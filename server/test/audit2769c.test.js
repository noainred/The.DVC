/**
 * v2.769(점검 R4 — G3 PDU·아이실론 사용량) 회귀 테스트.
 *  D4-01 PDU 전력·온습도 시계열은 장비 × 시간 조각 + 시간 기준 양보(결과는 예전 한 문장과 같다) · 라우트 조회 창 상한 = 화면 최대(30일) ·
 *        dbStats 는 집계 함수를 한 문장에 하나씩.
 *  D4-02 pdu-config 가 중앙 임계치를 싣고(파일이 있을 때만 · 손상이면 thresholdsUnreadable) 엣지 pull 이 정제해 적용한다 — 못 받으면 직전 값 유지.
 *        (중앙이 엣지 스냅샷을 평가하지 않는 것은 설계 — 엣지 현장 알림. 알림 채널 설정은 배포하지 않는다.)
 *  D4-03 isidu 대상 메일 '조사마다' + '변화 없으면 생략' 의 기준 = 마지막으로 실제 보낸 조사(없으면 비교 없이 보낸다).
 *  D4-04 isidu 추이는 최신부터 읽고, 점이 많으면 기간 전체에 고르게 솎고 그 사실을 밝힌다.
 *  D4-05 데모 계정(isAdminDetailUser 아님)에는 아이실론 데모(mock-) 대상만 — 실등록 대상의 주소·계정·경로·폴더 이름이 실리지 않는다.
 *  D4-06 연결 시험 성공이 저장 대상의 인증 정지를 푸는 것은 host·port·username·auth·deviceId 가 저장값과 같을 때만.
 * 기준 시각은 실제 시각을 정시 경계에서 30분 떨어뜨려 고정한다(docs/rules/common.md).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import ssh2 from 'ssh2';
import { stripComments } from './_stripComments.js';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2769c-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.AUTH_ENABLED = 'false';
process.env.CENTRAL_TOKEN = 'ctok-2769c';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
process.env.SSH_HOSTKEY_POLICY = 'observe';
process.env.ISIDU_SSH_KEY = '';
delete process.env.PDU_DB;
delete process.env.PDU_THRESHOLDS_LOCAL;
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'src');
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');

const H = 3_600_000; const DAY = 24 * H;
const NOW = Math.floor(Date.now() / H) * H - 30 * 60_000;

const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch { /* */ } } try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const quiet = async (fn) => {
  const w = console.warn; const l = console.log; const e = console.error;
  console.warn = () => {}; console.log = () => {}; console.error = () => {};
  try { return await fn(); } finally { console.warn = w; console.log = l; console.error = e; }
};

/* ═══════════════════════════ D4-01 PDU 시계열 ═══════════════════════════ */

const pdb = await import('../src/pdu/db.js');
const { DatabaseSync } = await import('node:sqlite');

/** 수정 전(v2.768) 한 문장 판본 — 같은 DB 파일을 다른 연결로 연다(WAL 이라 읽기는 겹쳐도 된다). */
function refPower(conn, ids, r) {
  const where = ids.length ? `AND device_id IN (${ids.map(() => '?').join(',')})` : '';
  return conn.prepare(`SELECT device_id, (ts/${r.bucketMs}) AS b, AVG(tot) AS avg_w, MAX(tot) AS max_w,
      SUM(CASE WHEN tot IS NULL THEN 1 ELSE 0 END) AS partial
     FROM (SELECT device_id, ts, CASE WHEN COUNT(power_w) = COUNT(*) THEN SUM(power_w) END AS tot
             FROM pdu_sample WHERE ts >= ? AND ts <= ? ${where} GROUP BY device_id, ts)
    GROUP BY device_id, b ORDER BY b ASC`).all(r.since, r.until, ...ids);
}
function refEnv(conn, ids, r) {
  const where = ids.length ? `AND device_id IN (${ids.map(() => '?').join(',')})` : '';
  return conn.prepare(`SELECT device_id || '#' || sensor AS device_id, (ts/${r.bucketMs}) AS b,
      AVG(temp_c) AS avg_w, MAX(temp_c) AS max_w, AVG(humidity_pct) AS avg_h
     FROM pdu_env WHERE ts >= ? AND ts <= ? ${where} GROUP BY device_id, sensor, b ORDER BY b ASC`).all(r.since, r.until, ...ids);
}
// 모든 칸이 null 인 행(그 버킷의 시각이 전부 부분 합)은 shape 가 '값 없음' 과 구분하지 않으므로 비교에서 뺀다 — 버킷 축은 따로 대조한다.
const cellsOf = (rows, cols) => new Map(rows.map((x) => [`${x.device_id}|${x.b}`, cols.map((c) => (x[c] == null ? null : Math.round(Number(x[c]) * 1000) / 1000))]).filter(([, v]) => v.some((y) => y != null)));
const seriesCells = (out, withHum = false) => {
  const m = new Map();
  for (const s of out.series) {
    out.bucketKeys.forEach((b, i) => {
      if (s.avg[i] == null && s.peak[i] == null && !(withHum && s.humidity?.[i] != null)) return;
      m.set(`${s.key}|${b}`, [s.avg[i], s.peak[i], ...(withHum ? [s.humidity?.[i] ?? null] : [])]);
    });
  }
  return m;
};

