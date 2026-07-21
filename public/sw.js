// Minimal service worker: caches the static app shell so the app installs and opens
// instantly, but never touches anything real-time (API calls, Socket.IO, WebRTC/LiveKit).
// Bump CACHE_NAME whenever you change any cached file so clients pick up the new version.
const CACHE_NAME = "housie-shell-v1";

const APP_SHELL = [
  "/index.html",
  "/dashboard.html",
  "/room.html",
  "/css/style.css",
  "/js/api.js",
  "/js/room.js",
  "/js/pwa.js",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function shouldBypass(url) {
  // Never cache or intercept anything real-time or dynamic: the REST API, Socket.IO's
  // handshake/polling requests, and any cross-origin request (e.g. the LiveKit CDN script,
  // STUN/TURN, or a LiveKit media server) — let the browser handle those natively.
  return (
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/socket.io/")
  );
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (shouldBypass(url)) return; // let the network handle it, untouched

  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached); // offline — fall back to whatever we had cached, if anything

      // Cache-first for instant loads, but refresh the cache in the background so the
      // shell doesn't go stale forever.
      return cached || network;
    })
  );
});
