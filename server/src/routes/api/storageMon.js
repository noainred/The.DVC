// 스토리지 모니터링 라우트(v2.302) — 특수기능 '스토리지 모니터링(Isilon 등)' 화면용.
// 조회: 전체 범위 계정만(스토리지는 vCenter 귀속이 없는 인프라 장비 — 'vCenter 귀속 없는
// 데이터는 범위 계정에 노출 금지' 규칙, fleet 과 동일 403 패턴). 변경: adminOnly + 감사로그.
import { fullScopeOnlyWith } from '../admin/shared.js';
import { requireRole, requirePerm } from '../../auth/auth.js';
import { store } from '../../store.js';
import { logAudit } from '../../audit.js';
import { STORAGE_TYPES, collectMethodsFor, normalizeCollectMethod } from '../../storage/types.js';
import { listDevices, listDevicesWithSecrets, saveDevice, deleteDevice, deviceInputIssue, getDeviceWithSecret } from '../../storage/registry.js';
import { requireSettingsOwner } from '../admin/shared.js';
import { localSnapshots, dropSnapshot } from '../../storage/store.js';
import { collectDeviceNow, storagePollerStatus, pollStorageOnce, testDeviceConnection } from '../../storage/poller.js';
import { edgeStorageSnapshots, edgeStorageReports } from '../../central/storageEdge.js';
import { listActivity } from '../../storage/activityLog.js';
import { areaSummary, areaJson, capacityHistory, capacityHistoryAll, dbAvailable,
  dailySeries, dailySpans, dayIndex, dayLabel, dayStartMs, pruneNow, effectiveKeepDays, DAY_OFFSET_MIN, capacityResets } from '../../storage/db.js';
import { growthMatrix, normalizePeriods, DEFAULT_PERIODS } from '../../storage/growth.js';
import { GROWTH_SPEC, loadGrowthSettings, saveGrowthSettings } from '../../storage/growthSettings.js';
import { AREA_LABEL } from '../../storage/onefsCatalog.js';
import { listDatacenters } from '../../datacenter/store.js';
import { knownAgentNames } from '../../central/knownAgents.js';
import { devicesToCsv, sampleCsv, parseDevicesCsv, analyzeImport, methodChangeHints,
  devicesToText, sampleText, parseDevicesText, TEXT_FIELDS } from '../../storage/csv.js';
import { enrichAdvice, selectRows } from '../../util/bulkImport.js';
import { startBulkTest, publicRun, passedLines } from '../../util/bulkRun.js';
import { requestCollect, hasPendingRequest, recentCollectDrops } from '../../storage/collectRequests.js';
import { INTERVAL_SPEC, loadIntervalConfig, saveIntervalConfig, intervalsForAgent,
  envIntervals, runtimeIntervalSource, applyOwnIntervals } from '../../storage/intervals.js';

import { isAdminReq, maskDeviceAddress, maskSnapAddress, maskActivityEvents, maskPollerStatus } from '../../auth/addressMask.js';
import { latestMapByDevice } from '../../storage/latestSnapshots.js';
import { numOrNull } from '../../util/numOrNull.js';
/**
 * 연결 테스트 응답의 개수 요약(v2.603 RECENT2603-04). 노드·경보는 수집기가 못 읽으면 null 이다 — 0 으로 바꾸지 않는다
 * (0 은 '경보 없음' 이라는 거짓). 풀·계정은 배열 길이라 빈 배열이면 0 이 맞다.
 */
export function testCounts(snap) {
  return {
    nodes: numOrNull(snap?.nodes?.count), pools: (snap?.pools || []).length,
    accounts: (snap?.accounts || []).length, alerts: numOrNull(snap?.alerts?.unresolved),
  };
}
const adminOnly = requireRole('admin');
const toolsPerm = requirePerm('tools'); // 조회 라우트 기능 권한(v2.416 감사 L-3)
// v2.583: 같은 6줄이 라우트 파일 8곳에 복사돼 있었다 — 공용 팩토리 하나로(사유 문구는 그대로).
const fullScopeOnly = fullScopeOnlyWith('스토리지 모니터링은 전체 범위(vCenter 제한 없는) 계정만 조회할 수 있습니다.');

