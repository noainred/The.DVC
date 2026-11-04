/**
 * test/bareosHealth2890.test.js — v2.890 Bareos 사전 점검(시안 docs/design/bareos-precheck · 컨펌 2026-11-05).
 *  ① judgeCorp · verdictOf — 엣지에서 본 vCenter 접속 실패 = 불가 · 중앙에서 본 것 = 참고(판정 밖) · 지문 첫 관측 · 바뀜 = 경고 · 디스크 기준 · 모름은 수에 넣지 않음
 *  ② daysToFull — 최근 7일 · 표본 3개 미만 · 늘지 않으면 null
 *  ③ transitionOf · mailPlan — 나빠짐 · 회복 · 좋아짐(메일 없음) · 모름은 커서를 옮기지 않음 · 메일 끄기 설정
 *  ④ healthProbe — 접속 · 지문 · 차단 대역 · 형식 · 시한 · statfs · 같은 서버 판정
 *  ⑤ edgeResult.health — 아는 칸만 · 지문 모양 · 음수 바이트 null
 *  ⑥ ops.health — 중앙에서는 디스크를 재지 않음 · 엣지 + 같은 서버만 잼 · 다른 서버면 remote
 *  ⑦ runDirector · 기록 — 법인(사이트)마다 · trigger · 인증 정지 = 모름 · 지문 기준 · acceptThumb · 이력 7 · 디스크 표본 하루 하나
 *  ⑧ 라우트(실제 라우터 + 가짜 Director) — 범위 · 전 법인 점검 문지기 · 설정 검증 · 지문 기준 범위
 *  ⑨ mailTick(자식 프로세스 — 메일 · 설정 · store 대체) — 나빠짐 한 통 · 반복 없음 · 회복 한 통 · 꺼짐이면 커서만 · 실패면 10분 뒤
 *  ⑩ 일일 요약 절 · 데모
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const J = (p) => JSON.stringify(pathToFileURL(path.join(SRC, p)).href);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bareos2890-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';
process.env.SSRF_ALLOW_LOOPBACK = 'true';

const H = await import('../src/bareos/health.js');
const P = await import('../src/bareos/healthProbe.js');
const { OPS } = await import('../src/bareos/ops.js');
const { sanitizeEdgeResult } = await import('../src/bareos/edgeResult.js');
const { config } = await import('../src/config.js');
const { dayIndex } = await import('../src/util/dayKey.js');
const { startFakeDirector } = await import('./_fakeBareosDirector.js');

const FP1 = 'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01';
const FP2 = '12:34:56:78:9A:BC:DE:F0:12:34:56:78:9A:BC:DE:F0:12:34:56:78';
const TB = 1024 ** 4; const GB = 1024 ** 3;
const edgeRes = (o = {}) => ({ from: 'edge', version: '25.1.2', vcs: [{ host: 'vc.corp', ok: true, code: null, ms: 800, thumbprint: FP1 }], disks: [{ path: '/var/lib/bareos/storage', availBytes: 0.4 * 4 * TB, sizeBytes: 4 * TB, usedBytes: 0.6 * 4 * TB, code: null }], diskSkipped: null, ...o });
const st = (j, key) => j.items.find((x) => x.key === key)?.status;

test('① judgeCorp — 판정 규칙', () => {
  let j = H.judgeCorp({ result: edgeRes(), vcserver: 'vc.corp' });
  assert.equal(j.verdict, 'ok'); assert.equal(st(j, 'thumb'), 'ok'); assert.match(j.items.find((x) => x.key === 'thumb').detail, /첫 관측/);
  assert.equal(j.thumbprint, FP1);
  // 엣지에서 접속 거부 = 불가(조치에 nc 명령) · 지문은 모름
  j = H.judgeCorp({ result: edgeRes({ vcs: [{ host: 'vc.corp', ok: false, code: 'ECONNREFUSED', ms: 5, thumbprint: null }] }), vcserver: 'VC.corp', prevThumb: { value: FP1 } });
  assert.equal(j.verdict, 'bad'); assert.equal(st(j, 'vc'), 'bad'); assert.equal(st(j, 'thumb'), 'unknown');
  assert.match(j.items.find((x) => x.key === 'vc').action, /nc -vz VC\.corp 443/);
  // 중앙에서 본 것 = 참고(판정 밖) · 디스크 모름 → 법인 모름(Director 콘솔만 정상이면 '정상' 이라 하지 않는다)
  j = H.judgeCorp({ result: { from: 'central', version: '25', vcs: [{ host: 'vc.corp', ok: false, code: 'ETIMEDOUT', ms: 10000, thumbprint: null }], disks: [], diskSkipped: 'central' }, vcserver: 'vc.corp' });
  assert.equal(st(j, 'vc'), 'info'); assert.equal(st(j, 'disk'), 'unknown'); assert.equal(j.verdict, 'unknown');
  j = H.judgeCorp({ result: { from: 'central', version: '25', vcs: [{ host: 'vc.corp', ok: true, code: null, ms: 600, thumbprint: FP1 }], disks: [], diskSkipped: 'central' }, vcserver: 'vc.corp', prevThumb: { value: FP1 } });
  assert.equal(st(j, 'thumb'), 'ok'); assert.equal(j.verdict, 'unknown', '중앙에서 지문만 정상이어도 모름');
  // 지문 바뀜 = 경고
  j = H.judgeCorp({ result: edgeRes({ vcs: [{ host: 'vc.corp', ok: true, ms: 1, thumbprint: FP2 }] }), vcserver: 'vc.corp', prevThumb: { value: FP1 } });
  assert.equal(st(j, 'thumb'), 'warn'); assert.equal(j.verdict, 'warn'); assert.match(j.items.find((x) => x.key === 'thumb').detail, new RegExp(`${FP1} → 지금 ${FP2}`));
  // 디스크 기준(여유 %)
  const disk = (pct) => edgeRes({ disks: [{ path: '/v', availBytes: pct * TB, sizeBytes: TB, usedBytes: (1 - pct) * TB }] });
  assert.equal(st(H.judgeCorp({ result: disk(0.04), vcserver: 'vc.corp' }), 'disk'), 'bad');
  assert.equal(st(H.judgeCorp({ result: disk(0.05), vcserver: 'vc.corp' }), 'disk'), 'bad', '경계(5%) 포함');
  assert.equal(st(H.judgeCorp({ result: disk(0.12), vcserver: 'vc.corp' }), 'disk'), 'warn');
  assert.equal(st(H.judgeCorp({ result: disk(0.30), vcserver: 'vc.corp' }), 'disk'), 'ok');
  // 디스크 기준(가득 찰 때까지) — 표본 7일 · 하루 +50GB · 여유 100GB → 2일 = 위험
  const now = Date.now(); const today = dayIndex(now);
  const samples = { '/v': Array.from({ length: 7 }, (_, i) => ({ day: today - 6 + i, used: 900 * GB + i * 50 * GB })) };
  const j2 = H.judgeCorp({ result: edgeRes({ disks: [{ path: '/v', availBytes: 100 * GB, sizeBytes: 600 * GB, usedBytes: 500 * GB }] }), vcserver: 'vc.corp', diskSamples: samples, now });
  assert.equal(st(j2, 'disk'), 'bad'); assert.match(j2.items.find((x) => x.key === 'disk').detail, /약 2일/);
  assert.equal(j2.items.find((x) => x.key === 'disk').disks[0].daysLeft, 2);
  // 설정 기준을 따른다
  const cfg = { ...H.DEFAULTS, disk: { warnPct: 40, warnDays: 14, badPct: 5, badDays: 3 } };
  assert.equal(st(H.judgeCorp({ result: disk(0.30), vcserver: 'vc.corp', cfg }), 'disk'), 'warn');
  // 디스크 못 읽음 · 건너뜀 · 매핑 vcserver 없음 · Director 오류 분류
  assert.equal(st(H.judgeCorp({ result: edgeRes({ disks: [{ path: '/v', code: 'ENOENT', availBytes: null, sizeBytes: null }] }), vcserver: 'vc.corp' }), 'disk'), 'unknown');
  assert.match(H.judgeCorp({ result: edgeRes({ disks: [], diskSkipped: 'remote' }), vcserver: 'vc.corp' }).items.find((x) => x.key === 'disk').detail, /이 엣지 노드에 있지 않습니다/);
  assert.equal(st(H.judgeCorp({ result: edgeRes(), vcserver: '' }), 'vc'), 'unknown');
  const stopped = H.judgeCorp({ error: { code: 'auth-stopped' }, vcserver: 'vc.corp' });
  assert.equal(stopped.verdict, 'unknown', '인증 정지 = 점검하지 않음(모름)');
  assert.match(stopped.items.find((x) => x.key === 'dir').detail, /인증 실패로 주기 조회를 멈춘 Director/);
  assert.equal(H.judgeCorp({ error: { code: 'connect' }, vcserver: 'vc.corp' }).verdict, 'bad');
  assert.equal(H.judgeCorp({ error: { code: 'timeout' }, vcserver: 'vc.corp' }).verdict, 'unknown', '엣지 회신 없음은 모름');
  // 모든 항목 모름이면 법인 모름 · 백틱 없음
  assert.equal(H.verdictOf([{ key: 'dir', status: 'unknown' }, { key: 'vc', status: 'unknown' }]), 'unknown');
  assert.doesNotMatch(JSON.stringify(H.judgeCorp({ result: edgeRes(), vcserver: 'vc.corp' })), /`/);
});

test('② daysToFull — 최근 7일 · 표본 3개 미만 · 늘지 않으면 null', () => {
  const t = 1000;
  assert.equal(H.daysToFull([{ day: t, used: 1 }, { day: t - 1, used: 0 }], 10, t), null, '표본 2개');
  assert.equal(H.daysToFull([{ day: t - 2, used: 5 }, { day: t - 1, used: 5 }, { day: t, used: 5 }], 10, t), null, '늘지 않음');
  assert.equal(H.daysToFull([{ day: t - 2, used: 9 }, { day: t - 1, used: 7 }, { day: t, used: 5 }], 10, t), null, '줄어듦');
  const r = H.daysToFull([{ day: t - 20, used: 0 }, { day: t - 2, used: 10 }, { day: t - 1, used: 20 }, { day: t, used: 30 }], 100, t);
  assert.equal(r.perDay, 10, '7일 밖 표본은 쓰지 않는다'); assert.equal(r.days, 10);
  assert.equal(H.daysToFull([{ day: t - 2, used: 10 }, { day: t - 1, used: 20 }, { day: t, used: 30 }], null, t), null, '여유를 못 읽음');
});

test('③ transitionOf · mailPlan', () => {
  assert.equal(H.transitionOf('bad', null), 'worse', '처음부터 불가면 알린다');
  assert.equal(H.transitionOf('ok', null), null);
  assert.equal(H.transitionOf('warn', 'ok'), 'worse');
  assert.equal(H.transitionOf('bad', 'warn'), 'worse');
  assert.equal(H.transitionOf('warn', 'bad'), 'better');
  assert.equal(H.transitionOf('ok', 'bad'), 'recover');
  assert.equal(H.transitionOf('unknown', 'bad'), null, '모름은 커서를 옮기지 않는다');
  assert.equal(H.transitionOf('bad', 'bad'), null, '같은 상태는 다시 보내지 않는다');
  const corps = { a: { verdict: 'bad', notified: null, items: [] }, b: { verdict: 'warn', notified: 'bad', items: [] }, c: { verdict: 'ok', notified: 'warn', items: [] }, d: { verdict: 'unknown', notified: 'ok', items: [] } };
  const p = H.mailPlan(corps);
  assert.deepEqual(p.rows.map((r) => [r.vcenterId, r.kind]), [['a', 'worse'], ['c', 'recover']]);
  assert.deepEqual(p.marks, { a: 'bad', b: 'warn', c: 'ok' }, '좋아짐도 커서는 옮긴다(나중에 다시 나빠지면 알린다)');
  const off = H.mailPlan(corps, { mail: { onWorse: false, onRecover: false } });
  assert.deepEqual(off.rows, []); assert.deepEqual(off.marks, p.marks, '메일을 꺼도 커서는 옮긴다');
});

test('④ healthProbe — 접속 · 지문 · 차단 · 형식 · 시한 · statfs · 같은 서버', async () => {
  const { EventEmitter } = await import('node:events');
  const fake = (mode, fp = FP1) => (opts, onSecure) => {
    const s = new EventEmitter(); s.destroy = () => {}; s.getPeerCertificate = () => ({ fingerprint: fp }); s.opts = opts;
    setTimeout(() => { if (mode === 'ok') onSecure(); else if (mode !== 'hang') s.emit('error', Object.assign(new Error(mode), { code: mode })); }, 1);
    fake.last = opts; return s;
  };
  let r = await P.checkVc('vc.corp', { connect: fake('ok') });
  assert.equal(r.ok, true); assert.equal(r.thumbprint, FP1); assert.equal(fake.last.servername, 'vc.corp'); assert.equal(fake.last.rejectUnauthorized, false); assert.equal(typeof fake.last.lookup, 'function', 'SSRF lookup 훅');
  r = await P.checkVc('192.168.1.10', { connect: fake('ok') });
  assert.equal(fake.last.servername, undefined, 'IP 리터럴에는 SNI 를 싣지 않는다');
  r = await P.checkVc('vc.corp', { connect: fake('ok', 'not-a-fp') });
  assert.equal(r.thumbprint, null, '모양이 틀린 지문은 버린다');
  assert.equal((await P.checkVc('vc.corp', { connect: fake('ECONNREFUSED') })).code, 'ECONNREFUSED');
  assert.equal((await P.checkVc('vc.corp', { connect: fake('ESSRFBLOCKED') })).code, 'blocked');
  assert.equal((await P.checkVc('vc.corp', { connect: fake('EWEIRD') })).code, 'error');
  assert.equal((await P.checkVc('vc.corp', { connect: fake('hang'), timeoutMs: 1000 })).code, 'ETIMEDOUT');
  const ac = new AbortController(); setTimeout(() => ac.abort(), 5);
  assert.equal((await P.checkVc('vc.corp', { connect: fake('hang'), signal: ac.signal, timeoutMs: 20_000 })).code, 'ETIMEDOUT', '시한 신호');
  delete process.env.SSRF_ALLOW_LOOPBACK;
  try {
    let called = false;
    r = await P.checkVc('169.254.169.254', { connect: () => { called = true; return fake('ok')({}, () => {}); } });
    assert.equal(r.code, 'blocked'); assert.equal(called, false, '링크로컬은 접속하지 않는다');
  } finally { process.env.SSRF_ALLOW_LOOPBACK = 'true'; }
  assert.equal((await P.checkVc('a b;rm', { connect: fake('ok') })).code, 'invalid');
  // statfs
  const disks = await P.checkDisks(['/v', '/missing', 'rel/path', '/a/../b'], { statfs: async (p) => { if (p === '/missing') throw Object.assign(new Error('x'), { code: 'ENOENT' }); return { bsize: 4096, blocks: 1000, bfree: 400, bavail: 300 }; } });
  assert.deepEqual(disks.map((d) => [d.path, d.code]), [['/v', null], ['/missing', 'ENOENT'], ['rel/path', 'invalid'], ['/a/../b', 'invalid']]);
  assert.deepEqual([disks[0].sizeBytes, disks[0].availBytes, disks[0].usedBytes], [4096000, 1228800, 2457600]);
  // 같은 서버
  const ifaces = { eth0: [{ address: '10.20.0.14' }] };
  assert.equal(P.isThisHost('10.20.0.14', { ifaces, hostname: 'edge1' }), true);
  assert.equal(P.isThisHost('EDGE1.corp', { ifaces, hostname: 'edge1.corp' }), true);
  assert.equal(P.isThisHost('127.0.0.1', { ifaces, hostname: 'x' }), true);
  assert.equal(P.isThisHost('10.9.9.9', { ifaces, hostname: 'edge1' }), false);
  assert.equal(P.isThisHost('', { ifaces, hostname: 'edge1' }), false);
});

test('⑤ edgeResult.health — 아는 칸만', () => {
  const env = (value) => sanitizeEdgeResult('health', { ok: true, value }).value;
  const r = env({ from: 'edge', version: '25.1.2', at: Date.now(), secret: 'x', vcs: [{ host: 'vc', ok: true, ms: 5, thumbprint: FP1, extra: 1 }, { host: 'v2', ok: 'yes', code: 'ECONNREFUSED; rm', thumbprint: 'zz' }], disks: [{ path: '/v', availBytes: -1, sizeBytes: '100', usedBytes: 5, code: 'ENOENT' }], diskSkipped: 'other' });
  assert.equal(r.secret, undefined); assert.equal(r.vcs[0].extra, undefined);
  assert.equal(r.vcs[1].ok, false, '불리언만'); assert.equal(r.vcs[1].code, null, '코드 모양 밖'); assert.equal(r.vcs[1].thumbprint, null);
  assert.equal(r.disks[0].availBytes, null, '음수는 못 읽음'); assert.equal(r.disks[0].sizeBytes, 100, '문자열 수치는 수로');
  assert.equal(r.diskSkipped, null);
  assert.equal(env({ from: 'x' }).from, 'central');
  assert.equal(sanitizeEdgeResult('health', { ok: false, code: 'auth-stopped', reason: 'x' }).code, 'auth-stopped', '실패 봉투는 코드를 지킨다');
});

test('⑥ ops.health — 중앙은 디스크를 재지 않는다 · 엣지 + 같은 서버만 · 다른 서버면 remote', async () => {
  const s = { info: { banner: 'OK: bareos-dir Version: 25.1.2 (01 Nov 2026)' } };
  const prev = config.agent.centralUrl;
  try {
    config.agent.centralUrl = '';
    let r = await OPS.health(s, { vcservers: [], volumeDirs: [tmp], dirHost: '127.0.0.1' });
    assert.deepEqual([r.from, r.version, r.diskSkipped, r.disks.length], ['central', '25.1.2', 'central', 0]);
    config.agent.centralUrl = 'https://central.example';
    r = await OPS.health(s, { vcservers: [], volumeDirs: [tmp], dirHost: '127.0.0.1' });
    assert.deepEqual([r.from, r.diskSkipped], ['edge', null]);
    assert.equal(r.disks[0].path, tmp); assert.ok(r.disks[0].sizeBytes > 0, '실제 statfs');
    r = await OPS.health(s, { vcservers: [], volumeDirs: [tmp], dirHost: '10.123.45.67' });
    assert.deepEqual([r.diskSkipped, r.disks.length], ['remote', 0]);
  } finally { config.agent.centralUrl = prev; }
  const { MUTATING } = await import('../src/bareos/ops.js');
  assert.equal(MUTATING.has('health'), false, '읽기 전용');
  const { RESULT_MS } = await import('../src/bareos/edgeOps.js');
  assert.ok(RESULT_MS.health > 0 && RESULT_MS.health <= 120_000);
});

test('⑦ runDirector · 기록 — 법인마다 · trigger · 지문 기준 · 이력 · 디스크 표본', async () => {
  H._resetHealthForTest();
  const calls = [];
  let res = edgeRes({ vcs: [{ host: 'vc-a.corp', ok: true, ms: 1, thumbprint: FP1 }, { host: 'vc-b.corp', ok: false, code: 'ENOTFOUND', ms: 1, thumbprint: null }] });
  H._setHealthDepsForTest({ onDirector: async (dir, kind, args, o) => { calls.push([dir, kind, args, o.trigger, !!o.signal]); if (dir === 'dX') throw Object.assign(new Error('정지'), { code: 'auth-stopped' }); return res; } });
  const plan = { directorId: 'd1', name: '한국', host: '10.0.0.1', sites: [{ vcenterId: 'vc-a', vcserver: 'vc-a.corp' }, { vcenterId: 'vc-b', vcserver: 'vc-b.corp' }], volumeDirs: ['/var/lib/bareos/storage'] };
  await H.runDirector(plan, { trigger: 'timer' });
  assert.deepEqual(calls[0].slice(0, 2), ['d1', 'health']);
  assert.deepEqual(calls[0][2], { vcservers: ['vc-a.corp', 'vc-b.corp'], volumeDirs: ['/var/lib/bareos/storage'], dirHost: '10.0.0.1' });
  assert.deepEqual(calls[0].slice(3), ['timer', true]);
  let v = H.healthView();
  const byId = Object.fromEntries(v.corps.map((c) => [c.vcenterId, c]));
  assert.equal(byId['vc-a'].verdict, 'ok'); assert.equal(byId['vc-b'].verdict, 'bad', '법인(사이트)마다 따로');
  assert.equal(byId['vc-a'].thumbBase, FP1, '첫 관측이 기준');
  // 지문이 바뀌면 경고 → 새 지문을 기준으로 → 정상
  res = edgeRes({ vcs: [{ host: 'vc-a.corp', ok: true, ms: 1, thumbprint: FP2 }] });
  await H.runDirector(plan, { trigger: 'manual' });
  v = H.healthView((id) => id === 'vc-a');
  assert.equal(v.corps.length, 1, 'allow 로 거른다');
  assert.equal(v.corps[0].verdict, 'warn'); assert.equal(v.corps[0].thumbBase, FP1, '기준은 저절로 바뀌지 않는다');
  const after = H.acceptThumb('vc-a');
  assert.equal(after.thumbBase, FP2); assert.equal(after.verdict, 'ok');
  assert.throws(() => H.acceptThumb('vc-zz'), /지금 본 지문이 없습니다/);
  // 이력 7 · 디스크 표본은 하루 하나
  for (let i = 0; i < 9; i++) await H.runDirector(plan);
  v = H.healthView((id) => id === 'vc-a');
  assert.equal(v.corps[0].history.length, 7);
  assert.equal(Object.values(v.corps[0].spark)[0].length, 1, '같은 날은 표본 하나');
  // 인증 정지 = 모름 · 동시 실행 거부
  await H.runDirector({ ...plan, directorId: 'dX', sites: [{ vcenterId: 'vc-x', vcserver: 'vc-x.corp' }] });
  assert.equal(H.healthView((id) => id === 'vc-x').corps[0].verdict, 'unknown');
  H._setHealthDepsForTest({ onDirector: () => new Promise((r) => setTimeout(() => r(res), 50)) });
  const p1 = H.runDirector(plan);
  await assert.rejects(() => H.runDirector(plan), (e) => e.code === 'conflict');
  await p1;
  // 상태 파일(비밀 없음 · 0600)
  const f = path.join(tmp, 'bareos-health-state.json');
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  H._setHealthDepsForTest({});
});

test('⑦-b plansOf · dueOf', () => {
  const plans = H.plansOf({ directors: [{ id: 'd1', name: 'A', host: 'h1', agent: 'e1' }, { id: 'd2', name: 'B' }], sites: [{ vcenterId: 'v1', directorId: 'd1', vcserver: 'vc1' }, { vcenterId: 'v2', directorId: 'd1', vcserver: '' }, { vcenterId: 'v3', directorId: 'gone' }] });
  assert.equal(plans.length, 1, '매핑이 없는 Director · 없는 Director 의 매핑은 점검하지 않는다');
  assert.deepEqual(plans[0].sites, [{ vcenterId: 'v1', vcserver: 'vc1' }, { vcenterId: 'v2', vcserver: '' }]);
  assert.deepEqual(plans[0].volumeDirs, [H.DEFAULT_VOLUME_DIR], '설치 기록이 없으면 기본 경로');
  // dueOf — 포탈 시각(기본 UTC+9) 20:00
  const at = (h, m) => Date.UTC(2026, 10, 5, h - 9, m);
  const cfg = { enabled: true, time: '20:00' };
  assert.equal(H.dueOf(cfg, {}, at(19, 59)).due, false);
  assert.equal(H.dueOf(cfg, {}, at(20, 0)).due, true);
  assert.equal(H.dueOf(cfg, { day: '2026-11-05' }, at(21, 0)).due, false, '오늘 돌았으면 다시 돌지 않는다');
  assert.equal(H.dueOf({ ...cfg, enabled: false }, {}, at(21, 0)).due, false);
  // 설정 검증
  assert.throws(() => H.normHealth({ disk: { warnPct: 5, badPct: 5 } }), /위험 여유 %/);
  assert.throws(() => H.normHealth({ disk: { warnDays: 3, badDays: 3 } }), /위험 일수/);
  assert.throws(() => H.normHealth({ time: '25:00' }), /HH:MM/);
  assert.throws(() => H.normHealth({ disk: { warnPct: 'x' } }), /정수/);
  assert.deepEqual(H.normHealth({}), { enabled: true, time: '20:00', disk: { warnPct: 15, warnDays: 14, badPct: 5, badDays: 3 }, mail: { onWorse: true, onRecover: true, inDigest: true } }, '컨펌된 기본값');
});

/* ── ⑧ 라우트 ── */
let srv; let base; let fd;
const USERS = { admin: { username: 'adm', role: 'admin', scope: null }, sadm: { username: 'sadm', role: 'admin', scope: { vcenters: ['vc-a'] } }, wadm: { username: 'wadm', role: 'admin', scope: { writeVcenters: ['vc-a'] } } };
before(async () => {
  fd = await startFakeDirector({ name: 'portal', password: 'pw-1', handle: async () => ({ jobs: [] }) });
  fs.writeFileSync(path.join(tmp, 'users.json'), JSON.stringify({ users: [{ username: 'adm', role: 'admin' }, { username: 'sadm', role: 'admin' }, { username: 'wadm', role: 'admin' }] }));
  fs.writeFileSync(path.join(tmp, 'bareos.json'), JSON.stringify({
    version: 2, directors: [{ id: 'dir_kr', name: 'KR-dir', host: '127.0.0.1', port: fd.port, consoleName: 'portal', password: 'pw-1', timeoutMs: 5000 }], defaults: {},
    sites: [
      { vcenterId: 'vc-a', directorId: 'dir_kr', vcserver: '127.0.0.1', client: 'kr-fd', storage: 'kr-sd', pool: 'p', configFile: '/etc/bareos/vmware/kr.ini' },
      { vcenterId: 'vc-b', directorId: 'dir_kr', vcserver: '127.0.0.1', client: 'kr-fd', storage: 'kr-sd', pool: 'p', configFile: '/etc/bareos/vmware/kr.ini' },
    ],
  }));
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const { store } = await import('../src/store.js');
  store.snapshot = { generatedAt: Date.now(), source: 'mock', vcenters: [{ id: 'vc-a', name: 'Seoul' }, { id: 'vc-b', name: 'Warsaw' }], hosts: [], datastores: [], alarms: [], networks: [], vms: [] };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api', api);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}/api/tools/bareos-backup/health`;
});
after(async () => { try { srv?.close(); } catch { /* */ } await fd?.close(); });
const call = async (u, method, sub = '', body) => {
  const r = await fetch(`${base}${sub}`, { method, headers: { 'x-u': u, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* */ }
  return { s: r.status, j, t };
};

test('⑧ 라우트 — 범위 · 전 법인 점검 문지기 · 설정 · 지문 기준', async () => {
  H._resetHealthForTest(); H._setHealthDepsForTest({});
  for (const f of fs.readdirSync(tmp)) if (f.startsWith('bareos-health')) fs.rmSync(path.join(tmp, f));
  // 한 법인 지금 점검(실제 가짜 Director — 중앙 직접이라 vCenter 접속은 참고 · 디스크 모름 → 모름)
  let r = await call('admin', 'POST', '/run', { vcenterId: 'vc-a' });
  assert.equal(r.s, 200, r.t);
  assert.equal(r.j.corp.vcenterId, 'vc-a'); assert.equal(r.j.corp.from, 'central'); assert.equal(r.j.corp.verdict, 'unknown');
  assert.equal(r.j.corp.items.find((x) => x.key === 'dir').status, 'ok');
  assert.ok(!/pw-1|password/.test(r.t), '비밀 없음');
  // 조회 — 전체 범위는 설정 · 범위 계정은 자기 법인만 · 설정 없음
  r = await call('admin', 'GET');
  assert.equal(r.s, 200); assert.deepEqual(r.j.corps.map((c) => c.vcenterId).sort(), ['vc-a', 'vc-b']); assert.ok(r.j.config);
  r = await call('sadm', 'GET');
  assert.deepEqual(r.j.corps.map((c) => c.vcenterId), ['vc-a']); assert.equal(r.j.config, undefined); assert.equal(r.j.last, null);
  // 범위 밖 법인 = 404 · 쓰기 밖 = 403
  assert.equal((await call('sadm', 'POST', '/run', { vcenterId: 'vc-b' })).s, 404);
  assert.equal((await call('wadm', 'POST', '/run', { vcenterId: 'vc-b' })).s, 403);
  assert.equal((await call('sadm', 'POST', '/vc-b/thumb-accept', {})).s, 404);
  assert.equal((await call('wadm', 'POST', '/vc-b/thumb-accept', {})).s, 403);
  assert.equal((await call('admin', 'POST', '/run', { vcenterId: 'vc-zz' })).s, 404);
  // 전 법인 점검 — 범위 · 쓰기 제한 관리자는 403 · 전체 범위는 202
  r = await call('sadm', 'POST', '/run', {});
  assert.equal(r.s, 403); assert.match(r.j.reason, /전체 범위 관리자만/, '조회 범위 계정은 첫 문지기에서');
  assert.equal((await call('wadm', 'POST', '/run', {})).s, 403);
  r = await call('admin', 'POST', '/run', {});
  assert.equal(r.s, 202, r.t);
  for (let i = 0; i < 100 && H.healthRunning(); i++) await new Promise((x) => setTimeout(x, 20));
  // 설정 — 전체 범위만 · 검증 · 저장
  assert.equal((await call('sadm', 'GET', '/settings')).s, 403);
  assert.equal((await call('wadm', 'PUT', '/settings', { time: '19:30' })).s, 403);
  assert.equal((await call('admin', 'PUT', '/settings', { disk: { warnPct: 5, badPct: 5 } })).s, 400);
  r = await call('admin', 'PUT', '/settings', { time: '19:30', disk: { warnPct: 20, warnDays: 21, badPct: 10, badDays: 7 }, mail: { onWorse: true, onRecover: false, inDigest: true } });
  assert.equal(r.s, 200, r.t); assert.equal(r.j.config.time, '19:30'); assert.equal(r.j.config.mail.onRecover, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'bareos-health.json'), 'utf8')).disk.badDays, 7);
  // 지문 기준 — 본 지문이 없으면 400(중앙 직접 · 127.0.0.1:443 은 열려 있지 않다)
  assert.equal((await call('admin', 'POST', '/vc-a/thumb-accept', {})).s, 400);
  // 관리자가 아니면 403
  assert.equal((await call('nobody', 'GET')).s, 403);
});

