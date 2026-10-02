/**
 * horizon/featureProbe.js — Horizon 연결 테스트의 '기능별 경로 확인'(v2.686).
 *
 * 왜 있나(사용자 신고 2026-10-02, 실장비 Connection Server 7.13.1):
 *  · v2.685 연결 테스트는 **라이선스 경로 하나만** 조회해 놓고 "실시간 사용자·앱별 사용 수집은 이 등록으로
 *    동작할 수 있습니다" 라고 말했다. 사용자가 같은 로그인 토큰으로 curl 을 돌려 보니 그 서버에서
 *    `/rest/inventory/v1/sessions`·`/rest/inventory/v1/application-pools`·`/rest/config/v1/licenses` 가
 *    전부 **404** 였다 — 실시간 사용자 수집은 동작할 수 없는 서버였다(확인하지 않은 주장이 틀렸다).
 *  · 같은 화면이 버전(7.13.1)을 이미 읽어 놓고 "버전을 확인하고 UAG·로드밸런서 주소인지 확인하세요" 라고
 *    말했다. 커넥션 서버 정보 API 가 같은 로그인으로 응답했으면 그 주소는 커넥션 서버다 — 근거가 있는데
 *    엉뚱한 조치를 안내했다.
 *
 * 규칙:
 *  1. **같은 로그인 한 번 안에서** 기능마다 가장 작은 조회(`page=1&size=1`)를 한 번씩 한다 — 새 로그인 없음.
 *  2. 성공은 '2xx' 가 아니라 **2xx + JSON(배열을 기대하면 배열)** 이다. 사용자 브라우저 실측: 토큰 없는 요청은
 *     없는 경로에도 200 + HTML(509B)을 돌려준다 — 상태코드만 보면 없는 경로를 '있다' 고 말한다.
 *  3. 후보 경로는 **404 일 때만** 다음 후보로 넘어간다(`sessionCollect.js fetchCatalog` 와 같은 규칙).
 *     시도한 경로는 전부 `attempts` 에 남긴다(마지막 시도만 보고하면 앞 경로의 403 이 가려진다).
 *  4. 사용자 실측으로 확인한 사실: 토큰을 붙인 요청은 없는 경로(`/rest/inventory/v1/zzz`)에
 *     **404 application/json** 을 준다 → 인증된 404 는 '그 서버에 그 API 가 없다' 로 읽어도 된다.
 *  5. ⚠ 최소 버전 숫자를 지어내지 않는다 — v2.685 의 '8 2006 이상 필요' 는 근거가 없었다
 *     (경로 근거는 공개 코드 horizon-mcp 의 2512~2606 검증뿐이다). 대신 그 서버에서 관측한 결과를 말한다.
 */

import { SESSION_PATH } from './sessions.js';
import { CATALOG_PATHS } from './appUsage.js';
import { readJsonCapped } from '../util/readCapped.js';
import { describeError } from '../util/errors.js';

/** 라이선스 조회 경로(Horizon REST — 공개 코드 horizon-mcp 가 2512~2606 에서 확인한 경로). */
export const LICENSE_PATH = '/rest/config/v1/licenses';

/**
 * 커넥션 서버 정보(버전) 후보 — 404 일 때만 다음으로.
 * 실측(사용자 curl, 7.13.1): `/rest/monitor/v1/connection-servers` 404 · `/rest/monitor/connection-servers` 200 ·
 * `/rest/config/v1/connection-servers` 404. 그래서 v1 이 없는 경로가 7.x 에서 쓰인다.
 */
export const PROBE_PATHS = Object.freeze(['/rest/monitor/v1/connection-servers', '/rest/monitor/connection-servers', '/rest/config/v1/connection-servers']);

/** 응답 본문 상한 — 모든 조회가 size=1 이거나 작은 목록이라 1MB 면 넉넉하다(넘으면 '형식 미인식'). */
const PROBE_MAX_BYTES = 1_048_576;

/**
 * 기능 목록 — 화면이 이 순서로 줄을 그린다. `uses` 는 그 경로를 쓰는 포탈 기능(문구용).
 * ⚠ 경로는 실제 수집기가 쓰는 상수를 그대로 가져온다(복제하면 테스트가 확인한 경로와 수집 경로가 갈라진다).
 */
