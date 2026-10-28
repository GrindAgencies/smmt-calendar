// agent-activity-sync v5 (2026-10-28) — REBUILT ON AGENCY DATA.
// v1-v4 read and wrote the `personal` schema of the old Digital Twin (connections, calendar_events_raw,
// agent_activity). Those tables no longer exist in any of the five Supabase projects, so every call
// errored ("Could not find the table 'personal.connections'"). Christopher chose to rebuild it on the
// agency's own records (2026-10-28).
//
// What it measures now, per agent per week (public.agent_activity, refreshed by agent_activity_refresh()):
//   with_focus  field trainings this agent brought to the focus trainer (app_settings.activity_focus,
//               default C1991 = Christopher) - in-app bookings, where the agent is known
//   with_other  field trainings this agent brought to any other trainer
//   self_run    field trainings this agent ran as the trainer (in-app + their Calendly as host)
// and a coaching priority score/tier per agent (public.agent_coaching_priority, coaching_priority_refresh()).
// Limitation: Calendly records the CLIENT as invitee, so Calendly bookings cannot say which agent
// brought them; they count only as the host's self_run.
//
// The daily pg_cron job `agent-activity-daily` runs both refreshes in SQL. This endpoint runs them on
// demand and returns the result. Operations (token) or the platform builder only.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
async function rpc(fn: string, args: Record<string, unknown>) { try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); return await r.json(); } catch (_) { return null; } }
async function allowed(body: any): Promise<boolean> {
  const t = String(body.token ?? "").trim();
  if (t) { const r = await rpc("ops_authorize", { p_token: t }); if (r && r.ok) return true; }
  const s = String(body.session ?? "").trim().slice(0, 120);
  if (!s) return false;
  const code = await rpc("agent_session_code", { p_token: s });
  if (typeof code !== "string" || !code) return false;
  return (await rpc("is_platform_admin", { p_code: code })) === true;
}
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: any = {}; try { body = await req.json(); } catch (_) { body = {}; }
  if (!(await allowed(body))) return json({ ok: false, error: "Operations only." }, 401);
  const weeks = Math.max(1, Math.min(26, Number(body.weeks) || 8));
  const activity = await rpc("agent_activity_refresh", { p_weeks: weeks });
  const priority = await rpc("coaching_priority_refresh", {});
  if (!activity || activity.code || !priority || priority.code) return json({ ok: false, error: "Refresh failed.", activity, priority }, 500);
  return json({ ok: true, activity, priority });
});
