// org-archive v1 — an EMD folds someone away on their own org chart, or brings them back.
//
// Until now only Operations could do this, from the Ops tracker, which an EMD cannot reach.
// So an EMD watching someone leave had to message Operations and wait, while the person kept
// appearing in their chart and their head-counts.
//
// DELIBERATELY NOT A DELETE. The org chart is a family tree: nobody is ever removed. Marking
// someone departed moves them to Alumni — still on the tree, never counted, one toggle away
// from visible. This matters more than it sounds: the quit flag has been wrong at least six
// times on this platform, and an action that can be wrong must be an action that can be undone.
//
// Scope is the point. An EMD may fold away their OWN people — anyone in their downline, or in
// a baseshop they own. They cannot touch another shop, they cannot touch the hierarchy root,
// and they cannot re-parent anybody: who reports to whom stays with Operations and Eli Cox.
//
// Actions:
//   can { session }                    -> { allowed, level, scope }
//   set { session, code, departed }    -> fold away / bring back one person

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const lo = (s: unknown) => (s ?? "").toString().trim().toLowerCase();
const enc = encodeURIComponent;

async function rpc(fn: string, args: Record<string, unknown>) {
  try {
    const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) });
    return await r.json();
  } catch (_) { return null; }
}
async function getJSON(path: string) {
  try { const r = await fetch(`${SUPA}/rest/v1/${path}`, { headers: DBH }); return (await r.json()) || []; }
  catch (_) { return []; }
}

async function sessionCode(session: unknown): Promise<string> {
  const s = String(session ?? "").trim().slice(0, 120);
  if (!s) return "";
  const got = await rpc("agent_session_code", { p_token: s });
  return (typeof got === "string") ? norm(got) : "";
}
async function opsAuthorized(token: unknown): Promise<boolean> {
  const t = String(token ?? "").trim();
  if (!t) return false;
  const r = await rpc("ops_authorize", { p_token: t });
  return !!(r && r.ok);
}
function isEmdPlus(cl: unknown): boolean {
  const s = lo(cl);
  if (!s) return false;
  return s === "emd" || s.includes("executive marketing") || s === "nvp" ||
         s.includes("national vice") || s === "sevp" || s.includes("senior executive");
}

/* Who is asking, and how far their reach goes. */
async function who(body: Record<string, unknown>) {
  if (await opsAuthorized(body.token)) {
    return { ok: true, level: "ops", code: "", name: "Operations", all: true };
  }
  const code = await sessionCode(body.session);
  if (!code) return { ok: false, no_session: true, level: "", code: "", name: "", all: false };

  const a = (await getJSON(
    `tracker_agents?code=eq.${enc(code)}&select=code,first_name,last_name,contract_level,title,platform_admin&limit=1`,
  ))[0];
  if (!a) return { ok: false, level: "", code, name: "", all: false };

  const nm = `${a.first_name || ""} ${a.last_name || ""}`.trim() || code;
  if (a.platform_admin === true) return { ok: true, level: "admin", code, name: nm, all: true };
  if (isEmdPlus(a.contract_level || a.title)) return { ok: true, level: "emd", code, name: nm, all: false };
  return { ok: false, level: "", code, name: nm, all: false };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body: Record<string, unknown> = await req.json().catch(() => ({}));
    const action = String(body.action ?? "").trim();
    const w = await who(body);

    if (action === "can") {
      if (w.no_session) return json({ ok: false, needs_session: true, allowed: false }, 200);
      return json({ ok: true, allowed: !!w.ok, level: w.level, by: w.name,
                    scope: w.all ? "everyone" : "your own team" });
    }

    if (action !== "set") return json({ ok: false, error: "unknown action" }, 400);

    if (w.no_session) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 200);
    if (!w.ok) return json({ ok: false, error: "Only an EMD or Operations can do this." }, 403);

    const target = norm(body.code);
    const departed = body.departed === true;
    if (!target) return json({ ok: false, error: "Who?" }, 400);

    /* You cannot fold yourself away, and you cannot fold away the top of the tree — either
       would leave the chart without a root or without the person holding the pen. */
    if (w.code && target === norm(w.code)) {
      return json({ ok: false, error: "You cannot remove yourself from the chart." }, 403);
    }
    const root = norm(await rpc("org_root_code", {}));
    if (root && target === root) {
      return json({ ok: false, error: "The top of the hierarchy cannot be removed." }, 403);
    }

    const t = (await getJSON(
      `tracker_agents?code=eq.${enc(target)}&select=code,first_name,last_name,status,baseshop&limit=1`,
    ))[0];
    if (!t) return json({ ok: false, error: "No such person." }, 404);

    /* An EMD reaches their own downline only. Operations and the platform admin reach all. */
    if (!w.all) {
      const inDown = await rpc("is_in_downline", { p_leader: w.code, p_target: target });
      if (inDown !== true) {
        return json({ ok: false, error: "That person is not on your team." }, 403);
      }
    }

    const patch = departed
      ? { status: "quit" }
      : { status: "active" };
    const up = await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${enc(target)}`, {
      method: "PATCH",
      headers: { ...DBH, Prefer: "return=minimal" },
      body: JSON.stringify(patch),
    });
    if (!up.ok) return json({ ok: false, error: "Could not update." }, 500);

    const nm = `${t.first_name || ""} ${t.last_name || ""}`.trim() || target;
    return json({ ok: true, code: target, name: nm, departed,
                  message: departed
                    ? `${nm} moved to Alumni — still on the tree, no longer counted.`
                    : `${nm} is back on the active chart.` });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
