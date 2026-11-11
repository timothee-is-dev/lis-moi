// Lis-moi : met toute l'appli en cache pour qu'elle marche sans réseau.
// Après une modification de l'appli, augmenter VERSION pour forcer la mise à jour.
const VERSION = "lis-moi-v9";
// la voix naturelle (82 Mo) a son propre cache, installé à la demande et gardé d'une version à l'autre
const VOIX = "lis-moi-voix";
const FILES = [
  "./",
  "index.html",
  "ocr.js",
  "phrases.js",
  "voix.js",
  "manifest.webmanifest",
  "icon-192.png",
  "icon-512.png",
  "vendor/opencv/opencv.js",
  "vendor/ort/ort.wasm.min.js",
  "vendor/ort/ort-wasm-simd-threaded.js",
  "vendor/ort/ort-wasm-simd-threaded.wasm",
  "vendor/models/det.onnx",
  "vendor/models/cls.onnx",
  "vendor/models/rec_latin.onnx",
  "vendor/models/latin_dict.txt"
];

async function tell(type){
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  clients.forEach(c => c.postMessage({ type }));
}

async function allCached(){
  const cache = await caches.open(VERSION);
  for (const f of FILES){ if (!(await cache.match(f))) return false; }
  return true;
}

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(VERSION)
      .then(c => c.addAll(FILES))
      .then(() => self.skipWaiting())
      .catch(err => { tell("cache-error"); throw err; })
  );
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== VERSION && k !== VOIX).map(k => caches.delete(k)));
    await self.clients.claim();
    if (await allCached()) tell("cached");
  })());
});

self.addEventListener("message", async e => {
  if (e.data && e.data.type === "check"){
    const ok = await allCached();
    e.source && e.source.postMessage({ type: ok ? "cached" : "cache-error" });
  }
});

// La page doit être "isolée" (calcul sur plusieurs cœurs, et sinon le navigateur refuse de lancer le
// moteur de la voix). On ajoute donc nous-mêmes les en-têtes à tout ce qu'on sert, y compris depuis le cache.
function isolated(res){
  if (!res || res.type === "opaque" || res.status === 0) return res;
  const h = new Headers(res.headers);
  h.set("Cross-Origin-Embedder-Policy", "require-corp");
  h.set("Cross-Origin-Opener-Policy", "same-origin");
  h.set("Cross-Origin-Resource-Policy", "same-origin");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

// Cache d'abord, réseau ensuite (et on garde une copie de ce qui vient du réseau)
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await caches.match(e.request, { ignoreSearch: true });   // appli ou voix
    if (hit) return isolated(hit);
    try {
      const res = await fetch(e.request);
      const u = new URL(e.request.url);
      // les fichiers de la voix ne vont dans le cache que via le bouton "Installer"
      if (res.ok && u.origin === location.origin && !/\/vendor\/(voix|piper)\/|voix-worker\.js/.test(u.pathname)) cache.put(e.request, res.clone());
      return u.origin === location.origin ? isolated(res) : res;
    } catch (err) {
      if (e.request.mode === "navigate") return isolated(await cache.match("index.html"));
      throw err;
    }
  })());
});
