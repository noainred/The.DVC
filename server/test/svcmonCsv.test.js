/**
 * 성능점검 CSV 가져오기/내보내기 — 왕복 안정성, 행 그룹핑, 스키마 단일 소스, 용량 판정.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'svcmon-csv-'));
process.env.SVCMON_WORKERS = '0';

const store = await import('../src/svcmon/store.js');
const { csvLines, targetsToCsv, parseTargetsCsv, sampleCsv, REQUIRED_COLUMNS } = await import('../src/svcmon/csvio.js');
const schema = await import('../src/svcmon/testSchema.js');
const capacity = await import('../src/svcmon/capacity.js');
const { parseCsvRows } = await import('../src/util/csv.js');

/* ── 스키마 단일 소스 ── */
test('cleanTest 결과 키 = 스키마 필드 키(둘 중 하나만 바뀌면 CSV 가 그 필드를 버린다)', () => {
  const t = store.addTarget({ kind: 'infra', path: 'A', name: 'schema-check', host: '10.1.0.1' });
  const x = store.addTest(t.id, {
    name: '전 필드', type: 'soap', port: 8443, url: 'https://10.1.0.1/svc', keyword: 'ok', expectStatus: 200,
    insecure: true, record: 'a.example.com', server: '10.1.0.53', expect: '10.1.0.9',
    payload: 'p', send: 'EHLO x', body: '<x/>', soapAction: 'urn:x',
    warnDays: 20, warnMs: 100, badMs: 200, maxHops: 9, intervalSec: 120,
  });
  const skip = new Set(['id', 'tpl', 'tplKey']);
  const got = Object.keys(x).filter((k) => !skip.has(k)).sort();
  const want = schema.TEST_FIELDS.map((f) => f.key).sort();
  assert.deepEqual(got, want, '스키마 표와 저장 객체의 필드가 일치해야 한다');
});

test('CSV 컬럼 = 대상 5열 + 점검 20열, 필수 컬럼이 표에 존재', () => {
  assert.equal(schema.CSV_COLUMNS.length, schema.TARGET_FIELDS.length + schema.TEST_FIELDS.length);
  assert.equal(new Set(schema.CSV_COLUMNS).size, schema.CSV_COLUMNS.length, '컬럼명 중복 금지');
  for (const c of REQUIRED_COLUMNS) assert.ok(schema.CSV_COLUMNS.includes(c), `필수 컬럼 ${c}`);
});

/* ── 내보내기 ── */
test('내보내기: BOM + 헤더 + 점검 1건=1행, 점검 없는 대상은 1행', () => {
  const targets = [
    { kind: 'infra', path: 'A\\B', name: 'srv1', host: '10.1.1.1', enabled: true, tests: [
      { name: 'p', type: 'ping', intervalSec: 120, enabled: true },
      { name: 't', type: 'tcp', port: 8080, intervalSec: 60, enabled: false },
    ] },
    { kind: 'service', path: 'C', name: 'svc1', host: '10.1.1.2', enabled: false, tests: [] },
  ];
  const csv = targetsToCsv(targets);
  assert.ok(csv.startsWith('﻿'), '엑셀 한글을 위해 BOM 필수');
  const rows = parseCsvRows(csv);
  assert.equal(rows.length, 4, '헤더 1 + 점검 2행 + 점검없는 대상 1행');
  assert.deepEqual(rows[0], schema.CSV_COLUMNS);
  assert.equal(rows[1][schema.CSV_COLUMNS.indexOf('test_name')], 'p');
  assert.equal(rows[2][schema.CSV_COLUMNS.indexOf('test_enabled')], 'false');
  assert.equal(rows[3][schema.CSV_COLUMNS.indexOf('test_name')], '', '점검 없는 대상은 점검 컬럼이 빈 칸');
  assert.equal(rows[3][schema.CSV_COLUMNS.indexOf('target_enabled')], 'false');
});

