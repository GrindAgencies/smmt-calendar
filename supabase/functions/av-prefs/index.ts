// av-prefs v5 (2026-10-21) — a member's own scheduling preferences: their timezone, and the
//   appointment-email content they want guests to receive.
//
// v5 adds appt_get / appt_set. Elijah asked that when a meeting is booked with a guest email,
// the guest receives the appointment details plus that organizer's own saved message and Zoom
// details. This function owns the CONTENT half only. It does not send, and it does not pretend
// to: SENDING IS NOT CONFIGURED — email-sender reports RESEND_API_KEY unset and has delivered
// 0 of 21 queued messages since July — so appt_get reports sending_configured honestly and the
// UI says so rather than implying a guest will receive something.
//
// Stored one row per agent in agent_appt_email, keyed by code, because the brief is explicit
// that one organizer's save must never overwrite another's — or the organization's.
//
// TWO WAYS IN, BOTH CLOSED (v4):
//  1. `ADMIN_TOKEN = "2026"` compared directly — the fifth function found carrying its own copy of
//     the literal, which is why turning the shared legacy switch off never reached it.
//  2. Identity was a typed `code` OR a typed trainer NAME. The fallback was the worse half: for a
//     trainer row with no code on it, `lo(t.name) === lo(name)` meant simply NAMING the trainer
//     authorised you to change their settings. Trainer names are on the booking page.
//
// A timezone is not cosmetic here: every slot the booking pages show is rendered in the trainer's
// timezone, so moving it silently shifts every appointment time a client or broker is offered.
//
// Now: an Operations token ops_authorize() accepts, or the session token minted at PIN entry — and
// a member may only ever change their OWN row.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
function json(o: unknown, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const lo = (s: unknown) => (s ?? "").toString().trim().toLowerCase();
const clean = (s: unknown) => (s ?? "").toString().trim().slice(0, 80);
const text = (s: unknown, n: number) => (s ?? "").toString().slice(0, n);
const enc = encodeURIComponent;
async function rpc(fn: string, args: Record<string, unknown>) { try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); return await r.json(); } catch (_) { return null; } }
async function opsAuthorized(token: unknown) { const t = String(token ?? ""); if (!t) return false; const r = await rpc("ops_authorize", { p_token: t }); return !!(r && r.ok); }
/* Proof of identity. A session token is proof; a typed code or name is not. */
async function sessionCode(session: unknown): Promise<string> {
  const s = String(session ?? "").trim().slice(0, 120);
  if (!s) return "";
  const got = await rpc("agent_session_code", { p_token: s });
  return (typeof got === "string") ? norm(got) : "";
}
async function nameOfCode(code: string): Promise<string> {
  if (!code) return "";
  const r = await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${enc(code)}&select=first_name,last_name&limit=1`, { headers: DBH });
  const a = ((await r.json()) || [])[0];
  return a ? `${a.first_name || ""} ${a.last_name || ""}`.trim() : "";
}

// Allow-list of IANA timezones we support in the UI (keeps stored values sane).
const TZOK = new Set([
  "America/Los_Angeles","America/Denver","America/Phoenix","America/Chicago",
  "America/New_York","America/Anchorage","Pacific/Honolulu","America/Puerto_Rico"
]);

const MAX_MSG = 4000;
const MAX_JOIN = 1500;

async function loadAvail() {
  const ex = await fetch(`${SUPA}/rest/v1/app_settings?key=eq.cft_availability&select=value`, { headers: DBH });
  const rows = await ex.json();
  return (rows && rows[0] && rows[0].value) ? rows[0].value : null;
}
async function saveAvail(value: unknown) {
  const up = await fetch(`${SUPA}/rest/v1/app_settings?on_conflict=key`, { method: "POST", headers: { ...DBH, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key: "cft_availability", value, updated_at: new Date().toISOString() }) });
  return up.ok;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = (req.method === "POST") ? (await req.json().catch(() => ({}))) : {};
    const action = (body.action as string) || "";

    /* ---------- the organizer's own appointment-email content ---------- */
    /* Whose row this is, is decided HERE from the session, never from a code in the request.
       Operations may name someone; a member is only ever themselves. */
    if (action === "appt_get" || action === "appt_set") {
      const isOps = await opsAuthorized(body.token);
      const meCode = isOps ? "" : await sessionCode(body.session);
      if (!isOps && !meCode) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401);
      const who = isOps ? norm(body.code) : meCode;
      if (!who) return json({ ok: false, error: "Which account?" }, 400);

      /* Honest status. A connection that cannot send is not a connection, and the brief is
         explicit that API acceptance must never be reported as delivery. Nothing has been
         sent since July because this key has never been set. */
      const sendingConfigured = !!Deno.env.get("RESEND_API_KEY");

      if (action === "appt_set") {
        const row = {
          agent_code: who,
          message: text(body.message, MAX_MSG),
          join_info: text(body.join_info, MAX_JOIN),
          updated_at: new Date().toISOString(),
        };
        const up = await fetch(`${SUPA}/rest/v1/agent_appt_email?on_conflict=agent_code`, {
          method: "POST", headers: { ...DBH, Prefer: "resolution=merge-duplicates,return=representation" },
          body: JSON.stringify(row),
        });
        if (!up.ok) return json({ ok: false, error: "Could not save that." }, 500);
        const saved = ((await up.json()) || [])[0] || row;
        return json({ ok: true, agent_code: who, message: saved.message || "", join_info: saved.join_info || "", sending_configured: sendingConfigured });
      }

      const got = await fetch(`${SUPA}/rest/v1/agent_appt_email?agent_code=eq.${enc(who)}&select=message,join_info,updated_at&limit=1`, { headers: DBH });
      const r0 = ((await got.json()) || [])[0] || null;
      return json({
        ok: true, agent_code: who,
        message: (r0 && r0.message) || "",
        join_info: (r0 && r0.join_info) || "",
        updated_at: r0 ? r0.updated_at : null,
        sending_configured: sendingConfigured,
        /* Said plainly so the page can tell the truth rather than imply delivery. */
        sending_note: sendingConfigured ? null : "No sending account is connected yet, so guests will not receive this. Saving it now means it is ready the moment one is.",
      });
    }

    if (action === "set_timezone") {
      const isOps = await opsAuthorized(body.token);
      const meCode = isOps ? "" : await sessionCode(body.session);
      if (!isOps && !meCode) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401);

      const tz = clean(body.timezone);
      if (!TZOK.has(tz)) return json({ ok: false, error: "unsupported timezone" }, 400);
      const avail = await loadAvail();
      if (!avail || !Array.isArray(avail.cfts)) return json({ ok: false, error: "cft_availability missing" }, 500);

      // Operations may name a trainer. A member is only ever themselves — matched on their own
      // code first, and on their own name only as a fallback for rows that predate codes.
      const wantName = isOps ? clean(body.trainer_name || body.name) : await nameOfCode(meCode);
      const wantCode = isOps ? norm(body.code || body.trainer_code) : meCode;
      const idx = avail.cfts.findIndex((c: Record<string, unknown>) => {
        if (wantCode && norm(c.code) === wantCode) return true;
        if (!norm(c.code) && wantName && lo(c.name) === lo(wantName)) return true;
        return false;
      });
      if (idx < 0) return json({ ok: false, error: isOps ? "trainer not found" : "You are not set up as a trainer, so there is no schedule to change." }, 404);

      const t = avail.cfts[idx] as Record<string, unknown>;
      t.timezone = tz; avail.cfts[idx] = t;
      const ok = await saveAvail(avail);
      return json({ ok, name: t.name, timezone: tz });
    }

    if (action === "timezones") {
      // Central map name/code -> timezone, for booker-facing pages. Deliberately open: the public
      // booking page needs it to render a trainer's slots in the right zone, and a timezone is not
      // personal data. It carries nothing else.
      const avail = await loadAvail();
      const out: Record<string, string> = {};
      if (avail && Array.isArray(avail.cfts)) for (const c of avail.cfts) { if (c && c.timezone) { if (c.code) out[norm(c.code)] = c.timezone; if (c.name) out[lo(c.name)] = c.timezone; } }
      return json({ ok: true, timezones: out });
    }

    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) { return json({ ok: false, error: String(e) }, 500); }
});
