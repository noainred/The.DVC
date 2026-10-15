/**
 * routes/api/isilonDirUsage.js — 특수 기능 '아이실론 디렉터리 사용량'(v2.736).
 *
 * 사용자 요청(2026-10-14): "특수기능에 내가 지정한 아이실론의 특정 디렉터리 하위의 모든 폴더의 크기를 조사해서 Top 10 …
 *   ssh admin@<아이실론> 'du -A -h -d 1 "/ifs/data/workspace/users/"' … ssh password-less … 각각의 edge 가 속한 동일한 법인의
 *   아이실론 장비의 특정 디렉터리 용량도 … /ifs/data/workspace/users/aaa 는 사용자명 aaa … DB 에 저장해서 주기적으로 트래킹".
 *
 * ── 권한: adminOnly + fullScopeOnly ─────────────────────────────────────────
 * 응답에 사용자 이름(= 폴더 이름)별 사용량, 아이실론 주소·SSH 계정, 노드의 SSH 공개키가 들어간다. 사용자별 사용량은 개인 정보에
 * 가깝고 operator 는 `tools` 를 기본 보유하므로 관리자만 본다. 아이실론은 vCenter 귀속이 없어 범위 계정에 나눌 축이 없다 → 403
 * (스토리지 모니터링과 같은 기준). CSV 는 + `data.csv`.
 *
 * ── 이 라우트가 하지 않는 것 ────────────────────────────────────────────────
 *  · 조회는 DB·등록부만 읽는다 — 장비 왕복 0. 조사(du)는 폴러가 주기로, 또는 '지금 수집' 으로만 한다.
 *  · 비밀을 응답에 싣지 않는다(공개키는 비밀이 아니다 — 아이실론의 authorized_keys 에 넣을 값이다).
 *  · '연결 시험' 은 경로 확인(ls -d)만 한다 — du 를 돌리지 않는다(수십 분 걸린다). 엣지 담당 대상은 **그 엣지가** 시험한다(v2.736 —
 *    메인이 엣지의 수집 서버 URL 로 직접 요청, iDRAC PUSH 스캔과 같은 길. `central/isiduRemote.js`).
 */
import { requireRole, requirePerm } from '../../auth/auth.js';
import { requireSuperAdmin } from '../../auth/roles.js';
import { logAudit } from '../../audit.js';
import { fullScopeOnlyWith } from '../admin/shared.js';
import { knownAgentNames } from '../../central/knownAgents.js';
import { listDatacenters } from '../../datacenter/store.js';
import { pickAgent, pickDatacenter } from '../../cvp/formChoices.js';
import { ssrfBlockReason } from '../../collector/registry.js';
import { listDevices, registryLoadError as storageRegistryLoadError } from '../../storage/registry.js';
import { csvLine, CSV_BOM } from '../../util/csv.js';
import { fileStamp, localStamp } from '../../util/dayKey.js';
import { loadSettings, saveSettings, resolveTarget, isiduSettingsLoadError, RANGES, AUTH_MODES, MAX_TARGETS, normalizeTarget } from '../../isidu/settings.js';
import { SIZE_MODES, duCommand } from '../../isidu/parse.js';
import { keyInfo, publicKeyView, ensureKey, keyDir, KEY_FILE_NAME } from '../../isidu/sshKey.js';
import { authGuard, authStopOf, FAIL_KINDS, testTargetPath } from '../../isidu/collect.js';
import { isiduPollerStatus, runNow, FAIL_RETRY_MS, LONG_FAIL_MS } from '../../isidu/poller.js';
import { requestIsiduCollect, isiduRequestState, recentIsiduDrops } from '../../isidu/collectRequests.js';
import { allIsiduEdgeStatus } from '../../central/isiduEdge.js';
import { buildReport, listUsers, allRows, trend, TREND_DAYS, USERS_LIMIT_MAX, buildOverview, OVERVIEW_POOL } from '../../isidu/report.js';
import { nudgeIsiduEdge, testIsiduOnEdge, MIN_ISIDU_EDGE_VERSION } from '../../central/isiduRemote.js';
import { edgeTargetView } from '../../isidu/settings.js';
import { poolSettled } from '../../util/pool.js';
import { HISTORY_AGENT } from '../../isidu/targets.js';
import * as db from '../../isidu/db.js';
import { isMockMode } from '../../mock/demo/flags.js';
import { ensureIsiduDemo } from '../../mock/demo/isidu.js';
import { isiduMailReady, isiduMailStateOf, sendLatestNow } from '../../isidu/notify.js';
import { targetMailOf, mailRecipients, MAIL_LIST_MAX, FAIL_ALERT_MIN_MS } from '../../isidu/mailRules.js';
import { normalizeBulkPatch, applyBulk, removeTargets, bulkIdsOf, settingsRev, BULK_KEYS, NOT_APPLIED_CODES } from '../../isidu/bulk.js';

