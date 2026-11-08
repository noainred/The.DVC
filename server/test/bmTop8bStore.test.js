/**
 * 리눅스 성능 8b단계 ⑳ — Top-N 저장(‘변화 있을 때만’ 기준) · 조회(이 시점 · 지속 · PID 재사용 · 띠) · 보존(날 파일 삭제) · **실제 폴러 배선**.
 *   ① 기준(sameAsBase): 같은 (PID, 시작) 집합 + CPU ±5%p · RSS · I/O ±5% 안이면 같음 · 집합이 바뀌거나 넘으면 다름
 *   ② 적재: 머리는 매 주기 · 전체 행은 바뀐 주기만 · 기준이 60분 넘으면 다시 전체 · 같은 ts 두 번은 하나 · 꺼짐 · 값 없음은 적지 않는다
 *   ③ 조회: 같음 표본은 기준 행 · 지속(같은 PID · 시작) · PID 재사용(같은 PID · 다른 시작) · 그 시각 표본 없음 · 띠 5분 · 1시간(시간 집계 = 누적 CPU 차이 — 하한)
 *   ④ 보존: pruneMonthFiles(top 7일)가 오래된 날 파일을 지운다 · 파일 이름 해석(날 · 월)
 *   ⑤ 폴러 배선: pollBmUsageOnce 가 ##TOP 값을 적재 · top.on=false 면 수집기에 top:false
 * 기준 시각: 실제 시각을 5분 경계로 떨어뜨린 기준(제품이 실제 시각으로 날 파일을 고른다 — common.md).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bm8btop-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
let sqlite = true; try { await import('node:sqlite'); } catch { sqlite = false; }
const STEP = 300_000; const HOUR = 3_600_000; const DAY = 86_400_000;
const NOW = Math.floor(Date.now() / STEP) * STEP - 2 * STEP;

const T = await import('../src/bmusage/topStore.js');
const M = await import('../src/bmusage/monthStore.js');

const proc = (pid, start, cpu, { comm = 'postgres', user = 'gpadmin', rss = 3_000_000, cpuS = 1000, rd = 1e6, wr = 1e5, ioPerm = false } = {}) => ({ pid, start, cpu, comm, user, rssKb: rss, state: 'R', cpuS, rd, wr, ioPerm });
const topOf = (cpu, { mem = null, upS = 100_000 } = {}) => ({ src: 'top', dtS: 1.1, clk: 100, pageKb: 4, uptimeS: upS, nproc: 400, nrun: 3, nd: 1, cpuTotal: cpu.reduce((a, x) => a + x.cpu, 0) + 2,
  candidates: cpu.length, cpu, mem: mem || cpu.map((x) => ({ pid: x.pid, user: x.user, rssKb: x.rssKb, state: 'R', etimes: 100, comm: x.comm, start: x.start })), io: cpu.filter((x) => x.rd != null), ioPerm: cpu.filter((x) => x.ioPerm).length, ioUnknown: 0, unparsed: 0, capped: false });

test('① 변화 기준 · 시간 집계 증분(순수)', () => {
  const a = T.kindsOf(topOf([proc(10, 5, 60), proc(11, 6, 10)]));
  assert.equal(T.sameAsBase(T.kindsOf(topOf([proc(10, 5, 64.9), proc(11, 6, 6)])), a), true, '±5%p 안');
  assert.equal(T.sameAsBase(T.kindsOf(topOf([proc(10, 5, 66), proc(11, 6, 10)])), a), false, 'CPU 5%p 넘음');
  assert.equal(T.sameAsBase(T.kindsOf(topOf([proc(10, 9, 60), proc(11, 6, 10)])), a), false, '같은 PID 라도 시작이 다르면 다른 프로세스(재사용)');
  assert.equal(T.sameAsBase(T.kindsOf(topOf([proc(10, 5, 60, { rss: 3_200_000 }), proc(11, 6, 10)])), a), false, 'RSS 5% 넘음');
  assert.equal(T.sameAsBase(T.kindsOf(topOf([proc(10, 5, 60, { rd: 2e5, wr: 1e4 }), proc(11, 6, 10, { rd: 1e5 })])), T.kindsOf(topOf([proc(10, 5, 60, { rd: 5e5, wr: 1e4 }), proc(11, 6, 10, { rd: 1e5 })]))), true, 'I/O 둘 다 1MB/s 미만이면 같음');
  // 시간 집계 — 직전에도 후보였던 같은 (PID, 시작)만 · 음수 · 비정상은 버린다
  const prev = new Map([['10:5', 900], ['11:6', 50]]);
  const d = T.hourlyDelta(topOf([proc(10, 5, 60, { cpuS: 1080 }), proc(11, 6, 10, { cpuS: 40, comm: 'x' }), proc(12, 7, 5, { cpuS: 5, comm: 'new' })]), prev, { elapsedS: 300 });
  assert.equal(d.byComm.get('postgres').cpuS, 180);
  assert.equal(d.byComm.has('x') && d.byComm.get('x').cpuKnown, false, '감소(누적 리셋)는 CPU 를 지어내지 않는다');
  assert.equal(d.byComm.get('new')?.cpuKnown ?? false, false, '직전에 후보가 아니던 프로세스는 CPU 초를 세지 않는다(하한)');
  assert.equal(d.next.get('12:7'), 5);
});

test('② ③ 적재 · 조회 · 띠', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  T._resetTopStoreForTest();
  const items = [];
  // 6 주기: 0,1 같음 → 2 바뀜(CPU 70) → 3 같음 → 4 PID 10 재사용(시작 다름) → 5 표본 없음(수집 실패 — 적지 않는다)
  const s = (k, cpu) => ({ key: 'K1', ts: NOW - (5 - k) * STEP, top: topOf(cpu, { upS: 100_000 + k * 300 }) });   // uptime 은 시각과 함께 는다(같은 부팅)
  items.push(s(0, [proc(10, 5, 60, { cpuS: 1000 }), proc(11, 6, 10, { comm: 'kswapd0', user: 'root', cpuS: 10 })]));
  items.push(s(1, [proc(10, 5, 62, { cpuS: 1180 }), proc(11, 6, 11, { comm: 'kswapd0', user: 'root', cpuS: 40 })]));
  items.push(s(2, [proc(10, 5, 70, { cpuS: 1390 }), proc(11, 6, 11, { comm: 'kswapd0', user: 'root', cpuS: 70 })]));
  items.push(s(3, [proc(10, 5, 71, { cpuS: 1600 }), proc(11, 6, 12, { comm: 'kswapd0', user: 'root', cpuS: 100 })]));
  items.push(s(4, [proc(10, 99_000, 30, { cpuS: 3 }), proc(11, 6, 12, { comm: 'kswapd0', user: 'root', cpuS: 136 })]));
  items.push({ key: 'K1', ts: NOW, top: { off: true } });
  items.push({ key: 'K2', ts: NOW, top: null });
  const w = await T.topWriteBatch({ agent: '', items });
  assert.equal(w.ok, true, JSON.stringify(w));
  assert.equal(w.samples, 5, '머리는 표본마다(꺼짐 · 값 없음은 적지 않는다)');
  assert.equal(w.full, 3, '전체 행은 처음 · 바뀐 주기 · PID 재사용 주기만');
  const again = await T.topWriteBatch({ agent: '', items: [s(4, [proc(10, 99_000, 30), proc(11, 6, 12, { comm: 'kswapd0', user: 'root' })])] });
  assert.equal(again.samples, 0, '같은 ts 두 번은 하나(중복 적재 금지)');
  // 이 시점 — 같음 표본(3)은 기준(2)의 행 · 지속
  const p3 = await T.topAt({ agent: '', key: 'K1', ts: NOW - 2 * STEP });
  assert.equal(p3.sample.ts, NOW - 2 * STEP); assert.equal(p3.sample.same, true); assert.equal(p3.sample.baseTs, NOW - 3 * STEP);
  assert.equal(p3.rows.cpu[0].val, 70, '기준 표본 값');
  assert.equal(p3.rows.cpu[0].hint, 'gpdb'); assert.equal(p3.rows.cpu[0].cont, true, '직전 표본에도 같은 PID · 시작 = 지속');
  assert.equal(p3.prevTs, NOW - 3 * STEP); assert.equal(p3.nextTs, NOW - STEP);
  const p4 = await T.topAt({ agent: '', key: 'K1', ts: NOW - STEP });
  const r10 = p4.rows.cpu.find((x) => x.pid === 10);
  assert.equal(r10.pidReused, true, '같은 PID · 다른 시작 = 재사용(다른 프로세스)'); assert.equal(r10.cont, false);
  const none = await T.topAt({ agent: '', key: 'K1', ts: NOW + 3 * HOUR });
  assert.equal(none.sample, null); assert.equal(none.reason, 'no-sample', '그 시각 표본 없음(0 으로 메우지 않는다)');
  // 띠 — 5분
  const b = await T.topBand({ agent: '', key: 'K1', from: NOW - HOUR, to: NOW });
  assert.equal(b.res, '5m'); assert.equal(b.points.length, 5); assert.equal(b.approx, 2, '같음 표본 2개는 기준 값으로');
  assert.deepEqual(b.comms.slice(0, 2), ['postgres', 'kswapd0']);
  // 띠 — 1시간(시간 집계: 누적 CPU 차이 — postgres 180+210+210 · 재사용 PID 는 새 프로세스라 세지 않음)
  const bh = await T.topBand({ agent: '', key: 'K1', from: NOW - 3 * DAY, to: NOW + STEP });
  assert.equal(bh.res, '1h');
  const sumPg = bh.points.reduce((a, p) => a + (p.by.postgres || 0), 0);
  assert.ok(Math.abs(sumPg - Math.round((600 / 36) * 10) / 10) < 0.3, `postgres 600 CPU 초 = ${sumPg}%(시간 칸 합)`);
  // 기준이 60분 넘으면 같은 값이어도 다시 전체
  T._resetTopStoreForTest();
  const far = [0, 13].map((k) => ({ key: 'K3', ts: NOW - (13 - k) * STEP, top: topOf([proc(20, 1, 50)]) }));
  assert.equal((await T.topWriteBatch({ agent: '', items: far })).full, 2, '기준 65분 전 → 다시 전체(먼 기준 행을 끌어 쓰지 않는다)');
  T.dropTopState(new Set(['K1']));
});

test('④ 보존 — 날 파일 삭제 · 파일 이름', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  assert.deepEqual(M.parseFileName('bm-usage-top-2026-11-08.db'), { family: 'top', key: '2026-11-08' });
  assert.deepEqual(M.parseFileName('bm-usage-toph-2026-11.db'), { family: 'toph', key: '2026-11' });
  assert.equal(M.parseFileName('bm-usage-top-2026-11.db'), null, '날 가족에 월 이름은 없다');
  assert.equal(M.parseFileName('bm-usage-2026-11-08.db'), null, '원시 가족에 날 이름은 없다');
  assert.deepEqual(M.parseFileName('bm-usage-2026-11.db'), { family: 'raw', key: '2026-11' }, '기존 이름 그대로');
  const [s0, e0] = M.periodRange('top', '2026-11-08');
  assert.equal(e0 - s0, DAY);
  T._resetTopStoreForTest();
  const old = NOW - 10 * DAY;
  await T.topWriteBatch({ agent: '', items: [{ key: 'P1', ts: old, top: topOf([proc(1, 1, 5)]) }, { key: 'P1', ts: NOW, top: topOf([proc(1, 1, 5)]) }] });
  const before = M.listFamilyFiles('top').map((f) => f.key);
  assert.ok(before.includes(M.periodKeyOf('top', old)));
  const r = await M.pruneMonthFiles({ keepDays: { top: 7, toph: 90 }, now: NOW });
  assert.ok(r.filesDeleted.some((x) => x.startsWith('bm-usage-top-')), JSON.stringify(r));
  const after = M.listFamilyFiles('top').map((f) => f.key);
  assert.ok(!after.includes(M.periodKeyOf('top', old)) && after.includes(M.periodKeyOf('top', NOW)), '오래된 날 파일만 지운다');
});

test('⑤ 실제 폴러 배선 — ##TOP 값 적재 · top.on=false 면 수집기에 top:false', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  fs.writeFileSync(path.join(DIR, 'idrac.json'), JSON.stringify({ servers: [] }));
  fs.writeFileSync(path.join(DIR, 'bm-storage.json'), JSON.stringify({ servers: [{ id: 'o-w1', name: 'bm-w1', host: '127.0.0.1', port: 9, username: 'mon', password: 'pw', mounts: [] }] }));
  fs.writeFileSync(path.join(DIR, 'bmusage-settings.json'), JSON.stringify({ enabled: true, corps: { vcW: true }, osSsh: true, idracTelemetry: false }));
  const poller = await import('../src/bmusage/poller.js');
  const OSm = await import('../src/bmusage/collectors/osSsh.js');
  poller._setFleetForTest(async () => ({ bareMetal: [{ serverId: 's-w1', name: 'bm-w1', serviceTag: 'WTAG1', vcenterId: 'vcW' }], virtualizationHosts: [] }));
  (await import('../src/bmusage/settings.js'))._resetForTest();
  const seen = [];
  const stdout = ['##STAT', 'cpu  10 0 10 1000 0 0 0 0 0 0', '##MEM', 'MemTotal: 1000000 kB', 'MemAvailable: 500000 kB', '##TOP',
    'tS:src=top dt=1.10 clk=100 pg=4096 up=5000.00 n=300 r=2 d=0 tot=40.0 c=1', 'tC:777|gpadmin|R|35.5|12000|100|1000|1000|2000|postgres', 'tM:777|gpadmin|4000|R|4900|postgres', '##END'].join('\n');
  poller._setOsCollectorForTest(async (_h, opts) => { seen.push(opts.top); return { ...OSm.shapeLinux(stdout, []), ok: true, peak: { windowS: 0 }, stderr: '' }; });
  t.after(() => { poller._setOsCollectorForTest(null); poller._setFleetForTest(null); poller._resetForTest(); });
  T._resetTopStoreForTest();
  const r = await poller.pollBmUsageOnce({ trigger: 'manual' });
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
  assert.equal(seen[0], true, '기본 = 켬');
  assert.equal(r.top?.samples, 1, `주기 상태에 개수(${JSON.stringify(r.top)})`);
  const { config } = await import('../src/config.js');
  const p = await T.topAt({ agent: config.agent?.name || '', key: 'WTAG1', ts: Date.now() });
  assert.equal(p.rows.cpu[0].pid, 777); assert.equal(p.rows.cpu[0].comm, 'postgres'); assert.equal(p.rows.cpu[0].hint, 'gpdb');
  // 끄면 수집기에 top:false(명령이 ‘꺼짐’ 한 줄)
  const R = await import('../src/bmusage/perfRules.js');
  R.savePerfRules({ top: { on: false, keepDays: 7, hourlyDays: 90 } }, { by: 'test' });
  await poller.pollBmUsageOnce({ trigger: 'manual' });
  assert.equal(seen.at(-1), false, 'top.on=false → 수집기 옵션 top:false');
  R._resetPerfRulesForTest();
});
