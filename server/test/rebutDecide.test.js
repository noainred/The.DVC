// 결정 권장안 구현 반증(적대적 재검토) — G1a(서버 보안) 확정분 회귀.
//  R1  64 F7: 서명 시각 창(±10분) 밖으로만 거부된 script · ssh 항목은 assignKey 가 중앙과 같아 다시 내려오지 않았다 — 시계를 맞춰도
//      재시작 전까지 영원히 멈췄다(보류에 시한 없음). SKEW_MS 뒤 첫 폴에서 한 번 다시 받는다(서명 없음 · 불일치는 중앙 지문이 바뀔 때만).
//  R2  64 F2: 자동 되돌림을 포기한(revertGaveUp) 뒤 확정 · 새 적용 거절 문구가 '곧 되돌립니다' · '확정하거나' 로 사실과 달랐다.
//  R3  66 ①: 표시 이름이 겹친 담당 엣지의 iLO 전용 대역은 '엣지 버전 미상(중앙 재시작 직후이거나 미등록)' 으로 보류돼 진짜 사유(이름 겹침)가 보이지 않았다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'rebut-decide-'));
process.env.CONFIG_DIR = CFG;
process.env.PORT = '4000';
process.env.AGENT_NAME = 'edge-rebut';
process.env.RMA_ALLOW_CUSTOM = 'true';
delete process.env.RMA_PASSWORD;

