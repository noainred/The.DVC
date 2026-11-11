/**
 * storage/inspect/view.js — 점검 **화면 · 보고서 · 메일 공용 모델**(v2.965). 장비 호출 0(이력 + 수집 스냅샷 + 노드 부하 DB).
 *
 *  · 장비마다 최신 점검(store) → judge.judgeDevice(+ perf 7일 — 그 점검 시각에서 거꾸로 7일). 지난 점검과 비교(diffItems — 장비 명령 항목만).
 *  · 법인 = 장비의 datacenterId(법인 · vCenter · 엣지 1:1:1 — CLAUDE.md). 이름은 datacenter 등록부.
 *  · 비관리자 판본: 장비 이름이 주소이면 가리고(maskDeviceAddress) 사유 · 오류 문구 속 주소도 가린다(scrubHosts). 엣지 이름은 그대로(운영 단위).
 *  · perf 는 (장비, 창 끝) 로 10분 기억한다 — 같은 점검의 창은 바뀌지 않는다.
 */
import { listDevices, registryLoadError } from '../registry.js';
import { localSnapshots } from '../store.js';
import { edgeStorageSnapshots } from '../../central/storageEdge.js';
import { latestMapByDevice } from '../latestSnapshots.js';
import { listDatacenters } from '../../datacenter/store.js';
import { maskDeviceAddress, scrubHosts } from '../../auth/addressMask.js';
import { isMockMode, isDemoId } from '../../mock/demo/storage.js';
import { judgeDevice, summarize, groupStatus, diffItems, thresholdsOf } from './judge.js';
import { devicePerf, topNodes, PERF_METRICS } from './perf.js';
import { runsOf } from './store.js';
import { createYielder } from '../../util/timeSlice.js';
import { inspectRequestState } from './requests.js';

export const WEEK_MS = 7 * 86_400_000;
export const STALE_MS = 8 * 86_400_000; // 반증 F4: 주간 회차 + 하루 — 넘은 실행은 확인 불가(값은 참고)
const PERF_TTL_MS = 10 * 60_000;
const _perf = new Map(); // `${id}|${to}` → { at, v }
async function perfOf(id, to, yielder = null) {
  const k = `${id}|${to}`;
  const hit = _perf.get(k);
  if (hit && Date.now() - hit.at < PERF_TTL_MS) return hit.v;
  const v = await devicePerf(id, { from: to - WEEK_MS, to, yielder });
  _perf.set(k, { at: Date.now(), v });
  while (_perf.size > 2_000) _perf.delete(_perf.keys().next().value);
  return v;
}
export function _resetViewForTest() { _perf.clear(); }

/** 점검 대상 장비 목록(전 노드 — 위임 포함). live 에서는 mock- 장비를 뺀다. */
export function inspectDevices() {
  return listDevices().filter((d) => d && d.type === 'isilon' && d.enabled !== false && (isMockMode() || !isDemoId(d.id)));
}
function corpMap() { try { return new Map(listDatacenters().map((d) => [String(d.id), String(d.name || d.id)])); } catch { return new Map(); } }

/**
 * 전체 모델 — 법인별 현황 · 장비별 판정. admin=false 면 주소 가림 판본.
 * @returns {Promise<{generatedAt, thresholds, devices, corps, totals, registryError}>}
 */
