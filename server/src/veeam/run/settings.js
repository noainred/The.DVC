/**
 * veeam/run/settings.js — 백업 실행 설정(v2.818, `veeam-backup-run.json` — 비밀 없음).
 *
 *  · jobPrefix   포탈 전용 잡 이름 접두(기본 'PORTAL-')
 *  · servers     Veeam 서버(등록부 id)별 포탈 전용 잡 저장소·보존(복원 지점 수)
 *  · hosts       포탈 vCenter id → Veeam 이 그 vCenter 를 부르는 이름(직접 지정 — 비우면 자동: 대조가 배운 이름 또는 등록 주소)
 * Veeam 서버 자체(주소·계정·담당 엣지·연결 vCenter)는 모니터링 등록부(veeam/registry.js) 하나다 — 여기서 다시 등록하지 않는다.
 * 원자적 쓰기 + 로드 손상 preserveCorrupt(설정 파일 규칙). 못 읽었으면 registryUnreadable 처럼 loadError 로 말한다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../../util/atomicWrite.js';
import { makeLoadError } from '../../util/registryCore.js';
import { numOrNull } from '../../util/numOrNull.js';

const FILE = () => path.join(config.configDir, 'veeam-backup-run.json');
export const DEFAULT_JOB_PREFIX = 'PORTAL-';
export const DEFAULT_RETENTION = 7;
const RE_PREFIX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,23}$/;
const RE_REPO = /^[A-Za-z0-9-]{1,64}$/;
const RE_VC_HOST = /^[A-Za-z0-9][A-Za-z0-9._-]{0,253}$/;
const RE_ID = /^[^\x00-\x1f]{1,128}$/; // eslint-disable-line no-control-regex
const SAFE_KEY = (k) => k !== '__proto__' && k !== 'constructor' && k !== 'prototype';

let _db = null;
const loadErr = makeLoadError();
export function settingsLoadError() { load(); return loadErr.get(); }

/** 정규화(순수) — 모르는 키·형식 오류는 버린다. */
export function normalizeRunSettings(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const servers = {};
  if (r.servers && typeof r.servers === 'object' && !Array.isArray(r.servers)) {
    for (const k of Object.keys(r.servers).slice(0, 200)) {
      if (!SAFE_KEY(k) || !RE_ID.test(k)) continue;
      const v = r.servers[k] && typeof r.servers[k] === 'object' ? r.servers[k] : {};
      const repo = typeof v.repositoryId === 'string' && RE_REPO.test(v.repositoryId.trim()) ? v.repositoryId.trim() : '';
      const n = numOrNull(v.retention);
      const retention = n != null && Number.isInteger(n) && n >= 1 && n <= 999 ? n : DEFAULT_RETENTION;
      servers[k] = { repositoryId: repo, retention };
    }
  }
  const hosts = {};
  if (r.hosts && typeof r.hosts === 'object' && !Array.isArray(r.hosts)) {
    for (const k of Object.keys(r.hosts).slice(0, 200)) {
      if (!SAFE_KEY(k) || !RE_ID.test(k)) continue;
      const v = typeof r.hosts[k] === 'string' ? r.hosts[k].trim() : '';
      if (v && RE_VC_HOST.test(v)) hosts[k] = v;
    }
  }
  return { jobPrefix: typeof r.jobPrefix === 'string' && RE_PREFIX.test(r.jobPrefix.trim()) ? r.jobPrefix.trim() : DEFAULT_JOB_PREFIX, servers, hosts };
}

function load() {
  if (_db) return _db;
  try {
    if (fs.existsSync(FILE())) { _db = normalizeRunSettings(JSON.parse(fs.readFileSync(FILE(), 'utf8'))); return _db; }
  } catch (e) { preserveCorrupt(FILE(), e?.message); loadErr.set(e); }
  loadErr.checkCorruptOnly(FILE());
  _db = normalizeRunSettings({});
  return _db;
}

export function getRunSettings() { const d = load(); return { jobPrefix: d.jobPrefix, servers: { ...d.servers }, hosts: { ...d.hosts } }; }
/** 서버별 포탈 잡 설정(없으면 기본). */
export function serverRunSettings(serverId) { return load().servers[serverId] || { repositoryId: '', retention: DEFAULT_RETENTION }; }

/**
 * 저장 — 입력 형식 오류는 버리지 않고 **거부**한다(사람이 넣은 값이 조용히 사라지면 '저장했는데 왜 안 되지' 가 된다).
 * @returns {{ok:true, settings:object}|{ok:false, reason:string}}
 */
export function saveRunSettings(input = {}) {
  const i = input && typeof input === 'object' ? input : {};
  if (i.jobPrefix !== undefined && !(typeof i.jobPrefix === 'string' && RE_PREFIX.test(i.jobPrefix.trim()))) return { ok: false, reason: "잡 이름 접두는 영숫자로 시작하는 24자 이내(영숫자·._-) — 예: 'PORTAL-'" };
  for (const [k, v] of Object.entries(i.servers && typeof i.servers === 'object' ? i.servers : {})) {
    const repo = typeof v?.repositoryId === 'string' ? v.repositoryId.trim() : '';
    if (repo && !RE_REPO.test(repo)) return { ok: false, reason: `저장소 id 형식 오류(${String(k).slice(0, 40)})` };
    if (v?.retention !== undefined && v?.retention !== '') { const n = numOrNull(v.retention); if (n == null || !Number.isInteger(n) || n < 1 || n > 999) return { ok: false, reason: '보존(복원 지점 수)은 1~999 정수' }; }
  }
  for (const [k, v] of Object.entries(i.hosts && typeof i.hosts === 'object' ? i.hosts : {})) {
    const h = typeof v === 'string' ? v.trim() : '';
    if (h && !RE_VC_HOST.test(h)) return { ok: false, reason: `vCenter 이름 형식 오류(${String(k).slice(0, 40)}) — 호스트 이름·IP 만` };
  }
  const cur = load();
  _db = normalizeRunSettings({
    jobPrefix: i.jobPrefix !== undefined ? i.jobPrefix : cur.jobPrefix,
    // 서버별 값은 합친다 — 입력에 없는 서버 id 는 유지(빈 서버 목록 화면이 저장소·보존을 지우지 않게 — v2.820.1 B3). 값을 지우려면 그 id 에 빈 저장소를 보낸다.
    servers: i.servers && typeof i.servers === 'object' && !Array.isArray(i.servers) ? { ...cur.servers, ...i.servers } : cur.servers,
    hosts: i.hosts !== undefined ? i.hosts : cur.hosts,
  });
  atomicWriteFileSync(FILE(), JSON.stringify({ version: 1, ..._db }, null, 2), { mode: 0o600 });
  loadErr.clear();
  return { ok: true, settings: getRunSettings() };
}

export function _resetForTest() { _db = null; loadErr.clear(); }
