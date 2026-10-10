/**
 * routes/api/vmSeries.js — 실시간 스파이크 수집(v2.510) API.
 *
 *  GET  /tools/vmseries/settings      설정 + vCenter 별 대상 수 + 디스크 사용량 + 폴러 상태 (tools 권한)
 *  PUT  /tools/vmseries/settings      설정 변경 (admin) — 대상에서 빠진 vCenter 의 DB 파일은 삭제(용량 회수)
 *  GET  /tools/vmseries/scope-data    범위 선택 트리용 클러스터/호스트/폴더/VM (tools, scope)
 *  GET  /tools/vmseries/status        폴러 상태 (tools)
 *  POST /tools/vmseries/run           지금 수집 (admin, 재진입 가드 공유)
 *  GET  /tools/vmseries/local         리포트 'Local + vCenter' 섹션 — VM 1대 (tools, 단건 scope 404)
 *  GET  /tools/vmseries/top           전 VM 스파이크 순위 (tools, scope)
 *  DELETE /tools/vmseries/data        vCenter 데이터 삭제 (admin)
 *
 * 보안: 조회는 `scopedVcenterIds` 교집합(요청 필터보다 먼저), 단건은 `inUserScope` 404(존재 은닉).
 * 설정 응답의 targets 는 범위 계정에 교집합만(범위 밖 id 열거 금지). 도구 게이트 키는 `waste`
 * (auth/toolAccess.js — Optimization 이 이 리포트의 주인).
 */
import { demoOn, isMockMode } from '../../mock/demo/flags.js'; // v2.708 데모(mock)는 켜진 것처럼
import { scopedVcenterIds, inUserScope } from '../../auth/scope.js';
import { mergeScopedMap, filterScopedMap, denyScopedRun, keepScopedFields, ignoredGlobalFields } from '../../auth/scopeMerge.js'; // v2.605 AUTHZ2605-01 · v2.606 AUTHZ2606-05 · v2.607 AUTHZ2607-05
import { requireRole, requirePerm } from '../../auth/auth.js';
import { logAudit } from '../../audit.js';
import { store } from '../../store.js';
import { loadVmSeriesSettings, saveVmSeriesSettings, VMSERIES_LIMITS } from '../../vmseries/settings.js';
import { summarizeScope, normFolder } from '../../vmseries/scope.js';
import { vmSeriesDiskUsage, dropVmSeriesDb, vmSeriesDbStats, vmSeriesMeta, vmSeriesFreeBytes } from '../../vmseries/db.js';
import { dbFileName } from '../../metrics/vmperfDb.js';
import { vmSeriesPollerStatus, runVmSeriesNow } from '../../vmseries/poller.js';
import { localReportFor, topSpikers } from '../../vmseries/query.js';
import { vmSeriesPushStatus } from '../../agent/vmSeriesPush.js';
import { mockLocalReport } from '../../vmseries/mock.js';
import { memoJson, scopeKey } from './shared.js';
import { pushAll } from '../../util/pushAll.js';
/**
 * v2.595(감사 AUTHZ-2595-02): push 상태도 범위로 거른다 — status 만 거르고 push.last 로 범위 밖 vCenter id·오류 문구·
 * centralUrl 이 나갔다(v2.574 SEC-07 과 같은 우회). 범위 계정은 자기 범위 vCenter 의 마지막 보고만, centralUrl·오류 원문은 admin 만.
 */
function scopeVmSeriesPush(p, allowed, user) {
  if (!p || typeof p !== 'object') return p;
  const admin = user?.role === 'admin';
  const last = p.last && (!allowed || !p.last.vcenterId || allowed.has(p.last.vcenterId)) ? p.last : null;
  const out = { ...p, last: last && !admin ? { ...last, error: last.error ? '(관리자만 확인)' : last.error } : last };
  if (!admin) out.centralUrl = null;
  if (allowed && p.last && !last) out.lastHidden = true;
  return out;
}

