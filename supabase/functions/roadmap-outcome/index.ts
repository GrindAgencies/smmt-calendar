// roadmap-outcome v5 (2026-10-21) — the chutes and ladders of My Tracker.
//
// v5: `record` AND `events` HAD NO AUTHENTICATION AT ALL. Only `recent`, the Operations
// summary, was gated. The other two took a bare agent `code` out of the request, and GFI
// codes are printed on the org chart, so with no credential whatsoever anybody could:
//
//   · read any broker's roadmap history — every failed exam, declined application and
//     carrier knock-back, with the notes attached;
//   · POST `record` against any broker, which CLEARS challenges and therefore SLIDES THEIR
//     TRACKER MARKER BACKWARDS. An unauthenticated write to somebody else's progress, and
//     one that looks to the victim exactly like the platform deciding they had regressed.
//
// Verified open before this change: a credential-free `record` reached the step lookup, and
// a credential-free `events` answered. Verified refused after.
//
// Identity is now the session token minted at PIN entry. A typed `code` is IGNORED for a
// member — recording an outcome is self-reporting on your OWN board, which is what the
// existing `by: "self"` stamp already assumed. Operations may still name an agent, which is
// what support needs, and `recent` is unchanged.
//
// NO CLIENT CHANGE WAS NEEDED: session.js wraps window.fetch and already adds `session` to
// every JSON body bound for /functions/v1/, and roadmap.html loads it. The credential was
// arriving all along; this function simply never looked at it.
//
// The roadmap engine is otherwise a one-way street: a step is finished when its
// boxes are ticked, and your position is the first unfinished step. Real life is
// not one-way. People fail the state exam. Licence applications come back.
// Carriers decline. A first client says no.
//
// A level in roadmap_config may declare an `outcome` with two or more options,
// each of which SETS or CLEARS specific challenges. Clearing an earlier
// challenge is what makes the marker slide backwards — the existing engine
// recomputes position from the challenges themselves, so no separate notion of
// "where you are" has to be maintained or kept in sync.
//
// Deliberately narrow: this endpoint can only apply a move that the config
// already describes for that exact level. It cannot write arbitrary progress.
//
// Actions:
//   record { code, level, choice, by?, note? }  -> apply the move, log it
//   events { code }                             -> the history for one broker
//   recent { token, limit? }                    -> Operations: everyone's slips
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// v4 (2026-09-30): the hardcoded "2026" is gone — it was the only lock on the Operations-only
// `events` view and on the unscoped branch of `recent`. Now ops_authorize().
async function _rpcAuth(fn, args) { try { const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`, "Content-Type": "application/json" }, body: JSON.stringify(args) }); return await r.json(); } catch (_) { return null; } }
/* The one authority for "is this really Operations". Replaces a hardcoded literal that could not
   be switched off centrally, which is exactly why five other functions kept working after the
   September cutover was supposed to have closed this. */
async function _opsOk(token) { const t = String(token ?? "").trim(); if (!t) return false; const r = await _rpcAuth("ops_authorize", { p_token: t }); return !!(r && r.ok); }
/* Proof of identity. A session token is proof; a typed code is not — and here a typed code
   was a write to another person's progression. */
async function _sessionCode(session) {
  const v = String(session ?? "").trim().slice(0, 120);
  if (!v) return "";
  const got = await _rpcAuth("agent_session_code", { p_token: v });
  return (typeof got === "string") ? got.trim().toUpperCase() : "";
}

const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const clean = (s: unknown, n = 160) => (s ?? "").toString().trim().slice(0, n);
const enc = encodeURIComponent;

async function loadConfig() {
  const r = await fetch(`${SUPA}/rest/v1/app_settings?key=eq.roadmap_config&select=value`, { headers: DBH });
  const rows = await r.json();
  return (rows && rows[0]) ? rows[0].value : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body: Record<string, unknown> = (req.method === "POST") ? (await req.json().catch(() => ({}))) : {};
    const action = clean(body.action, 20) || "record";

    /* ---------- Operations: everything that has slipped lately ---------- */
    if (action === "recent") {
      if (!(await _opsOk(body.token))) return json({ ok: false, error: "Operations only." }, 401);
      const limit = Math.min(Math.max(Number(body.limit) || 60, 1), 300);
      const r = await fetch(`${SUPA}/rest/v1/tracker_agents?roadmap_events=neq.[]&select=code,first_name,last_name,roadmap_events`, { headers: DBH });
      const rows = (await r.json()) || [];
      const out: Record<string, unknown>[] = [];
      for (const a of rows) {
        const evs = Array.isArray(a.roadmap_events) ? a.roadmap_events : [];
        for (const e of evs) {
          out.push({ ...e, code: norm(a.code), name: `${a.first_name || ""} ${a.last_name || ""}`.trim() });
        }
      }
      out.sort((x, y) => String(y.at || "").localeCompare(String(x.at || "")));
      return json({ ok: true, count: out.length, events: out.slice(0, limit) });
    }

    /* WHOSE BOARD. Resolved once, here, for both of the actions below. Operations may act
       for a named agent; everybody else is themselves and a typed code is ignored. */
    const isOps = await _opsOk(body.token);
    let code = "";
    if (isOps) {
      code = norm(body.code);
      if (!code) return json({ ok: false, error: "code required" }, 400);
    } else {
      code = await _sessionCode(body.session);
      if (!code) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401);
    }

    /* ---------- one broker's history ---------- */
    if (action === "events") {
      const r = await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${enc(code)}&select=roadmap_events&limit=1`, { headers: DBH });
      const a = ((await r.json()) || [])[0];
      if (!a) return json({ ok: false, error: "not found" }, 404);
      const evs = Array.isArray(a.roadmap_events) ? a.roadmap_events : [];
      return json({ ok: true, events: evs });
    }

    /* ---------- record what happened ---------- */
    if (action !== "record") return json({ ok: false, error: "unknown action" }, 400);

    const levelId = clean(body.level, 60);
    const choiceKey = clean(body.choice, 40);
    if (!levelId || !choiceKey) return json({ ok: false, error: "level and choice required" }, 400);

    const config = await loadConfig();
    if (!config) return json({ ok: false, error: "roadmap not configured" }, 500);

    const levels = (config.levels as Record<string, unknown>[]) || [];
    const level = levels.find((l) => String(l.id) === levelId);
    if (!level) return json({ ok: false, error: "no such step" }, 404);

    const outcome = level.outcome as Record<string, unknown> | undefined;
    const options = (outcome && Array.isArray(outcome.options)) ? outcome.options as Record<string, unknown>[] : [];
    const choice = options.find((o) => String(o.key) === choiceKey);
    // Only a move the config already describes for THIS step is allowed.
    if (!choice) return json({ ok: false, error: "that is not an option on this step" }, 400);

    const r = await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${enc(code)}&select=code,first_name,last_name,progress,roadmap_events&limit=1`, { headers: DBH });
    const agent = ((await r.json()) || [])[0];
    if (!agent) return json({ ok: false, error: "not found" }, 404);

    const prog: Record<string, unknown> = (agent.progress && typeof agent.progress === "object") ? agent.progress : {};
    const sets = Array.isArray(choice.sets) ? choice.sets as string[] : [];
    const clears = Array.isArray(choice.clears) ? choice.clears as string[] : [];
    const changed: { set: string[]; cleared: string[] } = { set: [], cleared: [] };

    for (const id of sets) { if (!prog[String(id)]) { prog[String(id)] = 1; changed.set.push(String(id)); } }
    for (const id of clears) { if (prog[String(id)]) { delete prog[String(id)]; changed.cleared.push(String(id)); } }

    const nowIso = new Date().toISOString();
    const events = Array.isArray(agent.roadmap_events) ? agent.roadmap_events : [];
    /* isOps is resolved once at the top of the handler now — see WHOSE BOARD above. */
    const event = {
      level: levelId,
      level_name: String(level.name || ""),
      choice: choiceKey,
      label: String(choice.label || ""),
      tone: String(choice.tone || ""),
      at: nowIso,
      by: isOps ? (clean(body.by, 60) || "Operations") : "self",
      note: clean(body.note, 200),
      cleared: changed.cleared,
      set: changed.set,
    };
    events.push(event);
    // A long tail helps nobody; the recent history is what people act on.
    const trimmed = events.slice(-40);

    const up = await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${enc(code)}`, {
      method: "PATCH",
      headers: { ...DBH, Prefer: "return=minimal" },
      body: JSON.stringify({ progress: prog, roadmap_events: trimmed, updated_at: nowIso, last_activity: nowIso }),
    });
    if (!up.ok) return json({ ok: false, error: "could not save" }, 500);

    // How many times this step has been attempted, so the board can say so.
    const attempts = trimmed.filter((e: Record<string, unknown>) => e.level === levelId).length;

    return json({
      ok: true,
      level: levelId,
      choice: choiceKey,
      tone: choice.tone || "",
      say: choice.say || "",
      next: choice.next || levelId,
      moved_back: (choice.tone === "down"),
      cleared: changed.cleared,
      set: changed.set,
      attempts,
      event,
    });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
