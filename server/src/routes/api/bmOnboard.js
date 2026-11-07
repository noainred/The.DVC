/**
 * routes/api/bmOnboard.js — 리눅스 성능 7b단계: SSH 키 저장소 · 법인 공통 계정 · 서버 등록(CSV/Excel 온보딩) · 누락 점검 API.
 *
 * 권한(설계 §19 · server/CLAUDE.md '7b SSH 키 저장소'):
 *  · 키 · 공통 계정 **조회**: 관리자(+tools). 응답에는 지문 · 공개키 · 이름 · 사용처 수만(개인키 · passphrase · 비밀번호 없음 — 있는지만).
 *    공통 계정은 범위 계정에게 자기 조회 범위 법인 + 전 법인 공용('')만.
 *  · 키 · 공통 계정 **관리**(등록 · 수정 · 회전 · 삭제 · 비밀 입력): `requireSettingsOwner`(소유자 ∧ 전체 범위) + 본인 OTP 재인증(`reauth` — 마지막 게이트:
 *    권한이 없는 요청이 OTP 를 소모하지 않게) + 감사 로그(비밀 미기재).
 *  · 온보딩(분석 · 적용) · 누락 점검은 아래 절 — 범위 계정은 행 단위로 조회 밖 404 → 쓰기 밖 403(그 행 거부).
 * 저장소를 못 읽으면 503(registryUnreadable) — 빈 목록을 내려보내지 않는다.
 */
import { requireRole, requirePerm } from '../../auth/auth.js';
import { requireSettingsOwner } from '../admin/shared.js';
import { reauth } from './reauth.js';
import { logAudit } from '../../audit.js';
import { store } from '../../store.js';
import { inUserScope } from '../../auth/scope.js';
import * as KS from '../../bmusage/onboard/keyStore.js';
import * as REFS from '../../bmusage/onboard/refs.js';

const adminOnly = requireRole('admin');
const toolsPerm = requirePerm('tools');
/** 키 관리 게이트 묶음 — 순서가 뜻이다(관리자 → tools → 소유자 등급 → OTP). */
const keyAdmin = [adminOnly, toolsPerm, requireSettingsOwner, reauth];

const t = (v, max = 256) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max).trim();
const bodyOf = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});
const who = (req) => req.user?.username || '';

/** 결과 → 응답(상태 코드는 결과의 status · code 로). 저장소 못 읽음은 503 + registryUnreadable 표지. */
function send(res, r, okStatus = 200) {
  if (r && r.ok) return res.status(okStatus).json(r);
  const status = Number(r?.status) || (r?.code === 'registry-unreadable' || r?.code === 'SECRETS_POLICY_UNAVAILABLE' ? 503 : 400);
  const { status: _s, ...rest } = r || { ok: false, reason: '알 수 없는 오류' };
  void _s;
  return res.status(status).json({ ...rest, ok: false, ...(rest.code === 'registry-unreadable' ? { registryUnreadable: true } : {}) });
}
function unreadable503(res) {
  const e = KS.keyStoreLoadError();
  if (!e) return false;
  res.status(503).json({ ok: false, code: 'registry-unreadable', registryUnreadable: true, reason: `SSH 키 저장소(${KS.KEY_FILE_NAME})를 읽지 못했습니다 — 손상 보존본(${KS.KEY_FILE_NAME}.corrupt.*)을 확인하세요.` });
  return true;
}

