import { Router } from 'express';
import { config } from '../config.js';
import { authenticate, signToken, verifyToken, authMiddleware, requireEnrolled, requireRole, getUser, beginTotpEnroll, confirmTotpEnroll, setupState } from '../auth/auth.js';
import { rolePermissions, roleToolsDenied, effectiveToolAccess } from '../auth/permissions.js';
import { loadAdConfig, saveAdConfig, testAd } from '../auth/ad.js';
import { requireSettingsOwner } from './admin/shared.js';
import { logAudit } from '../audit.js';
import { recordPortalLoginFail } from '../security/loginStore.js';
import { loadSessionSecurity, singleSessionRequired } from '../security/securitySettings.js';
import { newSessionId, setActiveSession } from '../auth/sessions.js';
import { checkLoginAllowed, recordLoginFailure, recordLoginSuccess } from '../security/loginRateLimit.js';
import { wrapAsyncRouter } from '../util/asyncRoute.js';
import { clientIp } from '../util/rateLimit.js';   // v2.503: 잠금 출발지 판정을 전역 레이트리밋과 통일(trust proxy 규약)

export const authRouter = Router();
// v2.574 BUG-03: express 4 는 async 핸들러의 throw 를 잡지 않아 그 요청이 **응답 없이
// 매달린다**(소켓 fd 가 잡힌다). 라우트를 등록하기 **전에** 감싸 전역 에러 핸들러로 보낸다.
// ⚠ 라우트 등록보다 아래로 옮기지 말 것 — 그 뒤에 등록된 것만 보호된다.
wrapAsyncRouter(authRouter);

// Whether auth is required at all, and whether AD login is enabled (UI hint).
// 유휴 자동 로그아웃 설정도 함께 내려 클라이언트가 그 시간으로 타이머를 건다(비밀 아님).
authRouter.get('/config', (_req, res) => {
  const ad = loadAdConfig();
  const sec = loadSessionSecurity();
  // setupState: 초기 구축 중이면 로그인 화면이 '최초 관리자 비밀번호 파일 경로'를 안내한다
  // (비밀번호 값이 아니라 경로만 — 이미 문서에 공개된 고정 위치).
  // ⚠ settingsOwners(설정 소유 '계정명' 목록)는 여기에 싣지 않는다 — 미인증 응답이라
  // 공격자에게 유효 관정 계정명을 알려주는 열거 단서가 된다(감사 C1 후속). 프론트의 '설정' 탭
  // 노출 판단은 인증 후 /auth/me 의 isSettingsOwner 불리언을 쓴다(서버는 requireSettingsOwner 로 강제).
  res.json({
    authEnabled: config.auth.enabled, adEnabled: Boolean(ad.enabled && ad.url),
    idleLogoutEnabled: sec.idleLogoutEnabled, idleLogoutMin: sec.idleLogoutMin,
    // 세션 만료 경고·연장(v2.428) — 값 자체는 비밀이 아니고, 클라이언트가 이 값으로 경고 타이머를
    // 건다. 실제 만료 판정은 서버(토큰 exp)가 소유하므로 클라이언트가 이 값을 조작해도
    // 세션이 길어지지 않는다(경고를 늦게 볼 뿐).
    sessionWarnEnabled: sec.sessionWarnEnabled, sessionWarnMin: sec.sessionWarnMin,
    sessionExtendMin: sec.sessionExtendMin, sessionMaxHours: sec.sessionMaxHours,
    ...setupState(),
  });
});

