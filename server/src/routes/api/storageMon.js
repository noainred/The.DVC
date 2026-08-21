// ì¤í ë¦¬ì§ ëª¨ëí°ë§ ë¼ì°í¸(v2.302) â í¹ìê¸°ë¥ 'ì¤í ë¦¬ì§ ëª¨ëí°ë§(Isilon ë±)' íë©´ì©.
// ì¡°í: ì ì²´ ë²ì ê³ì ë§(ì¤í ë¦¬ì§ë vCenter ê·ìì´ ìë ì¸íë¼ ì¥ë¹ â 'vCenter ê·ì ìë
// ë°ì´í°ë ë²ì ê³ì ì ë¸ì¶ ê¸ì§' ê·ì¹, fleet ê³¼ ëì¼ 403 í¨í´). ë³ê²½: adminOnly + ê°ì¬ë¡ê·¸.
import { requireRole } from '../../auth/auth.js';
import { scopedVcenterIds } from '../../auth/scope.js';
import { store } from '../../store.js';
import { logAudit } from '../../audit.js';
import { STORAGE_TYPES } from '../../storage/types.js';
import { listDevices, listDevicesWithSecrets, saveDevice, deleteDevice, deviceInputIssue } from '../../storage/registry.js';
import { requireSettingsOwner } from '../admin/shared.js';
import { localSnapshots, dropSnapshot } from '../../storage/store.js';
import { collectDeviceNow, storagePollerStatus, pollStorageOnce } from '../../storage/poller.js';
import { edgeStorageSnapshots } from '../../central/storageEdge.js';
import { listActivity } from '../../storage/activityLog.js';
import { areaSummary, areaJson, capacityHistory, dbAvailable } from '../../storage/db.js';
import { AREA_LABEL } from '../../storage/onefsCatalog.js';
import { listDatacenters } from '../../datacenter/store.js';
import { knownAgentNames } from '../../central/knownAgents.js';
import { devicesToCsv, sampleCsv, parseDevicesCsv, analyzeImport } from '../../storage/csv.js';
import { requestCollect, hasPendingRequest } from '../../storage/collectRequests.js';

const adminOnly = requireRole('admin');
const fullScopeOnly = (req, res, next) => {
  if (scopedVcenterIds(req.user, store.get())) {
    return res.status(403).json({ ok: false, reason: 'ì¤í ë¦¬ì§ ëª¨ëí°ë§ì ì ì²´ ë²ì(vCenter ì í ìë) ê³ì ë§ ì¡°íí  ì ììµëë¤.' });
  }
  next();
};

