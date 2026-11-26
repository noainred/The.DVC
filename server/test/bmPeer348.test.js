// 물리서버 ‘같은 묶음 대비’(v3.48 — 설계 docs/design/bm-feature-proposals ⑨ · 사용자 '① ② ③ ⑨ 먼저 구현' · 범위 '엣지 서버까지').
//   ① 분위 · 한 지표 판정(폭 = 사분위 울타리 + 바닥값) · 값 없는 서버는 빼고 센다 · 모자라면 판정하지 않는다 ② 묶음 판정(네 지표 · 기준 표지)
//   ③ 24시간 평균의 조건(표본 수 + 구간 비율) ④ 요청 키 정리 ⑤ 수집 노드의 묶음 평균(peerAvgFor — CPU · 메모리 · 전력 · 모르는 키는 건너뛰고 센다 · 못 읽은 값은 null)
//   ⑥ 엣지 응답 정제(청한 키만 · 수로 · 시각 자르기) ⑦ 라우트(/tools/bm-folders/peer): 묶음 = 법인 · 폴더 · 모델 · 엣지마다 요청 1개 · 다른 서버 이름을 싣지 않는다 ·
//      구버전 엣지는 따로 센다 · 실패 사유는 전체 범위 관리자만 · 범위 밖 404 · 저장소 못 읽음 503 · 엣지 포탈 404 ⑧ 최소 엣지 버전은 릴리스 노트에서(숫자를 박지 않는다).
//   픽스처 식별자는 전부 합성(SYNTH · 192.0.2.x — 공개 저장소 규약).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 정리 실패는 시험 결과가 아니다 */ } } };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });

const tmp = tmpDir('bmpeer348-');
process.env.CONFIG_DIR = tmp;
const here = path.dirname(fileURLToPath(import.meta.url));

const P = await import('../src/bmcheck/peer.js');
const A = await import('../src/bmusage/peerAvg.js');
const PULL = await import('../src/central/bmPeerPull.js');
const MV = await import('../src/central/featureMinEdgeVersion.js');
const fleet = await import('../src/central/fleet.js');
const bs = await import('../src/bmfolders/store.js');
const sm = await import('../src/servicemap/store.js');
const registry = await import('../src/idrac/registry.js');
const invCache = await import('../src/idrac/invCache.js');
const { store } = await import('../src/store.js');
const { registerBmFolders, _setTrendDepsForTest } = await import('../src/routes/api/bmFolders.js');
const svcinv = await import('../src/routes/api/svcInventory.js');

