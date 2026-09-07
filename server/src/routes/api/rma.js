/**
 * 원격 명령(RMA) 라우트(v2.416) — 특수기능 '원격 명령 실행(RMA)' 화면용.
 *
 * 접근 규약: 전부 admin 전용(원격 서버에서 명령을 실행하는 기능 — 조회도 admin). 상태변경
 * (실행·비밀번호·분배 설정·배포)은 감사로그. 실행 요청은 프리셋 id + 파라미터만 받아
 * 카탈로그로 검증하고(commands.js), 엣지가 다시 검증한다.
 */
import { requireRole } from '../../auth/auth.js';
import { logAudit } from '../../audit.js';
import { catalog, buildCommand, describeCommand, getPreset } from '../../rma/commands.js';
import { enqueueJob, getJob, listHistoryAsync, listRmaAgents, DONE_TTL } from '../../rma/jobs.js';
import { signJob } from '../../rma/signing.js';
import { rmaPasswordFor, setRmaPassword, listRmaPasswordMeta } from '../../rma/agentSecrets.js';
import { getRmaSettings, setAgentMode, setDefaultMode, setAgentAccess, setAgentRemote } from '../../rma/settings.js';
import { testCatalog, buildTest } from '../../rma/tests.js';
import { scheduleFor, listSchedules, upsertScheduleItem, removeScheduleItem } from '../../rma/schedules.js';
import { latestResults, testHistory, summarize, evaluateRmaItself, dropResult } from '../../rma/testResults.js';
import { deployRma, listRmaInstances, removeRmaInstance, deployInputIssue } from '../../rma/deploy.js';
import { ssrfBlockReason } from '../../collector/registry.js';
import { knownAgentNames } from '../../central/knownAgents.js';
import { listAgentTokens } from '../../central/agentTokens.js';

