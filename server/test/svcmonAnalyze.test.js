/**
 * 성능점검 CSV 로그 분석 엔진(svcmon/loganalyze.js) — T1~T9.
 * 임시 CONFIG_DIR 에 합성 로그(일별 2 + 파트 + 시간별 1 + 보조 파일)를 만들어 검증한다.
 * 외부 네트워크·실서비스에 의존하지 않는다.
 *
 * 합성 데이터(로컬 시간 기준 — csvlog.periodKey 가 로컬 시간이므로 파일명과 일치):
 *   results-20260701.csv      r1 ok120 r2 ok80 r3 bad30(tcp,db01)
 *   results-20260701-p02.csv  r4 ok200(응답에 쉼표·따옴표) r5 warn500 r11 ok90(응답에 줄바꿈)
 *   results-20260810-14.csv   r6 ok10 r7 bad5000(응답 수식가드) r10 ok15(대상 -edge01 가드)
 *                             + 불량 2행(컬럼 부족 / 시각 파싱 실패)
 *   results-20260115.csv      rH1 ok40 (상반기 검증용, 7~8월 조회에선 사전 스킵)
 *   results-20250101.csv      손상 행만 있음 — 스캔되면 badRows 가 늘어난다(스킵 검증용)
 *   results-legacy.csv        rL ok60 (파일명 파싱 불가 → mtime 판단으로 스캔 대상)
 *
 * T10~T13 은 위 메인 픽스처의 파일 수 단언(listLogWindows/skipped)을 보호하기 위해
 * 각자 별도 로그 디렉터리(setLogSettings dirName 전환)에서 돈다 — T8 과 같은 패턴.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// config.configDir 은 모듈 로드 시점에 고정된다 — import 보다 **먼저** 설정해야 한다.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'svcmon-analyze-'));
process.env.CONFIG_DIR = DIR;

const { analyzeLog, listLogWindows, parseLogFileName } = await import('../src/svcmon/loganalyze.js');
const { logDir, setLogSettings } = await import('../src/svcmon/logsettings.js');
const { periodKey } = await import('../src/svcmon/csvlog.js');

/* ── 합성 로그 생성 ── */
const BOM = '﻿';
const HEADER = '시각,경로,대상,호스트,점검명,유형,상태,응답,ms,연속횟수';

/** csvlog.cell 과 같은 규칙(수식가드 + RFC4180 quoting)으로 셀을 만든다. */
function q(v) {
  let s = String(v ?? '');
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}
const L = (...a) => new Date(...a).getTime(); // 로컬 시간 ms epoch
function row(ts, p, target, host, testName, type, status, reply, ms, streak = 1) {
  return [new Date(ts).toISOString(), p, target, host, testName, type, status, reply, ms, streak].map(q).join(',');
}
function writeLog(name, lines) {
  fs.writeFileSync(path.join(logDir(), name), [BOM + HEADER, ...lines].join('\n') + '\n');
}

