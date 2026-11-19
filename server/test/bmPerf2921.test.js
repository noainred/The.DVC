/**
 * v2.922(리눅스 성능 3a — 서버) — 시간 단위 파일 · 3단 롤업 · 장치별 이력 · 피크 A 안 · 추이 API · D7 · D13 · 집계 SQL 규약.
 * 마이그레이션은 bmPerf2921Migrate.test.js · CVP 는 bmPerf2921Cvp.test.js · 행 크기 실측은 bmPerf2921Size.test.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { stripComments } from './_stripComments.js';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'bm2921-'));
process.env.CONFIG_DIR = DIR;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const SRC = (rel) => stripComments(fs.readFileSync(path.join(import.meta.dirname, '../src', rel), 'utf8'));
const HOUR = 3_600_000; const DAY = 86_400_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;

async function fresh() {
  const db = await import('../src/bmusage/db.js');
  db._resetForTest();
  for (const f of fs.readdirSync(DIR)) fs.rmSync(path.join(DIR, f), { recursive: true, force: true });
  return { db, month: await import('../src/bmusage/monthStore.js') };
}

/* ── 월 파일 · 기간 ───────────────────────────────────────────────────── */
test('기간 키·파일 이름: 포탈 시각(KST) 경계 · 1일은 연 파일 · 메인 파일은 이 모듈 파일이 아니다', async () => {
  const M = await import('../src/bmusage/monthStore.js');
  // 2026-11-30 15:00Z = 12-01 00:00 KST → 12월 파일
  assert.equal(M.periodKeyOf('raw', Date.UTC(2026, 10, 30, 15, 0)), '2026-12');
  assert.equal(M.periodKeyOf('raw', Date.UTC(2026, 10, 30, 14, 59)), '2026-11');
  assert.equal(M.periodKeyOf('d1', Date.UTC(2026, 11, 31, 15, 0)), '2027');
  assert.equal(M.fileNameOf('raw', '2026-11'), 'bm-usage-2026-11.db');
  assert.equal(M.fileNameOf('h1', '2026-11'), 'bm-usage-1h-2026-11.db');
  assert.equal(M.fileNameOf('d1', '2026'), 'bm-usage-1d-2026.db');
  assert.equal(M.parseFileName('bm-usage.db'), null);
  assert.deepEqual(M.parseFileName('bm-usage-dev-2026-02.db'), { family: 'dev', key: '2026-02' });
  assert.equal(M.parseFileName('bm-usage-1d-2026-01.db'), null, '1일은 연 파일만');
  const [a, b] = M.periodRange('raw', '2026-11');
  assert.equal(new Date(a).toISOString(), '2026-10-31T15:00:00.000Z'); assert.equal(new Date(b).toISOString(), '2026-11-30T15:00:00.000Z');
});

test('조회는 창에 걸리는 파일만 연다 · 상한 10(ATTACH 상한) 넘으면 최근 10 + filesCapped · 없는 달은 그 달 없음 · 열기 실패는 사유', async () => {
  const { month } = await fresh();
  assert.equal(month.MONTH_FILES_PER_QUERY, 10);
  // 14개월 창
  const from = Date.UTC(2025, 0, 10); const to = Date.UTC(2026, 1, 20);
  const seen = [];
  const r = await month.forEachPeriod('raw', from, to, (_db, k) => seen.push(k));
  assert.equal(r.filesCapped, 4); assert.equal(r.periods.length, 10); assert.equal(r.periods.at(-1), '2026-02');
  assert.equal(seen.length, 0, '파일이 없으면 열지 않는다(만들지 않는다)');
  assert.ok(r.missingPeriods.every((x) => x.reason === 'none'));
  assert.equal(fs.readdirSync(DIR).filter((f) => f.startsWith('bm-usage-')).length, 0, '조회가 빈 파일을 만들면 안 된다');
  // 열기 실패(파일 자리에 디렉터리)는 사유를 싣고 나머지로 계속
  const k = month.periodKeyOf('raw', NOW);
  fs.mkdirSync(path.join(DIR, month.fileNameOf('raw', k)));
  const r2 = await month.forEachPeriod('raw', NOW - 40 * DAY, NOW, () => {});
  const bad = r2.missingPeriods.find((x) => x.period === k);
  assert.ok(bad && bad.reason !== 'none', JSON.stringify(r2.missingPeriods));
});

