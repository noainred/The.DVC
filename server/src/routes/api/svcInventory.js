/**
 * routes/api/svcInventory.js — 특수 기능 '서비스 인벤토리'(도구 키 `svc-inventory`, v2.887).
 *   설계: docs/design/service-map/README.md(시안 A 3차 + 4차 검토, 사용자 선택 '시안 2 — 카탈로그 + 매트릭스').
 *
 * VM(vCenter)과 베어메탈(iDRAC/OS)을 법인 › 폴더 › 서비스로 묶는다. ESXi 호스트는 구성원이 아니라 파생(영향 호스트).
 * **새 수집기가 없다** — 스냅샷·통합 서버 인벤토리·베어메탈 사용률·부품 장애·Bareos 원장을 읽는 시점에 조인한다(장비·vCenter 왕복 0).
 *
 * 구조: 입력 수집(gather — 여기, 라우트 계층: 법인별 사용량 라우트의 입력 헬퍼를 재사용하므로 도메인 모듈에 두지 않는다 — 의존 방향 규약)
 *       → 판정·집계·큐(servicemap/build.js — 순수) → 범위 절단·가림.
 *
 * ── 권한 ─────────────────────────────────────────────────────────────────────
 *  · 조회: `tools` + vCenter 범위(요청 필터보다 먼저). 법인 귀속 없는 서버는 범위 계정에 주지 않는다.
 *  · 법인 쓰기(폴더·서비스·규칙·별칭·고정·스캔 라벨): admin/operator · 데모 계정 아님 · '조회 밖 404 → 쓰기 밖 403'(corpWriteAccess).
 *    쓰기 범위 미설정 = 조회 범위 전체에 쓰기 가능(auth/scope.js 기본값 — 4차 반증 6).
 *  · 전역 카탈로그·태그 카테고리·손상 초기화: admin · 전체 범위.
 *  · 비관리자 판본: 스캔 엔트리 대역(CIDR)·주소처럼 보이는 이름을 싣지 않는다(4차 반증 13).
 * ── 캐시 ─────────────────────────────────────────────────────────────────────
 *  · 입력 수집: 스냅샷 세대 + 태그 카테고리마다 1회(무거운 분류·사용률·장애 조회).
 *  · 응답: memoJson + extraKey = 범위 | 쓰기 범위 | 관리자 판본 | 저장소 rev (4차 반증 8 — 같은 범위의 다른 계정이 서로의 판본을 받지 않게).
 * ⚠ 폴링하지 않는다(화면은 마운트 1회 + 새로고침 + 쓰기 뒤 재조회).
 */
import crypto from 'node:crypto';
import { requirePerm, requireRole } from '../../auth/auth.js';
import { scopedVcenterIds, inUserScope, inUserWriteScope, writeScopedVcenterIds } from '../../auth/scope.js';
import { isDemoGuest, isAdminDetailUser } from '../../auth/demoGuest.js';
import { todayStamp } from '../../util/dayKey.js';   // 파일명 날짜 = 설정 오프셋의 '오늘'(UTC 날짜 금지 — v2.582 BUG-3)
import { addressMatcher, maskedAddressName, maskedIdToken, MASK_TOKEN_PREFIX } from '../../auth/addressMask.js';
import { store } from '../../store.js';
import { loadVcenterConfig } from '../../config.js';
import { memoJson, scopeKey } from './shared.js';
import { logAudit } from '../../audit.js';
import { numOrNull } from '../../util/numOrNull.js';
import { csvLine, CSV_BOM } from '../../util/csv.js';
import { acquireExport } from '../../util/exportBusy.js';
import { buildCorpUsage } from '../../corpusage/build.js';
import { idOf } from '../../bmusage/targets.js';
import { loadBmUsageSettings } from '../../bmusage/settings.js';
import { latestUsage } from '../../bmusage/db.js';
import { vmRefOf, vmTagsOf, tagsPartialOf } from '../../tags/analyze.js';
import { buildInventory, hostKeyOf } from '../../servicemap/build.js';
import { CORP_OPS, FLEET_OPS } from '../../servicemap/ops.js';
import { getMap, getPins, peekMap, peekPins, storeRev, storeLoadError, mutateMap, mutatePins, flushStore, resetCorrupt, LIMITS } from '../../servicemap/store.js';
import { mergeLatestRows, rowsByAgentKeyOf, makeCapOf, clampEdgeTs } from './corpUsage.js';

const toolsPerm = requirePerm('tools');
const csvPerm = requirePerm('data.csv');
const writeRole = requireRole('admin', 'operator');
const t = (v) => String(v ?? '').trim();
const lc = (v) => t(v).toLowerCase();
const DAY = 86_400_000;

// ───────── 구성원 키 ─────────
/** VM 키 — instanceUuid 가 있으면 `iu:<vcenterId>:<uuid>`(vCenter 안에서만 유일 — 4차 반증 17), 없으면 `vm:<vm.id>`(moref). */
export function vmKeyOf(vm) {
  const u = lc(vm?.instanceUuid);
  return u ? { key: `iu:${t(vm.vcenterId)}:${u}`, keyKind: 'instanceUuid' } : { key: `vm:${t(vm?.id)}`, keyKind: 'moref' };
}
/** 베어메탈 키 — 서비스태그가 있으면 `st:<태그 소문자>`, 없으면 `fl:<fleetId 해시>`(fleetId 가 주소일 수 있어 원문을 키에 싣지 않는다). */
export function bmKeyOf(b) {
  const tag = lc(b?.serviceTag);
  if (tag) return { key: `st:${tag}`, keyKind: 'serviceTag' };
  const f = lc(b?.fleetId || b?.serverId || b?.name);
  return { key: `fl:${crypto.createHash('sha1').update(f).digest('hex').slice(0, 16)}`, keyKind: 'fleetId' };
}
/**
 * 5차 R15 — 키 등급이 오르면(VM: moref → instanceUuid · 베어메탈: fleetId → 서비스태그) 그 전에 낮은 등급 키로 저장한 고정을 잃지 않게
 * **낮은 등급 키를 별칭으로** 싣는다. 판정은 별칭 고정을 그 구성원의 고정으로 쓰고(resolveMember), 유령으로 보지 않는다(buildQueues live).
 * 별칭 고정은 다음 고정 쓰기 때 새 키로 옮기거나 검토 탭 '새 키로 옮기기'(`pins.rekey`)로 옮긴다 — 읽기 경로에서는 쓰지 않는다.
 */
export function vmAliasKeys(vm, keyKind) { return keyKind === 'instanceUuid' && t(vm?.id) ? [`vm:${t(vm.id)}`] : []; }
export function bmAliasKeys(b, keyKind) {
  if (keyKind !== 'serviceTag') return [];
  // 태그가 없을 때의 fleetId — 함대 분류(`insights/fleetInventory.js`)와 같은 규칙: 일반 행 norm(serverId) · ESXi 호스트 행(host:) norm(name).
  // ⚠ 4차 반증 1: 예전에는 lc(fleetId) 로 만들었는데 태그가 읽힌 뒤 fleetId 는 태그라서 옛 키와 절대 맞지 않았다(승계가 동작하지 않음).
  // 엣지 보고분은 serverId 자체가 `edge:<agent>:<fleetId>` 라 태그가 읽히면 바뀐다 — 엣지가 보낸 '태그 없을 때 id' 로 만든 serverId 를 쓴다(6차 2).
  //   구버전 엣지(필드 없음)는 승계하지 못한다(예전과 같다 — 옛 고정은 유령으로 보인다).
  const sid = t(b?.untaggedServerId) || t(b?.serverId);
  const f = !b?.untaggedServerId && sid.startsWith('host:') ? lc(b?.name) : lc(sid);
  return f ? [`fl:${crypto.createHash('sha1').update(f).digest('hex').slice(0, 16)}`] : [];
}
/** Bareos 원장 → VM 백업 칸(순수). undefined = Bareos 미사용 · null = 원장 못 읽음 · 'ok' 24h 내 성공 · 'fail' 실패/지연 · 'none' 잡 없음. */
export function backupOf(view, now) {
  if (view === null) return null;
  if (!view || view.job === false) return 'none';
  if (view.st === 'error' || view.st === 'canceled') return 'fail';
  const okAt = numOrNull(view.ok) ?? (view.st === 'ok' || view.st === 'warning' ? numOrNull(view.at) : null);
  if (okAt != null && now - okAt <= DAY) return 'ok';
  return view.job ? 'fail' : 'none';
}

/**
 * 베어메탈의 스캔 엔트리(순수 — 5차 R6·R18). 등록부 서버는 등록부 scanRangeId, 엣지 push 는 serverId, 수집 서버 pull 은 `remote:<수집기>:<서버>` 로 찾는다.
 * scan 이 없으면 이유: 'unknown-entry'(엔트리 id 는 왔는데 중앙 등록부에 없음) · 'old-source'(엣지·수집 서버가 필드를 보내지 않음 = 구버전) ·
 * 'not-reported'(엣지·수집 서버 출처인데 그 서버의 등록 정보가 오지 않음 — OME 장치·서버 목록을 보내지 않는 수집 서버·아직 못 받음) · 없음(수동 등록).
 * ⚠ 'not-reported' 를 수동 등록으로 단정하지 말 것(2차 반증 1 — 값이 없는 이유를 단정하지 않는다).
 * 수집 서버 경로가 엔트리 id 를 주지 않으면(null·undefined) **같은 서비스 태그의 엣지 push 값**을 쓴다(2차 반증 5 — 혼합 버전 기간에
 * 2.887~2.892 엣지가 이미 보낸 id 를 버리지 않게). 태그가 둘 이상의 엣지 기록에서 다른 값이면 쓰지 않는다(edgeScanByTag 에 넣지 않는다).
 */
export function scanInfoOf(b, { edgeScan = new Map(), remoteScan = new Map(), regById = new Map(), scanEntries = new Map(), edgeScanByTag = new Map() } = {}) {
  const sid = t(b?.serverId);
  const viaEdge = b?.source === 'edge' || b?.source === 'remote';
  let reported = b?.source === 'edge' ? edgeScan.get(sid) : b?.source === 'remote' ? remoteScan.get(sid) : t(regById.get(sid)?.scanRangeId);
  if (b?.source === 'remote' && typeof reported !== 'string') {
    const byTag = edgeScanByTag.get(lc(b?.serviceTag));
    if (typeof byTag === 'string') reported = byTag;
  }
  const entryId = typeof reported === 'string' ? reported : '';
  const e = entryId ? scanEntries.get(entryId) : null;
  if (e) return { scan: { entryId, label: e.service }, scanWhy: undefined };
  if (entryId) return { scan: null, scanWhy: 'unknown-entry' };
  if (viaEdge && reported === null) return { scan: null, scanWhy: 'old-source' };
  if (viaEdge && reported === undefined) return { scan: null, scanWhy: 'not-reported' };
  return { scan: null, scanWhy: undefined };
}
/** 엣지 push 의 서비스 태그 → 스캔 엔트리 id(문자열만 · 같은 태그가 다른 값이면 뺀다). 순수. */
export function edgeScanByTagOf(edgeServers = []) {
  const out = new Map(); const bad = new Set();
  for (const s of edgeServers || []) {
    const tag = lc(s?.serviceTag); if (!tag || bad.has(tag) || typeof s?.scanRangeId !== 'string') continue;
    const v = t(s.scanRangeId);
    if (out.has(tag) && out.get(tag) !== v) { out.delete(tag); bad.add(tag); continue; }
    out.set(tag, v);
  }
  return out;
}

