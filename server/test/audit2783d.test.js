/**
 * v2.783 점검 Q4(축 P — INSIGHTS) 수정 회귀 고정.
 *
 *  - P-B1  인시던트 '발생' 이 알림 **발송 기록**(쿨다운 재발송·재시도마다 1건)을 세어 지속 장애 하나가 24h 에 24번 '발생' 했다.
 *          발생은 'key 의 직전 사건이 해소이거나 없을 때의 fired' 만이고, 나머지는 kind 'notify'(재발송 — 집계 제외)다.
 *          channelsOn 은 teams·email 도 본다(alerts.js 발송 판정과 같은 네 채널).
 *  - P-B2  보안 자세: 버전·빌드·수명 데이터를 모르는 vCenter/호스트를 '정상' 으로 셌다 → worst 'unknown'·summary.unknown(정상 밖).
 *          버전 없는 호스트도 버리지 않고 미확인으로 센다. 내장 데이터셋 무결성(maxAffectedBuild < fixedBuild).
 *  - P-I1  이상 탐지: 계열 예외를 삼켜 0건(초록)이었다 → 계열별 evaluated·insufficient·error.
 *  - P-I2  /tools/report/capacity: 캐시 키가 originalUrl 이라 `&_=` 로 매번 재계산, runHeavyExclusive 미경유 → 정규화 인자 키 + 직렬.
 *
 * 기준 시각은 실제 시각을 정시 경계로 떨어뜨려 고정한다(docs/rules/common.md).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'a2783d-'));
process.env.CONFIG_DIR = DIR;
process.env.DB_DIR = DIR;
process.env.AUTH_ENABLED = 'false';

const HOUR = 3_600_000;
const MIN = 60_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * MIN;   // 정시 −30분 고정
const iso = (t) => new Date(t).toISOString();

const { buildIncidents } = await import('../src/insights/incidents.js');

after(() => { fs.rmSync(DIR, { recursive: true, force: true }); });

/* ── P-B1 ─────────────────────────────────────────────────────────── */
test('P-B1 ① 쿨다운 재발송 24건(해소 없음)은 발생 1회 — 나머지는 재발송(notify)으로 타임라인에만', () => {
  // recent 는 최신이 앞(alerts.js pushRecent unshift). 24시간 동안 60분마다 재발송.
  const recent = [];
  for (let i = 0; i < 24; i++) recent.push({ at: iso(NOW - i * HOUR), key: 'ds:vc1:ds-1', vcenterId: 'vc1', severity: 'warning', title: '데이터스토어 90%' });
  const r = buildIncidents({ firing: [], recent, config: { channels: { slack: { enabled: true } } } }, { vcenters: [] }, { now: NOW });
  assert.equal(r.summary.recent24h, 1, '지속 장애 하나는 발생 1회');
  const kinds = r.timeline.filter((e) => e.key === 'ds:vc1:ds-1').map((e) => e.kind);
  assert.equal(kinds.filter((k) => k === 'fired').length, 1);
  assert.equal(kinds.filter((k) => k === 'notify').length, 23, '재발송은 지우지 않고 notify 로 남긴다');
  const fired = r.timeline.find((e) => e.kind === 'fired');
  assert.equal(fired.ts, NOW - 23 * HOUR, '가장 오래된 기록이 발생');
  const total = r.byDay.reduce((s, d) => s + d.warning + d.critical, 0);
  assert.equal(total, 1, '일자별 추세도 1');
});

test('P-B1 ② 발생→해소→재발은 2회, 재시도(같은 장애 안의 추가 발송)는 세지 않는다', () => {
  const recent = [
    { at: iso(NOW - 5 * MIN), key: 'k', vcenterId: 'vc1', severity: 'critical', title: 'x' },      // 재발의 재시도
    { at: iso(NOW - 10 * MIN), key: 'k', vcenterId: 'vc1', severity: 'critical', title: 'x' },     // 재발
    { at: iso(NOW - 20 * MIN), key: 'k', vcenterId: 'vc1', severity: 'resolved', title: '해소: x' },
    { at: iso(NOW - 25 * MIN), key: 'k', vcenterId: 'vc1', severity: 'critical', title: 'x' },     // 첫 발생의 재시도(15분 뒤)
    { at: iso(NOW - 40 * MIN), key: 'k', vcenterId: 'vc1', severity: 'critical', title: 'x' },     // 첫 발생
  ];
  const r = buildIncidents({ firing: [], recent, config: { channels: {} } }, { vcenters: [] }, { now: NOW });
  assert.equal(r.summary.recent24h, 2);
  const firedTs = r.timeline.filter((e) => e.kind === 'fired').map((e) => e.ts);
  assert.deepEqual(firedTs, [NOW - 10 * MIN, NOW - 40 * MIN]);
  assert.equal(r.timeline.filter((e) => e.kind === 'notify').length, 2);
  assert.equal(r.timeline.filter((e) => e.kind === 'resolved').length, 1);
});

