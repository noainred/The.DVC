// v2.934 — Monitoring 엣지 알림 키: 재배정 재알림(v2.932 남긴 것 — 재현) · 같은 이름 점검(반증 N1) 회귀. 실제 ingestReport 흐름을 탄다.
//  ① 재배정(같은 이름 · 새 id) 뒤 실패 알림은 1건 — 새 id 행 · 메타가 같은 push 에 와도(재현 흐름) · needMeta 다음 push 에 와도(실제 흐름).
//     예전(v2.928~v2.932)에는 GC 대기 중인 옛 id 행의 메타까지 이름 수로 세어 새 id 가 testId 키(`엣지·#새id`)로 떨어져 한 번 더 알렸다.
//  ② 같은 이름 두 점검(TCP 22·443 이 둘 다 'TCP 포트 열림')의 한쪽 실패를 다른 쪽 정상이 '복구' 로 지우지 않는다 —
//     청크가 나뉘어도 · 청크 순서가 바뀌어도 · 청크 하나가 유실돼도 · 엣지 예열 중에도 · 한 청크 안 행 순서가 바뀌어도.
//  ③ 이름 키별 id 색인은 메타와 늘 맞는다(이름을 바꾼 메타 · GC 로 지운 메타).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'svcmon2934-'));
process.env.CONFIG_DIR = TMP;
process.env.AUTH_ENABLED = 'true';

const TR = await import('../src/svcmon/transitions.js');
const EDGE = await import('../src/central/svcmonEdge.js');
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

// 기준 시각 — 실제 시각에서 정시 경계로 떨어뜨린다(고정 epoch · Date.now() 직접 둘 다 쓰지 않는다).
const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 30 * 60_000;
const MIN = 60_000;
const SEP = '\u0001';

function reset(opts = {}) {
  const sent = [];
  TR._resetTransitionsForTest({ send: async (a) => { sent.push(a); } });
  EDGE._resetEdgeCache();
  TR._setAlertSettingsForTest({ enabled: true, failCount: 1, recover: true, ...opts });
  return sent;
}
const R = (i, s, k, a = 0) => ({ i, s, r: s === 'ok' ? '1ms' : 'connect ECONNREFUSED', m: s === 'ok' ? 1 : null, k, a });
/**
 * 스냅샷 하나를 실제 엣지처럼 청크로 보낸다(svcmonPush 봉투 — snapId · seq · total · metaSig). `lost` 의 청크 번호(1부터)는 보내지 않는다.
 * @returns 마지막으로 받은 청크의 응답
 */
function push(agent, at, chunks, { sig = 's', lost = [], extra = {} } = {}) {
  let res = null;
  chunks.forEach((c, idx) => {
    if (lost.includes(idx + 1)) return;
    res = EDGE.ingestReport(agent, { snapId: at, seq: idx + 1, total: chunks.length, rows: c.rows || [], ...(c.meta ? { meta: c.meta } : {}), metaSig: sig, ...extra }, at);
  });
  return res;
}
const crit = (sent) => sent.filter((a) => a.severity === 'critical');
const info = (sent) => sent.filter((a) => a.severity === 'info');

/* ── ① 재배정 ── */
test('① 재배정 — 새 id 행 · 메타가 같은 push 에 와도 실패 알림은 1건(키는 이름 키) · 복구는 새 id 로 1건', async () => {
  const sent = reset();
  const m = (i) => ({ i, p: 'Infra', n: 'vc-r', h: 'h', t: 'TCP 443', y: 'tcp', iv: 60 });
  push('EDGE-R', NOW, [{ rows: [R('o1', 'bad', 1)], meta: [m('o1')] }], { sig: 's1' });
  // 배정 재스냅샷 — 같은 점검에 새 id. 옛 id 행(o1)은 완결 GC 의 '직전 완결 허용' 으로 이 세대 동안 남는다.
  push('EDGE-R', NOW + MIN, [{ rows: [R('n1', 'bad', 2)], meta: [m('n1')] }], { sig: 's2' });
  assert.equal(EDGE.getAgentRaw('EDGE-R').rows.has('o1'), true, '옛 id 행은 한 세대 남는다(이 시험의 전제)');
  assert.equal(TR.alertStats().alerted, 1, '새 id 가 testId 키로 따로 알린 상태를 만들면 안 된다');
  push('EDGE-R', NOW + 2 * MIN, [{ rows: [R('n1', 'bad', 3)] }], { sig: 's2' });
  assert.equal(EDGE.getAgentRaw('EDGE-R').rows.has('o1'), false, '옛 id 행은 다음 완결에 GC');
  push('EDGE-R', NOW + 3 * MIN, [{ rows: [R('n1', 'ok', 1)] }], { sig: 's2' });
  await TR.flushAlerts();
  assert.equal(crit(sent).length, 1, `실패 알림 ${crit(sent).length}건 — 키 ${crit(sent).map((a) => a.key.replaceAll(SEP, '·')).join(' , ')}`);
  assert.equal(crit(sent)[0].key, `svcmon.test.bad:EDGE-R${SEP}Infra${SEP}vc-r${SEP}TCP 443`);
  assert.equal(info(sent).length, 1, '복구는 새 id 로 와도 한 번');
  assert.equal(TR.alertStats().alerted, 0);
});