// ───────── 입력 수집(스냅샷 세대 + 태그 카테고리 + 입력 세대마다 1회) ─────────
let _gather = { key: '', rev: -1, promise: null };
let _inputRev = 0;   // 저장소 밖 입력을 다시 읽어야 할 때(입력 다시 읽기 · 이 화면의 스캔 라벨 변경) 올린다 — 응답 캐시·판정 memo 도 넘긴다
const GATHER_CHAIN_MAX_MS = 15_000;
/**
 * 단일 비행: 같은 키·같은 입력 세대면 진행 중인 수집을 함께 기다린다.
 * 입력 세대만 바뀌었으면(같은 스냅샷 — 입력 다시 읽기·라벨 변경) **진행 중인 수집이 끝난 뒤** 새로 모은다 — 예전에는 `_gather` 만 비워
 * 진행 중 수집과 새 수집이 겹쳐 두 벌 돌았다(2차 반증 4). 앞 수집이 멈춰도 뒤가 영원히 묶이지 않게 기다림에 상한을 둔다.
 */
async function gather(snap, tagCategory) {
  const key = `${snap?.generatedAt || 0}|${tagCategory}`;
  if (_gather.key === key && _gather.rev === _inputRev && _gather.promise) return _gather.promise;
  const prev = _gather.key === key ? _gather.promise : null;
  const rev = _inputRev;
  const p = (async () => {
    if (prev) {
      let tm;
      await Promise.race([prev.catch(() => {}), new Promise((r) => { tm = setTimeout(r, GATHER_CHAIN_MAX_MS); tm.unref?.(); })]);
      clearTimeout(tm);
    }
    return gatherNow(snap, tagCategory);
  })().catch((e) => { if (_gather.promise === p) _gather = { key: '', rev: -1, promise: null }; throw e; });
  _gather = { key, rev, promise: p };
  return p;
}

