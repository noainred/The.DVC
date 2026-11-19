/**
 * IP 충돌 의심 판정(v3.1.0 — 설계 docs/design/ipam-alerts-mac-dns ③ · 보드 ⑤). 판정은 이 파일 하나다(알림 엔진 · 대장 · 추천 카드 · 변화 기록).
 *
 * '충돌' 이 아니라 '충돌 의심' 이다 — 스캐너는 한 번에 한 MAC 만 본다(원시 ARP 없음). 판정 순서(보드 ⑤):
 *   ① 스캔이 그 IP 의 MAC 을 **이웃 표(ARP)로** 읽었고 지난 완료 스캔에서도 보았다(miss 0) — NetBIOS 가 말한 MAC 은 쓰지 않는다
 *   ② 게이트웨이 이중화 가상 MAC · 여러 IP 에 답하는 MAC(대리 ARP 라우터 — SHARED_MAC_MAX 이상)은 뺀다
 *   ③ 그 IP 를 vCenter 의 VM(전원 켜짐)이 갖고 있고, 그 VM 의 NIC MAC 목록을 알며, 스캔 MAC 이 그 목록에 **없다**
 *   ④ 같은 MAC 을 연속 streak 회(설정값 — 기본 2) 이상 보았다(vMotion · IP 교체 직후의 한 번짜리 엇갈림을 거른다)
 * 모르는 것(NIC MAC 미수집 · 여러 VM 이 같은 IP · 스캔이 지난번에 못 봄)은 의심도 정상도 아니다 — `unknown` 으로 센다.
 *
 * VM 의 NIC MAC = 장치 구성(vm.dev.nics — vmcfg 수집, 오래된 VM 부터 주기당 상한) ∪ 게스트 NIC(vm.dns.nics — VMware Tools).
 * ESXi 호스트 관리 IP 는 대조하지 않는다(vmkernel NIC MAC 이 수집에 없다 — 설계 §3).
 */
import { normMac, macInfo } from './macVendor.js';

export const SHARED_MAC_MAX = 8;   // 한 MAC 이 이만큼 이상의 IP 에 답하면 라우터(대리 ARP)로 보고 판정에서 뺀다
export const STREAK_DEFAULT = 2;
const SEEN_SLACK_MS = 60_000;   // 병합 시각과 완료 보고 시각의 차(같은 보고 안에서 수 ms) — 넉넉히

const isOn = (vm) => vm && (vm.powerState === 'POWERED_ON' || vm.powerState === 'poweredOn');
function vmIps(vm) {
  const list = Array.isArray(vm.ipAddresses) && vm.ipAddresses.length ? vm.ipAddresses : (vm.ipAddress ? [vm.ipAddress] : []);
  return list.filter((x) => typeof x === 'string');
}
function vmMacs(vm) {
  const out = new Set();
  for (const n of Array.isArray(vm?.dev?.nics) ? vm.dev.nics : []) { const m = normMac(n?.mac); if (m) out.add(m); }
  for (const n of Array.isArray(vm?.dns?.nics) ? vm.dns.nics : []) { const m = normMac(n?.mac); if (m) out.add(m); }
  return out;
}

/**
 * VM IP → { vm, macs } (켜진 VM 만). 같은 IP 를 두 VM 이 주장하면 ambiguous(판정하지 않는다 — 대장의 '중복' 이 따로 말한다).
 * @returns {Map<string, { vm:{id,name,vcenterId}, macs:Set<string>, ambiguous?:boolean }>}
 */
export function vmMacIndex(snap) {
  const idx = new Map();
  for (const vm of Array.isArray(snap?.vms) ? snap.vms : []) {
    if (!isOn(vm) || vm.template) continue;
    const macs = vmMacs(vm);
    for (const ip of vmIps(vm)) {
      const cur = idx.get(ip);
      if (cur) { if (cur.vm.id !== vm.id) cur.ambiguous = true; continue; }
      idx.set(ip, { vm: { id: vm.id, name: vm.name || '', vcenterId: vm.vcenterId || '' }, macs });
    }
  }
  return idx;
}

