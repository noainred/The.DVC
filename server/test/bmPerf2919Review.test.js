/**
 * v2.919 리눅스 성능 1단계 — **반증 검토(review-s1) 반영분** 회귀 고정. D1~D6 · D8.
 *
 *  D1 출력 잘림 — 숫자 중간에서 잘린 마지막 구획은 통째로 버린다(missing · _prev 에 넣지 않는다) · 기존 구획 줄 상한 · 바이트 산수 ·
 *     예전(f794b98) 범위의 다섯 지표가 큰 출력(1MiB 초과)에서도 살아남는다
 *  D2 엣지 봉투 바이트 상한 — 장치 32개 × 2,000대 합성에서 상한 안으로 · 다섯 지표 행은 언제나 남는다 · perfTruncated 표지가 중앙 정제를 통과
 *  D3 엣지 시각은 수신 시각으로 자른다(2100년) · 원본은 edgeTsRaw
 *  D4 30일 전 행·인벤토리는 ‘정상/주의’ 로 판정하지 않는다(stale)
 *  D5 읽은 칸이 기준 비율 미만이면 ‘정상’ 대신 ‘대부분 못 읽음’ · 판정 한 줄은 읽은 칸 수를 늘 말한다
 *  D6 ALTER 실패를 삼키지 않는다 — 실패 목록·실제 열만 적재(기존 지표는 계속)·migrateError 가 결과·상태에 오른다
 *  D8 명령 앞 LC_ALL=C
 * 표본은 커널 문서 형식이다(실장비 출력 아님 — 정직 기록).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CFG = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bmperf2919r-'));
const PREV = process.env.CONFIG_DIR;
process.env.CONFIG_DIR = CFG;
test.after(() => {
  if (PREV === undefined) delete process.env.CONFIG_DIR; else process.env.CONFIG_DIR = PREV;
  fs.rmSync(CFG, { recursive: true, force: true });
});

const O = await import('../src/bmusage/collectors/osSsh.js');
const U = await import('../src/bmusage/usage.js');
const J = await import('../src/bmusage/useJudge.js');
const HW = await import('../src/bmusage/hwFacts.js');
const PV = await import('../src/bmusage/perfView.js');
const S = await import('../src/bmusage/settings.js');
const C = await import('../src/central/bmUsageEdgePull.js');
const E = await import('../src/bmusage/edgePull.js');
const { EXEC_MAX_OUTPUT } = await import('../src/proxy/sshExec.js');
const { PERF_COL_NAMES } = await import('../src/bmusage/perfCols.js');
const CORP = await import('../src/routes/api/corpUsage.js');

/** 표본 — DISK 줄 수를 늘릴 수 있다(멀티패스 서버 흉내). */
// 커널 5.5+ 20칸 · 현실적인 누적값 자릿수(줄 약 150B — 반증의 멀티패스 추정과 같은 크기).
const diskLine = (i, ticks = 2500) => ` 8 ${i} sd${String.fromCharCode(97 + (i % 26))}${Math.floor(i / 26)} 1234567890 12345678 98765432100 123456789 2345678901 23456789 87654321000 234567890 0 ${ticks} 3456789012 0 0 0 0 1234567 7654321`;
const sample = ({ disks = 2, ticks = 2500, end = true } = {}) => [
  '##STAT', 'ctxt 100', 'procs_running 2', 'procs_blocked 0', 'cpu  1000 0 500 8000 200 0 0 0 0 0', 'cpu0 1000 0 500 8000 200 0 0 0 0 0',
  '##MEM', 'MemTotal: 1000 kB', 'MemAvailable: 500 kB',
  '##DISK', ...Array.from({ length: disks }, (_, i) => diskLine(i, ticks)),
  '##NET', 'Inter-|   Receive', ' face |bytes', '  eth0: 1000 10 0 0 0 0 0 0 2000 20 0 0 0 0 0 0', '  eth1: 5000 10 0 0 0 0 0 0 7000 20 0 0 0 0 0 0',
  '##NETINFO', 'eth0 10000 up 1', 'eth1 10000 up 1',
  '##FC', '##TICK', '100',
  '##DF', 'Filesystem 1024-blocks Used Available Capacity Mounted on', '/dev/sda1 1000 600 400 60% /',
  '##HOST', 'Linux bm1 5.14.0',
  '##LOAD', '0.5 0.5 0.5 1/100 1',
  '##PSI', '##VMSTAT', 'pswpin 0', '##SNMP', '##BLKQ', '##SYSCTL', '##IRQ', '##DFI',
  ...(end ? ['##END'] : []),
].join('\n');

