/**
 * v2.603 감사 그룹 c — DB 보존 정리(청크·진행 공유)·보존일 검증·로그 설정 로드 클램프·일일 보고 재시도 간격·VM 통계 분모.
 * DB2603-02 · DB2603-03 · RECENT2603-03 · RECENT2603-06 · TIM2603-01 · TIM2603-02 · LEFT2603-03.
 * 기준 시각에 Date.now() 를 쓰지 않는다 — 보존 경계와 한참 떨어진 고정 시각(2001년)이나 '지금 − N일' 대신
 * 경계를 몇 년 넘긴 과거 값만 쓴다(경계 근처에 표본을 두지 않는다).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2603c-'));
process.env.CONFIG_DIR = DIR;
process.env.PRUNE_CHUNK_ROWS = '500';             // 청크를 작게 — 여러 청크로 나뉘는지(양보하는지) 본다
process.env.PING_DB_PATH = path.join(DIR, 'ping.db');
process.env.CURUSER_DB_PATH = path.join(DIR, 'curuser.db');
process.env.HZSESS_DB_PATH = path.join(DIR, 'hz.db');
process.env.VMSERIES_DB_DIR = path.join(DIR, 'vmseries');
process.env.VMTRACK_DB_PATH = path.join(DIR, 'vm-track.db');

const OLD = 1_000_000_000_000;          // 2001-09 — 어떤 보존 경계보다 과거
const DAY = 86_400_000;
const { DatabaseSync } = await import('node:sqlite');

/** 약속이 끝날 때까지 setImmediate 프로브가 몇 번 돌았는지 — 0 이면 정리가 루프를 한 번도 양보하지 않은 것이다. */
async function yieldsWhile(p) {
  let n = 0; let done = false;
  const spin = () => { if (done) return; n++; setImmediate(spin); };
  setImmediate(spin);
  const r = await p;
  done = true;
  return { r, yields: n };
}
function bulk(file, sql, rows) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout=3000; BEGIN');
  const st = db.prepare(sql);
  for (const r of rows) st.run(...r);
  db.exec('COMMIT');
  db.close();
}
const count = (file, sql) => { const db = new DatabaseSync(file); const n = db.prepare(sql).get().n; db.close(); return Number(n); };

// ── DB2603-02 ────────────────────────────────────────────────────────────────
test('DB2603-02: 통신 점검 보존 정리는 청크로 나눠 양보하며 전부 지운다', async () => {
  const lc = await import('../src/linkcheck/db.js');
  assert.ok(await lc.available(), 'linkcheck DB');
  const file = path.join(DIR, 'link-check.db');
  bulk(file, 'INSERT INTO link_sample (link_id, ts, ok) VALUES (?, ?, 1)', Array.from({ length: 3000 }, (_, i) => ['l1', OLD + i]));
  bulk(file, 'INSERT INTO link_event (link_id, ts, event) VALUES (?, ?, ?)', Array.from({ length: 1200 }, (_, i) => ['l1', OLD + i, 'fail']));
  const { r, yields } = await yieldsWhile(lc.pruneLinkCheck({ sampleDays: 90, eventDays: 30, dailyDays: 365, force: true }));
  assert.equal(r.ok, true);
  assert.equal(r.sample, 3000);
  assert.equal(r.event, 1200);
  assert.equal(r.done, true);
  assert.ok(yields >= 5, `청크 사이에 양보해야 한다(프로브 ${yields}회)`);
  assert.equal(count(file, 'SELECT COUNT(*) n FROM link_sample'), 0);
});

test('DB2603-02: 통신 점검 — 보존일이 다르면 진행 중인 정리가 끝난 뒤 새 경계로 한 번 더 돈다', async () => {
  const lc = await import('../src/linkcheck/db.js');
  const file = path.join(DIR, 'link-check.db');
  // 아주 오래된 행(어느 보존일에도 삭제) + 약 3년 전 행은 보존일 5년에는 남고 90일에는 지워진다.
  const threeYearsAgo = Date.parse('2023-06-01T00:00:00Z');
  bulk(file, 'INSERT INTO link_sample (link_id, ts, ok) VALUES (?, ?, 1)', Array.from({ length: 2000 }, (_, i) => ['l2', OLD + i]));
  bulk(file, 'INSERT INTO link_sample (link_id, ts, ok) VALUES (?, ?, 1)', Array.from({ length: 700 }, (_, i) => ['l3', threeYearsAgo + i]));
  const p1 = lc.pruneLinkCheck({ sampleDays: 365 * 10, eventDays: 30, dailyDays: 365, force: true });
  const p2 = lc.pruneLinkCheck({ sampleDays: 90, eventDays: 30, dailyDays: 365, force: true });
  const [a, b] = await Promise.all([p1, p2]);
  assert.equal(a.sample, 2000);
  assert.equal(b.sample, 700, '두 번째 호출은 새 보존일(90일)로 돌아야 한다 — 공유만 하면 0 이다');
  assert.equal(count(file, 'SELECT COUNT(*) n FROM link_sample'), 0);
});