test('P-B1 ③ 같은 ts 면 recent 의 앞(최신)이 나중 사건이다 — 해소가 앞이면 다음 fired 는 없으므로 발생 1', () => {
  const same = iso(NOW - 20 * MIN);
  const recent = [
    { at: same, key: 'k', vcenterId: 'vc1', severity: 'resolved', title: '해소' },
    { at: same, key: 'k', vcenterId: 'vc1', severity: 'critical', title: 'x' },
  ];
  const r = buildIncidents({ firing: [], recent, config: { channels: {} } }, { vcenters: [] }, { now: NOW });
  assert.equal(r.summary.recent24h, 1);
  assert.equal(r.timeline.filter((e) => e.kind === 'notify').length, 0);
});

test('P-B1 ④ vc:<id> 합성 생략 — 가장 최근 사건이 재발송(notify)이어도 진행 중이므로 합성하지 않는다', () => {
  const snap = { vcenters: [{ id: 'vc1', name: 'vc1', status: 'unreachable', staleSince: NOW - 3 * HOUR }] };
  const recent = [
    { at: iso(NOW - HOUR), key: 'vc:vc1', vcenterId: 'vc1', severity: 'critical', title: 'vCenter 수집 실패: vc1' },
    { at: iso(NOW - 2 * HOUR), key: 'vc:vc1', vcenterId: 'vc1', severity: 'critical', title: 'vCenter 수집 실패: vc1' },
  ];
  const r = buildIncidents({ firing: [], recent, config: { channels: {} } }, snap, { now: NOW });
  assert.equal(r.timeline.filter((e) => e.key === 'vc:vc1' && e.kind === 'fired').length, 1, '한 장애는 한 번');
  assert.equal(r.summary.recent24h, 1);
});

test('P-B1 ⑤ channelsOn 은 teams·email 도 본다(alerts.js 발송 판정과 같은 네 채널)', () => {
  const on = (channels) => buildIncidents({ firing: [], recent: [], config: { channels } }, { vcenters: [] }, { now: NOW }).summary.channelsOn;
  assert.equal(on({ teams: { enabled: true } }), true);
  assert.equal(on({ email: { enabled: true } }), true);
  assert.equal(on({ slack: { enabled: true } }), true);
  assert.equal(on({ webhook: { enabled: true } }), true);
  assert.equal(on({ slack: { enabled: false }, teams: {} }), false);
  assert.equal(on(undefined), false);
});

/* ── P-B2 ─────────────────────────────────────────────────────────── */
const CVE = await import('../src/insights/cve.js');

