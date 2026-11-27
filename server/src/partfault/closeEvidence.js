/**
 * partfault/closeEvidence.js — 알림 단계 기록 정리의 ‘닫힘’ 근거 중 **판정이 본 것**(중앙 전용 · 메모리 · v3.54 반증 13c).
 *
 * 판정 폴러(runOnce)는 진행 기록 가운데 DB 에 열려 있지 않은 것을 ‘가상의 열린 장애’ 로 **같은 전이(transition)** 에 넣는다. 그 전이가 닫은 것
 * (장비를 읽었고 · 그 종류를 모았고 · 정비 창 밖이고 · 등록부를 읽었고 · 보고가 있는데 그 부품이 없거나 정상)만 여기 남는다. 전이가 보류한 것은 남지 않는다.
 * 판정마다 통째로 바꾼다(지난 판정의 근거를 쌓지 않는다). 재시작하면 비고, 다음 판정이 다시 만든다(그 사이 기록은 남는다 — 닫힘을 모른다).
 * 다른 근거(DB 의 마지막 이벤트가 닫힘 — 평소 닫힘 · 수동 닫기)는 escalationRun 이 DB 에서 읽는다.
 */
let _keys = new Set();
let _at = null;
export function setJudgedClosed(keys, at = Date.now()) { _keys = new Set(keys); _at = at; }
export const judgedClosedKeys = () => _keys;
export const judgedClosedAt = () => _at;
export function _resetJudgedClosedForTest() { _keys = new Set(); _at = null; }
