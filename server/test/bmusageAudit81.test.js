/**
 * 전체 점검 81회차 — 베어메탈 사용률 2차 ③(최상위 모듈 a~m: db · monthMigrate · monthStore · idle · capacity …) 회귀 시험.
 *  F1 마이그레이션이 **삭제 단계에서** 실패(phase failed · failedPhase delete)하면 읽기 규칙이 반쯤 지운 예전 표를 그 구간의 원본으로 보고
 *     시간 단위 파일(대조를 통과한 사본)을 건너뛰어 화면 이력에 구멍이 났다 → 삭제 단계 실패는 '삭제 중' 과 같은 규칙(파일이 원본).
 *  F2 저활용 결과 파일(bm-idle.json) 읽기 오류(EISDIR · EACCES …)를 손상으로 보고 원본을 옮긴 뒤 다음 계산이 이력(62일) · 후보 시작일을 새로 썼다
 *     → 공용 판정(util/jsonFileLoad readJsonFile) — 읽기 오류는 옮기지 않고(캐시 안 함) 그동안 다시 계산이 덮어쓰지 않는다.
 *  F3 용량 소진 예측 결과 파일(bm-capacity.json) — F2 와 같은 꼴.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'bmaudit81-'));
process.env.CONFIG_DIR = DIR;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const DAY = 86_400_000; const HOUR = 3_600_000;
// 기준 시각: 실제 시각에서 정시로 떨어뜨린다(common.md)
const NOW = Math.floor(Date.now() / HOUR) * HOUR;

async function seedLegacy() {
  const { DatabaseSync } = await import('node:sqlite');
  const c = new DatabaseSync(path.join(DIR, 'bm-usage.db'));
  c.exec(`CREATE TABLE usage_history (agent TEXT NOT NULL DEFAULT '', key TEXT NOT NULL, ts INTEGER NOT NULL, name TEXT, vcenter_id TEXT, src TEXT,
      cpu_pct REAL, mem_pct REAL, disk_busy_pct REAL, disk_used_pct REAL, net_pct REAL, net_bps REAL, hba_pct REAL, hba_bps REAL, io_pct REAL, PRIMARY KEY (agent, key, ts));
    CREATE INDEX idx_bmusage_ts ON usage_history(ts);
    CREATE TABLE usage_daily (agent TEXT NOT NULL DEFAULT '', key TEXT NOT NULL, day TEXT NOT NULL, name TEXT, vcenter_id TEXT,
      cpu_sum REAL DEFAULT 0, cpu_n INTEGER DEFAULT 0, cpu_max REAL, mem_sum REAL DEFAULT 0, mem_n INTEGER DEFAULT 0, mem_max REAL,
      disk_busy_max REAL, disk_used_max REAL, net_max REAL, net_bps_max REAL, hba_max REAL, hba_bps_max REAL, io_max REAL,
      samples INTEGER NOT NULL DEFAULT 0, last_ts INTEGER, PRIMARY KEY (agent, key, day));`);
  const ins = c.prepare('INSERT INTO usage_history (agent,key,ts,name,vcenter_id,src,cpu_pct,mem_pct) VALUES (?,?,?,?,?,?,?,?)');
  c.exec('BEGIN');
  const t0 = NOW - 6 * HOUR;
  for (let i = 0; i < 72; i++) ins.run('', 'A', t0 + i * 300_000, 'bm-A', 'vc1', 'os', 10 + (i % 12), 50);
  const d = c.prepare('INSERT INTO usage_daily (agent,key,day,name,vcenter_id,cpu_sum,cpu_n,cpu_max,mem_sum,mem_n,mem_max,samples,last_ts) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const { dayKey } = await import('../src/util/dayKey.js');
  for (let j = 1; j <= 3; j++) d.run('', 'A', dayKey(NOW - j * DAY), 'bm-A', 'vc1', 2880, 288, 20, 14400, 288, 60, 288, NOW - j * DAY);
  c.exec('COMMIT');
  c.close();
}
async function freshDb() {
  const db = await import('../src/bmusage/db.js');
  const mig = await import('../src/bmusage/monthMigrate.js');
  db._resetForTest(); mig._resetMigrateForTest();
  for (const f of fs.readdirSync(DIR)) fs.rmSync(path.join(DIR, f), { recursive: true, force: true });
  return { db, mig };
}

test('F1 삭제 단계에서 실패한 마이그레이션 — 읽기는 대조를 통과한 시간 단위 파일(반쯤 지운 예전 표가 아니다)', async () => {
  const { db, mig } = await freshDb();
  await seedLegacy();
  await db.dbStatus();   // 열기 — copy-raw
  const main = await db.mainDbForMigration();
  // 삭제 단계의 DELETE 를 첫 청크 뒤에 실패하게 한다(디스크 오류 · 잠김 같은 일시 오류의 재현).
  const realPrepare = main.prepare.bind(main);
  let delCalls = 0;
  main.prepare = (sql) => {
    const st = realPrepare(sql);
    if (!/^DELETE FROM usage_history WHERE rowid IN/.test(sql)) return st;
    return { run: (...a) => { delCalls += 1; if (delCalls > 1) throw new Error('disk I/O error'); return st.run(...a); } };
  };
  let r;
  try { r = await mig.runMonthMigration({ chunkRows: 20, now: NOW }); } finally { delete main.prepare; }
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.failedPhase, 'delete');
  const rule = await db.migrationReadRule();
  assert.equal(rule.phase, 'failed');
  // 예전 표는 일부만 남았다(첫 청크 20행을 지웠다)
  const left = realPrepare('SELECT COUNT(*) c FROM usage_history').get().c;
  assert.ok(left > 0 && left < 72, `예전 표 잔여 ${left}`);
  const h = await db.usageHistory('A', { hours: 7 });
  assert.equal(h.rows.length, 72, `원시 이력 72행(파일) — 받은 ${h.rows.length}행`);
  const daily = await db.usageDaily({ key: 'A', days: 5 });
  assert.equal(daily.length, 3, '일 롤업 3일(사본 표)');
  assert.equal(rule.legacyRaw, false, '삭제 단계 실패 — 예전 표는 더 이상 원본이 아니다');
  assert.equal(rule.legacyDaily, false);
  // 다시 시도하면 끝까지 지운다
  const r2 = await mig.runMonthMigration({ chunkRows: 20, now: NOW + 2 * HOUR, hooks: { retryNow: true } });
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal(r2.phase, 'done');
  assert.equal(realPrepare('SELECT COUNT(*) c FROM usage_history').get().c, 0);
});

test('F1 읽기 규칙(순수) — 실패 단계별 원본', async () => {
  const { readRule } = await import('../src/bmusage/db.js');
  for (const fp of ['copy-raw', 'copy-daily', 'verify']) assert.equal(readRule({ phase: 'failed', failedPhase: fp, legacyMaxTs: 1 }).legacyRaw, true, fp);
  assert.equal(readRule({ phase: 'failed', failedPhase: 'delete', rawCopied: true, legacyMaxTs: 1 }).legacyRaw, false);
  assert.equal(readRule({ phase: 'delete', legacyMaxTs: 1 }).legacyRaw, false);
  assert.equal(readRule({ phase: 'copy-raw', legacyMaxTs: 1 }).legacyRaw, true);
});

/** 결과 파일 자리에 디렉터리를 두면 stat 은 되고 읽기만 EISDIR — root 로 도는 시험에서 재현되는 읽기 오류(34회차 F4 와 같은 수단). */
function makeUnreadable(file) { fs.rmSync(file, { recursive: true, force: true }); fs.mkdirSync(file); fs.writeFileSync(path.join(file, 'keep'), 'x'); }
const corruptCopies = (base) => fs.readdirSync(DIR).filter((f) => f.startsWith(`${base}.corrupt.`));

