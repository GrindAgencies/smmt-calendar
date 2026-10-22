// cal-feed v6 (2026-10-21) — company-wide calendar feed (Dashboard + week + Clients).
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
// v6 IS A TRANSITION SHIM, AND IT EXISTS BECAUSE v5 BROKE THE LIVE SITE FOR A FEW MINUTES.
// The other half of this fix is adding cal-feed to the GETFIX list in session.js — but session.js
// is a CLIENT file served from GitHub Pages, and the live site runs whatever was last pushed. v5
// required a session the live client does not yet send, so every request answered 401 with
// needs_session, and session.js reacts to that by clearing the stored session AND tsfg_code and
// redirecting to the sign-in screen. The effect on a signed-in agent opening the Scheduler was to
// be silently signed out — far worse than the leak it was closing.
//
// So: a caller with no session gets an EMPTY, SUCCESSFUL answer instead of a 401. No needs_session
// key, so nobody is bounced; no rows, so no client data leaves. REMOVE THE SHIM once the
// session.js change is live, so a genuinely missing session is reported honestly rather than
// looking like an empty calendar.
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
    const me = await sessionCode(body.session || url.searchParams.get("session"));
    const isOps = me ? false : await opsAuthorized(body.token || url.searchParams.get("token"));
    if (!me && !isOps) {
      /* THE SHIM — see the v6 note at the top. Empty and successful, never a 401, because a 401
         here signs the person out of the whole app. Remove once session.js is pushed. */
      return json({
        ok: true, events: [], stale_client: true,
        note: "This calendar needs the updated app to load company events. Reload the page; if it persists the site update is still pending.",
      });
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
