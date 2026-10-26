// summit-api v9 (2026-10-26: board `self`) · v8 (2026-10-24) — A TICK IS A REQUEST UNTIL AN EMD APPROVES IT. Handoff §9: ordinary
//     agents must not be able to promote themselves. Before v8 every one of the 124 ticks had been
//     set by the agent on their own ladder. Christopher chose "agent requests, EMD approves":
//     summit_checks.status is 'pending' or 'approved', only approved counts toward a stage, an
//     EMD in scope / Operations / the platform admin approves (never their own ladder), and every
//     request, approval, rejection, withdrawal and clear is written to summit_check_events.
//     New actions: `approvals` (the review queue) and `check_review` (approve/reject, batched).
//     The 124 pre-existing ticks were kept as approved — nobody lost progress.
//
// summit-api v7 (2026-10-20) — the Road is now TWENTY stages with stable requirement ids.
//     Completion moved from summit_progress(agent, stage_index, bool[]) to
//     summit_checks(agent, req_key) because the old shape stored ticks by ARRAY POSITION: a
//     reorder silently moved somebody's evidence onto a different milestone, and the ladder was
//     just reordered end to end. The old rows are archived, not deleted.
//     `board` also returns `derived` — per agent, the stage their AWARDED RANK proves through
//     plus the requirements the licensing board already evidences. That used to be computed in
//     the browser from signals that only load for the signed-in user, so teammates appeared to
//     have no record evidence at all. One call answers for everyone in scope.
//
// summit-api v5 (2026-09-30) — backing service for the Summit Org Chart / Road to EMD.
//
// v5: THE CASHFLOW LEVELS PAST EMD ARE NOW DATA, AND ELI OR OPERATIONS CAN ADD MORE.
//     Christopher: "MAKE IT SO ADDITIONAL LEVELS CAN BE ADDED BY ELIJAH COX and OPERATIONS ONLY.
//     based on loaded cashflow ... if someone crosses 500K in cashflow eli can set more levels to
//     be able to add diamonds to the emblem to make them grow."
//     The ladder used to be a hardcoded CASE in summit_ladder() AND a hardcoded CASH_TIERS array
//     in summit.html — two copies, both needing a code change to add a level. It is now one row:
//     app_settings.summit_cash_tiers. `board` returns it so the page can label the next level, and
//     `tiers_set` writes it. Deliberately NOT an EMD power: an EMD could otherwise invent a level
//     they have just cleared. Eli, Operations, and the platform builder only.
//
// v4: a shop's promotion standards are visible only to that shop. v3 returned every baseshop's
//     requirements to everyone, so an ELEVATE associate could read what SMMT demands. Standards
//     are a shop's internal business; they are now filtered to the viewer's own baseshop group,
//     the same rule the rest of the platform uses.
// v3: EACH EMD OWNS THEIR SHOP'S PROMOTION STANDARDS (summit_requirements, per baseshop; only
//     that shop's EMD or Operations may set them — an MD cannot rewrite the bar they are measured
//     against). Plus the old tracker's completions now count: summit_stages_done() maps My
//     Tracker's checklist onto the ladder and returns completion PER STAGE, because tracker
//     progress is not linear.
// v2: derived ladder from rank, cashflow and the EMD prestige tier.
//
// What this function deliberately does NOT own:
//   · agents, ranks, hierarchy  -> tracker_agents, read through org-api (baseshop scoping applies)
//   · production                -> the policies ledger, via summit_production(), splits honoured.
//   · checklist steps           -> tracker_agents.progress, still My Tracker's to own.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const low  = (s: unknown) => (s ?? "").toString().trim().toLowerCase();
const clean = (s: unknown, n = 200) => (s ?? "").toString().trim().slice(0, n);
const enc = encodeURIComponent;
const slug = (s: unknown) => low(s).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

async function db(path: string, init?: RequestInit) { return fetch(`${SUPA}/rest/v1/${path}`, { ...init, headers: { ...DBH, ...(init?.headers || {}) } }); }
async function dbGet(path: string) { const r = await db(path); return (await r.json()) || []; }
async function rpc(fn: string, args: Record<string, unknown>) { try { const r = await db(`rpc/${fn}`, { method: "POST", body: JSON.stringify(args) }); return await r.json(); } catch (_) { return null; } }
async function opsAuthorized(token: unknown) { const r = await rpc("ops_authorize", { p_token: String(token ?? "") }); return !!(r && r.ok); }

