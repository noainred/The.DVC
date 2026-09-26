/**
 * audit2620b.test.js — v2.620 서버 축 감사 SRV2620-02·03·05·06·07 회귀 고정.
 *
 *  02 dead-band(온도 원본 생략) 이후 원본을 직접 읽던 짧은 창 평균·1시간 미만 버킷이 안정 구간을 '없음' 으로 읽던 것
 *  03 낡은(stale·unreachable) vCenter 의 마지막 값을 샘플러가 '지금 값' 으로 적재하던 것(평탄선) + 부분 합 전체('')
 *  05 iDRAC 스캔 주기의 로드 경로가 파일 값을 그대로 쓰던 것(1초 주기 전 대역 프로빙)
 *  06 Isilon 풀 전체 용량 결측을 0 바이트로 싣던 것
 *  07 로그 분석 버퍼 항목 time:'' 가 1970 이 되던 것
 *
 * 기준 시각은 Date.now() 를 그대로 쓰지 않는다 — 정시 −30분으로 고정해 분·시 경계에서 떨어뜨린다(CLAUDE.md v2.517 규약).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2620b-'));
process.env.CONFIG_DIR = DIR;
process.env.TEMP_DB_PATH = path.join(DIR, 'host-temp.db');
// SRV2620-05: 손으로 고친(또는 복원된) 설정 파일 — 1초 주기.
fs.writeFileSync(path.join(DIR, 'idrac-scan-settings.json'), JSON.stringify({ intervalMs: 1000 }));

const HOUR = 3_600_000;
const MIN = 60_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * MIN; // 항상 과거 · 시 경계에서 30분

const { getMetricsDb, stepWindowAvg, stepBuckets } = await import('../src/metrics/db.js');

/* ── SRV2620-02 ─────────────────────────────────────────────────────────── */

test('★ 02 짧은 창 평균 — 안정된 호스트(0.5℃ 미만 진동)도 값이 나온다(예전: 창 안 저장 행 0 → 빠짐)', async () => {
  const db = await getMetricsDb();
  assert.equal(db.kind, 'sqlite');
  for (let i = 20; i >= 0; i--) {
    db.insertMany([
      { metric: 'temp_host', k: 'stable', v: i % 2 ? 27.0 : 27.2 },
      { metric: 'temp_host', k: 'moving', v: 30 + (i % 2) },
    ], NOW - i * MIN);
  }
  const since = NOW - 5 * MIN;
  const raw = db.recentAvg('temp_host', since);
  assert.equal(raw.has('stable'), false, '전제: 원본만 보면 안정 호스트는 창 안 행이 0 이다(dead-band)');
  const m = db.recentAvgStep('temp_host', since, { nowTs: NOW });
  assert.ok(m.has('stable'), '안정 호스트가 평균에서 빠졌다 — 창 직전 저장 행을 이월해야 한다');
  const s = m.get('stable');
  assert.ok(s.avg >= 27.0 && s.avg <= 27.2, `이월 평균 ${s.avg}`);
  assert.equal(s.carried, true, '이월했다는 사실을 밝혀야 한다');
  const mv = m.get('moving');
  assert.ok(mv.avg > 30 && mv.avg < 31, `변하는 호스트 평균 ${mv.avg}`);
  assert.equal(mv.max, 31);
});

test('★ 02 1분 버킷 추이 — 안정 구간을 직전 값으로 채우고(carried) 채운 수를 밝힌다', async () => {
  const db = await getMetricsDb();
  const r = db.historyStep('temp_host', 'stable', NOW - 10 * MIN, MIN, 5000, { nowTs: NOW });
  assert.equal(r.stepped, true);
  assert.ok(r.points.length >= 10, `점 ${r.points.length}개 — 안정 구간이 비었다`);
  assert.ok(r.carried >= 9, `채운 점 ${r.carried}`);
  assert.ok(r.points.every((p) => p.avg >= 27.0 && p.avg <= 27.2));
  assert.equal(r.maxGapMs, 30 * MIN);
  // 60분 이상 버킷은 롤업(전량) — step 을 쓰지 않는다
  const h = db.historyStep('temp_host', 'stable', NOW - 2 * HOUR, HOUR, 100, { nowTs: NOW });
  assert.equal(h.stepped, false);
  // dead-band 가 없는 계열은 그대로
  assert.equal(db.historyStep('ds_usedgb', 'x', NOW - HOUR, MIN, 100, { nowTs: NOW }).stepped, false);
});

