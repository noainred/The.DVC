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
import { atomicWriteFileSync } from '../util/atomicWrite.js';

const FILE = () => path.join(config.configDir, 'partfault-settings.json');
const t = (v) => String(v ?? '').trim();
let _cache = null;

const DEFAULTS = Object.freeze({ enabled: false, edges: {}, central: null });

export function loadPartFaultSettings() {
  if (_cache) return _cache;
  try {
    const j = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    _cache = { ...DEFAULTS, ...(j && typeof j === 'object' ? j : {}) };
  } catch { _cache = { ...DEFAULTS }; }   // 설정 파일 — 손상이면 기본값(꺼짐)으로 시작. 켜진 척하지 않는다.
  if (!_cache.edges || typeof _cache.edges !== 'object') _cache.edges = {};
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

export function _resetForTest() { _cache = null; }
