// ops-fieldtraining — field-training tracker for Operations.
// v2 (2026-09-02): authorisation is an Operations session from ops-auth rather than the
// literal "2026" that shipped inside ops.html.
// v3 (2026-09-05): BASESHOP, PROPERLY. Two faults here:
//   1. `baseshop` was being filled with the agent's EMD or MD *name*, not their baseshop.
//      The page then filtered rows with BSSCOPE.indexOf(row.baseshop), comparing a person's
//      name against "TITANS" — which can never match, so that tab's scoping did nothing at all.
//      It now carries the real tracker_agents.baseshop, with the leader names kept separately.
//   2. Scoping is enforced on the server via ops_scope(), so a baseshop seat is not sent other
//      teams' training records in the first place. Master seats and MD/EMD callers are unaffected.
//
// v6 (2026-10-15) — A TYPED CODE IS NOT A CREDENTIAL. The weakest door of the four. The check
//   read, in effect: "is this string a row in tracker_agents? then you are in" — so ANY agent
//   code, and every one of them is printed on the org chart, opened the whole tracker: who is
//   training, with whom, when, and the notes attached. A seat code listed in operations_users
//   did the same thing one level up.
//
//   Emptying operations_users on 14 Oct closed that half and took Operations down with it,
//   because four functions leaned on the same list. The check belongs here instead:
//     · Operations — the session token minted at PIN entry;
//     · anyone else — their own signed-in agent session.
//   Who can see what is unchanged; what changed is that you now have to be the person whose
//   code you are using. Baseshop scoping reads the verified code rather than the typed one.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
function json(o: unknown, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const low = (s: unknown) => (s ?? "").toString().trim().toLowerCase();
const clean = (s: unknown) => (s ?? "").toString().trim();
function ptToday(): string { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date()); }

async function rpc(fn: string, args: Record<string, unknown>) { try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); return await r.json(); } catch (_) { return null; } }

/* Who is asking: an Operations seat, or a person signed in as themselves. Returns the
   verified code, which is what scoping then uses. */
async function authOf(body: any): Promise<{ ok: boolean; code: string; ops: boolean; error?: string }> {
  const t = String(body.token ?? "").trim();
  if (t) {
    const r = await rpc("ops_authorize", { p_token: t });
    if (r && r.ok) return { ok: true, code: norm(r.code), ops: true };
  }
  const s = String(body.session ?? "").trim().slice(0, 120);
  if (!s) return { ok: false, code: "", ops: false, error: "Sign in to open the training tracker." };
  const got = await rpc("agent_session_code", { p_token: s });
  const code = (typeof got === "string") ? norm(got) : "";
  if (!code) return { ok: false, code: "", ops: false, error: "Your session has expired — sign in again." };
  return { ok: true, code, ops: false };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = (req.method === "POST") ? (await req.json().catch(() => ({}))) : {};
    const action = (body.action as string) || "ft_list";

    const az = await authOf(body);
    if (!az.ok) return json({ ok: false, error: az.error || "unauthorized" }, 401);

    // Which baseshops may this caller see? Resolved from the verified identity.
    const sc = await rpc("ops_scope", { p_token: String(body.token || ""), p_code: az.code });
    const scoped = !!(sc && sc.scoped);
    const allow = new Set<string>(((sc && Array.isArray(sc.bases)) ? sc.bases : []).map((b: string) => low(b)));

    if (action === "ft_list") {
      const q = `${SUPA}/rest/v1/bookings?or=(category.ilike.*field training*)&select=id,agent_code,agent_name,trainer_name,trainer_code,date,time,status,notes,category&order=date.desc`;
      const ex = await fetch(q, { headers: DBH });
      const rows: Record<string, unknown>[] = (await ex.json()) || [];
      const rx = await fetch(`${SUPA}/rest/v1/tracker_agents?select=code,first_name,last_name,baseshop,emd,md,status`, { headers: DBH });
      const roster: Record<string, unknown>[] = (await rx.json()) || [];
      const rmap: Record<string, Record<string, unknown>> = {};
      for (const a of roster) rmap[norm(a.code)] = a;
      const today = ptToday();
      const agents: Record<string, Record<string, unknown>> = {};
      const sessions: Record<string, Record<string, unknown>[]> = {};
      for (const b of rows) {
        const ra = rmap[norm(b.agent_code)] || {};
        // Drop other baseshops before they are ever assembled into a response.
        if (scoped && !allow.has(low(ra.baseshop))) continue;
        const code = norm(b.agent_code) || ("NAME:" + clean(b.agent_name).toLowerCase());
        if (!agents[code]) {
          agents[code] = {
            agent_code: clean(b.agent_code), agent_name: clean(b.agent_name) || (ra.first_name ? (ra.first_name + " " + ra.last_name) : ""),
            baseshop: clean(ra.baseshop) || "", md: clean(ra.md) || "", emd: clean(ra.emd) || "",
            active: ra.status ? (ra.status === "active") : true,
            completed: 0, upcoming: 0, canceled: 0, no_show: 0, total: 0, last_completed: "", next_date: "", trainers: {} as Record<string, number>
          };
          sessions[code] = [];
        }
        const a = agents[code]; const st = clean(b.status).toLowerCase(); const d = clean(b.date);
        a.total = (a.total as number) + 1;
        if (b.trainer_name) { const tn = clean(b.trainer_name); (a.trainers as Record<string, number>)[tn] = ((a.trainers as Record<string, number>)[tn] || 0) + 1; }
        if (st === "completed") { a.completed = (a.completed as number) + 1; if (!a.last_completed || d > (a.last_completed as string)) a.last_completed = d; }
        else if (st === "canceled" || st === "cancelled") a.canceled = (a.canceled as number) + 1;
        else if (st === "no_show" || st === "noshow") a.no_show = (a.no_show as number) + 1;
        else if (d >= today) { a.upcoming = (a.upcoming as number) + 1; if (!a.next_date || d < (a.next_date as string)) a.next_date = d; }
        sessions[code].push({ id: b.id, date: d, time: clean(b.time), trainer: clean(b.trainer_name), status: st, notes: clean(b.notes) });
      }
      const list = Object.keys(agents).map((k) => {
        const a = agents[k]; const tr = a.trainers as Record<string, number>;
        a.trainer_list = Object.keys(tr).sort((x, y) => tr[y] - tr[x]);
        a.sessions = sessions[k];
        return a;
      });
      list.sort((x, y) => (y.completed as number) - (x.completed as number) || String(x.agent_name).localeCompare(String(y.agent_name)));
      const shown = list.reduce((t, a) => t + (a.total as number), 0);
      const totals = { agents: list.length, completed: list.reduce((t, a) => t + (a.completed as number), 0), upcoming: list.reduce((t, a) => t + (a.upcoming as number), 0), sessions: shown };
      return json({ ok: true, scoped, agents: list, totals });
    }

    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) { return json({ ok: false, error: String(e) }, 500); }
});
