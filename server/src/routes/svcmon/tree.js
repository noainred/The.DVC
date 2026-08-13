/**
 * 성능점검 폴더/정렬 트리 + 대상·점검 CRUD — routes/svcmon.js(구 1,053줄) 분할(v2.291.0).
 * 본문은 원본 그대로, 등록 순서는 셸(routes/svcmon.js)의 register 호출 순서가 보존한다.
 *
 * 순서 메모: 이 모듈의 param 라우트(PUT·DELETE /targets/:id, /targets/:id/tests*)는 전부
 * PUT/DELETE/POST 이고, transfer.js 의 /targets/* 리터럴 GET/POST 와는 메서드 또는 3번째
 * 세그먼트 리터럴이 달라 겹치지 않는다(예: POST /targets/:id/tests vs POST /targets/hostmap/parse
 * — 'tests'≠'parse'). 유일한 순서 민감 쌍(export.csv→export.:format)은 transfer.js 내부에 있다.
 */

import { logAudit } from '../../audit.js';
import {
  listFolders, setSort,
  addTarget, updateTarget, deleteTarget, addTest, updateTest, deleteTest,
  addFolder, renameFolder, moveFolder, reorderTargets, reorderFolders, deleteFolder, bulkAddTargets,
  LIMITS,
} from '../../svcmon/store.js';
import { canEdit } from './shared.js';

export function registerTree(svcmonRouter) {

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

svcmonRouter.post('/folders/move', canEdit, (req, res) => {
  try {
    const r = moveFolder(req.body || {});
    logAudit({ user: req.user?.username, action: 'svcmon.folder.move', target: r.path, detail: `이동 ${r.moved}건 (from ${req.body?.path})` });
    res.json({ ...r, folders: listFolders() });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

svcmonRouter.put('/reorder/targets', canEdit, (req, res) => {
  try { res.json(reorderTargets(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

svcmonRouter.put('/reorder/folders', canEdit, (req, res) => {
  try { res.json(reorderFolders(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
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

}
