// v2.960 — Monitoring 쉬운 등록(시안 3차 A+B+C): 사용/중지 일괄 · 시험 점검 후 사용(직접 · 엣지 · 시한 · 재시작) · 알림 억제 ·
//   법인 판정 보강 · 법인 담당 엣지 · 감시 범위 · 라우트 게이트. 설계 docs/design/monitoring-autoreg/README.md §11.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripComments } from './_stripComments.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'svcmon-easyreg-'));
process.env.CONFIG_DIR = TMP;
process.env.AUTH_ENABLED = 'true';

const S = await import('../src/svcmon/store.js');
const TRI = await import('../src/svcmon/trial.js');
const TR = await import('../src/svcmon/transitions.js');
const SS = await import('../src/svcmon/settingsSync.js');
const AS = await import('../src/central/svcmonAssignSync.js');
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const tcp = (name, port, extra = {}) => ({ name, type: 'tcp', port, intervalSec: 60, ...extra });
function seed(rows) {
  const r = S.bulkAddTargets(rows.map((x) => ({ kind: 'infra', path: 'Test', host: '10.0.0.1', enabled: false, ...x })), { dedup: false });
  assert.equal(r.committed, true, JSON.stringify(r.errors));
  S.flushStore();
  const byName = new Map(S.listTargets().map((x) => [x.name, x]));
  return rows.map((x) => byName.get(x.name));
}

/* ── A: 사용/중지 일괄 ── */
test('setEnabledMany — enabled 하나만 바꾸고 저장은 한 번 · 바뀐 대상의 엣지 · 없음 · 그대로', () => {
  const [a, b, c] = seed([
    { name: 'en-a', tests: [tcp('TCP 22', 22), tcp('TCP 443', 443)] },
    { name: 'en-b', agent: 'edge-x', tests: [tcp('TCP 22', 22)] },
    { name: 'en-c', enabled: true, tests: [tcp('TCP 22', 22)] },
  ]);
  const rev = S.storeRevision();
  const r = S.setEnabledMany({ targets: [a.id, b.id, c.id, 'nope'], enabled: true });
  assert.equal(r.changed, 2); assert.equal(r.unchanged, 1); assert.deepEqual(r.missing, ['nope']);
  assert.deepEqual(r.agents, ['edge-x'], '바뀐 대상의 담당 엣지만(배정 동기화 대상)');
  assert.equal(S.storeRevision(), rev + 1, '저장은 한 번');
  assert.equal(S.getTarget(a.id).enabled, true);
  assert.equal(S.getTarget(a.id).name, 'en-a', '다른 칸은 그대로');
  const r2 = S.setEnabledMany({ tests: [{ targetId: a.id, testId: a.tests[1].id }], enabled: false });
  assert.equal(r2.changed, 1);
  assert.equal(S.getTarget(a.id).tests[1].enabled, false);
  assert.equal(S.getTarget(a.id).tests[0].enabled !== false, true, '다른 점검은 그대로');
  assert.equal(S.setEnabledMany({ targets: [], enabled: true }).changed, 0);
});

/* ── A: 시험 계획 · 판정(순수) ── */
test('judgeTrial — 경고는 통과 · 하나라도 실패면 실패(사유) · 결과 없음은 실패 · 엣지는 다 오기 전 대기', () => {
  assert.equal(TRI.judgeTrial([{ name: 'a', status: 'ok' }, { name: 'b', status: 'warn' }]).verdict, 'pass');
  const f = TRI.judgeTrial([{ name: 'a', status: 'ok' }, { name: 'SSH 22', status: 'bad', reply: '연결 거부' }]);
  assert.equal(f.verdict, 'fail'); assert.match(f.reason, /SSH 22 — 연결 거부/);
  assert.equal(TRI.judgeTrial([]).verdict, 'fail', '무음 통과 금지');
  assert.equal(TRI.judgeTrial([], 2).verdict, 'wait');
  assert.equal(TRI.judgeTrial([{ name: 'a', status: 'ok' }], 2).verdict, 'wait', '기대 2개 중 1개 — 아직 통과로 단정하지 않는다');
  assert.equal(TRI.judgeTrial([{ name: 'a', status: 'bad' }], 2).verdict, 'fail', '실패는 다 오기 전에도 판정');
});

