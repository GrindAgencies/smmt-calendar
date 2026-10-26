import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// mktg-team v8 (2026-10-26) — A WARM MARKET IS SEEN DOWN THE TREE, NEVER ACROSS OR UP IT. "all"
//   returned every warm-market list in the caller's whole baseshop: an MD's leads were readable by
//   the CFTs below them, and one branch could read another's. Brief section 8: hierarchy reveals
//   your own tree, and never an upline's or a sibling branch's private contacts. The list is now
//   the caller plus their recursive downline (nb_scope_codes); the root of the tree and
//   Operations keep the full view.
//
// mktg-team v7 (2026-10-18) — the leadership view now carries WHY a lead is being called.
//
// Each lead already had an `apptType` ("appointment" or "hiring") but it was set through a
// dropdown buried in the broker's own detail panel, and it never left the broker's device:
// allLeads() builds an explicit field list and apptType was not on it. So a leader looking at
// the team's book could not tell a field training appointment from a hiring interview, which
// is exactly the split that decides who makes the call and what they say. One field added,
// surfaced as the Purpose column.
//
// mktg-team v6 (2026-09-30) — IDENTITY NOW COMES FROM A SESSION, NOT FROM A TYPED CODE.
//
// v5 closed the baseshop leak: a TITANS director could no longer read all four shops' lead lists.
// But it still answered the question "who are you?" with whatever `code` arrived in the request
// body, and GFI codes are printed on the org chart. So the shop boundary held while the PERSON
// boundary did not: send a colleague's code and you were served their shop's leads as them, and
// `growth_plan` handed back an AI playbook built from their private contact list.
//
// This is the single most sensitive endpoint in the app for that — the rows carry client NAME,
// PHONE, EMAIL, age, marital status, children and free-text notes. Third-party personal data.
//
// Now: the caller is whoever holds the session token minted when they entered their PIN
// (agent_session_code), or Operations (ops_authorize). A `code` in the body is treated as a
// REQUEST, never as proof — for growth_plan it is ignored outright, and for the roster reads it
// only ever narrows within what the session holder is already entitled to. `needs_session` tells
// the page to send them through sign-in once; session.js handles the bounce.

const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
function json(o: unknown, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const low = (s: unknown) => (s ?? "").toString().trim().toLowerCase();
const clean = (s: unknown) => (s ?? "").toString().trim();

async function loadKey(k: string) { try { const r = await fetch(`${SUPA}/rest/v1/app_settings?key=eq.${encodeURIComponent(k)}&select=value`, { headers: DBH }); const rows = await r.json(); return (rows && rows[0]) ? rows[0].value : null; } catch (_) { return null; } }
async function saveKey(k: string, v: unknown) { try { await fetch(`${SUPA}/rest/v1/app_settings?on_conflict=key`, { method: "POST", headers: { ...DBH, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key: k, value: v, updated_at: new Date().toISOString() }) }); } catch (_) { /* noop */ } }
async function rpc(fn: string, args: Record<string, unknown>) { try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); return await r.json(); } catch (_) { return null; } }

/* ===== WHO IS CALLING =====
   Two kinds of caller, and nothing else counts:
     · Operations / a machine job, proven by a token ops_authorize() accepts.
     · A signed-in member, proven by a session token minted at PIN entry.
   A bare `code` proves nothing, so it is never read here. */
type Caller = { code: string; ops: boolean };
async function whoIsCalling(body: Record<string, unknown>, q: URLSearchParams): Promise<Caller> {
  const t = clean(body.token || q.get("token")).slice(0, 120);
  if (t) { const o = await rpc("ops_authorize", { p_token: t }); if (o && o.ok) return { code: "", ops: true }; }
  const s = clean(body.session || q.get("session")).slice(0, 120);
  if (s) { const c = await rpc("agent_session_code", { p_token: s }); if (typeof c === "string" && c) return { code: norm(c), ops: false }; }
  return { code: "", ops: false };
}

