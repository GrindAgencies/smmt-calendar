// calendly-sync v15 (2026-10-22) — per-agent Calendly PAT + analytics + public-link routing +
// WEBHOOK auto-register.
//
// v15: THE PER-PERSON ACTIONS TRUSTED A TYPED CODE. `code` came straight off the request and was
// used both as "which Operations seat is this" AND as "which agent am I", and the second meaning
// is not something a request may assert. Agent codes are printed on the org chart, so:
//
//   save_token     attached a Calendly account to ANY agent's code — and it also PATCHes that
//                  agent's cal_link, so their public booking link would point at the attacker's
//                  calendar. The most serious of these.
//   disconnect     deleted anyone's Calendly connection, silently stopping their sync.
//   status         returned whether they are connected, their Calendly name and email, their
//                  scheduling URL and event count. (It never returned the token itself.)
//   webhook_status confirmed whether they have a webhook. Measured live before the fix.
//   sync/list/
//   analytics/alerts  acted as that person.
//
// `code` is deliberately LEFT ALONE, because ops_scope() legitimately resolves it as a SEAT code
// for the Operations paths. What is new is meCode: the signed-in agent, proven by the session
// minted at PIN entry. Every per-person action uses meCode now. Operations keeps naming an agent,
// which is what support needs.
//
// DELIBERATELY STILL OPEN: public_link and exact_slot. book.html is the PUBLIC booking page, used
// by clients who have no account; public_link resolves a name slug to a Calendly scheduling URL
// that is public by definition, and exact_slot returns open times. Gating either would break
// booking for the people it exists to serve.
//
// No client change: profile.html, calendar.html and ops.html all load session.js. book.html does
// too, and sends no session — which is correct, and the two actions it needs stay open.
// v5: exact_slot — exact-slot deep link, prefilled with invitee name/email/guests.
// v6: exact_slot no longer force-picks an arbitrary event type when the category doesn't match.
// v7 (2026-09-03): admin check goes through ops_authorize instead of the literal "2026".
// v8 (2026-09-05): baseshop scoping for the Operations bookings tab.
// v9 (2026-09-05): an Operations SEAT reads like an admin, scoped to its own baseshops. v8 decided
//     "is this an admin read?" from the token alone, so once the pages stopped sending the shared
//     literal a seat with no session yet fell through to agent=<its own code> and the Bookings tab
//     came back empty. ops_scope() reports whether the caller is a real seat, and that fallback is
//     itself gated on the legacy flag — so switching the flag off closes this door in the same move.
// v12 (2026-09-22): THE CATEGORY MATCHER. Christopher: "change it to match for everyone."
//     A Scheduler category almost never equals a trainer's event-type name word for word —
//     "Hiring Interview" is "Hiring / Partnership Interview" to Cassandra, "Hiring + Partnership
//     Interview" to Courtney, "GFI: expansion Interview" to Seale, "Expansion Meeting" to Gage.
//     Each category now carries the patterns that MEAN it, STRONGEST FIRST: matching on the weak
//     word alone sent Seale's hiring interviews to his "Future Financial Skillbridge Interview".
//     The old generic keyword fallback is gone — it quietly returned a FIELD TRAINING event
//     type's availability for a hiring interview, which is worse than no answer, because an
//     unmatched category simply falls back to the trainer's in-app availability.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CAL = "https://api.calendly.com";
const WEBHOOK_URL = "https://bmfqxtocxkjhsgfnndlo.supabase.co/functions/v1/calendly-webhook";
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
function json(o: unknown, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const low = (s: unknown) => (s ?? "").toString().trim().toLowerCase();
const clean = (s: unknown) => (s ?? "").toString().trim();
const enc = (s: string) => encodeURIComponent(s);
const slugify = (s: unknown) => (s ?? "").toString().trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
async function db(path: string, init?: RequestInit) { return fetch(`${SUPA}/rest/v1/${path}`, { ...init, headers: { ...DBH, ...(init?.headers || {}) } }); }
async function dbGet(path: string) { const r = await db(path); return (await r.json()) || []; }
async function rpc(fn: string, args: Record<string, unknown>) { const r = await db(`rpc/${fn}`, { method: "POST", body: JSON.stringify(args) }); return r.ok ? await r.json() : null; }
async function opsAuthorized(token: unknown) { const r = await rpc("ops_authorize", { p_token: String(token ?? "") }); return !!(r && r.ok); }
/* Proof of identity. A typed code let anyone attach THEIR Calendly to somebody else's account,
   read that person's connection, or delete it. */
async function sessionCode(session: unknown): Promise<string> {
  const v = String(session ?? "").trim().slice(0, 120);
  if (!v) return "";
  const got = await rpc("agent_session_code", { p_token: v });
  return (typeof got === "string") ? norm(got) : "";
}
function calHdr(token: string) { return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }; }
async function calMe(token: string) { const r = await fetch(`${CAL}/users/me`, { headers: calHdr(token) }); if (!r.ok) return null; const j = await r.json(); return j.resource || null; }
async function agentRow(code: string) { const rows = await dbGet(`tracker_agents?code=eq.${enc(norm(code))}&select=first_name,last_name`); return rows[0] || null; }
async function fullName(code: string) { const a = await agentRow(code); return a ? `${a.first_name || ""} ${a.last_name || ""}`.trim() : ""; }
async function loadKey(k: string) { const rows = await dbGet(`app_settings?key=eq.${k}&select=value`); return rows[0] ? rows[0].value : null; }
async function saveKey(k: string, v: unknown) { await db(`app_settings?on_conflict=key`, { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key: k, value: v, updated_at: new Date().toISOString() }) }); }
async function mirrorToCft(name: string, url: string) { if (!name || !url) return; const av = await loadKey("cft_availability"); if (!av || !Array.isArray(av.cfts)) return; let ch = false; av.cfts = av.cfts.map((c: any) => { if (c && c.name && c.name.trim().toLowerCase() === name.trim().toLowerCase()) { c.calendly = url; ch = true; } return c; }); if (ch) await saveKey("cft_availability", av); }

