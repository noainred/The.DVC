/**
 * `numOrNull` — '읽지 못한 수치' 를 0 으로 둔갑시키지 않는 단일 판정 (v2.561).
 *
 * ⚠⚠ **이 저장소에서 여섯 번 재발한 결함의 코어다.** `Number(null)`·`Number('')`·`Number([])` 는
 * 전부 **0** 이고 `Number.isFinite(0)` 은 참이라, 흔히 쓰이는
 *
 *     const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);   // ✗ 틀렸다
 *
 * 형태는 **'값을 읽지 못했다'(null·빈 문자열)를 '값이 0 이다' 로 바꾼다**. 오류가 나지 않으므로
 * 화면은 정상처럼 보이고, 0 은 '사용량 0'·'부하 없음'·'0℃' 같은 **적극적인 거짓**이 된다.
 * 실제 사고 — v2.525(Horizon `connected`) · v2.540(용량 `tb()`) · v2.550(디스크 여유) ·
 * v2.552(`certText` '0일 남음') · v2.556(스파크라인 0℃) · **v2.561(스토리지 용량 적재)**.
 *
 * v2.561 이전에는 같은 헬퍼가 **13벌** 복사돼 있었고 그중 **7벌이 틀린 형태**였다
 * (CLAUDE.md '코어는 하나다' 위반). 판정은 이 모듈 하나가 갖는다 —
 * `test/numOrNull2561.test.js` 가 소스에서 지역 복사본이 되살아나는 것을 막는다.
 *
 * 규칙:
 *  · `null`·`undefined`·`''`(빈 문자열, 공백만인 문자열)  → `null` ('읽지 못함')
 *  · 숫자로 해석되지 않는 값(NaN·`[]`·`{}`·`'abc'`·`Infinity`) → `null`
 *  · 그 밖의 유한수 → 그 수
 *
 * ⚠ **'0 이 정답인 카운터' 에 쓰지 말 것.** 보고가 없을 때 0 이 맞는 값(예:
 * `central/svcmonEdge.js` 의 `items`·`reported`)은 의도적으로 `: 0` 이고 이 함수를 쓰지 않는다.
 * 이 함수는 **측정값**(용량·온도·사용률·처리량·지연) 전용이다.
 */

/**
 * @param {unknown} v
 * @returns {number|null} 유한수, 아니면 null
 */
export function numOrNull(v) {
  if (v == null) return null;
  // ⚠ 빈 문자열·공백만인 문자열을 **Number() 에 넘기기 전에** 걸러야 한다(0 이 된다).
  if (typeof v === 'string' && v.trim() === '') return null;
  // ⚠ 배열·객체도 걸러낸다 — `Number([]) === 0`, `Number([5]) === 5` 로 조용히 통과한다.
  if (typeof v !== 'number' && typeof v !== 'string') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export default numOrNull;
