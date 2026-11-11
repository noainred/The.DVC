/**
 * storage/inspect/perf.js — 7일 노드 통계 · Top 10 노드 편중(v2.965 · 설계 README §3.4).
 *
 *  · 원천은 **이미 쌓고 있는 노드 부하 기록**(storage-history.db — v2.926 ~ v2.937 · 5분 표본)이다. 장비 호출 0 · 새 서버 수집 없음.
 *  · 노드마다 창 평균(표본 수로 가중) · 최대 · 표본 수. 읽지 못한 표본은 DB 에 null 이라 평균에서 빠진다(0 으로 넣지 않는다).
 *  · 편중 = 가장 바쁜 노드 ÷ 노드 평균(ops/s — 없으면 처리량 In+Out). 노드 평균의 분모에는 값이 있는 노드만 든다(표본 0 노드는 '기록 없음').
 *  · 집계는 순수 함수(aggregateNodeRows · skewOf · topNodes)로 나누고 DB 읽기(devicePerf)는 얇게 — 테스트가 순수 쪽을 고정한다.
 */
import { nodeLoadQuery } from '../db.js';
import { createYielder } from '../../util/timeSlice.js';

export const PERF_METRICS = Object.freeze({
  ops: { group: 'proto', keys: ['ops'], label: '프로토콜 ops/s', unit: 'ops/s' },
  net: { group: 'net', keys: ['in', 'out'], label: '처리량 In + Out', unit: 'bps' },
  busy: { group: 'disk', keys: ['busy'], label: '디스크 busy', unit: '%' },
  cpu: { group: 'cpu', keys: ['cpu'], label: 'CPU', unit: '%' },
});
const HUGE_BUCKET = 400 * 86_400_000; // 창 하나를 한 칸으로(경계에 걸리면 두 칸 — 아래에서 가중 합친다)

/**
 * nodeLoadQuery(kind 'bucket') 행들 → 노드별 { avg, max, n }. 키가 여럿이면(In+Out) 같은 칸의 합을 평균한다 — 칸마다 둘 다 있을 때만 더한다(부분 합 금지).
 * @returns {Map<number, {avg:number|null, max:number|null, n:number}>}
 */
export function aggregateNodeRows(rows, keys) {
  const acc = new Map();
  for (const r of rows || []) {
    const node = Number(r?.node);
    if (!Number.isFinite(node)) continue;
    const vs = keys.map((k) => r?.v?.[k]);
    if (vs.some((x) => x == null || !Number.isFinite(Number(x)))) continue;
    const v = vs.reduce((a, b) => a + Number(b), 0);
    const ns = keys.map((k) => Number(r?.n?.[k]) || 0);
    const n = Math.min(...ns) || 1;
    const mxs = keys.map((k) => r?.mx?.[k]);
    const mx = mxs.every((x) => x != null && Number.isFinite(Number(x))) ? mxs.reduce((a, b) => a + Number(b), 0) : null;
    const cur = acc.get(node) || { s: 0, n: 0, max: null };
    cur.s += v * n; cur.n += n; if (mx != null) cur.max = cur.max == null ? mx : Math.max(cur.max, mx);
    acc.set(node, cur);
  }
  const out = new Map();
  for (const [node, c] of acc) out.set(node, { avg: c.n > 0 ? c.s / c.n : null, max: c.max, n: c.n });
  return out;
}
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
/** 편중 — nodes:[{lnn, value}] → { nodes, mean, lnn, ratio }(값이 있는 노드만 · 평균 0 이면 ratio null). */
export function skewOf(nodes) {
  const xs = (nodes || []).filter((x) => x && x.value != null && Number.isFinite(x.value));
  if (!xs.length) return { nodes: 0, mean: null, lnn: null, ratio: null };
  const mean = xs.reduce((a, b) => a + b.value, 0) / xs.length;
  const top = xs.reduce((a, b) => (b.value > a.value ? b : a));
  return { nodes: xs.length, mean, lnn: top.lnn, ratio: mean > 0 ? r1(top.value / mean) : null, value: top.value };
}

/**
 * 장비 하나의 창 통계 — { samples, nodes:[{lnn, ops, net, busyAvg, busyMax, cpuAvg, cpuMax}], skew:{…, metric, metricLabel}, why? }.
 * DB 가 없거나 표본이 0 이면 samples 0 + why(판정은 확인 불가).
 */
