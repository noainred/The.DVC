/**
 * routes/api/periodicReport.js — 정기 점검 보고(도구 `periodic-report` — 세그먼트 = 키 · 설계 docs/design/periodic-report · v3.31).
 *
 * 게이트(설계 §4.6):
 *  · 조회(보관함 · 보고서 · 카탈로그 · 상태) = tools 권한. **범위 계정은 자기 법인 행만**(rules.scopeCutDoc — 법인 행이 없는 포탈 자체 항목은 싣지 않는다) ·
 *    목록의 판정 수도 범위로 다시 센다(회차 행렬 — 문서를 읽지 않는다). 전달 기록 문구 속 메일 주소는 비관리자 판본에서 가린다.
 *  · 설정 조회 = 전체 범위(fullScopeOnly) — 받는 사람 주소는 관리자 판본만(그 밖은 수만).
 *  · 설정 저장 · 지금 만들기 · 미리보기 보관 · 다시 보내기 = admin + 조회 · 쓰기 모두 전체 범위(fullRwOnly) + 감사 로그.
 *  · XLSX 내려받기 = data.csv 권한(csvGate2643 규약) + 서버 전체 동시 1건(exportBusy).
 * 화면은 폴링하지 않는다(마운트 1회 + 버튼 · 생성 중일 때만 상태 조회).
 */
import ExcelJS from 'exceljs';
import { requireRole, requirePerm } from '../../auth/auth.js';
import { scopedVcenterIds } from '../../auth/scope.js';
import { fullScopeOnlyWith, fullReadWriteScopeOnlyWith } from '../admin/shared.js';
import { isAdminReq } from '../../auth/addressMask.js';
import { logAudit } from '../../audit.js';
import { store } from '../../store.js';
import { acquireExport } from '../../util/exportBusy.js';
import { KINDS, KIND_LABEL, STATUS_LABEL, RUN_ID_RE, scopeCutDoc, scopedCountsFromMatrix, actionsOf, unknownsOf } from '../../periodic/rules.js';
import { AXES } from '../../periodic/catalog.js';
import { renderReportHtml, corpNamer, corpMatrix, stamp, attachmentName } from '../../periodic/render.js';
import * as svc from '../../periodic/service.js';
import * as pdb from '../../periodic/db.js';

