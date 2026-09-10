// 설정 › 폴더 사용량 리포트 라우트(v2.454) — 엣지 마운트 폴더의 하위 폴더 사용량 Top-N + 주기 메일.
//
// 권한 경계(server/CLAUDE.md 규약을 그대로 따른다):
//  - 조회/저장/실행은 **adminOnly**. 상태 변경 라우트라 requireRole 로 게이트한다.
//  - SMTP 비밀번호를 다루는 저장·발송 테스트는 **requireSettingsOwner** — 백업·자격증명과 같은
//    등급이다(릴레이 계정이 유출되면 사내 메일 위조에 쓰인다).
//  - **비밀 값은 응답에 싣지 않는다** — redact() 가 hasPassword 불리언만 남긴다. '보기' 경로 금지.
//  - 상태 변경은 전부 logAudit(비밀 미기재).
import { requireRole } from '../../auth/auth.js';
import { logAudit } from '../../audit.js';
import { requireSettingsOwner } from './shared.js';
import { load as loadCfg, save as saveCfg, redact, validate, smtpIssue } from '../../dirusage/settings.js';
import { getDb, dbStatus } from '../../dirusage/db.js';
import { runNow, schedulerStatus } from '../../dirusage/scheduler.js';
import { renderReport, renderSubject } from '../../dirusage/report.js';
import { sendMail } from '../../util/smtp.js';
import { listRmaAgents } from '../../rma/jobs.js';

const adminOnly = requireRole('admin');