test('D4-01 조각 판본의 결과가 예전 한 문장과 같다(데이지체인 합산·부분 합 제외·partialSamples·센서별 온습도 · 장비 지정/전체 · 여러 버킷 폭)', async () => {
  pdb._resetForTest();
  const list = [];
  const step = 5 * 60_000;
  const n = Math.floor(3 * DAY / step);
  for (let i = 0; i < n; i++) {
    const ts = NOW - (n - i) * step + 7_000;   // 버킷 경계와 겹치지 않는 임의 위상
    list.push({ id: 'pa', collectedAt: ts, units: [{ index: 1, powerW: 1000 + (i % 7) }, { index: 2, powerW: i % 13 === 0 ? null : 500 }], sensors: [{ index: 1, tempC: 20 + (i % 5), humidityPct: 40 + (i % 3) }, { index: 2, tempC: 30, humidityPct: null }] });
    list.push({ id: 'pb', collectedAt: ts + 1_000, units: [{ index: 1, powerW: 2000 - (i % 11) }], sensors: [{ index: 1, tempC: 25, humidityPct: 50 }] });
    if (i % 4 === 0) list.push({ id: 'pc.x', collectedAt: ts + 2_000, units: [{ index: 1, powerW: 300 }], sensors: [] });
  }
  assert.ok(await pdb.recordSnapshots(list, { chunk: 1000 }) > 0);
  const conn = new DatabaseSync(path.join(DIR, 'pdu.db'));
  closers.push(() => conn.close());
  for (const [ids, opts] of [[[], { hours: 24, points: 150 }], [[], { hours: 72, points: 37 }], [['pa'], { hours: 72, points: 150 }], [['pb', 'pc.x'], { hours: 6, points: 120 }],
    [[], { from: NOW - 50 * H, to: NOW - 3 * H, points: 61 }]]) {
    const r = pdb.rangeOf(opts);
    const got = await pdb.powerSeries(ids, opts);
    const ref = refPower(conn, ids, r);
    assert.ok(ref.length > 0, '기준 결과가 비면 비교가 무의미하다');
    assert.deepEqual(seriesCells(got), new Map([...cellsOf(ref, ['avg_w', 'max_w'])].map(([k, v]) => [k, v.map((x) => (x == null ? null : Math.round(x * 10) / 10))])), `power ${JSON.stringify({ ids, opts })}`);
    assert.equal(got.partialSamples, ref.reduce((a, x) => a + Number(x.partial || 0), 0), 'partialSamples 가 같다');
    assert.deepEqual(got.buckets, [...new Set(ref.map((x) => Number(x.b)))].sort((a, b) => a - b).map((b) => b * r.bucketMs));
    const ge = await pdb.envSeries(ids, opts);
    const re = refEnv(conn, ids, r);
    const refCells = new Map([...cellsOf(re, ['avg_w', 'max_w', 'avg_h'])].map(([k, [a, m, h]]) => [k, [a == null ? null : Math.round(a * 10) / 10, m == null ? null : Math.round(m * 10) / 10, h == null ? null : Math.round(h)]]));
    assert.deepEqual(seriesCells(ge, true), refCells, `env ${JSON.stringify({ ids, opts })}`);
  }
  // 데이지체인 합산 확인(뜻이 바뀌지 않았다): pa 의 유닛 합 = 1000+x + 500, 유닛 2 를 못 읽은 시각은 빠지고 센다.
  const pa = await pdb.powerSeries(['pa'], { hours: 72, points: 150 });
  assert.ok(pa.series[0].avg.filter((v) => v != null).every((v) => v >= 1500 && v <= 1506), '유닛 합산');
  assert.ok(pa.partialSamples > 0, '부분 합 시각을 센다');
});