test('DB2603-02: ping prune 은 Promise 이고 청크 사이에 양보한다', async () => {
  const { getPingDb } = await import('../src/ping/db.js');
  const db = await getPingDb();
  assert.equal(db.kind, 'sqlite');
  db.insertMany(Array.from({ length: 4000 }, (_, i) => ({ target: 't1', ts: OLD + i, rtt: 1, ok: true })));
  db.insertMany([{ target: 't1', ts: Date.parse('2030-01-01T00:00:00Z'), rtt: 1, ok: true }]);   // 경계 한참 뒤(미래) — 남는다
  const p = db.prune(Date.parse('2020-01-01T00:00:00Z'));
  assert.ok(p && typeof p.then === 'function', 'prune 은 약속을 돌려줘야 한다(동기 DELETE 한 방 금지)');
  const { r, yields } = await yieldsWhile(p);
  assert.equal(r.deleted, 4000);
  assert.ok(r.chunks >= 8, `청크 수 ${r.chunks}`);
  assert.ok(yields >= 5, `양보 ${yields}회`);
  assert.equal(db.meta('t1').count, 1);
});

test('DB2603-02: 현재 사용자·Horizon 세션·vmseries 정리도 청크로 양보한다', async () => {
  const cu = await import('../src/curuser/db.js');
  await cu.curUserDbStatus();
  await cu.commitCurUser({ ts: OLD, records: [], series: [] });
  bulk(process.env.CURUSER_DB_PATH, 'INSERT INTO vc_series (vcenter_id, ts) VALUES (?, ?)', Array.from({ length: 2500 }, (_, i) => ['vc', OLD + i]));
  const c = await yieldsWhile(cu.pruneCurUser(180, { every: 1 }));
  assert.equal(c.r.series, 2500);
  assert.ok(c.yields >= 3, `curuser 양보 ${c.yields}회`);

  const hz = await import('../src/horizon/sessionDb.js');
  await hz.hzSessionDbStatus();
  await hz.commitHzSessions({ ts: OLD, records: [], series: [] });
  bulk(process.env.HZSESS_DB_PATH, 'INSERT INTO hz_series (server_id, ts) VALUES (?, ?)', Array.from({ length: 2500 }, (_, i) => ['s1', OLD + i]));
  const h = await yieldsWhile(hz.pruneHzSessions(30, { every: 1 }));
  assert.equal(h.r.series, 2500);
  assert.ok(h.yields >= 3, `horizon 양보 ${h.yields}회`);

  const vs = await import('../src/vmseries/db.js');
  const x = await vs.getVmSeriesDb('vc-a');
  assert.ok(x, 'vmseries DB');
  x.db.exec('BEGIN');
  const ins = x.db.prepare("INSERT INTO spikes (kind, ref, t0, t1, n, cols, data) VALUES ('vm', ?, ?, ?, 1, '[]', x'00')");
  for (let i = 0; i < 2500; i++) ins.run('vm-1', OLD + i * 10, OLD + i * 10 + 5);
  const cov = x.db.prepare("INSERT INTO cover (kind, ref, h, samples) VALUES ('vm', 'vm-1', ?, 1)");
  for (let i = 0; i < 1500; i++) cov.run(OLD + i * 3_600_000);
  x.db.exec('COMMIT');
  const v = await yieldsWhile(vs.pruneVmSeries('vc-a', 30));
  assert.equal(v.r, 2500);
  assert.ok(v.yields >= 3, `vmseries 양보 ${v.yields}회`);
  assert.equal(Number(x.db.prepare('SELECT COUNT(*) n FROM cover').get().n), 0);
});

