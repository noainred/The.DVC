/**
 * test/focusMonCard2992.test.js — v2.992 서버 집중 모니터링 개요 카드 아래 줄 고르기(사용자 2026-11-13 "빨간색 부분에 보이는 것들을 사용자가 선택해서 볼 수 있게 —
 * Disk write/read, Network in/out, disk wait 등등의 값을 표시한 부분에 메뉴를 만들어서 선택해서 볼 수 있게").
 *  ① rates.summaryOf 의 새 칸: 디스크 읽기 · 쓰기(MB/s) · IOPS · 대기열(물리 디스크 합) · CPU I/O 대기 · steal · 부하 1분 · 코어 수 · 스왑 — 못 읽은 값은 null(0 아님)
 *  ② 저장된 묶음에서 다시 만든 표본(query.overview — 메모리 묶음)도 같은 칸을 낸다(새 열을 저장하지 않고 이미 있는 열 t.* · c.* · l.* · m.* 에서)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'focusmoncard2992-'));
process.env.DATA_SOURCE = 'mock';
const store = await import('../src/focusmon/store.js');
const Q = await import('../src/focusmon/query.js');
const R = await import('../src/focusmon/rates.js');
const mock = await import('../src/focusmon/mock.js');

const dtot = (o) => R.IOSTAT_COLS.map((c) => (c in o ? o[c] : null));

test('① summaryOf 새 칸 — 물리 디스크 합 · CPU · 부하 · 스왑 · 못 읽음은 null', () => {
  const s = {
    cpu: { pct: 40, iow: 3.5, stl: 0.4, cores: [1, 2, 3, 4] }, mem: { pct: 60, swU: 2 ** 30, swT: 4 * 2 ** 30 }, load: [1.25, 1, 0.5],
    net: [], dsk: [], dtot: dtot({ r: 120, w: 45, rMB: 12.5, wMB: 4.25, qu: 0.75, rAwait: 1.5, wAwait: 2.5, util: 30 }),
  };
  const x = R.summaryOf(s);
  assert.deepEqual({ rMB: x.rMB, wMB: x.wMB, rIo: x.rIo, wIo: x.wIo, qu: x.qu, iow: x.iow, stl: x.stl, load1: x.load1, cores: x.cores, swU: x.swU, swT: x.swT },
    { rMB: 12.5, wMB: 4.25, rIo: 120, wIo: 45, qu: 0.75, iow: 3.5, stl: 0.4, load1: 1.25, cores: 4, swU: 2 ** 30, swT: 4 * 2 ** 30 });
  assert.equal(x.rAwait, 1.5); assert.equal(x.wAwait, 2.5);
  const e = R.summaryOf({ cpu: { pct: 1 }, mem: null, net: [], dsk: [], dtot: null, load: null });
  for (const k of ['rMB', 'wMB', 'rIo', 'wIo', 'qu', 'iow', 'stl', 'load1', 'cores', 'swU', 'swT']) assert.equal(e[k], null, `${k} 는 못 읽으면 null`);
  assert.equal(R.summaryOf({ cpu: { pct: 1, cores: [] }, dsk: [], net: [] }).cores, null, '코어 칸이 없으면 코어 수도 모름(0 아님)');
  assert.equal(R.summaryOf({ cpu: { pct: 1 }, dsk: [], net: [], dtot: dtot({ r: 0, w: 0, rMB: 0, wMB: 0, qu: 0 }) }).rMB, 0, '잰 0 은 0');
});

test('② 저장 묶음에서 다시 만든 표본(개요)도 같은 칸을 낸다 — 새 저장 열 없이', async () => {
  const id = mock.DEMO_TARGETS[0].id;
  const t0 = Math.floor(Date.now() / 60_000) * 60_000 - 120_000; // 정시 분 경계로 떨어뜨린 기준 시각(2분 전)
  for (let k = 0; k < 4; k++) { const ts = t0 + k * 2_000; store.ingestSample(id, ts, mock.demoSample(id, ts, 2), mock.demoHello(id), ts); }
  const w = { win: 5, end: t0 + 10_000, from: t0 - 60_000, to: t0 + 10_000, past: true };
  const r = await Q.overview([id], w);
  const sum = r.targets[0].sum;
  assert.ok(sum, '요약');
  for (const k of ['rMB', 'wMB', 'rIo', 'wIo', 'qu', 'iow', 'stl', 'load1', 'cores']) assert.equal(typeof sum[k], 'number', `${k} = ${sum[k]}`);
  assert.ok('swU' in sum && 'swT' in sum);
});
