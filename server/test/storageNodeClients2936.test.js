/**
 * storageNodeClients2936.test.js — 아이실론 노드 2차(v2.936): 디스크 busy·IOPS(②) · 클라이언트·프로토콜(③) · 표본 주기 분리(⑨) · 노드 드로어 · 재배치 보드.
 *
 * 사용자 요청(2026-11-07 14:32): "나머지 추천 ②③⑨도 진행해 · 특정 노드를 클릭하면 그 노드에서 연결된 클라이언트가 어떤 프로토콜을 사용해서 노드를
 *   사용하고 있는지 · 특정 노드에 치우치는 이슈가 있어서 노드에 연결된 서버를 확인해서 재배치". 설계 docs/design/isilon-node-clients/README.md.
 *
 * 고정하는 것:
 *  ① 파서 — 요약 세 모양(배열 · {stats|clients:[…]} · 못 읽음 null) · 같은 노드+IP+프로토콜 합산 · 지연 µs→ms · 프로토콜 별칭 · 드라이브 busy 평균/최대·IOPS ·
 *       REST 표본 노드(devid→lnn 대응표 · B/s×8) · `isi statistics system` 의 net 은 옵션(1시간 경로 동작 불변)
 *  ② 정제 — 아는 필드만 · 노드 64 · 클라이언트 상한 · 문자열 수치는 수로 · ts 는 수신 시각 이하 · 새 노드 필드가 엣지 화이트리스트에 있다
 *  ③ 재배치 판정(순수) — 행렬·비중·고정 · 쏠림(ops 0 노드도 분모) · 탐욕 후보(옮겨도 최대가 안 내려가면 멈춤)
 *  ④ DB — 표본 1개 = 트랜잭션 1개 · 같은 (장비, ts) 재전송 무시 · 클라이언트/프로토콜 시간·일 요약 · 보존 칸 4개(기본 7·90·2·30·365) · 원시 보존 밖 창은 시간 요약
 *  ⑤ 폴러 — 주기 nodeLoadMs(기본 5분 · 상한 60분) · 대상(아이실론 · 활성 · 토글 기본 켬) · 장비 점유 공유 · 미전송 고리(장비당 3) · 등록부 토글 규약
 *  ⑥ 중앙 수신 — 표본 고리 정제·중복·상한 · 응답 확인(ack)을 push 가 공용 판독기로 읽는다 · storage-data 라우트가 같은 소유권 필터를 지난다(소스 대조)
 *  ⑦ 실제 api — node-load(프로토콜 묶음 표 · 디스크 묶음 4지표 · 표본 켜진 장비는 15분 칸) · node-clients(지금·창·비중·고정·다른 노드 · node 없으면 400) ·
 *       client-dist(쏠림·후보·프로토콜 필터·note) · 범위 계정 403 · 데모 404
 *  ⑧ 이름 — VM IP · 호스트 관리 IP · 장비 보고 이름 우선 · 같은 IP 둘은 ambiguous · 비정규 표기는 같은 IP 가 아니다 · 역방향 DNS 호출 없음(소스 대조)
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import url from 'node:url';
import express from 'express';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeclients2935-'));
Object.assign(process.env, { CONFIG_DIR: TMP, DATA_SOURCE: 'live', AUTH_ENABLED: 'false' });
delete process.env.CENTRAL_URL; delete process.env.CENTRAL_TOKEN;
for (const k of ['STORAGE_NODELOAD_KEEP_DAYS', 'STORAGE_NODELOAD_HOURLY_KEEP_DAYS', 'STORAGE_NODECLIENT_KEEP_DAYS', 'STORAGE_NODECLIENT_HOURLY_KEEP_DAYS', 'STORAGE_NODECLIENT_DAILY_KEEP_DAYS', 'STORAGE_NODELOAD_MS', 'STORAGE_NODELOAD_TIMEOUT_MS']) delete process.env[k];
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const here = path.dirname(url.fileURLToPath(import.meta.url));
const src = (p) => fs.readFileSync(path.join(here, '..', 'src', p), 'utf8');
const H = 3_600_000; const D = 24 * H; const M5 = 300_000;
const NOW = Math.floor(Date.now() / H) * H; // 정시 경계로 고정(docs/rules/common.md)
// ⚠ 동적 import 는 전부 여기서(테스트 사이 top-level await 금지).
const NL = await import('../src/storage/collectors/isilonNodeLoad.js');
const M = await import('../src/storage/nodeLoad.js');
const db = await import('../src/storage/db.js');
const GS = await import('../src/storage/growthSettings.js');
const IV = await import('../src/storage/intervals.js');
const REG = await import('../src/storage/registry.js');
const POL = await import('../src/storage/poller.js');
const NLP = await import('../src/storage/nodeLoadPoller.js');
const SE = await import('../src/central/storageEdge.js');
const CR = await import('../src/util/centralReply.js');
const CN = await import('../src/storage/clientNames.js');
const { NODE_NUM_KEYS, sanitizeNodeList } = await import('../src/central/edgeRecord.js');
const { api } = await import('../src/routes/api.js');

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
async function call(urlPath, user = { username: 'root', role: 'admin', scope: {} }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use('/api', api);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(500).json({ error: String(err?.message || err) }));
  const srv = http.createServer(app); const port = await listen(srv);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api${urlPath}`);
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally { srv.closeAllConnections?.(); srv.close(); }
}

/** 표본(수집기 buildNodeLoadSample 결과 모양) — 노드 2 가 쏠린다(A 가 nfs 900 ops 고정) · 노드 3 은 클라이언트 0. */
function sampleAt(ts, { skew = 1 } = {}) {
  const cl = (ip, name, proto, ops) => ({ ip, name, proto, ops, in: ops * 1000, out: ops * 4000, lat: 1.5 });
  return {
    ts,
    nodes: [
      { id: 1, in: 1e6, out: 2e6, din: 1e5, dout: 2e5, cpu: 20, ops: 150, lat: 1.5, busy: 30, iops: 900, proto: { nfs: { ops: 150, lat: 1.5, in: 150_000, out: 600_000 } },
        clients: [cl('10.1.1.3', '', 'nfs', 100), cl('10.1.1.1', '', 'nfs', 50)] },
      { id: 2, in: 3e6, out: 5e6, din: 4e5, dout: 6e5, cpu: 61, ops: 1200 * skew, lat: 2.4, busy: 71, iops: 2600, proto: { nfs: { ops: 900 * skew, lat: 2.6, in: 0, out: 0 }, smb: { ops: 300 * skew, lat: 1.9, in: 0, out: 0 } },
        clients: [cl('10.1.1.1', '', 'nfs', 900 * skew), cl('10.1.1.2', 'file-srv', 'smb', 300 * skew)] },
      { id: 3, in: 5e5, out: 1e6, din: null, dout: null, cpu: 5, ops: 0, lat: null, busy: 4, iops: 10, proto: null, clients: [] },
    ],
    probe: { source: 'test', total: 3, clients: 2, proto: 2, drives: 3, latUnit: 'ms' },
  };
}

