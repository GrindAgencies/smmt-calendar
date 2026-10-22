// resources-api v5 — Resources tab store: carriers, scripts, agent how-tos, recordings.
// Carriers / scripts / how: editable by ANY signed-in user. Recordings: EMD/MD/Ops only.
//
// v2 (2026-09-30): the Operations shortcut in whoAmI() compared the token to a hardcoded "2026",
// so four digits granted `ops:true, leader:true` — which is read access to the MD/EMD-only
// recordings and the right to delete any resource. It now goes through ops_authorize(), the same
// authority as every other Operations endpoint, and can be closed centrally.
//
// v5 (2026-09-30): …and the OTHER half of the same gate. With the literal gone, `leader` was still
// decided by looking up whatever `code` the request typed — and GFI codes are printed on the org
// chart. So typing any MD's or EMD's code still unlocked the leader-only recordings and still
// allowed deleting any resource in the tab. Identity now comes from the session token minted at
// PIN entry.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
function json(o: unknown, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const clean = (s: unknown, n = 8000) => (s ?? "").toString().trim().slice(0, n);
const arr = (v: unknown) => Array.isArray(v) ? v : (v == null || v === "" ? [] : [v]);
const enc = encodeURIComponent;
const KINDS = ["carrier", "script", "how", "recording"];
const LEADER = /^(md|emd|nvp|sevp|marketing director|executive marketing director|national vice president|senior executive vice president)$/i;
async function getJSON(path: string) { try { const r = await fetch(`${SUPA}/rest/v1/${path}`, { headers: DBH }); return (await r.json()) || []; } catch (_) { return []; } }
async function rpc(fn: string, args: Record<string, unknown>) { try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); return await r.json(); } catch (_) { return null; } }
async function opsAuthorized(token: unknown): Promise<boolean> {
  const t = String(token ?? "").trim();
  if (!t) return false;
  const j = await rpc("ops_authorize", { p_token: t });
  return !!(j && j.ok);
}
/* Proof of identity. A session token is proof; a typed code is not. */
async function sessionCode(session: unknown): Promise<string> {
  const s = String(session ?? "").trim().slice(0, 120);
  if (!s) return "";
  const got = await rpc("agent_session_code", { p_token: s });
  return (typeof got === "string") ? norm(got) : "";
}
async function whoAmI(body: any) {
  if (await opsAuthorized(body.token)) return { ok: true, ops: true, leader: true, code: "OPS", name: clean(body.by_name) || "Operations" };
  const code = await sessionCode(body.session);
  if (!code) return { ok: false, ops: false, leader: false, code: "", name: "" };
  const rows = await getJSON(`tracker_agents?code=eq.${enc(code)}&select=first_name,last_name,contract_level&limit=1`);
  const a = rows[0]; const leader = !!(a && LEADER.test(String(a.contract_level || "").trim()));
  return { ok: !!a, ops: false, leader, code, name: a ? `${a.first_name || ""} ${a.last_name || ""}`.trim() : code };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: any = {}; try { body = await req.json(); } catch (_) { /* */ }
  const action = String(body.action || "list");
  const who = await whoAmI(body);
  if (!who.ok) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401);

  if (action === "list") {
    const kind = String(body.kind || ""); if (KINDS.indexOf(kind) < 0) return json({ ok: false, error: "bad kind" });
    if (kind === "recording" && !who.leader) return json({ ok: true, items: [], restricted: true, leader: false });
    const rows = await getJSON(`resources?kind=eq.${enc(kind)}&select=*&order=sort.asc,updated_at.desc&limit=2000`);
    return json({ ok: true, items: rows, leader: who.leader, me: who.code });
  }

  if (action === "save") {
    const kind = String(body.kind || ""); if (KINDS.indexOf(kind) < 0) return json({ ok: false, error: "bad kind" });
    if (kind === "recording" && !who.leader) return json({ ok: false, error: "Leaders (MD/EMD) only." }, 403);
    const row: Record<string, unknown> = {
      kind, title: clean(body.title, 400), category: clean(body.category, 200), body: clean(body.body, 20000),
      data: (body.data && typeof body.data === "object") ? body.data : {},
      updated_by: who.code, updated_by_name: who.name, updated_at: new Date().toISOString(),
    };
    if (body.effectiveness !== undefined && body.effectiveness !== null && body.effectiveness !== "") row.effectiveness = Math.max(0, Math.min(100, Number(body.effectiveness) || 0));
    if (body.tags !== undefined) row.tags = arr(body.tags).map((x) => clean(x, 60)).filter(Boolean);
    if (body.sort !== undefined) row.sort = Number(body.sort) || 0;
    let saved: any = null; let okFlag = false;
    if (body.id) {
      const up = await fetch(`${SUPA}/rest/v1/resources?id=eq.${enc(String(body.id))}`, { method: "PATCH", headers: { ...DBH, Prefer: "return=representation" }, body: JSON.stringify(row) });
      const r = await up.json(); saved = Array.isArray(r) ? r[0] : r; okFlag = up.ok;
    } else {
      row.created_by = who.code; row.created_by_name = who.name; row.created_at = row.updated_at;
      const ins = await fetch(`${SUPA}/rest/v1/resources`, { method: "POST", headers: { ...DBH, Prefer: "return=representation" }, body: JSON.stringify(row) });
      const r = await ins.json(); saved = Array.isArray(r) ? r[0] : r; okFlag = ins.ok;
    }
    return json({ ok: okFlag, item: saved });
  }

  if (action === "delete") {
    if (!(who.leader || who.ops)) return json({ ok: false, error: "Leaders (MD/EMD) only." }, 403);
    const id = String(body.id || ""); if (!id) return json({ ok: false, error: "no id" });
    const del = await fetch(`${SUPA}/rest/v1/resources?id=eq.${enc(id)}`, { method: "DELETE", headers: { ...DBH, Prefer: "return=minimal" } });
    return json({ ok: del.ok, id });
  }

  return json({ ok: false, error: "unknown action" }, 400);
});
