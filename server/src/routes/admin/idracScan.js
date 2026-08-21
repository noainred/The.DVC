// iDRAC ìì¸(:id)Â·ê°ì ¸ì¤ê¸°Â·ì¤ìº/ëì­/ì¡Â·ì­ì /í ë¹ â admin.js(êµ¬ 2,410ì¤) ë¶í (v2.285.0). ë³¸ë¬¸ì ìë³¸ ê·¸ëë¡, ë±ë¡ ììë admin.js í¸ì¶ ììê° ë³´ì¡´íë¤.
import { config } from '../../config.js';
import { store } from '../../store.js';
import { logAudit } from '../../audit.js';
import { getAllGpuGuestDiag } from '../../central/gpuGuestDiag.js';
import { listInventory } from '../../central/inventory.js';
import { getAllAgentConfigs } from '../../central/agentConfig.js';
import { updateServer, removeServer, importServers, parseCsv, bulkAddByIps, registerScanned, assignVcenter, deleteServers, loadRegistry as loadIdracRegistry } from '../../idrac/registry.js';
import { expandIpList } from '../../idrac/iprange.js';
import { scanForIdracs } from '../../idrac/scan.js';
import { enqueueIdracScan, enqueueIdracRegister, getIdracScanResult, listIdracScanJobs, getIdracScanJobLog, cancelIdracScanJob, recentPollingAgents } from '../../central/idracScanJobs.js';
import { pushIdracScan } from '../../central/idracScanPush.js';
import { getPollerStatus, pollNow } from '../../idrac/poller.js';
import { listScanRanges, saveScanRanges, removeScanRanges, getScanRangeRaw } from '../../idrac/scanRanges.js';
import { scanRangesToCsv, sampleCsv as scanRangesSampleCsv, parseScanRangesCsv, analyzeScanRangesImport } from '../../idrac/scanRangesCsv.js';
import { listDatacenters } from '../../datacenter/store.js';
import { startIdracScanNow, idracScanStatus, stopIdracScanNow, setIdracScanIntervalMs } from '../../idrac/scanPoller.js';
import { listIdracScanLog, idracScanLogDatacenters } from '../../idrac/scanLog.js';
import { getInventory as getIdracInventory } from '../../idrac/invCache.js';
import { getSensorSeries } from '../../idrac/sensorStore.js';
import { fetchInventory as fetchIdracInventory, fetchSensors as fetchIdracSensors, probeGpuTelemetry } from '../../idrac/redfish.js';
import { listCollectors } from '../../collector/registry.js';
import { findRemoteServer } from '../../collector/remoteInventory.js';
import { findHostByServiceTag } from '../../idrac/hostMatch.js';
import { getDatacenterAssign } from '../../datacenter/store.js';
import { allCollectorStatus } from '../../collector/state.js';
import { listAssignments, getResults } from '../../central/assignments.js';
import { adminOnly, requireSettingsOwner } from './shared.js';


// Register iDRACs found by a scan, applying the shared credentials, then poll.
// Body: { found:[...], username, password, mode?, vcenterId?, agent? }
// mode: 'merge'(ê¸°ë³¸) | 'replace'(ì ì²´ êµì²´) | 'replace-vcenter'(ìì vCenterë§ êµì²´).
// agent ì§ì (ìì): ìì´ì í¸ê° íì§ì ë±ë¡(ì¤ì ëª» ë¿ë ëì­) â reqId ë°í, UIê° í´ë§.
const normIdracMode = (m) => (['replace', 'replace-vcenter', 'merge'].includes(m) ? m : 'merge');

