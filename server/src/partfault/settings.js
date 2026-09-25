/**
 * partfault/settings.js — 파트 장애 기능 스위치(v2.548 F3).
 *
 * v2.547 의 확정 결함: 문서와 poller 는 `PARTFAULT_ENABLED` opt-in 이라 했는데 **엣지 push 는 그 값을
 * 보지 않았다**(push.js:85 가 CENTRAL_URL/TOKEN 만 검사). 기능을 켠 적이 없는 28개 엣지가 10분마다
 * 스캔·POST 했고, 반대로 엣지에서 `PARTFAULT_ENABLED=true` 를 주면 엣지 poller 까지 돌아 **알림이 두 번**
 * 나갔다. 스위치는 한 곳이어야 한다 — 이 파일이 그 한 곳이다.
 *
 * 판정 순서(한 노드에서 '켜졌는가'):
 *  ① env `PARTFAULT_ENABLED` 가 `'true'`/`'false'` 면 그것이 이긴다(현장 강제 — 회선이 좁은 법인의 탈출구,
 *     storage/intervals.js 의 portal.env 우선 규약과 같은 판단).
 *  ② 아니면 중앙 설정 파일 `partfault-settings.json` 의 `enabled`(중앙 노드) /
 *     중앙이 배포해 준 `central.enabled`(엣지 노드 — `agent/partFaultConfigPull.js` 가 채운다).
 *  ③ 둘 다 없으면 **꺼짐**.
 *
 * 중앙은 엣지별로도 끌 수 있다(`edges[<agent>].enabled`) — 판정 규칙이 바뀌어 특정 법인만 잠시 멈춰야 할 때.
 * ⚠ 이 파일은 **비밀을 담지 않는다**(SECRET_FILES 등록 대상 아님). 다만 `.gitignore` 에는 넣는다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { clampSetting } from '../util/clampSetting.js'; // v2.613 DEPS2613-12: 숫자 설정 정규화는 하나
import { numOrNull } from '../util/numOrNull.js';

const FILE = () => path.join(config.configDir, 'partfault-settings.json');
const t = (v) => String(v ?? '').trim();
let _cache = null;
let _retentionFromFile = false; // v2.613 PERSIST2613-06: 파일에 retentionDays 가 실제로 있었는가(출처 표시용)

/**
 * v2.613 PERSIST2613-06: 이력 보존일. 형제(bmusage·linkcheck·cvp·curuser·horizon)는 설정 파일 + 화면인데 partfault 만 env 전용이라
 *   '부품 장애 이력 2년' 을 바꾸려면 portal.env 를 고쳐야 했다(v2.409 '중앙 배포값' 규약과 반대 방향). 하한 30일(그 아래면 전이
 *   이력이 뜻을 잃는다) · 상한 10년 · 기본 730일. 빈 칸은 미지정(이전 값 유지 — v2.596 CLAMP 규약).
 */
export const RETENTION_LIMITS = Object.freeze({ min: 30, max: 3650, def: 730 });
const DEFAULTS = Object.freeze({ enabled: false, edges: {}, central: null, retentionDays: RETENTION_LIMITS.def });

export function loadPartFaultSettings() {
  if (_cache) return _cache;
  try {
    const j = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    _cache = { ...DEFAULTS, ...(j && typeof j === 'object' ? j : {}) };
    _retentionFromFile = !!(j && typeof j === 'object' && numOrNull(j.retentionDays) != null);
  } catch (e) { if (fs.existsSync(FILE())) preserveCorrupt(FILE(), e.message); _cache = { ...DEFAULTS }; }   // 설정 파일 — 손상이면 기본값(꺼짐)으로 시작. 켜진 척하지 않는다.
  if (!_cache.edges || typeof _cache.edges !== 'object') _cache.edges = {};
  _cache.retentionDays = clampSetting(_cache.retentionDays, RETENTION_LIMITS); // 손편집 값도 범위 안으로(비숫자는 기본값)
  return _cache;
}