authRouter.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  // 문자열만 허용 — 객체/배열이 오면 String() 강제변환으로 "[object Object]" 같은 값이 인증에
  // 쓰이는 사고를 막는다(특수문자 자체는 어떤 것이든 그대로 통과).
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }
  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().split(',')[0];
  // 잠금 키의 출발지는 `clientIp(req)` 로 정한다(v2.503, 감사 S2): **`trust proxy` 가 설정된
  // 배포에서만** XFF 기반 `req.ip` 를 쓰고, 아니면 실제 peer 를 쓴다 — XFF 를 무조건 믿으면
  // 스푸핑으로 잠금을 무력화할 수 있고, 반대로 peer 로 고정하면 리버스 프록시 뒤에서 **전 사용자가
  // 한 키를 공유**해 v2.500 의 계정 무관 카운터가 전체 로그인 잠금으로 번진다.
  // 전역 레이트리밋(util/rateLimit.js)과 같은 규약을 쓴다(v2.428 에서 같은 결함을 고쳤다).
  // 감사 로그에는 XFF 원문(`ip`)을 그대로 남긴다.
  const gateIp = clientIp(req);

  // 무차별 대입 방어: peer+계정 잠금 상태면 인증 시도 자체를 막는다.
  const gate = checkLoginAllowed(gateIp, username);
  if (gate.blocked) {
    logAudit({ user: username, action: '로그인 차단(잠금)', detail: `${gate.retryAfterSec}s`, ip });
    return res.status(429).set('Retry-After', String(gate.retryAfterSec))
      .json({ error: `로그인 시도가 일시적으로 잠겼습니다. ${gate.retryAfterSec}초 후 다시 시도하세요.` });
  }

  const user = await authenticate(username, password);
  if (!user) {
    const lk = recordLoginFailure(gateIp, username);
    logAudit({ user: username, action: lk.locked ? '로그인 실패(잠금 발동)' : '로그인 실패', ip });
    try { recordPortalLoginFail({ username, ip, reason: 'invalid credentials' }); } catch { /* */ }
    if (lk.locked) {
      return res.status(429).set('Retry-After', String(lk.retryAfterSec))
        .json({ error: `로그인 실패가 많아 일시적으로 잠겼습니다. ${lk.retryAfterSec}초 후 다시 시도하세요.` });
    }
    return res.status(401).json({ error: 'invalid credentials' });
  }

  recordLoginSuccess(gateIp, username);
  // 로컬 계정 토큰에는 src/tv(tokenVersion)를 실어 서버측 폐기(비번/역할 변경 시 즉시 무효)를
  // 가능하게 한다(감사 M5). AD 계정은 로컬 레코드가 없어 다음 로그인 시점에 역할이 반영된다.
  const local = user.source === 'local' ? getUser(user.username) : null;
  // 단일 세션 강제(ID 공유 금지, v2.280) — 강제 대상이면 이 로그인에 새 세션 ID(sid)를 발급해 토큰에
  // 싣고 계정의 활성 세션으로 등록한다. 이 등록이 같은 계정의 이전 세션 sid 를 덮어써(최신 로그인
  // 우선) 이전 토큰이 resolveTokenUser 에서 무효가 된다. 아니면 sid 를 싣지 않는다(다중 세션 허용).
  // v2.294: 판정은 singleSessionRequired 하나로(resolveTokenUser 와 동일 함수 — 발급/검사 쌍 유지).
  // 내장 데모 계정(local.demo)은 '설정 › 세션 보안'의 Demo 중복 접속 모드에 따라 전역과 독립 판정:
  // 'allow'=중복 허용(전역 단일세션이어도 sid 미발급·미검사), 'single'=데모만 단일 세션, 미설정=전역 따름.
  const sid = singleSessionRequired(!!local?.demo) ? newSessionId() : null;
  const token = signToken({ sub: user.username, role: user.role, name: user.name, ...(local ? { src: 'local', tv: local.tokenVersion || 0 } : {}), ...(sid ? { sid } : {}) });
  if (sid) setActiveSession(user.username, sid, { at: Date.now(), ip });
  logAudit({ user: user.username, action: '로그인', detail: `${user.role}${sid ? ' · 단일세션' : ''}${user.mustEnrollOtp ? ' · OTP 등록 필요(등록 전용 세션)' : ''}`, ip });
  // 로그인 직후에도 프론트가 메뉴를 바로 게이팅할 수 있게 권한/scope 를 함께 내려준다.
  // mustEnrollOtp 이면 프론트는 OTP 등록 화면에 고정된다(서버도 requireEnrolled 로 차단).
  const owners = (() => { try { return loadSessionSecurity().settingsOwners || []; } catch { return []; } })();
  const enriched = {
    ...user,
    permissions: rolePermissions(user.role),
    /*
     * ⚠⚠ **사용자 재정의를 반영한 유효값**이다(v2.555). `roleToolsDenied(role)` 로 되돌리면
     *   '이 사용자만 스토리지' 설정이 화면에 반영되지 않아 **숨겨야 할 메뉴가 그대로 보인다**.
     *   `toolsAllowed` 가 배열이면 **그 목록만** 허용이라는 뜻이고(웹 `toolAllowed` 가 그렇게
     *   판정한다), `null` 이면 기존 거부목록 방식이다 — 서버가 전체 도구 목록을 **추측하지
     *   않는다**(추측하면 새로 추가된 도구가 조용히 새어 나간다).
     */
    ...toolFields(user),
    // username 만으로 판정 — 표시이름(name)은 admin 이 변경 가능한 값이라 권한 축에서 제외한다
    // (routes/admin/shared.js requireSettingsOwner 주석 참고: 4차 재감사에서 승계 우회 재현).
    isSettingsOwner: !config.auth.enabled || owners.includes(user.username),
    // 서비스 허브 주소는 인증 후에만 — 미인증 응답에 내부 호스트를 노출하지 않는다.
    serviceHubUrl: config.serviceHubUrl || '',
    scope: (local && local.scope) ? { vcenters: local.scope.vcenters || [], regions: local.scope.regions || [] } : { vcenters: [], regions: [] },
  };
  res.json({ token, user: enriched });
});

