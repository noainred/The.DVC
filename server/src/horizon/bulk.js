/**
 * horizon/bulk.js — Horizon Connection Server **CSV/자유텍스트 내보내기·가져오기·샘플**(v2.525).
 *
 * 사용자 요청(2026-09-16): "호라이즌 서비스에 호라이즌 서버 등록이 필요하면 csv/text
 * import/export 기능 추가해줘".
 *
 * ⚠ **판정 코어를 복제하지 않는다** — `util/bulkImport.js`(v2.513)에 위임한다. 이 저장소는
 *   복제로 인한 사고를 겪었다(CLAUDE.md: `console/`↔`version_3/` 58~87% 중복, v2.506 svcmon
 *   권한 버그를 두 곳에 고쳐야 했던 일). 스토리지·SAN 스위치·Horizon 세 도구가 같은 코어를 쓴다.
 *
 * ⚠ **식별 키가 앞의 두 도구와 다르다 — `id` 단독이다.**
 *   `horizon.js upsertHorizon` 은 `id` 로 찾아 갱신하고, **host 중복은 거부하지 않는다**
 *   (스토리지 `host+type`, SAN 스위치 `host` 와 다르다). 여기서 키를 host 로 두면
 *   같은 host 를 가진 다른 팟(id 가 다른 정상 구성)이 '파일 내 중복' 으로 막히고,
 *   반대로 id 중복은 통과했다가 **조용히 덮어써진다**. `keyOf` 를 바꾸지 말 것.
 *
 * 보안(스토리지·SAN 과 같은 계약):
 *  · **비밀번호는 절대 내보내지 않는다** — export/sample 의 password 열은 값이 없다.
 *    가져오기에서는 받고, 비우면 기존 비밀번호를 유지한다(`normalize` 규칙).
 *  · ⚠ 단 **host·username·domain 이 바뀌면 저장 비밀이 승계되지 않는다**(`util/secretCarry.js`,
 *    v2.503 보안 불변조건) — 그래서 접속처를 바꾼 행은 비밀번호를 비우면 검증이
 *    'password는 필수입니다' 로 떨어진다. 이것이 **정상 동작**이다(우회를 만들지 말 것).
 *  · 셀은 `csvLine` 의 `guardCell` 로 수식 인젝션 방어, 가져오기는 `unguardCell` 로 해제.
 */

import { parseCsvRows, csvLine, unguardCell, delimiterHint, CSV_BOM } from '../util/csv.js';
import { analyzeBulkImport } from '../util/bulkImport.js';
import { parseFreeRows, rowsToFreeText, unmark, EMPTY_MARK } from '../util/bulkText.js';

/** 열 순서 — CSV·자유텍스트 공용. password 는 맨 끝(가져오기 전용). */
export const COLUMNS = ['id', 'name', 'host', 'username', 'domain', 'timeoutMs', 'enabled', 'password'];

/** 헤더·키 별칭 — 다른 대량 등록 화면과 **같은 어휘**를 쓴다(번갈아 쓰는 사용자가 헷갈리지 않게). */
export const ALIASES = {
  아이디: 'id', 식별자: 'id', serverid: 'id', server: 'id',
  표시명: 'name', 이름: 'name',
  ip: 'host', fqdn: 'host', url: 'host', 주소: 'host',
  계정: 'username', user: 'username', 'ad계정': 'username',
  도메인: 'domain', addomain: 'domain', 'ad도메인': 'domain',
  비밀번호: 'password', pw: 'password', pass: 'password',
  timeout: 'timeoutMs', 시한: 'timeoutMs', 'timeout(ms)': 'timeoutMs', timeoutms: 'timeoutMs',
  활성: 'enabled', 사용: 'enabled',
};

const bool = (v, dflt = true) => {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return dflt;
  return !['false', '0', 'no', 'n', 'off', '비활성', 'disabled', '아니오'].includes(s);
};

/**
 * 한 행 빠른 검증 — `normalize` 보다 **먼저** 명확한 사유를 주기 위한 것뿐이다.
 * 여기서 규칙을 새로 만들지 말 것(검증 진실의 원천은 `horizon.js normalize`).
 */
export function rowIssue(row) {
  if (!row.id) return 'id 누락 — Horizon 서버를 구분하는 키입니다(예: hz-seoul)';
  if (!row.host) return 'host 누락 — https://커넥션서버 형식으로 적으세요';
  return null;
}

