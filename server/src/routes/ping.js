/**
 * Ping 모니터링 API — 네트워크 메뉴의 'Ping 모니터링' 화면용.
 *  GET  /api/ping/status              모든 대상 현재 상태(최신 RTT + baseline 분류) — 인증 사용자
 *  GET  /api/ping/series?id=&range=   단일 대상 시계열(다운샘플, 색상 상태) — 인증 사용자
 *  GET  /api/ping/targets             대상 목록 — 인증 사용자
 *  POST /api/ping/targets             대상 추가 — 관리자
 *  PUT  /api/ping/targets/:id         대상 수정 — 관리자
 *  DELETE /api/ping/targets/:id       대상 삭제(이력도 제거) — 관리자
 *  POST /api/ping/poll-now            즉시 1회 측정 — 관리자
 */

import express from 'express';
import { requireRole } from '../auth/auth.js';
<<<<<<< HEAD
import { loadVcenterConfig } from '../config.js';
import { listTargets, addTarget, updateTarget, removeTarget, seedVcenterTargets } from '../ping/store.js';
=======
import { listTargets, addTarget, updateTarget, removeTarget } from '../ping/store.js';
>>>>>>> origin/claude/vmware-global-monitoring-portal-nrnpnt
import { statusAll, seriesOf } from '../ping/service.js';
import { getPingDb } from '../ping/db.js';
import { pollOnce } from '../ping/monitor.js';

export const pingRouter = express.Router();
const adminOnly = requireRole('admin');

const RANGES = {
  '1h': 3_600_000, '6h': 6 * 3_600_000, '24h': 24 * 3_600_000,
  '7d': 7 * 86_400_000, '30d': 30 * 86_400_000, '1y': 365 * 86_400_000,
};

pingRouter.get('/status', async (_req, res) => {
  try { res.json(await statusAll()); } catch (e) { res.status(500).json({ error: e.message }); }
});

pingRouter.get('/targets', (_req, res) => res.json({ targets: listTargets() }));

pingRouter.get('/series', async (req, res) => {
  const id = String(req.query.id || '');
  if (!id) return res.status(400).json({ ok: false, reason: 'id가 필요합니다.' });
  const rangeMs = RANGES[String(req.query.range || '6h')] || RANGES['6h'];
  const points = Math.max(30, Math.min(1000, Number(req.query.points) || 240));
  try { const r = await seriesOf(id, { rangeMs, points }); res.status(r.ok ? 200 : 404).json(r); }
  catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});

pingRouter.post('/targets', adminOnly, (req, res) => {
  const r = addTarget(req.body || {});
  res.status(r.ok ? 200 : 400).json(r);
});

pingRouter.put('/targets/:id', adminOnly, (req, res) => {
  const r = updateTarget(req.params.id, req.body || {});
  res.status(r.ok ? 200 : 400).json(r);
});

pingRouter.delete('/targets/:id', adminOnly, async (req, res) => {
  const r = removeTarget(req.params.id);
  if (r.ok) { try { (await getPingDb()).dropTarget(r.id); } catch { /* 이력 삭제 실패는 무시 */ } }
  res.status(r.ok ? 200 : 400).json(r);
});

pingRouter.post('/poll-now', adminOnly, async (_req, res) => {
  try { const r = await pollOnce(); res.json({ ok: true, ...(r || {}) }); }
  catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});
<<<<<<< HEAD

// vCenter를 Ping 대상으로 동기화(신규 vCenter 자동 등록). 재시작 없이 즉시 반영.
pingRouter.post('/seed-vcenters', adminOnly, (_req, res) => {
  try { const { vcenters } = loadVcenterConfig(); res.json(seedVcenterTargets(vcenters)); }
  catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});
=======
>>>>>>> origin/claude/vmware-global-monitoring-portal-nrnpnt
