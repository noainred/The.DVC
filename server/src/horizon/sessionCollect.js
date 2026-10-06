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
 * `auth`(로그인 단계 401/403 — 계정) / `forbidden`(로그인 뒤 401/403 — 역할 권한, v2.686) /
 * `no-login-endpoint`(로그인 404) / `no-endpoint`(404 — 이 Horizon 버전이 그 경로를 노출하지 않음)
 * / `http`(그 외 상태코드) / `timeout` / `unparsed`(응답이 배열이 아니거나 계정 필드 없음).
 * 한 문구로 뭉개면 조치가 정반대인 상황을 같은 말로 덮는다(v2.517 규약).
 */
import { withHorizonSession } from './horizon.js';
import { describeError } from '../util/errors.js';
import { normalizeSessions, SESSION_PATH, PAGE_SIZE_MAX } from './sessions.js';
import { pushAll } from '../util/pushAll.js';
import { CATALOG_PATHS, normalizeCatalog, usageFromSessions } from './appUsage.js';
import { numOrNull } from '../util/numOrNull.js';
import { readJsonCapped } from '../util/readCapped.js'; // v2.686 SEC-2686-01: 세션·카탈로그 페이지 본문 상한(gzip 해제 후 크기)
import { isDemoEntryId, demoHorizonSessionsRaw, demoHorizonCatalogRaw } from '../mock/demo/users.js'; // v2.708 데모(mock 에서만)
/** 한 페이지 상한 — size 최대 1000 세션 × 수 KB 를 넉넉히 덮는다. 넘으면 그 페이지는 형식 미인식이다. */
const PAGE_MAX_BYTES = 32 * 1_048_576;

/*
 * v2.684 — 앱·데스크톱 이름 카탈로그(앱 풀·데스크톱 풀·팜 목록).
 * 목록은 자주 바뀌지 않는다 — **세션 조회와 같은 로그인 안에서**, 카탈로그가 낡았을 때만(기본 6시간) 읽는다.
 * 새 로그인을 만들지 않는 것이 핵심이다(고RTT 법인에서 로그인 왕복이 곧 비용이고, AD 감사 로그도 늘린다).
 * 읽기에 실패하면 **직전 카탈로그를 지우지 않는다**(한 번의 실패로 이름이 전부 ID 로 바뀌면 그날의 누적이
 * 서비스 둘로 갈라진다). 실패 사유는 그대로 보고한다.
 */
const CATALOG_TTL_MS = (() => { const n = numOrNull(process.env.HZ_CATALOG_TTL_MS); return n != null && n >= 60_000 ? Math.min(n, 7 * 86_400_000) : 6 * 3_600_000; })();
const CATALOG_PAGE = 1000;
const CATALOG_MAX_PAGES = 10;
const _catalogs = new Map();   // serverId -> { at, catalog, counts, usedPaths, errors, truncated }

/** 다시 읽을 때인가 — 성공 뒤에는 TTL, 실패 뒤에는 30분(매 주기 같은 404 를 되풀이하지 않게). */
export const CATALOG_RETRY_MS = 30 * 60_000;
export function catalogDue(prev, now) {
  if (!prev) return true;
  const failed = prev.failedAt && prev.failedAt >= (prev.at || 0);
  return failed ? now - prev.failedAt >= Math.min(CATALOG_RETRY_MS, CATALOG_TTL_MS) : now - (prev.at || 0) >= CATALOG_TTL_MS;
}

export function _resetCatalogsForTest() { _catalogs.clear(); }
export function catalogInfo(serverId) {
  const c = _catalogs.get(String(serverId || ''));
  return c ? { at: c.at, failedAt: c.failedAt || null, counts: c.counts, usedPaths: c.usedPaths, errors: c.errors, truncated: c.truncated } : null;
}

