// v2.635 — 베어메탈 스토리지 디스크 사용량 12시간 이력(사용자 요청: 서버·그룹·합계를 12시간마다 별도 DB 에 저장,
// 1일/7일/1달/분기/반기 차트). 이 테스트가 고정하는 것:
//  ① 낡은 결과·못 읽은 서버는 합에 넣지 않고, 그 그룹·합계는 부분 합(partial)으로 적재한다(거짓 하락 방지)
//  ② 한 대도 못 읽었으면 행을 만들지 않는다(0 바이트 = '비었다' 는 거짓)
//  ③ 슬롯(KST 0시·12시)당 한 번 — 같은 슬롯에서는 더 온전한 값만 덮는다
//  ④ 폴러가 기동 뒤 한 번도 돌지 않았으면 적재하지 않는다
//  ⑤ 조회 API 가 기간·종류를 지키고 주소를 싣지 않는다
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bmhist-'));
process.env.BMSTOR_HISTORY_DB_PATH = path.join(TMP, 'bmstor-history.db');
delete process.env.BMSTOR_HISTORY_INTERVAL_HOURS;

const H = 3_600_000;
const T = 1_790_000_000_000;                 // 고정 기준 시각(Date.now 금지 — CLAUDE.md)
const TB = 1024 ** 4;
const srv = (id, groups, extra = {}) => ({ id, name: id.toUpperCase(), host: `10.0.0.${id.length}`, groups, mounts: ['/'], enabled: true, ...extra });
const res = (tb, usedTb, at = T - 60_000, extra = {}) => ({
  ok: true, at, mounts: [{ mount: '/', totalBytes: tb * TB, usedBytes: usedTb * TB, availBytes: (tb - usedTb) * TB, usedPct: 0 }], missing: [], ...extra,
});

let hist; let db; let sampler;
before(async () => {
  hist = await import('../src/bmstor/history.js');
  db = await import('../src/bmstor/historyDb.js');
  sampler = await import('../src/bmstor/historySampler.js');
});
after(() => { db._resetBmHistoryDbForTest(); fs.rmSync(TMP, { recursive: true, force: true }); });

test('① buildHistoryRows: 서버·그룹·합계 행 + 못 읽은 서버가 있으면 그 그룹·합계는 부분 합', () => {
  const servers = [srv('a', ['G1']), srv('b', ['G1', 'G2']), srv('c', ['G2']), srv('d', [], { enabled: false })];
  const latest = new Map([
    ['a', res(10, 4)],
    ['b', res(20, 5)],
    ['c', { ok: false, at: T - 60_000, mounts: [], error: 'ssh' }],
    ['d', res(99, 99)],
  ]);
  const { rows, excluded } = hist.buildHistoryRows(servers, latest, { now: T, freshMs: 30 * 60_000 });
  const by = (k, key) => rows.find((r) => r.kind === k && r.key === key);
  assert.equal(excluded, 1, '오류 서버 c');
  assert.ok(!by('server', 'c'), '못 읽은 서버는 행을 만들지 않는다');
  assert.ok(!by('server', 'd'), '비활성 서버는 제외');
  assert.equal(by('server', 'a').usedBytes, 4 * TB);
  assert.equal(by('group', 'G1').usedBytes, 9 * TB);
  assert.equal(by('group', 'G1').partial, false);
  assert.equal(by('group', 'G2').usedBytes, 5 * TB, 'G2 는 b 만 더했다');
  assert.equal(by('group', 'G2').partial, true, 'c 를 못 읽었으니 부분 합');
  assert.equal(by('group', 'G2').read, 1);
  assert.equal(by('group', 'G2').servers, 2);
  const tot = by('total', '');
  assert.equal(tot.usedBytes, 9 * TB, '비활성 d(99TB)는 합계에 없다');
  assert.equal(tot.partial, true);
  assert.equal(tot.read, 2);
  assert.equal(tot.servers, 3);
});

test('① 낡은 결과(freshMs 초과)는 못 읽은 것으로 센다 · 마운트를 못 찾은 서버는 그 서버·그룹·합계가 부분 합', () => {
  const servers = [srv('a', ['G1']), srv('b', ['G1'])];
  const latest = new Map([['a', res(10, 4, T - 2 * H)], ['b', res(10, 1, T - 60_000, { missing: ['/data'] })]]);
  const { rows, stale } = hist.buildHistoryRows(servers, latest, { now: T, freshMs: 30 * 60_000 });
  assert.equal(stale, 1);
  assert.ok(!rows.find((r) => r.kind === 'server' && r.key === 'a'));
  assert.equal(rows.find((r) => r.kind === 'server' && r.key === 'b').partial, true);
  assert.equal(rows.find((r) => r.kind === 'group' && r.key === 'G1').partial, true);
  assert.equal(rows.find((r) => r.kind === 'total').partial, true);
});

