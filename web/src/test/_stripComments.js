/**
 * web/src/test/_stripComments.js — 웹 테스트의 소스 스윕용 주석 제거기(v2.615, SF2-06 — 테스트 전용 모듈).
 *
 * 왜 따로 두나: 같은 상태 기계가 웹 테스트 파일마다 복사되고 있었다(audit2613b · uiText · storageFaultText).
 * 서버는 v2.613 에 사본 24벌을 test/_stripComments.js 하나로 모았다 — 웹도 같은 규칙으로 하나를 쓴다.
 *
 * 동작: 블록 주석과 줄 주석을 지우되 **개행은 보존**한다(지우면 줄 번호가 밀려 엉뚱한 줄을 지목한다 — v2.574 규약).
 * ⚠ 한계(정직 기록): 문자열·정규식 리터럴 안의 주석 모양은 구분하지 않는다. JSX 텍스트의 홑따옴표 때문에 따옴표
 *   추적을 넣으면 오히려 동기가 깨진다. 대상 파일에 그런 문자열이 생기면 스윕 결과를 먼저 의심할 것.
 * ⚠ 이 파일은 화면 번들에 들어가지 않는다(테스트만 import 한다).
 */
export function stripComments(s) {
  let out = ''; let i = 0;
  const N = s.length;
  while (i < N) {
    const c = s[i]; const d = s[i + 1];
    if (c === '/' && d === '*') {
      const e = s.indexOf('*/', i + 2);
      out += s.slice(i, e < 0 ? N : e + 2).replace(/[^\n]/g, '');
      i = e < 0 ? N : e + 2;
      continue;
    }
    if (c === '/' && d === '/') {
      const e = s.indexOf('\n', i);
      out += s.slice(i, e < 0 ? N : e).replace(/[^\n]/g, '');
      i = e < 0 ? N : e;
      continue;
    }
    out += c; i += 1;
  }
  return out;
}
