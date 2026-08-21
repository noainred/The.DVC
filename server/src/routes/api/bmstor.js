// ë² ì´ë©í ì¤í ë¦¬ì§(v2.340, ì¬ì©ì ìêµ¬) â ìë² SSH(df)ë¡ ë¡ì»¬ ëì¤í¬ ë§ì´í¸ ì©ëì ì£¼ê¸° ìì§í´
// ìë²/ê·¸ë£¹/ì ì²´ í©ì°(ì´Â·ì¬ì©Â·ê°ì©)ì ë³´ì¬ì¤ë¤. ì ë¶ adminOnly(SSH ìê²©ì¦ëªÂ·í¸ì¤í¸ êµ¬ì±).
import { requireRole } from '../../auth/auth.js';
import { logAudit } from '../../audit.js';
import { listBmServers, listBmServersRaw, saveBmServer, removeBmServer, getBmSettings, saveBmSettings, bmServerInputIssue } from '../../bmstor/registry.js';
import { getBmLatest, bmCollectNow, bmPollerStatus } from '../../bmstor/poller.js';
import { aggregate } from '../../bmstor/agg.js';
import { bmServersToCsv, sampleCsv as bmSampleCsv, parseBmServersCsv, analyzeBmServersImport } from '../../bmstor/csv.js';
import { listCollectors } from '../../collector/registry.js';
import { requireSettingsOwner } from '../admin/shared.js';

const adminOnly = requireRole('admin');