// What each Scheduler category MEANS, in the words trainers actually use on their own calendars.
// `cat` recognises the category being asked for; `yes` is ordered STRONGEST SIGNAL FIRST, so a
// trainer who has both "GFI: expansion Interview" and "Future Financial Skillbridge Interview"
// gets the expansion one rather than whichever merely contains the word "interview".
// `no` guards a trap — "(Licensed Agents Only)" lives inside Field Training names, so Licensing
// Help must not be lured onto a field-training calendar by the word "licensed".
const CAT_RULES: { cat: RegExp; yes: RegExp[]; no?: RegExp }[] = [
  { cat: /field\s*train/i,          yes: [/field\s*train/i, /ride[-\s]?along/i] },
  { cat: /hiring|interview/i,       yes: [/hiring/i, /partnership/i, /expansion/i, /meet\s*(and|&|\+)\s*greet/i, /recruit/i, /interview/i] },
  { cat: /coach|1[-\s]?on[-\s]?1/i, yes: [/coach/i, /1[-\s]?on[-\s]?1|one[-\s]?on[-\s]?one/i, /agent\s*to\s*agent/i, /mentor/i, /strategy\s*call/i] },
  { cat: /licens/i,                 yes: [/licensing/i], no: /licensed\s*agents|agents\s*only|field\s*train/i },
  { cat: /phone\s*zone/i,           yes: [/phone/i, /dial/i] }
];
// Best event type for a category: the trainer's own wording, then what the category means, then
// shared significant words. Returns null rather than guessing — an unmatched category falls back
// to the trainer's in-app availability, which is right, where a wrong calendar is not.
function pickEventType(ets: any[], publicEts: any[], want: string) {
  if (!want) return null;
  const exact = ets.find((e: any) => String(e.name || "").toLowerCase().includes(want));
  if (exact) return exact;
  const rule = CAT_RULES.find((r) => r.cat.test(want));
  if (rule) {
    const allowed = publicEts.filter((e: any) => !(rule.no && rule.no.test(String(e.name || ""))));
    for (const pat of rule.yes) {
      const hit = allowed.find((e: any) => pat.test(String(e.name || "")));
      if (hit) return hit;
    }
  }
  const words = want.split(/[^a-z0-9]+/).filter((w: string) => w.length > 3);
  if (words.length) {
    let best: any = null, bestScore = 0;
    for (const e of publicEts) {
      const n = String(e.name || "").toLowerCase();
      const sc = words.filter((w: string) => n.indexOf(w) >= 0).length;
      if (sc > bestScore) { bestScore = sc; best = e; }
    }
    if (best) return best;
  }
  return null;
}

