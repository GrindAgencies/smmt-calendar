// nexus-app — Christopher's Nexus, as an installable app.
// Serves the PWA shell, its manifest, icons and service worker, plus a small JSON API.
// The browser never sees the RPC secret: it carries its own app token (nexus.secrets 'app'),
// and this function does the privileged calls server-side.
//
//   GET  /nexus-app?k=<app token>   first open — stores the token, then reloads clean
//   GET  /nexus-app                 the app
//   GET  /nexus-app?manifest=1      web app manifest
//   GET  /nexus-app?sw=1            service worker
//   GET  /nexus-app?icon=192|512|apple
//   POST /nexus-app?api=<name>      data (Bearer = app token)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { SHELL } from "./shell.ts";
import { ICON_192, ICON_512, ICON_APPLE } from "./icons.ts";

const local = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const BRAIN = `${Deno.env.get("SUPABASE_URL")}/functions/v1/nexus-brain`;

let NX: { url: string; anon: string; rpc: string } | null = null;
async function cfg() {
  if (NX) return NX;
  const { data } = await local.from("nexus_feed_secret").select("name,value").in("name", ["nexus_url", "nexus_anon", "nexus_rpc"]);
  const m = Object.fromEntries((data || []).map((r: any) => [r.name, r.value]));
  NX = { url: m.nexus_url, anon: m.nexus_anon, rpc: m.nexus_rpc };
  return NX;
}
async function rpc(action: string, payload: any) {
  const c = await cfg();
  const r = await fetch(`${c.url}/rest/v1/rpc/nexus_rpc`, { method: "POST", headers: { apikey: c.anon, Authorization: `Bearer ${c.anon}`, "Content-Type": "application/json" }, body: JSON.stringify({ action, payload, secret: c.rpc }) });
  if (!r.ok) throw new Error(`rpc ${action} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return await r.json();
}
async function callFn(name: string, args: any = {}) {
  const c = await cfg();
  const r = await fetch(`${c.url}/rest/v1/rpc/nexus_call`, { method: "POST", headers: { apikey: c.anon, Authorization: `Bearer ${c.anon}`, "Content-Type": "application/json" }, body: JSON.stringify({ fn: name, secret: c.rpc, args }) });
  if (!r.ok) throw new Error(`call ${name} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return await r.json();
}
const sel = (t: string, w?: string, o?: string, l = 100) => rpc("select", { table: t, where: w, order_by: o, limit: l });

let APP_TOKEN = "";
async function appToken() {
  if (APP_TOKEN) return APP_TOKEN;
  const r = await callFn("app_token");
  APP_TOKEN = r?.token || "";
  return APP_TOKEN;
}

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const json = (o: any, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const MANIFEST = {
  name: "Nexus", short_name: "Nexus",
  description: "Christopher's executive operating system",
  start_url: "./nexus-app", scope: "./", id: "nexus-app",
  display: "standalone", orientation: "portrait-primary",
  background_color: "#14110E", theme_color: "#14110E",
  icons: [
    { src: "./nexus-app?icon=192", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "./nexus-app?icon=512", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "./nexus-app?icon=512", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
};

const SW = `
const CACHE = 'nexus-v1';
const SHELL_URLS = ['./nexus-app', './nexus-app?icon=192', './nexus-app?icon=512'];
self.addEventListener('install', function(e){
  e.waitUntil(caches.open(CACHE).then(function(c){ return c.addAll(SHELL_URLS).catch(function(){}); }).then(function(){ return self.skipWaiting(); }));
});
self.addEventListener('activate', function(e){
  e.waitUntil(caches.keys().then(function(ks){
    return Promise.all(ks.filter(function(k){ return k !== CACHE; }).map(function(k){ return caches.delete(k); }));
  }).then(function(){ return self.clients.claim(); }));
});
self.addEventListener('fetch', function(e){
  var u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.searchParams.has('api')) return;         // never cache the API
  e.respondWith(
    fetch(e.request).then(function(r){
      var copy = r.clone();
      caches.open(CACHE).then(function(c){ c.put(e.request, copy); });
      return r;
    }).catch(function(){ return caches.match(e.request); })
  );
});
`;

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // ---------- static (never touches the database, so the app always loads) ----------
  if (url.searchParams.get("manifest")) {
    return new Response(JSON.stringify(MANIFEST), { headers: { "content-type": "application/manifest+json", "cache-control": "public, max-age=3600" } });
  }
  if (url.searchParams.get("sw")) {
    return new Response(SW, { headers: { "content-type": "application/javascript", "cache-control": "no-store" } });
  }
  const ico = url.searchParams.get("icon");
  if (ico) {
    const src = ico === "512" ? ICON_512 : ico === "apple" ? ICON_APPLE : ICON_192;
    return new Response(b64(src), { headers: { "content-type": "image/png", "cache-control": "public, max-age=604800" } });
  }

  // ---------- api ----------
  const api = url.searchParams.get("api");
  if (api) {
    const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const key = bearer || url.searchParams.get("k") || "";
    let tok = "";
    try { tok = await appToken(); } catch (e) { return json({ error: "backend unreachable: " + (e as Error).message.slice(0, 160) }, 502); }
    if (!tok || key !== tok) return json({ error: "unauthorized" }, 401);
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    try {
      if (api === "home") return json(await callFn("app_home"));

      if (api === "chat") {
        const text = String(body.text || "").trim();
        if (!text) return json({ error: "empty" }, 400);
        const c = await cfg();
        const r = await fetch(`${BRAIN}?chat=1`, { method: "POST", headers: { Authorization: `Bearer ${c.rpc}`, "Content-Type": "application/json" }, body: JSON.stringify({ text, channel: "app", chat_id: "app" }) });
        const j = await r.json().catch(() => ({ reply: "Nexus did not answer." }));
        return json({ reply: j.reply || j.error || "no reply" });
      }
      if (api === "history") {
        const rows = await sel("conversations", "chat_id = 'app'", "ts desc", 40);
        return json({ messages: rows.reverse().map((m: any) => ({ role: m.role, content: m.content, ts: m.ts })) });
      }

      if (api === "book") {
        const [people, caps, checks] = await Promise.all([
          sel("v_black_book", undefined, "bucket_sort, name", 400),
          sel("person_capabilities", undefined, undefined, 2000),
          sel("v_name_check", undefined, undefined, 200),
        ]);
        const byp: Record<string, any[]> = {};
        for (const c of caps) (byp[c.person_id] ||= []).push(c);
        for (const p of people) {
          const cs = byp[p.id] || [];
          p.offers_full = cs.filter((c: any) => c.direction === "offers").map((c: any) => c.label);
          p.needs_full = cs.filter((c: any) => c.direction === "needs").map((c: any) => c.label);
        }
        return json({ people, checks });
      }
      if (api === "who") {
        const rows = await callFn("find_people", { q: String(body.need || ""), limit: 12 });
        return json({ results: rows });
      }

      if (api === "plate") {
        const rows = await sel("tasks", "owner = 'Christopher' and status not in ('done','eliminated')", "deadline nulls last, priority_score desc", 400);
        const done = await sel("tasks", "owner = 'Christopher' and status = 'done' and completed_at > now() - interval '2 days'", "completed_at desc", 40);
        return json({ open: rows, done });
      }
      if (api === "task") {
        const id = String(body.id || "").replace(/[^0-9a-f-]/g, "");
        if (!id) return json({ error: "no id" }, 400);
        const act = String(body.action || "done");
        const set: any = act === "done" ? { status: "done", completed_at: new Date().toISOString() }
          : act === "drop" ? { status: "eliminated" }
          : act === "reopen" ? { status: "next", completed_at: null }
          : { deadline: String(body.due || "").slice(0, 10), status: "next" };
        if (act === "move" && !/^\d{4}-\d{2}-\d{2}$/.test(set.deadline)) return json({ error: "bad date" }, 400);
        const r = await rpc("update", { table: "tasks", set, where: `id = '${id}'` });
        return json({ ok: true, rows: r?.rows ?? 0 });
      }
      if (api === "needle") {
        const today = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" })).toISOString().slice(0, 10);
        await rpc("upsert", { table: "daily_needle", on_conflict: "date", rows: [{ date: today, items: body.items || [] }] });
        return json({ ok: true });
      }

      if (api === "notes") {
        const q = String(body.q || "").trim().toLowerCase().replace(/'/g, "''");
        const w = q ? `not archived and lower(coalesce(title,'') || ' ' || body) like '%${q}%'` : "not archived";
        return json({ notes: await sel("notes", w, "pinned desc, updated_at desc", 200) });
      }
      if (api === "note") {
        const row: any = {};
        for (const k of ["title", "body", "entity", "folder"]) if (body[k] !== undefined) row[k] = body[k];
        for (const k of ["pinned", "archived"]) if (body[k] !== undefined) row[k] = !!body[k];
        if (body.id) {
          const id = String(body.id).replace(/[^0-9a-f-]/g, "");
          await rpc("update", { table: "notes", set: row, where: `id = '${id}'` });
          return json({ ok: true, id });
        }
        row.source = "app";
        await rpc("insert", { table: "notes", rows: [row] });
        const back = await sel("notes", "source = 'app'", "created_at desc", 1);
        return json({ ok: true, id: back[0]?.id });
      }

      return json({ error: "unknown api" }, 404);
    } catch (e) {
      return json({ error: (e as Error).message.slice(0, 300) }, 500);
    }
  }

  // ---------- the app ----------
  const base = url.pathname;
  return new Response(SHELL.replaceAll("__BASE__", base), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
});
