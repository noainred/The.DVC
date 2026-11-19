// v2.988 — Monitoring 쉬운 등록 후속(잔여 작업): 엣지 시험은 배정 적용(ack) 뒤 결과만 · 엣지 메타의 구분(infra|service) — 수신 화이트리스트 ·
//   알림 억제 · 시험 판정 · 개요 조인 · '법인 폴더로 정리' · '지금 한 번 점검' · 데모 엣지 배정 후보. 설계 docs/design/monitoring-autoreg/README.md §11.8.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'svcmon-easyreg2-'));
process.env.CONFIG_DIR = TMP;
process.env.AUTH_ENABLED = 'true';

const S = await import('../src/svcmon/store.js');
const TRI = await import('../src/svcmon/trial.js');
const TR = await import('../src/svcmon/transitions.js');
const SS = await import('../src/svcmon/settingsSync.js');
const E = await import('../src/central/svcmonEdge.js');
const D = await import('../src/svcmon/dash.js');
const AS = await import('../src/central/svcmonAssignSync.js');
const P = await import('../src/svcmon/poller.js');
const A = await import('../src/central/svcmonAssign.js');
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const tcp = (name, port) => ({ name, type: 'tcp', port, intervalSec: 60 });
function seed(rows) {
  const r = S.bulkAddTargets(rows.map((x) => ({ kind: 'infra', path: 'F', host: '10.0.0.1', enabled: false, ...x })), { dedup: false });
  assert.equal(r.committed, true, JSON.stringify(r.errors));
  S.flushStore();
  const all = S.listTargets();
  return rows.map((x) => all.find((y) => y.name === x.name && (y.kind || 'infra') === (x.kind || 'infra')));
}
const okSync = (agents) => agents.map((agent) => ({ agent, ok: true }));

/* ── 엣지 메타의 구분 ── */
test('엣지 메타 구분 — 아는 값만 받는다(화이트리스트) · 알림 정보 · 엣지 상태 행에 실린다 · 옛 엣지는 빈 값', () => {
  E._resetEdgeCache();
  const now = Date.now();
  const meta = [
    { i: 'a', p: 'P', n: 'svc-x', h: 'h', t: 'HTTP', y: 'http', iv: 60, k: 'service' },
    { i: 'b', p: 'P', n: 'bogus', h: 'h', t: 'TCP', y: 'tcp', iv: 60, k: '<script>' },
    { i: 'c', p: 'P', n: 'old', h: 'h', t: 'TCP', y: 'tcp', iv: 60 },
  ];
  E.ingestReport('edge-k', { snapId: 1, seq: 1, total: 1, rows: ['a', 'b', 'c'].map((i) => ({ i, s: 'ok', r: 'ok', k: 1, a: 0 })), meta }, now);
  const raw = E.getAgentRaw('edge-k');
  assert.equal(raw.meta.get('a').k, 'service');
  assert.equal(raw.meta.get('b').k, '', '모르는 값은 버린다');
  assert.equal(raw.meta.get('c').k, '', '옛 엣지(구분 없음)는 빈 값');
  const items = E.edgeState('edge-k', {}, now).items;
  assert.equal(items.find((x) => x.target === 'svc-x').kind, 'service');
});

test('엣지가 메타에 구분을 싣고 메타 서명 판이 바뀐다(업그레이드한 엣지가 새 메타를 보내게)', () => {
  const [x] = seed([{ name: 'meta-svc', kind: 'service', enabled: true, tests: [tcp('TCP 1', 1)] }]);
  S.flushStore();
  P._setPollerStateForTest({ items: [{ test: x.tests[0], host: x.host, target: x }], res: [] });
  const snap = P.snapshotResults({ withMeta: true });
  assert.equal(snap.meta[0].k, 'service');
  assert.match(snap.metaSig, /^m2:/);
});

