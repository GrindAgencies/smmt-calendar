// goals-api v2 — Snapshot goals, one accountable owner per level.
//
//   personal   → each person sets their own
//   team       → the Marketing Director who runs that team
//   baseshop   → the EMD who owns that baseshop
//   hierarchy  → Eli Cox
//
// v2 (2026-09-30): IDENTITY COMES FROM THE SESSION, NOT FROM body.code.
// Every permission below was already enforced server-side — but all of it hung on a GFI code
// supplied by the caller, and codes are printed on the org chart. Sending a colleague's code
// returned their goals with can_edit:true and let you write them. The caller is now whoever the
// session says they are; the code in the body is ignored for identity.
//
// Goals used to be a single JSON blob with three buckets, and the 'shop' bucket was
// GLOBAL — every baseshop shared one set of numbers, so TITANS (4 people) and SMMT (74)
// were held to the same target. Goals now live in a real table keyed by level + owner + month,
// and the database decides who may write each one.
//
// Actions:
//   get { month }                      -> all four levels for this person + who owns each
//   set { scope, metric, target, month} -> write one goal (permission enforced)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const clean = (s: unknown, n = 80) => (s ?? "").toString().trim().slice(0, n);
const SCOPES = ["personal", "team", "baseshop", "hierarchy"];
const METRICS = ["fta", "premium", "families", "partners"];
const LABEL: Record<string, string> = { personal: "Personal", team: "Team", baseshop: "Baseshop", hierarchy: "Hierarchy" };

function thisMonth() { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date()).slice(0, 7); }
async function rpc(fn: string, args: Record<string, unknown>) {
  const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) });
  return await r.json();
}
async function getJSON(path: string) { const r = await fetch(`${SUPA}/rest/v1/${path}`, { headers: DBH }); return (await r.json()) || []; }

/* WHO IS ACTUALLY CALLING. A session token is proof; a GFI code is a public fact printed on the
   org chart. Operations keeps its own door via ops_authorize, because Ops screens act on behalf
   of the whole company rather than as one agent. */
async function callerCode(body: Record<string, unknown>): Promise<{ code: string; ops: boolean }> {
  const t = clean(body.token, 120);
  if (t) {
    const o = await rpc("ops_authorize", { p_token: t });
    if (o && o.ok) return { code: norm(body.code), ops: true };
  }
  const s = clean(body.session, 120);
  if (s) {
    const c = await rpc("agent_session_code", { p_token: s });
    if (typeof c === "string" && c) return { code: norm(c), ops: false };
  }
  return { code: "", ops: false };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const action = clean(body.action, 20) || "get";
    const who = await callerCode(body);
    const code = who.code;
    const month = /^\d{4}-\d{2}$/.test(clean(body.month, 7)) ? clean(body.month, 7) : thisMonth();
    if (!code) return json({ ok: false, needs_session: true, error: "Sign in again to continue." }, 401);

    if (action === "get") {
      const out: Record<string, unknown> = {};
      for (const scope of SCOPES) {
        const owner = await rpc("goal_owner_for", { p_code: code, p_scope: scope });
        const ownerKey = (typeof owner === "string") ? owner : null;
        if (!ownerKey) {
          // e.g. an agent with nobody above them who is an MD yet — the level simply does not apply
          out[scope] = { owner: null, targets: {}, can_edit: false, why: "No " + LABEL[scope].toLowerCase() + " is set up for you yet." };
          continue;
        }
        const perm = await rpc("goal_can_edit", { p_code: code, p_scope: scope, p_owner: ownerKey });
        const rows = await getJSON(`goals?scope=eq.${scope}&owner=eq.${encodeURIComponent(ownerKey)}&month=eq.${month}&select=metric,target,set_by_name,updated_at`);
        const targets: Record<string, number> = {};
        let setBy = "", setAt = "";
        for (const r of rows) { targets[String(r.metric)] = Number(r.target) || 0; if (!setBy && r.set_by_name) { setBy = String(r.set_by_name); setAt = String(r.updated_at || ""); } }
        out[scope] = { owner: ownerKey, targets, can_edit: !!(perm && perm.ok), why: (perm && perm.why) || "", set_by: setBy, set_at: setAt };
      }
      return json({ ok: true, month, levels: out });
    }

    if (action === "set") {
      const scope = clean(body.scope, 12);
      const metric = clean(body.metric, 12);
      if (SCOPES.indexOf(scope) < 0) return json({ ok: false, error: "Unknown goal level." });
      if (METRICS.indexOf(metric) < 0) return json({ ok: false, error: "Unknown metric." });
      const n = Number(String(body.target ?? "").replace(/[^0-9.]/g, ""));
      const target = isNaN(n) ? 0 : Math.max(0, Math.round(n * 100) / 100);

      const owner = await rpc("goal_owner_for", { p_code: code, p_scope: scope });
      const ownerKey = (typeof owner === "string") ? owner : null;
      if (!ownerKey) return json({ ok: false, error: "There is no " + LABEL[scope].toLowerCase() + " to set goals for yet." });

      // The real gate. The UI greys out what you cannot edit, but it is only a courtesy —
      // this runs on every write regardless of what the browser sent.
      const perm = await rpc("goal_can_edit", { p_code: code, p_scope: scope, p_owner: ownerKey });
      if (!perm || !perm.ok) return json({ ok: false, error: (perm && perm.why) || "You cannot set that goal." });

      const whoRow = await getJSON(`tracker_agents?code=eq.${encodeURIComponent(code)}&select=first_name,last_name&limit=1`);
      const name = whoRow[0] ? `${whoRow[0].first_name || ""} ${whoRow[0].last_name || ""}`.trim() : code;

      const up = await fetch(`${SUPA}/rest/v1/goals?on_conflict=scope,owner,month,metric`, {
        method: "POST",
        headers: { ...DBH, Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ scope, owner: ownerKey, month, metric, target, set_by: code, set_by_name: name, updated_at: new Date().toISOString() }),
      });
      if (!up.ok) { const t = await up.text(); return json({ ok: false, error: "Could not save.", detail: t.slice(0, 160) }); }
      return json({ ok: true, scope, owner: ownerKey, month, metric, target, set_by_name: name });
    }

    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
