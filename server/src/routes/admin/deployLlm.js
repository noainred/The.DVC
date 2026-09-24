// 오프라인 패키지·에이전트 배포·LLM/Ollama·릴리스 노트 — admin.js(구 2,410줄) 분할(v2.285.0). 본문은 원본 그대로, 등록 순서는 admin.js 호출 순서가 보존한다.
import { config } from '../../config.js';
import { saveNote, deleteNote } from '../../release-notes.js';
import { loadLlmConfig, llmUrlIssue, saveLlmConfig } from '../../llm/config.js';
import { ollamaTest } from '../../llm/ollama.js';
import { installOllama } from '../../llm/ollamaDeploy.js';
import { deployAgent, testTarget, installerInfo, checkAgentStatus, envPairs, envPairsIssue } from '../../agent/deploy.js';
import { fetchRemoteVersions, listLocalPackages, downloadPackage } from '../../upgrade/fetchPackage.js';
import { getPackageSettings, savePackageSettings } from '../../upgrade/packageSettings.js';
import { listTargets, getTargetRaw, saveTarget, removeTarget, recordResult, findTargetByHost, listTargetsRaw } from '../../agent/deployRegistry.js';
import { targetsToCsv, sampleCsv as deploySampleCsv, parseTargetsCsv, analyzeTargetsImport } from '../../agent/deployCsv.js';
import { parseTargetsText, analyzeBulkDeploy, targetsToText, targetsToTextCsv, sampleText, sampleTextCsv, fillAutoTokens, COLUMN_PRESETS, DEFAULT_PRESET } from '../../agent/deployText.js';   // 대량 배포 텍스트/CSV(v2.432)
import { startBulkDeploy, getRun, listRuns, cancelRun, activeRunId } from '../../agent/bulkDeploy.js';        // 대량 배포 실행기(v2.432)
import { autoRegisterCollector } from '../../agent/autoRegister.js';
import { diffTargets, targetUrl, tokenOk, STATUS as SYNC_STATUS, ACTION as SYNC_ACTION } from '../../agent/collectorSync.js';  // 에이전트↔수집 서버 대조(v2.434~2.436)
import { forceCollectorToken } from '../../agent/deploy.js';
import { loadCollectors, updateCollector } from '../../collector/registry.js';
import { pullNow } from '../../collector/puller.js';
import { resilientFetch } from '../../util/resilientFetch.js';
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
    central: { hasToken: !!centralTokenInfo().hasToken }, // v2.480(3차 감사 S1): 토큰 평문은 소유자 전용 /central-token 으로만(웹 AgentDeploy 는 이미 그 경로 사용)
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

/**
 * 대상 저장 — v2.434 부터 **저장만 해도 수집 서버로 자동 등록**한다(사용자 요구 '에이전트를 등록하면
 * 자동으로 수집서버(원격)에 등록'). 예전에는 '배포 성공' 시에만 등록돼, 대상만 미리 등록해 둔 사이트가
 * 수집 서버 목록에 영영 안 떴다. registerCollector===false 면 건너뛴다.
 * autoCollectorToken=true 면 토큰이 없을 때 새로 만들어 대상에 저장한다 — 다만 그 토큰은 **엣지에 아직
 * 없으므로** 배포하거나 '엣지에 반영'을 해야 pull 이 200 이 된다(응답의 needsEdgeSync 로 알린다).
 */