// Baseshop reach for the caller. `seat` means a real Operations seat (session, or seat code
// while the legacy flag still allows it); `scoped` narrows them to `allow`.
async function scopeOf(token: unknown, code: unknown) {
  const sc = await rpc("ops_scope", { p_token: String(token || ""), p_code: String(code || "") });
  const scoped = !!(sc && sc.scoped);
  const seat = !!(sc && sc.seat);
  const allow = new Set<string>(((sc && Array.isArray(sc.bases)) ? sc.bases : []).map((b: string) => low(b)));
  return { scoped, seat, allow };
}
async function baseByCode(): Promise<Record<string, string>> {
  const rows = await dbGet(`tracker_agents?select=code,baseshop&limit=5000`);
  const m: Record<string, string> = {}; rows.forEach((a: any) => { m[norm(a.code)] = low(a.baseshop); });
  return m;
}
async function registerWebhook(token: string, uri: string, org: string, code: string) {
  const key = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, "");
  try {
    const wr = await fetch(`${CAL}/webhook_subscriptions`, { method: "POST", headers: calHdr(token), body: JSON.stringify({ url: WEBHOOK_URL, events: ["invitee.created", "invitee.canceled"], organization: org, scope: "user", user: uri, signing_key: key }) });
    if (wr.ok) { const wj = await wr.json(); const wuri = wj.resource ? wj.resource.uri : ""; await db(`calendly_connections?code=eq.${enc(norm(code))}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ webhook_uri: wuri, webhook_key: key }) }); return { ok: true, uri: wuri }; }
    const t = await wr.text();
    if (wr.status === 409) { await db(`calendly_connections?code=eq.${enc(norm(code))}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ webhook_key: key }) }); return { ok: true, existing: true }; }
    return { ok: false, status: wr.status, detail: t.slice(0, 200) };
  } catch (e) { return { ok: false, error: String(e) }; }
}

