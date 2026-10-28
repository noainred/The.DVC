/**
 * vcenter/hostCorp.js — ESXi 호스트 화면 '법인별' 보기의 집계(순수, v2.810 — 승인 시안 B https://claude.ai/artifact/JGykMmoG7kAyNsa5y4uG1x).
 *
 * 법인 = vCenter 1:1. 법인 한 줄 = 호스트 상태 · CPU 구간 · 용량/할당 · 클러스터 자세(HA·수용 제어·DRS·EVC·N+1) · 수집 상태 · RTT.
 * 판정을 새로 만들지 않는다 — 있는 함수를 그대로 부른다:
 *   · CPU 구간: 웹 views/hostTriage.js cpuBucket 과 같은 경계(> 90 확인 · > 100 별도 · 못 읽음 'na') — 번들 경계라 두 벌이고
 *     server/test/hostCorp2810.test.js 가 같은 입력으로 대조한다.
 *   · 클러스터 묶음: clustercfg/analyze.js clusterIndex(ref 우선 · 같은 이름 다른 데이터센터를 섞지 않는다)
 *   · HA·DRS·EVC·판정 코드: clustercfg/analyze.js analyzeClusters(클러스터 HA·DRS 점검 화면과 같은 결과)
 *   · N+1: clustercfg/n1.js n1Groups('인사이트' 화면과 같은 판정 — 가장 큰 호스트 1대 장애 · CPU·메모리 ≤ 90% · 점검 호스트는 받는 쪽에서 뺀다)
 *   · VM 할당 합: vcenter/hostChecks.js vmSumsOf(템플릿 제외 · 못 읽은 VM 은 unknown 으로 따로)
 * 시안에서 정한 판정(사용자 결정 2026-10-28 '시안 정의 그대로'):
 *   · 여유 메모리 = Σ(정격 메모리 × 90% − 사용 중) — 사용률을 읽은 호스트만, 뺀 호스트 수를 headroomExcluded 로 밝힌다.
 *   · 법인 위험(crit) = 연결 실패 · 끊김/무응답 1대 이상 · CPU 90% 초과 5대 이상 · HA 꺼진 클러스터
 *     주의(warn) = 낡은 값 · CPU 90% 초과 1대 이상 · 점검 · N+1 불가 · 수용 제어 꺼짐 · DRS 수동/꺼짐 · 판정 코드
 *     없음(none) = 첫 수집 중 · 비활성(호스트를 모른다 — 0대가 아니다)
 * 못 읽은 값은 0 이 아니다 — null('—')이고 개수는 따로 센다. 클러스터 구성 권한(access.cluster)이 없으면 HA·DRS·N+1 키를 싣지 않는다.
 * ⚠ store·DB 를 import 하지 않는다 — readable(store.usageReadable) · capKnown(store.hostCapacityKnown) · rttOf 를 라우트가 넘긴다.
 */
import { numOrNull } from '../util/numOrNull.js';
import { analyzeClusters, clusterIndex, clusterLabelOf, keyOf, refKeyOf } from '../clustercfg/analyze.js';
import { n1Groups } from '../clustercfg/n1.js';
import { vmSumsOf, vmsByHostOf } from './hostChecks.js';
import { REGIONS } from '../util/regions.js';

export const CPU_ATTENTION_PCT = 90;   // 서버 high-cpu 경보 · 웹 hostTriage.CPU_ATTENTION_PCT 와 같다
export const CPU_HOT_CRIT = 5;         // 법인 위험: CPU 90% 초과 호스트 수(시안 정의)
export const HEADROOM_PCT = 90;        // 여유 메모리 기준(정격의 90%)
export const BUCKET_KEYS = Object.freeze(['lt50', 'b50', 'b75', 'b90', 'over', 'na']);
const REGION_ORDER = REGIONS;   // 리전 순서 = 단일 소스(util/regions.js)

/** CPU 구간 — 웹 hostTriage.cpuBucket 과 같은 경계. readable 이 false 면 'na'(0% 아님). */
export function cpuBucketOf(h, readable) {
  const v = readable(h) ? numOrNull(h?.cpuUsagePct) : null;
  if (v == null) return 'na';
  if (v > 100) return 'over';
  if (v > CPU_ATTENTION_PCT) return 'b90';
  if (v >= 75) return 'b75';
  if (v >= 50) return 'b50';
  return 'lt50';
}

/** 법인 구분 — 이름에 'IRS' 가 있으면 irs(corpusage/build.js corpGroupOf 와 같은 판정). */
const groupOf = (vc) => (/irs/i.test(String(vc?.name || vc?.id || '')) ? 'irs' : 'davinci');

