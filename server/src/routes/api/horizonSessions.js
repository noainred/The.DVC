/**
 * routes/api/horizonSessions.js — Horizon 실시간 사용자(v2.525) API.
 *
 *  GET  /tools/horizon-sessions            서버별 + 전체 집계(+ 상태·근거) (tools 권한)
 *  GET  /tools/horizon-sessions/history    추이(serverId='' 은 전체 합집합 계열) (tools)
 *  GET  /tools/horizon-sessions/activity   수집 작업 로그 `{poller, events}` (tools)
 *  POST /tools/horizon-sessions/collect    지금 수집 (admin, 폴러와 재진입 가드 공유)
 *  GET  /tools/horizon-sessions/settings   설정 + 대상 서버 목록 (tools)
 *  PUT  /tools/horizon-sessions/settings   설정 변경 (admin)
 *  GET  /tools/current-users/combined      Windows ∪ VDI 고유 사용자 (tools)
 *
 * 보안:
 *  · Horizon 은 **vCenter 에 매인 자원이 아니다** — 법인 범위(scope) 로 나눌 축이 없다. 그래서
 *    범위 제한 계정에는 403(`requiredOwner`)으로 정직하게 거절한다. 임의로 전 법인 수치를
 *    보여주면 범위 제한을 무력화하고, 빈 값을 주면 '사용자 0명' 이라는 거짓이 된다.
 *  · 자격증명은 응답에 절대 싣지 않는다(Connection Server 목록은 `listHorizon()` 의 redact 판).
 *
 * ⚠ 계정명은 개인정보성이다. 사용자 선택(2026-09-16)대로 **목록 기본 표시는 가림**이고
 *   `settings.showNamesInList` 가 정한다 — 화면이 그 사실을 밝힌다.
 */
import { scopeDbStatus } from '../../auth/scopeStatus.js';
import { requireRole, requirePerm } from '../../auth/auth.js';
import { scopedVcenterIds } from '../../auth/scope.js';
import { logAudit } from '../../audit.js';
import { store } from '../../store.js';
import { listHorizon } from '../../horizon/horizon.js';
import { load as loadHzSettings, save as saveHzSettings, LIMITS } from '../../horizon/sessionSettings.js';
import { hzLatestRecords, hzSeriesRange, hzSessionDbStatus } from '../../horizon/sessionDb.js';
import { combineServers } from '../../horizon/sessions.js';
import { KIND_LABEL } from '../../horizon/sessionCollect.js';
import { hzSessionPollerStatus, runHzSessionsNow, targetServers } from '../../horizon/sessionPoller.js';
import { listHzSessionActivity } from '../../horizon/sessionActivityLog.js';
import { latestRecords as curUserLatest } from '../../curuser/db.js';
import { load as loadCurUser, staleAfterMs } from '../../curuser/settings.js';
import { buildReport as buildCurUserReport } from '../../curuser/report.js';
import { combineSources } from '../../curuser/combine.js';
import { KIND_LABEL as CU_KIND_LABEL } from '../../curuser/guestinfoSource.js';

const DAY = 86_400_000;
const clampDays = (v) => Math.max(1, Math.min(365, Math.round(Number(v) || 7)));

/** 범위 제한 계정 거절(위 머리말) — 조용히 빈 값을 주지 않는다. */
function denyScoped(req, res) {
  if (!scopedVcenterIds(req.user, store.get())) return false;
  res.status(403).json({
    error: 'forbidden', requiredOwner: true,
    reason: 'Horizon 실시간 사용자는 법인 범위로 나눌 수 있는 자원이 아니어서 전 법인 범위 계정만 볼 수 있습니다.',
  });
  return true;
}

/** 서버별 최신 + 전체 합집합. 이번 주기 값만 합친다(직전 값을 섞으면 '지금' 이 거짓이 된다). */
async function currentReport() {
  const rows = await hzLatestRecords();
  const latestTs = rows.length ? Math.max(...rows.map((r) => Number(r.ts) || 0)) : 0;
  const fresh = rows.filter((r) => Number(r.ts) === latestTs);
  return { rows, latestTs: latestTs || null, total: combineServers(fresh), freshCount: fresh.length };
}