/* ── D1 ─────────────────────────────────────────────────────────────── */
test('D1 DISK 중간 절단 — 잘린 숫자를 카운터로 쓰지 않는다: DISK·뒤 구획 missing · 디스크 카운터는 빈 목록(_prev 에 안 들어감) · 가짜 100% 없음', () => {
  const full = sample({ ticks: 149360 });
  const at = full.indexOf(' 149360 ', full.indexOf('##DISK'));
  const cut = full.slice(0, at + 3);   // '14' 까지 — 반증 재현(io_ticks 149360 → 14)
  const r = O.shapeLinux(cut, ['/']);
  assert.equal(r.truncated, true);
  assert.deepEqual(r.cutSections, ['DISK']);
  assert.ok(r.read.includes('cpu') && r.read.includes('mem'), '잘리기 전 구획은 남는다');
  assert.ok(r.missing.includes('diskio') && r.missing.includes('net'), r.missing.join(','));
  assert.deepEqual(r.counters.disks, [], '잘린 구획의 카운터를 들고 가지 않는다');
  // 다음 주기가 온전하게 오면 — 직전 표본에 디스크가 없으므로 그 주기 busy 는 null(첫 표본)이지 Δ(149360−14)로 부푼 100% 가 아니다.
  const prev = U.buildUsage({ target: { key: 'K' }, os: { ...r, ok: true }, now: 1_000_000 });
  assert.deepEqual(prev.next.counters.disks, []);
  const nextOs = { ...O.shapeLinux(sample({ ticks: 149360 }), ['/']), ok: true };
  const b = U.buildUsage({ target: { key: 'K' }, os: nextOs, prev: prev.next, now: 1_300_000 });
  assert.equal(b.row.disk_busy_pct, null, '가짜 100% 가 원시·일 롤업에 남지 않는다');
  assert.ok(prev.notes.some((x) => x.includes('잘려') && x.includes('DISK')), '잘린 구획을 노트가 말한다');
});

test('D1 NET 중간 절단 — NET 은 missing, 앞의 DISK 는 온전히 읽는다', () => {
  const full = sample();
  const at = full.indexOf('eth1: 50', full.indexOf('##NET'));
  const r = O.shapeLinux(full.slice(0, at + 8), ['/']);
  assert.deepEqual(r.cutSections, ['NET']);
  assert.ok(r.read.includes('diskio'));
  assert.ok(r.missing.includes('net'));
  assert.deepEqual(r.counters.nets, []);
});

test('D1 예전(f794b98) 범위 다섯 지표 — 1MiB 를 넘는 큰 출력(디스크 9,000줄)에서도 전부 살아남고 상한에 닿지 않는다', () => {
  const big = sample({ disks: 9_000 });
  assert.ok(big.length > 1_048_576, `표본이 1MiB 를 넘어야 한다(${big.length})`);
  assert.ok(big.length < O.OUTPUT_MAX_BYTES, '전체 바이트 상한에 닿지 않는다');
  const r = O.shapeLinux(big, ['/']);
  assert.equal(r.truncated, false); assert.deepEqual(r.linesCapped, []);
  for (const k of ['cpu', 'mem', 'diskio', 'net', 'diskspace']) assert.ok(r.read.includes(k), k);
  assert.equal(r.counters.disks.length, 9_000);
  const a = U.buildUsage({ target: { key: 'K' }, os: { ...r, ok: true }, now: 1_000_000 });
  const r2 = O.shapeLinux(sample({ disks: 9_000, ticks: 2_600 }).replace('cpu  1000 0 500 8000', 'cpu  1100 0 500 8000').replace('eth0: 1000', 'eth0: 3000'), ['/']);
  const b = U.buildUsage({ target: { key: 'K' }, os: { ...r2, ok: true }, prev: a.next, now: 1_300_000 });
  for (const c of ['cpu_pct', 'mem_pct', 'disk_busy_pct', 'disk_used_pct', 'net_bps']) assert.notEqual(b.row[c], null, c);
});

