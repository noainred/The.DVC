/**
 * storage/collectors/arrayPerf.js — 어레이 **프런트엔드 성능 5분 표본**(v2.952 · SAN 스토리지 성능 ⓑ · 설계 `docs/design/san-storage-perf/README.md` §4.2).
 *
 * 어레이가 스스로 보고하는 디렉터 · 노드 · SP 성능을 읽어 노드 부하 표본(storage/nodeLoad.js — 5분 표본 경로 · DB · 엣지 push · 조회)에 싣는다.
 * 스위치 처리량(SAN 포트 사용량)과 **같은 단위 이름**(FA-1D · Node A · SPA)으로 묶여 'SAN 스토리지 성능' 상세 ② 와 성능 점검 어레이 측 5항목이 쓴다.
 *
 *   벤더           단위(kind)        경로(문서)                                                         지표 → 표본 열
 *   PowerMax·VMAX  FE 디렉터(fa)     POST /univmax/restapi[/버전]/performance/FEDirector/keys · /metrics   PercentBusy→busy · HostIOs→iops · HostMBs→hbps(×1e6) ·
 *                                                                                                      Read/WriteResponseTime→lat(둘 중 큰 값) · QueueDepthUtilization→queue
 *   PowerStore     노드(node)·포트(port) POST /api/rest/metrics/generate performance_metrics_by_node · _by_fe_fc_port   total_iops→iops · avg_latency(µs→ms)→lat ·
 *                                                                                                      read+write_bandwidth(B/s)→hbps · cpu_utilization(있을 때만)→cpu
 *   Unity          SP(sp)·포트(port)  GET /api/types/metricValue/instances?filter=path EQ "…"            sp.*.cpu.summary.utilization→cpu ·
 *                                                                                                      sp.*.fibreChannel.target.*.readBytes/writeBytes(누적 → 델타/초)→hbps · reads/writes(누적)→iops
 *
 * ⚠⚠ 정직 기록 — **실장비 미확인**(isilonNodeLoad.js 와 같은 수준): 경로는 벤더 문서(README §9)에서, 응답 필드 이름은 문서 · 공개 예제에서 가져왔고 실제 장비로
 *   확인하지 못했다. 그래서 파서는 전부 **순수 함수**(픽스처 테스트)이고, 못 읽은 값은 null + `probe` 에 무엇을 읽었고 무엇이 없었는지 남긴다 —
 *   첫 실장비 표본의 probe(fields · errors)를 보고 파서만 맞추면 된다(캡처 가이드 `CAPTURE-GUIDE.md`). 값을 지어내지 않는다(0 으로 채우지 않는다).
 *
 * 규약(CLAUDE.md): 조회 전용 POST 만(restCommon.makePoster 머리말) · 401 은 즉시 던져 계정 잠금을 막는다(isCredReject — authGuard 가 멈춘다) ·
 *   단위 64 상한(NODE_LOAD_LIMIT — 디렉터/노드/SP 먼저, 포트는 남는 자리만) · 문자열 수치는 수로(numOrNull) · 장비 시한은 폴러가 signal 로 끊는다.
 */
import { numOrNull } from '../../util/numOrNull.js';
import { makeGetter, makeRawGetter, makePoster, isCredReject } from './restCommon.js';
import { apiVersionsFrom, pathsFor } from './powermax.js';
import { NODE_LOAD_LIMIT, unitIdOf } from '../nodeLoad.js';

/** 어레이 측 표본을 읽는 장비 타입(REST 수집 방식만 — SSH(uemcli · pstcli) 변형은 성능 경로가 없다). registry · 폴러 · 화면이 같이 쓴다. */
export const FE_PERF_TYPES = Object.freeze(['powermax', 'vmax', 'powerstore', 'unity480']);
export const isFePerfType = (type) => FE_PERF_TYPES.includes(String(type || ''));
/** 표본 열(노드 부하 표의 fe 묶음과 같은 순서). */
export const FE_KEYS = Object.freeze(['busy', 'cpu', 'iops', 'lat', 'hbps', 'queue']);
/** PowerMax FE 디렉터 지표 — 전체 묶음이 거부되면(지원하지 않는 지표 · 400) 핵심 3개로 한 번 더. */
export const PMAX_FE_METRICS = Object.freeze(['PercentBusy', 'HostIOs', 'HostMBs', 'ReadResponseTime', 'WriteResponseTime', 'QueueDepthUtilization']);
export const PMAX_FE_CORE = Object.freeze(['PercentBusy', 'HostIOs', 'HostMBs']);
export const PMAX_WINDOW_MS = 20 * 60_000;   // 진단(5분) 표본 몇 개가 들어오는 창 — 마지막 점만 쓴다
/** v2.955 PowerMax FE **포트** 단위(performance/FEPort keys → metrics · 문서 기준 — 실장비 확인 전). 디렉터(부모)를 다 읽은 뒤 남는 자리에만 · 호출 상한(디렉터당 · 전체). */
export const PMAX_FE_PORT_METRICS = Object.freeze(['PercentBusy', 'IOs', 'MBs', 'ResponseTime']);
export const PMAX_FE_PORT_CORE = Object.freeze(['PercentBusy', 'IOs', 'MBs']);
export const PMAX_PORTS_PER_DIR = 4;
export const PMAX_PORT_CALLS_MAX = 24;
export const MAX_ARRAYS = 4;                 // Unisphere 하나가 관리하는 로컬 어레이 상한(powermax.js MAX_LOCAL_ARRAYS 와 같은 뜻)
export const UNITY_CPU_PATH = 'sp.*.cpu.summary.utilization';
export const UNITY_FC_PATHS = Object.freeze({ readBytes: 'sp.*.fibreChannel.target.*.readBytes', writeBytes: 'sp.*.fibreChannel.target.*.writeBytes',
  reads: 'sp.*.fibreChannel.target.*.reads', writes: 'sp.*.fibreChannel.target.*.writes' });
