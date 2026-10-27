/**
 * veeam/vmListCatalog.js — VM 목록 내보내기 '필요한 항목만 고르기' 열 카탈로그(순수, v2.798).
 *
 * 사용자 요청(2026-10-27): "vm list export 하는 기능에서 메모, TAG, 디스크 파티션 종류 등의 구성 정보에서 내가 필요한 것만 선택해서 export"
 *   · 시안 https://claude.ai/artifact/FS8Uk5piEnbFJE7qvLRWQW 승인 · 결정: 저장값은 계정에 · 파일 시스템 종류 수집 포함 · 실시간 조회 항목(생성일·UUID·NIC) 제외.
 *
 * 열은 여기 하나다 — 웹 창(GET /veeam/vm-list/catalog 로 받는다)·CSV·엑셀 '데이터' 시트가 같은 key·머리·칸 값을 쓴다.
 *  · key 는 고정(저장값에 남는다 — 바꾸지 말 것. 지우면 저장값에서 조용히 빠지고 화면이 알린다).
 *  · v2.792 열(vmListCsv.vmListColumns)과 같은 항목은 머리·칸 글자가 같다(테스트가 대조 — cols 를 안 보내면 예전 그대로 그 열을 쓴다).
 *  · 못 읽은 값은 빈칸, 그 vCenter 에서 아직 모으지 않은 소스(태그 수집 전·파티션 수집 안 된 VM·구성 캐시 미도달)는 '수집 안 됨'(MISSING) — 0·'없음' 으로 쓰지 않는다.
 *  · avail = 채워짐 정도(화면 배지): snap 30초 인벤토리 · cache 주기 수집 캐시 · opt 수집을 켜야 함(게스트 파티션) · 바꾸지 않는 값.
 *  · needs = 그 열이 읽는 추가 소스(veeam·tags·parts·marks) — 라우트는 고른 열에 필요한 소스만 읽는다(Veeam 대조는 무겁다).
 */
import { folderParts, offsetLabel, veeamStateText } from './vmListCsv.js';
import { backupVerdict } from './backupStatus.js';
import { localStamp, DAY_OFFSET_MIN } from '../util/dayKey.js';
import { osOfPath } from '../guestpart/rules.js';

export const MISSING = '수집 안 됨';
export const MAX_COLS = 100;
const POWER_TEXT = Object.freeze({ POWERED_ON: '켜짐', POWERED_OFF: '꺼짐', SUSPENDED: '일시 중지' });
const TOOLS_TEXT = Object.freeze({ RUNNING: '실행 중', NOT_RUNNING: '꺼짐' });
const TOOLS_VS_TEXT = Object.freeze({ guestToolsCurrent: '최신', guestToolsNeedUpgrade: '업그레이드 필요', guestToolsNotInstalled: '설치 안 됨', guestToolsUnmanaged: '직접 관리', guestToolsTooOld: '너무 오래됨', guestToolsSupportedOld: '지원(구판)', guestToolsSupportedNew: '지원(신판)', guestToolsTooNew: '너무 새것', guestToolsBlacklisted: '차단 판' });
const CRIT_TEXT = Object.freeze({ high: '중요도 상', mid: '중요도 중', low: '중요도 하' });
const OS_TEXT = Object.freeze({ win: 'Windows', lnx: 'Linux' });
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const num1 = (v) => (fin(v) ? Math.round(v * 10) / 10 : '');
const join = (a) => (Array.isArray(a) ? a.filter((x) => x != null && x !== '').join(' | ') : '');
const onOff = (b) => (b === true ? '켜짐' : b === false ? '꺼짐' : '모름');

