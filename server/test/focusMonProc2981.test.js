/**
 * test/focusMonProc2981.test.js — v2.981 서버 집중 모니터링 '프로세스 세부 정보'.
 * 사용자 요청(2026-11-12): "프로세스를 클릭하면 어떤 프로세스인지 프로세스에 대한 세부 정보와, 그 프로세스가 사용하는 네트워크/디스크 사용량/CPU 사용량 보여주는 기능 추가"
 *  → 시안 ⑩(docs/design/focus-mon/README.md §16) · 컨펌 '구현해줘'(기본값: 상위 30 상시 수집 · sudo 없음 · 서버 전체 네트워크 참고 · 같은 이름 카드 · 이름 설명 사전).
 *  ① 원격 명령: 여전히 상수 · 읽기 전용 · cmdline/environ 0 · 새 구획(##UNIT 30초 · ##IO 프로세스 주기) · head = 파서 상한 + 1 · HELLO 에 지연 집계
 *  ② 실제 출력(이 컨테이너 리눅스에서 새 스크립트를 돌린 원문): PROC 14칸 · IO(root 라 읽힘) · 옛 6칸 줄도 읽는다
 *  ③ 파서: 서비스 이름은 .service/.scope 로 끝나는 안전한 글자만 · IO 숫자만 · 지연 집계 판정(sysctl · nodelayacct · 옛 커널)
 *  ④ topProcs: 사용자/커널 · 부모 이름 · 서비스 · 같은 이름 수 · 디스크 대기 %(지연 집계가 꺼졌으면 null) · 읽기/쓰기(못 읽으면 null — 0 아님) · 시작 tick(같은 프로세스 판정)
 *  ⑤ 엣지 정제: 새 칸은 아는 것만 · 형식 · 상한 · 숫자는 수로 · 옛 엣지(새 칸 없음)는 null
 *  ⑥ procDetail: 상위 30 밖 구간은 비운다(0 아님) · 같은 pid 재사용(시작 tick 다름)은 다른 프로세스 · 서버 전체 네트워크 참고 · 같은 이름 · 사용자 가림
 *  ⑦ 라우트: 문(admin · 전체 범위) · 범위 밖/없는 대상 404 · pid 형식 400 · 구간에 없으면 404 · 비관리자 판본 사용자 가림
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'focusmonproc2981-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'mock';
process.env.FOCUSMON_SSH_KEY = '';
process.env.AUTH_SECRET = 'test-secret-proc-2981-xxxxxxxxxxxxxxxxxxxxxxxxxx';

const express = (await import('express')).default;
const { api } = await import('../src/routes/api.js');
const svc = await import('../src/focusmon/service.js');
const SCRIPT = await import('../src/focusmon/script.js');
const P = await import('../src/focusmon/parse.js');
const R = await import('../src/focusmon/rates.js');
const store = await import('../src/focusmon/store.js');
const registry = await import('../src/focusmon/registry.js');
const Q = await import('../src/focusmon/query.js');
const edge = await import('../src/central/focusMonEdge.js');

const HERE = path.dirname(new URL(import.meta.url).pathname);
const FIX = path.join(HERE, 'fixtures/focusmon/container-linux-6.18-proc2981.txt');

const users = {
  admin: { username: 'a', role: 'admin', scope: null },
  viewer: { username: 'v', role: 'viewer', scope: null },
  scoped: { username: 's', role: 'admin', scope: { vcenters: ['vc-x'] } },
  demo: { username: 'thedvcdemp', role: 'admin', scope: null, demoGuest: true },
};
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = users[req.headers['x-test-user'] || 'admin']; next(); });
app.use('/api', api);
const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${srv.address().port}`;
after(() => { svc.stopFocusMon(); srv.close(); });
async function call(p, who = 'admin') {
  const r = await fetch(base + p, { headers: { 'x-test-user': who } });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { json = null; }
  return { status: r.status, body: json, text };
}

/* ── ① 원격 명령 ── */
test('① 원격 명령 — 상수 · 읽기 전용 · 인자 0 · 새 구획 UNIT(30초) · IO(프로세스 주기) · head = 파서 상한 + 1 · HELLO 지연 집계', () => {
  const s = SCRIPT.SCRIPTS[2];
  assert.ok(!/cmdline|environ/.test(s.replace(/\/proc\/cmdline/g, '')), '프로세스 인자 · 환경을 읽지 않는다(커널 부트 줄 /proc/cmdline 의 nodelayacct 개수만 센다)');
  assert.match(s, /grep -c nodelayacct \/proc\/cmdline 2>\/dev\/null/, '/proc/cmdline 은 grep -c(개수)로만 — 내용을 내보내지 않는다');
  assert.ok(!/\/proc\/\[0-9\]\*\/(cmdline|environ|fd|exe|cwd|maps)/.test(s));
  assert.ok(!/getline/.test(s));
  assert.ok(!/\bsudo\b|\bsu\b/.test(s));
  assert.match(s, /echo '##UNIT'; timeout -s KILL 5 grep -H -m1 -E ':name=systemd:\|\^0::' \/proc\/\[0-9\]\*\/cgroup 2>\/dev\/null \| awk /, '커널 잠금에서 기다리지 않게 시한(반증 F1)');
  assert.match(s, /echo '##IO'; timeout -s KILL 3 grep -H -E '\^\(read_bytes\|write_bytes\):' \/proc\/\[0-9\]\*\/io 2>\/dev\/null \| awk /, 'io 는 cred_guard_mutex 에서 기다릴 수 있다(반증 F1)');
  assert.match(s, /echo '##PROC'; grep -H '' \/proc\/\[0-9\]\*\/stat 2>\/dev\/null \| awk /, 'pid 는 파일 경로에서(반증 F2)');
  // UNIT 은 30초 구획 안 · IO 는 PROC 와 같은 블록 안
  const topo = s.slice(s.indexOf('if [ $((n % TE)) -eq 0 ]; then'), s.indexOf('  fi', s.indexOf('if [ $((n % TE)) -eq 0 ]; then')));
  assert.match(topo, /##UNIT/);
  const proc = s.slice(s.indexOf("echo '##PROC'"), s.indexOf("echo '##END'", s.indexOf("echo '##PROC'")));
  assert.match(proc, /##IO/);
  for (const [sec, re] of [['UNIT', /\/cgroup 2>\/dev\/null \| awk [^\n]*\| head -n (\d+)/], ['IO', /\/io 2>\/dev\/null \| awk [^\n]*\| head -n (\d+)/], ['PROC', /\/stat 2>\/dev\/null \| awk [^\n]*\| head -n (\d+)/]]) {
    assert.equal(Number(re.exec(s)?.[1]), P.SECTION_MAX_LINES[sec] + 1, `${sec} head = 파서 상한 + 1`);
  }
  assert.match(s, /echo "dacct \$\(cat \/proc\/sys\/kernel\/task_delayacct 2>\/dev\/null \|\| echo -\) \$\(grep -c nodelayacct \/proc\/cmdline 2>\/dev\/null\)"/);
  // 서비스 이름 · comm 은 원격 awk 가 안전한 글자로 바꾼다
  assert.match(s, /gsub\(\/\[\^A-Za-z0-9@\._:-\]\/,"_",u\)/);
  assert.match(s, /gsub\(\/\[\^A-Za-z0-9\._:@\+-\]\/,"_",c\)/);
});

test('① 새 스크립트는 이 컨테이너 리눅스(mawk)에서 실제로 돈다 — 프레임 · PROC 14칸 · IO', () => {
  // MAXN 만 3 으로 줄여 실제로 돌린다(그 밖은 상수 그대로)
  const sh = SCRIPT.SCRIPTS[1].replace(/MAXN=\d+/, 'MAXN=3');
  let out = '';
  try { out = execFileSync('bash', ['-c', sh], { encoding: 'utf8', timeout: 20_000, maxBuffer: 64 * 1024 * 1024 }); } catch (e) { out = String(e.stdout || ''); }
  const frames = []; let hello = null;
  const p = P.createFrameParser({ onHello: (h) => { hello = h; }, onFrame: (f) => frames.push(P.frameToRaw(f)) });
  for (const l of out.split('\n')) p.push(l);
  assert.ok(frames.length >= 2, `프레임 ${frames.length}`);
  assert.equal(hello.isLinux, true);
  assert.ok(hello.dacct === true || hello.dacct === false, `지연 집계 판정 ${hello.dacct}`);
  const withProc = frames.filter((f) => f.proc);
  assert.ok(withProc.length >= 1);
  const pr = withProc[0].proc;
  assert.ok(pr.length > 5);
  assert.ok(pr.every((x) => x.ppid !== undefined && 'ut' in x && 'st' in x), '새 칸이 있다');
  assert.ok(pr.some((x) => x.state && /^[A-Za-z]$/.test(x.state)));
  assert.ok(withProc[0].io instanceof Map, 'IO 구획을 받는다(못 읽으면 빈 맵)');
});

/* ── ② · ③ 파서 ── */
test('② 파서 — PROC 14칸 · 옛 6칸 줄 · 서비스 이름 · IO · 지연 집계', () => {
  const pr = P.parseProc([
    '1234 500 12 900 2048 java 1 400 100 0 4294967296 7 33 S',
    '99 10 1 50 10 old_style',
    '77 1 1 1 1 bad name with spaces',
    '88 1 1 1 1 kworker_0:1 2 1 0 -20 0 0 - I',
    '66 1 1 1 1 java 1 2 3',
  ]);
  const j = pr.find((x) => x.pid === 1234);
  assert.deepEqual({ ppid: j.ppid, ut: j.ut, st: j.st, ni: j.ni, vsz: j.vsz, mf: j.mf, bio: j.bio, state: j.state }, { ppid: 1, ut: 400, st: 100, ni: 0, vsz: 4294967296, mf: 7, bio: 33, state: 'S' });
  const o = pr.find((x) => x.pid === 99);
  assert.equal(o.comm, 'old_style'); assert.equal(o.ppid, null, '옛 줄은 새 칸이 null');
  const k = pr.find((x) => x.pid === 88);
  assert.equal(k.ni, -20, 'nice 는 음수도'); assert.equal(k.bio, null, "'-' = 지연 집계 칸 없음");
  const m = pr.find((x) => x.pid === 66);
  assert.equal(m?.ppid ?? null, null, '14칸이 아닌 줄은 새 형식으로 읽지 않는다(망가진 줄의 칸을 부모 · 시간으로 믿지 않는다)');
  const u = P.parseUnit(['1234 tomcat.service', '55 session-3.scope', '66 evil;rm.service', '77 ../x.service', '88 notunit', 'x y.service']);
  assert.equal(u.get(1234), 'tomcat.service'); assert.equal(u.get(55), 'session-3.scope');
  assert.equal(u.has(66), false); assert.equal(u.has(77), false, '점 둘 · 경로 글자는 받지 않는다'); assert.equal(u.has(88), false);
  const io = P.parseIo(['10 4096 8192', '11 x 1', '12 1']);
  assert.deepEqual(io.get(10), { r: 4096, w: 8192 }); assert.equal(io.has(11), false); assert.equal(io.has(12), false);
  const h = (d) => P.parseHello(['uname Linux 3.10.0', `dacct ${d}`]).dacct;
  assert.equal(h('1 0'), true); assert.equal(h('0 0'), false, 'sysctl 0 = 꺼짐(5.14+ 기본)');
  assert.equal(h('- 0'), true, 'sysctl 이 없는 옛 커널(RHEL 7) = 기본 켜짐'); assert.equal(h('- 1'), false, 'nodelayacct 부트 옵션');
  assert.equal(P.parseHello(['uname Linux 3.10.0']).dacct, null, '옛 수집(줄 없음) = 모름');
});

test('② 실제 출력 원문(fixture) — 새 스크립트 원문 · 옛 원문 둘 다 읽는다', () => {
  for (const f of [FIX, path.join(HERE, 'fixtures/focusmon/container-linux-6.18.txt')]) {
    const frames = [];
    const p = P.createFrameParser({ onFrame: (x) => frames.push(P.frameToRaw(x)) });
    for (const l of fs.readFileSync(f, 'utf8').split('\n')) p.push(l);
    assert.ok(frames.some((x) => x.proc && x.proc.length > 5), path.basename(f));
  }
});

/* ── ④ topProcs ── */
test('④ topProcs — 사용자/커널 · 부모 이름 · 서비스 · 같은 이름 수 · 디스크 대기 · 읽기/쓰기(못 읽으면 null) · 시작 tick', () => {
  const mk = (pid, ticks, ut, st, extra = {}) => ({ pid, ticks, thr: 4, start: 1000 + pid, rss: 256, comm: extra.comm || 'java', ppid: extra.ppid ?? 1, ut, st, ni: 0, vsz: 1048576 * 100, mf: extra.mf ?? 0, bio: extra.bio ?? 0, state: 'S' });
  const prev = [mk(1, 0, 0, 0, { comm: 'systemd', ppid: 0 }), mk(100, 1000, 800, 200, { mf: 10, bio: 100 }), mk(101, 0, 0, 0), mk(102, 0, 0, 0, { comm: 'postgres' })];
  const cur = [mk(1, 0, 0, 0, { comm: 'systemd', ppid: 0 }), mk(100, 1500, 1200, 300, { mf: 30, bio: 150 }), mk(101, 100, 100, 0), mk(102, 50, 50, 0, { comm: 'postgres' })];
  const units = new Map([[100, 'tomcat.service']]);
  const io = new Map([[100, { r: 10 * 1048576, w: 0 }]]); const prevIo = new Map([[100, { r: 0, w: 0 }]]);
  const r = R.topProcs(prev, cur, { dt: 5, tck: 100, page: 4096, ncpu: 8, up: 5000, users: new Map([[100, 'wasadm']]), units, io, prevIo, dacct: true });
  const j = r.top.find((x) => x.pid === 100);
  assert.equal(j.cpu, 100); assert.equal(j.us, 80); assert.equal(j.sy, 20);
  assert.equal(j.pp, 1); assert.equal(j.pc, 'systemd'); assert.equal(j.sv, 'tomcat.service');
  assert.equal(j.ns, 2, '같은 이름(java) 프로세스 2개');
  assert.equal(j.mf, 4, 'major fault 초당');
  assert.equal(j.io, 10, '디스크 대기 = 지연 tick 차 / tck / dt × 100');
  assert.equal(j.rb, 2, '읽기 MB/s'); assert.equal(j.wb, 0, '쓰기 0 은 읽힌 0');
  assert.equal(j.sk, 1100, '시작 tick — pid 재사용 판정');
  assert.equal(j.vsz, 100);
  const o = r.top.find((x) => x.pid === 101);
  assert.equal(o.rb ?? null, null, '/proc/<pid>/io 를 못 읽은 프로세스는 null(0 아님)'); assert.equal(o.sv ?? null, null);
  assert.ok(!('rb' in o), 'null 칸은 싣지 않는다(DB 크기 — 반증 F10)');
  assert.equal(r.da, true);
  const off = R.topProcs(prev, cur, { dt: 5, tck: 100, page: 4096, ncpu: 8, up: 5000, dacct: false });
  assert.equal(off.top.find((x) => x.pid === 100).io ?? null, null, '지연 집계가 꺼진 서버는 디스크 대기를 모름(0 아님)');
  assert.equal(off.da, false);
  const old = R.topProcs([{ pid: 5, ticks: 0, thr: 1, start: 1, rss: 1, comm: 'x' }], [{ pid: 5, ticks: 10, thr: 1, start: 1, rss: 1, comm: 'x' }], { dt: 1, tck: 100, up: 10 });
  assert.equal(old.top[0].us ?? null, null, '옛 줄(새 칸 없음)은 null'); assert.equal(old.top[0].pp ?? null, null);
});

/* ── ⑤ 엣지 정제 ── */
test('⑤ 엣지 정제 — 새 칸은 아는 것만 · 형식 · 상한 · 숫자는 수로 · 옛 엣지는 null', () => {
  const c = edge.cleanProcs({ n: 5, da: true, top: [{ pid: 7, c: 'java', u: 'app', cpu: 1, us: '0.5', sy: 0.5, pp: 1, pc: 'systemd', sv: 'tomcat.service', ns: 3, ni: -5, st: 'S', vsz: 10, mf: 1, io: 2, rb: 3, wb: null, sk: 99, evil: 'x', cmdline: '/bin/java -Dpw=secret' }] });
  const x = c.top[0];
  assert.equal(x.us, 0.5, '문자열 수치는 수로');
  assert.equal(x.sv, 'tomcat.service'); assert.equal(x.pc, 'systemd'); assert.equal(x.ni, -5); assert.equal(x.st, 'S'); assert.equal(x.sk, 99);
  assert.equal(x.wb ?? null, null);
  assert.ok(!('evil' in x) && !('cmdline' in x), '모르는 칸 · 인자는 버린다');
  assert.equal(c.da, true);
  const bad = edge.cleanProcs({ top: [{ pid: 7, c: 'java', sv: 'a;b.service', pc: 'x y', st: 'SS', ns: -1 }] }).top[0];
  assert.equal(bad.sv ?? null, null); assert.equal(bad.pc ?? null, null); assert.equal(bad.st ?? null, null); assert.equal(bad.ns ?? null, null, '음수는 버린다');
  const neg = edge.cleanProcs({ top: [{ pid: 7, c: 'java', us: -5, rb: -1, ni: 99, sk: -3 }] }).top[0];
  assert.equal(neg.us ?? null, null); assert.equal(neg.rb ?? null, null); assert.equal(neg.ni ?? null, null, 'nice 는 -20 ~ 19'); assert.equal(neg.sk ?? null, null);
  const odd = edge.cleanProcs({ top: [{ pid: 7, c: 'java', sk: 1.5, pp: 2.7, ns: 1e21, io: 1e300, rb: 1e300 }] }).top[0];
  for (const k of ['sk', 'pp', 'ns', 'io', 'rb']) assert.equal(odd[k] ?? null, null, `${k}: 정수 · 범위 밖은 버린다(반증 F9)`);
  const old = edge.cleanProcs({ n: 1, top: [{ pid: 7, c: 'java', cpu: 1 }] });
  assert.equal(old.top[0].us ?? null, null); assert.equal(old.da, null, '옛 엣지 = 모름');
  assert.equal(edge.cleanHello({ kernel: 'Linux', dacct: true }).dacct, true);
  assert.equal(edge.cleanHello({ kernel: 'Linux', dacct: 'yes' }).dacct, null);
});

/* ── ⑥ procDetail ── */
const END = Math.floor(Date.now() / 60_000) * 60_000 - 1;
const FROM = END - 10 * 60_000;
const entry = (pid, sk, cpu, extra = {}) => ({ pid, c: extra.c || 'java', u: 'wasadm', cpu, sh: cpu / 8, us: cpu * 0.8, sy: cpu * 0.2, rss: 512, th: 40, et: 3600, pp: 1, pc: 'systemd', sv: 'tomcat.service', ns: 3, ni: 0, st: 'S', vsz: 4096, mf: 0, io: 5, rb: null, wb: null, sk, ...extra });

test('⑥ procDetail — 상위 30 밖 구간은 비운다 · pid 재사용은 다른 프로세스 · 같은 이름 · 서버 네트워크 참고 · 사용자 가림', async () => {
  const id = 'fm-p2981aaaa';
  let k = 0;
  for (let t = FROM + 1; t <= END; t += 5_000) {
    k += 1;
    const inTop = k <= 40 || k > 80; // 가운데 구간은 상위 30 밖
    const top = [entry(200, 777, 50 + (k % 3), { c: 'postgres', sv: 'postgresql.service' }), entry(201, 778, 10, { c: 'postgres' })];
    if (inTop) top.unshift(entry(100, 555, 120));
    if (k > 100) top.push(entry(100, 999, 1, { c: 'other' })); // 같은 pid 를 다른 프로세스가 재사용(시작 tick 다름)
    store.ingestProcs(id, t, { n: 400, da: true, top });
  }
  const mkS = (rx) => ({ dt: 2, cpu: { pct: 1, usr: 1, sys: 0, iow: 0, stl: 0, irq: 0, cores: [1] }, mem: null, net: [{ n: 'eth0', k: 'phys', sp: 10000, st: 'up', m: null, md: null, mem: [], act: null, rx, tx: rx / 2, u: 1, er: 0, dr: 0 }], dsk: [], dtot: null, nPhys: 1, load: [0, 0, 0], run: 1, blk: 0, thr: 1 });
  for (let t = FROM + 1; t <= END; t += 2_000) store.ingestSample(id, t, mkS(8e6), null, t);
  const w = { from: FROM, to: END, win: 10, past: true };
  const d = await Q.procDetail(id, w, { pid: 100, sk: 555, maskUser: (u) => `#${u.length}` });
  assert.ok(d, '찾았다');
  assert.equal(d.info.c, 'java'); assert.equal(d.info.sv, 'tomcat.service'); assert.equal(d.info.pc, 'systemd'); assert.equal(d.info.u, '#6', '사용자 가림 함수를 거친다');
  assert.equal(d.series.cpu.length, d.points); assert.equal(d.net.rx.length, d.points, '서버 네트워크도 같은 칸');
  const nulls = d.series.cpu.filter((v) => v == null).length;
  assert.ok(nulls > 0, '상위 30 밖 구간은 비운다(0 으로 채우지 않는다)');
  assert.ok(!d.series.cpu.some((v) => v === 1), '같은 pid 를 재사용한 다른 프로세스(시작 tick 999)를 섞지 않는다');
  assert.ok(d.cover.inTopMs > 0 && d.cover.inTopMs < d.cover.totalMs, '상위 30 에 든 시간');
  assert.equal(d.max.cpu, 120);
  assert.ok(d.net.rx.some((v) => v === 8e6), '서버 전체 수신(참고) — s.rx 열');
  assert.equal(d.same.total, 3); assert.deepEqual(d.same.list.map((x) => x.pid), [100], '같은 이름(java)은 상위 30 안의 것만 · 전체 수는 ns');
  const pg = await Q.procDetail(id, w, { pid: 200, sk: 777 });
  assert.deepEqual(pg.same.list.map((x) => x.pid).sort(), [200, 201]);
  assert.equal(await Q.procDetail(id, w, { pid: 100, sk: 123 }), null, '시작 tick 이 다르면 없다');
  assert.equal(await Q.procDetail(id, w, { pid: 4242 }), null);
});

/* ── ⑦ 라우트 ── */
test('⑦ 라우트 — 문 · 없는 대상 404 · pid 형식 400 · 구간에 없으면 404 · 비관리자 판본 사용자 가림', async () => {
  registry._resetForTest();
  const main = (await call('/api/tools/focus-mon')).body;
  const demo = main.targets.find((t) => t.demo);
  assert.ok(demo, '목 모드 데모 대상');
  const now = Date.now();
  for (let i = 0; i < 6; i++) store.ingestProcs(demo.id, now - 30_000 + i * 5_000, { n: 10, da: true, top: [entry(4321, 1234, 40)] });
  const q = (who, extra = '') => call(`/api/tools/focus-mon/proc?target=${demo.id}&pid=4321&sk=1234&win=5${extra}`, who);
  const ok = await q('admin');
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.body.info.u, 'wasadm');
  for (const who of ['viewer', 'scoped']) assert.equal((await q(who)).status, 403, who);
  const dm = await q('demo');
  assert.equal(dm.status, 200, dm.text);
  assert.equal(dm.body.usersMasked, true, '관리자 판본이 아니면 사용자 이름을 가린다');
  assert.notEqual(dm.body.info.u, 'wasadm');
  assert.ok(dm.body.same.list.every((x) => x.u !== 'wasadm'), '같은 이름 목록의 사용자도 가린다');
  assert.equal((await call('/api/tools/focus-mon/proc?target=fm-nosuch0000&pid=1&win=5')).status, 404);
  // 데모 계정에는 데모 대상만 보인다 — 등록된 실제 서버의 프로세스 기록이 있어도 404(데이터가 있는지조차 말하지 않는다)
  const real = registry.addTarget({ name: 'real-01', host: '10.7.0.1', port: 22, username: 'dvcmon', agent: '' }, { agents: [] }).target;
  for (let i = 0; i < 6; i++) store.ingestProcs(real.id, now - 30_000 + i * 5_000, { n: 10, da: true, top: [entry(777, 1, 40)] });
  assert.equal((await call(`/api/tools/focus-mon/proc?target=${real.id}&pid=777&sk=1&win=5`)).status, 200, '관리자에게는 보인다');
  assert.equal((await call(`/api/tools/focus-mon/proc?target=${real.id}&pid=777&sk=1&win=5`, 'demo')).status, 404, '데모 계정에는 없는 대상');
  assert.equal((await call(`/api/tools/focus-mon/proc?target=${demo.id}&pid=abc&win=5`)).status, 400);
  assert.equal((await call(`/api/tools/focus-mon/proc?target=${demo.id}&pid=0&win=5`)).status, 400);
  assert.equal((await call(`/api/tools/focus-mon/proc?target=${demo.id}&pid=4321&sk=-1&win=5`)).status, 400);
  assert.equal((await call(`/api/tools/focus-mon/proc?target=${demo.id}&pid=999999&win=5`)).status, 404, '구간에 없는 프로세스');
  assert.equal((await call(`/api/tools/focus-mon/proc?target=${demo.id}&pid=9999999&win=5`)).status, 400, 'PID 상한(4194304) 밖');
});

/* ── ⑧ 수집기 ── */
test('⑧ 수집기 — 서비스 이름(30초 구획) · 입출력 · 지연 집계가 상위 목록까지 간다(가짜 SSH 스트림)', async () => {
  const { createCollector } = await import('../src/focusmon/collector.js');
  const lines = [
    '##HELLO 1', 'uname Linux 3.10.0-1127.el7.x86_64 x86_64', 'tck 100', 'page 4096', 'ncpu 4', 'hidepid 0', 'dacct - 0', 'host t', '##END',
    '##T 100.00 1700000000', '##UNIT', '500 tomcat.service', '##PROC', '1 0 1 1 1 systemd 0 0 0 0 0 0 0 S', '500 100 4 900 256 java 1 80 20 0 1048576 0 10 S', '##IO', '500 0 0', '##END',
    '##T 105.00 1700000005', '##PROC', '1 0 1 1 1 systemd 0 0 0 0 0 0 0 S', '500 600 4 900 256 java 1 480 120 0 1048576 5 60 R', '##IO', '500 10485760 0', '##END',
  ];
  let got = null;
  const col = createCollector({ id: 'fm-col29810', host: '10.9.9.9', port: 22, username: 'dvcmon' }, {
    interval: 1, keys: { keyInfo: () => ({ fingerprint: 'fp-col2981' }), privateKeyForConnect: () => 'PEM' },
    onProcs: (p) => { got = p; }, onSample: () => {}, onStatus: () => {},
    connect: async (_o, fn) => fn({ execStream: async (_s, { onLine }) => { for (const l of lines) onLine(l); return { code: 0 }; } }),
  });
  col.start();
  const end = Date.now() + 3_000; while (!got && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  col.stop();
  assert.ok(got, '상위 목록을 받았다');
  const j = got.top.find((x) => x.pid === 500);
  assert.equal(j.sv, 'tomcat.service', '30초 구획의 서비스 이름이 다음 프로세스 표본까지 간다');
  assert.equal(j.pc, 'systemd'); assert.equal(j.us, 80); assert.equal(j.sy, 20);
  assert.equal(j.rb, 2); assert.equal(j.wb, 0);
  assert.equal(j.io, 10, 'sysctl 없는 옛 커널 + nodelayacct 없음 = 지연 집계 켜짐');
  assert.equal(got.da, true);
});

/* ── ⑨ 반증 1인(2026-11-12) 확정분 ── */
const awkOf = (marker) => {
  const l = SCRIPT.SCRIPTS[2].split('\n').find((x) => x.includes(`echo '${marker}'`));
  return l.slice(l.indexOf('| awk') + 2, l.lastIndexOf(' | head'));
};
const runAwk = (prog, input) => execFileSync('bash', ['-c', prog], { input, encoding: 'utf8', timeout: 10_000 });
const F = '1 2 3 4 5 6 7 8 9 10 11 400 100 14 15 16 17 0 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 9';

test('⑨ F2 — 줄바꿈 comm 으로 다른 pid 행을 위조하지 못한다(pid 는 파일 경로에서) · 빈 comm 은 _ · 경로와 첫 칸이 다르면 버린다', () => {
  // 실제 원격 awk(상수에서 꺼낸 그대로)에 grep -H 모양 입력을 넣는다 — 5555 의 comm 이 "\n1234 (sshd" 인 stat 이 두 줄로 나온 것
  const out = runAwk(awkOf('##PROC'), [`/proc/5555/stat:5555 (`, `/proc/5555/stat:1234 (sshd) S ${F}`, `/proc/77/stat:77 () R ${F}`, `/proc/88/stat:99 (liar) R ${F}`, `/proc/66/stat:66 (ok:name) S ${F}`, ''].join('\n'));
  const rows = P.parseProc(out.trim().split('\n'));
  assert.deepEqual(rows.map((r) => r.pid).sort((a, b) => a - b), [66, 77, 5555], '1234 행이 생기지 않고 · 경로 pid(88)와 첫 칸(99)이 다르면 버린다');
  assert.equal(rows.find((r) => r.pid === 5555).comm, '_1234__sshd', '위조 글자는 이름 안에 남는다(프로세스는 숨지 않는다)');
  assert.equal(rows.find((r) => r.pid === 77).comm, '_', '빈 comm 은 _ (반증 F4 — 13칸 줄이 되지 않는다)');
  assert.equal(P.parseProc(['1 1 1 1 1 1 2 3 4 5 6 7 8']).length, 0, '13칸 줄은 받지 않는다');
});

test('⑨ F5 — 서비스는 경로의 첫(시스템 수준) .service/.scope · 이름 안의 : 를 자르지 않는다', () => {
  const out = runAwk(awkOf('##UNIT'), [
    '/proc/10/cgroup:1:name=systemd:/user.slice/user-1000.slice/user@1000.service/app.slice/sshd.service',
    '/proc/11/cgroup:0::/system.slice/foo:bar.service',
    '/proc/12/cgroup:1:name=systemd:/system.slice/docker.service/x/y.scope',
    '/proc/13/cgroup:1:name=systemd:/',
    '/proc/x/cgroup:1:name=systemd:/system.slice/a.service', ''].join('\n'));
  const u = P.parseUnit(out.trim().split('\n'));
  assert.equal(u.get(10), 'user@1000.service', '사용자 유닛 이름(sshd.service)으로 위조되지 않는다');
  assert.equal(u.get(11), 'foo:bar.service');
  assert.equal(u.get(12), 'docker.service');
  assert.equal(u.has(13), false);
  assert.equal(u.size, 3);
});

test('⑨ F6 — 사용자 · 서비스 맵을 읽은 뒤에 시작한 프로세스에는 붙이지 않는다(pid 재사용 → 모름)', () => {
  const mk = (pid, start, ticks) => ({ pid, ticks, thr: 1, start, rss: 1, comm: 'x', ppid: 1, ut: ticks, st: 0, ni: 0, vsz: 0, mf: 0, bio: 0, state: 'S' });
  const users = new Map([[10, 'olduser'], [11, 'app']]); const units = new Map([[10, 'old.service'], [11, 'app.service']]);
  // 맵은 uptime 100초에 읽었다 · pid 10 은 150초에 시작(재사용) · pid 11 은 50초에 시작
  const r = R.topProcs([mk(10, 15000, 0), mk(11, 5000, 0)], [mk(10, 15000, 100), mk(11, 5000, 50)], { dt: 5, tck: 100, up: 200, users, units, usersUp: 100, unitsUp: 100 });
  const a = r.top.find((x) => x.pid === 10); const b = r.top.find((x) => x.pid === 11);
  assert.equal(a.u, null); assert.equal(a.sv ?? null, null, '맵보다 늦게 시작 — 예전 계정 · 서비스를 붙이지 않는다');
  assert.equal(b.u, 'app'); assert.equal(b.sv, 'app.service');
});

test('⑨ F8 — 구간 평균 표의 열쇠에 시작 tick(pid 재사용 작업자를 한 줄로 섞지 않는다)', async () => {
  const id = 'fm-p2981bbbb';
  const t0 = END - 4 * 60_000;
  for (let i = 0; i < 12; i++) store.ingestProcs(id, t0 + i * 5_000, { n: 5, top: [entry(300, i < 6 ? 1000 : 2000, i < 6 ? 10 : 90, { c: 'worker' })] });
  const r = await Q.procs([id], { from: t0 - 1, to: END, win: 5, past: true }, { at: 'avg' });
  const rows = r.per[0].top.filter((x) => x.pid === 300);
  assert.equal(rows.length, 2, '시작 tick 이 다른 두 프로세스는 두 줄');
  assert.deepEqual(rows.map((x) => x.sk).sort(), [1000, 2000]);
});
