/**
 * test/focusMonHistory3130.test.js — v3.13.0 서버 집중 모니터링 ‘긴 구간 · 사건 · 가장 변했나’(시안 ⑭ History · 사용자 "기본값대로 모두 구현해줘").
 * 컨펌 기본값: ① 1시간 · 6시간 · 24시간 · 7일 · 30일 ② 1분 · 1시간 요약(최저 · 평균 · 최고 · 표본 수 · 기록할 때 · 30일) ③ 쌓인 기록은 조각으로 백필
 * ④ 겹쳐 보기 어제 · 지난주 ⑤ 중앙값 비 + 분포 겹침 · 앞 4배 ⑥ 직접 적는 사건 = 관리자 · 전체 쓰기 범위 · 30일 · 감사.
 *
 *  ① 요약 — 넣는 열 · 못 읽음은 표본 수에 없음(0 아님) · 다 못 읽은 열은 없음 · 가중 합치기 · 바이트 왕복 · 깨진 바이트 null
 *  ② DB — 기록할 때 1분 요약이 같이 · 1시간 요약은 끝난 시간만 · 늦게 다시 쓴 분은 그 시간을 다시 · 기동 할 일 · 백필(빈 요약 · 되풀이 없음) · 정리 · 종료 쓰기(모르는 kind)
 *  ③ 긴 구간 조회 — 칸이 비면 null · 가중 평균 · 띠 · 지금 시간은 1분 요약을 합쳐 · 겹쳐 보기(그때 없던 칸 null) · 데모 비용 · 빈 시간
 *  ④ 사건 — 재부팅(가동 시간 감소) · 인증 · 호스트키는 바뀐 순간만 · 앞 상태 모르면 적지 않음 · 직접 적기 검사 · 범위 펴기 · 수집 시작 · 끝
 *  ⑤ 가장 변했나 — 점수 · 겹침 · 칸 모자람 · 두 구간 같은 출처 · 못 읽음 제외
 *  ⑥ 라우트 — 긴 구간 분기 · iostat 은 원본만 · 사건 쓰기 문(관리자 · 쓰기 범위 · 데모 · 503) · 지우기는 직접 적은 것만 · 감사 · 변화 조회 문
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// v3.18.8: 이 파일이 만든 임시 폴더는 시험이 끝나면 지운다(지우지 않아 전량 실행마다 /tmp 에 쌓였다 — tmpCleanup3188 이 고정).
//   exit 에서 한 번 더 지운다 — 모듈의 종료 flush(util/exitFlush.js)가 뒤늦게 다시 만든 폴더(수 MB 실측)까지.
const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) fs.rmSync(d, { recursive: true, force: true }); };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });

const DIR = tmpDir('focusmonhist3130-');
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'mock';
process.env.CENTRAL_TOKEN = 'ctok-hist-3130';
process.env.FOCUSMON_SSH_KEY = '';
process.env.AUTH_SECRET = 'test-secret-hist-3130-xxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

const SUM = await import('../src/focusmon/summary.js');
const CODEC = await import('../src/focusmon/codec.js');
const store = await import('../src/focusmon/store.js');
const db = await import('../src/focusmon/db.js');
const rollup = await import('../src/focusmon/rollup.js');
const recorder = await import('../src/focusmon/recorder.js');
const L = await import('../src/focusmon/longq.js');
const Q = await import('../src/focusmon/query.js');
const EV = await import('../src/focusmon/events.js');
const CH = await import('../src/focusmon/changes.js');
const mock = await import('../src/focusmon/mock.js');
const edge = await import('../src/central/focusMonEdge.js');

// 기준 시각: 실제 시각을 정시로 떨어뜨린 뒤 30분(지금 시간 안 · 끝난 시간이 앞에 있다 — common.md 규약)
const HOUR = Math.floor(Date.now() / 3_600_000) * 3_600_000;
const NOW = HOUR + 30 * 60_000;
const MIN = (t) => Math.floor(t / 60_000);

function blockOf(minute, rows, meta = null) {
  const b = CODEC.newBlock(minute);
  for (const [ts, obj] of rows) CODEC.appendToBlock(b, ts, new Map(Object.entries(obj)), meta);
  return b;
}
const sumRow = (target, minute, obj) => ({ kind: 's1', target, minute, data: SUM.encodeSum(SUM.summarizeBlock(blockOf(minute, [[minute * 60_000 + 1000, obj], [minute * 60_000 + 3000, obj]]))) });

after(() => { try { db._resetForTest(); } catch { /* */ } });

/* ── ① 요약 ─────────────────────────────────────────────────────────────── */
test('① 요약 — 넣는 열 · 못 읽음은 표본 수에 없음 · 다 못 읽은 열은 없음 · 가중 합치기 · 왕복', () => {
  const meta = { dsk: { sda: { k: 'disk' }, sda1: { k: 'part' } }, net: { eth0: { k: 'phys' }, veth9: { k: 'virt' } }, fs: {} };
  assert.equal(SUM.summaryKeep('c.k3', meta), false, '코어별은 뺀다');
  assert.equal(SUM.summaryKeep('d.sda.wAwait', meta), true);
  assert.equal(SUM.summaryKeep('d.sda.aqu', meta), false, '물리 디스크도 고른 칸만');
  assert.equal(SUM.summaryKeep('d.sda1.wAwait', meta), false, '파티션은 뺀다');
  assert.equal(SUM.summaryKeep('n.eth0.rx', meta), true);
  assert.equal(SUM.summaryKeep('n.veth9.rx', meta), false, '가상 인터페이스는 뺀다');
  assert.equal(SUM.summaryKeep('d.nope.wAwait', meta), false, '메타에 없는 장치');
  assert.equal(SUM.summaryKeep('s.cpu', meta), true);

  const b = CODEC.newBlock(100);
  CODEC.appendToBlock(b, 6_000_000, new Map([['c.pct', 10], ['m.pct', null], ['x.none', null]]), meta);
  CODEC.appendToBlock(b, 6_002_000, new Map([['c.pct', 30], ['m.pct', 50], ['x.none', null]]), meta);
  CODEC.appendToBlock(b, 6_004_000, new Map([['c.pct', NaN], ['m.pct', 70], ['x.none', null]]), meta);
  const s = SUM.summarizeBlock(b);
  assert.deepEqual(SUM.sumCol(s, 'c.pct'), { n: 2, a: 20, lo: 10, hi: 30 }, 'NaN 은 표본 수에 넣지 않는다(0 이 아니다)');
  assert.deepEqual(SUM.sumCol(s, 'm.pct'), { n: 2, a: 60, lo: 50, hi: 70 });
  assert.equal(SUM.sumCol(s, 'x.none'), null, '다 못 읽은 열은 싣지 않는다');
  assert.equal(SUM.summarizeBlock(CODEC.newBlock(1)), null, '표본 없는 묶음은 요약 없음');

  const s2 = SUM.summarizeBlock(blockOf(101, [[6_060_000, { 'c.pct': 80 }]]));
  const m = SUM.mergeSums([s, s2]);
  assert.deepEqual(SUM.sumCol(m, 'c.pct'), { n: 3, a: 40, lo: 10, hi: 80 }, '평균은 표본 수 가중((20×2 + 80×1) / 3 = 40)');
  assert.deepEqual(SUM.sumCol(m, 'm.pct'), { n: 2, a: 60, lo: 50, hi: 70 }, '한쪽에만 있는 열');
  const back = SUM.decodeSum(SUM.encodeSum(m));
  assert.deepEqual(back.keys, m.keys);
  assert.equal(SUM.decodeSum(Buffer.from('not deflate')), null, '깨진 바이트는 null(던지지 않는다)');
  assert.equal(SUM.decodeSum(SUM.encodeSum({ v: 99, keys: [], n: [], a: [], lo: [], hi: [] })), null, '모르는 판');
  assert.equal(SUM.decodeSum(SUM.encodeSum({ v: SUM.SUM_VERSION, keys: ['a'], n: [1], a: [], lo: [1], hi: [1] })), null, '배열 길이가 다르면 null');
});

