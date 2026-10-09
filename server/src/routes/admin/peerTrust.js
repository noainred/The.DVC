/**
 * routes/admin/peerTrust.js — 설정 › 장비 신뢰(SSH 호스트키·TLS 인증서) API(2026-10-09 검토 S-01·S-02, 그룹 H).
 *
 * 왜: 포탈은 등록된 장비에 비밀번호를 실어 접속한다. 경로·DNS 를 가로챈 쪽이 자기 서버로 접속을 유도하면 그 비밀번호가
 * 그대로 넘어간다. `security/peerTrust.js` 가 (종류, 호스트, 포트) → 신뢰 지문을 들고 연결이 내민 지문과 대조한다.
 * 이 라우트는 관리자가 그 지문을 **별도 경로(장비 콘솔 등)로 확인한 뒤 승인**하고, 바뀐 지문을 거부·삭제하고,
 * 정책(enforce/observe)을 바꾸는 곳이다.
 *
 * 권한:
 *   · 조회 — admin + 전체 범위(장비 주소·지문은 전 법인 공용 정보라 법인 축으로 나눌 수 없다 — 형제 보안 화면과 같은 기준)
 *   · 승인·거부·삭제·관찰 일괄 승인 — admin + 전체 범위. 승인은 본문 `confirmVerified:true`(관리자가 지문을 별도로 확인했다는
 *     명시적 확인)가 없으면 400 — 화면의 확인 대화상자를 건너뛴 호출로 '그냥 승인' 이 되지 않게.
 *   · 정책 변경 — 위 + 설정 소유 계정(requireSettingsOwner). observe 로 바꾸면 처음 보는 장비가 관찰로 통과하므로 보안 정책 등급이다.
 *   · OTP 등록 전 세션은 /api/admin 마운트의 requireEnrolled 가 막는다 · 데모 계정은 READ_DENY('/api/admin/security') 가 막는다.
 * 모든 변경은 logAudit(지문은 공개 정보라 기록한다 — 비밀이 아니다).
 */
import {
  PEER_KINDS, PEER_MODES, normalizeFingerprint, normalizePeerHost, listPeers, peerTrustStatus,
  approvePeer, rejectPeer, removePeer, approveAllObserved, setPeerPolicy,
} from '../../security/peerTrust.js';
import { tlsTrustStatus } from '../../security/tlsTrust.js';
import { logAudit } from '../../audit.js';
import { clientIp } from '../../util/rateLimit.js';
import { adminOnly, fullScopeOnlyWith, requireSettingsOwner } from './shared.js';

const fleetOnly = fullScopeOnlyWith('장비 신뢰(SSH 호스트키·TLS 인증서)는 전 법인 장비에 공통이라 전체 범위(vCenter 제한 없는) 계정만 다룰 수 있습니다.');

// 호스트: 이름·IPv4·IPv6(대괄호 허용)·zone(%) 만. 키 구분자 '|'·공백·제어 문자는 거부(저장소 키가 어긋나지 않게).
const HOST_RE = /^[A-Za-z0-9._:%[\]-]{1,255}$/;

/** 본문의 kind/host/port 를 검사한다. 문제면 { error } 를, 아니면 { kind, host, port } 를 돌려준다. */
export function peerTarget(body = {}) {
  const kind = String(body.kind ?? '').trim();
  if (!PEER_KINDS.includes(kind)) return { error: `종류(kind)는 ${PEER_KINDS.join('·')} 중 하나여야 합니다.`, field: 'kind' };
  const host = String(body.host ?? '').trim();
  if (!HOST_RE.test(host) || !normalizePeerHost(host)) return { error: '호스트 형식이 올바르지 않습니다(이름·IP 만, 공백·특수문자 불가).', field: 'host' };
  const p = Number(body.port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) return { error: '포트는 1~65535 정수여야 합니다.', field: 'port' };
  return { kind, host, port: p };
}

const actor = (req) => req.user?.username || 'unknown';
const audit = (req, action, target, detail) => {
  try { logAudit({ user: actor(req), action, target, detail, ip: clientIp(req) }); } catch { /* 감사 실패가 결과를 바꾸지 않는다 */ }
};