writeLog('results-20260701.csv', [
  row(L(2026, 6, 1, 1), 'A.Infra\\Seoul', 'web01', '10.0.0.1', 'HTTP', 'http', 'ok', 'HTTP 200', 120),
  row(L(2026, 6, 1, 2), 'A.Infra\\Seoul', 'web02', '10.0.0.2', 'HTTP', 'http', 'ok', 'HTTP 200', 80),
  row(L(2026, 6, 1, 3), 'A.Infra\\Busan', 'db01', '10.0.1.1', 'TCP체크', 'tcp', 'bad', 'Connection refused', 30),
]);
writeLog('results-20260701-p02.csv', [
  row(L(2026, 6, 1, 4), 'B.Svc\\SBP', 'app01', '10.0.2.1', 'HTTP', 'http', 'ok', '응답 "OK", 지연', 200),
  row(L(2026, 6, 1, 5), 'B.Svc\\SBP', 'app02', '10.0.2.2', 'HTTP', 'http', 'warn', '느림', 500),
  row(L(2026, 6, 1, 7), 'B.Svc\\SBP', 'ml01', '10.0.2.3', 'HTTP', 'http', 'ok', '줄1\n줄2', 90), // 응답에 줄바꿈
]);
writeLog('results-20260810-14.csv', [
  row(L(2026, 7, 10, 14, 5), 'B.Svc\\Edge', 'edge00', '10.0.4.1', 'PING', 'ping', 'ok', 'pong', 10),
  row(L(2026, 7, 10, 14, 10), 'B.Svc\\Edge', 'edge02', '10.0.4.2', 'HTTP', 'http', 'bad', '=cmd|evil', 5000), // 응답 수식가드
  row(L(2026, 7, 10, 14, 15), 'B.Svc\\Edge', '-edge01', '10.0.4.3', 'PING', 'ping', 'ok', 'pong', 15),         // 대상 수식가드
  'too,few',                                                        // 컬럼 부족 → badRows
  '찌그러진시각,B.Svc\\Edge,x,10.0.4.9,PING,ping,ok,r,5,1',          // 시각 파싱 실패 → badRows
]);
writeLog('results-20260115.csv', [
  row(L(2026, 0, 15, 9), 'B.Svc\\H1', 'h1svc', '10.0.5.1', 'PING', 'ping', 'ok', 'pong', 40),
]);
writeLog('results-20250101.csv', [
  '깨진,"미종결', // 이 파일이 열리면 badRows 가 늘어난다 — 사전 스킵 검증용
]);
writeLog('results-legacy.csv', [
  row(L(2026, 6, 1, 6), 'B.Svc\\Legacy', 'legacy01', '10.0.6.1', 'PING', 'ping', 'ok', 'pong', 60),
]);

// 조회 창: 7~8월(메인) / 2026년 전체
const W1 = { from: L(2026, 6, 1), to: L(2026, 8, 1) };
const WALL = { from: L(2026, 0, 1), to: L(2027, 0, 1) };

/* ── 파일명 파싱 ── */

test('parseLogFileName: day/hour/part/week/month/quarter 형식 + 불가 시 null', () => {
  const day = parseLogFileName('results-20260701.csv');
  assert.deepEqual([day.rotate, day.from, day.to], ['day', L(2026, 6, 1), L(2026, 6, 2)]);

  const hour = parseLogFileName('results-20260810-14.csv');
  assert.deepEqual([hour.rotate, hour.from, hour.to], ['hour', L(2026, 7, 10, 14), L(2026, 7, 10, 15)]);

  // 파트 접미(-pNN)는 기간에 영향이 없다
  const part = parseLogFileName('results-20260810-14-p02.csv');
  assert.deepEqual([part.from, part.to], [hour.from, hour.to]);

  // 주간 — 시작이 월요일이고, csvlog.periodKey(라이터의 진실)와 키가 왕복 일치한다
  const wk = parseLogFileName('results-2026-W32.csv');
  assert.equal(wk.rotate, 'week');
  assert.equal(new Date(wk.from).getDay(), 1);
  assert.equal(periodKey(wk.from, 'week'), '2026-W32');
  assert.equal(periodKey(wk.to - 1, 'week'), '2026-W32');
  assert.equal(periodKey(wk.to, 'week'), '2026-W33');

  const mo = parseLogFileName('results-202608.csv');
  assert.deepEqual([mo.rotate, mo.from, mo.to], ['month', L(2026, 7, 1), L(2026, 8, 1)]);

  const qt = parseLogFileName('results-2026Q3.csv');
  assert.deepEqual([qt.rotate, qt.from, qt.to], ['quarter', L(2026, 6, 1), L(2026, 9, 1)]);

  assert.equal(parseLogFileName('results-20261301.csv'), null); // 13월 — 무효
  assert.equal(parseLogFileName('results-legacy.csv'), null);
  assert.equal(parseLogFileName('other-20260701.csv'), null);
});

test('listLogWindows: 파일별 기간 추정(파싱 불가는 from/to null)', () => {
  const wins = listLogWindows();
  assert.equal(wins.length, 6);
  const day = wins.find((w) => w.name === 'results-20260701.csv');
  assert.equal(day.from, L(2026, 6, 1));
  assert.equal(day.to, L(2026, 6, 2));
  assert.ok(day.sizeBytes > 0);
  const legacy = wins.find((w) => w.name === 'results-legacy.csv');
  assert.equal(legacy.from, null);
  assert.equal(legacy.to, null);
  assert.ok(legacy.modifiedAt > 0);
});

