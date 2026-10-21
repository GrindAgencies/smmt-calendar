// ops-nbfeed v22 — LIVE, TWO-WAY New Business feed.
// v19 (2026-09-14): CLIENT STATE, PHONE AND EMAIL ARE REAL COLUMNS.
//      Christopher: "please show ops the state in which clients are in" and make the board
//      "COPY and Paste friendly. for transferring between tabs." State was never fetched at all,
//      though 136 of 137 policies carry one across 25 states — Operations needs it to know which
//      carrier rules and licence apply. Phone and email were already in each row's payload but
//      were invisible: no column existed, so the values arrived in the browser and were thrown
//      away. All three are now columns, editable like any other, and included in the row copy.
// v12: a baseshop Operations seat only ever RECEIVES its own baseshop's business, enforced
//      on the server rather than hidden in the browser.
// v13 (2026-09-03): the master seat can SHARE a single record with another baseshop's Operations,
//      who then sees it alongside their own. Ownership does not change and the baseshop is not
//      opened up — one record, one direction, revocable.
// v17 (2026-09-08): a policy is always in exactly one of three places — PIPELINE (this board),
//      IN FORCE (the 🟢 In Force tab), or DEAD (the Archived view). In force is NOT archived.
// v18 (2026-09-10): SCOPING NOW COMES FROM ops_scope(), NOT A PRIVATE COPY.
//      This function resolved a seat's baseshops itself while ops-inforce asked ops_scope(). The
//      two drifted, and that is exactly how the leak happened: ops_scope let the shared legacy
//      token "2026" outrank the seat code, so the ELEVATE seat saw the whole company's in-force
//      book while this board was correctly scoped. One source of truth now, so they cannot
//      disagree again — and this board inherits baseshop GROUPS for free, which is what lets
//      SMMT and GRIND act as one shop while GRIND is still pre-emptive.
//
// v20 (2026-10-15) — A TYPED CODE IS NOT A CREDENTIAL. Four sibling functions were corrected
//      earlier today; a sweep of every edge function found this one still open, and it is the
//      worst of the set because the rows carry the client's PHONE AND EMAIL alongside carrier,
//      premium and policy number:
//
//        POST /ops-nbfeed {"code":"<any MD or EMD code>"}
//        -> ok:true, role:"md", the whole live pipeline
//
//      Both routes in asked only for a string anyone can read: a seat code from
//      operations_users, or any agent code whose contract level is MD or above — and every code
//      is printed on the org chart. Now: Operations proves itself with the session token minted
//      at PIN entry, a leader proves themselves with their own signed-in agent session.
//      Baseshop scope, master-seat status and note authorship all read the verified identity
//      instead of a by_code supplied by the caller — passing somebody else's seat code used to
//      decide which baseshops the answer covered.
//
// v21 (2026-10-19) — IN FORCE MEANS THE MONEY LANDED, AND NOTHING ELSE.
//      Christopher: "only change to IN FORCE in the ops tracker once the operations staff
//      specifically lists FUNDS HAVE BEEN PAID OUT."
//      INFORCE had carried four statuses since 2026-09-08. Three of them — Funds Received,
//      Policy Issued, Premium Drafted — all happen BEFORE any payout, so a policy left this
//      board (and Operations' working queue) while there was still work to do on it. In force
//      is now exactly one status: Paid Out. The other three stay in the pipeline where the work
//      is. This list and ops-inforce's MUST agree — a policy belongs to exactly one of the three
//      places, and v18 is the standing reminder of what happens when two copies drift.
//
//      And because the payout date is the record that the money actually landed, marking a
//      policy Paid Out now stamps today's date when none has been set. 41 of the 85 policies
//      already marked paid had no date at all, which is precisely the gap this closes.
//
// v22 (2026-10-19) — THAT STAMP MUST BE THE EASTERN BUSINESS DATE, NOT UTC.
//      v21 shipped the stamp as new Date().toISOString(), which is UTC. Operations works
//      evenings — the session log shows shifts running past midnight UTC — so a payout entered
//      at 9pm Eastern on the 31st would have been dated the 1st and counted in the following
//      month of the production report. Caught the same evening: UTC already read 2026-10-20
//      while the business day was still 2026-10-19.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const KTRACK = "ops_nb_tracking";
const KORDER = "ops_nbfeed_order";
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
function json(o: unknown, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const clean = (s: unknown) => (s ?? "").toString().trim().slice(0, 6000);
const low = (s: unknown) => (s ?? "").toString().trim().toLowerCase();
const has = (v: unknown) => !!(v && String(v).trim());
const numOr = (v: unknown) => { const n = Number(v); return isNaN(n) ? 0 : n; };
const clampPct = (v: unknown) => { const n = Number(String(v).replace(/[%\s]/g, "")); return isNaN(n) ? 50 : Math.max(0, Math.min(100, Math.round(n))); };
const uid = () => crypto.randomUUID().slice(0, 8);
const enc = encodeURIComponent;
const LEADER = /^(md|emd|nvp|sevp|marketing director|executive marketing director|national vice president|senior executive vice president)$/i;

/* The business date this company runs on. Not the server's idea of today. */
const bizToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

/* ---- the three places a policy can be ---- */
const INFORCE = ["paid"];
const DEAD = ["declined", "cancelled", "incomplete", "closed", "lapsed"];
const isInForce = (p: any) => INFORCE.indexOf(low(p.status)) >= 0;
const isDead = (p: any) => DEAD.indexOf(low(p.status)) >= 0;
const isPipeline = (p: any) => !isInForce(p) && !isDead(p);

const STLABEL: Record<string, string> = {
  premium_drafted: "Premium Drafted", contracting_error: "Contracting Error", closed: "Closed", pending_suitability: "Suitability Needed",
  pending: "Pending Underwriting", outstanding_requirements: "Outstanding Requirements", aps: "APS", needs_med_exam: "Needs to Schedule Medical Exam", med_exam_scheduled: "Med Exam Scheduled", policy_delivery: "Policy Delivery", pending_client_signature: "Pending Client Signature", pending_agent_signature: "Pending Agent Signature", policy_issued: "Policy Issued", pending_premium: "Pending Premium", approved: "Approved", declined: "Declined", other: "Other", cancelled: "Cancelled", incomplete: "Incomplete", paid: "Paid Out", suitability_needed: "Suitability Needed", pending_funds_transfer: "Pending Transfer of Funds", funds_received: "Funds Received", lapsed: "Lapsed"
};
const LABEL2CODE: Record<string, string> = {}; for (const k in STLABEL) LABEL2CODE[low(STLABEL[k])] = k;
const STATUS_OPTS = [["Pending Underwriting", "#c99a2e"], ["Outstanding Requirements", "#d64550"], ["APS", "#e07a2f"], ["Needs to Schedule Medical Exam", "#e07a2f"], ["Med Exam Scheduled", "#e07a2f"], ["Policy Delivery", "#1f9c8a"], ["Pending Client Signature", "#c99a2e"], ["Pending Agent Signature", "#c99a2e"], ["Policy Issued", "#1f9c8a"], ["Pending Premium", "#2e86c9"], ["Approved", "#2e86c9"], ["Declined", "#8e8e93"], ["Other", "#8e8e93"], ["Cancelled", "#8e8e93"], ["Incomplete", "#d64550"], ["Paid Out", "#1a9c52"], ["Suitability Needed", "#c99a2e"], ["Pending Transfer of Funds", "#c99a2e"], ["Funds Received", "#1a9c52"], ["Lapsed", "#8e8e93"]].map((x) => ({ value: x[0], color: x[1] }));
const POLFIELD: Record<string, string> = { client: "client_name", carrier: "carrier", product: "product", ap: "annual_premium", coverage: "coverage", status: "status", date: "submitted_date", policy_num: "policy_number", state: "state", phone: "phone", email: "email" };
const BASECOLS = [
  { key: "client", label: "Client", type: "text" },
  { key: "state", label: "State", type: "text" },
  { key: "phone", label: "Phone", type: "text" },
  { key: "email", label: "Email", type: "text" },
  { key: "agent", label: "Writing Agent", type: "text", ro: true }, { key: "baseshop", label: "Baseshop", type: "text", ro: true }, { key: "carrier", label: "Carrier", type: "text" }, { key: "product", label: "Product", type: "text" }, { key: "ap", label: "Annual Premium", type: "money" }, { key: "coverage", label: "Face Amount", type: "money" }, { key: "split_agent", label: "Split Agent", type: "text", ro: true }, { key: "split_pct", label: "Writer's Split %", type: "text" }, { key: "status", label: "Status", type: "select", options: STATUS_OPTS }, { key: "date", label: "Submitted", type: "text" }, { key: "policy_num", label: "Policy #", type: "text" }
];
async function loadKey(k: string) { const r = await fetch(`${SUPA}/rest/v1/app_settings?key=eq.${k}&select=value`, { headers: DBH }); const rows = await r.json(); return (rows && rows[0]) ? rows[0].value : null; }
async function saveKey(k: string, v: unknown) { await fetch(`${SUPA}/rest/v1/app_settings?on_conflict=key`, { method: "POST", headers: { ...DBH, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key: k, value: v, updated_at: new Date().toISOString() }) }); }
async function getJSON(path: string) { const r = await fetch(`${SUPA}/rest/v1/${path}`, { headers: DBH }); return (await r.json()) || []; }
async function rpc(fn: string, args: Record<string, unknown>) { try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); return await r.json(); } catch (_) { return null; } }