const morefOf = (id, vcId) => String(id || '').slice(String(vcId || '').length + 1);

/**
 * 폴러 상태를 **범위 계정용으로 축약**한다 (v2.574 SEC-07).
 *
 * ⚠⚠ `lastResult` 의 `errors[]`·`skipped[]`·`per[]` 는 전부 `vcenterId` 를 들고 있고
 *   `errors[].error` 에는 그 vCenter 의 **수집 실패 메시지**가 실린다(`vmseries/poller.js:142`).
 *   `/settings`(:35)는 `vcenters`·`usage`·`resolved`·`settings.targets` 를 전부 `allowed` 로
 *   거르는데 **바로 옆 `status:` 필드가 그 필터를 우회**하고 있었다 — v2.550.3 이
 *   `status.last.counts` 에서 겪은 것과 같은 유형(필드 단위 누락)이다.
 * ⚠ 개수(`vcenters`·`vms`·`samples`)도 전 법인 합계라 범위 계정에는 주지 않는다 —
 *   대신 **거른 목록에서 다시 세어** 준다(주 조회 `bmUsage.js:57-70` 과 같은 방식).
 * ⚠ 통째로 null 로 만들지 않는다 — `running`·`enabled`·`intervalMs` 는 화면이
 *   '수집이 꺼져 있다 / 도는 중이다' 를 말하는 근거라 범위와 무관하다.
 */
export function scopeVmSeriesStatus(st, allowed) {
  if (!st || typeof st !== 'object') return st;
  if (!allowed) return st;
  const { lastResult, ...rest } = st;
  if (!lastResult) return { ...rest, lastResult: null, scoped: true };
  const keep = (x) => x && allowed.has(String(x.vcenterId));
  const errors = (lastResult.errors || []).filter(keep);
  const skipped = (lastResult.skipped || []).filter(keep);
  const per = (lastResult.per || []).filter(keep);
  const sum = (k) => per.reduce((a, x) => a + (Number(x?.[k]) || 0), 0);
  return {
    ...rest,
    lastResult: {
      at: lastResult.at, trigger: lastResult.trigger, ms: lastResult.ms,
      paused: lastResult.paused ?? undefined, mock: lastResult.mock ?? undefined,
      errors, skipped, per,
      // 전 법인 합계 대신 **보이는 것만** 다시 센다.
      vcenters: per.length, vms: sum('vms'), hosts: sum('hosts'),
      samples: sum('samples'), moments: sum('moments'), spikeRows: sum('spikeRows'),
    },
    scoped: true,
  };
}

/**
 * v2.732(점검 2회차 B5-02): 저장된 targets 중 지금 스냅샷에 없는 것 — vCenter 키 · 호스트 id · VM id.
 * 화면은 스냅샷에 있는 것만 트리로 그리므로(삭제된 VM 은 체크박스가 없다) 이 목록이 사람이 낡은 대상을 해제할 유일한 길이다.
 * 클러스터·폴더는 이름 문자열이라(서버도 형식만 검사) 대상이 아니다. 호출부가 범위로 거른 targets 를 넘긴다.
 *  반환 { staleIds: string[](평탄), staleTargets: { [vcId]: { vcenter: bool, hosts: [], vms: [] } },
 *        staleUnknown: { [vcId]: { reason, hosts: n, vms: n } } }
 *
 * v2.733(점검 3회차 C1-03 — v2.732 회귀, 재현): 위 판정을 스냅샷의 id 집합만으로 하면 **그 vCenter 의 인벤토리를 아직(또는 지금)
 *   못 읽은 동안** 선택 호스트·VM 전부가 '목록에 없음' 이 된다 — 재시작 직후 골격(`snap.initial`, 호스트·VM 0)에서 선택 202개가
 *   전부 칩으로 떴고, 그 칩을 ✕ + 저장하면 수집 대상에서 빠진다. 그래서 vCenter 의 **수집 상태**로 먼저 가른다
 *   (`inventoryUnreadReason` — 지어내지 않는다: 근거는 status·stale·그 vCenter 의 이월 인벤토리 유무). 판정하지 않은 vCenter 는
 *   staleTargets 에 넣지 않고 staleUnknown 에 사유와 **선택 개수**를 싣는다(화면이 '수집 전이라 판정하지 않음' 을 말한다).
 */