/* Which baseshops may this caller see? One definition, shared by every tab. */
type Scope = { ok: boolean; code: string; name: string; baseshop: string; all: boolean; bases: string[]; codes?: string[] };
async function agentScope(code: string): Promise<Scope> {
  const r = await rpc("agent_scope", { p_code: norm(code) });
  if (!r || r.ok !== true) return { ok: false, code: norm(code), name: "", baseshop: "", all: false, bases: [] };
  return { ok: true, code: String(r.code || ""), name: String(r.name || ""), baseshop: String(r.baseshop || ""), all: !!r.all, bases: Array.isArray(r.bases) ? r.bases.map((x: unknown) => norm(x)) : [] };
}

async function orgRoleOf(code: string): Promise<string> {
  try {
    const v = await loadKey("org_structure");
    const nodes = (v && Array.isArray(v.nodes)) ? v.nodes as Record<string, unknown>[] : [];
    const n = nodes.find((x) => norm(x.id) === norm(code) || norm(x.gfi) === norm(code));
    return n ? String(n.role || "agent") : "agent";
  } catch (_) { return "agent"; }
}
async function isBaseOwner(code: string): Promise<boolean> {
  try {
    const bs = await loadKey("baseshops");
    const list = (bs && Array.isArray(bs.bases)) ? bs.bases as Record<string, unknown>[] : [];
    return list.some((b) => norm(b.owner_code) === norm(code));
  } catch (_) { return false; }
}
function contractIsLeader(cl: unknown): boolean {
  const s = low(cl);
  if (!s) return false;
  return /(^|\b)(cft|certified field trainer|md|marketing director|emd|executive marketing|nvp|national vice|sevp|senior executive|ceo)(\b|$)/.test(s);
}