test('D4-01 큰 조회 동안 이벤트 루프가 돈다 — 최장 정지가 예전 한 문장 조회 시간의 절반 미만(비율 비교)', async () => {
  pdb._resetForTest();
  const conn = new DatabaseSync(path.join(DIR, 'pdu.db'));
  closers.push(() => conn.close());
  conn.exec('DELETE FROM pdu_sample; DELETE FROM pdu_env; DELETE FROM pdu_bank;');
  const D = 40; const DAYS = 10; const step = 5 * 60_000; const n = Math.floor(DAYS * DAY / step);
  let list = [];
  for (let i = 0; i < n; i++) {
    const ts = NOW - (n - i) * step;
    for (let d = 0; d < D; d++) list.push({ id: `p${d}`, collectedAt: ts, units: [{ index: 1, powerW: 1000 + d }], sensors: [] });
    if (list.length >= 20_000) { await pdb.recordSnapshots(list, { chunk: 5000 }); list = []; }
  }
  await pdb.recordSnapshots(list, { chunk: 5000 });
  const opts = { hours: 24 * DAYS, points: 150 };
  const r = pdb.rangeOf(opts);
  refPower(conn, [], r);                       // 캐시 데우기
  // 벽시계 정지는 다른 테스트 파일·GC·OS 선점에도 길어진다 — 3번씩 재고 기준은 중앙값, 새 판본은 가장 좋은 회차로 비교한다
  // (예전 한 문장 판본은 매번 조회 시간만큼 멈추므로 어느 회차도 기준의 절반 아래로 내려가지 못한다).
  const refs = [];
  for (let k = 0; k < 3; k++) { const t0 = performance.now(); refPower(conn, [], r); refs.push(performance.now() - t0); }
  const refMs = refs.sort((a, b) => a - b)[1];
  let maxGap = Infinity; let ticks = 0; let out = null;
  for (let k = 0; k < 3; k++) {
    let gap = 0; let cnt = 0; let run = true; let last = performance.now();
    const tick = () => { const x = performance.now(); gap = Math.max(gap, x - last); last = x; cnt++; if (run) setImmediate(tick); };
    setImmediate(tick);
    out = await pdb.powerSeries([], opts);
    run = false;
    if (gap < maxGap) { maxGap = gap; ticks = cnt; }
  }
  assert.equal(out.series.length, D);
  assert.ok(ticks >= 3, `조회 중 다른 작업이 돌아야 한다(틱 ${ticks}회)`);
  assert.ok(maxGap < refMs * 0.5, `최장 정지 ${maxGap.toFixed(1)}ms 가 한 문장 조회 ${refMs.toFixed(1)}ms 의 절반 미만이어야 한다`);
});

