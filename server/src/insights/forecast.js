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
  // ⚠ 블로킹 방지(v2.287, 확정 버그 #14): days 에 상한이 없고 bucketMin 이 60 미만이면 metrics
  // history 의 시간당 롤업 경로(bucketMs>=1h)를 못 타고 원본 samples 를 풀레인지로 데이터스토어
  // 키마다 GROUP BY 스캔해 이벤트 루프가 멈춘다. days 3~1830 · bucketMin 60~1440 으로 클램프해
  // 항상 시간당 롤업 경로를 타게 한다(/tools/capacity-forecast 가 120일·일버킷으로 안전히 쓰는 패턴).
  const days = Math.max(3, Math.min(1830, Number(opts.days) || 14));
  const since = Date.now() - days * DAY;
  const bucketMs = Math.max(60, Math.min(1440, Number(opts.bucketMin) || 60)) * 60_000;
  const minR2 = opts.minR2 != null ? Number(opts.minR2) : 0.3;
  const now = Date.now();

  const vcFilter = opts.vcenterId ? String(opts.vcenterId) : '';
  // 사용자 scope 허용 vCenter 집합(v2.288, 확정 버그: GPU 예측 scope 우회). null=무제한.
  // 데이터스토어 예측은 호출자가 scopeSlice 로 좁힌 snap.datastores 를 넘겨 이미 제한되지만,
  // GPU 예측(아래)은 스냅샷이 아니라 metrics DB 의 gpu_vc 키 전체를 직접 훑으므로 여기서 교집합
  // 필터를 별도로 적용해야 범위 밖 vCenter GPU 가 새지 않는다.
  const allowed = opts.allowed instanceof Set ? opts.allowed : null;
  const dsCap = new Map(); // dsId -> capacityGB
  for (const d of snap.datastores || []) {
    if (vcFilter && d.vcenterId !== vcFilter) continue; // vCenter 범위 지정 시 그 법인만(대규모 환경 hang 방지)
    if (allowed && !allowed.has(d.vcenterId)) continue; // scope 방어(호출자가 scoped snap 을 안 넘겨도 이중 차단)
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
    if (allowed && !allowed.has(k)) continue; // scope: 범위 밖 vCenter GPU 예측 유출 차단(확정 버그)
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
