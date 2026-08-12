// 중앙 토큰/에이전트 토큰·IPAM 설정/스캔/대역 — admin.js(구 2,410줄) 분할(v2.285.0). 본문은 원본 그대로, 등록 순서는 admin.js 호출 순서가 보존한다.
import { config } from '../../config.js';
import { ledgerInfo } from '../../ipam/db.js';
import { loadSettings as loadIpamSettings, saveSettings as saveIpamSettings } from '../../ipam/settings.js';
import { listTargets } from '../../agent/deployRegistry.js';
import { logAudit } from '../../audit.js';
import { loadScanSettings, saveScanSettings, scanResultList, scanInfo, listScanAgents, getAgentReports, getScanRuns, LOCAL } from '../../ipam/scanStore.js';
import { startScan, scanStatus, rescheduleScanPoller } from '../../ipam/scanPoller.js';
import { saveVcRanges, removeVcRanges } from '../../ipam/rangeStore.js';
import { listAssignments as listIdracAssignments, getResults as getAgentResults } from '../../central/assignments.js';
import { centralTokenInfo, generateCentralToken, setCentralToken } from '../../central/token.js';
import { listAgentTokens, issueAgentToken, revokeAgentToken } from '../../central/agentTokens.js';
import { getCentralAuthStats } from '../central.js';
import { listInventory } from '../../central/inventory.js';
import { getIngestStats, resetIngestStats } from '../../central/ingestStats.js';
import { listCollectors } from '../../collector/registry.js';
import { adminOnly } from './shared.js';

