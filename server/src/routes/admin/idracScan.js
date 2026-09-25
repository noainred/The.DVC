// iDRAC 상세(:id)·가져오기·스캔/대역/잡·삭제/할당 — admin.js(구 2,410줄) 분할(v2.285.0). 본문은 원본 그대로, 등록 순서는 admin.js 호출 순서가 보존한다.
import { config } from '../../config.js';
import { store } from '../../store.js';
import { logAudit } from '../../audit.js';
import { getAllGpuGuestDiag } from '../../central/gpuGuestDiag.js';
import { listInventory } from '../../central/inventory.js';
import { getAllAgentConfigs } from '../../central/agentConfig.js';
import { updateServer, removeServer, importServers, parseCsv, bulkAddByIps, registerScanned, assignVcenter, deleteServers, loadRegistry as loadIdracRegistry } from '../../idrac/registry.js';
import { expandIpList } from '../../idrac/iprange.js';
import { scanForIdracs } from '../../idrac/scan.js';
import { listTargets } from '../../agent/deployRegistry.js';
import { enqueueIdracScan, enqueueIdracRegister, getIdracScanResult, listIdracScanJobs, getIdracScanJobLog, cancelIdracScanJob, recentPollingAgents, agentOfReq } from '../../central/idracScanJobs.js';
import { pushIdracScan } from '../../central/idracScanPush.js';
import { getPollerStatus, pollNow } from '../../idrac/poller.js';
import { listScanRanges, saveScanRanges, removeScanRanges, getScanRangeRaw } from '../../idrac/scanRanges.js';
import { scanRangesToCsv, sampleCsv as scanRangesSampleCsv, parseScanRangesCsv, analyzeScanRangesImport } from '../../idrac/scanRangesCsv.js';
import { listDatacenters } from '../../datacenter/store.js';
import { startIdracScanNow, idracScanStatus, stopIdracScanNow, setIdracScanIntervalMs, tryAcquireScan, releaseScan } from '../../idrac/scanPoller.js';
import { makeScanAuthPolicy } from '../../idrac/scanAuth.js';
import { listIdracScanLog, idracScanLogDatacenters } from '../../idrac/scanLog.js';
import { getInventory as getIdracInventory } from '../../idrac/invCache.js';
import { getSensorSeries, remoteSensorView } from '../../idrac/sensorStore.js';
import { idracTempMetric, TEMP_SERIES_ENABLED, TEMP_SERIES_DETAIL } from '../../idrac/serverTempSeries.js'; // v2.504: 서버별 온도 장기 추이
import { getMetricsDb } from '../../metrics/db.js';
import { fetchInventory as fetchIdracInventory, fetchSensors as fetchIdracSensors, probeGpuTelemetry } from '../../idrac/redfish.js';
import { listCollectors } from '../../collector/registry.js';
import { findRemoteServer } from '../../collector/remoteInventory.js';
import { findHostByServiceTag } from '../../idrac/hostMatch.js';
import { getDatacenterAssign } from '../../datacenter/store.js';
import { allCollectorStatus } from '../../collector/state.js';
import { listAssignments, getResults } from '../../central/assignments.js';
import { adminOnly, requireSettingsOwner, fullScopeOnlyWith } from './shared.js';
import { numOrNull } from '../../util/numOrNull.js';
// v2.611 AUTHZ2611: 전 법인 등록부·동작은 전체 범위 계정만(v2.607 fleetWideOnly 의 형제 등록부).
const fleetOnly = fullScopeOnlyWith('iDRAC 등록부·스캔 대역·스캔 실행은 전 법인 공용이라 전체 범위(vCenter 제한 없는) 계정만 바꾸거나 실행할 수 있습니다(재귀속·삭제로 다른 법인 서버를 옮길 수 있었다).');


// Register iDRACs found by a scan, applying the shared credentials, then poll.
// Body: { found:[...], username, password, mode?, vcenterId?, agent? }
// mode: 'merge'(기본) | 'replace'(전체 교체) | 'replace-vcenter'(소속 vCenter만 교체).
// agent 지정(위임): 에이전트가 현지에 등록(중앙 못 닿는 대역) → reqId 반환, UI가 폴링.
const normIdracMode = (m) => (['replace', 'replace-vcenter', 'merge'].includes(m) ? m : 'merge');

