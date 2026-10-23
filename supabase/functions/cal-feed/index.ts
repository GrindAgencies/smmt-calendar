// cal-feed v7 (2026-10-22) — company-wide calendar feed (Dashboard + week + Clients).
// Read-only. Includes client fields for the Clients tab. v4 also returns
// starts_at/ends_at/timezone (+title/color) so the scheduler can render every event in the
// VIEWER's own time zone from its true instant.
//
// v5: THE "LIGHT GATE" WAS NO GATE. The rule was `if (!code) return 401` — any non-empty string
// passed. `?code=x` returned up to 2000 company bookings INCLUDING client_email and client_phone.
// Measured, not supposed: one credential-free request for October came back with 12 events, 8
// client email addresses and 2 client phone numbers. That is third-party personal data about
// people who are not users of this platform, readable by anyone who knows the URL.
//
// WHY IT WAS MISSED. session.js converts the old query-string GETs into POSTs so they carry the
// session, and cal-feed was deliberately left off that list on the grounds that it "serves a
// calendar file". It does not — the name misleads; it returns JSON. So the session never arrived,
// and the function was written to make do with a code.
//
// v7 (2026-10-22) REPLACES THE SHIM WITH A REAL DISTINCTION, now that session.js is live and
// serving cal-feed in its GETFIX list (verified against tsfg.app, not just against the push).
//
// The shim answered empty-and-successful to EVERY caller without a session, which also silenced
// the genuine case of an expired session — that person saw an empty calendar instead of being
// asked to sign in. The two cases are distinguishable and always were:
//
//   no `session` key at all   -> a client running the OLD session.js, which did not send one.
//                                Empty and successful: no data, and critically no bounce, because
//                                a 401 here clears tsfg_code and throws them to the sign-in
//                                screen. GitHub Pages serves .js with max-age=600, so such
//                                clients can exist for ten minutes after any deploy.
//   `session` sent but bad    -> a CURRENT client whose session really has expired. That is what
//                                needs_session is for, and bouncing them is correct.
//
// This is no longer a temporary measure to rip out: it is the right behaviour permanently,
// because the stale-client window reopens on every future deploy.
//
// THE ORIGINAL SHIM NOTE, kept because the lesson is the point:
// v6 EXISTED BECAUSE v5 BROKE THE LIVE SITE FOR A FEW MINUTES.
// The other half of this fix is adding cal-feed to the GETFIX list in session.js — but session.js
// is a CLIENT file served from GitHub Pages, and the live site runs whatever was last pushed. v5
// required a session the live client does not yet send, so every request answered 401 with
// needs_session, and session.js reacts to that by clearing the stored session AND tsfg_code and
// redirecting to the sign-in screen. The effect on a signed-in agent opening the Scheduler was to
// be silently signed out — far worse than the leak it was closing.
//
// v6 did so for EVERY sessionless caller; v7 narrows that to callers that sent no session key.
// Nobody is bounced and no rows leave either way.
//
// STILL BROAD, AND FLAGGED RATHER THAN CHANGED: every signed-in agent still receives every
// baseshop's bookings with the client contact fields, and calendar.html filters to the caller's
// own name in the browser (clientBookings(), line ~1941). Scoping that server-side is the right
// end state, but COMPANY_EV also drives the dashboard's company view, so narrowing it changes what
// people see. That is a product decision, not a quiet edit.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
function json(o: unknown, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }
const clean = (s: unknown) => (s ?? "").toString().trim().slice(0, 40);
async function rpc(fn: string, args: Record<string, unknown>) {
  try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); return await r.json(); }
  catch (_) { return null; }
}
/* Proof of identity. A session token is proof; a bare code is not, and an arbitrary string is
   certainly not. */
async function sessionCode(session: unknown): Promise<string> {
  const v = String(session ?? "").trim().slice(0, 120); if (!v) return "";
  const got = await rpc("agent_session_code", { p_token: v });
  return (typeof got === "string") ? got.trim().toUpperCase() : "";
}
async function opsAuthorized(token: unknown) {
  const t = String(token ?? "").trim(); if (!t) return false;
  const r = await rpc("ops_authorize", { p_token: t }); return !!(r && r.ok);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  let body: any = {}; if (req.method === "POST") body = await req.json().catch(() => ({}));
  const action = (body.action as string) || url.searchParams.get("action") || "";
  /* `code` is deliberately NOT read any more. It was the whole gate and it accepted any string;
     leaving it here would read as though it still mattered. */
  if (action === "company_events") {
    /* A real signed-in member, or Operations. `code` is no longer consulted for access at all —
       it was the entire gate, and it accepted anything. */
    const sentSession = (body.session || url.searchParams.get("session")) ? true : false;
    const me = await sessionCode(body.session || url.searchParams.get("session"));
    const isOps = me ? false : await opsAuthorized(body.token || url.searchParams.get("token"));
    if (!me && !isOps) {
      /* Sent nothing: an old client. Empty, successful, and NOT a 401 — a 401 here clears
         tsfg_code and throws the person to the sign-in screen. */
      if (!sentSession) {
        return json({
          ok: true, events: [], stale_client: true,
          note: "This calendar needs the updated app to load company events. Reload the page; if it persists the site update is still pending.",
        });
      }
      /* Sent a session that did not resolve: genuinely expired, on a current client. Say so. */
      return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401);
    }
    const from = clean(body.from || url.searchParams.get("from"));
    const to   = clean(body.to   || url.searchParams.get("to"));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return json({ ok: false, error: "valid from/to (YYYY-MM-DD) required" });
    const ex = await fetch(
      `${SUPA}/rest/v1/bookings?date=gte.${from}&date=lte.${to}&status=in.(booked,confirmed,pending,completed)&order=starts_at.desc&select=id,conf,date,time,starts_at,ends_at,timezone,duration_minutes,category,title,color,trainer_name,trainer_code,agent_name,client_email,client_phone,client_id,status,source&limit=2000`,
      { headers: DBH },
    );
    return json({ ok: true, events: (await ex.json()) || [] });
  }
  return json({ ok: false, error: "unknown action" }, 400);
});