export function registerPeerTrust(adminRouter) {
  adminRouter.get('/security/peer-trust', adminOnly, fleetOnly, (req, res) => {
    const kind = PEER_KINDS.includes(String(req.query.kind || '')) ? String(req.query.kind) : undefined;
    // TLS 쪽 상태(사설 CA 번들·수집기별 모드·예외·최근 거부 — 그룹 I 의 tlsTrust.js)는 읽기만 한다.
    // 못 읽으면 null + 사유(화면이 'TLS 상태를 읽지 못했습니다' 로 말한다 — 빈 상태로 지어내지 않는다).
    let tls = null;
    let tlsError = null;
    try { tls = tlsTrustStatus(); } catch (e) { tlsError = String(e?.message || e).slice(0, 200); }
    res.json({ ok: true, status: peerTrustStatus(), peers: listPeers({ kind }), kinds: PEER_KINDS, modes: PEER_MODES, tls, tlsError });
  });

  adminRouter.post('/security/peer-trust/approve', adminOnly, fleetOnly, (req, res) => {
    const b = req.body || {};
    const t = peerTarget(b);
    if (t.error) return res.status(400).json({ ok: false, reason: t.error, field: t.field });
    if (b.confirmVerified !== true) {
      return res.status(400).json({ ok: false, reason: '지문을 장비 콘솔 등 별도 경로로 확인했다는 확인(confirmVerified)이 필요합니다.', field: 'confirmVerified' });
    }
    if (b.fp != null && b.fp !== '' && !normalizeFingerprint(t.kind, b.fp)) {
      return res.status(400).json({ ok: false, reason: t.kind === 'ssh' ? '지문 형식은 SHA256:<base64 43자> 입니다.' : '지문 형식은 SHA-256 16진 64자리(콜론 구분 가능)입니다.', field: 'fp' });
    }
    const before = listPeers({ kind: t.kind }).find((e) => e.host === normalizePeerHost(t.host) && e.port === t.port) || null;
    const r = approvePeer(t.kind, t.host, t.port, b.fp || null, { by: actor(req), note: typeof b.note === 'string' ? b.note : '' });
    if (!r.ok) return res.status(400).json({ ok: false, reason: r.error === 'nothing-to-approve' ? '승인할 지문이 없습니다(관찰·대기 지문이 없으면 지문을 직접 입력하세요).' : r.error, code: r.error });
    const prev = before?.trusted?.fp && before.trusted.fp !== r.fp ? before.trusted.fp : null;
    audit(req, '장비 신뢰 지문 승인', `${t.kind} ${t.host}:${t.port}`,
      `${r.fp}${prev ? ` (이전 ${prev} → 교체)` : ''}${r.matchedPresented === false ? ' · 장비가 내민 지문과 다른 값을 미리 승인' : ''}`);
    res.json({ ok: true, ...r, status: peerTrustStatus() });
  });

  adminRouter.post('/security/peer-trust/reject', adminOnly, fleetOnly, (req, res) => {
    const b = req.body || {};
    const t = peerTarget(b);
    if (t.error) return res.status(400).json({ ok: false, reason: t.error, field: t.field });
    if (b.fp != null && b.fp !== '' && !normalizeFingerprint(t.kind, b.fp)) return res.status(400).json({ ok: false, reason: '지문 형식이 올바르지 않습니다.', field: 'fp' });
    const r = rejectPeer(t.kind, t.host, t.port, b.fp || null, { by: actor(req) });
    if (!r.ok) return res.status(400).json({ ok: false, reason: '거부할 지문이 없습니다.', code: r.error });
    audit(req, '장비 신뢰 지문 거부', `${t.kind} ${t.host}:${t.port}`, r.fp);
    res.json({ ok: true, ...r, status: peerTrustStatus() });
  });

  adminRouter.post('/security/peer-trust/remove', adminOnly, fleetOnly, (req, res) => {
    const t = peerTarget(req.body || {});
    if (t.error) return res.status(400).json({ ok: false, reason: t.error, field: t.field });
    const r = removePeer(t.kind, t.host, t.port);
    if (!r.ok) return res.status(404).json({ ok: false, reason: '그 장비 항목이 없습니다.' });
    audit(req, '장비 신뢰 항목 삭제', `${t.kind} ${t.host}:${t.port}`, '다음 연결은 처음 보는 장비로 판정');
    res.json({ ok: true, ...r, status: peerTrustStatus() });
  });

  adminRouter.post('/security/peer-trust/approve-observed', adminOnly, fleetOnly, (req, res) => {
    const b = req.body || {};
    const kind = String(b.kind ?? '');
    if (!PEER_KINDS.includes(kind)) return res.status(400).json({ ok: false, reason: '종류(kind)가 올바르지 않습니다.', field: 'kind' });
    if (b.confirmVerified !== true) {
      return res.status(400).json({ ok: false, reason: '관찰 지문을 확인했다는 확인(confirmVerified)이 필요합니다.', field: 'confirmVerified' });
    }
    const r = approveAllObserved(kind, { by: actor(req) });
    audit(req, '장비 신뢰 관찰 지문 일괄 승인', kind, `${r.approved}건`);
    res.json({ ok: true, ...r, status: peerTrustStatus() });
  });

  adminRouter.put('/security/peer-trust/policy', adminOnly, fleetOnly, requireSettingsOwner, (req, res) => {
    const b = req.body || {};
    const kind = String(b.kind ?? '');
    const mode = String(b.mode ?? '');
    const r = setPeerPolicy(kind, mode, { by: actor(req) });
    if (!r.ok) {
      const reason = r.error === 'env-forced' ? `환경변수 ${r.envKey} 가 정책을 정하고 있어 화면에서 바꿀 수 없습니다.`
        : r.error === 'unknown-kind' ? '종류(kind)가 올바르지 않습니다.' : `정책은 ${PEER_MODES.join('·')} 중 하나여야 합니다.`;
      return res.status(r.error === 'env-forced' ? 409 : 400).json({ ok: false, reason, code: r.error });
    }
    audit(req, '장비 신뢰 정책 변경', kind, mode);
    res.json({ ok: true, ...r, status: peerTrustStatus() });
  });
}
