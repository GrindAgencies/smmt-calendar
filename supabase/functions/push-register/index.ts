// push-register v4 (2026-09-30) — stores a device's push token so push-send/push-api can reach it.
// Called by the native iOS shell (APNs device token) and/or Android.
//
// v1 reasoned that "storing a device token is low-risk" and took `agent_code` straight from the
// request. That was the wrong risk. The agent_code on a device row is the ADDRESS push notifications
// are delivered to, so anyone could register THEIR OWN device under somebody else's code and start
// receiving that person's notifications — booking alerts, sale alerts, direct messages and team
// announcements, several of which carry client names. Nothing about it would have looked wrong: the
// victim keeps getting their notifications too.
//
// Now: the device token itself still needs no credential (the shell registers on launch, before
// anyone has signed in, and a token with no owner is harmless — it simply cannot be targeted).
// ATTACHING it to a person requires the session token minted at PIN entry, and attaches it to that
// person. notif.js already re-registers on sign-in (__pushReattach), which is exactly when the
// session exists, so the ownerless row gets claimed by its real owner a moment later.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, OPTIONS" };
function json(o: unknown, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const clean = (s: unknown) => (s ?? "").toString().trim().slice(0, 300);
const enc = encodeURIComponent;
async function rpc(fn: string, args: Record<string, unknown>) { try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); return await r.json(); } catch (_) { return null; } }
async function opsAuthorized(t: unknown) { const s = String(t ?? ""); if (!s) return false; const r = await rpc("ops_authorize", { p_token: s }); return !!(r && r.ok); }
async function sessionCode(session: unknown): Promise<string> {
  const s = String(session ?? "").trim().slice(0, 120);
  if (!s) return "";
  const got = await rpc("agent_session_code", { p_token: s });
  return (typeof got === "string") ? norm(got) : "";
}
async function nameOfCode(code: string): Promise<string> {
  if (!code) return "";
  const r = await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${enc(code)}&select=first_name,last_name&limit=1`, { headers: DBH });
  const a = ((await r.json()) || [])[0];
  return a ? `${a.first_name || ""} ${a.last_name || ""}`.trim() : "";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let b: any = {}; try { b = await req.json(); } catch (_) { /* */ }
  const action = String(b.action || "register");
  // NOTE: `token` here is the DEVICE push token, not an auth credential. The Operations
  // credential, when there is one, arrives as `ops_token`.
  const token = clean(b.token);
  if (!token) return json({ ok: false, error: "token required" });

  if (action === "unregister") {
    // Deleting a row needs the device token itself, which only that device has.
    await fetch(`${SUPA}/rest/v1/device_tokens?token=eq.${enc(token)}`, { method: "DELETE", headers: { ...DBH, Prefer: "return=minimal" } });
    return json({ ok: true, unregistered: true });
  }

  // register / upsert
  const platform = (clean(b.platform).toLowerCase() || "ios");
  const isOps = await opsAuthorized(b.ops_token);
  const mine = isOps ? norm(b.agent_code || b.code) : await sessionCode(b.session);
  const now = new Date().toISOString();
  const row: Record<string, unknown> = { token, platform, last_seen: now };
  // Only a PROVEN identity may own a device. An unsigned-in device registers ownerless and is
  // claimed on the next call, after sign-in.
  if (mine) { row.agent_code = mine; row.agent_name = (isOps ? clean(b.agent_name || b.name) : "") || await nameOfCode(mine); }
  const r = await fetch(`${SUPA}/rest/v1/device_tokens?on_conflict=token`, {
    method: "POST",
    headers: { ...DBH, Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(row),
  });
  const ok = r.ok; let saved: any = null; try { const j = await r.json(); saved = Array.isArray(j) ? j[0] : j; } catch (_) { /* */ }
  return json({ ok, token: token.slice(0, 12) + "…", agent_code: mine || (saved && saved.agent_code) || null, platform, claimed: !!mine });
});
