/*
 * Offline support.
 *  - Pages: network first, so a deploy is picked up immediately; the saved copy is used only offline.
 *  - /assets/* (hashed file names) and version-pinned CDN files: cache first, they never change.
 *  - Other files of this site: saved copy first, refreshed in the background.
 */
const SHELL = "pdfedit-shell-v1";
const CDN = "pdfedit-cdn-v1";
const STATIC = [
  "/icon.svg",
  "/theme.js",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      await Promise.allSettled(STATIC.map((url) => cache.add(url)));
      await precacheApp(cache).catch(() => {});
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys())
        if (name.startsWith("pdfedit-") && name !== SHELL && name !== CDN) await caches.delete(name);
      await self.clients.claim();
    })(),
  );
});

/**
 * Saves the page and every build file it leads to (scripts, styles, the engine worker and its wasm) by
 * following the /assets references from the HTML, then forgets files of older builds.
 */
async function precacheApp(cache) {
  const response = await fetch("/", { cache: "no-store" });
  if (!response.ok) return;
  const html = await response.clone().text();
  const seen = new Set();
  const todo = references(html, new URL("/", self.location.origin));
  let complete = true;
  while (todo.length) {
    const path = todo.pop();
    if (seen.has(path)) continue;
    seen.add(path);
    try {
      let file = await cache.match(path, { ignoreVary: true });
      if (!file) {
        file = await fetch(path);
        // a name that only looked like a file
        if (!isUsable(file)) continue;
        await cache.put(path, file.clone());
      }
      if (/\.(js|mjs|css)$/.test(path))
        todo.push(...references(await file.text(), new URL(path, self.location.origin)));
    } catch {
      complete = false;
    }
  }
  // the page is saved last, so the offline copy never points at files we do not have
  if (!complete) return;
  await cache.put("/", response);
  for (const request of await cache.keys()) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/assets/") && !seen.has(path)) await cache.delete(request);
  }
}

function references(text, base) {
  const found = [];
  const pattern = /["'`(=]((?:\/assets\/|assets\/|\.\/)?[\w.-]+-[\w-]{8}\.(?:js|mjs|css|wasm))(?=["'`)?#>\s])/g;
  for (const match of text.matchAll(pattern)) {
    const raw = match[1];
    // a bare name inside a bundled file sits next to it in /assets
    const url = new URL(raw.startsWith("assets/") ? "/" + raw : raw, base);
    if (url.origin === self.location.origin && url.pathname.startsWith("/assets/")) found.push(url.pathname);
  }
  return found;
}

/** a missing asset may be answered with the HTML page: never save that as a script */
function isUsable(response) {
  return response.ok && !(response.headers.get("content-type") || "").includes("text/html");
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || request.headers.has("range")) return;
  const url = new URL(request.url);

  if (url.origin === "https://cdn.jsdelivr.net") {
    // only files pinned to an exact version are safe to keep for good
    if (/@v?\d+\.\d+\.\d+/.test(url.pathname) || /@[0-9a-f]{40}/.test(url.pathname))
      event.respondWith(
        cacheFirst(event, CDN, request.url, () => fetch(request.url, { mode: "cors", credentials: "omit" })),
      );
    return;
  }
  if (url.origin !== self.location.origin || url.pathname === "/sw.js") return;

  if (request.mode === "navigate") event.respondWith(page(event, request));
  else if (url.pathname.startsWith("/assets/"))
    event.respondWith(cacheFirst(event, SHELL, request, () => fetch(request)));
  else event.respondWith(staleWhileRevalidate(event, request));
});

async function page(event, request) {
  const cache = await caches.open(SHELL);
  try {
    const response = await fetch(request);
    if (response.ok && new URL(request.url).pathname === "/") {
      const fresh = response.clone();
      event.waitUntil(
        (async () => {
          const saved = await cache.match("/", { ignoreVary: true });
          // a new build: fetch its files now so it also works offline
          if (!saved || (await saved.text()) !== (await fresh.text())) await precacheApp(cache);
        })().catch(() => {}),
      );
    }
    return response;
  } catch (error) {
    const saved = await cache.match("/", { ignoreVary: true });
    if (saved) return saved;
    throw error;
  }
}

async function cacheFirst(event, name, key, load) {
  const cache = await caches.open(name);
  const saved = await cache.match(key, { ignoreVary: true });
  if (saved) return saved;
  const response = await load();
  if (isUsable(response)) event.waitUntil(cache.put(key, response.clone()).catch(() => {}));
  return response;
}

async function staleWhileRevalidate(event, request) {
  const cache = await caches.open(SHELL);
  const saved = await cache.match(request, { ignoreVary: true });
  const update = fetch(request).then(async (response) => {
    if (isUsable(response)) await cache.put(request, response.clone());
    return response;
  });
  if (!saved) return update;
  event.waitUntil(update.catch(() => {}));
  return saved;
}