test('알림 억제는 구분까지 맞춘다(반증 L1) — 다른 구분의 같은 경로 · 이름 대상 알림은 막지 않는다 · 구분을 모르면 예전처럼 억제', async () => {
  const sent = [];
  TR._resetTransitionsForTest({ send: async (a) => { sent.push(a); } });
  TR._setAlertSettingsForTest({ enabled: true, failCount: 1, scope: 'all' });
  const now = Date.now();
  TR.muteTarget('E', 'dup-n', now + 600_000, 'infra');
  assert.equal(TR.isMuted('E', 'dup-n', now + 1000, 'infra'), true);
  assert.equal(TR.isMuted('E', 'dup-n', now + 1000, 'service'), false);
  assert.equal(TR.isMuted('E', 'dup-n', now + 1000, ''), true, '구분을 모르면(옛 엣지) 어느 구분이든 억제 중이면 억제');
  TR.noteResult({ scope: '', testId: 'svc-1', status: 'bad', streak: 1, at: now + 1000, target: { name: 'dup-n', path: 'E', kind: 'service' }, test: { name: 'HTTP', type: 'http' } });
  TR.noteResult({ scope: '', testId: 'inf-1', status: 'bad', streak: 1, at: now + 1000, target: { name: 'dup-n', path: 'E', kind: 'infra' }, test: { name: 'TCP', type: 'tcp' } });
  await TR.flushAlerts();
  assert.equal(sent.length, 1, '서비스 대상의 실패만 알린다(시험 중인 인프라 대상은 억제)');
  assert.match(sent[0].title, /dup-n › HTTP/);
});

/* ── ack 뒤 판정 ── */
test('엣지 시험은 배정 적용(ack) 뒤 결과만 — ack 전 행(옛 스냅샷)은 세지 않는다 · 구분이 다른 행은 거른다', () => {
  TRI._resetTrialForTest();
  const [x] = seed([{ name: 'ack-x', path: 'A1', agent: 'edge-a', tests: [tcp('TCP 22', 22)] }]);
  const t0 = Date.now();
  TRI.startTrial([x.id], { now: t0, deps: { executes: false, assignments: [], sync: okSync } });
  const rows = [{ path: 'A1', target: 'ack-x', host: '10.0.0.1', kind: 'infra', test: 'TCP 22', status: 'bad', reply: '옛 스냅샷', measuredAt: t0 + 5000 }];
  assert.equal(TRI.trialTick(t0 + 6000, { ackAt: () => 0, edgeRows: () => rows, sync: okSync }).judged, 0, 'ack 가 없으면 기다린다');
  assert.equal(TRI.trialTick(t0 + 6000, { ackAt: () => t0 - 1, edgeRows: () => rows, sync: okSync }).judged, 0, '시작 전 ack 는 이번 배정이 아니다');
  assert.equal(TRI.trialTick(t0 + 40_000, { ackAt: () => t0 + 30_000, edgeRows: () => rows, sync: okSync }).judged, 0, 'ack 보다 (여유 이상) 앞선 측정은 옛 스냅샷');
  rows.push({ path: 'A1', target: 'ack-x', host: '10.0.0.1', kind: 'service', test: 'TCP 22', status: 'bad', reply: '다른 구분', measuredAt: t0 + 35_000 });
  assert.equal(TRI.trialTick(t0 + 40_000, { ackAt: () => t0 + 30_000, edgeRows: () => rows, sync: okSync }).judged, 0, '다른 구분의 행은 세지 않는다');
  rows.push({ path: 'A1', target: 'ack-x', host: '10.0.0.1', kind: '', test: 'TCP 22', status: 'ok', measuredAt: t0 + 36_000 });
  assert.equal(TRI.trialTick(t0 + 40_000, { ackAt: () => t0 + 30_000, edgeRows: () => rows, sync: okSync }).judged, 1, '구분을 모르는 행(옛 엣지)은 거르지 않는다');
  assert.equal(TRI.trialOf(x.id).state, 'pass');
});

test('배정 동기화 결과가 새 sig 를 싣는다(ack 대조 근거)', () => {
  const [y] = seed([{ name: 'sig-y', path: 'S1', agent: 'edge-sig', tests: [tcp('TCP 22', 22)] }]);
  const out = AS.syncByAgentAssignments(['edge-sig'], 'op');
  assert.equal(out[0].ok, true);
  assert.match(out[0].sig, /^[0-9a-f]{16}$/);
  assert.ok(y);
});