/* ── ① 파서 ─────────────────────────────────────────────────────────── */
test('① 파서 — 요약 세 모양 · 합산 · µs→ms · 별칭 · 드라이브 · REST 표본 노드 · system 통계 net 옵션', () => {
  assert.equal(NL.summaryRowsOf('not json'), null);
  assert.equal(NL.summaryRowsOf({ foo: 1 }), null);
  assert.equal(NL.summaryRowsOf('[{"a":1},5,null]').length, 1);
  assert.equal(NL.summaryRowsOf({ clients: [{ a: 1 }] }).length, 1);
  const rows = NL.parseClientRows(JSON.stringify({ client: [
    { node: 2, remote_addr: '10.1.1.1', remote_name: 'vm-a', protocol: 'nfs3', operation_rate: 100, in: 10, out: 20, time_avg: 2500 },
    { node: 2, remote_addr: '10.1.1.1', protocol: 'NFS v4', operation_rate: 50, in: 5, out: 5, time_avg: 500 },
    { node: 2, remote_addr: '10.1.1.9', protocol: 'smb2', operation_rate: '7', in: null },
    { remote_addr: '10.1.1.8', protocol: 'nfs', operation_rate: 1 }, { node: 1, protocol: 'nfs' },
  ] }));
  assert.equal(rows.length, 2, '노드·IP 없는 행은 뺀다 · nfs3/nfs4 는 nfs 하나로 합친다');
  const a = rows.find((r) => r.ip === '10.1.1.1');
  assert.deepEqual([a.node, a.proto, a.name, a.ops, a.in, a.out, a.lat], [2, 'nfs', 'vm-a', 150, 15, 25, 1.5], '합 · 지연은 단순 평균(2.5·0.5 ms)');
  const b = rows.find((r) => r.ip === '10.1.1.9');
  assert.deepEqual([b.proto, b.ops, b.in], ['smb', 7, null], '문자열 수치는 수로 · 못 읽은 값은 null');
  const pr = NL.parseProtocolRows([{ node: 1, protocol: 'nfs', operation_rate: 100, time_avg: 1000 }, { node: 1, protocol: 'nfs', operation_rate: 300, time_avg: 3000 }, { node: 1, protocol: 'http', operation_rate: 0 }, { protocol: 'nfs' }]);
  assert.equal(pr.length, 2);
  assert.deepEqual([pr[0].ops, pr[0].lat], [400, 2.5], 'ops 가중 평균(1ms×100 + 3ms×300)/400');
  const dr = NL.parseDriveRows([{ node: 1, drive: 1, busy: 20, xfers_in: 10, xfers_out: 5 }, { node: 1, drive: 2, busy: 60, xfers_in: 1, xfers_out: 1 }, { node: 2, drive: 1 }]);
  assert.deepEqual(dr.find((d) => d.node === 1), { node: 1, busyAvg: 40, busyMax: 60, iops: 17, drives: 2 });
  assert.deepEqual(dr.find((d) => d.node === 2), { node: 2, busyAvg: null, busyMax: null, iops: null, drives: 1 }, '읽지 못한 드라이브는 null(0 이 아니다)');
  // REST 표본 노드 — devid→lnn 대응표 · 네트워크 B/s×8 · 디스크·CPU·busy·IOPS 키
  const st = { stats: [
    { devid: 7, key: 'node.net.ext.bytes.in.rate', value: 1000 }, { devid: 7, key: 'node.disk.bytes.in.rate.sum', value: 50 }, { devid: 7, key: 'node.cpu.idle.avg', value: 700 },
    { devid: 7, key: 'node.disk.busy.avg', value: 33 }, { devid: 7, key: 'node.disk.xfers.in.rate.sum', value: 10 }, { devid: 7, key: 'node.disk.xfers.out.rate.sum', value: 5 },
    { devid: 8, key: 'node.net.ext.bytes.out.rate', value: '20' }, { devid: null, key: 'x', value: 1 }, 'junk',
  ] };
  const map = NL.nodeIdMapOf({ nodes: [{ id: 7, lnn: 1 }, { id: 8, lnn: 2 }, { id: 'x' }] });
  const nodes = NL.restSampleNodes(st, map);
  assert.deepEqual(nodes.map((n) => n.id), [1, 2]);
  assert.deepEqual([nodes[0].inBps, nodes[0].diskInBytesPs, nodes[0].cpuPct, nodes[0].busyPct, nodes[0].iops, nodes[0].outBps], [8000, 50, 30, 33, 15, null]);
  assert.deepEqual([nodes[1].outBps, nodes[1].inBps], [160, null], '문자열 수치는 수로 · 없는 키는 null');
  assert.deepEqual(NL.restSampleNodes(st, null).map((n) => n.id), [7, 8], '대응표가 없으면 devid 그대로');
  assert.equal(NL.nodeIdMapOf({}), null);
  const sys = JSON.stringify([{ node: 1, 'Disk In': 10, 'Net In': 100, 'Net Out': 200, CPU: 12.5 }]);
  assert.deepEqual(NL.parseIsiSystemStats(sys).get(1), { diskInBytesPs: 10, cpuPct: 12.5 }, '1시간 경로(net 옵션 없음)는 예전 그대로 — isi status 처리량을 덮지 않는다');
  assert.deepEqual(NL.parseIsiSystemStats(sys, { net: true }).get(1), { diskInBytesPs: 10, cpuPct: 12.5, inBps: 800, outBps: 1600 }, '표본 경로는 Net In/Out(B/s 가정 ×8)도 읽는다');
  // 조립 — 클라이언트 상한 · probe
  const s = NL.buildNodeLoadSample({ ts: NOW, nodes: [{ id: 1, inBps: 1 }, { id: 2 }], clients: Array.from({ length: 15 }, (_, i) => ({ node: 1, ip: `10.0.0.${i + 1}`, proto: 'nfs', ops: i })), protocols: null, drives: [{ node: 1, busyAvg: 10, busyMax: 20, iops: 5, drives: 3 }], clientLimit: 10, source: 'x' });
  assert.equal(s.nodes[0].clients.length, 10); assert.equal(s.nodes[0].clients[0].ip, '10.0.0.15', 'ops 큰 순');
  assert.deepEqual([s.nodes[0].busy, s.nodes[0].busyMax, s.nodes[0].iops, s.nodes[1].busy], [10, 20, 5, null]);
  assert.deepEqual([s.probe.clientsRead, s.probe.protocolsRead, s.probe.drivesRead, s.probe.latUnit], ['ok', 'none', 'ok', NL.LAT_UNIT_NOTE]);
});

