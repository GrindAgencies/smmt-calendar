// hub-api v31 (2026-10-26): WHICH OPERATIONS SEAT OVERSEES WHICH PRIVATE ROOM. Owner decision:
//   private groups and DMs are overseen by the master Operations seats (0000 Anais, C1991 the
//   builder) everywhere, and by a per-baseshop Operations seat ONLY for its own shop(s). Until now
//   every Ops token -- including TITANS's or SCAPED's seat -- opened every private group and every
//   DM in the company. A private group belongs to its creator's (byCode) baseshop; a DM to the
//   baseshops of its two people (either one in the seat's shops is enough). Open rooms,
//   announcements and #operations are unchanged, and machine/legacy tokens keep full reach.
//   One rule, opsOversight(), now gates hub_access/hub_channels, hub_list, hub_search, hub_send,
//   hub_edit, hub_delete, hub_react and hub_deletechannel for an Ops caller.
// hub-api v30 (2026-10-26): AUDIT FOLLOW-UPS.
//   · canSeeCustom no longer lets a display-name match open a private group: two people can
//     share a name, and `by` was once whatever the request typed. byCode (checked in prod: every
//     c_ group carries one) and the members list are the only keys.
//   · @ops/@operations in hub_send obeys hub_escalate's cap (5 open per person) and at most one
//     escalation per person per group per 10 minutes - typing it twice must not page Ops twice.
//   · hub_react checks the caller may read the message's room. Reacting to a message id in a DM
//     or private group you are not in used to work, and echoed back its reactions.
//   · hub_setprofile: `title` is leadership rank and is no longer self-assigned (Ops only), and
//     cal_link gets profile-api save_contact's Calendly validation.
//   · mayModerate: a designated group admin of a PRIVATE group must still be a member of it.
//   · hub_deletechannel removes the group through the locked hub_channel_remove RPC instead of
//     rewriting the whole registry blob, which could drop a group created in the same moment.
// hub-api v28 (2026-10-26): hub_profile gave anyone signed in another person's email, phone and
//   booking link across every baseshop. Contact details now come back only when the person is in
//   the caller's own baseshop scope (agent_scope) or is the caller; Operations sees all. Name,
//   title, baseshop and presence are unchanged - the directory still works company-wide.
// hub-api v27 (2026-10-26): WHO MAY SEE AND MODERATE WHAT. Christopher: "private groups are
//   only to be moderated by those involved and Operations ... only if there is a question or
//   contestation should she be pinged on a private group message. also those MDs can only
//   moderate their own baseshop."
//   · A private group is visible to its members and creator only (Operations reaches every room
//     through its own token). Being an MD/EMD/exec no longer opens other people's private groups.
//   · Moderation (removing someone else's message, deleting a group) is decided per ROOM by
//     mayModerate(): private group -> its creator and designated admins (and Ops); open group ->
//     those, plus leaders of the creator's own baseshop; a baseshop room -> that shop's leaders;
//     company-wide rooms -> the company-wide (super) seats. Previously any MD could remove any
//     message anywhere.
//   · hub_escalate: a private-group member asks Operations to look (question / dispute). It is
//     recorded in hub_escalations and posted to #operations by the Help Desk bot. Typing
//     @Operations in a private group does the same. Nothing else in a private group reaches Ops.
// hub-api v26 (2026-10-26): Operations is answered with EVERY channel by hub_access/hub_channels
// (see that branch), so the Operations seat can open, moderate and attach files in every room.
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
/* v31: what an Operations token reaches. `full` = the master seats (0000, C1991) and every
   non-session token (cron/machine, legacy) - exactly what every Ops token used to get. A
   per-baseshop seat gets its shops, widened through baseshop groups by ops_scope the same way
   pin's lockAuthority does. ops_scope failing leaves `bases` empty: fail closed, not open. */