/** DRS 자동화 — off · manual · partial · auto · null(못 읽음). */
export function drsModeOf(drs) {
  if (!drs || typeof drs !== 'object') return null;
  if (drs.enabled === false) return 'off';
  if (drs.enabled !== true) return null;
  const b = String(drs.behavior || '');
  if (b === 'manual') return 'manual';
  if (b === 'partiallyAutomated') return 'partial';
  return 'auto';
}

const sum = (arr, f) => arr.reduce((a, x) => a + (f(x) || 0), 0);
const avg = (vals) => (vals.length ? Math.round(vals.reduce((a, v) => a + v, 0) / vals.length) : null);

function hostStats(list, readable, capKnown) {
  const b = Object.fromEntries(BUCKET_KEYS.map((k) => [k, 0]));
  let maint = 0, connected = 0, capUnknown = 0, cores = 0, memMB = 0, headMB = 0, headExcluded = 0;
  const cpu = [], mem = [];
  for (const h of list) {
    b[cpuBucketOf(h, readable)] += 1;
    if (h.connectionState === 'MAINTENANCE') maint += 1;
    else if (h.connectionState === 'CONNECTED') connected += 1;
    if (capKnown(h)) { cores += h.cpuCores; memMB += h.memTotalMB; } else capUnknown += 1;
    const c = readable(h) ? numOrNull(h.cpuUsagePct) : null;
    const m = readable(h) ? numOrNull(h.memUsagePct) : null;
    if (c != null) cpu.push(c);
    if (m != null) mem.push(m);
    const total = numOrNull(h.memTotalMB);
    if (readable(h) && m != null && total != null) headMB += total * (HEADROOM_PCT - m) / 100; else headExcluded += 1;
  }
  const hot = b.b90 + b.over;
  const readN = list.length - b.na;
  return {
    hosts: list.length, connected, maint, down: b.na, buckets: b, hot,
    cpuAvg: avg(cpu), cpuMax: cpu.length ? Math.max(...cpu) : null, memAvg: avg(mem),
    // 용량을 하나도 못 읽었으면 null — 0 코어라는 거짓 금지. 일부만 못 읽었으면 읽은 값의 합 + capUnknown.
    cores: capUnknown === list.length && list.length ? null : cores,
    memTotalGB: capUnknown === list.length && list.length ? null : Math.round(memMB / 1024),
    capUnknown,
    headroomGB: readN > 0 && headExcluded < list.length ? Math.round(headMB / 1024) : null,
    headroomExcluded: headExcluded,
  };
}

/** 할당 비율 — 분모(용량)를 일부라도 못 읽었으면 null(분자만 남은 틀린 비율 금지 — toolsCapacity 와 같은 규칙). */
function ratios(st, vm) {
  const ok = st.capUnknown === 0 && st.cores != null;
  return {
    vcpuPerCore: ok && st.cores > 0 ? Math.round((vm.vcpu / st.cores) * 10) / 10 : null,
    ramPct: ok && st.memTotalGB > 0 ? Math.round((vm.memMB / 1024 / st.memTotalGB) * 100) : null,
  };
}

/**
 * @param {object} p
 * @param {object[]} p.vcenters  범위·필터를 적용한 vCenter(법인) 목록
 * @param {object[]} p.hosts     범위·필터를 적용한 호스트
 * @param {object[]} p.vms       범위를 적용한 VM(호스트 키로 붙인다)
 * @param {(h)=>boolean} p.readable  store.usageReadable
 * @param {(h)=>boolean} p.capKnown  store.hostCapacityKnown
 * @param {(vcId)=>({rttMs:number|null, ok:boolean, at:number}|null)} [p.rttOf]  핑 모니터의 마지막 값(없으면 null)
 * @param {{cluster:boolean}} [p.access]  클러스터 구성 권한 — false 면 HA·DRS·N+1 키를 싣지 않는다
 * @param {boolean} [p.dropEmpty] 검색·상태 필터로 호스트가 0 이 된 법인을 뺀다(필터 결과 화면)
 */
