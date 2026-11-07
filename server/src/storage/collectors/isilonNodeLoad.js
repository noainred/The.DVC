/**
 * storage/collectors/isilonNodeLoad.js — Isilon/PowerScale 노드별 부하(디스크 쓰기·읽기 · CPU) 읽기(v2.926, 순수 모듈).
 *
 * 사용자 요청(2026-11-07): "노드별 io network 부하를 저장하고 차트로" → "Disk io 추가" → 성능 관점 추천 ①(노드 CPU).
 * 네트워크 In/Out 은 예전부터 읽는다(SSH `isi status` 처리량 열 · REST `node.net.ext.bytes.*.rate`). 이 모듈은 **그 옆에
 * 디스크·CPU 를 더하는 것만** 한다 — 장비 왕복을 늘리지 않는 쪽으로:
 *  · REST: 이미 부르는 `statistics/current?devid=all` 의 key 목록에 3개를 더한다(왕복 0).
 *  · SSH : 세션 안에 `isi statistics system --nodes all --format json` 1개(best-effort · 세션 예산 안 · 실패해도 `isi status` 값은 유지).
 *
 * ⚠⚠ 정직 기록 — **실장비에서 본 적이 없다**(OneFS 문서 지식 수준, 수집기 머리말들과 같은 수준):
 *  · REST 키 이름 `node.disk.bytes.{in,out}.rate.sum`(노드의 전 드라이브 합 B/s) · `node.cpu.idle.avg`.
 *  · `node.cpu.idle.avg` 의 단위는 **1/10 % (0~1000)** 로 가정한다(OneFS 의 cpu 통계 키가 per-mille 로 보고된다는 문서 기억).
 *    그 범위를 벗어나는 값은 버린다(null) — 단위를 값마다 추측하지 않는다(값마다 추측하면 모든 노드가 바쁠 때 해석이 뒤집힌다).
 *  · 디스크 In = 쓰기, Out = 읽기 로 화면이 부른다(디스크 기준 '들어감 = 기록'). 첫 실장비 수집에서 방향을 확인할 것.
 *  · `isi statistics system --format json` 의 행 모양·필드 이름. 그래서 셋을 받는다: ① 행 객체 배열 ② `{stats|nodes:[…]}` ③ 그 밖 = 못 읽음(null).
 *    필드 이름은 대소문자·밑줄·공백을 지우고 비교한다(`Disk In` · `disk_in` · `diskIn` 모두 `diskin`).
 *  못 읽은 값은 0 이 아니라 **필드를 만들지 않는다**(numOrNull 규약) — 화면은 키가 없는 장비에서 디스크·CPU 버튼을 그리지 않는다.
 */
import { numOrNull } from '../../util/numOrNull.js';
import { protoKeyOf } from '../nodeLoad.js'; // v2.932: 프로토콜 이름 규칙 한 벌

/** REST `statistics/current` 에 더하는 키(노드별 — devid=all). */
export const ISI_NODE_LOAD_REST_KEYS = Object.freeze(['node.disk.bytes.in.rate.sum', 'node.disk.bytes.out.rate.sum', 'node.cpu.idle.avg',
  // v2.932(2차 ②): 디스크 busy %(노드 평균 — 0~100 가정) · 드라이브 전송 수(IOPS = in + out). 실장비 미확인 — 범위 밖은 null.
  'node.disk.busy.avg', 'node.disk.xfers.in.rate.sum', 'node.disk.xfers.out.rate.sum']);
/** 2차 — 5분 표본 폴러가 부르는 REST 요약 3개(OneFS 8/9 Platform API v3 — 실장비 미확인). limit 은 노드 수 × 상위 N 으로 호출부가 정한다. */
export const ISI_SUMMARY_PATHS = Object.freeze({
  client: (limit) => `/platform/3/statistics/summary/client?degraded=true&limit=${Math.max(1, Math.min(2000, Math.floor(limit) || 200))}`,
  protocol: '/platform/3/statistics/summary/protocol?degraded=true',
  drive: '/platform/3/statistics/summary/drive?degraded=true',
});
/** 2차 — SSH 세션 안 명령(고정 문자열 · 사용자 입력 없음). 순서 = 예산이 모자랄 때 뒤부터 잃는다. */
export const ISI_SAMPLE_CMDS = Object.freeze({
  system: 'isi statistics system --nodes all --format json',
  client: 'isi statistics client --nodes all --format json',
  protocol: 'isi statistics protocol --nodes all --format json',
  drive: 'isi statistics drive --nodes all --format json',
});
/** SSH 세션에 더하는 명령 1개(사용자 입력이 섞이지 않는 고정 문자열). */
export const ISI_SYSTEM_STATS_CMD = 'isi statistics system --nodes all --format json';
export const ISI_SYSTEM_STATS_SOURCE = 'isi statistics system';
export const ISI_REST_LOAD_SOURCE = 'REST node.disk.bytes.*.rate.sum · node.cpu.idle.avg';

