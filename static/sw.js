// Service worker for Wan Mobile.
//   1. Caches the app shell + static assets so repeat visits cost ~no network
//      (and the app loads offline). Bump CACHE_VERSION on each deploy to purge
//      old assets.
//   2. Handles Web Push so a "video ready" notification arrives even when the
//      browser is minimised or closed.

const CACHE_VERSION = "wan-static-v1";
// Same-origin static assets to precache on install. Media and /api/* are never
// cached here (dynamic + auth + large); the browser HTTP cache + immutable
// Cache-Control on video endpoints handle those.
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
      .catch(() => {}) // a missing asset must not block activation
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// Cache-first with background revalidation (stale-while-revalidate).
async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(request);
  const fetching = fetch(request)
    .then((resp) => {
      if (resp && resp.ok) cache.put(request, resp.clone());
      return resp;
    })
    .catch(() => cached);
  return cached || fetching;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Never intercept API calls or media — they're dynamic, authed, and large.
  if (url.origin === location.origin && url.pathname.startsWith("/api/")) return;

  // App navigations: network-first so a fresh shell wins, fall back to cache
  // offline.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() => caches.match("/index.html").then((r) => r || caches.match("/")))
    );
    return;
  }

  // Same-origin static assets → stale-while-revalidate.
  if (url.origin === location.origin) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  // Google Fonts (CSS + font files) → cache-first to kill repeat CDN fetches.
  if (url.origin === "https://fonts.googleapis.com"
      || url.origin === "https://fonts.gstatic.com") {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }
});

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
