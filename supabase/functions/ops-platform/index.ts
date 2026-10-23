// ops-platform — resolves a baseshop Ops platform code (0000-0005) into a scoped view.
// 0000 = STANDARD master (sees everyone); each other code = that baseshop + anything that rolls up into it.
//
// v4 (2026-10-14): this function was handing the whole Operations seat map to anonymous
// callers. `list` returned every seat code, the baseshop it governs, its owner and — worst —
// WHICH SEAT IS MASTER. The old comment read "no secrets returned beyond codes already known
// to owners", but a seat code is half of an Operations credential; publishing which one is
// master narrows an attacker to a single PIN on a known master account. `login` was the same
// weakness in reverse: it confirmed, to anyone, whether a guessed 4-digit code was a real
// seat and what it could see — a free oracle for enumerating 0000-9999.
//
// Now: `list` requires a real Operations session. `login` still resolves a code, because the
// sign-in screen needs it before anyone has a session, but it no longer discloses the owner
// or distinguishes "wrong code" from "right code" in a way worth enumerating — and the PIN
// remains the thing that actually grants access.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
function json(o: unknown, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }
const clean = (s: unknown) => (s ?? "").toString().trim();

async function rpc(fn: string, args: Record<string, unknown>) {
  try {
    const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) });
    return await r.json();
  } catch (_) { return null; }
}
async function opsAuthorized(token: unknown): Promise<boolean> {
  const t = String(token ?? "").trim();
  if (!t) return false;
  const r = await rpc("ops_authorize", { p_token: t });
  return !!(r && r.ok);
}

async function loadBases() {
  const r = await fetch(`${SUPA}/rest/v1/app_settings?key=eq.baseshops&select=value`, { headers: DBH });
  const rows = await r.json();
  return (rows && rows[0] && rows[0].value) ? rows[0].value : null;
}
// scope = which baseshop names this platform can see
function scopeFor(base: Record<string, unknown>, list: Record<string, unknown>[]): string[] {
  if (base.is_ops_platform || base.super) return list.map((b) => String(b.name)); // master: everyone
  const out = [String(base.name)];
  for (const b of list) { if (Array.isArray(b.also) && (b.also as string[]).indexOf(String(base.name)) >= 0) out.push(String(b.name)); }
  return Array.from(new Set(out));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = new URL(req.url);
    const body = (req.method === "POST") ? (await req.json().catch(() => ({}))) : {};
    const action = (body.action as string) || url.searchParams.get("action") || "login";
    const cfg = await loadBases();
    const list: Record<string, unknown>[] = (cfg && Array.isArray(cfg.bases)) ? cfg.bases : [];

    /* REVIEWED 2026-10-22 and left open, with the trade-off stated.
       `login` resolves a four-digit seat code to its baseshop and scope WITHOUT a PIN, which
       makes it an enumeration oracle: ten thousand guesses identify all six real seat codes and
       which one is master. It stays because the sign-in screen genuinely needs to resolve the
       code a person just typed in order to show them the right seat, and because a seat code no
       longer opens anything on its own — ops-bot v6/v7 and ops-import v4 closed the last
       endpoints that accepted one, so what an enumerator learns is now a label, not a key.
       The PIN is the gate. It already withholds the owner's NAME for the same reason. */
    if (action === "login") {
      const code = clean(body.code || url.searchParams.get("code"));
      if (!/^\d{4}$/.test(code)) return json({ ok: false, error: "Enter a 4-digit baseshop Ops code." });
      const base = list.find((b) => String(b.platform_code) === code);
      if (!base) return json({ ok: false, error: "That Ops code isn’t recognized." });
      const master = !!(base.is_ops_platform || base.super);
      const bases = scopeFor(base, list);
      /* The owner's name is deliberately NOT returned here. Resolving a code to a scope is
         needed by the sign-in screen; naming the person who holds it is not, and it is the
         detail that makes an enumerated code worth something. The PIN is still the gate. */
      return json({ ok: true, platform_code: code, base: base.name,
        scope: master ? "master" : "base", bases,
        label: master ? "Standard — Operations Master" : (String(base.name) + " — Operations") });
    }

    if (action === "list") {
      /* The full seat directory, including which seat is master. Operations only. */
      if (!(await opsAuthorized(body.token))) {
        return json({ ok: false, error: "Sign in to an Operations seat first." }, 401);
      }
      return json({ ok: true, platforms: list.map((b) => ({ code: b.platform_code || "", base: b.name, owner: b.owner_name || "", master: !!(b.is_ops_platform || b.super) })) });
    }

    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) { return json({ ok: false, error: String(e) }, 500); }
});