test('② 한 대도 못 읽었으면 행이 없다(0 바이트를 지어내지 않는다)', () => {
  const servers = [srv('a', ['G1'])];
  assert.deepEqual(hist.buildHistoryRows(servers, new Map(), { now: T }).rows, []);
  assert.deepEqual(hist.buildHistoryRows(servers, new Map([['a', { ok: false, at: T, mounts: [] }]]), { now: T }).rows, []);
});

test('③ slotOf: KST 0시·12시에 슬롯이 바뀐다 · 환경변수 간격은 1~24시간', () => {
  const kstMidnight = Date.UTC(2026, 8, 28, 15, 0, 0);   // 2026-09-29 00:00 KST
  const s = hist.slotOf(kstMidnight);
  assert.equal(hist.slotOf(kstMidnight - 1), s - 1);
  assert.equal(hist.slotOf(kstMidnight + 12 * H - 1), s);
  assert.equal(hist.slotOf(kstMidnight + 12 * H), s + 1);
  assert.equal(hist.slotStart(s), kstMidnight);
  process.env.BMSTOR_HISTORY_INTERVAL_HOURS = '';
  assert.equal(hist.historyIntervalHours(), 12, '빈 값은 미지정');
  process.env.BMSTOR_HISTORY_INTERVAL_HOURS = '100';
  assert.equal(hist.historyIntervalHours(), 24);
  process.env.BMSTOR_HISTORY_INTERVAL_HOURS = 'x';
  assert.equal(hist.historyIntervalHours(), 12);
  delete process.env.BMSTOR_HISTORY_INTERVAL_HOURS;
  process.env.BMSTOR_HISTORY_RETENTION_DAYS = '';
  assert.equal(hist.historyRetentionDays(), 1825, '빈 값이 0(전부 보관)으로 둔갑하지 않는다');
  process.env.BMSTOR_HISTORY_RETENTION_DAYS = '0';
  assert.equal(hist.historyRetentionDays(), 0);
  delete process.env.BMSTOR_HISTORY_RETENTION_DAYS;
});

test('③ DB: 같은 슬롯에서 부분 합은 온전한 합을 덮지 못하고, 온전한 합은 부분 합을 덮는다', async () => {
  const slot = 5000;
  const part = { kind: 'total', key: '', name: '전체 합계', totalBytes: 10, usedBytes: 4, availBytes: 6, servers: 3, read: 2, partial: true };
  const full = { ...part, totalBytes: 30, usedBytes: 9, availBytes: 21, read: 3, partial: false };
  assert.equal((await db.commitBmHistory({ slot, ts: T - 5 * H, rows: [part] })).written, 1);
  assert.equal((await db.commitBmHistory({ slot, ts: T - 4 * H, rows: [full] })).written, 1, '부분 → 온전');
  assert.equal((await db.commitBmHistory({ slot, ts: T - 3 * H, rows: [part] })).written, 0, '온전 → 부분 은 거부');
  const r = await db.bmHistoryRange(T - 10 * H, T);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].usedBytes, 9);
  assert.equal(r.rows[0].partial, false);
  assert.deepEqual(await db.totalOfSlot(slot), { exists: true, partial: false, read: 3 });
  assert.equal((await db.totalOfSlot(slot + 1)).exists, false);
});

test('④ 샘플러: 첫 수집 전에는 적재하지 않고, 슬롯당 한 번 · 부분 합이면 새 수집마다 보강', async () => {
  sampler._resetBmHistorySamplerForTest();
  const servers = [srv('a', ['G1']), srv('b', ['G1'])];
  let latest = new Map([['a', res(10, 4)]]);
  let pollAt = 0;
  const deps = { listServers: () => servers, latest: () => latest, pollStatus: () => ({ lastRunAt: pollAt, intervalMinutes: 10 }) };
  const now = Date.UTC(2026, 8, 28, 16, 0, 0);          // 2026-09-29 01:00 KST
  assert.equal((await sampler.sampleBmHistoryOnce({ now, deps })).reason, 'no-collection');
  pollAt = now - 60_000;
  latest = new Map([['a', res(10, 4, now - 60_000)]]);
  const r1 = await sampler.sampleBmHistoryOnce({ now, deps });
  assert.equal(r1.ok, true);
  assert.equal(r1.partial, true, 'b 를 못 읽었다');
  assert.equal((await sampler.sampleBmHistoryOnce({ now: now + 60_000, deps })).reason, 'same-collection', '같은 수집으로 다시 적재하지 않는다');
  pollAt = now + 10 * 60_000;
  latest = new Map([['a', res(10, 4, pollAt)], ['b', res(10, 2, pollAt)]]);
  const r2 = await sampler.sampleBmHistoryOnce({ now: now + 11 * 60_000, deps });
  assert.equal(r2.ok, true);
  assert.equal(r2.partial, false);
  assert.equal((await sampler.sampleBmHistoryOnce({ now: now + 20 * 60_000, deps })).reason, 'slot-done');
  // 재시작 뒤에도 같은 슬롯은 다시 적재하지 않는다(DB 기록을 본다).
  sampler._resetBmHistorySamplerForTest();
  pollAt = now + 30 * 60_000;
  assert.equal((await sampler.sampleBmHistoryOnce({ now: now + 31 * 60_000, deps })).reason, 'slot-done');
  // 다음 슬롯(13:00 KST)에는 다시 적재한다.
  latest = new Map([['a', res(10, 5, now + 12 * H)], ['b', res(10, 2, now + 12 * H)]]);
  pollAt = now + 12 * H;
  assert.equal((await sampler.sampleBmHistoryOnce({ now: now + 12 * H + 60_000, deps })).ok, true);
  const rng = await db.bmHistoryRange(now - H, now + 13 * H, { kind: 'total' });
  assert.equal(rng.rows.length, 2, '슬롯 두 개 = 합계 행 두 개');
  assert.deepEqual(rng.rows.map((x) => x.usedBytes / TB), [6, 7]);
  const st = sampler.bmHistoryStatus();
  assert.equal(st.intervalHours, 12);
  assert.equal(st.intervalMs, 12 * H);
});

