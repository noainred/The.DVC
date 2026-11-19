/**
 * pdu/csv.js — PDU 장비 CSV 내보내기/가져오기/샘플(사용자 요구: '다수 PDU 를 일괄 입력·수정').
 *
 * storage/csv.js 와 같은 계약 — 공용 파서(util/csv.js, RFC4180 + 수식 인젝션 방어)를 재사용한다.
 *
 * 보안:
 *  - **비밀번호는 기본적으로 내보내지 않는다**(export/sample 은 password 열을 빈 값으로 둔다).
 *    가져오기에서는 받을 수 있고(일괄 등록 편의), 비우면 기존 비밀번호를 유지한다(saveDevice 규칙).
 *  - 셀은 csvLine 이 guardCell 로 수식 인젝션(`=`,`+`,`-`,`@` 시작)을 막고, 가져오기는
 *    unguardCell 로 쌍을 해제한다.
 *  - 행/셀 상한으로 대용량 CSV 동기 파싱 블로킹을 막는다.
 *
 * 멱등성: **host** 를 동일 장비 식별 키로 본다 — 같은 host 가 이미 있으면 그 id 로 수정,
 *   없으면 신규. 그래서 export → 편집 → import 왕복이 안전하다.
 * 빈 칸(결정 78 남긴 것 ③): 수정 행의 빈 칸 · 없는 열 = 저장값 유지, 값을 지우려면 `-` 하나(새 장비는 빈 칸 · `-` 모두 기본값).
 *
 * ⚠ 센서/PDU 수량 열이 없는 것은 의도다 — 수집기가 장비에 물어 자동 탐지하므로 사람이 적을
 *   필요가 없고, 적어 두면 현장에서 센서를 늘렸을 때 CSV 가 낡은 진실이 된다.
 */

import { parseCsvRows, csvLine, unguardCell, delimiterHint, CSV_BOM } from '../util/csv.js';
import { EMPTY_MARK } from '../util/bulkText.js';

export const CSV_COLUMNS = ['name', 'host', 'username', 'sshPort', 'datacenter', 'agent', 'enabled', 'note', 'password'];

const MAX_ROWS = 5000;
const MAX_CELL = 2000;

const bool = (v, dflt = true) => {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return dflt;
  return !['false', '0', 'no', 'n', 'off', '비활성', 'disabled', '아니오'].includes(s);
};

/**
 * 등록 목록 → CSV 문자열(BOM + 헤더 + 행).
 * @param devices listDevices() 결과(비밀번호 미포함)
 * @param dcName  datacenterId → 표시명
 * @param opts    includePasswords 를 쓰려면 listDevicesWithSecrets() 를 넘겨야 하며,
 *                **호출부가 소유자 게이트 + 감사로그를 책임진다**(평문 자격증명 덤프이므로).
 */
export function devicesToCsv(devices = [], dcName = (x) => x, { includePasswords = false } = {}) {
  const lines = [csvLine(CSV_COLUMNS)];
  for (const d of devices) {
    lines.push(csvLine([
      d.name || '',
      d.host || '',
      d.username || '',
      d.sshPort || 22,
      dcName(d.datacenterId) || d.datacenterId || '',
      d.agent || '',                                  // 빈 값 = 중앙 직접 수집
      d.enabled === false ? 'false' : 'true',
      d.note || '',
      includePasswords ? (d.password || '') : '',     // 기본: 절대 내보내지 않음
    ]));
  }
  return CSV_BOM + lines.join('\r\n') + '\r\n';
}

/** 붙여넣기용 샘플(주석 대신 예시 2행). 비밀번호 열은 비워 둔다. */
export function sampleCsv() {
  return CSV_BOM + [
    csvLine(CSV_COLUMNS),
    csvLine(['9B01_PDU_01', '10.94.10.11', 'apc', 22, 'OC2', '', 'true', '9층 B열 랙', '']),
    csvLine(['WA_PDU_01', '10.93.20.31', 'apc', 22, 'WA', '엣지 WA', 'true', '원격지 — 엣지 위임 수집', '']),
  ].join('\r\n') + '\r\n';
}

