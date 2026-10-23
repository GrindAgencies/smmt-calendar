// email-sender v5 — drains the outbound_messages email queue via Resend.
// Safe no-op until RESEND_API_KEY is set. Marks each message sent / failed / skipped / stale.
// SMS (channel=sms) is left queued until a provider (Twilio, gated on A2P) is wired the same way.
//
// v5 (2026-10-22): A LOADED GUN AIMED AT CLIENTS. The queue had been filling since July while
// nothing drained it, and this function sent whatever was `queued`, oldest first, with no check
// that the message still made sense. Setting RESEND_API_KEY was the only thing standing between
// real clients and a mailshot of reminders for meetings that already happened.
//
// Measured, not supposed — of the 28 messages queued on 2026-10-22:
//
//   7  "your appointment is tomorrow"   emails   appointment ALREADY PAST
//   7  "your appointment is in an hour" emails   appointment ALREADY PAST
//   5  confirmations                    emails   appointment ALREADY PAST
//   3  confirmations                    SMS      appointment ALREADY PAST
//   2  more reminders                   mixed    appointment ALREADY PAST
//   4  genuinely still upcoming
//
// 24 of 28 were for appointments in the past, and the remaining 4 all belonged to a booking that
// had been CANCELLED. Whoever wired the provider would have sent a client a one-hour warning for
// a July meeting, and a "your appointment is tomorrow" for a meeting that was called off. The
// first anyone would have known is a client replying to ask what the message was about. So of 28
// queued messages the correct number to send is 2 — the two cancellation notices. A dormant
// queue is not a safe queue: it is a queue whose contents quietly go stale, and the drain is
// where that has to be caught.
//
// THE RULE: a time-sensitive message that is no longer true is not sent. It is marked `stale`
// with the reason, so the row survives as a record instead of vanishing or firing.
//
//   appointment already started   -> stale. A reminder for a past meeting is never correct, and
//                                    a confirmation after the fact only confuses.
//   appointment CANCELLED         -> stale. Found while checking the data, and it is the worst
//                                    of the three: all four messages in the queue that were
//                                    still in the future belonged to a CANCELLED booking, two of
//                                    them "your appointment is tomorrow" reminders. A time check
//                                    alone would have sent those — a reminder for a meeting that
//                                    is off, delivered next to the cancellation notice for the
//                                    same meeting.
//   no appointment attached, and
//   older than STALE_DAYS         -> stale. Nothing left to check it against and too old to be
//                                    useful. Cancellations are exempt from all of this: "that
//                                    meeting is off" does not expire the way "it is tomorrow"
//                                    does, and it is the one message a cancelled booking SHOULD
//                                    still send.
//
// The guard runs BEFORE the provider is consulted, so it costs nothing and applies on the very
// first drain. Marking is deliberately not a delete — the next person needs to see that 24
// messages were suppressed and why, which an empty table would not tell them.
//
// NOTE for whoever wires the provider: this function is STILL not on any cron schedule, so the
// queue is never drained even once RESEND_API_KEY exists. Both halves are needed — the key AND a
// schedule that calls this with the cron machine token, matching push-fanout-1min:
//   body := jsonb_build_object('action','drain','token',(select token from ops_machine_tokens where name='cron'))
// Run `{"action":"status"}` first: it now reports how many of the queued messages are stale, so
// you can see what the first drain would suppress before it happens, and `{"dry":true}` reports
// the split without sending. SMS has no sender at all yet; when one is written it needs this same
// guard, which is why isStale() takes a message rather than being inlined into the email loop.
//
// v4 (2026-10-20, backend audit): AUTH. v3 shipped with `const ADMIN_TOKEN = "2026"` and let
// anyone who posted that string drain the queue. That literal was retired platform-wide on
// 2026-10-05 — six functions had it hardcoded and were fixed then; this was the seventh and was
// missed because no cron calls it, so nothing broke and nothing complained. It now authorises
// the same way push-send and desk do: ops_authorize(), which accepts a real Operations session
// or the 'cron' machine token. No literal passwords.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND = (Deno.env.get("RESEND_API_KEY") || "").trim();
const FROM   = Deno.env.get("EMAIL_FROM") || "The Standard Financial Group <onboarding@resend.dev>";

/* How long a message with no appointment attached stays worth sending. Reminders and
   confirmations are about a specific time; a week past its creation it is noise. */
const STALE_DAYS = 7;
/* A few minutes' slack, so a reminder that fires right as the meeting starts still goes. */
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

/* Is this message still true? Takes the message rather than being inlined, because the SMS
   sender that does not exist yet needs exactly this test and must not reinvent it. */
