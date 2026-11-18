/**
 * vcenter/hostInsight.js — Hypervisor(ESXi 호스트) 탭 '분석' 보기(v3.22.0 · 설계 docs/design/host-insight · 사용자 확정 2026-11-18 기본값)의 집계.
 * 순수(store · DB import 없음 — 라우트 `routes/api/hostInsight.js GET /hosts/insight` 가 범위 · 리전으로 거른 vcenters · hosts · vms 와 판정 함수를 넘긴다).
 *
 * 왜 법인별 줄인가: VM 분석(inventory/vmInsight.js)과 같다 — 바로가기에서 법인을 여럿 고르면 모든 수 · 목록이 그 법인들의 합이어야 한다.
 *   서버가 법인(vCenter)마다 한 줄 · 클러스터마다 한 줄을 주고 화면이 고른 줄을 더한다(선택을 바꿀 때 서버 왕복이 없다). 그래서 줄의 값은 전부
 *   **더할 수 있는 모양**이다 — 평균은 { value, sum, n }, 분포는 칸별 수, 상위 목록은 법인마다 상위 N(합집합의 상위 N 은 법인별 상위 N 의 합집합 안에 있다),
 *   모델 · 버전 · 제조사는 법인마다 상한(MODELS_MAX)까지 다 싣는다(법인별 상위 8 만 주면 여러 법인을 더한 상위 8 이 틀린다).
 *
 * 판정을 새로 만들지 않는다(판정 코어는 하나):
 *  · 법인 · 클러스터 줄(상태 · 구간 · 용량 · 여유 · HA · 수용 제어 · DRS · N+1 · VM 할당) = `hostCorp.hostCorpOf` 그대로(/hosts/corp 와 같은 함수 · 같은 입력).
 *    독립 호스트 줄은 같은 파일의 `hostStats`(법인 · 클러스터 줄과 같은 셈).
 *  · 호스트 수 · 확인 대상 · 과부하(CPU > 90) · 끊김 · 못 읽음 = `platformSummary.hostsSection`(웹 hostTriage.hostReasons 와 대조 고정된 세 규칙).
 *  · 사용률 칸 = `vmDist.usageBinOf`(5% 칸 · 100 이상은 마지막 칸)를 10% 칸으로 접은 것 — VM 분석과 같은 칸.
 *  · 평균 = hostCorp 의 평균과 같은 입력(readable 이고 numOrNull 로 읽은 값) — value 는 hostCorp 의 값(반올림 단순 평균) 그대로.
 *  · 90% 초과(over90) = hostCorp `CPU_ATTENTION_PCT`(> 90 — 과부하 · CPU 구간 b90 · over 와 같은 경계). 메모리도 같은 경계로 센다.
 *  · VM 할당 · 호스트당 VM 수 = `vmSums.vmSumsOf`(템플릿 제외 · 못 읽은 값은 따로 — v3.19.0).
 *  · 하드웨어 · 예기치 않은 재부팅 = `hostChecks.hostChecksOf` 의 호스트별 판정(/hosts/checks 와 같은 함수) — 권한(access.hw · access.hygiene)이 없으면 키를 싣지 않는다.
 *  · 개수를 모르는 법인(첫 수집 중 · 비활성 · 연결 실패 · 인증 정지이며 호스트 0) = `hostCorp.corpUnknownOf` — 수는 전부 null('0대' 라는 거짓 금지).
 *
 * 못 읽은 값은 0 이 아니다: 사용률을 못 읽은 호스트(usageUnknown) · 용량 모름(capUnknown) · 여유 계산에서 뺀 호스트(headroom.excluded) ·
 *   클러스터 설정 미수집(clusters.cfgUnknown · cluster.cfgCollected:false) · 전력 센서 없음 · 소켓/스레드 못 읽음은 합 · 평균 · 칸에서 빼고 따로 센다.
 * 성능: 호스트 · VM 한 번씩 훑기(O(N)) · 상위 목록은 법인마다 N 칸 삽입 · 큰 반복 사이 시간 기준 양보(`yielder` — createYielder).
 */
