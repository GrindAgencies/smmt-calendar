import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// v4 (2026-09-30): the hardcoded "2026" is gone. It gated adding and DELETING coaching notes,
// and made `list` return every note in the company instead of the caller's own. Authorisation
// now goes through ops_authorize(), so it rides the same switch as everything else.
async function _rpcAuth(fn, args) { try { const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`, "Content-Type": "application/json" }, body: JSON.stringify(args) }); return await r.json(); } catch (_) { return null; } }
/* The one authority for "is this really Operations". Replaces a hardcoded literal that could not
   be switched off centrally, which is exactly why five other functions kept working after the
   September cutover was supposed to have closed this. */
async function _opsOk(token) { const t = String(token ?? "").trim(); if (!t) return false; const r = await _rpcAuth("ops_authorize", { p_token: t }); return !!(r && r.ok); }

const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
function json(o: unknown, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const low = (s: unknown) => (s ?? "").toString().trim().toLowerCase();
const clean = (s: unknown) => (s ?? "").toString().trim().slice(0, 4000);

async function loadKey(k: string) { try { const r = await fetch(`${SUPA}/rest/v1/app_settings?key=eq.${encodeURIComponent(k)}&select=value`, { headers: DBH }); const rows = await r.json(); return (rows && rows[0]) ? rows[0].value : null; } catch (_) { return null; } }
async function orgRoleOf(code: string): Promise<string> {
  try {
    const v = await loadKey("org_structure");
    const nodes = (v && Array.isArray(v.nodes)) ? v.nodes as Record<string, unknown>[] : [];
    const n = nodes.find((x) => norm(x.id) === norm(code) || norm(x.gfi) === norm(code));
    return n ? String(n.role || "agent") : "agent";
  } catch (_) { return "agent"; }
}
async function isBaseOwner(code: string): Promise<boolean> {
  try {
    const bs = await loadKey("baseshops");
    const list = (bs && Array.isArray(bs.bases)) ? bs.bases as Record<string, unknown>[] : [];
    return list.some((b) => norm(b.owner_code) === norm(code));
  } catch (_) { return false; }
}
function contractIsLeader(cl: unknown): boolean {
  const s = low(cl);
  if (!s) return false;
  return /(^|\b)(cft|certified field trainer|md|marketing director|emd|executive marketing|nvp|national vice|sevp|senior executive|ceo)(\b|$)/.test(s);
}
async function isCoach(code: string): Promise<boolean> {
  const c = norm(code);
  if (!c) return false;
  const role = await orgRoleOf(c);
  if (role === "cft" || role === "senior" || role === "exec" || role === "trainer") return true;
  if (await isBaseOwner(c)) return true;
  try {
    const ex = await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${encodeURIComponent(c)}&select=contract_level&limit=1`, { headers: DBH });
    const a = ((await ex.json()) || [])[0];
    if (a && contractIsLeader(a.contract_level)) return true;
  } catch (_) { /* noop */ }
  return false;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = new URL(req.url);
    let body: Record<string, unknown> = {};
    if (req.method === "POST") body = await req.json().catch(() => ({}));
    const action = (body.action as string) || url.searchParams.get("action") || "";
    const token = (body.token as string) || "";

    if (action === "add") {
      const byCode = norm(body.by_code);
      const traineeCode = norm(body.trainee_code);
      const text = clean(body.body);
      if (!traineeCode || !text) return json({ ok: false, error: "Missing trainee or note." });
      const allowed = await _opsOk(token) || (byCode && await isCoach(byCode));
      if (!allowed) return json({ ok: false, error: "Only trainers and senior leaders can leave coaching notes." }, 403);
      const row = {
        trainee_code: traineeCode, trainee_name: clean(body.trainee_name),
        by_code: byCode, by_name: clean(body.by_name), trainer_name: clean(body.trainer_name),
        booking_id: clean(body.booking_id) || null, ft_date: clean(body.ft_date) || null, body: text
      };
      const ins = await fetch(`${SUPA}/rest/v1/coaching_notes`, { method: "POST", headers: { ...DBH, Prefer: "return=representation" }, body: JSON.stringify(row) });
      const r = await ins.json();
      return json({ ok: ins.ok, note: Array.isArray(r) ? r[0] : r });
    }

    if (action === "list") {
      const code = norm(body.code || url.searchParams.get("code"));
      if (!code) return json({ ok: false, error: "no code" });
      const ex = await fetch(`${SUPA}/rest/v1/coaching_notes?trainee_code=eq.${encodeURIComponent(code)}&order=created_at.desc&limit=300`, { headers: DBH });
      return json({ ok: true, notes: (await ex.json()) || [] });
    }

    if (action === "booking") {
      const bid = clean(body.booking_id || url.searchParams.get("booking_id"));
      if (!bid) return json({ ok: true, notes: [] });
      const ex = await fetch(`${SUPA}/rest/v1/coaching_notes?booking_id=eq.${encodeURIComponent(bid)}&order=created_at.desc`, { headers: DBH });
      return json({ ok: true, notes: (await ex.json()) || [] });
    }

    if (action === "delete") {
      const id = clean(body.id); const byCode = norm(body.by_code);
      if (!id) return json({ ok: false, error: "no id" });
      let q = `${SUPA}/rest/v1/coaching_notes?id=eq.${encodeURIComponent(id)}`;
      if (!(await _opsOk(token))) { if (!byCode) return json({ ok: false, error: "unauthorized" }, 401); q += `&by_code=eq.${encodeURIComponent(byCode)}`; }
      const del = await fetch(q, { method: "DELETE", headers: { ...DBH, Prefer: "return=minimal" } });
      return json({ ok: del.ok, id });
    }

    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
