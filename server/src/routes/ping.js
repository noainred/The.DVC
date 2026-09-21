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
import { scopedVcenterIds } from '../auth/scope.js';
import { store } from '../store.js';
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

import { wrapAsyncRouter } from '../util/asyncRoute.js';
export const pingRouter = express.Router();
// v2.574 BUG-03: express 4 는 async 핸들러의 throw 를 잡지 않아 그 요청이 **응답 없이
// 매달린다**(소켓 fd 가 잡힌다). 라우트를 등록하기 **전에** 감싸 전역 에러 핸들러로 보낸다.
// ⚠ 라우트 등록보다 아래로 옮기지 말 것 — 그 뒤에 등록된 것만 보호된다.
wrapAsyncRouter(pingRouter);
const adminOnly = requireRole('admin');

// 일 단위 범위(네트워크 체크 UI: 1일/7일/30일/90일/365일) + 기존 시간 범위 호환.
const DAY = 86_400_000;
const RANGES = {
  '1h': 3_600_000, '6h': 6 * 3_600_000, '24h': DAY, '1d': DAY,
  '7d': 7 * DAY, '30d': 30 * DAY, '90d': 90 * DAY, '365d': 365 * DAY, '1y': 365 * DAY,
};
const rangeMsOf = (q, def = '1d') => RANGES[String(q || def)] || RANGES[def];

// ⚠ 보안(M-2, 2026-09-12): 조회 라우트에 사용자 vCenter scope 를 강제한다. 범위 제한 계정이
// 전 vCenter 관리 호스트명·IP·응답시간을 열람하던 갭(CLAUDE.md "조회 라우트 scope 는 예외 없이")
// 을 닫는다. vCenter 타깃 id 는 'vc_<vcenterId>' 이므로 그 접두를 벗겨 허용 집합과 대조한다.
// manual 타깃(vCenter 귀속 없음)은 그대로 두고(기존 동작), edge 타깃은 별도 라우트(DC 그룹)다.
function vcScope(req) {
  const allowed = scopedVcenterIds(req.user, store.get()); // null = 전체 허용
  const vcIdOf = (id) => (String(id).startsWith('vc_') ? String(id).slice(3) : null);
  return {
    all: !allowed,
    okId: (id) => { if (!allowed) return true; const v = vcIdOf(id); return v == null || allowed.has(v); },
    okVcenterId: (vcId) => !allowed || allowed.has(String(vcId)),
  };
}

const vcenterList = () => (loadVcenterConfig().vcenters || []).map((v) => ({ id: v.id, name: v.name || v.id, host: v.host }));
const vcNameMap = () => { const m = new Map(vcenterList().map((v) => [String(v.id), v.name])); return (id) => m.get(String(id)) || id; };
const dcNameMap = () => { const m = new Map(listDatacenters().map((d) => [d.id, d.name || d.id])); return (id) => m.get(String(id)) || id; };

