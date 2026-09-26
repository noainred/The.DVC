// 설정 › 폴더 사용량 리포트 라우트(v2.454) — 엣지 마운트 폴더의 하위 폴더 사용량 Top-N + 주기 메일.
//
// 권한 경계(server/CLAUDE.md 규약을 그대로 따른다):
//  - 조회/저장/실행은 **adminOnly**. 상태 변경 라우트라 requireRole 로 게이트한다.
//  - SMTP 접속 정보는 **여기 없다** — 포탈 공용 메일 설정(설정 › 메일 발송, `mail.json`)이 소유하고
//    이 기능은 `sendPortalMail({ kind: 'dirusage' })` 로 보낸다. 따라서 이 라우트에 비밀 값이 없다.
//  - 상태 변경은 전부 logAudit.
import { requireRole } from '../../auth/auth.js';
import { logAudit } from '../../audit.js';
import { fullScopeOnlyWith } from './shared.js';
import { load as loadCfg, save as saveCfg, redact, validate } from '../../dirusage/settings.js';
import { getDb, dbStatus } from '../../dirusage/db.js';
import { runNow, schedulerStatus } from '../../dirusage/scheduler.js';
import { renderReport, renderSubject } from '../../dirusage/report.js';
import { listRmaAgents } from '../../rma/jobs.js';

const adminOnly = requireRole('admin');
// v2.611 AUTHZ2611-02: 포탈 호스트 동작은 전 법인 공용 — 범위 계정 403.
const fleetOnly = fullScopeOnlyWith('폴더 사용량 설정·실행은 포탈 호스트 경로를 스캔하는 전 법인 공용 동작이라 전체 범위(vCenter 제한 없는) 계정만 바꿀 수 있습니다.');

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

  // 저장 — 비밀 값이 없으므로 adminOnly 로 충분하다(SMTP 는 설정 › 메일 발송이 소유자 게이트).
  adminRouter.put('/dir-usage', adminOnly, fleetOnly, (req, res) => {
    const body = req.body || {};
    const errs = validate({ ...loadCfg(), ...body });
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
  adminRouter.post('/dir-usage/run', adminOnly, fleetOnly, async (req, res) => {
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
    // v2.620(SRV2620-01): 지문 집합(name_set)은 비교용 내부 값이라 응답에 싣지 않는다(행마다 최대 160KB).
    res.json({ ok: true, scan: withoutNameSet(scan), prev: withoutNameSet(db.prev(scan.target_id, scan.ts)) });
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

  // 메일 테스트는 공용 설정 화면(설정 › 메일 발송)의 `POST /admin/mail/test` 하나로 통일했다 —
  // 기능마다 테스트 버튼이 따로 있으면 어느 SMTP 를 시험한 것인지 헷갈린다.
}

/** DB 행 → report.js 가 기대하는 레코드 모양. */
function toRec(r) {
  return {
    targetId: r.target_id, agent: r.agent, root: r.root, ts: r.ts,
    totalBytes: r.total_bytes, sumBytes: r.sum_bytes, count: r.count,
    othersBytes: r.others_bytes, othersCount: r.others_count,
    skipped: r.skipped, truncated: !!r.truncated, entries: r.entries || [],
    nameSet: r.name_set || null,   // v2.620(SRV2620-01): 순위 밖 이탈·진입 판정 근거(옛 행은 null)
  };
}

function withoutNameSet(r) {
  if (!r) return r;
  const { name_set: _omit, ...rest } = r;
  return rest;
}