/* ── T1: 버킷 집계 정확성(일/월/연간) — 수기 계산과 대조 ── */

test('T1 일 버킷: ok/warn/bad·avgMs·maxMs 수기 계산 일치', async () => {
  const res = await analyzeLog({ ...W1, bucket: 'day' });
  assert.equal(res.buckets.length, 2);

  // 20260701: 120+80+30+200+500+60+90 = 1080 / 7행 = 154.29
  const b1 = res.buckets[0];
  assert.equal(b1.key, '20260701');
  assert.equal(b1.from, L(2026, 6, 1));
  assert.deepEqual(
    [b1.rows, b1.ok, b1.warn, b1.bad, b1.other, b1.avgMs, b1.maxMs],
    [7, 5, 1, 1, 0, Math.round((1080 / 7) * 100) / 100, 500],
  );

  // 20260810: 10+5000+15 = 5025 / 3행 = 1675
  const b2 = res.buckets[1];
  assert.equal(b2.key, '20260810');
  assert.deepEqual([b2.rows, b2.ok, b2.bad, b2.avgMs, b2.maxMs], [3, 2, 1, 1675, 5000]);

  // 합계: 10행, 6105ms → 610.5
  assert.deepEqual(
    [res.totals.rows, res.totals.ok, res.totals.warn, res.totals.bad, res.totals.other],
    [10, 7, 1, 2, 0],
  );
  assert.equal(res.totals.avgMs, 610.5);
  assert.equal(res.totals.maxMs, 5000);
  assert.equal(res.truncated, false);
});

test('T1 월 버킷: 202607/202608 로 갈린다', async () => {
  const res = await analyzeLog({ ...W1, bucket: 'month' });
  assert.deepEqual(res.buckets.map((b) => [b.key, b.rows]), [['202607', 7], ['202608', 3]]);
  assert.equal(res.buckets[0].from, L(2026, 6, 1));
  assert.equal(res.buckets[1].from, L(2026, 7, 1));
});

test('T1 연간 버킷: 2026 전체 — 1월 파일 포함 11행', async () => {
  const res = await analyzeLog({ ...WALL, bucket: 'year' });
  assert.equal(res.buckets.length, 1);
  const b = res.buckets[0];
  assert.equal(b.key, '2026');
  assert.equal(b.from, L(2026, 0, 1));
  // 6105 + 40(1월) = 6145 / 11행 = 558.64
  assert.deepEqual([b.rows, b.ok, b.warn, b.bad], [11, 8, 1, 2]);
  assert.equal(b.avgMs, Math.round((6145 / 11) * 100) / 100);
});

/* ── T2: 기간 밖 파일은 실제로 열지 않는다 ── */

test('T2 사전 선별: 기간 밖 파일 스킵(손상 파일이 badRows 에 안 잡힘)', async () => {
  const res = await analyzeLog({ ...W1, bucket: 'day' });
  // 20250101(2025년) + 20260115(1월) 두 파일이 스킵된다
  assert.equal(res.files.skipped, 2);
  assert.equal(res.files.scanned, 4);
  assert.ok(!res.files.list.includes('results-20250101.csv'));
  assert.ok(!res.files.list.includes('results-20260115.csv'));
  // 20250101 은 손상 행만 있다 — 열렸다면 badRows 3 이상이 됐을 것(불량 2행은 시간별 파일 것)
  assert.equal(res.badRows, 2);
  // 파일명 파싱 불가(results-legacy.csv)는 스캔 대상에 들어간다(침묵 누락 금지)
  assert.ok(res.files.list.includes('results-legacy.csv'));
  const legacy = await analyzeLog({ ...W1, target: 'legacy01' });
  assert.equal(legacy.totals.rows, 1);
});

/* ── T3: 예산 초과 → truncated + 부분 결과 ── */

test('T3 maxRows 초과: truncated:true + 어디까지 봤는지 보고', async () => {
  // 스캔 순서(이름 정렬): -p02(3행) → 20260701(1행째에서 예산 도달) → 나머지 skipped
  const res = await analyzeLog({ ...W1, bucket: 'day', maxRows: 3 });
  assert.equal(res.truncated, true);
  assert.equal(res.scannedRows, 3);
  assert.equal(res.files.scanned, 2);
  assert.equal(res.files.skipped, 4); // 사전 스킵 2 + 예산 소진 미열람 2
  // 부분 결과: p02 의 3행(200 ok + 500 warn + 90 ok) = 790/3
  assert.equal(res.totals.rows, 3);
  assert.equal(res.buckets[0].rows, 3);
  assert.equal(res.buckets[0].avgMs, Math.round((790 / 3) * 100) / 100);
});

