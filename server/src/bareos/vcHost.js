/**
 * bareos/vcHost.js — FD 가 접속할 vCenter 주소(매핑의 vcserver)를 **vCenter 등록부**에서 읽는다(v2.851.1).
 *
 * 2026-11-02 사용자 화면(완전 설치 마무리 — '사이트 매핑의 vcserver 주소가 올바르지 않습니다'): 완전 설치 대상 표 · 설정 화면의 매핑 미리 채우기가
 *   주소를 수집 스냅샷(store.get().vcenters[].host)에서 읽었다 — 스냅샷의 vCenter 항목은 수집기가 만든 것이라 host 칸이 **없다**(soapClient · restClient ·
 *   store.js 병합 어디에도 없음) → 늘 빈 값이었고, 완전 설치 7단계가 vcserver '' 로 매핑을 저장해 마무리(FD 지문 · INI)가 거부됐다.
 *   주소는 등록부(vcenters.json — 'https://…' 형식 필수)에만 있다.
 * 값은 호스트 이름 또는 IP 만(스킴 · 경로 · 포트 제거) — 플러그인 값 규칙이 ':' 를 거부한다(settings.js normalizeSite).
 */
import { loadRegistry } from '../vcenter/registry.js';

/** 'https://vc.corp:443/sdk' → 'vc.corp' (못 알아보면 ''). */
export function vcHostOf(raw) {
  const s = String(raw ?? '').trim().replace(/^https?:\/\//i, '').replace(/[/?#].*$/, '').replace(/:\d{1,5}$/, '');
  return /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(s) ? s : '';
}

/** 등록부의 vCenter id → 주소. 못 읽으면 빈 Map(부르는 쪽이 '모름' 으로 다룬다 — 빈 값을 저장하지 않는다). */
export function registryHosts() {
  const m = new Map();
  try { for (const v of loadRegistry()) if (v && v.id != null) { const h = vcHostOf(v.host); if (h) m.set(String(v.id), h); } } catch { /* 모름 */ }
  return m;
}