const adminOnly = requireRole('admin');
const RE_AGENT = /^[^<>"'\s]{1,64}$/;
const RE_INSTANCE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RE_HOST = /^[A-Za-z0-9][A-Za-z0-9._-]{0,253}$/;

export function registerRma(api) {

/** 화면 초기 데이터 — 인스턴스 그룹(하트비트) + 카탈로그 + 분배 설정 + 비밀번호 메타 + 토큰 발급 엣지. */
api.get('/tools/rma', adminOnly, (_req, res) => {
  const tokens = new Set(listAgentTokens().map((t) => String(t.agent || t.name || t).toLowerCase()));
  const pwMeta = Object.fromEntries(listRmaPasswordMeta().map((m) => [m.agent, m]));
  const st = getRmaSettings();
  const extra = (name) => { const a = st.agents[String(name).toLowerCase()] || {}; return { allowedIps: a.allowedIps || [], comment: a.comment || '', remote: a.remote || null }; };
  const agents = listRmaAgents().map((g) => ({ ...g, ...extra(g.agent), hasPassword: !!pwMeta[g.agent.toLowerCase()]?.hasPassword, hasToken: tokens.has(g.agent.toLowerCase()) }));
  const seen = new Set(agents.map((a) => a.agent.toLowerCase()));
  // 하트비트가 없는(=RMA 미배포) 알려진 엣지도 보여 배포 대상을 고를 수 있게 한다.
  const known = knownAgentNames().filter((n) => !seen.has(String(n).toLowerCase())).map((n) => ({ agent: n, instances: [], onlineCount: 0, pending: 0, lastSeen: null, ...extra(n), hasPassword: !!pwMeta[String(n).toLowerCase()]?.hasPassword, hasToken: tokens.has(String(n).toLowerCase()), notDeployed: true }));
  res.json({ agents: [...agents, ...known], catalog: catalog(), tests: testCatalog(), settings: st, schedules: listSchedules(), doneTtlMs: DONE_TTL });
});

// ── 점검 스케줄(v2.418, HostMonitor 'Test by agent') ──
api.get('/tools/rma/agents/:agent/schedule', adminOnly, (req, res) => {
  res.json({ ok: true, agent: req.params.agent, ...scheduleFor(String(req.params.agent || '')) });
});
api.put('/tools/rma/agents/:agent/schedule', adminOnly, (req, res) => {
  const agent = String(req.params.agent || '').trim();
  if (!RE_AGENT.test(agent)) return res.status(400).json({ ok: false, reason: 'agent 형식 오류' });
  try {
    const row = upsertScheduleItem(agent, req.body || {});
    logAudit({ user: req.user?.username, action: 'RMA 점검 스케줄 저장', target: agent, detail: `${row.test}${row.name ? `(${row.name})` : ''} ${row.intervalSec}s${row.instance ? ` @${row.instance}` : ''}${row.enabled ? '' : ' (비활성)'}`, ip: req.ip });
    res.json({ ok: true, item: row, ...scheduleFor(agent) });
  } catch (e) { res.status(400).json({ ok: false, reason: e.message }); }
});
api.delete('/tools/rma/agents/:agent/schedule/:id', adminOnly, (req, res) => {
  const agent = String(req.params.agent || '').trim();
  const ok = removeScheduleItem(agent, String(req.params.id || ''));
  if (ok) { dropResult(agent, String(req.params.id)); logAudit({ user: req.user?.username, action: 'RMA 점검 스케줄 삭제', target: `${agent}/${req.params.id}`, ip: req.ip }); }
  res.json({ ok, ...scheduleFor(agent) });
});
/** 점검 미리 검증(형식) — 저장 전 화면에서. */
api.post('/tools/rma/tests/validate', adminOnly, (req, res) => {
  const b = buildTest(req.body?.test, req.body?.args || {});
  res.json(b.ok ? { ok: true, args: b.args } : { ok: false, reason: b.issue });
});
/** 최신 점검 상태 — 'rma-itself' 는 여기서 하트비트로 판정. */
api.get('/tools/rma/tests/results', adminOnly, async (req, res) => {
  const agent = String(req.query.agent || '');
  const groups = listRmaAgents();
  for (const s of listSchedules()) {
    if (agent && s.agent.toLowerCase() !== agent.toLowerCase()) continue;
    const g = groups.find((x) => x.agent.toLowerCase() === s.agent);
    for (const t of scheduleFor(s.agent).tests) if (t.test === 'rma-itself' && t.enabled !== false) await evaluateRmaItself(s.agent, t.id, { online: g?.onlineCount || 0, total: g?.instances?.length || 0 });
  }
  const rows = latestResults({ agent });
  res.json({ ok: true, rows, summary: summarize(rows) });
});
api.get('/tools/rma/tests/history', adminOnly, async (req, res) => {
  res.json({ ok: true, ...(await testHistory(String(req.query.agent || ''), String(req.query.id || ''), { hours: Number(req.query.hours) || 24, limit: Number(req.query.limit) || 500 })) });
});

/** 접속 허용 IP·코멘트 / 원격 관리 설정(v2.418). */
api.put('/tools/rma/agents/:agent/access', adminOnly, (req, res) => {
  const agent = String(req.params.agent || '').trim();
  if (!RE_AGENT.test(agent)) return res.status(400).json({ ok: false, reason: 'agent 형식 오류' });
  try {
    const r = setAgentAccess(agent, { allowedIps: req.body?.allowedIps ?? [], comment: req.body?.comment ?? '' });
    logAudit({ user: req.user?.username, action: 'RMA 접속 허용 IP 설정', target: agent, detail: r.allowedIps.join(',') || '(제한 없음)', ip: req.ip });
    res.json({ ok: true, ...r });
  } catch (e) { res.status(400).json({ ok: false, reason: e.message }); }
});
api.put('/tools/rma/agents/:agent/remote', adminOnly, (req, res) => {
  const agent = String(req.params.agent || '').trim();
  if (!RE_AGENT.test(agent)) return res.status(400).json({ ok: false, reason: 'agent 형식 오류' });
  try {
    const r = setAgentRemote(agent, req.body || {});
    logAudit({ user: req.user?.username, action: 'RMA 원격 관리 설정', target: agent, detail: JSON.stringify(r), ip: req.ip });
    res.json({ ok: true, ...r });
  } catch (e) { res.status(400).json({ ok: false, reason: e.message }); }
});

/** 명령 실행 요청 — Body { agent, instance?, cmd, args?, timeoutMs? } → { reqId, target }. */
api.post('/tools/rma/run', adminOnly, (req, res) => {
  const b = req.body || {};
  const agent = String(b.agent || '').trim();
  if (!RE_AGENT.test(agent)) return res.status(400).json({ ok: false, reason: 'agent(법인/엣지 이름)가 필요합니다.' });
  const instance = String(b.instance || '').trim();
  if (instance && !RE_INSTANCE.test(instance)) return res.status(400).json({ ok: false, reason: '인스턴스 이름 형식 오류' });
  // 중앙 검증: 자유 명령은 엣지 정책이 최종이지만 여기서는 형식만 본다(allowCustom:true). 엣지가 거부하면 결과로 사유가 온다.
  const built = buildCommand(b.cmd, b.args || {}, { allowCustom: true, timeoutMs: b.timeoutMs });
  if (!built.ok) return res.status(400).json({ ok: false, reason: built.issue });
  const preset = getPreset(built.preset);
  const issuedAt = Date.now();
  const secret = rmaPasswordFor(agent);
  const spec = { cmd: built.preset, args: built.args, timeoutMs: built.timeoutMs, label: preset?.label || built.preset, issuedAt };
  let r;
  try {
    r = enqueueJob(agent, spec, {
      user: req.user?.username || '', timeoutMs: built.timeoutMs, instance,
      sign: secret ? (reqId) => signJob(secret, { reqId, agent, cmd: spec.cmd, args: spec.args, timeoutMs: spec.timeoutMs, issuedAt }) : null,
    });
  } catch (e) { return res.status(429).json({ ok: false, reason: e.message }); }
  logAudit({ user: req.user?.username, action: built.danger ? 'RMA 원격 명령 실행(위험)' : 'RMA 원격 명령 실행', target: `${agent}${instance ? `/${instance}` : r.target ? `→${r.target}` : ''}`, detail: `${describeCommand(built.preset, built.args)}${built.shell ? ` :: ${String(built.shell).slice(0, 200)}` : ''} (${r.reqId}${secret ? ', 서명' : ', 무서명'})`, ip: req.ip });
  res.json({ ok: true, reqId: r.reqId, target: r.target, signed: !!secret });
});

api.get('/tools/rma/jobs/:reqId', adminOnly, (req, res) => {
  res.json(getJob(String(req.params.reqId || '')));
});

api.get('/tools/rma/history', adminOnly, async (req, res) => {
  res.json({ rows: await listHistoryAsync({ agent: String(req.query.agent || ''), limit: Number(req.query.limit) || 100 }) });
});

/** 법인 RMA 비밀번호 등록/해제 — Body { password } ('' = 해제). 값은 응답·감사로그에 싣지 않는다. */
api.put('/tools/rma/agents/:agent/password', adminOnly, (req, res) => {
  const agent = String(req.params.agent || '').trim();
  if (!RE_AGENT.test(agent)) return res.status(400).json({ ok: false, reason: 'agent 형식 오류' });
  try {
    const r = setRmaPassword(agent, req.body?.password ?? '');
    logAudit({ user: req.user?.username, action: r.hasPassword ? 'RMA 비밀번호 설정' : 'RMA 비밀번호 해제', target: agent, ip: req.ip });
    res.json({ ok: true, ...r });
  } catch (e) { res.status(400).json({ ok: false, reason: e.message }); }
});

/** 분배 설정 — Body { mode, primary } (법인) / PUT /settings { defaultMode } (전역). */
api.put('/tools/rma/agents/:agent/mode', adminOnly, (req, res) => {
  const agent = String(req.params.agent || '').trim();
  if (!RE_AGENT.test(agent)) return res.status(400).json({ ok: false, reason: 'agent 형식 오류' });
  try {
    const r = setAgentMode(agent, { mode: String(req.body?.mode || ''), primary: String(req.body?.primary || '') });
    logAudit({ user: req.user?.username, action: 'RMA 분배 설정', target: agent, detail: `${r.mode}${r.primary ? ` primary=${r.primary}` : ''}${r.explicit ? '' : ' (전역 기본)'}`, ip: req.ip });
    res.json({ ok: true, ...r });
  } catch (e) { res.status(400).json({ ok: false, reason: e.message }); }
});
api.put('/tools/rma/settings', adminOnly, (req, res) => {
  try {
    const m = setDefaultMode(String(req.body?.defaultMode || ''));
    logAudit({ user: req.user?.username, action: 'RMA 전역 분배 설정', detail: m, ip: req.ip });
    res.json({ ok: true, defaultMode: m });
  } catch (e) { res.status(400).json({ ok: false, reason: e.message }); }
});

// ── 원격 배포(SSH root) ──
function targetOf(b) {
  const host = String(b.host || '').trim();
  if (!RE_HOST.test(host)) return { error: 'host 형식 오류' };
  const ssrf = ssrfBlockReason(`https://${host}`);
  if (ssrf) return { error: `host 차단: ${ssrf}` };
  const port = Number(b.port) || 22;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: 'SSH 포트 오류' };
  if (!String(b.username || '').trim()) return { error: 'SSH 계정을 입력하세요.' };
  return { host, port, username: String(b.username).trim(), password: String(b.password || ''), privateKey: b.privateKey ? String(b.privateKey) : undefined };
}

/** 서버의 RMA 인스턴스 조회(SSH). Body: { host, port, username, password } */
api.post('/tools/rma/deploy/list', adminOnly, async (req, res) => {
  const t = targetOf(req.body || {});
  if (t.error) return res.status(400).json({ ok: false, reason: t.error });
  res.json(await listRmaInstances(t));
});

/** 배포. Body: { host, port, username, password, instances:[{name,priority}], rmaPassword, allowCustom, agentName, centralUrl, centralToken } */
api.post('/tools/rma/deploy', adminOnly, async (req, res) => {
  const b = req.body || {};
  const t = targetOf(b);
  if (t.error) return res.status(400).json({ ok: false, reason: t.error });
  const opts = { instances: b.instances, password: b.rmaPassword, clearPassword: !!b.clearPassword, allowCustom: !!b.allowCustom, agentName: b.agentName, centralUrl: b.centralUrl, centralToken: b.centralToken,
    serviceUnits: b.serviceUnits, allowReboot: !!b.allowReboot, fileRoots: b.fileRoots, enabledCommands: b.enabledCommands, enabledTests: b.enabledTests, remoteManage: !!b.remoteManage, comment: b.comment };
  const issue = deployInputIssue(opts);
  if (issue) return res.status(400).json({ ok: false, reason: issue });
  const r = await deployRma(t, opts);
  logAudit({ user: req.user?.username, action: 'RMA 원격 배포', target: `${t.host}`, detail: `${(b.instances || []).map((i) => i.name).join(',')} ok=${r.ok}${r.reason ? ` ${r.reason}` : ''}`, ip: req.ip });
  // 배포한 비밀번호를 중앙에도 함께 등록(선택) — 같은 값을 두 번 입력하지 않게.
  if (r.ok && b.rmaPassword && b.agentName && b.registerPassword) {
    try { setRmaPassword(b.agentName, b.rmaPassword); } catch { /* 형식 오류는 위에서 이미 거름 */ }
  }
  res.json(r);
});

api.post('/tools/rma/deploy/remove', adminOnly, async (req, res) => {
  const b = req.body || {};
  const t = targetOf(b);
  if (t.error) return res.status(400).json({ ok: false, reason: t.error });
  const r = await removeRmaInstance(t, b.name);
  logAudit({ user: req.user?.username, action: 'RMA 인스턴스 제거', target: `${t.host}/${String(b.name || '')}`, detail: r.ok ? 'ok' : r.reason, ip: req.ip });
  res.json(r);
});

}
