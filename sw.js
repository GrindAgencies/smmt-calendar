// The Standard — minimal service worker.
// The app updates frequently and pulls LIVE data from Supabase, so we deliberately
// do NOT cache anything — every request goes to the network. A registered SW with a
// fetch handler still satisfies the "Add to Home Screen" install criteria; content
// simply stays always-fresh. (If offline support is wanted later, add scoped caching
// here that EXCLUDES supabase.co and the .html shell.)
self.addEventListener('install', function(){ self.skipWaiting(); });
self.addEventListener('activate', function(e){ e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function(){ /* network passthrough — no caching */ });
