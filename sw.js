/* global PAPERPLANE_ASSETS */
importScripts('./precache.js');

const prefix = `paperplane:${self.registration.scope}:`;
const cacheName = `${prefix}${PAPERPLANE_ASSETS.revision}`;
const absolute = path => new URL(path, self.registration.scope).href;
const assets = new Set(PAPERPLANE_ASSETS.paths.map(absolute));
const home = absolute('./index.html');

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName);
    await cache.addAll([...assets].map(url => new Request(url, { cache: 'reload' })));
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith(prefix) && key !== cacheName) await caches.delete(key);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  url.search = '';
  const key = request.mode === 'navigate' && url.href === absolute('./') ? home : url.href;
  if (!assets.has(key)) return;
  event.respondWith((async () => (await (await caches.open(cacheName)).match(key)) ?? fetch(request))());
});
