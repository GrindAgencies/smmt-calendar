// cal-sync v7 — import external calendar BUSY times from iCal (.ics) feeds to prevent
// double-bookings (Google secret iCal address [includes Calendly] + Apple published ICS).
// actions: get_feeds{session} | save_feeds{session,google_ics,apple_ics,calendly} | sync{session} | sync_all{token}.
// Busy stored on the broker's cft_availability entry: busy:[{date:'YYYY-MM-DD', s:minPT, e:minPT}].
// Recurring events expanded (RRULE FREQ DAILY/WEEKLY/MONTHLY/YEARLY + INTERVAL/BYDAY/COUNT/UNTIL/EXDATE).
// v4: MONTHLY nth-weekday (BYDAY=3TH / BYDAY=-1FR) + BYSETPOS — e.g. "3rd Thursday", "last Friday".
// v5 (2026-09-03): sync_all goes through ops_authorize — an Operations session or the cron
// machine token — instead of the literal "2026" that shipped inside ops.html.
// v6 (2026-09-03): every feed now reports back by name with a plain-English problem and fix.
// Before this, a wrong link failed silently: the page showed a green "connected" from whichever
// feed did work, so a broker whose Google link was a view/embed URL (HTTP 401) had no idea why
// their meetings never blocked bookings. Feeds are pre-checked for the common wrong-link shapes.
//
// v7 (2026-09-30) — THE FEED ADDRESSES ARE SECRETS, AND THEY WERE PUBLIC.
// get_feeds took a bare `code` and NO credential of any kind, then returned that person's Google
// SECRET iCal address and their Apple published ICS link. Those URLs are the calendar: anyone
// holding one can read every event, title and time in it, indefinitely, from anywhere — and GFI
// codes are printed on the org chart, so all 189 people's private calendars were one request away
// from any stranger on the internet. save_feeds was the mirror image: it could repoint somebody's
// busy-time import at a calendar the attacker controls, which silently decides when that trainer
// appears free to be booked.
// Identity is now the session token minted at PIN entry, and a member only ever reads or writes
// their OWN feeds. sync_all stays an Operations/cron job.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
function json(o: unknown, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const low = (s: unknown) => (s ?? "").toString().trim().toLowerCase();
const clean = (s: unknown) => (s ?? "").toString().trim().slice(0, 600);
const full = (a: any) => `${a.first_name || ""} ${a.last_name || ""}`.trim();
const pad = (n: number) => (n < 10 ? "0" + n : "" + n);
const DOW: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const GOOGLE_FIX = "Google Calendar → Settings → click your calendar in the left list → Integrate calendar → copy the Secret address in iCal format (it ends in /basic.ics).";
const APPLE_FIX = "On a Mac: right-click the calendar → Share Calendar → tick Public Calendar → copy that link. On iPhone: Calendars → the (i) next to the calendar → Public Calendar → Share Link.";
function nthWeekday(y: number, mo: number, dow: number, ord: number): number | null {
  if (ord > 0) { const fdow = new Date(Date.UTC(y, mo - 1, 1)).getUTCDay(); const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate(); const day = 1 + ((dow - fdow + 7) % 7) + (ord - 1) * 7; return day <= dim ? day : null; }
  const last = new Date(Date.UTC(y, mo, 0)); const ldow = last.getUTCDay(); const dim = last.getUTCDate(); const day = dim - ((ldow - dow + 7) % 7) + (ord + 1) * 7; return day >= 1 ? day : null;
}

// ---- plain-English diagnosis of a feed link ----
// Catches the wrong-link shapes people actually paste before we even make a request.
function feedHint(label: string, rawUrl: string): string {
  const u = low(rawUrl);
  if (label === "Google") {
    if (u.indexOf("/calendar/embed") >= 0 || u.indexOf("cid=") >= 0) return "That is the Google view/embed link, not a calendar feed. " + GOOGLE_FIX;
    if (u.indexOf("calendar.google.com/calendar/u/") >= 0 || u.indexOf("/r/") >= 0) return "That link just opens Google Calendar in a browser. " + GOOGLE_FIX;
    if (u.indexOf(".ics") < 0) return "A Google calendar feed address ends in .ics. " + GOOGLE_FIX;
  }
  if (label === "Apple") {
    if (u.indexOf("icloud.com") >= 0 && u.indexOf("/published/") < 0) return "That is not a published iCloud calendar link. " + APPLE_FIX;
    if (u.indexOf(".ics") < 0 && u.indexOf("/published/") < 0) return "That does not look like a shared calendar link. " + APPLE_FIX;
  }
  return "";
}
function httpProblem(label: string, status: number): { problem: string; fix: string } {
  if (status === 401 || status === 403) return { problem: `${label} refused that link because it is private.`, fix: label === "Google" ? GOOGLE_FIX : APPLE_FIX };
  if (status === 404) return { problem: `${label} says that link no longer exists.`, fix: `Create the sharing link again and paste the new one. ${label === "Google" ? GOOGLE_FIX : APPLE_FIX}` };
  if (status >= 500) return { problem: `${label} is having trouble right now — nothing is wrong with your link.`, fix: "Press Sync again in a few minutes." };
  return { problem: `${label} returned an error (HTTP ${status}).`, fix: label === "Google" ? GOOGLE_FIX : APPLE_FIX };
}

async function loadKey(k: string) { const r = await fetch(`${SUPA}/rest/v1/app_settings?key=eq.${k}&select=value`, { headers: DBH }); const rows = await r.json(); return (rows && rows[0]) ? rows[0].value : null; }
async function saveCftAvail(value: unknown) { await fetch(`${SUPA}/rest/v1/app_settings?on_conflict=key`, { method: "POST", headers: { ...DBH, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key: "cft_availability", value, updated_at: new Date().toISOString() }) }); }
async function getJSON(path: string) { const r = await fetch(`${SUPA}/rest/v1/${path}`, { headers: DBH }); return (await r.json()) || []; }
async function rpc(fn: string, args: Record<string, unknown>) { try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); return await r.json(); } catch (_) { return null; } }
async function opsAuthorized(token: unknown) { const t = String(token ?? ""); if (!t) return false; const r = await rpc("ops_authorize", { p_token: t }); return !!(r && r.ok); }
/* Proof of identity. A session token is proof; a typed code is not — and what this function hands
   back is a secret calendar URL, so there is no version of "close enough" here. */
