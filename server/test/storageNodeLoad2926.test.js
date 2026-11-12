/**
 * storageNodeLoad2926.test.js — 아이실론 노드 부하 시계열(네트워크 In/Out · 디스크 쓰기/읽기 · CPU) 회귀(v2.926).
 *
 * 사용자 요청(2026-11-07): "아이실론에서 이미 수집하는 정보에서 노드별 io network 부하를 저장하고 차트로" · "기간별 시간별로 이전 기록" ·
 *   "Disk io 추가" · 성능 관점 추천 ①CPU ④잡 엔진 ⑤지난주 같은 구간 비교(추천대로 진행). 설계 docs/design/isilon-node-load/README.md.
 *
 * 고정하는 것:
 *  ① 수집기 — REST 키 3개를 **같은 호출**에 더한다(왕복 0) · CPU idle(1/10 %) → 사용률 · 범위 밖은 null · SSH 출력 세 모양 · lnn 조인 · 못 읽음 사유
 *  ② 엣지 정제 — 새 노드 필드 3개가 화이트리스트에 있다(문자열 수치는 수로 · 객체는 null)
 *  ③ 적재 규칙 — 실패·노드 없음·값 없는 타입은 적재하지 않는다 · 값이 모두 빈 노드도 행을 남긴다 · 0 으로 바꾸지 않는다 · 잡 모양
 *  ④ DB — 스냅샷 1개 = 트랜잭션 1개 · 같은 시각 재전송은 아무것도 쓰지 않는다(일 롤업 이중 집계 없음) · 일 평균은 읽은 표본만 ·
 *        max 는 못 읽은 표본이 지우지 않는다 · 원시 보존(노드 부하 전용)으로 원시만 지우고 일 롤업은 남는다
 *  ⑤ 창 — 기간별 표·버킷 · 미래 end 자르기 · 촘촘한 수집 주기는 15분 버킷
 *  ⑥ 조립 — 칸의 노드를 전부 읽었을 때만 클러스터 값(부분 합 금지) · 버킷 칸은 읽은 표본이 있을 때만
 *  ⑦ 실제 api 라우터 — 응답 모양 · 비교 구간 · 잡 · 과거 창 · 범위 계정 403 · 데모 계정 404
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import url from 'node:url';
import express from 'express';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeload2926-'));
Object.assign(process.env, { CONFIG_DIR: TMP, DATA_SOURCE: 'live', AUTH_ENABLED: 'false' });
delete process.env.CENTRAL_URL;
delete process.env.CENTRAL_TOKEN;
delete process.env.STORAGE_NODELOAD_KEEP_DAYS;
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const here = path.dirname(url.fileURLToPath(import.meta.url));
const src = (p) => fs.readFileSync(path.join(here, '..', 'src', p), 'utf8');
const H = 3_600_000;
const D = 24 * H;
// 기준 시각은 실제 시각을 정시 경계로 떨어뜨려 고정한다(docs/rules/common.md — Date.now() 직접·고정 epoch 둘 다 깨진다).
const NOW = Math.floor(Date.now() / H) * H;
// ⚠ 동적 import 는 전부 여기서(테스트 사이 top-level await 금지 — storageUsage2789 머리말).
const NL = await import('../src/storage/collectors/isilonNodeLoad.js');
const { normalizeIsilon } = await import('../src/storage/collectors/isilon.js');
const M = await import('../src/storage/nodeLoad.js');
const db = await import('../src/storage/db.js');
const { sanitizeNodeList, NODE_NUM_KEYS } = await import('../src/central/edgeRecord.js');
const GS = await import('../src/storage/growthSettings.js');
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

/** 정규화 스냅샷(아이실론 모양) — vals[i] = [in, out, din, dout, cpu] (undefined 면 그 필드 없음). */
function snapOf(deviceId, ts, vals, { jobs, ok = true, nodesSection = 'ok' } = {}) {
  const list = vals.map((v, i) => {
    const n = { id: i + 1, ip: `10.0.0.${i + 1}`, health: 'ok' };
    const f = ['inBps', 'outBps', 'diskInBytesPs', 'diskOutBytesPs', 'cpuPct'];
    f.forEach((k, j) => { if (v[j] !== undefined) n[k] = v[j]; });
    return n;
  });
  return { deviceId, type: 'isilon', ok, collectedAt: ts, sections: { nodes: nodesSection }, nodes: { count: list.length, unhealthy: 0, list },
    extra: jobs === undefined ? {} : { jobs } };
}

