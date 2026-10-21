// hub-api v21 (2026-09-18): #operations is the Operations team's private room — eligible()
// refuses it to every agent, and the bot trigger refuses it to every bot. Business
// notifications (sale alerts, Coach's daily report) now go to the TRAINING channel of the
// baseshop that did the business, instead of #operations where the trigger fanned them out to
// every shop's announcements.
// hub-api v20 (2026-09-03): every Operations check goes through ops_authorize instead of the
// literal "2026" that shipped inside ops.html. This function posts as any bot, edits and
// deletes anyone's messages, and DMs the entire company, so the shared string was the only
// thing standing between the public and the whole Team Hub. Authorised once per request.
// hub-api v24 (2026-09-29): THE MORNING HUDDLE IS GONE. Christopher: "delete anything morning
// huddle related from the platform we no longer do those." Removed from Bob's knowledge answers,
// from Coach's scripted "Stalling" nudge and from the prompt behind Coach's AI replies (which is
// told explicitly not to suggest one, or the model will invent it back). hub_cron's SESSIONS list
// was ALSO two schedule changes behind bots-cron — Phone Zone on Wednesday, Orientation on
// Wed/Thu, no Licensed Agents training — so it is brought in line at the same time.
// hub-api v25 (2026-09-30): WHO IS CALLING, and WHO MAY READ A CHANNEL.
//   v20 fixed the Operations token. What it did not fix is that every OTHER branch answered
//   "who are you?" by reading `body.code` -- and GFI codes are printed on the org chart. So
//   hub_send posted AS anybody under their own name, hub_setavatar and hub_setprofile rewrote
//   anybody's identity card, and hub_edit / hub_delete reached into anybody's messages.
//   Two further gaps, both about READING: hub_list checked nothing but #operations, and a DM
//   channel id is simply the two codes sorted -- so any pair's private conversation could be
//   reconstructed and read. hub_search was worse: it searched EVERY message in the company,
//   DMs included, with no scoping at all, so no id even had to be guessed.
//   Identity now comes from the session token minted when somebody enters their PIN, reading a
//   channel is checked at the moment history is fetched (not just when the sidebar is drawn),
//   and search only ever returns channels the asker may actually open.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
function json(o: unknown, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const clean = (s: unknown) => (s ?? "").toString().trim().slice(0, 4000);
const low = (s: unknown) => (s ?? "").toString().trim().toLowerCase();
const money = (v: unknown) => "$" + (Number(v) || 0).toLocaleString("en-US");
async function rpc(fn: string, args: Record<string, unknown>) { try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); return await r.json(); } catch (_) { return null; } }
async function opsAuthorized(token: unknown) { const t = String(token ?? ""); if (!t) return false; const r = await rpc("ops_authorize", { p_token: t }); return !!(r && r.ok); }
/* Proof of identity. A session token is proof; a typed code is not. */
async function sessionCode(session: unknown): Promise<string> {
  const s = (session ?? "").toString().trim().slice(0, 120);
  if (!s) return "";
  const got = await rpc("agent_session_code", { p_token: s });
  return (typeof got === "string") ? norm(got) : "";
}

/* ===== Live Claude with model fallback (shared by Bob, Coach, advisor, tutor) ===== */
const MODELS = ["claude-haiku-4-5", "claude-haiku-4-5-20251001", "claude-3-5-haiku-20241022", "claude-sonnet-4-6", "claude-3-5-sonnet-20241022", "claude-3-haiku-20240307"];
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

