/**
 * routes/api/svcStatus.js — 특수기능 '포탈 서비스 상태 모니터링'(도구 키 `svc-status` · v3.54).
 *
 * 게이트: 전부 **관리자 + 전체 범위**(통신 점검 · 전송 속도와 같다 — 응답에 전 법인 엣지 포탈 · vCenter · CVP · 스토리지의 주소:포트와 담당 엣지가 실린다.
 *   엣지 · CVP · 스토리지는 vCenter 귀속이 없어 범위 계정에 나눌 축이 없다 — v2.525 규약). 쓰기(fullScopeOnlyWith 는 안전 메서드가 아니면 조회 ∧ 쓰기 전체).
 * 주소 가림: 관리자 판본(`isAdminDetailUser`)이 아니면 접속처 칸을 비우고 `addressHidden` 으로 밝힌다(데모 계정이 여기 해당한다).
 * 데모 계정: 사람이 등록한 항목을 통째로 빼고 데모 항목만 준다(가림은 기억(memo) **밖에서** — 전송 속도 maskXferMainForDemoGuest 와 같은 꼴) · 단건은 404.
 *   설정 화면 API 는 데모 계정 READ_DENY(auth/demoGuest.js) · '지금 측정' · '제외' POST 는 기본 403(SAFE_ACTIONS 아님 — 실제 주소에 연결한다).
 */
import { requireRole } from '../../auth/auth.js';
import { logAudit } from '../../audit.js';
import { fullScopeOnlyWith } from '../admin/shared.js';
import { isAdminDetailUser, isDemoGuest } from '../../auth/demoGuest.js';
import { unreadMark } from '../settingsUnreadMark.js';
import { strOf } from '../../util/coercionTrap.js';
import {
  loadSvcStatusSettings, saveSvcStatusSettings, setExcluded, svcStatusWriteRefusal, svcStatusSettingsLoadError, svcStatusUsingLastGood, LIMITS, ALERT_TO_MAX,
} from '../../svcstatus/settings.js';
import { mainPayload, detailPayload, sourcesPayload, getPlan, invalidatePlan } from '../../svcstatus/service.js';
import { svcStatusPollerStatus, runSvcStatusNow } from '../../svcstatus/poller.js';
import { MAIL_KIND } from '../../svcstatus/notify.js';
import { countsOf } from '../../svcstatus/view.js';
import { KIND_LABEL } from '../../svcstatus/targets.js';
import * as db from '../../svcstatus/db.js';

const adminOnly = requireRole('admin');
const fullScopeOnly = fullScopeOnlyWith('포탈 서비스 상태 모니터링은 전체 범위(vCenter 제한 없는) 계정만 볼 수 있습니다 — 전 법인 엣지 포탈 · vCenter · CVP · 스토리지의 주소:포트와 담당 엣지가 들어갑니다.');
const MEMO_TTL_MS = 10_000;
let _memo = null;   // { key, at, body } — 관리자 판본 하나(가림 · 데모 거르기는 밖에서)


/** 데모 계정 판본 — 데모 항목만 남기고 합계를 다시 센다. */
export function maskForDemoGuest(body) {
  const rows = body.rows.filter((r) => r.demo);
  const kinds = body.kinds.map((k) => ({ ...k, n: rows.filter((r) => r.kind === k.key).length }));
  const edges = body.edges.filter((e) => /^mock-/i.test(e.agent));
  return { ...body, rows, kinds, edges, counts: countsOf(rows), demoMasked: body.rows.length - rows.length, sourceErrors: [] };
}
/**
 * 주소 가림 판본(관리자 판본이 아닌 계정 — 데모 계정 포함). 폴러 상태는 **아는 칸만** 남긴다(화이트리스트):
 * 메일 결과 사유 · 주기 오류 원문에는 SMTP 서버 주소:포트 · 오류 원문이 실린다(점검 반증 #9 — 재현).
 */
