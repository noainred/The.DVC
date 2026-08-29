// ìì§ê¸° CRUD/ì´ìÂ·ë°ì´í°ì¼í°Â·VM ì¬êµ¬ì± â admin.js(êµ¬ 2,410ì¤) ë¶í (v2.285.0). ë³¸ë¬¸ì ìë³¸ ê·¸ëë¡, ë±ë¡ ììë admin.js í¸ì¶ ììê° ë³´ì¡´íë¤.
import { config } from '../../config.js';
import { requirePerm, setLocalPassword } from '../../auth/auth.js';
import { inUserScope, inUserWriteScope } from '../../auth/scope.js';
import { store } from '../../store.js';
import { forceCollectorToken } from '../../agent/deploy.js';
import { listTargets, getTargetRaw } from '../../agent/deployRegistry.js';
import { logAudit } from '../../audit.js';
import { loadVcenterConfig } from '../../config.js';
import { getVmHardware, reconfigVm } from '../../provision/reconfig.js';
import { listCollectors, addCollector, updateCollector, removeCollector, loadCollectors, ssrfBlockReason, collectorInputIssue } from '../../collector/registry.js';
import { collectorsToCsv, sampleCsv as collectorsSampleCsv, parseCollectorsCsv, analyzeCollectorsImport } from '../../collector/csv.js';
import { clearCollectorServers } from '../../collector/remoteInventory.js';
import { listDatacenters, getDatacenterAssign, addDatacenter, updateDatacenter, removeDatacenter, setVcenterDatacenterMany, getDatacenterOrder, saveDatacenterOrder } from '../../datacenter/store.js';
import { allCollectorStatus, clearCollectorHosts } from '../../collector/state.js';
import { pullNow } from '../../collector/puller.js';
import { pushUpgradeToCollectors } from '../../collector/upgradePush.js';
import { resilientFetch } from '../../util/resilientFetch.js';
import { resolveBundleBytes, lastBundleReject } from '../../upgrade/bundleSource.js';
import { upgradeManager } from '../../upgrade/manager.js';
import { adminOnly, ensureCollectorDatacenter, requireSettingsOwner } from './shared.js';


// ââ VM ì¬ì ë³ê²½(ReconfigVM) â vCPU/RAM/ëì¤í¬ ì¦ì¤Â·ì¶ê°, NIC ì¶ê°/ì­ì  (ê´ë¦¬ì) ââââââââââ
// vmId íì '<vcId>:<moref>'. ì¤ëì·ì¼ë¡ VM ì¡´ì¬Â·vCenter ìê²©ì¦ëªì íì¸í ë¤ SOAP ì¤í.
function resolveVmTarget(vmId) {
  const snap = store.get();
  const vm = (snap.vms || []).find((v) => v.id === vmId);
  if (!vm) return { error: 'VMì ì°¾ì ì ììµëë¤(íì¬ ì¤ëì·ì ìì â í´ë¹ vCenter ì°ê²°ì´ ëê²¼ê±°ë í´ë§ ì ì¼ ì ììµëë¤).', code: 404 };
  if (snap.source === 'mock') return { error: 'ë°ëª¨(mock) ëª¨ëììë ì¬ì ë³ê²½ì ì¬ì©í  ì ììµëë¤.', code: 400 };
  const sep = String(vmId).indexOf(':');
  const vcId = sep >= 0 ? vmId.slice(0, sep) : vmId;
  const moref = sep >= 0 ? vmId.slice(sep + 1) : '';
  const vc = (loadVcenterConfig().vcenters || []).find((v) => v.id === vcId);
  // vCenterê° ì´ í¬íì ì§ì  ë±ë¡ë¼ ìì§ ìì¼ë©´(ìì/ì£ì§ ìì§ vCenter) ìê²©ì¦ëªì´ ìì´ ì¬ì ë³ê²½ ë¶ê°.
  if (!vc) return { error: `ì´ VMì vCenter('${vcId}')ê° ì´ í¬íì ë±ë¡ëì´ ìì§ ìì ì¬ì ë³ê²½ì í  ì ììµëë¤(ìì/ì£ì§ ìì§ vCenter). í´ë¹ vCenterê° ì§ì  ë±ë¡ë í¬íìì ë³ê²½íì¸ì.`, code: 400 };
  return { vm, vc, moref, snap };
}

