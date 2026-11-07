// v2.927 — Monitoring 개선: 개요 집계 양보(반증 M6 후속) · 동시 요청 공유 · 엣지 알림 키(재배정 재알림 · 메타 없을 때 보류) · 개요→트리 바로가기 id.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'svcmon2927-'));
process.env.CONFIG_DIR = TMP;
process.env.AUTH_ENABLED = 'true';

const D = await import('../src/svcmon/dash.js');
const TR = await import('../src/svcmon/transitions.js');
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

/** 결정적 의사 난수(테스트 재현). */
function rng(seed) { let x = seed >>> 0; return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; }
function dataset(nTargets = 400, testsPer = 5, seed = 7) {
  const r = rng(seed); const now = Date.now();
  const STATES = ['ok', 'ok', 'ok', 'warn', 'bad'];
  const targets = []; const results = new Map();
  for (let i = 0; i < nTargets; i++) {
    const tests = [];
    for (let j = 0; j < testsPer; j++) {
      const id = `t${i}-${j}`; const type = j === 0 ? 'cert' : (j === 1 ? 'tcp' : 'http');
      tests.push({ id, name: `점검${j}`, type, intervalSec: 60 });
      const st = STATES[Math.floor(r() * STATES.length)];
      // 동점(같은 ms·같은 streak·같은 D-일)을 일부러 많이 만든다 — 상위 K 의 동점 순서가 예전 전체 정렬과 같아야 한다.
      results.set(id, { status: st, ms: Math.floor(r() * 20) * 10, ts: now, streak: Math.floor(r() * 5), reply: type === 'cert' ? `D-${Math.floor(r() * 90)}` : 'x' });
    }
    targets.push({ id: `g${i}`, kind: i % 3 ? 'infra' : 'service', name: `host-${i}`, host: `10.0.${i % 250}.1`, path: `법인${i % 7}\\폴더`, enabled: true, tests,
      ...(i % 4 === 0 ? { origin: { key: `set:idrac|r${i}`, kind: 'set:idrac', corp: `C${i % 5}` } } : {}) });
  }
  const edgeItems = { 'edge-a': [], 'edge-b': [] };
  for (let i = 0; i < 300; i++) {
    const tg = targets[i % targets.length];
    edgeItems[i % 2 ? 'edge-a' : 'edge-b'].push({ state: ['ok', 'warn', 'bad', 'unknown', 'stale'][i % 5], path: tg.path, target: tg.name, host: tg.host, test: `e${i}`, type: i % 7 ? 'tcp' : 'cert', reply: `D-${i % 70}`, ms: (i % 13) * 7, streak: i % 9 });
  }
  return { targets, results, edgeItems, now };
}
test('buildDashAsync 는 동기판 buildDash 와 결과가 같고, 양보한다', async () => {
  const { targets, results, edgeItems, now } = dataset();
  const agents = Object.keys(edgeItems);
  const sync = D.buildDash({ targets, results, edgeStates: agents.map((a) => ({ agent: a, items: edgeItems[a] })), now, executes: true });
  let yields = 0;
  const async = await D.buildDashAsync({ targets, results, agents, edgeItemsOf: (a) => edgeItems[a], now, executes: true },
    { maybeYield: async () => { yields += 1; await new Promise((r) => setImmediate(r)); return true; }, every: 100 });
  assert.deepEqual(async, sync);
  assert.ok(yields >= 20, `양보 ${yields}회 — 큰 입력에서 이벤트 루프를 놓아야 한다`);
});

