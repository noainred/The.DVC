/**
 * VM 전체 정보 내보내기 (특수 기능, v2.275 → v2.799 '필요한 항목만 고르기') — 선택한 vCenter 의 VM 을
 * 고른 항목만 한 행으로 펼친다. RVTools 의 탭 체계(vInfo·vCPU·vMemory·vDisk·vPartition·vNetwork·vSnapshot·vTools)를
 * 기준 체크리스트로 삼았다. 항목·머리·칸 값은 vmExportCatalog.js 하나다(CSV·엑셀·미리보기가 같은 함수).
 *
 * 데이터 출처(v2.799 — 실시간이 안 되면 캐시로 대체한다):
 *  1) 수집 스냅샷(store) — 이름/호스트/클러스터/폴더/CPU/메모리/IP/스냅샷/Tools 등(항상 가용).
 *  2) 구성·장치 캐시(vm.cfg·vm.dev — vmcfg/, 주기 수집 · 엣지도 보낸다) — 펌웨어·핫애드·예약·CBT·부팅·디스크(용량·데이터스토어·모드)·CD-ROM.
 *  3) 게스트 디스크 수집 DB(guestdisk/ — 설정에서 켬) — 실시간이 없을 때의 게스트 파티션.
 *  4) 태그 인벤토리(vcenter.tagInv) — vSphere 태그·사용자 지정 속성.
 *  5) 내보내기 시점 라이브 SOAP 1회(retrieveManyObjectProps, 250개씩 페이지) — NIC 상세(MAC·네트워크)·디스크 파일/thin·
 *     게스트 파티션·UUID·생성일·코어 수. 실패하거나 막힌 vCenter(엣지 위임·비활성·점검중·인증 정지)는 1~4 로 계속하고
 *     실시간 전용 칸은 '수집 안 됨'(사유 동봉). ⚠ v2.799 이전에는 이 경우 디스크·파티션 칸까지 모두 빈칸이었다(결함 7).
 *
 * v2.799 결함 수정(사용자 요청 '버그 수정' — 시안 https://claude.ai/artifact/FCUJ73AgKCxpzcr4J6Y6TC):
 *  ① NIC·디스크 수: 보강이 성공해도 그 VM 이 응답에 없으면 0 을 썼다 → VM 마다 실시간 속성 유무로 판정('수집 안 됨').
 *  ② Thin 여부: uncommitted 를 못 읽어도 'N' → 빈칸. ③ 메모리: memMB 결측 → 0/NaN → 빈칸.
 *  ④ 시각이 UTC(…Z) → 포탈 시각(localStamp) + 머리에 시간대. ⑤ 동시 1건(acquireExport)·감사 로그 없음 → 라우트.
 *  ⑥ 화면을 열기만 해도 전량 실시간 조회 → 미리보기는 실시간을 부르지 않는다(실시간 칸은 '내려받을 때 조회').
 *
 * 실시간 결과는 vCenter 단위 60초 캐시(buildVmExport — 연달아 받는 CSV·엑셀이 라이브 조회를 두 번 하지 않게).
 * 캐시에는 장치 XML 원문 대신 해석한 값만 둔다(VM 1,500대 × 수십 KB 를 60초 붙잡지 않게). 사용자 scope 검사는 라우트에서
 * vCenter 단위로 끝난 뒤 호출되므로 캐시에 사용자 차원은 없다.
 */

import { VimSoapClient } from './soapClient.js';
import { parseVmDevices, parseGuestDisks } from './soapParse.js';
import { store } from '../store.js';
import { loadVcenterConfig } from '../config.js';
import { onDemandVcBlock, onDemandLoginError } from './dsBrowse.js';   // v2.742(VC-03): 주문형 로그인 문(collectTarget·authStopGate 를 묶은 것)
import { DAY_OFFSET_MIN } from '../util/dayKey.js';
import { partsForVcenter } from '../guestdisk/db.js';   // v2.798 — 한 vCenter 의 파티션 최신 값(파일 시스템 종류 포함) + 수집에 든 VM
import { load as loadGuestDiskSettings } from '../guestdisk/settings.js';
import { vmRefOf, vmTagsOf, tagStateOf } from '../tags/analyze.js';
import {
  MISSING, LIVE_LATER, FOLDER_LEVELS_MAX, PRESETS, selectedColumns, needsOf, legacyColumns, guestKnownSum, folderParts, folderOptions, inFolder,
} from './vmExportCatalog.js';
import { ynDaysOf } from '../veeam/backupStatus.js';
import { vmExportSummary } from './vmExportSummary.js';   // v2.801 엑셀 '요약' 시트

