// '호스트 및 클러스터 현황' — 트리를 펼치지 않고 **모든 클러스터·모든 호스트**를 한 번에 보는
// 평면 행 생성 + CSV 직렬화(v2.335, 사용자 요구). 화면 표와 CSV 가 같은 행 배열을 쓰므로
// '화면에 보이는 것'과 '내려받은 것'이 달라지는 일이 없다.
//
// 'Off VM 포함' 체크박스와의 관계: 할당(vCPU·RAM) 합산 대상은 호출부가 넘기는 vms 목록이다
// (vcdVirt.js 와 동일한 계약). 체크 해제 시 호출부가 켜진 VM 만 넘기므로 표·CSV 의 가상화율도
// 트리 배지와 정확히 같은 값이 된다.
import { allocByHost, virtSum } from './vcdVirt.js';

const HOST_STATE_KO = { CONNECTED: '정상', MAINTENANCE: '점검', DISCONNECTED: '끊김', NOT_RESPONDING: '무응답' };
/** 호스트 연결 상태 한글 표기(트리의 StateBadge 와 같은 어휘). 모르는 값은 원문 그대로. */
export const stateKo = (s) => HOST_STATE_KO[s] || (s || '');

/** 가상화율 표기 — 트리 배지(VirtBadge)와 같은 반올림(소수 1자리). 분모/분자가 없으면 빈 값. */
export function ratioText(alloc, base) {
  if (!base || !alloc) return '';
  return (Math.round((alloc / base) * 10) / 10).toFixed(1);
}

