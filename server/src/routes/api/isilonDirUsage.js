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
import { isAdminReq } from '../../auth/addressMask.js';
import { scopeDbStatus } from '../../auth/scopeStatus.js';
import { logAudit } from '../../audit.js';
import { fullScopeOnlyWith } from '../admin/shared.js';
import { knownAgentNames } from '../../central/knownAgents.js';
import { pickAgent, pickDatacenter } from '../../cvp/formChoices.js';
import { ssrfBlockReason } from '../../collector/registry.js';
import { listDevices, registryLoadError as storageRegistryLoadError } from '../../storage/registry.js';
import { summarizeRegistryError, REGISTRY_ERROR_LABEL } from '../../util/registryCore.js'; // v2.744(최종 수정분 검토 RV2744F-LOAD-02)
import { csvLine, CSV_BOM } from '../../util/csv.js';
import { fileStamp, localStamp } from '../../util/dayKey.js';
import { loadSettings, saveSettings, resolveTarget, isiduSettingsLoadError, RANGES, AUTH_MODES, MAX_TARGETS, normalizeTarget } from '../../isidu/settings.js';
import { SIZE_MODES, duCommand } from '../../isidu/parse.js';
import { keyInfo, publicKeyView, ensureKey, keyDir, KEY_FILE_NAME } from '../../isidu/sshKey.js';
import { authGuard, FAIL_KINDS, testTargetPath } from '../../isidu/collect.js';
import { isiduPollerStatus, runNow, FAIL_RETRY_MS, LONG_FAIL_MS } from '../../isidu/poller.js';
import { requestIsiduCollect, recentIsiduDrops } from '../../isidu/collectRequests.js';
import { allIsiduEdgeStatus } from '../../central/isiduEdge.js';
import { buildReport, listUsers, allRows, trend, TREND_DAYS, USERS_LIMIT_MAX, buildOverview, OVERVIEW_POOL } from '../../isidu/report.js';
import { nudgeIsiduEdge, testIsiduOnEdge, MIN_ISIDU_EDGE_VERSION } from '../../central/isiduRemote.js';
import { edgeTargetView } from '../../isidu/settings.js';
import { poolSettled } from '../../util/pool.js';
import { HISTORY_AGENT } from '../../isidu/targets.js';
import * as db from '../../isidu/db.js';
import { isMockMode } from '../../mock/demo/flags.js';
import { ensureIsiduDemo } from '../../mock/demo/isidu.js';
import { isiduMailReady, sendLatestNow } from '../../isidu/notify.js';
import { targetMailOf, MAIL_LIST_MAX, FAIL_ALERT_MIN_MS, isEmail } from '../../isidu/mailRules.js';
import { load as loadMailCfg } from '../../mail/settings.js';
import { DAY_OFFSET_MIN } from '../../util/dayKey.js';
import { normalizeBulkPatch, applyBulk, removeTargets, bulkIdsOf, settingsRev, BULK_KEYS, NOT_APPLIED_CODES } from '../../isidu/bulk.js';
import { targetRows, dcList } from '../../isidu/rows.js';   // v2.742: 목록 행 조립은 종합 메일과 같이 쓴다
import { saveDigestSettings } from '../../isidu/settings.js';
import { isiduDigestStatus, sendDigestNow, previewDigest } from '../../isidu/digest.js';
import { DIGEST_TOPN_CHOICES, DIGEST_GRACE_MS, SURGE_MIN_BYTES, SURGE_MIN_RATIO } from '../../isidu/digestRules.js';

const adminOnly = requireRole('admin');
const csvPerm = requirePerm('data.csv');
const fullScopeOnly = fullScopeOnlyWith('아이실론 디렉터리 사용량은 전체 범위(vCenter 제한 없는) 계정만 볼 수 있습니다 — 아이실론은 vCenter 에 귀속되지 않습니다.');
const t = (v) => String(v ?? '').trim();
const lo = (v) => t(v).toLowerCase();

