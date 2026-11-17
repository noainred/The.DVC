/**
 * rebut83.test.js — 전체 점검 83회차: 80 · 81 · 82회차(베어메탈 사용률 2차) 수정 반증 + 그 회차들이 남긴 결정(권장안) 회귀 시험.
 *
 *  81 F1 반증  일 롤업(usage_daily) 삭제 중 실패 · 시도 소진 — 읽기는 파일 · 보존 정리는 멈추지 않는다 · 재시도가 끝까지 지운다(결함 아님 확인).
 *  81 결정 ⓐ   주 조회 db 진단(행 수 · 파일별 행 · 바이트 · 마이그레이션 센 수)은 전체 범위 계정만 — 범위 계정은 개수 없는 상태(dbStateOnly).
 *  81 결정 ⓑ   엣지 봉투 저활용 · 용량 예측에 상태 파일 readError — 중앙 정제가 통과시키고 화면이 '읽기 오류' 로(손상본 보존이 아니다).
 *  81 결정 ⓒ   저활용 계산이 못 연 1일 연 파일을 버린 부분 창 — unreadPeriods 표지 · 엣지 · 중앙 정제 · 화면 '기간 일부 못 읽음(n)'.
 *  80 F1 반증  물리 디스크(sd*)의 '[none]' 하나는 noSched 가 아니다(권고 유지) — dm-* · md* · NVMe 다중 경로 머리는 예전대로 참고.
 *  80 E1       스냅샷 IO 이름 — awk getline 으로 /proc/<pid>/comm 을 읽지 않는다(셸 grep · 시한 · 붙이기 awk).
 *  80 F2 형제  스냅샷 ps 에 시한(8b S1 'ps 는 전부 timeout') — 멈춘 ps 가 전 구획을 잃게 하지 않는다 · 안 시한 합 + 여유 ≤ exec 시한(진단 30 · 집중 15초).
 *  80 E2       Top-N 후보 io 둘째 읽기가 시한에 끊기면 '권한(p)' 이 아니라 '모름(-)'.
 *  82 결정 ⓐ   사용률 설정 손상 중 저장은 명시 확정(서비스 점검 · 전체 범위 관리자의 confirmDefaults)일 때만 — 그 밖 409.
 *  82 F2 반증  보존 정리 '멈춤' 에 끝이 없어 DB 가 무상한으로 자랐다 → 설정이 허용하는 가장 긴 보존으로만 지운다(되돌릴 수 없는 삭제 없음 · 상한 있음).
 *  82 결정 ⓑ   폴러 주기 전체 상한 — 끝나지 않는 주기가 가드를 영원히 붙잡지 않는다.
 *  82 남긴 것 ② 잘린 '정비 창 뒤 첫 발화' 의 억제 계수 after 를 두 번 세지 않는다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-rebut83-'));
process.env.CONFIG_DIR = DIR;
process.env.BMUSAGE_ALERT_MAX = '1';   // 82 남긴 것 ② — 알림 주기 상한 1건(모듈 로드 때 읽는다)
process.env.DATA_SOURCE = 'live';
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const F = (n) => path.join(DIR, n);
const HOUR = 3_600_000; const DAY = 86_400_000;
// 기준 시각: 실제 시각에서 정시로 떨어뜨린다(common.md)
const NOW = Math.floor(Date.now() / HOUR) * HOUR;
const SRC = (p) => fs.readFileSync(path.join(import.meta.dirname, '../src', p), 'utf8');
const DASH = ['/bin/dash', '/bin/sh'].find((x) => fs.existsSync(x));
const HAS = (bin) => { try { execFileSync('/bin/sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' }); return true; } catch { return false; } };
function fakeBin(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-rebut83-bin-'));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(d, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return d;
}

/* ═════════════ 81 F1 반증 ═════════════ */
async function seedLegacy() {
  const { DatabaseSync } = await import('node:sqlite');
  const c = new DatabaseSync(F('bm-usage.db'));
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
  for (let j = 1; j <= 30; j++) d.run('', 'A', dayKey(NOW - j * DAY), 'bm-A', 'vc1', 2880, 288, 20, 14400, 288, 60, 288, NOW - j * DAY);
  c.exec('COMMIT');
  c.close();
}