async function agentRow(code: string) { return (await dbGet(`tracker_agents?code=eq.${enc(norm(code))}&select=code,first_name,last_name,contract_level,title,baseshop,platform_admin`))[0] || null; }
const isLeader = (a: any) => ["MD", "EMD"].indexOf(norm(a && a.contract_level)) >= 0
  || /marketing director|vice president/i.test(String((a && a.title) || ""))
  || (a && a.platform_admin === true);
/* Setting the standards is an EMD act, not an MD one: an MD must not be able to rewrite the bar
   they are themselves measured against. */
const isEMD = (a: any) => ["EMD", "NVP"].indexOf(norm(a && a.contract_level)) >= 0
  || /executive marketing|vice president/i.test(String((a && a.title) || ""))
  || (a && a.platform_admin === true);

/* The cashflow levels past EMD. One row of data, seeded with the five thresholds that used to be
   hardcoded. Falls back to those if the row is ever missing, so the emblems never all reset. */
const DEFAULT_TIERS = [
  { at: 100000, name: "100K Ring" }, { at: 250000, name: "Quarter Million" },
  { at: 500000, name: "Half Million" }, { at: 1000000, name: "Million Dollar" },
  { at: 2500000, name: "Multi-Million" },
];
async function tiersOf(): Promise<{ at: number; name: string }[]> {
  const rows = await dbGet(`app_settings?key=eq.summit_cash_tiers&select=value`);
  const raw = (rows[0] && rows[0].value && Array.isArray(rows[0].value.tiers)) ? rows[0].value.tiers : null;
  if (!raw || !raw.length) return DEFAULT_TIERS;
  return raw.map((t: any) => ({ at: Number(t.at) || 0, name: clean(t.name, 40) || "" }))
            .filter((t: any) => t.at > 0)
            .sort((a: any, b: any) => a.at - b.at);
}
/* Adding a level is Eli's and Operations'. NOT an EMD's — an EMD could otherwise invent a level
   they have just cleared and hand themselves a diamond. */
async function ownsLevels(code: string, ops: boolean): Promise<boolean> {
  if (ops) return true;
  const c = norm(code);
  if (!c) return false;
  if (c === "GFI20" || /^(000[0-5]|9999)$/.test(c)) return true;
  return (await rpc("is_platform_admin", { p_code: c })) === true;
}

/* Which agents — and which baseshops — may this viewer see? agent_scope() is the one answer. */
async function scopeOf(code: string, ops: boolean): Promise<{ all: boolean; codes: Set<string>; shops: Set<string> }> {
  const rows = await dbGet(`tracker_agents?select=code,baseshop&limit=5000`);
  if (ops) {
    return { all: true, codes: new Set(rows.map((r: any) => norm(r.code))), shops: new Set(rows.map((r: any) => low(r.baseshop))) };
  }
  const sc = await rpc("agent_scope", { p_code: code });
  if (sc && sc.ok && sc.all) {
    return { all: true, codes: new Set(rows.map((r: any) => norm(r.code))), shops: new Set(rows.map((r: any) => low(r.baseshop))) };
  }
  const bases = new Set<string>(((sc && Array.isArray(sc.bases)) ? sc.bases : []).map((b: string) => low(b)));
  const codes = new Set<string>();
  for (const r of rows) if (bases.has(low(r.baseshop))) codes.add(norm(r.code));
  codes.add(norm(code));
  return { all: false, codes, shops: bases };
}

/* v8: who may APPROVE a tick. Operations; the platform admin; or an EMD (by the server-set
   contract level / title, never anything typed) for someone in their own downline. Never
   yourself — an EMD's own ladder goes to the EMD above them, so nobody promotes themselves. */
async function mayApprove(viewer: string, target: string, ops: boolean, me: any): Promise<boolean> {
  if (ops) return true;
  if (!viewer || norm(viewer) === norm(target)) return false;
  if (me && me.platform_admin === true) return true;
  if (!isEMD(me)) return false;
  return (await rpc("is_in_downline", { p_leader: norm(viewer), p_target: norm(target) })) === true;
}
/* The set of agents this viewer can approve for, used for the board and the review queue. */
async function approvableCodes(viewer: string, ops: boolean, me: any): Promise<{ all: boolean; codes: Set<string> }> {
  if (ops || (me && me.platform_admin === true)) return { all: true, codes: new Set() };
  if (!viewer || !isEMD(me)) return { all: false, codes: new Set() };
  const rows = await rpc("nb_scope_codes", { p_leader: norm(viewer) });
  const codes = new Set<string>((Array.isArray(rows) ? rows : []).map((r: any) => norm(r.code)));
  codes.delete(norm(viewer));
  return { all: false, codes };
}
async function logCheck(agent: string, key: string, event: string, actor: string) {
  await db(`summit_check_events`, { method: "POST", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ agent_code: agent, req_key: key, event, actor: actor || "ops" }) });
}

