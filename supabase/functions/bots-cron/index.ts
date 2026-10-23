// bots-cron v9 (2026-10-22) — WHO MAY CONFIGURE THE BOTS.
//
// v9: `get` and `set` decided what you could edit from `body.code`, a typed string. Agent codes
// are printed on the org chart, so sending the platform builder's code answered
// is_builder:true, is_ops:true, hierarchy_editable:true and every baseshop as editable —
// measured, not supposed. `set` used the same path, so anyone could rewrite what Stuart posts
// into EVERY baseshop's announcements channel: the reminder offsets, the quiet hours, and the
// daily highlight lines that get posted to teams. That is content injection into the company's
// own channels, and it needed nothing but a code anyone can read off the chart.
//
// Identity is now the session minted at PIN entry, or an Operations token. `run` is unchanged —
// it is the cron and already required Operations. No client change: teamhub.html and
// profile.html, the only two callers, both load session.js.
//
// bots-cron v8 (2026-09-29) — announcements land in a BASESHOP's own channel. Never the company
// chat, never Operations.
//
// v8: THE DAILY MORNING HUDDLE IS GONE. Christopher: "delete anything morning huddle related from
//   the platform we no longer do those." It was the only 5-day-a-week entry here, so Stuart was
//   firing four reminders a day per baseshop for a meeting that no longer happens — by far the
//   loudest thing in every announcements channel. Removed from SESSIONS, from the Scheduler's
//   TRAININGS in calendar.html, from the daily non-negotiables and from the iCal feeds.
//
// v5: the session list is brought back in line with the Scheduler's TRAININGS in calendar.html,
//   which had drifted — Stuart was announcing Phone Zone on Wednesday at noon while the app
//   showed Tuesday noon and Thursday 9am, so the reminder and the calendar disagreed.
//   Christopher (2026-09-28): "adjust the Team orrientation to Tuesday and wednesday instead of
//   wednesday and thrusday ... and add a Licensed agent Only training to thursday at 6PM pst in
//   elijah cox zoom room." Orientation Day 1 -> Tue, Day 2 -> Wed, Licensed Agents Only -> Thu.
//   These all run in Elijah's one Zoom room, so they are a single company meeting series and
//   cannot sit at different times for different baseshops — each shop is reminded in its own
//   channel, at the one real time.
//
// v4 changes:
//   · The company-wide post to #main as "Operations · Announcements" is GONE. Christopher's rule:
//     bots only announce in their respective team chat. Each baseshop gets the same reminder in
//     its own channel, which is where its people actually look.
//   · The schedule is now the EMD's to set, per baseshop, from their profile: which reminder
//     offsets go out, what hour and which days the highlights post, and quiet hours outside
//     which nothing posts at all. It used to be hardcoded to 60/30/10/0 and an 8-9am window.
//   · bot_channel_policy() in the database is the backstop — even if some other function aims a
//     team bot at #main, it is fanned out to the baseshop channels instead.
// v3: a platform builder gets the same reach as Operations without holding EMD rank.
const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
function json(o: unknown, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const low = (s: unknown) => (s ?? "").toString().trim().toLowerCase();
async function loadKey(k: string) { const r = await fetch(`${SUPA}/rest/v1/app_settings?key=eq.${k}&select=value`, { headers: DBH }); const rows = await r.json(); return (rows && rows[0]) ? rows[0].value : null; }
async function saveKey(k: string, value: unknown) { await fetch(`${SUPA}/rest/v1/app_settings?on_conflict=key`, { method: "POST", headers: { ...DBH, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key: k, value, updated_at: new Date().toISOString() }) }); }
async function rpc(fn: string, args: Record<string, unknown>) { try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); return await r.json(); } catch (_) { return null; } }
async function opsAuthorized(token: unknown) { const r = await rpc("ops_authorize", { p_token: String(token ?? "") }); return !!(r && r.ok); }
/* Proof of identity. A session token is proof; a typed code is not — and here a typed code was
   edit rights over what the bots say to every team. */
