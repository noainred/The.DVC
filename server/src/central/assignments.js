/**
 * Central store for per-agent scan assignments and the results agents report
 * back. Assignments map an agent NAME to an IP range + iDRAC credentials; each
 * agent pulls its own assignment, scans locally, and posts results here.
 *
 * Stored in CONFIG_DIR/agent-assignments.json (0600; holds credentials) and
 * CONFIG_DIR/agent-results.json (0600; scan summaries).
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, safeLoadText } from '../util/atomicWrite.js';
import { openSecretsDeep, sealSecretsDeep } from '../security/secretVault.js'; // v2.538: 이 파일은 v2.537 까지 봉인 대상 미등록이었다(감사 M4 계열)
import { parseCsvRows } from '../util/csv.js';
import { numOrNull } from '../util/numOrNull.js';
import { registerExitFlush } from '../util/exitFlush.js'; // v2.582 ARCH-4: 디바운스 저장은 종료 시 동기 flush 를 등록한다
import { capStr } from '../util/capStr.js';
import { makeSettingsLoadError } from '../util/settingsLoadError.js'; // v2.727(감사 D-01): 손상 → 설정 pull 503(v2.631 규약)
import { makeJsonFileReader, readJsonFile, READ_RETRY_MS } from '../util/jsonFileLoad.js'; // 87회차 ⓐ: 읽기 오류 ≠ 손상(공용 읽기 판정)
import { inRetryWindow } from '../util/jsonFileRead.js';   // 128회차: 재읽기 간격 판정은 공용(시계가 뒤로 가도 그 차만큼 굳지 않게)
import { accessMoved } from '../util/secretCarry.js'; // v2.731(점검 A3-01 ②): 접속처가 바뀌면 저장 비밀번호를 승계하지 않는다
import { envPositive } from '../util/envNumber.js'; // v3.17.6: 양수 env 는 하나로(음수 · Infinity 를 통과시키지 않는다)

const FILE = path.join(config.configDir, 'agent-assignments.json');
const RESULT_FILE = path.join(config.configDir, 'agent-results.json');

// ---- assignments ----------------------------------------------------------

/*
 * v2.727(감사 D-01): 로드 오류 상태. 손상 → preserveCorrupt → 빈 배정이면 `GET /api/central/assignment` 가 `200 assigned:false` 를 내려
 *   엣지 스캐너(agent/scanner.js)가 '중앙 지정 없음' 으로 읽고 **조용히 멈췄다**(28곳의 위임 iDRAC 스캔). v2.631 settingsLoadError 가
 *   이 배포 경로를 빠뜨렸다(등록 13곳 중 이 파일과 GPU 게스트 배포가 없었다). 오류면 라우트가 503 settingsUnreadable 로 답하고
 *   엣지는 직전 상태를 유지한다. 재시작 뒤(원본이 .corrupt 로 옮겨져 ENOENT)도 보존본만 있으면 여전히 못 읽은 것이다(missing()).
 *   오류는 **관리자 저장**(save — 추가·수정·삭제·가져오기)만 해제한다. confirm 은 지금 읽히는 값(손상이면 빈 목록)을 그대로 쓴다.
 */
const _loadErr = makeSettingsLoadError(() => FILE, { label: 'iDRAC 스캔 배정(엣지별)', confirm: () => save(loadAssignments()), recheckMs: READ_RETRY_MS });   // 87회차 ⓐ: 이 로더는 부를 때마다 다시 읽는다(읽기 오류만 간격)
/** 배정 파일을 못 읽었으면 { at, reason }, 읽었으면 null — 라우트가 pull 응답 전에 본다. */
export function assignmentsLoadError() { loadAssignments(); return _loadErr.get(); }

/*
 * 87회차 ⓐ(84회차 남긴 것 ② — 권장안): 공용 읽기 판정(util/jsonFileLoad.js). 예전 catch 하나는 **읽기 오류**(EACCES · EIO)도 손상으로 보고
 *   온전한 원본(iDRAC 자격증명 전량)을 `.corrupt.*` 로 옮겼다 — 권한을 고쳐도 보존본을 되돌려야 했고, '전체 목록 가져오기(바꾸기)' · 확정이 열렸다.
 *   이제 읽기 오류는 원본을 두고 · 오류(readError)를 세워 배정 pull 503 · 모든 저장(바꾸기 포함) 거절을 유지하며 · READ_RETRY_MS 간격으로만 디스크를 다시 본다
 *   (엣지 28곳의 pull 마다 죽어 가는 디스크를 두드리지 않게). 읽히면 재시작 없이 풀린다. 손상은 예전과 같다(보존 → 503 → 관리자 저장 · 확정 · 바꾸기로 풀림).
 */