test('P-B2 ① 버전·빌드·수명 데이터를 모르면 정상이 아니라 미확인 — summary.unknown 은 정상과 따로', () => {
  const snap = {
    vcenters: [
      { id: 'vc-rest', name: 'REST 폴백', version: 'unknown' },             // restClient.js 폴백
      { id: 'vc-none', name: '버전 없음' },
      { id: 'vc-ok', name: '최신', version: '8.0.3', build: '24322831' },
    ],
    hosts: [
      { id: 'h-nobuild', name: 'esx-nobuild', vcenterId: 'vc-ok', version: '8.0.1', build: '' },
      { id: 'h-60', name: 'esx-60', vcenterId: 'vc-ok', version: '6.0.0', build: '3620759' },
      { id: 'h-nover', name: 'esx-nover', vcenterId: 'vc-ok' },
      { id: 'h-crit', name: 'esx-old', vcenterId: 'vc-ok', version: '8.0.1', build: '1' },
      { id: 'h-ok', name: 'esx-new', vcenterId: 'vc-ok', version: '8.0.3', build: '24414501' },
      { id: 'h-0', name: 'esx-zero', vcenterId: 'vc-ok', version: '8.0.3', build: 0 },
    ],
  };
  const r = CVE.computeSecurityPosture(snap);
  const w = (id) => [...r.hosts, ...r.vcenters].find((x) => x.id === id)?.worst;
  assert.equal(w('vc-rest'), 'unknown', "REST 폴백 'unknown' 은 정상이 아니다");
  assert.equal(w('vc-none'), 'unknown', '버전 없는 vCenter 도 버리지 않고 미확인');
  assert.equal(w('vc-ok'), 'ok');
  assert.equal(w('h-nobuild'), 'unknown', '빌드를 못 읽으면 권고 대조를 못 했다');
  assert.equal(w('h-60'), 'unknown', '데이터셋 밖 라인');
  assert.equal(w('h-nover'), 'unknown', '버전 없는 호스트를 조용히 버리지 않는다');
  assert.equal(w('h-crit'), 'critical');
  assert.equal(w('h-ok'), 'ok');
  assert.equal(w('h-0'), 'unknown', '빌드 0 은 못 읽은 값');
  const s = r.summary;
  assert.equal(s.total, 9);
  assert.equal(s.unknown, 6);
  assert.equal(s.ok, 2);
  assert.equal(s.critical, 1);
  assert.equal(s.critical + s.warning + s.ok + s.unknown, s.total, '네 칸의 합 = 전체');
  for (const x of [...r.hosts, ...r.vcenters]) if (x.worst === 'unknown') assert.ok(x.unknownReason, `${x.id} 미확인 사유`);
});

test('P-B2 ② 수명 데이터로 EOL 이 확정이면 빌드를 몰라도 위험(EOL 은 아는 사실)', () => {
  const r = CVE.computeSecurityPosture({ hosts: [{ id: 'h65', name: 'esx65', version: '6.5.0', build: '' }], vcenters: [] });
  assert.equal(r.hosts[0].worst, 'critical');
  assert.equal(r.hosts[0].eol, true);
});

test('P-B2 ③ 정렬 — 위험 > 주의 > 미확인 > 정상', () => {
  const r = CVE.computeSecurityPosture({ vcenters: [], hosts: [
    { id: 'a', version: '8.0.3', build: '24414501' },
    { id: 'b', version: 'unknown' },
    { id: 'c', version: '8.0.1', build: '1' },
  ] });
  assert.deepEqual(r.hosts.map((h) => h.worst), ['critical', 'unknown', 'ok']);
});

// VMSA-2023-0023 원문 확인 필요 — 이 행은 maxAffectedBuild == fixedBuild(22380479)다. 기억으로 데이터를 고치지 않는다.
//   원문으로 고친 뒤에는 이 목록에서 지울 것(아래 단정이 '아직 같다' 를 확인하므로 고치면 이 테스트가 그 사실을 알린다).
const KNOWN_DATA_GAPS = new Set(['VMSA-2023-0023|esxi|8.0']);
test('P-B2 ④ 내장 데이터셋 무결성 — 모든 권고 행은 maxAffectedBuild < fixedBuild (확인 필요 행은 명시 예외)', () => {
  const { advisories, lifecycle } = CVE.cveDataset();
  assert.ok(advisories.length > 0 && lifecycle.length > 0);
  for (const a of advisories) {
    const id = `${a.id}|${a.product}|${a.line}`;
    assert.ok(Number.isInteger(a.maxAffectedBuild) && Number.isInteger(a.fixedBuild), id);
    if (KNOWN_DATA_GAPS.has(id)) {
      assert.equal(a.maxAffectedBuild, a.fixedBuild, `${id}: 예외 사유가 없어졌다 — KNOWN_DATA_GAPS 에서 지울 것`);
      continue;
    }
    assert.ok(a.maxAffectedBuild < a.fixedBuild, `${id}: maxAffectedBuild(${a.maxAffectedBuild}) < fixedBuild(${a.fixedBuild})`);
    assert.ok(lifecycle.some((l) => l.product === a.product && l.line === a.line), `${id}: 수명 데이터에 라인이 있어야 한다`);
  }
  for (const l of lifecycle) assert.ok(Number.isFinite(Date.parse(l.eogs)), `${l.product} ${l.line} eogs`);
});