export const LAT_UNIT_NOTE = { powermax: 'ms(문서)', powerstore: 'us→ms(가정)', unity480: '없음(SP 단위 응답 시간 경로 미사용)' };
export const HBPS_NOTE = { powermax: 'HostMBs×1e6', powerstore: 'read_bandwidth+write_bandwidth(B/s)', unity480: 'FC target readBytes+writeBytes 누적 델타/초' };

const str = (v, max = 60) => (typeof v === 'string' ? v.trim().slice(0, max) : (typeof v === 'number' ? String(v) : ''));
const pct = (v) => { const n = numOrNull(v); return n == null || n < 0 || n > 100 ? null : n; };
const nonneg = (v) => { const n = numOrNull(v); return n == null || n < 0 ? null : n; };
const r1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
const capErr = (e) => String(e?.message || e || '').slice(0, 160);
/** 타입 → 단위 종류(부모 단위). */
export const unitKindOf = (type) => (type === 'powerstore' ? 'node' : type === 'unity480' ? 'sp' : 'fa');

/* ── 표본 조립(순수) ───────────────────────────────────────────────────────── */
/**
 * 단위 행 → 노드 부하 표본. 부모 단위(fa·node·sp)가 먼저, 포트는 남는 자리(64 상한)만 — 상한에 걸려 뺀 수를 probe 에 적는다.
 * @param {{ts:number, type:string, source:string, units:Array<{name:string, kind:string, parent?:string|null, busy?,cpu?,iops?,lat?,hbps?,queue?}>, probe?:object}} input
 * @returns {{ts:number, nodes:Array<object>, units:Array<{id:number,name:string,kind:string,parent:number|null}>, probe:object}}
 */
export function buildFeSample({ ts, type, source = '', units = [], probe = {} }) {
  const parents = units.filter((u) => u && u.kind !== 'port');
  const ports = units.filter((u) => u && u.kind === 'port');
  const room = Math.max(0, NODE_LOAD_LIMIT - Math.min(parents.length, NODE_LOAD_LIMIT));
  const pick = [...parents.slice(0, NODE_LOAD_LIMIT), ...ports.slice(0, room)];
  const nodes = []; const catalog = []; const seen = new Set();
  for (const u of pick) {
    const name = str(u.name, 60); if (!name) continue;
    const id = unitIdOf(name); if (seen.has(id)) continue;
    seen.add(id);
    const parent = u.parent ? unitIdOf(u.parent) : null;
    catalog.push({ id, name, kind: u.kind || unitKindOf(type), parent });
    nodes.push({ id, busy: pct(u.busy), cpu: pct(u.cpu), iops: nonneg(u.iops), lat: nonneg(u.lat) == null ? null : r1(nonneg(u.lat)), hbps: nonneg(u.hbps), queue: pct(u.queue),
      in: null, out: null, din: null, dout: null, ops: null, proto: null, clients: [] });
  }
  const measured = (k) => nodes.filter((n) => n[k] != null).length;
  return {
    ts: numOrNull(ts) ?? Date.now(), nodes, units: catalog,
    probe: { source, type, total: nodes.length, parents: Math.min(parents.length, NODE_LOAD_LIMIT), ports: Math.min(ports.length, room),
      omitted: Math.max(0, parents.length - NODE_LOAD_LIMIT) + Math.max(0, ports.length - room),
      measured: Object.fromEntries(FE_KEYS.map((k) => [k, measured(k)])), latUnit: LAT_UNIT_NOTE[type] || '', hbpsBasis: HBPS_NOTE[type] || '', ...probe },
  };
}

