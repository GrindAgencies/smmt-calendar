// The Standard — LIVE-FIRST service worker.
// This platform runs the business in real time, so the golden rule is: NEVER serve a
// stale page and NEVER cache data. We do not keep any cache at all. On every update this
// worker also PURGES any cache a previous version might have created, on every device,
// automatically — so no broker or operations user can get stuck on an old/empty screen.
//
// Behaviour:
//   • POST requests (all Supabase/API calls) -> untouched, straight to the network (live).
//   • Cross-origin requests (Supabase, fonts, etc.) -> untouched (live).
//   • Same-origin page loads (.html shell) -> fetched fresh with cache:'no-store', so a new
//     deploy is picked up immediately and the browser's own disk cache can't pin an old copy.
//   • Same-origin scripts/styles (.js/.css) -> revalidated on every load, because GitHub
//     Pages serves them with max-age=600. That ten minutes is enough for a deploy to go
//     out while every open browser keeps running the previous notif.js — which is exactly
//     what happened on 2026-09-01: the new HTML shipped and the old script kept loading,
//     so the sidebar rail and the dark sidebar silently did not exist for anyone.
// Bump VERSION whenever this file changes so browsers roll the new worker out.
const VERSION = 'tsfg-sw-v3-revalidate-assets';

self.addEventListener('install', function () { self.skipWaiting(); });

self.addEventListener('activate', function (e) {
  e.waitUntil((async function () {
    // wipe every cache bucket (belt-and-suspenders: clears anything any prior worker cached)
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map(function (k) { return caches.delete(k); }));
    } catch (_) { /* no caches / not supported — fine */ }
    await self.clients.claim(); // take control of open tabs right away
  })());
});

self.addEventListener('fetch', function (e) {
  const req = e.request;
  if (req.method !== 'GET') return;                        // never intercept POST/PUT/etc — APIs stay 100% live
  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.origin !== self.location.origin) return;         // never intercept cross-origin (Supabase, CDNs) — live

  // Same-origin page navigations: always pull the freshest shell, bypassing the browser HTTP cache.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req, { cache: 'no-store' }).catch(function () { return fetch(req); })
    );
  }
  // Same-origin scripts and styles: always ask the server whether our copy is current.
  // 'no-cache' still allows a conditional request, so an unchanged file comes back as a
  // cheap 304 rather than a full download — fresh code without the bandwidth of no-store.
  else if (/\.(?:js|css)(?:$|\?)/i.test(url.pathname + url.search)) {
    e.respondWith(
      fetch(req, { cache: 'no-cache' }).catch(function () { return fetch(req); })
    );
  }
  // Everything else same-origin (images, fonts): plain passthrough — no caching.
});