test('D4-01 조회 창 상한 — rangeOf maxHours 가 hours·from 을 모두 자르고, 라우트는 화면 최대 범위(30일)를 넘긴다', () => {
  const a = pdb.rangeOf({ hours: 9600, maxHours: 720 });
  assert.ok(Math.abs((a.until - a.since) - 720 * H) < 1000, '9600h 요청은 720h 로');
  const b = pdb.rangeOf({ from: Date.now() - 400 * DAY, maxHours: 720 });
  assert.ok(b.until - b.since <= 720 * H + 1000, 'from 으로 우회하지 못한다');
  const c = pdb.rangeOf({ hours: 9600 });
  assert.ok(c.until - c.since > 720 * H, '상한을 주지 않은 호출부는 예전처럼 보존기간까지');
  const route = stripComments(read('routes/api/pdu.js'));
  const cap = /const SERIES_MAX_HOURS = 24 \* (\d+);/.exec(route);
  assert.ok(cap, 'SERIES_MAX_HOURS 정의');
  assert.equal((route.match(/maxHours: SERIES_MAX_HOURS/g) || []).length, 2, 'power·env 두 라우트 모두');
  const web = fs.readFileSync(path.join(WEB, 'views/tools/PduCharts.jsx'), 'utf8');
  const ks = [...web.matchAll(/\{ k: ([\d *]+), label:/g)].map((m) => m[1].split('*').reduce((x, y) => x * Number(y.trim()), 1));
  assert.ok(ks.length >= 3, '웹 RANGES 를 읽었다');
  assert.equal(24 * Number(cap[1]), Math.max(...ks), '라우트 상한 = 화면의 가장 긴 범위');
});

test('D4-01 dbStats — 집계 함수는 한 문장에 하나씩(COUNT·MIN·MAX 단독)이고 값은 그대로', async () => {
  const src = stripComments(read('pdu/db.js'));
  const body = src.slice(src.indexOf('export async function dbStats'), src.indexOf('export function _resetForTest'));
  for (const m of body.matchAll(/`SELECT ([^`]*)`/g)) {
    const aggs = (m[1].match(/\b(COUNT|MIN|MAX|SUM|AVG)\s*\(/gi) || []).length;
    assert.ok(aggs <= 1, `한 문장에 집계 ${aggs}개: ${m[1]}`);
  }
  const st = await pdb.dbStats();
  assert.ok(st.sample.n > 0);
  assert.ok(st.sample.oldest <= st.sample.newest && st.sample.newest <= NOW + 1);
  assert.equal(typeof st.env.n, 'number');
});

/* ═══════════════════════════ D4-02 PDU 임계치 배포 ═══════════════════════════ */

const TH = await import('../src/pdu/thresholds.js');

test('D4-02 applyCentralThresholds — 알려진 키·유한수·불리언만, 객체가 아니면 직전 값 유지 · 실효 = 중앙 > 파일 > 기본', () => {
  TH._resetForTest();
  const thFile = path.join(DIR, 'pdu-thresholds.json');
  fs.writeFileSync(thFile, JSON.stringify({ tempWarnC: 26, bankWarnA: 10 }));
  assert.equal(TH.loadThresholds().tempWarnC, 26, '중앙 값을 받기 전에는 엣지 파일');
  assert.equal(TH.applyCentralThresholds({ tempWarnC: '29.5', powerWarnW: 4000, powerCritW: null, humLowPct: '', enabled: 'yes', bankWarnA: { $gt: 1 }, tempCritC: 1e12, evil: 1, __proto__: { polluted: 1 } }), true);
  const eff = TH.loadThresholds();
  assert.equal(eff.tempWarnC, 29.5, '문자열 수치는 수로');
  assert.equal(eff.powerWarnW, 4000);
  assert.equal(eff.powerCritW, null, 'null = 감시 안 함');
  assert.equal(eff.humLowPct, null, "'' = 감시 안 함");
  assert.equal(eff.enabled, true, '불리언이 아닌 enabled 는 버린다(파일 값)');
  assert.equal(eff.bankWarnA, 10, '객체 값은 버린다(파일 값)');
  assert.equal(eff.tempCritC, TH.DEFAULTS.tempCritC, '범위 밖 수치는 버린다');
  assert.ok(!('evil' in eff) && !('polluted' in eff), '모르는 키는 싣지 않는다');
  for (const bad of [null, [1, 2], 'x', 7]) assert.equal(TH.applyCentralThresholds(bad), false);
  assert.equal(TH.loadThresholds().tempWarnC, 29.5, '객체가 아니면 직전 중앙 값 유지');
  TH.saveThresholds({ humHighPct: 65 });
  assert.equal(JSON.parse(fs.readFileSync(thFile, 'utf8')).tempWarnC, 26, '엣지 저장이 중앙 값을 파일로 굳히지 않는다');
  process.env.PDU_THRESHOLDS_LOCAL = '1';
  try { assert.equal(TH.loadThresholds().tempWarnC, 26, '현장 고정이면 중앙 값 무시'); } finally { delete process.env.PDU_THRESHOLDS_LOCAL; }
  // 실효 임계치가 실제 판정에 쓰인다(엣지 폴러는 loadThresholds() 를 그대로 넘긴다).
  const v = TH.evaluateSnapshot({ id: 'p1', units: [{ index: 1, powerW: 4200, banks: [] }], sensors: [] }, TH.loadThresholds());
  assert.ok(v.some((x) => x.metric === 'power' && x.limit === 4000), '중앙 powerWarnW 가 엣지 판정에 쓰인다');
  fs.rmSync(thFile, { force: true });
  TH._resetForTest();
});

let centralBase;
let edgeTok;
async function startCentral() {
  if (centralBase) return;
  const express = (await import('express')).default;
  const { centralRouter } = await import('../src/routes/central.js');
  const app = express();
  app.use('/api/central', express.json({ limit: '16mb' }), centralRouter);
  const srv = http.createServer(app);
  closers.push(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }));
  centralBase = `http://127.0.0.1:${await listen(srv)}`;
  const { issueAgentToken } = await import('../src/central/agentTokens.js');
  edgeTok = issueAgentToken('edge-th').token;
}

test('D4-02 실제 centralRouter pdu-config — 중앙 파일이 있을 때만 thresholds, 손상이면 값 대신 thresholdsUnreadable · 실제 엣지 pull 이 적용·유지', async () => {
  await startCentral();
  const thFile = path.join(DIR, 'pdu-thresholds.json');
  fs.rmSync(thFile, { force: true });
  TH._resetForTest();
  const cget = async () => (await fetch(`${centralBase}/api/central/pdu-config?agent=edge-th&intervalsHold=1`, { headers: { 'X-Central-Token': edgeTok } })).json();
  const j0 = await cget();
  assert.equal(j0.ok, true, JSON.stringify(j0));
  assert.ok(!('thresholds' in j0), '한 번도 저장하지 않은 중앙은 기본값으로 엣지 파일을 덮지 않는다');
  TH.saveThresholds({ powerWarnW: 3500, tempWarnC: 28 });
  const j1 = await cget();
  assert.equal(j1.thresholds?.powerWarnW, 3500, `수정 전: pdu-config 는 intervals·devices 만 — ${JSON.stringify(j1)}`);
  assert.equal(j1.thresholds?.tempWarnC, 28);

  // 실제 엣지 pull(같은 프로세스 — 중앙 파일과 엣지 파일이 같아지지 않게 응답을 가로채 중앙 값만 바꿔 넘긴다).
  const { config } = await import('../src/config.js');
  const pull = await import('../src/agent/pduConfigPull.js');
  let reply = { ...j1, thresholds: { ...j1.thresholds, powerWarnW: 4100 } };
  const fake = http.createServer((q, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(q.url.startsWith('/api/central/pdu-config') ? reply : { ok: true })); });
  closers.push(() => new Promise((r) => fake.close(() => r())));
  const fport = await listen(fake);
  const keep = { u: config.agent.centralUrl, t: config.agent.centralToken, n: config.agent.name };
  Object.assign(config.agent, { centralUrl: `http://127.0.0.1:${fport}`, centralToken: 'x', name: 'edge-th' });
  try {
    const r1 = await quiet(() => pull.pullPduConfigNow());
    assert.equal(r1.ok, true, JSON.stringify(r1));
    assert.equal(r1.thresholdsApplied, true);
    assert.equal(TH.loadThresholds().powerWarnW, 4100, '엣지가 중앙 임계치를 적용한다');
    reply = { ok: true, devices: [], collectNow: [], intervals: {} };                     // 옛 중앙 — 필드 없음
    await quiet(() => pull.pullPduConfigNow());
    assert.equal(TH.loadThresholds().powerWarnW, 4100, '옛 중앙(필드 없음)이면 직전 값 유지');
    reply = { ok: true, devices: [], collectNow: [], intervals: {}, thresholdsUnreadable: { reason: '손상' }, thresholds: { powerWarnW: 1 } };
    const r3 = await quiet(() => pull.pullPduConfigNow());
    assert.equal(TH.loadThresholds().powerWarnW, 4100, '못 읽었다고 하면 직전 값 유지(같이 온 값도 쓰지 않는다)');
    assert.equal(r3.thresholdsUnreadable, '손상');
    reply = { ok: true, devices: [], collectNow: [], intervals: {}, thresholds: [1, 2] };
    await quiet(() => pull.pullPduConfigNow());
    assert.equal(TH.loadThresholds().powerWarnW, 4100, '객체가 아니면 직전 값 유지');
    await pull.pduCollectJobSettled();
  } finally { Object.assign(config.agent, { centralUrl: keep.u, centralToken: keep.t, name: keep.n }); TH._resetForTest(); }

  // 중앙 파일 손상 → 값 대신 사유(엣지는 직전 값 유지). 옛 엣지는 이 필드를 모르므로 503 으로 막지 않는다.
  fs.writeFileSync(thFile, '{ 손상');
  const j2 = await quiet(() => cget());
  assert.equal(j2.ok, true);
  assert.ok(!('thresholds' in j2), '손상이면 기본값을 싣지 않는다');
  assert.ok(j2.thresholdsUnreadable?.reason, JSON.stringify(j2));
  assert.ok(!/손상"|\{ 손상/.test(JSON.stringify(j2.thresholdsUnreadable)), '파일 원문 조각을 싣지 않는다');
  const j3 = await quiet(() => cget());
  assert.ok(j3.thresholdsUnreadable, '보존본만 남은 뒤에도 못 읽은 것');
  TH.saveThresholds({ powerWarnW: 3600 });
  assert.equal((await cget()).thresholds?.powerWarnW, 3600, '관리자가 저장하면 풀린다');
});

test('D4-02 중앙은 엣지 스냅샷을 평가하지 않는다(이중 발송 방지 — 엣지 현장 알림이 설계) · 알림 채널 설정은 pdu-config 에 없다', () => {
  const poller = stripComments(read('pdu/poller.js'));
  assert.ok(!/edgePduSnapshots/.test(poller), '중앙 폴러가 엣지 스냅샷을 평가하지 않는다');
  const central = stripComments(read('routes/central.js'));
  const seg = central.slice(central.indexOf("centralRouter.get('/pdu-config'"), central.indexOf("centralRouter.post('/pdu-data'"));
  assert.ok(seg.length > 100);
  assert.ok(!/loadAlertConfig|alerts\b/.test(seg), '알림 채널 설정을 배포하지 않는다');
});

/* ═══════════════════════════ D4-03 isidu 메일 '변화 없으면 생략' ═══════════════════════════ */

const idb = await import('../src/isidu/db.js');
const N = await import('../src/isidu/notify.js');
const { parseDuOutput } = await import('../src/isidu/parse.js');

function fakeSmtp() {
  const st = { mails: 0, reject: false };
  const srv = net.createServer((sock) => {
    let buf = ''; let inData = false; sock.write('220 x\r\n');
    sock.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const l = buf.slice(0, i); buf = buf.slice(i + 2);
        if (inData) { if (l === '.') { inData = false; if (st.reject) sock.write('554 rejected\r\n'); else { st.mails++; sock.write('250 ok\r\n'); } } continue; }
        const u = l.toUpperCase();
        if (u.startsWith('EHLO')) sock.write('250-x\r\n250 OK\r\n');
        else if (u === 'DATA') { inData = true; sock.write('354 go\r\n'); } else if (u === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); } else sock.write('250 ok\r\n');
      }
    });
    sock.on('error', () => {});
  });
  return { st, srv };
}
const w = (n, v) => fs.writeFileSync(path.join(DIR, n), JSON.stringify(v));