test('DB2603-02: RMA 이력 정리는 저장 경로를 막지 않고 백그라운드 청크로 돈다', async () => {
  const h = await import('../src/rma/historyDb.js');
  assert.ok(await h.historyAvailable());
  const file = path.join(DIR, 'rma-history.db');
  bulk(file, "INSERT INTO rma_history (req_id, agent, done_at) VALUES (?, 'a', ?)", Array.from({ length: 2000 }, (_, i) => [`old-${i}`, OLD + i]));
  for (let i = 0; i < 19; i++) assert.equal(await h.saveHistoryRow({ reqId: `n-${i}`, agent: 'a', doneAt: Date.parse('2030-01-01T00:00:00Z') }), true);
  const t = performance.now();
  assert.equal(await h.saveHistoryRow({ reqId: 'n-19', agent: 'a', doneAt: Date.parse('2030-01-01T00:00:00Z') }), true);   // 20번째 — 정리 발동
  const saveMs = performance.now() - t;
  let spins = 0;
  while (count(file, "SELECT COUNT(*) n FROM rma_history WHERE req_id LIKE 'old-%'") > 0 && spins < 200) { await new Promise((r) => setImmediate(r)); spins++; }
  assert.equal(count(file, "SELECT COUNT(*) n FROM rma_history WHERE req_id LIKE 'old-%'"), 0);
  assert.ok(spins >= 2, `정리가 저장 호출 안에서 한 번에 끝나면 안 된다(대기 ${spins}회 · 저장 ${saveMs.toFixed(1)}ms)`);

  const tr = await import('../src/rma/testResults.js');
  await tr.ingestResult('seed', { id: 'x', status: 'ok' }, { alert: false, now: Date.parse('2030-01-01T00:00:00Z') });
  const tfile = path.join(DIR, 'rma-tests.db');
  bulk(tfile, "INSERT INTO test_results (agent, test_id, ts, status) VALUES ('a', 't', ?, 'ok')", Array.from({ length: 2000 }, (_, i) => [OLD + i]));
  for (let i = 0; i < 49; i++) await tr.ingestResult('b', { id: 'y', status: i % 2 ? 'ok' : 'bad' }, { alert: false, now: Date.parse('2030-01-01T00:00:00Z') + i });
  spins = 0;
  while (count(tfile, `SELECT COUNT(*) n FROM test_results WHERE ts < ${OLD + 10_000}`) > 0 && spins < 200) { await new Promise((r) => setImmediate(r)); spins++; }
  assert.equal(count(tfile, `SELECT COUNT(*) n FROM test_results WHERE ts < ${OLD + 10_000}`), 0);
  assert.ok(spins >= 2, `점검 이력 정리도 백그라운드 청크여야 한다(대기 ${spins}회)`);
});

// ── RECENT2603-06 ────────────────────────────────────────────────────────────
test('RECENT2603-06: SAN 사용량 pruneNow 는 진행 중인 옛 보존일 정리를 공유하지 않고 새 경계로 한 번 더 돈다', async () => {
  const pd = await import('../src/sanswitch/perfDb.js');
  const ancient = Array.from({ length: 2000 }, (_, i) => ({ d: 'sw1', ts: OLD + i, p: 1, b: 10 }));
  const mid = Array.from({ length: 600 }, (_, i) => ({ d: 'sw1', ts: Date.parse('2023-06-01T00:00:00Z') + i, p: 2, b: 10 }));
  await pd.importSamples([...ancient, ...mid], [], 3650);
  const p1 = pd.pruneNow(3650);            // 10년 — 2001년 행만 지운다(여러 청크라 진행 중이 된다)
  const p2 = pd.pruneNow(90);              // 90일 — 2023년 행까지
  const [a, b] = await Promise.all([p1, p2]);
  assert.equal(a.deleted, 2000);
  assert.equal(b.deleted, 600, '새 보존일이 그 호출에 적용되지 않았다(진행 중인 옛 정리를 공유했다)');
  const again = await pd.pruneNow(90);
  assert.equal(again.deleted, 0);
});

// ── DB2603-03 · RECENT2603-03 ────────────────────────────────────────────────
test('DB2603-03: 음수 보존일은 이력을 지우지 않는다', async () => {
  const vt = await import('../src/vmtrack/db.js');
  const x = await vt.getDb();
  assert.ok(x);
  x.db.prepare("INSERT INTO snaps (slot, ts, vcenter_id, total, on_count, added, removed, baseline) VALUES ('s-neg', ?, '', 1, 1, 0, 0, 0)").run(Date.parse('2030-01-01T00:00:00Z'));
  const before = Number(x.db.prepare('SELECT COUNT(*) n FROM snaps').get().n);
  for (const bad of [-1, -365, 'abc']) {
    const r = await vt.pruneVmtrack(bad);
    assert.equal(r.ok, false, `보존일 ${bad}`);
    assert.equal(r.reason, 'invalid-retention');
  }
  assert.equal(Number(x.db.prepare('SELECT COUNT(*) n FROM snaps').get().n), before, '미래 경계로 전체 이력이 지워졌다');
});

