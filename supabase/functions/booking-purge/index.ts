// booking-purge v6 (2026-10-22) — delete an appointment and have it stay deleted, everywhere.
//
// v5: THE IDENTITY WAS STILL TYPED, AND PREVIEW WAS NEVER GATED AT ALL.
//
//   mayDelete() read `body.code || body.by_code` straight from the request. Agent codes are
//   printed on the org chart, so typing the code of the agent or trainer on an appointment
//   permanently deleted it, and typing ANY MD's or EMD's code permanently deleted ANYBODY's.
//   v2 closed the no-authorisation hole and then decided who you were from a string you sent.
//
//   The v2 note below says preview "stays open to any signed-in caller". It was not open to
//   signed-in callers; it was open to everyone — the early `return` for preview sits above every
//   check. Measured: one credential-free request returned the agent's name, the trainer's name,
//   the category, the date and the time. A comment describing a control is not a control.
//
//   Both now resolve identity from the session token minted at PIN entry, or an Operations
//   token. `deleted_by` on the tombstone records that verified identity instead of whatever
//   name the caller claimed — an audit trail that stores a self-reported name is not one.
//
// v6 (2026-10-22) CLOSES THE BREADTH v5 FLAGGED, AND THE FLAG UNDERSTATED IT.
//
//   v5 said "any MD or EMD may delete any appointment in the company". True, but the test was
//   `contract_level IN ('MD','EMD')` — an EXACT match on an abbreviation, against a free-text
//   COMMISSION field whose values are not written consistently. So it over-granted and
//   under-granted at the same time, and the data says so:
//
//     Edgar Zavala      contract_level "MD", no title        -> could delete all 1,653
//     Elijah Cox        the ORG ROOT, EMD by title, but
//                       contract_level "National Vice
//                       President"                           -> matched nothing, could delete none
//     Christopher       contract_level "Marketing Director"  -> also matched nothing; only
//                                                               platform_admin rescued him
//
//   Leadership is `title` and the org tree; `contract_level` is what somebody is PAID at, and
//   there is a standing rule never to conflate the two — this function was conflating them, which
//   is why the org root had no delete rights while an MD had rights over every shop. The fix is
//   not to swap one field for the other: 126 of 203 records have no title, so `title` alone would
//   have stripped a real MD. Both are read, tolerantly, and the DOWNLINE test is mandatory. Being
//   generous about who counts as a leader is safe when nobody reaches outside their own team.
//
//   v6: the whole company for Operations, platform admins and anyone agent_scope() answers
//   all:true for (which is how the org root gets it, by the one scoping rule rather than a
//   special case); your OWN appointments either side; and for a leader, the appointments of
//   their OWN DOWNLINE, via is_in_downline() — exactly what "their leadership" always meant.
//
//   Measured before changing: each of the 8 leaders could delete all 1,653 appointments; under
//   the downline rule they hold between 0 and 8. All 1,653 resolve to a real agent code on at
//   least one side, so the rule can always be evaluated and no fail-open clause is needed — the
//   v5 worry that narrowing "would refuse deletions that work today" was unfounded. The feature
//   has been used exactly once in its life, by an Associate, through the pre-v2 hole.
//
//   PREVIEW IS NOW GATED THE SAME WAY, because it was gated by nothing per-appointment: any
//   signed-in person could read any appointment's agent, trainer, category, date and time from
//   its id. You may preview what you could delete. Preview exists only as the confirm step
//   before deleting, so the two rights are the same right.
//
// Cancelling only set status='cancelled', and the two existing deletes each covered a single
// source ("this only removes it from your calendar"). Neither actually removed the appointment
// from the trackers that read the bookings table — the Ops bookings tab, the field-training tab,
// and the leaderboard's "Field Trainings Booked" all count rows there.
//
// v2 (2026-09-08) — SECURITY: `delete` HAD NO AUTHORISATION AT ALL. Only `restore` checked a
//   token; anyone who could reach the function and knew (or guessed) an appointment id could
//   permanently delete it — someone else's booking, any booking, with its reminders and coaching
//   notes, and with a Calendly tombstone that stops the sync ever bringing it back. The endpoint
//   is public (verify_jwt false), so this was a live hole in a destructive, irreversible action.
//   Deleting now requires one of: the agent on the booking, the trainer on it, an MD/EMD, a
//   platform admin, or Operations. `preview` is read-only and stays open to any signed-in caller.
//   [SUPERSEDED by v5 and v6 — kept as the record of what was believed at the time. Preview was
//   not open to signed-in callers but to everyone, and it is now gated exactly like delete.]
//
// What a purge clears:
//   bookings            the row itself
//   booking_transfers   cascades on the foreign key
//   outbound_messages   cascades — no reminder fires for a deleted appointment
//   coaching_notes      no constraint, so cleared explicitly or it orphans
//   booking_deletions   a tombstone, so the 30-minute Calendly sync cannot re-import it
//                       (1,499 of 1,625 bookings came from Calendly)
//
// ft_log is deliberately NOT touched: those are curriculum milestones set by hand, not a record
// of this appointment.
//
// Actions:
//   preview { id, session | token }                  -> what deleting this would clear
//   delete  { id, session | token, reason? }         -> `by` is no longer read; the tombstone
//                                                       records the VERIFIED caller
//   restore { calendly_event_uuid, token }           -> lift a tombstone (Ops)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const clean = (s: unknown, n = 200) => (s ?? "").toString().trim().slice(0, n);
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const enc = encodeURIComponent;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function getJSON(path: string) { const r = await fetch(`${SUPA}/rest/v1/${path}`, { headers: DBH }); return (await r.json()) || []; }
async function rpc(fn: string, args: Record<string, unknown>) { try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); return await r.json(); } catch (_) { return null; } }
async function getBooking(id: string) { return (await getJSON(`bookings?id=eq.${enc(id)}&select=*&limit=1`))[0] || null; }
async function countRows(path: string) {
  try {
    const r = await fetch(`${SUPA}/rest/v1/${path}`, { headers: { ...DBH, Prefer: "count=exact", Range: "0-0" } });
    const n = parseInt((r.headers.get("content-range") || "").split("/")[1] || "0", 10);
    return isNaN(n) ? 0 : n;
  } catch (_) { return 0; }
}