/* ── PowerMax · VMAX ─────────────────────────────────────────────────────── */
/** keys 응답 → 디렉터 id 목록(순수). `{feDirectorInfo:[{directorId}]}` — 모양이 다르면 []. */
export function parsePmaxDirectorKeys(data) {
  const list = Array.isArray(data?.feDirectorInfo) ? data.feDirectorInfo : (Array.isArray(data?.directorInfo) ? data.directorInfo : []);
  const out = [];
  for (const d of list) { const id = str(d?.directorId, 40); if (id && !out.includes(id)) out.push(id); if (out.length >= NODE_LOAD_LIMIT) break; }
  return out;
}
/** metrics 응답 → 마지막 점(순수). `{resultList:{result:[{timestamp, PercentBusy, …}]}}`. 못 읽으면 null. 응답 시간은 읽기·쓰기 중 큰 값. */
export function parsePmaxMetrics(data) {
  const rows = Array.isArray(data?.resultList?.result) ? data.resultList.result : (Array.isArray(data?.result) ? data.result : []);
  let last = null;
  for (const r of rows) { if (!r || typeof r !== 'object') continue; const t = numOrNull(r.timestamp); if (last == null || (t ?? -1) >= (numOrNull(last.timestamp) ?? -1)) last = r; }
  if (!last) return null;
  const rd = nonneg(last.ReadResponseTime); const wr = nonneg(last.WriteResponseTime);
  const mbs = nonneg(last.HostMBs);
  return {
    ts: numOrNull(last.timestamp), busy: pct(last.PercentBusy), iops: nonneg(last.HostIOs), hbps: mbs == null ? null : mbs * 1e6,
    lat: rd == null && wr == null ? null : Math.max(rd ?? 0, wr ?? 0), queue: pct(last.QueueDepthUtilization),
    fields: Object.keys(last).filter((k) => k !== 'timestamp').slice(0, 24),
  };
}
/** FEPort/keys 응답 → 포트 id 목록(순수). `{fePortInfo:[{portId, firstAvailableDate, lastAvailableDate}]}` — 중복 제거 · 디렉터당 상한. */
export function parsePmaxPortKeys(data, { max = PMAX_PORTS_PER_DIR } = {}) {
  const list = Array.isArray(data?.fePortInfo) ? data.fePortInfo : (Array.isArray(data?.portInfo) ? data.portInfo : []);
  const out = [];
  for (const p of list) { const id = str(p?.portId, 16); if (id && !out.includes(id)) out.push(id); if (out.length >= max) break; }
  return out;
}
/** FEPort/metrics 응답 → 마지막 점(순수). 포트 지표 이름은 디렉터와 다르다(IOs · MBs · ResponseTime) — 디렉터 이름(HostIOs · HostMBs)으로 와도 읽는다. */
export function parsePmaxPortMetrics(data) {
  const rows = Array.isArray(data?.resultList?.result) ? data.resultList.result : (Array.isArray(data?.result) ? data.result : []);
  let last = null;
  for (const r of rows) { if (!r || typeof r !== 'object') continue; const t = numOrNull(r.timestamp); if (last == null || (t ?? -1) >= (numOrNull(last.timestamp) ?? -1)) last = r; }
  if (!last) return null;
  const mbs = nonneg(last.MBs ?? last.HostMBs);
  const rd = nonneg(last.ReadResponseTime); const wr = nonneg(last.WriteResponseTime); const rt = nonneg(last.ResponseTime);
  return {
    ts: numOrNull(last.timestamp), busy: pct(last.PercentBusy), iops: nonneg(last.IOs ?? last.HostIOs), hbps: mbs == null ? null : mbs * 1e6,
    lat: rt != null ? rt : (rd == null && wr == null ? null : Math.max(rd ?? 0, wr ?? 0)), queue: null,
    fields: Object.keys(last).filter((k) => k !== 'timestamp').slice(0, 24),
  };
}
async function tryPost(post, paths, body) {
  let err;
  for (const p of paths) { try { return { data: await post(p, body), path: p }; } catch (e) { err = e; if (isCredReject(e)) throw e; } }
  throw err;
}
/** 지원하지 않는 지표를 보내면 Unisphere 가 400 을 돌려준다(문구에 metric 이 든다) — 그때만 핵심 묶음으로 한 번 더. */
const looksUnsupportedMetric = (e) => /metric|400|bad request/i.test(String(e?.message || ''));

