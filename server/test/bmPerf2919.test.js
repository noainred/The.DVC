/**
 * v2.919 리눅스 베어메탈 통합 성능 모니터링 — **1단계(서버)** 회귀 고정.
 * 설계: docs/design/linux-bm-perf/README.md §3.2 · §4 · §4.2 · §4.4.
 *
 * ⚠ 표본은 **커널 문서(proc.rst · psi.rst · iostats.rst) 형식 + 이 개발 컨테이너(커널 6.18 · dash)에서 실제로 돌린 출력**이다.
 *   이 현장 실장비(Rocky 9 · RHEL 8 베어메탈) 출력은 본 적이 없다 — 첫 실수집에서 sections·truncated 를 보고 좁힌다(정직 기록).
 *
 * 고정하는 것:
 *  ① 파서 — 정상(Rocky 9 형식) · PSI 없는 RHEL 8(absent) · 짧은 /proc/stat · 잘린 출력(missing + truncated)
 *  ② absent vs missing(readSection) · ③ rates 첫 표본·리셋 null · ④ USE 판정 경계값 · 병목/포화/오류 · 못 읽은 칸은 따로 센다
 *  ⑤ 교차 판정(둘 다 / 한쪽만) · ⑥ 커버리지 4등급 · ⑦ 중앙 정제 화이트리스트 · ⑧ 엣지 봉투 계약(실제 함수 호출)
 *  ⑨ 서버 상세 scope 404(실제 bmPerfView + 실제 라우터) · ⑩ ReDoS 비율 · ⑪ 세션 예산 산수 불변 · ⑫ ‘주기당 Redfish 호출 수 불변’ 소스 스윕
 *  ⑬ DB 마이그레이션(v2.918 스키마 → 새 열) · ⑭ 기준값 정규화·부분 저장
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { stripComments } from './_stripComments.js';

// config 싱글턴이 굳기 전에 임시 CONFIG_DIR(저장소 config 를 건드리지 않게 — bmUsagePerf2550 과 같은 이유).
const CFG = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bmperf2919-'));
const PREV_CFG = process.env.CONFIG_DIR;
process.env.CONFIG_DIR = CFG;
test.after(() => {
  if (PREV_CFG === undefined) delete process.env.CONFIG_DIR; else process.env.CONFIG_DIR = PREV_CFG;
  fs.rmSync(CFG, { recursive: true, force: true });
});

const SRC_DIR = path.join(import.meta.dirname, '../src');
const bare = (rel) => stripComments(fs.readFileSync(path.join(SRC_DIR, rel), 'utf8'));

const P = await import('../src/bmusage/parse/linuxProc.js');
const O = await import('../src/bmusage/collectors/osSsh.js');
const R = await import('../src/bmusage/rates.js');
const U = await import('../src/bmusage/usage.js');
const J = await import('../src/bmusage/useJudge.js');
const HW = await import('../src/bmusage/hwFacts.js');
const PV = await import('../src/bmusage/perfView.js');
const S = await import('../src/bmusage/settings.js');
const C = await import('../src/central/bmUsageEdgePull.js');
const { PERF_COLS, PERF_COL_NAMES } = await import('../src/bmusage/perfCols.js');

/* ── 표본(커널 문서 형식) ─────────────────────────────────────────────────── */
const base = ({ psi = true, oom = true, end = true, stat = null } = {}) => [
  '##STAT',
  ...(stat || [
    'intr 123456 0 0 0', 'ctxt 987654', 'btime 1700000000', 'processes 4242', 'procs_running 3', 'procs_blocked 1', 'softirq 1 2 3',
    'cpu  1000 10 500 8000 200 0 50 40 0 0', 'cpu0 500 5 250 4000 100 0 25 20 0 0', 'cpu1 500 5 250 4000 100 0 25 20 0 0',
  ]),
  '##MEM', 'MemTotal:       16000000 kB', 'MemAvailable:    8000000 kB', 'SwapTotal: 0 kB', 'SwapFree: 0 kB',
  'HugePages_Total:       0', 'HugePages_Free:        0', 'Hugepagesize:       2048 kB',
  '##DISK', ' 259       0 nvme0n1 1000 0 80000 500 2000 0 160000 3000 2 2500 3500 0 0 0 0',
  ' 259       1 nvme0n1p1 10 0 80 5 20 0 160 30 0 25 35',
  '##NET', 'Inter-|   Receive                                                |  Transmit',
  ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
  '    lo: 100 1 0 0 0 0 0 0 100 1 0 0 0 0 0 0',
  '  eth0: 1000 10 1 2 0 0 0 0 2000 20 3 4 0 0 0 0',
  ' veth9: 1000 10 0 50 0 0 0 0 2000 20 0 9 0 0 0 0',
  '##NETINFO', 'eth0 10000 up 1', 'veth9 10000 up 0',
  '##FC', '##TICK', '100', '##DF', '##HOST', 'Linux bm-kr1-db01 5.14.0-427.el9.x86_64',
  '##LOAD', '1.50 1.20 1.00 3/500 12345',
  '##PSI', ...(psi ? [
    'cpu some avg10=1.00 avg60=2.00 avg300=3.00 total=100', 'cpu full avg10=0.00 avg60=0.00 avg300=0.00 total=0',
    'memory some avg10=0.50 avg60=0.40 avg300=0.30 total=10', 'memory full avg10=0.20 avg60=0.10 avg300=0.05 total=5',
    'io some avg10=8.00 avg60=6.00 avg300=4.00 total=50', 'io full avg10=12.00 avg60=9.00 avg300=5.00 total=40',
  ] : []),
  '##VMSTAT', 'pswpin 10', 'pswpout 20', 'pgmajfault 300', ...(oom ? ['oom_kill 0'] : []),
  '##SNMP', 'Tcp: RtoAlgorithm RtoMin RtoMax MaxConn ActiveOpens PassiveOpens AttemptFails EstabResets CurrEstab InSegs OutSegs RetransSegs InErrs OutRsts InCsumErrors',
  'Tcp: 1 200 120000 -1 100 50 1 2 12 10000 20000 40 0 3 0',
  '##BLKQ', 'nvme0n1|[none] mq-deadline|1023|0', 'sda|mq-deadline kyber [bfq] none|64|1',
  '##SYSCTL', '/proc/sys/vm/swappiness:60', '/proc/sys/net/ipv4/tcp_rmem:4096\t131072\t6291456',
  '/sys/kernel/mm/transparent_hugepage/enabled:always [madvise] never', '/etc/passwd:root:x:0:0', '/proc/sys/vm/dirty_ratio:',
  '##IRQ', '128|8|32|eth0-TxRx-0', '129|1|32|eth0-TxRx-1', 'irqbalance=active',
  '##DFI', 'Filesystem      Inodes  IUsed   IFree IUse% Mounted on', '/dev/nvme0n1p2 1000000 250000 750000   25% /', '/dev/mapper/x 0 0 0 - /xfs',
  ...(end ? ['##END'] : []),
].join('\n');