export function registerStorageMon(api) {

/**
 * íµí© ì¡°í â ì´ ë¸ë(ì¤ì) ì§ì  ìì§ë¶ + ì  ì£ì§ push ë¶ì í©ì³ ì¥ë¹ë³ ìµì  ì¤ëì·ì ë°í.
 * ê°ì deviceId ê° ììª½ì ìì¼ë©´ ìµì  collectedAt ì°ì . ë²ì¸/íìë³ ë·°ë íë¡ í¸ê° ì´ íí
 * ëª©ë¡ì ê·¸ë£¹ííë¤(ë·° ì¶ê°ê° ìë² ë³ê²½ ìì´ ê°ë¥ â íì¥ ìêµ¬ ë°ì).
 */
api.get('/tools/storage', fullScopeOnly, (_req, res) => {
  const byId = new Map();
  for (const s of [...localSnapshots(), ...edgeStorageSnapshots()]) {
    const cur = byId.get(s.deviceId);
    if (!cur || (s.collectedAt || 0) > (cur.collectedAt || 0)) byId.set(s.deviceId, s);
  }
  const devices = listDevices().map((d) => ({ ...d, snap: byId.get(d.id) || null }));
  // ë±ë¡ë¶ì ìëë° ì¤ëì·ë§ ìë í­ëª©(ì£ì§ ìì¡´ push ë±)ë ì ì§íê² ë¸ì¶(orphan íê¸°).
  const known = new Set(devices.map((d) => d.id));
  const orphans = [...byId.values()].filter((s) => !known.has(s.deviceId));
  res.json({
    devices, orphans,
    types: STORAGE_TYPES,
    datacenters: (() => { try { return listDatacenters(); } catch { return []; } })(),
    // ì£ì§ ëª©ë¡: per-agent í í°ë¿ ìëë¼ ì¤ìê³¼ íµì  ì¤ì¸ ëª¨ë  ìë ¤ì§ ì£ì§ë¥¼ ë³í©(v2.312 â
    // iDRAC ììê³¼ ëì¼ ìì¤). í í° ë¯¸ë°ê¸(ê³µì  CENTRAL_TOKEN) íê²½ììë ì£ì§ë¥¼ ê³ ë¥¼ ì ìë¤.
    agents: knownAgentNames(),
    poller: storagePollerStatus(),
  });
});

api.post('/tools/storage/devices', adminOnly, (req, res) => {
  try {
    const d = saveDevice(req.body || {});
    logAudit({ user: req.user?.username, action: 'ì¤í ë¦¬ì§ ì¥ë¹ ì ì¥', target: `${d.type}/${d.name}`, detail: `${d.host} Â· ìì§=${d.agent || 'ì¤ì'}` });
    res.status(201).json({ ok: true, device: d });
  } catch (e) { res.status(400).json({ ok: false, reason: e.message }); }
});

api.delete('/tools/storage/devices/:id', adminOnly, (req, res) => {
  if (!deleteDevice(req.params.id)) return res.status(404).json({ ok: false, reason: 'ì¥ë¹ë¥¼ ì°¾ì ì ììµëë¤.' });
  dropSnapshot(req.params.id); // ì§ì´ ì¥ë¹ì ë¡ì ì¤ëì·ì´ íë©´ì ì ë ¹ì¼ë¡ ë¨ì§ ìê²
  logAudit({ user: req.user?.username, action: 'ì¤í ë¦¬ì§ ì¥ë¹ ì­ì ', target: req.params.id });
  res.json({ ok: true });
});

/**
 * ìì§ ìì ë¡ê·¸(v2.315, ì¬ì©ì ìêµ¬ 'ì§íì¤/ìë£ ì°½').
 * poller.inFlight = ì§ê¸ ìì§ ì¤ì¸ ì¥ë¹('ì§íì¤'), events = ìµê·¼ ìë£ ì´ë²¤í¸('ìë£', newest-first).
 * ì¡°í ì ì©ì´ë¼ fullScopeOnly(ì¤í ë¦¬ì§ë vCenter ë²ì ë° â ë¤ë¥¸ ì¤í ë¦¬ì§ ì¡°íì ëì¼ ê²ì´í¸).
 */
api.get('/tools/storage/activity', fullScopeOnly, (req, res) => {
  res.json({ poller: storagePollerStatus(), events: listActivity(Number(req.query.limit) || 100) });
});

/**
 * ì ì²´ ìë¡ê³ ì¹¨(v2.315, ì¬ì©ì ìêµ¬) â ì¤ì ì§ì (agent ë¹) ì¥ë¹ë¥¼ ì¦ì ì¬ìì§íë¤.
 * pollStorageOnce ë¥¼ ì¬ì¬ì©í´ í´ë¬ì ì¬ì§ì ê°ëÂ·ë³ë ¬ 3ê° ì íì ê·¸ëë¡ íë¤(ë¶í ííí).
 * ì£ì§ ìì ì¥ë¹ë ìê²©ìì ê°ì í  ì ìì´ ìë¥¼ ì¸ì´ 'ë¤ì ì£¼ê¸° ë°ì'ì¼ë¡ ìë´ë§ íë¤(ì ì§).
 */
api.post('/tools/storage/collect-all', adminOnly, async (req, res) => {
  try {
    const all = listDevices().filter((d) => d.enabled !== false);
    const edge = all.filter((d) => (d.agent || '').trim()).length;
    const central = all.length - edge;
    const result = await pollStorageOnce(); // { ok, fail } ëë { skipped:true }(ì´ë¯¸ ì§í ì¤)
    logAudit({ user: req.user?.username, action: 'ì¤í ë¦¬ì§ ì ì²´ ìë¡ê³ ì¹¨',
      detail: `ì¤ì ${central}ë ì¬ìì§(${result.skipped ? 'ì´ë¯¸ ì§íì¤' : `ì±ê³µ ${result.ok}Â·ì¤í¨ ${result.fail}`})Â·ì£ì§ ${edge}ë ë¤ìì£¼ê¸°` });
    res.json({ ok: true, central, edge, result });
  } catch (e) { res.status(502).json({ ok: false, reason: e.message }); }
});

/**
 * ì§ê¸ ìì§(ì°ê²° íì¤í¸ ê²¸) â ì¤ì ìì§ ì¥ë¹ë ì¦ì, ì£ì§ ìì ì¥ë¹ë **ì¬ìì§ ìì²­ ë±ë¡**.
 * v2.316(ì¬ì©ì ë²ê·¸ ì ê³ ): ê³¼ê±°ì ì£ì§ ì¥ë¹ì ìë´ ë©ìì§ë§ ë°ííê³  ìë¬´ê²ë íì§ ììë¤ â
 * collectRequests íì ìì²­ì ë¨ê¸°ë©´ ì£ì§ê° ë¤ì config pull(â¤5ë¶) ë ì¦ì ìì§ + ì¦ì push íë¤.
 */
api.post('/tools/storage/devices/:id/collect', adminOnly, async (req, res) => {
  try {
    const dev = listDevices().find((d) => d.id === req.params.id);
    if (!dev) return res.status(404).json({ ok: false, reason: 'ì¥ë¹ë¥¼ ì°¾ì ì ììµëë¤.' });
    if ((dev.agent || '').trim()) {
      const dup = hasPendingRequest(dev.id);
      requestCollect(dev.id, dev.agent);
      logAudit({ user: req.user?.username, action: 'ì¤í ë¦¬ì§ ì¬ìì§ ìì²­(ì£ì§)', target: `${dev.name}(${dev.id})`, detail: `ì£ì§ ${dev.agent}` });
      return res.status(202).json({ ok: true, requested: true,
        reason: dup
          ? `ì´ë¯¸ ì¬ìì§ ìì²­ì´ ëê¸° ì¤ìëë¤ â ì£ì§ '${dev.agent}' ì ë¤ì pull(â¤5ë¶) ì ì¦ì ìì§Â·push ë©ëë¤.`
          : `ì¬ìì§ ìì²­ ë±ë¡ â ì£ì§ '${dev.agent}' ê° ë¤ì pull(â¤5ë¶) ì ì¦ì ìì§íê³  ë°ë¡ push í©ëë¤.` });
    }
    await collectDeviceNow(req.params.id);
    logAudit({ user: req.user?.username, action: 'ì¤í ë¦¬ì§ ì¦ì ìì§', target: req.params.id });
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ ok: false, reason: e.message }); }
});