async function agentRow(code: string) {
  const ex = await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${encodeURIComponent(code)}&select=first_name,last_name,emd,md,progress,pct,email,phone,cal_link,title,contract_level,baseshop,direct_to,direct_to_name,last_activity,created_at`, { headers: DBH });
  const r = await ex.json(); return (r && r[0]) ? r[0] : null;
}
async function orgRole(code: string): Promise<string> {
  try {
    const ex = await fetch(`${SUPA}/rest/v1/app_settings?key=eq.org_structure&select=value`, { headers: DBH });
    const rws = await ex.json(); const nodes = (rws && rws[0] && rws[0].value && Array.isArray(rws[0].value.nodes)) ? rws[0].value.nodes : [];
    const n = nodes.find((x: Record<string, unknown>) => norm(x.id) === norm(code) || norm(x.gfi) === norm(code)); return n ? (n.role as string || "agent") : "agent";
  } catch (_) { return "agent"; }
}

const BSCH = [["announcements", "Announcements", "📣"], ["training", "Training", "🎓"], ["licensing", "Licensing", "📝"], ["cft", "CFT Room", "🏵️"]];
async function loadBases(): Promise<{ root: string; bases: Record<string, unknown>[] }> {
  try {
    const ex = await fetch(`${SUPA}/rest/v1/app_settings?key=eq.baseshops&select=value`, { headers: DBH });
    const rws = await ex.json(); const v = (rws && rws[0]) ? rws[0].value : null;
    if (v && Array.isArray(v.bases)) return { root: v.root || "STANDARD", bases: v.bases };
  } catch (_) { /* fall through */ }
  return { root: "STANDARD", bases: [{ name: "STANDARD", owner_code: "GFI20", owner_name: "Elijah Cox", super: true, parent: null }] };
}
function agentLevel(a: Record<string, unknown> | null): string {
  const cl = a && a.contract_level ? String(a.contract_level).toLowerCase() : "";
  if (cl) { if (cl === "emd" || cl.includes("executive")) return "EMD"; if (cl === "md" || (cl.includes("marketing director") && !cl.includes("executive"))) return "MD"; if (cl.includes("senior")) return "Senior Associate"; return "Associate"; }
  const t = a && a.title ? String(a.title) : ""; if (/executive marketing/i.test(t)) return "EMD"; if (/marketing director/i.test(t) && !/executive/i.test(t)) return "MD"; return "Associate";
}
function accessibleBasesOf(baseshop: string, bases: { root: string; bases: Record<string, unknown>[] }): string[] {
  const list = bases.bases || []; const byName: Record<string, Record<string, unknown>> = {}; list.forEach((b) => byName[String(b.name)] = b);
  const root = bases.root || "STANDARD"; const out: string[] = []; const queue: string[] = [baseshop || root]; let g = 0;
  while (queue.length && g++ < 60) { const cur = queue.shift(); if (!cur || out.indexOf(cur) >= 0) continue; out.push(cur); const b = byName[cur]; if (b) { if (b.parent) queue.push(String(b.parent)); if (Array.isArray(b.also)) (b.also as string[]).forEach((x) => queue.push(x)); } }
  if (out.indexOf(root) < 0) out.push(root); return out;
}
function genChannels(bases: { root?: string; bases: Record<string, unknown>[] }) {
  const ch: Record<string, unknown>[] = [
    { id: "main", name: "Company Chat", icon: "💬", scope: "hierarchy" },
    { id: "leadership", name: "Leadership", icon: "👑", scope: "hierarchy" },
    { id: "operations", name: "Operations", icon: "⚙️", scope: "hierarchy" }
  ];
  const root = low(bases.root || "STANDARD");
  for (const bs of (bases.bases || [])) {
    const nm = String(bs.name); const pfx = low(nm);
    if (pfx === root) continue; // STANDARD/root has no base group — Company Chat is the STANDARD chat
    for (const c of BSCH) ch.push({ id: pfx + "_" + c[0], name: nm + " · " + c[1], icon: c[2], baseshop: nm, baseshopName: nm, sub: c[0] });
  }
  return ch;
}
type Acc = { role: string; licensed: boolean; mod: boolean; name: string; baseshop: string; scope: string; owns_base: string; accessibleBases: string[] };
async function accessOf(code: string): Promise<Acc> {
  const a = await agentRow(code); const role = await orgRole(code);
  const prog = (a && a.progress && typeof a.progress === "object") ? a.progress as Record<string, unknown> : {};
  const licensed = !!(prog.w3_reslic || prog.w3_exam || prog.w1_exam);
  const name = a ? (((a.first_name || "") + " " + (a.last_name || "")).trim()) : "";
  const bases = await loadBases(); const list = bases.bases || [];
  const baseshop = (a && a.baseshop) ? String(a.baseshop) : (bases.root || "STANDARD");
  const lvl = agentLevel(a);
  const superOwn = list.find((b) => b.super && norm(b.owner_code) === norm(code));
  const own = list.find((b) => norm(b.owner_code) === norm(code) && !b.super);
  let scope = "member"; if (superOwn) scope = "super"; else if (own || lvl === "MD" || lvl === "EMD") scope = "base_owner";
  const mod = role === "senior" || role === "exec" || scope !== "member";
  const accessibleBases = scope === "super" ? list.map((b) => String(b.name)) : accessibleBasesOf(baseshop, bases);
  return { role, licensed, mod, name, baseshop, scope, owns_base: superOwn ? String(superOwn.name) : (own ? String(own.name) : ""), accessibleBases };
}
function eligible(id: string, acc: Acc, bases: { root?: string; bases: Record<string, unknown>[] }) {
  if (id === "main") return true;
  if (id === "leadership") return acc.mod;
  // #operations is the Operations team's private room. It is served only through hub-ops,
  // which the Operations seats use; no agent, leader or baseshop owner sees it here.
  if (id === "operations") return false;
  const m = /^([a-z0-9]+)_(announcements|training|licensing|cft)$/.exec(id);
  if (m) {
    const pfx = m[1], sub = m[2];
    const base = (bases.bases || []).find((b) => low(b.name) === pfx);
    if (acc.scope !== "super") { if (!base) return false; if ((acc.accessibleBases || []).indexOf(String(base.name)) < 0) return false; }
    if (sub === "cft") return acc.scope === "super" || acc.role === "cft" || acc.role === "trainer" || acc.mod;
    return true;
  }
  return true;
}
function canSeeCustom(c: Record<string, unknown>, code: string, acc: { role: string; mod: boolean; name: string }) {
  if (!c.private) return true;
  if (acc.role === "exec" || acc.mod) return true;
  if (Array.isArray(c.members) && (c.members as string[]).indexOf(code) >= 0) return true;
  if (low(c.by) === low(acc.name)) return true;
  return false;
}
async function customChannels(): Promise<Record<string, unknown>[]> {
  const ex = await fetch(`${SUPA}/rest/v1/app_settings?key=eq.hub_channels&select=value`, { headers: DBH });
  const rws = await ex.json();
  return (rws && rws[0] && Array.isArray(rws[0].value?.channels)) ? rws[0].value.channels : [];
}

const KB = [
  { k: "training live trainings monday tuesday wednesday thursday day1 day2 licensed 6pm", a: "Live trainings, all 6 PM PST on Zoom (ID 9646509994, PW WEALTH): Mon (Team), Tue (Orientation Day 1), Wed (Orientation Day 2), Thu (Licensed Agents Only). Library on Resources.", src: "Resources → Training Library" },
  { k: "licensing license exam prelicensing operations anais appointed", a: "For licensing help, book Operations (Anais): calendly.com/impactagency-ops/licensing, 858-433-4429, impactagency.ops@gmail.com.", src: "Operations line" },
  { k: "carrier carriers rolodex products american national equity north", a: "The carrier rolodex is on the Resources tab.", src: "Resources → Carrier Rolodex" },
  { k: "crm leads follow up marketing plan phone zone", a: "Work your pipeline on the Leads tab / Marketing Plan and the Phone Zone shared pool.", src: "Leads" },
  { k: "comp compensation contract advance commission pay", a: "Your comp is your contract % at the carrier; all business is 100% advance. Log sales in New Business for Expected Commission.", src: "New Business" },
  { k: "new business policy submit sale pipeline in force", a: "Log every submitted app in New Business. It moves Submitted → Pending → Approved → In Force → Closed.", src: "New Business" },
  { k: "promotion senior associate marketing director partners cashflow", a: "Senior Associate = 3 business partners + 3 families helped in 30 days. Marketing Director = 45K paid points + 4 Senior Associates promoted.", src: "My Tracker → Promotion" },
  { k: "book cft field training trainer calendar schedule scheduler", a: "Book a Certified Field Trainer on the Scheduler tab — pick a date, time, and trainer.", src: "Scheduler" }
];
function askKB(q: string) {
  const words = low(q).replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2);
  let best = null as null | typeof KB[0]; let bestScore = 0;
  for (const e of KB) { let sc = 0; for (const w of words) if (e.k.indexOf(w) >= 0) sc++; if (sc > bestScore) { bestScore = sc; best = e; } }
  if (best && bestScore > 0) return { answer: best.a, source: best.src, found: true };
  return { answer: "I don't have a verified answer for that yet. Please reach out to Operations (Anais — 858-433-4429) or your upline.", source: "", found: false };
}
function isQuestion(b: string) { const s = low(b); if (/@quest/.test(s)) return true; if (/\?\s*$/.test(s)) return true; return /^(who|what|whats|when|where|why|how|hows|which|can|could|do|does|did|is|are|am|should|would|will)\b/.test(s); }
async function askAI(q: string) {
  const kb = askKB(q);
  const sys = "You are Bob, the friendly AI teammate for The Standard Financial Group, a life-insurance agency. Answer teammates in under 80 words — accurate, warm, and encouraging. Use this internal knowledge when relevant:\n" + KB.map((e) => "- " + e.a + " (" + e.src + ")").join("\n") + "\nIf you are unsure or it involves compliance, comp specifics, or personal client data, tell them to contact Operations (Anais, 858-433-4429). Never invent facts.";
  const r = await callClaude(sys, q, 300);
  if (r.txt) return { answer: r.txt, source: "Bob · AI", found: true };
  return kb;
}
async function claudeCall(sys: string, prompt: string, maxTokens: number) {
  const r = await callClaude(sys, prompt, maxTokens);
  if (r.txt) return { ok: true, answer: r.txt, found: true, source: "Claude" };
  return { ok: false, answer: "", found: false, error: r.err || "no text returned" };
}
async function askAdvisor(prompt: string) {
  const sys = "You are a senior life-insurance advisor and sales coach for The Standard Financial Group. You are given a client's Personal Financial Review (PFR). Produce a concise, specific analysis in four short labeled sections: (1) What stands out, (2) The biggest gap or opportunity, (3) Recommended strategy — name the product (IUL, FIA, term, or annuity) and why it fits, (4) A short discovery-to-close talk track the advisor can use. Tie every point to the client's actual numbers. Keep it under 280 words, warm and professional. Never invent facts; for exact compliance, comp, or commission questions tell them to contact Operations (Anais, 858-433-4429).";
  return await claudeCall(sys, prompt, 800);
}
async function askTutor(prompt: string) {
  const sys = "You are the AI Training Coach for The Standard Financial Group, a life-insurance agency, embedded in a new-agent training tracker. Help agents with licensing, the BLDRs onboarding (Days 1–4), warm-market prospecting, running a PFR, presenting IUL/FIA/annuity concepts, objection handling, and staying on pace. Be warm, motivating, and concrete — give one clear next action. Under 140 words. Internal facts you can use:\n" + KB.map((e) => "- " + e.a + " (" + e.src + ")").join("\n") + "\nFor exact compliance, comp, or personal client data, tell them to contact Operations (Anais, 858-433-4429). Never invent facts.";
  const r = await claudeCall(sys, prompt, 420);
  if (r.ok) return r;
  return askKB(prompt);
}
async function postHub(channel: string, kind: string, name: string, bodyTxt: string, attach: unknown) {
  const code = kind === "ai" ? "BOB" : kind === "recognition" ? "KEVIN" : kind === "announce" ? "STUART" : "SYS";
  await fetch(`${SUPA}/rest/v1/hub_messages`, { method: "POST", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify({ channel, author_code: code, author_name: name, body: bodyTxt, kind, attach: attach || null, reactions: {} }) });
}

// A business notification belongs to the baseshop that DID the business, in that shop's own
// training room. Previously these were aimed at #operations, where the bot trigger fanned them
// out to every baseshop's announcements — so one shop's sales were announced to all the others.
async function trainingChannelFor(agentCode: string): Promise<string> {
  if (!agentCode) return "";
  const a = await agentRow(norm(agentCode));
  const shop = low(a && a.baseshop);
  if (!shop) return "";
  const bases = await loadBases();
  if (shop === low(bases.root || "STANDARD")) return "";   // the root shop has no channel group
  return shop + "_training";
}

/* ===== Coach · Progression (author_code stays KYLE: it is the DM channel identity key) ===== */
const KYLE_DM = (code: string) => "dm:" + [norm(code), "KYLE"].sort().join("|");
async function postKyle(channel: string, bodyTxt: string) {
  await fetch(`${SUPA}/rest/v1/hub_messages`, { method: "POST", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify({ channel, author_code: "KYLE", author_name: "Coach", body: bodyTxt, kind: "coach", attach: null, reactions: {} }) });
}
function progFromActivity(la: string | null, ca: string | null): { status: string; days: number | null } {
  const base = la || ca;
  if (!base) return { status: "none", days: null };
  const t = new Date(base).getTime(); if (isNaN(t)) return { status: "none", days: null };
  const d = Math.floor((Date.now() - t) / 86400000);
  let s = "green"; if (d <= 7) s = "green"; else if (d <= 14) s = "yellow"; else if (d <= 30) s = "orange"; else s = "red";
  return { status: s, days: d };
}
const SEV: Record<string, { lbl: string; emo: string }> = { yellow: { lbl: "Slowing", emo: "🟡" }, orange: { lbl: "Stalling", emo: "🟠" }, red: { lbl: "Stalled", emo: "🔴" } };
function kyleCoach(first: string, status: string, days: number | null): string {
  const dtxt = days == null ? "a while" : (days + " day" + (days === 1 ? "" : "s"));
  if (status === "yellow") return "📣 Hey " + first + "! Coach here. Your activity's cooled off — it's been " + dtxt + " since your last logged activity, which puts you in 🟡 Slowing. Easy fix: log one dial, one conversation, or book one appointment today and you're back in the green. 💪 Reply here if you want a quick idea.";
  if (status === "orange") return "📣 " + first + ", it's Coach — checking in. You've gone " + dtxt + " without logged activity, so you're in 🟠 Stalling. This is where momentum is won or lost. Knock out ONE thing today: make 5 dials, book a field training, or get on tonight's live training. Reply \"help\" and I'll build you a 20-minute comeback plan.";
  return "📣 " + first + ", Coach here — and I'm not giving up on you. It's been " + dtxt + " with no logged activity, so you're 🔴 Stalled. I've looped your upline in so we can get you unstuck together. One call restarts everything. Reply here or reach out to your leader today — you've got this. 🔴→🟢";
}
async function kyleReply(code: string, q: string): Promise<string> {
  const a = await agentRow(code);
  const first = a ? (((a.first_name || "") as string).toString().trim() || "friend") : "friend";
  const pr = progFromActivity(a ? (a.last_activity as string) : null, a ? (a.created_at as string) : null);
  const stTxt = pr.status === "none" ? "just getting started" : pr.status;
  const sys = "You are Coach, a tough-love progression coach for The Standard Financial Group, a life-insurance sales agency. You throw punch-hugs: warm, direct, and unwilling to let anyone coast. You're DMing " + first + ", whose momentum status is '" + stTxt + "' (" + (pr.days == null ? "no" : pr.days) + " days since last logged activity — green=on track ≤7d, yellow=slowing 8–14d, orange=stalling 15–30d, red=stalled 30d+). Reply in under 90 words: name the gap out loud, give ONE concrete next action — log a dial/conversation/appointment on My Tracker, get on a live training (6 PM PST, Zoom 964 650 9994, PW WEALTH), or book a field training on the Scheduler — and end on a question they have to answer. There is no morning huddle any more; never suggest one. Celebrate them if they're on track. Never invent client or commission facts; for those send them to Operations (Anais, 858-433-4429). Start with 📣.";
  const r = await callClaude(sys, q || "check in with me", 260);
  if (r.txt) return r.txt;
  if (pr.status === "green" || pr.status === "none") return "📣 " + first + ", you're 🟢 on track — love to see it! Keep the streak alive: log today's activity on My Tracker and maybe bring a teammate to the next training. What's your next application?";
  if (isQuestion(q)) { const kb = askKB(q); if (kb.found) return "📣 " + kb.answer + (kb.source ? ("\n📚 " + kb.source) : ""); }
  return kyleCoach(first, pr.status, pr.days);
}

async function recognizePolicy(id: string) {
  const ex = await fetch(`${SUPA}/rest/v1/policies?id=eq.${encodeURIComponent(id)}&select=*`, { headers: DBH });
  const rows = await ex.json(); const p = (rows && rows[0]) ? rows[0] : null;
  if (!p) return { ok: false, error: "policy not found" };
  if (p.recognized) return { ok: true, skipped: true };
  const nm = clean(p.agent_name) || "A teammate"; const agentFirst = nm.split(/\s+/)[0] || nm;
  const cn = clean(p.client_name); const bt = low(p.business_type) === "annuity" ? "annuity" : "life";
  const carrier = clean(p.carrier) || "—"; const product = clean(p.product) || "—";
  const prem = Number(p.annual_premium) || 0;
  const comm = (p.expected_commission !== null && p.expected_commission !== undefined && p.expected_commission !== "") ? Number(p.expected_commission) : null;
  const partnerName = p.split_flag ? clean(p.split_agent) : "";
  const isSplit = !!p.split_flag && !!partnerName;
  let recog: string;
  if (isSplit) {
    const partnerFirst = partnerName.split(/\s+/)[0] || partnerName;
    const sp = (p.split_pct !== null && p.split_pct !== undefined && p.split_pct !== "") ? Math.max(0, Math.min(100, Math.round(Number(p.split_pct)))) : 50;
    const wr = (p.contract_pct !== null && p.contract_pct !== undefined && p.contract_pct !== "") ? Number(p.contract_pct) : null;
    const pr = (p.partner_contract_pct !== null && p.partner_contract_pct !== undefined && p.partner_contract_pct !== "") ? Number(p.partner_contract_pct) : wr;
    const writerPart = (wr != null) ? Math.round(prem * (sp / 100) * (wr / 100)) : null;
    const partnerPart = (pr != null) ? Math.round(prem * ((100 - sp) / 100) * (pr / 100)) : null;
    const commLine = (writerPart != null && partnerPart != null)
      ? ("\n💵 Est. commission — " + agentFirst + ": " + money(writerPart) + " · " + partnerFirst + ": " + money(partnerPart))
      : "";
    recog = "🎉 SALE ALERT — " + nm + " & " + partnerName + " just wrote new business together! 🔥\n🏢 Carrier: " + carrier + "\n📄 Product: " + product + "\n💰 Premium submitted: " + money(prem) + "/yr\n🤝 Split sale — " + agentFirst + " " + sp + "% · " + partnerFirst + " " + (100 - sp) + "%" + commLine + "\nTwo teammates, one protected family 👏 Way to go, " + agentFirst + " & " + partnerFirst + "!";
  } else {
    recog = "🎉 SALE ALERT — " + nm + " just wrote new business! 🔥\n🏢 Carrier: " + carrier + "\n📄 Product: " + product + "\n💰 Premium submitted: " + money(prem) + "/yr" + (comm != null ? ("\n💵 Est. commission to " + agentFirst + ": " + money(comm)) : "") + "\nAnother family protected 👏 Way to go, " + agentFirst + "!";
  }
  await postHub("main", "recognition", "Kevin", recog, null);
  const ops = "🧾 NEW SALE SUBMITTED\n• Agent: " + nm + " (" + (p.agent_code || "—") + ")\n• Client: " + (cn || "—") + (p.state ? (" · " + p.state) : "") + "\n• Type: " + bt + "\n• Carrier: " + carrier + "\n• Product: " + product + "\n• Coverage: " + money(p.coverage) + "\n• Annual Premium: " + money(prem) + (comm != null ? ("\n• Est. Commission: " + money(comm)) : "") + "\n• Status: " + (clean(p.status) || "—") + (p.split_flag ? ("\n• Split with: " + (clean(p.split_agent) || "—")) : "") + "\n• EMD / MD: " + (clean(p.emd) || "—") + " / " + (clean(p.md) || "—") + "\n• Submitted: " + (clean(p.submitted_date) || "—");
  const saleCh = await trainingChannelFor(String(p.agent_code || ""));
  if (saleCh) await postHub(saleCh, "announce", "Sale Alert", ops, { source: "New Business" });
  await fetch(`${SUPA}/rest/v1/policies?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify({ recognized: true }) });
  return { ok: true, recognized: true, agent: nm };
}
const SESSIONS = [
  { d: [1], h: 9, m: 0, t: "Momentum Monday (9 AM) Training", host: "Matthew Welsh", z: "https://zoom.us/j/6199970102", zt: "Zoom 619 997 0102 · Passcode 2026" },
  { d: [1], h: 18, m: 0, t: "Momentum Monday — Team Training", host: "Elijah Cox & Team", z: "https://us02web.zoom.us/j/9646509994?pwd=a2s1OXhzeTB3N3BBOWRkUmw1VHE2Zz09", zt: "Zoom 964 650 9994 · Password WEALTH" },
  { d: [2, 4, 5], h: 6, m: 0, t: "CFT Orientation (Morning)", host: "Christopher Lorenz", z: "https://zoom.us/j/9646509953", zt: "Zoom 964 650 9953" },
  { d: [2], h: 12, m: 0, t: "Phone Zone", host: "Christopher Lorenz", z: "https://zoom.us/j/9646509953", zt: "Zoom 964 650 9953" },
  { d: [4], h: 9, m: 0, t: "Phone Zone", host: "Christopher Lorenz", z: "https://zoom.us/j/9646509953", zt: "Zoom 964 650 9953" },
  { d: [3], h: 17, m: 0, t: "Armed Forces Call", host: "Team", z: "https://zoom.us/j/6806839747", zt: "Zoom 680 683 9747" },
  { d: [2], h: 18, m: 0, t: "Orientation Day 1", host: "Elijah Cox", z: "https://us02web.zoom.us/j/9646509994?pwd=a2s1OXhzeTB3N3BBOWRkUmw1VHE2Zz09", zt: "Zoom 964 650 9994 · Password WEALTH" },
  { d: [3], h: 18, m: 0, t: "Orientation Day 2", host: "Elijah Cox", z: "https://us02web.zoom.us/j/9646509994?pwd=a2s1OXhzeTB3N3BBOWRkUmw1VHE2Zz09", zt: "Zoom 964 650 9994 · Password WEALTH" },
  { d: [4], h: 18, m: 0, t: "Licensed Agents Only Training", host: "Elijah Cox", z: "https://us02web.zoom.us/j/9646509994?pwd=a2s1OXhzeTB3N3BBOWRkUmw1VHE2Zz09", zt: "Zoom 964 650 9994 · Password WEALTH" }
];
function offLabel(b: number) { if (b === 0) return "is LIVE now — join!"; if (b === 60) return "starts in 1 hour"; return "starts in " + b + " minutes"; }
function ptClock() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const gp = (t: string) => { const x = parts.find((p) => p.type === t); return x ? x.value : ""; };
  const wdMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let hh = parseInt(gp("hour"), 10); if (hh === 24) hh = 0;
  return { wd: wdMap[gp("weekday")], hh, mm: parseInt(gp("minute"), 10), date: gp("year") + "-" + gp("month") + "-" + gp("day") };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = new URL(req.url);
    let body: Record<string, unknown> = {};
    if (req.method === "POST") body = await req.json().catch(() => ({}));
    const action = (body.action as string) || url.searchParams.get("action") || "";
    const isAdmin = await opsAuthorized(body.token);

    /* Resolve the caller ONCE, then overwrite body.code with the verified answer. Every check
       further down was already written correctly against `code`; the only thing wrong with them
       was where `code` came from. Doing it here means they all become sound without moving.
       hub_profile is the single exception: there `code` names the person being LOOKED AT, which
       is the roster card everyone in the hub can already see. */
    const CALLER = isAdmin ? "" : await sessionCode(body.session);
    if (!isAdmin) {
      if (!CALLER) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401);
      if (action !== "hub_profile") body.code = CALLER;
      // hub_delete reads `by` as a CODE to claim moderator powers. (hub_createchannel reads `by`
      // as a display NAME, so it is deliberately left alone.)
      if (action === "hub_delete") body.by = CALLER;
      // The code is proven now, but the NAME shown on the message was still whatever the request
      // said. Drop it so it is always looked up from the roster, and the byline matches the author.
      if (action === "hub_send") delete body.author_name;
      if (action === "hub_presence") delete body.name;
    }

    if (action === "hub_policyalert") {
      if (!isAdmin) return json({ ok: false, error: "unauthorized" }, 401);
      const id = clean(body.id); if (!id) return json({ ok: false, error: "no id" });
      return json(await recognizePolicy(id));
    }

    if (action === "hub_access" || action === "hub_channels") {
      const code = norm(body.code || url.searchParams.get("code"));
      const bases = await loadBases();
      const acc: Acc = code ? await accessOf(code) : { role: "agent", licensed: false, mod: false, name: "", baseshop: bases.root, scope: "member", owns_base: "", accessibleBases: [bases.root] };
      const custom = await customChannels();
      const all = genChannels(bases).concat(custom);
      const chans = all.filter((c: Record<string, unknown>) => (c.id as string).indexOf("c_") === 0 ? canSeeCustom(c, code, acc) : eligible(c.id as string, acc, bases));
      const baseshops = (bases.bases || []).filter((b) => low(b.name) !== low(bases.root)).map((b) => ({ id: low(b.name), name: String(b.name), emd: b.owner_name || "" }));
      return json({ ok: true, access: acc, channels: chans, baseshops });
    }

    if (action === "hub_send") {
      const code = norm(body.code); const channel = clean(body.channel) || "main";
      if (!code) return json({ ok: false, error: "missing" });
      if (!isAdmin && channel.indexOf("dm:") !== 0) {
        const acc = await accessOf(code);
        if (channel.indexOf("c_") === 0) {
          const cl = await customChannels(); const cobj = cl.find((x) => x.id === channel);
          if (cobj && !canSeeCustom(cobj, code, acc)) return json({ ok: false, error: "You don't have access to this channel." }, 403);
        } else { const bases = await loadBases(); if (!eligible(channel, acc, bases)) return json({ ok: false, error: "You don't have access to this channel." }, 403); }
      }
      let nm = clean(body.author_name); if (!nm) { const a = await agentRow(code); nm = a ? (((a.first_name || "") + " " + (a.last_name || "")).trim()) : ""; }
      const row: Record<string, unknown> = { channel, author_code: code, author_name: nm, body: clean(body.body), kind: clean(body.kind) || "text", attach: (body.attach && typeof body.attach === "object") ? body.attach : null, reply_to: body.reply_to ? Number(body.reply_to) : null, reactions: {} };
      const ins = await fetch(`${SUPA}/rest/v1/hub_messages`, { method: "POST", headers: { ...DBH, Prefer: "return=representation" }, body: JSON.stringify(row) });
      const r = await ins.json();
      const inserted = Array.isArray(r) ? r[0] : r;
      let bot = null;
      if (row.kind === "text" && channel.indexOf("dm:") === 0 && channel.toUpperCase().indexOf("KYLE") >= 0 && row.author_code !== "KYLE") {
        const rep = await kyleReply(code, String(row.body || ""));
        const krow: Record<string, unknown> = { channel, author_code: "KYLE", author_name: "Coach", body: rep, kind: "coach", attach: null, reactions: {} };
        const bi = await fetch(`${SUPA}/rest/v1/hub_messages`, { method: "POST", headers: { ...DBH, Prefer: "return=representation" }, body: JSON.stringify(krow) });
        const br = await bi.json(); bot = Array.isArray(br) ? br[0] : br;
      } else if (row.kind === "text" && channel.indexOf("dm:") !== 0 && isQuestion(String(row.body || ""))) {
        const qq = String(row.body || "").replace(/@quest[a-z]*/ig, "").trim();
        const ans = await askAI(qq);
        const brow: Record<string, unknown> = { channel, author_code: "BOB", author_name: "Bob", body: ans.answer, kind: "ai", attach: ans.source ? { source: ans.source } : null, reactions: {} };
        const bi = await fetch(`${SUPA}/rest/v1/hub_messages`, { method: "POST", headers: { ...DBH, Prefer: "return=representation" }, body: JSON.stringify(brow) });
        const br = await bi.json(); bot = Array.isArray(br) ? br[0] : br;
      }
      return json({ ok: ins.ok, message: inserted, bot });
    }

    if (action === "hub_list") {
      const channel = clean(body.channel || url.searchParams.get("channel")) || "main";
      // hub_list has never checked access: knowing a channel id was enough to read its history,
      // so hiding #operations in the sidebar would not actually have made it private. The
      // Operations seats reach the hub with an Operations token (teamhub's h() adds it in ops
      // mode), so that token is exactly the line between them and everybody else.
      if (channel === "operations" && !isAdmin) return json({ ok: true, messages: [] });
      /* ...and knowing any OTHER channel id was still enough. A DM id is just the two codes
         sorted, both printed on the org chart, so anyone could rebuild a colleague's private
         conversation. Private custom channels had the same shape of gap: eligible() and
         canSeeCustom() decided what appeared in the SIDEBAR, and nothing re-checked when the
         history itself was fetched. */
      if (!isAdmin) {
        if (channel.indexOf("dm:") === 0) {
          const parts = channel.slice(3).split("|").map((x) => norm(x));
          if (parts.indexOf(norm(CALLER)) < 0) return json({ ok: false, error: "That conversation is not yours." }, 403);
        } else {
          const cbases = await loadBases();
          const cacc = await accessOf(CALLER);
          if (!eligible(channel, cacc, cbases)) return json({ ok: false, error: "You do not have access to that channel." }, 403);
          if (channel.indexOf("c_") === 0) {
            const cust = (await customChannels()).find((c) => String(c.id) === channel);
            if (cust && !canSeeCustom(cust, norm(CALLER), cacc)) return json({ ok: false, error: "That channel is private." }, 403);
          }
        }
      }
      const after = Number(body.after || url.searchParams.get("after")) || 0;
      let q = `${SUPA}/rest/v1/hub_messages?channel=eq.${encodeURIComponent(channel)}&order=id.asc`;
      if (after > 0) q += `&id=gt.${after}`; else q += `&limit=500`;
      const ex = await fetch(q, { headers: DBH });
      return json({ ok: true, messages: (await ex.json()) || [] });
    }

    if (action === "hub_react") {
      const id = Number(body.id); const code = norm(body.code); const emoji = clean(body.emoji).slice(0, 8);
      if (!id || !code || !emoji) return json({ ok: false, error: "missing" });
      const ex = await fetch(`${SUPA}/rest/v1/hub_messages?id=eq.${id}&select=reactions`, { headers: DBH });
      const rows = await ex.json(); if (!rows || !rows[0]) return json({ ok: false, error: "not found" });
      const rx = (rows[0].reactions && typeof rows[0].reactions === "object") ? rows[0].reactions : {};
      const arr: string[] = Array.isArray(rx[emoji]) ? rx[emoji] : [];
      const i = arr.indexOf(code); if (i >= 0) arr.splice(i, 1); else arr.push(code);
      if (arr.length) rx[emoji] = arr; else delete rx[emoji];
      const up = await fetch(`${SUPA}/rest/v1/hub_messages?id=eq.${id}`, { method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify({ reactions: rx }) });
      return json({ ok: up.ok, reactions: rx });
    }

    if (action === "hub_edit") {
      const id = Number(body.id); const code = norm(body.code);
      if (!id) return json({ ok: false, error: "no id" });
      let q = `${SUPA}/rest/v1/hub_messages?id=eq.${id}`;
      if (!isAdmin) q += `&author_code=eq.${encodeURIComponent(code)}`;
      const up = await fetch(q, { method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify({ body: clean(body.body), edited: true }) });
      return json({ ok: up.ok });
    }

    if (action === "hub_delete") {
      const id = Number(body.id); const code = norm(body.code); const by = norm(body.by);
      if (!id) return json({ ok: false, error: "no id" });
      let modOk = isAdmin;
      if (!modOk && by) { const acc = await accessOf(by); modOk = acc.mod; }
      let q = `${SUPA}/rest/v1/hub_messages?id=eq.${id}`;
      if (!modOk) q += `&author_code=eq.${encodeURIComponent(code)}`;
      const up = await fetch(q, { method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify({ deleted: true, body: "", attach: null }) });
      return json({ ok: up.ok });
    }

    if (action === "hub_presence") {
      const code = norm(body.code); const channel = clean(body.channel) || ""; const status = (low(body.status) === "away") ? "away" : "active";
      if (code) { let nm = clean(body.name); if (!nm) { const a = await agentRow(code); nm = a ? (((a.first_name || "") + " " + (a.last_name || "")).trim()) : ""; } await fetch(`${SUPA}/rest/v1/hub_presence?on_conflict=code`, { method: "POST", headers: { ...DBH, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ code, name: nm, channel, status, last_seen: new Date().toISOString() }) }); }
      const cut = new Date(Date.now() - 90000).toISOString();
      const ex = await fetch(`${SUPA}/rest/v1/hub_presence?last_seen=gte.${encodeURIComponent(cut)}&select=code,name,channel,status,last_seen`, { headers: DBH });
      return json({ ok: true, online: (await ex.json()) || [] });
    }

    if (action === "hub_setavatar") {
      const code = norm(body.code); const urlv = (body.url ?? "").toString();
      if (!code || !urlv) return json({ ok: false, error: "missing" });
      if (urlv.length > 900000) return json({ ok: false, error: "image too large" });
      const up = await fetch(`${SUPA}/rest/v1/hub_avatars?on_conflict=code`, { method: "POST", headers: { ...DBH, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ code, url: urlv, updated_at: new Date().toISOString() }) });
      return json({ ok: up.ok });
    }
    if (action === "hub_avatars") {
      const ex = await fetch(`${SUPA}/rest/v1/hub_avatars?select=code,url`, { headers: DBH });
      const rows = (await ex.json()) || [];
      const map: Record<string, string> = {}; for (const r of rows) map[r.code] = r.url;
      return json({ ok: true, avatars: map });
    }

    if (action === "hub_profile") {
      const code = norm(body.code || url.searchParams.get("code"));
      if (!code) return json({ ok: false, error: "no code" });
      const a = await agentRow(code); const acc = await accessOf(code);
      const pex = await fetch(`${SUPA}/rest/v1/hub_presence?code=eq.${encodeURIComponent(code)}&select=last_seen,status,channel`, { headers: DBH });
      const prow = ((await pex.json()) || [])[0] || null;
      return json({ ok: true, profile: { code, name: acc.name, email: (a && a.email) || "", phone: (a && a.phone) || "", cal_link: (a && a.cal_link) || "", title: (a && a.title) || "", direct_to: (a && a.direct_to) || "", direct_to_name: (a && a.direct_to_name) || "", role: acc.role, baseshop: acc.baseshop, last_seen: prow ? prow.last_seen : "", pres_status: prow ? prow.status : "", pres_channel: prow ? prow.channel : "" } });
    }

    if (action === "hub_setprofile") {
      const code = norm(body.code);
      if (!code) return json({ ok: false, error: "no code" });
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (typeof body.email === "string") patch.email = clean(body.email);
      if (typeof body.phone === "string") patch.phone = clean(body.phone);
      if (typeof body.cal_link === "string") patch.cal_link = clean(body.cal_link);
      if (typeof body.title === "string") patch.title = clean(body.title);
      /* direct_to IS the org tree — it is the single source of truth the whole hierarchy is
         computed from, and who your upline is is not a contact detail you set about yourself.
         An agent editing their own contact card could re-parent themselves under anyone. Upline
         changes belong to org-api set_upline, which is Operations/EMD only. */
      if (isAdmin) {
        if (typeof body.direct_to === "string") patch.direct_to = norm(body.direct_to);
        if (typeof body.direct_to_name === "string") patch.direct_to_name = clean(body.direct_to_name);
      }
      const up = await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${encodeURIComponent(code)}`, { method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify(patch) });
      return json({ ok: up.ok, code });
    }

    if (action === "hub_roster") {
      const ex = await fetch(`${SUPA}/rest/v1/tracker_agents?select=code,first_name,last_name,direct_to,direct_to_name,md,emd,status,title,baseshop&code=neq.POOL&order=first_name.asc`, { headers: DBH });
      const rows = (await ex.json()) || [];
      const members = rows.filter((r: Record<string, unknown>) => (r.status || "active") !== "quit").map((r: Record<string, unknown>) => ({ code: r.code, name: (((r.first_name as string) || "") + " " + ((r.last_name as string) || "")).trim(), direct_to: r.direct_to || "", direct_to_name: r.direct_to_name || "", md: r.md || "", emd: r.emd || "", title: r.title || "", baseshop: r.baseshop || "" }));
      return json({ ok: true, count: members.length, members });
    }

    if (action === "hub_createchannel") {
      const name = clean(body.name); if (!name) return json({ ok: false, error: "no name" });
      const byCode = norm(body.code);
      // `by` is the creator's display name, and it used to be whatever the request typed.
      const by = isAdmin ? clean(body.by) : ((await accessOf(byCode)).name || clean(body.by));
      const id = "c_" + low(name).replace(/[^a-z0-9]+/g, "_").slice(0, 24) + "_" + Math.random().toString(36).slice(2, 6);
      const priv = !!body.private;
      let members: string[] = Array.isArray(body.members) ? (body.members as unknown[]).map((x) => norm(x)).filter(Boolean) : [];
      if (byCode && members.indexOf(byCode) < 0) members.push(byCode);
      const ex = await fetch(`${SUPA}/rest/v1/app_settings?key=eq.hub_channels&select=value`, { headers: DBH });
      const rws = await ex.json();
      const v = (rws && rws[0] && rws[0].value) ? rws[0].value : { channels: [] };
      if (!Array.isArray(v.channels)) v.channels = [];
      v.channels.push({ id, name, icon: priv ? "🔒" : "📌", by, byCode, private: priv, members });
      const up = await fetch(`${SUPA}/rest/v1/app_settings?on_conflict=key`, { method: "POST", headers: { ...DBH, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key: "hub_channels", value: v, updated_at: new Date().toISOString() }) });
      return json({ ok: up.ok, id, private: priv, members });
    }

    if (action === "hub_deletechannel") {
      const id = clean(body.id); const byCode = norm(body.code);
      if (!id || id.indexOf("c_") !== 0) return json({ ok: false, error: "only custom channels can be deleted" });
      const ex = await fetch(`${SUPA}/rest/v1/app_settings?key=eq.hub_channels&select=value`, { headers: DBH });
      const rws = await ex.json();
      const v = (rws && rws[0] && rws[0].value) ? rws[0].value : { channels: [] };
      const list: Record<string, unknown>[] = Array.isArray(v.channels) ? v.channels : [];
      const cobj = list.find((x) => x.id === id);
      if (!cobj) return json({ ok: false, error: "channel not found" });
      let allowed = isAdmin || norm(cobj.byCode) === byCode;
      if (!allowed && byCode) { const acc = await accessOf(byCode); allowed = acc.mod; }
      if (!allowed) return json({ ok: false, error: "Only the creator or a moderator can delete this channel." }, 403);
      v.channels = list.filter((x) => x.id !== id);
      await fetch(`${SUPA}/rest/v1/app_settings?on_conflict=key`, { method: "POST", headers: { ...DBH, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key: "hub_channels", value: v, updated_at: new Date().toISOString() }) });
      await fetch(`${SUPA}/rest/v1/hub_messages?channel=eq.${encodeURIComponent(id)}`, { method: "DELETE", headers: { ...DBH, Prefer: "return=minimal" } });
      return json({ ok: true, id });
    }

    if (action === "hub_ask") { return json({ ok: true, ...(await askAI(clean(body.q))) }); }
    if (action === "pfr_ai") { return json(await askAdvisor(clean(body.prompt || body.q))); }
    if (action === "hub_tutor") { return json({ ok: true, ...(await askTutor(clean(body.q || body.prompt))) }); }
    if (action === "ai_ping") { const r = await claudeCall("Reply with exactly: OK", "ping", 12); return json(r); }

    if (action === "hub_search") {
      const term = low(body.q || url.searchParams.get("q"));
      if (!term) return json({ ok: true, messages: [] });
      // Search wide, then keep only what this person could have opened for themselves. Without
      // this, one search read every private message in the company.
      const ex = await fetch(`${SUPA}/rest/v1/hub_messages?body=ilike.*${encodeURIComponent(term)}*&deleted=eq.false&order=id.desc&limit=400`, { headers: DBH });
      let hits: Record<string, unknown>[] = (await ex.json()) || [];
      if (!isAdmin) {
        const sbases = await loadBases();
        const sacc = await accessOf(CALLER);
        const scust = await customChannels();
        const me = norm(CALLER);
        hits = hits.filter((m) => {
          const ch = String(m.channel || "");
          if (ch.indexOf("dm:") === 0) return ch.slice(3).split("|").map((x) => norm(x)).indexOf(me) >= 0;
          if (ch === "operations") return false;
          if (!eligible(ch, sacc, sbases)) return false;
          if (ch.indexOf("c_") === 0) {
            const c = scust.find((x) => String(x.id) === ch);
            if (c && !canSeeCustom(c, me, sacc)) return false;
          }
          return true;
        });
      }
      return json({ ok: true, messages: hits.slice(0, 40) });
    }

    if (action === "hub_kyle") {
      if (!isAdmin) return json({ ok: false, error: "unauthorized" }, 401);
      const clk = ptClock(); const date = clk.date;
      const lex = await fetch(`${SUPA}/rest/v1/app_settings?key=eq.kyle_log&select=value`, { headers: DBH });
      const lrows = await lex.json(); let log: string[] = (lrows && lrows[0] && Array.isArray(lrows[0].value?.keys)) ? lrows[0].value.keys : [];
      const ex = await fetch(`${SUPA}/rest/v1/tracker_agents?select=code,first_name,last_name,md,emd,direct_to,baseshop,last_activity,created_at,status&code=neq.POOL`, { headers: DBH });
      const rows = (await ex.json()) || [];
      const active = rows.filter((r: Record<string, unknown>) => (r.status || "active") !== "quit");
      const nameCode: Record<string, string> = {};
      for (const r of active) { const nm = (((r.first_name as string) || "") + " " + ((r.last_name as string) || "")).trim().toLowerCase(); if (nm) nameCode[nm] = r.code as string; }
      type Aff = { code: string; first: string; name: string; status: string; days: number | null; md: string; emd: string; shop: string };
      const affected: Aff[] = [];
      for (const r of active) {
        const pr = progFromActivity(r.last_activity as string, r.created_at as string);
        if (pr.status === "green" || pr.status === "none") continue;
        affected.push({ code: r.code as string, first: (((r.first_name as string) || "").trim() || (r.code as string)), name: (((r.first_name as string) || "") + " " + ((r.last_name as string) || "")).trim(), status: pr.status, days: pr.days, md: ((r.md as string) || "").trim(), emd: ((r.emd as string) || "").trim(), shop: low(r.baseshop) });
      }
      const preview = !!body.preview;
      const posted = { agents: 0, uplines: 0, ops: 0 };
      const sevOrder: Record<string, number> = { red: 0, orange: 1, yellow: 2 };
      for (const ag of affected) {
        const k = "A|" + date + "|" + ag.code; if (log.indexOf(k) >= 0) continue;
        if (!preview) { await postKyle(KYLE_DM(ag.code), kyleCoach(ag.first, ag.status, ag.days)); log.push(k); }
        posted.agents++;
      }
      const leaders: Record<string, Aff[]> = {};
      for (const ag of affected) {
        const ups = new Set<string>();
        for (const nm of [ag.md, ag.emd]) { if (!nm) continue; const c = nameCode[nm.toLowerCase()]; if (c && c !== ag.code) ups.add(c); }
        for (const uc of ups) { (leaders[uc] = leaders[uc] || []).push(ag); }
      }
      for (const uc of Object.keys(leaders)) {
        const k = "U|" + date + "|" + uc; if (log.indexOf(k) >= 0) continue;
        const lead = active.find((r: Record<string, unknown>) => r.code === uc);
        const lf = lead ? (((lead.first_name as string) || "").trim() || uc) : uc;
        const list = leaders[uc].slice().sort((a, b) => sevOrder[a.status] - sevOrder[b.status]);
        const lines = list.map((a) => SEV[a.status].emo + " " + SEV[a.status].lbl + ": " + a.name + " (" + a.code + (a.days != null ? ", " + a.days + "d" : "") + ")").join("\n");
        const msg = "📣 Coach · Downline Momentum Alert (" + date + ")\n" + lf + ", these teammates under you need a nudge today:\n" + lines + "\n\nA 2-minute check-in from you moves the needle more than anything. I've already DM'd each of them directly.";
        if (!preview) { await postKyle(KYLE_DM(uc), msg); log.push(k); }
        posted.uplines++;
      }
      // The daily report is split by baseshop and posted into each shop's own training room,
      // so a leader sees the people who are actually theirs instead of the whole company.
      const byShop: Record<string, Aff[]> = {};
      for (const ag of affected) { if (ag.shop) (byShop[ag.shop] = byShop[ag.shop] || []).push(ag); }
      const rootShop = low((await loadBases()).root || "STANDARD");
      for (const shop of Object.keys(byShop)) {
        if (shop === rootShop) continue;
        const ko = "O|" + date + "|" + shop; if (log.indexOf(ko) >= 0) continue;
        const mine = byShop[shop];
        const cnt: Record<string, number> = { yellow: 0, orange: 0, red: 0 }; mine.forEach((a) => cnt[a.status]++);
        const stalled = mine.filter((a) => a.status === "red").sort((a, b) => (b.days || 0) - (a.days || 0));
        const sl = stalled.length ? stalled.map((a) => "🔴 " + a.name + " (" + a.code + (a.days != null ? ", " + a.days + "d" : "") + ")").join("\n") : "None 🎉";
        const msg = "📣 Coach · Daily Progression Report (" + date + ")\n🟡 Slowing: " + cnt.yellow + "   🟠 Stalling: " + cnt.orange + "   🔴 Stalled: " + cnt.red + "\n\nStalled — need a leadership touch:\n" + sl + "\n\nEvery agent above + their full upline has been DM'd by Coach.";
        if (!preview) { await postKyle(shop + "_training", msg); log.push(ko); }
        posted.ops++;
      }
      if (!preview && (posted.agents || posted.uplines || posted.ops)) {
        if (log.length > 1500) log = log.slice(log.length - 1500);
        await fetch(`${SUPA}/rest/v1/app_settings?on_conflict=key`, { method: "POST", headers: { ...DBH, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key: "kyle_log", value: { keys: log }, updated_at: new Date().toISOString() }) });
      }
      return json({ ok: true, at: date, affected: affected.length, buckets: { yellow: affected.filter(a => a.status === "yellow").length, orange: affected.filter(a => a.status === "orange").length, red: affected.filter(a => a.status === "red").length }, posted, preview });
    }

    if (action === "hub_cron") {
      if (!isAdmin) return json({ ok: false, error: "unauthorized" }, 401);
      const clk = ptClock(); const nowMin = clk.hh * 60 + clk.mm;
      if (body.preview) {
        let best: Record<string, unknown> | null = null; let bestDelta = 1e9;
        for (let off = 0; off <= 7; off++) { const wd = (clk.wd + off) % 7; for (const s of SESSIONS) { if (s.d.indexOf(wd) < 0) continue; const delta = off * 1440 + (s.h * 60 + s.m) - nowMin; if (delta > 0 && delta < bestDelta) { bestDelta = delta; best = s; } } }
        if (!best) return json({ ok: true, preview: null });
        const hrs = Math.floor(bestDelta / 60), mins = bestDelta % 60;
        const when = bestDelta < 60 ? ("in " + bestDelta + " min") : ("in " + hrs + "h" + (mins ? (" " + mins + "m") : ""));
        const bt = "📣 [Preview] " + best.t + " — next up " + when + "!\nHost: " + best.host + "\n🎥 Join Zoom: " + best.z + "\n" + best.zt + "\n\nStuart announces at 1 hour, 30 min, 10 min, and the moment it's live. 🔥";
        await postHub("main", "announce", "Stuart", bt, { source: "Team Calendar" });
        return json({ ok: true, preview: best.t, when });
      }
      const lex = await fetch(`${SUPA}/rest/v1/app_settings?key=eq.hub_announce_log&select=value`, { headers: DBH });
      const lrows = await lex.json(); let log: string[] = (lrows && lrows[0] && Array.isArray(lrows[0].value?.keys)) ? lrows[0].value.keys : [];
      const posted: string[] = [];
      const OFFS = [60, 30, 10, 0];
      for (const s of SESSIONS) {
        if (s.d.indexOf(clk.wd) < 0) continue;
        const delta = (s.h * 60 + s.m) - nowMin;
        let bucket = -1; for (const o of OFFS) { if (Math.abs(delta - o) <= 2) { bucket = o; break; } }
        if (bucket < 0) continue;
        const key = clk.date + "|" + s.t + "|" + bucket; if (log.indexOf(key) >= 0) continue;
        const cta = bucket === 0 ? "It's LIVE — jump on now! 🔴" : "Jump on and bring a teammate — let's fill the room! 🔥";
        const bodyTxt = "📣 " + s.t + " " + offLabel(bucket) + "!\nHost: " + s.host + "\n🎥 Join Zoom: " + s.z + "\n" + s.zt + "\n\n" + cta;
        await postHub("main", "announce", "Stuart", bodyTxt, { source: "Team Calendar" });
        log.push(key); posted.push(key);
      }
      if (posted.length) { if (log.length > 400) log = log.slice(log.length - 400); await fetch(`${SUPA}/rest/v1/app_settings?on_conflict=key`, { method: "POST", headers: { ...DBH, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key: "hub_announce_log", value: { keys: log }, updated_at: new Date().toISOString() }) }); }
      return json({ ok: true, at: clk.date + " " + clk.hh + ":" + (clk.mm < 10 ? "0" + clk.mm : clk.mm) + " PT (wd" + clk.wd + ")", posted });
    }

    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
