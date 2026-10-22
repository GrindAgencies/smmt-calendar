// notif-prefs v2 (2026-09-30) — each person's own notification settings.
//
// Christopher: "create a notification settings to be able to control all push notifications".
// Everything here is scoped to the signed-in agent's own code: you can read and change YOUR
// settings and nobody else's. There is no admin override on purpose — whether someone's phone
// buzzes at 10pm is theirs to decide, not Operations'.
//
// v2: …and now "the signed-in agent" actually means that. v1 took the code from the request, and
// GFI codes are printed on the org chart, so anyone could switch OFF a colleague's push
// notifications entirely — they would simply stop being told about bookings, sales and approvals
// and have no way to notice — or set their quiet hours to swallow the day. It also exposed their
// registered device platforms and recent delivery log. Identity is now the session token minted
// at PIN entry, and `code` is not read at all.
//
// Actions: get {session} | save {session, ...fields} | test {session}
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const enc = encodeURIComponent;
const TYPES = ["booking", "sale", "recruit", "mention", "task", "announcement", "reminder"];

async function rpc(fn: string, args: Record<string, unknown>) { try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); return await r.json(); } catch (_) { return null; } }
async function getJSON(p: string) { try { const r = await fetch(`${SUPA}/rest/v1/${p}`, { headers: DBH }); return (await r.json()) || []; } catch (_) { return []; } }
const hourOr = (v: unknown, d: number) => { const n = Number(v); return (isFinite(n) && n >= 0 && n <= 23) ? Math.floor(n) : d; };
/* Proof of identity. A session token is proof; a typed code is not. */
async function sessionCode(session: unknown): Promise<string> {
  const s = String(session ?? "").trim().slice(0, 120);
  if (!s) return "";
  const got = await rpc("agent_session_code", { p_token: s });
  return (typeof got === "string") ? norm(got) : "";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const action = String(body.action || "get");
    const code = await sessionCode(body.session);
    if (!code) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401);
    // The session already proves the person exists, but keep the name lookup: `test` and the
    // settings row both assume a real roster entry.
    const who = await getJSON(`tracker_agents?code=eq.${enc(code)}&select=code,first_name,last_name&limit=1`);
    if (!who[0]) return json({ ok: false, error: "unknown code" }, 404);

    if (action === "get") {
      const prefs = await rpc("notif_prefs_for", { p_code: code });
      const devices = await getJSON(`device_tokens?agent_code=eq.${enc(code)}&select=platform,last_seen`);
      const recent = await getJSON(`push_log?agent_code=eq.${enc(code)}&select=outcome,items,sent_at&order=sent_at.desc&limit=10`);
      return json({ ok: true, prefs, types: TYPES, devices: devices.length, device_platforms: devices.map((d: any) => d.platform), recent });
    }

    if (action === "save") {
      const cur: any = (await rpc("notif_prefs_for", { p_code: code })) || {};
      const types: Record<string, boolean> = { ...(cur.types || {}) };
      if (body.types && typeof body.types === "object") {
        for (const t of TYPES) { const v = (body.types as any)[t]; if (v !== undefined) types[t] = !!v; }
      }
      const row = {
        code,
        push_enabled: (body.push_enabled !== undefined) ? !!body.push_enabled : (cur.push_enabled !== false),
        types,
        quiet_enabled: (body.quiet_enabled !== undefined) ? !!body.quiet_enabled : (cur.quiet_enabled !== false),
        quiet_start: hourOr(body.quiet_start !== undefined ? body.quiet_start : cur.quiet_start, 21),
        quiet_end:   hourOr(body.quiet_end   !== undefined ? body.quiet_end   : cur.quiet_end, 7),
        digest: (body.digest !== undefined) ? !!body.digest : (cur.digest !== false),
        tz: (body.tz !== undefined) ? (String(body.tz || "").trim() || null) : (cur.tz || null),
        updated_at: new Date().toISOString(),
      };
      const up = await fetch(`${SUPA}/rest/v1/notification_prefs?on_conflict=code`, { method: "POST", headers: { ...DBH, Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(row) });
      if (!up.ok) return json({ ok: false, error: "Could not save.", detail: (await up.text()).slice(0, 160) });
      return json({ ok: true, prefs: (await up.json())[0] || row });
    }

    // Let someone prove to themselves that it works, without waiting for real news.
    if (action === "test") {
      const devices = await getJSON(`device_tokens?agent_code=eq.${enc(code)}&select=token&limit=1`);
      if (!devices.length) return json({ ok: false, error: "No device registered yet — open the app on your phone first." });
      const r = await fetch(`${SUPA.replace('/rest/v1','')}/functions/v1/push-send`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "send", token: String(body.ops_token || ""), to: code, keep_tokens: true, title: "The Standard", body: "Test notification — your settings are working.", url: "index.html" }) });
      const j = await r.json().catch(() => ({}));
      return json({ ok: !!(j && j.sent), sent: (j && j.sent) || 0, detail: j });
    }

    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) { return json({ ok: false, error: String(e).slice(0, 200) }, 500); }
});