/* ── ② DB ──────────────────────────────────────────────────────────────── */
test('② 기록할 때 1분 요약이 같이 쓰인다 · 1시간 요약은 끝난 시간만 · 늦게 다시 쓴 분은 그 시간을 다시', async () => {
  store._resetForTest(); rollup._resetForTest(); recorder._resetForTest();
  const id = 'fm-hist-a';
  const prevH = HOUR - 3_600_000;
  // 지난 시간 두 분 + 지금 시간 한 분 — store 로 받아 기록기로 쓴다
  for (const [t, v] of [[prevH + 60_000, 10], [prevH + 61_000, 20], [prevH + 30 * 60_000, 60], [HOUR + 60_000, 90], [HOUR + 5 * 60_000, 90]]) {
    store.ingestSample(id, t, { cpu: { pct: v, usr: v, sys: 0, iow: 0, stl: 0 } }, null, t + 1000);
  }
  const rows = store.drainWrites(1000);
  assert.ok(rows.some((r) => r.kind === 's1' && r.minute === MIN(prevH + 60_000)), '묶음이 닫힐 때 1분 요약이 같은 대기열에');
  const w = await db.writeBlocks(rows);
  assert.ok(w.ok);
  for (const x of rows) if (x.kind === 's1') rollup.markDirty(x.target, x.minute);
  const s1 = await db.readSum1(id, MIN(prevH), MIN(HOUR + 59 * 60_000));
  assert.ok(s1.length >= 2);
  assert.equal(await rollup.rollupTick(NOW), 1, '끝난 시간(앞 시간)만 — 지금 시간은 쓰지 않는다');
  const h = await db.readSum60(id, Math.floor(prevH / 3_600_000), Math.floor(NOW / 3_600_000));
  assert.equal(h.length, 1);
  const hs = SUM.decodeSum(h[0].data);
  assert.equal(SUM.sumCol(hs, 's.cpu')?.hi ?? SUM.sumCol(hs, 'c.pct').hi, 60);
  assert.deepEqual([SUM.sumCol(hs, 'c.pct').lo, SUM.sumCol(hs, 'c.pct').hi], [10, 60]);
  // 늦게 다시 쓴 분 → 그 시간을 다시 만든다
  const late = sumRow(id, MIN(prevH + 60_000), { 'c.pct': 99 });
  assert.ok((await db.writeBlocks([late])).ok);
  rollup.markDirty(id, late.minute);
  assert.equal(await rollup.rollupTick(NOW), 1);
  const h2 = SUM.decodeSum((await db.readSum60(id, Math.floor(prevH / 3_600_000), Math.floor(prevH / 3_600_000)))[0].data);
  assert.equal(SUM.sumCol(h2, 'c.pct').hi, 99, '다시 만든 1시간 요약');
  assert.equal(await rollup.rollupTick(NOW), 0, '할 일을 다 했으면 0');
  // 기동 할 일 — 1시간 요약이 없는 끝난 시간을 찾는다
  const old = HOUR - 5 * 3_600_000;
  assert.ok((await db.writeBlocks([sumRow(id, MIN(old) + 3, { 'c.pct': 5 })])).ok);
  rollup._resetForTest();
  assert.ok((await rollup.seedDirty(NOW)) >= 1);
  assert.ok((await rollup.rollupTick(NOW)) >= 1);
  assert.equal((await db.readSum60(id, Math.floor(old / 3_600_000), Math.floor(old / 3_600_000))).length, 1);
});

test('② 백필 — 요약 없는 원본 분만 · 못 읽은 묶음은 빈 요약(되풀이 없음) · 열린 분은 기록기 몫 · 끝까지 가면 멈춤', async () => {
  rollup._resetForTest();
  const id = 'fm-hist-b';
  const m0 = MIN(HOUR - 2 * 3_600_000);
  const rows = [];
  for (let k = 0; k < 45; k++) rows.push({ kind: 'm', target: id, minute: m0 + k, n: 1, data: CODEC.encodeBlock(blockOf(m0 + k, [[(m0 + k) * 60_000 + 500, { 'c.pct': k }]])) });
  rows.push({ kind: 'm', target: id, minute: m0 + 50, n: 1, data: Buffer.from('broken-block') });
  rows.push({ kind: 'm', target: id, minute: MIN(NOW), n: 1, data: CODEC.encodeBlock(blockOf(MIN(NOW), [[NOW, { 'c.pct': 1 }]])) });
  assert.ok((await db.writeBlocks(rows)).ok);
  let total = 0;
  for (let i = 0; i < 20 && !rollup.backfillState().building === false; i++) { total += await rollup.backfillSlice(NOW, 1000); if (!rollup.backfillState().building) break; }
  const st = rollup.backfillState();
  assert.equal(st.building, false, '끝까지 갔다');
  assert.ok(total >= 46, `요약 ${total}개`);
  assert.ok(st.empty >= 1, '깨진 묶음 — 빈 요약을 남겼다');
  const s1 = await db.readSum1(id, m0, m0 + 60);
  assert.equal(s1.length, 46, '45분 + 깨진 1분(빈 요약)');
  assert.equal((await db.readSum1(id, MIN(NOW), MIN(NOW))).length, 0, '아직 열린 분은 기록기 몫');
  assert.deepEqual(await db.metricsWithoutSum(-1, MIN(NOW) - 2, 50).then((r) => r.filter((x) => x.target === id)), [], '같은 분을 되풀이하지 않는다');
  const empties = s1.map((r) => SUM.decodeSum(r.data)).filter((s) => s && !s.keys.length);
  assert.equal(empties.length, 1);
  const back = await L.sumRowsFor(id, m0 * 60_000, (m0 + 60) * 60_000, 'm');
  assert.equal(back.length, 45, '빈 요약은 조회에서 뺀다(수집하지 않은 칸 — 0 이 아니다)');
  // 백필한 분의 시간도 1시간 요약 할 일이 된다(변이 — 할 일을 적지 않으면 30일 화면이 비었다)
  assert.ok(rollup.dirtyCount() >= 1, '백필 뒤 1시간 할 일');
  await rollup.rollupTick(NOW, 100);
  assert.ok((await db.readSum60(id, Math.floor(m0 / 60), Math.floor((m0 + 50) / 60))).length >= 1, '백필한 시간의 1시간 요약');
});

test('② 기록기 — 쓴 1분 요약의 시간을 할 일로 적는다(끝난 시간이면 다음 1시간 요약 틱에 쓴다)', async () => {
  store._resetForTest(); rollup._resetForTest(); recorder._resetForTest();
  // v3.18.8: 실행 환경의 디스크 여유가 5% 아래면 기록기가 멈춰(정상 동작) 이 시험이 실패했다 — 여유는 고정하고 그 판정은 따로 시험한다
  recorder._setFreeSpaceForTest(() => ({ free: 100 * 2 ** 30, total: 200 * 2 ** 30 }));
  const id = 'fm-hist-r';
  const t0 = HOUR - 2 * 3_600_000 + 5 * 60_000;
  store.ingestSample(id, t0, { cpu: { pct: 33, usr: 33, sys: 0, iow: 0, stl: 0 } }, null, t0 + 500);
  store.ingestSample(id, t0 + 60_000, { cpu: { pct: 44, usr: 44, sys: 0, iow: 0, stl: 0 } }, null, t0 + 60_500); // 앞 분이 닫힌다
  assert.equal(rollup.dirtyCount(), 0);
  await recorder.recordTick(NOW);
  assert.ok(rollup.dirtyCount() >= 1, '기록기가 쓴 1분 요약의 시간 → 할 일');
  assert.ok((await rollup.rollupTick(NOW)) >= 1);
  assert.equal(SUM.sumCol(SUM.decodeSum((await db.readSum60(id, Math.floor(t0 / 3_600_000), Math.floor(t0 / 3_600_000)))[0].data), 'c.pct').a, 33);
  recorder._setFreeSpaceForTest(null);
});

