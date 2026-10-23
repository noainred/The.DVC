/**
 * v2.772 G3(bughunt4 Z4) — 로그 DB 소비처가 '수집은 하지만 뒤처진 vCenter'(따라잡는 중 포함)를 0건/정상에 섞던 것.
 *  Z4-S3 지연 판정 한 벌(logs/coverage.js) — VM 가용성의 측정 끝(measureEndOf)·허용치(tailToleranceOf)와 같은 코어
 *  Z4-1  미보호 VM: 지연 vCenter 의 보호 근거 없는 VM 은 미보호가 아니라 판정 불가 'collect-lag'(실제 라우트)
 *  Z4-2  로그인 실패 분석 · 주기 감시 상태 · 로그 이슈 분석(+ 기억 키)에 lagging
 *  Z4-3  구성 변경 이력: 스캔 상한에 닿으면 실제로 훑은 시각 범위(scannedFrom ~ scannedTo)
 * 재현 원본: scratchpad bughunt4/Z4/r1_consumers.mjs · r3_changes.mjs. 기준 시각은 정시 경계로 고정한다(docs/rules/common.md).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evlog2772c-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.AUTH_ENABLED = 'false';
fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({
  vcenters: [
    { id: 'oc1', name: 'OC1', host: 'oc1.example.invalid', username: 'u', password: 'p' },
    { id: 'oc2s', name: 'OC2Sandbox', host: 'oc2s.example.invalid', username: 'u', password: 'p' },
    { id: 'vc-s', name: 'Site', host: 's.example.invalid', username: 'u', password: 'p', collectMode: 'site', remoteAgent: 'edge-pl' },
  ],
}));

const servers = [];
after(async () => {
  for (const s of servers) { try { s.closeAllConnections?.(); s.close(); } catch { /* */ } }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ }
});

const express = (await import('express')).default;
const { store } = await import('../src/store.js');
const { api } = await import('../src/routes/api.js');
const { getLogsDb } = await import('../src/logs/db.js');
const cov = await import('../src/logs/coverage.js');
const { measureEndOf } = await import('../src/availability/analyze.js');
const { tailToleranceOf } = await import('../src/routes/api/vmAvailability.js');
const { computeUnprotected } = await import('../src/reports/unprotected.js');
const { analyzeLoginFails } = await import('../src/security/loginFails.js');
const { runLoginAnalysisNow, loginMonitorStatus } = await import('../src/security/loginMonitor.js');
const { analyzeLogsForIssues, analyzeLogsForIssuesMemo, _resetLogIssuesMemo } = await import('../src/net/logIssues.js');
const { lagDurText } = await import('../../web/src/views/eventCoverageText.js');

const H = 3_600_000;
const DAY = 24 * H;
const BASE = Math.floor(Date.now() / H) * H;          // 정시 경계로 고정한 '지금'
const LAG = 94 * H;                                    // 실서버 OC2Sandbox 3일 22시간
const REG = [{ id: 'oc1' }, { id: 'oc2s' }, { id: 'vc-s', collectMode: 'site', remoteAgent: 'edge-pl' }];
// okAt 주입: oc1 은 지금까지 온전 · oc2s 는 94시간 전까지만(따라잡는 중)
const okAtStale = (id) => (id === 'oc1' ? BASE : id === 'oc2s' ? BASE - LAG : null);
const okAtFresh = (id) => (id === 'oc1' || id === 'oc2s' ? BASE : null);
const LAG_DEPS = { registry: REG, okAtOf: okAtStale, tolMs: H };

const db = await getLogsDb();
const rows = [];
let k = 0;
const ev = (vcenterId, ts, o = {}) => rows.push({ vcenterId, key: `k${++k}`, ts, severity: 'info', type: 'UserLoginSessionEvent', user: 'x', entity: 'h1', message: 'm', ...o });
// oc1 은 정시 경계 + 59분까지 이벤트가 있다(라우트는 실제 시각으로 판정 — 정시 경계를 넘은 실행에서도 '지금' 으로 보이게).
for (let t = BASE - 7 * DAY; t <= BASE + 59 * 60_000; t += 30 * 60_000) { ev('oc1', t); if (t <= BASE - LAG) ev('oc2s', t); }
const snap = (vc, vm, ts) => ev(vc, ts, { type: 'VmSnapshotCreatedEvent', user: 'CORP\\svc-veeam', entity: vm, message: `Created snapshot VeeamTmp on ${vm}` });
for (let d = 1; d <= 7; d++) { snap('oc1', 'daily-a', BASE - d * DAY); if (BASE - d * DAY <= BASE - LAG) snap('oc2s', 'daily-b', BASE - d * DAY); }
snap('oc1', 'weekly-a', BASE - 2 * DAY);                 // oc1 은 수집됨 → 보호
// weekly-b@oc2s 의 백업(지금 − 2일)은 아직 수집 전 구간이라 DB 에 없다
db.insertMany(rows);