async function cftPlus(code: string): Promise<{ ok: boolean; via: string; name: string; role: string; contract: string }> {
  const c = norm(code);
  if (!c) return { ok: false, via: "", name: "", role: "", contract: "" };
  let name = "", contract = "";
  try {
    const ex = await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${encodeURIComponent(c)}&select=first_name,last_name,contract_level&limit=1`, { headers: DBH });
    const a = ((await ex.json()) || [])[0];
    if (a) { name = (((a.first_name as string) || "") + " " + ((a.last_name as string) || "")).trim(); contract = String(a.contract_level || ""); }
  } catch (_) { /* noop */ }
  const role = await orgRoleOf(c);
  if (role === "cft" || role === "senior" || role === "exec") return { ok: true, via: "role:" + role, name, role, contract };
  if (await isBaseOwner(c)) return { ok: true, via: "base_owner", name, role, contract };
  if (contractIsLeader(contract)) return { ok: true, via: "contract:" + low(contract), name, role, contract };
  return { ok: false, via: "", name, role, contract };
}

/* Leads for the shops this caller is entitled to — never the whole company.
   `bases` empty with all=false means an unplaced agent: they get nothing but their own list. */
async function allLeads(scope: Scope): Promise<Record<string, unknown>[]> {
  let path = `tracker_agents?select=code,first_name,last_name,emd,md,status,baseshop,warm_market&order=updated_at.desc`;
  if (!scope.all && Array.isArray(scope.codes)) {
    const list = scope.codes.filter((c) => /^[A-Za-z0-9_.-]+$/.test(c)).map((c) => `"${c}"`).join(",");
    path += `&code=in.(${encodeURIComponent(list || `"${norm(scope.code)}"`)})`;
  } else if (!scope.all) {
    const bases = (scope.bases || []).filter(Boolean);
    if (!bases.length) {
      path += `&code=eq.${encodeURIComponent(norm(scope.code))}`;
    } else {
      const list = bases.map((b) => `"${b}"`).join(",");
      path += `&baseshop=in.(${encodeURIComponent(list)})`;
    }
  }
  const ex = await fetch(`${SUPA}/rest/v1/${path}`, { headers: DBH });
  const rows = await ex.json();
  const leads: Record<string, unknown>[] = [];
  for (const r of (rows || [])) {
    if (r.code === "POOL") continue;
    const wm = Array.isArray(r.warm_market) ? r.warm_market : [];
    const agentName = ((r.first_name || "") + " " + (r.last_name || "")).trim();
    for (const c of wm) {
      if (!c) continue;
      leads.push({
        agent_code: r.code, agent_name: agentName, emd: r.emd || "", md: r.md || "", agent_status: r.status || "active",
        baseshop: r.baseshop || "",
        id: c.id || "", name: c.name || "", phone: c.phone || "", email: c.email || "",
        direct_to: c.directTo || "", time_zone: c.timeZone || "", age: c.age || "", married: !!c.married, children: !!c.children,
        how_know: c.howKnow || "", appt_date: c.apptDate || "", traits: c.traits || "",
        /* WHY this person is being called: a field training appointment or a hiring interview.
           Stored lowercase here so the page does not have to know the three spellings the
           field picked up before it was ever surfaced ("appointment", "Appointment", "hiring"). */
        appt_type: low(c.apptType),
        contacted: !!c.contacted, pooled: !!c.pooled, locked: !!c.locked, senior_only: !!c.seniorOnly,
        notes: c.notes || "", status: c.status || "", outcome: c.outcome || "", date: c.date || "", done: !!c.done
      });
    }
  }
  return leads;
}

/* ===== AI Growth Plan (focused playbook from the broker's own Marketing Plan) ===== */
const MODELS = ["claude-sonnet-4-6", "claude-3-5-sonnet-20241022", "claude-haiku-4-5", "claude-haiku-4-5-20251001", "claude-3-5-haiku-20241022"];
async function callClaude(sys: string, prompt: string, maxTokens: number): Promise<{ txt: string; model?: string; err?: string }> {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return { txt: "", err: "no ANTHROPIC_API_KEY set" };
  let lastErr = "no models tried";
  for (const model of MODELS) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify({ model, max_tokens: maxTokens, system: sys, messages: [{ role: "user", content: prompt || "hello" }] }) });
      const j = await res.json();
      const txt = (j && j.content && j.content[0] && j.content[0].text) ? String(j.content[0].text).trim() : "";
      if (txt) return { txt, model };
      const em = (j && j.error && (j.error.message || j.error.type)) ? String(j.error.message || j.error.type) : "no text";
      lastErr = model + ": " + em;
      if (/authentication|invalid x-api-key|permission|credit|billing/i.test(em)) return { txt: "", err: em };
    } catch (e) { lastErr = model + ": " + String(e); }
  }
  return { txt: "", err: lastErr };
}
function statusOf(c: Record<string, unknown>): string {
  const k = c && c.status ? String(c.status) : "";
  if (k && ["fresh", "called", "scheduled", "followup", "won", "lost"].indexOf(k) >= 0) return k;
  if (c) { if (c.outcome === "win") return "won"; if (c.outcome === "lose") return "lost"; if (c.contacted) return "called"; }
  return "fresh";
}
/* The same two purposes, in words the coach can use. */
function purposeOf(c: Record<string, unknown>): string {
  const v = low(c && c.apptType);
  if (v === "hiring" || v === "hi") return "hiring interview";
  if (v === "appointment" || v === "fta") return "field training appointment";
  return "";
}
async function getAgentFull(code: string) {
  const ex = await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${encodeURIComponent(code)}&select=first_name,last_name,warm_market&limit=1`, { headers: DBH });
  return ((await ex.json()) || [])[0] || null;
}
const GROWTH_SYS = `You are an elite financial services business coach, CRM strategist, and accountability partner. Your advisor works at The Standard Financial Group — a life-insurance & financial-services agency (life/IUL/FIA/annuities, retirement, protection, and referral-driven growth).

You are given the advisor's OWN Marketing Plan: their personal list of contacts, each with how they know them, a pipeline status, and notes. Some contacts are marked with the PURPOSE of the call — a field training appointment (a client conversation) or a hiring interview (a recruiting conversation). Respect that split: never suggest pitching a recruit or recruiting a client unless the advisor has left it unmarked.

Produce a FOCUSED, execution-ready growth playbook in clean GitHub-flavored Markdown with EXACTLY these five sections and headers, in this order:

## 1) Your list at a glance
Group the contacts into meaningful segments (e.g. Warm market / Family & friends, Business owners, Professional network/COIs, Referral partners, Prospects by need, Dormant). Give counts and 2–3 sharp observations about strengths, gaps, and who to add. Note how many are marked for appointments versus hiring interviews, and whether that balance fits their goals.

## 2) Hot / Warm / Cold priorities
Sort the real contacts into Hot (ready for a discovery/appointment), Warm (nurture), and Cold (long-term). Name specific people from the list and say why. Flag the top few to call this week and anyone at risk of going stale.

## 3) Your 90-day plan (week by week)
A practical week-by-week cadence (Weeks 1–12) of daily outreach, discovery meetings, reviews, educational touches, and referral asks — with clear weekly goals. Keep activity realistic for one advisor.

## 4) Scripts you can use today
Short, ready-to-send, compliance-safe scripts: a discovery call opener, a voicemail, a relationship text (non-promotional), a referral/introduction ask, and an annual-review invite. Warm, educational, never pushy.

## 5) Your 5 highest-impact actions this week
Five concrete moves, each one line, ordered by impact — the fastest path to more conversations, appointments, and referrals.

RULES: Ground every recommendation in the ACTUAL contacts (reference names and segments from the list). Relationship-first and educational — never promise or imply specific investment returns, guarantees, or give individualized securities/tax/legal advice. For exact compliance, comp, or licensing questions, tell them to check with Operations (Anais, 858-433-4429). Be specific, warm, and motivating. Keep the whole thing tight — roughly 750–950 words. Do not add sections beyond the five.`;