test('② 정리 — 보관 기간 밖 요약 · 사건도 지운다 · 종료 쓰기는 모르는 kind 를 원본 표에 넣지 않는다', async () => {
  const id = 'fm-hist-c';
  const oldMin = MIN(NOW) - 40 * 1440;
  assert.ok((await db.writeBlocks([sumRow(id, oldMin, { 'c.pct': 1 }), { kind: 's60', target: id, hour: Math.floor(oldMin / 60), data: SUM.encodeSum(SUM.summarizeBlock(blockOf(oldMin, [[oldMin * 60_000, { 'c.pct': 1 }]]))) },
    { kind: 'e', id: 'ev-000000000001', target: id, at: oldMin * 60_000, ekind: 'user', text: 'old', by: 'a', scope: 'server' }])).ok);
  await db.pruneChunk(MIN(NOW) - 30 * 1440);
  assert.equal((await db.readSum1(id, oldMin - 1, oldMin + 1)).length, 0);
  assert.equal((await db.readSum60(id, Math.floor(oldMin / 60) - 1, Math.floor(oldMin / 60) + 1)).length, 0);
  assert.equal((await db.readEvents(id, 0, NOW)).length, 0);
  // 종료 쓰기(동기) — 같은 runRows · 모르는 kind 는 쓰지 않는다(예전에는 원본 표에 들어갔다)
  const n = db.writeBlocksSync([sumRow(id, MIN(NOW) - 10, { 'c.pct': 3 }), { kind: 'zz', target: id, minute: MIN(NOW) - 9, n: 1, data: Buffer.from('x') }]);
  assert.equal(n, 2);
  assert.equal((await db.readSum1(id, MIN(NOW) - 10, MIN(NOW) - 10)).length, 1);
  assert.equal((await db.readMetric(id, MIN(NOW) - 9, MIN(NOW) - 9)).length, 0, '모르는 kind 는 fm_metric 에 넣지 않는다');
});

/* ── ③ 긴 구간 조회 ─────────────────────────────────────────────────────── */
test('③ 칸 — 빈 칸은 null · 표본 수 가중 · 띠 · 지금 시간은 1분 요약을 합친다', async () => {
  const id = 'fm-hist-d';
  const t0 = HOUR - 3 * 3_600_000;
  const rows = [
    { t: t0, span: 60_000, s: SUM.summarizeBlock(blockOf(MIN(t0), [[t0 + 1, { 'c.pct': 10 }], [t0 + 2, { 'c.pct': 10 }], [t0 + 3, { 'c.pct': 10 }]])) },
    { t: t0 + 60_000, span: 60_000, s: SUM.summarizeBlock(blockOf(MIN(t0) + 1, [[t0 + 60_001, { 'c.pct': 50 }]])) },
  ];
  const b = L.sumBuckets(rows, 'c.pct', t0, t0 + 10 * 60_000, 5);
  assert.equal(b.avg[0], 20, '(10×3 + 50×1) / 4');
  assert.deepEqual([b.min[0], b.max[0]], [10, 50], '띠');
  assert.deepEqual(b.avg.slice(1), [null, null, null, null], '요약이 없는 칸은 null(0 이 아니다)');
  // 1시간 요약 + 지금 시간(끝나지 않음)은 1분 요약을 합친다
  const prevH = Math.floor(t0 / 3_600_000);
  assert.ok((await db.writeBlocks([{ kind: 's60', target: id, hour: prevH, data: SUM.encodeSum({ ...SUM.summarizeBlock(blockOf(MIN(t0), [[t0, { 'c.pct': 5 }]])), h: prevH }) },
    sumRow(id, MIN(HOUR) + 2, { 'c.pct': 70 })])).ok);
  const hr = await L.sumRowsFor(id, t0, NOW, 'h');
  assert.equal(hr[0].t, prevH * 3_600_000);
  const cur = hr.find((r) => r.t === HOUR);
  assert.ok(cur && cur.partial, '지금 시간 — 1분 요약을 합친 칸(partial)');
  assert.equal(SUM.sumCol(cur.s, 'c.pct').a, 70);
});

test('③ 긴 구간 서버 상세 · 겹쳐 보기 — 그때 없던 칸은 null · 표는 끝 순간 · 출처', async () => {
  const id = mock.DEMO_TARGETS[0].id;
  L._resetForTest();
  const w = Q.normWindow({ win: 1440 }, Date.now(), { long: true });
  assert.equal(w.long, true); assert.equal(w.win, 1440);
  assert.equal(Q.normWindow({ win: 1440 }, Date.now()).win, 5, '긴 구간을 받지 않는 곳(iostat · 프로세스)은 원래 기본값');
  const r = await L.longServer(id, w, { cmp: '1d' });
  assert.equal(r.points, L.LONG_POINTS[1440]);
  assert.equal(r.long.src, 'm');
  assert.equal(r.charts.band.min.length, r.points);
  for (let k = 0; k < r.points; k++) if (r.charts.band.min[k] != null) assert.ok(r.charts.band.min[k] <= r.charts.band.max[k]);
  assert.equal(r.overlay.cmp, '1d'); assert.equal(r.overlay.cpu.length, r.points, '겹쳐 보기는 같은 칸 수');
  assert.equal(r.at, 'end', '긴 구간 표는 끝 순간(구간 평균 없음)');
  const w30 = Q.normWindow({ win: 43200 }, Date.now(), { long: true });
  const r30 = await L.longServer(id, w30, {});
  assert.equal(r30.long.src, 'h');
  assert.ok(r30.charts.cpu.usr.filter((v) => v != null).every((v) => v > 0));
  // 빈 시간은 7일(1시간 칸 — 칸마다 1시간 요약 하나)에서 본다. 30일(4시간 칸)은 칸 경계가 지금 시각을 따라 움직여 3시간 남짓의 빈 시간이 한 칸을 다 덮지 않을 수 있다(시각에 따라 깨지던 시험)
  const r7 = await L.longServer(id, Q.normWindow({ win: 10080 }, Date.now(), { long: true }), {});
  assert.ok(r7.charts.cpu.usr.filter((v) => v == null).length >= 3, '이틀 전 아침(수집하지 않은 시간)은 null — 0 이 아니다');
  // 실제 대상 — 그때 수집하지 않은 앞날은 null
  const rid = 'fm-hist-d';
  const r2 = await L.longServer(rid, Q.normWindow({ win: 360 }, NOW, { long: true }), { cmp: '7d' }, NOW);
  assert.ok(r2.overlay.cpu.every((v) => v == null), '지난주 이 시간에는 기록이 없다 — 칸을 지어내지 않는다');
  // 어제 같은 시간 — 하루 앞의 기록을 같은 칸으로 옮긴다(지금 구간에는 기록이 없다)
  const yid = 'fm-hist-y';
  const yMin = MIN(NOW - 86_400_000 - 30 * 60_000);
  assert.ok((await db.writeBlocks([sumRow(yid, yMin, { 'c.pct': 42, 'm.pct': 61 })])).ok);
  L._resetForTest();
  const ry = await L.longServer(yid, Q.normWindow({ win: 360 }, NOW, { long: true }), { cmp: '1d' }, NOW);
  assert.ok(ry.charts.band.avg.every((v) => v == null), '지금 구간에는 기록이 없다');
  assert.deepEqual(ry.overlay.cpu.filter((v) => v != null), [42], '어제 기록이 같은 자리 칸에 하나');
  assert.deepEqual(ry.overlay.mem.filter((v) => v != null), [61]);
  const k = ry.overlay.cpu.findIndex((v) => v != null);
  const step = (6 * 3_600_000) / ry.points;
  assert.equal(k, Math.floor(((yMin * 60_000 + 30_000 + 86_400_000) - (NOW - 6 * 3_600_000)) / step), '하루 뒤로 옮긴 시각의 칸');
});

test('③ 데모 요약 비용 — 개요 20대 × 24시간이 이벤트 루프를 오래 막지 않는다', async () => {
  L._resetForTest();
  const ids = mock.DEMO_TARGETS.map((x) => x.id);
  const t0 = performance.now();
  const rows = mock.demoSumRows(ids[0], Date.now() - 86_400_000, Date.now(), 60_000);
  const one = performance.now() - t0;
  assert.ok(rows.length >= 1300 && rows.length <= 1441);
  assert.ok(one < 250, `서버 하나 24시간 ${Math.round(one)}ms — 칸마다 데모 표본을 만들면 약 500ms 였다`);
  const ov = await L.longOverview(ids, Q.normWindow({ win: 1440 }, Date.now(), { long: true }));
  assert.equal(ov.targets.length, ids.length);
  assert.ok(ov.targets[0].series.cpu.some((v) => v != null));
});

