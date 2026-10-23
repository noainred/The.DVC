/**
 * veeam/registry.js — Veeam Backup & Replication 서버 등록부(v2.751).
 *
 * 서버는 **중앙 포탈에서 등록**하고 ① 어느 vCenter 의 VM 을 백업하는지(vcenterIds) ② 누가 읽는지(agent)를 정한다:
 *   agent '' = 중앙이 직접 읽음 · agent '<엣지명>' = 그 엣지가 읽음(스토리지 원격 점검과 같은 축 — storage/registry.js).
 * 엣지는 자기 몫을 config pull(agent/veeamConfigPull.js)로 받아 이 등록부에 pulled:true 로 반영한다(같은 모듈이 양쪽에서 동작).
 *
 * 보안(server/CLAUDE.md — 자격증명 파일 규칙):
 *  - password 는 secretVault 봉인(SECRET_FILES 에 veeam-servers.json 등록) · 원자적 쓰기 · 로드 손상 preserveCorrupt.
 *  - host 는 형식 화이트리스트 + ssrfBlockReason(링크로컬·루프백·우회 표기 차단, RFC1918 허용).
 *  - 접속처(host·port·username)가 바뀌면 저장 비밀번호를 승계하지 않는다(util/secretCarry.js). agent 변경은 승계한다(같은 서버).
 *  - 비밀번호 제어문자 거부(헤더·폼 본문 오류 문구로 값이 새지 않게 — storage v2.311 과 같은 이유).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { makeLoadError, filterObjectElements, devicesForThisNode as coreForThisNode, devicesForAgent as coreForAgent } from '../util/registryCore.js';
import { openSecretsDeep, sealSecretsDeep } from '../security/secretVault.js';
import { ssrfBlockReason } from '../collector/registry.js';
import { accessMoved, dropCarriedSecrets } from '../util/secretCarry.js';

const FILE = () => path.join(config.configDir, 'veeam-servers.json');
export const MAX_SERVERS = 200;
const RE_HOST = /^[A-Za-z0-9][A-Za-z0-9._-]{0,253}$/;
const RE_NAME = /^[^<>"']{1,64}$/;
const RE_API_VER = /^\d{1,2}\.\d{1,2}-rev\d{1,2}$/;
export const DEFAULT_PORT = 9419;
// v12.0 의 첫 판(1.1-rev0). 상위 판 서버(12.1~13)도 이전 판을 받는다 — 서버가 거절하면 화면에서 바꾼다.
export const DEFAULT_API_VERSION = '1.1-rev0';

let _db = null;
const loadErr = makeLoadError();
export function registryLoadError() { load(); return loadErr.get(); }

function load() {
  if (_db) return _db;
  try {
    if (fs.existsSync(FILE())) {
      const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('형식 오류');
      const p = openSecretsDeep(raw);
      _db = { servers: filterObjectElements(p.servers).list };
      return _db;
    }
  } catch (e) { preserveCorrupt(FILE(), e?.message); loadErr.set(e); }
  loadErr.checkCorruptOnly(FILE());
  _db = { servers: [] };
  return _db;
}

function persist() {
  atomicWriteFileSync(FILE(), JSON.stringify(sealSecretsDeep({ version: 1, servers: load().servers }), null, 2), { mode: 0o600 });
  loadErr.clear();
}

const redact = ({ password, ...d }) => ({ ...d, hasPassword: !!password });
/**
 * v2.762(G1·G2): 접속처 지문 — 소문자 host:port:username 의 sha256 앞 16자. 결과에 실어 '어느 접속처에서 읽은 것인가' 를 대조한다
 *   (secretCarry.accessMoved 와 같은 세 칸 · 사용자명 평문을 결과 파일·선로에 싣지 않는다). 비밀번호는 넣지 않는다(바꿔도 같은 서버).
 */
export function accessFingerprint(d) {
  if (!d || typeof d !== 'object') return '';
  const key = `${String(d.host ?? '').trim().toLowerCase()}:${Number(d.port) || DEFAULT_PORT}:${String(d.username ?? '').trim().toLowerCase()}`;
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}
/** 목록 — 비밀번호는 반환하지 않는다(hasPassword 만). */
export function listServers() { return load().servers.map(redact); }
/** 수집기 전용(비밀 포함). */
export function getServerWithSecret(id) { return load().servers.find((d) => d.id === id) || null; }

