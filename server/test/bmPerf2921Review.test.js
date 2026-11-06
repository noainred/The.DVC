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

test('D4 대조: 1시간 표본이 빠지면 지우지 않는다(hourly 불일치 → failed · 예전 표 그대로)', async () => {
  const { db, mig, month } = await fresh();
  const T = NOW - 40 * DAY;
  await seedLegacy((ins) => { for (let i = 0; i < 12; i++) ins.run('', 'K', T + i * 300_000, 'k', 'vc', 'os', 10, 1); });
  await db.dbStatus();
  const r = await mig.runMonthMigration({ now: NOW, hooks: {
    beforeVerify: async () => { await month.withPeriodFile('h1', month.periodKeyOf('h1', T), {}, (d) => { d.exec('UPDATE usage_hourly SET samples = samples - 1'); }); },
  } });
  assert.equal(r.phase, 'failed'); assert.equal(r.failedPhase, 'verify'); assert.match(r.error, /hourly/);
  const { DatabaseSync } = await import('node:sqlite');
  const c = new DatabaseSync(path.join(DIR, 'bm-usage.db'), { readOnly: true });
  assert.equal(c.prepare('SELECT COUNT(*) c FROM usage_history').get().c, 12, '대조 실패면 예전 표를 지우지 않는다'); c.close();
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
