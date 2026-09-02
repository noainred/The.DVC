/**
 * storage/intervals.js — 스토리지 수집 주기(중앙에서 엣지 설정, v2.409).
 *
 * 왜: 주기는 지금까지 **엣지 장비의 portal.env 상수**였다(모듈 로드 시 1회 읽음). 주기를 줄이려면
 * 각 엣지에 SSH 로 붙어 portal.env 를 고치고 재시작해야 했는데, 엣지가 28개 법인에 흩어져 있어
 * 사실상 조정 불가였다. 이 모듈은 주기를 **중앙이 배포하는 값**으로 바꾼다.
 *
 * 경로(기존 아웃바운드 pull 축 재사용 — 중앙은 엣지에 명령을 밀어넣을 수 없다):
 *   중앙 UI(설정 › 스토리지 수집 주기) → storage-intervals.json
 *     → GET /api/central/storage-config 응답의 `intervals`
 *       → 엣지 agent/storageConfigPull.js 가 applyCentralIntervals()
 *         → 폴러/푸셔가 다음 틱부터 새 주기로 재무장(onIntervalsChange 로 즉시 재무장)
 *
 * 우선순위: **중앙 지정값 > 엣지 portal.env > 기본값**.
 *   - 중앙이 값을 안 주면(빈 객체) 엣지는 자기 env/기본값으로 되돌아간다(중앙 '미설정' = 로컬 유지).
 *   - 엣지에서 `STORAGE_INTERVALS_LOCAL=1` 이면 중앙 값을 무시한다(현장 고정 탈출구 —
 *     회선이 좁은 법인에서 중앙 실수로 주기가 확 줄어드는 사고를 막는 안전핀).
 *
 * 한계(정직 표기):
 *   - 설정 pull 주기 자체를 늘려 두면(예 60분) 그 값을 줄이라는 지시도 최대 그만큼 늦게 도착한다
 *     (구조상 불가피 — 엣지가 물어보러 와야 알 수 있다). 기본 5분에서는 문제되지 않는다.
 *   - 하한(60초·영역수집 10분)은 서버에서 강제한다. 28개 vCenter·고RTT 환경에서 그 밑으로 내리면
 *     수집이 끝나기 전에 다음 주기가 오고 재진입 가드에 막혀 '설정만 바뀌고 실효 없음'이 된다.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';

/** 조정 가능한 주기 항목. min/def 는 서버가 단일 소스 — UI 가 이 표를 받아 폼을 그린다. */
export const INTERVAL_SPEC = [
  { key: 'pollMs', env: 'STORAGE_POLL_MS', def: 10 * 60_000, min: 60_000,
    label: '장비 수집 주기', hint: '스토리지 장비에 접속해 용량·노드 상태를 읽는 간격. 짧을수록 화면이 최신이지만 장비/회선 부하가 는다.' },
  { key: 'pushMs', env: 'STORAGE_PUSH_MS', def: 5 * 60_000, min: 60_000,
    label: '중앙 전송(push) 주기', hint: '엣지가 수집한 결과를 중앙으로 올리는 간격. 중앙 화면 반영 지연 = 수집 주기 + 이 값.' },
  { key: 'configPullMs', env: 'STORAGE_CONFIG_PULL_MS', def: 5 * 60_000, min: 60_000,
    label: '중앙 설정 수신(pull) 주기', hint: '장비 목록·이 주기 설정·수집 요청을 중앙에서 받아오는 간격. 중앙 "수집" 버튼의 반응 속도이기도 하다.' },
  { key: 'areasMs', env: 'STORAGE_AREAS_MS', def: 60 * 60_000, min: 10 * 60_000,
    label: '영역(쿼터/공유) 전수 수집 주기', hint: 'PowerScale 쿼터·SMB/NFS 등 무거운 전수 조회 간격. 장비 부하가 커 기본이 길다.' },
];
const SPEC_BY_KEY = new Map(INTERVAL_SPEC.map((s) => [s.key, s]));
const MAX_MS = 24 * 60 * 60_000; // 상한 24시간 — 그 이상은 사실상 '끔'이라 오설정으로 본다.

/**
 * 입력 정규화(순수). 아는 키만 남기고 하한/상한으로 clamp 한다.
 * 값이 숫자가 아니거나 비어 있으면 그 키를 **버린다**(0/NaN 이 하한으로 승격되어 의도치 않게
 * 최소 주기로 도는 사고 방지 — '미입력'과 '최소값 지정'은 다른 뜻이다).
 * @returns { values, issues } issues 는 사람이 읽는 경고 문자열 배열(저장은 진행).
 */
