/**
 * 중앙에서 지정하는 'agent(엣지)별 배포 사용자' 저장소.
 *
 * 목적: 중앙에서 원격 엣지 포탈에 접속(설정 열람 등)할 수 있는 사용자를 일괄 관리한다. 엣지는
 * 폐쇄망/NAT 뒤에 있을 수 있으므로, 중앙이 지정한 사용자 목록을 엣지가 아웃바운드로 pull해
 * 자기 로컬 users.json에 managed 태그로 반영한다(GPU 게스트 설정 배포와 동일한 pull 패턴).
 *
 * 비밀번호는 중앙에서 scrypt 해시로 변환해 보관·배포한다(평문 미보관). 엣지는 그 해시를 그대로
 * 저장하므로 노드 간 검증이 호환된다(scrypt 해시는 자체 완결형).
 *
 * 저장: CONFIG_DIR/central-agent-users.json (0600, 원자적 쓰기). 클라이언트로는 해시를 가린다.
 *   { [agent]: { at, users: [{ username, name, role, passwordHash }] } }
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, safeLoadText } from '../util/atomicWrite.js';
import { hashPassword } from '../auth/auth.js';
import { agentKeyOf } from '../util/agentKey.js';
import { capStr } from '../util/capStr.js'; // v2.612: 상주 사유 문자열은 평탄화해 자른다(v2.607 TIM2607-01)
import { makeSettingsLoadError } from '../util/settingsLoadError.js';
import { parseJsonObject } from '../util/jsonObject.js'; // v3.17.2: 객체가 아닌 JSON(수 · 글자 · 배열)은 깨진 JSON 과 같이 — 손상 보존 경로로
import { makeJsonFileReader, READ_RETRY_MS } from '../util/jsonFileLoad.js'; // 87회차 ⓐ: 읽기 오류 ≠ 손상(공용 읽기 판정)

const FILE = path.join(config.configDir, 'central-agent-users.json');
const VALID_ROLES = ['admin', 'operator', 'viewer'];
const USER_RE = /^[A-Za-z0-9._@-]{2,64}$/;
// 특수 키 '*' = 모든 엣지에 공통 배포되는 글로벌 목록. 엣지 pull 시 자기 목록과 합쳐 적용되므로
// 신규 엣지도 자동으로 글로벌 사용자를 받는다(대상을 스냅샷하지 않아 동적).
export const GLOBAL_AGENT = '*';

let byAgent = Object.create(null); // agent -> { at, users: [...] }
// ⚠ 손상 시 조용히 빈 객체로 시작하면 다음 persist()가 온전했던 배포 사용자(비밀번호 해시 포함)
// 원본을 덮어써 영구 유실된다 — preserveCorrupt 로 보존한 뒤에만 빈 값으로 출발한다.
// v2.612 LEFT2612-01: 읽지 못했으면(손상 → 보존, 또는 파일 없이 손상 보존본만 있음) 그 사실을 기억한다 — /users-config 가 503 으로
//   답해 엣지가 관리 계정(managed)을 전부 지우지 않게. 다음 저장이 성공하면 풀린다.
let _loadError = null;
export function registryLoadError() { fresh(); return _loadError; }   // 87회차 ⓐ: 읽기 오류면 간격마다 다시 읽는다
/*
 * 전체 점검 17회차(C-10 — 재현): 읽지 못한 동안 **쓰지 않는다**. 예전에는 관리자가 아무 엣지 하나에 사용자를 추가하면 그 1건만 든 파일이
 *   쓰이고 표지가 풀렸다 — /users-config 가 503 대신 200 으로 줄어든 목록을 내려 **다른 모든 엣지의 managed 계정이 지워졌다**
 *   (엣지 agent/usersConfigPull.js 는 빠진 managed 계정을 제거한다). 관리 화면은 손상을 알리지 않아 관리자는 빈 목록만 보고 저장했다.
 *   해제는 ① 손상 보존본(.corrupt.*)을 되돌리고 재시작 ② 서비스 점검 › 설정 파일 '기본값으로 확정'(지금 메모리 값 = 빈 목록을 배포 —
 *   사람이 정한다, settingsLoadError 규약) 둘뿐이다. 표지 원문(_loadError.reason)은 그대로 둔다 — 503 의 위치 요약(summarizeRegistryError)의 원천.
 *   `_svc` 는 서비스 점검 목록 · 확정 경로에 올리는 사본이다(같은 자리에서 함께 세우고 푼다).
 */
