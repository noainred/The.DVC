/**
 * collector/csv.js — 수집 서버(원격) CSV 내보내기/가져오기/샘플(v2.338, 사용자 요구).
 *
 * 목적: 설정 › 수집 서버(원격)의 등록 목록을 CSV 로 내려받아 백업·편집·타 환경 이관에 쓰고,
 * 편집한 CSV 를 일괄 가져온다. 스토리지 장비 CSV(v2.313·2.317, storage/csv.js)와 같은 골격 —
 * 공용 파서(util/csv.js — RFC4180·수식 인젝션 방어) 재사용, 드라이런(문법 검증) 후 커밋.
 *
 * 보안(중요):
 *  - **토큰은 기본적으로 내보내지 않는다**(export 의 token 컬럼은 빈 값) — listCollectors 가
 *    토큰을 redact 하는 것과 같은 계약. `?tokens=1` 은 requireSettingsOwner 게이트 + 감사로그
 *    (스토리지 비밀번호 포함 내보내기와 동일 규칙). 가져오기에서 token 을 비우면 기존 토큰 유지.
 *  - 셀은 csvLine(guardCell)로 수식 인젝션 방어, 가져오기는 unguardCell 로 쌍 해제.
 *
 * 멱등성/덮어쓰기(사용자 요구 'overwrite 여부 확인'): **id(대소문자 무시)** 가 동일 수집 서버
 * 식별 키다(registry 의 dedupeByIdCase 와 같은 규칙). 같은 id 가 이미 있으면 그 행의 동작은
 * '덮어쓰기(overwrite)'로 판정되고, 커밋 시 overwrite=true 를 명시해야만 적용된다(미명시 시
 * 해당 행은 건너뛰고 skipped 로 보고 — 실수로 기존 URL/매핑을 갈아엎는 사고 방지).
 */

import { parseCsvRows, csvLine, unguardCell, delimiterHint, CSV_BOM } from '../util/csv.js';

// 내보내기/샘플 공통 컬럼 순서(token 은 가져오기 전용이라 맨 끝 — export 는 기본 빈 값).
export const CSV_COLUMNS = ['id', 'name', 'url', 'datacenter', 'vcenterId', 'enabled', 'token'];

const bool = (v, dflt = true) => {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return dflt;
  return !['false', '0', 'no', 'n', 'off', '비활성', 'disabled', '아니오'].includes(s);
};

/**
 * 수집 서버 목록 → CSV 문자열(BOM + 헤더 + 행).
 * @param {Array} collectors loadCollectors() 결과(토큰 평문 보유 — includeTokens 아닐 땐 안 쓴다).
 * @param {{includeTokens?:boolean}} [opts] 기본 false — token 컬럼을 빈 값으로 유지.
 *   true 로 쓰려면 **호출부가 requireSettingsOwner 게이트 + 감사로그를 책임진다**(자격증명 덤프).
 */
export function collectorsToCsv(collectors, { includeTokens = false } = {}) {
  const lines = [csvLine(CSV_COLUMNS)];
  for (const c of collectors || []) {
    lines.push(csvLine([
      c.id || '', c.name || '', c.url || '', c.datacenter || '', c.vcenterId || '',
      c.enabled === false ? 'false' : 'true',
      includeTokens ? (c.token || '') : '',   // 기본: 절대 내보내지 않음(선택 시만)
    ]));
  }
  return CSV_BOM + lines.join('\r\n') + '\r\n';
}

/** 샘플 CSV — 헤더 + 컬럼 설명 주석 행 + 예시 2행. 주석 행은 가져오기에서 자동으로 걸러진다. */
export function sampleCsv() {
  const lines = [
    csvLine(CSV_COLUMNS),
    csvLine(['# id: 엣지(에이전트) 이름 — 대소문자 무시 동일 키', '# name: 표시 이름', '# url: http(s)://호스트:포트',
      '# datacenter: 법인/사이트 라벨(선택)', '# vcenterId: 원격 호스트 귀속 vCenter(선택)',
      '# enabled: true|false', '# token: 비우면 기존 유지(신규는 없음)']),
    csvLine(['WA-Edge', '바르샤바 수집기', 'http://10.20.0.10:4000', 'WA', 'vc-wa-01', 'true', 'ChangeMe-Token']),
    csvLine(['KR-Edge', '한국 수집기', 'http://10.10.0.10:4000', '한국', '', 'true', '']),
  ];
  return CSV_BOM + lines.join('\r\n') + '\r\n';
}