/* ── 반증(v2.988) R1 · R2 · R8 — 실제 배정 · ack 경로(ackAt 주입 없이) ── */
// 엣지 pull 흉내 — agent/svcmonConfigPull 과 같은 규칙(적용에 성공한 sig 로 묻고 unchanged 면 ack 하지 않는다) + 라우트(routes/central.js)의 확인 기록.
function edgeSim(agent) {
  let applied = '';
  return (now, { errors = [] } = {}) => {
    const d = A.getAssignmentForAgent(agent, applied);
    if (d.unchanged) { A.noteUnchangedPull(agent, d.sig, now); return 'unchanged'; }
    A.ackAssignment(agent, { sig: d.sig, applied: { added: d.counts.targets, newTests: d.counts.tests }, removed: 0, errors });
    if (!errors.length) applied = d.sig;
    return 'applied';
  };
}
const realTick = (now, rows) => TRI.trialTick(now, { edgeRows: () => rows });

test('반증 R1-a(재현) — 배정이 엣지가 이미 적용한 sig 로 되돌아와도(A→B→A) 변경 없음 pull 확인 뒤 판정한다(시한 거짓 실패 아님)', () => {
  TRI._resetTrialForTest(); A._resetAssignCache();
  const AG = 'edge-r1a';
  const [x] = seed([{ name: 'r1a-x', path: 'R1A', agent: AG, tests: [tcp('TCP 22', 22)] }]);
  const pull = edgeSim(AG);
  AS.syncByAgentAssignments([AG], 'adm'); pull(Date.now());
  const t1 = Date.now();
  TRI.startTrial([x.id], { now: t1, deps: { executes: false } });
  pull(t1 + 1000);   // S1 적용 · ack
  const ack1 = A.listAssignments().find((a) => a.agent === AG).ack.at;
  realTick(Math.max(ack1, t1) + 5000, [{ path: 'R1A', target: 'r1a-x', host: '10.0.0.1', kind: 'infra', test: 'TCP 22', status: 'bad', reply: 'refused', measuredAt: Math.max(ack1, t1) + 2000 }]);
  assert.equal(TRI.trialOf(x.id).state, 'fail', '1차 실패 → 되돌림(S0)');
  const t2 = Math.max(ack1, t1) + 60_000;
  TRI.startTrial([x.id], { now: t2, deps: { executes: false } });   // 엣지는 아직 S0 을 당기지 않았다 → 배정이 다시 S1
  assert.equal(pull(t2 + 10_000), 'unchanged', '엣지는 S1 을 그대로 갖고 있다 — ack 하지 않는다');
  const ok = [{ path: 'R1A', target: 'r1a-x', host: '10.0.0.1', kind: 'infra', test: 'TCP 22', status: 'ok', measuredAt: t2 + 30_000 }];
  assert.equal(realTick(t2 + 40_000, ok).judged, 1, '확인 뒤 잰 행으로 판정');
  assert.equal(TRI.trialOf(x.id).state, 'pass');
  assert.equal(S.getTarget(x.id).enabled, true);
});

test('반증 R1-a — 오류 ack 만 있던 sig 의 변경 없음 pull 은 확인이 아니다(검증 거부 sig 로도 묻는다)', () => {
  A._resetAssignCache();
  const AG = 'edge-r1err';
  seed([{ name: 'r1e-x', path: 'R1E', agent: AG, tests: [tcp('TCP 22', 22)] }]);
  const sig = AS.syncByAgentAssignments([AG], 'adm')[0].sig;
  A.ackAssignment(AG, { sig, applied: { added: 0, newTests: 0 }, errors: ['검증 거부'] });
  assert.equal(A.noteUnchangedPull(AG, sig, Date.now()), false);
  assert.equal(A.assignReadiness(AG).confirmAt, 0);
});

test('반증 R1-b(재현) — 배정에 이미 켜진 채 실린 대상(sig 가 그대로 · ack 가 시작 전)은 시작 이후 행으로 곧바로 판정한다', () => {
  TRI._resetTrialForTest(); A._resetAssignCache();
  const AG = 'edge-r1b';
  const [x] = seed([{ name: 'r1b-x', path: 'R1B', agent: AG, enabled: true, tests: [tcp('TCP 22', 22)] }]);
  const pull = edgeSim(AG);
  AS.syncByAgentAssignments([AG], 'adm'); pull(Date.now());
  S.updateTarget(x.id, { enabled: false });   // PUT /targets/:id 처럼 배정을 다시 굳히지 않고 끔 — 엣지 스냅샷에는 켜져 있다
  S.flushStore();
  const t0 = Date.now() + 1000;
  TRI.startTrial([x.id], { now: t0, deps: { executes: false } });
  assert.ok(TRI.pendingTrials()[0].sig, '대기에 이번 시험이 굳힌 sig 를 남긴다');
  const rows = [{ path: 'R1B', target: 'r1b-x', host: '10.0.0.1', kind: 'infra', test: 'TCP 22', status: 'ok', measuredAt: t0 + 20_000 }];
  assert.equal(realTick(t0 + 30_000, rows).judged, 1);
  assert.equal(TRI.trialOf(x.id).state, 'pass');
});

