/**
 * 외부 공개 API 인증 미들웨어 (v2.562).
 *
 * ⚠⚠ **기존 scope 판정을 재사용한다 — 복제하지 말 것.** 키의 `vcenters` 를 그대로
 * `user.scope.vcenters` 에 넣어 합성 사용자를 만들면 `auth/scope.js scopedVcenterIds` ·
 * `inUserScope` 가 **손대지 않고** 그대로 걸린다(빈 배열 = 전체라는 기존 의미까지 동일).
 * 여기서 별도 필터를 짜면 두 판정이 갈라져 v2.536 이 기록한 사고("프론트 조건만 있고 서버
 * 집행이 없었다")의 변형이 된다.
 *
 * ⚠⚠ **합성 사용자의 역할은 `viewer` 로 못 박는다.** 공개 API 는 조회 전용이고
 * (`allowlist.js` 가 GET 만 선언한다) 상태변경 라우트는 `requireRole('admin','operator')` 를
 * 요구하므로, viewer 로 두면 **실수로 쓰기 경로에 연결해도 역할에서 막힌다**(방어선 2중).
 * 역할을 넓히지 말 것.
 *
 * ⚠ 실패 사유를 한 문구로 덮지 않는다(v2.517 `perfDiagText` 규약) — 키 없음 / 모르는 키 /
 *   폐기 / 만료 / 분류 없음 / 상한 초과는 **상대 포탈이 할 조치가 전부 다르다**.
 *
 * ⚠ 인증 실패를 감사 로그에 남기되 **키 평문을 남기지 않는다** — 앞 8자 지문만
 *   (`tokenFingerprint`). 키가 로그로 새면 발급의 의미가 없다.
 */

import { verifyApiKey, markUsed, rateAllow, KEY_STATE, publicKey, KEY_PREFIX } from './keys.js';
import { tokenFingerprint } from '../util/tokenFingerprint.js';
import { logAudit } from '../audit.js';
import { clientIp } from '../util/rateLimit.js'; // v2.583: 거부 감사 요약의 출처 키
import { createDenyAuditGate } from '../util/denyAuditGate.js';

/** 키를 읽는 위치 — 헤더 우선. ⚠ 쿼리스트링은 프록시 액세스 로그·브라우저 히스토리에 남는다. */
export function readKey(req) {
  const h = req.get('X-Api-Key');
  if (h) return { key: String(h).trim(), from: 'header' };
  const a = req.get('Authorization') || '';
  const m = /^Bearer\s+(\S+)$/i.exec(a);
  // ⚠ 세션 토큰과 구분한다 — 접두가 없으면 이 경로의 키가 아니다(엉뚱한 값으로 시도하지 않게).
  if (m && m[1].startsWith(KEY_PREFIX)) return { key: m[1], from: 'bearer' };
  return { key: '', from: null };
}

/** 상태 → HTTP·문구. 화면·상대 포탈이 조치를 알 수 있게 **사유를 구분한다**. */
const DENY = Object.freeze({
  [KEY_STATE.UNKNOWN]: { status: 401, code: 'unknown-key', reason: '키를 알 수 없습니다 — 값이 틀렸거나 지워진 키입니다.' },
  [KEY_STATE.REVOKED]: { status: 401, code: 'revoked', reason: '폐기된 키입니다 — 새 키를 발급받아야 합니다(같은 값은 다시 살아나지 않습니다).' },
  [KEY_STATE.EXPIRED]: { status: 401, code: 'expired', reason: '만료된 키입니다 — 설정 › 연동 키에서 만료일을 늘리거나 재발급하세요.' },
  [KEY_STATE.NO_GROUPS]: { status: 403, code: 'no-groups', reason: '이 키에 허용 분류가 없습니다 — 설정 › 연동 키에서 분류를 골라야 합니다.' },
});

/**
 * 미들웨어 팩토리. 통과하면 `req.apiKey`(공개 형태)와 `req.user`(합성 viewer)를 채운다.
 *
 * ⚠ `next()` 로 흘려보내지 않는다 — 이 라우터는 **공개 API 전용**이므로 키가 없으면 401 이다
 *   (세션 사용자에게도 열면 두 인증 경로가 한 라우터에 섞여 판정이 흐려진다).
 */
