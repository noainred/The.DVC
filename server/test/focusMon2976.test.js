/**
 * test/focusMon2976.test.js — v2.976 특수 기능 ‘집중 모니터링’(설계 docs/design/focus-mon · 사용자 컨펌 2026-11-11 ‘만들어줘’ · 전체 검증).
 *
 * 고정하는 것:
 *  ① 원격 명령은 주기별 **상수 넷**뿐 — 사용자 입력이 들어갈 자리가 없다 · 인자 · 환경 · sudo · 쓰기 0 · comm 만
 *  ② 표지 위조 · 재개방 · END 없는 프레임은 버린다 · 두 글자 표지(##PS)도 받는다(초판 결함 — 정규식이 3글자부터였다)
 *  ③ iostat 13칸 식 = 사용자가 보낸 iostat 출력의 값(sdj · sdd · sde) · 요청 0건이면 지연 null(iostat 의 0.00 과 다름) · 걸린 요청만 있으면 stuck
 *  ④ 본딩 속도(802.3ad 합 · active-backup 하나) · 속도 모름 → 사용률 null · 프로세스 pid 재사용은 버림
 *  ⑤ 묶음 코덱 왕복(null 보존) · 판 번호가 다르면 풀지 않음
 *  ⑥ 수집(세션) 상한 · 잠깐 보기 시한 · 보는 화면 없음 → 끝 · 계속 수집은 재시작 뒤 이어 받음 · 안 볼 때 10초
 *  ⑦ 엣지 동기화 정제 — 남의 대상 id 는 버림 · 시각은 수신 시각으로 옮김 · 모르는 값은 null · 공유 토큰은 403
 *  ⑧ 실제 SSH(가짜 SSH 서버가 이 컨테이너의 bash 로 명령을 돌린다) — 키 로그인 · 표본 · 프로세스 · 다시 연결 규칙 · 키 거부는 자동 재시도 0
 *  ⑨ 실제 api 라우터 — 권한(operator 403 · 범위 403 · 쓰기는 조회·쓰기 전체 범위) · 등록 검사(IPv4 정규형 · 루프백) · 503 · CSV 권한 · 보기 4종
 *  ⑩ 실제 central 라우터 — 개별 토큰 전용 · 응답 목록에 비밀 0
 *  ⑪ DB — 쓰기 · 읽기 · 정리 조각이 minute 단독 인덱스를 탄다
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import ssh2 from 'ssh2';
import zlib from 'node:zlib';

const { Server } = ssh2;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'focusmon2976-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
process.env.SSH_HOSTKEY_POLICY = 'observe';
process.env.CENTRAL_TOKEN = 'ctok-2976';
process.env.FOCUSMON_SSH_KEY = '';
process.env.AUTH_SECRET = 'test-secret-2976-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const FIX = path.join(HERE, 'fixtures/focusmon/container-linux-6.18.txt');
const SCRIPT = await import('../src/focusmon/script.js');
const P = await import('../src/focusmon/parse.js');
const R = await import('../src/focusmon/rates.js');
const CODEC = await import('../src/focusmon/codec.js');
const store = await import('../src/focusmon/store.js');
const registry = await import('../src/focusmon/registry.js');
const svc = await import('../src/focusmon/service.js');
const edge = await import('../src/central/focusMonEdge.js');
const collector = await import('../src/focusmon/collector.js');
const fmdb = await import('../src/focusmon/db.js');

const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch { /* */ } } svc.stopFocusMon(); });

/* ═══════════════════════════ ① 명령은 상수 ═══════════════════════════ */

