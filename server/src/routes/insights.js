/**
 * 인사이트 API — FinOps(전력·비용), AI 이상탐지, 용량 예측, 보안 자세(CVE/EOL),
 * 토폴로지, 인시던트 타임라인, ChatOps. /api 하위(로그인 필요)에 마운트. 설정 변경은 admin.
 */

import crypto from 'node:crypto';
import { pageArgs } from '../util/pageArgs.js';
import { Router } from 'express';
import { requireRole, requirePerm } from '../auth/auth.js';
import { store, usageReadable } from '../store.js';
import { scopedVcenterIds } from '../auth/scope.js';
import { userHasPermission } from '../auth/permissions.js';
// scope 강제 헬퍼(v2.288, 확정 버그 재발 방지): 조회 라우트는 사용자 scope 로 좁힌 스냅샷을 빌더에
// 넘기고, 캐시 키에 scope 서명을 섞어 스코프가 다른 계정이 같은 캐시를 공유하지 못하게 한다.
// (routes/api/reports.js 와 동일 패턴 — 그쪽은 memoJson, 여기선 snapMemo 캐시.)
import { scopeSlice, scopeKey } from './api/shared.js';
import { allMeasuredPower, vcPowerSkippedOf } from '../idrac/service.js';
import { unreadVcenterReasons } from '../metrics/unreadVcenters.js'; // v2.733(C2-02): 지표 샘플러와 같은 판정
import { filterMeasuredByMapping, loadPowerSettings } from '../idrac/powerSettings.js';
import { keepMappedMeasured } from '../idrac/attribution.js';
import { snapMemo, sendCached } from '../util/snapCache.js';
import { computeFinOps, loadFinopsConfig, saveFinopsConfig } from '../insights/finops.js';
import { computePowerBreakdown } from '../insights/powerBreakdown.js';
import { getDatacenterAssign, listDatacenters, datacenterOfVcenter } from '../datacenter/store.js';
import { getFleetInventory, fleetGhostReport } from '../insights/fleetInventory.js'; // v2.783(점검 Q2 P-B3): prune 은 화면과 같은 유령 판정
import { setFleetTag, pruneFleetTags, loadFleetTags, applyFleetExclude } from '../insights/fleetTags.js';
import { setFleetAssign, setFleetAssignMany, applyFleetAssign, pruneFleetAssign, loadFleetAssign } from '../insights/fleetAssign.js';
import { fleetRev } from '../insights/fleetRev.js';
import { fleetPartialsSummary } from '../central/fleet.js'; // v2.607 LEFT2607-02
import { loadRegistry, updateServer, assignVcenter } from '../idrac/registry.js';
import { logAudit } from '../audit.js';
import { detectAnomalies, anomalyCfgArgs } from '../insights/anomaly.js';
import { forecastCapacity, forecastCfgArgs } from '../insights/forecast.js';
import { computeSecurityPosture } from '../insights/cve.js';
import { buildTopology } from '../insights/topology.js';
import { buildGraph } from '../insights/graph.js';
import { getIncidents } from '../insights/incidents.js';
import { chatOps } from '../llm/chatops.js';
import { isAdminReq, addressMatcher, maskedIdToken, maskedAddressName } from '../auth/addressMask.js';
import { isDemoGuest } from '../auth/demoGuest.js';
import { acquireExport } from '../util/exportBusy.js';
import { fileStamp, localStamp } from '../util/dayKey.js';
import { getInventory } from '../idrac/invCache.js';
import { allRemoteServers } from '../collector/remoteInventory.js';
import { catalogForClient, resolveFields, BASIC_KEYS } from '../insights/hwExport/catalog.js';
import { makeInvOf, selectServers, buildHwModel, KINDS, UNASSIGNED } from '../insights/hwExport/rows.js';
import { buildDcIndex, makeCorpOf, VC_PREFIX } from '../insights/hwExport/corp.js';
import { analysisServersWithRemote, collectorToDatacenterMap, collectorDcMaps } from '../insights/analysisServers.js';
import { loadCollectors } from '../collector/registry.js';
import { renderHwExport, SPEC_MAX } from '../insights/hwExport/render.js';
import { getPrefs as getHwPrefs, setPref as setHwPref, FMTS as HW_FMTS, BANDS as HW_BANDS } from '../insights/hwExport/prefs.js';

import { wrapAsyncRouter } from '../util/asyncRoute.js';
import { fullScopeOnlyWith } from './admin/shared.js';
export const insightsRouter = Router();
// v2.574 BUG-03: express 4 는 async 핸들러의 throw 를 잡지 않아 그 요청이 **응답 없이
// 매달린다**(소켓 fd 가 잡힌다). 라우트를 등록하기 **전에** 감싸 전역 에러 핸들러로 보낸다.
// ⚠ 라우트 등록보다 아래로 옮기지 말 것 — 그 뒤에 등록된 것만 보호된다.
wrapAsyncRouter(insightsRouter);
const adminOnly = requireRole('admin');
// v2.606 AUTHZ2606-01: 통합 서버 인벤토리 **변경**도 GET(/fleet)과 같은 근거로 전체 범위 계정만 —
//   베어메탈은 귀속 전에는 법인 축이 없어 범위로 나눌 수 없고, 범위 admin 이 다른 법인 서버를 자기
//   vCenter 로 귀속시키면 bm-usage·전력·개요의 범위 필터가 그 서버를 범위 안으로 본다(쓰기로 읽기 범위가 넓어진다).
//   PUT /fleet/tag 응답은 전 함대 태그 맵이다(같은 계정의 GET /fleet 은 403).
const fleetFullScopeOnly = fullScopeOnlyWith('통합 서버 인벤토리 변경은 전체 범위(vCenter 제한 없는) 계정만 할 수 있습니다 — 베어메탈은 귀속 전에는 법인 축이 없어 범위로 나눌 수 없습니다.');

/*
 * v2.601 AUTHZ-2601-03 — 비-admin 가림. v2.600 이 `/idrac/host-power` 에 건 주소 가림(maskHostPower)의 형제다:
 * IP 로 등록한 iDRAC 은 서버 이름이 곧 IP 라 `/finops` topHosts·`/power-breakdown` servers·`/fleet` 행으로
 * 그 IP 가 viewer 에게 그대로 나갔다. ⚠ **ESXi 호스트 이름은 가리지 않는다** — 인벤토리(inv.hosts)로 이미
 * 보이는 이름이라 가려도 막는 것이 없고, 가리면 두 화면의 같은 호스트가 서로 다른 이름이 된다.
 * 캐시(snapMemo)는 가리기 전 값을 공유하고 가림은 응답 직전에 새 객체로 한다(캐시 원본을 바꾸지 않는다).
 */
