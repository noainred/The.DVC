/**
 * contention/parse.js — CPU 경합(C2)·디스크 지연(C3)(v2.706). 순수 파서·요약·판정·엣지 정제를 이 모듈 하나가 소유한다.
 *
 * 원천: vCenter **실시간(20초) 통계**의 최근 창(기본 15표본 = 5분)을 VM·호스트 묶음으로 한 번에 받는다(QueryPerf, instance '*').
 *  · 실시간 통계는 통계 레벨과 무관하게 ESXi 가 갖고 있다(최근 약 1시간). 주/월 롤업은 레벨에 따라 비므로 쓰지 않는다.
 *  · 값은 '최근 5분 창' 이다 — 지난주 피크가 아니다. 화면이 그 사실을 말한다.
 *
 * 모양(vm.perfc / host.perfc — 없으면 아직 읽지 않았다 = '미수집', 판정하지 않는다):
 *   vm.perfc   = { at, samples, readyPct:{avg,max}|null, costopPct:{avg,max}|null, latencyPct:{avg,max}|null,
 *                  readMs:{avg,max}|null, writeMs:{avg,max}|null, disk:'scsi0:1'|null }
 *   host.perfc = { at, samples, diskMaxMs:{avg,max}|null, ds:[{uuid, readMs:{avg,max}|null, writeMs:{avg,max}|null}] }
 *  - 못 읽은 값은 null(0 이 아니다 — 0 은 '경합 없음' 이라는 값이다).
 */
import { xmlUnescape } from '../vcenter/soapParse.js';

/** 카운터 키('group.name.rollup') — 이름만 선언하고 id 는 그 vCenter 카탈로그에서 찾는다(없으면 그 값만 null). */
export const VM_COUNTERS = Object.freeze({
  ready: 'cpu.ready.summation',
  costop: 'cpu.costop.summation',
  latency: 'cpu.latency.average',
  read: 'virtualDisk.totalReadLatency.average',
  write: 'virtualDisk.totalWriteLatency.average',
});
export const HOST_COUNTERS = Object.freeze({
  diskMax: 'disk.maxTotalLatency.latest',
  dsRead: 'datastore.totalReadLatency.average',
  dsWrite: 'datastore.totalWriteLatency.average',
});
export const REALTIME_INTERVAL = 20;
export const DEFAULT_SAMPLES = 15;
const SAMPLE_MS = REALTIME_INTERVAL * 1000;
export const HOST_DS_MAX = 64;

/**
 * 다중 엔티티 QueryPerf 응답 → Map<ref, Map<counterId, Map<instance, number[]>>>(결측 -1 은 버린다).
 * 계열 경계는 `<id>` 블록이다(표본도 `<value>` 라 컨테이너와 태그가 같다 — perfBatch.js 의 같은 함정).
 */
export function parsePerfInstances(xml, entityType) {
  const out = new Map();
  if (typeof xml !== 'string') return out;
  const re = /<returnval\b[^>]*>([\s\S]*?)<\/returnval>/g;
  let m;
  while ((m = re.exec(xml))) {
    const blk = m[1];
    const ent = new RegExp(`<entity type="${entityType}">([^<]+)</entity>`).exec(blk)?.[1];
    if (!ent) continue;
    const byCounter = new Map();
    const marks = [...blk.matchAll(/<id>([\s\S]*?)<\/id>/g)];
    for (let i = 0; i < marks.length; i++) {
      const cid = /<counterId>(\d+)<\/counterId>/.exec(marks[i][1])?.[1];
      if (!cid) continue;
      const inst = xmlUnescape(/<instance>([^<]*)<\/instance>/.exec(marks[i][1])?.[1] || '');
      const from = marks[i].index + marks[i][0].length;
      const to = i + 1 < marks.length ? marks[i + 1].index : blk.length;
      const vals = [...blk.slice(from, to).matchAll(/<value>(-?\d+)<\/value>/g)].map((x) => Number(x[1])).filter((v) => Number.isFinite(v) && v >= 0);
      if (!byCounter.has(cid)) byCounter.set(cid, new Map());
      byCounter.get(cid).set(inst, vals);
    }
    out.set(ent, byCounter);
  }
  return out;
}

