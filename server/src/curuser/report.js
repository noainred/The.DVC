/**
 * curuser/report.js — 저장된 최신 레코드 → 화면·API 가 쓰는 보고서(v2.520, 순수 모듈).
 *
 * ── 왜 조회 시점에 신선도를 **다시** 판정하는가(핵심) ─────────────────────────
 * `kind`('ok'|'stale'|…)는 수집 시점에 계산된 값이다. 그런데 위임(엣지) 법인의 레코드는
 * 엣지가 push 를 멈추면 **중앙 DB 에 `kind:'ok'` 로 그대로 남는다** — 며칠 전 값이 화면에서
 * 계속 '정상' 으로 보인다. 그래서 여기서 **게스트 발행 시각(`at`)** 을 기준으로 다시 판정한다.
 * `at` 은 절대 시각이라 중앙·엣지 어느 쪽에서 만든 레코드든 같은 기준으로 볼 수 있다.
 *
 * ⚠ **`stale` 레코드의 사용자는 세지 않는다.** 그 값이 지금도 맞는지 우리는 모른다 —
 *   세면 '지금 3명' 이라고 말하면서 실제로는 4시간 전 3명일 수 있다. 대신 **몇 대가 제외됐는지**
 *   를 함께 낸다(`kinds`). 조용히 빼면 '이 폴더에 아무도 없다' 는 거짓이 된다.
 * ⚠ 계정명은 시계열에 넣지 않는다(`aggregate.seriesRow` 머리말) — 여기서도 `names` 는 **최신
 *   스냅샷 전용**이다.
 */
import { aggregateAll } from './aggregate.js';
import { KIND_LABEL } from './guestinfoSource.js';

/** 상태별 개수 — 화면이 '정상 N · 값 오래됨 M · 발행기 없음 K' 를 그대로 적는다. */
export function kindCounts(records) {
  const out = {};
  for (const r of records || []) {
    const k = String(r?.kind || 'unknown');
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

/**
 * 발행 시각 기준 신선도 재판정. 반환은 **새 배열**(입력 불변).
 *
 * 규칙:
 *  · `at` 이 있고 `now - at > staleAfterMs` → `stale`(ok:false)
 *  · `at` 이 미래(유예 초과) → `clock-skew`(ok:false)
 *  · `at` 이 없는 상태(no-agent·guest-error·unparsed·not-found)는 **그대로 둔다** — 신선도가
 *    아니라 다른 이유로 실패한 것이다(원인을 덮어쓰지 않는다).
 */
export function refreshKinds(records, { now = Date.now(), staleAfterMs = 30 * 60_000, skewGraceMs = 5 * 60_000 } = {}) {
  return (records || []).map((r) => {
    if (!r) return r;
    const at = r.at == null ? null : Number(r.at);
    if (at == null || !Number.isFinite(at)) return { ...r, ageMs: null };
    const ageMs = now - at;
    if (r.kind === 'no-agent' || r.kind === 'guest-error' || r.kind === 'unparsed' || r.kind === 'incomplete' || r.kind === 'not-found') return { ...r, ageMs };
    if (ageMs < -skewGraceMs) return { ...r, ageMs, kind: 'clock-skew', ok: false };
    if (ageMs > staleAfterMs) return { ...r, ageMs, kind: 'stale', ok: false };
    return { ...r, ageMs, kind: 'ok', ok: true };
  });
}

/**
 * 보고서 조립.
 *
 * @param {object[]} records  `db.latestRecords()` 결과
 * @param {object} p
 * @param {(id:string)=>string} p.vcNameOf
 * @param {object[]} [p.skipped] `scope.resolveTargets().skipped` (대상 아님 — 실패가 아니다)
 * @returns {{
 *   now:number, staleAfterMs:number,
 *   total:object, vcenters:object[], kinds:object, kindLabels:object,
 *   lastReadAt:number|null, oldestPublishAt:number|null, records:object[], skipped:object[]
 * }}
 */
export function buildReport(records, { now = Date.now(), staleAfterMs = 30 * 60_000, vcNameOf = (id) => id, skipped = [] } = {}) {
  const fresh = refreshKinds(records, { now, staleAfterMs });
  const agg = aggregateAll(fresh, { vcNameOf });
  const reads = fresh.map((r) => Number(r.ts)).filter((n) => Number.isFinite(n));
  const pubs = fresh.map((r) => Number(r.at)).filter((n) => Number.isFinite(n));
  // vCenter별 상태 개수·마지막 조회 시각도 함께 — 화면이 법인 행에서 바로 사유를 말할 수 있게.
  const byVc = new Map();
  for (const r of fresh) {
    const id = String(r.vcenterId || '');
    if (!byVc.has(id)) byVc.set(id, []);
    byVc.get(id).push(r);
  }
  const vcenters = agg.vcenters.map((v) => {
    const rs = byVc.get(v.vcenterId) || [];
    const ts = rs.map((r) => Number(r.ts)).filter(Number.isFinite);
    return {
      ...v,
      kinds: kindCounts(rs),
      lastReadAt: ts.length ? Math.max(...ts) : null,
      skipped: (skipped || []).filter((s) => String(s.vcenterId || '') === v.vcenterId).length,
    };
  });
  return {
    now,
    staleAfterMs,
    total: agg.total,
    vcenters,
    kinds: kindCounts(fresh),
    kindLabels: { ...KIND_LABEL, 'not-found': 'vCenter 응답에 없음', unknown: '알 수 없음' },
    lastReadAt: reads.length ? Math.max(...reads) : null,
    oldestPublishAt: pubs.length ? Math.min(...pubs) : null,
    records: fresh,
    skipped: skipped || [],
  };
}
