// tracker-occupancy v4 — who is parked on each My Tracker spot + how long they've been stuck.
// Computes each broker's current level (same rules as roadmap-api compute()), maintains a
// level_since timer (resets only when they actually advance), and returns per-spot rosters.
// Senior brokers (Senior Associate+/CFT/MD/EMD/Ops) see WHO; everyone else sees counts only.
//
// v4 (2026-09-30) — IDENTITY. Two things were wrong, and they were the same thing twice:
//   · `ADMIN_TOKEN = "2026"` was compared directly, so this function never joined the September
//     cutover onto ops_authorize() and the legacy switch being off did not apply to it. Sending
//     the literal returned the FULL roster — every broker's name, code, progress and how many
//     days they have been stuck — to a caller with no credentials at all.
//   · The "are you senior enough to see WHO" test read a typed `code`. Codes are on the org chart,
//     so typing any senior's code bought the same roster.
//   Both now come from proof: an Operations token ops_authorize() accepts, or the session token
//   minted when somebody enters their PIN.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH  = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
function json(o: unknown, s = 200){ return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const lo = (s: unknown) => (s ?? "").toString().trim().toLowerCase();
const enc = encodeURIComponent;
const fullName = (a: any) => `${a.first_name || ""} ${a.last_name || ""}`.trim();
async function getJSON(path: string){ try { const r = await fetch(`${SUPA}/rest/v1/${path}`, { headers: DBH }); return (await r.json()) || []; } catch (_) { return []; } }
async function rpc(fn: string, args: Record<string, unknown>){ try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); return await r.json(); } catch (_) { return null; } }
async function loadKey(k: string){ const rows = await getJSON(`app_settings?key=eq.${k}&select=value`); return rows[0] ? rows[0].value : null; }
async function patchAgent(code: string, patch: Record<string, unknown>){ try { await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${enc(code)}`, { method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify(patch) }); } catch (_) {} }
async function photoSet(): Promise<Set<string>>{ try { const rows = await getJSON(`hub_avatars?select=code`); return new Set(rows.map((x: any) => norm(x.code))); } catch (_) { return new Set(); } }

function cfThreshold(l: any): number { if (l.cf !== undefined && l.cf !== null && l.cf !== "") return Number(l.cf) || 0; const m = /^cf(\d+)$/.exec(String(l.id)); return m ? parseInt(m[1], 10) * 1000 : 0; }
function visibleLevels(config: any, pathway: string){ const levels = (config.levels as any[]) || []; return levels.filter((l) => { if (l.hidden === true) return false; const p = lo(l.pathway) || "all"; return p === "all" || p === pathway; }).sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0)); }
// current level id + overall pct, mirroring roadmap-api compute()
function currentOf(agent: any, config: any){
  const prog = (agent.progress && typeof agent.progress === "object") ? agent.progress : {};
  const pathway = lo(agent.pathway); const cashflow = Number(agent.cashflow) || 0;
  const levels = visibleLevels(config, pathway);
  let prevDone = true, currentId = "", doneChal = 0, totalChal = 0;
  for (const l of levels) {
    const ch = (l.challenges as string[]) || [];
    let comp = ch.filter((id) => !!prog[id]).length;
    let done = ch.length > 0 && comp === ch.length;
    if (String(l.world) === "cashflow" && cashflow > 0) { const thr = cfThreshold(l); if (thr > 0 && cashflow >= thr) { done = true; comp = ch.length; } }
    const status = done ? "done" : (prevDone ? "active" : "locked");
    doneChal += comp; totalChal += ch.length;
    if (status === "active" && !currentId) currentId = String(l.id);
    prevDone = done;
  }
  if (!currentId && levels.length) currentId = String(levels[levels.length - 1].id);
  return { current_level: currentId, pct: totalChal ? Math.round(doneChal * 100 / totalChal) : 0 };
}
function isSenior(contract: string){ const s = lo(contract); return s.includes("senior") || s === "md" || s.includes("marketing director") || s === "emd" || s.includes("executive") || s === "nvp" || s.includes("national vice"); }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: any = {}; try { body = await req.json(); } catch (_) {}

  // WHO IS CALLING — Operations by token, or a member by the session minted at PIN entry.
  const tok = String(body.token || "").slice(0, 120);
  let isAdmin = false;
  if (tok) { const az = await rpc("ops_authorize", { p_token: tok }); isAdmin = !!(az && az.ok); }
  let code = "";
  if (!isAdmin) {
    const sess = String(body.session || "").slice(0, 120);
    if (sess) { const got = await rpc("agent_session_code", { p_token: sess }); if (typeof got === "string") code = norm(got); }
  }
  // This is a roster of real people and it also keeps their level timers, so it is never anonymous.
  if (!isAdmin && !code) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401);

  const config = await loadKey("roadmap_config");
  if (!config) return json({ ok: false, error: "roadmap not configured" }, 500);

  // eligibility to see WHO (rather than just how many): Ops, or a Senior Associate+/CFT caller.
  let eligible = isAdmin;
  if (!eligible && code) {
    const caller = (await getJSON(`tracker_agents?code=eq.${enc(code)}&select=contract_level,first_name,last_name&limit=1`))[0];
    if (caller) {
      eligible = isSenior(caller.contract_level);
      if (!eligible) { const av = await loadKey("cft_availability"); const nm = lo(fullName(caller)); eligible = !!(av && Array.isArray(av.cfts) && av.cfts.some((c: any) => lo(c.name) === nm && !c.hidden)); }
    }
  }

  const photos = await photoSet();
  const agents = await getJSON(`tracker_agents?status=neq.quit&select=code,first_name,last_name,progress,pathway,cashflow,contract_level,level_at,level_since`);
  const nowMs = Date.now();
  const occ: Record<string, any[]> = {}; const counts: Record<string, number> = {};
  for (const a of agents) {
    const cc = norm(a.code); if (!cc || cc === "POOL") continue;
    const { current_level: lid, pct } = currentOf(a, config); if (!lid) continue;
    let since = a.level_since;
    if (String(a.level_at || "") !== String(lid)) { since = new Date().toISOString(); await patchAgent(cc, { level_at: lid, level_since: since }); }
    else if (!since) { since = new Date().toISOString(); await patchAgent(cc, { level_since: since }); }
    const days = Math.max(0, Math.floor((nowMs - new Date(since).getTime()) / 86400000));
    counts[lid] = (counts[lid] || 0) + 1;
    (occ[lid] = occ[lid] || []).push({ code: cc, name: fullName(a), days, has_photo: photos.has(cc), pct });
  }
  Object.keys(occ).forEach((k) => occ[k].sort((x, y) => y.days - x.days));
  const thresholds = { fresh: 7, warm: 14, stall: 30 }; // <7 fresh, 7-13 warm, 14-29 stall, 30+ stuck
  if (!eligible) return json({ ok: true, eligible: false, counts, thresholds });
  return json({ ok: true, eligible: true, occupancy: occ, counts, thresholds });
});
