/**
 * 하드웨어 집계 드릴다운 매칭 — 순수 함수. 인벤토리가 (dim, key)에 해당하는지 판정한다.
 * dim: 'model' | 'cpu' | 'memory' | 'gpu'. 집계(hardware-summary)와 동일한 키 규칙을 쓴다.
 * gpu는 일치하는 GPU 카드 수(gpuCount)도 함께 반환.
 */
export function hardwareDimMatch(inv, dim, key) {
  if (!inv) return { match: false, gpuCount: 0 };
  if (dim === 'model') return { match: (inv.system?.model || '미상') === key, gpuCount: 0 };
  if (dim === 'cpu') {
    const cpu = inv.cpu || {};
    return { match: ((cpu.model || '미상') + (cpu.count ? ` ×${cpu.count}` : '')) === key, gpuCount: 0 };
  }
  if (dim === 'memory') {
    const gib = inv.memory?.totalGiB;
    return { match: gib != null && Number.isFinite(Number(gib)) && `${Math.round(Number(gib))} GiB` === key, gpuCount: 0 };
  }
  if (dim === 'gpu') {
    const n = (inv.gpus || []).filter((g) => ((g.model || g.name || '').trim()) === key).length;
    return { match: n > 0, gpuCount: n };
  }
  return { match: false, gpuCount: 0 };
}
