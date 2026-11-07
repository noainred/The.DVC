/**
 * bmusage/portMap.js — 서버 NIC ↔ 스위치·포트 **수동 매핑 파일**(v2.922 · 3a · 설계 PROFILES §10 ①). 파일: `<configDir>/bmusage-portmap.json`.
 *
 *  · 사람이 손으로 정한 값이라 파일 스토어 규약 넷을 지킨다(perf-db.md v2.582): 원자 쓰기(atomicWriteFileSync) · 손상 보존(preserveCorrupt —
 *    조용히 빈 목록으로 덮지 않는다) · 동기 쓰기(디바운스 없음 → 종료 flush 불필요) · 날짜 코어 불필요(시각은 epoch ms).
 *  · 쓰기는 라우트가 정한다(설정 소유자 = admin · 범위 계정은 자기 법인 서버만 — 조회 밖 404 → 쓰기 밖 403) · 감사 로그는 라우트(logAudit).
 *  · 매핑 근거가 바뀌면(케이블 이동 등) 승계하지 않는다 — 사람이 지우고 다시 확정한다(자동 갱신 없음).
 *  · 키: (agent, key, nic). agent 는 그 서버를 수집하는 노드 이름('' = 중앙 직접). 항목 상한 20,000(1,000대 × NIC 4 × 5배 여유).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';

const FILE = () => path.join(config.configDir, 'bmusage-portmap.json');
export const PORTMAP_MAX = 20_000;
const ID_RE = /^[A-Za-z0-9._:/@+ -]{1,256}$/;

let _cache = null;
let _loadError = null;
export function portMapLoadError() { return _loadError; }

function load() {
  if (_cache) return _cache;
  if (!fs.existsSync(FILE())) { _cache = { v: 1, entries: [] }; _loadError = null; return _cache; }
  try {
    const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.entries)) throw new Error('entries 배열이 없습니다');
    _cache = { v: 1, entries: raw.entries.filter((e) => e && typeof e === 'object').slice(0, PORTMAP_MAX) };
    _loadError = null;
  } catch (e) {
    // ⚠ 손상이면 원본을 보존하고 빈 목록으로 — 다음 저장이 온전했던 매핑을 덮지 않게 저장은 막는다(_loadError).
    preserveCorrupt(FILE(), String(e?.message || e));
    _loadError = { at: Date.now(), reason: `매핑 파일을 읽지 못했습니다(원본은 보존): ${String(e?.message || e).slice(0, 160)}` };
    _cache = { v: 1, entries: [] };
  }
  return _cache;
}

/** 입력 검증(순수). */
export function validateMapping(m = {}) {
  const f = { agent: String(m.agent ?? ''), key: String(m.key ?? '').trim(), nic: String(m.nic ?? '').trim(), cvpId: String(m.cvpId ?? '').trim(), deviceKey: String(m.deviceKey ?? '').trim(), port: String(m.port ?? '').trim() };
  if (f.agent && !ID_RE.test(f.agent)) return { error: 'agent 형식' };
  for (const k of ['key', 'nic', 'cvpId', 'deviceKey', 'port']) if (!ID_RE.test(f[k])) return { error: `${k} 가 필요합니다(1~256자 · 영숫자와 ._:/@+- 공백).` };
  return { value: f };
}

export function listPortMap({ agent = null, key = null } = {}) {
  return load().entries.filter((e) => (agent == null || e.agent === agent) && (key == null || e.key === key)).map((e) => ({ ...e }));
}

/** 확정(덮어쓰기). 반환 { ok, entry, replaced }. 손상 파일을 읽은 상태면 저장을 거부한다(보존한 원본을 빈 목록으로 덮지 않게). */
export function setPortMapping(m, { by = '' } = {}) {
  if (_loadError || (load() && _loadError)) return { ok: false, reason: _loadError.reason };
  const v = validateMapping(m);
  if (v.error) return { ok: false, reason: v.error };
  const cur = load();
  const f = v.value;
  const idx = cur.entries.findIndex((e) => e.agent === f.agent && e.key === f.key && e.nic === f.nic);
  const entry = { ...f, source: 'manual', by: String(by || '').slice(0, 64), at: Date.now() };
  const replaced = idx >= 0 ? cur.entries[idx] : null;
  const next = idx >= 0 ? cur.entries.map((e, i) => (i === idx ? entry : e)) : [...cur.entries, entry];
  if (next.length > PORTMAP_MAX) return { ok: false, reason: `매핑 상한(${PORTMAP_MAX})을 넘습니다.` };
  write({ v: 1, entries: next });
  return { ok: true, entry, replaced };
}
export function removePortMapping({ agent = '', key, nic } = {}) {
  if (_loadError || (load() && _loadError)) return { ok: false, reason: _loadError.reason };
  const cur = load();
  const next = cur.entries.filter((e) => !(e.agent === String(agent) && e.key === String(key) && e.nic === String(nic)));
  if (next.length === cur.entries.length) return { ok: false, reason: '그 매핑이 없습니다.', notFound: true };
  write({ v: 1, entries: next });
  return { ok: true, removed: cur.entries.length - next.length };
}
function write(obj) {
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  atomicWriteFileSync(FILE(), JSON.stringify(obj, null, 2), { mode: 0o600 });
  _cache = obj;
}
export function _resetPortMapForTest() { _cache = null; _loadError = null; }