test('planTrial — 점검 위치: byAgent 엣지 · 직접 · 경로 기준 엣지 · 점검할 곳 없음 · 이미 사용 · 켜진 점검 없음', () => {
  const mk = (o) => ({ id: o.name, kind: 'infra', path: o.path || 'P', name: o.name, host: 'h', enabled: false, tests: [tcp('TCP 22', 22)], ...o });
  const assignments = [
    { agent: 'edge-by', scope: { byAgent: true }, exceptTypes: ['trace', 'domain'], lastExpectMs: 120_000 },
    { agent: 'edge-path', scope: { byAgent: false, kind: 'infra', path: 'Site', includeSub: true }, exceptTypes: ['trace', 'domain'] },
  ];
  const list = [
    mk({ name: 'on', enabled: true }),
    mk({ name: 'notests', tests: [tcp('x', 1, { enabled: false })] }),
    mk({ name: 'by', agent: 'edge-by', tests: [tcp('TCP 22', 22), { name: 'TR', type: 'trace', intervalSec: 300 }] }),
    mk({ name: 'noassign', agent: 'edge-new' }),
    mk({ name: 'pathcov', path: 'Site\\a' }),
    mk({ name: 'plain' }),
    mk({ name: 'onlytrace', agent: 'edge-by', tests: [{ name: 'TR', type: 'trace', intervalSec: 300 }] }),
  ];
  const central = TRI.planTrial(list, { executes: false, assignments });
  const where = (p) => Object.fromEntries([...p.local.map((x) => [x.name, 'local']), ...p.edge.map((x) => [x.name, 'edge']), ...p.skip.map((x) => [x.name, 'skip'])]);
  assert.deepEqual(where(central), { on: 'skip', notests: 'skip', by: 'edge', noassign: 'edge', pathcov: 'skip', plain: 'skip', onlytrace: 'skip' });
  const by = central.edge.find((x) => x.name === 'by');
  assert.deepEqual(by.expect, ['TCP 22'], '엣지 배정 제외 유형(trace)은 기대 점검에서 뺀다');
  assert.equal(by.expectMs, 120_000);
  assert.match(central.skip.find((x) => x.name === 'pathcov').reason, /경로 기준 배정 엣지\(edge-path\)/);
  assert.match(central.skip.find((x) => x.name === 'plain').reason, /점검할 곳이 없습니다/);
  const both = TRI.planTrial(list, { executes: true, assignments });
  assert.deepEqual(where(both), { on: 'skip', notests: 'skip', by: 'edge', noassign: 'edge', pathcov: 'local', plain: 'local', onlytrace: 'skip' });
  assert.match(both.local.find((x) => x.name === 'pathcov').note, /경로 기준 배정/);
});

test('edgeOfTarget — 엣지 배정 PUT 의 고르기 규칙(다른 엣지 소유 · 구분 · 하위 포함)', () => {
  const as = [{ agent: 'e1', scope: { byAgent: false, kind: 'infra', path: 'A', includeSub: false } }];
  assert.deepEqual(AS.edgeOfTarget({ path: 'A', kind: 'infra' }, as), { agent: 'e1', mode: 'path' });
  assert.deepEqual(AS.edgeOfTarget({ path: 'A\\b', kind: 'infra' }, as), { agent: '', mode: '' }, '하위 포함이 아니면 아래 경로는 아니다');
  assert.deepEqual(AS.edgeOfTarget({ path: 'A', kind: 'service' }, as), { agent: '', mode: '' });
  assert.deepEqual(AS.edgeOfTarget({ path: 'A', kind: 'infra', agent: 'e1' }, as), { agent: 'e1', mode: 'path' });
  assert.deepEqual(AS.edgeOfTarget({ path: 'Z', agent: 'e2' }, as), { agent: 'e2', mode: 'byAgent' }, '배정이 없는 엣지는 byAgent 로 굳힐 수 있다');
});

/* ── A: 직접 시험 ── */
test('직접 시험 — 통과만 켜고 실패는 중지 유지 + 사유 · 결과는 폴러 결과에 넣지 않는다 · 같은 때 두 번은 409', async () => {
  TRI._resetTrialForTest();
  const [ok, bad] = seed([
    { name: 'loc-ok', tests: [tcp('TCP 22', 22), tcp('TCP 443', 443)] },
    { name: 'loc-bad', tests: [tcp('TCP 22', 22), tcp('TCP 8443', 8443)] },
  ]);
  let release;
  const gate = new Promise((r) => { release = r; });
  const run = async (items) => {
    await gate;
    return items.map(({ test: x }) => ({ testId: x.id, status: x.port === 8443 ? 'bad' : (x.port === 443 ? 'warn' : 'ok'), reply: x.port === 8443 ? '연결 거부' : '12ms', ms: 12 }));
  };
  const r = TRI.startTrial([ok.id, bad.id], { user: 'op', deps: { executes: true, assignments: [], run } });
  assert.equal(r.ok, true);
  assert.equal(r.job.state, 'running');
  const again = TRI.startTrial([ok.id], { deps: { executes: true, assignments: [], run } });
  assert.equal(again.ok, false); assert.equal(again.busy, true, '직접 시험은 한 번에 하나');
  release();
  await r.done;
  const job = TRI.getTrial(r.job.id);
  assert.equal(job.state, 'done');
  assert.deepEqual(job.counts, { pass: 1, fail: 1, wait: 0, skip: 0, running: 0 });
  assert.equal(S.getTarget(ok.id).enabled, true, '통과 → 사용');
  assert.equal(S.getTarget(bad.id).enabled, false, '실패 → 중지 유지');
  const bi = job.items.find((x) => x.targetId === bad.id);
  assert.match(bi.reason, /TCP 8443 — 연결 거부/);
  assert.equal(bi.tests.length, 2);
  assert.equal(TRI.trialOf(bad.id).state, 'fail');
  const P = await import('../src/svcmon/poller.js');
  assert.equal(P.getResults().has(ok.tests[0].id), false, '시험 결과는 폴러 결과·전이 이력에 넣지 않는다(시험은 감시가 아니다)');
});

