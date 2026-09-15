/**
 * sanswitch/bulk.js — SAN 스위치 장비 CSV/자유텍스트 내보내기·가져오기·샘플(v2.513).
 *
 * 사용자 요청(2026-09-15): "san switch 도 같은 메뉴" — 스토리지가 v2.313/v2.317 에 가진
 * 대량 등록 기능(CSV·드라이런)에 자유텍스트를 더한 것을 스위치에도.
 *
 * ⚠ 스토리지와 **다른 점 하나가 결정적이다 — 식별 키**:
 *   `sanswitch/registry.js saveDevice` 는 신규 등록 시 **host 중복을 거부**한다(type 무관).
 *   그래서 동일 장비 판정은 **`host` 단독**이다. 스토리지처럼 `host+type` 으로 두면
 *   같은 host 를 다른 type 으로 적은 행이 'add' 로 판정됐다가 저장에서 예외로 떨어진다
 *   (드라이런 통과 = 저장 성공 이라는 계약이 깨진다).
 *
 * 보안(스토리지 CSV 와 같은 계약):
 *  · **비밀번호는 절대 내보내지 않는다** — export/sample 의 password 열은 값이 없다.
 *    가져오기에서는 받을 수 있고, 비우면 기존 비밀번호를 유지한다(saveDevice 규칙).
 *  · 셀은 `guardCell`(csvLine 내부)로 수식 인젝션 방어, 가져오기는 `unguardCell` 로 해제.
 *  · 행·셀 상한으로 대용량 동기 파싱 블로킹 방지.
 */

import { parseCsvRows, csvLine, unguardCell, delimiterHint, CSV_BOM } from '../util/csv.js';
import { analyzeBulkImport } from '../util/bulkImport.js';
import { parseFreeRows, rowsToFreeText, unmark } from '../util/bulkText.js';
import { isKnownType, isImplementedType, SAN_SWITCH_TYPES, collectMethodsFor } from './types.js';

/** 열 순서 — CSV·자유텍스트 공용. password 는 맨 끝(가져오기 전용). */
export const COLUMNS = ['type', 'name', 'host', 'username', 'collectMethod', 'sshPort', 'httpsPort', 'vfId', 'datacenter', 'agent', 'enabled', 'note', 'password'];

/** 헤더·키 별칭 — 스토리지와 **같은 어휘**를 쓴다(두 화면을 번갈아 쓰는 사용자가 헷갈리지 않게). */
export const ALIASES = {
  타입: 'type', 표시명: 'name', 이름: 'name', ip: 'host', fqdn: 'host',
  계정: 'username', user: 'username', 비밀번호: 'password', pw: 'password',
  method: 'collectMethod', 수집방식: 'collectMethod', collectmethod: 'collectMethod',
  port: 'sshPort', 포트: 'sshPort', sshport: 'sshPort', httpsport: 'httpsPort',
  vfid: 'vfId', vf: 'vfId',
  datacenterid: 'datacenter', 법인: 'datacenter', dc: 'datacenter',
  엣지: 'agent', 수집주체: 'agent', 활성: 'enabled', 메모: 'note', comment: 'note',
};

const bool = (v, dflt = true) => {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return dflt;
  return !['false', '0', 'no', 'n', 'off', '비활성', 'disabled', '아니오'].includes(s);
};

/** 한 행 빠른 검증(타입 구현 여부·host 존재) — registry 검증 전에 명확한 사유를 주기 위해. */
export function rowIssue(row) {
  if (!isKnownType(row.type)) return `알 수 없는 타입 '${row.type}'`;
  if (!isImplementedType(row.type)) return `미구현 타입 '${row.type}'`;
  if (!row.host) return 'host 누락';
  return null;
}

/* ────────────────── 내보내기 ────────────────── */

const rowOf = (d, dcName) => ({
  type: d.type || '', name: d.name || '', host: d.host || '', username: d.username || '',
  collectMethod: d.collectMethod || '',
  sshPort: String(d.sshPort || 22),
  httpsPort: d.collectMethod === 'rest' ? String(d.httpsPort || 443) : '',
  vfId: d.vfId == null ? '' : String(d.vfId),
  datacenter: dcName(d.datacenterId) || d.datacenterId || '',
  agent: d.agent || '',                             // 빈 값 = 중앙 직접 수집
  enabled: d.enabled === false ? 'false' : 'true',
  note: d.note || '',
  password: '',                                     // 절대 내보내지 않는다
});