async function fetchCatalog(get) {
  const raw = { apps: [], desktops: [], farms: [] };
  const usedPaths = {}; const errors = {}; const truncated = {};
  const KIND_FIELD = { app: 'apps', desktop: 'desktops', farm: 'farms' };
  for (const [kind, paths] of Object.entries(CATALOG_PATHS)) {
    for (const p of paths) {
      const acc = [];
      let status = 0; let bad = false;
      for (let page = 1; page <= CATALOG_MAX_PAGES; page++) {
        const r = await get(p, { query: { page: String(page), size: String(CATALOG_PAGE) } });
        if (!r.ok) { status = r.status; break; }
        const body = await readJsonCapped(r, PAGE_MAX_BYTES, 'Horizon 응답').catch(() => null);
        if (!Array.isArray(body)) { bad = true; break; }
        pushAll(acc, body);
        if (body.length < CATALOG_PAGE) break;
        if (page === CATALOG_MAX_PAGES) truncated[kind] = true;
      }
      if (status === 404) { errors[kind] = `${p}: 404`; continue; }   // 이 버전에 없는 경로 — 다음 후보
      if (status) { errors[kind] = `${p}: HTTP ${status}`; break; }
      if (bad) { errors[kind] = `${p}: 응답이 배열이 아닙니다`; break; }
      raw[KIND_FIELD[kind]] = acc; usedPaths[kind] = p; delete errors[kind];
      break;
    }
  }
  return { raw, usedPaths, errors, truncated };
}

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
export async function collectServerSessions(s, { pageSize = 500, maxPages = 20, maxUsers = 2000, timeoutMs, catalog = true, now = Date.now() } = {}) {
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
        const body = await readJsonCapped(r, PAGE_MAX_BYTES, 'Horizon 응답').catch(() => null);
        if (!Array.isArray(body)) {
          const e = new Error('세션 응답이 배열이 아닙니다(형식 미인식).');
          e.kind = 'unparsed';
          throw e;
        }
        pushAll(acc, body);
        pages = page;
        const more = headerSaysMore(r);
        if (more === false) break;
        if (body.length < size) break;       // 마지막 페이지
        if (page >= cap) { truncated = true; break; }
      }
      // 카탈로그 — 같은 로그인 안에서, 낡았을 때만. 실패해도 세션 결과는 그대로 쓴다(이름만 ID 로 남는다).
      const sid = String(s.id || '');
      const prev = _catalogs.get(sid);
      if (catalog && catalogDue(prev, now)) {
        try {
          const c = await fetchCatalog(get);
          const got = Object.keys(c.usedPaths).length > 0;
          if (got || !prev) {
            // 일부 종류만 읽었으면 못 읽은 종류는 직전 값을 이어 쓴다(지우지 않는다).
            const merged = { apps: c.raw.apps, desktops: c.raw.desktops, farms: c.raw.farms };
            if (prev?.raw) for (const [k, f] of [['app', 'apps'], ['desktop', 'desktops'], ['farm', 'farms']]) if (!c.usedPaths[k]) merged[f] = prev.raw[f] || [];
            const norm = normalizeCatalog(merged);
            _catalogs.set(sid, { at: now, raw: merged, catalog: norm, counts: norm.counts, usedPaths: c.usedPaths, errors: c.errors, truncated: c.truncated });
          } else {
            _catalogs.set(sid, { ...prev, errors: c.errors, failedAt: now });
          }
        } catch (e) {
          if (prev) _catalogs.set(sid, { ...prev, errors: { all: String(e?.message || e).slice(0, 200) }, failedAt: now });
          else _catalogs.set(sid, { at: 0, failedAt: now, raw: null, catalog: normalizeCatalog({}), counts: { apps: 0, desktops: 0, farms: 0 }, usedPaths: {}, errors: { all: String(e?.message || e).slice(0, 200) }, truncated: {} });
        }
      }
      return { acc, pages, truncated };
    });
    const norm = normalizeSessions(out.acc, { maxUsers });
    const cat = _catalogs.get(String(s.id || ''));
    const usage = norm.parsed ? usageFromSessions(out.acc, { usedUserKey: norm.usedUserKey, usedStateKey: norm.usedStateKey, catalog: cat?.catalog }) : null;
    return {
      ok: true,
      kind: norm.parsed ? 'ok' : 'unparsed',
      error: norm.parsed ? null : '세션 응답에서 계정 필드를 찾지 못했습니다(형식 미인식).',
      pages: out.pages, truncated: out.truncated, ms: Date.now() - t0,
      ...norm,
      usage,
      catalog: catalogInfo(s.id),
    };
  } catch (e) {
    const d = describeError(e);
    const st = Number(e?.httpStatus) || 0;
    // v2.686 HZT-06·HZ-07: '자격증명 거부(auth)' 는 **로그인 단계**의 401/403 뿐이다. 로그인은 성공했는데 세션
    //   조회가 403 이면 계정이 아니라 역할 권한 문제다 — 'auth' 로 두면 authGuard 가 주기 수집을 멈추고 '비밀번호를
    //   고치면 재개' 라는 틀린 조치를 말한다. 로그인 자체가 404 면 '세션 경로가 없다' 가 아니라 로그인 API 가 없다.
    const atLogin = e?.phase === 'login';
    const kind = e?.kind === 'unparsed' ? 'unparsed'
      : e?.kind === 'no-token' ? 'no-token'
        : atLogin && (st === 401 || st === 403) ? 'auth'
          : atLogin && st === 404 ? 'no-login-endpoint'
            : st === 401 || st === 403 ? 'forbidden'
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

/**
 * 데모(mock) 모드용(v2.708) — 커넥션 서버에 **접속하지 않고** 합성 세션으로 수집 성공 결과를 만든다.
 * 세션 해석·누적 쌍은 실수집과 **같은 순수 함수**(normalizeSessions·usageFromSessions·normalizeCatalog)를 거친다 —
 * 판정을 복제하지 않는다. 데모 등록(`mock-` id)이 아닌 실등록 서버에는 예전처럼 '데모 모드' 로 답한다(지어내지 않는다).
 */
export function mockSessionResult(s, { maxUsers = 2000, now = Date.now() } = {}) {
  if (!isDemoEntryId(s?.id)) {
    return {
      ok: false, kind: 'mock', error: '데모(mock) 모드에서는 Horizon 세션을 수집하지 않습니다.',
      pages: 0, truncated: false, ms: 0, parsed: false,
      sessions: null, connected: null, disconnected: null, pending: null,
      users: null, usersConnected: null, names: [], pools: [],
      usersOmitted: 0, poolsOmitted: 0, usedUserKey: null, usedStateKey: null, userIdOnly: false,
      serverId: s?.id || '',
    };
  }
  const sid = String(s.id);
  const raw = demoHorizonSessionsRaw(sid, now);
  if (catalogDue(_catalogs.get(sid), now)) {
    const merged = demoHorizonCatalogRaw();
    const norm = normalizeCatalog(merged);
    _catalogs.set(sid, { at: now, raw: merged, catalog: norm, counts: norm.counts, usedPaths: { app: CATALOG_PATHS.app[0], desktop: CATALOG_PATHS.desktop[0], farm: CATALOG_PATHS.farm[0] }, errors: {}, truncated: {} });
  }
  const norm = normalizeSessions(raw, { maxUsers });
  const usage = usageFromSessions(raw, { usedUserKey: norm.usedUserKey, usedStateKey: norm.usedStateKey, catalog: _catalogs.get(sid)?.catalog });
  return {
    ok: true, kind: 'ok', error: null, pages: 1, truncated: false, ms: 5 + (raw.length % 40), demo: true,
    ...norm, usage, catalog: catalogInfo(sid), serverId: sid,
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
  // v2.686: 로그인 뒤 권한 부족 · 로그인 API 없음 · 로그인 응답에 토큰 없음 — 셋 다 '자격증명 거부' 가 아니다.
  forbidden: '권한 부족(로그인은 성공)',
  'no-login-endpoint': '로그인 API 없음(404)',
  'no-token': '로그인 응답 형식 미인식',
  http: '조회 실패(HTTP)',
  timeout: '시한 초과',
  error: '조회 오류',
  mock: '데모 모드',
  disabled: '비활성',
});