/**
 * @param {object} snap 스냅샷(vms)
 * @param {(ip:string)=>object|null} scanOf 그 IP 의 스캔 저장 항목(scanStore.getScanResults()[ip])
 * @param {{ streak?:number, macIpCount?:(mac:string)=>number, index?:Map, lastScanOf?:(agent:string)=>number|null }} [o] lastScanOf = 그 에이전트의 마지막 완료 스캔 시각
 * @returns {{ suspects: Array<{ip, vm, mac, vendor, vmMacs:string[], otherVm?:object, at, agent, seen}>, unknown: Array<{ip, vm, reason}> }}
 *   unknown 사유: 'no-vm-mac'(NIC MAC 미수집) · 'ambiguous'(여러 VM) · 'not-seen'(지난 스캔에 없음 — miss>0)
 */
export function findConflicts(snap, scanOf, { streak = STREAK_DEFAULT, macIpCount = null, index = null, lastScanOf = null } = {}) {
  const idx = index || vmMacIndex(snap);
  const need = Math.max(1, Math.floor(Number(streak) || STREAK_DEFAULT));
  // 어느 VM 의 NIC 인가(다른 VM 의 MAC 이 응답 — IP 가 옮겨 갔는데 Tools 가 옛 IP 를 보고하는 경우 등) — 필요할 때만 한 번 만든다
  let macOwner = null;
  const ownerOf = (mac) => {
    if (!macOwner) {
      macOwner = new Map();
      for (const v of idx.values()) for (const m of v.macs) if (!macOwner.has(m)) macOwner.set(m, v.vm);
    }
    return macOwner.get(mac) || null;
  };
  const suspects = []; const unknown = [];
  for (const [ip, v] of idx) {
    const sc = scanOf(ip);
    const arp = sc && sc.arp && typeof sc.arp === 'object' && sc.arp.v ? sc.arp : null;
    if (!arp) continue;                                   // 스캔이 MAC 을 모른다(다른 서브넷 · 스캔 대역 밖) — 대상 아님
    if (v.ambiguous) { unknown.push({ ip, vm: v.vm, reason: 'ambiguous' }); continue; }
    if (!v.macs.size) { unknown.push({ ip, vm: v.vm, reason: 'no-vm-mac' }); continue; }
    if ((arp.miss || 0) > 0) { unknown.push({ ip, vm: v.vm, reason: 'not-seen' }); continue; }
    // 그 에이전트의 마지막 완료 스캔이 이 IP 를 보지 못했다(응답 없음) — 옛 MAC 으로 의심을 이어 가지 않는다(모름)
    const last = typeof lastScanOf === 'function' ? lastScanOf(sc.agent) : null;
    if (last != null && (arp.at || 0) < last - SEEN_SLACK_MS) { unknown.push({ ip, vm: v.vm, reason: 'not-seen' }); continue; }
    if (v.macs.has(arp.v)) continue;                      // 그 VM 의 NIC — 정상
    const info = macInfo(arp.v);
    if (info?.kind === 'gateway') continue;               // 이중화 가상 MAC
    if (typeof macIpCount === 'function' && macIpCount(arp.v) >= SHARED_MAC_MAX) continue;   // 대리 ARP 라우터
    if ((arp.n || 1) < need) continue;                    // 아직 연속 회수가 모자람
    const other = ownerOf(arp.v);
    suspects.push({ ip, vm: v.vm, mac: arp.v, vendor: info?.vendor || null, vmMacs: [...v.macs].slice(0, 8),
      ...(other && other.id !== v.vm.id ? { otherVm: other } : {}), at: arp.at || null, agent: sc.agent || '', seen: arp.n || 1 });
  }
  suspects.sort((a, b) => (a.ip < b.ip ? -1 : 1));
  return { suspects, unknown };
}
