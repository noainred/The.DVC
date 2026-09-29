/**
 * cvp/bulk.js — Arista CloudVision(CVP) 서버 등록의 **CSV/자유텍스트 내보내기·가져오기·샘플**(v2.641).
 *
 * 사용자 요청(2026-09-28): "CVP 를 CSV import/export 하는 기능 추가해줘 CVP 가 많아" →
 * "비밀번호도 export 에 추가해줘" → "토큰도 포함".
 *
 * ⚠ **판정 코어를 복제하지 않는다** — `util/bulkImport.js`(v2.513)에 위임한다. 스토리지·SAN 스위치·
 *   Horizon 과 같은 코어·같은 화면(`web/src/views/tools/BulkDeviceIo.jsx`)을 쓴다(CLAUDE.md '코어는 하나다').
 *
 * ⚠⚠ **식별 키 — `registry.js saveServer` 가 판정하는 그대로다.**
 *   · `id` 가 있으면 그 id(없는 id 면 saveServer 도 '없는 CVP 서버입니다.' 로 던진다 → 같은 사유로 오류).
 *   · `id` 가 없으면 **주소(baseUrlOf 로 정규화한 origin) + 담당 엣지(대소문자 무시)** — saveServer 가 새 등록에서
 *     '같은 주소·같은 담당의 CVP 서버가 이미 등록되어 있습니다' 로 거부하는 바로 그 조합이다. 그래서 id 없이
 *     export→편집→import 해도 **복제되지 않고 그 서버의 수정**이 된다(멱등).
 *   · agent 열이 아예 없는 파일에서 같은 주소의 서버가 둘 이상이면(담당 엣지만 다름) **어느 것인지 모른다** —
 *     추측하지 않고 오류로 돌려준다(id 또는 agent 열로 구분하라고 말한다).
 *   · 등록부 id 는 포탈이 발급하므로(`cvp-…`) 새 서버의 id 를 파일이 정할 수는 없다 — 새로 넣으려면 id 칸을 비운다.
 *
 * ⚠⚠ **드라이런 통과 = 실제 저장 성공**: `prepareRow` 가 저장 입력을 만드는 **단일 지점**이고, 판정은
 *   `routes/api/cvp.js saveRoute` 와 같은 순서(pickAgent → pickDatacenter → serverInputIssue)다. 드라이런과 저장이
 *   각자 입력을 만들면 '검증 통과 후 저장 실패' 가 생긴다(horizon/bulk.js toSaveInput 과 같은 판단).
 *
 * ⚠ **파일에 없는 열은 건드리지 않는다**(수정 행) — CSV 헤더에 없는 열, 자유텍스트 키=값 줄에 적지 않은 키,
 *   위치형 줄에서 뒤쪽에 아예 없는 칸은 저장값을 유지한다. 특히 `agent` 를 빠뜨린 한 줄(‘id=… token=…’)이
 *   엣지 위임 CVP 를 **중앙 직접으로 조용히 바꾸면 안 된다**. 칸이 **있는데 비어 있으면** 그 값을 비운다
 *   (DataCenter 해제·중앙 직접 전환 — 폼과 같은 뜻). 단 authMode·verifyTls·enabled 는 선택지 칸이라
 *   빈 칸 = 기존 유지(신규는 기본값)다.
 *
 * 보안:
 *  · **비밀(비밀번호·토큰)은 기본 내보내기에 담지 않는다** — 열은 있고 값이 비어 있다. `includeSecrets` 는
 *    라우트가 설정 소유자 게이트 + 감사로그를 통과시킨 뒤에만 켠다(routes/admin/idracScan.js export.csv 선례).
 *  · 가져오기의 빈 비밀 칸 = 저장값 유지. ⚠ 단 host·계정·인증 방식이 바뀌면 저장 비밀을 **승계하지 않는다**
 *    (`util/secretCarry.js` · v2.503) — 그 행은 비밀을 다시 적지 않으면 검증에서 떨어진다. 정상 동작이다.
 *  · 셀은 `csvLine`(guardCell)로 수식 인젝션 방어, 가져오기는 `unguardCell` 로 해제(쌍으로).
 */