test('내보내기: 유형과 무관한 컬럼은 빈 칸(기본값을 설정값으로 오해하지 않게)', () => {
  const csv = targetsToCsv([{ kind: 'infra', path: 'A', name: 's', host: '10.1.1.3', tests: [
    { name: 'p', type: 'ping', intervalSec: 60, enabled: true, warnDays: 30 },
  ] }]);
  const rows = parseCsvRows(csv);
  assert.equal(rows[1][schema.CSV_COLUMNS.indexOf('warn_days')], '', 'ping 에 D-일은 의미가 없다');
  assert.equal(rows[1][schema.CSV_COLUMNS.indexOf('url')], '');
  assert.equal(rows[1][schema.CSV_COLUMNS.indexOf('insecure')], '');
});

test('내보내기: 쉼표·따옴표·수식 문자가 든 이름도 되읽을 수 있다', () => {
  const csv = targetsToCsv([{ kind: 'infra', path: 'A\\B,C', name: '=weird,"name"', host: '10.1.1.4', tests: [] }]);
  const rows = parseCsvRows(csv);
  const nameIdx = schema.CSV_COLUMNS.indexOf('target_name');
  assert.equal(rows[1][nameIdx], "'=weird,\"name\"", '수식 가드가 붙은 상태로 저장');
  const back = parseTargetsCsv(csv);
  assert.equal(back.errors.length, 0);
  assert.equal(back.targets[0].name, '=weird,"name"', '가져오기에서 가드를 되돌린다');
  assert.equal(back.targets[0].path, 'A\\B,C');
});

/* ── 가져오기 ── */
test('가져오기: 같은 대상의 여러 행을 하나로 묶는다(행마다 대상을 만들면 중복된다)', () => {
  const csv = targetsToCsv([{ kind: 'infra', path: 'A\\B', name: 'srv1', host: '10.1.2.1', tests: [
    { name: 'p', type: 'ping', intervalSec: 120, enabled: true },
    { name: 't', type: 'tcp', port: 22, intervalSec: 120, enabled: true },
    { name: 'h', type: 'http', url: 'https://10.1.2.1/', intervalSec: 60, enabled: true },
  ] }]);
  const r = parseTargetsCsv(csv);
  assert.equal(r.errors.length, 0);
  assert.equal(r.targets.length, 1, '3행 → 대상 1개');
  assert.equal(r.targets[0].tests.length, 3);
  assert.equal(r.rowCount, 3);
});

test('가져오기: 같은 대상 행들이 서로 다른 host 를 적으면 오류(어느 쪽이 맞는지 알 수 없다)', () => {
  const csv = 'kind,path,target_name,host,test_name,type\r\n'
    + 'infra,A,srv1,10.1.2.2,p,ping\r\n'
    + 'infra,A,srv1,10.1.2.9,t,tcp\r\n';
  const r = parseTargetsCsv(csv);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].reason, /host 가 앞 행/);
  assert.equal(r.errors[0].row, 3, '행 번호는 헤더를 1행으로 센다');
});

test('가져오기: 필수 컬럼 누락 / 빈 값 / 미지 유형', () => {
  const noHeader = parseTargetsCsv('kind,path,test_name\r\ninfra,A,p\r\n');
  assert.match(noHeader.errors[0].reason, /필수 컬럼이 없습니다.*target_name.*host/);

  const r = parseTargetsCsv('kind,path,target_name,host,test_name,type\r\n'
    + 'infra,A,,10.1.2.3,p,ping\r\n'          // 이름 없음
    + 'infra,,srv2,10.1.2.4,p,ping\r\n'       // 경로 없음
    + 'infra,A,srv3,,p,ping\r\n'              // 호스트 없음
    + 'infra,A,srv4,10.1.2.5,p,disk\r\n'      // 미지 유형
    + 'infra,A,srv5,10.1.2.6,p,\r\n'          // 유형 없음
    + 'bogus,A,srv6,10.1.2.7,p,ping\r\n');    // 미지 구분
  const reasons = r.errors.map((e) => e.reason).join(' | ');
  assert.match(reasons, /target_name 이 비어/);
  assert.match(reasons, /path 가 비어/);
  assert.match(reasons, /host 가 비어/);
  assert.match(reasons, /알 수 없는 유형: disk/);
  assert.match(reasons, /type 이 필요/);
  assert.match(reasons, /kind 는 infra\/service/);
  assert.equal(r.errors.length, 6);
});

