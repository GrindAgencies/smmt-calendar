// ops-bot v8 (2026-10-28) — open to MDs, EMDs and Operations; leaders get their own baseshop's snapshot.
// ops-bot v7 (2026-10-22) — Claude-backed Operations Assistant. Data-aware, can create tasks & toggle
// automations, carries an editable knowledge base to debrief new Ops staff. High token ceiling.
//
// v6: THE SEAT-CODE DOOR IS CLOSED. v3's comment said a four-digit code "must be a REAL Operations
// seat" — and that was the whole test. There are six seat codes (0000-0005), each typed on a
// sign-in screen every morning, so `{"code":"0002"}` was an Operations login to an assistant that
// reads the entire book of business in snapshot() — every agent, every policy, submitted AP,
// paid-out AP and commission — and can create tasks and switch the automations off. Operations
// must now present the session token minted at PIN entry. No regression: ops.html has sent that
// token on every ops-role call since the September cutover, and a restored tab without a live
// session is already bounced to the PIN prompt rather than running tokenless.
//
// v7 (2026-10-22): THE LEADER BRANCH IS CLOSED TOO. v6 left it open pending a decision, because
// closing it looked like it would lock MD/EMDs out. It does not: ops.html loads session.js, which
// injects the signed-in agent's session into this very request, so a leader who has signed into
// the app with their PIN is recognised without typing anything. What stops working is the thing
// that should: asserting you are an EMD by typing an EMD's code off the org chart.
//
// The rank test is unchanged — a baseshop owner, or a contract_level of EMD/NVP/SEVP. Only where
// the CODE comes from changed, from the request body to the verified session.
//
// v3 (2026-09-02) fixes two ways in. Authorisation was the literal "2026", which shipped
// inside ops.html for anyone to read; it is now an Operations session from ops-auth.
// And ANY four-digit string used to pass — `/^\d{4}$/` on the code alone — so "1234" was a
// valid Operations login to an assistant that can read the whole book of business and
// create tasks. It now has to be a real Operations seat.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
function json(o: unknown, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const low = (s: unknown) => (s ?? "").toString().trim().toLowerCase();
const money = (v: unknown) => "$" + (Math.round(Number(v) || 0)).toLocaleString("en-US");
const clean = (s: unknown) => (s ?? "").toString().trim().slice(0, 6000);

async function getJSON(path: string) { try { const r = await fetch(`${SUPA}/rest/v1/${path}`, { headers: DBH }); return (await r.json()) || []; } catch (_) { return []; } }
async function loadKey(k: string) { try { const r = await fetch(`${SUPA}/rest/v1/app_settings?key=eq.${k}&select=value`, { headers: DBH }); const rows = await r.json(); return (rows && rows[0]) ? rows[0].value : null; } catch (_) { return null; } }
async function saveKey(k: string, v: unknown) { await fetch(`${SUPA}/rest/v1/app_settings?on_conflict=key`, { method: "POST", headers: { ...DBH, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key: k, value: v, updated_at: new Date().toISOString() }) }); }
async function rpc(fn: string, args: Record<string, unknown>) { try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); return await r.json(); } catch (_) { return null; } }
async function opsAuthorized(token: unknown) { const r = await rpc("ops_authorize", { p_token: String(token ?? "") }); return !!(r && r.ok); }

const MODELS = ["claude-sonnet-4-6", "claude-3-5-sonnet-20241022", "claude-haiku-4-5", "claude-haiku-4-5-20251001", "claude-3-5-haiku-20241022"];
async function callClaude(sys: string, messages: any[], maxTokens: number): Promise<{ txt: string; model?: string; err?: string }> {
  const key = Deno.env.get("ANTHROPIC_API_KEY"); if (!key) return { txt: "", err: "no ANTHROPIC_API_KEY" };
  let lastErr = "none";
  for (const model of MODELS) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify({ model, max_tokens: maxTokens, system: sys, messages }) });
      const j = await res.json();
      const txt = (j && j.content && j.content[0] && j.content[0].text) ? String(j.content[0].text).trim() : "";
      if (txt) return { txt, model };
      const em = (j && j.error && (j.error.message || j.error.type)) ? String(j.error.message || j.error.type) : "no text";
      lastErr = model + ": " + em; if (/authentication|invalid x-api-key|permission|credit|billing/i.test(em)) return { txt: "", err: em };
    } catch (e) { lastErr = model + ": " + String(e); }
  }
  return { txt: "", err: lastErr };
}