import { parseCsvRows, csvLine, unguardCell, delimiterHint, CSV_BOM } from '../util/csv.js';
import { analyzeBulkImport } from '../util/bulkImport.js';
import { parseFreeRows, rowsToFreeText, unmark, parseKeyed, splitCells, EMPTY_MARK } from '../util/bulkText.js';
import { secretProvided } from '../util/secretCarry.js';
import { baseUrlOf, serverInputIssue, agentKeyEq, MAX_SERVERS } from './registry.js';
import { pickAgent, pickDatacenter } from './formChoices.js';
import { tokenPos } from '../util/bulkAdvice.js';

/** 열 순서 — CSV·자유텍스트 공용. 비밀 두 칸은 맨 끝(기본 내보내기에서는 값이 비어 있다). */
export const COLUMNS = ['id', 'name', 'host', 'authMode', 'username', 'agent', 'datacenter', 'verifyTls', 'enabled', 'note', 'password', 'token'];

/** 헤더·키 별칭 — 다른 대량 등록 화면과 같은 어휘(번갈아 쓰는 사용자가 헷갈리지 않게). */
export const ALIASES = {
  아이디: 'id', 식별자: 'id', serverid: 'id', cvpid: 'id',
  표시명: 'name', 이름: 'name',
  ip: 'host', fqdn: 'host', url: 'host', 주소: 'host',
  인증: 'authMode', 인증방식: 'authMode', auth: 'authMode', authmode: 'authMode',
  계정: 'username', user: 'username',
  엣지: 'agent', 담당: 'agent', 담당엣지: 'agent', edge: 'agent',
  dc: 'datacenter', 법인: 'datacenter', 데이터센터: 'datacenter', datacenterid: 'datacenter',
  tls: 'verifyTls', 인증서검증: 'verifyTls', verifytls: 'verifyTls',
  활성: 'enabled', 사용: 'enabled',
  메모: 'note', 비고: 'note',
  비밀번호: 'password', pw: 'password', pass: 'password',
  토큰: 'token', apitoken: 'token',
};

const aliasOf = (h) => {
  const s = String(h ?? '').trim().toLowerCase();
  return ALIASES[s] || COLUMNS.find((c) => c.toLowerCase() === s) || null;
};

const TRUE_WORDS = ['true', '1', 'yes', 'y', 'on', '예', '사용', '활성', 'enabled'];
const FALSE_WORDS = ['false', '0', 'no', 'n', 'off', '아니오', '미사용', '비활성', 'disabled'];
/** 불리언 칸 — '' 는 null(미지정), 모르는 단어는 undefined(오류). 모르는 값을 true 로 접지 않는다. */
export function parseBool(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return null;
  if (TRUE_WORDS.includes(s)) return true;
  if (FALSE_WORDS.includes(s)) return false;
  return undefined;
}

/** 인증 방식 칸 — 한글 별칭을 받는다. 모르는 값은 그대로 넘겨 serverInputIssue 가 거부하게 한다(규칙 복제 금지). */
export function parseAuthMode(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return '';
  if (['token', '토큰', 'api', 'apitoken'].includes(s)) return 'token';
  if (['password', '비밀번호', 'pw', 'pass', 'id/pw'].includes(s)) return 'password';
  return s;
}

/* ────────────────── 내보내기 ────────────────── */

