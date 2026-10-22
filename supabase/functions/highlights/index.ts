// highlights v2 (2026-10-20) — the team-highlights carousel on the app home.
//
// Christopher: "create a team wheel of highlights through uploaded images."
// The iPhone brief then narrowed WHO may change it: "Only the authenticated account belonging to
// Elijah Cox can manage its content... His display name alone is not authorization; names can
// change or collide... A generic admin role must not silently grant other people this editing
// capability. The stated requirement is Elijah only."
//
// v1 FAILED THAT on both counts. It granted editing to Operations, to the platform admin, and to
// anyone whose contract_level read EMD / NVP / SEVP — five EMDs plus Ops plus admin, where the
// requirement is one person. v2 replaces that with one explicit server-side allow-list of agent
// CODES in app_settings.highlights_editors, seeded with GFI20 and nothing else. Rank, Operations
// and platform_admin now confer no editing rights here at all, which is the point: this is the
// one capability that is NOT inherited from being powerful elsewhere.
//
// WHY A CODE AND NOT A NAME. The roster holds two people called Elijah — Elijah Cox (GFI20,
// active) and Elijah Harding (H0583, quit). A name test would be ambiguous today, never mind
// after a marriage or a typo. The allow-list is also not a client-supplied value, a UI flag or a
// localStorage entry: it is read from the database on every write, and the caller is identified
// by the session token minted at PIN entry, so a typed code proves nothing.
//
// EVERY WRITE IS CHECKED, not just the one with a visible button: add, replace, reorder and
// remove each call canEdit() independently. Hiding the controls is a courtesy to everybody else;
// it is not the control.
//
// Images arrive already resized by the browser and are kept as data URLs, exactly the way profile
// photos have worked since 2026-07-25. That reuse is deliberate: no storage bucket, no signed
// URLs, and no second set of access rules that could disagree with the first.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const low = (s: unknown) => (s ?? "").toString().trim().toLowerCase();
const enc = encodeURIComponent;

/* A resized photo is a few hundred KB. Anything beyond this is not a resized photo, and a
   carousel of them would make the home screen slow to open on a phone. */
const MAX_CHARS = 900_000;
const MAX_SLIDES = 12;
/* If the setting is ever deleted the feature must LOCK, not open. */
const FALLBACK_EDITORS = ["GFI20"];

async function getJSON(path: string) { try { const r = await fetch(`${SUPA}/rest/v1/${path}`, { headers: DBH }); return (await r.json()) || []; } catch (_) { return []; } }
async function rpc(fn: string, args: Record<string, unknown>) { try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); return await r.json(); } catch (_) { return null; } }

/* The allow-list, read fresh from the database on every request. */
async function editorCodes(): Promise<string[]> {
  const rows = await getJSON(`app_settings?key=eq.highlights_editors&select=value`);
  const v = rows[0] && rows[0].value;
  const list = (v && Array.isArray(v.codes)) ? v.codes : null;
  const codes = (list || FALLBACK_EDITORS).map(norm).filter(Boolean);
  return codes.length ? codes : FALLBACK_EDITORS.map(norm);
}

type Me = { ok: boolean; code?: string; name?: string; baseshop?: string; canEdit?: boolean; seesAll?: boolean; error?: string };