/* ── ① 파서 ─────────────────────────────────────────────────────────────── */
test('① 정상(Rocky 9 형식) — 새 구획을 전부 읽고 구획 상태는 ok · truncated 아님', () => {
  const r = O.shapeLinux(base(), ['/']);
  assert.equal(r.truncated, false);
  for (const k of ['stat', 'load', 'psi', 'vmstat', 'snmp', 'blkq', 'sysctl', 'hugepages', 'irq', 'dfi']) {
    assert.equal(r.perf[k].missing, false, `${k} missing`); assert.equal(r.perf[k].absent, false, `${k} absent`);
  }
  const st = r.perf.stat.value;
  assert.equal(st.coreCount, 2, '코어 수 = cpuN 줄 수');
  assert.equal(st.ctxt, 987654); assert.equal(st.intr, 123456); assert.equal(st.procsRunning, 3); assert.equal(st.procsBlocked, 1);
  // 기존 규약 — idle 은 idle+iowait, 원시 idle 은 idleRaw(덮지 않는다 — 자체 실측에서 잡은 결함)
  assert.equal(st.cpu.idle, 8200); assert.equal(st.cpu.idleRaw, 8000); assert.equal(st.cpu.steal, 40);
  assert.deepEqual(r.counters.cpu, { total: 9800, idle: 8200 }, 'cpu_pct 입력은 예전 parseProcStat 그대로');
  assert.equal(r.counters.cpuExt.idle, r.counters.cpu.idle, '분해와 cpu_pct 가 같은 idle 을 쓴다');
  assert.deepEqual(r.perf.load.value, { load1: 1.5, load5: 1.2, load15: 1, runnable: 3, threads: 500 });
  assert.equal(r.perf.psi.value.io.full.avg10, 12); assert.equal(r.perf.psi.value.cpu.some.avg60, 2);
  assert.deepEqual(r.perf.vmstat.value, { pswpin: 10, pswpout: 20, pgmajfault: 300, oomKill: 0 });
  assert.equal(r.perf.snmp.value.retransSegs, 40); assert.equal(r.perf.snmp.value.outSegs, 20000);
  assert.deepEqual(r.perf.blkq.value.map((b) => [b.name, b.scheduler, b.rotational]), [['nvme0n1', 'none', false], ['sda', 'bfq', true]]);
  const sy = r.perf.sysctl.value;
  assert.equal(sy['vm.swappiness'], '60'); assert.equal(sy['thp.enabled'], 'madvise'); assert.equal(sy['net.ipv4.tcp_rmem'], '4096 131072 6291456');
  assert.equal(sy['vm.dirty_ratio'], null, '빈 값은 null(확인 불가 — 0 이 아니다)');
  assert.ok(!Object.values(sy).includes('root:x:0:0'), '화이트리스트 밖 경로는 받지 않는다');
  assert.deepEqual(r.perf.hugepages.value, { total: 0, free: 0, sizeKb: 2048 });
  assert.equal(r.perf.irq.value.irqbalance, 'active'); assert.equal(r.perf.irq.value.spreadMin, 1); assert.equal(r.perf.irq.value.spreadMax, 8);
  assert.equal(r.perf.dfi.value[0].iusePct, 25); assert.equal(r.perf.dfi.value[1].iusePct, null, 'xfs 동적 inode(0·-)는 사용률을 내지 않는다');
  // DISK 14열 · NET 16열
  const d = r.counters.disks.find((x) => x.name === 'nvme0n1');
  assert.deepEqual([d.reads, d.readTicksMs, d.writes, d.writeTicksMs, d.inFlight, d.weightedTicksMs], [1000, 500, 2000, 3000, 2, 3500]);
  assert.ok(!r.counters.disks.some((x) => x.name === 'nvme0n1p1'), '파티션은 예전처럼 뺀다');
  const e = r.counters.nets.find((x) => x.iface === 'eth0');
  assert.deepEqual([e.rxErrs, e.rxDrop, e.txErrs, e.txDrop, e.rxPackets, e.txPackets], [1, 2, 3, 4, 10, 20]);
});

test('① PSI 없는 RHEL 8 — 표지는 왔는데 0줄 = absent(못 읽음과 구분) · oom_kill 없는 커널은 그 칸만 null', () => {
  const r = O.shapeLinux(base({ psi: false, oom: false }), ['/']);
  assert.equal(r.perf.psi.absent, true); assert.equal(r.perf.psi.missing, false); assert.equal(r.perf.psi.value, null);
  assert.equal(r.perf.vmstat.value.oomKill, null);
  const b = U.buildPerf({ os: { ...r, ok: true }, pc: null, pAt: null, now: 1, lim: R.MAX_SPAN_MS });
  assert.equal(b.cols.psi_io_full10, null);
  assert.equal(b.detail.sections.psi, 'absent');
  assert.ok(b.notes.some((x) => x.includes('PSI')), 'PSI 없음을 노트가 말한다');
});

test('① 짧은 /proc/stat — 칸이 모자라면 그 칸만 null · 4칸 미만이면 못 읽음(missing)', () => {
  const four = O.shapeLinux(base({ stat: ['cpu  10 0 5 80', 'cpu0 10 0 5 80'] }), []);
  assert.equal(four.perf.stat.value.cpu.iowait, null, '옛 커널(4칸) — iowait 이후는 null');
  assert.equal(four.perf.stat.value.coreCount, 1);
  assert.equal(four.perf.stat.value.ctxt, null);
  const three = O.shapeLinux(base({ stat: ['cpu 1 2 3'] }), []);
  assert.equal(three.perf.stat.missing, true, '줄은 있는데 읽지 못하면 missing(absent 가 아니다)');
});

test('① 잘린 출력 — ##END 가 없으면 truncated, 표지가 오지 않은 구획은 missing', () => {
  const full = base();
  const cut = full.slice(0, full.indexOf('##PSI') + 6);
  const r = O.shapeLinux(cut, ['/']);
  assert.equal(r.truncated, true);
  assert.equal(r.perf.load.missing, false, '잘리기 전 구획은 읽는다');
  for (const k of ['vmstat', 'snmp', 'blkq', 'sysctl', 'irq', 'dfi']) assert.equal(r.perf[k].missing, true, k);
  const b = U.buildPerf({ os: { ...r, ok: true }, now: 1, lim: R.MAX_SPAN_MS });
  assert.ok(b.notes.some((x) => x.includes('잘려')));
});

/* ── ② absent vs missing ──────────────────────────────────────────────── */
test('② readSection — 표지 없음=missing · 빈 줄만=absent · 파싱 실패=missing · 값=값', () => {
  const fn = (ls) => (ls[0] === 'ok' ? 1 : null);
  assert.deepEqual(P.readSection({}, 'X', fn), { value: null, absent: false, missing: true });
  assert.deepEqual(P.readSection({ X: ['', '  '] }, 'X', fn), { value: null, absent: true, missing: false });
  assert.deepEqual(P.readSection({ X: ['bad'] }, 'X', fn), { value: null, absent: false, missing: true });
  assert.deepEqual(P.readSection({ X: ['ok'] }, 'X', fn), { value: 1, absent: false, missing: false });
  assert.deepEqual(P.readSection({ X: ['ok'] }, 'X', () => { throw new Error('x'); }), { value: null, absent: false, missing: true });
});

