/**
 * AI 이상탐지 — 임계값이 아니라 "평소 패턴 대비 이탈"을 통계로 탐지한다. 기존 metrics
 * 시계열(temp_host, gpu_util, gpu_vc, ds_usedgb …)의 과거 분포로 평균/표준편차를 구하고,
 * 최신값의 robust Z-score(중앙값·MAD 기반)가 임계 이상이면 이상으로 표시한다.
 *
 * 30개 vCenter·고RTT 환경을 고려해 전부 in-process 계산이며 외부 의존성/모델 없음.
 */

import { getMetricsDb } from '../metrics/db.js';

// 탐지 대상 시계열 패밀리 + 라벨(엔티티 키 → 사람이 읽을 이름은 호출부에서 매핑).
const FAMILIES = [
  { metric: 'temp_host', label: '호스트 온도', unit: '℃', high: true, low: false },
  { metric: 'gpu_util', label: 'GPU 사용률', unit: '%', high: true, low: false },
  { metric: 'gpu_vc', label: 'vCenter GPU', unit: '%', high: true, low: false },
  { metric: 'ds_usedgb', label: '데이터스토어 사용량', unit: 'GB', high: true, low: false },
];

const median = (arr) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/**
 * 한 패밀리의 이상치 목록.
 * baseline은 history(버킷 평균)로 구해 단발 스파이크에 과민하지 않게 한다.
 */
async function detectFamily(db, fam, { z = 3.5, windowHours = 24, bucketMin = 10, minSamples = 12 }) {
  const since = Date.now() - windowHours * 3600_000;
  const latest = db.latestAll(fam.metric); // Map<k,{v,ts}>
  const out = [];
  for (const [k, last] of latest) {
    const hist = db.history(fam.metric, k, since, bucketMin * 60_000, 5000); // [{ts,avg,min,max}]
    if (hist.length < minSamples) continue;
    const vals = hist.map((h) => h.avg);
    const med = median(vals);
    const mad = median(vals.map((v) => Math.abs(v - med))) || 0;
    // MAD가 0이면(완전 평탄) 표준편차로 폴백.
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length) || 0;
    const scale = mad ? mad * 1.4826 : sd; // MAD→σ 환산상수
    if (!scale) continue;
    const score = (last.v - med) / scale;
    const isHigh = fam.high && score >= z;
    const isLow = fam.low && score <= -z;
    if (isHigh || isLow) {
      out.push({
        metric: fam.metric, label: fam.label, unit: fam.unit, key: k,
        value: Number(last.v.toFixed(1)), baseline: Number(med.toFixed(1)),
        z: Number(score.toFixed(1)), direction: score >= 0 ? 'high' : 'low',
        at: last.ts, samples: hist.length,
      });
    }
  }
  return out.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
}

/** 모든 패밀리 이상탐지. opts: { z, windowHours, bucketMin }. */
export async function detectAnomalies(opts = {}) {
  const db = await getMetricsDb();
  const z = Math.max(2, Number(opts.z) || 3.5);
  const cfg = { z, windowHours: Number(opts.windowHours) || 24, bucketMin: Number(opts.bucketMin) || 10, minSamples: 12 };
  const families = [];
  let total = 0;
  for (const fam of FAMILIES) {
    let items = [];
    try { items = await detectFamily(db, fam, cfg); } catch { items = []; }
    total += items.length;
    families.push({ metric: fam.metric, label: fam.label, count: items.length, items: items.slice(0, 50) });
  }
  return { config: cfg, total, families, generatedAt: Date.now() };
}