/** @param {object} s 등록부 항목(비밀 포함 가능) @param {{includeSecrets?:boolean}} o */
export function rowOf(s, { includeSecrets = false } = {}) {
  return {
    id: s.id || '',
    name: s.name || '',
    host: s.host || '',
    authMode: s.authMode === 'password' ? 'password' : 'token',
    username: s.authMode === 'password' ? (s.username || '') : '',
    agent: s.agent || '',
    datacenter: s.datacenterId || '',   // id 로 내보낸다(이름이 겹쳐도 되돌아올 때 모호하지 않게 — 가져오기는 id·이름 둘 다 받는다)
    verifyTls: s.verifyTls === true ? 'true' : 'false',
    enabled: s.enabled === false ? 'false' : 'true',
    note: s.note || '',
    // 기본은 **값을 싣지 않는다**. includeSecrets 는 라우트가 설정 소유자 게이트를 통과시킨 뒤에만 켠다.
    // 공개 형태(listServers)의 '********' 가 들어와도 비밀로 내보내지 않는다.
    password: includeSecrets && secretProvided(s.password) ? String(s.password) : '',
    token: includeSecrets && secretProvided(s.token) ? String(s.token) : '',
  };
}

export function serversToCsv(servers, { includeSecrets = false } = {}) {
  const lines = [csvLine(COLUMNS)];
  for (const s of servers || []) {
    const r = rowOf(s, { includeSecrets });
    lines.push(csvLine(COLUMNS.map((c) => r[c])));
  }
  return CSV_BOM + lines.join('\r\n') + '\r\n';
}

/** 자유텍스트 내보내기 — 비밀은 **항상** 빈칸이다(자유텍스트는 인용·공백 규칙 때문에 비밀 문자열을 온전히 왕복시킬 수 없다). */
export function serversToText(servers) {
  return rowsToFreeText((servers || []).map((s) => rowOf(s)), COLUMNS, {
    comment: [
      'CVP 서버 목록(자유텍스트) — 이 파일을 고쳐 그대로 가져올 수 있습니다.',
      '· 열 구분: 탭 · | · 쉼표 · 공백 중 아무거나. 빈칸은 ‘-’.',
      '· 비밀번호·토큰은 자유텍스트로 내보내지 않습니다 — 새로 넣을 때만 마지막 두 열에 적으세요(비우면 기존 유지).',
      '· host·계정·인증 방식 중 하나라도 바꾸면 저장된 비밀을 승계하지 않습니다(보안 규칙) — 그 행은 비밀을 다시 적으세요.',
      '· 새 서버는 id 칸을 비웁니다(‘-’) — id 는 포탈이 발급합니다.',
    ].join('\n'),
  });
}

/* ────────────────── 샘플 ────────────────── */

export function sampleCsv() {
  const lines = [
    csvLine(COLUMNS),
    // 주석 행 — id 가 '#...' 로 시작하므로 파싱에서 걸러진다(안내 목적).
    csvLine(['# id: 비우면 새 등록 · 있으면 그 서버 수정', '# name: 표시명', '# host: https://cvp.example 또는 호스트[:포트]',
      '# authMode: token | password', '# username: password 방식의 계정', '# agent: 담당 엣지(비우면 중앙 직접)',
      '# datacenter: DataCenter id 또는 이름', '# verifyTls: true|false', '# enabled: true|false', '# note: 메모',
      '# password: 비우면 기존 유지', '# token: 비우면 기존 유지']),
    csvLine(['', 'CVP Seoul', 'https://cvp.seoul.example.com', 'token', '', '', '', 'false', 'true', '', '', 'ChangeMe-service-account-token']),
    csvLine(['', 'CVP Warsaw', 'cvp.wa.example.com:443', 'password', 'svc-cvp', '', '', 'false', 'true', '', 'ChangeMe!2', '']),
  ];
  return CSV_BOM + lines.join('\r\n') + '\r\n';
}

