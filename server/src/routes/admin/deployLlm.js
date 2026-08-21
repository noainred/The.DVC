// ì¤íë¼ì¸ í¨í¤ì§Â·ìì´ì í¸ ë°°í¬Â·LLM/OllamaÂ·ë¦´ë¦¬ì¤ ë¸í¸ â admin.js(êµ¬ 2,410ì¤) ë¶í (v2.285.0). ë³¸ë¬¸ì ìë³¸ ê·¸ëë¡, ë±ë¡ ììë admin.js í¸ì¶ ììê° ë³´ì¡´íë¤.
import { config } from '../../config.js';
import { saveNote, deleteNote } from '../../release-notes.js';
import { loadLlmConfig, saveLlmConfig } from '../../llm/config.js';
import { ollamaTest } from '../../llm/ollama.js';
import { installOllama } from '../../llm/ollamaDeploy.js';
import { deployAgent, testTarget, installerInfo, checkAgentStatus } from '../../agent/deploy.js';
import { fetchRemoteVersions, listLocalPackages, downloadPackage } from '../../upgrade/fetchPackage.js';
import { getPackageSettings, savePackageSettings } from '../../upgrade/packageSettings.js';
import { listTargets, getTargetRaw, saveTarget, removeTarget, recordResult, findTargetByHost, listTargetsRaw } from '../../agent/deployRegistry.js';
import { targetsToCsv, sampleCsv as deploySampleCsv, parseTargetsCsv, analyzeTargetsImport } from '../../agent/deployCsv.js';
import { logAudit } from '../../audit.js';
import { centralTokenInfo } from '../../central/token.js';
import path from 'node:path';
import { addCollector, updateCollector, loadCollectors } from '../../collector/registry.js';
import { pullNow } from '../../collector/puller.js';
import { adminOnly, ensureCollectorDatacenter, requireSettingsOwner } from './shared.js';


