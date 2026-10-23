// cal-feed v8 (2026-10-22) — company-wide calendar feed (Dashboard + week + Clients).
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
// v8 (2026-10-22) SCOPES IT, which v5-v7 flagged and left alone. Two separate over-shares:
//
//   EVERY BASESHOP'S BOOKINGS went to every signed-in agent. That is the same cross-shop leak
//   the tab-by-tab audit already fixed everywhere else, and agent_scope() is the platform's one
//   answer to "which shops may this person see". A row is kept when the caller is a party to it,
//   or when EITHER side's baseshop is in their scope — either side, because cross-baseshop
//   bookings are deliberate here and both participants must keep seeing them.
//
//   CLIENT EMAIL AND PHONE went out on every row. Only one consumer reads them —
//   clientBookings() in calendar.html — and it already filters to the caller's own bookings
//   first, so shipping them on everybody else's rows was pure surplus. They are now present
//   only on rows the caller is a party to.
//
// MATCHED ON CODE *OR* NAME, deliberately. The Clients tab matches trainer_name, and 7 of the
// 1,120 bookings that carry a client email have a trainer_name but no trainer_code — matching on
// code alone would have silently emptied those from that trainer's own Clients tab.
//
//
// ALSO IN v8, A DEAD LINE MADE LIVE: bookedCalendlyUuids() in calendar.html suppresses the gold
// "CALENDLY · Import" overlay row for an event that is already a booking, by matching
// calendly_event_uuid. This function never selected that column, so the COMPANY_EV half of that
// dedupe had always compared undefined to undefined. It is in the select list now. A uuid belongs
// to exactly one Calendly event, so a row carrying yours IS yours.
// Checked before changing: all 1,218 visible bookings resolve to a baseshop on at least one
// side, so nothing needs a fail-open case and none is written.

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
const low = (s: unknown) => (s ?? "").toString().trim().toLowerCase();
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
/* The one canonical answer to "which baseshops may this person see" — the same call the Hub,
   the Scheduler and the Operations tabs make. */
async function agentScope(code: string): Promise<{ all: boolean; bases: string[] }> {
  const r = await rpc("agent_scope", { p_code: norm(code) });
  if (!r || r.ok !== true) return { all: false, bases: [] };
  return { all: !!r.all, bases: Array.isArray(r.bases) ? r.bases.map((x: unknown) => String(x)) : [] };
}
/* One roster read: code -> baseshop, and code -> full name (the Clients tab matches on name). */
async function rosterIndex(): Promise<{ shopOf: Record<string, string>; nameOf: Record<string, string> }> {
  const shopOf: Record<string, string> = {}; const nameOf: Record<string, string> = {};
  try {
    const r = await fetch(`${SUPA}/rest/v1/tracker_agents?select=code,baseshop,first_name,last_name&limit=5000`, { headers: DBH });
    for (const a of ((await r.json()) || [])) {
      const c = norm(a.code); if (!c) continue;
      shopOf[c] = String(a.baseshop || "");
      nameOf[c] = `${a.first_name || ""} ${a.last_name || ""}`.trim();
    }
  } catch (_) { /* an empty index scopes to your own rows, which fails closed */ }
  return { shopOf, nameOf };
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
      `${SUPA}/rest/v1/bookings?date=gte.${from}&date=lte.${to}&status=in.(booked,confirmed,pending,completed)&order=starts_at.desc&select=id,conf,date,time,starts_at,ends_at,timezone,duration_minutes,category,title,color,trainer_name,trainer_code,agent_code,agent_name,client_email,client_phone,client_id,calendly_event_uuid,status,source&limit=2000`,
      { headers: DBH },
    );
    const rows: Record<string, unknown>[] = (await ex.json()) || [];

    /* Operations keeps the company view. A member is scoped, by the one scoping rule. */
    const scope = isOps ? { all: true, bases: [] as string[] } : await agentScope(me);
    const roster = await rosterIndex();
    const myName = low(roster.nameOf[me] || "");
    const allow = new Set(scope.bases.map(low));

    const party = (b: Record<string, unknown>) =>
      norm(b.trainer_code) === me || norm(b.agent_code) === me ||
      (!!myName && (low(b.trainer_name) === myName || low(b.agent_name) === myName));

    const inScope = (b: Record<string, unknown>) => {
      if (scope.all) return true;
      if (party(b)) return true;                       /* always your own */
      const ts = low(roster.shopOf[norm(b.trainer_code)] || "");
      const as = low(roster.shopOf[norm(b.agent_code)] || "");
      return (!!ts && allow.has(ts)) || (!!as && allow.has(as));
    };

    const events = rows.filter(inScope).map((b) => {
      if (scope.all || party(b)) return b;
      /* Not yours: the client's contact details are not yours either. */
      const { client_email: _e, client_phone: _p, ...rest } = b as Record<string, unknown>;
      return rest;
    });
    return json({ ok: true, scoped: !scope.all, events });
  }
  return json({ ok: false, error: "unknown action" }, 400);
});
