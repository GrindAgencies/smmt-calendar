// hub-files v2 (2026-10-20) — photos, videos and documents in a conversation.
//
// v2 FIXES A DENY-EVERYTHING BUG CAUGHT IN TESTING. v1 asked hub-api "which channels may this
// code see?" with only the code. hub-api requires a SESSION — a typed code has not been proof of
// identity anywhere on this platform since 2026-09-30 — so it answered needs_session, the channel
// list came back empty, and mayUse() returned false for every channel. DMs still worked, because
// those are checked here from the pair itself, so the failure would have presented as
// "attachments work in direct messages but silently refuse in every group" — a confusing thing
// to debug weeks later. The caller's own session is now forwarded, so hub-api resolves the same
// person and answers properly.
//
// ROUND TWO task 8, which Elijah called the important one.
//
// WHY THIS IS NOT DONE THE WAY PROFILE PHOTOS ARE. Avatars and the home carousel are stored as
// data URLs on a row, and that is fine for a resized 300KB portrait. A phone video is tens of
// megabytes; putting one in a database row would bloat every query that touches the message and
// hand the whole file to anyone loading the conversation. So attachments live in Supabase
// Storage, in a PRIVATE bucket, and the message row keeps only small metadata.
//
// NOTHING IS READABLE BY A PLAIN URL. The bucket is private and carries no RLS policy for anon
// or authenticated, so those roles can read and write nothing in it; only this function, holding
// service_role, can. Every upload and every view is checked against the SAME channel access rule
// the chat itself uses — hub-api's hub_channels for a channel, both sides of the pair for a DM —
// rather than a second rule invented here that could drift from it. Views are short-lived signed
// links, so a URL that leaks stops working rather than remaining an open door to a private chat.
//
// The brief is explicit on this point: do not publish private chat uploads at unrestricted public
// URLs merely to make previews convenient.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const norm = (c: unknown) => (c ?? "").toString().trim().toUpperCase();
const low = (s: unknown) => (s ?? "").toString().trim().toLowerCase();
const enc = encodeURIComponent;

const BUCKET = "hub-attachments";
const MAX_BYTES = 52428800;              // 50MB, the same ceiling the bucket itself enforces
const VIEW_SECONDS = 60 * 60;            // a view link lives an hour, not for ever

/* What a phone actually produces, plus the documents people send. Checked here AND by the
   bucket, so a client that lies about its type still cannot store something else. */
const ALLOWED: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp",
  "image/heic": "heic", "image/heif": "heif",
  "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm",
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "text/plain": "txt", "text/csv": "csv",
};

async function getJSON(path: string) { try { const r = await fetch(`${SUPA}/rest/v1/${path}`, { headers: DBH }); return (await r.json()) || []; } catch (_) { return []; } }
async function rpc(fn: string, args: Record<string, unknown>) { try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); return await r.json(); } catch (_) { return null; } }

async function whoIs(body: any): Promise<string> {
  const t = String(body.token ?? "").trim();
  if (t) { const r = await rpc("ops_authorize", { p_token: t }); if (r && r.ok) return norm(body.code) || norm(r.code); }
  const s = String(body.session ?? "").trim().slice(0, 120);
  if (!s) return "";
  const got = await rpc("agent_session_code", { p_token: s });
  return (typeof got === "string") ? norm(got) : "";
}

/* THE one access rule, borrowed rather than rebuilt. A DM is readable by its two participants;
   a channel by whoever hub-api says may see it. If that answer ever changes, attachments follow
   it automatically, which is the entire point of not writing a second copy here. */