/* ── ③ rates ──────────────────────────────────────────────────────────── */
const sample = (mut = {}) => {
  const r = O.shapeLinux(base(), ['/']);
  return { ...r, ok: true, ...mut };
};
test('③ 첫 표본은 누적 칸이 전부 null(순간값 load·PSI 는 첫 주기부터) — 0 으로 채우지 않는다', () => {
  const b = U.buildPerf({ os: sample(), pc: null, pAt: null, now: 1_000_000, lim: R.MAX_SPAN_MS });
  for (const k of ['cpu_user_pct', 'cpu_sys_pct', 'cpu_core_max_pct', 'ctxt_ps', 'swap_out_ps', 'pgmajfault_ps', 'oom_kill_delta', 'disk_iops', 'disk_await_ms', 'disk_aqu', 'net_err_delta', 'net_drop_delta', 'tcp_retrans_pct']) {
    assert.equal(b.cols[k], null, `${k} 는 첫 표본에서 null`);
  }
  assert.equal(b.cols.load1, 1.5); assert.equal(b.cols.runq_per_core, 0.75, 'load1 1.5 ÷ 코어 2');
  assert.equal(b.cols.psi_io_full10, 12); assert.equal(b.cols.disk_inflight, 2); assert.equal(b.cols.procs_blocked, 1);
  assert.equal(b.detail.firstSample, true);
});

test('③ 두 표본 — 분해·코어 최고·await·IOPS·aqu·스왑·재전송·오류 증가분(물리 NIC 만) 계산', () => {
  const t0 = 1_000_000; const t1 = t0 + 300_000;
  const a = sample();
  const bTxt = base()
    .replace('cpu  1000 10 500 8000 200 0 50 40 0 0', 'cpu  1600 10 800 8400 300 0 50 140 0 0')
    .replace('cpu0 500 5 250 4000 100 0 25 20 0 0', 'cpu0 1050 5 500 4100 100 0 25 20 0 0')
    .replace('259       0 nvme0n1 1000 0 80000 500 2000 0 160000 3000 2 2500 3500', '259       0 nvme0n1 4000 0 80000 2000 5000 0 160000 7500 2 2500 603500')
    .replace('eth0: 1000 10 1 2 0 0 0 0 2000 20 3 4', 'eth0: 1000 10 6 2 0 0 0 0 2000 20 3 4')
    .replace('veth9: 1000 10 0 50', 'veth9: 1000 10 0 999')
    .replace('pswpout 20', 'pswpout 320')
    .replace('Tcp: 1 200 120000 -1 100 50 1 2 12 10000 20000 40 0 3 0', 'Tcp: 1 200 120000 -1 100 50 1 2 12 10000 21000 60 0 3 0');
  const b = sample(O.shapeLinux(bTxt, ['/']));
  const pc = a.counters;
  const out = U.buildPerf({ os: b, pc, pAt: t0, now: t1, lim: R.MAX_SPAN_MS });
  // Δtotal = (1600+10+800+8400+300+0+50+140) − 9800 = 1500 · user(+nice) Δ600 → 40% · sys Δ300 → 20% · iowait Δ100 → 6.7% · steal Δ100 → 6.7%
  assert.equal(out.cols.cpu_user_pct, 40); assert.equal(out.cols.cpu_sys_pct, 20); assert.equal(out.cols.cpu_iowait_pct, 6.7); assert.equal(out.cols.cpu_steal_pct, 6.7);
  assert.ok(out.cols.cpu_core_max_pct > 80, `cpu0 Δtotal 900 · Δidle 100 → 88.9% (${out.cols.cpu_core_max_pct})`);
  assert.equal(out.cols.disk_iops, 20, 'Δ(reads+writes) 6000 ÷ 300초');
  assert.equal(out.cols.disk_await_ms, 1, 'Δticks 6000ms ÷ Δios 6000');
  assert.equal(out.cols.disk_aqu, 2, 'Δweighted 600000ms ÷ 300000ms');
  assert.equal(out.cols.swap_out_ps, 1, 'Δ300 pages ÷ 300초');
  assert.equal(out.cols.tcp_retrans_pct, 2, 'ΔRetrans 20 ÷ ΔOutSegs 1000');
  assert.equal(out.cols.net_err_delta, 5, 'eth0 rx errs 1→6');
  assert.equal(out.cols.net_drop_delta, 0, '가상 인터페이스(veth) 드롭은 회선 드롭이 아니다 — 물리 NIC 만');
  assert.equal(out.streak.netErr, 1);
});

test('③ 카운터 리셋(음수)·간격 비정상은 null — 증가분·비율 모두', () => {
  assert.equal(R.deltaOrNull(10, 5, 0, 300_000), null);
  assert.equal(R.deltaOrNull(10, 15, 0, 300_000), 5);
  assert.equal(R.deltaOrNull(10, 15, 0, 500), null, '1초 미만 간격');
  assert.equal(R.deltaOrNull(10, 15, 0, R.MAX_SPAN_MS + 1), null, '간격 한계 초과');
  assert.equal(R.deltaOrNull(null, 15, 0, 300_000), null, '첫 표본');
  assert.equal(R.awaitMs({ reads: 1, writes: 1, readTicksMs: 1, writeTicksMs: 1 }, { reads: 1, writes: 1, readTicksMs: 1, writeTicksMs: 1 }, 0, 300_000), null, 'I/O 0건이면 await 를 지어내지 않는다');
  assert.equal(R.retransPct({ retransSegs: 1, outSegs: 5 }, { retransSegs: 1, outSegs: 5 }, 0, 300_000), null, '보낸 세그먼트 0');
  assert.deepEqual(R.cpuBreakdownPct({ total: 10 }, { total: 5 }, 0, 300_000), { user: null, sys: null, iowait: null, steal: null });
});

test('③ 연속 증가 — null 은 판정 보류(직전 연속값 유지) · 0 이면 끊는다', () => {
  const st = (prev, v) => U.buildPerf({ os: sample(), pc: null, now: 1, lim: R.MAX_SPAN_MS, prevStreak: prev }).streak;
  assert.deepEqual(st({ netErr: 2, netDrop: 0, oom: 1 }, null), { netErr: 2, netDrop: 0, oom: 1 }, '첫 표본(null)은 연속값을 바꾸지 않는다');
});

/* ── ④ USE 판정 ───────────────────────────────────────────────────────── */
const TH = S.PERF_DEFAULTS;
test('④ 경계값 — 기준과 같으면 그 등급(>=) · 바로 아래는 한 단계 낮다 · null 은 판정 보류', () => {
  assert.equal(J.grade(TH.utilWarn, TH.utilWarn, TH.utilBad), 'warn');
  assert.equal(J.grade(TH.utilWarn - 0.1, TH.utilWarn, TH.utilBad), 'ok');
  assert.equal(J.grade(TH.utilBad, TH.utilWarn, TH.utilBad), 'bad');
  assert.equal(J.grade(null, TH.utilWarn, TH.utilBad), null);
  assert.equal(J.grade('', TH.utilWarn, TH.utilBad), null, "Number('')===0 함정 — 빈 값은 0 이 아니다");
  assert.equal(J.gradeIncrease(0, 0, 3), 'ok');
  assert.equal(J.gradeIncrease(1, 2, 3), 'warn');
  assert.equal(J.gradeIncrease(1, 3, 3), 'bad', '반복(연속 주기) → bad');
  assert.equal(J.gradeIncrease(null, 9, 3), null);
});

