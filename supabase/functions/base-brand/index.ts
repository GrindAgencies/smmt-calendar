// base-brand v3 — each baseshop as its own operating space, inside one platform.
//
// The EMD who owns a baseshop controls how it looks and what their team sees:
// colour, logo, the name they go by, the greeting on Home, what they are pushing
// this month, and which snapshot cards they do not use. What they cannot do is
// reshape the hierarchy — that is Operations and Eli Cox only (org-api).
//
// v3 (2026-09-30): canEditWith() compared the caller's token to a hardcoded "2026", so four
// digits returned can_edit:true for EVERY baseshop — the right to rename and recolour every
// shop in the company. Authorisation is resolved ONCE per request through ops_authorize() and
// passed down as a boolean, so the permission rule stays a pure function and there is only one
// place that decides what Operations means.
//
// v2 — honours the `super` flag already carried in app_settings.baseshops.
//
// Actions:
//   get   { code }                  -> the caller's baseshop branding + can_edit
//   for   { baseshop }              -> branding for one baseshop (read-only)
//   all   {}                        -> every baseshop's branding (theming, cheap)
//   save  { code, ...fields }       -> the owning EMD (or a super) updates it
//   logo_url { code, filename }     -> signed upload URL for a logo
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPS_CODE = /^000[0-5]$/;
const LOGO_BUCKET = "cal";                      // already public, already used for images
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const low = (s: unknown) => (s ?? "").toString().trim().toLowerCase();
const clean = (s: unknown, n = 300) => (s ?? "").toString().trim().slice(0, n);
const enc = encodeURIComponent;

async function opsAuthorized(token: unknown): Promise<boolean> {
  const t = String(token ?? "").trim();
  if (!t) return false;
  try {
    const r = await fetch(`${SUPA}/rest/v1/rpc/ops_authorize`, { method: "POST", headers: DBH, body: JSON.stringify({ p_token: t }) });
    const j = await r.json();
    return !!(j && j.ok);
  } catch (_) { return false; }
}

const HEX = /^#[0-9a-fA-F]{6}$/;
function softOf(hex: string): string {
  // a 12% tint of the accent, so cards and chips read as the same brand
  if (!HEX.test(hex)) return "rgba(91,108,255,.12)";
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},.12)`;
}

async function loadBases() {
  try {
    const r = await fetch(`${SUPA}/rest/v1/app_settings?key=eq.baseshops&select=value`, { headers: DBH });
    const v = ((await r.json()) || [])[0]?.value;
    const root = norm(v?.root || "STANDARD");
    const bases: Record<string, unknown>[] = Array.isArray(v?.bases) ? v.bases : [];
    return { root, bases };
  } catch (_) { return { root: "STANDARD", bases: [] as Record<string, unknown>[] }; }
}

// A "super" oversees every baseshop. The flag lives beside the owner in the
// baseshops config, which is where the grant is already administered.
function isSuper(bases: Record<string, unknown>[], code: string): boolean {
  return bases.some((b) => norm(b.owner_code) === code && String(b.super) === "true");
}

async function whoIs(code: string) {
  if (!code) return null;
  const r = await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${enc(code)}&select=code,first_name,last_name,contract_level,title,baseshop&limit=1`, { headers: DBH });
  const a = ((await r.json()) || [])[0];
  if (!a) return null;
  const lvl = low(a.contract_level) + " " + low(a.title);
  return {
    code: norm(a.code),
    name: `${a.first_name || ""} ${a.last_name || ""}`.trim(),
    baseshop: norm(a.baseshop),
    level: a.contract_level || a.title || "",
    isEmd: /\bemd\b|executive marketing|national vice|senior executive/.test(lvl),
  };
}

/* Who may edit a given baseshop's branding. `opsOk` is resolved once per request against
   ops_authorize() and handed in, so this stays a pure decision with no hidden authority. */
function canEditWith(bases: Record<string, unknown>[], me: { code: string; baseshop: string; isEmd: boolean } | null, baseshop: string, opsOk: boolean) {
  if (opsOk) return true;
  if (!me) return false;
  if (OPS_CODE.test(me.code)) return true;
  if (isSuper(bases, me.code)) return true;
  const owned = bases.some((b) => norm(b.name) === norm(baseshop) && norm(b.owner_code) === me.code);
  if (owned) return true;
  // A newly promoted EMD should not be locked out waiting for a config edit.
  return me.isEmd && me.baseshop === norm(baseshop);
}

async function readOne(baseshop: string) {
  const r = await fetch(`${SUPA}/rest/v1/baseshop_settings?baseshop=eq.${enc(baseshop)}&select=*&limit=1`, { headers: DBH });
  return ((await r.json()) || [])[0] || null;
}


/* ===== base-brand: WHO IS CALLING (2026-09-30) =====
   Identity used to come from a typed `code`, and GFI codes are printed on the org chart. It now
   comes from the session token minted when somebody enters their PIN, or an Operations token. */
