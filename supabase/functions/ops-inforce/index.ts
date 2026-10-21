// ops-inforce v13 — policies that are ON THE BOOKS and still need tracking.
// v5: `set_paid_date` action — Operations can manually set/clear a policy's Paid Out date.
// v6 (2026-09-02): authorisation is an Operations session from ops-auth rather than the literal
//   "2026" that shipped inside ops.html. ops_authorize() honours the old token until the pages cut over.
// v7 (2026-09-05): BASESHOP SCOPING ENFORCED HERE. The In Force tab was filtering by baseshop in
//   the browser, so every seat still received every baseshop's book of business and could read the
//   rest out of the response. ops_scope() resolves the caller's bases from their session (or, until
//   the legacy token retires, from their seat code) and rows are dropped before they leave. Master
//   seats and non-seat callers (MD/EMD by GFI code) are unaffected. set_paid_date now refuses a
//   policy outside the caller's baseshop.
// v10 (2026-09-08): IN FORCE IS FOUR STATUSES, NOT ONE. This listed only "paid", so a policy that
//   was issued, had premium drafted, or had funds received was on the books but appeared on NO
//   Operations screen. In force now means the same four statuses the rest of the platform uses.
// v11 (2026-09-30): ARCHIVE. Christopher: "still archive the paid ones in the INFORCE tab in the
//   ops platform." New Business could archive; this tab could not, so it grew forever — 93
//   policies, 81 of them paid and closed out, all still in the working view. Archiving is a
//   FILING action: archived_at is its own column, never status='closed' (which means dead), and
//   nothing outside this tab reads it, so production, cashflow and the leaderboard keep counting
//   an archived policy exactly as before.
//
// v12 (2026-10-15) — A TYPED CODE IS NOT A CREDENTIAL. This tab lists client names, carriers,
//   policy numbers and premiums for the whole book, and three routes in asked for nothing better
//   than a string anyone can read off a screen or an org chart:
//     · a four-digit seat code present in operations_users — full Operations read AND write;
//     · ANY agent code whose row has platform_admin — also full Operations read and write;
//     · any MD or EMD agent code — read.
//   Emptying operations_users on 14 Oct shut the first of those and took Operations down with it,
//   because four functions shared that list. So the check moves here: Operations proves itself
//   with the session token minted at PIN entry, and a leader (or the platform admin) proves
//   themselves with their own signed-in agent session. Baseshop scoping and the archive author
//   now read the verified identity instead of whatever the body claimed.
//
// v13 (2026-10-19) — IN FORCE MEANS THE MONEY LANDED, AND NOTHING ELSE.
//   Christopher: "only change to IN FORCE in the ops tracker once the operations staff
//   specifically lists FUNDS HAVE BEEN PAID OUT."
//   v10 widened this to four statuses so that nothing fell off every screen at once. Three of
//   those four — Funds Received, Policy Issued, Premium Drafted — all happen BEFORE a payout.
//   Treating them as on-the-books overstated the book and, worse, moved a policy off the
//   pipeline board while Operations still had work to do on it. In force is now exactly one
//   status: Paid Out. The other three go back to the New Business board, which is the screen
//   that exists for business still in flight — so nothing disappears, it is just filed where
//   the work actually is.
//
//   The payout DATE is the record that the money landed, so it is no longer optional: marking a
//   policy Paid Out stamps today's date when Operations has not set one (see ops-nbfeed), and
//   this tab reports how many rows are still missing theirs so the gap can be closed rather
//   than silently carried. 41 of the 85 paid policies had no date when this shipped.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const INFORCE = ["paid"];
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
function json(o: unknown, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const low = (s: unknown) => (s ?? "").toString().trim().toLowerCase();
const numOr = (v: unknown) => { const n = Number(v); return isNaN(n) ? 0 : n; };
const enc = encodeURIComponent;
async function getJSON(path: string) { const r = await fetch(`${SUPA}/rest/v1/${path}`, { headers: DBH }); return (await r.json()) || []; }
async function rpc(fn: string, args: Record<string, unknown>) { try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); return await r.json(); } catch (_) { return null; } }
const STLABEL: Record<string, string> = { paid: "Paid Out", funds_received: "Funds Received", policy_issued: "Policy Issued", premium_drafted: "Premium Drafted" };

