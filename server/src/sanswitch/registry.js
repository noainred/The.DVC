/**
 * sanswitch/registry.js — SAN 스위치 등록부(v2.410).
 *
 * 장비는 **중앙 포탈에서 등록**하고 수집 주체(agent)를 지정한다:
 *   agent '' = 중앙이 직접 수집 · agent '<엣지명>' = 그 엣지가 수집.
 * 엣지는 자기 몫을 config pull(agent/sanSwitchConfigPull.js)로 받아 pulled:true 로 반영한다
 * (스토리지 모니터링과 완전히 같은 위임 축 — 중앙은 엣지에 명령을 밀어넣을 수 없다).
 *
 * 보안(server/CLAUDE.md — 스토리지 등록부와 동일한 불변조건. 되돌리지 말 것):
 *  - password 는 secretVault 봉인 대상('sanswitch-devices.json' 을 SECRET_FILES 에 등록).
 *  - 원자적 쓰기 + 로드 손상 시 preserveCorrupt(빈 목록 저장이 전 자격증명을 지우는 사고 방지).
 *  - host 는 형식 화이트리스트 + ssrfBlockReason(링크로컬/루프백/우회표기 차단, RFC1918 허용).
 *  - **host 변경 시 저장 비밀번호를 이월하지 않는다**(uagmon M3) — host 바꿔치기로 자격증명이
 *    공격자 서버로 선제 전송되는 경로 차단.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { openSecretsDeep, sealSecretsDeep } from '../security/secretVault.js';
import { ssrfBlockReason } from '../collector/registry.js';
import { isKnownType, isImplementedType, normalizeCollectMethod } from './types.js';
import { accessMoved, dropCarriedSecrets } from '../util/secretCarry.js'; // v2.607 SEC2607-07

const FILE = path.join(config.configDir, 'sanswitch-devices.json');
const MAX_DEVICES = 300;
const RE_HOST = /^[A-Za-z0-9][A-Za-z0-9._-]{0,253}$/;
const RE_NAME = /^[^<>"']{1,64}$/;

let _db = null;

function load() {
  if (_db) return _db;
  try {
    if (fs.existsSync(FILE)) {
      const p = openSecretsDeep(JSON.parse(fs.readFileSync(FILE, 'utf8')));
      _db = { devices: Array.isArray(p.devices) ? p.devices : [] };
      return _db;
    }
  } catch { preserveCorrupt(FILE); }
  _db = { devices: [] };
  return _db;
}

function persist() {
  atomicWriteFileSync(FILE, JSON.stringify(sealSecretsDeep({ version: 1, devices: load().devices }), null, 2), { mode: 0o600 });
}

/** 목록 — 비밀번호는 절대 반환하지 않는다(hasPassword 불리언만). */
export function listDevices() {
  return load().devices.map(({ password, ...d }) => ({ ...d, hasPassword: !!password }));
}
export function getDeviceWithSecret(id) { return load().devices.find((d) => d.id === id) || null; }

/** 입력 검증(순수 — 저장하지 않음). 오류면 사유 문자열, 정상이면 null. */
export function deviceInputIssue(input = {}) {
  const type = String(input.type || '').trim();
  if (!isKnownType(type)) return `알 수 없는 스위치 타입: ${type}`;
  if (!isImplementedType(type)) return `'${type}' 수집기는 아직 미구현입니다(카탈로그의 '예정' 타입 — 등록은 구현 후에).`;
  if (!RE_NAME.test(String(input.name || '').trim())) return '표시명 형식 오류(1~64자, <>"\' 금지)';
  const host = String(input.host || '').trim();
  if (!RE_HOST.test(host)) return 'host 형식 오류 — IP/호스트명만(공백·특수문자·선행 - 불가)';
  const ssrf = ssrfBlockReason(`https://${host}`);
  if (ssrf) return `host 차단: ${ssrf}`;
  if (!String(input.username || '').trim()) return '접속 계정을 입력하세요.';
  // 제어문자 비밀번호 거부(스토리지 등록부와 동일) — 값이 오류 메시지에 실려 유출되는 경로 차단.
  if (/[\x00-\x1f\x7f]/.test(String(input.password ?? ''))) return '비밀번호에 제어문자(개행·탭 등)가 포함되어 있습니다 — 붙여넣기 내용을 확인하세요.'; // eslint-disable-line no-control-regex
  // vfId 는 SSH 수집기가 `setcontext <vfId>;` 로 CLI 에 삽입한다 — 정수(1..128) 또는 빈 값만(셸 조립 불변조건).
  if (input.vfId != null && input.vfId !== '' && !(/^\d{1,3}$/.test(String(input.vfId).trim()) && Number(input.vfId) >= 1 && Number(input.vfId) <= 128)) return 'Virtual Fabric ID 는 1~128 정수만 가능합니다.';
  for (const k of ['sshPort', 'httpsPort']) {
    if (input[k] != null && input[k] !== '' && !(/^\d{1,5}$/.test(String(input[k]).trim()) && Number(input[k]) >= 1 && Number(input[k]) <= 65535)) return `${k} 는 1~65535 정수만 가능합니다.`;
  }
  return null;
}

