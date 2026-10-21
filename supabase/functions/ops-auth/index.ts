// ops-auth v1 — sign-in for the Operations platform.
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
//   set    { code, pin }        -> choose one (first time only)
//   login  { code, pin }        -> verify and mint a session token
//   check  { token }            -> is this session still good? (who does it belong to?)
//   logout { token }            -> end it now
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
      return json(await rpc("ops_pin_set", { p_code: clean(body.code, 8), p_pin: pin }));
    }

    if (action === "login") {
      const pin = clean(body.pin, 8);
      if (!/^[0-9]{6}$/.test(pin)) return json({ ok: false, error: "Enter your 6-digit Operations PIN." });
      return json(await rpc("ops_login", {
        p_code: clean(body.code, 8), p_pin: pin,
        p_ua: clean(req.headers.get("user-agent") || "", 300),
      }));
    }

    if (action === "check")  return json(await rpc("ops_session_ok", { p_token: clean(body.token, 80) }));
    if (action === "logout") return json(await rpc("ops_logout",     { p_token: clean(body.token, 80) }));

    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
