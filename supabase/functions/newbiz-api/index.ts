// newbiz-api v22 (2026-10-20) — numOr() no longer turns an explicit null into 0. See its note.
// newbiz-api v21 (2026-10-20) — newbiz_update NO LONGER BLANKS COLUMNS IT WAS NOT SENT.
//      It built a complete row via mapRow() and PATCHed all of it, so any caller sending a
//      partial payload wiped every column it omitted — including a split partner's share and
//      paid_out_date. See the block comment on newbiz_update. v15 fixed this for one column;
//      this fixes it for all of them.
// newbiz-api v20 — policies CRUD + summary + goals. v13: goals are MONTH-SCOPED (keyed by YYYY-MM).
// v14 (2026-09-03): every admin check goes through ops_authorize instead of the literal "2026",
//      which shipped inside newbusiness.html and ops.html. This endpoint reads, edits and DELETES
//      the policy ledger, so the shared string was the only thing standing between the public and
//      the whole book of business. Resolved once per request — the token may arrive in the body or
//      the query string, and both paths are now authorised the same way.
// v15 (2026-09-04): STOP RE-STAMPING submitted_date. mapRow() defaulted it to today and mapRow is
//      used by newbiz_update as well as newbiz_add, and the form never sent the field — so EVERY
//      EDIT silently moved a policy's submitted date to the day it was edited. Now the date is
//      only defaulted when creating, and an update never touches it unless one is supplied.
// v18 (2026-09-07): LEADERS NOW SEE THEIR WHOLE ORG, NOT ONE LEVEL DOWN. The "leader" filter
//      matched the denormalised md/emd NAME columns, which only ever name the agent's immediate
//      leader, so business two or more levels down was invisible (Elijah -> Seale -> Gage). Scope
//      is resolved through the real org tree by nb_scope(), and the hierarchy ROOT sees every
//      policy with no filter at all.
// v19 (2026-09-07): A SPLIT PARTNER'S RATE IS NO LONGER BORROWED FROM THE WRITER. When
//      partner_contract_pct was empty this code fell back to the WRITER's contract rate, so a
//      partner appeared to earn at a level they do not hold — Todd Doyle was being credited at
//      Christopher's 60% instead of his own 50%, reading $11,658 where the truth was $10,108. The
//      leaderboard meanwhile treated the same empty field as ZERO, so the two screens disagreed on
//      the same policy. Now: the partner's rate is resolved from their contract level (the
//      official map in app_settings.contract_rates) at the moment a policy is SAVED, and the
//      read-time fallback is 0 rather than someone else's rate, so a gap can never again quietly
//      inflate a number. expected_commission is recomputed from the resolved rate.
//
// v20 (2026-09-30) — WHO IS ASKING. v14 fixed the Operations token and then left every ordinary
//      caller identified by a typed `code`, which is printed on the org chart. On a ledger holding
//      client names, phones, emails, dates of birth and commission figures that meant:
//        · newbiz_list / newbiz_summary with a colleague's code returned their whole book;
//        · newbiz_add wrote a policy in somebody else's name;
//        · newbiz_update edited any policy that code writes or partners on;
//        · newbiz_delete destroyed their policies;
//        · goals_set took a typed NAME in `by`, so typing "Elijah Cox" set COMPANY goals.
//      Plus a filter bug with nothing to do with identity: newbiz_setstatus only applied its
//      ownership filter `if (!isAdmin && code)` — so OMITTING the code applied no filter at all
//      and let anyone set the status of any policy in the company.
//      Identity is now the session token minted at PIN entry, or an Operations token. A `leader`
//      book must be the caller's own, or someone above them in the org tree — which keeps the
//      Personal / Team / Baseshop / Hierarchy views working exactly as they do now, while
//      stopping anyone asking for an unrelated leader's book.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const COMPANY_OWNER = "elijah cox";
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
function json(o: unknown, status = 200) { return new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } }); }
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const clean = (s: unknown) => (s ?? "").toString().trim().slice(0, 400);
const low = (s: unknown) => (s ?? "").toString().trim().toLowerCase();
/* Number(null) and Number("") are both 0, so numOr(null, null) used to answer 0 rather than
   null. The moment a caller started sending the record back as stored, every numeric column
   that was legitimately empty came back as a zero — monthly_contribution and
   lump_sum_contribution on a life policy, and on an annuity those are the contribution
   figures themselves. An absent, null or blank value means "no value", not zero. */
