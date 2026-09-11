/**
 * idrac/physicalCapacity.js — iDRAC 가 인식한 **모든 물리 서버**의 코어·메모리 합계(v2.486, 순수 함수).
 *
 * 사용자 요구: Overview 의 CPU/메모리 카드에 vCenter(ESXi) 기준 수치와 별개로 '전체 물리 서버' 기준
 * 코어 수·물리 메모리 량을 보이게. 출처는 iDRAC Redfish 인벤토리(`inv.cpu.cores` = ProcessorSummary.CoreCount,
 * `inv.memory.totalGiB` = MemorySummary.TotalSystemMemoryGiB). 중앙 직접 등록 서버는 invCache, 위임 법인의
 * 원격 서버는 엣지가 실어 보낸 콤팩트 인벤토리(s.inv)를 쓴다(routes/admin/shared.js invForServer 와 동일 규칙).
 *
 * 정직 원칙: 인벤토리가 없는 서버는 합계에 넣지 않고 개수만 센다(추정 금지). CoreCount 가 없으면 소켓별
 * `inv.cpus[].cores` 합으로 대체하고, 그것도 없으면 코어를 모르는 서버로 센다.
 */

const num = (x) => { const n = Number(x); return Number.isFinite(n) && n > 0 ? n : null; };

/** 한 서버 인벤토리 → { cores, threads, sockets, memGiB } (각각 null 가능). */
export function capacityOfInventory(inv) {
  if (!inv || typeof inv !== 'object') return null;
  let cores = num(inv.cpu?.cores);
  if (cores == null && Array.isArray(inv.cpus) && inv.cpus.length) {
    const s = inv.cpus.reduce((a, c) => a + (num(c?.cores) || 0), 0);
    cores = s > 0 ? s : null;
  }
  return {
    cores,
    threads: num(inv.cpu?.threads),
    sockets: num(inv.cpu?.count) ?? (Array.isArray(inv.cpus) && inv.cpus.length ? inv.cpus.length : null),
    memGiB: num(inv.memory?.totalGiB),
  };
}

/**
 * 서버 목록을 집계한다. servers: [{ id, ... }] (OME 엔트리 제외한 물리 서버, 중앙+원격 병합·중복 제거 후).
 * invOf(server) → inventory|null.
 * @returns {{ servers:number, withInventory:number, withCores:number, withMemory:number,
 *            cores:number, threads:number, sockets:number, memGiB:number, memGB:number }}
 */
export function aggregatePhysical(servers, invOf) {
  const out = { servers: 0, withInventory: 0, withCores: 0, withMemory: 0, cores: 0, threads: 0, sockets: 0, memGiB: 0, memGB: 0 };
  const seen = new Set();
  for (const s of servers || []) {
    const id = String(s?.id ?? '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.servers++;
    const cap = capacityOfInventory(invOf(s));
    if (!cap) continue;
    out.withInventory++;
    if (cap.cores != null) { out.withCores++; out.cores += cap.cores; }
    if (cap.threads != null) out.threads += cap.threads;
    if (cap.sockets != null) out.sockets += cap.sockets;
    if (cap.memGiB != null) { out.withMemory++; out.memGiB += cap.memGiB; }
  }
  out.memGiB = Math.round(out.memGiB);
  out.memGB = Math.round(out.memGiB * 1.073741824);   // GiB → GB(10진) — vCenter 카드의 GB 와 같은 단위로 병기
  return out;
}
