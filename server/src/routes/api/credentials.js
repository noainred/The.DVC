/**
 * 통합 계정 관리 라우트(v2.419) — 특수기능 '통합 계정 관리' 화면.
 *
 * 접근 규약:
 *  - 조회(목록): admin. **비밀 값은 어떤 응답에도 없다**(hasPassword/hasKey/지문만).
 *  - 등록/수정/삭제: admin + **재인증** — 로컬 OTP 계정은 현재 OTP 코드(body.otp, 1회용·잠금 적용),
 *    OTP 가 없는 계정(AD 등)은 설정 소유자여야 한다. 전부 감사로그(비밀 미기재).
 *  - 연결 테스트: 저장된 계정으로 지정 법인 RMA 가 대상에 SSH `true` 를 실행(ssh-exec 잡) — 비밀은
 *    브로커 경로로만 흐른다.
 */
import { requireRole, verifyUserOtp, getUser } from '../../auth/auth.js';
import { logAudit } from '../../audit.js';
import { config } from '../../config.js';
import { loadSessionSecurity } from '../../security/securitySettings.js';
import { listCredentials, saveCredential, deleteCredential, getCredentialView, credentialUsable, KINDS, inspectPrivateKey } from '../../security/credentialStore.js';
import { knownAgentNames } from '../../central/knownAgents.js';
import { enqueueJob, listRmaAgents } from '../../rma/jobs.js';
import { buildCommand } from '../../rma/commands.js';
import { signJob } from '../../rma/signing.js';
import { rmaPasswordFor } from '../../rma/agentSecrets.js';

const adminOnly = requireRole('admin');

/** 재인증 게이트 — 로컬 OTP 계정: OTP 코드 검증(403 + needEnroll), 그 외: 설정 소유자만. */
function reauth(req, res, next) {
  if (!config.auth.enabled) return next();
  const username = req.user?.username || '';
  const u = getUser(username);
  if (u && u.totpEnabled) {
    const v = verifyUserOtp(username, req.body?.otp ?? req.query?.otp); // DELETE 는 본문이 없어 쿼리로
    if (!v.ok) return res.status(403).json({ ok: false, reason: v.reason, needOtp: true, needEnroll: !!v.needEnroll });
    return next();
  }
  let owners = [];
  try { owners = loadSessionSecurity().settingsOwners || []; } catch { owners = []; }
  if (owners.includes(username)) return next();
  return res.status(403).json({ ok: false, reason: 'OTP 가 없는 계정은 설정 소유자만 계정 정보를 변경할 수 있습니다(OTP 를 등록하면 본인 재인증으로 가능).' });
}

export function registerCredentials(api) {

api.get('/tools/credentials', adminOnly, (_req, res) => {
  res.json({ ok: true, items: listCredentials(), kinds: KINDS, agents: knownAgentNames(), rmaAgents: listRmaAgents().map((g) => ({ agent: g.agent, online: g.onlineCount > 0, allowSsh: (g.instances || []).some((i) => i.policy?.allowSsh) })) });
});

/** 개인키 사전 검증(저장 전) — 지문만 돌려주고 키는 저장하지 않는다. */
api.post('/tools/credentials/inspect-key', adminOnly, (req, res) => {
  const r = inspectPrivateKey(req.body?.privateKey || '', req.body?.passphrase || '');
  res.json(r.ok ? { ok: true, type: r.type, fingerprint: r.fingerprint, comment: r.comment } : { ok: false, reason: r.reason });
});

api.post('/tools/credentials', adminOnly, reauth, (req, res) => {
  try {
    const { otp, ...input } = req.body || {};
    void otp;
    const saved = saveCredential({ ...input, id: undefined }, { actor: req.user?.username || '' });
    logAudit({ user: req.user?.username, action: '통합 계정 등록', target: saved.name, detail: `${saved.kind}/${saved.username} 법인=${saved.agents.join(',')} 대상=${saved.hosts.join(',')}`, ip: req.ip });
    res.json({ ok: true, item: saved });
  } catch (e) { res.status(400).json({ ok: false, reason: e.message }); }
});

api.put('/tools/credentials/:id', adminOnly, reauth, (req, res) => {
  try {
    const { otp, ...input } = req.body || {};
    void otp;
    const saved = saveCredential({ ...input, id: String(req.params.id) }, { actor: req.user?.username || '' });
    logAudit({ user: req.user?.username, action: '통합 계정 수정', target: saved.name, detail: `${saved.kind}/${saved.username} 법인=${saved.agents.join(',')} 대상=${saved.hosts.join(',')}${input.password || input.privateKey ? ' (비밀 교체)' : ''}`, ip: req.ip });
    res.json({ ok: true, item: saved });
  } catch (e) { res.status(400).json({ ok: false, reason: e.message }); }
});

api.delete('/tools/credentials/:id', adminOnly, reauth, (req, res) => {
  const gone = deleteCredential(String(req.params.id));
  if (!gone) return res.status(404).json({ ok: false, reason: '계정을 찾을 수 없습니다.' });
  logAudit({ user: req.user?.username, action: '통합 계정 삭제', target: gone.name, detail: `${gone.kind}/${gone.username}`, ip: req.ip });
  res.json({ ok: true });
});

/** 연결 테스트 — Body { agent, host, port?, instance? } → RMA ssh-exec 'true' 잡 등록 → { reqId } (결과는 /tools/rma/jobs/:reqId). */
api.post('/tools/credentials/:id/test', adminOnly, (req, res) => {
  const id = String(req.params.id);
  const cv = getCredentialView(id);
  if (!cv) return res.status(404).json({ ok: false, reason: '계정을 찾을 수 없습니다.' });
  const b = req.body || {};
  const agent = String(b.agent || '').trim(), host = String(b.host || '').trim();
  const use = credentialUsable(id, { agent, host });
  if (!use.ok) return res.status(400).json({ ok: false, reason: use.reason });
  const built = buildCommand('ssh-exec', { host, port: b.port || 22, credentialId: id, command: 'echo RMA-CRED-OK; id -un; uname -n' }, { timeoutMs: 30_000 });
  if (!built.ok) return res.status(400).json({ ok: false, reason: built.issue });
  const issuedAt = Date.now(); const secret = rmaPasswordFor(agent);
  const spec = { cmd: 'ssh-exec', args: built.args, timeoutMs: built.timeoutMs, label: `계정 연결 테스트(${cv.name})`, issuedAt };
  let r;
  try {
    r = enqueueJob(agent, spec, { user: req.user?.username || '', timeoutMs: built.timeoutMs, instance: String(b.instance || ''), sign: secret ? (reqId) => signJob(secret, { reqId, agent, cmd: spec.cmd, args: spec.args, timeoutMs: spec.timeoutMs, issuedAt }) : null });
  } catch (e) { return res.status(429).json({ ok: false, reason: e.message }); }
  logAudit({ user: req.user?.username, action: '통합 계정 연결 테스트', target: cv.name, detail: `${agent} → ${host} (${r.reqId})`, ip: req.ip });
  res.json({ ok: true, reqId: r.reqId, target: r.target });
});

}
