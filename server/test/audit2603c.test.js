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
