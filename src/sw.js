"use strict";

const APP_SHELL_CACHE = "woodwire-app-shell-v2";
const FALLBACK_PAGE = "./index.html";
const APP_SHELL_ASSETS = [
  "./",
  FALLBACK_PAGE,
  "./manifest.json",
  "./assets/favicon.svg",
  "./assets/icon-192.png",
  "./assets/icon-512.png",
  "./assets/styles.css",
  "./scripts/app.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(APP_SHELL_CACHE).then((cache) => cache.addAll(APP_SHELL_ASSETS)),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== APP_SHELL_CACHE)
          .map((key) => caches.delete(key)),
      ),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== "GET") {
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    return;
  }

  if (url.origin !== self.location.origin) {
    return;
  }

  // Navigations go to the network first so they pass through Cloudflare Access,
  // which renews (or prompts for) the session. Access login redirects are
  // returned as-is and never cached; the cached shell is only an offline fallback.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((networkResponse) => cacheSuccessfulResponse(request, networkResponse))
        .catch(() =>
          caches
            .match(request)
            .then((cachedResponse) => cachedResponse || caches.match(FALLBACK_PAGE)),
        ),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }

      return fetch(request)
        .then((networkResponse) => cacheSuccessfulResponse(request, networkResponse))
        .catch(() => {
          throw new Error("Network request failed");
        });
    }),
  );
});

function cacheSuccessfulResponse(request, networkResponse) {
  if (networkResponse.ok) {
    const responseClone = networkResponse.clone();
    void caches
      .open(APP_SHELL_CACHE)
      .then((cache) => cache.put(request, responseClone))
      .catch(() => {
        // Ignore best-effort cache write failures.
      });
  }

  return networkResponse;
}
