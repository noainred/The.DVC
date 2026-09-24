/**
 * central/tokenCheckPull.js — 중앙이 엣지에서 **토큰 자기보고**를 당긴다(v2.560).
 *
 * 왜 pull 인가: `GET /api/collector/token-check` 는 `collector/puller.js:23` 이 이미 60초마다
 * 쓰는 **같은 url·같은 토큰**(`X-Collector-Token`)이다 — **새 네트워크 허용이 필요 없다**.
 * ⚠⚠ 그리고 이것이 v2.554 가 기록한 한계를 **구조적으로 피하는** 이유다: `/api/central/link-check`
 *   계열은 **개별 토큰 전용**이라 공유 `CENTRAL_TOKEN` 만 쓰는 법인은 403 이고 "403 을 받고 있다는
 *   사실조차 보고할 수 없다". 수집 토큰 게이트는 공유/개별과 무관하게 동작하므로, 개별 토큰으로
 *   이관되지 않은 법인도 이 점검의 대상이 된다.
 *
 * ⚠ **상시 push 0** — 사람이 화면에서 누를 때만 나간다(v2.549·v2.554 규약).
 * ⚠ **인메모리다** — 진실의 원천은 각 엣지의 env 이고 이것은 '방금 본 값' 이다.
 * ⚠ **저장 키는 중앙이 아는 이름**(등록부 `name`)이다 — 본문 `node.agent` 를 믿지 않는다(v2.548 F5).
 *   둘이 다르면 그 사실 자체가 진단이므로 화면이 나란히 보여 준다.
 * ⚠ **실패가 직전 값을 지우지 않는다**(v2.550.3 H5) — 한 번 실패한 뒤 화면이 '보고 없음' 이 되면
 *   방금까지 보던 값이 사라진다. 실패는 `lastAttempt` 로 남긴다.
 */
import { readJsonCapped, EDGE_RESPONSE_MAX_BYTES } from '../util/readCapped.js'; // v2.583: 엣지 응답 크기 상한
import { resilientFetch } from '../util/resilientFetch.js';
import { withOutboundTag } from '../util/outboundStats.js'; // v2.601 WEB2601-02: 같은 주소 엣지를 기록에서 나눈다
import { findCollector } from './edgeLogPull.js';
import { capTrim } from '../util/capStr.js'; // v2.606 TIM2606-02: 보관 글자는 평탄화(SlicedString 이 응답 원문을 붙잡지 않게)

/** 이 엔드포인트를 내주기 시작한 최소 엣지 버전 — 그 아래는 경로가 없다. */
export const MIN_EDGE_VERSION = '2.560.0';
const TIMEOUT_MS = Math.max(3_000, Number(process.env.PORTALCHECK_PULL_TIMEOUT_MS) || 20_000);
/** 보고가 이보다 오래되면 화면이 '낡았다' 고 말한다(값을 지우지는 않는다). */
export const STALE_MS = Math.max(60_000, Number(process.env.PORTALCHECK_PULL_STALE_MS) || 30 * 60_000);

const t = (v) => String(v ?? '').trim();
/** agent(소문자) → 보고 레코드 */
const _store = new Map();

/**
 * 수신분 정제 — **아는 키만** 담는다(v2.552 규약). 엣지가 임의 필드를 늘려 중앙 메모리를
 * 부풀리지 못하게 하고, 무엇보다 **전체 해시처럼 생긴 긴 값을 받아 보관하지 않게** 한다.
 */
export function sanitizeEnvelope(body) {
  const facts = (o) => ({
    set: o?.set === true,
    // ⚠ 8자만 받는다 — 구버전·변조 엣지가 전체 해시를 실어도 중앙에 남지 않는다(규칙 2).
    short: capTrim(o?.short, 8),
    len: Number(o?.len) > 0 ? Math.round(Number(o.len)) : 0,
    space: o?.space === true,
    hygiene: Array.isArray(o?.hygiene) ? o.hygiene.map((x) => capTrim(x, 16)).slice(0, 8) : [],
  });
  const triState = (v) => (v === true ? true : v === false ? false : null); // null = 모른다
  const tok = body?.tokens || {};
  const sp = body?.selfProbe || {};
  return {
    at: Number(body?.at) || Date.now(),
    node: {
      agent: capTrim(body?.node?.agent, 64),
      hostname: capTrim(body?.node?.hostname, 128),
      version: capTrim(body?.node?.version, 32),
      datacenter: capTrim(body?.node?.datacenter, 64),
      centralUrl: capTrim(body?.node?.centralUrl, 256),
    },
    tokens: {
      collector: facts(tok.collector),
      centralSend: facts(tok.centralSend),
      centralGate: facts(tok.centralGate),
      collectorEqualsCentralSend: triState(tok.collectorEqualsCentralSend),
      centralGateEqualsCentralSend: triState(tok.centralGateEqualsCentralSend),
    },
    centralRole: {
      enabled: body?.centralRole?.enabled === true,
      byEnv: body?.centralRole?.byEnv === true,
      byIssuedTokens: body?.centralRole?.byIssuedTokens === true,
    },
    selfProbe: {
      ran: sp.ran === true,
      ok: sp.ok === true,
      status: Number(sp.status) || null,
      ms: Number(sp.ms) || 0,
      kind: capTrim(sp.kind, 32),
      reason: capTrim(sp.reason, 300),
      yourAgent: capTrim(sp.yourAgent, 64),
      tokenMode: capTrim(sp.tokenMode, 16),
      centralVersion: capTrim(sp.centralVersion, 32),
      centralInstance: capTrim(sp.centralInstance, 64),
    },
  };
}

