/**
 * vcenter/vmExportCatalog.js — 특수 기능 'VM 전체 정보 내보내기' 항목 카탈로그(순수, v2.799).
 *
 * 사용자 요청(2026-10-27): "특수기능 'VM 전체 정보 CSV' 버그 수정 · 추가할 수 있는 정보 확인 · 클로드 디자인으로 멋지게 ·
 *   vm list export 기능(v2.798 VM 목록 내보내기) 참고". 시안 https://claude.ai/artifact/FCUJ73AgKCxpzcr4J6Y6TC 승인(시안대로 · 표준 검증 · main 기준 독립).
 *
 * 열은 여기 하나다 — 웹 화면(GET /tools/vm-export/catalog)·미리보기·CSV·엑셀이 같은 key·머리·칸 값을 쓴다.
 *  · key 는 고정(계정 저장값에 남는다 — 바꾸지 말 것. 지우면 저장값에서 빠지고 화면이 그 수를 알린다).
 *  · '예전 CSV 그대로'(PRESET legacy)는 v2.278 의 열 순서·머리 그대로다(시각 열만 머리에 시간대를 붙였다 — 예전 값은 UTC 였다).
 *  · src = 값의 출처(화면 배지): snap 30초 인벤토리 · cache 주기 수집(구성·장치 캐시 vm.cfg/vm.dev) ·
 *    both 실시간 보강이 있으면 실시간, 없으면 구성 캐시 · live 실시간 전용(내보낼 때 vCenter 에 한 번 로그인) ·
 *    parts 게스트 파티션(실시간 guest.disk, 없으면 게스트 디스크 수집 DB) · tags 태그 인벤토리(주기 수집).
 *  · ⚠ 못 읽은 값은 빈칸, 그 출처가 이 VM 을 아직 모으지 않았으면 '수집 안 됨'(MISSING) — 0·'N' 으로 쓰지 않는다
 *    (v2.799 이전: NIC·디스크 수 0, Thin 'N', 메모리 0 을 지어냈다 — vmExport.js 머리말).
 *
 * 칸 함수 get(vm, d, o):
 *   vm = 스냅샷 VM · d = vmExport.js rowContext() 가 만든 VM 한 대의 출처 묶음 · o = 표 옵션(아래 tableOpts).
 *   d = { live, props, nics|null, disks|null, diskSrc, guest|null, cfg|null, dev|null, tg|null, liveMiss }
 *   (예전 테스트처럼 d 의 일부만 주어도 깨지지 않는다 — 없는 출처는 '모름' 이다.)
 */
import { localStamp, DAY_OFFSET_MIN } from '../util/dayKey.js';
import { numOrNull } from '../util/numOrNull.js';
import { CATALOG as VM_LIST_CATALOG, timeCtx as vmListTimeCtx } from '../veeam/vmListCatalog.js';   // v2.801 Veeam 묶음은 VM 목록 항목을 그대로 쓴다
import { YN_DAYS, YN_DEFAULT_DAYS } from '../veeam/backupStatus.js';

export const MISSING = '수집 안 됨';
/** 미리보기 전용 — 실시간 전용 칸은 미리보기에서 조회하지 않는다(화면을 여는 것만으로 vCenter 전량 조회를 하지 않게 — v2.799 결함 6). */
export const LIVE_LATER = '내려받을 때 조회';
export const DISK_SLOTS = 7;
export const FOLDER_LEVELS_MAX = 32;
export const MAX_ITEMS = 150;
const DAY = 86_400_000;

