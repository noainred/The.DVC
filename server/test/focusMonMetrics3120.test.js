/**
 * test/focusMonMetrics3120.test.js — v3.12.0 서버 집중 모니터링 ‘더할 지표’(시안 ⑬ Metrics · 사용자 "기본값대로 모두 구현해줘").
 * 컨펌 기본값: ① 파일시스템 60초 · df 시한 3초(넘기면 '응답 없음') ② 문턱 = 설정의 사용률 문턱 ③ 가득 찰 때까지 — 계속 수집만 · 6시간 미만 '—'
 * ④ 같은 1분 묶음에 열 추가 ⑤ 비교 · 카드 아래 줄에도.
 *
 *  ① 원격 명령 — 상수 · 새 구획(VM · SNMP · SOCK · FS · FSI) · df 는 -l + timeout KILL · 60초 · 사용자 값 없음 · 이 컨테이너의 bash 로 실제 실행 → 파서 → 표본
 *  ② 파서 — RHEL 7(zone 접미) · 새 커널(_anon/_file · proactive) 회수 줄 · throttle 제외 · snmp 머리/값 쌍 · sockstat · df 마운트 거르기 · rc 137 · xfs inode
 *  ③ 계산 — 초당 값 · 카운터 감소는 null · 보낸 세그먼트 0 이면 재전송률 null · D 상태 이어진 시간 · 파일시스템 최대 · 요약(카드 줄)
 *  ④ 묶음(코덱) ↔ 조회 — 열 · 메타 왕복 · 서버 상세(표 · 추이 · 최고 · 파일시스템 마지막 확인) · 구간 평균 · 비교 열쇠
 *  ⑤ 엣지 정제 — 아는 칸만 · 상한 · 마운트 · 이름 규칙
 *  ⑥ 가득 찰 때까지 — 계속 수집이 아니면 'not-record' · 6시간 미만 'short' · 직선 추세 · 늘지 않음 · 데모 값
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'focusmonmetrics3120-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'mock';
const SCRIPT = await import('../src/focusmon/script.js');
const P = await import('../src/focusmon/parse.js');
const R = await import('../src/focusmon/rates.js');
const CODEC = await import('../src/focusmon/codec.js');
const store = await import('../src/focusmon/store.js');
const Q = await import('../src/focusmon/query.js');
const db = await import('../src/focusmon/db.js');
const edge = await import('../src/central/focusMonEdge.js');
const mock = await import('../src/focusmon/mock.js');
after(() => { try { db._resetForTest(); } catch { /* */ } });

const END = Math.floor(Date.now() / 60_000) * 60_000 - 1;

/* ── ① ── */
test('① 원격 명령 — 상수 · 새 구획 · df 는 로컬만 · 시한 KILL · 60초 · 실제 bash 실행 → 표본', () => {
  const s = SCRIPT.scriptFor(2);
  for (const sec of ['VM', 'SNMP', 'SOCK', 'FS', 'FSI']) assert.match(s, new RegExp(`echo '##${sec}'`), sec);
  assert.match(s, /awk '\/\^\(cpu\[0-9\]\* \|procs_running \|procs_blocked \|ctxt \|processes \)\/\{print;next\} \/\^intr \/\{print \$1,\$2\}' \/proc\/stat/, 'intr 는 앞 두 칸만');
  assert.match(s, /timeout -s KILL 3 df -P -l -T -k /, 'df 는 시한 KILL · 로컬만(-l — 네트워크 파일시스템은 보지 않는다)');
  assert.match(s, /timeout -s KILL 3 df -P -l -i /);
  assert.match(s, /FE=60/); assert.match(s, /if \[ \$\(\( \(n \* I\) % FE \)\) -lt \$I \]; then/, '60초마다');
  assert.ok(!/\/proc\/net\/tcp\b/.test(s), '소켓마다의 목록(/proc/net/tcp)은 비싸서 읽지 않는다');
  assert.ok(!/\/proc\/\[0-9\]\*\/(cmdline|environ)|environ/.test(s), '프로세스 인자 · 환경은 여전히 읽지 않는다(부트 줄 /proc/cmdline 은 grep -c 개수만 — v2.981)');
  // 이 컨테이너의 bash 로 실제로 돌린다(주기 1초 · 3초 남짓) — 첫 프레임에 FS 가 있다(n=0)
  const r = spawnSync('bash', ['-c', SCRIPT.scriptFor(1)], { encoding: 'utf8', timeout: 3_600, killSignal: 'SIGKILL' });
  const raws = []; let hello = null;
  const p = P.createFrameParser({ onHello: (h) => { hello = h; }, onFrame: (f) => raws.push(P.frameToRaw(f)) });
  for (const l of String(r.stdout || '').split('\n')) p.push(l);
  assert.ok(hello && raws.length >= 2, `프레임 ${raws.length}개(${String(r.stderr || '').slice(0, 200)})`);
  const f0 = raws[0];
  assert.ok(f0.stat.ctxt > 0 && f0.stat.forks > 0 && f0.stat.intr > 0, 'ctxt · processes · intr 첫 합계');
  assert.ok(f0.vm && f0.vm.majflt != null, 'vmstat');
  assert.ok(f0.snmp && f0.snmp.outSegs != null && f0.snmp.estab != null, 'snmp');
  assert.ok(f0.sock && f0.sock.inuse != null, 'sockstat');
  assert.ok(f0.fs && f0.fs.rc === 0 && f0.fs.rows.length >= 1 && f0.fs.rows.every((x) => x.pct == null || (x.pct >= 0 && x.pct <= 100)), JSON.stringify(f0.fs));
  assert.equal(raws[1].fs, null, '둘째 프레임(1초 뒤)에는 FS 가 없다 — 60초마다');
  const smp = R.computeSample(raws[0], raws[1], {});
  assert.ok(smp.sched && smp.sched.cs != null && smp.sched.cs >= 0, '초당 컨텍스트 스위치');
  assert.ok(smp.tcp && smp.tcp.es != null && smp.vmp && smp.vmp.mf != null);
});

