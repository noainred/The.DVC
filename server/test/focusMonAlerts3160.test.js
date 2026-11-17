/**
 * test/focusMonAlerts3160.test.js — v3.16.0 서버 집중 모니터링 ‘알림 · OOM · 자동 조절’(시안 ⑯ Alerts · 사용자 "기본값대로 모두 구현해줘").
 * 컨펌 기본값: ① 계속 수집만 ② 기존 알람 · 메일 채널 ③ 관리자 · 전체 쓰기 범위 · 감사 · 정비 창 억제 ④ 판정 보류(엣지 끊김) ⑤ OOM 60초 · 권한 없음 표시 ⑥ 자동 조절 기본 꺼짐 · 문턱 1% · 3%.
 *
 *  ① 규칙 정제 · 저장(원자 쓰기 · 손상이면 쓰기 거절 · 조건이 바뀌면 상태를 지운다)
 *  ② 판정 코어 — 지속 내내 넘어야 발생 · 구간을 덮어야 · 못 읽으면 보류(해제 아님) · 해제는 여유 5% · 보류에서 돌아오면 이어서
 *  ③ 미리 보기(1분 요약)
 *  ④ 판정 주기 — 계속 수집만 · 정비 창 억제 · 목 모드는 보내지 않음 · 보류는 기록만 · 사건 남김
 *  ⑤ 커널 메시지 — 원격 awk(이 컨테이너 bash · 실제 dmesg) · 파서 · 한 번만 싣기 · 사건 열쇠 · 엣지 정제
 *  ⑥ 자동 조절 — 두 창 이어서 넘으면 한 단계 · 10분 유지 · 1시간 낮으면 되돌림 · 끄면 지움
 *  ⑦ 라우트 — 조회 문 · 쓰기 문(관리자 · 쓰기 범위 · 데모) · 503 · 감사 · 보이는 서버만
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

const DIR = tmpDir('focusmonalerts3160-');
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'mock';
process.env.CENTRAL_TOKEN = 'ctok-alerts-3160';
process.env.FOCUSMON_SSH_KEY = '';
process.env.AUTH_SECRET = 'test-secret-alerts-3160-xxxxxxxxxxxxxxxxxxxxxxxxxxxx';
delete process.env.CENTRAL_URL;

const AL = await import('../src/focusmon/alerts.js');
const TU = await import('../src/focusmon/tune.js');
const store = await import('../src/focusmon/store.js');
const db = await import('../src/focusmon/db.js');
const P = await import('../src/focusmon/parse.js');
const SCRIPT = await import('../src/focusmon/script.js');
const edge = await import('../src/central/focusMonEdge.js');
const mock = await import('../src/focusmon/mock.js');
after(() => { try { db._resetForTest(); } catch { /* */ } });

const NOW = Math.floor(Date.now() / 60_000) * 60_000 + 30_000;
const base = { name: 'CPU 높음', metric: 'cpu', threshold: 90, durMin: 5, severity: 'crit', scope: { kind: 'record' } };

