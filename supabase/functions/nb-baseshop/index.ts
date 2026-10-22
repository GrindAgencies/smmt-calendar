// nb-baseshop v1 (2026-10-20) — New Business, scoped to the caller's whole BASESHOP.
//
// Why this exists as its own endpoint rather than a branch inside newbiz-api:
// newbiz-api already answers the other two scopes. Personal is its default (identify by
// session, filter to policies you write or partner on, and credit you YOUR SHARE via my_ap).
// Hierarchy is its existing `leader` path, which resolves the real org tree through nb_scope().
// Baseshop is the only one it cannot express, because a baseshop is not an org subtree —
// SUMMIT holds 144 life policies where Christopher's downline holds 92, and neither contains
// the other. newbiz-api is the policy SUBMISSION backbone (v20, create/update/delete/status),
// so during launch week a read-only sibling is the lower-risk place to add a read-only scope.
//
// SHARE CONVENTION, matched exactly to newbiz-api's leader mode so the three scopes are
// comparable: in a team view every policy is counted ONCE AT ITS FULL ANNUAL PREMIUM. That is
// what newbiz-api does when it has no single caller to attribute to (it sets share = 100), and
// it is the right answer for a team: the shop wrote that much business, however the credit was
// split internally. Per-person share-weighting belongs to Personal scope, and lives in
// newbiz-api where the complicated half of that arithmetic already is. Nothing is duplicated.
//
// WHO MAY ASK: can_see_baseshop(code) — Christopher's decision on 2026-10-20 was "leaders only",
// so a regular agent cannot see their colleagues' books. That rule is a DATABASE function on
// purpose: the Leaderboard needs the identical test, and two copies of a permission rule drift.
// Ten people qualify today. Enforced here on the server; the UI hiding the control is a
// courtesy, not the control.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH  = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const clean = (s: unknown) => (s ?? "").toString().trim().slice(0, 120);
const dnum = (v: unknown) => { const n = Number(v); return isNaN(n) ? 0 : n; };
const enc = encodeURIComponent;

async function rpc(fn: string, args: Record<string, unknown>) {
  try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); return await r.json(); }
  catch (_) { return null; }
}
async function getJSON(path: string) {
  try { const r = await fetch(`${SUPA}/rest/v1/${path}`, { headers: DBH }); return (await r.json()) || []; }
  catch (_) { return []; }
}
async function opsAuthorized(t: unknown) {
  const s = String(t ?? ""); if (!s) return false;
  const r = await rpc("ops_authorize", { p_token: s }); return !!(r && r.ok);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: any = {}; try { body = await req.json(); } catch (_) { body = {}; }

  /* Identity is the session minted at PIN entry. A typed code is not proof — same posture as
     newbiz-api v20, which closed exactly that hole on this ledger. */
  const isOps = await opsAuthorized(body.token);
  let code = "";
  if (isOps) code = norm(body.code);
  else {
    const s = String(body.session ?? "").trim().slice(0, 120);
    if (!s) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401);
    const got = await rpc("agent_session_code", { p_token: s });
    code = (typeof got === "string") ? norm(got) : "";
    if (!code) return json({ ok: false, needs_session: true, error: "Your session has expired — sign in again." }, 401);
  }
  if (!code) return json({ ok: false, error: "no code" }, 400);

  const allowed = isOps ? true : !!(await rpc("can_see_baseshop", { p_code: code }));
  const meRows = await getJSON(`tracker_agents?code=eq.${enc(code)}&select=baseshop,first_name,last_name&limit=1`);
  const shop = clean(meRows[0] && meRows[0].baseshop) || (isOps ? clean(body.baseshop) : "");

  /* 'check' lets the page ask whether to offer the control at all, without pulling the data. */
  if (String(body.action || "") === "check") {
    return json({ ok: true, allowed, baseshop: shop });
  }
  if (!allowed) {
    return json({ ok: false, error: "Base shop figures are for the people who lead the shop." }, 403);
  }
  if (!shop) return json({ ok: false, error: "You are not recorded in a baseshop yet." }, 400);

  /* Everyone in the shop, including people who have left — business they wrote while they were
     here still belongs to the shop's history, and dropping it would make past months shrink
     every time somebody departs. */
  const members = await getJSON(`tracker_agents?baseshop=eq.${enc(shop)}&select=code&limit=5000`);
  const codes = members.map((m: any) => String(m.code ?? "").trim()).filter((c: string) => /^[A-Za-z0-9_.-]+$/.test(c));
  if (!codes.length) return json({ ok: true, count: 0, scope: shop, baseshop: shop, allowed, policies: [] });

  const bt = clean(body.business_type).toLowerCase();
  const inList = codes.map((c) => `"${c}"`).join(",");
  /* Writer OR partner, so a policy written outside the shop but partnered by someone inside it
     still shows — and the dedupe below stops it being counted twice when BOTH are in the shop. */
  let q = `${SUPA}/rest/v1/policies?select=*&order=submitted_date.desc,created_at.desc`
        + `&or=(agent_code.in.(${inList}),split_agent_code.in.(${inList}))`;
  if (bt === "life" || bt === "annuity") q += `&business_type=eq.${bt}`;

  const ex = await fetch(q, { headers: DBH });
  const raw: Record<string, unknown>[] = (await ex.json()) || [];

  /* One row per policy. The or= above can match a policy on both sides; PostgREST returns it
     once, but dedupe explicitly so a future change to that filter cannot silently double the
     shop's production. */
  const seen = new Set<string>();
  const rows: Record<string, unknown>[] = [];
  for (const r of raw) { const k = String(r.id); if (seen.has(k)) continue; seen.add(k); rows.push(r); }

  /* Row shaping identical to newbiz-api's leader mode: full premium, full commission, counted
     once. my_ap is the field the page reads for every scope, so the page needs no special case. */
  for (const r of rows) {
    const prem = dnum(r.annual_premium);
    const sp = (r.split_flag && r.split_pct != null) ? Number(r.split_pct) : 100;
    const wRate = (r.contract_pct != null) ? Number(r.contract_pct) : null;
    const pRate = (r.partner_contract_pct != null) ? Number(r.partner_contract_pct) : 0;  // never the writer's
    const writerPart  = (wRate != null) ? Math.round(prem * (sp / 100) * (wRate / 100)) : 0;
    const partnerPart = r.split_flag ? Math.round(prem * ((100 - sp) / 100) * (pRate / 100)) : 0;
    r._share = 1;
    r.split_role = r.split_flag ? "given" : "";
    r.my_share_pct = 100;
    r.my_ap = Math.round(prem);
    r.my_commission = r.split_flag ? (writerPart + partnerPart)
                                   : ((wRate != null) ? Math.round(prem * (wRate / 100)) : 0);
    r.partner_pct = r.split_flag ? (100 - Number(r.split_pct != null ? r.split_pct : 50)) : null;
    r.partner_contract_pct = (r.partner_contract_pct != null) ? Number(r.partner_contract_pct) : null;
  }

  return json({ ok: true, count: rows.length, scope: shop, baseshop: shop, allowed, members: codes.length, policies: rows });
});
