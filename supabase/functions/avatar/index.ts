// avatar — serves a person's profile photo as a real, cacheable image by code.
//
// ACCEPTED AS UNAUTHENTICATED, DELIBERATELY. ops/scan-identity.py reports this as OPEN and that
// is correct: a `code` in the query string is the whole input. It is left that way because
//   1. this is the target of an <img src>, and a browser fetching an image cannot attach a
//      session token — closing it properly means every face on the org chart, My Team and the
//      Hub becomes a fetch-then-blob, which is a real change for no real gain, and
//   2. the entire exposure is ONE PROFILE PHOTO to somebody who already knows an agent code.
//      No name, no contact details, no business data — the response is image bytes and nothing
//      else. Those faces are shown to every colleague across the app by design.
// If that ever stops being true — if this endpoint starts returning anything but the photo — the
// reasoning above expires and it needs the session like everything else.
// hub_avatars stores photos as base64 data URLs; this decodes and streams the bytes so
// browsers can lazy-load + cache each face individually (never bloats the org/team JSON).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = new URL(req.url);
    const code = (url.searchParams.get("code") || "").trim().toUpperCase();
    if (!code) return new Response("code required", { status: 400, headers: CORS });
    const r = await fetch(`${SUPA}/rest/v1/hub_avatars?code=eq.${encodeURIComponent(code)}&select=url`, { headers: DBH });
    const rows = await r.json();
    const dataUrl: string = (rows && rows[0] && rows[0].url) ? rows[0].url : "";
    if (!dataUrl.startsWith("data:")) return new Response("not found", { status: 404, headers: CORS });
    const comma = dataUrl.indexOf(","); if (comma < 0) return new Response("bad", { status: 404, headers: CORS });
    const meta = dataUrl.slice(5, comma);                 // e.g. image/jpeg;base64
    const mime = (meta.split(";")[0] || "image/jpeg");
    const b64 = dataUrl.slice(comma + 1);
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Response(bytes, { headers: { ...CORS, "Content-Type": mime, "Cache-Control": "public, max-age=600" } });
  } catch (e) { return new Response(String(e), { status: 500, headers: CORS }); }
});
