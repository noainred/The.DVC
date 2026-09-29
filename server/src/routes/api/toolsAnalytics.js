// 인사이트·위협 탐지·GPU 이력 — api.js(구 2,445줄) 분할(v2.283.0). 본문은 원본 그대로, 등록 순서는 api.js 호출 순서가 보존한다.
import { scopedVcenterIds } from '../../auth/scope.js';
import { requirePerm } from '../../auth/auth.js'; // v2.479(감사 S-4)
import { store, usageReadable } from '../../store.js';
import { scanResultList, getIpHistoryMap } from '../../ipam/scanStore.js';
import { getClassifier } from '../../ipam/settings.js';
import { getMetricsDb } from '../../metrics/db.js';
import { loadMetricsSettings } from '../../metrics/settings.js';
import { numOrNull } from '../../util/numOrNull.js';

/** v2.655: GPU 추이 집계 단위(사용자 요청 "1분/10분/1시간/6시간 단위로"). 키는 화면과 같아야 한다(웹 GPU_HIST_BUCKETS). */
export const GPU_HIST_BUCKETS = Object.freeze({ '1m': 60_000, '10m': 600_000, '1h': 3_600_000, '6h': 21_600_000 });
/** 단위를 고른 조회의 점 상한 — 1분 × 2일(2,880) 이 들어가고 차트가 그릴 만한 크기. */
export const GPU_HIST_MAX_POINTS = 3000;
import { nsxStore } from '../../nsx/store.js';
import { memoJson, hash, scopeSlice, scopeKey } from './shared.js';
import { suggestSize } from '../../reports/rightsizing.js'; // v2.629 DATA2629-05: 과대 VM 은 초과분만
import { gpuHostKey } from './hardwareGpu.js'; // v2.598 VC2598-03 — (vCenter, 호스트) 키


// 위협 탐지 — (A) 텔레메트리 기반 + (B) NSX 분산 IDS 이벤트. 자사 인프라 방어 목적.
const RISKY_PORTS = { 21: 'FTP', 23: 'Telnet', 135: 'RPC', 139: 'NetBIOS', 445: 'SMB', 1433: 'MSSQL', 3306: 'MySQL', 3389: 'RDP', 5432: 'PostgreSQL', 5900: 'VNC', 6379: 'Redis', 9200: 'Elasticsearch', 27017: 'MongoDB', 11211: 'Memcached' };
const EOL_OS = [
  [/windows.*(\bxp\b|2000|2003|2008|vista|\b7\b|\bnt\b)/i, 'Windows (EOL)'],
  [/cent\s?os.*(\b5\b|\b6\b|\b7\b)/i, 'CentOS (EOL)'],
  [/red\s?hat.*(\b5\b|\b6\b|\b7\b)/i, 'RHEL (EOL)'],
  [/ubuntu.*(1[0-6]\.(04|10)|8\.04|9\.|0[0-9]\.)/i, 'Ubuntu (EOL)'],
  [/debian.*(\b[1-9]\b)\b/i, 'Debian old'],
];