/**
 * CSV → 장비 입력 배열. 검증은 하지 않고 **형태만** 맞춘다(saveDevice 가 최종 검증).
 * @param text CSV 원문
 * @param dcIdOf 표시명/ID → datacenterId 해석기(이름·ID 둘 다 허용)
 * @returns { rows:[], errors:[] } rows 는 saveDevice 입력 형태
 */
export function csvToDevices(text, dcIdOf = (x) => x) {
  const raw = parseCsvRows(String(text || ''), { maxRows: MAX_ROWS, maxCell: MAX_CELL });
  if (!raw.length) return { rows: [], errors: ['CSV 에 내용이 없습니다.'] };

  const header = raw[0].map((c) => unguardCell(c).trim().toLowerCase());
  // 헤더 없이 붙여넣는 경우도 허용 — 첫 셀이 알려진 열 이름이 아니면 기본 순서로 본다.
  const hasHeader = header.includes('host') || header.includes('name');
  const cols = hasHeader ? header : CSV_COLUMNS.map((c) => c.toLowerCase());
  const at = (row, key) => {
    const i = cols.indexOf(key);
    return i >= 0 ? unguardCell(row[i] ?? '').trim() : '';
  };
  // 결정(78 남긴 것 ③ — CSV 빈 칸 계약): 수정 행의 **빈 칸(또는 파일에 없는 열)** = 저장값 유지, **`-` 하나** = 비움(명시 — 새 장비면 기본값).
  //   예전에는 빈 agent · enabled · note · datacenter 가 저장값을 덮었다 — 빈 agent 한 칸이 엣지 위임 PDU 를 중앙 직접 수집으로 바꿨다.
  //   `_blank` = 빈 칸이었던 필드(라우트가 수정 행이면 그 키를 저장 입력에서 빼 saveDevice(normalize)가 저장값을 쓰게 한다).
  //   비밀번호 칸은 이 표지 밖이다(빈 칸 = 유지 · `-` 도 글자 그대로 — 예전 규약).
  const opt = (row, key, blank, field = key) => {
    const v = at(row, key);
    if (v === EMPTY_MARK) return '';
    if (!v) blank.push(field);
    return v;
  };

  const rows = [];
  const errors = [];
  for (let i = hasHeader ? 1 : 0; i < raw.length; i++) {
    const r = raw[i];
    if (!r || r.every((c) => !String(c ?? '').trim())) continue; // 빈 줄
    const host = at(r, 'host');
    if (!host && !at(r, 'name')) continue;
    if (!host) { errors.push(`${i + 1}행: host 가 비어 있습니다.`); continue; }
    const blank = [];
    const name = opt(r, 'name', blank);
    const portRaw = opt(r, 'sshport', blank, 'sshPort');
    const userRaw = opt(r, 'username', blank);
    const dcRaw = opt(r, 'datacenter', blank, 'datacenterId');
    const agent = opt(r, 'agent', blank);
    const enabledRaw = opt(r, 'enabled', blank);
    const note = opt(r, 'note', blank);
    rows.push({
      name: name || host,
      host,
      username: userRaw || 'apc',
      sshPort: portRaw ? Number(portRaw) : 22,
      // 78회차 F5 → 결정(78 남긴 것 ③): 기본값('apc' · 22 · 켬 · 빈 값)은 **새 장비**에만 쓴다. 수정 행에서 기본값으로 덮으면 계정 · 포트가 바뀐 것으로
      //   판정돼(saveDevice pduAccessMoved) 저장 비밀번호가 조용히 버려졌고, 빈 agent 가 위임 장비를 중앙 직접으로 바꿨다. 저장 경로(normalize)는 아는 필드만 읽으므로 이 표지는 저장되지 않는다.
      ...(blank.length ? { _blank: blank } : {}),
      datacenterId: dcIdOf(dcRaw) || '',
      agent,
      enabled: bool(enabledRaw),
      note,
      password: at(r, 'password'),   // 비우면 saveDevice 가 기존 값을 유지
      _line: i + 1,
    });
  }
  return { rows, errors, delimiter: delimiterHint(raw[0]) };
}