test('T3b maxMs=0: 시간 예산 즉시 소진 — 파일을 열지 않고 truncated', async () => {
  const res = await analyzeLog({ ...W1, bucket: 'day', maxMs: 0 });
  assert.equal(res.truncated, true);
  assert.equal(res.files.scanned, 0);
  assert.equal(res.scannedRows, 0);
  assert.equal(res.files.skipped, 6); // 사전 스킵 2 + 미열람 4
});

/* ── T4: 응답 필드의 쉼표·따옴표·줄바꿈·수식가드 파싱 ── */

test('T4 특수문자 행 파싱: 쉼표/이스케이프 따옴표/줄바꿈/수식가드가 컬럼을 밀지 않는다', async () => {
  // r4: 응답 `응답 "OK", 지연` — 쉼표가 필드를 갈랐다면 ms(200)가 어긋난다
  const a = await analyzeLog({ ...W1, target: 'app01' });
  assert.deepEqual([a.totals.rows, a.totals.avgMs], [1, 200]);
  // r11: 응답에 줄바꿈 — 물리 2행이 논리 1행으로 이어진다
  const m = await analyzeLog({ ...W1, target: 'ml01' });
  assert.deepEqual([m.totals.rows, m.totals.avgMs, m.badRows], [1, 90, 2]);
  // r7: 응답 '=cmd|evil (수식가드) — 집계에 영향 없음
  const e = await analyzeLog({ ...W1, target: 'edge02' });
  assert.deepEqual([e.totals.rows, e.totals.avgMs], [1, 5000]);
  // r10: 대상 -edge01 은 '-edge01 로 기록된다 — 가드를 벗겨 비교
  const g = await analyzeLog({ ...W1, target: '-edge01' });
  assert.deepEqual([g.totals.rows, g.totals.avgMs], [1, 15]);
});

/* ── T5: 잘못된 행은 badRows 로 세고 집계는 계속 ── */

test('T5 불량 행(컬럼 부족·시각 파싱 실패): badRows 카운트 + 나머지 집계 유지', async () => {
  const res = await analyzeLog({ ...W1, bucket: 'day' });
  assert.equal(res.badRows, 2);       // too,few + 찌그러진시각
  assert.equal(res.totals.rows, 10);  // 불량 행 제외 전부 집계
  assert.equal(res.scannedRows, 12);  // 유효 10 + 불량 2 (헤더 제외)
});

/* ── T6: 필터 ── */

test('T6 필터: target/test/type/path prefix/status', async () => {
  assert.equal((await analyzeLog({ ...W1, target: 'db01' })).totals.rows, 1);
  assert.equal((await analyzeLog({ ...W1, target: 'db01' })).totals.bad, 1);
  assert.equal((await analyzeLog({ ...W1, test: 'TCP체크' })).totals.rows, 1);
  assert.equal((await analyzeLog({ ...W1, type: 'tcp' })).totals.rows, 1);
  assert.equal((await analyzeLog({ ...W1, type: 'ping' })).totals.rows, 3);   // r6,r10,rL
  assert.equal((await analyzeLog({ ...W1, path: 'A.Infra' })).totals.rows, 3);
  assert.equal((await analyzeLog({ ...W1, path: 'A.Infra\\Seoul' })).totals.rows, 2);
  const bad = await analyzeLog({ ...W1, status: 'bad' });
  assert.deepEqual([bad.totals.rows, bad.totals.bad, bad.totals.ok], [2, 2, 0]);
});

/* ── T7: half/year 버킷 표기 ── */