/** 엣지별 상태(공개키 — 관리자가 그 법인 아이실론에 등록할 값). */
function edgeViews() {
  return allIsiduEdgeStatus().map((e) => ({
    agent: e.agent, at: e.at, lastPush: e.lastPush || null,
    key: e.status?.key || null, targets: e.status?.targets ?? null, version: e.status?.version || null,
    poller: e.status?.poller ? { lastTick: e.status.poller.lastTick, running: e.status.poller.running?.length || 0, lastError: e.status.poller.lastError } : null,
  }));
}

/**
 * v2.744(최종 수정분 검토 RV2744F-LOAD-02): 스토리지 등록부 로드 오류의 **응답 모양**(순수 — 원본을 바꾸지 않는다).
 *   `storageRegistryLoadError().reason` 은 V8 JSON.parse 오류 원문이라 오류 위치 앞뒤 파일 조각(손상된 storage-devices.json 의 장비 비밀번호
 *   앞부분)을 싣는다 — 예전에는 그 객체를 응답에 그대로 실어 브라우저 네트워크 응답·HAR·프록시 로그에 조각이 남았다. 같은 등록부 오류를 내보내는
 *   형제 경로(routes/central.js registryUnreadable · partFaults maskRegistryUnreadable · bmusage sourceErrorsView · central/fleet.js fleetPartialsSummary)와
 *   같은 규칙이다: 관리자 상세(isAdminReq — 데모 계정 제외)에는 분류 + 위치 숫자(summarizeRegistryError().text), 그 밖에는 분류 고정 문구(label)만 +
 *   `reasonDetailHidden`. 화면(IsilonDirUsageTool.jsx)은 이 값이 **있는지만** 본다 — 오류가 없으면 null(진리값 뜻 그대로).
 * @param {null|{at:number, reason:string}} err  storageRegistryLoadError() 값
 * @param {{detail?:boolean}} [o]
 * @returns {null|{at:(number|null), code:string, reason:string, reasonDetailHidden?:true}}
 */
