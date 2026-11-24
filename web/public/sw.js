/* VM Portal Service Worker — PWA 설치 가능성 + 오프라인 셸. 자산은 항상 네트워크 우선
   (업그레이드 후 stale 자산 방지). 네트워크 실패 시에만 캐시 폴백. */
const CACHE = 'vmportal-shell-v1';
/* 전체 점검 156회차(129 · 132 · 133회차가 남긴 것): 이 캐시를 지우는 곳이 없어, 판이 나올 때마다 이름에 해시가 든 옛 화면 조각이
   브라우저에 끝없이 쌓였다 → 이 기간 넘게 다시 받지 않은 것만 지운다.
   161회차(156 반증 — Chromium 실측): 156 은 나이를 **응답 Date** 로 쟀다. 그런데 Date 는 '이 브라우저가 마지막으로 받은 때' 가 아니다 —
     · 화면 조각(/assets/…)은 `immutable` 이라 브라우저 HTTP 캐시가 **처음 받은 때의 Date** 를 그대로 돌려준다(다시 열어도 Date 가 새로워지지 않는다).
       판을 받은 지 14일이 지나면 방문할 때마다 지금 쓰는 조각까지 지웠다(실측: 캐시 34개 → 4개).
     · 서버 시계가 늦거나 이 PC 시계가 빠르면(14일 넘게) 방금 받은 화면(/)까지 지워 서버가 잠깐 끊긴 사이의 재방문이 열리지 않았다(실측 net::ERR_FAILED).
   → 담을 때 **이 브라우저의 시각**을 머리말(STAMP)에 적고 그것으로만 잰다(서버 시계 · 프록시 · HTTP 캐시와 무관).
     표시가 없는 항목(옛 판의 워커가 담은 것)은 지금 시각을 적어 두고 이번에는 지우지 않는다(다음부터 센다).
     이 워커가 살아 있는 동안 다시 받은 주소(fresh)는 지우지 않는다 — 정리가 읽은 뒤 · 지우기 전에 새로 담긴 것을 지우지 않게. */
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const TRIM_EVERY_MS = 60 * 60 * 1000;
const STAMP = 'x-sw-cached-at';
const fresh = new Set();
const urlKey = (u) => String(u).split('#')[0];
/** 응답 사본에 담은 시각을 적는다(본문은 흘려 보낸다 — 통째로 읽지 않는다). */
function stamped(res, now) {
  const h = new Headers(res.headers);
  h.set(STAMP, String(now));
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}
let lastTrim = 0;
async function trimOld(now = Date.now()) {
  if (now - lastTrim < TRIM_EVERY_MS) return;
  lastTrim = now;
  try {
    const c = await caches.open(CACHE);
    for (const k of await c.keys()) {
      const u = urlKey(k.url);
      if (fresh.has(u)) continue;
      const r = await c.match(k);
      if (!r || fresh.has(u)) continue;   // 읽는 사이 새로 받았다 — 건드리지 않는다
      const raw = r.headers.get(STAMP);
      if (raw == null) { await c.put(k, stamped(r, now)); continue; }
      const at = Number(raw);
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
        if (fresh.size > 5000) fresh.clear();
        fresh.add(urlKey(req.url));   // 기다림(await) 앞에서 적는다 — 진행 중인 정리가 이 주소를 지우지 않게
        const c = await caches.open(CACHE);
        const put = Promise.resolve().then(() => c.put(req, stamped(res.clone(), Date.now()))).catch(() => { /* 담지 못해도(용량 등) 응답은 그대로 */ });
        // 화면을 여는 요청(내비게이션)이 성공했을 때만, 이번 응답을 담은 뒤에 옛 것을 정리한다(워커가 살아 있는 동안 시간당 1번 —
        //   잠들었다 깨면 기억이 지워져 다음 화면 열기에 다시 훑는다 · Chromium 실측 313개 0.3초 미만 · 응답을 기다리게 하지 않는다).
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
