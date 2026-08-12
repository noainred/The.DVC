/**
 * VM 전체 정보 CSV export (특수 기능, v2.275) — 선택한 vCenter 의 모든 VM 에 대해
 * '획득 가능한 최대 필드'를 한 행으로 펼친다. RVTools 의 탭 체계(vInfo·vCPU·vMemory·
 * vDisk·vPartition·vNetwork·vSnapshot·vTools)를 기준 체크리스트로 삼았다.
 *
 * 데이터 소스 2단:
 *  1) 수집 스냅샷(store) — 이름/호스트/클러스터/폴더/CPU/메모리/IP/스냅샷/Tools 등(항상 가용).
 *  2) 내보내기 시점 라이브 SOAP 1회(retrieveManyObjectProps, 250개씩 페이지) —
 *     NIC 상세(MAC·네트워크)·디스크별 용량/thin/데이터스토어·게스트 파티션 사용량·
 *     UUID·코어수·예약/제한 등 스냅샷에 없는 필드 보강. 실패해도 export 는 성공하고
 *     enriched=false + 사유를 함께 반환한다(엣지 수집(site) vCenter 는 중앙에서 직접
 *     접속이 안 될 수 있다 — 그 경우 스냅샷 필드만 내려간다).
 *
 * 결과는 vCenter 단위 60초 캐시(같은 데이터로 미리보기(JSON)와 CSV 다운로드가 연달아
 * 호출되므로 라이브 조회를 두 번 하지 않기 위함). 사용자 scope 검사는 라우트에서
 * vCenter 단위로 끝난 뒤 호출되므로 캐시에 사용자 차원은 없다.
 */

import { VimSoapClient } from './soapClient.js';
import { parseVmDevices, parseGuestDisks } from './soapParse.js';
import { store } from '../store.js';
import { loadVcenterConfig } from '../config.js';
import { csvLine, CSV_BOM } from '../util/csv.js';

// 라이브 보강으로 가져올 per-VM 속성 — 없는 속성은 응답에서 빠질 뿐이라 전부 best-effort.
const ENRICH_PROPS = [
  'config.hardware.device', 'guest.disk', 'config.hardware.numCoresPerSocket',
  'config.uuid', 'config.instanceUuid', 'config.guestId', 'config.createDate', 'config.firmware',
  'runtime.bootTime', 'guest.hostName', 'config.cpuHotAddEnabled', 'config.memoryHotAddEnabled',
  'config.cpuAllocation.reservation', 'config.cpuAllocation.limit',
  'config.memoryAllocation.reservation', 'config.memoryAllocation.limit',
  'summary.config.numEthernetCards', 'summary.config.numVirtualDisks',
  'config.changeTrackingEnabled',
];

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const iso = (v) => { const t = Date.parse(v || ''); return Number.isFinite(t) ? new Date(t).toISOString() : ''; };
const isoTs = (t) => (Number.isFinite(t) && t ? new Date(t).toISOString() : '');
const yn = (v) => (v === true || v === 'true' ? 'Y' : v === false || v === 'false' ? 'N' : '');
const join = (arr) => (arr && arr.length ? arr.join('; ') : '');

/**
 * 컬럼 정의 — JSON 미리보기와 CSV 가 같은 정의를 공유한다(어긋남 방지).
 * get(vm, d): vm=스냅샷 VM, d={ props, nics, disks, guest } (라이브 보강, 없으면 빈 값).
 */