export const GROUPS = Object.freeze([
  { id: 'base', name: '기본' },
  { id: 'guest', name: '게스트 OS · Tools' },
  { id: 'ident', name: '식별 · 이력' },
  { id: 'cpu', name: 'CPU · 메모리' },
  { id: 'net', name: '네트워크' },
  { id: 'disk', name: '가상 디스크 · 스토리지' },
  { id: 'part', name: '게스트 파티션' },
  { id: 'snap', name: '스냅샷' },
  { id: 'dev', name: '장치 · 위생', isNew: true },
  { id: 'meta', name: '태그 · 속성', isNew: true },
  { id: 'veeam', name: 'Veeam 백업', isNew: true },
]);
export const GROUP_NOTES = Object.freeze({
  ident: 'UUID · 생성일은 실시간 보강으로만 얻습니다 — 엣지 위임 vCenter 나 실시간 보강을 끄면 ‘수집 안 됨’ 입니다.',
  net: 'NIC · MAC · 포트그룹은 실시간 보강으로만 얻습니다. IP · 게이트웨이 · DNS 는 VMware Tools 가 보고한 인벤토리 값입니다.',
  disk: '‘캐시 · 실시간’ 은 실시간 보강이 켜져 있고 vCenter 에 직접 접속할 수 있으면 실시간 값, 아니면 구성 캐시 값입니다. 디스크 파일 경로와 디스크별 Thin 은 실시간에만 있습니다.',
  part: '실시간 보강이 있으면 그 시점의 게스트 파티션, 없으면 게스트 디스크 수집(설정에서 켬) 값입니다. Tools 가 도는 VM 만 있습니다. 파일 시스템 종류는 vSphere 7.0 이상이 주는 값으로 추정합니다(옛 판이면 빈칸).',
  dev: '구성 캐시(주기 수집)입니다 — 재시작 직후 아직 읽지 않은 VM 은 ‘수집 안 됨’ 입니다.',
  meta: '태그와 사용자 지정 속성은 vCenter 마다 주기(기본 6시간)로 모읍니다 — 첫 수집 전에는 ‘수집 안 됨’ 입니다.',
  veeam: 'VM 목록 내보내기와 같은 판정입니다(Veeam 연동 대조 · vCenter 스냅샷 이벤트 최근 7일). ‘여부’ 두 항목은 예 · 아니오 · 모름 — Veeam 연동이 없거나 아직 못 읽은 VM 은 ‘아니오’ 가 아니라 ‘모름’ 입니다.',
});

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const r1 = (v) => Math.round(v * 10) / 10;
const join = (arr) => (Array.isArray(arr) && arr.length ? arr.filter((x) => x != null && x !== '').join('; ') : '');
const yn = (v) => (v === true || v === 'true' ? 'Y' : v === false || v === 'false' ? 'N' : '');
const num = (v) => { const n = numOrNull(v); return n == null ? '' : n; };
const dd = (d) => d || {};
/** 실시간 전용 칸 — 이 VM 의 실시간 속성이 없으면 '모름' 글자(미리보기 LIVE_LATER · 그 밖 MISSING). */
const liveMiss = (d) => (d && typeof d.liveMiss === 'string' ? d.liveMiss : MISSING);
const live = (d, f) => (d?.live ? f(d.props || {}) : liveMiss(d));
/** 실시간이 있으면 그 값, 없으면 구성 캐시, 둘 다 없으면 MISSING. */
const both = (d, fromLive, fromCfg) => (d?.live ? fromLive(d.props || {}) : d?.cfg ? fromCfg(d.cfg) : MISSING);
const cfgOnly = (d, f) => (d?.cfg ? f(d.cfg) : MISSING);
const devOnly = (d, f) => (d?.dev ? f(d.dev) : MISSING);
const msOf = (v) => { if (fin(v)) return v > 0 ? v : null; const t = Date.parse(v || ''); return Number.isFinite(t) && t > 0 ? t : null; };
const stamp = (o, ms) => (ms == null ? '' : localStamp(ms, o?.offsetMin ?? DAY_OFFSET_MIN));
/** 포탈 시간대 표기 — 540분이면 KST, 그 밖은 (UTC±hh:mm). */
export function tzName(offsetMin = DAY_OFFSET_MIN) {
  const m = Number(offsetMin) || 0;
  if (m === 540) return 'KST';
  const a = Math.abs(m);
  return `(UTC${m < 0 ? '−' : '+'}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')})`;
}
/** VM 폴더 단계 — '/' 로 나누고 숨은 최상위 'vm' 을 뺀다(veeam/vmListCsv.folderParts 와 같은 규칙). */
export const folderParts = (folder) => String(folder || 'vm').split('/').filter((p) => p && p !== 'vm');

/* ── 디스크 ── */
const diskTypeOf = (x) => (x.rdm ? 'RDM' : x.thin === true ? 'thin' : x.thin === false ? 'thick' : MISSING);
// '라벨 용량 타입 모드 [데이터스토어]'(v2.278 형식). 모르는 타입(구성 캐시의 thin)·빈 모드는 자리째 뺀다 — 정규식 없이(장비 출력은 길이를 믿지 않는다).
const diskText = (x) => { const t = diskTypeOf(x); return [x.label, `${fin(x.capacityGB) ? x.capacityGB : '?'}GB`, t === MISSING ? '' : t, x.mode || '', `[${x.datastore || '?'}]`].filter(Boolean).join(' '); };
const disksOf = (d, f) => (Array.isArray(d?.disks) ? f(d.disks) : MISSING);
/** 수·합계 — 구성 캐시 목록이 상한(32개)에서 잘렸으면(disksPartial) 쓰지 않는다(부분 합 금지). */
const disksAll = (d, f) => (Array.isArray(d?.disks) ? (d.disksPartial ? '' : f(d.disks)) : MISSING);
function diskSlotColumns() {
  const out = [];
  for (let i = 0; i < DISK_SLOTS; i++) {
    const n = i + 1;
    const at = (d) => (Array.isArray(dd(d).disks) ? dd(d).disks[i] : undefined);
    const slot = (d, f) => { if (!Array.isArray(dd(d).disks)) return MISSING; const x = at(d); return x ? f(x) : ''; };
    out.push(
      { key: `disk${n}CapacityGB`, label: `디스크${n} 용량(GB)`, get: (vm, d) => slot(d, (x) => (fin(x.capacityGB) ? x.capacityGB : '')) },
      { key: `disk${n}Type`, label: `디스크${n} 타입`, get: (vm, d) => slot(d, diskTypeOf) },
      { key: `disk${n}Mode`, label: `디스크${n} 모드`, get: (vm, d) => slot(d, (x) => x.mode || '') },
      { key: `disk${n}Datastore`, label: `디스크${n} 데이터스토어`, get: (vm, d) => slot(d, (x) => x.datastore || '') },
      // 구성 캐시에는 파일 경로가 없다 — 그 디스크는 '수집 안 됨'(빈칸은 '파일 없음' 으로 읽힌다).
      { key: `disk${n}File`, label: `디스크${n} 파일`, get: (vm, d) => slot(d, (x) => (typeof x.fileName === 'string' ? x.fileName : MISSING)) },
    );
  }
  return out;
}
const DISK_SLOT_COLUMNS = Object.freeze(diskSlotColumns());

/* ── 게스트 파티션 ── */
/** 게스트 파티션의 사용·여유 합 — 값을 모르는 파티션(null)은 빼고, 아는 것이 하나도 없으면 ''(v2.600 LO2600-07). */
export function guestKnownSum(guest, key) {
  const known = (guest || []).filter((x) => x && x[key] != null);
  return known.length ? r1(known.reduce((s, x) => s + x[key], 0)) : '';
}
const partsOf = (d, f) => { const g = dd(d).guest; if (g == null) return MISSING; return g.length ? f(g) : ''; };