/**
 * VM 단건 라우트의 데이터 범위 가드(v2.389) — 형제 라우트(vms/:id/console, VM 복제,
 * Tools 업그레이드, 프로비저닝)와 동일한 2단계 규약을 적용한다.
 *
 *  1) 조회 범위 밖  → 404 (존재 은닉. 범위 밖 VM 의 실재 여부를 알려주지 않는다)
 *  2) 조회는 되지만 쓰기 범위 밖 → 403 (존재는 이미 보이므로 은닉 불필요)
 *
 * 배경: /vm/:id/reconfig 는 vCPU·메모리 증설과 디스크/NIC 추가·삭제를 실제로 수행하는
 * 상태변경인데 requirePerm('vm.reconfig') 만 걸려 있었다. vm.reconfig 는 권한 카탈로그에
 * 있어 operator/viewer 에게 위임할 수 있으므로(기본 매트릭스는 admin 전용), 위임한 배포에서는
 * 범위 제한 계정이 범위 밖 vCenter 의 VM 을 재구성할 수 있었다. GET /vm/:id/hardware 도
 * 같은 권한만 요구해 범위 밖 VM 의 하드웨어·네트워크·데이터스토어 구성이 노출됐다.
 *
 * @param {boolean} write true 면 쓰기 범위까지 검사(POST reconfig), false 면 조회 범위만(GET).
 * @returns {null | { code, error }} null = 통과.
 */
function vmScopeDenied(req, vm, write) {
  const snap = store.get();
  if (!inUserScope(req.user, snap, vm.vcenterId)) {
    return { code: 404, error: 'VM 을 찾을 수 없습니다.' };
  }
  if (write && !inUserWriteScope(req.user, snap, vm.vcenterId)) {
    return { code: 403, error: '조회 전용 범위 — 이 vCenter 의 VM 사양을 변경할 수 없습니다.' };
  }
  return null;
}

