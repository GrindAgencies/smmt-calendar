// fix-org v2 — one-shot repair: rebuild org_structure parents from tracker_agents.direct_to
// (the recruit source of truth), place missing active agents into the tree, back up first.
// action 'preview' (default) = dry run diff; action 'apply' = backs up then writes.
//
// v2 (2026-10-20, backend audit): AUTH. This was the worst of the leftover holes. v1 read
//   const TOKEN = Deno.env.get("INTEGRITY_TOKEN") || "2026"
// and INTEGRITY_TOKEN has never been set in this project, so the fallback was live: anyone who
// posted {"token":"2026","action":"apply"} could REWRITE app_settings.org_structure — the tree
// every baseshop, team roll-up and permission check is derived from. A read-only preview was
// bad; the apply path was a stranger restructuring the company. The same defaulted-literal bug
// was found and fixed in integrity-check on 2026-09-30 and in six other functions on
// 2026-10-05; this one was missed because nothing legitimate calls it, so nothing ever broke in
// a way that pointed here. Now authorises through ops_authorize() — a real Operations session
// or the 'cron' machine token — with no literal fallback of any kind.
const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
function json(o: unknown, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const full = (a: any) => `${a.first_name || ""} ${a.last_name || ""}`.trim();
async function loadKey(k: string) { const r = await fetch(`${SUPA}/rest/v1/app_settings?key=eq.${k}&select=value`, { headers: DBH }); const rows = await r.json(); return (rows && rows[0]) ? rows[0].value : null; }
async function saveKey(k: string, value: unknown) { await fetch(`${SUPA}/rest/v1/app_settings?on_conflict=key`, { method: "POST", headers: { ...DBH, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key: k, value, updated_at: new Date().toISOString() }) }); }
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
  const apply = String(body.action || "preview") === "apply";

  const org = (await loadKey("org_structure")) || { root: "", nodes: [] };
  const root = norm(org.root);
  const nodes: any[] = Array.isArray(org.nodes) ? JSON.parse(JSON.stringify(org.nodes)) : [];
  const nodeById: Record<string, any> = {}; nodes.forEach((n) => { nodeById[norm(n.id)] = n; });

  const agents = await getJSON("tracker_agents?select=code,first_name,last_name,direct_to,baseshop,status&limit=2000");
  const ag: Record<string, any> = {}; const active = new Set<string>();
  agents.forEach((a: any) => { const c = norm(a.code); ag[c] = a; if ((a.status || "active").toLowerCase() !== "quit") active.add(c); });
  const nmeOf = (c: string) => ag[c] ? full(ag[c]) : (nodeById[c] ? nodeById[c].name : c);

  const reparented: any[] = []; const added: any[] = []; const skipped: any[] = [];

  // 1) reparent existing nodes to direct_to when it's a valid active recruiter
  for (const n of nodes) {
    const c = norm(n.id); if (c === root) { n.parent = null; continue; }
    const a = ag[c]; if (!a) continue;
    const dt = norm(a.direct_to);
    if (dt && active.has(dt) && norm(n.parent) !== dt) { reparented.push({ code: c, name: nmeOf(c), from: n.parent ? nmeOf(norm(n.parent)) : "—", to: nmeOf(dt) }); n.parent = dt; }
  }

  // 2) add missing active agents under their direct_to (dependency-ordered)
  const present = new Set(Object.keys(nodeById));
  let ord = 90; let progress = true;
  while (progress) {
    progress = false;
    for (const c of active) {
      if (present.has(c) || c === root) continue;
      const a = ag[c]; const dt = norm(a.direct_to);
      if (c === "APLREVIEW") continue;                 // review demo acct — keep out of the org
      if (!dt || !active.has(dt)) continue;             // no valid recruiter — handle after loop
      if (!present.has(dt)) continue;                    // parent not placed yet — wait a pass
      const node = { id: a.code, gfi: a.code, ord: ord++, name: full(a), role: "agent", parent: dt, baseshop: a.baseshop || "" };
      nodes.push(node); nodeById[c] = node; present.add(c); added.push({ code: c, name: full(a), under: nmeOf(dt) }); progress = true;
    }
  }
  // leftover unplaceable
  for (const c of active) { if (!present.has(c) && c !== root && c !== "APLREVIEW") { const a = ag[c]; skipped.push({ code: c, name: full(a), reason: a.direct_to ? ("recruiter " + norm(a.direct_to) + " not active/placeable") : "no direct_to set" }); } }

  // cycle check
  let cycle = null;
  for (const n of nodes) { let cur = norm(n.id), seen: Record<string, boolean> = {}, hops = 0; while (cur && hops++ < 200) { const p = norm(nodeById[cur] ? (nodeById[cur].parent || "") : ""); if (!p) break; if (p === norm(n.id)) { cycle = norm(n.id); break; } if (seen[p]) break; seen[p] = true; cur = p; } if (cycle) break; }

  const summary = { reparented: reparented.length, added: added.length, skipped: skipped.length, cycle };
  if (!apply || cycle) return json({ ok: !cycle, mode: apply && cycle ? "aborted-cycle" : "preview", summary, reparented, added, skipped });

  // APPLY: backup then write
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  await saveKey("org_structure_backup_" + stamp, org);
  const newOrg = { root: org.root, nodes, updated: new Date().toISOString().slice(0, 10), repaired_from: "direct_to", backup_key: "org_structure_backup_" + stamp };
  await saveKey("org_structure", newOrg);
  return json({ ok: true, mode: "applied", backup_key: "org_structure_backup_" + stamp, summary, reparented, added, skipped });
});
