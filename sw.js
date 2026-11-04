/* Service worker: кэширует оболочку приложения, чтобы оно открывалось как установленная программа */
const CACHE = "lira-v1";
const SHELL = ["./", "index.html", "style.css", "app.js", "nlu.js", "data/dataset.js", "data/model.js", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png"];
self.addEventListener("install", (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener("activate", (e) => e.waitUntil(
  caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin || u.pathname.startsWith("/api/") || e.request.method !== "GET") return;
  // Сначала сеть (свежие файлы), при её отсутствии — кэш
  e.respondWith(fetch(e.request).then((r) => {
    const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r;
  }).catch(() => caches.match(e.request)));
});