/* ── ② ── */
test('② 파서 — 회수 줄 합(throttle · _anon/_file 제외) · snmp 쌍 · sockstat · df 마운트 거르기 · 시한 · xfs inode', () => {
  const rhel7 = ['pswpin 10', 'pswpout 20', 'pgmajfault 30', 'pgscan_kswapd_dma 1', 'pgscan_kswapd_normal 100', 'pgscan_direct_normal 50', 'pgscan_direct_throttle 999',
    'pgsteal_kswapd_normal 80', 'pgsteal_direct_normal 40'];
  assert.deepEqual(P.parseVm(rhel7), { swpin: 10, swpout: 20, majflt: 30, scan: 151, steal: 120 }, 'zone 접미 합 · direct_throttle(횟수)는 뺀다');
  const k6 = ['pgscan_kswapd 7', 'pgscan_direct 3', 'pgscan_khugepaged 1', 'pgscan_proactive 2', 'pgscan_anon 13', 'pgscan_file 0', 'pgsteal_kswapd 5', 'pgsteal_anon 5'];
  assert.deepEqual(P.parseVm(k6), { swpin: null, swpout: null, majflt: null, scan: 13, steal: 5 }, '_anon · _file 은 같은 수의 내역이라 다시 세지 않는다 · 없는 칸은 null');
  const snmp = ['Tcp: RtoAlgorithm CurrEstab OutSegs RetransSegs', 'Tcp: 1 12 1000 7', 'TcpExt: ListenOverflows ListenDrops', 'TcpExt: 3 4', 'Tcp: A B', 'Tcp: 1'];
  assert.deepEqual(P.parseSnmp(snmp), { retrans: 7, outSegs: 1000, estab: 12, lof: 3, ldrop: 4 }, '머리 · 값 칸 수가 다르면 버린다');
  assert.equal(P.parseSnmp(['Tcp: __proto__ OutSegs', 'Tcp: 5 6']).outSegs, null, '머리에 이상한 이름이 있으면 그 쌍을 통째로 버린다(커널 머리는 영문 · 숫자뿐)');
  assert.deepEqual(P.parseSock(['sockets: used 5', 'TCP: inuse 16 orphan 1 tw 9 alloc 16 mem 0']), { inuse: 16, tw: 9, orphan: 1 });
  const df = ['Filesystem     Type 1024-blocks     Used Available Capacity Mounted on', '/dev/vda ext4 100 40 50 45% /', '/dev/sdb1 xfs 1000 900 100 90% /data',
    '/dev/sdc1 xfs 10 1 9 10% /my mount', '/dev/x ext4 10 1 9 10% /a/../etc', '/dev/y ext4 10 1 9 10% __proto__', 'rc 0'];
  const fsr = P.parseFs(df);
  assert.equal(fsr.rc, 0);
  assert.deepEqual(fsr.rows.map((x) => [x.m, x.pct]), [['/', 44.4], ['/data', 90]], '사용 ÷ (사용 + 쓸 수 있는 양) · 공백 · .. · 이상한 이름은 버린다');
  const ino = P.parseFsi(['Filesystem Inodes IUsed IFree IUse% Mounted on', '/dev/vda 1000 300 700 30% /', '/dev/sdb1 0 0 0 - /data', 'rc 0']);
  const merged = P.mergeFs(fsr, ino);
  assert.deepEqual(merged.rows.map((x) => [x.m, x.ipct]), [['/', 30], ['/data', null]], 'xfs · inode 0 은 null(—)');
  const hung = P.mergeFs(P.parseFs(['Filesystem Type 1024-blocks Used Available Capacity Mounted on', 'rc 137']), null);
  assert.equal(hung.rc, 137); assert.equal(hung.rows.length, 0, '시한에 걸리면 줄 없음 · rc 137');
  assert.deepEqual(P.parseStat(['cpu  1 2 3 4 5 6 7 8', 'ctxt 99', 'processes 5', 'intr 1234']).intr, 1234);
});