const SG = await import('../src/rma/signing.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

after(() => { try { fs.rmSync(CFG, { recursive: true, force: true }); } catch { /* */ } });

// ── R1 ──────────────────────────────────────────────────────────────────────
test('R1 64 F7 — 시각 창 밖으로만 거부된 항목은 SKEW_MS 뒤 첫 폴에서 다시 받는다(영원히 멈추지 않는다) · 다시 받은 새 서명이면 실행 가능', async () => {
  const A = await import('../src/rma/agent.js');
  const now = Date.now();
  const item = (id) => ({ id, test: 'script', args: { command: 'true', timeoutMs: 5000 }, intervalSec: 60, enabled: true });
  // 엣지 시계가 중앙보다 20분 앞섰다 — 서명(HMAC)은 맞고 시각만 창 밖
  const skewed = SG.signScheduleTests('pw-edge', 'edge-rebut', [item('w1')], now - 20 * 60_000)[0];
  A.applySchedule({ version: 3, assignKey: 'k3', tests: [skewed] }, { password: 'pw-edge', now });
  assert.match(A._scheduleForTest().tests[0].sigIssue, /허용 오차/);
  assert.match(A._scheduleForTest().tests[0].sigIssue, /10분 안에/, '사유가 다시 받는 시점을 사실대로 말한다');
  assert.equal(A.scheduleAssignKeyForPoll(now), 'k3', '곧바로 재요청하지는 않는다(폴마다 전량 재전송 금지)');
  assert.equal(A.scheduleAssignKeyForPoll(now + SG.SKEW_MS), '', 'SKEW_MS 뒤에는 assignKey 를 비워 중앙이 새 서명으로 다시 내려보낸다(예전: 영원히 k3)');
  // 시계를 맞춘 뒤 중앙이 다시 내려보낸 사본 — 판정이 풀리고 재요청 표지도 지운다
  const fresh = SG.signScheduleTests('pw-edge', 'edge-rebut', [item('w1')], now + SG.SKEW_MS)[0];
  A.applySchedule({ version: 3, assignKey: 'k3', tests: [fresh] }, { password: 'pw-edge', now: now + SG.SKEW_MS + 1000 });
  assert.equal(A._scheduleForTest().tests[0].sigIssue, undefined);
  assert.equal(A.scheduleAssignKeyForPoll(now + 10 * SG.SKEW_MS), 'k3', '풀린 뒤에는 재요청하지 않는다');
  // 서명 불일치 · 서명 없음은 시간으로 풀리지 않는다 — 주기 재요청을 걸지 않는다(중앙 비밀번호를 고치면 :k 지문이 바뀌어 다시 내려간다)
  const wrong = SG.signScheduleTests('other-pw', 'edge-rebut', [item('w2')], now)[0];
  A.applySchedule({ version: 4, assignKey: 'k4', tests: [wrong, item('w3')] }, { password: 'pw-edge', now });
  assert.ok(A._scheduleForTest().tests.every((t) => t.sigIssue));
  assert.equal(A.scheduleAssignKeyForPoll(now + 10 * SG.SKEW_MS), 'k4');
});

// ── R2 ──────────────────────────────────────────────────────────────────────
const LIST_ALL = 'public (active)\n  target: default\n  services: ssh\n  ports: 4000/tcp 22/tcp\n  rich rules:\n';
function fakeFw(st) {
  return async (args) => {
    if (args[0] === '--state') return { ok: true, code: 0, stdout: 'running\n', stderr: '' };
    if (args[0] === '--get-default-zone') return { ok: true, code: 0, stdout: 'public\n', stderr: '' };
    if (args.includes('--list-all')) return { ok: true, code: 0, stdout: LIST_ALL, stderr: '' };
    if (args[0] === '--reload') { st.reloads++; return st.failReload > 0 ? (st.failReload--, { ok: false, code: 1, stdout: '', stderr: 'Error: COMMAND_FAILED' }) : { ok: true, code: 0, stdout: 'success', stderr: '' }; }
    return { ok: true, code: 0, stdout: 'success', stderr: '' };
  };
}
test('R2 64 F2 — 자동 되돌림을 포기한 뒤의 확정 · 새 적용 거절은 수동 조치 필요를 말한다(곧 되돌립니다 · 확정하거나 금지)', async () => {
  const S = await import('../src/hostaccess/service.js');
  const St = await import('../src/hostaccess/settings.js');
  St._resetHostAccessCache(); St.saveHostAccess({ pending: null, applied: null });
  const st = { reloads: 0, failReload: 1e9 };
  S._setExec({ fw: fakeFw(st), sshdCtl: async () => ({ ok: true }), sshdActive: async () => true, isSudoDenied: () => false });
  S._setRevertRetryMinMs(20); S._setRevertRetryWindowMs(150);
  try {
    assert.equal((await S.applyHostAccess({ ssh: { mode: 'deny' }, confirmMinutes: 1 }, { requesterIp: '10.1.1.1', by: 't' })).ok, true);
    // 포기 전(기한 안): 예전 문구 그대로
    const before = await S.applyHostAccess({ ssh: { mode: 'deny' }, confirmMinutes: 1 }, { requesterIp: '10.1.1.1', by: 't' });
    assert.match(before.errors.join(' '), /먼저 확정하거나 되돌리세요/);
    St.saveHostAccess({ pending: { ...St.loadHostAccess().pending, deadline: Date.now() + 10 } });
    await S.resumeHostAccessPending();
    for (let k = 0; k < 80 && St.loadHostAccess().pending?.revertGaveUp !== true; k++) await sleep(25);
    assert.equal(St.loadHostAccess().pending?.revertGaveUp, true);
    const c = await S.confirmHostAccess({ by: 'admin' });
    assert.equal(c.ok, false);
    assert.match(c.errors.join(' '), /수동 조치 필요/);
    assert.doesNotMatch(c.errors.join(' '), /곧 되돌립니다/, '자동 재시도를 멈췄는데 곧 되돌린다고 말했다');
    const a = await S.applyHostAccess({ ssh: { mode: 'deny' }, confirmMinutes: 1 }, { requesterIp: '10.1.1.1', by: 't' });
    assert.equal(a.ok, false);
    assert.match(a.errors.join(' '), /수동 조치 필요/);
    assert.doesNotMatch(a.errors.join(' '), /확정하거나/, '기한이 지나 확정할 수 없는데 확정하라고 했다');
    st.failReload = 0;
    assert.equal((await S.revertHostAccess({ by: 'admin' })).ok, true, '수동 되돌림으로 풀린다');
  } finally { S._setRevertRetryMinMs(); S._setRevertRetryWindowMs(); S._setExec(null); St.saveHostAccess({ pending: null, applied: null }); }
});

// ── R3 ──────────────────────────────────────────────────────────────────────
test('R3 66 ① — 표시 이름이 겹친 담당 엣지의 iLO 전용 대역 보류 사유는 이름 겹침을 말한다(재시작 직후 · 미등록 추측 금지)', async () => {
  const reg = await import('../src/collector/registry.js');
  const P = await import('../src/central/idracScanPush.js');
  for (const r of [
    { id: 'rb-a', name: 'rb-dup', url: 'https://10.9.2.21:3443', token: 'TOK-A', enabled: true },
    { id: 'rb-b', name: 'RB-DUP', url: 'https://10.9.2.22:3443', token: 'TOK-B', enabled: true },
  ]) { const x = reg.addCollector(r, { managed: true }); assert.ok(x && x.ok !== false, JSON.stringify(x)); }
  assert.equal(P.edgeVersionOf('rb-dup'), '', '겹친 이름 — 버전을 모른다');
  const why = P.collectorAmbiguityReason('rb-dup');
  assert.match(why, /2개라 어느 엣지인지 정할 수 없습니다/);
  assert.equal(P.collectorAmbiguityReason('rb-a'), '', 'id 로 지정하면 겹침이 아니다');
  const g = P.iloEdgeGate({ hasIlo: true, hasDell: false, version: P.edgeVersionOf('rb-dup'), unknownWhy: why });
  assert.equal(g.delegate, false, '버전을 모르면 iLO 전용 대역은 여전히 보류(안전 쪽)');
  assert.match(g.reason, /2개라 어느 엣지인지 정할 수 없습니다/);
  assert.doesNotMatch(g.reason, /중앙 재시작 직후/, '진짜 사유를 추측 문구로 덮었다');
  // 이름 겹침이 아닌 미상(예전 문구 그대로)
  assert.match(P.iloEdgeGate({ hasIlo: true, hasDell: false, version: '' }).reason, /중앙 재시작 직후/);
  // 기동 주기 스캔 경로(scanPoller)가 이 사유를 넘기는가 — 소스 고정(주석 제거 후)
  const { stripComments } = await import('./_stripComments.js');
  const src = stripComments(fs.readFileSync(new URL('../src/idrac/scanPoller.js', import.meta.url), 'utf8'));
  assert.match(src, /iloEdgeGate\(\{[^}]*unknownWhy:\s*collectorAmbiguityReason\(e\.agent\)/);
});