export const FEATURES = Object.freeze([
  Object.freeze({ key: 'license', label: '라이선스 만료일', paths: Object.freeze([LICENSE_PATH]), query: null, expect: 'any' }),
  Object.freeze({ key: 'sessions', label: '실시간 사용자(세션)', paths: Object.freeze([SESSION_PATH]), query: Object.freeze({ page: '1', size: '1' }), expect: 'array' }),
  Object.freeze({ key: 'apps', label: '앱 목록(앱 풀)', paths: CATALOG_PATHS.app, query: Object.freeze({ page: '1', size: '1' }), expect: 'array' }),
  Object.freeze({ key: 'desktops', label: '데스크톱 풀', paths: CATALOG_PATHS.desktop, query: Object.freeze({ page: '1', size: '1' }), expect: 'array' }),
  Object.freeze({ key: 'farms', label: '팜', paths: CATALOG_PATHS.farm, query: Object.freeze({ page: '1', size: '1' }), expect: 'array' }),
]);

/** 조회 결과 종류 — 웹 `horizonAdminText.js FEATURE_KIND_TEXT` 와 1:1(테스트가 대조). */
export const PROBE_KINDS = Object.freeze(['ok', 'not-found', 'forbidden', 'unauthorized', 'unparsed', 'http', 'timeout', 'error']);

function errKind(e) {
  const m = String(describeError(e).message || e?.message || '');
  return /timeout|aborted|timed out/i.test(m) ? 'timeout' : 'error';
}

/** 응답 하나를 판정한다. 본문은 성공일 때만 읽고 실패면 버린다(소켓을 붙잡지 않게). */
export async function classifyResponse(res, expect = 'any') {
  const status = Number(res?.status) || 0;
  if (!res?.ok) {
    try { await res?.body?.cancel?.(); } catch { /* 이미 닫힘 */ }
    const kind = status === 404 ? 'not-found' : status === 403 ? 'forbidden' : status === 401 ? 'unauthorized' : 'http';
    return { status, kind };
  }
  let body;
  try { body = await readJsonCapped(res, PROBE_MAX_BYTES, 'Horizon 응답'); } catch { body = undefined; }
  if (body === undefined || body === null) return { status, kind: 'unparsed', detail: 'JSON 이 아닌 응답(HTML 등)' };
  if (expect === 'array' && !Array.isArray(body)) return { status, kind: 'unparsed', detail: '배열이 아닌 응답' };
  return { status, kind: 'ok', body, count: Array.isArray(body) ? body.length : null };
}

/**
 * 후보 경로를 차례로 조회한다(404 일 때만 다음). 예외는 삼키지 않고 그 시도의 결과로 남긴다 —
 * 한 조회의 시한 초과가 '로그인 성공' 사실을 지우지 않게(v2.686 HZT-05).
 */
export async function probePaths(get, paths, { query = null, expect = 'any', keepBody = false } = {}) {
  const attempts = [];
  let last = null;
  for (const p of paths) {
    let r;
    try {
      const res = await get(p, query ? { query: { ...query } } : undefined);
      r = await classifyResponse(res, expect);
    } catch (e) {
      r = { status: null, kind: errKind(e), detail: String(describeError(e).message || '').slice(0, 200) };
    }
    attempts.push({ path: p, status: r.status, kind: r.kind, ...(r.detail ? { detail: r.detail } : {}) });
    last = { path: p, ...r };
    if (r.kind !== 'not-found') break;
  }
  if (!last) return { path: null, status: null, kind: 'error', attempts };
  const out = { path: last.path, status: last.status, kind: last.kind, attempts };
  if (last.count != null) out.count = last.count;
  if (last.detail) out.detail = last.detail;
  if (keepBody && last.kind === 'ok') out.body = last.body;
  return out;
}

