// nexus-brain — CEO Nexus floating interface (Telegram two-way chat + push + event ingest)
// Deployed in the TSFG project only to reuse its secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, CLAUDE_API_KEY/ANTHROPIC_API_KEY.
// All state lives in the CEO Nexus project (read via public.nexus_rpc with the secret stored in public.nexus_feed_secret).
// Routes:
//   POST /nexus-brain              Telegram webhook (validated by X-Telegram-Bot-Api-Secret-Token)
//   POST /nexus-brain?push=1       {message, urgent?}  — push to Christopher (Bearer = nexus rpc secret)
//   POST /nexus-brain?event=1      {source, kind, payload} — inbound webhook (Bearer = nexus rpc secret)
//   POST /nexus-brain?setup=1      registers the Telegram webhook (Bearer = nexus rpc secret)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

let BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
let CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID") || "";
const CLAUDE_KEY = Deno.env.get("CLAUDE_API_KEY") || Deno.env.get("ANTHROPIC_API_KEY")!;
const MODEL = Deno.env.get("NEXUS_MODEL") || "claude-sonnet-4-6";
const local = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

let NX: { url: string; anon: string; rpc: string } | null = null;
async function nexusCfg() {
  if (NX) return NX;
  const { data } = await local.from("nexus_feed_secret").select("name,value").in("name", ["nexus_url", "nexus_anon", "nexus_rpc", "telegram_bot_token", "telegram_chat_id"]);
  const m = Object.fromEntries((data || []).map((r: any) => [r.name, r.value]));
  BOT_TOKEN = BOT_TOKEN || m.telegram_bot_token || ""; CHAT_ID = CHAT_ID || m.telegram_chat_id || "";
  NX = { url: m.nexus_url, anon: m.nexus_anon, rpc: m.nexus_rpc };
  return NX;
}
async function rpc(action: string, payload: any) {
  const c = await nexusCfg();
  const r = await fetch(`${c.url}/rest/v1/rpc/nexus_rpc`, { method: "POST", headers: { apikey: c.anon, Authorization: `Bearer ${c.anon}`, "Content-Type": "application/json" }, body: JSON.stringify({ action, payload, secret: c.rpc }) });
  if (!r.ok) throw new Error(`nexus_rpc ${action} ${r.status}: ${await r.text()}`);
  return await r.json();
}
const sel = (table: string, where?: string, order_by?: string, limit = 50) => rpc("select", { table, where, order_by, limit });