test('④ 병목(둘 이상 bad) · 포화(S bad) · 오류(E bad) · 못 읽은 칸은 판정에 넣지 않고 따로 센다', () => {
  const det = { osKind: 'linux', sections: { psi: 'ok' }, disks: [{ name: 'nvme1n1', aqu: 6 }], nics: [{ iface: 'eth0', errDelta: 4 }], streak: { netErr: 5 } };
  const b = J.judgeUse({ row: { src: 'os', disk_busy_pct: 95, disk_aqu: 6, psi_io_full10: 12, cpu_pct: 10 }, detail: det, coverage: 'os', th: TH });
  assert.equal(b.perResource.disk, 'bottleneck'); assert.equal(b.verdict, 'bottleneck'); assert.equal(b.focus, 'disk');
  assert.match(b.line, /^디스크 병목 — nvme1n1 평균 대기열 6/);
  assert.ok(!b.line.includes('`') && !b.line.includes('**'), '문구에 백틱·별표 금지');
  const sat = J.judgeUse({ row: { src: 'os', disk_busy_pct: 10, disk_aqu: 6 }, detail: det, coverage: 'os', th: TH });
  assert.equal(sat.perResource.disk, 'saturated');
  const err = J.judgeUse({ row: { src: 'os', net_err_delta: 4, net_pct: 1 }, detail: det, coverage: 'os', th: TH });
  assert.equal(err.perResource.net, 'errors');
  // 못 읽은 칸: 판정에 넣지 않는다 — 전부 missing 이면 '판정 불가', 정상으로 세지 않는다
  const none = J.judgeUse({ row: {}, detail: { osKind: 'linux', sections: {} }, coverage: 'os', th: TH });
  assert.equal(none.verdict, 'unknown'); assert.equal(none.counts.ok, 0);
  assert.ok(none.counts.missing > 0);
});

test('④ PSI absent 는 none(없음) — missing 과 다른 칸 · 경로가 없으면 nopath · Windows 는 OS 포화 칸이 nopath', () => {
  const r = J.judgeUse({ row: { src: 'os', runq_per_core: 0.5 }, detail: { osKind: 'linux', sections: { psi: 'absent' } }, coverage: 'os', th: TH });
  assert.equal(r.cells.cpu.S.code, 'ok', 'PSI 가 없어도 런큐로 판정한다');
  assert.equal(r.cells.cpu.S.basis.find((x) => x.key === 'psi_cpu_some10').code, 'none');
  const r2 = J.judgeUse({ row: {}, detail: { osKind: 'linux', sections: { psi: 'absent' } }, coverage: 'os', th: TH });
  assert.equal(r2.cells.mem.S.code, 'missing', '스왑은 첫 표본(missing) + PSI absent → missing(전부 absent 일 때만 none)');
  assert.equal(r2.cells.hw.U.code, 'nopath', 'OS 만인 서버의 하드웨어 축은 경로 없음');
  const w = J.judgeUse({ row: { cpu_pct: 50 }, detail: { osKind: 'windows' }, coverage: 'os', th: TH });
  assert.equal(w.cells.cpu.S.code, 'nopath'); assert.equal(w.cells.cpu.U.code, 'ok');
  const id = J.judgeUse({ row: { cpu_pct: 95 }, detail: null, hw: HW.shapeHwFacts({}), coverage: 'idrac', th: TH });
  assert.equal(id.cells.cpu.S.code, 'nopath', 'iDRAC 만 — 런큐·PSI 는 경로 없음'); assert.equal(id.cells.cpu.U.code, 'bad');
});

test('④ 기준값은 API(설정)에서 온다 — 기준을 바꾸면 판정이 바뀐다', () => {
  const row = { src: 'os', cpu_pct: 85 };
  assert.equal(J.judgeUse({ row, coverage: 'os', th: TH }).cells.cpu.U.code, 'warn');
  assert.equal(J.judgeUse({ row, coverage: 'os', th: { ...TH, utilWarn: 86 } }).cells.cpu.U.code, 'ok');
});

test('④ OS↔iDRAC CPU 불일치 — 둘 다 있을 때만 · 기준 이상이면 flag · 어느 쪽이 맞는지 단정하지 않는다', () => {
  const hw = HW.shapeHwFacts({ sensor: { t: 1_000, cpu: 40, temps: {} } }, { now: 1_000 });
  const r = J.judgeUse({ row: { src: 'os', cpu_pct: 60 }, hw, coverage: 'both', th: TH });
  assert.deepEqual(r.mismatch.cpu, { os: 60, idrac: 40, diffPp: 20, flag: true });
  const r2 = J.judgeUse({ row: { src: 'idrac', cpu_pct: 60 }, hw, coverage: 'both', th: TH });
  assert.equal(r2.mismatch, null, '행이 iDRAC 출처면 OS 값이 없다');
});

/* ── ⑤ 교차 판정 · ⑥ 커버리지 ──────────────────────────────────────────── */
test('⑤ 교차 판정은 둘 다 읽힌 서버에서만 — 한쪽만이면 전부 nopath', () => {
  const use = J.judgeUse({ row: { src: 'os', runq_per_core: 3 }, coverage: 'os', th: TH });
  assert.ok(J.crossJudge({ use, hw: null, coverage: 'os', th: TH }).every((c) => c.state === 'nopath'));
});
test('⑤ ① 전력 cap 근접 + 런큐↑ → 후보 · ② await↑ + SMART 예측 장애 → 교체 후보 / 깨끗하면 I/O 양 · ④ CRC 를 받지 않으면 missing', () => {
  const now = 10_000_000;
  const hw = HW.shapeHwFacts({
    power: { watts: 470, ts: now }, inv: { collectedAt: now, powerCap: { limitWatts: 500 }, collections: {}, disks: [{ name: 'Disk.Bay.1', predictiveFailure: true }], memoryDimms: [{ locator: 'A1', health: 'OK' }] },
    sensor: { t: now, cpu: 50, temps: { 'System Board Inlet Temp': 24 } }, faults: [],
  }, { now });
  assert.equal(hw.power.capPct, 94); assert.equal(hw.inletC, 24); assert.deepEqual(hw.diskPredicted, ['Disk.Bay.1']);
  const use = J.judgeUse({ row: { src: 'os', runq_per_core: 3, disk_aqu: 5, net_drop_delta: 7 }, detail: { osKind: 'linux', sections: {}, streak: {} }, hw, coverage: 'both', th: TH });
  const cr = J.crossJudge({ use, hw, coverage: 'both', th: TH });
  assert.equal(cr[0].state, 'candidate'); assert.equal(cr[0].code, 'power-thermal-limit');
  assert.equal(cr[1].state, 'candidate'); assert.equal(cr[1].code, 'replace-candidate');
  assert.equal(cr[2].state, 'inactive', 'DIMM 이 정상이면 ③ 은 서지 않는다');
  assert.equal(cr[3].state, 'missing', 'iDRAC CRC 는 이 저장소가 받지 않는다 — 단정하지 않는다');
  const clean = HW.shapeHwFacts({ inv: { collectedAt: now, collections: {}, disks: [{ name: 'd', predictiveFailure: false }] } }, { now });
  const cr2 = J.crossJudge({ use, hw: clean, coverage: 'both', th: TH });
  assert.equal(cr2[1].code, 'io-volume');
  assert.equal(cr2[0].state, 'missing', '전력·흡기 둘 다 못 읽으면 missing');
});
test('⑥ 커버리지 4등급 — 신선도 한계 안의 마지막 성공 기준 · iDRAC 은 주 폴러 사실(hw.read)로도 읽힌 것', () => {
  const now = 100 * 60_000; const fresh = 15 * 60_000;
  assert.equal(J.coverageOf({ osAt: now, idracAt: now, now, freshMs: fresh }), 'both');
  assert.equal(J.coverageOf({ osAt: now, now, freshMs: fresh }), 'os');
  assert.equal(J.coverageOf({ hwRead: true, now, freshMs: fresh }), 'idrac');
  assert.equal(J.coverageOf({ osAt: now - fresh - 1, now, freshMs: fresh }), 'none', '오래된 성공은 읽힌 것이 아니다');
  assert.equal(J.freshMsFor(300_000), 15 * 60_000);
  assert.equal(J.freshMsFor(3_600_000), 3 * 3_600_000);
});

