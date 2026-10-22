/**
 * veeam/bulk.js — Veeam 백업 서버 **CSV/자유텍스트 내보내기·가져오기·샘플**(v2.751).
 *
 * 사용자 요청(2026-10-22): "veeam 서버 등록하는 것을 csv, 자유 형식으로 등록하는 기능 추가해줘".
 *
 * ⚠ 판정 코어를 복제하지 않는다 — `util/bulkImport.js`·`util/bulkText.js`·`util/csv.js` 에 위임한다(스토리지·SAN 스위치·Horizon 과 같은 코어,
 *   웹은 같은 모달 `views/tools/BulkDeviceIo.jsx`).
 * ⚠ 식별 키는 **host:port** 다 — 등록부 `veeam/registry.js saveServer` 의 중복 규칙(같은 host·port 는 두 번 등록할 수 없다)과 같다.
 *   기존 서버와 키가 같으면 그 서버의 id 로 갱신한다.
 *
 * 열:
 *  · vcenters — 이 Veeam 이 백업하는 vCenter. id 또는 표시 이름, 여러 개는 `;` 로 구분(자유텍스트의 열 구분자와 겹치지 않게).
 *  · agent    — 읽는 곳. 비우거나 '중앙'·'central' 이면 중앙 직접. 그 밖은 **중앙이 아는 엣지 이름**이어야 한다
 *               (cvp/formChoices.js pickAgent — 오타·대소문자 차이 방지, docs/rules/edge.md 의 '담당 엣지는 목록에서' 규칙).
 *  · password — 가져오기 전용. 내보내기·샘플에는 **값을 싣지 않는다**. 비우면 기존 유지 — 단 host·port·계정이 바뀌면 저장 비밀번호를
 *               승계하지 않으므로(util/secretCarry.js) 그 행은 비밀번호를 다시 적어야 한다(검증이 알려 준다).
 */
import { parseCsvRows, csvLine, unguardCell, delimiterHint, CSV_BOM } from '../util/csv.js';
import { analyzeBulkImport } from '../util/bulkImport.js';
import { parseFreeRows, rowsToFreeText, unmark, EMPTY_MARK } from '../util/bulkText.js';
import { pickAgent } from '../cvp/formChoices.js';
import { serverInputIssue, DEFAULT_PORT } from './registry.js';

/** 열 순서 — CSV·자유텍스트 공용. password 는 맨 끝(가져오기 전용). */
export const COLUMNS = ['name', 'host', 'port', 'username', 'vcenters', 'agent', 'apiVersion', 'enabled', 'note', 'password'];

/** 헤더·키 별칭(다른 대량 등록 화면과 같은 어휘). */
export const ALIASES = {
  이름: 'name', 표시명: 'name', 서버: 'name', server: 'name',
  ip: 'host', fqdn: 'host', 주소: 'host', address: 'host',
  포트: 'port',
  계정: 'username', user: 'username', 사용자: 'username',
  vcenter: 'vcenters', vcenterids: 'vcenters', 'vcenter목록': 'vcenters', 연결vcenter: 'vcenters', 백업vcenter: 'vcenters',
  엣지: 'agent', edge: 'agent', 담당엣지: 'agent', 읽는곳: 'agent', reader: 'agent',
  api: 'apiVersion', 'api판': 'apiVersion', apiversion: 'apiVersion', 'x-api-version': 'apiVersion',
  활성: 'enabled', 사용: 'enabled', 수집: 'enabled',
  메모: 'note', 비고: 'note',
  비밀번호: 'password', pw: 'password', pass: 'password',
};

const bool = (v, dflt = true) => {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return dflt;
  return !['false', '0', 'no', 'n', 'off', '비활성', 'disabled', '아니오', '끔'].includes(s);
};
const CENTRAL_WORDS = new Set(['중앙', 'central', '중앙직접', 'direct']);
export const keyOfHostPort = (host, port) => `${String(host || '').trim().toLowerCase()}:${Number(port) || DEFAULT_PORT}`;

