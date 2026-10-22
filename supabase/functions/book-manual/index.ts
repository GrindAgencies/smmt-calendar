// book-manual v2 (2026-10-21) — create / delete a personal (manually-added) appointment on the
// user's own calendar.
// Writes to the same `bookings` table the Scheduler reads (source:'manual', no trainer), so manual
// appointments show up alongside real bookings + Calendly appts in every calendar view.
//
// v2: THERE WAS NO AUTHENTICATION OF ANY KIND. `agent_code` came straight off the request, and GFI
// codes are printed on the org chart, so with no credential at all anybody could:
//
//   · PUT AN APPOINTMENT ON ANYBODY'S CALENDAR, with any title, notes and guest list. It appears
//     exactly like one they added themselves.
//   · BLOCK THEM FROM BEING BOOKED. `bookings` carries the bookings_agent_no_overlap EXCLUDE
//     constraint, so a planted appointment makes that agent unbookable for that slot — a trainer
//     could be quietly emptied of availability without anything looking wrong.
//   · DELETE their manual appointments.
//
// `agent_name` was also taken from the request, so the name printed on the booking was whatever
// the caller claimed. It is read from the roster now.
//
// Verified open before the change (both actions reached validation with no credential) and refused
// after. No client change was needed: session.js wraps window.fetch and already adds `session` to
// every JSON body bound for /functions/v1/, and calendar.html — the only caller — loads it.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DEFAULT_TZ = "America/Los_Angeles";
const DBH  = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
function json(o: unknown, s = 200){ return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }
const norm  = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const clean = (s: unknown) => (s ?? "").toString().trim().slice(0, 500);
async function rpc(fn: string, args: Record<string, unknown>) {
  try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); return await r.json(); }
  catch (_) { return null; }
}
async function opsAuthorized(token: unknown) {
  const t = String(token ?? "").trim(); if (!t) return false;
  const r = await rpc("ops_authorize", { p_token: t }); return !!(r && r.ok);
}
/* Proof of identity. A session token is proof; a typed code is not — and here a typed code was a
   write onto somebody else's calendar. */
async function sessionCode(session: unknown): Promise<string> {
  const v = String(session ?? "").trim().slice(0, 120); if (!v) return "";
  const got = await rpc("agent_session_code", { p_token: v });
  return (typeof got === "string") ? norm(got) : "";
}
/* The name on the booking comes from the roster, never from the request. */
async function rosterName(code: string): Promise<string> {
  if (!code) return "";
  try {
    const r = await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${encodeURIComponent(code)}&select=first_name,last_name&limit=1`, { headers: DBH });
    const a = ((await r.json()) || [])[0];
    return a ? `${a.first_name || ""} ${a.last_name || ""}`.trim() : "";
  } catch (_) { return ""; }
}
function confCode(){ const a="ABCDEFGHJKMNPQRSTUVWXYZ23456789"; let s=""; for(let i=0;i<6;i++) s+=a[Math.floor(Math.random()*a.length)]; return s; }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: any = {}; try { body = await req.json(); } catch (_) { /* */ }
  const action = body.action || "create";
  try {
    /* WHOSE CALENDAR. Operations may name an agent, which a backfill needs; everybody else is
       themselves and a typed code is ignored. */
    const isOps = await opsAuthorized(body.token);
    let who = "";
    if (isOps) {
      who = norm(body.code);
      if (!who) return json({ ok: false, error: "code required" }, 400);
    } else {
      who = await sessionCode(body.session);
      if (!who) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401);
    }
    if (action === "create") {
      const code = who; const agentName = (await rosterName(who)) || clean(body.agent_name);
      const title = clean(body.title); const date = clean(body.date); const time = clean(body.time);
      const duration = Number(body.duration_minutes) > 0 ? Number(body.duration_minutes) : 60;
      const category = clean(body.category) || "Personal"; const notes = clean(body.notes);
      const color = clean(body.color) || "#6366f1"; const guests = clean(body.guests);
      if (!code || !title || !date || !time) return json({ ok: false, error: "missing appointment details" });
      const row = { conf: confCode(), agent_code: code, agent_name: agentName, title, category, date, time, duration_minutes: duration, timezone: DEFAULT_TZ, source: "manual", status: "booked", notes, color, guests };
      const ins = await fetch(`${SUPA}/rest/v1/bookings`, { method: "POST", headers: { ...DBH, Prefer: "return=representation" }, body: JSON.stringify(row) });
      const text = await ins.text();
      if (!ins.ok) {
        if (text.includes("bookings_agent_no_overlap")) return json({ ok: false, taken: true, error: `You already have something scheduled at ${time}. Pick another time.` });
        return json({ ok: false, error: `Could not save (${ins.status}).`, detail: text.slice(0, 200) });
      }
      let created: any = null; try { const p = JSON.parse(text); created = Array.isArray(p) ? p[0] : p; } catch (_) { /* */ }
      return json({ ok: true, booking: created });
    }
    if (action === "delete") {
      const code = who; const id = clean(body.id);
      if (!code || !id) return json({ ok: false, error: "missing id" });
      // only allow deleting the caller's own manual appointment
      const del = await fetch(`${SUPA}/rest/v1/bookings?id=eq.${encodeURIComponent(id)}&agent_code=eq.${encodeURIComponent(code)}&source=eq.manual`, { method: "DELETE", headers: DBH });
      if (!del.ok) return json({ ok: false, error: `Could not delete (${del.status}).` });
      return json({ ok: true });
    }
    return json({ ok: false, error: "unknown action" });
  } catch (e) { return json({ ok: false, error: String(e) }, 500); }
});
