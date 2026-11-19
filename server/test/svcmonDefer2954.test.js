// v2.954(개선 검토 2번 — v2.934 '남긴 것' ① ③): 이번 스냅샷을 다 받기 전에는 이름 중복을 확정할 수 없는 경우 알림 판정을 미룬다.
//  ① 여러 청크 엣지에서 재배정 새 id 행 · 메타가 완결 전 청크에 오면 직전 완결의 옛 id 를 형제로 세어 testId 키로 한 번 더 알렸다.
//  ③ 첫 메타가 청크로 나뉘어 같은 이름 형제의 메타가 뒤 청크에 오면 앞 점검이 이름 키 → testId 키로 한 번 바뀌어 다시 알렸다.
//  ⑤ 보류에는 시한 — 다 받지 못한 스냅샷(청크 유실)이 이어지면 시한 뒤 넓은 창 판정(중복이면 testId 키)으로 확정한다.
//  실제 ingestReport 흐름을 탄다(svcmonRealloc2934 와 같은 봉투).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'svcmon2954-'));
process.env.CONFIG_DIR = TMP;
process.env.AUTH_ENABLED = 'true';
const TR = await import('../src/svcmon/transitions.js');
const EDGE = await import('../src/central/svcmonEdge.js');
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 30 * 60_000;
const MIN = 60_000;
const SEP = '\u0001';
function reset() {
  const sent = [];
  TR._resetTransitionsForTest({ send: async (a) => { sent.push(a); } });
  EDGE._resetEdgeCache();
  TR._setAlertSettingsForTest({ enabled: true, failCount: 1, recover: true });
  return sent;
}
const R = (i, s, k, a = 0) => ({ i, s, r: s === 'ok' ? '1ms' : 'connect ECONNREFUSED', m: s === 'ok' ? 1 : null, k, a });
function push(agent, at, chunks, { sig = 's', lost = [] } = {}) {
  let res = null;
  chunks.forEach((c, idx) => {
    if (lost.includes(idx + 1)) return;
    res = EDGE.ingestReport(agent, { snapId: at, seq: idx + 1, total: chunks.length, rows: c.rows || [], ...(c.meta ? { meta: c.meta } : {}), metaSig: sig, expectMs: MIN }, at);
  });
  return res;
}
const crit = (sent) => sent.filter((a) => a.severity === 'critical');
const info = (sent) => sent.filter((a) => a.severity === 'info');

test('① 재배정 — 새 id 행 · 메타가 완결 전 청크에 와도(실패 기준 1회) 실패 알림 1건 · 키는 이름 키', async () => {
  const sent = reset();
  const m = (i, n) => ({ i, p: 'US\\Infra', n, h: 'h', t: 'TCP 22', y: 'tcp', iv: 60 });
  push('EDGE-U', NOW, [{ rows: [R('o1', 'bad', 1)], meta: [m('o1', 'esx1')] }, { rows: [R('o3', 'ok', 1)], meta: [m('o3', 'esx3')] }], { sig: 'g1' });
  // 재배정 — 새 id(n1)의 행 · 메타가 같은 push 의 **첫(완결 전) 청크**로 온다. 옛 id o1 은 직전 완결에만 있다.
  push('EDGE-U', NOW + MIN, [{ rows: [R('n1', 'bad', 1)], meta: [m('n1', 'esx1')] }, { rows: [R('n3', 'ok', 1)], meta: [m('n3', 'esx3')] }], { sig: 'g2' });
  push('EDGE-U', NOW + 2 * MIN, [{ rows: [R('n1', 'bad', 2)] }, { rows: [R('n3', 'ok', 2)] }], { sig: 'g2' });
  push('EDGE-U', NOW + 3 * MIN, [{ rows: [R('n1', 'ok', 1)] }, { rows: [R('n3', 'ok', 3)] }], { sig: 'g2' });
  await TR.flushAlerts();
  assert.equal(crit(sent).length, 1, `실패 알림 ${crit(sent).length}건 — ${crit(sent).map((a) => a.key.replaceAll(SEP, '·')).join(' , ')}`);
  assert.equal(crit(sent)[0].key, `svcmon.test.bad:EDGE-U${SEP}US\\Infra${SEP}esx1${SEP}TCP 22`);
  assert.equal(info(sent).length, 1);
  assert.equal(TR.alertStats().metaPending, 0, '보류가 남지 않는다');
});