export function registerStorageMon(api) {

/**
 * 통합 조회 — 이 노드(중앙) 직접 수집분 + 전 엣지 push 분을 합쳐 장비별 최신 스냅샷을 반환.
 * 같은 deviceId 가 양쪽에 있으면 최신 collectedAt 우선. 법인/타입별 뷰는 프론트가 이 평탄
 * 목록을 그룹핑한다(뷰 추가가 서버 변경 없이 가능 — 확장 요구 반영).
 */
api.get('/tools/storage', toolsPerm, fullScopeOnly, (req, res) => {
  // v2.599(EDGE2599-02): 장비마다 최신 collectedAt 하나 — 공개 API 와 같은 판정 하나(storage/latestSnapshots.js).
  const byId = latestMapByDevice([localSnapshots(), edgeStorageSnapshots()]);
  const devices = listDevices().map((d) => ({ ...d, snap: byId.get(d.id) || null }));
  // 등록부에 없는데 스냅샷만 있는 항목(엣지 잔존 push 등)도 정직하게 노출(orphan 표기).
  const known = new Set(devices.map((d) => d.id));
  const orphans = [...byId.values()].filter((s) => !known.has(s.deviceId));
  // v2.599(AUTHZ-2599-03): 비-admin(tools 권한 operator 등)에는 관리 IP·계정명을 가리고 그 사실을 밝힌다
  //   (v2.593 relaytopo maskTopology 와 같은 기준 — 등록·수정·테스트는 adminOnly 라 화면 기능은 그대로다).
  const admin = isAdminReq(req);
  res.json({
    devices: admin ? devices : devices.map(maskDeviceAddress),
    orphans: admin ? orphans : orphans.map(maskSnapAddress),
    ...(admin ? {} : { addressHidden: true }),
    // 타입 카탈로그에 '수집 방식 목록'을 붙여 내려준다(v2.405) — 등록 폼이 타입별 메뉴를
    // 그 목록으로 그린다. 규칙이 프론트에 복사되지 않게 서버가 단일 소스다.
    types: STORAGE_TYPES.map((t) => ({ ...t, methods: collectMethodsFor(t.type) })),
    datacenters: (() => { try { return listDatacenters(); } catch { return []; } })(),
    // 엣지 목록: per-agent 토큰뿐 아니라 중앙과 통신 중인 모든 알려진 엣지를 병합(v2.312 —
    // iDRAC 위임과 동일 소스). 토큰 미발급(공유 CENTRAL_TOKEN) 환경에서도 엣지를 고를 수 있다.
    agents: knownAgentNames(),
    poller: storagePollerStatus(),
    // v2.591: 엣지가 가져갔지만 새 수집 결과가 오지 않아 재인출 뒤 폐기한 '지금 수집' 요청 — 화면이 말한다(조용한 소실 금지).
    collectDrops: recentCollectDrops(),
    // v2.581(BUG-D): 엣지별 보고 요약 — 장비 보고 시각·대수 + 상태 전용 보고(0대). 화면이 '엣지가 0대라고
    // 보고했다' 와 '엣지가 아무것도 안 보냈다' 를 구분해 말한다.
    edgeReports: edgeStorageReports(),
    // v2.582 BUG-4: 화면 각주가 'config pull(≤5분) · push(≤5분)' 을 **숫자로 박고** 있었다(CLAUDE.md '주기 숫자를
    // 문구에 박지 말 것'). 중앙이 배포하는 값(전역 지정)이 있으면 그것, 없으면 기본값을 실어 준다. 엣지가 portal.env 로
    // 현장 값을 잡았으면 중앙은 그것을 모른다 — 그래서 'source' 를 함께 실어 화면이 '중앙 지정'/'기본값' 을 밝힌다.
    edgeIntervals: (() => {
      try {
        const g = loadIntervalConfig().global || {};
        const pick = (key) => { const spec = INTERVAL_SPEC.find((x) => x.key === key); const v = Number(g[key]); return Number.isFinite(v) && v > 0 ? { ms: v, source: 'central' } : { ms: spec?.def ?? null, source: 'default' }; };
        return { configPull: pick('configPullMs'), push: pick('pushMs') };
      } catch { return null; }
    })(),
  });
});

/**
 * 등록/수정 전 연결·API 동작 테스트(v2.404, 사용자 요구 — Unity 등록 시 API 가 실제로 도는지).
 * 저장하지 않고 입력값 그대로 수집기를 1회 돌려 '무엇이 되고 무엇이 안 되는지'를 돌려준다.
 *
 * 보안:
 *  - adminOnly (다른 스토리지 상태변경 라우트와 동일 게이트). 자격증명으로 외부 장비에
 *    접속하는 동작이라 조회 권한으로 열면 안 된다.
 *  - 검증은 deviceInputIssue 단일 소스 — 타입/표시명/host 형식 + **ssrfBlockReason** 을
 *    그대로 탄다(임의 host 로 내부망을 찌르는 프로브가 되지 않게).
 *  - ⚠ host 가 바뀌면 저장된 비밀번호를 절대 이월하지 않는다(registry.saveDevice 의
 *    'host 변경 시 비번 이월 금지'와 같은 규칙 — uagmon M3). 이월하면 host 만 공격자
 *    주소로 바꿔 테스트를 눌러 장비 비밀번호를 그 서버로 선제 전송시킬 수 있다.
 *  - 응답에 비밀번호를 싣지 않는다(수집기 스냅샷에는 없음). 오류 문자열도 restCommon 의
 *    헤더 사전검증으로 값이 되울려 나오지 않는다.
 *  - 감사로그를 남긴다(자격증명 사용 + 외부 접속 시도).
 */
api.post('/tools/storage/test', adminOnly, async (req, res) => {
  const body = req.body || {};
  const issue = deviceInputIssue(body);
  if (issue) return res.status(400).json({ ok: false, reason: issue });

  const host = String(body.host || '').trim();
  const existing = body.id ? getDeviceWithSecret(body.id) : null;
  // 수정 화면은 비밀번호를 비워 보낸다(= '기존 유지'). host 가 그대로일 때만 저장분을 쓴다.
  let password = String(body.password || '');
  let pwSource = 'input';
  if (!password && existing && existing.host === host) { password = existing.password || ''; pwSource = 'stored'; }
  if (!password) {
    return res.status(400).json({ ok: false, reason: existing && existing.host !== host
      ? 'host 를 변경했으므로 비밀번호를 다시 입력해야 테스트할 수 있습니다(저장된 비밀번호는 새 주소로 보내지 않습니다).'
      : '비밀번호를 입력하세요.' });
  }

  const device = {
    id: body.id || '__test__', type: String(body.type || '').trim(), name: String(body.name || '').trim(),
    host, username: String(body.username || '').trim(), password,
    // isilon 만 ssh/api 선택(그 외 타입은 수집기가 API 전용) — saveDevice 와 같은 규칙.
    // 저장 경로(saveDevice)와 같은 보정 규칙을 쓴다 — 테스트는 통과했는데 저장은 다른 방식으로
    // 돌아가는 어긋남을 막는다(types.js COLLECT_METHODS 단일 소스).
    collectMethod: normalizeCollectMethod(String(body.type || '').trim(), String(body.collectMethod || '')),
    sshPort: Number(body.sshPort) || 22,
  };

  const snap = await testDeviceConnection(device);
  logAudit({
    user: req.user?.username, action: '스토리지 연결 테스트', target: `${device.type}/${device.name}`,
    detail: `${device.host} · ${snap.ok ? '성공' : `실패: ${snap.error || '사유 미상'}`} · ${snap.ms}ms · 비번=${pwSource === 'stored' ? '저장분' : '입력값'}`,
  });

  // 결과 요약만 — 원본 스냅샷 전체(노드 목록 등)는 테스트 화면에 불필요하고 응답만 커진다.
  res.json({
    ok: !!snap.ok,
    ms: snap.ms,
    error: snap.error || '',
    name: snap.name || '',
    version: snap.version || '',
    serial: snap.serial || '',
    capacity: snap.capacity || null,
    // v2.603 RECENT2603-04: 노드·경보 수를 읽지 못한 수집기(PowerMax 경보 미수집 — v2.602 가 null 로 둔다)의 null 을
    //   `?? 0` 이 다시 0 으로 바꿔 화면이 '경보 0' 이라 했다. 못 읽은 값은 null 그대로 두고 화면이 '—' 로 그린다.
    counts: testCounts(snap),
    sections: snap.sections || {},
    // SSH CLI 수집기(pstcli·uemcli·xmcli·vplexcli)는 각 명령의 원문 앞부분을 남긴다(v2.405).
    // 이 CLI 들의 출력 형식은 버전마다 달라 파싱이 빗나갈 수 있는데, 원문을 못 보면 원격 장비의
    // 문제를 추측으로만 다뤄야 한다. adminOnly 라우트이고 장비 소유자가 보는 값이며, 자격증명은
    // 명령줄에 싣지 않으므로(그 계정으로 SSH 접속한 상태에서 실행) 원문에 비밀번호가 없다.
    cliRaw: Array.isArray(snap.extra?.cliRaw) ? snap.extra.cliRaw : undefined,
  });
});

api.post('/tools/storage/devices', adminOnly, (req, res) => {
  try {
    const d = saveDevice(req.body || {});
    logAudit({ user: req.user?.username, action: '스토리지 장비 저장', target: `${d.type}/${d.name}`, detail: `${d.host} · 수집=${d.agent || '중앙'}` });
    res.status(201).json({ ok: true, device: d });
    // v2.522: 중복 거부는 **충돌 장비를 함께** 내려준다 — 화면이 '그 장비 보기'로 필터를 풀고
    // 데려간다(사유만 주면 13개 법인·42대에서 사용자가 찾을 수 없다는 실제 신고).
  } catch (e) { res.status(400).json({ ok: false, reason: e.message, conflict: e.conflict || null }); }
});

api.delete('/tools/storage/devices/:id', adminOnly, (req, res) => {
  if (!deleteDevice(req.params.id)) return res.status(404).json({ ok: false, reason: '장비를 찾을 수 없습니다.' });
  dropSnapshot(req.params.id); // 지운 장비의 낡은 스냅샷이 화면에 유령으로 남지 않게
  logAudit({ user: req.user?.username, action: '스토리지 장비 삭제', target: req.params.id });
  res.json({ ok: true });
});

/**
 * 수집 작업 로그(v2.315, 사용자 요구 '진행중/완료 창').
 * poller.inFlight = 지금 수집 중인 장비('진행중'), events = 최근 완료 이벤트('완료', newest-first).
 * 조회 전용이라 fullScopeOnly(스토리지는 vCenter 범위 밖 — 다른 스토리지 조회와 동일 게이트).
 */
api.get('/tools/storage/activity', toolsPerm, fullScopeOnly, (req, res) => {
  // v2.599(AUTHZ-2599-03): 목록과 같은 기준 — 비-admin 에는 작업 로그의 관리 주소도 가린다.
  const admin = isAdminReq(req);
  const events = listActivity(Number(req.query.limit) || 100);
  const poller = storagePollerStatus();   // v2.600: poller(inFlight 이름)도 같은 기준으로
  res.json({ poller: admin ? poller : maskPollerStatus(poller, listDevices().map((d) => d.host)), events: admin ? events : maskActivityEvents(events), ...(admin ? {} : { addressHidden: true }) });
});

/**
 * 전체 새로고침(v2.315, 사용자 요구) — 중앙 직접(agent 빈) 장비를 즉시 재수집한다.
 * pollStorageOnce 를 재사용해 폴러의 재진입 가드·병렬 3개 제한을 그대로 탄다(부하 평탄화).
 * 엣지 위임 장비는 원격에서 강제할 수 없어 수를 세어 '다음 주기 반영'으로 안내만 한다(정직).
 */
api.post('/tools/storage/collect-all', adminOnly, async (req, res) => {
  try {
    const all = listDevices().filter((d) => d.enabled !== false);
    const edgeDevs = all.filter((d) => (d.agent || '').trim());
    const edge = edgeDevs.length;
    const central = all.length - edge;
    const result = await pollStorageOnce(); // { ok, fail } 또는 { skipped:true }(이미 진행 중)
    // v2.582 BUG-2: 엣지 위임 장비는 '다음 주기' 로 안내만 했다 — 형제 도구(SAN 스위치 v2.516)는 재수집 요청을
    // 등록해 엣지가 다음 설정 pull 때 즉시 수집·push 한다. 같은 큐(collectRequests)를 쓰고 연타는 hasPendingRequest 가 막는다.
    let requested = 0; let alreadyQueued = 0;
    for (const d of edgeDevs) {
      if (hasPendingRequest(d.id)) { alreadyQueued++; continue; }
      try { requestCollect(d.id, d.agent); requested++; } catch { /* 한 대 실패가 전체를 막지 않게 */ }
    }
    logAudit({ user: req.user?.username, action: '스토리지 전체 새로고침',
      detail: `중앙 ${central}대 재수집(${result.skipped ? '이미 진행중' : `성공 ${result.ok}·실패 ${result.fail}`}) · 엣지 ${edge}대 중 요청 ${requested}(대기중 ${alreadyQueued})` });
    res.json({ ok: true, central, edge, requested, alreadyQueued, result });
  } catch (e) { res.status(502).json({ ok: false, reason: e.message }); }
});

/**
 * 지금 수집(연결 테스트 겸) — 중앙 수집 장비는 즉시, 엣지 위임 장비는 **재수집 요청 등록**.
 * v2.316(사용자 버그 신고): 과거엔 엣지 장비에 안내 메시지만 반환하고 아무것도 하지 않았다 —
 * collectRequests 큐에 요청을 남기면 엣지가 다음 config pull(≤5분) 때 즉시 수집 + 즉시 push 한다.
 */
api.post('/tools/storage/devices/:id/collect', adminOnly, async (req, res) => {
  try {
    const dev = listDevices().find((d) => d.id === req.params.id);
    if (!dev) return res.status(404).json({ ok: false, reason: '장비를 찾을 수 없습니다.' });
    if ((dev.agent || '').trim()) {
      const dup = hasPendingRequest(dev.id);
      requestCollect(dev.id, dev.agent);
      logAudit({ user: req.user?.username, action: '스토리지 재수집 요청(엣지)', target: `${dev.name}(${dev.id})`, detail: `엣지 ${dev.agent}` });
      return res.status(202).json({ ok: true, requested: true,
        reason: dup
          ? `이미 재수집 요청이 대기 중입니다 — 엣지 '${dev.agent}' 의 다음 pull(≤5분) 시 즉시 수집·push 됩니다.`
          : `재수집 요청 등록 — 엣지 '${dev.agent}' 가 다음 pull(≤5분) 시 즉시 수집하고 바로 push 합니다.` });
    }
    // v2.591 L1: 이미 수집 중이면 새 세션을 열지 않는다 — '됐다' 고 말하지 않고 409 로 그 사실을 알린다.
    if (!(await collectDeviceNow(req.params.id))) return res.status(409).json({ ok: false, busy: true, reason: '이 장비는 지금 수집 중입니다 — 끝나면 결과가 표에 반영됩니다(같은 장비에 세션을 두 개 열지 않습니다).' });
    logAudit({ user: req.user?.username, action: '스토리지 즉시 수집', target: req.params.id });
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ ok: false, reason: e.message }); }
});