/* ââ CSV ì¼ê´ ê´ë¦¬(v2.313, ì¬ì©ì ìêµ¬) â ë´ë³´ë´ê¸°Â·ìíÂ·ê°ì ¸ì¤ê¸°. ì ë¶ adminOnly(ì¥ë¹ êµ¬ì±). ââ */

const dcNameMap = () => { try { const m = new Map(listDatacenters().map((x) => [x.id, x.name || x.id])); return (id) => m.get(id) || id || ''; } catch { return (id) => id || ''; } };

/**
 * íì¬ ë±ë¡ ì¥ë¹ë¥¼ CSV ë¡ ë´ë³´ë´ê¸°. ê¸°ë³¸ì ë¹ë°ë²í¸ ì ì¸(listDevices ê³ì½).
 * ?passwords=1(v2.317, ì¬ì©ì ìêµ¬ 'í¬í¨ ì¬ë¶ ì í'): íë¬¸ ë¹ë°ë²í¸ í¬í¨ â ìê²©ì¦ëª ì¼ê´
 * ë¤íì´ë¯ë¡ **requireSettingsOwner**(ë°±ì ë¼ì°í¸ì ëì¼ ê²ì´í¸ â server/CLAUDE.md ê·ì¹)ë¥¼
 * ì¶ê°ë¡ íµê³¼í´ì¼ íê³  ê°ì¬ë¡ê·¸ë¥¼ ë¨ê¸´ë¤. admin ì´ì´ë ìì ìê° ìëë©´ 403.
 */
