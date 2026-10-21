// push-send v7 — native push to registered devices (APNs iOS + FCM Android), with per-person control.
//
// v7 (2026-09-05): SETTINGS, QUIET HOURS AND DIGESTS. Before this every notification became its own
//   phone buzz. The real numbers say that does not survive contact with 85 people: bookings alone run
//   ~37/day, and the worst single day for one person was 35 notifications. Thirty-five buzzes is how an
//   app gets deleted — or worse, how someone turns iOS notifications off for good, which you never win
//   back. So the fanout now:
//     • groups everything pending for a person into ONE push per run (digest), rather than one each
//     • honours notification_prefs — master switch, per-type switches, personal quiet hours
//     • stays silent 9pm–7am in the person's own zone (Pacific unless they set one); the in-app bell
//       still shows everything, so nothing is lost, it just does not wake anyone
//     • writes push_log so we can SEE what launch week actually did to people's phones
// v5: the APNs key comes from the vault (the dashboard's secrets form ate it twice).
// v4: every secret trimmed on read. v3: sandbox/production fallback. v2: ops_authorize + fanout.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH  = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
function json(o: unknown, s = 200){ return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }
const env = (k: string) => (Deno.env.get(k) || "").trim();
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const low  = (s: unknown) => (s ?? "").toString().trim().toLowerCase();
const clean = (s: unknown) => (s ?? "").toString().trim().slice(0, 400);
const enc = encodeURIComponent;
const GRACE_MINUTES = 60;
const DEFAULT_TZ = "America/Los_Angeles";
const isPem = (s: string) => /-----BEGIN [^-]*PRIVATE KEY-----/.test(s) && /-----END [^-]*PRIVATE KEY-----/.test(s);

async function rpc(fn: string, args: Record<string, unknown>){ try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); return await r.json(); } catch (_) { return null; } }
async function opsAuthorized(token: unknown){ const r = await rpc("ops_authorize", { p_token: String(token ?? "") }); return !!(r && r.ok); }
async function getJSON(path: string){ try { const r = await fetch(`${SUPA}/rest/v1/${path}`, { headers: DBH }); return (await r.json()) || []; } catch (_) { return []; } }
async function logPush(row: Record<string, unknown>){ try { await fetch(`${SUPA}/rest/v1/push_log`, { method: "POST", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify(row) }); } catch (_) { /* */ } }

// Local hour for a person, so "9pm" means 9pm where they are.
function hourIn(tz: string): number {
  try { return Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hour12: false }).format(new Date())); }
  catch (_) { return Number(new Intl.DateTimeFormat("en-GB", { timeZone: DEFAULT_TZ, hour: "2-digit", hour12: false }).format(new Date())); }
}
// Windows that wrap midnight (21 -> 7) are the normal case, so handle both shapes.
function inQuiet(hour: number, start: number, end: number){ return (start <= end) ? (hour >= start && hour < end) : (hour >= start || hour < end); }

// ---- the signing key: env var if it genuinely holds a PEM, otherwise the vault ----
let _pem = ""; let _pemAt = 0;
async function apnsPem(): Promise<string> {
  const e = env("APNS_KEY_P8");
  if (isPem(e)) return e;
  if (_pem && (Date.now() - _pemAt) < 10 * 60 * 1000) return _pem;
  const rows = await getJSON(`app_settings?key=eq.apns_key_secret_id&select=value`);
  const id = rows[0] && rows[0].value ? rows[0].value.id : null;
  if (!id) return "";
  const s = await rpc("svc_read_secret", { p_id: id });
  const pem = (typeof s === "string") ? s : "";
  if (isPem(pem)) { _pem = pem; _pemAt = Date.now(); }
  return isPem(pem) ? pem : "";
}