/* ── 수집 주기 설정(v2.409, 사용자 요구 '중앙에서 엣지의 스토리지 수집 주기를 설정') ─────────
 * 중앙은 엣지에 명령을 밀어넣을 수 없다(엣지는 NAT/폐쇄망 뒤 — 아웃바운드 pull 만). 그래서
 * 주기도 '설정 파일 → storage-config pull 응답 → 엣지 적용' 경로로 배포한다. 여기 저장은
 * 장비 구성 변경과 같은 무게라 adminOnly + 감사로그.
 */

/** 현재 설정 + 이 노드(중앙)의 실효 주기 + 항목 사양(하한/기본/설명 — UI 폼의 단일 소스). */
api.get('/tools/storage/intervals', adminOnly, (_req, res) => {
  res.json({
    ok: true,
    spec: INTERVAL_SPEC,
    config: loadIntervalConfig(),
    // 중앙 자신(직접 수집 장비 = agent '')이 지금 쓰는 값과 그 출처(central/env/default).
    central: { effective: runtimeIntervalSource(), env: envIntervals() },
    agents: knownAgentNames(),
    // 엣지별로 '지금 무엇이 배포될 예정인지'(전역+개별 병합 결과) — 저장 전에 결과를 볼 수 있게.
    effectiveByAgent: Object.fromEntries(['', ...knownAgentNames()].map((a) => [a, intervalsForAgent(a)])),
  });
});

