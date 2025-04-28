const STATIC_CACHE = 'a4-static-v5';
const DYN_CACHE    = 'a4-dynamic-v5';

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(STATIC_CACHE).then(c=>c.addAll([])));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k=>k!==STATIC_CACHE&&k!==DYN_CACHE)
          .map(k=>caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // media caching
  if (req.destination==='video' ||
      url.pathname.match(/\.(mp4|webm|ogg)$/i)) {
    event.respondWith(
      caches.open(DYN_CACHE).then(cache =>
        cache.match(req).then(res =>
          res || fetch(req).then(net => {
            cache.put(req, net.clone());
            return net;
          })
        )
      )
    );
    return;
  }

  // image caching
  if (req.destination==='image' ||
      url.pathname.match(/\.(png|jpe?g|gif|svg)$/i)) {
    event.respondWith(
      caches.match(req).then(res =>
        res || fetch(req).then(net => {
          caches.open(DYN_CACHE).then(c=>c.put(req, net.clone()));
          return net;
        })
      )
    );
    return;
  }

  // everything else: passthrough
});

self.addEventListener('message', event => {
  if (!event.data || event.data.type!=='PREFETCH') return;
  const urls = event.data.urls || [];
  event.waitUntil(
    caches.open(DYN_CACHE).then(cache =>
      Promise.all(urls.map(u =>
        fetch(u, {mode:'no-cors'})
          .then(res => cache.put(u, res.clone()))
          .catch(()=>{})
      ))
    )
  );
});