/** 저장·테스트 공용 정규화(순수) — 검증 통과 입력을 수집기가 기대하는 타입으로 굳힌다(문자열 vfId 가 CLI 에 그대로 가지 않게). */
export function normalizeDeviceInput(input = {}) {
  return {
    ...input,
    type: String(input.type || '').trim(),
    name: String(input.name || '').trim(),
    host: String(input.host || '').trim(),
    username: String(input.username || '').trim(),
    collectMethod: normalizeCollectMethod(String(input.type || '').trim(), String(input.collectMethod || '')),
    sshPort: Math.max(1, Math.min(65535, Math.floor(Number(input.sshPort)) || 22)),
    httpsPort: Math.max(1, Math.min(65535, Math.floor(Number(input.httpsPort)) || 443)),
    vfId: input.vfId === '' || input.vfId == null ? null : Math.max(1, Math.min(128, Math.floor(Number(input.vfId)) || 128)),
  };
}

export function saveDevice(input = {}) {
  const db = load();
  const issue = deviceInputIssue(input);
  if (issue) throw new Error(issue);
  const type = String(input.type || '').trim();
  const name = String(input.name || '').trim();
  const host = String(input.host || '').trim();
  const username = String(input.username || '').trim();
  const agent = String(input.agent || '').trim();
  const datacenterId = String(input.datacenterId || '').trim();

  const existing = input.id ? db.devices.find((d) => d.id === input.id) : null;
  const dev = existing || { id: `sw-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, createdAt: Date.now(), pulled: false };
  // v2.607(감사 SEC2607-07·LEFT2607-06): host 만 보던 것을 공용 판정(host·username·SSH 포트·REST 포트)으로 — 계정·포트를
  //   바꿔도 옛 비밀번호가 새 접속처로 시도됐다. agent(수집 엣지) 변경은 승계한다(위임 수집에 필요, 장비는 같다).
  //   포트는 그 포트를 **이전·새 수집 방식이 둘 다 쓸 때만** 비교한다(CSV 내보내기는 REST 가 아니면 httpsPort 를 비운다 —
  //   bulk.js — 쓰지 않는 포트의 기본값 복원으로 비밀을 버리면 거짓 폐기다).
  const newMethod = normalizeCollectMethod(type, String(input.collectMethod || ''));
  const oldRest = existing?.collectMethod === 'rest'; const newRest = newMethod === 'rest';
  const bothSsh = !!existing && !oldRest && !newRest; const bothRest = !!existing && oldRest && newRest;
  const moved = !!existing && accessMoved(
    { host: existing.host, username: existing.username || '',
      port: bothSsh ? (existing.sshPort || 22) : '', httpsPort: bothRest ? (existing.httpsPort || 443) : '' },
    { host, username,
      port: bothSsh ? Math.max(1, Math.min(65535, Math.floor(Number(input.sshPort)) || 22)) : '',
      httpsPort: bothRest ? Math.max(1, Math.min(65535, Math.floor(Number(input.httpsPort)) || 443)) : '' },
    ['host', 'username', 'port', 'httpsPort']);
  const password = String(input.password ?? '');
  let droppedSecrets = [];
  if (password) dev.password = password;
  else if (moved) droppedSecrets = dropCarriedSecrets(dev, input, ['password']); // 접속처 변경 시 비번 이월 금지
  const collectMethod = normalizeCollectMethod(type, String(input.collectMethod || ''));
  const sshPort = Math.max(1, Math.min(65535, Math.floor(Number(input.sshPort)) || 22));
  // REST 포트 — 기본 443. NAT/포트포워딩 뒤의 스위치를 위해 지정할 수 있게 둔다.
  const httpsPort = Math.max(1, Math.min(65535, Math.floor(Number(input.httpsPort)) || 443));
  // Virtual Fabrics 논리 스위치 ID — 미설정(빈 값)이면 기본 컨텍스트만 수집한다.
  const vfId = input.vfId === '' || input.vfId == null ? null : Math.max(1, Math.min(128, Math.floor(Number(input.vfId)) || 128));
  Object.assign(dev, { type, name, host, username, agent, datacenterId, collectMethod, sshPort, httpsPort, vfId,
    enabled: input.enabled !== false, note: String(input.note || '').slice(0, 200) });
  if (!existing) {
    if (db.devices.length >= MAX_DEVICES) throw new Error(`스위치는 최대 ${MAX_DEVICES}개까지 등록할 수 있습니다.`);
    if (db.devices.some((d) => d.host === host)) throw new Error('같은 host 의 스위치가 이미 등록되어 있습니다.');
    db.devices.push(dev);
  }
  persist();
  const { password: _p, ...safe } = dev;
  return { ...safe, hasPassword: !!dev.password, ...(droppedSecrets.length ? { droppedSecrets } : {}) };
}

export function deleteDevice(id) {
  const db = load();
  const i = db.devices.findIndex((d) => d.id === id);
  if (i < 0) return false;
  db.devices.splice(i, 1); persist();
  return true;
}

/** 이 노드가 수집할 장비(순수 판정). 중앙 여부는 이름이 아니라 centralUrl 로 가른다. */
export function devicesForThisNode({ devices = load().devices, agentName = config.agent.name, isEdge = !!config.agent.centralUrl } = {}) {
  const me = String(agentName || '').toLowerCase();
  return devices.filter((d) => d.enabled !== false && (isEdge
    ? String(d.agent || '').toLowerCase() === me
    : !(d.agent || '').trim()));
}

/** 특정 엣지 몫(중앙의 config 서빙용 — 비밀번호 포함: 엣지가 스위치에 로그인해야 한다). */
export function devicesForAgent(agentName) {
  const me = String(agentName || '').toLowerCase();
  return load().devices.filter((d) => d.enabled !== false && String(d.agent || '').toLowerCase() === me);
}

/** 엣지: 중앙 pull 결과 반영 — 내 몫을 통째로 교체(중앙이 진실의 원천). */
export function applyPulledDevices(list, { onRemoved = null } = {}) {
  const db = load();
  const mine = String(config.agent.name || '').toLowerCase();
  const keep = db.devices.filter((d) => String(d.agent || '').toLowerCase() !== mine);
  const before = new Set(db.devices.filter((d) => String(d.agent || '').toLowerCase() === mine).map((d) => d.id));
  const next = (list || []).map((d) => ({ ...d, pulled: true }));
  db.devices = [...keep, ...next];
  persist();
  // 중앙에서 삭제/이관된 장비의 id — 호출자가 로컬 스냅샷을 지워야 한다(안 지우면 낡은 스냅샷이
  // 매 주기 중앙으로 push 돼 중앙 화면에 orphan 으로 영구 표시된다 — v2.416 리뷰 결함 #4).
  const nextIds = new Set(next.map((d) => d.id));
  const removed = [...before].filter((id) => !nextIds.has(id));
  if (removed.length && typeof onRemoved === 'function') { try { onRemoved(removed); } catch { /* best effort */ } }
  return db.devices.length;
}

export function _resetForTest() { _db = null; }