export function vmSeriesStaleOf(targets, snap) {
  const vcs = new Set((snap?.vcenters || []).map((v) => v.id));
  const hostIds = new Set((snap?.hosts || []).map((h) => h.id));
  const vmIds = new Set((snap?.vms || []).map((v) => v.id));
  const unread = inventoryUnreadReasons(snap);
  const staleIds = []; const staleTargets = {}; const staleUnknown = {};
  for (const [id, t] of Object.entries(targets && typeof targets === 'object' ? targets : {})) {
    const gone = !vcs.has(id);
    if (!gone && unread.has(id)) {
      // 판정하지 않는다 — 선택 개수만 밝힌다(전체 선택이면 판정할 id 가 없으니 싣지 않는다).
      const n = (k) => (t && !t.all && Array.isArray(t[k]) ? t[k].length : 0);
      if (n('hosts') || n('vms')) staleUnknown[id] = { reason: unread.get(id), hosts: n('hosts'), vms: n('vms') };
      continue;
    }
    const list = (k, known) => (t && !t.all && Array.isArray(t[k]) ? t[k].map(String).filter((x) => !known.has(x)) : []);
    const hosts = list('hosts', hostIds); const vms = list('vms', vmIds);
    if (!gone && !hosts.length && !vms.length) continue;
    staleTargets[id] = { vcenter: gone, hosts, vms };
    if (gone) staleIds.push(id);
    pushAll(staleIds, hosts); pushAll(staleIds, vms);   // v2.603 규약 — 인벤토리 규모 배열에 스프레드 push 금지
  }
  return { staleIds, staleTargets, staleUnknown };
}

/** 사유 코드 전부 — 웹 staleSettingIds.js STALE_UNKNOWN_REASON 과 1:1(웹 테스트가 이 줄을 읽어 대조한다). */
export const INVENTORY_UNREAD_REASONS = Object.freeze(['disabled', 'pending', 'unreachable', 'maintenance', 'initial']);

/**
 * v2.733(C1-03): 인벤토리를 읽지 못한 vCenter 와 그 사유(순수). 근거는 store.js 병합의 상태값뿐이다.
 *   · disabled — 수집하지 않는다(인벤토리 없음). · pending — 첫 수집 중·site 첫 push 대기(인벤토리 없음).
 *   · unreachable·maintenance — 마지막 정상값을 이월하면(그 vCenter 의 호스트·VM 이 스냅샷에 있으면) 그 값으로 판정하고,
 *     최소 항목(lastGood 없음·보존 창 초과·직전 캐시 없는 점검중)이면 판정하지 않는다.
 *   · 골격(`snap.initial`) — 첫 병합 전이라 상태와 무관하게 인벤토리가 없다(상태가 위 넷이 아니면 'initial').
 *   연결된(connected) vCenter 가 정말 비어 있으면 **판정한다** — 읽은 결과다.
 * @returns {Map<string, 'disabled'|'pending'|'unreachable'|'maintenance'|'initial'>}
 */
export function inventoryUnreadReasons(snap) {
  const out = new Map();
  const hasInv = new Set();
  for (const h of snap?.hosts || []) if (h && h.vcenterId != null) hasInv.add(String(h.vcenterId));
  for (const v of snap?.vms || []) if (v && v.vcenterId != null) hasInv.add(String(v.vcenterId));
  for (const vc of snap?.vcenters || []) {
    if (!vc || vc.id == null) continue;
    const id = String(vc.id);
    const st = vc.status === 'maintenance' || vc.maintenance === true ? 'maintenance' : String(vc.status || '');
    let reason = null;
    if (st === 'disabled' || st === 'pending') reason = st;
    else if ((st === 'unreachable' || st === 'maintenance') && !hasInv.has(id)) reason = st;
    else if (snap?.initial === true && !hasInv.has(id)) reason = 'initial';
    if (reason) out.set(id, reason);
  }
  return out;
}