const VMS = ['daily-a', 'weekly-a', 'daily-b', 'weekly-b'].map((n, i) => ({ id: `vm-${i}`, name: n, vcenterId: n.endsWith('a') ? 'oc1' : 'oc2s', powerState: 'POWERED_ON', storageGB: 10 + i }));
store.snapshot = {
  generatedAt: new Date(BASE).toISOString(), source: 'live',
  vcenters: [{ id: 'oc1', name: 'OC1', status: 'ok' }, { id: 'oc2s', name: 'OC2Sandbox', status: 'ok' }, { id: 'vc-s', name: 'Site', status: 'ok', collectSource: 'site' }],
  hosts: [], vms: VMS, datastores: [], networks: [], alarms: [], collectionErrors: [],
};

const ADMIN = { username: 'adm', role: 'admin', name: 'adm', scope: null };
async function serve(user = ADMIN) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { ...user }; next(); });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  servers.push(srv);
  const base = `http://127.0.0.1:${srv.address().port}`;
  return async (p) => { const r = await fetch(base + p); let b = null; try { b = await r.json(); } catch { /* */ } return { status: r.status, b }; };
}

test('Z4-S3 허용치는 VM 가용성의 tailToleranceOf 와 같은 식(같은 입력 → 같은 값)', () => {
  for (const s of [undefined, null, {}, { pollIntervalMin: 10 }, { pollIntervalMin: 30 }, { pollIntervalMin: 1 }, { pollIntervalMin: '' }, { pollIntervalMin: 'abc' }, { pollIntervalMin: -5 }, { pollIntervalMin: '45' }]) {
    assert.equal(cov.eventTailToleranceOf(s), tailToleranceOf(s), JSON.stringify(s));
  }
});

test('Z4-S3 eventLagOf — measureEndOf 와 같은 판정(okAt·lastTs 중 늦은 것 · 둘 다 없으면 모름=null)', () => {
  const now = BASE;
  const cases = [
    { okAt: now - 10 * 60_000, lastTs: now - 5 * DAY },     // 조용한 vCenter — 수집은 정상
    { okAt: now - LAG, lastTs: now - LAG },                  // 따라잡는 중
    { okAt: null, lastTs: now - 3 * H },                     // 재시작 직후 — 마지막 저장 시각
    { okAt: null, lastTs: null },                            // 받은 적 없음 — 지연이 아니라 모름
    { okAt: now - 2 * H, lastTs: now - 10 * 60_000 },        // 늦은 쪽(lastTs)
  ];
  for (const c of cases) {
    const m = measureEndOf(c, now, H);
    const r = cov.eventLagOf('v', { now, tolMs: H, okAtOf: () => c.okAt, lastTsOf: () => c.lastTs });
    assert.equal(r != null, m.cut, JSON.stringify(c));
    if (r) { assert.equal(r.okAt, m.end); assert.equal(r.lagMs, now - m.end); assert.equal(r.source, m.source); }
  }
  // lastTs 가 0(db.lastTs 의 '없음')이면 못 읽은 값 — 1970 년으로 세지 않는다
  assert.equal(cov.eventLagOf('v', { now, tolMs: H, okAtOf: () => null, lastTsOf: () => 0 }), null);
});

test('Z4-S3 eventLagList/eventLagForView — 직접 수집 대상만 · notCollected 제외 · allowed·only 거르기 · 판정 못 하면 null', async () => {
  const nc = new Map([['vc-s', 'site']]);
  const ids = cov.eventCollectedIds({ registry: REG });
  assert.deepEqual(ids, ['oc1', 'oc2s'], '엣지 위임은 직접 수집 대상이 아니다');
  const all = cov.eventLagList({ ids: [...ids, 'vc-s'], now: BASE, tolMs: H, okAtOf: okAtStale, lastTsOf: () => null, notCollected: nc });
  assert.deepEqual(all.map((x) => x.vcenterId), ['oc2s']);
  assert.equal(all[0].lagMs, LAG);
  assert.deepEqual(cov.eventLagList({ ids, now: BASE, tolMs: H, okAtOf: okAtStale, allowed: new Set(['oc1']) }), [], '범위 밖 vCenter id 를 싣지 않는다');
  assert.deepEqual(cov.eventLagList({ ids, now: BASE, tolMs: H, okAtOf: okAtStale, only: ['oc1'] }), []);
  const v = await cov.eventLagForView({ db, now: BASE, notCollected: nc, deps: LAG_DEPS });
  assert.deepEqual(v.map((x) => x.vcenterId), ['oc2s']);
  // 기본 경로(등록부·로그 폴러 동적 import·db.lastTs) — 폴러 기록이 없으니 마지막 저장 시각으로 판정한다
  const d = await cov.eventLagForView({ db, now: BASE, notCollected: nc, deps: { tolMs: H } });
  assert.deepEqual(d.map((x) => x.vcenterId), ['oc2s']);
  assert.equal(d[0].source, 'last-event');
  // 판정 실패는 [] 가 아니라 null
  assert.equal(await cov.eventLagForView({ db, now: BASE, deps: { registry: REG, okAtOf: () => { throw new Error('x'); }, tolMs: H } }), null);
  assert.equal(cov.eventLagText(LAG), '3일 22시간');
  for (const ms of [null, -1, 0, 59_000, 40 * 60_000, 5 * H, 47 * H, 48 * H, LAG, 9 * DAY + 16 * H]) assert.equal(lagDurText(ms), cov.eventLagText(ms), `웹·서버 문구 한 규칙: ${ms}`);
});