test('D4-03 조사마다 du -h 한 칸씩 자라는 폴더 — 마지막으로 보낸 조사와 비교하므로 두 칸 이상 자라면 다시 보낸다 · SMTP 실패 뒤 같은 결과도 보낸다', async () => {
  const { st, srv } = fakeSmtp();
  const port = await listen(srv);
  closers.push(() => new Promise((r) => srv.close(() => r())));
  w('mail.json', { enabled: true, smtp: { host: '127.0.0.1', port, startTls: false, user: '', password: '', from: 'p@corp.local', timeoutMs: 5000 }, defaultTo: [], kinds: {}, rateLimitPerHour: 0 });
  w('isidu-settings.json', { retentionDays: 400, timeoutDefaultMin: 120, mail: { commonTo: [] }, targets: [
    { id: 'tg-creep', label: 'creep', host: '10.0.0.5', username: 'admin', path: '/ifs/u', topN: 2, mail: { to: ['x@corp.local'], onlyOnChange: true } },
    { id: 'tg-smtp', label: 'smtp', host: '10.0.0.6', username: 'admin', path: '/ifs/v', topN: 2, mail: { to: ['y@corp.local'], onlyOnChange: true } },
  ] });
  N._resetForTest();
  const T0 = NOW - 20 * DAY;
  const put = async (id, root, k, gib, extraRoot) => {
    const stdout = `${gib}G\t${root}/alpha\n 20G\t${root}/beta\n${gib + extraRoot}G\t${root}\n`;
    const p = parseDuOutput(stdout, root, { mode: 'h' });
    const ts = T0 + k * DAY;
    const r = await idb.insertScan({ agent: '', node: '', targetId: id, ts, ok: true, path: root, host: 'h', sizeMode: 'h', durationMs: 1000, trig: 'schedule',
      total: p.total, sumBytes: p.entries.reduce((a, e) => a + e.bytes, 0), sumRes: p.entries.reduce((a, e) => a + e.res, 0), count: p.entries.length, entries: p.entries });
    return quiet(() => N.notifyScanStored({ targetId: id, scanId: r.id, ok: true, ts }));
  };
  const states = [];
  for (let k = 0; k <= 10; k++) states.push((await put('tg-creep', '/ifs/u', k, 73 + k, 20)).state);
  assert.equal(states[0], 'sent');
  const sent = states.filter((s) => s === 'sent').length;
  assert.ok(sent >= 5, `수정 전: 첫 1통 뒤 10번 모두 unchanged(+10G 인데 메일 1통) — ${states.join(',')}`);
  for (let i = 1; i < states.length; i++) assert.ok(!(states[i] === 'unchanged' && states[i - 1] === 'unchanged'), `두 번 연속 생략되면 기준이 직전 조사다 — ${states.join(',')}`);

  // SMTP 가 거절한 결과는 '보낸 조사' 가 아니다 — 다음 같은 결과는 비교하지 않고 보낸다.
  const mails0 = st.mails;
  st.reject = true;
  assert.equal((await put('tg-smtp', '/ifs/v', 0, 50, 20)).state, 'failed');
  st.reject = false;
  const again = await put('tg-smtp', '/ifs/v', 1, 50, 20);
  assert.equal(again.state, 'sent', `수정 전: 직전(실패한) 조사와 같아 unchanged — ${JSON.stringify(again)}`);
  assert.equal(st.mails, mails0 + 1);
  assert.equal((await put('tg-smtp', '/ifs/v', 2, 50, 20)).state, 'unchanged', '실제로 보낸 뒤 같은 결과는 생략');
});

