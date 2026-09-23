/**
 * SAN 스위치 모니터링 라우트(v2.410) — 특수기능 'SAN 스위치 모니터링' 화면용.
 *
 * 접근 규약은 스토리지 모니터링과 동일하다:
 *  - 조회: 전체 범위 계정만. SAN 스위치는 vCenter 귀속이 없는 인프라 장비라 범위 계정에
 *    노출하지 않는다('vCenter 귀속 없는 데이터는 범위 계정에 노출 금지' — server/CLAUDE.md).
 *  - 변경(등록/수정/삭제/테스트/수집): adminOnly + 감사로그.
 */
import { scopeDbStatus } from '../../auth/scopeStatus.js';
import { requireRole, requirePerm } from '../../auth/auth.js';
import { store } from '../../store.js';
import { logAudit } from '../../audit.js';
import { SAN_SWITCH_TYPES, collectMethodsFor } from '../../sanswitch/types.js';
import { listDevices, saveDevice, deleteDevice, deviceInputIssue, getDeviceWithSecret, normalizeDeviceInput } from '../../sanswitch/registry.js';
import { localSnapshots, getSnapshot, dropSnapshot } from '../../sanswitch/store.js';
import { collectDeviceNow, sanSwitchPollerStatus, pollSanSwitchOnce, testDeviceConnection } from '../../sanswitch/poller.js';
import { startTestRun, getTestRun } from '../../sanswitch/testRuns.js';
import { edgeSanSwitchSnapshots, ORPHAN_TTL_MS } from '../../central/sanSwitchEdge.js';
import { listActivity as listSwActivity } from '../../sanswitch/activityLog.js';
// v2.511: 조닝 그림 — 순수 분석(스위치 왕복 없음).
import { zonesFromCompact, buildZoneGraph, buildZoneMatrix, zoneFindings, zoneSummary, portZoneDetail, classifyEndpoints } from '../../sanswitch/zoning.js';
import { listDatacenters } from '../../datacenter/store.js';
import { knownAgentNames } from '../../central/knownAgents.js';
import { requestCollect, hasPendingRequest, requestPerfCollect, hasPendingPerfRequest, recentCollectDrops } from '../../sanswitch/collectRequests.js';
import { loadPerfSettings, savePerfSettings, LIMITS as PERF_LIMITS } from '../../sanswitch/perfSettings.js';
import { pollPerfOnce, sanSwitchPerfStatus } from '../../sanswitch/perfPoller.js';
import { listActivity as listPerfActivity, latestEventByDevice as latestPerfEventByDevice } from '../../sanswitch/perfActivityLog.js';
import { perfEmptyDiag } from '../../sanswitch/perfDiag.js';
import { edgePerfStatusFor, listEdgePerfStatus } from '../../central/sanSwitchPerfEdge.js';
// 월간 점검(v2.519) — 판정은 순수 모듈, 기준선은 포탈 안에 저장(스위치 카운터는 건드리지 않는다).
import { checkDevice, checkPorts, summarizeAll, CHECK_ITEMS } from '../../sanswitch/healthCheck.js';
import { recordRun, listRuns, compareRuns, healthHistoryStatus, MAX_RUNS } from '../../sanswitch/healthHistory.js';
import { saveBaseline, getBaseline, clearBaseline, publicBaseline, listBaselines } from '../../sanswitch/errBaseline.js';
import { portSeries, storageSeries, storageSeriesMulti, arraySerialOf, endpointKind, perfDbStats, pruneNow, latestSampleTs, available as perfDbAvailable } from '../../sanswitch/perfDb.js';
import { listDevices as listStorageDevices } from '../../storage/registry.js';
import { localSnapshots as storageLocalSnaps } from '../../storage/store.js';
import { edgeStorageSnapshots } from '../../central/storageEdge.js';
import * as swBulk from '../../sanswitch/bulk.js';
import { enrichAdvice, selectRows } from '../../util/bulkImport.js';
import { startBulkTest, publicRun, passedLines } from '../../util/bulkRun.js';
import { fullScopeOnlyWith } from '../admin/shared.js';

const adminOnly = requireRole('admin');
const toolsPerm = requirePerm('tools'); // 조회 라우트에도 기능 권한(v2.416 감사 L-3 — 프론트 게이팅만으로는 API 직접 호출을 못 막는다)
// v2.583: 같은 6줄이 라우트 파일 8곳에 복사돼 있었다 — 공용 팩토리 하나로(사유 문구는 그대로).
const fullScopeOnly = fullScopeOnlyWith('SAN 스위치 모니터링은 전체 범위(vCenter 제한 없는) 계정만 조회할 수 있습니다.');

/** 목록 화면용 축약 — 포트 상세(수백 행)는 빼고 요약만 보낸다(목록 응답이 MB 가 되지 않게). */
const listShape = (s) => {
  if (!s) return null;
  const { list, ...ports } = s.ports || {};
  return { ...s, ports: { ...ports, listCount: (list || []).length } };
};

/** `?ports=1,2,3` 파싱(순수). 빈 값/빈 토큰은 무시 — `''.split(',')` → [''] → Number('') → 0 함정 방지. */
export const NONE_DC = '__none__';

/**
 * 조회 기간 파라미터(v2.420, 사용자 요구 '조회 조건에 내가 원하는 기간의 값을 볼 수 있는 기능').
 *  - `from`/`to`(epoch ms 또는 ISO/`datetime-local` 문자열) 가 있으면 그 구간(둘 중 하나만 있으면 나머지는
 *    to=지금 / from=to-24h). 최대 366일, from>=to 이면 400 대신 24h 로 되돌린다(화면이 잘못 보내도
 *    빈 화면이 되지 않게).
 *  - 없으면 `hours`(1~2160, 기본 24).
 */