export async function buildInspectModel({ now = Date.now(), admin = false, thresholds = null, withItems = true, filter = null } = {}) {
  const t = thresholdsOf(thresholds);
  const devs = inspectDevices().filter((d) => !filter || filter(d.id));
  const snaps = latestMapByDevice([localSnapshots(), edgeStorageSnapshots()]);
  const corps = corpMap();
  const hosts = devs.map((d) => d.host).filter(Boolean);
  const scrub = (s) => (admin || typeof s !== 'string' ? s : scrubHosts(s, hosts));
  // 반증 E2: 오류 · 사유 문구에는 등록 주소가 아니라 **해석된 IP**(ECONNREFUSED 10.x.x.x:22 등)가 실린다 — 비관리자 판본은 IPv4 모양도 가린다(문구는 160자 상한이라 선형).
  const scrubMsg = (s) => (admin || typeof s !== 'string' ? s : scrub(s).replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g, '(주소 가림)'));
  const out = [];
  const y = createYielder(15);
  for (const d of devs) {
    const runs = runsOf(d.id, 2);
    const run = runs[0] || null; const prev = runs[1] || null;
    // 반증 F6: 점검 전 장비는 창 끝을 정시로 내린다 — now 그대로면 기억(perfOf)이 요청마다 빗나가 매번 DB 를 다시 읽었다.
    const to = run?.at ?? Math.floor(now / 3_600_000) * 3_600_000;
    const perf = await perfOf(d.id, to, y);
    const staleDays = run && now - run.at > STALE_MS ? Math.floor((now - run.at) / 86_400_000) : 0;
    const items = judgeDevice(run, perf, t, { staleDays }).map((i) => (admin ? i : { ...i, value: scrub(i.value), ...(i.why ? { why: scrubMsg(i.why) } : {}) }));
    const prevItems = prev ? judgeDevice(prev, null, t).filter((i) => i.id !== 'disk-busy' && i.id !== 'node-skew') : null;
    const snap = snaps.get(d.id) || null;
    const name0 = String(snap?.name || d.name || d.id);
    const name = admin ? name0 : maskDeviceAddress({ ...d, name: name0 }).name;
    const sum = summarize(items);
    out.push({
      id: d.id, name, corp: d.datacenterId || '', corpName: corps.get(String(d.datacenterId)) || (d.datacenterId ? String(d.datacenterId) : '법인 미지정'),
      agent: d.agent || '', method: d.collectMethod === 'ssh' ? 'ssh' : 'api', version: run?.facts?.version || snap?.version || '',
      nodeCount: run?.facts?.nodeCount ?? snap?.nodes?.count ?? null, capacityPct: run?.facts?.capacity?.pct ?? snap?.capacity?.pct ?? null,
      run: run ? { at: run.at, ms: run.ms, method: run.method, partial: !!run.partial, ...(staleDays ? { staleDays } : {}), errors: run.errors.map((e) => ({ ...e, error: scrubMsg(e.error) })) } : null,
      ...(withItems ? { items } : {}), summary: sum, groups: groupStatus(items),
      diff: prevItems ? diffItems(items.filter((i) => i.id !== 'disk-busy' && i.id !== 'node-skew'), prevItems) : { worse: [], better: [], base: false },
      prevAt: prev?.at ?? null, skew: perf?.skew || null, perfSamples: perf?.samples || 0,
      request: d.agent ? (() => { const s = inspectRequestState(d.id); return s ? { state: s.state } : null; })() : null,
    });
  }
  const rank = { bad: 0, warn: 1, unknown: 2, ok: 3, na: 4 };
  out.sort((a, b) => (rank[a.summary.overall] - rank[b.summary.overall]) || String(a.corpName).localeCompare(String(b.corpName)) || String(a.name).localeCompare(String(b.name)));
  const byCorp = new Map();
  for (const d of out) { const k = d.corp || ''; if (!byCorp.has(k)) byCorp.set(k, { key: k, name: d.corpName, devices: [] }); byCorp.get(k).devices.push(d.id); }
  const totals = { ok: 0, warn: 0, bad: 0, unknown: 0, na: 0, total: 0, devices: out.length, inspected: out.filter((d) => d.run).length,
    nodes: out.reduce((a, d) => a + (Number(d.nodeCount) || 0), 0), nodesUnknown: out.filter((d) => !(Number(d.nodeCount) > 0)).length, corps: byCorp.size }; // 반증 F15: 노드 수를 모르는 장비는 0 으로 더하지 않고 따로 센다
  for (const d of out) for (const k of ['ok', 'warn', 'bad', 'unknown', 'na', 'total']) totals[k] += d.summary[k];
  return { generatedAt: now, thresholds: t, devices: out, corps: [...byCorp.values()], totals, registryError: !!registryLoadError() };
}