function b64url(input: ArrayBuffer | Uint8Array){ const bytes = input instanceof Uint8Array ? input : new Uint8Array(input); let s = ""; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function b64urlStr(str: string){ return b64url(new TextEncoder().encode(str)); }
function pemToBuf(pem: string){ const body = pem.replace(/-----BEGIN [^-]+-----/g, "").replace(/-----END [^-]+-----/g, "").replace(/\s+/g, ""); const bin = atob(body); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u.buffer; }
async function signJwt(header: Record<string, unknown>, payload: Record<string, unknown>, pem: string, algo: { name: string; namedCurve?: string; hash?: string }, signAlgo: { name: string; hash: string }){
  const signingInput = b64urlStr(JSON.stringify(header)) + "." + b64urlStr(JSON.stringify(payload));
  const k = await crypto.subtle.importKey("pkcs8", pemToBuf(pem), algo, false, ["sign"]);
  const sig = await crypto.subtle.sign(signAlgo, k, new TextEncoder().encode(signingInput));
  return signingInput + "." + b64url(sig);
}

let _apnsJwt = ""; let _apnsAt = 0;
async function apnsJwt(pem: string){ if (_apnsJwt && (Date.now() - _apnsAt) < 50 * 60 * 1000) return _apnsJwt; _apnsJwt = await signJwt({ alg: "ES256", kid: env("APNS_KEY_ID") }, { iss: env("APNS_TEAM_ID"), iat: Math.floor(Date.now() / 1000) }, pem, { name: "ECDSA", namedCurve: "P-256" }, { name: "ECDSA", hash: "SHA-256" }); _apnsAt = Date.now(); return _apnsJwt; }
async function sendApns(pem: string, token: string, title: string, body: string, url: string, badge: number | null, sandbox: boolean){
  const jwt = await apnsJwt(pem);
  const host = sandbox ? "api.sandbox.push.apple.com" : "api.push.apple.com";
  const topic = env("APNS_BUNDLE_ID") || "app.tsfg.standard";
  const aps: Record<string, unknown> = { alert: { title, body }, sound: "default" }; if (badge != null) aps.badge = badge;
  const payload: Record<string, unknown> = { aps }; if (url) payload.url = url;
  const r = await fetch(`https://${host}/3/device/${token}`, { method: "POST", headers: { authorization: "bearer " + jwt, "apns-topic": topic, "apns-push-type": "alert", "apns-priority": "10" }, body: JSON.stringify(payload) });
  if (r.ok) return { ok: true, host };
  const txt = await r.text(); let reason = ""; try { reason = JSON.parse(txt).reason || ""; } catch (_) { /* */ }
  const dead = r.status === 410 || reason === "BadDeviceToken" || reason === "Unregistered" || reason === "DeviceTokenNotForTopic";
  return { ok: false, status: r.status, reason: reason || txt.slice(0, 120), dead, host };
}
async function sendApnsSmart(pem: string, token: string, title: string, body: string, url: string, badge: number | null){
  const preferSandbox = env("APNS_PRODUCTION") === "false";
  const first = await sendApns(pem, token, title, body, url, badge, preferSandbox);
  if (first.ok) return first;
  if (first.reason === "BadDeviceToken" || first.reason === "DeviceTokenNotForTopic") {
    const second = await sendApns(pem, token, title, body, url, badge, !preferSandbox);
    if (second.ok) return second;
    return { ...second, tried_both: true };
  }
  return first;
}

function fcmAccount(): Record<string, string> | null { const raw = env("FCM_SERVICE_ACCOUNT"); if (!raw) return null; try { return JSON.parse(raw); } catch (_) { return null; } }
let _fcmTok = ""; let _fcmAt = 0;
async function fcmAccess(acct: Record<string, string>){ if (_fcmTok && (Date.now() - _fcmAt) < 50 * 60 * 1000) return _fcmTok; const now = Math.floor(Date.now() / 1000); const jwt = await signJwt({ alg: "RS256", typ: "JWT" }, { iss: acct.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }, acct.private_key, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }); const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=" + enc(jwt) }); const j = await r.json(); if (!j.access_token) throw new Error("fcm oauth failed"); _fcmTok = j.access_token; _fcmAt = Date.now(); return _fcmTok; }
async function sendFcm(token: string, title: string, body: string, url: string, acct: Record<string, string>){
  const at = await fcmAccess(acct);
  const msg = { message: { token, notification: { title, body }, data: url ? { url: String(url) } : {}, android: { priority: "HIGH" } } };
  const r = await fetch(`https://fcm.googleapis.com/v1/projects/${acct.project_id}/messages:send`, { method: "POST", headers: { authorization: "Bearer " + at, "Content-Type": "application/json" }, body: JSON.stringify(msg) });
  if (r.ok) return { ok: true };
  const txt = await r.text(); let status = ""; try { status = JSON.parse(txt).error?.status || ""; } catch (_) { /* */ }
  const dead = status === "UNREGISTERED" || status === "INVALID_ARGUMENT" || status === "NOT_FOUND";
  return { ok: false, status: r.status, reason: status || txt.slice(0, 120), dead };
}

async function delToken(tok: string){ try { await fetch(`${SUPA}/rest/v1/device_tokens?token=eq.${enc(tok)}`, { method: "DELETE", headers: { ...DBH, Prefer: "return=minimal" } }); } catch (_) { /* */ } }

async function deliver(rows: any[], title: string, text: string, url: string, badge: number | null, acct: Record<string, string> | null, pem: string, prune = true){
  let sent = 0, failed = 0, skipped = 0, pruned = 0; const errors: any[] = []; const hosts: Record<string, number> = {};
  await Promise.all(rows.map(async (r: any) => {
    try {
      const plat = low(r.platform);
      let res: any;
      if (plat === "ios") { if (!pem) { skipped++; return; } res = await sendApnsSmart(pem, r.token, title, text, url, badge); }
      else if (plat === "android") { if (!acct) { skipped++; return; } res = await sendFcm(r.token, title, text, url, acct); }
      else { skipped++; return; }
      if (res.ok) { sent++; if (res.host) hosts[res.host] = (hosts[res.host] || 0) + 1; }
      else { failed++; if (res.dead && prune) { await delToken(r.token); pruned++; } if (errors.length < 20) errors.push({ platform: plat, reason: res.reason, status: res.status }); }
    } catch (e) { failed++; if (errors.length < 20) errors.push({ error: String(e) }); }
  }));
  return { sent, failed, skipped, pruned, errors, hosts };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: any = {}; try { body = await req.json(); } catch (_) { /* */ }
  const action = String(body.action || "send");
  const acct = fcmAccount();
  const pem = await apnsPem();
  const apnsOk = !!(pem && env("APNS_KEY_ID") && env("APNS_TEAM_ID"));

  if (action === "config") return json({ ok: true, apns: apnsOk, key_source: isPem(env("APNS_KEY_P8")) ? "env" : (pem ? "vault" : "missing"), fcm: !!acct, bundle_id: env("APNS_BUNDLE_ID") || "app.tsfg.standard", key_id_len: env("APNS_KEY_ID").length, team_id: env("APNS_TEAM_ID"), apns_production: env("APNS_PRODUCTION") !== "false", grace_minutes: GRACE_MINUTES });

  if (!(await opsAuthorized(body.token))) return json({ ok: false, error: "unauthorized" }, 401);

  if (action === "fanout") {
    const limit = Math.min(400, Math.max(1, Number(body.limit) || 200));
    const since = new Date(Date.now() - GRACE_MINUTES * 60000).toISOString();
    const pend: any[] = await getJSON(`notifications?pushed_at=is.null&select=id,recipient_name,recipient_code,type,title,body,link,read_at,created_at&order=created_at.asc&limit=${limit}`);
    if (!pend.length) return json({ ok: true, pending: 0, sent: 0 });

    // Claim them up front: a push must never go out twice.
    const ids = pend.map((n) => n.id);
    await fetch(`${SUPA}/rest/v1/notifications?id=in.(${ids.join(",")})`, { method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify({ pushed_at: new Date().toISOString() }) });

    const live = pend.filter((n) => !n.read_at && String(n.created_at) >= since);
    const stale = pend.length - live.length;
    if (!live.length) return json({ ok: true, pending: pend.length, considered: 0, stale, sent: 0, apns: apnsOk });

    const devices: any[] = await getJSON(`device_tokens?select=token,platform,agent_code,agent_name&order=last_seen.desc&limit=5000`);
    const byCode: Record<string, any[]> = {}; const byName: Record<string, any[]> = {};
    devices.forEach((d) => {
      const c = norm(d.agent_code); if (c) (byCode[c] = byCode[c] || []).push(d);
      const n = low(d.agent_name); if (n) (byName[n] = byName[n] || []).push(d);
    });

    // ONE push per person per run — the whole point of the digest.
    const groups: Record<string, any[]> = {};
    for (const n of live) { const k = norm(n.recipient_code) || low(n.recipient_name); (groups[k] = groups[k] || []).push(n); }

    let sent = 0, failed = 0, skipped = 0, pruned = 0, noDevice = 0, quiet = 0, mutedOut = 0, digested = 0;
    const errors: any[] = [];
    for (const k of Object.keys(groups)) {
      const items = groups[k];
      const first = items[0];
      const code = norm(first.recipient_code);
      const targets = byCode[code] || byName[low(first.recipient_name)] || [];
      if (!targets.length) { noDevice++; await logPush({ agent_code: code || null, agent_name: first.recipient_name, outcome: "no_device", items: items.length }); continue; }

      const prefs: any = (await rpc("notif_prefs_for", { p_code: code || "" })) || {};
      if (prefs.push_enabled === false) { mutedOut++; await logPush({ agent_code: code, agent_name: first.recipient_name, outcome: "muted", items: items.length }); continue; }

      // Drop the types this person has switched off; keep the rest.
      const typesOn = prefs.types || {};
      const wanted = items.filter((n) => typesOn[low(n.type)] !== false);
      if (!wanted.length) { mutedOut++; await logPush({ agent_code: code, agent_name: first.recipient_name, outcome: "type_off", items: items.length }); continue; }

      if (prefs.quiet_enabled !== false) {
        const h = hourIn(prefs.tz || DEFAULT_TZ);
        if (inQuiet(h, Number(prefs.quiet_start ?? 21), Number(prefs.quiet_end ?? 7))) {
          quiet++; await logPush({ agent_code: code, agent_name: first.recipient_name, outcome: "quiet_hours", items: wanted.length });
          continue;   // the in-app bell still has them; we simply do not wake anyone
        }
      }

      let title: string, text: string, url: string;
      if (wanted.length === 1 || prefs.digest === false) {
        title = clean(wanted[0].title); text = clean(wanted[0].body); url = clean(wanted[0].link);
        if (wanted.length > 1) { /* digest off: still one push, but say how many */ text = clean(wanted[0].body) + ` (+${wanted.length - 1} more)`; }
      } else {
        digested++;
        title = `${wanted.length} new updates`;
        text = wanted.slice(0, 3).map((n: any) => clean(n.title)).join(" · ");
        if (wanted.length > 3) text += ` · +${wanted.length - 3} more`;
        url = clean(wanted[0].link);
      }

      const r = await deliver(targets, title, text, url, wanted.length, acct, pem);
      sent += r.sent; failed += r.failed; skipped += r.skipped; pruned += r.pruned;
      r.errors.forEach((e) => { if (errors.length < 20) errors.push(e); });
      await logPush({ agent_code: code, agent_name: first.recipient_name, outcome: r.sent ? (wanted.length > 1 ? "summary" : "sent") : "failed", items: wanted.length });
    }
    return json({ ok: true, pending: pend.length, people: Object.keys(groups).length, sent, digested, quiet, muted: mutedOut, no_device: noDevice, failed, skipped, pruned, stale, apns: apnsOk, errors: errors.slice(0, 20) });
  }

  let to = body.to;
  let codes: string[] = [];
  if (to && to !== "all") codes = (Array.isArray(to) ? to : [to]).map((x: unknown) => norm(x)).filter(Boolean);
  let path = `device_tokens?select=token,platform,agent_code&order=last_seen.desc&limit=5000`;
  if (codes.length) path += `&agent_code=in.(${codes.map(enc).join(",")})`;
  const rows: any[] = await getJSON(path);
  const title = clean(body.title); const text = clean(body.body); const url = clean(body.url); const badge = (body.badge != null) ? Number(body.badge) : null;
  if (!title && !text) return json({ ok: false, error: "title or body required" });
  if (body.dry_run) return json({ ok: true, dry_run: true, targets: rows.length, apns: apnsOk });
  const r = await deliver(rows, title, text, url, badge, acct, pem, body.keep_tokens !== true);
  return json({ ok: true, targets: rows.length, sent: r.sent, failed: r.failed, skipped: r.skipped, pruned: r.pruned, hosts: r.hosts, apns: apnsOk, errors: r.errors.slice(0, 20) });
});