export function rangeParams(q = {}) {
  const parse = (v) => {
    if (v == null || v === '') return null;
    const n = /^\d+$/.test(String(v)) ? Number(v) : Date.parse(String(v));
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const hours = Math.max(1, Math.min(24 * 90, Number(q.hours) || 24));
  let from = parse(q.from), to = parse(q.to);
  if (from == null && to == null) return { hours, from: null, to: null };
  if (to == null) to = Date.now();
  if (from == null) from = to - 24 * 3600_000;
  const MAX = 366 * 24 * 3600_000;
  if (from >= to || to - from > MAX) return { hours: 24, from: null, to: null, issue: from >= to ? '시작이 끝보다 늦습니다' : '최대 366일까지 조회할 수 있습니다' };
  return { hours: Math.max(1, Math.round((to - from) / 3600_000)), from, to };
}

export function parsePortsParam(v) {
  return String(v || '').split(',').map((x) => x.trim()).filter(Boolean).map(Number).filter(Number.isInteger).slice(0, 64);
}

export function registerSanSwitch(api) {

/**
 * 통합 조회 — 이 노드(중앙) 직접 수집분 + 전 엣지 push 분을 합쳐 장비별 최신 스냅샷 반환.
 * 같은 deviceId 가 양쪽에 있으면 최신 collectedAt 우선(스토리지 화면과 동일 규칙).
 */
api.get('/tools/sanswitch', toolsPerm, fullScopeOnly, (_req, res) => {
  const byId = new Map();
  for (const s of [...localSnapshots(), ...edgeSanSwitchSnapshots()]) {
    const cur = byId.get(s.deviceId);
    if (!cur || (s.collectedAt || 0) > (cur.collectedAt || 0)) byId.set(s.deviceId, s);
  }
  const devices = listDevices().map((d) => ({ ...d, snap: listShape(byId.get(d.id)), pending: hasPendingRequest(d.id) }));
  const known = new Set(devices.map((d) => d.id));
  // v2.583: 등록부에 없는 장비(orphan) 중 엣지 보고가 ORPHAN_TTL 을 넘긴 것은 목록에서 내리고 **개수를 밝힌다** —
  //   보고를 멈춘(철거된) 엣지의 스위치가 '고아' 로 무기한 남던 것(중앙 SAN 보관소에는 TTL 이 없다).
  const orphanAll = [...byId.values()].filter((s) => !known.has(s.deviceId));
  const orphans = orphanAll.filter((s) => !(s.staleMs > ORPHAN_TTL_MS)).map(listShape);
  const orphansExpired = orphanAll.length - orphans.length;
  res.json({
    devices, orphans, ...(orphansExpired ? { orphansExpired, orphanTtlMs: ORPHAN_TTL_MS } : {}),
    types: SAN_SWITCH_TYPES.map((t) => ({ ...t, methods: collectMethodsFor(t.type) })),
    datacenters: (() => { try { return listDatacenters(); } catch { return []; } })(),
    agents: knownAgentNames(),
    poller: sanSwitchPollerStatus(),
    // v2.591: 엣지가 가져갔지만 새 수집 결과가 오지 않아 재인출 뒤 폐기한 '지금 수집' 요청 — 화면이 말한다(조용한 소실 금지).
    collectDrops: recentCollectDrops(),
  });
});

/**
 * 포트 상세 — 목록 응답에서 뺀 포트 배열을 장비 단위로만 내려준다.
 * ⚠ 엣지 위임 장비는 **중앙에 문제 포트만** 올라와 있다(push.js 가 정상 포트를 뺀다 — 고RTT
 *   회선으로 매 주기 수백 행을 밀지 않기 위함). 그래서 응답에 portsOmitted 를 그대로 실어
 *   화면이 '정상 포트 N개는 엣지에만 있음'을 정직하게 안내하게 한다.
 */
api.get('/tools/sanswitch/devices/:id/ports', toolsPerm, fullScopeOnly, (req, res) => {
  const local = getSnapshot(req.params.id);
  const edge = edgeSanSwitchSnapshots().find((s) => s.deviceId === req.params.id);
  const snap = (!local || (edge && (edge.collectedAt || 0) > (local.collectedAt || 0))) ? edge : local;
  if (!snap) return res.status(404).json({ ok: false, reason: '수집된 스냅샷이 없습니다.' });
  // 장비 일반 정보(v2.411, 사용자 요구 '장비 일반 정보 표시')를 함께 내려준다 — 예전에는
  // 모델/FOS/수집시각만 보내서, 이미 수집해 둔 WWN·Domain·시리얼·팹·존·FRU 상태가
  // 화면에 전혀 쓰이지 않고 버려지고 있었다.
  res.json({
    ok: true, deviceId: snap.deviceId, name: snap.name, model: snap.model, fabricOs: snap.fabricOs,
    collectedAt: snap.collectedAt, source: snap === edge ? `엣지(${snap.agent || ''})` : '중앙 직접 수집',
    host: snap.host || '', agent: snap.agent || '',
    serial: snap.serial || '', wwn: snap.wwn || '', domainId: snap.domainId ?? null,
    switchState: snap.switchState || '', health: snap.health || null,
    fabric: snap.fabric || null, zoning: snap.zoning || null, licenses: snap.licenses || [],
    ports: snap.ports || { list: [] }, sections: snap.sections || {}, extra: snap.extra || {},
  });
});

/**
 * 조닝 그림 데이터(v2.511) — zone 멤버를 이니시에이터/타깃으로 갈라 그래프·매트릭스로.
 *
 * 무거운 일은 분석(2-색칠·매트릭스 조립)뿐이고 **vCenter/스위치 왕복이 없다**(수집 스냅샷만 읽는다).
 * 그래도 대형 패브릭은 zone 수천 개라 매 폴링으로 부르면 낭비다 — 화면은 탭을 열 때만 1회 부른다.
 * 포트/네임서버 정보를 함께 넘겨 라벨과 '로그인 여부' 판정을 정확히 한다.
 */
api.get('/tools/sanswitch/devices/:id/zoning', toolsPerm, fullScopeOnly, (req, res) => {
  const local = getSnapshot(req.params.id);
  const edge = edgeSanSwitchSnapshots().find((s) => s.deviceId === req.params.id);
  const snap = (!local || (edge && (edge.collectedAt || 0) > (local.collectedAt || 0))) ? edge : local;
  if (!snap) return res.status(404).json({ ok: false, reason: '수집된 스냅샷이 없습니다.' });
  const z = snap.zoning || null;
  const base = {
    ok: true, deviceId: snap.deviceId, name: snap.name, collectedAt: snap.collectedAt,
    source: snap === edge ? `엣지(${snap.agent || ''})` : '중앙 직접 수집',
    section: snap.sections?.zoning || 'skip',
    zoning: z ? { effectiveConfig: z.effectiveConfig || '', source: z.source || 'none', available: !!z.available,
      reason: z.reason || '', counts: z.counts || null, zoneCount: z.zoneCount || 0, truncated: !!z.truncated, limited: !!z.limited } : null,
  };
  if (!z?.available || !Array.isArray(z.zones) || !z.zones.length) {
    return res.json({ ...base, graph: { nodes: [], links: [], columns: { left: [], middle: [], right: [] }, zonesTotal: 0, unresolvedTotal: 0 }, matrix: { rows: [], cols: [], cells: [] }, findings: [], summary: null });
  }
  // 포트 정보로 라벨·로그인 여부를 채운다. 엣지 위임 장비는 문제 포트만 올라와 있어(push.js)
  // 대부분의 WWN 에 포트가 없다 — 그래서 **로그인 판정은 포트 목록이 온전할 때만** 한다
  // (일부만 보고 '로그인 안 함' 이라고 말하면 거짓이 된다).
  const list = snap.ports?.list || [];
  const portsComplete = !(snap.ports?.portsOmitted > 0) && !snap.ports?.truncated;
  const portByWwn = {}; const names = {}; const logged = new Set();
  for (const p of list) {
    for (const w of p.attached || []) {
      const k = String(w).toLowerCase();
      portByWwn[k] = p;
      if (p.attachedName) names[k] = p.attachedName;
      if (p.state === 'online') logged.add(k);
    }
  }
  // 네임서버 FC4 역할(v2.511) — 있으면 역할이 '확정' 이 된다. 수집기가 못 읽었으면 빈 객체라
  // 그림은 구조 추론으로 떨어진다(없는 근거를 지어내지 않는다 — 화면이 배지로 구분해 보여준다).
  const nsRoles = {};
  for (const [w, r] of Object.entries(snap.nsRoles || {})) nsRoles[String(w).toLowerCase()] = r;
  const zones = zonesFromCompact(z);
  const graph = buildZoneGraph(zones, { portByWwn, names, nsRoles });
  const matrix = buildZoneMatrix(graph);
  const findings = zoneFindings(zones, graph, portsComplete ? { loggedInWwns: logged } : {});
  res.json({
    ...base,
    graph, matrix, findings,
    summary: { ...zoneSummary({ defined: { zones: {}, aliases: z.aliases || {}, cfgs: {} }, effective: { zones: {} }, truncated: z.truncated },
      { cfgName: z.effectiveConfig, source: z.source, zones }, graph), ...z.counts },
    portsComplete,
    portsOmitted: snap.ports?.portsOmitted || 0,
  });
});

api.post('/tools/sanswitch/devices', adminOnly, (req, res) => {
  try {
    const saved = saveDevice(req.body || {});
    logAudit({ user: req.user?.username, action: 'SAN 스위치 등록/수정', target: `${saved.name}(${saved.host})`, detail: `${saved.type}/${saved.collectMethod}${saved.agent ? ` 엣지 ${saved.agent}` : ' 중앙 직접'}` });
    res.json({ ok: true, device: saved });
  } catch (e) { res.status(400).json({ ok: false, reason: e.message }); }
});

api.delete('/tools/sanswitch/devices/:id', adminOnly, (req, res) => {
  const dev = listDevices().find((d) => d.id === req.params.id);
  const ok = deleteDevice(req.params.id);
  if (ok) {
    dropSnapshot(req.params.id); // 등록을 지웠는데 스냅샷이 남아 orphan 으로 되살아나지 않게
    logAudit({ user: req.user?.username, action: 'SAN 스위치 삭제', target: `${dev?.name || ''}(${req.params.id})` });
  }
  res.json({ ok });
});

/**
 * 연결 테스트 — 등록 전/수정 중 값으로 실제 접속해 본다. 스냅샷은 저장하지 않는다.
 * 보안: adminOnly + deviceInputIssue(SSRF·형식) 선검증 + 감사로그. **host 를 바꿔 테스트할 때
 * 저장된 비밀번호를 이월하지 않는다**(uagmon M3 — host 바꿔치기로 자격증명이 공격자 서버로
 * 선제 전송되는 경로 차단). 비번을 새로 입력하지 않으면 같은 host 일 때만 저장분을 쓴다.
 */
api.post('/tools/sanswitch/test', adminOnly, async (req, res) => {
  const b = req.body || {};
  const issue = deviceInputIssue(b);
  if (issue) return res.status(400).json({ ok: false, reason: issue });
  let password = String(b.password ?? '');
  if (!password && b.id) {
    const saved = getDeviceWithSecret(b.id);
    if (saved && saved.host === String(b.host || '').trim()) password = saved.password || '';
  }
  // body 를 그대로 수집기에 넘기지 않는다 — vfId 는 CLI(`setcontext <vfId>;`)에 삽입되므로 저장 경로와
  // 같은 정규화(정수 1..128 / 포트 1..65535)를 거친다(v2.416 보안 감사 M-1).
  const device = { ...normalizeDeviceInput(b), id: b.id || `test-${Date.now()}`, password };
  const verbose = b.verbose === true || b.verbose === '1';
  logAudit({ user: req.user?.username, action: 'SAN 스위치 연결 테스트', target: `${b.name || ''}(${b.host})`, detail: `${b.type}/${b.collectMethod || ''} user=${device.username}${device.vfId ? ` vf=${device.vfId}` : ''}${device.agent ? ` 엣지=${device.agent}` : ''}${verbose ? ' 자세히(ssh -vvv)' : ''}` });
  // v2.421: 비동기 실행 — 즉시 runId 를 돌려주고 화면이 진행 로그를 폴링한다(엣지 위임 장비는 그 엣지가 실행).
  try {
    const r = startTestRun(device, { verbose, user: req.user?.username || '' });
    res.json({ ok: true, runId: r.id, target: r.target });
  } catch (e) { res.status(429).json({ ok: false, reason: e.message }); }
});

/** 연결 테스트 진행/결과 조회 — 추적 로그(단계별)·결과. 비밀번호는 없다. */
api.get('/tools/sanswitch/test/:runId', adminOnly, (req, res) => {
  const r = getTestRun(req.params.runId);
  if (!r) return res.status(404).json({ ok: false, reason: '테스트를 찾을 수 없습니다(만료 30분).' });
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, run: r });
});

