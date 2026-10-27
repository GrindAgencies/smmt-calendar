// hub-ops v6 (2026-10-26) — A BASESHOP OPS SEAT OVERSEES ONLY ITS OWN SHOP'S PRIVATE ROOMS.
//   Owner decision: private groups and DMs are overseen by the master seats (0000 Anais, C1991)
//   everywhere and by a per-baseshop seat only for its own shop(s). Every Ops token used to get
//   every private group, the list of all ~669 DM conversations, and the whole escalation queue.
//   Now a shop seat gets: private groups whose creator (byCode) is in its shops, DMs where either
//   person is in its shops, and only the escalations raised in groups it oversees (and may resolve
//   only those). Masters and machine tokens are unchanged. Same rule as hub-api v31 opsOversight.
// hub-ops v5 (2026-10-26) — the Operations side of "Ask Operations". Private groups reach Ops
//   ONLY when a member asks (hub-api hub_escalate, or @Operations in the group). These two
//   actions are how Ops sees and closes those requests:
//     escalations         -> open requests (oldest first) + the 20 most recently resolved
//     escalation_resolve  -> mark one resolved, stamped with the seat that closed it
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
/* One authority for "is this really Operations", shared with every other Operations endpoint.
   v6: also says how far it reaches. `full` = master seats and non-session (machine/legacy)
   tokens; otherwise the seat's shops via ops_scope (as pin lockAuthority). Fails closed. */