test('81 F1 반증 — 일 롤업 삭제 중 실패 · 시도 소진: 읽기는 파일(원시 72 · 일 30) · 보존 정리 안 멈춤 · 재시도로 끝까지', async () => {
  const db = await import('../src/bmusage/db.js');
  const mig = await import('../src/bmusage/monthMigrate.js');
  db._resetForTest(); mig._resetMigrateForTest();
  await seedLegacy();
  await db.dbStatus();   // 열기 — copy-raw
  const main = await db.mainDbForMigration();
  const realPrepare = main.prepare.bind(main);
  let calls = 0;
  // 원시 표는 다 지우고 일 롤업 표 DELETE 의 둘째 청크에서 실패(디스크 오류 흉내)
  main.prepare = (sql) => {
    const st = realPrepare(sql);
    if (!/^DELETE FROM usage_daily WHERE rowid IN/.test(sql)) return st;
    return { run: (...a) => { calls += 1; if (calls > 1) throw new Error('disk I/O error'); return st.run(...a); } };
  };
  let r;
  try { r = await mig.runMonthMigration({ chunkRows: 10, now: NOW }); } finally { delete main.prepare; }
  assert.equal(r.ok, false, JSON.stringify(r)); assert.equal(r.failedPhase, 'delete');
  assert.equal(realPrepare('SELECT COUNT(*) c FROM usage_history').get().c, 0, '원시 표는 다 지웠다');
  const left = realPrepare('SELECT COUNT(*) c FROM usage_daily').get().c;
  assert.ok(left > 0 && left < 30, `일 롤업 표는 일부만(${left})`);
  const read = async () => ({ raw: (await db.usageHistory('A', { hours: 7 })).rows.length, daily: (await db.usageDaily({ key: 'A', days: 40 })).length });
  assert.deepEqual(await read(), { raw: 72, daily: 30 }, '이중 계산 · 누락 없음(파일이 원본)');
  // 보존 정리는 멈추지 않는다(대조는 끝났다) — 예전 조건이면 heldForMigration 'failed'
  const p = await db.pruneUsage({ force: true, rawDays: 90, dailyDays: 3650 });
  assert.equal(p.heldForMigration, undefined, JSON.stringify(p));
  // 시도 소진(3회) 상태에서도 같은 읽기 규칙 — 먼저 한 번 돌려 '재시작 뒤 첫 실행' 의 시도 수 초기화를 지나게 한다(재시도 대기)
  assert.equal((await mig.runMonthMigration({ chunkRows: 10, now: NOW + 10 * 60_000 })).reason, 'retry-wait');
  const st = db.readMeta(main, db.MIGRATE_KEY);
  db.writeMeta(main, db.MIGRATE_KEY, { ...st, attempts: mig.MIGRATE_MAX_ATTEMPTS, failedAt: NOW });
  const w = await mig.runMonthMigration({ chunkRows: 10, now: NOW + 2 * HOUR });
  assert.equal(w.reason, 'attempts-exhausted', JSON.stringify(w));
  assert.equal((await db.migrationReadRule()).legacyRaw, false);
  assert.deepEqual(await read(), { raw: 72, daily: 30 });
  // 재시도 — 남은 행을 지우고 끝난다(읽기는 그대로)
  const r2 = await mig.runMonthMigration({ chunkRows: 10, now: NOW + 7 * HOUR, hooks: { retryNow: true } });
  assert.equal(r2.ok, true, JSON.stringify(r2)); assert.equal(r2.phase, 'done');
  assert.equal(realPrepare('SELECT COUNT(*) c FROM usage_daily').get().c, 0);
  assert.deepEqual(await read(), { raw: 72, daily: 30 });
});

/* ═════════════ 81 결정 ⓐ ═════════════ */
test('81 결정 ⓐ — 범위 계정의 db 진단은 개수 없는 상태만(dbStateOnly) · 주 조회가 isFullReadWriteScope 로 가른다', async () => {
  const { dbStateOnly } = await import('../src/routes/api/bmUsage.js');
  const full = { available: true, path: '/x/bm-usage.db', rawRows: 123456, dailyRows: 999, countsAt: 1, firstTs: 1, lastTs: 2, bytes: 5e9, rawRowsPartial: true, rawUnread: 3,
    legacyRows: { raw: 1, daily: 2 }, files: { raw: { rows: 5, bytes: 9 } }, devRollupMissed: { rows: 4 },
    migration: { phase: 'failed', failedPhase: 'delete', copied: { raw: 100 }, verify: { checked: [{ legacy: 50 }] }, deleted: { raw: 3 } }, migrateError: 'ALTER 실패' };
  const s = dbStateOnly(full);
  assert.deepEqual(s, { available: true, rawRowsPartial: true, migrateError: 'ALTER 실패', migration: { phase: 'failed', failedPhase: 'delete' }, redacted: ['path', 'counts'] });
  assert.doesNotMatch(JSON.stringify(s), /123456|999|5000000000|"rows"|"bytes"|copied|verify/);
  assert.deepEqual(dbStateOnly({ available: false, error: 'x' }), { available: false, error: 'x', migration: null, redacted: ['path', 'counts'] });
  const src = SRC('routes/api/bmUsage.js');
  assert.match(src, /db: !isFullReadWriteScope\(req\.user, store\.get\(\)\) \? dbStateOnly\(db\)/, '주 조회 db 칸 — 전체 범위만 개수');
});

