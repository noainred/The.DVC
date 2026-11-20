/**
 * v2.922(리눅스 성능 3a) — 예전 메인 파일 표 → 시간 단위 파일 마이그레이션. **실제 DB 파일**로 순서·중단·재개·실패를 시험한다.
 *  ① 순서: 옮기기 → 행 수 대조 → 그 뒤 삭제(각 단계 사이에 예전 표가 온전한지 본다)
 *  ② 중단 → 재개: 원시는 한 번만 들어가고 1시간 롤업은 두 번 더해지지 않는다(커서를 되돌린 ‘저장 전 죽음’ 도)
 *  ③ 실패(대상 파일을 열 수 없음): phase=failed · 예전 표는 그대로 · 읽기는 예전 표로 계속 · 고친 뒤 재시도로 끝난다
 *  ④ 대조 불일치: 지우지 않는다
 *  ⑤ 마이그레이션 중 읽기: 예전 표와 사본이 겹치지 않는다(중복 0)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'bm2921mig-'));
process.env.CONFIG_DIR = DIR;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const DAY = 86_400_000; const HOUR = 3_600_000;
// 기준 시각: 실제 시각에서 정시로 떨어뜨린다(common.md — Date.now() 직접·고정 epoch 둘 다 깨진다)
const NOW = Math.floor(Date.now() / HOUR) * HOUR;
const KEYS = ['A', 'B', 'C'];
/** 예전(v2.918 모양) 메인 파일을 손으로 만든다 — 원시 3대 × 6시간(5분) + 원시 40일 전 1시간 + 일 롤업 3일. */
async function seedLegacy() {
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
  c.exec('BEGIN');
  let n = 0;
  const t0 = NOW - 6 * HOUR;
  for (let i = 0; i < 72; i++) for (const k of KEYS) { ins.run('', k, t0 + i * 300_000, `bm-${k}`, 'vc1', 'os', 10 + (i % 12), 50); n++; }
  // 40일 전(원시 보존 30일 밖) — 원시로는 옮기지 않고 1시간 롤업만
  for (let i = 0; i < 12; i++) { ins.run('', 'A', NOW - 40 * DAY + i * 300_000, 'bm-A', 'vc1', 'os', 30, 50); n++; }
  const d = c.prepare('INSERT INTO usage_daily (agent,key,day,name,vcenter_id,cpu_sum,cpu_n,cpu_max,mem_sum,mem_n,mem_max,samples,last_ts) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const { dayKey } = await import('../src/util/dayKey.js');
  let dn = 0;
  for (let j = 1; j <= 3; j++) for (const k of KEYS) { d.run('', k, dayKey(NOW - j * DAY), `bm-${k}`, 'vc1', 2880, 288, 20, 14400, 288, 60, 288, NOW - j * DAY); dn++; }
  c.exec('COMMIT');
  c.close();
  return { raw: n, recentRaw: 72 * 3, daily: dn };
}
function legacyCount(table) {
  return import('node:sqlite').then(({ DatabaseSync }) => {
    const c = new DatabaseSync(path.join(DIR, 'bm-usage.db'), { readOnly: true });
    try { return c.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c; } finally { c.close(); }
  });
}
async function fresh() {
  const db = await import('../src/bmusage/db.js');
  const mig = await import('../src/bmusage/monthMigrate.js');
  db._resetForTest(); mig._resetMigrateForTest();
  for (const f of fs.readdirSync(DIR)) fs.rmSync(path.join(DIR, f), { recursive: true, force: true });
  return { db, mig, month: await import('../src/bmusage/monthStore.js') };
}
async function hourlySamples(month, from, to) {
  let total = 0;
  await month.forEachPeriod('h1', from, to, (db) => { for (const r of db.prepare('SELECT samples, cpu_sum, cpu_n FROM usage_hourly').all()) total += r.samples; });
  return total;
}

test('① 순서: 옮기기 → 행 수 대조 → 그 뒤 삭제 — 대조 전까지 예전 표는 한 행도 줄지 않는다', async () => {
  const { db, mig, month } = await fresh();
  const seed = await seedLegacy();
  await db.dbStatus();   // 열기 — 상태가 copy-raw 로 정해진다
  assert.equal((await db.migrationReadRule()).phase, 'copy-raw');
  const seen = [];
  const r = await mig.runMonthMigration({ chunkRows: 50, now: NOW, hooks: {
    afterRawChunk: async () => { seen.push(['chunk', await legacyCount('usage_history')]); },
    beforeVerify: async () => { seen.push(['verify', await legacyCount('usage_history'), await legacyCount('usage_daily')]); },
  } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.phase, 'done');
  assert.ok(seen.length >= 3);
  for (const s of seen) assert.equal(s[1], seed.raw, `${s[0]} 시점에 예전 원시가 줄었다 — 대조 전 삭제`);
  assert.equal(seen.at(-1)[2], seed.daily, '대조 직전 예전 일 롤업 온전');
  assert.equal(await legacyCount('usage_history'), 0, '대조 뒤 삭제');
  assert.equal(await legacyCount('usage_daily'), 0);
  const st = await db.dbStatus();
  assert.equal(st.migration.phase, 'done');
  assert.equal(st.migration.verify.ok, true);
  assert.equal(st.migration.copied.raw, seed.recentRaw, '보존 안 원시만 원시 파일로');
  assert.equal(st.migration.copied.rawOld, 12, '보존 밖 원시는 롤업만');
  // 원시는 월 파일에서 그대로 읽힌다(6시간 = 72 × 3)
  const h = await db.usageHistory('A', { hours: 7, limit: 1000 });
  assert.equal(h.rows.length, 72);
  // 1시간 롤업은 모든 예전 원시(40일 전 포함)를 한 번씩 센다
  assert.equal(await hourlySamples(month, NOW - 41 * DAY, NOW), seed.raw);
  // 일 롤업은 사본 표에서 읽힌다(값 보존)
  const d = await db.usageDaily({ key: 'B', days: 5 });
  assert.equal(d.length >= 3, true);
  assert.equal(d.find((x) => x.samples === 288)?.cpu_avg, 10);
});

test('② 중단 → 재개(커서를 되돌린 ‘저장 전 죽음’ 포함): 원시 한 번 · 1시간 롤업 두 번 더하지 않음 · 읽기 중복 0', async () => {
  const { db, mig, month } = await fresh();
  const seed = await seedLegacy();
  await db.dbStatus();
  let r = await mig.runMonthMigration({ chunkRows: 40, now: NOW, stopAfterChunks: 2 });
  assert.equal(r.interrupted, true);
  // 중단 중 읽기: 예전 표가 원본(사본과 겹치지 않는다 — 72행 정확히)
  const mid = await db.usageHistory('A', { hours: 7, limit: 1000 });
  assert.equal(mid.rows.length, 72, '마이그레이션 중 읽기에 중복이 생겼다');
  assert.equal(new Set(mid.rows.map((x) => x.ts)).size, 72);
  // ‘청크를 썼지만 커서를 저장하기 전에 죽었다’ — 커서를 0 으로 되돌린다
  const main = await db.mainDbForMigration();
  const st0 = db.readMeta(main, db.MIGRATE_KEY);
  db.writeMeta(main, db.MIGRATE_KEY, { ...st0, rawCursor: 0 });
  r = await mig.runMonthMigration({ chunkRows: 40, now: NOW });
  assert.equal(r.phase, 'done', JSON.stringify(r));
  assert.equal(await hourlySamples(month, NOW - 41 * DAY, NOW), seed.raw, '1시간 롤업이 재개로 두 번 더해졌다');
  const after = await db.usageHistory('A', { hours: 7, limit: 1000 });
  assert.equal(after.rows.length, 72);
  assert.equal(await legacyCount('usage_history'), 0);
});

test('③ 실패(대상 월 파일을 열 수 없음): failed · 예전 표 그대로 · 예전 표로 계속 읽음 · 고친 뒤 재시도로 완료', async () => {
  const { db, mig, month } = await fresh();
  const seed = await seedLegacy();
  await db.dbStatus();
  const bad = path.join(DIR, month.fileNameOf('raw', month.periodKeyOf('raw', NOW - 3 * HOUR)));
  fs.mkdirSync(bad);   // 파일 자리에 디렉터리 — SQLite 가 열지 못한다(실제 파일 시스템 실패)
  const r = await mig.runMonthMigration({ chunkRows: 100, now: NOW });
  assert.equal(r.ok, false); assert.equal(r.phase, 'failed'); assert.equal(r.failedPhase, 'copy-raw');
  assert.equal(await legacyCount('usage_history'), seed.raw, '실패했는데 예전 원시가 줄었다');
  assert.equal(await legacyCount('usage_daily'), seed.daily);
  const rule = await db.migrationReadRule();
  assert.equal(rule.legacyRaw, true, '실패 중에는 예전 표가 원본');
  const h = await db.usageHistory('B', { hours: 7, limit: 1000 });
  assert.equal(h.rows.length, 72, '실패 중에도 예전 표로 계속 읽는다');
  assert.ok((await db.dbStatus()).migration.error);
  // 바로 다시 부르면 재시도 대기(한 시간) — 무한 재시도로 돌지 않는다
  assert.equal((await mig.runMonthMigration({ now: NOW })).reason, 'retry-wait');
  fs.rmSync(bad, { recursive: true });
  const r2 = await mig.runMonthMigration({ chunkRows: 100, now: NOW, hooks: { retryNow: true } });
  assert.equal(r2.phase, 'done', JSON.stringify(r2));
  assert.equal(await hourlySamples(month, NOW - 41 * DAY, NOW), seed.raw);
});

test('④ 대조 불일치면 지우지 않는다(failedPhase=verify)', async () => {
  const { db, mig, month } = await fresh();
  const seed = await seedLegacy();
  await db.dbStatus();
  const r = await mig.runMonthMigration({ chunkRows: 100, now: NOW, hooks: {
    beforeVerify: async () => {
      // 사본 일부를 잃은 상황
      await month.withPeriodFile('raw', month.periodKeyOf('raw', NOW - HOUR), { create: false }, (d) => { d.exec('DELETE FROM usage_history WHERE rowid IN (SELECT rowid FROM usage_history LIMIT 5)'); });
    },
  } });
  assert.equal(r.phase, 'failed'); assert.equal(r.failedPhase, 'verify');
  assert.match(r.error, /행 수 대조 실패/);
  assert.equal(await legacyCount('usage_history'), seed.raw);
  assert.equal(await legacyCount('usage_daily'), seed.daily);
  assert.equal((await db.migrationReadRule()).legacyRaw, true);
});

test('⑤ 예전 표가 없는 새 설치는 none — 마이그레이션 없이 바로 월 파일', async () => {
  const { db, mig } = await fresh();
  await db.dbStatus();
  assert.equal((await db.migrationReadRule()).phase, 'none');
  assert.equal((await mig.runMonthMigration({ now: NOW })).phase, 'none');
});