test('반증 R6 — ack 보다 앞선 측정(옛 스냅샷)은 여유 없이 거른다', () => {
  const p = { sig: 'S2', startedAt: 1000 };
  assert.equal(TRI.readyAtFor(p, { sig: 'S2', ackAt: 5000, confirmAt: 0 }), 5000);
  assert.equal(TRI.readyAtFor(p, { sig: 'S2', ackAt: 500, confirmAt: 0 }), 1000, '같은 sig · 시작 전 ack = 이미 이 정의로 재는 중');
  assert.equal(TRI.readyAtFor(p, { sig: 'S3', ackAt: 500, confirmAt: 0 }), 0, '다른 sig 의 옛 ack 는 기다린다');
  assert.equal(TRI.readyAtFor(p, { sig: 'S3', ackAt: 0, confirmAt: 7000 }), 7000);
  assert.equal(TRI.readyAtFor(p, null), 0);
});

test('반증 R2(재현) — v2.960 대기 파일(구분 없음)은 대상의 구분으로 채운다', () => {
  const [x] = seed([{ name: 'r2-svc', kind: 'service', path: 'R2', agent: 'edge-r2', tests: [tcp('TCP 80', 80)] }]);
  fs.writeFileSync(path.join(TMP, 'svcmon-trial.json'), JSON.stringify({ v: 1, pending: [{ targetId: x.id, jobId: 'j', agent: 'edge-r2', path: 'R2', name: 'r2-svc', host: '10.0.0.1', startedAt: Date.now(), deadline: Date.now() + 600_000, expect: ['TCP 80'] }] }));
  TRI._resetTrialForTest({ reload: true });
  assert.equal(TRI.pendingTrials()[0].kind, 'service');
  TRI._resetTrialForTest();
  fs.rmSync(path.join(TMP, 'svcmon-trial.json'), { force: true });
});

test('반증 R8 — 데모 엣지(보고하지 않는 엣지)는 실행 역할이면 이 포탈이 대신 시험한다', () => {
  const tg = { id: 'd1', name: 'd1', path: 'D', host: 'h', kind: 'infra', enabled: false, agent: 'mock-Edge-Seoul', tests: [{ id: 'x', name: 'TCP', type: 'tcp', enabled: true }] };
  const p1 = TRI.planTrial([tg], { executes: true, assignments: [], localAgents: new Set(['mock-Edge-Seoul']) });
  assert.equal(p1.local.length, 1); assert.equal(p1.edge.length, 0);
  assert.equal(TRI.planTrial([tg], { executes: true, assignments: [] }).edge.length, 1, '실환경 엣지는 그대로 엣지 시험');
});

/* ── 개요 조인 ── */
test('개요 조인 — 엣지가 구분을 실으면 같은 구분의 대상에만 붙는다(옛 엣지는 경로 · 이름)', () => {
  const targets = [
    { id: 'gi', kind: 'infra', path: 'J', name: 'same', host: 'h', tests: [], origin: { kind: 'set:idrac' } },
    { id: 'gs', kind: 'service', path: 'J', name: 'same', host: 'h', tests: [] },
  ];
  const d = D.buildDash({ targets, edgeStates: [{ agent: 'e', items: [
    { state: 'bad', path: 'J', target: 'same', test: 't1', type: 'tcp', kind: 'infra' },
    { state: 'ok', path: 'J', target: 'same', test: 't2', type: 'http', kind: 'service' },
  ] }], executes: false });
  const hx = (id) => d.hexes.find((h) => h.id === id);
  assert.equal(hx('gi').state, 'bad');
  assert.equal(hx('gs').state, 'ok', '서비스 대상이 인프라 행의 실패를 떠안지 않는다');
});

