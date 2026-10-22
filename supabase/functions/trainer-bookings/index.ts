// trainer-bookings v1 — actionable bookings for a trainer (pending / booked / confirmed) only.
// Replaces atlas-api's atlas_trainer for the scheduler's My-Schedule view: that query returned ALL rows
// (1000+ completed/canceled history) and hit Supabase's row cap, so recent PENDING requests fell off the
// end and never reached the app — leaving trainers unable to approve them. Filtering to the actionable
// statuses keeps the set tiny and guarantees every pending request comes through.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
function json(o: unknown, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }
const clean = (s: unknown) => (s ?? "").toString().trim();

/* ===== trainer-bookings: WHO IS CALLING (2026-09-30) =====
   Identity used to come from a typed `code`, and GFI codes are printed on the org chart. It now
   comes from the session token minted when somebody enters their PIN, or an Operations token. */
const _SB = Deno.env.get("SUPABASE_URL")!;
const _SK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
async function _authRpc(fn: string, args: Record<string, unknown>) {
  try {
    const r = await fetch(`${_SB}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: _SK, Authorization: `Bearer ${_SK}`, "Content-Type": "application/json" }, body: JSON.stringify(args) });
    return await r.json();
  } catch (_) { return null; }
}
async function _isOps(token: unknown): Promise<boolean> {
  const t = String(token ?? "").trim(); if (!t) return false;
  const r = await _authRpc("ops_authorize", { p_token: t }); return !!(r && r.ok);
}
async function _sessionCode(session: unknown): Promise<string> {
  const s = String(session ?? "").trim().slice(0, 120); if (!s) return "";
  const got = await _authRpc("agent_session_code", { p_token: s });
  return (typeof got === "string") ? got.trim().toUpperCase() : "";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: any = {}; try { body = req.method === "POST" ? await req.json() : {}; } catch (_) { body = {}; }
  const url = new URL(req.url);
  /* v2 (2026-09-30): this had NO authentication at all. Naming any trainer returned their whole
     actionable schedule with select=* — client email, client phone, who they are seeing and when.
     A trainer now reads only their OWN; Operations may name one. */
  const _ops = await _isOps(body.token);
  const _me = _ops ? "" : await _sessionCode(body.session);
  if (!_ops && !_me) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401);
  const tc = _ops ? clean(body.trainer_code || url.searchParams.get("trainer_code")) : _me;
  const tn = _ops ? clean(body.trainer_name || url.searchParams.get("trainer_name")) : "";
  if (!tc && !tn) return json({ ok: false, error: "no trainer" });
  const filter = tc ? `trainer_code=eq.${encodeURIComponent(tc)}` : `trainer_name=eq.${encodeURIComponent(tn)}`;
  // only actionable rows — pending (needs approval), booked/confirmed (upcoming + review). Never the huge history.
  const ex = await fetch(`${SUPA}/rest/v1/bookings?${filter}&status=in.(pending,booked,confirmed)&order=date.asc&select=*&limit=2000`, { headers: DBH });
  return json({ ok: true, bookings: (await ex.json()) || [] });
});
