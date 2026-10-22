// emblem-api v6 — Call-of-Duty-style recognition emblems / calling cards.
// Brokers auto-UNLOCK emblems from real data and SELECT which to display (selected[0] = active emblem).
// actions: get {session} | select {session, ids} | all_active -> {CODE:{icon,tier}} for chat calling-cards.
//
// v6 (2026-09-30): WHOSE TROPHY CASE. The code came off the request, and GFI codes are printed on
// the org chart. `get` returns a `stats` block — and `cashflow` in it is the sum of that person's
// expected commission across their whole career. So typing a colleague's code reported what they
// have earned, alongside their team size and tenure. `select` could also rewrite which emblem
// somebody displays. Identity is now the session token minted at PIN entry.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
function json(o: unknown, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const low = (s: unknown) => (s ?? "").toString().trim().toLowerCase();
const full = (a: any) => `${a.first_name || ""} ${a.last_name || ""}`.trim();
function levelRank(l: string) { const s = low(l); if (s === "emd" || s.includes("executive")) return 3; if (s === "md" || (s.includes("marketing director") && !s.includes("executive"))) return 2; if (s.includes("senior")) return 1; return 0; }
async function rpc(fn: string, args: Record<string, unknown>) { try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); return await r.json(); } catch (_) { return null; } }
async function opsAuthorized(token: unknown) { const t = String(token ?? ""); if (!t) return false; const r = await rpc("ops_authorize", { p_token: t }); return !!(r && r.ok); }
/* Proof of identity. A session token is proof; a typed code is not. */
async function sessionCode(session: unknown): Promise<string> {
  const s = String(session ?? "").trim().slice(0, 120);
  if (!s) return "";
  const got = await rpc("agent_session_code", { p_token: s });
  return (typeof got === "string") ? norm(got) : "";
}

const EMBLEMS = [
  { id: "licensed", name: "Licensed", desc: "Passed your license exam", icon: "🎫", tier: "rank", cat: "Milestones" },
  { id: "cft", name: "Certified Field Trainer", desc: "Became a bookable CFT", icon: "🏵️", tier: "rank", cat: "Milestones" },
  { id: "senior_associate", name: "Senior Associate", desc: "Promoted to Senior Associate", icon: "🎖️", tier: "rank", cat: "Milestones" },
  { id: "md", name: "Marketing Director", desc: "Promoted to Marketing Director", icon: "🏅", tier: "rank", cat: "Milestones" },
  { id: "emd", name: "Executive Marketing Director", desc: "Reached EMD — your own base", icon: "👑", tier: "rank", cat: "Milestones" },
  { id: "cash_100k", name: "$100K Cashflow", desc: "$100,000 in career cashflow", icon: "💵", tier: "bronze", cat: "Cashflow" },
  { id: "cash_250k", name: "$250K Cashflow", desc: "$250,000 in career cashflow", icon: "💰", tier: "silver", cat: "Cashflow" },
  { id: "cash_500k", name: "$500K Cashflow", desc: "$500,000 in career cashflow", icon: "💎", tier: "gold", cat: "Cashflow" },
  { id: "cash_1m", name: "Millionaire — $1M Cashflow", desc: "$1,000,000 in career cashflow", icon: "🏆", tier: "platinum", cat: "Cashflow" },
  { id: "team_10", name: "10 Active Agents", desc: "10 active agents on your team", icon: "🤝", tier: "bronze", cat: "Team" },
  { id: "team_25", name: "25 Active Agents", desc: "25 active agents on your team", icon: "👥", tier: "silver", cat: "Team" },
  { id: "team_50", name: "50 Active Agents", desc: "50 active agents on your team", icon: "🏛️", tier: "gold", cat: "Team" },
  { id: "team_100", name: "100 Active Agents", desc: "100 active agents on your team", icon: "🌐", tier: "platinum", cat: "Team" },
  { id: "md_1", name: "First MD", desc: "1 Marketing Director on your team", icon: "⭐", tier: "silver", cat: "Leadership" },
  { id: "md_3", name: "3 MDs", desc: "3 Marketing Directors on your team", icon: "🌟", tier: "gold", cat: "Leadership" },
  { id: "md_5", name: "5 MDs", desc: "5 Marketing Directors on your team", icon: "💫", tier: "platinum", cat: "Leadership" },
  { id: "champ_1", name: "Monthly Champion", desc: "Finished #1 in a leaderboard category", icon: "🥇", tier: "gold", cat: "Competition" },
  { id: "champ_5", name: "5× Champion", desc: "Crowned #1 five times", icon: "🔥", tier: "platinum", cat: "Competition" },
  { id: "champ_10", name: "Dynasty — 10× Champion", desc: "Crowned #1 ten times", icon: "🐐", tier: "platinum", cat: "Competition" },
  { id: "tenure_3mo", name: "3 Months", desc: "3 months with the company", icon: "🌱", tier: "bronze", cat: "Tenure" },
  { id: "tenure_6mo", name: "6 Months", desc: "6 months with the company", icon: "⏳", tier: "bronze", cat: "Tenure" },
  { id: "tenure_1yr", name: "1 Year", desc: "1 year with the company", icon: "🎂", tier: "silver", cat: "Tenure" },
  { id: "tenure_2yr", name: "2 Years", desc: "2 years with the company", icon: "🗓️", tier: "gold", cat: "Tenure" },
  { id: "tenure_3yr", name: "3 Years", desc: "3 years with the company", icon: "🎗️", tier: "gold", cat: "Tenure" },
  { id: "tenure_5yr", name: "5 Years — Veteran", desc: "5 years with the company", icon: "🦅", tier: "platinum", cat: "Tenure" },
];