export function registerBmStorage(api) {
  // íí© â ìë² ëª©ë¡(ë¹ë° redact) + ìµì  ìì§ì í©ì°(ìë²/ê·¸ë£¹/ì ì²´)í´ ë°í. ì£ì§ ì½¤ë³´ì© ëª©ë¡ í¬í¨.
  api.get('/tools/bm-storage', adminOnly, (_req, res) => {
    const servers = listBmServers();
    const { total, groups, perServer } = aggregate(servers, getBmLatest());
    res.json({
      ok: true, total, groups, servers: perServer,
      config: servers, // í¸ì§ í¼ì© ìë³¸(ë§ì´í¸ ëª©ë¡ í¬í¨, ë¹ë°ë²í¸ë hasPassword ë§)
      settings: getBmSettings(), status: bmPollerStatus(),
      agents: listCollectors().map((c) => c.id), // ìì ê°ë¥í ì£ì§(ìì§ ìë²) ì´ë¦ ëª©ë¡
    });
  });

  // ìë² ì¶ê°/ìì  â body { id?, name, host, port, username, password?, agent, group, mounts, enabled }
  api.post('/tools/bm-storage/servers', adminOnly, (req, res) => {
    const r = saveBmServer(req.body || {});
    if (r.ok) logAudit({ user: req.user?.username, action: 'ë² ì´ë©í ì¤í ë¦¬ì§ ìë² ì ì¥', target: r.server?.host || '', detail: `mounts ${(r.server?.mounts || []).length}ê°${r.server?.agent ? ` Â· ì£ì§ ${r.server.agent}` : ''}`, ip: req.ip || '' });
    res.status(r.ok ? 200 : 400).json(r);
  });

  api.delete('/tools/bm-storage/servers/:id', adminOnly, (req, res) => {
    const r = removeBmServer(req.params.id);
    if (r.ok) logAudit({ user: req.user?.username, action: 'ë² ì´ë©í ì¤í ë¦¬ì§ ìë² ì­ì ', target: req.params.id, ip: req.ip || '' });
    res.status(r.ok ? 200 : 404).json(r);
  });

  // ìì§ ì£¼ê¸° ì ì¥(ë¶) â í´ë¬ê° 30ì´ í±ë§ë¤ ì¤ì ì ë¤ì ì½ì¼ë¯ë¡ ì¬ê¸°ë ìì´ ë°ìëë¤.
  api.put('/tools/bm-storage/settings', adminOnly, (req, res) => {
    const r = saveBmSettings(req.body || {});
    if (r.ok) logAudit({ user: req.user?.username, action: 'ë² ì´ë©í ì¤í ë¦¬ì§ ì£¼ê¸° ë³ê²½', target: `${r.settings.intervalMinutes}ë¶`, ip: req.ip || '' });
    res.status(r.ok ? 200 : 400).json(r);
  });

  /* ââ ìë² CSV ì¼ê´ ê´ë¦¬(v2.341, ì¬ì©ì ìêµ¬ â ë¤ì ìë² ë±ë¡). ìì§ ìë² CSV(v2.338)ì ëì¼ ê³¨ê²©:
   * ê¸°ë³¸ export ë ë¹ë°ë²í¸ ì ì¸(?secrets=1 ì ì¤ì  ìì ì + ê°ì¬ë¡ê·¸), ê°ì ¸ì¤ê¸°ë ëë¼ì´ë° â
   * ë®ì´ì°ê¸°(overwrite=true ëªì) 2ë¨ê³. agent ë ë±ë¡ë ìì§ ìë²(ìê²©) ì´ë¦ë§ íì©. ââ */
  api.get('/tools/bm-storage/export.csv', adminOnly, (req, res) => {
    const withPw = String(req.query.secrets || '') === '1';
    const send = () => {
      const list = withPw ? listBmServersRaw() : listBmServers();
      const csv = bmServersToCsv(list, { includeSecrets: withPw });
      logAudit({ user: req.user?.username, action: withPw ? 'ë² ì´ë©í ì¤í ë¦¬ì§ CSV ë´ë³´ë´ê¸°(ë¹ë°ë²í¸ í¬í¨)' : 'ë² ì´ë©í ì¤í ë¦¬ì§ CSV ë´ë³´ë´ê¸°', detail: `${list.length}ë`, ip: req.ip || '' });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="bm-storage-servers${withPw ? '-with-passwords' : ''}.csv"`);
      res.send(csv);
    };
    if (withPw) return requireSettingsOwner(req, res, send);
    send();
  });

  api.get('/tools/bm-storage/sample.csv', adminOnly, (_req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="bm-storage-servers-sample.csv"');
    res.send(bmSampleCsv());
  });

  api.post('/tools/bm-storage/import', adminOnly, (req, res) => {
    const { rows, error } = parseBmServersCsv(String(req.body?.csv || ''));
    if (error) return res.status(400).json({ ok: false, reason: error });
    if (!rows.length) return res.status(400).json({ ok: false, reason: 'ê°ì ¸ì¬ ë°ì´í° íì´ ììµëë¤.' });

    const all = listBmServers();
    const existingId = (host, port, user) => all.find((s) =>
      String(s.host).trim() === String(host).trim()
      && String(s.port || 22) === String(port || 22)
      && String(s.username || '') === String(user || ''))?.id;
    const agentSet = new Set(listCollectors().map((c) => String(c.id).toLowerCase()));
    const validAgent = (a) => agentSet.has(String(a).trim().toLowerCase());

    const { report, summary } = analyzeBmServersImport(rows, { existingId, validate: bmServerInputIssue, validAgent });
    if (req.body?.dryRun) return res.json({ ok: true, dryRun: true, report, summary, total: rows.length });

    const allowOverwrite = req.body?.overwrite === true;
    let added = 0, overwritten = 0; const failed = []; const skipped = [];
    const verdictByLine = new Map(report.map((r) => [r.line, r])); // O(rows²) find → O(rows) (v2.342 성능)
    for (const row of rows) {
      const verdict = verdictByLine.get(row._line);
      if (verdict?.action === 'error') { failed.push({ line: verdict.line, host: row.host, reason: verdict.reason }); continue; }
      const id = existingId(row.host, row.port, row.username);
      if (id && !allowOverwrite) { skipped.push({ line: row._line, host: row.host, reason: 'ê¸°ì¡´ í­ëª© â ë®ì´ì°ê¸° ë¯¸íì©(overwrite íì¸ íì)' }); continue; }
      const input = { id, name: row.name, host: row.host, port: row.port, username: row.username,
        group: row.group, agent: row.agent, dispatch: row.dispatch, mounts: row.mounts, enabled: row.enabled };
      if (row._hasPassword) input.password = row.password; // ë¹ì°ë©´ ê¸°ì¡´ ì ì§(saveBmServer ê·ì¹)
      const r = saveBmServer(input);
      if (r.ok) { if (id) overwritten++; else added++; }
      else failed.push({ line: row._line, host: row.host, reason: r.reason });
    }
    logAudit({ user: req.user?.username, action: 'ë² ì´ë©í ì¤í ë¦¬ì§ CSV ê°ì ¸ì¤ê¸°', detail: `ì¶ê° ${added}Â·ë®ì´ì°ê¸° ${overwritten}Â·ê±´ëë ${skipped.length}Â·ì¤í¨ ${failed.length}`, ip: req.ip || '' });
    res.json({ ok: true, added, overwritten, skipped, failed, total: rows.length });
  });

  // ì§ê¸ ìì§ â ì§í ì¤ì´ë©´ skipped(ì¬ì§ì ê°ë ê³µì , net/monitor.runMonitorNow í¨í´).
  api.post('/tools/bm-storage/collect', adminOnly, async (req, res) => {
    const r = await bmCollectNow('manual');
    if (r.ok) logAudit({ user: req.user?.username, action: 'ë² ì´ë©í ì¤í ë¦¬ì§ ìë ìì§', detail: `ìë² ${r.servers} Â· ì±ê³µ ${r.okCount} Â· ì¤ë¥ ${r.errors}`, ip: req.ip || '' });
    res.status(r.ok ? 200 : 409).json(r);
  });
}