/**
 * 전체 교체 저장. Body: { global:{...}, agents:{ '<엣지명>':{...}, '':{중앙} } }
 * 비어 있는 항목은 '미지정' 이고, 미지정 항목은 엣지가 자기 portal.env/기본값을 유지한다
 * (전 키를 채워 배포하면 현장 설정을 통째로 덮어쓰기 때문 — intervals.js 계약).
 */
api.put('/tools/storage/intervals', adminOnly, (req, res) => {
  try {
    const r = saveIntervalConfig({ global: req.body?.global || {}, agents: req.body?.agents || {} });
    // 중앙 자신은 pull 축이 없으므로 저장 즉시 반영(엣지는 다음 config pull 때 받는다).
    let own = null;
    try { own = applyOwnIntervals(); } catch (e) { own = { applied: false, reason: e.message }; }
    logAudit({ user: req.user?.username, action: '스토리지 수집 주기 변경',
      target: `전역 ${Object.keys(r.config.global).length}항목 · 엣지 ${Object.keys(r.config.agents).length}곳`,
      detail: JSON.stringify(r.config).slice(0, 500) });
    res.json({ ...r, own, central: { effective: runtimeIntervalSource(), env: envIntervals() },
      effectiveByAgent: Object.fromEntries(['', ...knownAgentNames()].map((a) => [a, intervalsForAgent(a)])),
      // 정직 표기: 엣지 반영은 즉시가 아니다 — 그 엣지의 '설정 pull 주기'만큼 걸릴 수 있다.
      note: '엣지에는 다음 설정 pull 때 적용됩니다(엣지별 pull 주기만큼 지연될 수 있음).' });
  } catch (e) { res.status(400).json({ ok: false, reason: e.message }); }
});

/* ── CSV 일괄 관리(v2.313, 사용자 요구) — 내보내기·샘플·가져오기. 전부 adminOnly(장비 구성). ── */

const dcNameMap = () => { try { const m = new Map(listDatacenters().map((x) => [x.id, x.name || x.id])); return (id) => m.get(id) || id || ''; } catch { return (id) => id || ''; } };


/**
 * 가져오기 본문 → 파싱 결과(v2.513). `text` 가 오면 자유텍스트, 아니면 기존 CSV.
 * 두 경로가 **같은 행 형태**를 만들어 뒤 파이프라인(analyzeImport → saveDevice)을 공유한다.
 */
function stParseBody(body = {}) {
  const raw = String(body.text ?? body.csv ?? '');
  const format = body.format === 'text' || (body.text != null && body.csv == null) ? 'text' : 'csv';
  if (format === 'text') {
    const r = parseDevicesText(raw, { defaults: body.defaults || {} });
    return { ...r, format, raw };
  }
  const r = parseDevicesCsv(raw);
  return { ...r, warnings: [], headerUsed: null, order: TEXT_FIELDS, format, raw };
}

/**
 * 현재 등록 장비를 CSV 로 내보내기. 기본은 비밀번호 제외(listDevices 계약).
 * ?passwords=1(v2.317, 사용자 요구 '포함 여부 선택'): 평문 비밀번호 포함 — 자격증명 일괄
 * 덤프이므로 **requireSettingsOwner**(백업 라우트와 동일 게이트 — server/CLAUDE.md 규칙)를
 * 추가로 통과해야 하고 감사로그를 남긴다. admin 이어도 소유자가 아니면 403.
 */
