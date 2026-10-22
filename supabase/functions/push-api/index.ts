// push-api v2 — APNs sender for The Standard iOS app.
// Fires lock-screen push to devices in device_tokens.
//
// v2 (2026-09-30): authorisation goes through ops_authorize(). v1 read PUSH_ADMIN_TOKEN from the
// environment and FELL BACK TO THE LITERAL '2026' when it was unset — which it was. That meant
// four digits, from anywhere, could fire a notification to every registered device in the company.
// A secret that defaults to a guessable value is not a secret. The caller must now hold a real
// Operations session or the cron machine token.
//
// Secrets (Supabase > Edge Functions > Secrets):
//   APNS_KEY_P8   (contents of the AuthKey_XXXX.p8, PEM incl. BEGIN/END lines)
//   APNS_KEY_ID   (10-char Key ID)
//   APNS_TEAM_ID  (10-char Team ID)
//   APNS_BUNDLE_ID (default app.tsfg.standard)
//   APNS_HOST     (default https://api.push.apple.com ; sandbox: https://api.sandbox.push.apple.com)

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const P8      = Deno.env.get('APNS_KEY_P8') || '';
const KEY_ID  = Deno.env.get('APNS_KEY_ID') || '';
const TEAM_ID = Deno.env.get('APNS_TEAM_ID') || '';
const BUNDLE  = Deno.env.get('APNS_BUNDLE_ID') || 'app.tsfg.standard';
const APNS_HOST = Deno.env.get('APNS_HOST') || 'https://api.push.apple.com';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

async function opsAuthorized(token: unknown): Promise<boolean> {
  const t = String(token ?? '').trim();
  if (!t) return false;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/ops_authorize`, {
      method: 'POST',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_token: t }),
    });
    const j = await r.json();
    return !!(j && j.ok);
  } catch (_) { return false; }
}

function b64url(bytes: Uint8Array): string {
  const s = btoa(String.fromCharCode(...bytes));
  return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function importP8(pem: string): Promise<CryptoKey> {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return await crypto.subtle.importKey(
    'pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

let _jwt = ''; let _jwtAt = 0;
async function apnsJwt(): Promise<string> {
  if (_jwt && Date.now() - _jwtAt < 45 * 60 * 1000) return _jwt;
  const key = await importP8(P8);
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const head = enc({ alg: 'ES256', kid: KEY_ID });
  const body = enc({ iss: TEAM_ID, iat: Math.floor(Date.now() / 1000) });
  const input = `${head}.${body}`;
  const raw = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(input));
  _jwt = `${input}.${b64url(new Uint8Array(raw))}`;
  _jwtAt = Date.now();
  return _jwt;
}

async function db(path: string, init: RequestInit = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json', ...(init.headers || {}),
    },
  });
}

async function sendOne(token: string, title: string, body: string, data: Record<string, unknown>) {
  const jwt = await apnsJwt();
  const res = await fetch(`${APNS_HOST}/3/device/${token}`, {
    method: 'POST',
    headers: {
      authorization: `bearer ${jwt}`,
      'apns-topic': BUNDLE,
      'apns-push-type': 'alert',
      'apns-priority': '10',
    },
    body: JSON.stringify({ aps: { alert: { title, body }, sound: 'default', badge: 1 }, ...data }),
  });
  const reason = res.status === 200 ? null : await res.text().catch(() => '');
  return { status: res.status, reason };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  let p: any = {};
  try { p = await req.json(); } catch { /* */ }
  const action = p.action || 'send';

  // Whether push is wired up at all is not a secret, and the status page needs it.
  if (action === 'health') {
    return json({ ok: true, configured: !!(P8 && KEY_ID && TEAM_ID), bundle: BUNDLE, host: APNS_HOST });
  }

  if (!(await opsAuthorized(p.token))) return json({ ok: false, error: 'unauthorized' }, 401);

  if (!(P8 && KEY_ID && TEAM_ID)) {
    return json({ ok: false, pending: true,
      reason: 'APNs key not configured yet — set APNS_KEY_P8 / APNS_KEY_ID / APNS_TEAM_ID secrets.' });
  }

  if (action === 'send') {
    const title = (p.title || 'The Standard').toString();
    const body  = (p.body  || '').toString();
    const data  = (p.data && typeof p.data === 'object') ? p.data : {};
    // target: specific agent_code, else all devices
    const filter = p.code ? `agent_code=eq.${encodeURIComponent(p.code)}` : 'token=not.is.null';
    const rows = await (await db(`device_tokens?select=token&${filter}`)).json().catch(() => []);
    if (!Array.isArray(rows) || rows.length === 0) return json({ ok: true, sent: 0, note: 'no devices' });

    let sent = 0; const dead: string[] = []; const errs: any[] = [];
    for (const r of rows) {
      try {
        const out = await sendOne(r.token, title, body, data);
        if (out.status === 200) sent++;
        else if (out.status === 410) dead.push(r.token);          // unregistered
        else errs.push({ status: out.status, reason: out.reason });
      } catch (e) { errs.push({ error: String(e) }); }
    }
    // prune dead tokens
    if (dead.length) {
      const list = dead.map((t) => `"${t}"`).join(',');
      await db(`device_tokens?token=in.(${list})`, { method: 'DELETE' }).catch(() => {});
    }
    return json({ ok: true, sent, pruned: dead.length, errors: errs.slice(0, 5) });
  }

  return json({ ok: false, error: 'unknown action' }, 400);
});
