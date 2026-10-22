// hub-roster v2 (2026-09-30) — the Team Hub people directory, scoped to your own baseshop.
//
// Christopher: "please audit all tabs and make sure they are specifically base only."
//
// hub-api's `hub_roster` action takes NO caller at all and returns every active person in the
// company — 71 people across four shops. That list is the DM directory, the "add people to a
// channel" picker and the upline picker, so a TITANS agent could open a direct message with anyone
// in SMMT. This replaces it for the app.
//
// It is a separate function on purpose: hub-api is a 50KB live chat service and redeploying the
// whole file to change eight lines is the riskier change the night before launch. The scoping that
// matters happens HERE, before any data leaves the server — this is not client-side hiding.
//
// v2: WHOSE directory. v1 got the scoping right and then decided WHO was asking from a typed
// `code`. GFI codes are printed on the org chart, so a TITANS agent only had to type an SMMT
// agent's code to be handed the SMMT directory — the exact cross-shop leak v1 existed to close,
// reachable through the front door. Identity is now the session token minted at PIN entry.
//
// POST { session } -> { ok, count, members: [{code,name,direct_to,direct_to_name,md,emd,title,baseshop}] }
// Operations (a valid ops token) still gets everyone, for the oversight view.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();

async function rpc(fn: string, args: Record<string, unknown>) {
  try {
    const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) });
    return await r.json();
  } catch (_) { return null; }
}
async function opsAuthorized(token: unknown) {
  const t = String(token ?? "");
  if (!t) return false;
  const r = await rpc("ops_authorize", { p_token: t });
  return !!(r && r.ok);
}
/* Proof of identity. A session token is proof; a typed code is not. */
async function sessionCode(session: unknown): Promise<string> {
  const s = String(session ?? "").trim().slice(0, 120);
  if (!s) return "";
  const got = await rpc("agent_session_code", { p_token: s });
  return (typeof got === "string") ? norm(got) : "";
}
/* The one canonical answer to "which baseshops may this person see" — shared with the other tabs. */
async function agentScope(code: string) {
  const r = await rpc("agent_scope", { p_code: norm(code) });
  if (!r || r.ok !== true) return { ok: false, all: false, bases: [] as string[] };
  return { ok: true, all: !!r.all, bases: Array.isArray(r.bases) ? r.bases.map((x: unknown) => norm(x)) : [] as string[] };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    let body: Record<string, unknown> = {};
    if (req.method === "POST") body = await req.json().catch(() => ({}));

    const ops = await opsAuthorized(body.token);
    const me = ops ? "" : await sessionCode(body.session);

    let all = ops;
    let bases: string[] = [];
    if (!ops) {
      // No identity means no directory. Fail closed — the bug being fixed here is exactly an
      // endpoint that answered the whole company to a caller it could not identify.
      if (!me) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401);
      const sc = await agentScope(me);
      if (!sc.ok) return json({ ok: true, count: 0, members: [], scope: "unknown" });
      all = sc.all; bases = sc.bases;
    }

    let path = `tracker_agents?select=code,first_name,last_name,direct_to,direct_to_name,md,emd,status,title,baseshop&code=neq.POOL&order=first_name.asc`;
    if (!all) {
      // An unplaced agent has no shop, so they get themselves and nobody else.
      if (!bases.length) path += `&code=eq.${encodeURIComponent(me)}`;
      else path += `&baseshop=in.(${encodeURIComponent(bases.map((b) => `"${b}"`).join(","))})`;
    }

    const ex = await fetch(`${SUPA}/rest/v1/${path}`, { headers: DBH });
    const rows: Record<string, unknown>[] = (await ex.json()) || [];
    const members = rows
      .filter((r) => (r.status || "active") !== "quit")
      .map((r) => ({
        code: r.code,
        name: (((r.first_name as string) || "") + " " + ((r.last_name as string) || "")).trim(),
        direct_to: r.direct_to || "",
        direct_to_name: r.direct_to_name || "",
        md: r.md || "",
        emd: r.emd || "",
        title: r.title || "",
        baseshop: r.baseshop || "",
      }));

    return json({ ok: true, count: members.length, members, scope: all ? "all" : "baseshop", bases });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
