// IPAM 설정/스캔/대역 — admin.js(구 2,410줄) 분할(v2.285.0). v2.639: 중앙 토큰·개별 토큰·위임 인벤토리·수신 통계 라우트 10개는
//   routes/admin/centralTokens.js 로 분리했다(이 파일은 IPAM 전용). 등록 순서는 admin.js 호출 순서가 보존한다.
import { config, loadVcenterConfig } from '../../config.js';
import { ledgerInfo } from '../../ipam/db.js';
import { loadSettings as loadIpamSettings, saveSettings as saveIpamSettings, savedInvalidEntries, invalidEntries, ignoreRanges, getClassifier } from '../../ipam/settings.js';
import { makeVcResolver } from '../../ipam/vcResolve.js'; // v2.639: vCenter 이름 해석기 한 벌(모호하면 null — 예전엔 첫 항목을 택했다)
import { checkRangeList } from '../../ipam/rangeSyntax.js';
import { listTargets } from '../../agent/deployRegistry.js';
import { logAudit } from '../../audit.js';
import { loadScanSettings, saveScanSettings, scanResultList, scanInfo, listScanAgents, getAgentReports, getScanRuns, getScanResults, LOCAL } from '../../ipam/scanStore.js';
import { buildScanRangeRows, applyRangeLineOp } from '../../ipam/scanRangeRows.js'; // v2.692: 등록된 스캔 대역 표 · 줄 단위 수정
import { startScan, scanStatus, rescheduleScanPoller } from '../../ipam/scanPoller.js';
import { recordScanLog, listScanLog, SCAN_LOG_EVENTS } from '../../ipam/scanLog.js'; // v2.636: 스캔 실행 로그
import { scanRangesToCsv, scanRangesSampleCsv, parseScanRangesCsv, analyzeScanRangesImport, LOCAL_AGENT } from '../../ipam/scanRangesCsv.js'; // v2.636: 에이전트별 스캔 대역 CSV
import { RANGE_CAP } from '../../ipam/scan.js';
import { agentVcenterIds, suggestAgentSubnets } from '../../ipam/scanDatacenter.js'; // v2.638: 데이터센터 귀속 · /24 대역 제안
import { currentScanDatacenters, invalidateScanDatacenters, scanDatacenterOf } from '../../ipam/scanDatacenterSource.js';
import { agentIdracServers } from '../../ipam/scanSuggestSource.js';
import { listDatacenters, datacenterOfVcenter, getDatacenterAssign } from '../../datacenter/store.js';
import { listScanRanges as listIdracScanRanges } from '../../idrac/scanRanges.js';
import { idracSubnets, vmSubnets, annotateSubnets, SUBNET_MAX } from '../../ipam/vcRangeSuggest.js'; // v2.690: vCenter 스캔 대역 '/24 가져오기'
import { todayStamp } from '../../util/dayKey.js';
import { readMigrationState, runVcRangeMigration, moveVcRangeManually, removeVcRangeManually, dismissMigration } from '../../ipam/vcRangeMigrate.js'; // v2.691: vCenter 별 대역 → 에이전트
import { saveVcRanges, removeVcRanges, listVcRanges } from '../../ipam/rangeStore.js';
import { sampleCsv as vcRangesSampleCsv, parseVcRangesCsv, analyzeVcRangesImport } from '../../ipam/vcRangesCsv.js';
import { listAssignments as listIdracAssignments, getResults as getAgentResults } from '../../central/assignments.js';
import { listCollectors } from '../../collector/registry.js';
import { adminOnly, fullScopeOnlyWith } from './shared.js';
import { store } from '../../store.js';
import { scopedVcenterIds, writeScopedVcenterIds } from '../../auth/scope.js';
import { mergeScopedMap, filterScopedMap, keepScopedFields, ignoredGlobalFields } from '../../auth/scopeMerge.js';
import { requirePerm as requireCsvPerm } from '../../auth/auth.js';
// v2.643: CSV·텍스트 가져오기/내보내기는 관리자 이상 + 'data.csv' 권한(super_admin 항상, admin 은 권한 설정에서 끌 수 있다).
const csvPerm = requireCsvPerm('data.csv');

// v2.607 AUTHZ2607-04·07: 위임 인벤토리 현황·소유 엣지·IP 스캔 결과·설정은 법인 축으로 나눌 수 없거나(엣지·스캔 대역 전체)
//   전 법인에 걸친 동작이라 범위 계정 403(v2.525 규약). vCenter별 스캔 대역은 쓰기 범위 밖이면 404(존재 은닉) —
//   GET(/tools/ipam/vc-ranges)은 범위로 거르는데 쓰기가 무스코프라 범위 admin 이 보이지 않는 법인 대역을 덮어쓰고 지웠다.
const fleetOnly = fullScopeOnlyWith('이 기능은 전 법인(엣지·스캔 전체)에 걸친 데이터·동작이라 전체 범위(vCenter 제한 없는) 계정만 쓸 수 있습니다.');
function vcRangeWritable(user, vcenterId) {
  const w = writeScopedVcenterIds(user, store.get());
  return !w || w.has(String(vcenterId || ''));
}

/**
 * v2.638: IP 스캔 설정 화면의 데이터센터 칸 — 이 에이전트의 귀속 판정(수동/자동/판정 불가와 근거)과 고를 수 있는 DataCenter 목록.
 * DataCenter 목록을 못 읽으면 빈 목록 + 사유(`datacentersError`) — 화면이 '없음' 이 아니라 '못 읽음' 이라 말한다.
 */
function scanDatacenterView(agent) {
  let datacenters = []; let datacentersError = null;
  try { datacenters = listDatacenters().map((d) => ({ id: d.id, name: d.name || d.id })); } catch (e) { datacentersError = String(e?.message || e).slice(0, 200); }
  let datacenter = null;
  try { datacenter = scanDatacenterOf(agent, store.get().vcenters); } catch { /* 판정 실패 — null(화면: 판정하지 못함) */ }
  return { datacenter, datacenters, ...(datacentersError ? { datacentersError } : {}) };
}