async function loadKey(k: string) { const r = await fetch(`${SUPA}/rest/v1/app_settings?key=eq.${k}&select=value`, { headers: DBH }); const rows = await r.json(); return (rows && rows[0]) ? rows[0].value : null; }
async function saveKey(k: string, value: unknown) { await fetch(`${SUPA}/rest/v1/app_settings?on_conflict=key`, { method: "POST", headers: { ...DBH, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key: k, value, updated_at: new Date().toISOString() }) }); }
async function getJSON(path: string) { const r = await fetch(`${SUPA}/rest/v1/${path}`, { headers: DBH }); return (await r.json()) || []; }

async function computeStats(code: string) {
  const arows = await getJSON(`tracker_agents?code=eq.${encodeURIComponent(code)}&select=code,first_name,last_name,contract_level,progress,title,created_at&limit=1`);
  const me = arows[0] || null;
  const prog = (me && me.progress && typeof me.progress === "object") ? me.progress : {};
  const licensed = !!(prog.w3_reslic || prog.w3_exam || prog.w1_exam);
  const level = me ? (me.contract_level || "") : "";
  const avail = await loadKey("cft_availability"); const nm = me ? low(full(me)) : "";
  const is_cft = !!(avail && Array.isArray(avail.cfts) && avail.cfts.some((c: any) => low(c.name) === nm && !c.hidden));
  const pols = await getJSON(`policies?agent_code=eq.${encodeURIComponent(code)}&select=expected_commission&limit=5000`);
  const cashflow = pols.reduce((t: number, p: any) => t + (Number(p.expected_commission) || 0), 0);
  let tenure_days = 0; if (me && me.created_at) { const t = new Date(me.created_at).getTime(); if (!isNaN(t)) tenure_days = Math.max(0, Math.floor((Date.now() - t) / 86400000)); }
  const org = (await loadKey("org_structure")) || { nodes: [] };
  const nodes = Array.isArray(org.nodes) ? org.nodes : [];
  const children: Record<string, string[]> = {}; nodes.forEach((n: any) => { const p = norm(n.parent || ""); if (!children[p]) children[p] = []; children[p].push(norm(n.id)); });
  const desc: string[] = []; const q = [...(children[norm(code)] || [])]; let g = 0;
  while (q.length && g++ < 5000) { const c = q.shift()!; if (desc.indexOf(c) >= 0) continue; desc.push(c); (children[c] || []).forEach((x) => q.push(x)); }
  let team_active = 0, team_mds = 0;
  if (desc.length) {
    const trows = await getJSON(`tracker_agents?code=in.(${encodeURIComponent(desc.join(","))})&select=code,contract_level,status&limit=5000`);
    trows.forEach((t: any) => { if (low(t.status) === "quit") return; team_active++; if (levelRank(t.contract_level) >= 2) team_mds++; });
  }
  const stats = (await loadKey("emblem_stats")) || {};
  const champ = (stats[norm(code)] && Number(stats[norm(code)].champ)) || 0;
  return { name: me ? full(me) : "", level, licensed, is_cft, cashflow, team_active, team_mds, champ, tenure_days };
}
function earnedIds(s: any): string[] {
  const r = levelRank(s.level); const out: string[] = [];
  if (s.licensed) out.push("licensed");
  if (s.is_cft) out.push("cft");
  if (r >= 1) out.push("senior_associate");
  if (r >= 2) out.push("md");
  if (r >= 3) out.push("emd");
  if (s.cashflow >= 100000) out.push("cash_100k");
  if (s.cashflow >= 250000) out.push("cash_250k");
  if (s.cashflow >= 500000) out.push("cash_500k");
  if (s.cashflow >= 1000000) out.push("cash_1m");
  if (s.team_active >= 10) out.push("team_10");
  if (s.team_active >= 25) out.push("team_25");
  if (s.team_active >= 50) out.push("team_50");
  if (s.team_active >= 100) out.push("team_100");
  if (s.team_mds >= 1) out.push("md_1");
  if (s.team_mds >= 3) out.push("md_3");
  if (s.team_mds >= 5) out.push("md_5");
  if (s.champ >= 1) out.push("champ_1");
  if (s.champ >= 5) out.push("champ_5");
  if (s.champ >= 10) out.push("champ_10");
  if (s.tenure_days >= 90) out.push("tenure_3mo");
  if (s.tenure_days >= 182) out.push("tenure_6mo");
  if (s.tenure_days >= 365) out.push("tenure_1yr");
  if (s.tenure_days >= 730) out.push("tenure_2yr");
  if (s.tenure_days >= 1095) out.push("tenure_3yr");
  if (s.tenure_days >= 1825) out.push("tenure_5yr");
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: any = {}; try { body = req.method === "POST" ? await req.json() : {}; } catch (_) { body = {}; }
  const url = new URL(req.url);
  const action = String(body.action || url.searchParams.get("action") || "get");

  const isOps = await opsAuthorized(body.token);
  const me = isOps ? "" : await sessionCode(body.session);
  if (!isOps && !me) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401);

  if (action === "all_active") {
    // Only the chosen icon and its tier — the calling-card chip beside a name in chat. No numbers.
    const sel = (await loadKey("broker_emblems")) || {};
    const META: Record<string, any> = {}; EMBLEMS.forEach((e) => META[e.id] = { icon: e.icon, tier: e.tier });
    const out: Record<string, any> = {};
    for (const k of Object.keys(sel)) { const ids = sel[k]; const id = Array.isArray(ids) ? ids[0] : null; if (id && META[id]) out[norm(k)] = META[id]; }
    return json({ ok: true, emblems: out });
  }

  // Operations may look at a named person's case; everybody else is themselves.
  const code = isOps ? norm(body.code || url.searchParams.get("code")) : me;
  if (!code) return json({ ok: false, error: "sign in required" }, 401);

  if (action === "get") {
    const s = await computeStats(code);
    const earned = new Set(earnedIds(s));
    const sel = (await loadKey("broker_emblems")) || {};
    let selected: string[] = Array.isArray(sel[code]) ? sel[code] : [];
    selected = selected.filter((id) => earned.has(id));
    const catalog = EMBLEMS.map((e) => ({ id: e.id, name: e.name, desc: e.desc, icon: e.icon, tier: e.tier, cat: e.cat, earned: earned.has(e.id) }));
    return json({ ok: true, name: s.name, catalog, selected, stats: { cashflow: s.cashflow, team_active: s.team_active, team_mds: s.team_mds, champ: s.champ, tenure_days: s.tenure_days, level: s.level, licensed: s.licensed, is_cft: s.is_cft }, earned_count: earned.size, total: EMBLEMS.length });
  }

  if (action === "select") {
    const s = await computeStats(code);
    const earned = new Set(earnedIds(s));
    let ids: string[] = Array.isArray(body.ids) ? body.ids.map((x: any) => String(x)) : [];
    ids = ids.filter((id) => earned.has(id) && EMBLEMS.some((e) => e.id === id)).slice(0, 5);
    const sel = (await loadKey("broker_emblems")) || {};
    sel[code] = ids; await saveKey("broker_emblems", sel);
    return json({ ok: true, selected: ids });
  }

  return json({ ok: false, error: "unknown action" }, 400);
});