export function normalizeIntervals(input = {}) {
  const values = {};
  const issues = [];
  for (const [k, raw] of Object.entries(input || {})) {
    const spec = SPEC_BY_KEY.get(k);
    if (!spec) { issues.push(`알 수 없는 항목 무시: ${k}`); continue; }
    if (raw === null || raw === undefined || raw === '') continue; // 미설정 = 엣지 로컬 유지
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) { issues.push(`${spec.label}: 숫자가 아니어서 무시(${raw})`); continue; }
    let v = Math.round(n);
    if (v < spec.min) { issues.push(`${spec.label}: 하한 ${Math.round(spec.min / 1000)}초로 올림(요청 ${Math.round(v / 1000)}초)`); v = spec.min; }
    if (v > MAX_MS) { issues.push(`${spec.label}: 상한 24시간으로 내림`); v = MAX_MS; }
    values[k] = v;
  }
  return { values, issues };
}

/** 이 노드의 로컬 기본값 = portal.env(없으면 코드 기본). 항상 전 키를 채운다. */
export function envIntervals() {
  const out = {};
  for (const s of INTERVAL_SPEC) {
    const n = Number(process.env[s.env]);
    out[s.key] = Number.isFinite(n) && n > 0 ? Math.min(MAX_MS, Math.max(s.min, Math.round(n))) : s.def;
  }
  return out;
}

// ── 런타임(이 노드에서 실제로 쓰이는 값) ───────────────────────────────────────
let _override = {};        // 중앙이 지정한 값(부분 — 지정한 키만)
let _overrideAt = 0;
const _listeners = new Set();

/** 현장 고정 핀 — 켜면 중앙 배포를 무시한다(엣지 portal.env). */
export const localPinned = () => String(process.env.STORAGE_INTERVALS_LOCAL || '') === '1';

/** 지금 이 노드가 쓸 실효 주기(전 키). 폴러가 매 틱 이 값을 읽는다. */
export function runtimeIntervals() {
  return localPinned() ? envIntervals() : { ...envIntervals(), ..._override };
}

/** 어느 키가 중앙 지정인지(UI/상태 표시용 — '왜 이 값인가'를 화면에서 설명할 수 있게). */
export function runtimeIntervalSource() {
  const env = envIntervals();
  const eff = runtimeIntervals();
  return INTERVAL_SPEC.map((s) => ({
    key: s.key, label: s.label, ms: eff[s.key],
    from: !localPinned() && _override[s.key] ? 'central' : (process.env[s.env] ? 'env' : 'default'),
  }));
}

/**
 * 중앙 배포값 적용(엣지 — storageConfigPull 이 호출). 값이 바뀌면 리스너(폴러 타이머)에
 * 알려 **즉시 재무장**한다. 알리지 않으면 이미 무장된 타이머가 만료될 때까지(최악 60분)
 * 새 주기가 안 먹어 '설정했는데 안 바뀐다'가 된다.
 */
export function applyCentralIntervals(input = {}) {
  if (localPinned()) return { applied: false, reason: 'STORAGE_INTERVALS_LOCAL=1 — 현장 고정(중앙 값 무시)' };
  const { values } = normalizeIntervals(input);
  const before = JSON.stringify(_override);
  if (before === JSON.stringify(values)) return { applied: false, unchanged: true, values };
  _override = values;
  _overrideAt = Date.now();
  const eff = runtimeIntervals();
  console.log('[storage-intervals] 중앙 지정 주기 적용: '
    + INTERVAL_SPEC.map((s) => `${s.key}=${Math.round(eff[s.key] / 1000)}s`).join(' '));
  for (const cb of _listeners) { try { cb(eff); } catch { /* 리스너 하나가 나머지를 막지 않게 */ } }
  return { applied: true, values, effective: eff };
}

export function onIntervalsChange(cb) { _listeners.add(cb); return () => _listeners.delete(cb); }
export function centralIntervalsInfo() { return { override: { ..._override }, at: _overrideAt, pinned: localPinned() }; }

/**
 * 주기를 스스로 다시 잡는 타이머(setInterval 대체).
 *
 * setInterval 은 생성 시점의 상수 간격에 묶여 있어 주기를 바꾸려면 재시작이 필요하다.
 * 여기서는 매 회 `getMs()` 를 다시 읽어 재무장하므로 중앙 배포가 다음 틱부터(변경 알림이
 * 오면 즉시) 반영된다. 부수효과로 **간격이 '이전 실행 종료 기준'** 이 되어, 수집이 주기를
 * 넘겨도 틱이 겹쳐 쌓이지 않는다(CLAUDE.md 재진입 규칙과 같은 방향 — 가드는 그대로 둔다).
 */