type OpsReach = { ok: boolean; full: boolean; bases: string[]; seat: string };
async function opsReach(token: unknown): Promise<OpsReach> {
  const t = String(token ?? ""); const none = { ok: false, full: false, bases: [], seat: "" };
  if (!t) return none;
  const r = await rpc("ops_authorize", { p_token: t });
  if (!(r && r.ok)) return none;
  const seat = norm(r.code);
  if (r.master === true || r.via !== "session") return { ok: true, full: true, bases: [], seat };
  const sc = await rpc("ops_scope", { p_token: t });
  if (sc && sc.seat && !sc.scoped) return { ok: true, full: true, bases: [], seat };
  const bases: string[] = Array.isArray(sc?.bases) ? sc.bases.map((b: unknown) => norm(b)).filter(Boolean) : [];
  return { ok: true, full: false, bases, seat };
}
/* v31: may this Operations caller oversee this room? Only private groups and DMs are limited;
   every other room answers true, as before. Registry and roster are read lazily and once per
   request, so a list (search, channels) costs two queries, not one per row. */
function opsOversight(reach: OpsReach) {
  let custom: Record<string, unknown>[] | null = null;
  let shops: Map<string, string> | null = null;
  const shopOf = async (code: unknown): Promise<string> => {
    if (!shops) {
      shops = new Map();
      try {
        const ex = await fetch(`${SUPA}/rest/v1/tracker_agents?select=code,baseshop&limit=10000`, { headers: DBH });
        for (const a of ((await ex.json()) || []) as Record<string, unknown>[]) shops.set(norm(a.code), norm(a.baseshop));
      } catch (_) { /* empty roster -> nothing private is in reach */ }
    }
    return shops.get(norm(code)) || "";
  };
  return async (channel: string): Promise<boolean> => {
    if (!reach.ok) return false;
    if (reach.full) return true;
    if (channel.indexOf("dm:") === 0) {
      for (const p of channel.slice(3).split("|")) { const b = await shopOf(p); if (b && reach.bases.indexOf(b) >= 0) return true; }
      return false;
    }
    if (channel.indexOf("c_") === 0) {
      if (!custom) custom = await customChannels();
      const c = custom.find((x) => String(x.id) === channel);
      if (!c || !c.private) return true;
      // A group the seat itself created is the seat's, whatever shop that maps to.
      const by = norm(c.byCode);
      if (by && (by === reach.seat || by === "OPS:" + reach.seat)) return true;
      const b = by ? await shopOf(by) : "";
      return !!b && reach.bases.indexOf(b) >= 0;
    }
    return true;
  };
}
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
  /* v27: private means the people in it. Rank (MD/EMD/exec) is no longer a key to someone
     else's private group; Operations reads every room through its own token instead. */
  if (code && norm(c.byCode) === norm(code)) return true;
  if (Array.isArray(c.members) && (c.members as string[]).map((x) => norm(x)).indexOf(norm(code)) >= 0) return true;
  /* v30: no display-name match. `by` is a name, names repeat, and an Ops-created group carries
     whatever name was typed - so it could open a private group to a stranger who shares it. */
  return false;
}
/* The shops a leader moderates: their own baseshop, any shop they own, and every shop beneath
   those. NOT the parents above them - "MDs can only moderate their own baseshop". */
function ownShops(acc: Acc, bases: { root: string; bases: Record<string, unknown>[] }): string[] {
  const list = bases.bases || [];
  const out = new Set<string>();
  [acc.baseshop, acc.owns_base].filter(Boolean).forEach((b) => out.add(norm(b)));
  let grew = true, guard = 0;
  while (grew && guard++ < 20) {
    grew = false;
    for (const b of list) { const n = norm(b.name), par = norm(b.parent); if (par && out.has(par) && !out.has(n)) { out.add(n); grew = true; } }
  }
  out.delete(norm(bases.root || "STANDARD"));     // the root is company-wide, not a shop to moderate
  return Array.from(out);
}
async function isDesignatedGroupAdmin(code: string, channel: string): Promise<boolean> {
  if (!code || !channel) return false;
  try {
    const ex = await fetch(`${SUPA}/rest/v1/hub_group_admins?channel=eq.${encodeURIComponent(channel)}&code=eq.${encodeURIComponent(code)}&select=code&limit=1`, { headers: DBH });
    const r = await ex.json(); return Array.isArray(r) && r.length > 0;
  } catch (_) { return false; }
}
/* May this person remove other people's messages in this room? (Their own is always allowed.)
   Operations is decided by the caller before this is asked. */
