// cancel-followups v5 — for EVERY true cancellation (internal booking + Calendly),
// create ONE idempotent Operations follow-up task in the shared `tasks` table.
// Reschedules are excluded in BOTH loops (a reschedule can also have an imported booking). Recent window only.
// v5 (2026-09-03): authorisation goes through ops_authorize — an Operations session or the
// cron machine token — instead of the literal "2026" that shipped inside ops.html.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH  = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
function json(o: unknown, s = 200){ return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const clean = (s: unknown) => (s ?? "").toString().trim().slice(0, 2000);
const lo = (s: unknown) => (s ?? "").toString().toLowerCase();
function todayPT(){ return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date()); }
function plusDays(base: string, days: number){ const d = new Date((base || todayPT()) + "T12:00:00Z"); if (isNaN(d.getTime())) return todayPT(); d.setUTCDate(d.getUTCDate() + (Number(days)||0)); return d.toISOString().slice(0,10); }
async function getJSON(path: string){ try { const r = await fetch(`${SUPA}/rest/v1/${path}`, { headers: DBH }); return (await r.json()) || []; } catch (_) { return []; } }
async function rpc(fn: string, args: Record<string, unknown>){ try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); return await r.json(); } catch (_) { return null; } }
async function opsAuthorized(token: unknown){ const r = await rpc("ops_authorize", { p_token: String(token ?? "") }); return !!(r && r.ok); }
function isReschedule(raw: any){ try { return lo(raw && raw.cancellation && raw.cancellation.reason).includes("reschedul"); } catch(_) { return false; } }
const mkTask = (o: any) => ({ status: "in_progress", description: "", tags: ["cancellation"], agent_codes: [], client_names: [], policy_ids: [], notes: [], owner_code: "OPS", owner_name: "Operations", created_by: "AUTO", created_by_name: "Automation", recurrence: "", kind: "backoffice", category: "Cancellations", priority: "high", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...o });

async function run(sinceDays: number, dueDays: number){
  const today = todayPT();
  const sinceDate = plusDays(today, -Math.abs(sinceDays || 14));
  const sinceISO = sinceDate + "T00:00:00Z";
  const due = plusDays(today, Math.abs(dueDays || 1));
  const existing = new Set((await getJSON(`tasks?select=auto_key&auto_key=like.cancel:*&limit=100000`)).map((x: any) => String(x.auto_key)));

  const cev = await getJSON(`calendly_events?status=in.(canceled,cancelled)&start_time=gte.${sinceISO}&select=event_uuid,agent_code,agent_name,invitee_name,event_type_name,name,start_time,raw&order=start_time.desc&limit=3000`);
  const reschedUuids = new Set<string>();
  for (const e of cev) { if (e.event_uuid && isReschedule(e.raw)) reschedUuids.add(String(e.event_uuid)); }

  const rows: any[] = []; const seenUuid = new Set<string>(); let skippedReschedule = 0;

  const bks = await getJSON(`bookings?status=in.(canceled,cancelled)&source=neq.manual&date=gte.${sinceDate}&select=id,agent_code,agent_name,trainer_name,category,title,date,time,calendly_event_uuid&order=date.desc&limit=3000`);
  for (const b of bks) {
    const uuid = b.calendly_event_uuid ? String(b.calendly_event_uuid) : "";
    if (uuid) seenUuid.add(uuid);
    if (uuid && reschedUuids.has(uuid)) { skippedReschedule++; continue; }
    const key = "cancel:bk:" + b.id; if (existing.has(key)) continue;
    const what = clean(b.title || b.trainer_name || b.category || "appointment");
    const withWho = clean(b.agent_name || "");
    rows.push(mkTask({ title: `Follow up — cancelled: ${what}` + (withWho ? ` (${withWho})` : ""), description: `Cancelled appointment on ${b.date || ""} ${b.time || ""} PT. Reach out to reschedule.`.trim(), agent_codes: b.agent_code ? [norm(b.agent_code)] : [], client_names: withWho ? [withWho] : [], due_date: due, auto_key: key }));
    existing.add(key);
  }

  for (const e of cev) {
    if (!e.event_uuid || seenUuid.has(String(e.event_uuid))) continue;
    if (reschedUuids.has(String(e.event_uuid))) { skippedReschedule++; continue; }
    const key = "cancel:cal:" + e.event_uuid; if (existing.has(key)) continue;
    const what = clean(e.event_type_name || e.name || "Calendly appointment");
    const inv = clean(e.invitee_name || "");
    const day = (() => { try { return new Date(e.start_time).toISOString().slice(0,10); } catch(_) { return ""; } })();
    rows.push(mkTask({ title: `Follow up — cancelled: ${what}` + (inv ? ` (${inv})` : ""), description: `Cancelled Calendly appointment${day ? " on " + day : ""}. Reach out to reschedule.`, agent_codes: e.agent_code ? [norm(e.agent_code)] : [], client_names: inv ? [inv] : [], due_date: due, auto_key: key }));
    existing.add(key);
  }

  let created = 0;
  if (rows.length) { const ins = await fetch(`${SUPA}/rest/v1/tasks`, { method: "POST", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify(rows) }); if (ins.ok) created = rows.length; else return { ok: false, error: `insert failed (${ins.status})`, detail: (await ins.text()).slice(0,300) }; }
  return { ok: true, created, skipped_reschedule: skippedReschedule, scanned: { bookings: bks.length, calendly: cev.length }, since: sinceDate, at: new Date().toISOString() };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: any = {}; try { body = await req.json(); } catch (_) { /* */ }
  if (!(await opsAuthorized(body.token))) return json({ ok: false, error: "unauthorized" }, 401);
  try { return json(await run(Number(body.since_days) || 14, Number(body.due_days) || 1)); }
  catch (e) { return json({ ok: false, error: String(e) }, 500); }
});