/**
 * vCenter 칸 → id 목록. id(대소문자 무시) 또는 표시 이름으로 찾는다. 모르는 값은 unknown 으로 돌려준다(지어내지 않는다).
 * @param {string} cell
 * @param {Array<{id:string, name:string}>} vcenters
 */
export function resolveVcenters(cell, vcenters) {
  const list = Array.isArray(vcenters) ? vcenters : [];
  const ids = []; const unknown = []; const ambiguous = [];
  for (const tok of String(cell || '').split(/\s*;\s*/).map((x) => x.trim()).filter(Boolean).slice(0, 32)) {
    const t = tok.toLowerCase();
    let hit = list.find((v) => String(v.id).toLowerCase() === t);
    if (!hit) {
      const byName = list.filter((v) => String(v.name || '').toLowerCase() === t);
      if (byName.length > 1) { ambiguous.push(tok); continue; }
      [hit] = byName;
    }
    if (!hit) { unknown.push(tok); continue; }
    if (!ids.includes(hit.id)) ids.push(hit.id);
  }
  return { ids, unknown, ambiguous };
}

/* ────────────────── 내보내기 ────────────────── */

const rowOf = (s) => ({
  name: s.name || '', host: s.host || '', port: String(s.port || DEFAULT_PORT), username: s.username || '',
  vcenters: (s.vcenterIds || []).join(';'), agent: s.agent || '중앙', apiVersion: s.apiVersion || '',
  enabled: s.enabled === false ? 'false' : 'true', note: s.note || '',
  password: '',                                      // 절대 내보내지 않는다
});

export function serversToCsv(servers) {
  const lines = [csvLine(COLUMNS)];
  for (const s of servers || []) lines.push(csvLine(COLUMNS.map((c) => rowOf(s)[c])));
  return CSV_BOM + lines.join('\r\n') + '\r\n';
}

export function serversToText(servers) {
  return rowsToFreeText((servers || []).map(rowOf), COLUMNS, {
    comment: [
      'Veeam Backup & Replication 서버 목록(자유텍스트) — 이 파일을 고쳐 그대로 가져올 수 있습니다.',
      '· 열 구분: 탭 · | · 쉼표 · 공백 중 아무거나. 빈칸은 `-`. vcenters 의 여러 vCenter 는 `;` 로.',
      '· 비밀번호는 보안상 내보내지 않습니다 — 새로 넣을 때만 마지막 열에 적으세요(비우면 기존 유지).',
      '· host·port·계정 중 하나라도 바꾸면 저장된 비밀번호를 승계하지 않습니다(보안 규칙) — 그 행은 비밀번호를 다시 적으세요.',
    ].join('\n'),
  });
}

/* ────────────────── 샘플 ────────────────── */

export function sampleCsv() {
  const lines = [
    csvLine(COLUMNS),
    csvLine(['# name: 표시명', '# host: Veeam B&R 서버 IP·호스트명(스킴·포트 없이)', '# port: 비우면 9419', '# username: 읽기 전용 계정 권장',
      '# vcenters: vCenter id 또는 이름(여러 개는 ;)', '# agent: 읽는 곳(비우거나 중앙 = 중앙 직접 · 그 밖은 중앙이 아는 엣지 이름)',
      '# apiVersion: 비우면 1.1-rev0(v12.0)', '# enabled: true|false', '# note: 메모', '# password: 비우면 기존 유지(신규는 필수)']),
    csvLine(['AZ Veeam', '10.40.1.15', '9419', 'CORP\\svc-veeam-ro', 'vc-az', 'az-edge', '', 'true', 'Arizona DC', 'ChangeMe!1']),
    csvLine(['PL Veeam', 'vbr-pl.corp.local', '', 'CORP\\svc-veeam-ro', 'vc-pl;vc-pl-dr', 'pl-edge', '1.1-rev2', 'true', '', 'ChangeMe!2']),
  ];
  return CSV_BOM + lines.join('\r\n') + '\r\n';
}