test('① 원격 명령은 주기별 상수 넷 — 주기 숫자만 다르고 읽기 전용 · comm 만', () => {
  assert.deepEqual(Object.keys(SCRIPT.SCRIPTS).map(Number), [1, 2, 5, 10]);
  assert.ok(Object.isFrozen(SCRIPT.SCRIPTS));
  const norm = (s) => s.replace(/I=\d+; P=\d+; TE=\d+; MAXN=\d+/, 'X');
  const base = norm(SCRIPT.SCRIPTS[2]);
  for (const k of [1, 5, 10]) assert.equal(norm(SCRIPT.SCRIPTS[k]), base, `주기 ${k}초 상수도 같은 본문`);
  assert.equal(SCRIPT.scriptFor(3), SCRIPT.SCRIPTS[2], '목록 밖 주기는 기본(2초) 상수');
  assert.equal(SCRIPT.scriptFor("2; rm -rf /"), SCRIPT.SCRIPTS[2], '주기 자리에 글자가 와도 상수만');
  const s = SCRIPT.SCRIPTS[2];
  assert.ok(!/cmdline|environ/.test(s), '프로세스 인자 · 환경을 읽지 않는다');
  assert.ok(!/\bsudo\b|\bsu\b|pkexec|doas/.test(s), 'sudo 류 0');
  assert.ok(!/\brm\b|\btee\b|\bkill\b|\bmkdir\b|\btouch\b/.test(s), '쓰기 · 종료 명령 0');
  const shell = s.replace(/awk '[^']*'/g, 'awk PROG'); // awk 프로그램 안의 비교(>0)는 리다이렉트가 아니다
  const redirects = [...shell.matchAll(/(?:^|[\s;])(\d?>{1,2})\s*([^\s)";|]+)/gm)].map((m) => m[1] + m[2]);
  assert.ok(redirects.length > 0 && redirects.every((r) => r === '2>/dev/null'), `리다이렉트는 /dev/null 만: ${redirects.join(' | ')}`);
  assert.match(s, /ps -e -o pid=,user:32=/, 'ps 는 pid · 사용자만');
  assert.ok(!/getline/.test(s), 'awk getline 으로 /proc 을 읽지 않는다(mawk 중단)');
  assert.match(s, /cat \/proc\/\[0-9\]\*\/stat 2>\/dev\/null \| awk/);
  assert.ok(!/[^\n]*\$\{?(name|host|user|target)/i.test(s), '대상 정보 변수 없음');
});

/* ═══════════════════════════ ② 파서 ═══════════════════════════ */

test('② 실제 출력(이 컨테이너 /proc) — 프레임 6개 · HELLO · ##PS 를 받는다', () => {
  const frames = []; let hello = null;
  const p = P.createFrameParser({ onHello: (h) => { hello = h; }, onFrame: (f) => frames.push(P.frameToRaw(f)) });
  for (const l of fs.readFileSync(FIX, 'utf8').split('\n')) p.push(l);
  assert.equal(frames.length, 6);
  assert.equal(hello.isLinux, true);
  assert.equal(hello.tck, 100);
  assert.ok(frames[0].ps instanceof Map && frames[0].ps.size > 10, '##PS(두 글자 표지)도 구획으로 받는다 — 초판은 정규식이 세 글자부터라 버렸다');
  assert.ok(frames[0].netTopo && frames[0].blk && frames[0].proc, '30초 구획이 첫 프레임에 있다');
  assert.equal(frames[1].netTopo, null, '30초 구획은 매 프레임이 아니다');
});

test('② 표지 위조 · 재개방 · END 없음은 그 프레임을 버린다', () => {
  const frames = [];
  const p = P.createFrameParser({ onFrame: (f) => frames.push(f) });
  const feed = (ls) => ls.forEach((l) => p.push(l));
  feed(['##T 10.00 1700000000', '##STAT', 'cpu  1 2 3 4 5 6 7 8', '##MEM', 'MemTotal: 10 kB', '##STAT', 'cpu  1 1 1 1', '##END']); // 재개방
  feed(['##T 11.00 1700000001', '##MEM', 'MemTotal: 10 kB', '##STAT', '##END']); // 역순
  feed(['##T 12.00 1700000002', '##STAT', 'cpu  1 2 3 4 5 6 7 8']); // END 없이
  feed(['##T 13.00 1700000003', '##STAT', 'cpu  1 2 3 4 5 6 7 8', ' ##END', '##ENDX', '##END']); // 앞 공백 · 다른 글자는 표지가 아니다
  assert.equal(frames.length, 1, '마지막 정상 프레임만');
  assert.equal(frames[0].up, 13);
  assert.deepEqual(frames[0].sec.STAT.slice(1), [' ##END', '##ENDX'], '표지 아닌 줄은 데이터로');
  const long = P.createFrameParser({ onFrame: (f) => frames.push(f) });
  long.push('##T 1.00 1'); long.push('##DISK'); for (let i = 0; i < 1100; i++) long.push(`8 0 sd${i} 1 1 1 1 1 1 1 1 0 1 1`); long.push('##END');
  assert.equal(frames[1].sec.DISK.length, P.SECTION_MAX_LINES.DISK);
  assert.deepEqual(frames[1].truncated, ['DISK'], '잘렸다는 사실을 남긴다');
});

/* ═══════════════════════════ ③ iostat 식 ═══════════════════════════ */

/** /proc/diskstats 두 표본(11칸) — 1초 동안 주어진 증가. */
function ds(d) { // d: { rIos, rMer, rSec, rTk, wIos, wMer, wSec, wTk, fl, io, tiq }
  const a = new Array(11).fill(1000);
  const b = a.slice();
  b[0] += d.rIos || 0; b[1] += d.rMer || 0; b[2] += d.rSec || 0; b[3] += d.rTk || 0; b[4] += d.wIos || 0; b[5] += d.wMer || 0; b[6] += d.wSec || 0; b[7] += d.wTk || 0;
  b[8] = d.fl || 0; b[9] += d.io || 0; b[10] += d.tiq || 0;
  return [a, b];
}
test('③ iostat 13칸 — 사용자가 보낸 iostat 출력의 sdj · sdd · sde 를 같은 식으로 재현', () => {
  const C = Object.fromEntries(R.IOSTAT_COLS.map((c, i) => [c, i]));
  // sdj: w/s 52 · wMB/s 7.85 · avgqu-sz 148.07 · await 3076.17 · w_await 3076.17 · svctm 19.23 · %util 100
  let [a, b] = ds({ wIos: 52, wSec: Math.round(7.85 * 2048), wTk: Math.round(3076.17 * 52), io: 1000, tiq: 148070 });
  let v = R.iostatOf(a, b, 1).v;
  assert.equal(v[C.w], 52); assert.equal(v[C.wMB], 7.85); assert.equal(v[C.wAwait], 3076.17); assert.equal(v[C.await], 3076.17);
  assert.equal(v[C.svctm], 19.23); assert.equal(v[C.util], 100); assert.equal(v[C.qu], 148.07);
  assert.ok(Math.abs(v[C.rqsz] - 309.17) < 0.05, `avgrq-sz ${v[C.rqsz]}`);
  assert.equal(v[C.rAwait], null, '읽기 0건이면 r_await 은 null(iostat 은 0.00)');
  // sdd(두 번째 표본): r/s 1 · w/s 2 · r_await 2360 · w_await 0 · await 786.67 · svctm 333.33 · %util 100
  [a, b] = ds({ rIos: 1, rSec: 16, rTk: 2360, wIos: 2, wSec: 16, wTk: 0, io: 1000, tiq: 1660 });
  v = R.iostatOf(a, b, 1).v;
  assert.equal(v[C.await], 786.67); assert.equal(v[C.svctm], 333.33); assert.equal(v[C.rAwait], 2360); assert.equal(v[C.wAwait], 0);
  // sdd(첫 표본): 끝난 요청 0 · 걸린 요청 2 · %util 100 → 지연 null · stuck
  [a, b] = ds({ fl: 2, io: 1000, tiq: 2000 });
  const io = R.iostatOf(a, b, 1);
  assert.equal(io.v[C.await], null); assert.equal(io.v[C.svctm], null); assert.equal(io.v[C.rqsz], null);
  assert.equal(io.v[C.util], 100); assert.equal(io.inflight, 2);
  const s = R.computeSample({ up: 1, disk: { sdd: a } }, { up: 2, disk: { sdd: b } }, { blk: { sdd: { name: 'sdd', kname: 'sdd', type: 'disk', parent: null, size: 1, mount: '' } } });
  assert.equal(s.dsk[0].stuck, true, '끝난 요청 0 · 걸린 요청 · 사용률 100% = 응답 없음');
  assert.equal(R.summaryOf(s).stuck, true);
  // 카운터가 줄었으면(재부팅) 그 칸은 null
  [a, b] = ds({ wIos: 52, wSec: 100, wTk: 100, io: 100 });
  assert.equal(R.iostatOf(b, a, 1).v[C.w], null);
});

test('③ 전체 디스크 = 물리 디스크만 · 지연은 요청 수 가중 · 구간 평균도 가중', () => {
  const t = R.aggregateIostat([{ v: [0, 0, 0, 100, 0, 10, 0, 1, 0, null, 10, 0, 50] }, { v: [0, 0, 0, 300, 0, 30, 0, 3, 0, null, 2, 0, 90] }]);
  assert.equal(t[3], 400); assert.equal(t[10], 4, '(100×10 + 300×2) / 400'); assert.equal(t[12], 90, '사용률은 최고값');
  const avg = R.timeAverageIostat([[0, 0, 0, 10, 0, 1, 0, 0, 0, null, 50, 0, 10], [0, 0, 0, 0, 0, 0, null, 0, null, null, null, null, 0]]);
  assert.equal(avg[3], 5, '횟수는 평균'); assert.equal(avg[10], 50, '지연은 요청이 있던 표본으로 가중(0건 표본이 지연을 끌어내리지 않는다)');
});

/* ═══════════════════════════ ④ 본딩 · 프로세스 ═══════════════════════════ */

test('④ 본딩 속도 — 802.3ad 는 올라온 구성원 합 · active-backup 은 쓰는 하나 · 속도 모름은 사용률 null', () => {
  const topo = {
    bond0: { speed: null, state: 'up', phys: false, master: null, bondMode: '802.3ad', slaves: ['eno1', 'eno2'], active: null },
    eno1: { speed: 10000, state: 'up', phys: true, master: 'bond0', bondMode: null, slaves: [], active: null },
    eno2: { speed: 10000, state: 'up', phys: true, master: 'bond0', bondMode: null, slaves: [], active: null },
    bond1: { speed: null, state: 'up', phys: false, master: null, bondMode: 'active-backup', slaves: ['ens1', 'ens2'], active: 'ens1' },
    ens1: { speed: 10000, state: 'up', phys: true, master: 'bond1', bondMode: null, slaves: [], active: null },
    ens2: { speed: 10000, state: 'up', phys: true, master: 'bond1', bondMode: null, slaves: [], active: null },
    tun0: { speed: null, state: 'unknown', phys: false, master: null, bondMode: null, slaves: [], active: null },
  };
  const cnt = (rx, tx) => ({ rxB: rx, rxErr: 0, rxDrop: 0, txB: tx, txErr: 0, txDrop: 0 });
  const prev = { up: 10, net: { bond0: cnt(0, 0), eno1: cnt(0, 0), eno2: cnt(0, 0), bond1: cnt(0, 0), ens1: cnt(0, 0), ens2: cnt(0, 0), tun0: cnt(0, 0) } };
  const cur = { up: 11, net: { bond0: cnt(250_000_000, 0), eno1: cnt(125_000_000, 0), eno2: cnt(125_000_000, 0), bond1: cnt(125_000_000, 0), ens1: cnt(125_000_000, 0), ens2: cnt(0, 0), tun0: cnt(1_000, 1_000) } };
  const s = R.computeSample(prev, cur, { topo });
  const by = Object.fromEntries(s.net.map((x) => [x.n, x]));
  assert.equal(by.bond0.k, 'bond'); assert.equal(by.bond0.sp, 20000); assert.equal(by.bond0.u, 10, '2 Gb/s ÷ 20 Gb');
  assert.equal(by.bond1.sp, 10000); assert.equal(by.bond1.u, 10, '1 Gb/s ÷ 10 Gb(쓰는 구성원 하나)');
  assert.equal(by.tun0.u, null, '속도를 모르면 사용률을 내지 않는다');
  assert.equal(R.summaryOf(s).netIf, 'bond0', '요약은 본딩 중 가장 바쁜 것');
});

test('④ 프로세스 상위 — 같은 pid 라도 시작 시각이 다르면(재사용) 버린다 · comm 만', () => {
  const prev = [{ pid: 10, ticks: 100, thr: 1, start: 500, rss: 10, comm: 'java' }, { pid: 11, ticks: 50, thr: 1, start: 600, rss: 10, comm: 'old' }];
  const cur = [{ pid: 10, ticks: 600, thr: 4, start: 500, rss: 256, comm: 'java' }, { pid: 11, ticks: 9999, thr: 1, start: 700, rss: 10, comm: 'new' }];
  const r = R.topProcs(prev, cur, { dt: 5, tck: 100, page: 4096, ncpu: 4, up: 1000, users: new Map([[10, 'wasadm']]) });
  assert.equal(r.top.length, 1);
  assert.deepEqual({ pid: r.top[0].pid, c: r.top[0].c, u: r.top[0].u, cpu: r.top[0].cpu, sh: r.top[0].sh }, { pid: 10, c: 'java', u: 'wasadm', cpu: 100, sh: 25 });
  assert.equal(r.top[0].rss, 1, '256 페이지 × 4KB = 1MB');
});

/* ═══════════════════════════ ⑤ 코덱 ═══════════════════════════ */

test('⑤ 묶음 코덱 왕복 — null 보존 · 늦게 온 표본 끼워 넣기 · 판 번호가 다르면 null', () => {
  const b = CODEC.newBlock(28_000_000);
  const t0 = 28_000_000 * 60_000;
  CODEC.appendToBlock(b, t0 + 4000, new Map([['a', 1.5], ['b', null]]), { net: {}, dsk: {} });
  CODEC.appendToBlock(b, t0 + 2000, new Map([['a', -3.25], ['c', 1e11]]), null);
  CODEC.appendToBlock(b, t0 + 4000, new Map([['b', 7]]), null);
  assert.deepEqual(b.ts, [t0 + 2000, t0 + 4000]);
  const d = CODEC.decodeBlock(CODEC.encodeBlock(b));
  assert.deepEqual(d.ts, [t0 + 2000, t0 + 4000]);
  assert.deepEqual(d.cols.get('a'), [-3.25, 1.5]);
  assert.deepEqual(d.cols.get('b'), [null, 7]);
  assert.deepEqual(d.cols.get('c'), [1e11, null]);
  const raw = zlib.inflateRawSync(CODEC.encodeBlock(b));
  const hl = raw.readUInt32LE(0);
  const h = JSON.parse(raw.subarray(4, 4 + hl).toString()); h.v = 99;
  const hb = Buffer.from(JSON.stringify(h)); const len = Buffer.alloc(4); len.writeUInt32LE(hb.length);
  assert.equal(CODEC.decodeBlock(zlib.deflateRawSync(Buffer.concat([len, hb, raw.subarray(4 + hl)]))), null);
  assert.equal(CODEC.decodeBlock(Buffer.from('garbage')), null, '깨진 줄은 던지지 않고 null');
});

/* ═══════════════════════════ ⑥ 수집(세션) ═══════════════════════════ */

test('⑥ 수집 상한 · 잠깐 보기 시한 · 보는 화면 없음 · 계속 수집 이어 받기 · 안 볼 때 10초', () => {
  store._resetForTest();
  const ids = (n, p) => Array.from({ length: n }, (_, i) => `fm-${p}${String(i).padStart(7, '0')}`);
  assert.equal(store.startSession({ targets: ids(21, 'a') }).code, 'too-many');
  const now = 1_800_000_000_000;
  const a = store.startSession({ targets: ids(20, 'a'), mode: 'watch', interval: 2 }, now);
  assert.equal(a.ok, true);
  const rec = store.startSession({ targets: ids(20, 'b'), mode: 'record', interval: 1 }, now);
  assert.equal(rec.ok, true);
  assert.equal(store.startSession({ targets: ids(1, 'c') }, now).code, 'too-many-total', '서로 다른 대상 40대');
  // v2.979 중복 방지: 이미 수집 중인 서버만 고르면 새 수집을 만들지 않는다(예전에는 같은 서버로 두 번째 수집을 만들었다 — 동시 수집 상한은 focusMonSess2979 ②)
  assert.equal(store.startSession({ targets: ids(1, 'b'), mode: 'record' }, now).code, 'already', '이미 수집 중인 서버만이면 already');
  assert.equal(store.startSession({ targets: ids(1, 'a') }, now).code, 'already');
  // 계속 수집 정의는 파일로 — 재시작(메모리 초기화) 뒤 이어 받는다
  const file = path.join(DIR, 'focusmon-sessions.json');
  assert.ok(fs.existsSync(file));
  assert.ok(!fs.readFileSync(file, 'utf8').includes(ids(1, 'a')[0]), '잠깐 보기는 파일에 남기지 않는다');
  store._resetForTest();
  assert.equal(store.listSessions().filter((s) => s.mode === 'record').length, 1, '계속 수집 1건(중복 수집은 만들어지지 않았다)');
  // 안 볼 때 10초 · 보면 원래 주기
  const resolve = (id) => ({ id, host: '10.0.0.1', port: 22, username: 'u', agent: '', enabled: true });
  let d = store.desiredFor('', resolve, now + 120_000);
  assert.ok(d.every((x) => x.interval === 10), '계속 수집뿐이고 60초 안에 본 화면이 없으면 10초');
  store.touchView([ids(1, 'b')[0]], now + 120_000);
  d = store.desiredFor('', resolve, now + 121_000);
  assert.equal(d.find((x) => x.id === ids(1, 'b')[0]).interval, 1);
  // 잠깐 보기: 보는 화면이 60초 없으면 끝(시작 90초 유예 뒤) · 시한이면 끝
  const w = store.startSession({ targets: ids(2, 'c'), mode: 'watch' }, now);
  assert.equal(w.ok, true);
  assert.equal(store.expireSessions(now + 80_000).length, 0, '시작 90초 유예');
  assert.equal(store.expireSessions(now + 95_000)[0]?.why, 'no-viewer');
  const w2 = store.startSession({ targets: ids(2, 'c'), mode: 'watch' }, now);
  for (let t = now; t < now + 16 * 60_000; t += 30_000) store.touchView(ids(2, 'c'), t);
  assert.equal(store.extendSession(w2.session.id, now + 60_000).ok, true);
  assert.equal(store.expireSessions(now + 16 * 60_000).length, 0, '연장했으니 15분에 끝나지 않는다');
  const ex = store.expireSessions(now + 31 * 60_000);
  assert.equal(ex[0]?.why, 'timeout');
  store._resetForTest();
  fs.rmSync(file, { force: true });
});

/* ═══════════════════════════ ⑦ 엣지 동기화 정제 ═══════════════════════════ */

test('⑦ 엣지 동기화 — 남의 대상은 버림 · 시각은 수신 시각으로 · 모르는 값은 null · 응답에 비밀 0', () => {
  store._resetForTest(); registry._resetForTest();
  const agents = ['edge-pl', 'edge-us'];
  const a = registry.addTarget({ name: 'pl-db-01', host: '10.48.20.11', port: 22, username: 'dvcmon', agent: 'edge-pl' }, { agents });
  const b = registry.addTarget({ name: 'us-db-01', host: '10.64.20.11', port: 22, username: 'dvcmon', agent: 'edge-us' }, { agents });
  assert.ok(a.ok && b.ok);
  const now = 1_800_000_100_000;
  store.startSession({ targets: [a.target.id, b.target.id], mode: 'watch', interval: 2 }, now);
  const s = { dt: 2, cpu: { pct: 50, usr: 40, sys: 10, iow: 0, stl: 0, irq: 0, cores: [50, '60', null] }, mem: { pct: 'x', total: 100 }, net: [{ n: 'bond0', k: 'bond', rx: 5, tx: 6, u: 1, evil: 1 }, { n: 'a b', k: 'phys' }], dsk: [{ n: 'sdb', k: 'disk', v: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13] }, { n: '../x', k: 'disk', v: [] }], dtot: null };
  const r = edge.handleEdgeSync('edge-pl', {
    sentAt: 5_000_000, version: '2.975.0', key: { present: true, usable: true, type: 'ecdsa-sha2-nistp256', fingerprint: 'SHA256:' + 'A'.repeat(43), publicKey: 'ecdsa-sha2-nistp256 ' + 'A'.repeat(100) + ' dvc@edge', privateKey: 'LEAK' },
    samples: [{ id: a.target.id, t: 4_990_000, s }, { id: b.target.id, t: 4_990_000, s }, { id: 'fm-nope0000', t: 4_990_000, s }],
    status: { [a.target.id]: { state: 'ok', lastSampleAt: 9e15, interval: 2 }, [b.target.id]: { state: 'auth' } },
  }, now);
  assert.equal(r.accepted.samples, 1);
  assert.equal(r.accepted.foreign, 3, '다른 엣지 대상 · 등록부에 없는 id 는 버린다(표본 2 + 상태 1)');
  const latest = store.latestOf(a.target.id);
  assert.equal(latest.ts, now - 10_000, '엣지 시각 → 수신 시각 − (보낸 시각 − 표본 시각)');
  assert.equal(latest.sample.cpu.cores[1], 60, '숫자 글자는 수로');
  assert.equal(latest.sample.mem.pct, null, '모르는 값은 null(0 아님)');
  assert.deepEqual(latest.sample.net.map((x) => x.n), ['bond0'], '이름 형식이 아니면 버린다');
  assert.ok(!('evil' in latest.sample.net[0]), '모르는 칸은 버린다');
  assert.deepEqual(latest.sample.dsk.map((x) => x.n), ['sdb']);
  assert.equal(store.statusOf(a.target.id).lastSampleAt, now, '엣지가 말한 미래 시각은 수신 시각으로 자른다');
  assert.equal(store.statusOf(b.target.id), null, '남의 대상 상태도 버린다');
  assert.ok(!JSON.stringify(store.edgeStateOf('edge-pl')).includes('LEAK'), '모르는 키 칸(개인키 흉내)은 남기지 않는다');
  assert.deepEqual(r.targets.map((x) => x.id), [a.target.id], '그 엣지 대상만 받는다');
  assert.deepEqual(Object.keys(r.targets[0]).sort(), ['host', 'id', 'interval', 'port', 'username']);
  assert.ok(r.validUntil - now <= 30_000, '보류 시한 30초');
  // 엣지 시각은 나이(보낸 시각 − 표본 시각)만 쓰고, 미래는 수신 시각 · 너무 오래된 것은 보존 한도로 자른다(변이 M8).
  assert.equal(edge.edgeTimeToCentral(4_990_000, 5_000_000, now), now - 10_000);
  assert.equal(edge.edgeTimeToCentral(9e15, 5_000_000, now), now, '미래 → 수신 시각');
  assert.equal(edge.edgeTimeToCentral(5_000_000 - 3 * 3_600_000, 5_000_000, now), now - edge.EDGE_BACKLOG_MS, '3시간 전 → 보존 한도');
  assert.equal(edge.edgeTimeToCentral('x', 5_000_000, now), null);
  assert.equal(edge.edgeTimeToCentral(123, null, now), now, '보낸 시각이 없으면 나이 0');
  store._resetForTest();
});

/* ═══════════════════════════ ⑧ 실제 SSH ═══════════════════════════ */

function hostKey() { return crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'sec1', format: 'pem' }); }
/** 공개키만 받는 가짜 SSH 서버 — exec 는 이 컨테이너의 bash 로 실제로 돈다(스트림 · 채널 닫힘 · 끝나지 않는 반복문을 그대로 시험). */
async function fakeLinux({ rejectAll = false } = {}) {
  const st = { auths: 0, conns: 0, commands: [], allowed: null, children: [] };
  const srv = new Server({ hostKeys: [hostKey()] }, (client) => {
    st.conns++;
    client.on('authentication', (ctx) => {
      if (ctx.method !== 'none') st.auths++;
      if (rejectAll || ctx.method !== 'publickey' || !st.allowed) return ctx.reject(['publickey']);
      const pk = ssh2.utils.parseKey(st.allowed);
      if (ctx.key.algo !== pk.type || !ctx.key.data.equals(pk.getPublicSSH())) return ctx.reject(['publickey']);
      if (ctx.signature && !pk.verify(ctx.blob, ctx.signature, ctx.hashAlgo)) return ctx.reject(['publickey']);
      return ctx.accept();
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('exec', (acc, _rej, info) => {
          st.commands.push(info.command);
          const stream = acc();
          const ch = spawn('bash', ['-c', info.command], { stdio: ['ignore', 'pipe', 'pipe'] });
          st.children.push(ch);
          ch.stdout.on('data', (d) => { try { stream.write(d); } catch { /* */ } });
          ch.stderr.on('data', (d) => { try { stream.stderr.write(d); } catch { /* */ } });
          ch.on('close', (code) => { try { stream.exit(code ?? 0); stream.end(); } catch { /* */ } });
          stream.on('close', () => { try { ch.kill('SIGTERM'); } catch { /* */ } });
        });
      });
    });
    client.on('error', () => {});
    client.on('close', () => { st.closed = (st.closed || 0) + 1; for (const c of st.children) { try { c.kill('SIGTERM'); } catch { /* */ } } });
  });
  const port = await new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv.address().port)));
  closers.push(() => { for (const c of st.children) { try { c.kill('SIGKILL'); } catch { /* */ } } return new Promise((r) => srv.close(() => r())); });
  return { port, st, allow: (pub) => { st.allowed = pub; } };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15_000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await wait(100); } return false; }

