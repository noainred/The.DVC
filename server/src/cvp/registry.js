/**
 * cvp/registry.js — Arista CloudVision(CVP) 서버 등록부(v2.608).
 *
 * 등록은 **중앙**에서 하고 수집 주체(agent)를 지정한다: agent '' = 중앙 직접 · '<엣지명>' = 그 엣지가 수집.
 * 엣지는 자기 몫을 `agent/cvpConfigPull.js` 로 받아 반영한다(SAN 스위치·스토리지와 같은 위임 축).
 *
 * 보안(server/CLAUDE.md — 되돌리지 말 것):
 *  - token·password 는 secretVault 봉인 대상('cvp-servers.json' 을 SECRET_FILES 에 등록 + .gitignore).
 *  - 원자적 쓰기 + 로드 손상 시 preserveCorrupt(빈 목록 저장이 전 자격증명을 지우는 사고 방지).
 *  - host 는 형식 검사 + ssrfBlockReason(링크로컬/루프백/우회표기 차단, RFC1918 허용).
 *  - **접속 대상(host·username·authMode)이 바뀌면 저장 비밀을 승계하지 않는다**(util/secretCarry — v2.500).
 *  - 응답에는 비밀을 싣지 않는다(`********` + hasToken/hasPassword).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { openSecretsDeep, sealSecretsDeep } from '../security/secretVault.js';
import { ssrfBlockReason } from '../collector/registry.js';
import { accessMoved, dropCarriedSecrets, secretProvided } from '../util/secretCarry.js';

const FILE = () => path.join(config.configDir, 'cvp-servers.json');
export const MAX_SERVERS = 64;
export const REDACTED = '********';
const RE_NAME = /^[^<>"'\x00-\x1f\x7f]{1,64}$/; // eslint-disable-line no-control-regex
const RE_HOSTNAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,253}$/;
const CTRL = /[\x00-\x1f\x7f]/; // eslint-disable-line no-control-regex

/** 엣지 이름 비교 — 대소문자·앞뒤 공백 무시(토큰 바인딩·장비 배정과 같은 규칙 — util/agentKey.js 머리말). */
export const agentKeyEq = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

let _db = null;

/**
 * v2.612 LEFT2612-01: 등록부 파일을 읽지 못했으면(손상 → preserveCorrupt) 그 사실을 기억한다. 설정 pull 라우트
 *   (routes/central.js)가 이 값을 보고 503 으로 답한다 — 빈 목록을 ok:true 로 내려보내면 엣지가 장비 목록·스냅샷을
 *   통째로 지운다. 다음 저장이 성공하면 풀린다(그때부터는 관리자가 다시 만든 목록이 진실이다).
 */
let _loadError = null;
export function registryLoadError() { load(); return _loadError; }
// v2.612 LEFT2612-01: 파일이 없는데 손상 보존본(<파일>.corrupt.<시각>)만 있으면 재시작 뒤에도 '못 읽음' 이다 — 여기서 빈 목록으로
//   출발하면 재시작 한 번으로 엣지 목록 삭제가 되살아난다. 관리자가 한 번 저장하면(파일이 생기면) 풀린다.
function corruptOnlyReason(file) {
  try {
    const dir = path.dirname(file); const base = path.basename(file) + '.corrupt.';
    const hit = fs.readdirSync(dir).filter((n) => n.startsWith(base)).sort().pop();
    return hit ? `등록부 파일이 없고 손상 보존본(${hit})만 있습니다` : null;
  } catch { return null; }
}

function load() {
  if (_db) return _db;
  try {
    if (fs.existsSync(FILE())) {
      const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('형식 오류');
      const p = openSecretsDeep(raw);
      _db = { servers: Array.isArray(p.servers) ? p.servers.filter((s) => s && typeof s === 'object') : [] };
      return _db;
    }
  } catch (e) { preserveCorrupt(FILE(), e?.message); _loadError = { at: Date.now(), reason: String(e?.message || e).slice(0, 200) }; }
  if (!_loadError && !fs.existsSync(FILE())) { const why = corruptOnlyReason(FILE()); if (why) _loadError = { at: Date.now(), reason: why }; }
  _db = { servers: [] };
  return _db;
}

function persist() {
  atomicWriteFileSync(FILE(), JSON.stringify(sealSecretsDeep({ version: 1, servers: load().servers }), null, 2), { mode: 0o600 });
  _loadError = null; // v2.612 LEFT2612-01
}