test('D1 기존 구획 줄 상한 — 상한+1 줄이 오면 앞 상한 줄만 쓰고 그 구획을 ‘상한 도달’ 로 밝힌다(값은 온전한 줄뿐)', () => {
  const r = O.shapeLinux(sample({ disks: O.SECTION_LINE_CAP.DISK + 1 }), ['/']);
  assert.deepEqual(r.linesCapped, ['DISK']);
  assert.equal(r.counters.disks.length, O.SECTION_LINE_CAP.DISK);
  const b = U.buildPerf({ os: { ...r, ok: true }, now: 1, lim: 3_600_000 });
  assert.ok(b.notes.some((x) => x.includes('줄 상한')));
  assert.deepEqual(b.detail.linesCapped, ['DISK']);
});

test('D1 바이트 산수 — 구획 상한 × 줄 최대(가정)의 합 < 전체 상한 < sshExec 실제 상한 · 기존 구획에도 head -n(상한+1)', () => {
  assert.ok(O.SECTION_BYTES_SUM < O.OUTPUT_MAX_BYTES, `${O.SECTION_BYTES_SUM} < ${O.OUTPUT_MAX_BYTES}`);
  assert.ok(O.OUTPUT_MAX_BYTES < EXEC_MAX_OUTPUT, 'sshExec 가 결과를 통째로 버리기 전에 우리가 먼저 자른다(실제 export 값과 비교)');
  const cmd = O.linuxCommand(['/']);
  for (const [k, file] of [['MEM', '/proc/meminfo'], ['DISK', '/proc/diskstats'], ['NET', '/proc/net/dev']]) {
    assert.ok(cmd.includes(`head -n ${O.SECTION_LINE_CAP[k] + 1} ${file}`), k);
  }
  assert.ok(cmd.includes(`head -n ${O.SECTION_LINE_CAP.NETINFO + 1} | cut -c1-128`), 'NETINFO');
  assert.ok(!cmd.includes('cat /proc/diskstats'), 'DISK 는 상한 없이 읽지 않는다');
  assert.ok(cmd.endsWith(`| head -c ${O.OUTPUT_MAX_BYTES}`));
});

/* ── D8 ─────────────────────────────────────────────────────────────── */
test('D8 명령 전체를 C 로캘로 — 한국어 로캘의 번역된 df 머리글이 ##DF·##DFI 에 섞이지 않게', () => {
  assert.ok(O.linuxCommand(['/']).startsWith('export LC_ALL=C; { '));
});

