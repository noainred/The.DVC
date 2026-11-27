/**
 * v2.954(점검 B-3) — 어레이 측 호스트 처리량 · IOPS: 읽기/쓰기 한쪽만 읽힌 값을 '합' 으로 저장하지 않는다(flowView.esxiBpsOf 규칙과 같다).
 *  ① PowerStore parsePstorePoint: total 이 없고 write_* 가 빠지면 null(total 이 있으면 그대로 · 둘 다 있으면 합).
 *  ② Unity unityCounterRate: SP 합은 그 SP 포트를 전부 읽었을 때만(리셋 · 빠진 포트가 있으면 null).
 *  ③ Unity sampleUnity: writeBytes · writes 경로 조회만 실패 → SP · 포트 hbps · iops 가 null(읽기만의 부분 합 아님) + probe.partialSums.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arrayperf2954-'));
process.env.CONFIG_DIR = tmp;
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const A = await import('../src/storage/collectors/arrayPerf.js');

test('B-3 ① PowerStore — 한쪽만 읽힌 IOPS · 대역폭은 null', () => {
  const one = A.parsePstorePoint([{ timestamp: '2026-11-09T01:05:00Z', read_iops: 500, read_bandwidth: 3e6 }]);
  assert.equal(one.iops, null); assert.equal(one.hbps, null);
  const both = A.parsePstorePoint([{ timestamp: '2026-11-09T01:05:00Z', read_iops: 500, write_iops: 700, read_bandwidth: 3e6, write_bandwidth: 1e6 }]);
  assert.equal(both.iops, 1200); assert.equal(both.hbps, 4e6);
  const tot = A.parsePstorePoint([{ timestamp: '2026-11-09T01:05:00Z', total_iops: 900, read_iops: 500, total_bandwidth: 5e6 }]);
  assert.equal(tot.iops, 900); assert.equal(tot.hbps, 5e6);
  assert.equal(A.bothSum(0, 0), 0, '0 은 읽힌 값'); assert.equal(A.bothSum(null, 0), null);
});

test('B-3 ② Unity — SP 합은 포트를 전부 읽었을 때만', () => {
  const ent = A.parseUnityEntries({ entries: [
    { content: { timestamp: '2026-11-09T01:00:00.000Z', values: { spa: { spa_fc4: 1000, spa_fc5: 500 }, spb: { spb_fc4: 100, spb_fc5: 100 } } } },
    { content: { timestamp: '2026-11-09T01:01:00.000Z', values: { spa: { spa_fc4: 1600, spa_fc5: 400 }, spb: { spb_fc4: 160 } } } }] });
  const r = A.unityCounterRate(ent);
  assert.equal(r.perSp.spa, null, 'spa_fc5 리셋 — 나머지 포트만의 부분 합 금지');
  assert.equal(r.perSp.spb, null, 'spb_fc5 가 최신 항목에서 빠짐 — 부분 합 금지');
  assert.equal(r.perPort.spa_fc4.rate, 10, '포트 자체 값은 그대로');
});

test('B-3 ③ Unity 조립 — 쓰기 경로만 실패하면 SP · 포트 hbps · iops 는 null', () => {
  const t1 = '2026-11-09T01:00:00.000Z'; const t2 = '2026-11-09T01:01:00.000Z';
  const counter = (a, b) => A.unityCounterRate(A.parseUnityEntries({ entries: [
    { content: { timestamp: t1, values: { spa: { spa_fc4: a } } } }, { content: { timestamp: t2, values: { spa: { spa_fc4: b } } } }] }));
  const empty = A.unityCounterRate([]);   // sampleUnity 의 fetchEntries 는 경로 실패를 [] 로 삼킨다
  const r = A.unityUnits({ cpu: { spa: 20 }, rb: counter(1000, 7000), wb: empty, rd: counter(10, 70), wr: empty }, { withPorts: true });
  const sp = r.units.find((u) => u.kind === 'sp'); const port = r.units.find((u) => u.kind === 'port');
  assert.equal(sp.hbps, null); assert.equal(sp.iops, null); assert.equal(sp.cpu, 20);
  assert.equal(port.hbps, null); assert.equal(port.iops, null);
  assert.equal(r.partial, 4);
  const ok = A.unityUnits({ cpu: {}, rb: counter(1000, 7000), wb: counter(0, 600), rd: counter(10, 70), wr: counter(0, 60) });
  assert.equal(ok.units.find((u) => u.kind === 'sp').hbps, 110); assert.equal(ok.units.find((u) => u.kind === 'sp').iops, 2); assert.equal(ok.partial, 0);
});