test('F2 저활용 결과 파일 읽기 오류 — 원본을 옮기지 않고 · 다시 계산이 덮지 않는다(손상은 예전처럼 보존)', async () => {
  const I = await import('../src/bmusage/idle.js');
  const file = path.join(DIR, 'bm-idle.json');
  I._resetIdleForTest();
  makeUnreadable(file);
  const cur = I.loadIdle();
  assert.equal(cur?.unreadable, true);
  assert.equal(cur?.readError, true, '읽기 오류 표지');
  assert.ok(fs.statSync(file).isDirectory(), '원본 자리는 그대로(옮기지 않는다)');
  assert.deepEqual(corruptCopies('bm-idle.json'), [], '손상 보존본을 만들지 않는다');
  const r = await I.recomputeIdle({ targets: [{ key: 'K1', name: 'k1', vcenterId: 'vc1' }], force: true, deps: { rules: { idle: {} }, judge: null, powerOf: () => null, activityOf: () => null, monthStore: { readDailyRange: async () => ({ live: [], mig: [] }) } } });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.skipped, 'read-error');
  assert.ok(fs.statSync(file).isDirectory(), '다시 계산이 읽지 못한 원본을 덮지 않는다');
  // 손상(형식 오류)은 예전처럼 보존본으로 옮기고 다음 계산이 새로 만든다
  fs.rmSync(file, { recursive: true, force: true });
  I._resetIdleForTest();
  fs.writeFileSync(file, '{not json');
  const c2 = I.loadIdle();
  assert.equal(c2?.unreadable, true);
  assert.equal(c2?.readError, undefined);
  assert.equal(corruptCopies('bm-idle.json').length, 1, '손상은 보존본으로');
  const r2 = await I.recomputeIdle({ targets: [{ key: 'K1', name: 'k1', vcenterId: 'vc1' }], force: true, deps: { rules: { idle: {} }, judge: null, powerOf: () => null, activityOf: () => null, monthStore: { readDailyRange: async () => ({ live: [], mig: [] }) } } });
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal(I.loadIdle()?.rows?.length, 1);
});

test('F3 용량 예측 결과 파일 읽기 오류 — 원본을 옮기지 않고 · 다시 계산이 덮지 않는다', async () => {
  const C = await import('../src/bmusage/capacity.js');
  const file = path.join(DIR, 'bm-capacity.json');
  C._resetCapacityForTest();
  makeUnreadable(file);
  const cur = C.loadCapacity();
  assert.equal(cur?.unreadable, true);
  assert.equal(cur?.readError, true);
  assert.ok(fs.statSync(file).isDirectory());
  assert.deepEqual(corruptCopies('bm-capacity.json'), []);
  const r = await C.recomputeCapacity({ targets: [], force: true, deps: { rules: {}, judge: null } });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.skipped, 'read-error');
  assert.ok(fs.statSync(file).isDirectory());
  fs.rmSync(file, { recursive: true, force: true });
  C._resetCapacityForTest();
});

test('F2 · F3 화면 문구 — 읽기 오류는 손상 문구(보존 · 다시 만든다)와 다르다', async () => {
  const it = await import('../../web/src/views/tools/bmIdleText.js');
  const ct = await import('../../web/src/views/tools/bmCapacityText.js');
  const a = it.sourceText({ node: 'n1', via: 'local', unreadable: true, readError: true });
  assert.match(a, /읽기 오류/);
  assert.doesNotMatch(a, /손상본 보존/);
  const b = ct.sourceText({ node: 'n1', via: 'local', unreadable: true, readError: true });
  assert.match(b, /읽기 오류/);
  assert.doesNotMatch(b, /다시 만든다/);
});
