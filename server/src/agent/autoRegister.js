/**
 * agent/autoRegister.js — 배포 성공 직후 그 호스트를 중앙에 '수집 서버'로 자동 등록(설치+등록 원클릭).
 * v2.432 에서 routes/admin/deployLlm.js 의 지역 함수를 분리했다(단건 배포·대량 배포가 같은 규칙을 쓰도록).
 */
import { addCollector, updateCollector, loadCollectors } from '../collector/registry.js';
import { pullNow } from '../collector/puller.js';
import { ensureCollectorDatacenter } from '../insights/analysisServers.js'; // v2.579: 도메인은 routes 를 import 하지 않는다(ARCH-04)

/** 수집 서버 id 로 쓸 슬러그(법인 → 에이전트명 → host 순). */
export function collectorIdFor(target) {
  return (String(target?.collectorDatacenter || target?.agentName || target?.host || '').trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')) || `col-${target?.host}`;
}

/**
 * collectorToken 이 있고 registerCollector!==false 일 때만 등록한다. 같은 id 면 갱신.
 * v2.428: 중계 엣지 경유 대상(SSH 포트≠22 등)은 host:portalPort 가 중앙에서 닿는 주소가 아니다 —
 * 광고 URL(advertiseUrl)이 있으면 그것을 수집 URL 로 쓴다.
 */
export function autoRegisterCollector(target, portalPort) {
  if (!target?.collectorToken || target.registerCollector === false) return null;
  const port = Number(portalPort) || 4000;
  const id = collectorIdFor(target);
  const url = String(target.advertiseUrl || '').trim().replace(/\/+$/, '') || `http://${target.host}:${port}`;
  const body = { id, name: target.agentName || target.collectorDatacenter || target.host, datacenter: target.collectorDatacenter || '', url, token: target.collectorToken, enabled: true };
  const exists = loadCollectors().find((c) => c.id === id);
  const r = exists ? updateCollector(id, body) : addCollector(body);
  if (r.ok) { ensureCollectorDatacenter(r.collector); pullNow().catch(() => {}); }
  return r.ok ? { registered: true, id, url, updated: !!exists } : { registered: false, reason: r.reason };
}
