// ops-statecolors v2 (2026-09-29) — Operations owns the State column's colours.
//
// Christopher: "allow for OPERATIONS to change and manipulate the state colors based on categories
// they deem fit." The red/orange rules were hardcoded in ops.html, so every change was a deploy.
// They live in app_settings.ops_state_colors now: Operations defines the CATEGORIES (label and
// colour) and which states belong to each.
//
// Deliberately its own small endpoint rather than another action bolted onto ops-directory: this
// is one setting with one permission rule, and it has no business sharing a function that also
// deletes agents.
//
// READ is open to any signed-in Ops seat or leader — the colours are on a board they already see.
// WRITE is Operations (or the platform builder) only: these rules drive how every seat reads the
// book, so one agent must not be able to repaint it for everybody.
//
// v2 (2026-10-15): THE RULE ABOVE WAS A COMMENT, NOT A CHECK. Read answered anonymously, and
// worse, canWrite() accepted `by_code` — so typing the platform builder's agent code, which is
// printed on the org chart, let anyone REPAINT the state rules for every seat in the company:
//
//   POST /ops-statecolors {"action":"save","by_code":"C1991","config":{...}}
//
// Identity is resolved once now, from an Operations session token or the caller's own signed-in
// agent session, and `platform_admin` is read off the VERIFIED code. Read needs a session too,
// which is what the paragraph above always claimed.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const clean = (s: unknown, n = 60) => (s ?? "").toString().trim().slice(0, n);
const slug = (s: unknown) => (s ?? "").toString().trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
const enc = encodeURIComponent;

async function db(path: string, init?: RequestInit) { return fetch(`${SUPA}/rest/v1/${path}`, { ...init, headers: { ...DBH, ...(init?.headers || {}) } }); }
async function dbGet(path: string) { const r = await db(path); return (await r.json()) || []; }
async function rpc(fn: string, args: Record<string, unknown>) { try { const r = await db(`rpc/${fn}`, { method: "POST", body: JSON.stringify(args) }); return await r.json(); } catch (_) { return null; } }

const DEFAULTS = {
  categories: [
    { id: "red",   label: "Red",   color: "#d64550" },
    { id: "watch", label: "Watch", color: "#e07a2f" },
  ],
  states: {} as Record<string, string>,
};

/* Only real US state / territory codes may be stored, so a typo cannot quietly create a rule
   that never matches anything. */
const CODES = new Set(("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS " +
  "MO MT NE NV NH NJ NM NY NC ND OH OK OR PA PR RI SC SD TN TX UT VT VA WA WV WI WY").split(" "));

/* One resolution of identity for the whole request. ops = a live Operations session. */
async function whoIsCalling(body: Record<string, unknown>): Promise<{ ok: boolean; code: string; ops: boolean }> {
  const tok = String(body.token ?? "").trim();
  if (tok) {
    const az = await rpc("ops_authorize", { p_token: tok });
    if (az && az.ok) return { ok: true, code: norm(az.code), ops: true };
  }
  const s = String(body.session ?? "").trim().slice(0, 120);
  if (!s) return { ok: false, code: "", ops: false };
  const got = await rpc("agent_session_code", { p_token: s });
  const code = (typeof got === "string") ? norm(got) : "";
  return code ? { ok: true, code, ops: false } : { ok: false, code: "", ops: false };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body: Record<string, unknown> = req.method === "POST" ? (await req.json().catch(() => ({}))) : {};
    const action = clean(body.action, 20) || "get";

    const me = await whoIsCalling(body);
    if (!me.ok) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401);

    /* platform_admin is read from the verified code, never from one supplied in the body. */
    let canWrite = me.ops;
    if (!canWrite && me.code) {
      const a = (await dbGet(`tracker_agents?code=eq.${enc(me.code)}&select=platform_admin`))[0];
      canWrite = !!(a && a.platform_admin === true);
    }

    const row = (await dbGet(`app_settings?key=eq.ops_state_colors&select=value`))[0];
    const cur = (row && row.value && typeof row.value === "object") ? row.value : DEFAULTS;

    if (action === "get") {
      return json({ ok: true, config: cur, can_edit: canWrite });
    }

    if (action === "save") {
      if (!canWrite) {
        return json({ ok: false, error: "Only Operations can change the State colours." }, 403);
      }
      const inCats = Array.isArray((body.config as any)?.categories) ? (body.config as any).categories : [];
      const inStates = ((body.config as any)?.states && typeof (body.config as any).states === "object")
        ? (body.config as any).states : {};

      /* Keep only well-formed categories, and dedupe ids so two cannot fight over the same key. */
      const seen = new Set<string>();
      const categories: { id: string; label: string; color: string }[] = [];
      for (const c of inCats.slice(0, 12)) {
        const label = clean(c && c.label, 40);
        if (!label) continue;
        let id = slug(c && c.id) || slug(label);
        if (!id || seen.has(id)) id = id + "-" + (categories.length + 1);
        seen.add(id);
        const color = /^#[0-9a-fA-F]{6}$/.test(String(c && c.color)) ? String(c.color) : "#8e8e93";
        categories.push({ id, label, color });
      }
      const validIds = new Set(categories.map((c) => c.id));

      /* A state may only point at a category that still exists, so deleting a category cannot
         leave rows referencing a colour that is gone. */
      const states: Record<string, string> = {};
      for (const k of Object.keys(inStates)) {
        const code = norm(k);
        if (!CODES.has(code)) continue;
        const cat = slug(inStates[k]);
        if (!cat || !validIds.has(cat)) continue;
        states[code] = cat;
      }

      const value = { categories, states };
      const up = await db(`app_settings?on_conflict=key`, {
        method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ key: "ops_state_colors", value, updated_at: new Date().toISOString() }),
      });
      if (!up.ok) return json({ ok: false, error: "Could not save." }, 500);
      return json({ ok: true, config: value });
    }

    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