/** 음이 아닌 유한수만(B/s). */
export function rateOrNull(v) {
  const n = numOrNull(v);
  return n != null && n >= 0 ? n : null;
}
/** REST `node.cpu.idle.avg`(1/10 % 가정) → CPU 사용률 %(소수 1자리). 0~1000 밖은 null. */
export function cpuPctFromIdlePermille(v) {
  const n = numOrNull(v);
  if (n == null || n < 0 || n > 1000) return null;
  return Math.round((1000 - n)) / 10;
}
/** SSH 출력의 CPU 칸 → %. 숫자·'12.3'·'12.3%' 를 받고 0~100 밖은 null. */
export function cpuPctOf(v) {
  if (v == null) return null;
  const s = typeof v === 'string' ? v.trim().replace(/%$/, '') : v;
  const n = numOrNull(s);
  return n != null && n >= 0 && n <= 100 ? Math.round(n * 10) / 10 : null;
}

/** REST 노드 통계 맵(키 → 값)에서 디스크·CPU 필드. 키가 없으면 그 필드를 만들지 않는다. */
export function restNodeLoadFields(st) {
  const has = (k) => !!st && Object.prototype.hasOwnProperty.call(st, k);
  const out = {};
  if (has('node.disk.bytes.in.rate.sum')) { const v = rateOrNull(st['node.disk.bytes.in.rate.sum']); if (v != null) out.diskInBytesPs = v; }
  if (has('node.disk.bytes.out.rate.sum')) { const v = rateOrNull(st['node.disk.bytes.out.rate.sum']); if (v != null) out.diskOutBytesPs = v; }
  if (has('node.cpu.idle.avg')) { const v = cpuPctFromIdlePermille(st['node.cpu.idle.avg']); if (v != null) out.cpuPct = v; }
  if (has('node.disk.busy.avg')) { const v = pctOrNull(st['node.disk.busy.avg']); if (v != null) out.busyPct = v; }
  if (has('node.disk.xfers.in.rate.sum') || has('node.disk.xfers.out.rate.sum')) {
    const a = rateOrNull(st['node.disk.xfers.in.rate.sum']); const b = rateOrNull(st['node.disk.xfers.out.rate.sum']);
    if (a != null || b != null) out.iops = Math.round((a || 0) + (b || 0)); // 한쪽만 읽혔으면 그만큼(하한) — 둘 다 없을 때만 필드 없음
  }
  return out;
}
/** 0~100 % 만(실장비에서 1/10 % 로 오면 >100 이 되어 버려진다 — 값마다 추측하지 않는다). */
export function pctOrNull(v) {
  const n = numOrNull(v);
  return n != null && n >= 0 && n <= 100 ? Math.round(n * 10) / 10 : null;
}

const keyOf = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
const ID_KEYS = new Set(['node', 'lnn', 'devid', 'nodeid', 'id']);
const DIN_KEYS = new Set(['diskin', 'diskinrate', 'diskbytesin', 'diskwrite', 'diskwritebytes']);
const DOUT_KEYS = new Set(['diskout', 'diskoutrate', 'diskbytesout', 'diskread', 'diskreadbytes']);
const CPU_KEYS = new Set(['cpu', 'cpupct', 'cpupercent', 'cpuusage']);
// v2.932(2차 ⑨): 5분 표본의 SSH 경로는 `isi status` 를 부르지 않으므로 네트워크도 이 명령에서 읽는다(열 이름 'Net In'/'Net Out' — B/s 로 가정, ×8).
//   1시간 수집(applyIsiSystemStats)은 예전처럼 `isi status` 처리량을 쓴다 — `net:true` 를 주지 않으면 이 키를 읽지 않는다(동작 불변).
const NIN_KEYS = new Set(['netin', 'netinrate', 'netbytesin', 'netinbytes']);
const NOUT_KEYS = new Set(['netout', 'netoutrate', 'netbytesout', 'netoutbytes']);
const toBps = (v) => (v == null ? null : v * 8);

