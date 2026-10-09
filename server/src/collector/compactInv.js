/**
 * collector/compactInv.js — 엣지 export 의 **축약 인벤토리**(순수, v2.728 에 collector/agent.js 에서 분리).
 *
 * 분리 이유: 데모 모드(mock/demo/edgeSeed.js)가 위임 서버의 축약 인벤토리를 **실제 함수로** 만들어야 하는데 agent.js 는
 * iDRAC 폴러·전력 서비스까지 끌고 와 import 순환(SCC)이 생긴다. 이 모듈은 idrac/nicPorts.js(의존 없음)만 쓴다.
 * agent.js 는 이것을 import 해 그대로 재수출한다(테스트·호출부 무변경).
 */
import { dedupNics } from '../idrac/nicPorts.js'; // v2.728: 같은 물리 포트 중복 제거(의존 없는 순수 모듈)
// 서버 분석용 콤팩트 인벤토리(중앙 '서버 분석' 4개 탭이 쓰는 필드만; 자격증명·잡정보 제외).
// 큰 항목은 firmware 배열뿐이라 O(구성요소 수)로 유지된다.
//
// ⚠⚠ v2.728: 부품 이름·상태(health·state)·PSU 입력값·디스크 예측 실패·롤업(health)·컬렉션 메타(collections·reachable)를 싣는다.
//   예전에는 이 값을 빼고 보내 위임(엣지) 서버의 상세 화면이 PSU 이름 칸 공백 · 입력 '—' · 상태 '—', 디스크 이름 공백으로 보였고
//   (사용자 신고 R640), 서버 부품 장애를 화면이 말할 수 없었다. ⚠ 중앙 collector/remoteInventory.js INV_SHAPE 에도 **같은 키**가
//   있어야 한다(한쪽만 넓히면 중앙이 버린다 — v2.611 CEN2611-01). 시리얼·부품번호 같은 자산 정보는 여전히 뺀다.
//   상태는 **못 읽었어도 키를 싣는다**(health: '') — 중앙이 '구버전 엣지(키 없음)' 와 '못 읽음(빈 값)' 을 가른다(idrac/invView.js).
const cs = (v, n = 64) => (typeof v === 'string' ? (v.length > n ? v.slice(0, n) : v) : '');
const cn = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const cb = (v) => (typeof v === 'boolean' ? v : null);     // 예측 실패 — null(미확인)을 false 로 굳히지 않는다(v2.547)
const st = (o) => ({ health: cs(o?.health, 32), state: cs(o?.state, 32) });
const COLL_KEYS = ['system', 'psus', 'disks', 'storageControllers', 'memoryDimms', 'cpus', 'gpus', 'pcie', 'fans'];
const HEALTH_KEYS = ['overall', 'processor', 'memory', 'storage', 'psu', 'fan', 'battery', 'gpu'];
export function compactInv(inv) {
  if (!inv) return null;
  const coll = inv.collections && typeof inv.collections === 'object' ? inv.collections : null;
  const health = inv.health && typeof inv.health === 'object' ? inv.health : null;
  return {
    // hostName: 파트/분석 화면에서 IP와 나란히 표시(iDRAC 이 보고하는 OS 호스트네임) — 누락 시
    // 위임(엣지) 서버는 hostname 컬럼이 영구 공백이 된다.
    system: inv.system ? { model: inv.system.model, serviceTag: inv.system.serviceTag, biosVersion: inv.system.biosVersion, hostName: inv.system.hostName, health: cs(inv.system.health, 32) } : undefined,
    cpu: inv.cpu ? { model: inv.cpu.model, count: inv.cpu.count, cores: inv.cpu.cores, health: cs(inv.cpu.health, 32) } : undefined,
    memory: inv.memory ? { totalGiB: inv.memory.totalGiB, health: cs(inv.memory.health, 32) } : undefined,
    gpus: Array.isArray(inv.gpus) ? inv.gpus.map((g) => ({ model: g.model, name: g.name, memoryMiB: g.memoryMiB, ...st(g) })) : [],
    idrac: inv.idrac ? { firmwareVersion: inv.idrac.firmwareVersion } : undefined,
    bios: inv.bios ? { version: inv.bios.version } : undefined,
    firmware: Array.isArray(inv.firmware) ? inv.firmware.map((f) => ({ type: f.type, version: f.version, name: f.name })) : [],
    // NIC 어댑터/포트 — 중앙 '서버 NIC 속도/모델 확인'용. 과거 이 필드가 누락돼 엣지 원격
    // 서버가 전부 '정보없음'(모델 0종)으로 나왔다. 포트는 id/link/speedMbps만(콤팩트 유지).
    // v2.728: 같은 물리 포트가 두 컬렉션(NetworkPorts·Ports)으로 두 번 실린 옛 캐시도 보내기 전에 한 번으로 묶는다(idrac/nicPorts.js).
    nics: Array.isArray(inv.nics) ? dedupNics(inv.nics).map((n) => ({
      name: n.name, model: n.model,
      // v2.682(R3E-01): 포트 MAC 도 싣는다 — 중앙 '통합 성능 모니터링' 의 MAC 규칙(ESXi NIC MAC ↔ iDRAC 포트 MAC)이 위임 서버에도 동작하게.
      //   중앙 remoteInventory INV_SHAPE 에도 'mac' 이 있어야 한다(한쪽만이면 버려진다). 없으면 키를 만들지 않는다.
      ports: Array.isArray(n.ports) ? n.ports.map((p) => ({ id: p.id, link: p.link, speedMbps: p.speedMbps, ...(typeof p.mac === 'string' && p.mac ? { mac: p.mac.slice(0, 64) } : {}) })) : [],
    })) : [],
    // 파트 인벤토리 탭용 — 집계에 필요한 식별 필드만(시리얼 등 자산정보 제외, 페이로드 절약).
    // 이 필드들을 빼면 위임(엣지) 법인의 서버가 파트 탭에서 전부 공백이 된다(과거 nics 누락과
    // 동일한 회귀 패턴 — test/compactInv.test.js 가 고정).
    cpus: Array.isArray(inv.cpus) ? inv.cpus.map((c) => ({ socket: c.socket, model: c.model, cores: c.cores, ...st(c) })) : [],
    disks: Array.isArray(inv.disks) ? inv.disks.map((d) => ({ name: cs(d.name, 128), model: d.model, capacityGB: d.capacityGB, media: d.media, protocol: d.protocol, ...st(d), predictiveFailure: cb(d.predictiveFailure) })) : [],
    psus: Array.isArray(inv.psus) ? inv.psus.map((p) => ({
      name: cs(p.name, 128), model: p.model, manufacturer: p.manufacturer, capacityWatts: p.capacityWatts,
      inputWatts: cn(p.inputWatts), outputWatts: cn(p.outputWatts), lineInputVoltage: cn(p.lineInputVoltage), ...st(p),
    })) : [],
    memoryDimms: Array.isArray(inv.memoryDimms) ? inv.memoryDimms.map((m) => ({ locator: cs(m.locator, 64), sizeGB: m.sizeGB, type: m.type, speedMHz: m.speedMHz, manufacturer: m.manufacturer, partNumber: m.partNumber, ...st(m) })) : [],
    storageControllers: Array.isArray(inv.storageControllers) ? inv.storageControllers.map((c) => ({ name: cs(c.name, 128), model: c.model, firmware: c.firmware, protocols: c.protocols, health: cs(c.health, 32) })) : [],
    pcie: Array.isArray(inv.pcie) ? inv.pcie.map((d) => ({ name: cs(d.name, 128), model: d.model, manufacturer: d.manufacturer, deviceType: d.deviceType, health: cs(d.health, 32) })) : [],
    // 팬: state 는 빈 슬롯일 때만 있다(v2.612 COL2612-08 — poller.js 가 그때만 싣는다). health 는 언제나 싣는다.
    fans: Array.isArray(inv.fans) ? inv.fans.map((f) => ({ name: f.name, model: f.model, partNumber: f.partNumber, health: cs(f.health, 32), ...(typeof f.state === 'string' && f.state ? { state: cs(f.state, 32) } : {}) })) : [],
    // 롤업·컬렉션 메타 — 아는 키만(값은 짧은 글자). 컬렉션은 'ok'|'failed' 만, reachable 은 불리언만.
    ...(health ? { health: Object.fromEntries(HEALTH_KEYS.filter((k) => Object.hasOwn(health, k)).map((k) => [k, cs(health[k], 32)])) } : {}),
    ...(coll ? { collections: Object.fromEntries(COLL_KEYS.filter((k) => coll[k] === 'ok' || coll[k] === 'failed').map((k) => [k, coll[k]])) } : {}),
    ...(typeof inv.reachable === 'boolean' ? { reachable: inv.reachable } : {}),
    collectedAt: inv.collectedAt,
  };
}