/* ═══════════════════════════ D4-04 isidu 추이 ═══════════════════════════ */

const R = await import('../src/isidu/report.js');

test('D4-04 추이 365일 — 스캔이 5,000 을 넘어도 최신 점이 들어가고, 기간 전체에 고르게 솎은 사실을 밝힌다', async () => {
  const N1 = 5600;
  for (let i = N1 - 1; i >= 0; i--) {
    const ts = NOW - i * H;
    await idb.insertScan({ agent: '', node: '', targetId: 'tg-trend', ts, ok: true, path: '/ifs/t', host: 'h', sizeMode: 'k', durationMs: 1, trig: 'schedule',
      total: { bytes: 1000 + (N1 - i), res: 1024 }, sumBytes: 1000 + (N1 - i), sumRes: 1024, count: 0, entries: [] });
  }
  const t = await R.trend('tg-trend', { days: 365 });
  assert.equal(t.state, 'ok');
  const last = t.points[t.points.length - 1];
  assert.equal(last.ts, NOW, `수정 전: 가장 오래된 5,000건만 와 마지막 점이 ${((NOW - last.ts) / DAY).toFixed(1)}일 전`);
  assert.equal(last.bytes, 1000 + N1);
  assert.equal(t.points[0].ts, NOW - (N1 - 1) * H, '첫 점은 기간 안 가장 오래된 스캔(고르게 솎기 — 최근만 남기지 않는다)');
  assert.ok(t.points.length <= R.TREND_POINTS_MAX);
  assert.deepEqual(t.thinned, { total: N1, shown: t.points.length }, '솎은 사실을 밝힌다');
  assert.ok(!t.truncated);
  for (let i = 1; i < t.points.length; i++) assert.ok(t.points[i].ts > t.points[i - 1].ts, '시각 오름차순');
  // 읽기 상한을 넘으면 가장 오래된 쪽을 자르고 표지(scansInLatest 단위).
  const g = await idb.scansInLatest('', 'tg-trend', NOW - 400 * DAY, 100);
  assert.equal(g.truncated, true);
  assert.equal(g.scans.length, 100);
  assert.equal(g.scans[99].ts, NOW, '최신부터 읽는다');
  assert.ok(g.scans[0].ts < g.scans[99].ts, '돌려줄 때는 오름차순');
  const small = await R.trend('tg-trend', { days: 7 });
  assert.equal(small.points.length, 7 * 24 + 1);
  assert.ok(!small.thinned && !small.truncated, '적으면 표지 없음');
});

/* ═══════════════════════════ D4-05·D4-06 화면 API ═══════════════════════════ */

async function call(user, method, url, body) {
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use('/api', api);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(500).json({ error: String(err?.message || err) }));
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/api${url}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const text = Buffer.from(await res.arrayBuffer()).toString('utf8');
    let json = null; try { json = JSON.parse(text); } catch { /* */ }
    return { status: res.status, body: json, text };
  } finally { srv.close(); }
}
const ADMIN = { username: 'root', role: 'admin', superAdmin: true, scope: {} };
const DEMO = { username: 'thedvcdemp', role: 'admin', demoGuest: true, scope: {} };

