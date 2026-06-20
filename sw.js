// ATLAS GYM Service Worker
// Estrategia: NETWORK-FIRST para el codigo de la app (html/js/css) para que
// las actualizaciones SIEMPRE lleguen. Cache solo como respaldo offline.
// NUNCA intercepta Firebase / CDNs (otro origen): van directo a la red.
const CACHE_NAME = 'atlas-gym-v5';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './firebase-config.js',
  './manifest.json'
];

// Instalar: precachear el shell y activar de inmediato
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).catch(() => {})
  );
});

// Activar: borrar caches viejos y tomar control de todas las pestañas
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Solo GET y solo mismo origen. Firebase/gstatic/cdn -> red directa (sin tocar).
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.origin !== self.location.origin) return;

  // Network-first: intenta red, guarda copia fresca, cae a cache si no hay red.
  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() =>
        caches.match(req).then((cached) => cached || caches.match('./index.html'))
      )
  );
});

// Permitir que la pagina pida activar el SW nuevo sin esperar
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
