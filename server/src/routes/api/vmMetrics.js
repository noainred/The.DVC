// VM/호스트 메트릭·콘솔 티켓·iDRAC 전력 — api.js(구 2,445줄) 분할(v2.283.0). 본문은 원본 그대로, 등록 순서는 api.js 호출 순서가 보존한다.
import { requirePerm } from '../../auth/auth.js';
import { inUserScope, inUserWriteScope, scopedVcenterIds } from '../../auth/scope.js';
import { store } from '../../store.js';
import { loadVcenterConfig } from '../../config.js';
import { hostPower } from '../../idrac/service.js';
import { fetchVmMetric, fetchHostMetric, fetchVmMetrics, fetchHostMetrics, pickPerfInterval, PERF_INTERVALS, PERF_RETENTION_DEFAULT, getVmConsole, fetchHostNicStats } from '../../vcenter/soapClient.js';
import { NIC_REALTIME_SAMPLES } from '../../vcenter/nicPerf.js';   // v2.925(B-③)
import { OVERLOAD_PCT } from '../../inventory/vmSignals.js'; // v2.911 성능 화면 기준선 — 신호 '과부하' 와 같은 값(화면에 90 을 박지 않는다)
import { respondIfVcAuthStopped, respondVcError } from '../../vcenter/authStopGate.js'; // v2.733(C3-01): 판정을 공용 헬퍼로
import { isAdminReq } from '../../auth/addressMask.js';
import { morefOf } from '../../vcenter/registry.js'; // v2.598 VC2598-06: 콜론 포함 vCenter id 안전한 moref 추출
import { idracScopeOf, idracInScope } from '../admin/idracCore.js'; // v2.742 AUTHZ-01: iDRAC 서버 범위 판정 한 벌(v2.629 AUTHZ2629-03)
import { loadCollectors } from '../../collector/registry.js';

/**
 * 성능 모달의 **실시간 자동 갱신(20초)** 이 vCenter 인증 실패 정지를 따른다(v2.591 — 감사 F6).
 * 모달을 연 채 두면 분당 3회 로그인이고, 인벤토리 수집(store)과 **같은 계정**이라 store 가 멈춰도 잠금은 그대로였다.
 * · 정지 중이면 로그인하지 않고 **409 + authStopped** 로 답한다(화면이 자동 갱신을 멈추고 사유를 말한다).
 * · 사람이 누른 새로고침(`manual=1`)은 막지 않는다(authGuard 규칙 3 — 고친 뒤 확인할 길).
 * · 로그인 거부면 주 폴러와 **같은 기록**에 시도를 올린다(화면의 시도 횟수가 정직해지게). 해제는 주 폴러·연결 테스트만.
 * v2.733(점검 3회차 C3-01): 판정이 형제 주문형 성능 경로 다섯 곳과 같아야 해서 `vcenter/authStopGate.js` 로 올렸다
 *   (응답 모양·문구는 그대로다 — authStop2591 F6 이 고정한다).
 * @returns {boolean} 응답을 보냈으면 true
 */
const metricAuthStopped = (req, res, vc) => respondIfVcAuthStopped(req, res, vc, { allowManual: true });
const metricError = (res, vc, err) => respondVcError(res, vc, err);


const METRIC_TYPES = ['cpu', 'mem', 'disk', 'net'];
const METRIC_UNIT = { cpu: '%', mem: '%', disk: 'KBps', net: 'KBps' };

/**
 * v2.911 — `types=cpu,mem,disk,net`(복수) 파싱: 화이트리스트 · 중복 제거 · 순서 유지. 없거나 전부 모르는 값이면 [](단건 `type=` 경로).
 * 배열(`types=cpu&types=mem`)도 받는다. 상한 4(지표 수) — 긴 문자열은 잘라서 본다(O(n) 분할만).
 */
export function parseMetricTypes(raw) {
  const text = Array.isArray(raw) ? raw.map((x) => String(x ?? '')).join(',') : String(raw ?? '');
  if (!text) return [];
  const out = [];
  for (const part of text.slice(0, 200).split(',')) {
    const k = part.trim().toLowerCase();
    if (METRIC_TYPES.includes(k) && !out.includes(k)) out.push(k);
  }
  return out;
}

