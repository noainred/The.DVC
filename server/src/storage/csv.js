/**
 * storage/csv.js — 스토리지 장비 CSV 내보내기/가져오기/샘플(v2.313, 사용자 요구).
 *
 * 목적: 스토리지 모니터링 장비를 한 건씩 폼으로 넣는 대신 CSV 로 일괄 등록/수정하고,
 * 현재 등록분을 CSV 로 내려받아 백업·편집·타 환경 이관에 쓴다. iDRAC CSV 가져오기와 동일한
 * 공용 파서(util/csv.js — RFC4180·수식 인젝션 방어)를 재사용한다.
 *
 * 보안(중요):
 *  - **비밀번호는 절대 내보내지 않는다**(export/sample 모두 password 컬럼을 값 없이 두거나 뺀다) —
 *    listDevices 가 password 를 반환하지 않는 것과 같은 계약. 가져오기에서는 password 를 받을 수
 *    있고(일괄 등록 편의), 비우면 기존 비밀번호를 유지한다(saveDevice 규칙).
 *  - 셀은 guardCell 로 수식 인젝션(`=`,`+`,`-`,`@` 시작) 방어, 가져오기는 unguardCell 로 쌍 해제.
 *  - 행/셀 상한(maxRows·maxCell)으로 대용량 CSV 동기 파싱 블로킹을 막는다.
 *
 * 멱등성: 가져오기는 (host + type) 를 동일 장비 식별 키로 본다 — 같은 host·type 이 이미 있으면
 *   그 id 로 **수정**(update), 없으면 신규 추가. 그래서 export→편집→import 왕복이 안전하다.
 */

import { parseCsvRows, csvLine, unguardCell, delimiterHint, CSV_BOM } from '../util/csv.js';
import { analyzeBulkImport } from '../util/bulkImport.js';
import { parseFreeRows, rowsToFreeText, unmark, EMPTY_MARK } from '../util/bulkText.js';
import { isKnownType, isImplementedType, STORAGE_TYPES } from './types.js';

// 내보내기/샘플 공통 컬럼 순서(password 는 가져오기 전용이라 맨 끝 — export 는 값 비움).
export const CSV_COLUMNS = ['type', 'name', 'host', 'username', 'collectMethod', 'sshPort', 'datacenter', 'agent', 'enabled', 'note', 'password'];

const bool = (v, dflt = true) => {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return dflt;
  return !['false', '0', 'no', 'n', 'off', '비활성', 'disabled', '아니오'].includes(s);
};

/**
 * 등록 장비 목록 → CSV 문자열(BOM + 헤더 + 행).
 * @param {Array} devices 기본은 listDevices() 결과(비밀번호 미포함). includePasswords 를 쓰려면
 *   registry.listDevicesWithSecrets() 결과를 넘겨야 하며 **호출부가 소유자 게이트+감사로그를
 *   책임진다**(v2.317 사용자 요구 '패스워드 포함 여부 선택' — 평문 자격증명 덤프이므로).
 * @param {(id:string)=>string} dcName datacenterId → 표시명(없으면 id 그대로)
 * @param {{includePasswords?:boolean}} [opts] 기본 false — password 컬럼을 빈 값으로 유지.
 */
export function devicesToCsv(devices, dcName = (x) => x, { includePasswords = false } = {}) {
  const lines = [csvLine(CSV_COLUMNS)];
  for (const d of devices) {
    lines.push(csvLine([
      d.type || '', d.name || '', d.host || '', d.username || '',
      d.type === 'isilon' ? (d.collectMethod || 'ssh') : '',   // 수집 방식은 isilon 만 유의미
      d.collectMethod === 'ssh' || d.type === 'isilon' ? (d.sshPort || 22) : '',
      dcName(d.datacenterId) || d.datacenterId || '',          // 사람이 읽는 법인명(가져오기는 이름/ID 둘 다 허용)
      d.agent || '',                                            // 빈 값 = 중앙 직접
      d.enabled === false ? 'false' : 'true',
      d.note || '',
      includePasswords ? (d.password || '') : '',               // 기본: 절대 내보내지 않음(선택 시만)
    ]));
  }
  return CSV_BOM + lines.join('\r\n') + '\r\n';
}