import { numOrNull } from '../util/numOrNull.js';
import { hostCorpOf, hostStats, corpIdentityOf, CPU_ATTENTION_PCT, HEADROOM_PCT } from './hostCorp.js';
import { vmsByHostOf } from './hostChecks.js';
import { vmSumsOf, vmAllocOf } from './vmSums.js';
import { hostsSection } from '../inventory/platformSummary.js';
import { usageBinOf, VM_DIST_BIN_PCT } from '../inventory/vmDist.js';
import { N1_LIMIT_PCT } from '../clustercfg/n1.js';
import { pushTop } from '../inventory/vmInsight.js';   // 법인마다 상위 N 삽입 — VM 분석과 한 벌

export const HOST_INSIGHT_TOP_N = 5;
export const HOST_HIST_BIN_PCT = 10;
export const HOST_HIST_BINS = 10;
const FOLD = HOST_HIST_BIN_PCT / VM_DIST_BIN_PCT;
/** 호스트 한 대의 VM 수 구간의 위 끝(이하) — 키 '9' 는 9 이하, '12' 는 9 초과 12 이하 … 'more' 는 마지막 끝 초과(시안 ⑨ 의 네 칸). */
export const VMS_PER_HOST_EDGES = Object.freeze([9, 12, 15]);
/** 화면이 접어 보이는 모델 수(넘치면 '그 밖'). 줄에는 MODELS_MAX 까지 싣는다. */
export const MODELS_SHOWN = 8;
export const MODELS_MAX = 50;
export const VERSIONS_MAX = 40;
/** 사용률 경계(포탈의 CPU 구간 · 지도 색 눈금) — hostCorp.cpuBucketOf 의 경계와 같다. */
export const USAGE_EDGES = Object.freeze([50, 75, CPU_ATTENTION_PCT]);
export const STANDALONE_NAME = '독립 호스트';
const NAME_MAX = 200;

/** 화면에 박지 않을 기준값 — 응답 thresholds. */
export function hostInsightThresholds({ bootDays = null } = {}) {
  return {
    overloadPct: CPU_ATTENTION_PCT,          // 과부하 · over90 · CPU 구간 '90 초과' 의 하한(초과)
    usageEdges: [...USAGE_EDGES],
    headroomPct: HEADROOM_PCT,               // 여유 메모리 = Σ(정격 × 이 % − 사용 중)
    n1LimitPct: N1_LIMIT_PCT,                // 한 대 빠진 뒤 CPU · 메모리가 이 값 이하면 버팀
    histBinPct: HOST_HIST_BIN_PCT, histBins: HOST_HIST_BINS,
    vmsPerHostEdges: [...VMS_PER_HOST_EDGES],
    topN: HOST_INSIGHT_TOP_N, modelsShown: MODELS_SHOWN, modelsMax: MODELS_MAX,
    bootDays: numOrNull(bootDays),           // 예기치 않은 재부팅을 보는 기간(일) — /hosts/checks 와 같은 값
  };
}

const textOrNull = (s, max = NAME_MAX) => (typeof s === 'string' && s.trim() ? s.trim().slice(0, max) : null);
const sizeKey = (n, edges) => { for (const e of edges) if (n <= e) return String(e); return 'more'; };
const zeroSizes = (edges) => Object.fromEntries([...edges.map(String), 'more'].map((k) => [k, 0]));
const countInto = (m, k) => m.set(k, (m.get(k) || 0) + 1);

const CMP_CPU = (a, b) => (b.cpu - a.cpu) || ((b.mem ?? -1) - (a.mem ?? -1)) || String(a.name).localeCompare(String(b.name)) || String(a.id).localeCompare(String(b.id));

/** 지도 · 막대가 더할 수 있게 Map → 많은 순 객체(상한 max · 넘친 수는 rest). */
function rankedOf(map, max) {
  const all = [...map.entries()].sort((x, y) => (y[1] - x[1]) || String(x[0]).localeCompare(String(y[0])));
  return { counts: Object.fromEntries(all.slice(0, max)), rest: all.slice(max).reduce((s, [, n]) => s + n, 0) };
}

