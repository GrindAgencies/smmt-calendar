// hub-groups v7 (2026-10-26) — member_add / member_remove no longer write back a copy of the
//   whole app_settings.hub_channels registry. Two edits at once (or an edit racing a new group
//   being created) used to lose one of them: a fresh group could vanish, a removed member could
//   come back. The change is now one call to hub_channel_patch, which applies members_add /
//   members_remove to the CURRENT list under the same row lock hub_channel_append uses, and in
//   the same statement deletes a removed member's hub_group_admins row for that group - being
//   taken out of a private group must also end being its admin.
// hub-groups v6 (2026-10-26) — members of a created group can be viewed and managed after
//   creation (brief §5: "Authorized group admins can later ... manage members under existing
//   rules"). Before this a private group was frozen with whoever was ticked on day one.
//   · members         any member may see who is in the group.
//   · member_add      owner / this group's admin. An agent admin may only add people inside
//     member_remove   their own agent_scope() - the same rule the people picker (hub-roster)
//                     uses - so the server, not the picker, keeps a group inside its shop.
//   The creator is always a member and cannot be removed. Built-in channels have no member
//   list (their access is rank/baseshop based) and are refused.
// hub-groups v5 (2026-10-26) — a group can carry a short description (brief §5: "Save the
//   optional description with the group; do not draw a field that discards its content").
//   Same editors as the name and photo: the group's creator, its designated admins, owners.
// hub-groups v4 (2026-10-26) — Operations master holds owner powers; Ops is never a typed code.
// hub-groups v3 (2026-10-22) — a group chat's own name and photo, who may change them, and
// who may post in the organisation-wide Announcements channel.
//
// v3: THE PERSON WHO CREATES A GROUP CAN NOW NAME AND PHOTOGRAPH IT. v2 recognised exactly two
// kinds of editor — the owner allow-list, and whoever an owner had explicitly named in
// hub_group_admins — so the ordinary case of "I made this group, let me set its picture" was
// refused. The iPhone handoff asks for a creation flow with a photo, and is explicit about the
// rule to apply: "Scope the creator's rights to the created group, without automatically
// granting announcements posting or company-wide administrator access."
//
// That is resolvable from data the app already keeps rather than a new permission: every custom
// channel in app_settings.hub_channels records `byCode`, the code of whoever created it. A
// caller who matches it is treated as an admin OF THAT ONE CHANNEL.
//
// Deliberately NOT widened: isOwner() is untouched, so designating group admins, managing the
// announcer list and every other owner power stay with the allow-list. Creating a group grants
// authority over that group and nothing else.
//
// v2 adds the announcer allow-list. Elijah asked for an Announcements chat everyone can read
// and only designated leadership can post in, managed from Settings. The WRITE restriction is
// not implemented here: it is a BEFORE INSERT trigger on hub_messages
// (hub_announcements_write_guard), because the brief requires it to hold for attachments,
// edits, realtime operations and direct API requests — "a hidden composer alone is
// insufficient" — and to take effect for an already-open session. A trigger is consulted on
// every insert from every path. What lives here is only the management of the list.
//
// ROUND TWO tasks 5 and 6. Elijah: a group chat has its own profile picture, its designated
// admin can change the name and the photo, and Elijah decides who those admins are.
//
// THREE SEPARATE LEVELS OF AUTHORITY, and none of them is inherited from being powerful
// elsewhere — the brief is explicit that a group-admin role must not confer company-wide
// access, and equally that EMD rank by itself confers nothing until somebody is designated:
//
//   OWNER          may designate and revoke group admins, for any group, AND may designate
//                  announcers. An explicit allow-list of agent CODES in
//                  app_settings.hub_group_owners - GFI20 (Elijah) and C1991 (Christopher,
//                  added at his request). Not a rank, not platform_admin, not Operations.
//   GROUP ADMIN    may rename and re-photograph THE GROUPS THEY ARE NAMED ON, and nothing else.
//   ANNOUNCER      may post in Announcements, and nothing else. Posting an announcement is NOT
//                  administration: it grants no group edit, no designation power, no bots.
//   MEMBER         may read. That is all.
//
// Every write re-checks. The UI hiding a button is a courtesy to everyone else, never the
// control: an unauthorised request straight to this function is refused the same way.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const low = (s: unknown) => (s ?? "").toString().trim().toLowerCase();
const enc = encodeURIComponent;