const _gatherStats = { runs: 0, inFlight: 0, maxInFlight: 0 };
/** 시험용 — 입력 수집이 몇 번 돌았고 동시에 몇 벌까지 겹쳤는가(2차 반증 4 회귀). */
export function _gatherStatsForTest() { return { ..._gatherStats }; }
async function gatherNow(snap, tagCategory) {
  _gatherStats.runs += 1; _gatherStats.inFlight += 1; _gatherStats.maxInFlight = Math.max(_gatherStats.maxInFlight, _gatherStats.inFlight);
  try { return await gatherNowInner(snap, tagCategory); } finally { _gatherStats.inFlight -= 1; }
}
async function gatherNowInner(snap, tagCategory) {
  const sourceErrors = [];
  const now = Date.now();
  const [{ getFleetInventory, fleetKeySources }, { loadRegistry }, { getInventory }, { allRemoteServers }, edgeUsage, { attributeBareMetalFromSnap },
    { unreadVcenterReasons }, { getEdgeFleetServers }, { listScanRanges }, pf, bareosReg, { bareosVmView }] = await Promise.all([
    import('../../insights/fleetInventory.js'), import('../../idrac/registry.js'), import('../../idrac/invCache.js'),
    import('../../collector/remoteInventory.js'), import('../../central/bmUsageEdgePull.js'), import('../../idrac/corpAttribution.js'),
    import('../../metrics/unreadVcenters.js'), import('../../central/fleet.js'), import('../../idrac/scanRanges.js'),
    Promise.all([import('../../partfault/db.js'), import('../../partfault/settings.js')]), import('../../bareos/registry.js'), import('../../bareos/vmView.js'),
  ]);
  const bareosSet = await import('../../bareos/settings.js');
  const vcenters = snap?.vcenters || [];
  const corpNames = new Map(vcenters.filter((v) => v && t(v.id)).map((v) => [t(v.id), t(v.name) || t(v.id)]));
  const unread = (() => { try { return unreadVcenterReasons(snap); } catch { return new Map(); } })();
  const unreadCorps = new Set(unread instanceof Map ? [...unread.keys()].map(t) : []);

  // ── 부품 장애(못 읽으면 null — 0 이 아니다) ──
  const [pfDb, pfSet] = pf;
  let faultsMeta = { available: false, reason: 'off' };
  let faultBy = null;
  try {
    if (!pfSet.partFaultEnabled()) faultsMeta = { available: false, reason: 'off' };
    else if (!pfDb.partFaultDbExists()) faultsMeta = { available: false, reason: 'no-db' };
    else {
      const st = await pfDb.partFaultDbStatus();
      if (!st.available) faultsMeta = { available: false, reason: 'unreadable' };
      else {
        faultBy = new Map();
        for (const f of await pfDb.openFaults()) { const k = lc(f.deviceKey); if (k) faultBy.set(k, (faultBy.get(k) || 0) + 1); }
        faultsMeta = { available: true };
      }
    }
  } catch (e) { faultsMeta = { available: false, reason: 'unreadable' }; sourceErrors.push(`부품 장애: ${String(e?.message || e).slice(0, 160)}`); }
  const faultsOf = (...keys) => {
    if (!faultBy) return null;
    for (const k of keys) { const n = faultBy.get(lc(k)); if (n) return n; }
    return 0;
  };

  // ── Bareos(VM 백업) — (vcenterId, vmId) 조인(이름 아님 — 4차 반증 11) ──
  // 법인 · vCenter · Bareos 는 1:1:1 — 백업 칸은 **그 법인에 Director 매핑(sites[].vcenterId)이 있을 때만** 센다(5차 검토 M1: 예전에는
  // 함대 어디든 잡이 하나라도 있으면 Bareos 를 안 쓰는 법인 VM 까지 '잡 없음' 으로 셌다). 매핑이 없는 법인 = undefined(해당 없음).
  let backupMeta = { used: false };
  let bareosBy = null;
  let bareosCorps = new Set();
  let bareosSettingsUnreadable = false;
  // ⚠ loadSettings 는 손상이어도 던지지 않고 빈 설정을 준다 — 손상은 settingsLoadError 로만 안다(5차 1차 반증 2: 손상이 '해당 없음' 으로 보였다).
  try {
    if (bareosSet.settingsLoadError()) throw new Error('Bareos 설정 파일을 읽지 못했습니다');
    bareosCorps = new Set((bareosSet.loadSettings().sites || []).map((s) => t(s?.vcenterId)).filter(Boolean));
  } catch (e) { bareosSettingsUnreadable = true; sourceErrors.push(`Bareos 설정: ${String(e?.message || e).slice(0, 160)}`); }
  try {
    if (bareosSettingsUnreadable) backupMeta = { used: true, unreadable: true };
    else if (bareosReg.registryLoadError()) backupMeta = bareosCorps.size ? { used: true, unreadable: true, corps: bareosCorps.size } : { used: false };
    else {
      const jobs = bareosReg.jobDigests();
      // 매핑이 지워졌어도 원장에 잡이 남은 법인은 센다(반증 10 — 옛 잡이 '해당 없음' 으로 가려지지 않게)
      for (const j of jobs) if (t(j.vcenterId)) bareosCorps.add(t(j.vcenterId));
      bareosBy = new Map(jobs.map((j) => [`${t(j.vcenterId)}|${t(j.vmId)}`, j]));
      backupMeta = bareosCorps.size ? { used: true, corps: bareosCorps.size } : { used: false };
    }
  } catch (e) { backupMeta = { used: true, unreadable: true }; sourceErrors.push(`Bareos 원장: ${String(e?.message || e).slice(0, 160)}`); }
  const backupOfVm = (vm) => {
    if (!backupMeta.used) return undefined;
    if (bareosSettingsUnreadable) return null;   // 어느 법인이 Bareos 를 쓰는지 모른다 — 모름
    if (!bareosCorps.has(t(vm.vcenterId))) return undefined;
    if (backupMeta.unreadable) return null;
    const j = bareosBy?.get(`${t(vm.vcenterId)}|${t(vm.id)}`) || null;
    return backupOf(j ? bareosVmView(j, '') : { job: false }, now);
  };

  // ── VM 구성원 ──
  const tagInvOf = new Map(vcenters.map((v) => [t(v.id), v.tagInv || null]));
  const members = [];
  for (const vm of snap?.vms || []) {
    if (!vm || vm.template) continue;
    const vc = t(vm.vcenterId);
    const { key, keyKind } = vmKeyOf(vm);
    const powered = vm.powerState === 'POWERED_ON' ? true : (vm.powerState === 'POWERED_OFF' || vm.powerState === 'SUSPENDED' ? false : null);
    let tags;
    if (tagCategory) {
      const inv = tagInvOf.get(vc);
      const ref = vmRefOf(vc, vm.id);
      const got = inv && ref ? vmTagsOf(inv, ref).tags : null;
      const mine = Array.isArray(got) ? got.filter((x) => lc(x.category) === lc(tagCategory)).map((x) => x.tag) : null;
      // 못 읽었거나(태그 null) 일부만 읽었는데 이 VM 태그가 없으면 '확인 안 됨'(미지정과 다르다)
      tags = mine == null ? null : (mine.length || !tagsPartialOf(inv) ? mine : null);
    }
    const cpu = numOrNull(vm.cpuUsagePct); const mem = numOrNull(vm.memUsagePct);
    const usage = powered === false ? { state: 'unread' }
      : unreadCorps.has(vc) ? { state: 'stale', cpuPct: null, memPct: null, src: 'vcenter' }
        : (cpu == null && mem == null) ? { state: 'unread', cpuPct: null, memPct: null, src: null }
          : { state: 'ok', cpuPct: cpu, memPct: mem, src: 'vcenter' };
    members.push({
      key, keyKind, aliasKeys: vmAliasKeys(vm, keyKind), kind: 'vm', corp: vc, name: t(vm.name), folderPath: typeof vm.folderPath === 'string' ? vm.folderPath : null, tags,
      host: t(vm.host), powered, cores: numOrNull(vm.cpuCount), memGB: numOrNull(vm.memMB) != null ? Math.round((vm.memMB / 1024) * 10) / 10 : null,
      storageGB: numOrNull(vm.storageGB), usage, backup: backupOfVm(vm), ip: t(vm.ipAddress), vmId: t(vm.id),
    });
  }

  // ── 베어메탈 구성원(통합 서버 인벤토리 분류 + 법인 귀속 규칙 — 4차 반증 2) + 사용률(법인별 사용량과 같은 판정) ──
  const fleet = await getFleetInventory(snap).catch((e) => { sourceErrors.push(`분류: ${String(e?.message || e).slice(0, 200)}`); return { bareMetal: [], virtualizationHosts: [] }; });
  const attr = attributeBareMetalFromSnap(fleet.bareMetal || [], snap);
  if (attr.error) sourceErrors.push(`법인 귀속: ${attr.error}`);
  const central = await latestUsage().catch((e) => { sourceErrors.push(`사용률 DB: ${String(e?.message || e).slice(0, 200)}`); return []; });
  const edges = (() => { try { return edgeUsage.listEdgeBmUsage(); } catch { return []; } })();
  const freshOf = (ms) => Math.max(30 * 60_000, 3 * (numOrNull(ms) || 300_000));
  const edgeRows = edges.flatMap((e) => {
    const f = freshOf(e?.snap?.settings?.intervalMs); const at = numOrNull(e?.snapAt);
    return (e?.snap?.rows || []).filter((r) => r && typeof r === 'object').map((r) => ({ ...r, ts: clampEdgeTs(r.ts, at), _freshMs: f, _agent: t(e?.agent) }));
  });
  const registry = (() => { try { return loadRegistry(); } catch { return []; } })();
  const remoteServers = (() => { try { return allRemoteServers(); } catch { return []; } })();
  const hostByName = new Map((snap?.hosts || []).map((h) => [`${t(h.vcenterId)}|${lc(h.name)}`, h]));
  const vcOwner = new Map(vcenters.filter((v) => v && (v.collectSource === 'site' || v.collectMode === 'site')).map((v) => [t(v.id), t(v.collectedBy || v.agent)]).filter(([id, a]) => id && a));
  const cu = buildCorpUsage({
    vcenters, bareMetal: attr.bareMetal || [], virtHosts: fleet.virtualizationHosts || [], rowsByKey: mergeLatestRows(central), rowsByAgentKey: rowsByAgentKeyOf(edgeRows),
    hostByKey: hostByName, capOf: makeCapOf({ getInventory, registry, remoteServers }), allowed: null, now, freshMs: freshOf(loadBmUsageSettings().intervalMs), unreadVcenters: unread, vcOwner, withServers: true,
  });
  const judged = new Map();   // `${vc}|${role}|${key or lcname}` → 서버 판정
  for (const c of cu.corps || []) for (const x of c.servers || []) judged.set(x.role === 'bm' ? `${c.vcenterId}|bm|${x.key}` : `${c.vcenterId}|virt|${lc(x.name)}`, x);
  for (const x of cu.unassigned?.servers || []) judged.set(`|bm|${x.key}`, x);
  const regById = new Map(registry.map((r) => [t(r.id), r]));
  // 스캔 엔트리 id — 엣지 push(serverId) · 수집 서버 pull(remote:<수집기>:<엣지 서버 id>). 값 null = 보고한 쪽이 구버전(필드 없음 — 5차 R6·R18).
  const edgeServers = (() => { try { return getEdgeFleetServers() || []; } catch { return []; } })();
  const edgeScan = new Map(edgeServers.map((s) => [t(s.serverId), typeof s.scanRangeId === 'string' ? t(s.scanRangeId) : null]));
  const remoteScan = new Map(remoteServers.map((s) => [`remote:${t(s.collectorId)}:${t(s.id)}`, typeof s.scanRangeId === 'string' ? t(s.scanRangeId) : null]));
  const edgeScanByTag = edgeScanByTagOf(edgeServers);
  const entries = (() => { try { return listScanRanges(); } catch (e) { sourceErrors.push(`스캔 대역: ${String(e?.message || e).slice(0, 160)}`); return []; } })();
  const scanEntries = new Map(entries.map((e) => [t(e.id), { service: t(e.service), datacenterId: t(e.datacenterId), range: (e.ranges || []).slice(0, 4).join(', ') }]));
  const isAddr = addressMatcher(registry.map((r) => r.host).filter(Boolean));
  const seenBm = new Set();
  for (const b of attr.bareMetal || []) {
    if (!b || typeof b !== 'object') continue;
    const vc = t(b.vcenterId);
    const { key, keyKind } = bmKeyOf(b);
    if (seenBm.has(key)) continue;   // 같은 박스를 두 번 세지 않는다(분류가 이미 dedup — 방어선)
    seenBm.add(key);
    const id = idOf(b);
    const x = judged.get(`${vc}|bm|${id.key}`) || null;
    const sid = t(b.serverId);
    const { scan, scanWhy } = scanInfoOf(b, { edgeScan, remoteScan, regById, scanEntries, edgeScanByTag });
    // 법인 귀속이 없는 이유(5차 R18 둘째 절): 귀속 판정 자체가 실패 · 같은 서비스 태그가 두 법인에 걸려 보류 · 어느 규칙에도 맞지 않음
    const corpWhy = vc ? undefined : attr.error ? 'attr-error' : attr.conflictTags?.has(lc(b.serviceTag)) ? 'tag-conflict' : undefined;
    let powered = null;
    try { const inv = b.source === 'edge' ? null : getInventory(sid); const ps = lc(inv?.powerState); powered = ps === 'on' ? true : ps === 'off' ? false : null; } catch { powered = null; }
    members.push({
      key, keyKind, aliasKeys: bmAliasKeys(b, keyKind), kind: 'bm', corp: vc, name: t(b.name), nameIsAddr: isAddr(t(b.name)), serviceTag: t(b.serviceTag), source: t(b.source), remoteAgent: t(b.remoteAgent),
      scan, ...(scanWhy ? { scanWhy } : {}), ...(corpWhy ? { corpWhy } : {}), powered, cores: x?.cores ?? null, memGB: x?.memGB ?? null,
      usage: x ? { state: x.state, cpuPct: x.cpuPct, memPct: x.memPct, src: x.src } : { state: 'unread' },
      faults: faultsOf(b.serviceTag, sid), corpRule: b.vcSource === 'corp-rule',
    });
  }
  // ── 파생 호스트(구성원이 아니다): 가상화 호스트의 사용률·장애 ──
  const hostByKey = new Map();
  for (const h of fleet.virtualizationHosts || []) {
    const vc = t(h.vcenterId); if (!vc) continue;
    const x = judged.get(`${vc}|virt|${lc(h.name)}`) || null;
    hostByKey.set(hostKeyOf(vc, h.name), { name: t(h.name), corp: vc, serviceTag: t(h.serviceTag), usage: x ? { state: x.state, cpuPct: x.cpuPct, memPct: x.memPct } : null, faults: faultsOf(h.serviceTag), connectionState: t(h.connectionState) });
  }
  let bmBlocked = false; let bmBlockedSources = [];
  try {
    const fk = fleetKeySources(snap);
    bmBlockedSources = (fk.unreadable || []).filter((u) => u.source !== 'vcenter').slice(0, 20).map((u) => ({ source: t(u.source), reason: t(u.reason).slice(0, 200) }));
    bmBlocked = bmBlockedSources.length > 0;
  } catch (e) { bmBlocked = true; bmBlockedSources = [{ source: 'fleet-keys', reason: `베어메탈 출처 목록을 만들지 못했습니다(${String(e?.message || e).slice(0, 120)})` }]; }
  // VM 식별 키(instanceUuid)를 못 읽는 법인 — VM 이 있는데 instanceUuid 가 하나도 없다(REST 폴백 수집 등). 그 법인의 iu: 고정은 유령이 아니라 판정 보류(4차 반증 5).
  const vmTotal = new Map(); const vmUuid = new Map();
  for (const vm of snap?.vms || []) { if (!vm || vm.template) continue; const vc = t(vm.vcenterId); vmTotal.set(vc, (vmTotal.get(vc) || 0) + 1); if (t(vm.instanceUuid)) vmUuid.set(vc, (vmUuid.get(vc) || 0) + 1); }
  const uuidUnreadCorps = new Set([...vmTotal.keys()].filter((vc) => !vmUuid.get(vc)));
  // 첫 수집 전(pending)·꺼진(disabled) vCenter — 그 법인 구성원이 '없다' 가 아니라 '아직 모른다'(6차 1 — unreadVcenters 는 pending 을 일부러 뺀다).
  // 수집 전 골격 스냅샷(initial)이면 어느 법인 구성원도 모른다.
  const corpHold = new Map();
  for (const v of vcenters) { const id = t(v?.id); if (!id) continue; if (v.status === 'pending') corpHold.set(id, 'corp-pending'); else if (v.status === 'disabled') corpHold.set(id, 'corp-disabled'); }
  const snapInitial = !snap || snap.initial === true;
  return { members, hostByKey, unreadCorps, bmBlocked, bmBlockedSources, uuidUnreadCorps, corpHold, snapInitial, corpNames, scanEntries, faultsMeta, backupMeta, bareosCorps, sourceErrors, at: now };
}

// ───────── 권한 ─────────
/** 법인 쓰기 — 알 수 없는 법인 404 · 조회 밖 404 · 쓰기 밖 403. 순수에 가깝다(스냅샷만 읽는다). */
export function corpWriteAccess(user, snap, corp) {
  const vc = t(corp);
  if (!vc || !(snap?.vcenters || []).some((v) => t(v.id) === vc)) return { status: 404, reason: '법인(vCenter)을 찾지 못했습니다.' };
  if (!inUserScope(user, snap, vc)) return { status: 404, reason: '법인(vCenter)을 찾지 못했습니다.' };
  if (!inUserWriteScope(user, snap, vc)) return { status: 403, reason: '이 법인은 조회 전용입니다(쓰기 범위 밖).' };
  return null;
}
const writerOk = (user) => ['admin', 'operator'].includes(user?.role) && !isDemoGuest(user);
function writeKeyOf(user, snap) {
  if (!writerOk(user)) return 'none';
  const w = writeScopedVcenterIds(user, snap);
  return w ? [...w].sort().join(',') : 'all';
}
// 등록 해제된 vCenter(스냅샷에 없음)는 쓰기 연산이 전부 404 라 버튼을 열지 않는다(5차 반증 R2 — 예전에는 writable:true 로 버튼이 열렸다).
const inSnap = (snap, vc) => (snap?.vcenters || []).some((v) => t(v.id) === t(vc));
const writableOf = (user, snap, vc) => writerOk(user) && inSnap(snap, vc) && inUserWriteScope(user, snap, vc);
/** vCenter 등록부(vcenters.json)의 id — 못 읽었거나 비었으면 null(모른다). 비밀은 쓰지 않고 id 만 본다. */
function registryIds() {
  try { const l = (loadVcenterConfig().vcenters || []).map((v) => t(v?.id)).filter(Boolean); return l.length ? new Set(l) : null; } catch { return null; }
}
/**
 * '알려진 법인' = 스냅샷 vCenter ∪ 등록부 vCenter. 둘 중 하나라도 비었거나 못 읽었으면 null — 그때는 어느 법인도 '등록 해제' 로 보지 않는다.
 * ⚠ 스냅샷만 보면 안 된다(5차 1차 반증 1 — 재현): 등록 직후 스냅샷이 갱신되기 전(수 초~수십 초)과 mock 데이터 소스(등록부를 무시)에서
 *   등록된 vCenter 가 '등록 해제' 로 보이고 법인 항목 정리가 그 법인 서비스·규칙을 지웠다.
 */