export const GROUPS = Object.freeze([
  { id: 'base', name: '기본' },
  { id: 'meta', name: '메모 · 태그 · 속성' },
  { id: 'disk', name: '디스크 · 파티션' },
  { id: 'cfg', name: '구성' },
  { id: 'res', name: '자원 · 네트워크' },
  { id: 'snap', name: '스냅샷' },
  { id: 'veeam', name: 'Veeam 백업' },
]);
export const GROUP_NOTES = Object.freeze({
  meta: '태그·사용자 지정 속성은 vCenter 마다 주기(기본 6시간)로 모읍니다 — 재시작 직후 첫 수집 전에는 ‘수집 안 됨’ 입니다. 백업 표시는 포탈에서 사람이 적은 값입니다.',
  disk: '게스트 파티션은 설정의 게스트 디스크 수집이 켜져 있고 VMware Tools 가 도는 VM 만 있습니다(그 밖은 ‘수집 안 됨’). 파일 시스템 종류는 vSphere 7.0 이상이 주는 값으로 추정합니다(옛 판이면 빈칸). 가상 디스크·CD-ROM 은 구성 캐시(주기 수집)입니다.',
  cfg: '구성 캐시는 주기마다 일부 VM 씩 채웁니다 — 재시작 직후에는 아직 도달하지 않은 VM 이 ‘수집 안 됨’ 입니다.',
});

/* ── 소스 읽기 도우미(행 r 의 모양은 라우트 vmListExport 가 만든다) ──
 * r = { vc(이름), linked, inv(인벤토리 VM), view(vmBackupView — Veeam 열을 고른 때만), tg({tags,custom} | undefined = 수집 안 됨),
 *       parts(파티션 배열 | undefined = 수집 안 됨), part(파티션 한 줄 반복 모드의 그 파티션), mark(markView), marksOk }
 */
const tagsCell = (r) => (r.tg?.tags == null ? MISSING : join(r.tg.tags.map((t) => (t.category ? `${t.category}:${t.tag}` : t.tag))));
const customCell = (r) => (r.tg?.custom == null ? MISSING : join(r.tg.custom.map((c) => `${c.name}=${c.value}`)));
const partsOf = (r) => (r.part ? [r.part] : r.parts);
function partText(p) {
  const cap = fin(p.capGB) ? `${num1(p.capGB)}GB` : '';
  const free = fin(p.capGB) && fin(p.usedGB) ? ` 여유 ${num1(p.capGB - p.usedGB)}` : p.unknown ? ' 여유 모름' : '';
  return `${p.path}${cap ? ` ${cap}` : ''}${free}${p.fs ? ` (${p.fs})` : ''}`;
}
function partSum(parts) {
  let cap = 0; let used = 0; let unk = 0;
  for (const p of parts) { if (fin(p.capGB) && fin(p.usedGB)) { cap += p.capGB; used += p.usedGB; } else unk++; }
  const known = parts.length - unk;
  if (!known) return unk ? '모름' : '';
  return `${num1(cap)} / ${num1(used)} / ${num1(cap - used)}${unk ? ` (모름 ${unk}개 제외)` : ''}`;
}
const cfgOf = (r, f) => (r.inv?.cfg ? f(r.inv.cfg) : MISSING);
const devOf = (r, f) => (r.inv?.dev ? f(r.inv.dev) : MISSING);
function resvText(c) {
  const out = [];
  if (fin(c.cpuReservationMhz) && c.cpuReservationMhz > 0) out.push(`CPU 예약 ${c.cpuReservationMhz}MHz`);
  if (fin(c.cpuLimitMhz) && c.cpuLimitMhz >= 0) out.push(`CPU 제한 ${c.cpuLimitMhz}MHz`);
  if (fin(c.memReservationMB) && c.memReservationMB > 0) out.push(`메모리 예약 ${num1(c.memReservationMB / 1024)}GB`);
  if (fin(c.memLimitMB) && c.memLimitMB >= 0) out.push(`메모리 제한 ${num1(c.memLimitMB / 1024)}GB`);
  if (out.length) return out.join(' · ');
  return [c.cpuReservationMhz, c.cpuLimitMhz, c.memReservationMB, c.memLimitMB].every((x) => x == null) ? '' : '없음';
}

/**
 * 카탈로그 — 항목마다 { key, group, label(화면) , head(o)(파일 머리 — 없으면 label), avail, needs?, get(r, o) }.
 * o = { snapDays, offsetMin, tz, t(ms→포탈 시각) }.
 */