const _SB = Deno.env.get("SUPABASE_URL")!;
const _SK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
async function _authRpc(fn: string, args: Record<string, unknown>) {
  try {
    const r = await fetch(`${_SB}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: _SK, Authorization: `Bearer ${_SK}`, "Content-Type": "application/json" }, body: JSON.stringify(args) });
    return await r.json();
  } catch (_) { return null; }
}
async function _isOps(token: unknown): Promise<boolean> {
  const t = String(token ?? "").trim(); if (!t) return false;
  const r = await _authRpc("ops_authorize", { p_token: t }); return !!(r && r.ok);
}
async function _sessionCode(session: unknown): Promise<string> {
  const s = String(session ?? "").trim().slice(0, 120); if (!s) return "";
  const got = await _authRpc("agent_session_code", { p_token: s });
  return (typeof got === "string") ? got.trim().toUpperCase() : "";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body: Record<string, unknown> = (req.method === "POST") ? (await req.json().catch(() => ({}))) : {};
    const action = clean(body.action, 20) || "get";
    const opsOk = await opsAuthorized(body.token);

    /* Every baseshop's branding. Cheap, and lets any screen theme itself. */
    if (action === "all") {
      const r = await fetch(`${SUPA}/rest/v1/baseshop_settings?select=*`, { headers: DBH });
      const rows = (await r.json()) || [];
      return json({ ok: true, brands: rows });
    }

    if (action === "for") {
      const bs = norm(body.baseshop);
      if (!bs) return json({ ok: false, error: "baseshop required" }, 400);
      return json({ ok: true, brand: await readOne(bs) });
    }

    /* v4 (2026-09-30): edit rights came from a typed `code`, so typing an EMD's code let you
       change that baseshop's logo and colours. Reads stay deliberately open — notif.js themes
       every page, including the sign-in screen, before anybody has a session. */
    const me = await whoIs(opsOk ? norm(body.code) : await _sessionCode(body.session));
    const { root, bases } = await loadBases();

    if (action === "get") {
      const target = norm(body.baseshop) || me?.baseshop || root;
      const brand = await readOne(target);
      const editable: string[] = [];
      for (const b of bases) {
        const nm = norm(b.name);
        if (editable.indexOf(nm) < 0 && canEditWith(bases, me, nm, opsOk)) editable.push(nm);
      }
      return json({
        ok: true,
        baseshop: target,
        brand,
        root,
        me: me ? { code: me.code, name: me.name, baseshop: me.baseshop, level: me.level, is_emd: me.isEmd } : null,
        can_edit: canEditWith(bases, me, target, opsOk),
        is_super: me ? isSuper(bases, me.code) || OPS_CODE.test(me.code) : false,
        editable_baseshops: editable,
        // Stated here so the UI can say plainly what an EMD does and does not own.
        hierarchy_note: "Your baseshop's look and dashboard are yours. Who reports to whom is managed by Operations and Eli Cox.",
      });
    }

    if (action === "logo_url") {
      const bs = norm(body.baseshop) || me?.baseshop || "";
      if (!canEditWith(bases, me, bs, opsOk)) return json({ ok: false, error: "Only this baseshop's EMD or Operations can change its logo." }, 403);
      const fn = clean(body.filename, 120).replace(/[^\w.\- ]+/g, "_");
      if (!fn) return json({ ok: false, error: "filename required" }, 400);
      const path = `baseshop-logos/${low(bs)}_${Date.now()}_${fn}`;
      const r = await fetch(`${SUPA}/storage/v1/object/upload/sign/${LOGO_BUCKET}/${path}`, {
        method: "POST", headers: DBH, body: JSON.stringify({}),
      });
      const j = await r.json();
      if (!j || !j.url) return json({ ok: false, error: "could not create upload url" }, 500);
      return json({
        ok: true, path,
        upload_url: `${SUPA}/storage/v1${j.url}`,
        public_url: `${SUPA}/storage/v1/object/public/${LOGO_BUCKET}/${path}`,
      });
    }

    if (action !== "save") return json({ ok: false, error: "unknown action" }, 400);

    const bs = norm(body.baseshop) || me?.baseshop || "";
    if (!bs) return json({ ok: false, error: "baseshop required" }, 400);
    if (!canEditWith(bases, me, bs, opsOk)) {
      return json({ ok: false, error: "Only this baseshop's EMD or Operations can change its settings." }, 403);
    }

    const patch: Record<string, unknown> = {
      baseshop: bs,
      updated_by: me?.code || "OPS",
      updated_by_name: me?.name || "Operations",
      updated_at: new Date().toISOString(),
    };
    if (body.display_name !== undefined) patch.display_name = clean(body.display_name, 60);
    if (body.tagline !== undefined) patch.tagline = clean(body.tagline, 140);
    if (body.welcome !== undefined) patch.welcome = clean(body.welcome, 240);
    if (body.logo_url !== undefined) patch.logo_url = clean(body.logo_url, 500);
    if (body.accent !== undefined) {
      const hex = clean(body.accent, 7);
      if (hex && !HEX.test(hex)) return json({ ok: false, error: "Colour must look like #5b6cff." }, 400);
      patch.accent = hex || null;
      patch.accent_soft = hex ? softOf(hex) : null;
    }
    if (Array.isArray(body.focus)) patch.focus = (body.focus as unknown[]).map((x) => clean(x, 80)).filter(Boolean).slice(0, 6);
    if (Array.isArray(body.hide_cards)) patch.hide_cards = (body.hide_cards as unknown[]).map((x) => low(x)).filter(Boolean).slice(0, 8);

    const up = await fetch(`${SUPA}/rest/v1/baseshop_settings?on_conflict=baseshop`, {
      method: "POST",
      headers: { ...DBH, Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify(patch),
    });
    const saved = ((await up.json()) || [])[0];
    if (!saved) return json({ ok: false, error: "Could not save." }, 500);
    return json({ ok: true, brand: saved });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