function knownCorpsOf(snap) {
  const s = (snap?.vcenters || []).map((v) => t(v?.id)).filter(Boolean);
  const reg = registryIds();
  if (!s.length || !reg) return null;
  return new Set([...s, ...reg]);
}
const fleetAdmin = (user, snap) => isAdminDetailUser(user) && !scopedVcenterIds(user, snap);   // 관리자 판본 판정은 isAdminDetailUser 하나(role 직접 비교 금지)

// ───────── 응답 조립 ─────────
// 읽기 경로는 동결 참조(복사 없음 — 5차 검토 R5: 요청마다 고정 5만 건 깊은 복사 114ms). 쓰기는 mutate* 만.
function loadState() {
  return { map: peekMap(), pins: peekPins(), rev: storeRev(), err: storeLoadError() };
}
/**
 * 판정·집계 결과 memo(5차 검토 M10/R5 — 실측: 6,500 구성원 buildInventory 중앙값 77ms 를 구성원·큐·후보·CSV 요청마다 되풀이했고,
 * 쓰기 한 번에 화면이 3요청을 보냈다). 키 = 스냅샷 세대 · 저장소 rev · 입력 세대(gather 시각 · inputRev) · 알려진 법인 · 범위 · 관리자 판본.
 * '세대가 바뀌면 무엇이 지워지는가': 키의 어느 값이 바뀌어도 새 키다 — 쓰기(rev) · 새 스냅샷 · 입력 다시 읽기 · 라벨 변경 · vCenter 등록부 변경.
 * TTL 12초 · 최대 4개(범위가 다른 계정 몇 명). 결과는 동결 참조를 품으므로 호출부는 고치지 않는다.
 */
const INV_MEMO_MS = 12_000;
const INV_MEMO_MAX = 4;
const _invMemo = new Map();
const _invStats = { hits: 0, misses: 0 };
export function _invMemoStats() { return { ..._invStats, size: _invMemo.size }; }
async function inventoryFor(req, snap) {
  const st = loadState();
  const g = await gather(snap, st.map.settings.tagCategory || '');
  const allowed = scopedVcenterIds(req.user, snap);
  const admin = isAdminDetailUser(req.user);
  const known = knownCorpsOf(snap);
  const key = [snap?.generatedAt || 0, st.rev, g.at, _inputRev, known ? [...known].sort().join(',') : '-', allowed ? [...allowed].sort().join(',') : '*', admin ? 'a' : 'u'].join('|');
  const now = Date.now();
  const hit = _invMemo.get(key);
  if (hit && now - hit.at < INV_MEMO_MS) { _invStats.hits += 1; return { st, g, inv: hit.inv, allowed, admin }; }
  _invStats.misses += 1;
  const inv = buildInventory({ members: g.members, map: st.map, pins: st.pins, hostByKey: g.hostByKey, allowed, unreadCorps: g.unreadCorps, bmBlocked: g.bmBlocked, uuidUnreadCorps: g.uuidUnreadCorps, corpHold: g.corpHold, snapInitial: g.snapInitial, corpNames: g.corpNames, scanEntries: g.scanEntries, adminView: admin, knownCorps: known });
  for (const [k, v] of _invMemo) if (now - v.at >= INV_MEMO_MS) _invMemo.delete(k);
  while (_invMemo.size >= INV_MEMO_MAX) _invMemo.delete(_invMemo.keys().next().value);
  _invMemo.set(key, { at: now, inv });
  return { st, g, inv, allowed, admin };
}

/**
 * '입력 다시 읽기'(5차 검토 M2 · 결정 ② 쓰기 계정) — 입력 수집(gather)은 스냅샷 세대마다 한 번이라, 이 화면 밖에서 바뀐 입력
 * (등록부 법인 귀속 · iDRAC 화면의 스캔 라벨 · 부품 장애 · Bareos 원장)은 다음 수집 주기까지 옛값이었다. 쓰기 계정이 지금 다시 읽게 한다.
 * 28법인 조인 비용 보호로 프로세스당 FRESH_MIN_MS 에 한 번(화면은 meta.limits 의 값으로 안내 — 숫자를 박지 않는다).
 */
const FRESH_MIN_MS = 30_000;
let _lastFresh = 0;
export function _resetFreshForTest() { _lastFresh = 0; }
function forceFresh(now = Date.now()) {
  if (now - _lastFresh < FRESH_MIN_MS) return { ok: false, waitSec: Math.ceil((FRESH_MIN_MS - (now - _lastFresh)) / 1000), agoSec: Math.max(0, Math.floor((now - _lastFresh) / 1000)) };
  _lastFresh = now;
  _inputRev += 1;   // 진행 중 수집은 비우지 않는다 — gather 가 그 뒤에 잇는다(2차 반증 4)
  return { ok: true };
}
/** 백업 메타를 범위로 자른다 — 범위 계정에 함대 전체의 Bareos 매핑 법인 수를 싣지 않는다(5차 1차 Chromium 확인). */
export function backupMetaFor(g, allowed) {
  const m = g.backupMeta || { used: false };
  if (!allowed || !m.used || m.corps == null) return m;
  const n = [...(g.bareosCorps || [])].filter((vc) => allowed.has(vc)).length;
  return n ? { ...m, corps: n } : { used: false };
}
/**
 * 판정 보류 시작 시각(5차 R10 — '보류에는 시한'). 저장하지 않는다 — 이 프로세스가 처음 보류로 본 시각이고 재시작하면 다시 센다(화면이 그렇게 밝힌다).
 * 지우지는 않는다(보류는 지우지 않는 것이 목적) — 오래 보류된 것을 사람이 보고 원인(못 읽는 법인·출처)을 고치게 한다.
 * 정리는 전체 범위 계산에서만 한다(범위 계정 계산은 일부만 보므로 남의 기록을 지우지 않게) · 상한으로 메모리를 묶는다.
 */
const HELD_SINCE_MAX = 50_000;
const _heldSince = new Map();
export function _resetHeldSinceForTest() { _heldSince.clear(); }
export function heldWithSince(list, full, now = Date.now()) {
  const seen = new Set();
  const out = (list || []).map((x) => {
    seen.add(x.key);
    if (!_heldSince.has(x.key)) {
      if (_heldSince.size >= HELD_SINCE_MAX) _heldSince.delete(_heldSince.keys().next().value);   // 가장 오래 넣은 것부터 버린다(새 보류가 null 이 되지 않게 — 3차 반증 6)
      _heldSince.set(x.key, now);
    }
    return { ...x, heldSince: _heldSince.get(x.key) ?? null };
  });
  if (full) for (const k of [..._heldSince.keys()]) if (!seen.has(k)) _heldSince.delete(k);
  return out;
}
/**
 * 5차 R7 · 결정 ⑤ — **범위가 지정된 계정 판본은 베어메탈 서비스태그를 싣지 않는다**(통합 서버 인벤토리 `/insights/fleet` 이 범위 계정에 403 인 것과 같은 기준).
 * 서비스태그는 키(`st:<태그>`)에도 들어 있으므로 베어메탈 키(st:·fl:)는 **프로세스 HMAC 토큰**(`auth/addressMask.js maskedIdToken`)으로 바꿔 싣는다
 * (`fl:` 은 fleetId sha1 이라 주소 공간을 전수하면 되돌릴 수 있다). 토큰은 재시작하면 바뀐다 — 화면은 매번 새로 받아 쓴다.
 * 쓰기 연산은 토큰을 원래 키로 되돌린다(`keyResolverFor`) — 범위 계정이 **원문 베어메탈 키를 보내면 받지 않는다**(태그를 맞혀 보는 길을 막는다).
 * VM 키(iu:·vm:)는 그대로다(instanceUuid·moref 는 서비스태그 기준 밖).
 */
const GHOST_SHOW = 500;          // 검토 화면에 싣는 유령·보류 행 상한(6차 8)
const GHOST_PRUNE_MAX = 5000;    // 유령 정리 한 번에 받는·미리 보여 주는 키 상한
const isBmKey = (k) => typeof k === 'string' && (k.startsWith('st:') || k.startsWith('fl:'));
export const pubKey = (k, hide) => (hide && isBmKey(k) ? maskedIdToken(k) : k);
/** 범위 계정이 보낸 키 → 원래 키(모르면 ''). 후보는 그 계정 범위 안 구성원·고정 키만. */
export function keyResolverFor(hide, candidates = []) {
  if (!hide) return (k) => k;
  let byToken = null;
  return (k) => {
    if (typeof k !== 'string' || !k) return '';
    if (k.startsWith(MASK_TOKEN_PREFIX)) {
      if (!byToken) { byToken = new Map(); for (const c of candidates) if (isBmKey(c)) byToken.set(maskedIdToken(c), c); }
      return byToken.get(k) || '';
    }
    return isBmKey(k) ? '' : k;
  };
}
const maskName = (m, admin, hide = false) => {
  if (!admin && m.kind === 'bm' && m.nameIsAddr) return maskedAddressName(m.name);
  // 이름이 곧 서비스태그인 베어메탈(호스트 이름 없이 등록) — 범위 계정 판본에서는 이름도 가린다(R7)
  if (hide && m.kind === 'bm' && m.serviceTag && lc(m.name) === lc(m.serviceTag)) return `서버 ${pubKey(m.key, true).slice(-6)}`;
  // 이름에 태그가 들어 있으면(iDRAC 기본 이름 'idrac-<태그>' 등) 그 부분만 가린다(4차 반증 3). 정규식 없이 선형으로(외부 입력).
  if (hide && m.kind === 'bm' && t(m.serviceTag).length >= 4) return stripTag(m.name, m.serviceTag);
  return m.name;
};

/** 이름에서 태그(대소문자 무시)를 '•••' 로 바꾼다 — 길이를 먼저 자르고 indexOf 로(외부 입력에 정규식 금지). */
export function stripTag(name, tag) {
  const n = String(name ?? '').slice(0, 256); const tg = lc(tag);
  if (!tg) return n;
  const low = n.toLowerCase(); let out = ''; let i = 0;
  for (let j = low.indexOf(tg); j >= 0; j = low.indexOf(tg, i)) { out += `${n.slice(i, j)}•••`; i = j + tg.length; }
  return out + n.slice(i);
}