/* ── ① 수집기 ─────────────────────────────────────────────────────── */
test('① REST — 디스크·CPU 키는 이미 부르는 노드 통계 호출에 더한다(왕복 0) · CPU idle 1/10 % → 사용률', () => {
  const s = src('storage/collectors/isilon.js');
  const call1 = s.slice(s.indexOf("trySection('nodeStats'"), s.indexOf("trySection('users'"));
  assert.match(call1, /ISI_NODE_LOAD_REST_KEYS\.map/, '노드 통계 호출 안에서 키를 붙인다');
  assert.equal((s.match(/\/platform\/1\/statistics\/current/g) || []).length, 3, '새 statistics 호출을 만들지 않는다(용량 1 · 노드 통계 1 · 전원 1 — 예전과 같은 수)');
  assert.equal(NL.cpuPctFromIdlePermille(1000), 0);
  assert.equal(NL.cpuPctFromIdlePermille(873), 12.7);
  assert.equal(NL.cpuPctFromIdlePermille(0), 100);
  for (const bad of [null, '', -1, 1001, 'x', {}]) assert.equal(NL.cpuPctFromIdlePermille(bad), null, `범위 밖·못 읽음은 null: ${JSON.stringify(bad)}`);
  assert.deepEqual(NL.restNodeLoadFields({ 'node.disk.bytes.in.rate.sum': 5, 'node.cpu.idle.avg': 900 }), { diskInBytesPs: 5, cpuPct: 10 });
  assert.deepEqual(NL.restNodeLoadFields({ 'node.disk.bytes.out.rate.sum': -3 }), {}, '음수는 필드를 만들지 않는다');
  assert.deepEqual(NL.restNodeLoadFields({}), {}, '키가 없으면 필드도 없다(0 이 아니다)');
});

test('① REST 정규화 — 노드에 디스크·CPU 를 싣고 몇 대 읽었는지 밝힌다 · 네트워크는 예전처럼 ×8', () => {
  const raw = {
    config: { name: 'c', onefs_version: { release: '9.5' } },
    nodes: { nodes: [{ id: 1, lnn: 1 }, { id: 2, lnn: 2 }] },
    nodeStats: { stats: [
      { devid: 1, key: 'node.net.ext.bytes.in.rate', value: 100 },
      { devid: 1, key: 'node.disk.bytes.in.rate.sum', value: 2000 }, { devid: 1, key: 'node.disk.bytes.out.rate.sum', value: 3000 },
      { devid: 1, key: 'node.cpu.idle.avg', value: 750 },
      { devid: 2, key: 'node.net.ext.bytes.in.rate', value: 50 }, { devid: 2, key: 'node.cpu.idle.avg', value: null },
    ] },
  };
  const s = normalizeIsilon({ id: 'i1', type: 'isilon', name: 'c' }, raw);
  const [a, b] = s.nodes.list;
  assert.equal(a.inBps, 800);
  assert.equal(a.diskInBytesPs, 2000);
  assert.equal(a.diskOutBytesPs, 3000);
  assert.equal(a.cpuPct, 25);
  assert.equal('diskInBytesPs' in b, false);
  assert.equal('cpuPct' in b, false, '못 읽은 CPU 는 0 이 아니라 필드 없음');
  assert.deepEqual(s.extra.nodeLoadProbe, { source: NL.ISI_REST_LOAD_SOURCE, total: 2, disk: 1, cpu: 1 });
});

test('① SSH — isi statistics system 출력 세 모양 · 필드 이름 변형 · 클러스터 행 제외 · 형식 불명은 null', () => {
  const arr = JSON.stringify([
    { Node: 1, CPU: '12.5%', 'Disk In': 1000, 'Disk Out': '2000', 'Net In': 9 },
    { node: 'All', cpu: 50, disk_in: 1 },
    { lnn: 2, cpu_pct: 140, diskIn: -1, diskOut: 7 },
  ]);
  const m = NL.parseIsiSystemStats(arr);
  assert.deepEqual(m.get(1), { cpuPct: 12.5, diskInBytesPs: 1000, diskOutBytesPs: 2000 });
  assert.deepEqual(m.get(2), { diskOutBytesPs: 7 }, 'CPU 100% 초과·음수 디스크는 버린다');
  assert.equal(m.size, 2, "'All' 행은 노드가 아니다");
  assert.equal(NL.parseIsiSystemStats(JSON.stringify({ stats: [{ node: 3, disk_out: 5 }] })).get(3).diskOutBytesPs, 5);
  assert.equal(NL.parseIsiSystemStats(JSON.stringify({ nodes: [{ devid: 4, cpu: 3 }] })).get(4).cpuPct, 3);
  for (const bad of ['', 'not json', '{"x":1}', '42']) assert.equal(NL.parseIsiSystemStats(bad), null);
  assert.equal(NL.parseIsiSystemStats('[]').size, 0);
});