/* ────────────────── 내보내기 ────────────────── */

const rowOf = (s) => ({
  id: s.id || '',
  name: s.name || '',
  host: s.host || '',
  username: s.username || '',
  domain: s.domain || '',
  timeoutMs: String(s.timeoutMs || 15_000),
  enabled: s.enabled === false ? 'false' : 'true',
  password: '',                                     // 절대 내보내지 않는다
});

export function serversToCsv(servers) {
  const lines = [csvLine(COLUMNS)];
  for (const s of servers || []) lines.push(csvLine(COLUMNS.map((c) => rowOf(s)[c])));
  return CSV_BOM + lines.join('\r\n') + '\r\n';
}

export function serversToText(servers) {
  return rowsToFreeText((servers || []).map(rowOf), COLUMNS, {
    comment: [
      'Horizon Connection Server 목록(자유텍스트) — 이 파일을 고쳐 그대로 가져올 수 있습니다.',
      '· 열 구분: 탭 · | · 쉼표 · 공백 중 아무거나. 빈칸은 `-`.',
      '· 비밀번호는 보안상 내보내지 않습니다 — 새로 넣을 때만 마지막 열에 적으세요(비우면 기존 유지).',
      '· host·계정·도메인 중 하나라도 바꾸면 저장된 비밀번호를 승계하지 않습니다(보안 규칙) — 그 행은 비밀번호를 다시 적으세요.',
    ].join('\n'),
  });
}

/* ────────────────── 샘플 ────────────────── */

export function sampleCsv() {
  const lines = [
    csvLine(COLUMNS),
    // 주석 행 — id 가 '#...' 로 시작하므로 파싱에서 걸러진다(안내 목적). 실제 사용 시 이 행은 지운다.
    csvLine(['# id: 고유 식별자(이 값으로 갱신 여부를 판정)', '# name: 표시명',
      '# host: https://커넥션서버', '# username: AD 계정', '# domain: AD 도메인',
      '# timeoutMs: 조회 시한(기본 15000)', '# enabled: true|false',
      '# password: 비우면 기존 유지(신규는 필수)']),
    csvLine(['hz-seoul', 'Seoul Horizon', 'https://horizon.seoul.example.com', 'svc-horizon', 'CORP', '15000', 'true', 'ChangeMe!1']),
    csvLine(['hz-warsaw', 'Warsaw Horizon', 'https://horizon.wa.example.com', 'svc-horizon', 'CORP', '30000', 'true', 'ChangeMe!2']),
  ];
  return CSV_BOM + lines.join('\r\n') + '\r\n';
}

export function sampleText() {
  return [
    '# Horizon Connection Server 대량 등록 — 자유텍스트 샘플',
    '# 한 줄에 서버 하나. `#` 줄과 빈 줄은 무시합니다. 아래 세 가지 표기를 모두 받습니다.',
    '#',
    '# ① 위치형 — 열 순서대로. 구분자는 탭·|·쉼표·공백 중 아무거나. 빈칸은 `-`.',
    `#   순서: ${COLUMNS.join(' ')}`,
    'hz-seoul   "Seoul Horizon"   https://horizon.seoul.example.com   svc-horizon   CORP   15000   true   ChangeMe!1',
    'hz-warsaw  "Warsaw Horizon"  https://horizon.wa.example.com      svc-horizon   CORP   30000   true   ChangeMe!2',
    '',
    '# ② 키=값형 — 아는 항목만 적습니다(순서 무관, 한글 키도 가능).',
    'id=hz-us name="US East Horizon" host=https://horizon.us.example.com 계정=svc-horizon 도메인=CORP 비밀번호=ChangeMe!3',
    '',
    '# ③ 헤더형 — 첫 줄에 열 이름을 적으면 그 순서로 읽습니다(엑셀에서 헤더까지 복사한 경우).',
    'host  id  name  username  domain',
    'https://horizon.jp.example.com  hz-jp  "Japan Horizon"  svc-horizon  CORP',
    '',
  ].join('\n');
}

/* ────────────────── 가져오기 파싱 ────────────────── */