/* ── ② 정제 ─────────────────────────────────────────────────────────── */
test('② 정제 — 아는 필드만 · 상한 · 문자열 수치 · ts 자르기 · 엣지 노드 화이트리스트', () => {
  const raw = { ts: String(NOW + 60_000), nodes: [
    { id: '2', in: '100', busy: 150, iops: -1, proto: { 'NFS v3': { ops: '9', lat: 1 }, __proto__junk: 'x', http: null }, clients: Array.from({ length: 60 }, (_, i) => ({ ip: `10.0.0.${i}`, proto: 'smb2', ops: i })), evil: 1 },
    { id: 2 }, { id: 'x' }, null, { id: 3, clients: [{ ip: 'bad\u0000ip' }, { ip: '' }, { ip: '10.0.0.9', name: 'n'.repeat(200) }] },
  ], probe: { source: 'a', bad: {}, n: 1 } };
  const s = M.sanitizeNodeLoadSample(raw, { maxTs: NOW });
  assert.equal(s.ts, NOW, '엣지 시각은 수신 시각 이하로');
  assert.deepEqual(s.nodes.map((n) => n.id), [2, 3], '중복·비정수 id 는 뺀다');
  assert.deepEqual([s.nodes[0].in, s.nodes[0].busy, s.nodes[0].iops], [100, null, null], '문자열 수치는 수로 · 범위 밖(%>100 · 음수)은 null');
  assert.deepEqual(Object.keys(s.nodes[0].proto), ['nfs'], '별칭 통일 · 객체 아닌 값 제외');
  assert.equal(s.nodes[0].clients.length, M.CLIENT_LIMIT_DEF, '클라이언트 상한(기본 10)');
  assert.equal(s.nodes[0].evil, undefined);
  assert.deepEqual(s.nodes[1].clients.map((c) => c.ip), ['badip', '10.0.0.9'], '제어 문자는 지우고 빈 IP 는 뺀다');
  assert.equal(s.nodes[1].clients[1].name.length, 80);
  assert.deepEqual(s.probe, { source: 'a', n: 1 });
  assert.equal(M.sanitizeNodeLoadSample({ ts: NOW, nodes: [] }), null);
  assert.equal(M.sanitizeNodeLoadSample({ ts: 0, nodes: [{ id: 1 }] }), null);
  assert.equal(M.sampleRowsOf('d', { ts: NOW, nodes: [{ id: 1 }] }).reason, 'no-load');
  const r = M.sampleRowsOf('d', sampleAt(NOW));
  assert.equal(r.ok, true); assert.equal(r.clients.length, 4); assert.equal(r.protos.length, 3); assert.equal(r.nodes.length, 3);
  for (const k of ['busyPct', 'iops', 'opsPs', 'latencyMs']) assert.ok(NODE_NUM_KEYS.includes(k), `엣지 노드 화이트리스트에 ${k}`);
  const o = { nodes: { count: 1, list: [{ id: 1, busyPct: '12', iops: { a: 1 }, opsPs: 5 }] } };
  sanitizeNodeList(o);
  assert.deepEqual([o.nodes.list[0].busyPct, o.nodes.list[0].iops, o.nodes.list[0].opsPs], [12, null, 5], '엣지 노드 값 — 문자열 수치는 수로 · 객체는 null');
});

