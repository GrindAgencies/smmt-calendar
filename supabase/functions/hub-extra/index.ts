// hub-extra v5 (2026-10-26) — a baseshop Operations seat pins, reads pins and read receipts only
//   in the private rooms it oversees. Owner decision: masters (0000, C1991) oversee every private
//   group and DM; a shop seat only private groups created by someone in its shops and DMs where
//   either person is. maySee() used to wave every Ops token into every room - pinned message
//   BODIES included. Open rooms, masters and machine tokens: unchanged. Rule = hub-api v31.
// hub-extra v4 — pinned messages and read receipts for Team Hub.
//
// A separate function rather than more actions bolted onto the 40KB hub-api:
// that file drives every message send in a chat people are using right now, and
// it is not worth the risk of a bad edit for two additive features.
//
// v4 (2026-09-30) — FOUR THINGS WERE WRONG, AND ONE OF THEM LEAKED MESSAGE TEXT:
//   · `pins` had NO authentication at all and returned the pinned messages of whatever channel was
//     named — INCLUDING THEIR BODY. A DM id is just the two codes sorted, both printed on the org
//     chart, so a pinned message inside any two colleagues' private conversation was readable by
//     anyone who asked for it.
//   · `seenby` likewise had none: it listed who had read how far in any channel, which exposes who
//     is in a DM and whether they have read it.
//   · `pin` took a typed code and a typed NAME, with no check that the caller could even see the
//     channel — so any message anywhere could be pinned or UNPINNED, stamped with anybody's name.
//   · `seen` took a typed code, so read receipts could be forged for a colleague.
// Everything now needs the session token minted at PIN entry, and every action checks that the
// caller may actually see the channel before it answers.
//
// Actions:
//   pin    { id, channel, session, on }   -> pin / unpin a message
//   pins   { channel, session }           -> the pinned messages in a channel
//   seen   { channel, session, last_id }  -> record how far you have read
//   seenby { channel, session, ids[] }    -> who has seen each of those messages
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const low = (s: unknown) => (s ?? "").toString().trim().toLowerCase();
const clean = (s: unknown, n = 160) => (s ?? "").toString().trim().slice(0, n);
const enc = encodeURIComponent;
const SHARED = ["main", "leadership"];   // "operations" is the Ops room and is NOT shared here

async function rpc(fn: string, args: Record<string, unknown>) { try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); return await r.json(); } catch (_) { return null; } }
/* v5: is this Operations, and how far does it reach? `full` = master seats and non-session
   (machine/legacy) tokens; otherwise the seat's shops via ops_scope, as pin lockAuthority. */