/* ── 태그 ── */
const tagText = (t) => (t.category ? `${t.category}:${t.tag}` : t.tag);
const tagsCell = (d) => (d?.tg?.tags == null ? MISSING : join(d.tg.tags.map(tagText)));
const customCell = (d) => (d?.tg?.custom == null ? MISSING : join(d.tg.custom.map((c) => `${c.name}=${c.value}`)));

/*
 * v2.801 Veeam 백업 묶음 — VM 목록 카탈로그(veeam/vmListCatalog.js)의 항목을 key·머리·칸 그대로 빌려 온다(판정 코어 하나 — 복제하지 않는다).
 *   d.bv = 그 VM 의 vmBackupView(veeam/vmViewProvider — 라우트가 읽는다) · d.bvLinked = Veeam 연동 여부. Veeam 소스를 못 읽었으면(d.bv undefined) '수집 안 됨'.
 *   시간대 표기만 이 카탈로그의 것(tzName — 'KST')으로 바꾼다.
 */
export const VEEAM_KEYS = Object.freeze(['vbkYn', 'vlast', 'vres', 'vjudge', 'vstate', 'vrp', 'vjob', 'vsnapYn', 'vsnapTs', 'vsnapN', 'vtmp', 'vtmpTs', 'vtmpStale']);
const veeamCtx = (o) => ({ ...vmListTimeCtx({ snapDays: o?.snapDays ?? 7, offsetMin: o?.offsetMin ?? DAY_OFFSET_MIN, now: o?.now ?? Date.now(), ynDays: o?.ynDays }), tz: tzName(o?.offsetMin) });
const VEEAM_ITEMS = VEEAM_KEYS.map((k) => {
  const L = VM_LIST_CATALOG.find((c) => c.key === k);
  return {
    key: k, group: 'veeam', label: L.label, src: 'veeam', ...(L.isNew ? { isNew: true } : {}),
    ...(L.head ? { head: (o) => L.head(veeamCtx(o)) } : {}),
    get: (vm, d, o) => (d?.bv === undefined ? MISSING : L.get({ inv: vm, view: d.bv || undefined, linked: d.bvLinked !== false }, veeamCtx(o))),
  };
});

/**
 * 카탈로그 — 항목마다 { key, group, label, src, isNew?, head?(o), cols?(o), get(vm, d, o) }.
 *  · cols(o) 가 있으면 한 항목이 여러 열이 된다(디스크 슬롯 · 폴더 단계 · 태그 카테고리별 열).
 */