const _svc = makeSettingsLoadError(() => FILE, { label: '엣지 배포 사용자(엣지별) — 확정하면 모든 엣지의 배포 계정이 지워집니다', confirm: () => persist(), ownerOnly: true });   // 18회차 반증 B-2: 쓰기 라우트(requireSettingsOwner)와 같은 등급 · 87회차 ⓐ: recheckMs 는 주지 않는다(손상 · 보존본만 남음은 재시작이 다시 읽는다 — 읽기 오류만 간격 재읽기)
function writeRefusal() {
  fresh();
  if (!_loadError) return null;
  // 87회차 ⓐ: 읽기 오류(원본은 그 자리에 그대로)는 조치가 다르다 — 보존본 · 확정이 아니라 권한 · 소유자 · 디스크.
  if (_readPending) return { ok: false, code: 'registry-unreadable', status: 503, readError: true,
    reason: `엣지 배포 사용자 파일(central-agent-users.json)을 읽지 못한 상태라 저장하지 않았습니다 — 읽기 오류이고 원본은 그대로 있습니다. 파일 권한 · 소유자(포탈 서비스 계정) · 디스크를 확인하세요(${Math.round(READ_RETRY_MS / 1000)}초마다 다시 읽고, 읽히면 저장이 다시 열립니다).` };
  return { ok: false, code: 'registry-unreadable', status: 503,
    reason: '엣지 배포 사용자 파일(central-agent-users.json)을 읽지 못한 상태라 저장하지 않았습니다 — 지금 저장하면 손상 보존본(.corrupt.*)에만 남은 다른 엣지의 배포 사용자가 모든 엣지에서 지워집니다. 보존본을 되돌리고 재시작하거나, 서비스 점검의 설정 파일에서 기본값으로 확정한 뒤 다시 저장하세요.' };
}
/**
 * v2.742(LEFT-01 — 재현): 대소문자만 다른 중복 키를 하나로 합친다(순수). 예전 쓰기(upsertAgentUser·removeAgentUser)는 읽기와 달리
 *   **글자 그대로** 키를 써서, 'edge-a' 에 배포된 사용자를 'Edge-A' 이름으로 추가하면 그 사용자 하나만 든 **새 목록**이 생겼다 — 'Edge-A'
 *   엣지는 그 목록을 받아(정확히 같은 키가 먼저다) 나머지 관리 계정(managed)을 지웠고, 'Edge-A' 이름의 삭제는 '없는 agent' 로 실패했다.
 *   이제 쓰기도 기존 키에 쓰고, 이미 생긴 중복은 로드 때 **가장 최근(at) 키**로 합친다 — 사용자는 합집합이고 같은 ID 는 최근 목록이 이긴다
 *   (어느 쪽 목록에서도 사람이 지운 적 없는 계정을 엣지에서 지우지 않게). 합친 사실은 콘솔에 남긴다. 파일은 다음 저장 때 다시 쓰인다.
 * @returns {{ map: object, merged: Array<{kept:string, dropped:string[]}> }}
 */
export function foldCaseDuplicateAgentUsers(map) {
  const src = map && typeof map === 'object' ? map : {};
  const groups = new Map();
  for (const k of Object.keys(src)) {
    const lo = k.toLowerCase(); // agentKeyOf 와 같은 비교(소문자)
    if (!groups.has(lo)) groups.set(lo, []);
    groups.get(lo).push(k);
  }
  const out = Object.create(null);
  const merged = [];
  for (const keys of groups.values()) {
    if (keys.length === 1) { out[keys[0]] = src[keys[0]]; continue; }
    const at = (k) => Number(src[k]?.at) || 0;
    const sorted = [...keys].sort((x, y) => at(y) - at(x) || (x < y ? -1 : x > y ? 1 : 0));
    const byName = new Map();
    // 오래된 것부터 넣고 최근 것이 덮는다 — 같은 ID 면 최근 목록의 값.
    for (const k of [...sorted].reverse()) for (const u of (Array.isArray(src[k]?.users) ? src[k].users : [])) if (u && u.username) byName.set(u.username, u);
    out[sorted[0]] = { at: at(sorted[0]), users: [...byName.values()] };
    merged.push({ kept: sorted[0], dropped: sorted.slice(1) });
  }
  return { map: out, merged };
}
/*
 * 87회차 ⓐ(84회차 남긴 것 ② — 권장안): 공용 읽기 판정(util/jsonFileLoad.js). 예전에는 기동 때 한 번 읽고 catch 하나가 **읽기 오류**(EACCES · EIO)도
 *   손상으로 보고 온전한 원본(배포 계정 해시)을 `.corrupt.*` 로 옮겼다 — 권한을 고쳐도 보존본을 되돌리고 재시작해야 했고, 서비스 점검 '기본값으로 확정'
 *   (빈 목록 배포 — 모든 엣지의 배포 계정 삭제)이 열렸다. 이제 읽기 오류는 원본을 두고 · 표지(readError)를 세워 /users-config 503 · 저장 거절을 유지하며 ·
 *   READ_RETRY_MS 간격으로 다시 읽어(조회 · 저장 경로가 부른다) 읽히면 재시작 없이 풀린다. 손상 · 보존본만 남음은 예전과 같다.
 */
