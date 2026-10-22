// apns-key-set — one-shot uploader for the APNs signing key.
//
// The dashboard's secrets form kept eating this: first the FILENAME was pasted into the value
// box, then the secret's own NAME. Both are easy mistakes and both fail silently until a push
// is attempted. This takes the copy-paste step away entirely: the .p8 is posted straight from
// the machine that downloaded it into Supabase Vault, using the same svc_store_secret() the
// Google refresh tokens already use.
//
// It VALIDATES before storing, so a wrong paste is rejected loudly instead of stored quietly:
// the PEM must have its header and footer and must decode as base64 to a plausible EC key.
// Nothing about the key is ever returned.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
async function rpc(fn: string, args: Record<string, unknown>) { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); if (!r.ok) throw new Error(`${fn}: ${(await r.text()).slice(0, 160)}`); return await r.json(); }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const az = await rpc("ops_authorize", { p_token: String(body.token ?? "") });
    if (!(az && az.ok)) return json({ ok: false, error: "unauthorized" }, 401);

    const pem = String(body.pem ?? "").trim();
    if (!pem) return json({ ok: false, error: "No key was sent." });
    if (!/-----BEGIN [^-]*PRIVATE KEY-----/.test(pem) || !/-----END [^-]*PRIVATE KEY-----/.test(pem)) {
      return json({ ok: false, error: "That does not look like a .p8 key — the BEGIN/END lines are missing. It is probably a filename or a name, not the file's contents.", length: pem.length });
    }
    const b64 = pem.replace(/-----BEGIN [^-]+-----/g, "").replace(/-----END [^-]+-----/g, "").replace(/\s+/g, "");
    let der: Uint8Array;
    try { const bin = atob(b64); der = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i); }
    catch (_) { return json({ ok: false, error: "The key body is not valid base64 — it was altered somewhere between the file and here." }); }
    if (der.length < 100 || der.length > 400) return json({ ok: false, error: `Unexpected key size (${der.length} bytes) — an APNs .p8 is around 138.` });
    // Prove it is genuinely an ES256 signing key before we keep it.
    try { await crypto.subtle.importKey("pkcs8", der.buffer, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]); }
    catch (e) { return json({ ok: false, error: "Apple's servers would reject this — it did not load as a P-256 signing key.", detail: String(e).slice(0, 120) }); }

    const id = await rpc("svc_store_secret", { p_name: `apns_key_p8_${Date.now()}`, p_secret: pem });
    const secretId = (typeof id === "string") ? id : (id && (id as any).id) || null;
    if (!secretId) return json({ ok: false, error: "Could not store the key in the vault." });
    await fetch(`${SUPA}/rest/v1/app_settings?on_conflict=key`, { method: "POST", headers: { ...DBH, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key: "apns_key_secret_id", value: { id: secretId, stored_at: new Date().toISOString() }, updated_at: new Date().toISOString() }) });
    return json({ ok: true, stored: true, key_bytes: der.length, note: "Validated as a P-256 signing key and stored in the vault." });
  } catch (e) { return json({ ok: false, error: String(e).slice(0, 200) }, 500); }
});
