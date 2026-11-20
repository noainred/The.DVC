/**
 * bmusage/onboard/placement.js — SSH 키를 이 서버 · 이 기능에 써도 되는가(순수 · 의존 없음 · v3.9.0 키 폴더 · 허용 기능).
 *
 * 판정은 keyPlacementIssue **하나**다 — 접속 때(refs.resolveOsAuth: 폴러 · 연결 시험)와 쓰기 때(온보딩 분석 · bm-storage 서버 저장 · 키 회전 ·
 * SSH 공용 접속 키 고르기)가 같은 함수를 쓴다. refs.js 가 그대로 다시 내보낸다(기존 호출부 `REFS.keyPlacementIssue`).
 * 순수 모듈로 둔 까닭: 온보딩 분석(importAnalyze — 순수 · 의존 주입)이 같은 판정을 직접 불러야 한다(4회차 점검 D1 — 쓰기 경로 셋에 판정이 없었다).
 *
 * 쓰기 때의 규칙(4회차 D1 · 메인 결정): 폴더(법인 · 서버) 밖은 **거부**(쓰면 수집이 매 주기 key-folder 로 접속하지 않는다 — B-4 '쓰기 전에 거절'),
 * 허용 기능에 없는 수집은 **경고**(기능 제한은 의도일 수 있다 — 적용은 막지 않는다). 연결 시험(conn-test)은 허용 기능을 보지 않으므로 경고가 그 차이를 말한다.
 */
const t = (v) => String(v ?? '').trim();

/** 허용 기능 목록과 무관하게 언제나 되는 쓰임 — 사람이 누르는 연결 시험(uname 한 줄). 그 밖의 호출은 기능 id 를 밝혀야 한다(빈 값 = 모르는 기능 — 목록이 있는 키는 거절). */
export const ALWAYS_ALLOWED_FEATURES = Object.freeze(['conn-test']);
/**
 * v3.30 서버 명령 실행(설계 docs/design/server-cmd D8): **직접 켠 키 · 계정만** 쓰는 기능 — 기능 목록이 없는(예전) 키 · 계정은 이 기능에 쓰지 않는다.
 *   원문 출력이 화면에 나오는 기능이라, 다른 기능을 위해 등록한 예전 키 · 계정이 저절로 쓰이지 않게(서버 단독 비밀번호는 기능 목록이 없어 이 판정 밖이다).
 */
export const EXPLICIT_FEATURES = Object.freeze(['server-cmd']);
/**
 * 점검 2회차 W2-2: **키로만 쓰는 · 직접 켠 키만** 기능(디스크 점검 설치 · 접속 자동 준비 — root 설치 · 준비). 판정은 `focusmon/audit/installCred.js`(키의 목록에 그 기능이 있어야 —
 *   예전 키는 쓰지 않는다)이고, 이 목록은 그 기능 이름의 한 곳이다(installCred 가 가져다 쓴다 · 화면 카탈로그의 ‘직접 켜야’ 표시도 이것 — 예전에는 화면이 이 둘을
 *   ‘예전 방식으로 쓰임’ 으로 보였다). featureBlocked 에 넣지 않는 것은 결정 대기(servercmd CLAUDE.md F12 — 합치면 ‘예전 계정 + 켠 키’ 설치가 막힌다).
 */
export const KEY_EXPLICIT_FEATURES = Object.freeze(['disk-audit-install', 'focus-mon-prep']);
/**
 * 허용 기능 판정 하나(키 · 공통 계정이 같은 함수 — keyPlacementIssue · refs.resolveOsAuth). true 면 막는다.
 *   목록이 있으면 그 기능이 있어야 하고, 목록이 없으면(예전 항목) 직접 켜야 하는 기능만 막는다.
 */
export function featureBlocked(features, feature = '') {
  const f = t(feature);
  if (ALWAYS_ALLOWED_FEATURES.includes(f)) return false;
  if (!Array.isArray(features)) return EXPLICIT_FEATURES.includes(f);
  return !features.includes(f);
}
/**
 * 키를 이 서버 · 이 기능에 써도 되는가(판정 하나 — 폴러 · 연결 시험 · SSH 공용 접속 화면의 키 고르기 · 쓰기 때 점검이 같은 함수).
 * @param {{folderCorp?:string, folderServer?:string, features?:string[]|null}} key
 * @param {{vcenterId?:string, name?:string}} server
 * @returns {null | 'key-folder' | 'key-feature'}
 */
export function keyPlacementIssue(key = {}, server = {}, feature = '') {
  const kc = t(key.folderCorp); const ks = t(key.folderServer);
  if (kc) {
    if (t(server.vcenterId) !== kc) return 'key-folder';
    if (ks && ks.toLowerCase() !== t(server.name).toLowerCase()) return 'key-folder';
  }
  if (featureBlocked(key.features, feature)) return 'key-feature';
  return null;
}