test('⑧ 실제 SSH — 키로 붙어 고정 명령을 돌리고 1초 표본 · 프로세스 상위를 받는다 · 끝내면 원격 반복문도 끝난다', async () => {
  store._resetForTest(); registry._resetForTest();
  const key = svc.focusKeys.ensureKey();
  assert.equal(key.created, true);
  assert.equal(fs.statSync(path.join(DIR, 'ssh', 'focusmon_key')).mode & 0o777, 0o600);
  const fk = await fakeLinux();
  fk.allow(svc.focusKeys.publicKeyView().publicKey);
  const t = registry.addTarget({ name: 'local', host: '127.0.0.1', port: fk.port, username: 'dvcmon' }, { agents: [] });
  assert.equal(t.ok, true, t.reason);
  const r = svc.startCollection({ targets: [t.target.id], interval: 1, mode: 'watch', by: 'tester' });
  assert.equal(r.ok, true);
  assert.ok(await until(() => (store.latestOf(t.target.id) && store.latestProcsOf(t.target.id))), '8초 안에 표본 · 프로세스가 온다');
  assert.deepEqual(fk.st.commands, [SCRIPT.SCRIPTS[1]], '대상에 간 명령 === 1초 상수');
  const s = store.latestOf(t.target.id).sample;
  assert.ok(s.cpu && s.mem && s.dsk.length > 0, '실제 /proc 에서 CPU · 메모리 · 디스크');
  assert.ok(store.latestProcsOf(t.target.id).top.length > 0);
  assert.equal(store.statusOf(t.target.id).state, 'ok');
  assert.equal(store.statusOf(t.target.id).hello.isLinux, true);
  // 주기 변경 → 같은 연결을 끊고 새 상수로
  svc.stopCollection(r.session.id);
  svc.tick1();
  assert.ok(await until(() => (fk.st.closed || 0) >= 1, 5_000), '수집을 끝내면 SSH 연결을 닫는다(실제 sshd 는 그때 원격 셸에 SIGHUP — 반복문이 끝난다)');
  assert.ok(await until(() => fk.st.children.every((c) => c.exitCode !== null || c.signalCode !== null), 8_000), '원격 반복문(bash)도 끝났다');
});

