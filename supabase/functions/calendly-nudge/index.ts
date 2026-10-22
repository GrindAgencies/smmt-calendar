// calendly-nudge v2 — finds bookable CFTs who haven't connected Calendly and DMs them a reminder
// (via the coach bot), plus a leadership summary to #operations. Run on a cron.
// v2 (2026-09-03): authorisation goes through ops_authorize — an Operations session or the
// cron machine token — instead of the literal "2026" that shipped inside ops.html. This one
// sends direct messages to real people, so a guessable token meant anyone could spam every CFT.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, OPTIONS" };
function json(o: unknown, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const low = (s: unknown) => (s ?? "").toString().trim().toLowerCase();
const full = (a: any) => `${a.first_name || ""} ${a.last_name || ""}`.trim();
async function db(path: string, init?: RequestInit) { return fetch(`${SUPA}/rest/v1/${path}`, { ...init, headers: { ...DBH, ...(init?.headers || {}) } }); }
async function dbGet(path: string) { const r = await db(path); return (await r.json()) || []; }
async function loadKey(k: string) { const rows = await dbGet(`app_settings?key=eq.${k}&select=value`); return rows[0] ? rows[0].value : null; }
async function rpc(fn: string, args: Record<string, unknown>) { try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); return await r.json(); } catch (_) { return null; } }
async function opsAuthorized(token: unknown) { const r = await rpc("ops_authorize", { p_token: String(token ?? "") }); return !!(r && r.ok); }

const NUDGE = "👋 Quick one — you still need to connect your Calendly so clients can book you directly.\n\nIt takes 2 minutes:\n1. Open your Profile (tap your name & photo in the bottom-left).\n2. Find the “Calendly Booking” card → tap “🔗 Connect Calendly”.\n3. In Calendly: Integrations → API & webhooks → Personal access tokens → Create → copy it.\n4. Paste it in — you'll see “🔔 real-time alerts on” and your booking link goes live.\n\nRequired for all CFTs. Ping me if you get stuck! — Coach";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: any = {}; try { body = await req.json(); } catch (_) { body = {}; }
  if (!(await opsAuthorized(body.token))) return json({ ok: false, error: "unauthorized" }, 401);
  const dry = body.dry === true;

  const av = await loadKey("cft_availability");
  const cfts = (av && Array.isArray(av.cfts)) ? av.cfts : [];
  const agents = await dbGet(`tracker_agents?select=code,first_name,last_name,status&limit=3000`);
  const nameToAgent: Record<string, any> = {};
  agents.forEach((a: any) => { if (full(a)) nameToAgent[low(full(a))] = a; });
  const conns = await dbGet(`calendly_connections?token=not.is.null&select=code`);
  const connected = new Set(conns.map((c: any) => norm(c.code)));

  const stragglers: any[] = []; const connectedList: string[] = []; const unmatched: string[] = [];
  for (const c of cfts) {
    if (!c || !c.name) continue;
    if (low(c.role) === "ops") continue;              // Ops staff — not a broker CFT
    if (c.hidden === true) continue;
    const a = nameToAgent[low(c.name)];
    if (!a) { unmatched.push(c.name); continue; }
    if (low(a.status) === "quit") continue;
    if (connected.has(norm(a.code))) { connectedList.push(c.name); continue; }
    stragglers.push({ name: c.name, code: norm(a.code) });
  }

  let dmSent = 0;
  if (!dry) {
    for (const s of stragglers) {
      await db(`hub_messages`, { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ channel: `dm:${s.code}|KYLE`, author_code: "KYLE", author_name: "Coach", body: NUDGE, kind: "coach", attach: null, reactions: {} }) });
      dmSent++;
    }
    if (body.summary !== false) {
      const total = stragglers.length + connectedList.length;
      const names = stragglers.map((s) => s.name).join(", ") || "none — everyone's connected! 🎉";
      const msg = `📅 Calendly connect status — ${connectedList.length}/${total} CFTs connected.\nStill pending (${stragglers.length}): ${names}\n(Each pending CFT was just DM'd a reminder.)`;
      await db(`hub_messages`, { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ channel: "operations", author_code: "CALENDLY", author_name: "📅 Calendly", body: msg, kind: "system", attach: null, reactions: {} }) });
    }
  }

  return json({ ok: true, connected: connectedList.length, pending: stragglers.length, dm_sent: dmSent, stragglers: stragglers.map((s) => s.name), unmatched });
});