/* ── P-I1 ─────────────────────────────────────────────────────────── */
test('P-I1 이상 탐지 — 계열별 evaluated·insufficient·error(빈 DB 는 0건이 아니라 평가 0)', async () => {
  const { getMetricsDb } = await import('../src/metrics/db.js');
  const { detectAnomalies } = await import('../src/insights/anomaly.js');
  const db = await getMetricsDb();
  const empty = await detectAnomalies({});
  for (const f of empty.families) {
    assert.equal(f.evaluated, 0, `${f.metric} evaluated`);
    assert.equal(f.insufficient, 0);
    assert.equal(f.error, null);
  }
  assert.equal(empty.evaluated, 0);
  // 표본 12개 미만 키 1 + 충분한 키 1
  const now = Date.now();
  for (let i = 3; i >= 1; i--) db.insertMany([{ metric: 'temp_host', k: 'h-few', v: 20 }], now - i * 10 * MIN);
  for (let i = 13; i >= 1; i--) db.insertMany([{ metric: 'temp_host', k: 'h-many', v: 20 + (i % 3) }], now - i * 10 * MIN);
  db.insertMany([{ metric: 'temp_host', k: 'h-many', v: 21 }], now - 30_000);
  const r = await detectAnomalies({});
  const t = r.families.find((f) => f.metric === 'temp_host');
  assert.equal(t.insufficient, 1, '표본 부족 1');
  assert.equal(t.evaluated, 1, '평가 1');
  assert.equal(t.count, 0);
  // 계열 조회 실패는 삼키지 않는다 — error 사유
  const orig = db.latestAll;
  db.latestAll = (m) => { if (m === 'gpu_util') throw new Error('boom'); return orig.call(db, m); };
  try {
    const e = await detectAnomalies({});
    const g = e.families.find((f) => f.metric === 'gpu_util');
    assert.equal(g.count, 0);
    assert.equal(g.evaluated, 0);
    assert.equal(g.error, '조회 실패', '계열 실패는 사유를 싣는다(원문은 싣지 않는다)');
    assert.ok(!JSON.stringify(e).includes('boom'), '오류 원문은 응답에 없다');
    assert.equal(e.errors, 1);
  } finally { db.latestAll = orig; }
});

/* ── P-I2 ─────────────────────────────────────────────────────────── */
const ADMIN = { username: 'adm', role: 'admin', scope: {} };
async function withServer(router, fn) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = ADMIN; next(); });
  app.use('/api', router);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try { return await fn(`http://127.0.0.1:${srv.address().port}/api`); } finally { srv.close(); }
}

test('P-I2 /tools/report/capacity — runHeavyExclusive 로 직렬, 캐시 키는 정규화 인자(의미 없는 쿼리로 재계산하지 않는다)', async () => {
  const { api } = await import('../src/routes/api.js');
  const { runHeavyExclusive } = await import('../src/routes/insights.js');
  await withServer(api, async (base) => {
    // ① 무거운 계산이 진행 중이면 뒤에 붙는다
    let release;
    const gate = new Promise((r) => { release = r; });
    const blocker = runHeavyExclusive(() => gate);
    let done = false;
    const p = fetch(`${base}/tools/report/capacity?days=14`).then(async (res) => { done = true; return { status: res.status, body: await res.json() }; });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(done, false, '진행 중인 무거운 계산 뒤에 줄을 선다');
    release();
    await blocker;
    const first = await p;
    assert.equal(first.status, 200, JSON.stringify(first.body).slice(0, 200));
    assert.equal(first.body.config?.days, 14);
    // ② 같은 정규화 인자 + 캐시 우회 쿼리 → 대기열이 막혀 있어도 즉시 캐시 응답
    let release2;
    const gate2 = new Promise((r) => { release2 = r; });
    const blocker2 = runHeavyExclusive(() => gate2);
    try {
      const res = await Promise.race([
        fetch(`${base}/tools/report/capacity?days=14.0001&_=${Math.random()}`).then((x) => x.json()),
        new Promise((r) => setTimeout(() => r('timeout'), 2000)),
      ]);
      assert.notEqual(res, 'timeout', '캐시 우회 쿼리가 재계산(대기열)으로 가면 안 된다');
      assert.equal(res.generatedAt, first.body.generatedAt, '같은 계산 결과');
    } finally { release2(); await blocker2; }
  });
});