test('⑧ 키 로그인 거부 → 멈춘다(다음 시도 0) · 시험도 거부 · 다시 연결은 60초에 한 번', async () => {
  store._resetForTest(); registry._resetForTest();
  const fk = await fakeLinux({ rejectAll: true });
  const t = registry.addTarget({ name: 'deny', host: '127.0.0.1', port: fk.port, username: 'dvcmon' }, { agents: [] });
  const r = svc.startCollection({ targets: [t.target.id], interval: 1, mode: 'watch' });
  assert.ok(await until(() => store.statusOf(t.target.id)?.state === 'auth'), '인증 거부 상태');
  const conns = fk.st.conns;
  await wait(3_000);
  svc.tick1();
  assert.equal(fk.st.conns, conns, '멈춘 대상은 다시 로그인하지 않는다(계정 잠금 방지)');
  // 수집을 끝내고 새로 시작해도(새 수집기) 정지 기록을 보고 붙지 않는다(변이 M3 — 정지 판정을 빼면 새 수집기가 다시 로그인한다).
  svc.stopCollection(r.session.id); svc.tick1();
  const r2 = svc.startCollection({ targets: [t.target.id], interval: 1, mode: 'watch' });
  assert.ok(r2.ok, JSON.stringify(r2));
  svc.tick1();
  await wait(2_000);
  assert.equal(fk.st.conns, conns, '새 수집도 로그인하지 않는다');
  assert.equal(store.statusOf(t.target.id)?.state, 'auth');
  const tr = await svc.localRunner.test(registry.getTarget(t.target.id));
  assert.equal(tr.kind, 'auth-stopped', '정지 중이면 시험도 하지 않는다');
  assert.equal(fk.st.conns, conns);
  assert.equal(svc.localRunner.retry(t.target.id).ok, true);
  assert.ok(await until(() => fk.st.conns > conns), '다시 연결은 한 번 시도한다');
  assert.equal(svc.localRunner.retry(t.target.id).code, 'too-soon', '60초 안에 다시 누르면 거절');
  svc.stopCollection(r2.session.id); svc.tick1();
});

