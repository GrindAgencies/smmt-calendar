// goals-api v4 — Snapshot goals, one accountable owner per level.
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
// v4 (2026-10-26): A BASESHOP OPS SEAT SETS GOALS FOR ITS OWN SHOP ONLY. v3 let every Ops
// token through, so the TITANS seat could rewrite SUMMIT's numbers and the company-wide
// HIERARCHY goal. Master seats (0000, C1991) keep the v3 behaviour exactly.
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

/* v4 (2026-10-26): which baseshops an Ops token may act on. null = company-wide (master seat or
   machine token). ops_scope expands each seat base through baseshop_groups, the same way every
   other scoped Ops screen does, so GRIND's seat still reaches SMMT/SUMMIT. */
async function seatBases(token: string): Promise<string[] | null> {
  const sc = await rpc("ops_scope", { p_token: token });
  if (sc && sc.seat && !sc.scoped) return null;
  return Array.isArray(sc?.bases) ? sc.bases.map((b: unknown) => norm(b)) : [];
}
async function baseOf(code: string): Promise<string> {
  if (!code) return "";
  const r = await getJSON(`tracker_agents?code=eq.${encodeURIComponent(code)}&select=baseshop&limit=1`);
  return norm(r[0]?.baseshop);
}
/* Can this Ops seat set a goal at this level for this agent? A baseshop seat may touch only goals
   that belong wholly to its shop: never HIERARCHY (company-wide), and a team goal only when the
   MD who owns it is in the shop too. */
async function opsMayEdit(bases: string[] | null, agent: string, scope: string, ownerKey: string) {
  if (bases === null) return { ok: true };
  const deny = { ok: false, why: "Your Operations seat covers " + (bases.join(", ") || "no baseshop") + " only." };
  if (scope === "hierarchy") return deny;
  const mine = await baseOf(agent);
  if (!mine || bases.indexOf(mine) < 0) return deny;
  if (scope === "baseshop" && bases.indexOf(norm(ownerKey)) < 0) return deny;
  if (scope === "team" && bases.indexOf(await baseOf(ownerKey)) < 0) return deny;
  return { ok: true };
}

/* WHO IS ACTUALLY CALLING. A session token is proof; a GFI code is a public fact printed on the
   org chart. Operations keeps its own door via ops_authorize, because Ops screens act on behalf
   of the whole company rather than as one agent. */
async function callerCode(body: Record<string, unknown>): Promise<{ code: string; ops: boolean; seat?: string; label?: string }> {
  const t = clean(body.token, 120);
  if (t) {
    const o = await rpc("ops_authorize", { p_token: t });
    if (o && o.ok) return { code: norm(body.code), ops: true, seat: String(o.code || ""), label: String(o.label || "Operations") };
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
    const bases = who.ops ? await seatBases(clean(body.token, 120)) : null;

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
        /* v3 (2026-10-26): Operations sets any goal at any level. It used to be judged as the
           agent it named, so Ops could only set what that agent could already set themselves.
           v4: "any goal" now means master seats only; a baseshop seat is held to its shop. */
        const perm = who.ops ? await opsMayEdit(bases, code, scope, ownerKey) : await rpc("goal_can_edit", { p_code: code, p_scope: scope, p_owner: ownerKey });
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
      const perm = who.ops ? await opsMayEdit(bases, code, scope, ownerKey) : await rpc("goal_can_edit", { p_code: code, p_scope: scope, p_owner: ownerKey });
      if (!perm || !perm.ok) return json({ ok: false, error: (perm && perm.why) || "You cannot set that goal." });

      const whoRow = await getJSON(`tracker_agents?code=eq.${encodeURIComponent(code)}&select=first_name,last_name&limit=1`);
      const name = who.ops ? (who.label || "Operations")
        : (whoRow[0] ? `${whoRow[0].first_name || ""} ${whoRow[0].last_name || ""}`.trim() : code);
      const setBy = who.ops ? `OPS:${who.seat || "?"}` : code;

      const up = await fetch(`${SUPA}/rest/v1/goals?on_conflict=scope,owner,month,metric`, {
        method: "POST",
        headers: { ...DBH, Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ scope, owner: ownerKey, month, metric, target, set_by: setBy, set_by_name: name, updated_at: new Date().toISOString() }),
      });
      if (!up.ok) { const t = await up.text(); return json({ ok: false, error: "Could not save.", detail: t.slice(0, 160) }); }
      return json({ ok: true, scope, owner: ownerKey, month, metric, target, set_by_name: name });
    }

    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