function memberRow(m, r, admin, hide = false) {
  return {
    key: pubKey(m.key, hide), keyKind: m.keyKind, kind: m.kind, corp: m.corp, name: maskName(m, admin, hide), serviceId: r.serviceId, src: r.src, via: r.src === 'folder' || r.src === 'scan' || r.src === 'tag' || r.src === 'rule' ? r.via : '',
    reason: r.reason || '', drift: !!r.drift, unchecked: !!r.unchecked, pinMismatch: r.pinMismatch ? true : undefined,
    autoServiceId: r.src === 'pin' ? (r.auto?.serviceId || null) : undefined,
    powered: m.powered, cores: m.cores, memGB: m.memGB, storageGB: m.kind === 'vm' ? m.storageGB : undefined,
    usage: m.usage ? { state: m.usage.state, cpu: m.usage.cpuPct ?? null, mem: m.usage.memPct ?? null, src: m.usage.src || null } : null,
    faults: m.faults, backup: m.backup, host: m.host || '', ip: m.kind === 'vm' ? m.ip : '', folderPath: m.kind === 'vm' ? m.folderPath : undefined,
    serviceTag: m.kind === 'bm' && !hide ? m.serviceTag : undefined, source: m.kind === 'bm' ? m.source : undefined, scanEntry: m.scan ? m.scan.entryId : undefined,
    // 태그 여럿(5차 M5·R14) — 태그로 정해진 구성원만. 값은 소문자 정렬 순 최대 8개 · 둘 이상의 서비스에 걸리면 tagAmbiguous
    tagValues: r.src === 'tag' && r.multi ? r.tagValues : undefined, tagAmbiguous: r.src === 'tag' && r.tagAmbiguous ? true : undefined,
    ruleOverlap: r.src === 'rule' && r.ruleOverlap ? r.ruleOverlap : undefined,
  };
}

