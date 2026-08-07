/**
 * 성능점검 API — 조회는 로그인 사용자, 변경은 admin/operator(CLAUDE.md RBAC 불변조건).
 *
 * 고부하 대응
 * - `/state` 는 10만 항목까지 커질 수 있으므로 **트리 경로 기준 페이징**을 지원한다
 *   (`?path=&limit=`). 요약 카운트는 전체 기준으로 따로 계산해 내려준다.
 * - 응답은 res.json 래퍼가 ETag/304 를 처리하므로 무변동 폴링은 본문 0바이트다.
 * - 로그 파일 다운로드는 스트리밍(createReadStream) — GB 파일을 메모리에 올리지 않는다.
 */

import fs from 'node:fs';
import express from 'express';
import { requireRole } from '../auth/auth.js';
import { logAudit } from '../audit.js';
import {
  listTargets, listTargetsCopy, listFolders, getSort, setSort, totalTests,
  addTarget, updateTarget, deleteTarget, addTest, updateTest, deleteTest,
  addFolder, renameFolder, deleteFolder, bulkAddTargets, planBulkTargets, flushStore,
  TEST_TYPES, KINDS, LIMITS,
} from '../svcmon/store.js';
import { TARGET_FIELDS, TEST_FIELDS, CSV_COLUMNS } from '../svcmon/testSchema.js';
import { csvLines, parseTargetsCsv, sampleCsv, REQUIRED_COLUMNS } from '../svcmon/csvio.js';
import { judgeCapacity, suggestIntervalSec } from '../svcmon/capacity.js';
import { testState, emptySummary } from '../svcmon/status.js';
import { edgeSummary, edgeState, edgeTotals, forgetAgent, MAX_AGENTS, MAX_ROWS_PER_AGENT } from '../central/svcmonEdge.js';
import { silenceStatus, checkSilenceOnce } from '../central/svcmonSilence.js';
import { svcmonPushStatus, pushSvcmonNow } from '../agent/svcmonPush.js';
import {
  listAssignments, setAssignment, deleteAssignment, DEFAULT_EXCEPT_TYPES,
  MAX_TARGETS_PER_AGENT, batchTag,
} from '../central/svcmonAssign.js';
import { svcmonConfigPullStatus, pullSvcmonConfigNow } from '../agent/svcmonConfigPull.js';
import { pollerRole } from '../svcmon/poller.js';
import {
  listTemplates, getTemplate, addTemplate, updateTemplate, duplicateTemplate,
  deleteTemplate, applyTemplate, templateUsage, materializeForTarget,
  MAX_TEMPLATES, MAX_ITEMS, SUBST_VARS,
} from '../svcmon/templates.js';
import { expandGenSpec } from '../svcmon/genspec.js';
import { recordBatch, listBatches, rollbackBatch, deleteBatchRecord } from '../svcmon/batches.js';
import { getResults, getLastSweep, runNow, pollerStats } from '../svcmon/poller.js';
import { getLogSettings, setLogSettings, ROTATE_UNITS, ROTATE_LABEL } from '../svcmon/logsettings.js';
import { logStatus, logFilePath, pruneOld, logStats } from '../svcmon/csvlog.js';
import { logDir } from '../svcmon/logsettings.js';

export const svcmonRouter = express.Router();
const canEdit = requireRole('admin', 'operator');
const adminOnly = requireRole('admin');

// 상태 판정·요약 키는 svcmon/status.js 하나에서만 정의한다(라우트·화면·테스트 공용).
const statusOf = (t, x, results, now) => testState(t, x, results, now);

/** 트리 + 대상 + 점검 + 최근 결과 + 요약. path/limit 으로 범위를 좁힐 수 있다. */
svcmonRouter.get('/state', (req, res) => {
  const results = getResults();
  const kind = KINDS.includes(req.query.kind) ? req.query.kind : null;
  const scope = typeof req.query.path === 'string' ? req.query.path : '';
  const limit = Math.min(2000, Math.max(1, Number(req.query.limit) || 300));

  const all = listTargetsCopy();
  const now = Date.now();
  // 요약은 항상 전체(또는 kind 전체) 기준 — 화면 상단 KPI 가 페이징에 흔들리지 않게.
  // pending/stale 을 disabled 와 **합치지 않는다**(감시 공백이 의도적 중지로 위장된다).
  const summary = emptySummary();
  for (const t of all) {
    if (kind && t.kind !== kind) continue;
    for (const x of t.tests) {
      summary.total += 1;
      const st = statusOf(t, x, results, now);
      if (summary[st] !== undefined) summary[st] += 1;
      else summary.pending += 1;
    }
  }

  const inScope = all.filter((t) => (!kind || t.kind === kind)
    && (!scope || t.path === scope || t.path.startsWith(`${scope}\\`)));
  const targets = inScope.slice(0, limit).map((t) => ({
    ...t,
    tests: t.tests.map((x) => {
      const r = results.get(x.id) || null;
      // 화면이 나이를 직접 계산하지 않게 서버가 실어 보낸다(클라이언트 시계는 틀릴 수 있다).
      const ageMs = r?.ts ? now - r.ts : null;
      return { ...x, result: r ? { ...r, ageMs } : null, state: statusOf(t, x, results, now) };
    }),
  }));

  res.json({
    targets,
    folders: listFolders(),
    sort: getSort(),
    summary,
    truncated: inScope.length > targets.length,
    scopeCount: inScope.length,
    targetCount: all.length,
    // 엣지 위임 요약 — 이 포탈이 직접 실행한 것 외에, 원격 법인 엣지가 보고한 현황.
    edges: edgeSummary(now),
    edgeTotals: edgeTotals(now),
    testTypes: TEST_TYPES,
    rotateUnits: ROTATE_UNITS,
    rotateLabels: ROTATE_LABEL,
    lastSweep: getLastSweep(),
  });
});