/** 공통 정규화 — CSV·자유텍스트가 **같은 행 형태**를 만든다(뒤 파이프라인 공유). */
function normRow(line, get) {
  const password = get('password', { trim: false });
  return {
    _line: line,
    id: get('id'),
    name: get('name'),
    host: get('host'),
    username: get('username'),
    domain: get('domain'),
    timeoutMs: get('timeoutMs'),
    enabled: bool(get('enabled')),
    password,
    _hasPassword: password !== '',
  };
}

export function parseServersCsv(text) {
  let rows;
  try { rows = parseCsvRows(text, { maxRows: 2000, maxCell: 8192 }); }
  catch (e) { return { rows: [], error: e.message }; }
  if (rows.length < 2) return { rows: [], error: '헤더 + 최소 1개 데이터 행이 필요합니다.' };

  const header = rows[0].map((h) => unguardCell(h).trim().toLowerCase());
  const aliasOf = (h) => ALIASES[h] || (COLUMNS.includes(h) ? h : (COLUMNS.find((c) => c.toLowerCase() === h) || null));
  const col = {};
  header.forEach((h, i) => { const f = aliasOf(h); if (f && col[f] == null) col[f] = i; });
  if (col.id == null || col.host == null) return { rows: [], error: "필수 헤더 'id' 와 'host' 가 없습니다." + delimiterHint(rows[0]) };

  const out = [];
  rows.slice(1).forEach((cells, n) => {
    const get = (f, { trim = true } = {}) => {
      const i = col[f];
      if (i == null) return '';
      const raw = unguardCell(cells[i] ?? '');
      // v2.516 규약: `-` 는 '이 칸은 비움' 표시(EMPTY_MARK)다. CSV 와 자유텍스트가 **같은 규칙**을
      // 써야 한다 — 형식만 바꿨을 때 규칙이 달라지면 사용자가 원인을 찾지 못한다.
      if (raw.trim() === EMPTY_MARK) return '';
      return trim ? raw.trim() : raw;
    };
    if (!get('id') && !get('host')) return;            // 완전 빈 행
    if (get('id').startsWith('#')) return;             // 샘플 주석 행
    out.push(normRow(n + 2, get));
  });
  if (!out.length) return { rows: [], error: 'id·host 가 모두 빈 행만 있습니다.' };
  return { rows: out, order: COLUMNS.filter((c) => col[c] != null) };
}

export function parseServersText(text, { defaults = {} } = {}) {
  const r = parseFreeRows(text, { fields: COLUMNS, aliases: ALIASES, defaults });
  if (r.error) return { rows: [], error: r.error, warnings: r.warnings, headerUsed: null, order: COLUMNS };
  const rows = r.rows
    .map((row) => normRow(row._line, (f) => unmark(row[f])))
    .filter((row) => row.id || row.host);
  if (!rows.length) return { rows: [], error: 'id·host 가 모두 빈 줄만 있습니다.', warnings: r.warnings, headerUsed: r.headerUsed, order: r.headerUsed || COLUMNS };
  return { rows, warnings: r.warnings, headerUsed: r.headerUsed, order: r.headerUsed || COLUMNS };
}

/* ────────────────── 드라이런 판정 ────────────────── */

/**
 * @param {Array} rows parseServersCsv/Text 결과
 * @param {{existingId:(id:string)=>object|undefined, validate:(input:object)=>string|null}} deps
 */
export function analyzeImport(rows, { existingId, validate }) {
  return analyzeBulkImport(rows, {
    keyOf: (row) => String(row.id || '').trim().toLowerCase(),   // ⚠ id 단독 — 파일 머리 주석 참조
    keyLabel: 'id',
    quickIssue: rowIssue,
    toInput: toSaveInput,
    existing: (row) => !!existingId(row.id),
    validate,
  });
}

/**
 * 행 → `upsertHorizon` 입력. **드라이런 검증과 실제 저장이 같은 객체를 쓰게** 하는 단일 지점이다
 * (두 곳에서 각자 만들면 '검증 통과 후 저장 실패' 가 생긴다).
 */
export function toSaveInput(row) {
  const out = {
    id: row.id, name: row.name, host: row.host,
    username: row.username, domain: row.domain,
    enabled: row.enabled,
  };
  if (String(row.timeoutMs || '').trim()) out.timeoutMs = row.timeoutMs;
  if (row._hasPassword) out.password = row.password;
  return out;
}
