// ai-api v17 (2026-10-26) — pfr_outcome let any signed-in agent overwrite the outcome on ANY review;
//   it now only updates rows belonging to the caller (Operations unchanged).
// ai-api v16 (2026-09-07)
// v16: the PFR is a document a FAMILY reads, so it gets the quality model first (Sonnet, with
//      Haiku only as fallback) and enough room to finish its sentences. v15 answers were being
//      cut off mid-word at the token ceiling, which looks broken in front of a client.
// v15 added three things and removed nothing:
//   1. HOUSE KNOWLEDGE. The GFI Client Service Menu and the frameworks the agency actually
//      teaches (6 Steps, DIME, Avalanche, the three tax buckets, G.R.I.P.P., PERCS, Section 162,
//      ETHOS/LSPN estate docs, the compliance language) now ride on every PFR prompt. They live
//      in app_settings.pfr_knowledge as TEXT, not in this file, so the agency can widen what
//      Claude knows without a code deploy. Source: GRIND Field Training Slides.pptx.
//   2. LEARNING. Every PFR analysis is written to pfr_learning with the facts it was given and
//      what it recommended. pfr_distill reads that book back, together with which reviews turned
//      into submitted business, and writes the patterns to app_settings.pfr_patterns — which is
//      then injected into later prompts. The system gets better from its own history.
//   3. CLIENT-FACING VOICE. The report is read by the family, so the knowledge block instructs
//      plain second-person English and bans internal sales language from client text.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPA = Deno.env.get("SUPABASE_URL")!;
const SKEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: SKEY, Authorization: `Bearer ${SKEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
function json(o: unknown, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }
const clean = (s: unknown) => (s ?? "").toString().trim().slice(0, 8000);
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();

const MODELS = ["claude-haiku-4-5", "claude-haiku-4-5-20251001", "claude-3-5-haiku-20241022", "claude-sonnet-4-6", "claude-3-5-sonnet-20241022", "claude-3-haiku-20240307"];
// A client reads the PFR. Accuracy and tone matter more here than speed, so quality goes first.
const PFR_MODELS = ["claude-sonnet-4-6", "claude-3-5-sonnet-20241022", "claude-haiku-4-5", "claude-haiku-4-5-20251001", "claude-3-5-haiku-20241022"];
const DOC_MODELS = ["claude-sonnet-4-6", "claude-3-5-sonnet-20241022", "claude-haiku-4-5", "claude-haiku-4-5-20251001"];
const DISTILL_MODELS = ["claude-sonnet-4-6", "claude-3-5-sonnet-20241022", "claude-haiku-4-5"];

const FACTS = [
  "Daily Morning Huddle: 8:00 AM PST, Zoom 964 650 9994 (PW WEALTH).",
  "Live trainings: Mon Team 6 PM, Wed Day 1 6 PM, Thu Day 2 6 PM PST.",
  "Licensing help: Operations (Anais) calendly.com/impactagency-ops/licensing, 858-433-4429.",
  "Log every submitted app in New Business (Submitted -> Pending -> Approved -> In Force -> Closed).",
  "Senior Associate = 3 business partners + 3 families helped in 30 days."
];

async function rpcGet(path: string) { try { const r = await fetch(`${SUPA}/rest/v1/${path}`, { headers: DBH }); return (await r.json()) || []; } catch (_) { return []; } }
async function opsAuthorized(token: unknown) { try { const r = await fetch(`${SUPA}/rest/v1/rpc/ops_authorize`, { method: "POST", headers: DBH, body: JSON.stringify({ p_token: String(token ?? "") }) }); const j = await r.json(); return !!(j && j.ok); } catch (_) { return false; } }

/* ---- House knowledge: what this agency actually offers, plus what it has learned. ----
   Held as data so it can grow without redeploying this function. Cached briefly because it
   rides on every PFR call. */
let KB_TXT = ""; let KB_AT = 0;
async function houseKnowledge(): Promise<string> {
  if (KB_TXT && (Date.now() - KB_AT) < 300000) return KB_TXT;
  let out = "";
  try {
    const rows = await rpcGet(`app_settings?key=in.(pfr_knowledge,pfr_patterns)&select=key,value`);
    const by: Record<string, any> = {};
    (rows as any[]).forEach((x: any) => { by[x.key] = x.value; });
    const kb = by["pfr_knowledge"] && by["pfr_knowledge"].text;
    const pat = by["pfr_patterns"] && by["pfr_patterns"].text;
    if (kb) out += "\n\n=== HOW THIS AGENCY SERVES A FAMILY (follow this) ===\n" + kb;
    if (pat) out += "\n\n=== WHAT WE HAVE LEARNED FROM OUR OWN PAST REVIEWS ===\n" + pat;
  } catch (_) { /* knowledge is an enhancement, never a hard dependency */ }
  KB_TXT = out; KB_AT = Date.now();
  return out;
}

/* Every analysis is kept so the house can learn from its own book. Never blocks the answer. */
async function logLearning(rec: Record<string, unknown>) {
  try { await fetch(`${SUPA}/rest/v1/pfr_learning`, { method: "POST", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify(rec) }); } catch (_) { /* noop */ }
}

async function claudeMsg(sys: string, content: unknown, maxTokens: number, models: string[]) {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return { ok: false, answer: "", found: false, error: "no ANTHROPIC_API_KEY set" };
  let lastErr = "no models tried";
  for (const model of models) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify({ model, max_tokens: maxTokens, system: sys, messages: [{ role: "user", content: content || "hello" }] }) });
      const j = await res.json();
      const txt = (j && j.content && j.content[0] && j.content[0].text) ? String(j.content[0].text).trim() : "";
      if (txt) return { ok: true, answer: txt, found: true, source: "Claude", model };
      const em = (j && j.error && (j.error.message || j.error.type)) ? String(j.error.message || j.error.type) : "no text";
      lastErr = model + ": " + em;
      const authFail = /authentication|invalid x-api-key|permission|credit|billing/i.test(em);
      if (authFail) return { ok: false, answer: "", found: false, error: em };
    } catch (e) { lastErr = model + ": " + String(e); }
  }
  return { ok: false, answer: "", found: false, error: lastErr };
}
async function claudeCall(sys: string, prompt: string, maxTokens: number, models?: string[]) { return claudeMsg(sys, prompt || "hello", maxTokens, models || MODELS); }

const ADVISOR_SYS = "You are a seasoned, fiduciary-minded life & retirement advisor and sales coach for The Standard Financial Group. You are given ONE specific client's Personal Financial Review (PFR) with their real numbers and the exact choices they made. Analyze THIS client only — never give generic advice. Every claim must reference their actual figures, age, health, family, priorities, and confidence; if two clients would get the same paragraph, you are being too generic.\n\nDO REAL ADVISOR MATH and show the numbers you used:\n- Cash flow: state monthly surplus/deficit and savings rate; flag if they are living beyond their means.\n- Emergency reserve: compare liquid savings to 3–6 months of their expenses; state the gap in months.\n- Debt: call out high-interest debt (credit cards) and whether it should be cleared before funding new premium.\n- Protection: sanity-check the stated insurable/protection need against income replacement (~10–15x income, or income to retirement age) and any EXISTING coverage; note if they are over- or under-insured.\n- Retirement: quantify the annual gap between desired income and their current trajectory, and roughly how much monthly funding would move the needle.\n\nTHEN give a SEQUENCED total-financial-picture plan — only the steps that apply, in priority order: (1) STABILIZE (emergency fund / high-interest debt), (2) PROTECT (right-size life coverage for the family), (3) GROW (tax-advantaged accumulation & retirement income), (4) OPTIMIZE (tax/legacy; for accredited clients, alternative investments). Put first-things-first: do not present a permanent product as the lead move if step 1 or 2 is unmet — name the immediate action (term now + build reserves / clear debt) first, and introduce the permanent product only as a later step.\n\nSERVICE FIRST — SUITABILITY ALWAYS: Recommend what is genuinely BEST for THIS client as a fiduciary; the right recommendation serves the client, never the sale. Our preferred tools are IUL (tax-free accumulation + protection), FIA / fixed-index annuities (protected retirement income), and term (low-cost protection). FAVOR IUL and FIA WHEN THEY GENUINELY FIT — IUL when there is real recurring monthly surplus and a multi-year horizon; FIA when at/near retirement with a lump sum of liquid/investable assets or an income gap. But recommend them ONLY when they make sense for THIS client. If the client has little/no surplus, high-interest debt, no emergency fund, a very short horizon, or simply needs cheap coverage, SAY SO and recommend term, debt paydown, or building reserves FIRST — never force a permanent product to make a sale. PREMIUM REALISM: size any MONTHLY premium (IUL / term / whole life) to the client's actual MONTHLY SURPLUS and never suggest a premium they cannot fund; an annuity (FIA) is instead funded from a one-time LUMP SUM of liquid assets, not monthly cash flow. NICOTINE / TOBACCO IS NEVER A DISQUALIFIER: a tobacco or nicotine user still FULLY qualifies for term, IUL, FIA and whole life — it only means tobacco-rate pricing and favoring tobacco-friendly carriers. The words 'decline', 'declined', 'ineligible', 'disqualify', 'uninsurable', 'high-risk', or 'substandard' must NEVER appear in relation to tobacco or nicotine; treat tobacco purely as a pricing factor. Be explicit about what does NOT fit and why (tobacco is never such a reason).\n\nOUTPUT four short labeled sections: (1) The picture — their numbers and what stands out, (2) Biggest gap or opportunity, (3) The plan — sequenced, naming the specific product(s) that fit each step with rough monthly figures sized to their surplus and need, (4) Discovery-to-close talk track in their advisor's voice. Warm and concrete. FINISH EVERY SENTENCE YOU START — an answer that stops mid-thought is worse than a shorter one, so if you are running long, tighten the remaining sections rather than getting cut off. Never invent facts; for exact compliance, comp, or commission questions, refer to Operations (Anais, 858-433-4429).";
const STRATEGY_SYS = "You are a senior life & annuity strategist for The Standard Financial Group (a GFI / Symmetry-Quility agency). You are given ONE client's Personal Financial Review (PFR). Recommend the single best strategy for THIS client and, when a product solution fits, name the TOP 3 carrier+product options to execute it — chosen ONLY from our partnered carriers below and matched to the client's AGE, HEALTH (health class + tobacco), and FINANCES (surplus, liquid assets, debt, protection need, retirement gap).\n\nPARTNERED CARRIERS (name — products — best-fit notes):\n- North American — IUL, Fixed & Index Annuities — strong accumulation IUL, competitive FIA.\n- Corebridge Financial (formerly AIG) — IUL, Term, Fixed & Index Annuities — broad/forgiving underwriting, solid term + IUL.\n- Symetra — IUL, Term, Fixed & Index Annuities — top-tier high-cash-value accumulation IUL.\n- F&G (Fidelity & Guaranty) — IUL, Fixed & Index Annuities — strong income products + accumulation IUL, friendlier underwriting.\n- Allianz Life — IUL, Fixed Index Annuities — premier FIA income riders, strong IUL.\n- Ethos — simplified-issue Term & Whole Life, instant no-exam decision — best for younger/healthy needing fast coverage.\n- Ameritas — IUL, Term, Whole Life — low-cost accumulation IUL, competitive term.\n- Foresters Financial — Term, Whole Life, Final Expense (+ member benefits) — family-friendly, moderate-health underwriting.\n- Mutual of Omaha — IUL, Term, Whole Life, Final Expense — senior-friendly underwriting, great final expense & term.\n- American Equity — Fixed Index Annuities — guaranteed-income FIA specialist.\n\nSUITABILITY RULES (SERVICE FIRST — recommend what is genuinely best for the client, never what merely sells):\n- FAVOR IUL or FIA WHEN THEY FIT: younger/mid client with real monthly surplus + accumulation/retirement/tax goal -> max-funded IUL; age ~55+ with a lump sum of liquid assets or an income gap -> FIA. Pure protection need or tight budget -> Term. Senior legacy / final-expense -> Whole Life / Final Expense.\n- ORDER THE 3 PICKS BY WHAT TO DO FIRST: pick #1 is the client's IMMEDIATE best action, #2 and #3 follow. If your headline calls to stabilize / clear high-interest debt / build reserves first, then pick #1 MUST be the low-cost TERM policy that protects the family NOW (or the immediate protection layer) — any permanent product (IUL / FIA / Whole Life) may appear ONLY as #2 or #3 and must be explicitly labeled 'once reserves are built / high-interest debt is cleared.' NEVER rank a permanent product #1 while the headline says stabilize first.\n- PREMIUM SIZING — MONTHLY vs LUMP SUM: a monthly life premium (IUL / term / whole life) must be affordable from the client's MONTHLY SURPLUS and must NEVER exceed it — if surplus is near zero, recommend only a small term premium. An FIA is DIFFERENT: it is funded from a one-time LUMP SUM of the client's liquid / investable assets, so size the FIA to their LIQUID ASSETS (not monthly surplus) and never imply the premium comes from monthly cash flow; present it as a one-time premium PLUS its estimated guaranteed monthly income. Never recommend an FIA to a client with no meaningful liquid assets to fund it.\n- NICOTINE / TOBACCO IS NEVER A DISQUALIFIER: a tobacco user still FULLY qualifies for term, IUL, FIA and whole life — recommend the SAME best-fit product you otherwise would, just through tobacco-friendly carriers (Mutual of Omaha, Foresters, F&G, Corebridge, Ameritas) at tobacco-rate pricing. The words 'decline', 'declined', 'ineligible', 'disqualify', 'uninsurable', 'high-risk', or 'substandard' must NEVER appear in relation to tobacco or nicotine anywhere in your answer; it is a pricing factor only.\n- Physical health (NOT tobacco): below-average health (Poor / ongoing issues) -> prefer lenient underwriters and do NOT recommend instant-issue (Ethos). Excellent/Good & young -> Symetra, North American, Ameritas (accumulation), Ethos (fast term).\n- Give concrete STARTING NUMBERS for each pick: monthly + annual premium AND death benefit / face amount (or one-time premium + guaranteed monthly income for FIA), sized to the client's actual surplus, protection need, and liquid assets. Label as estimates for illustration only.\n- If the client is accredited ($300K+ liquid, noted in the data), add ONE closing line on real estate / SPV as an additional wealth play (investment, not insurance; requires accreditation & suitability).\n\nOUTPUT FORMAT (no preamble, no disclaimer paragraph):\nStart with a single one-line strategy headline that reflects THIS client's situation (including 'stabilize first' if that's the honest call). Then, when a product solution fits, exactly 3 numbered items, each on its own line, ORDERED by what to do first:\n1. Carrier — Product — starting numbers — one-sentence why it fits their age/health/finances.\n2. ...\n3. ...\nFINISH EVERY SENTENCE YOU START — never get cut off mid-thought. Never invent carrier facts beyond the list above.";
const TUTOR_SYS = "You are the AI Training Coach for The Standard Financial Group, a life-insurance agency, embedded in a new-agent training tracker. Help with licensing, BLDRs onboarding (Days 1–4), warm-market prospecting, running a PFR, presenting IUL/FIA/annuity concepts, objection handling, and staying on pace. Be warm, motivating, and concrete — give one clear next action. Under 150 words. Internal facts:\n" + FACTS.map((f) => "- " + f).join("\n") + "\nFor exact compliance, comp, or personal client data, tell them to contact Operations (Anais, 858-433-4429). Never invent facts.";
const P1035_SYS = "You are a life-insurance replacement / 1035-exchange analyst for The Standard Financial Group. You are given details of a client's EXISTING life insurance policy (or policies) plus PFR context. YOUR AUDIENCE IS THE AGENT — this is INTERNAL decision-support, NOT client-facing advice. For each policy, assess: (1) Is this policy likely serving THIS client's current goals well or poorly? Weigh policy type vs goal — e.g. an older high-cost universal life or an underperforming whole life against an accumulation goal; a term policy nearing the end of its level period with no cash value; or a policy holding meaningful cash value that could fund a better-designed IUL or an annuity. (2) Could a 1035 exchange (tax-free transfer of existing cash value into a new life policy or annuity) plausibly benefit the client? (3) Red flags the agent MUST verify before any replacement: surrender charges, outstanding policy loans, whether the existing death benefit is still needed, contestability/new underwriting risk, and genuine suitability. Tie everything to the numbers provided (death benefit, cash value, premium, age of policy). Be specific and concise — under 220 words. End with the verdict on its own final line, exactly one of: VERDICT: KEEP or VERDICT: REVIEW or VERDICT: EXCHANGE. This is internal analysis only: replacement regulations and state suitability/replacement forms apply, and the agent must never churn a policy that still serves the client. For exact compliance questions, contact Operations (Anais, 858-433-4429).";

const DISTILL_SYS = "You are the analyst who teaches an agency's AI from its own history. You are given a batch of past Personal Financial Reviews: for each, the client facts the AI was given, what it recommended, and — where known — what the family actually did (submitted business and its annual premium, or no action). Find the PATTERNS that would make the next recommendation better.\n\nWrite a compact briefing, under 500 words, in these sections:\n1. WHAT CONVERTS — client shapes (surplus, age, family, priorities, existing accounts) where a recommendation turned into submitted business, and what the recommendation had in common.\n2. WHAT DOES NOT — where reviews led nowhere, and the likely reason (premium too big for the surplus, wrong product for the stage, protection skipped, service area never raised).\n3. MISSED SERVICE AREAS — how often the six GFI service areas were relevant but not raised, especially rollovers of an old 401k/IRA (the no-out-of-pocket win) and living benefits.\n4. RULES FOR NEXT TIME — at most 6 short imperative rules, each tied to evidence in the batch, that should steer future recommendations.\n\nBe concrete and quantitative where the data allows (counts, typical dollar figures). If the batch is too small or too uniform to support a claim, say so plainly rather than inventing a pattern. Never name individual clients.";

const BUDGET_SYS = "You extract a household's budget from a document (PDF, image/photo, spreadsheet export, or pasted text) into STRICT JSON for a financial-review app. Output ONLY one JSON object — no prose, no markdown code fences.\n\nHARD RULES:\n- If the source shows BOTH a Planned/Budget column AND an Actual column, ALWAYS use the ACTUAL amounts (what really happened). Never mix the two.\n- income and expenses are MONTHLY dollar amounts. assets, invest and debt are TOTAL BALANCES (not monthly).\n- Numbers ONLY: no $, no commas, no +/- signs, whole dollars, 0 when unknown.\n- Use ONLY these exact keys — do NOT invent or rename keys:\n  income: Job, Spouse, \"House Hack\", Passive, Portfolio\n  expenses: \"Mortgage/Rent\", \"Property Tax\", HOA, Utilities, Phone, Internet, Groceries, Subscriptions, Insurances, Gas, Childcare, Pets, \"Petty Cash\", \"Debt Payments\", Unforeseen\n  assets: House, Car, \"Savings Acct.\", Checking, Properties, Businesses\n  invest: TSP, \"401k\", \"Trad. IRA\", \"Roth IRA\", CDs, Bonds, Crypto, Stocks, IUL, FIA, \"403B\", \"457\"\n  debt: \"Student Loan\", \"Auto Loan\", Mortgage, \"Personal Loan\", \"Credit Cards\", Medical, HELOC, \"Payday Loans\", \"Equity Loans\", \"Pension Loans\"\n\nCATEGORY MAPPING (map each source row to the closest key; when several rows map to the same key, SUM them):\nINCOME: salary/wages/paycheck/W-2 -> Job. Self-employment, business, LLC or shop/store name, commissions, 1099, sales -> Job. A spouse's or partner's income -> Spouse. Rental / rent received, VA disability or VA compensation, Social Security, pension, annuity income, disability, child support, alimony, any benefit or passive stream -> Passive. Dividends, interest, capital gains, brokerage income -> Portfolio. Income from renting a room in the primary home -> \"House Hack\".\nEXPENSES: rent or mortgage payment -> \"Mortgage/Rent\". property tax -> \"Property Tax\". HOA dues -> HOA. electric/water/power/trash/sewer/natural gas utility -> Utilities. cell/phone -> Phone. internet/wifi/cable -> Internet. groceries/food -> Groceries. streaming/apps/memberships/music/software subscriptions -> Subscriptions. auto, home, health, or life INSURANCE premiums -> Insurances. fuel/gasoline for vehicles -> Gas. daycare/childcare/kids tuition -> Childcare. pets/pet food -> Pets. dining out/eating out/entertainment/pocket money/small misc spend -> \"Petty Cash\". monthly minimum PAYMENTS toward loans or credit cards -> \"Debt Payments\". one-time, irregular, or unexpected purchases (a new computer, a one-off business expense, a repair, medical bill) -> Unforeseen.\nDISAMBIGUATION: 'car insurance' / 'vehicle insurance' / 'auto insurance' -> Insurances (NOT Gas, NOT a car payment). A car/auto loan PAYMENT -> \"Debt Payments\". If an expense row fits no other key, add it to Unforeseen so the totals still reconcile.\nBALANCES: bank savings -> \"Savings Acct.\"; checking -> Checking; home value -> House and remaining mortgage balance -> Mortgage (debt); vehicle value -> Car and remaining auto-loan balance -> \"Auto Loan\" (debt); brokerage -> Stocks; retirement accounts to their matching key.\n\nSELF-CHECK BEFORE YOU ANSWER: If the document states an income total or an expense total (e.g. a 'Totals' row), the amounts you assign in that section MUST add up to that stated total. If your sum is short, you missed or misfiled a row — often a business/sales name that appears on BOTH the income and expense sides (assign the income-side amount to income, the expense-side amount to expenses). Find it and fix it before outputting.\n\nALSO return these top-level fields for verification:\n  income_total: sum of the monthly income you assigned\n  expense_total: sum of the monthly expenses you assigned\n  note: <=12-word note on any key assumption (e.g. 'Used Actual column')\n\nEXACT return shape:\n{\"income\":{},\"expenses\":{},\"assets\":{},\"invest\":{},\"debt\":{},\"income_total\":0,\"expense_total\":0,\"note\":\"\"}";

function mediaTypeFor(name: string, mime: string): string {
  const n = (name || "").toLowerCase(); const m = (mime || "").toLowerCase();
  if (m.includes("pdf") || n.endsWith(".pdf")) return "application/pdf";
  if (m.includes("png") || n.endsWith(".png")) return "image/png";
  if (m.includes("webp") || n.endsWith(".webp")) return "image/webp";
  if (m.includes("gif") || n.endsWith(".gif")) return "image/gif";
  if (m.includes("jpeg") || m.includes("jpg") || n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
  return "";
}


/* ===== ai-api: WHO IS CALLING (2026-09-30) =====
   Identity used to come from a typed `code`, and GFI codes are printed on the org chart. It now
   comes from the session token minted when somebody enters their PIN, or an Operations token. */
const _SB = Deno.env.get("SUPABASE_URL")!;
const _SK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
async function _authRpc(fn: string, args: Record<string, unknown>) {
  try {
    const r = await fetch(`${_SB}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: _SK, Authorization: `Bearer ${_SK}`, "Content-Type": "application/json" }, body: JSON.stringify(args) });
    return await r.json();
  } catch (_) { return null; }
}
async function _isOps(token: unknown): Promise<boolean> {
  const t = String(token ?? "").trim(); if (!t) return false;
  const r = await _authRpc("ops_authorize", { p_token: t }); return !!(r && r.ok);
}
async function _sessionCode(session: unknown): Promise<string> {
  const s = String(session ?? "").trim().slice(0, 120); if (!s) return "";
  const got = await _authRpc("agent_session_code", { p_token: s });
  return (typeof got === "string") ? got.trim().toUpperCase() : "";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    let body: Record<string, unknown> = {};
    if (req.method === "POST") body = await req.json().catch(() => ({}));
    const url = new URL(req.url);
    const action = (body.action as string) || url.searchParams.get("action") || "";
    /* Resolve the caller once, then overwrite the typed code with the verified answer. */
    {
      const _ops = await _isOps((body as Record<string, unknown>).token);
      if (!_ops) {
        const _me = await _sessionCode((body as Record<string, unknown>).session);
        if (!_me) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401);
        (body as Record<string, unknown>).code = _me;
      }
    }

    if (action === "ai_ping") return json(await claudeCall("Reply with exactly: OK", "ping", 16));

    if (action === "pfr_ai" || action === "pfr_strategy" || action === "pfr_1035") {
      const ctx = clean(body.prompt || body.q);
      const kb = await houseKnowledge();
      const cfg = action === "pfr_ai" ? { sys: ADVISOR_SYS + kb, tok: 2600 }
                : action === "pfr_strategy" ? { sys: STRATEGY_SYS + kb, tok: 1600 }
                : { sys: P1035_SYS, tok: 900 };   // 1035 review is internal-only, no client knowledge block
      const out = await claudeCall(cfg.sys, ctx, cfg.tok, PFR_MODELS);
      if (out.ok && out.answer) {
        await logLearning({
          pfr_id: clean(body.pfr_id) || null,
          agent_code: norm(body.agent_code) || null,
          client_name: clean(body.client_name) || null,
          kind: action, context: ctx, output: out.answer, model: out.model || null,
        });
      }
      return json(out);
    }

    if (action === "tutor" || action === "hub_tutor") return json(await claudeCall(TUTOR_SYS, clean(body.q || body.prompt), 480));

    /* Record what actually happened, so the distiller can tell a good recommendation from a
       merely plausible one. */
    if (action === "pfr_outcome") {
      const pid = clean(body.pfr_id); if (!pid) return json({ ok: false, error: "pfr_id required" });
      const oc = clean(body.outcome).toLowerCase();
      if (["submitted", "declined", "no_action"].indexOf(oc) < 0) return json({ ok: false, error: "outcome must be submitted, declined or no_action" });
      /* v17: only the review's own agent (or Operations) may record its outcome. */ const own = (await _isOps(body.token)) ? "" : `&agent_code=eq.${encodeURIComponent(String(body.code || ""))}`;
      const r = await fetch(`${SUPA}/rest/v1/pfr_learning?pfr_id=eq.${encodeURIComponent(pid)}${own}`, { method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify({ outcome: oc, outcome_ap: Number(body.annual_premium) || null, outcome_at: new Date().toISOString() }) });
      return json({ ok: r.ok, pfr_id: pid, outcome: oc });
    }

    /* Read the book back and write down what we have learned. Operations / cron only. */
    if (action === "pfr_distill") {
      if (!(await opsAuthorized(body.token))) return json({ ok: false, error: "unauthorized" }, 401);
      const limit = Math.min(Math.max(Number(body.limit) || 60, 5), 200);
      const rows = await rpcGet(`pfr_learning?kind=in.(pfr_ai,pfr_strategy)&order=created_at.desc&limit=${limit}&select=kind,context,output,outcome,outcome_ap,created_at`);
      const list = rows as any[];
      if (!list.length) return json({ ok: false, error: "No PFR history yet — run some reviews first." });
      const batch = list.map((r: any, i: number) => {
        const oc = r.outcome ? (r.outcome + (r.outcome_ap ? (", AP $" + Math.round(Number(r.outcome_ap))) : "")) : "unknown";
        return `--- REVIEW ${i + 1} (${r.kind}, outcome: ${oc}) ---\nCLIENT FACTS:\n${String(r.context || "").slice(0, 1400)}\nRECOMMENDED:\n${String(r.output || "").slice(0, 1400)}`;
      }).join("\n\n").slice(0, 120000);
      const out = await claudeMsg(DISTILL_SYS, "Here are the agency's most recent reviews. Distil what we have learned.\n\n" + batch, 1600, DISTILL_MODELS);
      if (!out.ok) return json(out);
      const known = list.filter((r: any) => r.outcome).length;
      await fetch(`${SUPA}/rest/v1/app_settings?on_conflict=key`, { method: "POST", headers: { ...DBH, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key: "pfr_patterns", value: { text: out.answer, reviews: list.length, with_outcome: known, model: out.model, at: new Date().toISOString() }, updated_at: new Date().toISOString() }) });
      KB_TXT = ""; KB_AT = 0;   // next PFR picks up the new patterns immediately
      return json({ ok: true, reviews: list.length, with_outcome: known, patterns: out.answer, model: out.model });
    }

    if (action === "pfr_knowledge") {
      const rows = await rpcGet(`app_settings?key=in.(pfr_knowledge,pfr_patterns)&select=key,value,updated_at`);
      return json({ ok: true, knowledge: rows });
    }

    if (action === "ask") {
      const sys = clean(body.system) || "You are a helpful assistant for a life-insurance agency. Be concise and accurate. Never invent facts.";
      return json(await claudeCall(sys, clean(body.prompt || body.q), Math.min(Number(body.max_tokens) || 600, 1400)));
    }
    if (action === "extract_budget") {
      let data = (body.data as string) || "";
      const name = (body.filename as string) || "";
      const mime = (body.mime as string) || "";
      const text = (body.text as string) || "";
      const instr = "Extract this household's budget into the exact JSON described. Remember: use the ACTUAL column when both Planned and Actual exist, monthly for income/expenses, balances for assets/invest/debt, only the allowed keys, and make each section's amounts reconcile to any stated Totals row.";
      let content: unknown;
      if (data) {
        if (data.indexOf(",") >= 0 && /^data:/i.test(data)) data = data.slice(data.indexOf(",") + 1);
        data = data.replace(/\s/g, "");
        if (data.length > 14_000_000) return json({ ok: false, error: "File too large — please use a file under ~10 MB." });
        const media = mediaTypeFor(name, mime);
        if (!media) return json({ ok: false, error: "Unsupported file type. Use a PDF, image (PNG/JPG), or paste the text." });
        if (media === "application/pdf") content = [{ type: "document", source: { type: "base64", media_type: media, data } }, { type: "text", text: instr }];
        else content = [{ type: "image", source: { type: "base64", media_type: media, data } }, { type: "text", text: instr }];
      } else if (text) {
        content = instr + "\n\nBUDGET SOURCE:\n" + text.slice(0, 12000);
      } else {
        return json({ ok: false, error: "Nothing to read — attach a file or paste the budget." });
      }
      const out = await claudeMsg(BUDGET_SYS, content, 1500, DOC_MODELS);
      if (!out.ok) return json(out);
      let parsed: unknown = null;
      try { const m = out.answer.match(/\{[\s\S]*\}/); parsed = JSON.parse(m ? m[0] : out.answer); } catch (_) { parsed = null; }
      return json({ ok: true, answer: out.answer, data: parsed, model: out.model });
    }
    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) { return json({ ok: false, error: String(e) }, 500); }
});
