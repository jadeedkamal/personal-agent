const CACHE = 'agent-shell-v9';
const SHELL = ['/', '/styles.css', '/app.js', '/vendor/marked.js', '/manifest.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
    // Tell any already-open tabs to reload so they pick up the new shell immediately,
    // instead of silently continuing to run whatever version they loaded with.
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const client of clients) client.postMessage({ type: 'sw-updated' });
  })());
});

// Network-first for the app shell: always try to fetch the latest version first, and only
// fall back to the cached copy when offline. This is what actually prevents staleness —
// bumping CACHE alone doesn't help if fetch() keeps serving old cached files forever.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/')) return; // never cache/intercept API calls
  if (e.request.method !== 'GET') return;

  e.respondWith((async () => {
    try {
      const fresh = await fetch(e.request);
      if (fresh && fresh.ok) {
        const cache = await caches.open(CACHE);
        cache.put(e.request, fresh.clone());
      }
      return fresh;
    } catch {
      const cached = await caches.match(e.request);
      if (cached) return cached;
      throw new Error('offline and no cached copy');
    }
  })());
});

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data.json(); } catch {}
  const title = data.title || 'Personal Agent';
  e.waitUntil(self.registration.showNotification(title, {
    body: data.body || 'Response ready',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: data.conversationId || 'personal-agent',
    data: { conversationId: data.conversationId },
  }));
});

// Focus an already-open tab and tell it which conversation to switch to, rather than always
// opening a fresh window on top of one the user may already have sitting in the background.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const conversationId = e.notification.data && e.notification.data.conversationId;
  e.waitUntil((async () => {
    const clientsArr = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientsArr) {
      if ('focus' in client) {
        client.postMessage({ type: 'open-conversation', conversationId });
        return client.focus();
      }
    }
    if (self.clients.openWindow) {
      return self.clients.openWindow(conversationId ? `/?c=${encodeURIComponent(conversationId)}` : '/');
    }
  })());
});
