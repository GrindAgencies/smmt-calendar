// hub-unread v7 — per-channel unread counts AND the last line of each conversation.
//
// Deliberately a separate function rather than another action bolted onto the
// 40KB hub-api: this is read-only and keeps a live chat function untouched.
//
// POST { read: { "<channel>": <lastSeenMessageId>, ... }, session: "<session token>" }
//   -> { ok, counts: { channel: n }, last: { channel: maxId },
//        preview: { channel: { body, name, at, mine } }, total }
// Messages you wrote yourself never count as unread.
//
// v2 (2026-09-10) BASESHOP ISOLATION. v1 returned a count for EVERY channel it found, so the reply
// to a TITANS agent listed grind_announcements, smmt_announcements, scaped_announcements and
// elevate_announcements — every other shop's room, with how much traffic each was carrying — plus
// the DM key of every other person in the company (dm:A1553|KYLE, dm:C3598|KYLE …), which is a map
// of who is talking to whom. hub-api's hub_channels was already correctly scoped, so the unread
// badge was leaking rooms the channel list itself refused to show.
//
// v5 (2026-09-30) — TWO REMAINING WAYS ROUND v2's SCOPING:
//   1. WHO. The scope was computed from a typed `code`, and GFI codes are printed on the org chart,
//      so typing a colleague's code returned THEIR channel map — including which DMs they have open
//      and how much unread traffic is in each. That is the same who-talks-to-whom leak v2 closed,
//      through the front door.
//   2. THE `known` ESCAPE HATCH. maySee() ended with `return known.has(ch)`, and `known` was built
//      from the channel keys the CALLER sent. So a caller could name any channel at all — a DM
//      between two other people — and have it counted, learning that it exists and how active it
//      is. Its real purpose was only private c_ rooms, whose membership hub_channels had already
//      checked, so it is now limited to exactly those.
//
// v6 (2026-10-19) — THE LAST LINE OF EACH CONVERSATION.
//   The phone layout lists conversations the way a messaging app does: name, the last thing said,
//   and when. Only the last message ID was ever returned, so every row read "No messages yet" with
//   no time against it — the page was asking a question this function had never answered.
//
//   It is answered here rather than with a second request because this function ALREADY walks
//   every message newest-first to count unreads: the first undeleted row it meets for a channel
//   IS that channel's last message. Three more columns on the same query, no extra round trip,
//   and the preview inherits maySee() exactly — a DM's last line can only ever reach the two
//   people in it.
//
//   Your OWN last message is the preview when you spoke last, as every messenger does. That is
//   why the preview is captured BEFORE the "your own messages are never unread" skip: the two
//   rules look similar and mean opposite things.
//
// v7 (2026-10-26) — c_ ROOMS ARE CHECKED AGAINST THE REGISTRY, NOT THE CALLER'S WORD.
//   v5 narrowed `known` to c_ rooms on the reasoning that the client could only hold a c_ key
//   because hub_channels served it. But `known` was still built from whatever keys the request
//   sent, so naming a private group's id was enough to get its unread count and its LAST LINE
//   (v6's preview) — reading a private group one message at a time. And `sc.all` (the company-
//   wide seats) waved every c_ room through, though v27 of hub-api took rank away as a key to
//   other people's private groups. Now a c_ room counts only if app_settings.hub_channels says
//   it is open, or the caller is in its members or is its creator (byCode) — hub-api
//   canSeeCustom's rule exactly. An Operations token still sees everything, as before.
//
// A channel counts only if it is one of:
//   • a SHARED room (main / operations / leadership) — company-wide by design,
//   • a DM this person is actually in,
//   • a room whose <shop>_ prefix is a baseshop they may see (agent_scope),
//   • a c_ group that is open, or that the caller is a member or the creator of (v7).
// No session means no counts: fail closed.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();

const SHARED = ["main", "operations", "leadership"];
/* Long enough to be useful on one line of a phone, short enough that 150 channels of it is
   still a small reply. The page truncates visually too; this caps what leaves the server. */
const PREVIEW_CHARS = 160;