/* ── 3단 롤업 수치 ───────────────────────────────────────────────────── */
test('5분 → 1시간 → 1일 롤업: 평균(합÷개수, null 제외) · 최대 · 피크(더 클 때만 시각도) · 재전송 이중 계수 없음', async () => {
  const { db, month } = await fresh();
  const h0 = NOW - 3 * HOUR;
  const mk = (i, cpu, peak, at) => ({ key: 'S1', ts: h0 + i * 300_000, name: 's1', vcenterId: 'vc', src: 'os', cpu_pct: cpu, mem_pct: 50,
    cpu_pct_peak: peak, cpu_pct_peak_at: at, peak_src: peak == null ? 'none' : 'window10', peak_window_s: peak == null ? 0 : 10 });
  const rows = [mk(0, 10, 30, h0 + 5_000), mk(1, 20, 90, h0 + 305_000), mk(2, null, 40, h0 + 605_000), mk(3, 40, null, null)];
  const r = await db.insertUsage(rows, '');
  assert.equal(r.inserted, 4, JSON.stringify(r));
  assert.equal((await db.insertUsage([mk(1, 99, 99, 1)], '')).duplicates, 1, '같은 ts 재전송');
  const hr = await month.readHourlyRange({ key: 'S1', from: h0, to: h0 + HOUR - 1 });
  assert.equal(hr.rows.length, 1);
  const H = hr.rows[0];
  assert.equal(H.samples, 4); assert.equal(H.cpu_n, 3, 'null 은 개수에 넣지 않는다'); assert.equal(H.cpu_sum, 70); assert.equal(H.cpu_max, 40);
  assert.equal(H.cpu_pct_peak, 90); assert.equal(H.cpu_pct_peak_at, h0 + 305_000, '피크 시각은 최대 피크의 시각');
  assert.equal(H.peak_samples, 3);
  const d = (await db.usageDaily({ key: 'S1', days: 2 })).find((x) => x.samples >= 4);
  assert.equal(d.cpu_avg, Math.round((70 / 3) * 10) / 10); assert.equal(d.cpu_max, 40); assert.equal(d.cpu_pct_peak, 90);
  // 원시는 월 파일에(메인 파일 예전 표는 비어 있다)
  const raw = await db.usageHistory('S1', { hours: 5 });
  assert.equal(raw.rows.length, 4); assert.equal(raw.rows[1].cpu_pct_peak, 90);
  const st = await db.dbStatus();
  assert.equal(st.legacyRows.raw, 0); assert.ok(st.files.raw.rows >= 4);
});

/* ── 보존 ─────────────────────────────────────────────────────────────── */
test('보존: 기간이 지난 파일은 통째로 삭제(-wal/-shm 포함) · 경계 달은 앞부분만 청크 · 쓰는 중(pin)인 파일은 미룬다', async () => {
  const { db, month } = await fresh();
  const old = NOW - 70 * DAY; const mid = NOW - 31 * DAY;
  await db.insertUsage([{ key: 'R', ts: old, cpu_pct: 1 }, { key: 'R', ts: mid, cpu_pct: 2 }, { key: 'R', ts: NOW - HOUR, cpu_pct: 3 }], '');
  const oldName = month.fileNameOf('raw', month.periodKeyOf('raw', old));
  assert.ok(fs.existsSync(path.join(DIR, oldName)));
  // pin 중이면 미룬다
  let deferred;
  await month.withPeriodFile('raw', month.periodKeyOf('raw', old), {}, async () => {
    deferred = await month.pruneMonthFiles({ keepDays: { raw: 30 } });
  });
  assert.ok(deferred.deferred.includes(oldName), JSON.stringify(deferred));
  assert.ok(fs.existsSync(path.join(DIR, oldName)));
  const r = await month.pruneMonthFiles({ keepDays: { raw: 30 } });
  assert.ok(r.filesDeleted.includes(oldName), JSON.stringify(r));
  for (const x of ['', '-wal', '-shm']) assert.ok(!fs.existsSync(path.join(DIR, `${oldName}${x}`)), x);
  const h = await db.usageHistory('R', { hours: 24 * 80 });
  assert.deepEqual(h.rows.map((x) => x.cpu_pct).filter((v) => v !== 1), h.rows.map((x) => x.cpu_pct), '70일 전 행은 사라졌다');
  // 1시간·1일 롤업 파일은 그대로(보존이 다르다)
  assert.ok(month.listFamilyFiles('h1').some((f) => f.key === month.periodKeyOf('h1', old)));
});

