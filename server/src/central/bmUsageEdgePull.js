/**
 * central/bmUsageEdgePull.js — 중앙이 엣지에서 베어메탈 사용률을 **당긴다**(v2.554).
 *
 * 사용자 지시: "엣지에서 종합하고 중앙으로 전달은 **중앙에서 조회할때만** 한다."
 * 즉 상시 push 가 없다 — 사람이 화면에서 누를 때만 나간다(v2.549 엣지 로그와 같은 구조).
 *
 * ⚠ **대상·토큰은 수집 서버 등록부**다 — `edgeLogPull.js findCollector` 를 **재사용**한다
 *   (등록부 조회를 복제하면 대소문자 규약·비활성 판정이 갈라진다. CLAUDE.md '코어는 하나다').
 * ⚠ **인메모리다** — 진실의 원천은 각 엣지의 DB 이고 이것은 '방금 본 값' 이다. 디스크에 쓰면
 *   재기동 뒤 낡은 값을 '지금 값' 인 척 보여준다(v2.548 `central/partFaultEdge.js` 와 같은 판단).
 * ⚠ **저장 키는 중앙이 아는 이름**(등록부 `name`)이다 — 응답 본문의 `node.agent` 를 믿지 않는다
 *   (v2.548 F5). 둘이 다르면 그 사실 자체가 진단이므로 화면이 나란히 보여 준다.
 * ⚠ 실패를 '모름' 으로 뭉개지 않는다 — `kind` 로 원인을 나눈다(조치가 전부 다르다).
 */
import { resilientFetch } from '../util/resilientFetch.js';
import { findCollector } from './edgeLogPull.js';

/** 이 엔드포인트를 내주기 시작한 최소 엣지 버전 — 그 아래는 경로가 없다. */
export const MIN_EDGE_VERSION = '2.554.0';
const TIMEOUT_MS = Math.max(5_000, Number(process.env.BMUSAGE_PULL_TIMEOUT_MS) || 20_000);
/** 보관분이 이보다 오래되면 화면이 '낡았다' 고 말한다(값을 지우지는 않는다). */
export const STALE_MS = Math.max(60_000, Number(process.env.BMUSAGE_PULL_STALE_MS) || 30 * 60_000);

const t = (v) => String(v ?? '').trim();
/** agent(소문자) → { at, ok, ms, snap|null, kind, reason } */
const _store = new Map();

export function putEdgeBmUsage(agent, rec) {
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
    /*
     * ⚠ **실패는 직전 값을 지우지 않는다**(v2.550.3 H5 규약): 통째로 덮으면 한 번 실패한 뒤
     *   화면이 '보관분 없음' 이 되어 방금까지 보던 값이 사라진다. 실패는 `lastAttempt` 로 남긴다.
     */
    snap: rec.ok && rec.snap ? rec.snap : (prev?.snap || null),
    snapAt: rec.ok && rec.snap ? Date.now() : (prev?.snapAt || null),
    lastAttempt: { at: Date.now(), ok: !!rec.ok, kind: rec.kind || '', reason: rec.reason || '', ms: Number(rec.ms) || 0 },
  };
  _store.set(key, next);
  return next;
}

export function getEdgeBmUsage(agent) { return _store.get(t(agent).toLowerCase()) || null; }
export function listEdgeBmUsage() { return [..._store.values()]; }
export function _resetForTest() { _store.clear(); }

/** 404 본문으로 '구버전' 과 '엣지에서 꺼짐' 을 가른다(둘은 조치가 정반대다 — v2.549 규약). */
function kindFor404(body) {
  if (body && typeof body === 'object' && body.reason) return { kind: 'disabled', reason: String(body.reason) };
  return { kind: 'old-version', reason: `이 엣지에 /api/collector/bm-usage 가 없습니다 — v${MIN_EDGE_VERSION} 이상으로 업그레이드해야 사용률을 읽을 수 있습니다.` };
}

/**
 * 한 엣지에서 당긴다. **저장까지** 하고 결과를 돌려준다.
 * @returns {{ok:boolean, kind?:string, reason?:string, ms:number, rec?:object}}
 */
export async function pullBmUsage(agent, { limit = 0 } = {}) {
  const t0 = Date.now();
  const col = await findCollector(agent);
  if (!col) return { ok: false, kind: 'not-registered', reason: '수집 서버 등록부에 없는 이름입니다(설정 › 수집 서버에서 등록하세요).', ms: 0 };
  if (col.enabled === false) return { ok: false, kind: 'disabled-central', reason: '중앙에서 이 수집 서버를 비활성으로 두었습니다.', ms: 0 };
  if (!t(col.url)) return { ok: false, kind: 'no-url', reason: '이 수집 서버에 URL 이 없습니다.', ms: 0 };

  const qs = Number(limit) > 0 ? `?limit=${Math.round(Number(limit))}` : '';
  const url = `${t(col.url).replace(/\/+$/, '')}/api/collector/bm-usage${qs}`;
  const name = col.name || agent;

  let res;
  try {
    res = await resilientFetch(url, {
      headers: { Accept: 'application/json', ...(col.token ? { 'X-Collector-Token': col.token } : {}) },
      timeoutMs: TIMEOUT_MS, retries: 1,
    });
  } catch (e) {
    const msg = String(e?.message || e);
    const kind = /timeout|abort|timed out/i.test(msg) ? 'timeout' : 'unreachable';
    const rec = putEdgeBmUsage(name, { ok: false, kind, reason: msg.slice(0, 300), ms: Date.now() - t0 });
    return { ok: false, kind, reason: msg.slice(0, 300), ms: Date.now() - t0, rec };
  }

  const ms = Date.now() - t0;
  let body = null;
  try { body = await res.json(); } catch { body = null; }

  const fail = (kind, reason) => {
    const rec = putEdgeBmUsage(name, { ok: false, kind, reason, ms });
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
  const rec = putEdgeBmUsage(name, { ok: true, ms, snap: body });
  return { ok: true, ms, rec };
}