/* Who may REQUEST a tick: yourself, or an upline for someone below them (the old edit rule). */
async function mayEditLadder(viewer: string, target: string, ops: boolean): Promise<boolean> {
  if (ops) return true;
  if (!viewer) return false;
  if (norm(viewer) === norm(target)) return true;
  const a = await agentRow(viewer);
  if (a && a.platform_admin === true) return true;
  const inDown = await rpc("is_in_downline", { p_leader: norm(viewer), p_target: norm(target) });
  return inDown === true;
}


/* ===== summit-api v: WHO IS CALLING (2026-09-30) =====
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
    const body: Record<string, unknown> = req.method === "POST" ? (await req.json().catch(() => ({}))) : {};
    const action = clean(body.action, 24) || "board";
    /* Resolve the caller once, then overwrite body.code with the verified answer. */
    {
      const _ops = await _isOps((body as Record<string, unknown>).token);
      if (!_ops) {
        const _me = await _sessionCode((body as Record<string, unknown>).session);
        if (!_me) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401);
        (body as Record<string, unknown>).code = _me;
      }
    }
    const code = norm(body.code);
    const ops = await opsAuthorized(body.token);
    if (!code && !ops) return json({ ok: false, error: "sign in required" }, 401);

    const scope = await scopeOf(code, ops);
    /* v9 (2026-10-26): `self:true` narrows any read to the caller's own record. The Profile page's
       read-only Road summary needs one person, not the whole team the caller may see. Only ever
       narrows scope; it can never widen it. */
    const selfOnly = body.self === true && !!code;
    const inScope = (c: unknown) => selfOnly ? norm(c) === norm(code) : (scope.all || scope.codes.has(norm(c)));
    const me = code ? await agentRow(code) : null;

    if (action === "board") {
      const tags = await dbGet(`summit_tags?select=id,label,color&order=label.asc`);
      const links = await dbGet(`summit_agent_tags?select=agent_code,tag_id&limit=20000`);
      const prog = await dbGet(`summit_progress?select=agent_code,stage_index,checks&limit=20000`);
      const checkRows = await dbGet(`summit_checks?select=agent_code,req_key,done,status&done=is.true&limit=50000`);
      const reqs = await dbGet(`summit_requirements?select=baseshop,stage_index,labels&limit=5000`);
      const lay = (await dbGet(`summit_layout?viewer_code=eq.${enc(code)}&select=positions,zoom`))[0] || null;

      const agentTags: Record<string, string[]> = {};
      for (const l of links) { const c = norm(l.agent_code); if (!inScope(c)) continue; (agentTags[c] = agentTags[c] || []).push(l.tag_id); }

      const progress: Record<string, Record<string, boolean[]>> = {};
      for (const p of prog) {
        const c = norm(p.agent_code); if (!inScope(c)) continue;
        (progress[c] = progress[c] || {})[String(p.stage_index)] = Array.isArray(p.checks) ? p.checks : [];
      }

      /* Completion against stable requirement ids. Only APPROVED ticks count; a pending one is
         returned separately so the page can show it as awaiting the EMD without counting it. */
      const checks: Record<string, Record<string, boolean>> = {};
      const pending: Record<string, Record<string, boolean>> = {};
      for (const r of checkRows) {
        const c = norm(r.agent_code); if (!inScope(c)) continue;
        const bucket = r.status === "pending" ? pending : checks;
        (bucket[c] = bucket[c] || {})[String(r.req_key)] = true;
      }
      const appr = await approvableCodes(code, ops, me);
      const approvable = appr.all ? "all" : Array.from(appr.codes).filter((c) => inScope(c));

      /* What the platform can already prove, per agent: the stage their awarded rank reaches,
         and the requirements the licensing board evidences. A rank clears up to its OWN
         promotion stage and no further — it must not certify Senior Partner. */
      const derivedRows = await rpc("summit_derived_all", {}) || [];
      const derived: Record<string, unknown> = {};
      for (const r of derivedRows) { const c = norm(r.agent_code); if (!inScope(c)) continue; derived[c] = r.derived || {}; }

      /* A shop's standards are its own business — only the viewer's own shops come back. */
      const requirements: Record<string, Record<string, string[]>> = {};
      for (const r of reqs) {
        const b = low(r.baseshop);
        if (!scope.all && !scope.shops.has(b)) continue;
        (requirements[b] = requirements[b] || {})[String(r.stage_index)] = Array.isArray(r.labels) ? r.labels : [];
      }

      const since = clean(body.since, 12) || null;
      const prodRows = await rpc("summit_production", { p_from: since, p_to: null }) || [];
      const production: Record<string, { points: number; deals: number }> = {};
      for (const r of prodRows) { const c = norm(r.agent_code); if (!inScope(c)) continue; production[c] = { points: Number(r.points) || 0, deals: Number(r.deals) || 0 }; }

      /* Which stages the platform can already prove, per agent: rank, the licensing board, the
         old tracker's checklist and logged field trainings. Per stage, not a single floor. */
      const ladderRows = await rpc("summit_ladder", {}) || [];
      const stages: Record<string, number[]> = {};
      const cash: Record<string, { amount: number; prestige: number }> = {};
      for (const r of ladderRows) {
        const c = norm(r.agent_code); if (!inScope(c)) continue;
        stages[c] = Array.isArray(r.stages) ? r.stages.map((x: unknown) => Number(x)) : [];
        cash[c] = { amount: Number(r.cashflow) || 0, prestige: Number(r.prestige) || 0 };
      }

      const signals = code ? await rpc("summit_signals", { p_code: code }) : null;

      return json({
        ok: true, scope: scope.all ? "all" : "baseshop",
        can_manage: ops || isLeader(me),
        can_set_standards: ops || isEMD(me),
        can_set_levels: await ownsLevels(code, ops),
        tiers: await tiersOf(),
        my_baseshop: me ? (me.baseshop || "") : "",
        approvable,
        tags, agent_tags: agentTags, progress, checks, pending, derived, production, stages, cash, requirements,
        signals: signals || {},
        layout: lay ? (lay.positions || {}) : {}, zoom: lay ? lay.zoom : null,
      });
    }

    /* ---------------- the cashflow levels past EMD ---------------- */
    if (action === "tiers_set") {
      if (!(await ownsLevels(code, ops))) {
        return json({ ok: false, error: "Only Elijah Cox and Operations can change the cashflow levels." }, 403);
      }
      const raw = Array.isArray(body.tiers) ? body.tiers : null;
      if (!raw) return json({ ok: false, error: "tiers required" }, 400);
      const seen = new Set<number>();
      const tiers = raw
        .map((t: any) => ({ at: Math.round(Number(t && t.at) || 0), name: clean(t && t.name, 40) }))
        .filter((t: any) => t.at > 0 && !seen.has(t.at) && seen.add(t.at) !== undefined)
        .sort((a: any, b: any) => a.at - b.at)
        .slice(0, 12);
      if (!tiers.length) return json({ ok: false, error: "Add at least one level." }, 400);
      const up = await db(`app_settings?on_conflict=key`, {
        method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ key: "summit_cash_tiers", value: { tiers }, updated_at: new Date().toISOString() }),
      });
      return json({ ok: up.ok, tiers });
    }

    /* ---------------- one requirement, ticked or un-ticked ---------------- */
    if (action === "check_set") {
      const target = norm(body.agent_code);
      const key = clean(body.req_key, 80);
      /* The id shape is stage.req or stage.path.req. Anything else is refused rather than
         stored, so a typo cannot create an orphan row nobody can ever clear. */
      if (!target || !/^[a-z0-9_]+\.[a-z0-9_]+(\.[a-z0-9_]+)?$/.test(key)) {
        return json({ ok: false, error: "agent and requirement required" }, 400);
      }
      /* v8: an EMD in scope (or Operations) writes an approved tick; anyone else who may edit
         this ladder — the agent, or an upline — files a REQUEST that does not count yet. */
      const approver = await mayApprove(code, target, ops, me);
      if (!approver && !(await mayEditLadder(code, target, ops))) {
        return json({ ok: false, error: "You can only update your own ladder, or someone on your team." }, 403);
      }
      const actor = code || "ops";
      const now = new Date().toISOString();
      const row = (await dbGet(`summit_checks?agent_code=eq.${enc(target)}&req_key=eq.${enc(key)}&select=status`))[0] || null;
      if (body.done === false) {
        if (!row) return json({ ok: true, agent_code: target, req_key: key, done: false, status: null });
        /* A requester can withdraw their own pending request, never an approved requirement. */
        if (row.status === "approved" && !approver) {
          return json({ ok: false, error: "This requirement was approved by your EMD. Ask them to clear it." }, 403);
        }
        const d = await db(`summit_checks?agent_code=eq.${enc(target)}&req_key=eq.${enc(key)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
        if (d.ok) await logCheck(target, key, row.status === "approved" ? "cleared" : (approver && norm(code) !== target ? "rejected" : "withdrawn"), actor);
        return json({ ok: d.ok, agent_code: target, req_key: key, done: false, status: null });
      }
      if (row && row.status === "approved") return json({ ok: true, agent_code: target, req_key: key, done: true, status: "approved" });
      const status = approver ? "approved" : "pending";
      const up = await db(`summit_checks?on_conflict=agent_code,req_key`, {
        method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ agent_code: target, req_key: key, done: true, status, updated_at: now, updated_by: actor,
          approved_by: approver ? actor : null, approved_at: approver ? now : null }),
      });
      if (up.ok) await logCheck(target, key, approver ? "approved" : "requested", actor);
      return json({ ok: up.ok, agent_code: target, req_key: key, done: true, status });
    }

    /* ---------------- the EMD's review queue ---------------- */
    if (action === "approvals") {
      const appr = await approvableCodes(code, ops, me);
      if (!appr.all && !appr.codes.size) return json({ ok: true, items: [] });
      const rows = await dbGet(`summit_checks?status=eq.pending&select=agent_code,req_key,updated_at,updated_by&order=updated_at.asc&limit=2000`);
      const items = rows.filter((r: any) => appr.all ? norm(r.agent_code) !== norm(code) : appr.codes.has(norm(r.agent_code)));
      const who = Array.from(new Set(items.flatMap((r: any) => [norm(r.agent_code), norm(r.updated_by)])));
      const names: Record<string, string> = {};
      if (who.length) {
        for (const a of await dbGet(`tracker_agents?code=in.(${who.map(enc).join(",")})&select=code,first_name,last_name`)) {
          names[norm(a.code)] = `${a.first_name || ""} ${a.last_name || ""}`.trim();
        }
      }
      return json({ ok: true, items: items.map((r: any) => ({ agent_code: norm(r.agent_code), agent_name: names[norm(r.agent_code)] || norm(r.agent_code),
        req_key: r.req_key, requested_at: r.updated_at, requested_by: norm(r.updated_by), requested_by_name: names[norm(r.updated_by)] || "" })) });
    }

    /* Approve or reject one or many pending requests. Each item is re-checked on its own. */
    if (action === "check_review") {
      const decision = body.decision === "approve" ? "approve" : (body.decision === "reject" ? "reject" : "");
      const list = (Array.isArray(body.items) ? body.items : [{ agent_code: body.agent_code, req_key: body.req_key }]).slice(0, 200);
      if (!decision || !list.length) return json({ ok: false, error: "decision and items required" }, 400);
      const actor = code || "ops";
      let done = 0, refused = 0;
      for (const it of list as any[]) {
        const target = norm(it && it.agent_code); const key = clean(it && it.req_key, 80);
        if (!target || !key || !(await mayApprove(code, target, ops, me))) { refused++; continue; }
        const q = `summit_checks?agent_code=eq.${enc(target)}&req_key=eq.${enc(key)}&status=eq.pending`;
        const r = decision === "approve"
          ? await db(q, { method: "PATCH", headers: { Prefer: "return=representation" },
              body: JSON.stringify({ status: "approved", approved_by: actor, approved_at: new Date().toISOString() }) })
          : await db(q, { method: "DELETE", headers: { Prefer: "return=representation" } });
        const changed = r.ok ? ((await r.json()) || []).length : 0;
        if (changed) { done++; await logCheck(target, key, decision === "approve" ? "approved" : "rejected", actor); }
      }
      return json({ ok: true, decision, done, refused });
    }

    /* Legacy array-position progress. The page no longer calls it; v8 keeps it only for approvers
       so it cannot be used as a side door around the approval rule. */
    if (action === "progress_set") {
      const target = norm(body.agent_code);
      const idx = Number(body.stage_index);
      if (!target || !(idx >= 0 && idx <= 18)) return json({ ok: false, error: "agent and stage required" }, 400);
      if (!(await mayApprove(code, target, ops, me))) return json({ ok: false, error: "Only an EMD or Operations can change progression." }, 403);
      const raw = Array.isArray(body.checks) ? body.checks : [];
      const checks = raw.slice(0, 8).map((x: unknown) => x === true);
      const up = await db(`summit_progress?on_conflict=agent_code,stage_index`, {
        method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ agent_code: target, stage_index: idx, checks, updated_at: new Date().toISOString(), updated_by: code || "ops" }),
      });
      return json({ ok: up.ok, agent_code: target, stage_index: idx, checks });
    }

    /* ---------------- a shop's promotion standards ---------------- */
    if (action === "req_set") {
      const shop = clean(body.baseshop, 40) || (me ? me.baseshop : "");
      const idx = Number(body.stage_index);
      if (!shop || !(idx >= 0 && idx <= 19)) return json({ ok: false, error: "baseshop and stage required" }, 400);
      const ownShop = me && low(me.baseshop) === low(shop);
      if (!(ops || (isEMD(me) && (ownShop || (me && me.platform_admin === true))))) {
        return json({ ok: false, error: "Only this baseshop's EMD or Operations can set its promotion standards." }, 403);
      }
      const labels = (Array.isArray(body.labels) ? body.labels : [])
        .map((x: unknown) => clean(x, 120)).filter((x: string) => !!x).slice(0, 10);
      const up = await db(`summit_requirements?on_conflict=baseshop,stage_index`, {
        method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ baseshop: shop, stage_index: idx, labels, updated_at: new Date().toISOString(), updated_by: code || "ops" }),
      });
      return json({ ok: up.ok, baseshop: shop, stage_index: idx, labels });
    }

    /* ---------------- tags ---------------- */
    const canManage = ops || isLeader(me);

    if (action === "tag_create") {
      if (!canManage) return json({ ok: false, error: "Only a leader or Operations can manage tags." }, 403);
      const label = clean(body.label, 40); if (!label) return json({ ok: false, error: "name required" }, 400);
      const id = slug(label); if (!id) return json({ ok: false, error: "name required" }, 400);
      const up = await db(`summit_tags?on_conflict=id`, { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ id, label, color: clean(body.color, 12) || "#d7ae54", created_by: code || "ops" }) });
      return json({ ok: up.ok, id, label });
    }

    if (action === "tag_delete") {
      if (!canManage) return json({ ok: false, error: "Only a leader or Operations can manage tags." }, 403);
      const id = slug(body.id); if (!id) return json({ ok: false, error: "id required" }, 400);
      const d = await db(`summit_tags?id=eq.${enc(id)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
      return json({ ok: d.ok, id });
    }

    if (action === "tag_assign") {
      if (!canManage) return json({ ok: false, error: "Only a leader or Operations can manage tags." }, 403);
      const target = norm(body.agent_code); const id = slug(body.tag_id);
      if (!target || !id) return json({ ok: false, error: "agent and tag required" }, 400);
      if (!inScope(target)) return json({ ok: false, error: "That agent is not in your baseshop." }, 403);
      if (body.on === false) {
        const d = await db(`summit_agent_tags?agent_code=eq.${enc(target)}&tag_id=eq.${enc(id)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
        return json({ ok: d.ok, agent_code: target, tag_id: id, on: false });
      }
      const up = await db(`summit_agent_tags?on_conflict=agent_code,tag_id`, { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ agent_code: target, tag_id: id, added_by: code || "ops" }) });
      return json({ ok: up.ok, agent_code: target, tag_id: id, on: true });
    }

    if (action === "layout_save") {
      if (!code) return json({ ok: false, error: "sign in required" }, 401);
      const positions = (body.positions && typeof body.positions === "object") ? body.positions : {};
      const up = await db(`summit_layout?on_conflict=viewer_code`, { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ viewer_code: code, positions, zoom: (body.zoom === null || body.zoom === undefined) ? null : Number(body.zoom), updated_at: new Date().toISOString() }) });
      return json({ ok: up.ok });
    }

    if (action === "layout_reset") {
      if (!code) return json({ ok: false, error: "sign in required" }, 401);
      const d = await db(`summit_layout?viewer_code=eq.${enc(code)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
      return json({ ok: d.ok });
    }

    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