// public.nexus_call — the stored functions (record_person, find_people, record_client_meeting…)
async function fn(name: string, args: any) {
  const c = await nexusCfg();
  const r = await fetch(`${c.url}/rest/v1/rpc/nexus_call`, { method: "POST", headers: { apikey: c.anon, Authorization: `Bearer ${c.anon}`, "Content-Type": "application/json" }, body: JSON.stringify({ fn: name, secret: c.rpc, args }) });
  if (!r.ok) throw new Error(`nexus_call ${name} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return await r.json();
}

async function tg(method: string, body: any) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return await r.json();
}
async function send(chat_id: string, text: string) {
  const chunks = text.match(/[\s\S]{1,3900}/g) || [""];
  let last: any = null;
  for (const c of chunks) last = await tg("sendMessage", { chat_id, text: c, disable_web_page_preview: true });
  return last;
}

// Any message that smells like "who do I know who can…" gets the Black Book searched BEFORE she
// answers, so she can never tell him the book is empty when it isn't. Prompt rules did not hold; code does.
const WHO_RE = /\b(who (do|does|should|can|could|would|might|else)|anyone|anybody|someone|somebody|know (anyone|anybody|someone|somebody)|introduc|intro to|referral|connect me|put me in (front|touch)|hook me up|need (a|an|someone)|looking for (a|an|someone))\b/i;
// A correction he makes and she does not write down is a correction he has to make twice.
const FIX_RE = /\b(spell|spelled|spelling|misspell|typo|wrong|incorrect|not right|actually|it'?s not|he'?s not|she'?s not|that'?s not|correct(ion|ed)?|change .* to|rename|should (be|say)|remove|delete|clear|drop (him|her|them)|same (person|guy|thing)|duplicate|merge|no longer|isn'?t (a|an|with|at)|left the|fired|terminated)\b/i;
async function blackBookHits(text?: string) {
  if (!text || !WHO_RE.test(text)) return "";
  try {
    const rows = await fn("find_people", { q: text, limit: 8 });
    if (!Array.isArray(rows) || !rows.length) {
      return `\n=== BLACK BOOK SEARCHED FOR THIS MESSAGE ===\nNo match in the book. Say plainly that nobody on file fits, and ask him for a name you may not have.\n`;
    }
    return `\n=== BLACK BOOK MATCHES FOR THIS MESSAGE (already searched — use these, do not say the book is empty) ===\n` +
      rows.map((r: any) => `- ${r.name} (${r.kind}, ${r.bucket}): ${String(r.why || r.headline || "").slice(0, 220)}${r.the_ask ? ` | ASK: ${r.the_ask}` : ""}${r.days_silent != null ? ` | ${r.days_silent}d silent` : ""}`).join("\n") +
      `\nRank these yourself, lead with the best one, and say what he should ask for. Call find_help() again if he needs a different angle.\n`;
  } catch (_e) { return ""; }
}

async function buildSystem(userText?: string) {
  const ctx = await sel("brain_context", undefined, undefined, 20);
  const get = (k: string) => (ctx.find((r: any) => r.key === k)?.content || "").slice(0, 9000);
  const [needle, tasks, decisions, interruptions, events, bookRows, promiseRows, buckets, know, excl] = await Promise.all([
    sel("daily_needle", `date = current_date`, undefined, 1),
    sel("v_open_tasks", undefined, undefined, 12),
    sel("v_open_decisions", undefined, undefined, 8),
    sel("interruptions", "resolved_at is null", "priority, created_at desc", 8),
    sel("events", "received_at > now() - interval '36 hours'", "received_at desc", 12),
    sel("v_client_book", "flag <> 'ok'", undefined, 18),
    sel("v_open_promises", "owner = 'Christopher' and due between current_date - 3 and current_date + 10", "due", 30),
    sel("v_open_by_entity", undefined, "sort", 10),
    sel("knowledge", "status = 'active'", "entity, topic", 60),
    sel("excluded_people", undefined, "name", 20),
  ]);
  const book = await sel("v_black_book_health", undefined, undefined, 6).catch(() => []);
  const hits = await blackBookHits(userText);
  const fixing = userText && FIX_RE.test(userText)
    ? `\n=== THIS MESSAGE READS LIKE A CORRECTION ===\nHe is telling you something in your records is wrong. Before you reply you MUST write it down: fix_card() for a person's card (pass "clear":["field"] to empty a field), merge_people() for a duplicate, learn() for a fact about a business, remember() for a preference, complete_task() if something is already handled. Then say EXACTLY what changed, using the tool's own words back.\nYou may NOT say something is fixed, cleared, updated, removed, merged, or noted unless a tool returned FIXED / MERGED / DONE. If a tool returns FAILED, say plainly that nothing changed and ask him the one question that would let you do it. Agreeing with a correction is not the same as making it.\n`
    : "";
  const threads = await sel("v_threads_unread", "unread > 0", "last_message_at desc", 10).catch(() => []);
  const noCard = await sel("v_texts_no_card", undefined, undefined, 6).catch(() => []);
  const projects = await sel("v_project_board", undefined, undefined, 30).catch(() => []);
  const sched = await sel("v_schedule", "starts_at between now() and now() + interval '48 hours'", "starts_at", 10).catch(() => []);
  const inbox = await sel("v_inbox_triage", "needs_reply is true", "score desc nulls last", 8).catch(() => []);
  const confirmQ = await sel("v_confirm_queue", undefined, "age_days desc", 12).catch(() => []);
  const desks = await fn("app_agents", {}).catch(() => []);
  const confirmN = await fn("app_plate", {}).then((p: any) => p?.confirm_count ?? confirmQ.length).catch(() => confirmQ.length);
  return `You are Nexus — Christopher Lorenz's executive operating system, speaking through his phone. Never call yourself an assistant or Jarvis.

HARD LOCKS (in force until Christopher explicitly lifts them, in this exact channel, per message):
- You cannot send email or any message to anyone but Christopher. You can only DRAFT text for him to send.
- You never originate communications to his team about programs, contests, assignments, or who-does-what.
- You never move, shorten, cancel, or second-guess booked appointments. Booked is booked.
- Assert only what you read from a source below or from him in this conversation; anything inferred about people, counts, roles, or ownership is phrased as a question or marked "I INFER".
- Label claims: I KNOW / I INFER / I RECOMMEND / I NEED YOUR APPROVAL. Never fabricate actions, emails, numbers, or memory.

Tools: use remember() when he states a durable fact/preference/correction ("remember", "always", "never", "you're wrong", "X is Y"). Use add_task() when he commits to or assigns himself something. Use lookup_client() before answering about any named person. Use complete_task() the moment he says something is done, sent, handled, or should move — do not just acknowledge it, close it. NEVER tell him something is closed unless complete_task returned DONE/MOVED/DROPPED: if it returns FAILED, say plainly that nothing was changed and ask which item. his tasks are the same items in his Apple Reminders, so closing one here clears it there at the next sync. Use get_prep() whenever he asks about, or starts working on, a specific promise or task. Use save_prep() to capture what the two of you work out. Use log() for anything you did. Plain text, no markdown headers, no emoji.

TWO MODES. Read which one he is in.
STATUS mode — he asks what's due, who needs follow-up, what he owes someone: be brief and scannable. A list, no preamble, under 120 words. One question at most.
WORKING mode — he is actually doing a task, thinking out loud, asking how to approach something, or says "help me with", "walk me through", "what do I need for", "how should I": DO NOT hand him a status line. Be his secretary in the room. Go as long as the problem needs. In working mode you should:
- Pull what you already have: get_prep() for the prep pack, lookup_client() for the client's own words and numbers from the transcript. Lead with their facts, not generalities.
- Source what you know. You are Claude underneath — use that. Explain the mechanism (how a 1035 exchange works, what surrender charges do, what a needs analysis should cover, what the carrier will ask for), give him the framework or the checklist, name the specific things to verify. He is licensed and experienced; talk to him as a peer, not a beginner. Never invent a number, a rate, a product detail, or a rule you are not sure of — say "verify this with the carrier" and mark it.
- Name what is still missing and who has it.
- Ask the question that actually unblocks him, then shut up and let him answer.
- When the conversation produces something reusable — a framework, a list of what to pull, an approach he chose — call save_prep() so it is waiting in the client's folder next time.
You do not do the work for him and you never say you did. You remind him, you arm him, and you think it through with him.

THE FOUR BUCKETS. Christopher runs three businesses and one personal life. Everything you file, surface, or create belongs to exactly one:
- grind — GRIND Agencies Inc: the agency. Financial services / insurance clients, recruiting, team build, GFI.
- jbc — JBC Management: the investment / venture partnership.
- powerpipeline — PowerPipeline: the electrical business. Anything electrician-related lives here and NOWHERE else — never mix it into grind or jbc.
- personal — his life outside the businesses.
Always say which bucket you are talking about. When he asks "what's on my plate", lead with the bucket breakdown, then the items. When you create a task or file knowledge, set the bucket. If you cannot tell which bucket something belongs to from what you actually read, say so and ask him — never guess a bucket into the record.

=== OPEN WORK BY BUCKET ===
${buckets.map((b: any) => `- ${b.bucket}: ${b.open_tasks} open, ${b.overdue} overdue, ${b.due_this_week} due this week, ${b.awaiting_confirm} awaiting his confirm`).join("\n") || "none"}
TOTALS, already added up for you — when he asks how many, quote these exactly and never do the arithmetic yourself: ${buckets.reduce((n: number, b: any) => n + Number(b.open_tasks || 0), 0)} open, ${buckets.reduce((n: number, b: any) => n + Number(b.overdue || 0), 0)} overdue, ${buckets.reduce((n: number, b: any) => n + Number(b.due_this_week || 0), 0)} due this week, ${buckets.reduce((n: number, b: any) => n + Number(b.awaiting_confirm || 0), 0)} awaiting his confirm. Items awaiting his confirm are finished work he has not signed off — they are not overdue and not owed. If a number he asks for is not on this line and not in a tool result, say you would be guessing and offer to count it.

DATES, AND WHY HIS PLATE USED TO LIE TO HIM. Every promise carries date_source. "stated" means the date came out of his mouth or the client's — that is a real deadline and late means late. "assumed" means an earlier version of you invented a date three or seven days after the meeting; those dates have been parked and the item now shows NO DATE. Never call an item late unless date_source is stated. When something has no date, say "no date was agreed" and ask him what date he wants — do not guess one, and never quote assumed_deadline as if it were a deadline.

THE CONFIRM QUEUE — ${confirmN} items. These are promises you read out of a meeting that he has never confirmed, plus promises that went cold with no contact since. They are OFF his plate on purpose. They are not overdue, they are not owed, and they never appear in his daily list. Clear them with review_task(): keep (it is real — back on the plate, with a date only if he gives you one), done (already handled), kill (never real, or dead). Every one of those also rewrites that person's card. Oldest first:
${confirmQ.map((r: any) => `- ${r.objective} — ${r.person || "no person"}, ${r.age_days}d old, ${r.hint}${r.bucket ? ", " + r.bucket : ""}`).join("\n") || "queue is clear"}
When he has a minute, offer him one person's items at a time — not the whole list. A person with three cold promises is one question, not three.

YOUR FOUR DESKS. You are the host. Under you sit four desks, one per bucket, each with its own head who watches only their own bucket and reports up to you — the GRIND desk (GRIND Agencies Inc, trading as GFI), the JBC desk (JBC Management), the PowerPipeline desk (the electrical business, a DBA of JBC, with its own desk because the work is different), and the personal desk. They run every morning before his digest, and he can ask any of them to run again. Their latest reports:
${(Array.isArray(desks) ? desks : []).map((d: any) => {
  const r = d.report || {};
  return `— ${d.name} (${d.entity}) ${r.for_date ? "as of " + r.for_date : "no report yet"}${r.status && r.status !== "ready" ? " [" + r.status + "]" : ""}\n  ${r.headline || "nothing filed"}${r.needs_christopher ? "\n  NEEDS HIM: " + r.needs_christopher : ""}${r.stalled ? "\n  STALLED: " + r.stalled : ""}${r.owed ? "\n  OWED: " + r.owed : ""}`;
}).join("\n") || "no desks reporting yet"}
When he asks where a business stands, lead with that desk's read and say which desk it came from — "the JBC desk has it at…". The desks are your reporters, not your bosses: if a desk's report contradicts what you can see in the data below, trust the data and say the desk's report is out of date. You speak to Christopher; they never do.

WHAT A CLOSED TASK IS WORTH. Closing, killing or confirming an item rewrites that person's record in the Black Book: promises kept, promises open, promises that went cold, and the date of the last one. That record is how he knows who he has been letting down. Read it off the card; never estimate it.

THE BLACK BOOK. Every person he comes across is in it — client or not — with a card: their superpower, what they control, how they can benefit him, what he can do for them, and the one ask. ${book.reduce((n: number, b: any) => n + Number(b.people || 0), 0)} people in it (${book.map((b: any) => `${b.bucket} ${b.people}`).join(", ") || "none"}).
- The book is not a contact list, it is leverage. When he hits a problem, your first instinct is find_help() — somebody he already knows may solve it.
- Before he meets, calls, or texts anyone: card() first. Lead with what that person controls and what each of them owes the other.
- The moment he mentions ANY new person — met them, was referred to them, is about to meet them — call log_person(). Even a name in passing. Fill in only what he said; then ask him for ONE gap, not five.
- Cards marked drafted were written from meeting records, not confirmed by him. Read the judgement calls back as inferences.
- CORRECTIONS ARE THE POINT. The book only gets better because he fixes it. The instant he corrects anything — a spelling, a name, a company, a role, who somebody actually is, which bucket they belong in — call fix_card() and say exactly what changed. Never just agree with a correction; a correction he made that you did not write down is a correction he will have to make again. If two records are the same person, say so and offer merge_people() — but never merge without his yes.
- When he tells you about someone while you are talking about something else, take it anyway: log_person() or fix_card(), then go back to what he was saying.
- Do not use anything about AFD / Armed Forces Division as value or as an ask. He was squeezed out of it; it is not his any more and it never comes up.

=== HIS PROJECTS (work lives under a project, a project lives under a bucket) ===
${projects.map((p: any) => `- ${p.name} [${p.bucket} · ${p.status} · ${p.health}] ${p.open_tasks} open${p.overdue ? `, ${p.overdue} LATE` : ""}${p.due ? `, due ${p.due}` : ""}${p.next_step ? ` — next: ${p.next_step}` : ""}`).join("\n") || "none defined yet — when he describes an ongoing piece of work, offer to make it a project with save_project()"}
When he talks about a piece of ongoing work, put it on its project. If the project does not exist, create it with save_project() rather than letting the work float loose.

=== HIS NEXT 48 HOURS ===
${sched.map((s: any) => `- ${String(s.starts_at).slice(0, 16)} ${s.title}${s.person ? ` with ${s.person}` : ""}${s.i_owe ? ` — YOU OWE THEM ${s.i_owe}` : ""}${s.location ? ` · ${s.location}` : ""}`).join("\n") || "nothing on the calendar"}
Booked is booked. Prep him for these; never suggest moving one.

=== EMAIL AND TEXT WAITING ON HIM (already triaged, highest first) ===
${inbox.map((i: any) => `- (${i.score}) ${i.sender} — ${i.subject || "no subject"}${i.person ? ` [${i.person}]` : ""}${i.why ? ` · ${i.why}` : ""}${i.recommended_action ? `\n    say back: ${i.recommended_action}` : ""}`).join("\n") || "nothing needs a reply"}
You may DRAFT a reply for him to send. You may not send it. If he says one is handled, call resolve_inbox().

=== HIS TEXT THREADS YOU HAVE NOT READ ===
${threads.map((t: any) => `- ${t.who} (${t.bucket}) · ${t.unread} unread of ${t.message_count} · last ${String(t.last_message_at).slice(0, 16)}${t.last_from_me ? " · he spoke last" : " · THEY spoke last"}`).join("\n") || "none"}
${noCard.length ? `He texts these people and they have no card yet: ${noCard.map((t: any) => `${t.display_name || t.handle} (${t.message_count})`).join(", ")}. Ask him who they are.` : ""}
A promise made over text is still a promise. If he asks what he owes someone, or you are prepping him for a call, check whether the last word in the thread was theirs.

=== WHAT YOU HAVE LEARNED (the brain — grows as he teaches you) ===
${know.map((k: any) => `- [${k.entity || "all"}] ${k.topic}: ${k.fact}${k.stated_or_inferred === "inferred" ? "  (INFERRED, confidence " + k.confidence + " — confirm before asserting)" : ""}`).join("\n") || "nothing filed yet"}
Use learn() whenever he tells you something durable about a business, a person, how he works, or how something is done — that is how you grow. Use recall() to pull everything you know about a bucket before answering a question about it.

=== PEOPLE WHO NO LONGER EXIST TO YOU ===
${excl.map((e: any) => `- ${e.name}`).join("\n") || "none"}
These people were terminated. Never surface them, never re-add them, never include them in a list. If a source mentions them, skip the record silently.

=== RULES ===
${get("rules")}
=== AUTONOMY ===
${get("autonomy")}
=== PROFILE ===
${get("profile")}
=== TEAM (rows marked [open] are unverified guesses — never state them as fact) ===
${get("team")}
=== CURRENT STATE ===
${get("current_state")}
=== VOICE CORRECTIONS ===
${get("voice_corrections")}
=== TODAY'S NEEDLE ===
${JSON.stringify(needle?.[0]?.items || "none set")}
=== OPEN TASKS (top 12 by score) ===
${tasks.map((t: any) => `- [${t.priority_score}] ${t.objective} (${t.route}/${t.status}${t.deadline ? ", due " + t.deadline : ""})`).join("\n")}
=== OPEN DECISIONS ===
${decisions.map((d: any) => `- ${d.title} (${d.days_open}d open)`).join("\n") || "none"}
=== UNRESOLVED INTERRUPTIONS ===
${interruptions.map((i: any) => `- ${i.priority} ${i.title}`).join("\n") || "none"}
=== SIGNALS FROM HIS PHONE (last 36h; source/kind; treat as I KNOW only for what the payload literally says) ===
${events.map((e: any) => `- ${String(e.received_at).slice(0, 16)} ${e.source}/${e.kind || ""}: ${JSON.stringify(e.payload).slice(0, 240)}`).join("\n") || "none"}
=== CLIENT BOOK — needs attention (flag · name · kind · days silent · open promises / waiting on them · next meeting) ===
${bookRows.map((c: any) => `- ${c.flag} · ${c.name} · ${c.kind} · ${c.days_silent ?? "?"}d · ${c.open_promises}/${c.waiting_on_them}${c.next_meeting ? " · next " + String(c.next_meeting).slice(0, 10) : ""}`).join("\n") || "none flagged"}
=== HIS OPEN PROMISES TO CLIENTS (next 7 days) ===
${promiseRows.map((p: any) => `- ${p.due || "no date"} · ${p.client}: ${p.text}`).join("\n") || "none"}
(Older backfilled promises are not listed here — use lookup_client() for any named person. When he says a promise is done, call complete_task() with a few words from it — do not just log it. "Who needs follow-up?" → answer from CLIENT BOOK. "What do I owe <name>?" → ALWAYS call lookup_client first.)
=== WHERE HE IS (coarse, from context events) ===
${get("context") || "unknown"}
Today is the "Now" line below — the CURRENT STATE section carries its own date and may be a day old; when they differ, treat state facts as "as of <state date>" and never restate its date as today.
Now: ${new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" })} PT
${hits}${fixing}`;
}

const TOOLS = [
  { name: "remember", description: "Store a durable fact, preference, or correction Christopher just stated. Not for transient info.", input_schema: { type: "object", properties: { type: { type: "string", enum: ["FACT", "PREFERENCE", "COMMITMENT", "DECISION", "OPEN_QUESTION"] }, title: { type: "string" }, body: { type: "string" }, tags: { type: "array", items: { type: "string" } } }, required: ["type", "title", "body"] } },
  { name: "add_task", description: "Create a task Christopher committed to or asked Nexus to track. Always set the bucket if you can tell which business it belongs to.", input_schema: { type: "object", properties: { objective: { type: "string" }, deadline: { type: "string", description: "YYYY-MM-DD or empty" }, route: { type: "string", enum: ["principal", "delegate", "automate", "defer", "undecided"] }, impact: { type: "integer" }, urgency: { type: "integer" }, entity: { type: "string", enum: ["grind", "jbc", "powerpipeline", "personal"], description: "which bucket — omit only if you genuinely cannot tell" } }, required: ["objective"] } },
  { name: "lookup_client", description: "Look up a person in the client book: profile, last meetings, every open promise (his and theirs). Call this before answering anything about a named client, recruit, or partner.", input_schema: { type: "object", properties: { name: { type: "string", description: "name or partial name" } }, required: ["name"] } },
  { name: "complete_task", description: "Mark one of his tasks/reminders done, or push its date. Use when he says 'done with X', 'finished the playbook', 'sent it', 'move X to Friday'. Match loosely on words in the objective.", input_schema: { type: "object", properties: { match: { type: "string", description: "words from the task/promise" }, action: { type: "string", enum: ["done", "reschedule", "drop"] }, due: { type: "string", description: "YYYY-MM-DD when rescheduling" } }, required: ["match", "action"] } },
  { name: "review_task", description: "Clear one item out of the confirm queue — the promises Nexus read out of a meeting that he has never confirmed, and the ones that went cold. Use it whenever he says an item is real, is already handled, or never existed. 'keep' puts it back on his plate (pass due only if he gave a real date), 'done' closes it, 'kill' drops it. Every one of these also updates that person's card.", input_schema: { type: "object", properties: { match: { type: "string", description: "words from the item, or a person's name" }, action: { type: "string", enum: ["keep", "done", "kill"] }, due: { type: "string", description: "YYYY-MM-DD only if HE stated a date" } }, required: ["match", "action"] } },
  { name: "get_prep", description: "Get the prep pack and client context for a promise/task he is working on: what he promised verbatim, the client's own facts from the transcript, prior research, open questions, where to look. Call this FIRST whenever he asks about or starts working on a specific item.", input_schema: { type: "object", properties: { match: { type: "string", description: "words from the promise, or a client name" } }, required: ["match"] } },
  { name: "save_prep", description: "Save or update the prep pack for a promise after working through it with him — the framework, what to pull, the approach chosen, open questions. Keeps it in the client's folder for next time.", input_schema: { type: "object", properties: { match: { type: "string", description: "words identifying the promise" }, client_facts: { type: "string" }, research: { type: "string", description: "the framework, mechanism, checklist you gave him" }, open_questions: { type: "string" }, where_to_look: { type: "string" } }, required: ["match"] } },
  { name: "learn", description: "File something durable Christopher just taught you into the brain: how a business works, who someone is, how he wants something done, a rule of his trade, a number or a name that will matter again. This is how Nexus grows — use it liberally whenever he explains something, not only when he says 'remember'. Mark it inferred if you worked it out rather than heard it.", input_schema: { type: "object", properties: { entity: { type: "string", enum: ["grind", "jbc", "powerpipeline", "personal", "all"], description: "which bucket this belongs to; 'all' for something that spans everything" }, topic: { type: "string", description: "short subject, e.g. 'pricing', 'who runs ops', 'permit process'" }, fact: { type: "string", description: "the thing itself, one sentence" }, detail: { type: "string" }, stated_or_inferred: { type: "string", enum: ["stated", "inferred"] } }, required: ["entity", "topic", "fact"] } },
  { name: "recall", description: "Pull everything Nexus knows about a bucket or a topic before answering. Call this whenever he asks about one of his businesses.", input_schema: { type: "object", properties: { entity: { type: "string", enum: ["grind", "jbc", "powerpipeline", "personal", "all"] }, topic: { type: "string", description: "optional keyword filter" } }, required: ["entity"] } },
  { name: "find_help", description: "THE BLACK BOOK. Search everyone Christopher knows by what they can DO for him — capital, crews, licences, an audience, a market, a skill, an introduction. Call this whenever he asks 'who do I know who…', 'who can help me with…', 'who has…', 'who should I call about…', or whenever he hits a problem someone in his book could solve. Also call it unprompted when you spot a match he has not seen.", input_schema: { type: "object", properties: { need: { type: "string", description: "what he needs, in plain words — 'commercial lender', 'Spanish speaking clients', 'electricians in San Diego', 'accredited investor'" } }, required: ["need"] } },
  { name: "card", description: "Pull one person's baseball card from the Black Book: who they are, their superpower, what they control, how they can benefit him, what he can do for them, the ask, and what each of them owes the other. Call this before he meets, calls, or texts anyone.", input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "log_person", description: "Add or update someone in the Black Book. Use this the moment he mentions a new person — someone he met, was referred to, or is about to meet — even in passing. Fill in only what he actually said; leave the rest out and ask him for the gaps later. Everyone he comes across belongs in the book, client or not.", input_schema: { type: "object", properties: { name: { type: "string" }, kind: { type: "string", enum: ["client", "prospect", "recruit", "partner", "vendor", "investor", "operator", "referral", "connector", "mentor", "friend", "family", "contact", "other"] }, entity: { type: "string", enum: ["grind", "jbc", "powerpipeline", "personal"] }, company: { type: "string" }, role: { type: "string" }, headline: { type: "string", description: "one line: who they are in his world" }, met_where: { type: "string" }, met_through: { type: "string" }, superpower: { type: "string" }, controls: { type: "string", description: "what they actually have: capital, crews, licences, audience, relationships, territory" }, value_to_me: { type: "string", description: "concretely how they can benefit him" }, value_to_them: { type: "string" }, the_ask: { type: "string" }, offers: { type: "array", items: { type: "string" }, description: "short searchable phrases for what they can provide" }, needs: { type: "array", items: { type: "string" } } }, required: ["name"] } },
  { name: "fix_card", description: "Correct someone's card when Christopher tells you something is wrong — a misspelled name, the wrong company or role, a bad read on what they do, a wrong bucket. Anything he corrects is stated fact: it overwrites what was there and the card becomes confirmed. Use this the instant he says 'it's spelled…', 'that's wrong', 'he's actually…', 'she's not a…'. Do not just agree with him — fix it.", input_schema: { type: "object", properties: { match: { type: "string", description: "the name currently on the card" }, new_name: { type: "string", description: "corrected spelling / full name, only if the name itself is wrong" }, kind: { type: "string" }, entity: { type: "string", enum: ["grind", "jbc", "powerpipeline", "personal"] }, entities: { type: "array", items: { type: "string" }, description: "every bucket they touch, if more than one" }, company: { type: "string" }, role: { type: "string" }, city: { type: "string" }, state: { type: "string" }, email: { type: "string" }, phone: { type: "string" }, headline: { type: "string" }, superpower: { type: "string" }, controls: { type: "string" }, value_to_me: { type: "string" }, value_to_them: { type: "string" }, the_ask: { type: "string" }, interests: { type: "string" }, relationship_strength: { type: "integer" }, trust: { type: "integer" }, offers: { type: "array", items: { type: "string" }, description: "capabilities to add as stated fact" }, remove_offers: { type: "array", items: { type: "string" }, description: "capabilities that were wrong" }, stage: { type: "string", description: "set to 'archived' to drop someone out of the book entirely" }, clear: { type: "array", items: { type: "string" }, description: "field names to empty out when he says something is simply wrong — e.g. [\"city\",\"role\"]" } }, required: ["match"] } },
  { name: "merge_people", description: "Two records are the same person or the same thing. Merges meetings, promises, prep, capabilities and connections into one and deletes the duplicate. Use when he says 'those are the same', 'that's just X', or you spot an obvious duplicate — but confirm with him before merging, it cannot be undone.", input_schema: { type: "object", properties: { from: { type: "string", description: "the record to absorb and delete" }, into: { type: "string", description: "the record to keep" } }, required: ["from", "into"] } },
  { name: "save_project", description: "Create or update one of his projects — a named piece of ongoing work under a bucket, that tasks, notes, meetings and email attach to. Use it when he describes something he is building or running that will span more than a few days, and when he tells you where a project stands. Pass the exact existing name to update.", input_schema: { type: "object", properties: { name: { type: "string" }, entity: { type: "string", enum: ["grind", "jbc", "powerpipeline", "personal"] }, status: { type: "string", enum: ["idea", "active", "paused", "done", "dropped"] }, purpose: { type: "string", description: "why it exists, one line" }, outcome: { type: "string", description: "what done looks like" }, next_step: { type: "string", description: "the very next physical action" }, health: { type: "string", enum: ["green", "amber", "red", "unknown"] }, due: { type: "string", description: "YYYY-MM-DD" } }, required: ["name"] } },
  { name: "resolve_inbox", description: "Clear something out of his inbox queue once he has handled it or told you it does not need him. Match on the sender or a few words of the subject.", input_schema: { type: "object", properties: { match: { type: "string", description: "sender or words from the subject" }, action: { type: "string", enum: ["done", "snooze", "task"], description: "done = handled; snooze = push it down; task = turn it into a task on his plate" } }, required: ["match", "action"] } },
  { name: "log", description: "Record an action Nexus took or a draft it produced.", input_schema: { type: "object", properties: { action: { type: "string" }, result: { type: "string", enum: ["executed", "drafted", "recommended", "needs_approval", "skipped"] } }, required: ["action", "result"] } },
];

const PREPCTX: { match?: string; commitment_id?: string; client_id?: string; saved?: boolean } = {};
async function runTool(name: string, input: any, chat_id: string) {
  const day = new Date().toISOString().slice(0, 10);
  if (name === "remember") {
    await rpc("insert", { table: "memories", rows: [{ vault_path: `telegram/${day}-${crypto.randomUUID().slice(0, 8)}.md`, type: input.type, title: input.title.slice(0, 200), body: input.body, source: "principal_stated", stated_or_inferred: "stated", confidence: 0.9, importance: 4, status: "active", tags: [...(input.tags || []), "telegram", "unfiled"] }] });
    return "stored (vault sync will file it)";
  }
  if (name === "add_task") {
    const ent = ["grind", "jbc", "powerpipeline", "personal"].includes(String(input.entity)) ? String(input.entity) : null;
    await rpc("insert", { table: "tasks", rows: [{ objective: input.objective, deadline: input.deadline || null, route: input.route || "undecided", impact: input.impact || 3, urgency: input.urgency || 3, status: "next", source: "telegram", source_ref: chat_id, entity: ent }] });
    return `task created${ent ? ` in ${ent}` : " — no bucket set, ask him which business this is"}`;
  }
  if (name === "learn") {
    const ent = ["grind", "jbc", "powerpipeline", "personal"].includes(String(input.entity)) ? String(input.entity) : null;
    try {
      await rpc("insert", { table: "knowledge", rows: [{ entity: ent, topic: String(input.topic).slice(0, 120), fact: String(input.fact).slice(0, 1000), detail: input.detail || null, source: "christopher", source_ref: `telegram/${day}`, stated_or_inferred: input.stated_or_inferred === "inferred" ? "inferred" : "stated", confidence: input.stated_or_inferred === "inferred" ? 0.6 : 1.0 }] });
    } catch (_e) { return "already knew that — nothing added"; }
    return `learned (${ent || "all"} · ${input.topic})`;
  }
  if (name === "recall") {
    const e = String(input.entity || "all");
    const w = [e === "all" ? "status = 'active'" : `status = 'active' and (entity = '${e.replace(/'/g, "''")}' or entity is null)`];
    if (input.topic) { const t = String(input.topic).toLowerCase().replace(/'/g, "''"); w.push(`(lower(topic) like '%${t}%' or lower(fact) like '%${t}%')`); }
    const rows = await sel("knowledge", w.join(" and "), "topic", 40);
    if (!rows.length) return `nothing filed for ${e} yet — this is a gap, tell him you don't know it and ask`;
    return rows.map((k: any) => `[${k.entity || "all"}] ${k.topic}: ${k.fact}${k.detail ? " — " + k.detail : ""}${k.stated_or_inferred === "inferred" ? ` (INFERRED ${k.confidence})` : ""}`).join("\n");
  }
  if (name === "lookup_client") {
    const q = String(input.name || "").trim().toLowerCase().replace(/'/g, "''");
    const cs = await sel("v_client_book", `lower(name) like '%${q}%'`, undefined, 3);
    if (!cs.length) return "no one matching that name in the client book";
    const out: string[] = [];
    for (const c of cs) {
      const ms = await sel("client_meetings", `client_id = '${c.id}'`, "met_at desc", 3);
      const ps = await sel("commitments", `client_id = '${c.id}' and status = 'open'`, "due", 20);
      out.push(`${c.name} (${c.kind}${c.company ? ", " + c.company : ""}) — flag: ${c.flag}; last contact ${c.last_contact || "?"}; next meeting ${c.next_meeting || "none"}; ${c.meetings} meetings.\nSummary: ${c.summary || "-"}\nRecent: ${ms.map((m: any) => `${String(m.met_at).slice(0, 10)} ${m.title || ""}: ${(m.outcome || m.summary || "").slice(0, 200)}`).join(" | ") || "-"}\nHis promises: ${ps.filter((p: any) => p.owner === "Christopher").map((p: any) => `[${p.due || "no date"}] ${p.text}`).join("; ") || "none"}\nWaiting on them: ${ps.filter((p: any) => p.owner !== "Christopher").map((p: any) => `[${p.due || "no date"}] ${p.owner}: ${p.text}`).join("; ") || "none"}`);
    }
    return out.join("\n---\n");
  }
  if (name === "review_task") {
    const STOP = new Set(["the","a","an","and","or","for","to","with","of","on","in","my","his","her","their","it","that","this","please","about","re"]);
    const words = String(input.match || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/)
      .filter((w: string) => w.length > 2 && !STOP.has(w)).slice(0, 6);
    if (!words.length) return "FAILED: could not pick out identifying words. Ask him which item, verbatim.";
    const like = (c: string) => words.map((w: string) => `lower(${c}) like '%${w.replace(/'/g, "''")}%'`).join(" and ");
    let rows = await sel("v_confirm_queue", `(${like("objective")})`, "age_days desc", 6);
    if (!rows.length) rows = await sel("v_confirm_queue", `(${like("coalesce(person,'')")})`, "age_days desc", 12);
    if (!rows.length) return `FAILED: nothing in the confirm queue matching "${input.match}". Nothing changed.`;
    if (rows.length > 1) return `FAILED: ${rows.length} match and nothing changed: ${rows.map((r: any) => `${r.objective} (${r.person || "no person"}, ${r.age_days}d)`).join(" | ")} — ask him which one.`;
    const r = rows[0];
    const act = String(input.action || "");
    const due = /^\d{4}-\d{2}-\d{2}$/.test(String(input.due || "")) ? String(input.due) : null;
    const out = await fn("app_task_review", { p_id: r.id, p_action: act, p_due: due });
    if (!out || out.error) return `FAILED: ${out?.error || "nothing changed"}. Tell him plainly that nothing was updated.`;
    const verb = act === "kill" ? "dropped" : act === "done" ? "closed" : "back on your plate";
    return `DONE: "${r.objective}" — ${verb}${due ? `, due ${due}` : ""}. ${r.person ? r.person + "'s card was updated. " : ""}${out.remaining} left in the confirm queue. Say this exact item back to him.`;
  }
  if (name === "complete_task") {
    const STOP = new Set(["the","a","an","and","or","for","to","with","of","on","in","my","his","her","their","it","that","this","done","finished","sent","did","just","already","please","link","about","re"]);
    const words = String(input.match || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/)
      .filter((w: string) => w.length > 2 && !STOP.has(w)).slice(0, 6);
    if (!words.length) return "FAILED: could not pick out identifying words. Ask him which item, verbatim.";
    const where = "status not in ('done','eliminated') and " + words.map((w: string) => `lower(objective) like '%${w.replace(/'/g, "''")}%'`).join(" and ");
    let cands = await sel("tasks", where, "deadline", 6);
    if (!cands.length && words.length > 2) {
      const loose = "status not in ('done','eliminated') and (" + words.map((w: string) => `lower(objective) like '%${w.replace(/'/g, "''")}%'`).join(" or ") + ")";
      const all = await sel("tasks", loose, "deadline", 20);
      const score = (t: any) => words.filter((w: string) => String(t.objective).toLowerCase().includes(w)).length;
      const best = all.map((t: any) => ({ t, n: score(t) })).sort((a, b) => b.n - a.n);
      if (best.length && best[0].n >= Math.max(2, words.length - 1) && (best.length === 1 || best[0].n > best[1].n)) cands = [best[0].t];
      else if (best.length) return `FAILED: no single match. Closest: ${best.slice(0, 3).map((b) => b.t.objective).join(" | ")} — ask him which one, and tell him nothing was closed.`;
    }
    if (!cands.length) return `FAILED: nothing open matching "${input.match}". Nothing was changed. Tell him it was not found and ask for the client name.`;
    if (cands.length > 1) return `FAILED: ${cands.length} match and nothing was changed: ${cands.map((t: any) => t.objective).join(" | ")} — ask him which one.`;
    const t = cands[0];
    if (input.action === "done") {
      await rpc("update", { table: "tasks", set: { status: "done", completed_at: new Date().toISOString() }, where: `id = '${t.id}'` });
      return `DONE: "${t.objective}" is closed. The client promise closed with it; it clears from Apple Reminders at the next sync. Confirm this exact item back to him.`;
    }
    if (input.action === "drop") {
      await rpc("update", { table: "tasks", set: { status: "eliminated" }, where: `id = '${t.id}'` });
      return `DROPPED: "${t.objective}".`;
    }
    const d = String(input.due || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return "FAILED: need a date (YYYY-MM-DD). Nothing was changed.";
    await rpc("update", { table: "tasks", set: { deadline: d, status: "next" }, where: `id = '${t.id}'` });
    return `MOVED to ${d}: "${t.objective}".`;
  }
  if (name === "get_prep" || name === "save_prep") {
    const STOP2 = new Set(["the","a","an","and","or","for","to","with","of","on","in","my","his","her","their","it","that","this","about","need","help"]);
    const w = String(input.match || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((x: string) => x.length > 2 && !STOP2.has(x)).slice(0, 5);
    if (!w.length) return "need a few identifying words";
    const esc = (x: string) => x.replace(/'/g, "''");
    const byText = "status = 'open' and owner = 'Christopher' and (" + w.map((x: string) => `lower(text) like '%${esc(x)}%'`).join(" and ") + ")";
    let ms = await sel("v_open_promises", byText, "due", 5);
    if (!ms.length) ms = await sel("v_open_promises", "status = 'open' and owner = 'Christopher' and (" + w.map((x: string) => `lower(client) like '%${esc(x)}%'`).join(" or ") + ")", "due", 8);
    if (!ms.length) return `nothing open matching "${input.match}"`;
    if (name === "get_prep" && ms.length === 1) { PREPCTX.match = input.match; PREPCTX.commitment_id = ms[0].id; PREPCTX.saved = false; const cx = await sel("clients", `lower(name) = lower('${esc(ms[0].client)}')`, undefined, 1); PREPCTX.client_id = cx[0]?.id; }
    if (name === "save_prep") {
      if (ms.length > 1) return `${ms.length} match: ${ms.map((m: any) => m.client + ": " + m.text).join(" | ")} — ask which one before saving.`;
      const m = ms[0];
      const cs = await sel("clients", `lower(name) = lower('${esc(m.client)}')`, undefined, 1);
      const row: any = { commitment_id: m.id, client_id: cs[0]?.id, title: `${m.client}: ${String(m.text).slice(0, 140)}`, what_was_promised: m.text, built_for: m.due || null, status: "ready" };
      for (const k of ["client_facts", "research", "open_questions", "where_to_look"]) if (input[k]) row[k] = String(input[k]).slice(0, 8000);
      await rpc("upsert", { table: "prep_packs", on_conflict: "commitment_id", rows: [row] });
      PREPCTX.saved = true;
      return `SAVED prep for "${m.text}" (${m.client}). Tell him it is filed and will come back with the reminder.`;
    }
    const out: string[] = [];
    for (const m of ms.slice(0, 3)) {
      const packs = await sel("prep_packs", `commitment_id = '${m.id}'`, undefined, 1);
      const p = packs[0];
      const cs = await sel("v_client_book", `lower(name) = lower('${esc(m.client)}')`, undefined, 1);
      const c = cs[0];
      let recent = "";
      if (c) {
        const mm = await sel("client_meetings", `client_id = '${c.id}'`, "met_at desc", 2);
        recent = mm.map((x: any) => `${String(x.met_at).slice(0, 10)}: ${(x.summary || x.outcome || "").slice(0, 700)}`).join("\n");
      }
      out.push([
        `PROMISE: ${m.text}`,
        `CLIENT: ${m.client}${c ? ` (${c.kind}) · last contact ${c.last_contact || "?"} · next meeting ${c.next_meeting || "none"} · folder ${c.drive_folder_url || "none"}` : ""}`,
        `DUE: ${m.due || "no date"}${m.promised_at ? ` · promised ${String(m.promised_at).slice(0, 10)} in "${m.meeting || ""}"` : ""}`,
        `THEIR OWN WORDS (from the meeting record): ${recent || "none on file"}`,
        p ? `PRIOR PREP:\nfacts: ${p.client_facts || "-"}\nresearch: ${p.research || "-"}\nopen: ${p.open_questions || "-"}\nwhere: ${p.where_to_look || "-"}` : "PRIOR PREP: none yet — build it with him now, then save_prep().",
      ].join("\n"));
    }
    return out.join("\n===\n");
  }
  if (name === "find_help") {
    const rows = await fn("find_people", { q: String(input.need || ""), limit: 10 });
    if (!Array.isArray(rows) || !rows.length) return `nobody in the Black Book matches "${input.need}". Say so plainly and ask if there is someone he has not told you about yet.`;
    return rows.map((r: any) => `${r.name} (${r.kind}, ${r.bucket}) — ${r.why || r.headline || "?"}${r.the_ask ? `\n  ASK: ${r.the_ask}` : ""}${r.days_silent != null ? `  · ${r.days_silent}d since contact` : ""}`).join("\n");
  }
  if (name === "card") {
    const q = String(input.name || "").trim().toLowerCase().replace(/'/g, "''");
    const ps = await sel("v_black_book", `lower(name) like '%${q}%'`, undefined, 3);
    if (!ps.length) return `no card for "${input.name}". Offer to start one with log_person.`;
    const out: string[] = [];
    for (const p of ps) {
      const links = await sel("person_links", `from_person = '${p.id}'`, undefined, 10);
      const names: string[] = [];
      for (const l of links.slice(0, 8)) {
        const t = await sel("clients", `id = '${l.to_person}'`, undefined, 1);
        if (t[0]) names.push(`${t[0].name}${l.kind && l.kind !== "knows" ? ` (${l.kind})` : ""}`);
      }
      out.push([
        `${p.name} — ${p.headline || p.summary || "no headline yet"}`,
        `${p.kind} · ${p.bucket}${p.entities?.length > 1 ? ` (+${p.entities.filter((e: string) => e !== p.entity).join(", ")})` : ""}${p.company ? ` · ${p.company}` : ""}${p.role ? ` · ${p.role}` : ""}${p.city ? ` · ${p.city}${p.state ? ", " + p.state : ""}` : ""}`,
        p.superpower ? `SUPERPOWER: ${p.superpower}` : "",
        p.controls ? `CONTROLS: ${p.controls}` : "",
        p.value_to_me ? `VALUE TO HIM: ${p.value_to_me}` : "",
        p.value_to_them ? `VALUE TO THEM: ${p.value_to_them}` : "",
        p.the_ask ? `THE ASK: ${p.the_ask}` : "",
        p.offers?.length ? `OFFERS: ${p.offers.join(" · ")}` : "",
        p.needs?.length ? `NEEDS: ${p.needs.join(" · ")}` : "",
        names.length ? `CONNECTED TO: ${names.join(", ")}` : "",
        `RELATIONSHIP: strength ${p.relationship_strength ?? "?"}/5, trust ${p.trust ?? "?"}/5 · last contact ${p.last_contact || "?"}${p.days_silent != null ? ` (${p.days_silent}d)` : ""} · ${p.meetings} meetings`,
        `LEDGER: he owes them ${p.i_owe}, they owe him ${p.they_owe}${p.reciprocity ? ` — ${p.reciprocity}` : ""}`,
        p.interests ? `HOOKS: ${p.interests}` : "",
        p.met_where ? `MET: ${p.met_where}${p.met_through ? ` via ${p.met_through}` : ""}` : "",
        p.card_status === "drafted" ? "(card is DRAFTED from meeting records, not confirmed by him — read the judgement calls back as inferences)" : "",
      ].filter(Boolean).join("\n"));
    }
    return out.join("\n---\n");
  }
  if (name === "log_person") {
    const caps = [
      ...(input.offers || []).map((l: string) => ({ direction: "offers", label: l, stated_or_inferred: "stated" })),
      ...(input.needs || []).map((l: string) => ({ direction: "needs", label: l, stated_or_inferred: "stated" })),
    ];
    const body: any = { source: "christopher", source_ref: `telegram/${day}`, card_status: "drafted", capabilities: caps };
    for (const k of ["name", "kind", "entity", "company", "role", "headline", "met_where", "met_through",
      "superpower", "controls", "value_to_me", "value_to_them", "the_ask"]) if (input[k]) body[k] = input[k];
    const r = await fn("record_person", body);
    if (r?.skipped) return "that person is on his excluded list — nothing was added, and do not bring them up.";
    return `filed in the Black Book${r?.entity ? ` under ${r.entity}` : ""}${caps.length ? `, ${caps.length} capabilities` : ""}. Tell him what is still blank and ask for one of the gaps.`;
  }
  if (name === "fix_card") {
    const body: any = {};
    for (const k of ["match", "new_name", "kind", "entity", "company", "role", "city", "state", "email", "phone",
      "headline", "superpower", "controls", "value_to_me", "value_to_them", "the_ask", "interests", "stage"])
      if (input[k]) body[k] = input[k];
    for (const k of ["relationship_strength", "trust"]) if (input[k] != null) body[k] = input[k];
    for (const k of ["entities", "offers", "remove_offers", "clear"]) if (Array.isArray(input[k]) && input[k].length) body[k] = input[k];
    const r = await fn("fix_person", body);
    if (r?.error) return `FAILED: ${r.error}${r.matches ? " — " + JSON.stringify(r.matches) : ""}. Nothing was changed.`;
    if (!r?.changed || !r.changed.length) return `FAILED: nothing was changed on ${r?.name || input.match}. Ask him which field and what it should say.`;
    return `FIXED ${r.name}: ${r.changed.join(", ")}. Card is now ${r.card_status}. Confirm back to him exactly what changed.`;
  }
  if (name === "merge_people") {
    const r = await fn("merge_people", { from: input.from, into: input.into });
    if (r?.error) return `FAILED: ${r.error}. Nothing was merged.`;
    return `MERGED "${r.merged}" into "${r.into}" — meetings, promises, prep, capabilities and connections all moved. The duplicate is gone.`;
  }
  if (name === "save_project") {
    const body: any = { name: String(input.name || "").trim() };
    if (!body.name) return "FAILED: a project needs a name.";
    for (const k of ["entity", "status", "purpose", "outcome", "next_step", "health", "due"]) if (input[k]) body[k] = input[k];
    const existing = await sel("projects", `lower(name) = lower('${body.name.replace(/'/g, "''")}')`, undefined, 1);
    if (existing[0]) body.id = existing[0].id;
    try {
      await rpc("insert", { table: "action_log", rows: [{ action: `project ${existing[0] ? "updated" : "created"}: ${body.name}`, result: "executed", tool: "nexus-brain/project", autonomy_level: 4, category: "projects", idempotency_key: `proj-${Date.now()}` }] });
      const c = await nexusCfg();
      const r = await fetch(`${c.url}/rest/v1/rpc/nexus_call`, { method: "POST", headers: { apikey: c.anon, Authorization: `Bearer ${c.anon}`, "Content-Type": "application/json" }, body: JSON.stringify({ fn: "app_project_save", secret: c.rpc, args: body }) });
      if (!r.ok) return `FAILED: ${(await r.text()).slice(0, 160)}`;
    } catch (e) { return `FAILED: ${(e as Error).message.slice(0, 160)}`; }
    return `${existing[0] ? "UPDATED" : "CREATED"} project "${body.name}"${body.entity ? ` in ${body.entity}` : ""}. Tell him what is on it now and ask for the next step if he has not given one.`;
  }
  if (name === "resolve_inbox") {
    const q = String(input.match || "").toLowerCase().replace(/'/g, "''");
    if (q.length < 3) return "FAILED: need a few words to match on.";
    const rows = await sel("v_inbox_triage", `lower(coalesce(sender,'') || ' ' || coalesce(subject,'')) like '%${q}%'`, "score desc", 4);
    if (!rows.length) return `FAILED: nothing in the inbox matches "${input.match}". Nothing was changed.`;
    if (rows.length > 1) return `FAILED: ${rows.length} match and nothing was changed: ${rows.map((r: any) => `${r.sender} — ${r.subject}`).join(" | ")} — ask him which.`;
    const c = await nexusCfg();
    const r = await fetch(`${c.url}/rest/v1/rpc/nexus_call`, { method: "POST", headers: { apikey: c.anon, Authorization: `Bearer ${c.anon}`, "Content-Type": "application/json" }, body: JSON.stringify({ fn: "app_inbox_action", secret: c.rpc, args: { p_id: rows[0].id, p_action: input.action } }) });
    if (!r.ok) return `FAILED: ${(await r.text()).slice(0, 160)}`;
    return `${String(input.action).toUpperCase()}: "${rows[0].subject || rows[0].sender}" is out of the queue.`;
  }
  if (name === "log") {
    await rpc("insert", { table: "action_log", rows: [{ action: input.action, result: input.result, tool: "nexus-brain/telegram", autonomy_level: 2, category: "chat", idempotency_key: `tg-${Date.now()}-${crypto.randomUUID().slice(0, 6)}` }] });
    return "logged";
  }
  return "unknown tool";
}

async function claude(system: string, messages: any[], chat_id: string): Promise<string> {
  let msgs = messages;
  for (let i = 0; i < 4; i++) {
    const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": CLAUDE_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify({ model: MODEL, max_tokens: 2000, system, tools: TOOLS, messages: msgs }) });
    const j = await r.json();
    if (!r.ok) throw new Error(`Claude ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
    const uses = (j.content || []).filter((c: any) => c.type === "tool_use");
    const text = (j.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n").trim();
    if (!uses.length || j.stop_reason !== "tool_use") return text || "(no reply)";
    const results = [];
    for (const u of uses) results.push({ type: "tool_result", tool_use_id: u.id, content: await runTool(u.name, u.input, chat_id) });
    msgs = [...msgs, { role: "assistant", content: j.content }, { role: "user", content: results }];
  }
  return "(tool loop limit)";
}

async function autoFilePrep(reply: string) {
  // Never lose thinking he already paid for: if she pulled a prep pack and did not save one, file the reply.
  if (!PREPCTX.commitment_id || PREPCTX.saved || reply.length < 400) { PREPCTX.commitment_id = undefined; return; }
  try {
    const ms = await sel("v_open_promises", `id = '${PREPCTX.commitment_id}'`, undefined, 1);
    const m = ms[0];
    if (m) {
      const existing = await sel("prep_packs", `commitment_id = '${m.id}'`, undefined, 1);
      const prior = existing[0]?.research ? existing[0].research + "\n\n--- later session ---\n" : "";
      await rpc("upsert", { table: "prep_packs", on_conflict: "commitment_id", rows: [{ commitment_id: m.id, client_id: PREPCTX.client_id, title: `${m.client}: ${String(m.text).slice(0, 140)}`, what_was_promised: m.text, built_for: m.due || null, status: "ready", research: (prior + reply).slice(0, 12000) }] });
      await rpc("insert", { table: "action_log", rows: [{ action: `prep pack auto-filed: ${m.client} — ${String(m.text).slice(0, 100)}`, result: "executed", tool: "nexus-brain/prep", autonomy_level: 4, category: "prep", idempotency_key: `prep-${m.id}-${Date.now()}` }] });
    }
  } catch (_e) { /* never break the reply over filing */ }
  PREPCTX.commitment_id = undefined; PREPCTX.saved = false;
}

// New work landed → tell him, grouped by bucket. Runs after every brain turn and on the hourly sweep.
async function drainNotifications(force = false): Promise<{ sent: number; text?: string }> {
  if (!BOT_TOKEN || !CHAT_ID) return { sent: 0 };
  const rows = await sel("notifications", "sent_at is null", "created_at", 40);
  if (!rows.length) return { sent: 0 };
  const urgent = rows.some((r: any) => r.priority === "urgent");
  // hold non-urgent single items for the sweep so she doesn't nag mid-conversation
  if (!force && !urgent && rows.length < 3) return { sent: 0 };
  const byBucket = new Map<string, any[]>();
  for (const r of rows) {
    const k = r.entity || "unsorted";
    if (!byBucket.has(k)) byBucket.set(k, []);
    byBucket.get(k)!.push(r);
  }
  const NAME: Record<string, string> = { grind: "GRIND Agencies", jbc: "JBC Management", powerpipeline: "PowerPipeline", personal: "Personal", unsorted: "Unsorted — tell me which business" };
  const parts = [`${rows.length} new on your plate${urgent ? " — one is due now" : ""}:`];
  for (const [k, list] of byBucket) {
    parts.push(`\n${NAME[k] || k} (${list.length})`);
    for (const n of list.slice(0, 8)) parts.push(`• ${String(n.title).replace(/^[^:]+: /, "")}${n.body ? " — " + n.body : ""}`);
    if (list.length > 8) parts.push(`  …and ${list.length - 8} more`);
  }
  parts.push(`\nSay "done <a few words>" to close one, or ask me about any of them.`);
  const text = parts.join("\n");
  await send(CHAT_ID, text);
  const ids = rows.map((r: any) => `'${r.id}'`).join(",");
  await rpc("update", { table: "notifications", set: { sent_at: new Date().toISOString(), channel: "telegram" }, where: `id in (${ids})` });
  return { sent: rows.length, text };
}

async function handleChat(chat_id: string, text: string) {
  await rpc("insert", { table: "conversations", rows: [{ channel: "telegram", chat_id, role: "user", content: text }] });
  const hist = await sel("conversations", `chat_id = '${chat_id}'`, "ts desc", 16);
  const messages = hist.reverse().map((h: any) => ({ role: h.role, content: h.content }));
  if (!messages.length || messages[messages.length - 1].role !== "user") messages.push({ role: "user", content: text });
  const system = await buildSystem(text);
  let reply: string;
  try { reply = await claude(system, messages, chat_id); } catch (e) { reply = `Nexus error: ${(e as Error).message.slice(0, 200)}`; }
  await rpc("insert", { table: "conversations", rows: [{ channel: "telegram", chat_id, role: "assistant", content: reply }] });
  await autoFilePrep(reply);
  await send(chat_id, reply);
  try { await drainNotifications(); } catch (_e) { /* never break the reply over a notice */ }
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const cfg = await nexusCfg();
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const authed = bearer === cfg.rpc;

  if (req.method !== "POST") return new Response("nexus-brain", { status: 200 });

  if (url.searchParams.get("diag")) {
    if (!authed) return new Response("unauthorized", { status: 401 });
    const me = BOT_TOKEN ? await tg("getMe", {}) : { ok: false, error: "no token" };
    return Response.json({ has_bot_token: !!BOT_TOKEN, has_chat_id: !!CHAT_ID, has_claude_key: !!CLAUDE_KEY, model: MODEL, telegram_getMe: me, nexus_cfg: { url: cfg.url, anon: !!cfg.anon, rpc: !!cfg.rpc } });
  }
  if (url.searchParams.get("chat")) {  // direct brain access (iOS Shortcut / voice / web): {text}
    if (!authed) return new Response("unauthorized", { status: 401 });
    const b = await req.json();
    const chat_id = String(b.chat_id || CHAT_ID || "direct");
    const text = String(b.text || b.message || "");
    if (!text) return Response.json({ error: "missing text" }, { status: 400 });
    await rpc("insert", { table: "conversations", rows: [{ channel: b.channel || "direct", chat_id, role: "user", content: text }] });
    const hist = await sel("conversations", `chat_id = '${chat_id}'`, "ts desc", 16);
    const messages = hist.reverse().map((h: any) => ({ role: h.role, content: h.content }));
    let reply: string;
    try { reply = await claude(await buildSystem(text), messages, chat_id); } catch (e) { reply = `Nexus error: ${(e as Error).message.slice(0, 300)}`; }
    await rpc("insert", { table: "conversations", rows: [{ channel: b.channel || "direct", chat_id, role: "assistant", content: reply }] });
    await autoFilePrep(reply);
    return Response.json({ reply });
  }
  if (url.searchParams.get("reminders")) {
    // Two-way Apple Reminders sync (iOS/macOS Shortcut). Body: {reminders:[{title,due?,completed?,notes?,list?}]}
    // Key = title (case-insensitive). Returns tasks the Shortcut should create as reminders (open in Nexus, absent in Reminders).
    if (!authed) return new Response("unauthorized", { status: 401 });
    const b = await req.json();
    let rems: any[] = Array.isArray(b.reminders) ? b.reminders : [];
    if (typeof b.lines === "string") {  // Shortcut-friendly: one reminder per line "title | yyyy-MM-dd | Yes/No"
      rems = b.lines.split(/\r?\n/).map((ln: string) => ln.split("|").map((x) => x.trim())).filter((f: string[]) => f[0])
        .map((f: string[]) => ({ title: f[0], due: (f[1] || "").match(/^\d{4}-\d{2}-\d{2}/) ? f[1].slice(0, 10) : "", completed: /^(yes|true|1)$/i.test(f[2] || ""), list: b.list || "Nexus" }));
    }
    const norm = (t: string) => String(t || "").trim().toLowerCase();
    const q = (s: string) => s.replace(/'/g, "''");
    const openTasks: any[] = await sel("tasks", "status not in ('done','eliminated','deferred') and review_state = 'live'", "created_at desc", 300);
    const doneRecent: any[] = await sel("tasks", "status = 'done' and completed_at > now() - interval '7 days'", undefined, 300);
    const byTitle = new Map<string, any>();
    for (const t of [...doneRecent, ...openTasks]) byTitle.set(norm(t.objective), t);
    let created = 0, completed = 0, updated = 0;
    const seen = new Set<string>();
    for (const r of rems) {
      const key = norm(r.title); if (!key) continue; seen.add(key);
      const due = r.due ? String(r.due).slice(0, 10) : null;
      const t = byTitle.get(key);
      if (!t) {
        if (r.completed) continue;
        await rpc("insert", { table: "tasks", rows: [{ objective: String(r.title).trim(), deadline: due, status: "next", route: "undecided", source: "reminders", source_ref: r.list || "Reminders", context: r.notes || null }] });
        created++; continue;
      }
      if (r.completed && t.status !== "done") { await rpc("update", { table: "tasks", set: { status: "done", completed_at: new Date().toISOString() }, where: `id = '${t.id}'` }); completed++; continue; }
      if (!r.completed && due && due !== (t.deadline || null)) { await rpc("update", { table: "tasks", set: { deadline: due }, where: `id = '${t.id}'` }); updated++; }
    }
    // tasks that exist in Nexus but not in Reminders → Shortcut creates them
    const LIST: Record<string, string> = { grind: "GRIND Agencies", jbc: "JBC Management", powerpipeline: "PowerPipeline", personal: "Personal" };
    const toCreate = openTasks.filter((t) => !seen.has(norm(t.objective)) && t.owner === "Christopher").map((t) => ({ title: t.objective, due: t.deadline || "", list: LIST[t.entity as string] || "Nexus", bucket: t.entity || "unsorted", notes: `Nexus · ${LIST[t.entity as string] || "unsorted"} · ${t.route}/${t.status} · score ${t.priority_score}${t.next_action ? " · next: " + t.next_action : ""}` }));
    if (rems.length || toCreate.length) await rpc("insert", { table: "action_log", rows: [{ action: `reminders_sync: ${rems.length} in, +${created} new, ${completed} done, ${updated} dates, ${toCreate.length} to Reminders`, result: "executed", tool: "nexus-brain/reminders", autonomy_level: 4, category: "tasks", idempotency_key: `rem-${Date.now()}` }] });
    return Response.json({ ok: true, created, completed, updated, create_in_reminders: toCreate });
  }
  if (url.searchParams.get("tasks")) {
    if (!authed) return new Response("unauthorized", { status: 401 });
    const t = await sel("v_open_tasks", undefined, undefined, 50);
    return Response.json({ tasks: t.map((x: any) => ({ id: x.id, title: x.objective, due: x.deadline || "", route: x.route, status: x.status, score: x.priority_score, next_action: x.next_action || "" })) });
  }
  if (url.searchParams.get("digest")) {
    if (!authed && url.searchParams.get("key") !== cfg.rpc) return new Response("unauthorized", { status: 401 });
    const b = req.headers.get("content-type")?.includes("json") ? await req.json().catch(() => ({})) : {};
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const today = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
    const t0 = iso(today), t7 = iso(new Date(today.getTime() + 7 * 864e5));
    const [dueNow, soon, meetings, undated, queue] = await Promise.all([
      sel("v_open_tasks", `deadline <= '${t0}'`, "deadline, priority_score desc", 40),
      sel("v_open_tasks", `deadline > '${t0}' and deadline <= '${t7}'`, "deadline", 20),
      sel("v_client_book", "flag = 'meeting soon'", undefined, 8),
      sel("v_open_tasks", "deadline is null", "priority_score desc", 200).catch(() => []),
      sel("v_confirm_queue", undefined, "age_days desc", 200).catch(() => []),
    ]);
    const line = (t: any) => `• ${t.objective}${t.deadline && t.deadline < t0 ? " (was " + t.deadline + ")" : ""}`;
    const parts: string[] = [];
    parts.push(`Nexus — ${today.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}`);
    if (meetings.length) parts.push(`\nMeetings coming:\n${meetings.map((m: any) => `• ${m.name}${m.next_meeting ? " " + String(m.next_meeting).slice(0, 10) : ""}${m.open_promises ? ` — you owe them ${m.open_promises}` : ""}`).join("\n")}`);
    parts.push(`\nDue today or overdue (${dueNow.length}):\n${dueNow.slice(0, 12).map(line).join("\n") || "• nothing"}`);
    if (dueNow.length > 12) parts.push(`…and ${dueNow.length - 12} more — say "list all" for the rest.`);
    if (soon.length) parts.push(`\nThis week (${soon.length}):\n${soon.slice(0, 6).map((t: any) => `• ${t.deadline} ${t.objective}`).join("\n")}`);
    if (undated.length) parts.push(`\nNo date was agreed (${undated.length}) — you promised these, nobody set a day. Reply "date <a few words> <yyyy-mm-dd>" to put one on the calendar.`);
    if (queue.length) parts.push(`\n${queue.length} in the confirm queue — promises I read out of meetings that you never confirmed, plus ones gone cold. Not late, not owed. Say /confirm and I will walk them one person at a time.`);
    parts.push(`\nReply "done <a few words>" to close one.`);
    const text = parts.join("\n");
    if (b.preview) return Response.json({ text, due: dueNow.length, soon: soon.length });
    const r = await send(CHAT_ID, text);
    await rpc("insert", { table: "action_log", rows: [{ action: `daily digest pushed: ${dueNow.length} due, ${soon.length} this week`, result: "executed", tool: "nexus-brain/digest", autonomy_level: 4, category: "notification", idempotency_key: `digest-${t0}-${Date.now()}` }] });
    return Response.json({ ok: !!r?.ok, due: dueNow.length, soon: soon.length });
  }
  if (url.searchParams.get("setup")) {
    if (!authed) return new Response("unauthorized", { status: 401 });
    if (!BOT_TOKEN) return Response.json({ ok: false, error: "no telegram bot token — insert it into public.nexus_feed_secret as telegram_bot_token" });
    if (!CHAT_ID) {  // autodetect from the most recent message to the bot
      const u = await tg("getUpdates", { limit: 5 });
      const first = (u.result || []).map((x: any) => x.message?.chat?.id).filter(Boolean)[0];
      if (first) { CHAT_ID = String(first); await local.from("nexus_feed_secret").upsert({ name: "telegram_chat_id", value: CHAT_ID }); }
      else return Response.json({ ok: false, error: "no chat id yet — send the bot any message, then call setup again" });
    }
    const hook = `${Deno.env.get("SUPABASE_URL")}/functions/v1/nexus-brain`;
    const r = await tg("setWebhook", { url: hook, secret_token: cfg.rpc, allowed_updates: ["message"], drop_pending_updates: true });
    await tg("setMyCommands", { commands: [{ command: "today", description: "What matters today" }, { command: "needle", description: "Did we move the needle" }, { command: "plate", description: "What can you take off my plate" }, { command: "did", description: "What did Nexus do today" }, { command: "book", description: "Who needs follow-up" }, { command: "promises", description: "What I owe clients" }, { command: "reminders", description: "Due today and overdue" }, { command: "week", description: "Due in the next 7 days" }, { command: "prep", description: "Work a task through with me" }, { command: "buckets", description: "All four buckets at a glance" }, { command: "grind", description: "GRIND Agencies only" }, { command: "jbc", description: "JBC Management only" }, { command: "power", description: "PowerPipeline only" }, { command: "personal", description: "Personal only" }, { command: "learn", description: "Teach Nexus something" }, { command: "brain", description: "What Nexus knows" }, { command: "blackbook", description: "State of the Black Book" }, { command: "card", description: "Read someone's baseball card" }, { command: "who", description: "Who do I know who can…" }] });
    return Response.json({ ok: true, webhook: hook, telegram: r });
  }
  if (url.searchParams.get("contacts")) {  // Mac address book → nexus.contacts_raw (stub cards, never overwrite a real one)
    if (!authed) return new Response("unauthorized", { status: 401 });
    const b = await req.json();
    const list: any[] = Array.isArray(b.contacts) ? b.contacts : [];
    if (!list.length) return Response.json({ ok: true, received: 0 });
    const rows = list.filter((c) => String(c.name || "").trim()).map((c) => ({
      source: b.source || "apple",
      ext_id: c.id ? String(c.id) : null,
      name: String(c.name).trim().slice(0, 200),
      org: c.org ? String(c.org).slice(0, 200) : null,
      title: c.title ? String(c.title).slice(0, 200) : null,
      emails: (c.emails || []).map((x: any) => String(x).toLowerCase().trim()).filter(Boolean).slice(0, 6),
      phones: (c.phones || []).map((x: any) => String(x).trim()).filter(Boolean).slice(0, 6),
      note: c.note ? String(c.note).slice(0, 1000) : null,
      last_seen: new Date().toISOString(),
    }));
    for (let i = 0; i < rows.length; i += 50) {
      await rpc("upsert", { table: "contacts_raw", on_conflict: "source,ext_id", rows: rows.slice(i, i + 50) });
    }
    const linked = await fn("link_contacts", {});
    await rpc("insert", { table: "action_log", rows: [{ action: `contacts import: ${rows.length} from ${b.source || "apple"}`, result: "executed", tool: "nexus-brain/contacts", autonomy_level: 4, category: "blackbook", idempotency_key: `contacts-${Date.now()}` }] });
    return Response.json({ ok: true, received: rows.length, linked });
  }
  if (url.searchParams.get("messages")) {  // iMessage/SMS threads → nexus.message_threads + nexus.messages
    if (!authed) return new Response("unauthorized", { status: 401 });
    const b = await req.json();
    const threads: any[] = Array.isArray(b.threads) ? b.threads : [];
    if (!threads.length) return Response.json({ ok: true, threads: 0 });
    let msgs = 0;
    for (const t of threads) {
      const handle = String(t.handle || "").trim();
      if (!handle) continue;
      await rpc("upsert", { table: "message_threads", on_conflict: "source,handle", rows: [{
        source: b.source || "imessage", handle,
        display_name: t.display_name ? String(t.display_name).slice(0, 200) : null,
        is_group: !!t.is_group,
        first_message_at: t.first_at || null, last_message_at: t.last_at || null,
        message_count: Number(t.count || 0), from_me_count: Number(t.from_me_count || 0),
        last_from_me: t.last_from_me == null ? null : !!t.last_from_me,
        updated_at: new Date().toISOString(),
      }] });
      const rows = await sel("message_threads", `source = '${(b.source || "imessage").replace(/'/g, "''")}' and handle = '${handle.replace(/'/g, "''")}'`, undefined, 1);
      const tid = rows[0]?.id;
      if (!tid || !Array.isArray(t.messages) || !t.messages.length) continue;
      const mrows = t.messages.filter((m: any) => m && m.id != null && m.at).map((m: any) => ({
        thread_id: tid, ext_id: String(m.id), sent_at: m.at,
        from_me: !!m.from_me, body: m.body ? String(m.body).slice(0, 4000) : null,
        service: m.service || null,
      }));
      for (let i = 0; i < mrows.length; i += 50) {
        await rpc("upsert", { table: "messages", on_conflict: "thread_id,ext_id", rows: mrows.slice(i, i + 50) });
      }
      msgs += mrows.length;
    }
    const linked = await fn("link_contacts", {});
    await rpc("insert", { table: "action_log", rows: [{ action: `messages import: ${threads.length} threads, ${msgs} messages`, result: "executed", tool: "nexus-brain/messages", autonomy_level: 4, category: "blackbook", idempotency_key: `msgs-${Date.now()}` }] });
    return Response.json({ ok: true, threads: threads.length, messages: msgs, linked });
  }
  if (url.searchParams.get("agent")) {
    // One of the four desks. Each sees only its own bucket and reports up to Nexus.
    if (!authed && url.searchParams.get("key") !== cfg.rpc) return new Response("unauthorized", { status: 401 });
    const b = await req.json().catch(() => ({}));
    const id = String(b.id || "").replace(/[^0-9a-f-]/g, "");
    const key = String(b.agent || "");
    const ent = String(b.entity || "");
    const work = (async () => {
      try {
        const brief = await fn("agent_brief", { entity: ent });
        const a = brief?.agent || {};
        const sys = `You are ${a.name || "a desk"} inside Nexus, Christopher Lorenz's executive operating system.

${a.brief || ""}

You do not talk to Christopher. You report to Nexus, who talks to him. Write as one desk head briefing the chief of staff: short, specific, no throat-clearing, no flattery.

Return ONLY a JSON object, no prose around it:
{
  "headline": "one sentence — the state of this bucket today, in his own plain language",
  "moved": "what actually changed since your last report, or empty string if nothing did",
  "stalled": "what has not moved and should have, with how long it has been sitting",
  "owed": "who is waiting on Christopher in this bucket, named, most exposed first",
  "needs_christopher": "the one or two things only he can decide or do, each one line",
  "body": "four to eight short lines Nexus can read out to him — the whole picture of this bucket"
}

Rules that override everything:
- Assert only what the evidence below contains. Never invent a number, a name, a date, a meeting or a promise.
- Anything you worked out rather than read, mark "I INFER" inside the sentence.
- An item with no deadline was never given one. Say "no date agreed" — never call it late, never invent urgency.
- Items in the confirm queue are NOT overdue and NOT owed. They are promises he has never confirmed or that went cold. Mention them as a count and who they belong to, nothing more.
- If your bucket is quiet, say it is quiet. A short honest report beats a padded one.
- Never mention AFD. He is out of that business.
- You cannot send anything. Never offer to.`;

        const r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "x-api-key": CLAUDE_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: JSON.stringify({ model: MODEL, max_tokens: 1600, system: sys,
            messages: [{ role: "user", content: JSON.stringify(brief).slice(0, 90000) }] }),
        });
        const j = await r.json();
        if (!r.ok) throw new Error(JSON.stringify(j).slice(0, 200));
        const text = (j.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n").trim();
        const m = text.match(/\{[\s\S]*\}/);
        if (!m) throw new Error("no json back from the desk");
        const out = JSON.parse(m[0]);
        if (id) await rpc("update", { table: "agent_reports", set: {
          status: "ready", ready_at: new Date().toISOString(),
          headline: String(out.headline || "").slice(0, 400),
          body: String(out.body || "").slice(0, 6000),
          moved: String(out.moved || "").slice(0, 2000),
          stalled: String(out.stalled || "").slice(0, 2000),
          owed: String(out.owed || "").slice(0, 2000),
          needs_christopher: String(out.needs_christopher || "").slice(0, 2000),
          numbers: brief?.counts || null,
        }, where: `id = '${id}'` });
        await rpc("update", { table: "agents", set: { last_run_at: new Date().toISOString() }, where: `key = '${key.replace(/'/g, "''")}'` });
        await rpc("insert", { table: "action_log", rows: [{ action: `${a.name || key} reported`, result: "executed", tool: "nexus-brain/agent", autonomy_level: 4, category: "briefing", idempotency_key: `desk-${key}-${Date.now()}` }] });
      } catch (e) {
        if (id) await rpc("update", { table: "agent_reports", set: { status: "failed", error: (e as Error).message.slice(0, 400) }, where: `id = '${id}'` }).catch(() => {});
      }
    })();
    // @ts-ignore
    if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(work); else await work;
    return Response.json({ ok: true, queued: id });
  }

  if (url.searchParams.get("rundown")) {
    // The rundown: her honest read of his day across personal and all four buckets.
    if (!authed && url.searchParams.get("key") !== cfg.rpc) return new Response("unauthorized", { status: 401 });
    const b = await req.json().catch(() => ({}));
    const id = String(b.id || "").replace(/[^0-9a-f-]/g, "");
    const kind = String(b.kind || "day");
    const pt = (t: any) => {
      const d = new Date(t);
      return isNaN(+d) ? String(t) : d.toLocaleString("en-US", {
        timeZone: "America/Los_Angeles", weekday: "short", month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit",
      });
    };
    const work = (async () => {
      try {
        const [home, inbox, sched, projects] = await Promise.all([
          fn("app_home", {}), fn("app_inbox", {}), fn("app_schedule", { days: 3 }), fn("app_projects", {}),
        ]);
        const brief = [
          `WHAT KIND: ${kind}`,
          `PLATE: ${(home.due_today || []).length} open items due today or earlier, of which ${(home.due_today || []).filter((t: any) => t.deadline && t.deadline < String(home.now).slice(0, 10)).length} are past a date that was actually agreed. ${home.week} due in the next 7 days. ${home.done_today} closed today. ${home.awaiting_confirm} sitting in the confirm queue — promises you read out of meetings that he has never confirmed, plus ones that went cold. Those are NOT overdue and NOT owed; mention the queue once, as a number, and never list them as late work. Items with no date were never given one — say so rather than inventing urgency.`,
          `BUCKETS: ${(home.buckets || []).map((x: any) => `${x.bucket} ${x.open_tasks} open/${x.overdue} late`).join(" · ")}`,
          `DUE OR LATE (top): ${(home.due_today || []).slice(0, 14).map((t: any) => `[${t.entity || "?"}] ${t.objective}${t.deadline ? " (" + t.deadline + ")" : ""}`).join(" | ") || "none"}`,
          `SCHEDULE NEXT 3 DAYS (all times already in his own time, Pacific — quote them exactly as written): ${(Array.isArray(sched) ? sched : []).slice(0, 12).map((s: any) => `${pt(s.starts_at)} ${s.title}${s.person ? " w/ " + s.person : ""}${s.i_owe ? " — you owe them " + s.i_owe : ""}`).join(" | ") || "nothing on the calendar"}`,
          `INBOX: ${inbox?.counts?.needs_reply || 0} need a reply, ${inbox?.counts?.hot || 0} hot. Top: ${(inbox?.items || []).slice(0, 10).map((i: any) => `(${i.score}) ${i.sender} — ${i.subject}${i.person ? " [" + i.person + "]" : ""}`).join(" | ") || "clear"}`,
          `TEXTS UNREAD: ${(inbox?.texts || []).slice(0, 6).map((t: any) => `${t.who} (${t.unread})`).join(", ") || "none"}`,
          `PROJECTS: ${(Array.isArray(projects) ? projects : []).map((p: any) => `${p.name} [${p.bucket}/${p.status}/${p.health}] ${p.open_tasks} open${p.overdue ? ", " + p.overdue + " late" : ""}${p.next_step ? " — next: " + p.next_step : ""}`).join(" | ") || "no projects defined yet"}`,
          `GOING COLD: ${(home.follow_up || []).map((p: any) => `${p.name} (${p.days_silent}d, owes ${p.i_owe})`).join(", ") || "nobody"}`,
          `LIFE: ${(home.life_open || []).map((t: any) => t.objective).join(" | ") || "nothing open"} ${(home.life || []).map((f: any) => f.topic + ": " + f.fact).join(" | ")}`,
          `NUMBERS: ${(home.metrics || []).filter((m: any) => m.value != null).map((m: any) => `${m.label} ${m.value}`).join(" · ")}`,
        ].join("\n");

        const sys = `You are Nexus, Christopher Lorenz's executive secretary and chief of staff. Write his rundown.

Plain text. No markdown headers, no bullets made of asterisks, no emoji. Short lines he can read on a phone.

Structure, in this order, skipping any section with nothing real in it:
1. One opening line: the honest shape of the day. Not a greeting.
2. THE NEEDLE — the two or three things that, if he does nothing else, make today count. Choose them yourself from the evidence; say why each one in half a sentence.
3. TODAY — what is on the calendar, in order, with what he owes each person before it.
4. NEEDS A REPLY — the emails and texts that actually need him, most urgent first, at most five, each with the one line of what to say back.
5. Then one short paragraph per bucket that has something happening: GRIND AGENCIES, JBC MANAGEMENT, POWERPIPELINE, PERSONAL. Name the project if there is one. If a bucket is quiet, say so in four words.
6. WHAT YOU ARE AVOIDING — the thing with the oldest date or the most postponements. One line. Be direct about it.

Rules: assert only what the evidence below says. Never invent a number, a name, a meeting, or a promise. Never restate a count with a different meaning than the label it carries — "open and due" is not "past due", and items awaiting his confirm are finished work, not work he owes. Quote calendar times exactly as given; they are already in his time. If something is inferred, mark it "I INFER". Do not mention AFD; he is out of it. Do not offer to send anything — you cannot send.`;

        const r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "x-api-key": CLAUDE_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: JSON.stringify({ model: MODEL, max_tokens: 2000, system: sys, messages: [{ role: "user", content: brief }] }),
        });
        const j = await r.json();
        if (!r.ok) throw new Error(JSON.stringify(j).slice(0, 200));
        const body = (j.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n").trim();
        if (id) await rpc("update", { table: "rundowns", set: { body, status: "ready", ready_at: new Date().toISOString() }, where: `id = '${id}'` });
        if (b.push && BOT_TOKEN && CHAT_ID) await send(CHAT_ID, body);
        await rpc("insert", { table: "action_log", rows: [{ action: `rundown written (${kind})`, result: "executed", tool: "nexus-brain/rundown", autonomy_level: 4, category: "briefing", idempotency_key: `rundown-${Date.now()}` }] });
      } catch (e) {
        if (id) await rpc("update", { table: "rundowns", set: { status: "failed", error: (e as Error).message.slice(0, 400) }, where: `id = '${id}'` }).catch(() => {});
      }
    })();
    // @ts-ignore
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) EdgeRuntime.waitUntil(work); else await work;
    return Response.json({ ok: true, id });
  }

  if (url.searchParams.get("triage")) {
    // Read what came in, decide what actually needs him, and rank it.
    if (!authed && url.searchParams.get("key") !== cfg.rpc) return new Response("unauthorized", { status: 401 });
    const b = req.headers.get("content-type")?.includes("json") ? await req.json().catch(() => ({})) : {};
    const limit = Math.min(Number(b.limit || 20), 40);
    const items = await sel("v_inbox_triage", "triaged_at is null", "score desc nulls last, received_at desc", limit);
    if (!items.length) return Response.json({ ok: true, triaged: 0, note: "nothing new to read" });

    const ents = await sel("entities", undefined, "sort", 6);
    const projs = await sel("projects", "status in ('active','idea')", "name", 40);
    const lines = items.map((i: any, n: number) =>
      `${n + 1}. id=${i.id}\n   from: ${i.sender}\n   subject: ${i.subject || "(none)"}\n   received: ${String(i.received_at).slice(0, 16)} (${i.days_old}d ago)\n   known person: ${i.person || "unknown"}${i.i_owe ? ` (he owes them ${i.i_owe})` : ""}\n   snippet: ${String(i.snippet || "").slice(0, 320)}`).join("\n\n");

    const sys = `You triage Christopher Lorenz's inbox. For each item decide whether it actually needs HIM, how urgently, and what the reply would say.

Return ONLY a JSON array, no prose, no code fence:
[{"id":"<the id given>","needs_reply":true,"score":0-100,"why":"one short sentence — why this needs him or does not","action":"the one line of what to say or do back","entity":"grind|jbc|powerpipeline|personal|null","project":"exact project name from the list or null"}]

How to score:
90+ a client or partner is waiting on him and it is late, or money/a signature/a licence is blocked
70-89 a real person asked him something and has not been answered
50-69 needs him this week, not today
25-49 informational, worth reading, no reply owed
0-24 automated, marketing, receipts, notifications — nothing owed

Buckets: grind = GRIND Agencies, financial services, insurance, GFI, recruiting. jbc = JBC Management, investment and venture. powerpipeline = electrical and electrician work. personal = his life outside the businesses.
Projects available: ${projs.map((p: any) => p.name).join(" | ") || "none defined"}

Rules: never invent a fact about the sender. If you cannot tell the bucket, use null. "action" is what HE would say — write it as the actual first line of a reply, not a description. Never suggest sending anything yourself.`;

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": CLAUDE_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 4000, system: sys, messages: [{ role: "user", content: lines }] }),
    });
    const j = await r.json();
    if (!r.ok) return Response.json({ error: JSON.stringify(j).slice(0, 300) }, { status: 500 });
    const text = (j.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
    const m = text.match(/\[[\s\S]*\]/);
    if (!m) return Response.json({ error: "no json from triage" }, { status: 500 });
    let out: any[] = [];
    try { out = JSON.parse(m[0]); } catch { return Response.json({ error: "bad json from triage" }, { status: 500 }); }

    let n = 0;
    const byName: Record<string, string> = {};
    for (const p of projs) byName[String(p.name).toLowerCase()] = p.id;
    for (const o of out) {
      const id = String(o.id || "").replace(/[^0-9a-f-]/g, "");
      if (!id) continue;
      const set: any = {
        score: Math.max(0, Math.min(100, Number(o.score) || 0)),
        needs_reply: !!o.needs_reply,
        why: String(o.why || "").slice(0, 400),
        recommended_action: String(o.action || "").slice(0, 800),
        triaged_at: new Date().toISOString(),
      };
      if (["grind", "jbc", "powerpipeline", "personal"].includes(String(o.entity))) set.entity = o.entity;
      const pid = byName[String(o.project || "").toLowerCase()];
      if (pid) set.project_id = pid;
      await rpc("update", { table: "inbox_items", set, where: `id = '${id}'` });
      n++;
    }
    await rpc("insert", { table: "action_log", rows: [{ action: `inbox triaged: ${n} items`, result: "executed", tool: "nexus-brain/triage", autonomy_level: 4, category: "inbox", idempotency_key: `triage-${Date.now()}` }] });
    return Response.json({ ok: true, triaged: n });
  }

  if (url.searchParams.get("ask")) {
    // The app queues a question; this answers it and writes the reply back for the app to read.
    if (!authed && url.searchParams.get("key") !== cfg.rpc) return new Response("unauthorized", { status: 401 });
    const b = await req.json();
    const id = String(b.id || "").replace(/[^0-9a-f-]/g, "");
    const text = String(b.text || "").trim();
    if (!id || !text) return Response.json({ error: "need id and text" }, { status: 400 });
    const work = (async () => {
      let reply = "";
      try {
        await rpc("insert", { table: "conversations", rows: [{ channel: "app", chat_id: "app", role: "user", content: text }] });
        const hist = await sel("conversations", `chat_id = 'app'`, "ts desc", 16);
        const messages = hist.reverse().map((h: any) => ({ role: h.role, content: h.content }));
        reply = await claude(await buildSystem(text), messages, "app");
        await rpc("insert", { table: "conversations", rows: [{ channel: "app", chat_id: "app", role: "assistant", content: reply }] });
        await autoFilePrep(reply);
        await rpc("update", { table: "app_chat", set: { reply, status: "done", replied_at: new Date().toISOString() }, where: `id = '${id}'` });
      } catch (e) {
        await rpc("update", { table: "app_chat", set: { status: "failed", error: (e as Error).message.slice(0, 400), replied_at: new Date().toISOString() }, where: `id = '${id}'` }).catch(() => {});
      }
    })();
    // @ts-ignore EdgeRuntime waitUntil when available
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) EdgeRuntime.waitUntil(work); else await work;
    return Response.json({ ok: true, id });
  }
  if (url.searchParams.get("cards")) {
    // Nightly Black Book upkeep, server-side. Runs on pg_cron, needs no Claude session:
    // anyone he has met since their card was last written gets it rewritten from the record.
    if (!authed && url.searchParams.get("key") !== cfg.rpc) return new Response("unauthorized", { status: 401 });
    const b = req.headers.get("content-type")?.includes("json") ? await req.json().catch(() => ({})) : {};
    const limit = Math.min(Number(b.limit || 4), 8);
    const stale = await sel("v_cards_stale",
      "why in ('met since last refresh','no card yet') and meetings > 0", "meetings desc, last_meeting desc", limit);
    if (!stale.length) return Response.json({ ok: true, refreshed: 0, note: "every card with meetings is current" });

    const done: string[] = [], failed: string[] = [];
    for (const p of stale) {
      try {
        const [cur] = await sel("clients", `id = '${p.id}'`, undefined, 1);
        if (!cur || cur.card_status === "confirmed") { continue; }  // never overwrite what he confirmed
        const ms = await sel("client_meetings", `client_id = '${p.id}'`, "met_at desc", 4);
        const ks = await sel("commitments", `client_id = '${p.id}' and status = 'open'`, "due", 12);
        const caps = await sel("person_capabilities", `person_id = '${p.id}'`, undefined, 20);
        const brief = [
          `NAME: ${cur.name}`,
          `KIND: ${cur.kind} · BUCKET: ${cur.entity || "unsorted"} · COMPANY: ${cur.company || "?"} · ROLE: ${cur.role || "?"}`,
          `EXISTING CARD — headline: ${cur.headline || "-"} | superpower: ${cur.superpower || "-"} | controls: ${cur.controls || "-"} | value to him: ${cur.value_to_me || "-"} | value to them: ${cur.value_to_them || "-"} | the ask: ${cur.the_ask || "-"}`,
          `EXISTING CAPABILITIES: ${caps.map((c: any) => `${c.direction}:${c.label}`).join(" · ") || "none"}`,
          `MEETINGS:\n${ms.map((m: any) => `- ${String(m.met_at).slice(0, 10)} ${m.title || ""}\n  summary: ${(m.summary || "").slice(0, 1200)}\n  outcome: ${(m.outcome || "").slice(0, 400)}\n  next step: ${(m.next_step || "").slice(0, 300)}`).join("\n") || "none"}`,
          `OPEN PROMISES: ${ks.map((k: any) => `[${k.owner}] ${k.text}`).join(" | ") || "none"}`,
        ].join("\n");

        const sys = `You maintain Christopher Lorenz's Black Book — a rolodex where each person's card records what they can actually DO for him.
Rewrite this person's card from the meeting record below. Return ONLY a JSON object, no prose, no code fence.

{"headline":"one line: who this person is in Christopher's world",
 "superpower":"what they are exceptionally good at",
 "controls":"what they actually have: capital, crews, licences, an audience, relationships, a territory, a book",
 "value_to_me":"concretely how they can benefit Christopher — specific, not flattering",
 "value_to_them":"what Christopher can do for them",
 "the_ask":"the one specific thing he could ask them for right now",
 "relationship_strength":1-5,"trust":1-5,
 "reciprocity":"who owes whom right now",
 "interests":"rapport hooks they actually volunteered, or omit",
 "offers":["short searchable phrase","2-6 words each"],
 "needs":["what they are looking for"]}

RULES, in order of importance:
1. Never invent. If the record does not tell you something, OMIT that key entirely. A missing field is correct; a plausible guess is a lie he will act on.
2. Keep what the existing card already got right — only improve or add. Do not drop a good line to write a worse one.
3. Never write government ID numbers, account numbers, dates of birth, health or medical details, or immigration status into a card. Those stay in the evidence record.
4. AFD / Armed Forces Division is dead to Christopher — he was squeezed out of it. Never build value or an ask around AFD and never write the acronym.
5. Ratings are evidence-based: one thin meeting is a 2, not a 4.`;

        const r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "x-api-key": CLAUDE_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: JSON.stringify({ model: MODEL, max_tokens: 1500, system: sys, messages: [{ role: "user", content: brief }] }),
        });
        const j = await r.json();
        const text = (j.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
        const m = text.match(/\{[\s\S]*\}/);
        if (!m) { failed.push(`${cur.name} (no json)`); continue; }
        const card = JSON.parse(m[0]);
        const payload: any = { name: cur.name, card_status: "drafted", source: "nexus", card_source: "auto-refresh", capabilities: [] };
        for (const k of ["headline", "superpower", "controls", "value_to_me", "value_to_them", "the_ask", "reciprocity", "interests"])
          if (card[k]) payload[k] = String(card[k]).slice(0, 4000);
        for (const k of ["relationship_strength", "trust"]) if (card[k] != null) payload[k] = card[k];
        for (const l of (card.offers || []).slice(0, 10)) payload.capabilities.push({ direction: "offers", label: String(l).slice(0, 160), stated_or_inferred: "inferred" });
        for (const l of (card.needs || []).slice(0, 6)) payload.capabilities.push({ direction: "needs", label: String(l).slice(0, 160), stated_or_inferred: "inferred" });
        await fn("record_person", payload);
        done.push(cur.name);
      } catch (e) { failed.push(`${p.name} (${(e as Error).message.slice(0, 60)})`); }
    }
    if (done.length || failed.length) {
      await rpc("insert", { table: "action_log", rows: [{ action: `black book upkeep: refreshed ${done.join(", ") || "none"}${failed.length ? "; failed " + failed.join(", ") : ""}`, result: failed.length && !done.length ? "failed" : "executed", tool: "nexus-brain/cards", autonomy_level: 4, category: "blackbook", idempotency_key: `cards-${Date.now()}` }] });
    }
    return Response.json({ ok: true, refreshed: done.length, names: done, failed });
  }
  if (url.searchParams.get("link")) {  // re-match contacts and threads to people
    if (!authed && url.searchParams.get("key") !== cfg.rpc) return new Response("unauthorized", { status: 401 });
    return Response.json(await fn("link_contacts", {}));
  }
  if (url.searchParams.get("notify")) {  // hourly sweep: push anything new that landed since the last one
    if (!authed && url.searchParams.get("key") !== cfg.rpc) return new Response("unauthorized", { status: 401 });
    const r = await drainNotifications(true);
    if (r.sent) await rpc("insert", { table: "action_log", rows: [{ action: `new-work notice pushed: ${r.sent} item(s)`, result: "executed", tool: "nexus-brain/notify", autonomy_level: 4, category: "notification", idempotency_key: `notify-${Date.now()}` }] });
    return Response.json({ ok: true, sent: r.sent });
  }
  if (url.searchParams.get("buckets")) {
    if (!authed && url.searchParams.get("key") !== cfg.rpc) return new Response("unauthorized", { status: 401 });
    const [work, book] = await Promise.all([sel("v_open_by_entity", undefined, "sort", 10), sel("v_bucket_book", undefined, undefined, 10)]);
    return Response.json({ work, book });
  }
  if (url.searchParams.get("push")) {
    if (!authed) return new Response("unauthorized", { status: 401 });
    const b = await req.json();
    const text = (b.urgent ? "P0 — " : "") + (b.message || b.text || "");
    const r = await send(b.chat_id || CHAT_ID, text);
    return Response.json({ ok: !!r?.ok, telegram: r });
  }
  if (url.searchParams.get("event")) {  // webhooks may carry the key in the URL (Calendly/Fathom can't set headers)
    if (!authed && url.searchParams.get("key") !== cfg.rpc) return new Response("unauthorized", { status: 401 });
    const b = await req.json();
    const source = String(url.searchParams.get("source") || b.source || (b.event && b.payload?.scheduled_event ? "calendly" : "unknown"));
    let kind = url.searchParams.get("kind") || (b.kind ? String(b.kind) : null);
    let payload = b.payload || (b.text ? { text: String(b.text).slice(0, 4000) } : b);
    if (source === "calendly" && b.event) {  // invitee.created / invitee.canceled → compact
      kind = String(b.event); const p = b.payload || {};
      payload = { invitee: p.name, email: p.email, event: p.scheduled_event?.name, start: p.scheduled_event?.start_time, end: p.scheduled_event?.end_time, status: p.status, cancel_reason: p.cancellation?.reason, questions: (p.questions_and_answers || []).map((q: any) => `${q.question}: ${q.answer}`).join(" | ").slice(0, 1500), event_uri: p.scheduled_event?.uri, invitee_uri: p.uri };
      if (kind === "invitee.created" && BOT_TOKEN && CHAT_ID) {
        const when = payload.start ? new Date(payload.start).toLocaleString("en-US", { timeZone: "America/Los_Angeles", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "?";
        await send(CHAT_ID, `New booking: ${payload.invitee || "?"} — ${payload.event || "?"} · ${when} PT${payload.questions ? "\n" + payload.questions : ""}`);
      }
      if (kind === "invitee.canceled" && BOT_TOKEN && CHAT_ID) await send(CHAT_ID, `Cancelled: ${payload.invitee || "?"} — ${payload.event || "?"}${payload.cancel_reason ? " · " + payload.cancel_reason : ""}`);
    }
    await rpc("insert", { table: "events", rows: [{ source, kind, payload }] });
    if (source === "context") {  // arrive/leave → current coarse context for the brain (never a history)
      const line = `${kind || "at"} ${payload.place || payload.text || ""} (as of ${new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" })} PT)`;
      await rpc("upsert", { table: "brain_context", on_conflict: "key", rows: [{ key: "context", content: line }] });
    }
    return Response.json({ ok: true, source, kind });
  }

  // Telegram webhook
  if (req.headers.get("x-telegram-bot-api-secret-token") !== cfg.rpc) return new Response("forbidden", { status: 403 });
  const upd = await req.json();
  const msg = upd.message;
  if (!msg?.text) return Response.json({ ok: true });
  const chat_id = String(msg.chat.id);
  if (chat_id !== String(CHAT_ID)) { await send(chat_id, "This line is private."); return Response.json({ ok: true }); }
  const cmd: Record<string, string> = { "/today": "What matters today?", "/needle": "Did we move the needle today?", "/plate": "What can you take off my plate?", "/did": "What did Nexus do today?", "/book": "Who in my client book needs follow-up right now, and why? Group by flag.", "/promises": "What have I promised clients that is still open? List by due date.", "/reminders": "List everything on my plate that is due today or overdue, grouped by client where relevant. Plain list, no preamble.", "/week": "What is due in the next 7 days?", "/prep": "Pick the promise due soonest that I have not prepped, pull everything you have on it, and walk me through what I need to get it done.", "/buckets": "Give me the breakdown across all four buckets — GRIND, JBC, PowerPipeline, Personal — open, overdue, due this week, and people needing follow-up in each. Plain list.", "/grind": "GRIND Agencies only: everything open, what's overdue, who needs follow-up. Nothing from the other businesses.", "/jbc": "JBC Management only: everything open, what's overdue, who needs follow-up. Nothing from the other businesses.", "/power": "PowerPipeline only: everything open and everything you know about it. Nothing from the other businesses.", "/personal": "Personal bucket only: everything open and everything you know about my personal life. Nothing from the businesses.", "/learn": "I am about to teach you something. Ask me which bucket it belongs to if it is not obvious, then file it with learn() and read it back to me so I can correct it.", "/brain": "Read back everything you have learned, grouped by bucket, so I can see what you know and correct what's wrong.", "/rundown": "Give me the rundown: the shape of my day, the needle, what is on the calendar with what I owe each person, what needs a reply, one paragraph per bucket that has something happening, and what I am avoiding.", "/desks": "Report from all four desks — GRIND, JBC, PowerPipeline and Personal. For each: the headline, what moved, what is stalled, who is owed, and what needs me. Say which desk each read came from.", "/confirm": "Walk me through the confirm queue one person at a time, oldest first. For each person show me their items with the age and your hint, and ask me keep, done or kill. Do not show me the whole queue at once.", "/inbox": "What actually needs a reply from me right now? Highest first, with what to say back. Nothing automated.", "/projects": "Where does every project stand? Group by bucket, name the next step on each, and tell me which one is stalled.", "/schedule": "What is on my calendar for the next two days, in order, with what I owe each person before it?", "/blackbook": "Give me the state of the Black Book: how many people per bucket, how many cards are still thin, and the five people with the most leverage I have not talked to in a while.", "/card": "Which person's card do you want? Ask me for a name, then read me their card.", "/who": "What do you need? Tell me what you're looking for and I'll search the Black Book for who you already know that can do it.", "/start": "Introduce yourself in two sentences and tell me what you know about today." };
  const text = cmd[msg.text.trim().split(/\s/)[0]] || msg.text;
  // respond async-safe: Telegram wants a quick 200
  const p = handleChat(chat_id, text);
  // @ts-ignore EdgeRuntime waitUntil when available
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) EdgeRuntime.waitUntil(p); else await p;
  return Response.json({ ok: true });
});