export function registerSvcInventory(api) {
  // ── 메인: 트리·서비스별 집계·전역 축·큐 개수 ──
  api.get('/tools/svc-inventory', toolsPerm, async (req, res) => {
    const snap = store.get();
    if (req.query.fresh === '1') {
      if (!writerOk(req.user)) return res.status(403).json({ ok: false, error: 'forbidden', reason: '입력 다시 읽기는 쓰기 계정(관리자·운영자)만 쓸 수 있습니다.' });
      const f = forceFresh();
      // 상한은 포탈 전체에 하나다 — 다른 사용자가 방금 읽었을 수 있고, 그 입력은 일반 새로고침으로 이미 받을 수 있다(2차 반증 3)
      if (!f.ok) return res.status(429).json({ ok: false, error: 'tooSoon', reason: `입력은 ${f.agoSec}초 전에 이미 다시 읽었습니다(다른 사용자일 수 있습니다) — 새로고침하면 그 입력이 보입니다. ${f.waitSec}초 뒤에 다시 읽을 수 있습니다.`, waitSec: f.waitSec, agoSec: f.agoSec });
    }
    const err = storeLoadError();
    if (err) return res.status(503).json({ ok: false, error: 'registryUnreadable', reason: `서비스 인벤토리 저장소를 읽지 못했습니다 — ${err.map || err.pins}. 빈 트리로 시작하지 않습니다(백업 복원 또는 전체 범위 관리자의 초기화).`, corrupt: err, canReset: fleetAdmin(req.user, snap) });
    const extraKey = `${scopeKey(req.user, snap)}|w${writeKeyOf(req.user, snap)}|${isAdminDetailUser(req.user) ? 'a' : 'u'}|r${storeRev()}|i${_inputRev}`;
    await memoJson(req, res, 'svc-inventory', async (s) => {
      const { st, g, inv, allowed } = await inventoryFor(req, s);
      const q = inv.queues;
      return {
        ok: true, at: g.at, rev: st.rev, scoped: !!allowed,
        settings: { tagCategory: st.map.settings.tagCategory || '' },
        canFleet: fleetAdmin(req.user, s), canWrite: writerOk(req.user),
        corps: inv.corps.map((c) => ({ ...c, writable: writableOf(req.user, s, c.vcenterId) })),
        services: inv.services, noCorp: inv.noCorp,
        global: inv.global,
        queues: { unassigned: q.unassigned.reduce((a, x) => a + x.n, 0), unassignedGroups: q.unassigned.length, unmapped: q.unmapped.length, drift: q.drift.length, mismatch: new Set(q.mismatch.map((x) => x.key)).size, redundant: q.redundant.length, ghosts: q.ghosts.length, ghostsHeld: q.ghostsHeld.length, orphaned: q.orphaned.length, tagAmbiguous: q.tagAmbiguous.length, ruleOverlap: q.ruleOverlap.length, aliasPins: q.aliasPins.length },
        // 법인을 고른 화면의 탭 숫자가 KPI 와 같은 기준이 되도록 법인별로도 센다(전 법인 숫자를 법인 화면에 쓰지 않는다).
        queuesByCorp: (() => {
          const o = {};
          const bump = (c, k, n = 1) => { const id = c || ''; (o[id] ||= { unassigned: 0, unmapped: 0, drift: 0, ghosts: 0, ghostsHeld: 0, mismatch: 0, redundant: 0, orphaned: 0, tagAmbiguous: 0, ruleOverlap: 0, aliasPins: 0 })[k] += n; };
          for (const x of q.unassigned) bump(x.corp, 'unassigned', x.n);
          for (const x of q.unmapped) bump(x.corp, 'unmapped');
          for (const x of q.drift) bump(x.corp, 'drift');
          for (const x of q.ghosts) bump(x.corp, 'ghosts');
          for (const x of q.ghostsHeld) bump(x.corp, 'ghostsHeld');
          // 구성원 수로 센다 — 한 구성원이 새 키·옛 키 불일치를 함께 가지면 행이 둘이다(6차 반증 2회차 R1)
          { const seen = new Set(); for (const x of q.mismatch) { if (seen.has(x.key)) continue; seen.add(x.key); bump(x.corp, 'mismatch'); } }
          for (const x of q.redundant) bump(x.corp, 'redundant');
          for (const x of q.tagAmbiguous) bump(x.corp, 'tagAmbiguous');
          for (const x of q.ruleOverlap) bump(x.corp, 'ruleOverlap');
          for (const x of q.aliasPins) bump(x.corp, 'aliasPins');
          for (const x of q.orphaned) bump(x.corp, 'orphaned');
          return o;
        })(),
        meta: { faults: g.faultsMeta, backup: backupMetaFor(g, allowed), unreadCorps: [...g.unreadCorps].filter((v) => !allowed || allowed.has(v)), bmBlocked: g.bmBlocked, sourceErrors: allowed ? [] : g.sourceErrors, limits: { ...LIMITS, freshMinMs: FRESH_MIN_MS }, snapAt: s?.generatedAt || null, inputsAt: g.at },
      };
    }, { ttlMs: 12_000, extraKey });
  });

  // ── 구성원 + 파생 호스트 ──
  api.get('/tools/svc-inventory/members', toolsPerm, async (req, res) => {
    try {
      const snap = store.get();
      if (storeLoadError()) return res.status(503).json({ ok: false, error: 'registryUnreadable' });
      const { g, inv, allowed, admin, st } = await inventoryFor(req, snap);
      const corp = t(req.query.corp); const svc = t(req.query.service); const gid = t(req.query.global); const unassigned = req.query.unassigned === '1';
      // 법인 귀속이 없는 미지정 구성원만(6차 6 — 예전에는 corp='' 가 '조건 없음' 으로 읽혀 전 법인 미지정이 나왔다). 범위 계정에는 싣지 않는다.
      const nocorp = req.query.nocorp === '1';
      if (corp && allowed && !allowed.has(corp)) return res.status(404).json({ ok: false, reason: '법인(vCenter)을 찾지 못했습니다.' });
      const svcCorp = svc ? inv.services.find((s) => s.id === svc)?.corp : null;
      if (svc && !svcCorp) return res.status(404).json({ ok: false, reason: '서비스를 찾지 못했습니다.' });
      const gSvc = gid ? new Set(inv.services.filter((s) => s.globalId === gid).map((s) => s.id)) : null;
      const pick = (m) => {
        if (allowed && !allowed.has(m.corp)) return false;
        if (nocorp) return !m.corp && !inv.resolved.get(m.key)?.serviceId;
        if (corp && m.corp !== corp) return false;
        const r = inv.resolved.get(m.key);
        if (svc) return r.serviceId === svc;
        if (gSvc) return !!r.serviceId && gSvc.has(r.serviceId);
        if (unassigned) return !r.serviceId;
        return !!corp;   // 법인만 주면 그 법인 전부 — 아무 조건도 없으면 빈 목록(전 함대를 한 번에 내리지 않는다)
      };
      const list = g.members.filter(pick);
      const CAP = 5000;
      const rows = list.slice(0, CAP).map((m) => memberRow(m, inv.resolved.get(m.key), admin, !!allowed));
      // 영향 호스트 — 호스트별 VM 을 한 번만 묶는다(전 법인 보기에서 호스트 수 × 구성원 수로 돌지 않게).
      const hostOf = (m) => hostKeyOf(m.corp, m.host);
      const listByHost = new Map();
      for (const m of list) if (m.kind === 'vm' && m.host) { const hk = hostOf(m); listByHost.set(hk, (listByHost.get(hk) || 0) + 1); }
      const onHostBy = new Map();
      for (const m of g.members) {
        if (m.kind !== 'vm' || !m.host) continue;
        const hk = hostOf(m); if (!listByHost.has(hk)) continue;
        if (!onHostBy.has(hk)) onHostBy.set(hk, []);
        onHostBy.get(hk).push(m);
      }
      const nameOfSvc = new Map(inv.services.map((s) => [s.id, s.name]));
      // '함께 떠받치는 서비스' 는 **다른** 서비스다 — 전역 서비스로 볼 때 자기 법인 서비스 id 도 뺀다(예전에는 svc 만 빼서 NTP 호스트에 NTP 가 떴다).
      const self = new Set([svc, ...(gSvc || [])].filter(Boolean));
      const hosts = [...listByHost.keys()].map((hk) => {
        const h = g.hostByKey.get(hk) || { name: hk.slice(hk.indexOf('|') + 1), corp: hk.slice(0, hk.indexOf('|')), usage: null, faults: null };
        const onHost = onHostBy.get(hk) || [];
        const mine = listByHost.get(hk) || 0;
        const others = [...new Set(onHost.map((m) => inv.resolved.get(m.key)?.serviceId).filter((id) => id && !self.has(id)).map((id) => nameOfSvc.get(id) || id))].slice(0, 20);
        const unassignedOn = onHost.filter((m) => !inv.resolved.get(m.key)?.serviceId).length;
        return { name: h.name, corp: h.corp, serviceTag: allowed ? '' : (h.serviceTag || ''), usage: h.usage, faults: h.faults, vmHere: mine, others, unassignedOn };
      }).sort((a, b) => b.vmHere - a.vmHere || a.name.localeCompare(b.name));
      res.json({ ok: true, rev: st.rev, members: rows, omitted: Math.max(0, list.length - CAP), hosts, faults: g.faultsMeta, backup: backupMetaFor(g, allowed) });
    } catch (e) { if (!res.headersSent) res.status(500).json({ ok: false, reason: String(e?.message || e).slice(0, 300) }); }
  });

  // ── 운영 큐: 미지정 묶음 · 매핑 안 된 값 · 드리프트 · 법인 불일치 · 유령(판정 보류 포함) ──
  api.get('/tools/svc-inventory/queues', toolsPerm, async (req, res) => {
    try {
      const snap = store.get();
      if (storeLoadError()) return res.status(503).json({ ok: false, error: 'registryUnreadable' });
      const { inv, allowed, admin, st, g } = await inventoryFor(req, snap);
      const corp = t(req.query.corp);
      if (corp && allowed && !allowed.has(corp)) return res.status(404).json({ ok: false, reason: '법인(vCenter)을 찾지 못했습니다.' });
      const q = inv.queues;
      // nocorp=1 — 트리 '(법인 미지정)': 법인 귀속 없는 항목만(6차 6). 범위 계정 큐에는 원래 법인 없는 항목이 없다(buildQueues inScope).
      const nocorp = req.query.nocorp === '1';
      const inCorp = (x) => (nocorp ? !x.corp : !corp || x.corp === corp);
      const byKey = new Map(g.members.map((m) => [m.key, m]));
      const hide = !!allowed;   // R7 — 범위 계정 판본은 베어메탈 키를 토큰으로
      const mask = (list) => list.map((x) => ({ ...x, key: pubKey(x.key, hide), name: byKey.get(x.key) ? maskName(byKey.get(x.key), admin, hide) : x.name }));
      const maskKeyOnly = (list) => list.map((x) => ({ ...x, key: pubKey(x.key, hide) }));
      res.json({
        ok: true, rev: st.rev,
        unassigned: q.unassigned.filter(inCorp).map((x) => ({ ...x, names: mask(x.names), keys: x.keys.map((k) => pubKey(k, hide)) })),
        unmapped: q.unmapped.filter(inCorp), drift: mask(q.drift.filter(inCorp)),
        // 고정이 가리키는 법인이 이 계정 범위 밖이면 그 법인 id·서비스 id 를 싣지 않는다(6차 5 — '어딘가 다른 법인에 고정돼 있다' 만)
        // 옛 키(별칭) 불일치 행의 aliasKey 도 베어메탈이면 토큰으로(R7 — fl:·st: 원문을 범위 계정에 싣지 않는다)
        mismatch: mask(q.mismatch.filter(inCorp)).map((x) => ({ ...x, ...(x.aliasKey ? { aliasKey: pubKey(x.aliasKey, hide) } : {}) }))
          .map((x) => (allowed && !allowed.has(x.pinCorp) ? { ...x, pinCorp: '', serviceId: '', pinCorpHidden: true } : x)),
        // 불필요한 고정 — 고른 법인 것만(5차 반증 R9: 예전에는 법인을 골라도 전 범위 합계였다) · 정리 버튼이 키를 쓰므로 500건까지 싣는다.
        redundant: (() => { const l = q.redundant.filter(inCorp); return { n: l.length, items: mask(l.slice(0, LIMITS.pinBatch)) }; })(),
        tagAmbiguous: (() => { const l = q.tagAmbiguous.filter(inCorp); return { n: l.length, items: mask(l.slice(0, 200)) }; })(),
        ruleOverlap: (() => { const l = q.ruleOverlap.filter(inCorp); return { n: l.length, items: mask(l.slice(0, 200)) }; })(),
        // 옛 키로 저장된 고정(R15) — 옛 키(aliasKey)도 베어메탈이면 토큰으로
        aliasPins: (() => { const l = q.aliasPins.filter(inCorp); return { n: l.length, corps: [...new Set(l.map((x) => x.corp))], items: mask(l.slice(0, 200)).map((x) => ({ ...x, aliasKey: pubKey(x.aliasKey, hide) })) }; })(),
        // 판정 보류(5차 R10): 언제부터(이 포탈 프로세스가 처음 본 시각 — 재시작하면 다시 센다) · 무엇이 막혔는지. 출처 문구는 관리자 판본만(장비·수집 서버 이름).
        // 유령·보류는 앞 GHOST_SHOW 건만 싣고 전체 개수·법인별 개수를 따로 준다(6차 8 — 실측: 상한 없이 고정 5만 건이면 응답 4.8MB). 정리 버튼은 법인별 개수로 연다.
        ...(() => {
          const gl = q.ghosts.filter(inCorp); const hl = heldWithSince(q.ghostsHeld, !allowed).filter(inCorp);
          const byCorp = {}; for (const x of gl) byCorp[x.corp] = (byCorp[x.corp] || 0) + 1;
          return { ghosts: maskKeyOnly(gl.slice(0, GHOST_SHOW)), ghostsN: gl.length, ghostsByCorp: byCorp, ghostsHeld: maskKeyOnly(hl.slice(0, GHOST_SHOW)), ghostsHeldN: hl.length };
        })(),
        orphaned: q.orphaned.filter(inCorp).length, bmBlocked: g.bmBlocked,
        // 문구(장비·수집 서버 이름)는 **전체 범위** 관리자만 — 범위가 지정된 관리자에게 다른 법인 출처 이름을 싣지 않는다(3차 반증 2 · sourceErrors 와 같은 기준)
        bmBlockedSources: g.bmBlocked ? (g.bmBlockedSources || []).map((u) => (admin && !allowed ? u : { source: u.source })) : [],
      });
    } catch (e) { if (!res.headersSent) res.status(500).json({ ok: false, reason: String(e?.message || e).slice(0, 300) }); }
  });

  // ── 한 대씩 고정 후보 ──
  api.get('/tools/svc-inventory/candidates', toolsPerm, async (req, res) => {
    try {
      const snap = store.get();
      // 손상 저장소면 빈 트리 기준(전부 '미소속')으로 답하지 않는다(5차 검토 M6 — members·queues 와 같은 규칙).
      if (storeLoadError()) return res.status(503).json({ ok: false, error: 'registryUnreadable', reason: '서비스 인벤토리 저장소를 읽지 못했습니다.' });
      const { g, inv, allowed, admin } = await inventoryFor(req, snap);
      const kind = req.query.kind === 'vm' ? 'vm' : 'bm';
      const corp = t(req.query.corp); const qq = lc(req.query.q).slice(0, 64); const onlyUn = req.query.unassignedOnly !== '0';
      const hide = !!allowed;   // R7 — 범위 계정은 서비스태그로 찾지 않는다(찾기가 태그를 맞혀 보는 길이 되지 않게)
      if (corp && allowed && !allowed.has(corp)) return res.status(404).json({ ok: false, reason: '법인(vCenter)을 찾지 못했습니다.' });
      const list = g.members.filter((m) => m.kind === kind && m.corp && (!allowed || allowed.has(m.corp)) && (!corp || m.corp === corp)
        && (!onlyUn || !inv.resolved.get(m.key)?.serviceId)
        && (!qq || lc(maskName(m, admin, hide)).includes(qq) || (!hide && lc(m.serviceTag).includes(qq)) || lc(m.folderPath).includes(qq) || lc(m.ip).includes(qq)));
      const CAP = 2000;
      res.json({ ok: true, items: list.slice(0, CAP).map((m) => ({ key: pubKey(m.key, hide), name: maskName(m, admin, hide), kind: m.kind, corp: m.corp, serviceTag: hide ? '' : (m.serviceTag || ''), folderPath: m.folderPath ?? null, source: m.source || '', scanEntry: m.scan?.entryId || '', serviceId: inv.resolved.get(m.key)?.serviceId || null, src: inv.resolved.get(m.key)?.src || 'none' })), omitted: Math.max(0, list.length - CAP) });
    } catch (e) { if (!res.headersSent) res.status(500).json({ ok: false, reason: String(e?.message || e).slice(0, 300) }); }
  });

  // ── CSV(범위 안 구성원 전부) ──
  api.get('/tools/svc-inventory.csv', toolsPerm, csvPerm, async (req, res) => {
    if (storeLoadError()) return res.status(503).json({ ok: false, error: 'registryUnreadable', reason: '서비스 인벤토리 저장소를 읽지 못해 내보내지 않았습니다(빈 트리 기준 파일을 만들지 않습니다).' });
    const lock = acquireExport('svc-inventory-csv', req);
    if (!lock.ok) return res.status(lock.status).json(lock.body);
    try {
      const snap = store.get();
      const { g, inv, allowed, admin } = await inventoryFor(req, snap);
      const svcById = new Map(inv.services.map((s) => [s.id, s]));
      const SRC = { pin: '고정', folder: 'vCenter 폴더 규칙', scan: '스캔 엔트리', tag: '태그', rule: '이름 규칙', none: '미지정' };
      // 5차 M11·R19: 전역 서비스·등급·담당자 · 드리프트 · 키 종류 · 백업은 화면과 같은 말(영문 코드 금지)
      const BACKUP = { ok: '성공', fail: '실패·지연', none: '잡 없음' };
      const KEY_KIND = { instanceUuid: 'instanceUuid', moref: 'moref(임시)', serviceTag: '서비스태그', fleetId: 'fleetId(임시)' };
      const globalById = new Map((inv.global?.globals || []).map((x) => [x.id, x]));
      const lines = [CSV_BOM + csvLine(['법인', '폴더', '서비스', '전역 서비스', '등급', '담당자', '종류', '이름', '키', '키 종류', '소속 근거', '근거 값', '드리프트', '전원', 'CPU%', '메모리%', 'vCPU/코어', '메모리GB', '스토리지GB', '부품 장애', '백업 24h', '호스트', 'IP'])];
      for (const m of g.members) {
        if (allowed && !allowed.has(m.corp)) continue;
        if (!m.corp && allowed) continue;
        const r = inv.resolved.get(m.key); const s = r.serviceId ? svcById.get(r.serviceId) : null;
        const gl = s?.globalId ? globalById.get(s.globalId) : null;
        // 드리프트 칸 — 고정한 구성원만 뜻이 있다. 자동 판정을 모르면(태그 못 읽음) '없음' 과 구별해 적는다(3차 반증 9)
        const drift = r.src !== 'pin' ? '' : r.drift ? `고정과 다름(자동: ${svcById.get(r.auto?.serviceId)?.name || r.auto?.serviceId || '—'})`
          : r.auto?.unchecked && !r.auto?.serviceId ? '모름(태그를 못 읽어 자동 판정 확인 안 됨)' : r.auto?.serviceId ? '같음' : '자동 판정 없음';
        lines.push(csvLine([g.corpNames.get(m.corp) || m.corp || '(법인 미지정)', s?.path || '', s?.name || '(미지정)', gl?.name || '', s ? (s.tier ?? '') : '', s?.owner || '',
          m.kind === 'vm' ? 'VM' : '베어메탈', maskName(m, admin, !!allowed), pubKey(m.key, !!allowed), KEY_KIND[m.keyKind] || m.keyKind || '', SRC[r.src] || r.src, r.via || r.reason || '', drift,
          m.powered === true ? '켜짐' : m.powered === false ? '꺼짐' : '모름', m.usage?.cpuPct ?? '', m.usage?.memPct ?? '', m.cores ?? '', m.memGB ?? '', m.kind === 'vm' ? (m.storageGB ?? '') : '',
          m.faults == null ? '' : m.faults, m.kind !== 'vm' ? '' : m.backup === undefined ? '해당 없음' : (m.backup === null ? '모름' : (BACKUP[m.backup] || m.backup)), m.host || '', m.kind === 'vm' ? m.ip : '']));
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="svc-inventory-${todayStamp()}.csv"`);
      res.send(lines.join('\r\n'));
    } catch (e) { if (!res.headersSent) res.status(500).json({ ok: false, reason: String(e?.message || e).slice(0, 300) }); }
    finally { lock.release(); }
  });

  // ── 쓰기 연산 하나로 ──
  api.post('/tools/svc-inventory/op', writeRole, toolsPerm, async (req, res) => {
    try {
      const snap = store.get();
      const user = req.user;
      if (isDemoGuest(user)) return res.status(403).json({ ok: false, error: 'forbidden', reason: '데모 계정은 바꿀 수 없습니다.' });
      const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
      const op = t(b.op);
      const who = user?.username || 'unknown';
      const audit = (target, detail) => logAudit({ user: who, action: `svc-inventory.${op}`, target: String(target || '').slice(0, 200), detail: String(detail || '').slice(0, 900) });
      const done = (result) => {
        if (!flushStore()) return res.status(500).json({ ok: false, reason: '저장에 실패했습니다(디스크 쓰기) — 다시 시도하십시오.' });
        return res.json({ ok: true, rev: storeRev(), result });
      };

      // 전체 범위 관리자 연산
      if (FLEET_OPS[op] || op === 'store.reset' || op === 'corp.purge') {
        if (!fleetAdmin(user, snap)) return res.status(403).json({ ok: false, error: 'forbidden', reason: '전역 카탈로그·태그 카테고리·초기화·법인 항목 정리는 전체 범위 관리자만 바꿀 수 있습니다.' });
        if (op === 'corp.purge') {
          // 등록 해제된 vCenter 의 법인 항목(서비스·폴더·규칙·별칭·이름 규칙)과 그 법인 고정을 지운다(5차 반증 R2 — 법인 쓰기는 스냅샷에 없으면 404 라
          // 다른 길이 없었다). 아직 등록된 vCenter·스냅샷이 비었을 때(판단 불가)는 거부한다. dry 는 지울 개수만 돌려준다.
          const corp = t(b.corp);
          if (!corp) return res.status(400).json({ ok: false, reason: '법인(vCenter)을 지정하십시오.' });
          if (storeLoadError()) return res.status(503).json({ ok: false, error: 'registryUnreadable', reason: '저장소를 읽지 못해 쓰기를 막았습니다.' });
          const known = knownCorpsOf(snap);
          if (!known) return res.status(409).json({ ok: false, reason: '인벤토리 스냅샷이나 vCenter 등록부를 읽지 못해 등록 해제 여부를 판단할 수 없습니다 — 수집 뒤 다시 시도하십시오.' });
          if (known.has(corp)) return res.status(409).json({ ok: false, reason: '이 vCenter 는 아직 등록돼 있습니다(등록부 또는 인벤토리) — 법인 항목 정리는 등록 해제된 vCenter 에만 씁니다.' });
          const c = getMap().corps[corp] || null;
          const pinKeys = Object.entries(getPins().pins).filter(([, p]) => p.corp === corp).map(([k]) => k);
          if (!c && !pinKeys.length) return res.status(404).json({ ok: false, reason: '그 법인 항목이 없습니다.' });
          const counts = { services: c?.services.length || 0, folders: c?.folders.length || 0, folderRules: c?.folderRules.length || 0, aliases: c?.aliases.length || 0, nameRules: c?.nameRules.length || 0, pins: pinKeys.length };
          if (b.dry === true) return res.json({ ok: true, result: { corp, counts } });
          // 화면이 본 개수와 지금 개수가 다르면 지우지 않는다(미리보기 뒤 다른 법인을 골랐거나 그 사이 바뀜 — 반증 7)
          if (b.expect && typeof b.expect === 'object' && Object.keys(counts).some((k) => Number(b.expect[k]) !== counts[k])) return res.status(409).json({ ok: false, reason: '지울 개수가 미리보기와 다릅니다 — 다시 확인하십시오.', result: { counts } });
          if (c) { const r1 = mutateMap((d) => { delete d.corps[corp]; return { result: {} }; }); if (!r1.ok) return res.status(r1.status).json({ ok: false, reason: r1.error }); }
          if (pinKeys.length) {
            const r2 = mutatePins((d) => { for (const k of pinKeys) delete d.pins[k]; return { result: {} }; });
            if (!r2.ok) return res.status(r2.status).json({ ok: false, reason: `법인 항목은 지웠지만 고정 정리에 실패했습니다 — ${r2.error}` });
          }
          audit(corp, `등록 해제된 vCenter 의 법인 항목 정리 ${JSON.stringify(counts)}`);
          return done({ corp, counts });
        }
        if (op === 'store.reset') {
          if (!storeLoadError()) return res.status(409).json({ ok: false, reason: '저장소가 정상입니다 — 초기화할 것이 없습니다.' });
          const r = resetCorrupt(); audit('service-map', `손상본 보존: ${r.moved.join(', ') || '(없음)'}`);
          return res.json({ ok: r.ok, rev: storeRev(), result: r });
        }
        const r = mutateMap((d) => FLEET_OPS[op](d, b));
        if (!r.ok) return res.status(r.status).json({ ok: false, reason: r.error });
        audit(b.id || b.name || op, JSON.stringify({ name: b.name, tier: b.tier, owner: b.owner, value: b.value }).slice(0, 400));
        return done(r.result);
      }

      // 이하 법인 연산 — 쓰기 범위 확인('조회 밖 404 → 쓰기 밖 403')
      const deny = corpWriteAccess(user, snap, b.corp);
      if (deny) return res.status(deny.status).json({ ok: false, error: deny.status === 403 ? 'forbidden' : 'not_found', reason: deny.reason });
      const corp = t(b.corp);
      if (storeLoadError()) return res.status(503).json({ ok: false, error: 'registryUnreadable', reason: '저장소를 읽지 못해 쓰기를 막았습니다.' });

      if (CORP_OPS[op]) {
        const r = mutateMap((d) => CORP_OPS[op](d, { ...b, corp }));
        if (!r.ok) return res.status(r.status).json({ ok: false, reason: r.error });
        // 서비스를 지우면 그 서비스를 가리키는 고정도 지운다(구성원은 미지정으로 — 자동 규칙이 있으면 그쪽으로).
        let pinsRemoved = 0;
        if (op === 'service.remove') {
          const rp = mutatePins((d) => { for (const [k, p] of Object.entries(d.pins)) if (p.corp === corp && p.serviceId === r.result.removed) { delete d.pins[k]; pinsRemoved += 1; } return { result: {} }; });
          if (!rp.ok) return res.status(rp.status).json({ ok: false, reason: `서비스는 지웠지만 고정 정리에 실패했습니다 — ${rp.error}` });
        }
        audit(corp, `${op} ${JSON.stringify({ id: b.id, name: b.name, path: b.path, prefix: b.prefix, kind: b.kind, match: b.match, value: b.value, serviceId: b.serviceId, globalId: b.globalId, enabled: b.enabled, moveUp: b.moveUp === true || undefined, keepAlias: Array.isArray(b.keepAlias) ? b.keepAlias.slice(0, 2) : undefined }).slice(0, 600)}${pinsRemoved ? ` · 고정 ${pinsRemoved}건 정리` : ''}`);
        return done({ ...r.result, ...(pinsRemoved ? { pinsRemoved } : {}) });
      }

      if (op === 'pins.set' || op === 'pins.clear' || op === 'pins.review') {
        const rawKeys = (Array.isArray(b.keys) ? b.keys : [b.key]).map(t).filter(Boolean);
        if (!rawKeys.length) return res.status(400).json({ ok: false, reason: '대상이 없습니다.' });
        if (rawKeys.length > LIMITS.pinBatch) return res.status(400).json({ ok: false, reason: `한 번에 ${LIMITS.pinBatch}대까지입니다.` });
        const map = getMap();
        const serviceId = op === 'pins.set' ? t(b.serviceId) : '';
        if (op === 'pins.set' && !(map.corps[corp]?.services || []).some((s) => s.id === serviceId)) return res.status(404).json({ ok: false, reason: '대상 서비스를 찾지 못했습니다.' });
        const g = await gather(snap, map.settings.tagCategory || '');
        const corpOfKey = new Map(g.members.map((m) => [m.key, m.corp]));
        // 범위 계정은 베어메탈 키를 토큰으로 받았다 — 이 법인 구성원·고정 키 안에서만 되돌린다(R7). 되돌리지 못한 키는 건너뛴다.
        const resolveKey = keyResolverFor(!!scopedVcenterIds(user, snap), [...g.members.filter((m) => m.corp === corp).map((m) => m.key), ...Object.entries(peekPins()).filter(([, p]) => p?.corp === corp).map(([k]) => k)]);
        const keys = rawKeys.map(resolveKey).filter(Boolean);
        const unresolved = rawKeys.length - keys.length;
        // '고정 유지' 는 지금의 자동 판정을 함께 적는다 — 자동 판정이 다른 서비스로 바뀌면 다시 드리프트로 묻는다(5차 반증 R8).
        // 화면이 본 자동 판정(expectAuto)과 지금 판정이 다르면 그 키는 검토하지 않는다 — 사람이 보지 못한 새 드리프트를 숨기지 않게(5차 1차 반증 3).
        // pins.clear + onlyIfRedundant: 지금도 '고정 = 자동 판정' 인 키만 지운다(반증 8 — 그 사이 바뀐 고정을 지우면 소속이 조용히 바뀐다).
        const needNow = op === 'pins.review' || (op === 'pins.clear' && b.onlyIfRedundant === true);
        const autoNow = needNow ? (await inventoryFor(req, snap)).inv.resolved : null;
        const expectAuto = op === 'pins.review' && b.expectAuto && typeof b.expectAuto === 'object' && !Array.isArray(b.expectAuto)
          ? Object.fromEntries(Object.entries(b.expectAuto).slice(0, LIMITS.pinBatch).map(([k, v]) => [resolveKey(t(k)), v]).filter(([k]) => k)) : null;
        let changed = 0; let skipped = unresolved; let stale = 0;
        // 키 등급이 오른 구성원은 고정이 낮은 등급 키(별칭)에 있을 수 있다(5차 R15) — 쓰는 김에 새 키로 옮긴다(읽기 경로는 쓰지 않는다).
        const aliasOf = new Map(g.members.filter((m) => m.corp === corp && m.aliasKeys?.length).map((m) => [m.key, m.aliasKeys]));
        const moveAlias = (d, k) => {
          if (d.pins[k]) { for (const a of aliasOf.get(k) || []) if (d.pins[a]?.corp === corp) delete d.pins[a]; return; }
          for (const a of aliasOf.get(k) || []) {
            if (d.pins[a]?.corp !== corp) continue;
            if (!d.pins[k]) d.pins[k] = { ...d.pins[a] };
            delete d.pins[a];
          }
        };
        const r = mutatePins((d) => {
          for (const k of keys) {
            if (op === 'pins.set') {
              // 살아 있는 구성원이고 그 법인 것이어야 한다(법인을 넘는 지정 금지 — 법인 귀속이 없는 서버는 통합 서버 인벤토리에서 먼저 정한다).
              if (corpOfKey.get(k) !== corp) { skipped += 1; continue; }
              moveAlias(d, k);
              d.pins[k] = { serviceId, corp, by: who, at: Date.now(), reviewed: false }; changed += 1;
            } else {
              moveAlias(d, k);
              const p = d.pins[k];
              if (!p || p.corp !== corp) { skipped += 1; continue; }
              const cur = autoNow?.get(k);
              if (op === 'pins.clear') {
                if (b.onlyIfRedundant === true && !(cur?.src === 'pin' && cur.redundant)) { stale += 1; continue; }
                delete d.pins[k]; changed += 1;
              } else {
                const now = cur?.auto?.serviceId ?? null;
                if (expectAuto && Object.prototype.hasOwnProperty.call(expectAuto, k) && (expectAuto[k] ?? null) !== now) { stale += 1; continue; }
                // 항목은 동결된 지금 값이다 — 고치지 않고 새 객체로 바꿔 넣는다(6차 8 — mutatePins 는 바뀐 키만 정리한다)
                d.pins[k] = { ...p, reviewed: true, reviewedAuto: now }; changed += 1;
              }
            }
          }
          if (!changed && stale) return { error: op === 'pins.review' ? '자동 판정이 화면과 달라졌습니다 — 새로 고쳐 다시 확인하십시오.' : '지금은 불필요한 고정이 아닙니다(자동 판정이 바뀜) — 새로 고쳐 다시 확인하십시오.', status: 409 };
          return { result: { changed, skipped, ...(stale ? { stale } : {}) } };
        });
        if (!r.ok) return res.status(r.status).json({ ok: false, reason: r.error });
        audit(corp, `${op} ${changed}건${serviceId ? ` → ${serviceId}` : ''}${skipped ? ` · 건너뜀 ${skipped}(다른 법인·없는 키)` : ''} · ${keys.slice(0, 20).join(',')}`);
        return done(r.result);
      }

      // 낮은 등급 키(별칭)로 저장된 고정을 새 키로 옮긴다(5차 R15) — 판정은 이미 별칭 고정을 쓰고 있으므로 소속은 바뀌지 않는다.
      // 새 키에도 고정이 있으면: 서비스가 같으면(중복) 옛 키만 지운다(dropped). **서비스가 다르면(충돌 — 6차 3) 건너뛴다**(conflicts) —
      // 판정은 새 키를 쓰고 있지만 옛 키 쪽이 사람이 의도한 값일 수 있다. 충돌은 `keys` 로 그 구성원을 고르고 `keepNew:true` 일 때만 옛 키를 지운다
      // (옛 키 서비스를 남기려면 화면이 그 서비스로 pins.set 을 보낸다 — 그때 moveAlias 가 옛 키를 정리한다).
      if (op === 'pins.rekey') {
        const g = await gather(snap, getMap().settings.tagCategory || '');
        const hideKeys = !!scopedVcenterIds(user, snap);
        const corpMembers = g.members.filter((m) => m.corp === corp && m.aliasKeys?.length);
        let only = null;
        if (Array.isArray(b.keys)) {
          const resolveKey = keyResolverFor(hideKeys, corpMembers.map((m) => m.key));
          const known = new Set(corpMembers.map((m) => m.key));   // 이 법인에서 옛 키를 가진 구성원만(모르는 키는 건너뛴다 — 조용히 0건 성공이 되지 않게)
          only = new Set(b.keys.slice(0, LIMITS.pinBatch).map((k) => resolveKey(t(k))).filter((k) => k && known.has(k)));
          if (!only.size) return res.status(400).json({ ok: false, reason: '대상이 없습니다(새로 고쳐 다시 고르십시오).' });
        }
        const keepNew = only && b.keepNew === true;
        let moved = 0; let dropped = 0; let conflicts = 0; let otherCorp = 0;
        const r = mutatePins((d) => {
          for (const m of corpMembers) {
            if (only && !only.has(m.key)) continue;
            for (const a of m.aliasKeys) {
              const p = d.pins[a]; if (!p || p.corp !== corp) continue;
              const cur = d.pins[m.key];
              // 새 키 고정이 다른 법인 것(법인 불일치 — 판정이 쓰지 않는다)이면 '이미 있음' 으로 보고 이 법인 고정을 지우지 않는다(6차 반증 F6)
              if (cur && cur.corp !== corp) { otherCorp += 1; continue; }
              if (cur && cur.serviceId !== p.serviceId && !keepNew) { conflicts += 1; continue; }
              if (cur) dropped += 1; else { d.pins[m.key] = { ...p }; moved += 1; }
              delete d.pins[a];
            }
          }
          return { result: { moved, dropped, ...(conflicts ? { conflicts } : {}), ...(otherCorp ? { otherCorp } : {}) } };
        });
        if (!r.ok) return res.status(r.status).json({ ok: false, reason: r.error });
        audit(corp, `옛 키 고정 ${moved}건을 새 키로 옮김${dropped ? ` · 새 키에 이미 있던 ${dropped}건은 옛 키만 지움${keepNew ? '(충돌 — 새 키 유지 선택)' : ''}` : ''}${conflicts ? ` · 서비스가 다른 ${conflicts}건은 건너뜀` : ''}${otherCorp ? ` · 새 키가 다른 법인에 고정된 ${otherCorp}건은 건너뜀` : ''}`);
        return done(r.result);
      }

      if (op === 'ghosts.prune') {
        const { inv } = await inventoryFor(req, snap);
        const ghostKeys = new Set(inv.queues.ghosts.filter((x) => x.corp === corp).map((x) => x.key));
        const hideKeys = !!scopedVcenterIds(user, snap);   // R7 — 범위 계정에는 토큰으로 보이고 토큰으로 받는다
        // dry 는 앞 GHOST_PRUNE_MAX 건의 키만 준다(6차 8 — 받는 쪽 상한과 같다). 그보다 많으면 total 로 알리고 화면이 '다시 누르면 다음' 을 안내한다.
        if (b.dry === true) return res.json({ ok: true, result: { keys: [...ghostKeys].slice(0, GHOST_PRUNE_MAX).map((k) => pubKey(k, hideKeys)), total: ghostKeys.size, max: GHOST_PRUNE_MAX, held: inv.queues.ghostsHeld.filter((x) => x.corp === corp).length } });
        const resolveGhost = keyResolverFor(hideKeys, [...ghostKeys]);
        // 화면이 미리 본 **키**와 지금 유령의 교집합만 지운다(5차 R11 · 3차 반증 3 — 개수만 비교하면 확인창에 없던 키가 끼어 지워졌다. insights fleet/prune 과 같은 방식).
        // 옛 화면(키 없이 개수만 · 아무것도 없이)도 받는다: expect 는 정수만, 다르면 409.
        let targets = ghostKeys; let skipped = 0;
        if (Array.isArray(b.keys)) {
          const raw = [...new Set(b.keys.slice(0, GHOST_PRUNE_MAX).map((k) => t(k)).filter(Boolean))];   // 같은 키 두 번은 한 번(4차 반증 7)
          const asked = [...new Set(raw.map(resolveGhost).filter(Boolean))];
          skipped = raw.length - asked.length;   // 되돌리지 못한 토큰
          targets = new Set(asked.filter((k) => ghostKeys.has(k)));
          skipped += asked.length - targets.size;
        } else if (b.expect != null) {
          if (!Number.isInteger(b.expect)) return res.status(400).json({ ok: false, reason: 'expect 는 정수여야 합니다.' });
          if (b.expect !== ghostKeys.size) return res.status(409).json({ ok: false, reason: `유령 고정 수가 미리 본 것(${b.expect})과 지금(${ghostKeys.size})이 다릅니다 — 새로 고쳐 다시 확인하십시오.` });
        }
        let removed = 0;
        const r = mutatePins((d) => { for (const k of targets) if (d.pins[k]) { delete d.pins[k]; removed += 1; } return { result: { removed, skipped } }; });
        if (!r.ok) return res.status(r.status).json({ ok: false, reason: r.error });
        audit(corp, `유령 고정 ${removed}건 정리(판정 보류 제외)${skipped ? ` · 미리 본 뒤 유령이 아니게 된 ${skipped}건 건너뜀` : ''}`);
        return done(r.result);
      }

      if (op === 'scan.label') {
        const { listScanRanges, setScanRangeLabel } = await import('../../idrac/scanRanges.js');
        const { datacenterOfVcenter, getDatacenterAssign } = await import('../../datacenter/store.js');
        const entry = listScanRanges().find((e) => t(e.id) === t(b.entryId));
        if (!entry) return res.status(404).json({ ok: false, reason: '스캔 엔트리를 찾지 못했습니다.' });
        const dc = t(datacenterOfVcenter(corp));
        if (!dc) {
          if (!fleetAdmin(user, snap)) return res.status(403).json({ ok: false, error: 'forbidden', reason: '이 법인에 DataCenter 매핑이 없어 엔트리 소속을 확인할 수 없습니다 — 전체 범위 관리자만 라벨을 정할 수 있습니다.' });
        } else {
          if (t(entry.datacenterId) !== dc) return res.status(403).json({ ok: false, error: 'forbidden', reason: '이 엔트리는 다른 DataCenter 소속입니다.' });
          // 라벨은 그 DataCenter 의 모든 vCenter 에 걸린다 — 그 vCenter 전부에 쓰기 범위가 있어야 한다.
          const vcsOfDc = Object.entries(getDatacenterAssign() || {}).filter(([, d]) => t(d) === dc).map(([v]) => t(v));
          const outside = vcsOfDc.filter((v) => !inUserWriteScope(user, snap, v));
          if (outside.length) return res.status(403).json({ ok: false, error: 'forbidden', reason: `이 DataCenter 의 다른 법인 ${outside.length}곳에 쓰기 범위가 없어 라벨을 정할 수 없습니다(라벨은 DataCenter 공용).` });
        }
        const r = setScanRangeLabel(entry.id, b.label, { datacenterId: t(entry.datacenterId) });
        if (!r.ok) return res.status(r.status).json({ ok: false, reason: r.reason });
        audit(corp, `스캔 엔트리 ${entry.id} 라벨 '${t(b.label).slice(0, 128)}'`);
        _inputRev += 1;   // 라벨은 입력이다 — 다음 조회가 (진행 중 수집 뒤에) 새로 모은다
        return res.json({ ok: true, rev: storeRev(), result: { entryId: entry.id } });
      }
      return res.status(400).json({ ok: false, reason: `알 수 없는 연산: ${op.slice(0, 40)}` });
    } catch (e) { if (!res.headersSent) res.status(500).json({ ok: false, reason: String(e?.message || e).slice(0, 300) }); }
  });
}