/* ── ⑦ 중앙 정제 ─────────────────────────────────────────────────────── */
test('⑦ 중앙 정제 화이트리스트 — 모르는 필드 제거 · 문자열 수치는 수로 · 상한 · enum 밖은 missing · 판정을 다시 하지 않는다', () => {
  const disks = Array.from({ length: 40 }, (_, i) => ({ name: `sd${i}`, aqu: '1.5', evil: 1 }));
  const snap = C.sanitizeBmUsageSnap({
    rows: [{ key: 'K1', cpu_pct: 'oops', runq_per_core: '1.5', psi_io_full10: '', detail_json: '{"x":1}', tuning_json: 'x' }],
    perf: [{
      key: 'K1', verdict: 'bottleneck', focus: 'disk', line: 'x'.repeat(1000), coverage: 'both', __proto__x: 1, injected: { a: 1 },
      codes: { cpu: { U: 'ok', S: 'pwned', E: 'bad' } }, counts: { ok: '3', evil: 9 },
      cross: [{ id: '1', state: 'candidate', code: 'power-thermal-limit', extra: 1 }, 'str'],
      detail: { disks, streak: { netErr: '2' }, sections: { psi: 'absent', hack: 'ok' }, osKind: 'evil' },
      tuning: { sysctl: { 'vm.swappiness': 60, 'evil.key': 'x' } },
      hw: { read: true, throttle: true, dimmBad: ['A1', { x: 1 }], faults: [{ kind: 'dimm', label: 'A1', state: 'fault', x: 2 }] },
    }, 'not-object'],
    perfThresholds: { utilWarn: '80', evil: 1 },
  });
  assert.equal(snap.rows[0].runq_per_core, 1.5, '새 열의 문자열 수치는 수로');
  assert.equal(snap.rows[0].psi_io_full10, null, '빈 값은 null(0 이 아니다)');
  assert.equal(snap.rows[0].cpu_pct, 'oops', '기존 열 계약(원시값 그대로 — CEN2604-03)은 바꾸지 않는다');
  assert.ok(!('detail_json' in snap.rows[0]) && !('tuning_json' in snap.rows[0]), 'JSON 문자열 열은 받지 않는다(perf 객체로 온다)');
  const p = snap.perf[0];
  assert.equal(snap.perf.length, 1); assert.ok(snap.sanitizeDropped >= 1, '버린 원소 수를 밝힌다');
  assert.ok(!('injected' in p) && !('__proto__x' in p));
  assert.equal(p.verdict, 'bottleneck', '엣지 판정 그대로(다시 판정하지 않는다)');
  assert.equal(p.line.length, 300);
  assert.equal(p.codes.cpu.S, 'missing', 'enum 밖 code 는 missing');
  assert.deepEqual(p.counts, { ok: 3, warn: 0, bad: 0, none: 0, missing: 0, nopath: 0, stale: 0 });
  assert.deepEqual(p.cross, [{ id: 1, state: 'candidate', code: 'power-thermal-limit' }]);
  assert.equal(p.detail.disks.length, 32, '장치 행 상한'); assert.equal(p.detail.disks[0].aqu, 1.5); assert.ok(!('evil' in p.detail.disks[0]));
  assert.equal(p.detail.streak.netErr, 2); assert.deepEqual(p.detail.sections, { psi: 'absent' }); assert.equal(p.detail.osKind, null);
  assert.deepEqual(p.tuning.sysctl, { 'vm.swappiness': '60' }, '모르는 sysctl 키는 버린다 · 값은 글자로');
  assert.equal(p.hw.throttle, null, '받지 않는 값은 엣지가 무엇을 보내든 null'); assert.deepEqual(p.hw.dimmBad, ['A1']);
  assert.deepEqual(p.hw.faults, [{ kind: 'dimm', label: 'A1', state: 'fault' }]);
  assert.equal(snap.perfThresholds.utilWarn, 80); assert.ok(!('evil' in snap.perfThresholds));
});

/* ── ⑧ 엣지 봉투 계약 ─────────────────────────────────────────────────── */
test('⑧ 엣지 봉투 — 실제 buildBmUsageEnvelope 호출: perf·기준값·열 대응이 실리고 꺼져 있어도 응답 · 중앙 정제를 통과한다', async () => {
  const E = await import('../src/bmusage/edgePull.js');
  const env = await E.buildBmUsageEnvelope({});
  assert.equal(typeof env.enabled, 'boolean', '켜짐 여부를 늘 싣는다(꺼져 있어도 응답 — 데모 모드면 켜짐)');
  assert.ok(Array.isArray(env.perf)); assert.equal(env.perfVersion, 1);
  assert.deepEqual(Object.keys(env.perfThresholds).sort(), Object.keys(S.PERF_DEFAULTS).sort());
  assert.equal(env.perfCols.length, PERF_COLS.length);
  assert.ok('truncated' in env);
  const cleaned = C.sanitizeBmUsageSnap(JSON.parse(JSON.stringify(env)));
  assert.equal(cleaned.perfCols.length, PERF_COLS.length); assert.deepEqual(cleaned.perfThresholds, env.perfThresholds);
  // 행이 있을 때 — perfForRows 가 판정을 붙이고 stripJsonCols 가 JSON 문자열 열을 뗀다
  const now = 50 * 60_000;
  const row = { key: 'K1', ts: now, src: 'os', os_at: now, cpu_pct: 95, disk_aqu: 9, detail_json: U.jsonCol({ osKind: 'linux', sections: { psi: 'ok' }, disks: [{ name: 'sda', aqu: 9 }] }), tuning_json: U.jsonCol({ sysctl: { 'vm.swappiness': '10' } }) };
  const { perf } = await E.perfForRows([row], [{ key: 'K1', idrac: null }], { intervalMs: 300_000, perf: S.PERF_DEFAULTS }, { full: true, now });
  assert.equal(perf[0].coverage, 'os'); assert.equal(perf[0].perResource.disk, 'saturated'); assert.equal(perf[0].tuning.sysctl['vm.swappiness'], '10');
  assert.ok(!('detail_json' in E.stripJsonCols(row)));
  const back = C.sanitizeBmUsageSnap({ perf: JSON.parse(JSON.stringify(perf)) }).perf[0];
  assert.equal(back.perResource.disk, 'saturated'); assert.equal(back.cells.disk.S.code, 'bad'); assert.equal(back.detail.disks[0].name, 'sda');
});

