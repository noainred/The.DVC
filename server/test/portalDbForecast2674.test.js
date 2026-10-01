// v2.674 — 포탈 DB 용량 예측: 표본이 재시작에도 이어지고, 일 표본 기울기로 1일·1주·1개월·6개월·1년을 낸다.
// 사용자 신고: "1개월 후·6개월 후·1년 후가 안 나온다"(재시작마다 메모리 표본이 지워져 관측 1시간을 못 넘겼다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-portaldb2674-'));
process.env.CONFIG_DIR = dir;
const DB = path.join(dir, 'host-temp.db');
const HIST = path.join(dir, 'portal-db-size-history.json');
const DAY = 86_400_000;
const m = await import('../src/insights/portalDb.js');
const GB = 1024 ** 3;
const rowOf = (r) => r.files.find((f) => f.file === 'host-temp.db');

test('① 저장된 일 표본(10일 · 하루 +1GB)이 재시작 뒤에도 읽혀 예측이 바로 나온다', () => {
  fs.writeFileSync(DB, ''); fs.truncateSync(DB, 50 * GB);   // 희소 파일 — 크기만 일 표본과 맞춘다(디스크를 쓰지 않는다)
  const now = Date.now();
  const daily = Array.from({ length: 10 }, (_, i) => [now - (10 - i) * DAY, (40 + i) * GB]);
  fs.writeFileSync(HIST, JSON.stringify({ v: 1, recent: {}, daily: { [DB]: daily } }));
  m._resetDbSizeHistoryForTest();
  m.recordDbSizeSample(now, { persist: false });
  const r = m.portalDbReport(now);
  const t = rowOf(r).trend;
  assert.equal(t.basis, 'daily');
  assert.equal(t.forecast.available, true, t.forecast.reason);
  for (const k of ['in1d', 'in1w', 'in1m', 'in6m', 'in1y']) assert.ok(Number.isFinite(t.forecast[k]), k);
  assert.equal(r.totalForecast.available, true);
  assert.ok(Number.isFinite(r.perDayTotalBytes));
});

test('② 일 표본 기울기는 최근 30일 최소제곱 — 하루 +1GB 면 1주 뒤 +7GB', () => {
  const now = Date.now();
  const daily = Array.from({ length: 40 }, (_, i) => [now - (40 - i) * DAY, (10 + i) * GB]);
  fs.writeFileSync(HIST, JSON.stringify({ v: 1, recent: {}, daily: { [DB]: daily } }));
  m._resetDbSizeHistoryForTest();
  const r = m.portalDbReport(now);   // 표본을 새로 찍지 않는다 — 저장분만으로 계산
  const t = rowOf(r).trend;
  assert.equal(t.basis, 'daily');
  assert.ok(Math.abs(t.perDayBytes - GB) < GB * 0.01, `일 증가 ${t.perDayBytes}`);
  // 출발점은 지금 실제 파일 크기(이 테스트에서는 수 KB) — 1주 뒤는 그 위에 +7GB
  const size = rowOf(r).sizeBytes;
  assert.ok(Math.abs(t.forecast.in1w - (size + 7 * GB)) < GB * 0.1, `1주 ${t.forecast.in1w}`);
  assert.ok(Math.abs(t.forecast.in1d - (size + GB)) < GB * 0.05, `1일 ${t.forecast.in1d}`);
  assert.equal(t.forecast.confidence, 'high');
});

test('③ 표본은 파일에 남는다 — 기록 후 다시 읽어도 이어진다(재시작 시뮬레이션)', () => {
  fs.rmSync(HIST, { force: true });
  m._resetDbSizeHistoryForTest();
  const t0 = Date.now() - 2 * 3_600_000;
  m.recordDbSizeSample(t0);
  fs.writeFileSync(DB, Buffer.alloc(4096));
  m.recordDbSizeSample(t0 + 2 * 3_600_000);
  assert.ok(fs.existsSync(HIST));
  m._resetDbSizeHistoryForTest();   // 메모리를 비운다(= 재시작)
  const t = rowOf(m.portalDbReport()).trend;
  assert.equal(t.basis, 'recent');
  assert.equal(t.forecast.available, true, '재시작 뒤에도 2시간 관측이 남아야 한다');
});

test('④ 관측 1시간 미만이면 숫자를 지어내지 않고 남은 시간을 말한다', () => {
  fs.rmSync(HIST, { force: true });
  m._resetDbSizeHistoryForTest();
  const now = Date.now();
  m.recordDbSizeSample(now - 30 * 60_000, { persist: false });
  m.recordDbSizeSample(now, { persist: false });
  const r = m.portalDbReport(now);
  const t = rowOf(r).trend;
  assert.equal(t.perDayBytes, null, '30분 차이를 하루로 늘린 값은 내지 않는다');
  assert.equal(t.forecast.available, false);
  assert.match(t.forecast.reason, /30분 — 1시간 이상 필요\(약 30분 뒤 표시\)/);
  assert.equal(r.perDayTotalBytes, null);
});

test('⑤ 손상된 표본 파일은 .corrupt 로 보존하고 새로 시작한다', () => {
  fs.writeFileSync(HIST, '{"v":1,"daily":{');
  m._resetDbSizeHistoryForTest();
  m.recordDbSizeSample(Date.now(), { persist: false });
  assert.ok(fs.readdirSync(dir).some((n) => n.startsWith('portal-db-size-history.json.corrupt')), fs.readdirSync(dir).join(','));
});

test('⑥ 표본 파일은 상태 파일이다(백업 변경 감시 제외)', async () => {
  const { isRuntimeStateFile } = await import('../src/backup/service.js');
  assert.equal(isRuntimeStateFile('portal-db-size-history.json'), true);
});

test('⑦ 정리·VACUUM 으로 크게 줄면 그 앞 표본은 쓰지 않고, 감소 추세라도 예측은 0 B 가 아니라 현재 크기다', () => {
  const now = Date.now();
  // 20일 동안 40GB→59GB 로 늘다가 5일 전 VACUUM 으로 10GB, 이후 하루 +0.2GB
  const daily = [
    ...Array.from({ length: 20 }, (_, i) => [now - (25 - i) * DAY, (40 + i) * GB]),
    ...Array.from({ length: 5 }, (_, i) => [now - (5 - i) * DAY, (10 + 0.2 * i) * GB]),
  ];
  fs.writeFileSync(HIST, JSON.stringify({ v: 1, recent: {}, daily: { [DB]: daily } }));
  fs.truncateSync(DB, Math.round(11 * GB));
  m._resetDbSizeHistoryForTest();
  const t = rowOf(m.portalDbReport(now)).trend;
  assert.ok(t.perDayBytes > 0 && Math.abs(t.perDayBytes - 0.2 * GB) < 0.02 * GB, `급감 뒤 기울기만 — ${t.perDayBytes}`);
  // 계속 줄어드는 경우: 예측은 현재 크기(0 B 가 아니다)
  const shrink = Array.from({ length: 10 }, (_, i) => [now - (10 - i) * DAY, (20 - 0.5 * i) * GB]);
  fs.writeFileSync(HIST, JSON.stringify({ v: 1, recent: {}, daily: { [DB]: shrink } }));
  fs.truncateSync(DB, Math.round(15.4 * GB));
  m._resetDbSizeHistoryForTest();
  const r2 = m.portalDbReport(now); const t2 = rowOf(r2).trend;
  assert.equal(t2.forecast.shrinking, true);
  assert.equal(t2.forecast.in1y, rowOf(r2).sizeBytes, '감소 추세면 1년 후도 지금 크기');
});