const MAX_AVATAR = 300_000;          // a 256px square JPEG is ~20-40KB; this is generous
const MAX_NAME = 60;
const MAX_DESC = 300;                // matches the hub_groups_description_len check
const OWNER_FALLBACK = ["GFI20"];    // if the setting is ever lost, authority SHRINKS, never opens
const ANNOUNCE_CHANNEL = "announcements";

async function getJSON(path: string) { try { const r = await fetch(`${SUPA}/rest/v1/${path}`, { headers: DBH }); return (await r.json()) || []; } catch (_) { return []; } }
async function rpc(fn: string, args: Record<string, unknown>) { try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); return await r.json(); } catch (_) { return null; } }

/* v4 (2026-10-26): AN OPERATIONS CALLER IS "OPS:<seat>", NEVER A CODE IT TYPED. v3 returned
   norm(body.code) for any Ops token, so Operations naming code=GFI20 BECAME the owner -- an
   impersonation, not a grant. The seat comes from the token; `master` says whether it is the
   all-shops seat, which now holds owner powers in its own right (see ownerMe below). */
async function whoIs(body: any): Promise<{ code: string; master: boolean }> {
  const t = String(body.token ?? "").trim();
  if (t) {
    const r = await rpc("ops_authorize", { p_token: t });
    if (r && r.ok) return { code: "OPS:" + norm(r.code), master: r.master === true };
  }
  const s = String(body.session ?? "").trim().slice(0, 120);
  if (!s) return { code: "", master: false };
  const got = await rpc("agent_session_code", { p_token: s });
  return { code: (typeof got === "string") ? norm(got) : "", master: false };
}

async function owners(): Promise<string[]> {
  const rows = await getJSON(`app_settings?key=eq.hub_group_owners&select=value`);
  const v = rows[0] && rows[0].value;
  const list = (v && Array.isArray(v.codes)) ? v.codes : null;
  const codes = (list || OWNER_FALLBACK).map(norm).filter(Boolean);
  return codes.length ? codes : OWNER_FALLBACK;
}
async function isOwner(code: string) { return (await owners()).indexOf(code) >= 0; }
/* Did this person create this channel? Read from the channel registry the hub already keeps,
   so there is one source of truth for who made a group and no second place to keep in step. */
async function isChannelCreator(code: string, channel: string) {
  if (!code || !channel || channel.indexOf("c_") !== 0) return false;
  const rows = await getJSON(`app_settings?key=eq.hub_channels&select=value`);
  const v = rows[0] && rows[0].value;
  const list = (v && Array.isArray(v.channels)) ? v.channels : [];
  const c = list.find((x: any) => String(x && x.id) === channel);
  return !!(c && norm(c.byCode) === norm(code));
}
async function isGroupAdmin(code: string, channel: string) {
  if (!code || !channel) return false;
  const r = await getJSON(`hub_group_admins?channel=eq.${enc(channel)}&code=eq.${enc(code)}&select=code&limit=1`);
  if (r.length > 0) return true;
  /* The creator of this group, and only for this group. */
  return await isChannelCreator(code, channel);
}

/* The announcer allow-list. Read straight from app_settings so this and the database trigger
   that actually enforces posting are looking at exactly one source of truth. */
async function announcers(): Promise<string[]> {
  const rows = await getJSON(`app_settings?key=eq.hub_announcers&select=value`);
  const v = rows[0] && rows[0].value;
  return ((v && Array.isArray(v.codes)) ? v.codes : []).map(norm).filter(Boolean);
}
async function saveAnnouncers(codes: string[], by: string) {
  const seen = new Set<string>(); const clean: string[] = [];
  for (const c of codes) { const n = norm(c); if (n && !seen.has(n)) { seen.add(n); clean.push(n); } }
  const body = JSON.stringify({
    key: "hub_announcers",
    value: {
      note: "Agent codes permitted to post in the org-wide Announcements channel. Managed by the hub_group_owners allow-list.",
      codes: clean, set_on: new Date().toISOString().slice(0, 10), set_by: by,
    },
    updated_at: new Date().toISOString(),
  });
  const r = await fetch(`${SUPA}/rest/v1/app_settings?on_conflict=key`, {
    method: "POST", headers: { ...DBH, Prefer: "resolution=merge-duplicates,return=minimal" }, body,
  });
  return { ok: r.ok, codes: clean };
}

/* The same access rule the chat itself uses, forwarded with the caller's own session -
   hub-api identifies people by session, never by a typed code. A DM has no group identity to
   edit, so this is channels only. */