test('③ 첫 메타가 청크로 나뉘어 같은 이름 형제의 메타가 뒤 청크에 와도 키가 한 번에 정해진다(testId 키 · 실패 1건 · 거짓 복구 없음)', async () => {
  const sent = reset();
  const twin = (i) => ({ i, p: 'P', n: 'srv1', h: 'h', t: 'TCP 포트 열림', y: 'tcp', iv: 60 });
  // 첫 스냅샷: A(실패)와 그 메타가 청크 1, 같은 이름 형제 B 의 행 · 메타는 청크 2
  push('EDGE-T', NOW, [{ rows: [R('A', 'bad', 1)], meta: [twin('A')] }, { rows: [R('B', 'ok', 1)], meta: [twin('B')] }]);
  for (let k = 2; k <= 5; k++) push('EDGE-T', NOW + (k - 1) * MIN, [{ rows: [R('A', 'bad', k)] }, { rows: [R('B', 'ok', k)] }]);
  await TR.flushAlerts();
  assert.equal(crit(sent).length, 1, `실패 알림 ${crit(sent).length}건 — ${crit(sent).map((a) => a.key.replaceAll(SEP, '·')).join(' , ')}`);
  assert.match(crit(sent)[0].key, new RegExp(`EDGE-T${SEP}#A$`), '같은 이름 둘이면 testId 키');
  assert.equal(info(sent).length, 0, '거짓 복구 없음');
});

test('⑤ 보류에는 시한 — 마지막 청크가 계속 유실되면 시한 뒤 넓은 창 판정(중복 → testId 키)으로 확정한다', async () => {
  const sent = reset();
  const m = (i) => ({ i, p: 'X', n: 'h1', h: 'h', t: 'TCP 80', y: 'tcp', iv: 60 });
  push('EDGE-L', NOW, [{ rows: [R('o1', 'bad', 1)], meta: [m('o1')] }, { rows: [R('z', 'ok', 1)], meta: [{ ...m('z'), n: 'other' }] }], { sig: 'a' });
  // 다음 스냅샷들은 둘째 청크를 잃는다 — 이번 스냅샷을 다 받지 못해 n1 은 계속 '확정할 수 없음'
  push('EDGE-L', NOW + MIN, [{ rows: [R('n1', 'bad', 1)], meta: [m('n1')] }, { rows: [R('z', 'ok', 2)] }], { sig: 'b', lost: [2] });
  await TR.flushAlerts();
  assert.equal(TR.alertStats().metaPending, 1, '보류 중');
  assert.equal(crit(sent).length, 1, '옛 id 의 알림만(첫 스냅샷)');
  push('EDGE-L', NOW + 20 * MIN, [{ rows: [R('n1', 'bad', 2)] }, { rows: [R('z', 'ok', 3)] }], { sig: 'b', lost: [2] });
  await TR.flushAlerts();
  assert.equal(TR.alertStats().metaPending, 0, '시한을 넘기면 확정한다(무기한 보류 금지)');
  assert.equal(crit(sent).length, 2, '넓은 창 판정 — 예전과 같이 testId 키로 한 번 더(거짓 복구 쪽이 아니다)');
});

test('④ 반증 — 재배정 + 첫 청크 유실 + 같은 완결의 GC 가 겹쳐도 정리 경로가 보류 행의 키를 확정하지 않는다(실패 알림 1건)', async () => {
  const sent = reset();
  const m = (i, n) => ({ i, p: 'US', n, h: 'h', t: 'TCP 22', y: 'tcp', iv: 60 });
  push('E', NOW, [{ rows: [R('o1', 'bad', 1)], meta: [m('o1', 'esx1')] }, { rows: [R('y', 'ok', 1)], meta: [m('y', 'yy')] }], { sig: 'a' });
  push('E', NOW + MIN, [{ rows: [R('o1', 'bad', 2)] }, { rows: [] }], { sig: 'a' });   // y 는 엣지에서 지워졌다(GC 대상)
  push('E', NOW + 2 * MIN, [{ rows: [] }, { rows: [R('n1', 'bad', 1)], meta: [m('n1', 'esx1')] }], { sig: 'b', lost: [1] });
  push('E', NOW + 3 * MIN, [{ rows: [] }, { rows: [R('n1', 'bad', 2)] }], { sig: 'b' });
  push('E', NOW + 4 * MIN, [{ rows: [] }, { rows: [R('n1', 'bad', 3)] }], { sig: 'b' });
  await TR.flushAlerts();
  assert.equal(crit(sent).length, 1, `실패 알림 ${crit(sent).map((a) => a.key.replaceAll(SEP, '·')).join(' , ')}`);
  assert.equal(info(sent).length, 0);
});