test('02 step 은 죽은 대상을 되살리지 않는다 — 창 안 실제 샘플이 없으면 null, 수집 공백은 잇지 않는다', () => {
  // 마지막 실제 샘플이 창 이전 → 평균 없음
  assert.equal(stepWindowAvg({ carry: { v: 27, ts: NOW - 20 * MIN }, rows: [], sinceTs: NOW - 5 * MIN, nowTs: NOW, last: { v: 27, ts: NOW - 20 * MIN } }), null);
  // 최신값을 모르면 이월만으로 지금 값을 만들지 않는다
  assert.equal(stepWindowAvg({ carry: { v: 27, ts: NOW - 20 * MIN }, rows: [], sinceTs: NOW - 5 * MIN, nowTs: NOW, last: null }), null);
  // 시간 가중: 창 5분 중 앞 4분 20℃ · 뒤 1분 30℃ → 22℃
  const w = stepWindowAvg({ carry: { v: 20, ts: NOW - 10 * MIN }, rows: [{ v: 30, ts: NOW - MIN }], sinceTs: NOW - 5 * MIN, nowTs: NOW, last: { v: 30, ts: NOW } });
  assert.equal(w.avg, 22); assert.equal(w.max, 30); assert.equal(w.carried, true);
  // 저장 행 사이 2시간 공백(수집 중단) — maxGap(30분)+여유(5분)를 넘는 구간은 채우지 않는다
  const b = stepBuckets({ carry: null, rows: [{ v: 25, ts: NOW - 3 * HOUR }, { v: 26, ts: NOW - HOUR }], start: NOW - 3 * HOUR, nowTs: NOW, bucketMs: 10 * MIN, maxGapMs: 30 * MIN, lastActualTs: NOW - HOUR });
  const inGap = b.points.filter((p) => p.ts > NOW - 3 * HOUR + 40 * MIN && p.ts < NOW - HOUR);
  assert.equal(inGap.length, 0, '수집이 멈춘 구간을 이월로 이었다');
  // 마지막 저장 행 이후는 실제 마지막 샘플 시각까지만
  assert.ok(b.points.every((p) => p.ts <= NOW - HOUR), '실제 마지막 샘플 이후를 채웠다');
});