/* ── ④ 사건 ────────────────────────────────────────────────────────────── */
test('④ 자동 사건 — 가동 시간이 30초 넘게 줄면 재부팅 · 인증 · 호스트키는 바뀐 순간만 · 앞 상태를 모르면 적지 않는다', () => {
  store._resetForTest();
  const id = 'fm-hist-e';
  const smp = (up) => ({ cpu: { pct: 1, usr: 1, sys: 0, iow: 0, stl: 0 }, up });
  store.ingestSample(id, NOW, smp(5000), null, NOW);
  store.ingestSample(id, NOW + 2000, smp(5002), null, NOW + 2000);
  store.ingestSample(id, NOW + 4000, smp(4990), null, NOW + 4000); // 12초 줄었다 — 표본 순서 흔들림 · 재부팅 아님
  store.ingestSample(id, NOW + 6000, smp(40), null, NOW + 6000);
  let ev = store.drainWrites(1000).filter((r) => r.kind === 'e');
  // 사건 시각 = 켜진 시각(받은 시각 − 가동 시간) — 앞 표본보다 앞으로는 가지 않는다(반증 F9)
  assert.equal(ev.length, 1); assert.equal(ev[0].ekind, 'reboot'); assert.equal(ev[0].at, NOW + 4000, '켜진 시각(NOW−34초)이 앞 표본보다 앞이라 앞 표본 시각');
  // 공백 뒤 가동 시간이 예전 값보다 커졌으면 재부팅으로 보지 않는다(반증 재검토 N1 — 엣지 표본 시각을 당기면 벽시계 공백만 커져 거짓 재부팅이 생겼다 · 놓침을 고른다)
  store.ingestSample(id, NOW + 600_000, smp(100), null, NOW + 600_000);
  assert.equal(store.drainWrites(1000).filter((r) => r.kind === 'e').length, 0, '가동 시간이 줄지 않았으면 사건 없음');
  store.ingestSample(id, NOW + 610_000, smp(20), null, NOW + 610_000); // 쉬던 동안 재부팅 · 가동 시간이 줄었다 — 시각은 켜진 시각
  ev = store.drainWrites(1000).filter((r) => r.kind === 'e');
  assert.deepEqual(ev.map((e) => [e.ekind, e.at]), [['reboot', NOW + 600_000]], '켜진 시각(NOW+590초)이 앞 표본보다 앞이라 앞 표본 시각');
  store.ingestSample(id, NOW + 8000, smp(null), null, NOW + 8000);
  assert.equal(store.drainWrites(1000).filter((r) => r.kind === 'e').length, 0, '가동 시간을 못 읽으면 판정하지 않는다');
  store.setStatus(id, { state: 'auth' }, NOW);
  assert.equal(store.drainWrites(1000).filter((r) => r.kind === 'e').length, 0, '앞 상태를 모르면(기동 직후) 적지 않는다');
  store.setStatus(id, { state: 'ok' }, NOW + 1);
  store.setStatus(id, { state: 'hostkey' }, NOW + 2);
  store.setStatus(id, { state: 'hostkey' }, NOW + 3);
  // 반증 F2: 다시 시도할 때마다 'connecting' 을 거쳐 같은 상태로 — 사건이 아니다
  for (let k = 0; k < 5; k++) { store.setStatus(id, { state: 'connecting' }, NOW + 10 + k * 2); store.setStatus(id, { state: 'hostkey' }, NOW + 11 + k * 2); }
  store.setStatus(id, { state: 'auth' }, NOW + 40);
  ev = store.drainWrites(1000).filter((r) => r.kind === 'e');
  assert.deepEqual(ev.map((e) => e.ekind), ['hostkey', 'auth'], '같은 상태가 이어지거나 연결 중을 거쳐 돌아와도 다시 적지 않는다');
  store.setStatus(id, { state: 'connecting' }, NOW + 50); store.setStatus(id, { state: 'ok' }, NOW + 51); store.setStatus(id, { state: 'connecting' }, NOW + 52); store.setStatus(id, { state: 'auth' }, NOW + 53);
  assert.deepEqual(store.drainWrites(1000).filter((r) => r.kind === 'e').map((e) => e.ekind), ['auth'], '정상을 거쳐 다시 거부되면 새 사건');
  // 접속처가 바뀌면 옛 서버의 가동 시간으로 재부팅을 만들지 않는다(반증 F9)
  store.ingestSample(id, NOW + 650_000, smp(90_000), null, NOW + 650_000); // 옛 서버는 오래 켜져 있었다
  store.drainWrites(1000);
  store.forgetTargetState(id);
  store.ingestSample(id, NOW + 700_000, smp(5), null, NOW + 700_000); // 새 접속처의 첫 표본 — 가동 시간이 작아도 재부팅이 아니다
  assert.equal(store.drainWrites(1000).filter((r) => r.kind === 'e').length, 0);
  assert.equal(store.queueEvent(id, 'evil', 'x'), null, '모르는 종류는 받지 않는다');
  // 엣지 표본의 가동 시간도 정제 화이트리스트를 지난다
  const c = edge.cleanSample({ up: 123.5, junk: 1 });
  assert.equal(c.up, 123.5); assert.equal(c.junk, undefined);
  assert.equal(edge.cleanSample({ up: -5 }).up ?? null, null, '음수 가동 시간은 받지 않는다');
  assert.equal(edge.cleanSample({ up: 2e10 }).up ?? null, null, '상한 밖');
});

test('④ 직접 적는 사건 — 빈 글 · 시각 범위 · 제어 글자 · 범위 펴기(그룹 · 수집) · 상한', () => {
  store._resetForTest();
  const all = [{ id: 'a', group: 'DB' }, { id: 'b', group: 'db' }, { id: 'c', group: 'web' }, { id: 'd' }];
  const T = (id) => all.find((x) => x.id === id);
  assert.equal(EV.planUserEvent({ target: T('a'), all, text: '   ' }, NOW).code, 'empty');
  assert.equal(EV.planUserEvent({ target: T('a'), all, text: 'x', at: NOW - 31 * 86_400_000 }, NOW).code, 'bad-at');
  assert.equal(EV.planUserEvent({ target: T('a'), all, text: 'x', at: NOW + 2 * 3_600_000 }, NOW).code, 'bad-at');
  assert.equal(EV.planUserEvent({ target: T('a'), all, text: 'x', at: 'abc' }, NOW).code, 'bad-at');
  const p = EV.planUserEvent({ target: T('a'), all, text: '  배포\u0000 v2\n끝  ', by: 'admin1' }, NOW);
  assert.equal(p.ok, true); assert.equal(p.text, '배포  v2 끝'); assert.deepEqual(p.targets, ['a']); assert.match(p.id, /^ev-[0-9a-f]{12}$/);
  assert.equal(EV.planUserEvent({ target: T('a'), all, text: 'x'.repeat(900) }, NOW).text.length, EV.TEXT_MAX);
  assert.deepEqual(EV.planUserEvent({ target: T('a'), all, text: 'x', scope: 'group' }, NOW).targets, ['a', 'b'], '그룹은 대소문자 무시');
  assert.equal(EV.planUserEvent({ target: T('d'), all, text: 'x', scope: 'group' }, NOW).code, 'no-group');
  assert.equal(EV.planUserEvent({ target: T('a'), all, text: 'x', scope: 'session' }, NOW).code, 'no-session');
  assert.equal(EV.planUserEvent({ target: T('a'), all, text: 'x', scope: 'weird' }, NOW).scope, 'server', '모르는 범위는 이 서버');
  const many = Array.from({ length: 260 }, (_, i) => ({ id: `g${i}`, group: 'G' }));
  assert.equal(EV.planUserEvent({ target: many[0], all: many, text: 'x', scope: 'group' }, NOW).targets.length, EV.SCOPE_MAX, '대상 상한');
});

