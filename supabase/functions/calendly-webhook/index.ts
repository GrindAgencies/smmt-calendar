// calendly-webhook v3 — receives Calendly booking events (invitee.created / invitee.canceled),
// verifies the HMAC signature against the CFT's stored signing key, updates calendly_events in real
// time, records an alert, and posts a live notification into the Team Hub.
// v2 HARDENING: removed the ?test bypass — every request must carry a valid Calendly signature.
// v3 (2026-09-18): the notice goes to the TRAINING channel of the baseshop that took the booking,
//   not #operations. #operations is the Operations team's own room now, and a booking belongs to
//   the shop that made it — Christopher: "Send all the other notifications to the training chats
//   in the perspective baseshops that do the business."
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const enc = (s: string) => encodeURIComponent(s);
const low = (s: unknown) => (s ?? "").toString().trim().toLowerCase();
async function db(path: string, init?: RequestInit) { return fetch(`${SUPA}/rest/v1/${path}`, { ...init, headers: { ...DBH, ...(init?.headers || {}) } }); }
async function dbGet(path: string) { const r = await db(path); return (await r.json()) || []; }
function fmt(iso: string) { try { return new Date(iso).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); } catch (_) { return iso; } }
// Which room hears about this booking: the booking agent's own baseshop training channel.
// Returns "" when the agent has no shop (or sits in the root shop, which has no channel group),
// and the notice is then simply not posted rather than landing somewhere it does not belong.
async function trainingChannelFor(agentCode: string): Promise<string> {
  if (!agentCode) return "";
  const ag = await dbGet(`tracker_agents?code=eq.${enc(agentCode)}&select=baseshop`);
  const shop = low(ag[0] && ag[0].baseshop);
  if (!shop) return "";
  const bs = await dbGet(`app_settings?key=eq.baseshops&select=value`);
  const root = low((bs[0] && bs[0].value && bs[0].value.root) || "STANDARD");
  if (shop === root) return "";
  return shop + "_training";
}
async function verifySig(raw: string, header: string, key: string): Promise<boolean> {
  if (!header || !key) return false;
  const parts: Record<string, string> = {}; header.split(",").forEach((s) => { const i = s.indexOf("="); if (i > 0) parts[s.slice(0, i).trim()] = s.slice(i + 1).trim(); });
  const t = parts["t"], sig = parts["v1"]; if (!t || !sig) return false;
  const te = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", te.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", k, te.encode(t + "." + raw));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hex.length !== sig.length) return false;
  let diff = 0; for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const raw = await req.text();
  let body: any = {}; try { body = JSON.parse(raw); } catch (_) { return new Response("bad json", { status: 400, headers: CORS }); }
  const ev = String(body.event || "");
  const p = body.payload || {};
  const se = p.scheduled_event || {};
  const hostEmail = low((se.event_memberships && se.event_memberships[0] && se.event_memberships[0].user_email) || "");
  const hostName = (se.event_memberships && se.event_memberships[0] && se.event_memberships[0].user_name) || "";

  // attribute to an agent via the connected Calendly email, then tracker email
  let agentCode = "", agentName = hostName, wkey = "";
  if (hostEmail) {
    const conns = await dbGet(`calendly_connections?cal_email=eq.${enc(hostEmail)}&select=code,webhook_key`);
    if (conns[0]) { agentCode = conns[0].code; wkey = conns[0].webhook_key || ""; }
    if (!agentCode) { const ags = await dbGet(`tracker_agents?email=eq.${enc(hostEmail)}&select=code,first_name,last_name`); if (ags[0]) { agentCode = ags[0].code; agentName = `${ags[0].first_name || ""} ${ags[0].last_name || ""}`.trim(); } }
  }

  // signature verification — always required. Unmatched host (no signing key) → reject.
  const ok = await verifySig(raw, req.headers.get("Calendly-Webhook-Signature") || "", wkey);
  if (!ok) return new Response("invalid signature", { status: 401, headers: CORS });

  const evUri = p.event || se.uri || "";
  const canceled = ev === "invitee.canceled";
  const loc = se.location || {};
  if (evUri) {
    await db(`calendly_events?on_conflict=event_uri`, { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({
      event_uri: evUri, event_uuid: String(evUri).split("/").pop(), agent_code: agentCode || null, agent_name: agentName || null,
      name: se.name || "", event_type_name: se.name || "", status: canceled ? "canceled" : (se.status || "active"),
      start_time: se.start_time || null, end_time: se.end_time || null, location_kind: loc.type || null,
      join_url: loc.join_url || loc.location || null, invitee_name: p.name || "", invitee_email: p.email || "", synced_at: new Date().toISOString()
    }) });
  }

  await db(`calendly_alerts`, { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ agent_code: agentCode || null, agent_name: agentName || null, kind: ev, event_name: se.name || "", invitee_name: p.name || "", invitee_email: p.email || "", start_time: se.start_time || null, event_uri: evUri }) });

  try {
    const channel = await trainingChannelFor(agentCode);
    if (channel) {
      const msg = (canceled ? "❌ Booking canceled: " : "📅 New booking: ") + (se.name || "appointment") + " — " + (p.name || "client") + " · " + fmt(se.start_time || "") + (agentName ? (" · " + agentName) : "");
      await db(`hub_messages`, { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ channel, author_code: "CALENDLY", author_name: "📅 Calendly", body: msg, kind: "system", reactions: {} }) });
    }
  } catch (_) { /* noop */ }

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
});