test('직접 시험 — 실행 오류는 실패로 남기고 잠금을 푼다', async () => {
  TRI._resetTrialForTest();
  const [x] = seed([{ name: 'loc-err', tests: [tcp('TCP 22', 22)] }]);
  const r = TRI.startTrial([x.id], { deps: { executes: true, assignments: [], run: async () => { throw new Error('pool down'); } } });
  await r.done;
  const it = TRI.getTrial(r.job.id).items[0];
  assert.equal(it.state, 'fail'); assert.match(it.reason, /pool down/);
  assert.equal(TRI.trialBusy(), false);
});

/* ── A: 엣지 시험 ── */
test('엣지 시험 — 켜고 배정 동기화 · 알림 억제(시한) · 첫 보고로 판정(실패 → 중지 + 배정 다시) · 시한 초과 되돌림 · 재시작 뒤 이어 판정', async () => {
  TRI._resetTrialForTest();
  const sent = [];
  TR._resetTransitionsForTest({ send: async (a) => { sent.push(a); } });
  TR._setAlertSettingsForTest({ enabled: true, failCount: 1, scope: 'all' });
  const [p1, p2, p3] = seed([
    { name: 'edge-pass', path: 'E', agent: 'edge-a', tests: [tcp('TCP 22', 22), tcp('TCP 443', 443)] },
    { name: 'edge-fail', path: 'E', agent: 'edge-a', tests: [tcp('TCP 22', 22)] },
    { name: 'edge-silent', path: 'E', agent: 'edge-b', tests: [tcp('TCP 22', 22)] },
  ]);
  const syncCalls = [];
  const sync = (agents, user, o) => { syncCalls.push({ agents: [...agents].sort(), note: o?.note }); return agents.map((agent) => ({ agent, ok: true })); };
  const t0 = Date.now();
  const r = TRI.startTrial([p1.id, p2.id, p3.id], { user: 'op', now: t0, deps: { executes: false, assignments: [], sync } });
  assert.equal(r.ok, true);
  assert.equal(r.job.counts.wait, 3);
  for (const x of [p1, p2, p3]) assert.equal(S.getTarget(x.id).enabled, true, '엣지는 배정 스냅샷의 켜진 대상만 돈다 — 먼저 켠다');
  assert.deepEqual(syncCalls[0], { agents: ['edge-a', 'edge-b'], note: '시험 점검' });
  assert.equal(TR.isMuted('E', 'EDGE-FAIL', t0 + 1000), true, '시험 중 알림 억제(이름 대소문자 무시)');
  // 시험 중 실패 결과 — 알리지 않는다
  TR.noteResult({ scope: 'edge-a', testId: 'x1', status: 'bad', streak: 1, at: t0 + 1000, target: { name: 'edge-fail', path: 'E' }, test: { name: 'TCP 22', type: 'tcp' } });
  await TR.flushAlerts();
  assert.equal(sent.length, 0, '시험 중인 대상은 실패 알림을 보내지 않는다');
  // 파일에 남는다(재시작 대비)
  const saved = JSON.parse(fs.readFileSync(path.join(TMP, 'svcmon-trial.json'), 'utf8'));
  assert.equal(saved.pending.length, 3);

  const rows = {
    'edge-a': [
      { path: 'E', target: 'edge-pass', test: 'TCP 22', status: 'ok', measuredAt: t0 - 5000 },   // 시험 전 측정 — 세지 않는다
      { path: 'E', target: 'edge-pass', test: 'TCP 22', status: 'ok', measuredAt: t0 + 2000 },
      { path: 'E', target: 'edge-fail', test: 'TCP 22', status: 'bad', reply: '연결 시간 초과', measuredAt: t0 + 2000 },
    ],
    'edge-b': null,
  };
  const tick1 = TRI.trialTick(t0 + 3000, { ackAt: () => t0, edgeRows: (a) => rows[a], sync });
  assert.equal(tick1.judged, 1, '실패만 판정 — 통과는 기대 점검 2개가 다 와야 한다');
  assert.equal(S.getTarget(p2.id).enabled, false, '엣지 첫 보고 실패 → 중지로 되돌림');
  assert.deepEqual(syncCalls.at(-1).agents, ['edge-a'], '되돌린 대상의 엣지 배정을 다시 굳힌다');
  assert.equal(TR.isMuted('E', 'edge-fail', t0 + 3000), true, '실패로 되돌린 대상은 엣지가 다음 당기기까지 옛 스냅샷으로 재므로 억제를 이어 간다(반증 M1)');
  assert.equal(TR.isMuted('E', 'edge-fail', t0 + 3000 + TRI.revertMuteMs(0) + 1), false, '그 억제에도 시한이 있다');
  rows['edge-a'].push({ path: 'E', target: 'edge-pass', test: 'TCP 443', status: 'warn', measuredAt: t0 + 4000 });
  TRI.trialTick(t0 + 5000, { ackAt: () => t0, edgeRows: (a) => rows[a], sync });
  assert.equal(S.getTarget(p1.id).enabled, true, '경고 포함 전부 보고 → 통과 · 사용 유지');
  assert.equal(TRI.getTrial(r.job.id).items.find((x) => x.targetId === p1.id).state, 'pass');

  // 재시작 — 파일에서 대기(edge-silent)를 이어 받는다. 시한 전에는 그대로, 지나면 되돌린다.
  TRI._resetTrialForTest({ reload: true });
  assert.equal(TRI.pendingTrials().length, 1);
  const dl = TRI.pendingTrials()[0].deadline;
  assert.ok(dl - t0 >= TRI.EDGE_DEADLINE_BASE_MS, '시한은 기본값 이상');
  assert.equal(TRI.trialTick(dl - 1, { ackAt: () => t0, edgeRows: () => null, sync }).judged, 0);
  const tEnd = TRI.trialTick(dl, { ackAt: () => t0, edgeRows: () => null, sync });
  assert.equal(tEnd.failed, 1);
  assert.equal(S.getTarget(p3.id).enabled, false, '시한까지 보고가 없으면 중지로 되돌린다(켠 채로 남지 않게)');
  assert.match(TRI.trialOf(p3.id, dl).reason, /시한까지 엣지 보고가 없었습니다/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(TMP, 'svcmon-trial.json'), 'utf8')).pending.length, 0);
  // 시험이 끝난 뒤의 실패는 알린다
  TR.noteResult({ scope: 'edge-b', testId: 'y1', status: 'bad', streak: 1, at: dl + TRI.revertMuteMs(0) + 1000, target: { name: 'edge-silent', path: 'E' }, test: { name: 'TCP 22', type: 'tcp' } });
  await TR.flushAlerts();
  assert.equal(sent.length, 1, '억제는 시험 · 되돌림 여유 동안만');
});