test('⑧ 리눅스가 아니면 멈추고 말한다 · 호스트키 거부는 인증 실패가 아니다', async () => {
  const seen = [];
  const fakeConnect = async (_creds, fn) => fn({ execStream: async (_cmd, { onLine }) => { ['##HELLO 1', 'uname Darwin 23.0 arm64', '##END'].forEach(onLine); return { code: 0 }; } });
  const c = collector.createCollector({ id: 'fm-x0000001', host: '10.0.0.9', port: 22, username: 'u' }, { interval: 2, keys: svc.focusKeys, connect: fakeConnect, onStatus: (st) => seen.push(st.state) });
  c.start();
  assert.ok(await until(() => seen.includes('unsupported-os'), 3_000));
  await wait(300);
  assert.equal(seen.filter((x) => x === 'connecting').length, 1, '다시 붙지 않는다');
  c.stop();
  const hk = Object.assign(new Error('SSH 호스트키 확인 거부 [SSH_HOSTKEY_UNTRUSTED]'), { code: 'SSH_HOSTKEY_UNTRUSTED' });
  const r = await collector.testTarget({ id: 'fm-x0000002', host: '10.0.0.9', port: 22, username: 'u' }, { keys: svc.focusKeys, connect: async () => { throw hk; } });
  assert.equal(r.kind, 'hostkey');
  assert.equal(collector.focusAuthGuard.peekAuthStop(collector.authDevOf({ id: 'fm-x0000002', host: '10.0.0.9', port: 22, username: 'u' }, svc.focusKeys.keyInfo().fingerprint)), null, '호스트키 거부로 인증 정지를 남기지 않는다');
});

