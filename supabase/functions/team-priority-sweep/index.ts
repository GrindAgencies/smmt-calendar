// team-priority-sweep v3 (2026-10-28) — REBUILT ON AGENCY DATA.
// v1/v2 moved people between coaching tiers in the old Digital Twin's `personal` schema, which no
// longer exists. The tiers now come from public.agent_coaching_priority (coaching_priority_refresh(),
// run daily by pg_cron `agent-activity-daily`, and on demand by agent-activity-sync).
// This endpoint returns the current coaching list, most urgent first. Operations (token) or the
// platform builder only. Read-only: it changes nothing.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
async function rpc(fn: string, args: Record<string, unknown>) { try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); return await r.json(); } catch (_) { return null; } }
async function getJSON(path: string) { try { const r = await fetch(`${SUPA}/rest/v1/${path}`, { headers: DBH }); const j = await r.json(); return Array.isArray(j) ? j : []; } catch (_) { return []; } }
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
  const rows = await getJSON(`agent_coaching_priority?select=agent_code,score,tier,stage,reasons,computed_at&order=score.desc&limit=1000`);
  const people = await getJSON(`tracker_agents?select=code,first_name,last_name,baseshop&limit=5000`);
  const by: Record<string, any> = {}; for (const p of people) by[String(p.code).toUpperCase()] = p;
  const list = rows.map((r: any) => { const p = by[String(r.agent_code).toUpperCase()] || {}; return { ...r, name: `${p.first_name || ""} ${p.last_name || ""}`.trim(), baseshop: p.baseshop || "" }; });
  const counts: Record<string, number> = {}; for (const r of list) counts[r.tier] = (counts[r.tier] || 0) + 1;
  return json({ ok: true, computed_at: rows[0] ? rows[0].computed_at : null, counts, list });
});
