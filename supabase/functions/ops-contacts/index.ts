// ops-contacts v2 (2026-09-18): the Operations booking directory, scoped on the server.
//
// An Operations contact's Calendly link used to ride along inside the cftavail trainer roster,
// which is handed unfiltered to every signed-in agent. Hiding the card in the page was the only
// thing keeping one baseshop's Operations link away from another's — anyone reading the network
// response had it. The links live in app_settings.ops_contacts now and leave the database only
// through ops_contacts_for(), which returns the contacts this caller's own hierarchy may book.
//
// Allie Mosle (ELEVATE) carries leader_code A2064, so she is reachable by Seale Mosle and Seale's
// downline only — walked from direct_to, so a baseshop label drift cannot widen it.
//
// v2 (2026-10-15): WHOSE HIERARCHY, DECIDED BY A TYPED CODE. The scoping above was real, but the
// code it scoped TO came straight out of the request body, so anyone could ask as anybody:
//
//   POST /ops-contacts {"code":"C1991"}
//   -> ok:true, contacts:[{name:"Anais Alvarez", seat:"0000", calendly:"..."}]
//
// That returns the Operations seat map — which person holds which seat, and their booking link —
// to anyone who types a code off the org chart. ops-platform v4 deliberately stopped publishing
// exactly that, and this endpoint was still handing it out the side door. The code now comes from
// the session minted at PIN entry; a typed one is ignored.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
function json(o: unknown, status = 200) { return new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } }); }
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
async function rpc(fn: string, args: Record<string, unknown>) { try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); return await r.json(); } catch (_) { return null; } }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    let body: Record<string, unknown> = {};
    if (req.method === "POST") body = await req.json().catch(() => ({}));
    const action = (body.action as string) || "list";
    if (action !== "list") return json({ ok: false, error: "unknown action" }, 400);

    /* Who is asking — proved, not typed. An Operations seat may also ask, for its own screens. */
    let code = "";
    const tok = String(body.token ?? "").trim();
    if (tok) { const r = await rpc("ops_authorize", { p_token: tok }); if (r && r.ok) code = norm(r.code); }
    if (!code) {
      const s = String(body.session ?? "").trim().slice(0, 120);
      if (!s) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401);
      const got = await rpc("agent_session_code", { p_token: s });
      code = (typeof got === "string") ? norm(got) : "";
      if (!code) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401);
    }

    const r = await fetch(`${SUPA}/rest/v1/rpc/ops_contacts_for`, { method: "POST", headers: DBH, body: JSON.stringify({ p_code: code }) });
    const out = await r.json().catch(() => null);
    if (!r.ok || !Array.isArray(out)) return json({ ok: true, contacts: [] });
    return json({ ok: true, contacts: out });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