test('① 재배정 — 실제 흐름(새 id 는 연속 횟수 1부터 · 메타는 needMeta 다음 push)에서도 실패 알림 1건', async () => {
  const sent = reset();
  const m = (i) => ({ i, p: 'PL\\Infra', n: 'vc-pl', h: 'h', t: 'HTTPS 443', y: 'http', iv: 60 });
  push('EDGE-P', NOW, [{ rows: [R('o1', 'bad', 4)], meta: [m('o1')] }], { sig: 'r1-1' });
  // 엣지가 배정을 다시 굳혔다 — 결과는 새 id 로 처음부터(연속 1) · 색인 세대가 바뀌어 metaSig 가 다르다 · 메타는 아직 없다
  const r2 = push('EDGE-P', NOW + MIN, [{ rows: [R('n1', 'bad', 1)] }], { sig: 'r2-1' });
  assert.equal(r2.needMeta, true, '세대가 바뀌면 중앙이 메타를 요청한다');
  assert.equal(TR.alertStats().metaPending, 1, '이름을 모르는 새 id 는 판정 보류');
  // 다음 push — 같은 측정의 재전송 + 메타(색인 전량)
  push('EDGE-P', NOW + 2 * MIN, [{ rows: [R('n1', 'bad', 1, MIN)], meta: [m('n1')] }], { sig: 'r2-1' });
  assert.equal(TR.alertStats().metaPending, 0);
  push('EDGE-P', NOW + 3 * MIN, [{ rows: [R('n1', 'bad', 2)] }], { sig: 'r2-1' });
  push('EDGE-P', NOW + 4 * MIN, [{ rows: [R('n1', 'ok', 1)] }], { sig: 'r2-1' });
  await TR.flushAlerts();
  assert.equal(crit(sent).length, 1, `실패 알림 ${crit(sent).length}건`);
  assert.equal(info(sent).length, 1);
});

test('① 재배정 — 여러 청크 엣지 · 메타가 다음 push 에 나뉘어 와도 실패 알림 1건', async () => {
  const sent = reset();
  const m = (i, n) => ({ i, p: 'US\\Infra', n, h: 'h', t: 'TCP 22', y: 'tcp', iv: 60 });
  push('EDGE-U', NOW, [{ rows: [R('o1', 'bad', 2), R('o2', 'ok', 2)], meta: [m('o1', 'esx1'), m('o2', 'esx2')] }, { rows: [R('o3', 'ok', 2)], meta: [m('o3', 'esx3')] }], { sig: 'g1' });
  push('EDGE-U', NOW + MIN, [{ rows: [R('n1', 'bad', 1), R('n2', 'ok', 1)] }, { rows: [R('n3', 'ok', 1)] }], { sig: 'g2' });
  push('EDGE-U', NOW + 2 * MIN, [{ rows: [R('n1', 'bad', 2), R('n2', 'ok', 2)], meta: [m('n1', 'esx1'), m('n2', 'esx2')] }, { rows: [R('n3', 'ok', 2)], meta: [m('n3', 'esx3')] }], { sig: 'g2' });
  push('EDGE-U', NOW + 3 * MIN, [{ rows: [R('n1', 'ok', 1), R('n2', 'ok', 3)] }, { rows: [R('n3', 'ok', 3)] }], { sig: 'g2' });
  await TR.flushAlerts();
  assert.equal(crit(sent).length, 1);
  assert.equal(info(sent).length, 1);
});