export function sampleText() {
  return [
    '# CVP 서버 대량 등록 — 자유텍스트 샘플',
    '# 한 줄에 CVP 하나. ‘#’ 줄과 빈 줄은 무시합니다. 아래 세 가지 표기를 모두 받습니다.',
    '#',
    '# ① 위치형 — 열 순서대로. 구분자는 탭·|·쉼표·공백 중 아무거나. 빈칸은 ‘-’.',
    `#   순서: ${COLUMNS.join(' ')}`,
    '-  "CVP Seoul"   https://cvp.seoul.example.com  token     -        -  -  false  true  -  -  ChangeMe-service-account-token',
    '-  "CVP Warsaw"  cvp.wa.example.com:443         password  svc-cvp  -  -  false  true  -  ChangeMe!2  -',
    '',
    '# ② 키=값형 — 아는 항목만 적습니다(순서 무관, 한글 키도 가능). 적지 않은 항목은 기존 값을 유지합니다.',
    'name="CVP US" host=https://cvp.us.example.com 인증=token 토큰=ChangeMe-token-3',
    '',
    '# ③ 헤더형 — 첫 줄에 열 이름을 적으면 그 순서로 읽습니다(엑셀에서 헤더까지 복사한 경우).',
    'host  name  authMode  token',
    'https://cvp.jp.example.com  "CVP Japan"  token  ChangeMe-token-4',
    '',
  ].join('\n');
}

/* ────────────────── 가져오기 파싱 ────────────────── */

function normRow(line, get, present) {
  const password = get('password', { trim: false });
  const token = get('token');
  return {
    _line: line,
    _present: present,            // 파일에 **있던** 필드(없는 필드는 저장값 유지 — 머리말 참조)
    id: get('id'),
    name: get('name'),
    host: get('host'),
    authMode: get('authMode'),
    username: get('username'),
    agent: get('agent'),
    datacenter: get('datacenter'),
    verifyTls: get('verifyTls'),
    enabled: get('enabled'),
    note: get('note'),
    password,
    token,
    _hasPassword: password !== '' || token !== '',
  };
}

export function parseServersCsv(text) {
  let rows;
  try { rows = parseCsvRows(text, { maxRows: 2000, maxCell: 8192 }); }
  catch (e) { return { rows: [], error: e.message }; }
  if (rows.length < 2) return { rows: [], error: '헤더 + 최소 1개 데이터 행이 필요합니다.' };

  const header = rows[0].map((h) => unguardCell(h).trim());
  const col = {};
  header.forEach((h, i) => { const f = aliasOf(h); if (f && col[f] == null) col[f] = i; });
  if (col.host == null && col.id == null) return { rows: [], error: "필수 헤더 'host'(또는 수정용 'id')가 없습니다." + delimiterHint(rows[0]) };
  const present = new Set(Object.keys(col));

  const out = [];
  rows.slice(1).forEach((cells, n) => {
    const get = (f, { trim = true } = {}) => {
      const i = col[f];
      if (i == null) return '';
      const raw = unguardCell(cells[i] ?? '');
      if (raw.trim() === EMPTY_MARK) return '';   // '-' = 비움(자유텍스트와 같은 규칙 — v2.516)
      return trim ? raw.trim() : raw;
    };
    if (!get('id') && !get('host') && !get('name')) return;   // 완전 빈 행
    if (get('id').startsWith('#')) return;                        // 샘플 주석 행
    out.push(normRow(n + 2, get, present));
  });
  if (!out.length) return { rows: [], error: 'id·host 가 모두 빈 행만 있습니다.' };
  return { rows: out, order: COLUMNS.filter((c) => col[c] != null) };
}

/**
 * 자유텍스트 한 줄에 **실제로 적힌 필드** — 키=값 줄이면 적은 키, 위치형이면 그 줄의 열 순서에서 토큰 개수만큼.
 * (parseFreeRows 는 없는 필드를 '' 로 채워 '비움' 과 '없음' 을 구분하지 못한다 — 수정 행이 엣지 담당을 조용히
 *  지우지 않게 여기서 되살린다.) 판정은 parseFreeRows 와 같은 순서(키형 → 위치형)다.
 */
function presentOfLine(lineText, order) {
  const k = parseKeyed(lineText, { aliasOf });
  if (Object.keys(k.values).length) return new Set(Object.keys(k.values));
  const { cells, explicit } = splitCells(lineText);
  const trimmed = [...cells];
  while (trimmed.length && trimmed[trimmed.length - 1] === '') trimmed.pop();
  const tokens = explicit ? trimmed : trimmed.filter((t) => t !== '');
  return new Set(order.slice(0, tokens.length));
}