function insightsMatcher(snap) {
  const esxi = new Set((snap?.hosts || []).map((h) => String(h?.name || '').toLowerCase()).filter(Boolean));
  let hosts = [];
  try { hosts = loadRegistry().map((r) => r?.host).filter((h) => typeof h === 'string' && h); } catch { hosts = []; }
  const isAddr = addressMatcher(hosts);
  return (v) => isAddr(v) && !esxi.has(String(v).trim().toLowerCase());
}
export function maskFinopsPayload(p, match) {
  if (!p || typeof p !== 'object' || !Array.isArray(p.topHosts)) return p;
  return { ...p, addressHidden: true, topHosts: p.topHosts.map((h) => (h && match(h.host) ? { ...h, host: maskedAddressName(h.host) } : h)) };
}
export function maskPowerBreakdownPayload(p, match) {
  if (!p || typeof p !== 'object' || !Array.isArray(p.servers)) return p;
  return { ...p, addressHidden: true, servers: p.servers.map((x) => (x && match(x.name) ? { ...x, name: maskedAddressName(x.name) } : x)) };
}
export function maskFleetPayload(p, match) {
  if (!p || typeof p !== 'object') return p;
  const row = (r) => {
    if (!r || typeof r !== 'object') return r;
    const o = { ...r };
    for (const f of ['serverId', 'fleetId', 'tagKey', 'idracServerId', 'untaggedServerId']) if (match(o[f])) o[f] = maskedIdToken(o[f]);
    if (match(o.name)) o.name = maskedAddressName(o.name);
    return o;
  };
  return {
    ...p, addressHidden: true,
    bareMetal: Array.isArray(p.bareMetal) ? p.bareMetal.map(row) : p.bareMetal,
    virtualizationHosts: Array.isArray(p.virtualizationHosts) ? p.virtualizationHosts.map(row) : p.virtualizationHosts,
  };
}

/**
 * v2.733(점검 3회차 C2-02): vCenter 추정 전력의 판정 입력 — 스냅샷(범위 조각)의 vCenter 상태(metrics/unreadVcenters.js — 지표 샘플러와
 *   같은 판정)와 호스트 연결 상태(store.usageReadable). allMeasuredPower 가 그 호스트의 vCenter 추정 전력을 넣지 않는다.
 */
function vcPowerSkipOf(slice) {
  return { unread: unreadVcenterReasons(slice), hostReadable: usageReadable };
}
/** 응답에 싣는 '뺀 것' 요약 — vCenter 추정 전력을 끈 설정이면 null(뺀 것이 아니라 쓰지 않는다). */
function vcPowerSkippedReport(slice, vcSkip) {
  return loadPowerSettings().includeVcenterPower === false ? null : vcPowerSkippedOf(slice.hosts, vcSkip);
}

// --- FinOps: 전력 → kWh·비용·CO2 ---
insightsRouter.get('/finops', async (req, res) => {
  try {
    const snap = store.get();
    const scoped = scopeSlice(snap, req.user, req.query.vcenterId); // 범위 제한 계정은 자기 vCenter 만
    // ⚠ scope 강제(확정 버그 수정): allMeasuredPower 는 hosts 인자와 무관하게 전 등록 서버를
    // 반환하므로, 범위 제한 계정에는 '귀속되지 않는 서버'를 반드시 잘라내야 한다(안 하면 범위 밖
    // 서버가 '(미매핑)' 으로 강등된 채 총량·topHosts 에 그대로 실려 전 함대가 노출됐다).
    const scopeLimited = scopedVcenterIds(req.user, snap) != null;
    // v2.583(감사 확정): ?vcenterId= 가 키에 없어 다른 vCenter(또는 전체)의 결과가 60초 동안 그대로 나갔다(형제 /power-breakdown 은 넣는다).
    const key = `${snap.generatedAt}|${JSON.stringify(loadPowerSettings())}|${JSON.stringify(loadFinopsConfig())}|${fleetRev()}|${scopeKey(req.user, snap)}|vc:${String(req.query.vcenterId || '')}`;
    const validIds = new Set((scoped.vcenters || []).map((v) => v.id));
    const payload = await snapMemo('finops', key, 60_000, async () => {
      // v2.733(C2-02): 읽지 못한 vCenter·끊긴 호스트의 vCenter 추정 전력은 '지금 값' 이 아니다 — 합산에서 빼고 개수로 밝힌다.
      const vcSkip = vcPowerSkipOf(scoped);
      let measured = filterMeasuredByMapping(applyFleetExclude(applyFleetAssign(await allMeasuredPower({ hosts: scoped.hosts, vcenterFirst: true, ...vcSkip }), validIds)), scoped);
      // v2.785(GV P-B4): vCenter 를 고르면(전체 범위 계정 포함) 그 vCenter 에 귀속된 서버만 — 예전에는 범위 계정만 걸러, 전체 범위 계정의
      //   ?vcenterId=X 가 다른 vCenter 서버 전력을 '(미매핑)' 으로 더한 전 함대 값이 됐다(형제 /power-breakdown 은 vcFilter 로 뺀다).
      if (scopeLimited || String(req.query.vcenterId || '')) measured = keepMappedMeasured(measured, scoped);
      return { ...computeFinOps(scoped, measured), vcPowerSkipped: vcPowerSkippedReport(scoped, vcSkip) };
    });
    if (isAdminReq(req)) sendCached(req, res, key, payload);
    else sendCached(req, res, `${key}|masked`, maskFinopsPayload(payload, insightsMatcher(snap)));
  } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});
insightsRouter.get('/finops/config', (_req, res) => res.json(loadFinopsConfig()));

// --- 전력 분석: 법인(vCenter)·모델·지역별 소비전력 분해 ---
insightsRouter.get('/power-breakdown', async (req, res) => {
  try {
    const snap = store.get();
    const vc = String(req.query.vcenterId || '');
    const assign = getDatacenterAssign();
    const datacenters = listDatacenters();
    // DataCenter 할당/목록이 바뀌면 캐시 무효화되도록 키에 포함.
    const dcKey = `${JSON.stringify(assign)}|${datacenters.map((d) => `${d.id}:${d.name}`).join(',')}|${collectorDcSig()}`;   // v2.972: 수집 서버 ↔ 법인 매칭이 바뀌면 키도
    const scoped = scopeSlice(snap, req.user, vc); // 범위 제한 계정은 자기 vCenter 전력만
    // ⚠ scope 강제(확정 버그 수정) — /finops 와 같은 이유. 이 라우트는 servers[] 로 서버 이름·
    // 서비스태그·모델·와트를 그대로 내려주므로 누수 영향이 더 크다.
    const scopeLimited = scopedVcenterIds(req.user, snap) != null;
    const key = `${snap.generatedAt}|${vc}|${JSON.stringify(loadPowerSettings())}|${fleetRev()}|${dcKey}|${scopeKey(req.user, snap)}`;
    const validIds = new Set((scoped.vcenters || []).map((v) => v.id));
    const payload = await snapMemo('power-breakdown', key, 60_000, async () => {
      const vcSkip = vcPowerSkipOf(scoped); // v2.733(C2-02) — /finops 와 같은 판정
      let measured = filterMeasuredByMapping(applyFleetExclude(applyFleetAssign(await allMeasuredPower({ hosts: scoped.hosts, vcenterFirst: true, ...vcSkip }), validIds)), scoped);
      if (scopeLimited) measured = keepMappedMeasured(measured, scoped);
      let collectorDc = null; let collectorDcManual = null;
      try { ({ map: collectorDc, manual: collectorDcManual } = collectorDcMaps()); } catch { collectorDc = null; collectorDcManual = null; }   // v2.972: 수집 서버 ↔ 법인 매칭(사용자 지정 → 이름 맞춤)
      return { ...computePowerBreakdown(scoped, measured, { vcenterId: vc, assign, datacenters, collectorDc, collectorDcManual }), vcPowerSkipped: vcPowerSkippedReport(scoped, vcSkip) };
    });
    if (isAdminReq(req)) sendCached(req, res, key, payload);
    else sendCached(req, res, `${key}|masked`, maskPowerBreakdownPayload(payload, insightsMatcher(snap)));
  } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});