// ───────── ① 한 지표 판정 ─────────
test('① 분위 — 선형 보간 · 빈 배열은 null', () => {
  assert.equal(P.quantile([], 0.5), null); assert.equal(P.quantile(null, 0.5), null);
  assert.equal(P.quantile([7], 0.25), 7);
  assert.equal(P.quantile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(P.quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(P.quantile([10, 20, 30, 40, 50], 0.25), 20); assert.equal(P.quantile([10, 20, 30, 40, 50], 0.75), 40);
  assert.equal(P.quantile([1, 2], 2), 2, '범위 밖 q 는 끝으로'); assert.equal(P.quantile([1, 2], -1), 1);
});

test('① 한 지표 — 폭 안 · 위 · 아래 · 폭 = 사분위 범위 울타리(바닥값보다 좁아지지 않는다)', () => {
  // 20·21·22·23·24 + 60: Q1 21.25 · Q3 23.75 · IQR 2.5 → 1.5×IQR 3.75 < 바닥 10 → 폭 11.25 ~ 33.75
  const hi = P.judgePeer([20, 21, 22, 23, 24, 60], 60, { floor: 10 });
  assert.deepEqual([hi.state, hi.value, hi.n, hi.missing, hi.median, hi.lo, hi.hi, hi.min, hi.max], ['high', 60, 6, 0, 22.5, 11.3, 33.8, 20, 60]);
  assert.deepEqual(hi.points, [20, 21, 22, 23, 24, 60], '점은 정렬해 싣는다(누구의 값인지는 싣지 않는다)');
  assert.equal(P.judgePeer([20, 21, 22, 23, 24, 60], 22, { floor: 10 }).state, 'in');
  assert.equal(P.judgePeer([50, 51, 52, 53, 54, 5], 5, { floor: 10 }).state, 'low');
  // 바닥값: 값이 거의 같은 묶음에서 2 % 차이를 ‘밖’ 으로 부르지 않는다
  assert.equal(P.judgePeer([30, 30, 30, 30, 32], 32, { floor: 10 }).state, 'in');
  assert.equal(P.judgePeer([30, 30, 30, 30, 32], 32, { floor: 0 }).state, 'high', '바닥값이 없으면 IQR 0 — 조금만 달라도 밖(그래서 바닥값을 둔다)');
  // 가운데값의 % 바닥(전력): 가운데 400 W 의 15 % = 60 W
  assert.equal(P.judgePeer([400, 400, 400, 400, 455], 455, { floor: 20, floorPct: 15 }).state, 'in');
  assert.equal(P.judgePeer([400, 400, 400, 400, 470], 470, { floor: 20, floorPct: 15 }).state, 'high');
  // 경계는 안(울타리 값과 같으면 밖이 아니다) — 위 · 아래 둘 다
  const edge = P.judgePeer([10, 10, 10, 10, 20], 20, { floor: 10 });
  assert.deepEqual([edge.hi, edge.state], [20, 'in']);
  const edgeLo = P.judgePeer([10, 20, 20, 20, 20], 10, { floor: 10 });
  assert.deepEqual([edgeLo.lo, edgeLo.state], [10, 'in']);
  // 판정은 화면에 쓰는 수(소수 한 자리)로 — 33.84 와 폭 끝 33.83 은 화면에서 둘 다 33.8 이다(반증 A9)
  //   Q1 = Q3 = 20 · 바닥 3.81 → 폭 끝 23.81(화면 23.8) · 이 서버 23.84(화면 23.8) — 원값으로는 23.84 > 23.81 이라 ‘밖’ 이었다
  const r = P.judgePeer([20, 20, 20, 20, 20, 23.84], 23.84, { floor: 3.81 });
  assert.deepEqual([r.value, r.hi, r.state], [23.8, 23.8, 'in']);
  assert.equal(P.judgePeer([20, 20, 20, 20, 20, 23.9], 23.9, { floor: 3.81 }).state, 'high', '화면 수로도 밖이면 밖');
  assert.deepEqual(P.PEER_METRICS.map((m) => [m.id, m.floor, m.floorPct]), [['cpu', 10, 0], ['mem', 10, 0], ['power', 20, 15], ['inlet', 3, 0]], '바닥값(문서 · 릴리스 노트에 적은 값)');
  // 폭이 넓은 묶음은 1.5 × IQR 이 바닥값을 이긴다
  const wide = P.judgePeer([10, 20, 30, 40, 50, 60, 70], 70, { floor: 10 });
  assert.deepEqual([wide.lo, wide.hi, wide.state], [-20, 100, 'in']);
  // 폭은 그 지표가 가질 수 있는 값 안으로 자른다(‘7 % ~ 124 %’ 를 폭으로 내지 않는다 — Chromium 판독) · 판정은 그대로
  const cut = P.judgePeer([55, 60, 68, 81, 85, 90, 92], 92, { floor: 10, lower: 0, upper: 100 });
  assert.deepEqual([cut.lo, cut.hi, cut.state], [28.8, 100, 'in']);   // Q1 64 · Q3 87.5 · w 35.25 → 28.75 ~ 122.75 → 위 끝을 100 에서 자른다
  assert.deepEqual([P.judgePeer([1, 2, 3, 4, 5], 5, { floor: 10, lower: 0, upper: 100 }).lo, P.judgePeer([1, 2, 3, 4, 5], 5, { floor: 10, lower: 0 }).hi], [0, 14]);
  assert.deepEqual(P.PEER_METRICS.map((m) => [m.id, m.lower, m.upper]), [['cpu', 0, 100], ['mem', 0, 100], ['power', 0, null], ['inlet', null, null]]);
  const g = P.judgePeerGroup([55, 60, 68, 81, 85, 90, 92].map((v, i) => ({ id: `s${i}`, mem: v, power: 10 + i })), 's6');
  assert.deepEqual([g.metrics.mem.hi, g.metrics.power.lo], [100, 0], '묶음 판정이 지표의 끝을 넘긴다');
});

test('① 값이 없는 서버는 묶음에서 빼고 센다(0 으로 넣지 않는다) · 값이 있는 서버가 모자라면 판정하지 않는다 · 이 서버 값이 없으면 none', () => {
  const j = P.judgePeer([20, null, '', undefined, 21, 22, 23, 24, 'x', {}], 24, { floor: 10 });
  assert.deepEqual([j.state, j.n, j.missing, j.min], ['in', 5, 5, 20], "'' · null 을 0 으로 세면 최솟값이 0 이 된다");
  const few = P.judgePeer([20, 21, 22, 90, null, null], 90, { floor: 10 });
  assert.deepEqual([few.state, few.n, few.missing, few.value], ['few', 4, 2, 90], '값 있는 서버 4대 — 판정하지 않는다(값 · 대수는 싣는다)');
  assert.equal(few.points, undefined); assert.equal(few.median, undefined);
  for (const none of [null, undefined, '', 'abc', NaN]) {
    const r = P.judgePeer([20, 21, 22, 23, 24, none], none, { floor: 10 });
    assert.deepEqual([r.state, r.value, r.n], ['none', null, 5], String(none));
  }
  // 0 은 값이다(0 % · 0 W 는 읽은 값)
  assert.deepEqual([P.judgePeer([0, 0, 0, 0, 0], 0, { floor: 10 }).state, P.judgePeer([0, 50, 50, 50, 50, 50], 0, { floor: 10 }).state], ['in', 'low']);
  assert.equal(P.judgePeer(null, 5).state, 'few'); assert.equal(P.judgePeer([1, 2, 3, 4, 5], 3, { min: 6 }).state, 'few');
  assert.equal(P.PEER_MIN, 5);
});

// ───────── ② 묶음 판정 ─────────
test('② 묶음 판정 — 네 지표 · 기준 표지(CPU · 메모리 · 전력 = 24시간 평균 / 흡기 온도 = 지금 값) · 폭 밖 수 · 판정한 수', () => {
  const rows = [
    { id: 'a', cpu: 78, mem: 40, power: 410, inlet: 24 },
    { id: 'b', cpu: 20, mem: 41, power: 400, inlet: 23 },
    { id: 'c', cpu: 22, mem: 39, power: 405, inlet: 24 },
    { id: 'd', cpu: 21, mem: 42, power: null, inlet: 23 },
    { id: 'e', cpu: 23, mem: 40, power: 395, inlet: null },
    { id: 'f', cpu: 19, mem: 38, power: 402, inlet: 24 },
  ];
  const j = P.judgePeerGroup(rows, 'a');
  assert.deepEqual(Object.keys(j.metrics), ['cpu', 'mem', 'power', 'inlet']);
  assert.deepEqual([j.metrics.cpu.state, j.metrics.mem.state, j.metrics.power.state, j.metrics.inlet.state], ['high', 'in', 'in', 'in']);
  assert.deepEqual([j.out, j.judged], [1, 4]);
  assert.deepEqual([j.metrics.cpu.basis, j.metrics.mem.basis, j.metrics.power.basis, j.metrics.inlet.basis], ['avg24', 'avg24', 'avg24', 'now'], '전력도 평균이다(수집 노드의 시간당 롤업) — 흡기 온도만 지금 값');
  assert.deepEqual([j.metrics.cpu.unit, j.metrics.power.unit, j.metrics.inlet.unit], ['%', 'W', '℃']);
  assert.deepEqual([j.metrics.power.n, j.metrics.power.missing, j.metrics.inlet.n], [5, 1, 5]);
  // 이 서버가 목록에 없으면 전부 none(다른 서버의 값으로 판정하지 않는다)
  const no = P.judgePeerGroup(rows, 'zz');
  assert.deepEqual([no.out, no.judged, no.metrics.cpu.state], [0, 0, 'none']);
  assert.deepEqual(P.judgePeerGroup(null, 'a').judged, 0);
  // 지표 표는 굳혀 둔다(실수로 바닥값을 바꾸지 않게)
  assert.ok(Object.isFrozen(P.PEER_METRICS) && P.PEER_METRICS.every(Object.isFrozen));
});

// ───────── ③ 24시간 평균의 최소 표본 ─────────
test('③ 24시간 평균 — 표본 수 그리고 구간 비율이 모두 될 때만 값(최근 1시간의 점들 · 점 하나를 하루 평균이라 하지 않는다) · 못 읽은 평균은 null', () => {
  assert.deepEqual([P.PEER_AVG_MIN_SAMPLES, P.PEER_AVG_MIN_COVERAGE], [12, 0.5]);
  assert.equal(P.avgValueOf({ avg: 41.5, n: 12, cov: 0.5 }), 41.5); assert.equal(P.avgValueOf({ avg: 41.5, n: 288, expected: 288, cov: 1 }), 41.5);
  assert.equal(P.avgValueOf({ avg: 41.5, n: 11, cov: 1 }), null, '표본 11개');
  assert.equal(P.avgValueOf({ avg: 41.5, n: 288, cov: 0.49 }), null, '점은 많아도 하루의 절반을 덮지 못했다(최근 몇 시간에 몰린 점)');
  assert.equal(P.avgValueOf({ avg: 41.5, n: 1, cov: 0.5 }), null, '점 하나가 두 칸 중 한 칸을 채운 경우 — 표본 수가 막는다');
  assert.equal(P.avgValueOf({ avg: 41.5, n: 288 }), null, '구간 비율을 모르면 값으로 보지 않는다'); assert.equal(P.avgValueOf({ avg: 41.5, cov: 1 }), null, '표본 수를 모르면 값으로 보지 않는다');
  assert.equal(P.avgValueOf({ avg: null, n: 288, cov: 1 }), null); assert.equal(P.avgValueOf({ avg: '', n: 288, cov: 1 }), null, "'' 는 0 이 아니다");
  assert.equal(P.avgValueOf({ avg: 41.5, n: 288, cov: '' }), null, "비율 '' 는 0 도 1 도 아니다");
  assert.equal(P.avgValueOf({ avg: 0, n: 288, cov: 1 }), 0, '0 % 는 읽은 값');
  assert.equal(P.avgValueOf(null), null); assert.equal(P.avgValueOf('x'), null);
  assert.equal(P.avgValueOf({ avg: 5, n: 3, cov: 0.2 }, { minSamples: 3, minCoverage: 0.2 }), 5);
  // 수집 주기가 긴 법인(3시간 · 6시간) — 하루 표본이 8 · 4개라 12개를 못 채운다 → 창이 담을 수 있는 수의 절반으로(반증 A4)
  assert.deepEqual([P.minSamplesFor({ expected: 288 }), P.minSamplesFor({ expected: 8 }), P.minSamplesFor({ expected: 4 }), P.minSamplesFor({ expected: 1 }), P.minSamplesFor({}), P.minSamplesFor(null)], [12, 4, 2, 2, 12, 12]);
  assert.equal(P.avgValueOf({ avg: 30, n: 8, expected: 8, cov: 0.88 }), 30, '3시간 주기 · 하루 8개');
  assert.equal(P.avgValueOf({ avg: 30, n: 3, expected: 8, cov: 0.88 }), null, '3시간 주기 · 하루 3개(절반 미만)');
  assert.equal(P.avgValueOf({ avg: 30, n: 11, expected: 288, cov: 1 }), null, '5분 주기는 그대로 12개');
});

// ───────── ④ 요청 키 정리 ─────────
test('④ 요청 키 — 글자만 · 다듬기 · 중복 제거 · 상한', () => {
  assert.deepEqual(A.cleanPeerKeys([' A ', 'A', '', null, 7, {}, 'B']), ['A', 'B']);
  assert.deepEqual(A.cleanPeerKeys('A'), []); assert.deepEqual(A.cleanPeerKeys(null), []);
  const many = Array.from({ length: 500 }, (_, i) => `K${i}`);
  assert.equal(A.cleanPeerKeys(many).length, A.PEER_KEYS_MAX);
  assert.equal(A.PEER_KEYS_MAX, P.PEER_GROUP_MAX, '중앙 묶음 상한과 엣지 요청 상한은 같은 수(한 요청에 묶음이 다 들어간다)');
  assert.equal(A.cleanPeerKeys(['x'.repeat(999)])[0].length, 256);
});

// ───────── ⑤ 수집 노드의 묶음 평균 ─────────
test('⑤ 통계에 구간 비율을 붙인다 — 값이 있는 칸 ÷ 칸 수 · 전력은 시간마다 같은 무게 · 못 읽으면 null', () => {
  assert.deepEqual(A.statWithCoverage({ avg: 40.5, n: 24, expected: 288, spark: [[1, 40, null], [2, null, null], [3, 41, 50], [4, null, 9]] }), { avg: 40.5, n: 24, expected: 288, cov: 0.5 });
  assert.deepEqual(A.statWithCoverage({ avg: null, n: 0, expected: 288, spark: [] }), { avg: null, n: 0, expected: 288, cov: null }, '칸이 없으면 비율을 모른다(0 이라 하지 않는다)');
  assert.equal(A.statWithCoverage({ error: 'db busy' }), null); assert.equal(A.statWithCoverage(null), null);
  assert.equal(A.statWithCoverage({ avg: 1, n: 1, spark: [[1, '', null], [2, 0, null]] }).cov, 0.5, "'' 는 값이 아니고 0 은 값이다");
  const H = 3_600_000;
  // 24시간 창 — 12시간분의 행: 평균은 시간 평균의 평균(표본 수로 무게를 주지 않는다)
  const rows = Array.from({ length: 12 }, (_, i) => ({ ts: i * H, avg: i < 6 ? 400 : 500, min: 1, max: 9 }));
  assert.deepEqual(A.powerStatOf(rows, 0, 24 * H), { avg: 450, n: 12, expected: 24, cov: 0.5 });
  assert.deepEqual(A.powerStatOf([], 0, 24 * H), { avg: null, n: 0, expected: 24, cov: 0 }, '행이 없으면 평균 없음(0 W 가 아니다)');
  assert.deepEqual(A.powerStatOf([{ ts: 0, avg: '' }, { ts: H, avg: 300 }, null], 0, 24 * H), { avg: 300, n: 1, expected: 24, cov: 0.04 });
  assert.equal(A.powerStatOf(Array.from({ length: 30 }, (_, i) => ({ ts: i * H, avg: 100 })), 0, 24 * H).cov, 1, '비율은 1 을 넘지 않는다(창이 시간 경계에 걸치면 행이 25개)');
  assert.equal(A.powerStatOf(null, 0, H), null); assert.equal(A.powerStatOf('x', 0, H), null);
});

test('⑤ peerAvgFor — 이 노드 대상만 · 모르는 키는 건너뛰고 센다 · 못 읽은 값은 null(0 으로 채우지 않는다) · 전력은 시간당 롤업의 평균 · 구간 검증', async () => {
  const HOUR = 3_600_000; const now = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000; const from = now - 24 * HOUR;
  const asked = []; const powerAsked = []; const hwAsked = []; const hwKeys = []; const hwFresh = [];
  const deps = {
    settings: async () => ({ intervalMs: 300_000 }),
    targets: async () => ({
      targets: [{ key: 'SYNTH01', vcenterId: 'vc-a', serviceTag: 'SYNTH01', serverId: 'reg-x', idrac: { regId: 'reg-1', host: '192.0.2.1', username: 'root', password: 'pw' } }, { key: 'SYNTH02', vcenterId: 'vc-a', idrac: { regId: 'reg-2' } }, { key: 'SYNTH03', vcenterId: 'vc-a' },
        { key: 'SYNTH01', vcenterId: 'vc-b', idrac: { regId: 'reg-second' } }],
      // 사용률 수집 대상이 아닌 서버: 법인 수집 꺼짐(이 노드 등록 — 전력 · 온도는 답한다) · 엣지 위임(다른 노드 — 모르는 키) · 등록 id 없음(모르는 키)
      skipped: [{ key: 'SYNTH04', serverId: 'reg-4', serviceTag: 'SYNTH04', reason: 'corp-off' }, { key: 'SYNTH05', serverId: 'reg-5', reason: 'edge-delegated', agent: 'pl-edge' },
        { key: 'SYNTH07', serverId: 'reg-7', reason: 'remote-collector-unknown' },
        { key: 'SYNTH06', serverId: '', reason: 'corp-off' }, { key: 'SYNTH01', serverId: 'reg-dup', reason: 'corp-off' }, null, { key: 7, serverId: 'x' }],
    }),
    trend: async ({ key, q }) => {
      asked.push(`${key}:${q.metric}:${q.from}:${q.to}`);
      if (key === 'SYNTH03') return { ok: false, reason: 'db busy' };
      if (key === 'SYNTH02' && q.metric === 'mem_pct') throw new Error('boom');
      const base = key === 'SYNTH01' ? 40 : 20;
      // SYNTH01: 시간마다 한 점(하루를 다 덮는다) · SYNTH02: 마지막 2시간에 몰린 24점
      const points = key === 'SYNTH01' ? Array.from({ length: 24 }, (_, i) => ({ t: q.from + (i + 1) * HOUR - 1, avg: base + (i % 2) }))
        : Array.from({ length: 24 }, (_, i) => ({ t: q.to - 2 * HOUR + i * 300_000, avg: base + (i % 2) }));
      return { ok: true, res: '5m', stepMs: 300_000, from: q.from, to: q.to, points };
    },
    hwReader: async (o) => { hwFresh.push(o.freshMs); return (target) => { hwAsked.push(`${target.idrac?.regId}:${target.serviceTag || ''}`); hwKeys.push(JSON.stringify(target)); const id = target.idrac?.regId; return id === 'reg-1' ? { power: { watts: 999 }, inletC: 24, sensorAt: now - 60_000 } : id === 'reg-2' ? { power: { watts: '' }, inletC: null } : id === 'reg-4' ? { inletC: 26.5, sensorAt: now - 5_000 } : null; }; },
    freshMs: async () => 3_600_000,
    powerDb: async () => ({ hourlyStats: (id, a, b) => { powerAsked.push(`${id}:${a}:${b}`); if (id === 'reg-2') throw new Error('locked'); return Array.from({ length: 24 }, (_, i) => ({ ts: a + i * HOUR, avg: 400 + (i % 2) * 20 })); } }),
  };
  const r = await A.peerAvgFor({ keys: ['SYNTH01', 'SYNTH02', 'SYNTH03', 'NOPE', 'SYNTH01', 9, 'SYNTH04', 'SYNTH05', 'SYNTH06', 'SYNTH07'], from, to: now, now, deps });
  assert.equal(r.ok, true); assert.equal(r.unknown, 4, '이 노드의 목록에 없는 키 · 다른 노드가 맡은 서버 · 등록 id 없는 서버는 수만 밝힌다(존재를 가르지 않는다)');
  assert.deepEqual(r.rows.map((x) => x.key), ['SYNTH01', 'SYNTH02', 'SYNTH03', 'SYNTH04']);
  const [a, b, c, d4] = r.rows;
  // 사용률 수집 대상이 아닌 서버 — CPU · 메모리는 없고(계열을 읽지도 않는다) 전력 · 흡기 온도는 등록부 id 로 답한다
  assert.deepEqual([d4.cpu, d4.mem, d4.power.avg, d4.power.cov, d4.inletC, d4.sensorAt], [null, null, 410, 1, 26.5, now - 5_000]);
  assert.equal(asked.some((x) => x.startsWith('SYNTH04')), false);
  assert.deepEqual([a.cpu.avg, a.cpu.n, a.cpu.cov, a.mem.avg, a.inletC, a.sensorAt], [40.5, 24, 1, 40.5, 24, now - 60_000]);
  assert.deepEqual(a.power, { avg: 410, n: 24, expected: 24, cov: 1 }, '전력 = 시간당 롤업의 24시간 평균(지금 값 999 W 가 아니다)');
  assert.equal(a.powerW, undefined, '지금 전력은 싣지 않는다(기준이 다른 값을 섞지 않게)');
  assert.deepEqual([b.cpu.avg, b.cpu.n, b.mem, b.power, b.inletC], [20.5, 24, null, null, null], '한 지표가 실패해도 다른 지표는 그대로 · 전력 DB 가 던지면 평균 없음');
  assert.ok(b.cpu.cov < 0.2, `마지막 2시간에 몰린 점 — 구간 비율이 낮다(${b.cpu.cov})`);
  assert.deepEqual([c.cpu, c.mem, c.power, c.inletC], [null, null, null, null], '계열을 못 읽은 서버 · 등록부 id 를 모르는 서버 — 평균 없음');
  assert.ok(asked.includes(`SYNTH01:cpu_pct:${from}:${now}`) && asked.includes(`SYNTH01:mem_pct:${from}:${now}`));
  assert.equal(asked.some((x) => x.startsWith('NOPE')), false, '모르는 키로는 계열을 읽지 않는다');
  assert.deepEqual(powerAsked, [`reg-1:${from}:${now}`, `reg-2:${from}:${now}`, `reg-4:${from}:${now}`], '전력은 iDRAC 등록 id 로(대상의 regId 가 먼저 · 없으면 함대 목록의 serverId) · 같은 구간 · 같은 키의 제외 줄(reg-dup)은 쓰지 않는다');
  assert.deepEqual(hwAsked, ['reg-1:SYNTH01', 'reg-2:', 'reg-4:SYNTH04'], '사실 읽기에는 등록부 id 와 태그만 넘긴다(계정 · 주소가 든 대상 객체를 넘기지 않는다) · 같은 키는 첫 대상(reg-second 가 아니다)');
  assert.equal(hwKeys.some((x) => /192\.0\.2\.1|password|username|host/.test(x)), false, hwKeys.join(' / '));
  assert.deepEqual(JSON.parse(hwKeys[0]), { serviceTag: 'SYNTH01', idrac: { regId: 'reg-1' } });
  assert.deepEqual(hwFresh, [A.PEER_INLET_FRESH_MS], '흡기 ‘지금 값’ 의 신선도는 30분 상한(사용률 주기 15분 → 15분 · 6시간 → 30분)');
  const slow = []; await A.peerAvgFor({ keys: ['SYNTH01'], from, to: now, now, deps: { ...deps, freshMs: async () => 6 * HOUR * 3, hwReader: async (o) => { slow.push(o.freshMs); return () => null; } } });
  assert.deepEqual(slow, [30 * 60_000]);
  // 라우트가 넘긴 대상 목록을 쓴다(대상 목록을 두 번 만들지 않는다 — 반증 A7)
  let made = 0; const r2 = await A.peerAvgFor({ keys: ['SYNTH01'], from, to: now, now, deps: { ...deps, targets: async () => { made += 1; return deps.targets(); } } });
  assert.deepEqual([made, r2.rows.length], [1, 1]);
  // 구간 검증
  for (const bad of [{ from: now, to: now }, { from: now, to: from }, { from: 'x', to: now }, { from: now - 9 * 86_400_000, to: now }, {}]) {
    const e = await A.peerAvgFor({ keys: ['SYNTH01'], ...bad, deps });
    assert.deepEqual([e.__status, e.ok], [400, false], JSON.stringify(bad));
  }
  // 사실 읽기 · 전력 DB 가 통째로 실패해도 사용률 평균은 낸다(전력 · 온도만 없음)
  const noHw = await A.peerAvgFor({ keys: ['SYNTH01'], from, to: now, now, deps: { ...deps, hwReader: async () => { throw new Error('no hw'); }, powerDb: async () => { throw new Error('no db'); } } });
  assert.deepEqual([noHw.rows[0].cpu.avg, noHw.rows[0].power, noHw.rows[0].inletC], [40.5, null, null]);
  assert.equal((await A.peerAvgFor({ keys: [], from, to: now, now, deps })).rows.length, 0);
});

// ───────── ⑥ 엣지 응답 정제 ─────────
test('⑥ 엣지 응답 정제 — 청한 키만 · 같은 키 둘째 줄은 버린다 · 문자열 수치는 수로 · 구간 비율은 0 ~ 1 · 엣지 시각은 수신 시각으로 자른다 · 모르는 필드는 버린다', () => {
  const now = 1_800_000_000_000;
  const body = { ok: true, node: 'edge', unknown: '2', secret: 'x', rows: [
    { key: 'SYNTH01', cpu: { avg: '41.5', n: '288', expected: 288, cov: '0.75', spark: [[1, 2, 3]], evil: 'x' }, mem: { avg: 30, n: 288, cov: 7 }, power: { avg: '410', n: 24, expected: 24, cov: -3 }, powerW: 999, inletC: '24.5', sensorAt: now + 86_400_000, host: '192.0.2.9', name: 'synth-db-01' },
    { key: 'SYNTH01', cpu: { avg: 99, n: 288, cov: 1 } },
    { key: 'OTHER', cpu: { avg: 1, n: 288, cov: 1 } },
    { key: 'SYNTH02', cpu: 'bad', mem: null, power: [], inletC: 'abc', sensorAt: 'x' },
    null, 'x', { key: 7 },
  ] };
  const s = PULL.sanitizePeerAvg(body, ['SYNTH01', 'SYNTH02'], now);
  assert.deepEqual(s, { ok: true, unknown: 2, rows: [
    { key: 'SYNTH01', cpu: { avg: 41.5, n: 288, expected: 288, cov: 0.75 }, mem: { avg: 30, n: 288, expected: null, cov: 1 }, power: { avg: 410, n: 24, expected: 24, cov: 0 }, inletC: 24.5, sensorAt: now },
    { key: 'SYNTH02', cpu: null, mem: null, power: null, inletC: null, sensorAt: null },
  ] });
  assert.equal(/192\.0\.2\.9|synth-db-01|secret|evil|powerW/.test(JSON.stringify(s)), false, '주소 · 이름 · 모르는 필드는 남지 않는다');
  assert.equal(PULL.sanitizePeerAvg({ ok: true, rows: [{ key: 'A', cpu: { avg: 1, n: 99 } }] }, ['A'], now).rows[0].cpu.cov, null, '비율이 없으면 모름(1 로 채우지 않는다)');
  // 지표가 가질 수 없는 값은 null(끝으로 잘라 ‘있을 법한 값’ 으로 만들지 않는다 — 반증 A3)
  const wild = PULL.sanitizePeerAvg({ ok: true, rows: [{ key: 'A', cpu: { avg: 250, n: -3, expected: 1e300, cov: 1 }, mem: { avg: -40, n: 288, cov: 1 }, power: { avg: 1e300, n: 24, cov: 1 }, inletC: 1_000_000 },
    { key: 'B', cpu: { avg: 100, n: 288, cov: 1 }, mem: { avg: 0, n: 0, cov: 0 }, power: { avg: 100000, n: 24, cov: 1 }, inletC: -60 }] }, ['A', 'B'], now).rows;
  assert.deepEqual([wild[0].cpu.avg, wild[0].cpu.n, wild[0].cpu.expected, wild[0].mem.avg, wild[0].power.avg, wild[0].inletC], [null, null, null, null, null, null]);
  assert.deepEqual([wild[1].cpu.avg, wild[1].mem.avg, wild[1].mem.n, wild[1].power.avg, wild[1].inletC], [100, 0, 0, 100000, -60], '끝값은 값이다');
  assert.equal(PULL.sanitizePeerAvg(null, ['A']), null); assert.equal(PULL.sanitizePeerAvg({ ok: true }, ['A']), null); assert.equal(PULL.sanitizePeerAvg([], ['A']), null);
  assert.equal(PULL.sanitizePeerAvg({ ok: 'true', rows: [] }, ['A']).ok, false, 'ok 는 true 일 때만');
  // 줄 수 상한 — 청한 키 수에 비례(엣지가 수만 줄을 보내도 그만큼만 훑는다)
  const flood = { ok: true, rows: [...Array.from({ length: 5000 }, () => ({ key: 'JUNK' })), { key: 'A', inletC: 1 }] };
  assert.equal(PULL.sanitizePeerAvg(flood, ['A'], now).rows.length, 0);
  assert.equal(PULL.peerAvgBodyOk({ ok: true, rows: [] }), true); assert.equal(PULL.peerAvgBodyOk({ ok: true }), false); assert.equal(PULL.peerAvgBodyOk({ ok: false, rows: [] }), false);
});

test('⑥ 빈 키면 엣지에 요청하지 않는다', async () => {
  const r = await PULL.pullEdgePeerAvg('no-such-edge', { keys: [], from: 1, to: 2 });
  assert.deepEqual(r, { ok: true, body: { ok: true, rows: [], unknown: 0 }, ms: 0 });
});

// ───────── ⑦ 라우트 ─────────
const routes = new Map();
const reg = { get: (p, ...h) => routes.set(`GET ${p}`, h), post: (p, ...h) => routes.set(`POST ${p}`, h) };
registerBmFolders(reg); svcinv.registerSvcInventory(reg);
const ADMIN = { username: 'admin', role: 'admin', scope: { vcenters: [], regions: [], writeVcenters: [] } };
const OPER = { username: 'oper1', role: 'operator', scope: { vcenters: [], regions: [], writeVcenters: [] } };
const SCOPED_A = { username: 'scoped-a', role: 'admin', scope: { vcenters: ['vc-a'], regions: [], writeVcenters: [] } };
const SCOPED_B = { username: 'scoped-b', role: 'admin', scope: { vcenters: ['vc-b'], regions: [], writeVcenters: [] } };
let gen = 0;
const mkRes = () => ({ statusCode: 200, headers: {}, body: undefined, headersSent: false,
  status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; this.headersSent = true; return this; },
  setHeader(k, v) { this.headers[k] = v; }, set(k, v) { this.headers[k] = v; return this; }, end() { this.headersSent = true; return this; }, send(x) { this.body = x; this.headersSent = true; return this; } });
async function call(key, { user = ADMIN, query = {}, body = {} } = {}) {
  const res = mkRes();
  await routes.get(key).at(-1)({ user, query, body, ip: '127.0.0.1', headers: {}, originalUrl: `${key.replace(/^\w+ /, '/api')}?${new URLSearchParams(query)}&u=${user.username}&g=${gen}` }, res);
  return res;
}
const snapOf = (hosts = []) => ({ ...store.snapshot, initial: false, generatedAt: Date.now() + 1000 + (gen += 7),
  vcenters: [{ id: 'vc-a', name: 'vcenter-a', status: 'ok' }, { id: 'vc-b', name: 'vcenter-b', status: 'ok' }], hosts, vms: [] });
const withSnap = async (fn, hosts = []) => { const prev = store.snapshot; try { store.snapshot = snapOf(hosts); return await fn(); } finally { store.snapshot = prev; } };
const TAG = (i) => `SYNTH${String(i).padStart(2, '0')}`;
/** vc-a 에 R750 일곱 대(s1~s7) + R650 한 대(s8) · vc-b 에 R750 한 대(s9). */
function reset() {
  bs._resetForTest(); sm._resetForTest(); fleet.resetEdgeFleet();
  for (const f of fs.readdirSync(tmp)) fs.rmSync(path.join(tmp, f), { recursive: true, force: true });
  fs.writeFileSync(path.join(tmp, 'service-map.json'), JSON.stringify({ rev: 0, globals: [], settings: { tagCategory: '' }, corps: {} }));
  fs.writeFileSync(path.join(tmp, 'service-map-pins.json'), JSON.stringify({ rev: 0, pins: {} }));
  const S1 = (i, vc, model = 'PowerEdge R750') => ({ id: `s${i}`, name: `synth-db-s${i}`, host: `https://192.0.2.${10 + i}`, username: 'root', password: 'x', serviceTag: TAG(i), model, vcenterId: vc });
  registry.importServers([1, 2, 3, 4, 5, 6, 7].map((i) => S1(i, 'vc-a')).concat([S1(8, 'vc-a', 'PowerEdge R650'), S1(9, 'vc-b')]), 'replace');
  // 모델은 인벤토리에서 온다(등록부 값이 아니다) — 인벤토리를 못 읽은 서버는 ‘모델 모름’ 으로 묶지 않는다
  for (const i of [1, 2, 3, 4, 5, 6, 7, 9]) invCache.setInventory(`s${i}`, INV(TAG(i), 'PowerEdge R750'));
  invCache.setInventory('s8', INV(TAG(8), 'PowerEdge R650'));
}
const INV = (tag, model) => ({ collectedAt: 1_790_000_000_000, collections: { system: 'ok' }, system: { hostName: `os-${tag}`, model, manufacturer: 'Dell Inc.', serviceTag: tag } });
/** 이름 → 키 · 지정한 서버들을 폴더에 넣는다. */
async function place(names, folder = 'SVC\\DB', corp = 'vc-a') {
  const list = (await call('GET /tools/bm-folders')).body;
  assert.equal(list.ok, true, JSON.stringify(list).slice(0, 300));
  const keyOf = (n) => { const r = list.servers.find((x) => x.name === n); assert.ok(r, `${n} — ${JSON.stringify(list.servers.map((x) => x.name))}`); return r.key; };
  if (names.length) {
    const o = await call('POST /tools/bm-folders/op', { body: { op: 'assign', corp, path: folder, keys: names.map(keyOf), createMissing: true } });
    assert.equal(o.body.ok, true, JSON.stringify(o.body));
  }
  return keyOf;
}
const N = (i) => `synth-db-s${i}`;
const STAT = (avg, n = 288, cov = 1) => ({ avg, n, expected: 288, cov });
/** 의존 주입 — 엣지 수집 서버(태그 집합)와 값 표. */
function depsOf({ edgeTags = new Set(), cpu = {}, mem = {}, power = {}, inlet = {}, edge = null, samples = {}, cov = {}, calls = [], noTarget = new Set(), localUnknown = 0 } = {}) {
  // 실제 수집 노드처럼: 사용률 수집 대상이 아닌 서버는 CPU · 메모리를 답하지 않는다(전력 · 흡기 온도만)
  const st = (tbl, k) => (k in tbl && !noTarget.has(k) ? STAT(tbl[k], samples[k] ?? 288, cov[k] ?? 1) : null);
  const row = (k) => ({ key: k, cpu: st(cpu, k), mem: st(mem, k), power: k in power ? STAT(power[k], 24, cov[k] ?? 1) : null, inletC: inlet[k] ?? null, sensorAt: null });
  return {
    resolvePerfTarget: async (req, T, o) => {
      calls.push(['resolve', o.key, o.vcenterId]);
      await T.currentTargets(); await T.listEdgeBmUsage();
      if (noTarget.has(o.key)) return null;
      // 이 노드 해석의 agent 는 노드 이름이다(실제 resolvePerfTarget 과 같게 — 값 찾기 열쇠가 agent 를 쓰면 잡힌다)
      return edgeTags.has(o.key) ? { via: 'edge', agent: 'pl-edge', realKey: o.key, target: { vcenterId: o.vcenterId } } : { via: 'local', agent: 'central-host', realKey: o.key, target: { vcenterId: o.vcenterId } };
    },
    perfTargetFail: (f) => (f && f.target ? null : { __status: 404 }),
    targets: { currentTargets: async () => { calls.push(['targets']); return { targets: [] }; }, listEdgeBmUsage: async () => { calls.push(['edges']); return []; } },
    localSeries: async () => ({ ok: false }), edgeSeries: async () => ({ ok: false }),
    localPeer: async (o) => { calls.push(['local', [...o.keys].sort().join(','), o.to - o.from, typeof o.deps?.targets]); return { ok: true, rows: o.keys.map(row), ...(localUnknown ? { unknown: localUnknown } : {}) }; },
    edgePeer: async (agent, o) => { calls.push(['edge', agent, [...o.keys].sort().join(',')]); return edge || { ok: true, body: { ok: true, rows: o.keys.map(row), unknown: 0 } }; },
  };
}

test('⑦ /peer — 묶음 = 같은 법인 · 같은 폴더 · 같은 모델 · 엣지 위임 서버는 엣지마다 요청 1개 · 다른 서버의 이름 · 키는 싣지 않는다', async () => {
  reset();
  const calls = [];
  const cpu = { [TAG(1)]: 78, [TAG(2)]: 20, [TAG(3)]: 22, [TAG(4)]: 21, [TAG(5)]: 23, [TAG(6)]: 19 };
  const mem = { [TAG(1)]: 40, [TAG(2)]: 41, [TAG(3)]: 39, [TAG(4)]: 42, [TAG(5)]: 40, [TAG(6)]: 38 };
  const power = { [TAG(1)]: 410, [TAG(2)]: 400, [TAG(3)]: 405, [TAG(5)]: 395, [TAG(6)]: 402 };
  const inlet = { [TAG(1)]: 24, [TAG(2)]: 23, [TAG(3)]: 24, [TAG(4)]: 23, [TAG(6)]: 24 };
  try {
    await withSnap(async () => {
      // s1~s6 을 같은 폴더에 · s7(같은 모델)은 다른 폴더 · s8(다른 모델)은 같은 폴더 · s9 는 다른 법인
      const keyOf = await place([1, 2, 3, 4, 5, 6, 8].map(N));
      await place([N(7)], 'SVC\\WEB');
      await place([N(9)], 'SVC\\DB', 'vc-b');   // 다른 법인의 같은 경로 · 같은 모델 — 묶음이 아니다
      _setTrendDepsForTest(depsOf({ edgeTags: new Set([TAG(5), TAG(6)]), cpu, mem, power, inlet, calls }));
      const r = await call('GET /tools/bm-folders/peer', { query: { key: keyOf(N(1)) } });
      assert.equal(r.statusCode, 200, JSON.stringify(r.body).slice(0, 300));
      const d = r.body;
      assert.deepEqual([d.ok, d.hours, d.min, d.minSamples, d.minCoverage, d.why], [true, 24, 5, 12, 0.5, undefined]);
      assert.deepEqual(d.group, { path: 'SVC\\DB', model: 'PowerEdge R750', size: 6, used: 6 }, '다른 폴더(s7) · 다른 모델(s8) · 다른 법인(s9)은 묶음이 아니다');
      assert.deepEqual([d.metrics.cpu.state, d.metrics.cpu.value, d.metrics.cpu.n, d.metrics.cpu.median], ['high', 78, 6, 21.5]);
      assert.deepEqual([d.metrics.mem.state, d.metrics.power.state, d.metrics.inlet.state], ['in', 'in', 'in']);
      assert.deepEqual([d.metrics.power.n, d.metrics.power.missing, d.metrics.inlet.missing], [5, 1, 1], '값이 없는 서버는 빼고 센다');
      assert.deepEqual([d.out, d.judged, d.notes], [1, 4, {}]);
      assert.deepEqual(d.self, { cpu: { n: 288, cov: 1 }, mem: { n: 288, cov: 1 }, power: { n: 24, cov: 1 } }, '이 서버의 표본 수 · 구간 비율(값 없음의 이유를 화면이 밝히게)');
      assert.deepEqual([d.metrics.power.basis, d.metrics.inlet.basis], ['avg24', 'now']);
      assert.deepEqual(d.metrics.cpu.points, [19, 20, 21, 22, 23, 78]);
      // 엣지마다 요청 1개(서버마다 WAN 을 왕복하지 않는다) · 이 노드 서버도 한 번에
      assert.deepEqual(calls.filter((c) => c[0] === 'edge'), [['edge', 'pl-edge', `${TAG(5)},${TAG(6)}`]]);
      assert.deepEqual(calls.filter((c) => c[0] === 'local'), [['local', [1, 2, 3, 4].map(TAG).join(','), 24 * 3_600_000, 'function']], '이 노드 계산에 이 요청의 대상 목록을 넘긴다');
      // 대상 해석 = (법인, 사용률 키) 쌍 · 대상 목록 두 조회는 요청당 한 번
      assert.equal(calls.filter((c) => c[0] === 'resolve').length, 6); assert.ok(calls.some((c) => c[0] === 'resolve' && c[1] === TAG(1) && c[2] === 'vc-a'));
      assert.deepEqual([calls.filter((c) => c[0] === 'targets').length, calls.filter((c) => c[0] === 'edges').length], [1, 1]);
      // 다른 서버의 이름 · 태그 · 키 · 주소는 응답에 없다(값 점만)
      const txt = JSON.stringify(d);
      for (const i of [2, 3, 4, 5, 6]) assert.equal(new RegExp(`${TAG(i)}|synth-db-s${i}|192\\.0\\.2\\.`, 'i').test(txt), false, `s${i}`);
      assert.equal(r.headers['Cache-Control'], 'no-store');
      // 묶음의 다른 서버를 열면 그 서버 기준으로 — s2 는 폭 안
      const r2 = (await call('GET /tools/bm-folders/peer', { query: { key: keyOf(N(2)) } })).body;
      assert.deepEqual([r2.metrics.cpu.state, r2.metrics.cpu.value, r2.out], ['in', 20, 0]);
      // 같은 (엣지, 키 묶음)은 60초 동안 한 번만 WAN 으로
      assert.equal(calls.filter((c) => c[0] === 'edge').length, 1);
    });
  } finally { _setTrendDepsForTest(null); }
});

test('⑦ /peer — 판정하지 않는 경우: 미분류 · 묶음이 5대 미만 · 값 있는 서버가 모자람 · 표본 부족 · 수집 대상 아님(따로 센다)', async () => {
  reset();
  try {
    await withSnap(async () => {
      const keyOf = await place([1, 2, 3, 4].map(N));
      await place([N(8)], 'SVC\\ONE');
      _setTrendDepsForTest(depsOf({ cpu: { [TAG(1)]: 50 } }));
      // 폴더에 넣지 않은 서버
      const un = (await call('GET /tools/bm-folders/peer', { query: { key: keyOf(N(5)) } })).body;
      assert.deepEqual([un.ok, un.why, un.metrics, un.group], [true, 'unplaced', undefined, undefined]);
      // 묶음 4대
      const few = (await call('GET /tools/bm-folders/peer', { query: { key: keyOf(N(1)) } })).body;
      assert.deepEqual([few.why, few.group, few.metrics], ['few', { path: 'SVC\\DB', model: 'PowerEdge R750', size: 4 }, undefined]);
      // 혼자인 모델
      assert.equal((await call('GET /tools/bm-folders/peer', { query: { key: keyOf(N(8)) } })).body.why, 'few');
    });
    await withSnap(async () => {
      const keyOf = await place([5, 6].map(N));   // 이제 6대
      const tags = [1, 2, 3, 4, 5, 6].map(TAG);
      const cpu = Object.fromEntries(tags.map((k, i) => [k, 20 + i]));
      // ① 값 있는 서버 4대(둘은 계열 없음) → few(지표 단위) · ② 표본 11개인 서버는 값 없음 · ③ 수집 대상이 아닌 서버는 따로 센다
      const part = { ...cpu }; delete part[TAG(5)]; delete part[TAG(6)];
      // 전력: 목록 행에 ‘지금 전력’ 이 있어도 평균이 없으면 값 없음(기준이 다른 값으로 대신 채우지 않는다)
      _setTrendDepsForTest(depsOf({ cpu: part, mem: cpu, samples: { [TAG(2)]: 11 }, noTarget: new Set([TAG(3)]) }));
      const d = (await call('GET /tools/bm-folders/peer', { query: { key: keyOf(N(1)) } })).body;
      assert.deepEqual([d.why, d.group.size, d.group.used], [undefined, 6, 6]);
      assert.deepEqual([d.metrics.cpu.state, d.metrics.cpu.n, d.metrics.cpu.missing, d.metrics.cpu.value], ['few', 2, 4, 20], '4대 중 표본 부족 1 · 대상 아님 1 을 뺀 2대');
      assert.deepEqual([d.metrics.mem.state, d.metrics.mem.n, d.metrics.mem.missing], ['few', 4, 2]);
      assert.deepEqual([d.metrics.power.state, d.metrics.power.n, d.metrics.inlet.state], ['none', 0, 'none'], '전력 평균 · 온도를 읽지 못한 서버 — 0 W 가 아니다');
      assert.deepEqual([d.out, d.judged, d.notes], [0, 0, { noTarget: 1 }]);
      // 이 서버가 표본 부족이면 none + 표본 수를 밝힌다
      const d2 = (await call('GET /tools/bm-folders/peer', { query: { key: keyOf(N(2)) } })).body;
      assert.deepEqual([d2.metrics.cpu.state, d2.metrics.cpu.value, d2.self], ['none', null, { cpu: { n: 11, cov: 1 }, mem: { n: 11, cov: 1 }, power: null }]);
      // 점은 많아도 하루의 절반을 덮지 못한 서버(구간 비율 0.3) — 값 없음 · 비율을 밝힌다
      _setTrendDepsForTest(depsOf({ cpu, mem: cpu, cov: { [TAG(4)]: 0.3 } }));
      const d3 = (await call('GET /tools/bm-folders/peer', { query: { key: keyOf(N(4)) } })).body;
      assert.deepEqual([d3.metrics.cpu.state, d3.metrics.cpu.n, d3.metrics.cpu.missing, d3.self.cpu], ['none', 5, 1, { n: 288, cov: 0.3 }]);
      const d4 = (await call('GET /tools/bm-folders/peer', { query: { key: keyOf(N(1)) } })).body;
      assert.deepEqual([d4.metrics.cpu.state, d4.metrics.cpu.n], ['in', 5], '다른 서버는 남은 5대로 판정');
      // 사용률 수집 대상이 아닌 서버(그 법인 수집 꺼짐 등)도 전력 · 흡기 온도는 견준다 — 그 서버를 수집하는 노드에 같은 키로 묻는다(엣지가 올린 서버는 그 엣지 · 그 밖은 이 노드)
      const calls = []; const watts = Object.fromEntries(tags.map((k, i) => [k, 400 + i * 2])); const temp = Object.fromEntries(tags.map((k) => [k, 23]));
      _setTrendDepsForTest(depsOf({ cpu, mem: cpu, power: watts, inlet: temp, noTarget: new Set([TAG(3), TAG(1)]), calls }));
      const d5 = (await call('GET /tools/bm-folders/peer', { query: { key: keyOf(N(1)) } })).body;
      assert.deepEqual([d5.metrics.cpu.state, d5.metrics.cpu.n, d5.metrics.cpu.missing], ['none', 4, 2], '이 서버도 대상이 아니다 — CPU 값 없음');
      assert.deepEqual([d5.metrics.power.state, d5.metrics.power.n, d5.metrics.power.value, d5.metrics.inlet.state, d5.metrics.inlet.n], ['in', 6, 400, 'in', 6], '전력 · 흡기 온도는 여섯 대 모두');
      assert.deepEqual([d5.notes, d5.judged, d5.self], [{ noTarget: 2 }, 2, { cpu: null, mem: null, power: { n: 24, cov: 1 } }]);
      assert.deepEqual(calls.filter((c) => c[0] === 'local').map((c) => c[1]), [tags.slice().sort().join(',')], '대상이 아닌 서버의 키도 이 노드에 함께 묻는다(요청 1개)');
      // 수집 노드가 모른다고 답한 서버 수는 따로 센다(값 없음의 이유 — 반증 A8)
      _setTrendDepsForTest(depsOf({ cpu, mem: cpu, localUnknown: 2 }));
      assert.deepEqual((await call('GET /tools/bm-folders/peer', { query: { key: keyOf(N(1)) } })).body.notes, { unknown: 2 });
      // 전력 평균도 구간 비율이 모자라면 값 없음(지금 전력 · 다른 기준으로 채우지 않는다)
      _setTrendDepsForTest(depsOf({ cpu, mem: cpu, power: watts, inlet: temp, cov: { [TAG(1)]: 0.3 } }));
      const d6 = (await call('GET /tools/bm-folders/peer', { query: { key: keyOf(N(1)) } })).body;
      assert.deepEqual([d6.metrics.power.state, d6.metrics.power.value, d6.self.power], ['none', null, { n: 24, cov: 0.3 }]);
    });
  } finally { _setTrendDepsForTest(null); }
});

test('⑦ /peer — 구버전 엣지 · 엣지 실패는 그 서버들을 빼고 따로 센다 · 실패 사유(주소)는 전체 범위 관리자에게만', async () => {
  reset();
  const cpu = Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((i) => [TAG(i), 20 + i]));
  try {
    await withSnap(async () => {
      const keyOf = await place([1, 2, 3, 4, 5, 6, 7].map(N));
      const k1 = keyOf(N(1));
      _setTrendDepsForTest(depsOf({ edgeTags: new Set([TAG(6), TAG(7)]), cpu, edge: { ok: false, kind: 'old-version', reason: "엣지 'pl-edge' 가 구버전입니다" } }));
      const o = (await call('GET /tools/bm-folders/peer', { query: { key: k1 } })).body;
      assert.deepEqual([o.metrics.cpu.state, o.metrics.cpu.n, o.metrics.cpu.missing, o.notes], ['in', 5, 2, { oldEdge: 1 }], '엣지 2대는 값 없음 — 남은 5대로 판정');
      assert.deepEqual(o.reasons, ["엣지 'pl-edge' 가 구버전입니다"]);
      _setTrendDepsForTest(depsOf({ edgeTags: new Set([TAG(6), TAG(7)]), cpu, edge: { ok: false, kind: 'error', reason: 'fetch failed https://192.0.2.99:8443' } }));
      const f = (await call('GET /tools/bm-folders/peer', { query: { key: k1 } })).body;
      assert.deepEqual([f.notes, /192\.0\.2\.99/.test(f.reasons[0])], [{ edgeFail: 1 }, true]);
      // 운영자(관리자 아님) · 범위 관리자에게는 사유를 싣지 않는다(수만)
      const op = (await call('GET /tools/bm-folders/peer', { user: OPER, query: { key: k1 } })).body;
      assert.deepEqual([op.notes, op.reasons], [{ edgeFail: 1 }, undefined]);
      const tok = (await call('GET /tools/bm-folders', { user: SCOPED_A })).body.servers.find((x) => x.name === N(1)).key;
      const sc = (await call('GET /tools/bm-folders/peer', { user: SCOPED_A, query: { key: tok } })).body;
      assert.deepEqual([sc.ok, sc.notes, sc.reasons, sc.metrics.cpu.n], [true, { edgeFail: 1 }, undefined, 5]);
      assert.equal(/192\.0\.2\.99|pl-edge/.test(JSON.stringify(sc)), false);
      // 이 노드 읽기가 실패하면 localFail(값은 전부 없음 — 0 으로 판정하지 않는다)
      const dd = depsOf({ cpu }); dd.localPeer = async () => { throw new Error('sqlite busy'); };
      _setTrendDepsForTest(dd);
      const lf = (await call('GET /tools/bm-folders/peer', { query: { key: k1 } })).body;
      assert.deepEqual([lf.notes, lf.metrics.cpu.state, lf.judged], [{ localFail: 1 }, 'none', 0]);
    });
  } finally { _setTrendDepsForTest(null); }
});