test('가져오기: 빈 셀은 키를 만들지 않아 저장소 기본값이 적용된다(하한 클램프 금지)', () => {
  const csv = 'kind,path,target_name,host,test_name,type,interval_sec,expect_status,warn_ms,max_hops,insecure\r\n'
    + 'infra,Z\\Empty,csv-empty,10.1.3.1,빈칸,http,,,,,\r\n';
  const r = parseTargetsCsv(csv);
  assert.equal(r.errors.length, 0);
  const t = r.targets[0].tests[0];
  assert.equal(t.intervalSec, undefined, '파서는 빈 셀을 넘기지 않는다');
  assert.equal(t.expectStatus, undefined);
  // 저장까지 가면 기본값이 채워진다
  const url = 'https://10.1.3.1/';
  r.targets[0].tests[0].url = url;
  const res = store.bulkAddTargets(r.targets);
  assert.equal(res.committed, true);
  const saved = store.listTargets().find((x) => x.name === 'csv-empty').tests[0];
  assert.equal(saved.intervalSec, 60);
  assert.equal(saved.expectStatus, undefined);
  assert.equal(saved.insecure, false);
});

test('가져오기: 알 수 없는 컬럼을 조용히 무시하지 않고 보고한다(오타 탐지)', () => {
  const r = parseTargetsCsv('kind,path,target_name,host,hostname,비고\r\ninfra,A,srv9,10.1.3.2,x,메모\r\n');
  assert.deepEqual(r.unknownColumns, ['hostname', '비고']);
  assert.equal(r.targets.length, 1);
});

test('가져오기: 행 상한 초과는 절단이 아니라 오류', () => {
  const head = 'kind,path,target_name,host\r\n';
  const body = Array.from({ length: 60 }, (_, i) => `infra,A,r${i},10.1.4.${i + 1}`).join('\r\n');
  const r = parseTargetsCsv(head + body, { maxRows: 10 });
  assert.equal(r.targets.length, 0);
  assert.match(r.errors[0].reason, /최대 11행/);
});

/* ── 왕복 ── */
test('왕복 고정: 내보내기 → 가져오기 → 저장 후 점검 값이 동일(id 제외)', () => {
  const t = store.addTarget({ kind: 'service', path: 'RT\\Group', name: 'rt-src', host: '10.1.5.1' });
  const made = [
    store.addTest(t.id, { name: 'http 점검', type: 'http', url: 'https://10.1.5.1/health', keyword: 'ok', expectStatus: 200, warnMs: 3000, intervalSec: 120 }),
    store.addTest(t.id, { name: 'cert 점검', type: 'cert', port: 8443, warnDays: 14, intervalSec: 86400 }),
    store.addTest(t.id, { name: 'dns 점검', type: 'dns', record: 'a.example.com', server: '10.1.5.53', intervalSec: 300 }),
    store.addTest(t.id, { name: 'ntp 점검', type: 'ntp', warnMs: 900, badMs: 4000, intervalSec: 600 }),
    store.addTest(t.id, { name: 'trace 점검', type: 'trace', maxHops: 12, intervalSec: 1800, enabled: false }),
  ];
  const src = store.listTargetsCopy().find((x) => x.name === 'rt-src');
  const csv = targetsToCsv([src]);

  const parsed = parseTargetsCsv(csv);
  assert.equal(parsed.errors.length, 0);
  parsed.targets[0].name = 'rt-dst';                 // 같은 폴더에 중복 이름을 만들지 않기 위해
  const r = store.bulkAddTargets(parsed.targets);
  assert.equal(r.committed, true, JSON.stringify(r.errors));

  const dst = store.listTargetsCopy().find((x) => x.name === 'rt-dst');
  assert.equal(dst.tests.length, made.length);
  const strip = (x) => { const { id, ...rest } = x; return rest; };
  for (let i = 0; i < made.length; i += 1) {
    assert.deepEqual(strip(dst.tests[i]), strip(src.tests[i]), `${src.tests[i].name} 왕복 불일치`);
  }
  assert.equal(dst.kind, src.kind);
  assert.equal(dst.host, src.host);
  assert.equal(dst.path, src.path);
});