/* ── D2 ─────────────────────────────────────────────────────────────── */
test('D2 엣지 봉투 — 장치 32개 × 2,000대 합성: 상한 안으로 줄이고(성능 상세부터) 다섯 지표 행·대상은 전부 남기며 표지가 중앙 정제를 통과한다', () => {
  const now = 100 * 3_600_000;
  const det = { v: 1, osKind: 'linux', sections: { psi: 'ok' }, streak: {},
    disks: Array.from({ length: 32 }, (_, i) => ({ name: `sd${i}`, busyPct: 50, iops: 100, awaitMs: 2, aqu: 1, inFlight: 0 })),
    nics: Array.from({ length: 32 }, (_, i) => ({ iface: `ens${i}`, errDelta: 0, dropDelta: 0, rxErrDelta: 0, txErrDelta: 0, rxDropDelta: 0, txDropDelta: 0, state: 'up' })) };
  const tun = { v: 1, sysctl: { 'vm.swappiness': '60' }, blkq: Array.from({ length: 32 }, (_, i) => ({ name: `sd${i}`, scheduler: 'mq-deadline', schedulers: ['none', 'mq-deadline'], nrRequests: 256, rotational: false })) };
  const row0 = { ts: now, src: 'os', os_at: now, cpu_pct: 40, mem_pct: 50, disk_busy_pct: 30, net_pct: 10, detail_json: U.jsonCol(det), tuning_json: U.jsonCol(tun) };
  const one = PV.buildPerfEntry({ row: { ...row0, key: 'K0' }, hw: null, th: S.PERF_DEFAULTS, intervalMs: 300_000, now, full: true });
  const N = 2_000;
  const env = {
    node: { agent: 'EDGE1', version: '2.919.0' }, at: now, enabled: true,
    targets: Array.from({ length: N }, (_, i) => ({ key: `K${i}`, name: `bm-${i}`, vcenterId: 'vc-a', paths: ['os'] })),
    rows: Array.from({ length: N }, (_, i) => ({ key: `K${i}`, ts: now, cpu_pct: 40, mem_pct: 50, disk_busy_pct: 30, disk_used_pct: 20, net_pct: 10 })),
    perf: Array.from({ length: N }, (_, i) => ({ ...one, key: `K${i}` })),
    perfThresholds: S.PERF_DEFAULTS, truncated: 0,
  };
  const rawBytes = Buffer.byteLength(JSON.stringify(env));
  assert.ok(rawBytes > E.ENVELOPE_MAX_BYTES, `합성 봉투가 상한을 넘어야 시험이 된다(${rawBytes})`);
  const fit = E.fitEnvelope(env);
  const bytes = Buffer.byteLength(JSON.stringify(fit));
  assert.ok(bytes <= E.ENVELOPE_MAX_BYTES, `${bytes} <= ${E.ENVELOPE_MAX_BYTES}`);
  assert.ok(E.ENVELOPE_MAX_BYTES < 16 * 1_048_576 / 1.5, '중앙 수신 상한(16MB)보다 충분히 작다');
  assert.equal(fit.rows.length, N, '다섯 지표 행은 언제나 남는다'); assert.equal(fit.targets.length, N);
  assert.equal(fit.perfTruncated.reason, 'envelope-bytes'); assert.equal(fit.perfTruncated.level, 'compact');
  assert.equal(fit.perf.length, N); assert.ok(!('detail' in fit.perf[0]) && !('cells' in fit.perf[0]), '무거운 것(장치별·튜닝·근거)부터 뺀다');
  assert.equal(fit.perf[0].verdict, one.verdict, '판정 code 표는 남는다');
  // 아주 작은 상한 — 성능 항목 전부 제거, 행은 그대로
  const tiny = E.fitEnvelope(env, 1_000_000);
  assert.equal(tiny.perfTruncated.level, 'dropped'); assert.deepEqual(tiny.perf, []); assert.equal(tiny.rows.length, N);
  // 상한 안이면 손대지 않는다
  const small = { ...env, perf: env.perf.slice(0, 2), rows: env.rows.slice(0, 2), targets: env.targets.slice(0, 2) };
  assert.equal(E.fitEnvelope(small), small);
  const cleaned = C.sanitizeBmUsageSnap(JSON.parse(JSON.stringify(fit)));
  assert.equal(cleaned.perfTruncated.level, 'compact'); assert.equal(cleaned.perfTruncated.bytesBefore, rawBytes);
  assert.equal(cleaned.rows.length, N);
});

/* ── D3 ─────────────────────────────────────────────────────────────── */
test('D3 엣지 시각은 수신 시각으로 자른다 — 2100년 ts·osAt·hw 시각 → 수신 시각 · 원본은 edgeTsRaw', () => {
  const Y2100 = 4_102_444_800_000;
  const rcv = Date.UTC(2026, 10, 7);
  const snap = C.sanitizeBmUsageSnap({ perf: [{ key: 'K', ts: Y2100, osAt: Y2100, idracAt: rcv - 1_000, detail: { at: Y2100 }, tuning: { at: Y2100 }, hw: { sensorAt: Y2100, inventoryAt: Y2100, power: { at: Y2100, watts: 1 } } }] }, { receivedAt: rcv });
  const p = snap.perf[0];
  assert.equal(p.ts, rcv); assert.equal(p.osAt, rcv); assert.equal(p.idracAt, rcv - 1_000, '과거 시각은 그대로');
  assert.deepEqual(p.edgeTsRaw, { ts: Y2100, osAt: Y2100 }, '원본은 따로');
  assert.equal(p.detail.at, rcv); assert.equal(p.tuning.at, rcv);
  assert.equal(p.hw.sensorAt, rcv); assert.equal(p.hw.inventoryAt, rcv); assert.equal(p.hw.power.at, rcv);
  assert.equal(CORP.clampEdgeTs(Y2100, rcv), rcv, 'corpUsage 의 이름도 같은 함수(util 하나)');
});