api.get('/tools/storage/devices/export.csv', adminOnly, (req, res) => {
  const withPw = String(req.query.passwords || '') === '1';
  const send = () => {
    const devices = withPw ? listDevicesWithSecrets() : listDevices();
    const csv = devicesToCsv(devices, dcNameMap(), { includePasswords: withPw });
    logAudit({ user: req.user?.username, action: withPw ? 'ì¤í ë¦¬ì§ CSV ë´ë³´ë´ê¸°(ë¹ë°ë²í¸ í¬í¨)' : 'ì¤í ë¦¬ì§ CSV ë´ë³´ë´ê¸°', detail: `${devices.length}ë` });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="storage-devices${withPw ? '-with-passwords' : ''}.csv"`);
    res.send(csv);
  };
  if (withPw) return requireSettingsOwner(req, res, send);
  send();
});

/** ìí CSV ííë¦¿ ë¤ì´ë¡ë â í¤ë + ì»¬ë¼ ì¤ëª ì£¼ì + ìì 2í. */
api.get('/tools/storage/devices/sample.csv', adminOnly, (_req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="storage-devices-sample.csv"');
  res.send(sampleCsv());
});

/**
 * CSV ì¼ê´ ê°ì ¸ì¤ê¸° â body.csv íì¤í¸ë¥¼ íì±í´ íë§ë¤ saveDevice.
 * (host+type) ëì¼ ì¥ë¹ë ìì (update), ìì¼ë©´ ì¶ê°. datacenter ë ì´ë¦/ID ëª¨ë í´ì.
 * íë³ ì±ê³µ/ì¤í¨ë¥¼ ì ì§íê² ë°í(ë¶ë¶ ì±ê³µ íì© â í í ì¤ë¥ê° ì ì²´ë¥¼ ë§ì§ ìì).
 *
 * body.dryRun=true(v2.317, ì¬ì©ì ìêµ¬ 'ë¬´ê²°ì± ê²ì¬'): **ì ì¥íì§ ìê³ ** íë³ íì ë§ ë°í.
 * ê²ì¦ ê·ì¹ì ì¤ì  ì ì¥ê³¼ ëì¼(registry.deviceInputIssue ë¨ì¼ ìì¤ â analyzeImport ì£¼ì) +
 * íì¼ ë´ ì¤ë³µ(host+type) ê²ì¶. UI ë ê²ì¦ íµê³¼ íìë§ ì¤í ë²í¼ì íì±ííë¤.
 */
api.post('/tools/storage/devices/import', adminOnly, (req, res) => {
  const { rows, error } = parseDevicesCsv(String(req.body?.csv || ''));
  if (error) return res.status(400).json({ ok: false, reason: error });
  if (!rows.length) return res.status(400).json({ ok: false, reason: 'ê°ì ¸ì¬ ë°ì´í° íì´ ììµëë¤.' });

  // datacenter ì´ë¦/ID â ID í´ì ì¤ë¹(ì´ë¦ ë§¤ì¹­ì ëìë¬¸ì ë¬´ì).
  let dcs = [];
  try { dcs = listDatacenters(); } catch { /* ëª©ë¡ ì¤í¨ ì ìë¬¸ ê·¸ëë¡ ì ì¥ */ }
  const resolveDc = (v) => {
    const s = String(v || '').trim();
    if (!s) return '';
    if (dcs.some((d) => d.id === s)) return s;
    const byName = dcs.find((d) => String(d.name || '').toLowerCase() === s.toLowerCase());
    return byName ? byName.id : s; // ëª» ì°¾ì¼ë©´ ìë¬¸ ì ì§(ì í¨ ID ì¼ ì ìì)
  };
  // (host+type) â ê¸°ì¡´ ì¥ë¹ id ë§µ(ë©±ë± update). êµ¬ë¶ì '|' â host ì ê·ì(RE_HOST)ì´ ë°°ì íë
  // ë¬¸ìë¼ host/type ê²½ê³ê° ëª¨í¸í´ì§ì§ ìëë¤(ê³¼ê±° NUL êµ¬ë¶ìë ìì¤ NUL ê¸ì§ ê·ì¹ ìë°).
  const key = (h, t) => `${h}|${t}`;
  const existing = new Map(listDevices().map((d) => [key(d.host, d.type), d.id]));

  // ë¬´ê²°ì± ë¶ì(ëë¼ì´ë°Â·ì¤ì  ê°ì ¸ì¤ê¸° ê³µì©) â ì¤ì  ì ì¥ê³¼ ê°ì ê²ì¦ ê·ì¹ì íë¤.
  const { report, summary } = analyzeImport(rows, {
    existingKey: (h, t) => existing.get(key(h, t)),
    resolveDc,
    validate: deviceInputIssue,
  });
  if (req.body?.dryRun) {
    return res.json({ ok: true, dryRun: true, report, summary, total: rows.length });
  }

  let added = 0, updated = 0; const failed = [];

  const verdictByLine = new Map(report.map((r) => [r.line, r])); // O(rows²) find → O(rows) (v2.342 성능)
  for (const row of rows) {
    const verdict = verdictByLine.get(row._line);
    if (verdict?.action === 'error') { failed.push({ line: verdict.line, name: verdict.name, reason: verdict.reason }); continue; }
    const id = existing.get(key(row.host, row.type));
    const input = {
      id, type: row.type, name: row.name, host: row.host, username: row.username,
      collectMethod: row.collectMethod, sshPort: row.sshPort, datacenterId: resolveDc(row.datacenter),
      agent: row.agent, enabled: row.enabled, note: row.note,
    };
    if (row._hasPassword) input.password = row.password; // ë¹ì°ë©´ ê¸°ì¡´ ì ì§(saveDevice ê·ì¹)
    try {
      saveDevice(input);
      if (id) updated++; else added++;
    } catch (e) { failed.push({ line: row._line, name: row.name || row.host, reason: e.message }); }
  }
  logAudit({ user: req.user?.username, action: 'ì¤í ë¦¬ì§ ì¥ë¹ CSV ê°ì ¸ì¤ê¸°', detail: `ì¶ê° ${added}Â·ìì  ${updated}Â·ì¤í¨ ${failed.length}` });
  res.json({ ok: true, added, updated, failed, total: rows.length });
});

/** ìì­ë³ ìì§ íí© + ìë¬¸(ì´ ë¸ë DB â ì¤ì ìì§ ì¥ë¹ ì ì©. ì£ì§ ì¥ë¹ ìë¬¸ì ì£ì§ DB ì ìì). */
api.get('/tools/storage/devices/:id/areas', adminOnly, async (req, res) => {
  res.json({ db: await dbAvailable(), labels: AREA_LABEL, rows: await areaSummary(req.params.id) });
});

/** ìì­ ìë¬¸ JSON 1ê±´ â ?endpoint= (DB api_latest ìµì ë³¸, 512KB ì ë¨ íê¸°). */
api.get('/tools/storage/devices/:id/areas/json', adminOnly, async (req, res) => {
  const row = await areaJson(req.params.id, String(req.query.endpoint || ''));
  if (!row) return res.status(404).json({ ok: false, reason: 'í´ë¹ ìëí¬ì¸í¸ì ì ì¥ë ìë¬¸ì´ ììµëë¤(ì£ì§ ìì§ ì¥ë¹ë©´ ìë¬¸ì ì£ì§ DB ì ììµëë¤).' });
  res.json({ ok: true, ...row });
});

/**
 * ì©ë ìê³ì´(ì¶ì´) â ?days=N (ê¸°ë³¸ 30, 1~400).
 * v2.318(ì¶ì´ ê·¸ëí): 7ì¼ ì´ê³¼ êµ¬ê°ì ~800ì  ëª©íë¡ ìê° ë²í· íê·  ë¤ì´ìí â raw ë
 * LIMIT 5000 ì ìë¶ë¶ë§ ìë ¤ ì¥ê¸° êµ¬ê°ìì ìµê·¼ ë°ì´í°ê° ì ë³´ìë¤(db.js selCapBucket ì£¼ì).
 */
api.get('/tools/storage/devices/:id/history', fullScopeOnly, async (req, res) => {
  const days = Math.max(1, Math.min(400, Number(req.query.days) || 30));
  const bucketMs = days <= 7 ? 0 : Math.ceil((days * 86400e3) / 800);
  res.json({ db: await dbAvailable(), bucketMs, points: await capacityHistory(req.params.id, Date.now() - days * 86400e3, bucketMs) });
});
}