test('왕복 2회: 같은 CSV 를 다시 가져와도 값이 자라지 않는다(수식가드 누적 금지)', () => {
  const src = [{ kind: 'infra', path: 'A', name: '=formula', host: '10.1.6.1', tests: [
    { name: '-dash', type: 'tcp', port: 80, intervalSec: 60, enabled: true },
  ] }];
  let csv = targetsToCsv(src);
  for (let i = 0; i < 3; i += 1) {
    const p = parseTargetsCsv(csv);
    assert.equal(p.targets[0].name, '=formula');
    assert.equal(p.targets[0].tests[0].name, '-dash');
    csv = targetsToCsv(p.targets);
  }
});

/* ── 샘플 ── */
test('샘플 CSV: 스키마 헤더와 일치하고 오류 없이 되읽힌다', () => {
  const csv = sampleCsv();
  const rows = parseCsvRows(csv);
  assert.deepEqual(rows[0], schema.CSV_COLUMNS, '샘플 헤더가 스키마와 어긋나면 안내가 거짓이 된다');
  const r = parseTargetsCsv(csv);
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  assert.ok(r.targets.length >= 5);
  // 점검 없는 대상 행 예시가 포함되어야 한다(사용법 안내)
  assert.ok(r.targets.some((t) => t.tests.length === 0));
  // 샘플은 사내 주소를 담지 않는다(문서용 대역·example.com 만)
  assert.ok(!/lge|lgcns|corp\.local/i.test(csv));
});

test('샘플 CSV: 그대로 등록되고 유형별 필수값 검증을 통과한다', () => {
  const r = parseTargetsCsv(sampleCsv());
  const res = store.bulkAddTargets(r.targets.map((t) => ({ ...t, path: `S\\${t.path}` })));
  assert.equal(res.committed, true, JSON.stringify(res.errors));
  assert.equal(res.added, r.targets.length);
});

/* ── 용량 판정 ── */
// 이 테스트는 SVCMON_WORKERS='0'(인라인) → 워커 1개로 계산: 소켓형 62/s · ping 16/s · 천장 800/s
test('용량 판정: 틱 천장 초과는 reject, 처리량 부족은 warn', () => {
  const ceiling = capacity.tickCeilingPerSec();
  assert.equal(ceiling, 800, 'MAX_PER_TICK 4000 ÷ 틱 5초');

  // 10,000 항목 ÷ 10초 = 1,000/s > 800/s → 어떤 튜닝으로도 지정 주기를 지킬 수 없다
  const rj = capacity.judgeCapacity({ tests: [], addedTests: Array.from({ length: 10000 }, () => ({ type: 'tcp', intervalSec: 10, enabled: true })) });
  assert.equal(rj.verdict, 'reject');
  assert.equal(rj.requiredPerSec, 1000);
  assert.match(rj.reasons.join(' '), /틱 상한 초과/);

  // 6,000 ÷ 60초 = 100/s — 천장은 넘지 않지만 워커 1개(62/s)로는 부족
  const warn = capacity.judgeCapacity({ tests: [], addedTests: Array.from({ length: 6000 }, () => ({ type: 'tcp', intervalSec: 60, enabled: true })) });
  assert.equal(warn.verdict, 'warn');
  assert.equal(warn.capablePerSec, 62);
  assert.match(warn.reasons.join(' '), /처리량 부족/);

  const ok = capacity.judgeCapacity({ tests: [], addedTests: Array.from({ length: 100 }, () => ({ type: 'tcp', intervalSec: 300, enabled: true })) });
  assert.equal(ok.verdict, 'ok');
  assert.equal(ok.reasons.length, 0);
});