export function devicesToCsv(devices, dcName = (x) => x) {
  const lines = [csvLine(COLUMNS)];
  for (const d of devices || []) {
    const r = rowOf(d, dcName);
    lines.push(csvLine(COLUMNS.map((c) => r[c])));
  }
  return CSV_BOM + lines.join('\r\n') + '\r\n';
}

export function devicesToText(devices, dcName = (x) => x) {
  return rowsToFreeText((devices || []).map((d) => rowOf(d, dcName)), COLUMNS, {
    comment: [
      'SAN 스위치 목록(자유텍스트) — 이 파일을 고쳐 그대로 가져올 수 있습니다.',
      '· 열 구분: 탭 · | · 쉼표 · 공백 중 아무거나. 빈칸은 `-`.',
      '· 비밀번호는 보안상 내보내지 않습니다 — 새로 넣을 때만 마지막 열에 적으세요(비우면 기존 유지).',
    ].join('\n'),
  });
}

/* ────────────────── 샘플 ────────────────── */

const implTypes = () => SAN_SWITCH_TYPES.filter((t) => t.implemented).map((t) => t.type);

export function sampleCsv() {
  const impl = implTypes().join('|');
  const methods = implTypes().flatMap((t) => collectMethodsFor(t).map((m) => (typeof m === 'string' ? m : m.method || m.value || ''))).filter(Boolean);
  const mHint = [...new Set(methods)].join('|') || 'ssh';
  const lines = [
    csvLine(COLUMNS),
    // 주석 행 — type 이 '#...' 라 rowIssue 에서 걸러진다(안내 목적). 실제 사용 시 이 행은 지운다.
    csvLine([`# type: ${impl}`, '# name: 표시명', '# host: IP/FQDN', '# username: 접속 계정',
      `# collectMethod: ${mHint}`, '# sshPort: 기본 22', '# httpsPort: REST 기본 443',
      '# vfId: Virtual Fabric 1~128(없으면 비움)', '# datacenter: 법인 이름 또는 ID',
      '# agent: 엣지 이름(비우면 중앙 직접 수집)', '# enabled: true|false', '# note: 메모',
      '# password: 비우면 기존 유지(신규는 필수)']),
    csvLine(['brocade', 'WA-SAN-01', '10.30.0.11', 'admin', 'ssh', '22', '', '', 'WA', 'agent-WA', 'true', '팹 A', 'ChangeMe!1']),
    csvLine(['brocade', 'WA-SAN-02', '10.30.0.12', 'admin', 'ssh', '22', '', '128', 'WA', 'agent-WA', 'true', '팹 B · VF 128', 'ChangeMe!2']),
  ];
  return CSV_BOM + lines.join('\r\n') + '\r\n';
}

export function sampleText() {
  const impl = implTypes().join(' | ');
  return [
    '# SAN 스위치 대량 등록 — 자유텍스트 샘플',
    '# 한 줄에 스위치 하나. `#` 줄과 빈 줄은 무시합니다. 아래 세 가지 표기를 모두 받습니다.',
    `# type 후보: ${impl}`,
    '#',
    '# ① 위치형 — 열 순서대로. 구분자는 탭·|·쉼표·공백 중 아무거나. 빈칸은 `-`.',
    `#   순서: ${COLUMNS.join(' ')}`,
    'brocade  WA-SAN-01  10.30.0.11  admin  ssh  22  -  -  WA  agent-WA  true  "팹 A"  ChangeMe!1',
    'brocade  WA-SAN-02  10.30.0.12  admin  ssh  22  -  128  WA  agent-WA  true  "팹 B · VF 128"  ChangeMe!2',
    '',
    '# ② 키=값형 — 아는 항목만 적습니다(순서 무관, 한글 키도 가능).',
    'type=brocade name=OC2-SAN-01 host=10.40.0.11 계정=admin 비밀번호=ChangeMe!3 법인=OC2',
    '',
    '# ③ 헤더형 — 첫 줄에 열 이름을 적으면 그 순서로 읽습니다(엑셀에서 헤더까지 복사한 경우).',
    'host  name  type  username',
    '10.40.0.12  OC2-SAN-02  brocade  admin',
    '',
  ].join('\n');
}

/* ────────────────── 가져오기 파싱 ────────────────── */