/**
 * 지금 수집 — 중앙 직접 수집 장비는 즉시, 엣지 위임 장비는 **재수집 요청 등록**(중앙은 엣지에
 * 명령을 밀어넣을 수 없어, 엣지가 다음 config pull 때 가져가 즉시 수집·push 한다).
 */
api.post('/tools/sanswitch/devices/:id/collect', adminOnly, async (req, res) => {
  try {
    const dev = listDevices().find((d) => d.id === req.params.id);
    if (!dev) return res.status(404).json({ ok: false, reason: '스위치를 찾을 수 없습니다.' });
    if ((dev.agent || '').trim()) {
      const dup = hasPendingRequest(dev.id);
      requestCollect(dev.id, dev.agent);
      logAudit({ user: req.user?.username, action: 'SAN 스위치 재수집 요청(엣지)', target: `${dev.name}(${dev.id})`, detail: `엣지 ${dev.agent}` });
      return res.status(202).json({ ok: true, requested: true,
        reason: `${dup ? '이미 재수집 요청이 대기 중입니다' : '재수집 요청 등록'} — 엣지 '${dev.agent}' 의 다음 설정 pull 때 즉시 수집하고 바로 push 합니다.` });
    }
    // v2.591 L1: 이미 수집 중이면 새 세션을 열지 않는다 — '됐다' 고 말하지 않고 409 로 그 사실을 알린다.
    if (!(await collectDeviceNow(req.params.id))) return res.status(409).json({ ok: false, busy: true, reason: '이 장비는 지금 수집 중입니다 — 끝나면 결과가 표에 반영됩니다(같은 장비에 세션을 두 개 열지 않습니다).' });
    logAudit({ user: req.user?.username, action: 'SAN 스위치 즉시 수집', target: req.params.id });
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ ok: false, reason: e.message }); }
});

/* ── 포트 사용량(portperfshow) 수집·조회(v2.411, 사용자 요구) ──────────────────
 * '설정에서 주기적으로 portperfshow 를 수행해 포트 사용량을 수집하는 DB' + '차트로 보면서
 * 포트 사용량을 분석해 스토리지 사용량을 볼 수 있게'.
 */

/** 설정 조회 — 한계값·DB 현황·마지막 수집 결과를 함께(설정 화면이 서버를 단일 소스로 쓰게). */
api.get('/tools/sanswitch/perf/settings', adminOnly, async (_req, res) => {
  // ⚠ `status` 는 **이 노드(중앙 직접 수집)** 의 폴러 상태다 — 위임 장비는 여기 안 들어온다.
  //   v2.516 까지 화면이 이것을 '전체 상태' 처럼 보여줘서, 엣지가 꺼졌거나 실패해도 알 수 없었다.
  //   `edges` 가 엣지들이 보고한 상태이고, 화면은 둘을 **나눠서** 표시해야 한다(v2.517).
  res.json({ ok: true, settings: loadPerfSettings(), limits: PERF_LIMITS,
    status: sanSwitchPerfStatus(), edges: listEdgePerfStatus(), db: await perfDbStats() });
});

api.put('/tools/sanswitch/perf/settings', adminOnly, async (req, res) => {
  try {
    const before = loadPerfSettings();
    const saved = savePerfSettings(req.body || {});
    logAudit({ user: req.user?.username, action: 'SAN 포트 사용량 수집 설정 변경',
      target: saved.enabled ? '켜짐' : '꺼짐',
      detail: `주기 ${Math.round(saved.intervalMs / 1000)}초 · 표본 ${saved.sampleSeconds}초 · 보관 ${saved.retentionDays}일 (이전: ${before.enabled ? '켜짐' : '꺼짐'})` });
    res.json({ ok: true, settings: saved, limits: PERF_LIMITS, status: sanSwitchPerfStatus(), edges: listEdgePerfStatus(), db: await perfDbStats() });
  } catch (e) { res.status(400).json({ ok: false, reason: e.message }); }
});

/**
 * 보관 기간 밖 표본 즉시 정리(v2.420, 설정 화면 '지금 정리'). 폴러의 prune 스로틀(20틱)을 기다리지
 * 않고 현재 retentionDays 기준으로 DELETE 1회 — ts 단독 인덱스를 타므로 풀스캔이 아니다.
 */
api.post('/tools/sanswitch/perf/prune', adminOnly, async (req, res) => {
  try {
    const st = loadPerfSettings();
    const r = await pruneNow(st.retentionDays);
    logAudit({ user: req.user?.username, action: 'SAN 포트 사용량 DB 즉시 정리', detail: `보관 ${st.retentionDays}일 기준 ${r.deleted ?? 0}행 삭제` });
    res.json({ ok: true, ...r, db: await perfDbStats() });
  } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});

/**
 * 지금 1회 수집(설정이 꺼져 있어도 관리자가 눌러 시험할 수 있게 force).
 *
 * v2.517 — **무엇을 했는지 나눠 말한다**(v2.516 '전체 수집' 과 같은 규약). 예전에는 `pollPerfOnce`
 * 만 불렀고, 그 안의 `devicesForThisNode()` 는 중앙에서 **agent 없는 장비만** 돌려주므로
 * (`registry.js:135`) 엣지 위임 장비는 **아무 일도 일어나지 않았는데 화면은 그 사실을 말하지 않았다.**
 * 이제 위임 엣지마다 재수집 요청을 등록하고(one-shot·TTL 15분), 응답에 '즉시 N대 / 요청 M대' 를 싣는다.
 */
