/**
 * central/edgePull.js — 중앙이 엣지에서 **당기는(pull)** 공용 사다리(v2.613 CONTRACT2613-01 · EDGE2613-02).
 *
 * v2.549(edge-log) → v2.554(bm-usage) → v2.560(token-check) 순으로 같은 사다리
 *   `findCollector → enabled/url → withOutboundTag(resilientFetch X-Collector-Token) → catch timeout/unreachable →
 *    readJsonCapped → 401/403 auth → 404 kindFor404(disabled|old-version) → !ok http → bad-body`
 * 가 **글자 단위로 세 벌** 복사돼 있었고 실제로 갈라져 있었다 — v2.604 CEN2604-03(404 본문 `reason` 이 객체면 `String()` 이
 * '[object Object]' 가 된다)이 bm-usage 에만 적용돼 같은 입력에 세 답(disabled/'[object Object]' · disabled/'(형식 오류)' ·
 * old-version)이 나왔다. CLAUDE.md '코어는 하나다'(v2.513·v2.533·v2.575 IMP-08·v2.579 ARCH-01). 세 모듈은 이제 **저장(put*)만**
 * 남기고 이 함수를 부른다. 판정 순서·kind 문자열·응답 모양은 그대로다(기존 테스트 edgeLog2549·bmUsage*·tokenCheck2560·audit2601f).
 *
 * 규약(각 모듈이 갖고 있던 것을 여기로 올렸다 — 되돌리지 말 것):
 *  · 대상·토큰은 **수집 서버 등록부**에서만 읽는다(요청 본문의 url·token 을 받지 않는다 — v2.480). 같은 url·같은 토큰이라
 *    새 네트워크 허용이 필요 없다.
 *  · 실패를 '모름' 으로 뭉개지 않는다 — `kind` 로 원인을 나눈다(조치가 전부 다르다). 열거는 `EDGE_PULL_KINDS` 하나이고
 *    웹 `edgeLogText.FETCH_KIND_TEXT` 가 그 키를 전부 가진다(테스트가 1:1 대조 — v2.553 code↔text 규약).
 *  · 404 는 **두 뜻**이다(엣지의 collector 가 꺼짐 / 구버전이라 이 경로가 없음) — 본문으로 가른다. 이 코드의 엣지는
 *    `{ok:false, reason:'…'}` 을, 구버전 엣지는 express 기본 404(HTML)를 준다. reason 은 `strOf`(글자·수·불리언만) 로 읽는다.
 *  · 응답은 `readJsonCapped`(크기 상한 — v2.583) 로 읽고, 나가는 호출은 `withOutboundTag(col.id)` 안에서(v2.601 WEB2601-02).
 *  · 시한·재시도는 **호출부 옵션**이다 — 각 모듈의 env(`*_PULL_TIMEOUT_MS`)와 '점검은 재시도가 판정을 흐린다'(token-check
 *    retries 0) 는 의도를 여기서 정하지 않는다.
 *
 * 반환: `{ ok, kind?, reason?, ms, body?, col, fetched }` — `fetched` 가 false 면 등록부 단계에서 끝난 것이라 호출부가
 *   보관소에 실패를 남기지 않는다(예전 동작 그대로 — 등록부 문제는 '그 엣지의 마지막 시도' 가 아니다).
 */
import { readJsonCapped, EDGE_RESPONSE_MAX_BYTES } from '../util/readCapped.js'; // v2.583: 엣지 응답 크기 상한
import { resilientFetch } from '../util/resilientFetch.js';
import { withOutboundTag } from '../util/outboundStats.js'; // v2.601 WEB2601-02: 같은 주소 엣지를 기록에서 나눈다
import { strOf } from '../util/coercionTrap.js'; // v2.604 CEN2604-03: 엣지 본문의 글자 필드는 타입부터 좁힌다
import { trimTrailingSlashes } from '../util/trimSlashes.js'; // v2.611: 끝 슬래시 제거는 선형 루프 하나
import { findCollectorByName } from '../collector/registry.js'; // v2.613 EDGE2613-08: 이름 조회 코어는 등록부 하나

/** 실패 종류 열거 — 세 pull 모듈이 낼 수 있는 kind 의 **전부**(웹 라벨 맵과 1:1). */
export const EDGE_PULL_KINDS = Object.freeze([
  'not-registered', 'disabled-central', 'no-url', // 등록부 단계(네트워크 왕복 없음)
  'timeout', 'unreachable',                       // 연결 단계
  'auth', 'disabled', 'old-version', 'http', 'bad-body', // 응답 단계
]);

const t = (v) => String(v ?? '').trim();
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/**
 * 등록부에서 이 이름의 수집 서버를 찾는다(대소문자 무시 — 등록부가 그 규약이다).
 * v2.613 EDGE2613-08: 판정은 `collector/registry.js findCollectorByName` 하나다. 이 래퍼는 호출부의 async 시그니처와
 * '등록부 예외 → null' 동작을 지킨다(edgeLogPull 이 같은 이름으로 재수출한다).
 */