export const CATALOG = Object.freeze([
  // 기본
  { key: 'vc', group: 'base', label: 'vCenter', avail: 'snap', get: (r) => r.vc },
  { key: 'flv', group: 'base', label: '폴더 1~N단계(열 나눔)', avail: 'snap', get: () => '' },   // 열 펼침은 selectedColumns 가 한다
  { key: 'folder', group: 'base', label: '폴더 경로', avail: 'snap', get: (r) => folderParts(r.inv.folder).join('/') },
  { key: 'name', group: 'base', label: 'VM 이름', head: () => 'VM', avail: 'snap', get: (r) => r.inv.name || '' },
  { key: 'power', group: 'base', label: '전원', avail: 'snap', get: (r) => POWER_TEXT[r.inv.powerState] || r.inv.powerState || '' },
  { key: 'tmpl', group: 'base', label: '템플릿', avail: 'snap', get: (r) => (r.inv.template === true ? '예' : '') },
  { key: 'conn', group: 'base', label: '연결 상태', avail: 'snap', get: (r) => r.inv.connectionState || '' },
  { key: 'cluster', group: 'base', label: '클러스터', avail: 'snap', get: (r) => r.inv.cluster || '' },
  { key: 'host', group: 'base', label: '호스트', avail: 'snap', get: (r) => r.inv.host || '' },
  { key: 'rp', group: 'base', label: '리소스 풀', avail: 'snap', get: (r) => r.inv.resourcePool || '' },
  { key: 'os', group: 'base', label: 'Guest OS', avail: 'snap', get: (r) => r.inv.guestOS || '' },
  { key: 'hw', group: 'base', label: 'HW 버전', avail: 'snap', get: (r) => r.inv.hwVersion || '' },
  { key: 'tools', group: 'base', label: 'VMware Tools(상태·버전)', avail: 'snap',
    get: (r) => [TOOLS_TEXT[r.inv.toolsStatus] || r.inv.toolsStatus || '', r.inv.toolsVersion || '', TOOLS_VS_TEXT[r.inv.toolsVersionStatus] || ''].filter(Boolean).join(' · ') },
  // 메모 · 태그 · 속성
  { key: 'notes', group: 'meta', label: '메모(vCenter 주석)', avail: 'snap', get: (r) => String(r.inv.notes || '').trim() },
  { key: 'tags', group: 'meta', label: 'vSphere 태그(카테고리:태그)', avail: 'cache', needs: 'tags', get: tagsCell },
  { key: 'custom', group: 'meta', label: '사용자 지정 속성', avail: 'cache', needs: 'tags', get: customCell },
  { key: 'bmark', group: 'meta', label: '백업 표시(중요도·백업 필요·메모)', avail: 'snap', needs: 'marks',
    get: (r) => (!r.marksOk || !r.mark ? '' : [CRIT_TEXT[r.mark.crit] || '', r.mark.need ? '백업 필요' : '', r.mark.memo || ''].filter(Boolean).join(' · ')) },
  // 디스크 · 파티션
  { key: 'partN', group: 'disk', label: '파티션 수', avail: 'opt', needs: 'parts', get: (r) => (r.parts === undefined ? MISSING : r.parts.length) },
  { key: 'partSum', group: 'disk', label: '파티션 합계(용량 / 사용 / 여유 GB)', avail: 'opt', needs: 'parts', get: (r) => (r.parts === undefined ? MISSING : partSum(r.parts)) },
  { key: 'partDetail', group: 'disk', label: '파티션 상세(경로·용량·여유·파일 시스템)', avail: 'opt', needs: 'parts', get: (r) => (partsOf(r) === undefined ? MISSING : join(partsOf(r).map(partText))) },
  { key: 'partOs', group: 'disk', label: 'OS 계열(파티션 경로로 추정)', avail: 'opt', needs: 'parts',
    get: (r) => { const ps = r.parts; if (ps === undefined) return MISSING; const k = ps.length ? osOfPath(ps[0].path) : ''; return OS_TEXT[k] || ''; } },
  { key: 'fsType', group: 'disk', label: '파일 시스템 종류(NTFS·ext4·xfs)', avail: 'opt', needs: 'parts',
    get: (r) => (partsOf(r) === undefined ? MISSING : join([...new Set(partsOf(r).map((p) => p.fs).filter(Boolean))])) },
  { key: 'vdisk', group: 'disk', label: '가상 디스크(수·크기·데이터스토어·모드)', avail: 'cache',
    get: (r) => devOf(r, (d) => {
      const ds = d.disks || [];
      if (!ds.length) return '0개';
      const caps = ds.map((x) => (fin(x.capacityGB) ? num1(x.capacityGB) : '?')).join('+');
      const stores = [...new Set(ds.map((x) => x.datastore).filter(Boolean))].join(', ');
      const modes = [...new Set(ds.map((x) => x.mode).filter(Boolean))].join(', ');
      return [`${ds.length}개`, `${caps}GB`, stores, modes].filter(Boolean).join(' · ');
    }) },
  { key: 'rdm', group: 'disk', label: 'RDM 디스크', avail: 'cache',
    get: (r) => devOf(r, (d) => { const x = (d.disks || []).filter((k) => k.rdm); return x.length ? `${x.length}개(${[...new Set(x.map((k) => k.rdmMode).filter(Boolean))].join(', ') || '모드 모름'})` : ''; }) },
  { key: 'cd', group: 'disk', label: 'CD-ROM 연결(ISO)', avail: 'cache',
    get: (r) => devOf(r, (d) => join((d.cdroms || []).filter((c) => c.connected === true).map((c) => c.file || (c.host ? '호스트 장치' : '연결됨')))) },
  // 구성
  { key: 'fw', group: 'cfg', label: '펌웨어(BIOS/EFI)', avail: 'cache', get: (r) => cfgOf(r, (c) => (c.firmware ? c.firmware.toUpperCase() : '')) },
  { key: 'hot', group: 'cfg', label: 'CPU·메모리 핫 애드', avail: 'cache', get: (r) => cfgOf(r, (c) => (c.cpuHotAdd == null && c.memHotAdd == null ? '' : `CPU ${onOff(c.cpuHotAdd)} · 메모리 ${onOff(c.memHotAdd)}`)) },
  { key: 'resv', group: 'cfg', label: '예약·제한(CPU·메모리)', avail: 'cache', get: (r) => cfgOf(r, resvText) },
  { key: 'cbt', group: 'cfg', label: 'CBT(변경 블록 추적)', avail: 'cache', get: (r) => cfgOf(r, (c) => (c.cbt == null ? '' : onOff(c.cbt))) },
  { key: 'cons', group: 'cfg', label: '디스크 통합 필요', avail: 'cache', get: (r) => cfgOf(r, (c) => (c.consolidationNeeded === true ? '예' : '')) },
  { key: 'boot', group: 'cfg', label: '마지막 부팅(가동 일수)', head: (o) => `마지막 부팅 ${o.tz}`, avail: 'cache',
    get: (r, o) => cfgOf(r, (c) => (fin(c.bootTime) && c.bootTime > 0 ? `${o.t(c.bootTime)} (${Math.max(0, Math.floor((o.now - c.bootTime) / 86_400_000))}일)` : '')) },
  // 자원 · 네트워크
  { key: 'cpu', group: 'res', label: 'vCPU', avail: 'snap', get: (r) => (fin(r.inv.cpuCount) ? r.inv.cpuCount : '') },
  { key: 'mem', group: 'res', label: '메모리(GB)', avail: 'snap', get: (r) => (fin(r.inv.memMB) ? num1(r.inv.memMB / 1024) : '') },
  { key: 'cpuPct', group: 'res', label: 'CPU 사용률(%)', avail: 'snap', get: (r) => num1(r.inv.cpuUsagePct) },
  { key: 'memPct', group: 'res', label: '메모리 사용률(%)', avail: 'snap', get: (r) => num1(r.inv.memUsagePct) },
  { key: 'stor', group: 'res', label: '스토리지 사용(GB)', avail: 'snap', get: (r) => num1(r.inv.storageGB) },
  { key: 'uncom', group: 'res', label: '미할당 예약(GB)', avail: 'snap', get: (r) => num1(r.inv.uncommittedGB) },
  { key: 'thin', group: 'res', label: 'Thin(추정)', avail: 'snap', get: (r) => (r.inv.thin === true ? '예' : '') },
  { key: 'ip', group: 'res', label: 'IP', avail: 'snap', get: (r) => r.inv.ipAddress || '' },
  { key: 'ips', group: 'res', label: '모든 IP', avail: 'snap', get: (r) => join(r.inv.ipAddresses) },
  { key: 'gw', group: 'res', label: '게이트웨이', avail: 'snap', get: (r) => join(r.inv.gateways) },
  { key: 'dns', group: 'res', label: 'DNS 서버', avail: 'snap', get: (r) => join(r.inv.dns?.servers) },
  // 스냅샷
  { key: 'snN', group: 'snap', label: '스냅샷 수(전체)', avail: 'snap', get: (r) => (fin(r.inv.snapshotCount) ? r.inv.snapshotCount : '') },
  { key: 'snSize', group: 'snap', label: '스냅샷 크기(GB)', avail: 'snap', get: (r) => num1(r.inv.snapshotSizeGB) },
  { key: 'snOld', group: 'snap', label: '스냅샷 가장 오래된 생성', head: (o) => `스냅샷 가장 오래된 생성 ${o.tz}`, avail: 'snap', get: (r, o) => o.t(r.inv.snapshotOldestTs) },
  { key: 'snNew', group: 'snap', label: '스냅샷 최근 생성', head: (o) => `스냅샷 최근 생성 ${o.tz}`, avail: 'snap', get: (r, o) => o.t(r.inv.snapshotNewestTs) },
  { key: 'snNames', group: 'snap', label: '스냅샷 이름', avail: 'snap', get: (r) => (Array.isArray(r.inv.snapshotNames) ? r.inv.snapshotNames.slice(0, 20).join(' | ') : '') },
  // Veeam 백업(v2.792 열 — 판정은 vmBackupView · backupVerdict 그대로)
  { key: 'vjudge', group: 'veeam', label: '백업 판단', avail: 'snap', needs: 'veeam', get: (r) => (r.view ? backupVerdict(r.view, { linked: r.linked }).text : '') },
  { key: 'vstate', group: 'veeam', label: 'Veeam 백업', avail: 'snap', needs: 'veeam', get: (r) => (r.view ? veeamStateText(r.view.v, r.linked) : '') },
  { key: 'vpg', group: 'veeam', label: 'Veeam 진행률(%)', avail: 'snap', needs: 'veeam', get: (r) => (r.view?.v && fin(r.view.v.pg) ? r.view.v.pg : '') },
  { key: 'vjob', group: 'veeam', label: 'Veeam 작업', avail: 'snap', needs: 'veeam', get: (r) => (r.view?.v?.jobs || []).join(' | ') },
  { key: 'vrp', group: 'veeam', label: 'Veeam 복원 지점', avail: 'snap', needs: 'veeam', get: (r) => (r.view?.v && fin(r.view.v.rp) && r.view.v.rp >= 0 ? r.view.v.rp : '') },
  { key: 'vlast', group: 'veeam', label: 'Veeam 마지막 백업 완료', head: (o) => `Veeam 마지막 백업 완료 ${o.tz}`, avail: 'snap', needs: 'veeam', get: (r, o) => o.t(r.view?.v?.lb) },
  { key: 'vres', group: 'veeam', label: 'Veeam 마지막 결과', avail: 'snap', needs: 'veeam', get: (r) => (r.view?.v ? (r.view.v.lr || r.view.v.lastResult || '') : '') },
  { key: 'vtmp', group: 'veeam', label: 'Veeam 임시 스냅샷(지금)', avail: 'snap', needs: 'veeam', get: (r) => (r.view?.s?.now ? r.view.s.now.n : '') },
  { key: 'vtmpTs', group: 'veeam', label: 'Veeam 임시 스냅샷 생성', head: (o) => `Veeam 임시 스냅샷 생성 ${o.tz}`, avail: 'snap', needs: 'veeam', get: (r, o) => o.t(r.view?.s?.now?.ts) },
  { key: 'vtmpStale', group: 'veeam', label: 'Veeam 임시 스냅샷 잔존(하루+)', avail: 'snap', needs: 'veeam', get: (r) => (r.view?.s?.now?.stale ? '예' : '') },
  { key: 'vsnapN', group: 'veeam', label: '최근 N일 Veeam 스냅샷 생성 횟수', head: (o) => `최근 ${o.snapDays}일 Veeam 스냅샷 생성 횟수`, avail: 'snap', needs: 'veeam',
    get: (r) => (!r.view ? '' : r.view.s?.ev === undefined ? '모름' : r.view.s.ev ? (r.view.s.ev.n ?? '') : 0) },
  { key: 'vsnapTs', group: 'veeam', label: 'Veeam 스냅샷 마지막 생성', head: (o) => `Veeam 스냅샷 마지막 생성 ${o.tz}`, avail: 'snap', needs: 'veeam', get: (r, o) => o.t(r.view?.s?.ev?.ts) },
]);
const BY_KEY = new Map(CATALOG.map((c) => [c.key, c]));
export const CATALOG_KEYS = Object.freeze(CATALOG.map((c) => c.key));