/** v2.911 — 목 모드 다중 지표 응답(라이브 `fetchEntityMetrics` 와 같은 모양 — 롤업 선택도 같은 규칙으로). */
export function synthMetrics(entity, types, interval, range = {}, now = Date.now()) {
  const picked = pickPerfInterval({ interval, start: range.start, end: range.end, now, retention: PERF_RETENTION_DEFAULT });
  const series = {};
  for (const t of types) { const one = synthMetric(entity, t, picked.name, range); series[t] = { unit: one.unit, points: one.points }; }
  const startTime = range.start ? new Date(range.start).toISOString() : null;
  const endTime = range.end ? new Date(range.end).toISOString() : null;
  return {
    ok: true, types: [...types], requested: PERF_INTERVALS[interval] ? interval : 'realtime', interval: picked.name, sampleSec: picked.id,
    start: startTime, end: endTime, past: !!(startTime || endTime), refreshSec: 20, retention: { ...PERF_RETENTION_DEFAULT }, retentionSource: 'default',
    series, missingCounters: [], mock: true,
  };
}
const withOverload = (r) => ({ ...r, overloadPct: OVERLOAD_PCT });

// Synthesize a realistic series for mock mode so the viewer works out of the box.
// Honors an explicit { start, end } date range when provided.
function synthMetric(vm, type, interval, range = {}) {
  const stepMs = { realtime: 20_000, day: 300_000, week: 1_800_000, month: 7_200_000, year: 86_400_000 }[interval] || 20_000;
  const defN = { realtime: 180, day: 288, week: 336, month: 360, year: 365 }[interval] || 180;
  let endMs = range.end ? Date.parse(range.end) : Date.now();
  let startMs = range.start ? Date.parse(range.start) : endMs - (defN - 1) * stepMs;
  if (startMs > endMs) [startMs, endMs] = [endMs, startMs];
  const n = Math.max(2, Math.min(2000, Math.round((endMs - startMs) / stepMs) + 1));
  const spec = { n, stepMs, startMs };
  const base = type === 'cpu' ? (vm.cpuUsagePct || 10)
    : type === 'mem' ? (vm.memUsagePct || 20)
      : type === 'disk' ? 1800 : 900; // KBps baselines
  const amp = type === 'cpu' || type === 'mem' ? base * 0.5 + 8 : base * 0.8;
  const seed = [...vm.id].reduce((a, c) => a + c.charCodeAt(0), 0);
  const points = [];
  for (let i = 0; i < spec.n; i++) {
    const t = new Date(spec.startMs + i * spec.stepMs).toISOString();
    const wave = Math.sin((i + seed) / 9) * 0.6 + Math.sin((i + seed) / 23) * 0.4;
    let v = base + wave * amp + (((seed * (i + 1)) % 17) - 8) * (amp / 20);
    if (type === 'cpu' || type === 'mem') v = Math.max(0, Math.min(100, v));
    else v = Math.max(0, v);
    points.push({ t, v: Math.round(v * 10) / 10 });
  }
  return { ok: true, type, interval, unit: METRIC_UNIT[type], points, mock: true, start: range.start || null, end: range.end || null };
}

/**
 * v2.925(B-③) — 목 모드 vmnic 카운터(라이브 fetchHostNicStats 와 같은 모양). 호스트 id 로 결정적이고, 몇몇 호스트의 한 NIC 에만
 * 수신 드롭을 넣어 화면의 판정('ESXi 쪽 · 스위치 쪽 · 드롭 없음')이 갈리게 한다. NIC 이름을 하나도 모르면 빈 목록.
 */