/* ── 장치별 ──────────────────────────────────────────────────────────── */
test('장치별 행: 가상 NIC 제외 · 파티션은 옵트인일 때만 · 상한 초과 n · 물리 디스크 먼저', async () => {
  const L = await import('../src/bmusage/parse/linuxProc.js');
  const DR = await import('../src/bmusage/deviceRows.js');
  const lines = ['8 0 sda 1 0 8 10 2 0 16 20 0 30 30', '8 1 sda1 1 0 8 10 2 0 16 20 0 30 30', '253 0 dm-0 1 0 8 10 2 0 16 20 0 30 30', '7 0 loop0 1 0 8 10 2 0 16 20 0 30 30'];
  assert.deepEqual(L.parseDiskstats(lines).map((d) => d.name), ['sda', 'dm-0'], '기본은 파티션·loop 제외');
  const withPart = L.parseDiskstats(lines, { partitions: true });
  assert.deepEqual(withPart.map((d) => [d.name, !!d.part]), [['sda', false], ['sda1', true], ['dm-0', false]], '옵트인: 파티션 행(part) · loop 는 여전히 제외');
  const disks = [{ name: 'dm-0' }, { name: 'sdb' }, { name: 'sda1', part: true }, { name: 'nvme0n1' }];
  const nics = [{ iface: 'veth1', virtual: true }, { iface: 'bond0', bitsPerSec: 2e10 }, { iface: 'eno1', bitsPerSec: 1e10 }, { iface: 'eno9' }];
  const r = DR.buildDeviceRows({ key: 'K', ts: 1, disks, nics, deviceMax: 32 });
  assert.deepEqual(r.rows.filter((x) => x.kind === 'disk').map((x) => x.dev), ['sdb', 'nvme0n1', 'dm-0', 'sda1'], '물리 → dm → 파티션');
  assert.ok(!r.rows.some((x) => x.dev === 'veth1'), '가상 NIC 제외');
  assert.equal(r.over, 0);
  const capped = DR.buildDeviceRows({ key: 'K', ts: 1, disks, nics, deviceMax: 4 });
  assert.equal(capped.rows.length, 4); assert.equal(capped.over, 3); assert.equal(capped.total, 7);
  assert.equal(capped.rows.filter((x) => x.kind === 'nic').length >= 2, true, '한 종류가 상한을 다 차지하지 않는다');
});

test('장치별 이력 적재 → 1시간 롤업 · 장치 목록 순서(처음 본 순서 = 색) 고정 · 마운트는 일 롤업만', async () => {
  const { db, month } = await fresh();
  const t0 = NOW - 2 * HOUR;
  const dev = (ts, d, busy) => ({ key: 'D', ts, kind: 'disk', dev: d, busy_pct: busy, busy_pct_peak: busy == null ? null : busy + 5, busy_pct_peak_at: ts - 1000 });
  await db.insertUsage([{ key: 'D', ts: t0, cpu_pct: 1 }], '', { devices: [dev(t0, 'sdb', 10), dev(t0, 'sda', 20)], mounts: [{ key: 'D', ts: t0, mount: '/data', used_pct: 50, inode_pct: 3, size_bytes: 100, used_bytes: 50 }] });
  await db.insertUsage([{ key: 'D', ts: t0 + 300_000, cpu_pct: 1 }], '', { devices: [dev(t0 + 300_000, 'sda', 40), dev(t0 + 300_000, 'nvme0n1', 1)] });
  const list = await db.deviceList('D');
  assert.deepEqual(list.filter((x) => x.kind === 'disk').map((x) => [x.dev, x.ord]), [['sdb', 1], ['sda', 2], ['nvme0n1', 3]], '처음 본 순서가 고정');
  const hr = await month.readDeviceRange({ key: 'D', kind: 'disk', dev: 'sda', from: t0, to: NOW, res: '1h' });
  assert.equal(hr.rows[0].samples, 2); assert.equal(hr.rows[0].busy_pct_sum, 60); assert.equal(hr.rows[0].busy_pct_max, 40); assert.equal(hr.rows[0].busy_pct_peak, 45);
  const m = await month.readMountDaily({ key: 'D', from: t0, to: NOW });
  assert.equal(m.rows.length, 1); assert.equal(m.rows[0].used_pct_max, 50);
  assert.equal(month.listFamilyFiles('dev').length, 1);
  assert.ok(!SRC('bmusage/monthStore.js').includes('usage_mount_history'), '마운트 5분 원시 표는 없다');
});