export { guestKnownSum };
/** 예전 열 목록(v2.278 — '예전 CSV 그대로' 조합과 같다). get(vm, d, ctx) 모양을 테스트·호환이 쓴다. */
export const VM_EXPORT_COLUMNS = Object.freeze(legacyColumns());
export const LEGACY_KEYS = PRESETS.find((p) => p.id === 'legacy').keys;

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

/** 라이브 보강 — 대상 vCenter 에 로그인해 per-VM 상세 속성을 한 번에 가져온다.
 *  (v2.459: 게스트 디스크 회수 리포트 폴러가 같은 벌크 조회를 재사용하므로 export 한다.) */
export async function collectDetails(vc, morefs, { signal = null } = {}) {
  // v2.598 T2598-02: 호출부(게스트 디스크)의 시한 신호를 SOAP 요청에 건다 — 결과만 포기하면 세션이 남은 조회를 계속한다.
  // 로그아웃은 VimSoapClient 가 신호와 무관하게 보낸다(ignoreExternal).
  const c = new VimSoapClient(vc, { signal });
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

const labelCmp = (a, b) => String(a.label).localeCompare(String(b.label), undefined, { numeric: true });
/**
 * 실시간 속성 한 VM → 캐시에 둘 값. 장치 목록을 받지 못했으면 nics·disks 는 null(모름 — 0 개가 아니다).
 * guest.disk 가 없으면 []( Tools 가 파티션을 보고하지 않았다 — 칸은 빈칸).
 */
export function compactLive(props) {
  const { 'config.hardware.device': devXml, 'guest.disk': guestXml, ...rest } = props || {};
  let nics = null; let disks = null;
  if (typeof devXml === 'string' && devXml) {
    const p = parseVmDevices(devXml);
    nics = p.nics;
    // 슬롯 배치는 라벨 자연순(Hard disk 1, 2, … 10) — 디바이스 XML 순서가 라벨 순과 다른 드문 구성에서도
    // '디스크1' 슬롯이 Hard disk 1 을 가리키게 한다(numeric 비교로 10>2 오정렬 방지).
    disks = p.disks.sort(labelCmp);
  }
  return { props: rest, nics, disks, guest: parseGuestDisks(typeof guestXml === 'string' ? guestXml : '') };
}

// vCenter 단위 결과 캐시(60초) — 미리보기(JSON)와 CSV 다운로드가 연달아 와도 라이브 조회 1회.
// 진행 중 프라미스를 캐시해 동시 요청도 합류시킨다.
// ⚠ v2.583 감사 #27(dsBrowse v2.277 과 같은 결함): TTL 을 **시작 시각**부터 재면 60초를 넘긴 라이브 조회가 진행 중인데도
//   '만료' 로 판정돼 같은 vCenter 에 두 번째 전량 조회가 시작되고 첫 결과는 버려졌다. 완료된 결과는 **완료 시각**부터
//   60초 유지하고, 진행 중인 것은 합류시킨다. 단 진행 중 상한(10분)을 둔다 — 이 경로에는 자체 시한이 없어, 매달린
//   조회에 영원히 합류하면 다시 시도할 길이 없다.
const _cache = new Map(); // vcenterId -> { startedAt, at(완료 시각, 진행 중엔 0), settled, promise }
const CACHE_MS = 60_000;
const PENDING_MAX_MS = 10 * 60_000;

// v2.605(감사 TIM2605-01): 완료 항목은 60초가 지나면 Map 에서 지운다(예전에는 만료 판정만 하고 남겨, vCenter 마다
//   마지막 export 결과가 프로세스 수명 동안 상주했다). 조회 때 만료분 청소 + 완료 시 unref 타이머.
function sweepExpired(now = Date.now()) {
  for (const [k, e] of _cache) if (e.settled && now - e.at >= CACHE_MS) _cache.delete(k);
}
/** 테스트·진단용 — 캐시 항목 수. */
export function _vmExportCacheSize(now) { sweepExpired(now); return _cache.size; }

/**
 * 실시간 보강(캐시 60초) — { vcenterId, vcenterName, enriched, enrichError, enrichBlocked?, total, details: Map<moref, compactLive> }.
 * v2.799: 예전에는 여기서 85+열 행까지 만들었다 — 이제 실시간 값만 돌려주고 표는 buildVmExportTable 이 고른 항목으로 만든다.
 */
export function buildVmExport(vcenterId) {
  sweepExpired();
  const hit = _cache.get(vcenterId);
  const now = Date.now();
  if (hit && (hit.settled ? now - hit.at < CACHE_MS : now - hit.startedAt < PENDING_MAX_MS)) return hit.promise;
  const entry = { startedAt: now, at: 0, settled: false, promise: null };
  entry.promise = buildVmExportFresh(vcenterId)
    .then((r) => {
      entry.settled = true; entry.at = Date.now();
      // v2.742(VC-03): 로그인하지 않은 결과(비활성·점검중·위임·인증 정지 — 거부 포함)는 기억하지 않는다. 비밀번호를 고치거나
      //   점검을 끝낸 직후의 내보내기가 60초 동안 '조회하지 않았습니다' 를 되풀이하지 않게.
      if (r?.enrichBlocked) { if (_cache.get(vcenterId) === entry) _cache.delete(vcenterId); return r; }
      const t = setTimeout(() => { if (_cache.get(vcenterId) === entry) _cache.delete(vcenterId); }, CACHE_MS);
      t.unref?.();
      return r;
    })
    .catch((e) => { if (_cache.get(vcenterId) === entry) _cache.delete(vcenterId); throw e; });
  _cache.set(vcenterId, entry);
  return entry.promise;
}

/**
 * 실시간 보강을 할 수 있는가(로그인하지 않고 판정) — 화면 상태·내보내기가 같은 판정.
 * @returns {{state:'ok'} | {state:'demo'|'noConfig'|'blocked', reason:string, skipReason?:string, authStopped?:object}}
 */
export function liveAvailability(vcenterId, snap = store.get()) { return liveGate(vcenterId, snap).av; }
// 접속 정보(비밀번호 포함)는 응답 객체에 섞지 않는다 — 판정(av)과 접속 정보를 따로 돌려준다.
function liveGate(vcenterId, snap) {
  if (snap?.source === 'mock') return { av: { state: 'demo', reason: '데모 모드 — 실시간 보강(NIC/UUID/생성일/디스크 파일)을 조회하지 않습니다' }, vcCfg: null };
  let vcCfg = null;
  try { vcCfg = loadVcenterConfig().vcenters.find((v) => v.id === vcenterId) || null; } catch { vcCfg = null; }
  if (!vcCfg) return { av: { state: 'noConfig', reason: 'vCenter 접속 정보 없음 — 실시간 보강을 할 수 없습니다' }, vcCfg: null };
  // v2.742(감사 VC-03): 비활성·점검중·엣지 위임·인증 정지 vCenter 에는 라이브 보강 로그인을 하지 않는다(판정은 dsBrowse.js
  //   onDemandVcBlock — collectTarget·authStopGate 를 그대로 쓴다).
  const block = onDemandVcBlock(vcCfg);
  if (block) return { av: { state: 'blocked', reason: block.reason, ...(block.skipReason ? { skipReason: block.skipReason } : { authStopped: block.authStopped }) }, vcCfg: null };
  return { av: { state: 'ok' }, vcCfg };
}

async function buildVmExportFresh(vcenterId) {
  const snap = store.get();
  const vc = (snap.vcenters || []).find((v) => v.id === vcenterId);
  const vms = (snap.vms || []).filter((v) => v.vcenterId === vcenterId);
  const vcName = vc?.name || vcenterId;

  // 라이브 보강 — 실패해도 내보내기는 다른 출처로 계속(사유 동봉).
  const details = new Map();
  let enriched = false;
  let enrichError = '';
  let enrichBlocked = null;   // v2.742(VC-03): 로그인하지 않은(또는 거부된) 사유 — { skipReason } | { authStopped }
  const { av, vcCfg } = liveGate(vcenterId, snap);
  if (av.state !== 'ok') {
    enrichError = av.state === 'blocked' ? `${av.reason} — 실시간 보강을 조회하지 않고 캐시 값으로 내보냅니다` : av.reason;
    if (av.state === 'blocked') enrichBlocked = av.skipReason ? { skipReason: av.skipReason } : { authStopped: av.authStopped };
  } else {
    try {
      // vc.id 에는 콜론이 있을 수 있어 split(':') 금지 — 알려진 프리픽스 길이로 잘라낸다.
      const morefs = vms.map((v) => v.id.slice(vcenterId.length + 1)).filter(Boolean);
      if (morefs.length) for (const [ref, props] of await collectDetails(vcCfg, morefs)) details.set(ref, compactLive(props));
      enriched = true;
    } catch (e) {
      // 로그인 거부(자격증명)는 주 폴러와 같은 정지 기록에 올린다 — 다음 내보내기는 로그인하지 않는다.
      const le = onDemandLoginError(vcCfg, e);
      if (le !== e && le.authStopped) enrichBlocked = { authStopped: le.authStopped };
      enrichError = `실시간 보강 실패(${String(e?.message || e).slice(0, 300)}) — 캐시 값으로 내보냅니다`;
    }
  }
  return { vcenterId, vcenterName: vcName, enriched, enrichError, ...(enrichBlocked ? { enrichBlocked } : {}), total: vms.length, details };
}

/** 게스트 파티션(수집 DB) — { collected:Set<vmId>, byVm:Map<vmId, parts[]> } | null(DB 없음·읽기 실패). 실시간 guest.disk 와 같은 모양으로 바꾼다. */
async function partsFromDb(vcenterId) {
  try {
    const p = await partsForVcenter(vcenterId);
    if (!p) return null;
    const byVm = new Map();
    for (const [vmId, rows] of p.byVm) {
      byVm.set(vmId, rows.map((r) => {
        const known = r.capGB != null && r.usedGB != null;
        return { path: r.path, capacityGB: r.capGB, usedGB: known ? r.usedGB : null, freeGB: known ? Math.round((r.capGB - r.usedGB) * 10) / 10 : null, ...(r.fs ? { fs: r.fs } : {}) };
      }));
    }
    return { collected: p.collected, byVm, ts: p.ts };
  } catch { return null; }
}

// 구성 캐시 디스크(vmcfg parseVmDeviceHygiene) → 실시간 디스크와 같은 모양. 파일 경로·thin 은 캐시에 없다(null = 모름).
const cacheDisk = (x) => ({ label: x.label || '', capacityGB: x.capacityGB ?? null, thin: null, rdm: x.rdm === true, mode: x.mode || '', datastore: x.datastore || '', fileName: null, sharing: x.sharing || null });
const DEV_LIST_MAX = 32;

/**
 * VM 한 대의 출처 묶음(vmExportCatalog 의 d). 실시간 값이 있으면 그것, 없으면 캐시.
 * @param {object} vm 스냅샷 VM
 * @param {{ vcenterId:string, live:object|null, partsDb:object|null, tagInv:object|null, liveMiss:string }} src
 */
export function rowContext(vm, src) {
  const ref = vm.id.slice(src.vcenterId.length + 1);
  const lv = src.live ? src.live.get(ref) || null : null;
  const d = { live: !!lv, props: lv?.props || {}, nics: lv ? lv.nics : null, liveMiss: src.liveMiss, cfg: vm.cfg || null, dev: vm.dev || null, tg: null };
  if (lv && Array.isArray(lv.disks)) { d.disks = lv.disks; d.diskSrc = 'live'; }
  else if (vm.dev && Array.isArray(vm.dev.disks)) {
    d.disks = vm.dev.disks.map(cacheDisk).sort(labelCmp);
    d.diskSrc = 'cache';
    // 장치 목록은 종류마다 32개까지만 싣는다(omitted) — 그때 디스크 수·합계는 모른다.
    d.disksPartial = Number(vm.dev.omitted) > 0 && vm.dev.disks.length >= DEV_LIST_MAX;
  } else { d.disks = null; d.diskSrc = null; }
  if (lv) d.guest = lv.guest;
  else if (src.partsDb) d.guest = src.partsDb.collected.has(vm.id) ? (src.partsDb.byVm.get(vm.id) || []) : null;
  else d.guest = null;
  if (src.tagInv) d.tg = vmTagsOf(src.tagInv, vmRefOf(src.vcenterId, vm.id) || ref);
  // v2.801 Veeam 묶음 — src.bv: undefined(고르지 않음) · null(못 읽음 → 칸 '수집 안 됨') · { linked, byId }.
  if (src.bv) { d.bv = src.bv.byId?.get(vm.id) ?? null; d.bvLinked = src.bv.linked !== false; }
  return d;
}

const nameCmp = (a, b) => String(a.name).localeCompare(String(b.name));

/**
 * 고른 항목의 표 — CSV·엑셀·미리보기가 같은 함수(v2.799).
 * @param {string} vcenterId 라우트가 scope 를 이미 확인한 vCenter
 * @param {{ keys:string[], live?:boolean, disk?:'slots'|'join', tagCols?:boolean, target?:'all'|'on'|'folder', folder?:string, tmpl?:boolean,
 *           ids?:string[], preview?:boolean, limit?:number, now?:number, maybeYield?:()=>Promise<void>,
 *           ynDays?:number, summary?:boolean, veeamViews?:(vc, vms)=>Promise<{linked,snapDays,byId}|null> }} sel
 *   v2.801: ynDays = '여부' 기준 일수(1·2·3·7, 기본 1) · summary = 엑셀 '요약' 시트 숫자도 만든다 · veeamViews = Veeam 판정을 읽는 함수
 *   (라우트가 veeam/vmViewProvider 로 건다 — 이 파일은 req 를 모른다). Veeam 은 Veeam 항목을 골랐거나 요약을 만들 때만 읽는다(vCenter 전체 대조라 무겁다).
 * @returns {Promise<{ head:string[], cells:any[][], cols:Array<{key,item,h,group,src}>, rowFolder:string[], rowPower:string[], summary?:object, meta:object }>}
 */
export async function buildVmExportTable(vcenterId, sel) {
  const now = sel.now ?? Date.now();
  const maybeYield = sel.maybeYield || (async () => {});
  const snap = store.get();
  const vc = (snap.vcenters || []).find((v) => v.id === vcenterId) || { id: vcenterId };
  const vcName = vc.name || vcenterId;
  const all = (snap.vms || []).filter((v) => v.vcenterId === vcenterId);
  const ids = Array.isArray(sel.ids) ? new Set(sel.ids.filter((x) => typeof x === 'string')) : null;
  let list = all.filter((vm) => (sel.tmpl === false ? vm.template !== true : true)
    && (sel.target === 'on' ? vm.powerState === 'POWERED_ON' : true)
    && (sel.target === 'folder' ? inFolder(vm, sel.folder || '') : true)
    && (ids ? ids.has(vm.id) : true));
  list.sort(nameCmp);
  const matched = list.length;   // 대상 조건에 맞는 VM 수(미리보기는 앞 몇 대만 만든다)
  if (Number.isInteger(sel.limit) && sel.limit >= 0) list = list.slice(0, sel.limit);

  const need = needsOf(sel.keys);
  let L = null;
  let live;
  if (!sel.live) live = { state: 'off' };
  else if (!need.has('live')) live = { state: 'unused' };
  else if (sel.preview) live = { state: 'preview', ...liveStateOf(liveAvailability(vcenterId, snap)) };
  else {
    L = await buildVmExport(vcenterId);
    const got = L.enriched ? list.filter((vm) => L.details.has(vm.id.slice(vcenterId.length + 1))).length : 0;
    live = L.enriched ? { state: 'ok', vms: got, rows: list.length } : { state: L.enrichBlocked ? 'blocked' : 'failed', reason: L.enrichError, ...(L.enrichBlocked || {}) };
  }
  const partsDb = need.has('parts') ? await partsFromDb(vcenterId) : null;
  const tagInv0 = need.has('tags') ? (vc.tagInv || null) : null;
  const tagState = tagStateOf(tagInv0);
  const tagInv = tagInv0 && ['ok', 'stale'].includes(tagState) ? tagInv0 : null;
  const ynDays = ynDaysOf(sel.ynDays);
  let views;   // undefined = 읽지 않음 · null = 못 읽음
  if (need.has('veeam') || sel.summary === true) views = typeof sel.veeamViews === 'function' ? await sel.veeamViews(vc, all) : null;

  let levels = 1;
  for (const vm of list) levels = Math.max(levels, folderParts(vm.folder).length);
  const o = {
    vcName, offsetMin: DAY_OFFSET_MIN, now, disk: sel.disk === 'join' ? 'join' : 'slots', tagCols: sel.tagCols === true,
    tagCategories: (tagInv?.categories || []).map((c) => c?.name), levels: Math.min(FOLDER_LEVELS_MAX, levels),
    ynDays, snapDays: views?.snapDays ?? 7,
  };
  const cols = selectedColumns(sel.keys, o);
  const src = { vcenterId, live: L?.enriched ? L.details : null, partsDb, tagInv, liveMiss: sel.preview && sel.live ? LIVE_LATER : MISSING,
    bv: need.has('veeam') ? (views || null) : undefined };
  const cells = []; const rowFolder = []; const rowPower = [];
  const filled = new Array(cols.length).fill(0);
  for (const vm of list) {
    await maybeYield();
    const d = rowContext(vm, src);
    const row = cols.map((c) => c.get(vm, d));
    for (let i = 0; i < row.length; i++) { const v = row[i]; if (v !== '' && v != null && v !== MISSING && v !== LIVE_LATER) filled[i] += 1; }
    cells.push(row);
    rowFolder.push(folderParts(vm.folder).join('/')); rowPower.push(vm.powerState || '');
  }
  return {
    head: cols.map((c) => c.h),
    cells,
    cols: cols.map((c, i) => ({ key: c.key, item: c.item, h: c.h, group: c.group, src: c.src, filled: filled[i] })),
    rowFolder, rowPower,
    ...(sel.summary === true ? { summary: vmExportSummary(list, { views: views || null, ynDays, now }) } : {}),
    meta: {
      vcenterId, vcenterName: vcName, total: all.length, matched, rows: list.length, live, at: now, offsetMin: DAY_OFFSET_MIN,
      tags: need.has('tags') ? tagState : null, parts: need.has('parts') ? (partsDb ? 'ok' : 'unreadable') : null,
      veeam: views === undefined ? null : views ? (views.linked ? 'ok' : 'unlinked') : 'unreadable', ynDays,
    },
  };
}
const liveStateOf = (av) => (av.state === 'ok' ? { can: true } : { can: false, reason: av.reason, ...(av.skipReason ? { skipReason: av.skipReason } : {}), ...(av.authStopped ? { authStopped: av.authStopped } : {}) });

/**
 * 화면 상태(GET /tools/vm-export/catalog) — 그 vCenter 의 출처마다 지금 상태. 로그인하지 않는다.
 * 숫자는 모르면 null(0 이 아니다).
 */
export async function vmExportStatus(vcenterId) {
  const snap = store.get();
  const vc = (snap.vcenters || []).find((v) => v.id === vcenterId) || {};
  const vms = (snap.vms || []).filter((v) => v.vcenterId === vcenterId);
  const av = liveAvailability(vcenterId, snap);
  let partsOn = null;
  try { partsOn = loadGuestDiskSettings()?.enabled === true; } catch { partsOn = null; }
  const pdb = await partsFromDb(vcenterId);
  const partVms = pdb ? pdb.collected.size : null;
  const partAt = pdb ? pdb.ts : null;
  const inv = vc.tagInv || null;
  return {
    vcenterId, vcenterName: vc.name || vcenterId,
    vmTotal: vms.length, vmOn: vms.filter((v) => v.powerState === 'POWERED_ON').length, templates: vms.filter((v) => v.template === true).length,
    invAt: snap.generatedAt || null,
    cfgVms: vms.filter((v) => v.cfg).length, devVms: vms.filter((v) => v.dev).length,
    live: { state: av.state, ...(av.reason ? { reason: av.reason } : {}), ...(av.skipReason ? { skipReason: av.skipReason } : {}), ...(av.authStopped ? { authStopped: av.authStopped } : {}) },
    parts: { on: partsOn, vms: partVms, at: partAt },
    tags: { state: tagStateOf(inv), at: inv?.tagsAt ?? null, categories: Array.isArray(inv?.categories) ? inv.categories.length : 0 },
    folders: folderOptions(vms),
  };
}