export function registerCentralIpam(adminRouter) {

// Shareable IP ledger DB location + record count (for other-program integration).
adminRouter.get('/ipam/db-info', adminOnly, async (_req, res) => {
  res.json(await ledgerInfo());
});

// IPMS settings: ignore IP ranges (global + per-vCenter) hidden from the ledger.
adminRouter.get('/ipam/settings', adminOnly, (_req, res) => res.json({ settings: loadIpamSettings() }));
adminRouter.put('/ipam/settings', adminOnly, (req, res) => res.json({ ok: true, settings: saveIpamSettings(req.body || {}) }));

// 중앙 토큰(CENTRAL_TOKEN) — 조회/생성/저장(실행중 서버 + portal.env 영속).
adminRouter.get('/central-token', adminOnly, (_req, res) => res.json(centralTokenInfo()));
// 사이트 위임 수집 현황(어떤 vCenter를 어떤 에이전트가 언제 push했는지).
adminRouter.get('/central/inventory', adminOnly, (_req, res) => res.json({ inventory: listInventory() }));
// 에이전트별 수신 트래픽 진단 — 누가 무엇을 얼마나 보내는지(와이어 바이트·push 빈도·페이로드 규모).
// iftop에서 특정 에이전트 트래픽이 비정상적으로 높을 때 원인(큰 페이로드 vs 잦은 push)을 짚어낸다.
adminRouter.get('/central/ingest-stats', adminOnly, (_req, res) => res.json({ ok: true, ...getIngestStats() }));
adminRouter.post('/central/ingest-stats/reset', adminOnly, (req, res) => { resetIngestStats(); logAudit({ user: req.user?.username, action: '수신 트래픽 통계 초기화', target: 'ingest-stats' }); res.json({ ok: true }); });
adminRouter.post('/central-token/generate', adminOnly, (req, res) => {
  const r = generateCentralToken({ force: !!(req.body && req.body.force) });
  res.json({ ok: true, ...r });
});
adminRouter.put('/central-token', adminOnly, (req, res) => {
  try { res.json({ ok: true, token: setCentralToken(req.body && req.body.token) }); }
  catch (e) { res.status(400).json({ ok: false, reason: e.message }); }
});

// ── 엣지별 개별 central 토큰 (공유 토큰의 광역 스코프 축소) ──────────────────
// 공유 CENTRAL_TOKEN 하나면 엣지 1대만 침해돼도 '남의 이름'으로 다른 사이트의 iDRAC 평문
// 비번·게스트 비번·사용자 해시를 전부 인출할 수 있다. 개별 토큰은 토큰↔agent를 바인딩해
// 자기 데이터만 보게 한다. 엣지는 이 값을 기존 CENTRAL_TOKEN(EDGE_TOKEN) 자리에 넣으면 되므로
// 엣지 코드 변경 없이 사이트별로 하나씩 이관할 수 있다.
adminRouter.get('/central/agent-tokens', adminOnly, (_req, res) => {
  res.json({ ok: true, tokens: listAgentTokens(), auth: getCentralAuthStats() });
});
adminRouter.post('/central/agent-tokens', adminOnly, (req, res) => {
  const r = issueAgentToken(req.body?.agent, { note: req.body?.note });
  if (r.ok) logAudit({ user: req.user?.username, action: '엣지 개별 central 토큰 발급', target: r.agent, detail: '기존 토큰이 있으면 회전(교체)', ip: req.ip || '' });
  // 평문 토큰은 이 응답에서만 확인 가능(서버는 해시만 저장) — 화면에서 복사해 엣지에 설정.
  res.status(r.ok ? 200 : 400).json(r);
});
adminRouter.delete('/central/agent-tokens/:agent', adminOnly, (req, res) => {
  const r = revokeAgentToken(req.params.agent);
  if (r.ok) logAudit({ user: req.user?.username, action: '엣지 개별 central 토큰 회수', target: req.params.agent, ip: req.ip || '' });
  res.status(r.ok ? 200 : 400).json(r);
});

// IP 능동 스캔(TCP 커넥트) — 에이전트별 설정/상태/수동실행/결과.
// agent 미지정 = 이 포탈(중앙) 직접 스캔(__local__). 그 외 이름 = 분산 에이전트 할당.
adminRouter.get('/ipam/scan/settings', adminOnly, (req, res) => {
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
adminRouter.put('/ipam/scan/settings', adminOnly, (req, res) => {
  const agent = (req.body && req.body.agent) || LOCAL;
  const settings = saveScanSettings(agent, req.body || {});
  if (agent === LOCAL) rescheduleScanPoller(); // 로컬 설정만 이 포탈 폴러에 적용
  res.json({ ok: true, agent, settings, status: scanStatus() });
});
adminRouter.post('/ipam/scan/run', adminOnly, (_req, res) => {
  const r = startScan({ manual: true }); // 비동기 시작 — 즉시 반환(백그라운드 실행, 창 닫아도 지속)
  res.json({ ...r, status: scanStatus(), info: scanInfo() });
});
// 진행 중 스캔 상태 + 완료된 스캔 이력(가벼운 폴링용).
adminRouter.get('/ipam/scan/status', adminOnly, (_req, res) => {
  res.json({ status: scanStatus(), info: scanInfo(), runs: getScanRuns(50), reports: getAgentReports() });
});
adminRouter.get('/ipam/scan/results', adminOnly, (_req, res) => {
  res.json({ results: scanResultList().slice(0, 5000), info: scanInfo() });
});

// vCenter별 스캔 대역 저장/삭제 + 즉시 스캔(주기 스캔이 이 대역들을 함께 스캔).
adminRouter.put('/ipam/vc-ranges', adminOnly, (req, res) => {
  const b = req.body || {};
  const r = saveVcRanges(b.vcenterId, { ranges: b.ranges, enabled: b.enabled });
  if (r.ok) { try { rescheduleScanPoller(); } catch { /* */ } }
  res.status(r.ok ? 200 : 400).json(r);
});
adminRouter.delete('/ipam/vc-ranges/:vcenterId', adminOnly, (req, res) => {
  const r = removeVcRanges(req.params.vcenterId);
  res.status(r.ok ? 200 : 404).json(r);
});
adminRouter.post('/ipam/vc-ranges/scan', adminOnly, (_req, res) => {
  const r = startScan({ manual: true });
  res.json({ ...r, status: scanStatus() });
});
}