/**
 * host 입력 → 기준 URL(`https://host[:port]`). URL(스킴 http/https) 또는 `host[:port]` 를 받는다.
 * 경로·쿼리·계정(userinfo)은 받지 않는다(토큰이 URL 에 실려 로그로 새지 않게). 오류면 { issue }.
 * @returns {{ base?: string, issue?: string }}
 */
export function baseUrlOf(host) {
  const raw = typeof host === 'string' ? host.trim() : '';
  if (!raw) return { issue: 'host 를 입력하세요.' };
  if (CTRL.test(raw) || /\s/.test(raw)) return { issue: 'host 에 공백·제어문자가 있습니다.' };
  let u;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`); }
  catch { return { issue: 'host 형식 오류 — URL(https://cvp.example) 또는 호스트[:포트]' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { issue: 'http/https 만 허용됩니다.' };
  if (u.username || u.password) return { issue: 'host 에 계정 정보를 넣지 마세요(인증 칸을 쓰세요).' };
  if ((u.pathname && u.pathname !== '/') || u.search || u.hash) return { issue: 'host 에는 경로·쿼리를 넣지 마세요(주소와 포트만).' };
  const hn = u.hostname.replace(/^\[|\]$/g, '');
  if (!hn || (!RE_HOSTNAME.test(hn) && !/^[0-9a-f:.]+$/i.test(hn))) return { issue: 'host 형식 오류 — IP/호스트명만' };
  const ssrf = ssrfBlockReason(u.origin);
  if (ssrf) return { issue: `host 차단: ${ssrf}` };
  return { base: u.origin };
}

const pub = (s) => {
  if (!s) return null;
  const { token, password, ...rest } = s;
  return { ...rest, token: token ? REDACTED : '', password: password ? REDACTED : '', hasToken: !!token, hasPassword: !!password };
};

/** 목록 — 비밀은 절대 반환하지 않는다. */
export function listServers() { return load().servers.map(pub); }
export function getServer(id) { return pub(load().servers.find((s) => s.id === id) || null); }
/** 비밀 포함(수집기·엣지 배포 전용 — 라우트 응답에 싣지 말 것). */
export function getServerWithSecret(id) { return load().servers.find((s) => s.id === id) || null; }

/** 입력 검증(순수). 오류면 사유, 정상이면 null. `prev` 는 수정 대상(비밀 승계 여부 판정에 쓴다). */
export function serverInputIssue(input = {}, prev = null) {
  if (!input || typeof input !== 'object') return '입력 형식 오류';
  if (!RE_NAME.test(String(input.name ?? '').trim())) return '표시명 형식 오류(1~64자, <>"\' 금지)';
  const b = baseUrlOf(input.host);
  if (b.issue) return b.issue;
  const mode = input.authMode === 'password' ? 'password' : input.authMode === 'token' || input.authMode == null || input.authMode === '' ? 'token' : null;
  if (!mode) return "authMode 는 'token' 또는 'password' 입니다.";
  const moved = prev ? accessMoved(prev, normFields(input), ['host', 'username', 'authMode']) : true;
  if (mode === 'token') {
    const t = input.token;
    if (typeof t === 'string' && CTRL.test(t)) return '토큰에 제어문자(개행·탭 등)가 있습니다 — 붙여넣기 내용을 확인하세요.';
    if (!secretProvided(t) && (moved || !prev?.token)) return '서비스 계정 토큰을 입력하세요.';
  } else {
    if (!String(input.username ?? '').trim()) return '접속 계정을 입력하세요.';
    const p = input.password;
    if (typeof p === 'string' && CTRL.test(p)) return '비밀번호에 제어문자(개행·탭 등)가 있습니다 — 붙여넣기 내용을 확인하세요.';
    if (!secretProvided(p) && (moved || !prev?.password)) return '비밀번호를 입력하세요.';
  }
  const agent = String(input.agent ?? '');
  if (agent.length > 64 || CTRL.test(agent)) return '담당 엣지 이름 형식 오류(64자 이하)';
  return null;
}

function normFields(input) {
  return {
    host: String(input.host ?? '').trim(),
    username: String(input.username ?? '').trim(),
    authMode: input.authMode === 'password' ? 'password' : 'token',
  };
}

/**
 * 저장(신규·수정). 반환은 공개 형태 + (접속 대상이 바뀌어 버린 비밀이 있으면) `droppedSecrets`.
 */
export function saveServer(input = {}) {
  const db = load();
  const existing = input.id ? db.servers.find((s) => s.id === input.id) : null;
  if (input.id && !existing) throw new Error('없는 CVP 서버입니다.');
  const issue = serverInputIssue(input, existing);
  if (issue) throw new Error(issue);
  const f = normFields(input);
  const srv = existing || { id: `cvp-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, createdAt: Date.now() };
  const moved = !!existing && accessMoved(existing, f, ['host', 'username', 'authMode']);
  let droppedSecrets = [];
  if (moved) droppedSecrets = dropCarriedSecrets(srv, input, ['token', 'password']);
  if (secretProvided(input.token)) srv.token = String(input.token).trim();
  if (secretProvided(input.password)) srv.password = String(input.password);
  // 모드와 무관한 비밀은 남기지 않는다(토큰 모드로 바꾸면 비밀번호를 버린다 — 쓰지 않는 비밀을 쥐고 있지 않게).
  if (f.authMode === 'token' && srv.password !== undefined && !secretProvided(input.password)) { delete srv.password; if (existing) droppedSecrets.push('password'); }
  if (f.authMode === 'password' && srv.token !== undefined && !secretProvided(input.token)) { delete srv.token; if (existing) droppedSecrets.push('token'); }
  Object.assign(srv, {
    name: String(input.name).trim(),
    host: f.host,
    authMode: f.authMode,
    username: f.authMode === 'password' ? f.username : '',
    agent: String(input.agent ?? '').trim(),
    verifyTls: input.verifyTls === true,
    enabled: input.enabled !== false,
    datacenterId: String(input.datacenterId ?? '').trim().slice(0, 64),
    note: String(input.note ?? '').slice(0, 200),
    updatedAt: Date.now(),
  });
  if (!existing) {
    if (db.servers.length >= MAX_SERVERS) throw new Error(`CVP 서버는 최대 ${MAX_SERVERS}개까지 등록할 수 있습니다.`);
    if (db.servers.some((s) => baseUrlOf(s.host).base === baseUrlOf(f.host).base && agentKeyEq(s.agent, srv.agent))) throw new Error('같은 주소·같은 담당의 CVP 서버가 이미 등록되어 있습니다.');
    db.servers.push(srv);
  }
  persist();
  return { ...pub(srv), ...(droppedSecrets.length ? { droppedSecrets: [...new Set(droppedSecrets)] } : {}) };
}