/* ── ③ ── */
test('③ 계산 — 초당 값 · 카운터 감소 null · 재전송률 · D 이어진 시간 · 요약', () => {
  const raw = (o) => ({ up: o.up, stat: { all: [1, 0, 1, 10, 0, 0, 0, 0], cores: [], running: o.run ?? 2, blocked: 0, ctxt: o.cs, forks: o.fk, intr: o.in },
    vm: { swpin: o.si, swpout: 0, majflt: 10, scan: 0, steal: 0 }, snmp: { retrans: o.rt, outSegs: o.out, estab: 5, lof: 0, ldrop: 0 }, sock: { inuse: 9, tw: 4, orphan: 0 } });
  const a = raw({ up: 100, cs: 1000, fk: 10, in: 500, si: 0, rt: 10, out: 1000 });
  const b = raw({ up: 102, cs: 3000, fk: 14, in: 900, si: 200, rt: 15, out: 2000 });
  const s = R.computeSample(a, b, {});
  assert.deepEqual(s.sched, { cs: 1000, in: 200, fk: 2 });
  assert.equal(s.vmp.si, 100); assert.equal(s.tcp.rt, 0.5, '재전송 5 ÷ 보낸 1000 = 0.5%'); assert.equal(s.tcp.es, 5); assert.equal(s.tcp.tw, 4);
  const reset = R.computeSample(b, raw({ up: 104, cs: 10, fk: 1, in: 1, si: 0, rt: 15, out: 2000 }), {});
  assert.equal(reset.sched.cs, null, '카운터가 줄면(재부팅 · 넘침) null — 음수 · 0 이 아니다');
  assert.equal(reset.tcp.rt, null, '보낸 세그먼트가 0 이면 비율이 없다(null)');
  const noVm = R.computeSample({ up: 1, stat: { all: [1, 0, 1, 10, 0, 0, 0, 0], cores: [] } }, { up: 3, stat: { all: [2, 0, 2, 12, 0, 0, 0, 0], cores: [] } }, {});
  assert.equal(noVm.vmp, null); assert.equal(noVm.tcp, null); assert.equal(noVm.sched, null, '구획이 없으면(옛 수집) 묶음째 null');
  // D 상태 이어진 시간 — 같은 pid · 시작 tick 이 이어지면 늘고, D 가 아니면 지운다
  const dS = new Map();
  const pr = (st, up) => R.procStates([{ pid: 7, start: 100, comm: 'jbd2', state: st }, { pid: 8, start: 5, comm: 'x', state: 'Z' }], up, dS);
  assert.deepEqual(pr('D', 10), { D: 1, Z: 1, pd: [{ pid: 7, c: 'jbd2', s: 0 }] });
  assert.equal(pr('D', 16).pd[0].s, 6, '6초째');
  assert.equal(pr('S', 18).D, 0); assert.equal(dS.size, 0, 'D 가 풀리면 지운다');
  assert.equal(pr('D', 20).pd[0].s, 0, '다시 D 가 되면 0 부터');
  assert.equal(R.procStates([{ pid: 1, start: 1, comm: 'a', state: null }], 1, new Map()), null, '상태 칸이 없는 옛 줄 = 모름(null)');
  const sum = R.summaryOf({ ...s, run: 6, cpu: { pct: 1, cores: [1, 1, 1, 1] }, pst: { D: 2, Z: 0, pd: [] }, fs: { rc: 0, rows: [{ m: '/', pct: 40 }, { m: '/data', pct: 93.5 }] } });
  assert.deepEqual([sum.fsMax, sum.tcpRt, sum.procD, sum.rq, sum.swIo], [93.5, 0.5, 2, 1.5, 100]);
  assert.equal(R.summaryOf({ cpu: null }).fsMax, null, '파일시스템을 못 읽으면 null');
});

