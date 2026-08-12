// 오프라인 패키지·에이전트 배포·LLM/Ollama·릴리스 노트 — admin.js(구 2,410줄) 분할(v2.285.0). 본문은 원본 그대로, 등록 순서는 admin.js 호출 순서가 보존한다.
import { config } from '../../config.js';
import { saveNote, deleteNote } from '../../release-notes.js';
import { loadLlmConfig, saveLlmConfig } from '../../llm/config.js';
import { ollamaTest } from '../../llm/ollama.js';
import { installOllama } from '../../llm/ollamaDeploy.js';
import { deployAgent, testTarget, installerInfo, checkAgentStatus } from '../../agent/deploy.js';
import { fetchRemoteVersions, listLocalPackages, downloadPackage } from '../../upgrade/fetchPackage.js';
import { getPackageSettings, savePackageSettings } from '../../upgrade/packageSettings.js';
import { listTargets, getTargetRaw, saveTarget, removeTarget, recordResult, findTargetByHost } from '../../agent/deployRegistry.js';
import { centralTokenInfo } from '../../central/token.js';
import path from 'node:path';
import { addCollector, updateCollector, loadCollectors } from '../../collector/registry.js';
import { pullNow } from '../../collector/puller.js';
import { adminOnly, ensureCollectorDatacenter } from './shared.js';


// 배포 성공 후, 그 호스트를 중앙에 '수집 서버'로 자동 등록(설치+등록 원클릭).
// collectorToken이 있고 registerCollector!==false 일 때만. 같은 id면 갱신.
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