api.post('/tools/sanswitch/perf/collect', adminOnly, async (req, res) => {
  const devices = listDevices().filter((d) => d.enabled !== false);
  const centralIds = devices.filter((d) => !(d.agent || '').trim()).map((d) => d.id);
  const edgeDevices = devices.filter((d) => (d.agent || '').trim());
  // 엣지 단위로 요청(엣지의 pollPerfOnce 는 자기 몫 전체를 한 주기에 수집한다 — 장비별로 나눌 이유가 없다).
  const agents = [...new Set(edgeDevices.map((d) => String(d.agent).trim()))];
  const requested = []; const alreadyQueued = [];
  for (const a of agents) {
    const r = requestPerfCollect(a);
    (r.duplicate ? alreadyQueued : requested).push(a);
  }
  logAudit({ user: req.user?.username, action: 'SAN 포트 사용량 즉시 수집',
    detail: `중앙 직접 ${centralIds.length}대 · 엣지 요청 ${requested.length}곳${alreadyQueued.length ? ` (대기중 ${alreadyQueued.length}곳)` : ''}` });
  const result = await pollPerfOnce({ force: true });
  res.json({
    ok: true, result,
    central: centralIds.length, edgeDevices: edgeDevices.length,
    requested, alreadyQueued,
    // 엣지는 다음 설정 pull 때(≤5분) 가져가 즉시 수집·push 한다 — '지금 수집했다' 가 아니다.
    note: agents.length
      ? `중앙 직접 ${centralIds.length}대는 지금 수집했고, 엣지 ${agents.length}곳(${edgeDevices.length}대)에는 재수집 요청만 등록했습니다 — 중앙은 엣지에 명령을 밀어넣을 수 없어, 엣지가 다음 설정 pull 때 가져가 즉시 수집·push 합니다.`
      : `중앙 직접 ${centralIds.length}대를 수집했습니다(위임 장비 없음).`,
  });
});

/* ── 월간 점검(v2.519, 사용자 제공 Brocade 월간 점검 체크리스트) ────────────────────
 * "위 명령어를 조합해서 장비 점검하는 기능 / 장비별 점검 / 전체 SAN 스위치 점검 버튼 /
 *  이상 유무를 간단하게 보고 / 자세한 정보를 세부 보고서를 PDF 로"
 *
 * ⚠ 점검은 **저장된 스냅샷을 판정**한다 — 스위치에 새로 접속하지 않는다. 이유:
 *   ① 판정에 필요한 원천(switchshow·porterrshow·sfpshow·sensorshow·errdump 등)이 이미 정기
 *      수집에 들어 있다. ② 전체 점검 버튼이 28대에 동시 SSH 를 열면 그게 운영 사고다.
 *   최신 데이터로 점검하려면 `/collect`(또는 '전체 수집')을 먼저 눌러 수집한 뒤 점검한다 —
 *   응답의 `collectedAt` 이 '언제 수집한 데이터로 판정했는지' 를 밝힌다.
 */
function snapshotFor(id) {
  const local = getSnapshot(id);
  const edge = edgeSanSwitchSnapshots().find((s) => s.deviceId === id);
  return (!local || (edge && (edge.collectedAt || 0) > (local.collectedAt || 0))) ? edge : local;
}

/** 장비 1대 점검. 기준선이 있으면 '당월 신규 에러' 까지 판정한다. */
/** 불량 포트 상세의 상한 — 넘으면 개수를 밝힌다(조용한 상한 금지). */
const PROBLEM_PORT_MAX = Math.max(5, Number(process.env.SANSW_PROBLEM_PORT_MAX) || 40);

/**
 * 점검이 지목한 포트에 대해서만 조닝 상대를 붙인다(v2.521).
 * 조닝 스냅샷이 없으면 **'조닝 안 됨' 이라 말하지 않는다** — '조닝 정보를 수집하지 못했다' 다.
 */
function zoneDetailFor(snap, problemRows) {
  const z = snap?.zoning || null;
  const list = snap?.ports?.list || [];
  const byIndex = new Map(list.map((p) => [p.index, p]));
  const ports = problemRows.map((r) => byIndex.get(r.index)).filter(Boolean);
  if (!ports.length) return { rows: [], note: '' };
  if (!z?.available || !Array.isArray(z.zones) || !z.zones.length) {
    return {
      rows: ports.map((p) => ({ index: p.index, slotPort: p.slotPort ?? null, attachedName: p.attachedName || '', state: p.state, wwns: [], zones: [], zoneCount: 0, zonesOmitted: 0, partnerCount: 0 })),
      note: z?.reason
        ? `조닝 정보를 수집하지 못해 상대편을 표시할 수 없습니다: ${String(z.reason).slice(0, 200)}`
        : '조닝 정보가 이 스냅샷에 없어 상대편을 표시할 수 없습니다(조닝 수집이 꺼져 있거나 명령이 실패했습니다).',
    };
  }
  const zones = zonesFromCompact(z);
  const names = {}; const aliasOf = { ...(z.aliases || {}) };
  for (const p of list) for (const w of p.attached || []) { if (p.attachedName) names[String(w).toLowerCase()] = p.attachedName; }
  const roles = classifyEndpoints(zones, { names, aliasOf, nsRoles: {} });
  return { rows: portZoneDetail(zones, ports, { names, aliasOf, roles }), note: '' };
}

api.get('/tools/sanswitch/devices/:id/healthcheck', toolsPerm, fullScopeOnly, async (req, res) => {
  const dev = listDevices().find((d) => d.id === req.params.id);
  if (!dev) return res.status(404).json({ ok: false, reason: '스위치를 찾을 수 없습니다.' });
  const snap = snapshotFor(req.params.id);
  if (!snap) {
    return res.status(404).json({ ok: false, reason: '수집된 스냅샷이 없습니다 — 먼저 수집하세요.' });
  }
  const baseline = getBaseline(req.params.id);
  const result = checkDevice(snap, { baseline });
  // v2.521 — 사용자 요청 "모든 포트에 대해서 점검" + "불량인 포트는 어떤 서버인지, 어디와
  // 조닝되어 있는지". 전 포트 판정은 스냅샷만 보므로 싸지만, **조닝 분석은 O(zone×멤버²)** 라
  // 점검이 지목한 포트에만 돌린다(전 포트로 넓히지 말 것 — zoning.js portZoneDetail 머리말).
  const portCheck = checkPorts(snap, { baseline });
  const problem = portCheck.rows.filter((r) => r.verdict === 'bad' || r.verdict === 'warn').slice(0, PROBLEM_PORT_MAX);
  const zoned = zoneDetailFor(snap, problem);
  // v2.522 — 사용자 요청 "점검 결과를 DB 로 저장해서 최근 10번 점검과 비교".
  // ⚠ **같은 스냅샷(collectedAt)이면 기록하지 않는다** — 점검은 스냅샷 판정이라 탭을 열 때마다
  //   기록하면 '최근 10회' 가 같은 값 10개가 된다('수집 1회 = 기록 1회', healthHistory.js 머리말).
  const rec = await recordRun(result, { ports: portCheck });
  const hist = await listRuns(req.params.id, Number(req.query.history) || 10);
  res.json({
    ok: true, result, baseline: publicBaseline(baseline), items: CHECK_ITEMS,
    ports: portCheck,
    problemPorts: zoned.rows,
    zoningNote: zoned.note,
    problemPortsOmitted: Math.max(0, portCheck.rows.filter((r) => r.verdict === 'bad' || r.verdict === 'warn').length - problem.length),
    history: { ...hist, recorded: rec, compare: compareRuns(hist.runs), db: scopeDbStatus(await healthHistoryStatus(), req.user) },
  });
});

/**
 * 점검 이력 — 최근 N회(기본 10) + 비교(v2.522).
 * 기록은 점검 조회가 자동으로 한다('수집 1회 = 기록 1회') — 이 라우트는 조회만 한다.
 */
api.get('/tools/sanswitch/devices/:id/healthcheck/history', toolsPerm, fullScopeOnly, async (req, res) => {
  const dev = listDevices().find((d) => d.id === req.params.id);
  if (!dev) return res.status(404).json({ ok: false, reason: '스위치를 찾을 수 없습니다.' });
  const hist = await listRuns(req.params.id, Number(req.query.limit) || 10);
  res.json({ ok: true, deviceId: req.params.id, name: dev.name || dev.host, ...hist, maxRuns: MAX_RUNS, compare: compareRuns(hist.runs), db: scopeDbStatus(await healthHistoryStatus(), req.user) });
});

/**
 * 전체 점검 — 등록된 모든 스위치를 판정해 **요약 + 장비별 결과**를 준다.
 * 스냅샷이 없는 장비는 결과에서 빼지 않고 `missing` 으로 밝힌다(조용히 빠지면 '전부 점검했다' 는 거짓).
 */