test('⑧ buildUsage 행 — 새 열·두 경로 읽은 시각·JSON 열이 실리고 _prev(next)에 연속값이 담긴다', () => {
  const os = { ...O.shapeLinux(base(), ['/']), ok: true };
  const b = U.buildUsage({ target: { key: 'K1' }, os, now: 1_000_000 });
  for (const c of PERF_COL_NAMES) assert.ok(c in b.row, c);
  assert.equal(b.row.os_at, 1_000_000); assert.equal(b.row.idrac_at, null);
  assert.equal(JSON.parse(b.row.detail_json).osKind, 'linux'); assert.equal(JSON.parse(b.row.tuning_json).sysctl['vm.swappiness'], '60');
  assert.deepEqual(b.next.streak, { netErr: 0, netDrop: 0, oom: 0 });
  const id = U.buildUsage({ target: { key: 'K2' }, idrac: { ok: true, cpuPct: 10 }, now: 5 });
  assert.equal(id.row.idrac_at, 5); assert.equal(id.row.detail_json, null);
  assert.ok(U.jsonCol({ big: 'x'.repeat(70_000) }).includes('"truncated":true'), 'JSON 열 상한 — 잘린 JSON 을 만들지 않는다');
});

/* ── ⑨ 서버 상세 scope 404 ──────────────────────────────────────────── */
test('⑨ 서버 상세(bmPerfView) — 범위 밖·귀속 없음·없는 키는 404(존재 은닉) · 범위 안은 200 · 엣지 보관분은 엣지 판정 그대로', async () => {
  const { bmPerfView } = await import('../src/routes/api/bmUsage.js');
  const AG = (await import('../src/config.js')).config.agent?.name || '';   // 적재 키와 조회 키가 같아야 한다(poller insertUsage 와 같은 식)
  const now = Date.now();
  const targets = [
    { key: 'TAG-A', name: 'a', vcenterId: 'vc-a', paths: ['os'], osHost: { host: 'h' }, idrac: null },
    { key: 'TAG-U', name: 'u', vcenterId: '', paths: ['os'], osHost: { host: 'h2' }, idrac: null },
  ];
  const deps = {
    currentTargets: async () => ({ targets }),
    latestUsage: async () => [{ agent: 'OTHER-NODE', key: 'TAG-A', ts: now, cpu_pct: 99 }, { agent: AG, key: 'TAG-A', ts: now, src: 'os', os_at: now, cpu_pct: 50, detail_json: U.jsonCol({ osKind: 'linux', sections: {} }) }],
    hwFactsReader: async () => () => null,
    bmAddressHosts: async () => [],
    listEdgeBmUsage: async () => [{ agent: 'EDGE1', snapAt: now, snap: { targets: [{ key: 'TAG-E', vcenterId: 'vc-b' }], perf: [{ key: 'TAG-E', verdict: 'saturated', line: '디스크 포화' }], perfThresholds: { utilWarn: 70 } } }],
  };
  const req = (scope, key, role = 'admin') => ({ user: { username: 'u', role, scope }, params: { key } });
  const snap = { vcenters: [] };
  const full = await bmPerfView(req(null, 'TAG-A'), snap, deps);
  assert.equal(full.ok, true); assert.equal(full.via, 'local'); assert.equal(full.entry.cells.cpu.U.code, 'ok', '다른 노드(agent) 행을 섞지 않는다');
  assert.equal(full.entry.coverage, 'os'); assert.ok(full.perfThresholds && full.perfCols, '기준값·열 대응을 함께 내려준다');
  assert.ok(!JSON.stringify(full.target).includes('password'), '자격증명 없음');
  assert.equal((await bmPerfView(req({ vcenters: ['vc-b'] }, 'TAG-A'), snap, deps)).__status, 404, '범위 밖 → 404');
  assert.equal((await bmPerfView(req({ vcenters: ['vc-a'] }, 'TAG-A'), snap, deps)).ok, true, '범위 안 → 200');
  assert.equal((await bmPerfView(req({ vcenters: ['vc-a'] }, 'TAG-U'), snap, deps)).__status, 404, '귀속 없는 서버는 범위 계정에 노출하지 않는다');
  assert.equal((await bmPerfView(req(null, 'TAG-U'), snap, deps)).ok, true, '전체 범위는 귀속 없는 서버도 본다');
  assert.equal((await bmPerfView(req(null, 'NOPE'), snap, deps)).__status, 404);
  const edge = await bmPerfView(req(null, 'TAG-E'), snap, deps);
  assert.equal(edge.via, 'edge'); assert.equal(edge.entry.verdict, 'saturated', '엣지 판정 그대로'); assert.equal(edge.perfThresholds.utilWarn, 70, '그 엣지의 기준값');
  assert.equal((await bmPerfView(req({ vcenters: ['vc-a'] }, 'TAG-E'), snap, deps)).__status, 404, '엣지 서버도 범위 밖이면 404');
  assert.equal((await bmPerfView(req({ vcenters: ['vc-b'] }, 'TAG-E', 'operator'), snap, deps)).entry.key, 'TAG-E');
});

test('⑨ 실제 라우터 — /api/tools/bm-usage/perf/:key 없는 키는 범위·전체 모두 404(500 아님) · 주 조회에 perf·기준값이 실린다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmperf2919-app-'));
  const script = `
    const express = (await import('express')).default;
    const { api } = await import(${JSON.stringify(path.join(SRC_DIR, 'routes/api.js'))});
    const mk = (scope) => { const app = express(); app.use((req, _r, n) => { req.user = { username: 'u', role: 'admin', scope }; n(); }); app.use('/api', api); return app; };
    const out = {};
    for (const [name, scope] of [['scoped', { vcenters: ['vc-a'] }], ['full', null]]) {
      const srv = await new Promise((r) => { const s = mk(scope).listen(0, '127.0.0.1', () => r(s)); });
      const base = 'http://127.0.0.1:' + srv.address().port;
      const a = await fetch(base + '/api/tools/bm-usage/perf/NOPE'); const ab = await a.json().catch(() => null);
      const m = await fetch(base + '/api/tools/bm-usage'); const mb = await m.json().catch(() => null);
      out[name] = { perf: a.status, perfBody: ab, cc: a.headers.get('cache-control'), main: m.status, mainKeys: Object.keys(mb || {}) };
      srv.close();
    }
    console.log('@@' + JSON.stringify(out));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, AUTH_ENABLED: 'false' }, encoding: 'utf8', cwd: path.resolve(SRC_DIR, '..'), timeout: 180_000,
  });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr.slice(-1500));
  const o = JSON.parse(r.stdout.split('\n').find((l) => l.startsWith('@@')).slice(2));
  for (const k of ['scoped', 'full']) {
    assert.equal(o[k].perf, 404, `${k}: ${JSON.stringify(o[k].perfBody)}`);
    assert.ok(!('__status' in o[k].perfBody), '내부 상태 필드는 본문에 남기지 않는다');
    assert.ok(!String(o[k].cc || '').includes('must-revalidate'), '404 는 캐시(sendCached) 경로로 보내지 않는다');
    assert.equal(o[k].main, 200);
    for (const f of ['perf', 'perfThresholds', 'perfDefaults', 'perfCols']) assert.ok(o[k].mainKeys.includes(f), `${k} 주 조회 ${f}`);
  }
});

test('⑨ 도구 접근 매핑 — 상세는 bm-usage 세그먼트 아래(새 세그먼트 bm-perf 를 만들지 않는다)', () => {
  const s = bare('routes/api/bmUsage.js');
  assert.match(s, /api\.get\('\/tools\/bm-usage\/perf\/:key', toolsPerm,/);
  assert.ok(!/'\/tools\/bm-perf/.test(s), '새 세그먼트는 toolsDenied 매핑 밖이다');
  // v2.932(E1-08): 열쇠는 perfKey(범위 서명 + 엣지 보관분 세대)로 모았다 — memoJson 이 그 열쇠를 쓰고, 열쇠에 범위 서명이 있는지 본다.
  assert.match(s, /memoJson\(req, res, 'bm-perf'[\s\S]{0,200}extraKey: await perfKey\(req\)/, 'memoJson + 열쇠');
  assert.match(s, /export const perfKey = async \(req\) => `\$\{scopeKey\(req\.user/, '열쇠에 범위 서명');
});