export async function samplePowermax(full, { signal = null, now = Date.now(), port = Number(process.env.STORAGE_UNISPHERE_PORT) || 8443 } = {}) {
  const get = makeGetter(full, { port, signal });
  const post = makePoster(full, { port, signal });
  const probe = { arrays: 0, directors: 0, read: 0, failed: 0, errors: [], metricSet: 'full' };
  let version = null;
  try { version = await get('/univmax/restapi/version'); } catch (e) { if (isCredReject(e)) throw e; }
  const { vers } = apiVersionsFrom(version);
  // 로컬 어레이 — 용량 수집과 같은 경로(원격 SRDF 상대는 뺀다). 못 읽으면 표본 없음(이유를 던진다).
  let ids = [];
  let listErr = null;
  for (const p of pathsFor(vers, '/system/symmetrix')) {
    try { const d = await get(p); ids = Array.isArray(d?.symmetrixId) ? d.symmetrixId.map((x) => str(x, 24)).filter(Boolean) : []; listErr = null; break; }
    catch (e) { if (isCredReject(e)) throw e; listErr = e; }
  }
  if (listErr && !ids.length) throw new Error(`어레이 목록 조회 실패: ${capErr(listErr)}`);
  const locals = [];
  for (const id of ids.slice(0, MAX_ARRAYS * 2)) {
    if (signal?.aborted) break;
    try {
      let a = null;
      for (const p of pathsFor(vers, `/system/symmetrix/${encodeURIComponent(id)}`)) { try { const d = await get(p); a = Array.isArray(d?.symmetrix) ? d.symmetrix[0] : d?.symmetrix || d; break; } catch (e) { if (isCredReject(e)) throw e; } }
      if (a && a.local === false) continue;
      locals.push(String(a?.symmetrixId || id));
      if (locals.length >= MAX_ARRAYS) break;
    } catch (e) { if (isCredReject(e)) throw e; probe.errors.push(`${id}: ${capErr(e)}`); }
  }
  probe.arrays = locals.length;
  const units = [];
  const multi = locals.length > 1;
  for (const sid of locals) {
    if (signal?.aborted) break;
    let dirs = [];
    try {
      const r = await tryPost(post, pathsFor(vers, '/performance/FEDirector/keys'), { symmetrixId: sid });
      probe.keysPath = r.path;
      dirs = parsePmaxDirectorKeys(r.data);
    } catch (e) { if (isCredReject(e)) throw e; probe.errors.push(`keys ${sid}: ${capErr(e)}`); continue; }
    probe.directors += dirs.length;
    for (const dirId of dirs) {
      if (signal?.aborted || units.length >= NODE_LOAD_LIMIT) break;
      const body = (metrics) => ({ symmetrixId: sid, directorId: dirId, startDate: now - PMAX_WINDOW_MS, endDate: now, dataFormat: 'Average', metrics: [...metrics] });
      let parsed = null;
      try {
        let r;
        try { r = await tryPost(post, pathsFor(vers, '/performance/FEDirector/metrics'), body(probe.metricSet === 'core' ? PMAX_FE_CORE : PMAX_FE_METRICS)); }
        catch (e) {
          if (isCredReject(e)) throw e;
          if (probe.metricSet === 'full' && looksUnsupportedMetric(e)) { probe.metricSet = 'core'; probe.fullSetError = capErr(e); r = await tryPost(post, pathsFor(vers, '/performance/FEDirector/metrics'), body(PMAX_FE_CORE)); }
          else throw e;
        }
        probe.metricsPath = r.path;
        parsed = parsePmaxMetrics(r.data);
        if (parsed) { probe.read += 1; if (!probe.fields) probe.fields = parsed.fields; } else probe.errors.push(`${dirId}: 점 없음`);
      } catch (e) { if (isCredReject(e)) throw e; probe.failed += 1; if (probe.errors.length < 8) probe.errors.push(`${dirId}: ${capErr(e)}`); }
      // Unisphere 하나가 어레이 여럿을 관리하면 이름을 어레이 번호로 구분한다(상세는 시리얼로 자기 것만 고른다 — arraySide.unitsForArray).
      units.push({ name: multi ? `${sid}::${dirId}` : dirId, kind: 'fa', ...(parsed || {}) });
    }
    // v2.955 포트 단위 — 디렉터를 다 읽은 뒤, 남는 자리(64 상한)와 호출 상한(전체 PMAX_PORT_CALLS_MAX · 디렉터당 PMAX_PORTS_PER_DIR) 안에서만. 문서 기준(실장비 확인 전) — probe.ports 가 읽은 수 · 실패를 말한다.
    probe.ports = probe.ports || { read: 0, failed: 0, calls: 0, skipped: 0 };
    for (const dirId of dirs) {
      if (signal?.aborted || units.length >= NODE_LOAD_LIMIT || probe.ports.calls >= PMAX_PORT_CALLS_MAX) { probe.ports.skipped += 1; continue; }
      let portIds = [];
      try { probe.ports.calls += 1; const r = await tryPost(post, pathsFor(vers, '/performance/FEPort/keys'), { symmetrixId: sid, directorId: dirId }); portIds = parsePmaxPortKeys(r.data); }
      catch (e) { if (isCredReject(e)) throw e; probe.ports.failed += 1; if (probe.errors.length < 8) probe.errors.push(`port keys ${dirId}: ${capErr(e)}`); continue; }
      const parentName = multi ? `${sid}::${dirId}` : dirId;
      for (const portId of portIds) {
        if (signal?.aborted || units.length >= NODE_LOAD_LIMIT || probe.ports.calls >= PMAX_PORT_CALLS_MAX) { probe.ports.skipped += 1; break; }
        const pbody = (metrics) => ({ symmetrixId: sid, directorId: dirId, portId, startDate: now - PMAX_WINDOW_MS, endDate: now, dataFormat: 'Average', metrics: [...metrics] });
        let parsed = null;
        try {
          probe.ports.calls += 1;
          let r;
          try { r = await tryPost(post, pathsFor(vers, '/performance/FEPort/metrics'), pbody(probe.portMetricSet === 'core' ? PMAX_FE_PORT_CORE : PMAX_FE_PORT_METRICS)); }
          catch (e) {
            if (isCredReject(e)) throw e;
            if (probe.portMetricSet !== 'core' && looksUnsupportedMetric(e)) { probe.portMetricSet = 'core'; r = await tryPost(post, pathsFor(vers, '/performance/FEPort/metrics'), pbody(PMAX_FE_PORT_CORE)); }
            else throw e;
          }
          parsed = parsePmaxPortMetrics(r.data);
          if (parsed) probe.ports.read += 1; else probe.ports.failed += 1;
        } catch (e) { if (isCredReject(e)) throw e; probe.ports.failed += 1; if (probe.errors.length < 8) probe.errors.push(`port ${dirId}:${portId}: ${capErr(e)}`); }
        units.push({ name: `${parentName}:${portId}`, kind: 'port', parent: parentName, ...(parsed || {}) });
      }
    }
  }
  if (!units.length) throw new Error(probe.errors[0] ? `FE 디렉터를 읽지 못했습니다 — ${probe.errors[0]}` : 'FE 디렉터가 없습니다(keys 응답 비어 있음)');
  return buildFeSample({ ts: now, type: 'powermax', source: probe.ports?.read ? 'Unisphere performance/FEDirector + FEPort' : 'Unisphere performance/FEDirector', units, probe });
}