const parseAssignmentsFile = (text) => { const p = JSON.parse(text); return Array.isArray(p?.assignments) ? openSecretsDeep(p.assignments) : []; };
const _reader = makeJsonFileReader(() => FILE, { parse: parseAssignmentsFile, preserve: true, tag: 'central' });
export function loadAssignments() {
  const r = _reader.read();
  if (r.kind === 'ok') { _loadErr.ok(); return r.value; }
  if (r.kind === 'missing') { _loadErr.missing(); return []; }
  if (r.kind === 'read-error') { _loadErr.readError(r.error, { retryMs: READ_RETRY_MS }); return []; }
  // ⚠ 손상 파일을 조용히 []로 넘기면 다음 save()가 온전했던 원본(=iDRAC 자격증명 전량)을 빈
  // 목록으로 영구히 덮어쓴다 — server/CLAUDE.md '자격증명 파일은 원자적 쓰기 + 로드 손상
  // preserveCorrupt' 불변조건. reader 가 보존(preserveCorrupt)한 뒤에만 빈 값을 반환한다.
  _loadErr.corrupt(r.error); // v2.727(D-01)
  // v2.744(최종 검토 RG2744-02): 사유는 요약이다 — 원문은 iDRAC 스캔 비밀번호 앞부분 같은 파일 조각을 싣고 이 줄은 콘솔 링버퍼로 나간다.
  console.error(`[central] agent-assignments.json 파싱 실패: ${safeLoadText(r.error) || '사유 미상'}`);
  return [];
}
/** 87회차 ⓐ: 읽기 오류(원본이 그 자리에 그대로)인가 — 그동안은 '바꾸기' 를 포함한 모든 저장을 거절한다(원자적 rename 이 보존본도 없이 원본을 덮는다). */
const readBlocked = () => !!_loadErr.get()?.readError;

/*
 * 전체 점검 18회차 반증 B-3(재현): 못 읽은 동안 **한 엣지의 추가 · 수정 · 삭제 · 병합 가져오기는 쓰지 않는다**. 예전에는 그 저장이 빈 목록에 한 건을 얹어
 *   파일을 쓰고 표지를 풀어, 다른 모든 엣지가 /api/central/assignment 에서 200 assigned:false 를 받고 위임 iDRAC 스캔을 조용히 멈췄다(관리 화면은
 *   손상을 알리지 않는다). 해제는 손상 보존본을 되돌리고 재시작 · 서비스 점검 '기본값으로 확정' · 전체 목록 가져오기(replace — 사람이 목록 전체를 다시 정함).
 *   agentUsers(17회차 C-10)와 같은 판단.
 */
function writeRefusal() {
  if (!_loadErr.get()) return null;
  if (readBlocked()) return { ok: false, code: 'registry-unreadable', status: 503, readError: true,
    reason: `iDRAC 스캔 배정 파일(agent-assignments.json)을 읽지 못한 상태라 저장하지 않았습니다 — 읽기 오류이고 원본은 그대로 있습니다. 파일 권한 · 소유자(포탈 서비스 계정) · 디스크를 확인하세요(${Math.round(READ_RETRY_MS / 1000)}초마다 다시 읽고, 읽히면 저장이 다시 열립니다).` };   // 87회차 ⓐ
  return { ok: false, code: 'registry-unreadable', status: 503,
    reason: 'iDRAC 스캔 배정 파일(agent-assignments.json)을 읽지 못한 상태라 저장하지 않았습니다 — 지금 한 엣지를 저장하면 손상 보존본(.corrupt.*)에만 남은 다른 엣지의 배정이 빠져 그 엣지들의 위임 스캔이 멈춥니다. 보존본을 되돌리고 재시작하거나, 서비스 점검의 설정 파일에서 기본값으로 확정하거나, 전체 목록 가져오기(바꾸기)로 목록 전체를 다시 정하세요.' };
}

