// hub-inbox v1 — your direct-message conversations, and clearing one away.
//
// Until now a normal agent had no list of their DM threads at all: the sidebar showed only
// the conversation currently open, plus a picker of people to start a new one. If somebody
// messaged you and you navigated away, there was no way back to it. That is the gap this
// closes.
//
// Deliberately small. The listing is one SQL function (dm_threads) rather than a round trip
// per thread, and hiding is a row, not a delete — a thread you clear comes back if that
// person writes again, which is what you want in a working team and not what a delete does.
//
// Actions:
//   threads { session }           -> your conversations, newest first
//   hide    { session, channel }  -> clear it from your list (yours only)
//   unhide  { session, channel }

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const enc = encodeURIComponent;

async function rpc(fn: string, args: Record<string, unknown>) {
  try {
    const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) });
    return await r.json();
  } catch (_) { return null; }
}

/* Identity from the session token minted at PIN entry — never a typed code. */
async function sessionCode(session: unknown): Promise<string> {
  const s = String(session ?? "").trim().slice(0, 120);
  if (!s) return "";
  const got = await rpc("agent_session_code", { p_token: s });
  return (typeof got === "string") ? norm(got) : "";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body: Record<string, unknown> = await req.json().catch(() => ({}));
    const action = String(body.action ?? "").trim();

    const me = await sessionCode(body.session);
    if (!me) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 200);

    if (action === "threads") {
      const rows = await rpc("dm_threads", { p_code: me });
      return json({ ok: true, threads: Array.isArray(rows) ? rows : [] });
    }

    if (action === "hide" || action === "unhide") {
      const ch = String(body.channel ?? "").trim().slice(0, 120);
      /* Only ever your own conversations. Without this check a crafted channel name would
         let somebody hide — or un-hide — a thread they are not part of. */
      if (!ch.startsWith("dm:") || ch.slice(3).split("|").map(norm).indexOf(me) < 0) {
        return json({ ok: false, error: "Not your conversation." }, 403);
      }

      if (action === "hide") {
        await fetch(`${SUPA}/rest/v1/hub_thread_hidden?on_conflict=code,channel`, {
          method: "POST",
          headers: { ...DBH, Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify({ code: me, channel: ch }),
        });
        return json({ ok: true, hidden: ch });
      }
      await fetch(`${SUPA}/rest/v1/hub_thread_hidden?code=eq.${enc(me)}&channel=eq.${enc(ch)}`, {
        method: "DELETE", headers: { ...DBH, Prefer: "return=minimal" },
      });
      return json({ ok: true, restored: ch });
    }

    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