/* ── ④ ── */
test('④ 묶음 ↔ 조회 — 열 · 메타 왕복 · 서버 상세 표 · 추이 · 최고 · 파일시스템 마지막 확인 · 구간 평균 · 비교 열쇠', async () => {
  const id = 'fm-aaaa3120';
  const FROM = END - 10 * 60_000;
  const base = mock.demoSample(mock.DEMO_TARGETS[0].id, FROM);
  let k = 0;
  for (let t = FROM + 1; t <= END; t += 2_000, k += 1) {
    const s = { ...base, sched: { cs: 1000 + k, in: 10, fk: 1 }, tcp: { ...base.tcp, rt: k === 100 ? 2.5 : 0.1 }, pst: { D: k % 50 === 0 ? 3 : 0, Z: 0, pd: [{ pid: 9, c: 'ora_dbw0', s: 4 }] },
      fs: k % 30 === 0 ? { ...base.fs, age: 0 } : null };
    store.ingestSample(id, t, s, null, t);
  }
  const d = await Q.serverDetail(id, { from: FROM, to: END, win: 10, past: true }, { at: 'end' });
  assert.ok(d.table.sched && d.table.tcp && d.table.vmp && d.table.pst, '표에 새 묶음');
  assert.equal(d.charts.ext['p.rt'].max, 2.5, '구간 최고'); assert.ok(d.charts.ext['p.rt'].maxAt > FROM);
  assert.equal(d.charts.ext['k.cs'].vals.length, d.sparkPoints);
  assert.ok(d.fs && d.fs.rows.some((r) => r.m === '/oradata'), '끝 순간 표본에 FS 가 없어도 구간 안 마지막 확인을 보인다');
  assert.ok(d.fs.at <= END && d.fs.at >= FROM);
  assert.deepEqual(d.table.pst.pd[0], { pid: 9, c: 'ora_dbw0', s: 4 }, 'D 목록은 묶음 메타로');
  const av = await Q.serverDetail(id, { from: FROM, to: END, win: 10, past: true }, { at: 'avg' });
  assert.ok(av.table.sched.cs > 1000 && av.table.sched.cs < 1000 + k, '구간 평균');
  // 비교 열쇠
  const meta = { fs: { '/data': {} } };
  assert.equal(Q.seriesKeyFor('fs', 'pct', 'all', meta), 's.fs');
  assert.equal(Q.seriesKeyFor('fs', 'ipct', 'mount:/data', meta), 'f./data.i');
  assert.equal(Q.seriesKeyFor('fs', 'pct', 'mount:/a/../b', meta), 's.fs', '이상한 마운트는 전체로');
  assert.equal(Q.seriesKeyFor('tcp', 'rt', 'all'), 'p.rt'); assert.equal(Q.seriesKeyFor('sched', 'D', 'all'), 'q.D'); assert.equal(Q.seriesKeyFor('sched', 'run', 'all'), 'l.run');
  assert.equal(Q.seriesKeyFor('vmp', 'zz', 'all'), 'v.si', '모르는 항목은 첫 항목');
  const cmp = await Q.compare([id], { from: FROM, to: END, win: 10, past: true }, { metric: 'fs', item: 'pct', scope: 'all' });
  assert.ok(cmp.targets[0].last > 0, '비교 — 파일시스템 최대');
  // 코덱 상한 — 마운트 64개
  const many = { fs: { rc: 0, age: 0, rows: Array.from({ length: 80 }, (_, i) => ({ m: `/m${i}`, t: 'ext4', d: '/dev/x', kb: 1, pct: 1, ipct: 1 })) } };
  assert.equal(Object.keys(CODEC.flattenSample(many).meta.fs).length, CODEC.FS_ROWS_MAX);
});

