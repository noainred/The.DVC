// 오프라인 패키지·에이전트 배포·LLM/Ollama·릴리스 노트 — admin.js(구 2,410줄) 분할(v2.285.0). 본문은 원본 그대로, 등록 순서는 admin.js 호출 순서가 보존한다.
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
import { parseTargetsText, analyzeBulkDeploy, targetsToText, targetsToTextCsv, sampleText, sampleTextCsv, fillAutoTokens, COLUMN_PRESETS, DEFAULT_PRESET } from '../../agent/deployText.js';   // 대량 배포 텍스트/CSV(v2.432)
import { startBulkDeploy, getRun, listRuns, cancelRun, activeRunId } from '../../agent/bulkDeploy.js';        // 대량 배포 실행기(v2.432)
import { autoRegisterCollector } from '../../agent/autoRegister.js';
import { logAudit } from '../../audit.js';
import { ipBlockReason } from '../../collector/registry.js';
import crypto from 'node:crypto';
import { centralTokenInfo } from '../../central/token.js';
import path from 'node:path';
import { adminOnly, requireSettingsOwner } from './shared.js';


// 배포 성공 후의 수집 서버 자동 등록은 agent/autoRegister.js 로 이관(v2.432) — 단건·대량 배포가 같은 규칙을 쓴다.

