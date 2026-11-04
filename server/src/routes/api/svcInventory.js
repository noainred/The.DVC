/**
 * routes/api/svcInventory.js — 특수 기능 '서비스 인벤토리'(도구 키 `svc-inventory`, v2.885).
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
import { addressMatcher, maskedAddressName } from '../../auth/addressMask.js';
import { store } from '../../store.js';
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
import { getMap, getPins, storeRev, storeLoadError, mutateMap, mutatePins, flushStore, resetCorrupt, LIMITS } from '../../servicemap/store.js';
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
/** Bareos 원장 → VM 백업 칸(순수). undefined = Bareos 미사용 · null = 원장 못 읽음 · 'ok' 24h 내 성공 · 'fail' 실패/지연 · 'none' 잡 없음. */
export function backupOf(view, now) {
  if (view === null) return null;
  if (!view || view.job === false) return 'none';
  if (view.st === 'error' || view.st === 'canceled') return 'fail';
  const okAt = numOrNull(view.ok) ?? (view.st === 'ok' || view.st === 'warning' ? numOrNull(view.at) : null);
  if (okAt != null && now - okAt <= DAY) return 'ok';
  return view.job ? 'fail' : 'none';
}

// ───────── 입력 수집(스냅샷 세대 + 태그 카테고리마다 1회) ─────────
let _gather = { key: '', promise: null };
let _inputRev = 0;   // 저장소 밖 입력(스캔 엔트리 라벨)을 이 화면에서 바꿨을 때 응답 캐시를 넘긴다
async function gather(snap, tagCategory) {
  const key = `${snap?.generatedAt || 0}|${tagCategory}`;
  if (_gather.key === key && _gather.promise) return _gather.promise;
  const p = gatherNow(snap, tagCategory).catch((e) => { if (_gather.promise === p) _gather = { key: '', promise: null }; throw e; });
  _gather = { key, promise: p };
  return p;
}

