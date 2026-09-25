/**
 * storageFault2615.test.js — 스토리지 '장애 장비' 검토 반영(v2.615)의 서버 쪽 회귀 고정.
 *
 *  SF-R1-02  수집기가 **전 노드 기준** 상태 미확인 수(`nodes.unknown`)를 싣는다 — 목록은 64대로 잘리므로
 *            웹이 목록만 보면 상한 밖 노드의 '못 읽음' 을 정상으로 단정한다(66노드 클러스터 실재).
 *  SF-R1-04  비정상 계수가 화면 판정(nodeHealthKind == storage/healthWord.js)과 같은 규칙이다 — 예전 Isilon SSH
 *            (`!== 'OK'`)·XtremIO REST·VPLEX REST 는 'n/a' 를 비정상으로 세 요약과 목록이 어긋났다.
 *  SF-R1-03  엣지가 올린 `nodes.list` 는 객체 원소·아는 필드·상한 64로 좁혀 저장한다(null 원소가 화면을 죽였다).
 *  SF2-08    비-admin 응답의 노드 IP(클러스터 내부·관리 주소)를 가린다(기존 결함).
 *  SF-R1-01  목록 응답이 담당 노드별 수집 주기(`pollMsByAgent`)를 싣는다 — 화면이 낡은 보고를 정상으로 세지 않게.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sf2615-'));
process.env.CONFIG_DIR = TMP;

const dev = (type) => ({ id: `d-${type}`, name: type, type, host: '10.0.0.9' });

test('SF-R1-02: Isilon REST — 66노드 중 목록 밖 2대 상태 미확인도 nodes.unknown 으로 센다', async () => {
  const { normalizeIsilon } = await import('../src/storage/collectors/isilon.js');
  const nodes = Array.from({ length: 66 }, (_, i) => ({ lnn: i + 1, id: i + 1, status: i >= 64 ? {} : { health: 'OK' } }));
  const s = normalizeIsilon(dev('isilon'), { nodes: { nodes } });
  assert.equal(s.nodes.count, 66);
  assert.equal(s.nodes.list.length, 64);
  assert.equal(s.nodes.unhealthy, 0);
  assert.equal(s.nodes.unknown, 2, '목록 밖 노드의 상태 미확인이 사라졌다');
});

test('SF-R1-02 · SF-R1-04: Isilon SSH — n/a·빈 칸은 비정상이 아니라 상태 미확인, -A- 는 그대로 비정상', async () => {
  const { normalizeIsiStatus } = await import('../src/storage/collectors/isilonSsh.js');
  const nodes = Array.from({ length: 66 }, (_, i) => ({ id: i + 1, ip: '', health: i === 64 ? 'n/a' : i === 65 ? '' : 'OK' }));
  nodes[3].health = '-A-';
  const s = normalizeIsiStatus(dev('isilon'), { name: 'ISI', nodes });
  assert.equal(s.nodes.count, 66);
  assert.equal(s.nodes.unhealthy, 1, "예전 !== 'OK' 는 n/a 를 비정상으로 세 2 였다");
  assert.equal(s.nodes.unknown, 2);
});

test('SF-R1-04: XtremIO REST — n/a 는 상태 미확인, failed 는 비정상(계수 = healthWord)', async () => {
  const { normalizeXtremio } = await import('../src/storage/collectors/xtremio.js');
  const s = normalizeXtremio(dev('xtremio'), {
    controllers: [
      { name: 'SC1', 'health-state': 'healthy' }, { name: 'SC2', 'health-state': 'n/a' }, { name: 'SC3', 'health-state': 'failed' },
    ],
  });
  assert.equal(s.nodes.unhealthy, 1, "예전 규칙은 n/a 를 비정상으로 세 2 였다");
  assert.equal(s.nodes.unknown, 1);
});

test('SF-R1-04: VPLEX REST — n/a 는 상태 미확인, critical-failure 는 비정상', async () => {
  const { normalizeVplex } = await import('../src/storage/collectors/vplex.js');
  const s = normalizeVplex(dev('vplex'), {
    clusters: [{ name: 'c1', health: 'ok' }],
    directors: [{ name: 'd1', health: 'ok' }, { name: 'd2', health: 'n/a' }, { name: 'd3', health: 'critical-failure' }, { name: 'd4' }],
  });
  assert.equal(s.nodes.unhealthy, 1);
  assert.equal(s.nodes.unknown, 2);
});

test('SF-R1-02: Unity REST 의 health 0(UNKNOWN)·PowerStore(상태를 주지 않음)도 unknown 을 싣는다', async () => {
  const { normalizeUnity } = await import('../src/storage/collectors/unity.js');
  const wrap = (list) => ({ entries: list.map((content) => ({ content })) });
  const u = normalizeUnity(dev('unity480'), { sps: wrap([{ name: 'SPA', health: { value: 5 } }, { name: 'SPB', health: { value: 0 } }]) });
  assert.equal(u.nodes.unhealthy, 0);
  assert.equal(u.nodes.unknown, 1);
  const { normalizePowerstore } = await import('../src/storage/collectors/powerstore.js');
  const p = normalizePowerstore(dev('powerstore'), { nodes: [{ slot: 0 }, { slot: 1 }] });
  assert.equal(p.nodes.unhealthy, 0);
  assert.equal(p.nodes.unknown, 2);
});

test('SF-R1-03: 엣지 스냅샷의 노드 목록 — 객체 원소만·아는 필드만·상한 64, 뺀 개수는 listDropped', async () => {
  const { sanitizeEdgeDevices, sanitizeNodeList, NODE_LIST_MAX } = await import('../src/central/edgeRecord.js');
  const list = [null, 'x', [1], { id: 1, health: 'ok', ip: { a: 1 }, secret: 'zzz', inBps: '12', hdd: { totalBytes: '10', usedBytes: null, pct: 5 } }];
  for (let i = 0; i < 70; i++) list.push({ id: i + 2, health: 'ok' });
  const r = sanitizeEdgeDevices([{ deviceId: 'd1', nodes: { count: '72', unhealthy: '0', unknown: '1', list } }]);
  const n = r.devices[0].nodes;
  assert.equal(n.count, 72);
  assert.equal(n.unknown, 1, 'nodes.unknown 도 숫자로 좁힌다');
  assert.equal(n.list.length, NODE_LIST_MAX);
  assert.equal(n.listDropped, 3 + 7, '비객체 3 + 상한 초과 7 을 밝힌다');
  assert.equal(n.list[0].ip, null, '객체 ip 는 null');
  assert.equal('secret' in n.list[0], false, '모르는 필드는 담지 않는다');
  assert.equal(n.list[0].inBps, 12);
  assert.deepEqual(n.list[0].hdd, { totalBytes: 10, usedBytes: null, pct: 5 });
  assert.ok(r.coerced > 0);
  // 목록이 배열이 아니면 빈 목록 + 사실을 밝힌다. 목록이 없으면 손대지 않는다.
  const o = { nodes: { count: 1, list: 'bad' } };
  sanitizeNodeList(o);
  assert.deepEqual(o.nodes, { count: 1, list: [], listDropped: 1 });
  const o2 = { nodes: { count: 1, unhealthy: 0 } };
  assert.equal(sanitizeNodeList(o2), 0);
  assert.deepEqual(o2.nodes, { count: 1, unhealthy: 0 });
});

test('SF2-08: 비-admin 응답(maskSnapAddress)은 노드 IP 를 비우고, 주소 그대로인 노드 이름은 라벨로 바꾼다', async () => {
  const { maskSnapAddress, maskDeviceAddress } = await import('../src/auth/addressMask.js');
  const snap = { host: '10.0.0.9', nodes: { count: 2, unhealthy: 1, list: [
    { id: 1, name: 'n1', ip: '10.1.0.1', health: 'ok' }, { id: 2, name: '10.1.0.2', ip: '10.1.0.2', health: 'down' }, null,
  ] } };
  const m = maskSnapAddress(snap);
  assert.equal(m.nodes.list[0].ip, '');
  assert.equal(m.nodes.list[0].name, 'n1', '주소가 아닌 이름은 그대로');
  assert.equal(m.nodes.list[1].ip, '');
  assert.notEqual(m.nodes.list[1].name, '10.1.0.2');
  assert.equal(m.nodes.list[2], null, '원소를 지어내지 않는다');
  assert.equal(m.nodes.count, 2);
  assert.equal(snap.nodes.list[0].ip, '10.1.0.1', '원본을 바꾸지 않는다');
  assert.equal(JSON.stringify(maskDeviceAddress({ id: 'x', host: '10.0.0.9', snap })).includes('10.1.0.'), false);
});

test('SF-R1-01: 목록 응답이 담당 노드별 수집 주기(pollMsByAgent)를 싣고, 통합 추이와 같은 계산을 쓴다', async () => {
  const { devicePollMsByAgent } = await import('../src/routes/api/storageMon.js');
  const { envPoll, pollOf } = devicePollMsByAgent([{ id: 'a', agent: '' }, { id: 'b', agent: 'GM1' }, { id: 'c', agent: 'GM1' }]);
  assert.ok(envPoll > 0);
  assert.deepEqual([...pollOf.keys()], ['', 'GM1']);
  for (const v of pollOf.values()) assert.ok(Number.isFinite(v) && v > 0);
  const src = fs.readFileSync(new URL('../src/routes/api/storageMon.js', import.meta.url), 'utf8');
  assert.match(src, /pollMsByAgent: \(\(\) => \{/);
  // 통합 추이(v2.600 DB2600-01)도 같은 헬퍼를 쓴다 — 두 곳이 따로 계산하면 모순이 생긴다.
  assert.match(src, /const \{ envPoll, pollOf \} = devicePollMsByAgent\(devs\);/);
});