export function registerDeployLlm(adminRouter) {

// --- Package auto-download (upgrade/install packages → packages dir) ---
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
// 배포 폼 자동 채우기용 기본값: 중앙 URL(접속한 호스트 기준 추정) + 포탈 포트 + 토큰 상태.
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
  // SSH 포트(target.port)와 포탈 포트(portalPort)를 혼동하지 않도록 분리.
  // portalPort만 install.sh --port 로 전달(예전 버그: SSH 22가 포탈 포트로 들어가 EACCES).
  const { installerPath, portalPort, ...target } = req.body || {};
  const r = await deployAgent(target, { installerPath, port: Number(portalPort) || 4000 });
  if (r.ok) r.collector = autoRegisterCollector(target, portalPort); // 설치 성공 시 중앙에 수집 서버로 자동 등록
  // 배포에 사용한 설정(gpuGuest·에이전트 설정 포함)을 '저장된 대상'에 반영해 '편집' 시 그대로 보이게 한다.
  // id가 없으면 같은 호스트의 기존 대상을 찾아 갱신(중복 생성 방지). '배포+설치'만 눌러도 설정이 유실되지 않음.
  try {
    const b = req.body || {};
    if (b.host) {
      const id = b.id || findTargetByHost(b.host, b.port, b.username)?.id;
      saveTarget({ ...b, id });
      r.targetSaved = true;
    }
  } catch { /* 저장 실패는 배포 결과에 영향 주지 않음 */ }
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

/* ── 배포 대상 CSV 일괄 관리(v2.339, 사용자 요구) — 수집 서버 CSV(v2.338)와 동일 골격. ──────
 * 내보내기 기본은 비밀값(password/centralToken/collectorToken) 제외, ?secrets=1 은
 * requireSettingsOwner + 감사로그. 가져오기는 dryRun(문법 검증) → 커밋 2단계이고,
 * (host,port,username)이 겹치는 행은 body.overwrite=true 명시 시에만 갱신한다.
 * privateKey(멀티라인)·gpuGuest(중첩)는 CSV 미지원 — 가져오기가 건드리지 않아 기존값 유지.
 */
adminRouter.get('/agent-deploy/targets/export.csv', adminOnly, (req, res) => {
  const withSecrets = String(req.query.secrets || '') === '1';
  const send = () => {
    const list = withSecrets ? listTargetsRaw() : listTargets();
    const csv = targetsToCsv(list, { includeSecrets: withSecrets });
    logAudit({ user: req.user?.username, action: withSecrets ? '배포 대상 CSV 내보내기(비밀 포함)' : '배포 대상 CSV 내보내기', detail: `${list.length}대`, ip: req.ip || '' });
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
  if (!rows.length) return res.status(400).json({ ok: false, reason: '가져올 데이터 행이 없습니다.' });

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
    if (id && !allowOverwrite) { skipped.push({ line: row._line, host: row.host, reason: '기존 항목 — 덮어쓰기 미허용(overwrite 확인 필요)' }); continue; }
    const input = { id, host: row.host, port: row.port, username: row.username, agentName: row.agentName,
      centralUrl: row.centralUrl, collectorDatacenter: row.collectorDatacenter, portalPort: row.portalPort,
      installerPath: row.installerPath, autoUpgrade: row.autoUpgrade, pushInventory: row.pushInventory, enabled: row.enabled };
    // 비밀값은 값이 있을 때만 전달(빈 값 → saveTarget 이 기존 유지).
    if (row.password) input.password = row.password;
    if (row.centralToken) input.centralToken = row.centralToken;
    if (row.collectorToken) input.collectorToken = row.collectorToken;
    const r = saveTarget(input);
    if (r.ok) { if (id) overwritten++; else added++; }
    else failed.push({ line: row._line, host: row.host, reason: r.reason });
  }
  logAudit({ user: req.user?.username, action: '배포 대상 CSV 가져오기', detail: `추가 ${added}·덮어쓰기 ${overwritten}·건너뜀 ${skipped.length}·실패 ${failed.length}`, ip: req.ip || '' });
  res.json({ ok: true, added, overwritten, skipped, failed, total: rows.length });
});

adminRouter.post('/agent-deploy/targets/:id/deploy', adminOnly, async (req, res) => {
  const t = getTargetRaw(req.params.id);
  if (!t) return res.status(404).json({ ok: false, reason: '대상을 찾을 수 없습니다.' });
  const r = await deployAgent(t, { installerPath: t.installerPath, port: t.portalPort });
  if (r.ok) r.collector = autoRegisterCollector(t, t.portalPort); // 설치 성공 시 중앙에 수집 서버로 자동 등록
  recordResult(t.id, r);
  res.status(r.ok ? 200 : 400).json(r);
});

// 저장된 대상의 서비스 상태를 재확인(재배포 없이). 결과를 '마지막 결과'에 반영.
adminRouter.post('/agent-deploy/targets/:id/status', adminOnly, async (req, res) => {
  const t = getTargetRaw(req.params.id);
  if (!t) return res.status(404).json({ ok: false, reason: '대상을 찾을 수 없습니다.' });
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

/* ── 대량 배포(v2.432, 사용자 요구 '엣지노드 배포를 대용량으로 할 수 있게 import export text 방식과
 * 입력 전에 배포하는 기능') ────────────────────────────────────────────────────────────────
 * 기존 CSV 가져오기(v2.339)는 '파일 업로드 → 대상 저장' 전용이고, deploy-all 은 저장된 대상만
 * 순차 배포하며 응답을 끝까지 붙잡는다. 여기서는 **붙여넣은 텍스트로 저장 없이 즉시 배포**하고
 * runId 폴링으로 진행률을 본다. 성공한 노드만 선택적으로 저장·수집 서버 등록.
 * 보안: adminOnly + 감사로그, 응답에 자격증명 없음(auth 방식만), host 는 SSRF 가드를 통과해야 배포된다.
 */
/** 토큰 자동 채움 옵션(순수 조립) — 중앙 토큰은 이 포탈 값, 수집 토큰은 **노드마다 새 난수**. */
function autoTokenOpts(body) {
  return {
    centralToken: body?.autoCentralToken ? (centralTokenInfo().token || '') : '',
    autoCollectorToken: !!body?.autoCollectorToken,
    gen: () => crypto.randomBytes(24).toString('hex'),
  };
}

/** 화면이 고를 수 있는 열 순서 프리셋(헤더가 있으면 헤더가 우선). */
adminRouter.get('/agent-deploy/bulk/presets', adminOnly, (_req, res) => res.json({
  ok: true, presets: Object.entries(COLUMN_PRESETS).map(([k, v]) => ({ key: k, label: v.label, columns: v.columns })),
  defaultPreset: DEFAULT_PRESET, hasCentralToken: !!centralTokenInfo().token,
}));

adminRouter.post('/agent-deploy/bulk/preview', adminOnly, (req, res) => {
  try {
    const text = String(req.body?.text || '');
    if (text.length > 1_000_000) return res.status(400).json({ ok: false, reason: '입력이 1MB 를 넘습니다.' });
    const { rows, skipped, header, columns } = parseTargetsText(text, req.body?.defaults || {}, { columns: req.body?.columns });
    if (!rows.length) return res.status(400).json({ ok: false, reason: '인식된 행이 없습니다. host 열(첫 열)을 확인하거나 샘플을 받아 형식을 맞추세요.', skipped: skipped.slice(0, 50) });
    // 미리보기에서도 토큰 자동 채움을 반영해 '자동 생성' 여부를 보여준다(값은 응답에 넣지 않는다).
    fillAutoTokens(rows, autoTokenOpts(req.body));
    const { report, summary } = analyzeBulkDeploy(rows, {
      existingId: (h, p, u) => findTargetByHost(h, p, u)?.id,
      blockReason: (h) => ipBlockReason(h),
    });
    res.json({ ok: true, report, summary, skipped: skipped.slice(0, 50), header: !!header, columns, total: rows.length });
  } catch (e) { res.status(400).json({ ok: false, reason: e.message }); }
});

adminRouter.post('/agent-deploy/bulk/run', adminOnly, (req, res) => {
  try {
    const text = String(req.body?.text || '');
    if (text.length > 1_000_000) return res.status(400).json({ ok: false, reason: '입력이 1MB 를 넘습니다.' });
    const { rows } = parseTargetsText(text, req.body?.defaults || {}, { columns: req.body?.columns });
    fillAutoTokens(rows, autoTokenOpts(req.body));
    const { report } = analyzeBulkDeploy(rows, {
      existingId: (h, p, u) => findTargetByHost(h, p, u)?.id,
      blockReason: (h) => ipBlockReason(h),
    });
    const badLines = new Set(report.filter((r) => r.action === 'error').map((r) => r.line));
    const only = Array.isArray(req.body?.onlyLines) && req.body.onlyLines.length ? new Set(req.body.onlyLines.map(Number)) : null;
    const targets = rows.filter((r) => !badLines.has(r._line) && (!only || only.has(r._line)));
    if (!targets.length) return res.status(400).json({ ok: false, reason: '배포 가능한 행이 없습니다(미리보기의 오류를 먼저 해결하세요).', errors: report.filter((r) => r.action === 'error').slice(0, 50) });
    const r = startBulkDeploy(targets, {
      saveTargets: req.body?.saveTargets !== false,
      registerCollector: req.body?.registerCollector !== false,
      portalPort: req.body?.portalPort, installerPath: req.body?.installerPath,
      by: req.user?.username || '',
    });
    logAudit({ user: req.user?.username, action: '엣지 노드 대량 배포 시작',
      detail: `${targets.length}대 · 저장=${req.body?.saveTargets !== false} 수집등록=${req.body?.registerCollector !== false} 호스트=${targets.slice(0, 20).map((t) => t.host).join(',')}${targets.length > 20 ? ' …' : ''}`,
      ip: req.ip || '' });
    res.status(r.ok ? 200 : 409).json({ ...r, total: targets.length, skippedErrors: report.filter((x) => x.action === 'error').length });
  } catch (e) { res.status(400).json({ ok: false, reason: e.message }); }
});

adminRouter.get('/agent-deploy/bulk', adminOnly, (_req, res) => res.json({ ok: true, runs: listRuns(), activeRunId: activeRunId() }));
adminRouter.get('/agent-deploy/bulk/:runId', adminOnly, (req, res) => {
  const r = getRun(req.params.runId);
  if (!r) return res.status(404).json({ ok: false, reason: '실행을 찾을 수 없습니다(최근 5회만 보관).' });
  res.json(r);
});
adminRouter.post('/agent-deploy/bulk/:runId/cancel', adminOnly, (req, res) => {
  const r = cancelRun(req.params.runId);
  if (r.ok) logAudit({ user: req.user?.username, action: '엣지 노드 대량 배포 취소', detail: req.params.runId, ip: req.ip || '' });
  res.status(r.ok ? 200 : 400).json(r);
});

/* 텍스트 내보내기 — 붙여넣기 입력칸에 그대로 다시 넣을 수 있는 형식(왕복). 비밀 포함은 소유자 게이트. */
adminRouter.get('/agent-deploy/targets/export.txt', adminOnly, (req, res) => {
  const withSecrets = String(req.query.secrets || '') === '1';
  const send = () => {
    const list = withSecrets ? listTargetsRaw() : listTargets();
    logAudit({ user: req.user?.username, action: withSecrets ? '배포 대상 텍스트 내보내기(비밀 포함)' : '배포 대상 텍스트 내보내기', detail: `${list.length}대`, ip: req.ip || '' });
    const csv = String(req.query.format || '').toLowerCase() === 'csv';
    res.setHeader('Content-Type', csv ? 'text/csv; charset=utf-8' : 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="agent-deploy-targets${withSecrets ? '-with-secrets' : ''}.${csv ? 'csv' : 'txt'}"`);
    res.send(csv ? targetsToTextCsv(list, { includeSecrets: withSecrets }) : targetsToText(list, { includeSecrets: withSecrets }));
  };
  if (withSecrets) return requireSettingsOwner(req, res, send);
  send();
});
adminRouter.get('/agent-deploy/targets/sample.txt', adminOnly, (req, res) => {
  const csv = String(req.query.format || '').toLowerCase() === 'csv';
  res.setHeader('Content-Type', csv ? 'text/csv; charset=utf-8' : 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="agent-deploy-bulk-sample.${csv ? 'csv' : 'txt'}"`);
  res.send(csv ? sampleTextCsv() : sampleText());
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