export function registerCollectorsDc(adminRouter) {

// ---- Distributed collection: remote collector agents ----------------------

// List registered collectors (tokens redacted) + live pull status.
adminRouter.get('/collectors', adminOnly, (_req, res) => {
  res.json({ collectors: listCollectors(), status: allCollectorStatus() });
});

adminRouter.post('/collectors', adminOnly, (req, res) => {
  // ê´ë¦¬ì UI ë±ë¡ = ìë ê³ ì (managed) â ì£ì§ ìê¸°ë±ë¡ì´ URL/í í°ì ë®ì´ì°ì§ ëª»íê².
  const result = addCollector(req.body || {}, { managed: true });
  if (result.ok) { ensureCollectorDatacenter(result.collector); pullNow().catch(() => {}); logAudit({ user: req.user?.username, action: 'ìì§ ìë² ë±ë¡', target: result.collector?.id || '', detail: `url=${result.collector?.url || ''} vcenterId=${result.collector?.vcenterId || ''}`, ip: req.ip || '' }); }
  res.status(result.ok ? 201 : 400).json(result);
});

adminRouter.put('/collectors/:id', adminOnly, (req, res) => {
  // ê´ë¦¬ì UI ìì  = ìë ê³ ì (managed) â ì ì¥í URL/í í°ì´ ìê¸°ë±ë¡ì¼ë¡ ìë³µëë ë²ê·¸ ë°©ì§.
  const result = updateCollector(req.params.id, req.body || {}, { managed: true });
  if (result.ok) {
    ensureCollectorDatacenter(result.collector);
    // ë¹íì±í ì ê·¸ ìì§ê¸°ì ìê²© ë°ì´í°ë ì¦ì ê±·ì´ë¸ë¤ â íë¬ë disabledë¥¼ ê±´ëë°ë¯ë¡
    // ë¨ê²¨ëë©´ ìë² ë¶ì/ì ë ¥ íë©´ì ì ë ¹ ìë²ê° ì¬ìì ì ê¹ì§ ê³ì íìëë¤.
    if (result.collector?.enabled === false) { clearCollectorHosts(req.params.id); clearCollectorServers(req.params.id); }
    pullNow().catch(() => {});
    logAudit({ user: req.user?.username, action: 'ìì§ ìë² ìì ', target: req.params.id, detail: `url=${result.collector?.url || ''} vcenterId=${result.collector?.vcenterId || ''}`, ip: req.ip || '' });
  }
  res.status(result.ok ? 200 : 400).json(result);
});

adminRouter.delete('/collectors/:id', adminOnly, (req, res) => {
  const result = removeCollector(req.params.id);
  if (result.ok) {
    clearCollectorHosts(req.params.id);   // ìê²© ì ë ¥ ë³í© ìí ì ê±°
    clearCollectorServers(req.params.id); // ìë² ë¶ìì© ìê²© ì¸ë²¤í ë¦¬ ì ê±°(ì ë ¹ ìë² ë°©ì§)
    logAudit({ user: req.user?.username, action: 'ìì§ ìë² ì­ì ', target: req.params.id, ip: req.ip || '' });
  }
  res.status(result.ok ? 200 : 404).json(result);
});

/* ââ ìì§ ìë² CSV ì¼ê´ ê´ë¦¬(v2.338, ì¬ì©ì ìêµ¬) â ë´ë³´ë´ê¸°Â·ìíÂ·ê°ì ¸ì¤ê¸°. âââââââââââââââ
 * ì¤í ë¦¬ì§ ì¥ë¹ CSV(v2.313Â·2.317)ì ëì¼ ê³¨ê²©: ê¸°ë³¸ export ë í í° ì ì¸, ?tokens=1 ì
 * requireSettingsOwner ê²ì´í¸(ìê²©ì¦ëª ë¤í â ë°±ì ë¼ì°í¸ì ê°ì ê·ì¹) + ê°ì¬ë¡ê·¸.
 * ê°ì ¸ì¤ê¸°ë dryRun(ë¬¸ë²Â·ì¤ë³µÂ·SSRF ê²ì¦, ì ì¥ ìì) â ì»¤ë° 2ë¨ê³ì´ê³ , ê¸°ì¡´ id ì ê²¹ì¹ë
 * í(ë®ì´ì°ê¸°)ì body.overwrite=true ë¥¼ ëªìí´ì¼ë§ ì ì©ëë¤(ì¬ì©ì ìêµ¬ 'overwrite ì¬ë¶ íì¸').
 */

// íì¬ ë±ë¡ ìì§ ìë²ë¥¼ CSV ë¡ ë´ë³´ë´ê¸°. ê¸°ë³¸ì í í° ì ì¸(listCollectors redact ê³ì½).
adminRouter.get('/collectors/export.csv', adminOnly, (req, res) => {
  const withTok = String(req.query.tokens || '') === '1';
  const send = () => {
    const list = loadCollectors();
    const csv = collectorsToCsv(list, { includeTokens: withTok });
    logAudit({ user: req.user?.username, action: withTok ? 'ìì§ ìë² CSV ë´ë³´ë´ê¸°(í í° í¬í¨)' : 'ìì§ ìë² CSV ë´ë³´ë´ê¸°', detail: `${list.length}ë`, ip: req.ip || '' });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="collectors${withTok ? '-with-tokens' : ''}.csv"`);
    res.send(csv);
  };
  if (withTok) return requireSettingsOwner(req, res, send);
  send();
});

/** ìí CSV ííë¦¿ ë¤ì´ë¡ë â í¤ë + ì»¬ë¼ ì¤ëª ì£¼ì + ìì 2í. */
adminRouter.get('/collectors/sample.csv', adminOnly, (_req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="collectors-sample.csv"');
  res.send(collectorsSampleCsv());
});

/**
 * CSV ì¼ê´ ê°ì ¸ì¤ê¸° â body { csv, dryRun?, overwrite? }.
 *  - dryRun=true: ì ì¥íì§ ìê³  íë³ íì (add/overwrite/error + ì¬ì )ë§ ë°í. ê²ì¦ ê·ì¹ì
 *    ì¤ì  ì ì¥ê³¼ ëì¼(registry.collectorInputIssue â normalize ë¨ì¼ ìì¤, SSRF/URL í¬í¨).
 *  - ì»¤ë°: add íì ë±ë¡, overwrite íì **overwrite=true ì¼ ëë§** ê°±ì (ìëë©´ skipped ë¡
 *    ë³´ê³  â ê¸°ì¡´ URL/í í°/ë§¤íì ì¤ìë¡ ê°ììë ì¬ê³  ë°©ì§). íë³ ì±ê³µ/ì¤í¨ ì ì§ ë°í.
 *  - ê°ì ¸ì¨ í­ëª©ì ê´ë¦¬ì ìë ë±ë¡ê³¼ ëì¼íê² managed=true(ìê¸°ë±ë¡ì´ ëª» ë®ì´ì).
 */
adminRouter.post('/collectors/import', adminOnly, (req, res) => {
  const { rows, error } = parseCollectorsCsv(String(req.body?.csv || ''));
  if (error) return res.status(400).json({ ok: false, reason: error });
  if (!rows.length) return res.status(400).json({ ok: false, reason: 'ê°ì ¸ì¬ ë°ì´í° íì´ ììµëë¤.' });

  // ëìë¬¸ì ë¬´ì id ì¡°í â ê¸°ì¡´ í­ëª©ì ì¤ì  id(registry dedupe ê·ì¹ê³¼ ëì¼ í¤).
  const existing = new Map(loadCollectors().map((c) => [String(c.id).toLowerCase(), c.id]));
  const existingId = (id) => existing.get(String(id).toLowerCase());

  const { report, summary } = analyzeCollectorsImport(rows, { existingId, validate: collectorInputIssue });
  if (req.body?.dryRun) {
    return res.json({ ok: true, dryRun: true, report, summary, total: rows.length });
  }

  const allowOverwrite = req.body?.overwrite === true;
  let added = 0, overwritten = 0; const failed = []; const skipped = [];
  const verdictByLine = new Map(report.map((r) => [r.line, r])); // O(rows²) find → O(rows) (v2.342 성능)
  for (const row of rows) {
    const verdict = verdictByLine.get(row._line);
    if (verdict?.action === 'error') { failed.push({ line: verdict.line, id: verdict.id, reason: verdict.reason }); continue; }
    const input = { id: row.id, name: row.name, url: row.url, datacenter: row.datacenter,
      vcenterId: row.vcenterId, enabled: row.enabled };
    if (row._hasToken) input.token = row.token; // ë¹ì°ë©´ ê¸°ì¡´ ì ì§(normalize ê·ì¹)
    const curId = existingId(row.id);
    if (curId) {
      if (!allowOverwrite) { skipped.push({ line: row._line, id: row.id, reason: 'ê¸°ì¡´ í­ëª© â ë®ì´ì°ê¸° ë¯¸íì©(overwrite íì¸ íì)' }); continue; }
      const r = updateCollector(curId, input, { managed: true });
      if (r.ok) { overwritten++; ensureCollectorDatacenter(r.collector); }
      else failed.push({ line: row._line, id: row.id, reason: r.reason });
    } else {
      const r = addCollector(input, { managed: true });
      if (r.ok) { added++; ensureCollectorDatacenter(r.collector); existing.set(row.id.toLowerCase(), row.id); }
      else failed.push({ line: row._line, id: row.id, reason: r.reason });
    }
  }
  if (added || overwritten) pullNow().catch(() => {});
  logAudit({ user: req.user?.username, action: 'ìì§ ìë² CSV ê°ì ¸ì¤ê¸°', detail: `ì¶ê° ${added}Â·ë®ì´ì°ê¸° ${overwritten}Â·ê±´ëë ${skipped.length}Â·ì¤í¨ ${failed.length}`, ip: req.ip || '' });
  res.json({ ok: true, added, overwritten, skipped, failed, total: rows.length });
});

// ì£ì§ í¬í ë¡ì»¬ ê³ì  ë¹ë°ë²í¸ ì¼ê´ ë³ê²½ â ê¸°ë³¸(admin) ë¹ë²ì ì¤ììì í ë²ì êµì²´.
// Body: { username?='admin', password, ids?: string[](ë¯¸ì§ì =íì± ì ì²´), includeCentral?: boolean }
// ì£ì§ì /api/collector/set-password(COLLECTOR_TOKEN ê°ë)ë¡ ë³ë ¬ í¸ì. ë¹ë°ë²í¸ë ì´ëìë ë¡ê¹íì§ ìëë¤.
adminRouter.post('/collectors/set-password', adminOnly, async (req, res) => {
  const username = String(req.body?.username || 'admin').trim();
  const password = String(req.body?.password || '');
  if (password.length < 8) return res.status(400).json({ ok: false, reason: 'ë¹ë°ë²í¸ë 8ì ì´ìì´ì´ì¼ í©ëë¤.' });
  if (password.length > 128) return res.status(400).json({ ok: false, reason: 'ë¹ë°ë²í¸ë 128ì ì´íì¬ì¼ í©ëë¤.' });
  const idFilter = Array.isArray(req.body?.ids) && req.body.ids.length ? new Set(req.body.ids.map(String)) : null;
  const targets = loadCollectors().filter((c) => c.enabled !== false && c.url && (!idFilter || idFilter.has(String(c.id))));

  const results = await Promise.all(targets.map(async (c) => {
    if (!c.token) return { id: c.id, name: c.name || c.id, ok: false, reason: 'ì´ ìì§ ìë²ì ì ì¥ë í í°ì´ ììµëë¤(ìì ìì í í° ìë ¥).' };
    try {
      const r = await resilientFetch(`${String(c.url).replace(/\/+$/, '')}/api/collector/set-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Collector-Token': c.token },
        body: JSON.stringify({ username, password }),
        timeoutMs: 15_000, retries: 1,
      });
      const body = await r.json().catch(() => ({}));
      if (r.status === 404) return { id: c.id, name: c.name || c.id, ok: false, reason: 'ì£ì§ê° ì´ ê¸°ë¥ì ì§ìíì§ ììµëë¤(v2.107 ë¯¸ë§ â ë¨¼ì  ìê·¸ë ì´ëíì¸ì).' };
      if (r.status === 403) return { id: c.id, name: c.name || c.id, ok: false, reason: 'í í° ë¶ì¼ì¹(ì£ì§ COLLECTOR_TOKEN íì¸).' };
      return { id: c.id, name: c.name || c.id, ok: r.ok && body.ok !== false, reason: body.reason || (r.ok ? null : `HTTP ${r.status}`), edgeVersion: body.version || null, totpEnabled: body.totpEnabled || false };
    } catch (e) {
      return { id: c.id, name: c.name || c.id, ok: false, reason: `ì°ê²° ì¤í¨: ${e.message}` };
    }
  }));

  // ìµì: ì¤ì í¬í ìì ì ëì¼ ê³ì ë í¨ê» ë³ê²½(ì£ì§/ì¤ì ë¹ë² íµì¼ì©).
  let central = null;
  if (req.body?.includeCentral === true) {
    // actor 전달: 관리자 세션 경로이므로 보호 계정(수퍼관리자·설정소유자) 대리 변경 경계를 적용한다
    // (auth.js credentialGuardDenied — 일괄 변경으로 그 경계를 우회하지 못하게).
    const r = setLocalPassword(username, password, { actor: req.user?.username });
    central = { ok: r.ok, reason: r.reason || null };
  }

  const okN = results.filter((r) => r.ok).length;
  logAudit({ user: req.user?.username, action: 'ì£ì§ ë¹ë°ë²í¸ ì¼ê´ ë³ê²½', target: username, detail: `ì±ê³µ ${okN}/${results.length}${central ? ` Â· ì¤ì ${central.ok ? 'ë³ê²½' : 'ì¤í¨'}` : ''}`, ip: req.ip || '' });
  res.json({ ok: true, username, total: results.length, succeeded: okN, results, central });
});

