/**
 * Prometheus/OpenTelemetry 호환 익스포터 — 수집한 지표를 표준 텍스트 포맷(/metrics)으로
 * 노출해 Grafana/Prometheus 등 기존 관측 스택과 연동한다. 인증은 선택(METRICS_EXPORT_TOKEN
 * 설정 시 ?token= 또는 Bearer 필요). 스냅샷 + 전력맵 + 게스트 GPU 오버레이를 게이지로 변환.
 */

import { Router } from 'express';
import { store } from '../store.js';
import { latestPowerByHostName } from '../idrac/service.js';
import { getGuestGpuAllHosts } from '../gpu/store.js';
import { tokenMatches } from '../util/secureCompare.js';

export const metricsExportRouter = Router();

const TOKEN = process.env.METRICS_EXPORT_TOKEN || '';
const lbl = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');

function line(name, labels, value) {
  if (value == null || !Number.isFinite(value)) return '';
  const l = Object.entries(labels).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}="${lbl(v)}"`).join(',');
  return `${name}{${l}} ${value}\n`;
}

metricsExportRouter.get('/', async (req, res) => {
  if (TOKEN) {
    // 기본은 Authorization 헤더만 허용 — ?token=은 프록시/접근로그/브라우저 히스토리에 토큰이
    // 남아 유출된다. 기존 Grafana 연동 호환이 필요하면 METRICS_ALLOW_QUERY_TOKEN=true로 옵트인.
    let t = (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!t && process.env.METRICS_ALLOW_QUERY_TOKEN === 'true') t = req.query.token || '';
    if (!tokenMatches(t, TOKEN)) return res.status(403).type('text/plain').send('# 403 토큰 불일치 (METRICS_EXPORT_TOKEN) — Authorization: Bearer 헤더 사용(쿼리 토큰은 METRICS_ALLOW_QUERY_TOKEN=true 시에만)\n');
  }
  const snap = store.get();
  let powerMap = new Map();
  try { powerMap = await latestPowerByHostName(); } catch { /* 전력 미수집 */ }
  const gpuHosts = getGuestGpuAllHosts();

  let out = '';
  const H = (name, help, type = 'gauge') => { out += `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n`; };

  // vCenter 가용성
  H('vmware_vcenter_up', 'vCenter 수집 상태(1=connected)');
  for (const v of snap.vcenters || []) out += line('vmware_vcenter_up', { vcenter: v.id, version: v.version }, v.status === 'connected' ? 1 : 0);

  // 호스트 지표
  H('vmware_host_cpu_percent', 'ESXi 호스트 CPU 사용률(%)');
  H('vmware_host_mem_percent', 'ESXi 호스트 메모리 사용률(%)');
  H('vmware_host_power_watts', 'ESXi 호스트 소비전력(W)');
  H('vmware_host_gpu_percent', 'ESXi 호스트 GPU 사용률(%, 게스트 오버레이 포함)');
  H('vmware_host_up', 'ESXi 호스트 연결 상태(1=connected)');
  for (const h of snap.hosts || []) {
    const labels = { vcenter: h.vcenterId, host: h.name, cluster: h.cluster };
    out += line('vmware_host_cpu_percent', labels, h.cpuUsagePct);
    out += line('vmware_host_mem_percent', labels, h.memUsagePct);
    out += line('vmware_host_up', labels, h.connectionState === 'CONNECTED' ? 1 : 0);
    const p = powerMap.get(String(h.name || '').toLowerCase());
    if (p?.watts != null) out += line('vmware_host_power_watts', labels, p.watts);
    const guest = gpuHosts.get(h.id);
    const gpuPct = h.gpuUtilPct ?? (guest ? guest.utilPct : null);
    if (gpuPct != null) out += line('vmware_host_gpu_percent', labels, gpuPct);
  }

  // 데이터스토어
  H('vmware_datastore_usage_percent', '데이터스토어 사용률(%)');
  H('vmware_datastore_capacity_bytes', '데이터스토어 용량(byte)');
  H('vmware_datastore_free_bytes', '데이터스토어 여유(byte)');
  for (const d of snap.datastores || []) {
    const labels = { vcenter: d.vcenterId, datastore: d.name, type: d.type };
    out += line('vmware_datastore_usage_percent', labels, d.usagePct);
    out += line('vmware_datastore_capacity_bytes', labels, (d.capacityGB || 0) * 1073741824);
    out += line('vmware_datastore_free_bytes', labels, (d.freeGB || 0) * 1073741824);
  }

  // 집계(per-vCenter VM 카운트)
  H('vmware_vm_count', 'vCenter별 VM 수');
  H('vmware_vm_powered_on', 'vCenter별 가동 VM 수');
  const byVc = new Map();
  for (const v of snap.vms || []) {
    if (v.template) continue;
    const g = byVc.get(v.vcenterId) || { total: 0, on: 0 };
    g.total++; if (v.powerState === 'POWERED_ON') g.on++;
    byVc.set(v.vcenterId, g);
  }
  for (const [vc, g] of byVc) { out += line('vmware_vm_count', { vcenter: vc }, g.total); out += line('vmware_vm_powered_on', { vcenter: vc }, g.on); }

  // 스크레이프 메타
  H('vmware_portal_build_info', '포탈 빌드 정보', 'gauge');
  out += line('vmware_portal_build_info', { source: snap.source }, 1);

  res.type('text/plain; version=0.0.4').send(out);
});