test('D4-05 데모 계정 — 메인 목록·개요는 데모(mock-) 대상만, 실등록 대상의 보고서·사용자·추이·CSV 는 404 · 관리자는 그대로', async () => {
  w('isidu-settings.json', { retentionDays: 400, timeoutDefaultMin: 120, mail: { commonTo: [] }, targets: [
    { id: 'tg-real', label: 'real-corp', host: '10.77.1.9', username: 'isiadmin77', path: '/ifs/data/realcorp/users', topN: 5 },
    { id: 'mock-isi-1', label: '데모 아이실론', host: '192.0.2.10', username: 'demo', path: '/ifs/demo/users', topN: 5 },
  ] });
  const ent = (name, gib) => ({ name, bytes: gib * 1024 ** 3, res: 1024 ** 3 });
  for (const [id, names] of [['tg-real', ['kim.realuser', 'lee.realuser']], ['mock-isi-1', ['demo.user']]]) {
    const entries = names.map((n, i) => ent(n, 10 + i));
    await idb.insertScan({ agent: '', node: '', targetId: id, ts: NOW, ok: true, path: '/ifs/x', host: 'h', sizeMode: 'h', durationMs: 1, trig: 'schedule',
      total: { bytes: 99 * 1024 ** 3, res: 1024 ** 3 }, sumBytes: entries.reduce((a, e) => a + e.bytes, 0), sumRes: 1024 ** 3, count: entries.length, entries });
  }
  const SECRETS = ['10.77.1.9', 'isiadmin77', '/ifs/data/realcorp', 'kim.realuser', 'tg-real'];
  const main = await call(DEMO, 'GET', '/tools/isilon-dirusage');
  assert.equal(main.status, 200, main.text);
  assert.deepEqual(main.body.targets.map((x) => x.id), ['mock-isi-1']);
  for (const s of SECRETS) assert.ok(!main.text.includes(s), `수정 전: 데모 계정 메인 목록에 실등록 대상 '${s}'`);
  assert.equal(main.body.demoMasked?.targets, 1, '가린 수를 밝힌다');
  const ov = await call(DEMO, 'GET', '/tools/isilon-dirusage/overview');
  assert.equal(ov.status, 200);
  for (const s of SECRETS) assert.ok(!ov.text.includes(s), `개요에 '${s}'`);
  for (const p of ['report', 'users', 'trend', 'export.csv']) {
    const r = await call(DEMO, 'GET', `/tools/isilon-dirusage/${p}?target=tg-real`);
    assert.equal(r.status, 404, `수정 전: 데모 계정 ${p} 가 실등록 대상을 준다 — ${r.status}`);
    for (const s of SECRETS.slice(0, 4)) assert.ok(!r.text.includes(s), `${p} 404 응답에 '${s}'`);
  }
  assert.equal((await call(DEMO, 'GET', '/tools/isilon-dirusage/report?target=mock-isi-1')).status, 200, '데모 대상은 그대로 본다');
  assert.equal((await call(DEMO, 'GET', '/tools/isilon-dirusage/users?target=mock-isi-1')).status, 200);
  // 관리자 판본은 그대로
  const am = await call(ADMIN, 'GET', '/tools/isilon-dirusage');
  assert.deepEqual(am.body.targets.map((x) => x.id).sort(), ['mock-isi-1', 'tg-real']);
  assert.ok(am.text.includes('10.77.1.9') && !('demoMasked' in am.body));
  const ar = await call(ADMIN, 'GET', '/tools/isilon-dirusage/users?target=tg-real');
  assert.equal(ar.status, 200);
  assert.ok(ar.text.includes('kim.realuser'));
});

test('D4-05 maskIsiduMainForDemo — 엣지(공개키·이름)·폴러 진행·버린 요청은 데모 것만, 폴러 기록 줄·마지막 오류는 싣지 않는다', async () => {
  const { maskIsiduMainForDemo } = await import('../src/isidu/demoMask.js');
  const body = {
    targets: [{ id: 'tg-real', host: '10.0.0.1' }, { id: 'mock-a' }],
    edges: [{ agent: 'seoul-edge', key: { publicKey: 'ecdsa AAA' } }, { agent: 'demo-edge-1' }],
    drops: [{ id: 'tg-real', agent: 'seoul-edge' }, { id: 'mock-a', agent: 'demo-edge-1' }],
    poller: { running: [{ targetId: 'tg-real' }, { targetId: 'mock-a' }], queued: [{ targetId: 'tg-real' }], interrupted: [], resumes: [{ targetId: 'tg-real' }], recent: [{ msg: 'tg-real 10.0.0.1 실패' }], lastError: { message: '10.0.0.1 접속 실패' } },
  };
  const out = maskIsiduMainForDemo(body, { isDemoAgent: (n) => n === 'demo-edge-1' });
  assert.deepEqual(out.targets.map((x) => x.id), ['mock-a']);
  assert.deepEqual(out.edges.map((x) => x.agent), ['demo-edge-1']);
  assert.deepEqual(out.drops.map((x) => x.id), ['mock-a']);
  assert.deepEqual(out.poller.running.map((x) => x.targetId), ['mock-a']);
  assert.deepEqual(out.poller.queued, []);
  assert.deepEqual(out.poller.recent, []);
  assert.equal(out.poller.lastError, null);
  assert.ok(!JSON.stringify(out).includes('10.0.0.1') && !JSON.stringify(out).includes('seoul-edge'));
  assert.equal(body.targets.length, 2, '원본을 바꾸지 않는다');
});

