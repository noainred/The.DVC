/**
 * 호스트 접근 제어 API(v2.485) — SSH/웹(80·443·포탈 포트) 클라이언트 제어 + OS 방화벽 추가 규칙.
 * 권한: 조회 admin · 초안 저장/계획 admin+설정 소유자 · 적용/확정/되돌림 admin+설정 소유자+**본인 OTP**
 * (서버 접근 경로를 바꾸는 작업이라 세션 탈취만으로는 못 하게 한다). 모든 변경은 감사 로그.
 */
import { config } from '../../config.js';
import { logAudit } from '../../audit.js';
import { verifyUserOtp, getUser } from '../../auth/auth.js';
import { clientIp } from '../../util/rateLimit.js';
import { adminOnly, requireSettingsOwner } from './shared.js';
import { hostAccessStatus, saveDraft, planHostAccess, applyHostAccess, confirmHostAccess, revertHostAccess, SUDOERS_HINT } from '../../hostaccess/service.js';

function requireOwnOtp(req, res, next) {
  if (!config.auth.enabled) return next();
  const name = req.user?.username || '';
  const u = getUser(name);
  if (!u?.totpEnabled) return res.status(403).json({ ok: false, reason: '이 작업은 OTP 가 등록된 계정만 실행할 수 있습니다(서버 접근 경로 변경). 사용자 관리에서 OTP 를 등록하세요.', needEnroll: true });
  const v = verifyUserOtp(name, req.body?.otp);
  if (!v.ok) return res.status(403).json({ ok: false, reason: `OTP 인증 실패 — ${v.reason}` });
  return next();
}

export function registerHostAccess(adminRouter) {
  adminRouter.get('/host-access', adminOnly, async (req, res) => {
    res.json({ ...(await hostAccessStatus({ requesterIp: clientIp(req) })), sudoersHint: SUDOERS_HINT() });
  });
  adminRouter.put('/host-access/draft', adminOnly, requireSettingsOwner, (req, res) => {
    const r = saveDraft(req.body?.settings || req.body || {});
    if (!r.ok) return res.status(400).json(r);
    logAudit({ user: req.user?.username, action: '호스트 접근 제어 초안 저장', detail: `ssh=${r.settings.ssh.mode} web=${r.settings.web.mode} extra=${r.settings.firewall.extra.length}`, ip: req.ip || '' });
    res.json(r);
  });
  adminRouter.post('/host-access/plan', adminOnly, requireSettingsOwner, async (req, res) => {
    res.json(await planHostAccess(req.body?.settings || {}, { requesterIp: clientIp(req) }));
  });
  adminRouter.post('/host-access/apply', adminOnly, requireSettingsOwner, requireOwnOtp, async (req, res) => {
    const r = await applyHostAccess(req.body?.settings || {}, { requesterIp: clientIp(req), by: req.user?.username || '' });
    logAudit({ user: req.user?.username, action: r.ok ? '호스트 접근 제어 적용(런타임, 확정 대기)' : '호스트 접근 제어 적용 실패', target: 'host-access', detail: r.ok ? `명령 ${r.commands.length}개 · 확정 기한 ${new Date(r.pending.deadline).toISOString()}` : (r.errors || []).join(' / ').slice(0, 300), ip: req.ip || '' });
    res.status(r.ok ? 200 : 400).json(r);
  });
  adminRouter.post('/host-access/confirm', adminOnly, requireSettingsOwner, requireOwnOtp, async (req, res) => {
    const r = await confirmHostAccess({ by: req.user?.username || '' });
    logAudit({ user: req.user?.username, action: r.ok ? '호스트 접근 제어 확정(영구)' : '호스트 접근 제어 확정 실패', target: 'host-access', detail: r.ok ? (r.notes || []).join(' ') : (r.errors || []).join(' / '), ip: req.ip || '' });
    res.status(r.ok ? 200 : 400).json(r);
  });
  adminRouter.post('/host-access/revert', adminOnly, requireSettingsOwner, async (req, res) => {
    const r = await revertHostAccess({ by: req.user?.username || '' });
    logAudit({ user: req.user?.username, action: '호스트 접근 제어 되돌림(런타임→영구 설정)', target: 'host-access', ip: req.ip || '' });
    res.status(r.ok ? 200 : 400).json(r);
  });
}
