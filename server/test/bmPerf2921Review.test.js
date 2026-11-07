/**
 * v2.922(리눅스 성능 3a) — 반증(review-s3a) 반영 회귀. D 번호는 반증 보고 `review-s3a.md` 의 번호다.
 *  D1 port-map 쓰기 범위(실제 라우터) · D3 CVP 드롭 정제 → 적재(실제 수신 함수) · D4/D5 롤업 보정 · D6 재시도 · D7 hostMatch 경계 ·
 *  D8·D11·D12·D13·D14·D15 · D2 주기 산수(실행 뒤 재무장).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bm2921rv-'));
process.env.CONFIG_DIR = DIR;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const SRC_DIR = path.join(import.meta.dirname, '../src');
const HOUR = 3_600_000; const DAY = 86_400_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;

/* ── D1 ─────────────────────────────────────────────────────────────── */
test('D1 실제 라우터 — port-map PUT/DELETE: 조회 무제한+쓰기 제한 403 · 범위 계정 다른 법인 CVP 403 · 범위 밖 404 · 관리자 200 · 감사 로그', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm2921rv-d1-'));
  fs.writeFileSync(path.join(dir, 'idrac.json'), JSON.stringify({ servers: [
    { id: 's-a', name: 'bm-a', host: '127.0.0.1:9', username: 'u', password: 'p' },
    { id: 's-b', name: 'bm-b', host: '127.0.0.1:9', username: 'u', password: 'p' },
  ] }));
  fs.writeFileSync(path.join(dir, 'bmusage-settings.json'), JSON.stringify({ enabled: true, corps: { vcA: true, vcB: true } }));
  fs.writeFileSync(path.join(dir, 'datacenters.json'), JSON.stringify({ datacenters: [{ id: 'DC-A', name: 'A' }, { id: 'DC-B', name: 'B' }], assign: { vcA: 'DC-A', vcB: 'DC-B' } }));
  fs.writeFileSync(path.join(dir, 'cvp-servers.json'), JSON.stringify({ servers: [{ id: 'cA', name: 'cvp-a', datacenterId: 'DC-A' }, { id: 'cB', name: 'cvp-b', datacenterId: 'DC-B' }] }));
  const script = `
    const express = (await import('express')).default;
    const poller = await import(${JSON.stringify(path.join(SRC_DIR, 'bmusage/poller.js'))});
    poller._setFleetForTest(async () => ({ bareMetal: [
      { serverId: 's-a', name: 'bm-a', serviceTag: 'TAGA', vcenterId: 'vcA' },
      { serverId: 's-b', name: 'bm-b', serviceTag: 'TAGB', vcenterId: 'vcB' },
    ], virtualizationHosts: [] }));
    const { api } = await import(${JSON.stringify(path.join(SRC_DIR, 'routes/api.js'))});
    const audit = await import(${JSON.stringify(path.join(SRC_DIR, 'audit.js'))});
    const mk = (user) => { const app = express(); app.use(express.json()); app.use((req, _r, n) => { req.user = user; n(); }); app.use('/api', api); return app; };
    const users = {
      admin: { username: 'adm', role: 'admin' },
      readAllWriteA: { username: 'rw', role: 'admin', scope: { vcenters: [], writeVcenters: ['vcA'] } },
      scopedA: { username: 'sa', role: 'admin', scope: { vcenters: ['vcA'] } },
    };
    const body = (key, cvpId) => JSON.stringify({ key, nic: 'eno1', cvpId, deviceKey: 'SW1', port: 'Et1' });
    const out = {};
    for (const [name, user] of Object.entries(users)) {
      const srv = await new Promise((r) => { const s = mk(user).listen(0, '127.0.0.1', () => r(s)); });
      const base = 'http://127.0.0.1:' + srv.address().port + '/api/tools/bm-usage/port-map';
      const put = (key, cvpId) => fetch(base, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: body(key, cvpId) }).then((x) => x.status);
      const del = (key) => fetch(base + '?key=' + key + '&nic=eno1', { method: 'DELETE' }).then((x) => x.status);
      out[name] = { putB: await put('TAGB', 'cB'), putA_cB: await put('TAGA', 'cB'), putA: await put('TAGA', 'cA'), delB: await del('TAGB'), delA: await del('TAGA') };
      srv.close();
    }
    out.audit = audit.auditEntriesWithAction ? audit.auditEntriesWithAction('bm-usage.port-map.set').length + audit.auditEntriesWithAction('bm-usage.port-map.remove').length : null;
    console.log('@@' + JSON.stringify(out));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, AUTH_ENABLED: 'false', DATA_SOURCE: '' }, encoding: 'utf8', cwd: path.resolve(SRC_DIR, '..'), timeout: 180_000,
  });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr.slice(-2000));
  const o = JSON.parse(r.stdout.split('\n').find((l) => l.startsWith('@@')).slice(2));
  // 조회 무제한 + 쓰기 vcA 만: vcB 서버는 보이므로 404 가 아니라 403(쓰기 밖) — 31140f2a 는 여기서 200 이었다
  assert.equal(o.readAllWriteA.putB, 403, JSON.stringify(o)); assert.equal(o.readAllWriteA.delB, 403);
  assert.equal(o.readAllWriteA.putA_cB, 403, '전체 범위가 아니면(쓰기 제한) 다른 법인 CVP 로 매핑할 수 없다');
  assert.equal(o.readAllWriteA.putA, 200);
  // 범위 계정 vcA: vcB 는 안 보인다 → 404 · 자기 법인 CVP 만
  assert.equal(o.scopedA.putB, 404); assert.equal(o.scopedA.delB, 404); assert.equal(o.scopedA.putA_cB, 403); assert.equal(o.scopedA.putA, 200);
  // 관리자(전체): 다른 법인 CVP 로도 매핑 가능 · 삭제
  assert.equal(o.admin.putB, 200); assert.equal(o.admin.putA_cB, 200); assert.equal(o.admin.delB, 200);
  if (o.audit != null) assert.ok(o.audit >= 6, `감사 로그 ${o.audit}건`);
});

/* ── D4 · D5 · D6 · D9 (실제 DB 파일) ───────────────────────────────── */
async function seedLegacy(rowsFn) {
  const { DatabaseSync } = await import('node:sqlite');
  const c = new DatabaseSync(path.join(DIR, 'bm-usage.db'));
  c.exec(`CREATE TABLE usage_history (agent TEXT NOT NULL DEFAULT '', key TEXT NOT NULL, ts INTEGER NOT NULL, name TEXT, vcenter_id TEXT, src TEXT,
      cpu_pct REAL, mem_pct REAL, disk_busy_pct REAL, disk_used_pct REAL, net_pct REAL, net_bps REAL, hba_pct REAL, hba_bps REAL, io_pct REAL, PRIMARY KEY (agent, key, ts));
    CREATE INDEX idx_bmusage_ts ON usage_history(ts);
    CREATE TABLE usage_daily (agent TEXT NOT NULL DEFAULT '', key TEXT NOT NULL, day TEXT NOT NULL, name TEXT, vcenter_id TEXT,
      cpu_sum REAL DEFAULT 0, cpu_n INTEGER DEFAULT 0, cpu_max REAL, mem_sum REAL DEFAULT 0, mem_n INTEGER DEFAULT 0, mem_max REAL,
      disk_busy_max REAL, disk_used_max REAL, net_max REAL, net_bps_max REAL, hba_max REAL, hba_bps_max REAL, io_max REAL,
      samples INTEGER NOT NULL DEFAULT 0, last_ts INTEGER, PRIMARY KEY (agent, key, day));
    CREATE TABLE usage_latest (agent TEXT NOT NULL DEFAULT '', key TEXT NOT NULL, ts INTEGER NOT NULL, name TEXT, vcenter_id TEXT, src TEXT,
      cpu_pct REAL, mem_pct REAL, disk_busy_pct REAL, disk_used_pct REAL, net_pct REAL, net_bps REAL, hba_pct REAL, hba_bps REAL, io_pct REAL, PRIMARY KEY (agent, key));`);
  const ins = c.prepare('INSERT INTO usage_history (agent,key,ts,name,vcenter_id,src,cpu_pct,mem_pct) VALUES (?,?,?,?,?,?,?,?)');
  c.exec('BEGIN'); rowsFn(ins); c.exec('COMMIT'); c.close();
}
async function fresh() {
  const db = await import('../src/bmusage/db.js');
  const mig = await import('../src/bmusage/monthMigrate.js');
  db._resetForTest(); mig._resetMigrateForTest();
  for (const f of fs.readdirSync(DIR)) fs.rmSync(path.join(DIR, f), { recursive: true, force: true });
  return { db, mig, month: await import('../src/bmusage/monthStore.js') };
}
async function hourlySum(month, agent, key, from, to) {
  let samples = 0; let cpuN = 0; let cpuSum = 0;
  await month.forEachPeriod('h1', from, to, (d) => {
    for (const r of d.prepare('SELECT samples, cpu_n, cpu_sum FROM usage_hourly WHERE agent=? AND key=? AND h>=? AND h<=?').all(agent, key, month.hourOf(from), to)) { samples += r.samples; cpuN += r.cpu_n; cpuSum += r.cpu_sum; }
  });
  return { samples, cpuN, cpuSum };
}

test('D4 m1 — 두 agent 의 보존 밖 행이 rowid 로 섞여도 1시간 롤업이 agent 별로 전부 세진다(커서 키 agent 별)', async () => {
  const { db, mig, month } = await fresh();
  const T = NOW - 40 * DAY;   // 원시 보존(30일) 밖 → 1시간 롤업만
  await seedLegacy((ins) => { for (let i = 0; i < 12; i++) { ins.run('', 'K', T + i * 300_000, 'k', 'vc', 'os', 10, 1); ins.run('edgeX', 'K', T + i * 300_000, 'k', 'vc', 'os', 20, 1); } });
  await db.dbStatus();
  const r = await mig.runMonthMigration({ now: NOW, chunkRows: 5 });
  assert.equal(r.phase, 'done', JSON.stringify(r));
  assert.equal((await hourlySum(month, '', 'K', T, T + 2 * HOUR)).samples, 12);
  assert.equal((await hourlySum(month, 'edgeX', 'K', T, T + 2 * HOUR)).samples, 12, '둘째 agent 의 행이 커서에 밟혀 사라지면 안 된다(31140f2a 는 1)');
  const v = (await db.dbStatus()).migration.verify;
  assert.ok(v.checked.some((x) => x.kind === 'hourly'), '1시간 표본 수 대조가 있다');
});

test('D4 m3 — 라이브가 같은 (agent,key,ts) 를 먼저 넣어도 1시간 표본은 원시 행 수와 같다(이중 계수 없음) · 재개해도 같은 값', async () => {
  const { db, mig, month } = await fresh();
  const H = NOW - 2 * HOUR;
  await seedLegacy((ins) => { for (let i = 0; i < 6; i++) ins.run('', 'K', H + i * 300_000, 'k', 'vc', 'os', 10, 50); });
  await db.dbStatus();
  await db.insertUsage([{ key: 'K', ts: H, name: 'k', cpu_pct: 99 }], '');   // 라이브가 먼저(같은 ts)
  const r = await mig.runMonthMigration({ now: NOW, chunkRows: 2, stopAfterChunks: 1 });
  assert.equal(r.interrupted, true);
  // 저장 전 죽음 — 커서를 되돌린다
  const main = await db.mainDbForMigration();
  db.writeMeta(main, db.MIGRATE_KEY, { ...db.readMeta(main, db.MIGRATE_KEY), rawCursor: 0 });
  const r2 = await mig.runMonthMigration({ now: NOW, chunkRows: 2 });
  assert.equal(r2.phase, 'done', JSON.stringify(r2));
  const raw = (await month.readRawRange({ key: 'K', from: H, to: H + HOUR - 1 })).rows;
  const hs = await hourlySum(month, '', 'K', H, H + HOUR - 1);
  assert.equal(raw.length, 6);
  assert.equal(hs.samples, 6, `1시간 표본 ${hs.samples} — 원시 6행과 같아야 한다(31140f2a 는 7)`);
  assert.equal(hs.cpuSum, 99 + 5 * 10, '라이브 값(99)이 원시에 남고 예전 같은 ts 값(10)은 버려진다');
});

test('D4 대조: 예전 행만 있는 시간의 1시간 표본이 하나라도 빠지면 지우지 않는다(hourly 불일치 → failed · 예전 표 그대로)', async () => {
  const { db, mig, month } = await fresh();
  const T = NOW - 40 * DAY;
  // 두 시간에 걸친 24행 — 첫 시간은 ‘예전 행만 있는 시간’(같아야 한다), 둘째 시간은 경계 시간(≥)
  await seedLegacy((ins) => { for (let i = 0; i < 24; i++) ins.run('', 'K', T + i * 300_000, 'k', 'vc', 'os', 10, 1); });
  await db.dbStatus();
  const r = await mig.runMonthMigration({ now: NOW, hooks: {
    beforeVerify: async () => { await month.withPeriodFile('h1', month.periodKeyOf('h1', T), {}, (d) => { d.prepare('UPDATE usage_hourly SET samples = samples - 1 WHERE h = ?').run(month.hourOf(T)); }); },
  } });
  assert.equal(r.phase, 'failed'); assert.equal(r.failedPhase, 'verify'); assert.match(r.error, /hourly/);
  const { DatabaseSync } = await import('node:sqlite');
  const c = new DatabaseSync(path.join(DIR, 'bm-usage.db'), { readOnly: true });
  assert.equal(c.prepare('SELECT COUNT(*) c FROM usage_history').get().c, 24, '대조 실패면 예전 표를 지우지 않는다'); c.close();
});

test('D5 a1 — 1시간 파일을 못 열어 롤업만 실패해도 보정 대기가 남고, 다음 보정이 원시에서 다시 집계한다(재전송해도 두 번 세지 않음)', async () => {
  const { db, month } = await fresh();
  const H = NOW - HOUR;
  const bad = path.join(DIR, month.fileNameOf('h1', month.periodKeyOf('h1', H)));
  fs.mkdirSync(bad);
  const r = await db.insertUsage([{ key: 'A', ts: H, cpu_pct: 30 }, { key: 'A', ts: H + 300_000, cpu_pct: 50 }], '');
  assert.equal(r.inserted, 2); assert.equal(r.ok, false, '롤업 실패를 숨기지 않는다');
  assert.equal(await month.pendingCount(), 1, '그 시간 버킷이 보정 대기로 남는다');
  fs.rmSync(bad, { recursive: true });
  month._resetMonthStoreForTest();
  assert.equal((await db.insertUsage([{ key: 'A', ts: H, cpu_pct: 30 }], '')).duplicates, 1);
  const rp = await db.repairRollups({});
  assert.ok(rp.buckets >= 1, JSON.stringify(rp));
  const hs = await hourlySum(month, '', 'A', H, H + HOUR - 1);
  assert.deepEqual([hs.samples, hs.cpuN, hs.cpuSum], [2, 2, 80]);
  const d = (await db.usageDaily({ key: 'A', days: 2 })).find((x) => x.samples >= 2);
  assert.equal(d.samples, 2, '1일은 다시 집계해도 같은 값(교체 — 누적 아님)'); assert.equal(d.cpu_avg, 40);
  assert.equal(await month.pendingCount(), 0);
  assert.equal((await db.repairRollups({})).buckets, 0, '대기가 없으면 아무것도 하지 않는다');
});

test('D5 — 정상 적재는 대기를 남기지 않는다(롤업이 성공하면 이번 대기를 지운다)', async () => {
  const { db, month } = await fresh();
  await db.insertUsage([{ key: 'B', ts: NOW - HOUR, cpu_pct: 1 }], '');
  assert.equal(await month.pendingCount(), 0);
});

test('D6 — 3회 실패 뒤에도 재시작하면 0 부터 · 다 쓴 뒤 6시간이면 다시 시도 · 실패 대기 중 파일·예전 표 보존은 멈춤 · 상태에 다음 재시도', async () => {
  const { db, mig, month } = await fresh();
  const T = NOW - 2 * HOUR;
  await seedLegacy((ins) => { for (let i = 0; i < 6; i++) ins.run('', 'K', T + i * 300_000, 'k', 'vc', 'os', 10, 1); });
  await db.dbStatus();
  const main = await db.mainDbForMigration();
  db.writeMeta(main, db.MIGRATE_KEY, { ...db.readMeta(main, db.MIGRATE_KEY), phase: 'failed', failedPhase: 'copy-raw', attempts: 3, failedAt: NOW - 10 * 60_000, error: 'ENOSPC' });
  // 이 프로세스의 첫 실행 → 횟수 0 부터(1시간 대기는 그대로)
  const a = await mig.runMonthMigration({ now: NOW });
  assert.equal(a.reason, 'retry-wait'); assert.ok(a.nextRetryAt > NOW);
  assert.equal(db.readMeta(main, db.MIGRATE_KEY).attempts, 0, '재시작하면 시도 횟수를 되돌린다');
  assert.equal(mig.migrationLast().nextRetryAt, a.nextRetryAt, '상태(_last)에 다음 재시도');
  // 실패 대기 중 보존 정리는 멈춘다
  const pr = await db.pruneUsage({ rawDays: 0.0001, force: true, keep: { raw: 1, h1: 1, d1: 1, dev: 1, dev1h: 1 } });
  assert.equal(pr.heldForMigration, 'failed'); assert.equal(pr.rawDeleted, 0);
  // 다 쓴 상태 + 6시간 경과 → 다시 시도해 끝까지
  db.writeMeta(main, db.MIGRATE_KEY, { ...db.readMeta(main, db.MIGRATE_KEY), attempts: 3, failedAt: NOW - 7 * HOUR });
  const b = await mig.runMonthMigration({ now: NOW });
  assert.equal(b.phase, 'done', JSON.stringify(b));
  assert.equal((await hourlySum(month, '', 'K', T, T + HOUR)).samples, 6);
});

test('D9 — 1시간 롤업 peak_src 는 피크를 낸 행의 출처(뒤의 psi 행이 덮지 않음 · 섞이면 mixed)', async () => {
  const { db, month } = await fresh();
  const H = NOW - 3 * HOUR;
  await db.insertUsage([
    { key: 'P', ts: H, cpu_pct: 10, cpu_pct_peak: 80, cpu_pct_peak_at: H - 1, peak_src: 'window10' },
    { key: 'P', ts: H + 300_000, cpu_pct: 10, peak_src: 'psi' },
  ], '');
  const row = (await month.readHourlyRange({ key: 'P', from: H, to: H + HOUR - 1 })).rows[0];
  assert.equal(row.peak_src, 'window10'); assert.equal(row.cpu_pct_peak, 80);
  await db.insertUsage([{ key: 'P', ts: H + 600_000, cpu_pct: 10, cpu_pct_peak: 20, cpu_pct_peak_at: H, peak_src: 'sampler' }], '');
  assert.equal((await month.readHourlyRange({ key: 'P', from: H, to: H + HOUR - 1 })).rows[0].peak_src, 'mixed');
  const M = await import('../src/bmusage/monthStore.js');
  assert.equal(M.mergePeakSrc(null, 'psi', false), 'psi'); assert.equal(M.mergePeakSrc('psi', 'window10', true), 'window10');
  assert.equal(M.aggregateRows([{ ts: 1, peak_src: 'window10', cpu_pct_peak: 5 }, { ts: 2, peak_src: 'psi' }], { agent: '', key: 'P', bucketCol: 'h', bucket: 0, rolls: M.ROLL }).peak_src, 'window10', '재집계도 같은 규칙');
});

/* ── D2 ─────────────────────────────────────────────────────────────── */
test('D2 — 타이머는 실행 뒤 재무장(간격 = 실행 + 주기): 1,000대 · 동시 32 에서 자동 맞춤이면 다섯 지표 간격 ≤ 10분(추이 결측 없음) · 맞춤이 없으면 결측', async () => {
  const P = await import('../src/bmusage/peakPlan.js');
  const W = await import('../src/bmusage/trendWindow.js');
  const IV = 300_000;
  const spaced = (periodMs, n = 12) => Array.from({ length: n }, (_, i) => ({ t: i * periodMs, avg: 1, max: 1, peak: null }));
  for (const baseMs of [3_000, 5_000, 7_000]) {
    const plan = P.planCycleWindow({ targets: 1000, osTargets: 1000, concurrency: 32, intervalMs: IV, capS: 10, baseMs });
    assert.equal(plan.expectedPeriodMs, plan.expectedMs + IV, '간격 = 실행 + 주기');
    assert.ok(plan.expectedPeriodMs <= 2 * IV, `기본 ${baseMs}ms: 간격 ${plan.expectedPeriodMs} 가 결측 경계(10분)를 넘는다`);
    const pts = spaced(plan.expectedPeriodMs);
    assert.deepEqual(W.gapsOf(pts, { from: 0, to: pts.at(-1).t, stepMs: IV }), [], `기본 ${baseMs}ms: 5분 추이에 결측이 생긴다`);
  }
  // 맞춤이 없으면(창 10초 그대로) 간격 ≈ 469 + 300 = 769초 → 모든 구간이 결측(31140f2a 의 기본값)
  const noPlan = P.expectedCycleMs({ targets: 1000, concurrency: 32, baseMs: 5_000, windowS: 10 }) + IV;
  assert.ok(noPlan > 2 * IV);
  const g = W.gapsOf(spaced(noPlan), { from: 0, to: 11 * noPlan, stepMs: IV });
  assert.equal(g.length, 11, '점 사이마다 결측');
  // 비율 상한 0.95 — 1 이상이면 간격 보장이 깨진다
  assert.equal(P.planCycleWindow({ targets: 10, concurrency: 1, intervalMs: IV, ratio: 3, capS: 10, baseMs: 1_000 }).ratio, 0.95);
});

/* ── D7 ─────────────────────────────────────────────────────────────── */
test('D7 — hostMatch 36표본(반증 h1): 거짓 음성 0 · 거짓 양성은 예전부터 있던 1건(2자 이름 — matchUplinks 단서가 아니다)뿐 · 업링크 결과', async () => {
  const M = await import('../src/cvp/hostMatch.js');
  const cases = [
    ['esx01', 'esx01 vmnic0', true], ['esx01', 'esx010 vmnic0', false], ['esx01', 'ESX01-vmnic1', true], ['esx01', 'to esx01b', false],
    ['esx01', 'esx01-b vmnic0', false], ['esx-01', 'esx-01 vmnic0', true], ['esx-01', 'esx-010 vmnic0', false], ['esx-01', 'esx-01-b vmnic0', false],
    ['esx-01', 'ESX_01 uplink', true], ['esx-01', 'esx 01', true], ['esx-01', 'esx/01', true], ['esx-01', 'kr-esx-01 vmnic2', false],
    ['esx-01', 'esx01', false], ['kr-esx-01', 'kr-esx-01 vmnic0', true], ['kr-esx-01', 'kr-esx-010', false], ['kr-esx-01', 'kr-esx-01-mgmt', true],
    ['kr-esx-1', 'kr-esx-10 vmnic0', false], ['kr-esx-1', 'kr esx 1', true], ['db-01', 'po10 db-01/db-02 mlag', true], ['db-02', 'po10 db-01/db-02 mlag', true],
    ['db-1', 'db-1-0 uplink', false], ['a-b', 'link a b c', false], ['bm-kr1-db01', 'bm-kr1-db01 eno1', true], ['bm-kr1-db01', 'bm-kr1-db010 eno1', false],
    ['bm-kr1-db01', 'bm-kr1-db01.corp.local', true], ['bm-kr1-db01', 'BM_KR1_DB01', true], ['bm-kr1-db01', 'bm-kr1-db01-old', false], ['host-1', 'host-1 eth0', true],
    ['host-1', 'vhost-1', false], ['web-01', 'web-01a', false], ['web-01', 'web-01 a', true], ['esx01.corp', 'esx01 vmnic', true],
    ['srv-10-1', 'srv 10 1 2', true], ['srv-10-1', 'srv-10-12', false], ['10.0.0.1', '10.0.0.1 mgmt', true], ['10.0.0.1', '10.0.0.10', false],
  ];
  assert.equal(cases.length, 36);
  const fp = []; const fn = [];
  for (const [h, d, exp] of cases) {
    const got = M.descHasName(d, h.toLowerCase().split('.')[0]);
    if (got && !exp) fp.push(`${h}|${d}`); if (!got && exp) fn.push(`${h}|${d}`);
  }
  assert.deepEqual(fn, [], '거짓 음성 0');
  assert.deepEqual(fp, ['10.0.0.1|10.0.0.10'], '남은 거짓 양성은 2자 이름 \'10\' 하나 — hostMatchTerms 가 3자 미만 이름을 단서로 쓰지 않아 업링크 매칭에는 닿지 않는다');
  assert.deepEqual(M.hostMatchTerms({ name: '10.0.0.1' }).names, [], '2자 짧은 이름은 단서가 아니다');
  // 가상화 호스트(v2.920 경로) — 뒤 연장(-b)·앞 연장은 잡지 않고, 연결어·역할 접미사는 잡는다
  const host = { name: 'kr-esx-01.corp.local', nics: [{ device: 'vmnic0', mac: '00:50:56:aa:bb:01' }, { device: 'vmnic1', mac: '' }] };
  const ports = [{ port: 'Et1', desc: 'kr-esx-01 vmnic0' }, { port: 'Et2', desc: 'kr-esx-01-b vmnic0' }, { port: 'Et3', desc: 'kr-esx-010 vmnic1' }, { port: 'Et4', desc: 'uplink kr esx 01' }, { port: 'Et5', desc: 'to-kr-esx-01' }];
  assert.deepEqual(M.matchUplinks(ports, host).uplinks.map((u) => [u.port, u.basis, u.nic]), [['Et1', 'desc-nic', 'vmnic0'], ['Et4', 'desc-name', null], ['Et5', 'desc-name', null]]);
  // 베어메탈 — 별칭 · 리눅스 NIC(붙어 있어도 NIC 지목) · -old 는 다른 호스트
  const bm = { name: 'bm-kr1-db01', aliases: ['ABC1234'], nics: [{ device: 'eno1' }] };
  const bports = [{ port: 'P1', desc: 'bm-kr1-db01 eno1' }, { port: 'P2', desc: 'svc ABC1234' }, { port: 'P3', desc: 'bm-kr1-db01-old eno1' }, { port: 'P4', desc: 'bm-kr1-db01-eno1' }];
  assert.deepEqual(M.matchUplinks(bports, bm).uplinks.map((u) => [u.port, u.basis, u.nic]), [['P1', 'desc-nic', 'eno1'], ['P2', 'desc-name', null], ['P4', 'desc-nic', 'eno1']]);
});

/* ── D12 ────────────────────────────────────────────────────────────── */
test('D12 — 피크 노트는 원인을 단정하지 않는다: 예산 축소(계산) · 표본 구간 모자람(원인 미확인) · 명령 실패를 따로', async () => {
  const U = await import('../src/bmusage/usage.js');
  const base = { ok: true, osKind: 'linux', counters: { cpu: { total: 1, idle: 1 }, disks: [], nets: [] }, mounts: [], perf: {} };
  const notes = (peak) => U.buildUsage({ target: { key: 'K' }, os: { ...base, peak }, now: 5_000 }).notes.join(' | ');
  // 창은 돌렸는데 표본 구간 0(31140f2a 는 여기서 '세션 예산이 모자라 …' 라고 단정했다)
  const short = notes({ windowS: 0, wantS: 10, plannedS: 10, reason: '', shortBy: 10, server: {}, devices: {} });
  assert.match(short, /10초 중 0초 구간만/); assert.match(short, /원인은 확인하지 못했습니다/); assert.doesNotMatch(short, /세션 예산/);
  assert.match(notes({ windowS: 0, wantS: 10, plannedS: 0, reason: 'budget' }), /최소 창\(2초\)보다 짧아/);
  assert.match(notes({ windowS: 0, wantS: 10, reason: 'error' }), /명령.*실패.*원인은 확인하지 못했습니다/);
});

/* ── D13 ────────────────────────────────────────────────────────────── */
test('D13 — 샘플러 해시는 자기 신고 값(기록 일치일 뿐 — 주석·사유가 그렇게 말한다) · 미래 시각은 형식 오류', async () => {
  const S = await import('../src/bmusage/samplerSpec.js');
  const sha = 'b'.repeat(64);
  const head = (at) => [`#dvc-bmperf v1 sha256=${sha} at=${at} window=300`, 'cpu_pct|1|2|1700000000'];
  const ok = S.parseSamplerFile(head(1700000000), { expectedSha: sha, now: 1700000000_000 + 60_000 });
  assert.equal(ok.state, 'ok'); assert.equal(ok.shaSelfReported, true, '설정에 해시를 넣으면 지금도 ok 가 될 수 있다(예전 주석은 틀렸다)');
  assert.equal(S.parseSamplerFile(head(1700000000 + 3600), { expectedSha: sha, now: 1700000000_000 }).state, 'bad', '미래 시각');
  assert.match(S.parseSamplerFile(head(1700000000), { expectedSha: 'c'.repeat(64), now: 1700000000_000 }).reason, /자기 신고/);
  const src = fs.readFileSync(path.join(SRC_DIR, 'bmusage/samplerSpec.js'), 'utf8');
  assert.ok(!src.includes('어떤 서버에서도\n *   state 가 \'ok\' 가 될 수 없다(기대'), '틀린 주석이 남아 있다');
});