async function sessionCode(session: unknown): Promise<string> {
  const s = String(session ?? "").trim().slice(0, 120);
  if (!s) return "";
  const got = await rpc("agent_session_code", { p_token: s });
  return (typeof got === "string") ? norm(got) : "";
}

function ptParts(d: Date) {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
  const g = (t: string) => { const x = p.find((q) => q.type === t); return x ? x.value : "00"; };
  let hh = parseInt(g("hour"), 10); if (hh === 24) hh = 0;
  return { date: `${g("year")}-${g("month")}-${g("day")}`, min: hh * 60 + parseInt(g("minute"), 10) };
}
function addDaysYMD(ymd: string, n: number) { const d = new Date(ymd + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function unfold(txt: string) { return txt.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, ""); }
function lineVal(block: string, key: string) { const re = new RegExp("(?:^|\\n)" + key + "(?:;[^:\\n]*)?:([^\\n\\r]+)"); const m = re.exec(block); return m ? m[1].trim() : ""; }
function parseDTraw(val: string): any { const m = /(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?/.exec(val || ""); if (!m) return null; if (!m[4]) return { allday: true, y: +m[1], mo: +m[2], d: +m[3] }; return { allday: false, y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], z: m[7] === "Z" }; }

function pushWindow(out: any[], dstr: string, min: number, durMin: number, allday: boolean) {
  if (allday) { const days = Math.max(1, Math.round(durMin / 1440)); for (let i = 0; i < days; i++) out.push({ date: addDaysYMD(dstr, i), s: 0, e: 1440 }); return; }
  let remaining = durMin, curDate = dstr, curStart = min, g = 0;
  while (remaining > 0 && g++ < 8) { const avail = 1440 - curStart; const chunk = Math.min(remaining, avail); out.push({ date: curDate, s: curStart, e: curStart + chunk }); remaining -= chunk; curStart = 0; curDate = addDaysYMD(curDate, 1); }
}
function eventBusy(ev: string, today: string, horizon: string): any[] {
  const dtS = parseDTraw(lineVal(ev, "DTSTART")); if (!dtS) return [];
  const dtE = parseDTraw(lineVal(ev, "DTEND"));
  const allday = !!dtS.allday;
  let durMin: number;
  if (allday) { durMin = 1440; if (dtE && dtE.allday) { const s = Date.UTC(dtS.y, dtS.mo - 1, dtS.d); const e = Date.UTC(dtE.y, dtE.mo - 1, dtE.d); const dm = Math.round((e - s) / 60000); if (dm > 0) durMin = dm; } }
  else { const s = Date.UTC(dtS.y, dtS.mo - 1, dtS.d, dtS.h, dtS.mi); const e = (dtE && !dtE.allday) ? Date.UTC(dtE.y, dtE.mo - 1, dtE.d, dtE.h, dtE.mi) : s + 3600000; durMin = Math.max(15, Math.round((e - s) / 60000)); }
  const toPT = (y: number, mo: number, d: number) => { if (allday) return { date: `${y}-${pad(mo)}-${pad(d)}`, min: 0 }; if (dtS.z) return ptParts(new Date(Date.UTC(y, mo - 1, d, dtS.h, dtS.mi))); return { date: `${y}-${pad(mo)}-${pad(d)}`, min: dtS.h * 60 + dtS.mi }; };
  const ex: Record<string, number> = {}; (ev.match(/EXDATE[^:\n]*:([^\n\r]+)/g) || []).forEach((lineStr) => { const vals = (lineStr.split(":")[1] || ""); vals.split(",").forEach((v) => { const mm = /(\d{4})(\d{2})(\d{2})/.exec(v); if (mm) ex[`${mm[1]}-${mm[2]}-${mm[3]}`] = 1; }); });
  const out: any[] = [];
  const add = (y: number, mo: number, d: number) => { const key = `${y}-${pad(mo)}-${pad(d)}`; if (ex[key]) return; const p = toPT(y, mo, d); if (p.date < today || p.date > horizon) return; pushWindow(out, p.date, p.min, durMin, allday); };
  const rr = lineVal(ev, "RRULE");
  if (!rr) { add(dtS.y, dtS.mo, dtS.d); return out; }
  const R: Record<string, string> = {}; rr.split(";").forEach((kv) => { const i = kv.indexOf("="); if (i > 0) R[kv.slice(0, i).toUpperCase()] = kv.slice(i + 1); });
  const freq = (R.FREQ || "").toUpperCase(); const interval = Math.max(1, parseInt(R.INTERVAL || "1", 10) || 1);
  const count = R.COUNT ? parseInt(R.COUNT, 10) : null; let until: string | null = null; if (R.UNTIL) { const um = /(\d{4})(\d{2})(\d{2})/.exec(R.UNTIL); if (um) until = `${um[1]}-${um[2]}-${um[3]}`; }
  const bydayFull = (R.BYDAY ? R.BYDAY.split(",") : []).map((x) => { const s = x.trim().toUpperCase(); const dow = DOW[s.slice(-2)]; const om = /^(-?\d+)/.exec(s); return (dow === undefined) ? null : { ord: om ? parseInt(om[1], 10) : 0, dow }; }).filter(Boolean) as { ord: number; dow: number }[];
  const byday = bydayFull.map((b) => b.dow);
  const setpos = (R.BYSETPOS ? R.BYSETPOS.split(",") : []).map((x) => parseInt(x.trim(), 10)).filter((x) => !isNaN(x));
  const ymdStr = (dt: Date) => `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
  const startMs = Date.UTC(dtS.y, dtS.mo - 1, dtS.d);
  let emitted = 0, guard = 0;
  if (freq === "WEEKLY" && byday.length) {
    const weekOf = (dt: Date) => { const w = new Date(dt.getTime()); w.setUTCDate(w.getUTCDate() - w.getUTCDay()); return w.getTime(); };
    const startWeek = weekOf(new Date(startMs)); const cur = new Date(startMs);
    while (guard++ < 800) { const ds = ymdStr(cur); if (ds > horizon) break; if (until && ds > until) break; if (count && emitted >= count) break;
      if (cur.getTime() >= startMs && byday.indexOf(cur.getUTCDay()) >= 0) { const wk = Math.round((weekOf(cur) - startWeek) / (7 * 86400000)); if (wk % interval === 0) { add(cur.getUTCFullYear(), cur.getUTCMonth() + 1, cur.getUTCDate()); emitted++; } }
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return out;
  }
  if (freq === "MONTHLY" && bydayFull.length) {
    let y = dtS.y, mo = dtS.mo;
    while (guard++ < 600) { const firstOfMonth = `${y}-${pad(mo)}-01`; if (firstOfMonth > horizon) break; if (until && until < firstOfMonth) break; if (count && emitted >= count) break;
      let cands: number[] = [];
      for (const bd of bydayFull) { if (bd.ord !== 0) { const d = nthWeekday(y, mo, bd.dow, bd.ord); if (d) cands.push(d); } else { for (let k = 1; k <= 5; k++) { const d = nthWeekday(y, mo, bd.dow, k); if (d) cands.push(d); } } }
      cands = Array.from(new Set(cands)).sort((a, b) => a - b);
      if (setpos.length) { const picked: number[] = []; for (const sp of setpos) { const idx = sp > 0 ? sp - 1 : cands.length + sp; if (idx >= 0 && idx < cands.length) picked.push(cands[idx]); } cands = Array.from(new Set(picked)).sort((a, b) => a - b); }
      for (const d of cands) { const ds = `${y}-${pad(mo)}-${pad(d)}`; if (until && ds > until) continue; if (ds > horizon) continue; if (count && emitted >= count) break; if (Date.UTC(y, mo - 1, d) >= startMs) { add(y, mo, d); emitted++; } }
      mo += interval; while (mo > 12) { mo -= 12; y++; }
    }
    return out;
  }
  const cur = new Date(startMs);
  while (guard++ < 800) { const ds = ymdStr(cur); if (until && ds > until) break; if (ds > horizon) break; if (count && emitted >= count) break;
    add(cur.getUTCFullYear(), cur.getUTCMonth() + 1, cur.getUTCDate()); emitted++;
    if (freq === "DAILY") cur.setUTCDate(cur.getUTCDate() + interval);
    else if (freq === "WEEKLY") cur.setUTCDate(cur.getUTCDate() + 7 * interval);
    else if (freq === "MONTHLY") cur.setUTCMonth(cur.getUTCMonth() + interval);
    else if (freq === "YEARLY") cur.setUTCFullYear(cur.getUTCFullYear() + interval);
    else break;
  }
  return out;
}

async function fetchBusy(feeds: { label: string; url: string }[]) {
  const today = ptParts(new Date()).date; const horizon = ptParts(new Date(Date.now() + 60 * 86400000)).date;
  const busy: any[] = []; const srcs: any[] = [];
  for (const feed of feeds) {
    const label = feed.label;
    let url = (feed.url || "").trim(); if (!url) continue;
    const hint = feedHint(label, url);
    if (url.indexOf("webcal://") === 0) url = "https://" + url.slice(9);
    if (!/^https?:\/\//i.test(url)) { srcs.push({ label, ok: false, err: "not a URL", problem: `That ${label} entry is not a web address.`, fix: label === "Google" ? GOOGLE_FIX : APPLE_FIX }); continue; }
    try {
      const r = await fetch(url, { headers: { "User-Agent": "smmt-cal-sync" } });
      if (!r.ok) { const p = httpProblem(label, r.status); srcs.push({ label, ok: false, err: "HTTP " + r.status, problem: hint || p.problem, fix: p.fix }); continue; }
      const txt = unfold(await r.text());
      if (txt.indexOf("BEGIN:VEVENT") < 0 && txt.indexOf("BEGIN:VCALENDAR") < 0) { srcs.push({ label, ok: false, err: "not an iCal feed", problem: hint || `That ${label} link opens a web page, not a calendar feed.`, fix: label === "Google" ? GOOGLE_FIX : APPLE_FIX }); continue; }
      let events = 0; const blocks = txt.split("BEGIN:VEVENT").slice(1);
      for (const b of blocks) {
        const ev = b.split("END:VEVENT")[0];
        if (/\nSTATUS:CANCELLED/i.test(ev) || /\nTRANSP:TRANSPARENT/i.test(ev)) continue;
        const occ = eventBusy(ev, today, horizon);
        if (occ.length) { for (const x of occ) busy.push(x); events++; }
      }
      srcs.push({ label, ok: true, events, blocks: blocks.length });
    } catch (e) { srcs.push({ label, ok: false, err: String(e).slice(0, 80), problem: `We could not reach that ${label} link.`, fix: "Check the link opens for you, then paste it again." }); }
  }
  if (busy.length > 4000) busy.length = 4000;
  return { busy, srcs };
}
async function syncOne(agent: any, avail: any) {
  const feeds = [{ label: "Google", url: clean(agent.google_ics) }, { label: "Apple", url: clean(agent.apple_ics) }].filter((f) => !!f.url);
  const nm = low(full(agent));
  const idx = (avail && Array.isArray(avail.cfts)) ? avail.cfts.findIndex((c: any) => low(c.name) === nm) : -1;
  if (!feeds.length) { if (idx >= 0 && avail.cfts[idx].busy && avail.cfts[idx].busy.length) { avail.cfts[idx].busy = []; return { code: agent.code, busy_count: 0, stored: true, sources: [], problems: [] }; } return { code: agent.code, busy_count: 0, stored: false, sources: [], problems: [] }; }
  const { busy, srcs } = await fetchBusy(feeds);
  let stored = false;
  if (idx >= 0) { avail.cfts[idx].busy = busy; avail.cfts[idx].busy_synced = new Date().toISOString(); stored = true; }
  const problems = srcs.filter((s: any) => !s.ok).map((s: any) => ({ label: s.label, problem: s.problem || s.err, fix: s.fix || "" }));
  return { code: agent.code, busy_count: busy.length, stored, sources: srcs, problems };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: any = {}; try { body = req.method === "POST" ? await req.json() : {}; } catch (_) { body = {}; }
  const url = new URL(req.url);
  const action = String(body.action || url.searchParams.get("action") || "get_feeds");

  if (action === "sync_all") {
    if (!(await opsAuthorized(body.token))) return json({ ok: false, error: "unauthorized" }, 401);
    const agents = await getJSON(`tracker_agents?or=(google_ics.not.is.null,apple_ics.not.is.null)&select=code,first_name,last_name,google_ics,apple_ics&limit=500`);
    const avail = (await loadKey("cft_availability")) || { cfts: [] };
    let changed = false; let cnt = 0; const broken: any[] = [];
    for (const a of agents) { const res = await syncOne(a, avail); if (res.stored) changed = true; cnt++; if (res.problems && res.problems.length) broken.push({ code: a.code, name: full(a), problems: res.problems }); }
    if (changed) await saveCftAvail(avail);
    return json({ ok: true, synced: cnt, broken_count: broken.length, broken });
  }

  /* Everything below reads or writes somebody's private calendar address, so it needs proof.
     Operations may name an agent (support); a member is only ever themselves. */
  const isOps = await opsAuthorized(body.token);
  const sess = isOps ? "" : await sessionCode(body.session);
  if (!isOps && !sess) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401);
  const code = isOps ? norm(body.code || url.searchParams.get("code")) : sess;
  if (!code) return json({ ok: false, error: "code required" }, 400);

  if (action === "get_feeds") {
    const rows = await getJSON(`tracker_agents?code=eq.${encodeURIComponent(code)}&select=code,first_name,last_name,google_ics,apple_ics,cal_link&limit=1`);
    const a = rows[0]; if (!a) return json({ ok: false, error: "agent not found" }, 404);
    const avail = (await loadKey("cft_availability")) || { cfts: [] };
    const nm = low(full(a)); const c = (avail && Array.isArray(avail.cfts)) ? avail.cfts.find((x: any) => low(x.name) === nm) : null;
    return json({ ok: true, google_ics: a.google_ics || "", apple_ics: a.apple_ics || "", calendly: a.cal_link || "", is_trainer: !!c, busy_count: (c && Array.isArray(c.busy)) ? c.busy.length : 0, last_synced: (c && c.busy_synced) || "" });
  }

  if (action === "save_feeds") {
    const patch: Record<string, unknown> = {};
    if (body.google_ics !== undefined) patch.google_ics = clean(body.google_ics) || null;
    if (body.apple_ics !== undefined) patch.apple_ics = clean(body.apple_ics) || null;
    if (body.calendly !== undefined) patch.cal_link = clean(body.calendly) || null;
    if (Object.keys(patch).length) await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${encodeURIComponent(code)}`, { method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify(patch) });
    const rows = await getJSON(`tracker_agents?code=eq.${encodeURIComponent(code)}&select=code,first_name,last_name,google_ics,apple_ics&limit=1`);
    const a = rows[0]; const avail = (await loadKey("cft_availability")) || { cfts: [] };
    const res = a ? await syncOne(a, avail) : { busy_count: 0, stored: false, sources: [], problems: [] };
    if (res.stored) await saveCftAvail(avail);
    return json({ ok: true, saved: true, ...res });
  }

  if (action === "sync") {
    const rows = await getJSON(`tracker_agents?code=eq.${encodeURIComponent(code)}&select=code,first_name,last_name,google_ics,apple_ics&limit=1`);
    const a = rows[0]; if (!a) return json({ ok: false, error: "agent not found" }, 404);
    const avail = (await loadKey("cft_availability")) || { cfts: [] };
    const res = await syncOne(a, avail); if (res.stored) await saveCftAvail(avail);
    return json({ ok: true, ...res });
  }

  return json({ ok: false, error: "unknown action" }, 400);
});
