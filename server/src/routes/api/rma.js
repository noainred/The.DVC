/**
 * 원격 명령(RMA) 라우트(v2.416) — 특수기능 '원격 명령 실행(RMA)' 화면용.
 *
 * 접근 규약: 전부 admin 전용(원격 서버에서 명령을 실행하는 기능 — 조회도 admin) · 상태 변경 · 임의 실행 명령과 셸 점검 저장은
 * 설정 소유자 등급 + 본인 OTP(결정(56~75 남긴 것) — 아래 dangerRunGate · shellScheduleGate · 비밀번호 · 배포 · 인스턴스 제거). 상태변경
 * (실행·비밀번호·분배 설정·배포·제거)은 감사로그. 실행 요청은 프리셋 id + 파라미터만 받아
 * 카탈로그로 검증하고(commands.js), 엣지가 다시 검증한다.
 */
import { requireRole } from '../../auth/auth.js';
import { logAudit } from '../../audit.js';
import { catalog, buildCommand, describeCommand, getPreset, presetDanger } from '../../rma/commands.js';
import { enqueueJob, getJob, listHistoryAsync, listRmaAgents, DONE_TTL } from '../../rma/jobs.js';
import { signJob, scheduleSignRequired } from '../../rma/signing.js';
import { rmaPasswordFor, setRmaPassword, listRmaPasswordMeta } from '../../rma/agentSecrets.js';
import { getRmaSettings, setAgentMode, setDefaultMode, setAgentAccess, setAgentRemote, rmaSettingsWriteRefusal } from '../../rma/settings.js';
import { unreadMark } from '../settingsUnreadMark.js';   // 112회차: 조회 응답의 읽기 오류 표지
import { testCatalog, buildTest } from '../../rma/tests.js';
import { scheduleFor, listSchedules, upsertScheduleItem, removeScheduleItem, scheduleSignNote, rmaSchedulesLoadError } from '../../rma/schedules.js';
import { latestResults, testHistory, summarize, evaluateRmaItself, dropResult } from '../../rma/testResults.js';
import { credentialUsable } from '../../security/credentialStore.js';
import { deployRma, listRmaInstances, removeRmaInstance, deployInputIssue } from '../../rma/deploy.js';
import { ssrfBlockReason } from '../../collector/registry.js';
import { knownAgentNames } from '../../central/knownAgents.js';
import { listAgentTokens } from '../../central/agentTokens.js';
import { fullScopeOnlyWith, requireSettingsOwner } from '../admin/shared.js';
import { ownOtpGate } from './reauth.js';

const adminOnly = requireRole('admin');
// v2.612 AUTHZ2612-04: RMA 는 엣지 단위 원격 명령이라 법인 축이 없다 — 범위 제한 admin 도 403(edge-log 와 같은 기준).
const fullScopeOnly = fullScopeOnlyWith('원격 명령(RMA)은 엣지 단위라 법인 범위로 나눌 수 없어 전체 범위(vCenter 제한 없는) 계정만 쓸 수 있습니다.');
/*
 * 결정(56~75 남긴 것) — 원격 명령 등급: 상태를 바꾸거나 임의 실행인 동작은 **설정 소유자 등급 + 본인 OTP**(호스트 접근 적용과 같은 모양 —
 *   routes/admin/hostAccess.js). 판정은 카탈로그의 danger(서비스 제어 · 재부팅 · 종료 · RMA 재시작 · 자유 명령 · ssh-exec — 저장 계정 · 1회 입력 모두)
 *   하나이고, 점검 스케줄은 셸을 주기 실행하는 두 점검(script · ssh — 서명 대상과 같은 집합)을 저장할 때 같은 게이트를 건다
 *   (스케줄로 우회하면 실행 게이트가 뜻이 없다). 읽기 프리셋 · 다른 점검은 예전처럼 admin + 전체 범위. 소유자 등급을 먼저 본다 —
 *   권한 없는 요청이 OTP 를 소모하지 않게. 웹은 /auth/me settingsOwnerTier 로 버튼을 잠근다(서버가 다시 막는다).
 */
