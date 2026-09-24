// 데이터 소스·vCenter CRUD/테스트/순서 — admin.js(구 2,410줄) 분할(v2.285.0). 본문은 원본 그대로, 등록 순서는 admin.js 호출 순서가 보존한다.
import { config, loadVcenterConfig } from '../../config.js';
import { vcAuthGuard } from '../../vcenter/restClient.js';
import { store } from '../../store.js';
import { getDataSource, setDataSource, isDataSourceOverridden } from '../../runtime-settings.js';
import { listRegistry, addVcenter, updateVcenter, removeVcenter, testConnection } from '../../vcenter/registry.js';
import { getOrder, saveOrder, sortByOrder } from '../../vcenter/order.js';
import { probeRelayPath } from '../../vcenter/relayProbe.js';
import { adminOnly, fullScopeOnlyWith } from './shared.js';
import { scopedVcenterIds, writeScopedVcenterIds } from '../../auth/scope.js';

/*
 * v2.607 AUTHZ2607-03 — vCenter 등록부는 법인 축이 있다. 예전에는 adminOnly 뿐이라 범위 제한 admin 이 범위 밖
 * vCenter 의 관리 주소·계정명을 보고, 수정(collectMode·enabled)·삭제(그 법인 수집 중단)할 수 있었다.
 *   · 목록·순서·전체 테스트는 범위 안만(뺀 개수는 omittedOutOfScope).
 *   · 수정·삭제·단건 테스트는 범위 밖이면 404(존재 은닉), 조회만 되고 쓰기 범위 밖이면 403.
 *   · 새 등록·데이터 소스 전환·표시 순서 저장은 전 법인에 걸친 동작이라 범위 계정 403.
 */
const fleetWideOnly = fullScopeOnlyWith('vCenter 등록·데이터 소스 전환·표시 순서는 전 법인에 걸친 설정이라 전체 범위(vCenter 제한 없는) 계정만 바꿀 수 있습니다.');
/** 대상 vCenter 가 범위 밖이면 응답하고 true. */
function denyVcOutOfScope(req, res, id) {
  const snap = store.get();
  const read = scopedVcenterIds(req.user, snap);
  if (!read) return false;
  if (!read.has(String(id))) { res.status(404).json({ ok: false, reason: 'vCenter 를 찾을 수 없습니다.' }); return true; }
  const write = writeScopedVcenterIds(req.user, snap);
  if (write && !write.has(String(id))) { res.status(403).json({ ok: false, error: 'forbidden', reason: '조회 전용 범위 — 이 vCenter 는 수정 권한이 없습니다.' }); return true; }
  return false;
}