/** v2.792 열 순서 그대로의 key 목록 — cols 를 보내지 않은 요청(예전 화면·엑셀 기본)이 쓰는 '전체 열'. */
export const LEGACY_KEYS = Object.freeze(['vc', 'flv', 'folder', 'name', 'power', 'tmpl', 'cluster', 'host', 'os', 'cpu', 'mem', 'stor', 'ip',
  'vjudge', 'vstate', 'vpg', 'vjob', 'vrp', 'vlast', 'vres', 'vtmp', 'vtmpTs', 'vtmpStale', 'vsnapN', 'vsnapTs', 'snN', 'snSize', 'snNew', 'snNames']);

/** 빠른 조합(화면 버튼) — key 목록. */
export const PRESETS = Object.freeze([
  { id: 'base', name: '기본', keys: ['vc', 'folder', 'name', 'power', 'os', 'cpu', 'mem', 'stor', 'ip', 'notes'] },
  { id: 'asset', name: '자산 대장', keys: ['vc', 'folder', 'name', 'power', 'cluster', 'host', 'os', 'hw', 'tools', 'cpu', 'mem', 'stor', 'ips', 'notes', 'tags', 'custom'] },
  { id: 'cfg', name: '구성 점검', keys: ['folder', 'name', 'hw', 'tools', 'fw', 'hot', 'resv', 'cbt', 'cons', 'vdisk', 'cd', 'snN', 'snOld'] },
  { id: 'disk', name: '디스크', keys: ['folder', 'name', 'os', 'stor', 'partN', 'partSum', 'partDetail', 'partOs', 'fsType', 'vdisk', 'rdm'] },
  { id: 'backup', name: '백업 확인', keys: ['folder', 'name', 'power', 'vjudge', 'vstate', 'vlast', 'vres', 'snN', 'bmark'] },
  { id: 'all', name: '전체', keys: CATALOG.map((c) => c.key) },
]);

