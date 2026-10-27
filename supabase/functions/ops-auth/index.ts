// ops-auth v6 — sign-in for the Operations platform.
//
// Until now a 4-digit platform code WAS the whole credential, and every admin call
// then carried the literal string "2026" as its authorisation. Both are readable by
// anyone: the code is short enough to guess and the token shipped inside ops.html.
// Anyone holding either could reset any agent's PIN and sign in as them.
//
// So: Operations now picks a 6-digit PIN (bcrypt, in Postgres, never readable), and a
// successful sign-in mints a random 32-byte session that expires in 8 hours. Admin
// endpoints validate that session instead of a shared literal, so authority is tied to
// a person who signed in and can be revoked.
//
// Actions:
//   status { code }             -> does this seat have a PIN yet?
//   set    { code, pin, setup } -> choose one (first time only; v7 needs the one-time setup code)
//   login  { code, pin }        -> verify and mint a session token
//   check  { token }            -> is this session still good? (who does it belong to?)
//   logout { token }            -> end it now
//   enroll { token, code, minutes } -> a MASTER seat opens first-PIN setup for another seat
//   reset  { token|session, code, minutes } -> clear a forgotten seat PIN and reopen setup
//
// v2 (2026-10-23) ADDS `enroll`, AND IT CLOSES A DEAD END RATHER THAN ADDING A FEATURE.
//
// ops_pin_set() refuses a first PIN unless a short enrollment window is open, which is right:
// without it, whoever typed a seat code first owned that seat. ops_pin_enroll() exists in the
// database to open that window and is correctly master-gated.
//
// Nothing ever called it. There was no action here and no UI anywhere, so the only way to open
// a window was direct database access. Meanwhile the sign-in screen told the locked-out person
// "Ask Operations to open setup for it" -- an instruction Operations had no way to carry out.
// A seat whose PIN had been cleared was therefore unrecoverable by the people who own the
// platform, which is how the Operations MASTER seat came to be stranded.
//
// The window stays capped at 240 minutes here as well as in the function. That cap is the
// whole safety property: while a window is open on a seat, the first person to type that code
// claims it, and the master seat sees every baseshop.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const clean = (s: unknown, n = 80) => (s ?? "").toString().trim().slice(0, n);

async function rpc(fn: string, args: Record<string, unknown>) {
  const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) });
  return await r.json();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const action = clean(body.action, 20) || "login";

    if (action === "status") {
      return json(await rpc("ops_pin_status", { p_code: clean(body.code, 8) }));
    }

    if (action === "set") {
      const pin = clean(body.pin, 8);
      if (!/^[0-9]{6}$/.test(pin)) return json({ ok: false, error: "Your Operations PIN must be 6 digits." });
      /* v7: the one-time setup code handed out by enroll/reset is required. Knowing a seat
         number during an open setup window is no longer enough to claim the seat. */
      const setup = clean(body.setup, 12);
      if (!setup) return json({ ok: false, needs_setup: true, error: "Enter the setup code you were given with this seat." });
      return json(await rpc("ops_pin_set", { p_code: clean(body.code, 8), p_pin: pin, p_setup: setup }));
    }

    if (action === "login") {
      const pin = clean(body.pin, 8);
      if (!/^[0-9]{6}$/.test(pin)) return json({ ok: false, error: "Enter your 6-digit Operations PIN." });
      return json(await rpc("ops_login", {
        p_code: clean(body.code, 8), p_pin: pin,
        p_ua: clean(req.headers.get("user-agent") || "", 300),
      }));
    }

    /* A master seat, or a platform admin, opens first-PIN setup for another seat. Authority is
       the CALLER'S OWN credential; ops_pin_enroll() decides which credentials count and still
       refuses a seat that already has a PIN -- this adds no new trust, it makes existing trust
       reachable.

       TWO DIFFERENT CREDENTIALS CAN AUTHORISE IT, AND THEY ARRIVE IN DIFFERENT FIELDS.
       `token` is the Operations SEAT session the page holds. `session` is the caller's own
       agent session, which session.js injects into every /functions/v1/ call. A master seat
       proves itself with the first; a platform admin proves themselves with the second and
       holds no seat token at all -- which is exactly why they were locked out, and why passing
       only `token` here silently dropped the one credential they had. */
    if (action === "enroll") {
      const mins = Math.max(5, Math.min(Number(body.minutes) || 60, 240));
      const code = clean(body.code, 8);
      const seat = clean(body.token, 80);
      const sess = clean(body.session, 120);
      /* ops_pin_enroll() takes ONE token, so try the seat then fall back to the session. The
         function remains the single authority on which of them counts. */
      let r: any = seat ? await rpc("ops_pin_enroll", { p_token: seat, p_code: code, p_minutes: mins }) : null;
      if ((!r || r.ok !== true) && sess) {
        r = await rpc("ops_pin_enroll", { p_token: sess, p_code: code, p_minutes: mins });
      }
      return json(r || { ok: false, error: "Sign in to an Operations seat first." });
    }

    /* v6 (2026-10-26): THE WAY BACK IN WHEN A PIN IS FORGOTTEN. enroll refuses a seat that
       already has a PIN, so a forgotten PIN on seat 0000 had no recovery short of database
       surgery -- the exact surgery that stranded it before. ops_pin_reset() clears the PIN and
       opens a setup window in one step, ends that seat's sessions, and is the only thing the
       database guard lets wipe the permanent seat's PIN. Same two credentials as enroll. */
    if (action === "reset") {
      const mins = Math.max(5, Math.min(Number(body.minutes) || 60, 240));
      const code = clean(body.code, 8);
      const seat = clean(body.token, 80);
      const sess = clean(body.session, 120);
      let r: any = seat ? await rpc("ops_pin_reset", { p_token: seat, p_code: code, p_minutes: mins }) : null;
      if ((!r || r.ok !== true) && sess) {
        r = await rpc("ops_pin_reset", { p_token: sess, p_code: code, p_minutes: mins });
      }
      return json(r || { ok: false, error: "Sign in first." });
    }

    if (action === "check")  return json(await rpc("ops_session_ok", { p_token: clean(body.token, 80) }));
    if (action === "logout") return json(await rpc("ops_logout",     { p_token: clean(body.token, 80) }));

    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
