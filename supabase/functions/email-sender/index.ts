// email-sender v6 (2026-10-23) — RETIRED. It does not send client mail and will not be wired.
//
// Christopher, 2026-10-23: "as for the email correspondance disregard and completely integrate
// calendly. and all callendly links. we will forever use calendly moving forward."
//
// CALENDLY OWNS CLIENT CORRESPONDENCE, PERMANENTLY. Every booking is made in Calendly, and
// Calendly already emails the invitee the confirmation, the reminders, the reschedule and the
// cancellation. This function existed to send a SECOND copy of all of that from our own domain.
// Two systems telling a client about the same appointment is worse than one even when both work;
// with only one of them wired it was just a silent backlog.
//
// The drain is therefore disabled outright rather than left waiting for RESEND_API_KEY. Setting
// that key was, until today, the only thing standing between real clients and a mailshot of
// stale reminders — so the key is no longer a trigger for anything.
//
// WHAT THE QUEUE LOOKED LIKE WHEN IT WAS RETIRED, because it is the argument for retiring it:
// 28 messages had piled up between 2026-07-27 and 2026-10-22, and 26 of them were no longer
// true. 24 were for appointments that had already happened — seven "your appointment is
// tomorrow", seven "in one hour", eight confirmations. The remaining 4 were in the future but
// belonged to a booking that had been CANCELLED, two of them "your appointment is tomorrow"
// reminders that would have arrived beside the cancellation notice for the same meeting. Of 28
// messages the correct number to send was 2.
//
// All 28 are now marked `superseded` rather than deleted, so the record of what was suppressed
// survives. Nothing was ever sent from here.
//
// ENFORCEMENT IS NOT IN THIS FILE, which is the point — a retired sender that still had a live
// drain path would be one edit away from firing. Three things hold the line:
//   1. atlas-api no longer composes client email/SMS (it writes one inapp audit row per kind,
//      which alreadyQueued() needs as the reminder/no-show dedupe key).
//   2. A BEFORE INSERT trigger on outbound_messages, trg_outbound_calendly_only, DIVERTS any
//      email/sms row to inapp and strips to_email/to_phone. It diverts rather than raising,
//      because a hard error inside the booking path would fail a real booking over a message
//      nobody was going to send. This covers every writer, present and future.
//   3. This function's drain is gone.
//
// `status` is kept, and only `status`. Operations can still see what is in the table, and if a
// client-facing channel is ever wanted again this is where to start reading — but it would be a
// product decision to reverse, not a key to set.
//
// v5 (2026-10-22) added a staleness guard — refuse to send a message whose appointment had
// already started or been cancelled. It is preserved below as isStale() and still reported by
// `status`, because it is the diagnostic that proved the queue had rotted, and whoever revisits
// this should see that number before trusting anything in the table.
//
// v4 (2026-10-20, backend audit): AUTH. v3 shipped with `const ADMIN_TOKEN = "2026"` and let
// anyone who posted that string drain the queue. That literal was retired platform-wide on
// 2026-10-05 — six functions had it hardcoded and were fixed then; this was the seventh and was
// missed because no cron calls it, so nothing broke and nothing complained. It authorises via
// ops_authorize(), which accepts a real Operations session or the 'cron' machine token.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

/* How long a message with no appointment attached would have stayed worth sending. */
const STALE_DAYS = 7;
/* A few minutes' slack, so a reminder firing right as the meeting starts was not called stale. */
const GRACE_MS = 10 * 60 * 1000;

const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
function json(o: unknown, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }

async function rpc(fn: string, args: Record<string, unknown>) {
  try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); return await r.json(); }
  catch (_) { return null; }
}
async function opsAuthorized(token: unknown) {
  const r = await rpc("ops_authorize", { p_token: String(token ?? "") });
  return !!(r && r.ok);
}

/* Kept from v5 as the diagnostic that proved the queue had rotted. Nothing sends on its verdict
   any more; `status` reports it so the next person sees how much of the table was already untrue
   before they trust any of it. */
function isStale(m: Record<string, unknown>, now = Date.now()): string {
  const kind = String(m.kind || "").toLowerCase();
  const timeSensitive = kind !== "cancellation";
  const bk = (m as { bookings?: { starts_at?: string; status?: string } | null }).bookings;
  const startsAt = bk && bk.starts_at ? Date.parse(bk.starts_at) : NaN;
  if (bk) {
    const st = String(bk.status || "").trim().toLowerCase();
    if (timeSensitive && /^(cancell?ed|declined|no_?show|no-show)$/.test(st)) return `appointment is ${st}`;
    if (timeSensitive && !isNaN(startsAt) && startsAt + GRACE_MS < now) return `appointment already started (${bk.starts_at})`;
    if (!isNaN(startsAt)) return "";
  }
  if (!timeSensitive) return "";
  const made = Date.parse(String(m.created_at || ""));
  if (!isNaN(made) && made + STALE_DAYS * 86400000 < now) {
    return `queued ${Math.floor((now - made) / 86400000)} days with no appointment attached`;
  }
  return "";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: any = {}; try { body = await req.json(); } catch (_) { body = {}; }
  const token = body.token || new URL(req.url).searchParams.get("token") || "";

  if (!(await opsAuthorized(token))) return json({ ok: false, error: "unauthorized" }, 401);

  /* The only action left. Read-only, and it writes nothing. */
  if (String(body.action || "") === "status") {
    const q = await fetch(
      `${SUPA}/rest/v1/outbound_messages?order=created_at.desc&limit=1000` +
      `&select=id,channel,kind,status,created_at,booking_id,bookings(starts_at,status)`,
      { headers: DBH },
    );
    const rows = (await q.json()) || [];
    const byStatus: Record<string, number> = {};
    let queued = 0, stale = 0;
    for (const m of rows) {
      const st = String(m.status || "unknown");
      byStatus[st] = (byStatus[st] || 0) + 1;
      if (st === "queued") { queued++; if (isStale(m)) stale++; }
    }
    return json({
      ok: true, retired: true, sender: "calendly",
      scanned: rows.length, by_status: byStatus,
      still_queued: queued, of_those_stale: stale,
      note: "Client correspondence is Calendly's, permanently. Nothing is sent from here. A BEFORE INSERT trigger on outbound_messages diverts any email/sms row to inapp, so the queue cannot refill.",
    });
  }

  /* Every other action, including the old `drain`, is refused by name rather than silently
     doing nothing — a caller expecting a send should be told it will never happen. */
  return json({
    ok: false, retired: true, error: "This sender is retired. Calendly sends all client correspondence.",
    note: "Setting RESEND_API_KEY no longer enables anything. Reversing this is a product decision: start by reading the header of this function.",
  }, 410);
});
