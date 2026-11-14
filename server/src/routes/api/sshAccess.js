/**
 * routes/api/sshAccess.js — 설정 › 보안 › **SSH 공용 접속** API(v3.9.0 · 설계 docs/design/ssh-access · 본체 `sshaccess/service.js`).
 *
 * 권한(server/CLAUDE.md '7b SSH 키 저장소' 와 같은 등급 — 이 화면은 저장된 비밀을 다룬다):
 *  · 조회 · 서버에 들어 있는 키 읽기 · 연결 시험 · 지금 점검 = 관리자 + **설정 소유자 등급**(소유자 ∧ 전체 범위 — `requireSettingsOwner`).
 *    범위 계정은 403(이 화면은 전 법인 키 · 서버를 한 번에 보여 준다 — 행 단위 범위를 두지 않고 화면 전체를 소유자 등급으로 둔다).
 *  · 바꾸는 것(키 등록 · 폴더 · 허용 기능 · 서버의 키 고르기 · 받는 곳 승인/삭제 · 법인 사용 중지/재개 · 상태 파일 · 키 저장소 다시 읽기) = 위에 더해
 *    **본인 OTP**(`reauth` — 마지막 게이트: 권한이 없는 요청이 OTP 를 소모하지 않게) + 감사 로그(이름 · 지문 · code 만 — 비밀 미기재).
 *    키를 새로 받는 쓰기(키 등록 · 받는 곳 승인)는 저장 방식 검사를 OTP 앞에 둔다(평문 정책 409 가 1회 비밀번호를 먼저 쓰지 않게 — 점검 B-5).
 *  · 접속 자격 원본은 만지지 않는다 — 전부 service 를 거친다(소스 스윕 테스트).
 */
import { requireRole } from '../../auth/auth.js';
import { requireSettingsOwner } from '../admin/shared.js';
import { reauth } from './reauth.js';
import { logAudit, listAuditByActionPrefix } from '../../audit.js';
import * as SVC from '../../sshaccess/service.js';
import * as ST from '../../sshaccess/state.js';   // 사건 목록 조회만(쓰기는 전부 service — 법인 사용 중지도 service 가 서버 목록을 함께 적는다)

const adminOnly = requireRole('admin');
/** 조회 게이트 — 관리자 → 설정 소유자 등급. */
const ownerRead = [adminOnly, requireSettingsOwner];
/** 쓰기 게이트 — 순서가 뜻이다(관리자 → 소유자 등급 → OTP 마지막). */
const ownerWrite = [adminOnly, requireSettingsOwner, reauth];
/** 키를 새로 받는 쓰기 — 저장 방식 검사 → OTP. */
const vaultFirst = (_req, res, next) => { const v = SVC.keyVaultIssue(); if (v) return send(res, v); return next(); };
const keyAddWrite = [adminOnly, requireSettingsOwner, vaultFirst, reauth];

const t = (v, max = 256) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max).trim();
const bodyOf = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});
const who = (req) => req.user?.username || '';
const featuresOf = (v) => (v === null ? null : Array.isArray(v) ? v.map((x) => t(x, 32)) : undefined);

function send(res, r, okStatus = 200) {
  res.set('Cache-Control', 'no-store');
  if (r && r.ok) return res.status(okStatus).json(r);
  const status = Number(r?.status) || (r?.code === 'registry-unreadable' || r?.code === 'state-unreadable' || r?.code === 'SECRETS_POLICY_UNAVAILABLE' ? 503 : 400);
  const { status: _s, ...rest } = r || { ok: false, reason: '알 수 없는 오류' };
  void _s;
  return res.status(status).json({ ...rest, ok: false });
}
const audit = (req, action, target, detail) => logAudit({ user: who(req), action, target: t(target, 128), ip: req.ip || '', detail: JSON.stringify(detail).slice(0, 400) });

