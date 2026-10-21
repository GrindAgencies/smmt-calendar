// org-api v13 — THE single source of truth for hierarchy. Everything is derived from ONE link:
// tracker_agents.direct_to (a person -> their DIRECT upline's code).
// Actions: tree | downline | stats | set_upline | unassigned | can_edit. verify_jwt:false.
//
// v13 (2026-09-30) — AND THE TYPED CODE IS GONE TOO. v12 (below) removed the hardcoded "2026" and
// described exactly what it had been exposing. What it left behind was the same exposure through a
// different door: authority was decided by a `by` / `code` the REQUEST supplied, and GFI codes are
// printed on the org chart. Typing an Operations seat code or Eli's code produced:
//   · can_edit → can_edit_hierarchy TRUE, and then set_upline could RESTRUCTURE THE COMPANY,
//     moving anyone under anyone — the one thing v4 set out to protect;
//   · tree → scope "all", i.e. all 189 people UNREDACTED with emails and phone numbers, which is
//     word for word the leak v12 thought it had closed.
// And downline / stats took a bare code, so any leader's whole team was readable by typing theirs.
// Identity is now the session token minted when somebody enters their PIN, or an Operations token
// ops_authorize() accepts. downline / stats stay available for drilling into a sub-leg — the
// subject must be you, or somebody inside your own downline.
//
// v12 (2026-09-30) — THE HARDCODED "2026" IS GONE. This function compared the caller's token to a
// literal, so it never asked the database and could not be closed by legacy_ops_token_allowed.
// With four digits and no credentials, anyone on the internet received all 189 people UNREDACTED
// — names, emails and phone numbers — with scope "all" and can_edit_hierarchy TRUE, which is the
// power to restructure the company. Authorisation now goes through ops_authorize(), the same
// authority every other Operations endpoint uses: a real Operations session or the cron machine
// token, and nothing else.
//
// v11 (2026-09-30) — ownsHierarchy() honours is_platform_admin(). Christopher builds the platform
// without holding a rank on it, so he was locked out of the very control he was asking for.
// Operations and Eli Cox are unchanged, and being an MD or EMD is still not enough.
//
// v10 (2026-09-10) — THE ORG CHART IS THE ONE DELIBERATELY COMPANY-WIDE TAB, BUT NOT
// COMPANY-WIDE IN DETAIL. Christopher, asked directly, chose: "Names company-wide,
// details own shop only." Everyone still sees the whole family tree — name, title,
// level, photo, and who reports to whom — because that is the hierarchy view he wants.
// But EMAIL, PHONE, licence status, onboarding %, activity and streak now fill in only
// for people in a baseshop you may see.
// Scope comes from agent_scope(), the same rule the other tabs use. Nodes outside it
// carry `limited: true` so the page can say so instead of rendering a blank as "no
// activity yet", which would libel another shop as dormant.
// `downline` and `stats` are NOT limited: those walk YOUR OWN team, which is yours to see
// even where a leg crosses a shop boundary.
//
// v8 (2026-09-05) — DEPARTED PEOPLE STAY ON THE TREE AS A SHADOW RECORD, and the
// system accounts (9999, APLREVIEW, DEMO2026, POOL) are excluded from it entirely.
// Departed people are returned with `departed: true`, are never counted as active,
// are excluded from team totals, active %, new-recruit counts and leg sizes, and
// never appear in "needs placing". They are structure and history, not headcount.
//
// v4 — WHO MAY CHANGE THE HIERARCHY. Reassigning an upline used to be open to
// any MD or EMD, which meant a baseshop leader could quietly move people between
// legs and reshape the org chart everyone else is measured on. The hierarchy is
// Operations and Eli Cox only. EMDs keep total control INSIDE their own baseshop
// — branding, dashboard, recordings, their team's day to day — but the shape of
// the org is not theirs to edit.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ACTIVE_DAYS = 21;
const NEW_DAYS = 30;
// Operations platform codes 0000-0005, and 9999 the creator account.
const OPS_CODE = /^(000[0-5]|9999)$/;
const HIERARCHY_OWNERS = new Set(["GFI20"]);   // Eli Cox — National Vice President
// Not people. The creator account, the Apple review logins and the shared leads
// bucket are machinery — they must never appear on the family tree.
const SYSTEM_CODES = new Set(["9999", "APLREVIEW", "DEMO2026", "POOL"]);
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
function json(o: unknown, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const clean = (s: unknown) => (s ?? "").toString().trim();
const fullName = (a: Record<string, unknown>) => `${a.first_name || ""} ${a.last_name || ""}`.trim();
function daysSince(ts: unknown): number | null { if (!ts) return null; const t = new Date(String(ts)).getTime(); if (isNaN(t)) return null; return Math.floor((Date.now() - t) / 86400000); }
const isDeparted = (a: Record<string, unknown>) => (a.status ?? "").toString().trim().toLowerCase() === "quit";

async function rpc(fn: string, args: Record<string, unknown>) {
  try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); return await r.json(); } catch (_) { return null; }
}
/* v12: the one authority for "is this really Operations". Never a literal. */
async function opsAuthorized(token: unknown): Promise<boolean> {
  const t = String(token ?? "").trim();
  if (!t) return false;
  const r = await rpc("ops_authorize", { p_token: t });
  return !!(r && r.ok);
}
/* v13: the one authority for "which member is this". A session token is proof; a code is not. */
async function sessionCode(session: unknown): Promise<string> {
  const s = String(session ?? "").trim().slice(0, 120);
  if (!s) return "";
  const got = await rpc("agent_session_code", { p_token: s });
  return (typeof got === "string") ? norm(got) : "";
}
/* Which baseshops may this caller see? One canonical rule, shared with the other tabs. */
async function agentScope(code: string) {
  const r = await rpc("agent_scope", { p_code: norm(code) });
  if (!r || r.ok !== true) return { ok: false, all: false, bases: [] as string[] };
  return { ok: true, all: !!r.all, bases: Array.isArray(r.bases) ? r.bases.map((x: unknown) => norm(x)) : [] as string[] };
}