// ë°°í¬ ì±ê³µ í, ê·¸ í¸ì¤í¸ë¥¼ ì¤ìì 'ìì§ ìë²'ë¡ ìë ë±ë¡(ì¤ì¹+ë±ë¡ ìí´ë¦­).
// collectorTokenì´ ìê³  registerCollector!==false ì¼ ëë§. ê°ì idë©´ ê°±ì .
function autoRegisterCollector(target, portalPort) {
  if (!target?.collectorToken || target.registerCollector === false) return null;
  const port = Number(portalPort) || 4000;
  const id = (String(target.collectorDatacenter || target.agentName || target.host || '').trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')) || `col-${target.host}`;
  const url = `http://${target.host}:${port}`;
  const body = { id, name: target.agentName || target.collectorDatacenter || target.host, datacenter: target.collectorDatacenter || '', url, token: target.collectorToken, enabled: true };
  const exists = loadCollectors().find((c) => c.id === id);
  const r = exists ? updateCollector(id, body) : addCollector(body);
  if (r.ok) { ensureCollectorDatacenter(r.collector); pullNow().catch(() => {}); }
  return r.ok ? { registered: true, id, url, updated: !!exists } : { registered: false, reason: r.reason };
}

export function registerDeployLlm(adminRouter) {

// --- Package auto-download (upgrade/install packages â packages dir) ---
adminRouter.get('/packages', adminOnly, async (req, res) => {
  const s = getPackageSettings();
  let remote = null;
  try { remote = await fetchRemoteVersions(req.query.baseUrl || s.baseUrl); }
  catch (e) { remote = { error: e.message }; }
  res.json({ dir: s.dir, baseUrl: s.baseUrl, settings: s, local: listLocalPackages(), remote });
});
// Web-editable package source (repository URL / download dir / token).
adminRouter.put('/packages/settings', adminOnly, (req, res) => {
  res.json({ ok: true, settings: savePackageSettings(req.body || {}) });
});
adminRouter.post('/packages/download', adminOnly, async (req, res) => {
  try { const r = await downloadPackage(req.body || {}); res.status(r.ok ? 200 : 400).json(r); }
  catch (e) { res.status(400).json({ ok: false, reason: e.message }); }
});

// --- iDRAC-scan agent auto-deploy (SSH push install) ---
adminRouter.get('/agent-deploy/installer', adminOnly, (req, res) => res.json(installerInfo(req.query.path)));
// ë°°í¬ í¼ ìë ì±ì°ê¸°ì© ê¸°ë³¸ê°: ì¤ì URL(ì ìí í¸ì¤í¸ ê¸°ì¤ ì¶ì ) + í¬í í¬í¸ + í í° ìí.
adminRouter.get('/agent-deploy/defaults', adminOnly, (req, res) => {
  const host = (req.get('host') || `localhost:${config.port}`).replace(/\/+$/, '');
  const proto = (req.get('x-forwarded-proto') || req.protocol || 'http').split(',')[0];
  res.json({
    centralUrl: `${proto}://${host}`,
    portalPort: config.port,
    central: centralTokenInfo(),
  });
});

adminRouter.post('/agent-deploy/test', adminOnly, async (req, res) => {
  res.json(await testTarget(req.body || {}));
});

adminRouter.post('/agent-deploy', adminOnly, async (req, res) => {
  // SSH í¬í¸(target.port)ì í¬í í¬í¸(portalPort)ë¥¼ í¼ëíì§ ìëë¡ ë¶ë¦¬.
  // portalPortë§ install.sh --port ë¡ ì ë¬(ìì  ë²ê·¸: SSH 22ê° í¬í í¬í¸ë¡ ë¤ì´ê° EACCES).
  const { installerPath, portalPort, ...target } = req.body || {};
  const r = await deployAgent(target, { installerPath, port: Number(portalPort) || 4000 });
  if (r.ok) r.collector = autoRegisterCollector(target, portalPort); // ì¤ì¹ ì±ê³µ ì ì¤ìì ìì§ ìë²ë¡ ìë ë±ë¡
  // ë°°í¬ì ì¬ì©í ì¤ì (gpuGuestÂ·ìì´ì í¸ ì¤ì  í¬í¨)ì 'ì ì¥ë ëì'ì ë°ìí´ 'í¸ì§' ì ê·¸ëë¡ ë³´ì´ê² íë¤.
  // idê° ìì¼ë©´ ê°ì í¸ì¤í¸ì ê¸°ì¡´ ëìì ì°¾ì ê°±ì (ì¤ë³µ ìì± ë°©ì§). 'ë°°í¬+ì¤ì¹'ë§ ëë¬ë ì¤ì ì´ ì ì¤ëì§ ìì.
  try {
    const b = req.body || {};
    if (b.host) {
      const id = b.id || findTargetByHost(b.host, b.port, b.username)?.id;
      saveTarget({ ...b, id });
      r.targetSaved = true;
    }
  } catch { /* ì ì¥ ì¤í¨ë ë°°í¬ ê²°ê³¼ì ìí¥ ì£¼ì§ ìì */ }
  res.status(r.ok ? 200 : 400).json(r);
});

// Saved targets + bulk deploy.
adminRouter.get('/agent-deploy/targets', adminOnly, (_req, res) => res.json({ targets: listTargets() }));

adminRouter.post('/agent-deploy/targets', adminOnly, (req, res) => {
  const r = saveTarget(req.body || {});
  res.status(r.ok ? 200 : 400).json(r);
});

adminRouter.delete('/agent-deploy/targets/:id', adminOnly, (req, res) => {
  const r = removeTarget(req.params.id);
  res.status(r.ok ? 200 : 400).json(r);
});

/* ââ ë°°í¬ ëì CSV ì¼ê´ ê´ë¦¬(v2.339, ì¬ì©ì ìêµ¬) â ìì§ ìë² CSV(v2.338)ì ëì¼ ê³¨ê²©. ââââââ
 * ë´ë³´ë´ê¸° ê¸°ë³¸ì ë¹ë°ê°(password/centralToken/collectorToken) ì ì¸, ?secrets=1 ì
 * requireSettingsOwner + ê°ì¬ë¡ê·¸. ê°ì ¸ì¤ê¸°ë dryRun(ë¬¸ë² ê²ì¦) â ì»¤ë° 2ë¨ê³ì´ê³ ,
 * (host,port,username)ì´ ê²¹ì¹ë íì body.overwrite=true ëªì ììë§ ê°±ì íë¤.
 * privateKey(ë©í°ë¼ì¸)Â·gpuGuest(ì¤ì²©)ë CSV ë¯¸ì§ì â ê°ì ¸ì¤ê¸°ê° ê±´ëë¦¬ì§ ìì ê¸°ì¡´ê° ì ì§.
 */
adminRouter.get('/agent-deploy/targets/export.csv', adminOnly, (req, res) => {
  const withSecrets = String(req.query.secrets || '') === '1';
  const send = () => {
    const list = withSecrets ? listTargetsRaw() : listTargets();
    const csv = targetsToCsv(list, { includeSecrets: withSecrets });
    logAudit({ user: req.user?.username, action: withSecrets ? 'ë°°í¬ ëì CSV ë´ë³´ë´ê¸°(ë¹ë° í¬í¨)' : 'ë°°í¬ ëì CSV ë´ë³´ë´ê¸°', detail: `${list.length}ë`, ip: req.ip || '' });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="agent-deploy-targets${withSecrets ? '-with-secrets' : ''}.csv"`);
    res.send(csv);
  };
  if (withSecrets) return requireSettingsOwner(req, res, send);
  send();
});

adminRouter.get('/agent-deploy/targets/sample.csv', adminOnly, (_req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="agent-deploy-targets-sample.csv"');
  res.send(deploySampleCsv());
});

adminRouter.post('/agent-deploy/targets/import', adminOnly, (req, res) => {
  const { rows, error } = parseTargetsCsv(String(req.body?.csv || ''));
  if (error) return res.status(400).json({ ok: false, reason: error });
  if (!rows.length) return res.status(400).json({ ok: false, reason: 'ê°ì ¸ì¬ ë°ì´í° íì´ ììµëë¤.' });

  const existingId = (host, port, user) => findTargetByHost(host, port, user)?.id;
  const { report, summary } = analyzeTargetsImport(rows, { existingId });
  if (req.body?.dryRun) return res.json({ ok: true, dryRun: true, report, summary, total: rows.length });

  const allowOverwrite = req.body?.overwrite === true;
  let added = 0, overwritten = 0; const failed = []; const skipped = [];
  const verdictByLine = new Map(report.map((r) => [r.line, r])); // O(rows²) find → O(rows) (v2.342 성능)
  for (const row of rows) {
    const verdict = verdictByLine.get(row._line);
    if (verdict?.action === 'error') { failed.push({ line: verdict.line, host: row.host, reason: verdict.reason }); continue; }
    const id = existingId(row.host, row.port, row.username);
    if (id && !allowOverwrite) { skipped.push({ line: row._line, host: row.host, reason: 'ê¸°ì¡´ í­ëª© â ë®ì´ì°ê¸° ë¯¸íì©(overwrite íì¸ íì)' }); continue; }
    const input = { id, host: row.host, port: row.port, username: row.username, agentName: row.agentName,
      centralUrl: row.centralUrl, collectorDatacenter: row.collectorDatacenter, portalPort: row.portalPort,
      installerPath: row.installerPath, autoUpgrade: row.autoUpgrade, pushInventory: row.pushInventory, enabled: row.enabled };
    // ë¹ë°ê°ì ê°ì´ ìì ëë§ ì ë¬(ë¹ ê° â saveTarget ì´ ê¸°ì¡´ ì ì§).
    if (row.password) input.password = row.password;
    if (row.centralToken) input.centralToken = row.centralToken;
    if (row.collectorToken) input.collectorToken = row.collectorToken;
    const r = saveTarget(input);
    if (r.ok) { if (id) overwritten++; else added++; }
    else failed.push({ line: row._line, host: row.host, reason: r.reason });
  }
  logAudit({ user: req.user?.username, action: 'ë°°í¬ ëì CSV ê°ì ¸ì¤ê¸°', detail: `ì¶ê° ${added}Â·ë®ì´ì°ê¸° ${overwritten}Â·ê±´ëë ${skipped.length}Â·ì¤í¨ ${failed.length}`, ip: req.ip || '' });
  res.json({ ok: true, added, overwritten, skipped, failed, total: rows.length });
});

adminRouter.post('/agent-deploy/targets/:id/deploy', adminOnly, async (req, res) => {
  const t = getTargetRaw(req.params.id);
  if (!t) return res.status(404).json({ ok: false, reason: 'ëìì ì°¾ì ì ììµëë¤.' });
  const r = await deployAgent(t, { installerPath: t.installerPath, port: t.portalPort });
  if (r.ok) r.collector = autoRegisterCollector(t, t.portalPort); // ì¤ì¹ ì±ê³µ ì ì¤ìì ìì§ ìë²ë¡ ìë ë±ë¡
  recordResult(t.id, r);
  res.status(r.ok ? 200 : 400).json(r);
});

// ì ì¥ë ëìì ìë¹ì¤ ìíë¥¼ ì¬íì¸(ì¬ë°°í¬ ìì´). ê²°ê³¼ë¥¼ 'ë§ì§ë§ ê²°ê³¼'ì ë°ì.
adminRouter.post('/agent-deploy/targets/:id/status', adminOnly, async (req, res) => {
  const t = getTargetRaw(req.params.id);
  if (!t) return res.status(404).json({ ok: false, reason: 'ëìì ì°¾ì ì ììµëë¤.' });
  const r = await checkAgentStatus(t);
  recordResult(t.id, r);
  res.json(r);
});

// Deploy to all enabled saved targets, sequentially (heavy SFTP transfers).
adminRouter.post('/agent-deploy/deploy-all', adminOnly, async (_req, res) => {
  const results = [];
  for (const t of listTargets().filter((x) => x.enabled !== false)) {
    const raw = getTargetRaw(t.id);
    const r = await deployAgent(raw, { installerPath: raw.installerPath, port: raw.portalPort });
    recordResult(t.id, r);
    results.push({ id: t.id, host: t.host, agentName: t.agentName, ok: r.ok, active: r.active, reason: r.reason });
  }
  res.json({ ok: true, deployed: results.filter((r) => r.ok).length, total: results.length, results });
});

// --- Local LLM (Ollama) config for natural-language search ---
adminRouter.get('/llm-config', adminOnly, (_req, res) => res.json({ config: loadLlmConfig() }));
adminRouter.put('/llm-config', adminOnly, (req, res) => res.json({ ok: true, config: saveLlmConfig(req.body || {}) }));
adminRouter.post('/llm-test', adminOnly, async (req, res) => {
  res.json(await ollamaTest({ ...loadLlmConfig(), ...(req.body || {}) }));
});

// SSH-install Ollama on a separate server (test reuses the agent SSH probe).
adminRouter.post('/ollama-deploy/test', adminOnly, async (req, res) => res.json(await testTarget(req.body || {})));
adminRouter.post('/ollama-deploy', adminOnly, async (req, res) => {
  const { mode, binaryPath, model, port, applyToPortal, ...target } = req.body || {};
  const r = await installOllama(target, { mode, binaryPath, model, port, applyToPortal });
  res.status(r.ok ? 200 : 400).json(r);
});

// Record / delete a release note (admin).
adminRouter.post('/release-notes', adminOnly, (req, res) => {
  const r = saveNote(req.body || {});
  res.status(r.ok ? 200 : 400).json(r);
});
adminRouter.delete('/release-notes/:version', adminOnly, (req, res) => {
  const r = deleteNote(req.params.version);
  res.status(r.ok ? 200 : 400).json(r);
});
}