/**
 * 가져오기 무결성 검사(v2.317, 사용자 요구 — 저장 전 드라이런). 순수 함수(저장 없음).
 * 행마다 실제 저장과 **같은 검증**(validate = registry.deviceInputIssue 주입)을 돌려
 * 동작(add/update/error)을 판정한다 — 드라이런 통과 = 실제 가져오기 성공 보장(같은 규칙).
 * 추가 검사: 파일 내부 중복(같은 host+type 이 두 번 나오면 뒤 행을 오류로 — 어느 행이
 * 이기는지 모호한 채 덮어쓰는 사고 방지).
 *
 * @param {Array} rows parseDevicesCsv().rows
 * @param {{existingKey:(h:string,t:string)=>string|undefined, resolveDc:(v:string)=>string,
 *          validate:(input:object)=>string|null}} deps
 * @returns {{report:Array, summary:{add:number,update:number,error:number,withPassword:number}}}
 */
export function analyzeImport(rows, { existingKey, resolveDc, validate }) {
  // v2.513: 판정 코어는 `util/bulkImport.js` 하나다(SAN 스위치도 같은 기능을 요구받았고, 복사하면
  // 두 판정이 갈라진다). 이 함수는 **시그니처를 유지하는 얇은 위임**이다 —
  // `storageMon.test.js` 가 이 형태를 고정하고 있어 호출부·테스트를 건드리지 않는다.
  return analyzeBulkImport(rows, {
    keyOf: (row) => `${row.host}|${row.type}`,   // 스토리지 식별 키는 host+type
    keyLabel: 'host+type',
    quickIssue: rowIssue,
    // 실제 저장과 동일한 입력 형태로 검증(datacenter 해석 포함) — 규칙 단일 소스.
    toInput: (row) => ({ type: row.type, name: row.name, host: row.host, username: row.username,
      password: row._hasPassword ? row.password : '', datacenterId: resolveDc(row.datacenter) }),
    existing: (row) => !!existingKey(row.host, row.type),
    validate,
  });
}

/** 샘플 CSV — 헤더 + 주석(설명) + 예시 2행. 관리자가 받아서 채워 넣는 템플릿. */
export function sampleCsv() {
  const impl = STORAGE_TYPES.filter((t) => t.implemented).map((t) => t.type).join('|');
  const lines = [
    csvLine(CSV_COLUMNS),
    // 주석 행(# 로 시작) — 파서가 컬럼 매핑을 못 찾는 헤더가 아니라 데이터 행이지만, 가져오기 시
    // type 이 '#...' 라 isKnownType 실패로 걸러진다(안내 목적). 실제 사용 시 이 행은 지운다.
    csvLine([`# type: ${impl} 중 하나`, '# name: 표시명', '# host: IP/FQDN', '# username: 접속 계정',
      '# collectMethod: isilon 만 ssh|api', '# sshPort: isilon ssh 기본 22', '# datacenter: 법인 이름 또는 ID(비우면 미지정)',
      '# agent: 엣지 이름(비우면 중앙 직접 수집)', '# enabled: true|false', '# note: 메모', '# password: 비우면 기존 유지(신규는 없음)']),
    csvLine(['isilon', 'WA-Isilon-01', '10.20.0.50', 'root', 'ssh', '22', 'WA', 'WA-Edge', 'true', '법인 WA 아카이브', 'ChangeMe!1']),
    csvLine(['powerstore', 'KR-PS-500T', '10.10.0.9', 'admin', '', '', '한국', '', 'true', '중앙 직접 수집', 'ChangeMe!2']),
  ];
  return CSV_BOM + lines.join('\r\n') + '\r\n';
}

/**
 * CSV 텍스트 → 장비 입력 객체 배열(순수 — 저장은 호출부에서 saveDevice 로). 헤더 별칭 허용.
 * datacenter 는 이름/ID 원문을 그대로 담고(해석은 라우트에서 listDatacenters 로), password 는
 * 앞뒤 공백이 유의미할 수 있어 trim 하지 않는다.
 * @returns {{rows: Array<{_line:number, ...input}>, error?: string}}
 */