test('T7 half 버킷: YYYY-H1/H2 표기 + 경계(1~6월/7~12월)', async () => {
  const res = await analyzeLog({ ...WALL, bucket: 'half' });
  assert.deepEqual(res.buckets.map((b) => [b.key, b.rows]), [['2026-H1', 1], ['2026-H2', 10]]);
  assert.equal(res.buckets[0].from, L(2026, 0, 1));
  assert.equal(res.buckets[1].from, L(2026, 6, 1));
  assert.equal(res.buckets[0].avgMs, 40);
  assert.equal(res.buckets[1].avgMs, 610.5);

  const yr = await analyzeLog({ ...WALL, bucket: 'year' });
  assert.deepEqual(yr.buckets.map((b) => b.key), ['2026']);
});

/* ── T8: 빈 디렉터리 ── */

test('T8 빈 디렉터리: 오류 없이 빈 결과', async () => {
  setLogSettings({ dirName: 'svcmon-logs-empty' });
  try {
    const res = await analyzeLog({ ...WALL, bucket: 'day' });
    assert.deepEqual(res.buckets, []);
    assert.equal(res.totals.rows, 0);
    assert.equal(res.totals.avgMs, null);
    assert.deepEqual(res.files, { scanned: 0, skipped: 0, list: [] });
    assert.equal(res.truncated, false);
    assert.deepEqual(listLogWindows(), []);
  } finally {
    setLogSettings({ dirName: 'svcmon-logs' }); // 기본값 복원(뒤 테스트 보호)
  }
});

/* ── T9: p95 근사 ── */

test('T9 p95 근사: 참값이 속한 히스토그램 빈 경계 안 + approx 명시', async () => {
  const res = await analyzeLog({ ...W1, bucket: 'day' });
  assert.equal(res.approx, true);
  // 20260701 ms=[120,80,30,200,500,60,90] → 참 p95=500, 빈 [500,1000)
  const b1 = res.buckets.find((b) => b.key === '20260701');
  assert.ok(b1.p95Ms >= 500 && b1.p95Ms <= 1000, `p95=${b1.p95Ms}`);
  // 20260810 ms=[10,5000,15] → 참 p95=5000, 빈 [5000,10000)
  const b2 = res.buckets.find((b) => b.key === '20260810');
  assert.ok(b2.p95Ms >= 5000 && b2.p95Ms <= 10000, `p95=${b2.p95Ms}`);
  // ms 표본이 없으면 null
  const none = await analyzeLog({ ...W1, target: '존재안함' });
  assert.deepEqual(none.buckets, []);
});

/* ── T10~T13 헬퍼: 별도 로그 디렉터리에서 실행(메인 픽스처 단언 보호) ── */

async function inLogDir(dirName, fn) {
  setLogSettings({ dirName }); // logDir() 가 디렉터리를 만든다
  try { return await fn(); } finally { setLogSettings({ dirName: 'svcmon-logs' }); }
}

/* ── T10: hour/week/quarter 버킷 경계(analyzeLog 경유) ── */

