/**
 * RFC 4180 CSV 토크나이저 — 따옴표("...")로 감싼 필드 안의 쉼표·줄바꿈·이스케이프된 따옴표("")를
 * 온전히 처리한다. 순진한 line.split(',')은 비밀번호에 쉼표(p@ss,w0rd)나 줄바꿈이 있으면 필드를
 * 잘라 잘못된 자격증명을 저장했다(특수문자 iDRAC 비번 스캔/위임 인증 실패의 원인).
 * 따옴표로 감싸지 않은 필드는 규칙 미적용이라 기존 단순 CSV도 그대로 호환된다.
 *
 * 구분자(v2.345): 기본 쉼표. 첫 유효 줄에 쉼표가 하나도 없고 탭이 있으면 탭 구분(TSV)으로
 * 자동 전환한다 — 엑셀 복사-붙여넣기와 "텍스트(탭으로 분리)" 저장본이 모든 CSV 가져오기에서
 * "필수 헤더 없음"으로만 실패하던 실사용 문제의 해결. 쉼표가 하나라도 있으면 쉼표 CSV 로
 * 취급하므로 기존 파일의 동작은 변하지 않는다.
 *
 * 반환: string[][] (레코드별 셀 배열). 전부 공백인 레코드는 제외한다.
 */

/** UTF-8 BOM — 엑셀이 붙이고, 남겨 두면 첫 헤더 셀이 '﻿kind' 가 되어 매칭이 조용히 실패한다. */
const BOM = '﻿';

/** 첫 유효(비어있지 않은) 줄의 인용 구간 밖 쉼표/탭 개수로 구분자를 판정한다. 쉼표 우선. */
function sniffDelimiter(s) {
  let commas = 0; let tabs = 0; let inQuotes = false; let atFieldStart = true; let sawContent = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') { if (s[i + 1] === '"') i++; else inQuotes = false; }
      continue;
    }
    if (c === '\n' || c === '\r') {
      if (sawContent || commas || tabs) break; // 첫 유효 줄까지만 본다
      atFieldStart = true; continue;           // 선행 빈 줄은 건너뛰기
    }
    if (c === '"' && atFieldStart) { inQuotes = true; sawContent = true; atFieldStart = false; continue; }
    if (c === ',') { commas++; atFieldStart = true; continue; }
    if (c === '\t') { tabs++; atFieldStart = true; continue; }
    if (c !== ' ') sawContent = true;
    atFieldStart = false;
  }
  return commas === 0 && tabs > 0 ? '\t' : ',';
}

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
  const delim = sniffDelimiter(s);
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
    } else if (c === delim) {
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

/**
 * 필수 헤더 미발견 시 원인 힌트 — 헤더 행이 "한 셀"로 읽혔고 그 안이 공백으로 나뉜 여러 단어면
 * 구분자 문제(공백 정렬 텍스트)다. "필수 헤더 없음"만으로는 사용자가 원인을 알 수 없어(실사용
 * 문의) 각 가져오기 파서가 필수 헤더 오류 뒤에 덧붙인다. 해당 없으면 빈 문자열.
 */
export function delimiterHint(headerRow) {
  const one = Array.isArray(headerRow) && headerRow.length === 1 ? String(headerRow[0]).trim() : '';
  return /\s/.test(one)
    ? ' 열이 하나로 읽혔습니다 — 쉼표(,) 또는 탭 구분 파일만 지원하며 공백으로 정렬한 텍스트는 열을 나눌 수 없습니다. 엑셀에서 "CSV(쉼표로 분리)"로 저장하거나 샘플 CSV 양식을 사용하세요.'
    : '';
}

/** 셀 배열 → CSV 한 줄(수식가드 + 필요한 경우만 따옴표). 단독 CR 도 quoting 한다. */
export function csvLine(cells) {
  return cells.map((c) => {
    const s = guardCell(c);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',');
}

export { BOM as CSV_BOM };