function save(list) {
  // 87회차 ⓐ: 마지막 방어선 — 읽기 오류 중에는 어느 경로(바꾸기 · 확정 포함)도 원본을 덮지 않는다.
  if (readBlocked()) throw Object.assign(new Error('iDRAC 스캔 배정 파일을 읽지 못한 상태라 저장하지 않았습니다(읽기 오류 — 원본은 그대로).'), { code: 'registry-unreadable', readError: true });
  atomicWriteFileSync(FILE, JSON.stringify(sealSecretsDeep({ assignments: list }), null, 2), { mode: 0o600 });
  _loadErr.ok(); // v2.727(D-01): 관리자 저장이 로드 오류를 푼다(settingsLoadError 규약)
  _reader.reset();
}

export function redact(a) {
  const { password, ...rest } = a;
  return { ...rest, hasPassword: Boolean(password) };
}

export function listAssignments() {
  return loadAssignments().map(redact);
}

/** Full assignment (incl. password) for one agent name — used by the agent API. */
export function getAssignment(agentName) {
  const key = String(agentName || '').trim().toLowerCase();
  return loadAssignments().find((a) => String(a.agent).trim().toLowerCase() === key) || null;
}

/**
 * 스캔 대역 비교 키(순수) — 줄·쉼표로 나눈 항목을 정규화한 집합. 순서·공백·대소문자·주석('#' 뒤)만 다른 입력은 같은 대역이다
 * (idrac/iprange.js expandIpList 와 같은 구분자 — 줄 · 쉼표. CSV 가져오기는 ';'·'|' 를 줄로 바꿔 둔다).
 */
export function ipsKey(v) {
  const items = [];
  for (const line of String(v ?? '').split(/\r?\n/)) {
    const body = line.split('#')[0];
    for (const t of body.split(/[,;|]/)) { const k = t.replace(/\s+/g, '').toLowerCase(); if (k) items.push(k); }
  }
  return [...new Set(items)].sort().join(',');
}

/**
 * 폐기 안내(응답 skipped·passwordDropped 의 reason) — 엣지는 다음 배정 조회에서 빈 비밀번호를 받는다.
 * v2.732(점검 2회차 B1-03): 2.731 이상 엣지는 빈 비밀번호 할당을 **스캔하지 않는다**(agent/scanner.js 'no-password' — 대역 전체에
 *   빈 비밀번호로 로그인하면 계정이 잠긴다). 예전 문구 '스캔은 iDRAC 로그인에 실패합니다' 는 2.730 이하 엣지에만 맞는 말이라
 *   관리자가 iDRAC 인증 실패 로그·계정 잠금을 찾게 했다(건너뜀을 실패라 말하지 않는다 — v2.513 규약). 구버전 엣지의 실패는 단서로 남긴다.
 */
export const ASSIGN_PASSWORD_DROPPED_REASON = 'IP 대역·iDRAC 계정이 바뀌어 저장된 iDRAC 비밀번호를 폐기했습니다 — 새 대역에 보낼 비밀번호를 다시 입력하세요(그 전까지 이 에이전트는 iDRAC 스캔을 하지 않습니다. 단 2.730 이하 엣지는 빈 비밀번호로 로그인을 시도해 실패합니다).';

/**
 * 반환 [entry, err, dropped]. dropped = 기존 비밀번호를 승계하지 않고 버렸는가.
 * v2.731(점검 A3-01 ②): 대역(ips — 정규화 집합)·계정(username)이 바뀌었는데 새 비밀번호가 없으면 기존 비밀번호를 승계하지 않는다
 *   (server/CLAUDE.md '접속처가 바뀌면 저장 비밀을 승계하지 않는다 — 자격증명 스토어 전부'. 형제 idrac/scanRanges.js 는 v2.606
 *   LEFT2606-02 에 같은 결함을 고쳤는데 이 스토어만 빠졌다). 예전에는 수정 창(비밀번호 칸이 빈 채로 열린다)에서 대역만 바꿔
 *   저장하면 엣지가 새 대역의 Redfish 응답 호스트마다 저장 iDRAC 비밀번호로 로그인했다(재현). CSV merge 가져오기도 이 함수를 지난다.
 *   대역 '추가' 도 대상이다 — 추가된 대역이 곧 새 접속처다.
 */
