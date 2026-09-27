/**
 * v2.630 감사 그룹 d — 위임 잡·엣지 수신의 '종결·시각·상태' 정합.
 *
 * A4-01: iDRAC 위임 스캔 잡이 재인출 소진·개별 취소·전체 중지로 닫혀도 스캔 대역 '최근 결과' 가 pending 으로 남던 것.
 * A4-02: 엣지 push 의 collectedAt 을 수신 시각으로 clamp 한 값만 남아, 엣지 시계가 빠르면 옛 스냅샷 재전송이 위임
 *        '지금 수집' 요청을 완료 처리하던 것 — 원본 엣지 시각(edgeCollectedAt)을 따로 싣고, 큐 완료 판정은 그 값으로 한다.
 * A4-03: RMA 명령이 기한 초과 '미회신' 으로 종결된 뒤 도착한 실제 결과를 받는다(late — 재실행 유도 방지, 재실행은 하지 않는다).
 * A4-04: central-svcmon-assign.json 의 pulledAt·ack·state 가 백업 지문에 잡히지 않는다(설정 변경은 여전히 잡힌다).
 * R2630-06: '기동 후 보고 없음' 유예가 그 엣지의 push 주기(배정 기록에 영속한 lastExpectMs)를 쓴다.
 * UI2630-03: 배정만 있고 보고 없는 엣지가 카드 요약(edgeSummaryWithAssigned)에 noReport 행으로 나온다.
 *
 * 기준 시각은 Date.now() 를 쓰지 않고 고정한다(CLAUDE.md v2.517 규약).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2630d-'));
process.env.SVCMON_WORKERS = '0';
process.env.SVCMON_SILENCE_ALERT = 'false';

const T0 = 1_900_000_000_000 - 30 * 60_000;

/* ── A4-01 ── */
const sr = await import('../src/idrac/scanRanges.js');
const jobs = await import('../src/central/idracScanJobs.js');
const lastRunOf = (id) => sr.listScanRanges().find((e) => e.id === id)?.lastRun;

function pendingJob(_label, ip) {
  const saved = sr.saveScanRanges({ datacenterId: 'dc1', ranges: [ip], agent: 'edgeA' });
  assert.equal(saved.ok, true);
  const rangeId = saved.id;
  const rid = jobs.enqueueIdracScan('edgeA', { ips: ip, username: 'u', password: 'p', datacenterId: 'dc1', trigger: 'periodic', rangeId });
  sr.recordScanRangeRun(rangeId, { delegated: true, agent: 'edgeA', reqId: rid, dispatch: 'poll', dispatchedAt: T0, pending: true });
  assert.equal(lastRunOf(rangeId)?.pending, true);
  return { rid, rangeId };
}

test('A4-01 — 재인출 소진으로 오류 종결된 잡은 대역 최근 결과의 pending 을 닫는다', () => {
  const { rid, rangeId } = pendingJob('r-reap', '10.0.0.1');
  let t = Date.now();
  for (let i = 0; i < 3; i++) { jobs.takeIdracScanJobs('edgeA'); t += 10 * 60_000; jobs.reapClaims(t); }
  assert.equal(jobs.getIdracScanResult(rid).state, 'error');
  const lr = lastRunOf(rangeId);
  assert.equal(lr.pending, false);
  assert.equal(lr.ok, false);
  assert.match(String(lr.error), /확인 응답/);
});

test('A4-01 — 개별 취소와 전체 중지도 대역 pending 을 닫는다', () => {
  const a = pendingJob('r-cancel', '10.0.0.2');
  assert.equal(jobs.cancelIdracScanJob(a.rid).ok, true);
  assert.equal(lastRunOf(a.rangeId).pending, false);
  assert.match(String(lastRunOf(a.rangeId).error), /취소/);

  const b = pendingJob('r-stop', '10.0.0.3');
  assert.ok(jobs.cancelPendingIdracScanJobs() >= 1);
  assert.equal(lastRunOf(b.rangeId).pending, false);
  assert.match(String(lastRunOf(b.rangeId).error), /중지/);
});

