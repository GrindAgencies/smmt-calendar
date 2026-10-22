// cal-feed v4 — company-wide calendar feed (Dashboard + week + Clients).
// Read-only. Light gate: a logged-in code present. Includes client fields for the
// Clients tab. v4: also returns starts_at/ends_at/timezone (+title/color) so the
// scheduler can render every event in the VIEWER's own time zone from its true instant.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
function json(o: unknown, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }
const clean = (s: unknown) => (s ?? "").toString().trim().slice(0, 40);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  let body: any = {}; if (req.method === "POST") body = await req.json().catch(() => ({}));
  const action = (body.action as string) || url.searchParams.get("action") || "";
  const code = clean(body.code || url.searchParams.get("code"));
  if (action === "company_events") {
    if (!code) return json({ ok: false, error: "sign in required" }, 401);
    const from = clean(body.from || url.searchParams.get("from"));
    const to   = clean(body.to   || url.searchParams.get("to"));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return json({ ok: false, error: "valid from/to (YYYY-MM-DD) required" });
    const ex = await fetch(
      `${SUPA}/rest/v1/bookings?date=gte.${from}&date=lte.${to}&status=in.(booked,confirmed,pending,completed)&order=starts_at.desc&select=id,conf,date,time,starts_at,ends_at,timezone,duration_minutes,category,title,color,trainer_name,trainer_code,agent_name,client_email,client_phone,client_id,status,source&limit=2000`,
      { headers: DBH },
    );
    return json({ ok: true, events: (await ex.json()) || [] });
  }
  return json({ ok: false, error: "unknown action" }, 400);
});