type Auth = { ok: boolean; role?: string; canEdit?: boolean; code?: string; error?: string };
async function authOf(body: any): Promise<Auth> {
  /* Operations: the session token minted at PIN entry, which also names the seat. */
  const t = String(body.token ?? "").trim();
  if (t) {
    const r = await rpc("ops_authorize", { p_token: t });
    if (r && r.ok) return { ok: true, role: "ops", canEdit: true, code: norm(r.code) };
  }
  /* Anyone else must be signed in as themselves. Typing C1991 used to be enough to be
     treated as the platform admin; it is an agent code, printed on the org chart. */
  const s = String(body.session ?? "").trim().slice(0, 120);
  if (!s) return { ok: false, error: "Sign in to Operations to open this tab." };
  const got = await rpc("agent_session_code", { p_token: s });
  const code = (typeof got === "string") ? norm(got) : "";
  if (!code) return { ok: false, error: "Your session has expired — sign in again." };
  const rows = await getJSON(`tracker_agents?code=eq.${enc(code)}&select=contract_level,platform_admin`);
  if (rows[0] && rows[0].platform_admin === true) return { ok: true, role: "ops", canEdit: true, code };
  const lvl = norm(rows[0] && rows[0].contract_level);
  if (lvl === "MD" || lvl === "EMD") return { ok: true, role: lvl.toLowerCase(), canEdit: false, code };
  return { ok: false, error: "This tab is for Operations and team leaders." };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: any = {}; try { body = req.method === "POST" ? await req.json() : {}; } catch (_) { body = {}; }
  const az = await authOf(body);
  if (!az.ok) return json({ ok: false, error: az.error || "unauthorized" }, 401);
  const action = String(body.action || "");
  const meCode = String(az.code || "");

  /* Scope follows the verified identity, not a code typed into the body. */
  const sc = await rpc("ops_scope", { p_token: String(body.token || ""), p_code: meCode });
  const scoped = !!(sc && sc.scoped);
  const allow = new Set<string>(((sc && Array.isArray(sc.bases)) ? sc.bases : []).map((b: string) => low(b)));

  const agents = await getJSON(`tracker_agents?select=code,first_name,last_name,baseshop&limit=3000`);
  const byCode: Record<string, any> = {}; agents.forEach((a: any) => byCode[norm(a.code)] = a);
  const baseOf = (agentCode: unknown) => { const a = byCode[norm(agentCode)]; return low(a && a.baseshop); };
  const inScope = (agentCode: unknown) => !scoped || allow.has(baseOf(agentCode));

  /* Both write actions check the caller may edit AND that the policy is in their baseshop. */
  async function ownedPolicy(id: string) {
    const owner = await getJSON(`policies?id=eq.${enc(id)}&select=agent_code,status`);
    if (!owner[0]) return { err: json({ ok: false, error: "That policy no longer exists." }, 404) };
    if (scoped && !inScope(owner[0].agent_code)) return { err: json({ ok: false, error: "That policy is not in your baseshop." }, 403) };
    return { row: owner[0] };
  }

  if (action === "set_paid_date") {
    if (!az.canEdit) return json({ ok: false, error: "Only Operations can edit the Paid Out date." }, 403);
    const id = String(body.id || ""); if (!id) return json({ ok: false, error: "missing id" });
    const o = await ownedPolicy(id); if (o.err) return o.err;
    const raw = low(body.paid_out_date);
    let val: string | null = null;
    if (raw) { if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return json({ ok: false, error: "Use a date like 2026-08-21." }); val = raw; }
    const up = await fetch(`${SUPA}/rest/v1/policies?id=eq.${enc(id)}`, { method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify({ paid_out_date: val }) });
    if (!up.ok) { const t = await up.text(); return json({ ok: false, error: "Could not save.", detail: t.slice(0, 160) }); }
    return json({ ok: true, id, paid_out_date: val });
  }

  /* File a closed-out policy away, or bring it back. Never deletes, never changes status. */
  if (action === "archive" || action === "unarchive") {
    if (!az.canEdit) return json({ ok: false, error: "Only Operations can archive a policy." }, 403);
    const id = String(body.id || ""); if (!id) return json({ ok: false, error: "missing id" });
    const o = await ownedPolicy(id); if (o.err) return o.err;
    const on = action === "archive";
    const up = await fetch(`${SUPA}/rest/v1/policies?id=eq.${enc(id)}`, {
      method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" },
      body: JSON.stringify({ archived_at: on ? new Date().toISOString() : null,
                             archived_by: on ? (meCode || "ops").slice(0, 40) : null }),
    });
    if (!up.ok) return json({ ok: false, error: "Could not save." }, 500);
    return json({ ok: true, id, archived: on });
  }

  const wantArchived = body.archived === true;
  const pols = await getJSON(`policies?select=id,agent_code,client_name,carrier,product,annual_premium,status,submitted_date,paid_out_date,coverage,policy_number,archived_at&limit=20000`);
  const live = pols.filter((p: any) => INFORCE.indexOf(low(p.status)) >= 0 && inScope(p.agent_code));
  const archivedCount = live.filter((p: any) => !!p.archived_at).length;
  const out = live.filter((p: any) => wantArchived ? !!p.archived_at : !p.archived_at).map((p: any) => {
    const a = byCode[norm(p.agent_code)];
    return { id: String(p.id), client: p.client_name || "", agent_code: p.agent_code || "", agent: a ? `${a.first_name || ""} ${a.last_name || ""}`.trim() : (p.agent_code || ""), baseshop: a ? (a.baseshop || "") : "", carrier: p.carrier || "", product: p.product || "", policy_number: p.policy_number || "", ap: Math.round(numOr(p.annual_premium)), coverage: Math.round(numOr(p.coverage)), status: low(p.status), status_label: STLABEL[low(p.status)] || p.status || "", paid_out_date: p.paid_out_date || "", submitted_date: p.submitted_date || "", date: p.paid_out_date || "", archived: !!p.archived_at };
  });
  out.sort((x: any, y: any) => String(y.date || y.submitted_date).localeCompare(String(x.date || x.submitted_date)));
  const total_ap = out.reduce((t: number, p: any) => t + p.ap, 0);
  const paid_ap = out.filter((p: any) => p.status === "paid").reduce((t: number, p: any) => t + p.ap, 0);
  const paid_count = out.filter((p: any) => p.status === "paid").length;
  /* How many of these are on the books with no record of WHEN the money landed. Reported so the
     gap can be worked off rather than carried silently — the date is the whole basis of the tab. */
  const missing_paid_date = out.filter((p: any) => !p.paid_out_date).length;
  return json({ ok: true, role: az.role, can_edit: az.canEdit, scoped, archived_view: wantArchived, archived_count: archivedCount, count: out.length, total_ap, paid_ap, paid_count, missing_paid_date, policies: out });
});
