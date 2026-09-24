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
import { readJsonCapped, EDGE_RESPONSE_MAX_BYTES } from '../util/readCapped.js'; // v2.583: 엣지 응답 크기 상한
import { resilientFetch } from '../util/resilientFetch.js';
import { withOutboundTag } from '../util/outboundStats.js'; // v2.601 WEB2601-02: 같은 주소 엣지를 기록에서 나눈다
import { findCollector } from './edgeLogPull.js';
import { strOf } from '../util/coercionTrap.js'; // v2.604 CEN2604-03: 엣지 본문의 글자 필드는 타입부터 좁힌다
import { numOrNull } from '../util/numOrNull.js';
import { capStr } from '../util/capStr.js';

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
    // v2.604(감사 CEN2604-03): 엣지 본문을 **아는 필드만** 담는다 — 예전에는 원문 그대로라 key 가 객체인 대상 하나로
    //   /tools/bm-usage/edges 가 재시작까지 500(String(obj) 가 던졌다), node.agent 가 객체면 화면이 React #31 로 죽었다.
    snap: rec.ok && rec.snap ? sanitizeBmUsageSnap(rec.snap) : (prev?.snap || null),
    snapAt: rec.ok && rec.snap ? Date.now() : (prev?.snapAt || null),
    lastAttempt: { at: Date.now(), ok: !!rec.ok, kind: rec.kind || '', reason: rec.reason || '', ms: Number(rec.ms) || 0 },
  };
  _store.set(key, next);
  return next;
}

/*
 * ── 엣지 사용률 봉투 정제(v2.604 CEN2604-03) ─────────────────────────────────────
 * 봉투 모양은 `bmusage/edgePull.js buildBmUsageEnvelope` 가 정한다. 그 필드만, 그 타입만 담는다.
 *  · 글자 필드는 strOf(객체·배열이면 '') · 수치는 numOrNull(못 읽으면 null — 0 으로 두지 않는다).
 *  · targets·rows·authStops 는 **원소가 객체일 때만**, 상한(엣지 봉투 상한 MAX_LIMIT 2,000)까지. 뺀 개수는 `sanitizeDropped`.
 *  · 대상 원소의 나머지 필드는 얕은 복사(원시값·원시값 배열·한 단계 객체)만 — 대상 모양은 버전마다 필드가 늘어서
 *    이름 목록으로 묶으면 새 필드가 조용히 사라진다. 대신 **깊이·개수·길이**를 묶는다.
 */
const SNAP_LIST_MAX = 2_000;
const FIELD_MAX = 64;
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
function prim(v) {
  if (typeof v === 'string') return capStr(v, 512); // v2.607(TIM2607-01)
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean' || v === null) return v;
  return undefined;
}
function shallow(o, depth = 0) {
  const out = {};
  let n = 0;
  for (const k of Object.keys(o)) {
    if (BAD_KEYS.has(k) || n >= FIELD_MAX) continue;
    const v = o[k];
    let c = prim(v);
    if (c === undefined && Array.isArray(v)) c = v.slice(0, FIELD_MAX).map(prim).filter((x) => x !== undefined);
    else if (c === undefined && isObj(v) && depth < 1) c = shallow(v, depth + 1);
    if (c === undefined) continue;
    out[k] = c; n += 1;
  }
  return out;
}
function objList(v, fn) {
  const arr = Array.isArray(v) ? v : [];
  const kept = arr.slice(0, SNAP_LIST_MAX).filter(isObj).map(fn);
  return { list: kept, dropped: arr.length - kept.length };
}
function numMap(v) {
  if (!isObj(v)) return {};
  const out = {};
  for (const k of Object.keys(v).slice(0, 256)) {
    if (BAD_KEYS.has(k)) continue;
    const x = v[k];
    if (isObj(x)) out[k] = numMap(x); // counts.byReason 처럼 한 단계 중첩
    else { const n = numOrNull(x); if (n != null) out[k] = n; }
  }
  return out;
}
export function sanitizeBmUsageSnap(snap) {
  if (!isObj(snap)) return null;
  const node = isObj(snap.node) ? snap.node : {};
  const st = isObj(snap.settings) ? snap.settings : null;
  const targets = objList(snap.targets, (x) => ({ ...shallow(x), key: strOf(x.key, 256), name: strOf(x.name, 256), vcenterId: strOf(x.vcenterId, 128) }));
  const rows = objList(snap.rows, (r) => ({ ...shallow(r), key: strOf(r.key, 256), name: strOf(r.name, 256) }));
  const stops = objList(snap.authStops, (a) => ({ key: strOf(a.key, 256), path: strOf(a.path, 32), attempts: numOrNull(a.attempts), since: numOrNull(a.since), reason: strOf(a.reason, 300) }));
  const dropped = targets.dropped + rows.dropped + stops.dropped;
  return {
    node: { agent: strOf(node.agent, 128), version: strOf(node.version, 32), role: strOf(node.role, 16), datacenter: strOf(node.datacenter, 128) },
    at: numOrNull(snap.at),
    enabled: snap.enabled === true,
    settings: st ? {
      intervalMs: numOrNull(st.intervalMs), osSsh: st.osSsh === true, idracTelemetry: st.idracTelemetry === true,
      idracFullTelemetry: st.idracFullTelemetry === true, includeUnassigned: st.includeUnassigned === true,
      corps: (Array.isArray(st.corps) ? st.corps : []).slice(0, 1_000).map((c) => strOf(c, 128)).filter(Boolean),
      enterpriseEnabled: st.enterpriseEnabled === true, enterpriseAck: st.enterpriseAck === true,
      enterpriseMode: strOf(st.enterpriseMode, 32), enterpriseActive: st.enterpriseActive === true,
    } : null,
    targets: targets.list,
    truncated: numOrNull(snap.truncated) ?? 0,
    rows: rows.list,
    counts: numMap(snap.counts),
    skippedCounts: numMap(snap.skippedCounts),
    authStops: stops.list,
    status: isObj(snap.status) ? shallow(snap.status) : null,
    ...(dropped ? { sanitizeDropped: dropped } : {}),
  };
}