test('표 위젯 상위 K 는 예전 전체 정렬 결과와 같다(동점 순서 포함)', () => {
  const { targets, results, edgeItems, now } = dataset(600, 6, 11);
  const edgeStates = Object.keys(edgeItems).map((a) => ({ agent: a, items: edgeItems[a] }));
  const d = D.buildDash({ targets, results, edgeStates, now, executes: true });
  // 예전(v2.915) 식 — 같은 입력을 같은 순서로 펼친 뒤 filter + 안정 정렬 + slice
  const flat = [];
  for (const tg of targets) for (const x of tg.tests) { const r = results.get(x.id); flat.push({ state: r.status, where: '', target: tg.name, test: x.name, type: x.type, reply: r.reply, ms: r.ms, streak: r.streak }); }
  for (const es of edgeStates) for (const it of es.items) flat.push({ state: it.state, where: es.agent, target: it.target, test: it.test, type: it.type, reply: it.reply, ms: it.ms, streak: it.streak });
  const slow = flat.filter((x) => (x.state === 'ok' || x.state === 'warn') && x.ms != null && x.type !== 'cert' && x.type !== 'domain').sort((a, b) => b.ms - a.ms).slice(0, 8);
  const streaks = flat.filter((x) => x.state === 'bad').sort((a, b) => b.streak - a.streak).slice(0, 10);
  const certs = flat.filter((x) => x.type === 'cert').map((x) => ({ ...x, days: D.certDaysOf(x.reply) })).filter((x) => x.days != null && x.days <= 60).sort((a, b) => a.days - b.days).slice(0, 10);
  const pick = (arr) => arr.map((x) => `${x.where}|${x.target}|${x.test}`);
  assert.deepEqual(pick(d.slow), pick(slow));
  assert.deepEqual(pick(d.streaks), pick(streaks));
  assert.deepEqual(pick(d.certs), pick(certs));
});

test('호스트 맵 칸은 개요→트리 바로가기용 id·구분을 싣는다(중앙 대상만)', () => {
  const { targets, results, now } = dataset(10, 2, 3);
  const d = D.buildDash({ targets, results, edgeStates: [{ agent: 'edge-x', items: [{ state: 'ok', path: 'nowhere', target: 'ghost', test: 't', type: 'tcp' }] }], now });
  const h = d.hexes.find((x) => x.name === 'host-0');
  assert.equal(h.id, 'g0');
  assert.equal(h.targetKind, 'service');
  assert.equal(d.hexes.find((x) => x.name === 'ghost').id, '', '중앙 저장소에 없는 엣지 행은 id 없음(이름 검색으로)');
});

/* ── 알림 키 ── */
test('엣지 알림 키는 이름 기준 — 재배정으로 점검 id 가 바뀌어도 다시 알리지 않는다 · 이름을 모르면 보류', async () => {
  const sent = [];
  TR._resetTransitionsForTest({ send: async (a) => { sent.push(a); } });
  TR._setAlertSettingsForTest({ enabled: true, failCount: 2, recover: true });
  assert.equal(TR.alertKeyOf({ scope: '', testId: 't9' }), '|t9');
  assert.equal(TR.alertKeyOf({ scope: 'edge-a', testId: 'e1', target: {}, test: {} }), null);
  const named = { scope: 'edge-a', target: { name: 'vc-a', path: 'P' }, test: { name: 'TCP 443', type: 'tcp' } };
  // 중앙 재시작 직후 — 메타 없음: 연속 5회여도 판정 보류(내부 id 로 알리지 않는다)
  TR.noteResult({ scope: 'edge-a', testId: 'old-1', status: 'bad', streak: 5, target: {}, test: {} });
  await TR.flushAlerts();
  assert.equal(sent.length, 0);
  assert.equal(TR.alertStats().metaPending, 1, '지금 보류 중인 수(누적이 아니다)');
  // 메타가 온 다음 결과 — 누적 연속 횟수로 바로 판정, 라벨은 이름
  TR.noteResult({ ...named, testId: 'old-1', prev: 'bad', status: 'bad', streak: 6 });
  await TR.flushAlerts();
  assert.equal(sent.length, 1);
  assert.equal(TR.alertStats().metaPending, 0, '판정되면 보류에서 빠진다');
  assert.match(sent[0].title, /vc-a › TCP 443/);
  // 배정 재스냅샷 — 같은 점검에 새 id. 실패가 이어져도 다시 알리지 않는다
  TR.noteResult({ ...named, testId: 'new-7', status: 'bad', streak: 7 });
  await TR.flushAlerts();
  assert.equal(sent.length, 1, '재배정이 같은 실패를 다시 알리면 안 된다');
  // 복구는 새 id 로 와도 이어진다
  TR.noteResult({ ...named, testId: 'new-7', prev: 'bad', status: 'ok', streak: 1 });
  await TR.flushAlerts();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].severity, 'info');
});

