// group-bot v1 (2026-10-28) — group options, members, mute/leave, and each group's own bot with
// admin-scheduled announcements.
//
// WHO MAY DO WHAT. This function does not invent a second permission model. Every request asks
// hub-groups `get` — with the caller's own session or Ops token — which already answers, for this
// one group: is the caller a member at all, may they administer it (`can_edit`: an owner, a
// designated admin of THIS group, or the person who created it), and may they appoint admins
// (`can_assign`: the owner allow-list — Elijah GFI20 — plus the Ops master seat). So:
//
//   regular member   view members · mute · leave (created groups only) · read the bot's name/photo
//   group admin      everything above + edit the bot, create/edit/delete/toggle/test announcements
//   owner            everything above; appointing/removing admins stays in hub-groups (owner-only)
//
// The page hiding a button is a courtesy. Each write below re-checks, so a crafted request
// from a regular member is refused here exactly as the UI would refuse it.
//
// SCHEDULING does not happen here. Saving an announcement only stores it; the database computes
// `next_run_at` (Pacific wall clock, DST-correct) and the pg_cron job `group-announcements-1min`
// calls hub_ann_release(), which posts what is due — with nobody signed in — at most once per
// slot. See the migration group_bot_announcements.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const enc = encodeURIComponent;

const BUCKET = "cal";                                   // public bucket, same home as EMD fliers
const FLYER_PREFIX = "fliers/groups/";
const FLYER_PUBLIC = `${SUPA}/storage/v1/object/public/${BUCKET}/${FLYER_PREFIX}`;
const MAX_FLYER = 5 * 1024 * 1024;
const MAX_BOT_AVATAR = 300_000;
const MAX_ANNS = 25;
const TZ = "America/Los_Angeles";
const ONLINE_MS = 3 * 60 * 1000;
const SYSTEM_CODES = ["POOL", "9999", "DEMO2026", "APLREVIEW"];