const numOr = (v: unknown, d: number | null = null) => { if (v === null || v === undefined || v === "") return d; const n = Number(v); return isNaN(n) ? d : n; };
const pctOf = (v: unknown) => { const n = Number(v); return isNaN(n) ? 50 : Math.max(0, Math.min(100, n)); };
function ptToday(): string { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date()); }
const squash = (s: unknown) => (s ?? "").toString().toLowerCase().replace(/[^a-z]/g, "");
async function rpc(fn: string, args: Record<string, unknown>) { try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); return await r.json(); } catch (_) { return null; } }
async function opsAuthorized(token: unknown) { const t = String(token ?? ""); if (!t) return false; const r = await rpc("ops_authorize", { p_token: t }); return !!(r && r.ok); }

/* ===== WHO IS CALLING — a session token is proof, a typed code is not. ===== */
type Caller = { code: string; name: string; ops: boolean };
async function whoIsCalling(body: Record<string, unknown>, q: URLSearchParams, isAdmin: boolean): Promise<Caller> {
  if (isAdmin) return { code: "", name: "Operations", ops: true };
  const s = ((body.session ?? q.get("session")) ?? "").toString().trim().slice(0, 120);
  if (!s) return { code: "", name: "", ops: false };
  const got = await rpc("agent_session_code", { p_token: s });
  const code = (typeof got === "string") ? norm(got) : "";
  if (!code) return { code: "", name: "", ops: false };
  let name = "";
  try {
    const ex = await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${encodeURIComponent(code)}&select=first_name,last_name&limit=1`, { headers: DBH });
    const a = ((await ex.json()) || [])[0];
    if (a) name = (((a.first_name as string) || "") + " " + ((a.last_name as string) || "")).trim();
  } catch (_) { /* noop */ }
  return { code, name, ops: false };
}
function needSession() { return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401); }

/* Every name at or above this person in the org tree: themselves, their upline chain by direct_to,
   and the md/emd names stamped on their own row as a backstop. A `leader` book is only theirs to
   ask for if the leader is one of these — which is exactly what the Personal / Team / Baseshop /
   Hierarchy views already request, and nothing more. */
async function uplineNames(code: string): Promise<Set<string>> {
  const out = new Set<string>();
  if (!code) return out;
  try {
    const ex = await fetch(`${SUPA}/rest/v1/tracker_agents?select=code,first_name,last_name,direct_to,md,emd&limit=5000`, { headers: DBH });
    const rows: Record<string, unknown>[] = (await ex.json()) || [];
    const byCode: Record<string, Record<string, unknown>> = {};
    for (const r of rows) byCode[norm(r.code)] = r;
    let cur = byCode[norm(code)]; let hops = 0;
    while (cur && hops++ < 40) {
      const nm = low((((cur.first_name as string) || "") + " " + ((cur.last_name as string) || "")).trim());
      if (nm) out.add(nm);
      if (low(cur.md)) out.add(low(cur.md));
      if (low(cur.emd)) out.add(low(cur.emd));
      const up = norm(cur.direct_to);
      if (!up || up === norm(cur.code)) break;
      cur = byCode[up];
    }
  } catch (_) { /* noop */ }
  return out;
}

// The rate an agent earns, from their contract level. Used to fill a split partner's rate at save
// time so the field is never left empty for something downstream to guess at.
async function rateForCode(code: string): Promise<number | null> {
  if (!code) return null;
  const r = await rpc("contract_rate_for_code", { p_code: code });
  const n = Number(r);
  return (r === null || r === undefined || isNaN(n)) ? null : n;
}

// Expected commission, always computed from the rate actually on the record. A missing partner
// rate contributes nothing — it must never inherit the writer's rate.
function expCommOf(row: Record<string, unknown>): number | null {
  const prem = Number(row.annual_premium) || 0;
  const contract = (row.contract_pct != null) ? Number(row.contract_pct) : null;
  if (contract == null || isNaN(contract)) return null;
  if (row.split_flag && row.split_pct != null) {
    const sp = Number(row.split_pct);
    const pr = (row.partner_contract_pct != null) ? Number(row.partner_contract_pct) : 0;
    return Math.round(prem * (sp / 100) * (contract / 100)) + Math.round(prem * ((100 - sp) / 100) * (pr / 100));
  }
  return Math.round(prem * (contract / 100));
}

// ---- month-scoped goals helpers ----
const GOAL_KEYS = ["partners", "premium", "fta", "families"];
function monthPick(obj: any, month: string): Record<string, unknown> {
  if (!obj || typeof obj !== "object") return {};
  if (month && obj[month] && typeof obj[month] === "object") return obj[month];
  const flat: Record<string, unknown> = {}; let any = false;
  for (const k of GOAL_KEYS) if (k in obj) { flat[k] = obj[k]; any = true; }
  return any ? flat : {};
}
function ensureMonth(container: any, month: string): Record<string, unknown> {
  if (!month) return container;
  if (!container[month] || typeof container[month] !== "object") {
    const legacy: Record<string, unknown> = {}; for (const k of GOAL_KEYS) if (k in container) legacy[k] = container[k];
    container[month] = legacy;
  }
  return container[month];
}

async function getAgent(code: string) {
  const ex = await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${encodeURIComponent(code)}&select=first_name,last_name,emd,md,status`, { headers: DBH });
  const rows = await ex.json();
  return rows && rows[0] ? rows[0] : null;
}