test('용량 판정: 중지된 점검은 부하 0, ping 은 별도 상한으로 판정', () => {
  const off = capacity.judgeCapacity({ tests: [], addedTests: Array.from({ length: 5000 }, () => ({ type: 'tcp', intervalSec: 10, enabled: false })) });
  assert.equal(off.requiredPerSec, 0, '중지 항목은 만기 인덱스에 들어가지 않아 부하가 0이다');
  assert.equal(off.verdict, 'ok');

  // 3,000 ping ÷ 60초 = 50/s — 소켓형 상한(62/s)은 넘지 않지만 ping 상한(16/s)은 넘는다.
  // ping 을 소켓형 기준으로만 보면 이 규모가 통과해 버린다.
  const pings = capacity.judgeCapacity({ tests: [], addedTests: Array.from({ length: 3000 }, () => ({ type: 'ping', intervalSec: 60, enabled: true })) });
  assert.equal(pings.verdict, 'warn');
  assert.equal(pings.requiredProcPerSec, 50);
  assert.equal(pings.procPerSec, 16);
  assert.match(pings.reasons.join(' '), /ping\/trace/);
});

test('용량 판정: 로그량을 함께 알린다(초당 처리량 × 98B × 86400)', () => {
  const r = capacity.judgeCapacity({ tests: [], addedTests: Array.from({ length: 12000 }, () => ({ type: 'tcp', intervalSec: 48, enabled: true })) });
  assert.equal(r.requiredPerSec, 250);
  assert.equal(r.logGbPerDay, 1.97);
});

/* ── 미리보기(계획) ── */
test('planBulkTargets: 저장하지 않고 커밋과 같은 판정을 낸다', () => {
  const rev = store.storeRevision();
  const before = store.listTargets().length;
  const rows = [
    { kind: 'infra', path: 'PV\\A', name: 'pv-1', host: '10.1.7.1', tests: [{ name: 'p', type: 'ping' }] },
    { kind: 'infra', path: 'PV\\A', name: 'pv-2', host: '127.0.0.1' },                 // 차단
    { kind: 'infra', path: 'PV\\A', name: 'pv-1', host: '10.1.7.3' },                  // 배치 내 중복
  ];
  const plan = store.planBulkTargets(rows);
  assert.equal(plan.prepared.length, 1);
  assert.equal(plan.errors.length, 1);
  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.newFolders, 2, 'PV + PV\\A');
  assert.equal(plan.newTests, 1);
  assert.equal(plan.after.targets, plan.before.targets + 1);
  assert.equal(store.listTargets().length, before, '미리보기는 저장소를 바꾸지 않는다');
  assert.equal(store.storeRevision(), rev, '리비전도 그대로여야 폴러가 인덱스를 재구성하지 않는다');
});

/* ── 폴러 공평 선정 / 상태 구분 ── */
test('capacity workerCount 는 pool.js 와 같은 식(os.cpus 기반)이어야 한다', async () => {
  const prev = process.env.SVCMON_WORKERS;
  delete process.env.SVCMON_WORKERS;
  const os = await import('node:os');
  const expected = Math.max(1, Math.min(4, Math.max(1, os.cpus().length - 1)));
  assert.equal(capacity.workerCount(), expected,
    'pool 은 os.cpus()-1(최대 4)로 워커를 만든다 — 다른 식을 쓰면 처리량을 과대/과소 평가한다');
  process.env.SVCMON_WORKERS = prev ?? '0';
});