/**
 * `isi statistics system --nodes all --format json` → Map(lnn → {diskInBytesPs?, diskOutBytesPs?, cpuPct?}).
 * 못 읽으면 null(형식 불명) · 읽었는데 노드 행이 없으면 빈 Map. 클러스터 합계 행('All'·'Cluster')은 뺀다.
 * 입력 길이는 1MB 로 자른다(장비 출력은 외부 입력 — 정규식 없이 JSON.parse 한 번).
 */
export function parseIsiSystemStats(text, { net = false } = {}) {
  const s = String(text ?? '').slice(0, 1_048_576).trim();
  if (!s) return null;
  let j;
  try { j = JSON.parse(s); } catch { return null; }
  const list = Array.isArray(j) ? j : Array.isArray(j?.stats) ? j.stats : Array.isArray(j?.nodes) ? j.nodes : null;
  if (!list) return null;
  const out = new Map();
  for (const row of list.slice(0, 512)) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    let id = null; const v = {};
    for (const [k0, val] of Object.entries(row)) {
      const k = keyOf(k0);
      if (ID_KEYS.has(k)) { const n = numOrNull(val); if (n != null && Number.isSafeInteger(n) && n >= 0) id = n; }
      else if (DIN_KEYS.has(k)) { const n = rateOrNull(val); if (n != null) v.diskInBytesPs = n; }
      else if (DOUT_KEYS.has(k)) { const n = rateOrNull(val); if (n != null) v.diskOutBytesPs = n; }
      else if (CPU_KEYS.has(k)) { const n = cpuPctOf(val); if (n != null) v.cpuPct = n; }
      else if (net && NIN_KEYS.has(k)) { const n = rateOrNull(val); if (n != null) v.inBps = toBps(n); }
      else if (net && NOUT_KEYS.has(k)) { const n = rateOrNull(val); if (n != null) v.outBps = toBps(n); }
    }
    if (id == null || out.has(id)) continue;
    out.set(id, v);
  }
  return out;
}

/** 몇 대에서 무엇을 읽었는지 — 화면이 '디스크 키 없음' 을 밝히는 근거(조용히 비우지 않는다). */
export function nodeLoadProbeOf(list, source) {
  const nodes = Array.isArray(list) ? list.filter((n) => n && typeof n === 'object') : [];
  const cnt = (f) => nodes.filter((n) => n[f] != null).length;
  return { source, total: nodes.length, disk: Math.max(cnt('diskInBytesPs'), cnt('diskOutBytesPs')), cpu: cnt('cpuPct') };
}

/**
 * SSH 결과를 정규화 스냅샷의 노드 목록에 붙인다(lnn = `nodes.list[].id`). `parsed` 가 null 이면 사유만 남긴다.
 * @param {object} snap 정규화 스냅샷(제자리 수정)
 * @param {Map|null} parsed parseIsiSystemStats 결과
 * @param {{budget?:boolean, failed?:boolean}} [why]
 */
export function applyIsiSystemStats(snap, parsed, why = {}) {
  if (!snap?.nodes || !Array.isArray(snap.nodes.list) || !snap.nodes.list.length) return snap;
  snap.extra = snap.extra || {};
  if (!(parsed instanceof Map)) {
    snap.extra.nodeLoadProbe = { source: ISI_SYSTEM_STATS_SOURCE, total: snap.nodes.list.length, disk: 0, cpu: 0,
      reason: why.budget ? 'budget' : why.failed ? 'exec' : 'parse' };
    return snap;
  }
  for (const n of snap.nodes.list) {
    const v = n && parsed.get(Number(n.id));
    if (v) Object.assign(n, v);
  }
  snap.extra.nodeLoadProbe = nodeLoadProbeOf(snap.nodes.list, ISI_SYSTEM_STATS_SOURCE);
  if (!parsed.size) snap.extra.nodeLoadProbe.reason = 'empty';
  return snap;
}

/**
 * v2.932(2차 ⑨) — REST `statistics/current?devid=all` 응답 → 표본 노드 목록 [{ id, inBps, outBps, diskInBytesPs?, … }].
 *  · devid 는 /cluster/nodes 의 id 라 lnn 과 다를 수 있다(v2.603) — 호출부가 준 idMap(devid → lnn)으로 바꾸고, 없으면 devid 그대로(probe.idMap 이 밝힌다).
 *  · 네트워크 키는 B/s → ×8(isilon.js bytesRateToBps 와 같은 규칙 — 그 모듈을 import 하면 순환이라 여기서 곱한다). null 은 그대로 null.
 */
