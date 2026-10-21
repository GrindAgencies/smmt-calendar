// tracker-api v40 (2026-09-30) — A TYPED CODE OR A TYPED NAME IS NO LONGER IDENTITY.
//
// v37 routed every Operations check through ops_authorize, so the literal "2026" stopped being a
// master key. What it did NOT do is ask who an ordinary caller was. Four separate ways in:
//
//   · action:"load" returned select=* for ANY code — the whole record, including that person's
//     entire warm_market (client names, phones, emails, ages, notes).
//   · action:"save" / "savewarm" / "setpath" / "daily" / "claimlead" WROTE to any code. savewarm
//     replaces the lead array outright, so one request could erase a colleague's book.
//   · action:"team" was gated on a typed leader NAME — and every page sends the same hardcoded
//     "Elijah Cox", so any caller at all was served the roster of the whole organisation with
//     each member's leads attached.
//   · action:"setorg" was gated on a typed `by` name being in the seniors list. Type a senior's
//     name — they are all on the org chart — and you could rewrite the entire org structure.
//
// Identity now comes from the session token minted when somebody enters their PIN
// (agent_session_code), or from Operations (ops_authorize). Writes always go to the SESSION's
// code; a `code` in the body is a request, not a claim.
//
// DELIBERATELY still open, because they carry no personal data and unknown internal jobs may
// call them: cftavail, orgtree, seniors, pulse (config, roles, and aggregate counts with first
// names only — all of it already visible on the org chart). And `load` without a session still
// answers, but only with existence + name + approval state, because the sign-in screen has to
// look an account up BEFORE there is a session to look it up with.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DEFAULT_TOTAL = 40;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
function json(o: unknown, status = 200) { return new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } }); }
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const clean = (s: unknown) => (s ?? "").toString().trim().slice(0, 200);
const low = (s: unknown) => (s ?? "").toString().trim().toLowerCase();
function ptToday(): string { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date()); }
function addDays(ymd: string, n: number): string { const [y,m,d] = ymd.split("-").map(Number); const dt = new Date(Date.UTC(y, m-1, d)); dt.setUTCDate(dt.getUTCDate()+n); return dt.toISOString().slice(0,10); }
function daysAgo(ymd: string, today: string): number { if (!ymd) return 0; try { const a = new Date(ymd+"T00:00:00Z").getTime(); const b = new Date(today+"T00:00:00Z").getTime(); if (isNaN(a)||isNaN(b)) return 0; return Math.round((b-a)/86400000); } catch { return 0; } }
async function rpc(fn: string, args: Record<string, unknown>) { try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); return await r.json(); } catch (_) { return null; } }
async function opsAuthorized(token: unknown) { const t = String(token ?? ""); if (!t) return false; const r = await rpc("ops_authorize", { p_token: t }); return !!(r && r.ok); }

async function getAgent(code: string) {
  const ex = await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${encodeURIComponent(code)}&select=*`, { headers: DBH });
  const rows = await ex.json();
  return rows && rows[0] ? rows[0] : null;
}

/* ===== WHO IS CALLING =====
   `ops` — Operations or a machine job, proven by a token ops_authorize() accepts.
   `code`/`name` — a signed-in member, proven by the session minted at PIN entry.
   Neither — an anonymous caller, who gets only the sign-in lookup. */
type Caller = { code: string; name: string; ops: boolean };
async function whoIsCalling(body: Record<string, unknown>, q: URLSearchParams): Promise<Caller> {
  const t = clean(body.token || q.get("token")).slice(0, 120);
  if (t && await opsAuthorized(t)) return { code: "", name: "Operations", ops: true };
  const s = clean(body.session || q.get("session")).slice(0, 120);
  if (s) {
    const c = await rpc("agent_session_code", { p_token: s });
    if (typeof c === "string" && c) {
      let name = "";
      try {
        const ex = await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${encodeURIComponent(norm(c))}&select=first_name,last_name&limit=1`, { headers: DBH });
        const a = ((await ex.json()) || [])[0];
        if (a) name = (((a.first_name as string) || "") + " " + ((a.last_name as string) || "")).trim();
      } catch (_) { /* noop */ }
      return { code: norm(c), name, ops: false };
    }
  }
  return { code: "", name: "", ops: false };
}
function needSession() { return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401); }