/* ── ① ── */
test('① 규칙 정제 · 저장 · 손상이면 쓰기 거절 · 조건이 바뀌면 상태를 지운다', () => {
  AL._resetForTest();
  assert.equal(AL.normalizeRule({ ...base, metric: 'evil' }).code, 'bad-metric');
  assert.equal(AL.normalizeRule({ ...base, threshold: 101 }).code, 'bad-threshold');
  assert.equal(AL.normalizeRule({ ...base, durMin: 7 }).code, 'bad-dur');
  assert.equal(AL.normalizeRule({ ...base, severity: 'x' }).code, 'bad-severity');
  assert.equal(AL.normalizeRule({ ...base, scope: { kind: 'group', group: '../x' } }).code, 'bad-scope');
  assert.equal(AL.normalizeRule({ ...base, scope: { kind: 'server', target: 'x' } }).code, 'bad-scope');
  assert.equal(AL.normalizeRule({ ...base, metric: 'app', threshold: 1 }).code, 'bad-app', '필수 앱은 서비스 이름');
  assert.equal(AL.normalizeRule({ ...base, name: 'a\u0000b' }).code, 'bad-name');
  assert.equal(AL.normalizeRule({ ...base, metric: 'app', threshold: 1, app: 'oracle-db.service' }).ok, true);
  const c = AL.writeRule('create', base, { by: 'a' });
  assert.ok(c.ok); assert.match(c.rule.id, /^ar-[0-9a-f]{12}$/);
  assert.equal(AL.loadRules().length, 1);
  // 상태가 있는 규칙의 조건을 바꾸면 상태를 지운다(옛 조건의 발생을 새 조건으로 해제하지 않게)
  AL.saveState({ [`${c.rule.id}|fm-aaaaaaaa01`]: { state: 'firing', since: 1 } });
  assert.ok(AL.writeRule('update', { id: c.rule.id, name: '이름만' }).ok);
  assert.ok(AL.loadState()[`${c.rule.id}|fm-aaaaaaaa01`], '이름만 바꾸면 상태는 그대로');
  assert.ok(AL.writeRule('update', { id: c.rule.id, threshold: 80 }).ok);
  assert.equal(AL.loadState()[`${c.rule.id}|fm-aaaaaaaa01`], undefined, '조건이 바뀌면 지운다');
  assert.equal(AL.writeRule('update', { id: 'ar-000000000000', name: 'x' }).code, 'not-found');
  // 손상 — 보존 · 쓰기 거절(빈 목록으로 덮지 않는다)
  fs.writeFileSync(path.join(DIR, AL.RULES_FILE), '{ broken');
  AL._resetForTest();
  assert.ok(AL.rulesLoadError());
  assert.equal(AL.writeRule('create', base).code, 'rules-unreadable');
  assert.ok(fs.readdirSync(DIR).some((f) => f.startsWith(`${AL.RULES_FILE}.corrupt`)), '손상본 보존');
  assert.ok(!fs.existsSync(path.join(DIR, AL.RULES_FILE)) || fs.readFileSync(path.join(DIR, AL.RULES_FILE), 'utf8').startsWith('{ broken'), '빈 목록으로 덮지 않았다');
  for (const f of fs.readdirSync(DIR)) if (f.startsWith(AL.RULES_FILE)) fs.rmSync(path.join(DIR, f));
  AL._resetForTest();
});

/* ── ② ── */
const series = (from, to, f, step = 2000) => { const o = []; for (let t = from; t <= to; t += step) o.push([t, f(t)]); return o; };
test('② 판정 — 지속 내내 넘어야 발생 · 덮어야 · 못 읽으면 보류(해제 아님) · 해제는 여유 5% · 보류에서 돌아오면 이어서', () => {
  const r = { op: 'ge', threshold: 90, durMin: 5 };
  let j = AL.judge(series(NOW - 6 * 60_000, NOW, () => 95), r, null, NOW);
  assert.equal(j.event, 'fire'); assert.equal(j.state, 'firing');
  assert.equal(AL.judge(series(NOW - 6 * 60_000, NOW, (t) => (t === NOW - 120_000 ? 80 : 95)), r, null, NOW).event, null, '한 번이라도 밑돌면 발생 아님');
  assert.equal(AL.judge(series(NOW - 3 * 60_000, NOW, () => 95), r, null, NOW).event, null, '구간을 덮지 못했다(3분만) — 발생 아님');
  assert.equal(AL.judge([...series(NOW - 6 * 60_000, NOW - 200_000, () => 95), ...series(NOW - 100_000, NOW, () => 95)], r, null, NOW).event, null, '큰 틈(100초) — 발생 아님');
  const firing = { state: 'firing', since: NOW - 60_000, firedAt: NOW - 60_000 };
  j = AL.judge(series(NOW - 600_000, NOW - 120_000, () => 95), r, firing, NOW);
  assert.equal(j.state, 'hold'); assert.equal(j.event, 'hold', '표본이 2분째 없다 — 보류(해제로 알리지 않는다)');
  const held = { state: 'hold', since: NOW - 60_000, was: 'firing', firedAt: NOW - 600_000 };
  j = AL.judge(series(NOW - 6 * 60_000, NOW, () => 88), r, held, NOW);
  assert.equal(j.state, 'firing', '88 은 여유(85.5) 위 — 해제 아님 · 보류 전 발생을 이어 간다');
  j = AL.judge(series(NOW - 6 * 60_000, NOW, () => 80), r, firing, NOW);
  assert.equal(j.event, 'resolve'); assert.equal(j.state, 'ok');
  assert.equal(AL.judge([...series(NOW - 6 * 60_000, NOW - 2000, () => 95), [NOW, null]], r, null, NOW).state, 'hold', '지금 값을 못 읽었다 — 보류');
  // 밑돎(필수 앱)
  const app = { op: 'lt', threshold: 2, durMin: 1 };
  assert.equal(AL.judge(series(NOW - 90_000, NOW, () => 0), app, null, NOW).event, 'fire');
  assert.equal(AL.judge(series(NOW - 90_000, NOW, () => 3), app, { state: 'firing', since: 0 }, NOW).event, 'resolve');
});