api.get('/tools/storage/devices/export.csv', adminOnly, (req, res) => {
  const withPw = String(req.query.passwords || '') === '1';
  const send = () => {
    const devices = withPw ? listDevicesWithSecrets() : listDevices();
    const csv = devicesToCsv(devices, dcNameMap(), { includePasswords: withPw });
    logAudit({ user: req.user?.username, action: withPw ? '스토리지 CSV 내보내기(비밀번호 포함)' : '스토리지 CSV 내보내기', detail: `${devices.length}대` });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="storage-devices${withPw ? '-with-passwords' : ''}.csv"`);
    res.send(csv);
  };
  if (withPw) return requireSettingsOwner(req, res, send);
  send();
});

/** 샘플 CSV 템플릿 다운로드 — 헤더 + 컬럼 설명 주석 + 예시 2행. */
api.get('/tools/storage/devices/sample.csv', adminOnly, (_req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="storage-devices-sample.csv"');
  res.send(sampleCsv());
});

/* ── 자유텍스트 내보내기·샘플(v2.513, 사용자 요청) ──
 * CSV 는 헤더·구분자를 맞춰야 하는데 현장 장비 목록은 위키 표·메일 본문·엑셀 한 컬럼으로 온다.
 * 붙여넣은 그대로 받는 경로를 같은 파이프라인에 붙였다. **비밀번호는 담지 않는다**(CSV 와 같은 계약). */
api.get('/tools/storage/devices/export.txt', adminOnly, (req, res) => {
  const devices = listDevices();
  logAudit({ user: req.user?.username, action: '스토리지 자유텍스트 내보내기', detail: `${devices.length}대` });
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="storage-devices.txt"');
  res.send(devicesToText(devices, dcNameMap()));
});

api.get('/tools/storage/devices/sample.txt', adminOnly, (_req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="storage-devices-sample.txt"');
  res.send(sampleText());
});

/**
 * CSV 일괄 가져오기 — body.csv 텍스트를 파싱해 행마다 saveDevice.
 * (host+type) 동일 장비는 수정(update), 없으면 추가. datacenter 는 이름/ID 모두 해석.
 * 행별 성공/실패를 정직하게 반환(부분 성공 허용 — 한 행 오류가 전체를 막지 않음).
 *
 * body.dryRun=true(v2.317, 사용자 요구 '무결성 검사'): **저장하지 않고** 행별 판정만 반환.
 * 검증 규칙은 실제 저장과 동일(registry.deviceInputIssue 단일 소스 — analyzeImport 주석) +
 * 파일 내 중복(host+type) 검출. UI 는 검증 통과 후에만 실행 버튼을 활성화한다.
 */
api.post('/tools/storage/devices/import', adminOnly, (req, res) => {
  const { rows, error, warnings, headerUsed, order, format, raw } = stParseBody(req.body || {});
  if (error) return res.status(400).json({ ok: false, reason: error });
  if (!rows.length) return res.status(400).json({ ok: false, reason: '가져올 데이터 행이 없습니다.' });

  // datacenter 이름/ID → ID 해석 준비(이름 매칭은 대소문자 무시).
  let dcs = [];
  try { dcs = listDatacenters(); } catch { /* 목록 실패 시 원문 그대로 저장 */ }
  const resolveDc = (v) => {
    const s = String(v || '').trim();
    if (!s) return '';
    if (dcs.some((d) => d.id === s)) return s;
    const byName = dcs.find((d) => String(d.name || '').toLowerCase() === s.toLowerCase());
    return byName ? byName.id : s; // 못 찾으면 원문 유지(유효 ID 일 수 있음)
  };
  // (host+type) → 기존 장비 id 맵(멱등 update). 구분자 '|' — host 정규식(RE_HOST)이 배제하는
  // 문자라 host/type 경계가 모호해지지 않는다(과거 NUL 구분자는 소스 NUL 금지 규칙 위반).
  const key = (h, t) => `${h}|${t}`;
  // v2.545: 값은 **장비 그대로** 둔다 — 아래 `methodChangeHints` 가 현재 수집 방식을 봐야 한다.
  const existing = new Map(listDevices().map((d) => [key(d.host, d.type), d]));

  // 무결성 분석(드라이런·실제 가져오기 공용) — 실제 저장과 같은 검증 규칙을 탄다.
  const { report, summary } = analyzeImport(rows, {
    existingKey: (h, t) => existing.get(key(h, t))?.id,
    resolveDc,
    validate: deviceInputIssue,
  });
  // v2.513: 오류 행에 '어디를 어떻게 고쳐라' 를 붙인다(사용자 요청). 판정은 다시 하지 않는다.
  const adv = enrichAdvice(report, rows, {
    text: raw, order, format, fields: TEXT_FIELDS,
    ctx: {
      types: STORAGE_TYPES.filter((t) => t.implemented).map((t) => t.type),
      agents: knownAgentNames(),
      datacenters: dcs.map((d) => d.name || d.id),
    },
  });

  if (req.body?.dryRun) {
    // v2.545: '수집 방식 칸이 비어 조용히 기본값으로 바뀌는 행' 을 같은 힌트 목록에 얹는다.
    const hints = [...adv.hints, ...methodChangeHints(rows, (h, t) => existing.get(key(h, t)))];
    return res.json({ ok: true, dryRun: true, report: adv.report, summary, hints,
      warnings: warnings || [], headerUsed: headerUsed || null, format, total: rows.length });
  }

  // v2.513: '검증을 통과한 일부만 등록'(사용자 요청).
  //  · selectLines — 화면에서 고른 줄 번호
  //  · testRunId   — 연결 테스트 통과 줄과의 **교집합**만 저장
  const tested = req.body?.testRunId ? passedLines(req.body.testRunId) : null;
  if (req.body?.testRunId && tested == null) {
    return res.status(400).json({ ok: false, reason: '연결 테스트 결과를 찾을 수 없습니다(15분 지나 폐기되었을 수 있습니다) — 다시 테스트하세요.' });
  }
  const sel = selectRows(rows, report, {
    lines: Array.isArray(req.body?.selectLines) ? req.body.selectLines : null,
    requireTested: tested,
  });

  let added = 0, updated = 0; const failed = [];

  for (const row of sel.picked) {
    const id = existing.get(key(row.host, row.type));
    const input = {
      id, type: row.type, name: row.name, host: row.host, username: row.username,
      collectMethod: row.collectMethod, sshPort: row.sshPort, datacenterId: resolveDc(row.datacenter),
      agent: row.agent, enabled: row.enabled, note: row.note,
    };
    if (row._hasPassword) input.password = row.password; // 비우면 기존 유지(saveDevice 규칙)
    try {
      saveDevice(input);
      if (id) updated++; else added++;
    } catch (e) { failed.push({ line: row._line, name: row.name || row.host, reason: e.message }); }
  }
  logAudit({ user: req.user?.username, action: `스토리지 장비 대량 가져오기(${format === 'text' ? '자유텍스트' : 'CSV'})`,
    detail: `추가 ${added}·수정 ${updated}·실패 ${failed.length}·제외 ${sel.skipped.length}${tested ? ' (연결 통과분만)' : ''}` });
  res.json({ ok: true, added, updated, failed, skipped: sel.skipped, total: rows.length, format });
});

/* ── 실제 연결 테스트(v2.513, 사용자 요청 "실제로 테스트해서 동작하는지 검증") ──
 * 저장 **전에** 행마다 로그인을 시도한다. 형식 검증만으로는 계정·비번·방화벽·SSH 알고리즘을 알 수 없다.
 *
 * ⚠ 엣지 위임 장비(`agent` 지정)는 중앙에서 직접 닿을 수 없어 '실패' 가 아니라 **'테스트 불가'** 다
 *   (닿지 못한 것을 실패라 하면 사용자가 멀쩡한 자격증명을 의심하며 고친다 — 정직 규약).
 * ⚠ 자동 재시도 없음 — 잘못된 비밀번호를 반복하면 어레이 계정이 잠긴다(bulkRun 이 강제).
 */
api.post('/tools/storage/devices/import/test', adminOnly, (req, res) => {
  const p = stParseBody(req.body || {});
  if (p.error) return res.status(400).json({ ok: false, reason: p.error });

  let dcs = [];
  try { dcs = listDatacenters(); } catch { /* 원문 유지 */ }
  const resolveDc = (v) => {
    const t = String(v || '').trim();
    if (!t) return '';
    if (dcs.some((d) => d.id === t)) return t;
    const byName = dcs.find((d) => String(d.name || '').toLowerCase() === t.toLowerCase());
    return byName ? byName.id : t;
  };
  const key = (h, t) => `${h}|${t}`;
  const existing = new Map(listDevices().map((d) => [key(d.host, d.type), d]));

  // 형식 오류 행은 테스트하지 않는다(로그인 시도가 무의미하고 장비에 부하만 준다).
  const { report } = analyzeImport(p.rows, {
    existingKey: (h, t) => existing.get(key(h, t))?.id,
    resolveDc, validate: deviceInputIssue,
  });
  const okLines = new Set(report.filter((r) => r.action !== 'error').map((r) => r.line));
  const targets = p.rows.filter((r) => okLines.has(r._line));
  if (!targets.length) return res.status(400).json({ ok: false, reason: '형식 검증을 통과한 행이 없습니다 — 먼저 오류를 고치세요.' });

  const started = startBulkTest({
    kind: 'storage', rows: targets, user: req.user?.username || '',
    skipReason: (row) => (String(row.agent || '').trim()
      ? `엣지 위임 장비(${row.agent}) — 중앙에서 직접 접속할 수 없어 테스트하지 않았습니다. 등록 후 엣지에서 수집됩니다.`
      : null),
    testOne: async (row) => {
      const input = {
        type: row.type, name: row.name, host: row.host, username: row.username,
        password: row.password, collectMethod: row.collectMethod, sshPort: row.sshPort,
        datacenterId: resolveDc(row.datacenter), agent: row.agent, enabled: row.enabled, note: row.note,
      };
      // 비밀번호가 비어 있으면(기존 유지) 저장된 값으로 테스트한다 — 그게 실제 수집이 쓸 값이다.
      if (!row._hasPassword) {
        const prev = existing.get(key(row.host, row.type));
        const full = prev ? getDeviceWithSecret(prev.id) : null;
        if (!full?.password) return { ok: false, reason: '비밀번호가 없습니다 — 신규 등록이면 password 열에 비밀번호를 적으세요.' };
        input.password = full.password;
      }
      try {
        const r = await testDeviceConnection(input, { timeoutMs: 60_000 });
        return r?.ok
          ? { ok: true, detail: { summary: r.summary || r.model || '로그인 성공' } }
          : { ok: false, reason: r?.error || r?.reason || '로그인 실패', detail: { phase: r?.phase, hint: r?.hint } };
      } catch (e) { return { ok: false, reason: e?.message || String(e) }; }
    },
  });
  if (!started.ok) return res.status(409).json(started);
  logAudit({ user: req.user?.username, action: '스토리지 대량 연결 테스트', detail: `${targets.length}대 시도(형식 오류 ${p.rows.length - targets.length}건 제외)` });
  res.json({ ok: true, id: started.id, total: targets.length });
});

/** 연결 테스트 진행률·결과(폴링). 자격증명은 응답에 없다(bulkRun publicRun). */
api.get('/tools/storage/devices/import/test/:id', adminOnly, (req, res) => {
  const run = publicRun(req.params.id);
  if (!run || run.kind !== 'storage') return res.status(404).json({ ok: false, reason: '실행을 찾을 수 없습니다(15분 지나 폐기되었을 수 있습니다).' });
  res.json({ ok: true, ...run });
});

/** 영역별 수집 현황 + 원문(이 노드 DB — 중앙 수집 장비 전용. 엣지 장비 원문은 엣지 DB 에 있음). */
api.get('/tools/storage/devices/:id/areas', adminOnly, async (req, res) => {
  res.json({ db: await dbAvailable(), labels: AREA_LABEL, rows: await areaSummary(req.params.id) });
});

/** 영역 원문 JSON 1건 — ?endpoint= (DB api_latest 최신본, 512KB 절단 표기). */
api.get('/tools/storage/devices/:id/areas/json', adminOnly, async (req, res) => {
  const row = await areaJson(req.params.id, String(req.query.endpoint || ''));
  if (!row) return res.status(404).json({ ok: false, reason: '해당 엔드포인트의 저장된 원문이 없습니다(엣지 수집 장비면 원문은 엣지 DB 에 있습니다).' });
  res.json({ ok: true, ...row });
});

/**
 * 용량 시계열(추이) — ?days=N (기본 30, 1~400).
 * v2.318(추이 그래프): 7일 초과 구간은 ~800점 목표로 시간 버킷 평균 다운샘플 — raw 는
 * LIMIT 5000 에 앞부분만 잘려 장기 구간에서 최근 데이터가 안 보였다(db.js selCapBucket 주석).
 */

/**
 * 추이 기간 프리셋(v2.380) — 12시간·24시간·1주를 사용자 요구로 추가.
 * 기존 days 파라미터도 계속 받는다(하위호환: 링크·북마크가 깨지지 않게).
 *  - 24시간 이하: 원본(raw) 조회 — 10분 수집 주기라 12h=72점·24h=144점으로 충분히 가볍다.
 *  - 1주 이상: 버킷 평균으로 ~800점 목표 다운샘플(raw 는 LIMIT 5000 에 앞부분만 남아
 *    장기 구간에서 최근이 잘려 나갔다 — db.js selCapBucket 주석 참조).
 */
const USAGE_RANGES = {
  '12h': { spanMs: 12 * 3_600_000, bucketMs: 0 },
  '24h': { spanMs: 24 * 3_600_000, bucketMs: 0 },
  '7d': { spanMs: 7 * 86_400_000, bucketMs: 3_600_000 },
  '30d': { spanMs: 30 * 86_400_000, bucketMs: 6 * 3_600_000 },
  '90d': { spanMs: 90 * 86_400_000, bucketMs: 12 * 3_600_000 },
  '400d': { spanMs: 400 * 86_400_000, bucketMs: 86_400_000 },
};
function usageRange(query = {}) {
  const key = String(query.range || '');
  if (USAGE_RANGES[key]) return { range: key, ...USAGE_RANGES[key] };
  // 하위호환: ?days=N (1~400). 기존 규칙(7일 초과면 ~800점 버킷)을 유지한다.
  const days = Math.max(1, Math.min(400, Number(query.days) || 30));
  return { range: `${days}d`, spanMs: days * 86400e3, bucketMs: days <= 7 ? 0 : Math.ceil((days * 86400e3) / 800) };
}

api.get('/tools/storage/devices/:id/history', toolsPerm, fullScopeOnly, async (req, res) => {
  const { spanMs, bucketMs, range } = usageRange(req.query);
  res.json({ db: await dbAvailable(), range, spanMs, bucketMs, points: await capacityHistory(req.params.id, Date.now() - spanMs, bucketMs) });
});

/**
 * 전체 장비 합산 용량 추이(v2.380) — 목록 화면의 통합 추이 탭.
 * 장비별 수집 시각이 달라 항상 버킷 평균 후 장비 합산으로 계산한다(db.capacityHistoryAll).
 * 각 점의 devices(그 버킷에 데이터가 있던 장비 수)를 함께 반환해, 일부 장비만 수집된 구간을
 * '전체 용량 급감' 으로 오독하지 않게 화면이 표시한다.
 */
/**
 * 스토리지 증가량(v2.531) — 특수기능 '스토리지 증가량' 화면(임원 보고 형태).
 *
 * 사용자 요청: "전체 스토리지를 보여주고 기간별로 용량이 얼마나 증가하고 있는지 매트릭스 형태로" ·
 * "장비별로 1일/1주/1달/3개월 등 지정한 기간으로 증가량".
 *
 * ⚠ **폴링 금지 대상은 아니지만 자주 부를 이유도 없다** — 일 단위 롤업을 읽을 뿐이라 vCenter/장비
 *   왕복은 0 이지만, 5년 × 장비수 행을 매번 읽는다. 화면은 마운트 시 1회 + 수동 새로고침만 한다
 *   (`v4Portal2508.test.js` 규약과 같은 판단).
 * ⚠ 판정·계산은 전부 `storage/growth.js`(순수)가 한다 — 라우트는 조회와 메타 결합만 한다.
 */
api.get('/tools/storage-growth', toolsPerm, fullScopeOnly, async (req, res) => {
  const { periods, dropped } = normalizePeriods(req.query.periods);
  const asOfDay = dayIndex(Date.now());
  // 필요한 만큼만 읽는다 — 가장 긴 기간 + 여유 1일(기준선이 그 날 없을 수 있다).
  const sinceDay = asOfDay - (Math.max(...periods.map((p) => p.days)) + 1);

  // v2.600 AUTHZ-2600-02: 형제 목록(/tools/storage)과 같은 기준으로 비-admin 에게 관리 주소를 가린다
  // (이름이 주소와 같으면 이름도 — 목록이 쓰는 maskDeviceAddress 하나로). 가린 사실은 addressHidden.
  const admin = isAdminReq(req);
  const rawDevices = listDevices();
  const hostById = new Map(rawDevices.map((d) => [d.id, d.host || '']));
  const regDevices = admin ? rawDevices : rawDevices.map(maskDeviceAddress);
  const meta = new Map();
  for (const d of regDevices) meta.set(d.id, { name: d.name, type: d.type, host: d.host, datacenterId: d.datacenterId });
  // 장비가 보고한 이름이 있으면 그것을 쓴다(v2.530 '장비' 열 규약과 같은 순서).
  for (const snap of [...localSnapshots(), ...edgeStorageSnapshots()]) {
    const id = snap.deviceId || snap.id;
    if (!id || !meta.has(id)) continue;
    // 장비 보고 이름도 주소와 같으면 가린다(스냅샷 host 가 없는 수집기라 등록부 주소를 넘긴다).
    const nm = admin ? snap.name : maskSnapAddress({ deviceId: id, type: snap.type, name: snap.name }, hostById.get(id)).name;
    if (nm) meta.set(id, { ...meta.get(id), name: nm });
  }

  const rows = await dailySeries(null, sinceDay);
  // 조회 구간은 '가장 긴 기간 + 1일' 로 좁히지만, 화면의 '관측 N일' 은 **전체 이력**이어야 한다 —
  // 구간으로 대신하면 700일치를 가진 장비가 '92일' 로 보인다(v2.531 스크린샷 판독에서 발견).
  const spans = await dailySpans();
  // 측정 기준이 바뀌어 이력을 재시작한 장비(v2.534) — '관측 N일' 이 왜 짧은지 화면이 말해야 한다.
  // 이것이 없으면 사용자는 수집 장애로 오해한다(조용한 삭제 금지).
  const resets = await capacityResets();
  const m = growthMatrix(rows, { periods, asOfDay, meta });
  const keep = effectiveKeepDays();
  res.json({
    db: await dbAvailable(),
    // 화면은 여기 숫자만 쓴다 — 주기·보존을 문구에 박지 않는다(CLAUDE.md 규약).
    asOfDay, asOfLabel: dayLabel(asOfDay), dayOffsetMin: DAY_OFFSET_MIN,
    periods: m.periods, periodsDropped: dropped,
    // 기준선은 **날짜로** 내려준다 — 화면이 일 인덱스(숫자)를 사람에게 보여주면 안 된다.
    devices: m.devices.map((d) => {
      const sp = spans[d.deviceId] || {};
      const firstDay = sp.firstDay ?? d.firstDay;
      const observedDays = sp.observed ?? d.observedDays;
      const totalSpan = firstDay == null ? 0 : d.latestDay - firstDay + 1;
      return {
      ...d,
      firstDay,
      observedDays,
      // 첫 관측부터 지금까지 중 **수집 기록이 없는 날 수**. 0 이 아니면 화면이 밝힌다
      // ('매일 관측이 있었다' 고 가정하지 않는다).
      gapDays: Math.max(0, totalSpan - observedDays),
      latestLabel: dayLabel(d.latestDay),
      firstLabel: firstDay == null ? null : dayLabel(firstDay),
      // {at, reason, rows} — 있으면 화면이 '그 날 기준이 바뀌어 다시 쌓기 시작했다' 고 밝힌다.
      historyReset: resets[d.deviceId] || null,
      growth: Object.fromEntries(Object.entries(d.growth).map(([k, g]) => [k,
        { ...g, baselineLabel: g.baselineDay == null ? null : dayLabel(g.baselineDay) }])),
      }; }),
    totals: m.totals,
    retention: { ...loadGrowthSettings(), effective: keep },
    // 법인·장비 종류 필터용 라벨 원천(v2.532) — 스토리지 모니터링 화면과 **같은 출처**를 쓴다.
    // 화면이 id 를 그대로 보여주면 'dc-wa' 같은 원시 값이 칩에 뜬다.
    types: STORAGE_TYPES.map((t) => ({ type: t.type, label: t.label })),
    datacenters: (() => { try { return listDatacenters(); } catch { return []; } })(),
    // 등록돼 있는데 이력이 한 줄도 없는 장비 — 화면이 '빠진 장비' 로 밝힌다(조용히 빼지 않는다).
    noHistory: regDevices.filter((d) => !m.devices.some((x) => x.deviceId === d.id)).map((d) => ({ id: d.id, name: d.name, host: d.host, type: d.type, enabled: d.enabled !== false })),
    ...(admin ? {} : { addressHidden: true }),
  });
});

/** 한 장비의 일 단위 추이(증가량 화면의 상세 차트용). */
api.get('/tools/storage-growth/:id/daily', toolsPerm, fullScopeOnly, async (req, res) => {
  const days = Math.max(2, Math.min(3650, Number(req.query.days) || 365));
  const asOfDay = dayIndex(Date.now());
  const rows = await dailySeries(req.params.id, asOfDay - days);
  res.json({
    db: await dbAvailable(), days, asOfDay,
    points: rows.map((r) => ({ day: r.day, label: dayLabel(r.day), ts: dayStartMs(r.day),
      totalBytes: r.total_bytes, usedBytes: r.used_bytes, maxUsed: r.max_used, samples: r.samples })),
  });
});

/** 보존 설정 조회 — 폼은 이 SPEC 으로 그린다(숫자 하드코딩 금지). */
api.get('/tools/storage-growth/settings', toolsPerm, fullScopeOnly, (req, res) => {
  res.json({ spec: GROWTH_SPEC, values: loadGrowthSettings(), defaultPeriods: DEFAULT_PERIODS });
});

/**
 * 보존 설정 저장(관리자) — **되돌릴 수 없는 삭제**가 따라올 수 있으므로 감사로그를 남긴다.
 * `prune:true` 일 때만 즉시 정리한다(화면이 '지금 정리' 를 눌렀을 때).
 */
api.post('/tools/storage-growth/settings', adminOnly, requireSettingsOwner, async (req, res) => {
  const { values, issues } = saveGrowthSettings(req.body || {});
  let pruned = false;
  if (req.body?.prune === true) pruned = await pruneNow();
  logAudit({
    user: req.user?.username, action: 'storage.growth.settings', ip: req.ip || '',
    detail: JSON.stringify({ values, pruned }).slice(0, 300),
  });
  res.json({ ok: true, values, issues, pruned });
});

api.get('/tools/storage/history', toolsPerm, fullScopeOnly, async (req, res) => {
  const { spanMs, bucketMs, range } = usageRange(req.query);
  // 전체 합산은 버킷이 필수 — 12시간 구간이라도 10분 버킷으로 시각을 정렬한다.
  const b = bucketMs || 600_000;
  // v2.600 DB2600-01: 수집 주기(기본 1시간)가 버킷(10분)보다 길어, 버킷마다 관측된 장비만 더하면
  // 점마다 일부 엣지만 합산된다. 장비마다 **담당 노드의 수집 주기 × 2** 까지 마지막 값을 이어 쓴다
  // (주기는 중앙 배포값 — 숫자를 박지 않는다). 그보다 오래된 장비는 빠지고 점의 missing 이 밝힌다.
  const envPoll = Number(envIntervals()?.pollMs) || 3_600_000;
  const pollOf = new Map();
  const staleByDevice = new Map();
  for (const d of listDevices()) {
    const agent = d.agent || '';
    if (!pollOf.has(agent)) {
      let v = null;
      try { v = Number(intervalsForAgent(agent)?.pollMs); } catch { v = null; }
      pollOf.set(agent, Number.isFinite(v) && v > 0 ? v : envPoll);
    }
    staleByDevice.set(d.id, 2 * pollOf.get(agent));
  }
  const now = Date.now();
  const points = await capacityHistoryAll(now - spanMs, b, { nowMs: now, staleMs: 2 * envPoll, staleByDevice });
  res.json({
    db: await dbAvailable(), range, spanMs, bucketMs: b, points,
    // 이 조회 구간에서 한 번이라도 관측된 장비 수 — 점의 devices 가 이보다 작으면 부분 합이다.
    expectedDevices: points.expectedDevices ?? null,
    carryMaxMs: Math.max(2 * envPoll, ...staleByDevice.values()),
    truncated: points.truncated === true,
  });
});
}