// v2.629 AUTHZ2629-04: 전력 요금·PUE·CO2 계수는 전 법인 FinOps 수치가 함께 쓰는 공용 설정이다(v2.612 AUTHZ2612-02 형제) —
//   범위 관리자가 바꿀 수 있었고 감사 기록도 없었다.
const fleetOnly = fullScopeOnlyWith('FinOps 요금·PUE·탄소 계수는 전 법인 비용 계산에 함께 쓰이는 공용 설정이라 전체 범위(vCenter 제한 없는) 계정만 바꿀 수 있습니다.');
insightsRouter.put('/finops/config', adminOnly, fleetOnly, (req, res) => {
  const saved = saveFinopsConfig(req.body || {});
  const keys = Object.keys(req.body && typeof req.body === 'object' ? req.body : {}).slice(0, 20).join(',');
  logAudit({ user: req.user?.username, action: 'insights.finops.config', detail: keys || '(빈 변경)', ip: req.ip || '' });
  res.json(saved);
});

// --- 통합 서버 인벤토리: iDRAC/OME 물리 서버 + vCenter 호스트 → 가상화/베어메탈 분류 + 베어메탈 전력 ---
insightsRouter.get('/fleet', async (req, res) => {
  try {
    const snap = store.get();
    // scope(v2.289 #2): 통합 서버 인벤토리는 전 vCenter 호스트 + 미귀속 베어메탈 하드웨어를 전수
    // 노출한다. 범위 제한 계정에는 이를 부분 필터로 안전히 좁히기 어렵고(베어메탈=vCenter 귀속
    // 없음, CLAUDE.md '미귀속 데이터는 범위 계정 노출 금지'), 하드웨어 인벤토리는 본래 전체 범위
    // 운영자용(모든 변경 라우트가 adminOnly)이므로 범위 제한 계정에는 접근을 막는다(누수 차단).
    // (범위별 하드웨어 뷰가 필요하면 별도 설계로 확장.)
    if (scopedVcenterIds(req.user, snap)) {
      return res.status(403).json({ ok: false, reason: '통합 서버 인벤토리는 전체 범위(vCenter 제한 없는) 계정만 조회할 수 있습니다.' });
    }
    // 캐시 키: 스냅샷 생성시각 + 플릿 리비전(태그/소속/레지스트리 변경 시 즉시 +1). 매 요청 파일 읽기 없음.
    const key0 = `${snap.generatedAt}|${fleetRev()}`;
    const raw = await snapMemo('fleet', key0, 60_000, async () => getFleetInventory(snap));
    // v2.969: 행마다 법인(DataCenter) — 서버 분석 · 하드웨어 내보내기와 같은 판정(hwCorpContext — 수집한 Agent 의 법인 기준). 법인 설정(목록 · vCenter 할당)이 바뀌면 키가 바뀐다.
    // 스캔 대역 법인 · 수집 서버 → 법인 · 원격 목록은 fleetRev 를 올리지 않는다 — 1분 단위 칸을 키에 넣어 ETag 도 바뀌게 한다(304 로 옛 본문을 붙잡지 않게 — 반증 2969 F8).
    const key = `${key0}|dc:${hwDcSignature()}|t:${Math.floor(Date.now() / 60_000)}`;
    const full = await snapMemo('fleet-corp', key, 60_000, async () => enrichFleetCorp(raw, hwCorpContext(snap)));
    // liveKeys는 prune 내부용 — 응답에서 제외. bareMetalDupes(다음 점검 ① 2차)도 내부용 — 베어메탈 사용률 라우트가 범위 · 가림을 걸어 따로 내준다.
    const { liveKeys, bareMetalDupes: _dupes, ...payload1 } = full;
    // 서비스 인벤토리 6차 반증 F2: untaggedServerId(엣지 '태그 없을 때 id' — 고정 승계 내부용)도 응답에서 뺀다.
    //   IP 스캔 등록 iDRAC 은 등록부 id 가 곧 IP 라 'edge:<agent>:10.x.x.x' 가 되어 비관리자 주소 가림(maskFleetPayload)을 비켜 갔다(재현).
    // v2.961: collectorId(원격 출처 행의 수집 서버 id — 베어메탈 사용률 위임 판정 내부용)도 응답에서 뺀다.
    //   반증 F4: 가상화 호스트의 idracCollectorId(받침 원격 항목의 수집 서버 id)도 내부용이라 뺀다.
    const payload0 = { ...payload1, bareMetal: Array.isArray(payload1.bareMetal) ? payload1.bareMetal.map(({ untaggedServerId: _u, collectorId: _c, ...r }) => r) : payload1.bareMetal,
      virtualizationHosts: Array.isArray(payload1.virtualizationHosts) ? payload1.virtualizationHosts.map(({ idracCollectorId: _c, ...r }) => r) : payload1.virtualizationHosts };
    // v2.607(감사 LEFT2607-02): 엣지 부분 목록·상한 제외·귀속 비움 요약. 이 라우트는 범위 계정에 403 이라(위) 여기서는 늘 싣는다.
    //   부분 상태는 fleetRev 를 올리지 않을 수 있어(목록 내용이 같으면) ETag 키에 요약을 함께 넣는다.
    const fleetPartials = fleetPartialsSummary({ detail: isAdminReq(req) }); // v2.744(회귀 검토 GD-R1): 등록부 손상 사유의 위치는 관리자에게만(maskFleetPayload 는 이 요약을 건드리지 않는다)
    const payload = { ...payload0, fleetPartials };
    const fpKey = `${key}|fp:${JSON.stringify(fleetPartials)}`;
    if (isAdminReq(req)) sendCached(req, res, fpKey, payload);
    else sendCached(req, res, `${fpKey}|masked`, maskFleetPayload(payload, insightsMatcher(snap)));
  } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});