/** 호스트 묶음의 분석 칸(법인 줄의 hostCorp 밖 값) — 호스트를 한 번 훑는다. */
async function scanHosts(list, { readable, capKnown, byHostVm, yielder, topN, checks }) {
  const cpuHist = new Array(HOST_HIST_BINS).fill(0); const memHist = new Array(HOST_HIST_BINS).fill(0);
  const usageUnknown = { cpu: 0, mem: 0 }; const histOut = { cpu: 0, mem: 0 }; const over90 = { cpu: 0, mem: 0 };
  let cpuSum = 0; let cpuN = 0; let memSum = 0; let memN = 0;
  let memTotalMB = 0; let sockets = 0; let socketsUnknown = 0; let threads = 0; let threadsUnknown = 0;
  let powerW = 0; let powerN = 0;
  const versions = new Map(); let versionUnread = 0;
  const models = new Map(); let modelUnread = 0;
  const vendors = new Map(); let vendorUnread = 0;
  const vmsPerHost = zeroSizes(VMS_PER_HOST_EDGES);
  const hw = checks?.access?.hw ? { ok: 0, warn: 0, fault: 0, unknown: 0, none: 0, pending: 0, error: 0 } : null;
  let reboots = checks?.access?.hygiene ? 0 : null;
  let rebootsUnread = checks?.access?.hygiene ? 0 : null;
  const cpuTop = [];
  for (const h of list) {
    if (yielder) await yielder();
    const ok = readable(h);
    const c = ok ? numOrNull(h.cpuUsagePct) : null;
    const m = ok ? numOrNull(h.memUsagePct) : null;
    if (c == null) usageUnknown.cpu += 1;
    else {
      cpuSum += c; cpuN += 1;
      const b = usageBinOf(c);
      if (b == null) histOut.cpu += 1; else cpuHist[Math.floor(b / FOLD)] += 1;
      if (c > CPU_ATTENTION_PCT) over90.cpu += 1;
    }
    if (m == null) usageUnknown.mem += 1;
    else {
      memSum += m; memN += 1;
      const b = usageBinOf(m);
      if (b == null) histOut.mem += 1; else memHist[Math.floor(b / FOLD)] += 1;
      if (m > CPU_ATTENTION_PCT) over90.mem += 1;
    }
    if (capKnown(h)) memTotalMB += h.memTotalMB;
    const so = numOrNull(h.cpuSockets); if (so == null || so <= 0) socketsUnknown += 1; else sockets += so;
    const th = numOrNull(h.cpuThreads); if (th == null || th <= 0) threadsUnknown += 1; else threads += th;
    const pw = numOrNull(h.powerWatts); if (pw != null && pw > 0) { powerW += pw; powerN += 1; }   // hostCorp powerKw 와 같은 규칙(> 0 만)
    const ver = textOrNull(h.version, 60); if (ver == null) versionUnread += 1; else countInto(versions, ver);
    const mo = textOrNull(h.model); if (mo == null) modelUnread += 1; else countInto(models, mo);
    const ve = textOrNull(h.vendor); if (ve == null) vendorUnread += 1; else countInto(vendors, ve);
    const vmN = vmSumsOf(byHostVm.get(`${h.vcenterId}\t${h.name}`) || []).n;
    vmsPerHost[sizeKey(vmN, VMS_PER_HOST_EDGES)] += 1;
    const ck = checks?.byId?.[h.id];
    if (hw) { const st = ck?.hw?.state; if (st && hw[st] != null) hw[st] += 1; else hw.error += 1; }
    if (reboots != null) { if (ck?.boot?.kind === 'unexpected') reboots += 1; else if (!ck?.boot) rebootsUnread += 1; }
    if (c != null && c >= 0) {
      pushTop(cpuTop, {
        id: h.id, name: h.name, vcenterId: h.vcenterId, cluster: textOrNull(h.cluster), model: textOrNull(h.model), vendor: textOrNull(h.vendor),
        connectionState: h.connectionState || null, vms: vmN, cpu: c, mem: m,
      }, CMP_CPU, topN);
    }
  }
  const round1 = (x) => Math.round(x * 10) / 10;
  return {
    stats: {
      memTotalMB, sockets, socketsUnknown, threads, threadsUnknown,
      powerW: { sum: Math.round(powerW), n: powerN },
      esxi: { ...(() => { const r = rankedOf(versions, VERSIONS_MAX); return { versions: r.counts, rest: r.rest }; })(), unread: versionUnread },
      model: { ...(() => { const r = rankedOf(models, MODELS_MAX); return { models: r.counts, rest: r.rest }; })(), unread: modelUnread },
      vendor: { ...(() => { const r = rankedOf(vendors, MODELS_MAX); return { vendors: r.counts, rest: r.rest }; })(), unread: vendorUnread },
      cpuHist, memHist, usageUnknown, histOut, over90,
      cpuAvgSum: round1(cpuSum), cpuN, memAvgSum: round1(memSum), memN,
      vmsPerHost,
      ...(hw ? { hw } : {}),
      ...(reboots != null ? { reboots30d: reboots, rebootsUnread } : {}),
    },
    cpuTop,
  };
}

