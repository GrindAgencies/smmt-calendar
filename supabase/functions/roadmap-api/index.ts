// roadmap-api v12 — progression engine + Ops config CRUD + team tokens + rank ladder + Ops cashflow + MILESTONE VERIFICATION.
// v11: key challenges (config.verify_challenges) only count toward completion/XP once Ops verifies them (tracker_agents.verify).
// v12 (2026-09-03): the four Operations-only actions — save_config, set_cashflow, verify and
//      pending — go through ops_authorize instead of the literal "2026" that shipped inside
//      ops.html. set_cashflow writes career cashflow and posts a public recognition, so a
//      guessable token could both rewrite someone's earnings and announce it to the company.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
function json(o: unknown, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const lo = (s: unknown) => (s ?? "").toString().trim().toLowerCase();
const clean = (s: unknown) => (s ?? "").toString().trim().slice(0, 200);
const money = (v: unknown) => "$" + (Number(v) || 0).toLocaleString("en-US");
const fullName = (a: Record<string, unknown>) => `${a.first_name || ""} ${a.last_name || ""}`.trim();

async function loadConfig() { const r = await fetch(`${SUPA}/rest/v1/app_settings?key=eq.roadmap_config&select=value`, { headers: DBH }); const rows = await r.json(); return (rows && rows[0]) ? rows[0].value : null; }
async function saveConfig(v: unknown) { const up = await fetch(`${SUPA}/rest/v1/app_settings?on_conflict=key`, { method: "POST", headers: { ...DBH, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key: "roadmap_config", value: v, updated_at: new Date().toISOString() }) }); return up.ok; }
async function loadKey(k: string) { try { const r = await fetch(`${SUPA}/rest/v1/app_settings?key=eq.${k}&select=value`, { headers: DBH }); const rows = await r.json(); return (rows && rows[0]) ? rows[0].value : null; } catch (_) { return null; } }
async function getJSON(path: string) { try { const r = await fetch(`${SUPA}/rest/v1/${path}`, { headers: DBH }); return (await r.json()) || []; } catch (_) { return []; } }
async function rpc(fn: string, args: Record<string, unknown>) { try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); return await r.json(); } catch (_) { return null; } }
async function opsAuthorized(token: unknown) { const r = await rpc("ops_authorize", { p_token: String(token ?? "") }); return !!(r && r.ok); }
async function patchAgent(code: string, patch: Record<string, unknown>) { try { await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${encodeURIComponent(code)}`, { method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify(patch) }); } catch (_) { /* noop */ } }
async function hubPost(bodyTxt: string) { try { await fetch(`${SUPA}/rest/v1/hub_messages`, { method: "POST", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify({ channel: "main", author_code: "KEVIN", author_name: "Kevin", body: bodyTxt, kind: "recognition", attach: { source: "Cashflow" }, reactions: {} }) }); } catch (_) { /* noop */ } }
async function photoSet(): Promise<Set<string>> { try { const r = await fetch(`${SUPA}/rest/v1/hub_avatars?select=code`, { headers: DBH }); const rows = (await r.json()) || []; return new Set(rows.map((x: Record<string, unknown>) => norm(x.code))); } catch (_) { return new Set(); } }

function keySet(config: Record<string, unknown>): Set<string> { const a = (config && (config.verify_challenges as string[])) || []; return new Set(Array.isArray(a) ? a : []); }

// ===== rank ladder (0..8) =====
async function playerRank(agent: Record<string, unknown>): Promise<number> {
  const prog = (agent.progress && typeof agent.progress === "object") ? agent.progress as Record<string, unknown> : {};
  const code = norm(agent.code);
  const licensed = !!(prog.w3_reslic || prog.w3_exam || prog.w1_exam);
  const presenter = !!(prog.cft_illus && prog.cft_pfr);
  let is_cft = false; try { const av = await loadKey("cft_availability"); const nm = lo(fullName(agent)); is_cft = !!(av && Array.isArray(av.cfts) && av.cfts.some((c: Record<string, unknown>) => lo(c.name) === nm && !c.hidden)); } catch (_) { /* noop */ }
  let cashflow = Number(agent.cashflow) || 0; if (!cashflow) { const pols = await getJSON(`policies?agent_code=eq.${encodeURIComponent(code)}&select=expected_commission&limit=5000`); cashflow = pols.reduce((t: number, p: Record<string, unknown>) => t + (Number(p.expected_commission) || 0), 0); }
  const netLic = licensed && cashflow > 0;
  const s = lo(agent.contract_level);
  const lr = (s === "emd" || s.includes("executive")) ? 3 : ((s === "md" || (s.includes("marketing director") && !s.includes("executive"))) ? 2 : (s.includes("senior") ? 1 : 0));
  const isNVP = s === "nvp" || s.includes("national vice");
  let idx = 0;
  if (licensed) idx = Math.max(idx, 1);
  if (netLic) idx = Math.max(idx, 2);
  if (presenter) idx = Math.max(idx, 3);
  if (is_cft) idx = Math.max(idx, 4);
  if (lr >= 1) idx = Math.max(idx, 5);
  if (lr >= 2) idx = Math.max(idx, 6);
  if (lr >= 3) idx = Math.max(idx, 7);
  if (isNVP) idx = Math.max(idx, 8);
  return idx;
}

function cfThreshold(l: Record<string, unknown>): number {
  if (l.cf !== undefined && l.cf !== null && l.cf !== "") return Number(l.cf) || 0;
  const m = /^cf(\d+)$/.exec(String(l.id)); return m ? parseInt(m[1], 10) * 1000 : 0;
}

function visibleLevels(config: Record<string, unknown>, pathway: string) {
  const levels = (config.levels as Record<string, unknown>[]) || [];
  return levels.filter((l) => { if (l.hidden === true) return false; const p = lo(l.pathway) || "all"; return p === "all" || p === pathway; }).sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
}
function compute(agent: Record<string, unknown>, config: Record<string, unknown>, keys?: Set<string>) {
  const prog = (agent.progress && typeof agent.progress === "object") ? agent.progress as Record<string, unknown> : {};
  const verify = (agent.verify && typeof agent.verify === "object") ? agent.verify as Record<string, unknown> : {};
  keys = keys || keySet(config);
  const pathway = lo(agent.pathway);
  const cashflow = Number(agent.cashflow) || 0;
  const perCh = Number(config.xp_per_challenge) || 25; const bonus = Number(config.xp_level_bonus) || 100;
  const levels = visibleLevels(config, pathway);
  let xp = 0, doneLevels = 0, doneChal = 0, totalChal = 0, pendingChal = 0; let prevDone = true; let currentId = "", currentWorld = "";
  const per: Record<string, unknown>[] = [];
  for (const l of levels) {
    const ch = (l.challenges as string[]) || [];
    let comp = ch.filter((id) => !!prog[id] && (!keys!.has(id) || !!verify[id])).length;
    const claimed = ch.filter((id) => !!prog[id]).length;
    const pend = ch.filter((id) => !!prog[id] && keys!.has(id) && !verify[id]).length;
    let done = ch.length > 0 && comp === ch.length;
    if (String(l.world) === "cashflow" && cashflow > 0) { const thr = cfThreshold(l); if (thr > 0 && cashflow >= thr) { done = true; comp = ch.length; } }
    const status = done ? "done" : (prevDone ? "active" : "locked");
    const lvlBonus = (l.xp !== undefined && l.xp !== null && l.xp !== "") ? Number(l.xp) : bonus;
    xp += comp * perCh + (done ? lvlBonus : 0);
    doneChal += comp; totalChal += ch.length; pendingChal += pend; if (done) doneLevels++;
    if (status === "active" && !currentId) { currentId = String(l.id); currentWorld = String(l.world); }
    per.push({ id: l.id, world: l.world, order: l.order, name: l.name, desc: l.desc || "", status, completed: comp, claimed, pending: pend, total: ch.length, reward_emblem: l.reward_emblem || "", difficulty: l.difficulty || "", challenges: ch });
    prevDone = done;
  }
  if (!currentId && per.length) { const last = per[per.length - 1]; currentId = String(last.id); currentWorld = String(last.world); }
  return { xp, level_index: doneLevels, total_levels: levels.length, done_challenges: doneChal, total_challenges: totalChal, pending_challenges: pendingChal, pct: totalChal ? Math.round(doneChal * 100 / totalChal) : 0, current_level: currentId, current_world: currentWorld, levels: per };
}
function lite(agent: Record<string, unknown>, config: Record<string, unknown>, photos: Set<string>, keys?: Set<string>) {
  const c = compute(agent, config, keys);
  return { code: norm(agent.code), name: fullName(agent), pathway: lo(agent.pathway), xp: c.xp, level_index: c.level_index, total_levels: c.total_levels, current_level: c.current_level, current_world: c.current_world, pct: c.pct, streak: Number(agent.streak) || 0, has_photo: photos.has(norm(agent.code)) };
}

const CF_MAJORS = [{ a: 1000000, e: "👑" }, { a: 500000, e: "💎" }, { a: 250000, e: "💰" }, { a: 100000, e: "💍" }, { a: 50000, e: "⌚" }];
const floor10k = (n: number) => Math.floor((Number(n) || 0) / 10000) * 10000;


/* ===== roadmap-api v: WHO IS CALLING (2026-09-30) =====
   Every check below used to read the caller's identity out of `body.code`, and GFI codes are
   printed on the org chart, so any of them could be performed as somebody else. Identity now comes
   from the session token minted when a person enters their PIN, or an Operations token. `body.code`
   is overwritten with the verified answer, so every rule further down becomes sound exactly where
   it already stands rather than being moved. */
const _SB = Deno.env.get("SUPABASE_URL")!;
const _SK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
async function _authRpc(fn: string, args: Record<string, unknown>) {
  try {
    const r = await fetch(`${_SB}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: _SK, Authorization: `Bearer ${_SK}`, "Content-Type": "application/json" }, body: JSON.stringify(args) });
    return await r.json();
  } catch (_) { return null; }
}
async function _isOps(token: unknown): Promise<boolean> {
  const t = String(token ?? "").trim(); if (!t) return false;
  const r = await _authRpc("ops_authorize", { p_token: t }); return !!(r && r.ok);
}
async function _sessionCode(session: unknown): Promise<string> {
  const s = String(session ?? "").trim().slice(0, 120); if (!s) return "";
  const got = await _authRpc("agent_session_code", { p_token: s });
  return (typeof got === "string") ? got.trim().toUpperCase() : "";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = (req.method === "POST") ? (await req.json().catch(() => ({}))) : {};
    const action = (body.action as string) || "config";
    /* Resolve the caller once, then overwrite body.code with the verified answer. */
    {
      const _ops = await _isOps((body as Record<string, unknown>).token);
      if (!_ops) {
        const _me = await _sessionCode((body as Record<string, unknown>).session);
        if (!_me) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401);
        (body as Record<string, unknown>).code = _me;
      }
    }

    if (action === "save_config") {
      if (!(await opsAuthorized(body.token))) return json({ ok: false, error: "Operations only." }, 401);
      const cfg = body.config as Record<string, unknown>;
      if (!cfg || !Array.isArray(cfg.worlds) || !Array.isArray(cfg.levels)) return json({ ok: false, error: "config must have worlds[] and levels[]" }, 400);
      const ids = (cfg.levels as Record<string, unknown>[]).map((l) => String(l.id));
      if (new Set(ids).size !== ids.length) return json({ ok: false, error: "level ids must be unique" }, 400);
      if (ids.some((x) => !x)) return json({ ok: false, error: "every level needs an id" }, 400);
      const clean2 = { version: Number(cfg.version) || 1, xp_per_challenge: Number(cfg.xp_per_challenge) || 25, xp_level_bonus: Number(cfg.xp_level_bonus) || 100, worlds: cfg.worlds, levels: cfg.levels, labels: cfg.labels || {}, verify_challenges: Array.isArray(cfg.verify_challenges) ? cfg.verify_challenges : [] };
      const ok = await saveConfig(clean2);
      return json({ ok, saved: ids.length });
    }

    if (action === "ack_rank") {
      const code = norm(body.code); if (!code) return json({ ok: false, error: "code required" }, 400);
      const r = await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${encodeURIComponent(code)}&select=code,first_name,last_name,progress,contract_level,cashflow&limit=1`, { headers: DBH });
      const agent = ((await r.json()) || [])[0]; if (!agent) return json({ ok: false, error: "not found" }, 404);
      const idx = await playerRank(agent); await patchAgent(code, { rank_ack: idx });
      return json({ ok: true, rank_ack: idx });
    }

    if (action === "set_cashflow") {
      if (!(await opsAuthorized(body.token))) return json({ ok: false, error: "Operations only." }, 401);
      const code = norm(body.code); if (!code) return json({ ok: false, error: "code required" }, 400);
      const r = await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${encodeURIComponent(code)}&select=code,first_name,last_name,cashflow&limit=1`, { headers: DBH });
      const agent = ((await r.json()) || [])[0]; if (!agent) return json({ ok: false, error: "not found" }, 404);
      const oldv = Number(agent.cashflow) || 0;
      const nw = Math.max(0, Math.round(Number(body.amount) || 0));
      await patchAgent(code, { cashflow: nw });
      let posted = false; let milestone: number | null = null;
      const recognize = body.recognize !== false;
      if (recognize && nw > oldv && Math.floor(nw / 5000) > Math.floor(oldv / 5000)) {
        const nm = fullName(agent); const first = (String(agent.first_name || "").trim()) || nm;
        const disp = floor10k(nw);
        const major = CF_MAJORS.find((m) => oldv < m.a && nw >= m.a);
        if (major) {
          milestone = major.a;
          const head = (disp > major.a)
            ? (major.e + " " + money(major.a) + " MILESTONE — " + nm + " is now at " + money(disp) + " in career cashflow! " + major.e)
            : (major.e + " MILESTONE — " + nm + " just crossed " + money(major.a) + " in career cashflow! " + major.e);
          await hubPost(head + "\n" + (major.a >= 1000000 ? "A brand-new MILLIONAIRE in the building. 👑🎉" : "Massive belt notch on the road to $1M.") + "\nEverybody show " + first + " some 🔥");
          posted = true;
        } else {
          const step = Math.floor(nw / 5000) * 5000; milestone = step;
          await hubPost("📈 CASHFLOW CLIMB — " + nm + " is now at " + money(disp) + " in career cashflow! Keep stacking, " + first + ". 💪");
          posted = true;
        }
      }
      return json({ ok: true, code, old: oldv, cashflow: nw, milestone, posted });
    }

    const config = await loadConfig();
    if (!config) return json({ ok: false, error: "roadmap not configured" }, 500);

    if (action === "config") return json({ ok: true, worlds: config.worlds || [], levels: config.levels || [], labels: config.labels || {}, verify_challenges: config.verify_challenges || [], xp_per_challenge: config.xp_per_challenge || 25, xp_level_bonus: config.xp_level_bonus || 100 });

    if (action === "verify") {
      if (!(await opsAuthorized(body.token))) return json({ ok: false, error: "Operations only." }, 401);
      const code = norm(body.code); if (!code) return json({ ok: false, error: "code required" }, 400);
      let challenges: string[] = Array.isArray(body.challenges) ? body.challenges : (body.challenge ? [body.challenge] : []);
      challenges = challenges.map((x) => String(x)).filter(Boolean);
      const decision = lo(body.decision) || "verify";
      if (!challenges.length) return json({ ok: false, error: "challenge required" }, 400);
      const r = await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${encodeURIComponent(code)}&select=verify,progress&limit=1`, { headers: DBH });
      const agent = ((await r.json()) || [])[0]; if (!agent) return json({ ok: false, error: "not found" }, 404);
      const verify: Record<string, unknown> = (agent.verify && typeof agent.verify === "object") ? agent.verify : {};
      const prog: Record<string, unknown> = (agent.progress && typeof agent.progress === "object") ? agent.progress : {};
      const by = clean(body.by) || "Operations"; const at = new Date().toISOString();
      for (const c of challenges) {
        if (decision === "reject") { delete verify[c]; delete prog[c]; }
        else if (decision === "unverify") { delete verify[c]; }
        else { verify[c] = { by, at }; }
      }
      await patchAgent(code, (decision === "reject") ? { verify, progress: prog } : { verify });
      return json({ ok: true, code, decision, verified: challenges, verify });
    }

    if (action === "pending") {
      if (!(await opsAuthorized(body.token))) return json({ ok: false, error: "Operations only." }, 401);
      const keys = keySet(config); const labels = (config.labels as Record<string, string>) || {};
      const chLevel: Record<string, string> = {}; for (const l of (config.levels as Record<string, unknown>[] || [])) { for (const c of ((l.challenges as string[]) || [])) chLevel[c] = String(l.name || ""); }
      const agents = await getJSON(`tracker_agents?status=neq.quit&select=code,first_name,last_name,progress,verify,contract_level`);
      const out: Record<string, unknown>[] = []; let totalPending = 0;
      for (const a of agents) {
        const cc = norm(a.code); if (!cc || cc === "POOL") continue;
        const prog = (a.progress && typeof a.progress === "object") ? a.progress : {};
        const verify = (a.verify && typeof a.verify === "object") ? a.verify : {};
        const pend: Record<string, string>[] = [];
        keys.forEach((c) => { if (prog[c] && !verify[c]) pend.push({ id: c, label: labels[c] || c, level: chLevel[c] || "" }); });
        if (pend.length) { totalPending += pend.length; out.push({ code: cc, name: fullName(a), contract_level: a.contract_level || "", pending: pend }); }
      }
      out.sort((x, y) => (y.pending as unknown[]).length - (x.pending as unknown[]).length);
      return json({ ok: true, count: out.length, total_pending: totalPending, agents: out });
    }

    if (action === "player") {
      const code = norm(body.code); if (!code) return json({ ok: false, error: "code required" }, 400);
      const r = await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${encodeURIComponent(code)}&select=code,first_name,last_name,progress,verify,pathway,streak,best_streak,contract_level,rank_ack,cashflow,created_at`, { headers: DBH });
      const agent = ((await r.json()) || [])[0]; if (!agent) return json({ ok: false, error: "not found" }, 404);
      const photos = await photoSet();
      const keys = keySet(config);
      const c = compute(agent, config, keys);
      const rankIdx = await playerRank(agent);
      let promotion = null; const ack = agent.rank_ack;
      if (ack === null || ack === undefined) { await patchAgent(code, { rank_ack: rankIdx }); }
      else if (rankIdx > Number(ack)) { promotion = { from: Number(ack), to: rankIdx }; }
      return json({ ok: true, worlds: config.worlds || [], labels: config.labels || {}, keys: Array.from(keys), player: { code, name: fullName(agent), pathway: lo(agent.pathway), has_photo: photos.has(code), streak: Number(agent.streak) || 0, best_streak: Number(agent.best_streak) || 0, contract_level: agent.contract_level || "", rank_index: rankIdx, promotion, cashflow: Number(agent.cashflow) || 0, verify: (agent.verify && typeof agent.verify === "object") ? agent.verify : {}, ...c } });
    }

    if (action === "nearby" || action === "leaderboard" || action === "team") {
      const sel = (action === "team") ? "code,first_name,last_name,progress,verify,pathway,streak,cashflow,direct_to" : "code,first_name,last_name,progress,verify,pathway,streak,cashflow";
      const r = await fetch(`${SUPA}/rest/v1/tracker_agents?status=neq.quit&select=${sel}`, { headers: DBH });
      const agents: Record<string, unknown>[] = (await r.json()) || [];
      const photos = await photoSet();
      const keys = keySet(config);

      if (action === "team") {
        const code = norm(body.code); if (!code) return json({ ok: false, error: "code required" }, 400);
        const byCode: Record<string, Record<string, unknown>> = {}; agents.forEach((a) => byCode[norm(a.code)] = a);
        const kids: Record<string, string[]> = {}; agents.forEach((a) => { const up = norm(a.direct_to); if (up && up !== norm(a.code)) (kids[up] = kids[up] || []).push(norm(a.code)); });
        const dl: Record<string, unknown>[] = []; const seen = new Set<string>();
        (function walk(cc: string) { for (const k of (kids[cc] || [])) { if (seen.has(k)) continue; seen.add(k); dl.push(byCode[k]); walk(k); } })(code);
        const team = dl.map((a) => lite(a, config, photos, keys)).sort((x, y) => y.xp - x.xp);
        const total = team.reduce((t, s) => t + s.xp, 0);
        const me = byCode[code] ? lite(byCode[code], config, photos, keys) : null;
        return json({ ok: true, me, team, team_tokens: total, team_count: team.length });
      }

      const states = agents.filter((a) => norm(a.code) && norm(a.code) !== "POOL").map((a) => lite(a, config, photos, keys));
      if (action === "nearby") {
        const code = norm(body.code); if (!code) return json({ ok: false, error: "not found" }, 404);
        const me = states.find((s) => s.code === code); if (!me) return json({ ok: false, error: "not found" }, 404);
        const others = states.filter((s) => s.code !== code && s.xp > 0);
        const ahead = others.filter((s) => s.level_index > me.level_index).sort((a, b) => a.level_index - b.level_index || a.xp - b.xp).slice(0, 3);
        const behind = others.filter((s) => s.level_index < me.level_index).sort((a, b) => b.level_index - a.level_index || b.xp - a.xp).slice(0, 3);
        const same = others.filter((s) => s.level_index === me.level_index).sort((a, b) => b.xp - a.xp).slice(0, 4);
        return json({ ok: true, me, ahead, behind, same });
      }
      const kind = lo(body.kind) || "xp";
      const scored = states.filter((s) => s.xp > 0);
      if (kind === "streak") scored.sort((a, b) => b.streak - a.streak || b.xp - a.xp);
      else if (kind === "progress") scored.sort((a, b) => b.pct - a.pct || b.xp - a.xp);
      else scored.sort((a, b) => b.xp - a.xp);
      return json({ ok: true, kind, leaders: scored.slice(0, Number(body.limit) || 20) });
    }

    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) { return json({ ok: false, error: String(e) }, 500); }
});