/* ── PowerStore ──────────────────────────────────────────────────────────── */
/** 노드 목록 → 단위(순수). slot 0 → Node A · 1 → Node B(PowerStore 표기) · 그 밖은 `Node <slot>`. */
export function parsePstoreNodes(list) {
  const out = [];
  for (const n of Array.isArray(list) ? list : []) {
    if (!n || typeof n !== 'object') continue;
    const id = str(n.id, 64); if (!id) continue;
    const slot = numOrNull(n.slot);
    const name = slot === 0 ? 'Node A' : slot === 1 ? 'Node B' : slot != null ? `Node ${slot}` : `Node ${id.slice(0, 8)}`;
    out.push({ pid: id, name, slot });
    if (out.length >= 16) break;
  }
  return out;
}
/** FC 포트 목록 → 단위(순수). 이름은 `Node A FC0` 꼴로 줄인다(SAN 심볼릭 이름 'NodeA FC0' 과 같은 비교 키) — 못 줄이면 원문. */
export function parsePstorePorts(list, nodes) {
  const byNode = new Map((nodes || []).map((n) => [n.pid, n.name]));
  const out = [];
  for (const p of Array.isArray(list) ? list : []) {
    if (!p || typeof p !== 'object') continue;
    const id = str(p.id, 64); if (!id) continue;
    const parent = byNode.get(str(p.node_id, 64)) || null;
    const raw = str(p.name, 80);
    const m = /Node([A-Z])(?![A-Za-z])[\s\S]{0,40}?(?:FEPort|Port|FC)\s*-?(\d+)/i.exec(raw);   // BaseEnclosure-NodeA-IoModule0-FEPort0 → Node A FC0
    const idx = numOrNull(p.port_index);
    const name = m ? `Node ${m[1].toUpperCase()} FC${m[2]}` : (parent && idx != null ? `${parent} FC${idx}` : raw || id);
    out.push({ pid: id, name, parent, wwn: str(p.wwn, 32) });
    if (out.length >= NODE_LOAD_LIMIT) break;
  }
  return out;
}
/** 두 항이 모두 있을 때만 합(순수 — v2.954 점검 B-3). 한쪽만 읽힌 값은 '합' 이 아니다(못 읽은 값은 0 이 아니다). */
export const bothSum = (x, y) => (x == null || y == null ? null : x + y);
/** metrics/generate 응답 → 마지막 점(순수). 지연은 µs → ms(가정 — probe.latUnit). CPU 는 응답에 있을 때만. */
export function parsePstorePoint(points) {
  const rows = Array.isArray(points) ? points : (points && typeof points === 'object' ? [points] : []);
  let last = null;
  for (const r of rows) { if (!r || typeof r !== 'object') continue; const t = Date.parse(r.timestamp || '') || numOrNull(r.timestamp) || 0; if (!last || t >= last._t) last = { ...r, _t: t }; }
  if (!last) return null;
  // v2.954(점검 B-3): total 이 없으면 읽기 · 쓰기가 **둘 다** 있을 때만 합(한쪽만이면 부분 합 — null · flowView.esxiBpsOf 와 같은 규칙).
  const ri = nonneg(last.read_iops); const wi = nonneg(last.write_iops);
  const iops = nonneg(last.total_iops) ?? bothSum(ri, wi);
  const rb = nonneg(last.read_bandwidth); const wb = nonneg(last.write_bandwidth);
  const hbps = nonneg(last.total_bandwidth) ?? bothSum(rb, wb);
  const latUs = nonneg(last.avg_latency);
  const cpu = pct(last.cpu_utilization ?? last.avg_cpu_utilization ?? last.cpu_utilization_pct);
  return { ts: last._t || null, iops, hbps, lat: latUs == null ? null : latUs / 1000, cpu, fields: Object.keys(last).filter((k) => k !== '_t').slice(0, 24) };
}
async function pstoreGenerate({ post, rawGet, csrf }, entity, entityId) {
  let token = csrf.token;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return await post('/api/rest/metrics/generate', { entity, entity_id: String(entityId ?? ''), interval: 'Five_Mins' }, token ? { 'DELL-EMC-TOKEN': token } : {}); }
    catch (e) {
      if (isCredReject(e)) throw e;
      if (attempt === 0 && /token|csrf|403|422/i.test(String(e.message))) {
        try { const r = await rawGet('/api/rest/login_session'); const t = r.headers.get('DELL-EMC-TOKEN') || r.headers.get('dell-emc-token') || null; if (t && t !== token) { token = t; csrf.token = t; continue; } }
        catch (e2) { if (isCredReject(e2)) throw e2; }
      }
      throw e;
    }
  }
  return null;
}
export async function samplePowerstore(full, { signal = null, now = Date.now(), port = Number(process.env.STORAGE_POWERSTORE_PORT) || 443, withPorts = true } = {}) {
  const get = makeGetter(full, { port, signal });
  const rawGet = makeRawGetter(full, { port, signal });
  const post = makePoster(full, { port, signal });
  const probe = { read: 0, failed: 0, errors: [] };
  const csrf = { token: null };
  // 첫 GET 의 응답 헤더에서 CSRF 토큰(powerstore.js 와 같은 규약). 401 은 여기서 던진다.
  const nodesRes = await rawGet('/api/rest/node?select=id,slot,appliance_id');
  csrf.token = nodesRes.headers.get('DELL-EMC-TOKEN') || nodesRes.headers.get('dell-emc-token') || null;
  const nodes = parsePstoreNodes(nodesRes.body);
  if (!nodes.length) throw new Error('노드 목록이 비어 있습니다(/api/rest/node)');
  const units = [];
  for (const n of nodes) {
    if (signal?.aborted) break;
    try {
      const pts = await pstoreGenerate({ post, rawGet, csrf }, 'performance_metrics_by_node', n.pid);
      const p = parsePstorePoint(pts);
      if (p) { probe.read += 1; if (!probe.fields) probe.fields = p.fields; } else probe.errors.push(`${n.name}: 점 없음`);
      units.push({ name: n.name, kind: 'node', ...(p || {}) });
    } catch (e) { if (isCredReject(e)) throw e; probe.failed += 1; if (probe.errors.length < 8) probe.errors.push(`${n.name}: ${capErr(e)}`); units.push({ name: n.name, kind: 'node' }); }
  }
  if (withPorts && !signal?.aborted) {
    try {
      const list = await get('/api/rest/fc_port?select=id,name,wwn,node_id,port_index');
      const ports = parsePstorePorts(list, nodes);
      probe.portsListed = ports.length;
      for (const p of ports) {
        if (signal?.aborted || units.length >= NODE_LOAD_LIMIT) break;
        try {
          const pts = await pstoreGenerate({ post, rawGet, csrf }, 'performance_metrics_by_fe_fc_port', p.pid);
          const v = parsePstorePoint(pts);
          units.push({ name: p.name, kind: 'port', parent: p.parent, ...(v ? { iops: v.iops, hbps: v.hbps, lat: v.lat } : {}) });
        } catch (e) { if (isCredReject(e)) throw e; if (probe.errors.length < 8) probe.errors.push(`${p.name}: ${capErr(e)}`); units.push({ name: p.name, kind: 'port', parent: p.parent }); }
      }
    } catch (e) { if (isCredReject(e)) throw e; probe.portsError = capErr(e); }
  }
  return buildFeSample({ ts: now, type: 'powerstore', source: 'PowerStore metrics/generate', units, probe });
}

