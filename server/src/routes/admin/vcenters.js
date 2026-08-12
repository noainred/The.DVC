// 데이터 소스·vCenter CRUD/테스트/순서 — admin.js(구 2,410줄) 분할(v2.285.0). 본문은 원본 그대로, 등록 순서는 admin.js 호출 순서가 보존한다.
import { config } from '../../config.js';
import { store } from '../../store.js';
import { getDataSource, setDataSource, isDataSourceOverridden } from '../../runtime-settings.js';
import { listRegistry, addVcenter, updateVcenter, removeVcenter, testConnection } from '../../vcenter/registry.js';
import { getOrder, saveOrder, sortByOrder } from '../../vcenter/order.js';
import { probeRelayPath } from '../../vcenter/relayProbe.js';
import { adminOnly } from './shared.js';

export function registerVcenters(adminRouter) {

// Read the effective data source (UI override or env default).
adminRouter.get('/data-source', adminOnly, (_req, res) => {
  res.json({ dataSource: getDataSource(), envDefault: config.dataSource, overridden: isDataSourceOverridden() });
});

// Switch the data source at runtime (mock | live | auto) and re-poll.
adminRouter.put('/data-source', adminOnly, async (req, res) => {
  const result = setDataSource((req.body || {}).dataSource);
  if (!result.ok) return res.status(400).json(result);
  await store.refresh().catch(() => {});
  res.json({ ...result, overridden: isDataSourceOverridden() });
});

// List registered vCenters (credentials redacted) + current data-source mode.
adminRouter.get('/vcenters', adminOnly, (_req, res) => {
  res.json({ dataSource: getDataSource(), vcenters: sortByOrder(listRegistry()) }); // 저장된 표시 순서 적용
});

// Register a new vCenter, then trigger a re-poll.
adminRouter.post('/vcenters', adminOnly, async (req, res) => {
  const result = addVcenter(req.body || {});
  if (result.ok) store.refresh().catch(() => {});
  res.status(result.ok ? 201 : 400).json(result);
});

// Update an existing vCenter (omit password to keep it), then re-poll.
adminRouter.put('/vcenters/:id', adminOnly, async (req, res) => {
  const result = updateVcenter(req.params.id, req.body || {});
  if (result.ok) store.refresh().catch(() => {});
  res.status(result.ok ? 200 : 400).json(result);
});

// Remove a vCenter, then re-poll.
adminRouter.delete('/vcenters/:id', adminOnly, async (req, res) => {
  const result = removeVcenter(req.params.id);
  if (result.ok) store.refresh().catch(() => {});
  res.status(result.ok ? 200 : 404).json(result);
});

// Test connectivity to a vCenter (new entry or a saved one by id).
adminRouter.post('/vcenters/test', adminOnly, async (req, res) => {
  res.json(await testConnection(req.body || {}));
});

// 등록된 모든 vCenter 연결을 병렬로 한 번에 테스트(느린 1곳이 전체를 막지 않게 per-vCenter 독립).
// ?only=enabled 면 '수집 사용'인 것만. 실패 시 중계 경로(TCP·TLS·HTTP) 단계 진단을 자동 첨부해
// 'TCP부터 안 됨(경로/방화벽)' vs 'TCP는 되는데 TLS만 막힘(HAProxy backend 끊김)'을 바로 구분.
adminRouter.post('/vcenters/test-all', adminOnly, async (req, res) => {
  const onlyEnabled = String(req.query.only || (req.body || {}).only || '') === 'enabled';
  const withRelay = String(req.query.relay || (req.body || {}).relay || 'true') !== 'false';
  let list = sortByOrder(listRegistry());
  if (onlyEnabled) list = list.filter((v) => v.enabled !== false);
  const results = await Promise.all(list.map(async (vc) => {
    const r = await testConnection({ id: vc.id }).catch((e) => ({ ok: false, reason: e.message }));
    const base = { id: vc.id, name: vc.name, host: vc.host, enabled: vc.enabled !== false, collectMode: vc.collectMode || 'direct', ...r };
    // 실패 시에만 경로 진단(짧은 6s 단계 타임아웃, 병렬) — 어디서 막혔는지 즉시 노출.
    if (!r.ok && withRelay) base.relay = await probeRelayPath(vc.host, { timeoutMs: 6000 }).catch(() => null);
    return base;
  }));
  res.json({ ok: true, testedAt: Date.now(), total: results.length, okCount: results.filter((r) => r.ok).length, results });
});

// vCenter display order (applies to every "vCenter 선택" list in the web).
adminRouter.get('/vcenter-order', adminOnly, (_req, res) => {
  const order = getOrder();
  const rank = new Map(order.map((id, i) => [id, i]));
  // Return all registered vCenters in saved order; unsaved ones appended.
  const list = listRegistry().map((v) => ({ id: v.id, name: v.name, region: v.location?.region || '' }));
  list.sort((a, b) => (rank.has(a.id) ? rank.get(a.id) : 1e9) - (rank.has(b.id) ? rank.get(b.id) : 1e9));
  res.json({ order, vcenters: list });
});
adminRouter.put('/vcenter-order', adminOnly, (req, res) => {
  res.json({ ok: true, order: saveOrder((req.body || {}).order) });
});
}