type OpsReach = { ok: boolean; full: boolean; bases: string[]; seat: string };
async function opsReach(token: unknown): Promise<OpsReach> {
  const t = String(token ?? ""); const none = { ok: false, full: false, bases: [], seat: "" };
  if (!t) return none;
  const r = await rpc("ops_authorize", { p_token: t });
  if (!(r && r.ok)) return none;
  const seat = norm(r.code);
  if (r.master === true || r.via !== "session") return { ok: true, full: true, bases: [], seat };
  const sc = await rpc("ops_scope", { p_token: t });
  if (sc && sc.seat && !sc.scoped) return { ok: true, full: true, bases: [], seat };
  const bases: string[] = Array.isArray(sc?.bases) ? sc.bases.map((b: unknown) => norm(b)).filter(Boolean) : [];
  return { ok: true, full: false, bases, seat };
}
/* v5: may this seat oversee this room? Only private groups and DMs are limited. */
async function opsMayRoom(reach: OpsReach, channel: string): Promise<boolean> {
  if (!reach.ok) return false;
  if (reach.full) return true;
  const shopOf = async (codes: string[]): Promise<string[]> => {
    const cs = codes.map((c) => norm(c)).filter(Boolean); if (!cs.length) return [];
    try {
      const r = await fetch(`${SUPA}/rest/v1/tracker_agents?code=in.(${cs.map((c) => `"${enc(c)}"`).join(",")})&select=baseshop`, { headers: DBH });
      return ((await r.json()) || []).map((a: Record<string, unknown>) => norm(a.baseshop)).filter(Boolean);
    } catch (_) { return []; }
  };
  if (channel.indexOf("dm:") === 0) return (await shopOf(channel.slice(3).split("|"))).some((b) => reach.bases.indexOf(b) >= 0);
  if (channel.indexOf("c_") === 0) {
    const c = (await customChannels()).find((x) => String(x.id) === channel);
    if (!c || !c.private) return true;
    const by = norm(c.byCode);
    if (by && (by === reach.seat || by === "OPS:" + reach.seat)) return true;
    return (await shopOf([by])).some((b) => reach.bases.indexOf(b) >= 0);
  }
  return true;
}
/* Proof of identity. A session token is proof; a typed code is not. */
async function sessionCode(session: unknown): Promise<string> {
  const s = String(session ?? "").trim().slice(0, 120);
  if (!s) return "";
  const got = await rpc("agent_session_code", { p_token: s });
  return (typeof got === "string") ? norm(got) : "";
}
async function agentScope(code: string) {
  const r = await rpc("agent_scope", { p_code: norm(code) });
  if (!r || r.ok !== true) return { ok: false, all: false, bases: [] as string[] };
  return { ok: true, all: !!r.all, bases: Array.isArray(r.bases) ? r.bases.map((x: unknown) => norm(x)) : [] as string[] };
}
async function customChannels(): Promise<Record<string, unknown>[]> {
  try {
    const r = await fetch(`${SUPA}/rest/v1/app_settings?key=eq.hub_channels&select=value`, { headers: DBH });
    const rows = await r.json();
    return (rows && rows[0] && Array.isArray(rows[0].value?.channels)) ? rows[0].value.channels : [];
  } catch (_) { return []; }
}
async function agentName(code: string): Promise<string> {
  try {
    const r = await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${enc(code)}&select=first_name,last_name&limit=1`, { headers: DBH });
    const a = ((await r.json()) || [])[0];
    return a ? `${a.first_name || ""} ${a.last_name || ""}`.trim() : "";
  } catch (_) { return ""; }
}

/* May this person see this channel at all? The same shape of rule the rest of the hub uses. */
async function maySee(channel: string, me: string, ops: OpsReach | null): Promise<boolean> {
  if (!channel) return false;
  if (ops) return await opsMayRoom(ops, channel);   // v5: was `return true` for every Ops token
  if (channel === "operations") return false;
  if (SHARED.indexOf(channel) >= 0) return true;
  if (channel.indexOf("dm:") === 0) {
    return channel.slice(3).split("|").map((x) => norm(x)).indexOf(me) >= 0;
  }
  if (channel.indexOf("c_") === 0) {
    const c = (await customChannels()).find((x) => String(x.id) === channel);
    if (!c) return false;
    if (!c.private) return true;
    const members = Array.isArray(c.members) ? (c.members as unknown[]).map((x) => norm(x)) : [];
    return members.indexOf(me) >= 0;
  }
  const us = channel.indexOf("_");
  if (us > 0) {
    const sc = await agentScope(me);
    if (sc.all) return true;
    return sc.bases.indexOf(norm(channel.slice(0, us))) >= 0;
  }
  return false;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    let body: Record<string, unknown> = {};
    if (req.method === "POST") body = await req.json().catch(() => ({}));
    const action = clean(body.action, 20);
    const channel = clean(body.channel, 120);

    const OPS = await opsReach(body.token);
    const isOps = OPS.ok;
    const opsArg = isOps ? OPS : null;
    const me = isOps ? "" : await sessionCode(body.session);
    if (!isOps && !me) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401);

    /* ---------- pin / unpin ---------- */
    if (action === "pin") {
      const id = Number(body.id) || 0;
      if (!id) return json({ ok: false, error: "missing id" });
      // Find the message first: the channel it lives in is what decides access, not what was sent.
      const mr = await fetch(`${SUPA}/rest/v1/hub_messages?id=eq.${id}&select=id,channel&limit=1`, { headers: DBH });
      const msg = ((await mr.json()) || [])[0];
      if (!msg) return json({ ok: false, error: "Message not found." }, 404);
      if (!(await maySee(String(msg.channel || ""), me, opsArg))) {
        return json({ ok: false, error: "That conversation is not yours." }, 403);
      }
      const on = body.on !== false;
      const by = isOps ? (clean(body.name) || "Operations") : (await agentName(me) || me);
      const patch = on
        ? { pinned: true, pinned_by: by, pinned_at: new Date().toISOString() }
        : { pinned: false, pinned_by: null, pinned_at: null };
      const up = await fetch(`${SUPA}/rest/v1/hub_messages?id=eq.${id}`, {
        method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" },
        body: JSON.stringify(patch),
      });
      return json({ ok: up.ok, id, pinned: on });
    }

    if (action === "pins") {
      if (!channel) return json({ ok: false, error: "no channel" });
      if (!(await maySee(channel, me, opsArg))) return json({ ok: false, error: "That conversation is not yours." }, 403);
      const ex = await fetch(
        `${SUPA}/rest/v1/hub_messages?channel=eq.${enc(channel)}&pinned=is.true&deleted=is.false` +
        `&select=id,author_name,author_code,body,kind,pinned_by,pinned_at&order=pinned_at.desc&limit=20`,
        { headers: DBH });
      return json({ ok: true, pins: (await ex.json()) || [] });
    }

    /* ---------- read receipts ---------- */
    if (action === "seen") {
      const code = isOps ? norm(body.code) : me;
      const lastId = Number(body.last_id) || 0;
      if (!code || !channel || !lastId) return json({ ok: false, error: "missing" });
      if (!(await maySee(channel, code, opsArg))) return json({ ok: false, error: "That conversation is not yours." }, 403);
      // Only ever move forward — scrolling back must not retract a receipt.
      const cur = await fetch(`${SUPA}/rest/v1/hub_reads?code=eq.${enc(code)}&channel=eq.${enc(channel)}&select=last_id`, { headers: DBH });
      const row = ((await cur.json()) || [])[0];
      if (row && Number(row.last_id) >= lastId) return json({ ok: true, unchanged: true });
      await fetch(`${SUPA}/rest/v1/hub_reads?on_conflict=code,channel`, {
        method: "POST",
        headers: { ...DBH, Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ code, name: (await agentName(code)) || code, channel, last_id: lastId, at: new Date().toISOString() }),
      });
      return json({ ok: true });
    }

    if (action === "seenby") {
      if (!channel) return json({ ok: false, error: "no channel" });
      if (!(await maySee(channel, me, opsArg))) return json({ ok: false, error: "That conversation is not yours." }, 403);
      const ids: number[] = Array.isArray(body.ids) ? (body.ids as unknown[]).map((x) => Number(x) || 0).filter(Boolean).slice(0, 60) : [];
      const ex = await fetch(`${SUPA}/rest/v1/hub_reads?channel=eq.${enc(channel)}&select=code,name,last_id`, { headers: DBH });
      const rows: Record<string, unknown>[] = (await ex.json()) || [];
      /* 2026-10-26: whoever WROTE a message is not one of its readers. "Seen by 1" under your own
         message, with nobody else in the room, was you. */
      const authors: Record<string, string> = {};
      if (ids.length) {
        const ax = await fetch(`${SUPA}/rest/v1/hub_messages?id=in.(${ids.join(",")})&select=id,author_code`, { headers: DBH });
        for (const m of ((await ax.json()) || []) as Record<string, unknown>[]) authors[String(m.id)] = String(m.author_code || "").toUpperCase();
      }
      const out: Record<string, { count: number; names: string[] }> = {};
      for (const id of ids) {
        const who = rows.filter((r) => Number(r.last_id) >= id && String(r.code || "").toUpperCase() !== authors[String(id)]);
        out[String(id)] = {
          count: who.length,
          names: who.map((r) => String(r.name || r.code)).slice(0, 12),
        };
      }
      return json({ ok: true, seen: out, readers: rows.length });
    }

    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