export const CATALOG = Object.freeze([
  // 기본
  { key: 'vcenter', group: 'base', label: 'vCenter', src: 'snap', get: (vm, d, o) => o?.vcName ?? '' },
  { key: 'vcenterId', group: 'base', label: 'vCenter ID', src: 'snap', get: (vm) => vm.vcenterId || '' },
  { key: 'name', group: 'base', label: 'VM 이름', src: 'snap', get: (vm) => vm.name || '' },
  { key: 'powerState', group: 'base', label: '전원', src: 'snap', get: (vm) => vm.powerState || '' },
  { key: 'connectionState', group: 'base', label: '연결 상태', src: 'snap', get: (vm) => vm.connectionState || '' },
  { key: 'template', group: 'base', label: '템플릿', src: 'snap', get: (vm) => yn(vm.template) },
  { key: 'cluster', group: 'base', label: '클러스터', src: 'snap', get: (vm) => vm.cluster || '' },
  { key: 'host', group: 'base', label: '호스트(ESXi)', src: 'snap', get: (vm) => vm.host || '' },
  { key: 'folder', group: 'base', label: '폴더', src: 'snap', get: (vm) => vm.folder || '' },
  { key: 'folderLevels', group: 'base', label: '폴더 1~N단계(열 나눔)', src: 'snap', isNew: true,
    cols: (o) => Array.from({ length: Math.max(1, Math.min(FOLDER_LEVELS_MAX, o?.levels || 1)) }, (_, i) => ({
      key: `folderLevel${i + 1}`, h: `폴더 ${i + 1}단계`, get: (vm) => folderParts(vm.folder)[i] || '',
    })) },
  { key: 'resourcePool', group: 'base', label: '리소스 풀', src: 'snap', get: (vm) => vm.resourcePool || '' },
  { key: 'notes', group: 'base', label: '메모', src: 'snap', get: (vm) => vm.notes || '' },
  // 게스트 OS · Tools
  { key: 'guestOS', group: 'guest', label: 'Guest OS(구성)', src: 'snap', get: (vm) => vm.guestOS || '' },
  { key: 'guestOsTools', group: 'guest', label: 'Guest OS(Tools 보고)', src: 'cache', isNew: true, get: (vm, d) => cfgOnly(d, (c) => c.guestNameTools || '') },
  { key: 'guestId', group: 'guest', label: 'Guest ID', src: 'both', get: (vm, d) => both(d, (p) => p['config.guestId'] || '', (c) => c.guestIdConfig || '') },
  { key: 'guestHostName', group: 'guest', label: '게스트 호스트명', src: 'both', get: (vm, d) => both(d, (p) => p['guest.hostName'] || '', (c) => c.guestHostName || '') },
  { key: 'toolsStatus', group: 'guest', label: 'Tools 상태', src: 'snap', get: (vm) => vm.toolsStatus || '' },
  { key: 'toolsVersion', group: 'guest', label: 'Tools 버전', src: 'snap', get: (vm) => vm.toolsVersion || '' },
  { key: 'toolsVersionStatus', group: 'guest', label: 'Tools 버전 상태', src: 'snap', get: (vm) => vm.toolsVersionStatus || '' },
  { key: 'hwVersion', group: 'guest', label: 'HW 버전', src: 'snap', get: (vm) => vm.hwVersion || '' },
  { key: 'firmware', group: 'guest', label: '펌웨어', src: 'both', get: (vm, d) => both(d, (p) => p['config.firmware'] || '', (c) => c.firmware || '') },
  // 식별 · 이력
  { key: 'uuid', group: 'ident', label: 'VM UUID', src: 'live', get: (vm, d) => live(d, (p) => p['config.uuid'] || '') },
  { key: 'instanceUuid', group: 'ident', label: 'Instance UUID', src: 'live', get: (vm, d) => live(d, (p) => p['config.instanceUuid'] || '') },
  { key: 'createDate', group: 'ident', label: '생성일', head: (o) => `생성일 ${tzName(o?.offsetMin)}`, src: 'live',
    get: (vm, d, o) => live(d, (p) => stamp(o, msOf(p['config.createDate']))) },
  { key: 'bootTime', group: 'ident', label: '최근 부팅', head: (o) => `최근 부팅 ${tzName(o?.offsetMin)}`, src: 'both',
    get: (vm, d, o) => both(d, (p) => stamp(o, msOf(p['runtime.bootTime'])), (c) => stamp(o, msOf(c.bootTime))) },
  { key: 'uptimeDays', group: 'ident', label: '가동 일수', src: 'both', isNew: true,
    // 꺼진 VM 의 bootTime 은 지난 부팅이다 — 가동 일수를 쓰지 않는다.
    get: (vm, d, o) => {
      const days = (ms) => (ms == null || vm.powerState !== 'POWERED_ON' ? '' : Math.max(0, Math.floor(((o?.now ?? Date.now()) - ms) / DAY)));
      return both(d, (p) => days(msOf(p['runtime.bootTime'])), (c) => days(msOf(c.bootTime)));
    } },
  { key: 'managedBy', group: 'ident', label: '관리 주체(vCLS · SRM 등)', src: 'cache', isNew: true,
    get: (vm, d) => cfgOnly(d, (c) => (c.managedBy ? [c.managedBy.extensionKey, c.managedBy.type ? `(${c.managedBy.type})` : ''].filter(Boolean).join(' ') : '')) },
  // CPU · 메모리
  { key: 'cpuCount', group: 'cpu', label: 'vCPU', src: 'snap', get: (vm) => (fin(vm.cpuCount) ? vm.cpuCount : '') },
  { key: 'coresPerSocket', group: 'cpu', label: '소켓당 코어', src: 'live', get: (vm, d) => live(d, (p) => { const c = numOrNull(p['config.hardware.numCoresPerSocket']); return c > 0 ? c : ''; }) },
  { key: 'sockets', group: 'cpu', label: '소켓 수', src: 'live',
    get: (vm, d) => live(d, (p) => { const c = numOrNull(p['config.hardware.numCoresPerSocket']); return c > 0 && fin(vm.cpuCount) ? Math.round(vm.cpuCount / c) : ''; }) },
  { key: 'cpuHotAdd', group: 'cpu', label: 'CPU 핫애드', src: 'both', get: (vm, d) => both(d, (p) => yn(p['config.cpuHotAddEnabled']), (c) => yn(c.cpuHotAdd)) },
  { key: 'cpuUsagePct', group: 'cpu', label: 'CPU 사용률(%)', src: 'snap', get: (vm) => num(vm.cpuUsagePct) },
  { key: 'cpuReservation', group: 'cpu', label: 'CPU 예약(MHz)', src: 'both', get: (vm, d) => both(d, (p) => num(p['config.cpuAllocation.reservation']), (c) => num(c.cpuReservationMhz)) },
  { key: 'cpuLimit', group: 'cpu', label: 'CPU 제한(MHz)', src: 'both', get: (vm, d) => both(d, (p) => num(p['config.cpuAllocation.limit']), (c) => num(c.cpuLimitMhz)) },
  // v2.799: memMB 를 못 읽었으면 빈칸(예전 Math.round(memMB/1024) 은 null→0 · undefined→NaN 을 썼다).
  { key: 'memGB', group: 'cpu', label: '메모리(GB)', src: 'snap', get: (vm) => { const m = numOrNull(vm.memMB); return m == null ? '' : r1(m / 1024); } },
  { key: 'memHotAdd', group: 'cpu', label: '메모리 핫애드', src: 'both', get: (vm, d) => both(d, (p) => yn(p['config.memoryHotAddEnabled']), (c) => yn(c.memHotAdd)) },
  { key: 'memUsagePct', group: 'cpu', label: '메모리 사용률(%)', src: 'snap', get: (vm) => num(vm.memUsagePct) },
  { key: 'memReservation', group: 'cpu', label: '메모리 예약(MB)', src: 'both', get: (vm, d) => both(d, (p) => num(p['config.memoryAllocation.reservation']), (c) => num(c.memReservationMB)) },
  { key: 'memLimit', group: 'cpu', label: '메모리 제한(MB)', src: 'both', get: (vm, d) => both(d, (p) => num(p['config.memoryAllocation.limit']), (c) => num(c.memLimitMB)) },
  { key: 'gpu', group: 'cpu', label: 'GPU', src: 'snap', get: (vm) => (vm.gpu ? `${vm.gpu.type} x${vm.gpu.count}${vm.gpu.profile ? ` (${vm.gpu.profile})` : ''}` : '') },
  // 네트워크
  // v2.799(결함 1): 실시간 보강이 '성공' 해도 이 VM 이 응답에 없거나 장치 목록을 못 받았으면 nics=null — 예전에는 0 을 썼다.
  { key: 'nicCount', group: 'net', label: 'NIC 수', src: 'live',
    get: (vm, d) => (Array.isArray(dd(d).nics) ? (d.nics.length || numOrNull(d.props?.['summary.config.numEthernetCards']) || 0) : liveMiss(d)) },
  { key: 'nics', group: 'net', label: 'NIC 상세', src: 'live',
    get: (vm, d) => (Array.isArray(dd(d).nics) ? join(d.nics.map((n) => `${n.label}(${n.type}) ${n.mac} @${n.network || '?'}${n.connected ? '' : ' [끊김]'}`)) : liveMiss(d)) },
  { key: 'macs', group: 'net', label: 'MAC 목록', src: 'live', get: (vm, d) => (Array.isArray(dd(d).nics) ? join(d.nics.map((n) => n.mac).filter(Boolean)) : liveMiss(d)) },
  { key: 'networks', group: 'net', label: '네트워크 목록', src: 'live',
    get: (vm, d) => (Array.isArray(dd(d).nics) ? join([...new Set(d.nics.map((n) => n.network).filter(Boolean))]) : liveMiss(d)) },
  { key: 'ipAddress', group: 'net', label: '대표 IP', src: 'snap', get: (vm) => vm.ipAddress || '' },
  { key: 'ipAddresses', group: 'net', label: 'IP 전체', src: 'snap', get: (vm) => join(vm.ipAddresses) },
  { key: 'gateways', group: 'net', label: '게이트웨이', src: 'snap', get: (vm) => join(vm.gateways) },
  { key: 'dns', group: 'net', label: 'DNS 서버', src: 'snap', isNew: true, get: (vm) => join(vm.dns?.servers) },
  // 가상 디스크 · 스토리지
  { key: 'diskCount', group: 'disk', label: '디스크 수', src: 'both',
    get: (vm, d) => (Array.isArray(dd(d).disks) ? (d.disksPartial ? '' : d.disks.length) : d?.live ? num(d.props?.['summary.config.numVirtualDisks']) : MISSING) },
  { key: 'diskProvisionedGB', group: 'disk', label: '디스크 프로비저닝 합계(GB)', src: 'both',
    // 용량을 모르는 디스크가 하나라도 있으면 합을 쓰지 않는다(부분 합 금지).
    get: (vm, d) => disksAll(d, (xs) => (!xs.length ? '' : xs.every((x) => fin(x.capacityGB)) ? r1(xs.reduce((s, x) => s + x.capacityGB, 0)) : '')) },
  { key: 'datastores', group: 'disk', label: '데이터스토어 목록', src: 'both', get: (vm, d) => disksOf(d, (xs) => join([...new Set(xs.map((x) => x.datastore).filter(Boolean))])) },
  { key: 'diskSlots', group: 'disk', label: '디스크 1~7 슬롯(슬롯당 5열)', src: 'both',
    cols: (o) => (o?.disk === 'join'
      ? [{ key: 'diskDetail', h: '디스크 상세', get: (vm, d) => disksOf(d, (xs) => join(xs.map(diskText))) }]
      : DISK_SLOT_COLUMNS.map((c) => ({ key: c.key, h: c.label, get: c.get }))) },
  // '한 칸에 이어 쓰기' 에서는 디스크 상세가 전부를 담으므로 이 열을 내지 않는다.
  { key: 'disksOverflow', group: 'disk', label: '디스크8+ 요약', src: 'both',
    cols: (o) => (o?.disk === 'join' ? [] : [{ key: 'disksOverflow', h: '디스크8+ 요약', get: (vm, d) => disksOf(d, (xs) => join(xs.slice(DISK_SLOTS).map(diskText))) }]) },
  { key: 'thinDiskCount', group: 'disk', label: 'Thin 디스크 수', src: 'live',
    get: (vm, d) => (dd(d).diskSrc === 'live' || (Array.isArray(dd(d).disks) && d.diskSrc == null) ? d.disks.filter((x) => x.thin === true).length : liveMiss(d)) },
  { key: 'rdmCount', group: 'disk', label: 'RDM 수', src: 'both', get: (vm, d) => disksAll(d, (xs) => xs.filter((x) => x.rdm).length) },
  { key: 'sharedDisks', group: 'disk', label: '공유 디스크(multi-writer)', src: 'cache', isNew: true,
    get: (vm, d) => devOnly(d, (v) => (v.disks || []).filter((x) => x.sharing && x.sharing !== 'sharingNone').length) },
  { key: 'storageUsedGB', group: 'disk', label: '스토리지 사용(GB, committed)', src: 'snap', get: (vm) => num(vm.storageGB) },
  { key: 'storageUncommittedGB', group: 'disk', label: '스토리지 미할당(GB, uncommitted)', src: 'snap', get: (vm) => num(vm.uncommittedGB) },
  // v2.727(감사 C-01): committed·uncommitted 중 하나라도 못 읽었으면 합을 지어내지 않는다 — 빈 칸. 보고된 0 은 값이다.
  { key: 'storageProvisionedGB', group: 'disk', label: '스토리지 프로비저닝(GB)', src: 'snap',
    get: (vm) => { const c = numOrNull(vm.storageGB); const u = numOrNull(vm.uncommittedGB); return c == null || u == null ? '' : c + u; } },
  // v2.799(결함 2): thin 은 uncommitted 로 추정한 값이다 — uncommitted 를 못 읽었으면(null) 'N' 이 아니라 빈칸.
  { key: 'thin', group: 'disk', label: 'Thin 여부(추정)', src: 'snap', get: (vm) => (numOrNull(vm.uncommittedGB) == null ? '' : yn(vm.thin === true)) },
  { key: 'cbt', group: 'disk', label: 'CBT(변경 추적)', src: 'both', get: (vm, d) => both(d, (p) => yn(p['config.changeTrackingEnabled']), (c) => yn(c.cbt)) },
  { key: 'consolidation', group: 'disk', label: '디스크 통합 필요', src: 'cache', isNew: true, get: (vm, d) => cfgOnly(d, (c) => yn(c.consolidationNeeded)) },
  // 게스트 파티션
  { key: 'guestPartCount', group: 'part', label: '게스트 파티션 수', src: 'parts', get: (vm, d) => partsOf(d, (g) => g.length) },
  { key: 'guestCapacityGB', group: 'part', label: '게스트 디스크 총량(GB)', src: 'parts', get: (vm, d) => partsOf(d, (g) => (g.every((x) => fin(x.capacityGB)) ? r1(g.reduce((s, x) => s + x.capacityGB, 0)) : '')) },
  // v2.600(감사 LO2600-07): 여유를 보고하지 않은 파티션은 사용·여유 합계에서 빼고 개수를 따로 싣는다.
  { key: 'guestUsedGB', group: 'part', label: '게스트 사용량(GB)', src: 'parts', get: (vm, d) => partsOf(d, (g) => guestKnownSum(g, 'usedGB')) },
  { key: 'guestFreeGB', group: 'part', label: '게스트 여유(GB)', src: 'parts', get: (vm, d) => partsOf(d, (g) => guestKnownSum(g, 'freeGB')) },
  { key: 'guestPartsUnknown', group: 'part', label: '게스트 여유 미보고 파티션 수', src: 'parts', get: (vm, d) => partsOf(d, (g) => g.filter((x) => x.usedGB == null).length) },
  { key: 'guestParts', group: 'part', label: '게스트 파티션 상세', src: 'parts',
    get: (vm, d) => partsOf(d, (g) => join(g.map((x) => `${x.path} ${x.usedGB == null ? '?' : x.usedGB}/${fin(x.capacityGB) ? x.capacityGB : '?'}GB`))) },
  // v2.798 이 수집을 시작한 파일 시스템 종류(GuestDiskInfo.filesystemType — 실시간 parseGuestDisks · 수집 DB part_latest.fs). 모르면 빈칸.
  { key: 'fsType', group: 'part', label: '파일 시스템 종류(NTFS · ext4 · xfs)', src: 'parts', isNew: true,
    get: (vm, d) => partsOf(d, (g) => join([...new Set(g.map((x) => x.fs).filter(Boolean))])) },
  // 스냅샷
  { key: 'snapshotCount', group: 'snap', label: '스냅샷 수', src: 'snap', get: (vm) => (fin(vm.snapshotCount) ? vm.snapshotCount : '') },
  { key: 'snapshotSizeGB', group: 'snap', label: '스냅샷 크기(GB)', src: 'snap', get: (vm) => num(vm.snapshotSizeGB) },
  { key: 'snapshotOldest', group: 'snap', label: '스냅샷 최초 생성', head: (o) => `스냅샷 최초 생성 ${tzName(o?.offsetMin)}`, src: 'snap', get: (vm, d, o) => stamp(o, msOf(vm.snapshotOldestTs)) },
  { key: 'snapshotNewest', group: 'snap', label: '스냅샷 최근 생성', head: (o) => `스냅샷 최근 생성 ${tzName(o?.offsetMin)}`, src: 'snap', get: (vm, d, o) => stamp(o, msOf(vm.snapshotNewestTs)) },
  { key: 'snapshotAgeDays', group: 'snap', label: '가장 오래된 스냅샷 경과 일수', src: 'snap', isNew: true,
    get: (vm, d, o) => { const t = msOf(vm.snapshotOldestTs); return t == null ? '' : Math.max(0, Math.floor(((o?.now ?? Date.now()) - t) / DAY)); } },
  { key: 'snapshotNames', group: 'snap', label: '스냅샷 이름', src: 'snap', get: (vm) => join(vm.snapshotNames) },
  // 장치 · 위생(v2.799 새 묶음 — 구성 캐시 vm.dev / vm.cfg)
  { key: 'cdrom', group: 'dev', label: 'CD-ROM 연결(ISO 경로)', src: 'cache', isNew: true,
    get: (vm, d) => devOnly(d, (v) => join((v.cdroms || []).filter((c) => c.connected === true).map((c) => c.file || (c.host ? '호스트 장치' : '연결됨')))) },
  { key: 'floppy', group: 'dev', label: '플로피 연결 수', src: 'cache', isNew: true, get: (vm, d) => devOnly(d, (v) => (v.floppies || []).filter((f) => f.connected === true).length) },
  { key: 'ports', group: 'dev', label: 'USB · 직렬 · 병렬 장치 수', src: 'cache', isNew: true,
    get: (vm, d) => devOnly(d, (v) => `USB ${fin(v.usb) ? v.usb : '?'} · 직렬 ${fin(v.serial) ? v.serial : '?'} · 병렬 ${fin(v.parallel) ? v.parallel : '?'}`) },
  { key: 'question', group: 'dev', label: '응답 대기 질문', src: 'cache', isNew: true, get: (vm, d) => cfgOnly(d, (c) => c.question?.text || (c.question ? '(내용 없음)' : '')) },
  // 태그 · 속성(v2.799 새 묶음 — vcenter.tagInv)
  { key: 'tags', group: 'meta', label: 'vSphere 태그(카테고리:태그)', src: 'tags', isNew: true,
    cols: (o) => {
      if (!o?.tagCols) return [{ key: 'tags', h: 'vSphere 태그', get: (vm, d) => tagsCell(d) }];
      const cats = [...new Set((o.tagCategories || []).map((c) => String(c || '')).filter(Boolean))];
      const out = cats.map((cat) => ({ key: `tag:${cat}`, h: `태그: ${cat}`, get: (vm, d) => (d?.tg?.tags == null ? MISSING : join(d.tg.tags.filter((t) => t.category === cat).map((t) => t.tag))) }));
      out.push({ key: 'tag:', h: '태그: (카테고리 없음)', get: (vm, d) => (d?.tg?.tags == null ? MISSING : join(d.tg.tags.filter((t) => !t.category || !cats.includes(t.category)).map((t) => t.tag))) });
      return out;
    } },
  { key: 'custom', group: 'meta', label: '사용자 지정 속성', src: 'tags', isNew: true, get: (vm, d) => customCell(d) },
  // Veeam 백업(v2.801 — 위 VEEAM_ITEMS)
  ...VEEAM_ITEMS,
]);