/* ── ⑩ ReDoS 비율 ─────────────────────────────────────────────────────── */
test('⑩ ReDoS — 새 파서는 입력 10배에 시간 약 10배(선형) · 긴 줄은 먼저 자른다', () => {
  const evil = (k) => {
    const lines = [];
    for (let i = 0; i < k; i += 1) {
      lines.push(`cpu${i} ${' 1'.repeat(200)} x`, `memory some avg10=${'1'.repeat(300)}`, `x|${'['.repeat(300)}|1|1`, `/proc/sys/vm/swappiness${' '.repeat(400)}`, `1.${'0'.repeat(400)} y`);
    }
    return lines;
  };
  const run = (k) => {
    const ls = evil(k);
    const t0 = process.hrtime.bigint();
    P.parseProcStatFull(ls); P.parsePsi(ls); P.parseBlkq(ls); P.parseSysctl(ls); P.parseLoadavg(ls); P.parseIrq(ls); P.parseDfInodes(ls); P.parseSnmpTcp(ls);
    return Number(process.hrtime.bigint() - t0) / 1e6;
  };
  run(200);
  const a = Math.max(run(400), 0.5); const b = run(4_000);
  assert.ok(b / a < 40, `10배 입력에 ${Math.round(b / a)}배 — 선형이 아니다(${a.toFixed(1)}ms → ${b.toFixed(1)}ms)`);
  const huge = P.splitSections(`##STAT\n${'9'.repeat(5_000_000)}\n##END`);
  assert.equal(huge.STAT[0].length, P.MAX_LINE_CHARS, '줄 길이를 먼저 자른다');
});