async function whoIs(body: any): Promise<Me> {
  const editors = await editorCodes();
  /* Operations may LOOK at every shop's highlights — they look after all of them — but an
     Operations token does not confer editing. Only the allow-list does. */
  const t = String(body.token ?? "").trim();
  if (t) {
    const r = await rpc("ops_authorize", { p_token: t });
    if (r && r.ok) {
      const c = norm(r.code);
      return { ok: true, code: c, name: String(r.label || "Operations"), baseshop: "", seesAll: true, canEdit: editors.indexOf(c) >= 0 };
    }
  }
  /* Everyone else by their own signed-in agent session. A typed code is not identity. */
  const s = String(body.session ?? "").trim().slice(0, 120);
  if (!s) return { ok: false, error: "Sign in to see your team highlights." };
  const got = await rpc("agent_session_code", { p_token: s });
  const code = (typeof got === "string") ? norm(got) : "";
  if (!code) return { ok: false, error: "Your session has expired — sign in again." };
  const rows = await getJSON(`tracker_agents?code=eq.${enc(code)}&select=first_name,last_name,baseshop,platform_admin,status`);
  const a = rows[0] || {};
  if (low(a.status) === "quit") return { ok: false, error: "That account is no longer active." };
  return {
    ok: true, code,
    name: `${a.first_name || ""} ${a.last_name || ""}`.trim() || code,
    baseshop: String(a.baseshop || ""),
    /* platform_admin is deliberately NOT consulted. The brief forbids a generic admin role
       quietly conferring this, and Christopher holds that flag. */
    seesAll: a.platform_admin === true,
    canEdit: editors.indexOf(code) >= 0,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: any = {}; try { body = req.method === "POST" ? await req.json() : {}; } catch (_) { body = {}; }

  const me = await whoIs(body);
  if (!me.ok) return json({ ok: false, error: me.error || "unauthorized" }, 401);
  const action = String(body.action || "list");
  const myShop = low(me.baseshop);

  /* One gate, called by every write. Not a flag computed once and trusted afterwards. */
  function mustEdit() {
    if (me.canEdit) return null;
    return json({ ok: false, error: "Team highlights are managed by Elijah Cox." }, 403);
  }

  /* ---------------------------------------------------------------- list ---- */
  if (action === "list") {
    const all = await getJSON(`team_highlights?select=id,baseshop,url,caption,sort,created_by_name,created_at&order=sort.asc,created_at.desc&limit=200`);
    const mine = (me.seesAll || !myShop)
      ? all
      : all.filter((h: any) => !h.baseshop || low(h.baseshop) === myShop);
    return json({
      ok: true,
      can_edit: !!me.canEdit,
      baseshop: me.baseshop || "",
      max: MAX_SLIDES,
      highlights: mine.map((h: any) => ({
        id: h.id, url: h.url, caption: h.caption || "",
        baseshop: h.baseshop || "", by: h.created_by_name || "", at: h.created_at,
        sort: Number(h.sort) || 0,
      })),
    });
  }

  /* ---------------------------------------------------------------- add ----- */
  if (action === "add") {
    const no = mustEdit(); if (no) return no;
    const url = String(body.url ?? "");
    if (!url.startsWith("data:image/")) return json({ ok: false, error: "That does not look like an image." });
    if (url.length > MAX_CHARS) return json({ ok: false, error: "That image is too large even after resizing — try a smaller one." });

    /* Elijah owns the company board, so his highlights are company-wide by default: every shop
       sees them. A baseshop may still be named explicitly. */
    const shop = String(body.baseshop || "").trim() || null;
    const existing = await getJSON(`team_highlights?select=id&${shop ? `baseshop=eq.${enc(shop)}` : "baseshop=is.null"}`);
    if (existing.length >= MAX_SLIDES) {
      return json({ ok: false, error: `That is the limit of ${MAX_SLIDES} highlights — remove one first.` });
    }
    /* New slides go to the end rather than fighting for position 0. */
    const tail = await getJSON(`team_highlights?select=sort&order=sort.desc&limit=1`);
    const nextSort = (tail[0] ? (Number(tail[0].sort) || 0) : 0) + 1;

    const r = await fetch(`${SUPA}/rest/v1/team_highlights`, {
      method: "POST", headers: { ...DBH, Prefer: "return=representation" },
      body: JSON.stringify({
        baseshop: shop, url,
        caption: String(body.caption ?? "").slice(0, 120),
        sort: (body.sort != null) ? (Number(body.sort) || 0) : nextSort,
        created_by: me.code, created_by_name: me.name,
      }),
    });
    if (!r.ok) return json({ ok: false, error: "Could not save that image." }, 500);
    const row = (await r.json())[0] || {};
    return json({ ok: true, id: row.id });
  }

  /* ------------------------------------------------------------ replace ----- */
  /* Swapping the photo on an existing slide, or editing its caption, without losing its place
     in the order — "replacing/removing images" in the brief. */
  if (action === "replace") {
    const no = mustEdit(); if (no) return no;
    const id = String(body.id || "");
    if (!id) return json({ ok: false, error: "Which highlight?" });
    const row = (await getJSON(`team_highlights?id=eq.${enc(id)}&select=id`))[0];
    if (!row) return json({ ok: false, error: "That highlight no longer exists." }, 404);

    const patch: Record<string, unknown> = {};
    if (body.url != null) {
      const url = String(body.url);
      if (!url.startsWith("data:image/")) return json({ ok: false, error: "That does not look like an image." });
      if (url.length > MAX_CHARS) return json({ ok: false, error: "That image is too large even after resizing." });
      patch.url = url;
    }
    if (body.caption != null) patch.caption = String(body.caption).slice(0, 120);
    if (!Object.keys(patch).length) return json({ ok: false, error: "Nothing to change." });

    const u = await fetch(`${SUPA}/rest/v1/team_highlights?id=eq.${enc(id)}`, {
      method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify(patch),
    });
    return json({ ok: u.ok, id });
  }

  /* ------------------------------------------------------------ reorder ----- */
  if (action === "reorder") {
    const no = mustEdit(); if (no) return no;
    const ids = Array.isArray(body.ids) ? body.ids.map((x: unknown) => String(x ?? "").trim()).filter(Boolean) : [];
    if (!ids.length) return json({ ok: false, error: "Send the order to apply." });
    if (ids.length > MAX_SLIDES * 2) return json({ ok: false, error: "Too many items." });
    /* Position is the index in the list the editor just dragged into shape. Written one row at a
       time so a single bad id cannot discard the whole arrangement. */
    let done = 0;
    for (let i = 0; i < ids.length; i++) {
      const u = await fetch(`${SUPA}/rest/v1/team_highlights?id=eq.${enc(ids[i])}`, {
        method: "PATCH", headers: { ...DBH, Prefer: "return=minimal" }, body: JSON.stringify({ sort: i + 1 }),
      });
      if (u.ok) done++;
    }
    return json({ ok: true, reordered: done, of: ids.length });
  }

  /* ------------------------------------------------------------- remove ----- */
  if (action === "remove") {
    const no = mustEdit(); if (no) return no;
    const id = String(body.id || "");
    if (!id) return json({ ok: false, error: "Which highlight?" });
    const row = (await getJSON(`team_highlights?id=eq.${enc(id)}&select=id`))[0];
    if (!row) return json({ ok: false, error: "That highlight is already gone." }, 404);
    const d = await fetch(`${SUPA}/rest/v1/team_highlights?id=eq.${enc(id)}`, { method: "DELETE", headers: { ...DBH, Prefer: "return=minimal" } });
    return json({ ok: d.ok, id });
  }

  return json({ ok: false, error: "unknown action" }, 400);
});