/* ═════════════ 81 결정 ⓑ ═════════════ */
test('81 결정 ⓑ — 엣지 봉투 · 중앙 정제 · 화면: 상태 파일 읽기 오류(readError)를 손상과 가른다', async () => {
  const P = await import('../src/bmusage/poller.js');
  P._setFleetForTest(async () => ({ bareMetal: [], virtualizationHosts: [] }));
  const I = await import('../src/bmusage/idle.js'); const C = await import('../src/bmusage/capacity.js');
  I._resetIdleForTest(); C._resetCapacityForTest();
  for (const f of ['bm-idle.json', 'bm-capacity.json']) { fs.mkdirSync(F(f)); fs.writeFileSync(path.join(F(f), 'keep'), 'x'); }   // stat 은 되고 읽기만 EISDIR
  try {
    const { buildBmUsageEnvelope } = await import('../src/bmusage/edgePull.js');
    const env = await buildBmUsageEnvelope();
    assert.deepEqual(env.idle, { unreadable: true, readError: true, rows: [] }, JSON.stringify(env.idle));
    assert.deepEqual(env.capacity, { unreadable: true, readError: true, rows: [] }, JSON.stringify(env.capacity));
    const { sanitizeIdleEnvelope } = await import('../src/central/bmIdleSanitize.js');
    const { sanitizeCapacityEnvelope } = await import('../src/central/bmMaintCapSanitize.js');
    assert.equal(sanitizeIdleEnvelope(env.idle).readError, true);
    assert.equal(sanitizeCapacityEnvelope(env.capacity).readError, true);
    assert.equal(sanitizeIdleEnvelope({ unreadable: true, readError: 'yes' }).readError, undefined, '불리언만');
    assert.equal(sanitizeIdleEnvelope({ unreadable: true }).readError, undefined, '손상은 예전 모양');
    // 라우트 출처 줄 · 화면 문구
    assert.match(SRC('routes/api/bmIdle.js'), /via: 'edge'[^\n]*\.\.\.\(id\?\.readError \? \{ readError: true \} : \{\}\)/);
    assert.match(SRC('routes/api/bmCapacity.js'), /via: 'edge'[^\n]*\.\.\.\(cap\?\.readError \? \{ readError: true \} : \{\}\)/);
    const it = await import('../../web/src/views/tools/bmIdleText.js');
    assert.doesNotMatch(it.sourceText({ node: 'edge-a', via: 'edge', unreadable: true, readError: true }), /손상본 보존/);
  } finally {
    for (const f of ['bm-idle.json', 'bm-capacity.json']) fs.rmSync(F(f), { recursive: true, force: true });
    I._resetIdleForTest(); C._resetCapacityForTest(); P._setFleetForTest(null);
  }
});

/* ═════════════ 81 결정 ⓒ ═════════════ */
test('81 결정 ⓒ — 저활용 부분 창: 못 연 1일 연 파일 · 조회 실패를 unreadPeriods 로 센다(none 은 정상) · 엣지 · 중앙 · 화면', async () => {
  const I = await import('../src/bmusage/idle.js');
  const { dayKey } = await import('../src/util/dayKey.js');
  const live = Array.from({ length: 25 }, (_, i) => ({ agent: '', key: 'K', day: dayKey(NOW - (i + 1) * DAY), cpu_sum: 100, cpu_n: 100, cpu_max: 2, mem_sum: 1000, mem_n: 100, disk_busy_max: 1, net_max: 1, samples: 100 }));
  const mk = (mp, fail = false) => ({ readDailyRange: async () => { if (fail) throw new Error('열기 실패'); return { live, mig: [], missingPeriods: mp }; } });
  const run = (ms) => I.computeIdleServer({ agent: '', target: { key: 'K', name: 'k' }, now: NOW, cfg: {}, deps: { monthStore: ms } });
  assert.equal((await run(mk([{ period: '2025', reason: 'SQLITE_CORRUPT' }, { period: '2024', reason: 'none' }]))).unreadPeriods, 1);
  assert.equal('unreadPeriods' in (await run(mk([{ period: '2024', reason: 'none' }]))), false, '파일이 없을 뿐(none)은 표지 없음');
  const failed = await run(mk([], true));
  assert.equal(failed.unreadPeriods, 1, '조회 자체 실패도 센다');
  assert.equal(failed.status, 'excluded', '데이터 부족으로 빠지지만 표지가 붙는다');
  const { sanitizeIdleRow } = await import('../src/central/bmIdleSanitize.js');
  const row = await run(mk([{ period: '2025', reason: 'x' }]));
  assert.equal(sanitizeIdleRow(row, new Set(['K'])).unreadPeriods, 1);
  assert.equal(sanitizeIdleRow({ ...row, unreadPeriods: '2x' }, new Set(['K'])).unreadPeriods, undefined);
  assert.match(SRC('bmusage/edgePull.js'), /const IDLE_FIELDS = \[[^\]]*'unreadPeriods'\]/);
  const it = await import('../../web/src/views/tools/bmIdleText.js');
  assert.match(it.statusText({ status: 'excluded', reason: 'insufficient', days: 4, unreadPeriods: 2 }), /데이터 부족\(4일\) · 기간 일부 못 읽음\(2\)$/);
  assert.doesNotMatch(it.statusText({ status: 'candidate' }), /못 읽음/);
});