const r1 = (x) => Math.round(x * 10) / 10;
/** 표본 → {avg,max} · 표본이 없으면 null. */
export function avgMax(vals, scale = (x) => x) {
  if (!Array.isArray(vals) || !vals.length) return null;
  const xs = vals.map(scale);
  return { avg: r1(xs.reduce((a, b) => a + b, 0) / xs.length), max: r1(Math.max(...xs)) };
}

/**
 * VM 하나 요약. readyMs·costopMs 는 20초 표본마다의 합(ms)이고 집계 인스턴스('')는 vCPU 전체 합이다
 *  → %/vCPU = ms / (20,000 × vCPU) × 100. vCPU 를 모르면 % 를 지어내지 않는다(null).
 *  · cpu.latency.average 는 % × 100(0.01 단위) 이다.
 *  · 가상 디스크 지연은 디스크(인스턴스)마다 오므로 **가장 나쁜 디스크** 를 고르고 그 이름을 남긴다.
 */
export function summarizeVm(byCounter, ids, numCpu, at = Date.now()) {
  const get = (k) => (ids[k] ? byCounter?.get(String(ids[k])) : null);
  const agg = (k) => get(k)?.get('') ?? null;
  const cpus = Number(numCpu) > 0 ? Number(numCpu) : null;
  const toPct = (ms) => (ms / (SAMPLE_MS * cpus)) * 100;
  const ready = agg('ready'); const costop = agg('costop'); const lat = agg('latency');
  let worst = null;
  for (const k of ['read', 'write']) {
    const m = get(k);
    if (!m) continue;
    for (const [inst, vals] of m) {
      if (!inst || !vals.length) continue;
      const mx = Math.max(...vals);
      if (!worst || mx > worst.v) worst = { v: mx, inst };
    }
  }
  const worstOf = (k) => { const m = get(k); if (!m) return null; let best = null; for (const [inst, vals] of m) { if (!inst) continue; const s = avgMax(vals); if (s && (!best || s.max > best.max)) best = s; } return best; };
  const samples = Math.max(0, ...[ready, costop, lat].map((v) => (Array.isArray(v) ? v.length : 0)));
  return {
    at, samples,
    readyPct: cpus ? avgMax(ready, toPct) : null,
    costopPct: cpus ? avgMax(costop, toPct) : null,
    latencyPct: avgMax(lat, (x) => x / 100),
    readMs: worstOf('read'), writeMs: worstOf('write'),
    disk: worst ? worst.inst.slice(0, 32) : null,
  };
}

/** 호스트 하나 요약 — 최대 디스크 지연(집계) + 데이터스토어별 읽기·쓰기 지연(인스턴스 = 데이터스토어 UUID). */
export function summarizeHost(byCounter, ids, at = Date.now()) {
  const get = (k) => (ids[k] ? byCounter?.get(String(ids[k])) : null);
  const dmax = get('diskMax')?.get('') ?? null;
  const dsMap = new Map();
  for (const [k, f] of [['dsRead', 'readMs'], ['dsWrite', 'writeMs']]) {
    const m = get(k);
    if (!m) continue;
    for (const [inst, vals] of m) {
      if (!inst) continue;
      const e = dsMap.get(inst) || { uuid: inst.slice(0, 64), readMs: null, writeMs: null };
      e[f] = avgMax(vals);
      dsMap.set(inst, e);
    }
  }
  return { at, samples: Array.isArray(dmax) ? dmax.length : 0, diskMaxMs: avgMax(dmax), ds: [...dsMap.values()].slice(0, HOST_DS_MAX) };
}

/** 데이터스토어 info XML 의 url(ds:///vmfs/volumes/<uuid>/) → uuid. 호스트 datastore.* 카운터의 인스턴스와 맞춘다. */
export function dsUuidOf(infoXml) {
  const url = /<url>([^<]+)<\/url>/.exec(typeof infoXml === 'string' ? infoXml : '')?.[1];
  if (!url) return null;
  const m = /\/volumes\/([^/]+)\/?/.exec(xmlUnescape(url));
  return m ? m[1].slice(0, 64) : null;
}

