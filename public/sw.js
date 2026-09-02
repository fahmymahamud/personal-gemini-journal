// Exists so the browser will offer to install the app: Chrome needs a service
// worker with a fetch handler before it fires beforeinstallprompt.
//
// Deliberately network-first and shell-only. A cache-first worker would keep
// serving yesterday's app.js after a Cloud Run deploy, so only the HTML shell
// is ever stored, and only as a fallback for when the network is gone. Every
// script, stylesheet and API call goes straight to the network, always.
const SHELL = 'remindclient-shell-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== SHELL).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;   // assets are never intercepted

  event.respondWith((async () => {
    try {
      const response = await fetch(event.request);
      // Keyed by the request, not by '/': the app and /admin are different
      // shells, and collapsing them would serve one in place of the other.
      const copy = response.clone();
      caches.open(SHELL).then((cache) => cache.put(event.request, copy)).catch(() => {});
      return response;
    } catch {
      const cached = await caches.match(event.request);
      if (cached) return cached;
      throw new Error('offline and no cached shell');
    }
  })());
});
