// pfr-api v10 (2026-10-26; v9 2026-10-26; v8 2026-09-30) — Personal Financial Reviews. This holds the most sensitive data in
// the platform: 94 reviews, each carrying a client's name, phone, household, health, assets,
// debt, monthly expenses and their existing policies with cash values. Third-party personal
// financial data about people who are not users of this app.
//
// FOUR WAYS IN, ALL CLOSED HERE:
//
//  1. `ADMIN_TOKEN = "2026"` compared directly — a fourth function that kept its own copy of the
//     literal and so never joined the September cutover onto ops_authorize(). Verified today:
//     one credential-free request returned ALL 94 reviews with the complete data blob.
//
//  2. `pfr_get` had NO check whatsoever. An id was the only thing needed to read a client's
//     entire financial review. And ids were free: pfr_list took a typed agent code — codes are
//     printed on the org chart — so the whole chain ran with no credentials at all.
//
//  3. pfr_list / pfr_reco / pfr_1035_list scoped to a TYPED code, so any agent's client book
//     was readable by typing their code.
//
//  4. pfr_save wrote `agent_code` from the request, so a review could be created or overwritten
//     in somebody else's name; pfr_delete took the same typed code and destroyed their reviews.
//
// Identity now comes from the session token minted when somebody enters their PIN, or an
// Operations token ops_authorize() accepts. A `code` in the request is never identity again:
// reads are scoped to the session, writes land on the session, and pfr_get checks the review
// actually belongs to the person asking.
//
// v10 (2026-10-26) — OPS SEATS ARE SCOPED, AND AN OPS EDIT NEVER MOVES A CLIENT.
//   a) Every Ops token saw every review in the company. A baseshop seat (0001-0005) now sees,
//      opens and saves only reviews owned by agents in its bases; master seats (0000, C1991)
//      keep the full view exactly as before.
//   b) v9 still let a named `code` win over the row's owner when Ops saved an EXISTING review,
//      so a stale or wrong code silently reassigned a client's whole financial file. An existing
//      review now always keeps its agent unless the request says reassign:true with a code. New
//      reviews still take the agent from pfr.html's picker (it sends `code`), unchanged.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
function json(o: unknown, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const clean = (s: unknown) => (s ?? "").toString().trim().slice(0, 200);
const numOr = (v: unknown) => { const n = Number((v ?? "").toString().replace(/[^0-9.\-]/g, "")); return isNaN(n) ? 0 : n; };
const enc = encodeURIComponent;
async function rpc(fn: string, args: Record<string, unknown>) { try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); return await r.json(); } catch (_) { return null; } }

/* ===== WHO IS CALLING =====
   Operations by token, or a member by the session minted at PIN entry. Nothing else. */
type Caller = { code: string; ops: boolean; token?: string };
async function whoIsCalling(body: Record<string, unknown>, q: URLSearchParams): Promise<Caller> {
  const t = ((body.token ?? q.get("token")) ?? "").toString().trim().slice(0, 120);
  if (t) { const az = await rpc("ops_authorize", { p_token: t }); if (az && az.ok) return { code: "", ops: true, token: t }; }
  const s = ((body.session ?? q.get("session")) ?? "").toString().trim().slice(0, 120);
  if (s) { const c = await rpc("agent_session_code", { p_token: s }); if (typeof c === "string" && c) return { code: norm(c), ops: false }; }
  return { code: "", ops: false };
}
/* v10: the agent codes a baseshop Ops seat may see, or null for company-wide (master seat or
   machine token). ops_scope expands the seat's bases through baseshop_groups, the same as every
   other scoped Ops screen. */
async function seatCodes(token: string): Promise<string[] | null> {
  const sc = await rpc("ops_scope", { p_token: token });
  if (sc && sc.seat && !sc.scoped) return null;
  const bases: string[] = Array.isArray(sc?.bases) ? sc.bases.map((b: unknown) => norm(b)) : [];
  if (!bases.length) return [];
  const r = await fetch(`${SUPA}/rest/v1/tracker_agents?select=code,baseshop&limit=5000`, { headers: DBH });
  const rows: Record<string, unknown>[] = (await r.json()) || [];
  return rows.filter((a) => bases.indexOf(norm(a.baseshop)) >= 0).map((a) => norm(a.code)).filter(Boolean);
}
/* PostgREST filter for "owned by one of these agents". An empty list must match nothing. */
const inCodes = (codes: string[]) => codes.length ? `&agent_code=in.(${codes.map((c) => enc(`"${c}"`)).join(",")})` : `&agent_code=eq.__none__`;
function needSession() { return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401); }

