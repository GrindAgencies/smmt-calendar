// present-api v2 (2026-09-07) — the agency's own presentations, served from inside the app.
//
// The Client Presentation and the Hiring Interview are the two things agents use every day and
// neither existed in the platform — they lived in Google Slides, which meant a login, a share
// setting, and a deck that is unusable on a phone in front of a client.
//
// They are now DATA (the presentations table), not a file: each slide carries what the client
// sees plus the speaker notes the agent reads. That means a leader can fix a line of script
// without redeploying anything, and the same content drives both the presenter and any export.
//
// v2 (2026-09-07) — TWO WAYS save() WAS QUIETLY DESTROYING THE DECK:
//   1. It rebuilt every slide from {t, sub, bullets, notes} and dropped everything else. The field
//      training deck is now the REAL company slides rendered from the source PowerPoint, and each
//      slide carries `img` (the exported slide) and `src` (its number in the original file). A
//      single edit through the app would have wiped every image and left 41 blank slides. This is
//      compliance-regulated material, so those fields are now preserved.
//   2. notes were truncated at 6,000 characters. The Client Service Menu script is 9,034 — it was
//      being cut mid-sentence, in the middle of the longest and most important talk track in the
//      deck. The ceiling is now 20,000.
//
// Actions:
//   list                     -> every active presentation (no slide bodies, for the tab)
//   get   { key }            -> one presentation with all slides + notes
//   save  { key, ..., code } -> leaders only: edit a deck
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const clean = (s: unknown, n = 400) => (s ?? "").toString().trim().slice(0, n);
const enc = encodeURIComponent;

async function getJSON(path: string) { try { const r = await fetch(`${SUPA}/rest/v1/${path}`, { headers: DBH }); return (await r.json()) || []; } catch (_) { return []; } }
async function rpc(fn: string, args: Record<string, unknown>) { try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); return await r.json(); } catch (_) { return null; } }

/* Editing the script is a leadership act — MD and above, Operations, or the platform builder. */
async function canEdit(code: string, token: unknown): Promise<boolean> {
  const t = await rpc("ops_authorize", { p_token: String(token ?? "") });
  if (t && t.ok) return true;
  const c = norm(code); if (!c) return false;
  const pa = await rpc("is_platform_admin", { p_code: c });
  if (pa === true) return true;
  const rows = await getJSON(`tracker_agents?code=eq.${enc(c)}&select=contract_level,title`);
  const a = (rows as any[])[0]; if (!a) return false;
  const lvl = ((a.contract_level || a.title || "") + "").toLowerCase();
  return /marketing director|executive|national vice|senior executive/.test(lvl) || lvl === "md" || lvl === "emd" || lvl === "nvp" || lvl === "sevp";
}


/* ===== present-api: WHO IS CALLING (2026-09-30) =====
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
    let body: Record<string, unknown> = {};
    if (req.method === "POST") body = await req.json().catch(() => ({}));
    const action = clean(body.action, 20) || "list";
    /* Resolve the caller once, then overwrite the typed code with the verified answer. */
    {
      const _ops = await _isOps((body as Record<string, unknown>).token);
      if (!_ops) {
        const _me = await _sessionCode((body as Record<string, unknown>).session);
        if (!_me) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401);
        (body as Record<string, unknown>).code = _me;
      }
    }

    if (action === "list") {
      const rows = await getJSON(`presentations?active=is.true&order=sort.asc&select=key,title,subtitle,audience,icon,sort,slides,updated_at`);
      const out = (rows as any[]).map((p) => ({
        key: p.key, title: p.title, subtitle: p.subtitle, audience: p.audience, icon: p.icon,
        slides: Array.isArray(p.slides) ? p.slides.length : 0, updated_at: p.updated_at,
      }));
      return json({ ok: true, presentations: out });
    }

    if (action === "get") {
      const key = clean(body.key, 60);
      if (!key) return json({ ok: false, error: "key required" });
      const rows = await getJSON(`presentations?key=eq.${enc(key)}&select=*&limit=1`);
      const p = (rows as any[])[0];
      if (!p) return json({ ok: false, error: "Presentation not found." }, 404);
      return json({ ok: true, presentation: p, can_edit: await canEdit(String(body.code || ""), body.token) });
    }

    if (action === "save") {
      if (!(await canEdit(String(body.code || ""), body.token))) {
        return json({ ok: false, error: "Marketing Directors and above can edit the presentations." }, 403);
      }
      const key = clean(body.key, 60);
      if (!key) return json({ ok: false, error: "key required" });
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString(), updated_by: norm(body.code) || null };
      if (body.title !== undefined) patch.title = clean(body.title, 120);
      if (body.subtitle !== undefined) patch.subtitle = clean(body.subtitle, 300);
      if (body.icon !== undefined) patch.icon = clean(body.icon, 8);
      if (body.active !== undefined) patch.active = !!body.active;
      if (body.slides !== undefined) {
        if (!Array.isArray(body.slides)) return json({ ok: false, error: "slides must be a list" });
        patch.slides = (body.slides as any[]).slice(0, 120).map((s: any) => {
          const out: Record<string, unknown> = {
            t: clean(s && s.t, 160), sub: clean(s && s.sub, 300),
            bullets: Array.isArray(s && s.bullets) ? s.bullets.slice(0, 12).map((b: unknown) => clean(b, 300)) : [],
            // 20,000 not 6,000: the Client Service Menu talk track alone is over 9,000 characters
            // and was being cut mid-sentence.
            notes: clean(s && s.notes, 20000),
          };
          // The exported company slide and its number in the source file. Preserved verbatim -
          // losing these would blank the deck, and it is regulated material.
          if (s && typeof s.img === "string" && s.img) out.img = clean(s.img, 300);
          if (s && s.src !== undefined && s.src !== null && !isNaN(Number(s.src))) out.src = Number(s.src);
          if (s && typeof s.viz === "string" && s.viz) out.viz = clean(s.viz, 40);
          if (s && s.vizArg !== undefined && s.vizArg !== null && !isNaN(Number(s.vizArg))) out.vizArg = Number(s.vizArg);
          return out;
        });
      }
      const r = await fetch(`${SUPA}/rest/v1/presentations?key=eq.${enc(key)}`, {
        method: "PATCH", headers: { ...DBH, Prefer: "return=representation" }, body: JSON.stringify(patch),
      });
      const out = await r.json();
      return json({ ok: r.ok, presentation: Array.isArray(out) ? out[0] : out });
    }

    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) { return json({ ok: false, error: String(e) }, 500); }
});
