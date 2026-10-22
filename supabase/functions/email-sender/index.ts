// email-sender v4 — drains the outbound_messages email queue via Resend.
// Safe no-op until RESEND_API_KEY is set. Marks each message sent / failed / skipped.
// SMS (channel=sms) is left queued until a provider (Twilio, gated on A2P) is wired the same way.
//
// v4 (2026-10-20, backend audit): AUTH. v3 shipped with `const ADMIN_TOKEN = "2026"` and let
// anyone who posted that string drain the queue. That literal was retired platform-wide on
// 2026-10-05 — six functions had it hardcoded and were fixed then; this was the seventh and was
// missed because no cron calls it, so nothing broke and nothing complained. It now authorises
// the same way push-send and desk do: ops_authorize(), which accepts a real Operations session
// or the 'cron' machine token. No literal passwords.
//
// NOTE for whoever wires the provider: this function is not on any cron schedule, so the queue
// is never drained even once RESEND_API_KEY exists. Both halves are needed — the key AND a
// schedule that calls this with the cron machine token, matching push-fanout-1min:
//   body := jsonb_build_object('action','drain','token',(select token from ops_machine_tokens where name='cron'))
// Until then 13 client emails and 5 SMS sit queued (oldest 2026-07-27) and no client receives them.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND = (Deno.env.get("RESEND_API_KEY") || "").trim();
const FROM   = Deno.env.get("EMAIL_FROM") || "The Standard Financial Group <onboarding@resend.dev>";

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

async function mark(id: number, status: string, error: string | null, sent: boolean) {
  await fetch(`${SUPA}/rest/v1/outbound_messages?id=eq.${id}`, {
    method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" },
    body: JSON.stringify({ status, error, sent_at: sent ? new Date().toISOString() : null }),
  }).catch(() => {});
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: any = {}; try { body = await req.json(); } catch (_) { body = {}; }
  const token = body.token || new URL(req.url).searchParams.get("token") || "";

  if (!(await opsAuthorized(token))) return json({ ok: false, error: "unauthorized" }, 401);

  /* Reports what is waiting without needing the provider configured, so the queue is
     inspectable from the Ops side instead of being invisible until someone runs SQL. */
  if (String(body.action || "") === "status") {
    const q = await fetch(`${SUPA}/rest/v1/outbound_messages?status=eq.queued&select=channel,kind,created_at&order=created_at.asc&limit=1000`, { headers: DBH });
    const rows = (await q.json()) || [];
    const byChannel: Record<string, number> = {};
    for (const m of rows) byChannel[String(m.channel)] = (byChannel[String(m.channel)] || 0) + 1;
    return json({ ok: true, configured: !!RESEND, queued: rows.length, by_channel: byChannel, oldest: rows[0]?.created_at || null });
  }

  if (!RESEND) return json({ ok: true, configured: false, note: "RESEND_API_KEY not set — nothing sent (safe no-op)." });

  const limit = Math.min(100, Number(body.limit) || 25);
  const dry = body.dry === true; // test mode: report, don't send
  const r = await fetch(`${SUPA}/rest/v1/outbound_messages?status=eq.queued&channel=eq.email&order=created_at.asc&limit=${limit}&select=id,to_email,subject,body,kind`, { headers: DBH });
  const msgs = (await r.json()) || [];
  if (dry) return json({ ok: true, configured: true, dry: true, queued_email: msgs.length });

  let sent = 0, failed = 0, skipped = 0;
  for (const m of msgs) {
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
  return json({ ok: true, configured: true, sent, failed, skipped, scanned: msgs.length });
});