/* ── ③ ── */
test('③ 미리 보기 — 1분 요약을 같은 규칙으로 · 요약 없는 분은 이어짐을 끊는다', () => {
  const r = { op: 'ge', threshold: 90, durMin: 3 };
  const m = (vals, t0 = 0) => vals.map((v, i) => [t0 + i * 60_000, v]);
  const p = AL.preview(m([50, 95, 95, 95, 95, 50, 50, 50, 95, 95, null, 95, 95]), r);
  assert.equal(p.count, 1); assert.deepEqual(p.intervals[0], [60_000, 8 * 60_000], '3분 이어진 뒤 발생 · 3분 낮아 해제');
  assert.equal(p.coveredMin, 12);
  // 요약이 빠진 분(행이 없음 — 수집 공백)도 이어짐을 끊는다
  const gap = AL.preview([[0, 95], [60_000, 95], [5 * 60_000, 95], [6 * 60_000, 50]], r);
  assert.equal(gap.count, 0, '두 분 + 공백 + 한 분 — 3분 이어지지 않았다');
});

test('④ 필수 앱 — 상위 20 밖이면 목록이 꽉 찼을 때 모름(null) · 20개 미만이면 0 으로 확정', () => {
  const rule = { metric: 'app', app: 'oracle-db.service', durMin: 1 };
  const now = Date.now();
  const mk = (sv) => ({ memProcs: () => new Map([[1, [{ t: now - 1000, apps: { sv, cm: [] } }]]]) });
  const full = Array.from({ length: 20 }, (_, k) => ({ k: `s${k}.service`, n: 1 }));
  assert.deepEqual(AL.pointsFor(mk(full), rule, 'x', now).map((p) => p[1]), [null], '꽉 찬 목록에 없으면 모름');
  assert.deepEqual(AL.pointsFor(mk(full.slice(0, 5)), rule, 'x', now).map((p) => p[1]), [0], '목록이 덜 찼는데 없으면 0(죽음)');
  assert.deepEqual(AL.pointsFor(mk([{ k: 'oracle-db.service', n: 3 }]), rule, 'x', now).map((p) => p[1]), [3]);
  assert.deepEqual(AL.pointsFor(mk(null), rule, 'x', now).map((p) => p[1]), [null], '서비스 지도 없음 — 모름');
});

