// emd-broadcast v4 (2026-09-30) — a leader speaking to their own team.
//
// v3 — BROADCASTING IS AN EMD ACT, NOT AN MD ONE. The rest of Baseshop Settings gates on EMD
//   (bot-admin refuses an MD outright), but this gated on MD+ — so an MD could post an
//   announcement to their whole SHOP channel and notify everyone in it, including the EMD who
//   owns it. Nicholas Marsh, an MD with no downline at all, could have announced to all of
//   TITANS. Two separate permissions now, because they are two different questions:
//     is_leader     — may open Baseshop Settings: approvals, the team roster, goals. MD and above.
//     can_broadcast — may POST to the shop channel. The baseshop OWNER, an EMD/NVP/SEVP, the
//                     platform builder, or Operations.
//   An MD keeps everything they legitimately need — approving their own recruits especially —
//   without being able to speak for a shop that is not theirs.
//
// One rule underpins all of it: a leader may only ever broadcast to THEIR OWN baseshop channel.
// The shop comes from the roster, never from the request body, so no payload can aim a broadcast
// at somebody else's team.
//
// v4 — …AND THE LEADER COMES FROM THE ROSTER TOO. v3 got the hard part right and then read WHO
//   was asking out of `body.code`. GFI codes are printed on the org chart, so all of v3's careful
//   rank arithmetic was one typed code away from being somebody else's rank: type an EMD's code
//   and you posted a pinned announcement into their shop channel under their name AND pushed a
//   notification to every person in that shop. The shop was safe from the payload; the identity
//   was not. Identity is now the session token minted when somebody enters their PIN.
//   (`release` was already correct — it is the cron, authorised by an Operations machine token,
//   and the code it passes to whoami() comes out of the stored row, not off a request.)
//
// v2: sessions inside a day were ordered by their TIME STRING, so "8:00 PM" sorted before
//     "9:00 AM" and the weekly training post read out of order. Sorted by real minutes now.
//
// Actions
//   me       { session }                     -> who you are, your shop, your channel, what you may do
//   feed     { session }                     -> what has been sent, and what is still scheduled
//   flier    { session, data_url, name }     -> store an image, return its public URL
//   send     { session, title, body, flier_url?, send_at?, push?, pin?, kind? }
//   trainings{ session, week_of? }           -> this week's sessions, as a ready-to-send draft
//   cancel   { session, id }                 -> pull a scheduled broadcast before it goes
//   release  { token }                       -> cron: post everything whose time has come
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const lo = (s: unknown) => (s ?? "").toString().trim().toLowerCase();
const clean = (s: unknown, n = 4000) => (s ?? "").toString().trim().slice(0, n);
const enc = encodeURIComponent;
const BUCKET = "cal";
const MAX_FLIER = 6 * 1024 * 1024;

function t2min(t: unknown): number {
  const s = String(t ?? "").trim();
  let m = /^(\d{1,2}):(\d{2})\s*([AaPp])[Mm]?$/.exec(s);
  if (m) { let h = +m[1] % 12; if (/[Pp]/.test(m[3])) h += 12; return h * 60 + (+m[2]); }
  m = /^(\d{1,2}):(\d{2})/.exec(s);
  return m ? (+m[1]) * 60 + (+m[2]) : 9999;
}

async function getJSON(path: string) { const r = await fetch(`${SUPA}/rest/v1/${path}`, { headers: DBH }); return (await r.json()) || []; }
async function rpc(fn: string, args: Record<string, unknown>) { try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); return await r.json(); } catch (_) { return null; } }
async function loadKey(k: string) { const rows = await getJSON(`app_settings?key=eq.${enc(k)}&select=value`); return rows[0] ? rows[0].value : null; }

/* Proof of identity. A session token is proof; a typed code is not. */
async function sessionCode(session: unknown): Promise<string> {
  const s = clean(session, 120);
  if (!s) return "";
  const got = await rpc("agent_session_code", { p_token: s });
  return (typeof got === "string") ? norm(got) : "";
}