export const VM_EXPORT_COLUMNS = [
  { key: 'vcenter', label: 'vCenter', get: (vm, d, ctx) => ctx.vcName },
  { key: 'vcenterId', label: 'vCenter ID', get: (vm) => vm.vcenterId },
  { key: 'name', label: 'VM 이름', get: (vm) => vm.name },
  { key: 'powerState', label: '전원', get: (vm) => vm.powerState },
  { key: 'connectionState', label: '연결 상태', get: (vm) => vm.connectionState || '' },
  { key: 'template', label: '템플릿', get: (vm) => yn(!!vm.template) },
  { key: 'cluster', label: '클러스터', get: (vm) => vm.cluster || '' },
  { key: 'host', label: '호스트(ESXi)', get: (vm) => vm.host || '' },
  { key: 'folder', label: '폴더', get: (vm) => vm.folder || '' },
  { key: 'resourcePool', label: '리소스 풀', get: (vm) => vm.resourcePool || '' },
  { key: 'guestOS', label: 'Guest OS(구성)', get: (vm) => vm.guestOS || '' },
  { key: 'guestId', label: 'Guest ID', get: (vm, d) => d.props['config.guestId'] || '' },
  { key: 'guestHostName', label: '게스트 호스트명', get: (vm, d) => d.props['guest.hostName'] || '' },
  { key: 'toolsStatus', label: 'Tools 상태', get: (vm) => vm.toolsStatus || '' },
  { key: 'toolsVersion', label: 'Tools 버전', get: (vm) => vm.toolsVersion || '' },
  { key: 'toolsVersionStatus', label: 'Tools 버전 상태', get: (vm) => vm.toolsVersionStatus || '' },
  { key: 'hwVersion', label: 'HW 버전', get: (vm) => vm.hwVersion || '' },
  { key: 'firmware', label: '펌웨어', get: (vm, d) => d.props['config.firmware'] || '' },
  { key: 'uuid', label: 'VM UUID', get: (vm, d) => d.props['config.uuid'] || '' },
  { key: 'instanceUuid', label: 'Instance UUID', get: (vm, d) => d.props['config.instanceUuid'] || '' },
  { key: 'cbt', label: 'CBT(변경 추적)', get: (vm, d) => yn(d.props['config.changeTrackingEnabled']) },
  { key: 'createDate', label: '생성일', get: (vm, d) => iso(d.props['config.createDate']) },
  { key: 'bootTime', label: '최근 부팅', get: (vm, d) => iso(d.props['runtime.bootTime']) },
  { key: 'cpuCount', label: 'vCPU', get: (vm) => vm.cpuCount },
  { key: 'coresPerSocket', label: '소켓당 코어', get: (vm, d) => num(d.props['config.hardware.numCoresPerSocket']) || '' },
  {
    key: 'sockets',
    label: '소켓 수',
    get: (vm, d) => { const c = num(d.props['config.hardware.numCoresPerSocket']); return c > 0 ? Math.round(vm.cpuCount / c) : ''; },
  },
  { key: 'cpuHotAdd', label: 'CPU 핫애드', get: (vm, d) => yn(d.props['config.cpuHotAddEnabled']) },
  { key: 'cpuUsagePct', label: 'CPU 사용률(%)', get: (vm) => vm.cpuUsagePct ?? '' },
  { key: 'cpuReservation', label: 'CPU 예약(MHz)', get: (vm, d) => d.props['config.cpuAllocation.reservation'] ?? '' },
  { key: 'cpuLimit', label: 'CPU 제한(MHz)', get: (vm, d) => d.props['config.cpuAllocation.limit'] ?? '' },
  { key: 'memGB', label: '메모리(GB)', get: (vm) => Math.round((vm.memMB / 1024) * 10) / 10 },
  { key: 'memHotAdd', label: '메모리 핫애드', get: (vm, d) => yn(d.props['config.memoryHotAddEnabled']) },
  { key: 'memUsagePct', label: '메모리 사용률(%)', get: (vm) => vm.memUsagePct ?? '' },
  { key: 'memReservation', label: '메모리 예약(MB)', get: (vm, d) => d.props['config.memoryAllocation.reservation'] ?? '' },
  { key: 'memLimit', label: '메모리 제한(MB)', get: (vm, d) => d.props['config.memoryAllocation.limit'] ?? '' },
  { key: 'nicCount', label: 'NIC 수', get: (vm, d) => (d.nics.length || num(d.props['summary.config.numEthernetCards']) || (d.enriched ? 0 : '')) },
  {
    key: 'nics',
    label: 'NIC 상세',
    get: (vm, d) => join(d.nics.map((n) => `${n.label}(${n.type}) ${n.mac} @${n.network || '?'}${n.connected ? '' : ' [끊김]'}`)),
  },
  { key: 'macs', label: 'MAC 목록', get: (vm, d) => join(d.nics.map((n) => n.mac).filter(Boolean)) },
  { key: 'networks', label: '네트워크 목록', get: (vm, d) => join([...new Set(d.nics.map((n) => n.network).filter(Boolean))]) },
  { key: 'ipAddress', label: '대표 IP', get: (vm) => vm.ipAddress || '' },
  { key: 'ipAddresses', label: 'IP 전체', get: (vm) => join(vm.ipAddresses) },
  { key: 'gateways', label: '게이트웨이', get: (vm) => join(vm.gateways) },
  { key: 'diskCount', label: '디스크 수', get: (vm, d) => (d.disks.length || num(d.props['summary.config.numVirtualDisks']) || (d.enriched ? 0 : '')) },
  {
    key: 'diskProvisionedGB',
    label: '디스크 프로비저닝 합계(GB)',
    get: (vm, d) => (d.disks.length ? Math.round(d.disks.reduce((s, x) => s + x.capacityGB, 0) * 10) / 10 : ''),
  },
  { key: 'datastores', label: '데이터스토어 목록', get: (vm, d) => join([...new Set(d.disks.map((x) => x.datastore).filter(Boolean))]) },
  {
    key: 'disks',
    label: '디스크 상세',
    get: (vm, d) => join(d.disks.map((x) => `${x.label} ${x.capacityGB}GB ${x.rdm ? 'RDM' : x.thin ? 'thin' : 'thick'} ${x.mode} [${x.datastore || '?'}]`)),
  },
  { key: 'thinDiskCount', label: 'Thin 디스크 수', get: (vm, d) => (d.disks.length ? d.disks.filter((x) => x.thin).length : '') },
  { key: 'rdmCount', label: 'RDM 수', get: (vm, d) => (d.disks.length ? d.disks.filter((x) => x.rdm).length : '') },
  { key: 'storageUsedGB', label: '스토리지 사용(GB, committed)', get: (vm) => vm.storageGB ?? '' },
  { key: 'storageUncommittedGB', label: '스토리지 미할당(GB, uncommitted)', get: (vm) => vm.uncommittedGB ?? '' },
  { key: 'storageProvisionedGB', label: '스토리지 프로비저닝(GB)', get: (vm) => num(vm.storageGB) + num(vm.uncommittedGB) },
  { key: 'thin', label: 'Thin 여부(추정)', get: (vm) => yn(!!vm.thin) },
  { key: 'guestPartCount', label: '게스트 파티션 수', get: (vm, d) => (d.guest.length ? d.guest.length : '') },
  {
    key: 'guestCapacityGB',
    label: '게스트 디스크 총량(GB)',
    get: (vm, d) => (d.guest.length ? Math.round(d.guest.reduce((s, x) => s + x.capacityGB, 0) * 10) / 10 : ''),
  },
  {
    key: 'guestUsedGB',
    label: '게스트 사용량(GB)',
    get: (vm, d) => (d.guest.length ? Math.round(d.guest.reduce((s, x) => s + x.usedGB, 0) * 10) / 10 : ''),
  },
  {
    key: 'guestFreeGB',
    label: '게스트 여유(GB)',
    get: (vm, d) => (d.guest.length ? Math.round(d.guest.reduce((s, x) => s + x.freeGB, 0) * 10) / 10 : ''),
  },
  { key: 'guestParts', label: '게스트 파티션 상세', get: (vm, d) => join(d.guest.map((x) => `${x.path} ${x.usedGB}/${x.capacityGB}GB`)) },
  { key: 'snapshotCount', label: '스냅샷 수', get: (vm) => vm.snapshotCount ?? 0 },
  { key: 'snapshotSizeGB', label: '스냅샷 크기(GB)', get: (vm) => vm.snapshotSizeGB ?? '' },
  { key: 'snapshotOldest', label: '스냅샷 최초 생성', get: (vm) => isoTs(vm.snapshotOldestTs) },
  { key: 'snapshotNewest', label: '스냅샷 최근 생성', get: (vm) => isoTs(vm.snapshotNewestTs) },
  { key: 'snapshotNames', label: '스냅샷 이름', get: (vm) => join(vm.snapshotNames) },
  { key: 'gpu', label: 'GPU', get: (vm) => (vm.gpu ? `${vm.gpu.type} x${vm.gpu.count}${vm.gpu.profile ? ` (${vm.gpu.profile})` : ''}` : '') },
  { key: 'notes', label: '메모', get: (vm) => vm.notes || '' },
];

