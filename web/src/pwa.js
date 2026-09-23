/**
 * PWA 부트스트랩 — 서비스워커 등록(설치 가능) + 위험 인시던트 브라우저 알림(폴링).
 * 브라우저 푸시(VAPID) 없이도 세션이 떠 있는 동안 새 위험 경보를 데스크톱/모바일 알림으로
 * 띄운다. 알림 권한은 사용자 제스처(인사이트 › 인시던트의 "알림 켜기")로 요청한다.
 */

import { fetchJson } from './api.js';

export function registerPwa() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('[pwa] SW 등록 실패:', e.message));
  });
}

/** 사용자 제스처에서 호출 — 알림 권한 요청. 반환: 'granted'|'denied'|'default'|'unsupported'. */
export async function enableNotifications() {
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  try { return await Notification.requestPermission(); } catch { return 'denied'; }
}

let timer = null;
let pausedUntil = 0;
const seen = new Set();

/** 위험 인시던트 폴링 → 새 항목을 브라우저 알림으로. 중복은 key로 억제. */
export function startAlertNotifications(intervalMs = 60_000) {
  if (timer) return;
  const tick = async () => {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    // v2.596(감사 SECWEB-02): 로그아웃·권한 없음(401/403)이면 60초마다 거부 요청을 쌓지 않게 10분 쉰다
    //   (셸 수명과 무관하게 한 번 시작되는 타이머라 멈추기만 하면 재로그인 뒤 다시 켤 길이 없다).
    if (Date.now() < pausedUntil) return;
    try {
      const d = await fetchJson('/insights/incidents', { limit: 30 });
      for (const o of (d.open || [])) {
        if (o.severity !== 'critical' || seen.has(o.key)) continue;
        seen.add(o.key);
        try {
          const reg = await navigator.serviceWorker?.ready;
          const body = o.detail || '';
          if (reg?.showNotification) reg.showNotification(`🔴 ${o.title}`, { body, tag: o.key, icon: '/icon.svg', badge: '/icon.svg' });
          else new Notification(`🔴 ${o.title}`, { body, tag: o.key, icon: '/icon.svg' });
        } catch { /* 알림 실패 무시 */ }
      }
      // 해소된 항목은 재알림 가능하도록 seen에서 제거.
      const openKeys = new Set((d.open || []).map((o) => o.key));
      for (const k of [...seen]) if (!openKeys.has(k)) seen.delete(k);
    } catch (e) {
      if (e?.status === 401 || e?.status === 403) pausedUntil = Date.now() + 10 * 60_000;
    }
  };
  timer = setInterval(tick, intervalMs);
  setTimeout(tick, 5000);
}
