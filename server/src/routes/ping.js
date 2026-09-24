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
  // v2.597(감사 AUTHZ-2597-01): 대상 객체에 vcenterId 가 있으면 그것이 귀속이다 — id 접두('vc_')만 보면 vcenterId 만
  //   가진 대상(수동 등록 등)이 범위 밖인데도 이름·관리 IP·RTT 가 보였다.
  let byId = null;
  const targetOf = (id) => { if (!byId) byId = new Map(listTargets().map((t) => [String(t.id), t])); return byId.get(String(id)); };
  const vcOfTarget = (t, id) => (t && t.vcenterId ? String(t.vcenterId) : vcIdOf(id));
  return {
    all: !allowed,
    okId: (id, t = targetOf(id)) => { if (!allowed) return true; const v = vcOfTarget(t, id); return v == null || allowed.has(v); },
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
    // ⚠ v2.575 BUG-16: `...r` 로 펼쳐 `monitorEnabled`·`intervalMs` 를 보존한다 —
    // 빠뜨리면 범위 제한 계정 화면만 '폴러가 꺼졌는지' 를 모른 채 '기다리면 됩니다' 라고 말한다.
    res.json({ ...r, targets, counts, total: targets.length });
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
  try {
    const r = await seriesOf(id, { rangeMs: rangeMsOf(req.query.range, '6h'), points });
    // v2.598(감사 AUTHZ-2598-01): 엣지 대상은 /edge/overview 와 **같은 판정**으로 주소를 가린다 —
    //   id 만 알면 이 단건 경로로 엣지 포탈의 host·port 가 그대로 나갔다(SEC-06 우회).
    if (r.ok && r.target && isEdgeTarget(id) && !canSeeEdgeAddress(req)) {
      return res.json({ ...r, target: { ...r.target, host: null, port: null }, addressHidden: true });
    }
    res.status(r.ok ? 200 : 404).json(r);
  }
  catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});

// v2.606 AUTHZ2606-02: 쓰기에도 조회와 **같은 범위**를 건다. 예전에는 adminOnly 뿐이라 범위 제한 admin 이
//   목록·/series 에서 404 로 숨겨진 범위 밖 대상을 PUT 으로 vcenterId 를 바꿔 **범위 안으로 끌어와** 주소·이력을
//   읽거나, DELETE 로 이력째 지울 수 있었다(쓰기가 읽기 범위를 넓혔다). 판정:
//   · 기존 대상 — okId(id)(조회와 같은 판정) + 목록에 보이는 종류(manual·vcenter)만. 밖이면 404(존재 은닉).
//   · 새 값 — body.vcenterId·body.id('vc_' 접두)가 범위 안이어야 한다. 밖이면 404 로 같은 은닉.
//   · 범위 계정은 source 를 manual·vcenter 밖으로 바꾸지 못한다(edge·vcport 는 전 법인 공용 목록이다).
//   전체 범위 admin 은 예전 그대로(scope.all).
const LISTED_SOURCES = new Set(['manual', 'vcenter']);
function scopedWriteDenied(req, { id = null, existing = false } = {}) {
  const scope = vcScope(req);
  if (scope.all) return false;
  const body = req.body || {};
  if (existing) {
    const t = listTargets().find((x) => String(x.id) === String(id));
    if (t && (!LISTED_SOURCES.has(t.source || 'manual') || !scope.okId(id, t))) return true;
    if (t && body.vcenterId == null && body.source == null) return false;
    const next = { ...(t || {}), ...(body.vcenterId != null ? { vcenterId: String(body.vcenterId || '') } : {}) };
    if (body.source != null && !LISTED_SOURCES.has(String(body.source))) return true;
    return !scope.okId(id, next);
  }
  if (body.source != null && !LISTED_SOURCES.has(String(body.source))) return true;
  const bid = body.id != null ? String(body.id) : '';
  const cur = bid ? listTargets().find((x) => String(x.id) === bid) : null;
  if (cur && (!LISTED_SOURCES.has(cur.source || 'manual') || !scope.okId(bid, cur))) return true;   // 범위 밖 기존 id 의 존재를 알리지 않는다
  if (body.vcenterId != null && String(body.vcenterId) !== '' && !scope.okVcenterId(body.vcenterId)) return true;
  return !scope.okId(bid || '_new', { vcenterId: body.vcenterId ? String(body.vcenterId) : '' });
}
const scopeNotFound = (res) => res.status(404).json({ ok: false, reason: '없는 대상' });
// 범위 계정에는 전 vCenter·전 대상을 건드리는 일괄 작업을 열지 않는다(seed-vcenters·vcport·poll-now).
function denyScopedBulk(req, res, what) {
  if (vcScope(req).all) return false;
  res.status(403).json({ ok: false, error: 'forbidden', requiredOwner: true, reason: `${what}은(는) 전 vCenter 대상을 바꿉니다 — 전체 범위(vCenter 제한 없는) 계정만 할 수 있습니다.` });
  return true;
}