/* ── ② 같은 이름 점검(N1) ── */
const twin = (i) => ({ i, p: 'P', n: 'srv1', h: 'h', t: 'TCP 포트 열림', y: 'tcp', iv: 60 });

test('② 같은 이름 둘 — 청크가 나뉘고 순서가 바뀌어도 한쪽 실패가 다른 쪽 정상으로 복구되지 않는다(첫 메타 직후 포함)', async () => {
  const sent = reset();
  // 첫 스냅샷: A 와 두 메타가 청크 1, B 는 청크 2 — A 를 판정할 때 B 는 아직 결과가 없다(메타만)
  push('EDGE-N', NOW, [{ rows: [R('A', 'bad', 1)], meta: [twin('A'), twin('B')] }, { rows: [R('B', 'ok', 1)] }]);
  for (let k = 2; k <= 7; k++) {
    const a = { rows: [R('A', 'bad', k)] }; const b = { rows: [R('B', 'ok', k)] };
    push('EDGE-N', NOW + (k - 1) * MIN, k % 2 ? [a, b] : [b, a]);   // 청크 순서를 번갈아 바꾼다(엣지가 색인을 다시 만들 때)
  }
  await TR.flushAlerts();
  assert.equal(crit(sent).length, 1, '실패는 한 번');
  assert.equal(info(sent).length, 0, '실패 중인 A 에 거짓 복구가 나가면 안 된다');
  assert.match(crit(sent)[0].key, new RegExp(`EDGE-N${SEP}#A$`), '같은 이름이면 testId 키');
});

test('② 같은 이름 둘 — 한 청크 안 행 순서가 바뀌어도 키가 흔들리지 않는다(판정은 청크를 다 반영한 뒤)', async () => {
  const sent = reset();
  push('EDGE-O', NOW, [{ rows: [R('A', 'bad', 1), R('B', 'ok', 1)], meta: [twin('A'), twin('B')] }]);
  for (let k = 2; k <= 7; k++) {
    const rows = k % 2 ? [R('A', 'bad', k), R('B', 'ok', k)] : [R('B', 'ok', k), R('A', 'bad', k)];
    push('EDGE-O', NOW + (k - 1) * MIN, [{ rows }]);
  }
  await TR.flushAlerts();
  assert.equal(crit(sent).length, 1);
  assert.equal(info(sent).length, 0);
});

test('② 같은 이름 둘 — 청크 하나가 유실된 스냅샷은 직전 완결의 형제를 센다(중복 실패 · 거짓 복구 없음)', async () => {
  const sent = reset();
  push('EDGE-L', NOW, [{ rows: [R('B', 'ok', 1)], meta: [twin('A'), twin('B')] }, { rows: [R('A', 'bad', 1)] }]);
  // 청크 1(B) 유실 — 완결 청크(A)만 왔다. '다 받음' 이 아니므로 직전 완결의 B 를 센다
  push('EDGE-L', NOW + MIN, [{ rows: [R('B', 'ok', 2)] }, { rows: [R('A', 'bad', 2)] }], { lost: [1] });
  // 순서가 바뀐 다음 스냅샷에서 이번엔 A 쪽 청크 유실 — B 정상이 A 를 '복구' 로 지우면 안 된다
  push('EDGE-L', NOW + 2 * MIN, [{ rows: [R('A', 'bad', 3)] }, { rows: [R('B', 'ok', 3)] }], { lost: [1] });
  push('EDGE-L', NOW + 3 * MIN, [{ rows: [R('B', 'ok', 4)] }, { rows: [R('A', 'bad', 4)] }]);
  await TR.flushAlerts();
  assert.equal(crit(sent).length, 1, `실패 알림 ${crit(sent).length}건`);
  assert.equal(info(sent).length, 0, '거짓 복구 없음');
});