/* ── ④ ── */
test('④ 판정 주기 — 계속 수집만 · 정비 창 억제 · 목 모드는 보내지 않음 · 보류는 기록만 · 사건', async () => {
  AL._resetForTest(); store._resetForTest();
  const c = AL.writeRule('create', { ...base, durMin: 1, threshold: 50 });
  assert.ok(c.ok);
  const a = 'fm-aaaaaaaa11'; const b = 'fm-bbbbbbbb22'; const m = 'fm-cccccccc33';
  const now = Date.now();
  for (const id of [a, b, m]) for (let t = now - 100_000; t <= now - 1000; t += 2000) store.ingestSample(id, t, { cpu: { pct: 80, usr: 80, sys: 0, iow: 0, stl: 0 } }, null, t);
  store.drainWrites(100_000);
  const targets = [{ id: a, name: 'A', host: '10.0.0.1', corp: 'C1' }, { id: b, name: 'B', host: '10.0.0.2', corp: 'C1' }, { id: m, name: 'M', host: '10.0.0.3', corp: 'C1' }];
  const sent = [];
  const r = await AL.alertCycle({ store, targets, recordIds: new Set([a, m]), send: async (x) => { sent.push(x); }, maintState: (t) => ({ scopes: { alerts: t.id === m } }), now });
  assert.equal(r.fires, 2, '계속 수집 서버 둘만(b 는 잠깐 보기 — 알림 없음)');
  assert.equal(sent.length, 1, '정비 창(m)은 억제'); assert.equal(r.suppressed, 1);
  assert.match(sent[0].key, new RegExp(`^focusmon:${c.rule.id}:${a}:fire:\\d+$`), '발생 열쇠에 발생 시각(반증 M2)'); assert.equal(sent[0].severity, 'critical');
  const ev = store.drainWrites(1000).filter((x) => x.kind === 'e' && x.ekind === 'alert');
  assert.equal(ev.length, 2, '억제한 것도 사건에는 남긴다');
  // 다음 주기 — 같은 상태면 다시 보내지 않는다
  const r2 = await AL.alertCycle({ store, targets, recordIds: new Set([a, m]), send: async (x) => { sent.push(x); }, now: now + 1000 });
  assert.equal(r2.fires, 0); assert.equal(sent.length, 1);
  // 목 모드 — 보내지 않는다(사건만)
  AL._resetForTest(); AL.saveState({});
  const r3 = await AL.alertCycle({ store, targets, recordIds: new Set([a]), send: async (x) => { sent.push(x); }, mock: true, now });
  assert.equal(r3.fires, 1); assert.equal(sent.length, 1);
  // 보류 — 기록만(보내지 않는다)
  const r4 = await AL.alertCycle({ store, targets, recordIds: new Set([a]), send: async (x) => { sent.push(x); }, now: now + 10 * 60_000 });
  assert.equal(r4.fires, 1); assert.equal(sent.length, 1, '보류는 알림으로 보내지 않는다');
  assert.ok(store.drainWrites(1000).some((x) => x.kind === 'e' && /판정 보류/.test(x.text)));
  // 엣지 노드는 판정하지 않는다
  process.env.CENTRAL_URL = 'https://central.example';
  assert.equal((await AL.alertCycle({ store, targets, recordIds: new Set([a]), now })).skipped, 'edge');
  delete process.env.CENTRAL_URL;
  AL.writeRule('delete', { id: c.rule.id });
});

