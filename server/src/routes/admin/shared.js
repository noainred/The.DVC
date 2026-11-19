// routes/admin 공용 — admin.js(구 2,410줄) 분할(v2.285.0)로 이동. 본문은 원본 그대로.
// adminOnly·requireSettingsOwner 미들웨어와 다중 도메인 헬퍼만 여기 둔다.
import fs from 'node:fs';
import { config } from '../../config.js';
import { requireRole } from '../../auth/auth.js';
import { loadSessionSecurity } from '../../security/securitySettings.js';
import { scopedVcenterIds, isFullReadWriteScope, WRITE_SCOPE_PARTIAL_REASON } from '../../auth/scope.js';
import { store } from '../../store.js';
import { analysisFilter, hostVcByTag, hostNameByTag, hostNicsByTag, withMappedVc, collectorToDatacenterMap, remoteServersResolved, analysisServersWithRemote, invForServer, ensureCollectorDatacenter } from '../../insights/analysisServers.js'; // v2.579: 재수출용


export const adminOnly = requireRole('admin');

/**
 * 6회차 점검 A1(메인 결정): **안전 메서드(GET · HEAD · OPTIONS)는 조회 범위만** 본다(조회 무제한 계정의 함대 조회를 막지 않는다 — 예전 그대로).
 *   **그 밖의 메서드(쓰기 · 실행)는 조회 ∧ 쓰기 모두 전체 범위**(`isFullReadWriteScope` — v2.904 · v2.935 와 같은 판정 하나)여야 통과한다.
 *   예전에는 두 공용 게이트(fullScopeOnlyWith · requireSettingsOwner)가 조회 범위만 봐서, 조회는 무제한이고 쓰기만 일부 법인으로 줄인 계정
 *   (scope = { vcenters: [], writeVcenters: [vcA] })이 전 법인 공용 쓰기(서버 귀속 · 수집 설정 · 백업 설정 · 공용 비밀 …)를 그대로 했다.
 *   라우트 수백 개를 하나씩 fullReadWriteScopeOnlyWith 로 바꾸다 빠뜨리지 않게 게이트 한 곳에서 가른다.
 *   판정이 던지면 거부한다(isFullReadWriteScope 의 기본값 false). 쓰기 범위 때문에 막을 때는 사유를 따로 준다(조회 범위 사유는 이 계정에 틀린 설명).
 */
export const SAFE_METHODS = Object.freeze(['GET', 'HEAD', 'OPTIONS']);
export const isSafeMethod = (req) => SAFE_METHODS.includes(String(req?.method || '').toUpperCase());
export { WRITE_SCOPE_PARTIAL_REASON };   // 문구는 auth/scope.js 하나(scopeMerge.denyFleetWrite 와 같은 사유)
/** 쓰기 · 실행 요청을 조회 ∧ 쓰기 전체 범위로 판정(안전 메서드 · 읽기성 POST 예외는 통과). 통과면 null, 막으면 응답 본문. */
function writeScopeDenial(req, { readPost = false } = {}) {
  if (isSafeMethod(req)) return null;
  if (readPost && String(req?.method || '').toUpperCase() === 'POST') return null;
  if (isFullReadWriteScope(req.user, store.get())) return null;
  return { ok: false, error: 'forbidden', reason: WRITE_SCOPE_PARTIAL_REASON, writeScope: 'partial' };
}

/**
 * 전체 범위(vCenter 제한 없는) 계정만 통과(v2.583 — 공용 팩토리). 로그·엣지·토큰처럼 **법인 축으로
 * 나눌 수 없는** 데이터를 주는 라우트가 쓴다. 예전에는 라우트 파일마다 같은 6줄을 복사했다
 * (routes/api 8곳 — 사유 문구만 다르다). 새 라우트는 이것을 쓴다.
 * 6회차 A1: 안전 메서드가 아닌 요청은 쓰기 범위도 전체여야 한다(위 머리말).
 * @param {string} reason  조회 범위 때문에 막을 때의 사유(예전 그대로)
 * @param {{readPost?:boolean}} [opts]  readPost — **본문만 계산하는 읽기성 POST**(저장 0 · 왕복 0 · 저장 비밀 사용 0 · 뒤따르는 쓰기 없이 혼자 쓰이는 진단)만 쓰기 판정에서 뺀다.
 *   예외는 최소로 둔다 — 지금 하나: POST /tools/cvp/parse-preview(docs/rules/security-api.md 6회차 A1 목록). 저장 직전 검증 · 미리보기(rma tests/validate 등)는
 *   그 저장이 어차피 막히므로 예외로 두지 않는다(san-flow/preview 가 v2.935 부터 같은 판정으로 막혀 있는 것과 같다).
 */