async function getJSON(path: string) { try { const r = await fetch(`${SUPA}/rest/v1/${path}`, { headers: DBH }); const j = await r.json(); return Array.isArray(j) ? j : []; } catch (_) { return []; } }
async function rpc(fn: string, args: Record<string, unknown>) { try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); return await r.json(); } catch (_) { return null; } }
async function write(method: string, path: string, body?: unknown, prefer = "return=representation") {
  const r = await fetch(`${SUPA}/rest/v1/${path}`, { method, headers: { ...DBH, Prefer: prefer }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data: any = null; try { data = await r.json(); } catch (_) { data = null; }
  return { ok: r.ok, data };
}

/* Identity: the session minted at PIN entry, or a real Operations token — never a typed code. */
async function whoIs(body: any): Promise<string> {
  const t = String(body.token ?? "").trim();
  if (t) { const r = await rpc("ops_authorize", { p_token: t }); if (r && r.ok) return "OPS:" + norm(r.code); }
  const s = String(body.session ?? "").trim().slice(0, 120);
  if (!s) return "";
  const got = await rpc("agent_session_code", { p_token: s });
  return (typeof got === "string") ? norm(got) : "";
}

/* The one authority on this group: hub-groups `get`, asked as the caller. */
async function access(body: any, channel: string) {
  const payload: Record<string, unknown> = { action: "get", channel };
  if (body.session) payload.session = String(body.session).slice(0, 120);
  if (body.token) payload.token = String(body.token);
  try {
    const r = await fetch(`${SUPA}/functions/v1/hub-groups`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}`, apikey: KEY }, body: JSON.stringify(payload) });
    const j = await r.json();
    if (!j || j.ok !== true) return { member: false, manage: false, assign: false, admins: [] as string[], error: (j && j.error) || "You are not in that group." };
    return { member: true, manage: !!j.can_edit, assign: !!j.can_assign, admins: (j.admins || []).map((a: any) => norm(a.code)), error: "" };
  } catch (_) { return { member: false, manage: false, assign: false, admins: [] as string[], error: "Could not check your access. Try again." }; }
}

const okChannel = (s: unknown) => { const v = (s ?? "").toString().trim(); return v.length > 0 && v.length <= 120 && /^[A-Za-z0-9_.-]+$/.test(v); };
const isDate = (s: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(s ?? "")) && !isNaN(Date.parse(String(s) + "T00:00:00Z"));
const isTime = (s: unknown) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s ?? ""));
const todayPT = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());

async function registry(): Promise<any[]> {
  const rows = await getJSON(`app_settings?key=eq.hub_channels&select=value`);
  const v = rows[0] && rows[0].value;
  return (v && Array.isArray(v.channels)) ? v.channels : [];
}
async function owners(): Promise<string[]> {
  const rows = await getJSON(`app_settings?key=eq.hub_group_owners&select=value`);
  const v = rows[0] && rows[0].value;
  return ((v && Array.isArray(v.codes)) ? v.codes : ["GFI20"]).map(norm);
}
async function botOf(channel: string) {
  const b = (await getJSON(`hub_group_bots?channel=eq.${enc(channel)}&select=channel,name,description,avatar,enabled,updated_at`))[0];
  return b || { channel, name: "Group Bot", description: null, avatar: null, enabled: true, updated_at: null, is_default: true };
}

/* Who is in this group. Created groups (c_*) keep an explicit list. The built-in rooms take their
   audience from the roster: a shop's chat is that shop's active people; the Company Chat is
   everyone active. */
async function memberCodes(channel: string): Promise<{ codes: string[]; creator: string; fromList: boolean }> {
  if (channel.indexOf("c_") === 0) {
    const ch = (await registry()).find((x: any) => String(x && x.id) === channel);
    if (!ch) return { codes: [], creator: "", fromList: true };
    const creator = norm(ch.byCode);
    const codes: string[] = (Array.isArray(ch.members) ? ch.members : []).map(norm).filter(Boolean);
    if (creator && codes.indexOf(creator) < 0) codes.push(creator);
    return { codes, creator, fromList: true };
  }
  const m = channel.match(/^([a-z0-9]+)_chat$/i);
  const filter = m ? `&baseshop=ilike.${enc(m[1])}` : "";
  const rows = await getJSON(`tracker_agents?status=neq.quit&access_status=eq.approved${filter}&select=code&limit=1000`);
  return { codes: rows.map((r: any) => norm(r.code)).filter((c: string) => c && SYSTEM_CODES.indexOf(c) < 0), creator: "", fromList: false };
}

function cleanAnn(a: any) {
  return {
    id: a.id, channel: a.channel, title: a.title, body: a.body, flyer_url: a.flyer_url,
    repeat: a.repeat, weekdays: a.weekdays || [], start_date: a.start_date, end_date: a.end_date,
    send_time: String(a.send_time || "").slice(0, 5), tz: a.tz, enabled: !!a.enabled,
    next_run_at: a.next_run_at, last_sent_at: a.last_sent_at, last_status: a.last_status, last_error: a.last_error,
    updated_at: a.updated_at,
  };
}

/* Validate an announcement payload; returns the row to store or an error string. */
function annRow(b: any): { row?: Record<string, unknown>; error?: string } {
  const title = String(b.title ?? "").trim();
  const text = String(b.body ?? "").replace(/\r\n/g, "\n").trim();
  const flyer = String(b.flyer_url ?? "").trim();
  const repeat = String(b.repeat ?? "weekly");
  const days = (Array.isArray(b.weekdays) ? b.weekdays : []).map((d: unknown) => Number(d)).filter((d: number) => Number.isInteger(d) && d >= 0 && d <= 6);
  const start = String(b.start_date ?? "").trim() || todayPT();
  const end = String(b.end_date ?? "").trim();
  const time = String(b.send_time ?? "").trim().slice(0, 5);
  if (!title) return { error: "Give the announcement a title." };
  if (title.length > 80) return { error: "Keep the title under 80 characters." };
  if (text.length > 2000) return { error: "Keep the message under 2,000 characters." };
  if (flyer && flyer.indexOf(FLYER_PUBLIC) !== 0) return { error: "Upload the flyer here rather than linking to it." };
  if (!text && !flyer) return { error: "Write a message or attach a flyer." };
  if (["once", "daily", "weekly"].indexOf(repeat) < 0) return { error: "Choose how often it repeats." };
  if (repeat === "weekly" && !days.length) return { error: "Pick at least one day of the week." };
  if (!isDate(start)) return { error: "Choose a start date." };
  if (end && !isDate(end)) return { error: "That end date is not valid." };
  if (end && end < start) return { error: "The end date is before the start date." };
  if (!isTime(time)) return { error: "Choose a send time." };
  return { row: {
    title, body: text, flyer_url: flyer || null, repeat,
    weekdays: repeat === "weekly" ? Array.from(new Set(days)).sort() : [],
    start_date: start, end_date: (repeat === "once" ? null : (end || null)), send_time: time, tz: TZ,
  } };
}

/* Magic bytes, not the file name or the browser's claim. */
function sniff(bytes: Uint8Array): { ext: string; mime: string } | null {
  if (bytes.length > 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return { ext: "jpg", mime: "image/jpeg" };
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return { ext: "png", mime: "image/png" };
  if (bytes.length > 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return { ext: "webp", mime: "image/webp" };
  return null;
}

async function postNow(channel: string, botName: string, text: string, flyer: string | null) {
  const r = await write("POST", "hub_messages", {
    channel, author_code: "GBOT", author_name: botName, body: text, kind: "groupbot",
    attach: flyer ? { type: "image", url: flyer, name: "Flyer" } : null, reactions: {},
  });
  const row = Array.isArray(r.data) ? r.data[0] : null;
  return { ok: r.ok && !!row, id: row ? row.id : null };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: any = {}; try { body = await req.json(); } catch (_) { body = {}; }

  const me = await whoIs(body);
  if (!me) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401);
  const action = String(body.action || "");
  const channel = String(body.channel ?? "").trim();
  /* The caller's own muted conversations, for the chat list. Only ever their own rows. */
  if (action === "mutes") {
    const rows = await getJSON(`hub_mutes?code=eq.${enc(me)}&select=channel`);
    return json({ ok: true, muted: rows.map((r: any) => String(r.channel)) });
  }

  if (!okChannel(channel)) return json({ ok: false, error: "Which group?" }, 400);

  const acc = await access(body, channel);
  if (!acc.member) return json({ ok: false, error: acc.error }, 403);
  const needAdmin = () => acc.manage ? null : json({ ok: false, error: "Only this group's admins can manage its bot." }, 403);

  /* ------------------------------------------------------------- context ---- */
  if (action === "ctx") {
    const bot = await botOf(channel);
    const muted = (await getJSON(`hub_mutes?code=eq.${enc(me)}&channel=eq.${enc(channel)}&select=channel`)).length > 0;
    let canLeave = false;
    if (channel.indexOf("c_") === 0 && !me.startsWith("OPS:")) {
      const mc = await memberCodes(channel);
      canLeave = mc.codes.indexOf(me) >= 0 && mc.creator !== me;
    }
    return json({ ok: true, channel, me, can_manage_bot: acc.manage, can_assign: acc.assign, can_leave: canLeave, muted,
      bot: { name: bot.name, description: bot.description, avatar: bot.avatar, enabled: bot.enabled } });
  }

  /* ------------------------------------------------------------- members ---- */
  if (action === "members") {
    const mc = await memberCodes(channel);
    const own = await owners();
    const list = mc.codes.slice(0, 1000);
    const people: any[] = [];
    for (let i = 0; i < list.length; i += 150) {
      const chunk = list.slice(i, i + 150);
      const rows = await getJSON(`tracker_agents?code=in.(${enc(chunk.join(","))})&select=code,first_name,last_name,title,status`);
      people.push(...rows);
    }
    const pres = await getJSON(`hub_presence?code=in.(${enc(list.slice(0, 1000).join(","))})&select=code,last_seen,status`);
    const seen: Record<string, any> = {}; for (const p of pres) seen[norm(p.code)] = p;
    const admins = new Set(acc.admins); if (mc.creator) admins.add(mc.creator);
    const now = Date.now();
    const out = people.filter((p: any) => String(p.status || "").toLowerCase() !== "quit").map((p: any) => {
      const c = norm(p.code); const pr = seen[c];
      const online = !!(pr && pr.last_seen && now - Date.parse(pr.last_seen) < ONLINE_MS);
      const role = own.indexOf(c) >= 0 ? "owner" : admins.has(c) ? "admin" : "member";
      return { code: c, name: `${p.first_name || ""} ${p.last_name || ""}`.trim() || c, title: p.title || "",
               role, creator: c === mc.creator, online, away: online && pr.status === "away",
               last_seen: pr ? pr.last_seen : null };
    });
    const rank = { owner: 0, admin: 1, member: 2 } as Record<string, number>;
    out.sort((a, b) => (rank[a.role] - rank[b.role]) || (Number(b.online) - Number(a.online)) || a.name.localeCompare(b.name));
    return json({ ok: true, channel, members: out, count: out.length, from_list: mc.fromList,
                  can_assign: acc.assign, can_manage: acc.manage, me });
  }

  /* ---------------------------------------------------------- mute / leave ---- */
  if (action === "mute" || action === "unmute") {
    if (me.startsWith("OPS:")) return json({ ok: false, error: "Operations oversight cannot be muted here." }, 400);
    if (action === "unmute") {
      const d = await write("DELETE", `hub_mutes?code=eq.${enc(me)}&channel=eq.${enc(channel)}`, undefined, "return=minimal");
      return json({ ok: d.ok, muted: false });
    }
    const r = await write("POST", "hub_mutes?on_conflict=code,channel", { code: me, channel, muted_at: new Date().toISOString() }, "resolution=merge-duplicates,return=minimal");
    return json({ ok: r.ok, muted: true });
  }
  if (action === "leave") {
    if (channel.indexOf("c_") !== 0) return json({ ok: false, error: "Team chats come with your baseshop, so they can't be left. You can mute it instead." }, 400);
    const mc = await memberCodes(channel);
    if (mc.creator === me) return json({ ok: false, error: "You created this group, so you stay in it." }, 400);
    if (mc.codes.indexOf(me) < 0) return json({ ok: false, error: "You are not a member of this group." }, 400);
    const res = await rpc("hub_channel_patch", { p_id: channel, p_patch: { members_remove: [me] } });
    if (!res || res.ok !== true) return json({ ok: false, error: "Could not leave the group. Try again." }, 500);
    await write("DELETE", `hub_mutes?code=eq.${enc(me)}&channel=eq.${enc(channel)}`, undefined, "return=minimal");
    return json({ ok: true, left: true });
  }

  /* ----------------------------------------------------------------- bot ---- */
  if (action === "bot_get") {
    const deny = needAdmin(); if (deny) return deny;
    return json({ ok: true, bot: await botOf(channel) });
  }
  if (action === "bot_save") {
    const deny = needAdmin(); if (deny) return deny;
    const patch: Record<string, unknown> = { channel, updated_by: me, updated_at: new Date().toISOString() };
    if (body.name !== undefined) {
      const nm = String(body.name ?? "").trim();
      if (!nm) return json({ ok: false, error: "Give the bot a name." }, 400);
      if (nm.length > 40) return json({ ok: false, error: "Keep the bot's name under 40 characters." }, 400);
      patch.name = nm;
    }
    if (body.description !== undefined) {
      const d = String(body.description ?? "").trim();
      if (d.length > 200) return json({ ok: false, error: "Keep the description under 200 characters." }, 400);
      patch.description = d || null;
    }
    if (body.avatar !== undefined) {
      const a = String(body.avatar ?? "");
      if (a && (!/^data:image\/(jpeg|png|webp);base64,/.test(a) || a.length > MAX_BOT_AVATAR)) return json({ ok: false, error: "That photo could not be used. Try a smaller JPG, PNG or WebP." }, 400);
      patch.avatar = a || null;
    }
    if (body.enabled !== undefined) patch.enabled = body.enabled === true;
    const have = (await getJSON(`hub_group_bots?channel=eq.${enc(channel)}&select=channel`)).length > 0;
    if (!have) patch.created_by = me;
    const r = have
      ? await write("PATCH", `hub_group_bots?channel=eq.${enc(channel)}`, patch)
      : await write("POST", "hub_group_bots", patch);
    if (!r.ok) return json({ ok: false, error: "Could not save the bot." }, 500);
    return json({ ok: true, bot: (Array.isArray(r.data) && r.data[0]) || await botOf(channel) });
  }

  /* ------------------------------------------------------------- flyer upload ---- */
  if (action === "flyer") {
    const deny = needAdmin(); if (deny) return deny;
    const du = String(body.data_url ?? "");
    const m = du.match(/^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
    if (!m) return json({ ok: false, error: "Flyers must be a JPG, PNG or WebP image." }, 400);
    let bytes: Uint8Array;
    try { const bin = atob(m[2]); bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); }
    catch (_) { return json({ ok: false, error: "That image could not be read." }, 400); }
    if (bytes.length > MAX_FLYER) return json({ ok: false, error: "That flyer is over 5 MB. Try a smaller image." }, 400);
    const kind = sniff(bytes);
    if (!kind) return json({ ok: false, error: "That file is not a JPG, PNG or WebP image." }, 400);
    const path = `${FLYER_PREFIX}${channel.toLowerCase()}/${crypto.randomUUID()}.${kind.ext}`;
    const up = await fetch(`${SUPA}/storage/v1/object/${BUCKET}/${path}`, {
      method: "POST", headers: { Authorization: `Bearer ${KEY}`, apikey: KEY, "Content-Type": kind.mime, "x-upsert": "false", "Cache-Control": "31536000" }, body: bytes,
    });
    if (!up.ok) return json({ ok: false, error: "Could not upload the flyer." }, 500);
    return json({ ok: true, url: `${SUPA}/storage/v1/object/public/${BUCKET}/${path}`, size: bytes.length, mime: kind.mime });
  }

  /* -------------------------------------------------------- announcements ---- */
  if (action === "ann_list") {
    const deny = needAdmin(); if (deny) return deny;
    const rows = await getJSON(`hub_group_announcements?channel=eq.${enc(channel)}&deleted_at=is.null&select=*&order=created_at.asc`);
    return json({ ok: true, announcements: rows.map(cleanAnn), tz: TZ, bot: await botOf(channel) });
  }

  if (action === "ann_save") {
    const deny = needAdmin(); if (deny) return deny;
    const v = annRow(body); if (v.error) return json({ ok: false, error: v.error }, 400);
    const row = v.row!;
    if (row.repeat === "once") {
      const nxt = await rpc("hub_ann_next_run", { p_repeat: "once", p_weekdays: [], p_start: row.start_date, p_end: null, p_time: row.send_time, p_tz: TZ, p_after: new Date().toISOString() });
      if (!nxt && body.enabled !== false) return json({ ok: false, error: "That date and time has already passed." }, 400);
    }
    const id = String(body.id ?? "").trim();
    const now = new Date().toISOString();
    if (id) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ ok: false, error: "Which announcement?" }, 400);
      const cur = (await getJSON(`hub_group_announcements?id=eq.${enc(id)}&channel=eq.${enc(channel)}&deleted_at=is.null&select=id`))[0];
      if (!cur) return json({ ok: false, error: "That announcement no longer exists." }, 404);
      const patch: Record<string, unknown> = { ...row, updated_by: me, updated_at: now };
      if (body.enabled !== undefined) patch.enabled = body.enabled !== false;
      const r = await write("PATCH", `hub_group_announcements?id=eq.${enc(id)}&channel=eq.${enc(channel)}`, patch);
      if (!r.ok || !Array.isArray(r.data) || !r.data[0]) return json({ ok: false, error: "Could not save that announcement." }, 500);
      return json({ ok: true, announcement: cleanAnn(r.data[0]) });
    }
    const count = (await getJSON(`hub_group_announcements?channel=eq.${enc(channel)}&deleted_at=is.null&select=id`)).length;
    if (count >= MAX_ANNS) return json({ ok: false, error: `A group can have up to ${MAX_ANNS} announcements. Delete one first.` }, 400);
    /* The bot row is created with the first announcement so the scheduler has a name to post under. */
    if (!(await getJSON(`hub_group_bots?channel=eq.${enc(channel)}&select=channel`)).length) {
      await write("POST", "hub_group_bots", { channel, created_by: me, updated_by: me }, "return=minimal");
    }
    const r = await write("POST", "hub_group_announcements", { ...row, channel, enabled: body.enabled !== false, created_by: me, updated_by: me });
    if (!r.ok || !Array.isArray(r.data) || !r.data[0]) return json({ ok: false, error: "Could not save that announcement." }, 500);
    return json({ ok: true, announcement: cleanAnn(r.data[0]) });
  }

  if (action === "ann_toggle" || action === "ann_delete") {
    const deny = needAdmin(); if (deny) return deny;
    const id = String(body.id ?? "").trim();
    if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ ok: false, error: "Which announcement?" }, 400);
    const patch: Record<string, unknown> = { updated_by: me, updated_at: new Date().toISOString() };
    /* Delete is a soft delete: it stops for good and leaves the row (and its delivery history)
       for anyone investigating later. Messages already posted to the chat are untouched. */
    if (action === "ann_delete") { patch.deleted_at = patch.updated_at; patch.deleted_by = me; patch.enabled = false; }
    else patch.enabled = body.enabled === true;
    if (action === "ann_toggle" && patch.enabled) {
      const a = (await getJSON(`hub_group_announcements?id=eq.${enc(id)}&channel=eq.${enc(channel)}&select=repeat,start_date,send_time`))[0];
      if (a && a.repeat === "once") {
        const nxt = await rpc("hub_ann_next_run", { p_repeat: "once", p_weekdays: [], p_start: a.start_date, p_end: null, p_time: String(a.send_time).slice(0, 5), p_tz: TZ, p_after: new Date().toISOString() });
        if (!nxt) return json({ ok: false, error: "That one-time announcement's time has passed. Edit it to pick a new time." }, 400);
      }
    }
    const r = await write("PATCH", `hub_group_announcements?id=eq.${enc(id)}&channel=eq.${enc(channel)}&deleted_at=is.null`, patch);
    if (!r.ok || !Array.isArray(r.data) || !r.data[0]) return json({ ok: false, error: "That announcement no longer exists." }, 404);
    return json({ ok: true, announcement: cleanAnn(r.data[0]), deleted: action === "ann_delete" });
  }

  if (action === "ann_runs") {
    const deny = needAdmin(); if (deny) return deny;
    const id = String(body.id ?? "").trim();
    if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ ok: false, error: "Which announcement?" }, 400);
    const runs = await getJSON(`hub_group_announcement_runs?announcement_id=eq.${enc(id)}&channel=eq.${enc(channel)}&select=slot_at,status,error,message_id,by_code,created_at&order=created_at.desc&limit=20`);
    return json({ ok: true, runs });
  }

  /* Send Test: posts the announcement into this group right now, as the bot, exactly as the
     scheduled one will look. Uses the saved announcement, or the unsaved draft in the editor. */
  if (action === "ann_test") {
    const deny = needAdmin(); if (deny) return deny;
    const bot = await botOf(channel);
    if (!bot.enabled) return json({ ok: false, error: "The bot is turned off. Turn it on to send a test." }, 400);
    let text = "", flyer: string | null = null, annId: string | null = null;
    const id = String(body.id ?? "").trim();
    if (id && body.draft !== true) {
      const a = (await getJSON(`hub_group_announcements?id=eq.${enc(id)}&channel=eq.${enc(channel)}&deleted_at=is.null&select=id,body,flyer_url`))[0];
      if (!a) return json({ ok: false, error: "That announcement no longer exists." }, 404);
      text = a.body || ""; flyer = a.flyer_url || null; annId = a.id;
    } else {
      text = String(body.body ?? "").replace(/\r\n/g, "\n").trim().slice(0, 2000);
      const f = String(body.flyer_url ?? "").trim();
      if (f && f.indexOf(FLYER_PUBLIC) !== 0) return json({ ok: false, error: "Upload the flyer here rather than linking to it." }, 400);
      flyer = f || null;
      if (/^[0-9a-f-]{36}$/i.test(id)) annId = id;
    }
    if (!text && !flyer) return json({ ok: false, error: "Write a message or attach a flyer first." }, 400);
    const p = await postNow(channel, bot.name || "Group Bot", text, flyer);
    if (!p.ok) return json({ ok: false, error: "The test could not be posted. Group bots may be switched off company-wide." }, 500);
    await write("POST", "hub_group_announcement_runs", { announcement_id: annId, channel, slot_at: new Date().toISOString(), status: "test", message_id: p.id, by_code: me }, "return=minimal");
    return json({ ok: true, message_id: p.id });
  }

  return json({ ok: false, error: "unknown action" }, 400);
});
