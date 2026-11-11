/**
 * routes/api/psInspect.js — PowerScale 장비 점검(독립 도구 `ps-inspect` — 세그먼트 = 키 · v2.964 · 설계 docs/design/powerscale-inspection).
 *
 * 게이트(사용자 결정 '전체 범위 계정만'):
 *  · 조회 = tools 권한 + 전체 범위(fullScopeOnly) — 스토리지 모니터링 · SAN 스토리지 성능과 같다. 비관리자 판본은 장비 이름이 주소이면 가리고(view.js) ·
 *    받는 사람 메일은 개수만 · 설정한 계정명(updatedBy)은 뺀다 · 발송 기록 문구 속 메일 주소를 가린다(isAdminReq = demoGuest.isAdminDetailUser 하나).
 *  · '지금 점검'(장비에 명령을 보낸다) · 설정 저장 · 지금 보내기 = admin + 조회 · 쓰기 모두 전체 범위(fullRwOnly) + 감사 로그. 수집 '지금 수집' 이 adminOnly 인 것과 같은 급.
 *  · CSV 는 data.csv 권한(csvGate2643 규약). 데모 손님은 데모 장비만(isDemoId — 다른 스토리지 라우트와 같은 규칙).
 *  · 장비 호출은 '지금 점검' 뿐 — 조회는 이력 · 스냅샷 · 노드 부하 DB 만 읽는다. 폴링하지 않는 화면(마운트 1회 + 버튼)을 전제로 응답을 캐시하지 않는다.
 */
import { requireRole, requirePerm } from '../../auth/auth.js';
import { fullScopeOnlyWith, fullReadWriteScopeOnlyWith } from '../admin/shared.js';
import { logAudit } from '../../audit.js';
import { isAdminReq } from '../../auth/addressMask.js';
import { isDemoGuest } from '../../auth/demoGuest.js';
import { isDemoId } from '../../mock/demo/storage.js';
import { ITEMS, GROUPS, STATUS_KO, REFS, REF_LEVEL_KO, REVIEW_ITEMS, ACTIONS, SOURCES_NOTE, THRESHOLD_DEFAULTS } from '../../storage/inspect/catalog.js';
import { SSH_CMDS, REST_PATHS, INSPECT_TIMEOUT_MS, SSH_BUDGET_MS, inspectRunnerStatus } from '../../storage/inspect/runner.js';
import { buildInspectModel, buildDeviceDetail, buildTopNodes } from '../../storage/inspect/view.js';
import { reportCsv } from '../../storage/inspect/report.js';
import { loadSettings, saveSettings, settingsLoadError, inspectScheduleStatus, startInspection, buildReport, sendReportNow } from '../../storage/inspect/schedule.js';
import { recentInspectDrops } from '../../storage/inspect/requests.js';
import { inspectStoreStatus } from '../../storage/inspect/store.js';

const toolsPerm = requirePerm('tools');
const adminOnly = requireRole('admin');
const csvPerm = requirePerm('data.csv');
const fullScopeOnly = fullScopeOnlyWith('PowerScale 장비 점검은 전체 범위(vCenter 제한 없는) 계정만 조회할 수 있습니다.');
const fullRwOnly = fullReadWriteScopeOnlyWith('PowerScale 점검 실행 · 설정 변경 · 보고서 발송은 조회 · 쓰기 모두 전체 범위(vCenter 제한 없는) 관리자만 할 수 있습니다.');
const MAIL_RE = /[^\s<>@,;:"'()[\]]+@[^\s<>@,;:"'()[\]]+/g;
const scrubMail = (v) => (typeof v === 'string' ? v.slice(0, 400).replace(MAIL_RE, '(메일 가림)') : v);
const filterOf = (req) => (isDemoGuest(req.user) ? (id) => isDemoId(id) : null);

/** 설정 비관리자 판본 — 받는 사람은 개수만 · 계정명 뺌. */
export function settingsView(s, admin) {
  if (admin || !s || typeof s !== 'object') return s;
  const { updatedBy: _u, to, corpTo, ...rest } = s; void _u;
  return { ...rest, to: [], toCount: Array.isArray(to) ? to.length : 0, corpTo: {}, corpToCount: Object.fromEntries(Object.entries(corpTo || {}).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0])), toHidden: true };
}
/** 회차 · 발송 기록 비관리자 판본 — 문구 속 메일 주소 가림. */
export function scheduleView(st, admin) {
  if (admin || !st || typeof st !== 'object') return st;
  const hist = (Array.isArray(st.history) ? st.history : []).map((h) => (h && typeof h === 'object' ? { ...h, ...(h.reason ? { reason: scrubMail(h.reason) } : {}),
    ...(Array.isArray(h.results) ? { results: h.results.map((r) => ({ ...r, ...(r.reason ? { reason: scrubMail(r.reason) } : {}) })) } : {}) } : h));
  return { ...st, settings: settingsView(st.settings, false), history: hist };
}

