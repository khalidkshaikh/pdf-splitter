const CACHE = 'pdfsplitter-v1';
const PRECACHE = [
    '/pdf-splitter/',
    '/pdf-splitter/static/css/style.css',
    '/pdf-splitter/static/js/main.js',
    '/pdf-splitter/static/icon.svg',
];

self.addEventListener('install', e => {
    e.waitUntil(
        caches.open(CACHE)
            .then(c => c.addAll(PRECACHE))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', e => {
    if (e.request.method !== 'GET') return;
    e.respondWith(
        caches.match(e.request).then(cached => {
            const networkFetch = fetch(e.request).then(response => {
                if (response.ok) {
                    caches.open(CACHE).then(c => c.put(e.request, response.clone()));
                }
                return response;
            }).catch(() => cached || new Response('', { status: 503 }));
            const isLocal = new URL(e.request.url).origin === self.location.origin;
            return isLocal ? (cached || networkFetch) : networkFetch;
        })
    );
});