// ââ DataCenter(ë²ì¸) â vCenterì ìì ê°ë. ì¤ì ìì ì¢ë¥ ì ì + vCenter í ë¹ (ê´ë¦¬ì) ââââââââ
adminRouter.get('/datacenters', adminOnly, (_req, res) => {
  // ë°±í: ë±ë¡ë ìì§ ìë²ì ë°ì´í°ì¼í°ë¥¼ DataCenter ëª©ë¡ì ìì¼ë©´ ìë ìì±(ì´ë¯¸ ë±ë¡ë OC1 ê°ì
  // ìì§ê¸°ë ì¬ë±ë¡ ìì´ 'ì¤ìº ëì­ ì¶ê°' ë±ìì ë°ë¡ ë³´ì´ê² íë¤). idempotent.
  try { for (const c of loadCollectors()) ensureCollectorDatacenter(c); } catch { /* best effort */ }
  res.json({ datacenters: listDatacenters(), assign: getDatacenterAssign() });
});
adminRouter.post('/datacenters', adminOnly, (req, res) => {
  const r = addDatacenter(req.body || {});
  if (r.ok) logAudit({ user: req.user?.username, action: 'DataCenter ë±ë¡', target: r.datacenter?.id || '', detail: r.datacenter?.name || '', ip: req.ip || '' });
  res.status(r.ok ? 201 : 400).json(r);
});
// '/datacenters/assign'ì '/:id'ë³´ë¤ ë¨¼ì  ë¬ì¼ ë¼ì°í¸ ì¶©ëì´ ìë¤.
adminRouter.put('/datacenters/assign', adminOnly, (req, res) => {
  const entries = Array.isArray(req.body?.entries) ? req.body.entries.slice(0, 5000) : [];
  if (!entries.length) return res.status(400).json({ ok: false, reason: 'entriesê° ë¹ììµëë¤.' });
  const r = setVcenterDatacenterMany(entries);
  if (r.ok) logAudit({ user: req.user?.username, action: 'vCenterâDataCenter í ë¹', target: `${r.changed}ê±´`, ip: req.ip || '' });
  res.status(r.ok ? 200 : 400).json(r);
});
adminRouter.put('/datacenters/:id', adminOnly, (req, res) => {
  const r = updateDatacenter(req.params.id, req.body || {});
  if (r.ok) logAudit({ user: req.user?.username, action: 'DataCenter ìì ', target: req.params.id, ip: req.ip || '' });
  res.status(r.ok ? 200 : 400).json(r);
});
adminRouter.delete('/datacenters/:id', adminOnly, (req, res) => {
  const r = removeDatacenter(req.params.id);
  if (r.ok) logAudit({ user: req.user?.username, action: 'DataCenter ì­ì ', target: req.params.id, ip: req.ip || '' });
  res.status(r.ok ? 200 : 404).json(r);
});
// DataCenter íì ìì(vCenter ììì ëì¼í ê°ë) â ëª¨ë  'DataCenter ì í' ëª©ë¡ì ì ì©.
adminRouter.get('/datacenter-order', adminOnly, (_req, res) => {
  res.json({ order: getDatacenterOrder(), datacenters: listDatacenters().map((d) => ({ id: d.id, name: d.name, region: d.region || '' })) });
});
adminRouter.put('/datacenter-order', adminOnly, (req, res) => {
  const r = saveDatacenterOrder((req.body || {}).order);
  if (r.ok) logAudit({ user: req.user?.username, action: 'DataCenter ìì ë³ê²½', detail: `${(r.order || []).length}ê°`, ip: req.ip || '' });
  res.status(r.ok ? 200 : 400).json(r);
});