/** 클러스터명 -> 호스트 목록. 미소속 호스트는 'standalone'(트리와 동일 규칙), 이름순 정렬. */
export function groupClusters(hosts) {
  const map = new Map();
  for (const h of hosts || []) {
    const c = h.cluster || 'standalone';
    if (!map.has(c)) map.set(c, []);
    map.get(c).push(h);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const sumBy = (list, pick) => list.reduce((a, h) => a + (Number(pick(h)) || 0), 0);
// 클러스터 CPU/MEM 사용률은 트리와 동일하게 호스트 단순 평균(가중 평균이 아님 — 표시값 일치가 우선).
const avgBy = (list, pick) => (list.length ? Math.round(sumBy(list, pick) / list.length) : 0);
const toGb = (mb) => Math.round((Number(mb) || 0) / 1024);

/**
 * 평면 행 생성: vCenter 1행 → (클러스터 1행 → 그 클러스터 호스트 n행) 반복.
 * hosts 는 클러스터 안에서 이름순 정렬한다(89 호스트 CSV 를 사람이 읽으려면 순서가 필요).
 * vmCountByHost(countByHost 결과)를 주면 VM 수를 그 맵으로 센다 — 'Off VM 포함' 해제 시
 * 켜진 VM 만 세기 위한 경로(v2.336). 주지 않으면 호스트가 보고한 h.vmCount(전체, 서버 집계).
 */
export function buildOverviewRows({ site = {}, hosts = [], vms = [], metrics = {}, vmCountByHost = null } = {}) {
  const { vcpu, vmem } = allocByHost(vms);
  const vcName = site.name || site.id || '';
  const rows = [];

  const dc = virtSum(hosts, vcpu, vmem, vmCountByHost);
  rows.push({
    level: 'vCenter', vcenter: vcName, cluster: '', host: '', state: '',
    hostCount: hosts.length, vmCount: dc.vmc,
    cpuPct: num(metrics.cpuUsagePct), memPct: num(metrics.memUsagePct),
    cpuRatio: ratioText(dc.alloc, dc.cores), vcpuAlloc: dc.alloc, cpuCores: dc.cores,
    cpuThreads: sumBy(hosts, (h) => h.cpuThreads),
    memRatio: ratioText(dc.memAlloc, dc.memPhys), memAllocGB: toGb(dc.memAlloc), memPhysGB: toGb(dc.memPhys),
    version: '', vendor: '', model: '', powerW: sumBy(hosts, (h) => h.powerWatts), tempC: null,
  });

  for (const [cl, chosts] of groupClusters(hosts)) {
    const cv = virtSum(chosts, vcpu, vmem, vmCountByHost);
    rows.push({
      level: '클러스터', vcenter: vcName, cluster: cl, host: '', state: '',
      hostCount: chosts.length, vmCount: cv.vmc,
      cpuPct: avgBy(chosts, (h) => h.cpuUsagePct), memPct: avgBy(chosts, (h) => h.memUsagePct),
      cpuRatio: ratioText(cv.alloc, cv.cores), vcpuAlloc: cv.alloc, cpuCores: cv.cores,
      cpuThreads: sumBy(chosts, (h) => h.cpuThreads),
      memRatio: ratioText(cv.memAlloc, cv.memPhys), memAllocGB: toGb(cv.memAlloc), memPhysGB: toGb(cv.memPhys),
      version: '', vendor: '', model: '', powerW: sumBy(chosts, (h) => h.powerWatts), tempC: null,
    });
    for (const h of [...chosts].sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
      const alloc = vcpu.get(h.name) || 0;
      const memAlloc = vmem.get(h.name) || 0;
      rows.push({
        level: '호스트', vcenter: vcName, cluster: cl, host: h.name || '', state: stateKo(h.connectionState),
        hostCount: 1, vmCount: vmCountByHost ? vmCountByHost.get(h.name) || 0 : Number(h.vmCount) || 0,
        cpuPct: num(h.cpuUsagePct), memPct: num(h.memUsagePct),
        cpuRatio: ratioText(alloc, h.cpuCores), vcpuAlloc: alloc, cpuCores: Number(h.cpuCores) || 0,
        cpuThreads: Number(h.cpuThreads) || 0,
        memRatio: ratioText(memAlloc, h.memTotalMB), memAllocGB: toGb(memAlloc), memPhysGB: toGb(h.memTotalMB),
        version: h.version || '', vendor: h.vendor || '', model: h.model || '',
        powerW: Number(h.powerWatts) || 0, tempC: num(h.tempC),
      });
    }
  }
  return rows;
}

// 화면 표와 CSV 가 공유하는 컬럼 정의(순서·라벨 동일 — 표에서 본 그대로 CSV 가 나온다).
export const OVERVIEW_COLUMNS = [
  { key: 'level', label: '구분' },
  { key: 'vcenter', label: 'vCenter' },
  { key: 'cluster', label: '클러스터' },
  { key: 'host', label: '호스트' },
  { key: 'state', label: '상태' },
  { key: 'hostCount', label: '호스트수', num: true },
  { key: 'vmCount', label: 'VM수', num: true },
  { key: 'cpuPct', label: 'CPU사용률(%)', num: true },
  { key: 'memPct', label: 'MEM사용률(%)', num: true },
  { key: 'cpuRatio', label: 'CPU가상화율', num: true },
  { key: 'vcpuAlloc', label: '할당vCPU', num: true },
  { key: 'cpuCores', label: '물리코어', num: true },
  { key: 'cpuThreads', label: '물리스레드', num: true },
  { key: 'memRatio', label: 'MEM가상화율', num: true },
  { key: 'memAllocGB', label: '할당RAM(GB)', num: true },
  { key: 'memPhysGB', label: '물리RAM(GB)', num: true },
  { key: 'version', label: 'ESXi버전' },
  { key: 'vendor', label: '제조사' },
  { key: 'model', label: '모델' },
  { key: 'powerW', label: '전력(W)', num: true },
  { key: 'tempC', label: '흡기온도(℃)', num: true },
];

const esc = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** CSV 본문(헤더 포함, CRLF). 호출부가 UTF-8 BOM 을 붙여 Excel 한글 깨짐을 막는다. */
export function overviewCsv(rows, columns = OVERVIEW_COLUMNS) {
  const lines = [columns.map((c) => esc(c.label)).join(',')];
  for (const r of rows || []) lines.push(columns.map((c) => esc(r[c.key])).join(','));
  return lines.join('\r\n');
}
