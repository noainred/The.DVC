/**
 * settingsFormDiff.js — 설정 폼이 '바꾸지 않은 칸' 을 서버에 보내지 않게 하는 순수 판정(v2.630 감사 WEB2630-01·02).
 *
 * 왜: 폼이 실효값(기본값·env 값)으로 칸을 채운 뒤 **전 칸을 보내면**, 사용자가 다른 칸 하나만 고쳐
 * 저장해도 채워 둔 값이 '관리자가 지정한 값' 으로 저장된다.
 *  - 자동 업그레이드: 확인 주기 0(끔)을 60 으로 채워, 설치 경로만 고쳐 저장해도 1시간 원격 확인이 켜졌다.
 *  - PDU 수집 주기: 실효값으로 세 칸을 채우고 전부 보내, 한 칸만 바꿔도 세 키가 '중앙 지정' 이 되어
 *    각 엣지의 portal.env 현장 주기를 덮었다(CLAUDE.md 스토리지 주기 규약 '중앙이 지정한 키만 내려간다').
 */

const blank = (v) => v == null || String(v).trim() === '';

/**
 * 업그레이드 확인 주기(ms) → 폼 칸(분). 0 은 0(끔) 그대로, 값이 없으면 빈 칸.
 * 예전 `ms ? … : 60` 은 0(끔)을 60 으로 둔갑시켰다.
 */
export function pollMinutesOf(ms) {
  if (ms == null || ms === '') return '';
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '';
  return Math.round(n / 60000);
}

/** 확인 주기 칸이 '끔' 을 뜻하는가(0). 빈 칸은 '미지정(서버 값 유지)' 이지 끔이 아니다. */
export function pollIsOff(minutes) {
  return !blank(minutes) && Number(minutes) === 0;
}

/**
 * 저장 본문에 넣을 pollIntervalMs — 처음 채운 값에서 **바뀌었을 때만** 숫자를 준다. 아니면 undefined(보내지 않음).
 * 빈 칸은 미지정(보내지 않음), 숫자가 아니어도 보내지 않는다.
 */
export function pollIntervalPatch(minutes, initialMinutes) {
  if (blank(minutes)) return undefined;
  const n = Number(minutes);
  if (!Number.isFinite(n)) return undefined;
  if (!blank(initialMinutes) && Number(initialMinutes) === n) return undefined;
  return Math.max(0, n) * 60000;
}

/**
 * 주기 모달 저장 본문 — 처음 값과 달라진 키만 담는다(초 → ms). 비운 칸은 '' 로 보내 '미지정으로 되돌리기' 다.
 * 아무것도 안 바꿨으면 빈 객체.
 */
export function changedIntervalBody(initial, vals) {
  const init = initial || {};
  const out = {};
  for (const [k, v] of Object.entries(vals || {})) {
    const a = blank(init[k]) ? '' : String(Number(init[k]));
    const b = blank(v) ? '' : String(Number(v));
    if (a === b) continue;
    out[k] = b === '' ? '' : Number(v) * 1000;
  }
  return out;
}