export function synthNicStats(host, now = Date.now()) {
  const seed = [...String(host?.id || '')].reduce((a, c) => a + c.charCodeAt(0), 0);
  const samples = NIC_REALTIME_SAMPLES;
  const end = Math.floor(now / 20_000) * 20_000;
  // 인벤토리 NIC 목록이 없는 데모 호스트는 가상 스위치 업링크 이름(hcfg.net)으로 — 라이브는 vCenter 가 답한 인스턴스를 그대로 쓴다.
  const names = new Set((Array.isArray(host?.nics) ? host.nics : []).map((n) => String(n?.device || '')));
  for (const sw of (Array.isArray(host?.hcfg?.net?.switches) ? host.hcfg.net.switches : [])) for (const u of (Array.isArray(sw?.uplinks) ? sw.uplinks : [])) names.add(String(u || ''));
  const nics = [...names].filter((d) => /^vmnic\d{1,3}$/.test(d)).slice(0, 16)
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    .map((nic, i) => {
      const up = (Array.isArray(host?.nics) ? host.nics : []).find((n) => n?.device === nic)?.link !== false;
      const pk = up ? 180 * (1800 + ((seed * (i + 3)) % 900)) : 0;
      const dropRx = up && (seed + i) % 4 === 0 ? 20 + (seed % 40) : 0;
      return { nic, droppedRx: dropRx, droppedTx: 0, errorsRx: 0, errorsTx: 0, packetsRx: pk, packetsTx: Math.round(pk * 0.8),
        valid: { droppedRx: samples, droppedTx: samples, errorsRx: samples, errorsTx: samples, packetsRx: samples, packetsTx: samples },
        samples, partial: false };
    });
  return { ok: true, mock: true, interval: 'realtime', sampleSec: 20, nics, windowStart: new Date(end - (samples - 1) * 20_000).toISOString(), windowEnd: new Date(end).toISOString(),
    samples, missingCounters: [], instancesTruncated: false };
}

/** 스냅샷 객체(VM·호스트) → { vcId, moref }. id 를 첫 콜론에서 자르지 않는다(v2.598 VC2598-06 — registry.morefOf 규약). */
export function vcRefOf(obj) {
  const vcId = String(obj?.vcenterId || '');
  return { vcId, moref: morefOf(obj?.id, vcId) };
}

/*
 * v2.600 AUTHZ-2600-06 — 권한 게이트가 없어 viewer 도 iDRAC 관리 URL(server.host)·iDRAC 네트워크
 * 식별(info.network 의 IP·FQDN)을 받았다. 형제 `/hosts/:id/metrics` 와 같은 `inv.hosts` 게이트를 걸고,
 * 비-admin 에는 관리 주소를 가린다(전력·하드웨어 정보는 그대로). iDRAC 등록부는 id 를 IP 문자열로
 * 발급하므로(`idrac/registry.js`) id 도 주소면 비운다. 가린 사실은 addressHidden.
 */
const IPV4_ID = /^\d{1,3}(?:\.\d{1,3}){3}$/;
export function maskHostPower(r) {
  if (!r || typeof r !== 'object') return r;
  const out = { ...r, addressHidden: true };
  if (out.server && typeof out.server === 'object') {
    const s = { ...out.server };
    const bare = String(s.host || '').replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/[/:].*$/, '');
    // '(via OME)'·'(수집서버 …)' 같은 출처 표식은 주소가 아니라 그대로 둔다.
    if (typeof s.host === 'string' && !/^\(.*\)$/.test(s.host)) s.host = '';
    if (typeof s.id === 'string' && (IPV4_ID.test(s.id) || (bare && s.id === bare))) s.id = '';
    if (typeof s.name === 'string' && bare && (s.name === r.server.host || s.name === bare)) s.name = '(이름 가림)';
    out.server = s;
  }
  if (out.info && typeof out.info === 'object' && Array.isArray(out.info.network)) {
    out.info = { ...out.info, network: out.info.network.map((n) => (n && typeof n === 'object' ? { ...n, ipv4: '', hostName: '', fqdn: '' } : n)) };
  }
  return out;
}

