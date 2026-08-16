// VM/호스트 메트릭·콘솔 티켓·iDRAC 전력 — api.js(구 2,445줄) 분할(v2.283.0). 본문은 원본 그대로, 등록 순서는 api.js 호출 순서가 보존한다.
import { requirePerm } from '../../auth/auth.js';
import { inUserScope, scopedVcenterIds } from '../../auth/scope.js';
import { store } from '../../store.js';
import { loadVcenterConfig } from '../../config.js';
import { hostPower } from '../../idrac/service.js';
import { fetchVmMetric, fetchHostMetric, PERF_INTERVALS, getVmConsole } from '../../vcenter/soapClient.js';


const METRIC_TYPES = ['cpu', 'mem', 'disk', 'net'];
const METRIC_UNIT = { cpu: '%', mem: '%', disk: 'KBps', net: 'KBps' };

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

export function registerVmMetrics(api) {

// On-demand VM performance time-series — NOT collected by the regular poll.
// Queried live from vCenter only when the user opens the metric viewer.
//   /vms/:id/metrics?type=cpu|mem|disk|net&interval=realtime|day|week|month|year
api.get('/vms/:id/metrics', async (req, res) => {
  const id = req.params.id;
  const type = METRIC_TYPES.includes(req.query.type) ? req.query.type : 'cpu';
  const interval = PERF_INTERVALS[req.query.interval] ? req.query.interval : 'realtime';
  // Optional explicit date range (ISO/datetime-local). Empty = rolling window.
  const start = req.query.start && !Number.isNaN(Date.parse(req.query.start)) ? req.query.start : null;
  const end = req.query.end && !Number.isNaN(Date.parse(req.query.end)) ? req.query.end : null;

  const snap = store.get();
  const vm = snap.vms.find((v) => v.id === id);
  if (!vm) return res.status(404).json({ ok: false, reason: 'VM을 찾을 수 없습니다.' });
  // 사용자 scope 밖 자원은 '없음'으로 응답(존재 여부도 흘리지 않는다).
  if (!inUserScope(req.user, snap, vm.vcenterId)) return res.status(404).json({ ok: false, reason: 'VM을 찾을 수 없습니다.' });

  if (snap.source === 'mock') return res.json(synthMetric(vm, type, interval, { start, end }));

  const sep = id.indexOf(':');
  const vcId = sep >= 0 ? id.slice(0, sep) : id;
  const moref = sep >= 0 ? id.slice(sep + 1) : '';
  const vc = loadVcenterConfig().vcenters.find((v) => v.id === vcId);
  if (!vc) return res.status(404).json({ ok: false, reason: 'vCenter 설정을 찾을 수 없습니다.' });
  try {
    res.json(await fetchVmMetric(vc, moref, type, interval, { start, end }));
  } catch (err) {
    res.status(502).json({ ok: false, reason: err.message });
  }
});

// ESXi 호스트 성능 — CPU/메모리/디스크/네트워크 실시간 + 기간 조회(VM과 동일 방식).
//   /hosts/:id/metrics?type=cpu|mem|disk|net&interval=realtime|day|week|month|year
api.get('/hosts/:id/metrics', async (req, res) => {
  const id = req.params.id;
  const type = METRIC_TYPES.includes(req.query.type) ? req.query.type : 'cpu';
  const interval = PERF_INTERVALS[req.query.interval] ? req.query.interval : 'realtime';
  const start = req.query.start && !Number.isNaN(Date.parse(req.query.start)) ? req.query.start : null;
  const end = req.query.end && !Number.isNaN(Date.parse(req.query.end)) ? req.query.end : null;

  const snap = store.get();
  const host = (snap.hosts || []).find((h) => h.id === id);
  if (!host) return res.status(404).json({ ok: false, reason: '호스트를 찾을 수 없습니다.' });
  if (!inUserScope(req.user, snap, host.vcenterId)) return res.status(404).json({ ok: false, reason: '호스트를 찾을 수 없습니다.' });

  if (snap.source === 'mock') return res.json(synthMetric(host, type, interval, { start, end }));

  const sep = id.indexOf(':');
  const vcId = sep >= 0 ? id.slice(0, sep) : id;
  const moref = sep >= 0 ? id.slice(sep + 1) : '';
  const vc = loadVcenterConfig().vcenters.find((v) => v.id === vcId);
  if (!vc) return res.status(404).json({ ok: false, reason: 'vCenter 설정을 찾을 수 없습니다.' });
  try {
    res.json(await fetchHostMetric(vc, moref, type, interval, { start, end }));
  } catch (err) {
    res.status(502).json({ ok: false, reason: err.message });
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
  if (snap.source === 'mock') {
    return res.json({ ok: true, mock: true, vmName: vm.name, reason: '데모 모드입니다. 실제 vCenter(live) 연결 시 VMRC/웹 콘솔 링크가 생성됩니다.' });
  }
  const sep = id.indexOf(':');
  const vcId = sep >= 0 ? id.slice(0, sep) : id;
  const moref = sep >= 0 ? id.slice(sep + 1) : '';
  const vc = loadVcenterConfig().vcenters.find((v) => v.id === vcId);
  if (!vc) return res.status(404).json({ ok: false, reason: 'vCenter 설정을 찾을 수 없습니다.' });
  try {
    const c = await getVmConsole(vc, moref, vm.name);
    res.json({ ...c, vmName: vm.name });
  } catch (err) {
    res.status(502).json({ ok: false, reason: err.message });
  }
});

// Real iDRAC power for one host (current + history). Used by the host detail
// popup. ?name=<esxi host name>&hours=24
// v2.313 보안 감사 반영: 형제 단건 라우트(/hosts/:id/metrics·/vms/:id/console)는 inUserScope
// 위반 시 404 를 반환하는데 이 라우트만 name→hostPower 직행이라, scope 제한 계정이 범위 밖
// ESXi 호스트명을 알면 전력·하드웨어 메타를 조회할 수 있었다. 스냅샷에서 name 으로 호스트를
// 찾아 소유 vCenter 가 범위 밖이면 존재를 숨기고 404(server/CLAUDE.md id 단건 scope 규칙).
api.get('/idrac/host-power', async (req, res) => {
  const name = req.query.name;
  if (!name) return res.status(400).json({ matched: false, reason: 'name이 필요합니다.' });
  const snap = store.get();
  const host = (snap.hosts || []).find((h) => h.name === String(name));
  // 범위 제한 계정: 매칭 호스트가 없거나(그 이름이 스냅샷에 없음) 범위 밖이면 404(존재 은닉).
  if (scopedVcenterIds(req.user, snap) && !(host && inUserScope(req.user, snap, host.vcenterId))) {
    return res.status(404).json({ matched: false, reason: '호스트를 찾을 수 없습니다.' });
  }
  try {
    const hours = Math.min(720, Math.max(1, Number(req.query.hours) || 24));
    const serviceTag = req.query.serviceTag ? String(req.query.serviceTag) : '';
    res.json(await hostPower(String(name), { hours, serviceTag }));
  } catch (err) {
    res.status(500).json({ matched: false, reason: err.message });
  }
});
}