export function fullScopeOnlyWith(reason = '이 화면은 전체 범위(vCenter 제한 없는) 계정만 조회할 수 있습니다.', { readPost = false } = {}) {
  const fullScopeGate = (req, res, next) => {
    if (scopedVcenterIds(req.user, store.get())) return res.status(403).json({ ok: false, error: 'forbidden', reason });
    const w = writeScopeDenial(req, { readPost });
    if (w) return res.status(403).json(w);
    next();
  };
  // v2.614(아키텍처 점검): `fleetOnly`·`fleetWideOnly` 류는 전부 이 팩토리의 산물이라 태그 하나로 판정기가 알아본다.
  fullScopeGate.gate = Object.freeze({ kind: 'fullScope', ...(readPost ? { readPost: true } : {}) });
  return fullScopeGate;
}

/**
 * v2.935(C-② 반증 L-1): 조회 **와 쓰기** 모두 전체 범위인 계정만 — 스위치 설정을 바꾸는 라우트(Flow Vision 플로우 · SAN 스위치 등록 · 수집 설정).
 *   `fullScopeOnlyWith` 는 조회 범위만 봐서 writeVcenters 로 쓰기만 줄인 admin 이 지나갔다. 판정은 auth/scope.js isFullReadWriteScope 하나(v2.904 규칙).
 */
export function fullReadWriteScopeOnlyWith(reason = '이 작업은 조회 · 쓰기 모두 전체 범위(vCenter 제한 없는) 계정만 할 수 있습니다.') {
  const fullRwGate = (req, res, next) => {
    if (!isFullReadWriteScope(req.user, store.get())) return res.status(403).json({ ok: false, error: 'forbidden', reason });
    next();
  };
  fullRwGate.gate = Object.freeze({ kind: 'fullScope' });
  return fullRwGate;
}

// '설정 소유 계정(settingsOwners)' 서버측 강제 — 지금까지 소유자 경계는 UI(App.jsx)에서만
// 걸려, 소유자가 아닌 admin이 엔드포인트를 직접 호출하면 소유자 목록을 갈아치우고 소유 계층을
// 탈취할 수 있었다(감사 지적: 클라이언트 전용 접근제어). adminOnly 뒤에 붙여 유효 소유자
// (설정된 소유자 + 중앙 배포 admin)만 통과시킨다. 인증 비활성 시엔 통과(단일 사용자 모드).
// ⚠ 구조적 보안 수정(2026-08-30, 4차 재감사) — 판정은 **username 만**으로 한다.
// 예전에는 `owners.includes(u.name)`(표시이름)도 소유자로 인정했다. 그런데 표시이름은
// `PATCH /admin/users/:u {name}` 으로 **아무 admin 이나 바꿀 수 있는 값**이어서, 비소유자 admin 이
// 자기 표시이름을 소유자 계정명으로 바꾸고 재로그인하면 그대로 소유자가 됐다(실행 재현).
// AD 로그인의 `displayName` 도 같은 축으로 새어 들어왔다(ad.js: name = displayName).
// 근본 원인은 '권한을 이름 문자열로 판정하면서 그 이름을 쓸 수 있는 지점을 하나씩만 막은 것'이라,
// 이름 축을 권한 축에서 **분리**해 이 부류를 끝낸다 — username 은 createUser 시점에 고정되고
// 이후 변경 경로가 없다(rename API 부재).
// 운영 주의: settings-owners.txt·SETTINGS_OWNERS·UI 목록에 **표시이름**을 적어 두었다면 이제
// 소유자로 인정되지 않는다 → 해당 계정의 **로그인 ID**로 바꿔 적어야 한다.
// v2.744(감사 AUTHZ-02): 설정 소유자 등급은 **전 법인 공용**(공유 CENTRAL_TOKEN 평문·전 법인 자격증명이 든 백업의 생성·내려받기·복원·삭제·
//   비밀 정책·세션 보안·메일)이라 **전체 범위 계정만** 통과한다. 예전에는 username 만 봐서 settingsOwners 에 든 범위 관리자
//   (scope.vcenters 가 있는 admin)가 소유자 라우트 35개 중 fullScope 게이트가 없던 16개를 그대로 썼다 — 같은 등급의 형제
//   (개별 엣지 토큰·host-access·API 키·엣지 사용자)는 fleetOnly 로 403 이었다(v2.743 LEFT-09 와 같은 판단의 남은 형제).
//   판정을 여기 두면 새 소유자 라우트도 자동으로 따른다(아키텍처 점검 archScan 도 이 게이트를 전체 범위로 센다).
//   거부 응답은 fullScopeOnlyWith 와 같은 모양({ok,error,reason}) — requiredOwner 를 싣지 않는다(이미 소유자인 계정에
//   '소유자 목록에 등록하라' 는 틀린 조치를 화면이 말하지 않게. 화면은 서버 사유와 함께 '범위' 안내로 그린다).
export const SETTINGS_OWNER_WRITE_SCOPE_REASON = '설정 소유자 등급의 변경은 전 법인 공용이라 쓰기 범위도 전체(vCenter 제한 없는)인 계정만 할 수 있습니다 — 이 계정은 쓰기 범위가 일부 법인으로 제한되어 있습니다.';
export const SETTINGS_OWNER_FULL_SCOPE_REASON = '설정 소유자 등급은 전 법인 공용이라 전체 범위(vCenter 제한 없는) 계정만 쓸 수 있습니다 — 이 계정은 소유자 목록에 있지만 범위가 지정되어 있습니다.';
/**
 * 설정 소유자 **등급** 판정(소유자 ∧ 조회 전체 범위 — v2.744 그대로). 통과면 null, 아니면 403 응답 본문.
 *   라우트 게이트(requireSettingsOwner)와 **등급 질의**(bmOnboard.isOwnerTier — 법인마다 쓰기 범위를 따로 보는 라우트 안의 행 · 창 승인 등급:
 *   8a 정비 창 · 7b 온보딩 묶음 행)가 같은 하나를 쓴다. 등급 질의는 6회차 A1 의 쓰기 범위 판정을 더하지 않는다 — 그 라우트는 대상 법인의 쓰기 범위를
 *   따로 본다(쓰기 vcA 소유자는 vcA 법인 창만 — bmMaint8aRoute 가 고정). 범위 판정이 던지면(스냅샷 이상) 범위 계정으로 본다 — 거부 기본값.
 */
