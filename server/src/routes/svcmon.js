/**
 * 성능점검(서비스 모니터링) API — 조회는 로그인 사용자 전체, 변경은 admin/operator.
 * 상태변경 라우트 RBAC 는 CLAUDE.md 보안 불변조건(POST/PUT/DELETE 에 requireRole).
 */

import express from 'express';
import { requireRole } from '../auth/auth.js';
import { logAudit } from '../audit.js';
import {
  listTargets, addTarget, updateTarget, deleteTarget,
  addTest, updateTest, deleteTest, TEST_TYPES,
} from '../svcmon/store.js';
import { getResults, getLastSweep, runNow } from '../svcmon/poller.js';

export const svcmonRouter = express.Router();
const canEdit = requireRole('admin', 'operator');

/** 트리 + 대상 + 점검 + 최근 결과 + 요약을 한 번에 — 프론트가 15초 폴링하는 단일 엔드포인트. */
svcmonRouter.get('/state', (req, res) => {
  const results = getResults();
  const targets = listTargets().map((t) => ({
    ...t,
    tests: t.tests.map((x) => ({ ...x, result: results.get(x.id) || null })),
  }));
  const summary = { total: 0, ok: 0, warn: 0, bad: 0, disabled: 0 };
  for (const t of targets) {
    for (const x of t.tests) {
      summary.total += 1;
      if (x.enabled === false || t.enabled === false) { summary.disabled += 1; continue; }
      const st = x.result?.status;
      if (st === 'ok') summary.ok += 1;
      else if (st === 'warn') summary.warn += 1;
      else if (st === 'bad') summary.bad += 1;
      else summary.disabled += 1; // 아직 미점검
    }
  }
  res.json({ targets, summary, testTypes: TEST_TYPES, lastSweep: getLastSweep() });
});

/** 수동 새로고침 — 주기 폴러와 재진입 가드를 공유(진행 중이면 202). */
svcmonRouter.post('/refresh', canEdit, async (req, res) => {
  const ran = await runNow();
  res.status(ran ? 200 : 202).json({ ok: true, ran });
});

svcmonRouter.post('/targets', canEdit, (req, res) => {
  try {
    const t = addTarget(req.body || {});
    logAudit({ user: req.user?.username, action: 'svcmon.target.add', target: t.name, detail: t.host });
    res.status(201).json({ target: t });
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