async function rpc(fn: string, args: Record<string, unknown>) {
  try {
    const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) });
    return await r.json();
  } catch (_) { return null; }
}
async function opsAuthorized(token: unknown) { const t = String(token ?? ""); if (!t) return false; const r = await rpc("ops_authorize", { p_token: t }); return !!(r && r.ok); }
/* Proof of identity. A session token is proof; a typed code is not. */
async function sessionCode(session: unknown): Promise<string> {
  const s = String(session ?? "").trim().slice(0, 120);
  if (!s) return "";
  const got = await rpc("agent_session_code", { p_token: s });
  return (typeof got === "string") ? norm(got) : "";
}
/* The one canonical answer to "which baseshops may this person see" — shared with the other tabs. */
async function agentScope(code: string) {
  const r = await rpc("agent_scope", { p_code: norm(code) });
  if (!r || r.ok !== true) return { ok: false, all: false, bases: [] as string[] };
  return { ok: true, all: !!r.all, bases: Array.isArray(r.bases) ? r.bases.map((x: unknown) => norm(x)) : [] as string[] };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    let body: Record<string, unknown> = {};
    if (req.method === "POST") body = await req.json().catch(() => ({}));

    const isOps = await opsAuthorized(body.token);
    const me = isOps ? norm(body.code) : await sessionCode(body.session);
    const readRaw = (body.read && typeof body.read === "object") ? body.read as Record<string, unknown> : {};
    const read: Record<string, number> = {};
    for (const k of Object.keys(readRaw)) {
      const n = Number(readRaw[k]);
      if (!isNaN(n) && n > 0) read[k] = n;
    }
    if (!isOps && !me) return json({ ok: false, needs_session: true, error: "Please sign in again.", counts: {}, last: {}, preview: {}, total: 0 }, 401);
    const sc = isOps ? { ok: true, all: true, bases: [] as string[] } : await agentScope(me);
    if (!sc.ok) return json({ ok: true, counts: {}, last: {}, preview: {}, total: 0, scope: "unknown" });

    /* v7: the custom-group registry, read once. Every c_ decision below is made from this, never
       from which keys the request happened to send. */
    const customs = new Map<string, Record<string, unknown>>();
    if (!isOps) {
      const cx = await fetch(`${SUPA}/rest/v1/app_settings?key=eq.hub_channels&select=value`, { headers: DBH });
      const crow = ((await cx.json()) || [])[0];
      const list = (crow && crow.value && Array.isArray(crow.value.channels)) ? crow.value.channels : [];
      for (const c of list as Record<string, unknown>[]) if (c && c.id) customs.set(String(c.id), c);
    }
    const mayCustom = (ch: string): boolean => {
      const c = customs.get(ch);
      if (!c) return false;                       // a deleted / unknown group counts for nobody
      if (!c.private) return true;
      if (norm(c.byCode) === me) return true;
      return Array.isArray(c.members) && (c.members as unknown[]).map((x) => norm(x)).indexOf(me) >= 0;
    };

    const maySee = (ch: string): boolean => {
      if (!ch) return false;
      if (isOps) return true;
      // c_ is decided before the company-wide shortcut: rank is not a key to a private group.
      if (ch.indexOf("c_") === 0) return mayCustom(ch);
      if (sc.all) return true;
      if (SHARED.indexOf(ch) >= 0) return true;
      if (ch.indexOf("dm:") === 0) {
        // dm:<CODE>|<CODE> — yours only if your code is one of the two sides.
        const sides = ch.slice(3).split("|").map((x) => norm(x));
        return sides.indexOf(me) >= 0;
      }
      const us = ch.indexOf("_");
      if (us > 0 && sc.bases.indexOf(norm(ch.slice(0, us))) >= 0) return true;
      return false;
    };

    // Newest first, capped. v6 adds author_name, body, attach and created_at so the last line of
    // each conversation comes back with the counts instead of needing its own request.
    const ex = await fetch(
      `${SUPA}/rest/v1/hub_messages?select=id,channel,author_code,author_name,body,attach,created_at,deleted&order=id.desc&limit=8000`,
      { headers: DBH },
    );
    const rows: Record<string, unknown>[] = (await ex.json()) || [];

    const counts: Record<string, number> = {};
    const last: Record<string, number> = {};
    type Prev = { body: string; name: string; at: string; mine: boolean };
    const preview: Record<string, Prev> = {};
    let total = 0;
    const allowed = new Map<string, boolean>();

    for (const r of rows) {
      const ch = String(r.channel || "");
      if (!ch) continue;
      if (!allowed.has(ch)) allowed.set(ch, maySee(ch));
      if (!allowed.get(ch)) continue;
      const id = Number(r.id) || 0;
      if (id > (last[ch] || 0)) last[ch] = id;
      if (r.deleted) continue;

      /* The newest surviving message in this channel, whoever wrote it. Captured BEFORE the
         own-messages skip below: a message of yours is never UNREAD, but it is very much the
         last thing said. */
      if (!preview[ch]) {
        let txt = String(r.body ?? "").replace(/\s+/g, " ").trim();
        if (!txt && r.attach) txt = "\u{1F4CE} Attachment";
        preview[ch] = {
          body: txt.slice(0, PREVIEW_CHARS),
          name: String(r.author_name ?? "").trim(),
          at: String(r.created_at ?? ""),
          mine: !!me && norm(r.author_code) === me,
        };
      }

      if (me && norm(r.author_code) === me) continue;   // your own messages are never unread
      if (id > (read[ch] || 0)) {
        counts[ch] = (counts[ch] || 0) + 1;
        total++;
      }
    }

    return json({ ok: true, counts, last, preview, total, scope: sc.all ? "all" : "baseshop" });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