const _reader = makeJsonFileReader(() => FILE, { parse: (t) => foldCaseDuplicateAgentUsers(parseJsonObject(t)), preserve: true, tag: 'central' });
let _readPending = false;
function loadFromDisk() {
  const r = _reader.read();
  if (r.kind === 'read-error') {
    const code = (capStr(r.error?.code, 32) || 'read-error');
    if (!_readPending || !_loadError) _loadError = { at: Date.now(), reason: `${code}: 읽기 오류 — 손상이 아니라 원본은 그대로 둡니다`, readError: true };
    _readPending = true;
    _svc.readError(r.error, { retryMs: READ_RETRY_MS });
    byAgent = Object.create(null);
    return;
  }
  if (_readPending) { _readPending = false; _loadError = null; _svc.ok(); }
  if (r.kind === 'ok') {
    byAgent = Object.assign(Object.create(null), r.value.map);
    for (const m of r.value.merged) console.warn(`[central] central-agent-users.json: 대소문자만 다른 엣지 이름 ${[m.kept, ...m.dropped].join(', ')} 의 배포 사용자를 ${m.kept} 하나로 합쳤습니다(사용자 합집합 · 같은 ID 는 최근 목록). 배포 사용자 화면에서 확인하세요.`);
    return;
  }
  byAgent = Object.create(null);
  if (r.kind === 'missing') {
    let hit = null;
    try { const base = path.basename(FILE) + '.corrupt.'; hit = fs.readdirSync(path.dirname(FILE)).filter((n) => n.startsWith(base)).sort().pop() || null; } catch { hit = null; }
    if (hit) { _loadError = { at: Date.now(), reason: `등록부 파일이 없고 손상 보존본(${hit})만 있습니다` }; _svc.missing(); }
    return;
  }
  // 손상(reader 가 preserveCorrupt 로 보존했다).
  // v2.744(최종 검토 RG2744-02): 콘솔 사유는 요약이다(원문 = 비밀번호 해시 앞부분 같은 파일 조각 — 콘솔 링버퍼로 나간다).
  //   메모리의 _loadError.reason 은 원문 그대로 둔다 — 밖으로 나가는 경로(routes/central.js registryUnreadable)가 summarizeRegistryError 로 요약하고
  //   관리자용 줄·칸 위치가 이 원문에서 나온다.
  console.error(`[central] central-agent-users.json 파싱 실패: ${safeLoadText(r.error) || '사유 미상'}`);
  _loadError = { at: Date.now(), reason: capStr(String(r.error?.message || r.error), 200) };
  _svc.corrupt(r.error);
}
/** 87회차 ⓐ: 읽기 오류가 서 있으면 다시 읽는다(간격 안에서는 디스크를 보지 않는다 — makeJsonFileReader). 조회 · 저장 경로가 부른다. */
function fresh() { if (_readPending) loadFromDisk(); }
loadFromDisk();

function persist() {
  // 87회차 ⓐ: 마지막 방어선 — 읽기 오류 중에는 어느 경로(확정 포함)도 원본을 덮지 않는다(settingsLoadError 는 읽기 오류의 확정을 이미 막는다).
  if (_readPending) throw Object.assign(new Error('엣지 배포 사용자 파일을 읽지 못한 상태라 저장하지 않았습니다(읽기 오류 — 원본은 그대로).'), { code: 'registry-unreadable', readError: true });
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  atomicWriteFileSync(FILE, JSON.stringify(byAgent), { mode: 0o600 });
  _loadError = null; // v2.612 LEFT2612-01 — 17회차(C-10)부터 쓰기 함수는 읽지 못한 동안 여기에 오지 않는다(확정 경로만)
  _svc.ok(); _reader.reset();
}
const cleanAgent = (a) => String(a || '').trim();

/** 특정 대상(agent 또는 '*')에 직접 지정된 사용자 목록(해시 포함). 관리 화면의 대상별 목록용. */
export function getAgentUsers(agent) {
  fresh();   // 87회차 ⓐ
  const a = cleanAgent(agent);
  const k = a ? agentKeyOf(byAgent, a) : null; // v2.597 L2597-03 — 대소문자만 다른 이름도 같은 엣지
  return k != null && byAgent[k] ? (byAgent[k].users || []) : [];
}