/** OS 계정 등록 항목을 쓰는 주기 수집 기능(bmusage/poller · bmstor/poller 의 withResolvedAuth feature). 이름은 SSH 공용 접속 FEATURE_CATALOG 와 같다(시험이 대조). */
export const COLLECT_FEATURES = Object.freeze(['bm-usage', 'bm-storage']);
export const FEATURE_LABEL = Object.freeze({ 'bm-usage': '베어메탈 사용률', 'bm-storage': '베어메탈 스토리지', 'disk-audit-install': '디스크 점검 프로그램 설치(root)', 'focus-mon-prep': '집중 모니터링 접속 준비(root)', 'server-info': '서버 정보', 'server-cmd': '서버 명령 실행' });
export const featureLabels = (ids = []) => ids.map((f) => FEATURE_LABEL[f] || f).join(' · ');

/** 판정에 필요한 칸만(비밀 없음). */
export function keyShape(k) {
  if (!k || typeof k !== 'object') return null;
  return { id: t(k.id), name: t(k.name), status: t(k.status), folderCorp: t(k.folderCorp), folderServer: t(k.folderServer), features: Array.isArray(k.features) ? [...k.features] : null };
}

/**
 * 쓰기 뒤 **효력 키** — 서버 키(key) → 공통 계정(cred)의 기본 키, 비밀번호 고정(osAuth 'password')이면 없음(refs.resolveOsAuth 와 같은 순서).
 * @param {{key?:string, cred?:string, osAuth?:string}} refs  참조 id(bindRule 토큰과 같은 꼴 — 빈 값 = 없음)
 * @param {{keyById:(id:string)=>object|null, accountById:(id:string)=>object|null}} look
 * @returns {object|null} keyShape
 */
export function effectiveKeyOf({ key = '', cred = '', osAuth = '' } = {}, { keyById = () => null, accountById = () => null } = {}) {
  if (osAuth === 'password') return null;
  let id = t(key);
  if (!id && t(cred)) { const a = accountById(t(cred)); id = a && a.kind === 'os' ? t(a.keyRef) : ''; }
  return id ? keyShape(keyById(id)) : null;
}

/**
 * 쓰기 때 점검 — 이 쓰기 뒤 효력 키를 이 서버(법인 · 이름)에 써도 되는가.
 *   before(쓰기 전 효력 키 id · 법인 · 이름)가 셋 다 같으면 **이 쓰기가 만든 문제가 아니다** — 판정하지 않는다(키와 무관한 칸 · 마운트만 고치는 저장을 예전 상태로 막지 않게).
 * @param {object|null} key  effectiveKeyOf 결과
 * @param {{vcenterId?:string, name?:string}} server  쓰기 뒤 서버
 * @param {{keyId?:string, vcenterId?:string, name?:string}|null} [before]  새 항목이면 null
 * @returns {{folder: null|'key-folder', blocked: string[]}}  blocked = 이 키로 막히는 수집 기능 id
 */
export function keyWriteIssue(key, server = {}, before = null) {
  if (!key) return { folder: null, blocked: [] };
  if (before && t(before.keyId) === t(key.id) && t(before.vcenterId) === t(server.vcenterId) && t(before.name).toLowerCase() === t(server.name).toLowerCase()) return { folder: null, blocked: [] };
  return {
    folder: keyPlacementIssue(key, server, ALWAYS_ALLOWED_FEATURES[0]) === 'key-folder' ? 'key-folder' : null,
    blocked: COLLECT_FEATURES.filter((f) => keyPlacementIssue({ features: key.features }, {}, f) === 'key-feature'),
  };
}

/**
 * 공통 계정을 이 서버(법인)에 써도 되는가(6회차 A2 — 판정 하나). 계정 법인이 비었거나(전 법인 공용) 서버 법인이 비었거나 같으면 된다.
 *   온보딩 분석의 cred-other-corp(importAnalyze credOk)와 공통 계정 저장의 그 계정을 쓰는 서버 대조(refs.accountUseIssue)가 같은 함수를 쓴다.
 *   ⚠ 접속 때 판정(resolveOsAuth)에는 넣지 않았다 — 이미 그렇게 쓰는 서버의 수집이 멈춘다(쓰기만 막는다 · docs/rules/idrac-server.md 6회차 X 남은 것).
 */
export function accountCorpOk(accountCorp, serverCorp) {
  const a = t(accountCorp).toLowerCase(); const v = t(serverCorp).toLowerCase();
  return !a || !v || a === v;
}

/** 회전 — 옛 키로 되던 수집 기능 중 새 키로는 막히는 것(같은 판정 keyPlacementIssue). */
export function lostFeatures(fromKey, toKey) {
  return COLLECT_FEATURES.filter((f) => !keyPlacementIssue({ features: fromKey?.features }, {}, f) && keyPlacementIssue({ features: toKey?.features }, {}, f) === 'key-feature');
}