function isStale(m: Record<string, unknown>, now = Date.now()): string {
  const kind = String(m.kind || "").toLowerCase();
  /* "That meeting is cancelled" is worth saying late. "It is tomorrow" is not. */
  const timeSensitive = kind !== "cancellation";
  const bk = (m as { bookings?: { starts_at?: string; status?: string } | null }).bookings;
  const startsAt = bk && bk.starts_at ? Date.parse(bk.starts_at) : NaN;
  if (bk) {
    /* Cancelled, declined, no-showed: nothing to remind anyone about. Spelled "canceled" in
       this table, so both spellings are matched rather than trusting one. */
    const st = String(bk.status || "").trim().toLowerCase();
    if (timeSensitive && /^(cancell?ed|declined|no_?show|no-show)$/.test(st)) {
      return `appointment is ${st}`;
    }
    if (timeSensitive && !isNaN(startsAt) && startsAt + GRACE_MS < now) {
      return `appointment already started (${bk.starts_at})`;
    }
    if (!isNaN(startsAt)) return "";  /* a real, live, future appointment: send it */
  }
  /* No appointment to check against — fall back to the message's own age. */
  if (!timeSensitive) return "";
  const made = Date.parse(String(m.created_at || ""));
  if (!isNaN(made) && made + STALE_DAYS * 86400000 < now) {
    return `queued ${Math.floor((now - made) / 86400000)} days with no appointment attached`;
  }
  return "";
}

async function mark(id: number, status: string, error: string | null, sent: boolean) {
  await fetch(`${SUPA}/rest/v1/outbound_messages?id=eq.${id}`, {
    method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" },
    body: JSON.stringify({ status, error, sent_at: sent ? new Date().toISOString() : null }),
  }).catch(() => {});
}

/* One query shape for both status and drain, so the two can never disagree about what is
   queued or what counts as stale. The embed rides the booking_id foreign key. */
const QUEUED = (extra: string) =>
  `outbound_messages?status=eq.queued${extra}&order=created_at.asc` +
  `&select=id,to_email,subject,body,kind,channel,created_at,booking_id,bookings(starts_at,status)`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: any = {}; try { body = await req.json(); } catch (_) { body = {}; }
  const token = body.token || new URL(req.url).searchParams.get("token") || "";

  if (!(await opsAuthorized(token))) return json({ ok: false, error: "unauthorized" }, 401);

  /* Reports what is waiting without needing the provider configured, so the queue is
     inspectable from the Ops side instead of being invisible until someone runs SQL.
     v5 also reports how much of it is STALE — the number that matters before a first drain. */
  if (String(body.action || "") === "status") {
    const q = await fetch(`${SUPA}/rest/v1/${QUEUED("")}&limit=1000`, { headers: DBH });
    const rows = (await q.json()) || [];
    const byChannel: Record<string, number> = {};
    const staleBy: Record<string, number> = {};
    let stale = 0;
    for (const m of rows) {
      byChannel[String(m.channel)] = (byChannel[String(m.channel)] || 0) + 1;
      if (isStale(m)) { stale++; staleBy[String(m.channel)] = (staleBy[String(m.channel)] || 0) + 1; }
    }
    return json({
      ok: true, configured: !!RESEND, queued: rows.length, by_channel: byChannel,
      stale, stale_by_channel: staleBy, would_send: rows.length - stale,
      oldest: rows[0]?.created_at || null,
      note: stale
        ? `${stale} of ${rows.length} queued messages are no longer true and would be marked stale, not sent.`
        : "Nothing stale in the queue.",
    });
  }

  if (!RESEND) return json({ ok: true, configured: false, note: "RESEND_API_KEY not set — nothing sent (safe no-op)." });

  const limit = Math.min(100, Number(body.limit) || 25);
  const dry = body.dry === true; // test mode: report, don't send
  const r = await fetch(`${SUPA}/rest/v1/${QUEUED("&channel=eq.email")}&limit=${limit}`, { headers: DBH });
  const msgs = (await r.json()) || [];
  if (dry) {
    const stale = msgs.filter((m: Record<string, unknown>) => isStale(m)).length;
    return json({ ok: true, configured: true, dry: true, queued_email: msgs.length, stale, would_send: msgs.length - stale });
  }

  let sent = 0, failed = 0, skipped = 0, stale = 0;
  for (const m of msgs) {
    /* Staleness first: checked before the provider is touched, so a dead reminder costs
       nothing and can never reach a client. */
    const why = isStale(m);
    if (why) { await mark(m.id, "stale", why, false); stale++; continue; }
    if (!m.to_email) { await mark(m.id, "skipped", "no to_email", false); skipped++; continue; }
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: FROM, to: [m.to_email], subject: m.subject || "The Standard Financial Group", text: m.body || "" }),
      });
      if (res.ok) { await mark(m.id, "sent", null, true); sent++; }
      else { const t = await res.text(); await mark(m.id, "failed", t.slice(0, 300), false); failed++; }
    } catch (e) { await mark(m.id, "failed", String(e).slice(0, 300), false); failed++; }
  }
  return json({ ok: true, configured: true, sent, failed, skipped, stale, scanned: msgs.length });
});