/* ═════════════ 80 F1 반증 ═════════════ */
test('80 F1 반증 — 물리 디스크(sd* · vd*)의 none 하나는 권고 유지 · dm-* · md* · NVMe 다중 경로 머리는 참고(noSched)', async () => {
  const { judgeTuning, noSchedChoice } = await import('../src/bmusage/tuning/judge.js');
  const { parseBlkq } = await import('../src/bmusage/parse/linuxProc.js');
  assert.equal(noSchedChoice({ name: 'sda', schedulers: ['none'] }), false);
  assert.equal(noSchedChoice({ name: 'vdb', schedulers: ['none'] }), false);
  assert.equal(noSchedChoice({ name: 'dm-0', schedulers: ['none'] }), true);
  assert.equal(noSchedChoice({ name: 'md127', schedulers: ['none'] }), true);
  assert.equal(noSchedChoice({ name: 'nvme0n1', schedulers: ['none'] }), true, 'NVMe 다중 경로 머리(bio 기반)');
  // mq-deadline 이 모듈이고 올라오지 않은 커널의 HDD — '[none]' 하나 → 권고(예전 80회차 판정은 참고로 숨겼다)
  const blkq = parseBlkq(['/sys/block/sda/queue/scheduler:[none]', '/sys/block/sda/queue/rotational:1', '/sys/block/dm-0/queue/scheduler:none', '/sys/block/dm-0/queue/rotational:1']);
  const it = judgeTuning({ tuning: { blkq, sections: { blkq: 'ok' }, sysctl: {} } }).items.find((x) => x.id === 'disk.hddSched');
  assert.equal(it.status, 'advise', JSON.stringify(it.devices));
  assert.equal(it.devices.find((d) => d.name === 'sda').status, 'advise');
  assert.equal(it.devices.find((d) => d.name === 'dm-0').reason, 'noSched');
});

