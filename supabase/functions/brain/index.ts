// brain v7 — the Data Brain: usage tracking, real last-seen, dormancy sweep,
// and Coach's next-level nudges.
//
// v7 (2026-09-03): levelup, sweep and restore go through ops_authorize — an Operations
// session or the cron machine token — instead of the literal "2026" that shipped inside
// ops.html. levelup DMs every active broker and sweep ARCHIVES people, so a guessable
// token could message the whole company or deactivate it.
//
// v6 — Kyle is now COACH. Not just a rename: the voice changed. Kyle reported
// numbers politely. Coach is a tough-love coach who throws punch-hugs — warm,
// direct, and unwilling to let anyone coast.
//
// The author_code stays "KYLE" on purpose: it is the identity key in every DM
// channel id, so changing it would orphan 669 existing conversations. The name
// people see is Coach.
//
// v5 — the zero case. 84 of 96 brokers show zero, but MOST OF THEM DO HAVE PAID
// CASHFLOW; the data simply is not in the system yet. So a zero is treated as
// MISSING DATA, not as "you have produced nothing".
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const clean = (s: unknown, n = 2000) => (s ?? "").toString().trim().slice(0, n);
const enc = encodeURIComponent;
const money = (v: number) => "$" + Math.round(v).toLocaleString("en-US");
async function rpc(fn: string, args: Record<string, unknown>) { try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); return await r.json(); } catch (_) { return null; } }
async function opsAuthorized(token: unknown) { const r = await rpc("ops_authorize", { p_token: String(token ?? "") }); return !!(r && r.ok); }

const KINDS = ["login", "page", "ask", "answer", "feedback", "action"];
const COACH_CODE = "KYLE";              // identity key — see the v6 note above
const COACH_NAME = "Coach";
const COACH_ICON = "📣";
const COACH_DM = (code: string) => "dm:" + [norm(code), COACH_CODE].sort().join("|");
const PAID_STATUS = "paid";

const TIERS: { at: number; name: string }[] = [
  { at: 50000, name: "⌚ the $50,000 Watch" },
  { at: 100000, name: "💍 the $100,000 Ring" },
];
function nextMarker(cf: number) { return Math.floor(cf / 10000) * 10000 + 10000; }
function nextTier(cf: number) { return TIERS.find((t) => cf < t.at) || null; }

function levelMessage(first: string, cf: number): string {
  if (cf <= 0) {
    return COACH_ICON + " " + first + " — Coach.\n\n" +
      "Straight talk: I have no paid cashflow on record for you. Nine times out of ten that means it has not been logged, not that it has not happened — but either way the board cannot see you right now, and what the board cannot see, it cannot reward.\n\n" +
      "Ten minutes fixes it:\n" +
      "• Every policy that has paid — log it in New Business and mark it Paid.\n" +
      "• If Operations tracks your number separately, ask them to update it.\n\n" +
      "Do that and I can actually show you how close your next marker is. So — what has paid out for you recently?";
  }

  const marker = nextMarker(cf);
  const gap = marker - cf;
  const tier = nextTier(cf);
  const earned = TIERS.filter((t) => cf >= t.at).map((t) => t.name);

  let msg = COACH_ICON + " " + first + " — Coach.\n\n" +
    money(cf) + " paid out. That is real, and you did it. Now the part you will not love:\n\n" +
    "Your next marker is " + money(marker) + ". That is " + money(gap) + " away — " +
    (gap <= 2500
      ? "close enough that it comes down to this week, not this quarter. Do not let this one sit."
      : "not a mountain. It is a number of conversations, and you know roughly how many.");
  if (tier) msg += "\n\nAfter that, " + tier.name + " is " + money(tier.at - cf) + " out. Keep it in your sights.";
  if (earned.length) msg += "\n\nAlready on the wall: " + earned.join(" · ") + ". Nobody can take those off you.";
  msg += "\n\nIf something has paid that is not showing, log it in New Business so it counts — I can only push you on what I can see.\n\n" +
    "I am in your corner, which is exactly why I am not letting you coast. What is your next application?";
  return msg;
}

async function postCoach(channel: string, bodyTxt: string) {
  await fetch(`${SUPA}/rest/v1/hub_messages`, {
    method: "POST", headers: { ...DBH, Prefer: "return=minimal" },
    body: JSON.stringify({ channel, author_code: COACH_CODE, author_name: COACH_NAME, body: bodyTxt, kind: "coach", attach: null, reactions: {} }),
  });
}

