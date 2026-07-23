// Minimal service worker — its only job is to make the app installable as a
// PWA. There is deliberately NO offline caching: the app is Supabase-backed and
// always needs the network, so every request passes straight through. Having a
// registered fetch handler is what lets browsers offer "Install app".
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* network passthrough — no respondWith */ });