const pick = (o, ks) => (o && typeof o === 'object' ? Object.fromEntries(ks.filter((k) => k in o).map((k) => [k, o[k]])) : null);
export function maskPollerForNonAdmin(p) {
  if (!p || typeof p !== 'object') return p ?? null;
  return {
    enabled: p.enabled, intervalMs: p.intervalMs, running: p.running, stuckReleases: p.stuckReleases, ...(p.demo ? { demo: true } : {}),
    last: pick(p.last, ['at', 'ms', 'trigger', 'measured', 'failed', 'skipped', 'edgeTargets', 'stored', 'dbOk', 'disabled', 'ok', 'demoEdges', 'heldKinds']),
    baseline: pick(p.baseline, ['at', 'ms', 'updated', 'ok']),
    mail: pick(p.mail, ['at', 'events', 'mails', 'sent', 'failed', 'skipped', 'ok']),
  };
}
export function maskAddresses(body) {
  return { ...body, addressHidden: true, rows: body.rows.map((r) => ({ ...r, host: '', port: null, address: '' })), poller: maskPollerForNonAdmin(body.poller) };
}

export function registerSvcStatus(api) {

api.get('/tools/svc-status', adminOnly, fullScopeOnly, async (req, res) => {
  const now = Date.now();
  const key = `${db.dataRev()}|${Math.floor(now / MEMO_TTL_MS)}`;
  let body = _memo && _memo.key === key ? _memo.body : null;
  if (!body) {
    body = await mainPayload({ now, pollerStatus: svcStatusPollerStatus() });
    _memo = { key, at: now, body };
  }
  if (isDemoGuest(req.user)) body = maskForDemoGuest(body);
  if (!isAdminDetailUser(req.user)) body = maskAddresses(body);
  res.set('Cache-Control', 'no-store');
  res.json(body);
});

api.get('/tools/svc-status/target', adminOnly, fullScopeOnly, async (req, res) => {
  const id = strOf(req.query.id, 300);
  if (!id) return res.status(400).json({ ok: false, reason: 'id 가 필요합니다.', field: 'id' });
  const range = strOf(req.query.range, 8) || '24h';
  const out = await detailPayload(id, { range, maskAddress: !isAdminDetailUser(req.user), demoOnly: isDemoGuest(req.user) });
  if (!out || (isDemoGuest(req.user) && !out.row.demo)) return res.status(404).json({ ok: false, reason: '그런 감시 대상이 없습니다.' });
  res.set('Cache-Control', 'no-store');
  res.json(out);
});

async function settingsBody() {
  const s = loadSvcStatusSettings();
  const plan = await getPlan();
  const byId = new Map(plan.rows.map((r) => [r.id, r]));
  const excluded = s.excluded.map((x) => {
    const r = byId.get(x.id);
    return { ...x, name: r?.name || '', kind: r?.kind || '', kindLabel: r ? KIND_LABEL[r.kind] : '', address: r && r.host ? `${r.host}:${r.port}` : '', present: !!r };
  });
  let mailConfigured = null;
  try {
    const { load } = await import('../../mail/settings.js');
    const { resolveRecipients } = await import('../../mail/kinds.js');
    mailConfigured = resolveRecipients(load(), MAIL_KIND, s.alerts.to.length ? s.alerts.to : null).ok === true;
  } catch { mailConfigured = null; }
  return {
    ok: true,
    settings: { ...s, excluded },
    limits: { ...Object.fromEntries(Object.entries(LIMITS).map(([k, v]) => [k, { min: v.min, max: v.max }])), alertsTo: { max: ALERT_TO_MAX } },
    sources: await sourcesPayload(),
    mail: { kind: MAIL_KIND, kindLabel: '포탈 서비스 상태', configured: mailConfigured },
    rawDays: db.RAW_DAYS,
    usingLastGood: svcStatusUsingLastGood(),
    settingsLoadError: svcStatusSettingsLoadError(),
    ...unreadMark(svcStatusWriteRefusal()),
  };
}

api.get('/tools/svc-status/settings', adminOnly, fullScopeOnly, async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await settingsBody());
});

