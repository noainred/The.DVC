/**
 * routes/api/sshAccess.js — 설정 › 보안 › **서버 접속(SSH · Windows)** API(v3.9.0 SSH 공용 접속 · v3.24 계층 지정 · 공통 계정 — 설계 docs/design/ssh-access · server-access · 본체 `sshaccess/service.js`).
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
  api.post('/settings/ssh-access/reload-keystore', ...ownerWrite, (req, res) => {
    const r = SVC.reloadKeyStore({ by: who(req) });
    audit(req, 'ssh-access.keystore.reload', 'ssh-keys.json', { ok: !!r.ok, code: r.code, keys: r.keys });
    send(res, r);
  });

  /* ── 키 ─────────────────────────────────────────────────────────── */
  api.post('/settings/ssh-access/keys', ...keyAddWrite, (req, res) => {
    const b = bodyOf(req);
    const r = SVC.addKeyInFolder({ name: b.name, privateKey: typeof b.privateKey === 'string' ? b.privateKey : '', passphrase: typeof b.passphrase === 'string' ? b.passphrase : '',
      rotateAt: b.rotateAt, folderCorp: b.folderCorp, folderServer: b.folderServer, features: featuresOf(b.features) }, { by: who(req) });
    audit(req, 'ssh-access.key.add', b.name, r.ok ? { fingerprint: r.key.fingerprint, folderCorp: r.key.folderCorp, folderServer: r.key.folderServer, features: r.key.features, ok: true } : { ok: false, code: r.code });
    send(res, r);
  });

  api.put('/settings/ssh-access/keys/:id/placement', ...ownerWrite, (req, res) => {
    const b = bodyOf(req);
    const r = SVC.setKeyPlacement({ keyId: t(req.params.id, 32), ...(b.folderCorp !== undefined ? { folderCorp: t(b.folderCorp, 128) } : {}),
      ...(b.folderServer !== undefined ? { folderServer: t(b.folderServer, 128) } : {}), ...(b.features !== undefined ? { features: featuresOf(b.features) } : {}) });
    audit(req, 'ssh-access.key.placement', req.params.id, r.ok ? { folderCorp: r.key.folderCorp, folderServer: r.key.folderServer, features: r.key.features, ok: true } : { ok: false, code: r.code, conflicts: r.conflicts?.length || 0 });
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
  api.delete('/settings/ssh-access/corps/:corp/stop', ...ownerWrite, (req, res) => {
    const r = SVC.resumeCorp(t(req.params.corp, 128), { by: who(req) });
    audit(req, 'ssh-access.corp.resume', req.params.corp, { ok: !!r.ok, code: r.code });
    send(res, r);
  });

  /* ── 받는 곳(폴더에 직접 넣은 키) ───────────────────────────────── */
  api.post('/settings/ssh-access/inbox/approve', ...keyAddWrite, async (req, res) => {
    const b = bodyOf(req);
    const r = await SVC.approveInbox({ relPath: typeof b.relPath === 'string' ? b.relPath.slice(0, 400) : '', fingerprint: t(b.fingerprint, 80), sha: t(b.sha, 80), name: t(b.name, 80), passphrase: typeof b.passphrase === 'string' ? b.passphrase : '',
      features: featuresOf(b.features), by: who(req) });
    audit(req, 'ssh-access.inbox.approve', t(b.relPath, 128), r.ok ? { fingerprint: r.key.fingerprint, name: r.key.name, plaintextRemoved: r.plaintextRemoved, ok: true } : { ok: false, code: r.code });
    send(res, r);
  });
  api.post('/settings/ssh-access/inbox/discard', ...ownerWrite, (req, res) => {
    const b = bodyOf(req);
    const r = SVC.discardInbox({ relPath: typeof b.relPath === 'string' ? b.relPath.slice(0, 400) : '', sha: t(b.sha, 80), by: who(req) });
    audit(req, 'ssh-access.inbox.discard', t(b.relPath, 128), { ok: !!r.ok, code: r.code });
    send(res, r);
  });

  /* ── v3.24 서버 접속 — 계층 지정(법인 › OS 종류 › 서버) · 공통 계정(설계 docs/design/server-access) ─────────
   * 전부 저장 비밀(공통 계정)을 서버에 묶거나 그 비밀을 바꾸는 쓰기다 — 관리자 → 설정 소유자 등급 → 본인 OTP(마지막). 감사에는 이름 · id · code 만(비밀 없음).
   * 새 비밀번호를 받는 계정 저장은 저장 방식 검사를 OTP 앞에 둔다(평문 정책 409 가 1회 비밀번호를 먼저 쓰지 않게 — 키와 같은 규칙 B-5).
   */
  /**
   * v3.24 반증 F9: 판정 거절(없는 계정 · OS 불일치 · 확인 대상 고르기 · 이름 중복 · 도메인 꼴 …)은 **OTP 앞에서** 낸다(6회차 A2 — 1회 비밀번호를 먼저 쓰지 않게).
   *   서비스를 dryRun 으로 한 번 돌려(로그인 · 쓰기 없음) 거절이면 그대로 돌려주고, 통과면 OTP 뒤에서 같은 판정을 다시 한다(그 사이 바뀌었을 수 있다).
   */
  const judgeFirst = (fn) => async (req, res, next) => {
    try { const r = await fn(bodyOf(req), req); if (r && r.ok === false) return send(res, r); return next(); } catch (e) { return next(e); }
  };
  const assignArgs = (b) => ({ corp: t(b.corp, 128), level: t(b.level, 16), accountId: t(b.accountId, 32), auth: b.auth === 'password' ? 'password' : '', verifyServerId: t(b.verifyServerId, 64),
    via: b.via === 'winrm' ? 'winrm' : '', port: Number.isInteger(Number(b.port)) && Number(b.port) >= 1 && Number(b.port) <= 65535 ? Number(b.port) : null });   // v3.26 WinRM(Windows 단계만 — 서비스가 다시 본다)
  const inheritArgs = (b) => ({
    ids: Array.isArray(b.ids) ? b.ids.slice(0, 1000).map((x) => t(x, 64)) : [],
    expectAddrs: b.expectAddrs && typeof b.expectAddrs === 'object' && !Array.isArray(b.expectAddrs) ? Object.fromEntries(Object.entries(b.expectAddrs).slice(0, 1000).map(([k, v]) => [t(k, 64), typeof v === 'string' ? t(v, 400) : ''])) : {},
    expectKeys: b.expectKeys && typeof b.expectKeys === 'object' && !Array.isArray(b.expectKeys) ? Object.fromEntries(Object.entries(b.expectKeys).slice(0, 1000).map(([k, v]) => [t(k, 64), typeof v === 'string' ? t(v, 600) : ''])) : {},
    clearOwn: b.clearOwn === true, verifyServerId: t(b.verifyServerId, 64),
  });
  api.put('/settings/ssh-access/assign', adminOnly, requireSettingsOwner, judgeFirst((b) => SVC.setAssignment({ ...assignArgs(b), dryRun: true })), reauth, async (req, res) => {
    const b = bodyOf(req);
    const r = await SVC.setAssignment({ ...assignArgs(b), by: who(req) });
    audit(req, 'ssh-access.assign', `${t(b.corp, 80)}/${t(b.level, 16)}`, { accountId: t(b.accountId, 32) || 'clear', auth: b.auth === 'password' ? 'password' : 'key-first', ok: !!r.ok, code: r.code, affected: r.affected, verified: r.verified?.ok });
    send(res, r);
  });
  api.post('/settings/ssh-access/servers/inherit', adminOnly, requireSettingsOwner, judgeFirst((b) => SVC.approveInherit({ ...inheritArgs(b), dryRun: true })), reauth, async (req, res) => {
    const b = bodyOf(req);
    const a = inheritArgs(b);
    const ids = a.ids;
    const r = await SVC.approveInherit({ ...a, by: who(req) });
    audit(req, b.clearOwn === true ? 'ssh-access.server.inherit-reset' : 'ssh-access.server.inherit', `${ids.length}대`, { ok: !!r.ok, code: r.code, approved: r.approved, failed: r.failed?.length, verified: r.verified?.ok });
    send(res, r);
  });
  api.delete('/settings/ssh-access/servers/:id/inherit', ...ownerWrite, (req, res) => {
    const b = bodyOf(req);
    const r = SVC.revokeInherit({ serverId: t(req.params.id, 64), expectAddr: typeof b.expectAddr === 'string' ? t(b.expectAddr, 400) : (typeof req.query.expectAddr === 'string' ? t(req.query.expectAddr, 400) : null), by: who(req) });
    audit(req, 'ssh-access.server.inherit-revoke', req.params.id, { ok: !!r.ok, code: r.code });
    send(res, r);
  });
  api.post('/settings/ssh-access/servers/:id/account', ...ownerWrite, async (req, res) => {
    const b = bodyOf(req);
    const r = await SVC.chooseServerAccount({ serverId: t(req.params.id, 64), accountId: t(b.accountId, 32), expectAddr: typeof b.expectAddr === 'string' ? t(b.expectAddr, 400) : null, by: who(req) });
    audit(req, 'ssh-access.server.account', req.params.id, { accountId: t(b.accountId, 32), ok: !!r.ok, code: r.code, test: r.test?.kind, reverted: r.reverted, revertFailed: r.revertError ? true : undefined });
    send(res, r);
  });
  // 서버 OS 종류(여러 대 한 번에) — os: 'linux' | 'windows' | ''(미지정) | 'detected'(수집이 알아낸 값 — 비어 있는 서버만). OS 가 바뀌면 그 서버의 물려받기 승인은 효력을 잃는다.
  api.post('/settings/ssh-access/servers/os', ...ownerWrite, (req, res) => {
    const b = bodyOf(req);
    const ids = Array.isArray(b.ids) ? b.ids.slice(0, 1000).map((x) => t(x, 64)) : [];
    const r = SVC.setServersOs({ ids, os: t(b.os, 16) });
    audit(req, 'ssh-access.server.os', `${ids.length}대`, { os: t(b.os, 16) || 'none', ok: !!r.ok, code: r.code, changed: r.changed, inheritLost: r.inheritLost });
    send(res, r);
  });
  /** 새 비밀번호가 있으면 저장 방식 검사 → OTP(키와 같은 순서). 없으면 그냥 OTP. */
  const pwVaultFirst = (req, res, next) => {
    const pw = bodyOf(req).password;
    if (typeof pw === 'string' && pw !== '' && pw !== '********') { const v = SVC.keyVaultIssue(); if (v) return send(res, v.code === 'keys-need-encryption' ? { ...v, code: 'passwords-need-encryption', reason: '법인 공통 비밀번호는 자격증명 저장 방식이 ‘암호화’ 일 때만 받습니다 — 설정 › 보안 › 자격증명 저장 방식에서 암호화로 바꾼 뒤 다시 저장하세요.' } : v); }
    return next();
  };
  const accountInput = (b) => ({
    ...(b.id ? { id: t(b.id, 32) } : {}), name: b.name, kind: 'os', corp: b.corp, username: b.username,
    ...(b.os !== undefined ? { os: t(b.os, 16) } : {}), ...(b.logon !== undefined ? { logon: t(b.logon, 8) } : {}), ...(b.domain !== undefined ? { domain: t(b.domain, 253) } : {}),
    ...(b.keyRef !== undefined ? { keyRef: t(b.keyRef, 32) } : {}), ...(typeof b.password === 'string' ? { password: b.password } : {}), ...(b.clearPassword === true ? { clearPassword: true } : {}),
    ...(b.features !== undefined ? { features: featuresOf(b.features) } : {}), ...(b.rotateBy !== undefined ? { rotateBy: b.rotateBy === null || b.rotateBy === '' ? null : t(b.rotateBy, 16) } : {}),
  });
  api.post('/settings/ssh-access/accounts', adminOnly, requireSettingsOwner, pwVaultFirst,
    judgeFirst((b) => { const { otp, ...rest } = b; void otp; return SVC.saveAccountChecked({ input: accountInput(rest), verifyServerId: t(rest.verifyServerId, 64), dryRun: true }); }), reauth, async (req, res) => {
    const { otp, ...b } = bodyOf(req); void otp;
    const r = await SVC.saveAccountChecked({ input: accountInput(b), verifyServerId: t(b.verifyServerId, 64), by: who(req) });
    audit(req, b.id ? 'ssh-access.account.update' : 'ssh-access.account.add', t(b.name, 64), r.ok
      ? { ok: true, os: r.account.os || '', logon: r.account.logon || '', corp: r.account.corp, secretChanged: typeof b.password === 'string' && b.password !== '' && b.password !== '********', verified: r.verified?.ok, dropped: r.droppedSecrets || [] }
      : { ok: false, code: r.code });
    send(res, r);
  });
  api.post('/settings/ssh-access/accounts/:id/verify', ...ownerWrite, async (req, res) => {
    const b = bodyOf(req);
    const r = await SVC.verifyAccount({ accountId: t(req.params.id, 32), serverId: t(b.serverId, 64), by: who(req) });
    audit(req, 'ssh-access.account.verify', req.params.id, { ok: !!r.ok, code: r.code, kind: r.kind, resumed: r.resumed });
    send(res, r);
  });
  api.delete('/settings/ssh-access/accounts/:id/stop', ...ownerWrite, (req, res) => {
    const r = SVC.resumeAccount({ accountId: t(req.params.id, 32), by: who(req) });
    audit(req, 'ssh-access.account.resume', req.params.id, { ok: !!r.ok, code: r.code });
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