/* ── ⑪ 세션 예산 산수 불변 · 명령 ─────────────────────────────────────── */
test('⑪ 세션 예산 산수 불변 — 50초 < 장비 시한 60초 · 최소 조각 5초 · 출력 상한 < SSH 출력 상한 · 왕복 1회', () => {
  assert.equal(O.SESSION_BUDGET_MS, 50_000); assert.equal(O.MIN_SLICE_MS, 5_000);
  assert.ok(O.OUTPUT_MAX_BYTES < 4 * 1024 * 1024, '우리가 먼저 잘라야 sshExec 4MB 상한에서 결과가 통째로 버려지지 않는다');
  const s = bare('bmusage/collectors/osSsh.js');
  assert.equal((s.match(/await exec\(linuxCommand\(/g) || []).length, 1, 'Linux 명령은 세션당 1회');
  const cmd = O.linuxCommand(['/', '/data']);
  for (const m of ['##STAT', '##LOAD', '##PSI', '##VMSTAT', '##SNMP', '##BLKQ', '##SYSCTL', '##IRQ', '##DFI', '##END']) assert.ok(cmd.includes(`echo '${m}'`), m);
  assert.ok(!cmd.includes('head -1 /proc/stat'), '/proc/stat 은 전체(cpuN·ctxt·procs)');
  assert.ok(cmd.includes('df -P -i -- / /data'), 'inode 는 sanitize 된 마운트만');
  assert.ok(cmd.endsWith(`| head -c ${O.OUTPUT_MAX_BYTES}`), '총량 상한');
  assert.ok(cmd.indexOf("echo '##HOST'") < cmd.indexOf("echo '##LOAD'"), '새 구획은 기존 구획 뒤 — 잘려도 예전 지표는 남는다');
  assert.ok(!/\bsudo\b|authorized_keys|tuned-adm|ethtool/.test(cmd), '읽기 전용 · sudo 없음');
  assert.ok(!/\bread -r v </.test(cmd), 'sysctl 파일을 셸 read 로 읽지 않는다(dash 1바이트 읽기 — 실측 결함)');
});

test('⑪ 명령은 실제 셸(sh)에서 문법 오류 없이 돈다 — 이 컨테이너에서 실행해 구획 표지가 전부 온다', () => {
  const r = spawnSync('sh', ['-c', O.linuxCommand(['/'])], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr.slice(0, 500));
  const sh = O.shapeLinux(r.stdout, ['/']);
  assert.ok(sh, '구획 표지를 인식');
  assert.equal(sh.truncated, false);
  assert.ok(sh.perf.stat.value && sh.perf.stat.value.coreCount >= 1);
  assert.ok(sh.perf.load.value);
  assert.ok(sh.perf.sysctl.value && /^\d+$/.test(String(sh.perf.sysctl.value['vm.swappiness'] || '')), `swappiness 를 온전히 읽는다: ${sh.perf.sysctl.value?.['vm.swappiness']}`);
});

/* ── ⑫ ‘주기당 Redfish 호출 수 불변’ ──────────────────────────────────── */
test('⑫ 하드웨어 사실은 이미 가진 데이터만 — 새 모듈은 redfish·fetch 를 부르지 않는다 · 폴러의 iDRAC 호출 지점 수 불변', () => {
  for (const f of ['bmusage/hwFacts.js', 'bmusage/useJudge.js', 'bmusage/perfView.js', 'bmusage/perfCols.js', 'central/bmPerfSanitize.js']) {
    const s = bare(f);
    assert.ok(!/redfish|fetchPower|fetchSensors|fetchInventory|fetchUsage|\bfetch\(|resilientFetch|undici/.test(s), `${f} 가 장비 호출 경로를 참조한다`);
  }
  const ep = bare('bmusage/edgePull.js');
  assert.ok(!/redfish|fetchUsage|\bfetch\(/.test(ep));
  // bmusage 폴러가 부르는 iDRAC 경로는 예전 그대로 둘(텔레메트리 1 · Enterprise 대체 1)이다.
  const poller = bare('bmusage/poller.js');
  assert.equal((poller.match(/m\.fetchUsage\(/g) || []).length, 1);
  assert.equal((poller.match(/collectEnterpriseUsage\(/g) || []).length, 1);
  const hw = bare('bmusage/hwFacts.js');
  assert.match(hw, /idb\.latest\(id\)/, '전력은 idrac/db 최신값 캐시');
  assert.match(hw, /getInventory\(id\)/, 'cap·DIMM·SMART·SEL 은 인벤토리 캐시');
  assert.match(hw, /getSensorSeries\(id/, '흡기·CPU 는 센서 링버퍼');
  assert.match(hw, /partFaultDbExists\(\) \? await pf\.openFaults/, '부품 장애 DB 가 없으면 만들지 않는다');
});

/* ── ⑬ DB 마이그레이션 ────────────────────────────────────────────────── */
test('⑬ DB — v2.918 스키마 DB 에 migratePerfColumns 를 돌리면 새 열을 더하고(기존 행 보존 · 멱등) 실제 적재·롤업·최신값이 새 열을 쓴다', async () => {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { console.log('  (node:sqlite 없음 — 건너뜀)'); return; }
  const db = await import('../src/bmusage/db.js');
  // A. 옛 스키마(v2.918 CREATE 그대로) 파일 — 마이그레이션 함수만
  const file = path.join(CFG, 'old-2918.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE usage_history (agent TEXT NOT NULL DEFAULT '', key TEXT NOT NULL, ts INTEGER NOT NULL, name TEXT, vcenter_id TEXT, src TEXT,
      cpu_pct REAL, mem_pct REAL, disk_busy_pct REAL, disk_used_pct REAL, net_pct REAL, net_bps REAL, hba_pct REAL, hba_bps REAL, io_pct REAL, PRIMARY KEY (agent, key, ts));
    CREATE TABLE usage_daily (agent TEXT NOT NULL DEFAULT '', key TEXT NOT NULL, day TEXT NOT NULL, name TEXT, vcenter_id TEXT,
      cpu_sum REAL DEFAULT 0, cpu_n INTEGER DEFAULT 0, cpu_max REAL, mem_sum REAL DEFAULT 0, mem_n INTEGER DEFAULT 0, mem_max REAL,
      disk_busy_max REAL, disk_used_max REAL, net_max REAL, net_bps_max REAL, hba_max REAL, hba_bps_max REAL, io_max REAL,
      samples INTEGER NOT NULL DEFAULT 0, last_ts INTEGER, PRIMARY KEY (agent, key, day));
    CREATE TABLE usage_latest (agent TEXT NOT NULL DEFAULT '', key TEXT NOT NULL, ts INTEGER NOT NULL, name TEXT, vcenter_id TEXT, src TEXT,
      cpu_pct REAL, mem_pct REAL, disk_busy_pct REAL, disk_used_pct REAL, net_pct REAL, net_bps REAL, hba_pct REAL, hba_bps REAL, io_pct REAL, PRIMARY KEY (agent, key));`);
  old.prepare('INSERT INTO usage_latest (agent,key,ts,cpu_pct) VALUES (?,?,?,?)').run('', 'OLD', 1, 33);
  const r1 = db.migratePerfColumns(old);
  // v2.922: 최신값에 피크 열(8 × 2) · 피크 메타 3 · 장치 상한 초과 1 이 더해졌다(3a — 3단 저장 구조).
  // v2.993: 최신값 전용 src_cm(CPU · 메모리 지표별 출처) 1칸 더
  assert.equal(r1.added, PERF_COL_NAMES.length * 3 + 4 + 16 + 3 + 1 + 1, '이력·롤업·최신값 × 새 열 + 최신값 전용 4 + v2.922 피크 20 + v2.993 src_cm');
  assert.equal(db.migratePerfColumns(old).added, 0, '멱등');
  const row = old.prepare("SELECT * FROM usage_latest WHERE key='OLD'").get();
  assert.equal(row.cpu_pct, 33, '기존 행 보존'); assert.equal(row.runq_per_core, null, '기존 행의 새 열은 null(0 이 아니다)');
  const cols = old.prepare('PRAGMA table_info(usage_daily)').all().map((c) => c.name);
  assert.ok(cols.includes('disk_aqu_max') && cols.includes('net_err_delta_max'));
  old.close();
  // B. 실제 모듈 DB 왕복(이 프로세스의 bm-usage.db — openDb 가 같은 마이그레이션을 탄다)
  db._resetForTest();
  assert.equal(await db.available(), true);
  const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 3_600_000;
  const ins = await db.insertUsage([{ key: 'NEW', ts: hour + 60_000, src: 'os', cpu_pct: 10, runq_per_core: 1.25, disk_aqu: 3, os_at: hour + 60_000, detail_json: '{"v":1}', tuning_json: '{"v":1}' }], 'T');
  assert.deepEqual(ins, { ok: true, inserted: 1, duplicates: 0 });
  await db.insertUsage([{ key: 'NEW', ts: hour + 120_000, src: 'idrac', cpu_pct: 11, runq_per_core: '', idrac_at: hour + 120_000 }], 'T');
  // v2.922(D13): JSON 열은 판정 소비처만 읽는다 — { json:true } 판본.
  const L = (await db.latestUsage({ json: true })).find((r) => r.key === 'NEW' && r.agent === 'T');
  assert.equal(L.runq_per_core, null, "빈 문자열은 0 이 아니라 null(Number('')===0 함정)");
  assert.equal(L.os_at, hour + 60_000, 'OS 를 이번에 못 읽었으면 마지막 OS 시각을 지킨다(COALESCE)');
  assert.equal(L.idrac_at, hour + 120_000); assert.equal(L.detail_json, null, '장치별 JSON 은 마지막 표본 그대로(옛 장치값을 섞지 않는다)');
  const daily = (await db.usageDaily({ key: 'NEW', agent: 'T', days: 3 }))[0];
  assert.equal(daily.runq_per_core_max, 1.25, '일 롤업은 새 열의 최대(null 은 최대를 지우지 않는다)'); assert.equal(daily.disk_aqu_max, 3); assert.equal(daily.samples, 2);
  const hist = await db.usageHistory('NEW', { agent: 'T', hours: 48 });
  assert.equal(hist.rows[0].runq_per_core, 1.25); assert.ok(!('detail_json' in hist.rows[0]), '이력에는 JSON 열을 두지 않는다(최신값 전용)');
  db._resetForTest();
});

/* ── ⑭ 기준값 ─────────────────────────────────────────────────────────── */
test('⑭ 기준값 — 범위 강제 · 빈 칸은 기본값 · warn>bad 면 bad 를 올린다 · 부분 저장은 키 단위로 겹친다 · 배포 키가 아니다', () => {
  const n = S.normalizePerfThresholds({ utilWarn: 95, utilBad: 90, runqWarn: '1.5', queueBad: '', evil: 1, psiFullWarn: -5 });
  assert.equal(n.utilBad, 95); assert.equal(n.runqWarn, 1.5); assert.equal(n.queueBad, S.PERF_DEFAULTS.queueBad); assert.equal(n.psiFullWarn, 0.1);
  assert.ok(!('evil' in n));
  assert.deepEqual(S.normalizeSettings({}).perf, S.PERF_DEFAULTS);
  S.saveBmUsageSettings({ perf: { utilWarn: 70 } });
  S.saveBmUsageSettings({ perf: { runqBad: 3 } });
  const p = S.loadBmUsageSettings().perf;
  assert.equal(p.utilWarn, 70, '앞서 저장한 키가 다음 부분 저장에 지워지지 않는다'); assert.equal(p.runqBad, 3);
  assert.ok(!S.DISTRIBUTED_KEYS.includes('perf'), '배포 서명이 바뀌면 구버전 엣지가 영원히 대기로 보인다 — 이번 단계에서는 배포하지 않는다');
});

test('열 계약 — PERF_COLS 는 자원·USE 칸을 갖고 판정 칸(judged)은 useJudge 가 실제로 읽는다', () => {
  const src = bare('bmusage/useJudge.js');
  for (const c of PERF_COLS) {
    assert.ok(['cpu', 'mem', 'disk', 'net'].includes(c.res) && ['U', 'S', 'E'].includes(c.use), c.col);
    if (c.judged) assert.ok(src.includes(`'${c.col}'`), `${c.col} 는 judged 인데 판정 코어가 읽지 않는다`);
  }
  assert.equal(new Set(PERF_COL_NAMES).size, PERF_COL_NAMES.length);
});