const FULL_SYS = `You are an elite financial services business coach, wealth-management growth strategist, CRM consultant, and accountability partner. Your advisor works at The Standard Financial Group — a life-insurance & financial-services agency (life/IUL/FIA/annuities, retirement, protection, lending relationships, and referral-driven growth).

You are given the advisor's OWN Marketing Plan: their personal list of contacts with how they know them, a pipeline status, and notes. Some contacts are marked with the PURPOSE of the call — a field training appointment (a client conversation) or a hiring interview (a recruiting conversation). Respect that split throughout.

Transform it into a comprehensive, personalized FINANCIAL SERVICES GROWTH PLAYBOOK they can execute immediately. Output clean GitHub-flavored Markdown with EXACTLY these 17 sections and headers, in order:

## 1) Executive Summary
## 2) Database Analysis
Segment every contact (A+ advocates/COIs, current & former clients, family, friends, professional network — CPAs/attorneys/bankers, business owners, high-net-worth, mass affluent, retirement, insurance, investment, referral partners, community, dormant). Counts, strengths, gaps, cross-sell potential, and who to add. Include the appointment-versus-hiring split.
## 3) Client & Prospect Segmentation
Name real contacts from the list in each tier.
## 4) 90-Day Growth Plan
Week-by-week (Weeks 1–12): weekly goals + daily activity (calls, texts, emails, reviews, educational touches, referral asks). Each block: purpose, rough time, expected outcome, priority.
## 5) CRM Architecture
Tags (AUM level, product, relationship strength), custom fields (risk tolerance, life stage, goals), stages (Prospect → Discovery → Planning → Active → Retention → Advocate), follow-up cadences, review cycles.
## 6) Communication System
Compliance-safe scripts: discovery call, follow-up, voicemail, relationship text, email, referral ask, annual-review invite, re-engagement. Give separate openers for a client appointment and a hiring interview.
## 7) Referral Strategy
Top referral sources in the list by name, COIs to build, timing, ask scripts, follow-up cadence, appreciation.
## 8) Social Media Plan
Financial-literacy/education content system, weekly posting schedule, formats (LinkedIn, reels), engagement.
## 9) Email Marketing System
Monthly education newsletter, campaigns (retirement, insurance, small business), onboarding & re-engagement sequences, subject lines.
## 10) Event Strategy
Workshops/webinars (retirement, tax w/ CPA, client appreciation): budget range, timeline, invite list from their contacts, follow-up, conversion goals.
## 11) Business Development Plan
COI & partner targets (CPA firms, estate attorneys, mortgage pros, business banking, HR/401k, chambers, associations).
## 12) Annual Growth Calendar
Month-by-month (tax season, retirement seasonality, insurance reviews, quarterly updates, seminars, referral campaigns, holidays).
## 13) KPI Dashboard
Discovery meetings, annual reviews, AUM growth, policies written/retained, referrals received & converted, retention, engagement, event attendance, revenue.
## 14) Weekly Execution System
Monday planning, daily outreach blocks, review meetings, content creation, referral conversations, follow-up, weekly review.
## 15) AI Productivity Enhancements
Where AI helps (compliance-safe email drafts, follow-up sequences, content, market-commentary drafts, CRM updates, meeting prep, review summaries).
## 16) First 30 Days Action Plan
## 17) Next 90 Days Roadmap

Finish with a short "## 🚀 Five highest-impact actions right now" list.

RULES: Ground every recommendation in the ACTUAL contacts (reference names and segments). Relationship-first, educational, compliance-safe — never promise or imply specific investment returns or guarantees, and don't give individualized securities/tax/legal advice. For exact compliance, comp, or licensing questions, tell them to check with Operations (Anais, 858-433-4429). Specific, warm, motivating, execution-focused.`;