api.get('/tools/sanswitch/healthcheck-all', toolsPerm, fullScopeOnly, async (req, res) => {
  const dcs = String(req.query.datacenterId || '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => (x === NONE_DC ? '' : x));
  const dcSet = dcs.length ? new Set(dcs) : null;
  const devices = listDevices().filter((d) => d.enabled !== false && (!dcSet || dcSet.has(String(d.datacenterId || ''))));
  const results = []; const missing = []; const recorded = [];
  for (const d of devices) {
    const snap = snapshotFor(d.id);
    if (!snap) { missing.push({ deviceId: d.id, name: d.name || d.host, agent: d.agent || '', datacenterId: d.datacenterId || '' }); continue; }
    const r = checkDevice(snap, { baseline: getBaseline(d.id) });
    if (r) {
      results.push({ ...r, datacenterId: d.datacenterId || '' });
      // 전체 점검도 기록한다(같은 수집 시각이면 healthHistory 가 스스로 건너뛴다).
      recorded.push(recordRun(r, { ports: checkPorts(snap, { baseline: getBaseline(d.id) }) }));
    }
  }
  const recStats = (await Promise.all(recorded)).reduce((a, x) => { if (x.saved) a.saved++; else a.skipped++; return a; }, { saved: 0, skipped: 0 });
  const dcNameOf = (() => {
    try { const m = new Map(listDatacenters().map((x) => [x.id, x.name || x.id])); return (id) => m.get(id) || id || '(법인 미지정)'; }
    catch { return (id) => id || '(법인 미지정)'; }
  })();
  res.json({
    ok: true, at: Date.now(),
    summary: { ...summarizeAll(results), missing: missing.length, registered: devices.length },
    results: results.map((r) => ({ ...r, datacenterName: dcNameOf(r.datacenterId) })),
    missing, items: CHECK_ITEMS, baselines: listBaselines(),
    // 이력 기록 결과 — '몇 건이 새로 기록되고 몇 건이 같은 스냅샷이어서 건너뛰었나'.
    recordedRuns: recStats, historyDb: scopeDbStatus(await healthHistoryStatus(), req.user),
  });
});

/**
 * 이번 달 기준선 저장 — 현재 스냅샷의 포트 에러 카운터를 포탈에 기억한다.
 * ⚠ 스위치의 `portstatsclear` 를 실행하지 않는다(다른 팀의 기준선을 지우는 파괴적 동작).
 */
api.post('/tools/sanswitch/devices/:id/err-baseline', adminOnly, (req, res) => {
  const dev = listDevices().find((d) => d.id === req.params.id);
  if (!dev) return res.status(404).json({ ok: false, reason: '스위치를 찾을 수 없습니다.' });
  const snap = snapshotFor(req.params.id);
  if (!snap) return res.status(404).json({ ok: false, reason: '수집된 스냅샷이 없습니다 — 먼저 수집하세요.' });
  if (snap.ok === false) return res.status(409).json({ ok: false, reason: '마지막 수집이 실패한 스냅샷입니다 — 기준선으로 쓰면 다음 점검이 틀립니다. 수집 성공 후 저장하세요.' });
  const saved = saveBaseline(req.params.id, snap);
  logAudit({ user: req.user?.username, action: 'SAN 스위치 에러 기준선 저장', target: `${dev.name}(${dev.id})`,
    detail: `포트 ${saved?.portCount ?? 0}개${saved?.portsComplete === false ? ' (중앙에 일부 포트만 있음)' : ''}` });
  res.json({ ok: true, baseline: saved });
});

api.delete('/tools/sanswitch/devices/:id/err-baseline', adminOnly, (req, res) => {
  const had = clearBaseline(req.params.id);
  logAudit({ user: req.user?.username, action: 'SAN 스위치 에러 기준선 삭제', target: req.params.id });
  res.json({ ok: true, removed: had });
});

/**
 * 포트 사용량 수집 작업 로그(v2.517). 응답 형태 `{poller, events}` 는 기본 수집
 * (`/tools/sanswitch/activity`)과 **똑같이** 유지할 것 — 웹의 공용 패널(`CollectActivity`)
 * 하나가 두 경로를 그린다. 키 이름을 바꾸면 한쪽이 조용히 빈다(v2.516 규약).
 */
api.get('/tools/sanswitch/perf/activity', toolsPerm, fullScopeOnly, (req, res) => {
  res.json({ poller: sanSwitchPerfStatus(), events: listPerfActivity(Number(req.query.limit) || 100) });
});

/**
 * 포트별 사용량 시계열. 원시 점을 그대로 주지 않고 버킷 평균으로 내려준다(브라우저 보호).
 * 단위는 **바이트/초**(portperfshow 원단위) — 화면이 ×8 해 bps 로 환산한다.
 */
/**
 * '표본이 왜 없나' 판정(v2.517, 사용자 신고 "데이터 수집이 안되, edge 의 사용량도 분석하게 해줘").
 *
 * 시계열이 **빈 경우에만** 만든다 — 판정 근거를 모으려면 `latestSampleTs`·작업 로그·엣지 상태를
 * 읽어야 하고, 데이터가 있는 정상 경로에 그 비용을 얹을 이유가 없다.
 * 판정 자체는 순수 모듈(`sanswitch/perfDiag.js`)이 하고, 문구는 웹(`sanPerfDiagText.js`)이 만든다.
 */
async function perfDiagFor(deviceId, r) {
  const dev = listDevices().find((d) => d.id === deviceId) || null;
  if (!dev) return null;
  const agent = String(dev.agent || '').trim();
  let lastSampleAt = null;
  try { lastSampleAt = (await latestSampleTs([deviceId])).get(String(deviceId)) || null; } catch { /* 판정 근거 없음 */ }
  let lastEvent = null;
  try { lastEvent = latestPerfEventByDevice().get(String(deviceId)) || null; } catch { /* 〃 */ }
  let edge = null;
  if (agent) { try { edge = edgePerfStatusFor(deviceId, agent); } catch { /* 〃 */ } }
  const d = perfEmptyDiag({
    device: { id: dev.id, name: dev.name, agent, collectMethod: dev.collectMethod || 'ssh' },
    settings: loadPerfSettings(),
    dbUnavailable: r?.unavailable === true || !(await perfDbAvailable()),
    lastSampleAt, since: r?.since ?? null,
    poller: sanSwitchPerfStatus(), lastEvent, edge,
  });
  // 엣지 위임 장비는 '지금 수집' 요청이 대기 중일 수 있다 — 화면이 연타를 막고 그 사실을 말한다.
  return { ...d, pendingRequest: agent ? hasPendingPerfRequest(agent) : false };
}

/** 시계열이 비었으면 진단을 붙인다(있으면 붙이지 않는다 — 위 머리말). */
async function withPerfDiag(deviceId, r) {
  const empty = !(r?.series || []).length;
  if (!empty) return r;
  return { ...r, diag: await perfDiagFor(deviceId, r) };
}

api.get('/tools/sanswitch/devices/:id/perf', toolsPerm, fullScopeOnly, async (req, res) => {
  const { hours, from, to, issue } = rangeParams(req.query);
  // ⚠ `''.split(',')` 은 [''] 이고 Number('') 은 0 이라, 빈 토큰을 먼저 걸러야 한다 — 안 거르면
  //   ports 미지정이 '포트 0 만' 으로 둔갑한다(v2.416 리뷰 확정 결함).
  const ports = parsePortsParam(req.query.ports);
  const r = await portSeries(req.params.id, { hours, from, to, ports: ports.length ? ports : null });
  res.json({ ok: true, unit: 'bytesPerSec', hours, from, to, rangeIssue: issue || null, ...(await withPerfDiag(req.params.id, r)) });
});

/** 연결 장비(스토리지 어레이)별 합산 시계열 — 포트가 아니라 '어느 스토리지가 얼마나 쓰이나'. */
api.get('/tools/sanswitch/devices/:id/perf/storage', toolsPerm, fullScopeOnly, async (req, res) => {
  const { hours, from, to, issue } = rangeParams(req.query);
  const r = await storageSeries(req.params.id, { hours, from, to });
  res.json({ ok: true, unit: 'bytesPerSec', hours, from, to, rangeIssue: issue || null, ...(await withPerfDiag(req.params.id, r)) });
});

/**
 * 법인(또는 전체) 단위 스토리지 사용량 통합 분석(v2.412, 사용자 요구
 * '법인을 선택하면 그 법인의 모든 스토리지 사용량을 분석').
 *
 * 스토리지 어레이는 이중화를 위해 팹 A/B 두 스위치에 나눠 물린다 — 스위치 한 대만 보면
 * 그 어레이 트래픽의 절반만 보인다. 여기서는 법인 안의 **모든 스위치를 합산**한다.
 *
 * 덤으로, 어레이 키에서 뽑은 시리얼이 등록된 스토리지 장비의 시리얼과 일치하면 그 장비의
 * **용량 사용률**을 함께 붙여 준다. 대역폭(얼마나 바쁜가)과 용량(얼마나 찼는가)은 다른 축이라
 * 나란히 봐야 증설 판단이 된다. ⚠ 확실히 일치할 때만 붙이고, 아니면 비운다(억지 매칭 금지).
 */
api.get('/tools/sanswitch/perf/storage-summary', toolsPerm, fullScopeOnly, async (req, res) => {
  const { hours, from, to, issue: rangeIssue } = rangeParams(req.query);
  // 법인은 **여러 개**를 받을 수 있다(쉼표 구분). 빈 값이면 전체.
  // '__none__' 은 법인 미지정 장비(datacenterId 빈 값)를 뜻하는 센티널(v2.417) — 쉼표 목록은 '' 를
  // 표현할 수 없어 예전에는 '(법인 미지정)' 을 고르면 전체로 둔갑했다(리뷰 확정).
  const dcs = String(req.query.datacenterId || '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => (x === NONE_DC ? '' : x));
  const dcSet = dcs.length ? new Set(dcs) : null;
  // split=1 이면 같은 어레이라도 법인마다 따로 집계한다(사용자 요구 — 복수 법인을 한꺼번에
  // 보면서도 법인 구분이 사라지지 않게). 기본은 법인이 2곳 이상일 때 자동 분리.
  const split = req.query.split == null ? dcs.length !== 1 : req.query.split === '1';
  const devices = listDevices().filter((d) => d.enabled !== false && (!dcSet || dcSet.has(String(d.datacenterId || ''))));
  const ids = devices.map((d) => d.id);
  // 엣지 위임 스위치(agent 지정)는 portperfshow 시계열이 **그 엣지 로컬 DB** 에만 있고 중앙으로 오지
  // 않는다(push 는 스냅샷만). 빈 시리즈가 '트래픽 없음' 처럼 보이지 않게 개수와 사유를 함께 준다.
  // v2.423: 엣지가 시계열을 중앙으로 중계하므로 '중앙에 없음'이 아니라 **마지막 반영 시각**을 보여준다. 아직 한 번도 오지 않은
  // 스위치만 안내(엣지가 v2.423 미만이거나 포트 사용량 수집이 꺼져 있거나 첫 push 대기).
  const edgeRaw = devices.filter((d) => String(d.agent || '').trim());
  const lastTs = await latestSampleTs(edgeRaw.map((d) => d.id));
  const edgeSwitches = edgeRaw.map((d) => ({ id: d.id, name: d.name || d.host, agent: d.agent, lastSampleAt: lastTs.get(String(d.id)) || null }));
  const edgeMissing = edgeSwitches.filter((e) => !e.lastSampleAt);
  const groupOf = split ? new Map(devices.map((d) => [String(d.id), String(d.datacenterId || '')])) : null;
  const agg = await storageSeriesMulti(ids, { hours, from, to, groupOf });

  // 등록 스토리지의 최신 스냅샷(용량) 색인 — 시리얼 정규화 후 대조.
  const norm = (v) => String(v ?? '').toLowerCase().replace(/[\s:_.-]/g, '');
  const stDevById = new Map(listStorageDevices().map((d) => [d.id, d]));
  // 법인별로 분리해 볼 때는 **그 법인의 스토리지 용량만** 붙여야 한다 — 그래서 키에 법인을 넣는다.
  const capBySerial = new Map();   // `${dc}\u0000${serial}` 또는 split 아니면 serial
  const capKey = (dcId, serial) => (split ? `${dcId}\u0000${serial}` : serial);
  for (const snap of [...storageLocalSnaps(), ...edgeStorageSnapshots()]) {
    if (!snap?.ok) continue;
    const d = stDevById.get(snap.deviceId) || {};
    if (dcSet && !dcSet.has(String(d.datacenterId || ''))) continue;  // 범위 밖 법인의 어레이는 붙이지 않는다
    const info = {
      deviceId: snap.deviceId, name: d.name || snap.name || '', type: d.type || '',
      totalBytes: snap.capacity?.totalBytes ?? null, usedBytes: snap.capacity?.usedBytes ?? null,
      pct: snap.capacity?.pct ?? null,
    };
    for (const key of [snap.serial, ...(snap.extra?.appliances || []).map((a) => a.serviceTag)]) {
      if (key) capBySerial.set(capKey(String(d.datacenterId || ''), norm(key)), info);
    }
  }

  const nameOf = new Map(devices.map((d) => [d.id, d.name || d.host || d.id]));
  const dcNameOf = (() => {
    try { const m = new Map(listDatacenters().map((x) => [x.id, x.name || x.id])); return (id) => m.get(id) || id || '(법인 미지정)'; }
    catch { return (id) => id || '(법인 미지정)'; }
  })();
  const series = agg.series.map((s) => {
    const serial = arraySerialOf(s.key);
    const capacity = serial ? (capBySerial.get(capKey(s.group ?? '', norm(serial))) || null) : null;
    return {
      ...s,
      datacenterId: s.group ?? null,
      datacenterName: s.group == null ? null : dcNameOf(s.group),
      arraySerial: serial,
      // 어레이/호스트 구분 — 법인 합산에서는 서버 HBA 가 수십 개씩 잡혀 표를 덮는다.
      // 화면 기본은 어레이만 보여주고 호스트는 따로 고를 수 있게 한다.
      endpointKind: endpointKind(s.key, { matched: !!capacity }),
      switches: s.deviceIds.map((id) => nameOf.get(id) || id),
      portCount: s.ports.length,
      capacity,
    };
  });
  const counts = series.reduce((a, s) => { a[s.endpointKind] = (a[s.endpointKind] || 0) + 1; return a; }, {});
  // 법인별 소계 — '어느 법인이 얼마나 쓰나'를 한눈에(스토리지만 합산, 호스트 제외).
  const byDc = {};
  for (const s of series) {
    if (s.endpointKind !== 'array') continue;
    const k = s.datacenterId ?? '';
    if (!byDc[k]) byDc[k] = { datacenterId: k, name: dcNameOf(k), storages: 0, avgTotal: 0, maxTotal: 0, peakAvg: 0, peakTotal: 0, switches: new Set() };
    byDc[k].storages++;
    byDc[k].avgTotal += s.avgTotal;
    byDc[k].maxTotal += s.maxTotal;
    byDc[k].peakAvg += s.peakAvg || 0;
    byDc[k].peakTotal += s.peakTotal || 0;
    for (const id of s.deviceIds) byDc[k].switches.add(id);
  }
  // 화면이 창을 닫지 않고 범위를 바꿀 수 있게, **필터와 무관한 전 법인 목록**을 함께 준다
  // (스위치가 등록된 법인만). 이게 없으면 사용자가 목록 화면으로 돌아가 칩을 다시 골라야 한다.
  const allDcs = (() => {
    const m = new Map();
    for (const d of listDevices().filter((x) => x.enabled !== false)) {
      const id = String(d.datacenterId || '');
      if (!m.has(id)) m.set(id, { id: id || NONE_DC, name: dcNameOf(id), switches: 0 }); // 미지정은 센티널 id 로 내려 화면이 고를 수 있게
      m.get(id).switches++;
    }
    return [...m.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  })();
  res.json({
    ok: true, unit: 'bytesPerSec', hours, from, to, until: agg.until ?? null, rangeIssue: rangeIssue || null, datacenterIds: dcs.map((x) => x || NONE_DC), split, allDatacenters: allDcs,
    // v2.517: 화면이 '수집을 켜세요' 를 **꺼져 있을 때만** 말하게 하려면 실제 설정을 알아야 한다.
    // 예전에는 무조건 그 문구여서, 이미 켜져 있고 장비에서 실패하는 상황에서도 설정을 의심하게 만들었다.
    perfEnabled: loadPerfSettings().enabled,
    edgeSwitches, edgeNote: edgeMissing.length
      ? `엣지(${[...new Set(edgeMissing.map((e) => e.agent))].join(', ')}) 수집 스위치 ${edgeMissing.length}대(${edgeMissing.map((e) => e.name).join(', ')})의 포트 사용량 시계열이 아직 중앙에 오지 않았습니다. 확인: ① 설정 › 수집 서버 › SAN 스위치 포트 사용량이 켜져 있는지(중앙 설정이 엣지에도 내려갑니다) ② 그 엣지가 v2.423 이상인지(엣지가 현지 수집분을 중앙으로 중계) ③ 켠 직후면 수집 주기(기본 5분) + 엣지 설정 pull(≤5분) 뒤 반영됩니다.`
      : '',
    byDatacenter: Object.values(byDc).map((x) => ({ ...x, switches: x.switches.size }))
      .sort((a, b) => b.avgTotal - a.avgTotal),
    switches: devices.map((d) => ({ id: d.id, name: d.name, host: d.host, datacenterId: d.datacenterId, datacenterName: dcNameOf(d.datacenterId) })),
    buckets: agg.buckets, bucketMs: agg.bucketMs, series, counts, unavailable: agg.unavailable || false,
  });
});

/**
 * 수집 작업 로그(v2.516, 사용자 요구 "스토리지 모니터링 처럼 화면 하단에 진행상태와 로그").
 * poller.inFlight = 지금 수집 중인 장비('진행중'), events = 최근 완료 이벤트('완료', newest-first).
 * 조회 전용이라 `toolsPerm + fullScopeOnly`(다른 SAN 조회와 동일 게이트 — SAN 은 vCenter 범위 밖).
 * ⚠ 스토리지의 `/tools/storage/activity` 와 **같은 응답 형태**를 유지할 것 — 웹이 공용 패널
 *   하나로 두 화면을 그린다(views/tools/CollectActivity.jsx). 키 이름을 바꾸면 한쪽이 빈다.
 */
api.get('/tools/sanswitch/activity', toolsPerm, fullScopeOnly, (req, res) => {
  res.json({ poller: sanSwitchPollerStatus(), events: listSwActivity(Number(req.query.limit) || 100) });
});

/**
 * 전체 수집(v2.516, 사용자 요구 "san switch 전체 수집 기능 버튼 추가").
 *
 * 중앙 직접 수집 장비는 **즉시** 수집하고, 엣지 위임 장비는 **재수집 요청을 큐에 등록**한다 —
 * 중앙은 엣지에 명령을 밀어넣을 수 없고, 엣지가 다음 설정 pull 때 가져가 즉시 수집·push 한다
 * (단건 `/devices/:id/collect` 와 같은 규약). 이미 대기 중인 요청은 `hasPendingRequest` 가
 * 중복 등록을 막는다(연타가 엣지 작업을 곱하지 않게).
 *
 * ⚠ 스토리지의 `/tools/storage/collect-all` 은 **엣지 요청을 등록하지 않고** '다음 주기' 안내만
 *   한다(v2.315 당시 설계). 여기서 등록하는 것이 사용자가 기대하는 '전체 수집' 이라 그렇게 했고,
 *   **응답에 실제로 무엇을 했는지 나눠 싣는다**(즉시 N대 / 요청 M대) — 뭉치면 '전부 지금 수집했다'
 *   는 거짓이 된다. 스토리지도 같은 동작으로 맞추려면 별건으로 다룰 것.
 *
 * 재진입: `pollSanSwitchOnce` 가 진행 중이면 `{ok:false, reason}` 을 돌려주고 그 사실을 그대로
 * 전달한다(폴러와 가드를 공유 — 중복 수집 금지 규약).
 */
api.post('/tools/sanswitch/collect-all', adminOnly, async (req, res) => {
  try {
    const all = listDevices().filter((d) => d.enabled !== false);
    const edgeDevs = all.filter((d) => String(d.agent || '').trim());
    const central = all.length - edgeDevs.length;
    // 엣지 요청 먼저 등록 — 중앙 수집(수십 초)이 끝나기를 기다리지 않게.
    let requested = 0; let alreadyQueued = 0;
    for (const d of edgeDevs) {
      if (hasPendingRequest(d.id)) { alreadyQueued++; continue; }
      try { requestCollect(d.id, d.agent); requested++; } catch { /* 한 대 실패가 전체를 막지 않게 */ }
    }
    const result = await pollSanSwitchOnce({ manual: true });   // { ok, collected, failed, ... } 또는 { ok:false, reason }
    logAudit({ user: req.user?.username, action: 'SAN 스위치 전체 수집',
      detail: `중앙 ${central}대 즉시(${result.ok === false ? result.reason : `성공 ${result.collected ?? 0}·실패 ${result.failed ?? 0}`})`
        + ` · 엣지 ${edgeDevs.length}대 중 요청 ${requested}(대기중 ${alreadyQueued})` });
    res.json({ ok: true, central, edge: edgeDevs.length, requested, alreadyQueued, result });
  } catch (e) { res.status(502).json({ ok: false, reason: e.message }); }
});

/** 이 노드 몫 전체 재수집(관리자 수동 실행 — 폴러와 재진입 가드를 공유한다). */
api.post('/tools/sanswitch/poll', adminOnly, async (req, res) => {
  logAudit({ user: req.user?.username, action: 'SAN 스위치 전체 수집 실행' });
  res.json(await pollSanSwitchOnce({ manual: true })); // v2.590: 수동 실행은 인증 실패 정지 장비도 1회 시도한다
});


/* ══════════════════ 대량 등록(CSV·자유텍스트, v2.513) ══════════════════
 * 사용자 요청(2026-09-15): "san switch 도 같은 메뉴" — CSV·자유텍스트 import/export,
 * 샘플 다운로드, 형식 검증, **실제 연결 테스트**, **통과분만 선택 등록**, **수정 조언**.
 *
 * 흐름(화면과 1:1):
 *   ① POST import {dryRun:true}          형식 검증 + 행별 add/update/error + 조언
 *   ② POST import/test                   실제 로그인 시도(비동기 run) → GET 으로 진행률 폴
 *   ③ POST import {selectLines, testRunId}  고른 행만 저장(연결 통과 교집합)
 *
 * 보안: 전부 adminOnly + fullScopeOnly(기존 SAN 라우트 규약). 내보내기에 비밀번호 없음.
 * 감사로그는 ②③ 에 남긴다(①은 저장하지 않으므로 남기지 않는다 — 로그 오염 방지).
 */

/** datacenter 이름/ID → ID 해석기(스토리지 가져오기와 같은 규칙). */
function swDcResolver() {
  let dcs = [];
  try { dcs = listDatacenters(); } catch { /* 목록 실패 시 원문 유지 */ }
  return (v) => {
    const s = String(v || '').trim();
    if (!s) return '';
    if (dcs.some((d) => d.id === s)) return s;
    const byName = dcs.find((d) => String(d.name || '').toLowerCase() === s.toLowerCase());
    return byName ? byName.id : s;      // 못 찾으면 원문 유지(유효 ID 일 수 있음)
  };
}

const swDcName = () => {
  try { const m = new Map(listDatacenters().map((x) => [x.id, x.name || x.id])); return (id) => m.get(id) || id || ''; }
  catch { return (id) => id || ''; }
};

/** 입력 본문 → 파싱 결과 + 형식 구분. `text` 가 있으면 자유텍스트, 아니면 CSV. */
function swParseBody(body = {}) {
  const raw = String(body.text ?? body.csv ?? '');
  const format = body.format === 'text' || (body.text != null && body.csv == null) ? 'text' : 'csv';
  if (format === 'text') {
    const r = swBulk.parseDevicesText(raw, { defaults: body.defaults || {} });
    return { ...r, format, raw };
  }
  const r = swBulk.parseDevicesCsv(raw);
  return { ...r, warnings: [], headerUsed: null, order: r.order || swBulk.COLUMNS, format, raw };
}

api.get('/tools/sanswitch/devices/export.csv', adminOnly, fullScopeOnly, (req, res) => {
  const devices = listDevices();
  logAudit({ user: req.user?.username, action: 'SAN 스위치 CSV 내보내기', detail: `${devices.length}대` });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="san-switches.csv"');
  res.send(swBulk.devicesToCsv(devices, swDcName()));
});

api.get('/tools/sanswitch/devices/export.txt', adminOnly, fullScopeOnly, (req, res) => {
  const devices = listDevices();
  logAudit({ user: req.user?.username, action: 'SAN 스위치 자유텍스트 내보내기', detail: `${devices.length}대` });
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="san-switches.txt"');
  res.send(swBulk.devicesToText(devices, swDcName()));
});

api.get('/tools/sanswitch/devices/sample.csv', adminOnly, fullScopeOnly, (_req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="san-switches-sample.csv"');
  res.send(swBulk.sampleCsv());
});

api.get('/tools/sanswitch/devices/sample.txt', adminOnly, fullScopeOnly, (_req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="san-switches-sample.txt"');
  res.send(swBulk.sampleText());
});

/**
 * ② 실제 연결 테스트 — 저장 **전에** 행마다 로그인을 시도한다.
 *
 * ⚠ 엣지 위임 장비(`agent` 지정)는 중앙에서 직접 닿을 수 없다. '실패' 가 아니라
 *   **'테스트 불가'**(skipped) 로 구분한다 — 닿지 못한 것을 실패라 하면 사용자가 멀쩡한
 *   자격증명을 의심하며 고친다(정직 규약).
 * ⚠ 자동 재시도 없음(잘못된 비밀번호 반복 = 계정 잠금). bulkRun 이 강제한다.
 */
api.post('/tools/sanswitch/devices/import/test', adminOnly, fullScopeOnly, (req, res) => {
  const p = swParseBody(req.body || {});
  if (p.error) return res.status(400).json({ ok: false, reason: p.error });
  const resolveDc = swDcResolver();
  const existing = new Map(listDevices().map((d) => [String(d.host).toLowerCase(), d]));

  // 형식 오류 행은 테스트하지 않는다(로그인 시도가 무의미하고 장비에 부하만 준다).
  const { report } = swBulk.analyzeImport(p.rows, {
    existingHost: (h) => existing.get(String(h).toLowerCase()),
    resolveDc, validate: deviceInputIssue,
  });
  const okLines = new Set(report.filter((r) => r.action !== 'error').map((r) => r.line));
  const targets = p.rows.filter((r) => okLines.has(r._line));
  if (!targets.length) return res.status(400).json({ ok: false, reason: '형식 검증을 통과한 행이 없습니다 — 먼저 오류를 고치세요.' });

  const started = startBulkTest({
    kind: 'sanswitch', rows: targets, user: req.user?.username || '',
    skipReason: (row) => (String(row.agent || '').trim()
      ? `엣지 위임 장비(${row.agent}) — 중앙에서 직접 접속할 수 없어 테스트하지 않았습니다. 등록 후 엣지에서 수집됩니다.`
      : null),
    testOne: async (row, signal) => {
      const input = swBulk.toSaveInput(row, resolveDc);
      // 비밀번호가 비어 있으면(기존 유지) 저장된 값으로 테스트한다 — 그게 실제 수집이 쓸 값이다.
      if (!row._hasPassword) {
        const saved = existing.get(String(row.host).toLowerCase());
        const full = saved ? getDeviceWithSecret(saved.id) : null;
        if (!full?.password) return { ok: false, reason: '비밀번호가 없습니다 — 신규 등록이면 마지막 열에 비밀번호를 적으세요.' };
        input.password = full.password;
      }
      try {
        const r = await testDeviceConnection(normalizeDeviceInput(input), { timeoutMs: 60_000, signal, ranOn: '중앙' });
        return r?.ok
          ? { ok: true, detail: { summary: r.summary || r.model || '로그인 성공' } }
          : { ok: false, reason: r?.error || r?.reason || '로그인 실패', detail: { phase: r?.phase, hint: r?.hint } };
      } catch (e) { return { ok: false, reason: e?.message || String(e) }; }
    },
  });
  if (!started.ok) return res.status(409).json(started);
  logAudit({ user: req.user?.username, action: 'SAN 스위치 대량 연결 테스트', detail: `${targets.length}대 시도(형식 오류 ${p.rows.length - targets.length}건 제외)` });
  res.json({ ok: true, id: started.id, total: targets.length });
});

/** 연결 테스트 진행률·결과(폴링). 자격증명은 응답에 없다(bulkRun publicRun). */
api.get('/tools/sanswitch/devices/import/test/:id', adminOnly, fullScopeOnly, (req, res) => {
  const run = publicRun(req.params.id);
  if (!run || run.kind !== 'sanswitch') return res.status(404).json({ ok: false, reason: '실행을 찾을 수 없습니다(15분 지나 폐기되었을 수 있습니다).' });
  res.json({ ok: true, ...run });
});

/**
 * ①/③ 가져오기 — `dryRun:true` 면 검증만, 아니면 저장.
 *  · `selectLines`  사용자가 고른 줄 번호(없으면 오류 아닌 전부)
 *  · `testRunId`    연결 테스트 실행 id — 주면 **통과한 줄과의 교집합**만 저장
 * 걸러낸 행은 버리지 않고 `skipped` 로 사유와 함께 돌려준다.
 */
api.post('/tools/sanswitch/devices/import', adminOnly, fullScopeOnly, (req, res) => {
  const p = swParseBody(req.body || {});
  if (p.error) return res.status(400).json({ ok: false, reason: p.error });

  const resolveDc = swDcResolver();
  const existing = new Map(listDevices().map((d) => [String(d.host).toLowerCase(), d]));
  const base = swBulk.analyzeImport(p.rows, {
    existingHost: (h) => existing.get(String(h).toLowerCase()),
    resolveDc, validate: deviceInputIssue,
  });
  // 오류 행에 '어디를 어떻게 고쳐라' 를 붙인다(사용자 요청).
  const { report, hints } = enrichAdvice(base.report, p.rows, {
    text: p.raw, order: p.order, format: p.format,
    fields: swBulk.COLUMNS,
    ctx: {
      types: SAN_SWITCH_TYPES.filter((t) => t.implemented).map((t) => t.type),
      agents: knownAgentNames(),
      datacenters: (() => { try { return listDatacenters().map((d) => d.name || d.id); } catch { return []; } })(),
    },
  });

  if (req.body?.dryRun) {
    return res.json({ ok: true, dryRun: true, report, summary: base.summary, hints,
      warnings: p.warnings, headerUsed: p.headerUsed, format: p.format, total: p.rows.length });
  }

  const tested = req.body?.testRunId ? passedLines(req.body.testRunId) : null;
  if (req.body?.testRunId && tested == null) {
    return res.status(400).json({ ok: false, reason: '연결 테스트 결과를 찾을 수 없습니다(15분 지나 폐기되었을 수 있습니다) — 다시 테스트하세요.' });
  }
  const { picked, skipped } = selectRows(p.rows, report, {
    lines: Array.isArray(req.body?.selectLines) ? req.body.selectLines : null,
    requireTested: tested,
  });

  let added = 0; let updated = 0; const failed = [];
  for (const row of picked) {
    const prev = existing.get(String(row.host).toLowerCase());
    const input = swBulk.toSaveInput(row, resolveDc);
    if (prev) input.id = prev.id;
    if (!row._hasPassword) delete input.password;     // 비우면 기존 유지(saveDevice 규칙)
    try { saveDevice(input); if (prev) updated++; else added++; }
    catch (e) { failed.push({ line: row._line, name: row.name || row.host, reason: e.message }); }
  }
  logAudit({ user: req.user?.username, action: `SAN 스위치 대량 가져오기(${p.format === 'text' ? '자유텍스트' : 'CSV'})`,
    detail: `추가 ${added}·수정 ${updated}·실패 ${failed.length}·제외 ${skipped.length}${tested ? ' (연결 통과분만)' : ''}` });
  res.json({ ok: true, added, updated, failed, skipped, total: p.rows.length, format: p.format });
});

}