/**
 * 엣지 pull이 실제로 적용할 '유효 사용자' = 글로벌('*') + 이 엣지 전용. 같은 ID면 엣지 전용이
 * 글로벌을 덮어쓴다(개별 지정이 우선). 엣지는 이 결과를 로컬 users.json에 managed로 반영.
 */
export function getEffectiveUsers(agent) {
  const a = cleanAgent(agent);
  const byName = new Map();
  for (const u of getAgentUsers(GLOBAL_AGENT)) byName.set(u.username, u);
  if (a && a !== GLOBAL_AGENT) for (const u of getAgentUsers(a)) byName.set(u.username, u); // 개별이 글로벌 우선
  return [...byName.values()];
}

/** 사용자 추가/수정(비밀번호 주면 해시로 변환 저장, 없으면 기존 유지). 반환 { ok, reason? }. */
export function upsertAgentUser(agent, { username, name, role = 'viewer', password } = {}) {
  const refused = writeRefusal(); if (refused) return refused;
  const a = cleanAgent(agent);
  if (!a) return { ok: false, reason: 'agent 필요' };
  username = String(username || '').trim();
  if (!USER_RE.test(username)) return { ok: false, reason: '사용자 ID 형식이 올바르지 않습니다(영문·숫자·._@- 2~64자).' };
  if (!VALID_ROLES.includes(role)) return { ok: false, reason: '역할이 올바르지 않습니다(admin/operator/viewer).' };
  if (password != null && password !== '') {
    if (typeof password !== 'string') return { ok: false, reason: '비밀번호 형식 오류' };
    if (password.length < 8 || password.length > 128) return { ok: false, reason: '비밀번호는 8~128자여야 합니다.' };
  }
  // v2.742(LEFT-01): 읽기(getAgentUsers)와 같은 규칙으로 기존 키에 쓴다 — 대소문자만 다른 이름이 새 목록을 만들지 않게.
  const k = agentKeyOf(byAgent, a) ?? a;
  const entry = byAgent[k] || { at: 0, users: [] };
  const users = entry.users || [];
  const cur = users.find((u) => u.username === username);
  if (cur) {
    cur.name = name || username; cur.role = role;
    if (password) cur.passwordHash = hashPassword(password);
  } else {
    const u = { username, name: name || username, role };
    if (password) u.passwordHash = hashPassword(password);
    users.push(u);
  }
  byAgent[k] = { at: Date.now(), users };
  persist();
  return { ok: true };
}

/** 여러 대상(엣지들 또는 '*')에 같은 사용자를 한 번에 배포. 반환 { ok, applied:[], failed:[] }. */
export function upsertAgentUsersBulk(targets, spec) {
  // v2.742(LEFT-01): 대소문자만 다른 대상은 같은 엣지다 — 처음 나온 표기 하나로 줄인다(두 번 '적용됨' 으로 보고하지 않게).
  const seen = new Set();
  const list = Array.isArray(targets) ? targets.map(cleanAgent).filter((t) => t && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase())) : [];
  if (!list.length) return { ok: false, reason: '대상이 없습니다.' };
  const refused = writeRefusal(); if (refused) return refused;
  const applied = []; const failed = [];
  for (const t of list) {
    const r = upsertAgentUser(t, spec);
    if (r.ok) applied.push(t); else failed.push({ agent: t, reason: r.reason });
  }
  return { ok: applied.length > 0, applied, failed };
}

/** 사용자 제거(다음 pull에 엣지에서도 삭제됨). */
export function removeAgentUser(agent, username) {
  const refused = writeRefusal(); if (refused) return refused;
  const a = cleanAgent(agent);
  const k = a ? agentKeyOf(byAgent, a) : null; // v2.742(LEFT-01): 'Edge-A' 로도 'edge-a' 목록에서 지운다
  const entry = k != null ? byAgent[k] : null;
  if (!entry) return { ok: false, reason: '없는 agent' };
  const before = (entry.users || []).length;
  entry.users = (entry.users || []).filter((u) => u.username !== String(username || '').trim());
  if (entry.users.length === before) return { ok: false, reason: '없는 사용자' };
  entry.at = Date.now();
  persist();
  return { ok: true };
}

/** 비밀번호 해시를 가린 목록(관리 UI용). */
export function listAgentUsers(agent) {
  return getAgentUsers(agent).map((u) => ({ username: u.username, name: u.name || u.username, role: u.role || 'viewer', hasPassword: !!u.passwordHash }));
}

/** 배포 사용자가 지정된 agent 요약 목록. */
export function listAgentUserAgents() {
  fresh();   // 87회차 ⓐ
  return Object.keys(byAgent).map((agent) => ({ agent, at: byAgent[agent]?.at || 0, users: (byAgent[agent]?.users || []).length }))
    .sort((x, y) => (y.at || 0) - (x.at || 0));
}