// íì¬ íëì¨ì´ + NIC ì¶ê°ì© ë¤í¸ìí¬ ëª©ë¡.
adminRouter.get('/vm/:id/hardware', requirePerm('vm.reconfig'), async (req, res) => {
  const t = resolveVmTarget(req.params.id);
  // 조회 범위 밖이면 404(존재 은닉) — 범위 밖 VM 의 하드웨어 구성 노출 차단(v2.389).
  if (t.vm) { const d = vmScopeDenied(req, t.vm, false); if (d) return res.status(d.code).json({ ok: false, reason: d.error }); }
  if (t.error) return res.status(t.code).json({ ok: false, reason: t.error });
  try {
    const hw = await getVmHardware(t.vc, t.moref);
    // ì´ë¦ ìì°ì ë ¬(ì«ì ì ë¯¸ì¬ ê³ ë ¤: uplink1 < uplink10, VMAX-2 < VMAX-10).
    const byName = (a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: 'base' });
    const networks = (t.snap.networks || [])
      .filter((n) => n.vcenterId === t.vc.id)
      .map((n) => ({ id: n.id, name: n.name, type: n.type, moref: String(n.id).split(':').slice(1).join(':') }))
      .sort(byName);
    // ëì¤í¬ ì¶ê° ì ì íí  ë°ì´í°ì¤í ì´ íë³´(í´ë¹ vCenter). ì´ë¦ìì¼ë¡ ì ë ¬(ì¬ì /ì´ì©ëì ë¼ë²¨ì íì).
    const datastores = (t.snap.datastores || [])
      .filter((d) => d.vcenterId === t.vc.id)
      .map((d) => ({ name: d.name, freeGB: d.freeGB, capacityGB: d.capacityGB }))
      .sort(byName);
    res.json({ ok: true, vmName: t.vm.name, powerState: hw.powerState, hw, networks, datastores });
  } catch (e) { res.status(502).json({ ok: false, reason: e.message }); }
});

