// a4-sw.js
const VERSION       = 'v6';
const PRECACHE      = `precache-${VERSION}`;
const RUNTIME       = `runtime-${VERSION}`;
const MEDIA_CACHE   = `media-${VERSION}`;
const IMAGE_CACHE   = `images-${VERSION}`;
const API_CACHE     = `api-${VERSION}`;
const POST_QUEUE    = 'post-queue';
const BG_SYNC_TAG   = 'post-queue-sync';
const FALLBACK_HTML = '/a4-media-optimizer/offline.html';

// Assets to precache
const PRECACHE_URLS = [
  FALLBACK_HTML,
  '/a4-media-optimizer/a4-sw.js',
  '/a4-media-optimizer/your-userscript.user.js'
];

// Max entries per cache
const MAX_ENTRIES = {
  [IMAGE_CACHE]: 100,
  [API_CACHE]:  50,
  [MEDIA_CACHE]: 30
};

// INSTALL
self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(PRECACHE)
      .then(c => c.addAll(PRECACHE_URLS))
  );
});

// ACTIVATE
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => ![PRECACHE, RUNTIME, MEDIA_CACHE, IMAGE_CACHE, API_CACHE].includes(k))
          .map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// UTILITY: trim old entries
async function trimCache(name, max) {
  const cache = await caches.open(name);
  const keys  = await cache.keys();
  if (keys.length > max) {
    await cache.delete(keys[0]);
    await trimCache(name, max);
  }
}

// FETCH
self.addEventListener('fetch', event => {
  const {request} = event;
  const url = new URL(request.url);

  // ignore chrome-extension or devtools calls
  if (url.protocol.startsWith('chrome')) return;

  // NAVIGATION: network-first -> cache fallback
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(resp => {
          caches.open(RUNTIME).then(cache => cache.put(request, resp.clone()));
          return resp;
        })
        .catch(() => caches.match(FALLBACK_HTML))
    );
    return;
  }

  // API/json: network-first, stale-while-revalidate
  if (url.pathname.startsWith('/api/') || request.headers.get('Accept')?.includes('application/json')) {
    event.respondWith(
      caches.open(API_CACHE).then(cache =>
        fetch(request)
          .then(resp => {
            cache.put(request, resp.clone());
            trimCache(API_CACHE, MAX_ENTRIES[API_CACHE]);
            return resp;
          })
          .catch(() => cache.match(request))
      )
    );
    return;
  }

  // IMAGES: stale-while-revalidate
  if (request.destination === 'image' || /\.(png|jpe?g|gif|svg|webp)$/.test(url.pathname)) {
    event.respondWith(
      caches.open(IMAGE_CACHE).then(cache =>
        cache.match(request).then(cached => {
          const network = fetch(request).then(resp => {
            cache.put(request, resp.clone());
            trimCache(IMAGE_CACHE, MAX_ENTRIES[IMAGE_CACHE]);
            return resp;
          });
          return cached || network;
        })
      )
    );
    return;
  }

  // MEDIA: cache-first (including range requests)
  if (request.destination === 'video' || /\.(mp4|webm|ogg)$/.test(url.pathname)) {
    event.respondWith(
      caches.open(MEDIA_CACHE).then(cache =>
        cache.match(request).then(cached => {
          if (cached) return cached;
          return fetch(request).then(resp => {
            cache.put(request, resp.clone());
            trimCache(MEDIA_CACHE, MAX_ENTRIES[MEDIA_CACHE]);
            return resp;
          });
        })
      )
    );
    return;
  }

  // CSS/JS: stale-while-revalidate
  if (request.destination === 'script' || request.destination === 'style' ||
     /\.(js|css)$/.test(url.pathname)) {
    event.respondWith(
      caches.open(RUNTIME).then(cache =>
        cache.match(request).then(cached => {
          const network = fetch(request).then(resp => {
            cache.put(request, resp.clone());
            return resp;
          });
          return cached || network;
        })
      )
    );
    return;
  }

  // Default: go to network
  event.respondWith(fetch(request));
});

// BACKGROUND SYNC: queue failed POSTs
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method === 'POST') {
    event.respondWith(
      fetch(req.clone()).catch(() =>
        req.clone().json().then(body => {
          return getDb().then(db => {
            const tx = db.transaction(POST_QUEUE, 'readwrite');
            tx.objectStore(POST_QUEUE).add({ url: req.url, body });
            return self.registration.sync.register(BG_SYNC_TAG)
              .then(() => new Response(JSON.stringify({queued: true}), {
                headers:{'Content-Type':'application/json'}
              }));
          });
        })
      )
    );
  }
});

self.addEventListener('sync', event => {
  if (event.tag === BG_SYNC_TAG) {
    event.waitUntil(
      getDb().then(db => {
        const tx = db.transaction(POST_QUEUE, 'readwrite');
        const store = tx.objectStore(POST_QUEUE);
        return store.getAll().then(items =>
          Promise.all(items.map(item =>
            fetch(item.url, {
              method: 'POST',
              headers:{'Content-Type':'application/json'},
              body: JSON.stringify(item.body)
            }).then(() => store.delete(item.id))
          ))
        );
      })
    );
  }
});

// IndexedDB helper
function getDb() {
  return new Promise((res, rej) => {
    const openReq = indexedDB.open('a4-sw-db', 1);
    openReq.onupgradeneeded = () => {
      openReq.result.createObjectStore(POST_QUEUE, { keyPath: 'id', autoIncrement: true });
    };
    openReq.onsuccess = () => res(openReq.result);
    openReq.onerror   = () => rej(openReq.error);
  });
}

// PUSH NOTIFICATIONS
self.addEventListener('push', event => {
  const data = event.data?.json() || {};
  const title = data.title || 'Notification';
  const opts  = { body: data.body, icon: data.icon, data: data.url };
  event.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data || '/'));
});

// PERIODIC SYNC (if supported)
self.addEventListener('periodicsync', event => {
  if (event.tag === 'content-sync') {
    event.waitUntil(
      caches.open(API_CACHE).then(cache =>
        fetch('/api/latest').then(resp => cache.put('/api/latest', resp.clone()))
      )
    );
  }
});

// MANUAL PREFETCH via POSTSCRIPT
self.addEventListener('message', event => {
  if (event.data?.type !== 'PREFETCH') return;
  const urls = event.data.urls || [];
  event.waitUntil(
    caches.open(RUNTIME).then(cache =>
      Promise.all(urls.map(u =>
        fetch(u, { mode:'no-cors' })
          .then(r => cache.put(u, r.clone()))
          .catch(()=>{})
      ))
    )
  );
});