function normalize(body, existing = null) {
  const e = existing ? { ...existing } : {};
  const agent = String(body.agent ?? e.agent ?? '').trim();
  const ips = String(body.ips ?? e.ips ?? '').trim();
  const username = String(body.username ?? e.username ?? '').trim();
  if (!agent) return [null, '에이전트 이름(agent)은 필수입니다.'];
  if (!ips) return [null, 'IP 대역(ips)은 필수입니다.'];
  if (!username) return [null, 'iDRAC 계정(username)은 필수입니다.'];
  const newPw = body.password ? String(body.password) : '';
  const moved = Boolean(existing) && (ipsKey(e.ips) !== ipsKey(ips) || accessMoved({ username: e.username || '' }, { username }, ['username']));
  const dropped = !newPw && moved && Boolean(e.password);
  return [{
    agent, ips, username,
    password: newPw || (dropped ? '' : e.password || ''),
    enabled: body.enabled != null ? Boolean(body.enabled) : (e.enabled != null ? e.enabled : true),
  }, null, dropped];
}

export function addAssignment(body) {
  const list = loadAssignments();
  const refused = writeRefusal(); if (refused) return refused;
  const [entry, err] = normalize(body);
  if (err) return { ok: false, reason: err };
  if (list.some((a) => a.agent.toLowerCase() === entry.agent.toLowerCase())) return { ok: false, reason: `이미 존재하는 에이전트: ${entry.agent}` };
  list.push(entry); save(list);
  return { ok: true, assignment: redact(entry) };
}

export function updateAssignment(agent, body) {
  const list = loadAssignments();
  const refused = writeRefusal(); if (refused) return refused;
  const idx = list.findIndex((a) => a.agent.toLowerCase() === String(agent).toLowerCase());
  if (idx === -1) return { ok: false, reason: `없는 에이전트: ${agent}` };
  const [entry, err, dropped] = normalize({ ...body, agent: list[idx].agent }, list[idx]);
  if (err) return { ok: false, reason: err };
  list[idx] = entry; save(list);
  // v2.731(A3-01 ②): 폐기 사실은 응답이 말한다(v2.607 droppedSecrets 규약 — 화면 views/droppedSecretText.js 가 읽는다).
  return { ok: true, assignment: redact(entry), ...(dropped ? { droppedSecrets: ['password'], skipped: [{ field: 'password', reason: ASSIGN_PASSWORD_DROPPED_REASON }] } : {}) };
}

export function removeAssignment(agent) {
  const list = loadAssignments();
  const refused = writeRefusal(); if (refused) return refused;
  const next = list.filter((a) => a.agent.toLowerCase() !== String(agent).toLowerCase());
  if (next.length === list.length) return { ok: false, reason: `없는 에이전트: ${agent}` };
  save(next);
  return { ok: true };
}

/**
 * Parse an assignments CSV. Columns: agent, ips, username, password, enabled.
 * The ips cell may hold several ranges separated by ';' or '|' (commas are the
 * CSV delimiter). A header row is optional. Lines starting with '#' are skipped.
 */
export function parseCsv(text) {
  // RFC4180 파서로 통일 — 위임 스캔용 iDRAC 비밀번호에 쉼표/따옴표/줄바꿈이 있어도 온전히 보존한다
  // (idrac/registry.js와 동일). 이전 line.split(',')는 p@ss,w0rd 같은 비번을 잘라 위임 스캔이 전부
  // 인증 실패(401)했다. 주석(#)으로 시작하는 레코드는 건너뛴다.
  const rows = parseCsvRows(text).filter((r) => !String(r[0] ?? '').trim().startsWith('#'));
  if (!rows.length) return [];
  const headerCells = rows[0].map((h) => h.trim().toLowerCase());
  const hasHeader = headerCells.includes('agent') && headerCells.includes('ips');
  const cols = hasHeader ? headerCells : ['agent', 'ips', 'username', 'password', 'enabled'];
  const out = [];
  for (const cells of rows.slice(hasHeader ? 1 : 0)) {
    const row = {};
    // 비밀번호는 앞뒤 공백이 유의미할 수 있어 trim하지 않는다(다른 필드만 trim).
    cols.forEach((c, i) => { const v = cells[i] ?? ''; row[c] = c === 'password' ? v : v.trim(); });
    if (!row.agent) continue;
    out.push({
      agent: row.agent,
      ips: (row.ips || '').split(/[;|]/).map((s) => s.trim()).filter(Boolean).join('\n'),
      username: row.username || 'root',
      password: row.password || '',
      enabled: !/^(0|false|no|off|중지|disabled)$/i.test((row.enabled || 'true').trim()),
    });
  }
  return out;
}

