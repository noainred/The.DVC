/**
 * mock/demo/flags.js — 데모(DATA_SOURCE=mock) 모드 공용 판정(v2.708).
 *
 * 규칙(모든 데모 모듈이 따른다)
 *  · 데모 데이터는 **mock 모드에서만** 만든다 — live/auto 에서는 아무것도 하지 않는다.
 *  · 등록부 시드는 **비어 있을 때만**, id 는 `mock-` 접두(실데이터를 덮지 않고, live 폴러가 건너뛸 수 있게).
 *  · 장비·엣지에 접속하지 않는다 — 합성 값은 메인 스냅샷(vCenter·호스트 이름)에서 결정적으로 만든다.
 *  · 기본 꺼짐(opt-in) 기능은 데모에서 '켜진 것처럼' 동작한다(`demoOn`). 저장된 설정 파일은 바꾸지 않는다 —
 *    live 로 바꾸면 원래 설정(꺼짐)으로 돌아간다. 응답·상태에 `demo:true` 를 실어 화면이 데모임을 말할 수 있게 한다.
 */
import { isMockMode } from '../seed.js';

export { isMockMode };

/** 저장된 '켜짐' 값 또는 데모 모드. */
export function demoOn(saved) {
  return saved === true || isMockMode();
}

/** 이름 기반 안정 해시 — 같은 입력은 언제나 같은 값. */
export function demoHash(s) {
  let h = 2166136261;
  const t = String(s);
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** 0~1 결정적 난수(시드 문자열). */
export function demoRand(seed) {
  return (demoHash(seed) % 100000) / 100000;
}

/** 사설 대역의 합성 주소(실제로 접속하지 않는다). */
export function demoIp(seed, prefix = 10) {
  const h = demoHash(seed);
  return `${prefix}.${(h >>> 8) % 250}.${(h >>> 16) % 250}.${(h % 253) + 1}`;
}