export function registerSshAccess(api) {
  api.get('/settings/ssh-access', ...ownerRead, async (_req, res) => {
    try { send(res, { ok: true, ...(await SVC.buildView()) }); } catch (e) { send(res, { ok: false, status: 500, reason: `화면 자료를 만들지 못했습니다(${String(e?.message || e).slice(0, 120)})` }); }
  });

  // 시작만 하고 바로 돌려준다(받는 곳 · 파일 대조가 길어도 요청을 붙잡지 않는다 — 점검 D-1). 결과는 화면을 다시 읽어 본다.
  api.post('/settings/ssh-access/scan', ...ownerRead, (_req, res) => {
    send(res, SVC.startSshAccessScanNow(), 202);
  });

  /* ── 손상 · 포탈 밖 변경 뒤 다시 읽기(사람이 파일을 확인한 뒤 — 재시작 없이) ─────────────── */
  api.post('/settings/ssh-access/reload-state', ...ownerWrite, (req, res) => {
    const r = SVC.reloadState({ by: who(req) });
    audit(req, 'ssh-access.state.reload', 'ssh-access-state.json', { ok: !!r.ok, code: r.code });
    send(res, r);
  });
  api.post('/settings/ssh-access/reload-keystore', ...ownerWrite, async (req, res) => {
    const r = await SVC.reloadKeyStore({ by: who(req) });
    audit(req, 'ssh-access.keystore.reload', 'ssh-keys.json', { ok: !!r.ok, code: r.code, keys: r.keys, pending: r.pending ? r.request.id : undefined });
    send(res, r, r.pending ? 202 : 200);
  });

  /* ── 키 ─────────────────────────────────────────────────────────── */
  api.post('/settings/ssh-access/keys', ...keyAddWrite, async (req, res) => {
    const b = bodyOf(req);
    const r = await SVC.addKeyInFolder({ name: b.name, privateKey: typeof b.privateKey === 'string' ? b.privateKey : '', passphrase: typeof b.passphrase === 'string' ? b.passphrase : '',
      rotateAt: b.rotateAt, folderCorp: b.folderCorp, folderServer: b.folderServer, features: featuresOf(b.features) }, { by: who(req) });
    audit(req, 'ssh-access.key.add', b.name, r.ok ? { fingerprint: r.key.fingerprint, folderCorp: r.key.folderCorp, folderServer: r.key.folderServer, features: r.key.features, ok: true, pending: r.pending ? r.request.id : undefined } : { ok: false, code: r.code });
    send(res, r, r.pending ? 202 : 200);
  });

  api.put('/settings/ssh-access/keys/:id/placement', ...ownerWrite, (req, res) => {
    const b = bodyOf(req);
    const r = SVC.setKeyPlacement({ keyId: t(req.params.id, 32), ...(b.folderCorp !== undefined ? { folderCorp: t(b.folderCorp, 128) } : {}),
      ...(b.folderServer !== undefined ? { folderServer: t(b.folderServer, 128) } : {}), ...(b.features !== undefined ? { features: featuresOf(b.features) } : {}) });
    audit(req, 'ssh-access.key.placement', req.params.id, r.ok ? { folderCorp: r.key.folderCorp, folderServer: r.key.folderServer, features: r.key.features, ok: true } : { ok: false, code: r.code, conflicts: r.conflicts?.length || 0 });
    send(res, r);
  });

  // 교체(회전) · 삭제 — 두 사람 승인이 켜져 있으면 요청만 만든다(202 · 다른 설정 소유자가 승인하면 실행).
  api.post('/settings/ssh-access/keys/rotate', ...ownerWrite, async (req, res) => {
    const b = bodyOf(req);
    const r = await SVC.rotateKeyReq({ from: t(b.from, 32), to: t(b.to, 32), by: who(req) });
    audit(req, 'ssh-access.key.rotate', `${t(b.from, 32)}>${t(b.to, 32)}`, { ok: !!r.ok, code: r.code, pending: r.pending ? r.request.id : undefined, servers: r.servers?.length, accounts: r.accounts });
    send(res, r, r.pending ? 202 : 200);
  });
  api.delete('/settings/ssh-access/keys/:id', ...ownerWrite, async (req, res) => {
    const r = await SVC.deleteKeyReq({ keyId: t(req.params.id, 32), by: who(req) });
    audit(req, 'ssh-access.key.delete', req.params.id, { ok: !!r.ok, code: r.code, pending: r.pending ? r.request.id : undefined });
    send(res, r, r.pending ? 202 : 200);
  });

  /* ── 두 사람 승인 · 보호 장치(v3.10.0) ─────────────────────────────── */
  // 사전 검사는 OTP 앞(자기 승인 · 지문 불일치 · 처리됨 · 기록 손상이 1회 비밀번호를 쓰지 않게 — 점검 A10).
  const approvePre = (approve) => (req, res, next) => { const b = bodyOf(req); const p = SVC.approvalPrecheck(t(req.params.id, 20), { approve, by: who(req), digest: t(b.digest, 64) }); return p ? send(res, p) : next(); };
  api.post('/settings/ssh-access/approvals/:id/approve', adminOnly, requireSettingsOwner, approvePre(true), reauth, async (req, res) => {
    const b = bodyOf(req);
    const r = await SVC.decideApproval(t(req.params.id, 20), { approve: true, by: who(req), digest: t(b.digest, 64), note: t(b.note, 300) });
    audit(req, 'ssh-access.approval.approve', req.params.id, { ok: !!r.ok, code: r.code, kind: r.request?.kind, target: t(r.request?.title, 120), requestedBy: r.request?.requestedBy });
    send(res, r);
  });
  api.post('/settings/ssh-access/approvals/:id/reject', adminOnly, requireSettingsOwner, approvePre(false), reauth, async (req, res) => {
    const b = bodyOf(req);
    const r = await SVC.decideApproval(t(req.params.id, 20), { approve: false, by: who(req), note: t(b.note, 300) });
    audit(req, 'ssh-access.approval.reject', req.params.id, { ok: !!r.ok, code: r.code, kind: r.request?.kind, target: t(r.request?.title, 120), status: r.request?.status });
    send(res, r);
  });
  api.put('/settings/ssh-access/guards', ...ownerWrite, async (req, res) => {
    const b = bodyOf(req);
    const patch = {};
    for (const k of ['twoPerson', 'serverRestrict']) if (typeof b[k] === 'boolean') patch[k] = b[k];
    const r = await SVC.changeGuards(patch, { by: who(req) });
    audit(req, 'ssh-access.guards', Object.keys(patch).join(','), { ok: !!r.ok, code: r.code, patch, pending: r.pending ? r.request.id : undefined });
    send(res, r, r.pending ? 202 : 200);
  });

  /* ── 키 로그인 설정 · 키 거두기(v3.10.0 — 서버의 authorized_keys 를 바꾸는 동작) ──── */
  const serverList = (v) => (Array.isArray(v) ? v.slice(0, 200).map((x) => ({ id: t(x?.id, 64), addr: typeof x?.addr === 'string' ? x.addr.slice(0, 400) : '' })) : null);
  const jobPre = (kind) => (_req, res, next) => { const p = SVC.keyJobPrecheck(kind); return p ? send(res, p) : next(); };
  api.post('/settings/ssh-access/key-login', adminOnly, requireSettingsOwner, jobPre('key-login'), reauth, async (req, res) => {
    const b = bodyOf(req);
    const once = typeof b.oncePassword === 'string' ? b.oncePassword : '';
    const r = await SVC.startKeyLogin({ servers: serverList(b.servers) || [], keyId: t(b.keyId, 32), oncePassword: once, removePassword: b.removePassword === true, replaceKeyId: t(b.replaceKeyId, 32), by: who(req) });
    audit(req, 'ssh-access.key-login.start', t(b.keyId, 32), { ok: !!r.ok, code: r.code, jobId: r.jobId, servers: r.total, oncePassword: !!once, removePassword: b.removePassword === true, replace: t(b.replaceKeyId, 32) || undefined });
    send(res, r, 202);
  });
  api.post('/settings/ssh-access/key-revoke', adminOnly, requireSettingsOwner, jobPre('key-revoke'), reauth, async (req, res) => {
    const b = bodyOf(req);
    const once = typeof b.oncePassword === 'string' ? b.oncePassword : '';
    const r = await SVC.startKeyRevoke({ keyId: t(b.keyId, 32), corp: t(b.corp, 128), servers: serverList(b.servers), oncePassword: once, by: who(req) });
    audit(req, 'ssh-access.key-revoke.start', t(b.keyId, 32), { ok: !!r.ok, code: r.code, jobId: r.jobId, servers: r.total, corp: t(b.corp, 128) || undefined, oncePassword: !!once, stopped: r.stopped || undefined, skipped: r.skipped?.length || undefined });
    send(res, r, 202);
  });
  api.get('/settings/ssh-access/jobs/:id', ...ownerRead, (req, res) => {
    const j = SVC.keyJob(t(req.params.id, 20));
    send(res, j ? { ok: true, job: j } : { ok: false, status: 404, code: 'not-found', reason: '작업을 찾을 수 없습니다(끝난 지 1시간이 지났거나 포탈이 다시 시작했습니다 — 다시 시작했으면 그때 처리 중이던 서버는 끝나지 않았을 수 있습니다).' });
  });
  // 멈추기 — 줄이는 방향(남은 서버를 하지 않는다)이라 OTP 없이 소유자 등급만. 지금 서버는 끝까지(되돌림을 끊지 않는다).
  api.post('/settings/ssh-access/jobs/:id/cancel', ...ownerRead, (req, res) => {
    const r = SVC.cancelKeyJob(t(req.params.id, 20), { by: who(req) });
    audit(req, 'ssh-access.key-job.cancel', req.params.id, { ok: !!r.ok, code: r.code });
    send(res, r);
  });

  /* ── 서버 ───────────────────────────────────────────────────────── */
  api.post('/settings/ssh-access/servers/:id/key', ...ownerWrite, async (req, res) => {
    const b = bodyOf(req);
    const r = await SVC.chooseServerKey({ serverId: t(req.params.id, 64), keyId: t(b.keyId, 32), expectAddr: typeof b.expectAddr === 'string' ? t(b.expectAddr, 400) : null, by: who(req) });
    audit(req, 'ssh-access.server.key', req.params.id, { keyId: t(b.keyId, 32) || 'corp-default', ok: !!r.ok, code: r.code, test: r.test?.kind, reverted: r.reverted, revertFailed: r.revertError ? true : undefined });
    send(res, r);
  });

  api.get('/settings/ssh-access/servers/:id/candidates', ...ownerRead, (req, res) => {
    send(res, SVC.serverKeyCandidates(t(req.params.id, 64)));
  });

  api.post('/settings/ssh-access/servers/:id/installed-keys', ...ownerRead, async (req, res) => {
    const b = bodyOf(req);
    const once = typeof b.oncePassword === 'string' ? b.oncePassword : '';
    const r = await SVC.readInstalledKeys({ serverId: t(req.params.id, 64), oncePassword: once, by: who(req) });
    audit(req, 'ssh-access.server.read-keys', req.params.id, { ok: !!r.ok, code: r.code, via: r.via, count: r.keys?.length, oncePassword: !!once });
    send(res, r);
  });

  api.post('/settings/ssh-access/servers/:id/test', ...ownerRead, async (req, res) => {
    const r = await SVC.testSavedServer({ serverId: t(req.params.id, 64), by: who(req) });
    audit(req, 'ssh-access.server.test', req.params.id, { ok: !!r.ok, kind: r.kind, authKind: r.authKind });
    send(res, r.ok || r.kind ? { ...r, ok: true, connected: !!r.ok } : r);
  });

  /* ── 법인 사용 중지(긴급 조치) ───────────────────────────────────── */
  api.post('/settings/ssh-access/corps/:corp/stop', ...ownerWrite, (req, res) => {
    const b = bodyOf(req);
    const r = SVC.stopCorp(t(req.params.corp, 128), { by: who(req), reason: t(b.reason, 300) });
    audit(req, 'ssh-access.corp.stop', req.params.corp, { ok: !!r.ok, code: r.code, reason: t(b.reason, 120), servers: r.servers });
    send(res, r);
  });
  api.delete('/settings/ssh-access/corps/:corp/stop', ...ownerWrite, async (req, res) => {
    const r = await SVC.resumeCorp(t(req.params.corp, 128), { by: who(req) });
    audit(req, 'ssh-access.corp.resume', req.params.corp, { ok: !!r.ok, code: r.code, pending: r.pending ? r.request.id : undefined });
    send(res, r, r.pending ? 202 : 200);
  });

  /* ── 받는 곳(폴더에 직접 넣은 키) ───────────────────────────────── */
  api.post('/settings/ssh-access/inbox/approve', ...keyAddWrite, async (req, res) => {
    const b = bodyOf(req);
    const r = await SVC.approveInbox({ relPath: typeof b.relPath === 'string' ? b.relPath.slice(0, 400) : '', fingerprint: t(b.fingerprint, 80), sha: t(b.sha, 80), name: t(b.name, 80), passphrase: typeof b.passphrase === 'string' ? b.passphrase : '',
      features: featuresOf(b.features), by: who(req) });
    audit(req, 'ssh-access.inbox.approve', t(b.relPath, 128), r.ok ? { fingerprint: r.key.fingerprint, name: r.key.name, plaintextRemoved: r.plaintextRemoved, ok: true, pending: r.pending ? r.request.id : undefined } : { ok: false, code: r.code });
    send(res, r, r.pending ? 202 : 200);
  });
  api.post('/settings/ssh-access/inbox/discard', ...ownerWrite, (req, res) => {
    const b = bodyOf(req);
    const r = SVC.discardInbox({ relPath: typeof b.relPath === 'string' ? b.relPath.slice(0, 400) : '', sha: t(b.sha, 80), by: who(req) });
    audit(req, 'ssh-access.inbox.discard', t(b.relPath, 128), { ok: !!r.ok, code: r.code });
    send(res, r);
  });

  /* ── 기록 ───────────────────────────────────────────────────────── */
  api.get('/settings/ssh-access/usage', ...ownerRead, (req, res) => {
    send(res, { ok: true, ...SVC.usageView({ fingerprint: t(req.query.fingerprint, 80), limit: Number(req.query.limit) || 200 }) });
  });
  api.get('/settings/ssh-access/changes', ...ownerRead, async (req, res) => {
    const items = await listAuditByActionPrefix(['ssh-access.', 'bm-usage.ssh-key.', 'bm-usage.account.'], { limit: Number(req.query.limit) || 200 });
    send(res, { ok: true, items, events: ST.listEvents({ limit: 100 }) });
  });
}