adminRouter.post('/agent-deploy/targets', adminOnly, (req, res) => {
  const body = { ...(req.body || {}) };
  let generated = false;
  if (!String(body.collectorToken || '').trim() && req.body?.autoCollectorToken && body.registerCollector !== false) {
    const existing = body.id ? getTargetRaw(body.id)?.collectorToken : '';
    if (existing) body.collectorToken = existing;
    else { body.collectorToken = crypto.randomBytes(24).toString('hex'); generated = true; }
  }
  const r = saveTarget(body);
  if (!r.ok) return res.status(400).json(r);
  let collector = null;
  try {
    const raw = getTargetRaw(r.target?.id) || body;
    collector = autoRegisterCollector(raw, raw.portalPort || body.portalPort);
  } catch (e) { collector = { registered: false, reason: e.message }; }
  if (collector?.registered) {
    logAudit({ user: req.user?.username, action: '배포 대상 저장 시 수집 서버 자동 등록', target: collector.id, detail: `${collector.url}${generated ? ' · 토큰 신규 생성' : ''}`, ip: req.ip || '' });
  }
  res.json({ ...r, collector, tokenGenerated: generated, needsEdgeSync: generated });
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

/**
 * v2.601(감사 LO2601-01): 행 검증에 env 블록 주입 검사를 더한다 — 값에 개행·NUL 이 있으면 원격 portal.env 에 새 키 줄이
 * 생긴다(CSV 대량 배포는 눈으로 확인하기 어렵다). 판정은 deploy.js envPairsIssue 하나이고, 여기서는 보고서 항목을 'error' 로
 * 바꾸고 요약 개수를 옮길 뿐이다(판정을 복제하지 않는다). 배포 실행(deployAgent)도 같은 검사를 한 번 더 한다.
 */
function markEnvIssues(rows, report, summary) {
  const byLine = new Map(report.map((r) => [r.line, r]));
  for (const row of rows) {
    const issue = envPairsIssue(envPairs(row, 0));
    if (!issue) continue;
    const r = byLine.get(row._line);
    if (!r || r.action === 'error') continue;
    if (summary && typeof summary[r.action] === 'number') summary[r.action] -= 1;
    if (summary && typeof summary.error === 'number') summary.error += 1;
    r.action = 'error'; r.reason = issue;
  }
}

adminRouter.post('/agent-deploy/targets/import', adminOnly, (req, res) => {
  const { rows, error } = parseTargetsCsv(String(req.body?.csv || ''));
  if (error) return res.status(400).json({ ok: false, reason: error });
  if (!rows.length) return res.status(400).json({ ok: false, reason: '가져올 데이터 행이 없습니다.' });

  const existingId = (host, port, user) => findTargetByHost(host, port, user)?.id;
  const { report, summary } = analyzeTargetsImport(rows, { existingId });
  markEnvIssues(rows, report, summary);
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

/**
 * ⚠ 보안(v2.500 감사 A/H-1): `autoCentralToken` 은 **이 포탈의 평문 CENTRAL_TOKEN** 을 요청자가
 * 붙여넣은 host 의 portal.env 에 SSH 로 기록한다. adminOnly 만으로는 설정 소유자가 아닌 admin 이
 * 자기 서버를 한 줄 넣어 중앙 토큰을 받아갈 수 있고, 그 토큰이면 공유 토큰 모드에서 전 엣지의
 * iDRAC 계정·managed passwordHash 를 인출할 수 있다. 백업 라우트(portal.env 사본)를 소유자 전용으로
 * 묶은 것과 같은 등급의 자산이므로 같은 경계를 적용한다. **옵션을 쓸 때만** 게이트해 기존 배포
 * 흐름(토큰을 직접 입력하는 경우)은 그대로 둔다.
 */
function ownerIfAutoCentralToken(req, res, next) {
  if (!req.body?.autoCentralToken) return next();
  return requireSettingsOwner(req, res, next);
}

/** 화면이 고를 수 있는 열 순서 프리셋(헤더가 있으면 헤더가 우선). */
adminRouter.get('/agent-deploy/bulk/presets', adminOnly, (_req, res) => res.json({
  ok: true, presets: Object.entries(COLUMN_PRESETS).map(([k, v]) => ({ key: k, label: v.label, columns: v.columns })),
  defaultPreset: DEFAULT_PRESET, hasCentralToken: !!centralTokenInfo().token,
}));

adminRouter.post('/agent-deploy/bulk/preview', adminOnly, ownerIfAutoCentralToken, (req, res) => {
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
    markEnvIssues(rows, report, summary);
    res.json({ ok: true, report, summary, skipped: skipped.slice(0, 50), header: !!header, columns, total: rows.length });
  } catch (e) { res.status(400).json({ ok: false, reason: e.message }); }
});

adminRouter.post('/agent-deploy/bulk/run', adminOnly, ownerIfAutoCentralToken, (req, res) => {
  try {
    const text = String(req.body?.text || '');
    if (text.length > 1_000_000) return res.status(400).json({ ok: false, reason: '입력이 1MB 를 넘습니다.' });
    const { rows } = parseTargetsText(text, req.body?.defaults || {}, { columns: req.body?.columns });
    fillAutoTokens(rows, autoTokenOpts(req.body));
    const { report } = analyzeBulkDeploy(rows, {
      existingId: (h, p, u) => findTargetByHost(h, p, u)?.id,
      blockReason: (h) => ipBlockReason(h),
    });
    markEnvIssues(rows, report, null);
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

/* ── 에이전트 ↔ 수집 서버(원격) 대조·연결(v2.434, 사용자 요구 '에이전트가 설치되어 있는데 수집서버가
 * 설정되어 있지 않으면 추가하는 기능') ──────────────────────────────────────────────────────
 * 엣지에 깔리는 프로그램은 하나지만 중앙은 그 하나를 두 목록에 적어 둔다(설치용 SSH 대상 / pull 용 URL+토큰).
 * 여기서 두 목록을 맞춰 보고, 빠진 수집 서버를 만들어 준다. 응답에 토큰 값은 넣지 않는다.
 */
adminRouter.get('/agent-deploy/collector-sync', adminOnly, (_req, res) => {
  const targets = listTargets().map((t) => getTargetRaw(t.id)).filter(Boolean);
  const { rows, orphans, summary } = diffTargets(targets, loadCollectors());
  res.json({ ok: true, rows, orphans, summary, statusLabels: SYNC_STATUS, actionLabels: SYNC_ACTION });
});

/**
 * 진단(v2.436) — **엣지가 실제로 어느 토큰을 받는지 측정**한다. 대조 표는 두 저장소의 값만 비교하므로
 * '토큰 불일치' 가 곧 장애를 뜻하지는 않는다(수집 서버 화면에서 토큰을 재발급·강제 동기화하면
 * collectors.json 과 엣지만 갱신되고 배포 대상 기록은 낡은 채로 남는다). 추측 대신 재 본다.
 *
 * 각 대상의 수집 URL 로 `/api/collector/export` 를 두 번 호출한다 — ① 수집 서버(중앙) 토큰 ② 배포 대상 토큰.
 * 결과로 권장 방향을 낸다:
 *   · 중앙 토큰만 통함 → `central-to-target`(중앙 값을 대상에 복사 · SSH 불필요) — 가장 흔한 정상 케이스
 *   · 대상 토큰만 통함 → `target-to-central`(대상 값을 중앙에 반영 · SSH 불필요)
 *   · 둘 다 안 통함   → `target-to-edge`(SSH 로 엣지에 밀어넣기) 또는 엣지 자체 점검
 * 응답에 토큰 값은 넣지 않는다(통했는지 여부만).
 */
adminRouter.post('/agent-deploy/collector-sync/probe', adminOnly, async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).slice(0, 50) : [];
  if (!ids.length) return res.status(400).json({ ok: false, reason: '진단할 대상을 선택하세요(최대 50건).' });
  const cols = loadCollectors();
  const hit = async (url, token) => {
    if (!token) return { tried: false, ok: false, reason: '토큰 없음' };
    try {
      const r = await resilientFetch(`${String(url).replace(/\/+$/, '')}/api/collector/export`, {
        headers: { Accept: 'application/json', 'X-Collector-Token': token },
        timeoutMs: config.collector.timeoutMs, retries: 0,
      });
      return { tried: true, ok: r.ok, reason: r.ok ? '' : `HTTP ${r.status}` };
    } catch (e) { return { tried: true, ok: false, reason: e.message }; }
  };
  const results = [];
  const run = async (id) => {
    const t = getTargetRaw(id);
    if (!t) { results.push({ id, ok: false, reason: '대상을 찾을 수 없습니다.' }); return; }
    const url = targetUrl(t);
    const col = cols.find((c) => String(c.url || '').replace(/\/+$/, '') === url) || cols.find((c) => c.id === collectorIdOf(t));
    const central = await hit(url, col?.token);
    const target = await hit(url, t.collectorToken);
    let recommend = 'none'; let why = '';
    if (central.ok && !target.ok) { recommend = 'central-to-target'; why = '엣지가 중앙(수집 서버) 토큰을 받습니다 — 배포 대상 기록만 낡았습니다. 재배포 전에 맞춰 두세요.'; }
    else if (!central.ok && target.ok) { recommend = 'target-to-central'; why = '엣지가 배포 대상 토큰을 받습니다 — 중앙 수집 서버의 토큰이 낡아 지금 pull 이 실패 중입니다.'; }
    else if (central.ok && target.ok) { recommend = 'central-to-target'; why = '두 토큰이 모두 통합니다(엣지가 최근 교체 중이거나 값이 같음). 중앙 값 기준으로 통일하세요.'; }
    else { recommend = 'target-to-edge'; why = `어느 토큰도 통하지 않습니다(중앙: ${central.reason || '실패'} · 대상: ${target.reason || '실패'}). 엣지가 꺼져 있거나 주소가 틀렸을 수 있으니 먼저 확인하고, 맞다면 '대상 → 엣지' 로 밀어넣으세요.`; }
    results.push({
      id, host: t.host, agentName: t.agentName || '', url, collectorId: col?.id || '',
      central: { tried: central.tried, ok: central.ok, reason: central.reason },
      target: { tried: target.tried, ok: target.ok, reason: target.reason },
      recommend, why, ok: true,
    });
  };
  const it = ids[Symbol.iterator]();
  await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
    for (let n = it.next(); !n.done; n = it.next()) await run(n.value);
  }));
  logAudit({ user: req.user?.username, action: '수집 서버 토큰 진단', detail: `${results.length}건`, ip: req.ip || '' });
  res.json({ ok: true, results });
});
const collectorIdOf = (t) => String(t?.collectorDatacenter || t?.agentName || t?.host || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * 빠진 수집 서버 추가(선택 행). 옵션:
 *  · generateToken : 대상에 수집 토큰이 없으면 새로 만들어 대상에 저장한다.
 *  · syncToEdge    : SSH 로 엣지 portal.env 의 COLLECTOR_TOKEN 을 그 값으로 교체하고 서비스를 재시작한다.
 *                    (새로 만든 토큰은 엣지에 없으므로 이걸 켜야 바로 pull 이 된다. 서비스가 잠깐 끊긴다.)
 *  · verify        : 등록 후 실제로 /api/collector/export 가 200 인지 확인한다.
 * SSH 는 무겁다 — 한 번에 최대 50건, 동시 3건.
 */
adminRouter.post('/agent-deploy/collector-sync', adminOnly, async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).slice(0, 50) : [];
  if (!ids.length) return res.status(400).json({ ok: false, reason: '추가할 대상을 선택하세요(최대 50건).' });
  const generateToken = req.body?.generateToken !== false;
  // 'add-only' 는 수집 서버가 있어도 정렬하지 않고 기존(추가) 흐름만 탄다 — 하위 호환.
  const tokenDirection = ['central-to-target', 'target-to-central', 'target-to-edge', 'add-only'].includes(req.body?.tokenDirection)
    ? req.body.tokenDirection : 'central-to-target';
  const syncToEdge = !!req.body?.syncToEdge || tokenDirection === 'target-to-edge';
  const verify = req.body?.verify !== false;
  logAudit({ user: req.user?.username, action: '에이전트 → 수집 서버 일괄 추가', detail: `${ids.length}건 · 방향=${tokenDirection} 토큰생성=${generateToken} 엣지반영=${syncToEdge}`, ip: req.ip || '' });

  const results = [];
  const run = async (id) => {
    const t = getTargetRaw(id);
    const base = { id, host: t?.host || '', agentName: t?.agentName || '', url: t ? targetUrl(t) : '' };
    if (!t) { results.push({ ...base, ok: false, reason: '대상을 찾을 수 없습니다.' }); return; }
    if (t.enabled === false) { results.push({ ...base, ok: false, reason: '비활성 대상입니다.' }); return; }

    /* v2.436 토큰 정렬 — 수집 서버가 **이미 있는** 대상은 '추가' 가 아니라 '정렬' 이다.
     * central-to-target: 수집 서버 토큰을 배포 대상에 복사(SSH 불필요 · 기본, 재배포 지뢰 제거)
     * target-to-central: 배포 대상 토큰을 수집 서버에 반영(SSH 불필요 · 엣지가 대상 값을 받을 때)
     * target-to-edge   : 배포 대상 토큰을 엣지 portal.env 에 밀어넣고 중앙도 맞춤(SSH · 서비스 재시작) */
    const existing = loadCollectors().find((c) => String(c.url || '').replace(/\/+$/, '') === targetUrl(t));
    if (existing && tokenDirection !== 'add-only') {
      if (tokenDirection === 'central-to-target') {
        if (!existing.token) { results.push({ ...base, ok: false, reason: `수집 서버 '${existing.id}' 에 토큰이 없습니다 — 그 화면에서 먼저 발급하세요.` }); return; }
        const sv = saveTarget({ ...t, collectorToken: existing.token });
        results.push({ ...base, ok: sv.ok, aligned: 'central-to-target', collectorId: existing.id,
          reason: sv.ok ? '' : sv.reason, note: sv.ok ? '수집 서버 토큰을 배포 대상에 복사했습니다(엣지·수집 동작 불변).' : '' });
        return;
      }
      if (tokenDirection === 'target-to-central') {
        const tok = String(t.collectorToken || '').trim();
        if (!tok) { results.push({ ...base, ok: false, reason: '배포 대상에 토큰이 없습니다.' }); return; }
        const upd = updateCollector(existing.id, { ...existing, token: tok }, { managed: true });
        if (upd.ok) pullNow().catch(() => {});
        results.push({ ...base, ok: upd.ok, aligned: 'target-to-central', collectorId: existing.id,
          reason: upd.ok ? '' : upd.reason, note: upd.ok ? '배포 대상 토큰을 수집 서버에 반영했습니다(엣지 미변경).' : '' });
        return;
      }
      // target-to-edge 는 아래 공통 흐름(엣지 반영 + 등록)으로 내려간다.
    }

    let token = String(t.collectorToken || '').trim();
    let tokenGenerated = false;
    if (!token) {
      if (!generateToken) { results.push({ ...base, ok: false, reason: '수집 토큰이 없습니다(토큰 생성을 켜세요).' }); return; }
      token = crypto.randomBytes(24).toString('hex'); tokenGenerated = true;
      // saveTarget 은 부분 수정에도 host 를 요구하므로 원본을 통째로 넘긴다(FIELDS 필터라 lastResult 는 보존).
      const sv = saveTarget({ ...t, id, collectorToken: token });
      if (!sv.ok) { results.push({ ...base, ok: false, reason: `토큰 저장 실패: ${sv.reason}` }); return; }
    }
    if (!tokenOk(token)) { results.push({ ...base, ok: false, reason: '저장된 수집 토큰에 사용할 수 없는 문자가 있습니다(영숫자·._~+/=- 만).' }); return; }

    // 엣지 반영(선택) — 새 토큰이면 이걸 해야 pull 이 통한다.
    let edge = null;
    if (syncToEdge) {
      const r = await forceCollectorToken({ ...t, collectorToken: token }, token, { urlPort: Number(t.portalPort) || 4000 });
      edge = { ok: !!r.ok, active: r.active || '', unit: r.unit || '', reason: r.reason || '', log: String(r.log || '').slice(-1500) };
      if (!r.ok) { results.push({ ...base, ok: false, tokenGenerated, edge, reason: `엣지 반영 실패 — ${r.reason}` }); return; }
    }

    const col = autoRegisterCollector({ ...t, collectorToken: token }, t.portalPort);
    if (!col?.registered) { results.push({ ...base, ok: false, tokenGenerated, edge, reason: col?.reason || '수집 서버 등록 실패' }); return; }

    let verified = null;
    if (verify) {
      try {
        const vr = await resilientFetch(`${col.url}/api/collector/export`, {
          headers: { Accept: 'application/json', 'X-Collector-Token': token },
          timeoutMs: config.collector.timeoutMs, retries: 1,
        });
        verified = { ok: vr.ok, reason: vr.ok ? '' : `HTTP ${vr.status}${vr.status === 403 ? ' (엣지의 COLLECTOR_TOKEN 이 다릅니다 — 배포하거나 엣지 반영을 켜세요)' : ''}` };
      } catch (e) { verified = { ok: false, reason: e.message }; }
    }
    results.push({ ...base, ok: true, collectorId: col.id, collectorUrl: col.url, updated: !!col.updated, tokenGenerated, edge, verified });
  };

  const it = ids[Symbol.iterator]();
  await Promise.all(Array.from({ length: Math.min(3, ids.length) }, async () => {
    for (let n = it.next(); !n.done; n = it.next()) await run(n.value);
  }));
  if (results.some((r) => r.ok)) pullNow().catch(() => {});
  const added = results.filter((r) => r.ok).length;
  logAudit({ user: req.user?.username, action: '에이전트 → 수집 서버 일괄 추가 결과', detail: `성공 ${added}/${results.length}`, ip: req.ip || '' });
  res.json({ ok: true, added, total: results.length, results, statusLabels: SYNC_STATUS });
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
adminRouter.put('/llm-config', adminOnly, (req, res) => {
  try { res.json({ ok: true, config: saveLlmConfig(req.body || {}) }); }
  catch (e) { res.status(e.status || 500).json({ ok: false, reason: e.message }); }
});
adminRouter.post('/llm-test', adminOnly, async (req, res) => {
  // v2.590 D6: 본문 url 로 임의 주소를 찌르지 못하게 같은 검증을 건다(저장값을 쓰든 본문을 쓰든 동일).
  const cfg = { ...loadLlmConfig(), ...(req.body || {}) };
  const why = llmUrlIssue(cfg.url);
  if (why) return res.status(400).json({ ok: false, reason: why });
  res.json(await ollamaTest(cfg));
});

// SSH-install Ollama on a separate server (test reuses the agent SSH probe).
adminRouter.post('/ollama-deploy/test', adminOnly, async (req, res) => res.json(await testTarget(req.body || {})));
// v2.583(감사 확정): 서버의 로컬 파일을 요청자가 고른 호스트로 보내는 경로라 자격증명 CSV 내보내기와 같은
//   등급(설정 소유자)으로 올린다 — 파일 검증(checkOllamaArchive)과 이중 방어.
adminRouter.post('/ollama-deploy', adminOnly, requireSettingsOwner, async (req, res) => {
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