let ROSTER: Record<string, unknown>[] | null = null;
async function roster(): Promise<Record<string, unknown>[]> {
  if (ROSTER) return ROSTER;
  try { const ex = await fetch(`${SUPA}/rest/v1/tracker_agents?select=code,first_name,last_name`, { headers: DBH }); ROSTER = (await ex.json()) || []; } catch (_) { ROSTER = []; }
  return ROSTER!;
}
async function resolveSplitCode(name: string): Promise<string> {
  const raw = (name ?? "").toString().trim(); const up = raw.toUpperCase();
  const list = await roster();
  if (up) { const byCode = list.find((a) => String(a.code).toUpperCase() === up); if (byCode) return String(byCode.code); }
  const n = squash(name); if (!n) return "";
  for (const a of list) { if (squash((a.first_name || "") + (a.last_name || "")) === n) return String(a.code); }
  const byLast = list.filter((a) => squash(a.last_name) && n.indexOf(squash(a.last_name)) >= 0);
  if (byLast.length === 1) return String(byLast[0].code);
  return "";
}
async function nameOfCode(code: string): Promise<string> {
  if (!code) return ""; const list = await roster();
  const a = list.find((x) => norm(x.code) === norm(code));
  return a ? (((a.first_name || "") + " " + (a.last_name || "")).trim()) : "";
}

// Who does this leader's book include? Walks the org tree instead of trusting the one-level md/emd
// names stamped on each policy. Returns null when the name cannot be resolved, so the caller can
// fall back to the legacy filter.
async function leaderScope(leader: string): Promise<{ root: boolean; codes: string[] } | null> {
  const r = await rpc("nb_scope", { p_leader: leader });
  if (!r || typeof r !== "object" || !(r as Record<string, unknown>).found) return null;
  const o = r as Record<string, unknown>;
  const codes = Array.isArray(o.codes) ? (o.codes as unknown[]).map((c) => String(c ?? "").trim()).filter((c) => /^[A-Za-z0-9_.-]+$/.test(c)) : [];
  return { root: !!o.root, codes };
}

async function orgByRole(role: string): Promise<string[]> {
  try {
    const ex = await fetch(`${SUPA}/rest/v1/app_settings?key=eq.org_structure&select=value`, { headers: DBH });
    const rws = await ex.json();
    const val = rws && rws[0] ? rws[0].value : null;
    if (val && Array.isArray(val.nodes)) return (val.nodes as Record<string, unknown>[]).filter((n) => n && n.role === role).map((n) => low(n.name));
  } catch (_) { /* noop */ }
  return [];
}
const orgExecs = () => orgByRole("exec");

