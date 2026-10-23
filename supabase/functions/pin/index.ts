// pin v13 — 4-digit sign-in PINs for The Standard, and the thing that issues an agent session.
//
// v12 (2026-10-23) — ACCOUNT TAKEOVER, CLOSED. `issue_setup_code` decided who was allowed to
// vouch for somebody's first PIN by reading `by_code` out of the REQUEST BODY and asking
// whether that code was a platform admin or the target's upline. Agent codes are printed on
// the org chart. So with no credential at all:
//     {"action":"issue_setup_code","code":"<anyone>","by_code":"<a platform admin's code>"}
// returned a valid setup code, and pin_set(<anyone>, <a PIN of your choosing>, <that code>)
// then took the account. Measured, not supposed: three borrowed codes -- a platform admin, the
// org root, and the target's own upline -- each passed the check with no token. 89 of 137
// accounts had no PIN and were claimable this way.
//
// This is the same bug class v8 and v11 closed elsewhere in this very file: a GFI code is a
// public identifier, never a credential. It survived here because `issue_setup_code` has no UI
// and no client ever called it, so nothing exercised it and nothing complained. Authority now
// comes from the caller's own agent session, or a real Operations token; `by_code` remains only
// as the byline recorded against the issued code.
//
// The PIN is hashed with bcrypt in Postgres (pgcrypto) and never stored or logged in readable
// form. PIN material lives in its own table (agent_pins), NOT on tracker_agents: tracker-api
// returns whole agent rows to the browser, so a hash stored there would be handed out to anyone
// holding a GFI code and cracked offline in seconds.
//
// v11 (2026-09-30) — VERIFYING A PIN NOW ISSUES AN AGENT SESSION. Until today the rest of the
// platform took a bare agent code as proof of identity, and codes are printed on the org chart,
// so one person could read and in places write as another. A session token is the only thing that
// can answer "who is actually calling", and the only honest place to mint one is the moment
// somebody proves who they are with their PIN. Resetting a PIN revokes every session for that
// person, so a stolen session cannot outlive the credential it came from.
//
// v8 (2026-09-30) — CLAIMING AN ACCOUNT NEEDS PROOF, NOT JUST PUBLIC FACTS. Name + code are both
// on the org chart. First-time setup also requires the email or last 4 of the phone on the
// record, or a one-time setup code from Operations or the person's own upline.
//
// THE RULE, set by Christopher 2026-09-17: "be within 90% accuracy of the name as an acceptance.
// 100% accuracy of the code."
//   CODE  — exact, always. Never fuzzy-matched in any action.
//   NAME  — forgiving. A second factor, not a spelling test.
//
// v7 counts a TRANSPOSITION as one edit (Damerau). v5 added middle-name tolerance after seven
// agents were locked out of their own accounts. v3 closed an earlier takeover on 'reset'.
//
// Actions: status | set | verify | reset | needs_setup | issue_setup_code | logout
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const clean = (s: unknown, n = 80) => (s ?? "").toString().trim().slice(0, n);

const tokens = (s: unknown) =>
  (s ?? "").toString().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);

// Damerau-Levenshtein: insert, delete, substitute OR transpose, each costing one.
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const d: number[][] = [];
  for (let i = 0; i <= a.length; i++) { d[i] = new Array(b.length + 1).fill(0); d[i][0] = i; }
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + cost);
      }
    }
  }
  return d[a.length][b.length];
}
function similarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  return longest ? (longest - editDistance(a, b)) / longest : 1;
}
const NAME_THRESHOLD = 0.80;

function nameMatches(typed: unknown, stored: unknown): boolean {
  const t = tokens(typed), s = tokens(stored);
  if (!t.length || !s.length) return false;
  const tj = t.join(""), sj = s.join("");
  if (tj === sj) return true;                                   // same name, any spacing
  if (t[0] === s[0]) return true;                               // "Jon" vs "Jon Paul"
  if (t[t.length - 1] === s[s.length - 1]) return true;         // "Gillis" vs "Dwight Gillis"
  if (t.some((x) => s.indexOf(x) >= 0)) return true;            // a middle name typed on its own
  if (similarity(tj, sj) >= NAME_THRESHOLD) return true;        // a typo
  return t.some((x) => s.some((y) => x.length >= 4 && similarity(x, y) >= NAME_THRESHOLD));
}

