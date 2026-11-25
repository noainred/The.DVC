/**
 * v2.954(점검 B-1) — 용량 예측 상세 맞춤선(fits)이 반올림 오차로 밀리지 않는다.
 *   x 가 1970 기준 날짜 번호(≈20,400)라 기울기를 소수 3자리로 자르면 그 오차 × x 만큼 맞춤선 높이가 밀렸다(재현: −9.5%p).
 *   응답의 intercept + slope × 날짜번호(웹 capChart 와 같은 식)가 반올림 전 linFit 값과 같아야 한다.
 * 기준 시각: 실제 시각을 정시로 떨어뜨린 기준(common.md).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bmcapfit-'));
process.env.CONFIG_DIR = DIR;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;

test('B-1 맞춤선 — 응답 값으로 계산한 마지막 날 높이가 실제 맞춤선과 0.01%p 안', async () => {
  const C = await import('../src/bmusage/capacity.js');
  const { dayKey } = await import('../src/util/dayKey.js');
  const today = dayKey(NOW);
  const t0 = C.dayNum(today);
  const slope = 0.5234567;
  const mrows = [];
  for (let b = 13; b >= 0; b -= 1) {
    const x = t0 - b;
    mrows.push({ day: new Date(x * 86_400_000).toISOString().slice(0, 10), mount: '/data', used_pct_max: 60 + slope * (13 - b), inode_pct_max: 3, size_bytes: 1e12 });
  }
  const monthStore = {
    readMountDaily: async () => ({ rows: mrows }),
    readDailyRange: async () => ({ live: [], mig: [] }),
  };
  const r = await C.computeServer({ agent: '', target: { key: 'K1', paths: ['os'] }, now: NOW, series: true, xfs: new Set(), deps: { monthStore } });
  assert.equal(r.ok, true);
  const f = r.fits['fs:/data'];
  assert.ok(f, JSON.stringify(r.fits));
  const truth = C.linFit(mrows.map((m) => ({ x: C.dayNum(m.day), y: m.used_pct_max })));
  const at = (k) => f.intercept + f.slope * k;   // 웹 capChart 와 같은 식
  for (const k of [t0 - 13, t0, t0 + 14]) {
    const want = truth.intercept + truth.slope * k;
    assert.ok(Math.abs(at(k) - want) < 0.01, `날짜 ${k}: 응답 ${at(k)} · 실제 ${want}`);
  }
  // 마지막 관측값(≈66.8%) 근처에서 출발 — 반올림 판본은 ≈57% 였다.
  assert.ok(Math.abs(at(t0) - (60 + slope * 13)) < 0.01);
});
