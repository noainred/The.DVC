/**
 * v2.604 감사 그룹 e — 타이머·설정·ping DB 회귀.
 *  RECENT2604-02 ping 대상 삭제의 시각 경계 · RECENT2604-03 일일 보고 예외 백오프 · LEFT2604-01 폴더 사용량 보존 빈 칸 ·
 *  LEFT2604-02 중계 점검 빈 칸 · TIM2604-01 업그레이드 재시작의 정상 종료 경로 · TIM2604-02 vmclone 실행 표시 ·
 *  TIM2604-03 백업 설정 로드 클램프 · DB2604-01 ping 개요 시간당 롤업.
 * 기준 시각은 Date.now() 를 쓰지 않는다(정시 −30분으로 고정 — 루트 CLAUDE.md v2.517 규약).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripComments } from './_stripComments.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2604e-'));
process.env.CONFIG_DIR = TMP;
process.env.PING_DB_PATH = path.join(TMP, 'ping.db');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const HOUR = 3_600_000;
const T0 = Date.parse('2031-03-04T05:30:00Z');   // 정시 +30분 — 시간 칸 경계에서 떨어뜨려 고정


// ── RECENT2604-02 ─────────────────────────────────────────────────────────
test('RECENT2604-02: 대상 삭제는 삭제 시각까지만 지운다 — 같은 id 로 다시 만든 대상의 새 표본·롤업은 남는다', async () => {
  const { getPingDb } = await import('../src/ping/db.js');
  const db = await getPingDb();
  await db._rollupSeed?.();
  const id = 'reuse-me';
  // 옛 대상: T0 이전 3시간 동안 분당 1건
  db.insertMany(Array.from({ length: 180 }, (_, i) => ({ target: id, ts: T0 - (i + 1) * 60_000, rtt: 10, ok: true })));
  const until = T0;
  // 삭제가 도는 사이 같은 id 로 다시 만든 대상의 표본(삭제 시각 뒤) — 같은 시간 칸 안에 넣는다
  db.insertMany([{ target: id, ts: T0 + 5_000, rtt: 42, ok: true }, { target: id, ts: T0 + 65_000, rtt: null, ok: false }]);
  const r = await db.dropTarget(id, until);
  assert.equal(r.deleted, 180, '옛 표본만 지운다');
  assert.equal(db.meta(id).count, 2, '새 대상의 표본 2건은 남는다');
  const h = db.historyHourly(id, T0 - 10 * HOUR, HOUR, 100);
  assert.equal(h.length, 1, '롤업은 경계 칸 하나만 남는다(이전 칸은 지웠다)');
  assert.equal(h[0].n, 2, '경계 칸은 남은 원시로 다시 만든다(옛 표본을 세지 않는다)');
  assert.equal(h[0].avg, 42);
  assert.equal(h[0].loss, 0.5);
  // 경계 없이 부르면 예전처럼 전부
  const r2 = await db.dropTarget(id);
  assert.equal(r2.deleted, 2);
  assert.equal(db.historyHourly(id, T0 - 10 * HOUR, HOUR, 100).length, 0);
  // 라우트는 삭제 시각을 넘긴다
  const route = stripComments(fs.readFileSync(path.join(SRC, 'routes/ping.js'), 'utf8'));
  assert.match(route, /db\.dropTarget\(r\.id,\s*Date\.now\(\)\)/);
});

// ── DB2604-01 ─────────────────────────────────────────────────────────────
test('DB2604-01: 장기 범위 버킷은 1시간 배수로 올리고 롤업을 읽는다 — 원시 GROUP BY 와 같은 값', async () => {
  const { getPingDb } = await import('../src/ping/db.js');
  const { planBuckets } = await import('../src/ping/service.js');
  const db = await getPingDb();
  await db._rollupSeed?.();
  assert.deepEqual(planBuckets(86_400_000, 300), { bucketMs: 288_000, hourly: false }, '1일은 원시 그대로');
  assert.deepEqual(planBuckets(30 * 86_400_000, 300), { bucketMs: 3 * HOUR, hourly: true }, '30일 2.4h → 3h');
  assert.deepEqual(planBuckets(365 * 86_400_000, 300), { bucketMs: 30 * HOUR, hourly: true }, '365일 29.2h → 30h');
  const id = 'roll';
  const rows = [];
  for (let j = 0; j < 20 * 24 * 12; j++) rows.push({ target: id, ts: T0 - j * 5 * 60_000, rtt: j % 7 === 0 ? null : 3 + (j % 11), ok: j % 13 !== 0 });
  db.insertMany(rows);
  assert.equal(db.rollupState().ready, true);
  for (const bucketMs of [3 * HOUR, 30 * HOUR]) {
    const since = T0 - 20 * 86_400_000;
    const a = db.history(id, since, bucketMs, 300);
    const b = db.historyHourly(id, since, bucketMs, 300);
    assert.ok(a.length > 5);
    assert.deepEqual(b, a, `버킷 ${bucketMs / HOUR}h 원시 == 롤업`);
  }
  assert.equal(db.historyHourly(id, T0 - 86_400_000, 288_000, 300), null, '1시간 배수가 아니면 null(원시로 떨어진다)');
  await db.prune(T0 - 10 * 86_400_000);
  const left = db.historyHourly(id, T0 - 30 * 86_400_000, HOUR, 10_000);
  assert.ok(left.every((x) => x.ts + HOUR <= T0 + HOUR && x.ts >= T0 - 10 * 86_400_000 - HOUR), 'prune 이 롤업도 지운다');
});

test('DB2604-01: 구버전 DB(롤업 없음)는 열 때 rowid 경계로 시드하고, 시드 중 적재분을 두 번 세지 않는다', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const file = path.join(TMP, 'old-ping.db');
  { const d = new DatabaseSync(file);
    d.exec('CREATE TABLE samples (target TEXT NOT NULL, ts INTEGER NOT NULL, rtt REAL, ok INTEGER NOT NULL)');
    const ins = d.prepare('INSERT INTO samples VALUES (?,?,?,?)');
    for (let j = 0; j < 500; j++) ins.run('old', T0 - j * 60_000, j % 5 ? 7 : null, j % 9 ? 1 : 0);
    d.close(); }
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
    process.env.PING_DB_PATH = ${JSON.stringify(file)};
    const { getPingDb } = await import(${JSON.stringify(pathToFileURL(path.join(SRC, 'ping/db.js')).href)});
    const db = await getPingDb();
    const before = db.rollupState().ready;
    db.insertMany([{ target: 'old', ts: ${T0} + 1000, rtt: 99, ok: true }]);   // 시드가 끝나기 전 적재
    await db._rollupSeed();
    const a = db.history('old', ${T0} - 86400000, ${3 * HOUR}, 300);
    const b = db.historyHourly('old', ${T0} - 86400000, ${3 * HOUR}, 300);
    console.log(JSON.stringify({ before, after: db.rollupState().ready, same: JSON.stringify(a) === JSON.stringify(b), n: b.reduce((s, x) => s + x.n, 0) }));
  `], { encoding: 'utf8', env: { ...process.env } });
  assert.equal(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(o.before, false, '시드 전에는 롤업을 쓰지 않는다');
  assert.equal(o.after, true);
  assert.equal(o.n, 501, '시드 중 적재분이 이중 계수되지 않는다');
  assert.equal(o.same, true, '시드 후 롤업 == 원시');
});

test('DB2604-01: 개요는 대상 사이에 양보하고 같은 요청을 공유하며 source 를 밝힌다', async () => {
  const svc = stripComments(fs.readFileSync(path.join(SRC, 'ping/service.js'), 'utf8'));
  assert.match(svc, /snapMemo\('ping-overview'/);
  assert.match(svc, /setImmediate/);
  const { overviewGrouped } = await import('../src/ping/service.js');
  const o = await overviewGrouped('edge', 'datacenterId', { rangeMs: 365 * 86_400_000, points: 300 });
  assert.equal(o.bucketMs, 30 * HOUR);
  assert.ok(['hourly', 'raw', 'mixed'].includes(o.source));
});

// ── RECENT2604-03 ─────────────────────────────────────────────────────────
test('RECENT2604-03: run() 이 던져도 실패로 세고 백오프가 걸린다', async () => {
  const m = await import('../src/reports/dailyReport.js');
  m._resetDailyReportForTest();
  m.saveDailyReportSettings({ enabled: true, hour: 0, minute: 0 });
  let calls = 0;
  const boom = async () => { calls++; throw new Error('boom'); };
  const noon = Date.parse('2031-03-04T03:00:00Z');   // KST 12:00 — 발송 시각(00:00) 이후
  const r1 = await m.dailyReportTick(noon, boom);
  assert.equal(r1.ran, true);
  assert.equal(r1.ok, false);
  assert.equal(m.dailyReportStatus().failStreak, 1);
  assert.match(m.dailyReportStatus().lastFailReason, /boom/);
  for (let i = 1; i <= 3; i++) {
    const r = await m.dailyReportTick(noon + i * 60_000, boom);
    assert.equal(r.skipped, 'backoff', '다음 분에 다시 시도하지 않는다');
  }
  assert.equal(calls, 1);
  m._resetDailyReportForTest();
});

// ── LEFT2604-01 ───────────────────────────────────────────────────────────
test('LEFT2604-01: 폴더 사용량 보존일 빈 칸·숫자 아님은 이전 값을 유지한다', async () => {
  const m = await import('../src/dirusage/settings.js');
  assert.equal(m.save({ retentionDays: 3650 }).retentionDays, 3650);
  assert.equal(m.save({ retentionDays: '' }).retentionDays, 3650, '빈 칸이 1일이 되면 이력이 지워진다');
  assert.equal(m.save({ retentionDays: 'abc' }).retentionDays, 3650);
  assert.equal(m.save({ retentionDays: [] }).retentionDays, 3650);
  assert.equal(m.save({ retentionDays: '120' }).retentionDays, 120);
  assert.equal(m.save({ retentionDays: 99999 }).retentionDays, 3650, '범위는 그대로 자른다');
  m.invalidate();
  assert.equal(m.load().retentionDays, 3650, '파일에도 유지된 값');
  const web = fs.readFileSync(path.join(HERE, '..', '..', 'web/src/views/DirUsageSettings.jsx'), 'utf8');
  assert.doesNotMatch(web, /Number\(retentionDays\)\s*\|\|/, '웹이 빈 칸을 365 로 바꿔 보내지 않는다');
  assert.match(web, /retentionDays: blankOr\(retentionDays\)/);
});

// ── LEFT2604-02 ───────────────────────────────────────────────────────────
test('LEFT2604-02: 중계 점검 주기·시한·실패 횟수의 빈 칸·0 은 이전 값을 유지한다', async () => {
  const m = await import('../src/relaycheck/settings.js');
  m._resetForTest();
  m.saveSettings({ intervalMs: 6 * HOUR, timeoutMs: 60_000, failStreak: 10 });
  const c = m.loadSettings();
  let r = m.saveSettings({ ...c, intervalMs: 0, timeoutMs: '', failStreak: null });
  assert.equal(r.intervalMs, 6 * HOUR);
  assert.equal(r.timeoutMs, 60_000);
  assert.equal(r.failStreak, 10);
  r = m.saveSettings({ ...c, intervalMs: 'x', timeoutMs: -5, failStreak: 3 });
  assert.equal(r.intervalMs, 6 * HOUR);
  assert.equal(r.timeoutMs, 60_000);
  assert.equal(r.failStreak, 3, '명시한 양수는 값이다');
  r = m.saveSettings({ ...c, intervalMs: 1, failStreak: 99 });
  assert.equal(r.intervalMs, 60_000, '양수는 한도로 자른다');
  assert.equal(r.failStreak, 10);
});

// ── TIM2604-01 ────────────────────────────────────────────────────────────
test('TIM2604-01: 업그레이드 재시작은 등록된 정상 종료 경로를 탄다(비-systemd 는 종료 직전에 새 프로세스)', async () => {
  const u = await import('../src/upgrade/upgrade.js');
  const saved = { i: process.env.INVOCATION_ID, n: process.env.NOTIFY_SOCKET };
  delete process.env.INVOCATION_ID; delete process.env.NOTIFY_SOCKET;
  try {
    const seen = [];
    let spawned = 0;
    let exited = 0;
    const spawnFn = () => { spawned++; return { unref() {} }; };
    const exitFn = () => { exited++; };
    u.setShutdownHandler((signal, opts) => seen.push({ signal, opts }));
    u.restartProcess({ spawnFn, exitFn });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].signal, 'upgrade-restart');
    assert.equal(spawned, 0, '새 프로세스는 종료 경로가 포트를 닫은 뒤에 띄운다');
    seen[0].opts.beforeExit();
    assert.equal(spawned, 1);
    process.env.INVOCATION_ID = 'x';
    u.restartProcess({ spawnFn, exitFn });
    assert.equal(seen.length, 2);
    assert.equal(seen[1].opts.beforeExit, undefined, 'systemd 는 종료만 — Restart=always 가 다시 띄운다');
    assert.equal(exited, 0, '직접 process.exit 하지 않는다');
    // 등록이 없으면 예전 동작(테스트·단독 import)
    u.setShutdownHandler(null);
    u.restartProcess({ spawnFn, exitFn });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(exited, 1);
  } finally {
    u.setShutdownHandler(null);
    if (saved.i == null) delete process.env.INVOCATION_ID; else process.env.INVOCATION_ID = saved.i;
    if (saved.n == null) delete process.env.NOTIFY_SOCKET; else process.env.NOTIFY_SOCKET = saved.n;
  }
  const idx = stripComments(fs.readFileSync(path.join(SRC, 'index.js'), 'utf8'));
  assert.match(idx, /setShutdownHandler\(gracefulExit\)/, 'index.js 가 gracefulExit 를 등록한다');
  const done = idx.slice(idx.indexOf('const done = (code)'), idx.indexOf('const timer = setTimeout'));
  assert.ok(done.indexOf('exitHooks') >= 0 && done.indexOf('exitHooks') < done.indexOf('process.exit(code)'), '종료 훅은 process.exit 앞에서 부른다');
  const upg = stripComments(fs.readFileSync(path.join(SRC, 'upgrade/upgrade.js'), 'utf8'));
  const fn = upg.slice(upg.indexOf('export function restartProcess'), upg.indexOf('export function restartProcess') + 1200);
  assert.ok(fn.indexOf('_shutdown(') >= 0 && fn.indexOf('_shutdown(') < fn.indexOf('exitFn(0)'), '등록된 종료 경로가 먼저다');
});

// ── TIM2604-02 ────────────────────────────────────────────────────────────
test('TIM2604-02: vmclone 은 스냅샷 삭제(병합)가 끝날 때까지 실행 중으로 보이고 같은 잡을 다시 받지 않는다', () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2604e-vc-'));
  fs.writeFileSync(path.join(cfg, 'vcenters.json'), JSON.stringify({ vcenters: [{ id: 'vc1', host: 'https://127.0.0.1:1', username: 'u', password: 'p' }] }));
  const u = (p) => pathToFileURL(path.join(SRC, p)).href;
  const script = `
    import { mock } from 'node:test';
    const hold = globalThis.__hold = { status: null, dup: null };
    mock.module(${JSON.stringify(u('vmclone/vsphere.js'))}, { namedExports: {
      VimSoapClient: class { async login() {} async logout() {} },
      createSnapshot: async () => 'snapshot-1',
      removeSnapshot: async () => {
        const r = await import(${JSON.stringify(u('vmclone/runner.js'))});
        hold.status = r.runnerStatus();
        hold.dup = r.enqueueRun(hold.jobId, 'manual');
      },
      parentFolderOf: async () => 'group-v1', cloneFromSnapshot: async () => 'vm-99', destroyClone: async () => {},
      vmFilePaths: async () => ({ vmx: null, files: [] }), parseDsPath: () => null, backupFileFilter: () => true,
      datacenterPathOf: async () => null, downloadDsFile: async () => 0,
    } });
    mock.module(${JSON.stringify(u('store.js'))}, { namedExports: { store: { get: () => ({ datastores: [{ vcenterId: 'vc1', name: 'ds1', id: 'vc1:datastore-1' }] }) } } });
    const st = await import(${JSON.stringify(u('vmclone/store.js'))});
    const job = st.saveJob({ vcenterId: 'vc1', vmId: 'vc1:vm-1', vmName: 'web01', dest: { type: 'datastore', datastoreName: 'ds1' }, keep: 3 });
    hold.jobId = job.id;
    const r = await import(${JSON.stringify(u('vmclone/runner.js'))});
    r.enqueueRun(job.id, 'manual');
    for (let i = 0; i < 200 && !st.getJob(job.id).lastRun; i++) await new Promise((x) => setTimeout(x, 10));
    await new Promise((x) => setTimeout(x, 50));
    console.log(JSON.stringify({ status: hold.status, dup: hold.dup, after: r.runnerStatus(), lastOk: st.getJob(job.id).lastRun?.ok }));
    process.exit(0);   // 결함 판본은 중복 대기열로 잡이 끝없이 다시 돈다 — 기다리지 않고 판정한다
  `;
  const r = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', script],
    { encoding: 'utf8', timeout: 30_000, env: { ...process.env, CONFIG_DIR: cfg, DATA_SOURCE: 'live' } });
  assert.equal(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(o.lastOk, true, '복제 자체는 성공');
  assert.ok(o.status?.running, '스냅샷 병합 중에도 실행 중으로 보인다');
  assert.equal(o.status.running.phase, '스냅샷 삭제(병합)');
  assert.equal(o.dup.queued, false, '병합 중 같은 잡을 다시 대기열에 올리지 않는다');
  assert.equal(o.after.running, null, '다 끝나면 내린다');
});

// ── TIM2604-03 ────────────────────────────────────────────────────────────
test('TIM2604-03: 백업 설정은 로드 경로에서도 클램프한다(-5·0.00001·retention 0)', async () => {
  const m = await import('../src/backup/settings.js');
  const n = m.normalizeBackupSettings;
  assert.equal(n({ every: -5 }).every, 1);
  assert.equal(n({ every: 0.00001 }).every, 1);
  assert.equal(n({ every: 5000 }).every, 1000);
  assert.equal(n({ retention: 0 }).retention, 30, 'retention 0 이 전부 삭제가 되지 않는다');
  assert.equal(n({ retention: 9999 }).retention, 500);
  assert.equal(n({ unit: 'week' }).unit, 'day');
  assert.equal(n({ scheduleEnabled: 'false' }).scheduleEnabled, false, '문자열을 참으로 읽지 않는다');
  fs.writeFileSync(path.join(TMP, 'backup.json'), JSON.stringify({ scheduleEnabled: true, every: -5, unit: 'minute', retention: 0 }));
  m._resetBackupSettingsForTest();
  const s = m.loadBackupSettings();
  assert.equal(s.every, 1);
  assert.equal(s.retention, 30);
  assert.equal(s.unit, 'minute');
  m._resetBackupSettingsForTest();
  fs.rmSync(path.join(TMP, 'backup.json'), { force: true });
});

// ── 추가: vmclone 목 판정 · 중계 점검 화면 빈 칸 ─────────────────────────────
function runVmcloneChild({ dataSource, withVc }) {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2604e-mode-'));
  if (withVc) fs.writeFileSync(path.join(cfg, 'vcenters.json'), JSON.stringify({ vcenters: [{ id: 'vc1', host: 'https://127.0.0.1:1', username: 'u', password: 'p' }] }));
  const u = (p) => pathToFileURL(path.join(SRC, p)).href;
  const script = `
    import { mock } from 'node:test';
    const calls = { snap: 0 };
    mock.module(${JSON.stringify(u('vmclone/vsphere.js'))}, { namedExports: {
      VimSoapClient: class { async login() {} async logout() {} },
      createSnapshot: async () => { calls.snap++; return 'snapshot-1'; }, removeSnapshot: async () => {},
      parentFolderOf: async () => 'group-v1', cloneFromSnapshot: async () => 'vm-99', destroyClone: async () => {},
      vmFilePaths: async () => ({ vmx: null, files: [] }), parseDsPath: () => null, backupFileFilter: () => true,
      datacenterPathOf: async () => null, downloadDsFile: async () => 0,
    } });
    mock.module(${JSON.stringify(u('store.js'))}, { namedExports: { store: { get: () => ({ datastores: [{ vcenterId: 'vc1', name: 'ds1', id: 'vc1:datastore-1' }] }) } } });
    const st = await import(${JSON.stringify(u('vmclone/store.js'))});
    const job = st.saveJob({ vcenterId: 'vc1', vmId: 'vc1:vm-1', vmName: 'web01', dest: { type: 'datastore', datastoreName: 'ds1' }, keep: 3 });
    const r = await import(${JSON.stringify(u('vmclone/runner.js'))});
    r.enqueueRun(job.id, 'manual');
    for (let i = 0; i < 400 && !st.getJob(job.id).lastRun; i++) await new Promise((x) => setTimeout(x, 10));
    const lr = st.getJob(job.id).lastRun;
    console.log(JSON.stringify({ snap: calls.snap, ok: lr?.ok, detail: lr?.detail }));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', script],
    { encoding: 'utf8', timeout: 30_000, env: { ...process.env, CONFIG_DIR: cfg, DATA_SOURCE: dataSource } });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

test('추가: vmclone 은 목 모드면 vCenter 설정이 있어도 실제 스냅샷을 만들지 않고, live 에서 설정이 없으면 성공이라 기록하지 않는다', () => {
  const m = runVmcloneChild({ dataSource: 'mock', withVc: true });
  assert.equal(m.snap, 0, '목 모드에서 실제 vCenter 경로(스냅샷)를 타지 않는다');
  assert.equal(m.ok, true);
  assert.match(m.detail, /mock/);
  const l = runVmcloneChild({ dataSource: 'live', withVc: false });
  assert.equal(l.snap, 0);
  assert.equal(l.ok, false, 'live 에서 vCenter 설정이 없으면 시뮬레이션 성공이 아니라 실패');
  assert.match(l.detail, /vCenter 설정을 찾을 수 없습니다/);
  const lv = runVmcloneChild({ dataSource: 'live', withVc: true });
  assert.equal(lv.snap, 1, 'live + 설정 있음은 실경로');
  const src = stripComments(fs.readFileSync(path.join(SRC, 'vmclone/runner.js'), 'utf8'));
  assert.doesNotMatch(src, /config\.mode/, '존재하지 않는 필드로 판정하지 않는다');
});

test('추가: 중계 점검 화면은 빈 숫자 칸을 0 으로 바꿔 보내지 않는다', () => {
  const web = fs.readFileSync(path.join(HERE, '..', '..', 'web/src/views/tools/RelayCheckTool.jsx'), 'utf8');
  assert.doesNotMatch(web, /Number\(e\.target\.value\)/, 'Number(\'\') 는 0 이다');
  assert.match(web, /set\('intervalMs', secToMs\(e\.target\.value\)\)/);
  assert.match(web, /set\('timeoutMs', secToMs\(e\.target\.value\)\)/);
  assert.match(web, /set\('failStreak', blankOr\(e\.target\.value\)\)/);
  assert.match(web, /import \{ blankOr \} from '\.\.\/blankOr\.js'/);
});