/* Proof of identity. A session token is proof; a typed code is not — and here a typed code was
   a permanent, irreversible deletion of somebody else's appointment. */
async function sessionCode(session: unknown): Promise<string> {
  const v = String(session ?? "").trim().slice(0, 120);
  if (!v) return "";
  const got = await rpc("agent_session_code", { p_token: v });
  return (typeof got === "string") ? norm(got) : "";
}
/* Resolved ONCE per request: Operations by token, or a member by their session. */
async function whoIs(body: Record<string, unknown>): Promise<{ ops: boolean; code: string }> {
  const az = await rpc("ops_authorize", { p_token: String(body.token ?? "") });
  if (az && az.ok) return { ops: true, code: norm(az.code) };
  return { ops: false, code: await sessionCode(body.session) };
}
/* Is this person a leader at all?
   `title` is the LEADERSHIP rank and `contract_level` is what somebody is PAID at, and the two
   must never be conflated — but 126 of 203 records have no title, including a real MD whose only
   leadership signal is the commission field. So BOTH are read here, matched tolerantly, because
   the values are free text ("MD" on one record, "Marketing Director" on the next).
   Being generous here is safe: this gate only decides whether the DOWNLINE test below gets to
   run, and that test is never skipped. Generous about who counts as a leader, strict about whose
   appointments they may touch — the strictness that matters lives in is_in_downline(). */
const LEADERISH = /\b(md|emd|marketing director|executive marketing director|nvp|national vice president|sevp|senior executive)\b/;
function isLeaderish(a: Record<string, unknown>): boolean {
  const t = (a.title ?? "").toString().trim().toLowerCase();
  const c = (a.contract_level ?? "").toString().trim().toLowerCase();
  return (!!t && LEADERISH.test(t)) || (!!c && LEADERISH.test(c));
}
/* Who may permanently delete this appointment? The people it actually belongs to, their own
   leadership, or Operations. Nobody else — this cannot be undone.
   Used for `preview` too: you may preview what you could delete. */