test('④ 사건 목록 — 기록된 사건 + 수집 시작 · 끝(fm_run) · 시각 순 번호 · 직접 적은 것만 user', async () => {
  const id = 'fm-hist-f';
  const plan = EV.planUserEvent({ target: { id }, all: [{ id }], text: '패치 적용', by: 'ops', at: NOW - 600_000 }, NOW);
  assert.ok((await EV.writeUserEvent(plan)).ok);
  assert.ok((await db.writeBlocks([{ kind: 'e', id: 'ev-aaaaaaaaaaaa', target: id, at: NOW - 900_000, ekind: 'reboot', text: '재부팅', by: 'mallory', scope: 'server' }])).ok);
  await db.writeRun({ id: 'run-h1', targets: [id], mode: 'record', interval: 2, started: NOW - 1_200_000, ended: NOW - 60_000, by: 'ops', why: 'stopped' });
  const r = await EV.eventsFor(id, NOW - 3_600_000, NOW);
  assert.deepEqual(r.events.map((e) => e.kind), ['start', 'reboot', 'user', 'stop']);
  assert.deepEqual(r.events.map((e) => e.n), [1, 2, 3, 4]);
  assert.equal(r.events.find((e) => e.kind === 'user').by, 'ops');
  assert.equal(r.events.find((e) => e.kind === 'reboot').by, '', '자동 사건에는 사람 이름이 없다');
  assert.deepEqual(r.events.filter((e) => e.user).map((e) => e.kind), ['user']);
  assert.equal(await db.deleteUserEvent('ev-aaaaaaaaaaaa'), 0, '자동 사건은 지우지 않는다');
  assert.equal(await db.deleteUserEvent(plan.id), 1);
});

/* ── ⑤ 가장 변했나 ──────────────────────────────────────────────────────── */
test('⑤ 점수 — 중앙값 비 × (1 − 겹침) · 같은 분포 0 · 칸 모자람 null · 0 근처 폭주 없음', () => {
  const same = [1, 2, 3, 4, 5, 6];
  assert.equal(CH.changeScore(same, same).score, 0);
  assert.equal(CH.overlapOf(same, same), 1);
  assert.equal(CH.overlapOf([1, 1], [9, 9]), 0);
  const up = CH.changeScore([10, 11, 10, 12, 10, 11], [40, 42, 41]);
  assert.equal(up.overlap, 0); assert.ok(Math.abs(up.score - Math.log((41 + 0.41) / (10.5 + 0.41))) < 0.01);
  assert.equal(CH.changeScore([1, 2, 3, 4], [1, 2, 3]), null, `앞 구간 칸 ${CH.MIN_A} 미만`);
  assert.equal(CH.changeScore([1, 2, 3, 4, 5], [1, 2]), null, `고른 구간 칸 ${CH.MIN_B} 미만`);
  const z = CH.changeScore([0, 0, 0, 0, 0], [0.001, 0, 0.002]);
  assert.ok(z.score < 5, `0 근처 ε 로 폭주하지 않는다(${z.score})`);
});

test('⑤ 두 구간을 같은 출처로 읽고 시각으로 나눈다 · 못 읽은 값은 뺀다 · 점수 순', async () => {
  CH._resetForTest();
  const id = 'fm-hist-g';
  const B = { from: NOW - 3_600_000, to: NOW }; const A = { from: NOW - 5 * 3_600_000, to: B.from };
  const rows = [];
  for (let m = MIN(A.from) + 1; m < MIN(B.to); m += 5) rows.push(sumRow(id, m, { 's.cpu': m * 60_000 >= B.from ? 80 : 20, 's.mem': 50, 's.wa': null }));
  assert.ok((await db.writeBlocks(rows)).ok);
  const v = await CH.valuesFor(id, A, B);
  assert.equal(v.src, 'm', '두 구간 합쳐 5시간 — 1분 요약(두 구간 같은 출처)');
  assert.ok(v.A.get('s.cpu').every((x) => x === 20) && v.B.get('s.cpu').every((x) => x === 80));
  assert.equal(v.A.get('s.wa').length, 0, '못 읽은 값은 0 이 아니라 뺀다');
  const r = await CH.biggestChanges([{ id, name: 'g' }], { win: 60, from: B.from, to: B.to }, NOW);
  assert.equal(r.rows[0].key, 's.cpu'); assert.equal(r.rows[0].a, 20); assert.equal(r.rows[0].b, 80);
  assert.ok(!r.rows.some((x) => x.key === 's.mem'), '변하지 않은 지표는 순위에 없다');
  assert.ok(r.rows[0].nA >= CH.MIN_A && r.rows[0].nB >= CH.MIN_B);
});

