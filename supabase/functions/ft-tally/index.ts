// ft-tally v2 — who's actually booking FIELD TRAININGS (and who isn't).
// Counts field-training bookings per broker from two sources:
//   1) bookings.agent_code  (internal bookings — the broker booked a trainer)
//   2) calendly_events invitee matched back to a broker (Calendly field trainings are
//      trainer-owned; the broker is the invitee — match invitee_email/name to tracker_agents)
// Returns per-broker counts + upcoming + last date, plus the list of active brokers with ZERO
// field trainings so Ops can see who to chase.
//
// v2 (2026-10-20, backend audit): AUTH. v1 compared the posted token against a hardcoded
// literal "2026" and so returned the entire roster — 137 brokers by name, and precisely which
// 123 have never booked a field training — to anyone who guessed four digits. That literal was
// retired platform-wide; integrity-check was fixed on 2026-09-30 and six more on 2026-10-05,
// but this one and fix-org were missed because nothing legitimate calls them, so no breakage
// ever pointed at them. Now authorises through ops_authorize(), which accepts a real
// Operations session or the 'cron' machine token.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH  = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
function json(o: unknown, s = 200){ return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const lo = (s: unknown) => (s ?? "").toString().trim().toLowerCase();
const fullName = (a: any) => `${a.first_name || ""} ${a.last_name || ""}`.trim();
async function getJSON(path: string){ try { const r = await fetch(`${SUPA}/rest/v1/${path}`, { headers: DBH }); return (await r.json()) || []; } catch (_) { return []; } }
async function opsAuthorized(token: unknown): Promise<boolean> {
  const t = String(token ?? "").trim();
  if (!t) return false;
  try {
    const r = await fetch(`${SUPA}/rest/v1/rpc/ops_authorize`, { method: "POST", headers: DBH, body: JSON.stringify({ p_token: t }) });
    const j = await r.json();
    return !!(j && j.ok);
  } catch (_) { return false; }
}
const isFT = (s: unknown) => { const t = lo(s); return t.includes("field") || t.includes("training"); };
const todayPT = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: any = {}; try { body = await req.json(); } catch (_) {}
  if (!(await opsAuthorized(body.token))) return json({ ok: false, error: "unauthorized" }, 401);
  const today = todayPT();

  // roster + lookup maps (email/name -> code)
  const agents = await getJSON(`tracker_agents?status=neq.quit&select=code,first_name,last_name,email`);
  const byEmail: Record<string, string> = {}; const byName: Record<string, string> = {}; const nameOf: Record<string, string> = {};
  for (const a of agents) { const c = norm(a.code); if (!c || c === "POOL") continue; nameOf[c] = fullName(a); if (a.email) byEmail[lo(a.email)] = c; const nm = lo(fullName(a)); if (nm) byName[nm] = c; }
  const tally: Record<string, { count: number; upcoming: number; last: string }> = {};
  const bump = (code: string, date: string) => { if (!code) return; const t = tally[code] || (tally[code] = { count: 0, upcoming: 0, last: "" }); t.count++; if (date && date >= today) t.upcoming++; if (date && date > t.last) t.last = date; };

  // 1) internal bookings attributed to the broker
  const bks = await getJSON(`bookings?status=in.(booked,confirmed,completed,pending)&agent_code=not.is.null&select=agent_code,category,date&limit=20000`);
  for (const b of bks) { if (isFT(b.category)) bump(norm(b.agent_code), b.date || ""); }

  // 2) Calendly field trainings -> match invitee back to a broker
  const cev = await getJSON(`calendly_events?status=in.(active)&select=event_type_name,name,invitee_email,invitee_name,start_time&limit=20000`);
  let matched = 0, unmatched = 0;
  for (const e of cev) {
    if (!isFT(e.event_type_name) && !isFT(e.name)) continue;
    let code = e.invitee_email ? byEmail[lo(e.invitee_email)] : "";
    if (!code && e.invitee_name) code = byName[lo(e.invitee_name)];
    if (!code) { unmatched++; continue; }
    matched++;
    let d = ""; try { d = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(e.start_time)); } catch (_) {}
    bump(code, d);
  }

  const booked = Object.keys(tally).map((c) => ({ code: c, name: nameOf[c] || c, count: tally[c].count, upcoming: tally[c].upcoming, last: tally[c].last }))
    .sort((a, b) => b.count - a.count);
  const never = agents.map((a: any) => norm(a.code)).filter((c: string) => c && c !== "POOL" && !tally[c]).map((c: string) => ({ code: c, name: nameOf[c] || c }));

  return json({ ok: true, at: new Date().toISOString(), total_brokers: Object.keys(nameOf).length, brokers_booking: booked.length, brokers_zero: never.length, calendly_matched: matched, calendly_unmatched: unmatched, booked, never });
});