/* ── D15 ────────────────────────────────────────────────────────────── */
test('D15 — 포트 대조는 CVP 도구 접근이 있어야 포트 값을 준다(없으면 권한 없음만) · 비관리자에게 포트 설명의 주소를 가린다', async () => {
  const B = await import('../src/routes/api/bmUsage.js');
  const now = Date.now();
  const target = { key: 'S', name: 'bm-kr1-db01', vcenterId: 'vc1', paths: ['os'] };
  const deps = {
    currentTargets: async () => ({ targets: [target] }), bmAddressHosts: async () => [], listEdgeBmUsage: async () => [],
    nicLatestFor: async () => ({ ok: true, nics: [{ nic: 'eno1', at: now, spanMs: 300_000, rxBps: 1, txBps: 1 }] }),
    cvpServers: async () => [{ id: 'c1', datacenterId: 'DC' }], datacenterOfVcenter: async () => 'DC',
    portLatestRows: async () => ({ rows: [{ cvp_id: 'c1', device_key: 'SW1', port: 'Et1', descr: 'bm-kr1-db01 eno1 10.20.30.40', in_bps: 8, out_bps: 8, rate_ts: now, hostname: 'sw1' }] }),
    portsByDesc: async () => ({ rows: [{ cvpId: 'c1', key: 'SW1', port: 'Et1', desc: 'bm-kr1-db01 eno1 10.20.30.40', hostname: 'sw1' }] }),
    cvpIntervalMs: async () => 300_000,
    listPortMap: async () => [{ nic: 'eno1', cvpId: 'c1', deviceKey: 'SW1', port: 'Et1' }],
  };
  const op = { user: { username: 'op', role: 'operator' }, params: { key: 'S' }, query: {} };
  const denied = await B.bmPortsView(op, {}, { ...deps, cvpToolIssue: async () => ({ tool: 'cvp', reason: '차단' }) });
  assert.equal(denied.cvpAccess, false); assert.deepEqual(denied.nics, [{ nic: 'eno1', state: 'no-permission' }]); assert.deepEqual(denied.candidates, []);
  assert.ok(!JSON.stringify(denied).includes('10.20.30.40'));
  const allowed = await B.bmPortsView(op, {}, { ...deps, cvpToolIssue: async () => null });
  assert.equal(allowed.cvpAccess, true); assert.equal(allowed.nics[0].state, 'mapped');
  assert.ok(!JSON.stringify(allowed).includes('10.20.30.40'), '비관리자 응답에 포트 설명의 주소가 남았다');
  const adm = await B.bmPortsView({ ...op, user: { username: 'a', role: 'admin' } }, {}, deps);
  assert.ok(JSON.stringify(adm).includes('10.20.30.40'), '관리자는 원문');
  // 실제 도구 접근 판정(기본 dep): 권한 파일이 없으면 operator 도 허용(거부 목록이 비어 있다) — 판정 함수가 연결돼 있는지만 본다
  const real = await B.bmPortsView(op, {}, (({ cvpToolIssue: _x, ...d }) => d)({ ...deps, cvpToolIssue: undefined }));
  assert.equal(typeof real.cvpAccess, 'boolean');
});