// ì¬ì ë³ê²½ ì¤í. body: { numCPUs?, memoryMB?, diskGrows?, diskAdds?, nicAdds?, nicRemoves? }
adminRouter.post('/vm/:id/reconfig', requirePerm('vm.reconfig'), async (req, res) => {
  const t = resolveVmTarget(req.params.id);
  // 상태변경 — 조회 범위 밖 404, 쓰기 범위 밖 403(v2.389). 형제 라우트와 동일 규약.
  if (t.vm) { const d = vmScopeDenied(req, t.vm, true); if (d) return res.status(d.code).json({ ok: false, reason: d.error }); }
  if (t.error) return res.status(t.code).json({ ok: false, reason: t.error });
  const b = req.body || {};
  const plan = {
    numCPUs: b.numCPUs != null ? Number(b.numCPUs) : undefined,
    coresPerSocket: b.coresPerSocket != null ? Number(b.coresPerSocket) : undefined,
    memoryMB: b.memoryMB != null ? Number(b.memoryMB) : undefined,
    diskGrows: Array.isArray(b.diskGrows) ? b.diskGrows.slice(0, 64) : [],
    diskAdds: Array.isArray(b.diskAdds) ? b.diskAdds.slice(0, 16).map((a) => ({
      sizeGB: a?.sizeGB, controllerKey: a?.controllerKey,
      datastore: a?.datastore ? String(a.datastore) : undefined,
    })) : [],
    nicAdds: Array.isArray(b.nicAdds) ? b.nicAdds.slice(0, 10) : [],
    nicRemoves: Array.isArray(b.nicRemoves) ? b.nicRemoves.slice(0, 10) : [],
    nicConnects: Array.isArray(b.nicConnects) ? b.nicConnects.slice(0, 20) : [],
  };
  // ì íí ë°ì´í°ì¤í ì´ê° ì´ vCenterì ì¤ì  ë°ì´í°ì¤í ì´ì¸ì§ ê²ì¦(ì¤íÂ·í vCenter ì°¨ë¨).
  const validDs = new Set((t.snap.datastores || []).filter((d) => d.vcenterId === t.vc.id).map((d) => d.name));
  for (const a of plan.diskAdds) {
    if (a.datastore && !validDs.has(a.datastore)) return res.status(400).json({ ok: false, reason: `ë°ì´í°ì¤í ì´ '${a.datastore}'ë¥¼ ì°¾ì ì ììµëë¤(ì´ vCenterì ë°ì´í°ì¤í ì´ë¥¼ ì ííì¸ì).` });
  }
  try {
    const r = await reconfigVm(t.vc, t.moref, plan);
    logAudit({
      user: req.user?.username, action: 'VM ì¬ì ë³ê²½',
      target: t.vm.name,
      detail: r.ok ? (r.changes || []).join(', ') : `ì¤í¨: ${r.error}`,
      ip: req.ip || '',
    });
    if (r.ok) { store.refresh().catch(() => {}); return res.json({ ok: true, changes: r.changes }); }
    res.status(400).json({ ok: false, reason: r.error, changes: r.changes });
  } catch (e) {
    logAudit({ user: req.user?.username, action: 'VM ì¬ì ë³ê²½', target: t.vm.name, detail: `ì¤ë¥: ${e.message}`, ip: req.ip || '' });
    res.status(502).json({ ok: false, reason: e.message });
  }
});

// Trigger an immediate pull of all collectors.
adminRouter.post('/collectors/pull', adminOnly, async (_req, res) => {
  await pullNow();
  res.json({ ok: true, status: allCollectorStatus() });
});