/* Proof of identity for a member. ops.html loads session.js, so this arrives on its own. */
async function sessionCode(session: unknown): Promise<string> {
  const v = String(session ?? "").trim().slice(0, 120);
  if (!v) return "";
  const got = await rpc("agent_session_code", { p_token: v });
  return (typeof got === "string") ? norm(got) : "";
}
/* v8 (2026-10-28, Christopher: "Ops assistant needs to be used for all MDs EMDs and Operations").
   Operations: company-wide. A leader (MD, EMD, NVP/SEVP, or a baseshop owner) on their own verified
   session: allowed, but the snapshot is THEIR baseshop(s) via agent_scope() - the hierarchy root and
   the platform builder still get everything. Leaders cannot switch the company-wide automations or
   write to the shared knowledge base; a task a leader asks for is assigned to that leader. */
type BotAuth = { ok: boolean; name: string; ops: boolean; code: string; bases: string[] | null; rank: string };
async function opsAuth(body: any): Promise<BotAuth> {
  const none: BotAuth = { ok: false, name: "", ops: false, code: "", bases: null, rank: "" };
  if (await opsAuthorized(body.token)) return { ok: true, name: clean(body.name) || "Operations", ops: true, code: "OPS", bases: null, rank: "Operations" };
  /* The code is the VERIFIED one, never typed; a seat code is not a credential either. */
  const code = await sessionCode(body.session); if (!code) return none;
  if (/^\d{4}$/.test(code)) return none;
  const bs = await loadKey("baseshops"); const list = (bs && Array.isArray(bs.bases)) ? bs.bases : [];
  const a = (await getJSON(`tracker_agents?code=eq.${encodeURIComponent(code)}&select=first_name,last_name,contract_level&limit=1`))[0];
  const who = a ? `${a.first_name || ""} ${a.last_name || ""}`.trim() : "";
  const owner = list.some((b: any) => norm(b.owner_code) === code);
  const lvl = low(a && a.contract_level);
  const leader = owner || /^(md|emd|nvp|sevp)$/.test(lvl) || /marketing director|national vice|senior executive/.test(lvl);
  if (!leader) return none;
  const sc = await rpc("agent_scope", { p_code: code });
  const all = !!(sc && sc.ok === true && sc.all === true);
  const bases = all ? null : ((sc && Array.isArray(sc.bases)) ? sc.bases.map((x: unknown) => String(x).toUpperCase()) : []);
  return { ok: true, name: who || code, ops: false, code, bases, rank: (a && a.contract_level) || "Leader" };
}

async function snapshot(bases: string[] | null): Promise<string> {
  let [agents, pols, tasks, access] = await Promise.all([
    getJSON(`tracker_agents?select=code,contract_level,license_status,status,baseshop&code=neq.POOL&limit=5000`),
    getJSON(`policies?select=status,annual_premium,expected_commission,agent_code&limit=20000`),
    getJSON(`tasks?select=status,due_date,category,priority&limit=20000`),
    getJSON(`tracker_agents?select=code,baseshop&access_status=eq.pending&code=neq.POOL&limit=5000`),
  ]);
  /* A leader's snapshot is their own baseshop(s): agents, their policies, their pending approvals.
     The Operations task board is not theirs, so it is left out rather than shown company-wide. */
  if (bases) {
    const inB = (b: unknown) => bases.indexOf(String(b || "").toUpperCase()) >= 0;
    const mine = new Set<string>(agents.filter((x: any) => inB(x.baseshop)).map((x: any) => norm(x.code)));
    agents = agents.filter((x: any) => mine.has(norm(x.code)));
    pols = pols.filter((p: any) => mine.has(norm(p.agent_code)));
    access = access.filter((x: any) => inB(x.baseshop));
    tasks = [];
  }
  const active = agents.filter((a: any) => low(a.status) !== "quit");
  const licensed = active.filter((a: any) => { const s = low(a.license_status); return s.includes("licensed") || s.includes("appointed") || s.includes("passed exam"); }).length;
  const lvl: Record<string, number> = {}; active.forEach((a: any) => { const l = norm(a.contract_level) || "(none)"; lvl[l] = (lvl[l] || 0) + 1; });
  const ISSUED = ["policy_issued", "premium_drafted", "paid", "funds_received"];
  const b = (s: string) => { s = low(s); if (["closed", "declined", "cancelled"].includes(s)) return "closed"; if (s === "approved") return "approved"; if (ISSUED.includes(s)) return "issued"; return "pending"; };
  const pc: Record<string, number> = { pending: 0, approved: 0, issued: 0, closed: 0 }; let paidAP = 0, subAP = 0, paidComm = 0;
  pols.forEach((p: any) => { const bk = b(p.status); pc[bk] = (pc[bk] || 0) + 1; if (bk !== "closed") subAP += Number(p.annual_premium) || 0; if (low(p.status) === "paid") { paidAP += Number(p.annual_premium) || 0; paidComm += Number(p.expected_commission) || 0; } });
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
  const openT = tasks.filter((t: any) => t.status === "in_progress" || t.status === "waiting");
  const overdueT = openT.filter((t: any) => t.due_date && t.due_date < today).length;
  const auto = await loadKey("task_automations"); const rules = (auto && auto.rules) || {};
  return [
    `Today (PT): ${today}`,
    `SCOPE: ${bases ? ("baseshop " + (bases.join(", ") || "(none)") + " only") : "whole company"}`,
    `AGENTS: ${active.length} active · ${licensed} licensed · by level: ${Object.entries(lvl).map(([k, v]) => k + " " + v).join(", ")}`,
    `POLICIES: ${pols.length} total · pending ${pc.pending}, approved ${pc.approved}, issued/in-force ${pc.issued}, closed ${pc.closed} · submitted AP ${money(subAP)} · PAID-OUT AP ${money(paidAP)} / est comm ${money(paidComm)}`,
    `PENDING ACCESS APPROVALS: ${access.length}`,
    bases ? `TASKS: (the Operations task board is not included in a leader's snapshot)` : `TASKS: ${openT.length} open · ${overdueT} overdue`,
    `AUTOMATIONS (built-in, toggleable): paidout_thankyou=${rules.paidout_thankyou?.active !== false}, license_sendout=${rules.license_sendout?.active !== false}, net_gear=${rules.net_gear?.active !== false}`,
  ].join("\n");
}