/**
 * Import assignments. mode 'merge' (default) upserts by agent name; 'replace'
 * swaps the whole list. Returns { ok, mode, added, updated, skipped[], total }.
 */
export function importAssignments(incoming, mode = 'merge') {
  if (!Array.isArray(incoming)) return { ok: false, reason: 'assignments 배열을 찾을 수 없습니다.' };
  const existing = loadAssignments();
  if (mode !== 'replace' || readBlocked()) { const refused = writeRefusal(); if (refused) return refused; }   // 18회차 B-3: 바꾸기(목록 전체)만 손상 중에도 쓴다 — 87회차 ⓐ: 읽기 오류(원본 그대로)는 바꾸기도 거절
  const result = mode === 'replace' ? [] : [...existing];
  let added = 0, updated = 0;
  const skipped = [];
  const passwordDropped = []; // v2.731(A3-01 ②): merge 로 대역·계정이 바뀌어 비밀번호를 승계하지 않은 에이전트(화면 passwordDroppedLines)
  for (const raw of incoming) {
    const base = mode === 'replace' ? null : existing.find((a) => a.agent.toLowerCase() === String(raw?.agent || '').toLowerCase());
    const [entry, err, dropped] = normalize(raw || {}, base);
    if (err) { skipped.push({ agent: raw?.agent || '(이름없음)', reason: err }); continue; }
    if (dropped) passwordDropped.push({ name: entry.agent, reason: ASSIGN_PASSWORD_DROPPED_REASON });
    const idx = result.findIndex((a) => a.agent.toLowerCase() === entry.agent.toLowerCase());
    if (idx >= 0) { result[idx] = entry; updated++; } else { result.push(entry); added++; }
  }
  // 안전장치: 'replace'인데 유효 항목이 0건이면 전체 삭제 금지(빈/무효 CSV로 스캔 할당 소실 방지).
  if (mode === 'replace' && result.length === 0) {
    return { ok: false, mode, added: 0, updated: 0, skipped, total: existing.length, reason: '가져올 유효한 할당이 없어 전체 교체를 취소했습니다(기존 유지).' };
  }
  save(result);
  return { ok: true, mode, added, updated, skipped, total: result.length, ...(passwordDropped.length ? { passwordDropped } : {}) };
}

// ---- results --------------------------------------------------------------

/**
 * 엣지 스캔 결과 본문 정제(순수 — v2.598, 감사 CENTRAL-03).
 * 예전 라우트는 `b.scanned || 0` 처럼 **값을 그대로** 저장해 `{"scanned":{"a":1}}` 같은 객체가 '에이전트 작업'
 * 화면에 그대로 렌더돼 React #31 로 화면이 죽었다(저장형 — 파일에 남아 재시작 뒤에도 계속 죽는다).
 * 수치는 유한한 0 이상 수만, 없거나 못 읽은 값은 **null**(0 으로 채우면 '미응답 0' 이라는 거짓이 된다).
 * `found` 는 객체 원소만·아는 문자열 필드만(길이 상한) 담는다.
 */
const FOUND_MAX = 5000;
const cnt = (v) => { const n = numOrNull(v); return n != null && n >= 0 ? n : null; };
const fstr = (v, n = 200) => (typeof v === 'string' ? capStr(v, n) : // v2.607(TIM2607-01)
  (typeof v === 'number' && Number.isFinite(v) ? String(v) : ''));
