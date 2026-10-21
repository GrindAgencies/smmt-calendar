// integrity-check v2 — direct-upline / org-tree integrity scan for the roll-up (report-only).
// Flags where the leaderboard roll-up parent (org tree, then md/emd) disagrees with the
// recruit designation (direct_to), plus orphans, missing org nodes, quit uplines, cycles,
// and subtrees disconnected from the root. Read-only; never edits data.
//
// v2 (2026-09-30): authorisation goes through ops_authorize(). v1 read a token from an env var
// that was never set and FELL BACK TO THE LITERAL "2026", so four digits returned the whole
// company's structural report — 193 agents, every orphan and every mismatch — to anyone. The
// fallback is the bug: a secret that defaults to a guessable value is not a secret.
const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
function json(o: unknown, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const low = (s: unknown) => (s ?? "").toString().trim().toLowerCase();
const full = (a: any) => `${a.first_name || ""} ${a.last_name || ""}`.trim();
async function loadKey(k: string) { const r = await fetch(`${SUPA}/rest/v1/app_settings?key=eq.${k}&select=value`, { headers: DBH }); const rows = await r.json(); return (rows && rows[0]) ? rows[0].value : null; }
async function getJSON(path: string) { const r = await fetch(`${SUPA}/rest/v1/${path}`, { headers: DBH }); return (await r.json()) || []; }
async function opsAuthorized(token: unknown): Promise<boolean> {
  const t = String(token ?? "").trim();
  if (!t) return false;
  try {
    const r = await fetch(`${SUPA}/rest/v1/rpc/ops_authorize`, { method: "POST", headers: DBH, body: JSON.stringify({ p_token: t }) });
    const j = await r.json();
    return !!(j && j.ok);
  } catch (_) { return false; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: any = {}; try { body = req.method === "POST" ? await req.json() : {}; } catch (_) { body = {}; }
  if (!(await opsAuthorized(body.token))) return json({ ok: false, error: "unauthorized" }, 401);

  const org = (await loadKey("org_structure")) || { root: "", nodes: [] };
  const root = norm(org.root);
  const nodes: any[] = Array.isArray(org.nodes) ? org.nodes : [];
  const orgParent: Record<string, string> = {}; const inOrg: Record<string, boolean> = {};
  nodes.forEach((n) => { const id = norm(n.id); inOrg[id] = true; orgParent[id] = norm(n.parent || ""); });

  const agents = await getJSON("tracker_agents?select=code,first_name,last_name,direct_to,direct_to_name,md,emd,status,baseshop&limit=2000");
  const byCode: Record<string, any> = {}; const nameToCode: Record<string, string> = {};
  agents.forEach((a: any) => { const c = norm(a.code); byCode[c] = a; if (full(a)) nameToCode[low(full(a))] = c; });
  const nmeOf = (c: string) => byCode[c] ? full(byCode[c]) : c;

  function rollupParent(a: any, c: string) {
    // mirrors the leaderboard/team-board roll-up: org parent, else md name, else emd name
    if (orgParent[c]) return orgParent[c];
    const m = nameToCode[low(a.md)]; if (m) return m;
    const e = nameToCode[low(a.emd)]; if (e) return e;
    return "";
  }

  const flagged: any[] = [];
  const counts: Record<string, number> = { mismatch: 0, orphan: 0, not_in_org: 0, no_direct_to: 0, quit_upline: 0, unplaceable: 0, disconnected: 0, cycle: 0 };

  for (const a of agents) {
    const c = norm(a.code); if (c === root) continue; if (low(a.status) === "quit") continue;
    const issues: any[] = [];
    const dt = norm(a.direct_to);
    const rp = rollupParent(a, c);

    if (!inOrg[c]) { issues.push({ type: "not_in_org", detail: "Not on the org chart" }); counts.not_in_org++; }
    if (!rp && !dt) { issues.push({ type: "orphan", detail: "No upline at all — production is counted for nobody" }); counts.orphan++; }
    else {
      if (dt && rp && dt !== rp) { issues.push({ type: "mismatch", detail: `Rolls up to ${nmeOf(rp)} but direct recruit is ${a.direct_to_name || nmeOf(dt)}` }); counts.mismatch++; }
      if (dt && !rp) { issues.push({ type: "unplaceable", detail: `Recruited by ${a.direct_to_name || nmeOf(dt)} but not placed in the roll-up tree` }); counts.unplaceable++; }
      if (!dt && rp) { issues.push({ type: "no_direct_to", detail: `In the tree under ${nmeOf(rp)} but no direct-recruit tag set` }); counts.no_direct_to++; }
    }
    if (rp && byCode[rp] && low(byCode[rp].status) === "quit") { issues.push({ type: "quit_upline", detail: `Upline ${nmeOf(rp)} has quit — production rolls into a dead node` }); counts.quit_upline++; }

    if (issues.length) flagged.push({ code: a.code, name: full(a), baseshop: a.baseshop || "", status: a.status || "", upline: rp ? nmeOf(rp) : "—", direct_to: a.direct_to_name || (dt ? nmeOf(dt) : "—"), issues });
  }

  // org-tree structural checks: disconnected from root + cycles
  for (const n of nodes) {
    const id = norm(n.id); if (id === root) continue;
    let cur = id; const seen: Record<string, boolean> = {}; let reachedRoot = false, cyc = false, hops = 0;
    while (cur && hops < 100) { hops++; const p = orgParent[cur]; if (!p) break; if (p === root) { reachedRoot = true; break; } if (seen[p]) { cyc = true; break; } seen[p] = true; cur = p; }
    if (cyc) counts.cycle++;
    else if (!reachedRoot) counts.disconnected++;
  }

  // severity ordering
  const rank: Record<string, number> = { orphan: 0, mismatch: 1, unplaceable: 2, quit_upline: 3, not_in_org: 4, no_direct_to: 5 };
  flagged.sort((a, b) => (rank[a.issues[0].type] ?? 9) - (rank[b.issues[0].type] ?? 9) || a.name.localeCompare(b.name));

  return json({ ok: true, root: nmeOf(root), scanned_at: new Date().toISOString(), agent_total: agents.length, org_nodes: nodes.length, flagged_count: flagged.length, counts, flagged });
});
