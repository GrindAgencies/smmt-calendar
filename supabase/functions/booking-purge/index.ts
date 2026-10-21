// booking-purge v2 — delete an appointment and have it stay deleted, everywhere.
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
//   preview { id }                                   -> what deleting this would clear
//   delete  { id, code | token, by, reason? }
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

/* Who may permanently delete this appointment? The people it actually belongs to, their
   leadership, or Operations. Nobody else — this cannot be undone. */
async function mayDelete(b: any, body: Record<string, unknown>): Promise<boolean> {
  const az = await rpc("ops_authorize", { p_token: String(body.token ?? "") });
  if (az && az.ok) return true;
  const code = norm(body.code || body.by_code);
  if (!code) return false;
  if (code === norm(b.agent_code) || code === norm(b.trainer_code)) return true;
  const a = (await getJSON(`tracker_agents?code=eq.${enc(code)}&select=contract_level,platform_admin`))[0];
  if (!a) return false;
  if (a.platform_admin === true) return true;
  return ["MD", "EMD"].indexOf(norm(a.contract_level)) >= 0;
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

    if (action === "preview") return json({ ok: true, ...summary });
    if (action !== "delete") return json({ ok: false, error: "unknown action" }, 400);

    if (!(await mayDelete(b, body))) {
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
          starts_at: b.starts_at, deleted_by: clean(body.by, 60) || "broker",
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