export function registerVcenters(adminRouter) {

// Read the effective data source (UI override or env default).
adminRouter.get('/data-source', adminOnly, (_req, res) => {
  res.json({ dataSource: getDataSource(), envDefault: config.dataSource, overridden: isDataSourceOverridden() });
});

// Switch the data source at runtime (mock | live | auto) and re-poll.
adminRouter.put('/data-source', adminOnly, fleetWideOnly, async (req, res) => {
  const result = setDataSource((req.body || {}).dataSource);
  if (!result.ok) return res.status(400).json(result);
  await store.refresh().catch(() => {});
  res.json({ ...result, overridden: isDataSourceOverridden() });
});

// List registered vCenters (credentials redacted) + current data-source mode.
adminRouter.get('/vcenters', adminOnly, (req, res) => {
  // v2.590(감사 F1): 인증 실패로 **주기 수집을 멈춘** vCenter 를 목록이 말하게 정지 기록을 싣는다.
  // 판정에는 복호된 자격증명이 필요하다(credHash — 비밀번호를 고쳤으면 스스로 해제된다). 응답에는
  // 해시·비밀번호를 싣지 않는다(시각·횟수·사유만).
  let full = new Map();
  try { full = new Map((loadVcenterConfig().vcenters || []).map((v) => [v.id, v])); } catch { /* 목록은 그대로 */ }
  const withStop = (v) => {
    const rec = full.has(v.id) ? vcAuthGuard.authStopFor(full.get(v.id)) : null;
    return rec ? { ...v, authStopped: { since: rec.since, at: rec.at, attempts: rec.attempts, reason: rec.reason } } : v;
  };
  const all = sortByOrder(listRegistry());
  const allowed = scopedVcenterIds(req.user, store.get());
  if (!allowed) return res.json({ dataSource: getDataSource(), vcenters: all.map(withStop) }); // 저장된 표시 순서 적용
  const mine = all.filter((v) => allowed.has(v.id));
  res.json({ dataSource: getDataSource(), vcenters: mine.map(withStop), scoped: true, omittedOutOfScope: all.length - mine.length });
});

// Register a new vCenter, then trigger a re-poll.
adminRouter.post('/vcenters', adminOnly, fleetWideOnly, async (req, res) => {
  const result = addVcenter(req.body || {});
  if (result.ok) store.refresh().catch(() => {});
  res.status(result.ok ? 201 : 400).json(result);
});

// Update an existing vCenter (omit password to keep it), then re-poll.
adminRouter.put('/vcenters/:id', adminOnly, async (req, res) => {
  if (denyVcOutOfScope(req, res, req.params.id)) return;
  const result = updateVcenter(req.params.id, req.body || {});
  if (result.ok) store.refresh().catch(() => {});
  res.status(result.ok ? 200 : 400).json(result);
});

// Remove a vCenter, then re-poll.
adminRouter.delete('/vcenters/:id', adminOnly, async (req, res) => {
  if (denyVcOutOfScope(req, res, req.params.id)) return;
  const result = removeVcenter(req.params.id);
  if (result.ok) store.refresh().catch(() => {});
  res.status(result.ok ? 200 : 404).json(result);
});

// Test connectivity to a vCenter (new entry or a saved one by id).
adminRouter.post('/vcenters/test', adminOnly, async (req, res) => {
  // v2.607: 범위 계정은 저장된 범위 안 vCenter 만 시험한다(새 항목 시험은 등록과 같은 전 법인 동작 — 403).
  if (scopedVcenterIds(req.user, store.get())) {
    const id = String((req.body || {}).id || '');
    if (!id) return res.status(403).json({ ok: false, error: 'forbidden', reason: '새 vCenter 연결 테스트는 전체 범위(vCenter 제한 없는) 계정만 할 수 있습니다.' });
    const read = scopedVcenterIds(req.user, store.get());
    if (!read.has(id)) return res.status(404).json({ ok: false, reason: 'vCenter 를 찾을 수 없습니다.' });
  }
  res.json(await testConnection(req.body || {}));
});

// 등록된 모든 vCenter 연결을 병렬로 한 번에 테스트(느린 1곳이 전체를 막지 않게 per-vCenter 독립).
// ?only=enabled 면 '수집 사용'인 것만. 실패 시 중계 경로(TCP·TLS·HTTP) 단계 진단을 자동 첨부해
// 'TCP부터 안 됨(경로/방화벽)' vs 'TCP는 되는데 TLS만 막힘(HAProxy backend 끊김)'을 바로 구분.
adminRouter.post('/vcenters/test-all', adminOnly, async (req, res) => {
  const onlyEnabled = String(req.query.only || (req.body || {}).only || '') === 'enabled';
  const withRelay = String(req.query.relay || (req.body || {}).relay || 'true') !== 'false';
  let list = sortByOrder(listRegistry());
  const allowedAll = scopedVcenterIds(req.user, store.get());
  const totalRegistered = list.length;
  if (allowedAll) list = list.filter((v) => allowedAll.has(v.id));   // v2.607: 범위 안만
  const omittedOutOfScope = totalRegistered - list.length;
  if (onlyEnabled) list = list.filter((v) => v.enabled !== false);
  const results = await Promise.all(list.map(async (vc) => {
    const r = await testConnection({ id: vc.id }).catch((e) => ({ ok: false, reason: e.message }));
    const base = { id: vc.id, name: vc.name, host: vc.host, enabled: vc.enabled !== false, collectMode: vc.collectMode || 'direct', ...r };
    // 실패 시에만 경로 진단(짧은 6s 단계 타임아웃, 병렬) — 어디서 막혔는지 즉시 노출.
    if (!r.ok && withRelay) base.relay = await probeRelayPath(vc.host, { timeoutMs: 6000 }).catch(() => null);
    return base;
  }));
  res.json({ ok: true, testedAt: Date.now(), total: results.length, okCount: results.filter((r) => r.ok).length, results, ...(allowedAll ? { scoped: true, omittedOutOfScope } : {}) });
});

// vCenter display order (applies to every "vCenter 선택" list in the web).
adminRouter.get('/vcenter-order', adminOnly, (req, res) => {
  const allowed = scopedVcenterIds(req.user, store.get());
  const order = allowed ? getOrder().filter((id) => allowed.has(id)) : getOrder();
  const rank = new Map(order.map((id, i) => [id, i]));
  // Return all registered vCenters in saved order; unsaved ones appended.
  const list = listRegistry().filter((v) => !allowed || allowed.has(v.id)).map((v) => ({ id: v.id, name: v.name, region: v.location?.region || '' }));
  list.sort((a, b) => (rank.has(a.id) ? rank.get(a.id) : 1e9) - (rank.has(b.id) ? rank.get(b.id) : 1e9));
  res.json({ order, vcenters: list });
});
adminRouter.put('/vcenter-order', adminOnly, fleetWideOnly, (req, res) => {
  res.json({ ok: true, order: saveOrder((req.body || {}).order) });
});
}
