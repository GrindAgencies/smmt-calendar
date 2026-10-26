// atlas-api v20 (2026-10-26): Operations can staff-book without an agent code (atlas_staff_book).
// atlas-api v19 (2026-10-21): notification bodies no longer print "null". See the compose
//   helpers above Deno.serve. 5 bookings have no confirmation code and 20 no trainer name,
//   so raw interpolation was sending "... · null" and "... with null" to real phones.
// atlas-api v18 (2026-09-30): WHO IS CALLING. Every action except the four public ones took its
//   caller from a typed `code`, and GFI codes are printed on the org chart. That meant: book a
//   trainer AS a colleague; read anyone's bookings (atlas_my); cancel or mark no-show on somebody
//   else's training; approve or decline a training request in a trainer's name; hand a booking to
//   a different trainer; and, by typing an EMD's code, rewrite the scheduler configuration and
//   read the outbound message queue, which carries clients' email addresses and phone numbers.
//   Identity is now the session token minted at PIN entry.
//   The atlas_public_* actions are the client-facing booking page. They never read body.code, they
//   are reached by strangers holding a booking link, and they are deliberately left untouched.
// atlas-api v17 — bookings + availability + transfers + approvals + public/staff +
// self-manage + smart availability + reminders + cancel notifications
// v17 (2026-09-05): the 24-hour and 1-hour reminders no longer repeat every 15 minutes.
//   Their "already sent" marker was only written when queueClientMsg() had a client email
//   or phone to write. An INTERNAL booking (a broker booking a trainer) has neither, so no
//   marker was ever written and the trainer notification re-fired on every cron tick inside
//   the reminder window — 8 copies of "Tomorrow: Field Training", 2 of "In ~1 hour". Now an
//   in-app marker is written unconditionally, the way the no-show flag already did it.
// v13: cftAvailTimes also excludes imported external-calendar BUSY blocks (cft.busy from cal-sync),
// so the PUBLIC booking page + reschedule + staff booking all avoid double-booking against Calendly/Google/Apple.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
async function _rpc(fn: string, args: Record<string, unknown>) { try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); return await r.json(); } catch (_) { return null; } }
async function opsAuthorized(token: unknown) { const r = await _rpc("ops_authorize", { p_token: String(token ?? "") }); return !!(r && r.ok); }
const DEFAULT_DUR = 60;
const DEFAULT_TZ  = "America/Los_Angeles";
const WD = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

const DBH  = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
function json(o: unknown, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }

const norm  = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const clean = (s: unknown) => (s ?? "").toString().trim().slice(0, 500);
const lo    = (s: unknown) => (s ?? "").toString().trim().toLowerCase();

