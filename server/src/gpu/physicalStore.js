/**
 * 물리(베어메탈) 서버 GPU 수집 결과 저장소 — 인메모리. 가상화하지 않은 서버에 직접
 * SSH로 nvidia-smi를 돌려 얻은 사용률/메모리/GPU 목록을 서버 id별로 보관한다.
 */

const byId = new Map(); // id -> { id, name, host, vcenterId, count, utilPct, utilNA, memUsedPct, gpus, error, at }

export function setPhysicalGpu(id, data) { byId.set(id, { ...data, at: Date.now() }); }
export function getPhysicalGpu(id) { return byId.get(id) || null; }
export function getAllPhysicalGpu() { return [...byId.values()]; }
export function removePhysicalGpu(id) { byId.delete(id); }
/** 등록부에서 사라진 서버의 결과 정리. */
export function prunePhysicalGpu(keepIds) {
  for (const k of [...byId.keys()]) if (!keepIds.has(k)) byId.delete(k);
}
export function physicalGpuCounts() {
  let gpus = 0; for (const v of byId.values()) gpus += v.count || 0;
  return { servers: byId.size, gpus };
}