// ── 공통(기존 Ping 모니터링) — manual/vcenter만 ────────────────────────────────
pingRouter.get('/status', async (req, res) => {
  try {
    const scope = vcScope(req);
    const r = await statusAll(['manual', 'vcenter']);
    if (scope.all) return res.json(r);
    const targets = (r.targets || []).filter((t) => scope.okId(t.id));
    const counts = targets.reduce((a, t) => { a[t.status] = (a[t.status] || 0) + 1; return a; }, {});
    res.json({ targets, counts, total: targets.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

pingRouter.get('/targets', (req, res) => {
  const scope = vcScope(req);
  res.json({ targets: listTargets().filter((t) => (t.source === 'manual' || t.source === 'vcenter') && scope.okId(t.id)) });
});

pingRouter.get('/series', async (req, res) => {
  const id = String(req.query.id || '');
  if (!id) return res.status(400).json({ ok: false, reason: 'id가 필요합니다.' });
  // 범위 밖 vCenter 대상은 404(존재 은닉 — 단건 라우트 규약).
  if (!vcScope(req).okId(id)) return res.status(404).json({ ok: false, reason: '없는 대상' });
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

/**
 * 엣지 노드 주소를 **볼 수 있는 계정인가** (v2.574 SEC-06).
 *
 * ⚠⚠ 엣지 타깃의 `host`/`port` 는 `ping/store.js:176-182 seedEdgeTargets()` 가
 *   **수집 서버 등록부의 url 에서 뽑아** 넣은 값 = 각 법인 **엣지 포탈의 실제 주소와 포트**다.
 *   이 저장소는 그 정보를 반복해서 **adminOnly + fullScopeOnly** 로 묶어 왔다
 *   (`routes/api/linkCheck.js:8` · `portalCheck.js:9` · `edgeLog.js:7` — 전부 "전 법인 엣지
 *   주소·내부 IP 가 담긴다 … operator 는 tools 를 기본 보유한다" 가 근거).
 *   그런데 `/edge/overview` 는 `index.js:297` 이 `authMiddleware + requireEnrolled` 로만
 *   mount 해 **아무 로그인 계정(viewer 포함)** 이 전 법인 엣지 주소를 볼 수 있었다.
 *
 * ⚠ 그렇다고 라우트를 403 으로 막지는 않는다 — 이 응답은 메인 내비의 **네트워크 › 체크** 화면
 *   (`web/src/views/Networks.jsx:60`)이 쓰는 것이라 막으면 operator 의 정상 업무가 통째로 깨진다.
 *   대신 **주소만 가린다**(이름·RTT·상태·추이는 그대로) — v2.500 D/M1 이 relaycheck 에서 택한
 *   것과 같은 방식이다("역할별 축약은 응답을 스프레드하지 말고 전용 모듈에서").
 * ⚠ 가린 사실을 **숨기지 않는다**(`addressHidden`) — 화면이 '왜 주소가 비었나' 를 말할 수 있게.
 */
function redactEdgeAddresses(out, req) {
  const isAdmin = req.user?.role === 'admin';
  const fullScope = !scopedVcenterIds(req.user, store.get());
  if (isAdmin && fullScope) return out;
  const groups = (out?.groups || []).map((g) => ({
    ...g,
    items: (g.items || []).map(({ host, port, ...rest }) => ({ ...rest, host: null, port: null })),
  }));
  return { ...out, groups, addressHidden: true };
}

// ── 네트워크 체크(서버 Ping) — 엣지 노드, DataCenter 그룹 ───────────────────────
pingRouter.get('/edge/overview', async (req, res) => {
  try {
    const r = await overviewGrouped('edge', 'datacenterId', {
      rangeMs: rangeMsOf(req.query.range, '1d'), points: Math.max(60, Math.min(600, Number(req.query.points) || 300)),
      groupName: dcNameMap(), groupOrder: getDatacenterOrder(),
    });
    res.json(redactEdgeAddresses(r, req));
  } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});

pingRouter.post('/edge/sync', adminOnly, (_req, res) => {
  try { res.json(seedEdgeTargets(listCollectors())); }
  catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});

// ── vCenter 포트 응답속도 — vCenter×사용자지정포트, vCenter 그룹 ────────────────
pingRouter.get('/vcport/overview', async (req, res) => {
  try {
    const scope = vcScope(req);
    const r = await overviewGrouped('vcport', 'vcenterId', {
      rangeMs: rangeMsOf(req.query.range, '1d'), points: Math.max(60, Math.min(600, Number(req.query.points) || 300)),
      groupName: vcNameMap(),
    });
    // 범위 제한 계정에는 허용 vCenter 그룹만(그룹 id = vcenterId). total 도 재계산.
    const groups = scope.all ? r.groups : (r.groups || []).filter((g) => scope.okVcenterId(g.id));
    const total = groups.reduce((a, g) => a + (g.items?.length || 0), 0);
    res.json({ ...r, groups, total, ports: getVcPorts() });
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
