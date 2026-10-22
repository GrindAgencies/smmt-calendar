// google-oauth v2 — one-click Google Calendar connect for trainers.
// Flow: auth_url -> Google consent -> callback (exchange code, store refresh token in Vault,
// upsert google_connections) -> sync free/busy into cft_availability busy blocks {date,s,e} (Pacific).
//
// v2 (2026-09-03): asks for calendar.freebusy instead of calendar.readonly.
// This function only ever calls the freeBusy endpoint — it never reads an event, a title or a
// guest list — so calendar.readonly was asking for far more than we use. calendar.readonly is a
// SENSITIVE scope: until an app passes Google verification, Google hard-blocks everyone who is not
// a listed test user with "Access blocked — Error 403: access_denied". That is the code error the
// trainers were hitting, and why google_connections was empty. calendar.freebusy is the
// least-privilege scope for exactly this job, so the consent screen is a plain
// "see when you're busy" prompt instead of a verification wall.
// Also cut over from the hardcoded "2026" admin token to a real ops_authorize() session.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PT = "America/Los_Angeles";
const HORIZON_DAYS = 60;
// Least privilege: free/busy only. Never event details.
const SCOPE = "openid email https://www.googleapis.com/auth/calendar.freebusy";
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
function json(o: unknown, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }
function html(body: string, s = 200) { return new Response(`<!doctype html><html><head><meta name=viewport content="width=device-width,initial-scale=1"><style>body{font-family:-apple-system,system-ui,sans-serif;background:#0b0f14;color:#e7e9ee;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.c{max-width:420px;text-align:center;padding:32px}.i{font-size:52px;margin-bottom:12px}h1{font-size:20px;margin:0 0 8px}p{color:#9aa4b2;font-size:14.5px;line-height:1.5;margin:0 0 18px}b{color:#e7e9ee}</style></head><body><div class=c>${body}</div><script>try{if(window.opener){window.opener.postMessage({source:'google-oauth',ok:${s === 200 ? "true" : "false"}},'*');}}catch(e){}setTimeout(function(){try{window.close();}catch(e){}},2500);</script></body></html>`, { status: s, headers: { ...CORS, "Content-Type": "text/html" } }); }
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const clean = (s: unknown) => (s ?? "").toString().trim();
const lo = (s: unknown) => (s ?? "").toString().trim().toLowerCase();
const esc = (s: unknown) => (s ?? "").toString().replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" } as Record<string, string>)[ch]);
const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function unb64url(s: string) { s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; return atob(s); }

async function cfg() { const ex = await fetch(`${SUPA}/rest/v1/app_settings?key=eq.google_oauth_config&select=value`, { headers: DBH }); const r = await ex.json(); return (r && r[0] && r[0].value) ? r[0].value : null; }
async function rpc(fn: string, args: Record<string, unknown>) { const ex = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); if (!ex.ok) throw new Error(`rpc ${fn}: ${await ex.text()}`); return await ex.json(); }
// A live Operations session (ops-auth). Legacy token still honoured centrally until every caller cuts over.
async function opsAuthorized(token: unknown) { try { const r = await rpc("ops_authorize", { p_token: String(token ?? "") }); return !!(r && r.ok); } catch (_) { return false; } }

// ---- PT helpers ----
function ptParts(d: Date) { const f = new Intl.DateTimeFormat("en-CA", { timeZone: PT, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }); const p: Record<string, string> = {}; f.formatToParts(d).forEach((x) => { p[x.type] = x.value; }); const hh = Number(p.hour) % 24; return { date: `${p.year}-${p.month}-${p.day}`, min: hh * 60 + Number(p.minute) }; }
function ptToday() { return new Intl.DateTimeFormat("en-CA", { timeZone: PT }).format(new Date()); }
// split a busy interval into per-PT-day {date,s,e} blocks (minutes from midnight)
function toPtBlocks(startISO: string, endISO: string) {
  const out: Record<string, unknown>[] = []; const s = new Date(startISO).getTime(); const e = new Date(endISO).getTime();
  if (!(e > s)) return out; let cur = s; let guard = 0;
  while (cur < e && guard++ < 80) {
    const p = ptParts(new Date(cur)); const startMin = p.min; const minsToMid = 1440 - startMin; const dayEnd = cur + minsToMid * 60000; const segEnd = Math.min(e, dayEnd);
    let endMin: number; if (segEnd >= dayEnd) endMin = 1440; else { const pe = ptParts(new Date(segEnd)); endMin = (pe.date === p.date) ? pe.min : 1440; }
    if (endMin > startMin) out.push({ date: p.date, s: startMin, e: endMin, src: "google" }); cur = dayEnd;
  }
  return out;
}