/* ── ⑤ ── */
test('⑤ 커널 메시지 — 원격 awk(실제 bash) · 파서 · 사건 열쇠 · 엣지 정제 · 원문 없음', () => {
  const sc = SCRIPT.scriptFor(2);
  assert.match(sc, /KO=\$\( \{ timeout -s KILL 3 dmesg -x 2>\/dev\/null; echo "##RC \$\?"; \} \| awk -v L="\$KL"/, 'dmesg 는 시한 KILL · 증분 기준 KL · 종료값은 POSIX(반증 L3 — PIPESTATUS 없음)');
  assert.ok(!/PIPESTATUS/.test(sc), 'bash 전용 문법 없음');
  assert.match(sc, /echo '##KMSG'/);
  assert.ok(!/dmesg[^\n]*\| *(tee|cat)\b/.test(sc));
  const awk = sc.match(/\| (awk -v L="\$KL" '[^\n]*?\}')/)[1];
  const lines = ['kern  :err   : [  100.600000] Killed process 4321 (java) total-vm:1kB', 'kern  :err   : [  100.500000] Out of memory: Kill process 4321 (java)',
    'kern  :err   : [  200.000000] EXT4-fs error secret-path /home/x', 'kern  :err   : [8640000.123456] Killed process 77 (my prog;rm) x'];
  const run = (kl) => spawnSync('bash', ['-c', `KL=${kl}; printf '%s\\n' "$@" | ${awk}`, 'x', ...lines], { encoding: 'utf8' }).stdout;
  const out = run(-1);
  assert.match(out, /^o 100\.600000 java$/m); assert.match(out, /^o 8640000\.123456 my_prog_rm$/m, '이름은 안전한 글자 · 시각은 글자 그대로(지수 표기 없음)');
  assert.match(out, /^e 1 200\.000000$/m, 'OOM 줄은 오류 수에서 뺀다'); assert.match(out, /^last 8640000\.123456$/m);
  assert.ok(!/secret-path/.test(out), '원문은 내보내지 않는다');
  assert.doesNotMatch(run('200.000000'), /java/, '지난 확인 뒤만');
  const k = P.parseKmsg(out.split('\n').concat(['rc 0', 'o 1e9 x', 'o 5 a;b']));
  assert.deepEqual(k.oom.map((o) => o.c), ['java', 'my_prog_rm']); assert.equal(k.rc, 0); assert.equal(k.en, 1);
  // 사건 — 같은 줄을 또 받아도 한 줄(열쇠) · 시각 = 켜진 시각 + 부팅 뒤 초
  store._resetForTest();
  const id = 'fm-dddddddd44'; const at = Date.now(); const boot = Math.floor((Math.round(at / 1000) - 1000) / 10) * 10 + 2; // 옛 열쇠(10초 반올림) 경계에서 떨어뜨림
  store.ingestKmsg(id, { rc: 0, boot, oom: [{ s: '100.600000', c: 'java' }], en: 1, es: '200.000000' }, at);
  store.ingestKmsg(id, { rc: 0, boot: boot + 1, oom: [{ s: '100.600000', c: 'java' }], en: 0 }, at);
  const ev = store.drainWrites(100).filter((x) => x.kind === 'e');
  assert.equal(new Set(ev.filter((x) => x.ekind === 'oom').map((x) => x.id)).size, 1, '다시 연결해 같은 OOM 을 받아도 열쇠가 같다');
  assert.equal(ev.find((x) => x.ekind === 'oom').at, (boot + 100.6) * 1000);
  assert.equal(store.kmsgOf(id).rc, 0);
  // 켜진 시각이 틀려 미래로 가는 사건은 받지 않는다(받은 시각 + 60초 넘게)
  store.ingestKmsg(id, { rc: 0, boot: Math.round(at / 1000) + 3600, oom: [{ s: '1.000000', c: 'x' }] }, at);
  assert.equal(store.drainWrites(100).filter((x) => x.kind === 'e').length, 0, '미래 시각 사건 없음');
  // 엣지 정제 — 아는 칸만 · 원문 칸 없음
  const c = edge.cleanSample({ dt: 2, km: { rc: 0, boot, oom: [{ s: '1.5', c: 'java' }, { s: 'x', c: 'a' }, { s: '2', c: 'a b' }], en: 3, es: '9.5', raw: 'SECRET' } }).km;
  assert.deepEqual(c.oom, [{ s: '1.5', c: 'java' }]); assert.equal(c.raw, undefined); assert.equal(c.en, 3);
  assert.equal(edge.cleanSample({ dt: 2, km: { rc: 999, boot: -5 } }).km.rc, null);
  // 이 컨테이너의 실제 dmesg 로 한 번(읽히면 rc 0 · 막히면 rc 1 — 어느 쪽이든 파서가 rc 를 읽는다)
  const real = spawnSync('bash', ['-c', `KL=-1; KO=$( { timeout -s KILL 3 dmesg -x 2>/dev/null; echo "##RC $?"; } | ${awk} ); printf '%s\\n' "$KO"`], { encoding: 'utf8' }).stdout;
  assert.ok(P.parseKmsg(real.trim().split('\n')).rc != null, real.slice(0, 200));
});

test('⑤ 수집기 — 커널 메시지는 다음 표본에 한 번만 · 데모', async () => {
  const k = mock.demoKmsg(mock.DEMO_TARGETS[0].id, Date.now());
  assert.equal(k.oom[0].c, 'oracle'); assert.equal(mock.demoKmsg(mock.DEMO_TARGETS[1].id, Date.now()).rc, 1, '둘째 데모 — 권한 없음');
  const src = fs.readFileSync(new URL('../src/focusmon/collector.js', import.meta.url), 'utf8');
  assert.match(src, /if \(pendingKm && s\.dt != null\) \{ s\.km = pendingKm; pendingKm = null; \}/, '한 번만');
});

/* ── ⑥ ── */
test('⑥ 자동 조절 — 두 창 이어서 넘으면 한 단계 · 10분 유지 · 1시간 낮으면 되돌림 · 끄면 지움', () => {
  TU._resetForTest();
  let st = null; const t0 = NOW;
  const step = (pct, t) => { const r = TU.decide(st, { cpuPct: pct, at: t }, { base: 5, warnPct: 1 }, t); st = r.next; return r.change; };
  assert.equal(step(2, t0), null, '한 창만 — 아직');
  assert.deepEqual(step(2, t0 + 30_000)?.to, 15);
  assert.equal(step(2, t0 + 60_000), null); assert.equal(step(2, t0 + 90_000), null, '늘린 뒤 10분은 다시 늘리지 않는다');
  assert.equal(TU.decide(st, { cpuPct: 2, at: t0 + 90_000 }, { base: 5, warnPct: 1 }, t0 + 700_000).change, null, '같은 창을 두 번 세지 않는다');
  assert.equal(step(2, t0 + 700_000)?.to, 30, '10분 뒤 다시 넘음 → 30초');
  assert.equal(step(0.2, t0 + 730_000), null);
  assert.equal(step(0.2, t0 + 730_000 + 59 * 60_000), null);
  assert.equal(step(0.2, t0 + 730_000 + 61 * 60_000)?.to, 15, '1시간 낮음 → 한 단계 되돌림');
  assert.equal(step(null, t0 + 900_000_000), null, '못 읽음은 판정하지 않는다');
  // tuneTick — 끄면 지운다 · procEveryFor
  const targets = [{ id: 'fm-eeeeeeee55', name: 'E' }];
  let at = NOW; const loads = { 'fm-eeeeeeee55': () => ({ cpuPct: 5, at }) };
  TU.tuneTick({ targets, loadOf: (id) => loads[id](), settings: { autoTune: 1, procEvery: 5, loadWarnPct: 1 }, now: at });
  at += 30_000;
  const ch = TU.tuneTick({ targets, loadOf: (id) => loads[id](), settings: { autoTune: 1, procEvery: 5, loadWarnPct: 1 }, now: at });
  assert.equal(ch.length, 1); assert.equal(TU.procEveryFor('fm-eeeeeeee55', 5), 15);
  TU.tuneTick({ targets, loadOf: (id) => loads[id](), settings: { autoTune: 0, procEvery: 5 }, now: at + 1 });
  assert.equal(TU.procEveryFor('fm-eeeeeeee55', 5), 5, '끄면 설정 주기로');
  assert.equal(TU.recentTunes()[0].to, 15);
});

/* ── ⑦ ── */
test('⑦ 라우트 — 조회 문 · 쓰기 문 · 503 · 감사 · 보이는 서버만 · 미리 보기', async () => {
  AL._resetForTest();
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const svc = await import('../src/focusmon/service.js');
  const { auditEntriesWithAction } = await import('../src/audit.js');
  const users = {
    admin: { username: 'a', role: 'admin', scope: null }, operator: { username: 'o', role: 'operator', scope: null },
    scoped: { username: 's', role: 'admin', scope: { vcenters: ['vc-x'] } }, wscoped: { username: 'w', role: 'admin', scope: { writeVcenters: ['vc-x'] } },
    demo: { username: 'thedvcdemp', role: 'admin', scope: null, demoGuest: true },
  };
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.user = users[req.headers['x-test-user'] || 'admin']; next(); });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base0 = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, p, { who = 'admin', body } = {}) => { const r = await fetch(base0 + p, { method, headers: { 'Content-Type': 'application/json', 'x-test-user': who }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
  try {
    const g = await call('GET', '/api/tools/focus-mon/alerts');
    assert.equal(g.status, 200); assert.ok(g.body.metrics.cpu); assert.deepEqual(g.body.limits.dur, AL.DUR_CHOICES); assert.equal(g.body.tune.enabled, false, '자동 조절 기본 꺼짐(컨펌 ⑥)');
    for (const who of ['operator', 'scoped']) assert.equal((await call('GET', '/api/tools/focus-mon/alerts', { who })).status, 403, who);
    for (const who of ['operator', 'scoped', 'wscoped', 'demo']) assert.equal((await call('POST', '/api/tools/focus-mon/alerts/rules', { who, body: base })).status, 403, who);
    const c = await call('POST', '/api/tools/focus-mon/alerts/rules', { body: base });
    assert.equal(c.status, 200);
    assert.ok(auditEntriesWithAction('focus-mon.alert-create').some((e) => e.detail.includes('CPU 높음')));
    assert.equal((await call('POST', '/api/tools/focus-mon/alerts/rules', { body: { ...base, scope: { kind: 'server', target: 'fm-0000000099' } } })).status, 404, '보이지 않는 서버');
    assert.equal((await call('POST', '/api/tools/focus-mon/alerts/rules', { body: { ...base, threshold: 'x' } })).body.code, 'bad-threshold');
    assert.equal((await call('PUT', `/api/tools/focus-mon/alerts/rules/${c.body.rule.id}`, { body: { enabled: false } })).body.rule.enabled, false);
    for (const who of ['operator', 'wscoped', 'demo']) assert.equal((await call('DELETE', `/api/tools/focus-mon/alerts/rules/${c.body.rule.id}`, { who })).status, 403, who);
    const id = mock.DEMO_TARGETS[0].id;
    const pv = await call('POST', '/api/tools/focus-mon/alerts/preview', { body: { target: id, rule: { metric: 'cpu', threshold: 30, durMin: 5, severity: 'warn' } } });
    assert.equal(pv.status, 200); assert.ok(pv.body.coveredMin > 1000, '데모 1분 요약 24시간'); assert.ok(pv.body.count >= 1);
    assert.equal((await call('POST', '/api/tools/focus-mon/alerts/preview', { body: { target: 'fm-0000000099', rule: base } })).status, 404);
    // 규칙 파일 손상 — 쓰기 503
    fs.writeFileSync(path.join(DIR, AL.RULES_FILE), '{ broken'); AL._resetForTest();
    const bad = await call('POST', '/api/tools/focus-mon/alerts/rules', { body: base });
    assert.equal(bad.status, 503); assert.equal(bad.body.reason, 'rulesUnreadable');
    for (const f of fs.readdirSync(DIR)) if (f.startsWith(AL.RULES_FILE)) fs.rmSync(path.join(DIR, f));
    AL._resetForTest();
  } finally { svc.stopFocusMon(); srv.close(); }
});