const BY_KEY = new Map(CATALOG.map((it) => [it.key, it]));
export const CATALOG_KEYS = Object.freeze(CATALOG.map((it) => it.key));

/** '예전 CSV 그대로' — v2.278 열 순서(디스크 슬롯 35열 + 8+ 요약 포함). 이 목록을 바꾸면 예전 파일과 열이 어긋난다. */
const LEGACY_KEYS = Object.freeze([
  'vcenter', 'vcenterId', 'name', 'powerState', 'connectionState', 'template', 'cluster', 'host', 'folder', 'resourcePool',
  'guestOS', 'guestId', 'guestHostName', 'toolsStatus', 'toolsVersion', 'toolsVersionStatus', 'hwVersion', 'firmware',
  'uuid', 'instanceUuid', 'cbt', 'createDate', 'bootTime',
  'cpuCount', 'coresPerSocket', 'sockets', 'cpuHotAdd', 'cpuUsagePct', 'cpuReservation', 'cpuLimit',
  'memGB', 'memHotAdd', 'memUsagePct', 'memReservation', 'memLimit',
  'nicCount', 'nics', 'macs', 'networks', 'ipAddress', 'ipAddresses', 'gateways',
  'diskCount', 'diskProvisionedGB', 'datastores', 'diskSlots', 'disksOverflow', 'thinDiskCount', 'rdmCount',
  'storageUsedGB', 'storageUncommittedGB', 'storageProvisionedGB', 'thin',
  'guestPartCount', 'guestCapacityGB', 'guestUsedGB', 'guestFreeGB', 'guestPartsUnknown', 'guestParts',
  'snapshotCount', 'snapshotSizeGB', 'snapshotOldest', 'snapshotNewest', 'snapshotNames', 'gpu', 'notes',
]);
export const PRESETS = Object.freeze([
  { id: 'legacy', name: '예전 CSV 그대로', keys: LEGACY_KEYS },
  { id: 'asset', name: '자산 대장', keys: Object.freeze(['vcenter', 'name', 'powerState', 'cluster', 'host', 'folder', 'guestOsTools', 'guestHostName', 'ipAddress', 'ipAddresses',
    'cpuCount', 'memGB', 'cpuUsagePct', 'memUsagePct', 'diskCount', 'diskProvisionedGB', 'datastores', 'uuid', 'createDate', 'notes', 'tags']) },
  { id: 'capacity', name: '용량 점검', keys: Object.freeze(['name', 'powerState', 'cluster', 'host', 'cpuCount', 'cpuUsagePct', 'cpuReservation', 'cpuLimit', 'memGB', 'memUsagePct',
    'memReservation', 'memLimit', 'diskCount', 'diskProvisionedGB', 'datastores', 'storageUsedGB', 'storageUncommittedGB', 'storageProvisionedGB', 'thinDiskCount',
    'guestCapacityGB', 'guestUsedGB', 'guestFreeGB', 'guestParts', 'snapshotSizeGB']) },
  { id: 'network', name: '네트워크', keys: Object.freeze(['name', 'powerState', 'nicCount', 'nics', 'macs', 'networks', 'ipAddress', 'ipAddresses', 'gateways', 'dns', 'guestHostName']) },
  { id: 'hygiene', name: '위생 점검', keys: Object.freeze(['name', 'powerState', 'connectionState', 'template', 'toolsStatus', 'toolsVersionStatus', 'hwVersion', 'snapshotCount',
    'snapshotOldest', 'snapshotAgeDays', 'cdrom', 'consolidation', 'question', 'cbt', 'uptimeDays']) },
  { id: 'meta', name: '메모 · 태그', keys: Object.freeze(['vcenter', 'name', 'folder', 'notes', 'tags', 'custom']) },
  { id: 'backup', name: '백업 확인', keys: Object.freeze(['name', 'powerState', 'folder', 'vbkYn', 'vlast', 'vres', 'vjudge', 'vsnapYn', 'vsnapTs', 'snapshotCount', 'snapshotNewest']) },   // v2.801
]);
export const DEFAULT_PRESET = 'asset';