/* ═════════════ 80 E1 · F2 형제 · 산수 ═════════════ */
test('80 E1 — 스냅샷 IO 이름: awk getline 없음 · 셸이 고른 pid 의 comm 을 시한 안에 읽어 붙인다(개행 든 comm 은 첫 줄 · 못 읽으면 ?)', async (t) => {
  const SNAP = await import('../src/bmusage/snapshot/command.js');
  for (const cmd of [SNAP.SNAPSHOT_COMMAND, SNAP.FOCUS_SNAPSHOT_COMMAND]) {
    assert.doesNotMatch(cmd, /getline/);
    assert.match(cmd, new RegExp(`timeout ${SNAP.SNAPSHOT_COMM_TIMEOUT_S} grep -s -H --line-buffered '' \\$\\(for _p in \\$_sp; do printf '/proc/%s/comm '`));
  }
  if (!HAS('awk')) return t.skip('awk 없음');
  const m = /\| (awk '\$1 == "N"[\s\S]*?\} \}') \| cut -c1-120/.exec(SNAP.SNAPSHOT_COMMAND);
  assert.ok(m, '붙이기 awk 조각');
  const input = ['readable=3', 'span=2', 'io 7 4096 0 ?', 'io 8 100 5 ?', 'io 9 1 1 ?', 'N /proc/7/comm:kworker/0:1H', 'N /proc/7/comm:둘째 줄', 'N /proc/9/comm:a\u0007b', ''].join('\n');
  for (const awk of ['awk', ...(HAS('mawk') ? ['mawk'] : [])]) {
    const out = spawnSync('/bin/sh', ['-c', m[1].replace(/^awk /, `${awk} `)], { input, encoding: 'utf8' }).stdout;
    assert.match(out, /^io 7 4096 0 kworker\/0:1H$/m, `${awk}: 이름(‘/’ · ‘:’ 포함)`);
    assert.match(out, /^io 8 100 5 \?$/m, `${awk}: 못 읽은 pid 는 ?`);
    assert.match(out, /^io 9 1 1 a\?b$/m, `${awk}: 제어 문자는 ?`);
    assert.match(out, /^readable=3$/m); assert.match(out, /^span=2$/m);
    const r = SNAP.parseSnapshot(`##PSCPU\n##IO\n${out}##END\n`, { topN: 5 });
    assert.deepEqual(r.ioTop.map((x) => x.name), ['kworker/0:1H', '?', 'a?b']);
  }
  // 실제 셸 — io 줄의 이름이 그 pid 의 comm 과 같다(살아 있는 pid 만 대조)
  if (!DASH) return;
  const out = execFileSync(DASH, ['-c', SNAP.FOCUS_SNAPSHOT_COMMAND], { encoding: 'utf8', timeout: 20_000, maxBuffer: 8 << 20 });
  const r = SNAP.parseSnapshot(out, { topN: 5 });
  assert.equal(r.truncated, false);
  for (const x of r.ioTop) {
    let comm = null; try { comm = fs.readFileSync(`/proc/${x.pid}/comm`, 'utf8').split('\n')[0]; } catch { continue; }
    assert.ok(x.name === '?' || x.name === comm.replace(/[^ -~]/g, '?').slice(0, 32), `pid ${x.pid}: ${x.name} ≠ ${comm}`);
  }
});

/** 명령 문자열의 timeout · sleep 합(초) — bmTop8bBudget worstOf 와 같은 셈. */
function waitsSum(cmd) {
  const t = [...String(cmd).matchAll(/\btimeout\s+(\d+(?:\.\d+)?)s?\s+\S+/g)].map((m) => Number(m[1]));
  const s = [...String(cmd).matchAll(/\bsleep\s+(\d+(?:\.\d+)?)\b/g)].map((m) => Number(m[1]));
  return [...t, ...s].reduce((a, b) => a + b, 0);
}
test('80 F2 형제 — 스냅샷 ps 는 시한 안(8b S1) · 멈춘 ps 가 io · ss · 커널 로그 구획을 잃게 하지 않는다 · 안 시한 합 + 여유 5초 ≤ exec 시한', async (t) => {
  const SNAP = await import('../src/bmusage/snapshot/command.js');
  const RUN = await import('../src/bmusage/snapshot/run.js');
  for (const cmd of [SNAP.SNAPSHOT_COMMAND, SNAP.FOCUS_SNAPSHOT_COMMAND]) {
    const ps = [...cmd.matchAll(/(\S+ \S+ )?ps -e /g)];
    assert.ok(ps.length >= 1);
    for (const m of ps) assert.equal(m[1], `timeout ${SNAP.SNAPSHOT_PS_TIMEOUT_S} `, '시한 없는 ps');
  }
  assert.ok(waitsSum(SNAP.SNAPSHOT_COMMAND) * 1000 + 5_000 <= RUN.SNAPSHOT_CMD_MS, `진단 ${waitsSum(SNAP.SNAPSHOT_COMMAND)}초`);
  const fr = SRC('bmusage/focus/run.js');
  const snapTmo = Number(/name: 'snap', cmd: FOCUS_SNAPSHOT_COMMAND, timeoutMs: (\d[\d_]*)/.exec(fr)?.[1]?.replace(/_/g, ''));
  assert.ok(waitsSum(SNAP.FOCUS_SNAPSHOT_COMMAND) * 1000 + 5_000 <= snapTmo, `집중 ${waitsSum(SNAP.FOCUS_SNAPSHOT_COMMAND)}초 + 5 ≤ ${snapTmo / 1000}`);
  if (!DASH || !HAS('timeout')) return t.skip('dash · timeout 없음');
  const bin = fakeBin({ ps: 'exec sleep 60' });   // ps 가 대상 프로세스의 /proc 읽기에서 멈춤 흉내
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const t0 = Date.now();
  const out = execFileSync(DASH, ['-c', SNAP.SNAPSHOT_COMMAND], { encoding: 'utf8', timeout: 25_000, env, maxBuffer: 8 << 20 });
  assert.ok(Date.now() - t0 < RUN.SNAPSHOT_CMD_MS - 5_000, `시한 안(${Date.now() - t0}ms)`);
  const r = SNAP.parseSnapshot(out, { topN: 5, dmesgLines: 5 });
  assert.equal(r.truncated, false, '##END 도착');
  assert.equal(r.states.cpu, 'absent'); assert.notEqual(r.states.io, 'missing'); assert.equal(r.states.ss === 'missing', false);
  // 예전 명령(시한 없는 ps)은 끝나지 않는다
  const OLD = SNAP.SNAPSHOT_COMMAND.split(`timeout ${SNAP.SNAPSHOT_PS_TIMEOUT_S} ps -e `).join('ps -e ');
  assert.notEqual(OLD, SNAP.SNAPSHOT_COMMAND);
  const old = spawnSync(DASH, ['-c', OLD], { encoding: 'utf8', timeout: 8_000, env, killSignal: 'SIGKILL' });
  assert.ok(old.error?.code === 'ETIMEDOUT' || old.signal === 'SIGKILL', '예전 명령은 8초 안에 끝나지 않았다');
});