async function inChannel(code: string, channel: string, session: string, opsToken: string): Promise<boolean> {
  if (!code || !channel || channel.startsWith("dm:")) return false;
  try {
    const payload: Record<string, unknown> = { action: "hub_channels", code };
    if (session) payload.session = session;
    if (opsToken) payload.token = opsToken;
    const r = await fetch(`${SUPA}/functions/v1/hub-api`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}`, apikey: KEY },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    const list = (j && Array.isArray(j.channels)) ? j.channels : [];
    return list.some((c: any) => String(c && c.id) === channel);
  } catch (_) { return false; }
}

const okChannel = (s: unknown) => {
  const v = (s ?? "").toString().trim();
  return v.length > 0 && v.length <= 120 && /^[A-Za-z0-9_.-]+$/.test(v);   // groups only, never dm:
};

async function channelRegistry(): Promise<any> {
  const rows = await getJSON(`app_settings?key=eq.hub_channels&select=value`);
  const v = (rows[0] && rows[0].value) || { channels: [] };
  if (!Array.isArray(v.channels)) v.channels = [];
  return v;
}
async function peopleByCode(codes: string[]) {
  const list = codes.map(norm).filter((c) => /^[A-Z0-9]{2,12}$/.test(c));
  if (!list.length) return {} as Record<string, any>;
  const rows = await getJSON(`tracker_agents?code=in.(${enc(list.join(","))})&select=code,first_name,last_name,baseshop,status`);
  const out: Record<string, any> = {};
  for (const a of rows) out[norm(a.code)] = { code: norm(a.code), name: `${a.first_name || ""} ${a.last_name || ""}`.trim() || norm(a.code), baseshop: a.baseshop || "", status: a.status || "active" };
  return out;
}

async function nameOf(code: string) {
  const a = (await getJSON(`tracker_agents?code=eq.${enc(code)}&select=first_name,last_name`))[0];
  return a ? `${a.first_name || ""} ${a.last_name || ""}`.trim() : code;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: any = {}; try { body = req.method === "POST" ? await req.json() : {}; } catch (_) { body = {}; }

  const caller = await whoIs(body);
  const me = caller.code;
  if (!me) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401);
  /* The Operations master seat holds every owner power alongside the allow-list. */
  const ownerMe = async () => caller.master || await isOwner(me);

  const action = String(body.action || "get");
  const channel = String(body.channel ?? "").trim();
  const sess = String(body.session ?? "").trim().slice(0, 120);
  const opsTok = String(body.token ?? "").trim();

  /* ---------------------------------------------- who may be designated at all ---- */
  /* EMDs, resolved from the roster's own rank fields rather than guessed from a name. Both
     columns are consulted because leadership and commission rank are different things here -
     Elijah's title reads Executive Marketing Director while his contract level reads National
     Vice President. */
  if (action === "eligible") {
    if (!(await ownerMe())) return json({ ok: false, error: "Only the owner can manage group admins." }, 403);
    const rows = await getJSON(`tracker_agents?select=code,first_name,last_name,baseshop,title,contract_level,status&status=neq.quit&limit=2000`);
    const emds = rows.filter((a: any) => {
      const t = low(a.title), c = low(a.contract_level);
      return /executive marketing director/.test(t) || c === "emd" ||
             /executive marketing director/.test(c);
    }).map((a: any) => ({
      code: norm(a.code), name: `${a.first_name || ""} ${a.last_name || ""}`.trim(),
      baseshop: a.baseshop || "", rank: a.title || a.contract_level || "",
    }));
    /* If the roster carries no EMD at all, say so plainly rather than returning an empty
       picker that looks like a loading failure. */
    return json({ ok: true, eligible: emds, count: emds.length,
      note: emds.length ? null : "No account on the roster is recorded as an EMD, so there is nobody to designate yet. Set a title or contract level of Executive Marketing Director on the people who lead the shops." });
  }

  /* ------------------------------------------- who may post in Announcements ------ */
  /* Readable by anyone signed in: every member needs to know whether the composer they are
     looking at will work, and the list of who speaks for the company is not a secret.
     Changing it is owner-only, re-checked on every write. */
  if (action === "announcers") {
    const codes = await announcers();
    const people = [];
    for (const c of codes) people.push({ code: c, name: await nameOf(c) });
    return json({ ok: true, channel: ANNOUNCE_CHANNEL, codes, people,
                  can_post: codes.indexOf(me) >= 0, can_manage: await ownerMe() });
  }

  if (action === "announcer_add" || action === "announcer_remove") {
    if (!(await ownerMe())) {
      return json({ ok: false, error: "Only the owner can decide who posts announcements." }, 403);
    }
    const who = norm(body.who);
    if (!who) return json({ ok: false, error: "Which account?" }, 400);
    const exists = (await getJSON(`tracker_agents?code=eq.${enc(who)}&select=code,status&limit=1`))[0];
    if (!exists) return json({ ok: false, error: "No account with that code." }, 404);
    if (low(exists.status) === "quit") return json({ ok: false, error: "That account is no longer active." }, 400);

    const cur = await announcers();
    let next: string[];
    if (action === "announcer_add") {
      if (cur.indexOf(who) >= 0) return json({ ok: true, codes: cur, already: true });
      next = cur.concat([who]);
    } else {
      /* The last announcer may be removed. An empty list means nobody can post, which is a
         coherent state and recoverable by the owner at any time - safer than a rule that
         quietly keeps somebody's access because the list would otherwise be empty. */
      next = cur.filter((c) => c !== who);
    }
    const saved = await saveAnnouncers(next, me);
    return json({ ok: saved.ok, codes: saved.codes, who, name: await nameOf(who),
                  posting: action === "announcer_add" });
  }

  if (!okChannel(channel)) return json({ ok: false, error: "Which group?" }, 400);

  const owner = await ownerMe();
  const admin = await isGroupAdmin(me, channel);
  const member = owner || admin || await inChannel(me, channel, sess, opsTok);

  /* ------------------------------------------------------------------- read ----- */
  if (action === "get") {
    if (!member) return json({ ok: false, error: "You are not in that group." }, 403);
    const g = (await getJSON(`hub_groups?channel=eq.${enc(channel)}&select=channel,name,avatar,description,updated_by,updated_at`))[0] || null;
    const admins = await getJSON(`hub_group_admins?channel=eq.${enc(channel)}&select=code,assigned_by,assigned_at&order=assigned_at.asc`);
    const withNames = [];
    for (const a of admins) withNames.push({ code: norm(a.code), name: await nameOf(norm(a.code)), assigned_at: a.assigned_at });
    return json({
      ok: true, channel,
      name: (g && g.name) || null,            // null = still using the derived name
      avatar: (g && g.avatar) || null,
      description: (g && g.description) || null,
      can_edit: owner || admin,               // owners can edit too, so a group is never stranded
      can_assign: owner,
      admins: withNames,
    });
  }

  /* ------------------------------------------------------------- name / photo ---- */
  if (action === "set_name" || action === "set_photo" || action === "set_description") {
    if (!(owner || admin)) {
      return json({ ok: false, error: "Only this group's admin can change it." }, 403);
    }
    const patch: Record<string, unknown> = { channel, updated_by: me, updated_at: new Date().toISOString() };
    if (action === "set_name") {
      const nm = String(body.name ?? "").trim();
      if (!nm) return json({ ok: false, error: "Give the group a name." }, 400);
      if (nm.length > MAX_NAME) return json({ ok: false, error: `Keep the name under ${MAX_NAME} characters.` }, 400);
      patch.name = nm;
    } else if (action === "set_description") {
      /* Optional: an empty value clears it. Plain text, trimmed, length-checked here AND by the
         table's own constraint. */
      const d = String(body.description ?? "").replace(/\r\n/g, "\n").trim();
      if (d.length > MAX_DESC) return json({ ok: false, error: `Keep the description under ${MAX_DESC} characters.` }, 400);
      patch.description = d || null;
    } else {
      const url = String(body.avatar ?? "");
      if (url === "") { patch.avatar = null; }      // removing the photo falls back to the group icon
      else {
        if (!url.startsWith("data:image/")) return json({ ok: false, error: "That does not look like an image." }, 400);
        if (url.length > MAX_AVATAR) return json({ ok: false, error: "That image is too large even after resizing." }, 400);
        patch.avatar = url;
      }
    }
    const r = await fetch(`${SUPA}/rest/v1/hub_groups?on_conflict=channel`, {
      method: "POST", headers: { ...DBH, Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify(patch),
    });
    if (!r.ok) return json({ ok: false, error: "Could not save that." }, 500);
    const saved = (await r.json())[0] || {};
    return json({ ok: true, channel, name: saved.name || null, avatar: saved.avatar || null, description: saved.description || null });
  }

  /* ---------------------------------------------------------------- members ---- */
  if (action === "members" || action === "member_add" || action === "member_remove") {
    if (channel.indexOf("c_") !== 0) return json({ ok: false, error: "This channel's membership comes from rank and baseshop, not a list." }, 400);
    const reg = await channelRegistry();
    const ch = reg.channels.find((x: any) => String(x && x.id) === channel);
    if (!ch) return json({ ok: false, error: "That group no longer exists." }, 404);
    const creator = norm(ch.byCode);
    const cur: string[] = Array.isArray(ch.members) ? ch.members.map(norm).filter(Boolean) : [];
    if (creator && cur.indexOf(creator) < 0) cur.push(creator);

    if (action === "members") {
      if (!member) return json({ ok: false, error: "You are not in that group." }, 403);
      const ppl = await peopleByCode(cur);
      const list = cur.map((c) => ppl[c] || { code: c, name: c, baseshop: "" })
        .sort((a: any, b: any) => (a.code === creator ? -1 : b.code === creator ? 1 : String(a.name).localeCompare(String(b.name))));
      return json({ ok: true, channel, private: !!ch.private, creator, members: list, count: list.length, can_manage: owner || admin });
    }

    if (!(owner || admin)) return json({ ok: false, error: "Only this group's admin can change its members." }, 403);
    const asked = (Array.isArray(body.who) ? body.who : [body.who]).map(norm).filter(Boolean).slice(0, 50);
    if (!asked.length) return json({ ok: false, error: "Which account?" }, 400);

    if (action === "member_remove") {
      if (asked.indexOf(creator) >= 0) return json({ ok: false, error: "The person who created the group stays in it." }, 400);
    } else {
      const ppl = await peopleByCode(asked);
      const missing = asked.filter((c) => !ppl[c] || low(ppl[c].status) === "quit");
      if (missing.length) return json({ ok: false, error: `Not an active account: ${missing.join(", ")}` }, 400);
      /* An owner or the Ops master may add anyone. A group admin only inside their own scope. */
      if (!owner && !me.startsWith("OPS:")) {
        const sc = await rpc("agent_scope", { p_code: me });
        const all = !!(sc && sc.ok === true && sc.all);
        const bases = (sc && Array.isArray(sc.bases)) ? sc.bases.map(norm) : [];
        const outside = all ? [] : asked.filter((c) => bases.indexOf(norm(ppl[c].baseshop)) < 0);
        if (outside.length) return json({ ok: false, error: `Outside your baseshop: ${outside.map((c) => ppl[c].name).join(", ")}` }, 403);
      }
    }
    /* v7: the delta, not a recomputed list - applied under the registry lock (see header). */
    const res = await rpc("hub_channel_patch", { p_id: channel, p_patch: action === "member_add" ? { members_add: asked } : { members_remove: asked } });
    if (!res || res.ok !== true || !res.channel) return json({ ok: false, error: "Could not save that." }, 500);
    const saved: string[] = Array.isArray(res.channel.members) ? res.channel.members : [];
    return json({ ok: true, channel, members: saved, count: saved.length });
  }

  /* ------------------------------------------------------- designate / revoke ---- */
  if (action === "admin_add" || action === "admin_remove") {
    if (!owner) return json({ ok: false, error: "Only Elijah can decide who administers a chat." }, 403);
    const who = norm(body.who);
    if (!who) return json({ ok: false, error: "Which account?" }, 400);
    const exists = (await getJSON(`tracker_agents?code=eq.${enc(who)}&select=code,status&limit=1`))[0];
    if (!exists) return json({ ok: false, error: "No account with that code." }, 404);
    if (low(exists.status) === "quit") return json({ ok: false, error: "That account is no longer active." }, 400);

    if (action === "admin_remove") {
      const d = await fetch(`${SUPA}/rest/v1/hub_group_admins?channel=eq.${enc(channel)}&code=eq.${enc(who)}`, { method: "DELETE", headers: { ...DBH, Prefer: "return=minimal" } });
      return json({ ok: d.ok, channel, who, admin: false });
    }
    const r = await fetch(`${SUPA}/rest/v1/hub_group_admins?on_conflict=channel,code`, {
      method: "POST", headers: { ...DBH, Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ channel, code: who, assigned_by: me, assigned_at: new Date().toISOString() }),
    });
    return json({ ok: r.ok, channel, who, admin: true, name: await nameOf(who) });
  }

  return json({ ok: false, error: "unknown action" }, 400);
});
