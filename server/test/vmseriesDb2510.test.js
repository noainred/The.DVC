/**
 * v2.510 — vCenter별 독립 스파이크 DB + 조회 회귀.
 *
 * 고정하는 것:
 *  · vCenter 마다 **파일**이 다르다(사용자 요구 "DB 분리하는거 꼭 기억해"). 조회는 그 파일만 본다.
 *  · 커서(cursor)가 재시작에도 살아남아 겹침 구간을 두 번 저장하지 않는다.
 *  · localReportFor: 창 안 순간만, run 횟수·최장 지속·커버리지(미측정 시간 = 표본 0) 계산.
 *  · 순위(topInWindow)는 BLOB 을 풀지 않고 행 집계로 답한다.
 *  · 대상 제외 → 파일째 삭제(용량 즉시 회수).
 *  · 중앙 수신 sanitize: 레이아웃 불일치 BLOB 은 버린다(위조·손상).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vmseries-'));
process.env.VMSERIES_DB_DIR = path.join(tmp, 'vmseries');
process.env.CONFIG_DIR = tmp;

const sqliteOk = await import('node:sqlite').then(() => true).catch(() => false);
const db = await import('../src/vmseries/db.js');
const q = await import('../src/vmseries/query.js');
const { packMoments } = await import('../src/vmseries/spikes.js');
const { VM_COUNTERS } = await import('../src/vmseries/counters.js');
const { dbFileName } = await import('../src/metrics/vmperfDb.js');

const HOUR = 3_600_000;
const NOW = Date.now();
const names = VM_COUNTERS.map((c) => c.name);
const ci = (n) => names.indexOf(n);
const moment = (ts, cpuPct, memPct = 10) => { const v = new Array(names.length).fill(-1); v[ci('cpuUsagePct')] = Math.round(cpuPct * 100); v[ci('cpuUsageMhz')] = Math.round(cpuPct * 48); v[ci('memUsagePct')] = Math.round(memPct * 100); v[ci('memActiveMB')] = 2048 * 1024; return { ts, vals: v }; };

function rowsFor(ref, t0, spikeMoments) {
  const p = packMoments(spikeMoments, names.length);
  return {
    spikes: p ? [{ kind: 'vm', ref, t0: p.t0, t1: p.t1, n: p.n, cols: names, buf: p.buf, mxcpu: Math.max(...spikeMoments.map((m) => m.vals[ci('cpuUsagePct')])), mxmem: -1 }] : [],
    cover: [{ kind: 'vm', ref, h: Math.floor(t0 / HOUR) * HOUR, samples: 180 }],
    cursors: [{ kind: 'vm', ref, lastTs: t0 + 59 * 60_000 }],
  };
}

test('vCenter 별 파일 분리 · 조회는 그 파일만', { skip: !sqliteOk ? 'node:sqlite 미지원' : false }, async () => {
  const t0 = NOW - 3 * HOUR;
  await db.commitVmSeries('vc-a', rowsFor('vm-1', t0, [moment(t0 + 60_000, 80), moment(t0 + 80_000, 85), moment(t0 + 100_000, 70)]));
  await db.commitVmSeries('vc-b', rowsFor('vm-1', t0, [moment(t0 + 60_000, 99)]));
  const files = fs.readdirSync(process.env.VMSERIES_DB_DIR).filter((f) => f.endsWith('.db')).sort();
  assert.deepEqual(files, [`${dbFileName('vc-a')}.db`, `${dbFileName('vc-b')}.db`].sort());
  const a = await q.momentsOf('vc-a', 'vm', 'vm-1', t0, NOW);
  const b = await q.momentsOf('vc-b', 'vm', 'vm-1', t0, NOW);
  assert.equal(a.length, 3); assert.equal(b.length, 1);
  assert.equal(a[0].cpuUsagePct, 80); assert.equal(a[0].memActiveMB, 2048, 'KB → MB');
  assert.equal(a[0].cpuReadyMs, null, '결측은 null');
  assert.equal(await q.momentsOf('vc-none', 'vm', 'vm-1', t0, NOW), null, '파일 없는 vCenter 는 null(생성하지 않는다)');
  assert.ok(!fs.existsSync(path.join(process.env.VMSERIES_DB_DIR, `${dbFileName('vc-none')}.db`)), '조회가 파일을 만들면 안 된다');
});

test('커서는 재시작(핸들 닫힘) 뒤에도 유지된다', { skip: !sqliteOk ? 'node:sqlite 미지원' : false }, async () => {
  const before = await db.loadCursors('vc-a');
  assert.ok(before.get('vm|vm-1') > 0);
  db.closeVmSeriesDb('vc-a');
  const after = await db.loadCursors('vc-a');
  assert.equal(after.get('vm|vm-1'), before.get('vm|vm-1'));
});

test('localReportFor — run·지속·커버리지·피크·빈도 버킷(미측정 표시)', { skip: !sqliteOk ? 'node:sqlite 미지원' : false }, async () => {
  const t0 = NOW - 3 * HOUR;
  const r = await q.localReportFor({ vcenterId: 'vc-a', kind: 'vm', ref: 'vm-1', days: 7, now: NOW, thresholds: { cpuPct: 50, memPct: 50, readyPct: 5 }, vcpu: 4 });
  assert.equal(r.available, true);
  assert.equal(r.runs.count, 1, '60·80·100초 = 20초 간격 연속 → run 1개');
  assert.equal(r.runs.maxSec, 60);
  assert.equal(r.momentCount, 3);
  assert.equal(r.peak.cpuUsagePct.v, 85);
  assert.equal(r.coverage.measuredHours, 1, '표본이 있는 시간은 1시간뿐');
  assert.equal(r.coverage.unmeasuredHours, r.coverage.expectedHours - 1);
  assert.ok(r.coverage.pct > 0 && r.coverage.pct < 2, `7일 중 1시간 = ${r.coverage.pct}%`);
  const bucket = r.freq.find((f) => f.t === Math.floor(t0 / HOUR) * HOUR);
  assert.ok(bucket, '7일 창은 시간 버킷');
  assert.equal(bucket.runs, 1); assert.equal(bucket.measured, true); assert.equal(bucket.maxCpuPct, 85);
  const empty = r.freq.find((f) => f.t === Math.floor((NOW - 10 * HOUR) / HOUR) * HOUR);
  assert.equal(empty.measured, false, '표본 없는 시간은 measured=false(스파이크 0 이 아니라 미측정)');
  const none = await q.localReportFor({ vcenterId: 'vc-a', kind: 'vm', ref: 'vm-zzz', days: 7, now: NOW });
  assert.equal(none.available, true); assert.equal(none.empty, true); assert.equal(none.coverage.samples, 0);
  const nodb = await q.localReportFor({ vcenterId: 'vc-none', kind: 'vm', ref: 'vm-1', days: 7, now: NOW });
  assert.equal(nodb.available, false); assert.equal(nodb.reason, 'no-db');
});

test('topSpikers — 행 집계(BLOB 미해제)로 순위', { skip: !sqliteOk ? 'node:sqlite 미지원' : false }, async () => {
  const top = await q.topSpikers('vc-a', 7, 10, NOW);
  assert.equal(top.length, 1);
  assert.equal(top[0].ref, 'vm-1'); assert.equal(top[0].moments, 3); assert.equal(top[0].mxcpuPct, 85);
});

test('prune · drop — 보존 밖 삭제와 파일째 회수', { skip: !sqliteOk ? 'node:sqlite 미지원' : false }, async () => {
  const old = NOW - 100 * 86_400_000;
  await db.commitVmSeries('vc-a', rowsFor('vm-old', old, [moment(old + 20_000, 90)]));
  assert.equal((await q.momentsOf('vc-a', 'vm', 'vm-old', old - HOUR, NOW)).length, 1);
  const n = await db.pruneVmSeries('vc-a', 60);
  assert.equal(n, 1);
  assert.equal((await q.momentsOf('vc-a', 'vm', 'vm-old', old - HOUR, NOW)).length, 0);
  const removed = db.dropVmSeriesDb('vc-b');
  assert.ok(removed >= 1);
  assert.ok(!fs.existsSync(path.join(process.env.VMSERIES_DB_DIR, `${dbFileName('vc-b')}.db`)));
  assert.equal(await q.momentsOf('vc-b', 'vm', 'vm-1', 0, NOW), null);
});

test('디스크 사용 현황은 인덱스로 원본 id 를 되돌린다', { skip: !sqliteOk ? 'node:sqlite 미지원' : false }, () => {
  const u = db.vmSeriesDiskUsage();
  assert.ok(u.some((x) => x.vcenterId === 'vc-a' && x.bytes > 0));
});