/* ═════════════ 80 E2 ═════════════ */
test('80 E2 — Top-N 후보 io 둘째 읽기가 시한에 끊기면 권한(p) 이 아니라 모름(-) — ioPerm 0 · ioUnknown 으로', async (t) => {
  const T = await import('../src/bmusage/parse/linuxTop.js');
  if (!DASH || !HAS('timeout')) return t.skip('dash · timeout 없음');
  const realGrep = execFileSync('/bin/sh', ['-c', 'command -v grep'], { encoding: 'utf8' }).trim();
  const mark = path.join(DIR, 'io-mark');
  // 첫 io 읽기(전 프로세스)는 진짜 · 후보 io 둘째 읽기만 멈춘다(커널 exec 잠금 대기 흉내)
  const bin = fakeBin({ grep: `case "$*" in *"/io"*) if [ -f '${mark}' ]; then exec sleep 60; fi; : > '${mark}';; esac; exec ${realGrep} "$@"` });
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const run = (cmd) => { fs.rmSync(mark, { force: true }); return T.readTopOutput(spawnSync(DASH, ['-c', cmd], { encoding: 'utf8', timeout: 30_000, env }).stdout).value; };
  const cmd = T.topCommand({ forceProc: true });
  const v = run(cmd);
  assert.ok(v && v.candidates > 0, `후보가 있다(${v?.candidates})`);
  assert.equal(v.ioPerm, 0, '시한에 끊긴 것을 권한으로 세지 않는다');
  assert.ok(v.ioUnknown > 0, `모름으로 센다(${v.ioUnknown})`);
  // 변이 — 끝 상태(JX)를 넘기지 않던 예전 명령이면 권한으로 보였다
  const OLD = cmd.replace(/\{ (timeout \d+ grep -H --line-buffered -E '\^\(read\|write\)_bytes:' [\s\S]*?2>\/dev\/null); echo "JX \$\?"; \}/, '$1');
  assert.notEqual(OLD, cmd);
  const vo = run(OLD);
  assert.ok(vo.ioPerm > 0, `예전: 권한 ${vo.ioPerm}`);
  const TT = await import('../../web/src/views/tools/bmTopText.js');
  assert.match(TT.sampleNotes({ ok: true, sample: { ts: 1, src: 'proc', ioUnknown: 3 } }).join(' '), /I\/O 값을 내지 못한 후보 3개 — 권한 문제가 아니라/);
});

/* ═════════════ 82 결정 ⓐ ═════════════ */
test('82 결정 ⓐ — 사용률 설정 손상 중 저장은 명시 확정일 때만(그 밖 409 · 파일 · 손상 표지 그대로) · 서비스 점검 확정은 된다', async () => {
  const S = await import('../src/bmusage/settings.js');
  fs.writeFileSync(F('bmusage-settings.json'), '{ corrupt');
  S._resetForTest();
  assert.ok(S.bmUsageLocalLoadError(), '손상 — 보존본으로 옮겼다');
  assert.throws(() => S.saveBmUsageSettings({ corps: { vcA: true } }), (e) => e.code === 'settings-unreadable' && e.status === 409 && e.corrupt === true);
  assert.equal(fs.existsSync(F('bmusage-settings.json')), false, '저장하지 않았다(기본값 전역 필드 파일이 생기지 않는다)');
  assert.ok(S.bmUsageLocalLoadError(), '손상 표지 그대로(보존 정리 멈춤도 그대로)');
  // 라우트: 전체 범위(조회 ∧ 쓰기) + confirmDefaults 일 때만 확정 저장
  assert.match(SRC('routes/api/bmUsage.js'), /const confirmLoadError = fullRw && req\.body\?\.confirmDefaults === true;[\s\S]{0,200}saveBmUsageSettings\(body, \{ confirmLoadError \}\)/);
  // 서비스 점검 '기본값으로 확정'(등록된 confirm)
  const util = await import('../src/util/settingsLoadError.js');
  const c = util.confirmSettingsDefault('bmusage-settings.json');
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.equal(S.bmUsageLocalLoadError(), null);
  assert.doesNotThrow(() => S.saveBmUsageSettings({ corps: { vcA: true } }), '정상 파일은 예전처럼 저장');
  for (const f of fs.readdirSync(DIR).filter((n) => n.startsWith('bmusage-settings.json.corrupt.'))) fs.rmSync(F(f));
  fs.rmSync(F('bmusage-settings.json'), { force: true }); S._resetForTest();
});

