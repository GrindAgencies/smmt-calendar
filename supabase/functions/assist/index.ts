// assist v4 — the ask-anything assistant, available to every agent on every screen.
//
// v4 (2026-09-07) gives it eyes and an escape hatch:
//   1. Its map of the app moved OUT of this file into app_settings.help_knowledge. The agency
//      can now teach it a new screen or a changed rule without a code deploy — the same pattern
//      proved on the PFR. The copy below stays as a fallback so a missing row never breaks it.
//   2. It reads the latest Watchtower health snapshot, so when someone asks "is booking broken?"
//      it can say yes, we know, since 9:10 — instead of guessing.
//   3. escalate: when it cannot help, it opens a real ticket in the Operations channel rather
//      than leaving the agent at a dead end.
//
// v3 note, still in force: it retrieves from brain_knowledge — the trainings leaders upload in
// Resources — and answers from the agency's own material where it fits, crediting the trainer.
//
// v2 note, still in force: the assistant does not compute anyone's premium or progress. v1
// summed raw annual_premium and reported $13,160 while Home showed $16.7K, because the dashboard
// weights split sales by each writer's share. An assistant that contradicts the dashboard is
// worse than one that declines.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const clean = (s: unknown, n = 2000) => (s ?? "").toString().trim().slice(0, n);
const enc = encodeURIComponent;
const OPS_CHANNEL = "operations";

const MODELS = ["claude-haiku-4-5", "claude-haiku-4-5-20251001", "claude-sonnet-4-6", "claude-3-5-haiku-20241022", "claude-3-5-sonnet-20241022"];
async function callClaude(sys: string, prompt: string, maxTokens: number): Promise<{ txt: string; model?: string; err?: string }> {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return { txt: "", err: "no ANTHROPIC_API_KEY set" };
  let lastErr = "no models tried";
  for (const model of MODELS) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model, max_tokens: maxTokens, system: sys, messages: [{ role: "user", content: prompt || "hello" }] }),
      });
      const j = await res.json();
      const txt = (j?.content?.[0]?.text) ? String(j.content[0].text).trim() : "";
      if (txt) return { txt, model };
      const em = j?.error?.message || j?.error?.type || "no text";
      lastErr = model + ": " + em;
      if (/authentication|invalid x-api-key|permission|credit|billing/i.test(String(em))) return { txt: "", err: String(em) };
    } catch (e) { lastErr = model + ": " + String(e); }
  }
  return { txt: "", err: lastErr };
}

/* Fallback only. The live copy lives in app_settings.help_knowledge — edit that, not this. */
const APP_MAP_FALLBACK = `
THE STANDARD — what each screen does:
- Home: your morning dashboard, Today's Snapshot and the live leaderboard. The menu is a collapsible rail on the left.
- Team Hub: internal chat with channels, DMs, mentions and bots.
- Scheduler: book a Certified Field Trainer or your baseshop's Operations team.
- New Business: log every submitted application and move it through its stages.
- My Tracker: your progression board.
- Resources: carriers, scripts, recordings and team trainings.
- Marketing Plan: your Top 100 warm-market list.
- My Team / Org Chart: your downline and the full hierarchy.
- PFR Builder: build a client's financial review.
- Ops Dashboard: Operations only (codes 0000-0005).
- Profile: photo, contact details and notification settings.
Licensing help: Operations (Anais) 858-433-4429.
`;

let KB = ""; let KB_AT = 0;
async function appMap(): Promise<string> {
  if (KB && (Date.now() - KB_AT) < 300000) return KB;
  let txt = "";
  try {
    const r = await fetch(`${SUPA}/rest/v1/app_settings?key=eq.help_knowledge&select=value`, { headers: DBH });
    const rows = await r.json();
    txt = (rows && rows[0] && rows[0].value && rows[0].value.text) ? String(rows[0].value.text) : "";
  } catch (_) { txt = ""; }
  KB = txt || APP_MAP_FALLBACK; KB_AT = Date.now();
  return KB;
}

/* What the Watchtower currently sees. Lets the assistant say "yes, we know" instead of guessing. */
async function healthNote(): Promise<string> {
  try {
    const r = await fetch(`${SUPA}/rest/v1/health_snapshots?order=created_at.desc&limit=1&select=status,findings,created_at`, { headers: DBH });
    const s = ((await r.json()) || [])[0];
    if (!s || s.status === "ok") return "\nPLATFORM STATUS: all monitored checks are healthy right now.\n";
    const items = (s.findings || []).map((f: any) => "- " + f.title).join("\n");
    return "\nPLATFORM STATUS — the monitor currently reports " + s.status.toUpperCase() + " (checked " + String(s.created_at).slice(11, 16) + " UTC):\n" + items +
      "\nIf the person's problem matches one of these, tell them plainly that it is a known issue already with Operations, and roughly what it affects. Do NOT claim it is fixed.\n";
  } catch (_) { return ""; }
}