export function registerVmMetrics(api) {

// On-demand VM performance time-series — NOT collected by the regular poll.
// Queried live from vCenter only when the user opens the metric viewer.
//   /vms/:id/metrics?type=cpu|mem|disk|net&interval=realtime|day|week|month|year
api.get('/vms/:id/metrics', requirePerm('inv.vms'), async (req, res) => {
  const id = req.params.id;
  const type = METRIC_TYPES.includes(req.query.type) ? req.query.type : 'cpu';
  const interval = PERF_INTERVALS[req.query.interval] ? req.query.interval : 'realtime';
  // Optional explicit date range (ISO/datetime-local). Empty = rolling window.
  const start = req.query.start && !Number.isNaN(Date.parse(req.query.start)) ? req.query.start : null;
  const end = req.query.end && !Number.isNaN(Date.parse(req.query.end)) ? req.query.end : null;

  const types = parseMetricTypes(req.query.types);   // v2.911 복수 지표 — 로그인 1회 · QueryPerf 1회

  const snap = store.get();
  const vm = snap.vms.find((v) => v.id === id);
  if (!vm) return res.status(404).json({ ok: false, reason: 'VM을 찾을 수 없습니다.' });
  // 사용자 scope 밖 자원은 '없음'으로 응답(존재 여부도 흘리지 않는다).
  if (!inUserScope(req.user, snap, vm.vcenterId)) return res.status(404).json({ ok: false, reason: 'VM을 찾을 수 없습니다.' });

  if (snap.source === 'mock') return res.json(types.length ? withOverload(synthMetrics(vm, types, interval, { start, end })) : synthMetric(vm, type, interval, { start, end }));

  // v2.598 VC2598-06: vCenter id 에 콜론이 있을 수 있다(registry 가 허용) — 첫 콜론에서 자르면 `apac:vc01:vm-1`
  // 이 vCenter 'apac' 으로 읽혀 '설정을 찾을 수 없습니다' 가 됐다. 스냅샷 객체의 vcenterId 로 자른다(morefOf).
  const { vcId, moref } = vcRefOf(vm);
  const vc = loadVcenterConfig().vcenters.find((v) => v.id === vcId);
  if (!vc) return res.status(404).json({ ok: false, reason: 'vCenter 설정을 찾을 수 없습니다.' });
  if (metricAuthStopped(req, res, vc)) return;
  try {
    res.json(types.length ? withOverload(await fetchVmMetrics(vc, moref, types, interval, { start, end })) : await fetchVmMetric(vc, moref, type, interval, { start, end }));
  } catch (err) {
    metricError(res, vc, err);
  }
});

// ESXi 호스트 성능 — CPU/메모리/디스크/네트워크 실시간 + 기간 조회(VM과 동일 방식).
//   /hosts/:id/metrics?type=cpu|mem|disk|net&interval=realtime|day|week|month|year
api.get('/hosts/:id/metrics', requirePerm('inv.hosts'), async (req, res) => {
  const id = req.params.id;
  const type = METRIC_TYPES.includes(req.query.type) ? req.query.type : 'cpu';
  const interval = PERF_INTERVALS[req.query.interval] ? req.query.interval : 'realtime';
  const start = req.query.start && !Number.isNaN(Date.parse(req.query.start)) ? req.query.start : null;
  const end = req.query.end && !Number.isNaN(Date.parse(req.query.end)) ? req.query.end : null;

  const types = parseMetricTypes(req.query.types);   // v2.911

  const snap = store.get();
  const host = (snap.hosts || []).find((h) => h.id === id);
  if (!host) return res.status(404).json({ ok: false, reason: '호스트를 찾을 수 없습니다.' });
  if (!inUserScope(req.user, snap, host.vcenterId)) return res.status(404).json({ ok: false, reason: '호스트를 찾을 수 없습니다.' });

  if (snap.source === 'mock') return res.json(types.length ? withOverload(synthMetrics(host, types, interval, { start, end })) : synthMetric(host, type, interval, { start, end }));

  const { vcId, moref } = vcRefOf(host);   // v2.598 VC2598-06 — 콜론 포함 vCenter id 안전
  const vc = loadVcenterConfig().vcenters.find((v) => v.id === vcId);
  if (!vc) return res.status(404).json({ ok: false, reason: 'vCenter 설정을 찾을 수 없습니다.' });
  if (metricAuthStopped(req, res, vc)) return;
  try {
    res.json(types.length ? withOverload(await fetchHostMetrics(vc, moref, types, interval, { start, end })) : await fetchHostMetric(vc, moref, type, interval, { start, end }));
  } catch (err) {
    metricError(res, vc, err);
  }
});

// v2.925(B-③) — 호스트 vmnic 드롭·에러(vCenter 실시간 최근 1시간). 형제 /hosts/:id/metrics 와 같은 게이트(inv.hosts · 범위 밖 404 ·
//   주 폴러 인증 정지면 로그인하지 않음). 주기 수집이 아니라 화면 버튼으로만 부른다. 같은 호스트를 동시에 물으면 진행 중인 조회 하나를 함께 쓴다.
const _nicInflight = new Map();   // `${vcId}\u0000${moref}` -> Promise
api.get('/hosts/:id/nic-stats', requirePerm('inv.hosts'), async (req, res) => {
  const snap = store.get();
  const host = (snap.hosts || []).find((h) => h.id === req.params.id);
  if (!host) return res.status(404).json({ ok: false, reason: '호스트를 찾을 수 없습니다.' });
  if (!inUserScope(req.user, snap, host.vcenterId)) return res.status(404).json({ ok: false, reason: '호스트를 찾을 수 없습니다.' });
  res.set('Cache-Control', 'no-store');
  if (snap.source === 'mock') return res.json({ ...synthNicStats(host), host: { id: host.id, name: host.name } });
  const { vcId, moref } = vcRefOf(host);
  const vc = loadVcenterConfig().vcenters.find((v) => v.id === vcId);
  if (!vc) return res.status(404).json({ ok: false, reason: 'vCenter 설정을 찾을 수 없습니다.' });
  if (metricAuthStopped(req, res, vc)) return;
  const k = `${vcId}\u0000${moref}`;
  let p = _nicInflight.get(k);
  if (!p) {
    p = fetchHostNicStats(vc, moref).finally(() => { if (_nicInflight.get(k) === p) _nicInflight.delete(k); });
    _nicInflight.set(k, p);
  }
  try {
    res.json({ ...(await p), host: { id: host.id, name: host.name } });
  } catch (err) {
    metricError(res, vc, err);
  }
});

// VM remote console (원격 콘솔). Returns VMRC + HTML5 web-console launch URLs
// using a one-time vCenter clone ticket. Live only.
api.get('/vms/:id/console', requirePerm('vm.console'), async (req, res) => {
  const id = req.params.id;
  const snap = store.get();
  const vm = snap.vms.find((v) => v.id === id);
  if (!vm) return res.status(404).json({ ok: false, reason: 'VM을 찾을 수 없습니다.' });
  if (!inUserScope(req.user, snap, vm.vcenterId)) return res.status(404).json({ ok: false, reason: 'VM을 찾을 수 없습니다.' });
  // 콘솔은 게스트 OS 조작(키 입력) 능력 — 조회 범위 안이라도 쓰기 범위(writeVcenters, v2.369) 밖이면
  // 403(존재는 이미 보이므로 은닉 불필요). writeVcenters 미설정이면 조회 범위와 동일(기존 동작).
  if (!inUserWriteScope(req.user, snap, vm.vcenterId)) return res.status(403).json({ ok: false, reason: '조회 전용 범위 — 이 vCenter 의 VM 콘솔을 열 수 없습니다.' });
  if (snap.source === 'mock') {
    return res.json({ ok: true, mock: true, vmName: vm.name, reason: '데모 모드입니다. 실제 vCenter(live) 연결 시 VMRC/웹 콘솔 링크가 생성됩니다.' });
  }
  const { vcId, moref } = vcRefOf(vm);   // v2.598 VC2598-06 — 콜론 포함 vCenter id 안전
  const vc = loadVcenterConfig().vcenters.find((v) => v.id === vcId);
  if (!vc) return res.status(404).json({ ok: false, reason: 'vCenter 설정을 찾을 수 없습니다.' });
  try {
    const c = await getVmConsole(vc, moref, vm.name);
    res.json({ ...c, vmName: vm.name });
  } catch (err) {
    res.status(502).json({ ok: false, reason: err.message });
  }
});

const lcTrim = (v) => String(v ?? '').trim().toLowerCase();
/**
 * v2.742(감사 AUTHZ-01): 그 호스트의 vCenter 를 수집하는 엣지(수집 서버 id, 소문자) — 등록부 remoteAgent(site) + 스냅샷 collectedBy.
 * 이름이 수집 서버의 표시 이름이면 id 로 접는다(엣지의 키는 수집 서버 id). 직접 수집 vCenter 면 빈 집합(엣지 항목을 받지 않는다).
 */
function hostCollectorIds(snap, vcenterId) {
  const vid = String(vcenterId || '');
  const reg = (loadVcenterConfig().vcenters || []).find((v) => String(v?.id) === vid);
  const sv = (snap?.vcenters || []).find((v) => String(v?.id) === vid);
  const names = [];
  if (reg && String(reg.collectMode || '') === 'site' && reg.remoteAgent) names.push(reg.remoteAgent);
  if (sv && sv.collectSource === 'site' && sv.collectedBy) names.push(sv.collectedBy);
  const out = new Set();
  let collectors = [];
  try { collectors = loadCollectors() || []; } catch { collectors = []; }
  for (const n of names) {
    const k = lcTrim(n);
    if (!k) continue;
    out.add(k);
    for (const c of collectors) if (lcTrim(c?.id) === k || lcTrim(c?.name) === k) out.add(lcTrim(c.id));
  }
  return out;
}
function hostPowerScope(req, snap, host) {
  const sc = idracScopeOf(req);
  const owners = hostCollectorIds(snap, host?.vcenterId);
  return {
    accept: (s) => idracInScope(sc, s),
    acceptRemote: (r) => owners.has(lcTrim(r?.collectorId)),
  };
}

// Real iDRAC power for one host (current + history). Used by the host detail
// popup. ?name=<esxi host name>&hours=24
// v2.313 보안 감사 반영: 형제 단건 라우트(/hosts/:id/metrics·/vms/:id/console)는 inUserScope
// 위반 시 404 를 반환하는데 이 라우트만 name→hostPower 직행이라, scope 제한 계정이 범위 밖
// ESXi 호스트명을 알면 전력·하드웨어 메타를 조회할 수 있었다. 스냅샷에서 name 으로 호스트를
// 찾아 소유 vCenter 가 범위 밖이면 존재를 숨기고 404(server/CLAUDE.md id 단건 scope 규칙).
api.get('/idrac/host-power', requirePerm('inv.hosts'), async (req, res) => {
  const name = req.query.name;
  if (!name) return res.status(400).json({ matched: false, reason: 'name이 필요합니다.' });
  const snap = store.get();
  // v2.742(감사 AUTHZ-01): 범위 계정은 **범위 안의** 같은 이름 호스트를 고른다 — 예전에는 이름이 같은 첫 호스트(다른 법인일 수 있다)의
  //   vCenter 하나만 보고 판정해, 범위 밖 호스트가 배열 앞에 있으면 자기 호스트도 404 였다. 전체 범위 계정은 예전 그대로(첫 일치).
  const allowedVcs = scopedVcenterIds(req.user, snap);
  const host = allowedVcs
    ? (snap.hosts || []).find((h) => h.name === String(name) && inUserScope(req.user, snap, h.vcenterId))
    : (snap.hosts || []).find((h) => h.name === String(name));
  // 범위 제한 계정: 매칭 호스트가 없거나(그 이름이 스냅샷에 없음) 범위 밖이면 404(존재 은닉).
  if (allowedVcs && !host) {
    return res.status(404).json({ matched: false, reason: '호스트를 찾을 수 없습니다.' });
  }
  try {
    const hours = Math.min(720, Math.max(1, Number(req.query.hours) || 24));
    // v2.322 보안 감사(scope 우회): hostPower 의 serviceTag 폴백(step4)은 태그 일치 장비를 scope
    // 재검사 없이 반환한다. 범위 제한 계정은 클라이언트가 준 임의 serviceTag 를 신뢰하지 않고
    // 위 게이트에서 매칭된 자기 범위 내 호스트의 스냅샷 태그로만 폴백한다(임의 태그로 범위 밖
    // 전력·하드웨어 인벤토리 조회 차단). 전체 범위 계정은 기존 동작(요청 태그 허용) 유지.
    const scoped = !!scopedVcenterIds(req.user, snap);
    const serviceTag = scoped ? (host?.serviceTag ? String(host.serviceTag) : '') : (req.query.serviceTag ? String(req.query.serviceTag) : '');
    // v2.742(감사 AUTHZ-01): 범위 계정이면 찾은 iDRAC·OME 서버의 귀속을 다시 본다(서버 분석과 같은 판정 — idracInScope, 귀속 없음은
    //   미노출). 엣지 보고 전력은 **그 호스트를 수집한 엣지**의 항목만 쓴다. 맞는 서버가 없으면 matched:false(존재 은닉).
    const r = await hostPower(String(name), { hours, serviceTag, ...(scoped ? hostPowerScope(req, snap, host) : {}) });
    res.json(isAdminReq(req) ? r : maskHostPower(r));
  } catch (err) {
    res.status(500).json({ matched: false, reason: err.message });
  }
});
}