test('RECENT2603-03: 삭제된 VM 의 전원 전이 행은 경계를 넘으면 지운다 — 로스터에 있는 VM 과 로스터 없는 vCenter 는 남긴다', async () => {
  const vt = await import('../src/vmtrack/db.js');
  const x = await vt.getDb();
  x.db.prepare("INSERT INTO roster (vcenter_id, vm_id, first_seen) VALUES ('vc9', 'vm-live', ?)").run(OLD);
  const ins = x.db.prepare('INSERT INTO changes (snap_id, ts, vcenter_id, kind, vm_id) VALUES (1, ?, ?, ?, ?)');
  ins.run(OLD, 'vc9', 'powered_off', 'vm-live');
  ins.run(OLD + DAY, 'vc9', 'powered_on', 'vm-live');
  ins.run(OLD, 'vc9', 'powered_off', 'vm-gone');   // 로스터에 없다 = 삭제된 VM
  ins.run(OLD + DAY, 'vc9', 'powered_on', 'vm-gone');
  ins.run(OLD + 2 * DAY, 'vc9', 'removed', 'vm-gone');
  ins.run(OLD, 'vc-noroster', 'powered_off', 'vm-x');   // 로스터 자체가 없는 vCenter — 판정하지 않고 남긴다
  const r = await vt.pruneVmtrack(1095);
  assert.equal(r.ok, true);
  const rows = (vc) => x.db.prepare('SELECT vm_id, kind FROM changes WHERE vcenter_id=? ORDER BY vm_id, kind').all(vc).map((q) => `${q.vm_id}:${q.kind}`);
  assert.deepEqual(rows('vc9'), ['vm-live:powered_off', 'vm-live:powered_on'], '삭제된 VM 의 전이 행이 남았다');
  assert.deepEqual(rows('vc-noroster'), ['vm-x:powered_off']);
});

// ── TIM2603-01 ───────────────────────────────────────────────────────────────
test('TIM2603-01: 로그 보관 설정 파일의 잘못된 주기는 로드에서 1~1440분으로 잘린다', async () => {
  const ls = await import('../src/logs/settings.js');
  const file = path.join(DIR, 'vcenter-logs.json');
  for (const [v, want] of [[0, 10], ['', 10], ['abc', 10], [-5, 10], [40000, 1440], [2 ** 40, 1440], [30, 30]]) {
    fs.writeFileSync(file, JSON.stringify({ pollIntervalMin: v }));
    ls._resetLogSettingsForTest();
    const s = ls.loadLogSettings();
    assert.equal(s.pollIntervalMin, want, `pollIntervalMin ${JSON.stringify(v)}`);
    const ms = s.pollIntervalMin * 60_000;
    assert.ok(ms >= 60_000 && ms <= 86_400_000, `setInterval 간격 ${ms}`);
  }
  fs.writeFileSync(file, JSON.stringify({ retentionDays: -3, maxSizeMB: 'x', maxPerPoll: 5, minSeverity: 'debug', storagePath: 7 }));
  ls._resetLogSettingsForTest();
  const s = ls.loadLogSettings();
  assert.equal(s.retentionDays, 365, '음수 보존일을 무제한(0)으로 넓히지 않는다');
  assert.equal(s.maxSizeMB, 1024);
  assert.equal(s.maxPerPoll, 100);
  assert.equal(s.minSeverity, 'info');
  assert.equal(s.storagePath, '');
  fs.writeFileSync(file, JSON.stringify({ retentionDays: 0, maxSizeMB: 0 }));   // 0 = 무제한(명시)
  ls._resetLogSettingsForTest();
  assert.equal(ls.loadLogSettings().retentionDays, 0);
  assert.equal(ls.loadLogSettings().maxSizeMB, 0);
  fs.writeFileSync(file, '[1,2]');   // 형식 불일치 = 손상(원본 보존 후 기본값)
  ls._resetLogSettingsForTest();
  assert.equal(ls.loadLogSettings().pollIntervalMin, 10);
  ls._resetLogSettingsForTest();
});