async function rpc(fn: string, args: Record<string, unknown>) {
  const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, {
    method: "POST", headers: DBH, body: JSON.stringify(args),
  });
  return await r.json();
}
async function opsOk(token: string) {
  const r = await rpc("ops_authorize", { p_token: token });
  return !!(r && r.ok);
}
/* WHO MAY VOUCH FOR SOMEBODY ELSE'S FIRST PIN.
   This decides whether a setup code is minted, and a setup code is proof-of-identity for
   pin_set(). Get it wrong and it is not a data leak, it is account takeover.

   IT WAS WRONG. It read `by_code` straight from the request body and asked whether THAT code
   was a platform admin or the target's upline. Agent codes are printed on the org chart, so
   with no token at all:
       {"action":"issue_setup_code","code":"<anyone>","by_code":"<a platform admin's code>"}
   returned a valid 6-character setup code, and
       pin_set(<anyone>, <a PIN you choose>, <that setup code>)
   then claimed the account. Measured on 2026-10-23: three different borrowed codes -- a
   platform admin, the org root, and the target's own upline -- all passed this check with no
   credential whatsoever. 89 of 137 accounts had no PIN at the time and were therefore
   claimable by anyone who could reach the endpoint.

   Identity now comes from the caller's own AGENT SESSION, which session.js injects into every
   /functions/v1/ call, or from a real Operations token. `by_code` is still accepted but only
   as the BYLINE recorded against the issued code -- never as the authority to issue one.
   Nothing in the client passed by_code for authority, because nothing in the client calls this
   at all; the only caller it ever had was a person with curl. */
async function mayVouchFor(target: string, token: string, session: string): Promise<string> {
  if (await opsOk(token)) return "OPS";
  const s = (session ?? "").toString().trim().slice(0, 120);
  if (!s) return "";
  const got = await rpc("agent_session_code", { p_token: s });
  const me = (typeof got === "string") ? norm(got) : "";
  if (!me) return "";
  if (await rpc("is_platform_admin", { p_code: me }) === true) return me;
  if ((await rpc("is_in_downline", { p_leader: me, p_target: norm(target) })) === true) return me;
  return "";
}
/* Who is asking, for a question that is not about one named person. Same two authorities as
   mayVouchFor, minus the per-target downline test, which the caller applies per row instead. */