const BASE_KNOWLEDGE = `You are the Operations Assistant for The Standard Financial Group (TSFG / GRIND Agencies), a life-insurance sales agency, embedded in their internal CRM (the "Operations Tracker" at ops.html). You are the behind-the-scenes primary Operations agent: you help Ops staff run the back office, answer how the business + software work, and onboard new Ops hires.

HOW THE BUSINESS WORKS:
- Agents (brokers) get licensed, then write life-insurance & annuity policies. Business is 100% advance commission. Agents progress: Associate → Licensed → Net Licensed (licensed + first production) → Certified Presenter → Certified Field Trainer → Senior Associate → Marketing Director (MD) → Executive Marketing Director (EMD, owns their own baseshop) → National VP.
- Baseshops (nested orgs): STANDARD (root) → SMMT, GRIND, TITANS, SCAPED, ELEVATE. Each EMD owns a baseshop.
- Policies flow: Submitted → Pending → Approved → Policy Issued → Premium Drafted → Paid Out (commissions received). "In Force" = Paid Out only.
- Split business: two agents share a policy; each earns target premium × their contract% × their split share.

THE SOFTWARE (tabs in the Ops Tracker): Licensing, New Business (live policy ledger, two-way synced), Fast Start (onboarding), Licensed & Appointed, In Force (Paid Out), GFI Tickets, Bookings, Field Training, Team Hub. Plus: Access Approvals (approve new agent signups), Roadmap Builder (gamified My Tracker), Tasks (task management + automations + per-task notes), Client Profiles (click a client name).

TASKS & AUTOMATIONS: Tasks link to agents and/or clients, have priority/status/due dates/recurrence/categories, and a NOTES log for backfilling details. Automations auto-create Ops tasks on status transitions: (1) client policy → Paid Out creates "Send thank-you email & update FUB profile"; (2) agent → Fully Licensed & Appointed creates "License send-out is due"; (3) agent → Net Licensed creates "Create flyer & send out gear". They run every 15 min.

YOUR STYLE: Warm, concise, concrete. Give the specific next action. Use the LIVE SNAPSHOT for current numbers. If asked to DO something you can (create a task, toggle an automation), do it via an action block. Never invent data — if you don't have it, say so and point to the right tab. For compliance/comp specifics beyond your data, defer to leadership.

ACTIONS: When (and only when) the user clearly asks you to create a task or change an automation, append EXACTLY ONE fenced action block at the very end of your reply, after your normal text:
\`\`\`action
{"do":"create_task","title":"...","kind":"backoffice|agent|general","priority":"low|medium|high|urgent","category":"...","due_date":"YYYY-MM-DD or empty","recurrence":"|daily|weekly|monthly|quarterly|yearly","agent_codes":[],"client_names":[]}
\`\`\`
or {"do":"toggle_automation","rule":"paidout_thankyou|license_sendout|net_gear","active":true|false}
If no action is needed, do NOT include an action block. Confirm what you did in plain language before the block.`;