/* ── ⑤ ── */
test('⑤ 엣지 정제 — 아는 칸만 · 상한 · 마운트 · 이름 규칙', () => {
  const c = edge.cleanSample({
    dt: 2, sched: { cs: 5, in: -1, fk: 'x', extra: 1 }, vmp: { si: 1e12, so: 2 }, tcp: { rt: 150, es: 3.5, tw: 7 },
    pst: { D: 2, Z: 0, pd: [{ pid: 5, c: 'a b', s: 1 }, { pid: 6, c: 'ok', s: 1 }] },
    fs: { rc: 0, age: 10, rows: [{ m: '/', t: 'xfs', d: '/dev/x', kb: 5, pct: 50, ipct: null }, { m: '../x', pct: 1 }, { m: '/', pct: 2 }, { m: '/v', t: 'A B', pct: 101 }] },
  });
  assert.deepEqual(c.sched, { cs: 5, in: null, fk: null });
  assert.equal(c.vmp.si, null, '상한 넘음'); assert.equal(c.tcp.rt, null, '재전송률 100 초과'); assert.equal(c.tcp.es, null, '연결 수는 정수');
  assert.deepEqual(c.pst.pd, [{ pid: 6, c: 'ok', s: 1 }]);
  assert.deepEqual(c.fs.rows.map((r) => [r.m, r.t, r.pct]), [['/', 'xfs', 50], ['/v', '?', null]], '.. 마운트 · 겹친 마운트는 버린다 · 이상한 종류는 ?');
  assert.equal(edge.cleanSample({ dt: 2 }).fs, undefined, '없으면 싣지 않는다');
});

/* ── ⑥ ── */
test('⑥ 가득 찰 때까지 — 계속 수집만 · 6시간 미만 short · 직선 추세 · 늘지 않음 · 데모', async () => {
  const id = 'fm-bbbb3120';
  assert.equal((await Q.fillEstimate(id, { now: END })).state, 'not-record', '계속 수집이 아니면 추정하지 않는다');
  store.startSession({ targets: [id], mode: 'record', by: 't' }, END);
  // 24시간 · 10분마다 · /var 는 하루 2%p 오름(지금 80%) · / 는 그대로
  const rows = [];
  for (let m = Math.floor(END / 60_000) - 24 * 60; m <= Math.floor(END / 60_000); m += 1) {
    if (m % 10 !== 0) continue;
    const t = m * 60_000 + 1;
    const ageH = (END - t) / 3_600_000;
    const s = { dt: 2, fs: { rc: 0, age: 0, rows: [{ m: '/var', t: 'xfs', d: '/dev/x', kb: 1, pct: 80 - (2 / 24) * ageH, ipct: null }, { m: '/', t: 'xfs', d: '/dev/y', kb: 1, pct: 40, ipct: null }] } };
    const { row, meta } = CODEC.flattenSample(s);
    const b = CODEC.newBlock(m); CODEC.appendToBlock(b, t, row, meta);
    rows.push({ kind: 'm', target: id, minute: m, n: 1, data: CODEC.encodeBlock(b) });
  }
  const w = await db.writeBlocks(rows); assert.equal(w.ok, true, JSON.stringify(w));
  const f = await Q.fillEstimate(id, { rows: [{ m: '/var', pct: 80 }, { m: '/', pct: 40 }], now: END });
  assert.equal(f.state, 'ok'); assert.ok(f.spanH >= 23);
  assert.equal(f.rows['/var'].trend, 'up'); assert.ok(Math.abs(f.rows['/var'].days - 10) < 0.5, `20%p ÷ 하루 2%p ≈ 10일(${f.rows['/var'].days})`);
  assert.equal(f.rows['/'].trend, 'flat'); assert.equal(f.rows['/'].days, null);
  // 짧은 기록 — 다른 대상 · 3시간
  const id2 = 'fm-cccc3120'; store.startSession({ targets: [id2], mode: 'record', by: 't' }, END);
  const rows2 = [];
  for (let m = Math.floor(END / 60_000) - 180; m <= Math.floor(END / 60_000); m += 10) {
    const mm = m - (m % 10); const { row, meta } = CODEC.flattenSample({ dt: 2, fs: { rc: 0, age: 0, rows: [{ m: '/', t: 'ext4', d: '/x', kb: 1, pct: 50, ipct: 1 }] } });
    const b = CODEC.newBlock(mm); CODEC.appendToBlock(b, mm * 60_000 + 1, row, meta); rows2.push({ kind: 'm', target: id2, minute: mm, n: 1, data: CODEC.encodeBlock(b) });
  }
  await db.writeBlocks(rows2);
  assert.equal((await Q.fillEstimate(id2, { now: END })).state, 'short', '기록이 6시간보다 짧으면 추정하지 않는다');
  assert.equal(mock.demoFill(mock.DEMO_TARGETS[0].id).rows['/oradata'].days, 2.6, '데모 — 시안과 같은 값');
  assert.equal((await Q.fillEstimate(mock.DEMO_TARGETS[0].id)).state, 'ok');
});
