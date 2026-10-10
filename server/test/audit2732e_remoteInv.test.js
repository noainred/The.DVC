/**
 * test/audit2732e_remoteInv.test.js — 점검 2회차(v2.732)
 *  B4-04: 엣지 iDRAC 인벤토리 `collectedAt` 이 미래면 받은 시각으로 자르고 원본은 `edgeCollectedAt` 으로 남긴다
 *         (센서 `t`·센서 상세 시각 v2.682 R3S-01/02 와 같은 규칙). 예전에는 자르지 않아 엣지 시계가 앞선 만큼 '낡음' 판정이
 *         오지 않았다(재현: 365일 앞선 시각 → 30일 뒤에도 serverParts stale=false).
 *  B6-05: pull 경로는 sanitizeEdgeExport 가 이미 정제한 목록을 setCollectorServers 가 다시 정제했다 — 모듈 내부 WeakSet 표지로
 *         한 번만 정제하되, 표지 없는 목록(데모 시드·외부 JSON)은 여전히 정제한다(방어선 유지 · 표지 위조 불가).
 * ⚠ 기준 시각은 경계에서 떨어뜨린 고정값(정시 −30분)이다 — Date.now() 를 그대로 기준으로 쓰지 않는다(v2.517 규약).
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'a2732e-rinv-'));
process.env.CONFIG_DIR = TMP;
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const ri = await import('../src/collector/remoteInventory.js');
const { summarizeServerParts } = await import('../src/idrac/serverParts.js');
const { idracGpuCounts } = await import('../src/idrac/gpuCount.js');

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;
const FUT = NOW + 365 * DAY;

const edgeServer = (over = {}) => ({
  id: 'r1', name: 'srv1', host: '10.0.0.1', serviceTag: 'TAG1',
  inv: { collectedAt: FUT, gpus: [{ model: 'A40' }], psus: [{ name: 'PSU1', health: 'OK', state: 'Enabled' }], health: { overall: 'OK' } },
  ...over,
});

beforeEach(() => { ri.clearCollectorServers('c1'); ri.clearCollectorServers('c2'); ri.clearCollectorServers('c3'); });

test('B4-04 ① 미래 collectedAt 은 now 로 자르고 원본은 edgeCollectedAt — 재정리해도 원본 유지', () => {
  const { servers } = ri.sanitizeRemoteServers([edgeServer()], { now: NOW });
  const inv = servers[0].inv;
  assert.equal(inv.collectedAt, NOW, '받은 시각으로 자른다');
  assert.equal(inv.edgeCollectedAt, FUT, '엣지 원본 시각을 남긴다');
  // 재정리(pull → 저장) — 같은 now · 더 늦은 now 둘 다 원본을 잃지 않는다
  for (const now of [NOW, NOW + HOUR]) {
    const again = ri.sanitizeRemoteServers(servers, { now }).servers[0].inv;
    assert.equal(again.collectedAt, NOW);
    assert.equal(again.edgeCollectedAt, FUT);
  }
  // 과거 시각은 그대로 · edgeCollectedAt 없음
  const past = ri.sanitizeRemoteServers([edgeServer({ inv: { collectedAt: NOW - HOUR } })], { now: NOW }).servers[0].inv;
  assert.equal(past.collectedAt, NOW - HOUR);
  assert.equal('edgeCollectedAt' in past, false);
});

test('B4-04 ② 자른 인벤토리는 시간이 지나면 낡음으로 판정된다(serverParts · gpuCount)', () => {
  const s = ri.sanitizeRemoteServers([edgeServer()], { now: NOW }).servers[0];
  const later = NOW + 30 * DAY;
  assert.equal(summarizeServerParts(s, s.inv, { now: later, remote: true }).stale, true, '30일 뒤 — 낡음');
  const g = idracGpuCounts([{ id: 'r1' }], () => s.inv, later);
  assert.equal(g.invStale, 1);
  assert.ok(g.gpusStale > 0, 'GPU 도 낡은 인벤토리로 센다');
  // 직후에는 신선
  assert.equal(summarizeServerParts(s, s.inv, { now: NOW + 60_000, remote: true }).stale, false);
});

test('B4-04 ③ ISO·숫자 글자 미래 시각도 자르고, 못 읽는 값은 지어내지 않는다', () => {
  const iso = ri.sanitizeRemoteInv({ collectedAt: new Date(FUT).toISOString() }, { now: NOW });
  assert.equal(iso.collectedAt, NOW);
  assert.equal(iso.edgeCollectedAt, FUT);
  const numStr = ri.sanitizeRemoteInv({ collectedAt: String(FUT) }, { now: NOW });
  assert.equal(numStr.collectedAt, NOW);
  assert.equal(numStr.edgeCollectedAt, FUT);
  const obj = ri.sanitizeRemoteInv({ collectedAt: { x: 1 } }, { now: NOW });
  assert.equal(obj.collectedAt, null);
  assert.equal('edgeCollectedAt' in obj, false);
  // now 가 없으면 자르지 않는다(순수 판정 호환)
  assert.equal(ri.sanitizeRemoteInv({ collectedAt: FUT }).collectedAt, FUT);
  // 위조된 edgeCollectedAt(collectedAt 보다 이르거나 같음)은 버린다
  assert.equal('edgeCollectedAt' in ri.sanitizeRemoteInv({ collectedAt: NOW, edgeCollectedAt: NOW - 1 }, { now: NOW }), false);
});

test('B4-04 ④ pull 경로(sanitizeEdgeExport → setCollectorServers)도 자른다', () => {
  const before = Date.now();
  const ex = ri.sanitizeEdgeExport({ servers: [edgeServer({ inv: { collectedAt: Date.now() + 365 * DAY } })] });
  ri.setCollectorServers('c1', 'dc', ex.servers);
  const s = ri.findRemoteServer('r1');
  assert.ok(s.inv.collectedAt >= before && s.inv.collectedAt <= Date.now(), '받은 시각 근처로 잘렸다');
  assert.ok(s.inv.edgeCollectedAt > Date.now() + 300 * DAY);
});

test('B6-05 ⑤ 정제된 export 목록은 다시 정제하지 않는다 — 저장 결과는 재정제와 같다', () => {
  const ex = ri.sanitizeEdgeExport({ servers: [edgeServer({ inv: { collectedAt: NOW, gpus: [{ model: 'A40' }] } }), edgeServer({ id: 'r2', serviceTag: 'TAG2' })] });
  ri.setCollectorServers('c1', 'dc', ex.servers);
  const s = ri.findRemoteServer('r1');
  assert.equal(s.inv, ex.servers[0].inv, '표지 있는 목록은 그 원소를 그대로 보관한다(두 번째 정제 없음)');
  // 결과 동일성 — 같은 목록을 다시 정제한 것과 깊이 같다
  const re = ri.sanitizeRemoteServers(ex.servers).servers;
  assert.deepEqual(ex.servers, re);
});

test('B6-05 ⑥ 표지 없는 목록(데모 시드 모양 · 오염 원소)은 여전히 정제된다', () => {
  ri.setCollectorServers('c2', 'dc', [null, 'x', { id: 'bad id\u0000' }, edgeServer({ serviceTag: { toString: 1 } })]);
  const all = ri.allRemoteServers().filter((x) => x.collectorId === 'c2');
  assert.equal(all.length, 1, '객체가 아닌 원소·나쁜 id 는 버린다');
  assert.equal(all[0].serviceTag, null, '글자가 아닌 serviceTag 는 null');
  assert.equal(all[0].inv.collectedAt <= Date.now(), true, '미래 시각도 잘린다');
});

test('B6-05 ⑦ JSON 으로 온 목록은 표지를 위조할 수 없다 · 넓힌 상한·미래 now 로 정제한 목록도 다시 정제', () => {
  const ex = ri.sanitizeEdgeExport({ servers: [edgeServer({ inv: { collectedAt: NOW } })] });
  const parsed = JSON.parse(JSON.stringify(ex.servers));
  parsed[0].serviceTag = { toString: 1 };
  ri.setCollectorServers('c1', 'dc', parsed);
  const s = ri.findRemoteServer('r1');
  assert.equal(s.serviceTag, null, '위조 목록의 오염 원소가 정제된다');
  assert.notEqual(s.inv, parsed[0].inv, '다시 정제했다');
  // 상한을 넓혀 정제한 목록 — 표지하지 않는다
  const wide = ri.sanitizeRemoteServers([edgeServer({ id: 'r3', inv: { collectedAt: NOW } })], { max: ri.REMOTE_SERVERS_MAX * 10 }).servers;
  ri.setCollectorServers('c3', 'dc', wide);
  assert.notEqual(ri.findRemoteServer('r3').inv, wide[0].inv);
  // 미래 now 로 정제한 목록 — 표지하지 않는다(미래 시각이 잘리지 않은 채 보관되지 않게)
  const futNow = ri.sanitizeRemoteServers([edgeServer({ id: 'r4', inv: { collectedAt: FUT } })], { now: FUT + DAY }).servers;
  ri.setCollectorServers('c3', 'dc', futNow);
  const r4 = ri.findRemoteServer('r4');
  assert.ok(r4.inv.collectedAt <= Date.now(), '저장 단계에서 다시 잘린다');
});