test('엣지 시험 — 배정을 굳히지 못한 엣지의 대상은 곧바로 되돌린다(켠 채로 남지 않는다)', () => {
  TRI._resetTrialForTest();
  const [x] = seed([{ name: 'edge-nosync', path: 'E2', agent: 'edge-z', tests: [tcp('TCP 22', 22)] }]);
  const r = TRI.startTrial([x.id], { deps: { executes: false, assignments: [], sync: (agents) => agents.map((agent) => ({ agent, ok: false, reason: '배정 상한' })) } });
  const it = r.job.items[0];
  assert.equal(it.state, 'fail'); assert.match(it.reason, /배정 상한/);
  assert.equal(S.getTarget(x.id).enabled, false);
  assert.equal(TRI.pendingTrials().length, 0);
  assert.equal(TR.isMuted('E2', 'edge-nosync'), false);
});

test('edgeDeadlineMs — 기본 이상 · push 주기가 길면 늘리고 · 상한', () => {
  assert.equal(TRI.edgeDeadlineMs(60_000), TRI.EDGE_DEADLINE_BASE_MS);
  assert.ok(TRI.edgeDeadlineMs(10 * 60_000) > TRI.EDGE_DEADLINE_BASE_MS);
  assert.equal(TRI.edgeDeadlineMs(10 * 3600_000), TRI.EDGE_DEADLINE_MAX_MS);
});

/* ── C: 법인 판정 보강 · 법인 담당 엣지 ── */
const ctx = {
  vcNames: new Map([['vc-reg', 'VC Registered']]),
  dcNames: new Map([['dc-fra', 'Frankfurt 법인'], ['dc-sel', 'Seoul 법인']]),
  dcOfVc: new Map([['vc-reg', 'dc-sel']]),
  vcAssign: new Map([['vc-reg', 'dc-sel'], ['vc-mock', 'dc-fra'], ['vc-mock2', 'dc-fra']]),
  dcByName: new Map([['dc-fra', 'dc-fra'], ['frankfurt 법인', 'dc-fra'], ['dc-sel', 'dc-sel'], ['seoul 법인', 'dc-sel'], ['seoul', 'dc-sel']]),
  vcEdge: new Map([['vc-mock', 'Edge-FRA']]),
};
test('corpOf — facts.datacenterId · 등록부에 없는 vCenter 의 DataCenter 할당 · DataCenter 이름(대소문자만 무시) · 묶음 키', () => {
  assert.deepEqual(SS.corpOf({ facts: { datacenterId: 'dc-fra' } }, ctx), { id: 'dc-fra', key: 'dc-fra', label: 'Frankfurt 법인' }, 'SAN 스위치 · iDRAC 의 소속 법인');
  assert.equal(SS.corpOf({ vcenterId: 'vc-mock' }, ctx).label, 'Frankfurt 법인', '등록부에 없는 vCenter 도 할당으로');
  assert.equal(SS.corpOf({ vcenterId: 'vc-mock' }, ctx).key, SS.corpOf({ vcenterId: 'vc-mock2' }, ctx).key, '같은 법인의 vCenter 둘은 같은 묶음');
  assert.deepEqual(SS.corpOf({ vcenterId: 'vc-reg' }, ctx), { id: 'vc-reg', key: 'dc-sel', label: 'Seoul 법인' }, 'id 는 예전 뜻 그대로');
  assert.equal(SS.corpOf({ facts: { datacenter: 'SEOUL' } }, ctx).label, 'Seoul 법인');
  assert.equal(SS.corpOf({ facts: { datacenter: 'Seoul-2' } }, ctx).label, '전역', '비슷한 이름으로 짐작하지 않는다');
  assert.deepEqual(SS.corpOf({}, ctx), { id: '', key: '', label: '전역' });
});