export function registerCentralIpam(adminRouter) {

// Shareable IP ledger DB location + record count (for other-program integration).
adminRouter.get('/ipam/db-info', adminOnly, async (_req, res) => {
  res.json(await ledgerInfo());
});

// IPMS settings: ignore IP ranges (global + per-vCenter) hidden from the ledger.
// v2.611 LEFT2611-02: 범위 계정에는 범위 안 vCenter 의 무시 대역만 보이고(omittedOutOfScope), PUT 은 범위 밖 vCenter 키를
//   직전 값 그대로 보존한다(v2.605 mergeScopedMap — 예전엔 GET 이 준 목록을 그대로 저장해 다른 법인 대역을 지웠다). 전 법인 공통
//   목록(전체 무시·공인·사설 대역)은 범위 계정이 바꿀 수 없다 — 적용하지 않고 ignoredGlobal 로 밝힌다(v2.607 AUTHZ2607-05).
const ipamList = (v) => (Array.isArray(v) ? v : String(v || '').split(/\r?\n/)).map((x) => String(x).trim()).filter(Boolean);
function ipamSettingsView(settings, allowed, snap) {
  // v2.637: 저장돼 있지만 적용되지 않는 줄(검증 전 저장분)과, 삭제된 vCenter 에 남은 무시 대역을 밝힌다 — 예전에는 화면의
  //   vCenter 선택기가 등록된 vCenter 만 보여 줘서 삭제된 vCenter 의 대역을 보거나 지울 길이 없었다.
  const known = new Set((snap?.vcenters || []).map((v) => v.id));
  const view = (st, extra = {}) => {
    const invalidSaved = savedInvalidEntries(st);
    const orphanVcenters = Object.keys(st.vcenters || {}).filter((k) => !known.has(k));
    return { settings: st, ...extra, ...(invalidSaved.length ? { invalidSaved } : {}), ...(orphanVcenters.length ? { orphanVcenters } : {}) };
  };
  if (!allowed) return view(settings);
  const all = Object.keys(settings.vcenters || {});
  const vcenters = filterScopedMap(settings.vcenters || {}, allowed);
  const omitted = all.length - Object.keys(vcenters).length;
  return view({ ...settings, vcenters }, omitted ? { omittedOutOfScope: omitted } : {});
}
// v2.637: 적용될 목록만 검사한다(범위 계정의 전역 목록 변경은 어차피 적용되지 않으므로 검사 대상이 아니다).
//   v2.639: 판정 본체는 ipam/settings.js invalidEntries 하나(savedInvalidEntries 와 같은 루프였다 — 두 벌 제거).
const ipamSettingsInvalid = (body, opt) => invalidEntries(body, opt);
const invalidReply = (res, invalid) => res.status(400).json({ ok: false, reason: `형식이 올바르지 않은 줄 ${invalid.length}개가 있어 저장하지 않았습니다.`, invalid: invalid.slice(0, 200), invalidCount: invalid.length });
adminRouter.get('/ipam/settings', adminOnly, (req, res) => {
  const snap = store.get();
  res.json(ipamSettingsView(loadIpamSettings(), scopedVcenterIds(req.user, snap), snap));
});
adminRouter.put('/ipam/settings', adminOnly, (req, res) => {
  const snap = store.get();
  const readAllowed = scopedVcenterIds(req.user, snap);
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  if (!readAllowed) {
    const invalid = ipamSettingsInvalid(body, { globals: true });
    if (invalid.length) return invalidReply(res, invalid);
    return res.json({ ok: true, ...ipamSettingsView(saveIpamSettings(body), null, snap) });
  }
  const writeAllowed = writeScopedVcenterIds(req.user, snap) || readAllowed;
  const invalid = ipamSettingsInvalid(body, { globals: false, vcKeys: writeAllowed });
  if (invalid.length) return invalidReply(res, invalid);
  const before = loadIpamSettings();
  const norm = (o) => ({ global: ipamList(o.global), publicRanges: ipamList(o.publicRanges), privateRanges: ipamList(o.privateRanges) });
  const { ignoredGlobal } = keepScopedFields({ ...body, ...norm(body) }, { ...before, ...norm(before) }, writeAllowed, ['vcenters']);
  const { merged, ignored } = mergeScopedMap(before.vcenters || {}, body.vcenters || {}, writeAllowed);
  const settings = saveIpamSettings({ global: before.global, publicRanges: before.publicRanges, privateRanges: before.privateRanges, vcenters: merged });
  res.json({ ok: true, ...ipamSettingsView(settings, readAllowed, snap), ...(ignored.length ? { ignoredOutOfScope: ignored.length } : {}), ...ignoredGlobalFields(ignoredGlobal) });
});

// (중앙 토큰·개별 토큰·위임 인벤토리·수신 통계 라우트 10개는 v2.639 에 routes/admin/centralTokens.js 로 옮겼다.)

// IP 능동 스캔(TCP 커넥트) — 에이전트별 설정/상태/수동실행/결과.
// agent 미지정 = 이 포탈(중앙) 직접 스캔(__local__). 그 외 이름 = 분산 에이전트 할당.
adminRouter.get('/ipam/scan/settings', adminOnly, fleetOnly, (req, res) => { // v2.611 LEFT2611-07: 형제 PUT·run·results 와 같은 게이트(임의 ?agent= 설정·전 엣지 보고)
  const agent = req.query.agent || LOCAL;
  // 선택 가능한 에이전트: 로컬 + IP스캔 설정된 에이전트 + iDRAC 할당 + 중앙에 보고한
  // 에이전트(getResults) + 배포된 에이전트(agentName) + 수집 서버(datacenter).
  const names = new Set([LOCAL]);
  for (const a of listScanAgents()) names.add(a.name);
  for (const a of listIdracAssignments()) if (a.agent) names.add(a.agent);
  for (const k of Object.keys(getAgentResults() || {})) names.add(k);
  for (const t of listTargets()) if (t.agentName) names.add(t.agentName);
  for (const c of listCollectors()) if (c.datacenter) names.add(c.datacenter);
  for (const k of Object.keys(getAgentReports() || {})) if (k && k !== LOCAL) names.add(k);
  res.json({
    agent, settings: loadScanSettings(agent), agents: [...names],
    status: scanStatus(), info: scanInfo(),
    centralEnabled: !!config.central.token,   // 에이전트 보고 가능 여부(중앙 토큰 설정)
    reports: getAgentReports(),               // 에이전트별 마지막 보고
    ...scanDatacenterView(agent),             // v2.638: 이 에이전트의 데이터센터 귀속 판정 + 고를 수 있는 DataCenter 목록
  });
});
adminRouter.put('/ipam/scan/settings', adminOnly, fleetOnly, (req, res) => {
  const agent = (req.body && req.body.agent) || LOCAL;
  // v2.638: 데이터센터는 등록된 DataCenter 만(빈 값 = 자동). 목록에 없는 값을 저장하면 그 에이전트의 스캔 결과가 어디에도 귀속되지 않는다.
  if (req.body && req.body.datacenterId !== undefined && req.body.datacenterId !== '') {
    const want = String(req.body.datacenterId || '').trim();
    let dcs = [];
    try { dcs = listDatacenters(); } catch { /* 아래에서 거부 */ }
    if (!dcs.some((d) => d.id === want)) return res.status(400).json({ ok: false, reason: `등록되지 않은 DataCenter 입니다: ${want.slice(0, 64)} — 설정 › DataCenter 에서 먼저 등록하거나 '자동' 을 고르세요.` });
  }
  // v2.639: 대역 문법은 형제 PUT /ipam/vc-ranges 와 같은 판정(checkRangeList — 뒤집힌 범위 오류·스캔 상한 경고)으로 검사한다.
  //   예전에는 검사 0(saveScanSettings 는 trim 뿐)이라 `10.0.0.0/24.5`·`10.0.0.250-300` 이 저장되고, 엣지가 그 줄을 느슨한 파서로
  //   스캔한 뒤 중앙 `/ip-scan-result` 가 specToRange null 로 전부 409 거부했다. 나누는 규칙([\n,])은 saveScanSettings 와 같다.
  let check = null;
  if (req.body && req.body.ranges !== undefined) {
    const raw = req.body.ranges;
    check = checkRangeList(Array.isArray(raw) ? raw : String(raw ?? '').split(/[\n,]/), { reversed: 'error', scanCap: RANGE_CAP });
    if (check.invalid.length) return invalidReply(res, check.invalid.map((x) => ({ field: 'ranges', agent, ...x })));
  }
  const settings = saveScanSettings(agent, req.body || {});
  invalidateScanDatacenters();
  if (agent === LOCAL) rescheduleScanPoller(); // 로컬 설정만 이 포탈 폴러에 적용
  recordScanLog({ event: 'settings', agent, user: req.user?.username, ranges: (settings.ranges || []).length, rangesSample: (settings.ranges || []).slice(0, 5),
    message: `IP 스캔 설정 저장 — ${settings.enabled ? '주기 스캔 켬' : '주기 스캔 끔'} · 주기 ${Math.round((settings.intervalMs || 0) / 60000)}분 · 포트 ${(settings.ports || []).length}개` });
  res.json({ ok: true, agent, settings, status: scanStatus(), ...(check?.warnings.length ? { warnings: check.warnings.slice(0, 50) } : {}), ...scanDatacenterView(agent) });
});
// v2.638: 에이전트가 쓰는 /24 대역 제안 — 그 에이전트가 수집하는 vCenter 의 VM·호스트 IP + 담당 iDRAC 관리 IP(스냅샷·등록부만 읽는다 — 장비 왕복 0).
adminRouter.get('/ipam/scan/suggest', adminOnly, fleetOnly, (req, res) => {
  const agent = String(req.query.agent || LOCAL).slice(0, 128);
  const snap = store.get();
  const { inputs } = currentScanDatacenters(snap.vcenters);
  const vcIds = agentVcenterIds(agent, { vcenters: inputs.vcenters, snapVcenters: snap.vcenters, collectors: inputs.collectors });
  const idrac = agentIdracServers(agent, inputs.collectors);
  const vcName = {};
  for (const v of snap.vcenters || []) vcName[v.id] = v.name || v.id;
  const r = suggestAgentSubnets({ vcenterIds: vcIds, vms: snap.vms, hosts: snap.hosts, idrac: idrac.servers, vcName });
  res.json({
    ok: true, agent, ...r,
    vcenters: vcIds.map((id) => ({ id, name: vcName[id] || id })),
    idracServers: idrac.servers.length, idracSource: idrac.source,
    datacenter: scanDatacenterOf(agent, snap.vcenters),
    ...(Object.keys(inputs.errors || {}).length ? { inputErrors: inputs.errors } : {}),
  });
});
/**
 * v2.691: 스캔 대역 소유자 목록(중복 판정용) — 에이전트별 스캔 대역 + 아직 옮기지 못한 vCenter 별 대역.
 * 화면은 지금 고른 에이전트를 빼고 나머지와 겹치는지 본다(같은 대역을 둘이 주기 스캔하면 결과가 섞인다).
 */
function scanRangeOwners() {
  const out = [];
  for (const a of listScanAgents()) out.push({ owner: a.name, label: a.name === LOCAL ? '이 포탈에서 직접' : a.name, kind: 'agent', enabled: a.enabled !== false, ranges: a.ranges || [] });
  if (!out.some((x) => x.owner === LOCAL)) { const l = loadScanSettings(LOCAL); out.push({ owner: LOCAL, label: '이 포탈에서 직접', kind: 'agent', enabled: l.enabled !== false, ranges: l.ranges || [] }); }
  const vcName = {};
  for (const v of store.get().vcenters || []) vcName[v.id] = v.name || v.id;
  for (const e of listVcRanges()) if ((e.ranges || []).length) out.push({ owner: `vc:${e.vcenterId}`, label: `vCenter ${vcName[e.vcenterId] || e.vcenterId}(옮기지 않은 대역)`, kind: 'vcenter', enabled: e.enabled !== false, ranges: e.ranges || [] });
  return out;
}
adminRouter.get('/ipam/scan/owners', adminOnly, fleetOnly, (_req, res) => {
  res.json({ ok: true, owners: scanRangeOwners() });
});
/**
 * v2.691: 스캔 대역 '/24 가져오기'(에이전트 기준) — kind=idrac(DataCenter 의 iDRAC 스캔 대역을 **서비스별**로) · kind=vm(vCenter VM 의 IPv4).
 * 스냅샷·설정 파일만 읽는다(장비 왕복 0). 텍스트 박스·다른 에이전트와의 중복 판정은 웹이 한다(저장 안 한 입력 기준).
 * 전 법인 데이터(iDRAC 스캔 대역·전 vCenter VM)라 형제 스캔 설정 라우트와 같은 게이트(adminOnly + fleetOnly).
 */
adminRouter.get('/ipam/scan/import', adminOnly, fleetOnly, (req, res) => {
  const agent = String(req.query.agent || LOCAL).slice(0, 128);
  const kind = req.query.kind === 'idrac' ? 'idrac' : req.query.kind === 'vm' ? 'vm' : '';
  if (!kind) return res.status(400).json({ ok: false, reason: 'kind 는 idrac 또는 vm 입니다.' });
  const snap = store.get();
  const { inputs } = currentScanDatacenters(snap.vcenters);
  const mine = new Set(agentVcenterIds(agent, { vcenters: inputs.vcenters, snapVcenters: snap.vcenters, collectors: inputs.collectors }));
  const base = { ok: true, kind, agent, cap: SUBNET_MAX };
  if (kind === 'vm') {
    const vcs = (snap.vcenters || []).map((v) => ({ id: v.id, name: v.name || v.id, mine: mine.has(v.id) }))
      .sort((a, b) => (Number(b.mine) - Number(a.mine)) || String(a.name).localeCompare(String(b.name)));
    const asked = String(req.query.vcenterId || '').slice(0, 200);
    if (asked && !vcs.some((v) => v.id === asked)) return res.status(404).json({ ok: false, reason: 'vCenter 를 찾을 수 없습니다.' });
    const vcenterId = asked || vcs.find((v) => v.mine)?.id || '';
    const vc = vcs.find((v) => v.id === vcenterId);
    if (!vcenterId) return res.json({ ...base, vcenters: vcs, vcenterId: '', subnets: [], totals: {}, omitted: 0, noVcenter: true, initial: !!snap.initial });
    const vr = vmSubnets({ vms: snap.vms, vcenterId });
    const ann = annotateSubnets(vr.subnets, { ...ipmsCtx(snap), vcenterIds: [vcenterId] });
    return res.json({ ...base, vcenters: vcs, vcenterId, vcenterName: vc?.name || vcenterId, vcenterMine: !!vc?.mine, ...vr, subnets: ann.subnets, ignored: ann.ignored, ignoreSources: ann.sources, initial: !!snap.initial });
  }
  let datacenters = []; let datacentersError = '';
  try { datacenters = listDatacenters().map((d) => ({ id: d.id, name: d.name || d.id })); } catch (e) { datacentersError = e?.message || String(e); }
  let decided = null;
  try { decided = scanDatacenterOf(agent, snap.vcenters); } catch { decided = null; }
  const assigned = decided?.datacenterId || '';
  const asked = String(req.query.datacenterId || '').slice(0, 200);
  const datacenterId = asked || assigned;
  const dc = datacenters.find((d) => d.id.toLowerCase() === datacenterId.toLowerCase());
  let entries = []; let rangesError = '';
  try { entries = listIdracScanRanges(); } catch (e) { rangesError = e?.message || String(e); }
  const low = datacenterId.toLowerCase();
  const mineEntries = datacenterId ? entries.filter((e) => String(e?.datacenterId || '').trim().toLowerCase() === low) : [];
  // 서비스마다 번호(1,2,3…)를 붙인다 — 이름이 없으면 화면이 '이름 없음' 으로 쓴다(지어내지 않는다).
  // v2.692: IPMS 무시 대역 — 전체 + 이 DataCenter 에 할당된 vCenter 의 무시 목록(iDRAC 대역에는 vCenter 축이 없어 DataCenter 로 잇는다).
  let dcVcIds = [];
  try { const asg = getDatacenterAssign(); dcVcIds = Object.keys(asg).filter((k) => String(asg[k] || '').toLowerCase() === datacenterId.toLowerCase()); } catch { dcVcIds = []; }
  const ctx = ipmsCtx(snap);
  let ignoreSources = null;
  const services = mineEntries.map((e, i) => {
    const r0 = idracSubnets({ entries: [e], datacenterId });
    const ann = annotateSubnets(r0.subnets, { ...ctx, vcenterIds: dcVcIds });
    ignoreSources = ann.sources;
    const r = { ...r0, subnets: ann.subnets, ignored: ann.ignored };
    return { no: i + 1, id: String(e.id || ''), service: String(e.service || '').trim(), ranges: (e.ranges || []).map((x) => String(x).trim()).filter(Boolean),
      enabled: e.enabled !== false, scanAgent: String(e.agent || '').trim(), subnets: r.subnets, ignored: r.ignored, invalid: r.invalid, omitted: r.omitted };
  });
  res.json({
    ...base, datacenterId, datacenterName: dc?.name || datacenterId, assignedDatacenterId: assigned,
    datacenterSource: asked ? 'chosen' : assigned ? (decided?.source || 'auto') : 'none', datacenterMissing: !!datacenterId && !dc && !datacentersError,
    datacenters, services, ignoreSources: ignoreSources || annotateSubnets([], { vcenterIds: dcVcIds, vcName: ctx.vcName }).sources, ignoreVcenters: dcVcIds,
    ...(datacentersError ? { datacentersError } : {}), ...(rangesError ? { rangesError } : {}),
  });
});
/**
 * v2.692: '/24 가져오기' 에 쓰는 IPMS 설정 묶음 — 무시 대역(전체 + vCenter 별)과 공인/사설 분류기.
 * 대장이 쓰는 것과 같은 목록·같은 분류기다(가져오기와 대장의 판정이 갈라지지 않게).
 */
function ipmsCtx(snap) {
  const vcName = {};
  for (const v of snap?.vcenters || []) vcName[v.id] = v.name || v.id;
  let ignore = { global: [], vcenters: {} }; let classify = null;
  try { ignore = ignoreRanges(); } catch { /* 설정을 못 읽으면 무시 대역 없이(빼지 않는 쪽) */ }
  try { classify = getClassifier().num; } catch { classify = null; }
  return { ignore, classify, vcName };
}
/**
 * v2.692: '스캔 대역·설정 › ① 등록된 스캔 대역' — 에이전트별 스캔 대역을 한 줄 = 한 행으로. 스냅샷·설정·스캔 결과만 읽는다(왕복 0).
 * 전 법인 데이터라 형제 스캔 설정 라우트와 같은 게이트(adminOnly + fleetOnly).
 */
adminRouter.get('/ipam/scan/ranges', adminOnly, fleetOnly, (_req, res) => {
  const snap = store.get();
  const { inputs } = currentScanDatacenters(snap.vcenters);
  const agents = listScanAgents();
  if (!agents.some((a) => a.name === LOCAL)) agents.unshift({ name: LOCAL, ...loadScanSettings(LOCAL) });
  const ctx = ipmsCtx(snap);
  const r = buildScanRangeRows({
    agents, results: getScanResults(), classify: ctx.classify, ignore: ctx.ignore,
    vcenterIdsOf: (a) => agentVcenterIds(a, { vcenters: inputs.vcenters, snapVcenters: snap.vcenters, collectors: inputs.collectors }),
    datacenterOf: (a) => scanDatacenterOf(a, snap.vcenters),
  });
  const vcName = ctx.vcName;
  res.json({ ok: true, rows: r.rows, agents: agents.map((a) => ({ name: a.name, enabled: a.enabled !== false })), vcName, scanInfo: scanInfo() });
});
/**
 * v2.692: 줄 단위 추가·수정·삭제. 그 에이전트의 다른 줄은 건드리지 않는다. `old` 가 지금 값과 다르면 409(다른 관리자가 바꿨다).
 * 대역 문법은 저장 PUT 과 같은 판정(checkRangeList — 뒤집힌 범위 오류·스캔 상한 경고).
 */
adminRouter.post('/ipam/scan/ranges/line', adminOnly, fleetOnly, (req, res) => {
  const b = req.body || {};
  const agent = String(b.agent || LOCAL).slice(0, 128);
  const op = String(b.op || '');
  const cur = loadScanSettings(agent);
  const r = applyRangeLineOp(cur.ranges, { op, index: b.index, old: b.old, value: b.value });
  if (!r.ok) return res.status(r.code === 'stale' ? 409 : 400).json({ ok: false, code: r.code, reason: r.reason });
  const check = checkRangeList(r.ranges, { reversed: 'error', scanCap: RANGE_CAP });
  if (op !== 'delete' && check.invalid.length) return invalidReply(res, check.invalid.map((x) => ({ field: 'ranges', agent, ...x })));
  const settings = saveScanSettings(agent, { ranges: r.ranges });
  invalidateScanDatacenters();
  if (agent === LOCAL) { try { rescheduleScanPoller(); } catch { /* */ } }
  const word = op === 'add' ? '추가' : op === 'edit' ? '수정' : '삭제';
  recordScanLog({ event: 'settings', agent, user: req.user?.username, ranges: (settings.ranges || []).length, rangesSample: [String(b.value || b.old || '').slice(0, 80)],
    message: `스캔 대역 ${word} — ${op === 'edit' ? `${String(b.old || '').slice(0, 80)} → ${String(b.value || '').slice(0, 80)}` : String(b.value || b.old || '').slice(0, 80)}` });
  logAudit({ user: req.user?.username, action: `ipam.scan.range.${op}`, target: agent, detail: op === 'edit' ? `${b.old} → ${b.value}` : String(b.value || b.old || ''), ip: req.ip });
  res.json({ ok: true, agent, ranges: settings.ranges, ...(check.warnings.length ? { warnings: check.warnings.slice(0, 50) } : {}) });
});
/**
 * v2.691: vCenter 별 스캔 대역 → 에이전트 이전 기록과 남은 대역. 아직 이전하지 않았고 스냅샷이 첫 병합을 지났으면 여기서 1회 실행한다
 * (기동 뒤 예약 실행과 같은 함수 — 동기라 겹치지 않는다).
 */
function migrationView() {
  let st = readMigrationState();
  if (!st?.done && !store.get()?.initial) {
    try { const r = runVcRangeMigration(); if (r.ran) { st = r.state; try { rescheduleScanPoller(); } catch { /* */ } } } catch { /* 화면이 '아직 이전 안 함' 으로 말한다 */ }
  }
  const vcName = {};
  for (const v of store.get().vcenters || []) vcName[v.id] = v.name || v.id;
  const remaining = listVcRanges().map((e) => ({ vcenterId: e.vcenterId, vcenterName: vcName[e.vcenterId] || e.vcenterId, ranges: e.ranges || [], enabled: e.enabled !== false }));
  const agents = [...new Set([LOCAL, ...listScanAgents().map((a) => a.name)])];
  return { ok: true, state: st, remaining, agents };
}
adminRouter.get('/ipam/scan/migration', adminOnly, fleetOnly, (_req, res) => { res.json(migrationView()); });
adminRouter.post('/ipam/scan/migration/move', adminOnly, fleetOnly, (req, res) => {
  const vcenterId = String(req.body?.vcenterId || '').slice(0, 200);
  const agent = String(req.body?.agent || '').trim().slice(0, 128);
  if (!vcenterId || !agent) return res.status(400).json({ ok: false, reason: 'vcenterId 와 agent 가 필요합니다.' });
  const r = moveVcRangeManually(vcenterId, agent, { user: req.user?.username });
  if (!r.ok) return res.status(r.status || 400).json(r);
  invalidateScanDatacenters();
  try { rescheduleScanPoller(); } catch { /* */ }
  logAudit({ user: req.user?.username, action: 'IP 스캔 대역 옮기기', target: vcenterId, detail: `→ ${agent === LOCAL ? '이 포탈에서 직접' : agent} · 대역 ${r.moved}줄${r.enabledAgent ? ' · 그 에이전트 주기 스캔을 켰습니다' : ''}`, ip: req.ip || '' });
  recordScanLog({ event: 'settings', agent, user: req.user?.username, message: `vCenter 별 스캔 대역을 에이전트로 옮김 — ${vcenterId.slice(0, 120)} · ${r.moved}줄` });
  res.json({ ...r, ...migrationView() });
});
adminRouter.post('/ipam/scan/migration/remove', adminOnly, fleetOnly, (req, res) => {
  const vcenterId = String(req.body?.vcenterId || '').slice(0, 200);
  if (!vcenterId) return res.status(400).json({ ok: false, reason: 'vcenterId 가 필요합니다.' });
  const r = removeVcRangeManually(vcenterId, { user: req.user?.username });
  if (!r.ok) return res.status(r.status || 400).json(r);
  try { rescheduleScanPoller(); } catch { /* */ }
  logAudit({ user: req.user?.username, action: 'IP 스캔 대역 지우기', target: vcenterId, detail: '옮기지 못한 vCenter 별 스캔 대역을 지웠습니다', ip: req.ip || '' });
  recordScanLog({ event: 'settings', user: req.user?.username, message: `옮기지 못한 vCenter 별 스캔 대역 삭제 — ${vcenterId.slice(0, 120)}` });
  res.json({ ...r, ...migrationView() });
});
adminRouter.post('/ipam/scan/migration/dismiss', adminOnly, fleetOnly, (_req, res) => {
  const r = dismissMigration();
  res.status(r.ok ? 200 : 404).json({ ...r, ...migrationView() });
});
// v2.636: 스캔 실행 로그(시작·종료·실패·건너뜀·엣지 보고·설정 변경) — 형제 status 와 같은 게이트(전 엣지 이름·대역이 들어간다).
adminRouter.get('/ipam/scan/log', adminOnly, fleetOnly, (req, res) => {
  res.json({ ok: true, ...listScanLog({ limit: req.query.limit, agent: req.query.agent, level: req.query.level, event: req.query.event }), events: SCAN_LOG_EVENTS });
});
adminRouter.post('/ipam/scan/run', adminOnly, fleetOnly, (_req, res) => {
  const r = startScan({ manual: true }); // 비동기 시작 — 즉시 반환(백그라운드 실행, 창 닫아도 지속)
  res.json({ ...r, status: scanStatus(), info: scanInfo() });
});
// 진행 중 스캔 상태 + 완료된 스캔 이력(가벼운 폴링용).
adminRouter.get('/ipam/scan/status', adminOnly, fleetOnly, (_req, res) => { // v2.611 LEFT2611-07
  res.json({ status: scanStatus(), info: scanInfo(), runs: getScanRuns(50), reports: getAgentReports() });
});
adminRouter.get('/ipam/scan/results', adminOnly, fleetOnly, (_req, res) => {
  res.json({ results: scanResultList().slice(0, 5000), info: scanInfo() });
});

/* ── v2.636: 에이전트별 IP 스캔 대역 CSV(IP관리 › CSV 가져오기·내보내기) ─────────────────────────────────
 * 형제 스캔 설정 라우트와 같은 게이트(adminOnly + fleetOnly — 전 엣지 이름·대역이 들어간다). 가져오기는 dryRun → 적용
 * 2단계이고, 교체 모드는 **파일에 나온 에이전트만** 바꾼다. 오류 줄이 있는 에이전트는 통째로 적용하지 않는다(scanRangesCsv). */
function scanRangesCurrent() {
  const m = new Map();
  for (const a of listScanAgents()) m.set(String(a.name).toLowerCase(), { name: a.name, ranges: a.ranges || [] });
  if (!m.has(LOCAL_AGENT)) m.set(LOCAL_AGENT, { name: LOCAL_AGENT, ranges: loadScanSettings(LOCAL).ranges || [] });
  return m;
}
adminRouter.get('/ipam/scan/ranges.csv', csvPerm, adminOnly, fleetOnly, (_req, res) => {
  const agents = [...scanRangesCurrent().values()].sort((a, b) => (a.name === LOCAL_AGENT ? -1 : b.name === LOCAL_AGENT ? 1 : a.name.localeCompare(b.name)));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="ip-scan-ranges-${todayStamp()}.csv"`);
  res.send(scanRangesToCsv(agents));
});
adminRouter.get('/ipam/scan/ranges/sample.csv', csvPerm, adminOnly, fleetOnly, (_req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="ip-scan-ranges-sample.csv"');
  res.send(scanRangesSampleCsv());
});
adminRouter.post('/ipam/scan/ranges/import', csvPerm, adminOnly, fleetOnly, (req, res) => {
  const { rows, error } = parseScanRangesCsv(String(req.body?.csv || ''));
  if (error) return res.status(400).json({ ok: false, reason: error });
  if (!rows.length) return res.status(400).json({ ok: false, reason: '가져올 데이터 행이 없습니다.' });
  const mode = req.body?.mode === 'add' ? 'add' : 'replace';
  const { report, summary, plans } = analyzeScanRangesImport(rows, { mode, current: scanRangesCurrent(), rangeCap: RANGE_CAP });
  const changing = plans.filter((p) => !p.blocked && (p.added.length || p.removed.length));
  if (req.body?.dryRun) return res.json({ ok: true, dryRun: true, mode, report, summary, plans, total: rows.length });
  const applied = []; const failed = [];
  for (const p of changing) {
    try { saveScanSettings(p.key, { ranges: p.after }); applied.push({ agent: p.agent, added: p.added.length, removed: p.removed.length, total: p.after.length }); }
    catch (e) { failed.push({ agent: p.agent, reason: String(e?.message || e).slice(0, 200) }); }
  }
  if (applied.some((a) => a.agent === LOCAL_AGENT)) { try { rescheduleScanPoller(); } catch { /* */ } }
  const blocked = plans.filter((p) => p.blocked).map((p) => ({ agent: p.agent, reason: p.blocked }));
  if (applied.length) {
    const addN = applied.reduce((a, x) => a + x.added, 0); const rmN = applied.reduce((a, x) => a + x.removed, 0);
    logAudit({ user: req.user?.username, action: 'IP 스캔 대역 CSV 가져오기', detail: `${mode === 'add' ? '추가' : '교체'} · 에이전트 ${applied.length}곳 · 대역 +${addN} −${rmN} · 막힘 ${blocked.length}`, ip: req.ip || '' });
    recordScanLog({ event: 'settings', user: req.user?.username, message: `IP 스캔 대역 CSV 가져오기(${mode === 'add' ? '추가' : '교체'}) — 에이전트 ${applied.length}곳 · 대역 +${addN} −${rmN}${blocked.length ? ` · 오류로 적용 안 한 에이전트 ${blocked.length}곳` : ''}` });
  }
  res.json({ ok: true, mode, applied, blocked, failed, report, summary, total: rows.length });
});

// vCenter별 스캔 대역 저장/삭제 + 즉시 스캔(주기 스캔이 이 대역들을 함께 스캔).
adminRouter.put('/ipam/vc-ranges', adminOnly, (req, res) => {
  const b = req.body || {};
  if (!vcRangeWritable(req.user, b.vcenterId)) return res.status(404).json({ ok: false, reason: 'vCenter 를 찾을 수 없습니다.' }); // v2.607 AUTHZ2607-04
  // v2.637: 스캔이 읽지 못하는 줄(rangeSize 0 — 빈 마스크·/33·뒤집힌 범위·오타)을 저장하지 않는다. 예전에는 오류 없이 저장되고
  //   주기 스캔에서 조용히 0개로 버려졌다.
  let check = null;
  if (b.ranges !== undefined) {
    check = checkRangeList(Array.isArray(b.ranges) ? b.ranges : String(b.ranges ?? '').split(/[\n,]/), { reversed: 'error', scanCap: RANGE_CAP });
    if (check.invalid.length) return invalidReply(res, check.invalid.map((x) => ({ field: 'scanRanges', vcenterId: String(b.vcenterId || ''), ...x })));
  }
  const r = saveVcRanges(b.vcenterId, { ranges: b.ranges, enabled: b.enabled });
  if (r.ok && check?.warnings.length) r.warnings = check.warnings.slice(0, 50);
  if (r.ok) {
    try { rescheduleScanPoller(); } catch { /* */ }
    recordScanLog({ event: 'settings', user: req.user?.username, ranges: (r.ranges || []).length, rangesSample: (r.ranges || []).slice(0, 5), message: `vCenter 스캔 대역 저장 — ${String(b.vcenterId || '').slice(0, 120)}` });
  }
  res.status(r.ok ? 200 : 400).json(r);
});
/**
 * v2.690: vCenter별 스캔 대역 편집기의 '/24 가져오기' — kind=idrac(그 vCenter 의 DataCenter 또는 고른 DataCenter 의 iDRAC 스캔 대역)
 * · kind=vm(그 vCenter VM 의 IPv4). 스냅샷·설정 파일만 읽는다(장비 왕복 0). 텍스트 박스와의 중복 판정은 웹이 한다(저장 안 한 입력 기준).
 *  · vCenter 는 조회 범위 안이어야 한다(밖이면 404 — 존재 은닉).
 *  · iDRAC 스캔 대역은 전 법인 설정이라 지금도 전체 범위 계정만 읽는다(GET /admin/idrac/scan-ranges 와 같은 기준) — 범위 계정은 403 + 사유.
 */
adminRouter.get('/ipam/vc-ranges/suggest', adminOnly, (req, res) => {
  const vcenterId = String(req.query.vcenterId || '').slice(0, 200);
  const kind = req.query.kind === 'idrac' ? 'idrac' : req.query.kind === 'vm' ? 'vm' : '';
  if (!kind) return res.status(400).json({ ok: false, reason: 'kind 는 idrac 또는 vm 입니다.' });
  const snap = store.get();
  const allowed = scopedVcenterIds(req.user, snap);
  const vc = (snap.vcenters || []).find((v) => v.id === vcenterId);
  let registered = false;
  try { registered = (loadVcenterConfig()?.vcenters || []).some((v) => v && v.id === vcenterId); } catch { registered = false; }
  if (!vcenterId || (allowed && !allowed.has(vcenterId)) || (!vc && !registered)) return res.status(404).json({ ok: false, reason: 'vCenter 를 찾을 수 없습니다.' });
  const base = { ok: true, kind, vcenterId, vcenterName: vc?.name || vcenterId, cap: SUBNET_MAX };
  if (kind === 'vm') {
    if (!vc) return res.json({ ...base, ...vmSubnets({ vms: [], vcenterId }), notInSnapshot: true }); // 등록됐지만 아직 수집 전
    return res.json({ ...base, ...vmSubnets({ vms: snap.vms, vcenterId }), initial: !!snap.initial });
  }
  if (allowed) return res.status(403).json({ ok: false, requiredFullScope: true, reason: 'iDRAC 스캔 대역은 전 법인 설정이라 전체 범위(vCenter 제한 없는) 계정만 읽을 수 있습니다 — VM 대역 가져오기는 쓸 수 있습니다.' });
  let datacenters = []; let datacentersError = '';
  try { datacenters = listDatacenters().map((d) => ({ id: d.id, name: d.name || d.id })); } catch (e) { datacentersError = e?.message || String(e); }
  let assigned = '';
  try { assigned = datacenterOfVcenter(vcenterId); } catch { assigned = ''; }
  const asked = String(req.query.datacenterId || '').slice(0, 200);
  const datacenterId = asked || assigned;
  const dc = datacenters.find((d) => d.id.toLowerCase() === datacenterId.toLowerCase());
  let entries = []; let rangesError = '';
  try { entries = listIdracScanRanges(); } catch (e) { rangesError = e?.message || String(e); }
  const r = datacenterId ? idracSubnets({ entries, datacenterId }) : { subnets: [], entries: [], invalid: [], omitted: 0 };
  res.json({
    ...base, ...r, datacenterId, datacenterName: dc?.name || datacenterId, assignedDatacenterId: assigned,
    datacenterSource: asked ? 'chosen' : assigned ? 'assigned' : 'none', datacenterMissing: !!datacenterId && !dc && !datacentersError,
    datacenters, ...(datacentersError ? { datacentersError } : {}), ...(rangesError ? { rangesError } : {}),
  });
});
adminRouter.delete('/ipam/vc-ranges/:vcenterId', adminOnly, (req, res) => {
  if (!vcRangeWritable(req.user, req.params.vcenterId)) return res.status(404).json({ ok: false, reason: 'vCenter 를 찾을 수 없습니다.' }); // v2.607 AUTHZ2607-04
  const r = removeVcRanges(req.params.vcenterId);
  if (r.ok) recordScanLog({ event: 'settings', user: req.user?.username, message: `vCenter 스캔 대역 삭제 — ${String(req.params.vcenterId || '').slice(0, 120)}` });
  res.status(r.ok ? 200 : 404).json(r);
});
adminRouter.post('/ipam/vc-ranges/scan', adminOnly, fleetOnly, (_req, res) => {
  const r = startScan({ manual: true });
  res.json({ ...r, status: scanStatus() });
});

/* ── 스캔 대역 CSV 일괄 관리 — iDRAC 스캔 대역 CSV(v2.339)와 동일 골격·공용 모달 계약.
 * 가져오기는 dryRun(vCenter 해석·대역 문법(rangeSize)·중복 검증) → 커밋 2단계이고,
 * 기존 vCenter 와 겹치는 행은 body.overwrite=true 명시 시에만 교체한다(대역 전체 교체 —
 * saveVcRanges 계약). 자격증명이 없는 데이터라 secrets 경로는 없다. */
adminRouter.get('/ipam/vc-ranges/sample.csv', csvPerm, adminOnly, (_req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="ipam-vc-ranges-sample.csv"');
  res.send(vcRangesSampleCsv());
});

adminRouter.post('/ipam/vc-ranges/import', csvPerm, adminOnly, (req, res) => {
  const { rows, error } = parseVcRangesCsv(String(req.body?.csv || ''));
  if (error) return res.status(400).json({ ok: false, reason: error });
  if (!rows.length) return res.status(400).json({ ok: false, reason: '가져올 데이터 행이 없습니다.' });

  // vCenter 이름/ID → ID(대소문자 무시). 못 찾으면 null → 오류 행(오타로 유령 vCenter 생성 방지).
  let vcs = [];
  try { vcs = loadVcenterConfig().vcenters || []; } catch { /* 목록 실패 시 resolve 전부 null → 전 행 오류 */ }
  // v2.611 LEFT2611-04: 범위 계정에는 쓰기 범위 밖 vCenter 를 '알 수 없는 vCenter' 와 **같은 결과**로 해석한다 —
  //   예전엔 dryRun 보고가 범위 밖 이름을 id·action 으로 풀어 줘 존재를 드러냈다(형제 PUT/DELETE 는 404 로 숨긴다).
  // v2.639: 해석기는 ipam/vcResolve.js 한 벌 — 이름이 겹치면 **null**(예전엔 첫 항목을 택해 오타 없이도 다른 vCenter 대역을 덮어썼다.
  //   manage CSV 의 해석기는 이미 모호하면 null 이었다 — 두 규칙을 하나로).
  const rv = makeVcResolver(vcs);
  const resolveVc = (v) => { const r = rv(v); return r.id && vcRangeWritable(req.user, r.id) ? r.id : null; };
  const existing = new Set(listVcRanges().map((e) => e.vcenterId));
  const { report, summary } = analyzeVcRangesImport(rows, { resolveVc, hasExisting: (id) => existing.has(id) });
  if (req.body?.dryRun) {
    // outOfScope 개수도 존재 단서라 싣지 않는다 — 범위 밖 행은 위 resolveVc 에서 이미 '알 수 없는 vCenter' 오류 행이다.
    return res.json({ ok: true, dryRun: true, report, summary, total: rows.length });
  }

  const allowOverwrite = req.body?.overwrite === true;
  let added = 0, overwritten = 0, outOfScope = 0; const failed = []; const skipped = [];
  const verdictByLine = new Map(report.map((r) => [r.line, r]));
  for (const row of rows) {
    const verdict = verdictByLine.get(row._line);
    if (verdict?.action === 'error') { failed.push({ line: verdict.line, vcenter: row.vcenter, reason: verdict.reason }); continue; }
    // v2.607 AUTHZ2607-04: 범위 계정은 자기 쓰기 범위 vCenter 행만 저장한다 — 나머지는 건너뛰고 개수를 밝힌다.
    if (!vcRangeWritable(req.user, verdict.vcId)) { outOfScope++; continue; }
    if (verdict.action === 'overwrite' && !allowOverwrite) { skipped.push({ line: row._line, vcenter: row.vcenter, reason: '기존 항목 — 덮어쓰기 미허용(overwrite 확인 필요)' }); continue; }
    const r = saveVcRanges(verdict.vcId, { ranges: row.ranges, enabled: row.enabled });
    if (r.ok) { if (verdict.action === 'overwrite') overwritten++; else added++; }
    else failed.push({ line: row._line, vcenter: row.vcenter, reason: r.reason });
  }
  if (added || overwritten) { try { rescheduleScanPoller(); } catch { /* */ } }
  logAudit({ user: req.user?.username, action: 'IPAM 스캔 대역 CSV 가져오기', detail: `추가 ${added}·덮어쓰기 ${overwritten}·건너뜀 ${skipped.length}·실패 ${failed.length}`, ip: req.ip || '' });
  if (added || overwritten) recordScanLog({ event: 'settings', user: req.user?.username, message: `vCenter 스캔 대역 CSV 가져오기 — 추가 ${added} · 덮어쓰기 ${overwritten} · 건너뜀 ${skipped.length} · 실패 ${failed.length}` });
  res.json({ ok: true, added, overwritten, skipped, failed, total: rows.length, ...(outOfScope ? { skippedOutOfScope: outOfScope, skippedOutOfScopeReason: '범위 밖(또는 조회 전용) vCenter 행은 저장하지 않았습니다.' } : {}) });
});
}