export function registerHorizonSessions(api) {

api.get('/tools/horizon-sessions', requirePerm('tools'), async (req, res) => {
  if (denyScoped(req, res)) return;
  const s = loadHzSettings();
  const registered = listHorizon();
  const { rows, latestTs, total } = await currentReport();
  res.json({
    now: Date.now(),
    lastReadAt: latestTs,
    total,
    servers: rows,
    // 등록돼 있는데 아직 한 번도 수집되지 않은 서버 — '사용자 0명' 이 아니라 '수집 전' 이다.
    pending: registered.filter((r) => r.enabled !== false && !rows.some((x) => x.serverId === r.id))
      .map((r) => ({ serverId: r.id, name: r.name || r.id, host: r.host })),
    registered: registered.length,
    targets: targetServers(s).length,
    kindLabels: KIND_LABEL,
    // 화면이 숫자를 하드코딩하지 않도록 **서버가 주는 값만** 쓰게 한다(CLAUDE.md 규칙).
    settings: {
      enabled: s.enabled, intervalMs: s.intervalMs, retentionDays: s.retentionDays,
      showNamesInList: s.showNamesInList, maxUsers: s.maxUsers, maxPages: s.maxPages, pageSize: s.pageSize,
    },
    poller: hzSessionPollerStatus(),
    db: scopeDbStatus(await hzSessionDbStatus(), req.user),   // v2.595(감사 AUTHZ-2595-04): DB 경로는 admin 에게만
    mock: store.get()?.source === 'mock',
  });
});

api.get('/tools/horizon-sessions/history', requirePerm('tools'), async (req, res) => {
  if (denyScoped(req, res)) return;
  const serverId = String(req.query.serverId || '');
  const days = clampDays(req.query.days);
  const now = Date.now();
  const out = await hzSeriesRange(serverId, now - days * DAY, now);
  const s = loadHzSettings();
  res.json({
    ...out, serverId, days, now,
    // ⚠ `span.first` 는 '수집 시작' 이 아니라 **max(수집 시작, 보존 경계)** 다 — 화면이
    //   '기다리면 채워진다' 고 단정하지 않도록 보존일·주기를 함께 내려준다.
    retentionDays: s.retentionDays, intervalMs: s.intervalMs,
    db: scopeDbStatus(await hzSessionDbStatus(), req.user),   // v2.595(감사 AUTHZ-2595-04): DB 경로는 admin 에게만
  });
});

api.get('/tools/horizon-sessions/activity', requirePerm('tools'), (req, res) => {
  if (denyScoped(req, res)) return;
  res.json({ poller: hzSessionPollerStatus(), events: listHzSessionActivity(Number(req.query.limit) || 100) });
});

api.post('/tools/horizon-sessions/collect', requireRole('admin'), async (req, res) => {
  const r = await runHzSessionsNow('manual');
  logAudit({
    user: req.user?.username, action: 'horizon.sessions.collect', ip: req.ip || '',
    detail: JSON.stringify({ ok: r.ok, servers: r.servers ?? null, skipped: !!r.skipped }).slice(0, 300),
  });
  res.json(r);
});

api.get('/tools/horizon-sessions/settings', requirePerm('tools'), async (req, res) => {
  if (denyScoped(req, res)) return;
  const s = loadHzSettings();
  res.json({
    settings: s,
    limits: LIMITS,
    servers: listHorizon().map((x) => ({ id: x.id, name: x.name || x.id, host: x.host, enabled: x.enabled !== false, hasPassword: !!x.hasPassword })),
    poller: hzSessionPollerStatus(),
    db: scopeDbStatus(await hzSessionDbStatus(), req.user),   // v2.595(감사 AUTHZ-2595-04): DB 경로는 admin 에게만
    mock: store.get()?.source === 'mock',
  });
});

api.put('/tools/horizon-sessions/settings', requireRole('admin'), (req, res) => {
  const b = req.body || {};
  if (b.servers !== undefined && (!b.servers || typeof b.servers !== 'object' || Array.isArray(b.servers))) {
    return res.status(400).json({ ok: false, reason: 'servers 는 객체여야 합니다.' });
  }
  const valid = new Set(listHorizon().map((x) => x.id));
  if (b.servers) {
    // 유령 id 저장 방지 — 저장해 두면 설정 화면이 없는 서버를 계속 보여준다.
    const bad = Object.keys(b.servers).filter((id) => !valid.has(id));
    if (bad.length) return res.status(400).json({ ok: false, reason: `등록되지 않은 Horizon 서버 id: ${bad.slice(0, 5).join(', ')}` });
  }
  const before = loadHzSettings();
  const next = saveHzSettings({ ...before, ...b, servers: b.servers === undefined ? before.servers : b.servers });
  logAudit({
    user: req.user?.username, action: 'horizon.sessions.settings', ip: req.ip || '',
    detail: JSON.stringify({ enabled: next.enabled, intervalMs: next.intervalMs }).slice(0, 300),
  });
  res.json({ ok: true, settings: next, limits: LIMITS });
});

/**
 * 두 출처 합집합 — '현재 사용자' 화면의 **전체** 탭이 쓴다.
 *
 * ⚠ 한 출처가 비어 있는 이유를 **판정해서** 내려준다(`state: 'ok'|'off'|'failed'|'unavailable'`).
 *   "수집 대기" 한 문구로 덮으면 조치가 정반대인 상황을 같은 말로 말한다(v2.509/v2.517 규약).
 */
api.get('/tools/current-users/combined', requirePerm('tools'), async (req, res) => {
  if (denyScoped(req, res)) return;

  // ── Windows 서버(guestinfo 경로) ──
  const cu = loadCurUser();
  const cuDb = await (async () => { try { const { curUserDbStatus } = await import('../../curuser/db.js'); return await curUserDbStatus(); } catch { return { available: false, error: '' }; } })();
  let windows;
  if (!cuDb.available) windows = { state: 'unavailable', names: [], reason: `DB 를 쓸 수 없습니다: ${cuDb.error || 'node:sqlite 없음'}` };
  else {
    const snap = store.get();
    const recs = await curUserLatest();
    const rep = buildCurUserReport(recs, {
      now: Date.now(), staleAfterMs: staleAfterMs(cu),
      vcNameOf: (id) => (snap?.vcenters || []).find((v) => v.id === id)?.name || id,
    });
    // ⚠ **'레코드가 있다' 를 '읽었다' 로 뭉개지 말 것.** 전 서버가 `stale`(값이 오래됨)·
    //   `no-agent`(발행기 없음)면 지금 유효한 값은 **하나도 없다** — 그때 `ok` 라고 말하면
    //   화면이 '전체 0명' 을 사실처럼 보여준다(목 데이터 실측에서 실제로 그랬다: 43대 중
    //   stale 41 · no-agent 2 인데 `state:'ok'` 였다).
    const usable = Number(rep.kinds?.ok) || 0;
    const kindText = Object.entries(rep.kinds || {})
      .filter(([k]) => k !== 'ok')
      .map(([k, n2]) => `${CU_KIND_LABEL[k] || k} ${n2}대`).join(' · ');
    windows = recs.length && usable > 0
      ? { state: 'ok', names: rep.total.names, reason: '', detail: { users: rep.total.users, sessions: rep.total.sessions, kinds: rep.kinds, lastReadAt: rep.lastReadAt } }
      : recs.length
        ? { state: 'failed', names: [], reason: `수집된 서버 ${recs.length}대 중 **지금 값이 유효한 서버가 없습니다** — ${kindText || '사유 미상'}.`,
          detail: { users: null, sessions: null, kinds: rep.kinds, lastReadAt: rep.lastReadAt } }
        : { state: cu.enabled ? 'failed' : 'off', names: [],
          reason: cu.enabled ? '수집은 켜져 있지만 아직 저장된 결과가 없습니다(첫 주기 전이거나 대상 폴더가 비어 있습니다).' : '수집이 꺼져 있습니다(설정에서 폴더를 지정하고 켜세요).' };
  }

  // ── Horizon(VDI) ──
  const hs = loadHzSettings();
  const hzDb = await hzSessionDbStatus();
  let vdi;
  if (!hzDb.available) vdi = { state: 'unavailable', names: [], reason: `DB 를 쓸 수 없습니다: ${hzDb.error || 'node:sqlite 없음'}` };
  else {
    const { total, freshCount, latestTs } = await currentReport();
    vdi = freshCount
      ? { state: total.serversOk ? 'ok' : 'failed', names: total.names,
        reason: total.serversOk ? '' : '등록된 Horizon 서버에서 세션을 읽지 못했습니다(작업 로그의 사유를 확인하세요).',
        detail: { users: total.users, usersConnected: total.usersConnected, sessions: total.sessions, serversOk: total.serversOk, serversFailed: total.serversFailed, stateBlind: total.stateBlind, lastReadAt: latestTs } }
      : { state: hs.enabled ? 'failed' : 'off', names: [],
        reason: hs.enabled ? '수집은 켜져 있지만 아직 저장된 결과가 없습니다(첫 주기 전입니다).' : 'Horizon 실시간 사용자 수집이 꺼져 있습니다(설정에서 켜세요).' };
  }

  const combined = combineSources({ windows, vdi });
  res.json({
    now: Date.now(),
    combined,
    sources: { windows: { ...windows, names: undefined }, vdi: { ...vdi, names: undefined } },
    showNamesInList: cu.showNamesInList === true && hs.showNamesInList === true,
  });
});

}