/** 입력 검증(순수). 오류면 사유, 정상이면 null. */
export function serverInputIssue(input = {}) {
  if (!RE_NAME.test(String(input.name || '').trim())) return '표시명 형식 오류(1~64자, <>"\' 금지)';
  const host = String(input.host || '').trim();
  if (!RE_HOST.test(host)) return 'host 형식 오류 — IP/호스트명만(스킴·포트·공백·선행 - 불가)';
  const ssrf = ssrfBlockReason(`https://${host}`);
  if (ssrf) return `host 차단: ${ssrf}`;
  const port = input.port == null || input.port === '' ? DEFAULT_PORT : Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return '포트는 1~65535 정수여야 합니다.';
  if (!String(input.username || '').trim()) return '접속 계정을 입력하세요.';
  if (/[\x00-\x1f\x7f]/.test(String(input.password ?? ''))) return '비밀번호에 제어문자(개행·탭 등)가 포함되어 있습니다 — 붙여넣기 내용을 확인하세요.'; // eslint-disable-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(String(input.username ?? ''))) return '계정에 제어문자가 포함되어 있습니다.'; // eslint-disable-line no-control-regex
  const v = String(input.apiVersion || '').trim();
  if (v && !RE_API_VER.test(v)) return "API 판 형식 오류 — 예: '1.1-rev0'(v12.0)·'1.1-rev2'(v12.2)·'1.2-rev0'(v13)";
  const ids = normVcenterIds(input.vcenterIds);
  if (!ids.length) return '이 Veeam 서버가 백업하는 vCenter 를 하나 이상 고르세요.';
  return null;
}

function normVcenterIds(v) {
  const arr = Array.isArray(v) ? v : (typeof v === 'string' && v ? [v] : []);
  const out = [];
  for (const x of arr) {
    const id = typeof x === 'string' ? x.trim() : '';
    if (id && id.length <= 128 && !/[\x00-\x1f]/.test(id) && !out.includes(id)) out.push(id); // eslint-disable-line no-control-regex
    if (out.length >= 32) break;
  }
  return out;
}