async function paidByAgent(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  try {
    const ex = await fetch(`${SUPA}/rest/v1/policies?select=agent_code,status,expected_commission&limit=20000`, { headers: DBH });
    const rows: Record<string, unknown>[] = (await ex.json()) || [];
    for (const r of rows) {
      if (String(r.status || "").trim().toLowerCase() !== PAID_STATUS) continue;
      const c = norm(r.agent_code); if (!c) continue;
      out[c] = (out[c] || 0) + (Number(r.expected_commission) || 0);
    }
  } catch (_) { /* fall back to the manual field */ }
  return out;
}


/* ===== brain: WHO IS CALLING (2026-09-30) =====
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
    const action = clean(body.action, 40) || "track";
    /* Resolve the caller once, then overwrite the typed code with the verified answer. */
    {
      const _ops = await _isOps((body as Record<string, unknown>).token);
      if (!_ops) {
        const _me = await _sessionCode((body as Record<string, unknown>).session);
        if (!_me) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401);
        (body as Record<string, unknown>).code = _me;
      }
    }

    if (action === "track") {
      const code = norm(body.code);
      const kind = clean(body.kind, 20).toLowerCase();
      if (!code || KINDS.indexOf(kind) < 0) return json({ ok: false, error: "missing code or bad kind" });
      await fetch(`${SUPA}/rest/v1/app_events`, {
        method: "POST", headers: { ...DBH, Prefer: "return=minimal" },
        body: JSON.stringify({
          code, name: clean(body.name, 120), kind, page: clean(body.page, 80),
          detail: (body.detail && typeof body.detail === "object") ? body.detail : {},
        }),
      });
      if (kind === "login" || kind === "page" || kind === "ask") {
        await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${enc(code)}&status=eq.archived`, {
          method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" },
          body: JSON.stringify({ status: "active", archived_at: null }),
        });
        await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${enc(code)}`, {
          method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" },
          body: JSON.stringify({ last_seen: new Date().toISOString(), archived_at: null }),
        });
      }
      return json({ ok: true });
    }

    if (action === "summary") {
      const code = norm(body.code);
      if (!code) return json({ ok: false, error: "no code" });
      const ex = await fetch(`${SUPA}/rest/v1/app_events?code=eq.${enc(code)}&select=kind,page,created_at&order=created_at.desc&limit=1000`, { headers: DBH });
      const rows: Record<string, unknown>[] = (await ex.json()) || [];
      const byKind: Record<string, number> = {}; const byPage: Record<string, number> = {};
      const days = new Set<string>();
      for (const r of rows) {
        byKind[String(r.kind)] = (byKind[String(r.kind)] || 0) + 1;
        if (r.page) byPage[String(r.page)] = (byPage[String(r.page)] || 0) + 1;
        days.add(String(r.created_at).slice(0, 10));
      }
      return json({ ok: true, code, events: rows.length, activeDays: days.size, byKind, byPage, lastEvent: rows[0]?.created_at || null });
    }

    if (action === "leaders") {
      const days = Math.min(365, Math.max(1, Number(body.days) || 30));
      const since = new Date(Date.now() - days * 86400000).toISOString();
      const ex = await fetch(`${SUPA}/rest/v1/app_events?created_at=gte.${enc(since)}&select=code,name,kind,created_at&limit=20000`, { headers: DBH });
      const rows: Record<string, unknown>[] = (await ex.json()) || [];
      const agg: Record<string, { code: string; name: string; events: number; days: Set<string>; asks: number }> = {};
      for (const r of rows) {
        const c = String(r.code || ""); if (!c) continue;
        if (!agg[c]) agg[c] = { code: c, name: String(r.name || ""), events: 0, days: new Set(), asks: 0 };
        agg[c].events++; agg[c].days.add(String(r.created_at).slice(0, 10));
        if (r.kind === "ask") agg[c].asks++;
      }
      const list = Object.values(agg)
        .map((a) => ({ code: a.code, name: a.name, events: a.events, activeDays: a.days.size, asks: a.asks }))
        .sort((x, y) => y.activeDays - x.activeDays || y.events - x.events);
      return json({ ok: true, days, people: list.length, list });
    }

    if (action === "levelup") {
      if (!(await opsAuthorized(body.token))) return json({ ok: false, error: "unauthorized" }, 401);
      const apply = body.apply === true;
      const only = norm(body.only);

      const paid = await paidByAgent();
      const ex = await fetch(`${SUPA}/rest/v1/tracker_agents?select=code,first_name,last_name,cashflow,status&code=neq.POOL&limit=5000`, { headers: DBH });
      const rows: Record<string, unknown>[] = (await ex.json()) || [];
      const targets = rows.filter((r) => {
        if (String(r.status || "active") !== "active") return false;
        if (only && norm(r.code) !== only) return false;
        return true;
      });

      const lex = await fetch(`${SUPA}/rest/v1/app_settings?key=eq.levelup_log&select=value`, { headers: DBH });
      const lrows = await lex.json();
      let log: string[] = (lrows && lrows[0] && Array.isArray(lrows[0].value?.keys)) ? lrows[0].value.keys : [];
      const day = new Date().toISOString().slice(0, 10);

      const preview: Record<string, unknown>[] = [];
      let sent = 0, correctedByPolicies = 0, missingData = 0;
      for (const r of targets) {
        const code = norm(r.code);
        const first = String(r.first_name || "").trim() || code;
        const manual = Number(r.cashflow) || 0;
        const fromPolicies = paid[code] || 0;
        const cf = Math.max(manual, fromPolicies);
        if (fromPolicies > manual) correctedByPolicies++;
        if (cf <= 0) missingData++;
        const k = code + "|" + day;
        if (apply && log.indexOf(k) >= 0) continue;
        const msg = levelMessage(first, cf);
        if (apply) { await postCoach(COACH_DM(code), msg); log.push(k); sent++; }
        else if (preview.length < 10) preview.push({ code, first, manual, fromPolicies, used: cf, message: msg });
      }

      if (apply && sent) {
        if (log.length > 3000) log = log.slice(log.length - 3000);
        await fetch(`${SUPA}/rest/v1/app_settings?on_conflict=key`, {
          method: "POST", headers: { ...DBH, Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify({ key: "levelup_log", value: { keys: log }, updated_at: new Date().toISOString() }),
        });
      }
      return json({ ok: true, applied: apply, eligible: targets.length, sent, correctedByPolicies, missingData, preview });
    }

    if (action === "sweep") {
      if (!(await opsAuthorized(body.token))) return json({ ok: false, error: "unauthorized" }, 401);
      const days = Math.min(3650, Math.max(30, Number(body.days) || 90));
      const cutoff = new Date(Date.now() - days * 86400000).toISOString();
      const apply = body.apply === true;
      const ex = await fetch(`${SUPA}/rest/v1/tracker_agents?select=code,first_name,last_name,status,last_seen,last_activity,created_at&code=neq.POOL&limit=5000`, { headers: DBH });
      const rows: Record<string, unknown>[] = (await ex.json()) || [];
      const targets = rows.filter((r) => {
        if (String(r.status || "active") !== "active") return false;
        const seen = r.last_seen || r.last_activity;
        if (!seen) return false;
        return String(seen) < cutoff;
      }).map((r) => ({ code: r.code, name: ((r.first_name || "") + " " + (r.last_name || "")).trim(), last: r.last_seen || r.last_activity }));
      if (apply) {
        for (const t of targets) {
          await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${enc(String(t.code))}`, {
            method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" },
            body: JSON.stringify({ status: "archived", archived_at: new Date().toISOString() }),
          });
        }
      }
      const noSignal = rows.filter((r) => String(r.status || "active") === "active" && !(r.last_seen || r.last_activity)).length;
      return json({ ok: true, days, cutoff, applied: apply, count: targets.length, targets: targets.slice(0, 200), skippedNoSignal: noSignal });
    }

    if (action === "restore") {
      if (!(await opsAuthorized(body.token))) return json({ ok: false, error: "unauthorized" }, 401);
      const code = norm(body.code);
      if (!code) return json({ ok: false, error: "no code" });
      const up = await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${enc(code)}`, {
        method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" },
        body: JSON.stringify({ status: "active", archived_at: null }),
      });
      return json({ ok: up.ok, code });
    }

    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