export function registerIdracScan(adminRouter) {

// 서버 상세 인벤토리(iDRAC/BIOS/드라이버 버전 등). 캐시 우선, ?refresh=1이면 즉시 재수집.
adminRouter.get('/idrac/:id/inventory', adminOnly, async (req, res) => {
  const s = loadIdracRegistry().find((x) => x.id === req.params.id);
  if (!s) {
    // 위임 법인의 원격 서버 — 중앙이 직접 못 닿으므로 엣지가 실어보낸 인벤토리를 그대로 반환(재수집 불가).
    const rs = findRemoteServer(req.params.id);
    if (rs) return res.json({ ok: true, fresh: false, remote: true, collectorId: rs.collectorId, inventory: rs.inv || null });
    return res.status(404).json({ ok: false, reason: '서버를 찾을 수 없습니다.' });
  }
  if (s.type === 'ome') return res.status(400).json({ ok: false, reason: 'OME 소스는 상세 인벤토리를 지원하지 않습니다(iDRAC 직접만).' });
  if (req.query.refresh === '1') {
    try { return res.json({ ok: true, fresh: true, inventory: await fetchIdracInventory(s) }); }
    catch (e) { return res.status(502).json({ ok: false, reason: e.message }); }
  }
  const inv = getIdracInventory(s.id);
  res.json({ ok: true, fresh: false, inventory: inv?.data || inv || null });
});

// 서비스태그(= ESXi 하드웨어 일련번호)로 이 iDRAC 물리 서버에 대응하는 vCenter 가상화 호스트 조회.
// 물리(iDRAC/베어메탈) ↔ 가상화(vCenter ESXi) 브릿지: Dell 서비스태그 == 호스트 일련번호.
adminRouter.get('/idrac/:id/vcenter-host', adminOnly, (req, res) => {
  const id = req.params.id;
  const s = loadIdracRegistry().find((x) => x.id === id) || findRemoteServer(id);
  if (!s) return res.status(404).json({ ok: false, reason: '서버를 찾을 수 없습니다.' });
  const norm = (t) => String(t || '').trim().toLowerCase();
  // iDRAC 접속 IP/호스트(v2.301) — 상세 모달이 'iDRAC 바로가기' 링크로 표시(사용자 요구).
  // 등록 레코드의 host 그대로(간혹 프로토콜이 붙은 레거시 값은 표시부에서 정리).
  const idracHost = String(s.host || '').trim();
  const tag = norm(s.serviceTag || getIdracInventory(id)?.system?.serviceTag || s.inv?.system?.serviceTag || '');
  if (!tag) return res.json({ ok: true, matched: false, serviceTag: '', reason: '서비스태그 없음', idracHost });
  const snap = store.get();
  const assign = getDatacenterAssign();
  const host = findHostByServiceTag(tag, snap.hosts || []);
  if (!host) return res.json({ ok: true, matched: false, serviceTag: s.serviceTag || tag, idracHost });
  res.json({
    ok: true, matched: true, serviceTag: host.serviceTag || tag, idracHost,
    host: {
      name: host.name,
      vcenterId: host.vcenterId || '',
      datacenterId: assign[String(host.vcenterId || '')] || '',
      cluster: host.cluster || '',
      connectionState: host.connectionState || '',
      cpuUsagePct: host.cpuUsagePct ?? null,
      memUsagePct: host.memUsagePct ?? null,
      vmCount: host.vmCount ?? null,
      model: host.model || '',
      powerState: host.powerState || '',
    },
  });
});

// 온도센서 + CPU 사용량 시계열(차트용). ?minutes=N 으로 최근 구간만. ?live=1 즉시 1샘플 수집.
adminRouter.get('/idrac/:id/sensors', adminOnly, async (req, res) => {
  const s = loadIdracRegistry().find((x) => x.id === req.params.id);
  if (!s) {
    // 위임 법인 원격 서버(v2.493): 중앙에 **시계열은 없지만 최신 센서 스냅샷은 있다**(엣지 export
    // 의 s.sensors — '법인별 온도' 화면이 이미 그 값을 쓴다). 예전에는 여기서 latest:null 을
    // 돌려줘 같은 서버가 법인별 온도에서는 52℃ 로 보이는데 상세 모달에서는 '센서 0개 · 0샘플 ·
    // 텔레메트리 미지원' 으로 보였다 → 수집 중단으로 오해. 최신값을 그대로 실어 보내고
    // seriesAvailable:false 로 '이력은 엣지에만 있음' 을 밝힌다.
    const rs = findRemoteServer(req.params.id);
    if (rs) return res.json({ ok: true, ...remoteSensorView(rs), live: null, intervalMs: getPollerStatus().intervalMs });
    return res.status(404).json({ ok: false, reason: '서버를 찾을 수 없습니다.' });
  }
  if (s.type === 'ome') return res.status(400).json({ ok: false, reason: 'OME 소스는 센서 시계열을 지원하지 않습니다.' });
  let live = null;
  if (req.query.live === '1') {
    try { live = await fetchIdracSensors(s); } catch (e) { live = { error: e.message }; }
  }
  const minutes = Math.max(0, Math.min(1440, Number(req.query.minutes) || 0));
  // seriesAvailable: 중앙이 이 서버의 시계열을 갖는지(로컬 등록 = 가짐). 화면이 '샘플 없음'과
  // '이력 미동기화(위임)'를 구분해 안내하는 근거.
  res.json({ ok: true, remote: false, seriesAvailable: true, cpuSynced: true, ...getSensorSeries(s.id, { minutes }), live, intervalMs: getPollerStatus().intervalMs });
});

/**
 * 서버별 온도 **장기 추이**(v2.504) — GET /admin/idrac/:id/temp-history?days=&bucket=
 *
 * 사용자 요청: "idrac 에서 조사하는 온도를 차트로 보이게 해줘"(참고로 '특수 기능 › ESXi 온도' 의
 * `5년 추이` 차트를 첨부). 기간·집계 단위 규약을 그 라우트(`/tools/esxi-temp/history`)와 **일부러
 * 똑같이** 맞춘다 — 같은 조작을 두 화면에서 다르게 만들지 않기 위해서다.
 *
 * `/idrac/:id/sensors` 와의 차이:
 *  · sensors  = `sensorStore` 인메모리 **24시간** · 센서 이름별 상세 · 중앙 직접 수집 서버만.
 *  · 이 라우트 = metrics DB 의 `idractemp_*` 계열 · 최대 5년 · **위임(엣지) 서버도 포함**.
 *    (엣지는 최신 스냅샷만 export 하므로 중앙에 이력이 0 이었다 — v2.504 계열이 그 공백을 채운다.)
 *
 * 정직성: 첫 관측 시각(`firstTs`)을 함께 준다. 화면이 '수집 시작 이전' 을 빈 구간으로 두어
 * 없는 이력을 지어내지 않게 하기 위함이다. 상세(흡기·배기·CPU) 계열은 `IDRAC_TEMP_SERIES_DETAIL`
 * 로만 적재되므로, 켜져 있지 않으면 `max` 한 줄만 온다 — 그 사실을 `detail` 로 밝힌다.
 *
 * 권한: 다른 iDRAC 상세 라우트와 같은 `adminOnly`(서버 분석 계열은 vCenter scope 를 걸지 않는다 —
 * 이 파일 위쪽 `/idrac/temps` 주석의 기존 규약을 따른다).
 */
adminRouter.get('/idrac/:id/temp-history', adminOnly, async (req, res) => {
  const id = String(req.params.id || '');
  const known = loadIdracRegistry().some((x) => x.id === id) || !!findRemoteServer(id);
  if (!known) return res.status(404).json({ ok: false, reason: '서버를 찾을 수 없습니다.' });

  const days = Math.max(1, Math.min(1830, Number(req.query.days) || 7));
  const since = Date.now() - days * 86_400_000;
  // 집계 단위(기준) — /tools/esxi-temp/history 와 동일한 표와 자동 규칙.
  const BUCKET = { minute: 60_000, hour: 3_600_000, day: 86_400_000 };
  const bucket = BUCKET[req.query.bucket] ? req.query.bucket : 'auto';
  const bucketMs = BUCKET[req.query.bucket]
    || (days <= 2 ? 3_600_000 : days <= 14 ? 6 * 3_600_000 : days <= 120 ? 86_400_000 : days <= 800 ? 7 * 86_400_000 : 30 * 86_400_000);
  const limit = bucketMs <= 60_000 ? 5000 : bucketMs <= 3_600_000 ? 3000 : 1500;

  const series = {};
  let firstTs = null;
  let dbError = '';
  try {
    const db = await getMetricsDb();
    const kinds = TEMP_SERIES_DETAIL ? ['max', 'inlet', 'exhaust', 'cpu'] : ['max'];
    for (const kind of kinds) {
      const metric = idracTempMetric(kind);
      series[kind] = db.history(metric, id, since, bucketMs, limit);
      // 첫 관측 시각 — 화면이 '수집 시작 이전' 을 소급 표시하지 않게 한다(v2.351 '+2만 TB' 교훈).
      try {
        const m = db.metaKey ? db.metaKey(metric, id) : null;
        if (m?.firstTs && (firstTs == null || m.firstTs < firstTs)) firstTs = m.firstTs;
      } catch { /* metaKey 미지원 버전 — firstTs 없이 응답(화면이 null 을 다룬다) */ }
    }
  } catch (e) {
    // 오류를 삼키지 않는다(v2.493 규칙) — '수집 0' 과 '조회 실패' 는 다르다.
    dbError = e?.message || String(e);
    console.warn('[idrac] 온도 추이 조회 실패:', dbError);
  }
  res.json({
    ok: true, id, days, bucket, bucketMs, firstTs,
    enabled: TEMP_SERIES_ENABLED, detail: TEMP_SERIES_DETAIL,
    series, error: dbError || undefined,
  });
});

// iDRAC에서 GPU 사용률 수집 가능 여부 실측 확인(GPU 목록 + 텔레메트리 리포트).
adminRouter.get('/idrac/:id/gpu-probe', adminOnly, async (req, res) => {
  const s = loadIdracRegistry().find((x) => x.id === req.params.id);
  if (!s) {
    // 위임 법인 원격 서버: 중앙이 iDRAC에 직접 못 닿아 실시간 프로브 불가(현장 에이전트에서 수행).
    if (findRemoteServer(req.params.id)) return res.status(400).json({ ok: false, reason: '위임 법인의 원격 서버는 중앙에서 실시간 GPU 프로브를 할 수 없습니다(현장 에이전트가 수집). 인벤토리의 GPU 목록을 참고하세요.' });
    return res.status(404).json({ ok: false, reason: '서버를 찾을 수 없습니다.' });
  }
  if (s.type === 'ome') return res.status(400).json({ ok: false, reason: 'OME 소스는 GPU 프로브를 지원하지 않습니다(iDRAC 직접만).' });
  try { res.json({ ok: true, ...(await probeGpuTelemetry(s)) }); }
  catch (e) { res.status(502).json({ ok: false, reason: e.message }); }
});

// Import servers (JSON array / { servers:[...] } / CSV text). Body:
//   { servers:[...], mode? } | { csv:"...", mode? } | bare array
adminRouter.post('/idrac/import', adminOnly, fleetOnly, (req, res) => {
  const body = req.body || {};
  let list;
  if (typeof body.csv === 'string') list = parseCsv(body.csv);
  else list = Array.isArray(body) ? body : body.servers;
  const result = importServers(list, body.mode === 'replace' ? 'replace' : 'merge');
  if (result.ok) pollNow().catch(() => {});
  res.status(result.ok ? 200 : 400).json(result);
});

// Preview how an IP list expands (count + sample + parse errors) — no writes.
adminRouter.post('/idrac/expand-ips', adminOnly, (req, res) => {
  const { ips, errors, truncated } = expandIpList((req.body || {}).ips || '');
  res.json({ ok: true, count: ips.length, truncated, sample: ips.slice(0, 12), errors });
});

// Bulk-register servers from an IP list with shared credentials, then poll.
// Body: { ips, username, password, namePrefix?, mode? }
adminRouter.post('/idrac/bulk-add', adminOnly, fleetOnly, (req, res) => {
  const result = bulkAddByIps(req.body || {});
  if (result.ok) pollNow().catch(() => {});
  res.status(result.ok ? 200 : 400).json(result);
});

// Scan an IP range and return only the IPs that are real Dell iDRACs (with
// identity). No writes. Body: { ips, username, password, agent? }
// agent 미지정/'__local__' = 이 포탈에서 직접 스캔(동기). 그 외 = 해당 에이전트에 위임.
adminRouter.post('/idrac/scan', adminOnly, fleetOnly, async (req, res) => {
  const { ips, username, password } = req.body || {};
  const agent = String(req.body?.agent || '').trim();
  if (!ips) return res.status(400).json({ ok: false, reason: 'IP 대역을 입력하세요.' });
  if (!username || !password) return res.status(400).json({ ok: false, reason: 'iDRAC 계정/비밀번호가 필요합니다.' });

  // 에이전트 위임 스캔(원격 사이트 iDRAC에 중앙이 직접 못 닿는 경우).
  if (agent && agent !== '__local__') {
    const dispatch = String(req.body?.dispatch || 'poll') === 'push' ? 'push' : 'poll';
    // dispatch=push: 중앙이 수집 서버 URL로 엣지에 직접 스캔 전송(엣지 폴링/중앙 토큰 불필요).
    if (dispatch === 'push') {
      const pr = pushIdracScan(agent, { ips, username, password, vcenterId: String(req.body?.vcenterId || '').trim(), datacenterId: String(req.body?.datacenterId || '').trim(), noRegister: true });
      if (!pr.ok) return res.status(400).json({ ok: false, reason: pr.reason });
      return res.json({ ok: true, delegated: true, dispatch: 'push', agent, reqId: pr.reqId });
    }
    if (!config.central.token) return res.status(400).json({ ok: false, reason: '중앙(CENTRAL_TOKEN) 미설정 — 에이전트 폴링 위임 스캔을 사용할 수 없습니다(중앙→엣지 직접 PUSH 방식은 토큰 없이도 가능).' });
    // noRegister: 스캔만 하고 등록은 UI 확인 후 별도 '등록' 잡으로(자동등록 안 함).
    const reqId = enqueueIdracScan(agent, { ips, username, password, vcenterId: String(req.body?.vcenterId || '').trim(), datacenterId: String(req.body?.datacenterId || '').trim(), noRegister: true });
    if (!reqId) return res.status(429).json({ ok: false, reason: '대기 중인 스캔 잡이 너무 많습니다. 잠시 후 다시 시도하세요.' });
    return res.json({ ok: true, delegated: true, dispatch: 'poll', agent, reqId });
  }

  // v2.611(감사 TIM2611-04): 재진입 가드 — 주기·'지금 스캔'·다른 임시 스캔과 같은 잠금(idrac/scanPoller.js running)을 쓴다.
  //   예전에는 가드가 없어 연타·주기 스캔과 겹치면 같은 대역(최대 2,048 IP · 동시 32)에 같은 계정 로그인이 곱해졌다.
  //   v2.612 RECENT2612-03: 임시 스캔은 인증 실패를 **기록하지 않는다**(record:false). 예전 주석은 '실패를 기록해 주기 스캔이
  //   본다' 였지만 정지 id 가 scan|adhoc|<ip> 라 어느 주기 스캔도 그 id 를 읽지 않았다(주기 스캔은 자기 대역 id 를 본다) —
  //   읽는 사람 없이 idrac-scan-auth-stops.json 에 실행마다 최대 2,048건씩 쌓이기만 했다. 옛 기록은 scanAuth.js 가 1회 지운다.
  const lock = tryAcquireScan('adhoc');
  if (!lock.ok) return res.status(409).json({ ok: false, busy: true, by: lock.by, reason: lock.reason });
  try {
    const authPolicy = makeScanAuthPolicy({ rangeId: 'adhoc', username, password, periodic: false, record: false });
    const result = await scanForIdracs({ ips, username, password, authPolicy });
    res.json({ ok: true, delegated: false, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, reason: err.message });
  } finally { releaseScan(); }
});

// 위임 스캔 결과 폴링. Query: reqId
adminRouter.get('/idrac/scan-result', adminOnly, (req, res) => {
  res.json(getIdracScanResult(String(req.query.reqId || '')));
});

// 위임 스캔에 사용할 수 있는 에이전트 이름 목록 — 중앙에 보고/등록된 에이전트 + 등록된
// '수집 서버(원격)'(id·이름) + 지금 실제로 잡을 인출 폴링 중인 에이전트를 병합한다. 폴링 중인
// 이름은 반드시 목록에 넣는다 — 잡을 실제로 인출하는 건 '폴링 중인 이름'이므로, 등록만 되고
// 폴링하지 않는 이름(예: OC2Sandbox)이 아니라 실제 폴링 이름(예: oc2)을 고를 수 있어야 한다.
// 대소문자 무시 중복 제거(잡 매칭도 소문자 기준).
adminRouter.get('/idrac/scan-agents', adminOnly, (_req, res) => {
  const names = new Set();
  const lower = new Set();
  const add = (v) => { const s = String(v || '').trim(); if (!s) return; const k = s.toLowerCase(); if (!lower.has(k)) { lower.add(k); names.add(s); } };
  for (const k of Object.keys(getAllAgentConfigs() || {})) add(k);
  for (const x of listInventory()) add(x.agent);
  for (const x of getAllGpuGuestDiag()) add(x.agent);
  for (const a of listAssignments()) add(a.agent);
  for (const k of Object.keys(getResults() || {})) add(k);
  for (const c of listCollectors()) { add(c.id); add(c.name); } // 수집 서버(원격) 등록분
  const polling = recentPollingAgents(5 * 60_000); // 최근 5분 내 잡 인출 폴링(소문자)
  for (const p of polling) add(p); // 실제 폴링 중인 이름을 반드시 선택 가능하게
  res.json({ agents: [...names].sort((a, b) => a.localeCompare(b)), pollingAgents: polling, centralEnabled: Boolean(config.central.token) });
});
adminRouter.post('/idrac/register-scanned', adminOnly, fleetOnly, (req, res) => {
  const { found, username, password, mode, vcenterId, datacenterId, agent } = req.body || {};
  const ag = String(agent || '').trim();
  if (ag && ag !== '__local__') {
    if (!config.central.token) return res.status(400).json({ ok: false, reason: '중앙(CENTRAL_TOKEN) 미설정 — 위임 등록을 사용할 수 없습니다.' });
    const reqId = enqueueIdracRegister(ag, { found, username, password, vcenterId: vcenterId || '', datacenterId: String(datacenterId || '').trim(), mode: normIdracMode(mode) });
    if (!reqId) return res.status(429).json({ ok: false, reason: '등록할 iDRAC가 없거나 대기 잡이 너무 많습니다.' });
    return res.json({ ok: true, delegated: true, agent: ag, reqId });
  }
  const result = registerScanned(found, username, password, normIdracMode(mode), vcenterId || '');
  if (result.ok) pollNow().catch(() => {});
  res.status(result.ok ? 200 : 400).json(result);
});

// ---- vCenter별 iDRAC 스캔 대역 + 주기 자동 발견(IPMS의 'vCenter별 스캔 대역'과 동일 흐름) ----
// 각 vCenter에 iDRAC IP 대역 + 계정을 저장하면, 주기 스캐너가 그 대역을 돌며 Dell iDRAC을
// 발견해 해당 vCenter로 자동 등록한다. 비밀번호는 응답에서 마스킹된다.
adminRouter.get('/idrac/scan-ranges', adminOnly, (_req, res) => {
  res.json({ ok: true, ranges: listScanRanges(), status: idracScanStatus(), centralEnabled: Boolean(config.central.token) });
});
// 저장/수정. Body: { id?, datacenterId, service?, ranges?, username?, password?, agent?, enabled?, mode? }
// id가 있으면 그 엔트리 수정, 없으면 새 엔트리 생성(한 법인에 여러 서비스 엔트리 허용).
// (구버전 클라이언트 호환: vcenterId로 와도 datacenterId로 처리)
adminRouter.put('/idrac/scan-ranges', adminOnly, fleetOnly, (req, res) => {
  const b = req.body || {};
  const dcId = b.datacenterId || b.vcenterId;
  const r = saveScanRanges({ ...b, datacenterId: dcId });
  if (r.ok) logAudit({ user: req.user?.username, action: 'iDRAC 스캔 대역 저장', target: `${dcId}${r.service ? `/${r.service}` : ''} (대역 ${(r.ranges || []).length}개${r.enabled ? '' : ', 비활성'}${r.droppedSecrets?.length ? ', 대역·엣지·계정 변경으로 저장 비밀번호 폐기' : ''})` }); // v2.606 LEFT2606-02
  res.status(r.ok ? 200 : 400).json(r);
});
// 삭제. :id = 엔트리 고유키(구버전 마이그레이션분은 id=datacenterId).
adminRouter.delete('/idrac/scan-ranges/:id', adminOnly, fleetOnly, (req, res) => {
  const r = removeScanRanges(req.params.id);
  if (r.ok) logAudit({ user: req.user?.username, action: 'iDRAC 스캔 대역 삭제', target: req.params.id });
  // v2.583: '없는 항목' 만 404 — 디스크 쓰기 실패는 500(서버 쪽 문제다. 404 로 두면 사용자가 목록이 낡은 줄 안다)
  res.status(r.ok ? 200 : r.reason === '없는 항목' ? 404 : 500).json(r);
});
/* ── 스캔 대역 CSV 일괄 관리(v2.339, 사용자 요구) — 수집 서버 CSV(v2.338)와 동일 골격. ──────
 * 내보내기 기본은 비밀번호 제외, ?secrets=1 은 requireSettingsOwner + 감사로그.
 * 가져오기는 dryRun(법인 해석·대역 문법(expandIpList)·중복 검증) → 커밋 2단계이고,
 * (법인,서비스)가 겹치는 행은 body.overwrite=true 명시 시에만 갱신한다.
 */
adminRouter.get('/idrac/scan-ranges/export.csv', adminOnly, (req, res) => {
  const withPw = String(req.query.secrets || '') === '1';
  const dcName = (() => { try { const m = new Map(listDatacenters().map((d) => [d.id, d.name || d.id])); return (id) => m.get(id) || id || ''; } catch { return (id) => id || ''; } })();
  const send = () => {
    const list = withPw ? listScanRanges().map((e) => getScanRangeRaw(e.id) || e) : listScanRanges();
    const csv = scanRangesToCsv(list, dcName, { includeSecrets: withPw });
    logAudit({ user: req.user?.username, action: withPw ? 'iDRAC 스캔 대역 CSV 내보내기(비밀번호 포함)' : 'iDRAC 스캔 대역 CSV 내보내기', detail: `${list.length}건`, ip: req.ip || '' });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="idrac-scan-ranges${withPw ? '-with-passwords' : ''}.csv"`);
    res.send(csv);
  };
  if (withPw) return requireSettingsOwner(req, res, send);
  send();
});

adminRouter.get('/idrac/scan-ranges/sample.csv', adminOnly, (_req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="idrac-scan-ranges-sample.csv"');
  res.send(scanRangesSampleCsv());
});

adminRouter.post('/idrac/scan-ranges/import', adminOnly, fleetOnly, (req, res) => {
  const { rows, error } = parseScanRangesCsv(String(req.body?.csv || ''));
  if (error) return res.status(400).json({ ok: false, reason: error });
  if (!rows.length) return res.status(400).json({ ok: false, reason: '가져올 데이터 행이 없습니다.' });

  // 법인 이름/ID → ID(대소문자 무시). 못 찾으면 null → 오류 판정(오타로 유령 법인 생성 방지).
  let dcs = [];
  try { dcs = listDatacenters(); } catch { /* 목록 실패 시 아래 resolve 가 전부 null → 전 행 오류 */ }
  const resolveDc = (v) => {
    const s = String(v || '').trim();
    if (!s) return null;
    if (dcs.some((d) => d.id === s)) return s;
    const byName = dcs.find((d) => String(d.name || '').toLowerCase() === s.toLowerCase());
    return byName ? byName.id : null;
  };
  // (법인,서비스) → 기존 엔트리 id 목록(2개 이상이면 모호 → 행 오류).
  const all = listScanRanges();
  const existingIds = (dcId, service) => all
    .filter((e) => e.datacenterId === dcId && String(e.service || '').toLowerCase() === String(service || '').toLowerCase())
    .map((e) => e.id);

  const { report, summary } = analyzeScanRangesImport(rows, { resolveDc, existingIds });
  if (req.body?.dryRun) return res.json({ ok: true, dryRun: true, report, summary, total: rows.length });

  const allowOverwrite = req.body?.overwrite === true;
  let added = 0, overwritten = 0; const failed = []; const skipped = []; const passwordDropped = [];
  const verdictByLine = new Map(report.map((r) => [r.line, r])); // O(rows²) find → O(rows) (v2.342 성능)
  for (const row of rows) {
    const verdict = verdictByLine.get(row._line);
    if (verdict?.action === 'error') { failed.push({ line: verdict.line, datacenter: row.datacenter, reason: verdict.reason }); continue; }
    const ids = existingIds(verdict.dcId, row.service);
    if (ids.length === 1 && !allowOverwrite) { skipped.push({ line: row._line, datacenter: row.datacenter, reason: '기존 항목 — 덮어쓰기 미허용(overwrite 확인 필요)' }); continue; }
    const input = { id: ids[0], datacenterId: verdict.dcId, service: row.service, ranges: row.ranges,
      username: row.username, agent: row.agent, dispatch: row.dispatch, enabled: row.enabled, mode: row.mode };
    if (row._hasPassword) input.password = row.password; // 비우면 기존 유지(saveScanRanges 규칙)
    const r = saveScanRanges(input);
    if (r.ok) {
      if (ids.length === 1) overwritten++; else added++;
      // v2.606 LEFT2606-02: 대역·엣지·계정이 바뀐 덮어쓰기는 저장 비밀번호를 폐기한다 — 그 행을 밝힌다(조용한 폐기 금지)
      // v2.612 LEFT2612-02: 고정 문구 대신 saveScanRanges 가 준 **필드별 사유**(r.skipped)를 그대로 싣는다 — 고정 문구는
      //   iLO 만 폐기된 행에도 'Dell 비밀번호 폐기 · 스캔 보류' 라고 말했다(Dell 스캔은 계속된다). iLO 비밀번호는 CSV 에 열이
      //   없어 다시 넣을 길이 없으므로 그 사실과 조치(화면에서 입력)를 덧붙인다.
      if (r.droppedSecrets?.length) {
        const reasons = (Array.isArray(r.skipped) ? r.skipped : []).map((x) => String(x?.reason || '')).filter(Boolean);
        if (!reasons.length) reasons.push(`저장된 비밀번호를 폐기했습니다(${r.droppedSecrets.join(', ')}).`);
        if (r.droppedSecrets.includes('iloPassword')) reasons.push('iLO 비밀번호는 CSV 로 넣을 수 없습니다 — 설정 화면의 스캔 대역 편집에서 iLO 비밀번호를 입력하세요.');
        passwordDropped.push({ line: row._line, datacenter: row.datacenter, fields: [...r.droppedSecrets], reason: `저장됨 — 단 ${reasons.join(' ')}` });
      }
    }
    else failed.push({ line: row._line, datacenter: row.datacenter, reason: r.reason });
  }
  logAudit({ user: req.user?.username, action: 'iDRAC 스캔 대역 CSV 가져오기', detail: `추가 ${added}·덮어쓰기 ${overwritten}·건너뜀 ${skipped.length}·실패 ${failed.length}${passwordDropped.length ? `·비밀번호 폐기 ${passwordDropped.length}` : ''}`, ip: req.ip || '' });
  res.json({ ok: true, added, overwritten, skipped, failed, passwordDropped, total: rows.length });
});

// 지금 스캔(비동기). Body: { id? }(엔트리 하나) | { datacenterId? }(그 법인의 모든 서비스) | {}(전체 enabled).
adminRouter.post('/idrac/scan-ranges/scan', adminOnly, fleetOnly, (req, res) => {
  const id = String(req.body?.id || '').trim();
  const datacenterId = String(req.body?.datacenterId || req.body?.vcenterId || '').trim();
  const opts = id ? { id } : datacenterId ? { datacenterId } : {};
  const r = startIdracScanNow(opts);
  logAudit({ user: req.user?.username, action: 'iDRAC 대역 즉시 스캔', target: id || datacenterId || '(전체)' });
  res.status(r.ok ? 200 : 400).json({ ...r, status: idracScanStatus() });
});
// 진행 상태(가벼운 폴링용).
adminRouter.get('/idrac/scan-ranges/status', adminOnly, (_req, res) => res.json({ ok: true, status: idracScanStatus() }));

// 스캔 로그(이력) — 주기/수동 스캔의 법인별 실행 기록. datacenterId 미지정 = 전체 통합.
adminRouter.get('/idrac/scan-log', adminOnly, (req, res) => {
  const datacenterId = String(req.query.datacenterId || '').trim();
  const limit = Number(req.query.limit) || 300;
  res.json({ ok: true, entries: listIdracScanLog({ datacenterId, limit }), datacenters: idracScanLogDatacenters() });
});

// 스캔 중지 — 진행 중 중앙 직접 스캔 중단 + 대기 중 위임 잡 취소(이미 인출된 위임 잡은 원격 중지 불가).
adminRouter.post('/idrac/scan-ranges/stop', adminOnly, fleetOnly, (req, res) => {
  const r = stopIdracScanNow();
  logAudit({ user: req.user?.username, action: 'iDRAC 스캔 중지', target: '(전체)', detail: `중앙중단=${r.stoppingCentral} 위임취소=${r.canceledJobs}` });
  res.json({ ...r, status: idracScanStatus() });
});

// 주기 스캔 간격 설정(시간 단위, 0=주기 끔·수동만). 저장 즉시 타이머 재적용, 업그레이드 후에도 유지.
adminRouter.put('/idrac/scan-ranges/interval', adminOnly, fleetOnly, (req, res) => {
  // v2.600 LO2600-05: 빈 값·null 은 400 — Number('')===0 이라 빈 칸이 '주기 끔' 으로 저장됐다(명시적 0 만 끔).
  const hours = numOrNull(req.body?.hours);
  if (hours == null || hours < 0 || hours > 720) return res.status(400).json({ ok: false, reason: '주기는 0~720 시간이어야 합니다(0=주기 끔).' });
  const r = setIdracScanIntervalMs(Math.round(hours * 3_600_000));
  if (r.ok) logAudit({ user: req.user?.username, action: 'iDRAC 스캔 주기 변경', target: `${hours}시간` });
  res.status(r.ok ? 200 : 500).json({ ...r, status: idracScanStatus() });
});

// 스캔 현황 — 주기 스캐너 상태 + 진행 중·최근 위임 스캔/등록 잡 목록(어디서든 진행 확인용).
// 위임 스캔으로 에이전트 현지 등록된 전력은 '원격 수집(collector)'로 반영되므로, 스캔 에이전트가
// 수집 서버로 등록돼 있는지 UI가 진단할 수 있게 수집 서버 요약(상태 포함)도 함께 반환한다.
adminRouter.get('/idrac/scan-jobs', adminOnly, (_req, res) => {
  const st = allCollectorStatus();
  const collectors = listCollectors().map((c) => ({
    id: c.id, name: c.name, datacenter: c.datacenter || '', enabled: c.enabled !== false,
    ok: st[c.id]?.ok ?? null, hosts: st[c.id]?.ok ? (st[c.id]?.hosts ?? 0) : 0, at: st[c.id]?.at || null, error: st[c.id]?.error || null,
  }));
  res.json({ ok: true, status: idracScanStatus(), jobs: listIdracScanJobs(), collectors, centralEnabled: Boolean(config.central.token) });
});

// 스캔 잡 세부 로그 — '스캔 현황' 로그창. 이벤트 타임라인 + 멈춤 진단(hints).
adminRouter.get('/idrac/scan-job-log', adminOnly, (req, res) => {
  // 수집 서버(원격)로 등록된 id/이름(소문자) — '등록·정상인데 폴링만 없음' 진단에 사용.
  const collectors = new Set();
  for (const c of listCollectors()) { if (c.id) collectors.add(String(c.id).toLowerCase()); if (c.name) collectors.add(String(c.name).toLowerCase()); }
  // v2.440: 배포 대상에 그 엣지가 등록돼 있으면 SSH 접속 주소를 조치 절차의 명령에 그대로 넣는다
  // (사용자가 '어느 장비에 붙어야 하나' 를 다시 찾지 않게). 비밀은 넘기지 않는다 — host/port/계정만.
  const reqId = String(req.query.reqId || '');
  const jobAgent = agentOfReq(reqId).trim().toLowerCase();
  let deployTarget = null;
  if (jobAgent) {
    const t = listTargets().find((x) => String(x.agentName || '').trim().toLowerCase() === jobAgent);
    if (t) deployTarget = { host: t.host || '', port: Number(t.port) || 22, username: t.username || 'root' };
  }
  const r = getIdracScanJobLog(reqId, { collectors, deployTarget });
  res.status(r.ok ? 200 : 404).json(r);
});

// 개별 대기 잡 취소 — 잘못된 AGENT_NAME 등으로 영원히 '대기'하는 잡 하나를 전체 중지 없이 정리.
adminRouter.post('/idrac/scan-job/cancel', adminOnly, fleetOnly, (req, res) => {
  const reqId = String(req.body?.reqId || '');
  const r = cancelIdracScanJob(reqId);
  if (r.ok) logAudit({ user: req.user?.username, action: 'iDRAC 대기 잡 취소', target: reqId });
  res.status(r.ok ? 200 : 400).json(r);
});

// 서버 일괄 삭제. Body: { all:true } 또는 { vcenterId } (빈 문자열=미지정 서버 삭제).
adminRouter.post('/idrac/delete', adminOnly, fleetOnly, (req, res) => {
  const b = req.body || {};
  const result = b.all
    ? deleteServers({ all: true })
    : (Object.prototype.hasOwnProperty.call(b, 'vcenterId')
      ? deleteServers({ vcenterId: b.vcenterId })
      : { ok: false, reason: 'all=true 또는 vcenterId가 필요합니다.' });
  if (result.ok) pollNow().catch(() => {});
  res.status(result.ok ? 200 : 400).json(result);
});

// 다수 iDRAC 서버의 소속 vCenter 일괄 지정/해제. Body: { ids?:[], vcenterId, all? }
// ids 미지정 + all=true → 전체 적용. 빈 vcenterId = 지정 해제(이름/태그 매칭으로 복귀).
adminRouter.post('/idrac/assign-vcenter', adminOnly, fleetOnly, (req, res) => {
  const b = req.body || {};
  const ids = b.all ? null : (Array.isArray(b.ids) ? b.ids : []);
  if (!b.all && (!ids || !ids.length)) return res.status(400).json({ ok: false, reason: '대상(ids) 또는 all=true가 필요합니다.' });
  const result = assignVcenter({ ids, vcenterId: b.vcenterId || '' });
  if (result.ok) pollNow().catch(() => {});
  res.json(result);
});

// 파라미터 라우트는 반드시 위의 모든 리터럴 '/idrac/...' 라우트 뒤에 둔다. 그렇지 않으면
// PUT/DELETE '/idrac/:id'가 '/idrac/scan-ranges'·'/idrac/power-settings' 같은 리터럴을 가려
// id="scan-ranges"로 잘못 처리되어 '없는 서버: scan-ranges' 오류가 난다.
adminRouter.put('/idrac/:id', adminOnly, fleetOnly, async (req, res) => {
  const result = updateServer(req.params.id, req.body || {});
  if (result.ok) pollNow().catch(() => {});
  res.status(result.ok ? 200 : 400).json(result);
});

adminRouter.delete('/idrac/:id', adminOnly, fleetOnly, async (req, res) => {
  const result = removeServer(req.params.id);
  res.status(result.ok ? 200 : 404).json(result);
});
}
