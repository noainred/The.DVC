/**
 * `hostCapacityKnown`(웹) — 호스트 용량(물리 코어 · CPU 총 MHz · 메모리 총량)을 읽었는가.
 *
 * ⚠ 서버 `server/src/store.js hostCapacityKnown` 과 **같은 규칙**이어야 한다(웹은 서버 소스를 import 할 수 없다 — 번들 경계).
 *   `server/test/leftoverC56.test.js` 가 두 구현을 같은 입력으로 대조한다.
 *   55회차 기록: 예전 웹(vcdVirt virtSum)은 코어 · 메모리 둘만 보고 서버는 셋을 봐서, 코어 · 메모리만 읽힌 호스트가 있으면
 *   vCenter 상세 트리는 가상화율을 내고 호스트 화면 요약 · Summary · 알림은 '미상' 으로 뺐다(54회차 F5 에서 맞춤).
 *
 * 규칙: 세 칸이 모두 유한한 number 일 때만 참. null · undefined · 글자('8') · NaN 은 못 읽음이다
 *   (서버 수집기는 못 읽은 용량을 null 로 싣는다 — REST 폴백 v2.733 · SOAP 54회차 F5).
 * @param {object|null|undefined} h  호스트(/hosts 항목)
 * @returns {boolean}
 */
export function hostCapacityKnown(h) {
  return !!h && [h.cpuCores, h.cpuTotalMhz, h.memTotalMB].every((v) => typeof v === 'number' && Number.isFinite(v));
}

export default hostCapacityKnown;