// --- 서버 하드웨어 정보 내보내기(v2.967 — 승인 시안 docs/design/baremetal-hw-xlsx · 사용자 기본안 7가지 2026-11-11) ---
// 게이트는 GET /fleet 과 같다(전체 범위 계정만 — 미귀속 베어메탈 하드웨어가 들어간다) + 파일 내보내기 권한 data.csv(v2.643 규약).
// 엑셀은 동시 1건(util/exportBusy — 없으면 포탈을 죽인다, security-api.md) · 워커 스레드에서 만든다(insights/hwExport/render.js).
// 관리자가 아니면 adminOnly 값(iDRAC 주소 · MAC · UUID)은 카탈로그에서 빠지고, 주소로 등록된 서버 이름 · Hostname 은 가린다(maskFleetPayload 와 같은 matcher).
const hwCsvPerm = requirePerm('data.csv');
const HW_FULL_SCOPE_REASON = '서버 하드웨어 정보 내보내기는 전체 범위(vCenter 제한 없는) 계정만 쓸 수 있습니다 — 통합 서버 인벤토리와 같은 기준입니다.';
const hwFullScopeOnly = fullScopeOnlyWith(HW_FULL_SCOPE_REASON);
async function hwFleetOf(snap) {
  return snapMemo('fleet', `${snap.generatedAt}|${fleetRev()}`, 60_000, async () => getFleetInventory(snap));   // GET /fleet 과 같은 캐시(같은 키)
}
/**
 * v2.968: 법인 = 법인(DataCenter) — 서버 분석 화면과 같은 판정(insights/hwExport/corp.js 머리말 · 사용자 신고 '법인별 서버 분리가 안 됨').
 * 서버 분석 목록(스캔 대역 법인 · 서비스태그로 찾은 vCenter 까지 채운 것)으로 색인을 만들고, 행 → 법인 함수와 법인 표시 순서(설정의 법인 순서)를 준다.
 */