export function registerBmOnboard(api, deps = {}) {
  /* ── SSH 키 저장소 ─────────────────────────────────────────────── */
  api.get('/tools/bm-usage/ssh-keys', adminOnly, toolsPerm, (req, res) => {
    if (unreadable503(res)) return;
    const v = REFS.listKeysView();
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, ...v });
  });

  api.post('/tools/bm-usage/ssh-keys', ...keyAdmin, (req, res) => {
    const b = bodyOf(req);
    const r = KS.addKey({ name: b.name, privateKey: typeof b.privateKey === 'string' ? b.privateKey : '', passphrase: typeof b.passphrase === 'string' ? b.passphrase : '', rotateAt: b.rotateAt }, { by: who(req) });
    logAudit({ user: who(req), action: 'bm-usage.ssh-key.add', target: t(b.name, 64), ip: req.ip || '',
      detail: JSON.stringify(r.ok ? { algo: r.key.algo, bits: r.key.bits, fingerprint: r.key.fingerprint, ok: true } : { ok: false, code: r.code }).slice(0, 300) });
    send(res, r);
  });

  api.put('/tools/bm-usage/ssh-keys/:id', ...keyAdmin, (req, res) => {
    const b = bodyOf(req);
    const r = KS.updateKeyMeta(t(req.params.id, 32), { ...(b.name !== undefined ? { name: b.name } : {}), ...(b.rotateAt !== undefined ? { rotateAt: b.rotateAt } : {}) });
    logAudit({ user: who(req), action: 'bm-usage.ssh-key.update', target: t(req.params.id, 32), ip: req.ip || '', detail: JSON.stringify({ name: r.ok ? r.key.name : undefined, ok: !!r.ok, code: r.code }).slice(0, 300) });
    send(res, r);
  });

  api.post('/tools/bm-usage/ssh-keys/:id/passphrase', ...keyAdmin, (req, res) => {
    const b = bodyOf(req);
    const r = KS.setKeyPassphrase(t(req.params.id, 32), typeof b.passphrase === 'string' ? b.passphrase : '');
    logAudit({ user: who(req), action: 'bm-usage.ssh-key.passphrase', target: t(req.params.id, 32), ip: req.ip || '', detail: JSON.stringify({ ok: !!r.ok, code: r.code }).slice(0, 200) });
    send(res, r);
  });

  api.post('/tools/bm-usage/ssh-keys/rotate', ...keyAdmin, (req, res) => {
    const b = bodyOf(req);
    const r = REFS.rotateKey(t(b.from, 32), t(b.to, 32));
    logAudit({ user: who(req), action: 'bm-usage.ssh-key.rotate', target: `${t(b.from, 32)}→${t(b.to, 32)}`, ip: req.ip || '',
      detail: JSON.stringify(r.ok ? { servers: r.servers.length, accounts: r.accounts, ok: true } : { ok: false, code: r.code }).slice(0, 300) });
    if (!r.ok) return send(res, r);
    // 화면이 '전 서버 재시험' 을 권한다 — 자동 재시험 · 재시도는 하지 않는다(계정 잠금).
    res.json({ ok: true, servers: r.servers, accounts: r.accounts, retestAdvised: r.servers.length > 0 });
  });

  api.delete('/tools/bm-usage/ssh-keys/:id', ...keyAdmin, (req, res) => {
    const r = REFS.deleteKeyIfUnused(t(req.params.id, 32));
    logAudit({ user: who(req), action: 'bm-usage.ssh-key.delete', target: t(req.params.id, 32), ip: req.ip || '', detail: JSON.stringify({ ok: !!r.ok, code: r.code }).slice(0, 200) });
    send(res, r);
  });

  /* ── 법인 공통 계정 ────────────────────────────────────────────── */
  api.get('/tools/bm-usage/accounts', adminOnly, toolsPerm, (req, res) => {
    if (unreadable503(res)) return;
    const snap = store.get();
    const v = REFS.listAccountsView({ visible: (corp) => inUserScope(req.user, snap, corp) });
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, ...v });
  });

  api.post('/tools/bm-usage/accounts', ...keyAdmin, (req, res) => {
    const b = bodyOf(req);
    const { otp, ...input } = b; void otp;
    const r = KS.saveAccount({
      id: input.id, name: input.name, kind: input.kind, corp: input.corp, username: input.username,
      keyRef: input.keyRef, password: typeof input.password === 'string' ? input.password : undefined, clearPassword: input.clearPassword === true,
    }, { by: who(req) });
    logAudit({ user: who(req), action: input.id ? 'bm-usage.account.update' : 'bm-usage.account.add', target: t(input.name, 64), ip: req.ip || '',
      detail: JSON.stringify(r.ok ? { kind: r.account.kind, corp: r.account.corp, keyRef: r.account.keyRef, secretChanged: typeof input.password === 'string' && input.password !== '' && input.password !== '********', dropped: r.droppedSecrets || [] } : { ok: false, code: r.code }).slice(0, 300) });
    send(res, r);
  });

  api.delete('/tools/bm-usage/accounts/:id', ...keyAdmin, (req, res) => {
    const r = REFS.deleteAccountIfUnused(t(req.params.id, 32));
    logAudit({ user: who(req), action: 'bm-usage.account.delete', target: t(req.params.id, 32), ip: req.ip || '', detail: JSON.stringify({ ok: !!r.ok, code: r.code }).slice(0, 200) });
    send(res, r);
  });

  void deps;
}