export function registerVmSeries(api) {

api.get('/tools/vmseries/settings', requirePerm('tools'), (req, res) => {
  const snap = store.get();
  const allowed = scopedVcenterIds(req.user, snap);
  const s = loadVmSeriesSettings();
  const vcenters = (snap.vcenters || []).filter((v) => !allowed || allowed.has(v.id))
    .map((v) => ({ id: v.id, name: v.name || v.id, collectSource: v.collectSource || 'central', status: v.status || '' }));
  const allowedFiles = allowed ? new Set([...allowed].map((id) => dbFileName(id))) : null;
  const usage = vmSeriesDiskUsage().filter((u) => (!allowedFiles ? true : allowedFiles.has(dbFileName(u.vcenterId))));
  const resolved = summarizeScope(snap, s).filter((r) => !allowed || allowed.has(r.vcenterId));
  const safeTargets = Object.fromEntries(Object.entries(s.targets || {}).filter(([id]) => !allowed || allowed.has(id)));
  res.json({
    settings: { ...s, targets: safeTargets }, ...vmSeriesStaleOf(safeTargets, snap), limits: VMSERIES_LIMITS, vcenters, resolved, usage,
    totalBytes: usage.reduce((a, u) => a + u.bytes, 0), freeBytes: vmSeriesFreeBytes(),
    // ⚠ v2.574 SEC-07 — `status` 도 거른다. 옆 필드들만 거르고 이것을 그대로 두면 우회로가 남는다.
    status: scopeVmSeriesStatus(vmSeriesPollerStatus(), allowed), push: scopeVmSeriesPush(vmSeriesPushStatus(), allowed, req.user), mock: snap.source === 'mock',
  });
});

api.put('/tools/vmseries/settings', requireRole('admin'), (req, res) => {
  const b = req.body || {};
  const snap = store.get();
  const validVc = new Set((snap.vcenters || []).map((v) => v.id));
  const before = loadVmSeriesSettings();
  if (b.targets !== undefined) {
    if (!b.targets || typeof b.targets !== 'object' || Array.isArray(b.targets)) return res.status(400).json({ ok: false, reason: 'targets 는 객체여야 합니다.' });
    // v2.732(B5-02): 유령 id 거부는 **새로 들어온** 모르는 id 만이다. 이미 저장돼 있던 vCenter 키·그 vCenter 아래에 저장돼 있던 호스트·VM id 는
    //   (삭제됐거나 스냅샷에 아직 없어도) 통과·보존하고 staleIds·staleTargets 로 밝힌다. 예전에는 기존 대상 전부를 스냅샷과 대조해 VM 하나만 지워져도
    //   이 설정을 영영 저장할 수 없었다(화면 트리는 스냅샷 VM 만 그려 그 id 를 해제할 수도 없었다). 조용히 걸러 저장하지 않는다.
    const prevT = before.targets && typeof before.targets === 'object' ? before.targets : {};
    const badVc = Object.keys(b.targets).filter((id) => !validVc.has(id) && !Object.hasOwn(prevT, id));
    if (badVc.length) return res.status(400).json({ ok: false, reason: `존재하지 않는 vCenter id: ${badVc.slice(0, 5).join(', ')}` });
    // 유령 id 저장 방지 — 호스트/VM id 는 스냅샷에 실재해야 한다(클러스터·폴더 이름은 문자열이라 형식만).
    const hostIds = new Set((snap.hosts || []).map((h) => h.id)); const vmIds = new Set((snap.vms || []).map((v) => v.id));
    const arr = (v) => (Array.isArray(v) ? v : []);   // 배열이 아니면 저장 정규화(coerceTargets)가 [] 로 읽는다 — 여기서 .filter 로 던지지 않게
    for (const [id, t] of Object.entries(b.targets)) {
      if (!t || typeof t !== 'object') return res.status(400).json({ ok: false, reason: `targets[${id}] 형식 오류` });
      if (t.all === true) continue;
      // '그 vCenter 아래에 이미 저장돼 있던 것' 만 낡은 id 로 통과한다 — 다른 vCenter 키로 옮겨 넣은 id 는 새 id 다.
      const pt = Object.hasOwn(prevT, id) && prevT[id] && !prevT[id].all ? prevT[id] : null;
      const prevH = new Set(arr(pt?.hosts).map(String)); const prevV = new Set(arr(pt?.vms).map(String));
      const badH = arr(t.hosts).filter((x) => !hostIds.has(String(x)) && !prevH.has(String(x)));
      const badV = arr(t.vms).filter((x) => !vmIds.has(String(x)) && !prevV.has(String(x)));
      if (badH.length || badV.length) return res.status(400).json({ ok: false, reason: `스냅샷에 없는 대상: ${[...badH, ...badV].slice(0, 5).join(', ')}` });
    }
  }
  // v2.605 AUTHZ2605-01: 범위 제한 admin 은 GET 이 거른 targets 를 되돌려 보낸다 — 전체로 저장하면 다른
  //   법인이 수집 범위에서 빠졌다. 범위 밖 targets 는 직전 값을 보존하고, 전 법인에 걸친 scope('all'↔
  //   'selected')는 바꾸지 않으며, 범위 밖 DB 는 dropExcluded 로도 지우지 않는다.
  const allowed = scopedVcenterIds(req.user, snap);
  // v2.607 AUTHZ2607-05: 전역 필드(enabled·주기·보존일·임계·scope)는 전 법인 공용 — 범위 계정의 값은 버리고 밝힌다.
  const kg = keepScopedFields(b, before, allowed, ['targets', 'dropExcluded']);
  const patch = kg.patch;
  let ignoredOutOfScope = [];
  if (allowed) {
    if (b.targets !== undefined) { const m = mergeScopedMap(before.targets, b.targets, allowed); patch.targets = m.merged; ignoredOutOfScope = m.ignored; }
    delete patch.scope;
  }
  const next = saveVmSeriesSettings(patch);
  // 선택 범위에서 빠진 vCenter 의 DB 파일 삭제(용량 즉시 회수) — 요청이 명시할 때만(dropExcluded).
  const dropped = [];
  if (b.dropExcluded === true && next.scope === 'selected') {
    const keep = new Set(Object.keys(next.targets).map((id) => dbFileName(id)));
    const allowedFiles = allowed ? new Set([...allowed].map((id) => dbFileName(id))) : null;
    for (const u of vmSeriesDiskUsage()) {
      if (allowedFiles && !allowedFiles.has(dbFileName(u.vcenterId))) continue;   // 범위 밖 DB 는 건드리지 않는다
      if (!keep.has(dbFileName(u.vcenterId))) { dropVmSeriesDb(u.vcenterId); dropped.push(u.vcenterId); }
    }
  }
  logAudit({
    user: req.user?.username, action: 'VM 실시간 스파이크 수집 설정 변경',
    target: next.enabled ? `주기 ${next.intervalMin}분 · 보존 ${next.retentionDays}일 · 범위 ${next.scope === 'selected' ? `${Object.keys(next.targets).length}개 vCenter` : '전체'}` : '비활성',
    detail: `${before.enabled !== next.enabled ? `enabled ${before.enabled}→${next.enabled} · ` : ''}임계 cpu ${next.thresholds.cpuPct}% mem ${next.thresholds.memPct}% ready ${next.thresholds.readyPct}%${dropped.length ? ` · DB 삭제: ${dropped.join(', ')}` : ''}`,
    ip: req.ip || '',
  });
  const safeNext = allowed ? { ...next, targets: filterScopedMap(next.targets, allowed) } : next;
  res.json({ ok: true, settings: safeNext, ...vmSeriesStaleOf(safeNext.targets, snap), dropped, ...(ignoredOutOfScope.length ? { ignoredOutOfScope: ignoredOutOfScope.length } : {}), ...ignoredGlobalFields(kg.ignoredGlobal) });
});

/** 범위 선택 트리 데이터 — 한 vCenter 의 클러스터/호스트/폴더/VM(전원 상태 포함, 꺼진 VM 은 표시만). */
api.get('/tools/vmseries/scope-data', requirePerm('tools'), (req, res) => {
  const snap = store.get();
  const vcId = String(req.query.vcenterId || '');
  if (!vcId || !inUserScope(req.user, snap, vcId) || !(snap.vcenters || []).some((v) => v.id === vcId)) return res.status(404).json({ ok: false, reason: 'not found' });
  const hosts = (snap.hosts || []).filter((h) => h.vcenterId === vcId).map((h) => ({ id: h.id, name: h.name, cluster: h.cluster || 'standalone', state: h.connectionState }));
  const vms = (snap.vms || []).filter((v) => v.vcenterId === vcId && !v.template).map((v) => ({ id: v.id, name: v.name, folder: normFolder(v.folder), host: v.host, cluster: v.cluster || '', on: v.powerState === 'POWERED_ON', vcpu: v.cpuCount || 0, memMB: v.memMB || 0 }));
  const clusters = [...new Set(hosts.map((h) => h.cluster))].sort();
  res.json({ vcenterId: vcId, clusters, hosts, vms });
});

// ⚠ v2.574 SEC-07 — 예전 시그니처는 `(_req, res)` 였다(사용자를 보지 않는다는 뜻). `lastResult` 의
//   `errors[].vcenterId`·`skipped[].vcenterId` 로 범위 밖 vCenter id 와 실패 메시지가 나갔다.
api.get('/tools/vmseries/status', requirePerm('tools'), (req, res) => {
  const allowed = scopedVcenterIds(req.user, store.get());
  res.json({ ok: true, ...scopeVmSeriesStatus(vmSeriesPollerStatus(), allowed), push: scopeVmSeriesPush(vmSeriesPushStatus(), allowed, req.user) });
});

api.post('/tools/vmseries/run', requireRole('admin'), async (req, res) => {
  // v2.606 AUTHZ2606-05: 전 법인 vCenter 에 접속하고 lastResult 전체(범위 밖 오류 원문)를 돌려준다 — 형제 guest-disk/run 과 같은 규약.
  if (denyScopedRun(req, res, 'VM 실시간 스파이크 수동 수집')) return;
  logAudit({ user: req.user?.username, action: 'VM 실시간 스파이크 수동 수집', ip: req.ip || '' });
  res.json(await runVmSeriesNow('manual'));
});

/** 리포트 로컬 섹션 — VM 1대. 산정에는 쓰지 않는다(표시 전용). */
api.get('/tools/vmseries/local', requirePerm('tools'), async (req, res) => {
  const vmId = String(req.query.vmId || '');
  const days = [7, 30, 90, 180, 365].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
  const snap = store.get();
  const vm = (snap.vms || []).find((v) => v.id === vmId);
  if (!vm || !inUserScope(req.user, snap, vm.vcenterId)) return res.status(404).json({ ok: false, reason: 'VM 을 찾을 수 없습니다.' });
  const s = loadVmSeriesSettings();
  if (snap.source === 'mock') return res.json({ ok: true, ...mockLocalReport(vm, days, s.thresholds), synthesized: true });
  const r = await localReportFor({ vcenterId: vm.vcenterId, kind: 'vm', ref: morefOf(vm.id, vm.vcenterId), days, thresholds: s.thresholds, vcpu: Number(vm.cpuCount) || 0 });
  const vcMeta = await vmSeriesMeta(vm.vcenterId, 'vcenter');
  res.json({ ok: true, ...r, settings: { enabled: s.enabled, intervalMin: s.intervalMin, retentionDays: s.retentionDays }, lastPollAt: vcMeta?.lastPollAt || null, synthesized: false });
});

/** 전 VM 스파이크 순위(창 안 스파이크 순간 수 순). */
api.get('/tools/vmseries/top', requirePerm('tools'), (req, res) => memoJson(req, res, 'vmseries-top', async (snap) => {
  const allowed = scopedVcenterIds(req.user, snap);
  const days = Math.max(1, Math.min(60, Number(req.query.days) || 7));
  const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
  let vcIds = (snap.vcenters || []).map((v) => v.id).filter((id) => !allowed || allowed.has(id));
  if (req.query.vcenterId) vcIds = vcIds.filter((id) => id === String(req.query.vcenterId));
  const byId = new Map((snap.vms || []).map((v) => [v.id, v]));
  const byHost = new Map((snap.hosts || []).map((h) => [h.id, h]));
  const items = []; const missingDb = [];
  for (const vcId of vcIds) {
    const rows = await topSpikers(vcId, days, limit);
    if (rows == null) { missingDb.push(vcId); continue; }
    for (const r of rows) {
      const ent = r.kind === 'vm' ? byId.get(`${vcId}:${r.ref}`) : byHost.get(`${vcId}:${r.ref}`);
      items.push({ vcenterId: vcId, kind: r.kind, id: `${vcId}:${r.ref}`, name: ent?.name || r.ref, cluster: ent?.cluster || '', host: r.kind === 'vm' ? (ent?.host || '') : '', moments: r.moments, rows: r.rows, mxcpuPct: r.mxcpuPct, mxmemPct: r.mxmemPct, firstT: r.firstT, lastT: r.lastT, present: !!ent });
    }
  }
  items.sort((a, b) => b.moments - a.moments);
  const s = loadVmSeriesSettings();
  return { days, limit, items: items.slice(0, limit), total: items.length, missingDb, thresholds: s.thresholds, enabled: demoOn(s.enabled), intervalSec: 20, synthesized: snap.source === 'mock', ...(isMockMode() ? { demo: true } : {}) };
}, { ttlMs: 60_000, extraKey: `${scopeKey(req.user, store.get())}|${req.query.vcenterId || ''}|${req.query.days || ''}|${req.query.limit || ''}` }));

api.delete('/tools/vmseries/data', requireRole('admin'), async (req, res) => {
  if (req.query.vcenterId === undefined) return res.status(400).json({ ok: false, reason: 'vcenterId 를 명시하세요.' });
  const vcId = String(req.query.vcenterId);
  // v2.606 AUTHZ2606-04: 형제 DELETE /tools/waste/settings/data(v2.605)와 같은 가드 — 범위 제한 admin 은 범위 밖 vCenter 의
  //   스파이크 DB 를 지울 수 없다(되돌릴 수 없는 삭제).
  const allowedDel = scopedVcenterIds(req.user, store.get());
  if (allowedDel && !allowedDel.has(vcId)) {
    return res.status(403).json({ ok: false, requiredOwner: true, reason: '범위 밖 vCenter 의 데이터는 전체 범위 계정만 지울 수 있습니다.' });
  }
  const stats = await vmSeriesDbStats(vcId);
  const removed = dropVmSeriesDb(vcId);
  logAudit({ user: req.user?.username, action: 'VM 실시간 스파이크 데이터 삭제', target: vcId, detail: `파일 ${removed}개 · 행 ${stats?.spikeRows ?? '?'}`, ip: req.ip || '' });
  res.json({ ok: true, vcenterId: vcId, filesRemoved: removed });
});

}
