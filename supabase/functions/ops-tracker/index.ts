// ops-tracker v2 — Operations override for My Tracker. Self-accountability is the default
// (brokers self-report, nothing needs approval); this lets Ops ADJUST or RESET any broker to
// where they ACTUALLY are. Writes tracker_agents.progress directly.
//
// v2 (2026-09-02): the only thing standing between the public internet and rewriting any
// broker's progress was the literal string "2026", which shipped inside ops.html. It is now
// an Operations session from ops-auth. ops_authorize() honours the old token until the pages
// cut over, then that is switched off centrally.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH  = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
function json(o: unknown, s = 200){ return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const lo = (s: unknown) => (s ?? "").toString().trim().toLowerCase();
const enc = encodeURIComponent;
const arr = (v: unknown) => Array.isArray(v) ? v : (v == null || v === "" ? [] : [v]);
const fullName = (a: any) => `${a.first_name || ""} ${a.last_name || ""}`.trim();
async function loadKey(k: string){ try { const r = await fetch(`${SUPA}/rest/v1/app_settings?key=eq.${k}&select=value`, { headers: DBH }); const rows = await r.json(); return (rows && rows[0]) ? rows[0].value : null; } catch (_) { return null; } }
async function rpc(fn: string, args: Record<string, unknown>){ try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); return await r.json(); } catch (_) { return null; } }
async function opsAuthorized(token: unknown){ const r = await rpc("ops_authorize", { p_token: String(token ?? "") }); return !!(r && r.ok); }
async function agent(code: string){ const r = await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${enc(code)}&select=code,first_name,last_name,progress,pathway,cashflow&limit=1`, { headers: DBH }); return ((await r.json()) || [])[0]; }
async function patchProg(code: string, prog: Record<string, unknown>){ await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${enc(code)}`, { method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify({ progress: prog }) }); }

function cfThreshold(l: any): number { if (l.cf !== undefined && l.cf !== null && l.cf !== "") return Number(l.cf) || 0; const m = /^cf(\d+)$/.exec(String(l.id)); return m ? parseInt(m[1], 10) * 1000 : 0; }
function visibleLevels(config: any, pathway: string){ const levels = (config.levels as any[]) || []; return levels.filter((l) => { if (l.hidden === true) return false; const p = lo(l.pathway) || "all"; return p === "all" || p === pathway; }).sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0)); }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: any = {}; try { body = await req.json(); } catch (_) {}
  if (!(await opsAuthorized(body.token))) return json({ ok: false, error: "unauthorized" }, 401);
  const action = String(body.action || "get");
  const code = norm(body.code); if (!code) return json({ ok: false, error: "code required" }, 400);
  const config = await loadKey("roadmap_config"); if (!config) return json({ ok: false, error: "roadmap not configured" }, 500);
  const a = await agent(code); if (!a) return json({ ok: false, error: "not found" }, 404);
  const prog: Record<string, unknown> = (a.progress && typeof a.progress === "object") ? a.progress : {};
  const levels = visibleLevels(config, lo(a.pathway));
  const cashflow = Number(a.cashflow) || 0;

  if (action === "set") {
    for (const c of arr(body.set)) prog[String(c)] = 1;
    for (const c of arr(body.clear)) delete prog[String(c)];
    await patchProg(code, prog);
  } else if (action === "reset_to") {
    const target = levels.find((l: any) => String(l.id) === String(body.level_id));
    const tord = target ? Number(target.order) : -1;
    for (const l of levels) { const complete = tord >= 0 && Number(l.order) <= tord; for (const cid of ((l.challenges as string[]) || [])) { if (complete) prog[cid] = 1; else delete prog[cid]; } }
    await patchProg(code, prog);
  }

  // build the current picture (works for get + after a mutation)
  const labels = (config.labels as Record<string, string>) || {};
  let doneLevels = 0, doneChal = 0, totalChal = 0; let prevDone = true; let currentId = "";
  const out = levels.map((l: any) => {
    const ch = (l.challenges as string[]) || [];
    let comp = ch.filter((id) => !!prog[id]).length;
    let done = ch.length > 0 && comp === ch.length;
    const auto = String(l.world) === "cashflow";
    if (auto && cashflow > 0) { const thr = cfThreshold(l); if (thr > 0 && cashflow >= thr) { done = true; comp = ch.length; } }
    const status = done ? "done" : (prevDone ? "active" : "locked");
    if (done) doneLevels++; doneChal += comp; totalChal += ch.length;
    if (status === "active" && !currentId) currentId = String(l.id);
    prevDone = done;
    return { id: l.id, name: l.name, world: l.world, order: l.order, status, auto, challenges: ch.map((cid) => ({ id: cid, label: labels[cid] || cid, done: !!prog[cid] })) };
  });
  return json({ ok: true, code, name: fullName(a), level_index: doneLevels, total_levels: levels.length, pct: totalChal ? Math.round(doneChal * 100 / totalChal) : 0, current_level: currentId, cashflow, levels: out });
});
