/**
 * curuser/settings.js — '현재 사용자' 수집 설정(v2.520).
 *
 * 사용자 요청: "vcenter 별로 **사용자가 설정에서 지정한 폴더**의 windows 서버에서 로그인한
 * 사용자의 수를 **설정에서 지정한 시간**마다 수집" + "10분마다 DB 에 저장".
 *
 * 파일: `CONFIG_DIR/curuser-settings.json`. 자격증명은 **여기 두지 않는다** — 게스트 계정은
 * 이미 `gpu/settings.js`(vCenter별 Windows 공용 계정 + VM별 재정의)가 갖고 있고, 비밀을 두 곳에
 * 두면 한쪽만 회전돼 조용히 실패한다.
 *
 * ── 주기 하한을 두는 이유 ────────────────────────────────────────────────────────
 * 게스트 실행 1회는 VMware Tools 왕복 5~6회 + 결과 파일 회수다(`gpu/guestops.js` 머리말).
 * 폴더에 Windows 서버가 200대면 한 주기에 그만큼이 돈다. 기본 **10분**(사용자 지정),
 * 하한 **5분** — 그 아래로는 이전 주기가 끝나기 전에 다음 주기가 와 재진입 가드가 계속 건너뛴다.
 *
 * ⚠ 기본은 **꺼짐(opt-in)** 이다 — 운영 Windows 서버에 주기적으로 프로세스를 띄우는 동작이라
 *   관리자가 폴더를 고르고 명시적으로 켜야 시작한다.
 * ⚠ 폴더 범위가 **비어 있으면 수집하지 않는다**(전체 VM 으로 확대 해석 금지). 5,850 VM 에
 *   게스트 실행을 돌리는 사고를 기본값으로 만들지 않는다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';

const FILE = () => path.join(config.configDir, 'curuser-settings.json');

export const LIMITS = Object.freeze({
  intervalMs: { min: 5 * 60_000, max: 12 * 3600_000, def: 10 * 60_000 },   // 기본 10분(사용자 지정)
  retentionDays: { min: 1, max: 3650, def: 180 },
  concurrency: { min: 1, max: 16, def: 4 },
  vmTimeoutMs: { min: 10_000, max: 300_000, def: 60_000 },
  maxVms: { min: 1, max: 5000, def: 400 },      // 한 주기 대상 상한(조용한 상한 금지 — 초과는 밝힌다)
});

const clamp = (v, l) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return l.def;
  return Math.min(l.max, Math.max(l.min, Math.round(n)));
};
const strArr = (v, max = 200) => (Array.isArray(v) ? v : [])
  .map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, max);

let _cache = null;

/**
 * 정규화(순수 — 테스트가 고정).
 *
 * `vcenters[vcId] = { enabled, folders: string[], includeSubfolders, excludeFolders: string[] }`
 * 폴더는 vSphere 'VM 및 템플릿' 경로 문자열이다(스냅샷 `vms[].folder` 와 같은 축).
 */
export function normalize(input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const vcIn = src.vcenters && typeof src.vcenters === 'object' ? src.vcenters : {};
  const vcenters = {};
  for (const [id, v] of Object.entries(vcIn).slice(0, 200)) {
    const o = v && typeof v === 'object' ? v : {};
    vcenters[String(id)] = {
      enabled: o.enabled === true,
      folders: strArr(o.folders),
      excludeFolders: strArr(o.excludeFolders, 100),
      // 기본 true — 사용자가 상위 폴더를 고르면 그 아래를 다 보는 것이 자연스럽다.
      includeSubfolders: o.includeSubfolders !== false,
    };
  }
  return {
    enabled: src.enabled === true,
    intervalMs: clamp(src.intervalMs, LIMITS.intervalMs),
    retentionDays: clamp(src.retentionDays, LIMITS.retentionDays),
    concurrency: clamp(src.concurrency, LIMITS.concurrency),
    vmTimeoutMs: clamp(src.vmTimeoutMs, LIMITS.vmTimeoutMs),
    maxVms: clamp(src.maxVms, LIMITS.maxVms),
    // 계정명을 목록·보고서에 상시 노출할지(기본 꺼짐 — 개인정보성. 상세 펼침에서는 항상 보인다).
    showNamesInList: src.showNamesInList === true,
    vcenters,
  };
}

export function load() {
  if (_cache) return { ..._cache, vcenters: { ..._cache.vcenters } };
  let raw = {};
  try { if (fs.existsSync(FILE())) raw = JSON.parse(fs.readFileSync(FILE(), 'utf8')); }
  catch { preserveCorrupt(FILE()); raw = {}; }
  _cache = normalize(raw);
  return { ..._cache, vcenters: { ..._cache.vcenters } };
}

export function save(input = {}) {
  _cache = normalize(input);
  atomicWriteFileSync(FILE(), JSON.stringify({ version: 1, ..._cache }, null, 2), { mode: 0o600 });
  return load();
}

/** 이 설정으로 수집할 vCenter 인지. 폴더가 **비어 있으면 대상이 아니다**(전체 확대 금지). */
export function isMonitored(s, vcId) {
  if (!s || s.enabled !== true) return false;
  const v = (s.vcenters || {})[String(vcId)];
  return !!(v && v.enabled && v.folders.length);
}

/**
 * 엣지: 중앙이 내려준 설정 적용(`storage/intervals.js`·`sanswitch/perfSettings.js` 와 같은 규약).
 * `CURUSER_LOCAL=1` 이면 현장 설정을 지킨다. 값이 같으면 파일을 다시 쓰지 않는다.
 */
export function applyCentral(remote) {
  if (!remote || typeof remote !== 'object') return false;
  if (String(process.env.CURUSER_LOCAL || '') === '1') return false;
  const next = normalize({ ...load(), ...remote });
  if (JSON.stringify(next) === JSON.stringify(load())) return false;
  save(next);
  return true;
}

export function _resetForTest() { _cache = null; }
export const _FILE = FILE;