/* D4-06 — 가짜 아이실론 SSH(공개키 인증 · ls -d 성공) 두 대: 저장된 대상(A)과 편집 중 다른 포트(B). */
function hostKey() { return crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'sec1', format: 'pem' }); }
async function fakeIsilon(allowedPub) {
  const st = { commands: [] };
  const srv = new ssh2.Server({ hostKeys: [hostKey()] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method !== 'publickey') return ctx.reject(['publickey']);
      const pk = ssh2.utils.parseKey(allowedPub);
      if (ctx.key.algo !== pk.type || !ctx.key.data.equals(pk.getPublicSSH())) return ctx.reject(['publickey']);
      if (ctx.signature && !pk.verify(ctx.blob, ctx.signature, ctx.hashAlgo)) return ctx.reject(['publickey']);
      return ctx.accept();
    });
    client.on('ready', () => client.on('session', (accept) => {
      const s = accept();
      s.on('exec', (acc, _rej, info) => { st.commands.push(info.command); const x = acc(); x.write('/ifs/s/users\n'); x.exit(0); x.end(); });
    }));
    client.on('error', () => {});
  });
  const port = await listen(srv);
  closers.push(() => new Promise((r) => srv.close(() => r())));
  return { port, st };
}

test('D4-06 연결 시험 — 편집 중인 다른 포트로 성공해도 저장 대상의 인증 정지를 풀지 않고, 저장값과 같을 때만 푼다', async () => {
  const K = await import('../src/isidu/sshKey.js');
  K.ensureKey();
  const pub = K.publicKeyView().publicKey;
  const A = await fakeIsilon(pub);
  const B = await fakeIsilon(pub);
  w('isidu-settings.json', { retentionDays: 400, timeoutDefaultMin: 120, mail: { commonTo: [] }, targets: [
    { id: 'tg-stop', label: 'stopped', host: '127.0.0.1', port: A.port, username: 'admin', path: '/ifs/s/users', topN: 5 },
  ] });
  const C = await import('../src/isidu/collect.js');
  const S = await import('../src/isidu/settings.js');
  const saved = S.loadSettings().targets.find((x) => x.id === 'tg-stop');
  assert.ok(saved, '설정에 대상이 있다');
  C.authGuard.markAuthStopped('tg-stop', { id: 'tg-stop', username: 'admin', password: K.keyInfo().fingerprint || '' }, '인증 거부');
  assert.ok(await C.authStopOf(saved), '정지 상태로 시작');

  const other = await quiet(() => call(ADMIN, 'POST', '/tools/isilon-dirusage/test', { ...saved, port: B.port }));
  assert.equal(other.status, 200, other.text);
  assert.equal(other.body.ok, true, other.text);
  assert.ok(B.st.commands.length >= 1, '편집값(B)으로 접속했다');
  assert.ok(await C.authStopOf(saved), `수정 전: 다른 포트로 시험이 성공하자 저장 대상의 인증 정지가 풀렸다`);
  const otherUser = await quiet(() => call(ADMIN, 'POST', '/tools/isilon-dirusage/test', { ...saved, username: 'admin2' }));
  assert.equal(otherUser.status, 200, otherUser.text);
  assert.ok(await C.authStopOf(saved), '다른 계정 시험도 풀지 않는다');

  const same = await quiet(() => call(ADMIN, 'POST', '/tools/isilon-dirusage/test', { ...saved }));
  assert.equal(same.body.ok, true, same.text);
  assert.ok(A.st.commands.length >= 1);
  assert.equal(await C.authStopOf(saved), null, '저장값과 같은 시험이 성공하면 푼다(v2.590 규약 유지)');

  // 순수 판정 — 정규화한 다섯 칸
  assert.equal(C.sameConnIdentity({ host: 'ISI.corp', port: '22', username: 'a', auth: 'key' }, { host: 'isi.corp ', port: 22, username: 'a' }), true);
  for (const d of [{ host: 'x' }, { port: 2222 }, { username: 'b' }, { auth: 'device' }, { deviceId: 'd1' }]) {
    assert.equal(C.sameConnIdentity({ host: 'isi', port: 22, username: 'a', auth: 'key', ...d }, { host: 'isi', port: 22, username: 'a', auth: 'key' }), false, JSON.stringify(d));
  }
  assert.equal(C.sameConnIdentity(null, { host: 'a' }), false);
  // 엣지 isidu-test 도 같은 판정을 쓴다.
  assert.match(stripComments(read('isidu/edgeOps.js')), /clearStopId: saved && sameConnIdentity\(t, saved\) \? t\.id : ''/);
});
