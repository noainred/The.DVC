/**
 * routes/api/toolsGuestPart.js — 게스트 파티션 사용률 경보 API(v2.749).
 *
 * 조회(tools 권한): 범위(scopedVcenterIds)를 **판정·요청 필터보다 먼저** 적용한다 — 범위 계정은 자기 vCenter 의 게스트만 보고,
 *   범위 밖 vCenter 를 지정하면 404(존재 은닉). 화면 필터(vcenterId·검색·OS)는 범위 안에서만 좁힌다.
 * 설정·메일(관리자 + 전체 범위): 무시 규칙·임계·메일 받는 사람은 전 법인 공용이라 범위 계정의 저장을 받지 않는다(403).
 *   메일 주소·보내는 사람은 관리자 판본(isAdminDetailUser)에만 싣는다.
 * 수집 켜기·주기·지금 수집은 게스트 디스크 회수와 같은 수집이라 그쪽 API(/tools/guest-disk/settings · /run)를 쓴다(설정 한 곳).
 */
import { scopedVcenterIds, inUserScope } from '../../auth/scope.js';
import { requireRole, requirePerm } from '../../auth/auth.js';
import { isAdminDetailUser, isDemoGuest } from '../../auth/demoGuest.js';
import { redactSystemLogLine } from '../../edgelog/redact.js';   // 보안 잔여 11-27 L7 반증 3회차 — 데모 판본의 실패 사유 속 메일 주소
import { logAudit } from '../../audit.js';
import { store } from '../../store.js';
import { fullScopeOnlyWith } from '../admin/shared.js';
import { overview, overviewSummary, vcenterDetail, overCsv, vmPartitions } from '../../guestpart/report.js';
import { isSummaryQuery } from './toolSummary.js';   // v3.21.0 VM 분석 화면 요약 — 같은 라우트 · 같은 게이트 안에서
import { load as loadSettings, save as saveSettings, publicSettings, settingsLoadError, guestPartWriteRefusal } from '../../guestpart/settings.js';
import { unreadMark } from '../settingsUnreadMark.js';   // 112회차: 조회 응답의 읽기 오류 표지
import { thresholdOk, MODES, RANGES, IGNORE_TEXT, CRIT_PCT, WIN_ISO_MAX_GB } from '../../guestpart/rules.js';
import { mailStatus, previewMail, sendDigest, sendVcenter, sendTest } from '../../guestpart/notify.js';
import { load as loadGuestDiskSettings } from '../../guestdisk/settings.js';
import { load as loadMailCfg } from '../../mail/settings.js';
import { todayStamp } from '../../util/dayKey.js';
import { textFields, listOrText } from '../../util/coercionTrap.js';   // 163회차: 본문 값이 객체 · 배열이면 String()/Number()/.trim() 이 던져 500 이었다 — 400

const csvPerm = requirePerm('data.csv');
const toolsPerm = requirePerm('tools');
const adminOnly = requireRole('admin');
const fullScopeOnly = fullScopeOnlyWith('게스트 파티션 사용률의 설정·메일은 전 법인 공용이라 전체 범위(vCenter 제한 없는) 관리자만 바꿀 수 있습니다.');

/** 화면 조건(쿼리) — 틀린 값은 무시하지 않고 400 이유로 돌려준다. */
function viewQuery(q) {
  const out = { thr: null, mode: null, issue: null };
  if (q.thr != null && q.thr !== '') { out.thr = thresholdOk(q.thr); if (out.thr == null) out.issue = `임계는 ${RANGES.threshold.min}~${RANGES.threshold.max} 사이의 정수여야 합니다.`; }
  if (q.mode != null && q.mode !== '') { if (MODES.includes(q.mode)) out.mode = q.mode; else out.issue = "판정 단위는 'part' 또는 'vm' 입니다."; }
  return out;
}

const meta = () => ({ rangeThr: RANGES.threshold, rangeTinyGB: RANGES.tinyGB, critPct: CRIT_PCT, ignoreText: IGNORE_TEXT, winIsoMaxGB: WIN_ISO_MAX_GB });