/* ═════════════ 82 F2 반증 ═════════════ */
test('82 F2 반증 — 설정 파일을 못 읽은 동안 보존 정리는 설정 상한(가장 긴 보존)으로만: 상한 밖은 지우고(무상한 증가 없음) 기본값 밖 · 상한 안은 남긴다', async () => {
  const P = await import('../src/bmusage/poller.js');
  const S = await import('../src/bmusage/settings.js');
  const R = await import('../src/bmusage/perfRules.js');
  const O = await import('../src/bmusage/opsDb.js');
  const month = await import('../src/bmusage/monthStore.js');
  const db = await import('../src/bmusage/db.js');
  const rawAt = (d) => NOW - d * DAY;
  const w = await month.writeServerRows([{ key: 'PR', ts: rawAt(420), cpu_pct: 1 }, { key: 'PR', ts: rawAt(100), cpu_pct: 2 }], '');
  assert.equal(w.ok, true, JSON.stringify(w.errors));
  await O.changeWriteBatch({ agent: '', items: [{ key: 'PR', at: NOW, facts: {}, events: [{ ts: rawAt(450), kind: 'pkg', item: 'k1', before: 'a', after: 'b' }, { ts: rawAt(100), kind: 'pkg', item: 'k2', before: 'a', after: 'b' }] }] });
  // 파일 상한(한 번에 여는 월 파일 수)에 걸리지 않게 구간을 둘로 나눠 읽는다
  const rawDays = async () => { const out = []; for (const d of [420, 100]) { const x = await db.rawRangeMerged({ key: 'PR', agent: '', from: rawAt(d + 2), to: rawAt(d - 2) }); for (const r0 of x.rows) out.push(Math.round((NOW - r0.ts) / DAY)); } return out; };
  assert.deepEqual(await rawDays(), [420, 100], '시험 전제 — 두 행이 들어갔다');
  fs.writeFileSync(F('bmusage-settings.json'), '{ corrupt'); S._resetForTest();
  fs.writeFileSync(F('bm-perf-rules.json'), '{ corrupt'); R._resetPerfRulesForTest();
  const r = await P.pruneTick({ every: 1 });
  assert.deepEqual(r.held, ['settings', 'perf-rules']); assert.equal(r.heldMax, true);
  assert.deepEqual(await rawDays(), [100], `원시: 상한(${S.RETENTION_MAX.raw}일) 밖 420일은 지우고 기본값(30일) 밖 100일은 남긴다`);
  const ev = await O.changeEventsRange({ key: 'PR', agent: '', from: rawAt(500), to: NOW });
  assert.deepEqual((ev?.rows || ev || []).map((x) => x.item).sort(), ['k2'], '변경 이벤트: 상한(400일) 밖 450일만 지움 · 기본(30일) 밖 100일은 남김');
  assert.equal(S.RETENTION_MAX.raw, 365); assert.equal(S.RETENTION_MAX.d1, 3650); assert.equal(S.RETENTION_MAX.h1, 730);
  const T = await import('../../web/src/views/tools/bmUsageText.js');
  assert.match(T.lastPruneNote({ at: NOW, ok: true, held: ['settings'], heldMax: true }, NOW), /가장 긴 보존보다 오래된 것만 지웁니다/);
  for (const f of fs.readdirSync(DIR).filter((n) => /^(bmusage-settings|bm-perf-rules)\.json\.corrupt\./.test(n))) fs.rmSync(F(f));
  fs.rmSync(F('bmusage-settings.json'), { force: true }); fs.rmSync(F('bm-perf-rules.json'), { force: true });
  S._resetForTest(); R._resetPerfRulesForTest();
});

