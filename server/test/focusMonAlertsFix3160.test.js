/**
 * test/focusMonAlertsFix3160.test.js — v3.16.0 ⑯ '알림 · OOM · 자동 조절' **반증 1인 반영**(높음 2 · 중간 11 · 낮음 6 — 재현을 시험으로 고정).
 *
 *  H1 필수 앱 — 상위 20 밖의 서비스도 센다(apps.all) · 죽은 서비스는 0 → 발생
 *  H2 정비 창 — 등록부 법인(DataCenter id) → 그 법인의 vCenter 들로 실제 판정기(maintJudge)에 묻는다 · 한 법인에 vCenter 가 여럿이면 서버 창만
 *  M1 발송 상한에 잘린 것은 다음 주기에 · M2 발생 열쇠에 발생 시각(포탈 억제 창이 재발생을 삼키지 않게) · L6 실패하면 다음 주기에 다시(2번까지)
 *  M3 쓰기 없는 표본(쓰기 지연 null · t.w 0)은 보류가 아니라 조용함 · M8 규칙 파일 손상 뒤 재시작해도 503 · M9 데모 계정 가림
 *  M4 엣지 km 은 대상마다 50초에 한 번 · 사건 대기열 상한(데이터를 밀어내지 않음) · M7 켜진 시각은 중앙이 다시 계산
 *  M5 부팅 식별 boot_id · 커널 오류는 첫 확인(버퍼 전체)과 증분을 섞지 않는다 · M6 OOM 은 가장 최근 20건 + 전체 수 · L2 memcg OOM 줄
 *  M10 설정 주기가 하한 · L1 되돌린 뒤 곧 다시 늘면 24시간 잠금 · M11 그룹 이름 바꾸기 · 지우기 · L3 dash 에서도 rc · L4 빈 이름 미리 보기
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// v3.18.8: 이 파일이 만든 임시 폴더는 시험이 끝나면 지운다(지우지 않아 전량 실행마다 /tmp 에 쌓였다 — tmpCleanup3188 이 고정).
//   exit 에서 한 번 더 지운다 — 모듈의 종료 flush(util/exitFlush.js)가 뒤늦게 다시 만든 폴더(수 MB 실측)까지.
const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) fs.rmSync(d, { recursive: true, force: true }); };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });

const DIR = tmpDir('focusmonalertsfix3160-');
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'mock';
process.env.CENTRAL_TOKEN = 'ctok-alertsfix-3160';
process.env.FOCUSMON_SSH_KEY = '';
process.env.AUTH_SECRET = 'test-secret-alertsfix-3160-xxxxxxxxxxxxxxxxxxxxxxxxx';
delete process.env.CENTRAL_URL;

const AL = await import('../src/focusmon/alerts.js');
const TU = await import('../src/focusmon/tune.js');
const store = await import('../src/focusmon/store.js');
const rates = await import('../src/focusmon/rates.js');
const P = await import('../src/focusmon/parse.js');
const SCRIPT = await import('../src/focusmon/script.js');
const edge = await import('../src/central/focusMonEdge.js');
const { maintStateForTarget } = await import('../src/focusmon/maintMatch.js');
const MJ = await import('../src/bmusage/maint/judge.js');

const base = { name: 'CPU 높음', metric: 'cpu', threshold: 50, durMin: 1, severity: 'crit', scope: { kind: 'record' } };
const fill = (id, now, row, from = now - 100_000) => { for (let t = from; t <= now - 1000; t += 2000) store.ingestSample(id, t, row, null, t); };

test('H1 필수 앱 — 서비스마다 프로세스 수(all) · 상위 20 밖 · 죽으면 0 → 발생', () => {
  // 서비스 22개 + 필수 앱(CPU 가 가장 낮음) — 상위 20 에 들지 않는다
  const units = new Map(); const cur = []; const rows = [];
  for (let i = 0; i < 22; i++) { const pid = 100 + i; units.set(pid, `s${i}.service`); cur.push({ pid, ppid: 1, comm: `s${i}`, thr: 1, rss: 10 }); rows.push({ p: { pid }, cpu: 10 + i }); }
  units.set(999, 'pay-core.service'); cur.push({ pid: 999, ppid: 1, comm: 'pay', thr: 1, rss: 1 }); rows.push({ p: { pid: 999 }, cpu: 0 });
  const g = rates.appGroups(cur, rows, { tck: 100, dt: 5, units, withAll: true });
  assert.equal(g.sv.length, 20); assert.ok(!g.sv.some((x) => x.k === 'pay-core.service'), '상위 20 밖');
  assert.equal(g.all['pay-core.service'], 1, 'all 에는 있다'); assert.equal(g.all['s0.service'], 1);
  assert.equal(rates.appGroups(cur, rows, { tck: 100, dt: 5, units }).all, undefined, 'withAll 아니면 싣지 않는다(메모리)');
  assert.equal(rates.appGroups(cur, rows, { tck: 100, dt: 5, units: new Map(), withAll: true }).all, undefined, '서비스 지도 없음 — 모름');
  const now = Date.now(); const rule = { metric: 'app', app: 'pay-core.service', durMin: 1, op: 'lt', threshold: 1 };
  const mk = (alive) => { const list = []; for (let t = now - 120_000; t <= now - 1000; t += 5000) { const withAll = (t - (now - 120_000)) % 20_000 === 0; list.push({ t, apps: { sv: g.sv, cm: [], ...(withAll ? { all: alive ? { 'pay-core.service': 1 } : { 's0.service': 1 } } : {}) } }); } return { memProcs: () => new Map([[1, list]]) }; };
  const dead = AL.pointsFor(mk(false), rule, 'x', now);
  assert.ok(dead.length >= 5 && dead.every((p) => p[1] === 0), 'all 이 있는 표본만 · 없는 이름 = 0');
  assert.equal(AL.judge(dead, rule, null, now, { holdAfterMs: 60_000 }).event, 'fire', '죽은 서비스 — 발생(예전: 판정 보류)');
  assert.ok(AL.pointsFor(mk(true), rule, 'x', now).every((p) => p[1] === 1));
  // 엣지 정제 — all 은 서비스 이름 · 정수만 · 상한
  const c = edge.cleanProcs({ n: 1, top: [], apps: { sv: [], cm: [], all: { 'a.service': 2, 'b c': 1, 'x.service': -1, 'y.service': 1.5, 'z.scope': 3 } } });
  assert.deepEqual({ ...c.apps.all }, { 'a.service': 2, 'z.scope': 3 });
  // DB 에는 all 을 남기지 않는다(마지막 표본의 apps 도 sv · cm 만)
  const src = fs.readFileSync(new URL('../src/focusmon/store.js', import.meta.url), 'utf8');
  assert.match(src, /s\.apps\.all \? \{ \.\.\.s, apps: \{ sv: s\.apps\.sv, cm: s\.apps\.cm \} \}/);
});

test('H2 정비 창 — 법인(DataCenter) → vCenter 들 · 실제 판정 코어 · vCenter 가 여럿이면 서버 창만', () => {
  const now = Date.now();
  const occ = { kind: 'once', start: new Date(now - 3_600_000).toISOString().slice(0, 16), end: new Date(now + 3_600_000).toISOString().slice(0, 16) };
  const win = (id, vc, target) => ({ id, name: id, vcenterId: vc, tz: 'UTC', schedule: occ, scopes: { alerts: true }, target, at: now });
  const judgeOf = (ws) => ({ windows: ws, stateFor: (t, at) => MJ.maintStateFor(ws, t, at, { tagsOf: () => [] }) });
  const t = { id: 'fm-aaaaaaaa11', host: '10.0.0.1' };
  // 서버 창(주소를 적음) — 법인 kr 의 vCenter vc-kr-01
  const J1 = judgeOf([win('w1', 'vc-kr-01', { kind: 'server', keys: ['10.0.0.1'] })]);
  assert.equal(J1.stateFor({ vcenterId: 'vc-kr-01', key: '10.0.0.1' }, now).scopes.alerts, true, '판정 코어가 창을 본다(시험 전제)');
  assert.equal(maintStateForTarget(J1, t, 'kr', { 'vc-kr-01': 'kr' }, now)?.scopes.alerts, true, '법인 → vCenter 로 풀어 억제');
  assert.equal(maintStateForTarget(J1, t, 'kr', { 'vc-kr-01': 'us' }, now), null, '다른 법인의 vCenter 는 아니다');
  assert.equal(maintStateForTarget(J1, t, null, { 'vc-kr-01': 'kr' }, now), null, '법인을 모르면 억제하지 않는다');
  assert.equal(maintStateForTarget(J1, { ...t, host: '10.0.0.9' }, 'kr', { 'vc-kr-01': 'kr' }, now), null, '다른 주소');
  // 법인 창 — vCenter 하나면 억제 · 둘이면(법인 1 : 서비스 N) 어느 서비스 서버인지 몰라 억제하지 않는다
  const J2 = judgeOf([win('w2', 'vc-kr-01', { kind: 'corp' })]);
  assert.equal(maintStateForTarget(J2, t, 'kr', { 'vc-kr-01': 'kr' }, now)?.scopes.alerts, true);
  assert.equal(maintStateForTarget(J2, t, 'kr', { 'vc-kr-01': 'kr', 'vc-kr-02': 'kr' }, now), null, '서비스가 여럿 — 법인 창은 억제하지 않음');
  assert.equal(maintStateForTarget(J1, t, 'kr', { 'vc-kr-01': 'kr', 'vc-kr-02': 'kr' }, now)?.scopes.alerts, true, '서버 창은 여럿이어도 억제');
  // 서비스가 판정기를 법인으로 묻는다(예전 t.corp 그대로 넘기던 코드가 돌아오지 않게)
  const src = fs.readFileSync(new URL('../src/focusmon/service.js', import.meta.url), 'utf8');
  assert.ok(!/vcenterId: t\.corp/.test(src)); assert.match(src, /maintStateForTarget\(J, t, cr\?\.of\(t\)\?\.id \|\| null, assign, now\)/);
});

test('M1 · M2 · L6 — 잘린 것은 다음 주기 · 발생 열쇠에 시각 · 실패하면 다시(2번까지)', async () => {
  AL._resetForTest(); store._resetForTest(); AL.saveState({});
  const c = AL.writeRule('create', base); assert.ok(c.ok);
  const now = Date.now();
  const ids = Array.from({ length: 25 }, (_, i) => `fm-${String(i).padStart(8, '0')}aa`);
  for (const id of ids) fill(id, now, { cpu: { pct: 90, usr: 90, sys: 0, iow: 0, stl: 0 } });
  store.drainWrites(1e6);
  const targets = ids.map((id, i) => ({ id, name: `S${i}`, host: `10.0.0.${i + 1}` }));
  const sent = []; const send = async (x) => { sent.push(x); return 'delivered'; };
  const r1 = await AL.alertCycle({ store, targets, recordIds: new Set(ids), send, now });
  assert.equal(r1.sent, AL.MAX_SEND); assert.equal(r1.cut, 5);
  const r2 = await AL.alertCycle({ store, targets, recordIds: new Set(ids), send, now: now + 1000 });
  assert.equal(r2.sent, 5, '잘린 5대는 다음 주기에(예전: 0 — 영영 사라짐)'); assert.equal(new Set(sent.map((x) => x.key)).size, 25);
  assert.ok(sent.every((x) => /:fire:\d+$/.test(x.key)), '발생 열쇠에 발생 시각');
  // 실패 — 두 번까지 다시
  AL.saveState({}); sent.length = 0; store.drainWrites(1e6);
  let calls = 0; const bad = async () => { calls += 1; return 'failed'; };
  const one = new Set([ids[0]]);
  for (let k = 0; k < 5; k++) await AL.alertCycle({ store, targets, recordIds: one, send: bad, now: now + 2000 + k });
  assert.equal(calls, 1 + AL.SEND_RETRY, '처음 + 다시 2번 — 그 뒤로는 매분 쌓지 않는다');
  const ev = store.drainWrites(1e5).filter((x) => x.kind === 'e' && x.ekind === 'alert' && x.target === ids[0] && /발생/.test(x.text));
  assert.equal(ev.length, 1, '다시 보낼 때 사건은 또 적지 않는다');
  AL.writeRule('delete', { id: c.rule.id });
});

test('판정 주기는 겹쳐 돌지 않는다(발송이 오래 걸리면 다음 주기는 건너뜀)', async () => {
  AL._resetForTest(); store._resetForTest(); AL.saveState({});
  const c = AL.writeRule('create', base);
  const now = Date.now(); const id = 'fm-busy00001';
  fill(id, now, { cpu: { pct: 90, usr: 90, sys: 0, iow: 0, stl: 0 } }); store.drainWrites(1e6);
  let release; const gate = new Promise((r) => { release = r; });
  const p1 = AL.alertCycle({ store, targets: [{ id, name: 'B', host: '10.0.0.1' }], recordIds: new Set([id]), send: async () => { await gate; return 'delivered'; }, now });
  const r2 = await AL.alertCycle({ store, targets: [{ id, name: 'B', host: '10.0.0.1' }], recordIds: new Set([id]), send: async () => 'delivered', now: now + 1 });
  assert.equal(r2.skipped, 'busy');
  release(); assert.equal((await p1).sent, 1);
  AL.writeRule('delete', { id: c.rule.id });
});

test('M3 쓰기 지연 — 쓰기 없는 표본은 조용함(보류 아님) · 발생 뒤 쉬면 해제', () => {
  const rule = { op: 'ge', threshold: 50, durMin: 1 };
  const now = 10_000_000;
  const quiet = []; for (let t = now - 80_000; t <= now - 1000; t += 5000) quiet.push([t, null, true]);
  const j = AL.judge(quiet, rule, { state: 'firing', since: now - 600_000, firedAt: now - 600_000 }, now);
  assert.equal(j.event, 'resolve', '쉬는 디스크 — 해제(예전: 해제 안 됨)'); assert.equal(j.idle, true);
  assert.equal(AL.judge([[now - 1000, null, true]], rule, { state: 'ok' }, now).state, 'ok', '마지막 표본이 조용함 — 보류가 아니다');
  assert.equal(AL.judge([[now - 1000, null]], rule, { state: 'ok' }, now).state, 'hold', '정말 못 읽음은 보류');
  // pointsFor — s.wa null 이고 t.w 가 0 이면 조용함 · t.w 를 모르면 못 읽음
  store._resetForTest();
  const id = 'fm-wwwwwwww01';
  const C = Object.fromEntries(rates.IOSTAT_COLS.map((c, i) => [c, i]));
  const v13 = (w) => rates.IOSTAT_COLS.map((c) => (c === 'w' ? w : c === 'wAwait' || c === 'await' ? null : 0));
  const dk = (w) => ({ dsk: [{ n: 'sda', k: 'disk', v: v13(w) }], dtot: v13(w) });
  assert.equal(C.wAwait > 0, true);
  const t0 = Date.now();
  store.ingestSample(id, t0 - 3000, dk(0), null, t0 - 3000);
  const pts = AL.pointsFor(store, { metric: 'wa', durMin: 1 }, id, t0);
  assert.deepEqual(pts.map((p) => [p[1], p[2] === true]), [[null, true]], `쓰기 0건 — 조용함 ${JSON.stringify(pts)}`);
});

test('M4 · M7 엣지 km — 대상마다 50초에 한 번 · 켜진 시각은 중앙이 · 사건 대기열 상한', () => {
  store._resetForTest(); edge._resetKmGateForTest?.();
  const src = fs.readFileSync(new URL('../src/central/focusMonEdge.js', import.meta.url), 'utf8');
  assert.match(src, /if \(!gateKm\(x\.id, ts, s\)\)/, '동기화 표본마다 km 을 거른다');
  assert.equal(edge.KM_MIN_GAP_MS, 50_000);
  // 대상마다 50초에 한 번(첫 확인 f 는 5초) · 켜진 시각 = 옮긴 표본 시각 − 가동 시간(엣지 boot 는 버린다)
  const T0 = 2_000_000_000_000;
  const km = (o = {}) => ({ up: 1000, km: { rc: 0, boot: 1, oom: [], en: 0, ...o } });
  const s1 = km(); assert.equal(edge.gateKm('fm-g', T0, s1), true); assert.equal(s1.km.boot, Math.round(T0 / 1000 - 1000), '엣지 boot(1) 대신 중앙 계산');
  const s2 = km(); assert.equal(edge.gateKm('fm-g', T0 + 10_000, s2), false); assert.equal(s2.km, undefined, '10초 뒤 km 은 버린다');
  assert.equal(edge.gateKm('fm-g', T0 + 16_000, km({ f: true })), true, '첫 확인은 5초 간격이면 받는다');
  assert.equal(edge.gateKm('fm-g', T0 + 17_000, km()), false);
  assert.equal(edge.gateKm('fm-g', T0 + 70_000, km()), true);
  assert.equal(edge.gateKm('fm-h', T0, { km: { rc: 0 } }), false, '가동 시간을 모르면 받지 않는다');
  // 사건 상한 — 넘치면 새 사건을 버리고, 데이터 줄은 남는다
  for (let i = 0; i < store.MAX_Q_EVENTS + 50; i++) store.queueEvent('fm-x', 'oom', `OOM — p${i} 종료`, Date.now(), { id: `oom:t:${i}` });
  const ws = store.drainWrites(1e6);
  assert.equal(ws.filter((x) => x.kind === 'e').length, store.MAX_Q_EVENTS);
  assert.ok(store.queueEvent('fm-x', 'oom', 'x', Date.now()), '비우면 다시 받는다');
  // 분당 OOM 사건 상한(대상마다)
  store._resetForTest();
  const at = Date.now(); const boot = Math.round(at / 1000) - 5000;
  for (let k = 0; k < 5; k++) store.ingestKmsg('fm-y', { rc: 0, boot, bid: '11111111-2222-3333-4444-555555555555', oom: Array.from({ length: 20 }, (_, i) => ({ s: `${k * 100 + i}.000000`, c: 'p' })), en: 0 }, at);
  assert.equal(store.drainWrites(1e5).filter((x) => x.ekind === 'oom').length, store.KM_OOM_PER_MIN);
});

test('M5 · M6 · L2 커널 메시지 — boot_id 열쇠 · 첫 확인과 증분 · 가장 최근 20건 · memcg 줄', () => {
  const sc = SCRIPT.scriptFor(2);
  assert.match(sc, /echo "b \$\(tr -cd '0-9a-f-' <\/proc\/sys\/kernel\/random\/boot_id 2>\/dev\/null \| cut -c1-36\)"/, '부팅 식별 — 상수 명령');
  const awk = sc.match(/\| (awk -v L="\$KL" '[^\n]*?\}')/)[1];
  const run = (kl, lines) => spawnSync('bash', ['-c', `KL=${kl}; printf '%s\\n' "$@" | ${awk}`, 'x', ...lines], { encoding: 'utf8' }).stdout;
  const pad = (v) => v.toFixed(6).padStart(12, ' ');
  const A = []; for (let i = 1; i <= 25; i++) A.push(`kern  :err   : [${pad(100 + i)}] Killed process ${1000 + i} (p${i}) total-vm:1kB`);
  const out = run(-1, A).split('\n');
  const os_ = out.filter((l) => l.startsWith('o '));
  assert.equal(os_.length, 20); assert.equal(os_[0], 'o 106.000000 p6'); assert.equal(os_[19], 'o 125.000000 p25', '가장 최근 20건(예전: 가장 오래된 20건 — p21~p25 를 잃었다)');
  assert.ok(out.includes('on 25')); assert.ok(out.includes('f'), '첫 확인 표지');
  assert.ok(!run('110.000000', A).split('\n').includes('f'), '증분이면 f 없음');
  const memcg = run(-1, ['kern  :err   : [  500.100000] Memory cgroup out of memory: Kill process 4321 (java) score 1000 or sacrifice child',
    'kern  :err   : [  500.100100] Killed process 4321 (java) total-vm:100kB',
    'kern  :err   : [  500.100200] Kill process 4322 (java) sharing same memory']); // RHEL 7(3.10) — 같은 메모리를 쓰는 프로세스도 죽인다는 줄(err)
  assert.match(memcg, /^e 0 0$/m, 'memcg OOM 줄은 커널 오류가 아니다'); assert.match(memcg, /^o 500\.100100 java$/m);
  const k = P.parseKmsg(['o 1.5 a', 'on 25', 'f', 'b 11111111-2222-3333-4444-555555555555', 'b ../../x', 'rc 0', 'e 3 9.5']);
  assert.equal(k.on, 25); assert.equal(k.f, true); assert.equal(k.bid, '11111111-2222-3333-4444-555555555555'); assert.equal(k.rc, 0);
  // 열쇠 — 같은 boot_id 면 켜진 시각이 흔들려도 같은 사건
  store._resetForTest();
  const at = Date.now(); const bid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'; const b0 = Math.round(at / 1000) - 3000;
  for (const b of [b0, b0 + 4, b0 + 5, b0 - 6]) store.ingestKmsg('fm-k', { rc: 0, boot: b, bid, oom: [{ s: '100.600000', c: 'java' }], en: 0, f: true }, at);
  assert.equal(new Set(store.drainWrites(1e4).filter((x) => x.ekind === 'oom').map((x) => x.id)).size, 1, 'boot_id 열쇠 — 반올림 경계와 무관');
  // 커널 오류 — 처음 보는 첫 확인은 기준만 · 증분은 센다 · 다시 연결한 첫 확인은 늘어난 만큼만(버퍼 전체를 다시 더하지 않는다)
  const kerrs = () => store.drainWrites(1e4).filter((x) => x.ekind === 'kerr').map((x) => Number(/(\d+)줄/.exec(x.text)[1]));
  store.ingestKmsg('fm-k3', { rc: 0, boot: b0, bid, oom: [], en: 500, es: '50.000000', f: true }, at);
  assert.deepEqual(kerrs(), [], '수집 전 오류는 새로 생긴 것이 아니다');
  store.ingestKmsg('fm-k3', { rc: 0, boot: b0, bid, oom: [], en: 1, es: '2900.000000' }, at);
  assert.deepEqual(kerrs(), [1]);
  store.ingestKmsg('fm-k3', { rc: 0, boot: b0 + 3, bid, oom: [], en: 503, es: '2950.000000', f: true }, at);
  assert.deepEqual(kerrs(), [2], '다시 연결 — 501 → 503, 사이에 난 2줄만(예전: 501줄을 다시 더해 합이 두 배)');
  store.ingestKmsg('fm-k3', { rc: 0, boot: b0 + 2000, bid: 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee', oom: [], en: 7, es: '30.000000', f: true }, at);
  assert.deepEqual(kerrs(), [7], '재부팅을 지켜봄 — 새 부팅의 버퍼 전체');
  // 증분이 20건을 넘었으면 '그 밖 N건'
  store.ingestKmsg('fm-k2', { rc: 0, boot: b0, bid, oom: [{ s: '10.000000', c: 'a' }], on: 30, en: 0 }, at);
  assert.ok(store.drainWrites(1e4).some((x) => x.ekind === 'oom' && /그 밖 29건/.test(x.text)));
  // M7 — 엣지 정제는 boot_id · f · on 을 통과시키고(형식 검사), 켜진 시각은 중앙 계산
  const c = edge.cleanSample({ dt: 2, up: 100, km: { rc: 0, boot: 1, bid: 'x', f: true, on: 25, oom: [] } }).km;
  assert.equal(c.bid, null); assert.equal(c.f, true); assert.equal(c.on, 25);
});

test('L3 dash 로그인 셸에서도 rc · 부팅 식별', () => {
  const sh = spawnSync('sh', ['-c', 'command -v dash'], { encoding: 'utf8' }).stdout.trim();
  if (!sh) return; // dash 가 없는 환경
  const r = spawnSync('timeout', ['4', 'dash', '-c', SCRIPT.scriptFor(1)], { encoding: 'utf8' });
  assert.ok(!/Bad substitution/.test(r.stderr || ''), r.stderr);
  const out = r.stdout || ''; const i = out.indexOf('##KMSG');
  assert.ok(i >= 0);
  const sec = out.slice(i + 7, out.indexOf('\n##', i + 3)).split('\n');
  const k = P.parseKmsg(sec);
  assert.ok(k.rc != null, `rc 를 읽는다 ${JSON.stringify(sec)}`);
});

test('M10 · L1 자동 조절 — 설정 주기가 하한 · 되돌린 뒤 곧 다시 늘면 24시간 잠금', () => {
  TU._resetForTest();
  const t0 = 1_000_000_000;
  let st = { pe: 5, over: 0, lowSince: null, changedAt: 0, lastAt: 0 };
  const r = TU.decide(st, { cpuPct: 0.6, at: t0 }, { base: 15, warnPct: 1 }, t0);
  assert.equal(r.next.pe, 15, '설정을 15초로 올리면 조절 값(5초)보다 성긴 설정을 따른다');
  // procEveryFor 도 하한
  TU.tuneTick({ targets: [{ id: 'fm-t1' }], loadOf: () => ({ cpuPct: 5, at: t0 }), settings: { autoTune: 1, procEvery: 5, loadWarnPct: 1 }, now: t0 });
  TU.tuneTick({ targets: [{ id: 'fm-t1' }], loadOf: () => ({ cpuPct: 5, at: t0 + 30_000 }), settings: { autoTune: 1, procEvery: 5, loadWarnPct: 1 }, now: t0 + 30_000 });
  assert.equal(TU.procEveryFor('fm-t1', 5), 15); assert.equal(TU.procEveryFor('fm-t1', 30), 30, '설정이 더 성기면 설정');
  // 진동 — 15 → 5 로 되돌린 뒤 6시간 안에 다시 15 → 24시간은 되돌리지 않는다
  st = { pe: 15, over: 0, lowSince: t0, changedAt: t0, lastAt: 0 };
  const step = (pct, t) => { const x = TU.decide(st, { cpuPct: pct, at: t }, { base: 5, warnPct: 1 }, t); st = x.next; return x.change; };
  assert.equal(step(0.2, t0 + 61 * 60_000)?.to, 5, '1시간 낮음 — 되돌림');
  const t1 = t0 + 75 * 60_000; // 되돌린 뒤 10분(늘림 유지) 지나서
  step(1.2, t1); const up = step(1.2, t1 + 30_000);
  assert.equal(up?.to, 15); assert.match(up.why, /24시간 되돌리지 않음/);
  assert.equal(step(0.2, t1 + 31 * 60_000), null);
  assert.equal(step(0.2, t1 + 3 * 3_600_000), null, '잠금 — 낮아도 되돌리지 않음');
  assert.equal(step(0.2, t1 + 25 * 3_600_000)?.to, 5, '24시간 뒤에는 되돌린다');
});

test('M8 · M9 · M11 · L4 라우트 — 손상 뒤 재시작도 503 · 데모 가림 · 그룹 이름 · 빈 이름 미리 보기', async () => {
  AL._resetForTest();
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const svc = await import('../src/focusmon/service.js');
  const registry = await import('../src/focusmon/registry.js');
  const mock = await import('../src/focusmon/mock.js');
  const users = { admin: { username: 'a', role: 'admin', scope: null }, demo: { username: 'thedvcdemp', role: 'admin', scope: null, demoGuest: true } };
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.user = users[req.headers['x-test-user'] || 'admin']; next(); });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const b0 = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, p, { who = 'admin', body } = {}) => { const r = await fetch(b0 + p, { method, headers: { 'Content-Type': 'application/json', 'x-test-user': who }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
  try {
    // M11 — 그룹 대상 규칙
    assert.ok(registry.createGroup('DB').ok);
    const g = await call('POST', '/api/tools/focus-mon/alerts/rules', { body: { ...base, name: '김철수 담당 결제 DB', metric: 'app', app: 'pay-core-prod.service', threshold: 1, scope: { kind: 'group', group: 'DB' } } });
    assert.equal(g.status, 200);
    const rn = await call('PUT', '/api/tools/focus-mon/groups/DB', { body: { name: 'DB-PROD' } });
    assert.equal(rn.status, 200); assert.equal(rn.body.rules, 1);
    assert.equal(AL.loadRules().find((r) => r.id === g.body.rule.id).scope.group, 'DB-PROD', '규칙도 새 이름으로');
    const del = await call('DELETE', '/api/tools/focus-mon/groups/DB-PROD');
    assert.equal(del.status, 409); assert.equal(del.body.code, 'group-in-rules');
    // M9 — 데모 계정은 규칙 이름 · 그룹 이름 · 서비스 이름을 보지 않는다
    const dv = await call('GET', '/api/tools/focus-mon/alerts', { who: 'demo' });
    assert.equal(dv.status, 200);
    const txt = JSON.stringify(dv.body.rules);
    for (const s of ['김철수', 'DB-PROD', 'pay-core-prod']) assert.ok(!txt.includes(s), `${s} 가림`);
    assert.ok(JSON.stringify((await call('GET', '/api/tools/focus-mon/alerts')).body.rules).includes('김철수'), '관리자는 원문');
    // L4 — 이름을 비운 폼으로 미리 보기
    const pv = await call('POST', '/api/tools/focus-mon/alerts/preview', { body: { target: mock.DEMO_TARGETS[0].id, rule: { name: '', metric: 'cpu', threshold: 30, durMin: 5, severity: 'warn' } } });
    assert.equal(pv.status, 200, JSON.stringify(pv.body));
    // M8 — 손상 → 조회도 503 · 재시작(캐시 비움)해도 손상 보존본만 있으면 503(쓰기가 열리지 않는다)
    fs.writeFileSync(path.join(DIR, AL.RULES_FILE), '{ broken'); AL._resetForTest();
    assert.equal((await call('GET', '/api/tools/focus-mon/alerts')).status, 503);
    AL._resetForTest(); // 재시작
    assert.ok(!fs.existsSync(path.join(DIR, AL.RULES_FILE)), '손상본은 옆으로 옮겨졌다');
    assert.equal((await call('GET', '/api/tools/focus-mon/alerts')).status, 503, '재시작 뒤에도 503');
    assert.equal((await call('POST', '/api/tools/focus-mon/alerts/rules', { body: base })).status, 503, '재시작 뒤에도 쓰기 거절');
    assert.equal((await AL.alertCycle({ store, now: Date.now() })).skipped, 'rules-unreadable');
    for (const f of fs.readdirSync(DIR)) if (f.startsWith(AL.RULES_FILE)) fs.rmSync(path.join(DIR, f));
    AL._resetForTest();
  } finally { svc.stopFocusMon(); srv.close(); }
});