export function startAdaptiveTimer(getMs, fn, { firstDelayMs = 0, name = '' } = {}) {
  let timer = null;
  let stopped = false;
  let lastRunAt = Date.now();
  const arm = (ms) => {
    clearTimeout(timer);
    timer = setTimeout(tick, Math.max(1_000, ms));
    timer.unref?.();
  };
  const tick = async () => {
    lastRunAt = Date.now();
    try { await fn(); } catch { /* 폴러는 자기 오류를 삼킨다(기존 .catch(()=>{}) 와 동일) */ }
    if (!stopped) arm(getMs());
  };
  arm(firstDelayMs);
  // 주기 변경 시 재무장 — 이미 흘린 시간을 빼고 다시 잡는다(주기를 늘렸다고 방금 돈 작업을
  // 또 돌리지 않고, 줄였다면 남은 시간이 음수가 되어 바로 다음 틱으로 간다).
  const off = onIntervalsChange(() => {
    if (stopped) return;
    const next = getMs() - (Date.now() - lastRunAt);
    if (name) console.log(`[storage-intervals] ${name} 타이머 재무장: ${Math.round(Math.max(1_000, next) / 1000)}초 후`);
    arm(next);
  });
  return { stop() { stopped = true; off(); clearTimeout(timer); } };
}

// ── 중앙 저장소(중앙 노드에서만 사용) ─────────────────────────────────────────
// 자격증명이 아니므로 vault 봉인 대상은 아니지만, 손상 시 조용히 빈 값을 저장해 설정이
// 사라지지 않게 원자적 쓰기 + preserveCorrupt 규칙은 동일하게 따른다(server/CLAUDE.md).
const FILE = path.join(config.configDir, 'storage-intervals.json');
const MAX_AGENTS = 200;
let _db = null;

function load() {
  if (_db) return _db;
  try {
    if (fs.existsSync(FILE)) {
      const p = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      _db = {
        global: normalizeIntervals(p.global || {}).values,
        agents: Object.fromEntries(Object.entries(p.agents || {}).slice(0, MAX_AGENTS)
          .map(([a, v]) => [String(a), normalizeIntervals(v || {}).values])),
      };
      return _db;
    }
  } catch { preserveCorrupt(FILE); }
  _db = { global: {}, agents: {} };
  return _db;
}

/** 저장된 설정 전체(UI 조회용). */
export function loadIntervalConfig() { const d = load(); return { global: { ...d.global }, agents: { ...d.agents } }; }

/**
 * 전체 교체 저장. `agents` 의 키는 엣지 이름이며 **빈 문자열 키는 중앙 자신**(직접 수집 장비)이다
 * — registry.js 의 agent '' 규약과 같다.
 */
export function saveIntervalConfig({ global = {}, agents = {} } = {}) {
  const issues = [];
  const g = normalizeIntervals(global);
  issues.push(...g.issues);
  const a = {};
  for (const [name, v] of Object.entries(agents).slice(0, MAX_AGENTS)) {
    const r = normalizeIntervals(v || {});
    issues.push(...r.issues.map((s) => `[${name || '중앙'}] ${s}`));
    if (Object.keys(r.values).length) a[String(name)] = r.values; // 빈 항목은 저장하지 않는다(파일이 유령 키로 붇지 않게)
  }
  _db = { global: g.values, agents: a };
  atomicWriteFileSync(FILE, JSON.stringify({ version: 1, ..._db }, null, 2), { mode: 0o600 });
  return { ok: true, config: loadIntervalConfig(), issues };
}

/**
 * 이 엣지에 배포할 값(부분 — 지정한 키만). 전역 위에 엣지별 값을 덮는다.
 * ⚠ 기본값을 채워 보내지 않는다 — 중앙이 지정하지 않은 항목까지 내려보내면 엣지가
 * portal.env 로 잡아 둔 현장 설정을 통째로 덮어쓴다('미설정 = 로컬 유지' 계약).
 */
export function intervalsForAgent(agent) {
  const d = load();
  return { ...d.global, ...(d.agents[String(agent || '')] || {}) };
}

/**
 * 중앙 노드가 **자기 자신**(직접 수집 장비 = registry 의 agent '')에 지정한 주기를 적용한다.
 * 엣지는 이 경로를 타지 않는다 — 엣지 값은 config pull 로 온다(파일이 엣지엔 없다).
 * 기동 시 1회 + 설정 저장 직후 호출해, 중앙 자신도 재시작 없이 주기가 바뀌게 한다.
 */
export function applyOwnIntervals() {
  if (config.agent.centralUrl && config.agent.centralToken) {
    return { applied: false, reason: '엣지 노드 — 주기는 중앙 설정 pull 로 적용된다' };
  }
  return applyCentralIntervals(intervalsForAgent(''));
}

export function _resetForTest() { _db = null; _override = {}; _overrideAt = 0; }