test('T10 hour/week/quarter 버킷: 경계 행이 올바른 버킷으로 갈린다', async () => {
  await inLogDir('svcmon-logs-buckets', async () => {
    // 시간 버킷 — 13:59:59.999/14:00/14:59:59.999/15:00 이 [13:1, 14:2, 15:1] 로 갈린다
    writeLog('results-20261005.csv', [
      row(L(2026, 9, 5, 13, 59, 59, 999), 'P', 'a', 'h', 'T', 'ping', 'ok', 'r', 10),
      row(L(2026, 9, 5, 14, 0, 0, 0), 'P', 'a', 'h', 'T', 'ping', 'ok', 'r', 10),
      row(L(2026, 9, 5, 14, 59, 59, 999), 'P', 'a', 'h', 'T', 'ping', 'ok', 'r', 10),
      row(L(2026, 9, 5, 15, 0, 0, 0), 'P', 'a', 'h', 'T', 'ping', 'ok', 'r', 10),
    ]);
    const hr = await analyzeLog({ from: L(2026, 9, 5), to: L(2026, 9, 6), bucket: 'hour' });
    assert.deepEqual(hr.buckets.map((b) => [b.key, b.rows, b.from]), [
      ['20261005-13', 1, L(2026, 9, 5, 13)],
      ['20261005-14', 2, L(2026, 9, 5, 14)],
      ['20261005-15', 1, L(2026, 9, 5, 15)],
    ]);

    // 주간 버킷 — from 은 월요일. 일요일 23:59:59 는 같은 주, 다음 월요일 00:00 은 다음 주.
    writeLog('results-20260803.csv', [
      row(L(2026, 7, 3), 'P', 'a', 'h', 'T', 'ping', 'ok', 'r', 10),             // 월 00:00
      row(L(2026, 7, 9, 23, 59, 59), 'P', 'a', 'h', 'T', 'ping', 'ok', 'r', 10), // 일 23:59:59
      row(L(2026, 7, 10), 'P', 'a', 'h', 'T', 'ping', 'ok', 'r', 10),            // 다음 월 00:00
    ]);
    const wk = await analyzeLog({ from: L(2026, 7, 3), to: L(2026, 7, 17), bucket: 'week' });
    assert.deepEqual(wk.buckets.map((b) => [b.key, b.rows, b.from]), [
      ['2026-W32', 2, L(2026, 7, 3)],
      ['2026-W33', 1, L(2026, 7, 10)],
    ]);
    assert.equal(new Date(wk.buckets[0].from).getDay(), 1); // 주 시작 = 월요일

    // 연말 ISO 주 — 2026-12-28(월)~2027-01-03(일)은 해가 갈려도 2026-W53 한 버킷이다
    writeLog('results-20261228.csv', [
      row(L(2026, 11, 28, 10), 'P', 'a', 'h', 'T', 'ping', 'ok', 'r', 10),
      row(L(2027, 0, 3, 23), 'P', 'a', 'h', 'T', 'ping', 'ok', 'r', 10),
    ]);
    const ye = await analyzeLog({ from: L(2026, 11, 21), to: L(2027, 0, 5), bucket: 'week' });
    assert.deepEqual(ye.buckets.map((b) => [b.key, b.rows, b.from]),
      [['2026-W53', 2, L(2026, 11, 28)]]);

    // 분기 버킷 — 6/30 23:59 → 2026Q2(from 4/1), 7/1 00:00 → 2026Q3(from 7/1)
    writeLog('results-20260630.csv', [
      row(L(2026, 5, 30, 23, 59), 'P', 'a', 'h', 'T', 'ping', 'ok', 'r', 10),
      row(L(2026, 6, 1, 0, 0), 'P', 'a', 'h', 'T', 'ping', 'ok', 'r', 10),
    ]);
    const qt = await analyzeLog({ from: L(2026, 5, 1), to: L(2026, 7, 1), bucket: 'quarter' });
    assert.deepEqual(qt.buckets.map((b) => [b.key, b.rows, b.from]), [
      ['2026Q2', 1, L(2026, 3, 1)],
      ['2026Q3', 1, L(2026, 6, 1)],
    ]);
  });
});

/* ── T11: p95 ≠ max 표본 — 'p95 대신 max 반환' 회귀를 구분한다 ── */

test('T11 p95 근사: 이상치 1개(p95≠max)에서 p95 가 max 로 끌려가지 않는다', async () => {
  await inLogDir('svcmon-logs-p95', async () => {
    // 5~23ms 19개 + 이상치 5000ms 1개. n=20 → need=ceil(19)=19 → 참 p95=23(빈 [20,50)).
    const rows = [];
    for (let i = 0; i < 19; i += 1) {
      rows.push(row(L(2026, 10, 2, 1, 0, i), 'P', 'a', 'h', 'T', 'ping', 'ok', 'r', 5 + i));
    }
    rows.push(row(L(2026, 10, 2, 2), 'P', 'a', 'h', 'T', 'ping', 'ok', 'r', 5000));
    writeLog('results-20261102.csv', rows);
    const res = await analyzeLog({ from: L(2026, 10, 2), to: L(2026, 10, 3), bucket: 'day' });
    assert.equal(res.buckets.length, 1);
    const b = res.buckets[0];
    assert.equal(b.maxMs, 5000);
    // p95FromHist 를 maxMs 반환으로 바꾸면 5000 이 되어 즉시 잡힌다
    assert.ok(b.p95Ms >= 23 && b.p95Ms <= 50, `p95Ms=${b.p95Ms}`);
  });
});

/* ── T12: 미종결 인용부호 폭주(손상 파일) — O(L) 파싱 + 손상 구간 양보·예산 ── */

