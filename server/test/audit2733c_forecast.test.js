/**
 * v2.733 점검 3회차 그룹 c — C2-07: 용량 예측(insights/forecast.js fit)이 마지막 표본의 나이를 무시했다.
 *   `current = 마지막 점`, `etaTs = now + 남은 일수` 라 5일 전 수집이 멈춘 데이터스토어는 그 5일 동안의 증가가 빠진 채
 *   **오늘부터** 소진일을 셌다 — 재현: 같은 추세(하루 +10GB)에서 신선한 DS 는 36일, 멈춘 DS 는 41일(정답 36일).
 *   남은 시간을 더 많이 말하는, 위험한 방향이다.
 * 규칙: 마지막 점 시각(lastTs)을 싣고 ETA 기준을 lastTs 로 한다(daysToLimit 은 여전히 '지금부터' — 이미 지났으면 0).
 *   지금 − lastTs 가 max(버킷, 표본 주기) × 3 을 넘으면 stale:true(신선하면 마지막 버킷 시작은 한 버킷 안이다 — 여유 두 버킷).
 *   신선한 쪽 나이 단언은 2.5시간까지 허용한다 — 모듈이 부르는 시점에 정시를 넘기면 1시간이 더해진다(경계 플래키 방지).
 *
 * ⚠ 기준 시각은 정시에서 30분 떨어뜨려 고정한다(v2.517 규약 — 버킷 경계에 걸려 시각에 따라 깨지지 않게). 실제 metrics DB 로 본다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'a2733c-fc-'));
process.env.CONFIG_DIR = CFG;
process.env.DATA_SOURCE = 'mock';
after(() => { try { fs.rmSync(CFG, { recursive: true, force: true }); } catch { /* 정리 실패는 결과와 무관 */ } });

const H = 3_600_000, D = 86_400_000;
const BASE = Math.floor(Date.now() / H) * H - 30 * 60_000;   // 항상 과거 · 정시에서 30분 떨어짐
const START = BASE - 14 * D;
const STOP = BASE - 5 * D;                                    // stale-ds 는 여기서 수집이 멈췄다
const used = (t) => 500 + ((t - START) / D) * 10;            // 하루 +10GB, 용량 1000GB

let seeded = false;
async function seed() {
  if (seeded) return;
  const { getMetricsDb } = await import('../src/metrics/db.js');
  const db = await getMetricsDb();
  for (let t = START; t <= BASE; t += H) {
    const rows = [{ metric: 'ds_usedgb', k: 'vcF:ds-fresh', v: used(t) }];
    if (t <= STOP) rows.push({ metric: 'ds_usedgb', k: 'vcS:ds-stale', v: used(t) });
    db.insertMany(rows, t);
  }
  seeded = true;
}
const SNAP = { datastores: [
  { id: 'vcS:ds-stale', name: 'stale-ds', vcenterId: 'vcS', capacityGB: 1000, usedGB: 590, usagePct: 59 },
  { id: 'vcF:ds-fresh', name: 'fresh-ds', vcenterId: 'vcF', capacityGB: 1000, usedGB: 640, usagePct: 64 },
] };

test('C2-07 마지막 표본이 5일 전인 DS — ETA 기준은 lastTs, 남은 일수는 신선한 DS 와 같은 추세면 같다 · stale 표지', async () => {
  await seed();
  const { forecastCapacity } = await import('../src/insights/forecast.js');
  const r = await forecastCapacity(SNAP, { days: 14 });
  const st = r.datastores.find((d) => d.id === 'vcS:ds-stale');
  const fr = r.datastores.find((d) => d.id === 'vcF:ds-fresh');
  assert.ok(st && fr, JSON.stringify(r.datastores));
  // 같은 추세 — 소진 시점은 같아야 한다. 예전: stale 41일 vs fresh 36일
  assert.ok(Math.abs(st.daysToLimit - fr.daysToLimit) <= 1, `멈춘 DS 가 남은 시간을 더 길게 말했다: stale ${st.daysToLimit}일 vs fresh ${fr.daysToLimit}일`);
  assert.ok(Math.abs(st.etaTs - fr.etaTs) < D, `ETA 가 ${((st.etaTs - fr.etaTs) / D).toFixed(1)}일 어긋났다`);
  assert.ok(fr.daysToLimit >= 35 && fr.daysToLimit <= 37, `fresh ${fr.daysToLimit}`);
  // 마지막 점 시각·신선도
  assert.equal(st.lastTs, Math.floor(STOP / H) * H, 'lastTs = 마지막 버킷 시작');
  assert.equal(st.stale, true);
  assert.equal(fr.stale, false);
  assert.ok(r.generatedAt - fr.lastTs <= 2.5 * H, `fresh lastTs 가 너무 오래됐다: ${(r.generatedAt - fr.lastTs) / H}시간`);
  assert.ok(Number.isFinite(r.config.staleAfterMs) && r.config.staleAfterMs >= 3 * H, '신선도 경계를 응답이 말한다');
});

test('C2-07 마지막 점에서 센 소진일이 이미 지났으면 daysToLimit 은 0(음수 아님) · soon 목록에 남는다', async () => {
  const { getMetricsDb } = await import('../src/metrics/db.js');
  const db = await getMetricsDb();
  // 30일 전 ~ 20일 전에 하루 +20GB 로 900 → 용량 1000 은 마지막 점에서 5일 뒤 = 이미 15일 전에 지났을 추세
  const s0 = BASE - 30 * D, s1 = BASE - 20 * D;
  for (let t = s0; t <= s1; t += H) db.insertMany([{ metric: 'ds_usedgb', k: 'vcO:ds-old', v: 700 + ((t - s0) / D) * 20 }], t);
  const { forecastCapacity } = await import('../src/insights/forecast.js');
  const r = await forecastCapacity({ datastores: [{ id: 'vcO:ds-old', name: 'old', vcenterId: 'vcO', capacityGB: 1000, usedGB: 900, usagePct: 90 }] }, { days: 40 });
  const d = r.datastores.find((x) => x.id === 'vcO:ds-old');
  assert.ok(d, JSON.stringify(r));
  assert.equal(d.stale, true);
  assert.equal(d.daysToLimit, 0, `이미 지났을 추세를 ${d.daysToLimit}일 남았다고 말했다`);
  assert.ok(d.etaTs < r.generatedAt, 'ETA 는 과거 시각(마지막 점 + 남은 일수)');
  assert.ok(r.soon.some((x) => x.id === 'vcO:ds-old'), '곧 찰 목록에서 빠지지 않는다');
});