async function mayDelete(b: any, me: { ops: boolean; code: string }): Promise<boolean> {
  if (me.ops) return true;
  const code = me.code;                       /* verified, never from the request body */
  if (!code) return false;
  /* Your own appointment, either side of it. */
  if (code === norm(b.agent_code) || code === norm(b.trainer_code)) return true;
  /* The whole company, for the few who really do see the whole company. agent_scope() is the
     one scoping rule, and all:true is how the org root qualifies — by the rule, not by name. */
  const sc = await rpc("agent_scope", { p_code: code });
  if (sc && sc.ok === true && sc.all === true) return true;
  const a = (await getJSON(`tracker_agents?code=eq.${enc(code)}&select=title,contract_level,platform_admin`))[0];
  if (!a) return false;
  if (a.platform_admin === true) return true;
  /* A leader, over their OWN downline. This is what "their leadership" always meant. */
  if (!isLeaderish(a)) return false;
  for (const target of [b.agent_code, b.trainer_code]) {
    const t = norm(target); if (!t) continue;
    const d = await rpc("is_in_downline", { p_leader: code, p_target: t });
    if (d === true) return true;
  }
  return false;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body: Record<string, unknown> = (req.method === "POST") ? (await req.json().catch(() => ({}))) : {};
    const action = clean(body.action, 20) || "preview";

    /* ---------- Operations: undo a deletion so Calendly may re-import ---------- */
    if (action === "restore") {
      const az = await rpc("ops_authorize", { p_token: String(body.token ?? "") });
      if (!(az && az.ok)) return json({ ok: false, error: "Operations only." }, 401);
      const uuid = clean(body.calendly_event_uuid, 120);
      if (!uuid) return json({ ok: false, error: "calendly_event_uuid required" }, 400);
      const d = await fetch(`${SUPA}/rest/v1/booking_deletions?calendly_event_uuid=eq.${enc(uuid)}`, { method: "DELETE", headers: { ...DBH, Prefer: "return=minimal" } });
      return json({ ok: d.ok, restored: uuid, note: "The next Calendly sync may bring this appointment back." });
    }

    /* Everything below reads or destroys a real person's appointment, so it needs a real
       caller. Resolved before the id is even looked at. */
    const me = await whoIs(body);
    if (!me.ops && !me.code) {
      return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401);
    }

    const id = clean(body.id, 60);
    if (!id || !UUID.test(id)) return json({ ok: false, error: "a valid appointment id is required" }, 400);

    const b = await getBooking(id);
    if (!b) return json({ ok: false, error: "That appointment no longer exists." }, 404);

    const reminders = await countRows(`outbound_messages?booking_id=eq.${enc(id)}&select=id`);
    const transfers = await countRows(`booking_transfers?booking_id=eq.${enc(id)}&select=id`);
    const notes = await countRows(`coaching_notes?booking_id=eq.${enc(id)}&select=id`);
    const fromCalendly = !!clean(b.calendly_event_uuid, 120);

    const summary = {
      appointment: {
        agent: b.agent_name || "", trainer: b.trainer_name || "",
        trainer_name: b.trainer_name || "",
        category: b.category || "", starts_at: b.starts_at || null,
        date: b.date || null, time: b.time || null,
        status: b.status || "", source: b.source || "",
      },
      will_clear: {
        booking: 1,
        scheduled_reminders: reminders,
        transfer_records: transfers,
        coaching_notes: notes,
        blocks_calendly_reimport: fromCalendly,
        on_google_calendar: !!clean(b.google_event_id, 120),
      },
    };

    if (action === "preview") {
      /* Gated identically to delete. It used to return the agent, the trainer, the category,
         the date and the time to any signed-in caller holding an id. */
      if (!(await mayDelete(b, me))) {
        return json({ ok: false, error: "That appointment is not yours to manage." }, 403);
      }
      return json({ ok: true, ...summary });
    }
    if (action !== "delete") return json({ ok: false, error: "unknown action" }, 400);

    if (!(await mayDelete(b, me))) {
      return json({ ok: false, error: "Only the agent, the trainer, their leader or Operations can delete this appointment." }, 401);
    }

    // 1. Tombstone FIRST. If the delete succeeds but this failed, the sync would quietly restore
    //    the appointment and the deletion would look flaky.
    if (fromCalendly) {
      await fetch(`${SUPA}/rest/v1/booking_deletions?on_conflict=calendly_event_uuid`, {
        method: "POST",
        headers: { ...DBH, Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({
          booking_id: id, calendly_event_uuid: b.calendly_event_uuid,
          agent_name: b.agent_name, trainer_name: b.trainer_name, category: b.category,
          /* The verified caller, not a claimed name. */
          starts_at: b.starts_at, deleted_by: (me.ops ? ("Operations:" + (me.code || "")) : me.code) || "unknown",
          reason: clean(body.reason, 200),
        }),
      });
    }

    // 2. Coaching notes have no foreign key, so nothing would clean them up.
    if (notes > 0) {
      await fetch(`${SUPA}/rest/v1/coaching_notes?booking_id=eq.${enc(id)}`, { method: "DELETE", headers: { ...DBH, Prefer: "return=minimal" } });
    }

    // 3. The booking itself. Transfers and queued reminders cascade with it.
    const del = await fetch(`${SUPA}/rest/v1/bookings?id=eq.${enc(id)}`, { method: "DELETE", headers: { ...DBH, Prefer: "return=minimal" } });
    if (!del.ok) return json({ ok: false, error: "Could not delete the appointment." }, 500);

    // 4. Tell both sides it is gone, so it disappears from their view and their notifications
    //    agree with their calendar.
    const note = async (to: unknown, title: string, text: string) => {
      if (!to) return;
      try {
        await fetch(`${SUPA}/rest/v1/notifications`, {
          method: "POST", headers: { ...DBH, Prefer: "return=minimal" },
          body: JSON.stringify({ recipient_code: to, title, body: text, created_at: new Date().toISOString() }),
        });
      } catch (_) { /* never undo a delete over a notification */ }
    };
    const when = `${b.date || ""}${b.time ? " at " + b.time : ""}`;
    const cat = b.category || "Appointment";
    await note(b.agent_code || null, `Removed: ${cat}`, `${when} with ${b.trainer_name || "your trainer"} has been removed from the calendar.`);
    await note(b.trainer_code || null, `Removed: ${cat}`, `${when} with ${b.agent_name || "an agent"} has been removed from the calendar. The slot is open again.`);

    const still = await getBooking(id);
    return json({
      ok: !still,
      deleted: !still,
      ...summary,
      note: fromCalendly
        ? "Deleted, and the Calendly sync is blocked from bringing it back."
        : "Deleted. The slot is open again.",
    });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