async function whoIsAsking(token: string, session: string): Promise<{ ops: boolean; code: string; admin: boolean }> {
  if (await opsOk(token)) return { ops: true, code: "OPS", admin: true };
  const s = (session ?? "").toString().trim().slice(0, 120);
  if (!s) return { ops: false, code: "", admin: false };
  const got = await rpc("agent_session_code", { p_token: s });
  const me = (typeof got === "string") ? norm(got) : "";
  if (!me) return { ops: false, code: "", admin: false };
  const admin = (await rpc("is_platform_admin", { p_code: me })) === true;
  return { ops: false, code: me, admin };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    let body: Record<string, unknown> = {};
    if (req.method === "POST") body = await req.json().catch(() => ({}));
    const action = clean(body.action, 20);
    const ua = clean(req.headers.get("user-agent") || "", 200);

    /* Ending a session needs only the session itself. */
    if (action === "logout") {
      const res = await rpc("agent_session_revoke", { p_token: clean(body.session, 80) });
      return json(res || { ok: true });
    }

    /* WHO CANNOT SIGN IN, AND WHY. Operations had no way to see this: the tracker carries no
       email, no phone and no PIN state, so the people who were stuck were invisible to the
       people who could unstick them. On 2026-10-23, 66 ACTIVE agents had no PIN, no email and
       no usable phone -- pin_set() offers them no proof route at all, so they could not set a
       first PIN by any means, and nobody could tell. Christian Monaghan was one of them and it
       took a direct report from Christopher to surface him.
       Scoped like everything else: Operations and platform admins see everyone, a leader sees
       their own downline. */
    if (action === "needs_setup") {
      const who = await whoIsAsking(clean(body.token, 80), clean(body.session, 120));
      if (!who.ops && !who.code) return json({ ok: false, error: "Sign in first." }, 401);
      const r = await fetch(
        `${SUPA}/rest/v1/tracker_agents?select=code,first_name,last_name,email,phone,status,baseshop,direct_to,direct_to_name&limit=5000`,
        { headers: DBH },
      );
      const agents: Record<string, unknown>[] = (await r.json()) || [];
      const pr = await fetch(`${SUPA}/rest/v1/agent_pins?select=code&limit=5000`, { headers: DBH });
      const withPin = new Set(((await pr.json()) || []).map((p: Record<string, unknown>) => norm(p.code)));
      const seeAll = who.ops || who.admin;
      const out: Record<string, unknown>[] = [];
      for (const a of agents) {
        const c = norm(a.code);
        if (!c || withPin.has(c)) continue;
        if (String(a.status || "") !== "active") continue;
        if (!seeAll) {
          const mine = (await rpc("is_in_downline", { p_leader: who.code, p_target: c })) === true;
          if (!mine) continue;
        }
        const email = clean(a.email, 120);
        const digits = clean(a.phone, 40).replace(/[^0-9]/g, "");
        out.push({
          code: a.code, name: `${a.first_name || ""} ${a.last_name || ""}`.trim(),
          baseshop: a.baseshop || "", upline: a.direct_to_name || a.direct_to || "",
          has_email: !!email, has_phone: digits.length >= 4,
          /* The whole point of the list: with neither, pin_set() has no route to offer them
             and a setup code is the ONLY way in. */
          can_self_serve: !!email || digits.length >= 4,
        });
      }
      out.sort((x, y) => Number(x.can_self_serve) - Number(y.can_self_serve) ||
                         String(x.name).localeCompare(String(y.name)));
      return json({
        ok: true, scope: seeAll ? "all" : "downline", count: out.length,
        stuck: out.filter((o) => !o.can_self_serve).length, agents: out.slice(0, 400),
      });
    }

    // THE CODE IS EXACT. It is never fuzzy-matched, in any action.
    const code = norm(body.code);
    if (!code) return json({ ok: false, error: "Enter your GFI code." });

    if (action === "status") {
      const res = await rpc("pin_status", { p_code: code });
      if (res && res.ok) {
        return json({ ok: true, has_pin: !!res.has_pin, locked: !!res.locked, name: res.name || "" });
      }
      return json(res);
    }

    if (action === "set") {
      const pin = clean(body.pin, 8);
      if (!/^[0-9]{4}$/.test(pin)) return json({ ok: false, error: "Your PIN must be 4 digits." });
      if (/^(\d)\1{3}$/.test(pin) || pin === "1234" || pin === "0000" || pin === "4321") {
        return json({ ok: false, error: "Pick something less guessable than that." });
      }

      const st = await rpc("pin_status", { p_code: code });
      if (!st || !st.ok) return json(st || { ok: false, error: "We don't recognise that code." });
      if (st.has_pin) return json({ ok: false, error: "A PIN is already set. Ask Operations to reset it." });

      const first = clean(body.first, 60);
      const last = clean(body.last, 60);
      if (!tokens(first).length || !tokens(last).length) {
        return json({ ok: false, error: "Enter your first and last name to set up your PIN.", needs_name: true });
      }
      if (!tokens(st.first_name).length || !tokens(st.last_name).length) {
        return json({ ok: false, error: "This account is missing its name. Ask Operations to finish setting it up." });
      }
      if (!nameMatches(first, st.first_name) || !nameMatches(last, st.last_name)) {
        return json({ ok: false, error: "That name does not match this code.", needs_name: true });
      }

      // and one thing the org chart does not show.
      const proof = clean(body.proof, 120);
      const res = await rpc("pin_set", { p_code: code, p_pin: pin, p_proof: proof || null });
      if (res && res.ok) {
        const sess = await rpc("agent_session_new", { p_code: code, p_ua: ua });
        if (sess && sess.ok) return json({ ok: true, session: sess.token, code });
      }
      return json(res);
    }

    if (action === "verify") {
      const pin = clean(body.pin, 8);
      if (!/^[0-9]{4}$/.test(pin)) return json({ ok: false, error: "Enter your 4-digit PIN." });
      const res = await rpc("pin_verify", { p_code: code, p_pin: pin });
      if (res && res.ok) {
        /* The session is minted HERE and nowhere else: the only moment this platform actually
           knows who somebody is, is the moment they prove it with their PIN. */
        const sess = await rpc("agent_session_new", { p_code: code, p_ua: ua });
        if (sess && sess.ok) return json({ ok: true, session: sess.token, code });
      }
      return json(res);
    }

    if (action === "reset") {
      if (!(await opsOk(clean(body.token, 80)))) return json({ ok: false, error: "unauthorized" }, 401);
      const res = await rpc("pin_reset", { p_code: code });
      // a reset credential must take its sessions with it
      await rpc("agent_sessions_revoke_all", { p_code: code });
      return json(res);
    }

    if (action === "issue_setup_code") {
      /* The VERIFIED caller, not a code they typed. Whatever by_code says is only a label. */
      const who = await mayVouchFor(code, clean(body.token, 80), clean(body.session, 120));
      if (!who) {
        return json({ ok: false, error: "Only Operations or this person's upline can issue a setup code." }, 403);
      }
      const res = await rpc("agent_setup_code_issue", { p_code: code, p_by: who });
      return json(res);
    }

    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