export function sampleText() {
  return [
    '# Veeam 백업 서버 대량 등록 — 자유텍스트 샘플',
    '# 한 줄에 서버 하나. `#` 줄과 빈 줄은 무시합니다. 아래 세 가지 표기를 모두 받습니다.',
    '# vcenters 에 vCenter 가 여럿이면 `;` 로 잇습니다(공백·쉼표는 열 구분자라 쓰지 않습니다).',
    '#',
    '# ① 위치형 — 열 순서대로. 구분자는 탭·|·쉼표·공백 중 아무거나. 빈칸은 `-`.',
    `#   순서: ${COLUMNS.join(' ')}`,
    '"AZ Veeam"  10.40.1.15         9419  CORP\\svc-veeam-ro  vc-az        az-edge  -         true  "Arizona DC"  ChangeMe!1',
    '"PL Veeam"  vbr-pl.corp.local  -     CORP\\svc-veeam-ro  vc-pl;vc-pl-dr  pl-edge  1.1-rev2  true  -        ChangeMe!2',
    '',
    '# ② 키=값형 — 아는 항목만 적습니다(순서 무관, 한글 키도 가능).',
    'name="US Veeam" host=vbr-us.corp.local 계정=CORP\\svc-veeam-ro vcenters=vc-us-east 엣지=중앙 비밀번호=ChangeMe!3',
    '',
    '# ③ 헤더형 — 첫 줄에 열 이름을 적으면 그 순서로 읽습니다(엑셀에서 헤더까지 복사한 경우).',
    'host  name  username  vcenters  agent',
    'vbr-jp.corp.local  "JP Veeam"  CORP\\svc-veeam-ro  vc-jp  jp-edge',
    '',
  ].join('\n');
}

/* ────────────────── 가져오기 파싱 ────────────────── */

function normRow(line, get) {
  const password = get('password', { trim: false });
  return {
    _line: line,
    name: get('name'), host: get('host'), port: get('port'), username: get('username'),
    vcenters: get('vcenters'), agent: get('agent'), apiVersion: get('apiVersion'),
    enabled: bool(get('enabled')), note: get('note'),
    password, _hasPassword: password !== '',
  };
}

export function parseServersCsv(text) {
  let rows;
  try { rows = parseCsvRows(text, { maxRows: 2000, maxCell: 8192 }); } catch (e) { return { rows: [], error: e.message }; }
  if (rows.length < 2) return { rows: [], error: '헤더 + 최소 1개 데이터 행이 필요합니다.' };
  const header = rows[0].map((h) => unguardCell(h).trim().toLowerCase().replace(/\s+/g, ''));
  const aliasOf = (h) => ALIASES[h] || (COLUMNS.find((c) => c.toLowerCase() === h) || null);
  const col = {};
  header.forEach((h, i) => { const f = aliasOf(h); if (f && col[f] == null) col[f] = i; });
  if (col.host == null) return { rows: [], error: "필수 헤더 'host' 가 없습니다." + delimiterHint(rows[0]) };
  const out = [];
  rows.slice(1).forEach((cells, n) => {
    const get = (f, { trim = true } = {}) => {
      const i = col[f];
      if (i == null) return '';
      const raw = unguardCell(cells[i] ?? '');
      if (raw.trim() === EMPTY_MARK) return '';
      return trim ? raw.trim() : raw;
    };
    if (!get('host') && !get('name')) return;
    if (get('name').startsWith('#') || get('host').startsWith('#')) return; // 샘플 주석 행
    out.push(normRow(n + 2, get));
  });
  if (!out.length) return { rows: [], error: 'host·name 이 모두 빈 행만 있습니다.' };
  return { rows: out, order: COLUMNS.filter((c) => col[c] != null) };
}

export function parseServersText(text, { defaults = {} } = {}) {
  const r = parseFreeRows(text, { fields: COLUMNS, aliases: ALIASES, defaults });
  if (r.error) return { rows: [], error: r.error, warnings: r.warnings, headerUsed: null, order: COLUMNS };
  const rows = r.rows.map((row) => normRow(row._line, (f) => unmark(row[f]))).filter((row) => row.host || row.name);
  if (!rows.length) return { rows: [], error: 'host·name 이 모두 빈 줄만 있습니다.', warnings: r.warnings, headerUsed: r.headerUsed, order: r.headerUsed || COLUMNS };
  return { rows, warnings: r.warnings, headerUsed: r.headerUsed, order: r.headerUsed || COLUMNS };
}