test('⑦ /peer — 범위 밖 · 없는 키 404 · 폴더 저장소를 못 읽으면 503 · 엣지 포탈에서는 답하지 않는다', async (t) => {
  reset();
  let k1 = ''; let k9 = '';
  try {
    await withSnap(async () => {
      const keyOf = await place([1, 2, 3, 4, 5].map(N));
      k1 = keyOf(N(1)); k9 = keyOf(N(9));
      _setTrendDepsForTest(depsOf({ cpu: Object.fromEntries([1, 2, 3, 4, 5].map((i) => [TAG(i), 30])) }));
      assert.equal((await call('GET /tools/bm-folders/peer', { user: SCOPED_B, query: { key: k1 } })).statusCode, 404, '다른 법인 범위 계정');
      assert.equal((await call('GET /tools/bm-folders/peer', { query: { key: 'st:nope' } })).statusCode, 404);
      // 범위 밖 서버의 토큰을 손에 넣어도(같은 프로세스 HMAC) 범위 안 후보에서만 되돌린다
      const tokA = (await call('GET /tools/bm-folders', { user: SCOPED_A })).body.servers.find((x) => x.name === N(1)).key;
      assert.equal((await call('GET /tools/bm-folders/peer', { user: SCOPED_B, query: { key: tokA } })).statusCode, 404, '다른 법인 서버의 토큰');
      assert.equal((await call('GET /tools/bm-folders/peer', { user: SCOPED_A, query: { key: tokA } })).statusCode, 200);
      assert.equal((await call('GET /tools/bm-folders/peer', { query: {} })).statusCode, 404);
      assert.equal((await call('GET /tools/bm-folders/peer', { query: { key: ['a', 'b'] } })).statusCode, 404, '배열 키');
      // 범위 계정은 자기 법인 서버만 — vc-b 의 s9 는 폴더 밖이라 unplaced
      const tok9 = (await call('GET /tools/bm-folders', { user: SCOPED_B })).body.servers.find((x) => x.name === N(9)).key;
      assert.equal((await call('GET /tools/bm-folders/peer', { user: SCOPED_B, query: { key: tok9 } })).body.why, 'unplaced');
      assert.equal((await call('GET /tools/bm-folders/peer', { query: { key: k9 } })).body.why, 'unplaced');
      // 모델을 모르는 서버(인벤토리 없음)는 묶음을 정하지 않는다
      invCache.setInventory('s6', null);
    });
    await withSnap(async () => {
      const list = (await call('GET /tools/bm-folders')).body;
      const k6 = list.servers.find((x) => x.name === N(6)).key;
      const o = await call('POST /tools/bm-folders/op', { body: { op: 'assign', corp: 'vc-a', path: 'SVC\\DB', keys: [k6], createMissing: true } });
      assert.equal(o.body.ok, true, JSON.stringify(o.body));
    });
    await withSnap(async () => {
      const list = (await call('GET /tools/bm-folders')).body;
      const r6 = list.servers.find((x) => x.name === N(6));
      assert.equal(r6.model || '', '', `인벤토리가 없는 서버의 모델: ${r6.model}`);
      assert.deepEqual((await call('GET /tools/bm-folders/peer', { query: { key: r6.key } })).body.why, 'no-model');
      // ESXi 행(vCenter 호스트)은 견주지 않는다
      const e = await call('GET /tools/bm-folders/search', { query: { inc: 'esx', kinds: 'esxi' } });
      assert.ok(e.body.rows?.length, JSON.stringify(e.body).slice(0, 200));
      const er = await call('GET /tools/bm-folders/peer', { query: { key: e.body.rows[0].key } });
      assert.deepEqual([er.statusCode, er.body.why, er.body.metrics], [200, 'esxi', undefined]);
    }, [{ id: 'h1', name: 'esx-01', vcenterId: 'vc-a', serviceTag: 'HT1' }]);
    const { config } = await import('../src/config.js');
    const prev = config.agent.centralUrl; config.agent.centralUrl = 'https://central.example.test';
    try { await withSnap(async () => { const r = await call('GET /tools/bm-folders/peer', { query: { key: k1 } }); assert.deepEqual([r.statusCode, r.body.error], [404, 'central-only']); }); } finally { config.agent.centralUrl = prev; }
    const w = console.error; const ww = console.warn; console.error = () => {}; console.warn = () => {};
    t.after(() => { console.error = w; console.warn = ww; });
    bs._resetForTest(); fs.writeFileSync(path.join(tmp, 'bm-folders-assign.json'), '{oops');
    await withSnap(async () => { const r = await call('GET /tools/bm-folders/peer', { query: { key: k1 } }); assert.deepEqual([r.statusCode, r.body.error], [503, 'registryUnreadable']); });
  } finally { _setTrendDepsForTest(null); reset(); }
});

