// Deliberately inert. Chrome requires a service worker with a fetch handler
// for the Android install prompt; caching nothing avoids stale-asset debugging
// in a tool that live-reloads from an SSE stream (/api/events).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* pass-through, caches nothing */ });
