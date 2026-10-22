// hub-typing v4 — "Christopher is typing…" for Team Hub.
//
// Kept out of hub_presence on purpose: hub-api's heartbeat rewrites that
// table's status column on a timer, which would race with a signal whose whole
// life is about four seconds.
//
// v4 (2026-09-30): WHO IS TYPING. Both the code and the display NAME came off the request, so
// anyone could make "Christopher is typing…" appear in any channel — small, but it is still
// putting words in somebody's mouth, and a typing marker in a DM is a claim to be in that DM.
// Identity is now the session token minted at PIN entry, and the name is read from the roster.
//
// POST { action:'set',  session, channel }  -> record that you are typing
// POST { action:'list', session, channel }  -> who else is typing here now
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const clean = (s: unknown, n = 120) => (s ?? "").toString().trim().slice(0, n);
const enc = encodeURIComponent;
async function rpc(fn: string, args: Record<string, unknown>) { try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); return await r.json(); } catch (_) { return null; } }
/* Proof of identity. A session token is proof; a typed code is not. */
async function sessionCode(session: unknown): Promise<string> {
  const s = String(session ?? "").trim().slice(0, 120);
  if (!s) return "";
  const got = await rpc("agent_session_code", { p_token: s });
  return (typeof got === "string") ? norm(got) : "";
}

const WINDOW_MS = 6000;   // a typing mark is stale after six seconds

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    let body: Record<string, unknown> = {};
    if (req.method === "POST") body = await req.json().catch(() => ({}));
    const action = clean(body.action, 20) || "list";
    const code = await sessionCode(body.session);
    const channel = clean(body.channel, 120);
    if (!code) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401);
    if (!channel) return json({ ok: false, error: "missing channel" });
    // A typing marker in a DM is a claim to be in that DM, so check the two sides.
    if (channel.indexOf("dm:") === 0) {
      const sides = channel.slice(3).split("|").map((x) => norm(x));
      if (sides.indexOf(code) < 0) return json({ ok: false, error: "That conversation is not yours." }, 403);
    }

    if (action === "set") {
      // The name shown is read from the roster, never from the request.
      let nm = "";
      try {
        const r = await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${enc(code)}&select=first_name,last_name&limit=1`, { headers: DBH });
        const a = ((await r.json()) || [])[0];
        if (a) nm = `${a.first_name || ""} ${a.last_name || ""}`.trim();
      } catch (_) { /* a missing name just shows the code */ }
      await fetch(`${SUPA}/rest/v1/hub_typing?on_conflict=code`, {
        method: "POST",
        headers: { ...DBH, Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ code, name: nm, channel, at: new Date().toISOString() }),
      });
      return json({ ok: true });
    }

    // list — everyone else marked typing in this channel inside the window
    const cut = new Date(Date.now() - WINDOW_MS).toISOString();
    const ex = await fetch(
      `${SUPA}/rest/v1/hub_typing?channel=eq.${enc(channel)}&at=gte.${enc(cut)}&select=code,name,at`,
      { headers: DBH },
    );
    const rows: Record<string, unknown>[] = (await ex.json()) || [];
    const others = rows.filter((r) => norm(r.code) !== code)
                       .map((r) => ({ code: r.code, name: r.name || r.code }));
    return json({ ok: true, typing: others });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