export function registerPsInspect(api) {
  /** 정적 표 — 항목 · 구분 · 참고 자료 · 세부 점검 · 조치 · 실행하는 명령(읽기 전용 목록 그대로 — 화면 '읽는 방법' · 근거 보기). */
  api.get('/tools/ps-inspect/catalog', toolsPerm, fullScopeOnly, (req, res) => {
    res.json({ ok: true, items: ITEMS, groups: GROUPS, statusKo: STATUS_KO, refs: REFS, refLevelKo: REF_LEVEL_KO, review: REVIEW_ITEMS, actions: ACTIONS, sourcesNote: SOURCES_NOTE,
      thresholdDefaults: THRESHOLD_DEFAULTS, commands: { ssh: SSH_CMDS.map((c) => ({ key: c.key, cmd: c.cmd, ...(c.fallback ? { fallback: c.fallback } : {}) })), rest: REST_PATHS },
      timeoutMs: INSPECT_TIMEOUT_MS, sshBudgetMs: SSH_BUDGET_MS });
  });

  /** 법인별 현황 — 장비마다 최신 점검 판정 · 구분 대표 상태 · 지난번 대비 · 편중. */
  api.get('/tools/ps-inspect', toolsPerm, fullScopeOnly, async (req, res) => {
    const admin = isAdminReq(req);
    const cfg = loadSettings();
    const model = await buildInspectModel({ admin, thresholds: cfg.thresholds, filter: filterOf(req) });
    res.json({ ok: true, ...model, schedule: scheduleView(inspectScheduleStatus(), admin), runner: inspectRunnerStatus(), store: inspectStoreStatus(),
      drops: recentInspectDrops(), settingsUnreadable: !!settingsLoadError() });
  });

  /** 장비 하나 — 20항목 + 최근 10회 구분별 비교. */
  api.get('/tools/ps-inspect/devices/:id', toolsPerm, fullScopeOnly, async (req, res) => {
    const id = String(req.params.id || '').slice(0, 128);
    const f = filterOf(req);
    if (f && !f(id)) return res.status(404).json({ ok: false, error: 'not-found' });
    const cfg = loadSettings();
    const d = await buildDeviceDetail(id, { admin: isAdminReq(req), thresholds: cfg.thresholds });
    if (!d) return res.status(404).json({ ok: false, error: 'not-found', reason: '점검 대상(활성 아이실론)이 아닙니다' });
    res.json({ ok: true, device: d });
  });

  /** Top N 노드 편중 — range 24h · 7d · 30d · metric ops · net · busy · cpu. */
  api.get('/tools/ps-inspect/top-nodes', toolsPerm, fullScopeOnly, async (req, res) => {
    const range = ['24h', '7d', '30d'].includes(String(req.query.range)) ? String(req.query.range) : '7d';
    const metric = ['ops', 'net', 'busy', 'cpu'].includes(String(req.query.metric)) ? String(req.query.metric) : 'ops';
    const n = Number(req.query.limit);
    const limit = Number.isFinite(n) && n >= 1 && n <= 50 ? Math.floor(n) : 10;
    const cfg = loadSettings();
    res.json({ ok: true, ...(await buildTopNodes({ range, metric, limit, admin: isAdminReq(req), thresholds: cfg.thresholds, filter: filterOf(req) })) });
  });

  /** 주간 보고서 — format=json(모델 · 메일 조각) | html(자급형 — 브라우저에서 인쇄 › PDF). corp 를 주면 그 법인판. */
  api.get('/tools/ps-inspect/report', toolsPerm, fullScopeOnly, async (req, res) => {
    const corp = req.query.corp != null && String(req.query.corp) !== '' ? String(req.query.corp).slice(0, 64) : null;
    const b = await buildReport({ corp, admin: false, filter: filterOf(req) }); // 보고서는 메일과 같은 판본(주소 가림)
    if (String(req.query.format || 'json') === 'html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      // 파일 이름에 한글(주차 · 법인)이 든다 — 헤더는 ASCII 만 받으므로 대체 이름 + RFC 5987 filename* 로(그대로 넣으면 500).
      res.setHeader('Content-Disposition', `attachment; filename="powerscale-inspect.html"; filename*=UTF-8''${encodeURIComponent(b.parts.filename)}`);
      return res.send(b.html);
    }
    res.json({ ok: true, model: b.model, subject: b.parts.subject, filename: b.parts.filename });
  });

  api.get('/tools/ps-inspect/report.csv', toolsPerm, fullScopeOnly, csvPerm, async (req, res) => {
    const cfg = loadSettings();
    const model = await buildInspectModel({ admin: isAdminReq(req), thresholds: cfg.thresholds, filter: filterOf(req) });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="powerscale-inspect.csv"');
    res.send(reportCsv(model));
  });

  /** 지금 점검 — ids 없으면 전부. 중앙 직접 장비는 바로, 위임 장비는 그 엣지 요청 큐(다음 설정 pull 때 · 결과는 다음 push). */
  api.post('/tools/ps-inspect/run', adminOnly, fullRwOnly, (req, res) => {
    const raw = req.body?.ids;
    const ids = Array.isArray(raw) ? raw.slice(0, 200).filter((x) => typeof x === 'string' || typeof x === 'number').map((x) => String(x).slice(0, 128)) : null;
    if (Array.isArray(raw) && !ids.length) return res.status(400).json({ ok: false, reason: 'ids 는 장비 id 목록입니다' });
    const r = startInspection({ ids, reason: 'manual' });
    logAudit({ user: req.user?.username, action: 'PowerScale 장비 점검 지금 실행', target: 'storage-inspect', detail: `${ids ? `장비 ${ids.length}대 지정` : '전체'} · 이 포탈 ${r.local} · 엣지 요청 ${r.queued}${r.unknown.length ? ` · 대상 아님 ${r.unknown.length}` : ''}` });
    res.status(202).json({ ok: true, ...r });
  });

  api.put('/tools/ps-inspect/settings', adminOnly, fullRwOnly, (req, res) => {
    const r = saveSettings(req.body || {}, { by: req.user?.username || '' });
    if (r.issue) return res.status(400).json({ ok: false, reason: r.issue });
    const s = r.settings;
    logAudit({ user: req.user?.username, action: 'PowerScale 장비 점검 설정 변경', target: 'storage-inspect.json',
      detail: `점검 ${s.enabled ? '켬' : '끔'} · 요일 ${s.weekday} ${s.time} · 메일 ${s.mailEnabled ? `켬(+${s.mailDelayMin}분)` : '끔'} · 받는 사람 ${s.to.length} · 법인판 ${Object.keys(s.corpTo).length}` });
    res.json({ ok: true, settings: s });
  });

  api.post('/tools/ps-inspect/report/send-now', adminOnly, fullRwOnly, async (req, res) => {
    const r = await sendReportNow(req.user?.username || 'admin');
    logAudit({ user: req.user?.username, action: 'PowerScale 주간 점검 보고서 지금 보내기', target: 'storage-inspect.json', detail: `${r.state}${r.reason ? ` · ${String(r.reason).slice(0, 120)}` : ''}${r.sent != null ? ` · 보냄 ${r.sent}/${r.jobs}` : ''}` });
    res.status(r.ok ? 200 : 409).json(r);
  });
}