/** 클러스터 지도 한 칸 — hostCorp 클러스터 줄(또는 독립 호스트 hostStats)에서. */
function clusterCell(c, { vcenterId, standalone, memTotalMB, cfgOk }) {
  const cell = {
    key: c.key, vcenterId, name: c.name, label: c.label ?? c.name, standalone,
    hosts: c.hosts, connected: c.connected, maint: c.maint, down: c.down,
    cores: c.cores, memTotalMB, memTotalGB: c.memTotalGB, capUnknown: c.capUnknown,
    busiestCpu: c.cpuMax, cpuAvg: c.cpuAvg, memAvg: c.memAvg,
    usageUnknown: c.buckets?.na ?? null, hot: c.hot,
    headroomGB: c.headroomGB, headroomExcluded: c.headroomExcluded,
    vms: c.vms ?? null, vcpu: c.vcpu ?? null, vcpuUnknown: c.vcpuUnknown ?? null,
    sev: c.sev ?? null,
  };
  if (cfgOk) {
    if (standalone) Object.assign(cell, { cfgCollected: null, ha: null, admission: null, drs: null, n1Ok: null, n1Cpu: null, n1Mem: null });
    else Object.assign(cell, { cfgCollected: c.cfgCollected, ha: c.ha, admission: c.admission, drs: c.drs, n1Ok: c.n1Ok, n1Cpu: c.cpuAfterFailPct, n1Mem: c.memAfterFailPct });
    // unknown 표시: 설정을 못 받았거나(cfgCollected false) N+1 을 판정하지 않았다(n1Ok null — 용량 모름 · 독립 호스트 · 1대뿐)
    cell.cfgUnknown = !standalone && cell.cfgCollected !== true;
    cell.n1Unknown = cell.n1Ok == null;
  }
  return cell;
}

const NULL_ROW_KEYS = Object.freeze([
  'hosts', 'attention', 'overloaded', 'clusterCount', 'standalone', 'cores', 'capUnknown', 'sockets', 'socketsUnknown', 'threads', 'threadsUnknown',
  'memTotalMB', 'vms', 'templates', 'vcpu', 'vcpuUnknown', 'memVmMB', 'memUnknown', 'vcpuPerCore', 'ramPct', 'powerW', 'esxi', 'model', 'vendor',
  'cpuHist', 'memHist', 'usageUnknown', 'histOut', 'cpuAvg', 'memAvg', 'over90', 'vmsPerHost', 'headroom', 'clusters',
]);

/**
 * @param {object} p
 * @param {object[]} p.vcenters  범위(· 리전)를 먼저 적용한 vCenter(법인) 목록 — 범위 밖은 이름도 싣지 않는다
 * @param {object[]} p.hosts     범위(· 리전)를 먼저 적용한 호스트
 * @param {object[]} p.vms       범위를 먼저 적용한 VM(호스트 키로 붙인다)
 * @param {(h)=>boolean} p.readable  store.usageReadable
 * @param {(h)=>boolean} p.capKnown  store.hostCapacityKnown
 * @param {{cluster:boolean, hygiene:boolean, hw:boolean}} p.access  routes/api/hostExport.js accessOf — 없는 권한의 칸은 싣지 않는다
 * @param {object|null} [p.checks]  hostChecksOf 결과({ byId, access }) — 하드웨어 · 재부팅. null 이면 그 칸을 싣지 않는다
 * @param {boolean} [p.unlisted=true] 목록에 없는 vCenter 의 호스트를 그 id 의 줄(unlisted:true)로 싣는다 — /hosts 합계와 합이 맞게
 * @param {number|null} [p.bootDays]
 * @param {() => Promise<boolean>} [p.yielder]
 * @returns {Promise<{ rows: object[], clusters: object[], top: object[], thresholds: object, access: object }>}
 */