/**
 * 응답에 싣는 도구 접근 필드(v2.555) — **한 곳에서 만든다**. 로그인과 `/auth/me` 가 각자
 * 만들면 한쪽만 고쳐져 '로그인 직후에는 숨는데 새로고침하면 보인다' 같은 상태가 생긴다.
 */
function toolFields(user) {
  const a = effectiveToolAccess({ username: user?.username, role: user?.role });
  return {
    toolsDenied: a.denied,
    // ⚠ `allowed` 가 `null` 이면 키를 **빈 배열로 두지 말 것** — 웹이 '전부 차단' 으로 읽는다.
    toolsAllowed: Array.isArray(a.allowed) ? a.allowed : null,
    toolMode: a.mode,
  };
}

// Returns the current user when a valid token is presented.
authRouter.get('/me', authMiddleware, (req, res) => {
  const u = getUser(req.user.username);
  // permissions: 현재 매트릭스 기준 '내 기능 권한'(프론트 메뉴/버튼 게이팅용, 매 조회 시 최신 반영).
  // scope: 볼 수 있는 vCenter/리전 제한(빈 배열 = 전체).
  // isSettingsOwner: '설정' 탭 노출 여부(계정명 목록 대신 불리언만 — 열거 단서 제거).
  const owners = (() => { try { return loadSessionSecurity().settingsOwners || []; } catch { return []; } })();
  const isSettingsOwner = !config.auth.enabled || owners.includes(req.user.username); // username 만(위 주석 참고)
  res.json({ user: { ...req.user, totpEnabled: !!u?.totpEnabled, local: !!u, permissions: rolePermissions(req.user.role), ...toolFields(req.user), isSettingsOwner, serviceHubUrl: config.serviceHubUrl || '' } });
});

/**
 * 세션 연장(v2.428) — "계속 사용 중입니다" 클릭.
 *
 * 왜 필요한가: 토큰 수명(AUTH_TOKEN_TTL, 기본 8시간)이 끝나면 작업 중이어도 예고 없이 로그아웃된다.
 * 만료 N분 전에 물어보고, 사용자가 확인하면 만료를 M분 미룬 **새 토큰**을 발급한다.
 *
 * 보안 경계(되돌리지 말 것):
 *  1. **경고 창 안에서만 허용**한다. 아니면 클라이언트가 로그인 직후부터 연장을 반복 호출해
 *     만료를 무한정 밀어 올릴 수 있다(정책 무력화). 창 밖 호출은 409 로 거절한다.
 *  2. 새 만료는 `지금 + M분`이 아니라 **`기존 만료 + M분`**이다. 사용자가 이해하는 '연장'이
 *     그것이고, 지금 기준으로 잡으면 경고 시점(만료 10분 전)에 눌렀을 때 실제로는 50분만 늘어난다.
 *  3. `sessionMaxHours`(0=무제한)로 **로그인 시각(iat) 기준 총 상한**을 강제한다. 상한에 걸리면
 *     그 지점까지만 늘리고 `capped:true` 를 알린다(조용히 무시하지 않는다).
 *  4. 페이로드는 원본 토큰의 클레임을 그대로 승계한다 — 특히 `sid`(단일 세션)와 `tv`(토큰 버전).
 *     여기서 새 sid 를 발급하면 다른 기기의 세션을 밀어내고, tv 를 빼면 폐기된 토큰이 되살아난다.
 *     role/name 도 토큰이 아니라 resolveTokenUser 가 매 요청 레코드에서 다시 읽으므로 승계로 충분하다.
 */
