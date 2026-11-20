/**
 * Prometheus/OpenTelemetry 호환 익스포터 — 수집한 지표를 표준 텍스트 포맷(/metrics)으로
 * 노출해 Grafana/Prometheus 등 기존 관측 스택과 연동한다. 인증은 선택(METRICS_EXPORT_TOKEN
 * 설정 시 ?token= 또는 Bearer 필요). 스냅샷 + 전력맵 + 게스트 GPU 오버레이를 게이지로 변환.
 */

import { Router } from 'express';
import { store, usageReadable } from '../store.js';
import { numOrNull } from '../util/numOrNull.js';
import { unreadVcenterReasons } from '../metrics/unreadVcenters.js';   // 122회차: '지금 값' 으로 쓰지 않는 vCenter(지표 샘플러와 같은 판정)
import { latestPowerByHostName } from '../idrac/service.js';
import { getGuestGpuAllHosts } from '../gpu/store.js';
import { tokenMatches } from '../util/secureCompare.js';

import { wrapAsyncRouter } from '../util/asyncRoute.js';
export const metricsExportRouter = Router();
// v2.574 BUG-03: express 4 는 async 핸들러의 throw 를 잡지 않아 그 요청이 **응답 없이
// 매달린다**(소켓 fd 가 잡힌다). 라우트를 등록하기 **전에** 감싸 전역 에러 핸들러로 보낸다.
// ⚠ 라우트 등록보다 아래로 옮기지 말 것 — 그 뒤에 등록된 것만 보호된다.
wrapAsyncRouter(metricsExportRouter);

const TOKEN = process.env.METRICS_EXPORT_TOKEN || '';
const lbl = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');