export function sanitizeScanResult(b) {
  const body = b && typeof b === 'object' && !Array.isArray(b) ? b : {};
  const raw = Array.isArray(body.found) ? body.found : [];
  const found = raw.slice(0, FOUND_MAX)
    .filter((f) => f && typeof f === 'object' && !Array.isArray(f))
    .map((f) => ({ ip: fstr(f.ip, 64), serviceTag: fstr(f.serviceTag, 64), model: fstr(f.model), manufacturer: fstr(f.manufacturer), hostName: fstr(f.hostName, 255) }));
  return {
    scanned: cnt(body.scanned),
    foundCount: cnt(body.foundCount) ?? found.length,
    found,
    ...(raw.length > found.length ? { foundOmitted: raw.length - found.length } : {}),
    unreachable: cnt(body.unreachable),
    notIdrac: cnt(body.notIdrac),
    authFailed: cnt(body.authFailed),
    durationMs: cnt(body.durationMs),
  };
}

// Object.create(null): 에이전트가 보낸 이름이 '__proto__' 등 프로토타입 키여도 오염되지 않게
// (inventory.js/fleet.js와 동일한 방어 — 일반 {}는 results['__proto__'] 대입이 조용히 유실된다).
let results = Object.create(null);
// 결과 파일도 동일 규칙 — 손상 시 보존 후 빈 값(다음 저장이 원본을 소거하지 않게).
// v2.598(감사 CENTRAL-03): 이미 저장된 오염 행도 로드 시 같은 정제를 거친다(운영 파일은 우리가 고칠 수 없다 —
//   쓰기만 고치면 이미 저장된 줄이 계속 화면을 죽인다. v2.569 감사 로그와 같은 판단).
//   ⚠ 정제 헬퍼(const)는 이 로드보다 **위에** 있어야 한다 — 아래로 옮기면 TDZ 로 로드가 던지고, catch 가
//   멀쩡한 파일을 손상으로 보존(preserveCorrupt)해 결과가 전부 사라진다(v2.566 TDZ 교훈).
// 87회차 ⓐ: 결과 파일도 공용 읽기 판정 — **읽기 오류**(EACCES · EIO)는 손상이 아니다: 원본을 옮기지 않고 빈 메모리로 시작하되, 그동안은 저장하지 않는다
//   (원자적 rename 이 원본을 덮는다). 저장 시점에 READ_RETRY_MS 간격으로 다시 읽어 읽히면 파일의 결과 중 메모리에 없는 agent 만 합친 뒤 저장한다
//   (메모리 쪽이 더 새 보고다 — 79회차 R2 정비 창 계수와 같은 '덮지 않고 합친다'). 손상은 예전과 같다(보존 후 빈 값).
let resultsReadBlocked = false; let resultsRetryAt = 0;
const parseResultsFile = (text) => loadResultsFileText(text);
function loadResultsFileText(text) {
  const raw = JSON.parse(text) || {};
  const out = Object.create(null);
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const k of Object.keys(raw)) {
      const v = raw[k];
      if (!v || typeof v !== 'object') continue;
      out[k] = { at: numOrNull(v.at), ...sanitizeScanResult(v) };
    }
  }
  return out;
}
{
  const r = readJsonFile(RESULT_FILE, { parse: parseResultsFile });
  if (r.kind === 'ok') results = r.value;
  else if (r.kind === 'read-error') { resultsReadBlocked = true; resultsRetryAt = Date.now() + READ_RETRY_MS; console.warn(`[central] agent-results.json 읽기 오류(${(capStr(r.error?.code, 32) || 'read-error')}) — 손상이 아니라 원본은 그대로 둡니다 · 읽힐 때까지 결과를 저장하지 않습니다`); }
  else if (r.kind === 'corrupt') console.error(`[central] agent-results.json 파싱 실패: ${safeLoadText(r.error) || '사유 미상'}`); // v2.744 RG2744-02: 사유는 요약(원문 = 파일 조각)
}
/** 87회차 ⓐ: 저장해도 되는가 — 읽기 오류였으면 간격마다 다시 읽어 합친다. 아직 못 읽으면 false(이번 저장을 건너뛴다). */
function resultsWritable() {
  if (!resultsReadBlocked) return true;
  if (inRetryWindow(Date.now(), resultsRetryAt, READ_RETRY_MS)) return false;
  const r = readJsonFile(RESULT_FILE, { parse: parseResultsFile });
  if (r.kind === 'read-error') { resultsRetryAt = Date.now() + READ_RETRY_MS; return false; }
  if (r.kind === 'ok') for (const k of Object.keys(r.value)) if (!(k in results)) results[k] = r.value[k];
  resultsReadBlocked = false; resultsRetryAt = 0;
  console.warn('[central] agent-results.json 다시 읽었습니다(읽기 오류 풀림 — 파일의 결과를 합쳤습니다)');
  return true;
}

