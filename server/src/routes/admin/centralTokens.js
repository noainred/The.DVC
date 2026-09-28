// 중앙 토큰(CENTRAL_TOKEN)·엣지별 개별 토큰·위임 인벤토리 현황·수신 트래픽 통계 — centralIpam.js(v2.285 분할)에서 다시 분리(v2.639).
//   그 파일은 이름과 달리 IPAM 라우트와 이 10개(중앙 토큰 3·개별 토큰 3·인벤토리 2·수신 통계 2)를 함께 담고 있었다. 본문은 그대로
//   옮겼고 게이트도 바꾸지 않았다(경로 집합이 IPAM 과 겹치지 않아 등록 순서가 동작에 영향을 주지 않는다).
import { logAudit } from '../../audit.js';
import { centralTokenInfo, generateCentralToken, setCentralToken } from '../../central/token.js';
import { listAgentTokens, issueAgentToken, revokeAgentToken } from '../../central/agentTokens.js';
import { getCentralAuthStats } from '../central.js';
import { listInventory, setInventoryOwner } from '../../central/inventory.js';
import { getIngestStats, resetIngestStats } from '../../central/ingestStats.js';
import { adminOnly, requireSettingsOwner, fullScopeOnlyWith } from './shared.js';

// v2.607 AUTHZ2607-04·07: 위임 인벤토리 현황·소유 엣지·엣지 토큰 목록은 법인 축으로 나눌 수 없는 전 법인 공용 데이터라 범위 계정 403(v2.525 규약).
const fleetOnly = fullScopeOnlyWith('이 기능은 전 법인(엣지 전체)에 걸친 데이터·동작이라 전체 범위(vCenter 제한 없는) 계정만 쓸 수 있습니다.');

export function registerCentralTokens(adminRouter) {

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
// v2.612 AUTHZ2612-07: 엣지 수신 통계·엣지 토큰 목록은 전 법인 공용 — fleetOnly.
adminRouter.get('/central/ingest-stats', adminOnly, fleetOnly, (_req, res) => res.json({ ok: true, ...getIngestStats() }));
adminRouter.post('/central/ingest-stats/reset', adminOnly, fleetOnly, (req, res) => { resetIngestStats(); logAudit({ user: req.user?.username, action: '수신 트래픽 통계 초기화', target: 'ingest-stats' }); res.json({ ok: true }); });
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
adminRouter.get('/central/agent-tokens', adminOnly, fleetOnly, (_req, res) => {
  res.json({ ok: true, tokens: listAgentTokens(), auth: getCentralAuthStats() });
});
adminRouter.post('/central/agent-tokens', adminOnly, fleetOnly, requireSettingsOwner, (req, res) => { // v2.480(3차 감사 S3): 토큰 발급은 소유자 경계
  const r = issueAgentToken(req.body?.agent, { note: req.body?.note });
  if (r.ok) logAudit({ user: req.user?.username, action: '엣지 개별 central 토큰 발급', target: r.agent, detail: '기존 토큰이 있으면 회전(교체)', ip: req.ip || '' });
  // 평문 토큰은 이 응답에서만 확인 가능(서버는 해시만 저장) — 화면에서 복사해 엣지에 설정.
  res.status(r.ok ? 200 : 400).json(r);
});
adminRouter.delete('/central/agent-tokens/:agent', adminOnly, fleetOnly, requireSettingsOwner, (req, res) => {
  const r = revokeAgentToken(req.params.agent);
  if (r.ok) logAudit({ user: req.user?.username, action: '엣지 개별 central 토큰 회수', target: req.params.agent, ip: req.ip || '' });
  res.status(r.ok ? 200 : 400).json(r);
});

}