// ---- token / connection ----
async function exchangeCode(c: Record<string, unknown>, code: string) {
  const body = new URLSearchParams({ code, client_id: String(c.client_id), client_secret: String(c.client_secret), redirect_uri: String(c.redirect_uri), grant_type: "authorization_code" });
  const ex = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  return await ex.json();
}
async function refreshAccess(c: Record<string, unknown>, refreshToken: string) {
  const body = new URLSearchParams({ client_id: String(c.client_id), client_secret: String(c.client_secret), refresh_token: refreshToken, grant_type: "refresh_token" });
  const ex = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  return await ex.json();
}
function emailFromIdToken(idt: string) { try { const parts = idt.split("."); if (parts.length < 2) return ""; const payload = JSON.parse(unb64url(parts[1])); return payload.email || ""; } catch (_) { return ""; } }

async function getConn(code: string) { const ex = await fetch(`${SUPA}/rest/v1/google_connections?trainer_code=eq.${encodeURIComponent(code)}&select=*`, { headers: DBH }); const r = await ex.json(); return (r && r[0]) ? r[0] : null; }
async function validAccessToken(c: Record<string, unknown>, conn: Record<string, unknown>) {
  const now = Date.now(); const exp = conn.access_expires_at ? new Date(String(conn.access_expires_at)).getTime() : 0;
  if (conn.access_token && exp - 60000 > now) return String(conn.access_token);
  const secret = await rpc("svc_read_secret", { p_id: conn.refresh_secret_id }); const refreshToken = typeof secret === "string" ? secret : "";
  if (!refreshToken) throw new Error("no refresh token");
  const tk = await refreshAccess(c, refreshToken);
  if (!tk.access_token) throw new Error("refresh failed: " + JSON.stringify(tk));
  const newExp = new Date(now + (Number(tk.expires_in) || 3600) * 1000).toISOString();
  await fetch(`${SUPA}/rest/v1/google_connections?trainer_code=eq.${encodeURIComponent(String(conn.trainer_code))}`, { method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify({ access_token: tk.access_token, access_expires_at: newExp, updated_at: new Date().toISOString() }) });
  return String(tk.access_token);
}

