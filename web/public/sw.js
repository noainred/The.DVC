/* VM Portal Service Worker — PWA 설치 가능성 + 오프라인 셸. 자산은 항상 네트워크 우선
   (업그레이드 후 stale 자산 방지). 네트워크 실패 시에만 캐시 폴백. */
const CACHE = 'vmportal-shell-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // API/실시간 데이터는 SW가 관여하지 않음(항상 최신).
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/metrics')) return;
  // 내비게이션/자산: 네트워크 우선, 실패 시 캐시.
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res && res.ok && res.type === 'basic') {
        const c = await caches.open(CACHE); c.put(req, res.clone());
      }
      return res;
    } catch {
      const cached = await caches.match(req);
      return cached || caches.match('/');
    }
  })());
});

// 인앱 알림 클릭 → 포탈 포커스.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((cs) => {
    for (const c of cs) if ('focus' in c) return c.focus();
    return self.clients.openWindow('/#/insights');
  }));
});