// ── TIM2603-02 ───────────────────────────────────────────────────────────────
test('TIM2603-02: 일일 보고 전 채널 실패 시 매 분이 아니라 15→30→60분 간격으로 재시도한다', async () => {
  const dr = await import('../src/reports/dailyReport.js');
  dr._resetDailyReportForTest();
  dr.saveDailyReportSettings({ enabled: true, hour: 0, minute: 0 });
  const T = Date.parse('2026-09-24T01:00:00Z');    // KST 10:00 — 같은 날 12시간 동안 틱을 돌린다
  let calls = 0;
  const failRun = async () => { calls++; return { ok: false, reason: '모든 알림 채널 전송에 실패했습니다' }; };
  const warn = console.warn; console.warn = () => {};
  try {
    for (let m = 0; m < 720; m++) await dr.dailyReportTick(T + m * 60_000, failRun);
  } finally { console.warn = warn; }
  assert.ok(calls >= 10 && calls <= 15, `12시간 동안 발송 시도 ${calls}회(예전에는 720회)`);
  const st = dr.dailyReportStatus();
  assert.equal(st.failStreak, calls);
  assert.ok(st.nextRetryAt > st.lastFailAt);
  assert.equal(dr.dailyReportBackoffMs(1), 15 * 60_000);
  assert.equal(dr.dailyReportBackoffMs(2), 30 * 60_000);
  assert.equal(dr.dailyReportBackoffMs(9), 60 * 60_000);
  // 성공하면 초기화 — 다음 실패는 다시 15분부터
  const okRun = async () => ({ ok: true });
  await dr.dailyReportTick(st.nextRetryAt, okRun);
  assert.equal(dr.dailyReportStatus().failStreak, 0);
  dr._resetDailyReportForTest();
});

// ── LEFT2603-03 ──────────────────────────────────────────────────────────────
test('LEFT2603-03: VM 통계 평균의 분모에 못 읽은 표본을 넣지 않는다', async () => {
  const vs = await import('../src/reports/vmStats.js');
  vs._resetVmStats();
  const vm = (cpu, mem) => ({ vms: [{ id: 'a', powerState: 'POWERED_ON', cpuUsagePct: cpu, memUsagePct: mem }] });
  vs.updateVmStats(vm(80, 50), 1);
  vs.updateVmStats(vm(null, 50), 2);
  vs.updateVmStats(vm(80, null), 3);
  const r = vs.vmStatsFor('a');
  assert.equal(r.samples, 3);
  assert.equal(r.cpuAvg, 80);
  assert.equal(r.memAvg, 50);
  vs.updateVmStats({ vms: [{ id: 'b', powerState: 'POWERED_ON', cpuUsagePct: 30, memUsagePct: null }] }, 4);
  const b = vs.vmStatsFor('b');
  assert.equal(b.memAvg, null, '한 번도 못 읽은 지표는 0 이 아니라 null');
  assert.equal(b.memMax, null);
  assert.equal(b.cpuMax, 30);
  vs._resetVmStats();
});

// ── 추가 ①: 진행 공유 헬퍼 + 시계열 prune 한 방 DELETE 스윕 ─────────────────
test('추가①: createPruneFlight — 같은 키는 공유, 다른 키는 끝난 뒤 한 번 더, 실패는 다음 실행을 막지 않는다', async () => {
  const { createPruneFlight } = await import('../src/util/chunkedPrune.js');
  const f = createPruneFlight();
  const order = [];
  let release; const gate = new Promise((r) => { release = r; });
  const a = f.run(90, async () => { order.push('a-start'); await gate; order.push('a-end'); return 'a'; });
  const a2 = f.run(90, async () => { order.push('dup'); return 'dup'; });
  const b = f.run(30, async () => { order.push('b'); return 'b'; });
  assert.equal(a, a2, '같은 키는 같은 약속');
  assert.equal(f.active, true);
  release();
  assert.deepEqual(await Promise.all([a, b]), ['a', 'b']);
  assert.deepEqual(order, ['a-start', 'a-end', 'b'], '다른 키는 앞 정리가 끝난 뒤에 돈다(겹치지 않는다)');
  assert.equal(f.active, false);
  const bad = f.run(1, async () => { throw new Error('x'); });
  await assert.rejects(bad);
  assert.equal(await f.run(2, async () => 'ok'), 'ok', '앞 실패가 다음 정리를 막지 않는다');
  const g = createPruneFlight({ covers: (run, next) => run >= next });
  let rel2; const gate2 = new Promise((r) => { rel2 = r; });
  const x = g.run(200, () => gate2.then(() => 'x'));
  assert.equal(g.run(100, async () => 'y'), x, '더 늦은 경계로 도는 정리는 이른 경계 요청을 덮는다');
  rel2(); await x;
});