function ptNow(): string { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date()); }
function prettyDay(d: string): string {
  try { return new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" }); }
  catch (_) { return d; }
}
function addDays(d: string, n: number): string {
  const dt = new Date(d + "T12:00:00Z"); dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
function weekStart(d: string): string {
  const wd = new Date(d + "T12:00:00Z").getUTCDay();
  return addDays(d, wd === 0 ? -6 : 1 - wd);
}

/* Who is asking, which single channel may they reach, and may they actually speak in it?
   The code handed in here always comes from a verified session, or from a stored row in the
   scheduled-release path — never straight off a request. */
async function whoami(code: string) {
  const c = norm(code);
  if (!c) return null;
  const a = (await getJSON(`tracker_agents?code=eq.${enc(c)}&select=code,first_name,last_name,baseshop,contract_level,title,platform_admin`))[0];
  if (!a) return null;
  const lvl = norm(a.contract_level || a.title);
  const isEmd = ["EMD", "NVP", "SEVP"].indexOf(lvl) >= 0 ||
    /EXECUTIVE|NATIONAL VICE|SENIOR EXECUTIVE/.test(lvl);
  const isLeader = a.platform_admin === true || isEmd ||
    ["MD"].indexOf(lvl) >= 0 || /MARKETING DIRECTOR/.test(lvl);
  const base = clean(a.baseshop, 40) || "";
  const bases = (await loadKey("baseshops")) || {};
  const list = Array.isArray(bases.bases) ? bases.bases : [];
  const entry = list.find((b: any) => lo(b.name) === lo(base));
  // Owning the shop is what earns the right to speak for it.
  const ownsAShop = list.some((b: any) => norm(b.owner_code) === c && !b.admin_grant);
  const canBroadcast = a.platform_admin === true || isEmd || ownsAShop;
  return {
    code: a.code,
    name: `${a.first_name || ""} ${a.last_name || ""}`.trim(),
    baseshop: base,
    channel: entry && entry.channel_key ? String(entry.channel_key) : (lo(base).replace(/[^a-z0-9]/g, "") + "_announcements"),
    label: entry && entry.label ? String(entry.label) : "",
    is_leader: isLeader,
    can_broadcast: canBroadcast,
    owns_shop: ownsAShop,
    level: lvl,
  };
}

async function postToChannel(channel: string, who: any, title: string, body: string, flier: string, pin: boolean) {
  const text = title ? ("**" + title + "**\n\n" + body) : body;
  const attach = flier ? { type: "image", url: flier } : null;
  const r = await fetch(`${SUPA}/rest/v1/hub_messages`, {
    method: "POST", headers: { ...DBH, Prefer: "return=representation" },
    body: JSON.stringify({
      channel, author_code: who.code, author_name: who.name,
      body: text, kind: "announcement", attach, reactions: {},
      pinned: !!pin, pinned_by: pin ? who.code : null, pinned_at: pin ? new Date().toISOString() : null,
    }),
  });
  const t = await r.text();
  let row: any = null; try { const p = JSON.parse(t); row = Array.isArray(p) ? p[0] : p; } catch (_) { /* */ }
  return { ok: r.ok, row, detail: t.slice(0, 200) };
}

async function notifyShop(baseshop: string, title: string, body: string, exceptCode: string) {
  const people = await getJSON(`tracker_agents?baseshop=eq.${enc(baseshop)}&select=code,status&limit=3000`);
  const rows = people
    .filter((p: any) => lo(p.status) !== "quit" && norm(p.code) !== norm(exceptCode) && clean(p.code, 40))
    .map((p: any) => ({ recipient_code: p.code, title, body, created_at: new Date().toISOString() }));
  if (!rows.length) return 0;
  for (let i = 0; i < rows.length; i += 200) {
    await fetch(`${SUPA}/rest/v1/notifications`, {
      method: "POST", headers: { ...DBH, Prefer: "return=minimal" },
      body: JSON.stringify(rows.slice(i, i + 200)),
    });
  }
  return rows.length;
}

async function weekTrainings(baseshop: string, weekOf: string) {
  const start = weekStart(weekOf || ptNow());
  const end = addDays(start, 6);
  const agents = await getJSON(`tracker_agents?select=code,baseshop&limit=3000`);
  const baseOf: Record<string, string> = {};
  agents.forEach((a: any) => baseOf[norm(a.code)] = lo(a.baseshop));
  const rows = await getJSON(`bookings?date=gte.${start}&date=lte.${end}&status=in.(booked,confirmed,pending)&select=date,time,category,trainer_name,trainer_code,agent_name,agent_code,location&order=date.asc&limit=2000`);
  const mine = rows.filter((b: any) =>
    baseOf[norm(b.trainer_code)] === lo(baseshop) || baseOf[norm(b.agent_code)] === lo(baseshop));
  const byDay: Record<string, any[]> = {};
  for (const b of mine) { (byDay[b.date] = byDay[b.date] || []).push(b); }
  const days = Object.keys(byDay).sort();
  const lines: string[] = [];
  for (const d of days) {
    lines.push(prettyDay(d));
    byDay[d]
      .sort((x: any, y: any) => t2min(x.time) - t2min(y.time))
      .forEach((b: any) => {
        lines.push(`  · ${b.time} — ${b.category || "Session"}: ${b.agent_name || ""} with ${b.trainer_name || ""}${b.location ? " (" + b.location + ")" : ""}`);
      });
    lines.push("");
  }
  return {
    week_of: start, week_end: end, count: mine.length,
    title: `This week's trainings — ${prettyDay(start)} to ${prettyDay(end)}`,
    body: mine.length ? lines.join("\n").trim() : "Nothing on the calendar for this week yet. Book a session and it shows up here.",
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const action = clean(body.action, 20) || "me";

    if (action === "release") {
      const az = await rpc("ops_authorize", { p_token: String(body.token ?? "") });
      if (!(az && az.ok)) return json({ ok: false, error: "unauthorized" }, 401);
      const due = await getJSON(`announcements?send_at=lte.${enc(new Date().toISOString())}&posted_at=is.null&status=eq.scheduled&select=*&limit=50`);
      let sent = 0;
      for (const a of due) {
        const who = await whoami(a.created_by);
        if (!who) continue;
        const res = await postToChannel(who.channel, who, a.title || "", a.body || "", a.flier_url || "", !!a.pinned);
        if (!res.ok) continue;
        if (a.push) await notifyShop(a.baseshop || who.baseshop, a.title || "Team update", clean(a.body, 180), a.created_by);
        await fetch(`${SUPA}/rest/v1/announcements?id=eq.${enc(a.id)}`, {
          method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" },
          body: JSON.stringify({ posted_at: new Date().toISOString(), status: "posted" }),
        });
        sent++;
      }
      return json({ ok: true, due: due.length, sent });
    }

    const myCode = await sessionCode(body.session);
    if (!myCode) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401);
    const who = await whoami(myCode);
    if (!who) return json({ ok: false, error: "Sign in again — we could not find your profile." }, 401);
    if (!who.is_leader) return json({ ok: false, error: "Only a Marketing Director and above can open Baseshop Settings." }, 403);
    if (!who.baseshop) return json({ ok: false, error: "Your profile has no baseshop, so there is no team channel to post to." }, 400);

    if (action === "me") return json({ ok: true, ...who });

    if (action === "feed") {
      const rows = await getJSON(`announcements?baseshop=eq.${enc(who.baseshop)}&select=*&order=created_at.desc&limit=40`);
      return json({
        ok: true, who, can_broadcast: who.can_broadcast,
        scheduled: rows.filter((r: any) => !r.posted_at && r.send_at && r.status === "scheduled"),
        sent: rows.filter((r: any) => !!r.posted_at),
      });
    }

    if (action === "trainings") {
      return json({ ok: true, ...(await weekTrainings(who.baseshop, clean(body.week_of, 10))) });
    }

    /* Everything past here PUTS SOMETHING IN FRONT OF THE WHOLE SHOP. */
    if (!who.can_broadcast) {
      return json({ ok: false, error: "Only the Executive Marketing Director who owns " + who.baseshop + " can announce to it." }, 403);
    }

    if (action === "flier") {
      const dataUrl = String(body.data_url || "");
      const m = /^data:(image\/(png|jpe?g|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
      if (!m) return json({ ok: false, error: "That file is not a PNG, JPG, GIF or WEBP image." });
      let bytes: Uint8Array;
      try {
        const bin = atob(m[3]);
        bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      } catch (_) { return json({ ok: false, error: "That image could not be read." }); }
      if (bytes.length > MAX_FLIER) return json({ ok: false, error: `That image is ${(bytes.length / 1048576).toFixed(1)}MB. Keep fliers under 6MB.` });
      const ext = m[2] === "jpeg" ? "jpg" : m[2];
      const path = `fliers/${lo(who.baseshop).replace(/[^a-z0-9]/g, "")}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
      const up = await fetch(`${SUPA}/storage/v1/object/${BUCKET}/${path}`, {
        method: "POST",
        headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": m[1], "x-upsert": "true" },
        body: bytes,
      });
      if (!up.ok) { const t = await up.text(); return json({ ok: false, error: "Could not store that image.", detail: t.slice(0, 200) }); }
      return json({ ok: true, url: `${SUPA}/storage/v1/object/public/${BUCKET}/${path}`, bytes: bytes.length });
    }

    if (action === "cancel") {
      const id = clean(body.id, 60);
      const r = await fetch(`${SUPA}/rest/v1/announcements?id=eq.${enc(id)}&baseshop=eq.${enc(who.baseshop)}&posted_at=is.null`, {
        method: "PATCH", headers: { ...DBH, Prefer: "return=representation" },
        body: JSON.stringify({ status: "canceled", send_at: null }),
      });
      const rows = await r.json();
      if (!r.ok || !Array.isArray(rows) || !rows.length) return json({ ok: false, error: "That one has already gone out, or is not yours to pull." });
      return json({ ok: true, id });
    }

    if (action !== "send") return json({ ok: false, error: "unknown action" }, 400);

    const title = clean(body.title, 160);
    const text = clean(body.body, 4000);
    const flier = clean(body.flier_url, 400);
    if (!title && !text && !flier) return json({ ok: false, error: "Write something, or attach a flier." });
    const kind = ["announcement", "flier", "trainings"].indexOf(clean(body.kind, 20)) >= 0 ? clean(body.kind, 20) : "announcement";
    const push = body.push === true;
    const pin = body.pin === true;

    let sendAt: string | null = null;
    if (clean(body.send_at, 40)) {
      const t = new Date(String(body.send_at));
      if (isNaN(t.getTime())) return json({ ok: false, error: "That send time is not a real date." });
      if (t.getTime() > Date.now() + 60000) sendAt = t.toISOString();
    }

    const ins = await fetch(`${SUPA}/rest/v1/announcements`, {
      method: "POST", headers: { ...DBH, Prefer: "return=representation" },
      body: JSON.stringify({
        title, body: text, kind, flier_url: flier || null,
        scope: "baseshop", baseshop: who.baseshop,
        created_by: who.code, created_by_name: who.name,
        status: sendAt ? "scheduled" : "posted",
        send_at: sendAt, push, pinned: pin,
        posted_at: sendAt ? null : new Date().toISOString(),
      }),
    });
    const itxt = await ins.text();
    let rec: any = null; try { const p = JSON.parse(itxt); rec = Array.isArray(p) ? p[0] : p; } catch (_) { /* */ }
    if (!ins.ok || !rec) return json({ ok: false, error: "Could not save that.", detail: itxt.slice(0, 200) });

    if (sendAt) return json({ ok: true, scheduled: true, id: rec.id, send_at: sendAt, channel: who.channel });

    const res = await postToChannel(who.channel, who, title, text, flier, pin);
    if (!res.ok) return json({ ok: false, error: "Saved, but it could not be posted to the channel.", detail: res.detail });
    let pushed = 0;
    if (push) pushed = await notifyShop(who.baseshop, title || "Team update", clean(text, 180), who.code);
    return json({ ok: true, posted: true, id: rec.id, channel: who.channel, message_id: res.row ? res.row.id : null, notified: pushed });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