export function restSampleNodes(st, idMap = null) {
  const per = new Map();
  for (const r of (Array.isArray(st?.stats) ? st.stats : []).slice(0, 4096)) {
    if (!r || typeof r !== 'object') continue;
    const d = numOrNull(r.devid);
    if (d == null || !Number.isSafeInteger(d) || d < 0) continue;
    if (!per.has(d)) per.set(d, {});
    const v = numOrNull(r.value);
    if (v != null && typeof r.key === 'string') per.get(d)[r.key] = v;
  }
  const out = [];
  for (const [devid, s] of per) {
    const id = idMap instanceof Map && idMap.has(devid) ? idMap.get(devid) : devid;
    out.push({ id, inBps: toBps(rateOrNull(s['node.net.ext.bytes.in.rate'])), outBps: toBps(rateOrNull(s['node.net.ext.bytes.out.rate'])), ...restNodeLoadFields(s) });
  }
  return out.sort((a, b) => a.id - b.id).slice(0, 64);
}
/** `/cluster/nodes` 응답 → Map(id(devid) → lnn). 둘 다 있는 행만. 못 읽으면 null. */
export function nodeIdMapOf(resp) {
  const list = Array.isArray(resp?.nodes) ? resp.nodes : null;
  if (!list) return null;
  const m = new Map();
  for (const n of list.slice(0, 512)) {
    const id = numOrNull(n?.id); const lnn = numOrNull(n?.lnn);
    if (id != null && lnn != null && Number.isSafeInteger(id) && Number.isSafeInteger(lnn)) m.set(id, lnn);
  }
  return m;
}

/* ── 2차(v2.932) — 5분 표본: 클라이언트 · 프로토콜 · 드라이브 요약 ───────────────────────────────────────────
 * REST summary/{client,protocol,drive} 와 SSH `isi statistics {client,protocol,drive} --format json` 을 **같은 행 파서**로 읽는다
 * (둘 다 '행 객체 배열' 이라는 문서 지식 — 실장비 미확인). 필드 이름은 대소문자·밑줄·공백을 지우고 비교한다.
 *  · 지연(time_avg)은 **µs 로 가정해 ms 로 바꾼다**(isi statistics 의 TimeAvg 단위 기억) — 표본 probe 에 `latUnit:'us→ms(가정)'` 로 남긴다.
 *  · 클라이언트 In/Out 은 B/s 그대로(네트워크 노드 값은 bps 지만 클라이언트는 장비가 B/s 로 준다 — 화면이 단위를 붙인다).
 *  · 프로토콜 이름은 소문자 · nfs3/nfs4 → nfs · smb1/smb2 → smb(화면 묶음) · 16자.
 */
export const LAT_UNIT_NOTE = 'us→ms(가정)';
const NODE_KEYS = new Set(['node', 'lnn', 'devid', 'nodeid', 'id']);
const OPS_KEYS = new Set(['operationrate', 'opsrate', 'ops', 'opsps', 'oprate', 'rate']);
const IN_KEYS = new Set(['in', 'inrate', 'bytesin', 'inbytes', 'inavg']);
const OUT_KEYS = new Set(['out', 'outrate', 'bytesout', 'outbytes', 'outavg']);
const LAT_KEYS = new Set(['timeavg', 'avgtime', 'latency', 'time']);
const PROTO_KEYS = new Set(['protocol', 'proto']);
const ADDR_KEYS = new Set(['remoteaddr', 'remoteip', 'clientip', 'ip', 'address']);
const NAME_KEYS = new Set(['remotename', 'clientname', 'hostname']);
const BUSY_KEYS = new Set(['busy', 'busypct', 'busyavg']);
const XIN_KEYS = new Set(['xfersin', 'xfersinrate', 'opsin', 'readops']);
const XOUT_KEYS = new Set(['xfersout', 'xfersoutrate', 'opsout', 'writeops']);
const latMs = (v) => { const n = numOrNull(v); return n != null && n >= 0 ? Math.round(n / 100) / 10 : null; }; // µs → ms 소수 1자리
const idOf = (v) => { const n = numOrNull(v); return n != null && Number.isSafeInteger(n) && n >= 0 ? n : null; };
const strCap = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : (typeof v === 'number' && Number.isFinite(v) ? String(v) : ''));

