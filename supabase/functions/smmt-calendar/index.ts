import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPA_URL = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
let cache: string | null = null;

Deno.serve(async () => {
  try {
    if (!cache) {
      const r = await fetch(
        `${SUPA_URL}/rest/v1/smmt_pages?slug=eq.smmt&select=html`,
        { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } },
      );
      const rows = await r.json();
      if (!rows || !rows[0] || !rows[0].html) {
        return new Response("Calendar not found", { status: 404 });
      }
      cache = rows[0].html as string;
    }
    const h = new Headers();
    h.set("Content-Type", "text/html; charset=utf-8");
    h.set("X-SMMT-Marker", "v10");
    h.set("Access-Control-Allow-Origin", "*");
    return new Response(cache, { status: 200, headers: h });
  } catch (e) {
    return new Response("Calendar error: " + (e as Error).message, { status: 500 });
  }
});