/* ── ⑨ 메일 ── */
test('⑨ mailTick — 나빠짐 한 통 · 반복 없음 · 회복 · 꺼짐이면 커서만 · 실패면 10분 뒤', () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'bareos2890m-'));
  const corp = (verdict, notified) => ({ at: 1, directorId: 'd1', directorName: '폴란드 Bareos', from: 'edge', verdict, notified, items: [{ key: 'vc', status: verdict === 'ok' ? 'ok' : 'bad', label: 'vCenter 접속', detail: 'vc:443 접속 거부(ECONNREFUSED) · 엣지 노드에서', action: 'FD 서버에서 nc -vz vc 443' }], history: [] });
  fs.writeFileSync(path.join(cfg, 'bareos-health-state.json'), JSON.stringify({ corps: { 'vc-pl': corp('bad', null), 'vc-kr': corp('ok', null) }, disks: {}, mail: {} }));
  const script = `
    import { mock } from 'node:test';
    globalThis.SENT = []; globalThis.MAIL = { enabled: true, kinds: {} }; globalThis.FAIL = false;
    mock.module(${J('mail/service.js')}, { namedExports: { sendPortalMail: async (m) => { globalThis.SENT.push(m); return globalThis.FAIL ? { ok: false, reason: 'SMTP' } : { ok: true }; } } });
    mock.module(${J('mail/settings.js')}, { namedExports: { load: () => globalThis.MAIL } });
    mock.module(${J('store.js')}, { namedExports: { store: { get: () => ({ source: 'live', vcenters: [{ id: 'vc-pl', name: 'vcenter-pl-krakow-01' }] }) } } });
    const H = await import(${J('bareos/health.js')});
    const out = {};
    const t0 = Date.now();
    globalThis.FAIL = true; await H.mailTick(t0); out.fail = globalThis.SENT.length;
    await H.mailTick(t0 + 60_000); out.retryTooSoon = globalThis.SENT.length;
    globalThis.FAIL = false; await H.mailTick(t0 + 11 * 60_000); out.sent = globalThis.SENT.length; out.subject = globalThis.SENT.at(-1).subject; out.kind = globalThis.SENT.at(-1).kind; out.html = globalThis.SENT.at(-1).html;
    await H.mailTick(t0 + 12 * 60_000); out.noRepeat = globalThis.SENT.length;
    const st = JSON.parse((await import('node:fs')).readFileSync(process.env.CONFIG_DIR + '/bareos-health-state.json', 'utf8'));
    st.corps['vc-pl'].verdict = 'ok'; st.corps['vc-pl'].items = [];
    (await import('node:fs')).writeFileSync(process.env.CONFIG_DIR + '/bareos-health-state.json', JSON.stringify(st));
    H._resetHealthForTest();
    await H.mailTick(t0 + 13 * 60_000); out.recover = globalThis.SENT.at(-1).subject; out.n2 = globalThis.SENT.length;
    const st2 = JSON.parse((await import('node:fs')).readFileSync(process.env.CONFIG_DIR + '/bareos-health-state.json', 'utf8'));
    st2.corps['vc-pl'].verdict = 'warn';
    (await import('node:fs')).writeFileSync(process.env.CONFIG_DIR + '/bareos-health-state.json', JSON.stringify(st2));
    H._resetHealthForTest();
    globalThis.MAIL = { enabled: true, kinds: { 'bareos-precheck': { enabled: false } } };
    await H.mailTick(t0 + 14 * 60_000); out.offSent = globalThis.SENT.length;
    out.offNotified = JSON.parse((await import('node:fs')).readFileSync(process.env.CONFIG_DIR + '/bareos-health-state.json', 'utf8')).corps['vc-pl'].notified;
    console.log(JSON.stringify(out));
    process.exit(0);
  `;
  const res = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, CONFIG_DIR: cfg, DATA_SOURCE: 'live' } });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout.trim().split('\n').pop());
  assert.equal(out.fail, 1, '보내 보고 실패'); assert.equal(out.retryTooSoon, 1, '10분 안에는 다시 보내지 않는다');
  assert.equal(out.sent, 2); assert.equal(out.kind, 'bareos-precheck');
  assert.match(out.subject, /^\[Bareos 사전 점검\] 불가 1 — vcenter-pl-krakow-01$/);
  assert.match(out.html, /접속 거부/); assert.match(out.html, /nc -vz vc 443/); assert.match(out.html, /백업 성공을 보장하지 않습니다/);
  assert.equal(out.noRepeat, 2, '같은 상태는 다시 보내지 않는다(정상 법인은 처음부터 보내지 않는다)');
  assert.match(out.recover, /회복 1/); assert.equal(out.n2, 3);
  assert.equal(out.offSent, 3, '이 종류가 꺼져 있으면 보내지 않고');
  assert.equal(out.offNotified, 'warn', '커서만 옮긴다(켠 뒤 쌓인 것을 쏟지 않는다)');
});