function confCode() { const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; let s = "GFI-"; for (let i = 0; i < 5; i++) s += a[Math.floor(Math.random() * a.length)]; return s; }
function prettyPT(dateYMD: string, timeStr: string) { try { const d = new Date(dateYMD + "T12:00:00Z"); const wd = d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }); const mo = d.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }); return `${wd}, ${mo} ${d.getUTCDate()} at ${timeStr} PT`; } catch (_) { return `${dateYMD} at ${timeStr} PT`; } }
const slugify = (s: unknown) => (s ?? "").toString().trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
function addDaysStr(ymd: string, n: number) { const d = new Date(ymd + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function todayPT() { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date()); }
function nowPTparts() { const f = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }); const p: Record<string, string> = {}; f.formatToParts(new Date()).forEach((x) => { p[x.type] = x.value; }); return { date: `${p.year}-${p.month}-${p.day}`, minutes: (Number(p.hour) % 24) * 60 + Number(p.minute) }; }
function computeCutoff(minNoticeHours: number) { const n = nowPTparts(); let date = n.date; let mins = n.minutes + Math.round((minNoticeHours || 0) * 60); while (mins >= 1440) { mins -= 1440; date = addDaysStr(date, 1); } return { date, minutes: mins }; }
function isClosure(dstr: string, closures: any[]): boolean { return (closures || []).some((cl: any) => { if (typeof cl === "string") return cl === dstr; if (cl && cl.date) return cl.date === dstr; if (cl && cl.start && cl.end) return dstr >= cl.start && dstr <= cl.end; return false; }); }
function t2minSrv(t: string) { const m = /(\d+):(\d+)\s*(AM|PM)/i.exec(t || ""); if (!m) return 0; let h = (+m[1]) % 12; if (/PM/i.test(m[3])) h += 12; return h * 60 + (+m[2]); }
function inRangeD(dstr: string, r: any) { return r && dstr >= r.start && dstr <= r.end; }
function cftAvailTimes(c: any, dstr: string, bookedTimes: string[], opts?: any): string[] {
  opts = opts || {};
  if (c.locked) return [];
  if (isClosure(dstr, opts.closures)) return [];
  if ((c.lockouts || []).some((r: any) => inRangeD(dstr, r))) return [];
  if ((c.vacations || []).some((r: any) => inRangeD(dstr, r))) return [];
  if ((c.blackouts || []).indexOf(dstr) >= 0) return [];
  const key = WD[new Date(dstr + "T12:00:00Z").getUTCDay()];
  let slots = (c.slots && c.slots[key]) ? c.slots[key] : [];
  slots = slots.filter((t: string) => bookedTimes.indexOf(t) < 0);
  const busy = (c.busy || []).filter((b: any) => b && b.date === dstr);
  if (busy.length) slots = slots.filter((t: string) => { const tm = t2minSrv(t); return !busy.some((b: any) => (Number(b.s) || 0) < tm + 60 && (Number(b.e) || 1440) > tm); });
  if (opts.cutoff) { const cd = opts.cutoff.date, cm = opts.cutoff.minutes; slots = slots.filter((t: string) => { if (dstr > cd) return true; if (dstr < cd) return false; return t2minSrv(t) >= cm; }); }
  return slots;
}
async function loadBookingTypes(): Promise<any[]> { const r = await fetch(`${SUPA}/rest/v1/app_settings?key=eq.booking_types&select=value`, { headers: DBH }); const rows = await r.json(); return (rows && rows[0] && rows[0].value && Array.isArray(rows[0].value.types)) ? rows[0].value.types : []; }
async function loadSchedulerConfig() { const r = await fetch(`${SUPA}/rest/v1/app_settings?key=eq.scheduler_config&select=value`, { headers: DBH }); const rows = await r.json(); const v = (rows && rows[0]) ? rows[0].value : {}; return { min_notice_hours: Number(v && v.min_notice_hours) || 0, closures: Array.isArray(v && v.closures) ? v.closures : [] }; }
async function availOpts() { const s = await loadSchedulerConfig(); return { closures: s.closures, cutoff: computeCutoff(s.min_notice_hours) }; }
async function resolveTrainerCode(trainerName: string): Promise<string | null> { const target = clean(trainerName).toLowerCase(); if (!target) return null; const r = await fetch(`${SUPA}/rest/v1/tracker_agents?select=code,first_name,last_name&status=neq.quit`, { headers: DBH }); if (!r.ok) return null; const rows = (await r.json()) || []; for (const row of rows) { const full = `${row.first_name || ""} ${row.last_name || ""}`.trim().toLowerCase(); if (full === target) return row.code; } return null; }
async function codeToName(code: string): Promise<string | null> { const c = norm(code); if (!c) return null; const r = await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${encodeURIComponent(c)}&select=first_name,last_name`, { headers: DBH }); if (!r.ok) return null; const rows = (await r.json()) || []; if (rows[0]) return `${rows[0].first_name || ""} ${rows[0].last_name || ""}`.trim(); return null; }
async function loadCftAvail(): Promise<any | null> { const r = await fetch(`${SUPA}/rest/v1/app_settings?key=eq.cft_availability&select=value`, { headers: DBH }); const rows = await r.json(); return (rows && rows[0]) ? rows[0].value : null; }
function roleOfName(name: string, avail: any): string | null { if (!avail || !Array.isArray(avail.cfts)) return null; const e = avail.cfts.find((c: any) => lo(c.name) === lo(name)); return e ? (e.role || "").toUpperCase() : null; }
async function roleOfCode(code: string, avail: any): Promise<string | null> { if (!code) return null; const name = await codeToName(code); if (!name) return null; return roleOfName(name, avail); }
async function saveCftAvail(value: unknown) { return fetch(`${SUPA}/rest/v1/app_settings?on_conflict=key`, { method: "POST", headers: { ...DBH, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key: "cft_availability", value, updated_at: new Date().toISOString() }) }); }
async function fireNotify(recipient_name: string, recipient_code: string | null, title: string, body: string, actor: string, ref_id: string) { try { await fetch(`${SUPA}/rest/v1/notifications`, { method: "POST", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify({ recipient_name, recipient_code: recipient_code || null, type: "booking", title, body, link: "calendar.html", actor, ref_id }) }); } catch (_) { /* */ } }
async function queueOutbound(m: any) { try { await fetch(`${SUPA}/rest/v1/outbound_messages`, { method: "POST", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify(m) }); } catch (_) { /* */ } }
async function alreadyQueued(bookingId: string, kind: string): Promise<boolean> { const r = await fetch(`${SUPA}/rest/v1/outbound_messages?booking_id=eq.${encodeURIComponent(bookingId)}&kind=eq.${encodeURIComponent(kind)}&select=id&limit=1`, { headers: DBH }); const rows = await r.json(); return Array.isArray(rows) && rows.length > 0; }
async function queueClientMsg(bk: any, kind: string, subject: string, bodyText: string) { if (!bk || !bk.id) return; if (bk.client_email) await queueOutbound({ booking_id: bk.id, conf: bk.conf, channel: "email", kind, recipient: bk.agent_name || "Client", to_email: bk.client_email, subject, body: bodyText, status: "queued" }); if (bk.client_phone) await queueOutbound({ booking_id: bk.id, conf: bk.conf, channel: "sms", kind, recipient: bk.agent_name || "Client", to_phone: bk.client_phone, body: bodyText, status: "queued" }); }
// Records that a reminder of this kind has gone out for this booking, whether or not the
// client had an email or phone. Without it a reminder repeats on every tick of the cron.
async function markReminded(bk: any, kind: string) { if (!bk || !bk.id) return; await queueOutbound({ booking_id: bk.id, conf: bk.conf, channel: "inapp", kind, recipient: bk.trainer_name || "", status: "sent", sent_at: new Date().toISOString() }); }

/* ===== composing a message out of parts that may not exist =========================
   "Elijah Cox · Tue, Oct 20 at 3:00 PM PT · null" reached a real phone. These bodies were
   built by raw interpolation, and in this ledger 5 bookings carry no confirmation code and
   20 carry no trainer name — so `${b.conf}` rendered the string "null" and `with
   ${bk.trainer_name}` rendered "with null". Absent parts now drop out WITH their separator
   rather than being serialised at the reader. */
const present = (v: unknown) => {
  /* A boolean is never a sentence fragment — String(false) would have put the word "false"
     in front of an agent. A NUMBER is deliberately kept, including 0: silently swallowing it
     would hide a caller passing the wrong thing rather than fix it. */
  if (v === null || v === undefined || typeof v === "boolean") return "";
  const s = String(v).trim();
  return (s && s !== "null" && s !== "undefined") ? s : "";
};
const dot = (...parts: unknown[]) => parts.map(present).filter(Boolean).join(" · ");
/* "Confirmation ABC123" or nothing at all — never a bare label with nothing after it. */
const tag = (label: string, v: unknown) => { const x = present(v); return x ? (label ? label + " " + x : x) : ""; };
/* " with Elijah Cox" or nothing — the leading space belongs to the fragment. */
const withWho = (v: unknown) => { const x = present(v); return x ? (" with " + x) : ""; };
/* " Confirmation ABC123." as a sentence tail, or nothing. */
const confNote = (v: unknown) => { const x = present(v); return x ? (" Confirmation " + x + ".") : ""; };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = new URL(req.url);
    let body: Record<string, unknown> = {};
    if (req.method === "POST") body = await req.json().catch(() => ({}));
    const action = (body.action as string) || url.searchParams.get("action") || "";
    const token  = (body.token  as string) || url.searchParams.get("token")  || "";
    // One authorisation for the whole request. The token may arrive in the body or the
    // query string depending on the action, so both are resolved the same way.
    const isAdmin = await opsAuthorized(token);

    /* Resolve the caller ONCE and overwrite body.code with the verified answer, so every check
       below becomes sound exactly where it already stands. The public booking actions are skipped:
       an external client has no account to prove. */
    const PUBLIC = action.indexOf("atlas_public_") === 0;
    if (!isAdmin && !PUBLIC) {
      const sess = (body.session ?? url.searchParams.get("session") ?? "").toString().trim().slice(0, 120);
      const who = sess ? await _rpc("agent_session_code", { p_token: sess }) : null;
      const sc = (typeof who === "string") ? norm(who) : "";
      if (!sc) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401);
      body.code = sc;
    }

    if (action === "atlas_cron_tick") {
      if (!isAdmin) return json({ ok: false, error: "unauthorized" }, 401);
      const now = Date.now(); const iso = (ms: number) => new Date(ms).toISOString();
      let q24 = 0, q1 = 0, ns = 0; const sel = "id,conf,agent_name,client_email,client_phone,trainer_name,trainer_code,category,date,time";
      const r24 = await fetch(`${SUPA}/rest/v1/bookings?status=in.(booked,confirmed)&starts_at=gte.${iso(now + 23 * 3600000)}&starts_at=lte.${iso(now + 25 * 3600000)}&select=${sel}`, { headers: DBH });
      for (const b of ((await r24.json()) || [])) { if (await alreadyQueued(b.id, "reminder_24h")) continue; const when = prettyPT(b.date, b.time); await queueClientMsg(b, "reminder_24h", `Reminder: ${b.category} tomorrow`, `Reminder: your ${b.category}${withWho(b.trainer_name)} is tomorrow — ${when}.${confNote(b.conf)}`); await markReminded(b, "reminder_24h"); fireNotify(b.trainer_name, b.trainer_code, `Tomorrow: ${b.category}`, dot(b.agent_name || "Client", when, b.conf), "Reminder", b.conf); q24++; }
      const r1 = await fetch(`${SUPA}/rest/v1/bookings?status=in.(booked,confirmed)&starts_at=gte.${iso(now + 45 * 60000)}&starts_at=lte.${iso(now + 75 * 60000)}&select=${sel}`, { headers: DBH });
      for (const b of ((await r1.json()) || [])) { if (await alreadyQueued(b.id, "reminder_1h")) continue; const when = prettyPT(b.date, b.time); await queueClientMsg(b, "reminder_1h", `Starting soon: ${b.category}`, `Your ${b.category}${withWho(b.trainer_name)} starts within the hour — ${when}.${confNote(b.conf)}`); await markReminded(b, "reminder_1h"); fireNotify(b.trainer_name, b.trainer_code, `In ~1 hour: ${b.category}`, dot(b.agent_name || "Client", when, b.conf), "Reminder", b.conf); q1++; }
      const nsr = await fetch(`${SUPA}/rest/v1/bookings?status=in.(booked,confirmed)&ends_at=lt.${iso(now - 30 * 60000)}&select=${sel}&limit=200`, { headers: DBH });
      for (const b of ((await nsr.json()) || [])) { if (await alreadyQueued(b.id, "noshow_flag")) continue; await queueOutbound({ booking_id: b.id, conf: b.conf, channel: "inapp", kind: "noshow_flag", recipient: b.trainer_name, status: "sent", sent_at: new Date().toISOString() }); fireNotify(b.trainer_name, b.trainer_code, `Did they show? ${b.category}`, dot(b.agent_name || "Client", prettyPT(b.date, b.time), "mark Completed or No-show", b.conf), "Reminder", b.conf); ns++; }
      return json({ ok: true, reminders_24h: q24, reminders_1h: q1, noshow_flags: ns });
    }

    if (action === "atlas_outbound_queue") {
      const authCode = norm(body.code || url.searchParams.get("code")); const avail = await loadCftAvail(); const role = (isAdmin) ? "OPS" : await roleOfCode(authCode, avail);
      if (!isAdmin && role !== "EMD") return json({ ok: false, error: "Only an EMD or Ops can view the message queue." }, 401);
      const st = clean(body.status || url.searchParams.get("status")) || "queued";
      const ex = await fetch(`${SUPA}/rest/v1/outbound_messages?status=eq.${encodeURIComponent(st)}&order=created_at.desc&select=id,conf,channel,kind,recipient,to_email,to_phone,subject,status,created_at&limit=300`, { headers: DBH });
      return json({ ok: true, messages: (await ex.json()) || [] });
    }

    if (action === "atlas_public_types") { const types = (await loadBookingTypes()).filter((t: any) => t.active !== false).map((t: any) => ({ key: t.key, name: t.name, duration: t.duration || 60, medium: t.medium || "video", location_based: !!t.location_based, variable_duration: !!t.variable_duration })); return json({ ok: true, types }); }

    if (action === "atlas_scheduler_config") {
      if (lo(body.op) !== "save") { return json({ ok: true, config: await loadSchedulerConfig() }); }
      const authCode = norm(body.code); const avail = await loadCftAvail(); const role = (isAdmin) ? "OPS" : await roleOfCode(authCode, avail);
      if (!isAdmin && role !== "EMD") return json({ ok: false, error: "Only an EMD or Ops can change scheduler settings." }, 401);
      const cur = await loadSchedulerConfig();
      const next = { min_notice_hours: (body.min_notice_hours !== undefined) ? Math.max(0, Number(body.min_notice_hours) || 0) : cur.min_notice_hours, closures: Array.isArray(body.closures) ? body.closures : cur.closures };
      const up = await fetch(`${SUPA}/rest/v1/app_settings?on_conflict=key`, { method: "POST", headers: { ...DBH, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key: "scheduler_config", value: next, updated_at: new Date().toISOString() }) });
      return json({ ok: up.ok, config: next });
    }

    if (action === "atlas_public_trainer") {
      const slug = slugify(body.slug || url.searchParams.get("slug")); if (!slug) return json({ ok: false, error: "no trainer" }, 400);
      const days = Math.min(21, Math.max(1, Number(body.days || url.searchParams.get("days")) || 14));
      const avail = await loadCftAvail(); const c = (avail && Array.isArray(avail.cfts)) ? avail.cfts.find((x: any) => slugify(x.name) === slug) : null;
      if (!c || c.hidden) return json({ ok: false, error: "Trainer not found." }, 404);
      let code = clean(c.code); if (!code) code = (await resolveTrainerCode(c.name)) || "";
      let photo = null; if (code) { const pr = await fetch(`${SUPA}/rest/v1/hub_avatars?code=eq.${encodeURIComponent(code)}&select=url`, { headers: DBH }); const prows = await pr.json(); if (prows && prows[0]) photo = prows[0].url; }
      const o = await availOpts(); const start = todayPT(); const end = addDaysStr(start, days);
      const br = await fetch(`${SUPA}/rest/v1/bookings?trainer_name=eq.${encodeURIComponent(c.name)}&status=in.(booked,confirmed,pending)&date=gte.${start}&date=lte.${end}&select=date,time`, { headers: DBH });
      const brows = (await br.json()) || []; const bookedBy: Record<string, string[]> = {}; brows.forEach((b: any) => { (bookedBy[b.date] = bookedBy[b.date] || []).push(b.time); });
      const out: any[] = []; for (let i = 0; i < days; i++) { const dstr = addDaysStr(start, i); const times = cftAvailTimes(c, dstr, bookedBy[dstr] || [], o); if (times.length) out.push({ date: dstr, times }); }
      return json({ ok: true, trainer: { name: c.name, photo, locked: !!c.locked }, slots: out });
    }

    if (action === "atlas_public_book") {
      const slug = slugify(body.slug); const date = clean(body.date); const time = clean(body.time); const typeKey = clean(body.type);
      const cname = clean(body.client_name); const cemail = clean(body.client_email); const cphone = clean(body.client_phone);
      const referral = clean(body.referral_source); const notes = clean(body.notes); const consent = body.consent === true || body.consent === "true"; const honeypot = clean(body.website);
      if (honeypot) return json({ ok: true, conf: confCode() });
      if (!slug || !date || !time || !typeKey || !cname || (!cemail && !cphone)) return json({ ok: false, error: "Please complete all required fields." });
      if (!consent) return json({ ok: false, error: "Please agree to be contacted to continue." });
      const ip = ((req.headers.get("x-forwarded-for") || "").split(",")[0] || "").trim() || "unknown";
      await fetch(`${SUPA}/rest/v1/booking_rate_limits`, { method: "POST", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify({ ip, email: cemail || null }) }).catch(() => {});
      const hourAgo = new Date(Date.now() - 3600000).toISOString(); const dayAgo = new Date(Date.now() - 86400000).toISOString();
      const ipc = await fetch(`${SUPA}/rest/v1/booking_rate_limits?ip=eq.${encodeURIComponent(ip)}&created_at=gte.${hourAgo}&select=id`, { headers: DBH });
      if ((((await ipc.json()) || []).length) > 5) return json({ ok: false, error: "Too many booking attempts. Please try again later." });
      if (cemail) { const ec = await fetch(`${SUPA}/rest/v1/booking_rate_limits?email=eq.${encodeURIComponent(cemail)}&created_at=gte.${dayAgo}&select=id`, { headers: DBH }); if ((((await ec.json()) || []).length) > 3) return json({ ok: false, error: "You’ve reached today’s booking limit. Please call us to book more." }); }
      const avail = await loadCftAvail(); const c = (avail && Array.isArray(avail.cfts)) ? avail.cfts.find((x: any) => slugify(x.name) === slug) : null;
      if (!c) return json({ ok: false, error: "Trainer not found." }, 404);
      let tcode = clean(c.code); if (!tcode) tcode = (await resolveTrainerCode(c.name)) || ""; if (!tcode) return json({ ok: false, error: "This trainer is not bookable right now." });
      const role = (c.role || "").toUpperCase(); const types = await loadBookingTypes(); const ty = types.find((t: any) => t.key === typeKey);
      if (!ty) return json({ ok: false, error: "Unknown appointment type." }); const duration = Number(ty.duration) > 0 ? Number(ty.duration) : DEFAULT_DUR;
      const o = await availOpts(); const dayB = await fetch(`${SUPA}/rest/v1/bookings?trainer_name=eq.${encodeURIComponent(c.name)}&date=eq.${date}&status=in.(booked,confirmed,pending)&select=time`, { headers: DBH });
      const taken = ((await dayB.json()) || []).map((x: any) => x.time);
      if (cftAvailTimes(c, date, taken, o).indexOf(time) < 0) return json({ ok: false, taken: true, error: "That time isn’t available. Please pick an open slot." });
      let clientId: any = null; if (cemail) { const cr = await fetch(`${SUPA}/rest/v1/potential_clients?email=ilike.${encodeURIComponent(cemail)}&select=id&limit=1`, { headers: DBH }); const crows = await cr.json(); if (crows && crows[0]) clientId = crows[0].id; }
      if (!clientId) { const insc = await fetch(`${SUPA}/rest/v1/potential_clients`, { method: "POST", headers: { ...DBH, Prefer: "return=representation" }, body: JSON.stringify({ name: cname, email: cemail || null, phone: cphone || null, source: "other", stage: "new_lead", service_interest: ty.name, notes: notes || null }) }); const irows = await insc.json(); if (Array.isArray(irows) && irows[0]) clientId = irows[0].id; }
      const conf = confCode(); const needsApproval = (role === "MD" || role === "EMD"); const status = needsApproval ? "pending" : "booked";
      const row = { conf, agent_code: null, agent_name: cname, trainer_name: c.name, trainer_code: tcode, trainer_calendly: clean(c.calendly), category: ty.name, date, time, duration_minutes: duration, timezone: DEFAULT_TZ, source: "public", status, notes, client_id: clientId, client_email: cemail || null, client_phone: cphone || null, meeting_medium: ty.medium || "video", referral_source: referral || null, consent_at: new Date().toISOString(), intake: { name: cname, email: cemail, phone: cphone, referral_source: referral, notes, type: ty.name } };
      const insb = await fetch(`${SUPA}/rest/v1/bookings`, { method: "POST", headers: { ...DBH, Prefer: "return=representation" }, body: JSON.stringify(row) }); const btext = await insb.text();
      if (!insb.ok) { if (btext.includes("bookings_trainer_no_overlap")) return json({ ok: false, taken: true, error: `${time} was just taken. Please pick another time.` }); return json({ ok: false, error: "Could not complete booking.", detail: btext.slice(0, 200) }); }
      let created: any = null; try { const p = JSON.parse(btext); created = Array.isArray(p) ? p[0] : p; } catch (_) { /* */ }
      const when = prettyPT(date, time); const contact = cemail || cphone || "";
      if (needsApproval) fireNotify(c.name, tcode, `Approval needed: ${ty.name}`, dot(`${cname} requested ${when}`, contact, "tap to approve", conf), cname, conf);
      else fireNotify(c.name, tcode, `New booking: ${ty.name}`, dot(cname, when, contact, conf), cname, conf);
      if (created) await queueClientMsg(created, "confirmation", `Your ${ty.name} is ${needsApproval ? "requested" : "booked"}`, `Hi ${cname}, your ${ty.name}${withWho(c.name)} is ${needsApproval ? "requested for" : "confirmed for"} ${when}.${confNote(conf)}`);
      return json({ ok: true, conf, trainer: c.name, when, status, pending: needsApproval });
    }

    if (action === "atlas_public_manage") {
      const op = lo(body.op) || "lookup"; const conf = norm(body.conf); const email = lo(body.email);
      if (!conf || !email) return json({ ok: false, error: "Enter your confirmation code and email." });
      const br = await fetch(`${SUPA}/rest/v1/bookings?conf=eq.${encodeURIComponent(conf)}&select=*`, { headers: DBH }); const bk = (await br.json())[0];
      if (!bk || lo(bk.client_email) !== email) return json({ ok: false, error: "We couldn’t find a booking with that code and email." });
      const safe = { conf: bk.conf, trainer: bk.trainer_name, type: bk.category, date: bk.date, time: bk.time, status: bk.status, when: prettyPT(bk.date, bk.time) };
      if (op === "lookup") return json({ ok: true, booking: safe });
      const active = (bk.status === "booked" || bk.status === "confirmed" || bk.status === "pending");
      if (!active) return json({ ok: false, error: `This booking is already ${bk.status}.` });
      if (op === "cancel") {
        const up = await fetch(`${SUPA}/rest/v1/bookings?id=eq.${encodeURIComponent(bk.id)}&status=in.(booked,confirmed,pending)`, { method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify({ status: "canceled" }) });
        if (!up.ok) return json({ ok: false, error: "Could not cancel. Please call us." });
        fireNotify(bk.trainer_name, bk.trainer_code, `Client canceled: ${bk.category}`, dot(bk.agent_name || "Client", prettyPT(bk.date, bk.time), conf), bk.agent_name || "Client", conf);
        return json({ ok: true, status: "canceled" });
      }
      if (op === "reschedule") {
        const date = clean(body.date); const time = clean(body.time); if (!date || !time) return json({ ok: false, error: "Pick a new date and time." });
        const avail = await loadCftAvail(); const c = (avail && Array.isArray(avail.cfts)) ? avail.cfts.find((x: any) => lo(x.name) === lo(bk.trainer_name)) : null;
        if (!c) return json({ ok: false, error: "This trainer can’t be rescheduled online. Please call us." });
        const o = await availOpts(); const dayB = await fetch(`${SUPA}/rest/v1/bookings?trainer_name=eq.${encodeURIComponent(bk.trainer_name)}&date=eq.${date}&status=in.(booked,confirmed,pending)&select=time,conf`, { headers: DBH });
        const taken = ((await dayB.json()) || []).filter((x: any) => x.conf !== conf).map((x: any) => x.time);
        if (cftAvailTimes(c, date, taken, o).indexOf(time) < 0) return json({ ok: false, taken: true, error: "That time isn’t open. Please pick another." });
        const up = await fetch(`${SUPA}/rest/v1/bookings?id=eq.${encodeURIComponent(bk.id)}&status=in.(booked,confirmed,pending)`, { method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify({ date, time }) });
        if (!up.ok) { const et = await up.text(); if (et.includes("bookings_trainer_no_overlap")) return json({ ok: false, taken: true, error: "That time was just taken. Please pick another." }); return json({ ok: false, error: "Could not reschedule. Please call us." }); }
        fireNotify(bk.trainer_name, bk.trainer_code, `Client rescheduled: ${bk.category}`, dot(`${bk.agent_name || "Client"} → ${prettyPT(date, time)} (was ${bk.time})`, conf), bk.agent_name || "Client", conf);
        return json({ ok: true, status: bk.status, when: prettyPT(date, time) });
      }
      return json({ ok: false, error: "unknown op" });
    }

    if (action === "atlas_staff_book") {
      /* v20 (2026-10-26): an Operations seat has no agent code, so it was told "Sign in required."
         It now books as OPS:<seat>, the same booker-of-record sched-ext uses. */
      let bookedBy = norm(body.code);
      if (!bookedBy && isAdmin) { const az = await _rpc("ops_authorize", { p_token: String(token ?? "") }); bookedBy = `OPS:${(az && az.code) || "?"}`; }
      if (!bookedBy) return json({ ok: false, error: "Sign in required." }, 401);
      const trainerName = clean(body.trainer_name); const slug = slugify(body.slug || trainerName); const date = clean(body.date); const time = clean(body.time); const typeKey = clean(body.type);
      const cname = clean(body.client_name); const cemail = clean(body.client_email); const cphone = clean(body.client_phone); const referral = clean(body.referral_source); const notes = clean(body.notes); const consent = body.consent === true || body.consent === "true";
      if (!slug || !date || !time || !typeKey || !cname || (!cemail && !cphone)) return json({ ok: false, error: "Missing required fields (trainer, type, date, time, client name, and email or phone)." });
      const avail = await loadCftAvail(); const c = (avail && Array.isArray(avail.cfts)) ? avail.cfts.find((x: any) => slugify(x.name) === slug || lo(x.name) === lo(trainerName)) : null;
      if (!c) return json({ ok: false, error: "Trainer not found." }, 404);
      let tcode = clean(c.code); if (!tcode) tcode = (await resolveTrainerCode(c.name)) || ""; if (!tcode) return json({ ok: false, error: "This trainer is not bookable." });
      const role = (c.role || "").toUpperCase(); const types = await loadBookingTypes(); const ty = types.find((t: any) => t.key === typeKey); if (!ty) return json({ ok: false, error: "Unknown appointment type." });
      const duration = Number(ty.duration) > 0 ? Number(ty.duration) : DEFAULT_DUR; const o = await availOpts();
      const dayB = await fetch(`${SUPA}/rest/v1/bookings?trainer_name=eq.${encodeURIComponent(c.name)}&date=eq.${date}&status=in.(booked,confirmed,pending)&select=time`, { headers: DBH }); const taken = ((await dayB.json()) || []).map((x: any) => x.time);
      if (cftAvailTimes(c, date, taken, o).indexOf(time) < 0) return json({ ok: false, taken: true, error: "That time isn’t open. Pick another slot." });
      let clientId: any = null; if (cemail) { const cr = await fetch(`${SUPA}/rest/v1/potential_clients?email=ilike.${encodeURIComponent(cemail)}&select=id&limit=1`, { headers: DBH }); const crows = await cr.json(); if (crows && crows[0]) clientId = crows[0].id; }
      if (!clientId) { const insc = await fetch(`${SUPA}/rest/v1/potential_clients`, { method: "POST", headers: { ...DBH, Prefer: "return=representation" }, body: JSON.stringify({ name: cname, email: cemail || null, phone: cphone || null, source: "other", stage: "new_lead", service_interest: ty.name, notes: notes || null }) }); const irows = await insc.json(); if (Array.isArray(irows) && irows[0]) clientId = irows[0].id; }
      const conf = confCode(); const needsApproval = (role === "MD" || role === "EMD"); const status = needsApproval ? "pending" : "booked";
      const row = { conf, agent_code: null, agent_name: cname, trainer_name: c.name, trainer_code: tcode, trainer_calendly: clean(c.calendly), category: ty.name, date, time, duration_minutes: duration, timezone: DEFAULT_TZ, source: "staff", status, notes, client_id: clientId, client_email: cemail || null, client_phone: cphone || null, meeting_medium: ty.medium || "video", referral_source: referral || null, consent_at: consent ? new Date().toISOString() : null, booked_by: bookedBy, intake: { name: cname, email: cemail, phone: cphone, referral_source: referral, notes, type: ty.name, booked_by: bookedBy } };
      const insb = await fetch(`${SUPA}/rest/v1/bookings`, { method: "POST", headers: { ...DBH, Prefer: "return=representation" }, body: JSON.stringify(row) }); const btext = await insb.text();
      if (!insb.ok) { if (btext.includes("bookings_trainer_no_overlap")) return json({ ok: false, taken: true, error: `${time} was just taken. Pick another time.` }); return json({ ok: false, error: "Could not complete booking.", detail: btext.slice(0, 200) }); }
      let created: any = null; try { const p = JSON.parse(btext); created = Array.isArray(p) ? p[0] : p; } catch (_) { /* */ }
      const when = prettyPT(date, time); const contact = cemail || cphone || "";
      if (needsApproval) fireNotify(c.name, tcode, `Approval needed: ${ty.name}`, dot(cname, when, contact, tag("booked by", bookedBy), conf), bookedBy, conf);
      else fireNotify(c.name, tcode, `New booking: ${ty.name}`, dot(cname, when, contact, tag("booked by", bookedBy), conf), bookedBy, conf);
      if (created) await queueClientMsg(created, "confirmation", `Your ${ty.name} is ${needsApproval ? "requested" : "booked"}`, `Hi ${cname}, your ${ty.name}${withWho(c.name)} is ${needsApproval ? "requested for" : "confirmed for"} ${when}.${confNote(conf)}`);
      return json({ ok: true, conf, trainer: c.name, when, status, pending: needsApproval });
    }

    if (action === "atlas_book") {
      const code = norm(body.code); const trainerName = clean(body.trainer_name); let trainerCode = clean(body.trainer_code); const date = clean(body.date); const time = clean(body.time); const category = clean(body.category);
      const duration = Number(body.duration_minutes) > 0 ? Number(body.duration_minutes) : DEFAULT_DUR; const agentName = clean(body.agent_name); const notes = clean(body.notes); const calendly = clean(body.trainer_calendly);
      if (!code || !trainerName || !date || !time) return json({ ok: false, error: "missing booking details" });
      const availB = await loadCftAvail(); if (!trainerCode) trainerCode = (await resolveTrainerCode(trainerName)) || ""; if (!trainerCode) return json({ ok: false, error: `Trainer "${trainerName}" is not registered. Add them first.` });
      const targetRole = roleOfName(trainerName, availB); const needsApproval = (targetRole === "MD" || targetRole === "EMD"); const status = needsApproval ? "pending" : "booked"; const conf = confCode();
      const row = { conf, agent_code: code, agent_name: agentName, trainer_name: trainerName, trainer_calendly: calendly, trainer_code: trainerCode, category, date, time, duration_minutes: duration, timezone: DEFAULT_TZ, source: "internal", status, notes };
      const ins = await fetch(`${SUPA}/rest/v1/bookings`, { method: "POST", headers: { ...DBH, Prefer: "return=representation" }, body: JSON.stringify(row) }); const text = await ins.text();
      if (!ins.ok) { if (text.includes("bookings_trainer_no_overlap")) return json({ ok: false, taken: true, error: `${trainerName} is already booked at ${time}. Pick another slot.` }); if (text.includes("bookings_agent_no_overlap")) return json({ ok: false, taken: true, error: `You already have a booking that overlaps ${time}. Cancel that one first.` }); if (text.includes("bookings_trainer_code_fk")) return json({ ok: false, error: `Trainer code ${trainerCode} is invalid.` }); return json({ ok: false, error: `Could not book (${ins.status}).`, detail: text.slice(0, 300) }); }
      let created: any = null; try { const parsed = JSON.parse(text); created = Array.isArray(parsed) ? parsed[0] : parsed; } catch (_) { /* */ }
      const when = prettyPT(date, time); const catStr = category || "Training"; const who = agentName || code;
      if (needsApproval) { fireNotify(trainerName, trainerCode, `Approval needed: ${catStr}`, dot(`${who} requested ${when}`, "tap to approve or decline", conf), who, conf); fireNotify(who, code, `Requested ${catStr} with ${trainerName}`, dot(`Pending ${trainerName.split(" ")[0]}'s approval`, when, conf), "System", conf); }
      else { fireNotify(trainerName, trainerCode, `${who} booked ${catStr}`, dot(when, tag("Confirmation", conf)), who, conf); fireNotify(who, code, `Training booked with ${trainerName}`, dot(catStr, when, tag("Confirmation", conf)), "System", conf); }
      return json({ ok: true, booking: created, pending: needsApproval });
    }

    if (action === "atlas_my") { const code = norm(body.code || url.searchParams.get("code")); if (!code) return json({ ok: false, error: "no code" }); const ex = await fetch(`${SUPA}/rest/v1/bookings?agent_code=eq.${encodeURIComponent(code)}&order=starts_at.asc&select=*`, { headers: DBH }); return json({ ok: true, bookings: (await ex.json()) || [] }); }

    if (action === "atlas_day") { const date = clean(body.date || url.searchParams.get("date")); if (!date) return json({ ok: false, error: "no date" }); const ex = await fetch(`${SUPA}/rest/v1/bookings?date=eq.${encodeURIComponent(date)}&status=in.(booked,confirmed,pending)&select=trainer_name,trainer_code,time,starts_at,ends_at,agent_name,agent_code,category,status`, { headers: DBH }); return json({ ok: true, bookings: (await ex.json()) || [] }); }

    if (action === "atlas_trainer") { const trainerName = clean(body.trainer_name || url.searchParams.get("trainer_name")); const trainerCode = clean(body.trainer_code || url.searchParams.get("trainer_code")); if (!trainerName && !trainerCode) return json({ ok: false, error: "no trainer" }); const filter = trainerCode ? `trainer_code=eq.${encodeURIComponent(trainerCode)}` : `trainer_name=eq.${encodeURIComponent(trainerName)}`; const ex = await fetch(`${SUPA}/rest/v1/bookings?${filter}&order=starts_at.asc&select=*`, { headers: DBH }); return json({ ok: true, bookings: (await ex.json()) || [] }); }

    if (action === "atlas_upcoming") { const ex = await fetch(`${SUPA}/rest/v1/bookings?status=in.(booked,confirmed)&order=starts_at.asc&select=trainer_name,trainer_code,starts_at,ends_at,agent_name,agent_code,category&limit=500`, { headers: DBH }); return json({ ok: true, bookings: (await ex.json()) || [] }); }

    if (action === "atlas_manage_upcoming") { const authCode = norm(body.code || url.searchParams.get("code")); const avail = await loadCftAvail(); const callerRole = (isAdmin) ? "OPS" : await roleOfCode(authCode, avail); if (!isAdmin && callerRole !== "EMD") return json({ ok: false, error: "Only an EMD or Ops can view the transfer queue." }, 401); const ex = await fetch(`${SUPA}/rest/v1/bookings?status=in.(booked,confirmed)&order=starts_at.asc&select=id,conf,agent_name,agent_code,trainer_name,trainer_code,category,date,time,status,starts_at&limit=500`, { headers: DBH }); return json({ ok: true, bookings: (await ex.json()) || [] }); }

    if (action === "atlas_setstatus") {
      const id = clean(body.id); const st = clean(body.status); const code = norm(body.code);
      const valid = ["booked", "confirmed", "completed", "canceled", "no_show"];
      if (!id || valid.indexOf(st) < 0) return json({ ok: false, error: "bad id/status" });
      const br0 = await fetch(`${SUPA}/rest/v1/bookings?id=eq.${encodeURIComponent(id)}&select=id,conf,agent_name,agent_code,client_email,client_phone,trainer_name,trainer_code,category,date,time`, { headers: DBH });
      const bk = (await br0.json())[0]; if (!bk) return json({ ok: false, error: "booking not found" });
      let allowed = (isAdmin) || (!!code && (norm(bk.agent_code) === code || norm(bk.trainer_code) === code));
      if (!allowed && code) { const avail = await loadCftAvail(); if ((await roleOfCode(code, avail)) === "EMD") allowed = true; }
      if (!allowed) return json({ ok: false, error: "unauthorized" }, 401);
      const patch: Record<string, unknown> = { status: st }; if (typeof body.notes === "string") patch.notes = clean(body.notes);
      const up = await fetch(`${SUPA}/rest/v1/bookings?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify(patch) });
      if (up.ok) {
        const when = prettyPT(bk.date, bk.time); const catStr = bk.category || "Appointment"; const who = bk.agent_name || bk.agent_code || "Client";
        if (st === "canceled") {
          if (bk.trainer_name) fireNotify(bk.trainer_name, bk.trainer_code, `Canceled: ${catStr}`, dot(who, when, bk.conf), who, bk.conf || id);
          if (bk.agent_code) fireNotify(who, clean(bk.agent_code), `Your ${catStr} was canceled`, dot(`${when}${withWho(bk.trainer_name)}`, bk.conf), "System", bk.conf || id);
          if (bk.client_email || bk.client_phone) await queueClientMsg(bk, "cancellation", `Your ${catStr} was canceled`, `Your ${catStr}${withWho(bk.trainer_name)} on ${when} has been canceled. Book again anytime.`);
        } else if (st === "no_show") {
          if ((bk.client_email || bk.client_phone) && !(await alreadyQueued(bk.id, "no_show_followup"))) await queueClientMsg(bk, "no_show_followup", "We missed you — let’s reschedule", `Hi ${bk.agent_name || "there"}, we missed you for your ${catStr} (${when}). We’d love to get you rebooked — just reply or book again anytime.`);
        }
      }
      return json({ ok: up.ok, id, status: st });
    }

    if (action === "atlas_approve") {
      const id = clean(body.id); const decision = lo(body.decision); const authCode = norm(body.code);
      if (!id || (decision !== "approve" && decision !== "decline")) return json({ ok: false, error: "bad id/decision" });
      const bres = await fetch(`${SUPA}/rest/v1/bookings?id=eq.${encodeURIComponent(id)}&select=*`, { headers: DBH }); const bk = (await bres.json())[0];
      if (!bk) return json({ ok: false, error: "booking not found" }); if (bk.status !== "pending") return json({ ok: false, error: `This booking is ${bk.status}, not pending.` });
      const authorized = (isAdmin) || (!!authCode && authCode === norm(bk.trainer_code)); if (!authorized) return json({ ok: false, error: "Only the booked trainer or Ops can approve." }, 401);
      const newStatus = decision === "approve" ? "confirmed" : "declined";
      const up = await fetch(`${SUPA}/rest/v1/bookings?id=eq.${encodeURIComponent(id)}&status=eq.pending`, { method: "PATCH", headers: { ...DBH, Prefer: "return=representation" }, body: JSON.stringify({ status: newStatus }) }); const uptext = await up.text();
      if (!up.ok) { if (uptext.includes("bookings_trainer_no_overlap")) return json({ ok: false, taken: true, error: `You already have a confirmed booking at ${bk.time}. Decline or move it first.` }); return json({ ok: false, error: `Could not update (${up.status}).`, detail: uptext.slice(0, 200) }); }
      let updated: any = null; try { const p = JSON.parse(uptext); updated = Array.isArray(p) ? p[0] : p; } catch (_) { /* */ } if (!updated) return json({ ok: false, error: "Booking was no longer pending." });
      const when = prettyPT(bk.date, bk.time); const catStr = bk.category || "Training"; const agent = bk.agent_name || bk.agent_code || "agent";
      if (decision === "approve") { fireNotify(agent, clean(bk.agent_code) || null, `Approved: ${catStr}${withWho(bk.trainer_name)}`, dot(when, tag("Confirmation", bk.conf)), bk.trainer_name, bk.conf || id); if (bk.client_email || bk.client_phone) await queueClientMsg(bk, "confirmation", `Confirmed: ${catStr}`, `Good news — your ${catStr}${withWho(bk.trainer_name)} is confirmed for ${when}.${confNote(bk.conf)}`); }
      else fireNotify(agent, clean(bk.agent_code) || null, `Declined: ${catStr}${withWho(bk.trainer_name)}`, `${when} — please choose another time or trainer.`, bk.trainer_name, bk.conf || id);
      return json({ ok: true, id, status: newStatus });
    }

    if (action === "atlas_transfer") {
      const id = clean(body.id); const authCode = norm(body.code); const reason = clean(body.reason); let toName = clean(body.to_trainer_name); let toCode = clean(body.to_trainer_code);
      if (!id) return json({ ok: false, error: "booking id required" }); if (!toName && !toCode) return json({ ok: false, error: "target trainer required" });
      const avail = await loadCftAvail(); const callerRole = (isAdmin) ? "OPS" : await roleOfCode(authCode, avail);
      const bres = await fetch(`${SUPA}/rest/v1/bookings?id=eq.${encodeURIComponent(id)}&select=*`, { headers: DBH }); const bk = (await bres.json())[0];
      if (!bk) return json({ ok: false, error: "booking not found" }); if (bk.status !== "booked" && bk.status !== "confirmed") return json({ ok: false, error: `Only active bookings can be transferred (this one is ${bk.status}).` });
      let toCalendly = ""; if (avail && Array.isArray(avail.cfts)) { const tc = avail.cfts.find((c: any) => { if (toCode && clean(c.code).toUpperCase() === toCode.toUpperCase()) return true; if (toName && lo(c.name) === lo(toName)) return true; return false; }); if (tc) { if (!toName) toName = tc.name; if (!toCode) toCode = clean(tc.code); toCalendly = clean(tc.calendly); } }
      if (!toCode) toCode = (await resolveTrainerCode(toName)) || ""; if (!toCode) return json({ ok: false, error: `Target trainer "${toName}" is not registered.` }); if (toCode.toUpperCase() === norm(bk.trainer_code)) return json({ ok: false, error: "Already assigned to that trainer." });
      const targetRole = roleOfName(toName, avail); const fromRole = roleOfName(bk.trainer_name, avail); const isManager = (callerRole === "OPS" || callerRole === "EMD"); const isPeerCft = (callerRole === "CFT" && !!authCode && authCode === norm(bk.trainer_code) && fromRole === "CFT" && targetRole === "CFT");
      if (!isManager && !isPeerCft) return json({ ok: false, error: "You can only transfer your own CFT session to another CFT. Cross-role transfers are EMD/Ops only." }, 401);
      const fromCode = clean(bk.trainer_code); const fromName = clean(bk.trainer_name); const patch = { trainer_name: toName, trainer_code: toCode, trainer_calendly: toCalendly };
      const up = await fetch(`${SUPA}/rest/v1/bookings?id=eq.${encodeURIComponent(id)}&status=in.(booked,confirmed)`, { method: "PATCH", headers: { ...DBH, Prefer: "return=representation" }, body: JSON.stringify(patch) }); const uptext = await up.text();
      if (!up.ok) { if (uptext.includes("bookings_trainer_no_overlap")) return json({ ok: false, taken: true, error: `${toName} is already booked at ${bk.time}. Pick another trainer.` }); if (uptext.includes("bookings_trainer_code_fk")) return json({ ok: false, error: `Trainer code ${toCode} is invalid.` }); return json({ ok: false, error: `Transfer failed (${up.status}).`, detail: uptext.slice(0, 300) }); }
      let moved: any = null; try { const p = JSON.parse(uptext); moved = Array.isArray(p) ? p[0] : p; } catch (_) { /* */ } if (!moved) return json({ ok: false, error: "Booking was not in a transferable state." });
      await fetch(`${SUPA}/rest/v1/booking_transfers`, { method: "POST", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify({ booking_id: id, from_trainer_code: fromCode || null, to_trainer_code: toCode, transferred_by: (isAdmin) ? "ops" : (authCode || null), reason: reason || null }) }).catch(() => {});
      const when = prettyPT(bk.date, bk.time); const catStr = bk.category || "Training"; const agentWho = bk.agent_name || bk.agent_code || "an agent"; const actor = (isAdmin) ? "Ops" : (authCode || "System");
      fireNotify(toName, toCode, `Transferred to you: ${catStr}`, dot(agentWho, when, tag("Conf", bk.conf)), actor, bk.conf || id);
      if (fromName) fireNotify(fromName, fromCode || null, `Booking transferred to ${toName}`, dot(`${catStr} with ${agentWho}`, when, reason), actor, bk.conf || id);
      fireNotify(agentWho, clean(bk.agent_code) || null, `Your ${catStr} was reassigned`, dot(`Now with ${toName} — same time, ${when}`, tag("Conf", bk.conf)), actor, bk.conf || id);
      if (bk.client_email || bk.client_phone) await queueClientMsg({ id, conf: bk.conf, agent_name: bk.agent_name, client_email: bk.client_email, client_phone: bk.client_phone }, "reassigned", `Your ${catStr} — new trainer`, `Your ${catStr} is now with ${toName}, same time (${when}).${confNote(bk.conf)}`);
      return json({ ok: true, booking: moved, from: fromName, to: toName });
    }

    if (action === "atlas_transfer_history") { const id = clean(body.id || url.searchParams.get("id")); const q = id ? `${SUPA}/rest/v1/booking_transfers?booking_id=eq.${encodeURIComponent(id)}&select=*&order=created_at.desc` : `${SUPA}/rest/v1/booking_transfers?select=*&order=created_at.desc&limit=200`; const ex = await fetch(q, { headers: DBH }); return json({ ok: true, transfers: (await ex.json()) || [] }); }

    if (action === "atlas_lock") {
      const trainerName = clean(body.trainer_name); const trainerCode = clean(body.trainer_code); const at = clean(body.action_type); const authCode = norm(body.code);
      if (!trainerName && !trainerCode) return json({ ok: false, error: "trainer required" }); const avail = await loadCftAvail(); if (!avail || !Array.isArray(avail.cfts)) return json({ ok: false, error: "cft_availability missing" });
      const idx = avail.cfts.findIndex((c: any) => { if (trainerCode && clean(c.code).toUpperCase() === trainerCode.toUpperCase()) return true; if (trainerName && lo(c.name) === lo(trainerName)) return true; return false; }); if (idx < 0) return json({ ok: false, error: "trainer not in cft_availability" });
      const t = avail.cfts[idx]; const role = (t.role || "").toUpperCase(); if (role !== "MD" && role !== "EMD") return json({ ok: false, error: "Only MDs and EMDs can lock calendars. CFTs should use blackouts." });
      let ownerCode = clean(t.code).toUpperCase(); if (!ownerCode) ownerCode = ((await resolveTrainerCode(t.name)) || "").toUpperCase(); const authorized = (isAdmin) || (ownerCode && authCode === ownerCode); if (!authorized) return json({ ok: false, error: "unauthorized" }, 401);
      if (at === "toggle") t.locked = !t.locked; else if (at === "add_lockout") { const s = clean(body.start), e = clean(body.end); if (!s || !e) return json({ ok: false, error: "start and end required" }); t.lockouts = Array.isArray(t.lockouts) ? t.lockouts : []; t.lockouts.push({ start: s, end: e }); } else if (at === "remove_lockout") { const s = clean(body.start), e = clean(body.end); t.lockouts = (Array.isArray(t.lockouts) ? t.lockouts : []).filter((x: any) => !(x && x.start === s && x.end === e)); } else return json({ ok: false, error: "bad action_type" });
      avail.cfts[idx] = t; const up = await saveCftAvail(avail); return json({ ok: up.ok, trainer: t.name, locked: !!t.locked, lockouts: t.lockouts || [] });
    }

    if (action === "atlas_avail_update") {
      const trainerName = clean(body.trainer_name); const trainerCode = clean(body.trainer_code); const authCode = norm(body.code);
      if (!trainerName && !trainerCode) return json({ ok: false, error: "trainer required" }); const avail = await loadCftAvail(); if (!avail || !Array.isArray(avail.cfts)) return json({ ok: false, error: "cft_availability missing" });
      const idx = avail.cfts.findIndex((c: any) => { if (trainerCode && clean(c.code).toUpperCase() === trainerCode.toUpperCase()) return true; if (trainerName && lo(c.name) === lo(trainerName)) return true; return false; }); if (idx < 0) return json({ ok: false, error: "trainer not in cft_availability" });
      const t = avail.cfts[idx]; let ownerCode = clean(t.code).toUpperCase(); if (!ownerCode) ownerCode = ((await resolveTrainerCode(t.name)) || "").toUpperCase(); const authorized = (isAdmin) || (ownerCode && authCode === ownerCode); if (!authorized) return json({ ok: false, error: "unauthorized" }, 401);
      if (Array.isArray(body.blackouts)) t.blackouts = body.blackouts; if (Array.isArray(body.vacations)) t.vacations = body.vacations; if (body.buffer_before !== undefined) t.buffer_before = Math.max(0, Number(body.buffer_before) || 0); if (body.buffer_after !== undefined) t.buffer_after = Math.max(0, Number(body.buffer_after) || 0); if (body.slots && typeof body.slots === "object") t.slots = body.slots;
      avail.cfts[idx] = t; const up = await saveCftAvail(avail); return json({ ok: up.ok, trainer: t.name, cft: { name: t.name, code: t.code || ownerCode || null, role: t.role, slots: t.slots || {}, blackouts: t.blackouts || [], vacations: t.vacations || [], buffer_before: t.buffer_before || 0, buffer_after: t.buffer_after || 0, locked: !!t.locked, lockouts: t.lockouts || [] } });
    }

    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) { return json({ ok: false, error: String(e) }, 500); }
});