test('Z4-1 computeUnprotected — 지연 vCenter 의 보호 근거 없는 VM 은 판정 불가 collect-lag · 근거가 있으면 그대로 보호', () => {
  const r = computeUnprotected(VMS, rows, { lookbackDays: 7, coveredVcenterIds: new Set(['oc1', 'oc2s']), notCollectedVcenterIds: new Map(),
    laggingVcenters: [{ vcenterId: 'oc2s', okAt: BASE - LAG, lagMs: LAG }] });
  assert.deepEqual(r.unprotected.map((x) => x.name), [], `weekly-b 를 미보호로 세면 거짓 백업 공백이다: ${JSON.stringify(r.unprotected)}`);
  assert.deepEqual(r.undetermined.map((x) => `${x.name}:${x.reason}`), ['weekly-b:collect-lag']);
  assert.ok(r.protected.some((x) => x.name === 'daily-b'), '지연 vCenter 라도 보이는 백업 근거는 실재한다');
  assert.deepEqual(r.summary.laggingVcenters, [{ vcenterId: 'oc2s', okAt: BASE - LAG, lagMs: LAG, vms: 1 }]);
  assert.equal(r.summary.undeterminedByReason['collect-lag'], 1);
  // Map 으로 줘도 같다 · 근거를 안 주면 예전 판정
  const m = computeUnprotected(VMS, rows, { lookbackDays: 7, laggingVcenters: new Map([['oc2s', { okAt: BASE - LAG, lagMs: LAG }]]) });
  assert.deepEqual(m.undetermined.map((x) => x.reason), ['collect-lag']);
  assert.deepEqual(computeUnprotected(VMS, rows, { lookbackDays: 7 }).unprotected.map((x) => x.name), ['weekly-b']);
});

test('Z4-1 실제 라우트 /tools/report/unprotected — oc2s(94시간 지연)의 weekly-b 는 미보호가 아니다', async () => {
  const get = await serve();
  const r = await get('/api/tools/report/unprotected?lookbackDays=7');
  assert.equal(r.status, 200);
  assert.deepEqual(r.b.unprotected.map((x) => x.name), [], JSON.stringify(r.b.summary));
  assert.deepEqual(r.b.undetermined.map((x) => `${x.name}:${x.reason}`), ['weekly-b:collect-lag']);
  assert.deepEqual(r.b.summary.laggingVcenters.map((x) => x.vcenterId), ['oc2s']);
  assert.ok(r.b.summary.laggingVcenters[0].lagMs >= LAG, '지연 길이는 실제 시각 기준이라 94시간 이상');
  assert.equal(r.b.protected.length, 3);
});

test('Z4-2 로그인 실패 분석 — lagging 을 싣는다(고른 vCenter 하나 · 전체 보기는 직접 수집 대상 중 뒤처진 것)', async () => {
  const one = await analyzeLoginFails({ vcenterId: 'oc2s', days: 2 }, { db, notCollected: new Map(), now: BASE, lag: LAG_DEPS });
  assert.deepEqual(one.lagging.map((x) => [x.vcenterId, x.lagMs]), [['oc2s', LAG]]);
  assert.equal(one.summary.vcenter, 0, '받은 만큼의 수치는 그대로 둔다');
  const fine = await analyzeLoginFails({ vcenterId: 'oc1', days: 2 }, { db, notCollected: new Map(), now: BASE, lag: LAG_DEPS });
  assert.deepEqual(fine.lagging, []);
  const all = await analyzeLoginFails({ days: 2 }, { db, notCollected: new Map([['vc-s', 'site']]), now: BASE, lag: LAG_DEPS });
  assert.deepEqual(all.lagging.map((x) => x.vcenterId), ['oc2s']);
  const nc = await analyzeLoginFails({ vcenterId: 'vc-s', days: 2 }, { db, notCollected: new Map([['vc-s', 'site']]), now: BASE, lag: LAG_DEPS });
  assert.deepEqual(nc.lagging, [], '지금 수집하지 않는 vCenter 는 notCollected 가 말한다(원인을 섞지 않는다)');
});