test('폴러 선정은 원형 커서 — 상한을 넘겨도 뒤쪽이 굶지 않는다(시뮬레이션)', () => {
  // poller.js sweep 의 선정 로직과 같은 알고리즘. 0번부터만 훑으면 뒤쪽이 영구히 실행되지
  // 않는다(실측: 15만 항목·주기 60초·천장 800/s → 1시간 동안 68%가 한 번도 안 돎).
  const N = 6000;
  const MAX_PER_TICK = 400;
  const TICK = 5000;
  const INTERVAL = 60;
  const run = (circular) => {
    const nextDue = new Array(N).fill(0);
    const ran = new Array(N).fill(0);
    let cursor = 0;
    let now = 0;
    for (let tick = 0; tick < 720; tick += 1) {
      now += TICK;
      const due = [];
      if (circular) {
        let i = cursor >= N ? 0 : cursor;
        for (let s = 0; s < N && due.length < MAX_PER_TICK; s += 1) {
          if (nextDue[i] <= now) due.push(i);
          i = i + 1 === N ? 0 : i + 1;
        }
        cursor = i;
      } else {
        for (let i = 0; i < N && due.length < MAX_PER_TICK; i += 1) {
          if (nextDue[i] <= now) due.push(i);
        }
      }
      for (const i of due) { nextDue[i] = now + INTERVAL * 1000; ran[i] += 1; }
    }
    return ran.filter((x) => x === 0).length;
  };
  const starved = run(false);
  const fair = run(true);
  // 천장(400/틱 ÷ 5초 = 80/s) × 주기 60초 = 4,800개만 소화 가능 → 나머지 1,200개가 굶는다.
  // 굶는 수가 '앞에서부터 소화 가능한 만큼'과 정확히 일치하는 것이 이 결함의 특징이다
  // (모두의 주기가 늘어나는 게 아니라 뒤쪽만 0회).
  assert.equal(starved, N - (MAX_PER_TICK / (TICK / 1000)) * INTERVAL,
    `0번부터 훑으면 소화 못한 뒤쪽이 정확히 굶어야 한다(실제 ${starved}/${N})`);
  assert.equal(fair, 0, `원형 커서는 모든 항목을 최소 1회 실행해야 한다(안 돈 항목 ${fair}개)`);
});

test('상태 판정: 중지 · 점검대기 · 갱신안됨 을 서로 구분한다', async () => {
  const st = await import('../src/svcmon/status.js');
  const now = 1_000_000_000;
  const results = new Map();
  const T = { enabled: true };
  const X = { id: 'x1', enabled: true, intervalSec: 60 };

  // 중지는 의도적 설정이다
  assert.equal(st.testState({ enabled: false }, X, results, now), 'disabled');
  assert.equal(st.testState(T, { ...X, enabled: false }, results, now), 'disabled');

  // 사용 중인데 결과가 없으면 '중지'가 아니라 '점검 대기'다 — 이 둘을 합치면 감시 공백이
  // 정상 설정으로 위장된다(폴러 과부하 시 실제로 그 상태가 대량 발생했다).
  assert.equal(st.testState(T, X, results, now), 'pending');

  // 방금 갱신된 결과는 그 상태 그대로
  results.set('x1', { status: 'ok', ts: now - 5_000 });
  assert.equal(st.testState(T, X, results, now), 'ok');

  // 주기의 3배를 넘겨 갱신되지 않으면 stale — 'ok' 를 계속 보여주면 한 시간 전 상태가
  // 현재 상태로 표시된다.
  results.set('x1', { status: 'ok', ts: now - 60_000 * 3 - 1 });
  assert.equal(st.testState(T, X, results, now), 'stale');

  // 주기가 짧아도 하한(60초) 안에서는 stale 로 보지 않는다(정상 지터 오탐 방지)
  const fast = { id: 'x2', enabled: true, intervalSec: 10 };
  results.set('x2', { status: 'ok', ts: now - 45_000 });
  assert.equal(st.testState(T, fast, results, now), 'ok');
  results.set('x2', { status: 'ok', ts: now - 61_000 });
  assert.equal(st.testState(T, fast, results, now), 'stale');

  // 알 수 없는 status 는 ok 로 취급하지 않는다
  results.set('x1', { status: '이상한값', ts: now });
  assert.equal(st.testState(T, X, results, now), 'pending');

  assert.deepEqual(Object.keys(st.emptySummary()).sort(),
    ['bad', 'disabled', 'ok', 'pending', 'stale', 'total', 'warn']);
});