async function sessionCode(session: unknown): Promise<string> {
  const v = String(session ?? "").trim().slice(0, 120);
  if (!v) return "";
  const got = await rpc("agent_session_code", { p_token: v });
  return (typeof got === "string") ? norm(got) : "";
}
async function isBuilder(code: string) { if (!code) return false; return (await rpc("is_platform_admin", { p_code: code })) === true; }
async function agent(code: string) { const r = await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${encodeURIComponent(code)}&select=first_name,last_name,contract_level,baseshop,title`, { headers: DBH }); const j = await r.json(); return (j && j[0]) ? j[0] : null; }
async function post(channel: string, code: string, name: string, bodyTxt: string) { await fetch(`${SUPA}/rest/v1/hub_messages`, { method: "POST", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify({ channel, author_code: code, author_name: name, body: bodyTxt, kind: "announce", attach: { source: "Team Calendar" }, reactions: {} }) }); }
async function loadBases() { const v = await loadKey("baseshops"); if (v && Array.isArray(v.bases)) return { root: v.root || "STANDARD", bases: v.bases }; return { root: "STANDARD", bases: [] }; }
async function loadCfg() { const v = await loadKey("hub_bot_config"); return (v && typeof v === "object") ? v : { bases: {} }; }
function lvlEMD(a: any) { const cl = low(a && a.contract_level); const t = low(a && a.title); return cl === "emd" || cl.includes("executive") || t.includes("executive marketing"); }

/* Each baseshop's own settings, with sensible defaults when its EMD has not set any. */
function schedOf(conf: any) {
  const s = (conf && conf.schedule) || {};
  return {
    announce: s.announce !== undefined ? s.announce !== false : (conf ? conf.announce !== false : true),
    reminders: Array.isArray(s.reminders) && s.reminders.length ? s.reminders : [60, 30, 10, 0],
    hlHour: (s.highlights_hour !== undefined) ? Number(s.highlights_hour) : 8,
    hlDays: Array.isArray(s.highlights_days) && s.highlights_days.length ? s.highlights_days : [1, 2, 3, 4, 5],
    quietBefore: (s.quiet_before !== undefined) ? Number(s.quiet_before) : 6,
    quietAfter: (s.quiet_after !== undefined) ? Number(s.quiet_after) : 21,
    highlights: Array.isArray(s.highlights) ? s.highlights : (Array.isArray(conf && conf.highlights) ? conf.highlights : []),
  };
}

const ZOOM_MAIN = "https://us02web.zoom.us/j/9646509994?pwd=a2s1OXhzeTB3N3BBOWRkUmw1VHE2Zz09";
const ZT_MAIN = "Zoom 964 650 9994 · Password WEALTH";
const ZOOM_CFT = "https://zoom.us/j/9646509953";
const ZT_CFT = "Zoom 964 650 9953";
// Kept deliberately identical to TRAININGS in calendar.html. If one changes, change both, or
// Stuart reminds people of a time the Scheduler does not show.
const SESSIONS = [
  { d: [1], h: 9, m: 0, t: "Momentum Monday (9 AM) Training", host: "Matthew Welsh", z: "https://zoom.us/j/6199970102", zt: "Zoom 619 997 0102 · Passcode 2026" },
  { d: [1], h: 18, m: 0, t: "Momentum Monday — Team Training", host: "Elijah Cox & Team", z: ZOOM_MAIN, zt: ZT_MAIN },
  { d: [2,4,5], h: 6, m: 0, t: "CFT Orientation (Morning)", host: "Christopher Lorenz", z: ZOOM_CFT, zt: ZT_CFT },
  { d: [2], h: 12, m: 0, t: "Phone Zone", host: "Christopher Lorenz", z: ZOOM_CFT, zt: ZT_CFT },
  { d: [4], h: 9, m: 0, t: "Phone Zone", host: "Christopher Lorenz", z: ZOOM_CFT, zt: ZT_CFT },
  { d: [3], h: 17, m: 0, t: "Armed Forces Call", host: "Team", z: "https://zoom.us/j/6806839747", zt: "Zoom 680 683 9747" },
  { d: [2], h: 18, m: 0, t: "Orientation Day 1", host: "Elijah Cox", z: ZOOM_MAIN, zt: ZT_MAIN },
  { d: [3], h: 18, m: 0, t: "Orientation Day 2", host: "Elijah Cox", z: ZOOM_MAIN, zt: ZT_MAIN },
  { d: [4], h: 18, m: 0, t: "Licensed Agents Only Training", host: "Elijah Cox", z: ZOOM_MAIN, zt: ZT_MAIN }
];
function offLabel(b: number) { if (b === 0) return "is LIVE now — join!"; if (b === 60) return "starts in 1 hour"; return "starts in " + b + " minutes"; }
function ptClock() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const gp = (t: string) => { const x = parts.find((p) => p.type === t); return x ? x.value : ""; };
  const wd: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let hh = parseInt(gp("hour"), 10); if (hh === 24) hh = 0;
  return { wd: wd[gp("weekday")], hh, mm: parseInt(gp("minute"), 10), date: gp("year") + "-" + gp("month") + "-" + gp("day") };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: any = {}; try { body = req.method === "POST" ? await req.json() : {}; } catch (_) { body = {}; }
  const action = String(body.action || "run");
  /* WHO IS ASKING — resolved once, from proof. `body.code` is never consulted again. */
  const opsTok = await opsAuthorized(body.token);
  const me = opsTok ? "" : await sessionCode(body.session);
  const builder = me ? await isBuilder(me) : false;
  const isOps = opsTok || builder;

  async function editableBases(code: string) {
    const bases = await loadBases(); const out: string[] = [];
    if (isOps) return { all: true, bases: (bases.bases || []).map((b: any) => String(b.name)), root: bases.root };
    if (!code) return { all: false, bases: [], root: bases.root };
    const a = await agent(code);
    for (const b of (bases.bases || [])) { if (norm(b.owner_code) === norm(code)) out.push(String(b.name)); }
    if (a && lvlEMD(a) && a.baseshop) { const bn = String(a.baseshop); if (out.indexOf(bn) < 0) out.push(bn); }
    return { all: false, bases: out, root: bases.root };
  }

  if (action === "get") {
    if (!opsTok && !me) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401);
    const ed = await editableBases(me);
    const cfg = await loadCfg();
    return json({ ok: true, editable: ed.bases, is_ops: ed.all, is_builder: builder, hierarchy_editable: ed.all, config: cfg.bases || {}, hierarchy: cfg.hierarchy || { announce: true } });
  }

  if (action === "set") {
    if (!opsTok && !me) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401);
    const code = me; const base = String(body.baseshop || "");
    const ed = await editableBases(code);
    if (base === "__hierarchy__") { if (!ed.all) return json({ ok: false, error: "Operations only" }, 403); }
    else if (!ed.all && ed.bases.map(low).indexOf(low(base)) < 0) return json({ ok: false, error: "You can only edit your own baseshop" }, 403);
    const cfg = await loadCfg(); if (!cfg.bases) cfg.bases = {};
    const patch = (body.config && typeof body.config === "object") ? body.config : {};
    if (base === "__hierarchy__") cfg.hierarchy = { ...(cfg.hierarchy || {}), ...patch };
    else cfg.bases[low(base)] = { ...(cfg.bases[low(base)] || {}), ...patch };
    await saveKey("hub_bot_config", cfg);
    return json({ ok: true, config: cfg.bases, hierarchy: cfg.hierarchy });
  }

  if (action === "run") {
    if (!isOps) return json({ ok: false, error: "unauthorized" }, 401);
    const clk = ptClock(); const nowMin = clk.hh * 60 + clk.mm;
    const bases = await loadBases(); const cfg = await loadCfg(); const bcfg = cfg.bases || {};
    const rootLow = low(bases.root);
    let log: string[] = ((await loadKey("hub_announce_log2")) || {}).keys || [];
    const posted: string[] = []; const preview = !!body.preview;
    const baseChans = (bases.bases || []).filter((b: any) => low(b.name) !== rootLow).map((b: any) => ({ name: String(b.name), pfx: low(b.name) }));

    for (const s of SESSIONS) {
      if (s.d.indexOf(clk.wd) < 0) continue;
      const delta = (s.h * 60 + s.m) - nowMin;
      for (const bc of baseChans) {
        const sc = schedOf(bcfg[bc.pfx]);
        if (!sc.announce) continue;
        if (clk.hh < sc.quietBefore || clk.hh > sc.quietAfter) continue;   // the EMD's quiet hours
        let bucket = -1;
        for (const o of sc.reminders) { if (Math.abs(delta - o) <= 2) { bucket = o; break; } }
        if (bucket < 0) continue;
        const bkey = clk.date + "|" + bc.pfx + "|" + s.t + "|" + bucket;
        if (log.indexOf(bkey) >= 0) continue;
        const cta = bucket === 0 ? "It's LIVE — jump on now! \u{1F534}" : "Jump on and bring a teammate — let's fill the room! \u{1F525}";
        const txt = "\u{1F4E3} " + s.t + " " + offLabel(bucket) + "!\nHost: " + s.host + "\n\u{1F3A5} Join Zoom: " + s.z + "\n" + s.zt + "\n\n" + cta;
        if (!preview) { await post(bc.pfx + "_announcements", "STUART", "Stuart", txt); log.push(bkey); }
        posted.push(bkey);
      }
    }

    for (const bc of baseChans) {
      const sc = schedOf(bcfg[bc.pfx]);
      if (!sc.announce || !sc.highlights.length) continue;
      if (sc.hlDays.indexOf(clk.wd) < 0) continue;                 // only the days the EMD picked
      if (clk.hh !== sc.hlHour) continue;                          // at the hour the EMD picked
      const hkey = clk.date + "|HL|" + bc.pfx;
      if (log.indexOf(hkey) >= 0) continue;
      const txt = "\u{1F4CC} " + bc.name + " — Today's Highlights\n" + sc.highlights.map((h: string) => "• " + h).join("\n");
      if (!preview) { await post(bc.pfx + "_announcements", "STUART", "Stuart", txt); log.push(hkey); }
      posted.push(hkey);
    }

    if (!preview && posted.length) { if (log.length > 800) log = log.slice(log.length - 800); await saveKey("hub_announce_log2", { keys: log }); }
    return json({ ok: true, at: clk.date + " " + clk.hh + ":" + (clk.mm < 10 ? "0" : "") + clk.mm + " PT", posted, preview });
  }

  return json({ ok: false, error: "unknown action" }, 400);
});
