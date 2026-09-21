/**
 * `numOrNull`(웹) — '읽지 못한 수치' 를 0 으로 둔갑시키지 않는 단일 판정.
 *
 * ⚠ 값은 `server/src/util/numOrNull.js` 와 **글자 그대로 같은 규칙**이어야 한다(웹은 서버
 * 소스를 import 할 수 없다 — 번들 경계). `server/test/audit2575.test.js` 가 두 구현의
 * 동작을 같은 입력으로 대조한다.
 *
 * ⚠⚠ **이 저장소에서 여덟 번 재발한 결함의 코어다.** `Number(null)`·`Number('')`·`Number([])`
 * 는 전부 **0** 이고 `Number.isFinite(0)` 은 참이라
 *
 *     const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);   // ✗ 틀렸다
 *
 * 형태는 '값을 읽지 못했다' 를 '값이 0 이다' 로 바꾼다. 오류가 나지 않아 화면은 정상처럼
 * 보이고, 0 은 '부하 없음'·'0℃'·'트래픽 없음' 같은 **적극적인 거짓**이 된다.
 * v2.575 실측 재현 — 연결 끊긴 ESXi 호스트가 vCenter 개요 표에서
 * `흡기온도 0℃ · CPU 0% · MEM 0%` 로 보였다(정답은 전부 `—`).
 *
 * ⚠ **'0 이 정답인 카운터' 에 쓰지 말 것** — 이 함수는 **측정값** 전용이다.
 */
export function numOrNull(v) {
  if (v == null) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  if (typeof v !== 'number' && typeof v !== 'string') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export default numOrNull;