export function hostCorpOf({ vcenters = [], hosts = [], vms = [], readable, capKnown, rttOf = () => null, access = { cluster: true }, dropEmpty = false, now = Date.now() } = {}) {
  const cfgOk = access?.cluster === true;
  const cidx = clusterIndex(hosts);
  const byHostVm = vmsByHostOf(vms);
  const vmsOf = (list) => list.flatMap((h) => byHostVm.get(`${h.vcenterId}\t${h.name}`) || []);

  // 클러스터 구성(HA·DRS·EVC·판정 코드) — 묶음 키로 찾는다. 이름 겹침으로 호스트를 붙이지 못한 행(nameCollision)은 쓰지 않는다.
  const cfgByKey = new Map();
  if (cfgOk) {
    const mode = cidx.mode;
    for (const r of analyzeClusters(vcenters, hosts).rows) {
      if (r.nameCollision) continue;
      const k = mode.get(r.vcenterId) === true && r.ref ? refKeyOf(r.vcenterId, r.ref) : keyOf(r.vcenterId, r.name);
      cfgByKey.set(k, r);
    }
  }
  const n1ByKey = cfgOk ? new Map(n1Groups(hosts, readable).map((x) => [x.key, x.row])) : new Map();

  // 호스트 → 클러스터 묶음
  const clusterHosts = new Map();
  for (const h of hosts) {
    const k = cidx.keyOf(h);
    if (!k) continue;
    if (!clusterHosts.has(k)) clusterHosts.set(k, []);
    clusterHosts.get(k).push(h);
  }

  const clusterRow = (k, list) => {
    const st = hostStats(list, readable, capKnown);
    const vm = vmSumsOf(vmsOf(list));
    const meta = cidx.meta(k);
    const first = list[0];
    const row = {
      key: k, vcenterId: first.vcenterId, name: first.cluster,
      label: clusterLabelOf({ name: first.cluster, sameName: meta.sameName, vcDatacenter: meta.vcDatacenter, clusterRef: meta.clusterRef }),
      ...st, hostIds: list.map((h) => h.id),
      vms: vm.n, vmsOn: vm.on, vcpu: vm.vcpu, vcpuUnknown: vm.vcpuUnknown, vmMemGB: Math.round(vm.memMB / 1024), ...ratios(st, vm),
    };
    if (cfgOk) {
      const c = cfgByKey.get(k) || null;
      const n = n1ByKey.get(k) || null;
      row.cfgCollected = !!c?.collected;
      row.ha = c?.collected ? (c.ha?.enabled ?? null) : null;
      row.admission = c?.collected && c.ha?.enabled === true ? (c.ha?.admission ?? null) : null;
      row.drs = c?.collected ? drsModeOf(c.drs) : null;
      row.evc = c?.collected ? (c.evc ?? null) : null;   // '' = 꺼짐 · null = 모름
      row.findings = c?.collected ? c.findings.map((f) => ({ code: f.code, sev: f.sev })) : [];
      row.n1Ok = n ? n.n1Ok : null;
      row.cpuAfterFailPct = n ? n.cpuAfterFailPct : null;
      row.memAfterFailPct = n ? n.memAfterFailPct : null;
    }
    row.sev = clusterSevOf(row, cfgOk);
    return row;
  };

  const corps = [];
  for (const vc of vcenters) {
    const list = hosts.filter((h) => h.vcenterId === vc.id);
    if (dropEmpty && !list.length) continue;
    const st = hostStats(list, readable, capKnown);
    const vm = vmSumsOf(vmsOf(list));
    const cls = [...clusterHosts.entries()].filter(([, l]) => l[0].vcenterId === vc.id).map(([k, l]) => clusterRow(k, l));
    const standalone = list.filter((h) => !cidx.keyOf(h)).length;
    const status = String(vc.status || '');
    const unknownHosts = (status === 'pending' || status === 'disabled' || status === 'unreachable' || vc.authStopped === true) && list.length === 0;
    const corp = {
      id: vc.id, name: vc.name || vc.id, region: vc.location?.region || null, city: vc.location?.city || null, country: vc.location?.country || null,
      group: groupOf(vc), status: status || null, stale: vc.stale === true, authStopped: vc.authStopped === true,
      receivedAt: numOrNull(vc.receivedAt), collect: vc.collectSource === 'site' ? 'site' : 'direct', collectedBy: vc.collectedBy || null,
      version: vc.version || null,
      ...st,
      // 호스트를 모르는 법인(첫 수집 중·비활성·연결 실패이며 이월 값 없음)은 개수를 null 로 — '0대' 라는 거짓 금지.
      ...(unknownHosts ? { hosts: null, connected: null, maint: null, down: null, hot: null } : {}),
      vms: vm.n, vmsOn: vm.on, vcpu: vm.vcpu, vcpuUnknown: vm.vcpuUnknown, vmMemGB: Math.round(vm.memMB / 1024), ...ratios(st, vm),
      powerKw: Math.round(sum(list, (h) => (numOrNull(h.powerWatts) > 0 ? h.powerWatts : 0)) / 100) / 10,
      clusterCount: cls.length, standalone, rtt: rttOf(vc.id) || null,
      clusters: cls.sort((a, b) => SEV_RANK[b.sev] - SEV_RANK[a.sev] || (b.cpuMax ?? -1) - (a.cpuMax ?? -1) || String(a.name).localeCompare(String(b.name))),
    };
    if (cfgOk) {
      const c = cls;
      corp.cfg = {
        collected: c.filter((x) => x.cfgCollected).length, haOn: c.filter((x) => x.ha === true).length, haOff: c.filter((x) => x.ha === false).length,
        acOff: c.filter((x) => x.ha === true && x.admission === false).length,
        drsAuto: c.filter((x) => x.drs === 'auto').length, drsWeak: c.filter((x) => x.drs === 'manual' || x.drs === 'off' || x.drs === 'partial').length,
        evcOff: c.filter((x) => x.findings.some((f) => f.code === 'evc-off-mixed')).length,
        withFindings: c.filter((x) => x.findings.length > 0).length,
        n1Ok: c.filter((x) => x.n1Ok === true).length, n1Fail: c.filter((x) => x.n1Ok === false).length, n1Unknown: c.filter((x) => x.n1Ok == null).length,
      };
    }
    corp.reasons = corpReasonsOf(corp);
    corp.sev = corpSevOf(corp);
    corps.push(corp);
  }
  corps.sort((a, b) => regionRank(a.region) - regionRank(b.region) || String(a.name).localeCompare(String(b.name)));
  return { corps, totals: totalsOf(corps, hosts, cfgOk), access: { cluster: cfgOk }, at: now };
}