/* ── D8 · D11 · D14 ─────────────────────────────────────────────────── */
test('D8 — 1일 추이도 열기 실패한 해(missingPeriods)와 파일 상한을 밝힌다 · D11 5분 추이는 필요한 열만 · 행 수 상태는 캐시(낡으면 지난 값 + stale)', async () => {
  const { db, month } = await fresh();
  const q = await import('../src/bmusage/trendQuery.js');
  const S = await import('../src/bmusage/settings.js');
  await db.insertUsage([{ key: 'T', ts: NOW - HOUR, cpu_pct: 5 }], '');
  const lastYear = String(new Date(NOW).getUTCFullYear() - 1);
  fs.mkdirSync(path.join(DIR, month.fileNameOf('d1', lastYear)));   // 작년 1일 파일 자리를 못 연다
  const r = await q.trendFor({ agent: '', key: 'T', q: { metric: 'cpu_pct', res: '1d', from: String(NOW - 500 * DAY), to: String(NOW) }, settings: S.normalizeSettings({}) });
  assert.equal(r.res, '1d');
  assert.ok((r.missingPeriods || []).some((x) => x.period === lastYear), JSON.stringify(r.missingPeriods));
  fs.rmSync(path.join(DIR, month.fileNameOf('d1', lastYear)), { recursive: true });
  const src = fs.readFileSync(path.join(SRC_DIR, 'bmusage/trendQuery.js'), 'utf8');
  assert.match(src, /rawRangeMerged\(\{ key, agent, from: win\.from, to: win\.to, limit: 50_000, cols: \[pq\.metric, `\$\{pq\.metric\}_peak`, `\$\{pq\.metric\}_peak_at`, 'peak_src'\] \}\)/);
  const raw = await db.rawRangeMerged({ key: 'T', from: NOW - 2 * HOUR, to: NOW, cols: ['cpu_pct'] });
  assert.deepEqual(Object.keys(raw.rows[0]).sort(), ['cpu_pct', 'ts'], '필요한 열만 읽는다');
  const s1 = await month.monthStoreStatus();
  assert.ok(s1.raw.rows >= 1 && !s1.stale);
  month.invalidateMonthCounts();
  const s2 = await month.monthStoreStatus();
  assert.equal(s2.stale, true, '낡았으면 지난 값을 바로 돌려주고 뒤에서 다시 센다');
  assert.match(fs.readFileSync(path.join(SRC_DIR, 'routes/admin/idracTrend.js'), 'utf8'), /cpuHistoryNote = \{ reason: 'bm-raw-retention', rawDays, coverFrom \}/, 'D14 — 원시 보존 밖 구간을 응답이 밝힌다');
  const M = await import('../src/bmusage/monthMigrate.js');
  assert.equal(M.MIGRATE_CHUNK_ROWS, 500, 'D11 — 마이그레이션 청크 500');
});