/**
 * 무인증 거부의 감사 기록 조절(v2.583) — 출처(IP)당 1분에 한 줄. 넘친 건수는 다음에 쓰는 줄에 합친다.
 * 출처 표는 유계(2,000)이고 넘치면 가장 오래된 출처부터 버린다(그 출처의 합친 건수만 사라진다).
 * @returns {{ write: boolean, folded: number }}
 */
const DENY_WINDOW_MS = 60_000;
// v2.583: 게이트 구현은 util/denyAuditGate.js 하나다(로그인 실패·차단도 같은 것을 쓴다 — 검증 에이전트 권고).
const _gate = createDenyAuditGate({ windowMs: DENY_WINDOW_MS });
export function denyAuditGate(ip, now = Date.now()) { return _gate(ip, now); }
export function _resetDenyAuditGate() { _gate.reset(); }

export function apiKeyAuth() {
  return function apiKeyAuthMw(req, res, next) {
    const { key, from } = readKey(req);
    if (!key) {
      return res.status(401).json({ ok: false, error: 'missing-key', code: 'missing-key',
        reason: 'X-Api-Key 헤더가 없습니다. 설정 › 연동 키에서 발급한 값을 넣으세요.' });
    }
    const { state, rec } = verifyApiKey(key);
    if (state !== KEY_STATE.OK) {
      const d = DENY[state] || DENY[KEY_STATE.UNKNOWN];
      /*
       * ⚠ 평문이 아니라 지문만 남긴다. 모르는 키도 지문을 남겨야 '누가 무엇으로 찔렀나' 를 본다.
       * ⚠ 인자명은 `user`·`target`·`detail` 이다(`audit.js:53`) — `actor` 로 쓰면 **조용히 버려진다**.
       */
      // v2.583(감사 확정): 무인증 요청 한 번이 감사 로그 한 줄이라, 한 IP 가 분당 1,800회(전역 레이트리밋)로
      //   **감사 이력 2만 줄을 약 11분에 밀어낼 수 있었다**. 같은 출처는 1분에 한 줄만 쓰고 나머지는 세어 두었다가
      //   다음 줄에 '직전에 요약한 N건' 으로 붙인다(버리지 않고 합친다 — 거부 사실 자체는 남는다).
      const sum = denyAuditGate(clientIp(req));
      if (sum.write) {
        logAudit({
          user: rec?.name ? `apikey:${rec.name}` : '(미상 키)',
          action: 'publicapi.deny',
          target: req.path,
          detail: `${d.code} · ${tokenFingerprint(key)} · from=${from}${sum.folded ? ` · 같은 출처 거부 ${sum.folded}건을 이 줄에 합침(1분 요약)` : ''}`,
        });
      }
      return res.status(d.status).json({ ok: false, error: d.code, code: d.code, reason: d.reason });
    }

    const gate = rateAllow(rec);
    if (!gate.ok) {
      res.set('Retry-After', String(gate.retryAfterSec));
      return res.status(429).json({ ok: false, error: 'rate-limited', code: 'rate-limited',
        reason: `분당 상한(${gate.limit}회)을 넘었습니다. ${gate.retryAfterSec}초 뒤 다시 시도하세요.`,
        limit: gate.limit, retryAfterSec: gate.retryAfterSec });
    }
    res.set('X-RateLimit-Limit', String(gate.limit));
    res.set('X-RateLimit-Remaining', String(gate.remaining));

    markUsed(rec);
    req.apiKey = publicKey(rec);
    /*
     * 합성 사용자 — 기존 scope 판정이 그대로 걸리게 하는 것이 목적이다.
     * ⚠ `role: 'viewer'` 를 넓히지 말 것(위 머리말). `mustEnrollOtp: false` 는 이 경로가
     *   `requireEnrolled` 를 타지 않기 때문에 명시해 두는 것이다(추측 여지를 없앤다).
     */
    req.user = {
      username: `apikey:${rec.name}`,
      role: 'viewer',
      name: rec.name,
      scope: { vcenters: [...(rec.vcenters || [])], writeVcenters: [] },
      mustEnrollOtp: false,
      isApiKey: true,
    };
    // 캐시 금지 — 키별로 범위가 다른데 중간 캐시가 섞으면 남의 법인 데이터가 간다.
    res.set('Cache-Control', 'no-store');
    return next();
  };
}