/** 라이브 보강 — 대상 vCenter 에 로그인해 per-VM 상세 속성을 한 번에 가져온다. */
async function collectDetails(vc, morefs) {
  const c = new VimSoapClient(vc);
  await c.login();
  try {
    const objs = await c.retrieveManyObjectProps('VirtualMachine', morefs, ENRICH_PROPS);
    const map = new Map();
    for (const o of objs) map.set(o.ref, o.props || {});
    return map;
  } finally {
    await c.logout().catch(() => {});
  }
}

// vCenter 단위 결과 캐시(60초) — 미리보기(JSON)와 CSV 다운로드가 연달아 와도 라이브 조회 1회.
// 진행 중 프라미스를 캐시해 동시 요청도 합류시킨다.
const _cache = new Map(); // vcenterId -> { at, promise }
const CACHE_MS = 60_000;

export function buildVmExport(vcenterId) {
  const hit = _cache.get(vcenterId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.promise;
  const promise = buildVmExportFresh(vcenterId).catch((e) => { _cache.delete(vcenterId); throw e; });
  _cache.set(vcenterId, { at: Date.now(), promise });
  return promise;
}

async function buildVmExportFresh(vcenterId) {
  const snap = store.get();
  const vc = (snap.vcenters || []).find((v) => v.id === vcenterId);
  const vms = (snap.vms || []).filter((v) => v.vcenterId === vcenterId);
  const vcName = vc?.name || vcenterId;

  // 라이브 보강 — 실패해도 export 는 스냅샷 필드로 계속(사유 동봉).
  let details = new Map();
  let enriched = false;
  let enrichError = '';
  if (snap.source === 'mock') {
    enrichError = '데모 모드 — 라이브 상세(NIC/디스크/게스트 파티션) 미조회';
  } else {
    const vcCfg = loadVcenterConfig().vcenters.find((v) => v.id === vcenterId);
    if (!vcCfg) {
      enrichError = 'vCenter 접속 정보 없음 — 스냅샷 필드만 내보냅니다';
    } else {
      try {
        // vc.id 에는 콜론이 있을 수 있어 split(':') 금지 — 알려진 프리픽스 길이로 잘라낸다.
        const morefs = vms.map((v) => v.id.slice(vcenterId.length + 1)).filter(Boolean);
        if (morefs.length) details = await collectDetails(vcCfg, morefs);
        enriched = true;
      } catch (e) {
        enrichError = `라이브 상세 조회 실패(${e.message}) — 스냅샷 필드만 내보냅니다(엣지 수집 vCenter 는 중앙에서 직접 접속이 안 될 수 있습니다)`;
      }
    }
  }

  const ctx = { vcName };
  const rows = vms.map((vm) => {
    const props = details.get(vm.id.slice(vcenterId.length + 1)) || {};
    const { nics, disks } = parseVmDevices(props['config.hardware.device']);
    const guest = parseGuestDisks(props['guest.disk']);
    const d = { props, nics, disks, guest, enriched };
    const row = {};
    for (const col of VM_EXPORT_COLUMNS) row[col.key] = col.get(vm, d, ctx);
    return row;
  });
  rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return { vcenterId, vcenterName: vcName, enriched, enrichError, total: rows.length, columns: VM_EXPORT_COLUMNS.map((c) => ({ key: c.key, label: c.label })), rows };
}

/** export 결과 → CSV 문자열(UTF-8 BOM + 수식 인젝션 가드 — 엑셀에서 한글/보안 안전). */
export function vmExportCsv(result) {
  const lines = [csvLine(VM_EXPORT_COLUMNS.map((c) => c.label))];
  for (const row of result.rows) lines.push(csvLine(VM_EXPORT_COLUMNS.map((c) => row[c.key])));
  return CSV_BOM + lines.join('\r\n') + '\r\n';
}
