/**
 * curuser/settings.js — '현재 사용자' 수집 설정(v2.520).
 *
 * 사용자 요청: "vcenter 별로 **사용자가 설정에서 지정한 폴더**의 windows 서버에서 로그인한
 * 사용자의 수를 **설정에서 지정한 시간**마다 수집" + "10분마다 DB 에 저장".
 *
 * 파일: `CONFIG_DIR/curuser-settings.json`. **자격증명이 없다** — 2026-09-15 사용자 결정
 * "Guestos 계정 없이" 에 따라 수집은 게스트가 스스로 발행한 `guestinfo.curuser.*` 를
 * vCenter `config.extraConfig` 로 **읽는 것뿐**이다(`curuser/guestinfoSource.js`).
 *
 * ── 주기 두 개를 따로 두는 이유(중요) ───────────────────────────────────────────
 * ① `intervalMs`      — **포탈이 vCenter 에서 읽는** 주기. 사용자 지정 기본 10분.
 * ② `guestPublishMs`  — **게스트 스케줄 작업이 발행하는** 주기. 포탈이 강제할 수 없다
 *    (각 Windows 서버의 `schtasks` 가 정한다). 이 값은 '관리자가 그렇게 등록했다' 는 **신고**이고,
 *    신선도 판정(`staleFactor` 배)과 내려주는 스크립트의 기본 주기에 쓰인다.
 *    ⚠ 둘을 하나로 합치지 말 것 — 합치면 포탈 주기를 바꾸는 순간 **게스트에 손도 대지 않았는데**
 *      전 서버가 '값이 오래됨' 으로 뒤바뀐다(또는 그 반대로 오래된 값을 신선하다고 말한다).
 *
 * ⚠ 기본은 **꺼짐(opt-in)** 이다 — 관리자가 폴더를 고르고 명시적으로 켜야 시작한다.
 * ⚠ 폴더 범위가 **비어 있으면 수집하지 않는다**(전체 VM 으로 확대 해석 금지). 5,850 VM 에
 *   게스트 실행을 돌리는 사고를 기본값으로 만들지 않는다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { numOrNull } from '../util/numOrNull.js';
import { clampSetting } from '../util/clampSetting.js'; // v2.613 DEPS2613-12 · RUNTIME2613-08: 숫자 설정 정규화는 하나(빈 칸 = 미지정)

const FILE = () => path.join(config.configDir, 'curuser-settings.json');

export const LIMITS = Object.freeze({
  intervalMs: { min: 5 * 60_000, max: 12 * 3600_000, def: 10 * 60_000 },   // 기본 10분(사용자 지정)
  retentionDays: { min: 1, max: 3650, def: 180 },
  concurrency: { min: 1, max: 16, def: 4 },
  vmTimeoutMs: { min: 10_000, max: 300_000, def: 60_000 },   // vCenter 조회 1회(법인 단위) 시한
  guestPublishMs: { min: 60_000, max: 12 * 3600_000, def: 10 * 60_000 },   // 게스트 스케줄 작업 주기(신고값)
  staleFactor: { min: 2, max: 12, def: 3 },                  // 발행주기 × 이 배수보다 오래되면 '값이 오래됨'
  maxVms: { min: 1, max: 5000, def: 400 },      // 한 주기 대상 상한(조용한 상한 금지 — 초과는 밝힌다)
});

const strArr = (v, max = 200) => (Array.isArray(v) ? v : [])
  .map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, max);

// v2.599 LO2599-01: 숫자 칸을 비우고 저장하면(''·null·비숫자·0 이하) clamp 가 **기본값**을 줬다 — 예: 보존 3650일 →
// 180일 · 주기 1시간 → 10분(현재 사용자). v2.596 규약대로 빈 칸은 '미지정' 이고 **이전 값을 유지**한다(판정은 numOrNull — Number('')===0 함정).
// v2.613 DEPS2613-12: clamp 사본 대신 util/clampSetting.js. 이 모듈의 계약(v2.599 LO2599-01·기존 테스트)은 '빈 값·비숫자·**0 이하** = 미지정
//   → 기본값' 이라 0 이하를 먼저 미지정(null)으로 접는다 — clampSetting 은 0 을 값으로 보고 하한으로 올린다(미입력이 최소주기로 둔갑).
const positive = (v) => { const n = numOrNull(v); return n != null && n <= 0 ? null : v; };
function keepPrevBlankNumbers(input, prev) {
  const out = { ...(input && typeof input === 'object' ? input : {}) };
  for (const k of Object.keys(LIMITS)) {
    const n = numOrNull(out[k]);
    if (n == null || n <= 0) out[k] = prev[k];
  }
  return out;
}

let _cache = null;
/**
 * 설정 변경 구독자 — `startAdaptiveTimer` 가 **무장된 타이머를 즉시 재무장**하는 데 쓴다.
 * 없으면 10분 주기에서 최대 10분 뒤에야 새 주기가 먹는다(v2.409 규칙).
 */
const listeners = new Set();
export function onCurUserSettingsChange(cb) { listeners.add(cb); return () => listeners.delete(cb); }

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
    intervalMs: clampSetting(positive(src.intervalMs), LIMITS.intervalMs),
    retentionDays: clampSetting(positive(src.retentionDays), LIMITS.retentionDays),
    concurrency: clampSetting(positive(src.concurrency), LIMITS.concurrency),
    vmTimeoutMs: clampSetting(positive(src.vmTimeoutMs), LIMITS.vmTimeoutMs),
    guestPublishMs: clampSetting(positive(src.guestPublishMs), LIMITS.guestPublishMs),
    staleFactor: clampSetting(positive(src.staleFactor), LIMITS.staleFactor),
    maxVms: clampSetting(positive(src.maxVms), LIMITS.maxVms),
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
  const before = _cache ? JSON.stringify(_cache) : null;
  _cache = normalize(keepPrevBlankNumbers(input, load()));
  atomicWriteFileSync(FILE(), JSON.stringify({ version: 1, ..._cache }, null, 2), { mode: 0o600 });
  if (before !== JSON.stringify(_cache)) for (const cb of listeners) { try { cb(); } catch { /* 격리 */ } }
  return load();
}

/** 이 설정으로 수집할 vCenter 인지. 폴더가 **비어 있으면 대상이 아니다**(전체 확대 금지). */
/**
 * 신선도 경계(ms) — **발행 주기 기준**이다(포탈 조회 주기가 아니다. 위 머리말 ⚠ 참조).
 * 화면은 이 값을 숫자로 하드코딩하지 않고 API 가 주는 것만 쓴다(CLAUDE.md 규칙).
 */
export function staleAfterMs(s) {
  const o = s || {};
  const pub = clampSetting(positive(o.guestPublishMs), LIMITS.guestPublishMs);
  const f = clampSetting(positive(o.staleFactor), LIMITS.staleFactor);
  return pub * f;
}

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

export function _resetForTest() { _cache = null; listeners.clear(); }
export const _FILE = FILE;