const ISSUED = ["policy_issued","premium_drafted","paid","funds_received"];
function bucket(s: string) { if (s === "closed" || s === "declined" || s === "cancelled") return "closed"; if (s === "approved") return "approved"; if (ISSUED.indexOf(s) >= 0) return "paid"; return "pending"; }
function dnum(v: unknown) { const n = Number(v); return isNaN(n) ? 0 : n; }

function mapRow(body: Record<string, unknown>) {
  const prem = numOr(body.annual_premium, 0) || 0;
  const contract = numOr(body.contract_pct, null);
  const advance = numOr(body.advance_pct, null);
  const splitFlag = !!body.split_flag;
  const splitPct = splitFlag ? pctOf(body.split_pct) : null;
  const partnerContract = numOr(body.partner_contract_pct, null);
  const st = clean(body.status).toLowerCase().replace(/\s+/g, "_") || "pending";
  const row: Record<string, unknown> = {
    client_name: clean(body.client_name), phone: clean(body.phone), email: clean(body.email),
    gender: clean(body.gender), dob: clean(body.dob) || null, source: clean(body.source),
    business_type: (clean(body.business_type).toLowerCase() === "annuity" ? "annuity" : "life"),
    status: st, stage: clean(body.stage),
    writing_off: !!body.writing_off, split_flag: splitFlag, split_agent: clean(body.split_agent),
    split_pct: splitPct, partner_contract_pct: (splitFlag ? partnerContract : null),
    state: clean(body.state).toUpperCase().slice(0, 2), carrier: clean(body.carrier), product: clean(body.product),
    policy_number: clean(body.policy_number), carrier_code: clean(body.carrier_code),
    coverage: numOr(body.coverage, 0) || 0, annual_premium: prem,
    monthly_contribution: numOr(body.monthly_contribution, null), lump_sum_contribution: numOr(body.lump_sum_contribution, null),
    /* Target premium (handoff 2026-10-23 section 6B): manually entered, saved independently of
       annual_premium, monthly_contribution and lump_sum_contribution, and never derived from
       them. null when not provided, which the brief requires to stay distinct from an entered 0.
       It has to be named HERE and nowhere else: newbiz_add inserts exactly what mapRow returns,
       and newbiz_update builds its patch with
           for (const k of sent) if (hasOwnProperty.call(full, k)) patch[k] = full[k]
       where full = mapRow(merged) -- so a column mapRow does not know is dropped from BOTH
       paths. Measured before this line existed: newbiz_update with target_premium returned
       ok:true, bumped updated_at, and left the column NULL. A silent discard that reported
       success. */
    target_premium: numOr(body.target_premium, null),
    contract_pct: contract, advance_pct: advance,
    // expected_commission is set after the partner's rate is resolved — see finishRow()
    expected_commission: null,
    date_written: clean(body.date_written) || null, first_draft_date: clean(body.first_draft_date) || null,
    // NOT defaulted to today here — see v15 note. The caller decides.
    submitted_date: clean(body.submitted_date) || null, notes: clean(body.notes),
    paid_out_date: clean(body.paid_out_date) || null,
    chargeback_type: clean(body.chargeback_type) || null,
    chargeback_amount: numOr(body.chargeback_amount, null),
    chargeback_date: clean(body.chargeback_date) || null,
    chargeback_note: clean(body.chargeback_note) || null,
    trailing_months: numOr(body.trailing_months, null),
    trailing_status: clean(body.trailing_status) || null,
    trailing_paid_at: clean(body.trailing_paid_at) || null,
    suitability_ok: !!body.suitability_ok
  };
  return row;
}