export const DAILY_FROM_MS = 8 * 86_400_000;
export async function devicePerf(deviceId, { from, to, yielder = null }) {
  // 반증 F6: ① 동기 SQLite 사이에 **실제로 양보**한다(await 만으로는 타이머 · I/O 에 양보하지 않는다 — 30대 × 24노드 × 7일 실측 1.2초 정지).
  //   ② 8일 넘는 창(30일)은 일 요약(node_load_daily)으로 읽는다 — 시간 요약은 노드 24 × 720시간이 행 상한(12,800)에 걸려 최근 며칠이 잘렸다(포탈 날짜 단위 창).
  //   ③ 그래도 잘렸으면(truncated) 평균이라고 내지 않고 확인 불가로 돌린다.
  const y = typeof yielder === 'function' ? yielder : createYielder(15);
  const daily = to - from > DAILY_FROM_MS;
  const q = async (m) => {
    let r;
    try {
      r = daily ? await nodeLoadQuery(deviceId, { group: PERF_METRICS[m].group, kind: 'day', from, to })
        : await nodeLoadQuery(deviceId, { group: PERF_METRICS[m].group, kind: 'bucket', from, to, bucketMs: HUGE_BUCKET });
    } catch { r = { db: false, rows: [] }; }
    await y();
    return r;
  };
  const [ops, net, disk, cpu] = [await q('ops'), await q('net'), await q('busy'), await q('cpu')]; // 차례로 — 질의 사이 시간 기준 양보
  if (!ops.db && !net.db) return { samples: 0, nodes: [], skew: skewOf([]), why: '이 포탈 노드에서 저장소 DB(SQLite)를 열 수 없습니다' };
  if ([ops, net, disk, cpu].some((r) => r.truncated)) return { samples: 0, nodes: [], skew: skewOf([]), truncated: true, why: '창 안 표본이 읽기 상한을 넘어 일부만 읽혔습니다 — 평균이라고 내지 않습니다' };
  const A = { ops: aggregateNodeRows(ops.rows, ['ops']), net: aggregateNodeRows(net.rows, ['in', 'out']), busy: aggregateNodeRows(disk.rows, ['busy']), cpu: aggregateNodeRows(cpu.rows, ['cpu']) };
  const lnns = [...new Set([...A.ops.keys(), ...A.net.keys(), ...A.busy.keys(), ...A.cpu.keys()])].sort((a, b) => a - b);
  const nodes = lnns.map((lnn) => ({
    lnn,
    ops: r1(A.ops.get(lnn)?.avg ?? null), net: A.net.get(lnn)?.avg ?? null,
    busyAvg: r1(A.busy.get(lnn)?.avg ?? null), busyMax: r1(A.busy.get(lnn)?.max ?? null),
    cpuAvg: r1(A.cpu.get(lnn)?.avg ?? null), cpuMax: r1(A.cpu.get(lnn)?.max ?? null),
    n: Math.max(A.ops.get(lnn)?.n || 0, A.net.get(lnn)?.n || 0, A.busy.get(lnn)?.n || 0, A.cpu.get(lnn)?.n || 0),
  }));
  const samples = nodes.reduce((a, b) => a + b.n, 0);
  const useOps = nodes.some((n) => n.ops != null);
  const metric = useOps ? 'ops' : 'net';
  const skew = { ...skewOf(nodes.map((n) => ({ lnn: n.lnn, value: n[metric] }))), metric, metricLabel: useOps ? 'ops/s' : '처리량' };
  return { samples, nodes, skew, ...(daily ? { granularity: 'day' } : {}), ...(samples ? {} : { why: '창 안에 노드 표본이 없습니다(표본 수집이 꺼졌거나 아직 쌓이지 않았습니다)' }) };
}

/**
 * Top N 노드 — perfs:[{ deviceId, perf }] → 행 [{ deviceId, lnn, value, ratio(자기 클러스터 평균 대비), share(클러스터 안 비중 %), busyAvg · busyMax · cpuAvg · cpuMax }].
 * metric: ops · net · busy · cpu. 값이 없는 노드는 순위에 넣지 않는다(0 으로 세지 않는다).
 */
export function topNodes(perfs, { metric = 'ops', limit = 10, skewFactor = 1.5 } = {}) {
  const key = metric === 'busy' ? 'busyAvg' : metric === 'cpu' ? 'cpuAvg' : metric;
  const rows = []; const clusters = [];
  for (const { deviceId, perf } of perfs || []) {
    const ns = (perf?.nodes || []).filter((n) => n[key] != null && Number.isFinite(n[key]));
    if (!ns.length) continue;
    const sum = ns.reduce((a, b) => a + b[key], 0);
    const mean = sum / ns.length;
    const dist = ns.map((n) => ({ lnn: n.lnn, ratio: mean > 0 ? r1(n[key] / mean) : null }));
    const max = dist.reduce((a, b) => ((b.ratio ?? -1) > (a.ratio ?? -1) ? b : a), dist[0]);
    clusters.push({ deviceId, nodes: dist, maxRatio: max.ratio, maxLnn: max.lnn, skewed: max.ratio != null && max.ratio >= skewFactor });
    for (const n of ns) {
      rows.push({ deviceId, lnn: n.lnn, value: n[key], ratio: mean > 0 ? r1(n[key] / mean) : null, share: sum > 0 ? Math.round((n[key] / sum) * 1000) / 10 : null,
        busyAvg: n.busyAvg, busyMax: n.busyMax, cpuAvg: n.cpuAvg, cpuMax: n.cpuMax, skewed: mean > 0 && n[key] / mean >= skewFactor });
    }
  }
  rows.sort((a, b) => b.value - a.value || String(a.deviceId).localeCompare(String(b.deviceId)) || a.lnn - b.lnn);
  const total = rows.reduce((a, b) => a + b.value, 0);
  const top = rows.slice(0, Math.max(1, Math.min(50, limit)));
  const topShare = total > 0 && (metric === 'ops' || metric === 'net') ? Math.round((top.reduce((a, b) => a + b.value, 0) / total) * 1000) / 10 : null;
  return { rows: top, nodesTotal: rows.length, topShare, clusters: clusters.sort((a, b) => (b.maxRatio ?? 0) - (a.maxRatio ?? 0)) };
}