/* ── 피크 A 안 ───────────────────────────────────────────────────────── */
test('피크 A: 예산이 모자라면 N 축소 · 2초 미만이면 0 · 창 안 최대와 시각 · 리셋 구간은 건너뜀', async () => {
  const P = await import('../src/bmusage/peakWindow.js');
  assert.deepEqual(P.planWindow({ wantS: 10, remainingMs: 30_000 }), { windowS: 10, reduced: false, reason: '' });
  assert.deepEqual(P.planWindow({ wantS: 10, remainingMs: 9_500 }), { windowS: 6, reduced: true, reason: 'budget' });
  assert.equal(P.planWindow({ wantS: 10, remainingMs: 4_000 }).windowS, 0);
  assert.equal(P.planWindow({ wantS: 0, remainingMs: 40_000 }).reason, 'off');
  const cmd = P.peakCommand(10);
  assert.match(cmd, /^export LC_ALL=C; \{ i=0; while \[ \$i -le 10 \]/); assert.match(cmd, /head -c \d+$/);
  // 표본 4개(1초 간격): cpu 2번째 구간이 최대(80%) · 디스크 io_ticks 3번째 구간 최대 · 세 번째 표본에서 디스크 리셋
  const sample = (i, up, cpu, ticks, rx) => [`##PK ${i} ${up}`, `cpu  ${cpu[0]} 0 0 ${cpu[1]} ${cpu[2]} 0 0 0 0 0`, '##PKD', `8 0 sda 100 0 0 10 ${100 + i} 0 0 10 0 ${ticks} ${ticks}`, '##PKN', ` eno1: ${rx} 0 0 0 0 0 0 0 ${rx} 0 0 0 0 0 0 0`].join('\n');
  const out = [sample(0, '100.00', [0, 0, 0], 0, 0), sample(1, '101.00', [20, 80, 0], 500, 1000), sample(2, '102.00', [100, 100, 0], 100, 3000), sample(3, '103.00', [110, 190, 0], 900, 4000), '##PKEND'].join('\n');
  const parsed = P.parsePeakOutput(out);
  assert.equal(parsed.samples.length, 4); assert.equal(parsed.truncated, false);
  const pk = P.computePeaks({ samples: parsed.samples, startWall: 1_000_000, nicInfo: { eno1: { bitsPerSec: 1e6 } } });
  assert.equal(pk.windowS, 3);
  assert.equal(pk.server.cpu_pct.peak, 80); assert.equal(pk.server.cpu_pct.at, 1_002_000);
  assert.equal(pk.server.disk_busy_pct.peak, 80, '리셋(500→100) 구간은 건너뛰고 100→900 = 80%');
  assert.equal(pk.devices.get('nic|eno1').util_pct.peak, 1.6);
  assert.equal(P.peakSrcOf({ windowS: 3 }), 'window10'); assert.equal(P.peakSrcOf({ windowS: 0, psiRead: true }), 'psi');
  assert.equal(P.peakSrcOf({ windowS: 0 }), 'none'); assert.equal(P.peakSrcOf({ windowS: 9, sampler: { state: 'ok' } }), 'sampler');
  // 잘린 출력(##PKEND 없음)은 truncated 이고 마지막(불완전) 표본은 버린다
  assert.equal(P.parsePeakOutput(out.replace('##PKEND', '')).truncated, true);
});

test('피크가 행으로: buildUsage 가 peak 열·peak_src·peak_window_s 를 싣고 1초 표본 배열은 행에 없다(DB 적재 금지)', async () => {
  const U = await import('../src/bmusage/usage.js');
  const os = { ok: true, osKind: 'linux', counters: { cpu: { total: 100, idle: 50 }, disks: [], nets: [] }, mounts: [], perf: {},
    peak: { windowS: 6, wantS: 10, plannedS: 6, shortBy: 0, reduced: true, reason: 'budget', server: { cpu_pct: { peak: 77, at: 123 } }, devices: {} } };
  const b = U.buildUsage({ target: { key: 'K', name: 'k' }, os, now: 10_000 });
  assert.equal(b.row.cpu_pct_peak, 77); assert.equal(b.row.cpu_pct_peak_at, 123); assert.equal(b.row.peak_src, 'window10'); assert.equal(b.row.peak_window_s, 6);
  assert.ok(b.notes.some((x) => x.includes('10초에서 6초로')), b.notes.join('|'));
  // 화면 상세용 _perIf·_perFc 는 폴러가 적재 전에 뗀다(v2.550.3) — 나머지 열에 배열이 있으면 1초 표본이 섞인 것이다.
  for (const [k, v] of Object.entries(b.row)) if (k !== '_perIf' && k !== '_perFc') assert.ok(!Array.isArray(v), `행에 배열(${k}) — 1초 표본이 섞였다`);
  const none = U.buildUsage({ target: { key: 'K' }, os: { ...os, peak: { windowS: 0, wantS: 10, reason: 'budget' } }, now: 10_000 });
  assert.equal(none.row.cpu_pct_peak, null, '창이 없으면 null(0 아님)'); assert.equal(none.row.peak_src, 'none'); assert.equal(none.row.peak_window_s, 0);
  // 소스: 1초 해상도 표가 없다
  const ms = SRC('bmusage/monthStore.js');
  assert.ok(!/CREATE TABLE IF NOT EXISTS \w*(1s|second|peak_sample)/i.test(ms));
});

test('샘플러 B: 옵트인일 때만 ##SAMPLER · 없으면 absent · 기대 해시 없으면 unverified(값을 쓰지 않는다)', async () => {
  const O = await import('../src/bmusage/collectors/osSsh.js');
  const S = await import('../src/bmusage/samplerSpec.js');
  assert.ok(!O.linuxCommand(['/']).includes('##SAMPLER'), '기본 명령은 그대로');
  assert.ok(O.linuxCommand(['/'], { sampler: true }).includes("echo '##SAMPLER'"));
  assert.equal(S.parseSamplerFile([]).state, 'absent'); assert.equal(S.parseSamplerFile(null).state, 'missing');
  const sha = 'a'.repeat(64);
  const f = [`#dvc-bmperf v1 sha256=${sha} at=1700000000 window=300`, 'cpu_pct|10|90|1700000100', 'bogus|1|2|3', 'net_pct|5|150|1'];
  const u = S.parseSamplerFile(f);
  assert.equal(u.state, 'unverified'); assert.deepEqual(Object.keys(u.metrics), ['cpu_pct'], '모르는 지표·범위 밖 버림');
  assert.equal(S.parseSamplerFile(f, { expectedSha: sha, now: 1700000000_000 + 60_000 }).state, 'ok');
  assert.equal(S.parseSamplerFile(f, { expectedSha: sha, now: 1700000000_000 + 3_600_000 }).state, 'stale');
  assert.ok(!/(scp|sftp|cat >|tee |install -m)/.test(SRC('bmusage/samplerSpec.js')), '배포(서버에 파일 쓰기) 기능이 없다');
});

/* ── D7 ───────────────────────────────────────────────────────────────── */
test('D7: ##BLKQ 는 grep -H 한 번(장치마다 프로세스 4개 금지) · 물리 디스크 먼저 · 상한은 설정 · 넘은 수는 total', async () => {
  const O = await import('../src/bmusage/collectors/osSsh.js');
  const L = await import('../src/bmusage/parse/linuxProc.js');
  const cmd = O.linuxCommand(['/']);
  assert.ok(cmd.includes("grep -H '' /sys/block/*/queue/scheduler /sys/block/*/queue/nr_requests /sys/block/*/queue/rotational"));
  assert.ok(!/cat "\$d\/queue\/scheduler"/.test(cmd), '예전 루프가 남아 있다');
  const lines = [];
  for (let i = 0; i < 70; i++) lines.push(`/sys/block/dm-${i}/queue/scheduler:none`);
  lines.push('/sys/block/sda/queue/scheduler:mq-deadline [none]', '/sys/block/sda/queue/nr_requests:64', '/sys/block/sda/queue/rotational:1', '/sys/block/md0/queue/scheduler:none');
  const r = L.parseBlkq(lines, { max: 5 });
  assert.equal(r[0].name, 'sda'); assert.equal(r[0].scheduler, 'none'); assert.equal(r[0].nrRequests, 64); assert.equal(r[0].rotational, true);
  assert.equal(r[1].name, 'md0'); assert.equal(r.length, 5); assert.equal(r.total, 72);
  assert.equal(L.parseBlkq(['sdb|[mq-deadline] none|256|0'])[0].scheduler, 'mq-deadline', '옛 형식도 받는다');
});

/* ── D13 ──────────────────────────────────────────────────────────────── */
test('D13: latestUsage() 기본은 JSON 열 없음 · 판정 소비처만 { json:true } · corpUsage·svcInventory·cpuLatest 는 기본', async () => {
  const { db } = await fresh();
  await db.insertUsage([{ key: 'J', ts: NOW, cpu_pct: 1, detail_json: '{"v":1}', tuning_json: '{"v":1}' }], '');
  const lite = (await db.latestUsage()).find((r) => r.key === 'J');
  assert.ok(lite && !('detail_json' in lite) && !('tuning_json' in lite) && lite.cpu_pct === 1);
  assert.equal((await db.latestUsage({ json: true })).find((r) => r.key === 'J').detail_json, '{"v":1}');
  for (const f of ['routes/api/corpUsage.js', 'routes/api/svcInventory.js', 'bmusage/cpuLatest.js']) assert.ok(!/latestUsage\(\{\s*json/.test(SRC(f)), f);
  for (const f of ['routes/api/bmUsage.js', 'bmusage/edgePull.js']) assert.ok(/latestUsage\(\{ json: true \}\)/.test(SRC(f)), f);
});

/* ── 추이 창(순수) ───────────────────────────────────────────────────── */
test('추이 창: 해상도 자동(2일 5분 · 60일 1시간 · 그 위 1일 · 보존 밖이면 한 단계 위) · 장치는 1일 없음 · 결측 구간 · 기준선', async () => {
  const W = await import('../src/bmusage/trendWindow.js');
  const keep = { raw: 30, h1: 365, d1: 1825, dev: 14, dev1h: 90 };
  const now = NOW;
  assert.equal(W.pickRes({ from: now - DAY, to: now, now, keepDays: keep }).res, '5m');
  assert.equal(W.pickRes({ from: now - 10 * DAY, to: now, now, keepDays: keep }).res, '1h');
  assert.equal(W.pickRes({ from: now - 200 * DAY, to: now, now, keepDays: keep }).res, '1d');
  assert.deepEqual(W.pickRes({ from: now - 40 * DAY, to: now - 39 * DAY, now, keepDays: keep }), { res: '1h', reason: 'retention' }, '원시 보존 밖 하루 창은 1시간');
  assert.deepEqual(W.pickRes({ from: now - 5 * DAY, to: now, now, kind: 'disk', req: '1d', keepDays: keep }), { res: '1h', reason: 'device-no-daily' });
  assert.equal(W.pickRes({ from: now - DAY, to: now, now, kind: 'mount', keepDays: keep }).res, '1d');
  const pts = W.toPoints([{ h: 0, cpu_sum: 30, cpu_n: 3, cpu_max: 20, cpu_pct_peak: 99, cpu_pct_peak_at: 5, samples: 4 }, { h: 3 * HOUR, cpu_sum: 0, cpu_n: 0, cpu_max: null, samples: 1 }], { metric: 'cpu_pct', res: '1h' });
  assert.deepEqual(pts[0], { t: 0, avg: 10, max: 20, peak: 99, peakAt: 5, n: 4 });
  assert.equal(pts[1].avg, null, '개수 0 이면 평균 null(0 아님)');
  const g = W.gapsOf(pts, { from: 0, to: 4 * HOUR, stepMs: HOUR });
  assert.ok(g.some((x) => x.from === 0 && x.to === 4 * HOUR) || g.some((x) => x.from === 0), JSON.stringify(g));
  assert.deepEqual(W.gapsOf([], { from: 1, to: 2, stepMs: 1 }), [{ from: 1, to: 2, reason: 'no-data' }]);
  assert.deepEqual(W.baselineOf('cpu_pct', { utilWarn: 80, utilBad: 90 }), { warn: 80, bad: 90, key: 'util' });
  assert.equal(W.baselineOf('net_bps', { utilWarn: 80 }), null, '처리량에는 기준선을 지어내지 않는다');
  assert.equal(W.normalizeWindow({ from: 10, to: 5 }), null);
  assert.equal(W.capPoints(Array.from({ length: W.TREND_MAX_POINTS + 3 }, (_, i) => ({ t: i }))).truncated, 3);
});

/* ── 추이 API(라우트 함수) ───────────────────────────────────────────── */
function req(user, params = {}, query = {}) { return { user, params, query }; }
const ADMIN = { username: 'a', role: 'admin' };
test('추이 API: 이 노드 서버(실제 DB) · 범위 밖 404 · 없는 키 404 · 잘못된 지표 400 · 엣지 위임 서버는 엣지 대행', async () => {
  const { db } = await fresh();
  const B = await import('../src/routes/api/bmUsage.js');
  const t0 = NOW - 2 * HOUR;
  const { config } = await import('../src/config.js');
  const AG = config.agent?.name || '';   // 적재 키 = 조회 키(폴러와 같은 식)
  const ins = await db.insertUsage([0, 1, 2].map((i) => ({ key: 'TK', ts: t0 + i * 300_000, cpu_pct: 10 * (i + 1), cpu_pct_peak: 50 + i, cpu_pct_peak_at: t0 + i * 300_000 - 1 })), AG);
  assert.equal(ins.inserted, 3, JSON.stringify(ins));
  const targets = [{ key: 'TK', name: 'tk', vcenterId: 'vc1', paths: ['os'] }];
  const deps = { currentTargets: async () => ({ targets }), bmAddressHosts: async () => [], listEdgeBmUsage: async () => [] };
  const r = await B.bmTrendView(req(ADMIN, { key: 'TK' }, { metric: 'cpu_pct', from: String(t0 - 1), to: String(NOW) }), {}, 'history', deps);
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.res, '5m'); assert.equal(r.points.length, 3, JSON.stringify(r).slice(0, 600));
  assert.deepEqual(r.points.map((p) => [p.avg, p.peak]), [[10, 50], [20, 51], [30, 52]]);
  assert.ok(Array.isArray(r.gaps)); assert.ok(r.baseline);
  assert.equal((await B.bmTrendView(req(ADMIN, { key: 'TK' }, { metric: 'evil;drop' }), {}, 'history', deps)).__status, 400);
  assert.equal((await B.bmTrendView(req(ADMIN, { key: 'NOPE' }, {}), {}, 'history', deps)).__status, 404);
  // 범위 계정(vc2 만) — 범위 밖은 없는 것과 같은 404
  const scoped = { username: 'u', role: 'operator', scope: { vcenters: ['vc2'] } };
  const snap = { vcenters: [{ id: 'vc1' }, { id: 'vc2' }] };
  const out = await B.bmTrendView(req(scoped, { key: 'TK' }, {}), snap, 'history', deps);
  assert.equal(out.__status, 404, JSON.stringify(out));
  // 엣지 위임: 보관분에 있는 대상 → pullBmTrend 를 부른다(중앙은 다시 계산하지 않는다)
  let called = null;
  const edgeDeps = { ...deps, currentTargets: async () => ({ targets: [] }),
    listEdgeBmUsage: async () => [{ agent: 'EDGE-A', snap: { targets: [{ key: 'EK', vcenterId: 'vc1' }] } }],
    pullBmTrend: async (agent, mode, key, q) => { called = { agent, mode, key, q }; return { ok: true, ms: 5, body: { ok: true, res: '1h', points: [{ t: 1, avg: 2 }] } }; } };
  const e = await B.bmTrendView(req(ADMIN, { key: 'EK' }, { metric: 'cpu_pct' }), {}, 'history', edgeDeps);
  assert.equal(e.via, 'edge'); assert.equal(e.agent, 'EDGE-A'); assert.equal(called.key, 'EK'); assert.equal(called.mode, 'history');
  const fail = await B.bmTrendView(req(ADMIN, { key: 'EK' }, {}), {}, 'history', { ...edgeDeps, pullBmTrend: async () => ({ ok: false, kind: 'timeout', reason: 't/o' }) });
  assert.equal(fail.ok, false); assert.equal(fail.kind, 'timeout');
  // 장치 목록
  const dv = await B.bmTrendView(req(ADMIN, { key: 'TK' }), {}, 'devices', deps);
  assert.equal(dv.ok, true); assert.deepEqual(Object.keys(dv.devices), ['disk', 'nic', 'mount']);
});

test('엣지 대행 응답 정제: 아는 필드만 · 점 상한 · 잘린 수(sanitizeTruncated) · 문자열 수치는 수로', async () => {
  const E = await import('../src/central/bmUsageEdgePull.js');
  const many = Array.from({ length: E.TREND_PULL_MAX_POINTS + 7 }, (_, i) => ({ t: i, avg: String(i), evil: { x: 1 } }));
  const s = E.sanitizeTrendBody({ ok: true, res: '5m', points: many, gaps: [{ from: 1, to: 2, reason: 'no-data', z: 1 }], baseline: { warn: '80', bad: 90 }, __proto__x: 1, extra: 'drop' });
  assert.equal(s.points.length, E.TREND_PULL_MAX_POINTS); assert.equal(s.sanitizeTruncated, 7);
  assert.equal(s.points[0].avg, 7); assert.ok(!('evil' in s.points[0])); assert.ok(!('extra' in s));
  assert.equal(s.baseline.warn, 80);
  assert.equal(E.sanitizeTrendBody({ res: 'evil' }).res, null);
  assert.equal(E.sanitizeTrendBody(null), null);
  assert.equal(E.TREND_MIN_EDGE_VERSION, '2.922.0');
  const col = SRC('routes/collector.js');
  for (const p of ['/bm-usage/trend', '/bm-usage/devices', '/bm-usage/nics']) assert.ok(col.includes(`collectorRouter.get('${p}'`), p);
  assert.match(col, /async function bmTrendCollector[\s\S]{0,300}checkToken\(req\)/, '토큰 게이트');
  assert.match(col, /이 엣지의 대상 서버가 아닙니다/, '엣지가 대상 목록으로 다시 거른다');
});

/* ── 집계 SQL 규약(소스 스윕) ─────────────────────────────────────────── */
/** 문장 하나 안의 '인자 하나짜리' 집계 함수 수(스칼라 MAX(a,b) 는 집계가 아니다). */
export function aggCount(sql) {
  let count = 0;
  const re = /\b(MIN|MAX|SUM|COUNT|AVG|TOTAL|GROUP_CONCAT)\s*\(/gi;
  let m;
  while ((m = re.exec(sql))) {
    let depth = 1; let i = m.index + m[0].length; let commas = 0;
    for (; i < sql.length && depth > 0; i++) { const c = sql[i]; if (c === '(') depth++; else if (c === ')') depth--; else if (c === ',' && depth === 1) commas++; }
    if (commas === 0) count++;
  }
  return count;
}
test('집계 SQL 규약: 3a 모듈의 SQL 문장마다 집계 함수(인자 하나) ≤ 1 — 스윕 자체도 검사', () => {
  assert.equal(aggCount('SELECT MIN(ts), MAX(ts) FROM t'), 2);
  assert.equal(aggCount('x=NULLIF(MAX(IFNULL(a,-1e308),IFNULL(b,-1e308)),-1e308)'), 0, '스칼라 MAX 는 집계가 아니다');
  assert.equal(aggCount("SELECT COUNT(*) c FROM t WHERE ts >= ?"), 1);
  for (const f of ['bmusage/monthStore.js', 'bmusage/monthMigrate.js', 'bmusage/trendQuery.js', 'bmusage/db.js']) {
    const src = SRC(f);
    const lits = src.match(/`[^`]*`|'[^'\n]*'/g) || [];
    for (const l of lits) if (/\bSELECT\b|\bUPDATE\b|\bINSERT\b/i.test(l)) assert.ok(aggCount(l) <= 1, `${f}: ${l.slice(0, 160)}`);
  }
});

/* ── 설정 ─────────────────────────────────────────────────────────────── */
test('저장 구조 설정: 기본값(30·365·14·90·32·파티션 끔·창 10·샘플러 끔) · 범위 · 0 은 창 끔 · 배포 키 아님 · 실효 원시 보존은 min', async () => {
  const S = await import('../src/bmusage/settings.js');
  const d = S.normalizeSettings({}).store;
  assert.deepEqual([d.rawDays, d.hourlyDays, d.devRawDays, d.devHourlyDays, d.deviceMax, d.partitionIo, d.peakWindowS, d.peakSampler, d.portTolPct], [30, 365, 14, 90, 32, false, 10, false, 5]);
  assert.equal(S.normalizeStoreSettings({ peakWindowS: 0 }).peakWindowS, 0);
  assert.equal(S.normalizeStoreSettings({ deviceMax: 99999, peakSamplerSha256: 'xyz' }).deviceMax, 256);
  assert.equal(S.normalizeStoreSettings({ peakSamplerSha256: 'xyz' }).peakSamplerSha256, '');
  assert.ok(!S.DISTRIBUTED_KEYS.includes('store'));
  assert.equal(S.effectiveRawDays(S.normalizeSettings({})), 30);
  assert.equal(S.effectiveRawDays(S.normalizeSettings({ rawRetentionDays: 7 })), 7, '기존 키를 더 짧게 둔 현장은 늘리지 않는다');
});

/* ── 폴러 연결 ───────────────────────────────────────────────────────── */
test('폴러: 보존 틱이 시간 단위 파일도 지운다(꺼져 있어도 · 첫 틱 아님) · store 옵션을 수집기에 넘김 · 장치 행을 적재 · 마이그레이션 틱', async () => {
  const { db, month } = await fresh();
  const P = await import('../src/bmusage/poller.js');
  const old = NOW - 80 * DAY;
  await db.insertUsage([{ key: 'P', ts: old, cpu_pct: 1 }, { key: 'P', ts: NOW - HOUR, cpu_pct: 2 }], '');
  const oldName = month.fileNameOf('raw', month.periodKeyOf('raw', old));
  assert.ok(fs.existsSync(path.join(DIR, oldName)));
  P._resetForTest();
  await P.bmUsageTimerTick();
  assert.ok(fs.existsSync(path.join(DIR, oldName)), '기동 첫 틱에는 지우지 않는다(v2.453)');
  for (let i = 1; i < 12; i++) await P.bmUsageTimerTick();
  assert.ok(!fs.existsSync(path.join(DIR, oldName)), '원시 30일 밖 월 파일은 파일째 지운다');
  assert.ok(P.bmUsageStatus().lastPrune?.files?.deleted?.includes(oldName), JSON.stringify(P.bmUsageStatus().lastPrune));
  assert.deepEqual(P.osStoreOpts({ partitionIo: true, blkqMax: 9, peakWindowS: 4, peakSampler: false, peakSamplerSha256: '' }), { partitionIo: true, blkqMax: 9, peakWindowS: 4, sampler: false, samplerSha: '' });
  const src = SRC('bmusage/poller.js');
  assert.match(src, /collectOsUsage\(target\.osHost, \{ signal, budgetMs: OS_BUDGET\.effective, \.\.\.osStoreOpts\(storeOf\(\), peakPlan\)(?:, \.\.\.\(logExtra \? \{ extraCommands: \[logExtra\] \} : \{\}\))?(?:, top)? \}\)/);   // v2.922: 주기 예산 결정을 함께 · 7a: 로그 읽기 exec
  assert.match(src, /insertUsage\(rows, config\.agent\?\.name \|\| '', \{ devices, mounts \}\)/);
  assert.match(src, /deviceMax: storeOf\(\)\.deviceMax/);
  assert.match(src, /ensureMonthMigration\(\)/);
});