// ── 판정 ────────────────────────────────────────────────────────────────────
/** 기준(관행 값 — VMware 성능 가이드에서 흔히 쓰는 경계). 판정은 창 평균으로, 최대는 근거로만 싣는다. */
export const THRESHOLDS = Object.freeze({
  readyWarn: 5, readyCrit: 10,       // % / vCPU
  costopWarn: 3, costopCrit: 10,     // % / vCPU — vSMP 동시 스케줄 대기
  latencyWarn: 10,                   // % — cpu.latency(경합·전력관리·HT 공유 포함)
  diskWarn: 20, diskCrit: 50,        // ms
});
export const CONTENTION_CODES = Object.freeze({
  'cpu-ready': 'warn', 'cpu-ready-crit': 'crit', 'cpu-costop': 'warn', 'cpu-costop-crit': 'crit', 'cpu-latency': 'info',
  'disk-latency': 'warn', 'disk-latency-crit': 'crit',
});

export function vmContentionFindings(vm) {
  const p = vm?.perfc;
  const out = [];
  if (!p || vm.powerState !== 'POWERED_ON') return out;
  const add = (code, facts) => out.push({ code, sev: CONTENTION_CODES[code], facts });
  const r = p.readyPct?.avg; const c = p.costopPct?.avg; const l = p.latencyPct?.avg;
  if (r != null) { if (r >= THRESHOLDS.readyCrit) add('cpu-ready-crit', { avg: r, max: p.readyPct.max }); else if (r >= THRESHOLDS.readyWarn) add('cpu-ready', { avg: r, max: p.readyPct.max }); }
  if (c != null) { if (c >= THRESHOLDS.costopCrit) add('cpu-costop-crit', { avg: c, max: p.costopPct.max }); else if (c >= THRESHOLDS.costopWarn) add('cpu-costop', { avg: c, max: p.costopPct.max }); }
  if (l != null && l >= THRESHOLDS.latencyWarn && !(r != null && r >= THRESHOLDS.readyWarn)) add('cpu-latency', { avg: l });
  const d = Math.max(p.readMs?.avg ?? -1, p.writeMs?.avg ?? -1);
  if (d >= THRESHOLDS.diskCrit) add('disk-latency-crit', { avg: d, disk: p.disk });
  else if (d >= THRESHOLDS.diskWarn) add('disk-latency', { avg: d, disk: p.disk });
  return out;
}

// ── 엣지 수신 정제(아는 필드만) ─────────────────────────────────────────────
const fin = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? r1(Math.min(v, 1e7)) : null);
const am = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? (fin(v.avg) == null ? null : { avg: fin(v.avg), max: fin(v.max) ?? fin(v.avg) }) : null);
const intOr = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null);
/**
 * v2.719(감사 B1-06): 엣지가 보낸 at 은 수신 시각(now)으로 자른다 — 미래 시각이면 'now - at <= staleMs' 가 영원히 참이라
 * 수집이 멈춰도 마지막 경합 값이 지금 값처럼 남았다(v2.682 R3S-01 규약). 원본은 edgeAt 으로 남긴다.
 */
function clampAt(v, now) {
  const at = intOr(v.at);
  if (at == null || !Number.isFinite(now) || at <= now) return { at };
  return { at: Math.trunc(now), edgeAt: at };
}
export function sanitizeVmPerfc(v, now = Date.now()) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  return {
    ...clampAt(v, now), samples: Math.max(0, Math.min(1000, intOr(v.samples) ?? 0)),
    readyPct: am(v.readyPct), costopPct: am(v.costopPct), latencyPct: am(v.latencyPct), readMs: am(v.readMs), writeMs: am(v.writeMs),
    disk: typeof v.disk === 'string' && /^[\w:.-]{1,32}$/.test(v.disk) ? v.disk : null,
  };
}
export function sanitizeHostPerfc(v, now = Date.now()) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const ds = Array.isArray(v.ds) ? v.ds.slice(0, HOST_DS_MAX).filter((x) => x && typeof x === 'object' && !Array.isArray(x) && typeof x.uuid === 'string' && /^[\w.:-]{1,64}$/.test(x.uuid))
    .map((x) => ({ uuid: x.uuid, readMs: am(x.readMs), writeMs: am(x.writeMs) })) : [];
  return { ...clampAt(v, now), samples: Math.max(0, Math.min(1000, intOr(v.samples) ?? 0)), diskMaxMs: am(v.diskMaxMs), ds };
}