type Auth = { ok: boolean; role?: string; canEdit?: boolean; name?: string; code?: string; error?: string };

/* WHO IS ASKING. See the v20 note: a typed code used to be enough. */
async function authOf(body: any): Promise<Auth> {
  const t = String(body.token ?? "").trim();
  if (t) {
    const r = await rpc("ops_authorize", { p_token: t });
    if (r && r.ok) return { ok: true, role: "ops", canEdit: true, name: String(r.label || "Operations"), code: norm(r.code) };
  }
  const s = String(body.session ?? "").trim().slice(0, 120);
  if (!s) return { ok: false, error: "Sign in to Operations to open this board." };
  const got = await rpc("agent_session_code", { p_token: s });
  const code = (typeof got === "string") ? norm(got) : "";
  if (!code) return { ok: false, error: "Your session has expired — sign in again." };
  const rows = await getJSON(`tracker_agents?code=eq.${enc(code)}&select=contract_level,first_name,last_name`);
  if (rows[0] && LEADER.test(String(rows[0].contract_level || "").trim())) {
    return { ok: true, role: "md", canEdit: false, name: `${rows[0].first_name || ""} ${rows[0].last_name || ""}`.trim(), code };
  }
  return { ok: false, error: "This board is for Operations and team leaders." };
}

