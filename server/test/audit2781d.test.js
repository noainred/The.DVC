/**
 * v2.781 점검 그룹 G4 — E-B1: 용량 예측(insights/forecast.js fit)에서 이미 한계에 닿은(current ≥ 용량) 항목이
 *   `daysToLimit: null` 로 나가 '증가 없음(안정)' 과 구별되지 않았다.
 *   ① 정렬키 `daysToLimit ?? 1e9` 로 맨 뒤 → 증가 중인 DS 가 100개를 넘으면 slice(0,100) 에서 **가장 급한 DS 가 잘렸다**
 *   ② KPI '30일 내 포화 예상 DS'(soon)가 `daysToLimit != null` 만 세어 꽉 찬 DS 를 빼고 초록 0 을 보였다
 *   ③ GPU vCenter 평균이 100% 에 닿으면 웹이 '안정' 으로 그렸다(웹 절반은 web/src/views/forecastRowText.test.js).
 *   재현(감사 forecastFull.mjs·fcNoise.mjs): 증가 DS 105개 + 꽉 찬 DS 1개 → 목록 100개에 FULL 없음 · soon 에 없음 ·
 *   GPU 80→100% 멈춤 → daysToLimit null.
 * 규칙: daysToLimit 은 null 그대로(웹 계약 유지 — '남은 일수' 를 지어내지 않는다) + `full: true`. 정렬은 full 이 맨 앞,
 *   soon 은 `full ||`. 포화 판정은 R² 필터보다 **앞**이다 — 꽉 찬 채 흔들리는 시계열(추세 신뢰도가 낮음)도 '지금 꽉 찼다' 는
 *   사실은 회귀와 무관하다(마지막 버킷 평균이 용량 이상). 꽉 차지 않은 흔들리는 시계열은 여전히 R² 로 걸러진다.
 *
 * ⚠ 기준 시각은 정시에서 30분 떨어뜨려 고정한다(v2.517 규약). 실제 metrics DB 로 본다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'a2781d-fc-'));
process.env.CONFIG_DIR = CFG;
process.env.DATA_SOURCE = 'mock';
after(() => { try { fs.rmSync(CFG, { recursive: true, force: true }); } catch { /* 정리 실패는 결과와 무관 */ } });

const H = 3_600_000, D = 86_400_000;
const BASE = Math.floor(Date.now() / H) * H - 30 * 60_000;   // 항상 과거 · 정시에서 30분 떨어짐
const START = BASE - 14 * D;
const N_GROW = 105;

const growDs = Array.from({ length: N_GROW }, (_, i) => ({ id: `vcA:ds-g${i}`, name: `grow${i}`, vcenterId: 'vcA', capacityGB: 1000, usedGB: 500, usagePct: 50 }));
const FULL = { id: 'vcA:ds-full', name: 'FULL', vcenterId: 'vcA', capacityGB: 1000, usedGB: 1000, usagePct: 100 };
const STOPPED = { id: 'vcB:ds-stopped', name: 'STOPPED', vcenterId: 'vcB', capacityGB: 1000, usedGB: 1000, usagePct: 100 };
const NOISYFULL = { id: 'vcC:ds-noisyfull', name: 'NOISYFULL', vcenterId: 'vcC', capacityGB: 1000, usedGB: 1000, usagePct: 100 };
const NOISY = { id: 'vcC:ds-noisy', name: 'NOISY', vcenterId: 'vcC', capacityGB: 1000, usedGB: 900, usagePct: 90 };

let seeded = false;
async function seed() {
  if (seeded) return;
  const { getMetricsDb } = await import('../src/metrics/db.js');
  const db = await getMetricsDb();
  for (let t = START; t <= BASE; t += H) {
    const day = (t - START) / D;
    const even = Math.round((BASE - t) / H) % 2 === 0;           // 마지막 점(BASE)이 짝수 — 흔들림의 '높은' 쪽
    const rows = [];
    for (let i = 0; i < N_GROW; i++) rows.push({ metric: 'ds_usedgb', k: `vcA:ds-g${i}`, v: 300 + day * (5 + i * 0.1) });
    rows.push({ metric: 'ds_usedgb', k: FULL.id, v: 1000 + day * 0.0001 });            // 꽉 참(아주 미세 증가)
    rows.push({ metric: 'ds_usedgb', k: STOPPED.id, v: Math.min(1000, 800 + day * 30) }); // 증가하다 7일째 1000/1000 에서 멈춤
    rows.push({ metric: 'ds_usedgb', k: NOISYFULL.id, v: even ? 1000 : 990 });        // 꽉 찬 채 흔들림(R² ≈ 0)
    rows.push({ metric: 'ds_usedgb', k: NOISY.id, v: even ? 900 : 890 });            // 꽉 차지 않은 흔들림 — 여전히 걸러진다
    rows.push({ metric: 'gpu_vc', k: 'vcG', v: Math.min(100, 80 + day * 3) });        // 7일째부터 100% 고정
    rows.push({ metric: 'gpu_vc', k: 'vcH', v: 40 + day * 1 });                       // 증가 중(아직 한계 아래)
    db.insertMany(rows, t);
  }
  seeded = true;
}