test('corpEdgesOf — 근거(수집 엣지 · 수집 서버 법인)만 · 배정 후보만 · 한 법인에 둘이면 고르지 않는다', () => {
  const cands = new Map([['edge-fra', 'Edge-FRA'], ['edge-sel', 'Edge-SEL'], ['edge-sel2', 'Edge-SEL2']]);
  const built = [
    { kind: 'set:collector', name: 'Edge-SEL', ref: 'c1', facts: { datacenter: 'Seoul' } },
    { kind: 'set:collector', name: 'Edge-SEL2', ref: 'c2', facts: { vcenterId: 'vc-reg' } },
    { kind: 'set:collector', name: 'Edge-NOTOKEN', ref: 'c3', facts: { datacenter: 'dc-fra' } },
  ];
  const m = SS.corpEdgesOf(built, ctx, cands);
  assert.deepEqual(m.get('dc-fra'), { agent: 'Edge-FRA', ambiguous: [] }, '수집 엣지(collectedBy) 근거 · 후보가 아닌 수집 서버는 무시');
  assert.deepEqual(m.get('dc-sel'), { agent: '', ambiguous: ['Edge-SEL', 'Edge-SEL2'] }, '둘이면 고르지 않는다');
});

test('classifyCatalog · planApply — 행에 법인 묶음 키 · 법인 엣지(엣지 포탈 자신은 제외) · corpEdge 일 때만 그 엣지로 · 연동됐지만 중지 수', () => {
  const cands = new Map([['edge-fra', 'Edge-FRA']]);
  const built = { targets: [
    { id: 'set:sanswitch-ssh|s1', kind: 'set:sanswitch-ssh', ref: 's1', name: 'SAN-FRA-1', host: '10.1.1.1', port: 22, facts: { datacenterId: 'dc-fra' } },
    { id: 'set:pdu|p1', kind: 'set:pdu', ref: 'p1', name: 'PDU-FRA-1', host: '10.1.1.2', port: 22, vcenterId: 'dc-fra', agent: 'Edge-FRA' },
    { id: 'set:collector|Edge-FRA', kind: 'set:collector', ref: 'Edge-FRA', name: 'Edge-FRA', host: 'edge.fra', port: 4000, scheme: 'https', facts: { datacenter: 'Frankfurt 법인' } },
    { id: 'set:idrac|i1', kind: 'set:idrac', ref: 'i1', name: 'idrac-off', host: '10.1.1.3', port: 443, scheme: 'https', vcenterId: 'vc-mock' },
  ] };
  const linkedOff = { id: 'g-off', kind: 'infra', path: '설정 연동\\서버\\Frankfurt 법인', name: 'idrac-off', host: '10.1.1.3', enabled: false, tests: [], origin: { key: 'set:idrac|i1', kind: 'set:idrac' } };
  const res = SS.classifyCatalog(built, [linkedOff], { ctx, candidates: cands });
  const row = (k) => res.rows.find((r) => r.key === k);
  assert.equal(row('set:sanswitch-ssh|s1').corp, 'Frankfurt 법인', 'SAN 스위치가 더는 전역이 아니다');
  assert.equal(row('set:sanswitch-ssh|s1').corpKey, 'dc-fra');
  assert.equal(row('set:sanswitch-ssh|s1').corpAgent, 'Edge-FRA');
  assert.equal(row('set:collector|Edge-FRA').corpAgent, '', '엣지 포탈은 중앙이 잰다');
  assert.equal(res.counts.linkedOff, 1);
  assert.deepEqual(res.corpEdges, [{ key: 'dc-fra', agent: 'Edge-FRA', ambiguous: [] }]);
  const builtByKey = new Map(built.targets.map((x) => [x.id, x]));
  const keys = ['set:sanswitch-ssh|s1', 'set:pdu|p1'];
  const off = SS.planApply(res.rows, keys, { builtByKey, svcTargets: [] });
  assert.equal(off.add.find((a) => a.key === 'set:sanswitch-ssh|s1').row.agent, undefined, 'corpEdge 를 고르지 않으면 예전 그대로(중앙)');
  const on = SS.planApply(res.rows, keys, { builtByKey, svcTargets: [], corpEdge: true });
  const san = on.add.find((a) => a.key === 'set:sanswitch-ssh|s1');
  assert.equal(san.row.agent, 'Edge-FRA'); assert.equal(san.agentFrom, 'corp');
  assert.equal(on.add.find((a) => a.key === 'set:pdu|p1').agentFrom, undefined, '항목 자체의 엣지가 우선');
  assert.equal(SS.previewOf(on).add.find((a) => a.key === 'set:sanswitch-ssh|s1').agentFrom, 'corp');
});