/** 장비 하나 — 최신 판정 + 이력(최근 N회 구분별 대표 상태). */
export async function buildDeviceDetail(id, { admin = false, thresholds = null, history = 10 } = {}) {
  const m = await buildInspectModel({ admin, thresholds, filter: (x) => String(x) === String(id) });
  const d = m.devices.find((x) => String(x.id) === String(id));
  if (!d) return null;
  const t = thresholdsOf(thresholds);
  const runs = runsOf(id, history);
  // 비교는 장비 항목만(포탈 표본 — disk-busy · node-skew — 은 회차 시각이 아니라 조회 시각 기준이라 뺀다). 장비 항목이 없는 구분(성능)은 키를 싣지 않는다('해당 없음' 으로 그려지지 않게).
  const hist = runs.map((r) => {
    const items = judgeDevice(r, null, t).filter((i) => i.id !== 'disk-busy' && i.id !== 'node-skew');
    const groups = groupStatus(items);
    for (const g of Object.keys(groups)) if (!items.some((i) => i.group === g)) delete groups[g];
    return { at: r.at, groups, summary: summarize(judgeDevice(r, null, t)) };
  });
  return { ...d, history: hist, thresholds: t };
}

/** Top N 노드 — range: 24h · 7d · 30d(지금에서 거꾸로) · metric: ops · net · busy · cpu. */
export async function buildTopNodes({ range = '7d', metric = 'ops', limit = 10, admin = false, now = Date.now(), thresholds = null, filter = null } = {}) {
  const days = range === '24h' ? 1 : range === '30d' ? 30 : 7;
  const m = PERF_METRICS[metric] ? metric : 'ops';
  const t = thresholdsOf(thresholds);
  const devs = inspectDevices().filter((d) => !filter || filter(d.id));
  const corps = corpMap();
  const hourEnd = Math.floor(now / 3_600_000) * 3_600_000; // 정시 경계 — 같은 시간 안의 요청은 같은 창(기억 적중)
  const perfs = [];
  const y = createYielder(15);
  for (const d of devs) perfs.push({ deviceId: d.id, perf: days === 7 ? await perfOf(d.id, hourEnd, y) : await devicePerf(d.id, { from: hourEnd - days * 86_400_000, to: hourEnd, yielder: y }) });
  const top = topNodes(perfs, { metric: m, limit, skewFactor: t.skewFactor });
  const meta = new Map(devs.map((d) => [d.id, d]));
  const snaps = latestMapByDevice([localSnapshots(), edgeStorageSnapshots()]);
  const nameOf = (id) => { const d = meta.get(id); const n0 = String(snaps.get(id)?.name || d?.name || id); return admin ? n0 : maskDeviceAddress({ ...d, name: n0 }).name; };
  const corpOf = (id) => { const c = meta.get(id)?.datacenterId; return corps.get(String(c)) || (c ? String(c) : '법인 미지정'); };
  return {
    range, metric: m, metricLabel: PERF_METRICS[m].label, unit: PERF_METRICS[m].unit, from: hourEnd - days * 86_400_000, to: hourEnd, skewFactor: t.skewFactor,
    rows: top.rows.map((r) => ({ ...r, name: nameOf(r.deviceId), corpName: corpOf(r.deviceId) })),
    clusters: top.clusters.map((c) => ({ ...c, name: nameOf(c.deviceId), corpName: corpOf(c.deviceId) })),
    nodesTotal: top.nodesTotal, topShare: top.topShare, devices: devs.length, devicesWithData: top.clusters.length,
  };
}