export function getEdgeBmUsage(agent) { return _store.get(t(agent).toLowerCase()) || null; }
export function listEdgeBmUsage() { return [..._store.values()]; }
export function _resetForTest() { _store.clear(); }

/** 404 본문으로 '구버전' 과 '엣지에서 꺼짐' 을 가른다(둘은 조치가 정반대다 — v2.549 규약). */
function kindFor404(body) {
  // v2.604 CEN2604-03: reason 이 객체면 String() 이 던지거나 '[object Object]' 가 된다 — 글자만.
  const why = body && typeof body === 'object' ? strOf(body.reason, 300) : '';
  if (why) return { kind: 'disabled', reason: why };
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
    res = await withOutboundTag(col.id || col.name || agent, () => resilientFetch(url, {
      headers: { Accept: 'application/json', ...(col.token ? { 'X-Collector-Token': col.token } : {}) },
      timeoutMs: TIMEOUT_MS, retries: 1,
    }));
  } catch (e) {
    const msg = String(e?.message || e);
    const kind = /timeout|abort|timed out/i.test(msg) ? 'timeout' : 'unreachable';
    const rec = putEdgeBmUsage(name, { ok: false, kind, reason: msg.slice(0, 300), ms: Date.now() - t0 });
    return { ok: false, kind, reason: msg.slice(0, 300), ms: Date.now() - t0, rec };
  }

  const ms = Date.now() - t0;
  let body = null;
  try { body = await readJsonCapped(res, EDGE_RESPONSE_MAX_BYTES, '엣지 사용률 응답'); } catch { body = null; } // v2.583: 크기 상한

  const fail = (kind, reason) => {
    const rec = putEdgeBmUsage(name, { ok: false, kind, reason, ms });
    return { ok: false, kind, reason, ms, rec };
  };
  if (res.status === 401 || res.status === 403) {
    return fail('auth', '수집 서버 토큰 불일치 — 중앙 등록값과 그 엣지의 COLLECTOR_TOKEN 을 대조하세요(다시 눌러도 같습니다).');
  }
  if (res.status === 404) { const k = kindFor404(body); return fail(k.kind, k.reason); }
  const bodyWhy = body && typeof body === 'object' ? strOf(body.reason, 300) : '';
  if (!res.ok) return fail('http', `HTTP ${res.status}${bodyWhy ? ` (${bodyWhy})` : ''}`);
  if (!isObj(body) || body.ok === false || !isObj(body.node)) {
    return fail('bad-body', bodyWhy || '응답 형식이 다릅니다(엣지가 아닌 서버에 닿았을 수 있습니다).');
  }
  const rec = putEdgeBmUsage(name, { ok: true, ms, snap: body });
  return { ok: true, ms, rec };
}