api.put('/tools/svc-status/settings', adminOnly, fullScopeOnly, async (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
  if (!body) return res.status(400).json({ ok: false, reason: '본문은 객체여야 합니다.' });
  const before = loadSvcStatusSettings();
  try {
    const next = saveSvcStatusSettings(body);
    invalidatePlan(); _memo = null;
    const changed = ['enabled', 'intervalMs', 'timeoutMs', 'concurrency', 'failThreshold', 'slowFactor', 'slowMinDeltaMs', 'retentionDays']
      .filter((k) => before[k] !== next[k]);
    if (JSON.stringify(before.kinds) !== JSON.stringify(next.kinds)) changed.push('kinds');
    if (JSON.stringify(before.alerts) !== JSON.stringify(next.alerts)) changed.push('alerts');
    logAudit({ user: req.user?.username, action: 'svc-status.settings', target: 'svc-status', detail: changed.length ? `바뀐 항목: ${changed.join(', ')}` : '변경 없음', ip: req.ip });
    res.json(await settingsBody());
  } catch (e) {
    const status = e?.status === 409 ? 409 : 400;
    res.status(status).json({ ok: false, reason: String(e?.message || e).slice(0, 300), ...(e?.code ? { code: e.code } : {}), ...(e?.field ? { field: e.field } : {}) });
  }
});

api.post('/tools/svc-status/exclude', adminOnly, fullScopeOnly, async (req, res) => {
  const id = strOf(req.body?.id, 300);
  if (!id) return res.status(400).json({ ok: false, reason: '대상 id 가 필요합니다.', field: 'id' });
  const on = req.body?.on !== false;
  try {
    const excluded = setExcluded(id, on, { reason: strOf(req.body?.reason, 200), by: req.user?.username || '' });
    invalidatePlan(); _memo = null;
    logAudit({ user: req.user?.username, action: on ? 'svc-status.exclude' : 'svc-status.include', target: id, ip: req.ip });
    res.json({ ok: true, excluded });
  } catch (e) {
    res.status(e?.status === 409 ? 409 : 400).json({ ok: false, reason: String(e?.message || e).slice(0, 300), ...(e?.code ? { code: e.code } : {}) });
  }
});

api.post('/tools/svc-status/run', adminOnly, fullScopeOnly, async (req, res) => {
  const id = strOf(req.body?.id, 300);
  if (id) {
    const plan = await getPlan();
    const row = plan.rows.find((r) => r.id === id);
    if (!row) return res.status(404).json({ ok: false, reason: '그런 감시 대상이 없습니다.' });
    if (row.plan === 'edge') return res.status(400).json({ ok: false, reason: `엣지(${row.by})가 재는 대상입니다 — 다음 엣지 보고를 기다리세요.` });
    if (row.plan !== 'central') return res.status(400).json({ ok: false, reason: '지금 재지 않는 대상입니다(꺼짐 · 제외 · 설정 오류 · 담당 엣지 모름).' });
  }
  const out = await runSvcStatusNow(id);
  if (out?.skipped === 'already-running') return res.status(409).json({ ok: false, reason: '측정이 이미 진행 중입니다 — 끝나면 화면에 반영됩니다.' });
  if (out?.skipped === 'edge-node') return res.status(409).json({ ok: false, reason: '엣지 포탈에서는 중앙 측정을 돌리지 않습니다.' });
  logAudit({ user: req.user?.username, action: 'svc-status.run', target: id || '(전체)', ip: req.ip });
  _memo = null;
  res.json({ ok: out?.ok !== false, measured: out?.measured ?? 0, failed: out?.failed ?? 0, skipped: out?.skipped ?? 0, note: out?.reason || '' });
});

}