function enrichAgent(r: Record<string, unknown>, today: string) {
  const ft = (r.ft_log && typeof r.ft_log === "object") ? r.ft_log as Record<string,string> : {};
  const dates = Object.values(ft).filter(Boolean).sort();
  const ftDone = dates.length;
  const ft30 = dates.filter((d) => { const da = daysAgo(d, today); return da >= 0 && da <= 30; }).length;
  let ftSpanDays = 0, ftPace = 0;
  if (dates.length >= 2) { const a0 = new Date(dates[0]+"T00:00:00Z").getTime(); const a1 = new Date(dates[dates.length-1]+"T00:00:00Z").getTime(); ftSpanDays = Math.max(1, Math.round((a1-a0)/86400000)); ftPace = Math.round((ftDone / ftSpanDays) * 7 * 10) / 10; }
  const prog = (r.progress && typeof r.progress === "object") ? r.progress as Record<string, unknown> : {};
  const bizDone = Object.keys(prog).filter((k) => k.indexOf("biz") === 0 && prog[k]).length;
  const wmArr = Array.isArray(r.warm_market) ? r.warm_market as Record<string, unknown>[] : [];
  const wm = wmArr.length;
  const wmWins = wmArr.filter((x) => x && x.outcome === "win").length;
  const wmLosses = wmArr.filter((x) => x && x.outcome === "lose").length;
  const wmPooled = wmArr.filter((x) => x && x.pooled).length;
  const wmDecided = wmWins + wmLosses;
  const wmRate = wmDecided ? Math.round((wmWins * 100) / wmDecided) : null;
  const mpAdded = (n: number) => wmArr.filter((x) => { if (!x) return false; const d = daysAgo(clean((x as Record<string, unknown>).date), today); return d >= 0 && d <= n; }).length;
  const mpContacted = wmArr.filter((x) => x && x.contacted).length;
  const contacted7 = wmArr.filter((x) => { if (!x || !(x as Record<string, unknown>).contactedDate) return false; const da = daysAgo(clean((x as Record<string, unknown>).contactedDate), today); return da >= 0 && da <= 7; }).length;
  let mpLastAdd = ""; for (const x of wmArr) { const d = clean(x && (x as Record<string, unknown>).date); if (d && (!mpLastAdd || d > mpLastAdd)) mpLastAdd = d; }
  const mpLastAddDays = mpLastAdd ? daysAgo(mpLastAdd, today) : null;
  const alog = Array.isArray(r.activity_log) ? r.activity_log as Record<string, unknown>[] : [];
  let dials7 = 0, convos7 = 0, appts7 = 0;
  const ymds: string[] = [];
  const laRaw = clean(r.last_activity || r.updated_at || r.created_at).slice(0, 10);
  if (laRaw) ymds.push(laRaw);
  if (clean(r.last_daily)) ymds.push(clean(r.last_daily));
  for (const dstr of dates) if (dstr) ymds.push(dstr);
  for (const x of wmArr) { const dd = clean(x && (x as Record<string, unknown>).date); if (dd) ymds.push(dd); }
  for (const ev of alog) { if (!ev) continue; const dd = clean((ev as Record<string, unknown>).date); if (dd) ymds.push(dd); const da = daysAgo(dd, today); if (dd && da >= 0 && da <= 7) { dials7 += Number((ev as Record<string, unknown>).dials) || 0; convos7 += Number((ev as Record<string, unknown>).convos) || 0; appts7 += Number((ev as Record<string, unknown>).appts) || 0; } }
  let lastActive = ""; for (const y of ymds) { if (y && (!lastActive || y > lastActive)) lastActive = y; }
  const daysInactive = lastActive ? daysAgo(lastActive, today) : null;
  const progressStatus = (daysInactive === null || daysInactive > 30) ? "red" : (daysInactive > 14 ? "orange" : (daysInactive > 7 ? "yellow" : "green"));
  const live = (r.last_daily === today || r.last_daily === addDays(today,-1)) ? (Number(r.streak)||0) : 0;
  const e: Record<string, unknown> = { ...r, pct: Math.min(100, Number(r.pct) || 0), status: r.status || "active", ft_done: ftDone, ft_30: ft30, ft_span_days: ftSpanDays, ft_pace_per_wk: ftPace, biz_submitted: bizDone, warm_leads: wm, wm_wins: wmWins, wm_losses: wmLosses, wm_pooled: wmPooled, wm_close_rate: wmRate, mp_added_7: mpAdded(7), mp_added_14: mpAdded(14), mp_added_30: mpAdded(30), mp_contacted: mpContacted, contacted_7: contacted7, mp_last_add: mpLastAdd, mp_last_add_days: mpLastAddDays, act_dials_7: dials7, act_convos_7: convos7, act_appts_7: appts7, last_active: lastActive, days_inactive: daysInactive, progress_status: progressStatus, live_streak: live };
  delete e.progress; delete e.warm_market; delete e.activity_log;
  return e;
}

async function loadInScope(code: string, leader: string) {
  const L = low(leader);
  const a = await getAgent(norm(code));
  if (!a) return { err: json({ ok: false, error: "agent not found" }, 404) };
  const inScope = !!L && (low(a.md) === L || low(a.emd) === L);
  if (!inScope) return { err: json({ ok: false, error: "That agent is not on your team." }, 403) };
  return { agent: a };
}