// Push an upgrade bundle to collector agents. Body: { id?, force? }.
// Brings one (id) or all registered agents up to the central portal's version.
adminRouter.post('/collectors/upgrade', adminOnly, async (req, res) => {
  const { id, force } = req.body || {};
  const bundle = await resolveBundleBytes(upgradeManager.settings);
  if (!bundle) {
    // ë¬´ê²°ì± ê²ì¦ ì¤í¨(sha ë¶ì¼ì¹/ë¶ì¬)ì 'ë²ë¤ ìì²´ê° ìì'ì êµ¬ë¶í´ ìë¦°ë¤.
    const why = lastBundleReject();
    return res.status(409).json({ ok: false, reason: why || 'ìê·¸ë ì´ë ë²ë¤ì ì°¾ì ì ììµëë¤ (ê°ì í´ë/ìê²© ìì¤ íì¸).' });
  }
  const results = await pushUpgradeToCollectors(bundle.bytes, { ids: id ? [id] : null, force: Boolean(force) });
  const ok = results.filter((r) => r.ok).length;
  res.json({ ok: true, version: bundle.version, source: bundle.source, pushed: results.length, succeeded: ok, results });
});

// Test connectivity to one collector (saved by id, or an ad-hoc {url, token}).
adminRouter.post('/collectors/test', adminOnly, async (req, res) => {
  const body = req.body || {};
  let { url, token } = body;
  if (body.id) { const saved = loadCollectors().find((c) => c.id === body.id); if (saved) { url = url || saved.url; token = token || saved.token; } }
  if (!url) return res.status(400).json({ ok: false, reason: 'urlì´ íìí©ëë¤.' });
  if (!/^https?:\/\//.test(url)) url = `http://${url}`;
  // SSRF ë°©ì´: ë§í¬ë¡ì»¬/í´ë¼ì°ë ë©íë°ì´í° ì£¼ìë¡ë í í°ì ë¶ì¬ ìì²­íì§ ìëë¤(ë±ë¡ ê²½ë¡ì ëì¼ ê°ë).
  const ssrf = ssrfBlockReason(url);
  if (ssrf) return res.status(400).json({ ok: false, reason: ssrf });
  const started = Date.now();
  let retried = 0;
  try {
    // ë¨ë° fetchë ê³ RTTÂ·ì¼ìì  ë¤í¸ìí¬ ë¸ë¦½ì 'ê°ë ì°ê²° ì ë¨'ì¼ë¡ ì¤íëë¤ â ì¬ìëë¡ í¡ì.
    const r = await resilientFetch(`${url.replace(/\/+$/, '')}/api/collector/export`, {
      headers: { Accept: 'application/json', ...(token ? { 'X-Collector-Token': token } : {}) },
      timeoutMs: config.collector.timeoutMs, retries: 2,
      onRetry: () => { retried++; },
    });
    if (!r.ok) {
      // ìë²ê° ì¤ ì¬ì (collector ë¼ì°í°ì error íë)ì ìíì½ëë³ í´ê²° íí¸ë¥¼ í¨ê» ìë´íë¤.
      let serverMsg = '';
      try { const j = await r.json(); serverMsg = j?.error || j?.reason || ''; } catch { /* ë³¸ë¬¸ ìì/ë¹JSON */ }
      const hint = r.status === 404
        ? "ìì§ ìë²ì COLLECTOR_TOKENì´ ì¤ì ëì§ ìììµëë¤(export ë¹íì±). ê·¸ ìì´ì í¸ë¥¼ 'COLLECTOR_TOKEN=<í í°>' íê²½ë³ìì í¨ê» ì¤í/ì¬ììíì¸ì(ë¦¬ëì¤: /etc/vmware-portal/portal.env)."
        : (r.status === 403 || r.status === 401)
          ? 'í í° ë¶ì¼ì¹(ì¸ì¦ ì¤í¨). ì´ íë©´ì í í°ì ìì´ì í¸ì COLLECTOR_TOKENê³¼ ëì¼íê² ë§ì¶ì¸ì.'
          : (r.status === 405 || r.status === 400)
            ? 'ì´ ì£¼ìê° ìì§ ìì´ì í¸(í¬í)ê° ìë ì ììµëë¤. URL/í¬í¸ë¥¼ íì¸íì¸ì.'
            : '';
      return res.json({ ok: false, reason: `HTTP ${r.status}${serverMsg ? ` â ${serverMsg}` : ''}${hint ? ` Â· ${hint}` : ''}`, status: r.status, ms: Date.now() - started, retried });
    }
    const data = await r.json();
    res.json({ ok: true, ms: Date.now() - started, retried, hosts: data.hosts, version: data.version, datacenter: data.datacenter });
  } catch (err) {
    res.json({ ok: false, reason: err.message, ms: Date.now() - started, retried });
  }
});

// í í° ê°ì  ëê¸°í â ì°ê²° íì¤í¸ê° 403(í í° ë¶ì¼ì¹)ì¼ ë, ìì§ ìë² URLì í¸ì¤í¸ì ì¼ì¹íë
// 'Edge ë¸ë í¬í ì¤ì¹' ì ì¥ ëì(SSH)ì ì°¾ì ì£ì§ portal.envì COLLECTOR_TOKENì ì´ íë©´ì
// í í°ì¼ë¡ êµì²´Â·ì¬ììíê³ , ì¤ì ì ì¥ í í°ë ê°ì ê°ì¼ë¡ ê³ ì (managed)í ë¤ ì¬ê²ì¦íë¤.
adminRouter.post('/collectors/:id/force-token', adminOnly, async (req, res) => {
  const saved = loadCollectors().find((c) => c.id === req.params.id);
  if (!saved) return res.status(404).json({ ok: false, reason: `ìë ìì§ ìë²: ${req.params.id}` });
  const token = String(req.body?.token || saved.token || '').trim();
  if (!token) return res.status(400).json({ ok: false, reason: 'í í°ì´ ììµëë¤. ì´ íë©´ìì í í°ì ìë ¥(ëë ìë ìì±)í ë¤ ë¤ì ìëíì¸ì.' });
  let url = String(req.body?.url || saved.url || '').trim();
  if (url && !/^https?:\/\//.test(url)) url = `http://${url}`;
  const ssrf = url ? ssrfBlockReason(url) : 'URLì´ ììµëë¤.';
  if (ssrf) return res.status(400).json({ ok: false, reason: ssrf });
  let host = ''; let urlPort = 0;
  try { const u = new URL(url); host = u.hostname; urlPort = Number(u.port) || (u.protocol === 'https:' ? 443 : 80); } catch { /* ìëìì ì²ë¦¬ */ }
  if (!host) return res.status(400).json({ ok: false, reason: 'ìì§ ìë² URLìì í¸ì¤í¸ë¥¼ íì¸í  ì ììµëë¤.' });
  const target = listTargets().map((t) => getTargetRaw(t.id)).find((t) => t && String(t.host || '').trim() === host);
  if (!target) {
    return res.status(404).json({ ok: false, reason: `SSH ë°°í¬ ëìì ${host} ê° ììµëë¤. 'ìì§ ìë² â ìê²© ë²ì¸(DC)ì Edge ë¸ë í¬í ì¤ì¹'ìì ì´ í¸ì¤í¸ë¥¼ ë¨¼ì  ì ì¥(SSH ê³ì  í¬í¨)íì¸ì.` });
  }
  // URL í¬í¸ë¥¼ ì¤ì  ìë¹ì¤ ì¤ì¸ ì¸ì¤í´ì¤ë¥¼ ì­ì¶ì í´ ì ì© â ê°ì í¸ì¤í¸ ë¤ì¤ ì¸ì¤í´ì¤(:4000/:4001)ë
  // NAT í¬ìë©(ë¤ë¥¸ ì¥ë¹)ì¼ ë ê¸°ë³¸ ì¸ì¤í´ì¤ë§ ê³ ì¹ê³  'ì±ê³µ'ì¼ë¡ ì¤ííë ë²ê·¸ ë°©ì§.
  const r = await forceCollectorToken(target, token, { urlPort });
  logAudit({ user: req.user?.username, action: 'ìì§ ìë² í í° ê°ì  ëê¸°í', target: `${saved.id} (${host})`, detail: r.ok ? `ì±ê³µ Â· ìë¹ì¤ ${r.active}` : `ì¤í¨ â ${r.reason}`, ip: req.ip || '' });
  if (!r.ok) return res.status(400).json({ ok: false, reason: r.reason, host, sshTarget: target.id, log: r.log });
  // ì¤ì ì ì¥ í í°ë ëì¼ ê°ì¼ë¡ ê³ ì (managed) â ì£ì§ ìê¸°ë±ë¡ì´ ì´ ê°ì ë®ì´ì°ì§ ìê².
  const upd = updateCollector(saved.id, { ...saved, token, url: saved.url }, { managed: true });
  // ì¬ê²ì¦: ì í í°ì¼ë¡ exportê° 200ì¸ì§ íì¸(ìë¹ì¤ ê¸°ë ì§íë¼ ì¬ìë ì¬ì ).
  let verified = false; let verifyReason = '';
  try {
    const vr = await resilientFetch(`${String(saved.url || url).replace(/\/+$/, '')}/api/collector/export`, {
      headers: { Accept: 'application/json', 'X-Collector-Token': token },
      timeoutMs: config.collector.timeoutMs, retries: 2,
    });
    verified = vr.ok;
    if (!vr.ok) verifyReason = `HTTP ${vr.status}`;
  } catch (e) { verifyReason = e.message; }
  if (verified) pullNow().catch(() => {});
  res.json({ ok: true, host, sshTarget: target.id, active: r.active, unit: r.unit, envFile: r.envFile, note: r.note || undefined, savedToken: upd.ok, verified, verifyReason: verified ? undefined : verifyReason });
});
}