export function registerToolsAnalytics(api) {

// 운영 인사이트 — 기존 스냅샷만으로 계산하는 모니터링 분석 묶음:
//  ② VM 라이트사이징(유휴/과대/과소)  ④ 클러스터 N+1(호스트 1대 장애 여력)
//  ⑧ 알람 핫스팟(심각도/엔티티/센터)   ⑩ GPU 유휴/낭비
api.get('/tools/insights', requirePerm('tools'), (req, res) => memoJson(req, res, 'tools-insights', (snap) => {
  // scopeSlice 가 사용자 scope + ?vcenterId 를 함께 적용(hosts/vms/alarms 스코프). extraKey 로 캐시도 분리.
  const scoped = scopeSlice(snap, req.user, req.query.vcenterId);
  const hosts = scoped.hosts;
  const vms = scoped.vms;
  const alarms = scoped.alarms || [];
  const on = vms.filter((v) => v.powerState === 'POWERED_ON');
  const r0 = (n, d = 0) => Number((n || 0).toFixed(d));
  const gb = (mb) => Math.round((mb || 0) / 1024);

  // ② 라이트사이징
  const slim = (v) => ({ name: v.name, vcenterId: v.vcenterId, host: v.host || '', cpuPct: v.cpuUsagePct ?? null, memPct: v.memUsagePct ?? null, vcpu: v.cpuCount || 0, ramGB: gb(v.memMB) });
  const idle = on.filter((v) => (v.cpuUsagePct ?? 100) < 5 && (v.memUsagePct ?? 100) < 20).map(slim);
  const oversized = on.filter((v) => (v.cpuCount || 0) >= 4 && (v.cpuUsagePct ?? 100) < 10 && !((v.cpuUsagePct ?? 100) < 5 && (v.memUsagePct ?? 100) < 20)).map(slim);
  const oversizeExcess = (v) => {
    const sz = suggestSize(v.vcpu || 0, v.ramGB || 0, v.cpuPct, v.memPct);
    return { vcpu: Math.max(0, (v.vcpu || 0) - sz.suggestedVcpu), ramGB: Math.max(0, (v.ramGB || 0) - sz.suggestedRamGB) };
  };
  const undersized = on.filter((v) => (v.cpuUsagePct ?? 0) > 85 || (v.memUsagePct ?? 0) > 90).map(slim);
  const rightsizing = {
    idleCount: idle.length, oversizedCount: oversized.length, undersizedCount: undersized.length,
    // v2.629(감사 DATA2629-05): 유휴 VM 은 할당 전량, 과대(oversized — CPU 만 본 판정) VM 은 reports/rightsizing.js suggestSize 의
    //   **초과분만** 더한다. 예전에는 메모리를 90% 쓰는 VM 의 RAM 전량까지 '회수 가능' 이었다(같은 이름의 숫자가 라이트사이징
    //   리포트와 뜻이 달랐다). 이 화면의 사용률은 **순간값**이다 — reclaimBasis 로 밝힌다.
    reclaimableVcpu: idle.reduce((a, v) => a + (v.vcpu || 0), 0) + oversized.reduce((a, v) => a + oversizeExcess(v).vcpu, 0),
    reclaimableRamGB: idle.reduce((a, v) => a + (v.ramGB || 0), 0) + oversized.reduce((a, v) => a + oversizeExcess(v).ramGB, 0),
    reclaimBasis: 'instant',
    idle: idle.slice(0, 200), oversized: oversized.slice(0, 200), undersized: undersized.slice(0, 200),
  };

  // ④ 클러스터 N+1 (가장 큰 호스트 1대 장애 시 잔여 용량으로 현재 사용량 수용 가능?)
  const cmap = new Map();
  for (const h of hosts) {
    const k = `${h.vcenterId}|${h.cluster || 'standalone'}`;
    const g = cmap.get(k) || { vcenterId: h.vcenterId, cluster: h.cluster || 'standalone', hosts: 0, readable: 0, excluded: 0, cpuMhz: 0, cpuUsed: 0, memMB: 0, memUsed: 0, maxCpu: 0, maxMem: 0 };
    g.hosts++;
    cmap.set(k, g);
    // v2.606(감사 WEB2606-02): 연결 끊긴·무응답 호스트는 사용량을 읽지 못했고(SOAP 이 0 을 싣는다) 부하를 받아 줄 수도
    // 없다 — '장애 후 잔여' 용량에 넣으면 N+1 이 여유라고 거짓 판정한다. 판정은 store.usageReadable 하나(v2.594).
    if (!usageReadable(h)) { g.excluded++; continue; }
    g.readable++; g.cpuMhz += h.cpuTotalMhz || 0; g.cpuUsed += h.cpuUsageMhz || 0; g.memMB += h.memTotalMB || 0; g.memUsed += h.memUsageMB || 0;
    g.maxCpu = Math.max(g.maxCpu, h.cpuTotalMhz || 0); g.maxMem = Math.max(g.maxMem, h.memTotalMB || 0);
  }
  const clusters = [...cmap.values()].map((g) => {
    const remCpu = g.cpuMhz - g.maxCpu, remMem = g.memMB - g.maxMem;
    const cpuOkPct = remCpu > 0 ? r0((g.cpuUsed / remCpu) * 100) : 999;
    const memOkPct = remMem > 0 ? r0((g.memUsed / remMem) * 100) : 999;
    const n1Ok = g.readable >= 2 && cpuOkPct <= 90 && memOkPct <= 90;
    return { vcenterId: g.vcenterId, cluster: g.cluster, hosts: g.hosts, hostsUsageExcluded: g.excluded, n1Ok, cpuAfterFailPct: cpuOkPct, memAfterFailPct: memOkPct,
      // 읽을 수 있는 호스트가 없으면 사용률은 null('—') — 0% 는 '부하 없음' 이라는 거짓이다.
      cpuUsagePct: g.cpuMhz ? r0((g.cpuUsed / g.cpuMhz) * 100) : null, memUsagePct: g.memMB ? r0((g.memUsed / g.memMB) * 100) : null };
  }).sort((a, b) => (a.n1Ok === b.n1Ok ? b.cpuAfterFailPct - a.cpuAfterFailPct : a.n1Ok ? 1 : -1));

  // ⑧ 알람 핫스팟
  const bySev = { critical: 0, warning: 0, info: 0 };
  const byEntity = new Map(); const byVc = new Map();
  for (const a of alarms) {
    const sev = (a.severity || 'info').toLowerCase(); bySev[sev] = (bySev[sev] || 0) + 1;
    const ent = a.entity || '(미상)'; byEntity.set(ent, (byEntity.get(ent) || 0) + 1);
    byVc.set(a.vcenterId || '', (byVc.get(a.vcenterId || '') + 1 || 1));
  }
  const alarmHotspot = {
    total: alarms.length, bySeverity: bySev,
    topEntities: [...byEntity.entries()].map(([entity, count]) => ({ entity, count })).sort((a, b) => b.count - a.count).slice(0, 20),
    byVcenter: [...byVc.entries()].map(([vcenterId, count]) => ({ vcenterId, count })).sort((a, b) => b.count - a.count),
  };

  // ⑩ GPU 유휴/낭비 (ESXi 보고 사용률 기준)
  const gpuHosts = hosts.filter((h) => (h.gpus || []).length);
  // v2.598 VC2598-03: 호스트 이름 단독 키는 다른 vCenter 의 같은 이름 호스트 VM 을 섞는다 — (vCenter, 이름).
  const gpuVmByHost = new Map();
  for (const v of vms) if (v.gpu && v.host) { const k = gpuHostKey(v.vcenterId, v.host); gpuVmByHost.set(k, (gpuVmByHost.get(k) || 0) + 1); }
  const idleGpu = gpuHosts.filter((h) => h.gpuUtilPct != null && h.gpuUtilPct < 10)
    .map((h) => ({ host: h.name, vcenterId: h.vcenterId, model: h.gpus[0].model, count: h.gpus.length, util: h.gpuUtilPct, assignedVms: gpuVmByHost.get(gpuHostKey(h.vcenterId, h.name)) || 0 }))
    .sort((a, b) => a.util - b.util);
  const gpuWaste = {
    totalGpuHosts: gpuHosts.length, totalGpus: gpuHosts.reduce((a, h) => a + h.gpus.length, 0),
    idleHostCount: idleGpu.length, idleGpus: idleGpu.reduce((a, x) => a + x.count, 0),
    unreporting: gpuHosts.filter((h) => h.gpuUtilPct == null).length, list: idleGpu.slice(0, 100),
  };

  return { generatedAt: snap.generatedAt, rightsizing, clusters, alarmHotspot, gpuWaste };
}, { extraKey: scopeKey(req.user, store.get()) }));
api.get('/tools/threats', requirePerm('tools'), (req, res) => memoJson(req, res, 'tools-threats', (snap) => {
  const vc = req.query.vcenterId;
  const allowed = scopedVcenterIds(req.user, snap);
  // VM 기반(mining/eol)은 사용자 scope 로 거른다. 스캔/NSX-IDS 는 vCenter 귀속이 없는 조직 전역
  // 네트워크 관측이라 범위 제한 계정에는 노출하지 않는다(deep-search 의 scanItems 정책과 동일).
  const vms = scopeSlice(snap, req.user, vc).vms;
  const on = vms.filter((v) => v.powerState === 'POWERED_ON');
  const classify = getClassifier();
  const slim = (v) => ({ name: v.name, vcenterId: v.vcenterId, host: v.host || '', cpuPct: v.cpuUsagePct ?? null, memPct: v.memUsagePct ?? null });

  // A1) 크립토마이닝 의심 — 고CPU 지속(현재 스냅샷 기준; 사용률 미보고는 제외)
  const mining = on.filter((v) => (v.cpuUsagePct ?? -1) >= 90).map(slim).sort((a, b) => (b.cpuPct || 0) - (a.cpuPct || 0));

  // A2) EOL/취약 OS
  const eol = vms.map((v) => { const m = EOL_OS.find(([re]) => re.test(v.guestOS || '')); return m ? { ...slim(v), os: v.guestOS, reason: m[1] } : null; }).filter(Boolean);

  // A3) 위험 포트 노출(스캔 결과) — 공인 노출이면 high. 범위 제한 계정에는 스캔 결과를 노출하지 않는다.
  const scan = allowed ? [] : scanResultList();
  const risky = scan.map((s) => {
    const hits = (s.openPorts || []).filter((p) => RISKY_PORTS[p]);
    if (!hits.length) return null;
    const pub = classify(s.ip) === 'public';
    return { ip: s.ip, hostname: s.hostname || '', ports: hits.map((p) => `${p}/${RISKY_PORTS[p]}`), public: pub, severity: pub ? 'high' : 'medium' };
  }).filter(Boolean).sort((a, b) => (b.public - a.public) || (b.ports.length - a.ports.length));

  // A4) 신규 rogue IP — vCenter가 모르고, 최근 7일 내 처음 스캔된 IP
  const known = new Set();
  for (const v of (snap.vms || [])) { const ips = v.ipAddresses?.length ? v.ipAddresses : (v.ipAddress ? [v.ipAddress] : []); for (const ip of ips) known.add(ip); }
  for (const h of (snap.hosts || [])) known.add(h.name);
  const hist = getIpHistoryMap();
  const cut = Date.now() - 7 * 86_400_000;
  const rogue = scan.filter((s) => !known.has(s.ip) && (hist[s.ip]?.firstSeen || 0) > cut)
    .map((s) => ({ ip: s.ip, hostname: s.hostname || '', firstSeen: hist[s.ip]?.firstSeen || null, ports: (s.openPorts || []), services: s.services || [] }))
    .sort((a, b) => (b.firstSeen || 0) - (a.firstSeen || 0));

  // B) NSX 분산 IDS 이벤트(있으면) — 조직 전역이라 범위 제한 계정에는 노출하지 않는다.
  const nsx = nsxStore.get();
  let idsEvents = allowed ? [] : (nsx.idsEvents || []);
  const idsManagers = allowed ? [] : (nsx.managers || []).map((m) => ({ name: m.name, enabled: m.idsEnabled ?? null, // v2.603(감사 COL-2603-05 후속): 조회 실패는 null 이다(서버 nsx/client.js 가 싣는다) — `|| 0` 이 '프로파일 0개' 라는 거짓으로 되돌렸다.
    profiles: m.idsProfiles ?? null, events: m.idsEventCount ?? null, ...(m.idsEventsTruncated ? { eventsTruncated: true } : {}) }));
  // v2.631(감사 AX2-04): 합계는 **자르기 전 전량**으로 센다 — 예전엔 500건으로 자른 뒤 세어 매니저 3곳 이상이면
  //   합계가 500 에 막히고 심각 건수가 앞쪽 매니저 것만 됐다. 목록은 심각도 우선(crit/high 먼저, 원래 순서 유지)으로
  //   정렬한 뒤 자르고, 뺀 개수를 밝힌다(조용한 상한 금지).
  const isCrit = (e) => /crit|high/i.test(String(e?.severity ?? ''));
  const IDS_LIST_MAX = 500;
  const idsTotal = idsEvents.length;
  const idsCriticalTotal = idsEvents.filter(isCrit).length;
  const idsSorted = idsEvents.map((e, i) => [isCrit(e) ? 0 : 1, i, e]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((r) => r[2]);
  const idsList = idsSorted.slice(0, IDS_LIST_MAX);
  const LIST_MAX = { mining: 200, eol: 300, risky: 300, rogue: 300 };
  const full = { mining, eol, risky, rogue };
  const omitted = {};
  for (const [k, max] of Object.entries(LIST_MAX)) if (full[k].length > max) omitted[k] = full[k].length - max;
  if (idsTotal > IDS_LIST_MAX) omitted.idsEvents = idsTotal - IDS_LIST_MAX;

  return {
    generatedAt: snap.generatedAt,
    summary: {
      mining: mining.length, eol: eol.length, riskyPublic: risky.filter((r) => r.public).length, riskyTotal: risky.length,
      rogue: rogue.length, idsEvents: idsTotal, idsCritical: idsCriticalTotal,
    },
    mining: mining.slice(0, LIST_MAX.mining), eol: eol.slice(0, LIST_MAX.eol), risky: risky.slice(0, LIST_MAX.risky), rogue: rogue.slice(0, LIST_MAX.rogue),
    ids: { managers: idsManagers, events: idsList, total: idsTotal, omitted: Math.max(0, idsTotal - IDS_LIST_MAX) },
    omitted,
  };
}, { extraKey: scopeKey(req.user, store.get()) }));

// GPU 사용률 히스토리(5년까지). level=host|cluster|vc, key=대상키, days=기간.
api.get('/tools/gpu/history', requirePerm('tools'), async (req, res) => {
  const level = ['host', 'cluster', 'vc', 'vm'].includes(req.query.level) ? req.query.level : 'host';
  // v2.650: 지표 선택 — util(사용률) · mem(메모리 점유 %) · temp(온도 ℃). 클러스터·법인 단위는 사용률만 있다.
  // v2.653: memmb(메모리 사용량 MB) 추가.
  const kind = ['util', 'mem', 'memmb', 'temp'].includes(req.query.metric) ? req.query.metric : 'util';
  const METRICS = {
    host: { util: 'gpu_util', mem: 'gpu_mem', memmb: 'gpu_mem_mb', temp: 'gpu_temp' },
    vm: { util: 'gpu_vm_util', mem: 'gpu_vm_mem', memmb: 'gpu_vm_mem_mb', temp: 'gpu_vm_temp' },
    cluster: { util: 'gpu_cluster' }, vc: { util: 'gpu_vc' },
  };
  const metric = METRICS[level][kind];
  if (!metric) return res.status(400).json({ ok: false, reason: `${level} 단위에는 ${kind} 추이가 없습니다(사용률만 있습니다).` });
  const unit = kind === 'temp' ? '℃' : kind === 'memmb' ? 'MB' : '%';
  const key = String(req.query.key || '');
  const days = Math.max(1, Math.min(1830, Number(req.query.days) || 7));
  // key 의 vCenter 귀속을 scope 로 검사(범위 밖 호스트/클러스터/vc GPU 히스토리 조회 차단).
  const allowedG = scopedVcenterIds(req.user, store.get());
  if (allowedG) {
    const snapG = store.get();
    const owns = level === 'vc' ? allowedG.has(key)
      : level === 'cluster' ? allowedG.has(key.split('|')[0])
        : level === 'vm' ? allowedG.has((snapG.vms || []).find((v) => v.id === key)?.vcenterId)
          : allowedG.has((snapG.hosts || []).find((h) => h.id === key)?.vcenterId);
    if (!owns) return res.json({ level, key, metric: kind, days, bucketMs: 0, unit, synthesized: false, points: [] });
  }
  const now = Date.now();
  const since = now - days * 86_400_000;
  // v2.655: 집계 단위를 고를 수 있다(1분·10분·1시간·6시간) — 안 고르면 예전처럼 기간으로 정한다.
  //   점 상한(GPU_HIST_MAX_POINTS)을 넘는 조합은 최근 쪽만 남기고 **잘렸다고 밝힌다**(truncated·coveredSince — 조용한 절단 금지).
  const pick = GPU_HIST_BUCKETS[req.query.bucket] || null;
  const bucketMs = pick || (days <= 2 ? 3_600_000 : days <= 14 ? 6 * 3_600_000 : days <= 120 ? 86_400_000 : days <= 800 ? 7 * 86_400_000 : 30 * 86_400_000);
  const limit = pick ? GPU_HIST_MAX_POINTS : 1000;
  let points = [];
  let cut = { truncated: false, coveredSince: null };
  try {
    const db = await getMetricsDb();
    const r = db.historyStep(metric, key, since, bucketMs, limit);
    points = r.points || []; cut = { truncated: !!r.truncated, coveredSince: r.coveredSince ?? null };
  } catch { points = []; }
  let synthesized = false;
  if (points.length < 2 && store.get().source === 'mock') {
    // 데모: 일과 시간대·요일 부하를 반영한 0~100% 합성 시계열.
    synthesized = true; points = [];
    const base = 25 + (hash(key + kind) % 30);
    const start = Math.max(since, now - (limit - 1) * bucketMs);
    cut = start > since ? { truncated: true, coveredSince: start } : { truncated: false, coveredSince: null };
    for (let t = start; t <= now; t += bucketMs) {
      const day = t / 86_400_000;
      let v = base + 22 * Math.abs(Math.sin(day / 9)) + 14 * Math.sin(day) + (hash(key + t) % 8);
      v = Math.max(0, Math.min(100, v));
      if (kind === 'temp') v = 32 + v * 0.45; // 데모: 32~77℃
      if (kind === 'memmb') v = v * 800; // 데모: 0~80,000MB
      points.push({ ts: Math.floor(t), avg: Number(v.toFixed(1)), min: Number(Math.max(0, v - 12).toFixed(1)), max: Number((kind === 'memmb' ? v * 1.1 : Math.min(100, v + 10)).toFixed(1)) });
    }
  }
  // 수집 주기(호스트 GPU 사용률 샘플 간격)보다 짧은 단위는 같은 값이 이어져 보일 수 있다 — 화면이 그 사실을 말한다.
  let sampleSec = null;
  try { sampleSec = numOrNull(loadMetricsSettings().gpuUtilIntervalSec); } catch { sampleSec = null; }
  res.json({ level, key, metric: kind, days, bucket: pick ? req.query.bucket : 'auto', bucketMs, limit, unit, synthesized, sampleSec, ...cut, points });
});
}
