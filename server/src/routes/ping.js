/**
 * Ping/네트워크 응답측정 API. 세 화면이 하나의 시계열 DB·폴러를 공유하되 source로 분리된다.
 *
 * 공통(기존 'Ping 모니터링', source=manual/vcenter):
 *  GET  /api/ping/status              현재 상태(최신 RTT + baseline 분류) — 인증
 *  GET  /api/ping/series?id=&range=   단일 대상 시계열 — 인증
 *  GET  /api/ping/targets             대상 목록 — 인증
 *  POST/PUT/DELETE /api/ping/targets  대상 관리 — 관리자
 *  POST /api/ping/poll-now            즉시 1회 측정 — 관리자
 *  POST /api/ping/seed-vcenters       vCenter 자동 등록 — 관리자
 *
 * 네트워크 체크(서버 Ping, source=edge — 엣지 노드 TCP, DataCenter 그룹):
 *  GET  /api/ping/edge/overview?range=   DC별 그룹 시계열 — 인증
 *  POST /api/ping/edge/sync              엣지 노드 자동 동기화 — 관리자
 *
 * vCenter 포트 응답속도(source=vcport — vCenter×사용자지정포트, vCenter 그룹):
 *  GET  /api/ping/vcport/overview?range= vCenter별 그룹 시계열 — 인증
 *  GET  /api/ping/vcport/ports           측정 포트 목록 — 인증
 *  PUT  /api/ping/vcport/ports           측정 포트 지정 + 대상 재구성 — 관리자
 *  POST /api/ping/vcport/sync            vCenter 변경 반영 — 관리자
 */

import express from 'express';
import { requireRole } from '../auth/auth.js';
import { loadVcenterConfig } from '../config.js';
import {
  listTargets, addTarget, updateTarget, removeTarget, seedVcenterTargets,
  seedEdgeTargets, getVcPorts, setVcPorts, syncVcPortTargets,
} from '../ping/store.js';
import { statusAll, seriesOf, overviewGrouped } from '../ping/service.js';
import { getPingDb } from '../ping/db.js';
import { pollOnce } from '../ping/monitor.js';
import { listCollectors } from '../collector/registry.js';
import { listDatacenters, getDatacenterOrder } from '../datacenter/store.js';

export const pingRouter = express.Router();
const adminOnly = requireRole('admin');

// 일 단위 범위(네트워크 체크 UI: 1일/7일/30일/90일/365일) + 기존 시간 범위 호환.
const DAY = 86_400_000;
const RANGES = {
  '1h': 3_600_000, '6h': 6 * 3_600_000, '24h': DAY, '1d': DAY,
  '7d': 7 * DAY, '30d': 30 * DAY, '90d': 90 * DAY, '365d': 365 * DAY, '1y': 365 * DAY,
};
const rangeMsOf = (q, def = '1d') => RANGES[String(q || def)] || RANGES[def];

const vcenterList = () => (loadVcenterConfig().vcenters || []).map((v) => ({ id: v.id, name: v.name || v.id, host: v.host }));
const vcNameMap = () => { const m = new Map(vcenterList().map((v) => [String(v.id), v.name])); return (id) => m.get(String(id)) || id; };
const dcNameMap = () => { const m = new Map(listDatacenters().map((d) => [d.id, d.name || d.id])); return (id) => m.get(String(id)) || id; };

// ── 공통(기존 Ping 모니터링) — manual/vcenter만 ────────────────────────────────
pingRouter.get('/status', async (_req, res) => {
  try { res.json(await statusAll(['manual', 'vcenter'])); } catch (e) { res.status(500).json({ error: e.message }); }
});

pingRouter.get('/targets', (_req, res) => res.json({ targets: listTargets().filter((t) => t.source === 'manual' || t.source === 'vcenter') }));

pingRouter.get('/series', async (req, res) => {
  const id = String(req.query.id || '');
  if (!id) return res.status(400).json({ ok: false, reason: 'id가 필요합니다.' });
  const points = Math.max(30, Math.min(1000, Number(req.query.points) || 240));
  try { const r = await seriesOf(id, { rangeMs: rangeMsOf(req.query.range, '6h'), points }); res.status(r.ok ? 200 : 404).json(r); }
  catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});

pingRouter.post('/targets', adminOnly, (req, res) => { const r = addTarget(req.body || {}); res.status(r.ok ? 200 : 400).json(r); });
pingRouter.put('/targets/:id', adminOnly, (req, res) => { const r = updateTarget(req.params.id, req.body || {}); res.status(r.ok ? 200 : 400).json(r); });
pingRouter.delete('/targets/:id', adminOnly, async (req, res) => {
  const r = removeTarget(req.params.id);
  if (r.ok) { try { (await getPingDb()).dropTarget(r.id); } catch { /* 이력 삭제 실패는 무시 */ } }
  res.status(r.ok ? 200 : 400).json(r);
});

pingRouter.post('/poll-now', adminOnly, async (_req, res) => {
  try { const r = await pollOnce(); res.json({ ok: true, ...(r || {}) }); }
  catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});

pingRouter.post('/seed-vcenters', adminOnly, (_req, res) => {
  try { const { vcenters } = loadVcenterConfig(); res.json(seedVcenterTargets(vcenters)); }
  catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});

// ── 네트워크 체크(서버 Ping) — 엣지 노드, DataCenter 그룹 ───────────────────────
pingRouter.get('/edge/overview', async (req, res) => {
  try {
    const r = await overviewGrouped('edge', 'datacenterId', {
      rangeMs: rangeMsOf(req.query.range, '1d'), points: Math.max(60, Math.min(600, Number(req.query.points) || 300)),
      groupName: dcNameMap(), groupOrder: getDatacenterOrder(),
    });
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});

pingRouter.post('/edge/sync', adminOnly, (_req, res) => {
  try { res.json(seedEdgeTargets(listCollectors())); }
  catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});

// ── vCenter 포트 응답속도 — vCenter×사용자지정포트, vCenter 그룹 ────────────────
pingRouter.get('/vcport/overview', async (req, res) => {
  try {
    const r = await overviewGrouped('vcport', 'vcenterId', {
      rangeMs: rangeMsOf(req.query.range, '1d'), points: Math.max(60, Math.min(600, Number(req.query.points) || 300)),
      groupName: vcNameMap(),
    });
    res.json({ ...r, ports: getVcPorts() });
  } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});

pingRouter.get('/vcport/ports', (_req, res) => res.json({ ports: getVcPorts() }));

pingRouter.put('/vcport/ports', adminOnly, (req, res) => {
  const r = setVcPorts((req.body || {}).ports, vcenterList());
  res.status(r.ok ? 200 : 400).json(r);
});

pingRouter.post('/vcport/sync', adminOnly, (_req, res) => {
  const r = syncVcPortTargets(vcenterList());
  res.status(r.ok ? 200 : 400).json(r);
});
