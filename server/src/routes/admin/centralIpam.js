// 중앙 토큰/에이전트 토큰·IPAM 설정/스캔/대역 — admin.js(구 2,410줄) 분할(v2.285.0). 본문은 원본 그대로, 등록 순서는 admin.js 호출 순서가 보존한다.
import { config } from '../../config.js';
import { ledgerInfo } from '../../ipam/db.js';
import { loadSettings as loadIpamSettings, saveSettings as saveIpamSettings } from '../../ipam/settings.js';
import { listTargets } from '../../agent/deployRegistry.js';
import { logAudit } from '../../audit.js';
import { loadScanSettings, saveScanSettings, scanResultList, scanInfo, listScanAgents, getAgentReports, getScanRuns, LOCAL } from '../../ipam/scanStore.js';
import { startScan, scanStatus, rescheduleScanPoller } from '../../ipam/scanPoller.js';
import { saveVcRanges, removeVcRanges, listVcRanges } from '../../ipam/rangeStore.js';
import { sampleCsv as vcRangesSampleCsv, parseVcRangesCsv, analyzeVcRangesImport } from '../../ipam/vcRangesCsv.js';
import { loadVcenterConfig } from '../../config.js';
import { listAssignments as listIdracAssignments, getResults as getAgentResults } from '../../central/assignments.js';
import { centralTokenInfo, generateCentralToken, setCentralToken } from '../../central/token.js';
import { listAgentTokens, issueAgentToken, revokeAgentToken } from '../../central/agentTokens.js';
import { getCentralAuthStats } from '../central.js';
import { listInventory, setInventoryOwner } from '../../central/inventory.js';
import { getIngestStats, resetIngestStats } from '../../central/ingestStats.js';
import { listCollectors } from '../../collector/registry.js';
import { adminOnly, requireSettingsOwner, fullScopeOnlyWith } from './shared.js';
import { store } from '../../store.js';
import { scopedVcenterIds, writeScopedVcenterIds } from '../../auth/scope.js';
import { mergeScopedMap, filterScopedMap, keepScopedFields, ignoredGlobalFields } from '../../auth/scopeMerge.js';