/**
 * 요청의 cols 검증 — 배열 · 문자열 · 중복 없음 · 아는 key · 상한. 모르는 key 는 조용히 버리지 않고 거절한다(저장값·화면이 어긋난 것을 알린다).
 * @returns {{ok:true, keys:string[]} | {ok:false, reason:string}}
 */
export function resolveCols(cols) {
  if (cols == null) return { ok: true, keys: [...LEGACY_KEYS] };
  if (!Array.isArray(cols)) return { ok: false, reason: '열 목록 형식이 잘못됐습니다.' };
  if (!cols.length) return { ok: false, reason: '내보낼 항목을 하나 이상 고르세요.' };
  if (cols.length > MAX_COLS) return { ok: false, reason: `항목은 ${MAX_COLS}개까지입니다.` };
  const seen = new Set();
  for (const k of cols) {
    if (typeof k !== 'string' || !BY_KEY.has(k)) return { ok: false, reason: `모르는 항목입니다: ${String(k).slice(0, 40)}` };
    if (seen.has(k)) return { ok: false, reason: `같은 항목이 두 번 있습니다: ${k}` };
    seen.add(k);
  }
  return { ok: true, keys: [...cols] };
}
/** 저장값 정리용 — 모르는 key 를 빼고(사라진 항목) 남은 것과 뺀 수. */
export function knownKeys(cols) {
  const keys = (Array.isArray(cols) ? cols : []).filter((k) => typeof k === 'string' && BY_KEY.has(k));
  return { keys: [...new Set(keys)], dropped: (Array.isArray(cols) ? cols.length : 0) - [...new Set(keys)].length };
}
/** 고른 열이 읽는 추가 소스. */
export function needsOf(keys) {
  const s = new Set();
  for (const k of keys) { const n = BY_KEY.get(k)?.needs; if (n) s.add(n); }
  return s;
}

