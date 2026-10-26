const CACHE_NAME = "light-reader-shell-v7";
const APP_SHELL = ["/manifest.webmanifest", "/icon-192.png", "/icon-512.png"];

async function cacheAppShell() {
  const cache = await caches.open(CACHE_NAME);
  await cache.addAll(APP_SHELL);
  const response = await fetch("/");
  const html = await response.clone().text();
  await cache.put("/", response);
  const assets = [...html.matchAll(/(?:src|href)=["'](\/_app\/[^"']+)["']/g)].map((match) => match[1]);
  await Promise.all([...new Set(assets)].map((asset) => cache.add(asset)));
}

self.addEventListener("install", (event) => {
  event.waitUntil(cacheAppShell());
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  // Never let an old service worker serve its own update script. The browser
  // must be able to fetch the current worker and refresh install metadata.
  if (url.origin === self.location.origin && url.pathname === "/sw.js") return;
  if (url.origin === self.location.origin && /^\/(?:manifest\.webmanifest|icon-(?:192|512)\.png)$/.test(url.pathname)) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(event.request, response.clone()));
          return response;
        })
        .catch(() => caches.match(event.request)),
    );
    return;
  }
  if (url.origin === self.location.origin && url.pathname.startsWith("/_app/")) {
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
        if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(event.request, response.clone()));
        return response;
      })),
    );
    return;
  }
  if (/^\/(auth|reader3|epub|local-book|uploads|assets)(\/|$)/.test(url.pathname)) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok && url.origin === self.location.origin) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match("/"))),
  );
});