function persist(next) {
  _cache = next;
  atomicWriteFileSync(FILE(), JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

/** 중앙: 관리자 저장. `edges` 는 { [agentLower]: { enabled } } 만 받는다. */
export function savePartFaultSettings(patch = {}) {
  const cur = loadPartFaultSettings();
  const next = { ...cur };
  if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
  if (patch.edges && typeof patch.edges === 'object') {
    const edges = {};
    for (const [k, v] of Object.entries(patch.edges)) {
      const key = t(k).toLowerCase();
      if (!key) continue;
      if (v && typeof v === 'object' && typeof v.enabled === 'boolean') edges[key] = { enabled: v.enabled };
    }
    next.edges = edges;
  }
  // v2.613 PERSIST2613-06: 빈 칸·비숫자는 미지정(이전 값 유지) — Number('')===0 이 하한으로 올라가 보존일이 줄어드는 사고를 막는다(v2.583·v2.596).
  if (Object.hasOwn(patch, 'retentionDays') && numOrNull(patch.retentionDays) != null) { next.retentionDays = clampSetting(patch.retentionDays, RETENTION_LIMITS); _retentionFromFile = true; }
  return persist(next);
}

/** 엣지: 중앙이 내려준 값 반영. 바뀌었을 때만 true. */
export function applyCentral(s = {}) {
  const cur = loadPartFaultSettings();
  const enabled = typeof s.enabled === 'boolean' ? s.enabled : null;
  if (enabled == null) return false;
  if (cur.central && cur.central.enabled === enabled) { _cache.central.at = Date.now(); return false; }
  persist({ ...cur, central: { enabled, at: Date.now() } });
  return true;
}

/** 중앙이 특정 엣지에 내려줄 값. */
export function settingsForAgent(agent) {
  const s = loadPartFaultSettings();
  const k = t(agent).toLowerCase();
  const e = Object.hasOwn(s.edges || {}, k) ? s.edges[k] : null;   // 'constructor' 같은 프로토타입 키 방어(v2.548 S1 계열)
  return { enabled: e && typeof e.enabled === 'boolean' ? e.enabled : !!s.enabled };
}

/**
 * 이 노드에서 기능이 켜졌는가 + **왜**(화면·로그가 '왜 안 도는지' 를 말해야 한다 — v2.547 규약).
 * @returns {{enabled:boolean, source:'env'|'central'|'edge-central'|'default'}}
 */
export function partFaultEnabled() {
  const env = t(process.env.PARTFAULT_ENABLED).toLowerCase();
  if (env === 'true') return { enabled: true, source: 'env' };
  if (env === 'false') return { enabled: false, source: 'env' };
  const s = loadPartFaultSettings();
  if (config.agent.centralUrl) {
    if (s.central && typeof s.central.enabled === 'boolean') return { enabled: s.central.enabled, source: 'edge-central' };
    return { enabled: false, source: 'default' };
  }
  return { enabled: !!s.enabled, source: s.enabled ? 'central' : 'default' };
}

/**
 * v2.613 PERSIST2613-06: 유효 보존일과 **출처**. env `PARTFAULT_RETENTION_DAYS` 가 이긴다(현장 강제 — PARTFAULT_ENABLED 와 같은 순서):
 *   빈 값·비숫자·음수는 **미지정**(설정으로 간다) · `0` 은 **전부 보관**(prune 생략 — config.js retentionEnv 의 v2.583 계약
 *   'IDRAC/TEMP/PING_RETENTION_DAYS=0 = keep all' 과 같은 뜻. 예전 `Math.max(30, Number(env) || 730)` 은 0 을 조용히 730 으로
 *   되돌렸다) · 양수는 하한 30일. env 가 없으면 설정 파일(화면) 값, 그것도 없으면 기본 730일.
 * @returns {{ days:number, source:'env'|'settings'|'default' }}  days 0 = 전부 보관
 */
export function partFaultRetention() {
  const raw = process.env.PARTFAULT_RETENTION_DAYS;
  const n = raw == null || String(raw).trim() === '' ? null : numOrNull(raw);
  if (n != null && n >= 0) return { days: n === 0 ? 0 : Math.max(RETENTION_LIMITS.min, Math.round(n)), source: 'env' };
  const s = loadPartFaultSettings();
  return { days: clampSetting(s.retentionDays, RETENTION_LIMITS), source: _retentionFromFile ? 'settings' : 'default' };
}

export function _resetForTest() { _cache = null; _retentionFromFile = false; }
