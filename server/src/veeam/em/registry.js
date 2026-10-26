/**
 * veeam/em/registry.js — Veeam Backup Enterprise Manager(EM) 등록부(v2.788, 사용자 요청 '설정 › Veeam 백업 서버 › Enterprise Manager').
 *
 * EM 은 여러 B&R 서버를 한곳에서 보는 제품이라 **중앙 포탈이 직접** 읽는다(엣지 배정 없음 — 사용자 결정). 그 밖의 규칙은 veeam/registry.js 와 같다:
 *  - password 는 secretVault 봉인(SECRET_FILES 에 veeam-em.json 등록) · 원자적 쓰기(0600) · 로드 손상 preserveCorrupt(빈 값 위에 덮지 않는다).
 *  - host 는 형식 화이트리스트 + ssrfBlockReason(링크로컬·루프백·우회 표기 차단, RFC1918 허용).
 *  - 접속처(host·port·username)가 바뀌면 저장 비밀번호를 승계하지 않는다(util/secretCarry.js).
 *  - 비밀번호·계정 제어문자 거부(헤더·오류 문구로 값이 새지 않게).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../../util/atomicWrite.js';
import { makeLoadError, filterObjectElements } from '../../util/registryCore.js';
import { openSecretsDeep, sealSecretsDeep } from '../../security/secretVault.js';
import { ssrfBlockReason } from '../../collector/registry.js';
import { accessMoved, dropCarriedSecrets } from '../../util/secretCarry.js';

const FILE = () => path.join(config.configDir, 'veeam-em.json');
export const MAX_EMS = 20;
export const DEFAULT_EM_PORT = 9398;
const RE_HOST = /^[A-Za-z0-9][A-Za-z0-9._-]{0,253}$/;
const RE_NAME = /^[^<>"']{1,64}$/;

let _db = null;
const loadErr = makeLoadError();
export function emRegistryLoadError() { load(); return loadErr.get(); }

function load() {
  if (_db) return _db;
  try {
    if (fs.existsSync(FILE())) {
      const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('형식 오류');
      const p = openSecretsDeep(raw);
      _db = { ems: filterObjectElements(p.ems).list };
      return _db;
    }
  } catch (e) { preserveCorrupt(FILE(), e?.message); loadErr.set(e); }
  loadErr.checkCorruptOnly(FILE());
  _db = { ems: [] };
  return _db;
}

function persist() {
  atomicWriteFileSync(FILE(), JSON.stringify(sealSecretsDeep({ version: 1, ems: load().ems }), null, 2), { mode: 0o600 });
  loadErr.clear();
}

const redact = ({ password, ...d }) => ({ ...d, hasPassword: !!password });
/** 접속처 지문(소문자 host:port:username 의 sha256 앞 16자) — 결과가 지금 접속처에서 읽은 것인지 대조한다(veeam/registry.js 와 같은 세 칸). */
export function emFingerprint(d) {
  if (!d || typeof d !== 'object') return '';
  const key = `${String(d.host ?? '').trim().toLowerCase()}:${Number(d.port) || DEFAULT_EM_PORT}:${String(d.username ?? '').trim().toLowerCase()}`;
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}
/** 목록 — 비밀번호는 반환하지 않는다(hasPassword 만). */
export function listEms() { return load().ems.map(redact); }
/** 수집기 전용(비밀 포함). */
export function getEmWithSecret(id) { return load().ems.find((d) => d.id === id) || null; }

/** 입력 검증(순수). 오류면 사유, 정상이면 null. */
export function emInputIssue(input = {}) {
  if (!RE_NAME.test(String(input.name || '').trim())) return '표시명 형식 오류(1~64자, <>"\' 금지)';
  const host = String(input.host || '').trim();
  if (!RE_HOST.test(host)) return 'host 형식 오류 — IP/호스트명만(스킴·포트·공백·선행 - 불가)';
  const ssrf = ssrfBlockReason(`https://${host}`);
  if (ssrf) return `host 차단: ${ssrf}`;
  const port = input.port == null || input.port === '' ? DEFAULT_EM_PORT : Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return '포트는 1~65535 정수여야 합니다.';
  if (!String(input.username || '').trim()) return '접속 계정을 입력하세요.';
  if (/[\x00-\x1f\x7f]/.test(String(input.password ?? ''))) return '비밀번호에 제어문자(개행·탭 등)가 포함되어 있습니다 — 붙여넣기 내용을 확인하세요.'; // eslint-disable-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(String(input.username ?? ''))) return '계정에 제어문자가 포함되어 있습니다.'; // eslint-disable-line no-control-regex
  return null;
}

/** 저장(추가·수정). 접속처가 바뀌면 moved:true · 옛 비밀번호 폐기 시 droppedSecrets. */
export function saveEm(input = {}) {
  const db = load();
  const issue = emInputIssue(input);
  if (issue) throw new Error(issue);
  const host = String(input.host || '').trim();
  const port = input.port == null || input.port === '' ? DEFAULT_EM_PORT : Number(input.port);
  const username = String(input.username || '').trim();
  const existing = input.id ? db.ems.find((d) => d.id === input.id) : null;
  if (input.id && !existing) throw new Error('Enterprise Manager 를 찾을 수 없습니다.');
  const dev = existing || { id: `vem-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, createdAt: Date.now() };
  const moved = !!existing && accessMoved({ host: existing.host, port: String(existing.port || DEFAULT_EM_PORT), username: existing.username || '' },
    { host, port: String(port), username }, ['host', 'port', 'username']);
  const password = String(input.password ?? '');
  let droppedSecrets = [];
  if (password && password !== '********') dev.password = password;
  else if (moved) droppedSecrets = dropCarriedSecrets(dev, input, ['password']);
  if (!existing && !dev.password) throw new Error('비밀번호를 입력하세요.');
  const keyChanged = !existing || String(existing.host || '').trim().toLowerCase() !== host.toLowerCase() || Number(existing.port || DEFAULT_EM_PORT) !== port;
  if (keyChanged && db.ems.some((d) => d.id !== dev.id && String(d.host).toLowerCase() === host.toLowerCase() && Number(d.port || DEFAULT_EM_PORT) === port)) {
    throw new Error(`이미 등록된 Enterprise Manager 입니다(${host}:${port}).`);
  }
  Object.assign(dev, {
    name: String(input.name || '').trim(), host, port, username,
    enabled: input.enabled !== false, note: String(input.note || '').slice(0, 200),
  });
  if (!existing) {
    if (db.ems.length >= MAX_EMS) throw new Error(`Enterprise Manager 는 최대 ${MAX_EMS}대까지 등록할 수 있습니다.`);
    db.ems.push(dev);
  }
  persist();
  return { ...redact(dev), ...(droppedSecrets.length ? { droppedSecrets } : {}), ...(moved ? { moved: true } : {}) };
}

export function deleteEm(id) {
  const db = load();
  const i = db.ems.findIndex((d) => d.id === id);
  if (i < 0) return false;
  db.ems.splice(i, 1); persist();
  return true;
}

/** 이 노드가 읽을 EM — 중앙에서만, 켜진 것만. */
export function emsForThisNode({ isEdge = !!String(config.agent?.centralUrl || '').trim() } = {}) {
  if (isEdge) return [];
  return load().ems.filter((d) => d.enabled !== false);
}

export function _resetEmRegistryForTest() { _db = null; loadErr.clear(); }