async function orgSeniors(): Promise<string[]> {
  try {
    const ex = await fetch(`${SUPA}/rest/v1/app_settings?key=eq.org_structure&select=value`, { headers: DBH });
    const rws = await ex.json();
    const val = rws && rws[0] ? rws[0].value : null;
    if (val && Array.isArray(val.nodes)) return (val.nodes as Record<string, unknown>[]).filter((n) => n && n.role === "senior").map((n) => low(n.name));
  } catch (_) { /* noop */ }
  return [];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = new URL(req.url);
    let body: Record<string, unknown> = {};
    if (req.method === "POST") body = await req.json().catch(() => ({}));
    const action = (body.action as string) || url.searchParams.get("action") || "";

    // ONE identity resolution for the whole request. `isAdmin` keeps its old meaning so every
    // Operations-gated branch below is untouched.
    const me = await whoIsCalling(body, url.searchParams);
    const isAdmin = me.ops;
    // Where a write lands: the session's own code, always. Operations may name a target.
    const myCode = me.ops ? norm(body.code || url.searchParams.get("code")) : me.code;

    if (action === "cftavail") {
      const ex = await fetch(`${SUPA}/rest/v1/app_settings?key=eq.cft_availability&select=value,updated_at`, { headers: DBH });
      const rows = await ex.json();
      const row = rows && rows[0] ? rows[0] : null;
      return json({ ok: true, value: row ? row.value : null, updated_at: row ? row.updated_at : null });
    }

    if (action === "setcftavail") {
      if (!isAdmin) return json({ ok: false, error: "unauthorized" }, 401);
      const value = body.value;
      if (!value || typeof value !== "object") return json({ ok: false, error: "missing value" });
      const up = await fetch(`${SUPA}/rest/v1/app_settings?on_conflict=key`, { method: "POST", headers: { ...DBH, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key: "cft_availability", value, updated_at: new Date().toISOString() }) });
      return json({ ok: up.ok });
    }

    if (action === "orgtree") {
      const ex = await fetch(`${SUPA}/rest/v1/app_settings?key=eq.org_structure&select=value,updated_at`, { headers: DBH });
      const rows = await ex.json();
      const row = rows && rows[0] ? rows[0] : null;
      return json({ ok: true, value: row ? row.value : null, updated_at: row ? row.updated_at : null });
    }

    if (action === "setorg") {
      // WAS: any caller who typed a senior's name in `by`. Senior names are on the org chart, so
      // that was a public write to the entire company structure. Now: Operations, or a SIGNED-IN
      // person who is themselves a senior — proven by session, not by what they typed.
      let allowed = isAdmin;
      if (!allowed && me.code && me.name) {
        const seniors = await orgSeniors();
        if (seniors.indexOf(low(me.name)) >= 0) allowed = true;
      }
      if (!allowed) return json({ ok: false, error: "unauthorized" }, 401);
      const value = body.value;
      if (!value || typeof value !== "object") return json({ ok: false, error: "missing value" });
      const up = await fetch(`${SUPA}/rest/v1/app_settings?on_conflict=key`, { method: "POST", headers: { ...DBH, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key: "org_structure", value, updated_at: new Date().toISOString() }) });
      return json({ ok: up.ok, by: me.ops ? "Operations" : me.name });
    }

    if (action === "seniors") {
      const seniors = await orgSeniors();
      return json({ ok: true, seniors });
    }

    if (action === "register") {
      // No page has called this since 2026-09-13 — both sign-in screens were changed to LOAD,
      // because register CREATES a roster row for any unused code. Creating people is the Join
      // form's job (profile-api signup), which asks for a recruiter and checks for duplicates.
      // Left reachable for Operations only, so nothing internal breaks.
      if (!isAdmin) return json({ ok: false, error: "Accounts are created from the Join form." }, 403);
      const code = norm(body.code), first = clean(body.first), last = clean(body.last);
      if (!code || !first || !last) return json({ ok: false, error: "Please enter your first name, last name, and GFI code." });
      const a = await getAgent(code);
      if (a) return json({ ok: true, returning: true, agent: a });
      const ins = await fetch(`${SUPA}/rest/v1/tracker_agents`, { method: "POST", headers: { ...DBH, Prefer: "return=representation" },
        body: JSON.stringify({ code, first_name: first, last_name: last, progress: {}, done_count: 0, total: DEFAULT_TOTAL, pct: 0, last_activity: new Date().toISOString() }) });
      const r = await ins.json();
      if (!ins.ok) return json({ ok: false, error: "Could not register", detail: r });
      return json({ ok: true, returning: false, agent: Array.isArray(r) ? r[0] : r });
    }

    if (action === "load") {
      // Two very different answers, because this endpoint has two very different jobs.
      //
      // The sign-in screen must look an account up BEFORE anyone has a session — it needs to know
      // "does this code exist, whose is it, is it approved". That much is on the org chart anyway,
      // so an anonymous caller still gets it.
      //
      // The FULL record is a different thing entirely: progress, field-training log, carrier
      // codes, and warm_market — that person's whole client list with names, phones, emails and
      // notes. v37 handed all of it to anyone who typed a code. Now it needs the session that
      // belongs to that code (or Operations).
      const code = norm(body.code || url.searchParams.get("code"));
      if (!code) return json({ ok: false, error: "No code" });
      const a = await getAgent(code);
      if (!a) return json({ ok: false, notfound: true });
      const mine = me.ops || (!!me.code && me.code === code);
      if (mine) return json({ ok: true, agent: a, today: ptToday() });
      return json({
        ok: true, lookup_only: true, today: ptToday(),
        agent: {
          code: a.code, first_name: a.first_name, last_name: a.last_name,
          status: a.status || "active", access_status: a.access_status || "approved",
          baseshop: a.baseshop || "", md: a.md || "", emd: a.emd || ""
        }
      });
    }

    if (action === "poolleads") {
      // The Phone Zone pool is shared between brokers by design, but the rows are still real
      // people's names and phone numbers — so you have to be signed in to see them.
      if (!isAdmin && !me.code) return needSession();
      const a = await getAgent("POOL");
      const wm = a && Array.isArray(a.warm_market) ? a.warm_market as Record<string, unknown>[] : [];
      const leads = wm.filter((c) => c).map((c) => ({
        id: c.id || "", name: c.name || "", phone: c.phone || "", email: c.email || "",
        timeZone: c.timeZone || "", age: c.age || "", married: !!c.married, children: !!c.children,
        howKnow: c.howKnow || "", apptDate: c.apptDate || "", traits: c.traits || "",
        notes: c.notes || "", contacted: !!c.contacted, date: c.date || "",
        autoReleased: !!c.autoReleased, originAgentName: c.originAgentName || ""
      }));
      return json({ ok: true, count: leads.length, leads });
    }

    if (action === "claimlead") {
      if (!isAdmin && !me.code) return needSession();
      const code = myCode;
      const leadId = clean(body.leadId);
      if (!code || !leadId) return json({ ok: false, error: "Missing your code or the lead id." });
      const agent = await getAgent(code);
      if (!agent) return json({ ok: false, error: "We couldn't find your agent record. Please sign in again." });
      if ((agent.status || "active") === "quit") return json({ ok: false, error: "This account is inactive." });
      const pool = await getAgent("POOL");
      const pwm: Record<string, unknown>[] = pool && Array.isArray(pool.warm_market) ? pool.warm_market.slice() : [];
      const idx = pwm.findIndex((x) => x && x.id === leadId);
      if (idx < 0) return json({ ok: false, taken: true, error: "That lead was just taken by another agent." });
      const lead = pwm[idx] as Record<string, unknown>;
      pwm.splice(idx, 1);
      const awm: Record<string, unknown>[] = Array.isArray(agent.warm_market) ? agent.warm_market.slice() : [];
      const prevNotes = clean(lead.notes);
      const claimed = {
        id: "wm" + Date.now() + Math.floor(Math.random()*1e6),
        name: lead.name || "", phone: lead.phone || "", email: lead.email || "",
        directTo: "", agentId: "", timeZone: lead.timeZone || "", age: lead.age || "",
        married: !!lead.married, children: !!lead.children, howKnow: lead.howKnow || "",
        apptDate: lead.apptDate || "", traits: lead.traits || "",
        notes: ((prevNotes ? (prevNotes + " ") : "") + "[Claimed from Phone Zone " + ptToday() + "]").slice(0, 200),
        contacted: true, contactedDate: ptToday(), status: "called", outcome: "", date: ptToday(), done: false
      };
      awm.unshift(claimed);
      await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.POOL`, { method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify({ warm_market: pwm, updated_at: new Date().toISOString() }) });
      const up = await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${encodeURIComponent(code)}`, { method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify({ warm_market: awm, updated_at: new Date().toISOString(), last_activity: new Date().toISOString() }) });
      return json({ ok: up.ok, lead: claimed, pool_remaining: pwm.length });
    }

    if (action === "sweepstale") {
      if (!isAdmin) return json({ ok: false, error: "unauthorized" }, 401);
      const days = Number(body.days) > 0 ? Number(body.days) : 21;
      const today = ptToday();
      const ex = await fetch(`${SUPA}/rest/v1/tracker_agents?select=code,first_name,last_name,status,warm_market`, { headers: DBH });
      const rows = await ex.json();
      const pool = (rows || []).find((r: Record<string, unknown>) => r.code === "POOL");
      let pwm: Record<string, unknown>[] = pool && Array.isArray(pool.warm_market) ? pool.warm_market.slice() : [];
      const autoByOrigin = new Map<string, boolean>();
      pwm.forEach((c) => { if (c && c.originLeadId) autoByOrigin.set(c.originLeadId as string, true); });
      const validOrigins = new Set<string>();
      let swept = 0;
      const updates: { code: string; warm_market: Record<string, unknown>[] }[] = [];
      for (const r of (rows || [])) {
        if (!r || r.code === "POOL" || (r.status || "active") === "quit") continue;
        const wm: Record<string, unknown>[] = Array.isArray(r.warm_market) ? r.warm_market : [];
        const agentName = (((r.first_name as string) || "") + " " + ((r.last_name as string) || "")).trim();
        let dirty = false;
        for (const c of wm) {
          if (!c) continue;
          const id = c.id as string;
          const qualifies = !!id && !c.imported && !c.locked && !c.seniorOnly && !c.contacted && !c.done && !c.outcome && !clean(c.apptDate) && (!!clean(c.name) || !!clean(c.phone)) && daysAgo(clean(c.date), today) >= days;
          if (qualifies) {
            validOrigins.add(id);
            if (!c.pooled) {
              c.pooled = true; c.pooledDate = today; dirty = true;
              if (!autoByOrigin.has(id)) {
                const copy = {
                  id: "wm" + Date.now() + Math.floor(Math.random()*1e6),
                  name: c.name || "", phone: c.phone || "", email: c.email || "",
                  directTo: "", agentId: "", timeZone: c.timeZone || "", age: c.age || "",
                  married: !!c.married, children: !!c.children, howKnow: c.howKnow || "",
                  apptDate: "", traits: c.traits || "",
                  notes: ("[Uncalled " + days + "+ days — released from " + (agentName || (r.code as string)) + "'s list] " + clean(c.notes)).slice(0, 200),
                  contacted: false, outcome: "", date: today, done: false,
                  originAgent: r.code, originAgentName: agentName, originLeadId: id, autoReleased: true
                };
                pwm.push(copy); autoByOrigin.set(id, true); swept++;
              }
            }
          } else if (c.pooled) {
            c.pooled = false; delete c.pooledDate; dirty = true;
          }
        }
        if (dirty) updates.push({ code: r.code as string, warm_market: wm });
      }
      const before = pwm.length;
      pwm = pwm.filter((c) => !c ? false : (!c.originLeadId ? true : validOrigins.has(c.originLeadId as string)));
      const recalled = before - pwm.length;
      for (const u of updates) {
        await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${encodeURIComponent(u.code)}`, { method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify({ warm_market: u.warm_market, updated_at: new Date().toISOString() }) });
      }
      await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.POOL`, { method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify({ warm_market: pwm, updated_at: new Date().toISOString() }) });
      return json({ ok: true, days, swept, recalled, agents_touched: updates.length, pool_total: pwm.length });
    }

    if (action === "save") {
      if (!isAdmin && !me.code) return needSession();
      const code = myCode;
      if (!code) return json({ ok: false, error: "No code" });
      const progress = (body.progress as Record<string, unknown>) || {};
      const done = Object.keys(progress).filter((k) => progress[k]).length;
      const total = Number(body.total) > 0 ? Number(body.total) : DEFAULT_TOTAL;
      const pct = total ? Math.min(100, Math.round((done * 100) / total)) : 0;
      const nowIso = new Date().toISOString();
      const patch: Record<string, unknown> = { progress, done_count: done, total, pct, updated_at: nowIso, last_activity: nowIso };
      if (typeof body.pathway === "string" && body.pathway) patch.pathway = body.pathway;
      if (typeof body.emd === "string") patch.emd = clean(body.emd);
      if (typeof body.md === "string") patch.md = clean(body.md);
      if (body.ft_log && typeof body.ft_log === "object") patch.ft_log = body.ft_log;
      if (body.carrier_codes && typeof body.carrier_codes === "object") patch.carrier_codes = body.carrier_codes;
      if (Array.isArray(body.activity_log)) patch.activity_log = body.activity_log;
      if (body.promo && typeof body.promo === "object") patch.promo = body.promo;
      if (Array.isArray(body.warm_market)) {
        const td = ptToday();
        patch.warm_market = (body.warm_market as Record<string, unknown>[]).map((c) => (c && c.contacted && !c.contactedDate) ? { ...c, contactedDate: td } : c);
      }
      const up = await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${encodeURIComponent(code)}`, { method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify(patch) });
      return json({ ok: up.ok, done, total, pct });
    }

    if (action === "savewarm") {
      // This one REPLACES the lead array. Sent with somebody else's code it wiped their book.
      if (!isAdmin && !me.code) return needSession();
      const code = myCode;
      if (!code) return json({ ok: false, error: "No code" });
      if (!Array.isArray(body.warm_market)) return json({ ok: false, error: "warm_market must be an array" });
      const td = ptToday();
      const wm = (body.warm_market as Record<string, unknown>[]).map((c) => (c && c.contacted && !c.contactedDate) ? { ...c, contactedDate: td } : c);
      const up = await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${encodeURIComponent(code)}`, { method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify({ warm_market: wm, updated_at: new Date().toISOString(), last_activity: new Date().toISOString() }) });
      return json({ ok: up.ok, count: wm.length });
    }

    if (action === "setpath") {
      if (!isAdmin && !me.code) return needSession();
      const code = myCode; const pathway = clean(body.pathway);
      if (!code || !pathway) return json({ ok: false, error: "missing" });
      const up = await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${encodeURIComponent(code)}`, { method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify({ pathway, updated_at: new Date().toISOString() }) });
      return json({ ok: up.ok, pathway });
    }

    if (action === "setupline") {
      if (!isAdmin) return json({ ok: false, error: "unauthorized" }, 401);
      const code = norm(body.code);
      if (!code) return json({ ok: false, error: "no code" });
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (typeof body.emd === "string") patch.emd = clean(body.emd);
      if (typeof body.md === "string") patch.md = clean(body.md);
      const up = await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${encodeURIComponent(code)}`, { method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify(patch) });
      return json({ ok: up.ok, code, emd: patch.emd, md: patch.md });
    }

    if (action === "importleads") {
      if (!isAdmin) return json({ ok: false, error: "unauthorized" }, 401);
      const code = norm(body.code);
      const leads = Array.isArray(body.leads) ? body.leads as Record<string, unknown>[] : [];
      if (!code) return json({ ok: false, error: "no code" });
      let a = await getAgent(code);
      if (!a) {
        const first = clean(body.first) || code;
        const last = clean(body.last) || "";
        const st = clean(body.status) === "quit" ? "quit" : "active";
        await fetch(`${SUPA}/rest/v1/tracker_agents`, { method: "POST", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify({ code, first_name: first, last_name: last, progress: {}, done_count: 0, total: DEFAULT_TOTAL, pct: 0, status: st, warm_market: [] }) });
        a = await getAgent(code);
      }
      const wm: Record<string, unknown>[] = Array.isArray(a.warm_market) ? a.warm_market.slice() : [];
      const keyOf = (x: Record<string, unknown>) => ((x.name as string || "").trim().toLowerCase() + "|" + (x.phone as string || "").replace(/\D/g, ""));
      const existing = new Set(wm.map(keyOf));
      let added = 0; let i = 0;
      for (const l of leads) {
        const nm = clean(l.name); const ph = clean(l.phone);
        if (!nm && !ph) continue;
        const k = keyOf({ name: nm, phone: ph });
        if (existing.has(k)) continue;
        existing.add(k);
        wm.push({ id: "wm" + Date.now() + Math.floor(Math.random()*1e6) + (i++), name: nm, phone: ph, email: clean(l.email), directTo: clean(l.directTo), agentId: clean(l.agentId), timeZone: clean(l.timeZone), age: clean(l.age), married: !!l.married, children: !!l.children, howKnow: clean(l.howKnow), apptDate: clean(l.apptDate), traits: clean(l.traits), notes: clean(l.notes), contacted: !!l.contacted, status: (l.contacted ? "called" : "fresh"), outcome: "", date: clean(l.date) || ptToday(), done: false, imported: true });
        added++;
      }
      const up = await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${encodeURIComponent(code)}`, { method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify({ warm_market: wm, updated_at: new Date().toISOString() }) });
      return json({ ok: up.ok, code, added, total: wm.length });
    }

    if (action === "daily") {
      if (!isAdmin && !me.code) return needSession();
      const code = myCode;
      if (!code) return json({ ok: false, error: "No code" });
      const a = await getAgent(code);
      if (!a) return json({ ok: false, notfound: true });
      const today = ptToday();
      let log: string[] = Array.isArray(a.daily_log) ? a.daily_log.slice() : [];
      const already = log.includes(today);
      if (!already) log.push(today);
      const set = new Set(log);
      let streak = 0; let d = today;
      while (set.has(d)) { streak++; d = addDays(d, -1); }
      const best = Math.max(Number(a.best_streak) || 0, streak);
      await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${encodeURIComponent(code)}`, { method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify({ daily_log: log, streak, best_streak: best, last_daily: today, updated_at: new Date().toISOString(), last_activity: new Date().toISOString() }) });
      const milestones = [7, 14, 30, 60, 90, 180];
      return json({ ok: true, already, streak, best, today, milestone: (!already && milestones.includes(streak)) ? streak : 0 });
    }

    if (action === "setstatus") {
      if (!isAdmin) return json({ ok: false, error: "unauthorized" }, 401);
      const code = norm(body.code);
      const status = (clean(body.status) === "quit") ? "quit" : "active";
      if (!code) return json({ ok: false, error: "no code" });
      const up = await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${encodeURIComponent(code)}`, { method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify({ status, updated_at: new Date().toISOString() }) });
      return json({ ok: up.ok, code, status });
    }

    if (action === "setcontacted") {
      if (!isAdmin) return json({ ok: false, error: "unauthorized" }, 401);
      const code = norm(body.code);
      const leadId = clean(body.leadId);
      if (!code || !leadId) return json({ ok: false, error: "missing code or leadId" });
      const a = await getAgent(code);
      if (!a) return json({ ok: false, error: "agent not found" });
      const wm: Record<string, unknown>[] = Array.isArray(a.warm_market) ? a.warm_market.slice() : [];
      const idx = wm.findIndex((x) => x && x.id === leadId);
      if (idx < 0) return json({ ok: false, error: "lead not found" });
      const cur = wm[idx] as Record<string, unknown>;
      const want = (typeof body.contacted === "boolean") ? body.contacted : !cur.contacted;
      const upd: Record<string, unknown> = { ...cur, contacted: want };
      if (want && !upd.contactedDate) upd.contactedDate = ptToday();
      wm[idx] = upd;
      const up = await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${encodeURIComponent(code)}`, { method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify({ warm_market: wm, updated_at: new Date().toISOString() }) });
      return json({ ok: up.ok, code, leadId, contacted: want, contactedDate: upd.contactedDate || "" });
    }

    if (action === "setleadstatus") {
      if (!isAdmin) return json({ ok: false, error: "unauthorized" }, 401);
      const code = norm(body.code);
      const leadId = clean(body.leadId);
      const raw = clean(body.status).toLowerCase();
      const st = raw === "nurture" ? "called" : raw;
      const valid = ["fresh", "called", "scheduled", "followup", "won", "lost"];
      if (!code || !leadId || valid.indexOf(st) < 0) return json({ ok: false, error: "missing code/leadId or bad status" });
      const a = await getAgent(code);
      if (!a) return json({ ok: false, error: "agent not found" });
      const wm: Record<string, unknown>[] = Array.isArray(a.warm_market) ? a.warm_market.slice() : [];
      const idx = wm.findIndex((x) => x && x.id === leadId);
      if (idx < 0) return json({ ok: false, error: "lead not found" });
      const upd: Record<string, unknown> = { ...(wm[idx] as Record<string, unknown>) };
      upd.status = st;
      if (st === "fresh") { upd.contacted = false; upd.outcome = ""; }
      else if (st === "won") { upd.contacted = true; upd.outcome = "win"; if (!upd.contactedDate) upd.contactedDate = ptToday(); }
      else if (st === "lost") { upd.contacted = true; upd.outcome = "lose"; if (!upd.contactedDate) upd.contactedDate = ptToday(); }
      else { upd.contacted = true; upd.outcome = ""; if (!upd.contactedDate) upd.contactedDate = ptToday(); }
      wm[idx] = upd;
      const up = await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${encodeURIComponent(code)}`, { method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify({ warm_market: wm, updated_at: new Date().toISOString() }) });
      return json({ ok: up.ok, code, leadId, status: st, contacted: upd.contacted, outcome: upd.outcome });
    }

    if (action === "setlocked") {
      if (!isAdmin) return json({ ok: false, error: "unauthorized" }, 401);
      const code = norm(body.code);
      const leadId = clean(body.leadId);
      if (!code || !leadId) return json({ ok: false, error: "missing code or leadId" });
      const a = await getAgent(code);
      if (!a) return json({ ok: false, error: "agent not found" });
      const wm: Record<string, unknown>[] = Array.isArray(a.warm_market) ? a.warm_market.slice() : [];
      const idx = wm.findIndex((x) => x && x.id === leadId);
      if (idx < 0) return json({ ok: false, error: "lead not found" });
      const cur = wm[idx] as Record<string, unknown>;
      const want = (typeof body.locked === "boolean") ? body.locked : !cur.locked;
      const upd: Record<string, unknown> = { ...cur, locked: want };
      if (want && upd.pooled) { upd.pooled = false; delete upd.pooledDate; }
      wm[idx] = upd;
      const up = await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${encodeURIComponent(code)}`, { method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify({ warm_market: wm, updated_at: new Date().toISOString() }) });
      return json({ ok: up.ok, code, leadId, locked: want });
    }

    if (action === "setsenioronly") {
      if (!isAdmin) return json({ ok: false, error: "unauthorized" }, 401);
      const code = norm(body.code);
      const leadId = clean(body.leadId);
      if (!code || !leadId) return json({ ok: false, error: "missing code or leadId" });
      const a = await getAgent(code);
      if (!a) return json({ ok: false, error: "agent not found" });
      const wm: Record<string, unknown>[] = Array.isArray(a.warm_market) ? a.warm_market.slice() : [];
      const idx = wm.findIndex((x) => x && x.id === leadId);
      if (idx < 0) return json({ ok: false, error: "lead not found" });
      const cur = wm[idx] as Record<string, unknown>;
      const want = (typeof body.seniorOnly === "boolean") ? body.seniorOnly : !cur.seniorOnly;
      const upd: Record<string, unknown> = { ...cur, seniorOnly: want };
      if (want && upd.pooled) { upd.pooled = false; delete upd.pooledDate; }
      wm[idx] = upd;
      const up = await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${encodeURIComponent(code)}`, { method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify({ warm_market: wm, updated_at: new Date().toISOString() }) });
      return json({ ok: up.ok, code, leadId, seniorOnly: want });
    }

    if (action === "delete") {
      if (!isAdmin) return json({ ok: false, error: "unauthorized" }, 401);
      const code = norm(body.code);
      if (!code) return json({ ok: false, error: "no code" });
      const del = await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${encodeURIComponent(code)}`, { method: "DELETE", headers: { ...DBH, Prefer: "return=minimal" } });
      return json({ ok: del.ok, code, deleted: del.ok });
    }

    if (action === "leaders") {
      if (!isAdmin && !me.code) return needSession();
      const ex = await fetch(`${SUPA}/rest/v1/tracker_agents?select=emd,md,status&code=neq.POOL`, { headers: DBH });
      const rows = (await ex.json()) || [];
      const names = new Set<string>();
      for (const r of rows) { if (!r || (r.status || "active") === "quit") continue; const m = clean(r.md), e = clean(r.emd); if (m) names.add(m); if (e) names.add(e); }
      const leaders: Record<string, unknown>[] = [];
      for (const name of names) {
        const L = name.toLowerCase();
        let asSenior = 0, asExec = 0, team = 0;
        for (const r of rows) { if (!r || (r.status || "active") === "quit") continue; const m = low(r.md) === L, e = low(r.emd) === L; if (m) asSenior++; if (e) asExec++; if (m || e) team++; }
        leaders.push({ name, team, senior: asSenior, exec: asExec, role: (asExec > asSenior && asExec > 0) ? "Exec Broker" : "Senior Broker" });
      }
      leaders.sort((a, b) => (Number(b.team) || 0) - (Number(a.team) || 0));
      return json({ ok: true, leaders });
    }

    if (action === "team") {
      // The pages that call this (Home's team snapshot, Team Hub's member directory) want NAMES
      // and metrics. v37 also attached every member's `leads` — their whole client list — and
      // gated the lot on a typed leader name that is hardcoded to the same person on every page.
      // So one request from anyone returned the entire organisation's client data.
      //
      // Now: you must be signed in, and `leads` is attached only for Operations or for the leader
      // whose team this actually is. Everyone else gets the roster and the numbers, which is all
      // any screen ever read.
      if (!isAdmin && !me.code) return needSession();
      const leader = clean(body.leader || url.searchParams.get("leader"));
      if (!leader) return json({ ok: false, error: "pick a leader" });
      const L = leader.toLowerCase();
      const maySeeLeads = isAdmin || (!!me.name && low(me.name) === L);
      const ex = await fetch(`${SUPA}/rest/v1/tracker_agents?select=code,first_name,last_name,emd,md,pathway,status,progress,done_count,total,pct,streak,best_streak,last_daily,ft_log,warm_market,activity_log,last_activity,created_at,updated_at&code=neq.POOL`, { headers: DBH });
      const rows = (await ex.json()) || [];
      const today = ptToday();
      const mine = rows.filter((r: Record<string, unknown>) => r && (r.status || "active") !== "quit" && (low(r.md) === L || low(r.emd) === L));
      const cleanLeads = (wm: unknown) => (Array.isArray(wm) ? wm : []).filter((c) => c).map((c: Record<string, unknown>) => ({ id: c.id || "", name: c.name || "", phone: c.phone || "", email: c.email || "", howKnow: c.howKnow || "", apptDate: c.apptDate || "", traits: c.traits || "", notes: c.notes || "", contacted: !!c.contacted, contactedDate: c.contactedDate || "", status: c.status || "", outcome: c.outcome || "", pooled: !!c.pooled, locked: !!c.locked, seniorOnly: !!c.seniorOnly, date: c.date || "" }));
      const agents = mine.map((r: Record<string, unknown>) => { const e = enrichAgent(r, today); e.relation = (low(r.md) === L) ? "direct" : "org"; if (maySeeLeads) e.leads = cleanLeads(r.warm_market); return e; });
      const buckets = { green: 0, yellow: 0, orange: 0, red: 0 };
      for (const r of agents) { const s = (r.progress_status as string) || "red"; (buckets as Record<string, number>)[s]++; }
      const top = (key: string, n = 5) => agents.filter((r: Record<string, unknown>) => (Number(r[key]) || 0) > 0).sort((a: Record<string, unknown>, b: Record<string, unknown>) => (Number(b[key])||0) - (Number(a[key])||0)).slice(0, n).map((r: Record<string, unknown>) => ({ code: r.code, name: ((r.first_name||"")+" "+(r.last_name||"")).trim(), value: Number(r[key])||0 }));
      return json({ ok: true, today, leader, leads_included: maySeeLeads, count: agents.length, buckets, leaderboard: { adders: top("mp_added_7"), streaks: top("live_streak"), trainings: top("ft_done"), appts: top("act_appts_7"), reached: top("contacted_7") }, agents });
    }

    /* The four team_* writes below have no caller in the app — they are left reachable only for
       Operations, or for the leader whose team it genuinely is, proven by session. */
    async function leaderGate(leader: string) {
      if (isAdmin) return null;
      if (!me.code) return needSession();
      if (!me.name || low(me.name) !== low(leader)) return json({ ok: false, error: "That is not your team." }, 403);
      return null;
    }

    if (action === "team_setleadstatus") {
      const leader = clean(body.leader), code = norm(body.code), leadId = clean(body.leadId), raw = clean(body.status).toLowerCase();
      const gate = await leaderGate(leader); if (gate) return gate;
      const st = raw === "nurture" ? "called" : raw;
      const valid = ["fresh", "called", "scheduled", "followup", "won", "lost"];
      if (!code || !leadId || valid.indexOf(st) < 0) return json({ ok: false, error: "missing code/leadId or bad status" });
      const sc = await loadInScope(code, leader); if (sc.err) return sc.err;
      const wm: Record<string, unknown>[] = Array.isArray(sc.agent.warm_market) ? sc.agent.warm_market.slice() : [];
      const idx = wm.findIndex((x) => x && x.id === leadId); if (idx < 0) return json({ ok: false, error: "lead not found" });
      const upd: Record<string, unknown> = { ...(wm[idx] as Record<string, unknown>) };
      upd.status = st;
      if (st === "fresh") { upd.contacted = false; upd.outcome = ""; }
      else if (st === "won") { upd.contacted = true; upd.outcome = "win"; if (!upd.contactedDate) upd.contactedDate = ptToday(); }
      else if (st === "lost") { upd.contacted = true; upd.outcome = "lose"; if (!upd.contactedDate) upd.contactedDate = ptToday(); }
      else { upd.contacted = true; upd.outcome = ""; if (!upd.contactedDate) upd.contactedDate = ptToday(); }
      wm[idx] = upd;
      const up = await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${encodeURIComponent(code)}`, { method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify({ warm_market: wm, updated_at: new Date().toISOString() }) });
      return json({ ok: up.ok, code, leadId, status: st });
    }

    if (action === "team_setlocked") {
      const leader = clean(body.leader), code = norm(body.code), leadId = clean(body.leadId);
      const gate = await leaderGate(leader); if (gate) return gate;
      if (!code || !leadId) return json({ ok: false, error: "missing code or leadId" });
      const sc = await loadInScope(code, leader); if (sc.err) return sc.err;
      const wm: Record<string, unknown>[] = Array.isArray(sc.agent.warm_market) ? sc.agent.warm_market.slice() : [];
      const idx = wm.findIndex((x) => x && x.id === leadId); if (idx < 0) return json({ ok: false, error: "lead not found" });
      const cur = wm[idx] as Record<string, unknown>;
      const want = (typeof body.locked === "boolean") ? body.locked : !cur.locked;
      const upd: Record<string, unknown> = { ...cur, locked: want };
      if (want && upd.pooled) { upd.pooled = false; delete upd.pooledDate; }
      wm[idx] = upd;
      const up = await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${encodeURIComponent(code)}`, { method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify({ warm_market: wm, updated_at: new Date().toISOString() }) });
      return json({ ok: up.ok, code, leadId, locked: want });
    }

    if (action === "team_setcontacted") {
      const leader = clean(body.leader), code = norm(body.code), leadId = clean(body.leadId);
      const gate = await leaderGate(leader); if (gate) return gate;
      if (!code || !leadId) return json({ ok: false, error: "missing code or leadId" });
      const sc = await loadInScope(code, leader); if (sc.err) return sc.err;
      const wm: Record<string, unknown>[] = Array.isArray(sc.agent.warm_market) ? sc.agent.warm_market.slice() : [];
      const idx = wm.findIndex((x) => x && x.id === leadId); if (idx < 0) return json({ ok: false, error: "lead not found" });
      const cur = wm[idx] as Record<string, unknown>;
      const want = (typeof body.contacted === "boolean") ? body.contacted : !cur.contacted;
      const upd: Record<string, unknown> = { ...cur, contacted: want };
      if (want && !upd.contactedDate) upd.contactedDate = ptToday();
      wm[idx] = upd;
      const up = await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${encodeURIComponent(code)}`, { method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify({ warm_market: wm, updated_at: new Date().toISOString() }) });
      return json({ ok: up.ok, code, leadId, contacted: want });
    }

    if (action === "team_logactivity") {
      const leader = clean(body.leader), code = norm(body.code);
      const gate = await leaderGate(leader); if (gate) return gate;
      const dials = Math.max(0, Number(body.dials) || 0), convos = Math.max(0, Number(body.convos) || 0), appts = Math.max(0, Number(body.appts) || 0);
      if (!code || (dials + convos + appts) === 0) return json({ ok: false, error: "nothing to log" });
      const sc = await loadInScope(code, leader); if (sc.err) return sc.err;
      const log: Record<string, unknown>[] = Array.isArray(sc.agent.activity_log) ? sc.agent.activity_log.slice() : [];
      log.push({ date: ptToday(), dials, convos, appts, by: leader });
      const up = await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${encodeURIComponent(code)}`, { method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify({ activity_log: log, updated_at: new Date().toISOString(), last_activity: new Date().toISOString() }) });
      return json({ ok: up.ok, code, logged: { dials, convos, appts } });
    }

    if (action === "marketing") {
      if (!isAdmin) return json({ ok: false, error: "unauthorized" }, 401);
      const ex = await fetch(`${SUPA}/rest/v1/tracker_agents?select=code,first_name,last_name,emd,md,status,warm_market&order=updated_at.desc`, { headers: DBH });
      const rows = await ex.json();
      const leads: Record<string, unknown>[] = [];
      for (const r of (rows || [])) {
        const wm = Array.isArray(r.warm_market) ? r.warm_market : [];
        const agentName = ((r.first_name || "") + " " + (r.last_name || "")).trim();
        for (const c of wm) {
          if (!c) continue;
          leads.push({
            agent_code: r.code, agent_name: agentName, emd: r.emd || "", md: r.md || "", agent_status: r.status || "active",
            id: c.id || "", name: c.name || "", phone: c.phone || "", email: c.email || "",
            direct_to: c.directTo || "", time_zone: c.timeZone || "", age: c.age || "", married: !!c.married, children: !!c.children,
            how_know: c.howKnow || "", appt_date: c.apptDate || "", traits: c.traits || "",
            contacted: !!c.contacted, pooled: !!c.pooled, locked: !!c.locked, senior_only: !!c.seniorOnly, notes: c.notes || "", status: c.status || "", outcome: c.outcome || "", date: c.date || "", done: !!c.done
          });
        }
      }
      if (url.searchParams.get("format") === "csv" || body.format === "csv") {
        const head = "Agent,Agent Code,Agent Status,Exec Broker,Senior Broker,Lead Name,Phone,Email,Contacted,In Pool,Locked,Senior Only,Direct To,Time Zone,Age,Married,Children,How You Know Them,Appt Date,Traits,Outcome,Notes,Date Added";
        const esc = (v: unknown) => `\"${(v == null ? "" : String(v)).replace(/\"/g, '\"\"')}\"`;
        const lines = [head].concat(leads.map((r) => [r.agent_name, r.agent_code, r.agent_status, r.emd, r.md, r.name, r.phone, r.email, (r.contacted?"Yes":"No"), (r.pooled?"Yes":""), (r.locked?"Yes":""), (r.senior_only?"Yes":""), r.direct_to, r.time_zone, r.age, (r.married?"Yes":""), (r.children?"Yes":""), r.how_know, r.appt_date, r.traits, r.outcome, r.notes, r.date].map(esc).join(",")));
        return new Response(lines.join("\n"), { headers: { ...CORS, "Content-Type": "text/csv; charset=utf-8" } });
      }
      return json({ ok: true, count: leads.length, leads });
    }

    if (action === "list" || action === "export" || action === "engagement" || action === "pulse") {
      if (action !== "pulse" && !isAdmin) return json({ ok: false, error: "unauthorized" }, 401);
      const ex = await fetch(`${SUPA}/rest/v1/tracker_agents?select=code,first_name,last_name,emd,md,pathway,status,progress,done_count,total,pct,streak,best_streak,last_daily,ft_log,warm_market,activity_log,last_activity,created_at,updated_at&order=emd.asc,md.asc,updated_at.desc`, { headers: DBH });
      const rows = await ex.json();
      const today = ptToday();
      const out = (rows || []).map((r: Record<string, unknown>) => enrichAgent(r, today));
      if (action === "pulse") {
        const active = out.filter((r: Record<string, unknown>) => (r.status || "active") !== "quit" && r.code !== "POOL");
        const buckets = { green: 0, yellow: 0, orange: 0, red: 0 };
        for (const r of active) { const s = (r.progress_status as string) || "red"; (buckets as Record<string, number>)[s]++; }
        const fn = (r: Record<string, unknown>) => ((r.first_name as string) || "").trim().split(" ")[0] || "";
        const top = (key: string, n = 3) => active.filter((r: Record<string, unknown>) => (Number(r[key]) || 0) > 0).sort((a: Record<string, unknown>, b: Record<string, unknown>) => (Number(b[key])||0) - (Number(a[key])||0)).slice(0, n).map((r: Record<string, unknown>) => ({ name: fn(r), value: Number(r[key])||0 }));
        const withLeads = active.filter((r: Record<string, unknown>) => (Number(r.warm_leads)||0) > 0).length;
        const onStreak = active.filter((r: Record<string, unknown>) => (Number(r.live_streak)||0) > 0).length;
        return json({ ok: true, today, active: active.length, buckets, with_leads: withLeads, on_streak: onStreak, builders: top("mp_added_7"), trainings: top("ft_done"), connectors: top("contacted_7"), appts: top("act_appts_7") });
      }
      if (action === "export") {
        const head = "Status,Executive Broker,Senior Broker,GFI Code,First Name,Last Name,Pathway,Steps Done,Total,Percent,Field Trainings Done,FT Last 30d,FT Pace/wk,Business Submitted,Warm Leads,Wins,Losses,In Pool,Close Rate %,Leads Added 7d,Leads Added 14d,Leads Added 30d,Reached Out,Days Inactive,Progress Status,Dials 7d,Convos 7d,Appts 7d,Reached 7d,Current Streak,Best Streak,Last Daily,Registered,Last Updated";
        const esc = (v: unknown) => `\"${(v == null ? "" : String(v)).replace(/\"/g, '\"\"')}\"`;
        const lines = [head].concat(out.map((r: Record<string, unknown>) => [r.status, r.emd, r.md, r.code, r.first_name, r.last_name, r.pathway, r.done_count, r.total, r.pct, r.ft_done, r.ft_30, r.ft_pace_per_wk, r.biz_submitted, r.warm_leads, r.wm_wins, r.wm_losses, r.wm_pooled, r.wm_close_rate, r.mp_added_7, r.mp_added_14, r.mp_added_30, r.mp_contacted, r.days_inactive, r.progress_status, r.act_dials_7, r.act_convos_7, r.act_appts_7, r.contacted_7, r.live_streak, r.best_streak, r.last_daily, r.created_at, r.updated_at].map(esc).join(",")));
        return new Response(lines.join("\n"), { headers: { ...CORS, "Content-Type": "text/csv; charset=utf-8" } });
      }
      if (action === "engagement") {
        const active = out.filter((r: Record<string, unknown>) => (r.status || "active") !== "quit" && r.code !== "POOL");
        const buckets = { green: 0, yellow: 0, orange: 0, red: 0 };
        for (const r of active) { const s = (r.progress_status as string) || "red"; (buckets as Record<string, number>)[s]++; }
        const top = (key: string, n = 5) => active.filter((r: Record<string, unknown>) => (Number(r[key]) || 0) > 0).sort((a: Record<string, unknown>, b: Record<string, unknown>) => (Number(b[key])||0) - (Number(a[key])||0)).slice(0, n).map((r: Record<string, unknown>) => ({ code: r.code, name: ((r.first_name||"")+" "+(r.last_name||"")).trim(), value: Number(r[key])||0 }));
        const leaderboard = { adders: top("mp_added_7"), streaks: top("live_streak"), trainings: top("ft_done"), appts: top("act_appts_7"), dials: top("act_dials_7"), reached: top("contacted_7") };
        return json({ ok: true, today, count: active.length, buckets, leaderboard, agents: active });
      }
      return json({ ok: true, count: out.length, agents: out });
    }

    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
