// push-diag — RETIRED 2026-09-05.
// This existed for one afternoon to work out why the APNs key would not decode (it turned out the
// dashboard had been given the filename, then the secret's own name, instead of the file contents).
// It reported the shape of the stored key, which is not something worth leaving reachable once the
// question is answered. The key now lives in the vault and is uploaded by apns-key-set, which
// validates it, so this is no longer needed. Deleted properly next time the function list is pruned.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, OPTIONS" };
Deno.serve((req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  return new Response(JSON.stringify({ ok: false, error: "retired" }), { status: 410, headers: { ...CORS, "Content-Type": "application/json" } });
});