const adminOnly = requireRole('admin');
const csvPerm = requirePerm('data.csv');
const fullScopeOnly = fullScopeOnlyWith('아이실론 디렉터리 사용량은 전체 범위(vCenter 제한 없는) 계정만 볼 수 있습니다 — 아이실론은 vCenter 에 귀속되지 않습니다.');
const t = (v) => String(v ?? '').trim();
const lo = (v) => t(v).toLowerCase();

function dcList() {
  try { return listDatacenters().map((d) => ({ id: String(d.id), name: String(d.name || d.id) })); } catch { return []; }
}

/** 화면 표에 실을 대상 — 등록부 반영 + 법인 이름 + 최신 상태. */
async function targetRows() {
  const devices = listDevices();
  const dcs = new Map(dcList().map((d) => [d.id, d.name]));
  const latest = await db.latestAll();
  const byId = new Map((latest || []).filter((r) => r.agent === HISTORY_AGENT).map((r) => [r.targetId, r]));
  const ps = isiduPollerStatus();
  const pollerRunning = new Map(ps.running.map((r) => [r.targetId, r]));
  const pollerQueued = new Map((ps.queued || []).map((r) => [r.targetId, r]));               // v2.741 TIMING-02: 동시 실행 상한에 걸려 기다리는 '지금 수집'
  const pollerInterrupted = new Map((ps.interrupted || []).map((r) => [r.targetId, r]));     // v2.737: 재시작으로 중단 · 재개 대기
  const pollerResumes = new Map();
  for (const r of ps.resumes || []) if (!pollerResumes.has(r.targetId)) pollerResumes.set(r.targetId, r);
  const edges = new Map(allIsiduEdgeStatus().map((e) => [lo(e.agent), e]));
  const st = loadSettings();
  const commonTo = st.mail?.commonTo || [];
  return Promise.all(st.targets.map(async (tg) => {
    const r = resolveTarget(tg, { devices });
    const l = byId.get(r.id) || null;
    const ag = t(r.agent);
    const edge = ag ? edges.get(lo(ag)) || null : null;
    const edgeRunning = edge?.status?.poller?.running?.find((x) => x.targetId === r.id) || null;
    const edgeInterrupted = edge?.status?.poller?.interrupted?.find((x) => x.targetId === r.id) || null;
    const edgeResume = edge?.status?.poller?.resumes?.find((x) => x.targetId === r.id) || null;
    return {
      id: r.id, label: r.label || '', path: r.path, sizeMode: r.sizeMode, intervalHours: r.intervalHours, timeoutMin: r.timeoutMin, topN: r.topN,
      enabled: r.enabled !== false, auth: r.auth, port: r.port, username: r.username || '',
      deviceId: r.deviceId || '', deviceName: r.deviceName || '', host: r.host || '', agent: ag,
      // v2.736: 실행 노드의 근거 — 'device'(장비 담당 노드) · 'override'(실행 노드 지정) · 'direct'(직접 입력 대상의 노드).
      agentSource: r.agentSource || 'direct', runVia: r.runVia || (r.deviceId ? 'device' : ''), deviceAgent: r.deviceAgent ?? null,
      datacenterId: r.datacenterId || '', corp: r.datacenterId ? (dcs.get(r.datacenterId) || r.datacenterId) : '',
      issue: r.issue || null, deviceDisabled: !!r.deviceDisabled,
      okScan: l?.okScan ? { id: l.okScan.id, ts: l.okScan.ts, durationMs: l.okScan.durationMs, count: l.okScan.count, total: l.okScan.total, sumBytes: l.okScan.sumBytes, errLines: l.okScan.errLines || 0, node: l.okScan.node || '' } : null,
      lastTry: l?.lastTry ? { id: l.lastTry.id, ts: l.lastTry.ts, ok: l.lastTry.ok, kind: l.lastTry.kind, error: l.lastTry.error, durationMs: l.lastTry.durationMs, node: l.lastTry.node || '', trig: l.lastTry.trig } : null,
      failStreak: l?.failStreak || 0,
      running: ag ? (edgeRunning ? { since: edgeRunning.since, trigger: edgeRunning.trigger, reportedAt: edge.at } : null) : (pollerRunning.get(r.id) || null),
      queued: ag ? null : (pollerQueued.get(r.id) || null),
      request: ag ? isiduRequestState(r.id) : null,
      // v2.737: 업그레이드·재시작으로 끝나지 못한 조사(재개 대기)와 마지막 자동 재개 결과 — 엣지 담당은 그 엣지의 보고.
      interrupted: ag ? edgeInterrupted : (pollerInterrupted.get(r.id) || null),
      lastResume: ag ? edgeResume : (pollerResumes.get(r.id) || null),
      // 엣지 담당 대상의 인증 정지는 엣지에 있다 — 중앙은 그 엣지의 마지막 시도 결과(kind 'auth')로만 안다.
      authStopped: ag ? null : await authStopOf(r),
      // v2.738 결과 메일 — 이 표는 주소를 싣지 않는다(개수·선택만). 주소는 설정 조회에만 있다.
      mail: (() => { const tm = targetMailOf(tg); const rc = mailRecipients(commonTo, tm); return { recipients: rc.to.length, onlyOnChange: tm.onlyOnChange, onFailure: tm.onFailure, excludeCommon: tm.excludeCommon }; })(),
      lastMail: isiduMailStateOf(r.id),
    };
  }));
}

