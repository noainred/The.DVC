/**
 * test/focusMonAvg2979.test.js — v2.979 서버 집중 모니터링 '구간 평균' 은 **시간 평균**이다(반증 1 — 2026-11-12).
 *  보는 화면이 없으면 '계속 수집' 은 10초 주기로 낮추고 화면을 열면 2초로 돌아간다 → 한 구간에 성긴 표본과 촘촘한 표본이 섞인다.
 *  예전 표본 평균은 촘촘한 최근 몇 분 쪽으로 치우쳤다(재현: 실제 %util 23.3 → 화면 50 · 수신 233 → 500 Mbps).
 *  ① sampleWeights: 앞 표본과의 간격 · 첫 표본 · 수집 공백
 *  ② timeAverageIostat: 무게 없으면 예전과 같다 · 무게가 있으면 횟수 · 사용률은 시간 평균, 지연은 요청 수(초당 횟수 × 시간) 가중
 *  ③ serverDetail(at:'avg'): 디스크 · 네트워크 · CPU 가 시간 평균 · 오류 · 드롭은 구간 합(평균 아님) · coverMs = 덮은 시간
 *  ④ procs(at:'avg'): 프로세스 CPU 도 시간 가중
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'focusmonavg2979-'));
process.env.DATA_SOURCE = 'mock';
const store = await import('../src/focusmon/store.js');
const Q = await import('../src/focusmon/query.js');
const R = await import('../src/focusmon/rates.js');
const C = Object.fromEntries(R.IOSTAT_COLS.map((c, i) => [c, i]));
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} ≈ ${b} (±${tol})`);

// 기준 시각: 실제 시각을 분 경계로 떨어뜨려 고정(docs/rules/common.md — Date.now() 직접 · 고정 epoch 둘 다 깨진다)
const END = Math.floor(Date.now() / 60_000) * 60_000 - 1;
const FROM = END - 30 * 60_000;

const mk = (util, rxMbps, wAwait, w, cpu, er) => {
  const v = R.IOSTAT_COLS.map(() => 0); v[C.util] = util; v[C.w] = w; v[C.wAwait] = wAwait; v[C.wMB] = w / 10; v[C.qu] = 0.1; v[C.await] = wAwait;
  return {
    dt: 2, cpu: { pct: cpu, usr: cpu, sys: 0, iow: 0, stl: 0, irq: 0, cores: [cpu] },
    mem: { pct: 10, total: 1e9, used: 1e8, avail: 9e8, bc: 0, free: 0, swT: 0, swU: 0, dirty: 0, slab: 0 },
    net: [{ n: 'eth0', k: 'phys', sp: 10000, st: 'up', m: null, md: null, mem: [], act: null, rx: rxMbps * 1e6, tx: 0, u: rxMbps / 100, er, dr: 0 }],
    dsk: [{ n: 'sda', dn: null, k: 'disk', p: null, mp: '', sz: 1, v, fl: 0 }], dtot: v, nPhys: 1, load: [0, 0, 0], run: 1, blk: 0, thr: 1,
  };
};

test('① sampleWeights — 앞 표본과의 간격 · 첫 표본은 다음 간격 · 60초 넘는 공백은 표본 간격으로', () => {
  const pos = [0, 10_000, 20_000, 22_000, 24_000, 200_000, 202_000].map((t) => [null, null, t]);
  assert.deepEqual(Q.sampleWeights(pos), [10_000, 10_000, 10_000, 2_000, 2_000, 10_000, 2_000], '공백 뒤 표본은 공백 길이가 아니라 표본 간격(p90 = 10초)');
  assert.deepEqual(Q.sampleWeights([[null, null, 5]]), [2_000], '표본 하나면 2초');
  assert.deepEqual(Q.sampleWeights([]), []);
});

test('② timeAverageIostat — 무게 없으면 예전과 같다 · 무게가 있으면 시간 평균 · 지연은 요청 수 × 시간 가중', () => {
  const a = R.IOSTAT_COLS.map(() => 0); a[C.util] = 10; a[C.w] = 50; a[C.wAwait] = 1;
  const b = R.IOSTAT_COLS.map(() => 0); b[C.util] = 90; b[C.w] = 500; b[C.wAwait] = 20;
  const plain = R.timeAverageIostat([a, b]);
  assert.equal(plain[C.util], 50, '무게 없음 = 표본 평균(예전)');
  const tw = R.timeAverageIostat([a, b], [25, 5]);
  near(tw[C.util], (25 * 10 + 5 * 90) / 30, 0.01, '사용률 시간 평균');
  near(tw[C.w], (25 * 50 + 5 * 500) / 30, 0.01, 'w/s 시간 평균');
  near(tw[C.wAwait], (25 * 50 * 1 + 5 * 500 * 20) / (25 * 50 + 5 * 500), 0.01, '지연은 요청 수(초당 × 시간) 가중');
  assert.equal(R.timeAverageIostat([null, a], [5, 0])[C.util], null, '무게 0 · 배열 아님은 뺀다');
});

test('③ serverDetail(at:avg) — 10초 → 2초로 바뀐 30분 구간도 시간 평균 · 오류는 구간 합 · coverMs', async () => {
  const id = 'fm-a2979aaaaa';
  let n = 0;
  for (let t = FROM + 1; t <= END - 5 * 60_000; t += 10_000) { store.ingestSample(id, t, mk(10, 100, 1, 50, 5, 1), null, t); n += 1; }   // 25분 · 10초 · 한가함
  for (let t = END - 5 * 60_000 + 2_000; t <= END; t += 2_000) { store.ingestSample(id, t, mk(90, 900, 20, 500, 95, 1), null, t); n += 1; } // 5분 · 2초 · 바쁨
  const d = await Q.serverDetail(id, { from: FROM, to: END, win: 30, past: true }, { at: 'avg' });
  const dsk = d.table.dsk[0].v; const net = d.table.net[0];
  near(dsk[C.util], (25 * 10 + 5 * 90) / 30, 0.6, '디스크 %util 시간 평균(표본 평균이면 50)');
  near(net.rx / 1e6, (25 * 100 + 5 * 900) / 30, 6, '수신 시간 평균(표본 평균이면 500 Mbps)');
  near(net.u, (25 * 1 + 5 * 9) / 30, 0.1, '사용률 = 순간 사용률의 시간 평균');
  near(d.table.cpu.pct, (25 * 5 + 5 * 95) / 30, 0.6, 'CPU 도 시간 평균');
  near(dsk[C.wAwait], (25 * 60 * 50 * 1 + 5 * 60 * 500 * 20) / (25 * 60 * 50 + 5 * 60 * 500), 0.3, '쓰기 지연은 요청 수 × 시간 가중');
  assert.equal(net.er, n, '오류는 평균이 아니라 구간 합(표본마다 그 간격의 증분)');
  near(d.coverMs, 30 * 60_000, 15_000, '덮은 시간 ≈ 30분');
  assert.equal(d.firstAt, FROM + 1); assert.equal(d.lastAt, END);
  // 구간 끝 순간 모드는 그대로(마지막 표본)
  const e = await Q.serverDetail(id, { from: FROM, to: END, win: 30, past: true }, { at: 'end' });
  assert.equal(e.table.dsk[0].v[C.util], 90); assert.equal(e.coverMs, null, '끝 순간에는 덮은 시간을 싣지 않는다');
});

test('③-2 일부만 수집한 구간 — coverMs 가 그만큼만(화면이 30분 중 몇 분치인지 말한다)', async () => {
  const id = 'fm-a2979bbbbb';
  for (let t = FROM + 1; t <= FROM + 10 * 60_000; t += 2_000) store.ingestSample(id, t, mk(40, 400, 5, 100, 40, 0), null, t);
  const d = await Q.serverDetail(id, { from: FROM, to: END, win: 30, past: true }, { at: 'avg' });
  near(d.coverMs, 10 * 60_000, 5_000, '10분치');
  assert.equal(d.table.dsk[0].v[C.util], 40);
});

test('④ procs(at:avg) — 프로세스 CPU 도 시간 가중(10초 → 2초로 바뀐 구간)', async () => {
  const id = 'fm-a2979ccccc';
  const p = (cpu) => ({ n: 120, top: [{ pid: 100, c: 'java', u: 'app', cpu, sh: null, rss: 1, th: 1, et: 1 }] });
  for (let t = FROM + 1; t <= END - 5 * 60_000; t += 10_000) store.ingestProcs(id, t, p(10));
  for (let t = END - 5 * 60_000 + 2_000; t <= END; t += 2_000) store.ingestProcs(id, t, p(90));
  const r = await Q.procs([id], { from: FROM, to: END, win: 30, past: true }, { at: 'avg' });
  near(r.per[0].top[0].cpu, (25 * 10 + 5 * 90) / 30, 0.8, '프로세스 CPU 시간 평균(스냅샷 평균이면 50)');
});
