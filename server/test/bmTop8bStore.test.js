/**
 * 리눅스 성능 8b단계 ⑳ — Top-N 저장(‘변화 있을 때만’ 기준) · 조회(이 시점 · 지속 · PID 재사용 · 띠) · 보존(날 파일 삭제) · **실제 폴러 배선**.
 *   ① 기준(sameAsBase): 같은 (PID, 시작) 집합 + CPU ±5%p · RSS · I/O ±5% 안이면 같음 · 집합이 바뀌거나 넘으면 다름
 *   ② 적재: 머리는 매 주기 · 전체 행은 바뀐 주기만 · 기준이 60분 넘으면 다시 전체 · 같은 ts 두 번은 하나 · 꺼짐 · 값 없음은 적지 않는다
 *   ③ 조회: 같음 표본은 기준 행 · 지속(같은 PID · 시작) · PID 재사용(같은 PID · 다른 시작) · 그 시각 표본 없음 · 띠 5분 · 1시간(시간 집계 = 누적 CPU 차이 — 하한)
 *   ④ 보존: pruneMonthFiles(top 7일)가 오래된 날 파일을 지운다 · 파일 이름 해석(날 · 월)
 *   ⑤ 폴러 배선: pollBmUsageOnce 가 Top-N 값(별도 exec 결과 perf.top)을 적재 · top.on=false 면 수집기에 top:false · 수집 계정 기록(반증 F5)
 *   ⑥ 반증 F2: 메모리 상위 시작 시각 ±1초 흔들림(실장비 셸 실측 열)은 같음 — 전체 저장이 첫 주기 + 60분 만료뿐
 *   ⑦ 반증 F3: 적재 실패 주기는 기준이 되지 않는다 · 날 가족 보존은 파일 삭제만(경계 날의 기준 행을 먼저 지우지 않는다) · 기준 행이 없으면 reason 'base-missing'(띠는 빼고 센다)
 *   ⑧ 반증 F4: 시간당 comm 24행 상한은 재시작 뒤에도(파일의 기존 comm 으로 채운다)
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
  const stdout = ['##STAT', 'cpu  10 0 10 1000 0 0 0 0 0 0', '##MEM', 'MemTotal: 1000000 kB', 'MemAvailable: 500000 kB', '##CHANGES', 'x:up=5000.00', 'x:sc=10.20.30.40', '##END'].join('\n');
  const topOut = ['tS:src=top dt=1.10 clk=100 pg=4096 up=5000.00 n=300 r=2 d=0 tot=40.0 c=1', 'tC:777|gpadmin|R|35.5|12000|100|1000|1000|2000|postgres', 'tM:777|gpadmin|4000|R|4900|postgres'].join('\n');
  const LT = await import('../src/bmusage/parse/linuxTop.js');
  // 별도 exec(반증 F1) — 수집기가 perf.top 에 싣는 것과 같은 꼴(readTopOutput)
  poller._setOsCollectorForTest(async (_h, opts) => { seen.push(opts.top); const sh = OSm.shapeLinux(stdout, []); return { ...sh, perf: { ...sh.perf, top: opts.top ? LT.readTopOutput(topOut) : { value: { off: true } } }, ok: true, peak: { windowS: 0 }, stderr: '' }; });
  t.after(() => { poller._setOsCollectorForTest(null); poller._setFleetForTest(null); poller._resetForTest(); });
  T._resetTopStoreForTest();
  const r = await poller.pollBmUsageOnce({ trigger: 'manual' });
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
  assert.equal(seen[0], true, '기본 = 켬');
  assert.equal(r.top?.samples, 1, `주기 상태에 개수(${JSON.stringify(r.top)})`);
  const { config } = await import('../src/config.js');
  const p = await T.topAt({ agent: config.agent?.name || '', key: 'WTAG1', ts: Date.now() });
  assert.equal(p.rows.cpu[0].pid, 777); assert.equal(p.rows.cpu[0].comm, 'postgres'); assert.equal(p.rows.cpu[0].hint, 'gpdb');
  // 반증 F5 배선: 수집 계정(등록 'mon') · 대상이 본 출발 주소(sc)를 저활용 활동 판정에 넘긴다
  const I = await import('../src/bmusage/idle.js');
  assert.deepEqual(I.selfLoginOf('WTAG1', null), { user: 'mon', ip: '10.20.30.40' });
  // 끄면 수집기에 top:false(명령이 ‘꺼짐’ 한 줄)
  const R = await import('../src/bmusage/perfRules.js');
  R.savePerfRules({ top: { on: false, keepDays: 7, hourlyDays: 90 } }, { by: 'test' });
  await poller.pollBmUsageOnce({ trigger: 'manual' });
  assert.equal(seen.at(-1), false, 'top.on=false → 수집기 옵션 top:false');
  R._resetPerfRulesForTest();
});

test('⑥ 반증 F2 — 메모리 상위 시작 시각 ±1초 흔들림(실장비 셸 실측 열)은 같음 · ±3초는 다른 프로세스', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  // 반증 rv8b/jitter.mjs 실측(dash · procps top/ps · 14회 연속): 메모리 상위 5 PID 전부가 두 값을 오갔다 — pid 85: 1,2,2,1,2,2,1,1,2,2,1,2,2,1
  const SEQ = [1, 2, 2, 1, 2, 2, 1, 1, 2, 2, 1, 2, 2, 1];
  assert.equal(T.sameProcStart(1, 2), true); assert.equal(T.sameProcStart(65550, 65551), true); assert.equal(T.sameProcStart(5, 8), false, '±3초는 다른 프로세스(PID 재사용)');
  assert.equal(T.sameProcStart(null, null), true); assert.equal(T.sameProcStart(null, 5), false);
  T._resetTopStoreForTest();
  const base = NOW - 13 * STEP;
  const cpu = [proc(30, 100, 40), proc(31, 200, 5, { comm: 'java', user: 'app' })];
  let full = 0;
  for (let i = 0; i < SEQ.length; i += 1) {
    const mem = [0, 1, 2, 3, 4].map((j) => ({ pid: 85 + j, user: 'root', rssKb: 400_000 + j, state: 'S', etimes: 100, comm: `m${j}`, start: SEQ[i] + j * 1000 }));
    const w = await T.topWriteBatch({ agent: '', items: [{ key: 'J1', ts: base + i * STEP - STEP, top: topOf(cpu, { mem, upS: 100_000 + i * 300 }) }] });
    full += w.full;
  }
  assert.equal(full, 2, `전체 저장은 첫 주기 + 60분 기준 만료만(예전 13/14) — ${full}/14`);
  // 같은 PID · 3초 넘게 다른 시작이면 다른 프로세스 → 전체 저장
  const mem2 = [0, 1, 2, 3, 4].map((j) => ({ pid: 85 + j, user: 'root', rssKb: 400_000 + j, state: 'S', etimes: 100, comm: `m${j}`, start: (j === 0 ? 9 : 1) + j * 1000 }));
  const w2 = await T.topWriteBatch({ agent: '', items: [{ key: 'J1', ts: base + 14 * STEP, top: topOf(cpu, { mem: mem2, upS: 100_000 + 14 * 300 }) }] });
  assert.equal(w2.full, 1, '시작 시각이 ±2초 밖이면 다른 프로세스');
});

test('⑦ 반증 F3 — 적재 실패 주기는 기준이 되지 않는다 · 보존 경계 날은 파일째 남는다 · 기준 행이 없으면 base-missing', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  // (가) 날 파일 열기 실패(그 이름에 디렉터리) → 다음 주기는 같은 내용이어도 전체 저장(빈 기준을 가리키는 ‘같음’ 머리가 생기지 않는다)
  T._resetTopStoreForTest();
  const d0 = Math.floor((NOW - 30 * DAY) / DAY) * DAY + 12 * HOUR;   // 다른 시험과 겹치지 않는 날 · 그 날 안
  const dir = path.join(M.dbDir(), M.fileNameOf('top', M.periodKeyOf('top', d0)));
  fs.mkdirSync(dir, { recursive: true });
  const same = () => topOf([proc(40, 7, 33)], { upS: 200_000 });
  const f1 = await T.topWriteBatch({ agent: '', items: [{ key: 'F3A', ts: d0, top: same() }] });
  assert.equal(f1.ok, false, '파일을 열지 못했다');
  fs.rmSync(dir, { recursive: true, force: true });
  const f2 = await T.topWriteBatch({ agent: '', items: [{ key: 'F3A', ts: d0 + STEP, top: { ...same(), uptimeS: 200_300 } }] });
  assert.equal(f2.ok, true); assert.equal(f2.full, 1, '실패한 주기는 기준이 아니다 → 전체 저장');
  const pa = await T.topAt({ agent: '', key: 'F3A', ts: d0 + STEP });
  assert.equal(pa.reason, undefined); assert.equal(pa.rows.cpu[0].pid, 40, '행이 있다(예전: same · 행 0 · reason 없음)');
  // (나) 보존 경계: 기준 = cut − 10분(전체) · 같음 머리 = cut + 10분(같은 날 파일) → 보존 정리 뒤에도 기준 행이 남는다(날 가족은 파일 삭제만)
  T._resetTopStoreForTest();
  const b0 = d0 + 2 * HOUR; const cut = b0 + 10 * 60_000; const now = cut + 7 * DAY;
  const g = await T.topWriteBatch({ agent: '', items: [{ key: 'F3B', ts: b0, top: same() }, { key: 'F3B', ts: b0 + 20 * 60_000, top: { ...same(), uptimeS: 201_200 } }] });
  assert.equal(g.full, 1); assert.equal(g.samples, 2);
  const older = Math.floor((d0 - 2 * DAY) / DAY) * DAY + HOUR;
  await T.topWriteBatch({ agent: '', items: [{ key: 'F3C', ts: older, top: same() }] });
  const pr = await M.pruneMonthFiles({ keepDays: { top: 7 }, now });
  assert.equal(pr.residualDeleted, 0, '날 가족은 경계 청크를 지우지 않는다');
  assert.ok(pr.filesDeleted.includes(M.fileNameOf('top', M.periodKeyOf('top', older))), '경계 앞 날 파일은 통째로 지운다');
  const pb = await T.topAt({ agent: '', key: 'F3B', ts: b0 + 20 * 60_000 });
  assert.equal(pb.sample.same, true); assert.equal(pb.rows.cpu.length, 1, `경계 날의 기준 행이 남는다(예전: 행 0 · reason 없음) — ${JSON.stringify(pb.reason)}`);
  // (다) 기준 행을 어떤 이유로든 못 읽으면 ‘없음’ 이 아니라 base-missing(조회 방어) · 띠는 그 표본을 빼고 센다
  await M.withPeriodFile('top', M.periodKeyOf('top', b0), { create: false }, async (db) => { db.prepare('DELETE FROM top_proc WHERE key=? AND ts=?').run('F3B', b0); });
  const pc = await T.topAt({ agent: '', key: 'F3B', ts: b0 + 20 * 60_000 });
  assert.equal(pc.reason, 'base-missing'); assert.ok(pc.sample, '표본 머리는 있다'); assert.equal(pc.rows.cpu.length + pc.rows.mem.length + pc.rows.io.length, 0);
  const bb = await T.topBand({ agent: '', key: 'F3B', from: b0 - STEP, to: b0 + HOUR });
  assert.equal(bb.points.length, 0); assert.equal(bb.baseMissing, 2, '행 없는 표본은 0 으로 그리지 않고 센다');
  await M.withPeriodFile('top', M.periodKeyOf('top', b0), { create: false }, async (db) => { db.prepare('DELETE FROM top_sample WHERE key=? AND ts=?').run('F3B', b0); });
  assert.equal((await T.topAt({ agent: '', key: 'F3B', ts: b0 + 20 * 60_000 })).reason, 'base-missing', '기준 머리가 없어도 base-missing');
  // (라) 같은 묶음 안 기준 예정 표본이 들어가지 못하면(같은 ts 가 이미 있다 — 다른 내용) 뒤 ‘같음’ 은 전체로 적는다(남의 행을 가리키지 않게)
  T._resetTopStoreForTest();
  const t1 = d0 + 4 * HOUR;
  await T.topWriteBatch({ agent: '', items: [{ key: 'F3D', ts: t1, top: topOf([proc(50, 9, 10)], { upS: 300_000 }) }] });
  T._resetTopStoreForTest();   // 재시작
  const y = await T.topWriteBatch({ agent: '', items: [{ key: 'F3D', ts: t1, top: topOf([proc(60, 9, 80)], { upS: 300_000 }) }, { key: 'F3D', ts: t1 + STEP, top: topOf([proc(60, 9, 81)], { upS: 300_300 }) }] });
  assert.equal(y.samples, 1, '같은 ts 는 무시'); assert.equal(y.full, 1, '기준이 못 들어갔으니 뒤 표본을 전체로');
  const pd = await T.topAt({ agent: '', key: 'F3D', ts: t1 + STEP });
  assert.equal(pd.rows.cpu[0].pid, 60, `자기 행(예전 판이면 앞 표본 ts 의 다른 내용 pid 50 을 가리킨다) — ${pd.rows.cpu[0]?.pid}`);
});

test('⑧ 반증 F4 — 시간당 comm 24행 상한은 재시작 뒤에도 지킨다', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  T._resetTopStoreForTest();
  const h0 = Math.floor((NOW - 40 * DAY) / HOUR) * HOUR + 5 * 60_000;
  const many = (prefix, n, i0 = 0) => topOf([], { mem: Array.from({ length: n }, (_, j) => ({ pid: 1000 + i0 + j, user: 'u', rssKb: 1000 + j, state: 'S', etimes: 100, comm: `${prefix}${j}`, start: 5 })) });
  await T.topWriteBatch({ agent: '', items: [{ key: 'F4', ts: h0, top: many('a', 30) }] });
  T._resetTopStoreForTest();   // 재시작(인메모리 초기화)
  await T.topWriteBatch({ agent: '', items: [{ key: 'F4', ts: h0 + STEP, top: many('c', 20, 100) }] });
  let rows = [];
  await M.withPeriodFile('toph', M.periodKeyOf('toph', h0), { create: false }, async (db) => { rows = db.prepare('SELECT comm FROM top_proc_hourly WHERE key=? AND hour=?').all('F4', M.hourOf(h0)); });
  assert.equal(rows.length, T.HOURLY_COMMS_MAX + 1, `상한 24 + ‘(기타)’ 1 — 재시작 뒤에도(예전 45행) · ${rows.length}`);
  assert.ok(rows.some((r) => r.comm === T.OTHER_COMM));
  assert.ok(!rows.some((r) => String(r.comm).startsWith('c')), '재시작 뒤 새 comm 은 상한 밖이면 ‘(기타)’ 로');
});