export function saveServer(input = {}) {
  const db = load();
  const issue = serverInputIssue(input);
  if (issue) throw new Error(issue);
  const host = String(input.host || '').trim();
  const port = input.port == null || input.port === '' ? DEFAULT_PORT : Number(input.port);
  const username = String(input.username || '').trim();
  const existing = input.id ? db.servers.find((d) => d.id === input.id) : null;
  if (input.id && !existing) throw new Error('서버를 찾을 수 없습니다.');
  const dev = existing || { id: `vbr-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, createdAt: Date.now(), pulled: false };
  // 접속처(host·port·username)가 바뀌면 옛 비밀번호를 새 접속처로 보내지 않는다(util/secretCarry.js).
  const moved = !!existing && accessMoved({ host: existing.host, port: String(existing.port || DEFAULT_PORT), username: existing.username || '' },
    { host, port: String(port), username }, ['host', 'port', 'username']);
  const password = String(input.password ?? '');
  let droppedSecrets = [];
  if (password && password !== '********') dev.password = password;
  else if (moved) droppedSecrets = dropCarriedSecrets(dev, input, ['password']);
  if (!existing && !dev.password) throw new Error('비밀번호를 입력하세요.');
  if (!existing && db.servers.some((d) => String(d.host).toLowerCase() === host.toLowerCase() && Number(d.port || DEFAULT_PORT) === port)) {
    throw new Error(`이미 등록된 Veeam 서버입니다(${host}:${port}).`);
  }
  Object.assign(dev, {
    name: String(input.name || '').trim(), host, port, username,
    agent: String(input.agent || '').trim().slice(0, 64),
    vcenterIds: normVcenterIds(input.vcenterIds),
    apiVersion: String(input.apiVersion || '').trim() || DEFAULT_API_VERSION,
    enabled: input.enabled !== false, note: String(input.note || '').slice(0, 200),
  });
  if (!existing) {
    if (db.servers.length >= MAX_SERVERS) throw new Error(`Veeam 서버는 최대 ${MAX_SERVERS}대까지 등록할 수 있습니다.`);
    db.servers.push(dev);
  }
  persist();
  // v2.761 B4: moved 를 돌려준다 — 호출부(관리 라우트·대량 가져오기)가 옛 접속처의 결과(lastOk)와 인증 정지를 지운다.
  return { ...redact(dev), ...(droppedSecrets.length ? { droppedSecrets } : {}), ...(moved ? { moved: true } : {}) };
}

export function deleteServer(id) {
  const db = load();
  const i = db.servers.findIndex((d) => d.id === id);
  if (i < 0) return false;
  db.servers.splice(i, 1); persist();
  return true;
}

/** 이 노드가 읽을 서버(중앙 = agent '' · 엣지 = agent 가 내 이름). */
export function serversForThisNode({ servers = load().servers, agentName = config.agent.name, isEdge = !!config.agent.centralUrl } = {}) {
  return coreForThisNode(servers, { agentName, isEdge });
}
/** 특정 엣지 몫(중앙의 config 서빙용 — 비밀번호 포함: 엣지가 Veeam 에 로그인해야 한다). */
export function serversForAgent(agentName) { return coreForAgent(load().servers, agentName); }
/** 이 vCenter 에 연결된 서버(비밀 없음). */
export function serversForVcenter(vcenterId) {
  return load().servers.filter((d) => d.enabled !== false && Array.isArray(d.vcenterIds) && d.vcenterIds.includes(vcenterId)).map(redact);
}

/**
 * 엣지: 중앙 pull 결과 반영 — 내 몫을 통째로 교체(중앙에서 지운 서버가 유령으로 남지 않게). 빠진 id(removed)와
 * 접속처(host·port·username)가 바뀐 id(moved — v2.761 B4: 호출부가 옛 결과·인증 정지를 지운다)를 돌려준다.
 * v2.761 B6: 중앙에서 받은 원소(pulled)는 **agent 이름과 무관하게** 전부 교체한다 — 엣지 이름이 바뀌면 옛 이름으로 받은 서버
 *   (봉인된 비밀번호 포함)가 영구히 남았다. 남기는 것은 이 노드에서 직접 등록한(pulled 아님) 남의 몫뿐이다.
 */
export function applyPulledServers(list) {
  const db = load();
  const mine = String(config.agent.name || '').toLowerCase();
  const replaced = (d) => d.pulled === true || String(d.agent || '').toLowerCase() === mine;
  const keep = db.servers.filter((d) => !replaced(d));
  const prevById = new Map(db.servers.filter(replaced).map((d) => [String(d.id), d]));
  const before = new Set(prevById.keys());
  const clean = (Array.isArray(list) ? list : []).filter((d) => d && typeof d === 'object' && typeof d.id === 'string' && !serverInputIssue({ ...d, password: d.password || '' }))
    .slice(0, MAX_SERVERS)
    .map((d) => ({
      id: d.id.slice(0, 64), name: String(d.name).trim(), host: String(d.host).trim(), port: Number(d.port) || DEFAULT_PORT,
      username: String(d.username).trim(), password: typeof d.password === 'string' ? d.password : '', agent: String(d.agent || '').trim(),
      vcenterIds: normVcenterIds(d.vcenterIds), apiVersion: RE_API_VER.test(String(d.apiVersion || '')) ? d.apiVersion : DEFAULT_API_VERSION,
      enabled: d.enabled !== false, note: String(d.note || '').slice(0, 200), pulled: true,
    }));
  db.servers = [...keep, ...clean];
  persist();
  const now = new Set(clean.map((d) => d.id));
  const moved = clean.filter((d) => {
    const p = prevById.get(d.id);
    return !!p && accessMoved({ host: p.host, port: String(p.port || DEFAULT_PORT), username: p.username || '' },
      { host: d.host, port: String(d.port), username: d.username }, ['host', 'port', 'username']);
  }).map((d) => d.id);
  return { count: clean.length, rejected: (Array.isArray(list) ? list.length : 0) - clean.length, removed: [...before].filter((id) => !now.has(id)), moved };
}

export function _resetForTest() { _db = null; loadErr.clear(); }