pingRouter.post('/targets', adminOnly, (req, res) => {
  if (scopedWriteDenied(req)) return res.status(404).json({ ok: false, reason: '범위 밖 vCenter 대상은 등록할 수 없습니다.' });
  const r = addTarget(req.body || {}); res.status(r.ok ? 200 : 400).json(r);
});
pingRouter.put('/targets/:id', adminOnly, (req, res) => {
  if (scopedWriteDenied(req, { id: req.params.id, existing: true })) return scopeNotFound(res);
  const r = updateTarget(req.params.id, req.body || {}); res.status(r.ok ? 200 : 400).json(r);
});
pingRouter.delete('/targets/:id', adminOnly, async (req, res) => {
  if (scopedWriteDenied(req, { id: req.params.id, existing: true })) return scopeNotFound(res);
  const r = removeTarget(req.params.id);
  // v2.603(감사 DB2603-02 후속): 이력 삭제는 청크로 나눠 **백그라운드**에서 끝까지 돈다(대상 1년치 ≈ 52만 행을 응답 경로에서
  // 기다리지 않는다). 대상은 이미 목록에서 빠졌으므로 화면에 영향이 없고, 실패는 조용히 버리지 않고 콘솔에 남긴다.
  let historyPurge;
  if (r.ok) {
    try {
      const db = await getPingDb();
      historyPurge = 'background';
      // v2.604(감사 RECENT2604-02): 삭제 시각까지의 표본만 지운다 — 삭제가 도는 동안 같은 id 로 다시 만든 대상의 새 표본은 남는다.
      db.dropTarget(r.id, Date.now())
        .then((x) => { if (x?.deleted) console.log(`[ping] 대상 ${r.id} 이력 ${x.deleted}행 삭제(${x.chunks}청크)`); })
        .catch((e) => console.warn(`[ping] 대상 ${r.id} 이력 삭제 실패: ${e?.message || e}`));
    } catch (e) { historyPurge = 'failed'; console.warn(`[ping] 대상 ${r.id} 이력 삭제 실패: ${e?.message || e}`); }
  }
  res.status(r.ok ? 200 : 400).json(historyPurge ? { ...r, historyPurge } : r);
});

pingRouter.post('/poll-now', adminOnly, async (req, res) => {
  if (denyScopedBulk(req, res, '즉시 전체 측정')) return;
  try { const r = await pollOnce(); res.json({ ok: true, ...(r || {}) }); }
  catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});

pingRouter.post('/seed-vcenters', adminOnly, (req, res) => {
  if (denyScopedBulk(req, res, 'vCenter 자동 등록')) return;
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
export function canSeeEdgeAddress(req) {
  return req.user?.role === 'admin' && !scopedVcenterIds(req.user, store.get());
}
const isEdgeTarget = (id) => listTargets().some((t) => String(t.id) === String(id) && t.source === 'edge');

function redactEdgeAddresses(out, req) {
  // v2.598: 판정은 canSeeEdgeAddress 하나 — /series 와 갈라지지 않게.
  if (canSeeEdgeAddress(req)) return out;
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
  if (denyScopedBulk(req, res, 'vCenter 포트 지정')) return;
  const r = setVcPorts((req.body || {}).ports, vcenterList());
  res.status(r.ok ? 200 : 400).json(r);
});

pingRouter.post('/vcport/sync', adminOnly, (req, res) => {
  if (denyScopedBulk(req, res, 'vCenter 포트 대상 동기화')) return;
  const r = syncVcPortTargets(vcenterList());
  res.status(r.ok ? 200 : 400).json(r);
});