/**
 * CSV 텍스트 → 수집 서버 입력 객체 배열(순수 — 저장은 라우트에서 add/updateCollector 로).
 * 헤더 별칭 허용, `#` 로 시작하는 id 행(샘플 주석)은 스킵. token 은 공백이 유의미할 수 있어
 * trim 하지 않는다.
 * @returns {{rows: Array<{_line:number, ...input}>, error?: string}}
 */
export function parseCollectorsCsv(text) {
  let rows;
  try { rows = parseCsvRows(text, { maxRows: 2000, maxCell: 8192 }); }
  catch (e) { return { rows: [], error: e.message }; }
  if (rows.length < 2) return { rows: [], error: '헤더 + 최소 1개 데이터 행이 필요합니다.' };

  const header = rows[0].map((h) => unguardCell(h).trim().toLowerCase());
  const idx = (...names) => { for (const n of names) { const i = header.indexOf(n); if (i >= 0) return i; } return -1; };
  const col = {
    id: idx('id', '아이디', '에이전트'), name: idx('name', '표시명', '이름'), url: idx('url', '주소'),
    datacenter: idx('datacenter', 'datacenterid', '법인', 'dc'), vcenterId: idx('vcenterid', 'vcenter'),
    enabled: idx('enabled', '활성'), token: idx('token', '토큰'),
  };
  if (col.id < 0 || col.url < 0) return { rows: [], error: "필수 헤더 'id' 와 'url' 이 없습니다." + delimiterHint(rows[0]) };

  const cell = (cells, i, { trim = true } = {}) => {
    if (i < 0) return '';
    const raw = unguardCell(cells[i] ?? '');
    return trim ? raw.trim() : raw;
  };
  const out = [];
  rows.slice(1).forEach((cells, n) => {
    const id = cell(cells, col.id);
    const url = cell(cells, col.url);
    if (!id && !url) return;                       // 완전 빈 행 스킵
    if (id.startsWith('#')) return;                // 샘플 주석 행 스킵
    out.push({
      _line: n + 2,                                // 사람용 행 번호(헤더=1)
      id,
      name: cell(cells, col.name) || id,           // name 비면 id 로 채움(등록 폼과 같은 편의)
      url,
      datacenter: cell(cells, col.datacenter),
      vcenterId: cell(cells, col.vcenterId),
      enabled: bool(cell(cells, col.enabled)),
      token: cell(cells, col.token, { trim: false }),
      _hasToken: col.token >= 0 && cell(cells, col.token, { trim: false }) !== '',
    });
  });
  return { rows: out };
}

/**
 * 가져오기 무결성 검사(드라이런·커밋 공용 — 순수 함수, 저장 없음). 행마다 실제 저장과 **같은
 * 검증**(validate = registry.collectorInputIssue 주입)을 돌려 동작(add/overwrite/error)을
 * 판정한다 — 드라이런 통과 = 실제 가져오기 성공 보장(같은 규칙). 파일 내부 중복(id 대소문자
 * 무시)이 두 번 나오면 뒤 행을 오류로 — 어느 행이 이기는지 모호한 채 덮어쓰는 사고 방지.
 *
 * @param {Array} rows parseCollectorsCsv().rows
 * @param {{existingId:(id:string)=>string|undefined, validate:(input:object)=>string|null}} deps
 *   existingId: 대소문자 무시 조회 → 기존 항목의 실제 id(없으면 undefined)
 * @returns {{report:Array, summary:{add:number,overwrite:number,error:number,withToken:number}}}
 */
export function analyzeCollectorsImport(rows, { existingId, validate }) {
  const seenInFile = new Map(); // lower(id) → 첫 등장 행 번호
  const report = [];
  const summary = { add: 0, overwrite: 0, error: 0, withToken: 0 };
  for (const row of rows) {
    const base = { line: row._line, id: row.id, name: row.name, url: row.url, hasToken: !!row._hasToken };
    const k = row.id.toLowerCase();
    const dupLine = seenInFile.get(k);
    let action = 'error'; let reason = null;
    if (dupLine) reason = `파일 내 중복 — ${dupLine}행과 같은 id(어느 행이 저장될지 모호)`;
    else {
      reason = validate({ id: row.id, name: row.name, url: row.url, datacenter: row.datacenter,
        vcenterId: row.vcenterId, enabled: row.enabled, token: row._hasToken ? row.token : '' });
      if (!reason) action = existingId(row.id) ? 'overwrite' : 'add';
    }
    if (!dupLine) seenInFile.set(k, row._line);
    if (row._hasToken && action !== 'error') summary.withToken++;
    summary[action === 'error' ? 'error' : action]++;
    report.push({ ...base, action, reason });
  }
  return { report, summary };
}