export function registerDirUsage(adminRouter) {

  // 설정 + 상태 + 최근 결과. 엣지 목록도 함께 내려 화면이 선택지를 만들 수 있게 한다.
  adminRouter.get('/dir-usage', adminOnly, async (_req, res) => {
    const db = await getDb();
    const latest = db ? db.latestAll() : [];
    res.json({
      settings: redact(),
      status: schedulerStatus(),
      db: dbStatus(),
      agents: listRmaAgents().map((a) => ({ agent: a.agent, online: a.online, instances: a.instances })),
      latest,
    });
  });

  // 저장 — SMTP 비밀번호가 들어오므로 설정 소유자만.
  adminRouter.put('/dir-usage', adminOnly, requireSettingsOwner, (req, res) => {
    const body = req.body || {};
    // 저장 전 검증: 현재 저장된 비밀번호를 합쳐 판정해야 '비워 두면 기존 유지'가 오탐되지 않는다.
    const cur = loadCfg();
    const merged = {
      ...cur, ...body,
      smtp: { ...cur.smtp, ...(body.smtp || {}), password: body.smtp?.password || cur.smtp.password },
    };
    const errs = validate(merged);
    if (errs.length) return res.status(400).json({ ok: false, reason: errs[0], errors: errs });
    const saved = saveCfg(body);
    logAudit({
      user: req.user?.username, action: '폴더 사용량 리포트 설정 저장',
      detail: `대상 ${saved.targets.length}개 · 메일 ${saved.mail.enabled ? `켜짐(${saved.mail.to.length}명)` : '꺼짐'} · 스케줄 ${saved.enabled ? '켜짐' : '꺼짐'}`,
      ip: req.ip,
    });
    res.json({ ok: true, settings: redact(saved) });
  });

  // 지금 스캔 — 폴러와 같은 재진입 가드를 공유한다(동시 실행 금지).
  adminRouter.post('/dir-usage/run', adminOnly, async (req, res) => {
    const targetId = String(req.body?.targetId || '');
    const r = await runNow(targetId);
    logAudit({ user: req.user?.username, action: '폴더 사용량 스캔 실행', target: targetId || '(전체)', detail: r.ok ? `${r.queued.length}건 요청` : r.reason, ip: req.ip });
    res.status(r.ok ? 200 : 409).json(r);
  });

  // 대상별 이력(최근 N건). 증감 계산은 화면이 두 건을 비교해 만든다.
  adminRouter.get('/dir-usage/history/:targetId', adminOnly, async (req, res) => {
    const db = await getDb();
    if (!db) return res.status(503).json({ ok: false, reason: '이력 DB 를 사용할 수 없습니다(node:sqlite).' });
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 30));
    res.json({ ok: true, scans: db.list(String(req.params.targetId), limit) });
  });

  // 스캔 1건 상세(Top-N 전체 + 직전 대비 증감).
  adminRouter.get('/dir-usage/scan/:id', adminOnly, async (req, res) => {
    const db = await getDb();
    if (!db) return res.status(503).json({ ok: false, reason: '이력 DB 를 사용할 수 없습니다(node:sqlite).' });
    const scan = db.get(Number(req.params.id));
    if (!scan) return res.status(404).json({ ok: false, reason: '스캔 기록이 없습니다.' });
    res.json({ ok: true, scan, prev: db.prev(scan.target_id, scan.ts) });
  });

  // 메일 미리보기(HTML) — 실제 발송 없이 본문만 확인한다. 발송 전에 서식을 보게 하는 용도.
  adminRouter.get('/dir-usage/preview/:id', adminOnly, async (req, res) => {
    const db = await getDb();
    if (!db) return res.status(503).json({ ok: false, reason: '이력 DB 를 사용할 수 없습니다.' });
    const row = db.get(Number(req.params.id));
    if (!row) return res.status(404).json({ ok: false, reason: '스캔 기록이 없습니다.' });
    const scan = toRec(row);
    const prev = db.prev(row.target_id, row.ts);
    const { html, text } = renderReport(scan, prev ? toRec(prev) : null);
    const cfg = loadCfg();
    res.json({ ok: true, subject: renderSubject(cfg.mail.subject, { root: scan.root, agent: scan.agent, ts: scan.ts, topN: scan.entries.length }), html, text });
  });

  // 메일 발송 테스트 — SMTP 설정 확인용. 비밀번호를 쓰므로 설정 소유자만.
  adminRouter.post('/dir-usage/test-mail', adminOnly, requireSettingsOwner, async (req, res) => {
    const cfg = loadCfg();
    const issue = smtpIssue(cfg.smtp);
    if (issue) return res.status(400).json({ ok: false, reason: issue });
    const to = req.body?.to || cfg.mail.to;
    if (!to || (Array.isArray(to) && !to.length)) return res.status(400).json({ ok: false, reason: '받는 사람을 지정하세요.' });
    try {
      const r = await sendMail(cfg.smtp, {
        to,
        subject: '[VMware Portal] 폴더 사용량 리포트 메일 테스트',
        text: '이 메일이 보이면 SMTP 설정이 정상입니다.\n실제 리포트는 설정한 주기마다 자동 발송됩니다.',
        html: '<div style="font-family:sans-serif"><p>이 메일이 보이면 <b>SMTP 설정이 정상</b>입니다.</p><p style="color:#667085;font-size:12.5px">실제 리포트는 설정한 주기마다 자동 발송됩니다.</p></div>',
      });
      logAudit({ user: req.user?.username, action: '폴더 사용량 리포트 메일 테스트', detail: `${r.accepted.length}명 수신`, ip: req.ip });
      res.json({ ok: true, accepted: r.accepted, reply: r.text });
    } catch (e) {
      // 오류 메시지에 비밀번호가 실리지 않는다(smtp.js 가 인증 단계 명령을 가린다).
      logAudit({ user: req.user?.username, action: '폴더 사용량 리포트 메일 테스트(실패)', detail: e.message.slice(0, 200), ip: req.ip });
      res.status(502).json({ ok: false, reason: e.message });
    }
  });
}

/** DB 행 → report.js 가 기대하는 레코드 모양. */
function toRec(r) {
  return {
    targetId: r.target_id, agent: r.agent, root: r.root, ts: r.ts,
    totalBytes: r.total_bytes, sumBytes: r.sum_bytes, count: r.count,
    othersBytes: r.others_bytes, othersCount: r.others_count,
    skipped: r.skipped, truncated: !!r.truncated, entries: r.entries || [],
  };
}
