// ops-fieldtraining — field-training tracker for Operations.
// v7 (2026-10-28): booked / completed / cancelled from Calendly + in-app bookings (see ft_list).
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
    let scoped = !!(sc && sc.scoped);
    let allow = new Set<string>(((sc && Array.isArray(sc.bases)) ? sc.bases : []).map((b: string) => low(b)));
    /* v7: ops_scope() answers "not scoped" for anybody who is not an Ops seat, so until now any
       signed-in AGENT calling this directly received every shop's field trainings. A person who
       is not an Ops seat is scoped by agent_scope() — the platform's one rule — so only the
       hierarchy root and the platform builder see every shop. Client names go to Ops seats and
       those two only. */
    let fullView = az.ops;
    if (!az.ops) {
      const as = await rpc("agent_scope", { p_code: az.code });
      if (as && as.ok === true && as.all === true) { fullView = true; }
      else {
        scoped = true;
        allow = new Set<string>(((as && Array.isArray(as.bases)) ? as.bases : []).map((b: string) => low(b)));
      }
    }

    if (action === "ft_list") {
      /* v7 (2026-10-28): BOOKED / COMPLETED / CANCELLED, FROM EVERY SOURCE.
         Christopher: "adjust the metrics to booked / completed / cancelled so we can see ratio".
         v6 read only `bookings`, whose copy of Calendly stopped around 11 Oct, so ~140 recent
         Calendly field trainings were missing, and its Calendly rows have no agent (Calendly's
         invitee is the CLIENT) so they were listed under the client's name as if an agent.
         Now: Calendly field trainings come from calendly_events (the source of truth; every
         mirrored bookings row exists there, verified), in-app bookings from `bookings` rows that
         are NOT Calendly mirrors, so nothing is counted twice. Each session carries its trainer
         (always known) and its agent (in-app only). The page groups and filters by period. */
      const today = ptToday();
      const nowIso = new Date().toISOString();
      const getAll = async (path: string) => {
        const out: Record<string, unknown>[] = [];
        for (let off = 0; off < 50000; off += 1000) {
          const r = await fetch(`${SUPA}/rest/v1/${path}&limit=1000&offset=${off}`, { headers: DBH });
          const page = await r.json().catch(() => []);
          if (!Array.isArray(page) || !page.length) break;
          out.push(...page); if (page.length < 1000) break;
        }
        return out;
      };
      const roster = await getAll(`tracker_agents?select=code,first_name,last_name,baseshop,emd,md,status&order=code.asc`);
      const rmap: Record<string, Record<string, unknown>> = {};
      for (const a of roster) rmap[norm(a.code)] = a;
      const nameOf = (code: string, fallback: string) => { const a = rmap[norm(code)]; return a ? `${a.first_name || ""} ${a.last_name || ""}`.trim() || fallback : fallback; };
      const ptDate = (iso: string) => { try { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(iso)); } catch (_) { return ""; } };
      const ptTime = (iso: string) => { try { return new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit" }).format(new Date(iso)); } catch (_) { return ""; } };

      const sessions: Record<string, unknown>[] = [];
      // 1) Calendly — trainer is the Calendly host; the invitee is the client.
      const cev = await getAll(`calendly_events?or=(event_type_name.ilike.*field*,name.ilike.*field*)&select=event_uuid,agent_code,agent_name,invitee_name,start_time,status&order=start_time.asc,event_uuid.asc`);
      for (const e of cev) {
        const tc = norm(e.agent_code); const st = low(e.status);
        const at = String(e.start_time || "");
        const outcome = (st === "canceled" || st === "cancelled") ? "cancelled" : (at && at > nowIso ? "upcoming" : "completed");
        sessions.push({ id: "c:" + e.event_uuid, source: "calendly", date: ptDate(at), time: ptTime(at), outcome,
          trainer_code: tc, trainer: nameOf(tc, clean(e.agent_name)), agent_code: "", agent: "", client: fullView ? clean(e.invitee_name) : "",
          baseshop: clean((rmap[tc] || {}).baseshop) });
      }
      // 2) In-app bookings (not Calendly mirrors) — agent and trainer both known.
      const bks = await getAll(`bookings?category=ilike.*field*training*&calendly_event_uuid=is.null&select=id,agent_code,agent_name,trainer_name,trainer_code,date,time,status,notes&order=id.asc`);
      for (const b of bks) {
        const st = low(b.status); const d = clean(b.date);
        let outcome = "booked_unmarked";
        if (st === "completed") outcome = "completed";
        else if (st === "canceled" || st === "cancelled" || st === "declined") outcome = "cancelled";
        else if (st === "no_show" || st === "noshow") outcome = "no_show";
        else if (d >= today) outcome = "upcoming";
        const ac = norm(b.agent_code), tc = norm(b.trainer_code);
        sessions.push({ id: "b:" + b.id, source: "app", date: d, time: clean(b.time), outcome, status: st,
          trainer_code: tc, trainer: clean(b.trainer_name) || nameOf(tc, ""), agent_code: ac, agent: clean(b.agent_name) || nameOf(ac, ""),
          client: "", notes: clean(b.notes), baseshop: clean((rmap[ac] || rmap[tc] || {}).baseshop) });
      }
      // Baseshop seats see their own shop only, decided here, before anything is sent.
      const shown = scoped ? sessions.filter((x) => allow.has(low(x.baseshop))) : sessions;
      shown.sort((a, b) => String(b.date).localeCompare(String(a.date)));
      const count = (k: string) => shown.filter((x) => x.outcome === k).length;
      const totals = { booked: shown.length, completed: count("completed"), cancelled: count("cancelled"), upcoming: count("upcoming"),
                       no_show: count("no_show"), unmarked: count("booked_unmarked"), calendly: shown.filter((x) => x.source === "calendly").length };
      return json({ ok: true, v: 7, scoped, today, sessions: shown, totals });
    }

    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) { return json({ ok: false, error: String(e) }, 500); }
});