test('E-B1 증가 DS 가 100개를 넘어도 꽉 찬 DS 는 목록 맨 앞·soon 에 있다', async () => {
  await seed();
  const { forecastCapacity } = await import('../src/insights/forecast.js');
  const r = await forecastCapacity({ datastores: [...growDs, FULL] }, { days: 14 });
  assert.equal(r.datastores.length, 100, '상한 100');
  const f = r.datastores.find((d) => d.id === FULL.id);
  assert.ok(f, '가장 급한(꽉 찬) DS 가 상한 100 에서 잘렸다');
  assert.equal(f.full, true);
  assert.equal(f.daysToLimit, null, '남은 일수를 지어내지 않는다(웹 계약 유지)');
  assert.equal(r.datastores[0].id, FULL.id, '정렬 맨 앞');
  assert.ok(r.soon.some((d) => d.id === FULL.id), "KPI '30일 내 포화 예상 DS' 에서 빠졌다");
  // 증가 중인 DS 에는 full 표지가 없다(false) — 정렬은 여전히 daysToLimit 오름차순
  const grow = r.datastores.filter((d) => d.id !== FULL.id);
  assert.ok(grow.every((d) => d.full === false && Number.isFinite(d.daysToLimit)));
  for (let i = 1; i < grow.length; i++) assert.ok(grow[i - 1].daysToLimit <= grow[i].daysToLimit);
});

test('E-B1 증가하다 1000/1000 에서 멈춘 DS(100개 절단 없이) — full · soon 에 든다', async () => {
  await seed();
  const { forecastCapacity } = await import('../src/insights/forecast.js');
  const r = await forecastCapacity({ datastores: [STOPPED] }, { days: 14 });
  const s = r.datastores.find((d) => d.id === STOPPED.id);
  assert.ok(s, JSON.stringify(r.datastores));
  assert.equal(s.current, 1000);
  assert.equal(s.full, true);
  assert.equal(s.daysToLimit, null);
  assert.equal(s.etaTs, null);
  assert.deepEqual(r.soon.map((d) => d.id), [STOPPED.id]);
});

test('E-B1 꽉 찬 채 흔들리는 DS 는 R² 가 낮아도 포화로 남고, 꽉 차지 않은 흔들림은 여전히 걸러진다', async () => {
  await seed();
  const { forecastCapacity } = await import('../src/insights/forecast.js');
  const r = await forecastCapacity({ datastores: [NOISYFULL, NOISY] }, { days: 14 });
  const nf = r.datastores.find((d) => d.id === NOISYFULL.id);
  assert.ok(nf, '꽉 찬 DS 가 R² 필터에서 사라졌다');
  assert.equal(nf.full, true);
  assert.ok(nf.r2 < r.config.minR2, `재현 전제: 흔들림의 R² 가 낮아야 한다(${nf.r2})`);
  assert.ok(!r.datastores.some((d) => d.id === NOISY.id), 'R² 필터(신뢰도)는 꽉 차지 않은 항목에 그대로');
  assert.ok(r.soon.some((d) => d.id === NOISYFULL.id));
});

test('E-B1 GPU vCenter 평균 100% — full · 정렬 맨 앞(증가 중인 vCenter 보다 앞)', async () => {
  await seed();
  const { forecastCapacity } = await import('../src/insights/forecast.js');
  const r = await forecastCapacity({ datastores: [] }, { days: 14 });
  const g = r.gpu.find((x) => x.vcenterId === 'vcG');
  const h = r.gpu.find((x) => x.vcenterId === 'vcH');
  assert.ok(g && h, JSON.stringify(r.gpu));
  assert.equal(g.current, 100);
  assert.equal(g.full, true);
  assert.equal(g.daysToLimit, null);
  assert.equal(h.full, false);
  assert.ok(Number.isFinite(h.daysToLimit));
  assert.equal(r.gpu[0].vcenterId, 'vcG');
});
