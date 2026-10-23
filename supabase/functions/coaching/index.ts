// coaching v5 (2026-10-22) — the notes a trainer leaves for a trainee after a field training.
//
// v5: EVERY ACTION TRUSTED A TYPED CODE, AND TWO OF THEM CHECKED NOTHING AT ALL.
//
//   These notes are candid written feedback about a named person — "what went well, what to
//   work on". They are among the more personal things this platform stores.
//
//   list     had NO authorisation. `{"action":"list","code":"<anyone>"}` returned up to 300 of
//            that person's coaching notes. Agent codes are printed on the org chart.
//   booking  had NO authorisation either: any appointment id returned its notes.
//   add      read `by_code` from the request and checked whether THAT code belonged to a coach,
//            then stored by_code, by_name and trainer_name exactly as sent — so a note could be
//            written on anybody's record under a real trainer's byline.
//   delete   scoped the delete by a typed `by_code`, so typing a trainer's code deleted the
//            notes they had written.
//
//   Identity now comes from the session minted at PIN entry, or an Operations token, and the
//   byline is read from the roster rather than accepted from the caller.
//
// WHO MAY READ WHAT:
//   your own notes          always — they are about you and you are meant to study them
//   a coach / leader        yes; they are already trusted to WRITE candid feedback about
//                           anyone, so reading is not a wider trust boundary
//   a booking's notes       the agent or the trainer on that booking, a coach, or Operations
//   Operations             everything
//
// No client change was needed: roadmap.html and calendar.html both load session.js, which
// injects the session into these calls already.
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
/* Proof of identity. A session token is proof; a typed code is not — and here a typed code was
   both a read of somebody's private feedback and a forged byline on their record. */
async function _sessionCode(session) {
  const v = String(session ?? "").trim().slice(0, 120);
  if (!v) return "";
  const got = await _rpcAuth("agent_session_code", { p_token: v });
  return (typeof got === "string") ? got.trim().toUpperCase() : "";
}

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
/* The byline, read from the roster rather than accepted from the caller. */
async function rosterName(code: string): Promise<string> {
  const c = norm(code); if (!c) return "";
  try {
    const r = await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${encodeURIComponent(c)}&select=first_name,last_name&limit=1`, { headers: DBH });
    const a = ((await r.json()) || [])[0];
    return a ? `${a.first_name || ""} ${a.last_name || ""}`.trim() : "";
  } catch (_) { return ""; }
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

    /* WHO IS ASKING. Resolved once, before any note is read or written. */
    const isOps = await _opsOk(token);
    const me = isOps ? "" : await _sessionCode(body.session);
    if (!isOps && !me) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401);
    const meIsCoach = isOps ? true : await isCoach(me);

    if (action === "add") {
      /* The author is the verified caller. Operations may still file one on a trainer's
         behalf, which is what support needs, and says so in the byline. */
      const byCode = isOps ? norm(body.by_code) : me;
      const traineeCode = norm(body.trainee_code);
      const text = clean(body.body);
      if (!traineeCode || !text) return json({ ok: false, error: "Missing trainee or note." });
      if (!meIsCoach) return json({ ok: false, error: "Only trainers and senior leaders can leave coaching notes." }, 403);
      /* The name on the note comes from the roster. It used to be whatever the request said,
         so a note could carry a real trainer's name without them writing it. */
      const author = byCode ? await rosterName(byCode) : "";
      const row = {
        trainee_code: traineeCode, trainee_name: (await rosterName(traineeCode)) || clean(body.trainee_name),
        by_code: byCode, by_name: author || clean(body.by_name),
        trainer_name: author || clean(body.trainer_name),
        booking_id: clean(body.booking_id) || null, ft_date: clean(body.ft_date) || null, body: text
      };
      const ins = await fetch(`${SUPA}/rest/v1/coaching_notes`, { method: "POST", headers: { ...DBH, Prefer: "return=representation" }, body: JSON.stringify(row) });
      const r = await ins.json();
      return json({ ok: ins.ok, note: Array.isArray(r) ? r[0] : r });
    }

    if (action === "list") {
      const asked = norm(body.code || url.searchParams.get("code"));
      /* Your own notes by default. Naming somebody else is for a coach or Operations. */
      const code = (isOps || meIsCoach) ? (asked || me) : me;
      if (!code) return json({ ok: false, error: "no code" });
      if (!isOps && !meIsCoach && asked && asked !== me) {
        return json({ ok: false, error: "Those notes are not yours." }, 403);
      }
      const ex = await fetch(`${SUPA}/rest/v1/coaching_notes?trainee_code=eq.${encodeURIComponent(code)}&order=created_at.desc&limit=300`, { headers: DBH });
      return json({ ok: true, notes: (await ex.json()) || [] });
    }

    if (action === "booking") {
      const bid = clean(body.booking_id || url.searchParams.get("booking_id"));
      if (!bid) return json({ ok: true, notes: [] });
      /* Notes about an appointment belong to the two people on it. */
      if (!isOps && !meIsCoach) {
        const bk = ((await (await fetch(`${SUPA}/rest/v1/bookings?id=eq.${encodeURIComponent(bid)}&select=agent_code,trainer_code&limit=1`, { headers: DBH })).json()) || [])[0];
        const mine = bk && (norm(bk.agent_code) === me || norm(bk.trainer_code) === me);
        if (!mine) return json({ ok: false, error: "That appointment is not yours." }, 403);
      }
      const ex = await fetch(`${SUPA}/rest/v1/coaching_notes?booking_id=eq.${encodeURIComponent(bid)}&order=created_at.desc`, { headers: DBH });
      return json({ ok: true, notes: (await ex.json()) || [] });
    }

    if (action === "delete") {
      const id = clean(body.id);
      if (!id) return json({ ok: false, error: "no id" });
      let q = `${SUPA}/rest/v1/coaching_notes?id=eq.${encodeURIComponent(id)}`;
      /* You may delete a note you wrote. The filter uses the VERIFIED code, so typing a
         trainer's code no longer deletes their notes. */
      if (!isOps) q += `&by_code=eq.${encodeURIComponent(me)}`;
      const del = await fetch(q, { method: "DELETE", headers: { ...DBH, Prefer: "return=minimal" } });
      return json({ ok: del.ok, id });
    }

    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