/** 운영 진단 — 워커/폴러/로그 라이터 상태(부하 점검용). */
svcmonRouter.get('/diag', canEdit, (req, res) => {
  res.json({
    poller: pollerStats(), log: logStats(),
    targets: listTargetsCopy().length, tests: totalTests(),
    // 엣지 위임 진단 — 이 서버가 받는 쪽(edges)인지 보내는 쪽(push)인지 함께 보인다.
    edges: edgeSummary(), push: svcmonPushStatus(), silence: silenceStatus(),
  });
});

svcmonRouter.post('/refresh', canEdit, async (req, res) => {
  const ran = await runNow();
  res.status(ran ? 200 : 202).json({ ok: true, ran });
});

/* ── 폴더 ── */
svcmonRouter.post('/folders', canEdit, (req, res) => {
  try {
    const f = addFolder(req.body || {});
    logAudit({ user: req.user?.username, action: 'svcmon.folder.add', target: f.path, detail: f.kind });
    res.status(201).json({ folder: f, folders: listFolders() });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

svcmonRouter.put('/folders/rename', canEdit, (req, res) => {
  try {
    const r = renameFolder(req.body || {});
    logAudit({ user: req.user?.username, action: 'svcmon.folder.rename', target: r.path });
    res.json({ ...r, folders: listFolders() });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

svcmonRouter.post('/folders/delete', canEdit, (req, res) => {
  try {
    const r = deleteFolder(req.body || {});
    logAudit({ user: req.user?.username, action: 'svcmon.folder.delete', target: req.body?.path, detail: `대상 ${r.removedTargets}개` });
    res.json({ ...r, folders: listFolders() });
  } catch (e) {
    res.status(e.code === 'NOT_EMPTY' ? 409 : 400).json({ error: e.message, count: e.count });
  }
});

svcmonRouter.put('/sort', canEdit, (req, res) => {
  try { res.json({ sort: setSort(req.body || {}) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

/* ── 대상/점검 ── */
svcmonRouter.post('/targets', canEdit, (req, res) => {
  try {
    const t = addTarget(req.body || {});
    logAudit({ user: req.user?.username, action: 'svcmon.target.add', target: t.name, detail: t.host });
    res.status(201).json({ target: t });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

svcmonRouter.post('/targets/bulk', canEdit, (req, res) => {
  try {
    const rows = Array.isArray(req.body?.targets) ? req.body.targets : [];
    if (rows.length > LIMITS.maxBulkRows) {
      return res.status(400).json({ error: `한 번에 최대 ${LIMITS.maxBulkRows}개까지 등록할 수 있습니다(요청 ${rows.length}개).` });
    }
    const r = bulkAddTargets(rows);
    // 검증 실패는 커밋 0건이다 — 201 로 응답하면 화면이 등록됐다고 표시한다.
    if (!r.committed) return res.status(400).json({ ...r, error: '검증에 실패해 등록하지 않았습니다.' });
    if (!r.saved) return res.status(500).json({ ...r, error: '파일 저장에 실패했습니다(디스크·권한 확인).' });
    logAudit({
      user: req.user?.username,
      action: 'svcmon.target.bulk',
      detail: `추가 ${r.added} · 건너뜀 ${r.skipped.length} · 점검 ${r.newTests} · 신규폴더 ${r.newFolders}`,
    });
    res.status(201).json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

svcmonRouter.put('/targets/:id', canEdit, (req, res) => {
  try {
    const t = updateTarget(req.params.id, req.body || {});
    if (!t) return res.status(404).json({ error: '대상을 찾을 수 없습니다.' });
    logAudit({ user: req.user?.username, action: 'svcmon.target.update', target: t.name });
    res.json({ target: t });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

svcmonRouter.delete('/targets/:id', canEdit, (req, res) => {
  if (!deleteTarget(req.params.id)) return res.status(404).json({ error: '대상을 찾을 수 없습니다.' });
  logAudit({ user: req.user?.username, action: 'svcmon.target.delete', target: req.params.id });
  res.json({ ok: true });
});

svcmonRouter.post('/targets/:id/tests', canEdit, (req, res) => {
  try {
    const t = addTest(req.params.id, req.body || {});
    if (!t) return res.status(404).json({ error: '대상을 찾을 수 없습니다.' });
    logAudit({ user: req.user?.username, action: 'svcmon.test.add', target: t.name, detail: t.type });
    res.status(201).json({ test: t });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

svcmonRouter.put('/targets/:id/tests/:testId', canEdit, (req, res) => {
  try {
    const t = updateTest(req.params.id, req.params.testId, req.body || {});
    if (!t) return res.status(404).json({ error: '점검을 찾을 수 없습니다.' });
    logAudit({ user: req.user?.username, action: 'svcmon.test.update', target: t.name });
    res.json({ test: t });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

svcmonRouter.delete('/targets/:id/tests/:testId', canEdit, (req, res) => {
  if (!deleteTest(req.params.id, req.params.testId)) return res.status(404).json({ error: '점검을 찾을 수 없습니다.' });
  logAudit({ user: req.user?.username, action: 'svcmon.test.delete', target: req.params.testId });
  res.json({ ok: true });
});

/* ── CSV 가져오기 / 내보내기 ── */

/**
 * 커밋 없이 판정만 — 미리보기와 실제 등록이 **같은 검증 코드**(planBulkTargets)를 쓴다.
 * 표본은 앞 20 + 뒤 5 + 건너뜀 10 만 내려보낸다(2,000행 전량을 보내면 응답이 수 MB 이고
 * 화면 표는 전 행을 DOM 에 렌더한다).
 */
function dryRunTargets(list) {
  const plan = planBulkTargets(list);
  // 저장소는 입력 순번(1..N)으로 행을 세지만, CSV 가져오기에서는 그 순번이 **원본 행 번호와
  // 다르다**(한 대상이 여러 행에서 묶이므로). csvio 가 붙여 둔 _row 로 되돌린다 —
  // 섞인 채로 내보내면 사용자가 오류 줄을 파일에서 찾을 수 없다.
  const srcRow = (n) => (n && list[n - 1] && list[n - 1]._row) || n;
  const addedTests = [];
  for (const { target } of plan.prepared) for (const x of target.tests) addedTests.push(x);
  const current = [];
  for (const t of listTargets()) {
    if (t.enabled === false) continue;
    for (const x of t.tests) current.push(x);
  }
  const capacity = judgeCapacity({ tests: current, addedTests });
  if (capacity.verdict !== 'ok') {
    capacity.suggestIntervalSec = suggestIntervalSec(plan.after.tests, capacity.workers);
  }
  const row = (p, verdict) => ({
    verdict,
    row: srcRow(p.row),
    kind: p.target.kind,
    path: p.target.path,
    name: p.target.name,
    host: p.target.host,
    enabled: p.target.enabled !== false,
    tests: p.target.tests.length,
    testSummary: p.target.tests.slice(0, 4).map((x) => `${x.type}${x.port ? `:${x.port}` : ''}`).join(', ')
      + (p.target.tests.length > 4 ? ` +${p.target.tests.length - 4}` : ''),
    newFolders: p.folders.length,
  });
  const head = plan.prepared.slice(0, 20).map((p) => row(p, 'create'));
  const tail = plan.prepared.length > 25 ? plan.prepared.slice(-5).map((p) => row(p, 'create')) : [];
  const skips = plan.skipped.slice(0, 10).map((s) => ({ verdict: 'skip', ...s, row: srcRow(s.row) }));
  return {
    create: plan.prepared.length,
    skip: plan.skipped.length,
    errors: [
      ...plan.errors.map((e) => ({ ...e, row: srcRow(e.row) })),
      ...plan.over.map((reason) => ({ row: 0, name: '', reason })),
    ],
    newFolders: plan.newFolders,
    newTests: plan.newTests,
    before: plan.before,
    after: plan.after,
    capacity,
    sample: [...head, ...tail, ...skips],
    truncatedSample: plan.prepared.length > 25 || plan.skipped.length > 10,
  };
}

/** 내보내기 — 청크 스트리밍. `res.json` 을 쓰면 압축 래퍼의 SHA-1 ETag 계산이 동기로 걸린다. */
svcmonRouter.get('/targets/export.csv', canEdit, (req, res) => {
  const kind = KINDS.includes(req.query.kind) ? req.query.kind : null;
  const scope = typeof req.query.path === 'string' ? req.query.path.trim() : '';
  const withTests = req.query.tests !== '0';
  const all = listTargetsCopy().filter((t) => {
    if (kind && (t.kind || 'infra') !== kind) return false;
    if (scope && !(t.path === scope || t.path.startsWith(`${scope}\\`))) return false;
    return true;
  });
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="svcmon-targets-${stamp}.csv"`);
  let tests = 0;
  for (const t of all) tests += (t.tests || []).length;
  logAudit({
    user: req.user?.username,
    action: 'svcmon.target.export',
    detail: `대상 ${all.length} · 점검 ${withTests ? tests : 0} · 열 ${CSV_COLUMNS.length}${scope ? ` · 경로 ${scope}` : ''}`,
  });
  // 줄을 모아 8,000줄마다 write — 한 문자열로 join 하면 30MB 규모에서 그 자체가 블로킹이다.
  let buf = [];
  for (const line of csvLines(all, { includeTests: withTests })) {
    buf.push(line);
    if (buf.length >= 8000) { res.write(buf.join('\r\n') + '\r\n'); buf = []; }
  }
  if (buf.length) res.write(buf.join('\r\n') + '\r\n');
  res.end();
});

/** 샘플 CSV — 스키마에서 생성한다(하드코딩 상수면 컬럼 추가한 날 샘플만 낡는다). */
svcmonRouter.get('/targets/sample.csv', canEdit, (req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="svcmon-sample.csv"');
  res.send(sampleCsv());
});

/** 컬럼 설명 — 화면이 표를 그릴 때 쓴다(스키마와 화면이 어긋나지 않게). */
svcmonRouter.get('/targets/csv-schema', canEdit, (req, res) => {
  const of = (f) => ({
    col: f.col, label: f.label, kind: f.kind, max: f.max, min: f.min,
    dflt: f.dflt, requiredFor: f.requiredFor, usedBy: f.usedBy,
    required: REQUIRED_COLUMNS.includes(f.col),
  });
  res.json({
    columns: CSV_COLUMNS,
    target: TARGET_FIELDS.map(of),
    test: TEST_FIELDS.map(of),
    required: REQUIRED_COLUMNS,
    types: TEST_TYPES,
    kinds: KINDS,
    limits: LIMITS,
  });
});

/**
 * 가져오기 — `mode:'preview'` 는 저장하지 않고 판정만, `'add'` 는 커밋한다.
 * 커밋은 all-or-nothing 이며 이미 있는 대상(구분+경로+이름)은 건너뛴다.
 */
svcmonRouter.post('/targets/import', canEdit, (req, res) => {
  const mode = req.body?.mode === 'add' ? 'add' : 'preview';
  const csv = typeof req.body?.csv === 'string' ? req.body.csv : '';
  if (!csv.trim()) return res.status(400).json({ error: 'CSV 내용이 비어 있습니다.' });

  const parsed = parseTargetsCsv(csv, { maxRows: LIMITS.maxBulkRows });
  if (parsed.targets.length > LIMITS.maxBulkRows) {
    return res.status(400).json({ error: `한 번에 최대 ${LIMITS.maxBulkRows}개 대상까지 가져올 수 있습니다(파싱 ${parsed.targets.length}개).` });
  }
  const dry = dryRunTargets(parsed.targets);
  const errors = [...parsed.errors, ...dry.errors];
  const summary = {
    rows: parsed.rowCount,
    create: dry.create,
    skip: dry.skip,
    error: errors.length,
    newFolders: dry.newFolders,
    newTests: dry.newTests,
  };
  const payload = {
    mode, summary, errors: errors.slice(0, 300),
    truncated: { errors: errors.length > 300 },
    unknownColumns: parsed.unknownColumns,
    sample: dry.sample,
    after: dry.after,
    limits: LIMITS,
    capacity: dry.capacity,
    expectedCount: dry.create,
  };
  if (mode === 'preview') return res.json(payload);

  if (errors.length) return res.status(400).json({ ...payload, error: `오류 ${errors.length}건이 있어 등록하지 않았습니다(전부 성공 또는 전부 취소).` });
  if (dry.capacity.verdict === 'reject') {
    return res.status(400).json({ ...payload, error: dry.capacity.reasons[0] });
  }
  if (typeof req.body?.expectedCount === 'number' && req.body.expectedCount !== dry.create) {
    return res.status(409).json({ ...payload, error: '미리보기 이후 목록이 바뀌었습니다. 미리보기를 다시 확인하세요.' });
  }
  const batch = 'b-' + Math.random().toString(36).slice(2, 10);
  const r = bulkAddTargets(parsed.targets, { batch });
  if (!r.committed) return res.status(400).json({ ...payload, ...r, error: '검증에 실패해 등록하지 않았습니다.' });
  if (!r.saved) return res.status(500).json({ ...payload, ...r, error: '파일 저장에 실패했습니다(디스크·권한 확인).' });
  logAudit({
    user: req.user?.username,
    action: 'svcmon.target.import',
    detail: `batch=${batch} · 추가 ${r.added} · 건너뜀 ${r.skipped.length} · 점검 ${r.newTests} · 신규폴더 ${r.newFolders}`,
  });
  res.status(201).json({ ...payload, ...r, batch });
});

/* ── 점검 템플릿 ── */

svcmonRouter.get('/templates', (req, res) => {
  const items = listTemplates().map((t) => ({ ...t, usage: templateUsage(t.id) }));
  res.json({ templates: items, limits: { maxTemplates: MAX_TEMPLATES, maxItems: MAX_ITEMS }, substVars: SUBST_VARS });
});

svcmonRouter.post('/templates', canEdit, (req, res) => {
  try {
    const t = addTemplate(req.body || {}, { user: req.user?.username });
    logAudit({
      user: req.user?.username, action: 'svcmon.template.add', target: t.name,
      detail: `항목 ${t.items.length}${t.items.some((x) => x.insecure) ? ' · insecure=true' : ''}`,
    });
    res.status(201).json({ template: t });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

svcmonRouter.put('/templates/:id', canEdit, (req, res) => {
  try {
    const t = updateTemplate(req.params.id, req.body || {}, { user: req.user?.username });
    if (!t) return res.status(404).json({ error: '템플릿을 찾을 수 없습니다.' });
    logAudit({
      user: req.user?.username, action: 'svcmon.template.update', target: t.name,
      detail: `항목 ${t.items.length} · rev ${t.rev}${t.items.some((x) => x.insecure) ? ' · insecure=true' : ''}`,
    });
    res.json({ template: t });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

svcmonRouter.post('/templates/:id/duplicate', canEdit, (req, res) => {
  try {
    const t = duplicateTemplate(req.params.id, { user: req.user?.username });
    if (!t) return res.status(404).json({ error: '템플릿을 찾을 수 없습니다.' });
    logAudit({ user: req.user?.username, action: 'svcmon.template.add', target: t.name, detail: `복제 ← ${req.params.id}` });
    res.status(201).json({ template: t });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/** 삭제 — 이미 적용된 점검은 **남긴다**(태그도 유지). 감시를 끊지 않는 쪽이 안전하다. */
svcmonRouter.delete('/templates/:id', canEdit, (req, res) => {
  try {
    const r = deleteTemplate(req.params.id);
    if (!r.removed) return res.status(404).json({ error: '템플릿을 찾을 수 없습니다.' });
    logAudit({
      user: req.user?.username, action: 'svcmon.template.delete', target: req.params.id,
      detail: `남은 점검 ${r.orphanTests} · 대상 ${r.orphanTargets}`,
    });
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

svcmonRouter.get('/templates/:id/usage', canEdit, (req, res) => {
  if (!getTemplate(req.params.id)) return res.status(404).json({ error: '템플릿을 찾을 수 없습니다.' });
  res.json(templateUsage(req.params.id));
});

/** 적용 — `mode:'preview'` 는 저장하지 않는다. 커밋은 all-or-nothing. */
svcmonRouter.post('/templates/:id/apply', canEdit, async (req, res) => {
  const dryRun = req.body?.mode !== 'apply';
  try {
    const r = await applyTemplate(req.params.id, {
      scope: req.body?.scope || {}, overwrite: !!req.body?.overwrite, dryRun,
      user: req.user?.username,
    });
    if (!r) return res.status(404).json({ error: '템플릿을 찾을 수 없습니다.' });

    // 적용 후 규모가 폴러 처리량을 넘는지 — 대량 적용은 CSV 가져오기와 같은 판정을 받는다.
    const cur = [];
    for (const t of listTargets()) { if (t.enabled !== false) for (const x of t.tests) cur.push(x); }
    const capacity = judgeCapacity({ tests: cur, addedTests: [] });
    const payload = {
      mode: dryRun ? 'preview' : 'apply',
      summary: { create: r.create, update: r.update, skip: r.skip, error: r.errorCount, rows: r.tests },
      errors: (r.errors || []).slice(0, 300),
      truncated: { errors: (r.errors || []).length > 300 },
      sample: r.sample || [],
      warnings: r.warnings || [],
      kindMismatch: r.kindMismatch,
      capacity,
      committed: r.committed,
      expectedCount: r.create + r.update,
    };
    if (dryRun) return res.json(payload);
    if (!r.committed) return res.status(400).json({ ...payload, error: `오류 ${r.errorCount}건이 있어 적용하지 않았습니다.` });
    if (r.saved === false) return res.status(500).json({ ...payload, error: '파일 저장에 실패했습니다(디스크·권한 확인).' });
    const tpl = getTemplate(req.params.id);
    logAudit({
      user: req.user?.username, action: 'svcmon.template.apply', target: req.params.id,
      detail: `${tpl?.name || ''} rev${tpl?.rev} · 추가 ${r.create} · 갱신 ${r.update} · 건너뜀 ${r.skip}${req.body?.overwrite ? ' · overwrite' : ''}`,
    });
    res.json(payload);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/* ── 대량 자동등록 ── */

/**
 * 이름 규칙 + IP 범위로 대상을 생성한다. `mode:'preview'` 는 저장하지 않는다.
 * 개수 불일치·IP 파싱 오류·차단 주소는 **전체 거부**한다 — 중간 오류 1건이 그 뒤 전 이름↔IP
 * 매핑을 한 칸 밀어 전 대상이 엉뚱한 주소를 감시하게 된다.
 */
svcmonRouter.post('/targets/generate', canEdit, (req, res) => {
  const spec = req.body?.spec || {};
  const commit = req.body?.mode === 'apply';
  const tplId = typeof spec.templateId === 'string' ? spec.templateId.trim() : '';
  let tpl = null;
  if (tplId) {
    tpl = getTemplate(tplId);
    if (!tpl) return res.status(400).json({ error: `템플릿을 찾을 수 없습니다: ${tplId}` });
  }

  // 템플릿 항목을 대상별로 실체화(치환 → 정제)한다. genspec 은 templates 를 import 하지 않고
  // 이 콜백만 호출한다 — 순환 의존을 피하고 치환 책임을 한 곳(templates.js)에 둔다.
  // 미치환 변수가 남거나 치환 결과가 SSRF 가드에 걸리면 여기서 throw 되어 그 행이 오류가 된다.
  const genErrors = [];
  const materialize = tpl
    ? (target) => {
      const r = materializeForTarget(tplId, target);
      if (r.errors.length) genErrors.push(...r.errors.map((e) => `${target.name}: ${e}`));
      return r.tests;
    }
    : null;

  const ex = expandGenSpec(spec, materialize ? { materialize } : {});
  if (genErrors.length) ex.errors.push(...genErrors);
  if (ex.errors.length || ex.blocked.length) {
    return res.status(400).json({
      summary: { rows: ex.stats?.names || 0, create: 0, skip: 0, error: ex.errors.length },
      errors: ex.errors.map((reason) => ({ row: 0, name: '', reason })),
      blocked: ex.blocked, warnings: ex.warnings, stats: ex.stats, suggest: ex.suggest,
      limits: LIMITS,
      error: ex.errors[0] || `차단된 주소 ${ex.blocked.length}개가 있어 생성하지 않았습니다.`,
    });
  }

  const dry = dryRunTargets(ex.rows);
  const errors = dry.errors;
  const payload = {
    mode: commit ? 'apply' : 'preview',
    summary: { rows: ex.rows.length, create: dry.create, skip: dry.skip, error: errors.length, newFolders: dry.newFolders, newTests: dry.newTests },
    errors: errors.slice(0, 300),
    truncated: { errors: errors.length > 300 },
    warnings: ex.warnings, stats: ex.stats, blocked: [],
    sample: dry.sample, after: dry.after, limits: LIMITS, capacity: dry.capacity,
    expectedCount: dry.create,
  };
  if (!commit) return res.json(payload);

  if (errors.length) return res.status(400).json({ ...payload, error: `오류 ${errors.length}건이 있어 등록하지 않았습니다.` });
  if (dry.capacity.verdict === 'reject') return res.status(400).json({ ...payload, error: dry.capacity.reasons[0] });
  if (typeof req.body?.expectedCount === 'number' && req.body.expectedCount !== dry.create) {
    return res.status(409).json({ ...payload, error: '미리보기 이후 목록이 바뀌었습니다. 미리보기를 다시 확인하세요.' });
  }
  const batch = 'b-' + Math.random().toString(36).slice(2, 10);
  const r = bulkAddTargets(ex.rows, { batch });
  if (!r.committed) return res.status(400).json({ ...payload, ...r, error: '검증에 실패해 등록하지 않았습니다.' });
  if (!r.saved) return res.status(500).json({ ...payload, ...r, error: '파일 저장에 실패했습니다(디스크·권한 확인).' });
  recordBatch({
    id: batch, createdBy: req.user?.username || '', source: 'generate',
    kind: spec.kind || 'infra', path: spec.path || '', targets: r.added, tests: r.newTests, templateId: tplId,
  });
  logAudit({
    user: req.user?.username, action: 'svcmon.target.generate',
    detail: `batch=${batch} · 대상 ${r.added} · 점검 ${r.newTests}${tplId ? ` · ${tplId}` : ''} · 필요 ${dry.capacity.requiredPerSec}/s`,
  });
  res.status(201).json({ ...payload, ...r, batch });
});

/* ── 배치 이력 / 롤백 ── */

svcmonRouter.get('/batches', canEdit, (req, res) => res.json({ batches: listBatches() }));

svcmonRouter.post('/batches/:id/rollback', canEdit, (req, res) => {
  const r = rollbackBatch(req.params.id, {
    expectedCount: typeof req.body?.expectedCount === 'number' ? req.body.expectedCount : null,
    user: req.user?.username,
  });
  if (r.error) return res.status(400).json(r);
  logAudit({
    user: req.user?.username, action: 'svcmon.target.batch.delete', target: req.params.id,
    detail: `대상 ${r.removed} · 점검 ${r.tests}`,
  });
  res.json({ ...r, batches: listBatches() });
});

svcmonRouter.delete('/batches/:id', canEdit, (req, res) => {
  if (!deleteBatchRecord(req.params.id)) return res.status(404).json({ error: '배치 기록을 찾을 수 없습니다.' });
  logAudit({ user: req.user?.username, action: 'svcmon.batch.record.delete', target: req.params.id, detail: '이력만 삭제(대상 유지)' });
  res.json({ ok: true, batches: listBatches() });
});

/* ── 엣지 배정(중앙 → 엣지 정의 배포) ── */

/** 배정 목록 + 이 인스턴스의 역할. 화면이 '중앙은 실행하지 않는다'를 명확히 표시해야 한다. */
svcmonRouter.get('/assign', canEdit, (req, res) => {
  res.json({
    role: pollerRole(),
    assignments: listAssignments(),
    defaultExceptTypes: DEFAULT_EXCEPT_TYPES,
    maxTargetsPerAgent: MAX_TARGETS_PER_AGENT,
    // 배정 후보 엣지 = 개별 토큰이 발급된 엣지 + 이미 보고 중인 엣지
    reporting: edgeSummary().map((e) => e.agent),
    pull: svcmonConfigPullStatus(),
  });
});

/**
 * 배정 저장 — 중앙 트리에서 범위를 잘라 그 엣지 몫으로 굳힌다(스냅샷).
 * `mode:'preview'` 면 저장하지 않고 무엇이 배포될지만 돌려준다.
 */
svcmonRouter.put('/assign/:agent', canEdit, (req, res) => {
  try {
    const kind = KINDS.includes(req.body?.kind) ? req.body.kind : '';
    const scopePath = typeof req.body?.path === 'string' ? req.body.path.trim() : '';
    const includeSub = req.body?.includeSub !== false;
    const exceptTypes = Array.isArray(req.body?.exceptTypes) ? req.body.exceptTypes : DEFAULT_EXCEPT_TYPES;
    const picked = listTargetsCopy().filter((t) => {
      if (kind && (t.kind || 'infra') !== kind) return false;
      if (!scopePath) return true;
      return includeSub ? (t.path === scopePath || t.path.startsWith(`${scopePath}\\`)) : t.path === scopePath;
    });
    let tests = 0;
    const skip = new Set(exceptTypes);
    for (const t of picked) for (const x of t.tests) if (!skip.has(x.type)) tests += 1;

    if (req.body?.mode === 'preview') {
      return res.json({
        preview: true, agent: req.params.agent,
        counts: { targets: picked.length, tests },
        exceptTypes,
        sample: picked.slice(0, 25).map((t) => ({
          kind: t.kind, path: t.path, name: t.name, host: t.host,
          tests: t.tests.filter((x) => !skip.has(x.type)).length,
          excluded: t.tests.filter((x) => skip.has(x.type)).length,
        })),
        truncated: picked.length > 25,
      });
    }
    const a = setAssignment(req.params.agent, { kind, path: scopePath, includeSub, exceptTypes, note: req.body?.note },
      picked, { user: req.user?.username });
    res.json({ assignment: { ...a, targets: undefined }, tag: batchTag(a.sig), assignments: listAssignments() });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

svcmonRouter.delete('/assign/:agent', canEdit, (req, res) => {
  if (!deleteAssignment(req.params.agent, { user: req.user?.username })) {
    return res.status(404).json({ error: '그 엣지의 배정이 없습니다.' });
  }
  res.json({ ok: true, assignments: listAssignments() });
});

/** 이 서버가 엣지일 때 — 정의를 즉시 1회 받아 적용(진단용). */
svcmonRouter.post('/config-pull-now', canEdit, async (req, res) => {
  const r = await pullSvcmonConfigNow();
  logAudit({ user: req.user?.username, action: 'svcmon.config.pull', detail: r.ok ? `대상 ${r.added ?? '-'} · sig ${r.sig ?? '-'}` : (r.reason || '실패') });
  res.status(r.ok ? 200 : 202).json(r);
});

/* ── 엣지 위임(RMA) ── */

/** 엣지 카드 목록 — 무보고·시계 오차·ping 판정 방식·미점검 수까지 한 화면에서 본다. */
svcmonRouter.get('/edges', (req, res) => {
  const now = Date.now();
  res.json({
    edges: edgeSummary(now),
    totals: edgeTotals(now),
    limits: { maxAgents: MAX_AGENTS, maxRowsPerAgent: MAX_ROWS_PER_AGENT },
    silence: silenceStatus(),
    // 이 서버가 **엣지로서** 중앙에 보고 중인지도 함께(한 포탈이 양쪽 역할을 겸할 수 있다).
    push: svcmonPushStatus(),
  });
});

/** 엣지 1개의 항목 목록. 메타(경로·대상·호스트)는 엣지가 보내 준 범위만 있다. */
svcmonRouter.get('/edge-state', (req, res) => {
  const r = edgeState(req.query.agent, {
    path: typeof req.query.path === 'string' ? req.query.path.trim() : '',
    limit: Math.min(2000, Math.max(1, Number(req.query.limit) || 500)),
    only: typeof req.query.only === 'string' ? req.query.only.trim() : '',
  });
  if (!r) return res.status(404).json({ error: '그 엣지의 보고가 없습니다.' });
  res.json(r);
});

/** 유령 엣지 정리(이름 변경·오타로 남은 항목). 대상 정의는 엣지가 갖고 있으므로 영향 없음. */
svcmonRouter.delete('/edges/:agent', canEdit, (req, res) => {
  if (!forgetAgent(req.params.agent, req.user?.username)) {
    return res.status(404).json({ error: '그 엣지를 찾을 수 없습니다.' });
  }
  res.json({ ok: true, edges: edgeSummary() });
});

/** 이 서버가 엣지일 때 — 즉시 1회 보고(진단용). 재진입 가드는 push 모듈이 공유한다. */
svcmonRouter.post('/push-now', canEdit, async (req, res) => {
  const r = await pushSvcmonNow();
  logAudit({ user: req.user?.username, action: 'svcmon.push.now', detail: r.ok ? `행 ${r.rows} · 청크 ${r.chunks}` : (r.reason || '실패') });
  res.status(r.ok ? 200 : 202).json(r);
});

/** 무보고 감시 즉시 1회(진단용). */
svcmonRouter.post('/silence-check', canEdit, async (req, res) => res.json(await checkSilenceOnce()));

/* ── 로그 설정/파일 ── */
svcmonRouter.get('/log', (req, res) => res.json(logStatus()));

svcmonRouter.put('/log', adminOnly, (req, res) => {
  try {
    const before = getLogSettings();
    const next = setLogSettings(req.body || {});
    // 보관 정책이 줄어들면 즉시 반영(다음 파일 생성까지 기다리지 않게)
    if (next.keepFiles < before.keepFiles || (next.maxTotalMB && next.maxTotalMB < before.maxTotalMB)) {
      pruneOld(logDir(), next);
    }
    logAudit({ user: req.user?.username, action: 'svcmon.log.settings', detail: `${next.rotate}/${next.keepFiles}` });
    res.json(logStatus());
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/**
 * CSV 다운로드 — 스트리밍(GB 파일을 메모리에 올리지 않는다).
 * 로그에는 전 대상의 호스트명·점검 결과가 들어 있어 사실상 인벤토리 내보내기다 —
 * 조회 권한만으로 열어 두지 않고 편집 권한을 요구하고 감사에 남긴다.
 */
svcmonRouter.get('/log/files/:name', canEdit, (req, res) => {
  const p = logFilePath(req.params.name);
  if (!p) return res.status(404).json({ error: '로그 파일을 찾을 수 없습니다.' });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.name}"`);
  logAudit({ user: req.user?.username, action: 'svcmon.log.download', target: req.params.name });
  fs.createReadStream(p).on('error', () => res.end()).pipe(res);
});

svcmonRouter.post('/log/prune', adminOnly, (req, res) => {
  const removed = pruneOld(logDir(), getLogSettings());
  logAudit({ user: req.user?.username, action: 'svcmon.log.prune', detail: `${removed}개 삭제` });
  res.json({ removed, ...logStatus() });
});

/** 종료 전 저장 flush(운영자 수동 호출·업그레이드 스크립트용). */
svcmonRouter.post('/flush', adminOnly, (req, res) => { flushStore(); res.json({ ok: true }); });
