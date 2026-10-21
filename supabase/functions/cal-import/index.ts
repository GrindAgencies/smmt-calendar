// cal-import v5 — import a Calendly appointment into the internal bookings table "as is".
// Isolated from the booking engine (atlas): a plain insert, deduped by calendly_event_uuid.
//
// v5 (2026-10-21): LONGER CONFIRMATION CODES. The code was three base-36 characters —
// 46,656 possibilities in total. Its sibling calendly-book used five hex characters of the
// Calendly UUID (1,048,576), and at 1,494 bookings that had already produced TWO collisions
// (CAL-901B0, CAL-B4CCB), each shared by two different clients. A collision is not a leak —
// atlas_public_manage checks the client's email after matching the code — but it locks the
// second client out of managing their own appointment. Both functions now use the same
// 12-hex-character suffix.
//
// v4 (2026-09-30): WHOSE CALENDAR. `agent_code` came straight off the request, and GFI codes are
// printed on the org chart — so anyone could insert appointments into anybody's calendar, at any
// time, with any client name and email attached. Nothing would look wrong to the victim: it is
// exactly how a real Calendly import appears. Identity is now the session token minted at PIN
// entry; the import always lands on the person who is signed in. Operations may still name an
// agent, which is what a backfill needs.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, OPTIONS" };
function json(o: unknown, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const clean = (s: unknown) => (s ?? "").toString().trim().slice(0, 300);

/* The confirmation code, derived from the Calendly event UUID.
   DETERMINISTIC ON PURPOSE: this row is upserted on calendly_event_uuid, so the same event must
   always produce the same code — a random one would be rewritten on every re-sync, changing a
   code a client may already be holding.
   12 hex characters is 2.8e14 possibilities: at a hundred thousand bookings the chance of any
   collision at all is about two in a hundred thousand, against roughly even odds at the old five.
   Falls back to a full random UUID when Calendly gave us no event id. (The old fallback,
   Math.random().toString(36).slice(2,7), is not short in practice — 300,000 trials produced no
   code under 5 characters — but it is RANDOM, so a re-sync of the same event would mint a
   different code each time, which is the one thing this function must not do.) */
function confFromUuid(uuid: unknown): string {
  const hex = String(uuid ?? "").replace(/[^0-9a-fA-F]/g, "").toUpperCase();
  if (hex.length >= 12) return hex.slice(0, 12);
  return crypto.randomUUID().replace(/-/g, "").toUpperCase().slice(0, 12);
}

async function rpc(fn: string, args: Record<string, unknown>) { try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); return await r.json(); } catch (_) { return null; } }
async function opsAuthorized(token: unknown) { const t = String(token ?? ""); if (!t) return false; const r = await rpc("ops_authorize", { p_token: t }); return !!(r && r.ok); }
/* Proof of identity. A session token is proof; a typed code is not. */
async function sessionCode(session: unknown): Promise<string> {
  const s = String(session ?? "").trim().slice(0, 120);
  if (!s) return "";
  const got = await rpc("agent_session_code", { p_token: s });
  return (typeof got === "string") ? norm(got) : "";
}
async function agentName(code: string): Promise<string> {
  if (!code) return "";
  try {
    const r = await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${encodeURIComponent(code)}&select=first_name,last_name&limit=1`, { headers: DBH });
    const a = ((await r.json()) || [])[0];
    return a ? `${a.first_name || ""} ${a.last_name || ""}`.trim() : "";
  } catch (_) { return ""; }
}
function ptParts(iso: string) {
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const time = d.toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit" });
  return { date, time };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = (req.method === "POST") ? (await req.json().catch(() => ({}))) : {};
    if ((body.action || "import") !== "import") return json({ ok: false, error: "unknown action" }, 400);

    const isOps = await opsAuthorized(body.token);
    const sess = isOps ? "" : await sessionCode(body.session);
    if (!isOps && !sess) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401);
    const code = isOps ? norm(body.code) : sess;
    const name = (isOps ? clean(body.name) : "") || await agentName(code);

    const startIso = clean(body.start_time);
    if (!code || !startIso) return json({ ok: false, error: "code and start_time required" }, 400);
    const uuid = clean(body.event_uuid);
    // dedupe: already imported for this agent?
    if (uuid) {
      const ex = await fetch(`${SUPA}/rest/v1/bookings?agent_code=eq.${encodeURIComponent(code)}&calendly_event_uuid=eq.${encodeURIComponent(uuid)}&select=id`, { headers: DBH });
      const rows = await ex.json();
      if (Array.isArray(rows) && rows.length) return json({ ok: true, already: true, id: rows[0].id });
    }
    const pt = ptParts(startIso);
    const conf = "CAL-" + confFromUuid(uuid);
    const row: Record<string, unknown> = {
      conf, agent_code: code, agent_name: name,
      trainer_name: clean(body.invitee_name) || "Client",
      category: clean(body.event_type_name) || clean(body.name) || "Calendly appointment",
      date: pt.date, time: pt.time, status: "confirmed", source: "calendly_import",
      starts_at: startIso, client_email: clean(body.invitee_email) || null,
      calendly_event_uuid: uuid || null,
      notes: "Imported from Calendly" + (body.join_url ? (" · " + clean(body.join_url)) : "")
    };
    const ins = await fetch(`${SUPA}/rest/v1/bookings`, { method: "POST", headers: { ...DBH, Prefer: "return=representation" }, body: JSON.stringify(row) });
    const r = await ins.json();
    if (!ins.ok) return json({ ok: false, error: (Array.isArray(r) ? "" : (r.message || "insert failed")) || "insert failed", detail: JSON.stringify(r).slice(0, 200) }, 500);
    return json({ ok: true, booking: Array.isArray(r) ? r[0] : r });
  } catch (e) { return json({ ok: false, error: String(e) }, 500); }
});
