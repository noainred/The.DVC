/**
 * Collector-agent export. When this instance runs at a datacenter as a
 * collector, it exposes its locally-collected power so the central portal can
 * pull and merge it. Only LOCAL data (this instance's iDRAC/OME) is exported —
 * never re-exported remote data — so there are no pull loops.
 */

import { config, currentVersion } from '../config.js';
import { localPowerByHostName } from '../idrac/service.js';
import { getPollerStatus } from '../idrac/poller.js';
import { allOmeDevices } from '../idrac/omeCache.js';
import { loadRegistry as loadIdracRegistry } from '../idrac/registry.js';
import { getInventory } from '../idrac/invCache.js';

// 서버 분석용 콤팩트 인벤토리(중앙 '서버 분석' 4개 탭이 쓰는 필드만; 자격증명·잡정보 제외).
// 큰 항목은 firmware 배열뿐이라 O(구성요소 수)로 유지된다.
function compactInv(inv) {
  if (!inv) return null;
  return {
    system: inv.system ? { model: inv.system.model, serviceTag: inv.system.serviceTag, biosVersion: inv.system.biosVersion } : undefined,
    cpu: inv.cpu ? { model: inv.cpu.model, count: inv.cpu.count, cores: inv.cpu.cores } : undefined,
    memory: inv.memory ? { totalGiB: inv.memory.totalGiB } : undefined,
    gpus: Array.isArray(inv.gpus) ? inv.gpus.map((g) => ({ model: g.model, name: g.name, memoryMiB: g.memoryMiB })) : [],
    idrac: inv.idrac ? { firmwareVersion: inv.idrac.firmwareVersion } : undefined,
    bios: inv.bios ? { version: inv.bios.version } : undefined,
    firmware: Array.isArray(inv.firmware) ? inv.firmware.map((f) => ({ type: f.type, version: f.version, name: f.name })) : [],
    collectedAt: inv.collectedAt,
  };
}

// 이 엣지의 iDRAC 레지스트리를 '서버 분석'용으로 직렬화(자격증명 제외). 위임 스캔으로 현지
// 등록된 서버 + 캐시 인벤토리를 중앙이 병합해 위임 법인도 서버 분석에 나타나게 한다.
// 표시 이름을 hostname으로 통일해 도출한다: ① hostNames 중 IP가 아닌 항목(=hostname) 우선,
// ② 없으면 저장된 name이 서비스태그가 아닐 때만 그 name, ③ 그래도 없으면 host(IP)/id.
// (과거 등록분이 name=서비스태그로 저장돼 있어도 재스캔 없이 다음 수집에서 교정된다.)
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
function serverDisplayName(s) {
  const tag = String(s.serviceTag || '').trim();
  const hn = (s.hostNames || []).find((h) => h && !IPV4_RE.test(String(h).trim()) && String(h).trim() !== tag);
  if (hn) return String(hn).trim();
  if (s.name && String(s.name).trim() !== tag) return String(s.name).trim();
  return String(s.host || '').replace(/^https?:\/\//, '') || s.id; // 스킴 제거한 IP
}

function localServersForExport() {
  const out = [];
  for (const s of loadIdracRegistry()) {
    if (s.type === 'ome') continue; // OME는 상세 인벤토리 미지원
    const inv = getInventory(s.id);
    out.push({
      id: s.id,
      name: serverDisplayName(s),
      host: s.host || '',
      serviceTag: s.serviceTag || inv?.system?.serviceTag || '',
      model: s.model || inv?.system?.model || '',
      vcenterId: s.vcenterId || '',
      datacenterId: s.datacenterId || '',
      type: s.type || 'idrac',
      inv: compactInv(inv),
    });
  }
  return out;
}

export async function buildExport() {
  const byNameMap = await localPowerByHostName();
  // 서버 1대당 한 행으로 중복 제거. localPowerByHostName은 한 서버를 여러 별칭(이름·서비스태그·
  // hostNames) 키로 넣으므로, 중복 제거 없이 export하면 중앙이 같은 서버를 별칭 수만큼 중복 집계한다
  // ('전력 보고' 수 과다·동일 호스트 중복의 원인). serverId 기준으로 첫 행만 내보낸다.
  const seen = new Set();
  const byHost = [];
  for (const [host, r] of byNameMap) {
    if (r.serverId != null && seen.has(r.serverId)) continue;
    if (r.serverId != null) seen.add(r.serverId);
    byHost.push({ host, watts: r.watts, ts: r.ts, serverName: r.serverName, serverId: r.serverId, serviceTag: r.serviceTag || '', model: r.model || '' });
  }
  const servers = localServersForExport();
  return {
    version: currentVersion(),
    datacenter: config.collector.datacenter || '',
    generatedAt: Date.now(),
    poller: getPollerStatus(),
    omeDevices: allOmeDevices().length,
    hosts: byHost.length,
    power: { byHost },
    // 서버 분석용 인벤토리(위임 법인 서버가 중앙 '서버 분석'에 나타나게 함). 전력만 쓰던
    // 구버전 중앙은 이 필드를 무시하므로 하위호환.
    servers,
  };
}