export function hwCorpContext(snap) {
  const dcs = (() => { try { return listDatacenters() || []; } catch { return []; } })();
  const dcNames = new Map(dcs.map((d) => [String(d.id), String(d.name || d.id)]));
  const vcNames = new Map((snap?.vcenters || []).map((v) => [String(v.id), String(v.name || v.id)]));
  const dcOfVc = (vc) => { try { return datacenterOfVcenter(vc) || ''; } catch { return ''; } };
  let index = { byId: new Map(), byTag: new Map() };
  try { index = buildDcIndex(analysisServersWithRemote(null), dcOfVc); } catch { /* 색인을 못 만들면 vCenter 할당만으로(더 많은 서버가 미지정 — 지어내지 않는다) */ }
  // 엣지 보고 행의 에이전트 → 법인(수집 서버 id · 이름, 대소문자 무시 — analysisServers.scanSiteIndex 의 agentDc 와 같은 맞춤)
  let agentDc = () => '';
  try {
    const byCollector = collectorToDatacenterMap();
    const lower = new Map([...byCollector].map(([k, v]) => [String(k).toLowerCase(), v]));
    for (const c of loadCollectors()) { const n = String(c?.name || '').toLowerCase(); if (n && !lower.has(n)) lower.set(n, byCollector.get(String(c.id)) || ''); }
    agentDc = (a) => byCollector.get(a) || lower.get(String(a).toLowerCase()) || '';
  } catch { /* 수집 서버 등록부를 못 읽으면 에이전트 귀속 없이 */ }
  const corpOf = makeCorpOf({ index, dcOfVc, dcName: (id) => dcNames.get(id) || '', vcName: (id) => vcNames.get(id) || '', agentDc });
  return { corpOf, dcOrder: dcs.map((d) => String(d.id)), dcOfVc, datacenters: dcs.map((d) => ({ id: String(d.id), name: String(d.name || d.id) })) };
}
/** v2.972: 수집 서버 ↔ 법인 매칭(사용자 지정 · 이름 라벨) 서명 — 매칭을 바꾸면 법인 판정 캐시 키가 바뀌게. */
export function collectorDcSig() {
  try { return loadCollectors().map((c) => `${c.id}:${c.datacenterId || ''}:${c.datacenter || ''}`).sort().join(','); } catch { return ''; }
}
/** 법인 설정 서명(목록 이름 · vCenter 할당 · 수집 서버 매칭) — /fleet 응답 캐시 키. 못 읽으면 ''(그 경우 fleetRev · 스냅샷으로만 바뀐다). */
export function hwDcSignature() {
  try {
    const list = (listDatacenters() || []).map((d) => `${d.id}=${d.name || ''}`).join(',');
    const asg = Object.entries(getDatacenterAssign() || {}).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}>${v}`).join(',');
    return crypto.createHash('sha1').update(`${list}|${asg}|${collectorDcSig()}`).digest('base64').slice(0, 16);
  } catch { return ''; }
}
/**
 * v2.969(사용자 요청 '통합 서버 인벤토리 화면도 법인(DataCenter) 기준으로' · 'Agent 자동 판정만'): 분류 결과의 행마다 corpId · corpName · corpSource(· 미지정이면 corpWhy)를 싣고,
 * 법인 목록(corps — 화면 필터 · 칩)과 지정에 쓸 법인(DataCenter) 목록(datacenters), '법인 미지정' 수를 덧붙인다. 원본은 바꾸지 않는다(캐시 공유).
 */
export function enrichFleetCorp(full, cc) {
  if (!full || typeof full !== 'object') return full;
  const tag = (rows, k) => (Array.isArray(rows) ? rows.map((r) => { const c = cc.corpOf(r, k) || { id: '', name: '미지정', src: '' }; return { ...r, corpId: c.id, corpName: c.id ? c.name : '', corpSource: c.src || '', ...(c.id ? {} : { corpWhy: c.why || '', ...(c.whyCode ? { corpWhyCode: c.whyCode } : {}) }) }; }) : rows);
  const bareMetal = tag(full.bareMetal, 'bm');
  const virtualizationHosts = tag(full.virtualizationHosts, 'vh');
  const out = { ...full, bareMetal, virtualizationHosts, corps: hwCorpRoster(full, cc), datacenters: cc.datacenters || [] };
  if (full.summary && Array.isArray(bareMetal)) out.summary = { ...full.summary, bareMetalNoCorp: bareMetal.filter((b) => !b.corpId).length };
  return out;
}
/**
 * 법인 목록(창의 칩) — 서버가 한 대라도 있는 법인만, 설정의 법인 순서 → (법인 할당 없는 vCenter 묶음) → 미지정 순.
 * 대수는 분류 결과에 같은 corpOf 를 적용해 센다(화면에서 더하지 않게 · 파일과 같은 판정).
 */
export function hwCorpRoster(fleet, { corpOf, dcOrder = [] }) {
  const m = new Map();
  const bump = (row, k) => {
    const c = corpOf(row, k) || { id: '', name: '미지정' };
    const id = c.id || UNASSIGNED;
    if (!m.has(id)) m.set(id, { id, name: c.id ? c.name : '미지정', bm: 0, vh: 0 });
    m.get(id)[k]++;
  };
  for (const b of fleet?.bareMetal || []) bump(b, 'bm');
  for (const h of fleet?.virtualizationHosts || []) bump(h, 'vh');
  const pos = new Map(dcOrder.map((id, i) => [id, i]));
  const tier = (c) => (c.id === UNASSIGNED ? 2 : c.id.startsWith(VC_PREFIX) ? 1 : 0);
  const rank = (c) => (pos.has(c.id) ? pos.get(c.id) : Number.MAX_SAFE_INTEGER);
  return [...m.values()].sort((a, b) => tier(a) - tier(b) || rank(a) - rank(b) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
/** 쿼리 → 내보내기 선택(검증). 모르는 값은 기본값 · 모르는 법인 id 는 버린다. */
export function hwExportOpts(q, { admin = false, corpIds = [] } = {}) {
  const pick = (v, list, def) => (list.includes(String(v ?? '')) ? String(v) : def);
  const format = pick(q.format, HW_FMTS, 'xlsx');
  const kind = pick(q.kind, KINDS, 'bm');
  const band = pick(q.band, HW_BANDS, 'band');
  const spec = format === 'xlsx' && String(q.spec ?? '') === '1';
  const fields = resolveFields(q.fields ? String(q.fields) : BASIC_KEYS, { admin });
  let corps = null;
  const raw = String(q.corps ?? '').trim();
  if (raw && raw !== 'all') {
    const known = new Set(corpIds.map(String));
    corps = new Set(raw.split(',').map((x) => x.trim()).filter((x) => known.has(x)).slice(0, 500));
    if (!corps.size) return { ok: false, reason: '고른 법인이 없습니다(알 수 없는 법인 id 는 버립니다).' };
  }
  return { ok: true, format, kind, band, spec, fields, corps };
}
const asciiName = (s) => String(s || '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_+/g, '_').slice(0, 120);
export function hwExportFileBase({ kind, corps, roster, stamp }) {
  const kindWord = kind === 'vh' ? 'esxi-hosts' : kind === 'both' ? 'all-servers' : 'baremetal';
  let scope = 'all';
  if (corps) {
    const picked = roster.filter((c) => corps.has(c.id));
    scope = picked.length === 1 ? (picked[0].id === UNASSIGNED ? 'unassigned' : picked[0].name) : `${picked.length}corps`;
  }
  return `server-hardware_${kindWord}_${scope}_${stamp}`;
}

insightsRouter.get('/fleet/hardware-meta', hwCsvPerm, hwFullScopeOnly, async (req, res) => {
  try {
    const snap = store.get();
    const fleet = await hwFleetOf(snap);
    const admin = isAdminReq(req);
    const cc = hwCorpContext(snap);
    // 화면(통합 서버 인벤토리)의 vCenter 필터 → 법인 id('화면 필터대로' 가 쓴다). 법인 할당이 없는 vCenter 는 그 vCenter 묶음.
    const vcCorp = Object.fromEntries((snap?.vcenters || []).map((v) => [String(v.id), cc.dcOfVc(String(v.id)) || `${VC_PREFIX}${v.id}`]));
    res.set('Cache-Control', 'no-store').json({
      ok: true, admin, specMax: SPEC_MAX, catalog: catalogForClient({ admin }), basicKeys: BASIC_KEYS,
      corps: hwCorpRoster(fleet, cc), vcCorp, prefs: getHwPrefs(req.user?.username)?.def || null,
    });
  } catch { res.status(500).json({ ok: false, reason: '내보내기 정보를 만들지 못했습니다.' }); }
});

insightsRouter.put('/fleet/hardware-prefs', requireRole('admin', 'operator'), hwCsvPerm, hwFullScopeOnly, (req, res) => {
  if (isDemoGuest(req.user)) return res.status(403).json({ ok: false, reason: '데모 계정은 저장할 수 없습니다.' });
  const v = req.body && typeof req.body === 'object' ? req.body.value : null;
  const r = setHwPref(req.user?.username, 'default', v);
  if (!r.ok) return res.status(r.status || 400).json({ ok: false, reason: r.reason, ...(r.code ? { [r.code]: true } : {}) });
  res.json({ ok: true, prefs: r.prefs.def });
});

insightsRouter.get('/fleet/hardware-export', hwCsvPerm, hwFullScopeOnly, async (req, res) => {
  const snap = store.get();
  const admin = isAdminReq(req);
  let fleet;
  try { fleet = await hwFleetOf(snap); } catch { return res.status(500).json({ ok: false, reason: '통합 서버 인벤토리를 만들지 못했습니다.' }); }
  const cc = hwCorpContext(snap);
  const roster = hwCorpRoster(fleet, cc);
  const o = hwExportOpts(req.query || {}, { admin, corpIds: roster.map((c) => c.id) });
  if (!o.ok) return res.status(400).json({ ok: false, error: 'bad_request', reason: o.reason });
  const lock = acquireExport('fleet.hardware.export', req);
  if (!lock.ok) return res.status(lock.status).json(lock.body);
  const ac = new AbortController();
  const onClose = () => { if (!res.writableEnded) ac.abort(); };
  req.on('close', onClose);
  try {
    const invOf = makeInvOf({ getInventory, registry: loadRegistry(), remoteServers: allRemoteServers() });
    const corpRank = new Map(roster.map((c, i) => [c.id === UNASSIGNED ? '' : c.id, i]));
    const servers = selectServers(fleet, { kind: o.kind, corps: o.corps, invOf, match: admin ? null : insightsMatcher(snap), corpOf: cc.corpOf, corpRank });
    const model = await buildHwModel(servers, o.fields, { admin, spec: o.spec });
    const now = Date.now();
    const kindText = o.kind === 'vh' ? '가상화 서버(ESXi 호스트)만' : o.kind === 'both' ? '물리서버 + 가상화 서버' : '물리서버(베어메탈)만';
    const scopeText = o.corps ? roster.filter((c) => o.corps.has(c.id)).map((c) => c.name).join(' · ') : '모든 법인';
    const meta = { basis: `${scopeText} · ${kindText} · 서버 ${servers.length}대 · 기준 ${localStamp(now)}`, kindText, band: o.band, admin };
    const base = hwExportFileBase({ kind: o.kind, corps: o.corps, roster, stamp: fileStamp(now) });
    const out = await renderHwExport(model, { format: o.format, baseName: asciiName(base), meta, signal: ac.signal });
    logAudit({ user: req.user?.username, action: 'fleet.hardware.export', target: o.kind, detail: `${o.format}${out.ext === 'zip' ? '(zip)' : ''} · 서버 ${servers.length} · 값 ${o.fields.length}${o.spec ? ' · 사양서' : ''}`, ip: req.ip || '' });
    res.setHeader('Content-Type', out.mime);
    res.setHeader('Content-Disposition', `attachment; filename="${asciiName(base)}.${out.ext}"; filename*=UTF-8''${encodeURIComponent(`${base}.${out.ext}`)}`);
    res.setHeader('Cache-Control', 'no-store');
    res.end(out.buffer);
  } catch (e) {
    if (!res.headersSent) {
      const aborted = e?.code === 'aborted';
      res.status(aborted ? 499 : 500).json({ ok: false, error: 'export_failed', reason: aborted ? '요청이 끊겨 멈췄습니다.' : `파일을 만들지 못했습니다${e?.code === 'timeout' ? '(시간 초과)' : ''}.` });
    }
  } finally {
    req.off('close', onClose);
    lock.release();
  }
});

// 수동 분류 예외 지정/해제(관리자). body: { key, tag: 'baremetal'|'virtualization'|'exclude'|'auto' }
// 전체 vCenter 재폴링(store.refresh) 없이 fleetRev만 올려 다음 GET에서 즉시 재계산(고RTT·30개 환경 보호).
insightsRouter.put('/fleet/tag', adminOnly, fleetFullScopeOnly, (req, res) => {
  const r = setFleetTag(req.body?.key, req.body?.tag);
  if (r.ok) logAudit({ user: req.user?.username, action: '플릿 분류 변경', target: String(req.body?.key || ''), detail: String(req.body?.tag || 'auto'), ip: req.ip || '' });
  // v2.732(점검 2회차 B5-03): 실패(입력 거부·디스크 쓰기 실패)를 200 {ok:false} 로 주던 것 — 형제 /fleet/assign 처럼 400.
  res.status(r.ok ? 200 : 400).json(r);
});
// 베어메탈 서버의 소속 법인(vCenter) 등록/해제(관리자). body: { serverId, serviceTag, key, vcenterId }.
// iDRAC 레지스트리에 등록된 서버는 레지스트리 vcenterId(전력 귀속과 공유)를 직접 갱신하고(권위 소스),
// 동일 키의 stale fleet-assign은 정리해 split-brain을 막는다. 그 외(OME/원격/무전력 발견분)는
// fleet-assign 저장소에 키 기준으로 보관한다. vcenterId는 실제 존재하는 vCenter만 허용(유령 법인 차단).
// 한 서버의 소속 법인 귀속(단건). 반환 { ok, via?, reason? }.
function assignOne({ serverId, serviceTag, key, vcenterId, validIds }) {
  const assignKey = String(key || serviceTag || serverId || '').trim();
  if (!assignKey) return { ok: false, reason: 'serverId/serviceTag/key 중 하나가 필요합니다.' };
  const reg = serverId ? loadRegistry().find((s) => s.id === serverId && s.type !== 'ome') : null;
  if (reg) {
    const r = updateServer(serverId, { vcenterId });
    if (!r.ok) return r;
    // 레지스트리가 권위 소스가 되었으므로 동일 키의 과거 fleet-assign(OME 발견기 등)을 정리.
    setFleetAssign(assignKey, '');
    if (serviceTag) setFleetAssign(serviceTag, '');
    return { ok: true, via: 'registry' };
  }
  const r = setFleetAssign(assignKey, vcenterId, validIds);
  if (!r.ok) return r;
  return { ok: true, via: 'assign' };
}

insightsRouter.put('/fleet/assign', adminOnly, fleetFullScopeOnly, (req, res) => {
  const vcenterId = String(req.body?.vcenterId || '').trim();
  const validIds = new Set((store.get().vcenters || []).map((v) => v.id));
  if (vcenterId && !validIds.has(vcenterId)) return res.status(400).json({ ok: false, reason: `존재하지 않는 vCenter id: ${vcenterId}` });
  const r = assignOne({
    serverId: String(req.body?.serverId || '').trim(), serviceTag: String(req.body?.serviceTag || '').trim(),
    key: String(req.body?.key || '').trim(), vcenterId, validIds,
  });
  if (!r.ok) return res.status(400).json(r);
  logAudit({ user: req.user?.username, action: '플릿 법인 귀속', target: String(req.body?.key || req.body?.serviceTag || req.body?.serverId || ''), detail: vcenterId ? `→ ${vcenterId} (${r.via})` : `해제 (${r.via})`, ip: req.ip || '' });
  res.json({ ok: true, via: r.via, vcenterId });
});

// 여러 베어메탈을 한 법인으로 일괄 귀속(관리자). body: { items:[{serverId,serviceTag,key}], vcenterId }.
// 배치 I/O: 레지스트리 서버는 assignVcenter 1회(전체 1 read+1 write), 나머지는 setFleetAssignMany 1회.
// (과거: 서버당 updateServer+setFleetAssign → 수천 회 동기 전체파일 쓰기로 이벤트 루프 블로킹)
insightsRouter.put('/fleet/assign-bulk', adminOnly, fleetFullScopeOnly, (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 5000) : [];
  const vcenterId = String(req.body?.vcenterId || '').trim();
  if (!items.length) return res.status(400).json({ ok: false, reason: 'items가 비었습니다.' });
  const validIds = new Set((store.get().vcenters || []).map((v) => v.id));
  if (vcenterId && !validIds.has(vcenterId)) return res.status(400).json({ ok: false, reason: `존재하지 않는 vCenter id: ${vcenterId}` });

  const regIds = new Set(loadRegistry().filter((s) => s.type !== 'ome').map((s) => String(s.id)));
  const regTargets = [];      // 레지스트리 갱신 대상 serverId
  const assignEntries = [];   // fleet-assign 일괄 [key, vc]
  const staleClears = [];     // 레지스트리로 옮긴 서버의 과거 fleet-assign 정리 [key, '']
  for (const it of items) {
    const serverId = String(it?.serverId || '').trim();
    const serviceTag = String(it?.serviceTag || '').trim();
    const key = String(it?.key || serviceTag || serverId).trim();
    if (!key) continue;
    if (serverId && regIds.has(serverId)) {
      regTargets.push(serverId);
      staleClears.push([key, '']);
      if (serviceTag) staleClears.push([serviceTag, '']);
    } else {
      assignEntries.push([key, vcenterId]);
    }
  }
  if (regTargets.length) assignVcenter({ ids: regTargets, vcenterId });           // 레지스트리 1 read+1 write
  // v2.732(점검 2회차 B5-03): fleet-assign 쓰기 실패({ok:false})를 버리고 언제나 {ok:true, assigned} 를 줬다 — 화면은
  //   '일괄 등록 완료' 라 말하는데 소속은 저장되지 않았다. 실패는 실패로 응답하고, 이미 반영된 레지스트리 몫은 밝힌다.
  const fr = (assignEntries.length || staleClears.length) ? setFleetAssignMany([...assignEntries, ...staleClears], validIds) : { ok: true }; // fleet-assign 1 write
  if (fr && fr.ok === false) {
    logAudit({ user: req.user?.username, action: '플릿 법인 일괄 귀속 실패', target: vcenterId || '(해제)', detail: `레지스트리 ${regTargets.length}대 반영 · 소속 ${assignEntries.length}대 저장 실패: ${String(fr.reason || '').slice(0, 200)}`, ip: req.ip || '' });
    return res.status(500).json({
      ok: false,
      reason: `소속 저장 실패(${fr.reason || '사유 미상'}) — iDRAC 등록 서버 ${regTargets.length}대는 반영됐고, 그 밖의 ${assignEntries.length}대는 저장되지 않았습니다.`,
      registryAssigned: regTargets.length, notSaved: assignEntries.length, total: items.length,
    });
  }
  const assigned = regTargets.length + assignEntries.length;
  logAudit({ user: req.user?.username, action: '플릿 법인 일괄 귀속', target: vcenterId || '(해제)', detail: `${assigned}/${items.length}대 (레지스트리 ${regTargets.length} · 소속 ${assignEntries.length})`, ip: req.ip || '' });
  res.json({ ok: true, assigned, total: items.length, errors: [] });
});

// 유령 태그/소속 키 정리(관리자) — 현재 어느 '등록된' 서버/호스트와도 매칭 안 되는 잔재 키 제거.
// v2.783(점검 Q2 P-B3 — 데이터 손실): ① 판정은 화면 요약과 같은 fleetGhostReport 하나(원격 수집 서버·OME·엣지·호스트 전부의 합집합).
//   ② 출처를 하나라도 못 읽었으면(등록부 손상·OME 미수신·수집 서버 미수신·호스트 목록 모르는 vCenter·엣지 보류/만료) 지우지 않는다 —
//      등록부 손상은 503(registryUnreadable), 그 밖은 409. 미리보기(dryRun)도 같은 판정(blocked·unreadable)과 지울 키 목록을 준다.
//   ③ 실제 삭제는 **미리 본 키 목록(keys)** 을 받아 '그 목록 ∩ 지금도 유령' 만 지운다(확인창과 실제 삭제 사이에 바뀐 것을 지우지 않는다).
//      목록 없는 요청(구버전 화면의 {})은 400 — 예전에는 그 요청이 전부를 지웠다.
const PRUNE_KEYS_MAX = 5000;
insightsRouter.post('/fleet/prune', adminOnly, fleetFullScopeOnly, (req, res) => {
  try {
    const rep = fleetGhostReport(store.get());
    const blocked = rep.unreadable.length > 0;
    const regBlocked = rep.unreadable.some((u) => u.registry);
    const reason = blocked
      ? `읽지 못한 출처가 있어 유령 키를 정리하지 않습니다(살아 있는 서버의 키를 지울 수 있습니다) — ${rep.unreadable.slice(0, 5).map((u) => u.reason).join(' · ')}${rep.unreadable.length > 5 ? ` 외 ${rep.unreadable.length - 5}건` : ''}`
      : '';
    const view = {
      ghostKeys: rep.ghostKeys, wouldRemoveTags: rep.tags.length, wouldRemoveAssign: rep.assign.length,
      keys: rep.keys.slice(0, PRUNE_KEYS_MAX), keysTotal: rep.keys.length, blocked,
      unreadable: rep.unreadable.map(({ source, id, reason: r }) => ({ source, ...(id ? { id } : {}), reason: r })),
    };
    if (req.body?.dryRun) return res.json({ ok: true, dryRun: true, ...view, ...(blocked ? { reason } : {}) });
    if (blocked) return res.status(regBlocked ? 503 : 409).json({ ok: false, ...view, reason, ...(regBlocked ? { registryUnreadable: true } : {}) });
    const want = Array.isArray(req.body?.keys) ? req.body.keys : null;
    if (!want) return res.status(400).json({ ok: false, reason: '정리할 키 목록(keys — 미리보기 결과)이 필요합니다. 화면을 새로 고친 뒤 다시 시도하세요.' });
    const ghost = new Set(rep.keys);
    const del = new Set();
    for (const k of want.slice(0, PRUNE_KEYS_MAX)) {
      if (typeof k === 'string' && ghost.has(k)) del.add(k); // 미리보기가 준 키 그대로(저장 키와 글자 단위로 같다)
    }
    const keepOf = (obj) => new Set(Object.keys(obj || {}).filter((k) => !del.has(k)));
    const tags = del.size ? pruneFleetTags(keepOf(loadFleetTags())) : 0;
    const assign = del.size ? pruneFleetAssign(keepOf(loadFleetAssign())) : 0;
    const skipped = Math.max(0, want.length - del.size); // 미리 본 뒤 유령이 아니게 된 키(또는 잘못된 값) — 지우지 않았다
    logAudit({ user: req.user?.username, action: '플릿 유령 키 정리', target: `키 ${del.size} (태그 ${tags} · 소속 ${assign})`, detail: `${[...del].slice(0, 20).join(', ')}${del.size > 20 ? ` 외 ${del.size - 20}` : ''}${skipped ? ` · 건너뜀 ${skipped}` : ''}`, ip: req.ip || '' });
    res.json({ ok: true, removedKeys: del.size, removedTags: tags, removedAssign: assign, skipped });
  } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});

/*
 * v2.689(I2): 이상 탐지·예측은 metrics DB 를 여러 번 훑는 가장 비싼 조회다. 두 가지를 막는다.
 *  ① 캐시 키에 `req.originalUrl` 전체를 쓰면 의미 없는 쿼리(`&_=난수`)만 바꿔도 single-flight·60초 기억을 우회해 매번 재계산한다
 *     → 키는 **계산이 실제로 읽는 인자를 클램프한 값**으로만 만들고, 계산에도 그 값을 넘긴다(키와 계산이 같은 값을 본다).
 *     v2.769(R4-D2-06): 정규화는 계산 모듈의 함수 하나(anomalyCfgArgs·forecastCfgArgs)다 — 계산이 다시 정규화해도 결과가 같다(멱등).
 *  ② 키가 다른 계산도 **전역 동시 1건**으로 줄 세운다(진행 중 계산 뒤에 붙는다). 서로 다른 인자 수십 개가 동시에 들어와도
 *     DB 스캔이 겹치지 않는다. 같은 키의 동시 요청은 snapMemo 가 진행 중 Promise 에 합류시킨다.
 */
let _heavyTail = Promise.resolve();
let _heavyActive = 0;
let _heavyPeak = 0;
export function runHeavyExclusive(fn) {
  const run = _heavyTail.then(async () => {
    _heavyActive += 1; if (_heavyActive > _heavyPeak) _heavyPeak = _heavyActive;
    try { return await fn(); } finally { _heavyActive -= 1; }
  });
  _heavyTail = run.then(() => {}, () => {});
  return run;
}
/** 테스트·진단용 — 동시에 돈 무거운 계산의 최대 개수(1 이어야 한다). */
export function _insightsHeavyStats({ reset = false } = {}) {
  const r = { active: _heavyActive, peak: _heavyPeak };
  if (reset) _heavyPeak = _heavyActive;
  return r;
}
/*
 * v2.769(점검 R4-D2-06): 인자 정규화는 계산 모듈의 함수(anomalyCfgArgs·forecastCfgArgs)를 그대로 쓴다 — 예전 사본은 z 상한·
 *   minR2 클램프·정수화가 없어 `z=2.0001`… 이 캐시를 우회하고 직렬 대기열을 늘렸고, `?minR2=` 는 Number('')=0 으로 필터를 풀었다.
 *   키는 정규화 뒤 값으로 만든다(같은 계산 = 같은 키).
 */
/** 이상 탐지 인자(anomaly.js detectAnomalies 와 같은 함수). */
export function anomalyArgs(q = {}) {
  return anomalyCfgArgs(q);
}
/** 예측 인자(forecast.js forecastCapacity 와 같은 함수 — 버킷은 1시간 정배수). */
export function forecastArgs(q = {}) {
  const out = forecastCfgArgs(q);
  if (q.vcenterId) out.vcenterId = String(q.vcenterId);
  return out;
}

const argsKey = (o) => Object.keys(o).sort().map((k) => `${k}=${o[k]}`).join('&');

// --- AI 이상탐지 ---
// 요청마다 전 시계열 재집계라 가장 비싼 조회였다 — 동일 파라미터의 동시/반복 요청을
// single-flight + 60s TTL 로 1회 계산에 합류시킨다(N 사용자 폴링 → 계산 1회).
// 스냅샷 파생이 아니라 metrics DB 파생이므로 key 는 TTL 이 회전시킨다.
insightsRouter.get('/anomalies', async (req, res) => {
  try {
    // scope(v2.289 #2): 범위 제한 계정은 자기 vCenter 의 엔티티 이상치만. 스냅샷에서 허용 엔티티
    // 키(호스트 id·데이터스토어 id·vCenter id)를 모아 detectAnomalies 에 넘긴다(무제한이면 null).
    const snap = store.get();
    const allow = scopedVcenterIds(req.user, snap);
    let allowedKeys = null;
    if (allow) {
      allowedKeys = new Set();
      for (const v of snap.vcenters || []) if (allow.has(v.id)) allowedKeys.add(v.id);           // gpu_vc·temp_vc
      for (const h of snap.hosts || []) if (allow.has(h.vcenterId)) allowedKeys.add(h.id);        // temp_host·gpu_util
      for (const d of snap.datastores || []) if (allow.has(d.vcenterId)) allowedKeys.add(d.id);   // ds_usedgb
    }
    const args = anomalyArgs(req.query);
    const key = `anomalies|${argsKey(args)}|${scopeKey(req.user, snap)}`;
    const payload = await snapMemo('anomalies', key, 60_000, () => runHeavyExclusive(() => detectAnomalies({ ...args, allowedKeys })));
    sendCached(req, res, `${payload.generatedAt}|${key}`, payload);
  } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});

// --- 용량/수명 예측 --- (동일 스냅샷 + 동일 파라미터 = 계산 1회)
insightsRouter.get('/forecast', async (req, res) => {
  try {
    const snap = store.get();
    const scoped = scopeSlice(snap, req.user, req.query.vcenterId); // 데이터스토어 예측 scope
    const allowed = scopedVcenterIds(req.user, snap);               // GPU 예측 scope(스냅샷 밖 metrics DB 키)
    const args = forecastArgs(req.query);
    const key = `${snap.generatedAt}|forecast?${argsKey(args)}|${scopeKey(req.user, snap)}`;
    const payload = await snapMemo('forecast', key, 60_000, () => runHeavyExclusive(() => forecastCapacity(scoped, { ...args, allowed })));
    sendCached(req, res, key, payload);
  } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});

// --- 보안 자세(CVE/EOL) --- 범위 제한 계정은 자기 vCenter 호스트만(전 사이트 ESXi/CVE 노출 방지).
insightsRouter.get('/security', (req, res) => res.json(computeSecurityPosture(scopeSlice(store.get(), req.user, req.query.vcenterId))));

// --- 토폴로지·의존성 ---
insightsRouter.get('/topology', async (req, res) => {
  const snap = store.get();
  const vc = req.query.vcenterId || null; const host = req.query.host || null;
  const scoped = scopeSlice(snap, req.user, vc); // 범위 제한 계정은 자기 vCenter 구성만
  const key = `${snap.generatedAt}|${vc || ''}|${host || ''}|${scopeKey(req.user, snap)}`;
  const payload = await snapMemo('topology', key, 60_000, async () => buildTopology(scoped, { vcenterId: vc, host }));
  sendCached(req, res, key, payload);
});

// --- 구성도 그래프(3D 네트워크용) — 설정된 구성 + 라이브 스냅샷 ---
insightsRouter.get('/graph', async (req, res) => {
  const snap = store.get();
  const vms = req.query.vms === '1' || req.query.vms === 'true';
  const vc = req.query.vcenterId || null; const host = req.query.host || null;
  const scoped = scopeSlice(snap, req.user, vc); // 범위 제한 계정은 자기 vCenter 그래프만
  // NSX 노드는 스냅샷이 아니라 등록부에서 만들어지므로 scopeSlice 로는 안 좁혀진다 → 허용 집합을
  // 명시 전달해야 한다(전 사이트 NSX 매니저 노출 차단 — graph.js allowedVcIds 주석 참고).
  const allowedVcIds = scopedVcenterIds(req.user, snap);
  const key = `${snap.generatedAt}|${vms ? 1 : 0}|${vc || ''}|${host || ''}|${scopeKey(req.user, snap)}`;
  const payload = await snapMemo('graph', key, 60_000, async () => buildGraph(scoped, { vms, vcenterId: vc, host, allowedVcIds }));
  sendCached(req, res, key, payload);
});

// --- 인시던트 타임라인 ---
// scope 필수: 알람 상세·vCenter 수집 실패에 타 사이트 엔티티명이 들어간다(incidents.js 주석).
insightsRouter.get('/incidents', (req, res) => res.json(getIncidents({
  limit: pageArgs(req.query, { def: 200, max: 1000 }).limit,   // v2.595(감사 DEPS2595-02): 음수·거대값 하한·상한
  allowed: scopedVcenterIds(req.user, store.get()),
})));

// --- ChatOps(자연어 운영 질의) ---
insightsRouter.post('/chatops', async (req, res) => {
  // v2.591 S1: inv.* 권한이 없는 종류의 원본 객체·이름을 싣지 않는다(`/search/nl` 과 같은 기준).
  try { res.json(await chatOps(req.body?.question || req.body?.q || '', scopedVcenterIds(req.user, store.get()), { can: (k) => userHasPermission(req.user, k) })); }
  catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});
