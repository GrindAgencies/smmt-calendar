// hub-safety v1 — reporting objectionable content, and blocking a person.
//
// App Store Guideline 1.2 requires both of these in any app that carries content one user
// writes and another reads. Team Hub does, so until now the app was out of compliance and
// — more to the point — an agent on the receiving end of something ugly had nowhere to go
// but Operations, by hand.
//
// Kept separate from hub-api deliberately. hub-api is twenty-five versions deep and carries
// the whole messaging surface; a safety mechanism should not require editing it.
//
// A block is ONE-DIRECTIONAL and PERSONAL. It hides that person from the blocker. It does
// not delete their messages for anyone else, and it does not tell them they were blocked —
// which is the behaviour people expect, and the behaviour that does not escalate a conflict
// inside a working team.
//
// Actions:
//   report       { session, message_id, reason }  -> files a report for Operations
//   block        { session, code }                -> hide this person from me
//   unblock      { session, code }
//   my_blocks    { session }                      -> who I have blocked
//   list_reports { token }                        -> Operations only: the open queue
//   resolve      { token, id, status }            -> Operations only: actioned | dismissed

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
const clean = (s: unknown, n = 400) => (s ?? "").toString().trim().slice(0, n);
const enc = encodeURIComponent;

async function rpc(fn: string, args: Record<string, unknown>) {
  try {
    const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) });
    return await r.json();
  } catch (_) { return null; }
}

/* Identity comes from the session token minted at PIN entry — never from a typed code. */
async function sessionCode(session: unknown): Promise<string> {
  const s = String(session ?? "").trim().slice(0, 120);
  if (!s) return "";
  const got = await rpc("agent_session_code", { p_token: s });
  return (typeof got === "string") ? norm(got) : "";
}

async function isOps(token: unknown): Promise<boolean> {
  const t = String(token ?? "").trim();
  if (!t) return false;
  const r = await rpc("ops_authorize", { p_token: t });
  return !!(r && r.ok);
}

async function db(path: string, init?: RequestInit) {
  const r = await fetch(`${SUPA}/rest/v1/${path}`, { headers: DBH, ...(init || {}) });
  const txt = await r.text();
  try { return txt ? JSON.parse(txt) : null; } catch (_) { return null; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body: Record<string, unknown> = await req.json().catch(() => ({}));
    const action = clean(body.action, 24);

    /* ---- Operations queue ------------------------------------------------ */
    if (action === "list_reports" || action === "resolve") {
      if (!(await isOps(body.token))) return json({ ok: false, error: "Operations only" }, 403);

      if (action === "list_reports") {
        const rows = await db("hub_reports?select=*&order=created_at.desc&limit=200");
        return json({ ok: true, reports: rows || [] });
      }
      const id = parseInt(String(body.id ?? "0"), 10);
      const status = clean(body.status, 12);
      if (!id || ["actioned", "dismissed"].indexOf(status) < 0) {
        return json({ ok: false, error: "id and status (actioned|dismissed) required" }, 400);
      }
      await db(`hub_reports?id=eq.${id}`, {
        method: "PATCH",
        headers: { ...DBH, Prefer: "return=minimal" },
        body: JSON.stringify({ status, handled_by: "OPS", handled_at: new Date().toISOString() }),
      });
      return json({ ok: true });
    }

    /* ---- Everything else is an agent acting for themselves ---------------- */
    const me = await sessionCode(body.session);
    if (!me) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 200);

    if (action === "my_blocks") {
      const rows = await db(`hub_blocks?blocker=eq.${enc(me)}&select=blocked,created_at`);
      return json({ ok: true, blocked: (rows || []).map((r: Record<string, unknown>) => r.blocked) });
    }

    if (action === "block" || action === "unblock") {
      const who = norm(body.code);
      if (!who) return json({ ok: false, error: "Who?" }, 400);
      if (who === me) return json({ ok: false, error: "You cannot block yourself." }, 400);

      if (action === "block") {
        await db("hub_blocks?on_conflict=blocker,blocked", {
          method: "POST",
          headers: { ...DBH, Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify({ blocker: me, blocked: who }),
        });
        return json({ ok: true, blocked: who });
      }
      await db(`hub_blocks?blocker=eq.${enc(me)}&blocked=eq.${enc(who)}`, {
        method: "DELETE", headers: { ...DBH, Prefer: "return=minimal" },
      });
      return json({ ok: true, unblocked: who });
    }

    if (action === "report") {
      const mid = parseInt(String(body.message_id ?? "0"), 10);
      if (!mid) return json({ ok: false, error: "Which message?" }, 400);

      /* Snapshot the message as it stood when reported — the author can edit or delete it
         afterwards, and Operations still needs to see what was actually complained about. */
      const msg = (await db(`hub_messages?id=eq.${mid}&select=id,author_code,channel,body&limit=1`) || [])[0];

      await db("hub_reports", {
        method: "POST",
        headers: { ...DBH, Prefer: "return=minimal" },
        body: JSON.stringify({
          message_id: mid,
          reporter: me,
          author_code: msg ? msg.author_code : null,
          channel: msg ? msg.channel : null,
          reason: clean(body.reason, 300) || "Not specified",
          body_excerpt: msg ? clean(msg.body, 400) : null,
        }),
      });
      return json({ ok: true, message: "Thank you. Operations has been notified and will review this." });
    }

    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
