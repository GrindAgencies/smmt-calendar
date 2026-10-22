// brain-learn v5 — leaders upload a recording; their baseshop gets it, and the
// assistant learns from it.
//
// Before this, the Data Brain only recorded what people ASKED. Nothing ever fed
// back into the answers: the assistant's knowledge was a hardcoded block of text
// in its own source. So a training an MD ran for their team could be stored and
// watched, but the chatbot remained ignorant of it.
//
// v2: recordings are BASESHOP-SCOPED. Each EMD's uploads belong to their own
// baseshop, and only that baseshop sees them. Uploading to STANDARD publishes to
// the whole hierarchy — every baseshop sees it. The Fathom-imported calls were
// cleared out; this is upload-only now.
//
// v5 (2026-09-30) — IDENTITY. This function decides who may write into the company's AI
// knowledge base, and it was answering that question with two things a stranger can supply:
//   · `ADMIN_TOKEN = "2026"` compared directly — so it never joined the September cutover onto
//     ops_authorize(), and turning the legacy switch off did nothing here. Sending the literal
//     granted Operations rights: upload, publish to the WHOLE hierarchy, and delete.
//   · a typed `code` for the "are you an MD or above" test. Codes are on the org chart.
// Anything written here is then quoted back to every agent by the assistant as company
// training, so this was a content-injection path into the AI, not only a permissions gap.
// Identity now comes from an Operations token ops_authorize() accepts, or the session token
// minted when somebody enters their PIN.
//
// What happens on upload:
//   1. the file lands in the private `trainings` bucket (signed URLs only)
//   2. a row is written to `resources` so it appears in the Resources tab
//   3. if there is TEXT — a pasted transcript, notes, or a text/markdown file —
//      Claude distils it into a summary plus the teaching points, and both go
//      into `brain_knowledge`, which the assistant searches at question time
//
// The honest limit: audio and video cannot be transcribed here. Claude does not
// accept audio and no transcription provider is wired up. A video therefore
// uploads and shares perfectly, but only teaches the assistant once someone
// supplies its transcript (paste it, attach a .txt/.vtt/.srt, or pull it from
// Fathom, which is already connected). This says so rather than pretending.
//
// Actions:
//   sign_upload { session, filename }                -> signed URL to PUT the file
//   save        { session, title, base, ... , text } -> resource row + learning
//   list        { session }                          -> what this person may see
//   search      { q, limit }                         -> ranked knowledge (used by assist)
//   file_url    { session, path }                    -> signed playback URL
//   remove      { session|token, id }                -> delete an upload + what it taught
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BUCKET = "trainings";
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const low = (s: unknown) => (s ?? "").toString().trim().toLowerCase();
const clean = (s: unknown, n = 400) => (s ?? "").toString().trim().slice(0, n);
const enc = encodeURIComponent;
async function rpc(fn: string, args: Record<string, unknown>) { try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); return await r.json(); } catch (_) { return null; } }

async function loadBases(): Promise<{ root: string; bases: string[] }> {
  try {
    const r = await fetch(`${SUPA}/rest/v1/app_settings?key=eq.baseshops&select=value`, { headers: DBH });
    const v = ((await r.json()) || [])[0]?.value;
    const root = String(v?.root || "STANDARD").toUpperCase();
    const list: string[] = Array.isArray(v?.bases) ? v.bases.map((b: Record<string, unknown>) => String(b.name || "").toUpperCase()) : [];
    const bases = Array.from(new Set(list.filter((b) => b && b !== root))).sort();
    return { root, bases };
  } catch (_) { return { root: "STANDARD", bases: [] }; }
}

/* Only Marketing Directors and above may publish to a team. The code passed in here has always
   come out of a verified session since v5 — never off the request. */
async function whoIs(code: string) {
  if (!code) return null;
  const r = await fetch(`${SUPA}/rest/v1/tracker_agents?code=eq.${enc(code)}&select=code,first_name,last_name,contract_level,title,baseshop&limit=1`, { headers: DBH });
  const a = ((await r.json()) || [])[0];
  if (!a) return null;
  const lvl = low(a.contract_level) + " " + low(a.title);
  // contract_level is free text: "MD", "Marketing Director", "EMD", "Executive...",
  // "National Vice President". Match the family, not one exact spelling.
  const isLeader = /\bemd\b|\bmd\b|marketing director|executive|national vice/.test(lvl);
  return {
    code: norm(a.code),
    name: `${a.first_name || ""} ${a.last_name || ""}`.trim(),
    baseshop: String(a.baseshop || "").toUpperCase(),
    level: a.contract_level || a.title || "",
    isLeader,
  };
}