async function mayModerate(code: string, acc: Acc, channel: string, bases: { root: string; bases: Record<string, unknown>[] }, custom?: Record<string, unknown>[]): Promise<boolean> {
  if (!code || !channel || channel.indexOf("dm:") === 0) return false;
  if (channel.indexOf("c_") === 0) {
    const c = (custom || await customChannels()).find((x) => x.id === channel);
    if (!c) return false;
    if (norm(c.byCode) === norm(code)) return true;
    /* v30: a designated admin of a private group moderates it only while still in it. Taking
       someone out of the group takes away the room; it must take away the gavel too. */
    if (await isDesignatedGroupAdmin(norm(code), channel) && (!c.private || canSeeCustom(c, code, acc))) return true;
    if (c.private) return false;                    // those involved, and Operations. Nobody else.
    if (acc.scope === "super") return true;
    if (!acc.mod) return false;
    const creator = c.byCode ? await agentRow(norm(c.byCode)) : null;
    return !!(creator && creator.baseshop && ownShops(acc, bases).indexOf(norm(creator.baseshop)) >= 0);
  }
  const m = /^([a-z0-9]+)_(announcements|training|licensing|cft|chat)$/.exec(channel);
  if (m) {
    if (acc.scope === "super") return true;
    if (!acc.mod) return false;
    return ownShops(acc, bases).indexOf(norm(m[1])) >= 0;
  }
  return acc.scope === "super";                     // #main, leadership and other company-wide rooms
}
/* Operations is asked to look at a private group. One row, one Help Desk line in #operations, one
   short note in the group so its members can see Operations was brought in. */
async function raiseToOps(channel: string, kind: "question" | "dispute", note: string, byCode: string, byName: string, messageId: number | null, groupName: string) {
  const ins = await fetch(`${SUPA}/rest/v1/hub_escalations`, { method: "POST", headers: { ...DBH, Prefer: "return=representation" },
    body: JSON.stringify({ channel, channel_name: groupName, kind, note: note || null, message_id: messageId, raised_by: byCode, raised_by_name: byName }) });
  const row = ((await ins.json()) || [])[0] || null;
  const label = kind === "dispute" ? "\u2696\ufe0f Dispute" : "\u2753 Question";
  const opsLine = `${label} from ${byName || byCode} in the private group \u201c${groupName}\u201d` + (note ? `:\n${note}` : ".") +
    `\nOpen it from Team Hub \u2192 Questions waiting.`;
  await fetch(`${SUPA}/rest/v1/hub_messages`, { method: "POST", headers: { ...DBH, Prefer: "return=minimal" },
    body: JSON.stringify({ channel: "operations", author_code: "HELPDESK", author_name: "Help Desk", body: opsLine, kind: "system", attach: null, reactions: {} }) });
  await fetch(`${SUPA}/rest/v1/hub_messages`, { method: "POST", headers: { ...DBH, Prefer: "return=minimal" },
    body: JSON.stringify({ channel, author_code: "OPSNOTE", author_name: "\ud83d\udee1\ufe0f Operations", body: `${byName || byCode} asked Operations to take a look (${kind}).`, kind: "system", attach: null, reactions: {} }) });
  return row;
}
/* v30: "may this signed-in person read this room?" - the rule hub_list applies, as one function
   so hub_react (and anything after it) cannot drift from it. Operations is decided by the caller. */
async function mayRead(channel: string, code: string): Promise<boolean> {
  if (!channel || !code) return false;
  if (channel.indexOf("dm:") === 0) return channel.slice(3).split("|").map((x) => norm(x)).indexOf(norm(code)) >= 0;
  if (channel === "operations") return false;
  const acc = await accessOf(code);
  if (!eligible(channel, acc, await loadBases())) return false;
  if (channel.indexOf("c_") === 0) {
    const c = (await customChannels()).find((x) => String(x.id) === channel);
    if (c && !canSeeCustom(c, norm(code), acc)) return false;
  }
  return true;
}
/* v30: the one flood rule for asking Operations into a private group, shared by hub_escalate and
   the @ops shortcut in hub_send. Returns an error string, or "" when the request may go ahead. */