/**
 * 요청의 '고른 항목' 검증 — 순서 보존 · 중복 제거. 모르는 항목은 거절한다(조용히 버리면 사람이 고른 열이 파일에서 사라진다).
 * @returns {{ok:true, keys:string[]} | {ok:false, reason:string}}
 */
export function resolveCols(cols) {
  if (!Array.isArray(cols) || !cols.length) return { ok: false, reason: '내보낼 항목을 하나 이상 고르세요.' };
  if (cols.length > MAX_ITEMS) return { ok: false, reason: `항목은 ${MAX_ITEMS}개까지 고를 수 있습니다.` };
  const keys = [];
  for (const k of cols) {
    if (typeof k !== 'string' || !BY_KEY.has(k)) return { ok: false, reason: `모르는 항목입니다: ${String(k).slice(0, 40)}` };
    if (!keys.includes(k)) keys.push(k);
  }
  return { ok: true, keys };
}
/** 저장값을 읽을 때 — 없어진 항목은 빼고 그 수를 센다(저장값 화면이 알린다). */
export function knownKeys(cols) {
  const keys = []; let dropped = 0;
  for (const k of Array.isArray(cols) ? cols : []) { if (typeof k === 'string' && BY_KEY.has(k)) { if (!keys.includes(k)) keys.push(k); } else dropped += 1; }
  return { keys, dropped };
}
/** 고른 항목이 읽는 추가 출처 — live(실시간 보강) · parts(게스트 파티션) · tags(태그 인벤토리). */
export function needsOf(keys) {
  const out = new Set();
  for (const k of keys || []) {
    const it = BY_KEY.get(k);
    if (!it) continue;
    if (it.src === 'live' || it.src === 'both') out.add('live');
    if (it.src === 'parts') { out.add('parts'); out.add('live'); }
    if (it.src === 'tags') out.add('tags');
    if (it.src === 'veeam') out.add('veeam');
  }
  return out;
}
/** 실시간 보강으로만 얻는 항목 수(화면 '이 vCenter 에서 수집 안 됨' 안내). */
export const liveOnlyCount = (keys) => (keys || []).filter((k) => BY_KEY.get(k)?.src === 'live').length;

