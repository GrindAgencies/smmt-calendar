// hub-ops v2 (2026-09-30) — Operations oversight for the Team Hub: ALL channels + ALL DM
// conversations.
//
// v2: AUTHORISATION GOES THROUGH ops_authorize(). v1 compared the token to a hardcoded "2026",
// which meant this function — the one that hands over every channel and the existence of all ~669
// direct-message conversations in the company — could be opened by anyone who typed four digits,
// and could NOT be closed by the legacy_ops_token_allowed flag, because it never asked the
// database. A real Operations session (or the cron machine token) now, and nothing else.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
function json(o: unknown, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const low = (s: unknown) => (s ?? "").toString().trim().toLowerCase();
async function loadKey(k: string) { const r = await fetch(`${SUPA}/rest/v1/app_settings?key=eq.${k}&select=value`, { headers: DBH }); const rows = await r.json(); return (rows && rows[0]) ? rows[0].value : null; }
async function getJSON(path: string) { const r = await fetch(`${SUPA}/rest/v1/${path}`, { headers: DBH }); return (await r.json()) || []; }
/* One authority for "is this really Operations", shared with every other Operations endpoint. */
async function opsAuthorized(token: unknown) {
  try {
    const r = await fetch(`${SUPA}/rest/v1/rpc/ops_authorize`, { method: "POST", headers: DBH, body: JSON.stringify({ p_token: String(token ?? "") }) });
    const j = await r.json();
    return !!(j && j.ok);
  } catch (_) { return false; }
}
const BSCH = [["announcements", "Announcements", "📣"], ["training", "Training", "🎓"], ["licensing", "Licensing", "📝"], ["cft", "CFT Room", "🎵"]];
async function loadBases() { const v = await loadKey("baseshops"); if (v && Array.isArray(v.bases)) return { root: v.root || "STANDARD", bases: v.bases }; return { root: "STANDARD", bases: [{ name: "STANDARD" }] }; }
function genChannels(bases: any) {
  const ch: any[] = [ { id: "main", name: "Company Chat", icon: "💬" }, { id: "leadership", name: "Leadership", icon: "👑" }, { id: "operations", name: "Operations", icon: "⚙️" } ];
  const root = low(bases.root || "STANDARD");
  for (const bs of (bases.bases || [])) { const nm = String(bs.name); const pfx = low(nm); if (pfx === root) continue; for (const c of BSCH) ch.push({ id: pfx + "_" + c[0], name: nm + " · " + c[1], icon: c[2], baseshop: nm, baseshopName: nm, sub: c[0] }); }
  return ch;
}
async function customChannels() { const v = await loadKey("hub_channels"); return (v && Array.isArray(v.channels)) ? v.channels : []; }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: any = {}; try { body = req.method === "POST" ? await req.json() : {}; } catch (_) { body = {}; }
  if (!(await opsAuthorized(body.token))) return json({ ok: false, error: "unauthorized" }, 401);
  const action = String(body.action || "channels");

  if (action === "channels" || action === "hub_channels" || action === "hub_access") {
    const bases = await loadBases();
    const channels = genChannels(bases).concat(await customChannels());
    const baseshops = (bases.bases || []).filter((b: any) => low(b.name) !== low(bases.root)).map((b: any) => ({ id: low(b.name), name: String(b.name), emd: b.owner_name || "" }));
    const access = { role: "ops", licensed: true, mod: true, name: String(body.name || "Operations"), baseshop: bases.root, scope: "super", owns_base: "", accessibleBases: (bases.bases || []).map((b: any) => String(b.name)) };
    return json({ ok: true, access, channels, baseshops, ops: true });
  }

  if (action === "dms") {
    const rows = await getJSON(`hub_messages?channel=like.dm:*&select=channel&limit=40000`);
    const counts: Record<string, number> = {}; for (const r of rows) counts[r.channel] = (counts[r.channel] || 0) + 1;
    const ag = await getJSON(`tracker_agents?select=code,first_name,last_name&code=neq.POOL&limit=3000`);
    const nm: Record<string, string> = {}; for (const a of ag) nm[norm(a.code)] = (((a.first_name || "") + " " + (a.last_name || "")).trim()) || String(a.code);
    const dms = Object.keys(counts).map((ch) => { const parts = ch.slice(3).split("|"); const names = parts.map((p) => p === "KYLE" ? "Kyle" : (nm[norm(p)] || p)); return { channel: ch, parts, names, label: names.join(" ↔ "), count: counts[ch] }; }).sort((a, b) => a.label.localeCompare(b.label));
    return json({ ok: true, count: dms.length, dms });
  }

  return json({ ok: false, error: "unknown action" }, 400);
});