const toolsPerm = requirePerm('tools');
const csvPerm = requirePerm('data.csv');
const adminOnly = requireRole('admin');
const fullScopeOnly = fullScopeOnlyWith('정기 점검 보고의 일정 · 전달 설정은 전체 범위(vCenter 제한 없는) 계정만 볼 수 있습니다.');
const fullRwOnly = fullReadWriteScopeOnlyWith('정기 점검 보고 만들기 · 설정 변경 · 다시 보내기는 조회 · 쓰기 모두 전체 범위(vCenter 제한 없는) 관리자만 할 수 있습니다.');
const MAIL_RE = /[^\s<>@,;:"'()[\]]+@[^\s<>@,;:"'()[\]]+/g;
const scrubMail = (v) => (typeof v === 'string' ? v.slice(0, 400).replace(MAIL_RE, '(메일 가림)') : v);
const DAY = 86_400_000;

const allowedOf = (req) => scopedVcenterIds(req.user, store.get());
const numQ = (v, d) => { const x = Number(v); return Number.isFinite(x) ? x : d; };

/** 설정 비관리자 판본 — 받는 사람 주소는 수만 · 바꾼 사람 계정명 뺌. */
export function settingsView(s, admin) {
  if (!s || admin) return s;
  const { updatedBy: _u, ...rest } = s; void _u;
  return { ...rest, mail: { ...s.mail, to: [], toCount: (s.mail?.to || []).length, corpTo: {}, corpToCount: Object.keys(s.mail?.corpTo || {}).length, toHidden: true } };
}
/** 상태 판본 — 기록 문구 속 메일 주소 가림(비관리자). */
function statusView(st, admin) {
  if (admin || !st) return st;
  return { ...st, history: (st.history || []).map((h) => ({ ...h, ...(h.reason ? { reason: scrubMail(h.reason) } : {}) })), lastError: st.lastError ? { ...st.lastError, message: scrubMail(st.lastError.message) } : null };
}
/** 회차 문서를 요청자 범위로 자르고 화면이 쓸 묶음(조치 · 확인 불가 · 법인 표)을 붙인다. */
function docFor(req, doc) {
  const allowed = allowedOf(req);
  const view = allowed ? scopeCutDoc(doc, allowed) : doc;
  const name = corpNamer(view);
  const out = { ...view, actions: actionsOf(view, name), unknowns: unknownsOf(view, name), corpTable: corpMatrix(view) };
  if (!isAdminReq(req) && out.manual) out.by = '(수동)';   // 만든 계정명은 관리자 판본만
  return out;
}

export function registerPeriodicReport(api) {
  /** 상태 — 주기별 다음 · 마지막 회차 · 진행 · 재시도 · DB. */
  api.get('/tools/periodic-report/status', toolsPerm, async (req, res) => {
    const st = await svc.status();
    const allowed = allowedOf(req);
    // 범위 계정 — 주기별 마지막 회차의 종합 · 판정 수는 전 법인 값이라 싣지 않는다(회차 ID · 시각만 · 수는 보관함이 범위로 다시 센다).
    const kinds = allowed ? Object.fromEntries(Object.entries(st.kinds || {}).map(([k, v]) => [k, { ...v, last: v.last ? { id: v.last.id, kind: v.last.kind, generatedAt: v.last.generatedAt, manual: v.last.manual } : null }])) : st.kinds;
    res.json({ ok: true, ...statusView(st, isAdminReq(req)), kinds, scoped: !!allowed, ...(allowed ? { history: [], recipients: null, lastError: null } : {}) });
  });

  /** 점검 항목 카탈로그(재정의 반영). */
  api.get('/tools/periodic-report/catalog', toolsPerm, (req, res) => {
    res.json({ ok: true, axes: AXES, kinds: KINDS.map((k) => ({ key: k, label: KIND_LABEL[k] })), statusLabel: STATUS_LABEL, ...svc.catalog() });
  });

  /** 보관함 — 범위 계정은 판정 수를 자기 범위로 다시 센다. */
  api.get('/tools/periodic-report/runs', toolsPerm, async (req, res) => {
    const kind = KINDS.includes(String(req.query.kind)) ? String(req.query.kind) : '';
    const days = Math.min(3650, Math.max(1, numQ(req.query.days, 90)));
    const to = Date.now() + DAY; const from = Date.now() - days * DAY;
    const limit = Math.min(200, Math.max(1, numQ(req.query.limit, 50)));
    const offset = Math.max(0, numQ(req.query.offset, 0));
    const r = await pdb.listRuns({ kind, from, to, limit, offset });
    if (!r) return res.status(503).json({ ok: false, code: 'db-unavailable', reason: `보관 DB 를 열지 못했습니다: ${pdb.periodicDbError() || '사유 미상'}` });
    const allowed = allowedOf(req);
    const admin = isAdminReq(req);
    const runs = r.runs.map(({ matrix, ...row }) => {
      if (!allowed) return { ...row, ...(admin ? {} : { by: row.manual ? '(수동)' : row.by }) };
      const sc = scopedCountsFromMatrix(matrix, allowed);
      const corps = Object.keys(matrix?.vc || {}).filter((v) => allowed.has(v)).length;
      return { ...row, by: row.manual ? '(수동)' : row.by, counts: sc.counts, overall: sc.overall, corpsTotal: corps, corpsReported: null, scoped: true };
    });
    res.json({ ok: true, runs, total: r.total, days, kind });
  });

  /** 회차 하나 — 범위로 자른 문서 + 조치 · 확인 불가 · 법인 표 + 전달 기록. */
  api.get('/tools/periodic-report/runs/:id', toolsPerm, async (req, res) => {
    const id = String(req.params.id || '');
    if (!RUN_ID_RE.test(id)) return res.status(400).json({ ok: false, reason: '회차 ID 형식이 아닙니다' });
    const got = await pdb.getRun(id);
    if (got == null) return res.status(503).json({ ok: false, code: 'db-unavailable', reason: `보관 DB 를 열지 못했습니다: ${pdb.periodicDbError() || '사유 미상'}` });
    if (!got.run?.doc) return res.status(404).json({ ok: false, reason: '회차를 찾지 못했습니다' });
    const doc = docFor(req, got.run.doc);
    if (allowedOf(req) && !doc.items.length) return res.status(404).json({ ok: false, reason: '회차를 찾지 못했습니다' });
    const admin = isAdminReq(req);
    const deliveries = allowedOf(req) ? [] : ((await pdb.deliveriesOfRun(id)) || []).map((d) => (admin ? d : { ...d, reason: scrubMail(d.reason), target: d.channel === 'mail' && d.target !== 'overall' ? '(법인판)' : d.target }));
    res.json({ ok: true, run: doc, deliveries });
  });

  /** 자급형 HTML 보고서(내려받기 — 브라우저에서 인쇄 › PDF). 범위 계정은 자기 법인판. */
  api.get('/tools/periodic-report/runs/:id/report.html', toolsPerm, async (req, res) => {
    const id = String(req.params.id || '');
    if (!RUN_ID_RE.test(id)) return res.status(400).json({ ok: false, reason: '회차 ID 형식이 아닙니다' });
    const got = await pdb.getRun(id);
    if (got == null) return res.status(503).json({ ok: false, code: 'db-unavailable' });
    if (!got.run?.doc) return res.status(404).json({ ok: false, reason: '회차를 찾지 못했습니다' });
    const allowed = allowedOf(req);
    const view = allowed ? scopeCutDoc(got.run.doc, allowed) : got.run.doc;
    if (allowed && !view.items.length) return res.status(404).json({ ok: false, reason: '회차를 찾지 못했습니다' });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${attachmentName(got.run.doc)}"`);
    res.send(renderReportHtml(view, { scopedNote: allowed ? '내 범위(법인) 판 — 볼 수 있는 법인 행만 담았습니다.' : '' }));
  });

  /** XLSX(요약 · 조치 필요 · 법인별 · 항목 · 확인하지 못한 것). */
  api.get('/tools/periodic-report/runs/:id/export.xlsx', toolsPerm, csvPerm, async (req, res) => {
    const id = String(req.params.id || '');
    if (!RUN_ID_RE.test(id)) return res.status(400).json({ ok: false, reason: '회차 ID 형식이 아닙니다' });
    const lock = acquireExport('periodic-report-xlsx', req);
    if (!lock.ok) return res.status(lock.status || 409).json(lock.body);
    try {
      const got = await pdb.getRun(id);
      if (got == null) return res.status(503).json({ ok: false, code: 'db-unavailable' });
      if (!got.run?.doc) return res.status(404).json({ ok: false, reason: '회차를 찾지 못했습니다' });
      const doc = docFor(req, got.run.doc);
      if (allowedOf(req) && !doc.items.length) return res.status(404).json({ ok: false, reason: '회차를 찾지 못했습니다' });
      const name = corpNamer(doc);
      const wb = new ExcelJS.Workbook();
      const add = (title, cols, rows) => { const ws = wb.addWorksheet(title); ws.columns = cols.map(([h, w]) => ({ header: h, width: w })); for (const r of rows) ws.addRow(r); ws.getRow(1).font = { bold: true }; ws.views = [{ state: 'frozen', ySplit: 1 }]; };
      add('요약', [['항목', 24], ['값', 60]], [['회차', doc.id], ['주기', KIND_LABEL[doc.kind]], ['기간', doc.periodLabel], ['생성', stamp(doc.generatedAt)], ['종합', STATUS_LABEL[doc.overall]],
        ['정상', doc.counts.ok], ['주의', doc.counts.warn], ['이상', doc.counts.crit], ['확인 불가', doc.counts.unknown], ['정보', doc.counts.info], ['법인(보고 / 전체)', `${doc.corpsReported ?? '—'} / ${doc.corpsTotal}`]]);
      add('조치 필요', [['판정', 10], ['법인', 18], ['축', 10], ['항목', 30], ['근거', 80]], doc.actions.map((a) => [STATUS_LABEL[a.status], a.corp, AXES.find((x) => x.key === a.axis)?.label || a.axis, a.label, a.basis]));
      add('법인별', [['법인', 20], ['vCenter', 20], ...AXES.map((a) => [a.label, 10]), ['확인 불가', 10], ['조치', 8]], doc.corpTable.map((c) => [c.dcName || c.name, c.name, ...AXES.map((a) => (c.axes[a.key] ? STATUS_LABEL[c.axes[a.key]] : '—')), c.unknown, c.actions]));
      const itemRows = [];
      for (const it of doc.items) {
        itemRows.push([AXES.find((x) => x.key === it.axis)?.label || it.axis, it.label, '(전체)', STATUS_LABEL[it.status], it.basis || it.value || '', it.unknownReason || '']);
        for (const r of it.rows || []) itemRows.push([AXES.find((x) => x.key === it.axis)?.label || it.axis, it.label, name(r.vc), STATUS_LABEL[r.status], r.text || '', '']);
      }
      add('항목', [['축', 10], ['항목', 30], ['법인', 18], ['판정', 10], ['근거', 80], ['확인 불가 사유', 40]], itemRows);
      add('확인하지 못한 것', [['항목', 30], ['범위', 30], ['사유', 60], ['확인하려면', 60]], doc.unknowns.map((u) => [u.label, u.where, u.reason, u.fix || '']));
      const buf = await wb.xlsx.writeBuffer();
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${attachmentName(got.run.doc).replace(/\.html$/, '.xlsx')}"`);
      res.send(Buffer.from(buf));
    } finally { lock.release?.(); }
  });

  /** 설정 — 전체 범위만(받는 사람 주소는 관리자 판본). */
  api.get('/tools/periodic-report/settings', toolsPerm, fullScopeOnly, (req, res) => {
    const s = svc.loadSettings();
    const err = svc.settingsError();
    res.json({ ok: !!s, settings: settingsView(s, isAdminReq(req)), settingsUnreadable: !s, ...(err ? { loadError: { reason: scrubMail(err.reason), readError: !!err.readError } } : {}) });
  });

  api.put('/tools/periodic-report/settings', adminOnly, fullRwOnly, (req, res) => {
    const r = svc.saveSettings(req.body || {}, { by: req.user?.username || null });
    if (r.error) return res.status(r.code === 'settings-unreadable' ? 409 : 400).json({ ok: false, reason: r.error, field: r.field, ...(r.code ? { code: r.code } : {}) });
    const s = r.settings;
    logAudit({ user: req.user?.username, action: '정기 점검 보고 설정 변경', target: 'periodic-report.json',
      detail: `${KINDS.map((k) => `${KIND_LABEL[k]} ${s.kinds[k].enabled ? s.kinds[k].time : '끔'}`).join(' · ')} · 메일 ${s.mail.enabled ? `켬(추가 ${s.mail.to.length} · 법인판 ${Object.keys(s.mail.corpTo).length})` : '끔'} · 채널 ${s.chat.enabled ? '켬' : '끔'} · 공지 ${s.notice.enabled ? '켬' : '끔'} · 이슈 ${s.issues.enabled ? '켬' : '끔'} · 항목 재정의 ${Object.keys(s.items).length}` });
    res.json({ ok: true, settings: s });
  });

  /** 지금 만들기 — preview:true 면 보관 · 전달 없이(10분 보관 미리보기). */
  api.post('/tools/periodic-report/run', adminOnly, fullRwOnly, async (req, res) => {
    const kind = String(req.body?.kind || '');
    if (!KINDS.includes(kind)) return res.status(400).json({ ok: false, reason: '주기는 일일 · 주간 · 월간 · 분기 중 하나입니다.' });
    const preview = req.body?.preview === true;
    const r = await svc.generateRun({ kind, manual: !preview, preview, by: req.user?.username || 'admin' });
    logAudit({ user: req.user?.username, action: preview ? '정기 점검 보고 미리보기' : '정기 점검 보고 지금 만들기', target: 'periodic-report', detail: `${KIND_LABEL[kind]} · ${r.ok ? (r.id || r.previewId) : `실패 — ${String(r.reason || '').slice(0, 120)}`}` });
    if (!r.ok) return res.status(r.code === 'busy' ? 409 : r.code === 'db-unavailable' ? 503 : 400).json({ ok: false, reason: r.reason, code: r.code });
    res.json({ ok: true, id: r.id || null, previewId: r.previewId || null, ...(preview ? { run: docFor(req, r.doc), html: renderReportHtml(r.doc, { preview: true }) } : {}) });
  });

  api.post('/tools/periodic-report/preview/:pid/keep', adminOnly, fullRwOnly, async (req, res) => {
    const r = await svc.keepPreview(String(req.params.pid || '').slice(0, 40), { by: req.user?.username || 'admin' });
    logAudit({ user: req.user?.username, action: '정기 점검 보고 미리보기 보관 · 보내기', target: 'periodic-report', detail: r.ok ? r.id : `실패 — ${String(r.reason || '').slice(0, 120)}` });
    if (!r.ok) return res.status(r.code === 'expired' ? 404 : 400).json({ ok: false, reason: r.reason, code: r.code });
    res.json({ ok: true, id: r.id });
  });

  /** 다시 보내기 — 실패 · 재시도 대기 경로(또는 지정한 경로). backoff 를 기다리지 않는다. */
  api.post('/tools/periodic-report/runs/:id/deliver', adminOnly, fullRwOnly, async (req, res) => {
    const id = String(req.params.id || '');
    if (!RUN_ID_RE.test(id)) return res.status(400).json({ ok: false, reason: '회차 ID 형식이 아닙니다' });
    const channel = ['mail', 'chat', 'notice', 'issues'].includes(String(req.body?.channel || '')) ? String(req.body.channel) : '';
    const r = await svc.redeliver(id, { channel });
    logAudit({ user: req.user?.username, action: '정기 점검 보고 다시 보내기', target: 'periodic-report', detail: `${id}${channel ? ` · ${channel}` : ''} · ${r.ok ? '성공' : `결과 ${String(r.reason || (r.results || []).map((x) => x.state).join(',')).slice(0, 120)}`}` });
    res.status(r.code === 'not-found' ? 404 : r.code === 'db-unavailable' ? 503 : 200).json(r);
  });
}