test('02 라우트 — 짧은 창은 recentAvgStep, 1시간 미만 버킷은 historyStep 을 쓰고 새 필드로 밝힌다', () => {
  const src = stripComments(fs.readFileSync(path.join(SRC, 'routes/api/toolsCapacity.js'), 'utf8'));
  const tempBlock = src.slice(src.indexOf("api.get('/tools/esxi-temp'"), src.indexOf("api.post('/tools/esxi-temp/spark'"));
  assert.match(tempBlock, /recentAvgStep\(/);
  assert.match(tempBlock, /historyStep\(/);
  assert.match(tempBlock, /avgMethod:/);
  assert.match(tempBlock, /stepFilled/);
  assert.match(tempBlock, /avg5C:/, '화면 계약 필드명(avg5C)은 유지');
});

test('★ 02 라우트 실호출 — /tools/esxi-temp/history?bucket=minute 가 안정 구간을 점으로 채운다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2620b-route-'));
  const script = `
    const { getMetricsDb } = await import(${JSON.stringify(path.join(SRC, 'metrics/db.js'))});
    const db = await getMetricsDb();
    const now = Date.now();
    for (let i = 20; i >= 0; i--) db.insertMany([{ metric: 'temp_host', k: 'h1', v: i % 2 ? 27.0 : 27.2 }], now - i * 60000);
    const express = (await import('express')).default;
    const { api } = await import(${JSON.stringify(path.join(SRC, 'routes/api.js'))});
    const app = express();
    app.use((req, _res, next) => { req.user = { username: 'u', role: 'admin', scope: null }; next(); });
    app.use('/api', api);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const r = await fetch('http://127.0.0.1:' + srv.address().port + '/api/tools/esxi-temp/history?level=host&key=h1&days=1&bucket=minute');
    const b = await r.json(); srv.close();
    console.log('@@' + JSON.stringify({ status: r.status, n: b.points.length, stepFilled: b.stepFilled, synthesized: b.synthesized, gap: b.deadbandMaxGapMs }));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, TEMP_DB_PATH: path.join(dir, 't.db'), DATA_SOURCE: 'mock', AUTH_ENABLED: 'false' },
    encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 120_000,
  });
  assert.equal(r.status, 0, r.stderr);
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, r.stdout.slice(-600));
  const o = JSON.parse(line.slice(2));
  assert.equal(o.status, 200);
  assert.equal(o.synthesized, false, '실측이 1점뿐이라 목 합성으로 떨어졌다(안정 구간이 비었다)');
  assert.ok(o.n >= 15, `점 ${o.n}개`);
  assert.ok(o.stepFilled >= 10, `stepFilled ${o.stepFilled}`);
  assert.equal(o.gap, 30 * MIN);
});

test('★ 02 라우트 실호출 — /tools/esxi-temp 의 짧은 창 평균이 안정 호스트에도 값을 낸다(avgCarried·avgMethod)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2620b-temp-'));
  const script = `
    const { store } = await import(${JSON.stringify(path.join(SRC, 'store.js'))});
    await store.refresh({ force: true });
    const h = (store.get().hosts || []).find((x) => x.tempC != null);
    const { getMetricsDb } = await import(${JSON.stringify(path.join(SRC, 'metrics/db.js'))});
    const db = await getMetricsDb();
    const now = Date.now();
    for (let i = 20; i >= 0; i--) db.insertMany([{ metric: 'temp_host', k: h.id, v: i % 2 ? 27.0 : 27.2 }], now - i * 60000);
    const express = (await import('express')).default;
    const { api } = await import(${JSON.stringify(path.join(SRC, 'routes/api.js'))});
    const app = express();
    app.use((req, _res, next) => { req.user = { username: 'u', role: 'admin', scope: null }; next(); });
    app.use('/api', api);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const r = await fetch('http://127.0.0.1:' + srv.address().port + '/api/tools/esxi-temp?vcenterId=' + encodeURIComponent(h.vcenterId));
    const b = await r.json(); srv.close();
    const row = (b.hosts || []).find((x) => x.id === h.id);
    console.log('@@' + JSON.stringify({ status: r.status, method: b.avgMethod, avg: row && row.avg5C, carried: row && row.avgCarried }));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, TEMP_DB_PATH: path.join(dir, 't.db'), DATA_SOURCE: 'mock', AUTH_ENABLED: 'false' },
    encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 120_000,
  });
  assert.equal(r.status, 0, r.stderr);
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, r.stdout.slice(-600));
  const o = JSON.parse(line.slice(2));
  assert.equal(o.status, 200);
  assert.equal(o.method, 'step');
  assert.ok(o.avg >= 27.0 && o.avg <= 27.2, `avg5C ${o.avg} — 안정 호스트가 '—' 였다`);
  assert.equal(o.carried, true);
});

test('02 roomTempSeries 1d 주석 — "1분 샘플이라 촘촘" 은 dead-band 이후 사실이 아니다', () => {
  const src = fs.readFileSync(path.join(SRC, 'idrac/roomTempSeries.js'), 'utf8');
  assert.doesNotMatch(src, /1분 샘플이라 촘촘/);
});

/* ── SRV2620-03 ─────────────────────────────────────────────────────────── */

const { vmAllocRows, staleVcenterIds } = await import('../src/metrics/sampler.js');
const snapOf = (vcs) => ({
  vcenters: vcs,
  hosts: vcs.map((vc) => ({ id: `h-${vc.id}`, vcenterId: vc.id, name: `esx-${vc.id}`, cpuCores: 10, cpuTotalMhz: 20000, tempC: 31 })),
  vms: vcs.map((vc) => ({ id: `v-${vc.id}`, vcenterId: vc.id, host: `esx-${vc.id}`, powerState: 'POWERED_ON', memMB: 4096, memUsagePct: 50, cpuCount: 2, cpuUsagePct: 40, storageGB: 10 })),
  datastores: vcs.map((vc) => ({ id: `d-${vc.id}`, vcenterId: vc.id, capacityGB: 100, usedGB: 50 })),
});
const ALL = { enabled: true, vcenterIds: [], trackTotal: true };

test('★ 03 수집 실패 이월(unreachable+stale) vCenter 는 VM 집계를 적재하지 않는다', () => {
  const r = vmAllocRows(snapOf([{ id: 'vc1', status: 'unreachable', stale: true, staleSince: NOW - 5 * HOUR }]), ALL);
  assert.equal(r.size, 0, `낡은 값이 '지금 값' 으로 나갔다: ${[...r.keys()]}`);
  assert.equal(r.staleVcenters, 1);
});

