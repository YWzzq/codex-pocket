const CACHE_NAME = "codex-pocket-shell-v2";
const APP_SHELL = ["/", "/index.html", "/styles.css", "/app.js", "/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/") || url.pathname === "/ws") return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return response;
      })
      .catch(() => caches.match(request).then((response) => response || caches.match("/index.html"))),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const threadId = event.notification.data?.threadId;
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const target = windows.find((client) => "focus" in client);
      if (target) {
        if (threadId) target.postMessage({ type: "open_thread", threadId });
        return target.focus();
      }
      return clients.openWindow(threadId ? `/?thread=${encodeURIComponent(threadId)}` : "/");
    }),
  );
});