const regionRank = (r) => { const i = REGION_ORDER.indexOf(r); return i < 0 ? REGION_ORDER.length : i; };
export const SEV_RANK = Object.freeze({ crit: 3, warn: 2, ok: 1, none: 0 });

/** 클러스터 위험 = HA 꺼짐 · N+1 불가 / 주의 = 판정 코드 · 끊김 · 점검. 구성 권한이 없으면 호스트 상태만 본다. */
export function clusterSevOf(c, cfgOk = true) {
  if (cfgOk && (c.ha === false || c.n1Ok === false)) return 'crit';
  if ((cfgOk && c.findings?.length) || c.down > 0 || c.maint > 0) return 'warn';
  return 'ok';
}

/** 법인의 확인 사유 — 화면의 '지금 확인' 칩과 같은 키(웹은 이 목록으로 거른다). */
export function corpReasonsOf(c) {
  const out = [];
  if (c.status === 'unreachable' || c.authStopped) out.push('fail');
  else if (c.stale) out.push('stale');
  if (c.hot > 0) out.push('hot');
  if (c.down > 0) out.push('down');
  if (c.maint > 0) out.push('maint');
  if (c.cfg?.n1Fail > 0) out.push('n1');
  if (c.cfg && (c.cfg.haOff > 0 || c.cfg.acOff > 0)) out.push('ha');
  return [...new Set(out)];
}

/** 법인 판정(시안 정의 — 위 머리말). */
export function corpSevOf(c) {
  if (c.status === 'pending' || c.status === 'disabled' || (c.hosts == null && c.status !== 'unreachable')) return 'none';
  if (c.status === 'unreachable' || c.authStopped || c.down > 0 || c.hot >= CPU_HOT_CRIT || c.cfg?.haOff > 0) return 'crit';
  if (c.stale || c.hot > 0 || c.maint > 0 || c.cfg?.n1Fail > 0 || c.cfg?.acOff > 0 || c.cfg?.drsWeak > 0 || c.cfg?.withFindings > 0) return 'warn';
  return 'ok';
}

function totalsOf(corps, hosts, cfgOk) {
  const t = {
    corps: corps.length,
    corpsOk: corps.filter((c) => (c.status === 'connected' || !c.status) && !c.stale).length,
    corpsStale: corps.filter((c) => c.stale && c.status !== 'unreachable').length,
    corpsFail: corps.filter((c) => c.status === 'unreachable' || c.authStopped).length,
    corpsUnknown: corps.filter((c) => c.hosts == null).length,
    clusters: sum(corps, (c) => c.clusterCount),
    hosts: hosts.length, hot: sum(corps, (c) => c.hot), down: sum(corps, (c) => c.down), maint: sum(corps, (c) => c.maint),
    hotCorps: corps.filter((c) => c.hot > 0).length,
    byReason: {},
  };
  for (const c of corps) for (const r of c.reasons) t.byReason[r] = (t.byReason[r] || 0) + 1;
  if (cfgOk) {
    t.n1Fail = sum(corps, (c) => c.cfg?.n1Fail);
    t.haOff = sum(corps, (c) => c.cfg?.haOff);
    t.acOff = sum(corps, (c) => c.cfg?.acOff);
  }
  return t;
}