function levelOf(a: Record<string, unknown>): string {
  const cl = (a.contract_level ?? "").toString().trim();
  if (cl) return cl;
  const t = (a.title ?? "").toString().toLowerCase();
  if (/executive marketing/.test(t)) return "Executive Marketing Director";
  if (/marketing director/.test(t)) return "Marketing Director";
  if (/senior/.test(t)) return "Senior Associate";
  return "Associate";
}
function isMgrLevel(lvl: string): boolean {
  const l = (lvl || "").toLowerCase().trim();
  if (/marketing director|executive|national vice|senior executive/.test(l)) return true;
  return l === "emd" || l === "md" || l === "nvp" || l === "sevp";
}

async function loadAgents(): Promise<Record<string, unknown>[]> {
  const r = await fetch(`${SUPA}/rest/v1/tracker_agents?select=code,first_name,last_name,title,contract_level,baseshop,direct_to,direct_to_name,status,license_status,pct,progress,last_activity,streak,created_at,email,phone&limit=5000`, { headers: DBH });
  const all: Record<string, unknown>[] = (await r.json()) || [];
  const agents = all.filter((a) => !SYSTEM_CODES.has(norm(a.code)));
  try {
    const pr = await fetch(`${SUPA}/rest/v1/hub_avatars?select=code`, { headers: DBH });
    const prows: Record<string, unknown>[] = (await pr.json()) || [];
    const pset = new Set(prows.map((x) => norm(x.code)));
    for (const a of agents) a._photo = pset.has(norm(a.code));
  } catch (_) { /* photos optional */ }
  return agents;
}