export function registerToolsGuestPart(api) {
  // v2.750 VM 상세 창의 '게스트 파티션 사용량' — VM 상세와 같은 권한(inv.vms)이다(특수 기능 도구가 아니라 그 VM 의 속성).
  //   VM 은 스냅샷에서 id 로 찾고 범위 밖이면 404(존재 은닉) — 수집 DB 의 vCenter 가 아니라 **스냅샷의** vCenter 로 판정한다.
  //   무시 규칙은 사유 문구만 싣는다(패턴 원문·메일 설정은 싣지 않는다).
  api.get('/vms/:id/partitions', requirePerm('inv.vms'), async (req, res) => {
    const snap = store.get();
    const vm = (snap.vms || []).find((v) => v.id === String(req.params.id));
    if (!vm || !inUserScope(req.user, snap, vm.vcenterId)) return res.status(404).json({ ok: false, reason: 'VM을 찾을 수 없습니다.' });
    res.json(await vmPartitions(vm));
  });

  api.get('/tools/guest-partition', toolsPerm, async (req, res) => {
    const allowed = scopedVcenterIds(req.user, store.get());
    const v = viewQuery(req.query);
    if (v.issue) return res.status(400).json({ ok: false, reason: v.issue });
    // v3.21.0: ?summary=1 — 법인별 줄 + 법인별 상위 N(VM 분석 화면). 게이트(tools · toolGate 'guest-partition')와 범위는 이 라우트 그대로다.
    //   화면 조건(vcenterId · 검색 · OS · limit)은 보지 않는다 — 범위 안 법인 전부의 줄을 주고 화면이 고른 법인을 더한다.
    if (isSummaryQuery(req.query)) return res.json({ ok: true, summary: true, tool: 'guest-partition', ...(await overviewSummary({ allowed, thr: v.thr, mode: v.mode })) });
    const vcenterId = req.query.vcenterId ? String(req.query.vcenterId) : null;
    if (vcenterId && allowed && !allowed.has(vcenterId)) return res.status(404).json({ ok: false, error: 'not found' });
    const os = ['win', 'lnx', 'other'].includes(req.query.os) ? req.query.os : 'all';
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 300));
    const r = await overview({ allowed, thr: v.thr, mode: v.mode, vcenterId, q: String(req.query.q || '').slice(0, 100), os, limit });
    const s = loadSettings();
    res.json({ ok: true, ...r, settings: publicSettings(s, allowed), meta: meta(), settingsLoadError: settingsLoadError() ? true : undefined });
  });

  api.get('/tools/guest-partition/vcenter/:id', toolsPerm, async (req, res) => {
    const allowed = scopedVcenterIds(req.user, store.get());
    const v = viewQuery(req.query);
    if (v.issue) return res.status(400).json({ ok: false, reason: v.issue });
    const r = await vcenterDetail(req.params.id, { allowed, thr: v.thr, mode: v.mode, onlyOver: req.query.all !== '1' });
    if (!r) return res.status(404).json({ ok: false, error: 'not found' });
    res.json({ ok: true, ...r, settings: publicSettings(undefined, allowed), meta: meta() });
  });

  api.get('/tools/guest-partition/export.csv', csvPerm, toolsPerm, async (req, res) => {
    const allowed = scopedVcenterIds(req.user, store.get());
    const v = viewQuery(req.query);
    if (v.issue) return res.status(400).json({ ok: false, reason: v.issue });
    const vcenterId = req.query.vcenterId ? String(req.query.vcenterId) : null;
    if (vcenterId && allowed && !allowed.has(vcenterId)) return res.status(404).json({ ok: false, error: 'not found' });
    const os = ['win', 'lnx', 'other'].includes(req.query.os) ? req.query.os : 'all';
    const r = await overview({ allowed, thr: v.thr, mode: v.mode, vcenterId, q: String(req.query.q || '').slice(0, 100), os, all: true });
    logAudit({ user: req.user?.username, action: '게스트 파티션 사용률 CSV 내보내기', detail: `${r.rows.length}행${vcenterId ? ` · ${vcenterId}` : ''}`, ip: req.ip || '' });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="guest-partition-over-${todayStamp()}.csv"`);
    res.send(overCsv(r));
  });

  // 설정 — 관리자(전체 범위)는 전체(메일 포함), 그 밖은 판정 기준만.
  api.get('/tools/guest-partition/settings', toolsPerm, (req, res) => {
    const allowed = scopedVcenterIds(req.user, store.get());
    const full = isAdminDetailUser(req.user) && !allowed;
    const gd = loadGuestDiskSettings();
    res.json({ ok: true, settings: full ? loadSettings() : publicSettings(undefined, allowed), full, collect: { enabled: gd.enabled, intervalHours: gd.intervalHours }, meta: meta(),
      // 112회차: 읽기 오류(107회차 — 원본을 옮기지 않는다)인데도 '.corrupt 로 보존했습니다' 라고 말했다 — 문구를 가르고, 화면이 저장을 잠그게 표지(settingsLoadError.readError)를 싣는다.
      loadError: settingsLoadError() ? (guestPartWriteRefusal() ? '설정 파일을 읽지 못해 기본값으로 보여 줍니다 — 읽기 오류이고 원본은 그대로 있습니다.' : '설정 파일을 읽지 못해 기본값으로 보여 줍니다 — 원본은 .corrupt 로 보존했습니다.') : null,
      ...unreadMark(guestPartWriteRefusal(), 'settingsLoadError') });
  });

  api.put('/tools/guest-partition/settings', adminOnly, fullScopeOnly, (req, res) => {
    const r = saveSettings(req.body || {});
    if (r.error) return res.status(r.status === 503 ? 503 : 400).json({ ok: false, reason: r.error, field: r.field || null, ...(r.status === 503 ? { code: r.code, readError: true } : {}) });   // 107회차: 설정 파일 읽기 오류는 503 settingsUnreadable
    const s = r.settings;
    logAudit({ user: req.user?.username, action: '게스트 파티션 사용률 설정 변경', detail: `임계 ${s.threshold}% · ${s.mode} · vCenter 별 임계 ${Object.keys(s.vcThresholds).length} · 통합 메일 ${s.mail.digest.enabled ? '켜짐' : '꺼짐'} · vCenter 메일 ${Object.keys(s.mail.vcenters).length}`, ip: req.ip || '' });
    res.json({ ok: true, settings: s });
  });

  // 메일 — 상태·기록(주소 없이 개수만) + 메일 서버 준비 여부.
  // 보안 잔여 11-27 L7(반증 3회차 must — 재현): 보내는 주소(smtp.from)는 메일 설정(/api/admin/mail — 데모 READ_DENY)의 값이다 — 관리자 판본에만 싣는다
  //   (범위 관리자는 /api/admin/mail 도 보내는 사람을 그대로 보이므로 isAdminDetailUser 기준). 데모 판본은 기록 · 마지막 오류의 실패 사유(SMTP 응답 원문 —
  //   '550 <받는 사람>' 처럼 주소가 실릴 수 있다)의 메일 주소 · 전화 · 카드 꼴을 가린다(edgelog/redact.js 하나 — 가림 규칙을 새로 만들지 않는다).
  api.get('/tools/guest-partition/mail', adminOnly, fullScopeOnly, (req, res) => {
    const detail = isAdminDetailUser(req.user);
    let server = { enabled: false, configured: false, defaultTo: 0, kindEnabled: true };
    try { const c = loadMailCfg(); server = { enabled: !!c.enabled, configured: !!String(c.smtp?.host || '').trim(), defaultTo: (c.defaultTo || []).length, kindEnabled: (c.kinds || {}).guestpart?.enabled !== false, ...(detail ? { from: c.smtp?.from || '' } : {}) }; } catch { /* 메일 설정 없음 */ }
    res.json({ ok: true, status: isDemoGuest(req.user) ? demoMailStatusView(mailStatus()) : mailStatus(), server });
  });

  api.post('/tools/guest-partition/mail/preview', adminOnly, fullScopeOnly, textFields('target'), async (req, res) => {
    const target = String(req.body?.target || 'digest');
    if (target !== 'digest' && !(store.get()?.vcenters || []).some((v) => v.id === target)) return res.status(404).json({ ok: false, error: 'not found' });
    res.json(await previewMail(target));
  });

  api.post('/tools/guest-partition/mail/send', adminOnly, fullScopeOnly, textFields('target'), async (req, res) => {
    const target = String(req.body?.target || 'digest');
    if (target !== 'digest' && !(store.get()?.vcenters || []).some((v) => v.id === target)) return res.status(404).json({ ok: false, error: 'not found' });
    logAudit({ user: req.user?.username, action: '게스트 파티션 사용률 메일 지금 보내기', target, ip: req.ip || '' });
    const r = target === 'digest' ? await sendDigest({ manual: true, by: req.user?.username || 'admin' }) : await sendVcenter(target, { trigger: 'manual', by: req.user?.username || 'admin' });
    res.json(r);
  });

  // 165회차(163 반증 — 재현): 163 의 '수정 전 500 표' 에 있던 자리인데 고쳐지지 않았다(to 객체 → 주소 정리의 String() 이 던짐). to 는 글자 또는 목록 — 화면은 목록을 보낸다.
  api.post('/tools/guest-partition/mail/test', adminOnly, fullScopeOnly, listOrText('to'), async (req, res) => {
    logAudit({ user: req.user?.username, action: '게스트 파티션 사용률 메일 테스트 발송', ip: req.ip || '' });
    const r = await sendTest(req.body?.to, req.user?.username || 'admin');
    if (r.error) return res.status(400).json({ ok: false, reason: r.error });
    res.json(r);
  });
}

/**
 * 보안 잔여 11-27 L7(반증 3회차): 데모 판본의 게스트 파티션 메일 상태 — 실패 사유 글자의 메일 주소 등만 가린다(구조 · 개수 · 시각은 그대로).
 * 원본(메모리 상태)은 바꾸지 않는다.
 */
export function demoMailStatusView(st) {
  if (!st || typeof st !== 'object') return st;
  const t = (v) => (typeof v === 'string' && v ? redactSystemLogLine(v) : v);
  return {
    ...st,
    history: Array.isArray(st.history) ? st.history.map((h) => (h && typeof h === 'object' ? { ...h, ...(h.reason != null ? { reason: t(h.reason) } : {}), ...(h.note != null ? { note: t(h.note) } : {}) } : h)) : st.history,
    lastError: st.lastError && typeof st.lastError === 'object' ? { ...st.lastError, message: t(st.lastError.message) } : t(st.lastError),   // notify.js: { at, message }
  };
}