async function growthPlan(code: string, regenerate: boolean, peek: boolean, full: boolean) {
  const cacheKey = "growthplan_" + (full ? "full_" : "") + norm(code);
  const cached = await loadKey(cacheKey) as Record<string, unknown> | null;
  if (peek) return { ok: true, plan: (cached && cached.md) || null, generated_at: (cached && cached.at) || "", count: (cached && cached.count) || 0, model: (cached && cached.model) || "", full };
  if (!regenerate && cached && cached.md) return { ok: true, plan: cached.md, generated_at: cached.at, count: cached.count, model: cached.model, cached: true, full };

  const a = await getAgentFull(code);
  if (!a) return { ok: false, error: "We couldn't find your record — sign in again." };
  const first = (clean(a.first_name) || "there").split(/\s+/)[0];
  const wm: Record<string, unknown>[] = Array.isArray(a.warm_market) ? a.warm_market : [];
  const real = wm.filter((c) => c && (clean(c.name) || clean(c.phone)));
  if (real.length < 3) return { ok: false, error: "Add at least a few people to your Marketing Plan first — then I can build your plan." };

  const lines = real.slice(0, 160).map((c, i) => {
    const bits = [`${i + 1}. ${clean(c.name) || "(no name)"}`];
    bits.push("know: " + (clean(c.howKnow) || "—"));
    bits.push("status: " + statusOf(c));
    const pp = purposeOf(c);
    if (pp) bits.push("calling for: " + pp);
    if (c.contacted) bits.push("contacted"); else bits.push("not yet contacted");
    if (clean(c.apptDate)) bits.push("appt " + clean(c.apptDate));
    if (clean(c.age)) bits.push("age " + clean(c.age));
    if (c.married) bits.push("married");
    if (c.children) bits.push("has kids");
    if (clean(c.traits)) bits.push("traits: " + clean(c.traits).slice(0, 60));
    if (c.outcome === "win") bits.push("WON"); else if (c.outcome === "lose") bits.push("lost");
    if (clean(c.notes)) bits.push("notes: " + clean(c.notes).slice(0, 90));
    return bits.join(" | ");
  });
  const wins = real.filter((c) => c.outcome === "win").length;
  const contacted = real.filter((c) => c.contacted).length;
  const ftaN = real.filter((c) => purposeOf(c) === "field training appointment").length;
  const hiN = real.filter((c) => purposeOf(c) === "hiring interview").length;
  const prompt = `Advisor first name: ${first}\nMarketing Plan size: ${real.length} contacts (${contacted} contacted, ${wins} won).\nMarked purpose: ${ftaN} field training appointments, ${hiN} hiring interviews, ${real.length - ftaN - hiN} unmarked.\n\nContacts:\n${lines.join("\n")}`;

  const r = await callClaude(full ? FULL_SYS : GROWTH_SYS, prompt, full ? 5200 : 2800);
  if (!r.txt) return { ok: false, error: "The AI coach is unavailable right now — try again in a minute." + (r.err ? " (" + r.err + ")" : "") };
  const at = new Date().toISOString();
  await saveKey(cacheKey, { md: r.txt, at, count: real.length, model: r.model || "" });
  return { ok: true, plan: r.txt, generated_at: at, count: real.length, model: r.model || "", full };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = new URL(req.url);
    let body: Record<string, unknown> = {};
    if (req.method === "POST") body = await req.json().catch(() => ({}));
    const action = (body.action as string) || url.searchParams.get("action") || "";

    const me = await whoIsCalling(body, url.searchParams);
    if (!me.ops && !me.code) {
      return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401);
    }

    if (action === "access") {
      if (me.ops) return json({ ok: true, cft_plus: true, name: "Operations", via: "ops", scope: "all" });
      const r = await cftPlus(me.code);
      const s = await agentScope(me.code);
      return json({ ok: true, code: me.code, cft_plus: r.ok, name: r.name, via: r.via, role: r.role, scope: s.all ? "all" : "baseshop", bases: s.bases, baseshop: s.baseshop });
    }

    if (action === "all") {
      // Three questions now, and ALL must pass:
      //   1. do you hold a real session?                          (whoIsCalling, above)
      //   2. are you senior enough to see other people's lists?    (cftPlus)
      //   3. WHOSE lists — which baseshops are yours?              (agentScope)
      // v5 asked only 2 and 3, so a typed code answered question 1 for free.
      if (me.ops) {
        const leads = await allLeads({ ok: true, code: "OPS", name: "Operations", baseshop: "", all: true, bases: [] });
        return json({ ok: true, count: leads.length, by: "Operations", scope: "all", leads });
      }
      const r = await cftPlus(me.code);
      if (!r.ok) return json({ ok: false, error: "Backend access is limited to CFTs and above." }, 403);
      const s = await agentScope(me.code);
      if (!s.ok) return json({ ok: false, error: "We couldn't find your record — sign in again." }, 403);
      /* v8: you and everyone beneath you. nb_scope_codes returns the whole company only for the
         configured root of the tree. */
      const tree = await rpc("nb_scope_codes", { p_leader: me.code });
      const codes = Array.isArray(tree) ? tree.map((t: Record<string, unknown>) => String((t && t.code) ?? t ?? "").trim()).filter(Boolean) : [me.code];
      const leads = await allLeads({ ...s, all: false, codes: codes.length ? codes : [me.code] });
      return json({ ok: true, count: leads.length, by: r.name || me.code, scope: "hierarchy", baseshop: s.baseshop, bases: s.bases, leads });
    }

    // AI Growth Plan — the SIGNED-IN broker's own list, full stop. A `code` in the body is ignored,
    // because this reads somebody's private contact list and feeds it to a model.
    if (action === "growth_plan") {
      const subject = me.ops ? norm(body.code) : me.code;
      if (!subject) return json({ ok: false, error: "no code" });
      return json(await growthPlan(subject, !!body.regenerate, !!body.peek, !!body.full));
    }

    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
