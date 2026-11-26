/**
 * idrac/ledState.js — 물리서버 **위치 LED 상태**(v3.49 · 설계 ⑥ — 이번 판은 보이기만). 순수.
 *
 *  · 주 iDRAC 폴러가 이미 읽는 값(Redfish System `IndicatorLED` — `idrac/redfish.js` inv.system.indicatorLED)을 화면에 보인다. 새 수집 없음.
 *  · 값: on(켜짐 · Lit) · blink(깜빡임 · Blinking) · off(꺼짐 · Off). 그 밖(빈 값 · Unknown · 모르는 글자)은 '' — 못 읽음(꺼짐이 아니다).
 *  · 엣지 수집 서버는 엣지가 함대 push 에 `led` 로 싣는다(agent/fleetPush.js) — 중앙은 `ledStateOf` 로 다시 정제한다(아는 값만).
 *  · 켜기 · 끄기(장비 상태를 바꾸는 동작)는 이 판에 없다 — 권한 · 감사 · 엣지 로컬 실행 틀을 원격 전원 조작(⑦)과 함께 만든다.
 */
export const LED_STATES = Object.freeze(['on', 'blink', 'off']);
const MAP = Object.freeze({ lit: 'on', on: 'on', blinking: 'blink', blink: 'blink', off: 'off' });

/** Redfish 값 · 정제된 값 → 'on' | 'blink' | 'off' | ''. 글자만 · 32자까지 본다(선형). */
export function ledStateOf(raw) {
  if (typeof raw !== 'string') return '';
  const k = raw.trim().slice(0, 32).toLowerCase();
  return Object.hasOwn(MAP, k) ? MAP[k] : '';
}
/** 인벤토리 → LED 상태(없으면 ''). */
export const ledOfInv = (inv) => ledStateOf(inv?.system?.indicatorLED);