/* ── A4-02 ── */
const { stampEdgeCollectedAt, EDGE_CLOCK_AHEAD_TOLERANCE_MS } = await import('../src/routes/central.js');
const { createCollectRequestQueue } = await import('../src/util/collectRequestQueue.js');

test('A4-02 — stampEdgeCollectedAt: 표시용은 clamp, 원본 엣지 시각은 따로, 시계 빠름은 밝힌다', () => {
  const now = T0;
  const ahead = stampEdgeCollectedAt({ deviceId: 'd1', collectedAt: now + 10 * 60_000 }, now);
  assert.equal(ahead.collectedAt, now);
  assert.equal(ahead.edgeCollectedAt, now + 10 * 60_000);
  assert.equal(ahead.edgeClockAheadMs, 10 * 60_000);

  const past = stampEdgeCollectedAt({ deviceId: 'd1', collectedAt: now - 5_000, edgeClockAheadMs: 999 }, now);
  assert.equal(past.collectedAt, now - 5_000);
  assert.equal(past.edgeCollectedAt, now - 5_000);
  assert.equal('edgeClockAheadMs' in past, false, '엣지가 보낸 값을 믿지 않는다');

  const tiny = stampEdgeCollectedAt({ collectedAt: now + EDGE_CLOCK_AHEAD_TOLERANCE_MS - 1 }, now);
  assert.equal('edgeClockAheadMs' in tiny, false);

  const bad = stampEdgeCollectedAt({ collectedAt: 'x' }, now);
  assert.equal(bad.collectedAt, now);
  assert.equal(bad.edgeCollectedAt, null);
  assert.equal(stampEdgeCollectedAt(null, now), null);
});

test('A4-02 — 큐 완료 판정에 원본 엣지 시각을 쓰면 옛 스냅샷 재전송이 요청을 끝내지 않는다', () => {
  const SKEW = 10 * 60_000;
  let c = T0;
  const snapEdgeTs = c + SKEW;                 // 엣지가 c(중앙 시계)에 수집 — 엣지 시계로는 c+10분
  const q = createCollectRequestQueue();
  q.ack('dev1', stampEdgeCollectedAt({ collectedAt: snapEdgeTs }, c).edgeCollectedAt);
  c += 30_000; q.request('dev1', 'edgeA', c); q.take('edgeA', c, 20);
  c += 60_000;
  const stale = stampEdgeCollectedAt({ collectedAt: snapEdgeTs }, c);
  assert.equal(q.ack('dev1', stale.edgeCollectedAt), false, '같은 옛 스냅샷은 완료가 아니다');
  // 대조: clamp 값으로 판정하면 예전 결함이 재현된다.
  const q2 = createCollectRequestQueue();
  let d = T0;
  q2.ack('dev1', stampEdgeCollectedAt({ collectedAt: snapEdgeTs }, d).collectedAt);
  d += 30_000; q2.request('dev1', 'edgeA', d); q2.take('edgeA', d, 20);
  d += 60_000;
  assert.equal(q2.ack('dev1', stampEdgeCollectedAt({ collectedAt: snapEdgeTs }, d).collectedAt), true, 'clamp 값은 시계가 섞인다(대조)');
  // 새 수집(엣지 시계로 더 새 값)은 완료다.
  c += 60_000;
  assert.equal(q.ack('dev1', stampEdgeCollectedAt({ collectedAt: snapEdgeTs + 120_000 }, c).edgeCollectedAt), true);
});