function buildGraph(agents: Record<string, unknown>[]) {
  const byCode: Record<string, Record<string, unknown>> = {};
  for (const a of agents) byCode[norm(a.code)] = a;
  const kids: Record<string, string[]> = {};
  const roots: string[] = []; const unassigned: string[] = [];
  for (const a of agents) {
    const code = norm(a.code); const up = norm(a.direct_to);
    if (up && byCode[up] && up !== code) { (kids[up] = kids[up] || []).push(code); }
    else if (!up) {
      const lvl = levelOf(a).toLowerCase();
      if (/executive marketing|national vice|senior executive/.test(lvl) || /exec/.test((a.title ?? "").toString().toLowerCase()) || lvl === "emd" || lvl === "nvp" || lvl === "sevp") roots.push(code);
      else if (!isDeparted(a)) unassigned.push(code);
    } else if (up && !byCode[up]) { if (!isDeparted(a)) unassigned.push(code); }
  }
  const subtree: Record<string, number> = {};
  function count(code: string, seen: Set<string>): number {
    if (seen.has(code)) return 0; seen.add(code);
    let n = 0;
    for (const k of (kids[code] || [])) {
      const kid = byCode[k];
      n += (kid && isDeparted(kid) ? 0 : 1) + count(k, seen);
    }
    subtree[code] = n; return n;
  }
  for (const rc of roots.concat(unassigned)) count(rc, new Set());
  for (const a of agents) if (subtree[norm(a.code)] === undefined) count(norm(a.code), new Set());
  return { byCode, kids, roots, unassigned, subtree };
}

/* Everyone beneath this person, by walking the tree down. Used to decide whether a `downline` or
   `stats` request is about a team the caller is actually above. */
function descendantsOf(start: string, kids: Record<string, string[]>): Set<string> {
  const out = new Set<string>();
  (function w(c: string) { for (const k of (kids[c] || [])) { if (out.has(k)) continue; out.add(k); w(k); } })(norm(start));
  return out;
}

// `full` = may this caller see this person's DETAIL, not just their place on the chart.
function nodeView(a: Record<string, unknown>, kids: Record<string, string[]>, subtree: Record<string, number>, full = true) {
  const code = norm(a.code); const dsAct = daysSince(a.last_activity); const dsNew = daysSince(a.created_at);
  const gone = isDeparted(a);
  const base = {
    code, name: fullName(a), title: clean(a.title), level: levelOf(a), baseshop: clean(a.baseshop) || "",
    direct_to: norm(a.direct_to) || "", direct_to_name: clean(a.direct_to_name),
    departed: gone, status: clean(a.status) || "active",
    directs: (kids[code] || []).length, downline_total: subtree[code] || 0,
    has_photo: !!a._photo,
  };
  if (!full) {
    return {
      ...base, limited: true,
      license_status: "", onboarding_pct: 0,
      last_activity: null, days_inactive: null, streak: 0,
      created_at: null, is_new: false, active: false,
      email: "", phone: "",
    };
  }
  return {
    ...base, limited: false,
    license_status: clean(a.license_status), onboarding_pct: Number(a.pct) || 0,
    last_activity: a.last_activity || null, days_inactive: dsAct, streak: Number(a.streak) || 0,
    created_at: a.created_at || null, is_new: !gone && dsNew !== null && dsNew <= NEW_DAYS,
    active: !gone && dsAct !== null && dsAct <= ACTIVE_DAYS,
    email: clean(a.email), phone: clean(a.phone),
  };
}

