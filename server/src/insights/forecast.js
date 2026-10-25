/**
 * 용량/수명 예측 — 시계열의 선형회귀 기울기로 "언제 한계에 도달하는지"를 추정한다.
 *   · 데이터스토어: ds_usedgb 추세 → 용량(capacityGB) 포화 ETA
 *   · GPU: gpu_vc/gpu_util 추세 → 100% 포화 ETA(과부하 시점)
 * 추가 수집 없이 metrics 시계열 + 스냅샷의 용량 정보를 결합한다.
 */

import { getMetricsDb } from '../metrics/db.js';
import { loadMetricsSettings } from '../metrics/settings.js';
import { createYielder } from '../util/timeSlice.js';
import { numOrNull } from '../util/numOrNull.js';

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

/*
 * v2.769(점검 R4-D2-06): 계산 인자 정규화 — 라우트 캐시 키와 계산이 **같은 함수**의 결과를 본다(v2.689 I2 '키와 계산이 같은 값').
 *   days 는 정수 3~1830, 버킷은 1시간 정배수(60~1440분), minR2 는 '못 읽은 값은 0 이 아니다' — `?minR2=` 가 Number('')=0 으로
 *   신뢰도 필터를 해제하고 'x' 가 NaN 으로 필터를 끄던 것을 막는다. 숫자가 아니면 기본(0.3), 숫자면 [0,1]·0.05 단위.
 */
export const DEFAULT_MIN_R2 = 0.3;
export function forecastCfgArgs(opts = {}) {
  const dn = Number(opts.days);
  const days = Number.isFinite(dn) && dn !== 0 ? Math.max(3, Math.min(1830, Math.round(dn))) : 14;
  const bn = Number(opts.bucketMin);
  const bucketH = Math.max(1, Math.round(Math.max(60, Math.min(1440, Number.isFinite(bn) && bn !== 0 ? bn : 60)) / 60));
  const r = numOrNull(opts.minR2);
  const minR2 = r == null ? DEFAULT_MIN_R2 : Math.max(0, Math.min(1, Math.round(r * 20) / 20));
  return { days, bucketMin: bucketH * 60, minR2 };
}