/* ── 라우트: 동시 요청은 계산 하나를 함께 기다린다 ── */
let server; let base;
before(async () => {
  const express = (await import('express')).default;
  const { svcmonRouter } = await import('../src/routes/svcmon.js');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: 'v', role: 'viewer' }; next(); });
  app.use('/api/svcmon', svcmonRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api/svcmon`;
});
after(() => { try { server?.close(); } catch { /* */ } });

test('/overview — 동시 요청 3건은 계산 1번 · 같은 세대 재요청은 캐시', async () => {
  const R = await import('../src/routes/svcmon/settingsSync.js');
  R._dashStateForTest({ reset: true });
  const rs = await Promise.all([1, 2, 3].map(() => fetch(`${base}/overview`).then((r) => r.json())));
  for (const b of rs) assert.equal(b.ok, true);
  assert.equal(R._dashStateForTest().builds, 1, '동시 요청은 진행 중인 계산을 함께 기다린다');
  await fetch(`${base}/overview`);
  assert.equal(R._dashStateForTest().builds, 1, '30초 안 같은 저장소 세대는 캐시');
});

test('트리 표 열 최소폭 합이 1440px 오른쪽 표 폭 안에 든다(TEST METHOD 잘림 회귀)', () => {
  const css = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'web', 'src', 'styles.css'), 'utf8');
  const m = /\.pc-thead, \.pc-tr, \.pc-group \{ display: grid; grid-template-columns: ([^;]+);/.exec(css);
  assert.ok(m, '열 정의를 찾지 못함');
  const mins = [...m[1].matchAll(/minmax\((\d+)px|(?:^|\s)(\d+)px(?=\s|$)/g)].map((x) => Number(x[1] || x[2]));
  const sum = mins.reduce((a, b) => a + b, 0);
  // 1440 - 사이드바 236 - 좌우 여백 48 - 트리 340 - 분할 막대 8 - 간격 12 ≈ 796
  assert.ok(sum <= 790, `열 최소폭 합 ${sum}px — 1440px 에서 표 폭(약 796px)을 넘으면 오른쪽 열이 잘린다`);
  const tableMin = Number(/\.pc-table \{ min-width: (\d+)px; \}/.exec(css)?.[1]);
  assert.ok(tableMin <= 790 && tableMin >= sum, `표 최소폭 ${tableMin}px`);
});

/* ── 반증 재검토(v2.927) ── */
test('N1 — 같은 이름의 점검 둘(TCP 22·443 이 둘 다 같은 기본 이름)은 testId 키로 갈라져 거짓 복구가 나가지 않는다', async () => {
  const sent = [];
  TR._resetTransitionsForTest({ send: async (a) => { sent.push(a); } });
  TR._setAlertSettingsForTest({ enabled: true, failCount: 1, recover: true });
  const { ingestReport } = await import('../src/central/svcmonEdge.js');
  const now = Date.now();
  const meta = [
    { i: 'A', p: 'P', n: 'srv1', h: 'h', t: 'TCP 포트 열림', y: 'tcp', iv: 60 },
    { i: 'B', p: 'P', n: 'srv1', h: 'h', t: 'TCP 포트 열림', y: 'tcp', iv: 60 },
  ];
  // 첫 push 는 결과 + 메타(중앙이 needMeta 로 요청한 회차). 이후 회차는 결과만 — 실제 흐름과 같다.
  ingestReport('edge-dup', { snapId: 1, rows: [{ i: 'A', s: 'bad', r: 'refused', m: null, k: 1, a: 0 }, { i: 'B', s: 'ok', r: '2ms', m: 2, k: 1, a: 0 }], meta }, now);
  for (let k = 2; k <= 5; k++) {
    ingestReport('edge-dup', { snapId: 1 + k, rows: [{ i: 'A', s: 'bad', r: 'refused', m: null, k, a: 0 }, { i: 'B', s: 'ok', r: '2ms', m: 2, k, a: 0 }] }, now + k * 60_000);
  }
  await TR.flushAlerts();
  assert.equal(sent.filter((a) => a.severity === 'critical').length, 1, '실패는 한 번');
  assert.equal(sent.filter((a) => a.severity === 'info').length, 0, '실패 중인 A 에 거짓 복구가 나가면 안 된다');
  assert.notEqual(TR.alertKeyOf({ scope: 'e', testId: 'A', target: { name: 'n', path: 'p' }, test: { name: 't', dupName: true } }),
    TR.alertKeyOf({ scope: 'e', testId: 'B', target: { name: 'n', path: 'p' }, test: { name: 't', dupName: true } }));
  // 구분자는 제어 문자 — 이름의 '|' 와 섞이지 않는다
  assert.notEqual(TR.alertKeyOf({ scope: 'e', target: { name: 'a|b', path: 'p' }, test: { name: 'c' } }), TR.alertKeyOf({ scope: 'e', target: { name: 'a', path: 'p' }, test: { name: 'b|c' } }));
});

test('N2 — 메타 없이 온 결과는 같은 요청에 메타가 함께 오면 바로 판정된다(다음 측정까지 기다리지 않는다)', async () => {
  const sent = [];
  TR._resetTransitionsForTest({ send: async (a) => { sent.push(a); } });
  TR._setAlertSettingsForTest({ enabled: true, failCount: 3 });
  const { ingestReport } = await import('../src/central/svcmonEdge.js');
  const now = Date.now();
  ingestReport('edge-late', { snapId: 10, rows: [{ i: 'X', s: 'bad', r: 'cert expired', m: null, k: 5, a: 0 }],
    meta: [{ i: 'X', p: 'P2', n: 'web1', h: 'h', t: '인증서 만료(443)', y: 'cert', iv: 86400 }] }, now);
  await TR.flushAlerts();
  assert.equal(sent.length, 1, '메타가 같은 요청에 왔으면 그 자리에서 판정');
  assert.match(sent[0].title, /web1 › 인증서 만료/);
  assert.equal(TR.alertStats().metaPending, 0);
  assert.equal(TR.hourlySeries(now).at(-1).n, 1, '재판정은 시간별 집계를 다시 세지 않는다');
});

test('N3 — 호스트 맵은 그룹 순서·이름 순서로 상한까지만 정렬하고 합계는 전체를 센다', () => {
  const targets = []; const results = new Map(); const now = Date.now();
  for (let i = 0; i < D.HEX_MAX + 300; i++) {
    targets.push({ id: `h${i}`, kind: 'infra', name: `n${String(i).padStart(5, '0')}`, host: 'x', path: i % 2 ? '나' : '가', enabled: true, tests: [{ id: `x${i}`, name: 'p', type: 'ping', intervalSec: 60 }] });
    results.set(`x${i}`, { status: 'ok', ts: now, streak: 1 });
  }
  const d = D.buildDash({ targets, results, edgeStates: [], now });
  assert.equal(d.hexTotal, D.HEX_MAX + 300);
  assert.equal(d.hexes.length, D.HEX_MAX);
  assert.equal(d.hexTruncated, true);
  assert.equal(d.hexes[0].group, '가', '그룹 순서(가 → 나)');
  assert.ok(d.hexes.slice(0, 10).every((h, i, a) => i === 0 || a[i - 1].name <= h.name), '그룹 안은 이름 순서');
  assert.deepEqual(d.groups.map((g) => [g.group, g.total]).sort(), [['가', (D.HEX_MAX + 300) / 2], ['나', (D.HEX_MAX + 300) / 2]]);
});