let persistTimer = null;
function persistResults() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      if (!resultsWritable()) { persistResults(); return; }   // 87회차 ⓐ: 읽기 오류 중 — 원본을 덮지 않고 다음 주기에 다시 본다
      fs.mkdirSync(path.dirname(RESULT_FILE), { recursive: true });
      // 원자적 쓰기 — 직접 writeFileSync 는 쓰는 도중 크래시/정전 시 절단본을 남기고,
      // 위의 로드 catch 가 그 절단본을 보고 빈 값으로 출발하게 만든다(같은 파일 왕복 손상).
      atomicWriteFileSync(RESULT_FILE, JSON.stringify(results), { mode: 0o600 });
    } catch { /* best effort */ }
  }, 3_000);
  persistTimer.unref?.();
}
registerExitFlush('central/assignments.results', () => { if (!persistTimer) return; clearTimeout(persistTimer); persistTimer = null; if (!resultsWritable()) return; atomicWriteFileSync(RESULT_FILE, JSON.stringify(results), { mode: 0o600 }); });   // 87회차 ⓐ

// v2.601(감사 CEN2601-04): 결과를 가진 agent 수 상한 — 라우트가 배정 없는 이름을 거절하지만(1차 방어), 배정이 지워진 옛 이름·
//   파일에 이미 쌓인 이름이 무한히 남지 않게 가장 오래된 보고부터 밀어낸다.
const RESULT_AGENTS_MAX = envPositive(process.env.CENTRAL_RESULT_AGENTS_MAX, 500);
export function setResult(agent, data) {
  const key = String(agent);
  if (!(key in results)) {
    const keys = Object.keys(results);
    if (keys.length >= RESULT_AGENTS_MAX) {
      keys.sort((x, y) => (results[x]?.at || 0) - (results[y]?.at || 0));
      for (const k of keys.slice(0, keys.length - RESULT_AGENTS_MAX + 1)) delete results[k];
      console.warn(`[central] agent-results: agent 수 상한(${RESULT_AGENTS_MAX}) — 가장 오래된 보고를 밀어냈습니다.`);
    }
  }
  results[key] = { at: Date.now(), ...sanitizeScanResult(data) };
  persistResults();
}

export function getResults() {
  return results;
}

/**
 * 폼의 '에이전트 이름' 선택 목록. 자유 타이핑으로 인한 AGENT_NAME 오타·불일치를 막기 위해,
 * 이미 알려진 에이전트 이름을 한 목록으로 합친다(대소문자 무시 중복 제거 — 잡 매칭도 소문자 기준).
 * 출처 우선순위: collector(수집 서버로 등록된 실제 이름) > reported(중앙에 보고) > assignment.
 * @param {{assignments?:Array, results?:object, collectors?:Array}} src
 * @returns {Array<{name:string, source:'collector'|'reported'|'assignment'}>}
 */
export function mergeKnownAgents({ assignments = [], results = {}, collectors = [] } = {}) {
  const known = new Map(); // lowerKey → { name, source }
  const add = (v, source) => {
    const s = String(v || '').trim();
    if (!s) return;
    const k = s.toLowerCase();
    const cur = known.get(k);
    // collector는 비-collector를 덮어쓴다(권위 있는 실제 이름). 단, 이미 collector면
    // 덮어쓰지 않는다 — 먼저 넣은 name(수집 서버 표시명)이 id(소문자)에 밀리지 않게.
    if (!cur || (source === 'collector' && cur.source !== 'collector')) known.set(k, { name: s, source });
  };
  for (const a of assignments) add(a?.agent, 'assignment');
  for (const k of Object.keys(results || {})) add(k, 'reported');
  for (const c of collectors) { add(c?.name, 'collector'); add(c?.id, 'collector'); }
  return [...known.values()].sort((a, b) => a.name.localeCompare(b.name));
}