/** 엣지별 상태(공개키 — 관리자가 그 법인 아이실론에 등록할 값). */
function edgeViews() {
  return allIsiduEdgeStatus().map((e) => ({
    agent: e.agent, at: e.at, lastPush: e.lastPush || null,
    key: e.status?.key || null, targets: e.status?.targets ?? null, version: e.status?.version || null,
    poller: e.status?.poller ? { lastTick: e.status.poller.lastTick, running: e.status.poller.running?.length || 0, lastError: e.status.poller.lastError } : null,
  }));
}

function settingsCtx() {
  return { devices: listDevices(), agents: knownAgentNames(), dcs: dcList(), pickAgent, pickDatacenter, ssrfBlockReason };
}

function pickTarget(id) {
  const tg = loadSettings().targets.find((x) => x.id === t(id));
  return tg ? resolveTarget(tg, { devices: listDevices() }) : null;
}

export function registerIsilonDirUsage(api) {

/** 메인 — 대상 목록·최신 상태·노드 키·엣지 키·폴러 상태. */
api.get('/tools/isilon-dirusage', adminOnly, fullScopeOnly, async (_req, res) => {
  const now = Date.now();
  // 데모(mock): 첫 화면이 폴러의 첫 틱(기동 90초 뒤)을 기다리지 않게 — 한 번만 돈다(이후 즉시 반환).
  if (isMockMode()) { try { await ensureIsiduDemo(); } catch { /* 데모 실패는 화면을 막지 않는다 */ } }
  res.json({
    ok: true, now,
    settingsLoadError: isiduSettingsLoadError(), storageRegistryError: storageRegistryLoadError(),
    targets: await targetRows(),
    key: publicKeyView(keyInfo()), keyFile: `${keyDir()}/${KEY_FILE_NAME}`,
    edges: edgeViews(),
    poller: isiduPollerStatus(),
    drops: recentIsiduDrops(),
    // v2.741 DEV-05: failLongMs 이상 돈 실패는 1시간이 아니라 주기만큼 쉰다(화면 '다음 시도' 계산 — isiduOverviewText.nextRunOf).
    failKinds: FAIL_KINDS, failRetryMs: FAIL_RETRY_MS, failLongMs: LONG_FAIL_MS,
    retentionDays: loadSettings().retentionDays,
    db: await db.dbStats(),
  });
});

/**
 * v2.739 개요 — 서브메뉴(서머리 · 법인 현황 · 전 법인 Top 10 · 수집 상태)가 쓰는 대상별 요약 + 최근 실행 기록.
 * 대상마다 전체 크기의 7일 변화·30일 추이·상위 폴더 OVERVIEW_POOL 개(7일 변화 포함)를 싣는다. 전 법인 Top 10 은 화면이 이 합집합에서 고른다.
 * DB 만 읽는다(장비 왕복 0). 대상 목록(상태·법인)은 `GET /tools/isilon-dirusage` 가 준다 — 여기서 다시 싣지 않는다.
 */
api.get('/tools/isilon-dirusage/overview', adminOnly, fullScopeOnly, async (_req, res) => {
  const ids = loadSettings().targets.map((x) => x.id);
  const known = new Set(ids);
  const [targets, recent] = await Promise.all([buildOverview(ids), db.recentScans(HISTORY_AGENT, 80)]);
  res.json({
    ok: true, now: Date.now(), pool: OVERVIEW_POOL, targets,
    recentUnavailable: recent == null,
    recent: (recent || []).filter((r) => known.has(r.targetId)).slice(0, 20).map((r) => ({
      targetId: r.targetId, ts: r.ts, ok: r.ok, kind: r.kind || '', error: r.error ? String(r.error).slice(0, 200) : '',
      durationMs: r.durationMs, count: r.count, errLines: r.errLines || 0, node: r.node || '', trig: r.trig || '',
    })),
  });
});

/** 보고서 — KPI · Top N · 7일 증가 상위 · 신규·사라진 폴더 일부. */
api.get('/tools/isilon-dirusage/report', adminOnly, fullScopeOnly, async (req, res) => {
  const tg = pickTarget(req.query.target);
  if (!tg) return res.status(404).json({ ok: false, reason: '설정에 없는 대상입니다.' });
  const rep = await buildReport(tg.id, { topN: tg.topN });
  res.json({ ok: true, target: { id: tg.id, label: tg.label || '', path: tg.path, sizeMode: tg.sizeMode, topN: tg.topN, intervalHours: tg.intervalHours }, ...rep });
});

/** 전체 사용자 — 검색·필터(신규/사라짐/증가/감소)·정렬·페이지. */
api.get('/tools/isilon-dirusage/users', adminOnly, fullScopeOnly, async (req, res) => {
  const tg = pickTarget(req.query.target);
  if (!tg) return res.status(404).json({ ok: false, reason: '설정에 없는 대상입니다.' });
  const r = await listUsers(tg.id, {
    q: t(req.query.q).slice(0, 100), filter: t(req.query.filter), sort: t(req.query.sort), dir: t(req.query.dir),
    offset: req.query.offset, limit: req.query.limit, spark: req.query.spark !== '0',
  });
  res.json({ ok: true, limitMax: USERS_LIMIT_MAX, ...r });
});

/** 추이 — 디렉터리 전체 또는 사용자 하나. */
api.get('/tools/isilon-dirusage/trend', adminOnly, fullScopeOnly, async (req, res) => {
  const tg = pickTarget(req.query.target);
  if (!tg) return res.status(404).json({ ok: false, reason: '설정에 없는 대상입니다.' });
  const name = t(req.query.name);
  if (name && (name.includes('/') || name.length > 512)) return res.status(400).json({ ok: false, reason: '폴더 이름 형식이 잘못됐습니다.' });
  const r = await trend(tg.id, { name, days: Number(req.query.days) });
  res.json({ ok: true, daysAllowed: TREND_DAYS, ...r });
});

/** CSV — 최신 스캔의 전체 사용자(사라진 폴더 포함). */
api.get('/tools/isilon-dirusage/export.csv', adminOnly, fullScopeOnly, csvPerm, async (req, res) => {
  const tg = pickTarget(req.query.target);
  if (!tg) return res.status(404).json({ ok: false, reason: '설정에 없는 대상입니다.' });
  const r = await allRows(tg.id);
  if (r.state !== 'ok') return res.status(409).json({ ok: false, reason: r.state === 'db-unavailable' ? 'DB 를 쓸 수 없습니다.' : '아직 성공한 조사가 없습니다.' });
  const head = ['순위', '사용자(폴더)', '크기(바이트)', '표기 해상도(바이트)', '비중(%)', '7일 변화(바이트)', '7일 변화 해상도 안', '30일 변화(바이트)', '상태'];
  const lines = [csvLine(head)];
  for (const row of r.rows) {
    const status = row.new7 === true ? '신규(7일)' : (row.d7 && !row.d7.withinRes ? (row.d7.bytes > 0 ? '증가' : '감소') : '');
    lines.push(csvLine([row.rank, row.name, row.bytes, row.res, row.share == null ? '' : (row.share * 100).toFixed(2),
      row.d7 ? row.d7.bytes : '', row.d7 ? (row.d7.withinRes ? 'Y' : 'N') : '', row.d30 ? row.d30.bytes : '', status]));
  }
  for (const row of r.removed7) lines.push(csvLine(['', row.name, row.bytes, row.res, '', '', '', '', '사라짐(7일 전 크기)']));
  const stamp = fileStamp();
  const safe = String(tg.label || tg.id).replace(/[^\w.-]+/g, '_').slice(0, 40) || 'target';
  logAudit({ user: req.user?.username, action: 'isidu.export', target: tg.id, detail: `rows=${r.rows.length} removed=${r.removed7.length}`, ip: req.ip });
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="isilon-dirusage-${safe}-${stamp}.csv"`);
  res.set('Cache-Control', 'no-store');
  res.send(CSV_BOM + lines.join('\r\n') + '\r\n' + csvLine([`# 조사 시각 ${localStamp(r.scan.ts)} · 경로 ${r.scan.path || tg.path} · 표기 ${r.scan.sizeMode === 'k' ? '-k(KB 정확)' : '-h(반올림)'}${r.scan.errLines ? ` · 권한 오류 ${r.scan.errLines}줄(일부 크기가 작을 수 있음)` : ''}`]) + '\r\n');
});

/** 설정 조회 — 대상·보존일 + 고를 목록(아이실론·엣지·DataCenter) + 이 노드의 키. */
api.get('/tools/isilon-dirusage/settings', adminOnly, fullScopeOnly, requireSuperAdmin, (_req, res) => {
  const devices = listDevices().filter((d) => d.type === 'isilon').map((d) => ({ id: d.id, name: d.name || d.host, host: d.host, agent: d.agent || '', datacenterId: d.datacenterId || '', enabled: d.enabled !== false, username: d.username || '' }));
  res.json({
    ok: true, settings: loadSettings(), loadError: isiduSettingsLoadError(),
    rev: settingsRev(loadSettings().targets),   // v2.739 일괄 변경 — 화면이 읽은 판(그 뒤 다른 사람이 바꿨으면 일괄 적용이 409)
    bulkKeys: BULK_KEYS,
    choices: { devices, agents: knownAgentNames(), datacenters: dcList() },
    ranges: RANGES, authModes: AUTH_MODES, sizeModes: SIZE_MODES, maxTargets: MAX_TARGETS,
    key: publicKeyView(keyInfo()),
    // v2.738: 결과 메일을 지금 보낼 수 있는가(전역 메일·SMTP·종류 켜짐) + 입력 상한.
    mailReady: isiduMailReady(), mailLimits: { listMax: MAIL_LIST_MAX, failAlertHours: Math.round(FAIL_ALERT_MIN_MS / 3_600_000) },
  });
});

/** 설정 저장 — 전체 목록 교체(같은 id 의 숫자 빈 칸은 이전 값 유지). */
api.put('/tools/isilon-dirusage/settings', adminOnly, fullScopeOnly, requireSuperAdmin, (req, res) => {
  if (isiduSettingsLoadError()) return res.status(409).json({ ok: false, reason: '저장된 설정 파일을 읽지 못했습니다 — 서비스 점검 화면에서 기본값으로 확정하거나 손상 보존본을 복구한 뒤 저장하세요(덮어쓰면 기존 대상이 사라집니다).' });
  const r = saveSettings(req.body || {}, settingsCtx());
  if (!r.ok) return res.status(400).json({ ok: false, reason: r.error, field: r.field || null, index: r.index ?? null });
  const mailTargets = r.settings.targets.filter((x) => targetMailOf(x).to.length).length;
  logAudit({ user: req.user?.username, action: 'isidu.settings', target: 'isidu-settings.json', detail: `targets=${r.settings.targets.length} retention=${r.settings.retentionDays} mailCommon=${r.settings.mail?.commonTo?.length || 0} mailTargets=${mailTargets}`, ip: req.ip });
  res.json({ ok: true, settings: r.settings, rev: settingsRev(r.settings.targets) });
});

/**
 * 일괄 변경(v2.739) — 고른 대상의 설정 항목을 한꺼번에 바꾸거나(patch) 목록에서 뺀다(remove).
 *  · dryRun:true 면 저장하지 않고 결과만 준다(화면의 미리보기 — 판정은 여기 하나).
 *  · rev(설정을 읽은 판)가 지금과 다르면 409 — 그 사이 다른 사람이 바꾼 값을 덮지 않는다.
 *  · 대상마다 개별 저장과 같은 정규화를 거친다. 맞지 않는 항목은 그 대상에서만 빼고(notApplied), 거절된 대상은 그대로 둔다(skipped).
 *  · 바뀐 대상이 0 이면 저장하지 않는다(파일·백업 변경 감시를 건드리지 않게).
 */
api.post('/tools/isilon-dirusage/bulk', adminOnly, fullScopeOnly, requireSuperAdmin, (req, res) => {
  if (isiduSettingsLoadError()) return res.status(409).json({ ok: false, reason: '저장된 설정 파일을 읽지 못했습니다 — 서비스 점검 화면에서 기본값으로 확정하거나 손상 보존본을 복구한 뒤 바꾸세요.' });
  const body = req.body || {};
  const ids = bulkIdsOf(body.ids);
  if (!ids || !ids.length) return res.status(400).json({ ok: false, reason: '바꿀 대상을 하나 이상 고르세요.', field: 'ids' });
  const cur = loadSettings();
  const rev = settingsRev(cur.targets);
  if (body.rev != null && t(body.rev) !== rev) return res.status(409).json({ ok: false, reason: '설정을 읽은 뒤 다른 곳에서 바뀌었습니다 — 다시 읽은 뒤 적용하세요.', code: 'rev-changed', rev });
  const dryRun = body.dryRun === true;
  let next; let result;
  if (body.remove === true) {
    const r = removeTargets(cur.targets, ids);
    next = r.targets;
    result = { mode: 'remove', removed: r.removed, notFound: r.notFound };
  } else {
    const p = normalizeBulkPatch(body.patch);
    if (p.error) return res.status(400).json({ ok: false, reason: p.error, field: p.field || null });
    const r = applyBulk(cur.targets, ids, p.patch, settingsCtx());
    next = r.targets;
    result = { mode: 'patch', patch: p.patch, changed: r.changed, unchanged: r.unchanged, skipped: r.skipped, notApplied: r.notApplied, notFound: r.notFound, notAppliedCodes: NOT_APPLIED_CODES };
  }
  const touched = result.mode === 'remove' ? result.removed.length : result.changed.length;
  if (dryRun || !touched) return res.json({ ok: true, dryRun, saved: false, rev, ...result });
  const s = saveSettings({ targets: next, retentionDays: cur.retentionDays }, settingsCtx());
  if (!s.ok) return res.status(400).json({ ok: false, reason: s.error, field: s.field || null, index: s.index ?? null });
  const what = result.mode === 'remove' ? `remove=${result.removed.length}` : `keys=${Object.keys(result.patch).join(',')} changed=${result.changed.length} skipped=${result.skipped.length}`;
  logAudit({ user: req.user?.username, action: 'isidu.bulk', target: ids.join(',').slice(0, 200), detail: what.slice(0, 300), ip: req.ip });
  res.json({ ok: true, dryRun: false, saved: true, settings: s.settings, rev: settingsRev(s.settings.targets), ...result });
});

/**
 * 지금 수집 — 중앙 담당은 바로 시작, 엣지 담당은 요청을 큐에 남기고 **그 엣지에 바로 알린다**(v2.736 — 엣지가 설정을 지금 다시 받아
 * 요청을 꺼낸다). 알림이 실패해도 요청은 큐에 남아 엣지의 다음 설정 pull(기본 5분)이 가져간다 — 응답 `nudged` 가 엣지마다 그 결과를 말한다.
 * du 결과는 기다리지 않는다(수십 분).
 */
api.post('/tools/isilon-dirusage/run', adminOnly, fullScopeOnly, async (req, res) => {
  const want = Array.isArray(req.body?.ids) ? req.body.ids.map(t).filter(Boolean).slice(0, MAX_TARGETS) : null;
  const devices = listDevices();
  const all = loadSettings().targets.map((x) => resolveTarget(x, { devices }));
  const pick = want ? all.filter((x) => want.includes(x.id)) : all.filter((x) => x.enabled !== false);
  const notFound = want ? want.filter((id) => !all.some((x) => x.id === id)) : [];
  const issues = []; const local = []; const requested = []; const duplicate = [];
  for (const r of pick) {
    if (r.issue) { issues.push({ id: r.id, issue: r.issue }); continue; }
    if (t(r.agent)) {
      const q = requestIsiduCollect(r.id, r.agent);
      (q.duplicate ? duplicate : requested).push({ id: r.id, agent: r.agent });
    } else local.push(r.id);
  }
  // v2.741 TIMING-02: 동시 실행 상한(ISIDU_CONCURRENCY)을 넘는 대상은 대기열(queued)에 들어가 앞 조사가 끝나면 차례로 시작한다.
  const lr = local.length ? await runNow(local, { trigger: 'manual' }) : { started: [], queued: [], busy: [], notHere: [], concurrency: null };
  // 요청을 넣은 엣지마다 한 번씩(대소문자 무시) — 같은 엣지의 대상이 여럿이어도 알림은 하나다. 동시 4, 재시도 없음.
  const agents = [...new Map([...requested, ...duplicate].map((x) => [lo(x.agent), x.agent])).values()];
  const nudged = (await poolSettled(agents, 4, (agent) => nudgeIsiduEdge(agent)))
    .map((x, i) => ({ agent: agents[i], ...(x.status === 'fulfilled' ? x.value : { ok: false, kind: 'unreachable', reason: String(x.reason?.message || x.reason).slice(0, 300) }) }));
  logAudit({ user: req.user?.username, action: 'isidu.run', target: want ? want.join(',').slice(0, 200) : '(전체)', detail: `started=${lr.started.length} queued=${(lr.queued || []).length} requested=${requested.length} nudged=${nudged.filter((x) => x.ok).length}/${nudged.length}`, ip: req.ip });
  res.status(202).json({ ok: true, started: lr.started, queued: lr.queued || [], concurrency: lr.concurrency ?? null, busy: lr.busy, notHere: lr.notHere, requested, duplicate, issues, notFound, nudged, minEdgeVersion: MIN_ISIDU_EDGE_VERSION });
});

/**
 * 연결 시험 — 경로가 있는지만 본다(`ls -d`). 본문의 대상(저장 전)도 시험할 수 있다 — 같은 정규화를 거친다.
 * 등록부 계정 인증이면 주소는 등록부 값만 쓴다(본문 주소로 장비 비밀번호를 보내지 않는다 — v2.480).
 */
api.post('/tools/isilon-dirusage/test', adminOnly, fullScopeOnly, requireSuperAdmin, async (req, res) => {
  const cur = loadSettings().targets;
  const prev = req.body?.id ? cur.find((x) => x.id === t(req.body.id)) || null : null;
  const n = normalizeTarget(req.body || {}, prev, settingsCtx());
  if (n.error) return res.status(400).json({ ok: false, reason: n.error, field: n.field || null });
  const r = resolveTarget(n.target, { devices: listDevices() });
  if (r.issue) return res.status(409).json({ ok: false, reason: r.issue === 'device-missing' ? '스토리지 등록부에 그 아이실론이 없습니다.' : '고른 장비가 아이실론이 아닙니다.' });
  // 데모(mock) 대상은 어느 노드로 지정돼 있어도 접속하지 않는다(데모 엣지는 실제로 없다).
  if (String(r.id || '').startsWith('mock-') && isMockMode()) {
    return res.json({ ok: true, demo: true, ms: 0, out: `${r.path} (데모 — 접속하지 않았습니다)`, command: duCommand(r.path, r.sizeMode), via: t(r.agent) ? 'edge' : 'main', node: t(r.agent) });
  }
  if (t(r.agent)) {
    // v2.736: 엣지 담당 대상은 **그 엣지가** 시험한다(메인이 엣지의 수집 서버 URL 로 요청 — iDRAC PUSH 스캔과 같은 길).
    // 보내는 것은 비밀 없는 대상 사본(edgeTargetView)뿐이다 — 엣지는 자기 키·자기 스토리지 등록부로 접속한다.
    const x = await testIsiduOnEdge(r.agent, edgeTargetView(r));
    logAudit({ user: req.user?.username, action: 'isidu.test', target: `${r.host}:${r.port} via ${r.agent}`, detail: x.ok ? 'ok' : `fail: ${String(x.reason || x.kind || '').slice(0, 120)}`, ip: req.ip });
    return res.json({ ...x, command: x.command || duCommand(r.path, r.sizeMode) });
  }
  const x = await testTargetPath(r, { clearStopId: prev ? prev.id : '' });   // 저장된 대상의 시험이 성공하면 인증 정지를 푼다(v2.590 규약)
  if (x.demo) return res.json({ ...x, via: 'main', node: '' });
  if (x.attempted === false) {
    // 접속 정보를 만들지 못했다(키 없음·등록부에 장비 없음) — 접속은 시도하지 않았다.
    return res.status(409).json({ ok: false, via: 'main', node: '', kind: x.kind, reason: x.reason });
  }
  logAudit({ user: req.user?.username, action: 'isidu.test', target: `${r.host}:${r.port}`, detail: x.ok ? 'ok' : `fail: ${String(x.reason || '').slice(0, 120)}`, ip: req.ip });
  res.json({ ...x, via: 'main', node: '' });
});

/**
 * 결과 메일 지금 보내기(v2.738) — 그 대상의 마지막 성공 결과를 그 대상의 받는 사람(공통 ∪ 대상별)에게 보낸다.
 * '변화 없으면 생략' 은 보지 않는다(사람이 누른 것이다). 데모 대상은 보내지 않는다. 주소는 응답·감사에 싣지 않는다(개수만).
 */
api.post('/tools/isilon-dirusage/mail-now', adminOnly, fullScopeOnly, requireSuperAdmin, async (req, res) => {
  const id = t(req.body?.id);
  if (!id || !loadSettings().targets.some((x) => x.id === id)) return res.status(404).json({ ok: false, reason: '설정에 없는 대상입니다.' });
  const r = await sendLatestNow(id, req.user?.username || 'admin');
  logAudit({ user: req.user?.username, action: 'isidu.mail', target: id, detail: `${r.state}${r.to != null ? ` to=${r.to}` : ''}${r.reason ? ` · ${String(r.reason).slice(0, 120)}` : ''}`, ip: req.ip });
  if (r.ok) return res.json(r);
  // 보내지 못한 것은 409(본문이 사유를 말한다) — 5xx 로 주면 재시도하는 호출부가 같은 메일을 두 번 보낼 수 있다.
  res.status(r.state === 'gone' ? 404 : 409).json(r);
});

/** 이 노드(중앙)의 SSH 키 만들기 — 없을 때만. 공개키를 돌려준다(아이실론 authorized_keys 에 넣을 값). */
api.post('/tools/isilon-dirusage/key', adminOnly, fullScopeOnly, requireSuperAdmin, (req, res) => {
  try {
    const r = ensureKey();
    if (r.created) logAudit({ user: req.user?.username, action: 'isidu.key.create', target: KEY_FILE_NAME, detail: `fp=${r.info?.fingerprint || ''}`, ip: req.ip });
    res.json({ ok: true, created: !!r.created, key: publicKeyView(keyInfo({ fresh: true })) });
  } catch (e) {
    res.status(500).json({ ok: false, reason: `SSH 키를 만들지 못했습니다: ${e.message}` });
  }
});

}
