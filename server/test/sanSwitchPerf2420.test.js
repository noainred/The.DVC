/**
 * v2.420 — SAN 포트 사용량 분석: 평균/피크 기준, 기간 지정(from/to), 보관 즉시 정리.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sansw2420-'));

test('rangeParams: hours 기본, from/to 우선, 역전·366일 초과는 24h 로 되돌리며 issue 표시', async () => {
  const { rangeParams } = await import('../src/routes/api/sanSwitch.js');
  assert.deepEqual(rangeParams({}), { hours: 24, from: null, to: null });
  assert.equal(rangeParams({ hours: '99999' }).hours, 24 * 90);
  const now = Date.now();
  const r = rangeParams({ from: String(now - 3600_000 * 5), to: String(now) });
  assert.equal(r.from, now - 3600_000 * 5); assert.equal(r.to, now); assert.equal(r.hours, 5);
  // ISO 문자열도 허용
  const iso = rangeParams({ from: new Date(now - 7200_000).toISOString(), to: new Date(now).toISOString() });
  assert.equal(iso.hours, 2);
  // to 만 없으면 지금까지
  const onlyFrom = rangeParams({ from: String(now - 3600_000) });
  assert.ok(onlyFrom.to >= now && onlyFrom.from === now - 3600_000);
  // 역전
  const rev = rangeParams({ from: String(now), to: String(now - 1000) });
  assert.equal(rev.from, null); assert.match(rev.issue, /늦/);
  // 366일 초과
  const big = rangeParams({ from: String(now - 400 * 86400_000), to: String(now) });
  assert.equal(big.from, null); assert.match(big.issue, /366/);
});

test('rangeOf: from/to 는 그 구간, hours 는 지금까지 — 버킷 폭은 구간/120(하한 60초)', async () => {
  const { rangeOf } = await import('../src/sanswitch/perfDb.js');
  const a = rangeOf({ hours: 24 });
  assert.equal(a.bucketMs, 720_000, '24h/120 = 12분');
  const b = rangeOf({ hours: 1 });
  assert.equal(b.bucketMs, 60_000, '1h/120 = 30초 → 하한 60초');
  const from = 1_000_000_000_000, to = from + 12 * 3600_000;
  const c = rangeOf({ from, to });
  assert.equal(c.since, from); assert.equal(c.until, to); assert.equal(c.bucketMs, 360_000); assert.equal(c.spanHours, 12);
});

test('storageSeries/Multi: 피크 시리즈는 버킷 안 포트별 MAX 의 합, 평균 시리즈는 AVG 의 합 — 피크 ≥ 평균', async () => {
  const { savePerfSample, storageSeries, storageSeriesMulti, portSeries, available, _resetForTest } = await import('../src/sanswitch/perfDb.js');
  if (!(await available())) return;
  _resetForTest();
  const now = Date.now();
  const NAME = 'SYMMETRIX::000497700230::SAF-1d 4::FC';
  const meta = [{ port: 0, attachedName: NAME, speed: '16G' }, { port: 1, attachedName: NAME, speed: '16G' }];
  // 같은 버킷(1시간 조회 → 60초 버킷) 안에 표본 2개: 포트0 100/300, 포트1 50/150 → AVG 합 300, MAX 합 450
  const base = Math.floor(now / 60_000) * 60_000 - 120_000; // 확실히 과거의 버킷 시작
  await savePerfSample('sw-p', base + 1000, { 0: 100, 1: 50 }, meta);
  await savePerfSample('sw-p', base + 30_000, { 0: 300, 1: 150 }, meta);
  const s = await storageSeries('sw-p', { hours: 1 });
  const sym = s.series.find((x) => x.key.startsWith('SYMMETRIX'));
  const i = sym.sum.findIndex((v) => v != null);
  assert.equal(sym.sum[i], 300); assert.equal(sym.peak[i], 450);
  assert.equal(sym.maxTotal, 300); assert.equal(sym.peakTotal, 450); assert.equal(sym.peakAvg, 450);
  assert.ok(sym.peakTotal >= sym.maxTotal);
  const m = await storageSeriesMulti(['sw-p'], { hours: 1 });
  const ms = m.series.find((x) => x.key.startsWith('SYMMETRIX'));
  assert.equal(ms.peakTotal, 450); assert.equal(ms.maxTotal, 300);
  assert.ok(m.until > 0 && s.until > 0, 'until 을 돌려준다');
  // 포트별 시계열도 peak 배열을 갖는다
  const p = await portSeries('sw-p', { hours: 1 });
  const p0 = p.series.find((x) => x.port === 0);
  assert.equal(p0.peak.find((v) => v != null), 300); assert.equal(p0.avg.find((v) => v != null), 200);
  // from/to 로 그 구간만: 표본 이전 구간을 지정하면 비어 있다
  const empty = await storageSeries('sw-p', { from: base - 3600_000, to: base - 1000 });
  assert.equal(empty.series.length, 0);
  _resetForTest();
});

test('pruneNow: 보관 기간 밖 표본을 즉시 삭제하고 삭제 행 수를 돌려준다', async () => {
  const { savePerfSample, pruneNow, perfDbStats, available, _resetForTest } = await import('../src/sanswitch/perfDb.js');
  if (!(await available())) return;
  _resetForTest();
  const now = Date.now();
  const meta = [{ port: 0, attachedName: 'X', speed: '16G' }];
  await savePerfSample('sw-q', now - 10 * 86400_000, { 0: 1 }, meta, 3650);
  await savePerfSample('sw-q', now, { 0: 1 }, meta, 3650);
  const st1 = await perfDbStats();
  assert.ok(st1.rows >= 2 && st1.fileBytes > 0 && st1.rowsLastDay >= 1);
  const r = await pruneNow(5);
  assert.equal(r.deleted, 1);
  const st2 = await perfDbStats();
  assert.equal(st2.rows, st1.rows - 1);
  _resetForTest();
});