/* ── ③ 재배치 판정 ───────────────────────────────────────────────────── */
test('③ 재배치(순수) — 행렬·비중·고정 · 쏠림(ops 0 노드도 분모) · 탐욕 후보 · 별칭', () => {
  const rows = [{ client: 'a', node: 4, ops: 90, proto: 'nfs' }, { client: 'a', node: 2, ops: 10 }, { client: 'b', node: 4, ops: 40 }, { client: 'b', node: 1, ops: 40 }, { client: 'c', node: 1, ops: 5 }, { client: 'z', node: 1, ops: null }];
  const mx = M.clientNodeMatrix(rows, { fixedShare: 0.9 });
  assert.deepEqual(mx.clients.map((c) => c.client), ['a', 'b', 'c'], 'ops 합 내림차순 · 값 없는 행은 뺀다');
  assert.deepEqual([mx.clients[0].top, mx.clients[0].topShare, mx.clients[0].fixed], [4, 90, true]);
  assert.deepEqual([mx.clients[1].fixed, mx.clients[1].topShare], [false, 50]);
  assert.deepEqual(mx.nodeTotals, { 1: 45, 2: 10, 4: 130 });
  const sk = M.nodeSkew(mx.nodeTotals, [1, 2, 3, 4], { factor: 1.5 });
  assert.equal(sk.mean, 185 / 4);
  assert.deepEqual(sk.nodes.map((n) => [n.id, n.total, n.skew]), [[1, 45, false], [2, 10, false], [3, 0, false], [4, 130, true]], '노드 3(ops 0)도 분모');
  const c = M.rebalanceCandidates(mx, sk);
  assert.equal(c.length, 1);
  assert.deepEqual([c[0].client, c[0].from, c[0].to, c[0].ops, c[0].fromAfter, c[0].toAfter], ['a', 4, 3, 90, 40, 90], '가장 한가한 노드 3 으로 · a 의 노드 2 몫은 그대로');
  assert.deepEqual(M.rebalanceCandidates(mx, M.nodeSkew(mx.nodeTotals, [1, 2, 4], { factor: 9 })), [], '쏠린 노드가 없으면 후보 없음');
  assert.deepEqual(['nfs3', 'NFS v4', 'smb2', 'cifs', 'HTTPS', 's3', ''].map(M.protoKeyOf), ['nfs', 'nfs', 'smb', 'smb', 'http', 's3', '']);
});