/* ── Unity ───────────────────────────────────────────────────────────────── */
/**
 * metricValue 응답 → 시각 내림차순 항목(순수). `{entries:[{content:{path, timestamp, interval, values}}]}`.
 * values 는 `{spa: 12.3, spb: 10}`(SP 단위) 또는 `{spa: {spa_fc4: 123}, spb: {…}}`(포트 단위 — 두 번째 키가 포트).
 */
export function parseUnityEntries(data) {
  const list = Array.isArray(data?.entries) ? data.entries : [];
  const out = [];
  for (const e of list) {
    const c = e?.content || e;
    if (!c || typeof c !== 'object' || !c.values || typeof c.values !== 'object') continue;
    const ts = Date.parse(c.timestamp || '') || null;
    out.push({ ts, interval: numOrNull(c.interval), values: c.values, path: str(c.path, 80) });
  }
  return out.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
}
/** SP 단위 값 — 최신 항목의 {spa, spb}. 값이 객체(포트별)면 합(cpu 는 합이 아니라 null). */
export function unitySpLatest(entries, { sum = false } = {}) {
  const e = entries[0]; if (!e) return {};
  const out = {};
  for (const [sp, v] of Object.entries(e.values)) {
    if (typeof v === 'object' && v) { if (!sum) continue; let s = 0; let any = false; for (const x of Object.values(v)) { const n = numOrNull(x); if (n != null) { s += n; any = true; } } out[sp] = any ? s : null; }
    else out[sp] = numOrNull(v);
  }
  return out;
}
/**
 * 누적 카운터 경로의 **초당 증가량**(순수) — 최신 두 항목의 차 ÷ 시각 차. SP 합과 포트별을 함께 돌려준다. 항목이 하나뿐이거나 줄어들면(리셋) null.
 * @returns {{perSp:Object<string, number|null>, perPort:Object<string, {sp:string, rate:number|null}>, intervalS:number|null}}
 */