type OpsReach = { ok: boolean; full: boolean; bases: string[]; seat: string };
async function rpc(fn: string, args: Record<string, unknown>) { try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); return await r.json(); } catch (_) { return null; } }
async function opsReach(token: unknown): Promise<OpsReach> {
  const t = String(token ?? ""); const none = { ok: false, full: false, bases: [], seat: "" };
  if (!t) return none;
  const r = await rpc("ops_authorize", { p_token: t });
  if (!(r && r.ok)) return none;
  const seat = norm(r.code);
  if (r.master === true || r.via !== "session") return { ok: true, full: true, bases: [], seat };
  const sc = await rpc("ops_scope", { p_token: t });
  if (sc && sc.seat && !sc.scoped) return { ok: true, full: true, bases: [], seat };
  const bases: string[] = Array.isArray(sc?.bases) ? sc.bases.map((b: unknown) => norm(b)).filter(Boolean) : [];
  return { ok: true, full: false, bases, seat };
}
/* v6: may this seat oversee this room? Only private groups and DMs are limited. */
function opsOversight(reach: OpsReach) {
  let custom: any[] | null = null;
  let shops: Map<string, string> | null = null;
  const shopOf = async (code: unknown): Promise<string> => {
    if (!shops) { shops = new Map(); for (const a of await getJSON(`tracker_agents?select=code,baseshop&limit=10000`)) shops.set(norm(a.code), norm(a.baseshop)); }
    return shops.get(norm(code)) || "";
  };
  return async (channel: string): Promise<boolean> => {
    if (!reach.ok) return false;
    if (reach.full) return true;
    if (channel.indexOf("dm:") === 0) {
      for (const p of channel.slice(3).split("|")) { const b = await shopOf(p); if (b && reach.bases.indexOf(b) >= 0) return true; }
      return false;
    }
    if (channel.indexOf("c_") === 0) {
      if (!custom) custom = await customChannels();
      const c = custom.find((x: any) => String(x.id) === channel);
      if (!c || !c.private) return true;
      const by = norm(c.byCode);
      if (by && (by === reach.seat || by === "OPS:" + reach.seat)) return true;
      const b = by ? await shopOf(by) : "";
      return !!b && reach.bases.indexOf(b) >= 0;
    }
    return true;
  };
}
/* v8 (2026-10-26): one chat per baseshop plus Company Chat, the same set hub-api serves. */
const BSCH = [["chat", "", "💬"]];
async function loadBases() { const v = await loadKey("baseshops"); if (v && Array.isArray(v.bases)) return { root: v.root || "STANDARD", bases: v.bases }; return { root: "STANDARD", bases: [{ name: "STANDARD" }] }; }
function genChannels(bases: any) {
  const ch: any[] = [ { id: "main", name: "Company Chat", icon: "💬" }, { id: "operations", name: "Operations", icon: "⚙️" } ];
  const root = low(bases.root || "STANDARD");
  for (const bs of (bases.bases || [])) { const nm = String(bs.name); const pfx = low(nm); if (pfx === root) continue; for (const c of BSCH) ch.push({ id: pfx + "_" + c[0], name: c[1] ? nm + " · " + c[1] : nm, icon: c[2], baseshop: nm, baseshopName: nm, sub: c[0] }); }
  return ch;
}
async function customChannels() { const v = await loadKey("hub_channels"); return (v && Array.isArray(v.channels)) ? v.channels : []; }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: any = {}; try { body = req.method === "POST" ? await req.json() : {}; } catch (_) { body = {}; }
  const OPS = await opsReach(body.token);
  if (!OPS.ok) return json({ ok: false, error: "unauthorized" }, 401);
  const opsMay = opsOversight(OPS);
  const action = String(body.action || "channels");

  if (action === "channels" || action === "hub_channels" || action === "hub_access") {
    const bases = await loadBases();
    const channels = genChannels(bases);
    for (const c of await customChannels()) if (await opsMay(String(c.id))) channels.push(c);
    const baseshops = (bases.bases || []).filter((b: any) => low(b.name) !== low(bases.root)).map((b: any) => ({ id: low(b.name), name: String(b.name), emd: b.owner_name || "" }));
    const access = { role: "ops", licensed: true, mod: true, name: String(body.name || "Operations"), baseshop: bases.root, scope: "super", owns_base: "", accessibleBases: (bases.bases || []).map((b: any) => String(b.name)) };
    return json({ ok: true, access, channels, baseshops, ops: true });
  }

  if (action === "escalations") {
    let open = await getJSON(`hub_escalations?status=eq.open&select=*&order=created_at.asc&limit=200`);
    let done = await getJSON(`hub_escalations?status=eq.resolved&select=*&order=resolved_at.desc&limit=${OPS.full ? 20 : 200}`);
    /* v6: a shop seat's queue is the requests raised in the groups it oversees. */
    if (!OPS.full) {
      const mine = async (rows: any[]) => { const out: any[] = []; for (const r of (Array.isArray(rows) ? rows : [])) if (await opsMay(String(r.channel || ""))) out.push(r); return out; };
      open = await mine(open); done = (await mine(done)).slice(0, 20);
    }
    return json({ ok: true, open, resolved: done, count: Array.isArray(open) ? open.length : 0 });
  }
  if (action === "escalation_resolve") {
    const id = Number(body.id); if (!id) return json({ ok: false, error: "Which request?" }, 400);
    /* v6: a shop seat may only close a request from a group it oversees (same answer as none open). */
    if (!OPS.full) {
      const row = (await getJSON(`hub_escalations?id=eq.${id}&select=channel&limit=1`))[0];
      if (!row || !(await opsMay(String(row.channel || "")))) return json({ ok: true, resolved: 0 });
    }
    let seat = "Operations";
    try {
      const r = await fetch(`${SUPA}/rest/v1/rpc/ops_authorize`, { method: "POST", headers: DBH, body: JSON.stringify({ p_token: String(body.token ?? "") }) });
      const j = await r.json(); if (j && j.ok) seat = String(j.label || ("Ops " + (j.code || "")));
    } catch (_) { /* keep the generic stamp */ }
    const up = await fetch(`${SUPA}/rest/v1/hub_escalations?id=eq.${id}&status=eq.open`, { method: "PATCH", headers: { ...DBH, Prefer: "return=representation" },
      body: JSON.stringify({ status: "resolved", resolved_by: seat, resolved_at: new Date().toISOString() }) });
    const rows = up.ok ? ((await up.json()) || []) : [];
    return json({ ok: up.ok, resolved: rows.length });
  }

  if (action === "dms") {
    /* v7: counted in the database. Reading every DM message and counting here was silently capped
       at the API's 1,000-row page, so busy conversations crowded the rest out: 110 of 141 shown. */
    const rows = await rpc("hub_dm_channel_counts", {});
    const counts: Record<string, number> = {}; for (const r of (Array.isArray(rows) ? rows : [])) counts[r.channel] = Number(r.n) || 0;
    const ag = await getJSON(`tracker_agents?select=code,first_name,last_name&code=neq.POOL&limit=3000`);
    const nm: Record<string, string> = {}; for (const a of ag) nm[norm(a.code)] = (((a.first_name || "") + " " + (a.last_name || "")).trim()) || String(a.code);
    /* v6: a shop seat lists only DMs with at least one person from its shops. */
    let keys = Object.keys(counts);
    if (!OPS.full) { const keep: string[] = []; for (const ch of keys) if (await opsMay(ch)) keep.push(ch); keys = keep; }
    const dms = keys.map((ch) => { const parts = ch.slice(3).split("|"); const names = parts.map((p) => p === "KYLE" ? "Kyle" : (nm[norm(p)] || p)); return { channel: ch, parts, names, label: names.join(" ↔ "), count: counts[ch] }; }).sort((a, b) => a.label.localeCompare(b.label));
    return json({ ok: true, count: dms.length, dms });
  }

  return json({ ok: false, error: "unknown action" }, 400);
});