/* ═══════════════════════════ ⑪ DB ═══════════════════════════ */

test('⑪ DB — 묶음 쓰기 · 범위 읽기 · 정리 조각은 minute 단독 인덱스', async () => {
  const b = CODEC.newBlock(1000);
  CODEC.appendToBlock(b, 1000 * 60_000 + 1000, new Map([['s.cpu', 10]]), { net: {}, dsk: {} });
  const r = await fmdb.writeBlocks([{ kind: 'm', target: 'fm-db000001', minute: 1000, n: 1, data: CODEC.encodeBlock(b) }, { kind: 'p', target: 'fm-db000001', minute: 1000, data: CODEC.encodeProcBlock([{ t: 1, n: 1, top: [] }]) }]);
  assert.equal(r.ok, true);
  const rows = await fmdb.readMetric('fm-db000001', 900, 1100);
  assert.equal(rows.length, 1);
  assert.equal(CODEC.decodeBlock(rows[0].data).cols.get('s.cpu')[0], 10);
  assert.deepEqual(await fmdb.coverage('fm-db000001', 0, 2000), [1000]);
  assert.match(fmdb._planForTest('SELECT rowid FROM fm_metric WHERE minute < ? LIMIT ?'), /USING COVERING INDEX idx_fm_metric_minute/);
  assert.equal(await fmdb.pruneChunk(1001), 2, '지표 · 프로세스 각 1줄');
  assert.equal((await fmdb.readMetric('fm-db000001', 0, 2000)).length, 0);
});

test('차트 칸 — 칸 폭을 표본 간격의 1.5배 이상으로 넓혀 수집 중인 구간에 빈 칸(끊긴 선)이 생기지 않는다', async () => {
  const Q = await import('../src/focusmon/query.js');
  // 2초 주기 · 표본마다 ±300ms 흔들림 — 5분 · 1분 구간 모두 칸 폭(150칸이면 2초 · 0.4초)이 주기 이하였다.
  const t0 = 1_000 * 60_000;
  const jit = [0, 300, -250, 120, -300, 280, -100, 0];
  const blocks = new Map(); // 분마다 묶음 하나(분당 표본 상한 MAX_N)
  for (let i = 0; i < 150; i++) {
    const ts = t0 + i * 2000 + jit[i % jit.length] + 300;
    const m = Math.floor(ts / 60_000);
    if (!blocks.has(m)) blocks.set(m, CODEC.newBlock(m));
    assert.ok(CODEC.appendToBlock(blocks.get(m), ts, new Map([['s.cpu', 10 + (i % 5)]]), null));
  }
  const pos = []; for (const b of blocks.values()) for (let i = 0; i < b.ts.length; i++) pos.push([b, i, b.ts[i]]);
  assert.ok(Q.sampleSpacing(pos) >= 1700 && Q.sampleSpacing(pos) <= 2700, `간격 ${Q.sampleSpacing(pos)}(2초 ± 흔들림 — 90번째 백분위)`);
  for (const winMin of [1, 5]) {
    const from = t0; const to = t0 + winMin * 60_000;
    const { avg } = Q.bucketize(pos, 's.cpu', from, to, 150);
    assert.ok(avg.length <= Math.floor((to - from) / 3000) && avg.length >= 2, `${winMin}분 칸 수 ${avg.length}`);
    assert.equal(avg.filter((v) => v == null).length, 0, `${winMin}분 구간에 빈 칸`);
  }
  // 표본이 없는 구간은 그대로 비운다(수집하지 않은 시간을 0 이나 이어진 선으로 그리지 않는다).
  const { avg } = Q.bucketize(pos, 's.cpu', t0, t0 + 10 * 60_000, 150);
  const empty = avg.filter((v) => v == null).length;
  assert.ok(empty >= avg.length / 2 - 2, `뒤쪽 5분은 비어야 한다 — 빈 칸 ${empty}/${avg.length}`);
  // 표본 1개 · 0개는 칸 수를 줄이지 않는다
  assert.equal(Q.sampleSpacing(pos.slice(0, 1)), null);
  assert.equal(Q.bucketize([], 's.cpu', t0, t0 + 60_000, 30).avg.length, 30);
});