async function syncOne(code: string): Promise<{ ok: boolean; count?: number; error?: string }> {
  const rows = await dbGet(`calendly_connections?code=eq.${enc(norm(code))}&select=token,uri`);
  const conn = rows[0]; if (!conn || !conn.token) return { ok: false, error: "not connected" };
  let uri = conn.uri; if (!uri) { const me = await calMe(conn.token); uri = me ? me.uri : null; }
  if (!uri) return { ok: false, error: "invalid token" };
  const agentName = await fullName(code);
  const since = new Date(Date.now() - 90 * 86400000).toISOString();
  const r = await fetch(`${CAL}/scheduled_events?user=${enc(uri)}&count=100&sort=start_time:desc&min_start_time=${enc(since)}`, { headers: calHdr(conn.token) });
  if (!r.ok) return { ok: false, error: `calendly ${r.status}` };
  const j = await r.json(); const events = Array.isArray(j.collection) ? j.collection : [];
  const out: Record<string, unknown>[] = [];
  for (const ev of events) {
    let invName = "", invEmail = "";
    try { const total = ev.invitees_counter ? ev.invitees_counter.total : 0; if (total > 0) { const ir = await fetch(`${ev.uri}/invitees?count=1`, { headers: calHdr(conn.token) }); if (ir.ok) { const inv = ((await ir.json()).collection || [])[0]; if (inv) { invName = inv.name || ""; invEmail = inv.email || ""; } } } } catch (_) { /* noop */ }
    const loc = ev.location || {};
    out.push({ event_uri: ev.uri, event_uuid: String(ev.uri || "").split("/").pop(), agent_code: norm(code), agent_name: agentName, name: ev.name || "", event_type_name: ev.name || "", status: ev.status || "", start_time: ev.start_time || null, end_time: ev.end_time || null, location_kind: loc.type || null, join_url: loc.join_url || loc.location || null, invitee_name: invName, invitee_email: invEmail, synced_at: new Date().toISOString() });
  }
  if (out.length) await db(`calendly_events?on_conflict=event_uri`, { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(out) });
  await db(`calendly_connections?code=eq.${enc(norm(code))}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ synced_at: new Date().toISOString(), updated_at: new Date().toISOString() }) });
  return { ok: true, count: out.length };
}

async function codeOfName(name: string): Promise<string> {
  const n = clean(name).toLowerCase(); if (!n) return "";
  const rows = await dbGet(`tracker_agents?select=code,first_name,last_name&limit=5000`);
  const m = rows.find((a: any) => `${a.first_name || ""} ${a.last_name || ""}`.trim().toLowerCase() === n);
  return m ? norm(m.code) : "";
}
const ptTime = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(iso)).replace(/\s+/g, "").toUpperCase();
const ptDate = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(iso));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: any = {}; try { body = await req.json(); } catch (_) { body = {}; }
  const action = String(body.action || "");
  /* `code` is left exactly as it was because it serves TWO purposes here: for Operations paths
     it is the Ops SEAT code handed to scopeOf(), and ops_scope resolves it. What it must never
     be again is proof of which AGENT you are — see meCode. */
  const code = norm(body.code);
  const isAdmin = await opsAuthorized(body.token);
  /* The signed-in agent, proven. Every per-person action below uses this instead of `code`. */
  const meCode = isAdmin ? code : await sessionCode(body.session);

  if (action === "exact_slot") {
    let tcode = norm(body.trainer_code); if (!tcode) tcode = await codeOfName(clean(body.trainer_name));
    if (!tcode) return json({ ok: false, error: "trainer not found" });
    const conn = (await dbGet(`calendly_connections?code=eq.${enc(tcode)}&select=token,uri,scheduling_url`))[0];
    if (!conn || !conn.token) return json({ ok: false, connected: false });
    let uri = conn.uri; if (!uri) { const me = await calMe(conn.token); uri = me ? me.uri : null; }
    if (!uri) return json({ ok: false, error: "invalid token" });
    const date = clean(body.date); const wantT = clean(body.time).replace(/\s+/g, "").toUpperCase();
    if (!date || !wantT) return json({ ok: false, error: "missing date/time" });
    const etr = await fetch(`${CAL}/event_types?user=${enc(uri)}&count=100&active=true`, { headers: calHdr(conn.token) });
    if (!etr.ok) return json({ ok: false, error: `event_types ${etr.status}` });
    const ets = ((await etr.json()).collection) || [];
    if (!ets.length) return json({ ok: false, error: "no active event types" });
    const mainUrl = clean(conn.scheduling_url);
    const publicEts = ets.filter((e: any) => e.active !== false && !e.secret);
    const want = clean(body.event_type_name).toLowerCase();
    const et = pickEventType(ets, publicEts, want);
    if (!et) {
      const choices = publicEts.map((e: any) => ({ name: e.name || "", scheduling_url: e.scheduling_url || "", duration: e.duration || null }));
      const su = mainUrl || (choices[0] ? choices[0].scheduling_url : "") || "";
      return json({ ok: false, no_match: true, scheduling_url: su, event_types: choices });
    }
    const nowIso = new Date(Date.now() + 120000).toISOString();
    let start = `${date}T00:00:00.000Z`; if (start < nowIso) start = nowIso;
    const end = new Date(new Date(`${date}T00:00:00.000Z`).getTime() + 34 * 3600000).toISOString();
    const atr = await fetch(`${CAL}/event_type_available_times?event_type=${enc(et.uri)}&start_time=${enc(start)}&end_time=${enc(end)}`, { headers: calHdr(conn.token) });
    if (!atr.ok) { const t = await atr.text(); return json({ ok: false, error: `available_times ${atr.status}`, detail: t.slice(0, 160), event_type: et.name }); }
    const slots = ((await atr.json()).collection) || [];
    const match = slots.find((s: any) => s.status === "available" && ptDate(s.start_time) === date && ptTime(s.start_time) === wantT);
    if (!match || !match.scheduling_url) return json({ ok: false, no_slot: true, event_type: et.name, scheduling_url: mainUrl || "", available: slots.filter((s: any) => ptDate(s.start_time) === date).map((s: any) => ptTime(s.start_time)) });
    let u = String(match.scheduling_url); const p: string[] = [];
    if (clean(body.name)) p.push("name=" + enc(clean(body.name)));
    if (clean(body.email)) p.push("email=" + enc(clean(body.email)));
    if (clean(body.guests)) p.push("guests=" + enc(clean(body.guests)));
    if (p.length) u += (u.indexOf("?") >= 0 ? "&" : "?") + p.join("&");
    return json({ ok: true, scheduling_url: u, event_type: et.name, start_time: match.start_time });
  }

  if (action === "public_link") {
    const slug = slugify(body.slug); if (!slug) return json({ ok: false });
    const rows = await dbGet(`tracker_agents?cal_link=neq.&select=first_name,last_name,cal_link&limit=3000`);
    for (const a of rows) { const nm = `${a.first_name || ""} ${a.last_name || ""}`.trim(); if (slugify(nm) === slug && a.cal_link) return json({ ok: true, scheduling_url: a.cal_link, name: nm }); }
    return json({ ok: false });
  }

  if (action === "save_token") {
    /* WAS: a typed code. Anyone could attach their own Calendly to another agent's account,
       which rewrote that agent's public cal_link to point at the attacker's calendar. */
    const code = meCode;
    if (!code) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401);
    const token = clean(body.token); if (!token) return json({ ok: false, error: "Paste your Calendly API token." });
    const me = await calMe(token);
    if (!me || !me.uri) return json({ ok: false, error: "That token didn’t validate. Copy the Personal Access Token from Calendly → Integrations → API & webhooks." });
    await db(`calendly_connections?on_conflict=code`, { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ code, token, uri: me.uri, scheduling_url: me.scheduling_url || "", cal_name: me.name || "", cal_email: me.email || "", organization: me.current_organization || "", updated_at: new Date().toISOString() }) });
    if (me.scheduling_url) { await db(`tracker_agents?code=eq.${enc(code)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ cal_link: me.scheduling_url }) }); await mirrorToCft(await fullName(code), me.scheduling_url); }
    const w = await registerWebhook(token, me.uri, me.current_organization || "", code);
    const s = await syncOne(code);
    return json({ ok: true, scheduling_url: me.scheduling_url || "", cal_name: me.name || "", cal_email: me.email || "", synced: s.count || 0, webhook: w.ok, webhook_error: w.ok ? undefined : (w.detail || w.error || ("HTTP " + w.status)) });
  }

  if (action === "status") {
    const code = meCode;
    if (!code) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401);
    const rows = await dbGet(`calendly_connections?code=eq.${enc(code)}&select=scheduling_url,cal_name,cal_email,synced_at,token,webhook_uri`);
    const c = rows[0]; if (!c) return json({ ok: true, connected: false });
    const cnt = await db(`calendly_events?agent_code=eq.${enc(code)}&select=event_uri`, { headers: { Prefer: "count=exact", Range: "0-0" } });
    const cr = cnt.headers.get("content-range") || ""; const totalEvents = cr.includes("/") ? parseInt(cr.split("/")[1], 10) || 0 : 0;
    return json({ ok: true, connected: true, has_token: !!c.token, webhook: !!c.webhook_uri, scheduling_url: c.scheduling_url || "", cal_name: c.cal_name || "", cal_email: c.cal_email || "", synced_at: c.synced_at, events: totalEvents });
  }

  if (action === "webhook_status") { const code = meCode; if (!code) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401); const rows = await dbGet(`calendly_connections?code=eq.${enc(code)}&select=webhook_uri`); return json({ ok: true, webhook: !!(rows[0] && rows[0].webhook_uri) }); }
  if (action === "register_webhooks") {
    if (!isAdmin) return json({ ok: false, error: "unauthorized" }, 401);
    const conns = await dbGet(`calendly_connections?token=not.is.null&select=code,token,uri,organization,webhook_uri`);
    let ok = 0; const details: any[] = [];
    for (const c of conns) { if (c.webhook_uri) { details.push({ code: c.code, already: true }); continue; } const w = await registerWebhook(c.token, c.uri, c.organization || "", c.code); if (w.ok) ok++; details.push({ code: c.code, ...w }); }
    return json({ ok: true, connections: conns.length, registered: ok, details });
  }

  /* WAS: a typed code deleted anyone's Calendly connection, silently stopping their sync. */
  if (action === "disconnect") { const code = meCode; if (!code) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401); await db(`calendly_connections?code=eq.${enc(code)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } }); return json({ ok: true }); }
  if (action === "sync") { const code = meCode; if (!code) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401); return json(await syncOne(code)); }
  if (action === "sync_all") {
    if (!isAdmin) return json({ ok: false, error: "unauthorized" }, 401);
    const conns = await dbGet(`calendly_connections?token=not.is.null&select=code`);
    let ok = 0, total = 0; const details: any[] = [];
    for (const c of conns) { const s = await syncOne(c.code); if (s.ok) { ok++; total += (s.count || 0); } details.push({ code: c.code, ...s }); }
    return json({ ok: true, connections: conns.length, synced_ok: ok, events: total, details });
  }

  if (action === "analytics") {
    const { scoped, seat } = await scopeOf(body.token, body.code);
    if (!isAdmin && !seat && !meCode) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401);
    // A baseshop seat does not get company-wide analytics. The page recomputes them
    // from the bookings it is allowed to see, which are scoped below.
    if (scoped) return json({ ok: true, scope: "baseshop", scoped: true, analytics: {} });
    const agent = (isAdmin || seat) ? null : (meCode || null);
    const a = await rpc("calendly_analytics", { p_agent: agent });
    return json({ ok: true, scope: agent || "company", analytics: a || {} });
  }
  if (action === "bookings" || action === "list_all" || action === "list") {
    const { scoped, seat, allow } = await scopeOf(body.token, body.code);
    const adminRead = isAdmin || seat;
    if (action === "list_all") { if (!adminRead) return json({ ok: false, error: "unauthorized" }, 401); }
    else if (!meCode && !adminRead) { return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401); }
    const agent = (action === "list") ? meCode : (adminRead ? (clean(body.agent) ? norm(body.agent) : null) : (meCode || null));
    let rows = await rpc("calendly_bookings", { p_agent: agent, p_status: clean(body.status) || null, p_type: clean(body.type) || null, p_upcoming: (body.upcoming === true ? true : (body.upcoming === false ? false : null)), p_search: clean(body.search) || null, p_limit: Number(body.limit) || 300 });
    if (scoped) {
      const base = await baseByCode();
      rows = (rows || []).filter((r: any) => allow.has(base[norm(r.agent_code)] || ""));
    }
    return json({ ok: true, scoped, events: rows || [] });
  }
  if (action === "alerts") {
    const { scoped, seat, allow } = await scopeOf(body.token, body.code);
    const adminRead = isAdmin || seat;
    if (!adminRead && !meCode) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401);
    const agent = adminRead ? null : (meCode || null);
    const q = agent ? `calendly_alerts?agent_code=eq.${enc(agent)}&order=created_at.desc&limit=50` : `calendly_alerts?order=created_at.desc&limit=50`;
    let alerts = await dbGet(q);
    if (scoped) { const base = await baseByCode(); alerts = (alerts || []).filter((a: any) => allow.has(base[norm(a.agent_code)] || "")); }
    return json({ ok: true, alerts });
  }

  return json({ ok: false, error: "unknown action" }, 400);
});