/* Which baseshops may this caller see? null = all of them. Resolved from the VERIFIED code —
   it used to come from body.by_code, so naming another seat changed what came back. */
async function scopeOf(token: string, meCode: string): Promise<string[] | null> {
  const sc = await rpc("ops_scope", { p_token: token, p_code: meCode });
  if (!sc || !sc.scoped) return null;
  return Array.isArray(sc.bases) ? sc.bases.map((x: unknown) => String(x)) : [];
}
async function isMasterSeat(token: string, meCode: string): Promise<boolean> {
  const sc = await rpc("ops_scope", { p_token: token, p_code: meCode });
  return !!(sc && sc.seat && !sc.scoped);
}
const inScope = (scope: string[] | null, base: unknown) =>
  !scope || scope.some((s) => low(s) === low(base));

async function track() { const raw = await loadKey(KTRACK); return (raw && typeof raw === "object") ? raw : {}; }
async function columns() { const order = await loadKey(KORDER); if (!Array.isArray(order) || !order.length) return BASECOLS; const out: any[] = []; for (const k of order) { const c = BASECOLS.find((x) => x.key === k); if (c && out.indexOf(c) < 0) out.push(c); } for (const c of BASECOLS) if (out.indexOf(c) < 0) out.push(c); return out; }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: any = {}; try { body = req.method === "POST" ? await req.json() : {}; } catch (_) { body = {}; }
  const action = String(body.action || "nb_list");
  const az = await authOf(body);
  if (!az.ok) return json({ ok: false, error: az.error || "unauthorized" }, 401);
  const tok = String(body.token || "").trim();
  const meCode = String(az.code || "");
  const scope = await scopeOf(tok, meCode);
  const master = await isMasterSeat(tok, meCode);
  const byName = az.name || "Operations"; const byCode = norm(meCode);

  /* ---------- pass a record across a baseshop line (master seat only) ---------- */
  if (action === "nb_share" || action === "nb_unshare") {
    if (!master) return json({ ok: false, error: "Only Operations for all baseshops can pass a record across." }, 403);
    const id = String(body.id || ""); const base = clean(body.baseshop).toUpperCase();
    if (!id || !base) return json({ ok: false, error: "Which record, and to which baseshop?" });
    const known = (await getJSON(`ops_accounts?select=bases`)).some((s: any) =>
      (Array.isArray(s.bases) ? s.bases : []).some((b: unknown) => String(b).toUpperCase() === base));
    if (!known) return json({ ok: false, error: `No Operations seat covers ${base}.` });
    if (action === "nb_unshare") {
      const d = await fetch(`${SUPA}/rest/v1/policy_shares?policy_id=eq.${enc(id)}&baseshop=eq.${enc(base)}`,
        { method: "DELETE", headers: { ...DBH, Prefer: "return=minimal" } });
      return json({ ok: d.ok, id, baseshop: base, shared: false });
    }
    const up = await fetch(`${SUPA}/rest/v1/policy_shares?on_conflict=policy_id,baseshop`, {
      method: "POST", headers: { ...DBH, Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ policy_id: id, baseshop: base, shared_by: byCode, shared_by_name: byName, note: clean(body.note).slice(0, 300) }),
    });
    if (!up.ok) { const t = await up.text(); return json({ ok: false, error: "Could not share that.", detail: t.slice(0, 160) }); }
    return json({ ok: true, id, baseshop: base, shared: true });
  }
  if (action === "nb_shares") {
    const id = String(body.id || "");
    const rows = id ? await getJSON(`policy_shares?policy_id=eq.${enc(id)}&select=*`) : await getJSON(`policy_shares?select=*&order=created_at.desc&limit=500`);
    return json({ ok: true, shares: rows, can_share: master,
      baseshops: Array.from(new Set((await getJSON(`ops_accounts?select=bases`)).flatMap((s: any) => Array.isArray(s.bases) ? s.bases : []))) });
  }

  if (action === "client_contact") {
    const nm = clean(body.name); if (!nm) return json({ ok: true, phone: "", email: "", count: 0 });
    const rows = await getJSON(`policies?client_name=ilike.${enc(nm)}&select=phone,email,state,submitted_date,agent_code&order=submitted_date.desc.nullslast&limit=50`);
    let allowed = rows;
    if (scope) {
      const agents = await getJSON(`tracker_agents?select=code,baseshop&limit=5000`);
      const baseOf: Record<string, string> = {}; agents.forEach((a: any) => baseOf[norm(a.code)] = a.baseshop || "");
      allowed = rows.filter((r: any) => inScope(scope, baseOf[norm(r.agent_code)]));
    }
    let phone = "", email = "", state = "";
    for (const r of allowed) { if (!phone && has(r.phone)) phone = String(r.phone).trim(); if (!email && has(r.email)) email = String(r.email).trim(); if (!state && has(r.state)) state = String(r.state).trim(); }
    return json({ ok: true, phone, email, state, count: allowed.length });
  }

  if (action === "nb_list") {
    const archived = !!body.archived;
    const agents = await getJSON(`tracker_agents?select=code,first_name,last_name,baseshop&limit=3000`);
    const byC: Record<string, any> = {}; agents.forEach((a: any) => byC[norm(a.code)] = a);
    let pols = await getJSON(`policies?select=id,agent_code,client_name,phone,email,state,carrier,product,annual_premium,coverage,status,submitted_date,policy_number,split_flag,split_agent,split_agent_code,split_pct,partner_contract_pct&order=submitted_date.desc&limit=20000`);

    const shareRows = await getJSON(`policy_shares?select=policy_id,baseshop,shared_by_name,note&limit=5000`);
    const sharedInto: Record<string, any> = {};
    for (const s of shareRows) { if (inScope(scope, s.baseshop) && scope) sharedInto[String(s.policy_id)] = s; }
    const sharedAny: Record<string, string[]> = {};
    for (const s of shareRows) { (sharedAny[String(s.policy_id)] = sharedAny[String(s.policy_id)] || []).push(String(s.baseshop)); }

    if (scope) pols = pols.filter((p: any) =>
      inScope(scope, (byC[norm(p.agent_code)] || {}).baseshop) || !!sharedInto[String(p.id)]);

    const archived_count = pols.filter(isDead).length;
    const inforce_count = pols.filter(isInForce).length;
    const pipeline_count = pols.filter(isPipeline).length;
    pols = pols.filter((p: any) => archived ? isDead(p) : isPipeline(p));

    const tk = await track();
    const tickets = pols.map((p: any) => {
      const a = byC[norm(p.agent_code)]; const t = tk[String(p.id)] || {};
      const home = a ? (a.baseshop || "") : "";
      const sIn = sharedInto[String(p.id)];
      let splitAgent = ""; let splitPct = "";
      if (p.split_flag) {
        const partner = byC[norm(p.split_agent_code)];
        const sp = (p.split_pct != null && p.split_pct !== "") ? Math.round(numOr(p.split_pct)) : 50;
        const pName = (partner ? `${partner.first_name || ""} ${partner.last_name || ""}`.trim() : "") || String(p.split_agent || "") || String(p.split_agent_code || "");
        splitAgent = pName ? `${pName} · ${100 - sp}%` : "";
        splitPct = String(sp);
      }
      return { id: String(p.id),
        shared_in: sIn ? { from: home, by: sIn.shared_by_name || "Operations", note: sIn.note || "" } : null,
        shared_with: sharedAny[String(p.id)] || [],
        data: { client: p.client_name || "", state: p.state || "", phone: p.phone || "", email: p.email || "", agent: a ? `${a.first_name || ""} ${a.last_name || ""}`.trim() : (p.agent_code || ""), baseshop: home, carrier: p.carrier || "", product: p.product || "", ap: String(Math.round(numOr(p.annual_premium)) || ""), coverage: String(Math.round(numOr(p.coverage)) || ""), split_agent: splitAgent, split_pct: splitPct, status: STLABEL[low(p.status)] || p.status || "", date: p.submitted_date || "", policy_num: p.policy_number || "", _color: t.color || "" },
        notes: Array.isArray(t.notes) ? t.notes : [] };
    });
    return json({ ok: true, role: az.role, can_edit: az.canEdit, live: true, tickets, columns: await columns(), archived_count, inforce_count, pipeline_count, scoped_to: scope, can_share: master });
  }

  if (action === "nb_set_columns") {
    if (!az.canEdit) return json({ ok: false, error: "Operations only." }, 403);
    const order = (Array.isArray(body.columns) ? body.columns : []).map((c: any) => String(c.key || c)).filter((k: string) => BASECOLS.some((b) => b.key === k));
    if (!order.length) return json({ ok: false, error: "No columns." });
    await saveKey(KORDER, order); return json({ ok: true, columns: await columns() });
  }

  if (action === "nb_update") {
    if (!az.canEdit) return json({ ok: false, error: "Operations only." }, 403);
    const id = String(body.id || ""); if (!id) return json({ ok: false, error: "Missing id." });
    if (scope) {
      const p0 = (await getJSON(`policies?id=eq.${enc(id)}&select=agent_code&limit=1`))[0];
      const ag = p0 ? (await getJSON(`tracker_agents?code=eq.${enc(norm(p0.agent_code))}&select=baseshop&limit=1`))[0] : null;
      const shared = (await getJSON(`policy_shares?policy_id=eq.${enc(id)}&select=baseshop`))
        .some((s: any) => inScope(scope, s.baseshop));
      if (!p0 || (!inScope(scope, ag ? ag.baseshop : "") && !shared)) {
        return json({ ok: false, error: "That business belongs to another baseshop." }, 403);
      }
    }
    const f = String(body.field || ""); const val = clean(body.value);
    if (f === "_color" || f === "process") {
      const tk = await track(); if (!tk[id] || typeof tk[id] !== "object") tk[id] = {};
      if (f === "_color") tk[id].color = val; else tk[id].process = val;
      await saveKey(KTRACK, tk); return json({ ok: true });
    }
    if (f === "split_pct") {
      const sp = clampPct(val);
      const rows = await getJSON(`policies?id=eq.${enc(id)}&select=annual_premium,contract_pct,partner_contract_pct,split_flag`);
      const p = rows[0];
      const patch: Record<string, unknown> = { split_pct: sp };
      if (p) {
        const prem = numOr(p.annual_premium);
        const wr = (p.contract_pct != null) ? Number(p.contract_pct) : null;
        const pr = (p.partner_contract_pct != null) ? Number(p.partner_contract_pct) : wr;
        if (wr != null) {
          const writerPart = Math.round(prem * (sp / 100) * (wr / 100));
          const partnerPart = (p.split_flag && pr != null) ? Math.round(prem * ((100 - sp) / 100) * (pr / 100)) : 0;
          patch.expected_commission = p.split_flag ? (writerPart + partnerPart) : Math.round(prem * (wr / 100));
        }
      }
      const up = await fetch(`${SUPA}/rest/v1/policies?id=eq.${enc(id)}`, { method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify(patch) });
      return json({ ok: up.ok, wroteback: true, recalculated: true, split_pct: sp });
    }
    if (POLFIELD[f]) {
      let dbval: unknown = val;
      if (f === "status") dbval = LABEL2CODE[low(val)] || low(val).replace(/\s+/g, "_") || null;
      else if (f === "ap" || f === "coverage") { const n = val.replace(/[$,\s]/g, ""); dbval = n === "" ? null : (isNaN(Number(n)) ? null : Number(n)); }
      else if (val === "") dbval = null;
      const patch: Record<string, unknown> = { [POLFIELD[f]]: dbval };
      /* Paid Out is the moment the money landed, so record WHEN. Only ever fills a blank —
         a date Operations has already entered is theirs and is never overwritten.

         The date is the EASTERN business date, not UTC. See the v22 note: Operations works
         evenings, and a payout stamped at 9pm on the 31st would otherwise be dated the 1st
         and land in the wrong month of the production report. */
      let stamped = "";
      if (f === "status" && dbval === "paid") {
        const cur = (await getJSON(`policies?id=eq.${enc(id)}&select=paid_out_date&limit=1`))[0];
        if (cur && !cur.paid_out_date) { stamped = bizToday(); patch.paid_out_date = stamped; }
      }
      const up = await fetch(`${SUPA}/rest/v1/policies?id=eq.${enc(id)}`, { method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify(patch) });
      let moved = "";
      if (f === "status" && typeof dbval === "string") {
        if (INFORCE.indexOf(dbval) >= 0) moved = "inforce";
        else if (DEAD.indexOf(dbval) >= 0) moved = "dead";
      }
      return json({ ok: up.ok, wroteback: true, moved, archived: moved === "dead", paid_out_date: stamped });
    }
    return json({ ok: true, ignored: true });
  }

  if (action === "nb_note" || action === "nb_note_del") {
    const id = String(body.id || ""); const tk = await track(); if (!tk[id] || typeof tk[id] !== "object") tk[id] = {};
    if (!Array.isArray(tk[id].notes)) tk[id].notes = [];
    if (action === "nb_note") { const text = clean(body.text); if (!text) return json({ ok: false, error: "Note is empty." }); tk[id].notes.unshift({ id: uid(), ts: new Date().toISOString(), by_code: byCode, by_name: byName, by_role: az.role, text }); }
    else { const nid = String(body.note_id || ""); const nt = tk[id].notes.find((x: any) => x.id === nid); if (!nt) return json({ ok: false, error: "Note not found." }, 404); const mine = has(byCode) && norm(nt.by_code) === byCode; if (!az.canEdit && !mine) return json({ ok: false, error: "You can only delete your own notes." }, 403); tk[id].notes = tk[id].notes.filter((x: any) => x.id !== nid); }
    await saveKey(KTRACK, tk); return json({ ok: true, notes: tk[id].notes });
  }
  return json({ ok: false, error: "unknown action" }, 400);
});
