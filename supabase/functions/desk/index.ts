// desk v2 (2026-09-07) — the Watchtower behind the help desk.
//
// Nothing watched this platform. Every problem found before today — booking reminders
// repeating every 15 minutes, 2,147 requests an hour per open Team Hub, any agent able to
// rewrite anyone's task, the Home sidebar filling the screen — was found by a human
// looking. This runs those checks on a schedule instead.
//
// Actions:
//   error  { code,name,page,message,source,line,col,stack }  -> record a page error an agent hit
//   scan   { token }                                          -> run the checks, save a snapshot, alert
//   status { session | token }                                -> latest snapshot (the assistant reads this)
//
// ALERTING RULE, learned the hard way: only announce a finding the FIRST time it appears.
// A monitor that repeats the same warning every 15 minutes is a spammer, and spammers get
// muted — which is worse than no monitor at all. Standing known conditions (the client
// email queue with no provider wired) are reported as metrics, never as alerts.
//
// v2 (2026-10-15): `status` is the DEFAULT action and answered anonymously, so the platform's
// own health report — every open finding, with detail — was readable by anyone who posted an
// empty body. That is a map of where this system is weak, handed to whoever asks. It needs a
// session now.
//
// `error` stays deliberately open, and must. It fires when a page has just broken, sometimes
// before anyone has signed in, and a crash reporter that needs a working session is a crash
// reporter that goes quiet exactly when it matters. It is write-only, capped and deduped in
// the database, and returns nothing a caller could learn from.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const clean = (s: unknown, n = 500) => (s ?? "").toString().trim().slice(0, n);
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const OPS_CHANNEL = "operations";

async function rpc(fn: string, args: Record<string, unknown>) {
  const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) });
  return await r.json();
}
async function getJSON(path: string) { try { const r = await fetch(`${SUPA}/rest/v1/${path}`, { headers: DBH }); return (await r.json()) || []; } catch (_) { return []; } }
async function opsAuthorized(token: unknown) { try { const j = await rpc("ops_authorize", { p_token: String(token ?? "") }); return !!(j && j.ok); } catch (_) { return false; } }
/* Signed in as an Operations seat, or as themselves. */
async function signedIn(body: Record<string, unknown>): Promise<boolean> {
  if (await opsAuthorized(body.token)) return true;
  const s = String(body.session ?? "").trim().slice(0, 120);
  if (!s) return false;
  try { const got = await rpc("agent_session_code", { p_token: s }); return typeof got === "string" && !!got.trim(); } catch (_) { return false; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    let body: Record<string, unknown> = {};
    if (req.method === "POST") body = await req.json().catch(() => ({}));
    const action = clean(body.action, 20) || "status";

    /* ---- an agent's page threw. Recorded, never blocking, deduped in the DB. ---- */
    if (action === "error") {
      const msg = clean(body.message, 500);
      if (!msg) return json({ ok: false, error: "no message" });
      // Browser extensions and cross-origin scripts produce this with no detail. Useless noise.
      if (/^script error\.?$/i.test(msg)) return json({ ok: true, ignored: true });
      const id = await rpc("log_app_error", {
        p_code: norm(body.code) || null, p_name: clean(body.name, 120) || null,
        p_page: clean(body.page, 120), p_message: msg,
        p_source: clean(body.source, 300), p_line: Number(body.line) || null,
        p_col: Number(body.col) || null, p_stack: clean(body.stack, 4000),
        p_ua: clean(req.headers.get("user-agent") || "", 300),
      });
      return json({ ok: true, id });
    }

    /* ---- latest health, for the assistant and for an Ops view ---- */
    if (action === "status") {
      if (!(await signedIn(body))) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401);
      const rows = await getJSON(`health_snapshots?order=created_at.desc&limit=1&select=status,findings,metrics,created_at`);
      const snap = (rows as any[])[0] || null;
      return json({ ok: true, snapshot: snap });
    }

    /* ---- the scan itself ---- */
    if (action === "scan") {
      if (!(await opsAuthorized(body.token))) return json({ ok: false, error: "unauthorized" }, 401);
      const res = await rpc("health_check", {});
      if (!res || !res.status) return json({ ok: false, error: "health_check failed", detail: res });

      const findings: any[] = Array.isArray(res.findings) ? res.findings : [];
      const keys = findings.map((f) => String(f.key));

      // What was already known at the last scan? Only NEW keys are worth anyone's attention.
      const prev = await getJSON(`health_snapshots?order=created_at.desc&limit=1&select=findings`);
      const prevKeys: string[] = (((prev as any[])[0] || {}).findings || []).map((f: any) => String(f.key));
      const fresh = findings.filter((f) => prevKeys.indexOf(String(f.key)) < 0);
      const cleared = prevKeys.filter((k) => keys.indexOf(k) < 0);

      await fetch(`${SUPA}/rest/v1/health_snapshots`, {
        method: "POST", headers: { ...DBH, Prefer: "return=minimal" },
        body: JSON.stringify({ status: res.status, findings: findings, metrics: res.metrics || {} }),
      });

      let announced = 0;
      if (fresh.length) {
        const worst = fresh.some((f) => f.level === "alert") ? "alert" : "warn";
        const icon = worst === "alert" ? "\u{1F6A8}" : "⚠️";
        const lines = fresh.map((f) => "• " + f.title + (f.detail ? (" — " + f.detail) : "")).join("\n");
        const text = icon + " Platform check — " + fresh.length + " new " + (fresh.length === 1 ? "finding" : "findings") + ":\n" + lines;
        await fetch(`${SUPA}/rest/v1/hub_messages`, {
          method: "POST", headers: { ...DBH, Prefer: "return=minimal" },
          body: JSON.stringify({ channel: OPS_CHANNEL, author_code: "WATCHTOWER", author_name: "\u{1F6E1}️ Watchtower", kind: "system", body: text }),
        }).catch(() => {});
        // Only a genuine alert is worth a phone buzz; warnings wait in the channel.
        if (worst === "alert") {
          await fetch(`${SUPA}/rest/v1/notifications`, {
            method: "POST", headers: { ...DBH, Prefer: "return=minimal" },
            body: JSON.stringify({
              recipient_name: "Christopher Lorenz", recipient_code: "C1991", type: "system",
              title: "Platform alert: " + fresh[0].title,
              body: fresh.map((f) => f.title).join(" · "),
              link: "teamhub.html?c=" + OPS_CHANNEL, actor: "Watchtower", ref_id: "health:" + keys.join(","),
            }),
          }).catch(() => {});
        }
        announced = fresh.length;
      }
      if (cleared.length) {
        await fetch(`${SUPA}/rest/v1/hub_messages`, {
          method: "POST", headers: { ...DBH, Prefer: "return=minimal" },
          body: JSON.stringify({ channel: OPS_CHANNEL, author_code: "WATCHTOWER", author_name: "\u{1F6E1}️ Watchtower", kind: "system",
            body: "✅ Cleared: " + cleared.join(", ") }),
        }).catch(() => {});
      }

      return json({ ok: true, status: res.status, findings: findings.length, announced, cleared: cleared.length, metrics: res.metrics });
    }

    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) { return json({ ok: false, error: String(e) }, 500); }
});