async function escalationBlocked(code: string, channel: string): Promise<string> {
  const op = await fetch(`${SUPA}/rest/v1/hub_escalations?raised_by=eq.${encodeURIComponent(code)}&status=eq.open&select=id`, { headers: DBH });
  if (((await op.json()) || []).length >= 5) return "You already have 5 open requests with Operations. They will get to them.";
  const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const rc = await fetch(`${SUPA}/rest/v1/hub_escalations?raised_by=eq.${encodeURIComponent(code)}&channel=eq.${encodeURIComponent(channel)}&created_at=gte.${encodeURIComponent(since)}&select=id&limit=1`, { headers: DBH });
  if (((await rc.json()) || []).length) return "Operations was already asked about this group in the last 10 minutes.";
  return "";
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
    const OPS = await opsReach(body.token);
    const isAdmin = OPS.ok;
    /* v31: isAdmin says "this is Operations"; opsMay says which private rooms it may oversee. */
    const opsMay = opsOversight(OPS);

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
      const bases = await loadBases();
      /* v26 (2026-10-26): OPERATIONS SEES EVERY ROOM. This used to build Ops's list from
         accessOf(body.code), so the Operations seat -- which has no agent rank -- got #main and
         little else, and hub-files / hub-groups (which ask this endpoint) refused it attachments
         and group settings everywhere else. Same answer hub-ops already gives. */
      if (isAdmin) {
        /* v31: a baseshop seat's list carries only the private groups of its own shops. */
        const channels: Record<string, unknown>[] = genChannels(bases);
        for (const c of await customChannels()) if (await opsMay(String(c.id))) channels.push(c);
        const baseshops = (bases.bases || []).filter((b) => low(b.name) !== low(bases.root)).map((b) => ({ id: low(b.name), name: String(b.name), emd: b.owner_name || "" }));
        const access = { role: "ops", licensed: true, mod: true, name: "Operations", baseshop: bases.root, scope: "super", owns_base: "", accessibleBases: (bases.bases || []).map((b) => String(b.name)) };
        return json({ ok: true, access, channels, baseshops, ops: true });
      }
      const code = norm(body.code || url.searchParams.get("code"));
      const acc: Acc = code ? await accessOf(code) : { role: "agent", licensed: false, mod: false, name: "", baseshop: bases.root, scope: "member", owns_base: "", accessibleBases: [bases.root] };
      const custom = await customChannels();
      const all = genChannels(bases).concat(custom);
      const chans = all.filter((c: Record<string, unknown>) => (c.id as string).indexOf("c_") === 0 ? canSeeCustom(c, code, acc) : eligible(c.id as string, acc, bases));
      const baseshops = (bases.bases || []).filter((b) => low(b.name) !== low(bases.root)).map((b) => ({ id: low(b.name), name: String(b.name), emd: b.owner_name || "" }));
      /* v27: the rooms this person may moderate, so the page offers "remove" only where the
         server will honour it. */
      const mod_channels: string[] = [];
      for (const c of chans) { if (await mayModerate(code, acc, String(c.id), bases, custom)) mod_channels.push(String(c.id)); }
      return json({ ok: true, access: acc, channels: chans, baseshops, mod_channels });
    }

    if (action === "hub_send") {
      const code = norm(body.code); const channel = clean(body.channel) || "main";
      if (!code) return json({ ok: false, error: "missing" });
      if (isAdmin && !(await opsMay(channel))) return json({ ok: false, error: "That conversation belongs to another baseshop." }, 403);
      /* v33 (2026-10-26): a direct message is only for its two people. DM rooms skipped every
         check here, so anyone could post into a conversation between two other agents -- found
         by the end-to-end Hub test. */
      if (!isAdmin && channel.indexOf("dm:") === 0) {
        const parts = channel.slice(3).split("|").map((x) => norm(x)).filter(Boolean);
        if (parts.length !== 2 || parts.indexOf(code) < 0) return json({ ok: false, error: "That conversation is not yours." }, 403);
      }
      if (!isAdmin && channel.indexOf("dm:") !== 0) {
        const acc = await accessOf(code);
        if (channel.indexOf("c_") === 0) {
          const cl = await customChannels(); const cobj = cl.find((x) => x.id === channel);
          /* ...and a group that no longer exists (or never did) takes no new messages. */
          if (!cobj) return json({ ok: false, error: "That group no longer exists." }, 404);
          if (!canSeeCustom(cobj, code, acc)) return json({ ok: false, error: "You don't have access to this channel." }, 403);
        } else { const bases = await loadBases(); if (!eligible(channel, acc, bases)) return json({ ok: false, error: "You don't have access to this channel." }, 403); }
      }
      let nm = clean(body.author_name); if (!nm) { const a = await agentRow(code); nm = a ? (((a.first_name || "") + " " + (a.last_name || "")).trim()) : ""; }
      /* v34 (2026-10-26): what a person may put on a message. `kind` decides how it is drawn --
         'system' wears the OPERATIONS badge and 'ai'/'coach'/'announce' look like the bots -- so an
         agent may only send plain text or a recognition. `attach` was stored as sent and drawn into
         src/href, which let a crafted object run script in everyone's Hub; an agent's attachment is
         now rebuilt from the v2 upload fields only, and only for a file in THIS room's folder. */
      let kind = clean(body.kind) || "text";
      let attach: unknown = null;
      if (isAdmin) {
        attach = (body.attach && typeof body.attach === "object") ? body.attach : null;
      } else {
        if (["text", "recognition"].indexOf(kind) < 0) kind = "text";
        const a = (body.attach && typeof body.attach === "object") ? body.attach as Record<string, unknown> : null;
        if (a) {
          const folder = channel.replace(/[^A-Za-z0-9_.|:-]/g, "_") + "/";
          const path = String(a.path ?? "");
          const akind = String(a.kind ?? "");
          if (Number(a.v) !== 2 || path.indexOf(folder) !== 0 || !/^[A-Za-z0-9_.|:\/-]+$/.test(path) || path.indexOf("..") >= 0 || ["image", "video", "file"].indexOf(akind) < 0) {
            return json({ ok: false, error: "That attachment could not be sent. Pick the file again." }, 400);
          }
          attach = { v: 2, kind: akind, path, name: clean(a.name).slice(0, 200), size: Number(a.size) || 0, mime: clean(a.mime).slice(0, 100) };
        }
      }
      const row: Record<string, unknown> = { channel, author_code: code, author_name: nm, body: clean(body.body), kind, attach, reply_to: body.reply_to ? Number(body.reply_to) : null, reactions: {} };
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
      /* v27: "@Operations" (or @ops) in a PRIVATE group is how a member asks Ops in. Nothing else
         said in a private group reaches Operations. */
      let escalated = false; let escalate_error = "";
      if (ins.ok && !isAdmin && channel.indexOf("c_") === 0 && /(^|\s)@(operations|ops)\b/i.test(String(row.body || ""))) {
        const cl = await customChannels(); const cobj = cl.find((x) => x.id === channel);
        if (cobj && cobj.private) {
          /* v30: same cap as hub_escalate. The message itself is still posted; only the page to
             Operations is held back, and the sender is told why. */
          escalate_error = await escalationBlocked(code, channel);
          if (!escalate_error) {
            await raiseToOps(channel, "question", String(row.body || "").slice(0, 1000), code, String(nm || code), inserted && inserted.id ? Number(inserted.id) : null, String(cobj.name || channel));
            escalated = true;
          }
        }
      }
      return json({ ok: ins.ok, message: inserted, bot, escalated, escalate_error: escalate_error || undefined });
    }

    if (action === "hub_list") {
      const channel = clean(body.channel || url.searchParams.get("channel")) || "main";
      // hub_list has never checked access: knowing a channel id was enough to read its history,
      // so hiding #operations in the sidebar would not actually have made it private. The
      // Operations seats reach the hub with an Operations token (teamhub's h() adds it in ops
      // mode), so that token is exactly the line between them and everybody else.
      if (channel === "operations" && !isAdmin) return json({ ok: true, messages: [] });
      // v31: a baseshop Ops seat reads only its own shops' private groups and DMs.
      if (isAdmin && !(await opsMay(channel))) return json({ ok: false, error: "That conversation belongs to another baseshop." }, 403);
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
      /* v32: the first load is the NEWEST 500, returned oldest-first. It used to ask for
         order=id.asc&limit=500, i.e. the oldest 500, so a room past 500 messages would have opened
         on its history and never shown what was said today. */
      let q = `${SUPA}/rest/v1/hub_messages?channel=eq.${encodeURIComponent(channel)}`;
      if (after > 0) q += `&id=gt.${after}&order=id.asc`; else q += `&order=id.desc&limit=500`;
      const ex = await fetch(q, { headers: DBH });
      const msgs = ((await ex.json()) || []) as Record<string, unknown>[];
      if (!(after > 0) && Array.isArray(msgs)) msgs.reverse();
      return json({ ok: true, messages: msgs });
    }

    if (action === "hub_react") {
      const id = Number(body.id); const code = norm(body.code); const emoji = clean(body.emoji).slice(0, 8);
      /* v34: a reaction is an emoji, not markup -- quotes, brackets and letters are refused. */
      if (/[<>"'`&\\A-Za-z0-9]/.test(emoji)) return json({ ok: false, error: "That is not a reaction." }, 400);
      if (!id || !code || !emoji) return json({ ok: false, error: "missing" });
      const ex = await fetch(`${SUPA}/rest/v1/hub_messages?id=eq.${id}&select=reactions,channel`, { headers: DBH });
      const rows = await ex.json(); if (!rows || !rows[0]) return json({ ok: false, error: "not found" });
      /* v30: only in a room you can read. Same answer as a missing id, so this cannot be used to
         probe which message ids live in rooms you are not in. */
      if (!isAdmin && !(await mayRead(String(rows[0].channel || ""), code))) return json({ ok: false, error: "not found" });
      if (isAdmin && !(await opsMay(String(rows[0].channel || "")))) return json({ ok: false, error: "not found" });
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
      // v31: Operations edits anyone's message only in a room it oversees; same answer as no id.
      if (isAdmin && !OPS.full) {
        const ex = await fetch(`${SUPA}/rest/v1/hub_messages?id=eq.${id}&select=channel`, { headers: DBH });
        const m0 = ((await ex.json()) || [])[0];
        if (!m0 || !(await opsMay(String(m0.channel || "")))) return json({ ok: false, error: "not found" });
      }
      /* v33: an edit to nothing is refused (it used to blank the message -- deleting is a separate,
         recorded action), and an edit that changed no row says so instead of reporting success. */
      const newBody = clean(body.body);
      if (!newBody.trim()) return json({ ok: false, error: "A message can't be empty. Delete it instead." }, 400);
      let q = `${SUPA}/rest/v1/hub_messages?id=eq.${id}&deleted=not.eq.true`;
      if (!isAdmin) q += `&author_code=eq.${encodeURIComponent(code)}`;
      const up = await fetch(q, { method: "PATCH", headers: { ...DBH, Prefer: "return=representation" }, body: JSON.stringify({ body: newBody, edited: true }) });
      const got = await up.json().catch(() => []);
      if (up.ok && !(Array.isArray(got) && got.length)) return json({ ok: false, error: "You can only edit your own messages." }, 403);
      return json({ ok: up.ok });
    }

    if (action === "hub_delete") {
      const id = Number(body.id); const code = norm(body.code); const by = norm(body.by);
      if (!id) return json({ ok: false, error: "no id" });
      let modOk = isAdmin;
      /* v31: a baseshop Ops seat removes messages only in rooms it oversees. */
      if (isAdmin && !OPS.full) {
        const ox = await fetch(`${SUPA}/rest/v1/hub_messages?id=eq.${id}&select=channel`, { headers: DBH });
        const o0 = ((await ox.json()) || [])[0];
        if (!o0 || !(await opsMay(String(o0.channel || "")))) return json({ ok: false, error: "That conversation belongs to another baseshop." }, 403);
      }
      /* v27: moderation is per room. Read the message's room, then ask mayModerate(). */
      if (!modOk && by) {
        const mx = await fetch(`${SUPA}/rest/v1/hub_messages?id=eq.${id}&select=channel,author_code`, { headers: DBH });
        const m0 = ((await mx.json()) || [])[0];
        if (m0 && norm(m0.author_code) !== norm(code)) {
          const acc = await accessOf(by); const bases = await loadBases();
          modOk = await mayModerate(by, acc, String(m0.channel || ""), bases);
          if (!modOk) return json({ ok: false, error: "You can only remove your own messages in this room." }, 403);
        }
      }
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
      let contact = isAdmin || norm(code) === norm(CALLER);
      if (!contact && CALLER) {
        const sc = await rpc("agent_scope", { p_code: norm(CALLER) });
        const bases = (sc && Array.isArray(sc.bases)) ? sc.bases.map((b: unknown) => norm(b)) : [];
        contact = !!(sc && sc.ok === true && (sc.all || bases.indexOf(norm(a && a.baseshop)) >= 0));
      }
      return json({ ok: true, profile: { code, name: acc.name, email: contact ? ((a && a.email) || "") : "", phone: contact ? ((a && a.phone) || "") : "", cal_link: contact ? ((a && a.cal_link) || "") : "", contact_hidden: !contact, title: (a && a.title) || "", direct_to: (a && a.direct_to) || "", direct_to_name: (a && a.direct_to_name) || "", role: acc.role, baseshop: acc.baseshop, last_seen: prow ? prow.last_seen : "", pres_status: prow ? prow.status : "", pres_channel: prow ? prow.channel : "" } });
    }

    if (action === "hub_setprofile") {
      const code = norm(body.code);
      if (!code) return json({ ok: false, error: "no code" });
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (typeof body.email === "string") patch.email = clean(body.email);
      if (typeof body.phone === "string") patch.phone = clean(body.phone);
      /* v30: the same Calendly rule as profile-api save_contact, so the two editors of this one
         column cannot disagree: https calendly.com only, a bare calendly.com/x gets its https://,
         blank clears it. It is printed as a link on other people's screens. */
      if (typeof body.cal_link === "string") {
        let link = clean(body.cal_link);
        if (link && /^(www\.)?calendly\.com\//i.test(link)) link = "https://" + link;
        if (link && !/^https:\/\/(www\.)?calendly\.com\/[A-Za-z0-9._~\/?=&%-]+$/i.test(link)) {
          return json({ ok: false, field: "cal_link", error: "That is not a Calendly booking link. It should look like https://calendly.com/your-name." }, 400);
        }
        patch.cal_link = link;
      }
      /* v30: `title` is leadership rank (agentLevel() reads it, and the roster shows it as who
         leads). Nobody promotes themselves from their own contact card; Operations may set it. */
      if (typeof body.title === "string") {
        if (!isAdmin) return json({ ok: false, field: "title", error: "Your title is set by Operations." }, 403);
        patch.title = clean(body.title);
      }
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
      /* v29 (handoff section 5): the 60-character rule lives here, not only in the field; a
         retry carrying the same req_id returns the group already made instead of a second one;
         the append is one locked database statement, so two people creating at once both keep
         their group; and invitees outside the creator's own scope are refused, the same rule as
         hub-groups member_add and the hub-roster picker. */
      const name = clean(body.name).replace(/\s+/g, " ").trim();
      if (!name) return json({ ok: false, field: "name", error: "Give the group a name." }, 400);
      if (name.length > 60) return json({ ok: false, field: "name", error: "Group names can be up to 60 characters." }, 400);
      const byCode = norm(body.code);
      // `by` is the creator's display name, and it used to be whatever the request typed.
      const by = isAdmin ? clean(body.by) : ((await accessOf(byCode)).name || clean(body.by));
      const reqId = clean(body.req_id).slice(0, 64);
      const id = "c_" + low(name).replace(/[^a-z0-9]+/g, "_").slice(0, 24) + "_" + Math.random().toString(36).slice(2, 6);
      const priv = !!body.private;
      let members: string[] = Array.isArray(body.members) ? (body.members as unknown[]).map((x) => norm(x)).filter(Boolean) : [];
      members = members.filter((c, i) => members.indexOf(c) === i && c !== byCode);
      if (members.length && !isAdmin) {
        const pex = await fetch(`${SUPA}/rest/v1/tracker_agents?code=in.(${members.map((c) => `"${encodeURIComponent(c)}"`).join(",")})&select=code,first_name,last_name,status,baseshop`, { headers: DBH });
        const ppl: Record<string, Record<string, unknown>> = {};
        for (const r of ((await pex.json()) || []) as Record<string, unknown>[]) ppl[norm(r.code)] = r;
        const missing = members.filter((c) => !ppl[c] || low(ppl[c].status) === "quit");
        if (missing.length) return json({ ok: false, field: "members", error: `Not an active account: ${missing.join(", ")}` }, 400);
        const sc = await rpc("agent_scope", { p_code: byCode });
        const all = !!(sc && sc.ok === true && sc.all);
        const bases = (sc && Array.isArray(sc.bases)) ? sc.bases.map((b: unknown) => norm(b)) : [];
        const outside = all ? [] : members.filter((c) => bases.indexOf(norm(ppl[c].baseshop)) < 0);
        if (outside.length) return json({ ok: false, field: "members", error: `Outside your baseshop: ${outside.map((c) => ((String(ppl[c].first_name || "") + " " + String(ppl[c].last_name || "")).trim() || c)).join(", ")}` }, 403);
      }
      if (byCode) members.push(byCode);
      const ch: Record<string, unknown> = { id, name, icon: priv ? "🔒" : "📌", by, byCode, private: priv, members };
      if (reqId) ch.req_id = reqId;
      const res = await rpc("hub_channel_append", { p_ch: ch, p_req: reqId });
      if (!res || !res.channel) return json({ ok: false, error: "Could not create the group. Try again." }, 500);
      const saved = res.channel as Record<string, unknown>;
      return json({ ok: true, id: saved.id, private: !!saved.private, members: saved.members, duplicate: !!res.dup });
    }

    if (action === "hub_escalate") {
      if (isAdmin) return json({ ok: false, error: "Operations does not need to escalate to itself." }, 400);
      const code = norm(body.code); const channel = clean(body.channel);
      const kind = low(body.kind) === "dispute" ? "dispute" : "question";
      const note = clean(body.note).slice(0, 1000);
      if (channel.indexOf("c_") !== 0) return json({ ok: false, error: "Asking Operations from here is for private groups." }, 400);
      const cl = await customChannels(); const cobj = cl.find((x) => x.id === channel);
      if (!cobj || !cobj.private) return json({ ok: false, error: "Asking Operations from here is for private groups." }, 400);
      const acc = await accessOf(code);
      if (!canSeeCustom(cobj, code, acc)) return json({ ok: false, error: "You are not in that group." }, 403);
      /* Keeps Ops from being flooded: at most 5 open requests per person, and (v30) one per group
         per 10 minutes. Shared with the @ops shortcut in hub_send. */
      const blocked = await escalationBlocked(code, channel);
      if (blocked) return json({ ok: false, error: blocked }, 429);
      const mid = Number(body.message_id) || null;
      const row = await raiseToOps(channel, kind, note, code, acc.name || code, mid, String(cobj.name || channel));
      return json({ ok: !!row, id: row ? row.id : null });
    }

    if (action === "hub_deletechannel") {
      const id = clean(body.id); const byCode = norm(body.code);
      if (!id || id.indexOf("c_") !== 0) return json({ ok: false, error: "only custom channels can be deleted" });
      const list = await customChannels();
      const cobj = list.find((x) => x.id === id);
      if (!cobj) return json({ ok: false, error: "channel not found" });
      // v31: Operations deletes a private group only if it oversees it (opsMay is true for open ones).
      let allowed = (isAdmin && await opsMay(id)) || (!isAdmin && norm(cobj.byCode) === byCode);
      /* v27: a private group is deleted only by its creator or Operations. An open group also by
         the leaders who moderate the creator's own baseshop. */
      if (!allowed && !isAdmin && byCode && !cobj.private) { const acc = await accessOf(byCode); allowed = await mayModerate(byCode, acc, id, await loadBases(), list); }
      if (!allowed) return json({ ok: false, error: cobj.private ? "Only the person who created this private group, or Operations, can delete it." : "Only the creator or a leader of this baseshop can delete this group." }, 403);
      /* v30: removed under the registry's row lock (hub_channel_remove), not by writing back a copy
         read above - a group created between that read and this write used to be erased with it.
         The RPC also drops the group's hub_group_admins rows. */
      const gone = await rpc("hub_channel_remove", { p_id: id });
      if (!gone || gone.ok !== true) return json({ ok: false, error: "Could not delete the group. Try again." }, 500);
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
      } else if (!OPS.full) {
        // v31: a baseshop Ops seat searches only the private rooms it oversees.
        const keep: Record<string, unknown>[] = [];
        for (const m of hits) if (await opsMay(String(m.channel || ""))) keep.push(m);
        hits = keep;
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