export function storageRegistryErrorView(err, { detail = false } = {}) {
  if (!err || typeof err !== 'object') return null;
  const sum = summarizeRegistryError(err) || summarizeRegistryError({ reason: '' });
  const at = Number.isFinite(err.at) ? err.at : null;
  return detail ? { at, code: sum.code, reason: sum.text }
    : { at, code: sum.code, reason: sum.label || REGISTRY_ERROR_LABEL['read-error'], reasonDetailHidden: true };
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
api.get('/tools/isilon-dirusage', adminOnly, fullScopeOnly, async (req, res) => {
  const now = Date.now();
  // 데모(mock): 첫 화면이 폴러의 첫 틱(기동 90초 뒤)을 기다리지 않게 — 한 번만 돈다(이후 즉시 반환).
  if (isMockMode()) { try { await ensureIsiduDemo(); } catch { /* 데모 실패는 화면을 막지 않는다 */ } }
  res.json({
    ok: true, now,
    settingsLoadError: isiduSettingsLoadError(), storageRegistryError: storageRegistryErrorView(storageRegistryLoadError(), { detail: isAdminReq(req) }),
    targets: await targetRows(),
    // v2.743 AUTHZ-01: 키 파일·DB 의 절대 경로(CONFIG_DIR)는 관리자 상세(데모 계정 제외)에게만 — 그 밖에는 파일 이름만.
    key: publicKeyView(keyInfo()), keyFile: isAdminReq(req) ? `${keyDir()}/${KEY_FILE_NAME}` : KEY_FILE_NAME,
    edges: edgeViews(),
    poller: isiduPollerStatus(),
    drops: recentIsiduDrops(),
    // v2.741 DEV-05: failLongMs 이상 돈 실패는 1시간이 아니라 주기만큼 쉰다(화면 '다음 시도' 계산 — isiduOverviewText.nextRunOf).
    failKinds: FAIL_KINDS, failRetryMs: FAIL_RETRY_MS, failLongMs: LONG_FAIL_MS,
    retentionDays: loadSettings().retentionDays,
    db: scopeDbStatus(await db.dbStats(), req.user),
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

/**
 * 종합 메일(v2.742) — 전 법인 결과를 모아 정한 요일·시각(포탈 시각)에 한 통으로 보낸다. 슈퍼 관리자 전용(수집 대상 설정과 같은 기준).
 *  · 조회는 설정 + 상태(다음 회차 3번 · 최근 기록 — 주소 없이 개수만) + 받는 사람 수(통합 관리자 · 추가 · 겹침).
 *  · 저장은 종합 메일 설정만 바꾼다(대상 목록 저장이 이 값을 지우지 않고, 이 저장도 대상 목록을 건드리지 않는다).
 */
function digestView() {
  const s = loadSettings();
  // 통합 관리자(메일 설정의 기본 받는 사람) — 화면이 저장 전 입력으로 받는 사람 수(겹침 포함)를 세는 데 쓴다. 이 라우트는 슈퍼 관리자 전용이고
  // 같은 주소는 설정 › 메일 발송에서도 보인다. 상태(status)·기록에는 여전히 주소를 싣지 않는다.
  let adminTo = [];
  try { adminTo = (loadMailCfg().defaultTo || []).filter(isEmail).slice(0, MAIL_LIST_MAX); } catch { adminTo = []; }
  return {
    ok: true, digest: s.mail?.digest || null, status: isiduDigestStatus(), loadError: isiduSettingsLoadError(), adminTo,
    mailReady: isiduMailReady(), topNChoices: DIGEST_TOPN_CHOICES, graceMin: Math.round(DIGEST_GRACE_MS / 60_000),
    surge: { minBytes: SURGE_MIN_BYTES, minRatio: SURGE_MIN_RATIO }, listMax: MAIL_LIST_MAX, offsetMin: DAY_OFFSET_MIN,
  };
}
api.get('/tools/isilon-dirusage/digest', adminOnly, fullScopeOnly, requireSuperAdmin, (_req, res) => { res.json(digestView()); });

api.put('/tools/isilon-dirusage/digest', adminOnly, fullScopeOnly, requireSuperAdmin, (req, res) => {
  if (isiduSettingsLoadError()) return res.status(409).json({ ok: false, reason: '저장된 설정 파일을 읽지 못했습니다 — 서비스 점검 화면에서 기본값으로 확정하거나 손상 보존본을 복구한 뒤 저장하세요.' });
  const r = saveDigestSettings(req.body?.digest ?? req.body ?? {});
  if (!r.ok) return res.status(r.unreadable ? 409 : 400).json({ ok: false, reason: r.error, field: r.field || null });
  const d = r.digest;
  logAudit({ user: req.user?.username, action: 'isidu.digest', target: 'isidu-settings.json', detail: `enabled=${d.enabled} days=${d.days.join('')} time=${d.time} admin=${d.includeAdmin} extra=${d.to.length} topN=${d.topN} watch=${d.includeWatch} targets=${d.includeTargets} skipIfNoNew=${d.skipIfNoNew}`, ip: req.ip });
  res.json(digestView());
});

/** 지금 한 번 보내기 — 저장된 설정·받는 사람으로 보낸다('새 조사 없으면 생략' 은 보지 않는다). 실패는 409(본문이 사유 — 재시도로 두 번 보내지 않게). */
api.post('/tools/isilon-dirusage/digest/send-now', adminOnly, fullScopeOnly, requireSuperAdmin, async (req, res) => {
  const r = await sendDigestNow(req.user?.username || 'admin');
  logAudit({ user: req.user?.username, action: 'isidu.digest.send', target: 'digest', detail: `${r.state}${r.to != null ? ` to=${r.to}` : ''}${r.reason ? ` · ${String(r.reason).slice(0, 120)}` : ''}`, ip: req.ip });
  if (r.ok) return res.json(r);
  res.status(409).json(r);
});

/** 미리보기 — 보내지 않는다. 본문 값(저장하지 않은 화면 값)이 있으면 그 값으로 만든다. 데모 대상도 넣고 그 사실을 밝힌다. */
api.post('/tools/isilon-dirusage/digest/preview', adminOnly, fullScopeOnly, requireSuperAdmin, async (req, res) => {
  const r = await previewDigest(req.body?.digest ?? null);
  if (!r.ok) return res.status(400).json({ ok: false, reason: r.error, field: r.field || null });
  res.json(r);
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