const VERSION_KEYS = ['version', 'connection_server_version', 'build_version'];
function versionOfItem(x) {
  if (!x || typeof x !== 'object') return null;
  for (const k of VERSION_KEYS) if (x[k] != null && x[k] !== '') return String(x[k]).slice(0, 64);
  const d = x.details;
  if (d && typeof d === 'object') {
    if (d.version) return String(d.version).slice(0, 64);
    if (d.build) return String(d.build).slice(0, 64);
  }
  return null;
}
const hostLabel = (h) => String(h || '').replace(/^https?:\/\//i, '').split(/[/:]/)[0].toLowerCase();

/**
 * 커넥션 서버 응답 → 버전. 팟에 여러 대가 있으면 **등록한 주소와 이름이 맞는 항목**을 먼저 쓰고,
 * 못 맞추면 대표 하나 + 서로 다른 버전 목록을 함께 낸다(첫 원소를 '이 서버 버전' 이라 단정하지 않는다).
 */
export function csVersionInfo(body, host = '') {
  const arr = Array.isArray(body) ? body : body ? [body] : [];
  const items = arr.map((x) => ({ name: String(x?.name || x?.host_name || x?.fqdn || '').toLowerCase(), version: versionOfItem(x) })).filter((x) => x.version);
  if (!items.length) return { version: null, versions: [], matched: false };
  const versions = [...new Set(items.map((x) => x.version))];
  const h = hostLabel(host);
  const hit = h ? items.find((x) => x.name && (x.name === h || x.name.split('.')[0] === h.split('.')[0])) : null;
  return { version: (hit || items[0]).version, versions, matched: !!hit, pod: items.length };
}

/** 옛 호출부 호환 — 문자열 하나(없으면 null). */
export function csVersionOf(body) { return csVersionInfo(body).version; }

/** '7.13.1' → 7. 점 표기가 아니면 null(빌드 번호를 메이저로 읽지 않는다). */
export function versionMajor(v) {
  const m = /^\s*(\d{1,2})\.(\d{1,3})/.exec(String(v ?? ''));
  return m ? Number(m[1]) : null;
}

/** 같은 로그인 안에서 커넥션 서버 정보(버전)를 읽는다. */
export async function probeVersion(get, host = '') {
  const r = await probePaths(get, PROBE_PATHS, { keepBody: true });
  const info = r.kind === 'ok' ? csVersionInfo(r.body, host) : { version: null, versions: [], matched: false };
  const { body, ...rest } = r;
  return { ...rest, ...info };
}

/**
 * 라이선스 조회 실패 문구 — 404 는 '로그인은 됐고 경로만 없다' 를 말한다(인증 문제로 오해하지 않게).
 * `ctx.versionRead` 가 참이면(같은 로그인으로 커넥션 서버 정보 API 가 응답) 그 주소는 커넥션 서버다 —
 * UAG·로드밸런서 조치를 안내하지 않고 관측 사실(그 서버가 그 경로에 404)을 말한다.
 */
export function licenseFailText(status, ctx = {}) {
  if (status === 404) {
    if (ctx.versionRead) {
      const v = ctx.version ? `(버전 ${ctx.version})` : '';
      return `라이선스 조회 실패 (HTTP 404) — 이 커넥션 서버${v}는 라이선스 API(${LICENSE_PATH})에 404 로 응답합니다. 같은 로그인으로 커넥션 서버 정보 API 는 응답했으므로 주소·계정 문제가 아니라 이 버전이 그 API 를 제공하지 않는 것으로 보입니다. 만료일은 Horizon 관리 콘솔에서 확인하세요.`;
    }
    return `라이선스 조회 실패 (HTTP 404) — 로그인은 성공했지만 이 서버가 라이선스 API(${LICENSE_PATH})에 404 로 응답했습니다. 커넥션 서버 정보도 읽지 못했으니 등록 주소가 커넥션 서버인지(UAG·로드밸런서가 아닌지)와 Horizon 버전을 확인하세요.`;
  }
  if (status === 403) return '라이선스 조회 거부 (HTTP 403) — 로그인은 성공했지만 이 계정에 라이선스 조회 권한이 없습니다(Horizon 관리자 역할 확인).';
  return `라이선스 조회 실패 (HTTP ${status})`;
}

const SHORT = Object.freeze({
  ok: '됨', 'not-found': '이 서버에 없음(404)', forbidden: '권한 없음(403)', unauthorized: '토큰 거부(401)',
  unparsed: '형식 미인식', http: 'HTTP 오류', timeout: '시한 초과', error: '확인 실패',
});

/** 대량 연결 테스트 결과표용 한 줄 요약(서버 문자열 — 백틱·별표 없음). */
export function featureSummary(r) {
  if (!r?.ok) return '';
  const parts = [`로그인 성공${r.csVersion ? ` · 커넥션 서버 ${r.csVersion}` : ''}`];
  for (const f of FEATURES) {
    const x = r.features?.[f.key];
    if (!x) continue;
    const s = SHORT[x.kind] || x.kind;
    parts.push(`${f.label} ${x.kind === 'http' && x.status ? `HTTP ${x.status}` : s}${f.key === 'license' && x.kind === 'ok' && r.licenses != null ? ` ${r.licenses}건` : ''}`);
  }
  return parts.join(' · ');
}