export function deleteServer(id) {
  const db = load();
  const i = db.servers.findIndex((s) => s.id === id);
  if (i < 0) return false;
  db.servers.splice(i, 1);
  persist();
  return true;
}

/** 이 노드가 수집할 서버(비밀 포함). 중앙 여부는 centralUrl 로 가른다. */
export function serversForThisNode({ servers = load().servers, agentName = config.agent.name, isEdge = !!config.agent.centralUrl } = {}) {
  return servers.filter((s) => s.enabled !== false && (isEdge ? agentKeyEq(s.agent, agentName) : !String(s.agent || '').trim()));
}

/** 특정 엣지 몫(중앙의 config 서빙용 — 비밀 포함: 엣지가 CVP 에 로그인해야 한다). */
export function serversForAgent(agentName) {
  if (!String(agentName || '').trim()) return [];
  return load().servers.filter((s) => s.enabled !== false && agentKeyEq(s.agent, agentName));
}

/** 엣지: 중앙 pull 결과 반영 — 내 몫을 통째로 교체. 빠진 id 를 돌려준다(호출자가 스냅샷·DB 행을 지운다). */
export function applyPulledServers(list) {
  const db = load();
  const mine = config.agent.name;
  const before = new Set(db.servers.filter((s) => agentKeyEq(s.agent, mine)).map((s) => s.id));
  const keep = db.servers.filter((s) => !agentKeyEq(s.agent, mine));
  const next = (Array.isArray(list) ? list : [])
    .filter((s) => s && typeof s === 'object' && typeof s.id === 'string' && s.id)
    .slice(0, MAX_SERVERS)
    .map((s) => ({ ...s, pulled: true }));
  db.servers = [...keep, ...next];
  persist();
  const nextIds = new Set(next.map((s) => s.id));
  return { count: next.length, removed: [...before].filter((id) => !nextIds.has(id)) };
}

export function _resetForTest() { _db = null; _loadError = null; }