const rmaOwnOtp = ownOtpGate('원격 명령의 상태 변경 · 임의 실행');
const ownerOtpThen = (req, res, next) => requireSettingsOwner(req, res, (err) => (err ? next(err) : rmaOwnOtp(req, res, next)));
// 결정(반증 G1a): 인수에 따라 위험해지는 프리셋(http-request 의 POST · 본문)도 같은 판정 하나(commands.js presetDanger).
export const rmaRunNeedsOwnerOtp = (cmd, args = {}) => presetDanger(getPreset(cmd), args);
export const rmaScheduleNeedsOwnerOtp = (test) => scheduleSignRequired(test);
function dangerRunGate(req, res, next) { return rmaRunNeedsOwnerOtp(req.body?.cmd, req.body?.args) ? ownerOtpThen(req, res, next) : next(); }
function shellScheduleGate(req, res, next) { return rmaScheduleNeedsOwnerOtp(req.body?.test) ? ownerOtpThen(req, res, next) : next(); }
const RE_AGENT = /^[^<>"'\s]{1,64}$/;
const RE_INSTANCE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RE_HOST = /^[A-Za-z0-9][A-Za-z0-9._-]{0,253}$/;

export function registerRma(api) {

/** 화면 초기 데이터 — 인스턴스 그룹(하트비트) + 카탈로그 + 분배 설정 + 비밀번호 메타 + 토큰 발급 엣지. */
api.get('/tools/rma', adminOnly, fullScopeOnly, (_req, res) => {
  const tokens = new Set(listAgentTokens().map((t) => String(t.agent || t.name || t).toLowerCase()));
  const pwMeta = Object.fromEntries(listRmaPasswordMeta().map((m) => [m.agent, m]));
  const st = getRmaSettings();
  const extra = (name) => { const a = st.agents[String(name).toLowerCase()] || {}; return { allowedIps: a.allowedIps || [], comment: a.comment || '', remote: a.remote || null }; };
  // 결정(56~75) 64 F7: 스케줄 서명 상태(중앙 비밀번호 없음 + 엣지 RMA_PASSWORD → script · ssh 점검이 멈춘다)를 한 줄로.
  const signNote = (g, hasPassword) => scheduleSignNote({ tests: scheduleFor(g.agent).tests, hasPassword, instances: g.instances || [] });
  const agents = listRmaAgents().map((g) => { const hasPassword = !!pwMeta[g.agent.toLowerCase()]?.hasPassword; return { ...g, ...extra(g.agent), hasPassword, hasToken: tokens.has(g.agent.toLowerCase()), scheduleSignNote: signNote(g, hasPassword) }; });
  const seen = new Set(agents.map((a) => a.agent.toLowerCase()));
  // 하트비트가 없는(=RMA 미배포) 알려진 엣지도 보여 배포 대상을 고를 수 있게 한다.
  const known = knownAgentNames().filter((n) => !seen.has(String(n).toLowerCase())).map((n) => ({ agent: n, instances: [], onlineCount: 0, pending: 0, lastSeen: null, ...extra(n), hasPassword: !!pwMeta[String(n).toLowerCase()]?.hasPassword, hasToken: tokens.has(String(n).toLowerCase()), notDeployed: true }));
  // 결정(56~75): ownerOtp — 이 명령 · 점검은 설정 소유자 등급 + 본인 OTP(화면이 OTP 칸을 열고 소유자 등급이 아니면 잠근다 — 판정은 서버 하나).
  res.json({ agents: [...agents, ...known], catalog: catalog().map((p) => ({ ...p, ownerOtp: rmaRunNeedsOwnerOtp(p.id) })),
    tests: testCatalog().map((t) => ({ ...t, ownerOtp: rmaScheduleNeedsOwnerOtp(t.id) })), settings: st, schedules: listSchedules(), doneTtlMs: DONE_TTL,
    // 112회차: 분배 · 접속 허용 설정을 못 읽은 동안 위 settings · 법인별 allowedIps · remote 는 저장된 값이 아니라 빈 값이다 — 화면이 그 빈 폼의 저장을 잠근다
    //   (다시 읽힌 뒤 빈 ‘접속 허용 IP’ 저장 = 그 법인의 허용 목록이 ‘제한 없음’ 으로 바뀐다).
    ...unreadMark(rmaSettingsWriteRefusal(), 'settingsLoadError') });
});

// ── 점검 스케줄(v2.418, HostMonitor 'Test by agent') ──
api.get('/tools/rma/agents/:agent/schedule', adminOnly, fullScopeOnly, (req, res) => {
  res.json({ ok: true, agent: req.params.agent, ...scheduleFor(String(req.params.agent || '')) });
});
api.put('/tools/rma/agents/:agent/schedule', adminOnly, fullScopeOnly, shellScheduleGate, (req, res) => {
  const agent = String(req.params.agent || '').trim();
  if (!RE_AGENT.test(agent)) return res.status(400).json({ ok: false, reason: 'agent 형식 오류' });
  try {
    if (String(req.body?.test) === 'ssh') {
      const use = credentialUsable(String(req.body?.args?.credentialId || ''), { agent, host: String(req.body?.args?.host || '') });
      if (!use.ok) return res.status(400).json({ ok: false, reason: use.reason });
    }
    const row = upsertScheduleItem(agent, req.body || {});
    logAudit({ user: req.user?.username, action: 'RMA 점검 스케줄 저장', target: agent, detail: `${row.test}${row.name ? `(${row.name})` : ''} ${row.intervalSec}s${row.instance ? ` @${row.instance}` : ''}${row.enabled ? '' : ' (비활성)'}`, ip: req.ip });
    res.json({ ok: true, item: row, ...scheduleFor(agent) });
  } catch (e) { res.status(e?.status === 409 ? 409 : 400).json({ ok: false, reason: e.message }); }   // 103회차 F16: 읽기 오류 중 저장은 409
});
api.delete('/tools/rma/agents/:agent/schedule/:id', adminOnly, fullScopeOnly, (req, res) => {
  const agent = String(req.params.agent || '').trim();
  // 105회차 A7(103 F16 덜 고침): 읽기 오류 동안 load() 는 빈 스케줄이라 삭제가 '없음' 으로 ok:false(200)를 돌려 사유가 보이지 않았다 — 저장과 같은 409.
  { const le = rmaSchedulesLoadError(); if (le?.readError) return res.status(409).json({ ok: false, code: 'settings-unreadable', readError: true, reason: String(le.reason || '').slice(0, 300) }); }
  const ok = removeScheduleItem(agent, String(req.params.id || ''));
  if (ok) { dropResult(agent, String(req.params.id)); logAudit({ user: req.user?.username, action: 'RMA 점검 스케줄 삭제', target: `${agent}/${req.params.id}`, ip: req.ip }); }
  res.json({ ok, ...scheduleFor(agent) });
});
/** 점검 미리 검증(형식) — 저장 전 화면에서. */
api.post('/tools/rma/tests/validate', adminOnly, fullScopeOnly, (req, res) => {
  const b = buildTest(req.body?.test, req.body?.args || {});
  res.json(b.ok ? { ok: true, args: b.args } : { ok: false, reason: b.issue });
});
/** 최신 점검 상태 — 'rma-itself' 는 여기서 하트비트로 판정. */
api.get('/tools/rma/tests/results', adminOnly, fullScopeOnly, async (req, res) => {
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
api.get('/tools/rma/tests/history', adminOnly, fullScopeOnly, async (req, res) => {
  res.json({ ok: true, ...(await testHistory(String(req.query.agent || ''), String(req.query.id || ''), { hours: Number(req.query.hours) || 24, limit: Number(req.query.limit) || 500 })) });
});

/** 접속 허용 IP·코멘트 / 원격 관리 설정(v2.418). */
api.put('/tools/rma/agents/:agent/access', adminOnly, fullScopeOnly, (req, res) => {
  const agent = String(req.params.agent || '').trim();
  if (!RE_AGENT.test(agent)) return res.status(400).json({ ok: false, reason: 'agent 형식 오류' });
  try {
    { const no = rmaSettingsWriteRefusal(); if (no) return res.status(503).json(no); }   // 107회차: 설정 파일 읽기 오류 중에는 저장하지 않는다(사유를 화면까지)
    const r = setAgentAccess(agent, { allowedIps: req.body?.allowedIps ?? [], comment: req.body?.comment ?? '' });
    logAudit({ user: req.user?.username, action: 'RMA 접속 허용 IP 설정', target: agent, detail: r.allowedIps.join(',') || '(제한 없음)', ip: req.ip });
    res.json({ ok: true, ...r });
  } catch (e) { res.status(400).json({ ok: false, reason: e.message }); }
});
api.put('/tools/rma/agents/:agent/remote', adminOnly, fullScopeOnly, (req, res) => {
  const agent = String(req.params.agent || '').trim();
  if (!RE_AGENT.test(agent)) return res.status(400).json({ ok: false, reason: 'agent 형식 오류' });
  try {
    { const no = rmaSettingsWriteRefusal(); if (no) return res.status(503).json(no); }   // 107회차: 설정 파일 읽기 오류 중에는 저장하지 않는다(사유를 화면까지)
    const r = setAgentRemote(agent, req.body || {});
    logAudit({ user: req.user?.username, action: 'RMA 원격 관리 설정', target: agent, detail: JSON.stringify(r), ip: req.ip });
    res.json({ ok: true, ...r });
  } catch (e) { res.status(400).json({ ok: false, reason: e.message }); }
});

/** 명령 실행 요청 — Body { agent, instance?, cmd, args?, timeoutMs? } → { reqId, target }. */
api.post('/tools/rma/run', adminOnly, fullScopeOnly, dangerRunGate, (req, res) => {
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
  // SSH 원격 실행(v2.419): 저장된 계정이면 중앙에서 법인/대상 범위를 먼저 검사(비밀은 안 실음 — 엣지가 브로커로
  // 받는다). 1회 입력 계정이면 spec.secret 에 실어 보내고 인출 즉시 중앙에서 삭제(jobs.takeJobs). 감사·이력에는 없다.
  if (built.preset === 'ssh-exec') {
    if (built.args.credentialId) {
      const use = credentialUsable(built.args.credentialId, { agent, host: built.args.host });
      if (!use.ok) return res.status(400).json({ ok: false, reason: use.reason });
      spec.args = { ...spec.args, username: use.username };
    } else {
      const u = String(b.secret?.username || built.args.username || '').trim(), p = String(b.secret?.password || '');
      if (!/^[A-Za-z0-9._@\\-]{1,64}$/.test(u) || !p) return res.status(400).json({ ok: false, reason: '저장된 계정을 고르거나 1회 입력 계정(ID/비밀번호)을 입력하세요.' });
      if (/[\x00-\x1f\x7f]/.test(p)) return res.status(400).json({ ok: false, reason: '비밀번호에 제어문자가 있습니다.' }); // eslint-disable-line no-control-regex
      spec.args = { ...spec.args, username: u };
      spec.secret = { username: u, password: p };
    }
  }
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

api.get('/tools/rma/jobs/:reqId', adminOnly, fullScopeOnly, (req, res) => {
  res.json(getJob(String(req.params.reqId || '')));
});

api.get('/tools/rma/history', adminOnly, fullScopeOnly, async (req, res) => {
  res.json({ rows: await listHistoryAsync({ agent: String(req.query.agent || ''), limit: Number(req.query.limit) || 100 }) });
});

/** 법인 RMA 비밀번호 등록/해제 — Body { password } ('' = 해제). 값은 응답·감사로그에 싣지 않는다. */
// 결정(반증 G1a — 사용자 '권장안대로'): 법인 RMA 비밀번호 설정 · 해제는 서명(엣지 방어선)을 바꾸는 동작 — 소유자 등급 + 본인 OTP.
api.put('/tools/rma/agents/:agent/password', adminOnly, fullScopeOnly, ownerOtpThen, (req, res) => {
  const agent = String(req.params.agent || '').trim();
  if (!RE_AGENT.test(agent)) return res.status(400).json({ ok: false, reason: 'agent 형식 오류' });
  try {
    const r = setRmaPassword(agent, req.body?.password ?? '');
    logAudit({ user: req.user?.username, action: r.hasPassword ? 'RMA 비밀번호 설정' : 'RMA 비밀번호 해제', target: agent, ip: req.ip });
    res.json({ ok: true, ...r });
  } catch (e) { res.status(e?.status === 409 ? 409 : 400).json({ ok: false, reason: e.message, ...(e?.code ? { code: e.code } : {}) }); }   // 97회차 F2: 읽기 오류 409
});

/** 분배 설정 — Body { mode, primary } (법인) / PUT /settings { defaultMode } (전역). */
api.put('/tools/rma/agents/:agent/mode', adminOnly, fullScopeOnly, (req, res) => {
  const agent = String(req.params.agent || '').trim();
  if (!RE_AGENT.test(agent)) return res.status(400).json({ ok: false, reason: 'agent 형식 오류' });
  try {
    { const no = rmaSettingsWriteRefusal(); if (no) return res.status(503).json(no); }   // 107회차: 설정 파일 읽기 오류 중에는 저장하지 않는다(사유를 화면까지)
    const r = setAgentMode(agent, { mode: String(req.body?.mode || ''), primary: String(req.body?.primary || '') });
    logAudit({ user: req.user?.username, action: 'RMA 분배 설정', target: agent, detail: `${r.mode}${r.primary ? ` primary=${r.primary}` : ''}${r.explicit ? '' : ' (전역 기본)'}`, ip: req.ip });
    res.json({ ok: true, ...r });
  } catch (e) { res.status(400).json({ ok: false, reason: e.message }); }
});
api.put('/tools/rma/settings', adminOnly, fullScopeOnly, (req, res) => {
  try {
    { const no = rmaSettingsWriteRefusal(); if (no) return res.status(503).json(no); }   // 107회차: 설정 파일 읽기 오류 중에는 저장하지 않는다(사유를 화면까지)
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
api.post('/tools/rma/deploy/list', adminOnly, fullScopeOnly, async (req, res) => {
  const t = targetOf(req.body || {});
  if (t.error) return res.status(400).json({ ok: false, reason: t.error });
  res.json(await listRmaInstances(t));
});

/** 배포. Body: { host, port, username, password, instances:[{name,priority}], rmaPassword, allowCustom, agentName, centralUrl, centralToken } */
// 결정(반증 G1a): 원격 배포는 대상 서버에 root 로 설치하고 RMA_ALLOW_CUSTOM · 재부팅 허용 · 비밀번호 해제를 심을 수 있다 — 소유자 등급 + 본인 OTP.
api.post('/tools/rma/deploy', adminOnly, fullScopeOnly, ownerOtpThen, async (req, res) => {
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

/** 인스턴스 제거(SSH root — 유닛 중지 · 비활성 · env 삭제). Body: { host, port, username, password, name } */
// 결정(반증 G1a 남긴 것 — 사용자 '권장안대로'): 대상 서버에서 RMA 를 지우는 상태 변경이라 배포와 같은 소유자 등급 + 본인 OTP(조회 /deploy/list 는 그대로).
api.post('/tools/rma/deploy/remove', adminOnly, fullScopeOnly, ownerOtpThen, async (req, res) => {
  const b = req.body || {};
  const t = targetOf(b);
  if (t.error) return res.status(400).json({ ok: false, reason: t.error });
  const r = await removeRmaInstance(t, b.name);
  logAudit({ user: req.user?.username, action: 'RMA 인스턴스 제거', target: `${t.host}/${String(b.name || '')}`, detail: r.ok ? 'ok' : r.reason, ip: req.ip });
  res.json(r);
});

}