// 한 번에 지우는 보존 DELETE 가 허용되는 곳 — 사유와 함께. 새 항목을 여기 넣기 전에 청크(chunkedDelete)를 먼저 볼 것.
const PRUNE_SINGLE_OK = {
  'vmseries/db.js:cover_batch': '엣지 청크 재전송 표식 — 10분만 보관(행 수 = 최근 청크 수)',
  'vmtrack/db.js:ds_changes': 'diff 저장(변경분만) · 한 트랜잭션 정리 — DB2603-05 실측 정상 상태 39ms',
  'vmtrack/db.js:snaps': 'vCenter × 슬롯(2회/일) — 연 2만 행 수준',
  'vmtrack/db.js:ds_series': 'diff 저장 + 경계 이전 마지막 행 보존(NOT IN) — 청크화하면 보존 규칙을 청크마다 다시 계산해야 한다',
  'vmtrack/db.js:changes': 'diff 저장 + 로스터 VM 마지막 전이 보존(v2.603) — 같은 이유',
  'sanswitch/perfDb.js:port_meta': '장비×포트 메타 — 상한 4,096행',
  'sanswitch/healthHistory.js:runs': '장비당 점검 이력 상한(SANHEALTH_MAX_RUNS 기본 24)',
  'partfault/db.js:part_event': '전이만 적재(상태가 바뀔 때만) — 유계',
  'storage/db.js:api_history': '후속 후보 — 장비 수 × 수집 주기 규모(미측정)',
  'storage/db.js:capacity_history': '후속 후보 — 장비 수 × 1시간 주기(기본 90일) 규모(미측정)',
  'storage/db.js:capacity_daily': '장비 × 일 1행(5년) — 20대 3.6만 행',
};
test('추가①: 시계열 보존 정리에 청크 없는 한 방 DELETE 를 새로 만들지 않는다(허용 목록은 사유와 함께)', async () => {
  const { stripComments } = await import('./_stripComments.js');
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src');
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.js')) files.push(p); } };
  walk(root);
  const found = [];
  for (const f of files) {
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    for (const m of src.matchAll(/DELETE FROM (\w+) WHERE \(?\s*(\w+)\s*<\s*\?/g)) {
      const tail = src.slice(m.index, m.index + 400);
      const end = tail.search(/['"`]/);
      const stmt = end >= 0 ? tail.slice(0, end) : tail;
      if (/rowid IN \(SELECT rowid/i.test(stmt)) continue;   // 청크 형태
      found.push(`${path.relative(root, f).split(path.sep).join('/')}:${m[1]}`);
    }
  }
  const unknown = [...new Set(found)].filter((k) => !PRUNE_SINGLE_OK[k]);
  assert.deepEqual(unknown, [], `청크 없는 보존 DELETE(허용 목록 밖): ${unknown.join(', ')}`);
  const stale = Object.keys(PRUNE_SINGLE_OK).filter((k) => !found.includes(k));
  assert.deepEqual(stale, [], `허용 목록에 있지만 소스에 없는 항목(청크로 바꿨으면 목록에서 빼라): ${stale.join(', ')}`);
  // 이번에 청크로 바꾼 모듈은 다시 한 방 DELETE 로 돌아가면 안 된다
  for (const k of ['linkcheck/db.js:link_sample', 'ping/db.js:samples', 'curuser/db.js:vc_series', 'horizon/sessionDb.js:hz_series',
    'vmseries/db.js:spikes', 'vmseries/db.js:cover', 'rma/historyDb.js:rma_history', 'rma/testResults.js:test_results', 'sanswitch/perfDb.js:port_perf',
    // v2.605(감사 DB2605-03·04): capacity 원본·롤업과 게스트 디스크 이력도 청크로 바꿨다 — 허용 목록에서 뺐다.
    'capacity/db.js:samples', 'capacity/db.js:samples_hourly', 'guestdisk/db.js:vm_series', 'guestdisk/db.js:part_series']) {
    assert.ok(!found.includes(k), `${k} 가 한 방 DELETE 로 되돌아갔다`);
    assert.ok(!PRUNE_SINGLE_OK[k], k);
  }
});

// ── 추가 ②: logs/poller.js schedule 2차 방어 ──────────────────────────────────
test('추가②: 로그 폴러는 캐시에 잘못된 주기가 들어가도 setInterval 간격을 1분~1일로 묶는다', async () => {
  const ls = await import('../src/logs/settings.js');
  const lp = await import('../src/logs/poller.js');
  const orig = globalThis.setInterval;
  const seen = [];
  globalThis.setInterval = (fn, ms, ...a) => { if (String(fn).includes('pollLogsOnce')) seen.push(ms); const t = orig(fn, 1e9, ...a); return t; };
  try {
    for (const bad of [0, Number.NaN, -5, 40000, 2 ** 40, '']) {
      ls._resetLogSettingsForTest();
      const cache = ls.loadLogSettings();
      cache.enabled = true;
      cache.pollIntervalMin = bad;           // 로드 검증을 거치지 않은 값(다른 경로로 바뀐 캐시)
      lp.rescheduleLogPoller();
    }
  } finally {
    globalThis.setInterval = orig;
    ls._resetLogSettingsForTest();
    const c = ls.loadLogSettings(); c.enabled = false; lp.rescheduleLogPoller();   // 타이머 정리
    ls._resetLogSettingsForTest();
  }
  assert.equal(seen.length, 6);
  for (const ms of seen) assert.ok(ms >= 60_000 && ms <= 86_400_000, `간격 ${ms}`);
});

// ── 추가 ⑤: 라이트사이징 — 피크를 못 읽은 차원은 권고 보류 ─────────────────
test('추가⑤: 메모리 피크를 못 읽은 VM 에 1GB 로 줄이라고 권하지 않는다(권고 보류 · held 로 밝힘)', async () => {
  const { suggestSize, computeRightsizing } = await import('../src/reports/rightsizing.js');
  const s = suggestSize(8, 32, 20, null);
  assert.equal(s.suggestedVcpu, 3);
  assert.equal(s.suggestedRamGB, 32, '메모리는 현재 사양 유지');
  assert.deepEqual(s.held, ['mem']);
  assert.equal(suggestSize(8, 32, 20, 30).held, undefined);
  const vms = [{ id: 'a', name: 'a', powerState: 'POWERED_ON', cpuCount: 8, memMB: 32 * 1024 }];
  const stats = { a: { samples: 20, cpuAvg: 5.5, memAvg: null, cpuMax: 20, memMax: null, sinceTs: 1 } };
  const r = computeRightsizing(vms, (id) => stats[id]);
  const o = r.oversized.find((x) => x.id === 'a');
  assert.ok(o, '과대 후보');
  assert.equal(o.suggestedRamGB, 32);
  assert.equal(o.reclaimRamGB, 0);
  assert.deepEqual(o.held, ['mem']);
  assert.equal(o.memMax, null, '못 읽은 피크를 0% 로 표시하지 않는다');
  assert.equal(o.memAvg, null);
});

// ── 추가 ⑥: ping 대상 삭제 이력 청크화 ─────────────────────────────────────
test('추가⑥: ping 대상 삭제는 그 대상 이력을 청크로 끝까지 지우고 다른 대상은 건드리지 않는다', async () => {
  const { getPingDb } = await import('../src/ping/db.js');
  const db = await getPingDb();
  db.insertMany(Array.from({ length: 3000 }, (_, i) => ({ target: 'drop-me', ts: Date.parse('2030-01-01T00:00:00Z') + i, rtt: 1, ok: true })));
  db.insertMany([{ target: 'keep-me', ts: Date.parse('2030-01-01T00:00:00Z'), rtt: 1, ok: true }]);
  const p = db.dropTarget('drop-me');
  assert.ok(p && typeof p.then === 'function', 'dropTarget 은 약속을 돌려줘야 한다');
  const { r, yields } = await yieldsWhile(p);
  assert.equal(r.deleted, 3000);
  assert.equal(r.done, true);
  assert.ok(yields >= 3, `양보 ${yields}회`);
  assert.equal(db.meta('drop-me').count, 0);
  assert.equal(db.meta('keep-me').count, 1);
  const route = fs.readFileSync(new URL('../src/routes/ping.js', import.meta.url), 'utf8');
  assert.match(route, /historyPurge = 'background'/, '라우트는 이력 삭제를 응답 경로에서 기다리지 않는다');
  assert.doesNotMatch(route, /await getPingDb\(\)\)\.dropTarget/);
});

// ── 추가: 열 추가 마이그레이션이 잠금을 '이미 있음' 으로 삼키지 않는다(vmtrack·linkcheck) ──
function lockedPair(name, ddl) {
  const f = path.join(DIR, `${name}.db`);
  const a = new DatabaseSync(f); a.exec(`PRAGMA journal_mode=WAL; ${ddl}`);
  const holder = new DatabaseSync(f); holder.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');   // 쓰기 잠금을 쥔다
  a.exec('PRAGMA busy_timeout=50');
  return { a, holder };
}
test('추가: vmtrack 열 추가 — 없는 열만 추가하고, 잠금은 던지고, 이미 있는 열은 건드리지 않는다', async () => {
  const { addMissingColumns } = await import('../src/vmtrack/db.js');
  assert.equal(typeof addMissingColumns, 'function');
  const { a, holder } = lockedPair('vt-mig', 'CREATE TABLE snaps (id INTEGER PRIMARY KEY, powered_on INTEGER NOT NULL DEFAULT 0);');
  assert.throws(() => addMissingColumns(a, 'snaps', [['powered_on', 'INTEGER NOT NULL DEFAULT 0'], ['skipped', 'INTEGER NOT NULL DEFAULT 0']]),
    /locked|busy/i, '잠금을 열 이미 있음으로 삼키면 열 없이 열린다');
  holder.exec('ROLLBACK'); holder.close();
  assert.deepEqual(addMissingColumns(a, 'snaps', [['powered_on', 'INTEGER NOT NULL DEFAULT 0'], ['skipped', 'INTEGER NOT NULL DEFAULT 0']]), ['skipped']);
  assert.deepEqual(addMissingColumns(a, 'snaps', [['skipped', 'INTEGER NOT NULL DEFAULT 0']]), [], '두 번째는 아무것도 안 한다');
  a.close();
});
test('추가: linkcheck ms_n — 잠금이면 던지고, 추가와 구 행 합 비우기는 함께 된다', async () => {
  const { migrateLinkDailyMsN } = await import('../src/linkcheck/db.js');
  assert.equal(typeof migrateLinkDailyMsN, 'function');
  const { a, holder } = lockedPair('lc-mig', "CREATE TABLE link_daily (link_id TEXT, day TEXT, ms_sum INTEGER NOT NULL DEFAULT 0); INSERT INTO link_daily VALUES ('l','2026-01-01',500);");
  assert.throws(() => migrateLinkDailyMsN(a), /locked|busy/i);
  assert.equal(a.prepare('PRAGMA table_info(link_daily)').all().some((r) => r.name === 'ms_n'), false);
  holder.exec('ROLLBACK'); holder.close();
  assert.equal(migrateLinkDailyMsN(a), true);
  assert.equal(Number(a.prepare('SELECT ms_sum FROM link_daily').get().ms_sum), 0, '새로 만든 경우 구 행 합을 비운다');
  a.exec("UPDATE link_daily SET ms_sum = 7");
  assert.equal(migrateLinkDailyMsN(a), false, '이미 있으면 건드리지 않는다');
  assert.equal(Number(a.prepare('SELECT ms_sum FROM link_daily').get().ms_sum), 7);
  a.close();
});

// ── 추가 ④: 일일 보고 실패 로그 ↔ 로그 분석 카탈로그 ─────────────────────────
test('추가④: 실제로 찍히는 일일 보고 실패 줄을 카탈로그 규칙이 잡는다(옛 판본 줄도)', async () => {
  const dr = await import('../src/reports/dailyReport.js');
  const cat = await import('../src/loganalysis/catalog.js');
  const rules = Object.values(cat).find((v) => Array.isArray(v) && v.some((r) => r?.id === 'daily-report-fail'));
  const rule = rules.find((r) => r.id === 'daily-report-fail');
  const re = rule.re instanceof RegExp ? rule.re : new RegExp(rule.re);
  dr._resetDailyReportForTest();
  dr.saveDailyReportSettings({ enabled: true, hour: 0, minute: 0 });
  const lines = [];
  const warn = console.warn; console.warn = (m) => lines.push(String(m));
  try { await dr.dailyReportTick(Date.parse('2026-09-24T01:00:00Z'), async () => ({ ok: false, reason: '수신자가 없습니다' })); }
  finally { console.warn = warn; dr._resetDailyReportForTest(); }
  const line = lines.find((l) => l.includes('[daily-report]'));
  assert.ok(line, '실패 줄이 찍혀야 한다');
  assert.equal(line.match(re)?.[1], '수신자가 없습니다', `카탈로그가 실제 줄을 못 잡는다: ${line}`);
  assert.equal('[daily-report] 발송 실패 — 옛 사유 (다음 틱에 재시도)'.match(re)?.[1], '옛 사유', '2.603 이전 판본 줄도 잡는다');
});