/* ────────────────── 저장 입력 · 검증 ────────────────── */

/**
 * 행 → `saveServer` 입력. 드라이런 검증과 실제 저장이 **같은 객체**를 쓴다(단일 지점).
 * @param {object} row
 * @param {{ existing:(key:string)=>object|undefined, vcenters:Array, agents:string[] }} ctx
 * @returns {object} 입력 + `_issues`(vCenter·엣지 해석 오류 — 검증이 사유로 쓴다)
 */
export function toSaveInput(row, ctx) {
  const prev = ctx.existing(keyOfHostPort(row.host, row.port));
  const vc = resolveVcenters(row.vcenters, ctx.vcenters);
  const agentRaw = String(row.agent || '').trim();
  const ag = CENTRAL_WORDS.has(agentRaw.toLowerCase().replace(/\s+/g, '')) ? { value: '' } : pickAgent(agentRaw, ctx.agents, prev?.agent || '');
  const issues = [];
  if (vc.unknown.length) issues.push(`vCenter ‘${vc.unknown.join(', ')}’ 를 찾지 못했습니다 — 포탈에 등록된 vCenter id 또는 이름을 적으세요(여러 개는 ;)`);
  if (vc.ambiguous.length) issues.push(`vCenter 이름 ‘${vc.ambiguous.join(', ')}’ 이 둘 이상과 같습니다 — id 로 적으세요`);
  if (ag.error) issues.push(ag.error);
  const out = {
    ...(prev ? { id: prev.id } : {}),
    name: row.name, host: row.host, port: String(row.port || '').trim() === '' ? DEFAULT_PORT : row.port, username: row.username,
    vcenterIds: vc.ids.length ? vc.ids : (String(row.vcenters || '').trim() === '' && prev ? prev.vcenterIds : vc.ids),
    agent: ag.error ? agentRaw : ag.value, apiVersion: row.apiVersion, enabled: row.enabled, note: row.note,
    _issues: issues,
    // 같은 host:port 인데 계정이 바뀌면 저장 비밀번호를 승계하지 않는다(util/secretCarry.js) — 그 행은 비밀번호를 다시 적어야 한다.
    _moved: !!prev && String(prev.username || '').trim().toLowerCase() !== String(row.username || '').trim().toLowerCase(),
  };
  if (row._hasPassword) out.password = row.password;
  return out;
}

/** 저장 입력 검증 — 해석 오류가 먼저, 그다음 등록부 단일 규칙(serverInputIssue). 신규는 비밀번호 필수. */
export function inputIssue(input, { isNew = false } = {}) {
  if (input._issues?.length) return input._issues.join(' · ');
  const base = serverInputIssue({ ...input, password: input.password ?? '' });
  if (base) return base;
  if (isNew && !input.password) return '신규 서버는 비밀번호가 필요합니다(마지막 열).';
  if (input._moved && !input.password) return '계정이 바뀌어 저장된 비밀번호를 승계하지 않습니다(보안 규칙) — 비밀번호를 다시 적으세요(마지막 열).';
  return null;
}

/** 드라이런 판정. */
export function analyzeImport(rows, ctx) {
  return analyzeBulkImport(rows, {
    keyOf: (row) => keyOfHostPort(row.host, row.port),
    keyLabel: 'host:port',
    quickIssue: (row) => (!row.host ? 'host 누락 — Veeam B&R 서버 IP·호스트명을 적으세요' : !row.name ? 'name 누락 — 표시명을 적으세요' : null),
    toInput: (row) => toSaveInput(row, ctx),
    existing: (row) => !!ctx.existing(keyOfHostPort(row.host, row.port)),
    validate: (input) => inputIssue(input, { isNew: !input.id }),
  });
}

/** 저장할 때 내부 표지(_issues)를 뺀 입력. */
export function cleanInput(input) {
  const { _issues, _moved, ...rest } = input;
  return rest;
}