test('⑦ /peer — 묶음 상한: 이 서버는 반드시 넣고 넘친 수를 밝힌다', async () => {
  reset();
  const max = P.PEER_GROUP_MAX; const total = max + 5;
  const S1 = (i) => ({ id: `b${i}`, name: `synth-big-${i}`, host: `https://192.0.2.${1 + (i % 250)}`, username: 'root', password: 'x', serviceTag: `SYNB${String(i).padStart(3, '0')}`, model: 'PowerEdge R760', vcenterId: 'vc-a' });
  registry.importServers(Array.from({ length: total }, (_, i) => S1(i + 1)), 'replace');
  for (let i = 1; i <= total; i++) invCache.setInventory(`b${i}`, INV(`SYNB${String(i).padStart(3, '0')}`, 'PowerEdge R760'));
  const cpu = Object.fromEntries(Array.from({ length: total }, (_, i) => [`SYNB${String(i + 1).padStart(3, '0')}`, 30]));
  const calls = [];
  try {
    await withSnap(async () => {
      const names = Array.from({ length: total }, (_, i) => `synth-big-${i + 1}`);
      const keyOf = await place(names, 'SVC\\BIG');
      _setTrendDepsForTest(depsOf({ cpu, calls }));
      const last = (await call('GET /tools/bm-folders/peer', { query: { key: keyOf(`synth-big-${total}`) } })).body;
      assert.deepEqual([last.group.size, last.group.used, last.group.truncated], [total, max, 5]);
      assert.deepEqual([last.metrics.cpu.state, last.metrics.cpu.n, last.metrics.cpu.value], ['in', max, 30], '목록 끝의 서버를 열어도 그 서버는 들어간다');
      assert.equal(calls.filter((c) => c[0] === 'local')[0][1].split(',').length, max, '한 요청의 키 수 = 상한');
      // 표본은 보는 사람과 무관하다(원문 키 순서) — 관리자 · 운영자가 같은 서버들로 견준다(반증 A1)
      calls.length = 0;
      await call('GET /tools/bm-folders/peer', { user: OPER, query: { key: keyOf(`synth-big-${total}`) } });
      const opKeys = calls.filter((c) => c[0] === 'local')[0][1];
      calls.length = 0;
      await call('GET /tools/bm-folders/peer', { query: { key: keyOf(`synth-big-${total}`) } });
      assert.equal(calls.filter((c) => c[0] === 'local')[0][1], opKeys);
    });
  } finally { _setTrendDepsForTest(null); reset(); }
});