/* ── ⑥ 라우트 ──────────────────────────────────────────────────────────── */
test('⑥ 라우트 — 긴 구간 분기 · iostat 은 원본 · 사건 쓰기 · 지우기 문 · 감사 · 변화 조회', async () => {
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const svc = await import('../src/focusmon/service.js');
  const { auditEntriesWithAction } = await import('../src/audit.js');
  const users = {
    admin: { username: 'a', role: 'admin', scope: null },
    operator: { username: 'o', role: 'operator', scope: null },
    scoped: { username: 's', role: 'admin', scope: { vcenters: ['vc-x'] } },
    wscoped: { username: 'w', role: 'admin', scope: { writeVcenters: ['vc-x'] } },
    demo: { username: 'thedvcdemp', role: 'admin', scope: null, demoGuest: true },
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = users[req.headers['x-test-user'] || 'admin']; next(); });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, p, { who = 'admin', body } = {}) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'x-test-user': who }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* */ }
    return { status: r.status, body: json };
  };
  try {
    const id = mock.DEMO_TARGETS[0].id;
    const st = await call('GET', '/api/tools/focus-mon');
    assert.deepEqual(st.body.limits.longWindows, [60, 360, 1440, 10080, 43200], '화면은 긴 구간 단추를 응답에서 읽는다');
    assert.equal(st.body.limits.eventTextMax, EV.TEXT_MAX);
    assert.equal(typeof st.body.history.building, 'boolean');
    const ov = await call('GET', `/api/tools/focus-mon/data?view=overview&win=1440&targets=${id}`);
    assert.equal(ov.status, 200); assert.equal(ov.body.win, 1440); assert.equal(ov.body.longWin, true); assert.equal(ov.body.long.src, 'm');
    const cp = await call('GET', `/api/tools/focus-mon/data?view=compare&win=10080&metric=cpu&item=pct&targets=${id}`);
    assert.equal(cp.body.long.src, 'h'); assert.equal(cp.body.points, L.LONG_POINTS[10080]);
    const s60 = await call('GET', `/api/tools/focus-mon/data?view=server&win=60&at=avg&targets=${id}`);
    assert.equal(s60.body.win, 60); assert.equal(s60.body.long, undefined, '서버 상세 1시간은 원본'); assert.equal(s60.body.at, 'end', '긴 구간에는 구간 평균이 없다');
    assert.ok(Array.isArray(s60.body.events));
    const s6h = await call('GET', `/api/tools/focus-mon/data?view=server&win=360&cmp=7d&targets=${id}`);
    assert.equal(s6h.body.long.src, 'm'); assert.equal(s6h.body.cmp, '7d'); assert.equal(s6h.body.overlay.cmp, '7d');
    assert.equal((await call('GET', `/api/tools/focus-mon/data?view=server&win=360&cmp=99d&targets=${id}`)).body.cmp, null, '모르는 겹쳐 보기는 무시');
    assert.equal((await call('GET', `/api/tools/focus-mon/data?view=iostat&win=1440&targets=${id}`)).body.win, 5, 'iostat 비교는 원본 구간만');
    // 변화 조회 — 조회 문
    const ch = await call('GET', `/api/tools/focus-mon/changes?win=60&targets=${id}`);
    assert.equal(ch.status, 200); assert.ok(Array.isArray(ch.body.rows));
    for (const who of ['operator', 'scoped']) assert.equal((await call('GET', `/api/tools/focus-mon/changes?win=60&targets=${id}`, { who })).status, 403, who);
    // 사건 쓰기 — 관리자 · 조회 · 쓰기 전체 범위 · 데모 차단
    const body = { target: id, text: '배포 v1.2', scope: 'server' };
    for (const who of ['operator', 'scoped', 'wscoped', 'demo']) assert.equal((await call('POST', '/api/tools/focus-mon/events', { who, body })).status, 403, who);
    assert.equal((await call('POST', '/api/tools/focus-mon/events', { body: { ...body, target: 'fm-none' } })).status, 404);
    assert.equal((await call('POST', '/api/tools/focus-mon/events', { body: { ...body, text: ' ' } })).body.code, 'empty');
    const ok = await call('POST', '/api/tools/focus-mon/events', { body });
    assert.equal(ok.status, 200); assert.equal(ok.body.targets, 1);
    const sv = await call('GET', `/api/tools/focus-mon/data?view=server&win=30&targets=${id}`);
    assert.ok(sv.body.events.some((e) => e.id === ok.body.id && e.user && e.by === 'a'), '서버 상세에 사건이 실린다');
    // 지우기 — 같은 문 · 직접 적은 것만 · 형식
    for (const who of ['operator', 'scoped', 'wscoped', 'demo']) assert.equal((await call('DELETE', `/api/tools/focus-mon/events/${ok.body.id}`, { who })).status, 403, who);
    assert.equal((await call('DELETE', '/api/tools/focus-mon/events/run-x-s')).status, 404, '수집 시작 · 끝(자동)은 지우지 않는다');
    assert.ok((await db.writeBlocks([{ kind: 'e', id: 'ev-bbbbbbbbbbbb', target: id, at: Date.now() - 1000, ekind: 'reboot', text: 'r', by: '', scope: 'server' }])).ok);
    assert.equal((await call('DELETE', '/api/tools/focus-mon/events/ev-bbbbbbbbbbbb')).status, 404, '자동 사건은 지우지 않는다');
    assert.ok(auditEntriesWithAction('focus-mon.event-add').some((e) => e.user === 'a' && e.detail.includes('이 서버(1대)') && e.detail.includes('배포 v1.2')), '적기 감사');
    const del = await call('DELETE', `/api/tools/focus-mon/events/${ok.body.id}`);
    assert.equal(del.status, 200); assert.equal(del.body.removed, 1);
    assert.equal((await call('DELETE', `/api/tools/focus-mon/events/${ok.body.id}`)).status, 404, '두 번째는 없다');
    assert.ok(auditEntriesWithAction('focus-mon.event-delete').some((e) => e.detail.includes('적은 사람 a') && e.detail.includes('배포 v1.2')), '지우기 감사');
    // 등록부를 못 읽으면 적기는 503(등록부 함수의 거절에만 기대지 않는다) · 파일은 그대로
    const registry = await import('../src/focusmon/registry.js');
    const FILE = path.join(DIR, 'focusmon-targets.json');
    const had = fs.existsSync(FILE) ? fs.readFileSync(FILE) : null;
    fs.writeFileSync(FILE, '{ broken'); registry._resetForTest();
    const bad = await call('POST', '/api/tools/focus-mon/events', { body });
    assert.equal(bad.status, 503); assert.equal(bad.body.reason, 'registryUnreadable');
    for (const f of fs.readdirSync(DIR)) if (f.startsWith('focusmon-targets.json.corrupt')) fs.rmSync(path.join(DIR, f));
    if (had) fs.writeFileSync(FILE, had); else fs.rmSync(FILE, { force: true });
    registry._resetForTest();
  } finally { svc.stopFocusMon(); srv.close(); }
});

/* ── ⑦ 반증 1인 반영(F1 ~ F14) ───────────────────────────────────────────── */
test('⑦ F1 · F12 — 1시간 구간은 칸이 요약 간격 이상(번갈아 비지 않음) · 끝나지 않은 시간은 덮은 구간의 가운데', async () => {
  L._resetForTest();
  const id = 'fm-hist-p';
  const rows = [];
  for (let m = MIN(NOW) - 60; m < MIN(NOW); m++) rows.push(sumRow(id, m, { 'c.pct': 40, 's.cpu': 40 }));
  assert.ok((await db.writeBlocks(rows)).ok);
  assert.ok(L.LONG_POINTS[60] <= 60 / 1.5, `1시간 칸 수 ${L.LONG_POINTS[60]}`);
  const w = Q.normWindow({ win: 60 }, NOW, { long: true });
  const ov = await L.longOverview([id], w, NOW);
  const cp = await L.longCompare([id], w, { metric: 'cpu', item: 'pct' }, NOW);
  assert.equal(ov.targets[0].series.cpu.filter((v) => v == null).length, 0, '개요 칸이 비지 않는다');
  assert.equal(cp.targets[0].avg.filter((v) => v == null).length, 0, '비교 칸이 비지 않는다(선이 이어진다)');
  // 7일 — 지금 시간(정시 + 30분, 끝나지 않음)의 1분 요약이 마지막 칸에 들어간다(정시 가운데 +30분 = 지금이라 예전에는 버려질 수 있었다)
  const r7 = await L.sumRowsFor(id, NOW - 7 * 86_400_000, NOW, 'h');
  const cur = r7.find((r) => r.partial && r.t === HOUR);
  assert.ok(cur, '지금 시간 partial');
  const b = L.sumBuckets(r7, 'c.pct', NOW - 7 * 86_400_000, NOW, 168);
  assert.equal(b.avg[167], 40, '마지막 칸');
  // 정시 10분 뒤에 끝나는 구간 — 끝나지 않은 시간 칸의 가운데는 덮은 구간(정시 ~ 10분)의 가운데라 남는다(정시 가운데 +30분이면 구간 밖이라 버려졌다 · F12) · 끝 뒤의 분은 넣지 않는다
  const to = HOUR + 10 * 60_000 + 30_000;
  const id2 = 'fm-hist-p2'; // 지금 시간에만 기록이 있는 서버(앞 시간 칸이 마지막 칸을 대신 채우지 않게)
  const r2rows = []; for (let k = 0; k <= 10; k++) r2rows.push(sumRow(id2, MIN(HOUR) + k, { 'c.pct': 40 }));
  r2rows.push(sumRow(id2, MIN(HOUR) + 20, { 'c.pct': 99 }));
  assert.ok((await db.writeBlocks(r2rows)).ok);
  const rp = await L.sumRowsFor(id2, to - 7 * 86_400_000, to, 'h');
  const curp = rp.find((r) => r.partial && r.t === HOUR);
  assert.ok(curp && curp.s.t1 <= to, '끝 뒤의 분(20분 · 99)은 넣지 않는다');
  assert.equal(SUM.sumCol(curp.s, 'c.pct').hi, 40);
  assert.equal(L.sumBuckets(rp, 'c.pct', to - 7 * 86_400_000, to, 168).avg[167], 40, '정시 10분 뒤 끝 — 마지막 칸이 남는다');
});

test('⑦ F4 · F5 · F13 — 재시작 뒤 보관 기간 전체에서 1시간 요약 구멍을 찾는다 · 가운데 빠진 시간을 요청 경로에서 메우지 않는다 · 백필은 조각', async () => {
  rollup._resetForTest();
  const id = 'fm-hist-h';
  const old = HOUR - 72 * 3_600_000;
  const rows = []; for (let k = 0; k < 60; k++) rows.push(sumRow(id, MIN(old) + k, { 'c.pct': 77 }));
  assert.ok((await db.writeBlocks(rows)).ok);
  // 요청 경로: 1시간 요약이 없는 가운데 시간은 1분 요약으로 메우지 않는다(끝 PARTIAL_HOURS 시간만)
  const before = await L.sumRowsFor(id, old - 3_600_000, NOW, 'h');
  assert.equal(before.filter((r) => r.t === old).length, 0, '가운데 구멍은 요청에서 메우지 않는다(백그라운드가 채운다)');
  // 기동 할 일 찾기 — 48시간보다 오래된 시간도
  for (let i = 0; i < 50; i++) await rollup.seedDirty(NOW, 1000);
  await rollup.rollupTick(NOW, 1000, 10_000);
  assert.equal((await db.readSum60(id, Math.floor(old / 3_600_000), Math.floor(old / 3_600_000))).length, 1, '72시간 전 시간의 1시간 요약');
  const after = await L.sumRowsFor(id, old - 3_600_000, NOW, 'h');
  assert.equal(SUM.sumCol(after.find((r) => r.t === old).s, 'c.pct').a, 77);
  // 백필은 원본의 가장 오래된 분부터 범위를 조각(SCAN_SLICE_MIN 분)으로 묻는다 — 다 만든 뒤 재시작해도 원본 표 전체를 한 번에 훑지 않는다
  rollup._resetForTest();
  assert.equal(rollup.backfillState().cursorMinute, null);
  const oldest = await db.oldestMinute();
  await rollup.backfillSlice(NOW, 0); // 한 조각만(시간 0 — 첫 조각 뒤 멈춘다)
  const c1 = rollup.backfillState().cursorMinute;
  assert.ok(c1 != null && c1 >= oldest - 1 && c1 <= oldest - 1 + rollup.SCAN_SLICE_MIN, `첫 조각 커서 ${c1 - oldest}`);
});