test('④ 등록 서버가 없으면 적재하지 않고 비활성으로 보고한다(서비스 점검이 경고를 내지 않게)', async () => {
  sampler._resetBmHistorySamplerForTest();
  const r = await sampler.sampleBmHistoryOnce({ now: T, deps: { listServers: () => [], latest: () => new Map(), pollStatus: () => ({ lastRunAt: T }) } });
  assert.equal(r.reason, 'no-servers');
  assert.equal(sampler.bmHistoryStatus().enabled, false);
});

test('seriesFromRows: 합계 → 그룹 → 서버 순 · 서버 이름은 현재 등록부 · 지워진 서버는 deleted', () => {
  const rows = [
    { kind: 'server', key: 'x', ts: 1, name: 'OLD', totalBytes: 1, usedBytes: 1, availBytes: 0, servers: 1, read: 1, partial: false },
    { kind: 'server', key: 'gone', ts: 1, name: 'GONE', totalBytes: 1, usedBytes: 1, availBytes: 0, servers: 1, read: 1, partial: false },
    { kind: 'group', key: '', ts: 1, name: '(그룹 없음)', totalBytes: 1, usedBytes: 1, availBytes: 0, servers: 1, read: 1, partial: false },
    { kind: 'total', key: '', ts: 1, name: '전체 합계', totalBytes: 1, usedBytes: 1, availBytes: 0, servers: 1, read: 1, partial: true },
  ];
  const s = hist.seriesFromRows(rows, { servers: [{ id: 'x', name: 'NEW' }] });
  assert.deepEqual(s.map((x) => x.kind), ['total', 'group', 'server', 'server']);
  assert.equal(s.find((x) => x.key === 'x').name, 'NEW');
  assert.equal(s.find((x) => x.key === 'gone').deleted, true);
  assert.equal(s[0].points[0].partial, true);
  assert.equal(s[1].name, '(그룹 없음)');
});

test('⑤ 조회 API: 기간 선택지 5종 · 모르는 기간은 7일 · 응답에 호스트 주소가 없다', async () => {
  const express = (await import('express')).default;
  const { registerBmStorage } = await import('../src/routes/api/bmstor.js');
  const app = express();
  const api = express.Router();
  app.use((req, _res, next) => { req.user = { username: 't', role: 'admin', scope: {} }; next(); });
  registerBmStorage(api);
  app.use('/api', api);
  const server = app.listen(0);
  try {
    const port = server.address().port;
    const j = await (await fetch(`http://127.0.0.1:${port}/api/tools/bm-storage/history?period=zzz&kind=total`)).json();
    assert.equal(j.ok, true);
    assert.equal(j.period, '7d');
    assert.deepEqual(j.periods.map((p) => p.label), ['1일', '7일', '1달', '분기', '반기']);
    assert.equal(j.kind, 'total');
    assert.equal(j.to - j.from, 7 * 86_400_000);
    assert.ok(!/10\.0\.0\./.test(JSON.stringify(j)), '주소를 싣지 않는다');
    const j2 = await (await fetch(`http://127.0.0.1:${port}/api/tools/bm-storage/history?period=6m&kind=bogus`)).json();
    assert.equal(j2.period, '6m');
    assert.equal(j2.kind, null, '모르는 kind 는 전체');
  } finally { server.close(); }
});

test('보존 정리: 첫 호출은 건너뛴다(v2.453) · 0 = 전부 보관', async () => {
  db._resetBmHistoryDbForTest();
  assert.equal((await db.pruneBmHistory(30, { every: 2 })).skipped, true);
  assert.equal((await db.pruneBmHistory(0, { every: 1 })).reason, '전부 보관');
});