test('⑦ /peer — 같은 엣지라도 키 묶음이 다르면 다시 묻는다 · 모델은 대소문자를 가리지 않는다(반증 A5 제안 P2 · Mg)', async () => {
  reset();
  try {
    await withSnap(async () => {
      await place([1, 2, 3, 4, 5].map(N));
      registry.importServers([10, 11, 12, 13, 14].map((i) => ({ id: `s${i}`, name: `synth-db-s${i}`, host: `https://192.0.2.${10 + i}`, username: 'root', password: 'x', serviceTag: TAG(i), model: 'PowerEdge R750', vcenterId: 'vc-a' })), 'merge');
      for (const i of [10, 11, 12, 13]) invCache.setInventory(`s${i}`, INV(TAG(i), 'PowerEdge R750'));
      invCache.setInventory('s14', INV(TAG(14), 'POWEREDGE r750'));
    });
    await withSnap(async () => {
      const keyOf2 = await place([10, 11, 12, 13, 14].map(N), 'SVC\\WEB');
      const list = (await call('GET /tools/bm-folders')).body; const k1 = list.servers.find((x) => x.name === N(1)).key;
      const calls = []; const all = [1, 2, 3, 4, 5, 10, 11, 12, 13, 14];
      _setTrendDepsForTest(depsOf({ edgeTags: new Set(all.map(TAG)), cpu: Object.fromEntries(all.map((i) => [TAG(i), i])), calls }));
      const a = (await call('GET /tools/bm-folders/peer', { query: { key: k1 } })).body;
      const b = (await call('GET /tools/bm-folders/peer', { query: { key: keyOf2(N(10)) } })).body;
      assert.deepEqual([a.metrics.cpu.n, b.metrics.cpu.n, b.group.size], [5, 5, 5], '대소문자만 다른 모델(s14)도 같은 묶음');
      assert.equal(calls.filter((c) => c[0] === 'edge').length, 2, '다른 키 묶음은 합치지 않는다');
    });
  } finally { _setTrendDepsForTest(null); }
});

