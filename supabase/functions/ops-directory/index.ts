// ops-directory v30 — Operations Tracker API.
//
// v30 (2026-10-26): A LEADER SEES THEIR OWN TREE, NOT THE COMPANY. An MD/EMD who opens the
//   Tracker with their AGENT session is not an Operations seat, so ops_scope('', code) answered
//   scoped:false and inScope() let every agent through: any MD could read every person's phone,
//   email, licence number and notes, and write notes on anyone. Leaders on an agent session are
//   now limited to themselves and their recursive downline (nb_scope_codes, the same tree New
//   Business uses; the hierarchy root still gets everyone). Ops seats keep their bases-based
//   scope and master seats (0000, C1991) and the platform builder are unchanged. edit_request,
//   which never checked scope at all, now does too.
//
// v29 (2026-10-21): THE TRACKER SPLITS A SPLIT POLICY. Christopher: "operations tracker,
//   split as normal." polByAgent() credited the writing agent 100% of a split and the
//   partner nothing, making this the only per-agent premium figure in the platform that did
//   not divide — leaderboard-api, newbiz-api, ops-metrics and ops-nbfeed all do. Across 113
//   splits and $638,611 of premium, $286,247 sat on the wrong name and 39 partners were
//   credited nothing at all. Todd Doyle read $0 against $25,617 of real split business.
//
// v28 (2026-10-15): A TYPED CODE IS NOT A CREDENTIAL. auth() accepted three strings as
//   proof of identity, none of them secret:
//     · a seat code listed in operations_users — full Operations read AND write over all
//       138 people: names, phones, emails, licence numbers, notes;
//     · any agent code whose row carries platform_admin — the same, in full;
//     · any MD/EMD agent code — read. Agent codes are printed on the org chart.
//   Emptying operations_users on 14 Oct shut the first door and took Operations down with
//   it — four functions read that one list to recognise people, so tickets vanished and
//   the master seat could not sign in. The check belongs here instead:
//     · Operations — the session token minted at PIN entry, which also names the seat;
//     · everyone else — their own signed-in agent session.
//   `ops_login` above is deliberately untouched: it runs BEFORE any of this, because it is
//   the step that establishes who someone is. It still hands back no more than a role and
//   the seat's own details, and the PIN remains the thing that actually grants access.
//   Baseshop scoping and note authorship now read the verified identity rather than a
//   `by_code` supplied by the caller.
// v27 (2026-09-14): THE "LICENSED" COUNT READ ZERO WHILE 51 AGENTS WERE LICENSED.
//   Christopher: "the numbers are not accurate at all." Only one of the five dashboard
//   metrics actually was — agents, profiles complete, AP submitted MTD and the baseshop
//   split all matched the database exactly. Licensed did not, and it read 0.
//   licStatus() returns the agent's REAL status text ("Fully Licensed & Appointed"), but
//   two places compared it to the literal string "Licensed", which no agent has ever had.
//   "Licensed" only exists in DEFAULT_LIC, the generic fallback used when an agency has
//   not defined its own pipeline. This one has: app_settings.ops_license_statuses is an
//   ORDERED 15-step list ending at "Fully Licensed & Appointed".
//   Both places now resolve the milestone from the LAST entry of that configured list, so
//   renaming or reordering the pipeline moves the metric with it and never needs a deploy.
//   The same bug silently made trackerRow's per-agent `ms.licensed` flag always false.
// v24 (2026-09-05): BASESHOP SCOPING IS ENFORCED HERE, not in the browser.
//   Each per-baseshop Operations seat (0001-0005) is tied to its own team: the page
//   was filtering rows client-side, which means the server was still sending every
//   baseshop's people and anyone could read the rest straight out of the response.
//   ops_scope() resolves the caller's allowed bases from their SESSION and rows are
//   filtered before they leave. A master seat (0000, and the platform builder) still sees
//   everything, and an MD or EMD signing in with their broker code is untouched — they are
//   not an Operations seat, so their own role rules still decide what they get.
// v23: platform_admin counts as Operations without a promotion.
// v22: authorisation is a real Operations session, not the literal "2026".
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DEFAULT_LIC = ["Not Started", "Pre-Licensing", "Exam Passed", "Licensed"];
const ALL_BASES = ["STANDARD", "SMMT", "TITANS", "SCAPED", "ELEVATE", "GRIND"];
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
function json(o: unknown, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const clean = (s: unknown) => (s ?? "").toString().trim().slice(0, 2000);
const low = (s: unknown) => (s ?? "").toString().trim().toLowerCase();
const firstTok = (s: unknown) => low(s).split(/\s+/)[0] || "";
const full = (a: any) => `${a.first_name || ""} ${a.last_name || ""}`.trim();
const has = (v: unknown) => !!(v && String(v).trim());
const numOr = (v: unknown) => { const n = Number(v); return isNaN(n) ? 0 : n; };
const COLTYPES = ["text", "select", "date", "check"];
const normColType = (t: unknown) => COLTYPES.indexOf(String(t)) >= 0 ? String(t) : "text";
const cleanColor = (c: unknown) => /^#[0-9a-fA-F]{3,8}$/.test(String(c || "")) ? String(c) : "#c99a2e";
const colorOrEmpty = (c: unknown) => /^#[0-9a-fA-F]{3,8}$/.test(String(c || "")) ? String(c) : "";
const cleanOptObjs = (o: unknown) => Array.isArray(o) ? o.map((x: any) => (x && typeof x === "object") ? { value: clean(x.value).slice(0, 60), color: cleanColor(x.color) } : { value: clean(x).slice(0, 60), color: "#c99a2e" }).filter((x: any) => has(x.value)).slice(0, 60) : [];
const cleanColorMap = (m: unknown) => { const out: Record<string, string> = {}; if (m && typeof m === "object") { let n = 0; for (const k in (m as any)) { if (n++ > 120) break; const c = colorOrEmpty((m as any)[k]); if (has(k) && c) out[String(k).slice(0, 80)] = c; } } return out; };
const OPS_CODE = /^000[0-5]$/;
const LEADER = /^(md|emd|nvp|sevp|marketing director|executive marketing director|national vice president|senior executive vice president)$/i;
function isLeader(v: unknown) { return LEADER.test(String(v || "").trim()); }
function leaderRole(v: unknown) { const s = String(v || "").trim().toLowerCase(); return (s === "emd" || s === "nvp" || s === "sevp" || s.indexOf("executive") >= 0 || s.indexOf("national") >= 0) ? "emd" : "md"; }
function leaderTitle(v: unknown) { const s = String(v || "").trim(); if (/^md$/i.test(s)) return "Marketing Director"; if (/^emd$/i.test(s)) return "Executive Marketing Director"; if (/^nvp$/i.test(s)) return "National Vice President"; if (/^sevp$/i.test(s)) return "Senior Executive Vice President"; return s || "Leader"; }
function isPlatformAdmin(a: any) { return !!(a && a.platform_admin === true); }
function adminTitle(a: any) { const lvl = clean(a && a.contract_level); return lvl ? `${lvl} · Platform Builder` : "Platform Builder"; }
function opsList(u: any) { return (u && Array.isArray(u.operators) && u.operators.length) ? u.operators : (u ? [u] : []); }
function ptToday() { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date()); }
function daysSince(iso: unknown) { if (!iso) return null; const d = new Date(String(iso)).getTime(); if (isNaN(d)) return null; return Math.floor((Date.now() - d) / 86400000); }
async function loadKey(k: string) { const r = await fetch(`${SUPA}/rest/v1/app_settings?key=eq.${k}&select=value`, { headers: DBH }); const rows = await r.json(); return (rows && rows[0]) ? rows[0].value : null; }
async function saveKey(k: string, v: unknown) { await fetch(`${SUPA}/rest/v1/app_settings?on_conflict=key`, { method: "POST", headers: { ...DBH, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key: k, value: v, updated_at: new Date().toISOString() }) }); }
async function getJSON(path: string) { const r = await fetch(`${SUPA}/rest/v1/${path}`, { headers: DBH }); return (await r.json()) || []; }
async function rpc(fn: string, args: Record<string, unknown>) { try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); return await r.json(); } catch (_) { return null; } }
async function getAgent(code: string) { const rows = await getJSON(`tracker_agents?code=eq.${encodeURIComponent(code)}&select=code,first_name,last_name,contract_level,baseshop,platform_admin`); return rows[0] || null; }
async function patchAgent(code: string, patch: Record<string, unknown>) { return fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${encodeURIComponent(norm(code))}`, { method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify(patch) }); }
async function patchWhere(table: string, filter: string, patch: Record<string, unknown>) { return fetch(`${SUPA}/rest/v1/${table}?${filter}`, { method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify(patch) }); }
const ISSUED = ["policy_issued", "premium_drafted", "paid", "funds_received"];
function bucket(s: string) { s = low(s); if (s === "closed" || s === "declined" || s === "cancelled") return "closed"; if (s === "approved") return "approved"; if (ISSUED.indexOf(s) >= 0) return "paid"; return "pending"; }
function licStatus(a: any) { if (has(a.license_status)) return a.license_status; const p = (a.progress && typeof a.progress === "object") ? a.progress : {}; if (p.w3_reslic || p.w3_apply) return "Licensed"; if (p.w1_exam) return "Exam Passed"; if (p.w1_prelic) return "Pre-Licensing"; return "Not Started"; }

// WHICH STATUS MEANS "LICENSED". The agency defines its own ordered pipeline in
// app_settings.ops_license_statuses; the final entry is the finished state — today
// "Fully Licensed & Appointed". Reading it from the list rather than hardcoding a word
// is what stops this counter silently returning zero again after a rename.
function licensedLabel(licStatuses: string[]): string {
  const arr = Array.isArray(licStatuses) ? licStatuses.filter((x) => has(x)) : [];
  return arr.length ? String(arr[arr.length - 1]) : "Licensed";
}
function isLicensed(status: unknown, licStatuses: string[]): boolean {
  return low(status) === low(licensedLabel(licStatuses));
}

function stepsDone(p: any) { if (!p || typeof p !== "object") return 0; let n = 0; for (const k in p) if (p[k]) n++; return n; }
function notesSorted(arr: any[]) { return arr.slice().sort((x: any, y: any) => String(y.ts || "").localeCompare(String(x.ts || ""))); }
function normColRec(c: any) { const type = normColType(c.type); return { key: String(c.key || ""), label: String(c.label || ""), tab: String(c.tab || "licensing"), type, options: cleanOptObjs(c.options), color: cleanColor(c.color) }; }

async function loadCore() {
  const opsUsers = (await loadKey("operations_users")) || {};
  const rawCols = (await loadKey("ops_custom_columns")) || [];
  const customCols = (Array.isArray(rawCols) ? rawCols : []).map(normColRec);
  const colColors = (await loadKey("ops_col_colors")) || {};
  const statusColors = (await loadKey("ops_license_status_colors")) || {};
  const licSaved = await loadKey("ops_license_statuses");
  const licStatuses = (Array.isArray(licSaved) && licSaved.length) ? licSaved : DEFAULT_LIC;
  const agents = await getJSON(`tracker_agents?select=code,first_name,last_name,contract_level,baseshop,state,ica,ica_date,license_number,license_type,license_status,notes_log,custom,pathway,pct,progress,status,updated_at,direct_to,direct_to_name,phone,email,platform_admin&limit=5000`);
  const byCode: Record<string, any> = {}; const downline = new Set<string>();
  agents.forEach((a: any) => { byCode[norm(a.code)] = a; if (has(a.direct_to)) downline.add(norm(a.direct_to)); });
  const org = (await loadKey("org_structure")) || { nodes: [] };
  const nodes = Array.isArray(org.nodes) ? org.nodes : [];
  const nodeById: Record<string, any> = {}; nodes.forEach((n: any) => nodeById[norm(n.id)] = n);
  const orgUp: Record<string, { code: string; name: string }> = {};
  nodes.forEach((n: any) => { const p = nodeById[norm(n.parent || "")]; if (p) orgUp[norm(n.id)] = { code: String(p.id || ""), name: String(p.name || "") }; });
  return { opsUsers, customCols, colColors: (colColors && typeof colColors === "object") ? colColors : {}, statusColors: (statusColors && typeof statusColors === "object") ? statusColors : {}, licStatuses, agents, byCode, downline, orgUp };
}

/* WHO IS ASKING. An Operations session, or a person signed in as themselves. There is no
   longer a route that trusts a code typed into the request body. */
function authOf(core: any, sessionOk: boolean, meCode: string) {
  if (sessionOk) return { ok: true, role: "ops", canEdit: true };
  if (!meCode) return { ok: false, error: "Sign in to open the Operations Tracker." };
  const a = core.byCode[meCode];
  if (isPlatformAdmin(a)) return { ok: true, role: "ops", canEdit: true };
  if (a && isLeader(a.contract_level)) return { ok: true, role: leaderRole(a.contract_level), canEdit: false };
  return { ok: false, error: "The Operations Tracker is for Operations staff and leaders (Marketing Director and above)." };
}

/* EVERY SIDE OF A SPLIT IS CREDITED TO ITS OWN AGENT (v29, Christopher: "operations
   tracker, split as normal").

   Until v29 this credited the WRITER the whole premium and the partner nothing, which made
   the Tracker the one per-agent figure in the platform that did not split — leaderboard-api,
   newbiz-api, ops-metrics and ops-nbfeed all do. Across 113 splits and $638,611 of premium
   that silently moved $286,247 onto the wrong name: Christopher read $145,501 against a true
   $116,365, Gage Griffin $85,980 against $58,503, and Todd Doyle read $0 against $25,617 of
   real business, so a producing agent looked idle.

   The share is the same one every other function uses: split_pct is the WRITER's percentage,
   defaulting to 50 when a split carries no figure. A policy with no split, or a split with no
   partner recorded, is unchanged and credits the writer in full. Counts and status buckets
   follow the premium — a split policy is one piece of work for each of the two people on it,
   which is what the Tracker's `count` has always meant for the writer. */
async function polByAgent() {
  const pols = await getJSON(`policies?select=agent_code,annual_premium,status,chargeback_amount,split_flag,split_pct,split_agent_code&limit=20000`);
  const m: Record<string, any> = {};
  const credit = (code: unknown, p: any, share: number) => {
    const c = norm(code); if (!c) return;
    const b = bucket(p.status);
    const o = m[c] || (m[c] = { count: 0, ap: 0, pending: 0, approved: 0, paid: 0, closed: 0, cb: 0 });
    o.count++;
    if (b !== "closed") o.ap += numOr(p.annual_premium) * share;
    o[b] = (o[b] || 0) + 1;
    o.cb += numOr(p.chargeback_amount) * share;
  };
  pols.forEach((p: any) => {
    const partner = norm(p.split_agent_code);
    if (p.split_flag && partner) {
      const sp = (p.split_pct != null && p.split_pct !== "") ? numOr(p.split_pct) : 50;
      const wShare = Math.max(0, Math.min(100, sp)) / 100;
      credit(p.agent_code, p, wShare);
      credit(partner,      p, 1 - wShare);
    } else {
      credit(p.agent_code, p, 1);
    }
  });
  return m;
}
function trackerRow(a: any, nb: any, core: any) {
  const code = norm(a.code); const ls = licStatus(a);
  const up = core.orgUp[code] || { code: "", name: "" };
  const recruiterCode = has(a.direct_to) ? a.direct_to : up.code;
  const recruiterName = has(a.direct_to_name) ? a.direct_to_name : up.name;
  const n = nb[code] || { count: 0, ap: 0, pending: 0, approved: 0, paid: 0, closed: 0, cb: 0 };
  const notes = Array.isArray(a.notes_log) ? a.notes_log : [];
  return {
    code: a.code, name: full(a), first_name: a.first_name || "", last_name: a.last_name || "", contract_level: a.contract_level || "Associate", baseshop: a.baseshop || "", status: a.status || "active",
    direct_to: recruiterCode || "", direct_to_name: recruiterName || "",
    state: a.state || "", ica: a.ica || "", ica_date: a.ica_date || "", license_number: a.license_number || "", license_type: a.license_type || "", license_status: ls,
    pathway: a.pathway || "", pct: numOr(a.pct), steps_done: stepsDone(a.progress), days_inactive: daysSince(a.updated_at),
    custom: (a.custom && typeof a.custom === "object") ? a.custom : {}, notes_count: notes.length,
    nb: { count: n.count, ap: Math.round(n.ap), pending: n.pending, approved: n.approved, paid: n.paid, cb: Math.round(n.cb) },
    ms: { licensed: isLicensed(ls, core.licStatuses), first_sale: n.count > 0, first_recruit: core.downline.has(code) }
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: any = {}; try { body = req.method === "POST" ? await req.json() : {}; } catch (_) { body = {}; }
  const url = new URL(req.url);
  const action = String(body.action || url.searchParams.get("action") || "directory");
  const code = String(body.code || url.searchParams.get("code") || "").trim();

  /* Sign-in runs BEFORE any authorisation: it is the step that establishes who someone is.
     It still only resolves a code to a role, and the PIN that follows is the real gate. */
  if (action === "ops_login") {
    const nm = String(body.name || "").trim();
    if (!nm) return json({ ok: false, error: "Enter your name." });
    if (/^000[0-4]$/.test(code)) {
      const users = (await loadKey("operations_users")) || {}; const u = users[code];
      if (!u) return json({ ok: false, error: "That Operations code isn’t assigned to anyone yet." });
      const ops = opsList(u);
      const m = ops.find((o: any) => firstTok(nm) === firstTok(o.name));
      if (!m) return json({ ok: false, error: "That name doesn’t match this Operations code." });
      return json({ ok: true, role: "ops", can_edit: true, ops: { code, name: m.name, title: m.title || "Operations", baseshops: m.baseshops || [] } });
    }
    const a = await getAgent(norm(code));
    if (!a) return json({ ok: false, not_ops: true, error: "Code not found. Operations codes are 0000–4; MDs and above use their broker code." });
    const admin = isPlatformAdmin(a);
    if (!admin && !isLeader(a.contract_level)) return json({ ok: false, error: "The Operations Tracker is for Operations staff and leaders (Marketing Director and above) only." });
    if (firstTok(nm) !== firstTok(full(a))) return json({ ok: false, error: "That name doesn’t match this code." });
    if (admin) return json({ ok: true, role: "ops", can_edit: true, ops: { code: a.code, name: full(a), title: adminTitle(a), baseshops: ALL_BASES } });
    return json({ ok: true, role: leaderRole(a.contract_level), can_edit: false, ops: { code: a.code, name: full(a), title: leaderTitle(a.contract_level), baseshops: a.baseshop ? [a.baseshop] : [] } });
  }

  const core = await loadCore();

  /* Identity, resolved once. An Operations token names its own seat; otherwise the caller
     must carry the session minted when THEY entered their PIN. */
  const opsTok = String(body.token || "").trim();
  const opsAz = opsTok ? await rpc("ops_authorize", { p_token: opsTok }) : null;
  const sessionOk = !!(opsAz && opsAz.ok);
  let meCode = sessionOk ? norm(opsAz.code) : "";
  if (!sessionOk) {
    const s = String(body.session ?? "").trim().slice(0, 120);
    if (s) { const got = await rpc("agent_session_code", { p_token: s }); if (typeof got === "string") meCode = norm(got); }
  }
  const az = authOf(core, sessionOk, meCode);
  if (!az.ok) return json({ ok: false, error: (az as any).error || "unauthorized" }, 401);
  /* by_name stays a display hint; by_code is the verified identity, and it is the field
     the "you may only edit your own note" check actually reads. */
  const meName = clean(body.by_name) || (sessionOk ? String((opsAz as any).label || "Operations") : (core.byCode[meCode] ? full(core.byCode[meCode]) : ""));

  // ---- baseshop scoping, decided on the server ----
  const sc = await rpc("ops_scope", { p_token: opsTok, p_code: meCode });
  const scoped = !!(sc && sc.scoped);
  const allow = new Set<string>(((sc && Array.isArray(sc.bases)) ? sc.bases : []).map((b: string) => low(b)));
  /* v30: a leader on an agent session (not an Ops seat, not the platform builder) is held to
     their own recursive downline. nb_scope_codes includes the leader and returns everyone for
     the hierarchy root. A failed lookup yields an empty tree, so it fails closed. */
  let tree: Set<string> | null = null;
  if (!sessionOk && az.role !== "ops") {
    const rows = await rpc("nb_scope_codes", { p_leader: meCode });
    tree = new Set((Array.isArray(rows) ? rows : []).map((r: any) => norm(r && typeof r === "object" ? r.code : r)).filter(Boolean));
  }
  const limited = scoped || !!tree;
  const inScope = (a: any) => tree ? tree.has(norm(a && a.code)) : (!scoped || allow.has(low(a && a.baseshop)));
  const visibleAgents = core.agents.filter(inScope);

  if (action === "tracker") {
    const nb = await polByAgent();
    const rows = visibleAgents.filter((a: any) => low(a.status) !== "quit").map((a: any) => trackerRow(a, nb, core));
    rows.sort((x: any, y: any) => x.name.localeCompare(y.name));
    const reqs = (await loadKey("ops_edit_requests")) || [];
    const pending = Array.isArray(reqs) ? reqs.filter((r: any) => r.status === "pending").length : 0;
    const archived = visibleAgents.filter((a: any) => low(a.status) === "quit").length;
    return json({ ok: true, role: az.role, can_edit: az.canEdit, scoped, bases: Array.from(allow), count: rows.length, rows, custom_columns: core.customCols, col_colors: core.colColors, status_colors: core.statusColors, license_statuses: core.licStatuses, pending_requests: pending, archived_count: archived });
  }

  if (action === "set_col_colors") {
    if (!az.canEdit) return json({ ok: false, error: "Operations only." }, 403);
    const tab = clean(body.tab).slice(0, 24) || "licensing";
    const k = clean(body.key).slice(0, 60); if (!k) return json({ ok: false, error: "Missing column key." });
    const cur = (await loadKey("ops_col_colors")) || {}; const map = (cur && typeof cur === "object") ? cur : {};
    if (!map[tab] || typeof map[tab] !== "object") map[tab] = {};
    const col = colorOrEmpty(body.color);
    if (col) map[tab][k] = col; else delete map[tab][k];
    await saveKey("ops_col_colors", map);
    return json({ ok: true, col_colors: map });
  }

  if (action === "ops_bookings") {
    if (!az.canEdit) return json({ ok: false, error: "Operations only." }, 403);
    const meU = core.opsUsers[meCode]; const meN = meU ? (opsList(meU)[0] || {}).name : ""; if (!meN) return json({ ok: true, bookings: [] });
    const bks = await getJSON(`bookings?trainer_name=eq.${encodeURIComponent(meN)}&order=created_at.desc&limit=80`);
    const out = bks.filter((b: any) => ["canceled", "declined"].indexOf(low(b.status)) < 0).map((b: any) => ({ id: b.id, created_at: b.created_at, agent: b.agent_name || "Someone", category: b.category || "Operations", date: b.date, time: b.time || (b.starts_at ? String(b.starts_at).slice(11, 16) : ""), status: b.status || "booked", conf: b.conf || "", meeting_link: b.meeting_link || b.trainer_calendly || "", notes: b.notes || "" }));
    return json({ ok: true, name: meN, bookings: out });
  }

  if (action === "agent_get") {
    const a = core.byCode[norm(code)]; if (!a) return json({ ok: false, error: "Agent not found." }, 404);
    if (!inScope(a)) return json({ ok: false, error: "That agent is not in your baseshop." }, 403);
    const nb = await polByAgent();
    const pols = await getJSON(`policies?agent_code=eq.${encodeURIComponent(norm(code))}&select=client_name,carrier,product,annual_premium,monthly_contribution,lump_sum_contribution,status,submitted_date&order=submitted_date.desc&limit=500`);
    const reqs = (await loadKey("ops_edit_requests")) || [];
    const myReqs = Array.isArray(reqs) ? reqs.filter((r: any) => norm(r.agent_code) === norm(code)) : [];
    const row = trackerRow(a, nb, core);
    const notes = Array.isArray(a.notes_log) ? notesSorted(a.notes_log) : [];
    return json({ ok: true, role: az.role, can_edit: az.canEdit, agent: row, phone: a.phone || "", email: a.email || "", direct_to: row.direct_to, direct_to_name: row.direct_to_name, custom_columns: core.customCols, license_statuses: core.licStatuses, status_colors: core.statusColors, notes, policies: pols, requests: myReqs });
  }

  if (action === "add_note") {
    const a = core.byCode[norm(code)]; if (!a) return json({ ok: false, error: "Agent not found." }, 404);
    if (!inScope(a)) return json({ ok: false, error: "That agent is not in your baseshop." }, 403);
    const text = clean(body.text); if (!text) return json({ ok: false, error: "Note is empty." });
    const cur = Array.isArray(a.notes_log) ? a.notes_log.slice() : [];
    cur.push({ id: crypto.randomUUID(), ts: new Date().toISOString(), by_code: meCode, by_name: meName || (az.role === "ops" ? "Operations" : "Leader"), by_role: az.role, text });
    const up = await patchAgent(code, { notes_log: cur });
    return json({ ok: up.ok, notes: notesSorted(cur) });
  }
  if (action === "edit_note" || action === "delete_note") {
    const a = core.byCode[norm(code)]; if (!a) return json({ ok: false, error: "Agent not found." }, 404);
    if (!inScope(a)) return json({ ok: false, error: "That agent is not in your baseshop." }, 403);
    const id = String(body.note_id || ""); const cur = Array.isArray(a.notes_log) ? a.notes_log.slice() : [];
    const nt = cur.find((x: any) => x.id === id); if (!nt) return json({ ok: false, error: "Note not found." }, 404);
    const mine = has(meCode) && norm(nt.by_code) === meCode;
    if (!az.canEdit && !mine) return json({ ok: false, error: "You can only edit or delete your own notes." }, 403);
    let next = cur;
    if (action === "delete_note") { next = cur.filter((x: any) => x.id !== id); }
    else { const text = clean(body.text); if (!text) return json({ ok: false, error: "Note is empty." }); nt.text = text; nt.edited_at = new Date().toISOString(); }
    const up = await patchAgent(code, { notes_log: next });
    return json({ ok: up.ok, notes: notesSorted(next) });
  }

  if (action === "agent_update") {
    if (!az.canEdit) return json({ ok: false, error: "Only Operations staff can edit fields. You can still add notes and submit edit requests." }, 403);
    const a = core.byCode[norm(code)]; if (!a) return json({ ok: false, error: "Agent not found." }, 404);
    if (!inScope(a)) return json({ ok: false, error: "That agent is not in your baseshop." }, 403);
    const patch: Record<string, unknown> = {}; const allowF = ["first_name", "last_name", "phone", "email", "state", "ica", "ica_date", "license_number", "license_type", "license_status", "baseshop", "contract_level"];
    allowF.forEach((f) => { if (body[f] !== undefined) patch[f] = clean(body[f]); });
    // A scoped seat must not be able to move someone OUT of its own baseshop.
    if (scoped && patch.baseshop !== undefined && !allow.has(low(patch.baseshop))) {
      return json({ ok: false, error: "You can only move people within your own baseshop." }, 403);
    }
    if (body.direct_to !== undefined) { const dt = norm(body.direct_to); patch.direct_to = dt; const up2 = dt ? core.byCode[dt] : null; patch.direct_to_name = up2 ? full(up2) : (clean(body.direct_to_name) || ""); }
    if (body.custom_key !== undefined) { const ck = clean(body.custom_key); const cv = clean(body.custom_val); const curc: Record<string, unknown> = (a.custom && typeof a.custom === "object") ? { ...a.custom } : {}; if (ck) { if (cv === "") delete curc[ck]; else curc[ck] = cv; patch.custom = curc; } }
    if (!Object.keys(patch).length) return json({ ok: false, error: "Nothing to update." });
    const up = await patchAgent(code, patch);
    return json({ ok: up.ok });
  }

  // ---- change an agent's SIGN-IN code (full cascade) ----
  if (action === "change_code") {
    if (!az.canEdit) return json({ ok: false, error: "Operations only." }, 403);
    const oldC = norm(code); const newC = norm(body.new_code);
    if (!oldC || !newC) return json({ ok: false, error: "Enter the new code." });
    if (!/^[A-Z0-9]{2,12}$/.test(newC)) return json({ ok: false, error: "New code must be 2–12 letters/numbers." });
    if (OPS_CODE.test(oldC) || OPS_CODE.test(newC)) return json({ ok: false, error: "Operations codes (000x) can’t be reassigned here." });
    const cur = core.byCode[oldC]; if (!cur) return json({ ok: false, error: "Agent not found." }, 404);
    if (!inScope(cur)) return json({ ok: false, error: "That agent is not in your baseshop." }, 403);
    if (newC === oldC) return json({ ok: true, code: newC, name: full(cur), unchanged: true });
    if (core.byCode[newC]) return json({ ok: false, error: "Code " + newC + " is already used by " + full(core.byCode[newC]) + "." });
    const up = await patchAgent(oldC, { code: newC });
    if (!up.ok) return json({ ok: false, error: "Could not update the agent record." });
    const cascaded: string[] = [];
    await patchWhere("policies", `agent_code=eq.${encodeURIComponent(oldC)}`, { agent_code: newC }); cascaded.push("policies.agent_code");
    await patchWhere("policies", `split_agent_code=eq.${encodeURIComponent(oldC)}`, { split_agent_code: newC }); cascaded.push("policies.split_agent_code");
    await patchWhere("tracker_agents", `direct_to=eq.${encodeURIComponent(oldC)}`, { direct_to: newC }); cascaded.push("downline.direct_to");
    try { const org = (await loadKey("org_structure")) || { nodes: [] }; if (Array.isArray(org.nodes)) { let ch = false; org.nodes.forEach((n: any) => { if (norm(n.id) === oldC) { n.id = newC; ch = true; } if (norm(n.parent) === oldC) { n.parent = newC; ch = true; } if (has(n.gfi) && norm(n.gfi) === oldC) { n.gfi = newC; ch = true; } }); if (ch) { await saveKey("org_structure", org); cascaded.push("org_structure"); } } } catch (_) { /* noop */ }
    try { const bs = (await loadKey("baseshops")); if (bs && Array.isArray(bs.bases)) { let ch = false; bs.bases.forEach((b: any) => { if (has(b.owner_code) && norm(b.owner_code) === oldC) { b.owner_code = newC; ch = true; } }); if (ch) { await saveKey("baseshops", bs); cascaded.push("baseshops.owner_code"); } } } catch (_) { /* noop */ }
    try {
      await patchWhere("tasks", `owner_code=eq.${encodeURIComponent(oldC)}`, { owner_code: newC });
      const tsk = await getJSON(`tasks?agent_codes=cs.%5B%22${encodeURIComponent(oldC)}%22%5D&select=id,agent_codes&limit=5000`);
      for (const t of tsk) { const arr = Array.isArray(t.agent_codes) ? t.agent_codes.map((x: any) => (norm(x) === oldC ? newC : x)) : []; await patchWhere("tasks", `id=eq.${encodeURIComponent(t.id)}`, { agent_codes: arr }); }
      cascaded.push("tasks(owner+links:" + tsk.length + ")");
    } catch (_) { /* noop */ }
    return json({ ok: true, old: oldC, code: newC, name: full(cur), cascaded });
  }

  if (action === "set_status") {
    if (!az.canEdit) return json({ ok: false, error: "Operations only." }, 403);
    const a = core.byCode[norm(code)]; if (!a) return json({ ok: false, error: "Agent not found." }, 404);
    if (!inScope(a)) return json({ ok: false, error: "That agent is not in your baseshop." }, 403);
    if (OPS_CODE.test(code)) return json({ ok: false, error: "That is an Operations login, not an agent." }, 400);
    const st = low(body.status) === "quit" ? "quit" : "active";
    const up = await patchAgent(code, { status: st });
    return json({ ok: up.ok, status: st, name: full(a) });
  }
  if (action === "archived_agents") {
    if (!az.canEdit) return json({ ok: false, error: "Operations only." }, 403);
    const arr = visibleAgents.filter((a: any) => low(a.status) === "quit").map((a: any) => ({ code: a.code, name: full(a), baseshop: a.baseshop || "", contract_level: a.contract_level || "", license_status: licStatus(a) }));
    arr.sort((x: any, y: any) => x.name.localeCompare(y.name));
    return json({ ok: true, agents: arr });
  }

  if (action === "add_agent") {
    if (!az.canEdit) return json({ ok: false, error: "Operations only." }, 403);
    const first = clean(body.first_name), last = clean(body.last_name);
    if (!first && !last) return json({ ok: false, error: "Enter at least a name." });
    const wantBase = clean(body.baseshop);
    if (scoped && wantBase && !allow.has(low(wantBase))) return json({ ok: false, error: "You can only add people to your own baseshop." }, 403);
    const used = new Set(Object.keys(core.byCode)); const AL = "ABCDEFGHJKLMNPQRSTUVWXYZ";
    let newCode = norm(body.custom_code || "");
    if (newCode) { if (!/^[A-Z0-9]{2,12}$/.test(newCode)) return json({ ok: false, error: "Custom code must be 2–12 letters/numbers." }); if (used.has(newCode) || OPS_CODE.test(newCode)) return json({ ok: false, error: "That code is already in use." }); }
    else { for (let i = 0; i < 400; i++) { const c = AL[Math.floor(Math.random() * AL.length)] + String(Math.floor(1000 + Math.random() * 9000)); if (!used.has(norm(c))) { newCode = c; break; } } }
    if (!newCode) return json({ ok: false, error: "Could not allocate a code, try again." });
    const dt = norm(body.direct_to); const upA = dt ? core.byCode[dt] : null;
    const row: Record<string, unknown> = {
      code: newCode, first_name: first, last_name: last, status: "active",
      contract_level: clean(body.contract_level) || "Associate", baseshop: wantBase || (scoped ? Array.from(allow)[0] : null) || null, state: clean(body.state) || null,
      phone: clean(body.phone) || null, email: clean(body.email) || null,
      direct_to: dt || null, direct_to_name: upA ? full(upA) : (clean(body.direct_to_name) || null),
      ica: clean(body.ica) || null, ica_date: clean(body.ica_date) || null,
      license_type: clean(body.license_type) || null, license_status: clean(body.license_status) || null, license_number: clean(body.license_number) || null,
      notes_log: [], custom: {}
    };
    const ins = await fetch(`${SUPA}/rest/v1/tracker_agents`, { method: "POST", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify(row) });
    if (!ins.ok) { const t = await ins.text(); return json({ ok: false, error: "Could not add.", detail: t.slice(0, 200) }); }
    return json({ ok: true, code: newCode, name: (first + " " + last).trim(), recruiter_unknown: !!(dt && !upA) });
  }

  if (action === "delete_agent") {
    if (!az.canEdit) return json({ ok: false, error: "Operations only." }, 403);
    const a = core.byCode[norm(code)]; if (!a) return json({ ok: false, error: "Agent not found." }, 404);
    if (!inScope(a)) return json({ ok: false, error: "That agent is not in your baseshop." }, 403);
    if (OPS_CODE.test(code)) return json({ ok: false, error: "That is an Operations login, not an agent." }, 400);
    const del = await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${encodeURIComponent(norm(code))}`, { method: "DELETE", headers: { ...DBH, Prefer: "return=minimal" } });
    try { const org = (await loadKey("org_structure")) || { nodes: [] }; if (Array.isArray(org.nodes)) { const before = org.nodes.length; org.nodes = org.nodes.filter((n: any) => norm(n.id) !== norm(code)); if (org.nodes.length !== before) await saveKey("org_structure", org); } } catch (_) { /* noop */ }
    return json({ ok: del.ok, name: full(a) });
  }

  if (action === "add_column") {
    if (!az.canEdit) return json({ ok: false, error: "Operations only." }, 403);
    const label = clean(body.label).slice(0, 40); if (!label) return json({ ok: false, error: "Enter a column name." });
    const tab = clean(body.tab) || "licensing";
    const type = normColType(body.type);
    const options = type === "select" ? cleanOptObjs(body.options) : [];
    const colr = cleanColor(body.color);
    const cur = (await loadKey("ops_custom_columns")) || []; const arr = Array.isArray(cur) ? cur : [];
    const key = crypto.randomUUID().slice(0, 8);
    arr.push({ key, label, tab, type, options, color: colr });
    await saveKey("ops_custom_columns", arr.slice(0, 200));
    return json({ ok: true, columns: arr.map(normColRec), key });
  }
  if (action === "update_column") {
    if (!az.canEdit) return json({ ok: false, error: "Operations only." }, 403);
    const key = clean(body.key);
    const cur = (await loadKey("ops_custom_columns")) || []; const arr = Array.isArray(cur) ? cur : [];
    const c = arr.find((x: any) => x.key === key); if (!c) return json({ ok: false, error: "Column not found." }, 404);
    if (body.label !== undefined) { const l = clean(body.label).slice(0, 40); if (l) c.label = l; }
    if (body.type !== undefined) c.type = normColType(body.type);
    if (body.options !== undefined) c.options = cleanOptObjs(body.options);
    if (body.color !== undefined) c.color = cleanColor(body.color);
    await saveKey("ops_custom_columns", arr);
    return json({ ok: true, columns: arr.map(normColRec) });
  }
  if (action === "delete_column") {
    if (!az.canEdit) return json({ ok: false, error: "Operations only." }, 403);
    const key = clean(body.key);
    const cur = (await loadKey("ops_custom_columns")) || []; const arr = (Array.isArray(cur) ? cur : []).filter((c: any) => c.key !== key);
    await saveKey("ops_custom_columns", arr);
    return json({ ok: true, columns: arr.map(normColRec) });
  }
  if (action === "save_license_statuses") {
    if (!az.canEdit) return json({ ok: false, error: "Operations only." }, 403);
    const arr = Array.isArray(body.statuses) ? body.statuses.map((s: unknown) => clean(s)).filter((s: string) => has(s)).slice(0, 60) : [];
    if (!arr.length) return json({ ok: false, error: "Keep at least one status." });
    await saveKey("ops_license_statuses", arr);
    let colors = core.statusColors;
    if (body.colors !== undefined) { colors = cleanColorMap(body.colors); await saveKey("ops_license_status_colors", colors); }
    // The dashboard's Licensed count follows the LAST status in this list, so tell the
    // caller which one that now is rather than leaving them to guess.
    return json({ ok: true, license_statuses: arr, status_colors: colors, licensed_label: licensedLabel(arr) });
  }

  if (action === "edit_request") {
    const a = core.byCode[norm(code)]; if (!a) return json({ ok: false, error: "Agent not found." }, 404);
    if (!inScope(a)) return json({ ok: false, error: "That agent is not in your baseshop." }, 403);
    const reqs = (await loadKey("ops_edit_requests")) || [];
    const arr = Array.isArray(reqs) ? reqs : [];
    arr.unshift({ id: crypto.randomUUID(), agent_code: a.code, agent_name: full(a), field: clean(body.field), note: clean(body.note), by_code: meCode, by_name: meName, by_role: az.role, ts: new Date().toISOString(), status: "pending" });
    await saveKey("ops_edit_requests", arr.slice(0, 1000));
    return json({ ok: true });
  }
  if (action === "requests") {
    const reqs = (await loadKey("ops_edit_requests")) || [];
    const arr = Array.isArray(reqs) ? reqs.slice(0, 300) : [];
    const mine = limited ? arr.filter((r: any) => { const a = core.byCode[norm(r.agent_code)]; return a && inScope(a); }) : arr;
    return json({ ok: true, can_edit: az.canEdit, requests: mine });
  }
  if (action === "resolve_request") {
    if (!az.canEdit) return json({ ok: false, error: "Operations only." }, 403);
    const id = String(body.id || ""); const st = clean(body.status) || "applied";
    const reqs = (await loadKey("ops_edit_requests")) || [];
    const arr = Array.isArray(reqs) ? reqs : [];
    const r = arr.find((x: any) => x.id === id); if (r) { r.status = st; r.resolved_at = new Date().toISOString(); }
    await saveKey("ops_edit_requests", arr);
    return json({ ok: true });
  }

  if (action === "overview") {
    const active = visibleAgents.filter((a: any) => low(a.status) !== "quit");
    const complete = active.filter((a: any) => has(a.first_name) && has(a.last_name) && has(a.phone) && has(a.email) && has(a.state) && has(a.direct_to)).length;
    const start = ptToday().slice(0, 8) + "01";
    const codes = new Set(active.map((a: any) => norm(a.code)));
    const pols = await getJSON(`policies?submitted_date=gte.${start}&select=annual_premium,agent_code&limit=8000`);
    const monthAP = pols.filter((p: any) => !limited || codes.has(norm(p.agent_code))).reduce((t: number, p: any) => t + numOr(p.annual_premium), 0);
    // Was `licStatus(a) === "Licensed"` — a word no agent has ever carried. See licensedLabel().
    const licensed = active.filter((a: any) => isLicensed(licStatus(a), core.licStatuses)).length;
    const byBase: Record<string, number> = {}; active.forEach((a: any) => { const b = a.baseshop || "—"; byBase[b] = (byBase[b] || 0) + 1; });
    return json({ ok: true, role: az.role, can_edit: az.canEdit, scoped, overview: { agents: active.length, complete, licensed, licensed_label: licensedLabel(core.licStatuses), month_ap: Math.round(monthAP), by_base: byBase } });
  }

  const active = visibleAgents.filter((a: any) => low(a.status) !== "quit");
  return json({ ok: true, count: active.length, people: active.map((a: any) => ({ code: a.code, name: full(a), phone: a.phone || "", email: a.email || "", state: a.state || "", ica: a.ica || "", baseshop: a.baseshop || "", contract_level: a.contract_level || "Associate" })) });
});
