// routes/admin 공용 — admin.js(구 2,410줄) 분할(v2.285.0)로 이동. 본문은 원본 그대로.
// adminOnly·requireSettingsOwner 미들웨어와 다중 도메인 헬퍼만 여기 둔다.
import fs from 'node:fs';
import { config } from '../../config.js';
import { requireRole } from '../../auth/auth.js';
import { loadSessionSecurity } from '../../security/securitySettings.js';
import { scopedVcenterIds } from '../../auth/scope.js';
import { store } from '../../store.js';
import { analysisFilter, hostVcByTag, hostNameByTag, hostNicsByTag, withMappedVc, collectorToDatacenterMap, remoteServersResolved, analysisServersWithRemote, invForServer, ensureCollectorDatacenter } from '../../insights/analysisServers.js'; // v2.579: 재수출용


export const adminOnly = requireRole('admin');

/**
 * 전체 범위(vCenter 제한 없는) 계정만 통과(v2.583 — 공용 팩토리). 로그·엣지·토큰처럼 **법인 축으로
 * 나눌 수 없는** 데이터를 주는 라우트가 쓴다. 예전에는 라우트 파일마다 같은 6줄을 복사했다
 * (routes/api 8곳 — 사유 문구만 다르다). 새 라우트는 이것을 쓴다.
 */
export function fullScopeOnlyWith(reason = '이 화면은 전체 범위(vCenter 제한 없는) 계정만 조회할 수 있습니다.') {
  const fullScopeGate = (req, res, next) => {
    if (scopedVcenterIds(req.user, store.get())) return res.status(403).json({ ok: false, error: 'forbidden', reason });
    next();
  };
  // v2.614(아키텍처 점검): `fleetOnly`·`fleetWideOnly` 류는 전부 이 팩토리의 산물이라 태그 하나로 판정기가 알아본다.
  fullScopeGate.gate = Object.freeze({ kind: 'fullScope' });
  return fullScopeGate;
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
export function requireSettingsOwner(req, res, next) {
  if (!config.auth.enabled) return next();
  let owners = [];
  try { owners = loadSessionSecurity().settingsOwners || []; } catch { owners = []; }
  const u = req.user || {};
  if (owners.includes(u.username)) return next();
  return res.status(403).json({ ok: false, error: 'forbidden', requiredOwner: true, reason: '설정 소유 계정만 변경할 수 있습니다.' });
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

