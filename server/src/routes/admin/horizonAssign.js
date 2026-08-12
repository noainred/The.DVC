// Horizon 등록·svcmon 할당 — admin.js(구 2,410줄) 분할(v2.285.0). 본문은 원본 그대로, 등록 순서는 admin.js 호출 순서가 보존한다.
import { config } from '../../config.js';
import { listHorizon as listHorizonServers, upsertHorizon, removeHorizon, testHorizon } from '../../horizon/horizon.js';
import { logAudit } from '../../audit.js';
import { listCollectors } from '../../collector/registry.js';
import { listAssignments, addAssignment, updateAssignment, removeAssignment, getResults, parseCsv as parseAssignmentsCsv, importAssignments, mergeKnownAgents } from '../../central/assignments.js';
import { adminOnly } from './shared.js';

export function registerHorizonAssign(adminRouter) {

// ---- Horizon Connection Server (라이선스 만료일 확인용 등록) ---------------
adminRouter.get('/horizon', adminOnly, (_req, res) => res.json({ servers: listHorizonServers() }));
adminRouter.post('/horizon', adminOnly, (req, res) => {
  const r = upsertHorizon(req.body || {});
  if (r.ok) logAudit({ user: req.user?.username, action: 'Horizon 서버 등록/수정', target: String(req.body?.id || ''), ip: req.ip || '' });
  res.status(r.ok ? 200 : 400).json(r);
});
adminRouter.delete('/horizon/:id', adminOnly, (req, res) => {
  const r = removeHorizon(req.params.id);
  if (r.ok) logAudit({ user: req.user?.username, action: 'Horizon 서버 삭제', target: req.params.id, ip: req.ip || '' });
  res.status(r.ok ? 200 : 400).json(r);
});
adminRouter.post('/horizon/test', adminOnly, async (req, res) => res.json(await testHorizon(req.body || {})));

// ---- Agent scan assignments (central orchestration) -----------------------

// List per-agent IP assignments (credentials redacted) + each agent's last
// reported scan result.
adminRouter.get('/assignments', adminOnly, (_req, res) => {
  // knownAgents: 폼에서 '에이전트 이름'을 직접 타이핑하지 않고 목록에서 고르게 한다(AGENT_NAME
  // 오타로 인한 잡 인출 불일치 방지). 출처 = 등록된 수집 서버(원격, 실제 AGENT_NAME) + 중앙에
  // 한 번이라도 보고한 에이전트 + 기존 할당. mergeKnownAgents가 대소문자 무시 중복 제거.
  const knownAgents = mergeKnownAgents({ assignments: listAssignments(), results: getResults(), collectors: listCollectors() });
  res.json({ assignments: listAssignments(), results: getResults(), knownAgents, centralEnabled: Boolean(config.central.token) });
});

adminRouter.post('/assignments', adminOnly, (req, res) => {
  const result = addAssignment(req.body || {});
  res.status(result.ok ? 201 : 400).json(result);
});

adminRouter.put('/assignments/:agent', adminOnly, (req, res) => {
  const result = updateAssignment(req.params.agent, req.body || {});
  res.status(result.ok ? 200 : 400).json(result);
});

adminRouter.delete('/assignments/:agent', adminOnly, (req, res) => {
  const result = removeAssignment(req.params.agent);
  res.status(result.ok ? 200 : 404).json(result);
});

// Import assignments from CSV text or a JSON array. Body:
//   { csv:"...", mode? } | { assignments:[...], mode? } | bare array
adminRouter.post('/assignments/import', adminOnly, (req, res) => {
  const b = req.body || {};
  let list;
  if (typeof b.csv === 'string') list = parseAssignmentsCsv(b.csv);
  else list = Array.isArray(b) ? b : b.assignments;
  const result = importAssignments(list, b.mode === 'replace' ? 'replace' : 'merge');
  res.status(result.ok ? 200 : 400).json(result);
});
}