test('① SSH 적용 — lnn 으로 조인 · 못 읽으면 사유(예산·실행 실패·형식) · 세션 순서는 정확 용량 다음', () => {
  const snap = { nodes: { list: [{ id: 1 }, { id: 2 }] }, extra: {} };
  NL.applyIsiSystemStats(snap, new Map([[2, { cpuPct: 9 }]]));
  assert.equal(snap.nodes.list[1].cpuPct, 9);
  assert.equal(snap.nodes.list[0].cpuPct, undefined);
  assert.deepEqual(snap.extra.nodeLoadProbe, { source: 'isi statistics system', total: 2, disk: 0, cpu: 1 });
  const s2 = { nodes: { list: [{ id: 1 }] }, extra: {} };
  NL.applyIsiSystemStats(s2, null, { budget: true });
  assert.equal(s2.extra.nodeLoadProbe.reason, 'budget');
  NL.applyIsiSystemStats(s2, null, { failed: true });
  assert.equal(s2.extra.nodeLoadProbe.reason, 'exec');
  NL.applyIsiSystemStats(s2, null, {});
  assert.equal(s2.extra.nodeLoadProbe.reason, 'parse');
  NL.applyIsiSystemStats(s2, new Map());
  assert.equal(s2.extra.nodeLoadProbe.reason, 'empty');
  const s = src('storage/collectors/isilonSsh.js');
  const i1 = s.indexOf('bsh.exec(ISI_STATS_CMD'); const i2 = s.indexOf('bsh.exec(ISI_SYSTEM_STATS_CMD'); const i3 = s.indexOf('readIsiPowerSsh(bsh');
  assert.ok(i1 > 0 && i2 > i1 && i3 > i2, '정확 용량 → 노드 부하 → 전원 순(예산이 모자라면 부가 정보부터 잃는다)');
  assert.match(s.slice(i2 - 60, i2 + 80), /soft\(/, 'best-effort — 실패해도 isi status 값은 유지');
  assert.ok(!/\$\{/.test(NL.ISI_SYSTEM_STATS_CMD), '고정 명령(입력이 섞이지 않는다)');
});

/* ── ② 엣지 정제 ──────────────────────────────────────────────────── */
test('② 엣지 노드 목록 — 새 필드 3개는 화이트리스트에 있고 수로 좁힌다', () => {
  for (const k of ['diskInBytesPs', 'diskOutBytesPs', 'cpuPct']) assert.ok(NODE_NUM_KEYS.includes(k), k);
  const o = { nodes: { list: [{ id: 1, diskInBytesPs: '1500', diskOutBytesPs: { x: 1 }, cpuPct: 33.3, evil: 'x' }] } };
  sanitizeNodeList(o);
  assert.deepEqual(o.nodes.list[0], { id: 1, diskInBytesPs: 1500, diskOutBytesPs: null, cpuPct: 33.3 });
});

/* ── ③ 적재 규칙 ──────────────────────────────────────────────────── */
test('③ 적재 규칙 — 실패·노드 없음·값 없는 타입은 적재하지 않는다 · 빈 노드도 행 · 0 으로 바꾸지 않는다', () => {
  assert.equal(M.nodeLoadRowsOf(snapOf('d', NOW, [[1]], { ok: false })).reason, 'collect-failed');
  assert.equal(M.nodeLoadRowsOf(snapOf('d', NOW, [[1]], { nodesSection: '오류: x' })).reason, 'no-nodes');
  assert.equal(M.nodeLoadRowsOf(snapOf('d', NOW, [[null, null], [undefined]])).reason, 'no-load', 'Unity·PowerStore 처럼 노드 처리량이 없는 장비');
  assert.equal(M.nodeLoadRowsOf(snapOf('', NOW, [[1]])).reason, 'no-id');
  const r = M.nodeLoadRowsOf(snapOf('d', NOW, [[10, 20, 30, 40, 50], [null, null, null, null, null], ['5', -1, 0, undefined, 101]]));
  assert.equal(r.ok, true);
  assert.equal(r.nodes.length, 3, '값이 모두 빈 노드도 행을 남긴다(부분 합 판정 근거)');
  // v2.932: 지표 4개(ops·lat·busy·iops)가 늘었다 — 스냅샷에 없으면 null(0 이 아니다).
  const N4 = { ops: null, lat: null, busy: null, iops: null, hbps: null, queue: null };
  assert.deepEqual(r.nodes[1], { id: 2, in: null, out: null, din: null, dout: null, cpu: null, ...N4 });
  assert.deepEqual(r.nodes[2], { id: 3, in: 5, out: null, din: 0, dout: null, cpu: null, ...N4 }, '음수·100% 초과 CPU 는 null, 0 은 0');
  const many = M.nodeLoadRowsOf(snapOf('d', NOW, Array.from({ length: 70 }, () => [1])));
  assert.equal(many.nodes.length, M.NODE_LOAD_LIMIT);
  assert.deepEqual(M.jobsOf({ running: [{ job: 'SmartPools[1]', impact: 'Low', phase: '1/2' }, null, { job: 5 }], paused: [{}, {}] }),
    { running: [{ job: 'SmartPools[1]', impact: 'Low', phase: '1/2' }], paused: 2 });
  assert.equal(M.jobsOf(undefined), null, '모르면 null(잡 없음이 아니다)');
});

/* ── ④ DB ─────────────────────────────────────────────────────────── */
test('④ DB — 트랜잭션 1개 · 재전송 무시 · 일 평균은 읽은 표본만 · max 는 null 이 지우지 않는다', async () => {
  const day0 = Math.floor((NOW - 3 * D) / D) * D - 9 * H + 2 * D;   // 포탈(KST) 날짜의 0시 근처 — 같은 날 안의 세 시각
  const t1 = day0 + 2 * H; const t2 = day0 + 3 * H; const t3 = day0 + 4 * H;
  const jobs = { running: [{ job: 'SmartPools[118838]', impact: 'Low', phase: '1/2' }], paused: [] };
  assert.equal((await db.saveNodeLoadPoint(snapOf('dev-a', t1, [[100, 10, 1000, 2000, 10], [200, 20, null, 4000, 30]], { jobs }))).saved, true);
  const dup = await db.saveNodeLoadPoint(snapOf('dev-a', t1, [[999, 999, 999, 999, 99], [1, 1, 1, 1, 1]]));
  assert.equal(dup.duplicate, true, '같은 (장비, 시각)은 아무것도 쓰지 않는다');
  assert.equal((await db.saveNodeLoadPoint(snapOf('dev-a', t2, [[300, 30, 3000, null, 20], [null, 40, 5000, 6000, 50]]))).saved, true);
  assert.equal((await db.saveNodeLoadPoint(snapOf('dev-a', t3, [[500, 50, null, null, null], [100, 60, 1000, 1000, 10]]))).saved, true);
  const raw = await db.nodeLoadQuery('dev-a', { group: 'net', kind: 'raw', from: t1, to: t3 + 1 });
  assert.equal(raw.rows.length, 6);
  const s = M.buildNodeLoadSeries(raw.rows, ['in', 'out'], { kind: 'raw' });
  assert.deepEqual(s.cols, [t1, t2, t3]);
  assert.deepEqual(s.cluster.in, [300, null, 600], '노드 2 의 t2 In 을 못 읽어 그 칸 합계는 비운다');
  assert.deepEqual(s.nodes[0].v.in, [100, 300, 500], '재전송 값(999)이 들어가지 않았다');
  const daily = await db.nodeLoadQuery('dev-a', { group: 'disk', kind: 'daily', from: t1, to: t3 + 1 });
  const n1 = daily.rows.find((r) => r.node === 1);
  assert.equal(n1.v.din, 2000, '읽은 두 표본(1000·3000)의 평균 — 못 읽은 표본을 0 으로 세지 않는다');
  assert.equal(n1.mx.din, 3000);
  assert.equal(n1.n.din, 2);
  assert.equal(n1.v.dout, 2000, '한 번만 읽었으면 그 값');
  const cpu = await db.nodeLoadQuery('dev-a', { group: 'cpu', kind: 'daily', from: t1, to: t3 + 1 });
  assert.equal(cpu.rows.find((r) => r.node === 1).mx.cpu, 20, 'max 는 마지막 표본(null)이 지우지 않는다');
  const bucket = await db.nodeLoadQuery('dev-a', { group: 'net', kind: 'bucket', from: t1, to: t3 + 1, bucketMs: D });
  const bs = M.buildNodeLoadSeries(bucket.rows, ['in', 'out'], { kind: 'bucket' });
  assert.equal(bs.cols.length, 1);
  assert.equal(bs.nodes[1].v.in[0], 150, '버킷 평균도 읽은 표본만(200·100)');
  assert.equal(bs.cluster.in[0], 450, '버킷 칸은 노드마다 읽은 표본이 있으면 평균의 합');
  const jl = M.jobsSeriesOf(await db.nodeLoadJobs('dev-a', t1, t3 + 1));
  assert.equal(jl.known, true);
  assert.deepEqual(jl.list, [{ ts: t1, running: [{ job: 'SmartPools[118838]', impact: 'Low', phase: '1/2' }], paused: 0 }]);
  const o = await db.nodeLoadOldest('dev-a');
  assert.equal(o.sampleTs, t1);
  assert.match(o.day, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(await db.nodeLoadOldest('none'), { sampleTs: null, day: null });
  // 값 없는 스냅샷은 표본도 남기지 않는다.
  assert.equal((await db.saveNodeLoadPoint(snapOf('unity-x', t1, [[null, null]]))).reason, 'no-load');
  assert.deepEqual(await db.nodeLoadOldest('unity-x'), { sampleTs: null, day: null });
});

test('④ 보존 — 노드 부하 원시 보존으로 원시·표본만 지우고 일 롤업은 남긴다(보존 설정 칸 · env 폴백)', async () => {
  const old = NOW - 40 * D;
  assert.equal((await db.saveNodeLoadPoint(snapOf('dev-old', old, [[1, 2, 3, 4, 5]]))).saved, true);
  const keep = GS.GROWTH_SPEC.find((x) => x.key === 'nodeLoadRawKeepDays');
  assert.equal(keep.def, 7, 'v2.932: 5분 표본이면 행이 12배라 기본 30일 → 7일(저장값이 있으면 그대로)');
  assert.equal(db.effectiveKeepDays().nodeRaw, 7);
  await db.pruneNow();
  assert.equal((await db.nodeLoadOldest('dev-old')).sampleTs, null, '40일 전 원시는 지워진다');
  assert.notEqual((await db.nodeLoadOldest('dev-old')).day, null, '일 롤업은 5년 보존이라 남는다');
  process.env.STORAGE_NODELOAD_KEEP_DAYS = '45';
  GS._resetForTest();
  assert.equal(GS.loadGrowthSettings().nodeLoadRawKeepDaysSource, 'env');
  assert.equal(GS.loadGrowthSettings().nodeLoadRawKeepDays, 45);
  delete process.env.STORAGE_NODELOAD_KEEP_DAYS;
  GS._resetForTest();
  assert.equal(GS.normalizeGrowthSettings({ nodeLoadRawKeepDays: 0 }).values.nodeLoadRawKeepDays, undefined, '0·빈 값을 하한으로 승격하지 않는다');
  assert.equal(GS.normalizeGrowthSettings({ nodeLoadRawKeepDays: 999 }).values.nodeLoadRawKeepDays, 400);
});

/* ── ⑤ 창 ─────────────────────────────────────────────────────────── */
test('⑤ 창 — 기간별 표·버킷 · 미래 end 는 지금으로 · 촘촘한 수집 주기는 15분 버킷', () => {
  const w = M.nodeLoadWindow({ range: '24h', now: NOW, sampleMs: H });
  assert.deepEqual([w.kind, w.start, w.end, w.past], ['raw', NOW - D, NOW, false]);
  assert.equal(M.nodeLoadWindow({ range: '24h', now: NOW, sampleMs: 5 * 60_000 }).bucketMs, 15 * 60_000);
  assert.deepEqual([M.nodeLoadWindow({ range: '7d', now: NOW }).kind, M.nodeLoadWindow({ range: '7d', now: NOW }).bucketMs], ['bucket', 4 * H]);
  assert.equal(M.nodeLoadWindow({ range: '90d', now: NOW }).kind, 'daily');
  const f = M.nodeLoadWindow({ range: '24h', end: NOW + 5 * H, now: NOW });
  assert.equal(f.end, NOW); assert.equal(f.clamped, true);
  const p = M.nodeLoadWindow({ range: '24h', end: NOW - 3 * D, now: NOW });
  assert.equal(p.past, true); assert.equal(p.start, NOW - 4 * D);
  assert.equal(M.nodeLoadWindow({ range: 'nope', end: 'x', now: NOW }).range, '24h');
});

/* ── ⑦ 실제 api 라우터 ─────────────────────────────────────────────── */
test('⑦ api — 응답 모양 · 비교 구간(지난주 같은 요일) · 잡 · 과거 창 · 묶음 · 범위 계정 403 · 데모 계정 404', async () => {
  const id = 'dev-api';
  for (let k = 1; k <= 6; k++) await db.saveNodeLoadPoint(snapOf(id, NOW - k * H, [[k * 10, k, k * 100, k * 200, k], [k * 20, k, k * 100, null, k]]));
  for (let k = 1; k <= 3; k++) await db.saveNodeLoadPoint(snapOf(id, NOW - 7 * D - k * H, [[5, 5, 5, 5, 5], [5, 5, 5, 5, 5]]));
  const r = await call(`/tools/storage/devices/${id}/node-load?range=24h&group=net`);
  assert.equal(r.status, 200);
  const b = r.body;
  assert.equal(b.ok, true); assert.equal(b.kind, 'raw'); assert.deepEqual(b.metrics, ['in', 'out']);
  assert.deepEqual(b.units, { in: 'bps', out: 'bps' });
  assert.equal(b.cols.length, 6);
  assert.deepEqual(b.nodes.map((n) => n.id), [1, 2]);
  assert.equal(b.cluster.in[5], 30, '마지막 칸(1시간 전) = 10 + 20');
  assert.equal(b.baseline.label, '지난주 같은 요일');
  assert.equal(b.baseline.cols.length, 3);
  assert.ok(b.baseline.cols.every((t) => t >= b.start && t < b.end), '비교 구간은 지금 창 위치로 옮겨 온다');
  assert.equal(b.baseline.cluster.in[0], 10);
  assert.equal(b.retention.rawDays, 7); assert.equal(b.rawMaxDays, 7);
  assert.equal(b.retention.hourlyDays, 90, 'v2.932: 원시가 끝난 뒤 24시간·7일 보기는 시간 요약으로 간다');
  assert.equal(b.oldest.sampleTs, NOW - 7 * D - 3 * H);
  assert.equal(b.jobsKnown, false, '잡 없는 표본(REST)은 모름이다');
  const disk = await call(`/tools/storage/devices/${id}/node-load?range=24h&group=disk`);
  assert.deepEqual(disk.body.metrics, ['din', 'dout', 'busy', 'iops'], 'v2.932: 디스크 묶음에 busy %·IOPS 가 들어간다');
  assert.equal(disk.body.cluster.dout[5], null, '노드 2 의 읽기를 못 읽어 합계를 비운다');
  assert.equal(disk.body.cluster.din[5], 200);
  const past = await call(`/tools/storage/devices/${id}/node-load?range=24h&end=${NOW - 7 * D}`);
  assert.equal(past.body.past, true);
  assert.equal(past.body.cols.length, 3, '과거 창(지난주)의 표본');
  const week = await call(`/tools/storage/devices/${id}/node-load?range=7d&group=cpu`);
  assert.equal(week.body.kind, 'bucket');
  assert.ok(week.body.nodes[0].mx, '버킷 칸은 최대도 싣는다');
  assert.equal(week.body.clusterAgg.cpu, 'avg');
  const bad = await call(`/tools/storage/devices/${id}/node-load?group=__proto__`);
  assert.equal(bad.body.group, 'net', '모르는 묶음은 기본값(프로토타입 키로 열 이름을 만들지 않는다)');
  const scoped = await call(`/tools/storage/devices/${id}/node-load`, { username: 'u', role: 'admin', scope: { vcenters: ['vc-1'] } });
  assert.equal(scoped.status, 403);
  const demo = await call(`/tools/storage/devices/${id}/node-load`, { username: 'thedvcdemp', role: 'admin', scope: {}, demoGuest: true });
  assert.equal(demo.status, 404, '데모 계정은 데모 장비만');
});