export function unityCounterRate(entries) {
  const [a, b] = entries;                           // a = 최신, b = 그 전
  const perSp = {}; const perPort = {};
  if (!a || !b || !(a.ts > b.ts)) return { perSp, perPort, intervalS: null };
  const dt = (a.ts - b.ts) / 1000;
  for (const [sp, va] of Object.entries(a.values)) {
    const vb = b.values?.[sp];
    if (va && typeof va === 'object') {
      // v2.954(점검 B-3): SP 합은 그 SP 포트를 **전부** 읽었을 때만(리셋 · 누락 포트를 빼고 나머지만 더한 부분 합은 null).
      let s = 0; let all = true; let cnt = 0;
      for (const [port, x] of Object.entries(va)) {
        const n1 = numOrNull(x); const n0 = numOrNull(vb?.[port]);
        const rate = n1 != null && n0 != null && n1 >= n0 ? (n1 - n0) / dt : null;
        perPort[port] = { sp, rate };
        cnt += 1;
        if (rate != null) s += rate; else all = false;
      }
      if (vb && typeof vb === 'object') for (const port of Object.keys(vb)) if (!Object.hasOwn(va, port)) all = false;   // 직전에 있던 포트가 최신 항목에서 빠짐
      perSp[sp] = all && cnt > 0 ? s : null;
    } else {
      const n1 = numOrNull(va); const n0 = numOrNull(vb);
      perSp[sp] = n1 != null && n0 != null && n1 >= n0 ? (n1 - n0) / dt : null;
    }
  }
  return { perSp, perPort, intervalS: dt };
}
const unityPortName = (port) => String(port || '').toUpperCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();   // spa_fc4 → SPA FC4
const spName = (sp) => String(sp || '').toUpperCase();
/**
 * SP · 포트 단위 조립(순수 — v2.954 점검 B-3에서 sampleUnity 밖으로 뺐다). 읽기 + 쓰기는 **둘 다** 있을 때만 합 —
 * 한쪽 경로(writeBytes 등) 조회만 실패하면 부분 합이 '최신 hbps' 가 되어 보고 대조가 거짓 주의였다. partial = 한쪽만 있어 null 로 둔 값 수.
 */