/** opts: { days (관측 기간), bucketMin, minR2 }. */
export async function forecastCapacity(snap, opts = {}) {
  const db = await getMetricsDb();
  // ⚠ 블로킹 방지(v2.287, 확정 버그 #14): days 에 상한이 없고 bucketMin 이 60 미만이면 metrics
  // history 의 시간당 롤업 경로(bucketMs>=1h)를 못 타고 원본 samples 를 풀레인지로 데이터스토어
  // 키마다 GROUP BY 스캔해 이벤트 루프가 멈춘다. days 3~1830 · bucketMin 60~1440 으로 클램프해
  // 항상 시간당 롤업 경로를 타게 한다(/tools/capacity-forecast 가 120일·일버킷으로 안전히 쓰는 패턴).
  const norm = forecastCfgArgs(opts); // v2.769(R4-D2-06): 클램프는 forecastCfgArgs 한 곳(라우트 캐시 키와 같은 값)
  const days = norm.days;
  const since = Date.now() - days * DAY;
  // v2.672(운영 장애 — capacity-forecast 와 같은 경로): 시간당 롤업**만** 읽는다(historyRollup — 원본 폴백 없음).
  //   history() 는 롤업 도입 이전 원본이 남은 현장에서 days 가 롤업 나이보다 길면 원본으로 떨어진다(원본 보존 기본 5년 ·
  //   ds_usedgb 는 분마다 저장) — 데이터스토어 수천 개 루프에서 그것이 포탈을 수 분씩 멈춘다. 롤업은 1시간 단위라
  //   버킷도 1시간 정배수로 맞춘다(예: 90분 → 2시간 — 응답 config.bucketMin 이 실제 값을 말한다).
  const bucketMs = (norm.bucketMin / 60) * 3_600_000;
  const readRollup = typeof db.historyRollup === 'function' ? db.historyRollup.bind(db) : null;
  const maybeYield = createYielder(15);   // 시간 기준 양보(개수 기준은 한 건이 느리면 못 막는다)
  const minR2 = norm.minR2;
  const now = Date.now();
  // v2.733(점검 3회차 C2-07): 마지막 점의 신선도 경계. 수집이 이어지면 마지막 버킷의 시작은 지금에서 한 버킷(표본 주기가 버킷보다
  //   길면 한 주기) 안이다 — 수집·롤업 지연 여유로 두 칸을 더 둔 ×3(저장소의 '주기 × 3' 신선도 규약과 같은 배수). 넘으면 stale.
  let sampleMs = 60_000;
  try { const s = Number(loadMetricsSettings()?.sampleIntervalMs); if (Number.isFinite(s) && s > 0) sampleMs = s; } catch { /* 설정을 못 읽으면 기본 1분 */ }
  const staleAfterMs = Math.max(bucketMs, sampleMs) * 3;

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
    // 롤업 조회가 없는 구버전 db 객체면 예측을 만들지 않는다 — history() 로 되돌리면 원본 집계 경로가 된다.
    const hist = readRollup ? readRollup(metric, k, since, bucketMs, 5000) : [];
    if (hist.length < 4) return null;
    const pts = hist.map((h) => ({ x: h.ts, y: h.avg }));
    const lr = linreg(pts);
    if (!lr) return null;
    const current = pts[pts.length - 1].y;
    // v2.781(점검 G4 E-B1): 이미 한계에 닿은(마지막 버킷 평균 ≥ 용량) 항목은 'full' 이다. 예전에는 daysToLimit 만 null 이라 '증가 없음(안정)'
    //   과 같은 값이 되어 ① 정렬 맨 뒤 → 상한 100 에서 가장 급한 DS 가 잘렸고 ② soon(30일 내 포화)에서 빠졌고 ③ 웹 GPU 칸이 '안정' 으로 그렸다.
    //   daysToLimit 은 null 그대로(남은 일수를 지어내지 않는다 — 웹 계약 유지)이고 full 표지를 따로 싣는다.
    //   포화 판정은 R² 필터보다 **앞**이다: R² 는 '추세(ETA) 신뢰도' 를 거르는 것이고 '지금 꽉 찼다' 는 회귀와 무관한 관측값이다 —
    //   꽉 찬 채 흔들리는 시계열(R² ≈ 0)이 목록에서 사라지면 안 된다. 꽉 차지 않은 항목은 예전처럼 R² 로 걸러진다.
    const capN = numOrNull(cap);   // 못 읽은 용량은 0 이 아니다 — 모르면 포화로 단정하지 않는다
    const full = capN != null && capN > 0 && Number.isFinite(current) && current >= capN;
    if (!full && lr.r2 < minR2) return null;
    // v2.733(C2-07 — 재현: 같은 추세에서 5일 전 멈춘 DS 가 41일, 신선한 DS 가 36일): current 는 **마지막 점의 값**이므로 남은 기간도
    //   마지막 점 시각(lastTs — 그 버킷의 시작)에서 센다. 예전처럼 지금부터 세면 수집이 멈춘 동안의 증가가 빠져 남은 시간을 더 길게
    //   말한다(위험한 방향). daysToLimit 은 화면 계약대로 '지금부터 N일' 이고, 추세상 이미 지났으면 0(음수 아님). 버킷 시작 기준이라
    //   신선한 DS 의 ETA 는 예전보다 최대 반 버킷 이르다(안전한 쪽).
    const lastTs = pts[pts.length - 1].x;
    const stale = now - lastTs > staleAfterMs;
    let daysToLimit = null, etaTs = null;
    if (!full && lr.slopePerDay > 0 && cap > current) {
      etaTs = lastTs + ((cap - current) / lr.slopePerDay) * DAY;
      daysToLimit = Math.max(0, Math.round((etaTs - now) / DAY));
    }
    return { current: Number(current.toFixed(1)), slopePerDay: Number(lr.slopePerDay.toFixed(2)), r2: Number(lr.r2.toFixed(2)), daysToLimit, etaTs, lastTs, stale, full };
  };

  // 데이터스토어 포화 예측
  const datastores = [];
  for (const [id, meta] of dsCap) {
    await maybeYield();
    if (!meta.cap) continue;
    const f = fit('ds_usedgb', id, meta.cap);
    if (!f) continue;
    datastores.push({ id, name: meta.name, vcenterId: meta.vc, capacityGB: Math.round(meta.cap), usedGB: Math.round(meta.used || f.current), usagePct: meta.pct, ...f });
  }
  // v2.781(E-B1): 포화(full)가 맨 앞 — 그다음 남은 일수 오름차순, 증가 없음(null)은 맨 뒤. 상한 100 이 가장 급한 항목을 자르지 않게.
  const limitKey = (x) => (x.full ? -1 : (x.daysToLimit ?? 1e9));
  datastores.sort((a, b) => limitKey(a) - limitKey(b));

  // GPU 포화 예측(vCenter 평균 사용률 100% 도달)
  const gpu = [];
  const gpuLatest = db.latestAll('gpu_vc');
  for (const [k] of gpuLatest) {
    await maybeYield();
    if (vcFilter && k !== vcFilter) continue;
    if (allowed && !allowed.has(k)) continue; // scope: 범위 밖 vCenter GPU 예측 유출 차단(확정 버그)
    const f = fit('gpu_vc', k, 100);
    if (!f) continue;
    gpu.push({ vcenterId: k, metric: 'gpu_vc', limit: 100, ...f });
  }
  gpu.sort((a, b) => limitKey(a) - limitKey(b));

  return {
    config: { days, bucketMin: bucketMs / 60_000, minR2, vcenterId: vcFilter || '', source: readRollup ? 'rollup' : 'unavailable', staleAfterMs },
    scannedDatastores: dsCap.size,
    datastores: datastores.slice(0, 100),
    gpu: gpu.slice(0, 100),
    // v2.781(E-B1): 이미 포화된 DS 도 'KPI 30일 내 포화 예상' 에 든다(예전: daysToLimit null 이라 빠져 초록 0).
    soon: datastores.filter((d) => d.full || (d.daysToLimit != null && d.daysToLimit <= 30)).slice(0, 30),
    generatedAt: now,
  };
}
