// ops-metrics v7 (2026-10-26) — leader check accepts spelled-out ranks ("National Vice President").
// ops-metrics v6 (2026-10-26) — A LEADER'S REPORT IS THEIR OWN BASESHOP. MD/EMD/NVP/SEVP sessions
//   were let in and then scoped with ops_scope(token="", code), which only knows Operations seats,
//   so it answered "unscoped" and every leader read every baseshop's points, AP, families,
//   licensing and data-quality list. A leader is now scoped by agent_scope() - the rule every
//   other tab uses. Operations seats and the platform builder are unchanged.
// ops-metrics v5 (2026-10-20) — the numbers Operations is asked for, from the data already here.
//
// Christopher: "track these metrics based on data in the operations dashboard. pending points
// per BASE. issued points. (after policices go in force) and then ALL licensing and NET
// licensing ratios for members on the team. please be able to generate monthly/quarterly/
// annualy reports on ALL ratios and metrics that can be provided by ALL imported data"
//
// ---------------------------------------------------------------------------------------
// WHAT A POINT IS
// A point is a commission dollar — the platform already says so ("Points Paid · Commission
// paid · by in-force date") and promotion to MD is written as 45,000 paid points. So points
// are not re-invented here; they are computed the one way the rest of the platform computes
// commission:  premium x your share of the policy x YOUR contract rate.
// Verified against the live ledger: on all 97 non-split policies that carry a rate, this
// reproduces the stored expected_commission exactly (re-verified 2026-10-20, worst gap 50c).
//
// PENDING vs ISSUED — the distinction Christopher asked for
//   PENDING  business is written and working its way through underwriting. It is not money
//            yet. Counted by submitted_date.
//   ISSUED   the carrier has paid out: status 'Paid Out'. This is the money. Counted by
//            paid_out_date, because the month a policy PAYS is not the month it was sold.
// Nothing is ever in both, and a dead policy (declined/cancelled/lapsed) is in neither.
//
// EVERY SIDE OF A SPLIT IS CREDITED TO ITS OWN AGENT'S BASESHOP
// Half the book is split business, and the two agents are not always in the same shop. A
// policy is therefore not one row with one home: it is up to two SIDES, each credited where
// that agent actually sits. This is what makes "points per BASE" mean anything. The partner's
// rate is their own — never the writer's, which is the bug that once credited partners at the
// writer's contract level — taken from partner_contract_pct, or failing that from their own
// contract level in app_settings.contract_rates. If neither is known the side is not invented;
// it is reported as a gap.
//
// FAMILIES ARE A UNION, NOT A SUM — households are counted distinct, because the same family
// cannot be added up across two agents who both worked it. v2: one household is one SURNAME,
// matching leaderboard-api. v1 counted distinct client NAMES and so reported 77 families where
// the company had helped 69.
//
// LICENSING, BOTH WAYS  (v3 — Christopher: "net licensed is licensed and have made 1000 in
// comissions")
//   ALL licensing ratio = licensed / EVERYONE ever brought in, including those who left.
//                         What share of recruiting produced a licensed agent at all.
//   NET licensing ratio = licensed AND has earned $1,000 in COMMISSION / everyone ever
//                         brought in. What share of recruiting produced a real producer.
// Same denominator on purpose, so the two read as one funnel: of everyone brought in, this
// many got licensed, and this many went on to actually earn.
//
// COMMISSION, NOT PREMIUM, AND PAID, NOT WRITTEN. Both distinctions matter and both are
// deliberate. leaderboard-api's existing "Net Licenses" column counts premium >= $1,000 and
// never checks whether the agent is licensed at all, which is a much easier bar — 36 people
// clear it where 13 clear this one. The two are NOT the same measure and are not meant to
// agree; this one follows the rule Christopher gave. "Made" is read the same way In Force is
// read: money that actually paid out, not business still working through underwriting.
//
// v4: by_base lists every shop that has EITHER business or people. Keying off business alone
// hid SCAPED entirely — two people, both licensed, no policies yet — so a whole shop's
// licensing ratio was invisible.
//
// v5 (2026-10-20, backend audit): the report now carries the NAMED records behind its own
// gaps, from the data_quality_issues view. The v4 `gaps` block said "41 policies are missing a
// payout date" but never said WHICH, so nobody could act on it and the number simply persisted.
// Severity 1 is money or headcount that is wrong RIGHT NOW (a payout dated before the business
// was submitted; a split whose partner is not on the roster, so that half is credited to
// nobody; a person whose upline does not exist, so they are in no team). Severity 2 and 3 are
// records that cannot be placed or priced. The counts are unscoped on purpose — a data fault
// is a data fault whoever is looking — but the per-record list is filtered to the viewer's
// baseshops, so a leader is handed only rows they can actually fix.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const low = (s: unknown) => (s ?? "").toString().trim().toLowerCase();
const numOr = (v: unknown) => { const n = Number(v); return isNaN(n) ? 0 : n; };
const enc = encodeURIComponent;
const r2 = (n: number) => Math.round(n * 10) / 10;