export function unityUnits({ cpu = {}, rb, wb, rd, wr }, { withPorts = true } = {}) {
  let partial = 0;
  const add = (x, y) => { if ((x == null) !== (y == null)) partial += 1; return bothSum(x, y); };
  const sps = new Set([...Object.keys(cpu), ...Object.keys(rb.perSp), ...Object.keys(rd.perSp)]);
  const units = [];
  for (const sp of [...sps].sort()) {
    units.push({ name: spName(sp), kind: 'sp', cpu: cpu[sp] ?? null, hbps: add(rb.perSp[sp], wb.perSp[sp]), iops: add(rd.perSp[sp], wr.perSp[sp]) });
  }
  if (withPorts) {
    const ports = new Set([...Object.keys(rb.perPort), ...Object.keys(rd.perPort)]);
    for (const p of [...ports].sort()) {
      const sp = rb.perPort[p]?.sp || rd.perPort[p]?.sp || '';
      units.push({ name: unityPortName(p), kind: 'port', parent: spName(sp), hbps: add(rb.perPort[p]?.rate, wb.perPort[p]?.rate), iops: add(rd.perPort[p]?.rate, wr.perPort[p]?.rate) });
    }
  }
  return { units, partial };
}
export async function sampleUnity(full, { signal = null, now = Date.now(), port = Number(process.env.STORAGE_UNITY_PORT) || 443, withPorts = true } = {}) {
  const get = makeGetter(full, { port, headers: { 'X-EMC-REST-CLIENT': 'true' }, signal });
  const q = (path, n) => `/api/types/metricValue/instances?filter=path EQ "${path}"&per_page=${n}&compact=true`;
  const probe = { errors: [], paths: {} };
  const fetchEntries = async (key, path, n) => {
    try { const d = await get(q(path, n)); const e = parseUnityEntries(d); probe.paths[key] = e.length; return e; }
    catch (e) { if (isCredReject(e)) throw e; probe.paths[key] = 'error'; if (probe.errors.length < 8) probe.errors.push(`${key}: ${capErr(e)}`); return []; }
  };
  const cpuE = await fetchEntries('cpu', UNITY_CPU_PATH, 4);   // 401 이면 여기서 던진다(첫 호출)
  if (signal?.aborted) throw new Error('수집 취소(타임아웃)');
  const rbE = await fetchEntries('readBytes', UNITY_FC_PATHS.readBytes, 4);
  const wbE = await fetchEntries('writeBytes', UNITY_FC_PATHS.writeBytes, 4);
  const rdE = await fetchEntries('reads', UNITY_FC_PATHS.reads, 4);
  const wrE = await fetchEntries('writes', UNITY_FC_PATHS.writes, 4);
  const cpu = unitySpLatest(cpuE);
  const rb = unityCounterRate(rbE); const wb = unityCounterRate(wbE); const rd = unityCounterRate(rdE); const wr = unityCounterRate(wrE);
  const sps = new Set([...Object.keys(cpu), ...Object.keys(rb.perSp), ...Object.keys(rd.perSp)]);
  if (!sps.size) throw new Error(`SP 값을 읽지 못했습니다(metricValue 비어 있음${probe.errors[0] ? ` — ${probe.errors[0]}` : ''})`);
  const { units, partial } = unityUnits({ cpu, rb, wb, rd, wr }, { withPorts });
  probe.counterIntervalS = rb.intervalS ?? rd.intervalS ?? null;
  if (partial) probe.partialSums = partial;   // 읽기 · 쓰기 한쪽만 읽혀 null 로 둔 값 수(사유는 probe.errors · probe.paths)
  probe.counterNote = rb.intervalS == null ? '누적 항목이 둘 미만 — 첫 표본(또는 이력 수집 꺼짐)이라 처리량 · IOPS 는 null' : '';
  return buildFeSample({ ts: now, type: 'unity480', source: 'Unity metricValue(cpu.summary · fibreChannel.target 누적 델타)', units, probe });
}

/** 타입별 분기 — 폴러가 부른다. 모르는 타입은 null(표본 없음 · 오류 아님). */
export async function sampleArrayPerf(full, opt = {}) {
  const type = String(full?.type || '');
  if (type === 'powermax' || type === 'vmax') return samplePowermax(full, opt);
  if (type === 'powerstore') return samplePowerstore(full, opt);
  if (type === 'unity480') return sampleUnity(full, opt);
  return null;
}
