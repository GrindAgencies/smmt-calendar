// leaderboard-api v25 (2026-10-26) — ONE TREE, AND HIERARCHY MEANS YOURS. Brief section 8.
//      · The tree came from app_settings.org_structure, a stale copy (92 nodes for 199 agents, five
//        parents disagreeing with direct_to): Gage Griffin's team read 3 people against a real 11.
//        parentOf is now tracker_agents.direct_to - the canonical recruiter link every other
//        screen uses - with the old copy only as a fallback for someone who has no direct_to.
//      · board scope=hierarchy ranked the whole company for everyone. It now ranks the caller and
//        their recursive downline; the root of the tree and the company-wide (super) seats keep the
//        whole company. snapshot.company follows the same rule.
// leaderboard-api v24 — STANDARD leaderboard + spotlight + emblem ledger + calling-cards + dashboard snapshot.
// v24 (2026-10-20): ALL TIME MEANS ALL OF IT, UNDATED BUSINESS INCLUDED. v23 implemented 'all'
//      as a window starting 1900-01-01, which is correct arithmetic and still the wrong answer:
//      a policy with no submitted_date fails `>= 1900-01-01` rather than passing it, so every
//      undated record fell out. Seale Mosle's all-time premium read $242,835 against a true
//      $258,759 — four of his policies, $15,924, silently missing from a figure whose entire
//      promise is that nothing is missing. Company-wide that is 8 policies and $18,924 of
//      premium, plus 27 paid policies carrying no payout date of any kind.
//      So 'all' now has NO date test at all, rather than a very old one: undated rows are in.
//      Every other period still excludes them, which is right — a record with no date cannot
//      honestly be placed in a week, a month, a year or a custom range, and ops-metrics already
//      reports those gaps by name on the Reports tab so they get fixed rather than hidden.
// v23 (2026-10-20): THE PERIOD ENGINE GAINED AN END DATE. Every figure here was built from a
//      single lower bound — "everything since <start>" — with no upper bound anywhere, so two
//      things were impossible rather than merely unbuilt: ALL TIME ('all' silently fell through
//      to the month default, as did every unrecognised word, so the button would have shown
//      October and looked right) and a DAY-EXACT CUSTOM RANGE (leaderboard.html had shipped a
//      custom-range sheet carrying an honest note that it was not day-exact). Both are the same
//      missing bound. ptPeriod() returns { ymd, end, label }; buildContext() applies both ends to
//      submitted premium, families, points paid, field trainings and recruits.
//      THE EXISTING PERIODS ARE DELIBERATELY UNCHANGED: week, month and year return
//      end = FAR_FUTURE, exactly the unbounded behaviour they have always had. Not caution for
//      its own sake — three field trainings are booked for future dates, so clamping to "today"
//      would have quietly dropped them from trainings_ran. Verified: all 12 existing
//      scope x period combinations returned byte-identical boards after the change.
//      `allPrem` stays unbounded in every period: it backs Net Licenses, which asks whether a
//      recruit has EVER written $1,000, not whether they did so inside the window.
// v19 (2026-09-07): FAMILIES HELPED IS A HOUSEHOLD COUNT, NOT A SCORE YOU CAN ADD UP. Every
//      aggregate — team, baseshop and company — summed each agent's family count, so when two
//      agents on the same team both served the Doe household the team was credited with two
//      families instead of one. Christopher's team read 39 households for the year when the real
//      figure was 27, and both sides of a split were counted twice by construction. Families are
//      now a UNION of surnames across the group. Everything else stays a sum, which is correct:
//      premium shares total 100% across a split, each side of a split earns on their OWN
//      contract, and every recruit and every training has exactly one owner.
// v18 (2026-09-07): the TEAM tab rolls up. A leader's number now includes everyone beneath them,
//      so Chris (who recruited Courtney, who recruited Paige) shows all three, Courtney shows two
//      and Paige shows her own. Baseshop and Hierarchy stay individual — those are the
//      competitions, and rolling them up would let a leader out-rank their own people on their
//      people's work.
// v17 (2026-09-07): FAMILIES HELPED is households, not policies — distinct SURNAMES, counted once
//      the policy is in force or paid out. Both sides of a split are credited. Field Trainings
//      Attended is retired from the dashboard in its favour.
// v16: FIELD TRAININGS SPLIT IN TWO — trainings_ran (trainer, every source incl. Calendly) and
//      trainings_attended (the agent trained, in-app only). Kept here for the snapshot.
// v15: Submitted Premium is dated by submitted_date; Points Paid by the IN FORCE date.
// v13: WHOSE NUMBERS COUNT — totals run over a `countable` set (not quit, not a system account).
// v10: split-aware premium — each agent is credited their SHARE of a split policy's premium.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const NET_LICENSE_MIN = 1000;
const BOARD_SIZE = 25;   // every category lists 25, zeros included, so nobody is invisible
const FAR_FUTURE = "2999-12-31";   // the open end: what every period meant before v23
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
function json(o: unknown, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const low = (s: unknown) => (s ?? "").toString().trim().toLowerCase();
const full = (a: any) => `${a.first_name || ""} ${a.last_name || ""}`.trim();
const isLic = (ls: unknown) => { const s = low(ls); return !!s && (s.includes("licensed") || s.includes("passed exam") || s.includes("appointed")) && !s.includes("not licensed") && !s.includes("unlicensed"); };
function money2(n: number) { n = Number(n) || 0; if (n >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M"; if (n >= 1e3) return "$" + (Math.round(n / 100) / 10) + "K"; return "$" + Math.round(n); }
const MN = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const EMBLEM_META: Record<string, [string, string]> = { licensed: ["\u{1F3AB}","rank"], cft: ["\u{1F3B5}","rank"], senior_associate: ["\u{1F396}️","rank"], md: ["\u{1F3C5}","rank"], emd: ["\u{1F451}","rank"], cash_100k: ["\u{1F4B5}","bronze"], cash_250k: ["\u{1F4B0}","silver"], cash_500k: ["\u{1F48E}","gold"], cash_1m: ["\u{1F3C6}","platinum"], team_10: ["\u{1F91D}","bronze"], team_25: ["\u{1F465}","silver"], team_50: ["\u{1F3DB}️","gold"], team_100: ["\u{1F310}","platinum"], md_1: ["⭐","silver"], md_3: ["\u{1F31F}","gold"], md_5: ["\u{1F4AB}","platinum"], champ_1: ["\u{1F947}","gold"], champ_5: ["\u{1F525}","platinum"], champ_10: ["\u{1F410}","platinum"], tenure_3mo: ["\u{1F331}","bronze"], tenure_6mo: ["⏳","bronze"], tenure_1yr: ["\u{1F382}","silver"], tenure_2yr: ["\u{1F5D3}️","gold"], tenure_3yr: ["\u{1F397}️","gold"], tenure_5yr: ["\u{1F985}","platinum"] };

// One family = one SURNAME. "John Doe, Jane Doe, Sam Doe" is three policies and ONE family helped.
// Trailing suffixes are stripped so "Robert Smith Jr." and "Robert Smith" are the same household.
function surname(nm: unknown): string {
  const s = (nm ?? "").toString().trim().replace(/[\s,]+(jr|sr|ii|iii|iv|v|md|dds|esq|phd)\.?$/i, "").trim();
  if (!s) return "";
  const parts = s.split(/\s+/);
  return parts[parts.length - 1].toLowerCase();
}
// A policy counts as help delivered once it is actually on the books.
const INFORCE = ["paid", "funds_received", "policy_issued", "premium_drafted"];

function prettyDay(ymd: string) {
  const y = ymd.slice(0, 4), m = parseInt(ymd.slice(5, 7), 10), d = parseInt(ymd.slice(8, 10), 10);
  return `${MN[m - 1].slice(0, 3)} ${d}, ${y}`;
}

/* The window a board is built over. Returns an inclusive [ymd, end] pair.
   week / month / year keep the open end they have always had (see the v23 note); 'all' carries
   no date test whatsoever (v24); only an explicit custom range clamps the top. */
function ptPeriod(period: string, from?: string, to?: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(new Date());
  const gp = (t: string) => { const x = parts.find((p) => p.type === t); return x ? x.value : ""; };
  const y = parseInt(gp("year"), 10), m = parseInt(gp("month"), 10), d = parseInt(gp("day"), 10);
  const wd = ({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 } as Record<string, number>)[gp("weekday")] || 0;
  const pad = (n: number) => (n < 10 ? "0" + n : "" + n);
  if (period === "custom") {
    /* Both ends inclusive, and ordered defensively: a user who picks the end date first must
       not get an empty board. */
    const f = String(from || "").slice(0, 10), t = String(to || "").slice(0, 10);
    const lo = (f <= t) ? f : t, hi = (f <= t) ? t : f;
    return { ymd: lo, end: hi, label: (lo === hi) ? prettyDay(lo) : `${prettyDay(lo)} – ${prettyDay(hi)}` };
  }
  if (period === "all")  return { ymd: "", end: FAR_FUTURE, label: "All time" };   // "" = no date test
  if (period === "year") return { ymd: `${y}-01-01`, end: FAR_FUTURE, label: `${y} · Year to date` };
  if (period === "week") { const back = (wd === 0 ? 6 : wd - 1); const dt = new Date(Date.UTC(y, m - 1, d)); dt.setUTCDate(dt.getUTCDate() - back); const sy = dt.getUTCFullYear(), sm = dt.getUTCMonth() + 1, sd = dt.getUTCDate(); return { ymd: `${sy}-${pad(sm)}-${pad(sd)}`, end: FAR_FUTURE, label: `Week of ${MN[sm - 1].slice(0, 3)} ${sd}` }; }
  return { ymd: `${y}-${pad(m)}-01`, end: FAR_FUTURE, label: `${MN[m - 1]} ${y}` };
}
function ptWeekday() { const wd = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short" }).format(new Date()); return ({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 } as Record<string, number>)[wd]; }
function ptDate() { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
async function loadKey(k: string) { const r = await fetch(`${SUPA}/rest/v1/app_settings?key=eq.${k}&select=value`, { headers: DBH }); const rows = await r.json(); return (rows && rows[0]) ? rows[0].value : null; }
async function saveKey(k: string, value: unknown) { await fetch(`${SUPA}/rest/v1/app_settings?on_conflict=key`, { method: "POST", headers: { ...DBH, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key: k, value, updated_at: new Date().toISOString() }) }); }
async function getJSON(path: string) { const r = await fetch(`${SUPA}/rest/v1/${path}`, { headers: DBH }); return (await r.json()) || []; }
async function rpc(fn: string, args: Record<string, unknown>) { try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); return await r.json(); } catch (_) { return null; } }
async function opsAuthorized(token: unknown) { const r = await rpc("ops_authorize", { p_token: String(token ?? "") }); return !!(r && r.ok); }
async function postChat(channel: string, bodyTxt: string) { await fetch(`${SUPA}/rest/v1/hub_messages`, { method: "POST", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify({ channel, author_code: "CHAMP", author_name: "\u{1F3C6} Leaderboard", body: bodyTxt, kind: "recognition", attach: null, reactions: {} }) }); }

function descendantsOf(parentOf: Record<string, string>, root: string): Set<string> {
  const kids: Record<string, string[]> = {};
  for (const c in parentOf) { const p = parentOf[c]; if (p) (kids[p] = kids[p] || []).push(c); }
  const out = new Set<string>(); const stack = [norm(root)]; let g = 0;
  while (stack.length && g++ < 20000) { const cur = stack.pop()!; (kids[cur] || []).forEach((k) => { if (!out.has(k)) { out.add(k); stack.push(k); } }); }
  return out;
}

// TEAM TAB ONLY: a leader's number includes everyone beneath them. Chris recruits Courtney,
// Courtney recruits Paige — Chris's team figure counts all three, Courtney's counts two, Paige's
// counts her own. Baseshop and Hierarchy stay individual, because those are the competitions and
// rolling them up would let a leader out-rank their own people on their own people's work.
function rollUp(ctx: any, map: Record<string, number>, team: Set<string>) {
  const out: Record<string, number> = {};
  team.forEach((c) => {
    let sum = ctx.countable(c) ? (map[c] || 0) : 0;
    descendantsOf(ctx.parentOf, c).forEach((d) => { if (team.has(d) && ctx.countable(d)) sum += map[d] || 0; });
    out[c] = sum;
  });
  return out;
}

// A HOUSEHOLD IS NOT A SCORE. If two agents on the same team each served the Doe family, the team
// helped one family, not two — and both sides of a split are credited the same household by
// design. So any group figure for families is the size of the UNION of their surnames, never the
// sum of their counts. Everything else on the board is genuinely additive and still uses rollUp().
function famUnion(ctx: any, codes: string[]): number {
  const seen = new Set<string>();
  codes.forEach((c) => {
    if (!ctx.countable(c)) return;
    const s = ctx.famSets[c];
    if (s) s.forEach((x: string) => seen.add(x));
  });
  return seen.size;
}
function rollUpFam(ctx: any, team: Set<string>) {
  const out: Record<string, number> = {};
  team.forEach((c) => {
    const codes = [c];
    descendantsOf(ctx.parentOf, c).forEach((d) => { if (team.has(d)) codes.push(d); });
    out[c] = famUnion(ctx, codes);
  });
  return out;
}

async function buildContext(period: string, from?: string, to?: string) {
  const P = ptPeriod(period, from, to); const start = P.ymd; const end = P.end;
  /* 'all' asks no date question at all, so a record with no date is IN rather than silently out
     (v24). Every other period requires a real date, because a record that cannot be dated cannot
     honestly be placed inside a week, a month, a year or a custom range. */
  const noDateTest = (period === "all");
  const inWin = (d: string) => noDateTest ? true : (!!d && d >= start && d <= end);
  const bases = (await loadKey("baseshops")) || { root: "STANDARD", bases: [] };
  const root = bases.root || "STANDARD";
  const baseList = Array.isArray(bases.bases) ? bases.bases : [];
  const org = (await loadKey("org_structure")) || { nodes: [] };
  const nodes = Array.isArray(org.nodes) ? org.nodes : [];
  const parentOf: Record<string, string> = {}; nodes.forEach((n: any) => parentOf[norm(n.id)] = norm(n.parent || ""));
  const brokerEmb = (await loadKey("broker_emblems")) || {};
  const agents = await getJSON("tracker_agents?select=code,first_name,last_name,baseshop,created_at,md,emd,status,license_status,system_account,direct_to&limit=2000");
  /* v25: the canonical recruiter link wins; org_structure only fills a gap. */
  agents.forEach((a: any) => { const c = norm(a.code), d = norm(a.direct_to); if (c && d && d !== c) parentOf[c] = d; });
  const orgRoot = norm(org.root || "");
  const byCode: Record<string, any> = {}; const nameToCode: Record<string, string> = {};
  agents.forEach((a: any) => { const c = norm(a.code); byCode[c] = { code: a.code, name: full(a), baseshop: a.baseshop || root, created_at: a.created_at, md: a.md || "", emd: a.emd || "", status: a.status || "active", system: !!a.system_account }; if (full(a)) nameToCode[low(full(a))] = c; });

  const countable = (c: string) => { const a = byCode[c]; return !!a && low(a.status) !== "quit" && !a.system; };

  const creditPrem = (map: Record<string, number>, p: any) => {
    const ap = Number(p.annual_premium) || 0; if (!ap) return;
    const wc = norm(p.agent_code) || nameToCode[low(p.agent_name)] || "";
    if (p.split_flag && norm(p.split_agent_code)) {
      const sp = (p.split_pct != null) ? Math.max(0, Math.min(100, Number(p.split_pct))) : 50;
      if (wc) map[wc] = (map[wc] || 0) + Math.round(ap * sp / 100);
      const pc = norm(p.split_agent_code); map[pc] = (map[pc] || 0) + Math.round(ap * (100 - sp) / 100);
    } else if (wc) { map[wc] = (map[wc] || 0) + ap; }
  };
  // SUBMITTED PREMIUM — dated by submitted_date, i.e. when the business was written.
  // Under 'all' the date filter is dropped entirely rather than widened, so the 8 policies
  // carrying no submitted_date ($18,924 of premium) are counted instead of vanishing.
  /* v28 (2026-10-26, Christopher): Submitted Premium is business that is still alive. Drafts
     (incomplete) were never submitted, and declined / cancelled / closed / lapsed business did not
     go through -- the same rule New Business, ops-metrics and ops-nbfeed already use, so the
     leaderboard and the New Business cards now agree. */
  let polQ = `policies?select=agent_code,agent_name,annual_premium,split_flag,split_pct,split_agent_code,status&or=(status.is.null,status.not.in.(incomplete,declined,cancelled,canceled,closed,lapsed))&limit=20000`;
  if (!noDateTest) {
    polQ += `&submitted_date=gte.${start}`;
    if (end !== FAR_FUTURE) polQ += `&submitted_date=lte.${end}`;
  }
  const pols = await getJSON(polQ);
  const premium: Record<string, number> = {}; pols.forEach((p: any) => creditPrem(premium, p));
  /* Deliberately unbounded in EVERY period: this backs Net Licenses, which asks whether a recruit
     has ever written $1,000 — not whether they did so inside the selected window. */
  const allPols = await getJSON(`policies?select=agent_code,agent_name,annual_premium,split_flag,split_pct,split_agent_code&or=(status.is.null,status.neq.incomplete)&limit=20000`);  // a draft is not $1,000 written
  const allPrem: Record<string, number> = {}; allPols.forEach((p: any) => creditPrem(allPrem, p));

  // FAMILIES HELPED — one per SURNAME, counted once the policy is actually in force / paid out.
  // The SETS are kept, not just their sizes: any group figure has to union them (see famUnion).
  const famPols = await getJSON(`policies?select=agent_code,agent_name,client_name,status,split_flag,split_agent_code,paid_out_date,first_draft_date,submitted_date&limit=20000`);
  const famSets: Record<string, Set<string>> = {};
  famPols.forEach((p: any) => {
    if (INFORCE.indexOf(low(p.status)) < 0) return;
    const sur = surname(p.client_name); if (!sur) return;
    const d = String(p.paid_out_date || p.first_draft_date || p.submitted_date || "").slice(0, 10);
    if (!inWin(d)) return;
    const wc = norm(p.agent_code) || nameToCode[low(p.agent_name)] || "";
    if (wc) (famSets[wc] = famSets[wc] || new Set<string>()).add(sur);
    const pc = (p.split_flag && norm(p.split_agent_code)) ? norm(p.split_agent_code) : "";
    if (pc) (famSets[pc] = famSets[pc] || new Set<string>()).add(sur);   // both sides helped them
  });
  const families: Record<string, number> = {};
  for (const c in famSets) families[c] = famSets[c].size;

  // POINTS PAID — commission on business that went IN FORCE in this period.
  const paidPols = await getJSON(`policies?status=eq.paid&select=agent_code,agent_name,annual_premium,contract_pct,partner_contract_pct,split_flag,split_pct,split_agent_code,paid_out_date,first_draft_date&limit=8000`);
  const points_paid: Record<string, number> = {};
  let paid_undated = 0;
  paidPols.forEach((p: any) => {
    const d = String(p.paid_out_date || p.first_draft_date || "").slice(0, 10);
    if (!d) { paid_undated++; if (!noDateTest) return; }   // under 'all', undated paid business still counts
    else if (!inWin(d)) return;
    const ap = Number(p.annual_premium) || 0; if (!ap) return;
    const wc = norm(p.agent_code) || nameToCode[low(p.agent_name)] || "";
    const pc = (p.split_flag && norm(p.split_agent_code)) ? norm(p.split_agent_code) : "";
    const wShare = pc ? ((p.split_pct != null) ? Math.max(0, Math.min(100, Number(p.split_pct))) : 50) : 100;
    const wPct = Number(p.contract_pct) || 0;
    if (wc && wPct) points_paid[wc] = (points_paid[wc] || 0) + Math.round(ap * (wShare / 100) * (wPct / 100));
    if (pc) { const pPct = Number(p.partner_contract_pct) || 0; if (pPct) points_paid[pc] = (points_paid[pc] || 0) + Math.round(ap * ((100 - wShare) / 100) * (pPct / 100)); }
  });

  // FIELD TRAININGS — RAN goes to the trainer (every source, incl. Calendly). ATTENDED goes to the
  // agent trained; no longer a leaderboard category but the snapshot still reports it.
  const bks = await getJSON(`bookings?category=ilike.*field*training*&select=agent_code,agent_name,trainer_code,trainer_name,date,starts_at,status&limit=8000`);
  const trainings_ran: Record<string, number> = {};
  const trainings_attended: Record<string, number> = {};
  const SKIP = ["canceled", "cancelled", "declined", "no_show", "transferred", "pending"];
  bks.forEach((b: any) => {
    const st = low(b.status); if (SKIP.includes(st)) return;
    const d = ((b.date || "").toString().slice(0, 10)) || ((b.starts_at || "").toString().slice(0, 10));
    if (!inWin(d)) return;
    const tc = norm(b.trainer_code) || nameToCode[low(b.trainer_name)] || "";
    if (tc) trainings_ran[tc] = (trainings_ran[tc] || 0) + 1;
    const ac = norm(b.agent_code) || nameToCode[low(b.agent_name)] || "";
    if (ac && ac !== tc) trainings_attended[ac] = (trainings_attended[ac] || 0) + 1;
  });

  const recruits: Record<string, number> = {}; const netLic: Record<string, number> = {}; const licensed: Record<string, number> = {};
  agents.forEach((a: any) => {
    const cc = norm(a.code); if (low(a.status) === "quit" || a.system_account) return;
    let rc = parentOf[cc] || ""; if (!rc || !byCode[rc]) rc = nameToCode[low(a.md)] || nameToCode[low(a.emd)] || "";
    if (!rc || rc === cc) return;
    if ((allPrem[cc] || 0) >= NET_LICENSE_MIN) netLic[rc] = (netLic[rc] || 0) + 1;
    if (isLic(a.license_status)) licensed[rc] = (licensed[rc] || 0) + 1;
    const cr = (a.created_at || "").toString().slice(0, 10); if (inWin(cr)) recruits[rc] = (recruits[rc] || 0) + 1;
  });

  return { P, start, end, noDateTest, bases, root, orgRoot, baseList, parentOf, byCode, nameToCode, brokerEmb, countable, paid_undated, trainings_attended, famSets, maps: { recruiter: recruits, premium, points_paid, trainings_ran, net_licenses: netLic, licensed, families } as Record<string, Record<string, number>> };
}
function embOf(ctx: any, code: string) { const sel = ctx.brokerEmb[norm(code)] || ctx.brokerEmb[code]; const id = Array.isArray(sel) ? sel[0] : null; if (id && EMBLEM_META[id]) return { icon: EMBLEM_META[id][0], tier: EMBLEM_META[id][1] }; return null; }

function ranked(ctx: any, map: Record<string, number>, base: string | null, opts?: { includeZeros?: boolean; only?: Set<string> }) {
  const includeZeros = !!(opts && opts.includeZeros);
  const only = opts && opts.only;
  const universe = includeZeros ? Object.keys(ctx.byCode) : Object.keys(map);
  const rows = universe.filter((c) => {
    const a = ctx.byCode[c];
    if (a && (low(a.status) === "quit" || a.system)) return false;   // never rank a leaver or a test account
    if (includeZeros) {
      if (!a) return false;
      if (!a.name) return false;
    } else if (!(map[c] > 0)) return false;
    if (only && !only.has(c)) return false;
    if (base !== null && !(a && low(a.baseshop) === low(base))) return false;
    return true;
  }).map((c) => ({ code: ctx.byCode[c] ? ctx.byCode[c].code : c, name: ctx.byCode[c] ? ctx.byCode[c].name : c, baseshop: ctx.byCode[c] ? ctx.byCode[c].baseshop : "", value: map[c] || 0, emb: embOf(ctx, c) }));
  rows.sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
  return rows;
}


/* ===== leaderboard-api v: WHO IS CALLING (2026-09-30) =====
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
  let body: any = {}; try { body = req.method === "POST" ? await req.json() : {}; } catch (_) { body = {}; }
  const url = new URL(req.url);
  const action = String(body.action || url.searchParams.get("action") || "board");
    /* Resolve the caller once, then overwrite body.code with the verified answer. */
    {
      const _ops = await _isOps((body as Record<string, unknown>).token);
      if (!_ops) {
        const _me = await _sessionCode((body as Record<string, unknown>).session);
        if (!_me) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401);
        (body as Record<string, unknown>).code = _me;
      }
    }

  if (action === "snapshot") {
    const code = norm(body.code || url.searchParams.get("code"));
    const ctx = await buildContext("month");
    const me = ctx.byCode[code] || null;
    const myBase = me ? me.baseshop : ctx.root;
    const M = ctx.maps; const TA = ctx.trainings_attended;
    const sumOver = (codes: string[]) => {
      let partners = 0, premium = 0, trainings_ran = 0, trainings_attended = 0, points_paid = 0;
      codes.filter(ctx.countable).forEach((c) => { partners += M.recruiter[c] || 0; premium += M.premium[c] || 0; trainings_ran += M.trainings_ran[c] || 0; trainings_attended += TA[c] || 0; points_paid += M.points_paid[c] || 0; });
      // households, not a sum — one family served by two of your people is still one family
      return { partners, premium, trainings_ran, trainings_attended, trainings: trainings_ran, families: famUnion(ctx, codes), points_paid };
    };
    const allCodes = Object.keys(ctx.byCode);
    const baseCodes = allCodes.filter((c) => low(ctx.byCode[c].baseshop) === low(myBase));
    const teamCodes = [code, ...Array.from(descendantsOf(ctx.parentOf, code))];
    const ran = M.trainings_ran[code] || 0;
    const personal = { partners: M.recruiter[code] || 0, premium: M.premium[code] || 0, trainings_ran: ran, trainings_attended: TA[code] || 0, trainings: ran, families: M.families[code] || 0, points_paid: M.points_paid[code] || 0 };
    const wholeCo = (code === ctx.orgRoot) || ctx.baseList.some((b: any) => b.super && norm(b.owner_code) === code);
    return json({ ok: true, month: ctx.P.label, month_start: ctx.P.ymd, base: myBase, personal, team: sumOver(teamCodes), shop: sumOver(baseCodes), company: sumOver(wholeCo ? allCodes : teamCodes), company_scope: wholeCo ? "company" : "hierarchy" });
  }

  if (action === "board") {
    const code = norm(body.code || url.searchParams.get("code"));
    const scope = low(body.scope || url.searchParams.get("scope") || "hierarchy");
    let period = low(body.period || url.searchParams.get("period") || "month");
    /* A custom range needs BOTH ends; without them it is not a range and falls back to the month
       rather than silently reporting something else under a custom label. */
    const cFrom = String(body.from || url.searchParams.get("from") || "").slice(0, 10);
    const cTo   = String(body.to   || url.searchParams.get("to")   || "").slice(0, 10);
    const isYmd = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
    if (period === "custom" && !(isYmd(cFrom) && isYmd(cTo))) period = "month";
    if (["week", "month", "year", "all", "custom"].indexOf(period) < 0) period = "month";
    const ctx = await buildContext(period, cFrom, cTo);
    const me = ctx.byCode[code] || null;
    const callerBase = me ? me.baseshop : ctx.root;
    const superOwn = ctx.baseList.find((b: any) => b.super && norm(b.owner_code) === code);
    let targetBase = callerBase;
    if (scope === "baseshop" && superOwn && body.base) targetBase = String(body.base);
    function meIn(rows: any[]) { for (let i = 0; i < rows.length; i++) if (norm(rows[i].code) === code) return { rank: i + 1, value: rows[i].value }; return { rank: 0, value: 0 }; }
    const team = new Set<string>([code, ...Array.from(descendantsOf(ctx.parentOf, code))]);
    const boards: Record<string, unknown> = {};
    for (const k of Object.keys(ctx.maps)) {
      const map = ctx.maps[k];
      if (scope === "personal") {
        const allRows = ranked(ctx, map, null); const baseRows = ranked(ctx, map, callerBase);
        const cR = meIn(allRows); const bR = meIn(baseRows);
        boards[k] = { value: map[code] || 0, rank_company: cR.rank, of_company: allRows.length, rank_base: bR.rank, of_base: baseRows.length, leader: allRows[0] ? { name: allRows[0].name, value: allRows[0].value } : null };
      } else {
        // Team rolls each person's downline into their number; the other scopes stay individual.
        // Families roll up as a UNION of households, everything else as a sum.
        const useMap = (scope === "team") ? (k === "families" ? rollUpFam(ctx, team) : rollUp(ctx, map, team)) : map;
        /* v25: Hierarchy is the caller's own tree unless they are the root or a company-wide seat. */
        const wholeCo = (code === ctx.orgRoot) || !!superOwn;
        const only = (scope === "team" || (scope === "hierarchy" && !wholeCo)) ? team : undefined;
        const rows = ranked(ctx, useMap, scope === "baseshop" ? targetBase : null, { includeZeros: true, only });
        const scored = rows.filter((r) => r.value > 0).length;
        boards[k] = { top: rows.slice(0, BOARD_SIZE).map((r, i) => ({ ...r, rank: i + 1 })), me: meIn(rows), total: rows.length, scored, rolled: scope === "team" };
      }
    }
    const viewableBases = superOwn ? ctx.baseList.map((b: any) => String(b.name)) : [callerBase];
    return json({ ok: true, scope, period, rolled_up: scope === "team", base: scope === "hierarchy" ? ctx.root : (scope === "baseshop" ? targetBase : callerBase), month: ctx.P.label, range: { from: (ctx.noDateTest ? null : ctx.start), to: ((ctx.noDateTest || ctx.end === FAR_FUTURE) ? null : ctx.end) }, is_super: !!superOwn, viewable_bases: viewableBases, board_size: BOARD_SIZE, paid_undated: ctx.paid_undated, you: { code, name: me ? me.name : "", baseshop: callerBase, emb: embOf(ctx, code) }, boards });
  }

  if (action === "spotlight") {
    if (!(await opsAuthorized(body.token))) return json({ ok: false, error: "unauthorized" }, 401);
    const preview = !!body.preview; const force = !!body.force;
    const wd = ptWeekday(); const today = ptDate();
    if (!force && [1, 3, 5].indexOf(wd) < 0) return json({ ok: true, skipped: "not Mon/Wed/Fri", weekday: wd });
    const logv = (await loadKey("spotlight_log")) || {};
    if (!force && !preview && logv.last === today) return json({ ok: true, skipped: "already posted today", at: today });
    const ctx = await buildContext("month");
    function champ(map: Record<string, number>, base: string | null) { return ranked(ctx, map, base)[0] || null; }
    function block(base: string | null) {
      const rec = champ(ctx.maps.recruiter, base), pre = champ(ctx.maps.premium, base), pp = champ(ctx.maps.points_paid, base), nl = champ(ctx.maps.net_licenses, base), tr = champ(ctx.maps.trainings_ran, base), fam = champ(ctx.maps.families, base);
      if (!rec && !pre && !tr && !nl && !pp && !fam) return null;
      const title = base ? (base + " Leaderboard") : "STANDARD Leaderboard";
      let m = "\u{1F3C6} " + title + " — " + ctx.P.label + " Champions\nGive it up for this month’s leaders! \u{1F525}";
      m += "\n\n\u{1F91D} Top Business Partners: " + (rec ? rec.name + " — " + rec.value + " new partner" + (rec.value === 1 ? "" : "s") : "—");
      m += "\n\u{1F3E1} Most Families Helped: " + (fam ? fam.name + " — " + fam.value + " household" + (fam.value === 1 ? "" : "s") : "—");
      m += "\n\u{1F4B0} Top Premium Submitted: " + (pre ? pre.name + " — " + money2(pre.value) : "—");
      m += "\n\u{1F4B5} Top Points Paid: " + (pp ? pp.name + " — " + money2(pp.value) : "—");
      m += "\n\u{1F3AB} Top Net Licenses: " + (nl ? nl.name + " — " + nl.value : "—");
      m += "\n\u{1F3CB}️ Top Field Trainings Ran: " + (tr ? tr.name + " — " + tr.value : "—");
      m += "\n\nChase the crown on your dashboard \u{1F451} New spotlight every Mon · Wed · Fri.";
      return m;
    }
    // Baseshop channels only — the company chat is not where bots announce. bot_channel_policy()
    // in the database enforces this too, so a stray post is redirected rather than landing wrong.
    const posts: { channel: string; body: string }[] = [];
    ctx.baseList.filter((b: any) => low(b.name) !== low(ctx.root)).forEach((b: any) => { const mm = block(String(b.name)); if (mm) posts.push({ channel: low(b.name) + "_announcements", body: mm }); });
    if (!preview) {
      for (const p of posts) await postChat(p.channel, p.body);
      const stats = (await loadKey("emblem_stats")) || {};
      for (const k of Object.keys(ctx.maps)) { const c = champ(ctx.maps[k], null); if (c && c.code) { const cc = norm(c.code); stats[cc] = stats[cc] || { champ: 0 }; stats[cc].champ = (Number(stats[cc].champ) || 0) + 1; } }
      await saveKey("emblem_stats", stats);
      await saveKey("spotlight_log", { last: today, at: new Date().toISOString() });
    }
    return json({ ok: true, preview, weekday: wd, month: ctx.P.label, posted: posts.length, channels: posts.map((p) => p.channel), messages: preview ? posts : undefined });
  }

  return json({ ok: false, error: "unknown action" }, 400);
});