/* ── 법인 폴더로 정리 ── */
const ctx = { dcNames: new Map([['dc-fra', 'Frankfurt 법인']]), dcByName: new Map([['dc-fra', 'dc-fra']]) };
test('법인 폴더로 정리 — 설정 연동이 놓은 자리(등록 때 법인)에 그대로 있는 대상만 · 사람이 옮긴 대상 · 경로 기준 엣지 대상은 건너뜀', () => {
  const built = { targets: [
    { id: 'set:sanswitch-ssh|s1', kind: 'set:sanswitch-ssh', ref: 's1', name: 'SAN-1', host: '10.1.1.1', port: 22, facts: { datacenterId: 'dc-fra' } },
    { id: 'set:sanswitch-ssh|s2', kind: 'set:sanswitch-ssh', ref: 's2', name: 'SAN-2', host: '10.1.1.2', port: 22, facts: { datacenterId: 'dc-fra' } },
    { id: 'set:sanswitch-ssh|s3', kind: 'set:sanswitch-ssh', ref: 's3', name: 'SAN-3', host: '10.1.1.3', port: 22, facts: { datacenterId: 'dc-fra' } },
  ] };
  const old = '설정 연동\\네트워크\\전역';
  const svc = [
    { id: 't1', kind: 'infra', path: old, name: 'SAN-1', host: '10.1.1.1', enabled: true, tests: [], origin: { key: 'set:sanswitch-ssh|s1', kind: 'set:sanswitch-ssh', corp: '전역', port: 22 } },
    { id: 't2', kind: 'infra', path: '사람이 옮김', name: 'SAN-2', host: '10.1.1.2', enabled: true, tests: [], origin: { key: 'set:sanswitch-ssh|s2', kind: 'set:sanswitch-ssh', corp: '전역', port: 22 } },
    { id: 't3', kind: 'infra', path: old, name: 'SAN-3', host: '10.1.1.3', enabled: true, tests: [], origin: { key: 'set:sanswitch-ssh|s3', kind: 'set:sanswitch-ssh', corp: '전역', port: 22 } },
  ];
  const res = SS.classifyCatalog(built, svc, { ctx });
  const row = (k) => res.rows.find((r) => r.key === k);
  assert.equal(row('set:sanswitch-ssh|s1').repath, '설정 연동\\네트워크\\Frankfurt 법인');
  assert.equal(row('set:sanswitch-ssh|s1').state, 'linked', '상태는 그대로(배너 · 드리프트를 흔들지 않는다)');
  assert.equal(row('set:sanswitch-ssh|s2').repath, undefined, '사람이 옮긴 대상은 건드리지 않는다');
  assert.equal(res.counts.repath, 2);
  const edgeOf = (x) => (x.path.startsWith('설정 연동\\네트워크\\Frankfurt') && x.name === 'SAN-3' ? { agent: 'edge-fra', mode: 'path' } : { agent: '', mode: '' });
  const plan = SS.planRepath(res.rows, ['set:sanswitch-ssh|s1', 'set:sanswitch-ssh|s2', 'set:sanswitch-ssh|s3'], { svcTargets: svc, edgeOf });
  assert.deepEqual(plan.move.map((m) => m.targetId), ['t1']);
  assert.match(plan.skip.find((s) => s.key === 'set:sanswitch-ssh|s3').reason, /경로 기준 배정 엣지\(edge-fra\)/, '옮긴 뒤 경로 기준 배정에 들어가는 대상도 건너뜀');
  assert.match(plan.skip.find((s) => s.key === 'set:sanswitch-ssh|s2').reason, /옮길 경로가 없습니다/);
  assert.match(SS.planRepath(res.rows, ['set:sanswitch-ssh|s1'], { svcTargets: svc, edgeOf, assignUnreadable: true }).skip[0].reason, /엣지 배정 파일을 읽지 못했습니다/);
});