/* ── ④ DB ─────────────────────────────────────────────────────────── */
test('④ DB — 표본 적재·중복 · 클라이언트/프로토콜 요약 · 노드 집합 · 보존 칸 4개 · 원시 보존 밖 창은 시간 요약', async () => {
  const id = 'dev-db';
  for (let k = 1; k <= 12; k++) assert.equal((await db.saveNodeLoadSample(id, sampleAt(NOW - k * M5))).saved, true);
  assert.equal((await db.saveNodeLoadSample(id, sampleAt(NOW - M5))).duplicate, true, '같은 (장비, ts) 재전송은 아무것도 쓰지 않는다');
  assert.equal((await db.saveNodeLoadSample(id, { ts: NOW, nodes: [{ id: 1 }] })).reason, 'no-load');
  const cq = await db.nodeClientsQuery(id, { from: NOW - 2 * H, to: NOW });
  assert.equal(cq.source, 'hourly');
  const a2 = cq.rows.find((r) => r.node === 2 && r.client === '10.1.1.1');
  assert.deepEqual([a2.proto, a2.samples, a2.ops, a2.opsSum], ['nfs', 12, 900, 10800], '12 표본 평균 900 · 합 10,800');
  assert.equal(cq.rows.find((r) => r.node === 2 && r.client === '10.1.1.2').name, 'file-srv');
  const lt = await db.nodeClientsLatest(id, 2, NOW - H);
  assert.equal(lt.ts, NOW - M5); assert.deepEqual(lt.rows.map((r) => r.client), ['10.1.1.1', '10.1.1.2'], 'ops 내림차순');
  assert.deepEqual((await db.nodeClientsLatest(id, 3, NOW - H)).rows, [], '노드 3 은 클라이언트 0');
  const pq = await db.nodeProtoQuery(id, { from: NOW - 2 * H, to: NOW });
  const smb = pq.rows.find((r) => r.node === 2 && r.proto === 'smb');
  assert.deepEqual([smb.ops, smb.opsMax, Math.round(smb.lat * 10) / 10, smb.samples], [300, 300, 1.9, 12]);
  assert.deepEqual(await db.nodeLoadNodeIds(id, { from: NOW - 2 * H, to: NOW }), [1, 2, 3], '값이 비어도 노드 행이 있으면 집합에 든다');
  const o = await db.nodeClientOldest(id);
  assert.equal(o.sampleTs, NOW - 12 * M5); assert.equal(o.hourTs, Math.floor((NOW - 12 * M5) / H) * H);
  // 디스크 묶음 조회 — busy·iops 열이 원시·시간 요약에 있다
  const dq = await db.nodeLoadQuery(id, { group: 'disk', kind: 'raw', from: NOW - 2 * H, to: NOW });
  assert.deepEqual(Object.keys(dq.rows[0].v), ['din', 'dout', 'busy', 'iops']);
  assert.equal(dq.rows.find((r) => r.node === 2).v.busy, 71);
  // 보존 칸 4개 + 기본값
  const keep = db.effectiveKeepDays();
  assert.deepEqual([keep.nodeRaw, keep.nodeHourly, keep.clientRaw, keep.clientHourly, keep.clientDaily], [7, 90, 2, 30, 365]);
  for (const k of ['nodeLoadRawKeepDays', 'nodeLoadHourlyKeepDays', 'nodeClientRawKeepDays', 'nodeClientHourlyKeepDays', 'nodeClientDailyKeepDays']) {
    const s = GS.GROWTH_SPEC.find((x) => x.key === k); assert.ok(s && s.presets.length >= 3 && s.hint.length > 20, `보존 칸 ${k}`);
  }
  const v = GS.loadGrowthSettings();
  assert.deepEqual([v.nodeClientRawKeepDays, v.nodeClientRawKeepDaysSource], [2, 'default']);
  // 보존 — 3일 전 클라이언트 원시는 지워지고 시간 요약(30일)·노드 시간 요약(90일)은 남는다
  const old = NOW - 3 * D;
  assert.equal((await db.saveNodeLoadSample('dev-old', sampleAt(old))).saved, true);
  assert.equal((await db.saveNodeLoadPoint({ deviceId: 'dev-old2', ok: true, collectedAt: NOW - 20 * D, sections: { nodes: 'ok' }, nodes: { count: 1, list: [{ id: 1, inBps: 5 }] }, extra: {} })).saved, true);
  await db.pruneNow();
  assert.equal((await db.nodeClientOldest('dev-old')).sampleTs, null, '클라이언트 원시(2일)는 지워진다');
  assert.notEqual((await db.nodeClientOldest('dev-old')).hourTs, null, '클라이언트 시간 요약(30일)은 남는다');
  assert.equal((await db.nodeClientsQuery('dev-old', { from: old - H, to: old + H })).rows.length, 4);
  assert.equal((await db.nodeLoadOldest('dev-old2')).sampleTs, null, '노드 원시(7일)는 지워진다');
  const hb = await db.nodeLoadQuery('dev-old2', { group: 'net', kind: 'bucket', from: NOW - 21 * D, to: NOW - 19 * D, bucketMs: H });
  assert.equal(hb.source, 'hourly'); assert.equal(hb.rows.length, 1); assert.equal(hb.rows[0].v.in, 5, '원시 보존 밖 창은 시간 요약(90일)으로 — 원시 폴백이 아니다');
});