export function settingsOwnerGradeDenial(req) {
  if (!config.auth.enabled) return null;
  let owners = [];
  try { owners = loadSessionSecurity().settingsOwners || []; } catch { owners = []; }
  const u = req?.user || {};
  if (!owners.includes(u.username)) return { ok: false, error: 'forbidden', requiredOwner: true, reason: '설정 소유 계정만 변경할 수 있습니다.' };
  let scoped = true;
  try { scoped = !!scopedVcenterIds(u, store.get()); } catch { scoped = true; }
  if (scoped) return { ok: false, error: 'forbidden', reason: SETTINGS_OWNER_FULL_SCOPE_REASON };
  return null;
}
export function requireSettingsOwner(req, res, next) {
  const g = settingsOwnerGradeDenial(req);
  if (g) return res.status(403).json(g);
  if (!config.auth.enabled) return next();
  // 6회차 A1: 쓰기 · 실행은 쓰기 범위도 전체여야 한다(fullScopeOnlyWith 와 같은 writeScopeDenial — 판정 isFullReadWriteScope 하나 · 던지면 거부).
  //   ⚠ **GET(백업 내려받기 · 상태 · 비밀 정책 조회 등)은 이번에 바꾸지 않았다** — 쓰기 범위가 지정된 소유자에게 전 법인 공용 비밀이 든 조회를 줄지는
  //   사용자 결정 대기(docs/rules/security-api.md 6회차 A1 '결정 대기'). 바꾸면 쓰기 범위 소유자는 소유자 라우트의 GET 도 잃는다.
  const w = writeScopeDenial(req);
  if (w) return res.status(403).json({ ...w, reason: SETTINGS_OWNER_WRITE_SCOPE_REASON });
  return next();
}
requireSettingsOwner.gate = Object.freeze({ kind: 'settingsOwner' }); // v2.614 아키텍처 점검 태그

// 자격증명 디버그 표시용 마스킹 — 평문 비밀번호는 절대 응답에 넣지 않고 길이만 노출한다.
// (계정명/passwordless 여부는 디버그에 유용하므로 유지)
export const maskPw = (p) => (p === '' || p == null) ? '(빈 비번/passwordless)' : `•••• (${String(p).length}자)`;

// 서버 분석 공용 헬퍼는 v2.579 에 `insights/analysisServers.js` 로 옮겼다(ARCH-04 — 도메인 모듈 4곳이
// 이 라우트 파일을 import 하던 방향 위반 제거). 라우트 5곳을 위해 같은 이름을 재수출한다.
export { analysisFilter, hostVcByTag, hostNameByTag, hostNicsByTag, withMappedVc, collectorToDatacenterMap, remoteServersResolved, analysisServersWithRemote, invForServer, ensureCollectorDatacenter };

export function existsFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

