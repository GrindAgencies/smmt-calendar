// book-manual v1 — create / delete a personal (manually-added) appointment on the user's own calendar.
// Writes to the same `bookings` table the Scheduler reads (source:'manual', no trainer), so manual
// appointments show up alongside real bookings + Calendly appts in every calendar view.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DEFAULT_TZ = "America/Los_Angeles";
const DBH  = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
function json(o: unknown, s = 200){ return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }
const norm  = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const clean = (s: unknown) => (s ?? "").toString().trim().slice(0, 500);
function confCode(){ const a="ABCDEFGHJKMNPQRSTUVWXYZ23456789"; let s=""; for(let i=0;i<6;i++) s+=a[Math.floor(Math.random()*a.length)]; return s; }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: any = {}; try { body = await req.json(); } catch (_) { /* */ }
  const action = body.action || "create";
  try {
    if (action === "create") {
      const code = norm(body.code); const agentName = clean(body.agent_name);
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
      const code = norm(body.code); const id = clean(body.id);
      if (!code || !id) return json({ ok: false, error: "missing id" });
      // only allow deleting the caller's own manual appointment
      const del = await fetch(`${SUPA}/rest/v1/bookings?id=eq.${encodeURIComponent(id)}&agent_code=eq.${encodeURIComponent(code)}&source=eq.manual`, { method: "DELETE", headers: DBH });
      if (!del.ok) return json({ ok: false, error: `Could not delete (${del.status}).` });
      return json({ ok: true });
    }
    return json({ ok: false, error: "unknown action" });
  } catch (e) { return json({ ok: false, error: String(e) }, 500); }
});