/** 줄 번호 → 그 줄을 읽을 때 쓰인 열 순서(파일 중간 헤더까지 따른다 — parseFreeRows 의 헤더 판정과 같은 규칙). */
function ordersByLine(text) {
  const map = new Map();
  let order = COLUMNS;
  String(text ?? '').split(/\r?\n/).forEach((line, i) => {
    if (!line.trim() || /^\s*#/.test(line)) return;
    const { cells } = splitCells(line);
    const filled = cells.filter((t) => t !== '');
    if (filled.length >= 2 && filled.every((t) => aliasOf(t))) { order = filled.map((t) => aliasOf(t)); return; }
    map.set(i + 1, order);
  });
  return map;
}

export function parseServersText(text, { defaults = {} } = {}) {
  const r = parseFreeRows(text, { fields: COLUMNS, aliases: ALIASES, defaults });
  if (r.error) return { rows: [], error: r.error, warnings: r.warnings, headerUsed: null, order: COLUMNS };
  const lines = String(text ?? '').split(/\r?\n/);
  const orders = ordersByLine(text);
  const rows = r.rows
    .map((row) => {
      const present = presentOfLine(lines[row._line - 1] ?? '', orders.get(row._line) || r.headerUsed || COLUMNS);
      return normRow(row._line, (f) => unmark(row[f]), present);
    })
    .filter((row) => row.id || row.host || row.name);
  if (!rows.length) return { rows: [], error: 'id·host 가 모두 빈 줄만 있습니다.', warnings: r.warnings, headerUsed: r.headerUsed, order: r.headerUsed || COLUMNS };
  return { rows, warnings: r.warnings, headerUsed: r.headerUsed, order: r.headerUsed || COLUMNS };
}

/* ────────────────── 행 → 저장 입력(단일 지점) ────────────────── */

const lc = (v) => String(v ?? '').trim().toLowerCase();

/**
 * 행이 가리키는 기존 서버 — saveServer 의 식별 규칙 그대로(머리말). 반환 `{ prev, issue }`.
 * @param {object} row
 * @param {object[]} servers 등록부(비밀 포함 원본)
 */
export function resolveExisting(row, servers) {
  const list = Array.isArray(servers) ? servers : [];
  const id = String(row.id ?? '').trim();
  if (id) {
    const prev = list.find((s) => s.id === id);
    return prev ? { prev } : { prev: null, issue: `없는 CVP 서버입니다(id ‘${id}’) — 새로 등록하려면 id 칸을 비우세요(id 는 포탈이 발급합니다).` };
  }
  const base = baseUrlOf(row.host).base;
  if (!base) return { prev: null };      // 주소 형식 오류는 serverInputIssue 가 같은 문구로 잡는다
  const same = list.filter((s) => baseUrlOf(s.host).base === base);
  const hasAgent = !row._present || row._present.has('agent');
  if (hasAgent) return { prev: same.find((s) => agentKeyEq(s.agent, row.agent)) || null };
  if (same.length > 1) return { prev: null, issue: `같은 주소의 CVP 서버가 ${same.length}개입니다(담당 엣지만 다름) — 어느 것인지 알 수 없어 저장하지 않았습니다. id 열 또는 agent 열을 적으세요.` };
  return { prev: same[0] || null };
}

/**
 * 행 → `saveServer` 입력 + 판정. **드라이런·연결 테스트·실제 저장이 전부 이 함수 하나**를 쓴다.
 * 판정 순서는 routes/api/cvp.js saveRoute 와 같다(pickAgent → pickDatacenter → serverInputIssue).
 *
 * @param {object} row 파싱된 행
 * @param {{servers:object[], agents:string[], datacenters:{id:string,name?:string}[]}} ctx
 * @returns {{ input:object, prev:object|null, key:string, issue:string|null, quick:string|null }}
 */
export function prepareRow(row, ctx) {
  const { prev, issue: resolveIssue } = resolveExisting(row, ctx.servers);
  const has = (f) => !row._present || row._present.has(f);
  const keep = (f, dflt) => (has(f) ? row[f] : (prev ? (prev[f] ?? dflt) : dflt));

  let quick = null;
  if (!String(row.host ?? '').trim() && !(prev && !has('host'))) quick = 'host 누락 — CVP 주소(https://cvp.example 또는 호스트[:포트])를 적으세요';
  if (!quick && resolveIssue) quick = resolveIssue;

  const vt = parseBool(row.verifyTls);
  const en = parseBool(row.enabled);
  if (!quick && vt === undefined) quick = `verifyTls 값 ‘${row.verifyTls}’ 을(를) 읽지 못했습니다 — true 또는 false`;
  if (!quick && en === undefined) quick = `enabled 값 ‘${row.enabled}’ 을(를) 읽지 못했습니다 — true 또는 false`;

  const input = {
    ...(prev ? { id: prev.id } : {}),
    name: String(keep('name', '') ?? '').trim(),
    host: String(keep('host', '') ?? '').trim(),
    authMode: parseAuthMode(row.authMode) || (prev ? (prev.authMode === 'password' ? 'password' : 'token') : 'token'),
    username: String(keep('username', '') ?? '').trim(),
    agent: String(keep('agent', '') ?? '').trim(),
    datacenterId: String((has('datacenter') ? row.datacenter : (prev ? prev.datacenterId : '')) ?? '').trim(),
    verifyTls: vt == null ? (prev ? prev.verifyTls === true : false) : vt,
    enabled: en == null ? (prev ? prev.enabled !== false : true) : en,
    note: String(keep('note', '') ?? ''),
  };
  // 빈 비밀 칸 = 저장값 유지(saveServer 가 secretProvided 로 판정한다 — 키를 아예 넣지 않는다).
  if (secretProvided(row.password)) input.password = row.password;
  if (secretProvided(row.token)) input.token = row.token;

  const base = baseUrlOf(input.host).base;
  const key = prev ? `id:${prev.id}` : (String(row.id ?? '').trim() ? `id:${String(row.id).trim()}` : `addr:${base || lc(input.host)}|${lc(input.agent)}`);

  let issue = null;
  if (!quick) {
    const ag = pickAgent(input.agent, ctx.agents, prev?.agent || '');
    if (ag.error) issue = ag.error;
    else {
      input.agent = ag.value;
      const dc = pickDatacenter(input.datacenterId, ctx.datacenters, prev?.datacenterId || '');
      if (dc.error) issue = dc.error;
      else {
        input.datacenterId = dc.value;
        issue = serverInputIssue(input, prev);
      }
    }
  }
  return { input, prev, key, issue, quick };
}

/**
 * 드라이런 판정 — 코어(`analyzeBulkImport`)에 주입만 한다.
 * @param {Array} rows parseServersCsv/Text 결과
 * @param {{servers:object[], agents:string[], datacenters:object[]}} ctx
 */
export function analyzeImport(rows, ctx) {
  const memo = new Map();
  const prep = (row) => { if (!memo.has(row)) memo.set(row, prepareRow(row, ctx)); return memo.get(row); };
  // 새 등록 상한 — saveServer 가 MAX_SERVERS 에서 던지는 것을 드라이런이 미리 말한다(파일 순서대로 자리를 준다).
  const room = MAX_SERVERS - (Array.isArray(ctx.servers) ? ctx.servers.length : 0);
  let adds = 0;
  const base = analyzeBulkImport(rows, {
    keyOf: (row) => prep(row).key,
    keyLabel: 'id 또는 host+agent',
    quickIssue: (row) => prep(row).quick,
    toInput: (row) => prep(row),
    existing: (row) => !!prep(row).prev,
    validate: (p) => {
      if (p.issue) return p.issue;
      if (!p.prev) {
        if (adds >= room) return `CVP 서버는 최대 ${MAX_SERVERS}개까지 등록할 수 있습니다(남은 자리 ${Math.max(0, room)}개).`;
        adds++;
      }
      return null;
    },
  });
  return { ...base, prepared: prep };
}

/** 연결 테스트에서 건너뛸 행 — 엣지 위임 CVP 는 중앙에서 닿지 않는 것이 정상이다('실패' 가 아니다 — v2.513). */
export function skipReasonOf(input) {
  const a = String(input?.agent ?? '').trim();
  return a ? `엣지(${a})가 수집하는 CVP — 중앙에서는 닿지 않는 것이 정상이라 시도하지 않았습니다(등록하면 엣지가 수집합니다).` : null;
}

/**
 * 연결 테스트 대상 — 새 비밀을 적은 행은 그 입력으로, 비밀을 비운 행은 **저장값으로 고정**한다
 * (v2.480 — 저장 비밀이 요청자가 적은 다른 호스트로 가지 않게. 접속 대상이 바뀐 행은 비밀 없이는 검증에서 이미 떨어진다).
 */
export function testTargetOf({ input, prev }) {
  const newSecret = input.authMode === 'password' ? secretProvided(input.password) : secretProvided(input.token);
  if (newSecret) return { ...input, id: undefined };
  return prev ? { ...prev, verifyTls: input.verifyTls } : null;
}

/* ────────────────── 조언 보정(CVP 전용) ────────────────── */

/** CVP host 의 정답 형식 — URL 과 호스트[:포트] **둘 다** 맞다(registry.baseUrlOf). */
export const HOST_HINT = 'CVP 주소 — https://cvp.example 또는 호스트[:포트] 형식(경로·쿼리·계정은 넣지 않습니다)';
const TOKEN_HINT = '서비스 계정 토큰 — 한 줄 문자열(개행·탭 없이). 비우면 기존 토큰을 유지하지만 host·인증 방식을 바꾼 행은 다시 적어야 합니다';

/**
 * `util/bulkAdvice.js` 의 공용 조언 중 **CVP 에서 틀리는 두 가지**만 바로잡는다(판정은 다시 하지 않는다 — v2.513 규약):
 *  ① host 조언 — 공용 문구는 'URL·포트를 넣지 말라' 인데 CVP 는 URL·포트가 정답이다(틀린 조언은 무음 실패보다 나쁘다 — v2.525).
 *  ② 토큰 오류 — '서비스 계정 토큰을 입력하세요' 가 공용 규칙에서 '계정' 에 걸려 **username 열을 지목**한다(엉뚱한 열).
 * 공용 모듈을 고치지 않고 여기서 덮는 이유: 다른 도구(스토리지·SAN·Horizon)의 조언을 흔들지 않기 위해서다.
 */
export function fixCvpAdvice(report, { text = '', order = [], format = 'csv' } = {}) {
  const lines = String(text || '').split(/\r?\n/);
  return (report || []).map((it) => {
    if (it.action !== 'error') return it;
    if (/토큰/.test(String(it.reason || '')) && it.field !== 'token') {
      const tok = tokenPos(lines[it.line - 1] ?? '', 'token', order);
      const where = format === 'csv' ? `${it.line}줄의 'token' 열` : (tok?.col ? `${it.line}줄의 ${tok.col}번째 항목` : `${it.line}줄의 'token'`);
      return { ...it, field: 'token', token: tok, current: '', expected: { kind: 'format', hint: TOKEN_HINT }, advice: `${where}을 고쳐야 합니다. ${TOKEN_HINT}.` };
    }
    if (it.field === 'host' && it.expected?.hint) {
      return { ...it, expected: { ...it.expected, hint: HOST_HINT }, advice: String(it.advice || '').replace(it.expected.hint, HOST_HINT) };
    }
    return it;
  });
}

/** 공용 사전 경고 중 CVP host 에 **틀린** 것(URL·포트·끝 슬래시를 지우라는 것)을 뺀다. 전각·스마트 인용부호 경고는 남긴다. */
export function cvpHints(hints) {
  return (hints || []).filter((h) => !(h.field === 'host' && /URL 이 들어갔|포트가 붙어|끝에 \/ 가/.test(String(h.advice || ''))));
}
