/**
 * 인사이트 API — FinOps(전력·비용), AI 이상탐지, 용량 예측, 보안 자세(CVE/EOL),
 * 토폴로지, 인시던트 타임라인, ChatOps. /api 하위(로그인 필요)에 마운트. 설정 변경은 admin.
 */

import { Router } from 'express';
import { requireRole } from '../auth/auth.js';
import { store } from '../store.js';
import { latestPowerByHostName, allMeasuredPower } from '../idrac/service.js';
import { filterMeasuredByMapping, loadPowerSettings } from '../idrac/powerSettings.js';
import { snapMemo, sendCached } from '../util/snapCache.js';
import { computeFinOps, loadFinopsConfig, saveFinopsConfig } from '../insights/finops.js';
import { computePowerBreakdown } from '../insights/powerBreakdown.js';
import { getFleetInventory } from '../insights/fleetInventory.js';
import { loadFleetTags, setFleetTag } from '../insights/fleetTags.js';
import { detectAnomalies } from '../insights/anomaly.js';
import { forecastCapacity } from '../insights/forecast.js';
import { computeSecurityPosture } from '../insights/cve.js';
import { buildTopology } from '../insights/topology.js';
import { buildGraph } from '../insights/graph.js';
import { getIncidents } from '../insights/incidents.js';
import { chatOps } from '../llm/chatops.js';

export const insightsRouter = Router();
const adminOnly = requireRole('admin');

// --- FinOps: 전력 → kWh·비용·CO2 ---
insightsRouter.get('/finops', async (req, res) => {
  try {
    const snap = store.get();
    const key = `${snap.generatedAt}|${JSON.stringify(loadPowerSettings())}|${JSON.stringify(loadFinopsConfig())}`;
    const payload = await snapMemo('finops', key, 60_000, async () => {
      const measured = filterMeasuredByMapping(await allMeasuredPower({ hosts: snap.hosts }), snap);
      return computeFinOps(snap, measured);
    });
    sendCached(req, res, key, payload);
  } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});
insightsRouter.get('/finops/config', (_req, res) => res.json(loadFinopsConfig()));

// --- 전력 분석: 법인(vCenter)·모델·지역별 소비전력 분해 ---
insightsRouter.get('/power-breakdown', async (req, res) => {
  try {
    const snap = store.get();
    const vc = String(req.query.vcenterId || '');
    const key = `${snap.generatedAt}|${vc}|${JSON.stringify(loadPowerSettings())}`;
    const payload = await snapMemo('power-breakdown', key, 60_000, async () => {
      const measured = filterMeasuredByMapping(await allMeasuredPower({ hosts: snap.hosts }), snap);
      return computePowerBreakdown(snap, measured, { vcenterId: vc });
    });
    sendCached(req, res, key, payload);
  } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});
insightsRouter.put('/finops/config', adminOnly, (req, res) => res.json(saveFinopsConfig(req.body || {})));

// --- 통합 서버 인벤토리: iDRAC/OME 물리 서버 + vCenter 호스트 → 가상화/베어메탈 분류 + 베어메탈 전력 ---
insightsRouter.get('/fleet', async (req, res) => {
  try {
    const snap = store.get();
    const key = `${snap.generatedAt}|${JSON.stringify(loadFleetTags())}`;
    const payload = await snapMemo('fleet', key, 60_000, async () => getFleetInventory(snap));
    sendCached(req, res, key, payload);
  } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});
// 수동 분류 예외 지정/해제(관리자). body: { key, tag: 'baremetal'|'virtualization'|'exclude'|'auto' }
insightsRouter.put('/fleet/tag', adminOnly, async (req, res) => {
  const r = setFleetTag(req.body?.key, req.body?.tag);
  if (r.ok) await store.refresh().catch(() => {}); // 분류 즉시 반영
  res.json(r);
});

// --- AI 이상탐지 ---
insightsRouter.get('/anomalies', async (req, res) => {
  try { res.json(await detectAnomalies(req.query)); }
  catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});

// --- 용량/수명 예측 ---
insightsRouter.get('/forecast', async (req, res) => {
  try { res.json(await forecastCapacity(store.get(), req.query)); }
  catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});

// --- 보안 자세(CVE/EOL) ---
insightsRouter.get('/security', (_req, res) => res.json(computeSecurityPosture(store.get())));

// --- 토폴로지·의존성 ---
insightsRouter.get('/topology', async (req, res) => {
  const snap = store.get();
  const vc = req.query.vcenterId || null; const host = req.query.host || null;
  const key = `${snap.generatedAt}|${vc || ''}|${host || ''}`;
  const payload = await snapMemo('topology', key, 60_000, async () => buildTopology(snap, { vcenterId: vc, host }));
  sendCached(req, res, key, payload);
});

// --- 구성도 그래프(3D 네트워크용) — 설정된 구성 + 라이브 스냅샷 ---
insightsRouter.get('/graph', async (req, res) => {
  const snap = store.get();
  const vms = req.query.vms === '1' || req.query.vms === 'true';
  const vc = req.query.vcenterId || null; const host = req.query.host || null;
  const key = `${snap.generatedAt}|${vms ? 1 : 0}|${vc || ''}|${host || ''}`;
  const payload = await snapMemo('graph', key, 60_000, async () => buildGraph(snap, { vms, vcenterId: vc, host }));
  sendCached(req, res, key, payload);
});

// --- 인시던트 타임라인 ---
insightsRouter.get('/incidents', (req, res) => res.json(getIncidents({ limit: Number(req.query.limit) || 200 })));

// --- ChatOps(자연어 운영 질의) ---
insightsRouter.post('/chatops', async (req, res) => {
  try { res.json(await chatOps(req.body?.question || req.body?.q || '')); }
  catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});