/* ONE FAMILY IS ONE SURNAME. "John Doe" and "Jane Doe" are two policies and ONE household.
   v1 counted distinct client NAMES, which read 77 families where the company had actually
   helped 69 — and it contradicted the leaderboard, which has counted surnames since
   2026-09-07. Same normalisation as leaderboard-api so the two screens cannot disagree. */
function surname(nm: unknown): string {
  const s = (nm ?? "").toString().trim().replace(/[\s,]+(jr|sr|ii|iii|iv|v|md|dds|esq|phd)\.?$/i, "").trim();
  if (!s) return "";
  const parts = s.split(/\s+/);
  return parts[parts.length - 1].toLowerCase();
}

async function getJSON(path: string) { const r = await fetch(`${SUPA}/rest/v1/${path}`, { headers: DBH }); return (await r.json()) || []; }
async function rpc(fn: string, args: Record<string, unknown>) { try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); return await r.json(); } catch (_) { return null; } }

/* What it takes to count as a NET licence: licensed, and this much commission actually
   paid out. A round number Christopher set; kept here as a constant so it is one edit. */
const NET_LICENSE_MIN = 1000;

/* Same three places a policy can be as ops-nbfeed and ops-inforce. These three lists must
   agree across all three functions — see ops-nbfeed v18 for what happens when they drift. */
const INFORCE = ["paid"];
const DEAD = ["declined", "cancelled", "incomplete", "closed", "lapsed"];

/* ---------------------------------------------------------------- who is asking */
type Auth = { ok: boolean; role?: string; code?: string; error?: string };
async function authOf(body: any): Promise<Auth> {
  const t = String(body.token ?? "").trim();
  if (t) {
    const r = await rpc("ops_authorize", { p_token: t });
    if (r && r.ok) return { ok: true, role: "ops", code: norm(r.code) };
  }
  const s = String(body.session ?? "").trim().slice(0, 120);
  if (!s) return { ok: false, error: "Sign in to Operations to open reports." };
  const got = await rpc("agent_session_code", { p_token: s });
  const code = (typeof got === "string") ? norm(got) : "";
  if (!code) return { ok: false, error: "Your session has expired — sign in again." };
  const rows = await getJSON(`tracker_agents?code=eq.${enc(code)}&select=contract_level,platform_admin`);
  if (rows[0] && rows[0].platform_admin === true) return { ok: true, role: "ops", code };
  const lvl = norm(rows[0] && rows[0].contract_level);
  /* v7: ranks are stored both abbreviated and spelled out - Elijah's reads "National Vice
     President" - so the long forms count too. Scope still comes from agent_scope below. */
  const LONG: Record<string, string> = { "MARKETING DIRECTOR": "MD", "EXECUTIVE MARKETING DIRECTOR": "EMD", "NATIONAL VICE PRESIDENT": "NVP", "SENIOR EXECUTIVE VICE PRESIDENT": "SEVP" };
  const short = LONG[lvl] || lvl;
  if (short === "MD" || short === "EMD" || short === "NVP" || short === "SEVP") return { ok: true, role: short.toLowerCase(), code };
  return { ok: false, error: "Reports are for Operations and team leaders." };
}