test('⑦ F6 — 짧은 구간 겹쳐 보기: 그때 표본이 성기면(10초) 그 간격에 맞춰 묶은 뒤 늘인다(선이 이어진다)', async () => {
  store._resetForTest();
  const id = 'fm-hist-o';
  const end = Date.now() - 5_000;
  for (let t = end - 5 * 60_000 - 86_400_000; t <= end - 86_400_000; t += 10_000) store.ingestSample(id, t, { cpu: { pct: 20, usr: 20, sys: 0, iow: 0, stl: 0 }, mem: { pct: 50 } }, null, t + 100);
  store.closeAll();
  assert.ok((await db.writeBlocks(store.drainWrites(5000))).ok);
  for (let t = end - 5 * 60_000; t <= end; t += 2_000) store.ingestSample(id, t, { cpu: { pct: 30, usr: 30, sys: 0, iow: 0, stl: 0 }, mem: { pct: 60 } }, null, t);
  const r = await Q.serverDetail(id, Q.normWindow({ win: 5, end }, end + 3_000), { cmp: '1d' });
  const n = r.overlay.cpu.length;
  assert.equal(n, r.charts.band.avg.length, '같은 칸 수');
  const nulls = r.overlay.cpu.filter((v) => v == null).length;
  assert.ok(nulls <= 2, `어제 선 빈 칸 ${nulls}/${n} — 번갈아 비지 않는다`);
  assert.ok(r.overlay.cpu.filter((v) => v != null).every((v) => v === 20));
});

test('⑦ F11 — 수집 시작 · 더함 · 뺌 · 끝은 서버마다 적는다(뺀 서버의 기록이 남고 더한 서버는 더한 시각)', async () => {
  store._resetForTest();
  const [a, b, c] = ['fm-hist-sa', 'fm-hist-sb', 'fm-hist-sc'];
  const t0 = NOW - 600_000;
  const r = store.startSession({ targets: [a, b], interval: 2, mode: 'watch', by: 'ops' }, t0);
  assert.ok(r.ok);
  store.addToSession(r.session.id, [c], t0 + 60_000);
  store.removeFromSession(r.session.id, b, t0 + 120_000);
  store.stopSession(r.session.id, 'stopped', t0 + 180_000);
  assert.ok((await db.writeBlocks(store.drainWrites(1000))).ok);
  await db.writeRun({ id: r.session.id, started: t0, ended: t0 + 180_000, by: 'ops', mode: 'watch', interval: 2, targets: [a, c] });
  const kinds = async (id) => (await EV.eventsFor(id, t0 - 1000, NOW)).events.map((e) => [e.kind, e.at - t0]);
  assert.deepEqual(await kinds(b), [['start', 0], ['stop', 120_000]], '뺀 서버 — 시작 · 뺌이 남는다');
  assert.deepEqual(await kinds(c), [['start', 60_000], ['stop', 180_000]], '더한 서버 — 더한 시각');
  assert.deepEqual(await kinds(a), [['start', 0], ['stop', 180_000]], 'fm_run 합성과 겹치지 않는다(같은 수집은 한 번)');
  assert.equal((await EV.eventsFor(a, t0 - 1000, NOW)).events[0].by, 'ops', '시작에는 시작한 사람');
});

test('⑦ F3 · F7 · F10 — 데모 계정에 사람 이름 · 직접 적은 글 없음 · 앞 구간이 보관 밖이면 밝힘 · 지우기도 503', async () => {
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const svc = await import('../src/focusmon/service.js');
  const users = { admin: { username: 'real-admin', role: 'admin', scope: null }, demo: { username: 'thedvcdemp', role: 'admin', scope: null, demoGuest: true } };
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.user = users[req.headers['x-test-user'] || 'admin']; next(); });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, p, { who = 'admin', body } = {}) => { const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'x-test-user': who }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
  try {
    const id = mock.DEMO_TARGETS[1].id;
    const w = await call('POST', '/api/tools/focus-mon/events', { body: { target: id, text: '운영 메모 CHG-1234' } });
    assert.equal(w.status, 200);
    assert.ok((await db.writeBlocks([{ kind: 'e', id: 'run:fs-x:s:1', target: id, at: Date.now() - 2000, ekind: 'start', text: '잠깐 보기 시작(2초)', by: 'real-admin', scope: 'session' }])).ok);
    const a = await call('GET', `/api/tools/focus-mon/data?view=server&win=30&targets=${id}`);
    assert.ok(a.body.events.some((e) => e.user && e.by === 'real-admin'), '관리자에게는 보인다');
    const d = await call('GET', `/api/tools/focus-mon/data?view=server&win=30&targets=${id}`, { who: 'demo' });
    assert.equal(d.status, 200);
    assert.ok(!d.body.events.some((e) => e.user), '데모 계정에는 직접 적은 사건이 없다');
    assert.ok(d.body.events.every((e) => e.by === ''), '데모 계정에는 사람 이름이 없다');
    assert.ok(!JSON.stringify(d.body.events).includes('CHG-1234'));
    const c30 = await call('GET', `/api/tools/focus-mon/changes?win=43200&targets=${id}`);
    assert.equal(c30.body.aBeyond, true, '30일 구간의 앞 4배는 보관 기간 밖');
    const c1 = await call('GET', `/api/tools/focus-mon/changes?win=60&targets=${id}`);
    assert.equal(c1.body.aBeyond, false);
    const registry = await import('../src/focusmon/registry.js');
    const FILE = path.join(DIR, 'focusmon-targets.json');
    const had = fs.existsSync(FILE) ? fs.readFileSync(FILE) : null;
    fs.writeFileSync(FILE, '{ broken'); registry._resetForTest();
    const del = await call('DELETE', `/api/tools/focus-mon/events/${w.body.id}`);
    assert.equal(del.status, 503); assert.equal(del.body.reason, 'registryUnreadable');
    for (const f of fs.readdirSync(DIR)) if (f.startsWith('focusmon-targets.json.corrupt')) fs.rmSync(path.join(DIR, f));
    if (had) fs.writeFileSync(FILE, had); else fs.rmSync(FILE, { force: true });
    registry._resetForTest();
  } finally { svc.stopFocusMon(); srv.close(); }
});

test('⑦ F8 — 긴 구간 60초 기억에 끝 값을 넣지 않는다(수집 중 표가 묵지 않는다)', async () => {
  L._resetForTest(); store._resetForTest();
  const id = 'fm-hist-m';
  const now = Date.now();
  store.ingestSample(id, now - 4000, { cpu: { pct: 10, usr: 10, sys: 0, iow: 0, stl: 0 } }, null, now - 4000);
  const w = Q.normWindow({ win: 360 }, now, { long: true });
  const r1 = await L.longServer(id, w, {}, now);
  store.ingestSample(id, now - 1000, { cpu: { pct: 90, usr: 90, sys: 0, iow: 0, stl: 0 } }, null, now - 1000);
  const r2 = await L.longServer(id, w, {}, now + 1000);
  assert.equal(r1.table.cpu.pct, 10); assert.equal(r2.table.cpu.pct, 90, '두 번째(기억 안)도 최신 표본');
  assert.equal(r2.lastAt, now - 1000);
  // 개요도 같은 규칙(끝 값은 매번)
  const o1 = await L.longOverview([id], w, now + 1500);
  store.ingestSample(id, now - 500, { cpu: { pct: 55, usr: 55, sys: 0, iow: 0, stl: 0 } }, null, now - 500);
  const o2 = await L.longOverview([id], w, now + 2000);
  assert.equal(o1.targets[0].sum.cpu, 90); assert.equal(o2.targets[0].sum.cpu, 55, '개요 — 기억 안에서도 최신 끝 값');
});