test('D4 경계: 원시 보존 경계를 정시로 맞춰 한 시간이 ‘커서로 더하기’ 와 ‘원시 재집계’ 로 갈라지지 않는다(정시가 아닌 now 로 시험)', async () => {
  const { db, mig, month } = await fresh();
  const cut = NOW - 30 * DAY;   // now = NOW + 30분 → 정시로 맞추지 않으면 경계가 cut + 30분(시간 중간)
  await seedLegacy((ins) => { for (let i = -12; i < 12; i++) ins.run('', 'K', cut + i * 300_000, 'k', 'vc', 'os', 10, 1); });
  await db.dbStatus();
  const r = await mig.runMonthMigration({ now: NOW + 30 * 60_000 });
  assert.equal(r.phase, 'done', JSON.stringify(r));
  assert.equal((await hourlySum(month, '', 'K', cut - HOUR, cut + HOUR - 1)).samples, 24, '경계 시간의 표본이 재집계로 지워지면 안 된다');
});

test('D4 업그레이드 당일: 보정이 1일을 다시 집계해도 옮긴 예전 원시(1일 사본 표가 따로 가진다)를 다시 세지 않는다', async () => {
  const { db, mig, month } = await fresh();
  const H = NOW - 3 * HOUR;
  const { dayKey } = await import('../src/util/dayKey.js');
  await seedLegacy((ins) => { for (let i = 0; i < 6; i++) ins.run('', 'K', H + i * 300_000, 'k', 'vc', 'os', 10, 1); });
  { const { DatabaseSync } = await import('node:sqlite'); const c = new DatabaseSync(path.join(DIR, 'bm-usage.db'));
    c.prepare('INSERT INTO usage_daily (agent,key,day,name,vcenter_id,cpu_sum,cpu_n,cpu_max,mem_sum,mem_n,mem_max,samples,last_ts) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run('', 'K', dayKey(H), 'k', 'vc', 60, 6, 10, 6, 6, 1, 6, H + 25 * 60_000); c.close(); }
  await db.dbStatus();
  assert.equal((await mig.runMonthMigration({ now: NOW })).phase, 'done');
  if (dayKey(NOW - HOUR) !== dayKey(H)) return;   // 자정 직후면 같은 날이 아니다 — 이 시험은 같은 날에서만 뜻이 있다
  await db.insertUsage([{ key: 'K', ts: NOW - HOUR, cpu_pct: 30 }], '');
  // 그 시간 버킷에 1일 재집계가 걸린 보정 대기를 직접 남긴다(롤업 실패를 흉내)
  await month.withPeriodFile('raw', month.periodKeyOf('raw', NOW - HOUR), {}, (d) => { d.prepare('INSERT OR REPLACE INTO _pend (agent,key,h,daily,at) VALUES (?,?,?,?,?)').run('', 'K', month.hourOf(NOW - HOUR), 1, Date.now()); });
  const rp = await db.repairRollups({});
  assert.ok(rp.days >= 1, JSON.stringify(rp));
  const d = (await db.usageDaily({ key: 'K', days: 2 })).find((x) => x.day === dayKey(H));
  assert.equal(d.samples, 7, `예전 6(사본) + 라이브 1 = 7 이어야 한다 — 옮긴 원시를 다시 세면 13 (${d.samples})`);
});