test('★ 03 위임 push 가 끊긴(site stale) vCenter 가 섞이면 전체(\'\') 합계는 적재하지 않는다(부분 합 = 거짓 하락)', () => {
  const r = vmAllocRows(snapOf([
    { id: 'ok1', status: 'ok' },
    { id: 'site1', status: 'ok', collectSource: 'site', stale: true },
  ]), ALL);
  assert.ok(r.has('ok1'));
  assert.equal(r.has('site1'), false);
  assert.equal(r.has(''), false);
  assert.equal(r.totalWithheld, true);
  // 전부 정상이면 전체 합계는 그대로
  const ok = vmAllocRows(snapOf([{ id: 'a', status: 'ok' }, { id: 'b', status: 'ok' }]), ALL);
  assert.ok(ok.has('')); assert.equal(ok.totalWithheld, false);
  assert.deepEqual([...staleVcenterIds(snapOf([{ id: 'x', status: 'unreachable' }, { id: 'y', status: 'ok' }]))], ['x']);
});

test('03 온도·DS·GPU 계열도 낡은 vCenter 를 거른다(소스) — lastRun 에 뺀 수를 싣는다', () => {
  const src = stripComments(fs.readFileSync(path.join(SRC, 'metrics/sampler.js'), 'utf8'));
  const inner = src.slice(src.indexOf('async function sampleOnceInner'));
  assert.match(inner, /const hostsWithTemp = freshHosts\.filter/);
  assert.match(inner, /for \(const h of freshHosts\)/, 'GPU 루프');
  assert.match(inner, /staleIds\.has\(String\(d\.vcenterId\)\)/, 'DS 루프');
  assert.match(inner, /staleSkipped/);
});

/* ── SRV2620-05 ─────────────────────────────────────────────────────────── */

test('★ 05 iDRAC 스캔 주기 — 로드 경로도 저장과 같은 [10분, 30일] 클램프(0 = 끔 유지)', async () => {
  const m = await import('../src/idrac/scanPoller.js');
  assert.equal(m.idracScanStatus().intervalMs, 600_000, '파일의 1초 주기가 그대로 쓰였다');
  assert.equal(m.clampScanIntervalMs(0), 0);
  assert.equal(m.clampScanIntervalMs(1000), 600_000);
  assert.equal(m.clampScanIntervalMs(1e15), 30 * 86_400_000);
  assert.equal(m.clampScanIntervalMs(-5), 0);
});

/* ── SRV2620-06 ─────────────────────────────────────────────────────────── */

test('★ 06 Isilon 풀 전체 용량을 못 읽으면 0 바이트가 아니라 null', async () => {
  const { normalizeIsilon } = await import('../src/storage/collectors/isilon.js');
  const snap = normalizeIsilon({ id: 'i1', name: 'i1', host: '10.0.0.1', type: 'isilon' }, {
    pools: { storagepools: [{ name: 'p0', usage: { used_bytes: 5 } }, { name: 'p1', usage: { total_bytes: 100, used_bytes: 40 } }, { name: 'p2', usage: { total_bytes: 0 } }] },
  });
  const [p0, p1, p2] = snap.pools;
  assert.equal(p0.totalBytes, null); assert.equal(p0.pct, null);
  assert.equal(p1.totalBytes, 100); assert.equal(p1.pct, 40);
  assert.equal(p2.totalBytes, null);
});

/* ── SRV2620-07 ─────────────────────────────────────────────────────────── */

test('★ 07 로그 버퍼 항목 time 이 빈 값이면 ts 는 null(1970 아님)', async () => {
  const { fromBufferEntry } = await import('../src/loganalysis/parse.js');
  assert.equal(fromBufferEntry({ msg: 'x', time: '' }).ts, null);
  assert.equal(fromBufferEntry({ msg: 'x', time: '   ' }).ts, null);
  assert.equal(fromBufferEntry({ msg: 'x', time: 0 }).ts, null);
  assert.equal(fromBufferEntry({ msg: 'x' }).ts, null);
  assert.equal(fromBufferEntry({ msg: 'x', time: NOW }).ts, NOW);
  assert.equal(fromBufferEntry({ msg: 'x', time: String(NOW) }).ts, NOW);
});