async function execAction(a: any, who: string, au: BotAuth): Promise<string> {
  try {
    if (!a || typeof a !== "object") return "";
    if (a.do === "create_task") {
      const row: any = { title: clean(a.title), kind: ["agent", "backoffice", "general"].includes(low(a.kind)) ? low(a.kind) : "general", priority: ["low", "medium", "high", "urgent"].includes(low(a.priority)) ? low(a.priority) : "medium", category: clean(a.category), status: "in_progress", owner_code: au.ops ? "OPS" : au.code, owner_name: au.ops ? "Operations" : who, due_date: clean(a.due_date) || null, recurrence: ["daily", "weekly", "monthly", "quarterly", "yearly"].includes(low(a.recurrence)) ? low(a.recurrence) : "", agent_codes: Array.isArray(a.agent_codes) ? a.agent_codes.map(norm).filter(Boolean) : [], client_names: Array.isArray(a.client_names) ? a.client_names.map((x: any) => clean(x)).filter(Boolean) : [], tags: [], policy_ids: [], notes: [], created_by: "OPSBOT", created_by_name: who, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      if (!row.title) return "⚠️ Could not create the task (no title).";
      const ins = await fetch(`${SUPA}/rest/v1/tasks`, { method: "POST", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify(row) });
      return ins.ok ? `✅ Task created: “${row.title}”` : "⚠️ Failed to create the task.";
    }
    if (a.do === "toggle_automation") {
      if (!au.ops) return "⚠️ Only Operations can switch the company-wide automations.";
      const rule = String(a.rule || ""); if (["paidout_thankyou", "license_sendout", "net_gear"].indexOf(rule) < 0) return "⚠️ Unknown automation.";
      const cfg = (await loadKey("task_automations")) || {}; if (!cfg.rules) cfg.rules = {};
      cfg.rules[rule] = { ...(cfg.rules[rule] || {}), active: !!a.active }; await saveKey("task_automations", cfg);
      return `✅ Automation “${rule}” ${a.active ? "enabled" : "disabled"}.`;
    }
  } catch (_) { /* noop */ }
  return "";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    let body: any = {}; if (req.method === "POST") body = await req.json().catch(() => ({}));
    const action = String(body.action || "ask");
    const au = await opsAuth(body); if (!au.ok) return json({ ok: false, error: "Operations only." }, 401);

    if (action === "get_knowledge") { return json({ ok: true, knowledge: (await loadKey("ops_bot_knowledge")) || "" }); }
    if (action === "add_knowledge") {
      if (!au.ops) return json({ ok: false, error: "Only Operations can add to the shared knowledge base." }, 403);
      const note = clean(body.note); if (!note) return json({ ok: false, error: "empty" });
      const cur = String((await loadKey("ops_bot_knowledge")) || "");
      const stamp = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
      await saveKey("ops_bot_knowledge", (cur ? cur + "\n" : "") + `- (${stamp}, ${au.name}) ${note}`);
      return json({ ok: true });
    }

    if (action === "ask") {
      const q = clean(body.q); if (!q) return json({ ok: false, error: "empty question" });
      const snap = await snapshot(au.bases);
      const learned = String((await loadKey("ops_bot_knowledge")) || "").slice(0, 12000);
      const whoLine = au.ops ? "You are speaking with Operations (company-wide access)." : `You are speaking with ${au.name} (${au.rank}), a team leader. Their snapshot covers ${au.bases ? "their own baseshop only" : "the whole company"}. They cannot switch company-wide automations or edit the shared knowledge base; a task they ask for is assigned to them. Never speculate about other baseshops' people or numbers. Do NOT emit a toggle_automation action for them; if they ask, say only Operations can change automations.`;
      const sys = BASE_KNOWLEDGE + "\n\n=== WHO YOU ARE HELPING ===\n" + whoLine + "\n\n=== LIVE SNAPSHOT ===\n" + snap + (learned ? ("\n\n=== TEAM-TAUGHT KNOWLEDGE (Ops added these) ===\n" + learned) : "");
      const hist = Array.isArray(body.history) ? body.history.slice(-10).map((m: any) => ({ role: (m.role === "assistant" ? "assistant" : "user"), content: clean(m.content) })) : [];
      const messages = hist.concat([{ role: "user", content: q }]);
      const r = await callClaude(sys, messages, 16000);
      if (!r.txt) return json({ ok: false, error: r.err || "no reply", answer: "I couldn't reach my brain just now — try again in a moment." });
      let answer = r.txt; let executed = "";
      const m = /```action\s*([\s\S]*?)```/.exec(r.txt);
      if (m) { answer = r.txt.replace(m[0], "").trim(); try { executed = await execAction(JSON.parse(m[1].trim()), au.name, au); } catch (_) { executed = ""; } }
      /* The model writes its reply BEFORE the server decides. If the action was refused or failed,
         the reply must not claim it happened: replace it with what actually occurred. */
      if (executed.indexOf("⚠️") === 0) { answer = executed.replace(/^⚠️\s*/, "") + " Nothing was changed."; }
      return json({ ok: true, answer, executed, model: r.model });
    }
    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) { return json({ ok: false, error: String(e) }, 500); }
});
