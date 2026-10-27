// 설정 › 메일 발송 라우트(v2.454) — 포탈 공용 SMTP 설정 + 기능별 수신자 + 발송 이력.
//
// 권한 경계(server/CLAUDE.md 자격증명 규약):
//  - 조회는 adminOnly. **저장·테스트 발송은 requireSettingsOwner** — SMTP 릴레이 계정이 유출되면
//    사내 메일 위조에 쓰이므로 백업·통합 계정과 같은 등급으로 본다.
//  - **비밀 값은 응답에 싣지 않는다**(redact() 가 hasPassword 불리언만). '보기' 경로 금지.
//  - 상태 변경은 전부 logAudit(비밀 미기재).
import { requireRole } from '../../auth/auth.js';
import { logAudit } from '../../audit.js';
import { requireSettingsOwner } from './shared.js';
import { load as loadMail, save as saveMail, redact, validate, smtpIssue, unknownKinds, nextSmtpPassword } from '../../mail/settings.js';
import { sendPortalMail, mailStatus } from '../../mail/service.js';
import { KINDS } from '../../mail/kinds.js';
import { store } from '../../store.js';
import { scopedVcenterIds } from '../../auth/scope.js';

const adminOnly = requireRole('admin');

/**
 * v2.768(점검 R3-C2-1): 발송 이력(제목·수신자)과 최근 오류는 **전 법인 알림 메일**의 기록이다 — 제목에 다른 법인의 vCenter·
 *   호스트·DS·VM 이름이 실린다. 형제 GET /admin/alerts 는 scopeAlertStatus 로 범위 vCenter 만 주는데 같은 알림의 제목이 이
 *   경로로는 그대로 나갔다. 이력에는 vCenter 귀속이 없어 나눌 축이 없다(v2.525 규약) → 범위 계정에는 싣지 않고 뺀 사실을 밝힌다
 *   (화면이 '기록 없음' 과 구분한다). 집계 수·인증 정지 표지는 법인 정보가 아니라 그대로 둔다.
 * @param {object} st mailStatus() 결과 · @param {Set<string>|null} allowed scopedVcenterIds 결과(null = 전체 범위)
 */
export function scopeMailStatus(st, allowed) {
  if (!allowed || !st) return st;
  const n = Array.isArray(st.history) ? st.history.length : 0;
  return { ...st, history: [], lastError: null, scoped: true, omittedOutOfScope: { history: n, lastError: !!st.lastError } };
}

export function registerMail(adminRouter) {

  adminRouter.get('/mail', adminOnly, (req, res) => {
    res.json({ settings: redact(), status: scopeMailStatus(mailStatus(), scopedVcenterIds(req.user, store.get())), kinds: KINDS });
  });

  adminRouter.put('/mail', adminOnly, requireSettingsOwner, (req, res) => {
    const body = req.body || {};
    const bad = unknownKinds(body.kinds);
    if (bad.length) return res.status(400).json({ ok: false, reason: `알 수 없는 발송 종류: ${bad.join(', ')}` });
    // 검증은 '저장 후 상태' 기준이어야 한다 — 비밀번호를 비워 보낸 경우(기존 유지)를 오탐하지 않게.
    // v2.768(점검 R3-C5-04): 비밀번호는 save 와 **같은 승계식**(nextSmtpPassword — 호스트 변경·clearPassword 면 빈 값)으로 채운다.
    //   예전 `body.password || cur.password` 는 save 가 버릴 비밀번호로 검증해 '계정 있음 + 비밀번호 없음' 을 200 으로 저장했다.
    const cur = loadMail();
    const hasSmtp = body.smtp && typeof body.smtp === 'object';
    const pw = hasSmtp ? nextSmtpPassword(body.smtp, cur.smtp) : { password: cur.smtp.password, dropped: null };
    const merged = {
      ...cur, ...body,
      smtp: { ...cur.smtp, ...(hasSmtp ? body.smtp : {}), password: pw.password },
    };
    const errs = validate(merged, pw.dropped);
    if (errs.length) return res.status(400).json({ ok: false, reason: errs[0], errors: errs });
    const saved = saveMail(body);
    logAudit({
      user: req.user?.username, action: '메일 발송 설정 저장',
      detail: `발송 ${saved.enabled ? '켜짐' : '꺼짐'} · 서버 ${saved.smtp.host || '(없음)'} · 기본 수신자 ${saved.defaultTo.length}명`,
      ip: req.ip,
    });
    res.json({ ok: true, settings: redact(saved) });
  });

  // 테스트 발송 — SMTP 설정 확인용. 비밀번호를 쓰므로 설정 소유자만.
  adminRouter.post('/mail/test', adminOnly, requireSettingsOwner, async (req, res) => {
    const cfg = loadMail();
    const issue = smtpIssue(cfg.smtp);
    if (issue) return res.status(400).json({ ok: false, reason: issue });
    const to = req.body?.to;
    const r = await sendPortalMail({
      kind: 'test',
      // 진단 화면이 단계별 대화를 보여준다(요구사항). 비밀번호는 추적에 담기지 않는다.
      trace: req.body?.trace !== false,
      to: to && (Array.isArray(to) ? to.length : String(to).trim()) ? to : null,
      by: req.user?.username || 'admin',
      subject: '[VMware Portal] 메일 발송 테스트',
      text: '이 메일이 보이면 SMTP 설정이 정상입니다.\n각 기능의 메일은 설정 › 메일 발송에서 종류별로 켜고 끌 수 있습니다.',
      html: '<div style="font-family:sans-serif"><p>이 메일이 보이면 <b>SMTP 설정이 정상</b>입니다.</p>'
        + '<p style="color:#667085;font-size:12.5px">각 기능의 메일은 <b>설정 › 메일 발송</b>에서 종류별로 켜고 끌 수 있습니다.</p></div>',
    });
    // 오류 메시지에 비밀번호가 실리지 않는다(util/smtp.js 가 인증 단계 명령을 가린다).
    res.status(r.ok ? 200 : 502).json(r);
  });
}