test('T12 손상 파일(미종결 인용 + 무따옴표 정상 행 다수): 예산 내 완료 + 이벤트 루프 무정지', async () => {
  await inLogDir('svcmon-logs-perf', async () => {
    // 정상 100행 → 미종결 인용 1행 → 정상 30,000행(행 ~130B, 총 ~3.9MB).
    // 미종결 행 이후의 무따옴표 행은 PENDING_MAX(1MB)까지 이어붙임으로 빨려 들어간다 —
    // 이어붙인 전체를 재파싱하는 O(L²) 구현은 이 패턴에서 십수 초 정지했다(실측 7.5MB 18s).
    const reply = 'x'.repeat(60);
    const base = L(2026, 8, 1);
    const lines = [];
    for (let i = 0; i < 100; i += 1) {
      lines.push(row(base + i * 1000, 'P.Perf', 'tgt01', '10.9.9.9', 'PERF', 'ping', 'ok', reply, 12));
    }
    lines.push(`${new Date(base + 100_000).toISOString()},P.Perf,tgt01,10.9.9.9,PERF,ping,ok,"잘린 미종결`);
    for (let i = 101; i < 30101; i += 1) {
      lines.push(row(base + i * 1000, 'P.Perf', 'tgt01', '10.9.9.9', 'PERF', 'ping', 'ok', reply, 12));
    }
    writeLog('results-20260901.csv', lines);

    // 스캔 중 이벤트 루프 최대 정지 시간 측정(50ms 인터벌의 지연)
    let maxGap = 0;
    let last = Date.now();
    const timer = setInterval(() => {
      const now = Date.now();
      if (now - last > maxGap) maxGap = now - last;
      last = now;
    }, 50);
    let res;
    try {
      res = await analyzeLog({ from: L(2026, 8, 1), to: L(2026, 8, 2), bucket: 'day' });
    } finally { clearInterval(timer); }

    assert.equal(res.truncated, false); // 기본 예산(10s) 내 완료 — O(L²)면 십수 초 걸려 절단된다
    assert.ok(res.elapsedMs < 5000, `elapsedMs=${res.elapsedMs}`);
    assert.ok(res.badRows >= 1, `badRows=${res.badRows}`); // 이어붙임 상한 초과 1건 이상
    // 상한 초과로 pending 이 버려진 뒤의 행들은 정상 집계된다(1MB/행130B ≈ 8천 행만 유실)
    assert.ok(res.totals.rows >= 10000 && res.totals.rows < 30100, `rows=${res.totals.rows}`);
    // 손상 구간에서도 물리행 기준 양보가 돌아 이벤트 루프가 초 단위로 멈추지 않는다
    assert.ok(maxGap < 1000, `이벤트 루프 최대 정지 ${maxGap}ms`);
  });
});

/* ── T13: 스캔 중간 시간 예산 — maxMs 초과 시 곧 중단(초과폭은 양보 배치 1회분) ── */

test('T13 시간 예산(스캔 중간): maxMs 를 넘기면 truncated + elapsedMs 유한 초과', async () => {
  await inLogDir('svcmon-logs-budget', async () => {
    const base = L(2026, 9, 1);
    const lines = [];
    for (let i = 0; i < 120_000; i += 1) {
      lines.push(row(base + i * 500, 'P.B', 't01', '10.9.9.8', 'T', 'ping', 'ok', 'x', 7));
    }
    writeLog('results-20261001.csv', lines);
    const res = await analyzeLog({ from: L(2026, 9, 1), to: L(2026, 9, 2), bucket: 'day', maxMs: 30 });
    assert.equal(res.truncated, true); // 12만 행을 30ms 에 못 끝낸다
    assert.ok(res.scannedRows < 120_000, `scannedRows=${res.scannedRows}`);
    // 예산 체크는 물리행 2,000행마다 — 초과폭은 배치 1회 처리 시간으로 유한하다
    assert.ok(res.elapsedMs < 2000, `elapsedMs=${res.elapsedMs}`);
  });
});

/* ── 인자 검증 ── */

test('인자 검증: from/to 필수, bucket 화이트리스트', async () => {
  await assert.rejects(() => analyzeLog({}), /from\/to/);
  await assert.rejects(() => analyzeLog({ from: 10, to: 5 }), /from\/to/);
  await assert.rejects(() => analyzeLog({ ...W1, bucket: 'decade' }), /bucket/);
});