test('A4-02 — 세 수신 라우트가 stampEdgeCollectedAt 을 쓴다(옛 clamp 식 0건)', async () => {
  const { stripComments } = await import('./_stripComments.js');
  const src = stripComments(fs.readFileSync(new URL('../src/routes/central.js', import.meta.url), 'utf8'));
  assert.equal((src.match(/stampEdgeCollectedAt\(/g) || []).length >= 4, true);
  assert.equal(/collectedAt:\s*Math\.min\(Number\([ds]\.collectedAt\)/.test(src), false);
});

/* ── A4-03 ── */
const rma = await import('../src/rma/jobs.js');

test('A4-03 — 미회신 종결 뒤 온 실제 결과를 late 로 받고 이력을 한 행으로 갱신한다', () => {
  rma._resetRma();
  const t0 = Date.now();
  rma.noteHeartbeat('A', 'i1', {});
  const { reqId } = rma.enqueueJob('A', { cmd: 'svc-restart' }, { timeoutMs: 1000, now: t0 });
  assert.equal(rma.takeJobs('A', 'i1', t0).length, 1);
  rma.reapClaims(t0 + 40_000);
  const expired = rma.getJob(reqId);
  assert.equal(expired.state, 'done');
  assert.equal(expired.result.ok, false);
  assert.equal(expired.expired, true);

  assert.equal(rma.setJobResult(reqId, { ok: true, exitCode: 0, stdout: 'restarted' }), true);
  const j = rma.getJob(reqId);
  assert.equal(j.late, true);
  assert.equal(j.result.ok, true);
  assert.equal(j.result.stdout, 'restarted');
  assert.equal(j.result.late, true);
  assert.match(j.result.reason, /재실행하지 마세요/);
  const hist = rma.listHistory({ agent: 'A' }).filter((h) => h.reqId === reqId);
  assert.equal(hist.length, 1, '미회신 행과 실제 결과 행이 나란히 남지 않는다');
  assert.equal(hist[0].ok, true);
  assert.equal(hist[0].late, true);

  // 같은 결과의 재전송은 받지 않는다(중복).
  assert.equal(rma.setJobResult(reqId, { ok: false, reason: 'dup' }), false);
  assert.equal(rma.getJob(reqId).result.ok, true);
});

test('A4-03 — 정상 회신된 잡의 재전송은 예전처럼 false', () => {
  rma._resetRma();
  const t0 = Date.now();
  rma.noteHeartbeat('B', 'i1', {});
  const { reqId } = rma.enqueueJob('B', { cmd: 'x' }, { timeoutMs: 60_000, now: t0 });
  rma.takeJobs('B', 'i1', t0);
  assert.equal(rma.setJobResult(reqId, { ok: true }), true);
  assert.equal(rma.setJobResult(reqId, { ok: true }), false);
  assert.equal(rma.getJob(reqId).late, undefined);
});

/* ── A4-04 ── */
const backup = await import('../src/backup/service.js');

test('A4-04 — 배정 파일은 pulledAt·ack·state 가 바뀌어도 지문이 같고, 대상이 바뀌면 달라진다', () => {
  const rec = (over = {}) => JSON.stringify({ v: 1, agents: { e1: { sig: 'abc', targets: [{ name: 't', tests: [{ type: 'ping', state: 'keep' }] }], counts: { targets: 1, tests: 1 }, state: 'pending', pulledAt: 0, ack: null, lastExpectMs: 60000, ...over } } });
  const fp = (c) => backup.settingsFingerprint({ 'central-svcmon-assign.json': c });
  assert.ok(backup.MIXED_STATE_FILES.has('central-svcmon-assign.json'));
  assert.equal(fp(rec()), fp(rec({ pulledAt: T0, ack: { at: T0, added: 1 }, state: 'active', lastExpectMs: 600000 })));
  assert.notEqual(fp(rec()), fp(rec({ sig: 'def' })));
  // 대상 안의 같은 이름 필드(state)는 설정이므로 지우지 않는다.
  const inner = JSON.stringify({ v: 1, agents: { e1: { sig: 'abc', targets: [{ name: 't', tests: [{ type: 'ping', state: 'other' }] }] } } });
  assert.notEqual(fp(rec({ targets: undefined, counts: undefined })), fp(inner));
});

/* ── R2630-06 · UI2630-03 ── */
const assign = await import('../src/central/svcmonAssign.js');
const edge = await import('../src/central/svcmonEdge.js');
const silence = await import('../src/central/svcmonSilence.js');

test('R2630-06 — 엣지 주기를 배정 기록에 영속하고 유예가 그 주기를 쓴다', async () => {
  assign._resetAssignCache();
  assign.setAssignment('Edge-Slow', {}, []);
  assign.setAssignment('edge-fast', {}, []);
  // 보고 봉투의 expectMs 가 배정 기록에 남는다(대소문자 무시).
  edge.ingestReport('edge-slow', { snapId: 1, seq: 1, total: 1, expectMs: 600_000, rows: [] }, T0);
  const slow = assign.listAssignments().find((a) => a.agent === 'Edge-Slow');
  assert.equal(slow.lastExpectMs, 600_000);
  assert.equal(edge.noReportGraceMs(slow), 1_800_000);
  assert.equal(edge.noReportGraceMs({}), edge.silenceLimitMs(null), '모르면 기존값');
  // 재배정해도 주기는 유지된다.
  assign.setAssignment('Edge-Slow', { note: 'x' }, []);
  assert.equal(assign.listAssignments().find((a) => a.agent === 'Edge-Slow').lastExpectMs, 600_000);

  // 중앙 재시작을 흉내 — 수신 상태 비움. 기본 유예(300초)를 지나도 느린 엣지는 알리지 않는다.
  edge._resetEdgeCache();
  silence._resetSilenceState({ startedAt: T0 });
  const r = await silence.checkSilenceOnce({ now: T0 + 400_000 });
  assert.ok(r.noReport.includes('Edge-Slow'));
  assert.equal(r.graceByAgent['Edge-Slow'], 1_800_000);
  assert.ok(!silence.silenceStatus().tracked.some((t) => t.agent === 'Edge-Slow'), '느린 엣지는 유예 중');
  assert.ok(silence.silenceStatus().tracked.some((t) => t.agent === 'edge-fast' && t.noReport), '주기를 모르는 엣지는 예전 유예');
  await silence.checkSilenceOnce({ now: T0 + 1_800_000 + 1_000 });
  assert.ok(silence.silenceStatus().tracked.some((t) => t.agent === 'Edge-Slow' && t.noReport));
});

test('UI2630-03 — 배정만 있고 보고 없는 엣지가 카드 요약에 noReport 행으로 나온다', () => {
  for (const a of assign.listAssignments()) assign.deleteAssignment(a.agent);
  assign._resetAssignCache();
  edge._resetEdgeCache();
  edge._setEdgeStartedAt(T0);
  assign.setAssignment('edge-live', {}, []);
  assign.setAssignment('edge-dead', {}, []);
  edge.ingestReport('EDGE-LIVE', { snapId: 1, seq: 1, total: 1, expectMs: 60_000, rows: [] }, T0 + 1_000);

  // edgeSummary 는 보고 중인 엣지만(배정 후보·전환 판정용 — 바꾸지 않는다).
  assert.deepEqual(edge.edgeSummary(T0 + 2_000).map((s) => s.agent), ['EDGE-LIVE']);

  const early = edge.edgeSummaryWithAssigned(T0 + 2_000);
  const dead = early.find((s) => s.agent === 'edge-dead');
  assert.ok(dead, '배정만 있는 엣지가 행으로 나온다');
  assert.equal(dead.assignedOnly, true);
  assert.equal(dead.noReport, true);
  assert.equal(dead.unknown, true);
  assert.equal(dead.silent, false);
  assert.equal(dead.awaitingFirstReport, true, '유예 전엔 대기');
  assert.equal(dead.lastAt, null);
  assert.equal(dead.items, null);
  assert.equal(early.filter((s) => s.agent.toLowerCase() === 'edge-live').length, 1, '대소문자만 다른 배정 이름은 중복 행을 만들지 않는다');

  const late = edge.edgeSummaryWithAssigned(T0 + 10 * 60_000).find((s) => s.agent === 'edge-dead');
  assert.equal(late.silent, true);
  assert.equal(late.awaitingFirstReport, false);

  const t = edge.edgeTotals(T0 + 2_000);
  assert.equal(t.agents, 1, '보고 중 엣지 수는 그대로');
  assert.equal(t.assignedNoReport, 1);
});