test('반증 R3 · R4 · R5(재현) — 법인을 모르거나 등록부를 못 읽으면 제안하지 않는다 · 옮길 폴더 이름 충돌 · 그사이 사람이 옮긴 대상은 건너뜀', () => {
  const old = '설정 연동\\네트워크\\전역';
  const fra = '설정 연동\\네트워크\\Frankfurt 법인';
  const built = { targets: [
    { id: 'set:sanswitch-ssh|a', kind: 'set:sanswitch-ssh', ref: 'a', name: 'SW-A', host: '10.2.1.1', port: 22, facts: { datacenterId: 'dc-fra' } },
    { id: 'set:sanswitch-ssh|b', kind: 'set:sanswitch-ssh', ref: 'b', name: 'SW-B', host: '10.2.1.2', port: 22, facts: { datacenterId: 'dc-fra' } },
    { id: 'set:sanswitch-ssh|c', kind: 'set:sanswitch-ssh', ref: 'c', name: 'SW-C', host: '10.2.1.3', port: 22, facts: { datacenterId: 'dc-fra' } },
  ] };
  const o = (k, corp) => ({ key: `set:sanswitch-ssh|${k}`, kind: 'set:sanswitch-ssh', corp, port: 22 });
  const svc = [
    { id: 'a1', kind: 'infra', path: old, name: 'SW-A', host: '10.2.1.1', enabled: true, tests: [], origin: o('a', '전역') },
    { id: 'b1', kind: 'infra', path: old, name: 'SW-B', host: '10.2.1.2', enabled: true, tests: [], origin: o('b', '전역') },
    { id: 'b2', kind: 'infra', path: fra, name: 'sw-b', host: '10.9.9.9', enabled: true, tests: [] },   // 목적 폴더에 같은 이름(대소문자만 다름)
    { id: 'c1', kind: 'infra', path: fra, name: 'SW-C', host: '10.2.1.3', enabled: true, tests: [], origin: o('c', 'Frankfurt 법인') },
  ];
  // R3: 등록부 손상 · 법인 미상이면 이미 정리된 대상(c1)을 '전역' 으로 되돌리자고 하지 않는다
  assert.equal(SS.classifyCatalog(built, svc, { ctx: { ...ctx, corpUnreadable: true } }).counts.repath, 0);
  assert.equal(SS.classifyCatalog(built, svc, { ctx: {} }).counts.repath, 0, '법인을 모르면(corpKey 없음) 제안하지 않는다');
  const res = SS.classifyCatalog(built, svc, { ctx });
  assert.equal(res.counts.repath, 2);
  const plan = SS.planRepath(res.rows, ['set:sanswitch-ssh|a', 'set:sanswitch-ssh|b'], { svcTargets: svc, edgeOf: () => ({ agent: '', mode: '' }) });
  assert.deepEqual(plan.move.map((m) => m.targetId), ['a1']);
  assert.match(plan.skip[0].reason, /같은 이름의 대상이 이미 있습니다/, 'R4: 겹치면 엣지가 한쪽을 건너뛴다');
  // R5: 분류 뒤 사람이 옮겼다
  const moved = svc.map((x) => (x.id === 'a1' ? { ...x, path: '사람이 고른 폴더' } : x));
  assert.match(SS.planRepath(res.rows, ['set:sanswitch-ssh|a'], { svcTargets: moved, edgeOf: () => ({ agent: '', mode: '' }) }).skip[0].reason, /그사이 다른 폴더로 옮겨졌습니다/);
});

test('반증 R7(재현) — 주소 변경 적용은 출처 법인(놓인 자리)을 덮지 않는다 → 다음 분류에서 정리 후보로 남는다', () => {
  const old = '설정 연동\\네트워크\\전역';
  const r0 = S.bulkAddTargets([{ kind: 'infra', path: old, name: 'sw-r7', host: '10.3.1.1', enabled: true, tests: [], origin: { key: 'set:sanswitch-ssh|r7', kind: 'set:sanswitch-ssh', corp: '전역', port: 22 } }], { dedup: false, trustedOrigin: true });
  assert.equal(r0.committed, true);
  S.flushStore();
  const builtNew = { targets: [{ id: 'set:sanswitch-ssh|r7', kind: 'set:sanswitch-ssh', ref: 'r7', name: 'sw-r7', host: '10.3.1.2', port: 22, facts: { datacenterId: 'dc-fra' } }] };
  const mine = () => S.listTargets().filter((x) => x.origin?.key === 'set:sanswitch-ssh|r7');
  const c1 = SS.classifyCatalog(builtNew, mine(), { ctx });
  assert.equal(c1.rows[0].state, 'changed');
  SS.executePlan(SS.planApply(c1.rows, ['set:sanswitch-ssh|r7'], { builtByKey: new Map([['set:sanswitch-ssh|r7', builtNew.targets[0]]]) }), { user: 'adm' });
  assert.equal(mine()[0].origin.corp, '전역');
  assert.equal(SS.classifyCatalog(builtNew, mine(), { ctx }).rows[0].repath, '설정 연동\\네트워크\\Frankfurt 법인');
});

