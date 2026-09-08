/**
 * pdu/intervals.js — PDU 수집 주기(사용자 요구: '수집 시간은 설정에서 지정').
 *
 * storage/intervals.js 와 **같은 계약**을 따른다(그쪽 주석이 배경 설명 — 중앙이 배포하고 엣지가
 * pull 로 받아 다음 틱부터 재무장). 왜 파일을 나눴나: 스토리지와 PDU 는 주기 성격이 달라
 * (PDU 는 전력이라 더 촘촘하게 보고 싶어함) 한 표에 섞으면 한쪽을 바꿀 때 다른 쪽이 끌려간다.
 *
 * 배포 계약(중요 — 되돌리지 말 것):
 *  - **중앙이 지정한 키만** 내려간다. 전 키를 채워 보내면 각 법인이 portal.env 로 잡아 둔
 *    현장 설정을 통째로 덮어쓴다.
 *  - 하한은 서버가 강제하고, **빈 값·0 은 하한으로 승격하지 않고 '미지정'으로 버린다**
 *    (미입력이 최소주기로 둔갑하는 사고 방지).
 *  - 엣지에서 `PDU_INTERVALS_LOCAL=1` 이면 중앙 값을 무시한다(현장 고정 탈출구).
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { startAdaptiveTimer as baseAdaptiveTimer } from '../util/adaptiveTimer.js';

const FILE = path.join(config.configDir, 'pdu-intervals.json');
const MAX_MS = 24 * 60 * 60_000;

/** 조정 가능한 주기 — 서버가 단일 소스. UI 가 이 표를 받아 폼을 그린다. */
export const INTERVAL_SPEC = [
  { key: 'pollMs', env: 'PDU_POLL_MS', def: 5 * 60_000, min: 60_000,
    label: 'PDU 수집 주기', hint: 'PDU 에 SSH 로 접속해 전력·뱅크·온습도를 읽는 간격. 짧을수록 추이가 촘촘하지만 장비/회선 부하가 는다.' },
  { key: 'pushMs', env: 'PDU_PUSH_MS', def: 5 * 60_000, min: 60_000,
    label: '중앙 전송(push) 주기', hint: '엣지가 수집 결과를 중앙으로 올리는 간격. 중앙 화면 반영 지연 = 수집 주기 + 이 값.' },
  { key: 'configPullMs', env: 'PDU_CONFIG_PULL_MS', def: 5 * 60_000, min: 60_000,
    label: '중앙 설정 수신(pull) 주기', hint: '장비 목록·주기 설정을 중앙에서 받아오는 간격.' },
];
const SPEC_BY_KEY = new Map(INTERVAL_SPEC.map((s) => [s.key, s]));

let _central = null;   // 엣지가 중앙에서 받은 값(메모리)
let _listeners = new Set();

function loadFile() {
  if (!fs.existsSync(FILE)) return {};
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; }
  catch (e) { preserveCorrupt(FILE, e.message); return {}; }
}

/** 중앙 UI 저장 — 지정한 키만 남긴다(빈 값/0 은 '미지정'으로 제거). */
export function saveIntervals(partial = {}) {
  const cur = loadFile();
  const next = { ...cur };
  for (const s of INTERVAL_SPEC) {
    if (!(s.key in partial)) continue;
    const raw = partial[s.key];
    if (raw === '' || raw == null) { delete next[s.key]; continue; } // 미지정으로 되돌리기
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n) || n <= 0) { delete next[s.key]; continue; } // 0/음수는 버린다(하한 승격 금지)
    next[s.key] = Math.min(MAX_MS, Math.max(s.min, n));
  }
  atomicWriteFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  notify();
  return next;
}

/** 중앙이 엣지에 내려보낼 값(지정된 키만). */
export function intervalsForEdge() { return loadFile(); }

/** 엣지: 중앙에서 받은 값 적용. */
export function applyCentralIntervals(obj) {
  if (process.env.PDU_INTERVALS_LOCAL === '1') return false; // 현장 고정
  const next = {};
  for (const s of INTERVAL_SPEC) {
    const v = obj?.[s.key];
    if (v == null || v === '') continue;
    const n = Math.round(Number(v));
    if (Number.isFinite(n) && n > 0) next[s.key] = Math.min(MAX_MS, Math.max(s.min, n));
  }
  const changed = JSON.stringify(next) !== JSON.stringify(_central || {});
  _central = next;
  if (changed) notify();
  return changed;
}

/**
 * 실효 주기 — **중앙 지정값 > 엣지 env > 기본값**.
 * ⚠ 모듈 로드 시 상수로 굳히지 말 것: 그러면 중앙에서 바꿔도 엣지를 재시작해야 먹는다.
 *   호출부는 매 틱 이 함수를 다시 부르고 startAdaptiveTimer 로 재무장해야 한다.
 */
export function runtimeIntervals() {
  const central = (process.env.PDU_INTERVALS_LOCAL === '1') ? {} : (_central || {});
  const file = loadFile();
  const out = {};
  for (const s of INTERVAL_SPEC) {
    // 중앙 노드에서는 자기 파일이 곧 중앙 지정값이다(엣지에서는 _central 이 그 역할).
    const fromCentral = central[s.key] ?? (config.agent.centralUrl ? undefined : file[s.key]);
    const fromEnv = process.env[s.env] ? Number(process.env[s.env]) : undefined;
    const v = fromCentral ?? fromEnv ?? s.def;
    out[s.key] = Math.min(MAX_MS, Math.max(s.min, Math.round(Number(v) || s.def)));
  }
  return out;
}

export const pollMs = () => runtimeIntervals().pollMs;
export const pushMs = () => runtimeIntervals().pushMs;
export const configPullMs = () => runtimeIntervals().configPullMs;

/** 값이 바뀌면 무장된 타이머를 즉시 재무장하도록 알린다(없으면 최대 1주기 늦게 적용). */
export function onIntervalsChange(fn) { _listeners.add(fn); return () => _listeners.delete(fn); }
function notify() { for (const fn of _listeners) { try { fn(); } catch { /* */ } } }

/** intervals 변경에 즉시 반응하는 adaptiveTimer 래퍼. */
export function startAdaptiveTimer(getMs, fn, opts = {}) {
  return baseAdaptiveTimer(getMs, fn, { ...opts, subscribe: onIntervalsChange });
}

export function _resetForTest() { _central = null; _listeners = new Set(); }