/* ── ⑤ 폴러 ─────────────────────────────────────────────────────────── */
test('⑤ 폴러 — 주기 항목 · 대상 · 장비 점유 공유 · 미전송 고리 · 등록부 토글 · 서비스 점검 대응표', async () => {
  const spec = IV.INTERVAL_SPEC.find((s) => s.key === 'nodeLoadMs');
  assert.deepEqual([spec.def, spec.min, spec.max], [5 * 60_000, 60_000, 60 * 60_000]);
  assert.equal(IV.envIntervals().nodeLoadMs, 5 * 60_000);
  const n = IV.normalizeIntervals({ nodeLoadMs: 3 * H, pollMs: 48 * H, areasMs: '' });
  assert.deepEqual(n.values, { nodeLoadMs: H, pollMs: 24 * H }, '항목별 상한(60분) · 공통 상한(24시간) · 빈 값은 미설정');
  assert.ok(n.issues.some((s) => /노드 부하 표본 주기: 상한 60분/.test(s)));
  // v2.949: REST 어레이(unity480 · collectMethod 기본 api)도 표본 대상이다(디렉터 · 노드 · SP 성능 — arrayPerf.js). SSH 변형은 제외.
  assert.deepEqual(NLP.sampleTargets([{ type: 'isilon', id: 'a' }, { type: 'isilon', id: 'b', nodeLoadEnabled: false }, { type: 'unity480', id: 'c' }, { type: 'isilon', id: 'd', enabled: false }, null,
    { type: 'unity480', id: 'e', collectMethod: 'ssh' }, { type: 'powermax', id: 'f', collectMethod: 'api', nodeLoadEnabled: false }]).map((d) => d.id), ['a', 'c']);
  // 장비 점유 — 표본 둘은 겹치지 않고, 두 번째는 IN_FLIGHT_BUSY
  const dev = { id: 'ex-1' }; const order = [];
  const p1 = POL.runSampleExclusive(dev, async () => { order.push('s'); await new Promise((r) => setTimeout(r, 20)); order.push('e'); return 'done'; });
  assert.equal(await POL.runSampleExclusive(dev, async () => 'second'), POL.IN_FLIGHT_BUSY);
  assert.deepEqual(POL.sampleInFlightIds(), ['ex-1']);
  assert.equal(await p1, 'done'); assert.deepEqual(POL.sampleInFlightIds(), []);
  assert.equal(await POL.runSampleExclusive(dev, async () => 'again'), 'again', '끝난 뒤에는 다시 들어간다');
  // 미전송 고리 — 장비당 RING_MAX · 보낸 것만 지운다(보내는 동안 들어온 새 표본은 남는다)
  NLP._resetForTest();
  for (let k = 1; k <= 5; k++) NLP._ringPushForTest('r1', { ts: NOW + k, nodes: [] });
  let pend = NLP.pendingNodeLoadSamples();
  assert.equal(pend[0].samples.length, NLP.RING_MAX); assert.equal(pend[0].samples[0].ts, NOW + 3, '가장 오래된 것부터 버린다');
  assert.equal(NLP.nodeLoadPollerStatus().ring.dropped, 2, '버린 수를 상태에 센다(무음 금지)');
  NLP._ringPushForTest('r1', { ts: NOW + 9, nodes: [] }); // 보내는 동안 들어온 표본
  NLP.markNodeLoadSamplesSent(pend);
  pend = NLP.pendingNodeLoadSamples();
  assert.deepEqual(pend.map((d) => d.samples.map((s) => s.ts)), [[NOW + 9]]);
  NLP.markNodeLoadSamplesSent(pend); assert.deepEqual(NLP.pendingNodeLoadSamples(), []);
  const st = NLP.nodeLoadPollerStatus();
  assert.deepEqual([st.intervalMs, st.timeoutMs, st.edge, st.ring.max], [5 * 60_000, 60_000, false, 3]);
  // 한 주기 — 아이실론 0대면 대상 0 으로 상태를 올린다(무음 금지)
  const r = await NLP.pollNodeLoadOnce();
  assert.equal(r.targets, 0); assert.equal(r.ok, 0); assert.equal(typeof r.at, 'number');
  // 등록부 토글 — 아이실론 기본 켬 · false 는 보존 · 다른 타입은 필드 없음
  const a = REG.saveDevice({ type: 'isilon', name: 'isi-t1', host: '10.9.9.1', username: 'u', password: 'p', collectMethod: 'api' });
  assert.equal(REG.listDevices().find((d) => d.id === a.id).nodeLoadEnabled, true);
  REG.saveDevice({ ...a, nodeLoadEnabled: false, password: 'p' });
  assert.equal(REG.listDevices().find((d) => d.id === a.id).nodeLoadEnabled, false);
  REG.saveDevice({ ...REG.getDeviceWithSecret(a.id), name: 'isi-t1b' });
  assert.equal(REG.listDevices().find((d) => d.id === a.id).nodeLoadEnabled, false, '다른 필드만 바꿔 저장해도 토글은 보존된다');
  // v2.949: REST 어레이(Unity · PowerStore · PowerMax · VMAX)는 같은 토글을 갖는다(디렉터 · 노드 · SP 성능 표본 — 기본 켬). SSH 변형은 경로가 없어 필드를 만들지 않는다.
  const u = REG.saveDevice({ type: 'unity480', name: 'un-1', host: '10.9.9.2', username: 'u', password: 'p', nodeLoadEnabled: true });
  assert.equal(REG.listDevices().find((d) => d.id === u.id).nodeLoadEnabled, true, 'REST 어레이는 토글을 갖는다(v2.949)');
  const us = REG.saveDevice({ type: 'unity480', name: 'un-2', host: '10.9.9.3', username: 'u', password: 'p', collectMethod: 'ssh', nodeLoadEnabled: true });
  assert.equal(REG.listDevices().find((d) => d.id === us.id).nodeLoadEnabled, undefined, 'SSH 변형은 필드를 만들지 않는다');
  // 서비스 점검·엣지 로그 표
  const { STATUS_SPEC } = await import('../src/edgelog/spec.js');
  const row = STATUS_SPEC.find((s) => s.key === 'collect.storageNodeLoad');
  assert.ok(row && row.mod === '../storage/nodeLoadPoller.js' && row.fn === 'nodeLoadPollerStatus');
  assert.ok(src('health/services.js').includes("'../storage/nodeLoadPoller.js':"));
  assert.ok(/startNodeLoadPoller/.test(src('index.js')), 'index.js 가 기동한다');
  // 수집 주기 폴러는 표본이 끝날 때까지 기다린다(소스 대조 — 표본 때문에 1시간 수집이 빠지지 않게)
  assert.ok(/const sp = _sampleFlight\.get\(dev\.id\);\s*\n\s*if \(sp\) await sp\.catch/.test(src('storage/poller.js')));
});