test('엣지 워커 — 중앙 응답의 보류 시한(validUntil)이 지나면 수집기를 모두 닫는다(중앙이 끊겨도 SSH 를 계속 열어 두지 않는다)', async () => {
  const { config } = await import('../src/config.js');
  const worker = await import('../src/agent/focusMonWorker.js');
  const saved = { url: config.agent.centralUrl, tok: config.agent.centralToken };
  // 닿지 않는 중앙(연결 거부) — 동기화가 실패하고 마지막 성공 응답도 없다(validUntil = 0).
  config.agent.centralUrl = 'http://127.0.0.1:9';
  config.agent.centralToken = 'ctok-2976';
  try {
    worker._resetForTest();
    worker._runnerForTest.reconcile([{ id: 'fm-w0000001', host: '127.0.0.1', port: 9, username: 'dvcmon', interval: 2 }]);
    assert.equal(worker._runnerForTest.running().length, 1, '수집기 하나가 돈다');
    const r = await worker.syncOnce();
    assert.equal(r.ok, false, '중앙 실패');
    assert.equal(worker._runnerForTest.running().length, 0, '보류 시한이 지나 수집기를 닫았다');
  } finally {
    worker.stopFocusMonWorker(); worker._resetForTest();
    config.agent.centralUrl = saved.url; config.agent.centralToken = saved.tok;
  }
});

test('반증 2 · 4 · 8 — 원격 이름으로 프로토타입을 오염시키지 못한다 · 프레임 글자 상한 · 원격 head 는 파서 상한 + 1 · 요약 열이 먼저', () => {
  const blk = P.parseBlk(['NAME="x" KNAME="__proto__" PKNAME="" TYPE="disk" SIZE="1" MOUNTPOINT="/evil"', 'NAME="sda" KNAME="sda" PKNAME="constructor" TYPE="disk" SIZE="1" MOUNTPOINT=""']);
  assert.equal(Object.prototype.mount, undefined, 'Object.prototype 오염 없음');
  assert.deepEqual(Object.keys(blk), ['sda']);
  assert.equal(blk.sda.parent, null, '부모 이름도 프로토타입 이름은 받지 않는다');
  assert.deepEqual(Object.keys(P.parseNetDev(['__proto__: 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16'])), []);
  // 열린 프레임이 줄 수 상한 × 줄 길이 상한만큼 붙잡지 못한다 — 글자 상한을 넘으면 그 프레임을 버린다
  let frames = 0;
  const fp = P.createFrameParser({ onFrame: () => { frames += 1; } });
  fp.push('##T 1.00 1700000000'); fp.push('##PS');
  const big = 'x'.repeat(16 * 1024);
  for (let i = 0; i < Math.ceil(P.FRAME_MAX_CHARS / big.length) + 2; i++) fp.push(big);
  fp.push('##END');
  assert.equal(frames, 0, '넘친 프레임은 버린다');
  assert.equal(fp.stats().oversize, 1);
  fp.push('##T 2.00 1700000002'); fp.push('##LOAD'); fp.push('0.1 0.2 0.3 1/2 3'); fp.push('##END');
  assert.equal(frames, 1, '다음 프레임은 정상');
  // 원격 head -n 은 파서 상한 + 1 — 같으면 잘려도 파서가 몰랐다
  const script = SCRIPT.SCRIPTS[2];
  for (const [sec, re] of [['DISK', /head -n (\d+) \/proc\/diskstats/], ['NET', /head -n (\d+) \/proc\/net\/dev/], ['BLK', /MOUNTPOINT 2>\/dev\/null \| head -n (\d+)/], ['PS', /user:32= 2>\/dev\/null \| head -n (\d+)/]]) {
    assert.equal(Number(re.exec(script)?.[1]), P.SECTION_MAX_LINES[sec] + 1, `${sec} head = 파서 상한 + 1`);
  }
  // 요약 열(s.*) · 전체 디스크(t.*)가 먼저 — 열 상한에 닿아도 버려지지 않는다
  const { row } = CODEC.flattenSample({ dt: 2, cpu: { pct: 1, usr: 1, sys: 0, iow: 0, stl: 0, irq: 0, cores: [1, 2] }, mem: null, net: [], dsk: [{ n: 'sda', k: 'disk', v: Array(13).fill(1), fl: 0 }], dtot: Array(13).fill(1) });
  const keys = [...row.keys()];
  assert.equal(keys[0], 's.cpu');
  assert.ok(keys.indexOf('t.util') < keys.indexOf('c.pct') && keys.indexOf('t.util') < keys.indexOf('d.sda.util'));
});

