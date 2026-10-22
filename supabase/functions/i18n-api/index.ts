// i18n-api v1 — platform-wide EN→ES translation with a shared, growing server-side cache.
// actions:
//   dict            → { ok, map }        the full cached English→Spanish map (client applies instantly)
//   translate {strings:[...]} → { ok, map }  translate any not-yet-cached strings via ai-api (Claude), cache, return
//   set_override {en, es}     → manually correct/lock a translation (Ops token)
// Cache lives in app_settings key 'i18n_es'. Spanish = Latin-American, US-Hispanic financial-services register.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ADMIN_TOKEN = "2026";
const AI = `${SUPA.replace(/\/$/, "")}/functions/v1/ai-api`;
const CACHE_KEY = "i18n_es";
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
function json(o: unknown, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }
const clean = (s: unknown) => (s ?? "").toString();
async function loadKey(k: string) { const r = await fetch(`${SUPA}/rest/v1/app_settings?key=eq.${k}&select=value`, { headers: DBH }); const rows = await r.json(); return (rows && rows[0]) ? rows[0].value : null; }
async function saveKey(k: string, v: unknown) { await fetch(`${SUPA}/rest/v1/app_settings?on_conflict=key`, { method: "POST", headers: { ...DBH, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key: k, value: v, updated_at: new Date().toISOString() }) }); }
async function getMap(): Promise<Record<string, string>> { const raw = await loadKey(CACHE_KEY); return (raw && typeof raw === "object") ? raw : {}; }

const SYS = "You are a professional translator for a US financial-services platform (life insurance, IUL, FIA, annuities, recruiting). Translate each English UI string into natural, warm Latin-American Spanish as used with US Hispanic clients. Rules: keep it concise (these are UI labels, buttons, and short sentences); do NOT translate or alter product acronyms or codes (IUL, FIA, PFR, GFI, AP, EMD, MD, CFT, ROP, SMD, NVP), numbers, currency, %, emojis, {curly placeholders}, or HTML entities; preserve leading/trailing spacing intent; keep punctuation. Return ONLY a compact JSON array of the translated strings, in the SAME order and SAME length as the input array — no keys, no commentary, no code fences.";

async function aiTranslate(batch: string[]): Promise<string[]> {
  const r = await fetch(AI, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "ask", system: SYS, prompt: JSON.stringify(batch), max_tokens: 4000 }) });
  if (!r.ok) return [];
  const j = await r.json(); let txt = clean(j.answer).trim();
  if (!txt) return [];
  txt = txt.replace(/^```(?:json)?/i, "").replace(/```$/,"").trim();
  const a = txt.indexOf("["); const b = txt.lastIndexOf("]");
  if (a < 0 || b < 0 || b <= a) return [];
  try { const arr = JSON.parse(txt.slice(a, b + 1)); return Array.isArray(arr) ? arr.map((x) => clean(x)) : []; } catch (_) { return []; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: any = {}; try { body = req.method === "POST" ? await req.json() : {}; } catch (_) { body = {}; }
  const action = String(body.action || "dict");

  if (action === "dict") { return json({ ok: true, map: await getMap() }); }

  if (action === "set_override") {
    if (String(body.token || "") !== ADMIN_TOKEN) return json({ ok: false, error: "unauthorized" }, 401);
    const en = clean(body.en).trim(); const es = clean(body.es).trim();
    if (!en || !es) return json({ ok: false, error: "en and es required" });
    const map = await getMap(); map[en] = es; await saveKey(CACHE_KEY, map);
    return json({ ok: true });
  }

  if (action === "translate") {
    const strings: string[] = Array.isArray(body.strings) ? body.strings.map((x: unknown) => clean(x)) : [];
    if (!strings.length) return json({ ok: true, map: {} });
    const map = await getMap();
    // unique, uncached, sane-length strings only
    const need: string[] = [];
    const seen = new Set<string>();
    for (const s of strings) {
      const t = s.trim();
      if (!t || t.length > 400) continue;
      if (map[t] != null || seen.has(t)) continue;
      seen.add(t); need.push(t);
    }
    // cap work per request to stay responsive; client will call again for the rest
    const work = need.slice(0, 160);
    let changed = false;
    for (let i = 0; i < work.length; i += 40) {
      const batch = work.slice(i, i + 40);
      const out = await aiTranslate(batch);
      if (out.length === batch.length) {
        for (let k = 0; k < batch.length; k++) { const es = (out[k] || "").trim(); if (es) { map[batch[k]] = es; changed = true; } }
      }
    }
    if (changed) await saveKey(CACHE_KEY, map);
    // return only the subset the caller asked about
    const outMap: Record<string, string> = {};
    for (const s of strings) { const t = s.trim(); if (map[t] != null) outMap[t] = map[t]; }
    return json({ ok: true, map: outMap, translated: changed, remaining: Math.max(0, need.length - work.length) });
  }

  return json({ ok: false, error: "unknown action" }, 400);
});
