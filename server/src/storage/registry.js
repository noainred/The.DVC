/**
 * storage/registry.js — 스토리지 장비 등록부(v2.302).
 *
 * 장비는 **중앙 포탈에서 등록**하고 수집 주체(agent)를 지정한다:
 *   agent '' = 중앙이 직접 수집(중앙에서 닿는 장비) · agent '<엣지명>' = 그 엣지가 수집.
 * 엣지는 자기 몫 장비를 config pull(agent/storageConfigPull.js)로 받아 이 레지스트리에
 * managed(pulled:true)로 반영한다 — 같은 모듈이 중앙/엣지 양쪽에서 동작(iDRAC 위임과 동일 축).
 *
 * 보안(server/CLAUDE.md):
 *  - password 는 secretVault 봉인 대상(SECRET_FILES 에 storage-devices.json 등록) —
 *    암호화 모드면 저장 시 봉인·로드 시 복호(idrac/registry.js 와 동일 경계).
 *  - 원자적 쓰기 + 로드 손상 보존(preserveCorrupt) — 자격증명 파일 규칙.
 *  - host 는 형식 화이트리스트 + ssrfBlockReason(링크로컬/루프백/우회표기 차단, RFC1918 허용).
 *  - host 변경 시 저장 비밀번호를 이월하지 않는다(uagmon M3 와 동일 — host 바꿔치기로
 *    자격증명이 공격자 서버로 선제 전송되는 경로 차단).
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { openSecretsDeep, sealSecretsDeep } from '../security/secretVault.js';
import { ssrfBlockReason } from '../collector/registry.js';
import { isKnownType, isImplementedType } from './types.js';

const FILE = path.join(config.configDir, 'storage-devices.json');
const MAX_DEVICES = 500;
const RE_HOST = /^[A-Za-z0-9][A-Za-z0-9._-]{0,253}$/; // IP/호스트명(선행 '-' 불가)
const RE_NAME = /^[^<>"']{1,64}$/;                      // 표시명 — 태그 인젝션 문자만 금지

let _db = null;

function load() {
  if (_db) return _db;
  try {
    if (fs.existsSync(FILE)) {
      // 암호화 모드로 봉인 저장된 password 를 로드 경계에서 복호(소비자는 평문만 본다).
      const p = openSecretsDeep(JSON.parse(fs.readFileSync(FILE, 'utf8')));
      _db = { devices: Array.isArray(p.devices) ? p.devices : [] };
      return _db;
    }
  } catch { preserveCorrupt(FILE); } // 손상 원본 보존 — 빈 목록 저장이 전 장비 자격증명을 지우는 사고 방지
  _db = { devices: [] };
  return _db;
}

function persist() {
  atomicWriteFileSync(FILE, JSON.stringify(sealSecretsDeep({ version: 1, devices: load().devices }), null, 2), { mode: 0o600 });
}

/** 목록 — 비밀번호는 절대 반환하지 않는다(hasPassword 불리언만). UI/집계 공용. */
export function listDevices() {
  return load().devices.map(({ password, ...d }) => ({ ...d, hasPassword: !!password }));
}
export function getDeviceWithSecret(id) { return load().devices.find((d) => d.id === id) || null; } // 수집기 전용

export function saveDevice(input = {}) {
  const db = load();
  const type = String(input.type || '').trim();
  if (!isKnownType(type)) throw new Error(`알 수 없는 스토리지 타입: ${type}`);
  if (!isImplementedType(type)) throw new Error(`'${type}' 수집기는 아직 미구현입니다(카탈로그의 '예정' 타입 — 등록은 구현 후에).`);
  const name = String(input.name || '').trim();
  const host = String(input.host || '').trim();
  if (!RE_NAME.test(name)) throw new Error('표시명 형식 오류(1~64자, <>"\' 금지)');
  if (!RE_HOST.test(host)) throw new Error('host 형식 오류 — IP/호스트명만(공백·특수문자·선행 - 불가)');
  const ssrf = ssrfBlockReason(`https://${host}`);
  if (ssrf) throw new Error(`host 차단: ${ssrf}`);
  const username = String(input.username || '').trim();
  if (!username) throw new Error('접속 계정을 입력하세요.');
  const agent = String(input.agent || '').trim();
  const datacenterId = String(input.datacenterId || '').trim();

  const existing = input.id ? db.devices.find((d) => d.id === input.id) : null;
  const dev = existing || { id: `st-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, createdAt: Date.now(), pulled: false };
  // host 변경 시 비번 이월 금지(uagmon M3) — 새 비번을 명시해야 저장된다.
  const hostChanged = existing && existing.host !== host;
  const password = String(input.password ?? '');
  if (password) dev.password = password;
  else if (hostChanged) delete dev.password;
  Object.assign(dev, { type, name, host, username, agent, datacenterId, enabled: input.enabled !== false, note: String(input.note || '').slice(0, 200) });
  if (!existing) {
    if (db.devices.length >= MAX_DEVICES) throw new Error(`장비는 최대 ${MAX_DEVICES}개까지 등록할 수 있습니다.`);
    if (db.devices.some((d) => d.host === host && d.type === type)) throw new Error('같은 host 의 같은 타입 장비가 이미 있습니다.');
    db.devices.push(dev);
  }
  persist();
  const { password: _p, ...safe } = dev;
  return { ...safe, hasPassword: !!dev.password };
}

export function deleteDevice(id) {
  const db = load();
  const i = db.devices.findIndex((d) => d.id === id);
  if (i < 0) return false;
  db.devices.splice(i, 1); persist();
  return true;
}

/**
 * 이 노드가 수집할 장비(순수 판정 — storageMon.test.js 고정).
 * 중앙(centralUrl 미설정)= agent '' 장비 · 엣지 = agent 가 내 이름(대소문자 무시)인 장비.
 * ⚠ 엣지의 AGENT_NAME 기본값이 hostname 이라, 중앙 여부는 이름이 아니라 centralUrl 로 가른다
 *   (중앙은 CENTRAL_URL 을 설정하지 않는다 — svcmonPush 등 기존 위임 축과 동일 판별).
 */
export function devicesForThisNode({ devices = load().devices, agentName = config.agent.name, isEdge = !!config.agent.centralUrl } = {}) {
  const me = String(agentName || '').toLowerCase();
  return devices.filter((d) => d.enabled !== false && (isEdge
    ? String(d.agent || '').toLowerCase() === me
    : !(d.agent || '').trim()));
}

/** 특정 엣지 몫 장비(중앙의 config 서빙용 — 비밀번호 포함: 엣지가 장비에 로그인해야 한다). */
export function devicesForAgent(agentName) {
  const me = String(agentName || '').toLowerCase();
  return load().devices.filter((d) => d.enabled !== false && String(d.agent || '').toLowerCase() === me);
}

/**
 * 엣지: 중앙 pull 결과 반영 — 내 몫 장비를 통째로 교체(merge 아님: 중앙이 진실의 원천이라
 * 중앙에서 지운 장비가 엣지에 유령으로 남으면 안 됨). pulled:true 로 표시해 엣지 로컬 등록과
 * 구분(엣지 UI 는 등록을 안 쓰지만 파일을 열어본 운영자가 출처를 알 수 있게).
 */
export function applyPulledDevices(list) {
  const db = load();
  const mine = String(config.agent.name || '').toLowerCase();
  const keep = db.devices.filter((d) => String(d.agent || '').toLowerCase() !== mine); // 남의 것/로컬은 보존
  db.devices = [...keep, ...(list || []).map((d) => ({ ...d, pulled: true }))];
  persist();
  return db.devices.length;
}

export function _resetForTest() { _db = null; }