async function isManager(code: string, token: string): Promise<boolean> {
  if (await opsAuthorized(token)) return true; if (!code) return false;
  const r = await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${encodeURIComponent(code)}&select=title,contract_level`, { headers: DBH });
  const a = ((await r.json()) || [])[0]; if (!a) return false;
  return isMgrLevel(levelOf(a));
}

// The hierarchy itself: Operations, Eli Cox, and the platform builder. Deliberately
// a code / platform_admin check and not a level check — being an EMD is not enough.
// The code reaching here is always a VERIFIED one (session or Operations), never typed.
async function ownsHierarchy(byCode: string, token: string): Promise<boolean> {
  if (await opsAuthorized(token)) return true;
  const c = norm(byCode);
  if (!c) return false;
  if (OPS_CODE.test(c) || HIERARCHY_OWNERS.has(c)) return true;
  return (await rpc("is_platform_admin", { p_code: c })) === true;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = (req.method === "POST") ? (await req.json().catch(() => ({}))) : {};
    const action = (body.action as string) || "tree";
    const token = (body.token as string) || "";

    // WHO IS CALLING. Operations by token, or a member by the session minted at PIN entry.
    // `by` and `code` are no longer consulted for identity: they were the whole hole.
    const isOps = await opsAuthorized(token);
    const ME = isOps ? "" : await sessionCode(body.session);
    if (!isOps && !ME) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401);

    if (action === "can_edit") {
      return json({ ok: true, can_edit_hierarchy: await ownsHierarchy(ME, token), by: ME });
    }

    if (action === "tree" || action === "unassigned") {
      const who = ME;
      // Operations and the hierarchy owners see the chart in full; everyone else sees
      // full detail for their own shop and names-only elsewhere.
      let seeAll = isOps || OPS_CODE.test(who) || HIERARCHY_OWNERS.has(who);
      let myBases: string[] = [];
      if (!seeAll && who) {
        const sc = await agentScope(who);
        if (sc.ok) { seeAll = sc.all; myBases = sc.bases; }
      }
      const mayDetail = (b: unknown) => seeAll || myBases.indexOf(norm(b)) >= 0;

      const agents = await loadAgents(); const g = buildGraph(agents);
      const nodes = agents.map((a) => nodeView(a, g.kids, g.subtree, mayDetail(a.baseshop)));
      const canEdit = await ownsHierarchy(who, token);
      if (action === "unassigned") return json({ ok: true, can_edit_hierarchy: canEdit, scope: seeAll ? "all" : "baseshop", bases: myBases, unassigned: nodes.filter((n) => g.unassigned.indexOf(n.code) >= 0) });
      const departed = nodes.filter((n) => n.departed).length;
      return json({ ok: true, count: nodes.length, working: nodes.length - departed, departed, can_edit_hierarchy: canEdit, scope: seeAll ? "all" : "baseshop", bases: myBases, roots: g.roots, unassigned: g.unassigned, nodes });
    }

    if (action === "downline" || action === "stats") {
      const code = norm(body.code) || ME; if (!code) return json({ ok: false, error: "code required" }, 400);
      const agents = await loadAgents(); const g = buildGraph(agents);
      /* A system/placeholder login (DEMO2026, the App Store reviewer account, POOL) is excluded
         from the family tree on purpose, so it has no node — and the page was rendering that 404
         as "Could not load this team." An account with nobody under them has an EMPTY team, which
         is a different thing from an error, and is what a reviewer or a brand-new agent should
         see. Somebody asking about a person who genuinely is not there still gets the 404. */
      if (!g.byCode[code]) {
        if (code === ME) {
          const empty = { code, name: "", title: "", level: "", baseshop: "", direct_to: "", direct_to_name: "",
                          departed: false, status: "active", directs: 0, downline_total: 0, has_photo: false, limited: false };
          return (action === "downline")
            ? json({ ok: true, leader: empty, count: 0, count_all: 0, departed: 0, downline: [] })
            : json({ ok: true, leader: empty, total_downline: 0, departed: 0, directs: 0, active: 0, active_pct: 0, new_recruits_30d: 0, legs: [] });
        }
        return json({ ok: false, error: "not found" }, 404);
      }
      /* Yours to look at if it IS you, or somebody inside your own downline — which is what
         drilling into a sub-leg means. Anyone else's team is not. */
      if (!isOps && code !== ME && !descendantsOf(ME, g.kids).has(code)) {
        return json({ ok: false, error: "That team is not in your downline." }, 403);
      }

      if (action === "downline") {
        const out: Record<string, unknown>[] = []; const seen = new Set<string>();
        (function walk(c: string, depth: number) {
          for (const k of (g.kids[c] || [])) { if (seen.has(k)) continue; seen.add(k);
            const v = nodeView(g.byCode[k], g.kids, g.subtree) as Record<string, unknown>; v.depth = depth; out.push(v); walk(k, depth + 1); }
        })(code, 1);
        const legOf: Record<string, string> = {};
        (function tag(c: string, leg: string) { for (const k of (g.kids[c] || [])) { legOf[k] = leg || k; tag(k, leg || k); } })(code, "");
        for (const v of out) v.leg = legOf[v.code as string] || "";
        const me = nodeView(g.byCode[code], g.kids, g.subtree);
        const working = out.filter((v) => !v.departed).length;
        return json({ ok: true, leader: me, count: working, count_all: out.length, departed: out.length - working, downline: out });
      }

      const all: Record<string, unknown>[] = []; const seen = new Set<string>();
      (function walk(c: string) { for (const k of (g.kids[c] || [])) { if (seen.has(k)) continue; seen.add(k); all.push(nodeView(g.byCode[k], g.kids, g.subtree)); walk(k); } })(code);
      const dl = all.filter((n) => !n.departed);
      const active = dl.filter((n) => n.active).length;
      const newRecruits = dl.filter((n) => n.is_new).length;
      const directs = (g.kids[code] || []).filter((k) => !isDeparted(g.byCode[k] || {})).length;
      const legs = (g.kids[code] || []).filter((k) => !isDeparted(g.byCode[k] || {})).map((k) => ({ code: k, name: (g.byCode[k] ? fullName(g.byCode[k]) : k), size: 1 + (g.subtree[k] || 0), active: 0 }));
      for (const leg of legs) { let ac = 0; const s = new Set<string>(); (function w(c: string) { for (const kk of (g.kids[c] || [])) { if (s.has(kk)) continue; s.add(kk); const nv = nodeView(g.byCode[kk], g.kids, g.subtree); if (nv.active) ac++; w(kk); } })(leg.code); const self = nodeView(g.byCode[leg.code], g.kids, g.subtree); leg.active = ac + (self.active ? 1 : 0); }
      return json({ ok: true, leader: nodeView(g.byCode[code], g.kids, g.subtree), total_downline: dl.length, departed: all.length - dl.length, directs, active, active_pct: dl.length ? Math.round(active / dl.length * 100) : 0, new_recruits_30d: newRecruits, legs: legs.sort((a, b) => (b.size as number) - (a.size as number)) });
    }

    if (action === "set_upline") {
      const code = norm(body.code); const newUp = norm(body.direct_to); const by = ME;
      if (!code) return json({ ok: false, error: "code required" }, 400);
      if (!(await ownsHierarchy(by, token))) {
        return json({ ok: false, error: "The hierarchy is managed by Operations and Eli Cox. Ask them to move someone — you keep full control of your own baseshop." }, 403);
      }
      if (newUp && newUp === code) return json({ ok: false, error: "A person can't report to themselves." }, 400);
      if (newUp) {
        const agents = await loadAgents(); const g = buildGraph(agents);
        const bad = new Set<string>();
        (function w(c: string) { for (const k of (g.kids[c] || [])) { if (!bad.has(k)) { bad.add(k); w(k); } } })(code);
        if (bad.has(newUp)) return json({ ok: false, error: "That would create a loop — you can't move someone under their own downline." }, 400);
        if (!g.byCode[newUp]) return json({ ok: false, error: "That upline code doesn't exist." }, 400);
      }
      const upName = newUp ? await (async () => { const r = await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${encodeURIComponent(newUp)}&select=first_name,last_name`, { headers: DBH }); const u = ((await r.json()) || [])[0]; return u ? fullName(u) : ""; })() : "";
      const up = await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${encodeURIComponent(code)}`, { method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify({ direct_to: newUp || null, direct_to_name: upName || null, updated_at: new Date().toISOString() }) });
      return json({ ok: up.ok, code, direct_to: newUp, direct_to_name: upName, by: by || "Operations" });
    }

    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) { return json({ ok: false, error: String(e) }, 500); }
});