test('coverageSummary — 감시 중 + 중지 + 미등록 = 설정된 시스템(제외 · 설정 문제 · 사라짐은 따로)', () => {
  SS._resetSettingsSyncForTest();
  assert.equal(SS.coverageSummary(), null, '감지 전에는 없다(지어내지 않는다)');
  SS.noteDetection({ rows: [], counts: { total: 12, linked: 3, changed: 1, linkedOff: 2, new: 5, problem: 1, excluded: 2, gone: 0, held: 0 } }, { at: 1000 });
  const c = SS.coverageSummary();
  assert.deepEqual({ configured: c.configured, monitored: c.monitored, stopped: c.stopped, unregistered: c.unregistered, problem: c.problem, excluded: c.excluded },
    { configured: 9, monitored: 2, stopped: 2, unregistered: 5, problem: 1, excluded: 2 });
  assert.equal(c.monitored + c.stopped + c.unregistered, c.configured);
});

test('설정 카탈로그 — iDRAC · SAN 스위치가 등록부의 소속 법인(datacenterId)을 싣는다', () => {
  const src = stripComments(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'linkcheck', 'settingsLinks.js'), 'utf8'));
  const blk = (name) => { const i = src.indexOf(`load('${name}'`); return src.slice(i, src.indexOf('}));', i)); };
  assert.match(blk('idrac'), /datacenterId: t\(s\.datacenterId\)/);
  assert.match(blk('sanswitch'), /datacenterId: t\(d\.datacenterId\)/);
});

/* ── 반증 1인(2026-11-10) 재현 → 회귀: H1 · M1 · M2 · M3 ── */
const E = await import('../src/central/svcmonEdge.js');
const A = await import('../src/central/svcmonAssign.js');
const okSync = (agents) => agents.map((agent) => ({ agent, ok: true }));
const edgeDeps = { executes: false, assignments: [], sync: okSync };

test('반증 M1 — 엣지 시험 실패로 되돌린 뒤에도 엣지가 옛 스냅샷으로 재는 동안 실패 알림을 보내지 않는다(시한 있음)', async () => {
  TRI._resetTrialForTest(); E._resetEdgeCache();
  const sent = [];
  TR._resetTransitionsForTest({ send: async (a) => { sent.push(a); } });
  TR._setAlertSettingsForTest({ enabled: true, failCount: 3, scope: 'all' });
  const [x] = seed([{ name: 'm1-x', path: 'M1', agent: 'edge-a', tests: [tcp('TCP 22', 22)] }]);
  const t0 = Date.now();
  TRI.startTrial([x.id], { now: t0, deps: edgeDeps });
  const meta = [{ i: 'e1', p: 'M1', n: 'm1-x', h: '10.0.0.1', t: 'TCP 22', y: 'tcp', iv: 60 }];
  E.ingestReport('edge-a', { snapId: 1, seq: 1, total: 1, rows: [{ i: 'e1', s: 'bad', r: 'refused', k: 1, a: 0 }], meta }, t0 + 60_000);
  assert.equal(TRI.trialTick(t0 + 61_000, { ackAt: () => t0, sync: okSync }).failed, 1, '기본 edgeRows(getAgentRaw) 경로로 판정');
  assert.equal(S.getTarget(x.id).enabled, false);
  E.ingestReport('edge-a', { snapId: 2, seq: 1, total: 1, rows: [{ i: 'e1', s: 'bad', r: 'refused', k: 2, a: 0 }] }, t0 + 120_000);
  E.ingestReport('edge-a', { snapId: 3, seq: 1, total: 1, rows: [{ i: 'e1', s: 'bad', r: 'refused', k: 3, a: 0 }] }, t0 + 180_000);
  await TR.flushAlerts();
  assert.equal(sent.length, 0, '되돌린 대상의 옛 스냅샷 측정은 알리지 않는다');
  assert.equal(TR.isMuted('M1', 'm1-x', t0 + 61_000 + TRI.revertMuteMs(0) - 1), true);
  assert.equal(TR.isMuted('M1', 'm1-x', t0 + 61_000 + TRI.revertMuteMs(0) + 1), false, '억제에는 시한이 있다');
});

