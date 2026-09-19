/**
 * routes/api/curUser.js — '현재 사용자'(v2.520) API.
 *
 *  GET  /tools/curuser                 전체 + vCenter별 집계(+ 상태별 개수·대상 아님) (tools 권한)
 *  GET  /tools/curuser/history         추이(vcenterId='' 은 전체 합계 계열) (tools)
 *  GET  /tools/curuser/activity        수집 작업 로그 `{poller, events}` (tools)
 *  POST /tools/curuser/collect         지금 수집 (admin, 폴러와 재진입 가드 공유)
 *  GET  /tools/curuser/settings        설정 + 대상 해석 결과 + 폴더 후보 (tools)
 *  PUT  /tools/curuser/settings        설정 변경 (admin)
 *  GET  /tools/curuser/agent-script    게스트 발행기 스크립트 다운로드 (tools)
 *
 * 보안: 조회는 `scopedVcenterIds` 교집합을 **요청 필터보다 먼저** 적용한다(범위 제한 계정이
 * 다른 법인 사용자 수를 보지 못하게). 설정 응답의 `vcenters` 도 범위 교집합만 — 범위 밖 법인
 * id 를 열거하지 않는다.
 *
 * ⚠ 계정명은 개인정보성이다. 응답에는 싣되(권한 게이트 안이다) 목록 화면의 기본 표시는
 *   `settings.showNamesInList` 가 정한다 — 화면이 그 사실을 밝힌다.
 */
import { scopedVcenterIds } from '../../auth/scope.js';
import { requireRole, requirePerm } from '../../auth/auth.js';
import { logAudit } from '../../audit.js';
import { store } from '../../store.js';
import { load as loadCurUser, save as saveCurUser, LIMITS, staleAfterMs } from '../../curuser/settings.js';
import { resolveTargets, SKIP_REASON } from '../../curuser/scope.js';
import { latestRecords, seriesRange, curUserDbStatus, vmSeriesEnabled } from '../../curuser/db.js';
import { buildReport } from '../../curuser/report.js';
import { curUserPollerStatus, runCurUserNow } from '../../curuser/poller.js';
import { listCurUserActivity } from '../../curuser/activityLog.js';
import { curUserPushStatus } from '../../agent/curUserPush.js';
import { guestAgentScript, installCommand, AGENT_FILE } from '../../curuser/agentScript.js';
import { KIND_LABEL } from '../../curuser/guestinfoSource.js';

const DAY = 86_400_000;
const clampDays = (v) => Math.max(1, Math.min(365, Math.round(Number(v) || 7)));