test('Z4-2 주기 감시 상태 — lagging(뒤처져 아직 보지 못한 vCenter)', async () => {
  await runLoginAnalysisNow();
  const st = loginMonitorStatus();
  assert.ok(Array.isArray(st.lagging), JSON.stringify(st));
  assert.deepEqual(st.lagging.map((x) => x.vcenterId), ['oc2s']);
  assert.deepEqual(st.notMonitored.map((x) => x.vcenterId), ['vc-s']);
});

test('Z4-2 로그 이슈 분석 — 고른 vCenter 가 뒤처졌으면 unknown collect-lag 패턴 · 범위(고른 하나)만 · 기억 키에 지연 집합', async () => {
  const one = await analyzeLogsForIssues({ vcenterId: 'oc2s', days: 1 }, { db, notCollected: new Map(), now: BASE, lag: LAG_DEPS });
  assert.equal(one.patterns[0].sev, 'unknown');
  assert.equal(one.patterns[0].code, 'collect-lag');
  assert.match(one.patterns[0].title, /3일 22시간 뒤처져/);
  assert.ok(!one.patterns.some((p) => p.title === '특이 패턴 없음'), '받은 것만으로 \'특이 패턴 없음\' 이라 단정하지 않는다');
  assert.deepEqual(one.lagging.map((x) => x.vcenterId), ['oc2s']);
  const oc1 = await analyzeLogsForIssues({ vcenterId: 'oc1', days: 1 }, { db, notCollected: new Map(), now: BASE, lag: LAG_DEPS });
  assert.deepEqual(oc1.lagging, [], '고른 vCenter 가 아니면 싣지 않는다(범위 계정은 라우트가 vCenter 하나를 강제한다)');
  assert.equal(oc1.patterns[0].title, '특이 패턴 없음');
  const all = await analyzeLogsForIssues({ days: 1 }, { db, notCollected: new Map([['vc-s', 'site']]), now: BASE, lag: LAG_DEPS });
  assert.equal(all.patterns[0].code, 'collect-lag');
  assert.deepEqual(all.lagging.map((x) => x.vcenterId), ['oc2s']);
  // 기억: 새 행 없이 따라잡기가 끝나면(okAt 만 전진 — lastRowid 그대로) 다음 요청은 다시 계산한다
  _resetLogIssuesMemo();
  const m1 = await analyzeLogsForIssuesMemo({ vcenterId: 'oc2s', days: 1 }, { db, notCollected: new Map(), lag: { ...LAG_DEPS } });
  assert.deepEqual(m1.lagging.map((x) => x.vcenterId), ['oc2s']);
  const m2 = await analyzeLogsForIssuesMemo({ vcenterId: 'oc2s', days: 1 }, { db, notCollected: new Map(), lag: { ...LAG_DEPS, okAtOf: okAtFresh } });
  assert.deepEqual(m2.lagging, [], '지연이 풀렸는데 1분 동안 기억한 \'뒤처짐\' 을 계속 말하면 안 된다');
  assert.notEqual(m2.patterns[0].code, 'collect-lag');
});

test('Z4-3 구성 변경 이력 — 스캔 상한에 닿으면 실제로 훑은 시각 범위를 싣는다', async () => {
  const extra = [];
  // 최근 2만 1천 행(1분 간격 · 비변경 종류) — 상한 2만 행이 덮는 범위는 약 333시간이 아니라 최근 2만 분
  for (let i = 0; i < 21_000; i++) extra.push({ vcenterId: 'oc1', key: `chg${i}`, ts: BASE - i * 30_000, severity: 'info', type: 'UserLoginSessionEvent', user: 'x', entity: 'h1', message: 'm' });
  db.insertMany(extra);
  const get = await serve();
  const r = await get('/api/tools/report/changes?days=7');
  assert.equal(r.status, 200);
  assert.equal(r.b.truncated, true);
  assert.equal(r.b.scanMax, 20_000);
  assert.ok(Number.isFinite(r.b.scannedFrom) && Number.isFinite(r.b.scannedTo), JSON.stringify({ f: r.b.scannedFrom, t: r.b.scannedTo }));
  const all = db.query({ since: BASE - 7 * DAY }, 20_000, 0);
  assert.equal(r.b.scannedFrom, all[all.length - 1].ts, '가장 오래된 훑은 행');
  assert.equal(r.b.scannedTo, all[0].ts, '가장 최근 훑은 행');
  assert.ok(r.b.scannedTo - r.b.scannedFrom < 7 * DAY, '7일을 골라도 실제로 본 것은 그보다 짧다 — 화면이 그 범위를 말해야 한다');
});
