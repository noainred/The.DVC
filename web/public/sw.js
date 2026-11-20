/* VM Portal Service Worker — PWA 설치 가능성 + 오프라인 셸. 자산은 항상 네트워크 우선
   (업그레이드 후 stale 자산 방지). 네트워크 실패 시에만 캐시 폴백. */
const CACHE = 'vmportal-shell-v1';
/* 전체 점검 156회차(129 · 132 · 133회차가 남긴 것): 이 캐시를 지우는 곳이 없어, 판이 나올 때마다 이름에 해시가 든 옛 화면 조각이
   브라우저에 끝없이 쌓였다. 네트워크 우선이라 지금 쓰는 자산은 받을 때마다 다시 담긴다(응답 Date 가 새로워진다) —
   이 기간 넘게 다시 받지 않은 것만 지운다. Date 가 없는 응답(프록시가 뗀 경우)은 판단하지 않는다(지우지 않는다). */
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const TRIM_EVERY_MS = 60 * 60 * 1000;
let lastTrim = 0;
async function trimOld(now = Date.now()) {
  if (now - lastTrim < TRIM_EVERY_MS) return;
  lastTrim = now;
  try {
    const c = await caches.open(CACHE);
    for (const k of await c.keys()) {
      const r = await c.match(k);
      const at = Date.parse((r && r.headers.get('date')) || '');
      if (Number.isFinite(at) && now - at > MAX_AGE_MS) await c.delete(k);
    }
  } catch { /* 정리 실패는 응답에 영향을 주지 않는다 — 다음 화면 열기에 다시 */ }
}

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
        const c = await caches.open(CACHE);
        const put = c.put(req, res.clone()).catch(() => { /* 담지 못해도(용량 등) 응답은 그대로 */ });
        // 화면을 여는 요청(내비게이션)이 성공했을 때만, 이번 응답을 담은 뒤에 옛 것을 정리한다(시간당 1번).
        if (req.mode === 'navigate') { try { e.waitUntil(put.then(() => trimOld())); } catch { /* 수명 연장 불가 — 정리는 다음에 */ } }
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