// Mirror the client's existing life policies (from the PFR JSON) into the OPS
// policy_1035_exchanges table so Operations has every 1035 candidate in one place
// (all 1035 forms require policy number + death benefit + cash value).
async function sync1035(pfrId: string, body: Record<string, unknown>, ownerCode: string) {
  if (!pfrId) return;
  const data = (body.data && typeof body.data === "object") ? body.data as Record<string, unknown> : {};
  const ex = (data.existing && typeof data.existing === "object") ? data.existing as Record<string, unknown> : {};
  const policies = Array.isArray(ex.policies) ? ex.policies as Record<string, unknown>[] : [];
  // rewrite this PFR's rows from scratch each save
  await fetch(`${SUPA}/rest/v1/policy_1035_exchanges?pfr_id=eq.${enc(pfrId)}`, { method: "DELETE", headers: { ...DBH, Prefer: "return=minimal" } });
  if (String(ex.has || "").toLowerCase() !== "yes") return;
  const rows = policies
    .filter((p) => p && (p.carrier || p.policyNo || p.deathBenefit || p.cashValue))
    .map((p, i) => {
      const verdict = clean(p.aiVerdict).toLowerCase();
      return {
        pfr_id: pfrId, policy_idx: i,
        agent_code: ownerCode, agent_name: clean(body.agent_name), client_name: clean(body.client_name),
        carrier: clean(p.carrier), policy_type: clean(p.ptype), policy_number: clean(p.policyNo),
        death_benefit: numOr(p.deathBenefit), cash_value: numOr(p.cashValue), premium_monthly: numOr(p.premiumMo),
        issue_year: p.issueYear ? Math.round(numOr(p.issueYear)) : null,
        ai_verdict: verdict, ai_assessment: (p.aiAssessment ?? "").toString().slice(0, 4000),
        exchange_recommended: verdict === "exchange",
        updated_at: new Date().toISOString()
      };
    });
  if (rows.length) await fetch(`${SUPA}/rest/v1/policy_1035_exchanges`, { method: "POST", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify(rows) });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = new URL(req.url);
    let body: Record<string, unknown> = {};
    if (req.method === "POST") body = await req.json().catch(() => ({}));
    const action = (body.action as string) || url.searchParams.get("action") || "";

    // Nothing here is public. Client financial data never leaves without proof of identity.
    const me = await whoIsCalling(body, url.searchParams);
    if (!me.ops && !me.code) return needSession();
    // Whose reviews these are. Operations may act for a named agent; everyone else is themselves.
    /* A four-digit code is an Operations SEAT, never an agent: treat it as "no agent named" so an
       Ops caller sees everything instead of filtering to a non-existent agent "0000". */
    const named = me.ops ? norm(body.code || url.searchParams.get("code")) : "";
    const mine = me.ops ? (/^\d{4}$/.test(named) ? "" : named) : me.code;
    /* v10: a baseshop seat's reach (null = master, unchanged). Naming an agent outside it is refused
       outright rather than quietly returning an empty book. */
    const seat = me.ops ? await seatCodes(me.token || "") : null;
    if (seat && mine && seat.indexOf(mine) < 0) {
      return json({ ok: false, error: "That agent is outside your Operations seat." }, 403);
    }
    const seatQ = seat ? inCodes(seat) : "";

    if (action === "pfr_list") {
      let q = `${SUPA}/rest/v1/pfrs?select=id,agent_code,agent_name,client_name,client_phone,insurable_need,status,recommended_carrier,recommended_product,recommended_strategy,updated_at,created_at,data&order=updated_at.desc`;
      if (!me.ops) q += `&agent_code=eq.${enc(me.code)}`;
      else if (mine) q += `&agent_code=eq.${enc(mine)}`;
      else q += seatQ;
      const ex = await fetch(q, { headers: DBH });
      return json({ ok: true, scope: me.ops ? (mine || "all") : me.code, pfrs: (await ex.json()) || [] });
    }

    if (action === "pfr_get") {
      // WAS: an id was the whole authorisation. Now the review has to be yours.
      const id = clean(body.id || url.searchParams.get("id"));
      if (!id) return json({ ok: false, error: "no id" });
      let q = `${SUPA}/rest/v1/pfrs?id=eq.${enc(id)}&select=*`;
      if (!me.ops) q += `&agent_code=eq.${enc(me.code)}`;
      else q += seatQ;
      const ex = await fetch(q, { headers: DBH });
      const rows = await ex.json();
      const pfr = (rows && rows[0]) ? rows[0] : null;
      if (!pfr) return json({ ok: false, error: "That review is not yours, or no longer exists." }, 404);
      return json({ ok: true, pfr });
    }

    if (action === "pfr_reco") {
      const nameQ = (body.client_name ?? url.searchParams.get("client_name") ?? "").toString().trim().toLowerCase();
      let q = `${SUPA}/rest/v1/pfrs?select=agent_code,client_name,recommended_carrier,recommended_product,recommended_strategy,updated_at&order=updated_at.desc`;
      if (!me.ops) q += `&agent_code=eq.${enc(me.code)}`;
      else if (mine) q += `&agent_code=eq.${enc(mine)}`;
      else q += seatQ;
      const ex = await fetch(q, { headers: DBH });
      const rows: Record<string, unknown>[] = (await ex.json()) || [];
      const map: Record<string, unknown> = {};
      for (const r of rows) {
        const k = ((r.client_name as string) || "").trim().toLowerCase();
        if (!k || map[k]) continue;
        if (!r.recommended_carrier && !r.recommended_product && !r.recommended_strategy) continue;
        map[k] = { carrier: r.recommended_carrier || "", product: r.recommended_product || "", strategy: r.recommended_strategy || "", at: r.updated_at };
      }
      if (nameQ) return json({ ok: true, reco: map[nameQ] || null });
      return json({ ok: true, recos: map });
    }

    // OPS / agent register of 1035 exchange candidates
    if (action === "pfr_1035_list") {
      let q = `${SUPA}/rest/v1/policy_1035_exchanges?select=*&order=updated_at.desc`;
      if (!me.ops) q += `&agent_code=eq.${enc(me.code)}`;
      else if (mine) q += `&agent_code=eq.${enc(mine)}`;
      else q += seatQ;
      const ex = await fetch(q, { headers: DBH });
      return json({ ok: true, policies: (await ex.json()) || [] });
    }

    // OPS updates a 1035 candidate's workflow status / notes
    if (action === "pfr_1035_update") {
      if (!me.ops) return json({ ok: false, error: "unauthorized" }, 401);
      const id = clean(body.id); if (!id) return json({ ok: false, error: "no id" });
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (typeof body.status === "string") patch.status = clean(body.status);
      if (typeof body.notes === "string") patch.notes = (body.notes as string).slice(0, 2000);
      /* v11: a per-baseshop seat may only move candidates belonging to its own shop's agents. */
      const up = await fetch(`${SUPA}/rest/v1/policy_1035_exchanges?id=eq.${enc(id)}${seatQ}`, { method: "PATCH", headers: { ...DBH, Prefer: "return=representation" }, body: JSON.stringify(patch) });
      const got = await up.json().catch(() => []);
      if (up.ok && seatQ && !(Array.isArray(got) && got.length)) return json({ ok: false, error: "That candidate is outside your baseshop." }, 403);
      return json({ ok: up.ok, id });
    }

    if (action === "pfr_save") {
      const id = clean(body.id);
      /* v9 (2026-10-26): OPERATIONS EDITING A CLIENT'S REVIEW KEEPS ITS OWNER. The owner used to
         be whatever code the request named, so an Ops save with no code failed ("no agent code")
         and one with the wrong code silently moved the client to another agent. For an existing
         review Ops now inherits the row's own agent; naming a code is only needed for a new one. */
      let owner = mine;
      let keepName = "";
      /* v10: for an EXISTING review the row's own agent always wins, whatever `code` says, unless
         the request explicitly asks to reassign (reassign:true plus a code). pfr.html sends the
         row's own agent_code here anyway, so the normal edit path is unchanged. */
      const reassign = me.ops && body.reassign === true && !!mine;
      if (me.ops && id) {
        const cur = await fetch(`${SUPA}/rest/v1/pfrs?id=eq.${enc(id)}&select=agent_code,agent_name${seatQ}`, { headers: DBH });
        const r0 = ((await cur.json()) || [])[0];
        if (!r0) return json({ ok: false, error: "That review no longer exists." }, 404);
        if (!reassign) { owner = norm(r0.agent_code); keepName = clean(r0.agent_name); }
      }
      if (!owner) return json({ ok: false, error: me.ops ? "Choose which agent this review belongs to." : "no agent code" });
      const row: Record<string, unknown> = {
        /* v10: an Ops edit keeps the row's agent_name too, so the name never drifts from the code. */
        agent_code: owner, agent_name: (keepName && me.ops) ? keepName : (clean(body.agent_name) || keepName),
        client_name: clean(body.client_name), client_phone: clean(body.client_phone), client_email: clean(body.client_email),
        data: (body.data && typeof body.data === "object") ? body.data : {},
        insurable_need: numOr(body.insurable_need), status: clean(body.status) || "draft",
        updated_at: new Date().toISOString()
      };
      if (body.recommended_carrier !== undefined) row.recommended_carrier = clean(body.recommended_carrier);
      if (body.recommended_product !== undefined) row.recommended_product = clean(body.recommended_product);
      if (body.recommended_strategy !== undefined) row.recommended_strategy = (body.recommended_strategy ?? "").toString().slice(0, 800);
      let saved: Record<string, unknown> | null = null; let okFlag = false;
      if (id) {
        let q = `${SUPA}/rest/v1/pfrs?id=eq.${enc(id)}`;
        if (!me.ops) q += `&agent_code=eq.${enc(me.code)}`;
        else q += seatQ;
        const up = await fetch(q, { method: "PATCH", headers: { ...DBH, Prefer: "return=representation" }, body: JSON.stringify(row) });
        const r = await up.json(); saved = Array.isArray(r) ? r[0] : r; okFlag = up.ok;
        if (okFlag && !saved) return json({ ok: false, error: "That review is not yours, or no longer exists." }, 404);
      } else {
        const ins = await fetch(`${SUPA}/rest/v1/pfrs`, { method: "POST", headers: { ...DBH, Prefer: "return=representation" }, body: JSON.stringify(row) });
        const r = await ins.json(); saved = Array.isArray(r) ? r[0] : r; okFlag = ins.ok;
      }
      // keep the OPS 1035 register in sync with this PFR's existing-policy data
      try { if (saved && saved.id) await sync1035(saved.id as string, body, owner); } catch (_e) { /* never fail the save on 1035 sync */ }
      return json({ ok: okFlag, pfr: saved });
    }

    if (action === "pfr_delete") {
      const id = clean(body.id);
      if (!id) return json({ ok: false, error: "no id" });
      let q = `${SUPA}/rest/v1/pfrs?id=eq.${enc(id)}`;
      if (!me.ops) q += `&agent_code=eq.${enc(me.code)}`;
      else q += seatQ;
      // Only clear the 1035 rows once we know the review itself was ours to delete.
      const del = await fetch(q + "&select=id", { method: "DELETE", headers: { ...DBH, Prefer: "return=representation" } });
      const gone = await del.json();
      if (!del.ok || !Array.isArray(gone) || !gone.length) return json({ ok: false, error: "That review is not yours, or no longer exists." }, 404);
      await fetch(`${SUPA}/rest/v1/policy_1035_exchanges?pfr_id=eq.${enc(id)}`, { method: "DELETE", headers: { ...DBH, Prefer: "return=minimal" } });
      return json({ ok: true, id });
    }

    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