test('⑩ 일일 요약 절 · 데모', () => {
  H._resetHealthForTest();
  fs.writeFileSync(path.join(tmp, 'bareos-health-state.json'), JSON.stringify({ corps: {
    a: { directorName: 'A', verdict: 'bad', items: [{ key: 'vc', status: 'bad', detail: '접속 거부' }] }, b: { directorName: 'B', verdict: 'ok', items: [] }, c: { directorName: 'C', verdict: 'unknown', items: [] },
  }, disks: {}, mail: {}, last: { at: Date.now() } }));
  fs.writeFileSync(path.join(tmp, 'bareos-health.json'), JSON.stringify(H.normHealth({})));
  let s = H.healthDigestSection((id) => `vc-${id}`);
  assert.match(s.html, /정상 1 · 불가 1 · 경고 0 · 모름 1/);
  assert.match(s.html, /vc-a/); assert.doesNotMatch(s.html, /vc-b/, '정상 법인은 싣지 않는다'); assert.match(s.html, /vc-c/);
  fs.writeFileSync(path.join(tmp, 'bareos-health.json'), JSON.stringify(H.normHealth({ mail: { inDigest: false } })));
  H._resetHealthForTest();
  assert.equal(H.healthDigestSection(), null, '설정에서 끄면 절이 없다');
  const d = H.demoHealth(Array.from({ length: 6 }, (_, i) => ({ id: `v${i}`, name: `n${i}` })));
  assert.deepEqual(d.corps.map((c) => c.verdict), ['bad', 'bad', 'warn', 'warn', 'ok', 'unknown']);
  assert.ok(d.demo && d.corps.every((c) => c.demo));
});
