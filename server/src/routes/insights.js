/**
 * 인사이트 API — FinOps(전력·비용), AI 이상탐지, 용량 예측, 보안 자세(CVE/EOL),
 * 토폴로지, 인시던트 타임라인, ChatOps. /api 하위(로그인 필요)에 마운트. 설정 변경은 admin.
 */

import { Router } from 'express';
import { requireRole } from '../auth/auth.js';
import { store } from '../store.js';
import { allMeasuredPower } from '../idrac/service.js';
import { filterMeasuredByMapping, loadPowerSettings } from '../idrac/powerSettings.js';
import { snapMemo, sendCached } from '../util/snapCache.js';
import { computeFinOps, loadFinopsConfig, saveFinopsConfig } from '../insights/finops.js';
import { computePowerBreakdown } from '../insights/powerBreakdown.js';
import { getFleetInventory } from '../insights/fleetInventory.js';
import { setFleetTag } from '../insights/fleetTags.js';
import { setFleetAssign, applyFleetAssign } from '../insights/fleetAssign.js';
import { fleetRev } from '../insights/fleetRev.js';
import { loadRegistry, updateServer } from '../idrac/registry.js';
import { logAudit } from '../audit.js';
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
    const key = `${snap.generatedAt}|${JSON.stringify(loadPowerSettings())}|${JSON.stringify(loadFinopsConfig())}|${fleetRev()}`;
    const payload = await snapMemo('finops', key, 60_000, async () => {
      const measured = filterMeasuredByMapping(applyFleetAssign(await allMeasuredPower({ hosts: snap.hosts })), snap);
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
    const key = `${snap.generatedAt}|${vc}|${JSON.stringify(loadPowerSettings())}|${fleetRev()}`;
    const payload = await snapMemo('power-breakdown', key, 60_000, async () => {
      const measured = filterMeasuredByMapping(applyFleetAssign(await allMeasuredPower({ hosts: snap.hosts })), snap);
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
    // 캐시 키: 스냅샷 생성시각 + 플릿 리비전(태그/소속/레지스트리 변경 시 즉시 +1). 매 요청 파일 읽기 없음.
    const key = `${snap.generatedAt}|${fleetRev()}`;
    const payload = await snapMemo('fleet', key, 60_000, async () => getFleetInventory(snap));
    sendCached(req, res, key, payload);
  } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});
// 수동 분류 예외 지정/해제(관리자). body: { key, tag: 'baremetal'|'virtualization'|'exclude'|'auto' }
// 전체 vCenter 재폴링(store.refresh) 없이 fleetRev만 올려 다음 GET에서 즉시 재계산(고RTT·30개 환경 보호).
insightsRouter.put('/fleet/tag', adminOnly, (req, res) => {
  const r = setFleetTag(req.body?.key, req.body?.tag);
  if (r.ok) logAudit({ user: req.user?.username, action: '플릿 분류 변경', target: String(req.body?.key || ''), detail: String(req.body?.tag || 'auto'), ip: req.ip || '' });
  res.json(r);
});
// 베어메탈 서버의 소속 법인(vCenter) 등록/해제(관리자). body: { serverId, serviceTag, key, vcenterId }.
// iDRAC 레지스트리에 등록된 서버는 레지스트리 vcenterId(전력 귀속과 공유)를 직접 갱신하고(권위 소스),
// 동일 키의 stale fleet-assign은 정리해 split-brain을 막는다. 그 외(OME/원격/무전력 발견분)는
// fleet-assign 저장소에 키 기준으로 보관한다. vcenterId는 실제 존재하는 vCenter만 허용(유령 법인 차단).
insightsRouter.put('/fleet/assign', adminOnly, (req, res) => {
  const serverId = String(req.body?.serverId || '').trim();
  const serviceTag = String(req.body?.serviceTag || '').trim();
  const assignKey = String(req.body?.key || serviceTag || serverId).trim();
  const vcenterId = String(req.body?.vcenterId || '').trim();
  if (!assignKey) return res.status(400).json({ ok: false, reason: 'serverId/serviceTag/key 중 하나가 필요합니다.' });
  const validIds = new Set((store.get().vcenters || []).map((v) => v.id));
  if (vcenterId && !validIds.has(vcenterId)) return res.status(400).json({ ok: false, reason: `존재하지 않는 vCenter id: ${vcenterId}` });

  const reg = serverId ? loadRegistry().find((s) => s.id === serverId && s.type !== 'ome') : null;
  let via = 'assign';
  if (reg) {
    const r = updateServer(serverId, { vcenterId });
    if (!r.ok) return res.status(400).json(r);
    // 레지스트리가 권위 소스가 되었으므로 동일 키의 과거 fleet-assign(OME 발견기 등)을 정리.
    setFleetAssign(assignKey, '');
    if (serviceTag) setFleetAssign(serviceTag, '');
    via = 'registry';
  } else {
    const r = setFleetAssign(assignKey, vcenterId, validIds);
    if (!r.ok) return res.status(400).json(r);
  }
  logAudit({ user: req.user?.username, action: '플릿 법인 귀속', target: assignKey, detail: vcenterId ? `→ ${vcenterId} (${via})` : `해제 (${via})`, ip: req.ip || '' });
  res.json({ ok: true, via, vcenterId });
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
