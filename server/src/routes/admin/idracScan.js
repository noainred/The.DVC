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
import { enqueueIdracScan, enqueueIdracRegister, getIdracScanResult, listIdracScanJobs, getIdracScanJobLog, cancelIdracScanJob, recentPollingAgents } from '../../central/idracScanJobs.js';
import { pushIdracScan } from '../../central/idracScanPush.js';
import { getPollerStatus, pollNow } from '../../idrac/poller.js';
import { listScanRanges, saveScanRanges, removeScanRanges } from '../../idrac/scanRanges.js';
import { startIdracScanNow, idracScanStatus, stopIdracScanNow, setIdracScanIntervalMs } from '../../idrac/scanPoller.js';
import { listIdracScanLog, idracScanLogDatacenters } from '../../idrac/scanLog.js';
import { getInventory as getIdracInventory } from '../../idrac/invCache.js';
import { getSensorSeries } from '../../idrac/sensorStore.js';
import { fetchInventory as fetchIdracInventory, fetchSensors as fetchIdracSensors, probeGpuTelemetry } from '../../idrac/redfish.js';
import { listCollectors } from '../../collector/registry.js';
import { findRemoteServer } from '../../collector/remoteInventory.js';
import { findHostByServiceTag } from '../../idrac/hostMatch.js';
import { getDatacenterAssign } from '../../datacenter/store.js';
import { allCollectorStatus } from '../../collector/state.js';
import { listAssignments, getResults } from '../../central/assignments.js';
import { adminOnly } from './shared.js';


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
  const tag = norm(s.serviceTag || getIdracInventory(id)?.system?.serviceTag || s.inv?.system?.serviceTag || '');
  if (!tag) return res.json({ ok: true, matched: false, serviceTag: '', reason: '서비스태그 없음' });
  const snap = store.get();
  const assign = getDatacenterAssign();
  const host = findHostByServiceTag(tag, snap.hosts || []);
  if (!host) return res.json({ ok: true, matched: false, serviceTag: s.serviceTag || tag });
  res.json({
    ok: true, matched: true, serviceTag: host.serviceTag || tag,
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
    // 위임 법인 원격 서버: 중앙에 시계열이 없음(온도 동기화는 후속). 상세 팝업이 에러나지 않게 빈 응답.
    if (findRemoteServer(req.params.id)) return res.json({ ok: true, remote: true, latest: null, series: [], live: null });
    return res.status(404).json({ ok: false, reason: '서버를 찾을 수 없습니다.' });
  }
  if (s.type === 'ome') return res.status(400).json({ ok: false, reason: 'OME 소스는 센서 시계열을 지원하지 않습니다.' });
  let live = null;
  if (req.query.live === '1') {
    try { live = await fetchIdracSensors(s); } catch (e) { live = { error: e.message }; }
  }
  const minutes = Math.max(0, Math.min(1440, Number(req.query.minutes) || 0));
  res.json({ ok: true, ...getSensorSeries(s.id, { minutes }), live, intervalMs: getPollerStatus().intervalMs });
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
adminRouter.post('/idrac/import', adminOnly, (req, res) => {
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
adminRouter.post('/idrac/bulk-add', adminOnly, (req, res) => {
  const result = bulkAddByIps(req.body || {});
  if (result.ok) pollNow().catch(() => {});
  res.status(result.ok ? 200 : 400).json(result);
});

// Scan an IP range and return only the IPs that are real Dell iDRACs (with
// identity). No writes. Body: { ips, username, password, agent? }
// agent 미지정/'__local__' = 이 포탈에서 직접 스캔(동기). 그 외 = 해당 에이전트에 위임.
adminRouter.post('/idrac/scan', adminOnly, async (req, res) => {
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

  try {
    const result = await scanForIdracs({ ips, username, password });
    res.json({ ok: true, delegated: false, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, reason: err.message });
  }
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
adminRouter.post('/idrac/register-scanned', adminOnly, (req, res) => {
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
adminRouter.put('/idrac/scan-ranges', adminOnly, (req, res) => {
  const b = req.body || {};
  const dcId = b.datacenterId || b.vcenterId;
  const r = saveScanRanges({ ...b, datacenterId: dcId });
  if (r.ok) logAudit({ user: req.user?.username, action: 'iDRAC 스캔 대역 저장', target: `${dcId}${r.service ? `/${r.service}` : ''} (대역 ${(r.ranges || []).length}개${r.enabled ? '' : ', 비활성'})` });
  res.status(r.ok ? 200 : 400).json(r);
});
// 삭제. :id = 엔트리 고유키(구버전 마이그레이션분은 id=datacenterId).
adminRouter.delete('/idrac/scan-ranges/:id', adminOnly, (req, res) => {
  const r = removeScanRanges(req.params.id);
  if (r.ok) logAudit({ user: req.user?.username, action: 'iDRAC 스캔 대역 삭제', target: req.params.id });
  res.status(r.ok ? 200 : 404).json(r);
});
// 지금 스캔(비동기). Body: { id? }(엔트리 하나) | { datacenterId? }(그 법인의 모든 서비스) | {}(전체 enabled).
adminRouter.post('/idrac/scan-ranges/scan', adminOnly, (req, res) => {
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
adminRouter.post('/idrac/scan-ranges/stop', adminOnly, (req, res) => {
  const r = stopIdracScanNow();
  logAudit({ user: req.user?.username, action: 'iDRAC 스캔 중지', target: '(전체)', detail: `중앙중단=${r.stoppingCentral} 위임취소=${r.canceledJobs}` });
  res.json({ ...r, status: idracScanStatus() });
});

// 주기 스캔 간격 설정(시간 단위, 0=주기 끔·수동만). 저장 즉시 타이머 재적용, 업그레이드 후에도 유지.
adminRouter.put('/idrac/scan-ranges/interval', adminOnly, (req, res) => {
  const hours = Number(req.body?.hours);
  if (!Number.isFinite(hours) || hours < 0 || hours > 720) return res.status(400).json({ ok: false, reason: '주기는 0~720 시간이어야 합니다(0=주기 끔).' });
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
  const r = getIdracScanJobLog(String(req.query.reqId || ''), { collectors });
  res.status(r.ok ? 200 : 404).json(r);
});

// 개별 대기 잡 취소 — 잘못된 AGENT_NAME 등으로 영원히 '대기'하는 잡 하나를 전체 중지 없이 정리.
adminRouter.post('/idrac/scan-job/cancel', adminOnly, (req, res) => {
  const reqId = String(req.body?.reqId || '');
  const r = cancelIdracScanJob(reqId);
  if (r.ok) logAudit({ user: req.user?.username, action: 'iDRAC 대기 잡 취소', target: reqId });
  res.status(r.ok ? 200 : 400).json(r);
});

// 서버 일괄 삭제. Body: { all:true } 또는 { vcenterId } (빈 문자열=미지정 서버 삭제).
adminRouter.post('/idrac/delete', adminOnly, (req, res) => {
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
adminRouter.post('/idrac/assign-vcenter', adminOnly, (req, res) => {
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
adminRouter.put('/idrac/:id', adminOnly, async (req, res) => {
  const result = updateServer(req.params.id, req.body || {});
  if (result.ok) pollNow().catch(() => {});
  res.status(result.ok ? 200 : 400).json(result);
});

adminRouter.delete('/idrac/:id', adminOnly, async (req, res) => {
  const result = removeServer(req.params.id);
  res.status(result.ok ? 200 : 404).json(result);
});
}