/* ── D4 ─────────────────────────────────────────────────────────────── */
test('D4 30일 전 행 — CPU 97% 를 ‘주의/정상’ 으로 판정하지 않는다(stale) · 오래된 인벤토리는 iDRAC ‘읽음’ 이 아니다', () => {
  const now = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  const old = now - 30 * 86_400_000;
  const hw = HW.shapeHwFacts({ inv: { collectedAt: old, collections: {}, disks: [{ name: 'd', predictiveFailure: false }], powerCap: { limitWatts: 500 } } }, { now, freshMs: 15 * 60_000 });
  assert.equal(hw.read, false, '30일 전 인벤토리만 있으면 iDRAC 경로를 읽은 것이 아니다');
  assert.equal(hw.inventoryStale, true); assert.equal(hw.diskPredicted, null, '오래된 SMART 로 ok 를 만들지 않는다');
  const e = PV.buildPerfEntry({ row: { key: 'K', ts: old, os_at: old, idrac_at: old, src: 'os', cpu_pct: 97, mem_pct: 95, net_pct: 99 }, hw, th: S.PERF_DEFAULTS, intervalMs: 300_000, now, full: true });
  assert.equal(e.coverage, 'none');
  assert.equal(e.verdict, 'stale'); assert.ok(!['ok', 'warn'].includes(e.verdict));
  assert.match(e.line, /^오래됨/);
  for (const r of ['cpu', 'mem', 'net']) assert.equal(e.cells[r].U.code, 'stale', r);
  assert.ok(e.counts.stale >= 3); assert.equal(e.counts.bad + e.counts.warn + e.counts.ok, 0, 'stale 은 판정에 넣지 않는다');
  // 같은 행이 신선하면 판정한다(대조군)
  const fresh = PV.buildPerfEntry({ row: { key: 'K', ts: now, os_at: now, src: 'os', cpu_pct: 97 }, hw: null, th: S.PERF_DEFAULTS, intervalMs: 300_000, now, full: true });
  assert.equal(fresh.cells.cpu.U.code, 'bad');
  const hwFresh = HW.shapeHwFacts({ inv: { collectedAt: now - 60 * 60_000, collections: {}, disks: [] } }, { now, freshMs: 15 * 60_000 });
  assert.equal(hwFresh.read, true, '인벤토리 갱신 주기(30분) 안의 캐시는 읽음');
});

/* ── D5 ─────────────────────────────────────────────────────────────── */
test('D5 15칸 중 1칸만 읽혀도 ‘정상’ 이 아니다 — 기준 비율 미만이면 ‘대부분 못 읽음’ · 판정 한 줄은 읽은 칸 j/a 를 늘 말한다', () => {
  const one = J.judgeUse({ row: { cpu_pct: 10 }, coverage: 'os', th: S.PERF_DEFAULTS });
  assert.equal(one.verdict, 'partial'); assert.notEqual(one.line.slice(0, 2), '정상');
  assert.match(one.line, /^대부분 못 읽음/); assert.match(one.line, /읽은 칸 1\/10/);
  const many = J.judgeUse({ row: { src: 'os', cpu_pct: 10, runq_per_core: 0.1, mem_pct: 10, swap_out_ps: 0, oom_kill_delta: 0, disk_busy_pct: 1, disk_aqu: 0.1, net_pct: 1, net_drop_delta: 0, net_err_delta: 0 }, detail: { osKind: 'linux', sections: {}, streak: {} }, coverage: 'os', th: S.PERF_DEFAULTS });
  assert.equal(many.verdict, 'ok'); assert.match(many.line, /^정상 · 읽은 칸 10\/10$/);
  // 기준값은 API 값 — 낮추면 1칸도 정상이 될 수 있다(기준이 화면에 박혀 있지 않다)
  assert.equal(J.judgeUse({ row: { cpu_pct: 10 }, coverage: 'os', th: { ...S.PERF_DEFAULTS, minJudgedPct: 5 } }).verdict, 'ok');
  // 실제로 나쁜 칸이 있으면 비율과 무관하게 말한다
  assert.equal(J.judgeUse({ row: { cpu_pct: 99 }, coverage: 'os', th: S.PERF_DEFAULTS }).verdict, 'warn');
  assert.ok('minJudgedPct' in S.normalizeSettings({}).perf);
});

