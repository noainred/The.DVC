/**
 * 용량/수명 예측 — 시계열의 선형회귀 기울기로 "언제 한계에 도달하는지"를 추정한다.
 *   · 데이터스토어: ds_usedgb 추세 → 용량(capacityGB) 포화 ETA
 *   · GPU: gpu_vc/gpu_util 추세 → 100% 포화 ETA(과부하 시점)
 * 추가 수집 없이 metrics 시계열 + 스냅샷의 용량 정보를 결합한다.
 */

import { getMetricsDb } from '../metrics/db.js';

// 최소제곱 선형회귀. points=[{x(ms), y}] → { slopePerDay, intercept, r2 }.
function linreg(points) {
  const n = points.length;
  if (n < 3) return null;
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
  if (sxx === 0) return null;
  const slope = sxy / sxx; // y per ms
  const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);
  return { slopePerDay: slope * 86_400_000, intercept: my - slope * mx, slopeMs: slope, r2 };
}

const DAY = 86_400_000;

/** opts: { days (관측 기간), bucketMin, minR2 }. */
export async function forecastCapacity(snap, opts = {}) {
  const db = await getMetricsDb();
  const days = Math.max(3, Number(opts.days) || 14);
  const since = Date.now() - days * DAY;
  const bucketMs = (Number(opts.bucketMin) || 60) * 60_000;
  const minR2 = opts.minR2 != null ? Number(opts.minR2) : 0.3;
  const now = Date.now();

  const vcFilter = opts.vcenterId ? String(opts.vcenterId) : '';
  const dsCap = new Map(); // dsId -> capacityGB
  for (const d of snap.datastores || []) {
    if (vcFilter && d.vcenterId !== vcFilter) continue; // vCenter 범위 지정 시 그 법인만(대규모 환경 hang 방지)
    dsCap.set(d.id, { cap: d.capacityGB, name: d.name, vc: d.vcenterId, used: d.usedGB, pct: d.usagePct });
  }

  const fit = (metric, k, cap) => {
    const hist = db.history(metric, k, since, bucketMs, 5000);
    if (hist.length < 4) return null;
    const pts = hist.map((h) => ({ x: h.ts, y: h.avg }));
    const lr = linreg(pts);
    if (!lr || lr.r2 < minR2) return null;
    const current = pts[pts.length - 1].y;
    let daysToLimit = null, etaTs = null;
    if (lr.slopePerDay > 0 && cap > current) {
      daysToLimit = (cap - current) / lr.slopePerDay;
      etaTs = now + daysToLimit * DAY;
    }
    return { current: Number(current.toFixed(1)), slopePerDay: Number(lr.slopePerDay.toFixed(2)), r2: Number(lr.r2.toFixed(2)), daysToLimit: daysToLimit == null ? null : Math.round(daysToLimit), etaTs };
  };

  // 데이터스토어 포화 예측
  const datastores = [];
  for (const [id, meta] of dsCap) {
    if (!meta.cap) continue;
    const f = fit('ds_usedgb', id, meta.cap);
    if (!f) continue;
    datastores.push({ id, name: meta.name, vcenterId: meta.vc, capacityGB: Math.round(meta.cap), usedGB: Math.round(meta.used || f.current), usagePct: meta.pct, ...f });
  }
  datastores.sort((a, b) => (a.daysToLimit ?? 1e9) - (b.daysToLimit ?? 1e9));

  // GPU 포화 예측(vCenter 평균 사용률 100% 도달)
  const gpu = [];
  const gpuLatest = db.latestAll('gpu_vc');
  for (const [k] of gpuLatest) {
    if (vcFilter && k !== vcFilter) continue;
    const f = fit('gpu_vc', k, 100);
    if (!f) continue;
    gpu.push({ vcenterId: k, metric: 'gpu_vc', limit: 100, ...f });
  }
  gpu.sort((a, b) => (a.daysToLimit ?? 1e9) - (b.daysToLimit ?? 1e9));

  return {
    config: { days, bucketMin: bucketMs / 60_000, minR2, vcenterId: vcFilter || '' },
    scannedDatastores: dsCap.size,
    datastores: datastores.slice(0, 100),
    gpu: gpu.slice(0, 100),
    soon: datastores.filter((d) => d.daysToLimit != null && d.daysToLimit <= 30).slice(0, 30),
    generatedAt: now,
  };
}