/**
 * 고른 항목 → 열 목록 [{ key, item, h, group, src, get(vm, d) }] — 한 항목이 여러 열이 될 수 있다.
 * @param {string[]} keys resolveCols 를 통과한 순서
 * @param {{ vcName?:string, offsetMin?:number, now?:number, disk?:'slots'|'join', tagCols?:boolean, tagCategories?:string[], levels?:number, ynDays?:number, snapDays?:number }} o
 */
export function selectedColumns(keys, o = {}) {
  const out = [];
  for (const k of keys) {
    const it = BY_KEY.get(k);
    if (!it) continue;
    const cols = it.cols ? it.cols(o) : [{ key: it.key, h: it.head ? it.head(o) : it.label, get: it.get }];
    for (const c of cols) out.push({ key: c.key, item: it.key, h: c.h, group: it.group, src: it.src, get: (vm, d) => c.get(vm, d, o) });
  }
  return out;
}

/** 예전 열 목록(v2.278 — 테스트·호환용) — { key, label, get(vm, d, ctx) }. 디스크는 슬롯 35열 + 8+ 요약. */
export function legacyColumns() {
  const out = [];
  for (const k of LEGACY_KEYS) {
    const it = BY_KEY.get(k);
    const cols = it.cols ? it.cols({ disk: 'slots' }) : [{ key: it.key, h: it.label, get: it.get }];
    for (const c of cols) out.push({ key: c.key, label: c.h, get: (vm, d, ctx) => c.get(vm || {}, d || {}, ctx || {}) });
  }
  return out;
}

const codeCmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
/** 고를 수 있는 폴더(상위 폴더 포함) — [{ path:'Prod/Web', depth, count(하위 포함 VM 수) }], 화면 트리와 같은 코드 단위 순서. */
export function folderOptions(vms) {
  const count = new Map();
  for (const v of vms || []) {
    const ps = folderParts(v?.folder);
    for (let i = 1; i <= ps.length; i++) { const k = ps.slice(0, i).join('/'); count.set(k, (count.get(k) || 0) + 1); }
  }
  return [...count.entries()].map(([path, n]) => ({ path, depth: path.split('/').length, count: n }))
    .sort((a, b) => { const pa = a.path.split('/'); const pb = b.path.split('/'); for (let i = 0; i < Math.min(pa.length, pb.length); i++) { const c = codeCmp(pa[i], pb[i]); if (c) return c; } return pa.length - pb.length; });
}
/** 그 폴더(하위 폴더 포함)의 VM 인가. path '' 이면 전부. */
export function inFolder(vm, path) {
  const want = folderParts(path || 'vm');
  if (!want.length) return true;
  const ps = folderParts(vm?.folder);
  return want.every((w, i) => ps[i] === w);
}

/** 화면이 받는 카탈로그(함수 없이) — 묶음 · 항목 · 빠른 조합 · 글자. */
export function catalogView({ snapDays = 7 } = {}) {
  return {
    groups: GROUPS.map((g) => ({
      id: g.id, name: g.name, ...(g.isNew ? { isNew: true } : {}), ...(GROUP_NOTES[g.id] ? { note: GROUP_NOTES[g.id] } : {}),
      items: CATALOG.filter((it) => it.group === g.id).map((it) => ({
        key: it.key, label: it.key === 'vsnapN' ? `최근 ${snapDays}일 Veeam 스냅샷 생성 횟수` : it.label, src: it.src, ...(it.isNew ? { isNew: true } : {}),
      })),
    })),
    presets: PRESETS.map((p) => ({ id: p.id, name: p.name, keys: [...p.keys] })),
    defaultPreset: DEFAULT_PRESET,
    missingText: MISSING,
    liveLaterText: LIVE_LATER,
    maxItems: MAX_ITEMS,
    ynDays: [...YN_DAYS], ynDefault: YN_DEFAULT_DAYS,
  };
}