/* ── ⑥ 중앙 수신 ─────────────────────────────────────────────────────── */
test('⑥ 중앙 수신 — 표본 고리 정제·중복·상한 · 응답 확인을 push 가 공용 판독기로 읽는다 · 라우트는 같은 소유권 필터', async () => {
  const s = sampleAt(NOW - 7 * M5);
  const ack = await SE.saveEdgeNodeLoadSamples('edge-a', [
    { deviceId: 'dev-edge', samples: [s, s, { ...s, ts: NOW + 10 * H }, 'junk', { ts: NOW, nodes: [] }] },
    { deviceId: { x: 1 }, samples: [] }, 'bad', { deviceId: 'dev-edge2', samples: 'no' },
  ], { now: NOW });
  assert.deepEqual(ack, { devices: 1, received: 5, saved: 2, duplicate: 1, dropped: 5 }, '미래 ts 는 수신 시각으로 잘려 새 표본으로 적재 · 모양 아닌 것(junk · 빈 노드 · id 없음 · 객체 아님 · samples 아님) 5개는 뺀다');
  assert.equal((await db.nodeClientOldest('dev-edge')).sampleTs, NOW - 7 * M5);
  assert.equal((await db.nodeClientsLatest('dev-edge', 2, NOW - D)).ts, NOW, '미래 시각은 수신 시각(now)으로');
  const d = CR.dropSummaryOf({ ok: true, saved: 3, nodeLoadSamples: { devices: 1, received: 3, saved: 2, duplicate: 1, dropped: 0, dbUnavailable: true, evil: 'x' } });
  assert.deepEqual(d.nodeLoadSamples, { devices: 1, received: 3, saved: 2, duplicate: 1, dropped: 0, dbUnavailable: true });
  assert.equal(d.text, '', '확인만 있고 뺀 것이 없으면 경고 문장은 비운다');
  assert.equal(CR.dropSummaryOf({ ok: true, saved: 3 }), null, '구버전 중앙(확인 없음)은 예전처럼 null');
  assert.match(CR.dropSummaryOf({ nodeLoadSamples: { dropped: 2, notOwned: 1 } }).text, /노드 부하 표본 3개 받지 않음/);
  const push = src('storage/push.js');
  assert.ok(/nodeLoadSamples = pendingNodeLoadSamples\(\)/.test(push) && /markNodeLoadSamplesSent\(nodeLoadSamples\)/.test(push));
  assert.ok(/dropSummaryOf\(await readCentralReply\(res\)\)/.test(push), '공용 판독기 리터럴(EDGE2613-05)');
  const route = src('routes/central.js');
  const i = route.indexOf("centralRouter.post('/storage-data'"); const seg = route.slice(i, route.indexOf('\n});', i));
  assert.ok(/req\.body\?\.nodeLoadSamples/.test(seg) && /onlyDelegated\(list, \(d\) => d\.deviceId/.test(seg) && /ownedSet\.has\(String\(d\.deviceId\)\)/.test(seg), '표본 고리도 중앙 직접 장비 거절 + 개별 토큰 위임 필터');
  assert.ok(/nodeLoadSamples: sampleAck/.test(seg), '응답에 확인을 싣는다');
});

/* ── ⑦ 실제 api ─────────────────────────────────────────────────────── */
test('⑦ api — node-load(프로토콜 표 · 디스크 4지표 · 표본 켜진 장비 15분 칸) · node-clients · client-dist · 403 · 404', async () => {
  const dev = REG.saveDevice({ type: 'isilon', name: 'isi-api', host: '10.9.9.7', username: 'u', password: 'p', collectMethod: 'api' });
  const id = dev.id;
  for (let k = 1; k <= 12; k++) await db.saveNodeLoadSample(id, sampleAt(NOW - k * M5));
  const nl = await call(`/tools/storage/devices/${id}/node-load?range=24h&group=proto`);
  assert.equal(nl.status, 200);
  assert.deepEqual(nl.body.metrics, ['ops', 'lat']); assert.deepEqual(nl.body.units, { ops: 'ops/s', lat: 'ms' });
  assert.deepEqual([nl.body.kind, nl.body.bucketMs, nl.body.sampleMs, nl.body.sample.sampleEnabled], ['bucket', 15 * 60_000, 5 * 60_000, true], '표본 폴러(5분)가 켜진 장비는 15분 칸');
  assert.ok(Array.isArray(nl.body.protoTable) && nl.body.protoTable.some((r) => r.node === 2 && r.proto === 'smb' && r.ops === 300), '프로토콜 묶음은 노드 × 프로토콜 표를 싣는다');
  assert.deepEqual([nl.body.retention.rawDays, nl.body.retention.hourlyDays], [7, 90]);
  const disk = await call(`/tools/storage/devices/${id}/node-load?range=24h&group=disk`);
  assert.deepEqual(disk.body.metrics, ['din', 'dout', 'busy', 'iops']); assert.equal(disk.body.protoTable, undefined);
  assert.equal(disk.body.clusterAgg.busy, 'avg');
  // 노드 드로어
  const bad = await call(`/tools/storage/devices/${id}/node-clients`);
  assert.equal(bad.status, 400);
  const nc = await call(`/tools/storage/devices/${id}/node-clients?node=2`);
  assert.equal(nc.status, 200); assert.equal(nc.body.node, 2); assert.equal(nc.body.range, '24h');
  assert.deepEqual(nc.body.clients.map((c) => c.client), ['10.1.1.1', '10.1.1.2'], 'ops 합 내림차순');
  const a = nc.body.clients[0];
  assert.deepEqual([a.proto, a.ops, a.fixed, Math.round(a.share), a.otherNodes, a.name, a.nameSource], ['nfs', 900, true, 95, [1], '', null], '노드 2 비중 94.7% → 고정 · 노드 1 도 쓴다 · 인벤토리에 없어 이름 없음');
  assert.deepEqual([nc.body.clients[1].name, nc.body.clients[1].nameSource], ['file-srv', 'device'], '장비가 준 이름이 먼저다');
  assert.equal(nc.body.latest.ts, NOW - M5); assert.equal(nc.body.latest.rows.length, 2);
  assert.deepEqual(nc.body.names, { named: 0, device: 1, unknown: 1 });
  assert.equal(nc.body.protos.length, 2); assert.equal(nc.body.lateMs, 15 * 60_000);
  const n3 = await call(`/tools/storage/devices/${id}/node-clients?node=3&range=7d`);
  assert.deepEqual([n3.body.clients.length, n3.body.latest.rows.length, n3.body.range], [0, 0, '7d'], '노드 3 은 ‘최근 작업한 클라이언트 없음’');
  const past = await call(`/tools/storage/devices/${id}/node-clients?node=2&end=${NOW - 3 * D}`);
  assert.equal(past.body.past, true); assert.equal(past.body.latest.ts, null, '과거 창에는 지금이 없다');
  // 분포 · 재배치
  const cd = await call(`/tools/storage/devices/${id}/client-dist?range=7d`);
  assert.equal(cd.status, 200);
  assert.deepEqual(cd.body.nodes.map((n) => [n.id, n.skew]), [[1, false], [2, true], [3, false]], '노드 3(ops 0)도 분모 · 노드 2 쏠림');
  assert.equal(cd.body.candidates.length, 1);
  assert.deepEqual([cd.body.candidates[0].client, cd.body.candidates[0].from, cd.body.candidates[0].to, cd.body.candidates[0].ops], ['10.1.1.1', 2, 3, 900], '후보 ops 는 창 평균 ops/s(창 합 10,800 / 표본 12)');
  assert.equal(cd.body.samples, 12); assert.match(cd.body.basis, /창 평균 ops\/s/);
  assert.equal(Math.round(cd.body.nodes.find((n) => n.id === 2).total), 1200, '노드 합도 창 평균 ops/s');
  assert.deepEqual([cd.body.thresholds.fixedShare, cd.body.thresholds.skewFactor, cd.body.proto, cd.body.protos], [0.9, 1.5, 'all', ['nfs', 'smb']]);
  assert.match(cd.body.note, /포탈은 장비·클라이언트 설정을 바꾸지 않습니다/);
  assert.equal(cd.body.clientsTotal, 3);
  const smb = await call(`/tools/storage/devices/${id}/client-dist?range=7d&proto=SMB2&skew=1.2&fixed=0.6`);
  assert.deepEqual(smb.body.clients.map((c) => c.client), ['10.1.1.2']); assert.deepEqual([smb.body.proto, smb.body.thresholds.skewFactor, smb.body.thresholds.fixedShare], ['smb', 1.2, 0.6]);
  const wild = await call(`/tools/storage/devices/${id}/client-dist?skew=99&fixed=0.1`);
  assert.deepEqual([wild.body.thresholds.skewFactor, wild.body.thresholds.fixedShare], [5, 0.5], '문턱값은 범위 안으로');
  for (const p of ['node-clients?node=2', 'client-dist']) {
    assert.equal((await call(`/tools/storage/devices/${id}/${p}`, { username: 'u', role: 'admin', scope: { vcenters: ['vc-1'] } })).status, 403);
    assert.equal((await call(`/tools/storage/devices/${id}/${p}`, { username: 'thedvcdemp', role: 'admin', scope: {}, demoGuest: true })).status, 404, '데모 계정은 데모 장비만');
  }
});

/* ── ⑧ 이름 ─────────────────────────────────────────────────────────── */
test('⑧ 이름 — VM IP · 호스트 관리 IP · 장비 보고 우선 · 같은 IP 둘 · 비정규 표기 · 역방향 DNS 없음', () => {
  const snap = { vms: [{ name: 'vm-a', ipAddresses: ['10.1.1.1', '192.168.0.5'], vcenterId: 'vc1' }, { name: 'vm-b', ipAddress: '10.1.1.1', vcenterId: 'vc2' }, { name: '', ipAddress: '10.1.1.4' }],
    hosts: [{ name: 'esx1.corp', mgmtIp: '10.1.1.2', vcenterId: 'vc1' }, { name: '10.1.1.3', vcenterId: 'vc1' }] };
  const idx = CN.buildClientNameIndex(snap);
  const rows = CN.nameClientRows([{ client: '10.1.1.1' }, { client: '192.168.0.5' }, { client: '10.1.1.2' }, { client: '10.1.1.3' }, { client: '010.1.1.2' }, { client: '10.1.1.9', name: 'dev-name' }, { client: '10.1.1.4' }], idx);
  assert.deepEqual(rows.map((r) => [r.name, r.nameSource, r.ambiguous === true]), [
    ['vm-a', 'vm', true], ['vm-a', 'vm', false], ['esx1.corp', 'host', false], ['10.1.1.3', 'host', false], ['', null, false], ['dev-name', 'device', false], ['', null, false],
  ], '같은 IP 둘은 첫 것 + ambiguous · 비정규 표기는 같은 IP 가 아니다 · 이름 없는 VM 은 색인하지 않는다');
  assert.equal(rows[0].vcenterId, 'vc1');
  assert.deepEqual(CN.nameStats(rows), { named: 4, device: 1, unknown: 2 });
  const s = src('storage/clientNames.js');
  assert.ok(!/dns|reverse|lookup/i.test(s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), '역방향 DNS 호출 없음(주석 밖)');
});