/** JSON 텍스트 또는 객체 → 행 객체 배열(① 배열 ② {stats|clients|protocols|drives|nodes:[…]} ③ 못 읽음 null). 입력은 2MB 로 자른다. */
export function summaryRowsOf(input) {
  let j = input;
  if (typeof input === 'string') {
    const s = input.slice(0, 2_097_152).trim();
    if (!s) return null;
    try { j = JSON.parse(s); } catch { return null; }
  }
  if (Array.isArray(j)) return j.filter((r) => r && typeof r === 'object' && !Array.isArray(r)).slice(0, 5000);
  if (!j || typeof j !== 'object') return null;
  for (const k of ['stats', 'clients', 'protocols', 'drives', 'nodes', 'client', 'protocol', 'drive']) {
    if (Array.isArray(j[k])) return j[k].filter((r) => r && typeof r === 'object' && !Array.isArray(r)).slice(0, 5000);
  }
  return null;
}
function fieldsOf(row) {
  const out = {};
  for (const [k0, v] of Object.entries(row)) {
    const k = keyOf(k0);
    if (NODE_KEYS.has(k)) out.node = idOf(v);
    else if (OPS_KEYS.has(k)) out.ops = rateOrNull(v);
    else if (IN_KEYS.has(k)) out.in = rateOrNull(v);
    else if (OUT_KEYS.has(k)) out.out = rateOrNull(v);
    else if (LAT_KEYS.has(k)) out.lat = latMs(v);
    else if (PROTO_KEYS.has(k)) out.proto = protoKeyOf(v);
    else if (ADDR_KEYS.has(k)) out.ip = strCap(v, 64);
    else if (NAME_KEYS.has(k)) out.name = strCap(v, 80);
    else if (BUSY_KEYS.has(k)) out.busy = pctOrNull(v);
    else if (XIN_KEYS.has(k)) out.xin = rateOrNull(v);
    else if (XOUT_KEYS.has(k)) out.xout = rateOrNull(v);
  }
  return out;
}
/** 클라이언트 행 → [{ node, ip, name, proto, ops, in, out, lat }] (노드·IP 없는 행은 뺀다 · 같은 노드+IP+프로토콜은 ops 합). */
export function parseClientRows(input) {
  const rows = summaryRowsOf(input);
  if (!rows) return null;
  const m = new Map();
  for (const r of rows) {
    const f = fieldsOf(r);
    if (f.node == null || !f.ip) continue;
    const key = `${f.node}|${f.ip}|${f.proto || ''}`;
    const cur = m.get(key) || { node: f.node, ip: f.ip, name: f.name || '', proto: f.proto || '', ops: null, in: null, out: null, lat: null, n: 0 };
    const add = (a, b) => (b == null ? a : (a == null ? b : a + b));
    cur.ops = add(cur.ops, f.ops); cur.in = add(cur.in, f.in); cur.out = add(cur.out, f.out);
    if (f.lat != null) { cur.lat = cur.lat == null ? f.lat : (cur.lat * cur.n + f.lat) / (cur.n + 1); }
    cur.n += 1; if (!cur.name && f.name) cur.name = f.name;
    m.set(key, cur);
  }
  return [...m.values()].map(({ n: _n, ...x }) => ({ ...x, lat: x.lat == null ? null : Math.round(x.lat * 10) / 10 }));
}
/** 프로토콜 행 → [{ node, proto, ops, lat, in, out }] (노드·프로토콜 없는 행은 뺀다 · 같은 키는 ops 합 · 지연은 ops 가중 평균). */
export function parseProtocolRows(input) {
  const rows = summaryRowsOf(input);
  if (!rows) return null;
  const m = new Map();
  for (const r of rows) {
    const f = fieldsOf(r);
    if (f.node == null || !f.proto) continue;
    const key = `${f.node}|${f.proto}`;
    const cur = m.get(key) || { node: f.node, proto: f.proto, ops: null, lat: null, in: null, out: null, w: 0, lw: 0 };
    if (f.ops != null) cur.ops = (cur.ops || 0) + f.ops;
    if (f.in != null) cur.in = (cur.in || 0) + f.in;
    if (f.out != null) cur.out = (cur.out || 0) + f.out;
    if (f.lat != null) { const w = f.ops != null && f.ops > 0 ? f.ops : 1; cur.lw = (cur.lw || 0) + f.lat * w; cur.w += w; cur.lat = cur.lw / cur.w; }
    m.set(key, cur);
  }
  return [...m.values()].map(({ w: _w, lw: _lw, ...x }) => ({ ...x, lat: x.lat == null ? null : Math.round(x.lat * 10) / 10 }));
}
/** 드라이브 행 → 노드별 { node, busyAvg, busyMax, iops, drives } (드라이브가 없는 노드는 없다 — 가속 노드). */
export function parseDriveRows(input) {
  const rows = summaryRowsOf(input);
  if (!rows) return null;
  const m = new Map();
  for (const r of rows) {
    const f = fieldsOf(r);
    if (f.node == null) continue;
    const cur = m.get(f.node) || { node: f.node, busySum: 0, busyN: 0, busyMax: null, iops: null, drives: 0 };
    cur.drives += 1;
    if (f.busy != null) { cur.busySum += f.busy; cur.busyN += 1; cur.busyMax = cur.busyMax == null ? f.busy : Math.max(cur.busyMax, f.busy); }
    if (f.xin != null || f.xout != null) cur.iops = (cur.iops || 0) + (f.xin || 0) + (f.xout || 0);
    m.set(f.node, cur);
  }
  return [...m.values()].map((c) => ({ node: c.node, busyAvg: c.busyN ? Math.round((c.busySum / c.busyN) * 10) / 10 : null, busyMax: c.busyMax, iops: c.iops == null ? null : Math.round(c.iops), drives: c.drives }));
}

