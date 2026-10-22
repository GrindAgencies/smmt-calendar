// account-delete v1 (2026-09-30) — the member deletes their own account.
//
// Apple 5.1.1(v) and Google Play both require this, in the app, initiated by the person, and Play
// additionally requires a route that works WITHOUT the app. The platform had neither — the privacy
// policy said "contact your upline", which is not user-initiated deletion and is a plain rejection
// on both stores.
//
// IDENTITY IS PROVEN BY THE PIN. That is deliberate and it is stricter than the rest of this
// platform, which still accepts a bare agent code as proof of who you are. Deleting an account is
// exactly the wrong place to inherit that weakness: agent codes are visible on the org chart, and
// without the PIN anyone could close a colleague's account.
//
// What is destroyed: sign-in, PIN, registered devices, presence, notification preferences, email,
// phone, state, calendar links, warm market.
// What is retained, and why: the person's NAME and their position on the org tree, because an
// insurance agency must keep the record of who wrote which policy. They become an Alumni shadow
// node — which is what departure already means here. This is disclosed in the app, on the public
// page and in the privacy policy, because the stores require the retention to be stated.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const clean = (s: unknown, n = 80) => (s ?? "").toString().trim().slice(0, n);

async function rpc(fn: string, args: Record<string, unknown>) {
  const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) });
  const t = await r.text();
  try { return JSON.parse(t); } catch (_) { return { ok: false, error: t.slice(0, 200) }; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: Record<string, unknown> = {};
  try { body = req.method === "POST" ? await req.json() : Object.fromEntries(new URL(req.url).searchParams); } catch (_) { body = {}; }

  const action = clean(body.action, 24) || "delete";

  /* What the app and the public page show before anyone presses the button. Kept here so the
     wording the stores review cannot drift away from what the code actually does. */
  if (action === "what_happens") {
    return json({
      ok: true,
      destroyed: [
        "Your sign-in and PIN — you will not be able to log in again",
        "Every device registered for notifications",
        "Your email address, phone number and state",
        "Your calendar links and your warm-market list",
      ],
      retained: [
        "Your name and your place on the org chart, kept as an Alumni record",
        "Policies you wrote and the commissions attached to them",
      ],
      why_retained: "The agency is required to keep the record of who wrote which policy. This is the same thing that happens when someone leaves.",
      reversible: false,
      contact: "admin@grindagencies.com",
    });
  }

  if (action === "delete") {
    const code = clean(body.code, 24);
    const pin = clean(body.pin, 12);
    const channel = clean(body.channel, 12) === "web" ? "web" : "in_app";
    if (!code) return json({ ok: false, error: "Enter your GFI code." }, 400);
    if (!/^[0-9]{4}$/.test(pin)) return json({ ok: false, error: "Enter your 4-digit PIN to confirm it is you." }, 400);

    const r = await rpc("account_delete_self", { p_code: code, p_pin: pin, p_channel: channel });
    if (!r || r.ok !== true) {
      return json({ ok: false, error: (r && r.error) || "Could not delete the account." }, 400);
    }
    return json({ ok: true, code: r.code, message: r.message });
  }

  return json({ ok: false, error: "unknown action" }, 400);
});