// Resolve the split partner (code + display name), fill their commission rate from their contract
// level when the form did not supply one, then compute expected_commission from what we ended up
// with. Shared by create and update so the two can never drift.
async function finishRow(row: Record<string, unknown>) {
  row.split_agent_code = row.split_flag ? await resolveSplitCode(String(row.split_agent || "")) : "";
  if (row.split_flag && row.split_agent_code) {
    const rn = await nameOfCode(String(row.split_agent_code));
    if (rn) row.split_agent = rn;
    if (row.partner_contract_pct == null) {
      const r = await rateForCode(String(row.split_agent_code));
      if (r != null) row.partner_contract_pct = r;
    }
  }
  row.expected_commission = expCommOf(row);
  return row;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = new URL(req.url);
    let body: Record<string, unknown> = {};
    if (req.method === "POST") body = await req.json().catch(() => ({}));
    const action = (body.action as string) || url.searchParams.get("action") || "";
    // one authorisation for the whole request — the token can arrive either way
    const rawToken = (body.token as string) || url.searchParams.get("token") || "";
    const isAdmin = await opsAuthorized(rawToken);

    const me = await whoIsCalling(body, url.searchParams, isAdmin);
    if (!me.ops && !me.code) return needSession();
    // Whose ledger this is. Operations may act for a named agent; everybody else is themselves.
    const myCode = me.ops ? norm(body.code || url.searchParams.get("code")) : me.code;

    if (action === "newbiz_add") {
      const code = myCode;
      if (!code) return json({ ok: false, error: "no code" });
      const a = await getAgent(code);
      const nm = a ? (((a.first_name || "") + " " + (a.last_name || "")).trim()) : clean(body.agent_name);
      const row = mapRow(body);
      // Only a NEW policy falls back to today, and only when nothing was supplied.
      if (!row.submitted_date) row.submitted_date = ptToday();
      row.agent_code = code; row.agent_name = nm; row.emd = a ? clean(a.emd) : ""; row.md = a ? clean(a.md) : "";
      await finishRow(row);
      const ins = await fetch(`${SUPA}/rest/v1/policies`, { method: "POST", headers: { ...DBH, Prefer: "return=representation" }, body: JSON.stringify(row) });
      const r = await ins.json();
      return json({ ok: ins.ok, policy: Array.isArray(r) ? r[0] : r });
    }

    if (action === "newbiz_update") {
      const id = clean(body.id);
      if (!id) return json({ ok: false, error: "no id" });

      /* v21 — A PARTIAL PAYLOAD MUST NOT BLANK THE REST OF THE ROW.
         mapRow() builds a COMPLETE policy row with a default for every column, and this
         handed that straight to PATCH. Every column the caller did not send was therefore
         overwritten with its default: the split partner and both split percentages, the
         advance %, the carrier code, the date of birth, the notes, paid_out_date (which is
         what in-force reporting reads), and the whole chargeback/trailing block. The New
         Business edit form sends 17 of ~45 columns, so saving an untouched edit erased a
         real agent's share of a real policy. v15 had already fixed exactly this for
         submitted_date alone — the other thirty-odd columns had the same hole.

         Now: overlay what was sent onto the row AS STORED, map the whole merged record so
         the derived values are computed from a complete policy rather than a fragment, then
         write back ONLY the columns the caller actually named. A caller that sends a full
         row behaves exactly as before. */
      const curEx = await fetch(`${SUPA}/rest/v1/policies?id=eq.${encodeURIComponent(id)}&select=*`, { headers: DBH });
      const curRows = (await curEx.json()) || [];
      const current: Record<string, unknown> | undefined = Array.isArray(curRows) ? curRows[0] : undefined;
      if (!current) return json({ ok: false, error: "That policy no longer exists." }, 404);

      /* Keys that address the request rather than the record, and must never be written. */
      const ENVELOPE = ["action", "id", "token", "session", "code", "by", "leader", "month", "goals", "scope"];
      const sent = Object.keys(body).filter((k) => ENVELOPE.indexOf(k) < 0);

      const merged: Record<string, unknown> = { ...current };
      for (const k of sent) merged[k] = body[k];
      const full = mapRow(merged);
      await finishRow(full);

      /* Only what was named. Anything mapRow invents for an absent column is discarded here,
         which is the whole point. Unknown keys (an agent_code, a read-time extra like
         my_commission) simply do not exist on `full` and are dropped. */
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      for (const k of sent) if (Object.prototype.hasOwnProperty.call(full, k)) patch[k] = full[k];

      /* Derived columns follow their inputs, never the caller. expected_commission is not the
         caller's to state, and changing split_flag has to clear or fill the columns hanging
         off it even when those were not mentioned — otherwise turning a split off would leave
         a stale partner percentage behind. */
      const SPLIT_INPUTS = ["split_flag", "split_agent", "split_pct", "partner_contract_pct"];
      const touchedSplit = SPLIT_INPUTS.some((k) => sent.indexOf(k) >= 0);
      if (touchedSplit) {
        patch.split_flag = full.split_flag;
        patch.split_agent = full.split_agent;
        patch.split_agent_code = full.split_agent_code;
        patch.split_pct = full.split_pct;
        patch.partner_contract_pct = full.partner_contract_pct;
      }
      if (touchedSplit || sent.indexOf("annual_premium") >= 0 || sent.indexOf("contract_pct") >= 0) {
        patch.expected_commission = full.expected_commission;
      }

      // a split partner may edit shared fields too, so allow writer OR partner (or Operations)
      let q = `${SUPA}/rest/v1/policies?id=eq.${encodeURIComponent(id)}`;
      if (!isAdmin) { const c = encodeURIComponent(me.code); q += `&or=(agent_code.eq.${c},split_agent_code.eq.${c})`; }
      const up = await fetch(q, { method: "PATCH", headers: { ...DBH, Prefer: "return=representation" }, body: JSON.stringify(patch) });
      const r = await up.json();
      const saved = Array.isArray(r) ? r[0] : r;
      if (up.ok && !saved) return json({ ok: false, error: "That policy is not yours to edit." }, 403);
      return json({ ok: up.ok, policy: saved, changed: Object.keys(patch).filter((k) => k !== "updated_at") });
    }

    if (action === "newbiz_list" || action === "newbiz_summary") {
      const leader = clean(body.leader || url.searchParams.get("leader"));
      const bt = clean(body.business_type || url.searchParams.get("business_type")).toLowerCase();
      const since = clean(body.since || url.searchParams.get("since"));
      const isList = action === "newbiz_list";
      // For an ordinary caller the only book they can name is their own, or one belonging to
      // somebody above them in the org tree. Anything else falls back to their own book rather
      // than erroring, so a stale screen degrades quietly instead of breaking.
      let useLeader = "";
      if (leader) {
        if (me.ops) useLeader = leader;
        else {
          const ups = await uplineNames(me.code);
          if (ups.has(low(leader))) useLeader = leader;
        }
      }
      // `code` is only ever the caller's own from here on.
      const code = (me.ops && !leader) ? myCode : (me.ops ? "" : (useLeader ? "" : me.code));
      let q = `${SUPA}/rest/v1/policies?select=*&order=submitted_date.desc,created_at.desc`;
      if (useLeader) {
        const sc = await leaderScope(useLeader);
        if (sc && sc.root) { /* hierarchy lead — the entire book, nothing filtered out */ }
        else if (sc && sc.codes.length) {
          const inList = sc.codes.map((c) => `"${c}"`).join(",");
          q += `&or=(agent_code.in.(${inList}),split_agent_code.in.(${inList}))`;
        } else { const L = encodeURIComponent(useLeader); q += `&or=(md.eq.${L},emd.eq.${L})`; }
      }
      else if (code) { q += `&or=(agent_code.eq.${encodeURIComponent(code)},split_agent_code.eq.${encodeURIComponent(code)})`; }
      else if (!me.ops) { q += `&or=(agent_code.eq.${encodeURIComponent(me.code)},split_agent_code.eq.${encodeURIComponent(me.code)})`; }
      /* Operations with no code and no leader: the whole ledger, as before. */
      if (bt === "life" || bt === "annuity") q += `&business_type=eq.${bt}`;
      if (since) q += `&submitted_date=gte.${encodeURIComponent(since)}`;
      const ex = await fetch(q, { headers: DBH });
      const rows: Record<string, unknown>[] = (await ex.json()) || [];
      for (const r of rows) {
        const isWriter = code ? norm(r.agent_code) === code : true;
        const isPartner = code ? norm(r.split_agent_code) === code : false;
        const sp = (r.split_flag && r.split_pct != null) ? Number(r.split_pct) : 100;
        const share = (code && isPartner && !isWriter) ? (100 - sp) : (code ? (r.split_flag ? sp : 100) : 100);
        (r as Record<string, unknown>)._share = share / 100;
        (r as Record<string, unknown>).split_role = (code && isPartner && !isWriter) ? "received" : (r.split_flag ? "given" : "");
        (r as Record<string, unknown>).my_share_pct = r.split_flag ? share : 100;
        (r as Record<string, unknown>).my_ap = Math.round((dnum(r.annual_premium)) * (share / 100));
        const prem = dnum(r.annual_premium);
        const wRate = (r.contract_pct != null) ? Number(r.contract_pct) : null;
        // A missing partner rate is worth NOTHING here. It must never inherit the writer's rate:
        // that credited partners at a contract level they do not hold (see the v19 note).
        const pRate = (r.partner_contract_pct != null) ? Number(r.partner_contract_pct) : 0;
        const writerPart = (wRate != null) ? Math.round(prem * (sp / 100) * (wRate / 100)) : 0;
        const partnerPart = r.split_flag ? Math.round(prem * ((100 - sp) / 100) * (pRate / 100)) : 0;
        const fullComm = r.split_flag ? (writerPart + partnerPart) : ((wRate != null) ? Math.round(prem * (wRate / 100)) : 0);
        (r as Record<string, unknown>).my_commission = (code && isPartner && !isWriter) ? partnerPart : (code ? (r.split_flag ? writerPart : fullComm) : fullComm);
        (r as Record<string, unknown>).partner_pct = r.split_flag ? (100 - Number(r.split_pct != null ? r.split_pct : 50)) : null;
        (r as Record<string, unknown>).partner_contract_pct = (r.partner_contract_pct != null) ? Number(r.partner_contract_pct) : null;
      }
      if (isList) return json({ ok: true, count: rows.length, scope: useLeader || code || "all", policies: rows });
      const wsum = (arr: Record<string, unknown>[], k: string) => arr.reduce((t, r) => t + dnum(r[k]) * (Number(r._share) || 1), 0);
      const msum = (arr: Record<string, unknown>[]) => arr.reduce((t, r) => t + dnum(r.my_commission), 0);
      const inB = (b: string) => rows.filter((r) => bucket(r.status as string) === b);
      const openR = rows.filter((r) => bucket(r.status as string) !== "closed");
      const paid = inB("paid");
      const out = {
        total: rows.length,
        counts: { submitted: openR.length, pending: inB("pending").length, approved: inB("approved").length, paid: paid.length, closed: inB("closed").length, active: inB("pending").length + inB("approved").length },
        ap_submitted: wsum(openR, "annual_premium"), ap_pending: wsum(inB("pending"), "annual_premium"),
        ap_approved: wsum(inB("approved"), "annual_premium"), ap_paid: wsum(paid, "annual_premium"),
        ap_closed: wsum(inB("closed"), "annual_premium"), total_coverage: wsum(openR, "coverage"),
        commission_total: msum(openR), commission_paid: msum(paid),
        deposits_count: paid.length, deposits_ap: wsum(paid, "annual_premium"), deposits_commission: msum(paid),
        chargeback_total: wsum(rows, "chargeback_amount"),
        net_deposits: msum(paid) - wsum(rows, "chargeback_amount")
      };
      return json({ ok: true, summary: out });
    }

    if (action === "newbiz_setstatus") {
      const id = clean(body.id); const st = clean(body.status).toLowerCase().replace(/\s+/g, "_");
      if (!id || !st) return json({ ok: false, error: "missing id or status" });
      const patch: Record<string, unknown> = { status: st, updated_at: new Date().toISOString() };
      if (typeof body.stage === "string") patch.stage = clean(body.stage);
      if (bucket(st) === "paid") {
        // Record when it went in force, but never overwrite a date already on the record —
        // re-saving the status would otherwise drag the policy into the current month.
        const cur = await fetch(`${SUPA}/rest/v1/policies?id=eq.${encodeURIComponent(id)}&select=paid_out_date`, { headers: DBH });
        const c0 = ((await cur.json()) || [])[0];
        if (!c0 || !c0.paid_out_date) patch.paid_out_date = ptToday();
      }
      let q = `${SUPA}/rest/v1/policies?id=eq.${encodeURIComponent(id)}`;
      // WAS `if (!isAdmin && code)` — omitting the code skipped the filter entirely and let
      // anyone restatus any policy. The filter is now unconditional for a non-Operations caller.
      if (!isAdmin) { const c = encodeURIComponent(me.code); q += `&or=(agent_code.eq.${c},split_agent_code.eq.${c})`; }
      const up = await fetch(q, { method: "PATCH", headers: { ...DBH, Prefer: "return=representation" }, body: JSON.stringify(patch) });
      const r = await up.json();
      if (up.ok && (!Array.isArray(r) || !r.length)) return json({ ok: false, error: "That policy is not yours to change." }, 403);
      return json({ ok: up.ok, id, status: st });
    }

    if (action === "newbiz_delete") {
      const id = clean(body.id);
      if (!id) return json({ ok: false, error: "no id" });
      let q = `${SUPA}/rest/v1/policies?id=eq.${encodeURIComponent(id)}`;
      if (!isAdmin) q += `&agent_code=eq.${encodeURIComponent(me.code)}`;
      const del = await fetch(q + "&select=id", { method: "DELETE", headers: { ...DBH, Prefer: "return=representation" } });
      const gone = await del.json();
      if (!del.ok || !Array.isArray(gone) || !gone.length) return json({ ok: false, error: "That policy is not yours to delete." }, 403);
      return json({ ok: true, id });
    }

    if (action === "goals_get") {
      const code = myCode || me.code;
      const month = clean(body.month || url.searchParams.get("month"));
      const ex = await fetch(`${SUPA}/rest/v1/app_settings?key=eq.goals&select=value`, { headers: DBH });
      const rws = await ex.json();
      const v = (rws && rws[0] && rws[0].value) ? rws[0].value : { personal: {}, shop: {}, company: {} };
      return json({ ok: true, month, personal: monthPick((v.personal && v.personal[code]) || {}, month), shop: monthPick(v.shop || {}, month), company: monthPick(v.company || {}, month) });
    }

    if (action === "goals_set") {
      // `by` used to be a typed NAME, so typing "Elijah Cox" set the COMPANY goals. It is the
      // verified session identity now. (Goals moved to goals-api; this is kept working for any
      // caller still pointed here.)
      const scope = clean(body.scope).toLowerCase();
      const code = myCode || me.code;
      const by = me.ops ? clean(body.by) : me.name;
      const month = clean(body.month);
      const goals = (body.goals && typeof body.goals === "object") ? body.goals as Record<string, unknown> : {};
      const ex = await fetch(`${SUPA}/rest/v1/app_settings?key=eq.goals&select=value`, { headers: DBH });
      const rws = await ex.json();
      const v = (rws && rws[0] && rws[0].value) ? rws[0].value : { personal: {}, shop: {}, company: {} };
      if (!v.personal) v.personal = {}; if (!v.shop) v.shop = {}; if (!v.company) v.company = {};
      if (scope === "shop") {
        let ok = isAdmin;
        if (!ok && by) { const ex2 = await orgExecs(); if (ex2.indexOf(low(by)) >= 0) ok = true; }
        if (!ok) return json({ ok: false, error: "Team goals can only be set by an EMD." }, 401);
        Object.assign(ensureMonth(v.shop, month), goals);
      } else if (scope === "company") {
        const ok = isAdmin || low(by) === COMPANY_OWNER;
        if (!ok) return json({ ok: false, error: "Company goals can only be set by Elijah Cox." }, 401);
        Object.assign(ensureMonth(v.company, month), goals);
      } else { if (!code) return json({ ok: false, error: "no code" }); if (!v.personal[code] || typeof v.personal[code] !== "object") v.personal[code] = {}; Object.assign(ensureMonth(v.personal[code], month), goals); }
      const up = await fetch(`${SUPA}/rest/v1/app_settings?on_conflict=key`, { method: "POST", headers: { ...DBH, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key: "goals", value: v, updated_at: new Date().toISOString() }) });
      return json({ ok: up.ok, scope, month, goals });
    }

    if (action === "opscheck") { return json({ ok: isAdmin }); }

    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