test('② 같은 이름 둘 — 엣지 예열 중(재시작 직후 일부만 측정)에는 아직 안 온 형제를 센다', async () => {
  const sent = reset();
  push('EDGE-W', NOW, [{ rows: [R('A', 'bad', 1), R('B', 'ok', 1)], meta: [twin('A'), twin('B')] }]);
  // 엣지 재시작 — A 만 다시 측정됨(B 는 아직). 한 청크라 '다 받음' 이지만 예열이라 이번 스냅샷만 보지 않는다
  push('EDGE-W', NOW + MIN, [{ rows: [R('A', 'bad', 2)] }], { extra: { warmingUp: true, items: 2, reported: 1 } });
  push('EDGE-W', NOW + 2 * MIN, [{ rows: [R('A', 'bad', 3), R('B', 'ok', 2)] }], { extra: { items: 2, reported: 2 } });
  await TR.flushAlerts();
  assert.equal(crit(sent).length, 1, `실패 알림 ${crit(sent).length}건`);
  assert.equal(info(sent).length, 0);
});

test('② 413 축소 재전송(같은 snapId · 다른 total)은 새 청크 수로 다시 센다', async () => {
  const sent = reset();
  push('EDGE-S', NOW, [{ rows: [R('A', 'bad', 1), R('B', 'ok', 1)], meta: [twin('A'), twin('B')] }]);
  // 1차: total 2 중 청크 1만 받고 청크 2 는 413(중앙에 오지 않는다) → 2차: total 3 으로 처음부터
  EDGE.ingestReport('EDGE-S', { snapId: NOW + MIN, seq: 1, total: 2, rows: [R('A', 'bad', 2)], metaSig: 's' }, NOW + MIN);
  for (const [seq, rows] of [[1, [R('A', 'bad', 2)]], [2, []], [3, [R('B', 'ok', 2)]]]) {
    EDGE.ingestReport('EDGE-S', { snapId: NOW + MIN, seq, total: 3, rows, metaSig: 's' }, NOW + MIN);
  }
  const a = EDGE.getAgentRaw('EDGE-S');
  assert.equal(a.recvTotal, 3);
  assert.deepEqual([...a.recvSeqs].sort(), [1, 2, 3]);
  await TR.flushAlerts();
  assert.equal(crit(sent).length, 1);
  assert.equal(info(sent).length, 0);
});

/* ── ③ 이름 키 색인 ── */
test('③ 이름 키별 id 색인은 메타와 맞는다 — 이름이 바뀐 메타 · GC 로 지운 메타', () => {
  reset();
  const key = (t) => `P${SEP}srv1${SEP}${t}`;
  push('EDGE-I', NOW, [{ rows: [R('X', 'ok', 1), R('Y', 'ok', 1)], meta: [twin('X'), twin('Y')] }]);
  assert.deepEqual(EDGE._nameIndexForTest('EDGE-I'), { [key('TCP 포트 열림')]: ['X', 'Y'] });
  // 점검 이름을 고쳤다(needMeta 로 다시 온 메타) — 옛 키에서 빠지고 새 키로
  push('EDGE-I', NOW + MIN, [{ rows: [R('X', 'ok', 2), R('Y', 'ok', 2)], meta: [twin('X'), { ...twin('Y'), t: 'TCP 443' }] }], { sig: 's2' });
  assert.deepEqual(EDGE._nameIndexForTest('EDGE-I'), { [key('TCP 포트 열림')]: ['X'], [key('TCP 443')]: ['Y'] });
  // 같은 메타가 다시 와도 중복으로 쌓이지 않는다
  push('EDGE-I', NOW + 2 * MIN, [{ rows: [R('X', 'ok', 3), R('Y', 'ok', 3)], meta: [twin('X'), { ...twin('Y'), t: 'TCP 443' }] }], { sig: 's2' });
  assert.deepEqual(EDGE._nameIndexForTest('EDGE-I'), { [key('TCP 포트 열림')]: ['X'], [key('TCP 443')]: ['Y'] });
  // X 가 엣지에서 사라짐 — 두 완결 뒤 GC 가 행 · 메타 · 색인을 함께 지운다
  push('EDGE-I', NOW + 3 * MIN, [{ rows: [R('Y', 'ok', 4)] }], { sig: 's3' });
  push('EDGE-I', NOW + 4 * MIN, [{ rows: [R('Y', 'ok', 5)] }], { sig: 's3' });
  assert.equal(EDGE.getAgentRaw('EDGE-I').meta.has('X'), false);
  assert.deepEqual(EDGE._nameIndexForTest('EDGE-I'), { [key('TCP 443')]: ['Y'] });
});