/* Identity only. Deliberately NO derived figures — see the v2 note at the top. */
async function agentContext(code: string): Promise<string> {
  if (!code) return "";
  try {
    const ex = await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${enc(code)}&select=first_name,last_name,title,contract_level,baseshop,md,emd`, { headers: DBH });
    const a = ((await ex.json()) || [])[0];
    if (!a) return "";
    const nm = ((a.first_name || "") + " " + (a.last_name || "")).trim();
    return `\nABOUT THE PERSON ASKING:\n- Name: ${nm} (${code}) — greet them by first name.\n- Level: ${a.contract_level || a.title || "Associate"} · baseshop ${a.baseshop || "—"}\n- Upline: MD ${a.md || "—"}, EMD ${a.emd || "—"}\n`;
  } catch (_) { return ""; }
}

/* The agency's own trainings, ranked against this question. */
async function agencyKnowledge(q: string): Promise<{ block: string; used: string[] }> {
  try {
    const r = await fetch(`${SUPA}/rest/v1/rpc/brain_search`, {
      method: "POST", headers: DBH, body: JSON.stringify({ q, lim: 3 }),
    });
    const hits = (await r.json()) || [];
    if (!Array.isArray(hits) || !hits.length) return { block: "", used: [] };
    const used: string[] = [];
    let block = "\nTHE AGENCY'S OWN TRAINING MATERIAL (use this first when it fits the question, and say who taught it):\n";
    for (const h of hits.slice(0, 3)) {
      used.push(String(h.id));
      block += `\n--- "${h.title}"${h.created_by_name ? " — taught by " + h.created_by_name : ""} ---\n`;
      if (h.summary) block += String(h.summary).slice(0, 600) + "\n";
      block += String(h.content || "").slice(0, 2500) + "\n";
    }
    return { block, used };
  } catch (_) { return { block: "", used: [] }; }
}

async function markUsed(ids: string[]) {
  for (const id of ids) {
    try { await fetch(`${SUPA}/rest/v1/rpc/brain_mark_used`, { method: "POST", headers: DBH, body: JSON.stringify({ p_id: id }) }); } catch (_) { /* never block an answer */ }
  }
}

async function track(code: string, name: string, kind: string, page: string, detail: Record<string, unknown>) {
  try {
    await fetch(`${SUPA}/rest/v1/app_events`, {
      method: "POST", headers: { ...DBH, Prefer: "return=minimal" },
      body: JSON.stringify({ code, name, kind, page, detail }),
    });
  } catch (_) { /* never block an answer on logging */ }
}


/* ===== assist: WHO IS CALLING (2026-09-30) =====
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
    const action = clean(body.action, 30) || "ask";
    /* Resolve the caller once, then overwrite the typed code with the verified answer. */
    {
      const _ops = await _isOps((body as Record<string, unknown>).token);
      if (!_ops) {
        const _me = await _sessionCode((body as Record<string, unknown>).session);
        if (!_me) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401);
        (body as Record<string, unknown>).code = _me;
      }
    }
    const code = norm(body.code);
    const name = clean(body.name, 120);
    const page = clean(body.page, 80);

    /* Thumbs up/down on an answer. */
    if (action === "feedback") {
      await track(code, name, "feedback", page, {
        rating: clean(body.rating, 10), q: clean(body.q, 600), a: clean(body.a, 2000),
      });
      return json({ ok: true });
    }

    /* The assistant could not help — hand it to a human instead of a dead end. */
    if (action === "escalate") {
      const q = clean(body.q, 600);
      if (!q) return json({ ok: false, error: "nothing to escalate" });
      const nm = name || code || "An agent";
      const text = "\u{1F64B} Help needed — *" + nm + "*" + (code ? (" (" + code + ")") : "") +
        (page ? (" on " + page) : "") + "\n“" + q + "”" +
        (body.a ? ("\n\n_The assistant answered:_ " + clean(body.a, 500)) : "") +
        "\n_Sent from the Ask assistant because it could not resolve this._";
      await fetch(`${SUPA}/rest/v1/hub_messages`, {
        method: "POST", headers: { ...DBH, Prefer: "return=minimal" },
        body: JSON.stringify({ channel: OPS_CHANNEL, author_code: "HELPDESK", author_name: "\u{1F6DF} Help Desk", kind: "system", body: text }),
      }).catch(() => {});
      await track(code, name, "escalate", page, { q, a: clean(body.a, 2000) });
      return json({ ok: true, message: "Sent to Operations — they will pick it up in the Operations channel." });
    }

    const q = clean(body.q, 1200);
    if (!q) return json({ ok: false, error: "no question" });

    const map = await appMap();
    const ctx = await agentContext(code);
    const kn = await agencyKnowledge(q);
    const health = await healthNote();

    const sys = "You are the assistant inside The Standard, the internal platform for The Standard Financial Group, a life-insurance agency. You help agents with ANY question about using the platform or about their business here.\n" +
      map + ctx + kn.block + health +
      "\nHOW TO ANSWER: Be warm, direct and specific. Under 120 words unless they ask for detail. When the answer is a place in the app, name the exact screen and the exact button.\n" +
      (kn.block ? "When the agency's own training material above answers the question, use it and name the trainer who taught it — that material is more authoritative than anything you know generally.\n" : "") +
      "NEVER quote or estimate anyone's premium, commission, progress, rank or goal figures — you do not have reliable access to them and the dashboard weights split sales in ways you cannot see. For any question about their numbers, tell them exactly where to look (Home for this month's snapshot and the leaderboard, New Business for policies, My Tracker for progression) and offer to explain what the number means.\n" +
      "If the person is reporting something BROKEN and it does not match a known issue above, say you will pass it to Operations and tell them to use the 'Send to Operations' option.\n" +
      "If you genuinely do not know, or it involves compliance or another person's client data, say so and point them to Operations (Anais, 858-433-4429). Never invent features that are not described above.";

    const r = await callClaude(sys, q, 500);
    const answer = r.txt || "I couldn't reach the assistant just now. For anything urgent, Operations (Anais) is on 858-433-4429.";

    if (r.txt && kn.used.length) await markUsed(kn.used);

    await track(code, name, "ask", page, { q, a: answer, model: r.model || "", ok: !!r.txt, err: r.err || "", knowledge_used: kn.used });

    return json({ ok: !!r.txt, answer, model: r.model || "", used_training: kn.used.length > 0, error: r.err || "" });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
