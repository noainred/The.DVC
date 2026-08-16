// 하드웨어/ESXi/GPU 인벤토리·시계열 export·IP핑 — api.js(구 2,445줄) 분할(v2.283.0). 본문은 원본 그대로, 등록 순서는 api.js 호출 순서가 보존한다.
import { requirePerm } from '../../auth/auth.js';
import { scopedVcenterIds, inUserScope } from '../../auth/scope.js';
import { guardCell } from '../../util/csv.js';
import { store } from '../../store.js';
import { config } from '../../config.js';
import { getMetricsDb } from '../../metrics/db.js';
import { sendMaybeZip } from '../../util/zip.js';
import { getGuestGpuVms } from '../../gpu/store.js';
import { enqueuePing, getPingResults, setPingResults } from '../../central/pingJobs.js';
import { pingMany } from '../../util/ping.js';


// GPU inventory per host + aggregate counts by model and vCenter.
// GPU 인벤토리 집계(호스트별 GPU 장수·모드·사용률·할당 VM) — /tools/gpu 와 CSV/JSON export 공용.
function buildGpuInventory(snap, vcenterId, allowed = null) {
  let hosts = snap.hosts;
  if (allowed) hosts = hosts.filter((h) => allowed.has(h.vcenterId));  // 사용자 scope 선강제
  if (vcenterId) hosts = hosts.filter((h) => h.vcenterId === vcenterId);
  // 스코프 밖 VM(할당 VM 이름·게스트 오버레이·GPU VM 수)이 새지 않게 vms 도 allowed 로 거른다.
  const scopedVms = allowed ? (snap.vms || []).filter((v) => allowed.has(v.vcenterId)) : (snap.vms || []);
  const hostsWithGpu = [];
  const byModel = {};
  const byVcenter = {};
  const byMode = { vgpu: 0, passthrough: 0, vsga: 0 };
  let totalGpus = 0;
  // GPU가 할당된 VM을 호스트(이름)별로 집계 — 각 GPU 호스트에 몇 개 VM이 GPU를 쓰는지.
  const gpuVmByHost = {};
  for (const v of scopedVms) {
    if (!v.gpu || !v.host) continue;
    const e = gpuVmByHost[v.host] || { vms: 0, on: 0, off: 0, vgpu: 0, passthrough: 0, names: [] };
    e.vms++; e.vgpu += v.gpu.vgpu || 0; e.passthrough += v.gpu.passthrough || 0;
    if (v.powerState === 'POWERED_ON') e.on++; else e.off++;
    if (v.name) e.names.push({ name: v.name, on: v.powerState === 'POWERED_ON' });
    gpuVmByHost[v.host] = e;
  }
  // 게스트 수집 사용률은 '전원 ON GPU VM'만 집계(전원 OFF VM의 stale 값 제외) → 호스트(이름)별 평균.
  const onGpuVmIds = new Set(scopedVms.filter((v) => v.gpu && v.powerState === 'POWERED_ON').map((v) => v.id));
  const guestUtilByHost = new Map(); // hostName -> [utilPct...]
  for (const g of getGuestGpuVms()) {
    if (!onGpuVmIds.has(g.vmId) || g.utilPct == null) continue;
    const arr = guestUtilByHost.get(g.host) || []; arr.push(g.utilPct); guestUtilByHost.set(g.host, arr);
  }
  for (const h of hosts) {
    const gpus = h.gpus || [];
    if (!gpus.length) continue;
    totalGpus += gpus.length;
    // 한 호스트에 모드가 섞일 수 있으므로 대표 모드(가장 많은 것) + 개수 분포를 함께 제공.
    const modes = {};
    for (const g of gpus) { const md = g.mode || (g.vgpuMode ? 'vgpu' : 'passthrough'); modes[md] = (modes[md] || 0) + 1; byMode[md] = (byMode[md] || 0) + 1; }
    const primaryMode = Object.entries(modes).sort((a, b) => b[1] - a[1])[0][0];
    // ESXi가 사용률을 못 보는 패스쓰루 호스트는 게스트 OS 수집 오버레이로 보완(전원 ON VM만).
    const gu = guestUtilByHost.get(h.name);
    const guestUtil = gu && gu.length ? Math.round(gu.reduce((a, b) => a + b, 0) / gu.length) : null;
    const utilPct = h.gpuUtilPct ?? guestUtil;
    const vmAlloc = gpuVmByHost[h.name] || { vms: 0, on: 0, off: 0, vgpu: 0, passthrough: 0, names: [] };
    hostsWithGpu.push({
      id: h.id, host: h.name, vcenterId: h.vcenterId, cluster: h.cluster, count: gpus.length,
      model: gpus[0].model, memGB: gpus[0].memGB, mode: primaryMode, modes,
      vgpu: primaryMode === 'vgpu', utilPct, utilSource: h.gpuUtilPct != null ? 'esxi' : (guestUtil != null ? 'guest' : null),
      assignedVms: vmAlloc.vms, assignedVmsOn: vmAlloc.on || 0, assignedVmsOff: vmAlloc.off || 0, assignedVmNames: vmAlloc.names || [],
    });
    for (const g of gpus) {
      byModel[g.model] = (byModel[g.model] || 0) + 1;
      byVcenter[h.vcenterId] = (byVcenter[h.vcenterId] || 0) + 1;
    }
  }
  const utils = hostsWithGpu.map((x) => x.utilPct).filter((x) => x != null);
  // GPU를 사용하는 VM 수(스코프 내, 템플릿 제외) — 상단 요약용.
  const gpuVmCount = scopedVms.filter((v) => v.gpu && !v.template && (!vcenterId || v.vcenterId === vcenterId)).length;
  return {
    totalGpus,
    hostsWithGpu: hostsWithGpu.length,
    gpuVmCount,
    utilReporting: utils.length,
    avgUtilPct: utils.length ? Math.round(utils.reduce((a, b) => a + b, 0) / utils.length) : null,
    byMode,
    byModel: Object.entries(byModel).map(([model, count]) => ({ model, count })).sort((a, b) => b.count - a.count),
    byVcenter: Object.entries(byVcenter).map(([vcenterId, count]) => ({ vcenterId, count })).sort((a, b) => b.count - a.count),
    items: hostsWithGpu.sort((a, b) => b.count - a.count),
  };
}