async function mayUse(code: string, channel: string, session: string, opsToken: string): Promise<boolean> {
  if (!code || !channel) return false;
  if (channel.startsWith("dm:")) {
    const parts = channel.slice(3).split("|").map(norm).filter(Boolean);
    return parts.indexOf(code) >= 0;
  }
  try {
    /* Forward the caller's OWN credential. hub-api identifies people by session, never by a
       typed code, so without this it answers needs_session and every channel is refused. */
    const payload: Record<string, unknown> = { action: "hub_channels", code };
    if (session) payload.session = session;
    if (opsToken) payload.token = opsToken;
    const r = await fetch(`${SUPA}/functions/v1/hub-api`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}`, apikey: KEY },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    const list = (j && Array.isArray(j.channels)) ? j.channels : [];
    return list.some((c: any) => String(c && c.id) === channel);
  } catch (_) { return false; }
}

/* Storage paths are built here, never accepted from the caller: a client-supplied path is how
   one conversation's upload ends up readable from another, or escapes the bucket entirely. */
function safeName(n: unknown) {
  return (n ?? "file").toString().trim().replace(/[^A-Za-z0-9._ -]/g, "").slice(0, 80) || "file";
}
function pathFor(channel: string, mime: string) {
  const ext = ALLOWED[low(mime)] || "bin";
  const key = channel.replace(/[^A-Za-z0-9_.|:-]/g, "_");
  const rand = crypto.randomUUID();
  return `${key}/${rand}.${ext}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: any = {}; try { body = req.method === "POST" ? await req.json() : {}; } catch (_) { body = {}; }

  const me = await whoIs(body);
  if (!me) return json({ ok: false, needs_session: true, error: "Please sign in again." }, 401);

  const action = String(body.action || "");
  const channel = String(body.channel ?? "").trim();

  /* ---- what the client is allowed to send, so the UI can say so before a 50MB upload ---- */
  if (action === "limits") {
    return json({ ok: true, max_bytes: MAX_BYTES, max_mb: Math.round(MAX_BYTES / 1048576), types: Object.keys(ALLOWED) });
  }

  if (!channel) return json({ ok: false, error: "Which conversation?" }, 400);
  const sessTok = String(body.session ?? "").trim().slice(0, 120);
  const opsTok  = String(body.token ?? "").trim();
  if (!(await mayUse(me, channel, sessTok, opsTok))) {
    return json({ ok: false, error: "You are not in that conversation." }, 403);
  }

  /* ---------------------------------------------------- a place to upload to ---- */
  if (action === "sign_upload") {
    const mime = low(body.mime);
    const size = Number(body.size) || 0;
    const name = safeName(body.name);
    if (!ALLOWED[mime]) {
      return json({ ok: false, error: "That kind of file cannot be sent here.", mime }, 400);
    }
    if (size <= 0 || size > MAX_BYTES) {
      return json({ ok: false, error: `Files can be up to ${Math.round(MAX_BYTES / 1048576)}MB. That one is ${(size / 1048576).toFixed(1)}MB.` }, 400);
    }
    const path = pathFor(channel, mime);
    const r = await fetch(`${SUPA}/storage/v1/object/upload/sign/${BUCKET}/${path}`, {
      method: "POST", headers: { Authorization: `Bearer ${KEY}`, apikey: KEY, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || !j.url) {
      return json({ ok: false, error: "Could not start that upload.", detail: String(j && j.message || r.status).slice(0, 160) }, 502);
    }
    /* The signed URL is relative to the storage host; hand back something usable as-is. */
    const url = String(j.url).startsWith("http") ? String(j.url) : `${SUPA}/storage/v1${String(j.url)}`;
    return json({ ok: true, upload_url: url, path, name, mime, size, bucket: BUCKET });
  }

  /* ------------------------------------------------- a short-lived way to view ---- */
  if (action === "sign_view") {
    const path = String(body.path ?? "").trim();
    if (!path) return json({ ok: false, error: "Which file?" }, 400);
    /* The path must belong to the channel the caller just proved they are in - otherwise a
       member of one conversation could sign a file out of another by guessing its path. */
    const key = channel.replace(/[^A-Za-z0-9_.|:-]/g, "_");
    if (!path.startsWith(key + "/") || path.indexOf("..") >= 0) {
      return json({ ok: false, error: "That file is not part of this conversation." }, 403);
    }
    const r = await fetch(`${SUPA}/storage/v1/object/sign/${BUCKET}/${path}`, {
      method: "POST", headers: { Authorization: `Bearer ${KEY}`, apikey: KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ expiresIn: VIEW_SECONDS }),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || !j.signedURL) {
      return json({ ok: false, error: "That file is no longer available." }, 404);
    }
    const url = String(j.signedURL).startsWith("http") ? String(j.signedURL) : `${SUPA}/storage/v1${String(j.signedURL)}`;
    return json({ ok: true, url, expires_in: VIEW_SECONDS });
  }

  /* ------------------------------------------------- tidy up an abandoned upload ---- */
  /* A file whose message was never sent is rubbish, and the brief asks that abandoned uploads
     be cleaned up without touching one that was successfully sent. The client calls this when
     the composer's draft attachment is removed. */
  if (action === "discard") {
    const path = String(body.path ?? "").trim();
    const key = channel.replace(/[^A-Za-z0-9_.|:-]/g, "_");
    if (!path || !path.startsWith(key + "/")) return json({ ok: false, error: "Not yours to remove." }, 403);
    const used = await getJSON(`hub_messages?channel=eq.${enc(channel)}&select=id,attach&attach=not.is.null&limit=500`);
    const stillUsed = used.some((m: any) => JSON.stringify(m.attach || "").indexOf(path) >= 0);
    if (stillUsed) return json({ ok: false, error: "That file is attached to a message." }, 409);
    await fetch(`${SUPA}/storage/v1/object/${BUCKET}/${path}`, { method: "DELETE", headers: { Authorization: `Bearer ${KEY}`, apikey: KEY } }).catch(() => {});
    return json({ ok: true, discarded: path });
  }

  return json({ ok: false, error: "unknown action" }, 400);
});
