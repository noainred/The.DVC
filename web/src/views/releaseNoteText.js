/**
 * 릴리스 노트 한 줄 → 화면 문자열(v2.607, 감사 WEB2607-08). release-notes.json 은 마크다운 관례(백틱 코드 표기)로
 * 적혀 있는데 화면은 평문으로 그려 백틱이 글자로 샜다. 짝이 맞는 백틱 구간을 홑화살괄호 ‘ ’ 로 바꾼다
 * (CLAUDE.md 값 인용 규칙). `**강조**` 는 BoldText 가 처리한다. 짝이 없는 백틱은 그대로 둔다(지어내지 않는다).
 */
export function releaseLineText(line) {
  const s = String(line ?? '');
  if (!s.includes('`')) return s;
  return s.replace(/`([^`\n]{1,400})`/g, '‘$1’');
}
