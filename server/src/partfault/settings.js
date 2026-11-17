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
import { isMockMode } from '../mock/demo/flags.js'; // v2.708 데모(mock)
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';
import { makeJsonFileLoader } from '../util/jsonFileLoad.js';   // 93회차 F4: 읽기 오류 ≠ 손상(결정 G2 공용 로더 — 78회차 F8 relaycheck 와 같은 꼴)
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

// 예전 판정 그대로 — 객체가 아닌 JSON(null · 배열 · 수)은 손상이다.
const parseStrictObject = (text) => { const v = JSON.parse(text); if (!v || typeof v !== 'object' || Array.isArray(v)) throw new SyntaxError('객체가 아닌 JSON 값'); return v; };
/*
 * 93회차 F4(재현 — 34회차 F4 · 78회차 F8 의 형제): 예전 로드는 읽기와 JSON.parse 를 catch 하나로 받아 **읽기 오류**(EACCES — root 가 손으로 고친
 *   0600 파일 · EIO · EISDIR)에도 원본을 `.corrupt.<시각>` 으로 옮기고 기본값(꺼짐)을 **재시작까지** 캐시했다 — 중앙의 파트 장애 판정 · 알림이
 *   조용히 꺼지고, 관리자가 다시 켜는 저장이 새 파일을 만들었다(엣지별 스위치 · 보존일 유실). 이제 공용 로더: 손상만 보존본으로 옮기고, 읽기 오류는
 *   원본을 두고 30초마다 다시 읽으며(읽히면 재시작 없이 풀린다) 그동안 저장은 409(partFaultSettingsWriteRefusal)로 거절한다.
 */
const _file = makeJsonFileLoader(FILE, { label: '파트 장애 설정', confirm: () => savePartFaultSettings({}), parse: parseStrictObject, tag: 'partfault' });
/** v2.631(EDGE2631-01): 설정 파일을 못 읽었으면 사유(배포 라우트가 503 으로 답한다), 읽었으면 null. */
export function partFaultSettingsLoadError() { loadPartFaultSettings(); return _file.loadError(); }
/** 93회차 F4: 읽기 오류 중의 쓰기 거절(라우트 409) 또는 null — 손상(보존본으로 옮김)은 예전처럼 관리자 저장이 푼다. */
export function partFaultSettingsWriteRefusal() {
  loadPartFaultSettings();
  if (!_file.loadError()?.readError) return null;
  return { ..._file.refusal('파트 장애 설정'), status: 409 };
}

export function loadPartFaultSettings() {
  if (_cache && !_file.recheckDue()) return _cache;   // 93회차 F4: 오류 중에는 캐시를 믿지 않고 간격마다 다시 판정
  // v2.631(EDGE2631-01): 손상이면 기본값(꺼짐)으로 시작하되 **로드 오류를 기억**한다 — 그 기본값을 /api/central/partfault-config 가
  //   200 으로 내려보내면 전 엣지의 파트 장애 수집이 꺼진다. 배포 라우트는 이 오류를 보고 503(엣지는 직전 값 유지)으로 답한다.
  const r = _file.load();
  if (r.kind === 'ok') {
    _cache = { ...DEFAULTS, ...r.value };
    _retentionFromFile = numOrNull(r.value.retentionDays) != null;
  } else { _cache = { ...DEFAULTS }; _retentionFromFile = false; }   // 없음 · 손상 · 읽기 오류 — 기본값(꺼짐)으로. 켜진 척하지 않는다.
  if (!_cache.edges || typeof _cache.edges !== 'object') _cache.edges = {};
  _cache.retentionDays = clampSetting(_cache.retentionDays, RETENTION_LIMITS); // 손편집 값도 범위 안으로(비숫자는 기본값)
  return _cache;
}

// v2.733(점검 3회차 C4-04): 캐시는 **디스크 쓰기 성공 뒤에만** 바꾼다(v2.732 B5-03 sanswitch/perfSettings.js 와 같은 규약). 예전에는 먼저
//   바꿔, 쓰기가 실패해 화면이 오류를 받은 뒤에도 메모리는 켜짐이라 중앙 판정·알림이 돌고 /partfault-config 로 전 엣지가 켰다 —
//   재시작하면 꺼짐으로 되돌아갔다. 엣지 applyCentral 도 같은 persist 라, 실패하면 다음 pull 이 '이미 같다' 로 건너뛰지 않고 다시 쓴다.
function persist(next) {
  // 93회차 F4: 마지막 방어선 — 읽기 오류 중에는 디스크의 원본(보존본도 없다)을 기본값 위의 값으로 덮지 않는다(엣지 applyCentral 포함 — 호출부가 잡는다).
  const no = partFaultSettingsWriteRefusal();
  if (no) throw Object.assign(new Error(no.reason), { status: 409, code: no.code, readError: true });
  atomicWriteFileSync(FILE(), JSON.stringify(next, null, 2), { mode: 0o600 });
  _cache = next;
  _file.saved();
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
  //   v2.733(C4-04): '파일에 보존일이 있다'(출처 settings) 표시도 쓰기 성공 뒤에 세운다 — 실패한 저장이 출처를 바꾸면 안 된다.
  const retentionSaved = Object.hasOwn(patch, 'retentionDays') && numOrNull(patch.retentionDays) != null;
  if (retentionSaved) next.retentionDays = clampSetting(patch.retentionDays, RETENTION_LIMITS);
  const out = persist(next);
  if (retentionSaved) _retentionFromFile = true;
  return out;
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
  // v2.708: 데모(mock) — 설정 파일은 바꾸지 않고 켜진 것처럼(source 'demo'). env PARTFAULT_ENABLED=false 가 여전히 이긴다(위).
  if (!s.enabled && isMockMode()) return { enabled: true, source: 'demo', demo: true };
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

export function _resetForTest() { _cache = null; _retentionFromFile = false; _file.resetRetry(); }