/** 공통 정규화 — CSV·자유텍스트가 **같은 행 형태**를 만든다(뒤 파이프라인 공유). */
function normRow(line, get) {
  const password = get('password', { trim: false });
  return {
    _line: line,
    type: get('type').toLowerCase(),
    name: get('name'),
    host: get('host'),
    username: get('username'),
    password,
    collectMethod: get('collectMethod').toLowerCase(),
    sshPort: get('sshPort'),
    httpsPort: get('httpsPort'),
    vfId: get('vfId'),
    datacenter: get('datacenter'),
    agent: get('agent'),
    enabled: bool(get('enabled')),
    note: get('note'),
    _hasPassword: password !== '',
  };
}

export function parseDevicesCsv(text) {
  let rows;
  try { rows = parseCsvRows(text, { maxRows: 2000, maxCell: 8192 }); }
  catch (e) { return { rows: [], error: e.message }; }
  if (rows.length < 2) return { rows: [], error: '헤더 + 최소 1개 데이터 행이 필요합니다.' };

  const header = rows[0].map((h) => unguardCell(h).trim().toLowerCase());
  const aliasOf = (h) => ALIASES[h] || (COLUMNS.includes(h) ? h : (COLUMNS.find((c) => c.toLowerCase() === h) || null));
  const col = {};
  header.forEach((h, i) => { const f = aliasOf(h); if (f && col[f] == null) col[f] = i; });
  if (col.name == null || col.host == null) return { rows: [], error: "필수 헤더 'name' 과 'host' 가 없습니다." + delimiterHint(rows[0]) };

  const out = [];
  rows.slice(1).forEach((cells, n) => {
    const get = (f, { trim = true } = {}) => {
      const i = col[f];
      if (i == null) return '';
      const raw = unguardCell(cells[i] ?? '');
      return trim ? raw.trim() : raw;
    };
    if (!get('name') && !get('host')) return;          // 완전 빈 행
    if (get('type').startsWith('#')) return;           // 샘플 주석 행
    out.push(normRow(n + 2, get));
  });
  if (!out.length) return { rows: [], error: 'name·host 가 모두 빈 행만 있습니다.' };
  return { rows: out, order: COLUMNS.filter((c) => col[c] != null) };
}

export function parseDevicesText(text, { defaults = {} } = {}) {
  const r = parseFreeRows(text, { fields: COLUMNS, aliases: ALIASES, defaults });
  if (r.error) return { rows: [], error: r.error, warnings: r.warnings, headerUsed: null, order: COLUMNS };
  const rows = r.rows
    .map((row) => normRow(row._line, (f) => unmark(row[f])))
    .filter((row) => row.name || row.host);
  if (!rows.length) return { rows: [], error: 'name·host 가 모두 빈 줄만 있습니다.', warnings: r.warnings, headerUsed: r.headerUsed, order: r.headerUsed || COLUMNS };
  return { rows, warnings: r.warnings, headerUsed: r.headerUsed, order: r.headerUsed || COLUMNS };
}

/* ────────────────── 드라이런 판정 ────────────────── */

/**
 * @param {Array} rows parseDevicesCsv/Text 결과
 * @param {{existingHost:(h:string)=>object|undefined, resolveDc:(v:string)=>string,
 *          validate:(input:object)=>string|null}} deps
 */
export function analyzeImport(rows, { existingHost, resolveDc, validate }) {
  return analyzeBulkImport(rows, {
    keyOf: (row) => String(row.host || '').toLowerCase(),   // ⚠ host 단독 — 파일 머리 주석 참조
    keyLabel: 'host',
    quickIssue: rowIssue,
    toInput: (row) => toSaveInput(row, resolveDc),
    existing: (row) => !!existingHost(row.host),
    validate,
  });
}

/**
 * 행 → `saveDevice` 입력. **드라이런 검증과 실제 저장이 같은 객체를 쓰게** 하는 단일 지점이다
 * (두 곳에서 각자 만들면 '검증 통과 후 저장 실패' 가 생긴다).
 * 기존 장비를 수정할 때는 호출부가 `id` 를 덧붙인다.
 */
export function toSaveInput(row, resolveDc = (x) => x) {
  return {
    type: row.type, name: row.name, host: row.host, username: row.username,
    password: row._hasPassword ? row.password : '',
    collectMethod: row.collectMethod,
    sshPort: row.sshPort, httpsPort: row.httpsPort, vfId: row.vfId,
    datacenterId: resolveDc(row.datacenter),
    agent: row.agent, enabled: row.enabled, note: row.note,
  };
}