test('반증 M2 — 사람이 대기 중 대상을 바꾸면 시험 대기를 멈춘다 · 같은 대상 대기는 둘이 되지 않는다', async () => {
  TRI._resetTrialForTest();
  const [y, z] = seed([
    { name: 'm2-y', path: 'M2', agent: 'edge-a', tests: [tcp('TCP 22', 22)] },
    { name: 'm2-z', path: 'M2', agent: 'edge-a', tests: [tcp('TCP 22', 22)] },
  ]);
  const t0 = Date.now();
  TRI.startTrial([y.id, z.id], { now: t0, deps: edgeDeps });
  assert.equal(TRI.pendingTrials().length, 2);
  // 사람: 라우트가 하는 일 — cancelTrials 뒤 사용/중지
  assert.equal(TRI.cancelTrials([y.id]), 1);
  S.setEnabledMany({ targets: [y.id], enabled: false }); S.setEnabledMany({ targets: [y.id], enabled: true });
  assert.equal(TR.isMuted('M2', 'm2-y'), false, '사람이 켠 대상의 실패는 알린다');
  const dl = TRI.pendingTrials()[0].deadline;
  TRI.trialTick(dl, { ackAt: () => t0, edgeRows: () => [], sync: okSync });
  assert.equal(S.getTarget(y.id).enabled, true, '사람이 마지막으로 켠 대상을 system 이 끄지 않는다');
  assert.equal(S.getTarget(z.id).enabled, false, '대기를 멈추지 않은 다른 대상은 시한대로 되돌린다');
  // 다른 경로로 꺼진 뒤 다시 시험 — 낡은 대기를 지우고 하나만
  const [w] = seed([{ name: 'm2-w', path: 'M2', agent: 'edge-a', tests: [tcp('TCP 22', 22)] }]);
  TRI.startTrial([w.id], { now: t0, deps: edgeDeps });
  S.setEnabledMany({ targets: [w.id], enabled: false });
  const again = TRI.startTrial([w.id], { now: t0 + 60_000, deps: edgeDeps });
  assert.equal(again.job.items[0].state, 'wait');
  assert.equal(TRI.pendingTrials().filter((p) => p.targetId === w.id).length, 1, '같은 대상 대기는 하나');
  assert.equal(TRI.startTrial([w.id], { now: t0 + 61_000, deps: edgeDeps }).job.items[0].reason, '이미 시험 중입니다(엣지 보고 대기).');
  // 라우트 소스 — 사용/중지 · 대상 수정(주소 · 사용) · 삭제가 대기를 멈춘다
  const route = stripComments(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'routes', 'svcmon', 'trial.js'), 'utf8'));
  assert.match(route, /const cancelled = cancelTrials\(touchedIds\);\s*const r = setEnabledMany/);
  const tree = stripComments(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'routes', 'svcmon', 'tree.js'), 'utf8'));
  assert.equal((tree.match(/cancelTrials\(/g) || []).length, 2, 'PUT /targets/:id · DELETE /targets/:id');
});

test('반증 M3 — 엣지 판정은 이번 시험의 행만(지금 주소 · 기대 점검 이름 · 점검마다 최근 하나)', () => {
  TRI._resetTrialForTest();
  const [w] = seed([{ name: 'm3-w', path: 'M3', agent: 'edge-a', host: '10.0.0.2', tests: [tcp('TCP 22', 22), tcp('TCP 443', 443)] }]);
  const t0 = Date.now();
  TRI.startTrial([w.id], { now: t0, deps: edgeDeps });
  const rows = [
    { path: 'M3', target: 'm3-w', host: '10.0.0.1', test: 'TCP 22', status: 'bad', reply: '옛 주소', measuredAt: t0 + 1000 },   // 옛 스냅샷(옛 주소)
    { path: 'M3', target: 'm3-w', host: '10.0.0.2', test: 'TCP 22', status: 'ok', measuredAt: t0 + 2000 },
    { path: 'M3', target: 'm3-w', host: '10.0.0.2', test: 'TCP 22', status: 'ok', measuredAt: t0 + 3000 },   // 같은 점검 두 행 — 두 번 세지 않는다
    { path: 'M3', target: 'm3-w', host: '10.0.0.2', test: 'Ping', status: 'ok', measuredAt: t0 + 3000 },     // 기대 밖 이름
  ];
  assert.equal(TRI.trialTick(t0 + 4000, { ackAt: () => t0, edgeRows: () => rows, sync: okSync }).judged, 0, 'TCP 443 이 오기 전에는 통과로 단정하지 않는다');
  rows.push({ path: 'M3', target: 'm3-w', host: '10.0.0.2', test: 'TCP 443', status: 'ok', measuredAt: t0 + 5000 });
  assert.equal(TRI.trialTick(t0 + 6000, { ackAt: () => t0, edgeRows: () => rows, sync: okSync }).judged, 1);
  assert.equal(TRI.trialOf(w.id).state, 'pass', '옛 주소의 실패 행에 끌려가지 않는다');
});

test('반증 H1 — 배정 파일을 못 읽는 동안 배정을 다시 굳히지 않는다(다른 엣지 배포분을 지우지 않게) · 엣지 시험은 건너뛴다', () => {
  TRI._resetTrialForTest();
  const [q] = seed([{ name: 'h1-q', path: 'H1', agent: 'edge-a', tests: [tcp('TCP 22', 22)] }]);
  A.setAssignment('edge-a', { byAgent: true }, S.listTargets().filter((x) => x.agent === 'edge-a'), { user: 'adm' });
  A.setAssignment('edge-p', { kind: 'infra', path: 'Site', includeSub: true }, [], { user: 'adm' });
  const FILE = path.join(TMP, 'central-svcmon-assign.json');
  fs.writeFileSync(FILE, '{"agents": {"edge-a": {');
  A._resetAssignCache();
  assert.ok(A.svcmonAssignLoadError());
  const out = AS.syncByAgentAssignments(['edge-a'], 'op');
  assert.equal(out[0].ok, false); assert.match(out[0].reason, /엣지 배정 파일을 읽지 못했습니다/);
  assert.ok(A.svcmonAssignLoadError(), '로드 오류가 그대로 남는다(엣지 pull 은 계속 503 — 배포분 유지)');
  const r = TRI.startTrial([q.id], { deps: { executes: true } });
  assert.equal(r.job.items[0].state, 'skip');
  assert.match(r.job.items[0].reason, /엣지 배정 파일을 읽지 못했습니다/);
  assert.equal(S.getTarget(q.id).enabled, false, '켜지 않는다');
  fs.rmSync(FILE, { force: true });
  for (const f of fs.readdirSync(TMP)) if (f.startsWith('central-svcmon-assign.json.corrupt')) fs.rmSync(path.join(TMP, f), { force: true });
  A._resetAssignCache();
});

