// 스토리지 사용량 보고서 라우트(v2.747) — 특수기능 '스토리지 사용량 보고서'(도구 키 storage-usage).
// 사용자 요청: "스토리지 사용량을 일간/주간 별로 이렇게 정리해서 보는 기능 · 표 형식 기본 · CSV export · 법인별/같은 종류 스토리지별 비교"
//   + "사용자가 지정한 시간에 전체 사용량을 사용자에게 이메일로 발송하는 기능".
// 조회: 전체 범위 계정만(스토리지는 vCenter 귀속이 없는 인프라 장비 — 스토리지 모니터링·증가량과 같은 403).
// 메일 설정 조회·미리보기: adminOnly + fullScopeOnly. 저장·지금 보내기: + requireSettingsOwner(증가량 보존 설정과 같은 기준) + 감사로그.
import { fullScopeOnlyWith, requireSettingsOwner } from '../admin/shared.js';
import { requireRole, requirePerm } from '../../auth/auth.js';
import { logAudit } from '../../audit.js';
import { isAdminReq } from '../../auth/addressMask.js';
import { loadUsageReport } from '../../storage/usageData.js';
import { storageRegistryErrorView } from './isilonDirUsage.js';
import { loadUsageMailSettings, saveUsageMailSettings, storageUsageMailStatus, sendUsageMailNow, previewUsageMail } from '../../storage/usageMail.js';
import { TREND_RANGE, SKIP_CODES, VIEW_PATH } from '../../storage/usageMailRules.js';
import { MAIL_LIST_MAX, isEmail } from '../../isidu/mailRules.js';
import { load as loadMailCfg } from '../../mail/settings.js';

const adminOnly = requireRole('admin');
const toolsPerm = requirePerm('tools');
const fullScopeOnly = fullScopeOnlyWith('스토리지 사용량 보고서는 전체 범위(vCenter 제한 없는) 계정만 조회할 수 있습니다.');

export function registerStorageUsage(api) {
  /**
   * 보고표 — `?gran=daily|weekly|monthly&count=N&weekday=0..6`. 판정·계산은 `storage/usageReport.js`(순수), 조회는 `usageData.js`.
   * ⚠ 장비 왕복 0 이지만 장비 × 기간 행을 읽는다 — 화면은 마운트 1회 + 버튼(폴링 금지).
   */
  api.get('/tools/storage-usage', toolsPerm, fullScopeOnly, async (req, res) => {
    const admin = isAdminReq(req);
    const r = await loadUsageReport({ gran: req.query.gran, count: req.query.count, weekday: req.query.weekday, admin });
    if (!r.ok) {
      // 등록부를 못 읽었으면 빈 표를 '장비 없음' 처럼 내려보내지 않는다(CLAUDE.md registryUnreadable 규약). 원문 조각은 관리자 상세에만.
      res.set('Retry-After', '60');
      return res.status(503).json({ error: '스토리지 등록부를 읽지 못했습니다 — 손상 보존본(storage-devices.json.corrupt.*)을 확인하세요.',
        registryUnreadable: true, storageRegistryError: storageRegistryErrorView(r.registryError, { detail: admin }) });
    }
    res.json(r);
  });

  /** 메일 설정·상태. 주소는 이 조회에만 싣는다(상태·기록에는 개수만). */
  api.get('/tools/storage-usage/mail', adminOnly, fullScopeOnly, (_req, res) => {
    let adminTo = [];
    try { adminTo = (loadMailCfg().defaultTo || []).filter(isEmail).slice(0, MAIL_LIST_MAX); } catch { adminTo = []; }
    res.json({ ok: true, mail: loadUsageMailSettings(), status: storageUsageMailStatus(), adminTo,
      limits: { listMax: MAIL_LIST_MAX, trend: TREND_RANGE }, skipCodes: SKIP_CODES, viewPath: VIEW_PATH });
  });

  api.put('/tools/storage-usage/mail', adminOnly, fullScopeOnly, requireSettingsOwner, (req, res) => {
    const r = saveUsageMailSettings(req.body?.mail ?? req.body);
    if (!r.ok) return res.status(r.status).json({ error: r.error, field: r.field || null });
    logAudit({ user: req.user?.username, action: 'storage.usage.mail', target: 'storage-usage-mail.json',
      detail: `enabled=${r.mail.enabled} days=${r.mail.days.join(',')} time=${r.mail.time} gran=${r.mail.gran} to=${r.mail.to.length} admin=${r.mail.includeAdmin}`, ip: req.ip || '' });
    res.json({ ok: true, mail: r.mail, status: storageUsageMailStatus() });
  });

  /** 지금 한 번 보내기 — 실패는 409(5xx 면 재시도하는 호출부가 같은 메일을 두 번 보낼 수 있다). */
  api.post('/tools/storage-usage/mail/send-now', adminOnly, fullScopeOnly, requireSettingsOwner, async (req, res) => {
    const r = await sendUsageMailNow(req.user?.username || 'admin');
    logAudit({ user: req.user?.username, action: 'storage.usage.mail.send', target: 'storage-usage',
      detail: `${r.state}${r.to != null ? ` to=${r.to}` : ''}${r.reason ? ` · ${String(r.reason).slice(0, 120)}` : ''}`, ip: req.ip || '' });
    res.status(r.ok ? 200 : 409).json({ ...r, status: storageUsageMailStatus() });
  });

  /** 미리보기 — 보내지 않는다. 본문(저장하지 않은 화면 값)을 받으면 그 값으로 만든다. */
  api.post('/tools/storage-usage/mail/preview', adminOnly, fullScopeOnly, async (req, res) => {
    const r = await previewUsageMail(req.body?.mail ?? null);
    if (!r.ok) return res.status(r.field ? 400 : 409).json(r);
    res.json(r);
  });
}