// v2.607 AUTHZ2607-04·07: 위임 인벤토리 현황·소유 엣지·IP 스캔 결과·설정은 법인 축으로 나눌 수 없거나(엣지·스캔 대역 전체)
//   전 법인에 걸친 동작이라 범위 계정 403(v2.525 규약). vCenter별 스캔 대역은 쓰기 범위 밖이면 404(존재 은닉) —
//   GET(/tools/ipam/vc-ranges)은 범위로 거르는데 쓰기가 무스코프라 범위 admin 이 보이지 않는 법인 대역을 덮어쓰고 지웠다.
const fleetOnly = fullScopeOnlyWith('이 기능은 전 법인(엣지·스캔 전체)에 걸친 데이터·동작이라 전체 범위(vCenter 제한 없는) 계정만 쓸 수 있습니다.');
function vcRangeWritable(user, vcenterId) {
  const w = writeScopedVcenterIds(user, store.get());
  return !w || w.has(String(vcenterId || ''));
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
function ipamSettingsView(settings, allowed) {
  if (!allowed) return { settings };
  const all = Object.keys(settings.vcenters || {});
  const vcenters = filterScopedMap(settings.vcenters || {}, allowed);
  const omitted = all.length - Object.keys(vcenters).length;
  return { settings: { ...settings, vcenters }, ...(omitted ? { omittedOutOfScope: omitted } : {}) };
}
adminRouter.get('/ipam/settings', adminOnly, (req, res) => {
  res.json(ipamSettingsView(loadIpamSettings(), scopedVcenterIds(req.user, store.get())));
});
adminRouter.put('/ipam/settings', adminOnly, (req, res) => {
  const snap = store.get();
  const readAllowed = scopedVcenterIds(req.user, snap);
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  if (!readAllowed) return res.json({ ok: true, settings: saveIpamSettings(body) });
  const writeAllowed = writeScopedVcenterIds(req.user, snap) || readAllowed;
  const before = loadIpamSettings();
  const norm = (o) => ({ global: ipamList(o.global), publicRanges: ipamList(o.publicRanges), privateRanges: ipamList(o.privateRanges) });
  const { ignoredGlobal } = keepScopedFields({ ...body, ...norm(body) }, { ...before, ...norm(before) }, writeAllowed, ['vcenters']);
  const { merged, ignored } = mergeScopedMap(before.vcenters || {}, body.vcenters || {}, writeAllowed);
  const settings = saveIpamSettings({ global: before.global, publicRanges: before.publicRanges, privateRanges: before.privateRanges, vcenters: merged });
  res.json({ ok: true, ...ipamSettingsView(settings, readAllowed), ...(ignored.length ? { ignoredOutOfScope: ignored.length } : {}), ...ignoredGlobalFields(ignoredGlobal) });
});

// 중앙 토큰(CENTRAL_TOKEN) — 조회/생성/저장(실행중 서버 + portal.env 영속).
// ⚠ requireSettingsOwner(6차 재감사): centralTokenInfo() 는 토큰을 **평문으로** 반환한다.
// `EDGE_MODE=all` + CENTRAL_TOKEN 설정 + COLLECTOR_TOKEN 미설정 구성에서는
// EDGE_TOKEN = CENTRAL_TOKEN = collector.token 이므로(config.js), 이 응답이 그 인스턴스의
// COLLECTOR_TOKEN 노출과 같아져 /api/collector/* 시스템 경로를 직접 호출할 수 있다.
// 비밀 '열람'은 소유자 등급이 맞다(collectors export.csv?tokens=1 와 같은 기준).
// UI 는 설정 탭(App.jsx ownerOnly) 안의 AgentDeploy 에서만 쓰므로 화면 영향 없음.
adminRouter.get('/central-token', adminOnly, requireSettingsOwner, (_req, res) => res.json(centralTokenInfo()));
// 사이트 위임 수집 현황(어떤 vCenter를 어떤 에이전트가 언제 push했는지).
adminRouter.get('/central/inventory', adminOnly, fleetOnly, (_req, res) => res.json({ inventory: listInventory() }));
// v2.599(EDGE2599-03): 위임(site) vCenter 인벤토리 소유 엣지 해제/지정 — 담당 엣지를 교체하면 새 엣지 push 가 TOFU 소유권에
//   막혀 영구 403 이었다. 해제(agent 비움)하면 다음 개별 토큰 push 가 새 소유가 되고, 지정하면 그 엣지만 쓸 수 있다.
//   보안 경계(엣지가 남의 vCenter 를 가로채지 못함)는 그대로다 — 바꾸는 주체는 관리자이고 전부 감사 로그에 남는다.
// Body: { vcenterId, agent }  (agent 빈 값 = 해제)
adminRouter.post('/central/inventory/owner', adminOnly, fleetOnly, (req, res) => {
  const vcenterId = String(req.body?.vcenterId || '').trim();
  const agent = String(req.body?.agent ?? '').trim();
  if (!vcenterId || vcenterId.length > 128) return res.status(400).json({ ok: false, reason: 'vcenterId 가 필요합니다.' });
  if (agent && !/^[A-Za-z0-9._-]{1,64}$/.test(agent)) return res.status(400).json({ ok: false, reason: '엣지 이름 형식이 올바르지 않습니다(영숫자·._- 64자 이내).' });
  const r = setInventoryOwner(vcenterId, agent);
  if (!r.ok) return res.status(404).json({ ok: false, reason: `vcenterId '${vcenterId}' 의 위임 인벤토리가 없습니다 — 아직 아무 엣지도 push 하지 않았다면 첫 개별 토큰 push 가 소유가 됩니다.` });
  logAudit({ user: req.user?.username, action: agent ? '위임 인벤토리 소유 엣지 지정' : '위임 인벤토리 소유 엣지 해제', target: vcenterId, detail: `from=${r.from || '(없음)'} to=${r.to || '(해제 — 다음 개별 토큰 push 가 소유)'}`, ip: req.ip || '' });
  res.json({ ok: true, vcenterId, from: r.from, to: r.to, released: !agent });
});
// 에이전트별 수신 트래픽 진단 — 누가 무엇을 얼마나 보내는지(와이어 바이트·push 빈도·페이로드 규모).
// iftop에서 특정 에이전트 트래픽이 비정상적으로 높을 때 원인(큰 페이로드 vs 잦은 push)을 짚어낸다.
adminRouter.get('/central/ingest-stats', adminOnly, (_req, res) => res.json({ ok: true, ...getIngestStats() }));
adminRouter.post('/central/ingest-stats/reset', adminOnly, (req, res) => { resetIngestStats(); logAudit({ user: req.user?.username, action: '수신 트래픽 통계 초기화', target: 'ingest-stats' }); res.json({ ok: true }); });
// 생성·저장도 소유자 전용 — 둘 다 응답에 토큰 평문을 실으므로 조회와 같은 노출이고,
// 저장은 엣지 인증 비밀을 임의 값으로 바꾸는 권능이다.
adminRouter.post('/central-token/generate', adminOnly, requireSettingsOwner, (req, res) => {
  const r = generateCentralToken({ force: !!(req.body && req.body.force) });
  logAudit({ user: req.user?.username, action: '중앙 토큰 생성', target: 'central-token', ip: req.ip || '' });
  res.json({ ok: true, ...r });
});
adminRouter.put('/central-token', adminOnly, requireSettingsOwner, (req, res) => {
  try {
    const token = setCentralToken(req.body && req.body.token);
    logAudit({ user: req.user?.username, action: '중앙 토큰 변경', target: 'central-token', ip: req.ip || '' });
    res.json({ ok: true, token });
  } catch (e) { res.status(400).json({ ok: false, reason: e.message }); }
});

// ── 엣지별 개별 central 토큰 (공유 토큰의 광역 스코프 축소) ──────────────────
// 공유 CENTRAL_TOKEN 하나면 엣지 1대만 침해돼도 '남의 이름'으로 다른 사이트의 iDRAC 평문
// 비번·게스트 비번·사용자 해시를 전부 인출할 수 있다. 개별 토큰은 토큰↔agent를 바인딩해
// 자기 데이터만 보게 한다. 엣지는 이 값을 기존 CENTRAL_TOKEN(EDGE_TOKEN) 자리에 넣으면 되므로
// 엣지 코드 변경 없이 사이트별로 하나씩 이관할 수 있다.
adminRouter.get('/central/agent-tokens', adminOnly, (_req, res) => {
  res.json({ ok: true, tokens: listAgentTokens(), auth: getCentralAuthStats() });
});
adminRouter.post('/central/agent-tokens', adminOnly, requireSettingsOwner, (req, res) => { // v2.480(3차 감사 S3): 토큰 발급은 소유자 경계
  const r = issueAgentToken(req.body?.agent, { note: req.body?.note });
  if (r.ok) logAudit({ user: req.user?.username, action: '엣지 개별 central 토큰 발급', target: r.agent, detail: '기존 토큰이 있으면 회전(교체)', ip: req.ip || '' });
  // 평문 토큰은 이 응답에서만 확인 가능(서버는 해시만 저장) — 화면에서 복사해 엣지에 설정.
  res.status(r.ok ? 200 : 400).json(r);
});
adminRouter.delete('/central/agent-tokens/:agent', adminOnly, requireSettingsOwner, (req, res) => {
  const r = revokeAgentToken(req.params.agent);
  if (r.ok) logAudit({ user: req.user?.username, action: '엣지 개별 central 토큰 회수', target: req.params.agent, ip: req.ip || '' });
  res.status(r.ok ? 200 : 400).json(r);
});

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
  });
});
adminRouter.put('/ipam/scan/settings', adminOnly, fleetOnly, (req, res) => {
  const agent = (req.body && req.body.agent) || LOCAL;
  const settings = saveScanSettings(agent, req.body || {});
  if (agent === LOCAL) rescheduleScanPoller(); // 로컬 설정만 이 포탈 폴러에 적용
  res.json({ ok: true, agent, settings, status: scanStatus() });
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

// vCenter별 스캔 대역 저장/삭제 + 즉시 스캔(주기 스캔이 이 대역들을 함께 스캔).
adminRouter.put('/ipam/vc-ranges', adminOnly, (req, res) => {
  const b = req.body || {};
  if (!vcRangeWritable(req.user, b.vcenterId)) return res.status(404).json({ ok: false, reason: 'vCenter 를 찾을 수 없습니다.' }); // v2.607 AUTHZ2607-04
  const r = saveVcRanges(b.vcenterId, { ranges: b.ranges, enabled: b.enabled });
  if (r.ok) { try { rescheduleScanPoller(); } catch { /* */ } }
  res.status(r.ok ? 200 : 400).json(r);
});
adminRouter.delete('/ipam/vc-ranges/:vcenterId', adminOnly, (req, res) => {
  if (!vcRangeWritable(req.user, req.params.vcenterId)) return res.status(404).json({ ok: false, reason: 'vCenter 를 찾을 수 없습니다.' }); // v2.607 AUTHZ2607-04
  const r = removeVcRanges(req.params.vcenterId);
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
adminRouter.get('/ipam/vc-ranges/sample.csv', adminOnly, (_req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="ipam-vc-ranges-sample.csv"');
  res.send(vcRangesSampleCsv());
});

adminRouter.post('/ipam/vc-ranges/import', adminOnly, (req, res) => {
  const { rows, error } = parseVcRangesCsv(String(req.body?.csv || ''));
  if (error) return res.status(400).json({ ok: false, reason: error });
  if (!rows.length) return res.status(400).json({ ok: false, reason: '가져올 데이터 행이 없습니다.' });

  // vCenter 이름/ID → ID(대소문자 무시). 못 찾으면 null → 오류 행(오타로 유령 vCenter 생성 방지).
  let vcs = [];
  try { vcs = loadVcenterConfig().vcenters || []; } catch { /* 목록 실패 시 resolve 전부 null → 전 행 오류 */ }
  // v2.611 LEFT2611-04: 범위 계정에는 쓰기 범위 밖 vCenter 를 '알 수 없는 vCenter' 와 **같은 결과**로 해석한다 —
  //   예전엔 dryRun 보고가 범위 밖 이름을 id·action 으로 풀어 줘 존재를 드러냈다(형제 PUT/DELETE 는 404 로 숨긴다).
  const resolveVc = (v) => {
    const s = String(v || '').trim();
    if (!s) return null;
    let id = null;
    if (vcs.some((x) => x.id === s)) id = s;
    else { const byName = vcs.find((x) => String(x.name || '').toLowerCase() === s.toLowerCase()); id = byName ? byName.id : null; }
    return id && vcRangeWritable(req.user, id) ? id : null;
  };
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
  res.json({ ok: true, added, overwritten, skipped, failed, total: rows.length, ...(outOfScope ? { skippedOutOfScope: outOfScope, skippedOutOfScopeReason: '범위 밖(또는 조회 전용) vCenter 행은 저장하지 않았습니다.' } : {}) });
});
}
