/**
 * routes/api/sshAccess.js — 설정 › 보안 › **SSH 공용 접속** API(v3.9.0 · 설계 docs/design/ssh-access · 본체 `sshaccess/service.js`).
 *
 * 권한(server/CLAUDE.md '7b SSH 키 저장소' 와 같은 등급 — 이 화면은 저장된 비밀을 다룬다):
 *  · 조회 · 서버에 들어 있는 키 읽기 · 연결 시험 · 지금 점검 = 관리자 + **설정 소유자 등급**(소유자 ∧ 전체 범위 — `requireSettingsOwner`).
 *    범위 계정은 403(이 화면은 전 법인 키 · 서버를 한 번에 보여 준다 — 행 단위 범위를 두지 않고 화면 전체를 소유자 등급으로 둔다).
 *  · 바꾸는 것(키 등록 · 폴더 · 허용 기능 · 서버의 키 고르기 · 받는 곳 승인/삭제 · 법인 사용 중지/재개) = 위에 더해 **본인 OTP**(`reauth` — 마지막 게이트:
 *    권한이 없는 요청이 OTP 를 소모하지 않게) + 감사 로그(이름 · 지문 · code 만 — 비밀 미기재).
 *  · 접속 자격 원본은 만지지 않는다 — 전부 service 를 거친다(소스 스윕 테스트).
 */
import { requireRole } from '../../auth/auth.js';
import { requireSettingsOwner } from '../admin/shared.js';
import { reauth } from './reauth.js';
import { logAudit, listAuditByActionPrefix } from '../../audit.js';
import * as SVC from '../../sshaccess/service.js';
import * as ST from '../../sshaccess/state.js';

const adminOnly = requireRole('admin');
/** 조회 게이트 — 관리자 → 설정 소유자 등급. */
const ownerRead = [adminOnly, requireSettingsOwner];
/** 쓰기 게이트 — 순서가 뜻이다(관리자 → 소유자 등급 → OTP 마지막). */
const ownerWrite = [adminOnly, requireSettingsOwner, reauth];

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

  api.post('/settings/ssh-access/scan', ...ownerRead, async (_req, res) => {
    const r = await SVC.runSshAccessScan();
    send(res, r.skipped ? { ok: false, status: 409, code: 'busy', reason: '점검이 이미 진행 중입니다.' } : { ok: true, mismatch: r.integrity?.mismatch?.length || 0, inbox: r.inbox });
  });

  /* ── 키 ─────────────────────────────────────────────────────────── */
  api.post('/settings/ssh-access/keys', ...ownerWrite, (req, res) => {
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
    const r = await SVC.chooseServerKey({ serverId: t(req.params.id, 64), keyId: t(b.keyId, 32), expectHost: typeof b.expectHost === 'string' ? b.expectHost : null, by: who(req) });
    audit(req, 'ssh-access.server.key', req.params.id, { keyId: t(b.keyId, 32) || 'corp-default', ok: !!r.ok, code: r.code, test: r.test?.kind, reverted: r.reverted });
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
    const r = ST.setCorpStop(t(req.params.corp, 128), { by: who(req), reason: t(b.reason, 300) });
    audit(req, 'ssh-access.corp.stop', req.params.corp, { ok: !!r.ok, code: r.code, reason: t(b.reason, 120) });
    send(res, r);
  });
  api.delete('/settings/ssh-access/corps/:corp/stop', ...ownerWrite, (req, res) => {
    const r = ST.clearCorpStop(t(req.params.corp, 128), { by: who(req) });
    audit(req, 'ssh-access.corp.resume', req.params.corp, { ok: !!r.ok, code: r.code });
    send(res, r);
  });

  /* ── 받는 곳(폴더에 직접 넣은 키) ───────────────────────────────── */
  api.post('/settings/ssh-access/inbox/approve', ...ownerWrite, async (req, res) => {
    const b = bodyOf(req);
    const r = await SVC.approveInbox({ relPath: t(b.relPath, 400), fingerprint: t(b.fingerprint, 80), name: t(b.name, 80), passphrase: typeof b.passphrase === 'string' ? b.passphrase : '',
      features: featuresOf(b.features), by: who(req) });
    audit(req, 'ssh-access.inbox.approve', b.relPath, r.ok ? { fingerprint: r.key.fingerprint, name: r.key.name, plaintextRemoved: r.plaintextRemoved, ok: true } : { ok: false, code: r.code });
    send(res, r);
  });
  api.post('/settings/ssh-access/inbox/discard', ...ownerWrite, (req, res) => {
    const b = bodyOf(req);
    const r = SVC.discardInbox({ relPath: t(b.relPath, 400), by: who(req) });
    audit(req, 'ssh-access.inbox.discard', b.relPath, { ok: !!r.ok, code: r.code });
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
