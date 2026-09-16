/**
 * horizon/sessionCollect.js — Horizon 세션 조회(v2.525). 네트워크 경계.
 *
 * 로그인·로그아웃·TLS·SSRF 가드는 `horizon.js withHorizonSession` 하나가 갖는다(복사 금지).
 *
 * ── 페이징 ─────────────────────────────────────────────────────────────────────
 * `GET /rest/inventory/v1/sessions?page=N&size=M` (1-based, `size` 최대 1000 —
 * `horizon-mcp tools/inventory.py:533-556`). 마지막 페이지 판정은 **받은 개수 < size** 로 한다.
 * Horizon 이 `HAS_MORE_RECORDS` 헤더를 준다는 언급이 있으나 이 환경에서 원문을 확인하지 못해
 * **있으면 참고하고 없으면 개수로 판정**한다(있다고 단정하지 않는다).
 * `maxPages` 를 넘기면 **`truncated:true` 로 밝힌다** — 조용히 자르면 '전 세션을 봤다' 는 거짓이 된다.
 *
 * ── 실패를 원인별로 구분한다 ────────────────────────────────────────────────────
 * `auth`(401/403 — 계정·권한) / `no-endpoint`(404 — 이 Horizon 버전이 그 경로를 노출하지 않음)
 * / `http`(그 외 상태코드) / `timeout` / `unparsed`(응답이 배열이 아니거나 계정 필드 없음).
 * 한 문구로 뭉개면 조치가 정반대인 상황을 같은 말로 덮는다(v2.517 규약).
 */
import { withHorizonSession } from './horizon.js';
import { describeError } from '../util/errors.js';
import { normalizeSessions, SESSION_PATH, PAGE_SIZE_MAX } from './sessions.js';

const HAS_MORE_HEADERS = ['has_more_records', 'hasmorerecords', 'x-has-more-records'];

function headerSaysMore(res) {
  for (const h of HAS_MORE_HEADERS) {
    const v = res.headers?.get?.(h);
    if (v != null) return String(v).toLowerCase() === 'true';
  }
  return null;     // 헤더가 없다 — '없음' 을 '더 없음' 으로 읽지 않는다
}

/**
 * 한 Connection Server 의 세션 전량 조회.
 *
 * @returns {{ok:boolean, kind:string, error:string|null, pages:number, truncated:boolean, ms:number, raw:object[]}}
 *          + `normalizeSessions()` 의 모든 필드(성공 시)
 */
export async function collectServerSessions(s, { pageSize = 500, maxPages = 20, maxUsers = 2000, timeoutMs } = {}) {
  const t0 = Date.now();
  const size = Math.max(1, Math.min(PAGE_SIZE_MAX, Math.round(Number(pageSize) || 500)));
  const cap = Math.max(1, Math.round(Number(maxPages) || 20));
  const entry = timeoutMs > 0 ? { ...s, timeoutMs } : s;
  try {
    const out = await withHorizonSession(entry, async (get) => {
      const acc = [];
      let pages = 0;
      let truncated = false;
      for (let page = 1; ; page++) {
        const r = await get(SESSION_PATH, { query: { page: String(page), size: String(size) } });
        if (!r.ok) {
          const e = new Error(`세션 조회 실패 (HTTP ${r.status})`);
          e.httpStatus = r.status;
          throw e;
        }
        const body = await r.json().catch(() => null);
        if (!Array.isArray(body)) {
          const e = new Error('세션 응답이 배열이 아닙니다(형식 미인식).');
          e.kind = 'unparsed';
          throw e;
        }
        acc.push(...body);
        pages = page;
        const more = headerSaysMore(r);
        if (more === false) break;
        if (body.length < size) break;       // 마지막 페이지
        if (page >= cap) { truncated = true; break; }
      }
      return { acc, pages, truncated };
    });
    const norm = normalizeSessions(out.acc, { maxUsers });
    return {
      ok: true,
      kind: norm.parsed ? 'ok' : 'unparsed',
      error: norm.parsed ? null : '세션 응답에서 계정 필드를 찾지 못했습니다(형식 미인식).',
      pages: out.pages, truncated: out.truncated, ms: Date.now() - t0,
      ...norm,
    };
  } catch (e) {
    const d = describeError(e);
    const st = Number(e?.httpStatus) || 0;
    const kind = e?.kind === 'unparsed' ? 'unparsed'
      : st === 401 || st === 403 ? 'auth'
        : st === 404 ? 'no-endpoint'
          : st > 0 ? 'http'
            : /timeout|aborted|timed out/i.test(String(d.message)) ? 'timeout' : 'error';
    return {
      ok: false, kind, error: d.message, hint: d.hint || '',
      pages: 0, truncated: false, ms: Date.now() - t0,
      // ⚠ 실패한 주기의 수치는 **null** 이다 — 0 으로 채우면 '사용자 0명' 이라는 거짓이 된다
      //   (v2.516 실측으로 확인된 유형).
      parsed: false, sessions: null, connected: null, disconnected: null, pending: null,
      users: null, usersConnected: null, names: [], pools: [],
      usersOmitted: 0, poolsOmitted: 0, usedUserKey: null, usedStateKey: null, userIdOnly: false,
    };
  }
}

/** 데모(mock) 모드용 — 없는 세션을 **지어내지 않는다**. 기능이 꺼진 이유를 그대로 돌려준다. */
export function mockSessionResult(s) {
  return {
    ok: false, kind: 'mock', error: '데모(mock) 모드에서는 Horizon 세션을 수집하지 않습니다.',
    pages: 0, truncated: false, ms: 0, parsed: false,
    sessions: null, connected: null, disconnected: null, pending: null,
    users: null, usersConnected: null, names: [], pools: [],
    usersOmitted: 0, poolsOmitted: 0, usedUserKey: null, usedStateKey: null, userIdOnly: false,
    serverId: s?.id || '',
  };
}

export const KIND_LABEL = Object.freeze({
  ok: '정상',
  unparsed: '형식 미인식',
  auth: '인증·권한 거부',
  // v2.535: 인증 실패로 **주기 수집을 멈춘** 상태. 'auth'(이번에 실패)와 구분한다 —
  //   조치가 같아 보여도 사용자가 알아야 할 사실이 다르다(지금은 시도조차 하지 않는다).
  'auth-stopped': '인증 실패 — 주기 수집 정지',
  'no-endpoint': '이 버전에 없는 경로(404)',
  http: '조회 실패(HTTP)',
  timeout: '시한 초과',
  error: '조회 오류',
  mock: '데모 모드',
  disabled: '비활성',
});