async function gatherNow(snap, tagCategory) {
  const sourceErrors = [];
  const now = Date.now();
  const [{ getFleetInventory, fleetKeySources }, { loadRegistry }, { getInventory }, { allRemoteServers }, edgeUsage, { attributeBareMetalFromSnap },
    { unreadVcenterReasons }, { getEdgeFleetServers }, { listScanRanges }, pf, bareosReg, { bareosVmView }] = await Promise.all([
    import('../../insights/fleetInventory.js'), import('../../idrac/registry.js'), import('../../idrac/invCache.js'),
    import('../../collector/remoteInventory.js'), import('../../central/bmUsageEdgePull.js'), import('../../idrac/corpAttribution.js'),
    import('../../metrics/unreadVcenters.js'), import('../../central/fleet.js'), import('../../idrac/scanRanges.js'),
    Promise.all([import('../../partfault/db.js'), import('../../partfault/settings.js')]), import('../../bareos/registry.js'), import('../../bareos/vmView.js'),
  ]);
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
  let backupMeta = { used: false };
  let bareosBy = null;
  try {
    if (bareosReg.registryLoadError()) { backupMeta = { used: true, unreadable: true }; bareosBy = null; }
    else {
      const jobs = bareosReg.jobDigests();
      if (jobs.length) {
        bareosBy = new Map(jobs.map((j) => [`${t(j.vcenterId)}|${t(j.vmId)}`, j]));
        backupMeta = { used: true };
      }
    }
  } catch (e) { backupMeta = { used: true, unreadable: true }; sourceErrors.push(`Bareos 원장: ${String(e?.message || e).slice(0, 160)}`); }
  const backupOfVm = (vm) => {
    if (!backupMeta.used) return undefined;
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
      key, keyKind, kind: 'vm', corp: vc, name: t(vm.name), folderPath: typeof vm.folderPath === 'string' ? vm.folderPath : null, tags,
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
  const edgeScan = (() => { try { return new Map(getEdgeFleetServers().map((s) => [t(s.serverId), t(s.scanRangeId)])); } catch { return new Map(); } })();
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
    const entryId = b.source === 'edge' ? (edgeScan.get(sid) || '') : t(regById.get(sid)?.scanRangeId);
    const e = entryId ? scanEntries.get(entryId) : null;
    let powered = null;
    try { const inv = b.source === 'edge' ? null : getInventory(sid); const ps = lc(inv?.powerState); powered = ps === 'on' ? true : ps === 'off' ? false : null; } catch { powered = null; }
    members.push({
      key, keyKind, kind: 'bm', corp: vc, name: t(b.name), nameIsAddr: isAddr(t(b.name)), serviceTag: t(b.serviceTag), source: t(b.source), remoteAgent: t(b.remoteAgent),
      scan: e ? { entryId, label: e.service } : null, powered, cores: x?.cores ?? null, memGB: x?.memGB ?? null,
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
  let bmBlocked = false;
  try { bmBlocked = (fleetKeySources(snap).unreadable || []).some((u) => u.source !== 'vcenter'); } catch { bmBlocked = true; }
  return { members, hostByKey, unreadCorps, bmBlocked, corpNames, scanEntries, faultsMeta, backupMeta, sourceErrors, at: now };
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
const writableOf = (user, snap, vc) => writerOk(user) && inUserWriteScope(user, snap, vc);
const fleetAdmin = (user, snap) => isAdminDetailUser(user) && !scopedVcenterIds(user, snap);   // 관리자 판본 판정은 isAdminDetailUser 하나(role 직접 비교 금지)

// ───────── 응답 조립 ─────────
function loadState() {
  return { map: getMap(), pins: getPins().pins, rev: storeRev(), err: storeLoadError() };
}
async function inventoryFor(req, snap) {
  const st = loadState();
  const g = await gather(snap, st.map.settings.tagCategory || '');
  const allowed = scopedVcenterIds(req.user, snap);
  const admin = isAdminDetailUser(req.user);
  const inv = buildInventory({ members: g.members, map: st.map, pins: st.pins, hostByKey: g.hostByKey, allowed, unreadCorps: g.unreadCorps, bmBlocked: g.bmBlocked, corpNames: g.corpNames, scanEntries: g.scanEntries, adminView: admin });
  return { st, g, inv, allowed, admin };
}
const maskName = (m, admin) => (!admin && m.kind === 'bm' && m.nameIsAddr ? maskedAddressName(m.name) : m.name);

function memberRow(m, r, admin) {
  return {
    key: m.key, keyKind: m.keyKind, kind: m.kind, corp: m.corp, name: maskName(m, admin), serviceId: r.serviceId, src: r.src, via: r.src === 'folder' || r.src === 'scan' || r.src === 'tag' || r.src === 'rule' ? r.via : '',
    reason: r.reason || '', drift: !!r.drift, unchecked: !!r.unchecked, pinMismatch: r.pinMismatch ? true : undefined,
    autoServiceId: r.src === 'pin' ? (r.auto?.serviceId || null) : undefined,
    powered: m.powered, cores: m.cores, memGB: m.memGB, storageGB: m.kind === 'vm' ? m.storageGB : undefined,
    usage: m.usage ? { state: m.usage.state, cpu: m.usage.cpuPct ?? null, mem: m.usage.memPct ?? null, src: m.usage.src || null } : null,
    faults: m.faults, backup: m.backup, host: m.host || '', ip: m.kind === 'vm' ? m.ip : '', folderPath: m.kind === 'vm' ? m.folderPath : undefined,
    serviceTag: m.kind === 'bm' ? m.serviceTag : undefined, source: m.kind === 'bm' ? m.source : undefined, scanEntry: m.scan ? m.scan.entryId : undefined,
  };
}

export function registerSvcInventory(api) {
  // ── 메인: 트리·서비스별 집계·전역 축·큐 개수 ──
  api.get('/tools/svc-inventory', toolsPerm, async (req, res) => {
    const snap = store.get();
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
        queues: { unassigned: q.unassigned.reduce((a, x) => a + x.n, 0), unassignedGroups: q.unassigned.length, unmapped: q.unmapped.length, drift: q.drift.length, mismatch: q.mismatch.length, redundant: q.redundant.n, ghosts: q.ghosts.length, ghostsHeld: q.ghostsHeld.length },
        // 법인을 고른 화면의 탭 숫자가 KPI 와 같은 기준이 되도록 법인별로도 센다(전 법인 숫자를 법인 화면에 쓰지 않는다).
        queuesByCorp: (() => {
          const o = {};
          const bump = (c, k, n = 1) => { const id = c || ''; (o[id] ||= { unassigned: 0, unmapped: 0, drift: 0, ghosts: 0, ghostsHeld: 0, mismatch: 0 })[k] += n; };
          for (const x of q.unassigned) bump(x.corp, 'unassigned', x.n);
          for (const x of q.unmapped) bump(x.corp, 'unmapped');
          for (const x of q.drift) bump(x.corp, 'drift');
          for (const x of q.ghosts) bump(x.corp, 'ghosts');
          for (const x of q.ghostsHeld) bump(x.corp, 'ghostsHeld');
          for (const x of q.mismatch) bump(x.corp, 'mismatch');
          return o;
        })(),
        meta: { faults: g.faultsMeta, backup: g.backupMeta, unreadCorps: [...g.unreadCorps].filter((v) => !allowed || allowed.has(v)), bmBlocked: g.bmBlocked, sourceErrors: allowed ? [] : g.sourceErrors, limits: LIMITS, snapAt: s?.generatedAt || null },
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
      if (corp && allowed && !allowed.has(corp)) return res.status(404).json({ ok: false, reason: '법인(vCenter)을 찾지 못했습니다.' });
      const svcCorp = svc ? inv.services.find((s) => s.id === svc)?.corp : null;
      if (svc && !svcCorp) return res.status(404).json({ ok: false, reason: '서비스를 찾지 못했습니다.' });
      const gSvc = gid ? new Set(inv.services.filter((s) => s.globalId === gid).map((s) => s.id)) : null;
      const pick = (m) => {
        if (allowed && !allowed.has(m.corp)) return false;
        if (corp && m.corp !== corp) return false;
        const r = inv.resolved.get(m.key);
        if (svc) return r.serviceId === svc;
        if (gSvc) return !!r.serviceId && gSvc.has(r.serviceId);
        if (unassigned) return !r.serviceId;
        return !!corp;   // 법인만 주면 그 법인 전부 — 아무 조건도 없으면 빈 목록(전 함대를 한 번에 내리지 않는다)
      };
      const list = g.members.filter(pick);
      const CAP = 5000;
      const rows = list.slice(0, CAP).map((m) => memberRow(m, inv.resolved.get(m.key), admin));
      const hostKeys = new Set(list.filter((m) => m.kind === 'vm' && m.host).map((m) => hostKeyOf(m.corp, m.host)));
      const nameOfSvc = new Map(inv.services.map((s) => [s.id, s.name]));
      const hosts = [...hostKeys].map((hk) => {
        const h = g.hostByKey.get(hk) || { name: hk.slice(hk.indexOf('|') + 1), corp: hk.slice(0, hk.indexOf('|')), usage: null, faults: null };
        const onHost = g.members.filter((m) => m.kind === 'vm' && m.corp === h.corp && lc(m.host) === lc(h.name));
        const mine = list.filter((m) => m.kind === 'vm' && m.corp === h.corp && lc(m.host) === lc(h.name)).length;
        const others = [...new Set(onHost.map((m) => inv.resolved.get(m.key)?.serviceId).filter((id) => id && id !== svc).map((id) => nameOfSvc.get(id) || id))].slice(0, 20);
        const unassignedOn = onHost.filter((m) => !inv.resolved.get(m.key)?.serviceId).length;
        return { name: h.name, corp: h.corp, serviceTag: h.serviceTag || '', usage: h.usage, faults: h.faults, vmHere: mine, others, unassignedOn };
      }).sort((a, b) => b.vmHere - a.vmHere || a.name.localeCompare(b.name));
      res.json({ ok: true, rev: st.rev, members: rows, omitted: Math.max(0, list.length - CAP), hosts, faults: g.faultsMeta, backup: g.backupMeta });
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
      const inCorp = (x) => !corp || x.corp === corp;
      const byKey = new Map(g.members.map((m) => [m.key, m]));
      const mask = (list) => list.map((x) => ({ ...x, name: byKey.get(x.key) ? maskName(byKey.get(x.key), admin) : x.name }));
      res.json({
        ok: true, rev: st.rev,
        unassigned: q.unassigned.filter(inCorp).map((x) => ({ ...x, names: mask(x.names) })),
        unmapped: q.unmapped.filter(inCorp), drift: mask(q.drift.filter(inCorp)), mismatch: mask(q.mismatch.filter(inCorp)),
        redundant: q.redundant, ghosts: q.ghosts.filter(inCorp), ghostsHeld: q.ghostsHeld.filter(inCorp), bmBlocked: g.bmBlocked,
      });
    } catch (e) { if (!res.headersSent) res.status(500).json({ ok: false, reason: String(e?.message || e).slice(0, 300) }); }
  });

  // ── 한 대씩 고정 후보 ──
  api.get('/tools/svc-inventory/candidates', toolsPerm, async (req, res) => {
    try {
      const snap = store.get();
      const { g, inv, allowed, admin } = await inventoryFor(req, snap);
      const kind = req.query.kind === 'vm' ? 'vm' : 'bm';
      const corp = t(req.query.corp); const qq = lc(req.query.q).slice(0, 64); const onlyUn = req.query.unassignedOnly !== '0';
      if (corp && allowed && !allowed.has(corp)) return res.status(404).json({ ok: false, reason: '법인(vCenter)을 찾지 못했습니다.' });
      const list = g.members.filter((m) => m.kind === kind && m.corp && (!allowed || allowed.has(m.corp)) && (!corp || m.corp === corp)
        && (!onlyUn || !inv.resolved.get(m.key)?.serviceId)
        && (!qq || lc(m.name).includes(qq) || lc(m.serviceTag).includes(qq) || lc(m.folderPath).includes(qq) || lc(m.ip).includes(qq)));
      const CAP = 2000;
      res.json({ ok: true, items: list.slice(0, CAP).map((m) => ({ key: m.key, name: maskName(m, admin), kind: m.kind, corp: m.corp, serviceTag: m.serviceTag || '', folderPath: m.folderPath ?? null, source: m.source || '', scanEntry: m.scan?.entryId || '', serviceId: inv.resolved.get(m.key)?.serviceId || null, src: inv.resolved.get(m.key)?.src || 'none' })), omitted: Math.max(0, list.length - CAP) });
    } catch (e) { if (!res.headersSent) res.status(500).json({ ok: false, reason: String(e?.message || e).slice(0, 300) }); }
  });

  // ── CSV(범위 안 구성원 전부) ──
  api.get('/tools/svc-inventory.csv', toolsPerm, csvPerm, async (req, res) => {
    const lock = acquireExport('svc-inventory-csv', req);
    if (!lock.ok) return res.status(lock.status).json(lock.body);
    try {
      const snap = store.get();
      const { g, inv, allowed, admin } = await inventoryFor(req, snap);
      const svcById = new Map(inv.services.map((s) => [s.id, s]));
      const SRC = { pin: '고정', folder: 'vCenter 폴더 규칙', scan: '스캔 엔트리', tag: '태그', rule: '이름 규칙', none: '미지정' };
      const lines = [CSV_BOM + csvLine(['법인', '폴더', '서비스', '종류', '이름', '키', '소속 근거', '근거 값', '전원', 'CPU%', '메모리%', 'vCPU/코어', '메모리GB', '스토리지GB', '부품 장애', '백업 24h', '호스트', 'IP'])];
      for (const m of g.members) {
        if (allowed && !allowed.has(m.corp)) continue;
        if (!m.corp && allowed) continue;
        const r = inv.resolved.get(m.key); const s = r.serviceId ? svcById.get(r.serviceId) : null;
        lines.push(csvLine([g.corpNames.get(m.corp) || m.corp || '(법인 미지정)', s?.path || '', s?.name || '(미지정)', m.kind === 'vm' ? 'VM' : '베어메탈', maskName(m, admin), m.key, SRC[r.src] || r.src, r.via || r.reason || '',
          m.powered === true ? '켜짐' : m.powered === false ? '꺼짐' : '모름', m.usage?.cpuPct ?? '', m.usage?.memPct ?? '', m.cores ?? '', m.memGB ?? '', m.kind === 'vm' ? (m.storageGB ?? '') : '',
          m.faults == null ? '' : m.faults, m.backup === undefined ? '' : (m.backup === null ? '모름' : m.backup), m.host || '', m.kind === 'vm' ? m.ip : '']));
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
      if (FLEET_OPS[op] || op === 'store.reset') {
        if (!fleetAdmin(user, snap)) return res.status(403).json({ ok: false, error: 'forbidden', reason: '전역 카탈로그·태그 카테고리·초기화는 전체 범위 관리자만 바꿀 수 있습니다.' });
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
        audit(corp, `${op} ${JSON.stringify({ id: b.id, name: b.name, path: b.path, prefix: b.prefix, kind: b.kind, value: b.value, serviceId: b.serviceId, globalId: b.globalId, enabled: b.enabled }).slice(0, 600)}${pinsRemoved ? ` · 고정 ${pinsRemoved}건 정리` : ''}`);
        return done({ ...r.result, ...(pinsRemoved ? { pinsRemoved } : {}) });
      }

      if (op === 'pins.set' || op === 'pins.clear' || op === 'pins.review') {
        const keys = (Array.isArray(b.keys) ? b.keys : [b.key]).map(t).filter(Boolean);
        if (!keys.length) return res.status(400).json({ ok: false, reason: '대상이 없습니다.' });
        if (keys.length > LIMITS.pinBatch) return res.status(400).json({ ok: false, reason: `한 번에 ${LIMITS.pinBatch}대까지입니다.` });
        const map = getMap();
        const serviceId = op === 'pins.set' ? t(b.serviceId) : '';
        if (op === 'pins.set' && !(map.corps[corp]?.services || []).some((s) => s.id === serviceId)) return res.status(404).json({ ok: false, reason: '대상 서비스를 찾지 못했습니다.' });
        const g = await gather(snap, map.settings.tagCategory || '');
        const corpOfKey = new Map(g.members.map((m) => [m.key, m.corp]));
        let changed = 0; let skipped = 0;
        const r = mutatePins((d) => {
          for (const k of keys) {
            if (op === 'pins.set') {
              // 살아 있는 구성원이고 그 법인 것이어야 한다(법인을 넘는 지정 금지 — 법인 귀속이 없는 서버는 통합 서버 인벤토리에서 먼저 정한다).
              if (corpOfKey.get(k) !== corp) { skipped += 1; continue; }
              d.pins[k] = { serviceId, corp, by: who, at: Date.now(), reviewed: false }; changed += 1;
            } else {
              const p = d.pins[k];
              if (!p || p.corp !== corp) { skipped += 1; continue; }
              if (op === 'pins.clear') { delete d.pins[k]; changed += 1; } else { p.reviewed = true; changed += 1; }
            }
          }
          return { result: { changed, skipped } };
        });
        if (!r.ok) return res.status(r.status).json({ ok: false, reason: r.error });
        audit(corp, `${op} ${changed}건${serviceId ? ` → ${serviceId}` : ''}${skipped ? ` · 건너뜀 ${skipped}(다른 법인·없는 키)` : ''} · ${keys.slice(0, 20).join(',')}`);
        return done(r.result);
      }

      if (op === 'ghosts.prune') {
        const { inv } = await inventoryFor(req, snap);
        const ghostKeys = new Set(inv.queues.ghosts.filter((x) => x.corp === corp).map((x) => x.key));
        if (b.dry === true) return res.json({ ok: true, result: { keys: [...ghostKeys], held: inv.queues.ghostsHeld.filter((x) => x.corp === corp).length } });
        let removed = 0;
        const r = mutatePins((d) => { for (const k of ghostKeys) if (d.pins[k]) { delete d.pins[k]; removed += 1; } return { result: { removed } }; });
        if (!r.ok) return res.status(r.status).json({ ok: false, reason: r.error });
        audit(corp, `유령 고정 ${removed}건 정리(판정 보류 제외)`);
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
        _gather = { key: '', promise: null }; _inputRev += 1;   // 라벨은 입력이다 — 다음 조회가 새로 모은다
        return res.json({ ok: true, rev: storeRev(), result: { entryId: entry.id } });
      }
      return res.status(400).json({ ok: false, reason: `알 수 없는 연산: ${op.slice(0, 40)}` });
    } catch (e) { if (!res.headersSent) res.status(500).json({ ok: false, reason: String(e?.message || e).slice(0, 300) }); }
  });
}