// pull free/busy and write into cft_availability busy for this trainer_code
async function syncBusy(c: Record<string, unknown>, conn: Record<string, unknown>) {
  const token = await validAccessToken(c, conn);
  const timeMin = new Date().toISOString();
  const timeMax = new Date(Date.now() + HORIZON_DAYS * 86400000).toISOString();
  const ex = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ timeMin, timeMax, timeZone: PT, items: [{ id: String(conn.calendar_id || "primary") }] }) });
  const fb = await ex.json();
  if (fb && fb.error) throw new Error(`freeBusy: ${clean(fb.error.message || JSON.stringify(fb.error))}`);
  const cal = fb && fb.calendars ? fb.calendars[String(conn.calendar_id || "primary")] : null;
  const busyIntervals: Record<string, string>[] = (cal && Array.isArray(cal.busy)) ? cal.busy : [];
  const blocks: Record<string, unknown>[] = [];
  for (const b of busyIntervals) { for (const blk of toPtBlocks(b.start, b.end)) blocks.push(blk); }
  // merge into cft_availability: keep non-google busy, replace google busy for this trainer
  const av = await fetch(`${SUPA}/rest/v1/app_settings?key=eq.cft_availability&select=value`, { headers: DBH });
  const avr = await av.json(); const val = (avr && avr[0]) ? avr[0].value : null;
  const tcode = norm(conn.trainer_code); let wrote = 0;
  if (val && Array.isArray(val.cfts)) {
    for (const cft of val.cfts) { if (norm(cft.code) === tcode) { const kept = (Array.isArray(cft.busy) ? cft.busy : []).filter((x: Record<string, unknown>) => x && x.src !== "google"); cft.busy = kept.concat(blocks); wrote = blocks.length; break; } }
    await fetch(`${SUPA}/rest/v1/app_settings?on_conflict=key`, { method: "POST", headers: { ...DBH, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key: "cft_availability", value: val, updated_at: new Date().toISOString() }) });
  }
  await fetch(`${SUPA}/rest/v1/google_connections?trainer_code=eq.${encodeURIComponent(String(conn.trainer_code))}`, { method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify({ last_sync_at: new Date().toISOString(), last_error: null, status: "connected", updated_at: new Date().toISOString() }) });
  return { busy_blocks: blocks.length, wrote };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = new URL(req.url);
    const c = await cfg();
    if (!c) return json({ ok: false, error: "oauth not configured" }, 500);

    // ----- OAuth callback (GET from Google) -----
    const gcode = url.searchParams.get("code"); const gstate = url.searchParams.get("state"); const gerr = url.searchParams.get("error");
    if (req.method === "GET" && (gcode || gerr)) {
      if (gerr) {
        // Say what actually happened. "access_denied" is either a tapped Cancel or Google refusing
        // the app for this account — both leave the trainer staring at a bare error code otherwise.
        const why = clean(url.searchParams.get("error_description")) || clean(gerr);
        const denied = lo(gerr) === "access_denied";
        return html(`<div class=i>⚠️</div><h1>${denied ? "Google didn’t allow the connection" : "That didn’t finish"}</h1><p>${esc(why)}.<br><br>${denied ? "If you tapped Cancel, just try again and press <b>Allow</b>. If Google blocked it, tell Operations — nothing is wrong with your account." : "Please close this window and try again."}</p>`, 400);
      }
      let trainerCode = ""; try { trainerCode = JSON.parse(unb64url(String(gstate))).code || ""; } catch (_) { /* noop */ }
      if (!trainerCode) return html(`<div class=i>⚠️</div><h1>Something went off</h1><p>We couldn't tell which account to link. Please close this and start the connect again.</p>`, 400);
      const tk = await exchangeCode(c, String(gcode));
      if (!tk.access_token) return html(`<div class=i>⚠️</div><h1>Google declined the connection</h1><p>${esc(clean(tk.error_description || tk.error || "Unknown error"))}. Please close this and try again.</p>`, 400);
      const email = emailFromIdToken(tk.id_token || "");
      const now = Date.now(); const accessExp = new Date(now + (Number(tk.expires_in) || 3600) * 1000).toISOString();
      let refreshSecretId: string | null = null;
      if (tk.refresh_token) { refreshSecretId = await rpc("svc_store_secret", { p_name: `google_refresh_${lo(trainerCode)}`, p_secret: tk.refresh_token }); }
      else { const existing = await getConn(trainerCode); if (existing && existing.refresh_secret_id) refreshSecretId = existing.refresh_secret_id; }
      const row = { trainer_code: norm(trainerCode), google_email: email, calendar_id: "primary", refresh_secret_id: refreshSecretId, access_token: tk.access_token, access_expires_at: accessExp, status: "connected", last_error: null, updated_at: new Date().toISOString() };
      await fetch(`${SUPA}/rest/v1/google_connections?on_conflict=trainer_code`, { method: "POST", headers: { ...DBH, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(row) });
      try { const conn = await getConn(trainerCode); if (conn) await syncBusy(c, conn); } catch (e) { /* connection saved even if first sync hiccups */ console.log("initial sync err", String(e)); }
      return html(`<div class=i>✅</div><h1>Calendar connected!</h1><p>${email ? ("<b>" + esc(email) + "</b> is linked. ") : ""}Your Google busy times will now block bookings automatically. You can close this window.</p>`);
    }

    // ----- JSON API (POST) -----
    const body = (req.method === "POST") ? (await req.json().catch(() => ({}))) : {};
    const action = (body.action as string) || url.searchParams.get("action") || "";
    const code = norm(body.code || url.searchParams.get("code"));
    const token = (body.token as string) || "";

    if (action === "auth_url") {
      if (!code) return json({ ok: false, error: "code required" }, 400);
      const state = b64url(JSON.stringify({ code, t: Date.now() }));
      const p = new URLSearchParams({ client_id: String(c.client_id), redirect_uri: String(c.redirect_uri), response_type: "code", scope: SCOPE, access_type: "offline", prompt: "consent", include_granted_scopes: "true", state });
      return json({ ok: true, url: `https://accounts.google.com/o/oauth2/v2/auth?${p.toString()}` });
    }

    if (action === "status") {
      if (!code) return json({ ok: false, error: "code required" }, 400);
      const conn = await getConn(code);
      if (!conn) return json({ ok: true, connected: false });
      return json({ ok: true, connected: conn.status === "connected", email: conn.google_email || "", last_sync_at: conn.last_sync_at || null, status: conn.status || "", last_error: conn.last_error || null });
    }

    if (action === "sync") {
      if (!code) return json({ ok: false, error: "code required" }, 400);
      const conn = await getConn(code); if (!conn) return json({ ok: false, error: "not connected" }, 404);
      try { const r = await syncBusy(c, conn); return json({ ok: true, ...r }); }
      catch (e) { await fetch(`${SUPA}/rest/v1/google_connections?trainer_code=eq.${encodeURIComponent(code)}`, { method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify({ last_error: String(e), status: "error", updated_at: new Date().toISOString() }) }); return json({ ok: false, error: String(e) }, 500); }
    }

    if (action === "sync_all") {
      if (!(await opsAuthorized(token))) return json({ ok: false, error: "unauthorized" }, 401);
      const ex = await fetch(`${SUPA}/rest/v1/google_connections?status=eq.connected&select=*`, { headers: DBH }); const conns = (await ex.json()) || [];
      let ok = 0, fail = 0; for (const conn of conns) { try { await syncBusy(c, conn); ok++; } catch (_) { fail++; } }
      return json({ ok: true, synced: ok, failed: fail, total: conns.length });
    }

    if (action === "disconnect") {
      if (!code) return json({ ok: false, error: "code required" }, 400);
      const conn = await getConn(code);
      if (conn) {
        // strip google busy blocks from cft_availability
        const av = await fetch(`${SUPA}/rest/v1/app_settings?key=eq.cft_availability&select=value`, { headers: DBH }); const avr = await av.json(); const val = (avr && avr[0]) ? avr[0].value : null;
        if (val && Array.isArray(val.cfts)) { for (const cft of val.cfts) { if (norm(cft.code) === code && Array.isArray(cft.busy)) cft.busy = cft.busy.filter((x: Record<string, unknown>) => x && x.src !== "google"); } await fetch(`${SUPA}/rest/v1/app_settings?on_conflict=key`, { method: "POST", headers: { ...DBH, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key: "cft_availability", value: val, updated_at: new Date().toISOString() }) }); }
        try { const secret = conn.refresh_secret_id ? await rpc("svc_read_secret", { p_id: conn.refresh_secret_id }) : ""; if (secret) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(String(secret))}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" } }); } catch (_) { /* noop */ }
        await fetch(`${SUPA}/rest/v1/google_connections?trainer_code=eq.${encodeURIComponent(code)}`, { method: "DELETE", headers: { ...DBH, Prefer: "return=minimal" } });
      }
      return json({ ok: true, disconnected: true });
    }

    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) { return json({ ok: false, error: String(e) }, 500); }
});
