/**
 * RFC 4180 CSV 토크나이저 — 따옴표("...")로 감싼 필드 안의 쉼표·줄바꿈·이스케이프된 따옴표("")를
 * 온전히 처리한다. 순진한 line.split(',')은 비밀번호에 쉼표(p@ss,w0rd)나 줄바꿈이 있으면 필드를
 * 잘라 잘못된 자격증명을 저장했다(특수문자 iDRAC 비번 스캔/위임 인증 실패의 원인).
 * 따옴표로 감싸지 않은 필드는 규칙 미적용이라 기존 단순 CSV도 그대로 호환된다.
 *
 * 반환: string[][] (레코드별 셀 배열). 전부 공백인 레코드는 제외한다.
 */

/** UTF-8 BOM — 엑셀이 붙이고, 남겨 두면 첫 헤더 셀이 '﻿kind' 가 되어 매칭이 조용히 실패한다. */
const BOM = '﻿';

/**
 * @param {string} text
 * @param {{maxRows?:number,maxCell?:number}} [limits] 0 이면 무제한(기존 호출부 호환).
 *   상한은 **스캔 중** 검사한다 — 전량 파싱 후 slice 하면 이미 메모리를 다 먹은 뒤다
 *   (1MB 개행 본문으로 heap +205MB·76ms 동기 블로킹 실측).
 */
export function parseCsvRows(text, { maxRows = 0, maxCell = 0 } = {}) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let s = String(text ?? '');
  if (s.startsWith(BOM)) s = s.slice(BOM.length);
  const overCell = () => {
    if (maxCell && field.length > maxCell) throw new Error(`CSV 셀이 최대 ${maxCell}자를 넘습니다(행 ${rows.length + 1}).`);
  };
  const endRow = () => {
    rows.push(row); row = [];
    if (maxRows && rows.length > maxRows) throw new Error(`CSV 행이 최대 ${maxRows}행을 넘습니다.`);
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; overCell(); } // "" → 리터럴 따옴표
        else inQuotes = false;
      } else { field += c; overCell(); }
    } else if (c === '"' && field === '') {
      inQuotes = true; // 필드 시작 위치의 따옴표만 인용 필드로 인식
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++; // CRLF
      row.push(field); field = '';
      endRow();
    } else { field += c; overCell(); }
  }
  if (field !== '' || row.length) { row.push(field); endRow(); }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

/**
 * 스프레드시트 수식 인젝션 방어 — `= + - @`(및 탭/CR)로 시작하는 셀에 작은따옴표를 붙인다.
 * 엑셀에서 `=cmd|...` 같은 셀이 실행되는 것을 막는다(pyportal hub/csvio.py 와 같은 규칙).
 */
export function guardCell(v) {
  const s = String(v ?? '');
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

/**
 * guardCell 의 역함수 — 가져오기에서 반드시 **쌍으로** 적용한다.
 * 없으면 내보내기→가져오기를 반복할 때마다 `'` 가 한 겹씩 쌓여 값이 자란다.
 */
export function unguardCell(v) {
  const s = String(v ?? '');
  return /^'[=+\-@\t\r]/.test(s) ? s.slice(1) : s;
}

/** 셀 배열 → CSV 한 줄(수식가드 + 필요한 경우만 따옴표). 단독 CR 도 quoting 한다. */
export function csvLine(cells) {
  return cells.map((c) => {
    const s = guardCell(c);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',');
}

export { BOM as CSV_BOM };
