/**
 * routes/admin/usage.js — 설정 › 사용자 › 기능 사용 현황 API(v2.912, 설계 docs/design/feature-usage §4.4).
 *
 * 권한: **adminOnly + requireSettingsOwner**(설정 소유자 ∧ 전체 범위) — 사용자 선택 '설정 소유자만'(2026-11-06).
 *   계정마다 어느 화면을 얼마나 썼는지는 개인 활동 기록이고 법인 축으로 나눌 수 없다(전 법인 사용자의 기록이 한 표에 있다).
 *   범위가 지정된 소유자는 requireSettingsOwner 가 403(SETTINGS_OWNER_FULL_SCOPE_REASON).
 *   · GET  /usage/report?days|from&to        개요 · 기능별 · 사용자별 집계(설정을 못 읽었으면 503 settingsUnreadable — 꺼짐 구간을 지어내지 않는다)
 *   · GET  /usage/user/:user?days|from&to    개인 상세(드로어)
 *   · GET  /usage/export.csv?days|from&to   일 집계 그대로(날 · 계정 · 이름 · 역할 · 키 · 열람 · 머문 초) — 동시 1건(util/exportBusy)
 *   · GET  /usage/settings · PUT /usage/settings  수집 설정 + 지금 상태 · 저장은 감사 로그(무엇이 어떻게 — res.locals.auditDetail)
 *   · POST /usage/purge {scope, user?, before?, otp}  기록 지우기 — **본인 OTP 재인증**(routes/api/reauth.js — 민감 작업 재인증 규칙) + 감사 로그
 * DB 를 못 열면 503(빈 표를 그리지 않는다).
 */
import { adminOnly, requireSettingsOwner } from './shared.js';
import { reauth } from '../api/reauth.js';
import { acquireExport } from '../../util/exportBusy.js';
import { csvLine, CSV_BOM } from '../../util/csv.js';
import { fileStamp } from '../../util/dayKey.js';
import { buildUsageReport, buildUserUsage, usageCsvRows, usageStatus, purgeUsageRecords } from '../../usage/store.js';
import { loadUsageSettings, saveUsageSettings, usageSettingsLoadError, noticeText, defaultNotice, USAGE_LIMITS, IDLE_MIN_RANGE, KEEP_DAYS_RANGE } from '../../usage/settings.js';

const gate = [adminOnly, requireSettingsOwner];
// eslint-disable-next-line no-control-regex
const NAME_RE = /^[^\s\u0000-\u001f\u007f]{1,64}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function fail(res, e, next) {
  if (e && Number.isInteger(e.status)) return res.status(e.status).json({ ok: false, reason: e.message, ...(e.code ? { error: e.code } : {}), ...(e.field ? { field: e.field } : {}) });
  return next(e);
}
const rangeOf = (q) => ({ days: q.days, from: q.from, to: q.to });
const unreadable = (res) => res.status(503).json({ ok: false, error: 'settingsUnreadable', reason: `usage-settings.json 을 읽지 못했습니다(${usageSettingsLoadError()?.reason || '손상'}) — 손상본은 .corrupt.<시각> 으로 보존했습니다. 수집 설정에서 다시 저장하면 기본값으로 시작합니다.` });

export function registerUsageAdmin(adminRouter) {
  adminRouter.get('/usage/report', ...gate, async (req, res, next) => {
    if (usageSettingsLoadError()) return unreadable(res);
    try { res.json(await buildUsageReport(rangeOf(req.query))); } catch (e) { fail(res, e, next); }
  });

  adminRouter.get('/usage/user/:user', ...gate, async (req, res, next) => {
    if (usageSettingsLoadError()) return unreadable(res);
    const u = String(req.params.user || '');
    if (!NAME_RE.test(u)) return res.status(400).json({ ok: false, reason: '계정 이름 형식이 아닙니다' });
    try { res.json(await buildUserUsage({ user: u, ...rangeOf(req.query) })); } catch (e) { fail(res, e, next); }
  });

  adminRouter.get('/usage/export.csv', ...gate, async (req, res, next) => {
    if (usageSettingsLoadError()) return unreadable(res);
    const lock = acquireExport('feature-usage', req);
    if (!lock.ok) return res.status(lock.status).json(lock.body);
    try {
      const out = [CSV_BOM + csvLine(['날짜(KST)', '계정', '이름', '역할', '화면 키', '열람', '머문 시간(초)'])];
      for await (const row of usageCsvRows(rangeOf(req.query))) out.push(csvLine(row));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="feature-usage-${fileStamp()}.csv"`);   // 포탈 날짜(KST) — UTC 날짜 파일명 금지(BUG-3)
      res.send(`${out.join('\r\n')}\r\n`);
    } catch (e) { fail(res, e, next); } finally { lock.release(); }
  });

  adminRouter.get('/usage/settings', ...gate, async (req, res) => {
    const s = loadUsageSettings();
    res.json({
      ok: true,
      settings: { enabled: s.enabled, idleMin: s.idleMin, keepDays: s.keepDays, excluded: s.excluded, noticeEnabled: s.noticeEnabled, notice: s.notice, toggles: s.toggles.slice(-20), updatedAt: s.updatedAt, updatedBy: s.updatedBy },
      noticePreview: noticeText(s), defaultNotice: defaultNotice(s.keepDays),
      limits: { ...USAGE_LIMITS, idleMin: IDLE_MIN_RANGE, keepDays: KEEP_DAYS_RANGE },
      loadError: usageSettingsLoadError(),
      status: await usageStatus(),
    });
  });

  adminRouter.put('/usage/settings', ...gate, (req, res, next) => {
    try {
      const { settings, changes } = saveUsageSettings(req.body || {}, req.user?.username || '');
      res.locals.auditDetail = changes.length ? changes.join(' · ') : '변경 없음';
      res.json({ ok: true, settings, noticePreview: noticeText(settings) });
    } catch (e) { fail(res, e, next); }
  });

  adminRouter.post('/usage/purge', ...gate, reauth, async (req, res, next) => {
    const b = req.body || {};
    const scope = b.scope;
    if (!['all', 'user', 'before'].includes(scope)) return res.status(400).json({ ok: false, reason: 'scope 는 all · user · before 중 하나여야 합니다' });
    if (scope === 'user' && !NAME_RE.test(String(b.user || ''))) return res.status(400).json({ ok: false, reason: '지울 계정 이름이 필요합니다' });
    if (scope === 'before' && !DAY_RE.test(String(b.before || ''))) return res.status(400).json({ ok: false, reason: 'before 는 YYYY-MM-DD 여야 합니다' });
    try {
      const r = await purgeUsageRecords({ scope, user: String(b.user || ''), before: String(b.before || '') });
      if (!r.ok) return res.status(503).json({ ok: false, error: 'db-unavailable', reason: r.reason });
      res.locals.auditDetail = `범위 ${scope}${scope === 'user' ? ` ${b.user}` : ''}${scope === 'before' ? ` ${b.before} 이전` : ''} · ${r.deleted}행`;
      res.json({ ok: true, deleted: r.deleted });
    } catch (e) { fail(res, e, next); }
  });
}
