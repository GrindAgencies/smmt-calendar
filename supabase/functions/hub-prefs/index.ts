// hub-prefs v1 (2026-10-20) — one person's own view of their chat list: pins and hides.
//
// ROUND TWO, tasks 3 and 4. Elijah: press and hold a chat to Pin it, pinned ones go to the top;
// and be able to remove a chat from your own list, with it coming back "when they type in again".
//
// BOTH OF THESE BELONG TO ONE PERSON. Nothing here changes what anybody else sees, nobody's
// membership, and no message. Hiding is not leaving, and it is not deleting: the conversation,
// its history and everyone else's view are untouched. The brief is explicit that a "Delete"
// that quietly means "hide from me" is the wrong thing to build, so the server never deletes
// anything on this path.
//
// THE HARD PART IS KNOWING WHAT "NEW MESSAGE" MEANS.
// A wall-clock timestamp cannot answer it. Phone clocks disagree with the server's, a reconnect
// replays messages that are not new, an edit touches an old row, and events arrive out of order.
// hub_messages.id is a server sequence, so hiding records the NEWEST ID THAT EXISTED at that
// moment and a chat returns only when some message carries a HIGHER one. A replayed, cached,
// edited or duplicated older message can never clear that bar, and a typing indicator is not a
// message at all so it cannot either — which is what Elijah actually described.
//
// A chat that has genuinely resurfaced has its hidden row DELETED rather than being filtered
// back in on every list: otherwise the same conversation would be re-evaluated for ever and
// would flicker back into hiding whenever a query raced a write.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const enc = encodeURIComponent;
const MAX_PINS = 50;

/* A conversation key is a channel name or a dm:A|B pair. Keep it to what the hub actually
   produces so a crafted value cannot be used to write rows against odd keys. */
const okChannel = (s: unknown) => {
  const v = (s ?? "").toString().trim();
  return v.length > 0 && v.length <= 160 && /^[A-Za-z0-9_:|.\-]+$/.test(v);
};

async function getJSON(path: string) { try { const r = await fetch(`${SUPA}/rest/v1/${path}`, { headers: DBH }); return (await r.json()) || []; } catch (_) { return []; } }
async function rpc(fn: string, args: Record<string, unknown>) { try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); return await r.json(); } catch (_) { return null; } }

/* Identity is the session minted at PIN entry. A typed code is not proof — and here it would
   let anyone rearrange or empty somebody else's chat list. */
async function whoIs(body: any): Promise<string> {
  const t = String(body.token ?? "").trim();
  if (t) { const r = await rpc("ops_authorize", { p_token: t }); if (r && r.ok) return norm(body.code) || norm(r.code); }
  const s = String(body.session ?? "").trim().slice(0, 120);
  if (!s) return "";
  const got = await rpc("agent_session_code", { p_token: s });
  return (typeof got === "string") ? norm(got) : "";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: any = {}; try { body = req.method === "POST" ? await req.json() : {}; } catch (_) { body = {}; }

  const me = await whoIs(body);
  if (!me) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401);

  const action = String(body.action || "list");
  const channel = String(body.channel ?? "").trim();

  /* ------------------------------------------------------------------ list ----
     Returns this person's pins, and the hides that STILL apply. Anything that has
     genuinely moved on is un-hidden here and reported, so the caller can show it again. */
  if (action === "list") {
    const pins = await getJSON(`hub_pins?code=eq.${enc(me)}&select=channel,pinned_at&order=pinned_at.desc`);
    const hid = await getJSON(`hub_thread_hidden?code=eq.${enc(me)}&select=channel,hidden_at,hidden_last_id`);

    const stillHidden: string[] = [];
    const resurfaced: string[] = [];

    for (const h of hid) {
      const ch = String(h.channel || "");
      if (!ch) continue;
      const boundary = Number(h.hidden_last_id);
      /* An older row with no boundary recorded cannot be judged by sequence. Rather than
         guess, fall back to its timestamp for that one row only. */
      let isNew = false;
      if (Number.isFinite(boundary)) {
        const newer = await getJSON(`hub_messages?channel=eq.${enc(ch)}&id=gt.${boundary}&deleted=not.eq.true&select=id&limit=1`);
        isNew = newer.length > 0;
      } else if (h.hidden_at) {
        const newer = await getJSON(`hub_messages?channel=eq.${enc(ch)}&created_at=gt.${enc(String(h.hidden_at))}&select=id&limit=1`);
        isNew = newer.length > 0;
      }
      if (isNew) {
        resurfaced.push(ch);
        /* Clear it once, here, instead of re-deciding on every list. */
        await fetch(`${SUPA}/rest/v1/hub_thread_hidden?code=eq.${enc(me)}&channel=eq.${enc(ch)}`, { method: "DELETE", headers: { ...DBH, Prefer: "return=minimal" } }).catch(() => {});
      } else {
        stillHidden.push(ch);
      }
    }

    return json({
      ok: true, code: me,
      pinned: pins.map((p: any) => String(p.channel)),
      pinned_at: Object.fromEntries(pins.map((p: any) => [String(p.channel), p.pinned_at])),
      hidden: stillHidden,
      resurfaced,
    });
  }

  if (!okChannel(channel)) return json({ ok: false, error: "Which conversation?" }, 400);

  /* ------------------------------------------------------------------- pin ---- */
  if (action === "pin" || action === "unpin") {
    if (action === "unpin") {
      const d = await fetch(`${SUPA}/rest/v1/hub_pins?code=eq.${enc(me)}&channel=eq.${enc(channel)}`, { method: "DELETE", headers: { ...DBH, Prefer: "return=minimal" } });
      return json({ ok: d.ok, pinned: false, channel });
    }
    const have = await getJSON(`hub_pins?code=eq.${enc(me)}&select=channel`);
    if (have.length >= MAX_PINS && !have.some((p: any) => String(p.channel) === channel)) {
      return json({ ok: false, error: `That is the limit of ${MAX_PINS} pinned chats.` });
    }
    const r = await fetch(`${SUPA}/rest/v1/hub_pins?on_conflict=code,channel`, {
      method: "POST", headers: { ...DBH, Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ code: me, channel, pinned_at: new Date().toISOString() }),
    });
    return json({ ok: r.ok, pinned: true, channel });
  }

  /* ------------------------------------------------------------------ hide ---- */
  if (action === "hide") {
    /* The boundary is taken NOW, server-side, from the sequence itself. A message arriving
       while this request is in flight gets a higher id than the one we record, so it counts
       as new and the chat comes straight back — which is the right outcome for that race. */
    const top = await getJSON(`hub_messages?channel=eq.${enc(channel)}&select=id&order=id.desc&limit=1`);
    const boundary = top[0] ? Number(top[0].id) : 0;
    const r = await fetch(`${SUPA}/rest/v1/hub_thread_hidden?on_conflict=code,channel`, {
      method: "POST", headers: { ...DBH, Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ code: me, channel, hidden_at: new Date().toISOString(), hidden_last_id: boundary }),
    });
    /* The pin is deliberately left alone. Hiding suppresses a pinned chat too, and when a real
       message brings it back it returns to the pinned area rather than losing its place. */
    return json({ ok: r.ok, hidden: true, channel, boundary });
  }

  if (action === "unhide") {
    const d = await fetch(`${SUPA}/rest/v1/hub_thread_hidden?code=eq.${enc(me)}&channel=eq.${enc(channel)}`, { method: "DELETE", headers: { ...DBH, Prefer: "return=minimal" } });
    return json({ ok: d.ok, hidden: false, channel });
  }

  return json({ ok: false, error: "unknown action" }, 400);
});