// ───────── ⑧ 최소 엣지 버전 ─────────
test('⑧ 최소 엣지 버전 — 릴리스 노트의 표지 제목 첫 게시 번호(없으면 지금 번호) · 숫자를 박지 않는다 · 수집 서버 경로는 토큰이 먼저', async () => {
  const dir = tmpDir('bmpeer-mv-');
  const f = path.join(dir, 'notes.json');
  fs.writeFileSync(f, JSON.stringify({ notes: [{ version: '3.50.0', title: '물리서버 — 같은 묶음 대비 보강' }, { version: '3.46.0', title: '물리서버 — 같은 묶음 대비(CPU · 메모리 · 전력 · 흡기 온도)' }, { version: '3.45.0', title: '물리서버 점검 — 보증' }] }));
  MV._resetFeatureMinEdgeVersionForTest();
  try {
    assert.equal(MV.peerMinEdgeVersion({ notesFile: f, fallback: () => '9.9.9' }), '3.46.0');
    MV._resetFeatureMinEdgeVersionForTest();
    fs.writeFileSync(f, JSON.stringify({ notes: [{ version: '3.45.0', title: '물리서버 점검 — 보증' }] }));
    assert.equal(MV.peerMinEdgeVersion({ notesFile: f, fallback: () => '9.9.9' }), '9.9.9', '노트에 없으면 지금 번호');
  } finally { MV._resetFeatureMinEdgeVersionForTest(); }
  const { stripComments } = await import('./_stripComments.js');
  const pull = stripComments(fs.readFileSync(path.join(here, '../src/central/bmPeerPull.js'), 'utf8'));
  assert.doesNotMatch(pull, /MIN_EDGE_VERSION\s*=\s*'\d|minVersion:\s*'\d/);
  assert.match(pull, /minVersion: peerMinEdgeVersion\(\)/); assert.match(pull, /retries: 0/, '읽기 요청이지만 POST — 자동 재시도 없음');
  const col = stripComments(fs.readFileSync(path.join(here, '../src/routes/collector.js'), 'utf8'));
  assert.match(col, /collectorRouter\.post\('\/bm-usage\/peer-avg', tokenFirst\('bm-usage-peer-avg'\), express\.json\(\{ limit: '80kb' \}\)/, '토큰 확인이 본문 파싱보다 먼저');
  // 라우트는 판정을 복제하지 않는다(코어 하나) · 대상 해석은 추이와 같은 함수
  const route = stripComments(fs.readFileSync(path.join(here, '../src/routes/api/bmFolders.js'), 'utf8'));
  const at = route.indexOf("api.get('/tools/bm-folders/peer'"); const seg = route.slice(at, route.indexOf("api.get('/tools/bm-folders/trend'"));
  assert.ok(at > 0 && seg.length > 500);
  assert.match(seg, /judgePeerGroup\(/); assert.match(seg, /D\.resolvePerfTarget\(req, T, \{ allowed, isAdmin: admin, key: m\.usageKey, vcenterId: m\.corp \}\)/);
  assert.match(seg, /D\.perfTargetFail\(found\)/); assert.doesNotMatch(seg, /quantile|1\.5 \*/);
  assert.doesNotMatch(seg, /\.watts\b/, '전력 평균을 목록 행의 지금 전력으로 대신 채우지 않는다(기준을 섞지 않는다)');
  // 해석이 실패한 서버의 폴백: 엣지가 올린 서버(remoteAgent) → 수집 서버(pull) 출처(collectorId → 등록부 이름) → 이 노드(반증 A2)
  assert.match(seg, /t\(m\.remoteAgent\) \|\| \(t\(m\.collectorId\) && typeof D\.collectorName === 'function' \? await D\.collectorName\(t\(m\.collectorId\)\)/);
});