/* ── 라우트 ── */
let server; let base; let who = null;
before(async () => {
  const express = (await import('express')).default;
  const { svcmonRouter } = await import('../src/routes/svcmon.js');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = who; next(); });
  app.use('/api/svcmon', svcmonRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api/svcmon`;
});
after(() => { try { server?.close(); } catch { /* */ } });
const ADMIN = { username: 'adm', role: 'admin' };
const OPER = { username: 'op', role: 'operator' };
const VIEWER = { username: 'v', role: 'viewer' };
const SCOPED_OP = { username: 'sop', role: 'operator', scope: { vcenters: ['vc-us-east'] } };
const SCOPED_ADMIN = { username: 'sad', role: 'admin', scope: { vcenters: ['vc-us-east'] } };
const call = async (method, p, user, body) => {
  who = user;
  const r = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch { /* */ }
  return { status: r.status, json };
};

test('라우트 — 사용/중지 · 시험은 canEdit + 전체 범위 · 입력 검증 · 바뀐 대상 반영', async () => {
  TRI._resetTrialForTest();
  const [x] = seed([{ name: 'route-x', tests: [tcp('TCP 22', 22)] }]);
  assert.equal((await call('POST', '/targets/enabled', VIEWER, { targets: [x.id], enabled: true })).status, 403);
  assert.equal((await call('POST', '/targets/enabled', SCOPED_OP, { targets: [x.id], enabled: true })).status, 403, '대상 트리는 전 법인 공용 — 범위 계정은 못 바꾼다');
  assert.equal((await call('POST', '/targets/enabled', OPER, { targets: [x.id] })).status, 400, 'enabled 없음');
  assert.equal((await call('POST', '/targets/enabled', OPER, { enabled: true })).status, 400, '고른 것 없음');
  const ok = await call('POST', '/targets/enabled', OPER, { targets: [x.id], enabled: true });
  assert.equal(ok.status, 200); assert.equal(ok.json.changed, 1);
  assert.equal(S.getTarget(x.id).enabled, true);
  assert.equal((await call('POST', '/trial', SCOPED_OP, { ids: [x.id] })).status, 403);
  assert.equal((await call('POST', '/trial', OPER, { ids: [] })).status, 400);
  const tr = await call('POST', '/trial', OPER, { ids: [x.id] });
  assert.equal(tr.status, 202);
  assert.equal(tr.json.job.items[0].reason, '이미 사용 중입니다.', '이미 켠 대상은 시험하지 않는다(실패해도 끄지 않게)');
  assert.equal((await call('GET', `/trial/${tr.json.job.id}`, VIEWER)).status, 403);
  assert.equal((await call('GET', `/trial/${tr.json.job.id}`, OPER)).status, 200);
  assert.equal((await call('GET', '/trial/nope', OPER)).status, 404);
  const [z] = seed([{ name: 'route-z', tests: [tcp('TCP 22', 22, { enabled: false })] }]);
  const tz = await call('POST', '/trial', OPER, { ids: [z.id] });
  assert.match(tz.json.job.items[0].reason, /켜진 점검이 없습니다/);
  const st = await call('GET', '/state?limit=2000', VIEWER);
  assert.equal(st.json.targets.find((y) => y.id === z.id).trial.state, 'skip', '/state 가 중지된 대상의 최근 시험 결과(건너뜀 사유)를 싣는다');
  assert.equal(st.json.targets.find((y) => y.id === x.id).trial, undefined, '이미 켠 대상의 건너뜀은 표지로 남기지 않는다');
});

test('라우트 — 개요 감시 범위는 관리자(전체 범위)에게만 · 캐시 본문에 섞이지 않는다', async () => {
  const R = await import('../src/routes/svcmon/settingsSync.js');
  R._dashStateForTest({ reset: true });
  const a = await call('GET', '/overview', ADMIN);
  assert.equal(a.status, 200); assert.equal('coverage' in a.json, true);
  const o = await call('GET', '/overview', OPER);
  assert.equal('coverage' in o.json, false, 'operator 에게는 싣지 않는다(카탈로그 게이트와 같은 기준)');
  assert.equal('coverage' in (await call('GET', '/overview', SCOPED_ADMIN)).json, false, '범위 admin 도 싣지 않는다');
  assert.equal(R._dashStateForTest().builds, 1, '같은 캐시를 쓰되 감시 범위는 응답마다 붙인다');
});

test('설정 연동 적용 라우트는 법인 엣지 옵션을 넘긴다 · 추가된 대상 id 를 돌려준다(소스 대조)', () => {
  const src = stripComments(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'routes', 'svcmon', 'settingsSync.js'), 'utf8'));
  assert.match(src, /corpEdge: body\.corpEdge === true/);
  const core = stripComments(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'svcmon', 'settingsSync.js'), 'utf8'));
  assert.match(core, /out\.addedIds = listTargets\(\)\.filter\(\(x\) => x\.batch === batch/);
});
