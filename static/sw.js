// Service worker for Wan Mobile.
//   1. Caches the app shell + static assets so repeat visits cost ~no network
//      (and the app loads offline). Bump CACHE_VERSION on each deploy to purge
//      old app-shell assets.
//   2. Caches API data (config, saved list, templates, presets) and image-library
//      files so the app loads fast and images are instant on repeat visits.
//   3. Handles Web Push for "video ready" notifications.

const CACHE_VERSION = "wan-static-v18";
// Persistent caches — NOT deleted when CACHE_VERSION bumps. Content is either
// immutable per URL (media) or freshened by stale-while-revalidate (data).
const MEDIA_CACHE   = "wan-media-v1";
const DATA_CACHE    = "wan-data-v1";

const PRECACHE = [
  "/",
  "/index.html",
  "/app.js",
  "/styles.css",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((c) => c.addAll(PRECACHE))
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  // Only evict OLD static-shell caches. MEDIA_CACHE and DATA_CACHE are kept
  // across deploys — wiping them on every push defeats the purpose.
  const KEEP = new Set([CACHE_VERSION, MEDIA_CACHE, DATA_CACHE]);
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !KEEP.has(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ---- cache helpers ----------------------------------------------------------

// Cache-first: serve from cache immediately; only hit network on a miss.
// Used for immutable content (images, static assets by version URL).
async function cacheFirst(request, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const resp = await fetch(request);
  if (resp && resp.ok) cache.put(request, resp.clone());
  return resp;
}

// Stale-while-revalidate: serve cached copy immediately (fast), then update
// the cache from the network in the background (always fresh on next visit).
async function staleWhileRevalidate(request, cacheName) {
  const cache    = await caches.open(cacheName);
  const cached   = await cache.match(request);
  const fetching = fetch(request)
    .then((resp) => { if (resp && resp.ok) cache.put(request, resp.clone()); return resp; })
    .catch(() => cached);
  return cached || fetching;
}

// ---- fetch handler ----------------------------------------------------------

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // ---- App navigations: network-first, fall back to cached shell. -----------
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() => caches.match("/index.html").then((r) => r || caches.match("/")))
    );
    return;
  }

  // ---- API routes -----------------------------------------------------------
  if (url.origin === location.origin && url.pathname.startsWith("/api/")) {

    // Never intercept Range requests. These are video partial fetches (seeking
    // and cover-thumbnail preload). They're large, we don't want to buffer them
    // in SW storage, and the server already sends immutable Cache-Control so the
    // browser HTTP cache handles them after the first load.
    if (req.headers.get("range")) return;

    // Input-image library files — immutable per URL (path = folder/filename).
    // Cache-first so the library grid is instant on repeat visits.
    if (url.pathname.startsWith("/api/images/file/")) {
      event.respondWith(cacheFirst(req, MEDIA_CACHE));
      return;
    }

    // Small data payloads that gate the UI on open. Stale-while-revalidate:
    // the cached version renders the UI immediately; the fresh version arrives
    // in the background and is served on the next visit.
    const DATA_PATHS = [
      "/api/config",
      "/api/templates",
      "/api/param-presets",
      "/api/last-params",
      "/api/saved",
    ];
    if (DATA_PATHS.includes(url.pathname)) {
      event.respondWith(staleWhileRevalidate(req, DATA_CACHE));
      return;
    }

    // Everything else under /api/ (pods, jobs, videos, balance, metrics…) goes
    // straight to the network — live data, no caching.
    return;
  }

  // ---- Same-origin static assets (app shell) — stale-while-revalidate. -----
  if (url.origin === location.origin) {
    event.respondWith(staleWhileRevalidate(req, CACHE_VERSION));
    return;
  }

  // ---- Google Fonts — cache-first. -----------------------------------------
  if (url.origin === "https://fonts.googleapis.com"
      || url.origin === "https://fonts.gstatic.com") {
    event.respondWith(cacheFirst(req, MEDIA_CACHE));
    return;
  }
});

// ---- push notifications -----------------------------------------------------

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) {}
  const title = data.title || "Wan Mobile";
  const options = {
    body: data.body || "",
    tag: data.tag || "wan-gen",
    renotify: true,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: { url: data.url || "/" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((list) => {
        for (const client of list) {
          if ("focus" in client) {
            client.focus();
            if (client.navigate) client.navigate(url);
            return;
          }
        }
        if (self.clients.openWindow) return self.clients.openWindow(url);
      })
  );
});