authRouter.post('/extend', authMiddleware, (req, res) => {
  if (!config.auth.enabled) return res.json({ ok: true, disabled: true }); // 인증 off면 만료 개념이 없다
  const raw = (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const payload = raw && verifyToken(raw);
  if (!payload || !payload.exp) return res.status(401).json({ ok: false, reason: '토큰이 유효하지 않습니다.' });

  const sec = loadSessionSecurity();
  if (!sec.sessionWarnEnabled) return res.status(409).json({ ok: false, reason: '세션 연장이 비활성화되어 있습니다.' });

  const now = Math.floor(Date.now() / 1000);
  const warnSec = Math.max(1, Number(sec.sessionWarnMin) || 10) * 60;
  const extendSec = Math.max(1, Number(sec.sessionExtendMin) || 60) * 60;

  // (1) 경고 창 밖 호출 거절 — 무한 연장 차단.
  if (payload.exp - now > warnSec) {
    return res.status(409).json({
      ok: false, reason: '아직 연장할 수 없습니다(만료 임박 시에만 연장 가능).',
      expiresAt: payload.exp * 1000, warnMin: sec.sessionWarnMin,
    });
  }

  // (2) 기존 만료 기준으로 연장. (3) 총 상한이 있으면 그 지점까지만.
  let nextExp = payload.exp + extendSec;
  let capped = false;
  const maxH = Number(sec.sessionMaxHours) || 0;
  if (maxH > 0) {
    const hardLimit = (Number(payload.iat) || now) + maxH * 3600;
    if (nextExp > hardLimit) { nextExp = hardLimit; capped = true; }
    if (nextExp <= now) {
      return res.status(409).json({ ok: false, reason: `세션 총 상한(${maxH}시간)에 도달해 더 연장할 수 없습니다. 다시 로그인하세요.`, capped: true });
    }
  }

  // (4) 클레임 승계 — sid/tv 를 반드시 유지한다.
  const { sub, role, name, src, tv, sid } = payload;
  const token = signToken(
    { sub, role, name, ...(src ? { src, tv } : {}), ...(sid ? { sid } : {}) },
    { exp: nextExp },
  );
  logAudit({ user: req.user?.username, action: '세션 연장', target: `${sec.sessionExtendMin}분`, detail: capped ? `총 상한(${maxH}h)까지만 연장` : `만료 ${new Date(nextExp * 1000).toISOString()}` });
  res.json({ ok: true, token, expiresAt: nextExp * 1000, extendedMin: sec.sessionExtendMin, capped });
});

// Self-service TOTP (Google Authenticator) enrollment for the current local user.
// actor = 대상과 동일(본인) → totpRebindDenied 통과. 수퍼관리자의 폰 교체 재등록 경로다.
authRouter.post('/totp/begin', authMiddleware, (req, res) => {
  if (!getUser(req.user.username)) return res.status(400).json({ ok: false, reason: '로컬 계정만 OTP를 등록할 수 있습니다. (AD 계정 제외)' });
  res.json(beginTotpEnroll(req.user.username, req.get('host') || '', { actor: req.user.username }));
});
authRouter.post('/totp/confirm', authMiddleware, (req, res) => {
  const r = confirmTotpEnroll(req.user.username, (req.body || {}).code, { actor: req.user.username });
  res.status(r.ok ? 200 : 400).json(r);
});

// --- Active Directory configuration, admin only ---
// requireEnrolled 필수(v2.322 보안 감사): authRouter 는 index.js 에서 requireEnrolled 없이
// mount 되므로(로그인/공개용), 이 admin 라우트들이 게이트 밖에 있으면 OTP 미등록(부트스트랩)
// admin 세션이 AD 설정을 바꿔 자기 LDAP 를 admin 그룹으로 응답시켜 OTP 우회 admin 경로를 만들 수
// 있다. requireEnrolled 를 넣어 등록 전 세션은 /auth/{me,totp/*} 외 이 라우트에 못 오게 한다.
const adminOnly = [authMiddleware, requireEnrolled, requireRole('admin')];

authRouter.get('/ad-config', ...adminOnly, (_req, res) => {
  res.json({ ad: loadAdConfig() });
});

// ⚠ 변경은 requireSettingsOwner 다(4차 재감사). AD 설정을 바꿀 수 있으면 자기가 통제하는 LDAP 를
// 지정해 응답 속성(그룹·displayName)을 임의로 만들 수 있다 — 그룹으로 admin 승격은 위 주석의
// OTP 우회 벡터이고, displayName 으로는 소유자 이름 위장 경로였다(권한 축을 username 으로
// 단일화해 후자는 닫혔지만, 인증 소스 자체를 바꾸는 권능은 소유자 등급이 맞다).
authRouter.put('/ad-config', ...adminOnly, requireSettingsOwner, (req, res) => {
  res.json({ ok: true, ad: saveAdConfig(req.body || {}) });
});

// Test connectivity / a sample login. Body: { config?, username?, password? }
authRouter.post('/ad-test', ...adminOnly, async (req, res) => {
  const { config: cfg, username, password } = req.body || {};
  res.json(await testAd(cfg, username, password));
});
