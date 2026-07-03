/**
 * RFC 4180 CSV 토크나이저 — 따옴표("...")로 감싼 필드 안의 쉼표·줄바꿈·이스케이프된 따옴표("")를
 * 온전히 처리한다. 순진한 line.split(',')은 비밀번호에 쉼표(p@ss,w0rd)나 줄바꿈이 있으면 필드를
 * 잘라 잘못된 자격증명을 저장했다(특수문자 iDRAC 비번 스캔/위임 인증 실패의 원인).
 * 따옴표로 감싸지 않은 필드는 규칙 미적용이라 기존 단순 CSV도 그대로 호환된다.
 *
 * 반환: string[][] (레코드별 셀 배열). 전부 공백인 레코드는 제외한다.
 */
export function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } // "" → 리터럴 따옴표
        else inQuotes = false;
      } else field += c;
    } else if (c === '"' && field === '') {
      inQuotes = true; // 필드 시작 위치의 따옴표만 인용 필드로 인식
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++; // CRLF
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}