test('법인 폴더로 정리 실행 — 경로 · 출처 법인만 바꾸고 대상 · 점검 id 는 그대로', () => {
  const [z] = seed([{ name: 'repath-z', path: '설정 연동\\서버\\전역', enabled: true, tests: [tcp('TCP 443', 443)] }]);
  const r = SS.executeRepath({ move: [{ key: 'k', name: 'repath-z', targetId: z.id, from: z.path, to: '설정 연동\\서버\\Frankfurt 법인', corp: 'Frankfurt 법인', agent: '' }] });
  assert.equal(r.moved.length, 1);
  const cur = S.getTarget(z.id);
  assert.equal(cur.path, '설정 연동\\서버\\Frankfurt 법인');
  assert.equal(cur.tests[0].id, z.tests[0].id, '점검 id 승계(연속 횟수 · 만기 유지)');
  assert.ok(S.listFolders().some((f) => f.path === '설정 연동\\서버\\Frankfurt 법인'), '폴더가 생긴다');
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
const SCOPED_ADMIN = { username: 'sad', role: 'admin', scope: { vcenters: ['vc-x'] } };
const call = async (method, p, user, body) => {
  who = user;
  const r = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch { /* */ }
  return { status: r.status, json };
};

test('라우트 — 지금 한 번 점검: canEdit + 전체 범위 · 결과만 돌려주고 폴러 결과에 넣지 않는다 · 없는 점검 404', async () => {
  const r0 = S.bulkAddTargets([{ kind: 'infra', path: 'Run', name: 'run-demo', host: '10.9.9.9', enabled: false, tests: [tcp('TCP 22', 22)] }], { dedup: false, batch: 'mock-demo' });
  assert.equal(r0.committed, true);
  const x = S.listTargets().find((y) => y.name === 'run-demo');
  const url = `/targets/${x.id}/tests/${x.tests[0].id}/run`;
  assert.equal((await call('POST', url, VIEWER)).status, 403);
  assert.equal((await call('POST', url, { ...OPER, scope: { vcenters: ['vc-x'] } })).status, 403);
  const ok = await call('POST', url, OPER);
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.ok(['ok', 'warn', 'bad'].includes(ok.json.result.status), '데모 대상은 합성 결과(네트워크 없음)');
  assert.equal(P.getResults().has(x.tests[0].id), false, '폴러 결과에 넣지 않는다');
  assert.equal((await call('POST', `/targets/${x.id}/tests/nope/run`, OPER)).status, 404);
});

test('라우트 — 법인 폴더로 정리는 관리자(전체 범위)만 · 미리보기는 저장하지 않는다', async () => {
  assert.equal((await call('POST', '/settings-sync/repath', OPER, { keys: ['x'] })).status, 403);
  assert.equal((await call('POST', '/settings-sync/repath', SCOPED_ADMIN, { keys: ['x'] })).status, 403);
  assert.equal((await call('POST', '/settings-sync/repath', ADMIN, { keys: [] })).status, 400);
  const pv = await call('POST', '/settings-sync/repath', ADMIN, { keys: ['set:nope|1'] });
  assert.equal(pv.status, 200);
  assert.equal(pv.json.preview.move.length, 0);
  assert.equal(pv.json.preview.skip.length, 1);
});

test('데모(mock)에서만 데모 엣지가 배정 후보 — live 에서는 넣지 않는다(소스 대조)', async () => {
  const { stripComments } = await import('./_stripComments.js');
  const src = stripComments(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'svcmon', 'settingsSync.js'), 'utf8'));
  assert.match(src, /if \(isMockMode\(\)\) for \(const e of \(await import\('\.\.\/mock\/demo\/edge\.js'\)\)\.demoEdgeList\(\)\)/);
});