test('반증 1 — 늦은 표본은 분마다 한 번만 다시 쓰고, 수집 중이 아닌 대상의 표본은 받지 않는다 · 분당 표본 상한', () => {
  store._resetForTest(); registry._resetForTest();
  const a = registry.addTarget({ name: 'pl-late', host: '10.48.20.31', port: 22, username: 'dvcmon', agent: 'edge-pl' }, { agents: ['edge-pl'] });
  const now = 1_800_000_200_000;
  const s = { dt: 2, cpu: { pct: 5, usr: 5, sys: 0, iow: 0, stl: 0, irq: 0, cores: [] }, mem: null, net: [], dsk: [], dtot: null };
  const lateBase = Math.floor((now - 150_000) / 60_000) * 60_000 + 1_000; // 2~3분 전 한 분 안(20초에 걸쳐 200개)
  const late = (k) => ({ id: a.target.id, t: lateBase + k * 100, s });
  const idle = edge.handleEdgeSync('edge-pl', { sentAt: now, samples: [late(0)] }, now);
  assert.equal(idle.accepted.samples, 0); assert.equal(idle.accepted.idle, 1, '아무도 수집하지 않는 대상은 받지 않는다');
  store.startSession({ targets: [a.target.id], mode: 'watch', interval: 2 }, now);
  edge.handleEdgeSync('edge-pl', { sentAt: now, samples: [{ id: a.target.id, t: now, s }] }, now); // 지금 분 묶음
  store.drainWrites(100_000);
  const before = store.memStats().rewrites;
  const r = edge.handleEdgeSync('edge-pl', { sentAt: now, samples: Array.from({ length: 200 }, (_, k) => late(k)) }, now);
  assert.equal(r.accepted.samples, 120, '분당 표본 상한(120)');
  assert.equal(store.memStats().rewrites - before, 1, '같은 분의 늦은 표본 200개 → 다시 쓰기 1번(예전: 표본마다)');
  const q = store.drainWrites(100_000).filter((x) => x.kind === 'm');
  assert.equal(q.length, 1);
  assert.equal(q[0].n, 120);
  store._resetForTest();
});

test('반증 3 · 9 — 로그인 뒤 세션이 곧바로 끝나면 물러난다(1초마다 다시 로그인하지 않는다) · 출력 없는 세션은 끊는다', async () => {
  let logins = 0; const seen = [];
  const quick = async (_c, fn) => { logins += 1; return fn({ execStream: async () => ({ code: 0 }) }); };
  const c = collector.createCollector({ id: 'fm-q0000001', host: '10.0.0.9', port: 22, username: 'u' }, { interval: 1, keys: svc.focusKeys, connect: quick, onStatus: (st) => seen.push(st.state) });
  svc.focusKeys.ensureKey();
  c.start();
  await wait(2_500);
  c.stop();
  assert.equal(logins, 1, `2.5초 동안 로그인 ${logins}번 — 곧바로 끝나는 세션은 물러난다(10초)`);
  assert.ok(seen.includes('error'), '오류로 보인다(연결 중에 머물지 않는다)');
  assert.ok(collector.idleLimitMs(2) >= 30_000 && collector.idleLimitMs(10) === 50_000);
});

test('반증 6 — 다시 연결은 60초 검사가 먼저(거절되면 정지를 풀지 않는다) · 수집 중이 아니어도 대상을 주면 정지만 푼다', () => {
  const t = { id: 'fm-r0000001', host: '10.0.0.10', port: 22, username: 'u' };
  const runner = svc.localRunner;
  const dev = collector.authDevOf(t, svc.focusKeys.keyInfo().fingerprint);
  collector.focusAuthGuard.markAuthStopped(dev.id, dev, '시험');
  const r1 = runner.retry(t.id, t);
  assert.equal(r1.ok, true); assert.equal(r1.running, false);
  assert.equal(collector.focusAuthGuard.peekAuthStop(dev), null, '정지가 풀렸다');
  collector.focusAuthGuard.markAuthStopped(dev.id, dev, '다시 거부');
  const r2 = runner.retry(t.id, t);
  assert.equal(r2.code, 'too-soon');
  assert.ok(collector.focusAuthGuard.peekAuthStop(dev), '60초 안의 두 번째 다시 연결은 정지를 풀지 않는다');
  collector.focusAuthGuard.clearAuthStop(dev.id);
});

test('반증 5 — 엣지 연결 시험은 한 번 내려보내면 60초 동안 다시 내려보내지 않는다', () => {
  store._resetForTest();
  store.requestEdgeTest('fm-t0000001', 'edge-pl', 1_000);
  assert.deepEqual(store.pendingTestsFor('edge-pl', 2_000), ['fm-t0000001']);
  assert.deepEqual(store.pendingTestsFor('edge-pl', 4_000), [], '2초 뒤 동기화에 다시 주지 않는다');
  assert.deepEqual(store.pendingTestsFor('edge-pl', 63_000), ['fm-t0000001'], '60초가 지나도 결과가 없으면 한 번 더');
  store._resetForTest();
});

test('차트 칸 — 주기가 바뀐 구간(계속 수집 10초 → 보는 동안 2초)도 선이 끊기지 않는다 · 1분 넘는 공백은 비운다(v2.977)', async () => {
  const Q = await import('../src/focusmon/query.js');
  const t0 = 2_000 * 60_000;
  const blocks = new Map();
  const put = (ts) => { const m = Math.floor(ts / 60_000); if (!blocks.has(m)) blocks.set(m, CODEC.newBlock(m)); assert.ok(CODEC.appendToBlock(blocks.get(m), ts, new Map([['s.cpu', 30]]), null)); };
  for (let t = t0; t < t0 + 180_000; t += 10_000) put(t + 137);          // 3분 — 10초(보는 화면 없음)
  for (let t = t0 + 180_000; t < t0 + 300_000; t += 2_000) put(t + 211); // 2분 — 2초(보는 중)
  const pos = []; for (const b of [...blocks.values()].sort((a, c) => a.minute - c.minute)) for (let i = 0; i < b.ts.length; i++) pos.push([b, i, b.ts[i]]);
  assert.equal(Q.sampleSpacing(pos), 10_000, '큰 쪽 간격(예전 중앙값은 2초)');
  const { avg } = Q.bucketize(pos, 's.cpu', t0, t0 + 300_000, 90);
  const first = avg.findIndex((v) => v != null); const last = avg.length - 1 - [...avg].reverse().findIndex((v) => v != null);
  assert.equal(avg.slice(first, last + 1).filter((v) => v == null).length, 0, `첫 표본과 끝 표본 사이 빈 칸 0(칸 ${avg.length})`);
  // 2분 공백이 있으면 그 칸들은 비운다(수집하지 않은 시간)
  const gapPos = pos.filter(([, , ts]) => ts < t0 + 60_000 || ts >= t0 + 180_000);
  const g = Q.bucketize(gapPos, 's.cpu', t0, t0 + 300_000, 90).avg;
  assert.ok(g.filter((v) => v == null).length >= 5, '1분 넘는 공백은 빈 칸으로 남는다');
});