/**
 * 표본 조립(순수) — 노드 목록(1차 필드 포함)에 요약 3개를 lnn 으로 붙인다.
 * @param {{ ts:number, nodes:Array<object>, clients?:Array|null, protocols?:Array|null, drives?:Array|null, clientLimit?:number, source:string }} a
 * @returns {{ ts, nodes:Array<{id, in, out, din, dout, cpu, ops, lat, busy, iops, proto:Object, clients:Array}>, probe:Object }}
 */
export function buildNodeLoadSample({ ts, nodes, clients = null, protocols = null, drives = null, clientLimit = 10, source = '' }) {
  const byNodeC = new Map(); const byNodeP = new Map(); const byNodeD = new Map();
  for (const c of clients || []) { if (!byNodeC.has(c.node)) byNodeC.set(c.node, []); byNodeC.get(c.node).push(c); }
  for (const p of protocols || []) { if (!byNodeP.has(p.node)) byNodeP.set(p.node, {}); byNodeP.get(p.node)[p.proto] = { ops: p.ops, lat: p.lat, in: p.in, out: p.out }; }
  for (const d of drives || []) byNodeD.set(d.node, d);
  const lim = Math.max(1, Math.min(50, Math.floor(clientLimit) || 10));
  const out = [];
  for (const n of (nodes || []).slice(0, 64)) {
    if (!n || typeof n !== 'object') continue;
    const id = idOf(n.id); if (id == null) continue;
    const pr = byNodeP.get(id) || null;
    let ops = null; let lw = 0; let w = 0;
    if (pr) for (const v of Object.values(pr)) { if (v.ops != null) ops = (ops || 0) + v.ops; if (v.lat != null) { const ww = v.ops != null && v.ops > 0 ? v.ops : 1; lw += v.lat * ww; w += ww; } }
    const d = byNodeD.get(id) || null;
    const cl = (byNodeC.get(id) || []).slice().sort((a, b) => (b.ops ?? -1) - (a.ops ?? -1)).slice(0, lim)
      .map((c) => ({ ip: c.ip, name: c.name || '', proto: c.proto, ops: c.ops, in: c.in, out: c.out, lat: c.lat }));
    out.push({
      id, in: numOrNull(n.inBps), out: numOrNull(n.outBps), din: numOrNull(n.diskInBytesPs), dout: numOrNull(n.diskOutBytesPs), cpu: numOrNull(n.cpuPct),
      ops: ops == null ? null : Math.round(ops), lat: w ? Math.round((lw / w) * 10) / 10 : null,
      busy: d ? d.busyAvg : numOrNull(n.busyPct), iops: d ? d.iops : numOrNull(n.iops),
      ...(d && d.busyMax != null ? { busyMax: d.busyMax } : {}),
      proto: pr, clients: cl,
    });
  }
  const probe = { source, total: out.length, clients: out.filter((n) => n.clients.length).length, proto: out.filter((n) => n.proto).length,
    drives: out.filter((n) => n.busy != null || n.iops != null).length, latUnit: LAT_UNIT_NOTE,
    clientsRead: clients ? 'ok' : 'none', protocolsRead: protocols ? 'ok' : 'none', drivesRead: drives ? 'ok' : 'none' };
  return { ts: numOrNull(ts) ?? Date.now(), nodes: out, probe };
}
