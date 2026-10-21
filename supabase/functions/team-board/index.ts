// team-board — cumulative "Team, all levels" leaderboard (isolated; does NOT touch leaderboard-api).
// Each person's value = their OWN contribution + the entire downline subtree, summed bottom-up.
// Same board shape as leaderboard-api competition mode so the dashboard renders it unchanged.
//
// v4 (2026-09-30): WHOSE TEAM. The board was built around a typed `code`, and GFI codes are printed
// on the org chart — so typing a leader's code returned THEIR team's board: every name in their
// downline with premium written, trainings run, recruits and licensing. That is another shop's
// performance data, which is exactly what the baseshop-isolation work set out to keep separate.
// Identity is now the session token minted at PIN entry; Operations may still name a leader.
const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const NET_MIN = 1000;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
function json(o: unknown, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const low = (s: unknown) => (s ?? "").toString().trim().toLowerCase();
const full = (a: any) => `${a.first_name || ""} ${a.last_name || ""}`.trim();
const isLic = (ls: unknown) => { const s = low(ls); return !!s && (s.includes("licensed") || s.includes("passed exam") || s.includes("appointed")) && !s.includes("not licensed") && !s.includes("unlicensed"); };
const MN = ["January","February","March","April","May","June","July","August","September","October","November","December"];
async function loadKey(k: string) { const r = await fetch(`${SUPA}/rest/v1/app_settings?key=eq.${k}&select=value`, { headers: DBH }); const rows = await r.json(); return (rows && rows[0]) ? rows[0].value : null; }
async function getJSON(path: string) { const r = await fetch(`${SUPA}/rest/v1/${path}`, { headers: DBH }); return (await r.json()) || []; }
async function rpc(fn: string, args: Record<string, unknown>) { try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); return await r.json(); } catch (_) { return null; } }
async function opsAuthorized(t: unknown) { const s = String(t ?? ""); if (!s) return false; const r = await rpc("ops_authorize", { p_token: s }); return !!(r && r.ok); }
/* Proof of identity. A session token is proof; a typed code is not. */
async function sessionCode(session: unknown): Promise<string> {
  const s = String(session ?? "").trim().slice(0, 120);
  if (!s) return "";
  const got = await rpc("agent_session_code", { p_token: s });
  return (typeof got === "string") ? norm(got) : "";
}
function periodStart(period: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(new Date());
  const gp = (t: string) => { const x = parts.find((p) => p.type === t); return x ? x.value : ""; };
  const y = parseInt(gp("year"), 10), m = parseInt(gp("month"), 10), d = parseInt(gp("day"), 10);
  const wd = ({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 } as Record<string, number>)[gp("weekday")] || 0;
  const pad = (n: number) => (n < 10 ? "0" + n : "" + n);
  if (period === "year") return { ymd: `${y}-01-01`, label: `${y} · Year to date` };
  if (period === "week") { const back = (wd === 0 ? 6 : wd - 1); const dt = new Date(Date.UTC(y, m - 1, d)); dt.setUTCDate(dt.getUTCDate() - back); return { ymd: dt.toISOString().slice(0, 10), label: `Week of ${MN[dt.getUTCMonth()].slice(0,3)} ${dt.getUTCDate()}` }; }
  return { ymd: `${y}-${pad(m)}-01`, label: `${MN[m - 1]} ${y}` };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: any = {}; try { body = req.method === "POST" ? await req.json() : {}; } catch (_) { body = {}; }

  const isOps = await opsAuthorized(body.token);
  const sess = isOps ? "" : await sessionCode(body.session);
  if (!isOps && !sess) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401);
  const code = isOps ? norm(body.code) : sess;

  let period = low(body.period || "month"); if (["week","month","year"].indexOf(period) < 0) period = "month";
  if (!code) return json({ ok: false, error: "missing code" }, 400);
  const P = periodStart(period); const start = P.ymd;

  const bases = (await loadKey("baseshops")) || { root: "STANDARD" };
  const root = bases.root || "STANDARD";
  const org = (await loadKey("org_structure")) || { nodes: [] };
  const nodes = Array.isArray(org.nodes) ? org.nodes : [];
  const parentOf: Record<string, string> = {}; const kids: Record<string, string[]> = {};
  nodes.forEach((n: any) => { const id = norm(n.id); const p = norm(n.parent || ""); parentOf[id] = p; if (p) (kids[p] = kids[p] || []).push(id); });

  const agents = await getJSON("tracker_agents?select=code,first_name,last_name,baseshop,created_at,md,emd,status,license_status&limit=2000");
  const byCode: Record<string, any> = {}; const nameToCode: Record<string, string> = {};
  agents.forEach((a: any) => { const c = norm(a.code); byCode[c] = { code: a.code, name: full(a), baseshop: a.baseshop || root, created_at: a.created_at, status: a.status || "active", license_status: a.license_status || "" }; if (full(a)) nameToCode[low(full(a))] = c; });
  // fill parent fallback (md/emd) for agents missing an org node
  agents.forEach((a: any) => { const c = norm(a.code); if (!parentOf[c]) { const p = nameToCode[low(a.md)] || nameToCode[low(a.emd)] || ""; if (p && p !== c) { parentOf[c] = p; (kids[p] = kids[p] || []).push(c); } } });

  // OWN contributions per node
  const ownPrem: Record<string, number> = {}, ownTrain: Record<string, number> = {}, ownRec: Record<string, number> = {}, ownNet: Record<string, number> = {}, ownLic: Record<string, number> = {};
  const pols = await getJSON(`policies?submitted_date=gte.${start}&select=agent_code,agent_name,annual_premium&limit=8000`);
  pols.forEach((p: any) => { const c = norm(p.agent_code) || nameToCode[low(p.agent_name)] || ""; if (!c) return; ownPrem[c] = (ownPrem[c] || 0) + (Number(p.annual_premium) || 0); });
  const allPols = await getJSON(`policies?select=agent_code,agent_name,annual_premium&limit=20000`);
  const allPrem: Record<string, number> = {};
  allPols.forEach((p: any) => { const c = norm(p.agent_code) || nameToCode[low(p.agent_name)] || ""; if (!c) return; allPrem[c] = (allPrem[c] || 0) + (Number(p.annual_premium) || 0); });
  const bks = await getJSON(`bookings?category=ilike.*field*training*&select=agent_code,agent_name,date,starts_at,status&limit=5000`);
  bks.forEach((b: any) => { const st = low(b.status); if (["canceled","declined","no_show","transferred","pending"].includes(st)) return; const d = ((b.date||"").toString().slice(0,10)) || ((b.starts_at||"").toString().slice(0,10)); if (!d || d < start) return; const c = norm(b.agent_code) || nameToCode[low(b.agent_name)] || ""; if (!c) return; ownTrain[c] = (ownTrain[c] || 0) + 1; });
  agents.forEach((a: any) => { const c = norm(a.code); if (low(a.status) === "quit") return;
    const cr = (a.created_at||"").toString().slice(0,10); const par = parentOf[c]; if (cr && cr >= start && par) ownRec[par] = (ownRec[par] || 0) + 1;  // new partner credits the DIRECT parent's own count
    if ((allPrem[c]||0) >= NET_MIN) ownNet[c] = 1;
    if (isLic(a.license_status)) ownLic[c] = 1;
  });

  // caller subtree (caller + all descendants)
  function subtree(rootc: string) { const out: string[] = []; const seen: Record<string, boolean> = {}; const stack = [rootc]; while (stack.length) { const n = stack.pop()!; if (seen[n]) continue; seen[n] = true; out.push(n); (kids[n] || []).forEach((k) => stack.push(k)); } return out; }
  const teamNodes = subtree(code);
  // cumulative subtree sum of an own-map, rooted at node x
  function cum(map: Record<string, number>, x: string) { let t = 0; const seen: Record<string, boolean> = {}; const stack = [x]; while (stack.length) { const n = stack.pop()!; if (seen[n]) continue; seen[n] = true; t += (map[n] || 0); (kids[n] || []).forEach((k) => stack.push(k)); } return t; }

  const OWN: Record<string, Record<string, number>> = { recruiter: ownRec, premium: ownPrem, trainings: ownTrain, licensed: ownLic, net_licenses: ownNet };
  const boards: Record<string, unknown> = {};
  for (const k of Object.keys(OWN)) {
    const rows = teamNodes.map((n) => ({ code: byCode[n] ? byCode[n].code : n, name: byCode[n] ? byCode[n].name : n, baseshop: byCode[n] ? byCode[n].baseshop : "", value: cum(OWN[k], n), emb: null }))
      .filter((r) => r.value > 0);
    rows.sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
    let meRank = 0, meVal = 0; for (let i = 0; i < rows.length; i++) if (norm(rows[i].code) === code) { meRank = i + 1; meVal = rows[i].value; break; }
    boards[k] = { top: rows.slice(0, 10).map((r, i) => ({ ...r, rank: i + 1 })), me: { rank: meRank, value: meVal }, total: rows.length };
  }
  const me = byCode[code] || null;
  return json({ ok: true, scope: "team", period, base: me ? me.baseshop : root, month: P.label, team_size: teamNodes.length - 1, you: { code, name: me ? me.name : "", baseshop: me ? me.baseshop : root, emb: null }, boards });
});