/** 시각 칸 도우미 묶음. */
export function timeCtx({ snapDays = 7, offsetMin = DAY_OFFSET_MIN, now = Date.now() } = {}) {
  return { snapDays, offsetMin, now, tz: offsetLabel(offsetMin), t: (ms) => (fin(ms) && ms > 0 ? localStamp(ms, offsetMin) : '') };
}

/**
 * 고른 key → 실제 열 정의 [{ h, get(r), key, folderLevel? }].
 *  · flv → '폴더 1~N단계'(levels 개) · tagCols 면 tags → 카테고리마다 '태그: <카테고리>'(그 vCenter 의 카테고리 이름 순).
 */
export function selectedColumns(keys, { levels = 1, tagCols = false, tagCategories = [], ...tc } = {}) {
  const o = timeCtx(tc);
  const out = [];
  const lv = Math.max(1, Math.min(32, Number(levels) || 1));
  for (const k of keys) {
    const c = BY_KEY.get(k);
    if (!c) continue;
    if (k === 'flv') {
      for (let i = 0; i < lv; i++) out.push({ key: k, folderLevel: i + 1, h: `폴더 ${i + 1}단계`, get: (r) => folderParts(r.inv.folder)[i] || '' });
      continue;
    }
    if (k === 'tags' && tagCols) {
      const cats = [...new Set((tagCategories || []).map(String).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko'));
      if (!cats.length) { out.push({ key: k, h: c.label, get: (r) => tagsCell(r) }); continue; }
      for (const cat of cats) {
        out.push({ key: k, h: `태그: ${cat}`, get: (r) => (r.tg?.tags == null ? MISSING : join(r.tg.tags.filter((t) => t.category === cat).map((t) => t.tag))) });
      }
      continue;
    }
    out.push({ key: k, h: c.head ? c.head(o) : c.label, get: (r) => c.get(r, o) });
  }
  return out;
}

/** 파티션 한 줄 반복 모드 — 파티션 열(partDetail·fsType)을 고른 때만, 파티션이 있는 VM 은 파티션마다 한 행. */
export const PART_ROW_KEYS = Object.freeze(['partDetail', 'fsType']);
export function expandPartRows(rows, keys, multi) {
  if (multi !== 'partRows' || !keys.some((k) => PART_ROW_KEYS.includes(k))) return rows;
  const out = [];
  for (const r of rows) {
    if (Array.isArray(r.parts) && r.parts.length) for (const p of r.parts) out.push({ ...r, part: p });
    else out.push(r);
  }
  return out;
}

/** 화면용 카탈로그(웹은 목록을 복제하지 않는다). */
export function catalogView({ snapDays = 7 } = {}) {
  return {
    groups: GROUPS.map((g) => ({
      id: g.id, name: g.name, note: GROUP_NOTES[g.id] || '',
      items: CATALOG.filter((c) => c.group === g.id).map((c) => ({ key: c.key, label: c.key === 'vsnapN' ? `최근 ${snapDays}일 Veeam 스냅샷 생성 횟수` : c.label, avail: c.avail })),
    })),
    presets: PRESETS.map((p) => ({ id: p.id, name: p.name, keys: p.keys })),
    legacyKeys: LEGACY_KEYS, maxCols: MAX_COLS, missingText: MISSING,
  };
}