export async function findCollector(agent) {
  try { return findCollectorByName(agent); } catch { return null; }
}

/** 기본 본문 판정 — 이 코드의 엣지 pull 응답은 `{ok, node:{…}, …}` 다. */
const defaultBodyOk = (body) => isObj(body) && body.ok !== false && isObj(body.node);

/**
 * 404 본문으로 '구버전' 과 '엣지에서 꺼짐' 을 가른다(둘은 조치가 정반대다 — v2.549 규약).
 * v2.604 CEN2604-03: reason 이 객체면 String() 이 던지거나 '[object Object]' 가 된다 — 글자만 읽는다(세 모듈 공통).
 */
export function kindFor404(body, { path = '', minVersion = '', what = '' } = {}) {
  const why = isObj(body) ? strOf(body.reason, 300) : '';
  if (why) return { kind: 'disabled', reason: why };
  return { kind: 'old-version', reason: `이 엣지에 ${path} 가 없습니다 — v${minVersion} 이상으로 업그레이드해야 ${what} 수 있습니다.` };
}

/**
 * 한 엣지에서 `path` 를 당긴다. **저장은 하지 않는다** — 호출부가 `fetched` 를 보고 보관소에 남긴다.
 * @param {string} agent  등록부 이름 또는 id
 * @param {string} path   `/api/collector/…`(쿼리 포함 가능)
 * @param {object} o
 * @param {number} o.timeoutMs   요청 시한(호출부 env)
 * @param {number} [o.retries=1] resilientFetch 재시도 — 점검류는 0
 * @param {Function} [o.fetchImpl=resilientFetch] 테스트 주입
 * @param {(body:any)=>boolean} [o.bodyOk] 본문 형식 판정(기본: 객체 + ok!==false + node 객체)
 * @param {string} [o.minVersion] 404 구버전 문구용 최소 엣지 버전
 * @param {string} [o.what]       404 구버전 문구용 — '로그를 읽을' 처럼 '… 수 있습니다' 앞 구절
 * @param {string} [o.label]      readJsonCapped 오류 문구 라벨
 * @param {string} [o.authReason] 401/403 사유 문구(모듈마다 조금 다른 문장을 유지)
 * @returns {Promise<{ok:boolean, kind?:string, reason?:string, ms:number, body?:object, col:object|null, fetched:boolean}>}
 */
export async function pullFromEdge(agent, path, {
  timeoutMs = 20_000, retries = 1, fetchImpl = resilientFetch, bodyOk = defaultBodyOk,
  minVersion = '', what = '읽을', label = '엣지 응답',
  authReason = '수집 서버 토큰 불일치 — 중앙 등록값과 그 엣지의 COLLECTOR_TOKEN 을 대조하세요(다시 눌러도 같습니다).',
} = {}) {
  const t0 = Date.now();
  const col = await findCollector(agent);
  if (!col) return { ok: false, kind: 'not-registered', reason: '수집 서버 등록부에 없는 이름입니다(설정 › 수집 서버에서 등록하세요).', ms: 0, col: null, fetched: false };
  if (col.enabled === false) return { ok: false, kind: 'disabled-central', reason: '중앙에서 이 수집 서버를 비활성으로 두었습니다.', ms: 0, col, fetched: false };
  if (!t(col.url)) return { ok: false, kind: 'no-url', reason: '이 수집 서버에 URL 이 없습니다.', ms: 0, col, fetched: false };

  const p = String(path || '');
  const pathOnly = p.split('?')[0];
  const url = `${trimTrailingSlashes(t(col.url))}${p}`;

  let res;
  try {
    res = await withOutboundTag(col.id || col.name || agent, () => fetchImpl(url, {
      headers: { Accept: 'application/json', ...(col.token ? { 'X-Collector-Token': col.token } : {}) },
      timeoutMs, retries,
    }));
  } catch (e) {
    const msg = String(e?.message || e);
    const kind = /timeout|abort|timed out/i.test(msg) ? 'timeout' : 'unreachable';
    return { ok: false, kind, reason: msg.slice(0, 300), ms: Date.now() - t0, col, fetched: true };
  }

  const ms = Date.now() - t0;
  let body = null;
  try { body = await readJsonCapped(res, EDGE_RESPONSE_MAX_BYTES, label); } catch { body = null; } // v2.583: 크기 상한

  const fail = (kind, reason) => ({ ok: false, kind, reason, ms, body, col, fetched: true });
  if (res.status === 401 || res.status === 403) return fail('auth', authReason);
  if (res.status === 404) { const k = kindFor404(body, { path: pathOnly, minVersion, what }); return fail(k.kind, k.reason); }
  const bodyWhy = isObj(body) ? strOf(body.reason, 300) : '';
  if (!res.ok) return fail('http', `HTTP ${res.status}${bodyWhy ? ` (${bodyWhy})` : ''}`);
  if (!bodyOk(body)) return fail('bad-body', bodyWhy || '응답 형식이 다릅니다(엣지가 아닌 서버에 닿았을 수 있습니다).');
  return { ok: true, ms, body, col, fetched: true };
}