export function parseDevicesCsv(text) {
  let rows;
  try { rows = parseCsvRows(text, { maxRows: 2000, maxCell: 8192 }); }
  catch (e) { return { rows: [], error: e.message }; }
  if (rows.length < 2) return { rows: [], error: '헤더 + 최소 1개 데이터 행이 필요합니다.' };

  const header = rows[0].map((h) => unguardCell(h).trim().toLowerCase());
  const idx = (...names) => { for (const n of names) { const i = header.indexOf(n); if (i >= 0) return i; } return -1; };
  const col = {
    type: idx('type', '타입'), name: idx('name', '표시명', '이름'), host: idx('host', 'ip', 'fqdn'),
    username: idx('username', '계정', 'user'), password: idx('password', '비밀번호', 'pw'),
    collectMethod: idx('collectmethod', 'method', '수집방식'), sshPort: idx('sshport', 'port', '포트'),
    datacenter: idx('datacenter', 'datacenterid', '법인', 'dc'), agent: idx('agent', '엣지', '수집주체'),
    enabled: idx('enabled', '활성'), note: idx('note', '메모', 'comment'),
  };
  if (col.name < 0 || col.host < 0) return { rows: [], error: "필수 헤더 'name' 과 'host' 가 없습니다." + delimiterHint(rows[0]) };

  const cell = (cells, i, { trim = true } = {}) => {
    if (i < 0) return '';
    const raw = unguardCell(cells[i] ?? '');
    // v2.516: `-` 는 자유텍스트에서 '이 칸은 비움' 표시다(EMPTY_MARK). CSV 에는 적용되지 않아
    // **같은 모달에서 형식만 바꿨을 때 규칙이 달랐다** — 자유텍스트로는 통과한 `-` 가 CSV 에서는
    // 값으로 읽혀 'Virtual Fabric ID 는 1~128' 오류가 났다(사용자 신고). 두 경로를 통일한다.
    // ⚠ 인용부호 해제는 하지 않는다 — CSV 는 parseCsvRows/unguardCell 이 이미 처리하며,
    //   여기서 또 벗기면 정당하게 인용된 값이 망가진다(그래서 unmark 전체를 쓰지 않는다).
    if (raw.trim() === EMPTY_MARK) return '';
    return trim ? raw.trim() : raw;
  };
  const out = [];
  rows.slice(1).forEach((cells, n) => {
    const name = cell(cells, col.name);
    const host = cell(cells, col.host);
    if (!name && !host) return;                    // 완전 빈 행 스킵
    const type = cell(cells, col.type);
    if (type.startsWith('#')) return;              // 샘플 주석 행 스킵
    out.push({
      _line: n + 2,                                // 사람용 행 번호(헤더=1)
      type, name, host,
      username: cell(cells, col.username),
      password: cell(cells, col.password, { trim: false }),
      collectMethod: cell(cells, col.collectMethod).toLowerCase(),
      sshPort: cell(cells, col.sshPort),
      datacenter: cell(cells, col.datacenter),
      agent: cell(cells, col.agent),
      enabled: bool(cell(cells, col.enabled)),
      note: cell(cells, col.note),
      _hasPassword: col.password >= 0 && cell(cells, col.password, { trim: false }) !== '',
    });
  });
  return { rows: out };
}

/** 가져오기 한 행 검증 요약(저장 전 사전 점검 — 라우트가 saveDevice 호출 전에 쓴다). */
export function rowIssue(row) {
  if (!isKnownType(row.type)) return `알 수 없는 타입 '${row.type}'`;
  if (!isImplementedType(row.type)) return `미구현 타입 '${row.type}'`;
  if (!row.host) return 'host 누락';
  return null;
}

/* ══════════════════ 자유텍스트(v2.513, 사용자 요청) ══════════════════
 * CSV 는 헤더·구분자를 맞춰야 하는데 현장에서 장비 목록은 위키 표·메일 본문·엑셀 한 컬럼으로
 * 온다. 그래서 붙여넣은 그대로 받는 경로를 둔다 — 파싱만 다르고 **이후 파이프라인
 * (analyzeImport → saveDevice)은 CSV 와 완전히 같다**(판정이 갈라지지 않게).
 */

/** 자유텍스트 위치형 열 순서 — password 는 맨 끝(내보내기는 늘 비운다). */
export const TEXT_FIELDS = ['type', 'name', 'host', 'username', 'collectMethod', 'sshPort', 'datacenter', 'agent', 'enabled', 'note', 'password'];

/** 별칭 — CSV 헤더 별칭(parseDevicesCsv 의 idx 목록)과 **같은 어휘**를 쓴다. */
export const TEXT_ALIASES = {
  타입: 'type', 표시명: 'name', 이름: 'name', ip: 'host', fqdn: 'host',
  계정: 'username', user: 'username', 비밀번호: 'password', pw: 'password',
  method: 'collectMethod', 수집방식: 'collectMethod', collectmethod: 'collectMethod',
  port: 'sshPort', 포트: 'sshPort', sshport: 'sshPort',
  datacenterid: 'datacenter', 법인: 'datacenter', dc: 'datacenter',
  엣지: 'agent', 수집주체: 'agent', 활성: 'enabled', 메모: 'note', comment: 'note',
};

/**
 * 자유텍스트 → 장비 입력 행. `parseDevicesCsv` 와 **같은 출력 형태**를 만든다
 * (`_line`·`_hasPassword`·enabled 불리언) — 그래야 뒤 파이프라인을 공유할 수 있다.
 * @param {string} text
 * @param {{defaults?:object}} [opts] 화면의 '공통값' — 빈 필드만 채운다
 * @returns {{rows:Array, error?:string, warnings:string[], headerUsed:string[]|null, order:string[]}}
 */
