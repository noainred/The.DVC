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
  listTargetsCopy, listFolders, getSort, setSort, totalTests,
  addTarget, updateTarget, deleteTarget, addTest, updateTest, deleteTest,
  addFolder, renameFolder, deleteFolder, bulkAddTargets, flushStore,
  TEST_TYPES, KINDS,
} from '../svcmon/store.js';
import { getResults, getLastSweep, runNow, pollerStats } from '../svcmon/poller.js';
import { getLogSettings, setLogSettings, ROTATE_UNITS, ROTATE_LABEL } from '../svcmon/logsettings.js';
import { logStatus, logFilePath, pruneOld, logStats } from '../svcmon/csvlog.js';
import { logDir } from '../svcmon/logsettings.js';

export const svcmonRouter = express.Router();
const canEdit = requireRole('admin', 'operator');
const adminOnly = requireRole('admin');

const statusOf = (t, x, results) => (t.enabled === false || x.enabled === false)
  ? 'disabled' : (results.get(x.id)?.status || 'none');

/** 트리 + 대상 + 점검 + 최근 결과 + 요약. path/limit 으로 범위를 좁힐 수 있다. */
svcmonRouter.get('/state', (req, res) => {
  const results = getResults();
  const kind = KINDS.includes(req.query.kind) ? req.query.kind : null;
  const scope = typeof req.query.path === 'string' ? req.query.path : '';
  const limit = Math.min(2000, Math.max(1, Number(req.query.limit) || 300));

  const all = listTargetsCopy();
  // 요약은 항상 전체(또는 kind 전체) 기준 — 화면 상단 KPI 가 페이징에 흔들리지 않게.
  const summary = { total: 0, ok: 0, warn: 0, bad: 0, disabled: 0 };
  for (const t of all) {
    if (kind && t.kind !== kind) continue;
    for (const x of t.tests) {
      summary.total += 1;
      const st = statusOf(t, x, results);
      if (st === 'ok') summary.ok += 1;
      else if (st === 'warn') summary.warn += 1;
      else if (st === 'bad') summary.bad += 1;
      else summary.disabled += 1;
    }
  }

  const inScope = all.filter((t) => (!kind || t.kind === kind)
    && (!scope || t.path === scope || t.path.startsWith(`${scope}\\`)));
  const targets = inScope.slice(0, limit).map((t) => ({
    ...t,
    tests: t.tests.map((x) => ({ ...x, result: results.get(x.id) || null })),
  }));

  res.json({
    targets,
    folders: listFolders(),
    sort: getSort(),
    summary,
    truncated: inScope.length > targets.length,
    scopeCount: inScope.length,
    targetCount: all.length,
    testTypes: TEST_TYPES,
    rotateUnits: ROTATE_UNITS,
    rotateLabels: ROTATE_LABEL,
    lastSweep: getLastSweep(),
  });
});

/** 운영 진단 — 워커/폴러/로그 라이터 상태(부하 점검용). */
svcmonRouter.get('/diag', (req, res) => {
  res.json({ poller: pollerStats(), log: logStats(), targets: listTargetsCopy().length, tests: totalTests() });
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
    const r = bulkAddTargets(Array.isArray(req.body?.targets) ? req.body.targets : []);
    logAudit({ user: req.user?.username, action: 'svcmon.target.bulk', detail: `추가 ${r.added} · 오류 ${r.errors.length}` });
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

/** CSV 다운로드 — 스트리밍(GB 파일을 메모리에 올리지 않는다). */
svcmonRouter.get('/log/files/:name', (req, res) => {
  const p = logFilePath(req.params.name);
  if (!p) return res.status(404).json({ error: '로그 파일을 찾을 수 없습니다.' });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.name}"`);
  fs.createReadStream(p).on('error', () => res.end()).pipe(res);
});

svcmonRouter.post('/log/prune', adminOnly, (req, res) => {
  const removed = pruneOld(logDir(), getLogSettings());
  logAudit({ user: req.user?.username, action: 'svcmon.log.prune', detail: `${removed}개 삭제` });
  res.json({ removed, ...logStatus() });
});

/** 종료 전 저장 flush(운영자 수동 호출·업그레이드 스크립트용). */
svcmonRouter.post('/flush', adminOnly, (req, res) => { flushStore(); res.json({ ok: true }); });
