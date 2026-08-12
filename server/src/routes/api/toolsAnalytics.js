// 인사이트·위협 탐지·GPU 이력 — api.js(구 2,445줄) 분할(v2.283.0). 본문은 원본 그대로, 등록 순서는 api.js 호출 순서가 보존한다.
import { scopedVcenterIds } from '../../auth/scope.js';
import { store } from '../../store.js';
import { scanResultList, getIpHistoryMap } from '../../ipam/scanStore.js';
import { getClassifier } from '../../ipam/settings.js';
import { getMetricsDb } from '../../metrics/db.js';
import { nsxStore } from '../../nsx/store.js';
import { memoJson, hash, scopeSlice, scopeKey } from './shared.js';


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
api.get('/tools/insights', (req, res) => memoJson(req, res, 'tools-insights', (snap) => {
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
  const undersized = on.filter((v) => (v.cpuUsagePct ?? 0) > 85 || (v.memUsagePct ?? 0) > 90).map(slim);
  const rightsizing = {
    idleCount: idle.length, oversizedCount: oversized.length, undersizedCount: undersized.length,
    reclaimableVcpu: [...idle, ...oversized].reduce((a, v) => a + (v.vcpu || 0), 0),
    reclaimableRamGB: [...idle, ...oversized].reduce((a, v) => a + (v.ramGB || 0), 0),
    idle: idle.slice(0, 200), oversized: oversized.slice(0, 200), undersized: undersized.slice(0, 200),
  };

  // ④ 클러스터 N+1 (가장 큰 호스트 1대 장애 시 잔여 용량으로 현재 사용량 수용 가능?)
  const cmap = new Map();
  for (const h of hosts) {
    const k = `${h.vcenterId}|${h.cluster || 'standalone'}`;
    const g = cmap.get(k) || { vcenterId: h.vcenterId, cluster: h.cluster || 'standalone', hosts: 0, cpuMhz: 0, cpuUsed: 0, memMB: 0, memUsed: 0, maxCpu: 0, maxMem: 0 };
    g.hosts++; g.cpuMhz += h.cpuTotalMhz || 0; g.cpuUsed += h.cpuUsageMhz || 0; g.memMB += h.memTotalMB || 0; g.memUsed += h.memUsageMB || 0;
    g.maxCpu = Math.max(g.maxCpu, h.cpuTotalMhz || 0); g.maxMem = Math.max(g.maxMem, h.memTotalMB || 0);
    cmap.set(k, g);
  }
  const clusters = [...cmap.values()].map((g) => {
    const remCpu = g.cpuMhz - g.maxCpu, remMem = g.memMB - g.maxMem;
    const cpuOkPct = remCpu > 0 ? r0((g.cpuUsed / remCpu) * 100) : 999;
    const memOkPct = remMem > 0 ? r0((g.memUsed / remMem) * 100) : 999;
    const n1Ok = g.hosts >= 2 && cpuOkPct <= 90 && memOkPct <= 90;
    return { vcenterId: g.vcenterId, cluster: g.cluster, hosts: g.hosts, n1Ok, cpuAfterFailPct: cpuOkPct, memAfterFailPct: memOkPct,
      cpuUsagePct: g.cpuMhz ? r0((g.cpuUsed / g.cpuMhz) * 100) : 0, memUsagePct: g.memMB ? r0((g.memUsed / g.memMB) * 100) : 0 };
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
  const gpuVmByHost = {};
  for (const v of vms) if (v.gpu && v.host) gpuVmByHost[v.host] = (gpuVmByHost[v.host] || 0) + 1;
  const idleGpu = gpuHosts.filter((h) => h.gpuUtilPct != null && h.gpuUtilPct < 10)
    .map((h) => ({ host: h.name, vcenterId: h.vcenterId, model: h.gpus[0].model, count: h.gpus.length, util: h.gpuUtilPct, assignedVms: gpuVmByHost[h.name] || 0 }))
    .sort((a, b) => a.util - b.util);
  const gpuWaste = {
    totalGpuHosts: gpuHosts.length, totalGpus: gpuHosts.reduce((a, h) => a + h.gpus.length, 0),
    idleHostCount: idleGpu.length, idleGpus: idleGpu.reduce((a, x) => a + x.count, 0),
    unreporting: gpuHosts.filter((h) => h.gpuUtilPct == null).length, list: idleGpu.slice(0, 100),
  };

  return { generatedAt: snap.generatedAt, rightsizing, clusters, alarmHotspot, gpuWaste };
}, { extraKey: scopeKey(req.user, store.get()) }));
api.get('/tools/threats', (req, res) => memoJson(req, res, 'tools-threats', (snap) => {
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
  const idsManagers = allowed ? [] : (nsx.managers || []).map((m) => ({ name: m.name, enabled: m.idsEnabled ?? null, profiles: m.idsProfiles || 0, events: m.idsEventCount || 0 }));
  const sev = (e) => e.severity;
  idsEvents = idsEvents.slice(0, 500);

  return {
    generatedAt: snap.generatedAt,
    summary: {
      mining: mining.length, eol: eol.length, riskyPublic: risky.filter((r) => r.public).length, riskyTotal: risky.length,
      rogue: rogue.length, idsEvents: idsEvents.length, idsCritical: idsEvents.filter((e) => /crit|high/.test(sev(e))).length,
    },
    mining: mining.slice(0, 200), eol: eol.slice(0, 300), risky: risky.slice(0, 300), rogue: rogue.slice(0, 300),
    ids: { managers: idsManagers, events: idsEvents },
  };
}, { extraKey: scopeKey(req.user, store.get()) }));

// GPU 사용률 히스토리(5년까지). level=host|cluster|vc, key=대상키, days=기간.
api.get('/tools/gpu/history', async (req, res) => {
  const level = ['host', 'cluster', 'vc'].includes(req.query.level) ? req.query.level : 'host';
  const metric = { host: 'gpu_util', cluster: 'gpu_cluster', vc: 'gpu_vc' }[level];
  const key = String(req.query.key || '');
  const days = Math.max(1, Math.min(1830, Number(req.query.days) || 7));
  // key 의 vCenter 귀속을 scope 로 검사(범위 밖 호스트/클러스터/vc GPU 히스토리 조회 차단).
  const allowedG = scopedVcenterIds(req.user, store.get());
  if (allowedG) {
    const snapG = store.get();
    const owns = level === 'vc' ? allowedG.has(key)
      : level === 'cluster' ? allowedG.has(key.split('|')[0])
        : allowedG.has((snapG.hosts || []).find((h) => h.id === key)?.vcenterId);
    if (!owns) return res.json({ level, key, days, bucketMs: 0, unit: '%', synthesized: false, points: [] });
  }
  const since = Date.now() - days * 86_400_000;
  const bucketMs = days <= 2 ? 3_600_000 : days <= 14 ? 6 * 3_600_000 : days <= 120 ? 86_400_000 : days <= 800 ? 7 * 86_400_000 : 30 * 86_400_000;
  let points = [];
  try { const db = await getMetricsDb(); points = db.history(metric, key, since, bucketMs, 1000); } catch { points = []; }
  let synthesized = false;
  if (points.length < 2 && store.get().source === 'mock') {
    // 데모: 일과 시간대·요일 부하를 반영한 0~100% 합성 시계열.
    synthesized = true; points = [];
    const base = 25 + (hash(key) % 30);
    for (let t = since; t <= Date.now(); t += bucketMs) {
      const day = t / 86_400_000;
      let v = base + 22 * Math.abs(Math.sin(day / 9)) + 14 * Math.sin(day) + (hash(key + t) % 8);
      v = Math.max(0, Math.min(100, v));
      points.push({ ts: Math.floor(t), avg: Number(v.toFixed(1)), min: Number(Math.max(0, v - 12).toFixed(1)), max: Number(Math.min(100, v + 10).toFixed(1)) });
    }
  }
  res.json({ level, key, days, bucketMs, unit: '%', synthesized, points });
});
}
