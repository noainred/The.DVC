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
import { atomicWriteFileSync } from '../util/atomicWrite.js';
import { hashPassword } from '../auth/auth.js';

const FILE = path.join(config.configDir, 'central-agent-users.json');
const VALID_ROLES = ['admin', 'operator', 'viewer'];
const USER_RE = /^[A-Za-z0-9._@-]{2,64}$/;

let byAgent = Object.create(null); // agent -> { at, users: [...] }
try { if (fs.existsSync(FILE)) byAgent = Object.assign(Object.create(null), JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}); } catch { byAgent = Object.create(null); }

function persist() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  atomicWriteFileSync(FILE, JSON.stringify(byAgent), { mode: 0o600 });
}
const cleanAgent = (a) => String(a || '').trim();

/** 배포용 사용자 목록(비밀번호 해시 포함) — 엣지 pull이 사용. */
export function getAgentUsers(agent) {
  const a = cleanAgent(agent);
  return a && byAgent[a] ? (byAgent[a].users || []) : [];
}

/** 사용자 추가/수정(비밀번호 주면 해시로 변환 저장, 없으면 기존 유지). 반환 { ok, reason? }. */
export function upsertAgentUser(agent, { username, name, role = 'viewer', password } = {}) {
  const a = cleanAgent(agent);
  if (!a) return { ok: false, reason: 'agent 필요' };
  username = String(username || '').trim();
  if (!USER_RE.test(username)) return { ok: false, reason: '사용자 ID 형식이 올바르지 않습니다(영문·숫자·._@- 2~64자).' };
  if (!VALID_ROLES.includes(role)) return { ok: false, reason: '역할이 올바르지 않습니다(admin/operator/viewer).' };
  if (password != null && password !== '') {
    if (typeof password !== 'string') return { ok: false, reason: '비밀번호 형식 오류' };
    if (password.length < 8 || password.length > 128) return { ok: false, reason: '비밀번호는 8~128자여야 합니다.' };
  }
  const entry = byAgent[a] || { at: 0, users: [] };
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
  byAgent[a] = { at: Date.now(), users };
  persist();
  return { ok: true };
}

/** 사용자 제거(다음 pull에 엣지에서도 삭제됨). */
export function removeAgentUser(agent, username) {
  const a = cleanAgent(agent);
  const entry = byAgent[a];
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
  return Object.keys(byAgent).map((agent) => ({ agent, at: byAgent[agent]?.at || 0, users: (byAgent[agent]?.users || []).length }))
    .sort((x, y) => (y.at || 0) - (x.at || 0));
}