export function putEdgeTokenReport(agent, rec) {
  const key = t(agent).toLowerCase();
  if (!key) return null;
  const prev = _store.get(key) || null;
  const next = {
    agent: t(agent),
    at: Date.now(),
    ok: !!rec.ok,
    ms: Number(rec.ms) || 0,
    kind: rec.kind || '',
    reason: rec.reason || '',
    report: rec.ok && rec.report ? rec.report : (prev?.report || null),
    reportAt: rec.ok && rec.report ? Date.now() : (prev?.reportAt || null),
    lastAttempt: { at: Date.now(), ok: !!rec.ok, kind: rec.kind || '', reason: rec.reason || '', ms: Number(rec.ms) || 0 },
  };
  _store.set(key, next);
  return next;
}

export function getEdgeTokenReport(agent) { return _store.get(t(agent).toLowerCase()) || null; }
export function listEdgeTokenReports() { return [..._store.values()]; }
export function _resetForTest() { _store.clear(); }

/** 404 본문으로 '구버전' 과 '엣지에서 꺼짐' 을 가른다(둘은 조치가 정반대다 — v2.549 규약). */
function kindFor404(body) {
  if (body && typeof body === 'object' && body.reason) return { kind: 'disabled', reason: String(body.reason).slice(0, 300) };
  return { kind: 'old-version', reason: `이 엣지에 /api/collector/token-check 가 없습니다 — v${MIN_EDGE_VERSION} 이상으로 업그레이드해야 엣지 저장 토큰을 확인할 수 있습니다.` };
}

/**
 * 한 엣지에서 당긴다. **저장까지** 하고 결과를 돌려준다.
 * @returns {{ok:boolean, kind?:string, reason?:string, ms:number, rec?:object}}
 */
export async function pullTokenCheck(agent, { selfProbe = true, fetchImpl = resilientFetch, timeoutMs = TIMEOUT_MS } = {}) {
  const t0 = Date.now();
  const col = await findCollector(agent);
  if (!col) return { ok: false, kind: 'not-registered', reason: '수집 서버 등록부에 없는 이름입니다(설정 › 수집 서버에서 등록하세요).', ms: 0 };
  if (col.enabled === false) return { ok: false, kind: 'disabled-central', reason: '중앙에서 이 수집 서버를 비활성으로 두었습니다.', ms: 0 };
  if (!t(col.url)) return { ok: false, kind: 'no-url', reason: '이 수집 서버에 URL 이 없습니다.', ms: 0 };

  // ⚠ 접속처는 **등록부 저장값에서만** 읽는다 — 요청 본문의 url 을 받지 않는다(v2.480 규약).
  const url = `${t(col.url).replace(/\/+$/, '')}/api/collector/token-check${selfProbe ? '' : '?selfprobe=0'}`;
  const name = col.id || col.name || agent; // v2.583 #29: 점검 행 키(수집 서버 id = 에이전트 이름)와 같은 키로 저장한다

  let res;
  try {
    res = await withOutboundTag(col.id || col.name || agent, () => fetchImpl(url, {
      headers: { Accept: 'application/json', ...(col.token ? { 'X-Collector-Token': col.token } : {}) },
      timeoutMs, retries: 0, // '되는가' 를 보는 점검이라 재시도가 판정을 흐린다
    }));
  } catch (e) {
    const msg = String(e?.message || e);
    const kind = /timeout|abort|timed out/i.test(msg) ? 'timeout' : 'unreachable';
    const rec = putEdgeTokenReport(name, { ok: false, kind, reason: msg.slice(0, 300), ms: Date.now() - t0 });
    return { ok: false, kind, reason: msg.slice(0, 300), ms: Date.now() - t0, rec };
  }

  const ms = Date.now() - t0;
  let body = null;
  try { body = await readJsonCapped(res, EDGE_RESPONSE_MAX_BYTES, '엣지 토큰 점검 응답'); } catch { body = null; } // v2.583: 크기 상한

  const fail = (kind, reason) => {
    const rec = putEdgeTokenReport(name, { ok: false, kind, reason, ms });
    return { ok: false, kind, reason, ms, rec };
  };
  if (res.status === 401 || res.status === 403) {
    return fail('auth', '수집 서버 토큰 불일치 — 중앙 등록값과 그 엣지의 COLLECTOR_TOKEN 을 대조하세요(다시 눌러도 같습니다).');
  }
  if (res.status === 404) { const k = kindFor404(body); return fail(k.kind, k.reason); }
  if (!res.ok) return fail('http', `HTTP ${res.status}${body?.reason ? ` (${body.reason})` : ''}`);
  if (!body || body.ok === false || !body.node) {
    return fail('bad-body', body?.reason ? String(body.reason).slice(0, 300) : '응답 형식이 다릅니다(엣지가 아닌 서버에 닿았을 수 있습니다).');
  }
  const rec = putEdgeTokenReport(name, { ok: true, ms, report: sanitizeEnvelope(body) });
  return { ok: true, ms, rec };
}