export async function hostInsightOf({ vcenters = [], hosts = [], vms = [], readable, capKnown, access = {}, checks = null, unlisted = true, bootDays = null, yielder = null, topN = HOST_INSIGHT_TOP_N, now = Date.now() } = {}) {
  const cfgOk = access?.cluster === true;
  const listed = new Set();
  const vcs = [];
  for (const vc of vcenters) { if (!vc || typeof vc !== 'object' || listed.has(vc.id)) continue; listed.add(vc.id); vcs.push(vc); }
  const hl = (hosts || []).filter((h) => h && typeof h === 'object');
  const unlistedIds = new Set();
  if (unlisted) for (const h of hl) if (!listed.has(h.vcenterId)) unlistedIds.add(h.vcenterId);
  // 법인 · 클러스터 줄은 /hosts/corp 와 같은 함수 · 같은 입력(목록에 없는 vCenter 는 신원만 있는 줄로 — corpIdentityOf({ id }))
  const corpOut = hostCorpOf({ vcenters: [...vcs, ...[...unlistedIds].map((id) => ({ id }))], hosts: hl, vms, readable, capKnown, access: { cluster: cfgOk }, now });
  const byVcHosts = new Map();
  for (const h of hl) { let a = byVcHosts.get(h.vcenterId); if (!a) { a = []; byVcHosts.set(h.vcenterId, a); } a.push(h); }
  const byHostVm = vmsByHostOf(vms);
  const hostById = new Map(hl.map((h) => [h.id, h]));
  const vcById = new Map(vcs.map((v) => [v.id, v]));
  const capMB = (list) => list.reduce((s, h) => s + (capKnown(h) ? h.memTotalMB : 0), 0);

  const rows = []; const clusters = []; const top = [];
  for (const corp of corpOut.corps) {
    const list = byVcHosts.get(corp.id) || [];
    const isUnlisted = unlistedIds.has(corp.id);
    const identity = isUnlisted ? { ...corpIdentityOf({ id: corp.id }), unlisted: true } : corpIdentityOf(vcById.get(corp.id));
    const unknown = corp.hosts == null;   // hostCorp 가 '개수 모름'(corpUnknownOf)으로 둔 법인
    if (unknown) {
      rows.push({ ...identity, unknown: true, ...Object.fromEntries(NULL_ROW_KEYS.map((k) => [k, null])) });
      top.push({ id: corp.id, cpuTop: [], n1Fail: [] });
      continue;
    }
    const hs = hostsSection(list, readable);
    const { stats, cpuTop } = await scanHosts(list, { readable, capKnown, byHostVm, yielder, topN, checks });
    const vmSum = vmSumsOf(list.flatMap((h) => byHostVm.get(`${h.vcenterId}\t${h.name}`) || []));
    const alloc = vmAllocOf(vmSum);
    const cfg = corp.cfg || null;
    rows.push({
      ...identity, unknown: false,
      hosts: { total: hs.total, connected: hs.connected, maint: hs.maint, down: hs.down, unread: hs.unread },
      attention: hs.attention, overloaded: hs.hot,
      clusterCount: corp.clusterCount, standalone: corp.standalone,
      cores: corp.cores, capUnknown: corp.capUnknown,
      sockets: stats.sockets, socketsUnknown: stats.socketsUnknown, threads: stats.threads, threadsUnknown: stats.threadsUnknown,
      memTotalMB: corp.memTotalGB == null ? null : stats.memTotalMB,
      vms: vmSum.n, templates: vmSum.templates,
      vcpu: corp.vcpu, vcpuUnknown: corp.vcpuUnknown, memVmMB: alloc.memMB, memUnknown: vmSum.memUnknown,
      vcpuPerCore: corp.vcpuPerCore, ramPct: corp.ramPct,
      powerW: stats.powerW,
      esxi: stats.esxi, model: stats.model, vendor: stats.vendor,
      cpuHist: stats.cpuHist, memHist: stats.memHist, usageUnknown: stats.usageUnknown, histOut: stats.histOut,
      cpuAvg: { value: corp.cpuAvg, sum: stats.cpuAvgSum, n: stats.cpuN },
      memAvg: { value: corp.memAvg, sum: stats.memAvgSum, n: stats.memN },
      over90: stats.over90,
      vmsPerHost: stats.vmsPerHost,
      headroom: { gb: corp.headroomGB, excluded: corp.headroomExcluded },
      clusters: cfg
        ? { total: corp.clusterCount, collected: cfg.collected, cfgUnknown: corp.clusterCount - cfg.collected, n1Ok: cfg.n1Ok, n1Fail: cfg.n1Fail, n1Unknown: cfg.n1Unknown,
          haOn: cfg.haOn, haOff: cfg.haOff, admissionOff: cfg.acOff,
          drsManual: corp.clusters.filter((c) => c.drs === 'manual').length, drsWeak: cfg.drsWeak, withFindings: cfg.withFindings }
        : { total: corp.clusterCount },
      ...(stats.hw ? { hw: stats.hw } : {}),
      ...(stats.reboots30d != null ? { reboots30d: stats.reboots30d, rebootsUnread: stats.rebootsUnread } : {}),
    });
    for (const c of corp.clusters) {
      const memList = (c.hostIds || []).map((id) => hostById.get(id)).filter(Boolean);
      clusters.push(clusterCell(c, { vcenterId: corp.id, standalone: false, memTotalMB: c.memTotalGB == null ? null : capMB(memList), cfgOk }));
    }
    // 독립 호스트 = 어느 클러스터 줄에도 들지 않은 호스트(hostCorp 의 standalone 수와 같은 집합 — clusterIndex 키가 없는 호스트)
    const inCluster = new Set(corp.clusters.flatMap((c) => c.hostIds || []));
    const alone = list.filter((h) => !inCluster.has(h.id));
    if (alone.length) {
      const st = hostStats(alone, readable, capKnown);
      const vm = vmSumsOf(alone.flatMap((h) => byHostVm.get(`${h.vcenterId}\t${h.name}`) || []));
      const va = vmAllocOf(vm);
      clusters.push(clusterCell({ ...st, key: `${corp.id}\u0000standalone`, name: STANDALONE_NAME, label: STANDALONE_NAME, vms: vm.n, vcpu: va.vcpu, vcpuUnknown: vm.vcpuUnknown, sev: null },
        { vcenterId: corp.id, standalone: true, memTotalMB: st.memTotalGB == null ? null : capMB(alone), cfgOk }));
    }
    top.push({
      id: corp.id, cpuTop,
      // 한 대가 빠지면 못 버티는 클러스터(빠진 뒤 사용률) — 클러스터 구성 권한이 없으면 싣지 않는다(키 없음)
      ...(cfgOk ? { n1Fail: corp.clusters.filter((c) => c.n1Ok === false)
        .map((c) => ({ key: c.key, name: c.name, label: c.label, hosts: c.hosts, cpuAfterFailPct: c.cpuAfterFailPct, memAfterFailPct: c.memAfterFailPct, ha: c.ha }))
        .sort((a, b) => Math.max(b.cpuAfterFailPct ?? -1, b.memAfterFailPct ?? -1) - Math.max(a.cpuAfterFailPct ?? -1, a.memAfterFailPct ?? -1) || String(a.name).localeCompare(String(b.name))) } : {}),
    });
  }
  rows.sort((x, y) => String(x.name).localeCompare(String(y.name)) || String(x.id).localeCompare(String(y.id)));
  const rank = new Map(rows.map((r, i) => [r.id, i]));
  top.sort((x, y) => rank.get(x.id) - rank.get(y.id));
  clusters.sort((x, y) => (rank.get(x.vcenterId) - rank.get(y.vcenterId)) || (x.standalone - y.standalone) || String(x.name).localeCompare(String(y.name)) || String(x.key).localeCompare(String(y.key)));
  return {
    rows, clusters, top, thresholds: hostInsightThresholds({ bootDays }),
    access: { cluster: cfgOk, hw: !!checks?.access?.hw, hygiene: !!checks?.access?.hygiene },
  };
}