// GPU 사용률 '수집된 전체 데이터' export — 시계열(샘플마다 한 행). range=all(수집 시작~현재)
// 또는 range=days(최근 N일). vcenterId로 법인 스코프. format은 .csv/.json.
async function gpuSeriesExport(req, res, fmt) {
  const range = req.query.range === 'days' ? 'days' : 'all';
  const days = Math.max(1, Math.min(1830, Number(req.query.days) || 30));
  const vcId = req.query.vcenterId || null;
  const snap = store.get();
  const allowed = scopedVcenterIds(req.user, snap); // null=무제한. 범위 밖 vCenter 의 GPU 시계열 유출 차단.
  const hostMap = new Map(); // host.id -> {name,vcenterId,cluster}
  for (const h of snap.hosts || []) hostMap.set(h.id, h);
  const db = await getMetricsDb();
  const meta = db.meta('gpu_util');
  const until = Date.now();
  const since = range === 'days' ? until - days * 86_400_000 : (meta.firstTs ?? 0);
  // 대량 dump를 한 번에 하지 않는다 — 1M행 동기 조회+매핑은 이벤트 루프를 ~10초 정지시켰다(실측).
  // ts 윈도우 청크(5만 행)로 나눠 조회하고 청크 사이 setImmediate로 양보해 폴링/API가 굶지 않게 한다.
  const MAX_ROWS = Math.max(1000, Number(process.env.GPU_EXPORT_MAX_ROWS) || 300_000);
  const CHUNK = 50_000;
  const out = [];
  // gpu_util은 %(0~100). 과거 일부 샘플이 vSphere 1/100% 단위로 ×100 저장된 경우가 있어
  // 100 초과면 ÷100로 정규화하고 0~100으로 클램프(util 최대 100이라 안전).
  const normPct = (v) => { const n = Number(v); if (!Number.isFinite(n)) return 0; const p = n > 100 ? n / 100 : n; return Math.max(0, Math.min(100, Math.round(p))); };
  let cursor = since;
  let truncated = false;
  while (out.length < MAX_ROWS) {
    const chunk = db.dump('gpu_util', cursor, until, CHUNK);
    if (!chunk.length) break;
    let rows = chunk;
    if (chunk.length === CHUNK) {
      // 경계 ts의 행이 청크에 걸쳐 잘릴 수 있어, 마지막 ts 행들은 버리고 다음 청크(since=그 ts)에서
      // 다시 읽는다(중복/누락 없이 페이지네이션 — 동일 ts 행 수는 호스트 수 이하라 항상 CHUNK 미만).
      const lastTs = chunk[chunk.length - 1].ts;
      rows = chunk.filter((r) => r.ts < lastTs);
      cursor = lastTs;
    }
    for (const r of rows) {
      const h = hostMap.get(r.k);
      if (allowed && !allowed.has(h?.vcenterId || '')) continue; // scope 밖(미상 호스트 포함) 제외
      if (vcId && (!h || h.vcenterId !== vcId)) continue;
      out.push({ ts: r.ts, host: h?.name || r.k, vcenterId: h?.vcenterId || '', cluster: h?.cluster || '', utilPct: normPct(r.v) });
      if (out.length >= MAX_ROWS) { truncated = true; break; }
    }
    if (chunk.length < CHUNK) break;
    await new Promise((r) => setImmediate(r)); // 청크 사이 이벤트 루프 양보
  }
  const stamp = new Date().toISOString().slice(0, 10);
  const sinceIso = meta.firstTs ? new Date(meta.firstTs).toISOString() : '없음';
  if (fmt === 'json') {
    const body = JSON.stringify({
      generatedAt: new Date().toISOString(), collectedSince: meta.firstTs ? new Date(meta.firstTs).toISOString() : null,
      range, days: range === 'days' ? days : null, vcenterId: vcId, sampleCount: out.length, truncated,
      points: out.map((p) => ({ ...p, tsIso: new Date(p.ts).toISOString() })),
    }, null, 2);
    sendMaybeZip(res, `gpu-history-${range}-${stamp}.json`, body, 'application/json; charset=utf-8');
    return;
  }
  const esc = (v) => { const s = guardCell(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }; // guardCell: 수식 인젝션 방어(= + - @)
  const head = ['timestamp_iso', 'epoch_ms', 'host', 'vcenter_id', 'cluster', 'gpu_util_pct'];
  const lines = [
    `# GPU 사용률 수집 데이터 — 수집 시작: ${sinceIso} (그날부터 누적) | 범위: ${range === 'all' ? '전체' : `최근 ${days}일`} | 생성: ${new Date().toISOString()} | 샘플 ${out.length}${truncated ? ' (상한 도달 — 기간을 좁혀 다시 내보내세요)' : ''}`,
    '# 단위: gpu_util_pct = GPU 사용률 %(0~100) · epoch_ms = Unix epoch 밀리초(엑셀은 지수표기로 보일 수 있음) · timestamp_iso = ISO8601 시각',
    head.join(','),
  ];
  for (const p of out) lines.push([new Date(p.ts).toISOString(), p.ts, p.host, p.vcenterId, p.cluster, p.utilPct].map(esc).join(','));
  sendMaybeZip(res, `gpu-history-${range}-${stamp}.csv`, '﻿' + lines.join('\r\n'), 'text/csv; charset=utf-8'); // BOM for Excel
}

// 중앙에서 직접 ping 시도 후 결과 저장(에이전트 없이도 같은 망이면 즉시 결과). 실패 격리.
async function pingLocallyAndStore(vcenterId, ips) {
  const rows = await pingMany(ips, { timeoutMs: 1500 });
  // 도달한 것만 저장 — 중앙이 못 가는 IP는 alive=false로 덮어쓰지 않고 에이전트 보고를 기다림.
  const reachable = rows.filter((r) => r.alive);
  if (reachable.length) setPingResults(vcenterId, reachable);
}

export function registerHardwareGpu(api) {

// Host hardware (vendor/model) summary — per vendor, per model, and the
// vCenter × vendor × model breakdown ("어떤 법인에 어떤 모델 몇 대").
api.get('/tools/hardware', (req, res) => {
  const snap = store.get();
  let hosts = snap.hosts;
  const allowed = scopedVcenterIds(req.user, snap);
  if (allowed) hosts = hosts.filter((h) => allowed.has(h.vcenterId));
  if (req.query.vcenterId) hosts = hosts.filter((h) => h.vcenterId === req.query.vcenterId);
  const vcName = {};
  for (const vc of snap.vcenters || []) vcName[vc.id] = vc.name;
  const byVendor = {};
  const byModel = {};
  const combo = new Map(); // vcenter|vendor|model -> count
  for (const h of hosts) {
    const vendor = h.vendor || '미상';
    const model = h.model || '미상';
    byVendor[vendor] = (byVendor[vendor] || 0) + 1;
    byModel[`${vendor} ${model}`] = (byModel[`${vendor} ${model}`] || 0) + 1;
    const key = `${h.vcenterId}|${vendor}|${model}`;
    combo.set(key, (combo.get(key) || 0) + 1);
  }
  const items = [...combo.entries()].map(([k, count]) => {
    const [vcenterId, vendor, model] = k.split('|');
    return { vcenterId, vcenterName: vcName[vcenterId] || vcenterId, vendor, model, count };
  }).sort((a, b) => b.count - a.count);
  res.json({
    hosts: hosts.length,
    byVendor: Object.entries(byVendor).map(([vendor, count]) => ({ vendor, count })).sort((a, b) => b.count - a.count),
    byModel: Object.entries(byModel).map(([model, count]) => ({ model, count })).sort((a, b) => b.count - a.count),
    items,
  });
});

// ESXi version distribution + host list (optionally per vCenter).
api.get('/tools/esxi', (req, res) => {
  const snap = store.get();
  let hosts = snap.hosts;
  const allowed = scopedVcenterIds(req.user, snap);
  if (allowed) hosts = hosts.filter((h) => allowed.has(h.vcenterId));
  if (req.query.vcenterId) hosts = hosts.filter((h) => h.vcenterId === req.query.vcenterId);
  const map = new Map();
  for (const h of hosts) {
    const v = h.version || 'unknown';
    if (!map.has(v)) map.set(v, { version: v, count: 0 });
    map.get(v).count++;
  }
  res.json({
    scanned: hosts.length,
    versions: [...map.values()].sort((a, b) => b.count - a.count),
    items: hosts.map((h) => ({ host: h.name, vcenterId: h.vcenterId, cluster: h.cluster, version: h.version || 'unknown', build: h.build || '', connectionState: h.connectionState })),
  });
});

api.get('/tools/gpu', (req, res) => {
  const snap = store.get();
  res.json(buildGpuInventory(snap, req.query.vcenterId, scopedVcenterIds(req.user, snap)));
});

// GPU 사용량/인벤토리 JSON export — 집계 결과 그대로 파일로 내려받기.
api.get('/tools/gpu.json', (req, res) => {
  const snap = store.get();
  const data = buildGpuInventory(snap, req.query.vcenterId, scopedVcenterIds(req.user, snap));
  const body = JSON.stringify({ generatedAt: new Date().toISOString(), vcenterId: req.query.vcenterId || null, ...data }, null, 2);
  sendMaybeZip(res, `gpu-${new Date().toISOString().slice(0, 10)}.json`, body, 'application/json; charset=utf-8');
});

// GPU 사용량/인벤토리 CSV export — 호스트별 한 행(모델·장수·모드·사용률·할당 VM).
api.get('/tools/gpu.csv', (req, res) => {
  const snap = store.get();
  const data = buildGpuInventory(snap, req.query.vcenterId, scopedVcenterIds(req.user, snap));
  const head = ['host', 'vcenter_id', 'cluster', 'gpu_model', 'gpu_count', 'mem_gb', 'mode', 'mode_breakdown', 'util_pct', 'util_source', 'assigned_vms'];
  const esc = (v) => { const s = guardCell(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }; // guardCell: 수식 인젝션 방어(= + - @)
  const lines = [head.join(',')];
  for (const r of data.items) {
    const breakdown = Object.entries(r.modes || {}).map(([m, n]) => `${m}:${n}`).join(' ');
    lines.push([r.host, r.vcenterId, r.cluster, r.model, r.count, r.memGB, r.mode, breakdown,
      r.utilPct == null ? '' : r.utilPct, r.utilSource || '', r.assignedVms].map(esc).join(','));
  }
  sendMaybeZip(res, `gpu-${new Date().toISOString().slice(0, 10)}.csv`, '﻿' + lines.join('\r\n'), 'text/csv; charset=utf-8'); // BOM for Excel
});

// GPU 사용률 시계열 수집 메타 — '언제부터 데이터가 쌓였는지'(수집 시작/마지막/샘플 수).
// export 모달에서 사용자가 수집 시작 일시를 보고 전체/기간을 고르도록.
api.get('/tools/gpu/series-meta', async (req, res) => {
  try {
    const db = await getMetricsDb();
    const m = db.meta('gpu_util');
    res.json({ collectedSince: m.firstTs, latestAt: m.lastTs, sampleCount: m.count });
  } catch { res.json({ collectedSince: null, latestAt: null, sampleCount: 0 }); }
});
api.get('/tools/gpu/export.csv', (req, res) => gpuSeriesExport(req, res, 'csv'));
api.get('/tools/gpu/export.json', (req, res) => gpuSeriesExport(req, res, 'json'));

// VM IP Ping(위임) — 중앙은 VM 사설 IP에 직접 못 가므로, 그 vCenter 담당 에이전트가
// ping을 대행한다. POST로 요청 큐잉 → 에이전트가 인출/실행/보고 → GET으로 녹/적 조회.
// 중앙이 직접 수집하는 vCenter(에이전트 없음)는 중앙이 직접 ping해 즉시 결과를 채운다.
api.post('/tools/ip-ping', requirePerm('tools'), async (req, res) => {
  const vcenterId = String(req.body?.vcenterId || '').trim();
  const ips = Array.isArray(req.body?.ips) ? req.body.ips.map((s) => String(s).trim()).filter(Boolean).slice(0, 16) : [];
  if (!vcenterId || !ips.length) return res.status(400).json({ ok: false, reason: 'vcenterId·ips가 필요합니다.' });
  // v2.322 보안 감사: 범위 밖 vCenter 로 위임 ping(범위 밖 에이전트가 임의 IP 도달성 프로빙)
  // 차단 — 단건 라우트 규칙대로 범위 밖은 404(존재 은닉). 전체 범위 계정은 무영향.
  if (!inUserScope(req.user, store.get(), vcenterId)) return res.status(404).json({ ok: false, reason: 'not found' });
  enqueuePing(vcenterId, ips);
  // 에이전트가 없는(중앙 직접 수집) vCenter는 중앙에서 직접 ping 시도(같은 망일 때 즉시 결과).
  if (config.dataSource !== 'mock') pingLocallyAndStore(vcenterId, ips).catch(() => {});
  res.json({ ok: true, queued: ips.length });
});
api.get('/tools/ip-ping', requirePerm('tools'), (req, res) => {
  const vcenterId = String(req.query.vcenterId || '').trim();
  const ips = String(req.query.ips || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!vcenterId || !ips.length) return res.status(400).json({ ok: false, reason: 'vcenterId·ips가 필요합니다.' });
  if (!inUserScope(req.user, store.get(), vcenterId)) return res.status(404).json({ ok: false, reason: 'not found' });
  res.json({ ok: true, results: getPingResults(vcenterId, ips) });
});

// GPU가 할당된 VM 목록 — 어떤 VM이 어떤 방식(vGPU/패스쓰루)·프로파일로 GPU를 쓰는지.
// 선택 필터: vcenterId, host, mode(vgpu|passthrough|mixed), model(호스트 GPU 모델).
api.get('/tools/gpu/vms', (req, res) => {
  const snap = store.get();
  // 호스트명 → GPU 모델 매핑(모델 필터용)
  const hostModel = {};
  for (const h of snap.hosts) if ((h.gpus || []).length) hostModel[h.name] = h.gpus[0].model;
  let vms = (snap.vms || []).filter((v) => v.gpu);
  const allowed = scopedVcenterIds(req.user, snap);
  if (allowed) vms = vms.filter((v) => allowed.has(v.vcenterId));
  if (req.query.vcenterId) vms = vms.filter((v) => v.vcenterId === req.query.vcenterId);
  if (req.query.host) vms = vms.filter((v) => v.host === req.query.host);
  if (req.query.model) vms = vms.filter((v) => hostModel[v.host] === req.query.model);
  if (req.query.mode) vms = vms.filter((v) => v.gpu.type === req.query.mode || (req.query.mode === 'vgpu' && v.gpu.vgpu) || (req.query.mode === 'passthrough' && v.gpu.passthrough));
  // 게스트 OS(nvidia-smi)에서 수집한 VM별 GPU 사용률/메모리 오버레이(패스쓰루 GPU는 ESXi가 못 봄).
  const guestByVm = new Map(getGuestGpuVms().map((g) => [g.vmId, g]));
  res.json({
    total: vms.length,
    vms: vms.map((v) => {
      // 전원 OFF VM은 사용률 계산/표시에서 제외(이전에 수집된 stale 값 무시).
      const g = v.powerState === 'POWERED_ON' ? guestByVm.get(v.id) : null;
      return {
        id: v.id, name: v.name, vcenterId: v.vcenterId, host: v.host, cluster: v.cluster,
        powerState: v.powerState, model: hostModel[v.host] || '', gpu: v.gpu,
        guestUtilPct: g ? g.utilPct : null, guestMemPct: g ? (g.memUsedPct ?? null) : null, guestAt: g ? g.at : null,
      };
    }).sort((a, b) => (a.vcenterId === b.vcenterId
      ? String(a.name || '').localeCompare(String(b.name || ''))
      : String(a.vcenterId || '').localeCompare(String(b.vcenterId || '')))).slice(0, 5000),
  });
});
}