export function parseDevicesText(text, { defaults = {} } = {}) {
  const r = parseFreeRows(text, { fields: TEXT_FIELDS, aliases: TEXT_ALIASES, defaults });
  if (r.error) return { rows: [], error: r.error, warnings: r.warnings, headerUsed: null, order: TEXT_FIELDS };
  const rows = r.rows.map((row) => {
    // 내보내기가 빈칸에 넣은 `-` 와 공백 보존용 인용부호를 되돌린다(왕복 안전).
    const v = (f) => unmark(row[f]);
    const password = v('password');
    return {
      _line: row._line,
      type: v('type'), name: v('name'), host: v('host'),
      username: v('username'),
      password,
      collectMethod: v('collectMethod').toLowerCase(),
      sshPort: v('sshPort'),
      datacenter: v('datacenter'),
      agent: v('agent'),
      enabled: bool(v('enabled')),
      note: v('note'),
      _hasPassword: password !== '',
    };
  }).filter((row) => row.name || row.host);      // 완전 빈 행 스킵(CSV 와 같은 규칙)
  if (!rows.length) return { rows: [], error: 'name·host 가 모두 빈 줄만 있습니다.', warnings: r.warnings, headerUsed: r.headerUsed, order: r.headerUsed || TEXT_FIELDS };
  return { rows, warnings: r.warnings, headerUsed: r.headerUsed, order: r.headerUsed || TEXT_FIELDS };
}

/** 등록 장비 → 자유텍스트(정렬된 표). **비밀번호는 담지 않는다**(CSV export 와 같은 계약). */
export function devicesToText(devices, dcName = (x) => x) {
  const rows = (devices || []).map((d) => ({
    type: d.type || '', name: d.name || '', host: d.host || '', username: d.username || '',
    collectMethod: d.type === 'isilon' ? (d.collectMethod || 'ssh') : '',
    sshPort: d.collectMethod === 'ssh' || d.type === 'isilon' ? String(d.sshPort || 22) : '',
    datacenter: dcName(d.datacenterId) || d.datacenterId || '',
    agent: d.agent || '', enabled: d.enabled === false ? 'false' : 'true',
    note: d.note || '', password: '',                        // 절대 내보내지 않는다
  }));
  return rowsToFreeText(rows, TEXT_FIELDS, {
    comment: [
      '스토리지 장비 목록(자유텍스트) — 이 파일을 고쳐 그대로 가져올 수 있습니다.',
      '· 열 구분: 탭 · | · 쉼표 · 공백 중 아무거나. 빈칸은 `-`.',
      '· 비밀번호는 보안상 내보내지 않습니다 — 새로 넣을 때만 마지막 열에 적으세요(비우면 기존 유지).',
    ].join('\n'),
  });
}

/** 샘플 자유텍스트 — 세 가지 표기를 한 파일에서 보여 준다(위치형·키=값·헤더). */
export function sampleText() {
  const impl = STORAGE_TYPES.filter((t) => t.implemented).map((t) => t.type).join(' | ');
  return [
    '# 스토리지 장비 대량 등록 — 자유텍스트 샘플',
    '# 한 줄에 장비 하나. `#` 줄과 빈 줄은 무시합니다. 아래 세 가지 표기를 모두 받습니다.',
    `# type 후보: ${impl}`,
    '#',
    '# ① 위치형 — 열 순서대로. 구분자는 탭·|·쉼표·공백 중 아무거나. 빈칸은 `-`.',
    `#   순서: ${TEXT_FIELDS.join(' ')}`,
    'isilon  WA-Isilon-01  10.20.0.50  root  ssh  22  WA  WA-Edge  true  "법인 WA 아카이브"  ChangeMe!1',
    'powerstore  KR-PS-500T  10.10.0.9  admin  -  -  한국  -  true  "중앙 직접 수집"  ChangeMe!2',
    '',
    '# ② 키=값형 — 아는 항목만 적습니다(순서 무관, 한글 키도 가능).',
    'type=unity name=KR-Unity-01 host=10.10.0.20 계정=admin 비밀번호=ChangeMe!3 법인=한국',
    '',
    '# ③ 헤더형 — 첫 줄에 열 이름을 적으면 그 순서로 읽습니다(엑셀에서 헤더까지 복사한 경우).',
    'host  name  type  username',
    '10.10.0.31  KR-Isilon-02  isilon  root',
    '',
  ].join('\n');
}