/* ── D6 ─────────────────────────────────────────────────────────────── */
test('D6 ALTER 실패를 삼키지 않는다 — 실패 목록·콘솔 오류 · 실제 열만 적재해 기존 지표는 계속 · migrateError 가 결과·상태에 오른다', async (t) => {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { t.skip('node:sqlite 없음'); return; }
  const db = await import('../src/bmusage/db.js');
  // ① 마이그레이션 함수 — 특정 열의 ALTER 가 실패하는 연결(디스크 가득·잠금 흉내)
  const real = new DatabaseSync(':memory:');
  real.exec('CREATE TABLE usage_history (agent TEXT, key TEXT, ts INTEGER); CREATE TABLE usage_daily (agent TEXT, key TEXT, day TEXT); CREATE TABLE usage_latest (agent TEXT, key TEXT, ts INTEGER)');
  const conn = { prepare: (q) => real.prepare(q), exec: (q) => { if (/ADD COLUMN disk_aqu /.test(q)) throw new Error('database or disk is full'); return real.exec(q); } };
  const errs = []; const orig = console.error; console.error = (...a) => errs.push(a.join(' '));
  let r;
  try { r = db.migratePerfColumns(conn); } finally { console.error = orig; }
  assert.equal(r.failed.length, 2, 'usage_history.disk_aqu · usage_latest.disk_aqu');
  assert.ok(r.failed[0].includes('disk is full'));
  assert.ok(!r.have.usage_history.has('disk_aqu') && r.have.usage_history.has('runq_per_core'));
  assert.ok(errs.some((x) => x.includes('더하지 못했습니다')), '콘솔에 오류로 남긴다(무음 실패 금지)');
  // ② 실제 모듈 DB — 열이 정말 없는 상태(DROP COLUMN)에서 적재가 기존 지표까지 실패하지 않는다
  db._resetForTest();
  assert.equal(await db.available(), true);
  const file = path.join(CFG, 'bm-usage.db');
  const side = new DatabaseSync(file);
  side.exec('ALTER TABLE usage_history DROP COLUMN disk_aqu');
  side.close();
  const have = { usage_history: new Set(['agent', ...PERF_COL_NAMES.filter((c) => c !== 'disk_aqu')]), usage_daily: null, usage_latest: null };
  db._setPerfColsForTest(have, { at: 1, count: 1, reasons: ['usage_history.disk_aqu: database or disk is full'] });
  const ins = await db.insertUsage([{ key: 'K', ts: 1_700_000_000_000, src: 'os', cpu_pct: 12, disk_aqu: 3 }], '');
  assert.equal(ins.ok, true, `기존 지표 적재가 매 주기 실패하지 않는다: ${ins.error || ''}`);
  assert.equal(ins.inserted, 1); assert.equal(ins.migrateError.count, 1, '실패 사실을 결과에 싣는다(폴러 _last.dbMigrateError)');
  assert.equal((await db.dbStatus()).migrateError.count, 1, '상태(수집 건강)도 본다');
  assert.equal((await db.latestUsage()).find((x) => x.key === 'K').disk_aqu, 3, '최신값 표에는 열이 있으니 적재된다');
  db._resetForTest();
});
