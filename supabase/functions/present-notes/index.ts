// present-notes v1 — an agent's own notes against a presentation slide.
//
// The company decks and their approved scripts are shared and must never be edited by an
// individual: they are compliance material. This sits beside them. Each agent gets their
// own line against each slide — the reminder about the client in front of them, the phrasing
// that works for them — and nobody else ever sees it.
//
// Actions:
//   get  { session, key }               -> { notes: { "<slide>": "text", ... } }
//   save { session, key, slide, note }  -> upsert one slide's note (empty note deletes it)

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

/* Identity from the session token minted at PIN entry — never a typed code. Without this a
   person could read anybody's private notes by guessing an agent code. */
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
    const presKey = String(body.key ?? "").trim().slice(0, 80);
    if (!presKey) return json({ ok: false, error: "Which presentation?" }, 400);

    const me = await sessionCode(body.session);
    if (!me) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 200);

    if (action === "get") {
      const r = await fetch(
        `${SUPA}/rest/v1/presenter_notes?code=eq.${enc(me)}&pres_key=eq.${enc(presKey)}&select=slide,note`,
        { headers: DBH },
      );
      const rows = (await r.json()) || [];
      const notes: Record<string, string> = {};
      for (const row of rows) notes[String(row.slide)] = String(row.note ?? "");
      return json({ ok: true, notes });
    }

    if (action === "save") {
      const slide = parseInt(String(body.slide ?? ""), 10);
      if (!Number.isFinite(slide) || slide < 0 || slide > 5000) {
        return json({ ok: false, error: "Which slide?" }, 400);
      }
      const note = String(body.note ?? "").slice(0, 4000);

      /* An emptied note is a deletion, not a blank row. Keeps the table honest and means
         clearing a note actually removes it rather than leaving an empty husk behind. */
      if (!note.trim()) {
        await fetch(
          `${SUPA}/rest/v1/presenter_notes?code=eq.${enc(me)}&pres_key=eq.${enc(presKey)}&slide=eq.${slide}`,
          { method: "DELETE", headers: { ...DBH, Prefer: "return=minimal" } },
        );
        return json({ ok: true, cleared: true });
      }

      await fetch(`${SUPA}/rest/v1/presenter_notes?on_conflict=code,pres_key,slide`, {
        method: "POST",
        headers: { ...DBH, Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ code: me, pres_key: presKey, slide, note, updated_at: new Date().toISOString() }),
      });
      return json({ ok: true });
    }

    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
