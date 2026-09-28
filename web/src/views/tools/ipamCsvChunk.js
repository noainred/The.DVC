/**
 * ipamCsvChunk.js — 큰 CSV 를 서버 한도(요청 본문 1MB · 한 번에 MANAGE_CHUNK_MAX 행) 안의 조각으로 나눈다(순수, v2.636).
 *
 * ⚠ 행 경계는 서버 `server/src/util/csv.js parseCsvRows` 와 **글자 그대로 같은 규칙**이어야 한다 — 서버는 조각마다
 * `_line = lineOffset + (조각 안 순번) + 2` 로 행 번호를 매기므로, 여기서 센 행과 서버가 센 행이 어긋나면 결과표의 행 번호가
 * 원래 파일과 달라진다(사용자가 엉뚱한 줄을 고친다). 같은 규칙:
 *   · 앞의 BOM 제거 · 구분자는 첫 유효 줄의 인용 밖 쉼표/탭으로(쉼표 우선) · 필드 **시작 위치**의 따옴표만 인용
 *   · 인용 안의 줄바꿈은 행 경계가 아니다 · CRLF 는 한 줄바꿈 · **모든 칸이 공백인 행은 버린다**(행 번호에서도 빠진다)
 * 첫 유효 행이 헤더다. 조각마다 헤더를 다시 붙인다(서버가 조각마다 열을 읽는다).
 */
const BOM = '﻿';

export function sniffDelimiter(s) {
  let commas = 0; let tabs = 0; let inQuotes = false; let atFieldStart = true; let sawContent = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') { if (s[i + 1] === '"') i++; else inQuotes = false; }
      continue;
    }
    if (c === '\n' || c === '\r') {
      if (sawContent || commas || tabs) break;
      atFieldStart = true; continue;
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
 * CSV → { delim, header:{raw, cells}, records:[{raw, cells}] }. raw 는 원문 조각(줄바꿈 제외)이라 그대로 다시 이어 보낼 수 있다.
 * 모든 칸이 공백인 행은 records 에 넣지 않는다(서버와 같은 규칙).
 */
export function splitCsvRecords(text) {
  let s = String(text ?? '');
  if (s.startsWith(BOM)) s = s.slice(BOM.length);
  const delim = sniffDelimiter(s);
  const out = [];
  let row = []; let field = ''; let inQuotes = false; let start = 0;
  const endRow = (endIdx) => {
    row.push(field); field = '';
    if (row.some((c) => c.trim() !== '')) out.push({ raw: s.slice(start, endIdx), cells: row });
    row = [];
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"' && field === '') {
      inQuotes = true;
    } else if (c === delim) {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      const end = i;
      if (c === '\r' && s[i + 1] === '\n') i++;
      endRow(end);
      start = i + 1;
    } else field += c;
  }
  if (field !== '' || row.length) endRow(s.length);
  const [header, ...records] = out;
  return { delim, header: header || null, records };
}

/** 문자열의 UTF-8 바이트 수(서버 본문 한도 비교용 — 한글은 3바이트). */
export function utf8Len(str) {
  let n = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

/**
 * 헤더를 붙인 조각들. JSON 으로 싸면 따옴표·줄바꿈이 이스케이프되어 커지므로 maxBytes 는 본문 한도(1MB)보다 넉넉히 작게.
 * @param {{header:{raw}, records:{raw}[]}} parsed splitCsvRecords 결과
 * @param {{maxRows?:number, maxBytes?:number, replace?:Map<number,string>}} opt  replace: 데이터 행 순번(0부터) → 대신 보낼 원문
 * @returns {{csv:string, lineOffset:number, rows:number}[]}
 */
export function chunkRecords(parsed, { maxRows = 2000, maxBytes = 600_000, replace = null } = {}) {
  if (!parsed?.header) return [];
  const head = parsed.header.raw;
  const headBytes = utf8Len(head) + 1;
  const chunks = [];
  let cur = []; let bytes = headBytes; let offset = 0;
  const flush = () => {
    if (!cur.length) return;
    chunks.push({ csv: `${head}\n${cur.join('\n')}\n`, lineOffset: offset, rows: cur.length });
    offset += cur.length; cur = []; bytes = headBytes;
  };
  parsed.records.forEach((r, i) => {
    const raw = replace && replace.has(i) ? replace.get(i) : r.raw;
    const b = utf8Len(raw) + 1;
    if (cur.length && (cur.length >= maxRows || bytes + b > maxBytes)) flush();
    cur.push(raw); bytes += b;
  });
  flush();
  return chunks;
}

/** 헤더 칸 정규화 — 서버 manageCsv 의 norm 과 같다(앞 작은따옴표 역가드·공백/밑줄/하이픈/괄호 제거·소문자). */
export function normHeader(h) {
  let s = String(h ?? '');
  if (s.startsWith("'") && /^'[=+\-@\t\r]/.test(s)) s = s.slice(1);
  return s.trim().toLowerCase().replace(/[\s_\-()]/g, '');
}
const IP_ALIASES = ['ip', 'ip주소', 'ipaddress', 'address'];
/** 헤더에서 ip 열 위치(-1 = 없음). */
export function ipColumnIndex(headerCells) {
  return (headerCells || []).findIndex((h) => IP_ALIASES.includes(normHeader(h)));
}

/**
 * 조각별 검증 결과를 합치고, **조각을 넘나드는 같은 IP** 를 찾는다(서버는 조각 안의 중복만 본다).
 * 뒤에 나온 행을 오류로 바꾸고, 적용 때 그 행을 주석 행으로 바꿔 보낼 목록(skip: 데이터 행 순번)을 준다.
 * @param {{report:object[]}[]} results 조각 순서대로 서버 dryRun 응답
 * @returns {{ report:object[], summary:object, skip:Set<number> }}
 */
export function mergeManageReports(results) {
  const report = [];
  for (const r of results || []) for (const x of (r?.report || [])) report.push({ ...x });
  report.sort((a, b) => (a.line || 0) - (b.line || 0));
  const firstLine = new Map();
  const skip = new Set();
  for (const x of report) {
    if (x.action === 'error' || !x.ip) continue;
    if (firstLine.has(x.ip)) {
      x.action = 'error';
      x.reason = `파일 안에서 같은 IP 가 두 번 나옵니다(${firstLine.get(x.ip)}행) — 어느 행을 쓸지 모호해 이 행은 적용하지 않습니다.`;
      x.changes = [];
      skip.add(x.line - 2);
    } else firstLine.set(x.ip, x.line);
  }
  const summary = { create: 0, update: 0, same: 0, clear: 0, error: 0 };
  for (const x of report) if (summary[x.action] != null) summary[x.action] += 1;
  return { report, summary, skip };
}

/** 적용 때 건너뛸 데이터 행을 대신할 주석 행(서버가 ip 칸이 '#' 로 시작하면 건너뛴다 — 행 번호는 그대로 유지된다). */
export function commentRecord(ipIdx, delim) {
  return `${delim.repeat(Math.max(0, ipIdx))}#skip-duplicate`;
}