export function registerIdracScan(adminRouter) {

// ìë² ìì¸ ì¸ë²¤í ë¦¬(iDRAC/BIOS/ëë¼ì´ë² ë²ì  ë±). ìºì ì°ì , ?refresh=1ì´ë©´ ì¦ì ì¬ìì§.
adminRouter.get('/idrac/:id/inventory', adminOnly, async (req, res) => {
  const s = loadIdracRegistry().find((x) => x.id === req.params.id);
  if (!s) {
    // ìì ë²ì¸ì ìê²© ìë² â ì¤ìì´ ì§ì  ëª» ë¿ì¼ë¯ë¡ ì£ì§ê° ì¤ì´ë³´ë¸ ì¸ë²¤í ë¦¬ë¥¼ ê·¸ëë¡ ë°í(ì¬ìì§ ë¶ê°).
    const rs = findRemoteServer(req.params.id);
    if (rs) return res.json({ ok: true, fresh: false, remote: true, collectorId: rs.collectorId, inventory: rs.inv || null });
    return res.status(404).json({ ok: false, reason: 'ìë²ë¥¼ ì°¾ì ì ììµëë¤.' });
  }
  if (s.type === 'ome') return res.status(400).json({ ok: false, reason: 'OME ìì¤ë ìì¸ ì¸ë²¤í ë¦¬ë¥¼ ì§ìíì§ ììµëë¤(iDRAC ì§ì ë§).' });
  if (req.query.refresh === '1') {
    try { return res.json({ ok: true, fresh: true, inventory: await fetchIdracInventory(s) }); }
    catch (e) { return res.status(502).json({ ok: false, reason: e.message }); }
  }
  const inv = getIdracInventory(s.id);
  res.json({ ok: true, fresh: false, inventory: inv?.data || inv || null });
});

// ìë¹ì¤íê·¸(= ESXi íëì¨ì´ ì¼ë ¨ë²í¸)ë¡ ì´ iDRAC ë¬¼ë¦¬ ìë²ì ëìíë vCenter ê°ìí í¸ì¤í¸ ì¡°í.
// ë¬¼ë¦¬(iDRAC/ë² ì´ë©í) â ê°ìí(vCenter ESXi) ë¸ë¦¿ì§: Dell ìë¹ì¤íê·¸ == í¸ì¤í¸ ì¼ë ¨ë²í¸.
adminRouter.get('/idrac/:id/vcenter-host', adminOnly, (req, res) => {
  const id = req.params.id;
  const s = loadIdracRegistry().find((x) => x.id === id) || findRemoteServer(id);
  if (!s) return res.status(404).json({ ok: false, reason: 'ìë²ë¥¼ ì°¾ì ì ììµëë¤.' });
  const norm = (t) => String(t || '').trim().toLowerCase();
  // iDRAC ì ì IP/í¸ì¤í¸(v2.301) â ìì¸ ëª¨ë¬ì´ 'iDRAC ë°ë¡ê°ê¸°' ë§í¬ë¡ íì(ì¬ì©ì ìêµ¬).
  // ë±ë¡ ë ì½ëì host ê·¸ëë¡(ê°í¹ íë¡í ì½ì´ ë¶ì ë ê±°ì ê°ì íìë¶ìì ì ë¦¬).
  const idracHost = String(s.host || '').trim();
  const tag = norm(s.serviceTag || getIdracInventory(id)?.system?.serviceTag || s.inv?.system?.serviceTag || '');
  if (!tag) return res.json({ ok: true, matched: false, serviceTag: '', reason: 'ìë¹ì¤íê·¸ ìì', idracHost });
  const snap = store.get();
  const assign = getDatacenterAssign();
  const host = findHostByServiceTag(tag, snap.hosts || []);
  if (!host) return res.json({ ok: true, matched: false, serviceTag: s.serviceTag || tag, idracHost });
  res.json({
    ok: true, matched: true, serviceTag: host.serviceTag || tag, idracHost,
    host: {
      name: host.name,
      vcenterId: host.vcenterId || '',
      datacenterId: assign[String(host.vcenterId || '')] || '',
      cluster: host.cluster || '',
      connectionState: host.connectionState || '',
      cpuUsagePct: host.cpuUsagePct ?? null,
      memUsagePct: host.memUsagePct ?? null,
      vmCount: host.vmCount ?? null,
      model: host.model || '',
      powerState: host.powerState || '',
    },
  });
});

// ì¨ëì¼ì + CPU ì¬ì©ë ìê³ì´(ì°¨í¸ì©). ?minutes=N ì¼ë¡ ìµê·¼ êµ¬ê°ë§. ?live=1 ì¦ì 1ìí ìì§.
adminRouter.get('/idrac/:id/sensors', adminOnly, async (req, res) => {
  const s = loadIdracRegistry().find((x) => x.id === req.params.id);
  if (!s) {
    // ìì ë²ì¸ ìê²© ìë²: ì¤ìì ìê³ì´ì´ ìì(ì¨ë ëê¸°íë íì). ìì¸ íìì´ ìë¬ëì§ ìê² ë¹ ìëµ.
    if (findRemoteServer(req.params.id)) return res.json({ ok: true, remote: true, latest: null, series: [], live: null });
    return res.status(404).json({ ok: false, reason: 'ìë²ë¥¼ ì°¾ì ì ììµëë¤.' });
  }
  if (s.type === 'ome') return res.status(400).json({ ok: false, reason: 'OME ìì¤ë ì¼ì ìê³ì´ì ì§ìíì§ ììµëë¤.' });
  let live = null;
  if (req.query.live === '1') {
    try { live = await fetchIdracSensors(s); } catch (e) { live = { error: e.message }; }
  }
  const minutes = Math.max(0, Math.min(1440, Number(req.query.minutes) || 0));
  res.json({ ok: true, ...getSensorSeries(s.id, { minutes }), live, intervalMs: getPollerStatus().intervalMs });
});

// iDRACìì GPU ì¬ì©ë¥  ìì§ ê°ë¥ ì¬ë¶ ì¤ì¸¡ íì¸(GPU ëª©ë¡ + íë ë©í¸ë¦¬ ë¦¬í¬í¸).
adminRouter.get('/idrac/:id/gpu-probe', adminOnly, async (req, res) => {
  const s = loadIdracRegistry().find((x) => x.id === req.params.id);
  if (!s) {
    // ìì ë²ì¸ ìê²© ìë²: ì¤ìì´ iDRACì ì§ì  ëª» ë¿ì ì¤ìê° íë¡ë¸ ë¶ê°(íì¥ ìì´ì í¸ìì ìí).
    if (findRemoteServer(req.params.id)) return res.status(400).json({ ok: false, reason: 'ìì ë²ì¸ì ìê²© ìë²ë ì¤ììì ì¤ìê° GPU íë¡ë¸ë¥¼ í  ì ììµëë¤(íì¥ ìì´ì í¸ê° ìì§). ì¸ë²¤í ë¦¬ì GPU ëª©ë¡ì ì°¸ê³ íì¸ì.' });
    return res.status(404).json({ ok: false, reason: 'ìë²ë¥¼ ì°¾ì ì ììµëë¤.' });
  }
  if (s.type === 'ome') return res.status(400).json({ ok: false, reason: 'OME ìì¤ë GPU íë¡ë¸ë¥¼ ì§ìíì§ ììµëë¤(iDRAC ì§ì ë§).' });
  try { res.json({ ok: true, ...(await probeGpuTelemetry(s)) }); }
  catch (e) { res.status(502).json({ ok: false, reason: e.message }); }
});

// Import servers (JSON array / { servers:[...] } / CSV text). Body:
//   { servers:[...], mode? } | { csv:"...", mode? } | bare array
adminRouter.post('/idrac/import', adminOnly, (req, res) => {
  const body = req.body || {};
  let list;
  if (typeof body.csv === 'string') list = parseCsv(body.csv);
  else list = Array.isArray(body) ? body : body.servers;
  const result = importServers(list, body.mode === 'replace' ? 'replace' : 'merge');
  if (result.ok) pollNow().catch(() => {});
  res.status(result.ok ? 200 : 400).json(result);
});

// Preview how an IP list expands (count + sample + parse errors) â no writes.
adminRouter.post('/idrac/expand-ips', adminOnly, (req, res) => {
  const { ips, errors, truncated } = expandIpList((req.body || {}).ips || '');
  res.json({ ok: true, count: ips.length, truncated, sample: ips.slice(0, 12), errors });
});

// Bulk-register servers from an IP list with shared credentials, then poll.
// Body: { ips, username, password, namePrefix?, mode? }
adminRouter.post('/idrac/bulk-add', adminOnly, (req, res) => {
  const result = bulkAddByIps(req.body || {});
  if (result.ok) pollNow().catch(() => {});
  res.status(result.ok ? 200 : 400).json(result);
});

// Scan an IP range and return only the IPs that are real Dell iDRACs (with
// identity). No writes. Body: { ips, username, password, agent? }
// agent ë¯¸ì§ì /'__local__' = ì´ í¬íìì ì§ì  ì¤ìº(ëê¸°). ê·¸ ì¸ = í´ë¹ ìì´ì í¸ì ìì.
adminRouter.post('/idrac/scan', adminOnly, async (req, res) => {
  const { ips, username, password } = req.body || {};
  const agent = String(req.body?.agent || '').trim();
  if (!ips) return res.status(400).json({ ok: false, reason: 'IP ëì­ì ìë ¥íì¸ì.' });
  if (!username || !password) return res.status(400).json({ ok: false, reason: 'iDRAC ê³ì /ë¹ë°ë²í¸ê° íìí©ëë¤.' });

  // ìì´ì í¸ ìì ì¤ìº(ìê²© ì¬ì´í¸ iDRACì ì¤ìì´ ì§ì  ëª» ë¿ë ê²½ì°).
  if (agent && agent !== '__local__') {
    const dispatch = String(req.body?.dispatch || 'poll') === 'push' ? 'push' : 'poll';
    // dispatch=push: ì¤ìì´ ìì§ ìë² URLë¡ ì£ì§ì ì§ì  ì¤ìº ì ì¡(ì£ì§ í´ë§/ì¤ì í í° ë¶íì).
    if (dispatch === 'push') {
      const pr = pushIdracScan(agent, { ips, username, password, vcenterId: String(req.body?.vcenterId || '').trim(), datacenterId: String(req.body?.datacenterId || '').trim(), noRegister: true });
      if (!pr.ok) return res.status(400).json({ ok: false, reason: pr.reason });
      return res.json({ ok: true, delegated: true, dispatch: 'push', agent, reqId: pr.reqId });
    }
    if (!config.central.token) return res.status(400).json({ ok: false, reason: 'ì¤ì(CENTRAL_TOKEN) ë¯¸ì¤ì  â ìì´ì í¸ í´ë§ ìì ì¤ìºì ì¬ì©í  ì ììµëë¤(ì¤ìâì£ì§ ì§ì  PUSH ë°©ìì í í° ìì´ë ê°ë¥).' });
    // noRegister: ì¤ìºë§ íê³  ë±ë¡ì UI íì¸ í ë³ë 'ë±ë¡' ì¡ì¼ë¡(ìëë±ë¡ ì í¨).
    const reqId = enqueueIdracScan(agent, { ips, username, password, vcenterId: String(req.body?.vcenterId || '').trim(), datacenterId: String(req.body?.datacenterId || '').trim(), noRegister: true });
    if (!reqId) return res.status(429).json({ ok: false, reason: 'ëê¸° ì¤ì¸ ì¤ìº ì¡ì´ ëë¬´ ë§ìµëë¤. ì ì í ë¤ì ìëíì¸ì.' });
    return res.json({ ok: true, delegated: true, dispatch: 'poll', agent, reqId });
  }

  try {
    const result = await scanForIdracs({ ips, username, password });
    res.json({ ok: true, delegated: false, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, reason: err.message });
  }
});

// ìì ì¤ìº ê²°ê³¼ í´ë§. Query: reqId
adminRouter.get('/idrac/scan-result', adminOnly, (req, res) => {
  res.json(getIdracScanResult(String(req.query.reqId || '')));
});

// ìì ì¤ìºì ì¬ì©í  ì ìë ìì´ì í¸ ì´ë¦ ëª©ë¡ â ì¤ìì ë³´ê³ /ë±ë¡ë ìì´ì í¸ + ë±ë¡ë
// 'ìì§ ìë²(ìê²©)'(idÂ·ì´ë¦) + ì§ê¸ ì¤ì ë¡ ì¡ì ì¸ì¶ í´ë§ ì¤ì¸ ìì´ì í¸ë¥¼ ë³í©íë¤. í´ë§ ì¤ì¸
// ì´ë¦ì ë°ëì ëª©ë¡ì ë£ëë¤ â ì¡ì ì¤ì ë¡ ì¸ì¶íë ê±´ 'í´ë§ ì¤ì¸ ì´ë¦'ì´ë¯ë¡, ë±ë¡ë§ ëê³ 
// í´ë§íì§ ìë ì´ë¦(ì: OC2Sandbox)ì´ ìëë¼ ì¤ì  í´ë§ ì´ë¦(ì: oc2)ì ê³ ë¥¼ ì ìì´ì¼ íë¤.
// ëìë¬¸ì ë¬´ì ì¤ë³µ ì ê±°(ì¡ ë§¤ì¹­ë ìë¬¸ì ê¸°ì¤).
adminRouter.get('/idrac/scan-agents', adminOnly, (_req, res) => {
  const names = new Set();
  const lower = new Set();
  const add = (v) => { const s = String(v || '').trim(); if (!s) return; const k = s.toLowerCase(); if (!lower.has(k)) { lower.add(k); names.add(s); } };
  for (const k of Object.keys(getAllAgentConfigs() || {})) add(k);
  for (const x of listInventory()) add(x.agent);
  for (const x of getAllGpuGuestDiag()) add(x.agent);
  for (const a of listAssignments()) add(a.agent);
  for (const k of Object.keys(getResults() || {})) add(k);
  for (const c of listCollectors()) { add(c.id); add(c.name); } // ìì§ ìë²(ìê²©) ë±ë¡ë¶
  const polling = recentPollingAgents(5 * 60_000); // ìµê·¼ 5ë¶ ë´ ì¡ ì¸ì¶ í´ë§(ìë¬¸ì)
  for (const p of polling) add(p); // ì¤ì  í´ë§ ì¤ì¸ ì´ë¦ì ë°ëì ì í ê°ë¥íê²
  res.json({ agents: [...names].sort((a, b) => a.localeCompare(b)), pollingAgents: polling, centralEnabled: Boolean(config.central.token) });
});
adminRouter.post('/idrac/register-scanned', adminOnly, (req, res) => {
  const { found, username, password, mode, vcenterId, datacenterId, agent } = req.body || {};
  const ag = String(agent || '').trim();
  if (ag && ag !== '__local__') {
    if (!config.central.token) return res.status(400).json({ ok: false, reason: 'ì¤ì(CENTRAL_TOKEN) ë¯¸ì¤ì  â ìì ë±ë¡ì ì¬ì©í  ì ììµëë¤.' });
    const reqId = enqueueIdracRegister(ag, { found, username, password, vcenterId: vcenterId || '', datacenterId: String(datacenterId || '').trim(), mode: normIdracMode(mode) });
    if (!reqId) return res.status(429).json({ ok: false, reason: 'ë±ë¡í  iDRACê° ìê±°ë ëê¸° ì¡ì´ ëë¬´ ë§ìµëë¤.' });
    return res.json({ ok: true, delegated: true, agent: ag, reqId });
  }
  const result = registerScanned(found, username, password, normIdracMode(mode), vcenterId || '');
  if (result.ok) pollNow().catch(() => {});
  res.status(result.ok ? 200 : 400).json(result);
});

// ---- vCenterë³ iDRAC ì¤ìº ëì­ + ì£¼ê¸° ìë ë°ê²¬(IPMSì 'vCenterë³ ì¤ìº ëì­'ê³¼ ëì¼ íë¦) ----
// ê° vCenterì iDRAC IP ëì­ + ê³ì ì ì ì¥íë©´, ì£¼ê¸° ì¤ìºëê° ê·¸ ëì­ì ëë©° Dell iDRACì
// ë°ê²¬í´ í´ë¹ vCenterë¡ ìë ë±ë¡íë¤. ë¹ë°ë²í¸ë ìëµìì ë§ì¤í¹ëë¤.
adminRouter.get('/idrac/scan-ranges', adminOnly, (_req, res) => {
  res.json({ ok: true, ranges: listScanRanges(), status: idracScanStatus(), centralEnabled: Boolean(config.central.token) });
});
// ì ì¥/ìì . Body: { id?, datacenterId, service?, ranges?, username?, password?, agent?, enabled?, mode? }
// idê° ìì¼ë©´ ê·¸ ìí¸ë¦¬ ìì , ìì¼ë©´ ì ìí¸ë¦¬ ìì±(í ë²ì¸ì ì¬ë¬ ìë¹ì¤ ìí¸ë¦¬ íì©).
// (êµ¬ë²ì  í´ë¼ì´ì¸í¸ í¸í: vcenterIdë¡ ìë datacenterIdë¡ ì²ë¦¬)
adminRouter.put('/idrac/scan-ranges', adminOnly, (req, res) => {
  const b = req.body || {};
  const dcId = b.datacenterId || b.vcenterId;
  const r = saveScanRanges({ ...b, datacenterId: dcId });
  if (r.ok) logAudit({ user: req.user?.username, action: 'iDRAC ì¤ìº ëì­ ì ì¥', target: `${dcId}${r.service ? `/${r.service}` : ''} (ëì­ ${(r.ranges || []).length}ê°${r.enabled ? '' : ', ë¹íì±'})` });
  res.status(r.ok ? 200 : 400).json(r);
});
// ì­ì . :id = ìí¸ë¦¬ ê³ ì í¤(êµ¬ë²ì  ë§ì´ê·¸ë ì´ìë¶ì id=datacenterId).
adminRouter.delete('/idrac/scan-ranges/:id', adminOnly, (req, res) => {
  const r = removeScanRanges(req.params.id);
  if (r.ok) logAudit({ user: req.user?.username, action: 'iDRAC ì¤ìº ëì­ ì­ì ', target: req.params.id });
  res.status(r.ok ? 200 : 404).json(r);
});
/* ââ ì¤ìº ëì­ CSV ì¼ê´ ê´ë¦¬(v2.339, ì¬ì©ì ìêµ¬) â ìì§ ìë² CSV(v2.338)ì ëì¼ ê³¨ê²©. ââââââ
 * ë´ë³´ë´ê¸° ê¸°ë³¸ì ë¹ë°ë²í¸ ì ì¸, ?secrets=1 ì requireSettingsOwner + ê°ì¬ë¡ê·¸.
 * ê°ì ¸ì¤ê¸°ë dryRun(ë²ì¸ í´ìÂ·ëì­ ë¬¸ë²(expandIpList)Â·ì¤ë³µ ê²ì¦) â ì»¤ë° 2ë¨ê³ì´ê³ ,
 * (ë²ì¸,ìë¹ì¤)ê° ê²¹ì¹ë íì body.overwrite=true ëªì ììë§ ê°±ì íë¤.
 */
adminRouter.get('/idrac/scan-ranges/export.csv', adminOnly, (req, res) => {
  const withPw = String(req.query.secrets || '') === '1';
  const dcName = (() => { try { const m = new Map(listDatacenters().map((d) => [d.id, d.name || d.id])); return (id) => m.get(id) || id || ''; } catch { return (id) => id || ''; } })();
  const send = () => {
    const list = withPw ? listScanRanges().map((e) => getScanRangeRaw(e.id) || e) : listScanRanges();
    const csv = scanRangesToCsv(list, dcName, { includeSecrets: withPw });
    logAudit({ user: req.user?.username, action: withPw ? 'iDRAC ì¤ìº ëì­ CSV ë´ë³´ë´ê¸°(ë¹ë°ë²í¸ í¬í¨)' : 'iDRAC ì¤ìº ëì­ CSV ë´ë³´ë´ê¸°', detail: `${list.length}ê±´`, ip: req.ip || '' });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="idrac-scan-ranges${withPw ? '-with-passwords' : ''}.csv"`);
    res.send(csv);
  };
  if (withPw) return requireSettingsOwner(req, res, send);
  send();
});

adminRouter.get('/idrac/scan-ranges/sample.csv', adminOnly, (_req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="idrac-scan-ranges-sample.csv"');
  res.send(scanRangesSampleCsv());
});

adminRouter.post('/idrac/scan-ranges/import', adminOnly, (req, res) => {
  const { rows, error } = parseScanRangesCsv(String(req.body?.csv || ''));
  if (error) return res.status(400).json({ ok: false, reason: error });
  if (!rows.length) return res.status(400).json({ ok: false, reason: 'ê°ì ¸ì¬ ë°ì´í° íì´ ììµëë¤.' });

  // ë²ì¸ ì´ë¦/ID â ID(ëìë¬¸ì ë¬´ì). ëª» ì°¾ì¼ë©´ null â ì¤ë¥ íì (ì¤íë¡ ì ë ¹ ë²ì¸ ìì± ë°©ì§).
  let dcs = [];
  try { dcs = listDatacenters(); } catch { /* ëª©ë¡ ì¤í¨ ì ìë resolve ê° ì ë¶ null â ì  í ì¤ë¥ */ }
  const resolveDc = (v) => {
    const s = String(v || '').trim();
    if (!s) return null;
    if (dcs.some((d) => d.id === s)) return s;
    const byName = dcs.find((d) => String(d.name || '').toLowerCase() === s.toLowerCase());
    return byName ? byName.id : null;
  };
  // (ë²ì¸,ìë¹ì¤) â ê¸°ì¡´ ìí¸ë¦¬ id ëª©ë¡(2ê° ì´ìì´ë©´ ëª¨í¸ â í ì¤ë¥).
  const all = listScanRanges();
  const existingIds = (dcId, service) => all
    .filter((e) => e.datacenterId === dcId && String(e.service || '').toLowerCase() === String(service || '').toLowerCase())
    .map((e) => e.id);

  const { report, summary } = analyzeScanRangesImport(rows, { resolveDc, existingIds });
  if (req.body?.dryRun) return res.json({ ok: true, dryRun: true, report, summary, total: rows.length });

  const allowOverwrite = req.body?.overwrite === true;
  let added = 0, overwritten = 0; const failed = []; const skipped = [];
  const verdictByLine = new Map(report.map((r) => [r.line, r])); // O(rows²) find → O(rows) (v2.342 성능)
  for (const row of rows) {
    const verdict = verdictByLine.get(row._line);
    if (verdict?.action === 'error') { failed.push({ line: verdict.line, datacenter: row.datacenter, reason: verdict.reason }); continue; }
    const ids = existingIds(verdict.dcId, row.service);
    if (ids.length === 1 && !allowOverwrite) { skipped.push({ line: row._line, datacenter: row.datacenter, reason: 'ê¸°ì¡´ í­ëª© â ë®ì´ì°ê¸° ë¯¸íì©(overwrite íì¸ íì)' }); continue; }
    const input = { id: ids[0], datacenterId: verdict.dcId, service: row.service, ranges: row.ranges,
      username: row.username, agent: row.agent, dispatch: row.dispatch, enabled: row.enabled, mode: row.mode };
    if (row._hasPassword) input.password = row.password; // ë¹ì°ë©´ ê¸°ì¡´ ì ì§(saveScanRanges ê·ì¹)
    const r = saveScanRanges(input);
    if (r.ok) { if (ids.length === 1) overwritten++; else added++; }
    else failed.push({ line: row._line, datacenter: row.datacenter, reason: r.reason });
  }
  logAudit({ user: req.user?.username, action: 'iDRAC ì¤ìº ëì­ CSV ê°ì ¸ì¤ê¸°', detail: `ì¶ê° ${added}Â·ë®ì´ì°ê¸° ${overwritten}Â·ê±´ëë ${skipped.length}Â·ì¤í¨ ${failed.length}`, ip: req.ip || '' });
  res.json({ ok: true, added, overwritten, skipped, failed, total: rows.length });
});

// ì§ê¸ ì¤ìº(ë¹ëê¸°). Body: { id? }(ìí¸ë¦¬ íë) | { datacenterId? }(ê·¸ ë²ì¸ì ëª¨ë  ìë¹ì¤) | {}(ì ì²´ enabled).
adminRouter.post('/idrac/scan-ranges/scan', adminOnly, (req, res) => {
  const id = String(req.body?.id || '').trim();
  const datacenterId = String(req.body?.datacenterId || req.body?.vcenterId || '').trim();
  const opts = id ? { id } : datacenterId ? { datacenterId } : {};
  const r = startIdracScanNow(opts);
  logAudit({ user: req.user?.username, action: 'iDRAC ëì­ ì¦ì ì¤ìº', target: id || datacenterId || '(ì ì²´)' });
  res.status(r.ok ? 200 : 400).json({ ...r, status: idracScanStatus() });
});
// ì§í ìí(ê°ë²¼ì´ í´ë§ì©).
adminRouter.get('/idrac/scan-ranges/status', adminOnly, (_req, res) => res.json({ ok: true, status: idracScanStatus() }));

// ì¤ìº ë¡ê·¸(ì´ë ¥) â ì£¼ê¸°/ìë ì¤ìºì ë²ì¸ë³ ì¤í ê¸°ë¡. datacenterId ë¯¸ì§ì  = ì ì²´ íµí©.
adminRouter.get('/idrac/scan-log', adminOnly, (req, res) => {
  const datacenterId = String(req.query.datacenterId || '').trim();
  const limit = Number(req.query.limit) || 300;
  res.json({ ok: true, entries: listIdracScanLog({ datacenterId, limit }), datacenters: idracScanLogDatacenters() });
});

// ì¤ìº ì¤ì§ â ì§í ì¤ ì¤ì ì§ì  ì¤ìº ì¤ë¨ + ëê¸° ì¤ ìì ì¡ ì·¨ì(ì´ë¯¸ ì¸ì¶ë ìì ì¡ì ìê²© ì¤ì§ ë¶ê°).
adminRouter.post('/idrac/scan-ranges/stop', adminOnly, (req, res) => {
  const r = stopIdracScanNow();
  logAudit({ user: req.user?.username, action: 'iDRAC ì¤ìº ì¤ì§', target: '(ì ì²´)', detail: `ì¤ìì¤ë¨=${r.stoppingCentral} ììì·¨ì=${r.canceledJobs}` });
  res.json({ ...r, status: idracScanStatus() });
});

// ì£¼ê¸° ì¤ìº ê°ê²© ì¤ì (ìê° ë¨ì, 0=ì£¼ê¸° ëÂ·ìëë§). ì ì¥ ì¦ì íì´ë¨¸ ì¬ì ì©, ìê·¸ë ì´ë íìë ì ì§.
adminRouter.put('/idrac/scan-ranges/interval', adminOnly, (req, res) => {
  const hours = Number(req.body?.hours);
  if (!Number.isFinite(hours) || hours < 0 || hours > 720) return res.status(400).json({ ok: false, reason: 'ì£¼ê¸°ë 0~720 ìê°ì´ì´ì¼ í©ëë¤(0=ì£¼ê¸° ë).' });
  const r = setIdracScanIntervalMs(Math.round(hours * 3_600_000));
  if (r.ok) logAudit({ user: req.user?.username, action: 'iDRAC ì¤ìº ì£¼ê¸° ë³ê²½', target: `${hours}ìê°` });
  res.status(r.ok ? 200 : 500).json({ ...r, status: idracScanStatus() });
});

// ì¤ìº íí© â ì£¼ê¸° ì¤ìºë ìí + ì§í ì¤Â·ìµê·¼ ìì ì¤ìº/ë±ë¡ ì¡ ëª©ë¡(ì´ëìë  ì§í íì¸ì©).
// ìì ì¤ìºì¼ë¡ ìì´ì í¸ íì§ ë±ë¡ë ì ë ¥ì 'ìê²© ìì§(collector)'ë¡ ë°ìëë¯ë¡, ì¤ìº ìì´ì í¸ê°
// ìì§ ìë²ë¡ ë±ë¡ë¼ ìëì§ UIê° ì§ë¨í  ì ìê² ìì§ ìë² ìì½(ìí í¬í¨)ë í¨ê» ë°ííë¤.
adminRouter.get('/idrac/scan-jobs', adminOnly, (_req, res) => {
  const st = allCollectorStatus();
  const collectors = listCollectors().map((c) => ({
    id: c.id, name: c.name, datacenter: c.datacenter || '', enabled: c.enabled !== false,
    ok: st[c.id]?.ok ?? null, hosts: st[c.id]?.ok ? (st[c.id]?.hosts ?? 0) : 0, at: st[c.id]?.at || null, error: st[c.id]?.error || null,
  }));
  res.json({ ok: true, status: idracScanStatus(), jobs: listIdracScanJobs(), collectors, centralEnabled: Boolean(config.central.token) });
});

// ì¤ìº ì¡ ì¸ë¶ ë¡ê·¸ â 'ì¤ìº íí©' ë¡ê·¸ì°½. ì´ë²¤í¸ íìë¼ì¸ + ë©ì¶¤ ì§ë¨(hints).
adminRouter.get('/idrac/scan-job-log', adminOnly, (req, res) => {
  // ìì§ ìë²(ìê²©)ë¡ ë±ë¡ë id/ì´ë¦(ìë¬¸ì) â 'ë±ë¡Â·ì ìì¸ë° í´ë§ë§ ìì' ì§ë¨ì ì¬ì©.
  const collectors = new Set();
  for (const c of listCollectors()) { if (c.id) collectors.add(String(c.id).toLowerCase()); if (c.name) collectors.add(String(c.name).toLowerCase()); }
  const r = getIdracScanJobLog(String(req.query.reqId || ''), { collectors });
  res.status(r.ok ? 200 : 404).json(r);
});

// ê°ë³ ëê¸° ì¡ ì·¨ì â ìëª»ë AGENT_NAME ë±ì¼ë¡ ììí 'ëê¸°'íë ì¡ íëë¥¼ ì ì²´ ì¤ì§ ìì´ ì ë¦¬.
adminRouter.post('/idrac/scan-job/cancel', adminOnly, (req, res) => {
  const reqId = String(req.body?.reqId || '');
  const r = cancelIdracScanJob(reqId);
  if (r.ok) logAudit({ user: req.user?.username, action: 'iDRAC ëê¸° ì¡ ì·¨ì', target: reqId });
  res.status(r.ok ? 200 : 400).json(r);
});

// ìë² ì¼ê´ ì­ì . Body: { all:true } ëë { vcenterId } (ë¹ ë¬¸ìì´=ë¯¸ì§ì  ìë² ì­ì ).
adminRouter.post('/idrac/delete', adminOnly, (req, res) => {
  const b = req.body || {};
  const result = b.all
    ? deleteServers({ all: true })
    : (Object.prototype.hasOwnProperty.call(b, 'vcenterId')
      ? deleteServers({ vcenterId: b.vcenterId })
      : { ok: false, reason: 'all=true ëë vcenterIdê° íìí©ëë¤.' });
  if (result.ok) pollNow().catch(() => {});
  res.status(result.ok ? 200 : 400).json(result);
});

// ë¤ì iDRAC ìë²ì ìì vCenter ì¼ê´ ì§ì /í´ì . Body: { ids?:[], vcenterId, all? }
// ids ë¯¸ì§ì  + all=true â ì ì²´ ì ì©. ë¹ vcenterId = ì§ì  í´ì (ì´ë¦/íê·¸ ë§¤ì¹­ì¼ë¡ ë³µê·).
adminRouter.post('/idrac/assign-vcenter', adminOnly, (req, res) => {
  const b = req.body || {};
  const ids = b.all ? null : (Array.isArray(b.ids) ? b.ids : []);
  if (!b.all && (!ids || !ids.length)) return res.status(400).json({ ok: false, reason: 'ëì(ids) ëë all=trueê° íìí©ëë¤.' });
  const result = assignVcenter({ ids, vcenterId: b.vcenterId || '' });
  if (result.ok) pollNow().catch(() => {});
  res.json(result);
});

// íë¼ë¯¸í° ë¼ì°í¸ë ë°ëì ìì ëª¨ë  ë¦¬í°ë´ '/idrac/...' ë¼ì°í¸ ë¤ì ëë¤. ê·¸ë ì§ ìì¼ë©´
// PUT/DELETE '/idrac/:id'ê° '/idrac/scan-ranges'Â·'/idrac/power-settings' ê°ì ë¦¬í°ë´ì ê°ë ¤
// id="scan-ranges"ë¡ ìëª» ì²ë¦¬ëì´ 'ìë ìë²: scan-ranges' ì¤ë¥ê° ëë¤.
adminRouter.put('/idrac/:id', adminOnly, async (req, res) => {
  const result = updateServer(req.params.id, req.body || {});
  if (result.ok) pollNow().catch(() => {});
  res.status(result.ok ? 200 : 400).json(result);
});

adminRouter.delete('/idrac/:id', adminOnly, async (req, res) => {
  const result = removeServer(req.params.id);
  res.status(result.ok ? 200 : 404).json(result);
});
}