function line(name, labels, value) {
  if (value == null || !Number.isFinite(value)) return '';
  const l = Object.entries(labels).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}="${lbl(v)}"`).join(',');
  return `${name}{${l}} ${value}\n`;
}

metricsExportRouter.get('/', async (req, res) => {
  // 보안(감사 M18): 토큰 미설정 시 과거엔 전체 인벤토리(호스트/VM/전력 토폴로지)가 무인증
  // 공개였다. 이제 기본 비활성(404) — 무인증 공개가 정말 필요하면 METRICS_ALLOW_ANON=true 옵트인.
  if (!TOKEN && process.env.METRICS_ALLOW_ANON !== 'true') {
    return res.status(404).type('text/plain')
      .send('# /metrics 비활성 — METRICS_EXPORT_TOKEN을 설정하고 Authorization: Bearer로 접근하세요(무인증 공개는 METRICS_ALLOW_ANON=true 옵트인).\n');
  }
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
  for (const v of snap.vcenters || []) {
    // v2.675: 기동 직후 골격(snap.initial — 첫 병합 전)의 '첫 수집 중' vCenter 는 내보내지 않는다. 예전에는 이 구간에 목록이 비어
    //   아무 줄도 없었다 — 0 으로 내보내면 외부 감시가 재시작마다 'vCenter 다운' 경보를 낸다(모르는 것을 0 으로 말하지 않는다).
    if (snap.initial && v.status === 'pending') continue;
    out += line('vmware_vcenter_up', { vcenter: v.id, version: v.version }, v.status === 'connected' ? 1 : 0);
  }

  // 122회차(116 F2 반증 — 재현): 수집이 멈춘 vCenter(점검중 · 수집 실패 이월 · 위임 push 끊김 — metrics/unreadVcenters.js)의 호스트 사용률 · 데이터스토어
  //   용량은 **마지막으로 읽은 값**이다(store 가 수집 실패는 최대 LASTGOOD_HOLD_MS, 점검중 · 위임 push 끊김은 기한 없이 이어 서빙한다). 그대로 내보내면
  //   외부 감시가 그 평탄선을 지금 값으로 읽는다 — 위임 vCenter 는 상태가 connected 그대로라 vmware_vcenter_up 도 1 이었다(끊긴 줄 알 길이 없었다).
  //   이 포탈의 지표 샘플러(v2.620 SRV2620-03)와 같은 판정으로 그 시계열을 내지 않는다. 연결 상태 · VM 수(인벤토리)는 예전 그대로 낸다.
  const unreadVc = unreadVcenterReasons(snap);
  // 값이 없는 것과 0 은 다르다 — 결측은 시계열을 내지 않으므로(Prometheus 규약) 외부 경보는 absent() 로 함께 봐야 한다. HELP 에 적는다.
  const ABSENT = ' — 지금 값을 못 읽으면 이 시계열을 내지 않는다(0 이 아니다 · absent 로 감시)';

  // 호스트 지표
  H('vmware_host_cpu_percent', `ESXi 호스트 CPU 사용률(%)${ABSENT}`);
  H('vmware_host_mem_percent', `ESXi 호스트 메모리 사용률(%)${ABSENT}`);
  H('vmware_host_power_watts', 'ESXi 호스트 소비전력(W)');
  H('vmware_host_gpu_percent', 'ESXi 호스트 GPU 사용률(%, 게스트 오버레이 포함)');
  H('vmware_host_up', 'ESXi 호스트 연결 상태(1=connected)');
  for (const h of snap.hosts || []) {
    const labels = { vcenter: h.vcenterId, host: h.name, cluster: h.cluster };
    const vcUnread = unreadVc.has(String(h.vcenterId));
    // v2.743(감사 VC-04): 끊긴·무응답 호스트는 사용률을 읽을 수 없다(store.usageReadable) — 수집기가 채운 0 을 내보내면 외부 대시보드가
    //   '부하 0%' 로 그린다. Prometheus 규약대로 결측은 그 시계열을 내지 않는다(vmware_host_up=0 은 그대로 낸다 — 거기서 끊김을 본다).
    if (usageReadable(h) && !vcUnread) {
      out += line('vmware_host_cpu_percent', labels, numOrNull(h.cpuUsagePct));
      out += line('vmware_host_mem_percent', labels, numOrNull(h.memUsagePct));
    }
    out += line('vmware_host_up', labels, h.connectionState === 'CONNECTED' ? 1 : 0);
    const p = powerMap.get(String(h.name || '').toLowerCase());
    if (p?.watts != null) out += line('vmware_host_power_watts', labels, p.watts);
    const guest = gpuHosts.get(h.id);
    const gpuPct = (vcUnread ? null : h.gpuUtilPct) ?? (guest ? guest.utilPct : null);   // 122회차: 스냅샷 값은 수집이 멈춘 vCenter 면 쓰지 않는다(게스트 오버레이는 별도 수집)
    if (gpuPct != null) out += line('vmware_host_gpu_percent', labels, gpuPct);
  }

  // 데이터스토어
  H('vmware_datastore_usage_percent', `데이터스토어 사용률(%)${ABSENT}`);
  H('vmware_datastore_capacity_bytes', `데이터스토어 용량(byte)${ABSENT}`);
  H('vmware_datastore_free_bytes', `데이터스토어 여유(byte)${ABSENT}`);
  for (const d of snap.datastores || []) {
    if (unreadVc.has(String(d.vcenterId))) continue;   // 122회차: 수집이 멈춘 vCenter 의 용량은 지금 값이 아니다(위 주석)
    const labels = { vcenter: d.vcenterId, datastore: d.name, type: d.type };
    // 116회차 F2(재현): 용량 · 여유를 **못 읽은** 데이터스토어(capacityGB · freeGB null — v2.598 SOAP freeSpace 없음 · v2.733 REST 폴백)를
    //   `(null || 0) * 1GiB` = 0 byte 로 내보냈다 — 외부 경보가 '여유 0' 으로 읽는다(실제로 가득 찬 DS 와 구분되지 않았다). 호스트 사용률(v2.743 VC-04)처럼
    //   결측은 그 시계열을 내지 않는다(line 이 null 을 건너뛴다). 보고된 0 은 값이다(numOrNull).
    const capGB = numOrNull(d.capacityGB); const freeGB = numOrNull(d.freeGB);
    out += line('vmware_datastore_usage_percent', labels, numOrNull(d.usagePct));
    out += line('vmware_datastore_capacity_bytes', labels, capGB == null ? null : capGB * 1073741824);
    out += line('vmware_datastore_free_bytes', labels, freeGB == null ? null : freeGB * 1073741824);
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