export function registerCurUser(api) {

/** 범위 허용 법인만 남긴다(요청 필터보다 먼저). */
function scopeFilter(req, snap) {
  const allowed = scopedVcenterIds(req.user, snap);
  return (id) => !allowed || allowed.has(String(id));
}

api.get('/tools/curuser', requirePerm('tools'), async (req, res) => {
  const snap = store.get();
  const ok = scopeFilter(req, snap);
  const s = loadCurUser();
  const vcNameOf = (id) => (snap.vcenters || []).find((v) => v.id === id)?.name || id;
  const recs = (await latestRecords()).filter((r) => ok(r.vcenterId));
  const scope = resolveTargets(snap.vms || [], s);
  const wanted = String(req.query.vcenterId || '');
  const rep = buildReport(recs, {
    now: Date.now(), staleAfterMs: staleAfterMs(s), vcNameOf,
    skipped: scope.skipped.filter((x) => ok(x.vcenterId)),
  });
  res.json({
    ...rep,
    vcenters: wanted ? rep.vcenters.filter((v) => v.vcenterId === wanted) : rep.vcenters,
    records: wanted ? rep.records.filter((r) => r.vcenterId === wanted) : rep.records,
    // 화면이 숫자를 하드코딩하지 않도록 **서버가 주는 값만** 쓰게 한다(CLAUDE.md 규칙).
    settings: {
      enabled: s.enabled, intervalMs: s.intervalMs, guestPublishMs: s.guestPublishMs,
      staleFactor: s.staleFactor, showNamesInList: s.showNamesInList, maxVms: s.maxVms,
      retentionDays: s.retentionDays,
    },
    targets: scope.targets.filter((t) => ok(t.vcenterId)).length,
    overLimit: scope.overLimit,
    skipReasons: SKIP_REASON,
    kindLabels: KIND_LABEL,
    poller: curUserPollerStatus(),
    db: await curUserDbStatus(),
    mock: snap.source === 'mock',
  });
});

api.get('/tools/curuser/history', requirePerm('tools'), async (req, res) => {
  const snap = store.get();
  const ok = scopeFilter(req, snap);
  const vcenterId = String(req.query.vcenterId || '');
  // 전체 합계 계열('')은 **범위 제한 계정에 주지 않는다** — 범위 밖 법인이 섞인 수치이기 때문.
  if (vcenterId === '' && scopedVcenterIds(req.user, snap)) {
    return res.status(403).json({ error: 'forbidden', requiredOwner: true, reason: '전체 합계 추이는 전 법인 범위 계정만 볼 수 있습니다(범위 밖 법인이 합산됩니다).' });
  }
  if (vcenterId && !ok(vcenterId)) return res.status(404).json({ error: 'not_found' });
  const days = clampDays(req.query.days);
  const now = Date.now();
  const out = await seriesRange(vcenterId, now - days * DAY, now);
  const s = loadCurUser();
  res.json({
    ...out, vcenterId, days, now,
    retentionDays: s.retentionDays, intervalMs: s.intervalMs,
    // ⚠ `span.first` 는 '수집 시작' 이 아니라 **max(수집 시작, 보존 경계)** 다 — 화면이
    //   '기다리면 채워진다' 고 단정하지 않도록 보존일을 함께 내려준다.
    db: await curUserDbStatus(),
  });
});

api.get('/tools/curuser/activity', requirePerm('tools'), (req, res) => {
  res.json({ poller: curUserPollerStatus(), events: listCurUserActivity(Number(req.query.limit) || 100) });
});

api.post('/tools/curuser/collect', requireRole('admin'), async (req, res) => {
  const r = await runCurUserNow('manual');
  logAudit({
    user: req.user?.username, action: 'curuser.collect', ip: req.ip || '',
    detail: JSON.stringify({ ok: r.ok, records: r.records ?? null, skipped: !!r.skipped }).slice(0, 300),
  });
  res.json(r);
});

api.get('/tools/curuser/settings', requirePerm('tools'), async (req, res) => {
  const snap = store.get();
  const ok = scopeFilter(req, snap);
  const s = loadCurUser();
  const vcenters = (snap.vcenters || []).filter((v) => ok(v.id))
    .map((v) => ({ id: v.id, name: v.name || v.id, collectSource: v.collectSource || 'central' }));
  // 폴더 후보 — 그 법인의 Windows VM 이 실제로 들어 있는 폴더만(전 폴더를 나열하면 수백 줄이다).
  const folders = new Map();
  for (const vm of snap.vms || []) {
    if (!ok(vm.vcenterId) || !vm.folder) continue;
    const isWin = /windows|microsoft/i.test(String(vm.guestOS || ''));
    const key = JSON.stringify([vm.vcenterId, vm.folder]);
    const e = folders.get(key) || { vcenterId: vm.vcenterId, folder: vm.folder, vms: 0, windows: 0 };
    e.vms++; if (isWin) e.windows++;
    folders.set(key, e);
  }
  const scope = resolveTargets(snap.vms || [], s);
  const resolved = new Map();
  const bump = (id, field) => {
    if (!ok(id)) return;
    const e = resolved.get(id) || { vcenterId: id, targets: 0, skipped: 0 };
    e[field]++; resolved.set(id, e);
  };
  for (const t of scope.targets) bump(t.vcenterId, 'targets');
  for (const t of scope.skipped) bump(t.vcenterId, 'skipped');
  res.json({
    settings: { ...s, vcenters: Object.fromEntries(Object.entries(s.vcenters || {}).filter(([id]) => ok(id))) },
    limits: LIMITS, vcenters,
    folders: [...folders.values()].filter((f) => f.windows > 0).sort((a, b) => b.windows - a.windows).slice(0, 500),
    resolved: [...resolved.values()],
    overLimit: scope.overLimit,
    staleAfterMs: staleAfterMs(s),
    agentFile: AGENT_FILE,
    installCommand: installCommand({ intervalMinutes: Math.round(s.guestPublishMs / 60_000) }),
    poller: curUserPollerStatus(), push: curUserPushStatus(),
    db: await curUserDbStatus(), vmSeries: vmSeriesEnabled(), mock: snap.source === 'mock',
  });
});

api.put('/tools/curuser/settings', requireRole('admin'), (req, res) => {
  const b = req.body || {};
  const snap = store.get();
  const validVc = new Set((snap.vcenters || []).map((v) => v.id));
  if (b.vcenters !== undefined) {
    if (!b.vcenters || typeof b.vcenters !== 'object' || Array.isArray(b.vcenters)) return res.status(400).json({ ok: false, reason: 'vcenters 는 객체여야 합니다.' });
    // 유령 id 저장 방지 — 저장해 두면 설정 화면이 없는 법인을 계속 보여준다.
    const bad = Object.keys(b.vcenters).filter((id) => !validVc.has(id));
    if (bad.length) return res.status(400).json({ ok: false, reason: `존재하지 않는 vCenter id: ${bad.slice(0, 5).join(', ')}` });
  }
  const before = loadCurUser();
  const next = saveCurUser({ ...before, ...b, vcenters: b.vcenters === undefined ? before.vcenters : b.vcenters });
  logAudit({
    user: req.user?.username, action: 'curuser.settings', ip: req.ip || '',
    detail: JSON.stringify({
      enabled: next.enabled, intervalMs: next.intervalMs,
      vcenters: Object.entries(next.vcenters).filter(([, v]) => v.enabled).map(([id]) => id),
    }).slice(0, 300),
  });
  res.json({ ok: true, settings: next, limits: LIMITS, staleAfterMs: staleAfterMs(next) });
});

/**
 * 게스트 발행기 스크립트 — 관리자가 Windows 서버에 한 번 등록한다.
 * ⚠ 파일명은 **ASCII**(v2.519 A/B 실측 — 헤드리스 Chromium 이 한글 download 파일명을 잃는다).
 */
api.get('/tools/curuser/agent-script', requirePerm('tools'), (req, res) => {
  const s = loadCurUser();
  const body = guestAgentScript({ intervalMinutes: Math.round(s.guestPublishMs / 60_000) });
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${AGENT_FILE}"`);
  res.send(body);
});

}