/* ═════════════ 82 결정 ⓑ ═════════════ */
test('82 결정 ⓑ — 폴러 주기 상한: 끝나지 않는 주기는 상한 안에서는 가드 · 넘기면 버리고 새 주기(늦게 끝난 옛 주기는 새 가드를 풀지 않는다)', async () => {
  const P = await import('../src/bmusage/poller.js');
  process.env.BMUSAGE_ENABLED = 'true';
  try {
    assert.equal(P.bmCycleMaxMs(300_000, ''), 15 * 60_000);
    assert.equal(P.bmCycleMaxMs(600_000, ''), 30 * 60_000);
    assert.equal(P.bmCycleMaxMs(300_000, '1000'), 60_000, '하한 60초');
    P._resetForTest();
    let release; const hang = new Promise((res) => { release = res; });
    P._setFleetForTest(async () => { await hang; return { bareMetal: [], virtualizationHosts: [] }; });
    const stuck = P.pollBmUsageOnce({ trigger: 'manual' });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await P.pollBmUsageOnce({ trigger: 'manual' })).reason, '이전 수집이 진행 중입니다.');
    assert.equal(P.bmUsageStatus().running, true);
    assert.ok(P.bmUsageStatus().runningForMs >= 0);
    P._ageCycleForTest(P.bmCycleMaxMs(P.bmUsageStatus().intervalMs) + 1);
    P._setFleetForTest(async () => ({ bareMetal: [], virtualizationHosts: [] }));
    const fresh = await P.pollBmUsageOnce({ trigger: 'manual' });
    assert.equal(fresh.ok, true, JSON.stringify(fresh));
    assert.equal(P.bmUsageStatus().stuckReleases, 1);
    assert.equal(P.bmUsageStatus().running, false);
    // 새 주기가 진행 중일 때 옛 주기가 늦게 끝나도 새 가드를 풀지 않는다
    let release2; const hang2 = new Promise((res) => { release2 = res; });
    P._setFleetForTest(async () => { await hang2; return { bareMetal: [], virtualizationHosts: [] }; });
    const cur = P.pollBmUsageOnce({ trigger: 'manual' });
    await new Promise((r) => setTimeout(r, 50));
    release(); await stuck;
    assert.equal(P.bmUsageStatus().running, true, '옛 주기의 finally 가 새 주기 가드를 풀지 않았다');
    release2(); await cur;
    assert.equal(P.bmUsageStatus().running, false);
  } finally { delete process.env.BMUSAGE_ENABLED; P._setFleetForTest(null); P._resetForTest(); }
});

/* ═════════════ 82 남긴 것 ② ═════════════ */
test('82 남긴 것 ② — 주기 상한에 잘린 정비 창 뒤 첫 발화는 억제 계수 after 를 보낸 주기에 한 번만 센다', async () => {
  const N = await import('../src/bmusage/notify.js');
  const R = await import('../src/bmusage/maint/runtime.js');
  assert.equal(N.MAX_SEND, 1);
  N._resetAlertStateForTest(); R._resetMaintRuntimeForTest();
  const win = { scopes: { alerts: true }, windows: [{ id: 'w83', scopes: ['alerts'] }], until: { alerts: NOW + HOUR } };
  const base = { alertEnabled: true, alertPct: 90, alertSustainMin: 0, alertRepeatHours: 6, intervalMs: 300_000, runMs: 0 };
  const rows = [{ key: 'm1', cpu_pct: 95 }, { key: 'm2', cpu_pct: 96 }];
  await N.runBmUsageAlerts(rows, { ...base, maintJudge: { stateFor: () => win } });   // 창 안 — 둘 다 보류
  await N._drainBmUsageAlertsForTest();
  const after = () => R.maintStats().byWindow.w83?.after ?? 0;
  assert.equal(after(), 0);
  const r2 = await N.runBmUsageAlerts(rows, { ...base, maintJudge: { stateFor: () => null } });   // 창 뒤 — 둘 다 ‘창 안부터 초과’ · 하나만 보냄
  await N._drainBmUsageAlertsForTest();
  assert.equal(r2.queued, 1); assert.equal(r2.capped, 1);
  assert.equal(after(), 1, '보낸 것만 센다(예전: 잘린 것까지 2)');
  const r3 = await N.runBmUsageAlerts(rows, { ...base, maintJudge: { stateFor: () => null } });   // 잘렸던 것이 이번에 나간다
  await N._drainBmUsageAlertsForTest();
  assert.equal(r3.queued, 1);
  assert.equal(after(), 2, '두 서버 — 두 번(예전: 3)');
});
