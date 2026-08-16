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

import { parseCsvRows, csvLine, unguardCell, CSV_BOM } from '../util/csv.js';
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
  const seenInFile = new Map(); // host|type → 첫 등장 행 번호(파일 내 중복 검출)
  const report = [];
  const summary = { add: 0, update: 0, error: 0, withPassword: 0 };
  for (const row of rows) {
    const base = { line: row._line, name: row.name || row.host, host: row.host, type: row.type, hasPassword: !!row._hasPassword };
    const quick = rowIssue(row);
    const k = `${row.host}|${row.type}`;
    const dupLine = seenInFile.get(k);
    let action = 'error'; let reason = null;
    if (quick) reason = quick;
    else if (dupLine) reason = `파일 내 중복 — ${dupLine}행과 같은 host+type(어느 행이 저장될지 모호)`;
    else {
      // 실제 저장과 동일한 입력 형태로 검증(datacenter 해석 포함) — 규칙 단일 소스.
      reason = validate({ type: row.type, name: row.name, host: row.host, username: row.username,
        password: row._hasPassword ? row.password : '', datacenterId: resolveDc(row.datacenter) });
      if (!reason) action = existingKey(row.host, row.type) ? 'update' : 'add';
    }
    if (!dupLine) seenInFile.set(k, row._line);
    if (row._hasPassword && action !== 'error') summary.withPassword++;
    summary[action === 'error' ? 'error' : action]++;
    report.push({ ...base, action, reason });
  }
  return { report, summary };
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
  if (col.name < 0 || col.host < 0) return { rows: [], error: "필수 헤더 'name' 과 'host' 가 없습니다." };

  const cell = (cells, i, { trim = true } = {}) => {
    if (i < 0) return '';
    const raw = unguardCell(cells[i] ?? '');
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
