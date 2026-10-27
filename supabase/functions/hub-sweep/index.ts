// hub-sweep v2 (2026-10-20) — removes chat attachments that nothing points at any more.
//
// FOUND BY TESTING TASK 8 RATHER THAN READING IT. hub-files has a `discard` action, but it only
// runs when somebody clicks the × on a composer draft. Pick a file and then close the tab,
// reload, lose signal, or let the phone kill the page, and the file is already sitting in the
// bucket with nothing left that will ever remove it. I produced one by accident while testing
// and it was still there. Worse: hub_deletechannel deletes a channel's MESSAGES but never its
// files, so deleting a channel silently stranded every photo ever sent to it.
//
// Both leave paid storage holding data nobody can even reach — hub-files' sign_view refuses any
// path outside a channel the caller is in, and a deleted channel is a channel nobody is in. So
// these are not a privacy hole; they are rubbish that accumulates for ever and that no screen
// will ever show anyone.
//
// ONE RULE COVERS BOTH: a file that no surviving message points at, past a grace period, is
// rubbish. The grace period is what makes it safe — it is far longer than any upload takes, so
// a file sitting in somebody's composer draft right now is never swept out from under them.
//
// This also means an attachment never outlives its message: hub-msg-retention-14day deletes
// messages after 14 days, that un-references their files, and the next sweep removes them.
// That is deliberate, and it is the same promise the chat already makes about its history.
//
// v2: the one-hour floor on the grace period now applies only when actually deleting. A dry run
// may ask "what is unreferenced RIGHT NOW" with grace_hours:0, which is the only way to see the
// detection working without waiting an hour for a test file to age. A dry run removes nothing,
// so there is no risk in letting it look.
//
// Kept separate from hub-files on purpose. hub-files is on the request path for every upload and
// every image view; a housekeeping job that walks the whole bucket has no business living there.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const SH = { Authorization: `Bearer ${KEY}`, apikey: KEY, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const BUCKET = "hub-attachments";
const DEFAULT_GRACE_HOURS = 24;
const MIN_GRACE_WHEN_DELETING = 1;

async function getJSON(path: string) {
  try { const r = await fetch(`${SUPA}/rest/v1/${path}`, { headers: DBH }); return (await r.json()) || []; } catch (_) { return []; }
}
async function rpc(fn: string, args: Record<string, unknown>) {
  try { const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: DBH, body: JSON.stringify(args) }); return await r.json(); } catch (_) { return null; }
}

/* The storage list API returns one level at a time and pages at 100. Folders come back with a
   null id, which is how a directory is told from a file. */
async function listPrefix(prefix: string) {
  const out: any[] = [];
  for (let offset = 0; offset <= 5000; offset += 100) {
    const r = await fetch(`${SUPA}/storage/v1/object/list/${BUCKET}`, {
      method: "POST", headers: SH,
      body: JSON.stringify({ prefix, limit: 100, offset, sortBy: { column: "name", order: "asc" } }),
    });
    const page = await r.json().catch(() => []);
    if (!Array.isArray(page) || !page.length) break;
    out.push(...page);
    if (page.length < 100) break;
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: any = {}; try { body = req.method === "POST" ? await req.json() : {}; } catch (_) { body = {}; }

  /* Operations or the scheduled job, never an agent session. Nothing here is per-person. */
  const auth = await rpc("ops_authorize", { p_token: String(body.token ?? "").trim() });
  if (!auth || !auth.ok) return json({ ok: false, error: "unauthorized" }, 403);

  const apply = body.apply !== false;                       // apply:false gives a dry run
  const asked = Number(body.grace_hours);
  const graceHours = Number.isFinite(asked)
    ? Math.max(apply ? MIN_GRACE_WHEN_DELETING : 0, asked)
    : DEFAULT_GRACE_HOURS;
  const cutoff = Date.now() - graceHours * 3600_000;

  /* Every path any surviving message still points at. Matched as text rather than by reaching
     into the attach shape, so a future change to that shape cannot quietly turn a live file
     into an orphan and delete it. */
  /* 2026-10-26: read EVERY page. The API answers at most 1,000 rows per request, so past 1,000
     attachments a single read would have left newer live files out of `referenced` -- and this
     function deletes what is not referenced. And a read that FAILS must stop the sweep: an empty
     list here means "delete everything past the grace period". */
  const msgs: any[] = [];
  let readFailed = false;
  for (let off = 0; off < 200000; off += 1000) {
    let page: unknown = null;
    try {
      const r = await fetch(`${SUPA}/rest/v1/hub_messages?select=id,attach&attach=not.is.null&order=id.asc&limit=1000&offset=${off}`, { headers: DBH });
      page = r.ok ? await r.json() : null;
    } catch (_) { page = null; }
    if (!Array.isArray(page)) { readFailed = true; break; }
    msgs.push(...page);
    if (page.length < 1000) break;
  }
  if (readFailed) return json({ ok: false, error: "Could not read which files are still in use, so nothing was deleted." }, 503);
  const referenced = msgs.map((m: any) => JSON.stringify(m.attach ?? "")).join("\n");

  const folders = (await listPrefix("")).filter((e: any) => e && e.name && !e.id);
  const orphans: { path: string; size: number; age_h: number }[] = [];
  let scanned = 0, keptInGrace = 0, keptReferenced = 0;

  for (const f of folders) {
    for (const it of await listPrefix(`${f.name}/`)) {
      if (!it || !it.id || !it.name) continue;
      scanned++;
      const path = `${f.name}/${it.name}`;
      const made = Date.parse(it.created_at || it.updated_at || "") || 0;
      if (made && made > cutoff) { keptInGrace++; continue; }      // still inside the grace period
      if (referenced.indexOf(path) >= 0) { keptReferenced++; continue; }
      orphans.push({ path, size: Number(it?.metadata?.size) || 0, age_h: made ? Math.round((Date.now() - made) / 3600_000) : -1 });
    }
  }

  let removed = 0;
  if (apply && orphans.length) {
    for (let i = 0; i < orphans.length; i += 50) {
      const batch = orphans.slice(i, i + 50).map((o) => o.path);
      const d = await fetch(`${SUPA}/storage/v1/object/${BUCKET}`, {
        method: "DELETE", headers: SH, body: JSON.stringify({ prefixes: batch }),
      });
      if (d.ok) removed += batch.length;
    }
  }

  return json({
    ok: true, applied: apply, scanned,
    kept: keptInGrace + keptReferenced,
    kept_in_grace: keptInGrace, kept_referenced: keptReferenced,
    orphans: orphans.length, removed,
    bytes_freed: orphans.reduce((a, o) => a + o.size, 0),
    grace_hours: graceHours,
    sample: orphans.slice(0, 20),
  });
});