async function callClaude(sys: string, prompt: string, maxTokens: number) {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return { txt: "", err: "no ANTHROPIC_API_KEY" };
  const MODELS = ["claude-sonnet-4-6", "claude-haiku-4-5", "claude-3-5-sonnet-20241022"];
  let lastErr = "";
  for (const model of MODELS) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model, max_tokens: maxTokens, system: sys, messages: [{ role: "user", content: prompt }] }),
      });
      const j = await res.json();
      const txt = j?.content?.[0]?.text ? String(j.content[0].text).trim() : "";
      if (txt) return { txt, model };
      lastErr = model + ": " + (j?.error?.message || "no text");
    } catch (e) { lastErr = model + ": " + String(e); }
  }
  return { txt: "", err: lastErr };
}

const VIDEO = /\.(mp4|mov|m4v|webm|avi|mkv)$/i;
const AUDIO = /\.(mp3|m4a|wav|aac|ogg)$/i;
const TEXTY = /\.(txt|md|vtt|srt|csv)$/i;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body: Record<string, unknown> = (req.method === "POST") ? (await req.json().catch(() => ({}))) : {};
    const action = clean(body.action, 24) || "list";

    /* ---------- retrieval: what the assistant calls ----------
       Deliberately left open. `assist` reaches this server-side while answering a question and
       carries no credential of its own, and what comes back is company training material rather
       than anybody's personal data. Everything that WRITES is gated below. */
    if (action === "search") {
      const q = clean(body.q, 500);
      if (!q) return json({ ok: true, hits: [] });
      const r = await fetch(`${SUPA}/rest/v1/rpc/brain_search`, {
        method: "POST", headers: DBH,
        body: JSON.stringify({ q, lim: Math.min(Number(body.limit) || 4, 10) }),
      });
      const hits = (await r.json()) || [];
      return json({ ok: true, hits: Array.isArray(hits) ? hits : [] });
    }

    // WHO IS CALLING — an Operations token, or the session minted at PIN entry. A typed `code`
    // is ignored: it used to be the whole basis for "are you a leader".
    const tok = clean(body.token, 120);
    let isOps = false;
    if (tok) { const az = await rpc("ops_authorize", { p_token: tok }); isOps = !!(az && az.ok); }
    let code = "";
    if (!isOps) {
      const sess = clean(body.session, 120);
      if (sess) { const got = await rpc("agent_session_code", { p_token: sess }); if (typeof got === "string") code = norm(got); }
    }
    if (!isOps && !code) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401);

    const me = await whoIs(code);
    const { root, bases } = await loadBases();

    if (action === "list") {
      const myBase = me?.baseshop || "";
      const r = await fetch(`${SUPA}/rest/v1/resources?kind=eq.training&select=*&order=created_at.desc&limit=300`, { headers: DBH });
      const all = (await r.json()) || [];
      // Everyone sees hierarchy-wide uploads; a baseshop upload is for that base.
      const items = all.filter((it: Record<string, unknown>) => {
        const d = (it.data || {}) as Record<string, unknown>;
        const b = String(d.base || "").toUpperCase();
        if (!b || b === root) return true;              // published to the whole hierarchy
        if (isOps) return true;
        return !!myBase && b === myBase;
      });
      const k = await fetch(`${SUPA}/rest/v1/brain_knowledge?source_type=eq.training&select=id,source_id,title,summary,uses,created_at&order=created_at.desc&limit=300`, { headers: DBH });
      const learned = (await k.json()) || [];
      return json({
        ok: true,
        can_upload: !!me?.isLeader || isOps,
        me: me ? { name: me.name, baseshop: me.baseshop, level: me.level } : null,
        root, bases, items, learned,
      });
    }

    if (!me?.isLeader && !isOps) {
      return json({ ok: false, error: "Uploading a recording is for Marketing Directors and above." }, 403);
    }

    if (action === "file_url") {
      const path = clean(body.path, 300);
      if (!path) return json({ ok: false, error: "path required" }, 400);
      const r = await fetch(`${SUPA}/storage/v1/object/sign/${BUCKET}/${path}`, {
        method: "POST", headers: DBH, body: JSON.stringify({ expiresIn: 60 * 60 * 6 }),
      });
      const j = await r.json();
      if (!j || !j.signedURL) return json({ ok: false, error: "could not sign" }, 500);
      return json({ ok: true, url: `${SUPA}/storage/v1${j.signedURL}` });
    }

    if (action === "sign_upload") {
      const fn = clean(body.filename, 160).replace(/[^\w.\- ]+/g, "_");
      if (!fn) return json({ ok: false, error: "filename required" }, 400);
      const path = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}_${fn}`;
      const r = await fetch(`${SUPA}/storage/v1/object/upload/sign/${BUCKET}/${path}`, {
        method: "POST", headers: DBH, body: JSON.stringify({}),
      });
      const j = await r.json();
      if (!j || !j.url) return json({ ok: false, error: "could not create upload url", detail: j }, 500);
      return json({ ok: true, path, upload_url: `${SUPA}/storage/v1${j.url}` });
    }

    if (action === "remove") {
      const id = clean(body.id, 60);
      if (!id) return json({ ok: false, error: "id required" }, 400);
      await fetch(`${SUPA}/rest/v1/brain_knowledge?source_id=eq.${enc(id)}`, { method: "DELETE", headers: { ...DBH, Prefer: "return=minimal" } });
      await fetch(`${SUPA}/rest/v1/resources?id=eq.${enc(id)}`, { method: "DELETE", headers: { ...DBH, Prefer: "return=minimal" } });
      return json({ ok: true, removed: id });
    }

    if (action !== "save") return json({ ok: false, error: "unknown action" }, 400);

    /* ---------- save the recording, and learn from it if there is text ---------- */
    const title = clean(body.title, 200);
    if (!title) return json({ ok: false, error: "Give the recording a title." }, 400);
    const category = clean(body.category, 80) || "Team Training";
    const path = clean(body.path, 300);
    const filename = clean(body.filename, 200);
    const notes = clean(body.notes, 2000);
    const text = clean(body.text, 200000);          // transcript or document text

    // Which baseshop is this for? Default to the uploader's own. Choosing the
    // hierarchy root publishes it to every baseshop.
    let base = norm(body.base) || me?.baseshop || root;
    if (base !== root && bases.indexOf(base) < 0 && !isOps) base = me?.baseshop || root;
    const wholeHierarchy = (base === root);

    const by = me ? me.name : "Operations";
    const byCode = me ? me.code : "OPS";
    const media = VIDEO.test(filename) ? "video" : (AUDIO.test(filename) ? "audio" : (TEXTY.test(filename) ? "text" : (filename ? "file" : "none")));

    const ins = await fetch(`${SUPA}/rest/v1/resources`, {
      method: "POST", headers: { ...DBH, Prefer: "return=representation" },
      body: JSON.stringify({
        kind: "training", title, category, body: notes,
        data: { path, filename, media, base, whole_hierarchy: wholeHierarchy, has_text: !!text },
        created_by: byCode, created_by_name: by,
      }),
    });
    const saved = ((await ins.json()) || [])[0];
    if (!saved) return json({ ok: false, error: "Could not save the recording." }, 500);

    const where = wholeHierarchy ? "the whole " + root + " hierarchy" : base;

    // No text means nothing to learn from — say so plainly instead of implying otherwise.
    if (!text) {
      return json({
        ok: true, resource: saved, learned: false, base, whole_hierarchy: wholeHierarchy,
        note: (media === "video" || media === "audio")
          ? "Uploaded to " + where + ". To also teach the assistant, add the transcript — paste it, attach a .txt/.vtt/.srt, or pull it from Fathom."
          : "Uploaded to " + where + ". Add notes or a transcript for the assistant to learn from it.",
      });
    }

    const sys = "You are indexing an internal training for a life-insurance agency so an assistant can answer agents' questions from it later.\n" +
      "Return EXACTLY two sections and nothing else:\n" +
      "SUMMARY: two or three sentences on what this training teaches and who should use it.\n" +
      "POINTS: 5-12 bullet lines, each a specific, usable teaching point, objection handle, script line or step. Keep the trainer's own wording where it is worth keeping.\n" +
      "Do not invent anything that is not in the material. If it is thin, return fewer points.";
    const r = await callClaude(sys, `TRAINING: ${title}\nCATEGORY: ${category}\n\n${text.slice(0, 60000)}`, 1200);

    let summary = "", points = "";
    if (r.txt) {
      const m = r.txt.split(/POINTS:/i);
      summary = clean(m[0].replace(/^SUMMARY:\s*/i, "").trim(), 1200);
      points = clean((m[1] || "").trim(), 6000);
    }

    const kr = await fetch(`${SUPA}/rest/v1/brain_knowledge`, {
      method: "POST", headers: { ...DBH, Prefer: "return=representation" },
      body: JSON.stringify({
        source_type: "training", source_id: saved.id, title,
        // the distilled points are what gets searched and quoted; the raw text is
        // kept behind them so nothing is lost if the distillation was thin
        content: (points ? points + "\n\n" : "") + text.slice(0, 40000),
        summary: summary || notes || null,
        tags: [category.toLowerCase()],
        scope: wholeHierarchy ? "company" : "baseshop",
        scope_key: wholeHierarchy ? null : base,
        created_by: byCode, created_by_name: by,
      }),
    });
    const know = ((await kr.json()) || [])[0];

    return json({
      ok: true, resource: saved, learned: !!know, base, whole_hierarchy: wholeHierarchy,
      knowledge_id: know ? know.id : null,
      summary: summary || null,
      distilled: !!r.txt,
      note: r.txt
        ? "Uploaded to " + where + ", and the assistant has learned it — it can answer from this now."
        : "Uploaded to " + where + ". The text was saved for the assistant, but it could not be distilled just now (" + (r.err || "") + ").",
    });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
