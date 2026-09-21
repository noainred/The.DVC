/**
 * 소스 검사 테스트용 **주석 제거** 코어 (v2.574).
 *
 * ⚠⚠ **정규식 두 줄짜리 판본은 틀렸다.** v2.552~2.573 의 테스트 6곳이
 *
 *     s.replace(<블록주석 정규식>, blank).replace(<줄주석 정규식>, '$1')
 *     (블록주석 정규식 = 슬래시-별 … 별-슬래시 를 게으르게 잡는 것. 여기 그대로 적으면
 *      이 JSDoc 이 그 자리에서 끝나 버린다 — 이 파일이 실제로 그 함정에 걸렸다.)
 *
 * 를 복사해 쓰고 있었는데, 줄 주석 **안에** `/*` 가 들어 있으면(이 저장소 실제 사례:
 * `agent/configPush.js:34` 의 `// 자기 설정(*.json/*.env), 대용량 데이터 제외` — `json/` 뒤의
 * `*` 가 `/*` 를 만든다) 블록 주석 규칙이 **그 지점부터 다음 블록주석 종료 기호까지 코드를 통째로 지운다**.
 * 실측: 그 파일의 `catch` 5개가 **전부 사라져**(스트립 후 0개) 새 스윕 테스트가 멀쩡한 코드를
 * '무음 실패' 로 오판했다. 순서를 뒤집어도(줄 주석 먼저) 블록 주석 안의 `//` 로 같은 문제가 난다.
 *
 * 그래서 **상태 기계**로 훑는다 — 문자열('", 백틱)·정규식 리터럴 안의 `/*`·`//` 는 주석이 아니고,
 * 주석 안의 따옴표도 문자열이 아니다.
 *
 * ⚠ **개행은 보존한다** — 지우면 줄 번호가 밀려 엉뚱한 줄을 지목한다(v2.569 실제 오탐).
 * 주석 자리는 공백으로 채워 오프셋도 그대로 둔다(테스트가 `m.index` 로 위치를 쓴다).
 *
 * ⚠ 정규식 리터럴과 나눗셈은 완벽히 구분할 수 없다(JS 의 알려진 모호성). 직전 의미 있는
 * 문자로 판정하며, 틀리면 **주석을 덜 지우는 쪽**(안전)으로 실패한다.
 */

/**
 * 주석 자리를 비운다 — **개행만 남긴다**.
 * ⚠ 개행 보존은 필수다(지우면 줄 번호가 밀려 엉뚱한 줄을 지목한다 — v2.569 실제 오탐).
 * ⚠ 공백으로 **채우지는** 않는다: 기존 스윕들이 `설정: {[\s\S]{0,200}키` 처럼 **거리 창**을 쓰는데,
 *   긴 JSDoc 을 공백 290자로 남기면 그 창을 넘겨 멀쩡한 코드를 누락으로 오판한다
 *   (v2.574 에 `linkCheck2552` 가 실제로 그렇게 깨졌다). 상대 순서는 그대로이므로
 *   `m.index` 로 '먼저/나중' 을 보는 검사에는 영향이 없다.
 */
const BLANK = (s) => s.replace(/[^\n]/g, '');
/** 정규식 리터럴이 올 수 있는 자리인지 — 직전 토큰이 값이면 나눗셈, 연산자·구두점이면 정규식. */
const REGEX_OK_BEFORE = /[([{;,:=!&|?+\-*%~^<>]$/;

/** @param {string} src @returns {string} 주석이 공백으로 바뀐 같은 길이의 소스 */
export function stripComments(src) {
  const s = String(src ?? '');
  let out = '';
  let i = 0;
  let prev = '';           // 직전 '의미 있는' 문자(공백·주석 제외)
  while (i < s.length) {
    const c = s[i], d = s[i + 1];
    if (c === '/' && d === '*') {                         // 블록 주석
      const end = s.indexOf('*/', i + 2);
      const stop = end === -1 ? s.length : end + 2;
      out += BLANK(s.slice(i, stop)); i = stop; continue;
    }
    if (c === '/' && d === '/') {                         // 줄 주석
      let end = s.indexOf('\n', i);
      if (end === -1) end = s.length;
      out += BLANK(s.slice(i, end)); i = end; continue;
    }
    if (c === '"' || c === "'" || c === '`') {            // 문자열·템플릿
      let j = i + 1;
      while (j < s.length) {
        if (s[j] === '\\') { j += 2; continue; }
        if (s[j] === c) { j += 1; break; }
        // ⚠ 템플릿의 `${...}` 안에는 다시 코드가 온다. 여기서는 주석을 찾지 않는 것으로
        //   충분하다(그 안의 주석은 드물고, 남겨도 '덜 지우는 쪽' 이라 안전하다).
        j += 1;
      }
      out += s.slice(i, j); prev = c; i = j; continue;
    }
    if (c === '/' && REGEX_OK_BEFORE.test(prev)) {        // 정규식 리터럴
      let j = i + 1, cls = false, ok = false;
      while (j < s.length) {
        const ch = s[j];
        if (ch === '\\') { j += 2; continue; }
        if (ch === '\n') break;                           // 개행이 나오면 정규식이 아니었다
        if (ch === '[') cls = true;
        else if (ch === ']') cls = false;
        else if (ch === '/' && !cls) { j += 1; ok = true; break; }
        j += 1;
      }
      if (ok) { out += s.slice(i, j); prev = '/'; i = j; continue; }
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i += 1;
  }
  return out;
}
