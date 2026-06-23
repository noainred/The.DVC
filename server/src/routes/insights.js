/**
 * 인사이트 API — FinOps(전력·비용), AI 이상탐지, 용량 예측, 보안 자세(CVE/EOL),
 * 토폴로지, 인시던트 타임라인, ChatOps. /api 하위(로그인 필요)에 마운트. 설정 변경은 admin.
 */

import { Router } from 'express';
import { requireRole } from '../auth/auth.js';
import { store } from '../store.js';
import { latestPowerByHostName } from '../idrac/service.js';
import { computeFinOps, loadFinopsConfig, saveFinopsConfig } from '../insights/finops.js';
import { detectAnomalies } from '../insights/anomaly.js';
import { forecastCapacity } from '../insights/forecast.js';
import { computeSecurityPosture } from '../insights/cve.js';
import { buildTopology } from '../insights/topology.js';
import { getIncidents } from '../insights/incidents.js';
import { chatOps } from '../llm/chatops.js';

export const insightsRouter = Router();
const adminOnly = requireRole('admin');

// --- FinOps: 전력 → kWh·비용·CO2 ---
insightsRouter.get('/finops', async (_req, res) => {
  try {
    const powerMap = await latestPowerByHostName();
    res.json(computeFinOps(store.get(), powerMap));
  } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});
insightsRouter.get('/finops/config', (_req, res) => res.json(loadFinopsConfig()));
insightsRouter.put('/finops/config', adminOnly, (req, res) => res.json(saveFinopsConfig(req.body || {})));

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
insightsRouter.get('/topology', (req, res) => res.json(buildTopology(store.get(), { vcenterId: req.query.vcenterId || null, host: req.query.host || null })));

// --- 인시던트 타임라인 ---
insightsRouter.get('/incidents', (req, res) => res.json(getIncidents({ limit: Number(req.query.limit) || 200 })));

// --- ChatOps(자연어 운영 질의) ---
insightsRouter.post('/chatops', async (req, res) => {
  try { res.json(await chatOps(req.body?.question || req.body?.q || '')); }
  catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});