test('⑦ F2 · F13 — 사건이 200건 넘으면 최근 쪽을 남긴다(DB · 목록) · 백필은 빈 조각(6시간 넘는 공백)을 건너 끝까지 간다', async () => {
  const id = 'fm-hist-t';
  const rows = [];
  for (let k = 0; k < 300; k++) rows.push({ kind: 'e', id: `ev-a${String(k).padStart(11, '0')}`, target: id, at: NOW - 3_600_000 + k * 1000, ekind: 'hostkey', text: 'h', by: '', scope: 'server' });
  rows.push({ kind: 'e', id: 'ev-ffffffffffff', target: id, at: NOW - 1000, ekind: 'user', text: '최근 메모', by: 'ops', scope: 'server' });
  assert.ok((await db.writeBlocks(rows)).ok);
  const db200 = await db.readEvents(id, NOW - 7_200_000, NOW, 200);
  assert.equal(db200[db200.length - 1].kind, 'user', 'DB 도 최근 쪽 · 시각 순');
  await db.writeRun({ id: 'fs-hist-old', targets: [id], mode: 'watch', interval: 2, started: NOW - 3_650_000, ended: null, by: 'x' }); // 업그레이드 전 수집(합성) — 목록이 200을 넘는다
  const r = await EV.eventsFor(id, NOW - 7_200_000, NOW);
  assert.equal(r.events.length, 200); assert.equal(r.cut, 1, '오래된 1건을 잘랐다');
  assert.ok(r.events.some((e) => e.user && e.text === '최근 메모'), '최근에 직접 적은 사건이 남는다');
  // 백필 — 원본에 6시간 넘는 공백이 있어도 끝까지(빈 조각에서 멈추지 않는다)
  rollup._resetForTest();
  const g = 'fm-hist-gap';
  const a0 = MIN(NOW) - 20 * 60; const a1 = MIN(NOW) - 8 * 60;
  const mk = (m) => ({ kind: 'm', target: g, minute: m, n: 1, data: CODEC.encodeBlock(blockOf(m, [[m * 60_000 + 500, { 'c.pct': 1 }]])) });
  assert.ok((await db.writeBlocks([mk(a0), mk(a1)])).ok);
  for (let i = 0; i < 400 && rollup.backfillState().building; i++) await rollup.backfillSlice(NOW, 1000);
  assert.equal((await db.readSum1(g, a1, a1)).length, 1, '공백 뒤의 분도 요약');
});

test('⑦ 재검토 N2 · N4 · N5 — 지금 시간 할 일은 세지 않음 · 넘겨받으면 끝 사건 · 합성은 종류별로', async () => {
  // N2 — 지금 시간 항목만 많으면 '만드는 중' 이 아니다
  rollup._resetForTest();
  for (let k = 0; k < 35; k++) rollup.markDirty(`fm-cur-${k}`, MIN(Date.now()));
  await rollup.backfillSlice(Date.now(), 1000); for (let i = 0; i < 200 && rollup.backfillState().building; i++) await rollup.backfillSlice(Date.now(), 1000);
  assert.equal(rollup.backfillState().building, false, '지금 시간 할 일 35개 — 만드는 중 아님');
  rollup._resetForTest();
  // N4 — 잠깐 보기 서버를 계속 수집이 넘겨받으면 잠깐 보기 쪽 끝 사건
  store._resetForTest();
  const w1 = store.startSession({ targets: ['fm-mv-a', 'fm-mv-b'], interval: 2, mode: 'watch', by: 'u' }, NOW - 50_000);
  assert.ok(w1.ok);
  const r2 = store.startSession({ targets: ['fm-mv-a'], interval: 2, mode: 'record', by: 'u' }, NOW - 40_000);
  assert.ok(r2.ok); assert.deepEqual(r2.moved, ['fm-mv-a']);
  const ev = store.drainWrites(1000).filter((r) => r.kind === 'e' && r.target === 'fm-mv-a').map((r) => [r.ekind, r.text]);
  assert.deepEqual(ev, [['start', '잠깐 보기 시작(2초)'], ['stop', '잠깐 보기 끝 — 계속 수집이 넘겨받음'], ['start', '계속 수집 시작(2초)']]);
  // N5 — 업그레이드 전에 시작해 지금 끝난 수집: 끝만 서버마다 적혀 있어도 시작은 fm_run 에서 만든다
  const id = 'fm-hist-n5';
  await db.writeRun({ id: 'fs-old-n5', targets: [id], mode: 'record', interval: 2, started: NOW - 900_000, ended: NOW - 100_000, by: 'old' });
  assert.ok((await db.writeBlocks([{ kind: 'e', id: `run:fs-old-n5:e:${NOW - 100_000}`, target: id, at: NOW - 100_000, ekind: 'stop', text: '계속 수집 끝', by: '', scope: 'session' }])).ok);
  const r = await EV.eventsFor(id, NOW - 3_600_000, NOW);
  assert.deepEqual(r.events.map((e) => [e.kind, e.at - NOW]), [['start', -900_000], ['stop', -100_000]], '시작은 합성 · 끝은 적은 것 하나(겹치지 않음)');
});

test('⑦ 재검토 N3 — 요약이 없으면 할 일 찾기를 끝낸다', async () => {
  const DIR2 = tmpDir('focusmonhist3130-n3-');
  const { spawnSync } = await import('node:child_process');
  const code = `process.env.CONFIG_DIR=${JSON.stringify(DIR2)};const r=await import(${JSON.stringify(new URL('../src/focusmon/rollup.js', import.meta.url).href)});await r.seedDirty(Date.now(),1000);await r.seedDirty(Date.now(),1000);console.log(JSON.stringify({n:await r.seedDirty(Date.now(),1000)}));`;
  const out = spawnSync(process.execPath, ['--experimental-sqlite', '--input-type=module', '-e', code], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(out.status, 0, out.stderr.slice(0, 300));
  assert.match(out.stdout, /\{"n":0\}/);
  // 끝났는지 — 원본 코드: null 이면 seed.done = true (소스 확인 — 같은 프로세스의 상태를 들여다볼 출입구가 없다)
  const src = fs.readFileSync(new URL('../src/focusmon/rollup.js', import.meta.url), 'utf8');
  assert.match(src, /if \(o == null\) \{ seed\.done = true; return 0; \}/);
});

test('⑦ 재검토 F8 나머지 — 긴 구간 비교 · CSV 의 시각 축은 기억한 칸의 기준', async () => {
  L._resetForTest();
  const id = mock.DEMO_TARGETS[2].id;
  const t = Date.now();
  const w1 = Q.normWindow({ win: 1440 }, t, { long: true });
  const a = await L.longCompare([id], w1, { metric: 'cpu', item: 'pct' }, t);
  const w2 = Q.normWindow({ win: 1440 }, t + 20_000, { long: true });
  const b = await L.longCompare([id], w2, { metric: 'cpu', item: 'pct' }, t + 20_000);
  if (Math.floor(w1.to / 60_000) === Math.floor(w2.to / 60_000)) {
    assert.equal(b.from, a.from, '기억한 칸 — 기준 시각도 기억한 것'); assert.equal(b.to, a.to);
  }
  assert.equal(a.from, w1.from); assert.equal(a.to, w1.to);
  const csv = fs.readFileSync(new URL('../src/routes/api/focusMon.js', import.meta.url), 'utf8');
  assert.match(csv, /const f0 = r\.from \?\? w\.from; const t1 = r\.to \?\? w\.to;/);
});
