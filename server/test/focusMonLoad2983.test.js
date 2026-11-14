/**
 * test/focusMonLoad2983.test.js — v2.983 서버 집중 모니터링 '수집 부하'(사용자 2026-11-12 "이렇게 데이터를 수집하는게 엣지노드와 수집 대상 서버에 부하를 얼마나
 * 주는지 확인하는 방법, 서버에서 상태 수집해서 수집방법에 따른 분석해서 보여주는 기능" → 시안 ⑪ · '구현해줘' + 구획 비용 '늘 잼 · 세 묶음').
 *  ① 원격 명령: (주기 × 프로세스 표본 주기) 12개 상수 · 목록 밖 값은 기본 · ##SELF 는 30초 구획 안 · 묶음 tick 은 셸 내장 명령만 · comm 을 싣지 않는다 ·
 *     bash · dash 에서 실제로 돌려 ##SELF 를 받는다(이 컨테이너 원문 픽스처도)
 *  ② 파서: ##SELF(s · p · c) · 칸이 모자라거나 수가 아니면 null(0 아님) · 묶음별 바이트(표지 줄 포함 · 합 = 받은 글자 + 줄바꿈)
 *  ③ 계산 코어: loadWindow(창 길이 · tick 감소 · tck 없음 → null) · judgeLoad · estimateLoad(모르는 묶음 → 합 null) · averageLoads · loadTotals
 *  ④ 수집기(가짜 SSH 스트림): ##SELF 두 번 → onLoad 창 · 새 세션은 앞 창과 잇지 않는다 · 프로세스 표본 주기를 바꾸면 새 상수로 다시 연다
 *  ⑤ 엣지: cleanLoad · cleanNodeLoad 화이트리스트 · 남의 대상 · 받지 않는 대상의 부하는 버린다 · 응답 procEvery · 워커 본문 load · diag.node · 실패하면 되돌린다
 *  ⑥ 라우트 GET /tools/focus-mon/load: 문(운영자 · 범위 계정 403) · 보이는 대상만 · 데모 계정에 엣지 노드 없음 · 오래된 창은 값 대신 staleS · 과거 구간은 DB 평균
 *  ⑦ 설정 · DB: procEvery 는 5 · 15 · 30 만 · 문턱 큼 > 보통 · fm_load · fm_node 쓰기 · 읽기 · 정리(minute 인덱스)
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'focusmonload2983-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'mock';
process.env.CENTRAL_TOKEN = 'ctok-load-2983';
process.env.FOCUSMON_SSH_KEY = '';
process.env.AUTH_SECRET = 'test-secret-load-2983-xxxxxxxxxxxxxxxxxxxxxxxxxx';

const express = (await import('express')).default;
const { api } = await import('../src/routes/api.js');
const { centralRouter } = await import('../src/routes/central.js');
const { issueAgentToken } = await import('../src/central/agentTokens.js');
const svc = await import('../src/focusmon/service.js');
const SCRIPT = await import('../src/focusmon/script.js');
const P = await import('../src/focusmon/parse.js');
const L = await import('../src/focusmon/load.js');
const store = await import('../src/focusmon/store.js');
const registry = await import('../src/focusmon/registry.js');
const db = await import('../src/focusmon/db.js');
const edge = await import('../src/central/focusMonEdge.js');
const worker = await import('../src/agent/focusMonWorker.js');
const mock = await import('../src/focusmon/mock.js');
const { config } = await import('../src/config.js');

const HERE = path.dirname(new URL(import.meta.url).pathname);
const FIX = path.join(HERE, 'fixtures/focusmon/container-linux-6.18-load2983.txt');

const users = {
  admin: { username: 'a', role: 'admin', scope: null },
  operator: { username: 'o', role: 'operator', scope: null },
  rscoped: { username: 'r', role: 'admin', scope: { vcenters: ['vc-x'] } },
  demo: { username: 'thedvcdemp', role: 'admin', scope: null, demoGuest: true },
};
const app = express();
app.use(express.json({ limit: '16mb' }));
app.use('/api/central', centralRouter);
app.use((req, _res, next) => { req.user = users[req.headers['x-test-user'] || 'admin']; next(); });
app.use('/api', api);
const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${srv.address().port}`;
after(() => { worker.stopFocusMonWorker(); svc.stopFocusMon(); srv.close(); });
async function call(method, p, { who = 'admin', body, headers = {} } = {}) {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'x-test-user': who, ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { json = null; }
  return { status: r.status, body: json, text };
}
const reset = () => { fs.rmSync(path.join(DIR, 'focusmon-targets.json'), { force: true }); registry._resetForTest(); store._resetLoadForTest(); for (const s of store.listSessions()) store.stopSession(s.id); };
const parseAll = (lines) => { const frames = []; const p = P.createFrameParser({ onFrame: (f) => frames.push(P.frameToRaw(f)) }); for (const l of lines) p.push(l); return frames; };

/* ── ① 원격 명령 ── */
test('① 원격 명령 — 12개 상수 · 목록 밖 값은 기본 · ##SELF 는 30초 구획 · 묶음 tick 은 내장 명령만 · comm 을 싣지 않는다', () => {
  assert.equal(Object.keys(SCRIPT.SCRIPT_TABLE).length, SCRIPT.INTERVALS.length * SCRIPT.PROC_EVERY_CHOICES.length);
  assert.ok(Object.isFrozen(SCRIPT.SCRIPT_TABLE));
  for (const i of SCRIPT.INTERVALS) {
    assert.equal(SCRIPT.scriptFor(i), SCRIPT.SCRIPTS[i], '프로세스 표본 주기를 안 주면 예전 상수(5초)');
    assert.equal(SCRIPT.scriptFor(i, 5), SCRIPT.SCRIPTS[i]);
    for (const p of SCRIPT.PROC_EVERY_CHOICES) assert.match(SCRIPT.scriptFor(i, p), new RegExp(`^I=${i}; P=${p}; TE=`, 'm'), `I=${i} P=${p}`);
  }
  assert.equal(SCRIPT.scriptFor(2, 10), SCRIPT.SCRIPTS[2], '목록 밖 표본 주기(10)는 기본 5초 상수');
  assert.equal(SCRIPT.scriptFor(2, '15; rm -rf /'), SCRIPT.SCRIPTS[2], '글자가 와도 상수만');
  assert.equal(SCRIPT.scriptFor(2, '15'), SCRIPT.SCRIPT_TABLE['2/15'], '수 글자는 수로');
  const norm = (s) => s.replace(/I=\d+; P=\d+; TE=\d+; MAXN=\d+/, 'X');
  const body = norm(SCRIPT.SCRIPTS[2]);
  for (const k of Object.keys(SCRIPT.SCRIPT_TABLE)) assert.equal(norm(SCRIPT.SCRIPT_TABLE[k]), body, `${k} 도 숫자 줄만 다르다`);
  const s = SCRIPT.SCRIPTS[2];
  const lines = s.split('\n');
  const fn = lines.find((l) => l.startsWith('ck() {'));
  assert.ok(fn, '묶음 tick 함수');
  assert.ok(!/\b(cat|awk|grep|cut|head|sed|ps|date)\b|\$\((?!\()|`/.test(fn), `묶음 tick 은 내장 명령만(명령 치환 · 외부 명령 없음 — 산술 $(( )) 은 내장): ${fn}`);
  assert.match(fn, /<\/proc\/\$\$\/stat/, '자기 stat 만 읽는다');
  assert.equal(lines.filter((l) => /ck; C[BCP]=\$\(\(C[BCP] \+ CK - L\)\); L=\$CK/.test(l)).length, 3, '묶음 셋(기본 · 구성 · 프로세스) 뒤에 한 번씩');
  // 묶음 위치: 기본은 DISK 바로 뒤 · 구성은 UNIT 바로 뒤 · 프로세스는 IO 바로 뒤(파서 SECTION_GROUP 과 같은 경계)
  const at = (re) => lines.findIndex((l) => re.test(l));
  assert.equal(at(/ck; CB=/), at(/echo '##DISK'/) + 1);
  assert.equal(at(/ck; CC=/), at(/echo '##UNIT'/) + 1);
  assert.equal(at(/ck; CP=/), at(/echo '##IO'/) + 1);
  const selfAt = at(/echo '##SELF'/);
  const endAfter = lines.findIndex((l, i) => i > selfAt && /echo '##END'/.test(l));
  assert.ok(selfAt > at(/ck; CP=/) && endAfter > selfAt && endAfter - selfAt <= 5, '##SELF 는 프레임 끝(프로세스 묶음 뒤 · 반복문의 ##END 바로 앞)');
  assert.match(lines[selfAt - 1], /if \[ \$\(\(n % TE\)\) -eq 0 \]; then/, '30초 구획 안');
  const selfBlock = lines.slice(selfAt, selfAt + 4).join('\n');
  assert.match(selfBlock, /\$\{x##\*\) \}/, "')' 뒤만 — comm(이름)을 싣지 않는다");
  assert.match(selfBlock, /\/proc\/\$PPID\/stat/, 'sshd 세션 = 부모');
  assert.ok(!/cmdline|environ|\/fd\b|\/exe\b/.test(selfBlock), '인자 · 환경 · 열린 파일 없음');
  assert.match(selfBlock, /\[ -z "\$CKBAD" \] && echo "c \$CB \$CC \$CP"/, '반증 F5: 묶음 tick 을 한 번이라도 못 읽었으면 c 줄을 내지 않는다');
  assert.deepEqual(P.SECTIONS.slice(-1), ['SELF'], 'SELF 는 마지막 구획(순서 규칙)');
  for (const sec of P.SECTIONS) assert.ok(P.SECTION_GROUP[sec], `${sec} 의 묶음`);
});

test('① 반증 F5 — 낱말 나누기를 하지 않는 셸(zsh 기본과 같은 IFS 빈 값)에서는 ck 가 실패를 표시한다', () => {
  const fn = SCRIPT.SCRIPTS[2].split('\n').find((l) => l.startsWith('ck() {'));
  const ok = spawnSync('bash', ['-c', `${fn}; CK=0; CKBAD=; ck; echo "bad=[$CKBAD] ck=$CK"`], { encoding: 'utf8' }).stdout.trim();
  assert.match(ok, /^bad=\[\] ck=\d+$/, ok);
  const bad = spawnSync('bash', ['-c', `IFS=''; ${fn}; CK=0; CKBAD=; ck; echo "bad=[$CKBAD] ck=$CK"`], { encoding: 'utf8' }).stdout.trim();
  assert.equal(bad, 'bad=[1] ck=0', '칸 수가 모자라면 CKBAD — c 줄을 내지 않는다(0 % 로 보이지 않게)');
});

test('① 실제로 돌린다 — bash · dash 둘 다 ##SELF(s · p · c)를 내고 파서가 읽는다', () => {
  for (const sh of ['bash', 'dash']) {
    if (spawnSync('sh', ['-c', `command -v ${sh}`]).status !== 0) continue; // 없는 환경은 건너뛴다(CI 우분투 · RHEL 에는 둘 다 있다)
    const r = spawnSync('timeout', ['2.5', sh, '-c', SCRIPT.scriptFor(1, 5)], { encoding: 'utf8', maxBuffer: 64 * 2 ** 20 });
    assert.equal(r.stderr, '', `${sh} 오류 출력 없음`);
    const frames = parseAll(r.stdout.split('\n'));
    const f = frames.find((x) => x.self);
    assert.ok(f, `${sh} ##SELF 프레임`);
    assert.equal(typeof f.self.self.ticks, 'number'); assert.equal(typeof f.self.sshd.ticks, 'number');
    assert.deepEqual(Object.keys(f.self.groups), ['base', 'topo', 'proc']);
    assert.ok(f.bytes.base > 0 && f.bytes.topo > 0 && f.bytes.proc > 0 && f.bytes.self > 0, JSON.stringify(f.bytes));
  }
});

/* ── ② 파서 ── */
test('② 파서 — 이 컨테이너 원문 · ##SELF 칸 · 못 읽음은 null · 묶음별 바이트 합 = 받은 글자 + 줄바꿈', () => {
  const lines = fs.readFileSync(FIX, 'utf8').split('\n');
  const frames = parseAll(lines);
  assert.ok(frames.length >= 2);
  const f = frames.find((x) => x.self);
  assert.ok(f && f.self.self && f.self.groups, '원문 픽스처의 ##SELF');
  // 프레임 하나의 바이트 합 = ##T 부터 ##END 까지 줄 길이 + 1
  const i0 = lines.indexOf(lines.find((l) => l.startsWith('##T ')));
  const i1 = lines.indexOf('##END', i0);
  const want = lines.slice(i0, i1 + 1).reduce((a, l) => a + l.length + 1, 0);
  const b = frames[0].bytes;
  assert.equal(b.base + b.topo + b.proc + b.self, want, '첫 프레임 바이트 합');
  const S = P.parseSelf;
  const st = (u, s, cu, cs, rss = 900) => `S 1 1 1 0 -1 4194304 10 20 0 0 ${u} ${s} ${cu} ${cs} 20 0 1 0 100 4096 ${rss} 0 0`;
  assert.deepEqual(S([`s ${st(5, 6, 7, 8)}`, `p ${st(1, 2, 300, 400)}`, 'c 3 4 5']), { self: { ticks: 26, rssPages: 900 }, sshd: { ticks: 3, rssPages: 900 }, groups: { base: 3, topo: 4, proc: 5 } }, '셸은 넷 합 · sshd 는 utime + stime');
  assert.deepEqual(S(['s S 1 2', 'p', 'c 1 2']), { self: null, sshd: null, groups: null }, '칸이 모자라면 null(0 아님)');
  assert.equal(S([`s ${st('x', 6, 7, 8)}`]).self, null, '수가 아니면 null');
  assert.equal(S([`s ${st(-5, 6, 7, 8)}`]).self, null, '음수 표기는 수가 아니다');
  assert.equal(S([`s 1 ${st(5, 6, 7, 8).slice(2)}`]).self, null, '첫 칸은 상태 글자');
  assert.deepEqual(S(['c 1 2 3', 'c 9 9 9']).groups, { base: 1, topo: 2, proc: 3 }, '같은 줄이 둘이면 앞 것');
  assert.equal(S(['c 1 2 3 4']).groups, null);
  assert.equal(S(['s S 1 1 1 0 -1 0 0 0 0 0 5 6 7 8 20 0 1 0 100']).self, null, 'tick 칸은 있어도 메모리 칸(22번째)까지 없으면 null — 줄 모양이 다르다');
});

/* ── ③ 계산 코어 ── */
const snap = (up, self, sshd, g) => ({ up, self: { ticks: self, rssPages: 800 }, sshd: sshd == null ? null : { ticks: sshd, rssPages: 400 }, groups: g });
test('③ loadWindow · judgeLoad · estimateLoad · averageLoads · loadTotals', () => {
  const ctx = { tck: 100, page: 4096, ncpu: 4, bytes: { base: 30_000, topo: 3_000, proc: 60_000, self: 600 }, frames: 15, topoRuns: 1, procRuns: 6 };
  const w = L.loadWindow(snap(100, 1000, 50, { base: 10, topo: 5, proc: 20 }), snap(130, 1060, 53, { base: 40, topo: 10, proc: 45 }), ctx);
  assert.equal(w.windowS, 30);
  assert.equal(w.cpuPct, 2, '60 tick ÷ (30초 × 100) = 2%');
  assert.equal(w.serverPct, 0.5, '코어 4개');
  assert.equal(w.sshdPct, 0.1);
  assert.deepEqual(w.groups.base, { pct: 1, runs: 15, msPerRun: 20 });
  assert.deepEqual(w.groups.topo, { pct: 0.17, runs: 1, msPerRun: 50 });
  assert.deepEqual(w.groups.proc, { pct: 0.83, runs: 6, msPerRun: 41.67 });
  assert.equal(w.bps, Math.round((93_600 / 30) * 100) / 100);
  assert.deepEqual(w.bytesPerRun, { base: 2000, topo: 3000, proc: 10000 });
  assert.equal(w.rssBytes, 800 * 4096); assert.equal(w.sshdRssBytes, 400 * 4096);
  assert.equal(L.loadWindow(snap(100, 1000, 50, {}), snap(103, 1010, 50, {}), ctx), null, '5초 미만 창은 버린다');
  assert.equal(L.loadWindow(snap(100, 1000, 50, {}), snap(800, 1010, 50, {}), ctx), null, '10분 넘는 창은 버린다');
  assert.equal(L.loadWindow(snap(100, 1000, 50, {}), snap(130, 10, 50, {}), ctx), null, 'tick 이 줄면(새 셸) 버린다');
  assert.equal(L.loadWindow(snap(100, 1000, 50, {}), snap(130, 1060, 50, {}), { ...ctx, tck: null }), null, 'tck 를 모르면 버린다(100 으로 짐작하지 않는다)');
  const ns = L.loadWindow(snap(100, 1000, null, null), snap(130, 1060, null, null), ctx);
  assert.equal(ns.sshdPct, null, 'sshd 를 못 읽으면 null(0 아님)');
  assert.equal(ns.groups.base.pct, null); assert.equal(ns.groups.base.msPerRun, null);
  const gb = L.loadWindow(snap(100, 1000, 50, { base: 0, topo: 0, proc: 0 }), snap(130, 1060, 53, { base: 0, topo: 0, proc: 0 }), ctx);
  assert.equal(gb.cpuPct, 2); assert.equal(gb.groups.base.pct, null, '반증 F5 두 번째 문: 셸은 썼는데 묶음 합이 0 이면 묶음은 모름(0 % 아님)');
  assert.equal(L.estimateLoad(gb, { interval: 2, procEvery: 5 }).cpuPct, null);
  const z = L.loadWindow(snap(100, 1000, 50, { base: 1, topo: 1, proc: 1 }), snap(130, 1000, 50, { base: 1, topo: 1, proc: 1 }), { ...ctx, procRuns: 0 });
  assert.equal(z.cpuPct, 0, '변화 없음은 0(잰 값)'); assert.equal(z.groups.proc.msPerRun, null, '횟수 0 이면 1회 비용은 모름');
  // 판정
  assert.equal(L.judgeLoad(0.5), 'light'); assert.equal(L.judgeLoad(1), 'mid'); assert.equal(L.judgeLoad(2.99), 'mid'); assert.equal(L.judgeLoad(3), 'heavy');
  assert.equal(L.judgeLoad(null), null, '값이 없으면 판정 없음(가벼움 아님)');
  assert.equal(L.judgeLoad(2, { loadWarnPct: 2, loadCritPct: 5 }), 'mid');
  // 추정 — 1회 비용(ms) ÷ 주기(초) ÷ 10 = %
  const e = L.estimateLoad(w, { interval: 2, procEvery: 5 });
  assert.deepEqual(e.by, { base: 1, topo: 0.17, proc: 0.83 });
  assert.equal(e.cpuPct, 2);
  assert.equal(e.bps, Math.round(2000 / 2 + 3000 / 30 + 10000 / 5));
  assert.equal(L.estimateLoad(w, { interval: 10, procEvery: 5 }).by.proc, 0.42, '표본 주기보다 주기가 길면 주기마다');
  assert.equal(L.estimateLoad(w, { interval: 2, procEvery: 30 }).by.proc, 0.14);
  assert.equal(L.estimateLoad(ns, { interval: 2, procEvery: 5 }).cpuPct, null, '모르는 묶음이 있으면 합도 모름');
  assert.equal(L.estimateLoad(null, { interval: 2, procEvery: 5 }).cpuPct, null);
  // 평균
  const a = L.averageLoads([w, { ...w, cpuPct: 4, sshdPct: null, interval: 5 }]);
  assert.equal(a.cpuPct, 3); assert.equal(a.sshdPct, 0.1, 'null 은 평균에서 뺀다'); assert.equal(a.interval, 5, '주기는 마지막 값'); assert.equal(a.windows, 2);
  assert.equal(L.averageLoads([]), null);
  // 요약
  const rows = [{ id: 'a', name: 'a', agent: '', load: { cpuPct: 1, bps: 100 } }, { id: 'b', name: 'b', agent: 'edge-x', load: { cpuPct: 3, bps: 300 } }, { id: 'c', name: 'c', agent: '', load: null },
    { id: 'd', name: 'd', agent: '', load: { cpuPct: null, bps: 999 } }]; // 창은 있는데 CPU 를 못 읽음 — 값 있음으로 세지 않는다
  const t = L.loadTotals(rows, [{ kind: 'central', load: { dbWriteBps: 10 } }, { kind: 'edge', load: { txBps: 7 } }], { retentionDays: 30 });
  assert.deepEqual({ ...t, cpuMax: t.cpuMax.name }, { servers: 4, measured: 2, missing: 2, cpuAvg: 2, cpuMax: 'b', bps: 400, centralDirectBps: 100, edgeLocalBps: 300, edgeToCentralBps: 7, dbWriteBps: 10, dbRetentionBytes: 10 * 86_400 * 30 });
});

/* ── ④ 수집기 ── */
const selfLines = (u, s, cu, cs, ps, g) => ['##SELF', `s S 1 1 1 0 -1 0 0 0 0 0 ${u} ${s} ${cu} ${cs} 20 0 1 0 100 4096 777 0 0`, `p S 1 1 1 0 -1 0 0 0 0 0 ${ps} 0 0 0 20 0 1 0 100 4096 333 0 0`, `c ${g.join(' ')}`];
test('④ 수집기 — ##SELF 두 번이면 onLoad 창 · 새 세션은 앞 창과 잇지 않는다 · 프로세스 표본 주기를 바꾸면 새 상수로 다시 연다', async () => {
  const { createCollector } = await import('../src/focusmon/collector.js');
  const hello = ['##HELLO 1', 'uname Linux 3.10.0 x86_64', 'tck 100', 'page 4096', 'ncpu 8', 'hidepid 0', 'dacct - 0', 'host t', '##END'];
  const frame = (up, extra = []) => [`##T ${up}.00 ${1700000000 + up}`, '##STAT', 'cpu  1 2 3 4 5 6 7 8', '##LOAD', '0.1 0.1 0.1 1/100 5', ...extra, '##END'];
  const run1 = [...hello, ...frame(100, selfLines(100, 50, 0, 0, 10, [0, 0, 0])), ...frame(101), ...frame(130, selfLines(130, 70, 20, 10, 13, [40, 30, 20]))];
  // 다시 접속(새 셸) — 앞 세션의 마지막 ##SELF 보다 tick 이 커도 앞 창과 잇지 않는다(창 길이 30초 · tick 증가라 잇는다면 거짓 창이 생긴다)
  const run2 = [...hello, ...frame(160, selfLines(400, 200, 0, 0, 30, [100, 100, 100]))];
  const loads = []; const commands = []; let k = 0; const statuses = [];
  const col = createCollector({ id: 'fm-ld29830', host: '10.9.9.8', port: 22, username: 'dvcmon' }, {
    interval: 1, procEvery: 5, keys: { keyInfo: () => ({ fingerprint: 'fp-ld2983' }), privateKeyForConnect: () => 'PEM' },
    onSample: () => {}, onProcs: () => {}, onStatus: (st) => statuses.push(st), onLoad: (l) => loads.push(l),
    // 첫 세션은 줄을 낸 뒤 끊길 때까지 붙어 있다(수집 중) · 둘째 세션은 줄을 내고 끝난다
    connect: async (_o, fn) => fn({ execStream: async (cmd, { onLine, signal }) => { commands.push(cmd); const first = k++ === 0; for (const l of first ? run1 : run2) onLine(l); if (first) await new Promise((r) => (signal.aborted ? r() : signal.addEventListener('abort', r))); return { code: 0 }; } }),
  });
  col.start();
  const end = Date.now() + 3_000; while (!loads.length && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  col.setProcEvery(30); // 수집 중 — 끊고 새 상수로 다시 연다
  const end2 = Date.now() + 4_000; while (!commands.includes(SCRIPT.scriptFor(1, 30)) && Date.now() < end2) await new Promise((r) => setTimeout(r, 20));
  col.stop();
  assert.equal(loads.length, 1, `창 하나(두 번째 세션의 ##SELF 는 앞 세션과 잇지 않는다): ${loads.length}`);
  const l = loads[0];
  assert.equal(l.windowS, 30);
  assert.equal(l.cpuPct, 2.67, '셸 넷 합 150 → 230 = 80 tick ÷ (30초 × 100) = 2.67%');
  assert.equal(l.sshdPct, 0.1, 'sshd 10 → 13 tick');
  assert.equal(l.groups.base.pct, 1.33); assert.equal(l.groups.topo.pct, 1); assert.equal(l.groups.proc.pct, 0.67);
  assert.equal(l.interval, 1); assert.equal(l.procEvery, 5); assert.equal(l.ncpu, 8);
  assert.equal(l.groups.base.runs, 2, '창 = 앞 ##SELF 프레임 뒤부터 이번 ##SELF 프레임까지(2개)'); assert.equal(l.groups.topo.runs, 0); assert.equal(l.groups.proc.runs, 0);
  assert.equal(l.groups.proc.msPerRun, null, '횟수 0 이면 1회 비용은 모름');
  assert.ok(l.bps > 0);
  assert.equal(commands[0], SCRIPT.scriptFor(1, 5), '처음 명령은 1초 · 5초 상수');
  assert.ok(commands.includes(SCRIPT.scriptFor(1, 30)), '바꾼 뒤 1초 · 30초 상수로 다시 열었다');
  assert.equal(col.procEvery(), 30);
  assert.ok(statuses.every((s) => !('load' in s)), '반증 F8: 부하 창은 상태 객체에 섞지 않는다(onLoad 로만)');
});

test('④ 반증 F10 — 물러나 있는(세션이 끝난) 수집기는 표본 주기를 바꿔도 곧바로 다시 로그인하지 않는다', async () => {
  const { createCollector } = await import('../src/focusmon/collector.js');
  const commands = [];
  const col = createCollector({ id: 'fm-ld29831', host: '10.9.9.7', port: 22, username: 'dvcmon' }, {
    interval: 1, procEvery: 5, keys: { keyInfo: () => ({ fingerprint: 'fp-ld2983b' }), privateKeyForConnect: () => 'PEM' },
    onSample: () => {}, onProcs: () => {}, onStatus: () => {},
    connect: async (_o, fn) => fn({ execStream: async (cmd) => { commands.push(cmd); return { code: 0 }; } }), // 줄 없이 곧바로 끝남 → 물러남(10초)
  });
  col.start();
  const end = Date.now() + 2_000; while (!commands.length && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(col.setProcEvery(15), true);
  await new Promise((r) => setTimeout(r, 400));
  col.stop();
  assert.equal(commands.length, 1, '물러남 대기를 건너뛰지 않는다(다음 접속 때 새 상수)');
  assert.equal(col.procEvery(), 15);
});

/* ── ⑤ 엣지 ── */
const W = { windowS: 30, cpuPct: 2.5, serverPct: 0.3, sshdPct: 0.1, groups: { base: { pct: 1, runs: 15, msPerRun: 20 }, topo: { pct: 0.5, runs: 1, msPerRun: 150 }, proc: { pct: 1, runs: 6, msPerRun: 50 } },
  bps: 3000, bpsBy: { base: 1000, topo: 100, proc: 1900, self: 20 }, bytesPerRun: { base: 2000, topo: 3000, proc: 9500 }, rssBytes: 3e6, sshdRssBytes: 1.5e6, ncpu: 8, interval: 2, procEvery: 5, procs: 300 };
test('⑤ 엣지 정제 — 아는 칸만 · 음수 · 글자 · 소수 횟수 · 모르는 주기 → null · 시각 · 데모 표시는 버린다 · 필수 칸이 없으면 통째로 버린다', () => {
  const c = edge.cleanLoad({ ...W, at: 1, demo: true, via: 'x', evil: { a: 1 }, groups: { ...W.groups, base: { pct: -1, runs: 1.5, msPerRun: 'x' }, extra: {} }, interval: 3, procEvery: 10, bps: 1e20 });
  assert.deepEqual(Object.keys(c).sort(), ['bps', 'bpsBy', 'bytesPerRun', 'cpuPct', 'groups', 'interval', 'ncpu', 'procEvery', 'procs', 'rssBytes', 'serverPct', 'sshdPct', 'sshdRssBytes', 'windowS']);
  assert.deepEqual(c.groups.base, { pct: null, runs: null, msPerRun: null });
  assert.deepEqual(Object.keys(c.groups), ['base', 'topo', 'proc']);
  assert.equal(c.interval, null); assert.equal(c.procEvery, null); assert.equal(c.bps, 1e10, '상한');
  assert.equal(edge.cleanLoad({ ...W, cpuPct: 'x' }), null); assert.equal(edge.cleanLoad({ ...W, windowS: -1 }), null); assert.equal(edge.cleanLoad([W]), null); assert.equal(edge.cleanLoad(null), null);
  assert.equal(edge.cleanLoad({ ...W, serverPct: 500 }).serverPct, 100, '서버 전체 대비는 100% 상한');
  const nd = edge.cleanNodeLoad({ windowS: 30, cpuPct: 5, fmPct: 1, rssBytes: 2e8, elMaxMs: 20, eluPct: 150, rxBps: 1e5, sessions: 3, txBps: 900, host: '10.0.0.1', token: 'x', sessionsList: [1], elP99Ms: 1 });
  assert.deepEqual(Object.keys(nd).sort(), ['cpuPct', 'elMaxMs', 'eluPct', 'fmPct', 'rssBytes', 'rxBps', 'sessions', 'txBps', 'windowS']);
  assert.equal(nd.eluPct, 100, '루프 사용률 상한 100');
  assert.equal(edge.cleanNodeLoad({ evil: 1 }), null); assert.equal(edge.cleanNodeLoad('x'), null);
  assert.equal(edge.cleanNodeLoad({ sessions: 2.5 }), null, '정수 칸에 소수 → null · 남는 수가 없으면 통째로 null');
});

test('⑤ 엣지 동기화 — 맡고 지금 받는 대상의 부하만 · 노드 표본 · 응답 procEvery = 중앙 설정', () => {
  reset();
  const mine = registry.addTarget({ name: 'e1', host: '10.31.0.1', port: 22, username: 'u', agent: 'edge-pl' }, { agents: ['edge-pl'] }).target;
  const idle = registry.addTarget({ name: 'e2', host: '10.31.0.2', port: 22, username: 'u', agent: 'edge-pl' }, { agents: ['edge-pl'] }).target;
  const other = registry.addTarget({ name: 'e3', host: '10.31.0.3', port: 22, username: 'u', agent: 'edge-us' }, { agents: ['edge-us'] }).target;
  assert.equal(store.startSession({ targets: [mine.id, other.id], interval: 2, mode: 'watch', by: 't' }).ok, true);
  registry.saveSettings({ procEvery: 15 });
  store.drainWrites(100_000);
  const r = edge.handleEdgeSync('edge-pl', { sentAt: Date.now(), load: { [mine.id]: W, [idle.id]: W, [other.id]: W, 'fm-nope0000': W }, diag: { node: { cpuPct: 4, sessions: 1, txBps: 800, host: 'x' } } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(store.loadOf(mine.id), '맡고 받는 대상');
  assert.equal(store.loadOf(mine.id).via, 'edge');
  assert.ok(!('at' in W) && store.loadOf(mine.id).at <= Date.now(), '시각은 중앙 수신 시각');
  assert.equal(store.loadOf(idle.id), null, '수집 중이 아닌 대상은 받지 않는다');
  assert.equal(store.loadOf(other.id), null, '다른 엣지가 맡은 대상은 받지 않는다');
  assert.ok(r.accepted.foreign >= 2 && r.accepted.idle >= 1, JSON.stringify(r.accepted));
  const n = store.nodeLoads().find((x) => x.node === 'edge-pl');
  assert.ok(n && n.cpuPct === 4 && n.txBps === 800 && !('host' in n), JSON.stringify(n));
  assert.ok(r.targets.length && r.targets.every((t) => t.procEvery === 15), '응답의 프로세스 표본 주기 = 중앙 설정');
  // 반증 F1: 같은 표본을 다시 받으면(엣지는 동기화마다 싣는다) 기록하지 않는다 · 같은 분은 한 줄 · 맡은 서버 없는 엣지 · 수집기 0 인 엣지는 받지 않는다
  const t0 = (Math.floor(Date.now() / 60_000) + 1) * 60_000 + 5_000; // 다음 분 5초 — 분 경계를 타지 않게 기준 시각을 고정(앞 동기화의 분과도 다르다)
  store.drainWrites(100_000);
  edge.handleEdgeSync('edge-pl', { sentAt: t0, diag: { node: { cpuPct: 4.5, sessions: 1, txBps: 800 } } }, t0);
  edge.handleEdgeSync('edge-pl', { sentAt: t0, diag: { node: { cpuPct: 4.5, sessions: 1, txBps: 800 } } }, t0 + 2_000);
  edge.handleEdgeSync('edge-pl', { sentAt: t0, diag: { node: { cpuPct: 5, sessions: 1, txBps: 800 } } }, t0 + 4_000); // 같은 분의 새 표본 — 대기열의 그 줄을 바꾼다
  const q = store.drainWrites(100_000).filter((x) => x.kind === 'n' && x.target === 'edge-pl');
  assert.equal(q.length, 1, `같은 분은 한 줄: ${q.length}`);
  assert.equal(JSON.parse(q[0].data).cpuPct, 5, '아직 쓰기 전이면 새 값으로');
  edge.handleEdgeSync('edge-pl', { sentAt: t0, diag: { node: { cpuPct: 6, sessions: 1, txBps: 800 } } }, t0 + 6_000);
  assert.equal(store.drainWrites(100_000).filter((x) => x.kind === 'n').length, 0, '이미 쓴 분은 건너뛴다(다음 분에 한 줄)');
  edge.handleEdgeSync('edge-pl', { sentAt: t0, diag: { node: { cpuPct: 7, sessions: 1, txBps: 800 } } }, t0 + 60_000);
  assert.equal(store.drainWrites(100_000).filter((x) => x.kind === 'n').length, 1, '다음 분에는 다시 한 줄');
  edge.handleEdgeSync('edge-pl', { sentAt: t0, diag: { node: { cpuPct: 7, sessions: 1, txBps: 800 } } }, t0 + 125_000); // 그다음 분 · 같은 표본의 재전송
  assert.equal(store.drainWrites(100_000).filter((x) => x.kind === 'n').length, 0, '같은 표본의 재전송은 분이 바뀌어도 기록하지 않는다');
  assert.equal(store.nodeLoads().find((x) => x.node === 'edge-pl').at, t0 + 125_000, '시각만 새로(받고 있다는 표시)');
  edge.handleEdgeSync('edge-us', { sentAt: Date.now(), diag: { node: { cpuPct: 9, sessions: 0, txBps: 1 } } });
  assert.ok(!store.nodeLoads().some((x) => x.node === 'edge-us'), '수집기 0 인 엣지의 표본은 받지 않는다');
  edge.handleEdgeSync('edge-idle', { sentAt: Date.now(), diag: { node: { cpuPct: 9, sessions: 2, txBps: 1 } } });
  assert.ok(!store.nodeLoads().some((x) => x.node === 'edge-idle'), '맡은 서버가 없는 엣지의 표본은 받지 않는다');
  registry.saveSettings({ procEvery: 5 });
});

test('⑤ 워커 — 본문에 load · diag.node(비밀 없음)를 싣고 · 보내면 비우고 · 실패하면 되돌린다', async () => {
  reset();
  const tok = issueAgentToken('edge-pl').token;
  const t = registry.addTarget({ name: 'w1', host: '10.32.0.1', port: 22, username: 'u', agent: 'edge-pl' }, { agents: ['edge-pl'] }).target;
  store.startSession({ targets: [t.id], interval: 2, mode: 'watch', by: 't' });
  const saved = { url: config.agent.centralUrl, tok: config.agent.centralToken, name: config.agent.name };
  config.agent.centralUrl = base; config.agent.centralToken = tok; config.agent.name = 'edge-pl';
  try {
    worker._resetForTest();
    worker.nodeSampleTick(); await new Promise((r) => setTimeout(r, 1100)); // 표본 창(1초 이상)이 생길 만큼 기다린다
    assert.equal(worker.nodeSampleTick(), null, '반증 F2: 수집기가 없으면 재지 않는다(표본기도 만들지 않는다)');
    assert.equal(worker.diagBody().node, undefined);
    const demoId = mock.DEMO_TARGETS[0].id;
    worker._runnerForTest.reconcile([{ id: demoId, host: '10.10.20.11', port: 22, username: 'dvcmon', interval: 2, demo: true }]);
    worker.nodeSampleTick(); await new Promise((r) => setTimeout(r, 1100)); worker.nodeSampleTick();
    const dg = worker.diagBody();
    assert.ok(dg.node && typeof dg.node.cpuPct === 'number' && dg.node.sessions === 1, JSON.stringify(dg.node));
    assert.ok(typeof dg.node.eluPct === 'number' && typeof dg.node.elMaxMs === 'number', '루프 사용률 · 가장 긴 멈춤');
    assert.ok(!/token|password|privateKey|10\.32/i.test(JSON.stringify(dg)), '진단에 비밀 · 주소 없음');
    worker._putLoadForTest(t.id, W);
    const ok = await worker.syncOnce();
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.ok(store.loadOf(t.id), '중앙이 받았다');
    assert.deepEqual(worker._loadsForTest(), {}, '보내면 비운다');
    assert.ok(store.nodeLoads().some((x) => x.node === 'edge-pl'), '노드 표본도 받았다');
    worker._putLoadForTest(t.id, { ...W, cpuPct: 9 });
    config.agent.centralUrl = 'http://127.0.0.1:9';
    const f = await worker.syncOnce();
    assert.equal(f.ok, false);
    assert.equal(worker._loadsForTest()[t.id]?.cpuPct, 9, '실패하면 다음 동기화로 되돌린다');
  } finally {
    worker.stopFocusMonWorker(); worker._resetForTest();
    config.agent.centralUrl = saved.url; config.agent.centralToken = saved.tok; config.agent.name = saved.name;
  }
});

/* ── ⑥ 라우트 ── */
test('⑥ GET /tools/focus-mon/load — 문 · 보이는 대상 · 데모 계정은 엣지 노드 없음 · 오래된 창은 staleS · 추정 · 요약', async () => {
  reset();
  const a = registry.addTarget({ name: 'rt-a', host: '10.33.0.1', port: 22, username: 'u', agent: '' }, { agents: [] }).target;
  const b = registry.addTarget({ name: 'rt-b', host: '10.33.0.2', port: 22, username: 'u', agent: 'edge-pl' }, { agents: ['edge-pl'] }).target;
  store.startSession({ targets: [a.id, b.id], interval: 2, mode: 'record', by: 't' }, Date.now() - 10 * 60_000); // 10분 전 시작 — 시작 때의 보는 화면 표시는 지났다
  store.setLoad(a.id, { ...W, cpuPct: 4 });
  store.setLoad(b.id, W, Date.now() - 5 * 60_000); // 5분 전 — 오래됨
  store.setNodeLoad('', { cpuPct: 7, fmPct: 0.5, dbWriteBps: 100 });
  store.setNodeLoad('edge-pl', { cpuPct: 3, txBps: 50 });
  const gone = registry.addTarget({ name: 'rt-gone', host: '10.33.0.9', port: 22, username: 'u', agent: '' }, { agents: [] }).target;
  store.setLoad(gone.id, W, Date.now() - 86_400_000); // 하루 전에 끝난 수집의 묵은 창 — 세션 없음
  for (const who of ['operator', 'rscoped']) assert.equal((await call('GET', '/api/tools/focus-mon/load', { who })).status, 403, who);
  const r = await call('GET', '/api/tools/focus-mon/load');
  assert.equal(r.status, 200, r.text);
  const ra = r.body.targets.find((x) => x.id === a.id); const rb = r.body.targets.find((x) => x.id === b.id);
  assert.equal(ra.load.cpuPct, 4); assert.equal(ra.judge, 'heavy', '문턱 3% 이상');
  assert.equal(ra.est.byInterval[10].by.base, 0.2, '추정 — 20ms ÷ 10초');
  assert.equal(rb.load, null, '오래된 창은 값을 싣지 않는다'); assert.ok(rb.staleS >= 299, '대신 몇 초 전인지'); assert.equal(rb.judge, null);
  assert.equal(r.body.totals.measured, 1); assert.equal(r.body.totals.missing, 1, '값 없는 대상은 따로 센다');
  assert.ok(!r.body.targets.some((x) => x.id === gone.id), '반증 F4: 끝난 수집의 묵은 창은 최근 구간에 싣지 않는다');
  assert.deepEqual(r.body.cadence, { windowSec: SCRIPT.TOPO_EVERY_S, topoSec: SCRIPT.TOPO_EVERY_S }, '반증 F12: 창 · 구성 주기는 응답 값');
  assert.equal(r.body.totals.centralDirectBps, 3000);
  assert.equal(r.body.nodes.find((x) => x.kind === 'central').load.cpuPct, 7);
  assert.equal(r.body.nodes.find((x) => x.node === 'edge-pl').load.cpuPct, 3);
  assert.deepEqual(r.body.choices.procEvery, [5, 15, 30]);
  // 보는 화면 심박 — 잠깐 보기 서버만(계속 수집은 쉬는 주기를 바꾸지 않게 남기지 않는다)
  const w1 = registry.addTarget({ name: 'rt-w', host: '10.33.0.3', port: 22, username: 'u', agent: '' }, { agents: [] }).target;
  store.startSession({ targets: [w1.id], interval: 2, mode: 'watch', by: 't' }, Date.now() - 10 * 60_000); // 10분 전 시작 · 심박 없음
  store.setLoad(w1.id, W);
  await call('GET', '/api/tools/focus-mon/load');
  const des = store.desiredFor('', (id) => registry.getTarget(id));
  assert.equal(des.find((x) => x.id === a.id).interval, 10, '계속 수집은 이 탭만으로는 쉬는 주기(10초) 그대로');
  assert.ok(store.expireSessions(Date.now()).every((x) => !x.targets.includes(w1.id)), '잠깐 보기는 이 탭의 심박으로 끝나지 않는다');
  const d = await call('GET', '/api/tools/focus-mon/load', { who: 'demo' });
  assert.equal(d.status, 200);
  assert.ok(!d.body.targets.some((x) => x.id === a.id || x.id === b.id), '데모 계정에는 등록부 서버 없음');
  assert.deepEqual(d.body.nodes.map((x) => x.kind), ['central'], '데모 계정에는 엣지 노드 없음');
  assert.ok(!/edge-pl/.test(d.text), '엣지 이름도 없음');
});

test('⑥ 과거 구간 — DB 분당 기록 평균(fm_load · fm_node) · 정리는 minute 인덱스', async () => {
  reset();
  const a = registry.addTarget({ name: 'db-a', host: '10.34.0.1', port: 22, username: 'u', agent: '' }, { agents: [] }).target;
  const now = Date.now();
  const end = now - 3 * 60_000; const m = Math.floor(end / 60_000);
  const w1 = await db.writeBlocks([
    { kind: 'l', target: a.id, minute: m - 2, data: JSON.stringify({ ...W, cpuPct: 1 }) },
    { kind: 'l', target: a.id, minute: m - 1, data: JSON.stringify({ ...W, cpuPct: 3 }) },
    { kind: 'l', target: a.id, minute: m - 200, data: JSON.stringify({ ...W, cpuPct: 99 }) },
    { kind: 'l', target: a.id, minute: m - 1 + 1000, data: '{broken' },
    { kind: 'n', target: '', minute: m - 1, data: JSON.stringify({ cpuPct: 6, dbWriteBps: 20 }) },
  ]);
  assert.equal(w1.ok, true, JSON.stringify(w1));
  const r = await call('GET', `/api/tools/focus-mon/load?win=5&end=${end}`);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.live, false);
  const ra = r.body.targets.find((x) => x.id === a.id);
  assert.equal(ra.load.cpuPct, 2, '구간 안 두 분의 평균(1 · 3) — 200분 전 값은 빠진다');
  assert.equal(ra.mode, null, '반증 F7: 지난 구간에 지금 수집 상태를 섞지 않는다');
  const other = registry.addTarget({ name: 'db-b', host: '10.34.0.2', port: 22, username: 'u', agent: '' }, { agents: [] }).target;
  store.startSession({ targets: [other.id], interval: 2, mode: 'record', by: 't' });
  const r2 = await call('GET', `/api/tools/focus-mon/load?win=5&end=${end}`);
  assert.ok(!r2.body.targets.some((x) => x.id === other.id), '지난 구간에는 그 구간에 기록이 있는 서버만');
  assert.equal(ra.load.windows, 2);
  assert.equal(r.body.nodes.find((x) => x.kind === 'central').load.cpuPct, 6);
  assert.match(db._planForTest('SELECT target, minute, data FROM fm_load WHERE minute >= ? AND minute <= ?'), /idx_fm_load_minute/);
  assert.match(db._planForTest('DELETE FROM fm_node WHERE rowid IN (SELECT rowid FROM fm_node WHERE minute < ? LIMIT ?)'), /idx_fm_node_minute/);
  const n = await db.pruneChunk(m - 100);
  assert.ok(n >= 1, '보관 기간 밖은 지운다');
  assert.equal((await db.readLoads(m - 300, m - 150)).length, 0);
  assert.equal((await db.readLoads(m - 5, m + 2000)).length, 2, '깨진 JSON 줄은 읽을 때 버린다');
});

/* ── ⑦ 설정 ── */
test('⑦ 설정 — procEvery 는 5 · 15 · 30 만 · 문턱 큼 > 보통 · PUT 라우트 · 데모 모형은 같은 계산 함수', async () => {
  reset();
  assert.equal(registry.saveSettings({ procEvery: 10 }).settings.procEvery, 5, '목록 밖은 기본');
  assert.equal(registry.saveSettings({ procEvery: 30 }).settings.procEvery, 30);
  const s = registry.saveSettings({ loadWarnPct: 5, loadCritPct: 2 }).settings;
  assert.equal(s.loadCritPct, 6, '큼 문턱은 보통보다 크게');
  const r = await call('PUT', '/api/tools/focus-mon/settings', { body: { procEvery: 15, loadWarnPct: 1, loadCritPct: 3 } });
  assert.equal(r.status, 200, r.text);
  assert.equal(registry.getSettings().procEvery, 15);
  assert.equal((await call('PUT', '/api/tools/focus-mon/settings', { who: 'demo', body: { procEvery: 30 } })).status, 403, '데모 계정은 바꾸지 못한다');
  registry.saveSettings({ procEvery: 5 });
  // 반증 F2: 이 노드에 수집기가 없으면 노드 표본을 만들지도 · 기록하지도 않는다(수집이 없으면 틱만)
  svc.tick1(); store.drainWrites(100_000);
  assert.equal(svc.localRunner.running().length, 0);
  assert.equal(svc.nodeTick(), null); await new Promise((r) => setTimeout(r, 1100)); assert.equal(svc.nodeTick(), null);
  assert.equal(store.drainWrites(100_000).filter((x) => x.kind === 'n').length, 0);
  // 반증 F13: 접속처가 바뀌면 부하 창도 지운다
  store.setLoad('fm-f13aaaaaaa', W); store.forgetTargetState('fm-f13aaaaaaa');
  assert.equal(store.loadOf('fm-f13aaaaaaa'), null);
  // 반증 F1: 대상 창도 분당 한 줄
  store.drainWrites(100_000);
  const m0 = Math.floor(Date.now() / 60_000) * 60_000 + 10_000; // 기준 시각 고정(분 경계를 타지 않게)
  store.setLoad('fm-q1aaaaaaaa', { ...W, cpuPct: 1 }, m0); store.setLoad('fm-q1aaaaaaaa', { ...W, cpuPct: 2 }, m0 + 30_000);
  const lq = store.drainWrites(100_000).filter((x) => x.kind === 'l');
  assert.equal(lq.length, 1); assert.equal(JSON.parse(lq[0].data).cpuPct, 2);
  const dl = mock.demoLoad(mock.DEMO_TARGETS[0].id, 2, 5, Date.now());
  assert.ok(dl && dl.demo === true && dl.cpuPct > 0 && dl.groups.proc.runs === 6, JSON.stringify(dl?.groups));
  assert.ok(Math.abs(dl.cpuPct - (dl.groups.base.pct + dl.groups.topo.pct + dl.groups.proc.pct)) <= 0.03, '묶음 합 ≈ 수집 CPU(반올림 차이만)');
});
