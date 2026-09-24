/**
 * audit2607f.test.js — v2.607 수정 그룹 f(DB 조회) 회귀.
 *
 *  DB2607-01 법인 전산실 온도 '수집 시작' 은 그 법인 키의 첫 관측이다(meta(metric) 는 k 조건이 없어 계열 전체).
 *  DB2607-02 vCenter 로그 필터 조회의 total 은 상한 COUNT(countCapped) + totalCapped 로 밝힌다.
 *  DB2607-03 검색어의 '_'·'%' 는 글자 그대로다(ESCAPE) — 인메모리 폴백(includes)과 같은 뜻.
 *  DB2607-04 파트 장애 전이 이력 limit 은 정수화(pageArgs + recentEvents 안 trunc), 실패 사유는 응답에.
 *
 * 기준 시각은 정시 -30분(CLAUDE.md v2.517 규약).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2607f-'));
process.env.CONFIG_DIR = tmp;
process.env.TEMP_DB_PATH = path.join(tmp, 'metrics.db');
process.env.PARTFAULT_DB_PATH = path.join(tmp, 'pf.db');

const HOUR = 3_600_000; const DAY = 24 * HOUR; const MIN = 60_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * MIN;
const src = (rel) => stripComments(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', rel), 'utf8'));

let mdb; let ldb; let pf; let roomTempHistory;
before(async () => {
  ({ roomTempHistory } = await import('../src/idrac/roomTempSeries.js'));
  const { getMetricsDb } = await import('../src/metrics/db.js');
  mdb = await getMetricsDb();
  const { getLogsDb } = await import('../src/logs/db.js');
  ldb = await getLogsDb();
  pf = await import('../src/partfault/db.js');
});
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

test('DB2607-01: 법인 B 의 수집 시작은 B 의 첫 관측이다(다른 법인 A 의 30일 전이 아니다)', async () => {
  // A: 30일 전부터, B: 2일 전부터(1시간 간격 — 값이 달라 dead-band 에 걸리지 않게). 롤업의 시간 버킷 바닥 때문에 최대 30분 이르게 나올 수 있다
  for (let t = NOW - 30 * DAY; t <= NOW; t += HOUR) {
    const rows = [{ metric: 'roomtemp_inlet_avg', k: 'A2607', v: 20 + ((t / HOUR) % 7) }];
    if (t >= NOW - 2 * DAY) rows.push({ metric: 'roomtemp_inlet_avg', k: 'B2607', v: 22 + ((t / HOUR) % 5) });
    mdb.insertMany(rows, t);
  }
  const r = await roomTempHistory(mdb, { kind: 'inlet', group: 'B2607', range: '30d' });
  assert.ok(r.collectedSince != null, '수집 시작이 비면 안 된다');
  const ageDays = (NOW - r.collectedSince) / DAY;
  assert.ok(ageDays < 2.1 && ageDays >= 1.9, `B 는 2일 전부터다 — 실제 ${ageDays.toFixed(2)}일 전(수정 전 30일 전)`);
  const ra = await roomTempHistory(mdb, { kind: 'inlet', group: 'A2607', range: '30d' });
  assert.ok((NOW - ra.collectedSince) / DAY > 29, 'A 는 30일 전부터다');
  const none = await roomTempHistory(mdb, { kind: 'inlet', group: 'C2607', range: '7d' });
  assert.equal(none.collectedSince, null, '관측이 없는 법인은 수집 시작도 없다(다른 법인 값을 빌리지 않는다)');
});

function logRows() {
  const rows = [];
  for (let i = 0; i < 40; i++) {
    rows.push({ vcenterId: 'vc-a', key: `k${i}`, ts: NOW - i * 1000, severity: i % 2 ? 'error' : 'info',
      type: 'VmEvent', user: 'svc', entity: 'vm-100', message: `power on vm-100 #${i}` });
  }
  rows.push({ vcenterId: 'vc-a', key: 'lit', ts: NOW - 100_000, severity: 'info', type: 'VmEvent', user: 'svc', entity: 'x', message: 'disk 100% full on vm_200' });
  return rows;
}

test('DB2607-03: 검색어의 _ 와 % 는 LIKE 와일드카드가 아니라 글자다', () => {
  ldb.insertMany(logRows());
  const base = { vcenterIds: ['vc-a'] };
  assert.equal(ldb.count({ ...base, q: 'vm_100' }), 0, "'vm_100' 은 없다 — 'vm-100' 이 맞으면 안 된다(수정 전 40)");
  assert.equal(ldb.count({ ...base, q: 'vm-100' }), 40);
  assert.equal(ldb.count({ ...base, q: 'vm_200' }), 1, '밑줄이 실제로 있으면 맞는다');
  assert.equal(ldb.count({ ...base, q: '100%' }), 1, "'100%' 는 글자 그대로 — '100' 뒤 아무 문자열이 아니다");
  assert.equal(ldb.count({ ...base, q: '100%x' }), 0);
  assert.equal(ldb.query({ ...base, q: 'vm_100' }, 50, 0).length, 0);
  assert.equal(ldb.count({ ...base, q: 'a\\b' }), 0, '백슬래시도 글자(ESCAPE 문자 자체)');
});

test('DB2607-02: 상한 COUNT — 맞는 행이 상한을 넘으면 capped 로 밝히고, 아니면 정확한 수', async () => {
  const { COUNT_CAP } = await import('../src/logs/db.js');
  assert.equal(COUNT_CAP, 10_000);
  const base = { vcenterIds: ['vc-a'], q: 'vm-100' };
  assert.deepEqual(ldb.countCapped(base, 5), { total: 5, capped: true });
  assert.deepEqual(ldb.countCapped(base, 40), { total: 40, capped: false }, '정확히 상한과 같으면 잘리지 않았다');
  assert.deepEqual(ldb.countCapped(base), { total: 40, capped: false });
  assert.deepEqual(ldb.countCapped({ ...base, severity: 'error' }), { total: 20, capped: false });
  assert.deepEqual(ldb.countCapped(base, 1.5), { total: 1, capped: true }, '상한도 정수화(REAL 바인딩 금지)');
  // 라우트: 필터가 있으면 countCapped 를 쓰고 totalCapped 를 응답에 싣는다
  const r = src('routes/api/checksLogs.js');
  const seg = r.slice(r.indexOf("api.get('/tools/vclogs',"), r.indexOf("api.get('/tools/vclogs/export.csv'"));
  assert.match(seg, /countCapped\(f\)/, '필터 조회는 상한 COUNT');
  assert.match(seg, /totalCapped:/, '상한에 닿았는지 응답이 밝힌다');
  assert.match(seg, /f\.q \|\| f\.severity/, '필터 판정은 검색어·심각도');
});

test('DB2607-04: 전이 이력 limit 소수는 정수화된다(datatype mismatch 로 빈 이력이 되지 않는다)', async () => {
  await pf.applyTransition({ opened: [{ agent: '', partKey: 'idrac:X2607:psu:1', scope: 'idrac', deviceId: 'd', state: 'fault' }] });
  assert.ok((await pf.recentEvents({ limit: 500 })).length >= 1);
  const ev = await pf.recentEvents({ limit: 1.5 });
  assert.equal(ev.length, 1, '1.5 → 1 (수정 전 throws datatype mismatch)');
  assert.ok((await pf.recentEvents({ limit: 'abc' })).length >= 1, '숫자가 아니면 기본값');
  const r = src('routes/api/partFaults.js');
  const seg = r.slice(r.indexOf("api.get('/tools/part-faults/events'"));
  const body = seg.slice(0, seg.indexOf('\n});'));
  assert.match(body, /pageArgs\(req\.query/, '라우트도 pageArgs 로 정수화');
  assert.doesNotMatch(body, /recentEvents\([^;]*\.catch\(\(\) => \[\]\)/, '실패를 빈 배열로 삼키지 않는다');
  assert.match(body, /eventsError/, '실패 사유를 응답에 싣는다');
});