/* ------------------------------------------------------------- licensing stages */
/* The ledger carries thirteen different licence statuses typed by hand over two years.
   Three of them mean the agent can write business; the rest are stages on the way, and an
   empty one means nobody has started them. Matching is on substrings so a new wording
   ("Fully Licensed - Appointed") still lands in the right bucket. */
function licStage(raw: unknown): "licensed" | "working" | "not_started" {
  const s = low(raw);
  if (!s) return "not_started";
  if (s.includes("fully licensed") || s.includes("newly licensed") || s.includes("e&o") || s.includes("compliance verification")) return "licensed";
  if (s.includes("kick off") || s.includes("enroll")) return "not_started";
  return "working";   // applied, exam scheduled/passed/failed/missed, everything mid-flight
}
const hasLeft = (a: any) => !!a.archived_at || low(a.status).includes("quit");

/* --------------------------------------------------------------- period buckets */
function bucketOf(iso: unknown, period: string): string {
  const s = String(iso ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return "";
  const y = s.slice(0, 4), m = Number(s.slice(5, 7));
  if (period === "year") return y;
  if (period === "quarter") return `${y}-Q${Math.ceil(m / 3)}`;
  return s.slice(0, 7);
}
function labelOf(b: string, period: string): string {
  if (period === "year") return b;
  if (period === "quarter") return b.replace("-", " ");
  const MON = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${MON[Number(b.slice(5, 7)) - 1]} ${b.slice(0, 4)}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: any = {}; try { body = req.method === "POST" ? await req.json() : {}; } catch (_) { body = {}; }

  const az = await authOf(body);
  if (!az.ok) return json({ ok: false, error: az.error || "unauthorized" }, 401);

  const period = ["month", "quarter", "year"].indexOf(String(body.period || "month")) >= 0 ? String(body.period) : "month";
  const meCode = String(az.code || "");

  /* Baseshop scope, from the verified identity — same rule as every other Ops tab. */
  let sc = await rpc("ops_scope", { p_token: String(body.token || ""), p_code: meCode });
  if (az.role !== "ops") {
    const as = await rpc("agent_scope", { p_code: meCode });
    sc = { scoped: !(as && as.ok === true && as.all), bases: (as && Array.isArray(as.bases)) ? as.bases : [] };
  }
  const scoped = !!(sc && sc.scoped);
  const allow = new Set<string>(((sc && Array.isArray(sc.bases)) ? sc.bases : []).map((b: string) => low(b)));

  const agents = await getJSON(`tracker_agents?select=code,first_name,last_name,baseshop,contract_level,license_status,status,archived_at,ica_date,created_at,system_account&limit=5000`);
  const byCode: Record<string, any> = {};
  for (const a of agents) byCode[norm(a.code)] = a;
  const baseOf = (c: unknown) => { const a = byCode[norm(c)]; return a ? (a.baseshop || "—") : "—"; };
  const inScope = (b: unknown) => !scoped || allow.has(low(b));

  const rates = (await getJSON(`app_settings?key=eq.contract_rates&select=value`))[0]?.value || {};
  /* An agent's own rate, for a partner side the ledger never priced. Their contract level,
     never the writer's. Returns null rather than a guess. */
  function rateOf(code: unknown): number | null {
    const a = byCode[norm(code)];
    if (!a) return null;
    const r = rates[low(a.contract_level)];
    return (typeof r === "number" && r > 0) ? r : null;
  }

  const pols = await getJSON(`policies?select=id,agent_code,client_name,annual_premium,status,submitted_date,paid_out_date,first_draft_date,contract_pct,split_flag,split_agent_code,split_pct,partner_contract_pct,business_type&limit=20000`);

  /* ---------- every policy becomes one or two SIDES, each credited to its own shop ---- */
  type Side = { base: string; agent: string; points: number | null; ap: number; client: string; state: string; bucket: string; priced: boolean };
  const sides: Side[] = [];
  const gaps = { paid_no_date: 0, paid_undatable: 0, no_writer_rate: 0, split_no_partner_rate: 0, split_no_partner_code: 0 };

  for (const p of pols) {
    const st = low(p.status);
    const dead = DEAD.indexOf(st) >= 0;
    if (dead) continue;                                   // dead business is in neither bucket
    const issued = INFORCE.indexOf(st) >= 0;

    /* The date that places this policy in a period. Issued business is dated by WHEN IT PAID,
       because that is the month the money belongs to; pending business by when it was written.
       Falling back to first_draft_date matches leaderboard-api and places 14 more paid
       policies in a real period; without it they were simply missing from every month. The
       payout date is still what is REPORTED as missing, because that is the record Operations
       needs to complete. */
    const when = issued ? (p.paid_out_date || p.first_draft_date) : p.submitted_date;
    if (issued && !p.paid_out_date) gaps.paid_no_date++;
    if (issued && !p.paid_out_date && !p.first_draft_date) gaps.paid_undatable++;
    const bucket = bucketOf(when, period);

    const ap = numOr(p.annual_premium);
    const isSplit = !!p.split_flag;
    const wShare = isSplit ? (p.split_pct != null && p.split_pct !== "" ? numOr(p.split_pct) : 50) / 100 : 1;

    // ---- the writing agent's side
    const wRate = (p.contract_pct != null) ? numOr(p.contract_pct) : rateOf(p.agent_code);
    if (wRate == null) gaps.no_writer_rate++;
    sides.push({
      base: baseOf(p.agent_code), agent: norm(p.agent_code),
      points: wRate == null ? null : ap * wShare * (wRate / 100),
      ap: ap * wShare, client: surname(p.client_name),
      state: issued ? "issued" : "pending", bucket, priced: wRate != null,
    });

    // ---- the partner's side, priced at the PARTNER's own rate
    if (isSplit) {
      if (!p.split_agent_code) { gaps.split_no_partner_code++; continue; }
      const pRate = (p.partner_contract_pct != null) ? numOr(p.partner_contract_pct) : rateOf(p.split_agent_code);
      if (pRate == null) gaps.split_no_partner_rate++;
      sides.push({
        base: baseOf(p.split_agent_code), agent: norm(p.split_agent_code),
        points: pRate == null ? null : ap * (1 - wShare) * (pRate / 100),
        ap: ap * (1 - wShare), client: surname(p.client_name),
        state: issued ? "issued" : "pending", bucket, priced: pRate != null,
      });
    }
  }

  /* ---------------------------------------------------------------- roll it up ------ */
  type Cell = { pending_points: number; issued_points: number; pending_ap: number; issued_ap: number;
                pending_count: number; issued_count: number; families: Set<string>; unpriced: number };
  const mk = (): Cell => ({ pending_points: 0, issued_points: 0, pending_ap: 0, issued_ap: 0, pending_count: 0, issued_count: 0, families: new Set(), unpriced: 0 });
  const add = (c: Cell, s: Side) => {
    if (s.state === "issued") { c.issued_points += s.points || 0; c.issued_ap += s.ap; c.issued_count++; if (s.client) c.families.add(s.client); }
    else { c.pending_points += s.points || 0; c.pending_ap += s.ap; c.pending_count++; }
    if (!s.priced) c.unpriced++;
  };

  /* Each agent's own commission, paid out. Built from the same sides as everything else, so
     a split partner is credited their own half at their own rate and nobody is counted twice.
     Deliberately computed BEFORE baseshop scoping: a person's earnings are their own whoever
     is looking at the report. */
  const paidCommOf: Record<string, number> = {};
  for (const s of sides) {
    if (s.state !== "issued" || !s.agent) continue;
    paidCommOf[s.agent] = (paidCommOf[s.agent] || 0) + (s.points || 0);
  }

  const byBase: Record<string, Cell> = {};
  const byPeriod: Record<string, Cell> = {};
  const byPeriodBase: Record<string, Record<string, Cell>> = {};
  const all = mk();

  for (const s of sides) {
    if (!inScope(s.base)) continue;
    add(all, s);
    if (!byBase[s.base]) byBase[s.base] = mk();
    add(byBase[s.base], s);
    if (!s.bucket) continue;                               // cannot be placed in a period
    if (!byPeriod[s.bucket]) byPeriod[s.bucket] = mk();
    add(byPeriod[s.bucket], s);
    if (!byPeriodBase[s.bucket]) byPeriodBase[s.bucket] = {};
    if (!byPeriodBase[s.bucket][s.base]) byPeriodBase[s.bucket][s.base] = mk();
    add(byPeriodBase[s.bucket][s.base], s);
  }

  /* ------------------------------------------------------------------ licensing ---- */
  type Lic = { roster: number; here: number; left: number; licensed: number; licensed_here: number; working: number; not_started: number; net_licensed: number; net_licensed_here: number };
  const licMk = (): Lic => ({ roster: 0, here: 0, left: 0, licensed: 0, licensed_here: 0, working: 0, not_started: 0, net_licensed: 0, net_licensed_here: 0 });
  const licAll = licMk(); const licBase: Record<string, Lic> = {};
  for (const a of agents) {
    if (a.system_account) continue;                        // bots and service rows are not people
    const base = a.baseshop || "—";
    if (!inScope(base)) continue;
    const L = licBase[base] = licBase[base] || licMk();
    const gone = hasLeft(a), stage = licStage(a.license_status);
    for (const c of [licAll, L]) {
      c.roster++;
      if (gone) c.left++; else c.here++;
      if (stage === "licensed") {
        c.licensed++; if (!gone) c.licensed_here++;
        /* A NET licence: licensed AND has actually earned. */
        if ((paidCommOf[norm(a.code)] || 0) >= NET_LICENSE_MIN) { c.net_licensed++; if (!gone) c.net_licensed_here++; }
      }
      else if (stage === "working") c.working++;
      else c.not_started++;
    }
  }
  const ratios = (c: Lic) => ({
    ...c,
    net_min: NET_LICENSE_MIN,
    all_ratio: c.roster ? r2(c.licensed * 100 / c.roster) : 0,              // licensed, of everyone ever brought in
    net_ratio: c.roster ? r2(c.net_licensed * 100 / c.roster) : 0,          // licensed AND earning, of the same
    /* Kept alongside because it answers a different and also useful question: how much of the
       roster standing TODAY can write. It is not the net licensing ratio. */
    licensed_here_ratio: c.here ? r2(c.licensed_here * 100 / c.here) : 0,
  });

  /* ------------------------------------------------- the records behind the gaps ---- */
  /* v5. The gaps block above counts faults; this names them. Without the names a report
     says "41 policies have no payout date" every month and nobody can act on it, because
     nobody knows which 41. Severity 1 is wrong money or wrong headcount right now.
     Unscoped counts (a fault is a fault), scoped list (only rows this viewer can fix). */
  const dq = await getJSON(`data_quality_issues?select=severity,issue,kind,ref,who,subject,money,detail&order=severity.asc,issue.asc&limit=1000`);
  const dqCount: Record<string, { rows: number; premium: number; severity: number }> = {};
  for (const d of dq) {
    const k = String(d.issue);
    if (!dqCount[k]) dqCount[k] = { rows: 0, premium: 0, severity: Number(d.severity) };
    dqCount[k].rows++; dqCount[k].premium += numOr(d.money);
  }
  /* A policy row's `subject` is the client; an agent row's is their baseshop. Only the agent
     rows can be shop-filtered reliably, so policy rows are shown to anyone who can see the
     report and agent rows are filtered. Erring toward showing a fault is deliberate: the cost
     of a hidden one is a wrong report, the cost of an extra one is a glance. */
  const dqList = dq.filter((d: any) => d.kind !== "agent" || inScope(d.subject));

  /* ---------------------------------------------------------------- shape the answer */
  const cell = (c: Cell) => ({
    pending_points: Math.round(c.pending_points), issued_points: Math.round(c.issued_points),
    pending_ap: Math.round(c.pending_ap), issued_ap: Math.round(c.issued_ap),
    pending_count: c.pending_count, issued_count: c.issued_count,
    families: c.families.size, unpriced: c.unpriced,
    /* Of the business written, how much actually paid. The single most telling ratio an
       agency has, and it comes free from the same two numbers. */
    placement: (c.pending_count + c.issued_count) ? r2(c.issued_count * 100 / (c.pending_count + c.issued_count)) : 0,
  });

  const buckets = Object.keys(byPeriod).sort().reverse();
  const limit = Math.max(1, Math.min(60, Number(body.limit) || 24));

  return json({
    ok: true, role: az.role, period, scoped,
    generated_at: new Date().toISOString(),
    totals: cell(all),
    /* Every baseshop that has EITHER business or people. Keying off business alone hid SCAPED
       entirely - two people, both licensed, no policies yet - so a shop could have a licensing
       ratio that no report would ever show. A shop with people and no business is exactly the
       one a leader needs to see. */
    by_base: Array.from(new Set([...Object.keys(byBase), ...Object.keys(licBase)])).sort()
      .map((b) => ({ baseshop: b, ...cell(byBase[b] || mk()), licensing: ratios(licBase[b] || licMk()) })),
    periods: buckets.slice(0, limit).map((b) => ({
      key: b, label: labelOf(b, period), ...cell(byPeriod[b]),
      by_base: Object.keys(byPeriodBase[b] || {}).sort().map((x) => ({ baseshop: x, ...cell(byPeriodBase[b][x]) })),
    })),
    licensing: ratios(licAll),
    gaps,
    data_quality: {
      total: dq.length,
      blocking: dq.filter((d: any) => Number(d.severity) === 1).length,
      by_issue: Object.keys(dqCount).sort((a, b) => (dqCount[a].severity - dqCount[b].severity) || (dqCount[b].rows - dqCount[a].rows))
        .map((k) => ({ issue: k, severity: dqCount[k].severity, rows: dqCount[k].rows, premium: Math.round(dqCount[k].premium) })),
      items: dqList.slice(0, 300),
    },
    notes: {
      points: "A point is a commission dollar: premium x your share of the policy x your own contract rate. Every side of a split is credited to that agent's own baseshop.",
      pending: "Written and still working through underwriting, dated by the day it was submitted. Not money yet.",
      issued: "Paid out by the carrier, dated by the day it paid - not the day it was sold.",
      families: "One household is one surname, counted once however many policies or agents were involved.",
      all_ratio: "Licensed, divided by everyone ever brought in - including those who have left.",
      net_ratio: "A NET licence is licensed AND $1,000 or more in commission actually paid out. Divided by everyone ever brought in, so it sits on the same base as the ALL ratio and the two read as one funnel.",
      licensed_here_ratio: "Licensed and still here, divided by everyone still here - how much of today's roster can write. Not the net licensing ratio.",
      placement: "Of the business written, the share that actually paid.",
      data_quality: "Records the ledger cannot state correctly. Severity 1 is money or headcount that is wrong right now; 2 and 3 are records that cannot be dated or priced. Fixing one here changes the numbers above.",
    },
  });
});
