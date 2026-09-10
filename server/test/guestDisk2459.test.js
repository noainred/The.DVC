// 게스트 디스크 회수 리포트(v2.459) — 순수 분석 + DB diff-저장 왕복 + CSV 회귀 고정.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { vmSummary, rankReclaim, usageTrend, reclaimAdvice } from '../src/guestdisk/analyze.js';
import { reclaimCsv } from '../src/guestdisk/service.js';

test('vmSummary — 파티션 합·여유·비율', () => {
  const s = vmSummary([{ path: 'C:\\', capacityGB: 79.2, usedGB: 25.7 }, { path: 'D:\\', capacityGB: 20, usedGB: 4 }]);
  assert.equal(s.allocGB, 99.2);
  assert.equal(s.usedGB, 29.7);
  assert.equal(s.freeGB, 69.5);
  assert.equal(s.partCount, 2);
  assert.ok(Math.abs(s.ratioPct - 29.9) < 0.2);
  // 할당 0 이면 비율 null(추정하지 않는다)
  assert.equal(vmSummary([]).ratioPct, null);
});

test('rankReclaim — 여유 큰 순 정렬 + 잡음 컷 + 합계', () => {
  const rows = [
    { vmId: 'a', allocGB: 100, usedGB: 90 },   // free 10
    { vmId: 'b', allocGB: 100, usedGB: 20 },   // free 80
    { vmId: 'c', allocGB: 100, usedGB: 98 },   // free 2 (컷)
  ];
  const r = rankReclaim(rows, { minReclaimGB: 5 });
  assert.deepEqual(r.rows.map((x) => x.vmId), ['b', 'a']); // c 제외, 여유순
  assert.equal(r.vmCount, 2);
  assert.equal(r.totalReclaimGB, 90);
  assert.equal(r.rows[0].freeGB, 80);
});

test('usageTrend — 증가/평탄/근거부족', () => {
  const day = 86_400_000; const t0 = 1_700_000_000_000;
  const growing = usageTrend([{ ts: t0, usedGB: 10 }, { ts: t0 + 10 * day, usedGB: 30 }]);
  assert.equal(growing.trend, 'growing');
  assert.equal(growing.growthGBPerDay, 2);
  const flat = usageTrend([{ ts: t0, usedGB: 10 }, { ts: t0 + 10 * day, usedGB: 10.2 }]);
  assert.equal(flat.trend, 'flat');
  // 점 1개 = 근거 부족(null, 추정 안 함)
  const one = usageTrend([{ ts: t0, usedGB: 10 }]);
  assert.equal(one.trend, null);
  assert.equal(one.growthGBPerDay, null);
});

test('reclaimAdvice — 증가 추세는 보류, 평탄/감소는 축소 후보', () => {
  assert.equal(reclaimAdvice(50, 'growing').safe, false);
  assert.equal(reclaimAdvice(50, 'flat').safe, true);
  assert.equal(reclaimAdvice(50, 'shrinking').safe, true);
  assert.equal(reclaimAdvice(2, 'flat').safe, false);       // 여유가 작으면 해당 없음
  assert.equal(reclaimAdvice(50, null).safe, false);        // 추이 표본 부족
});

test('reclaimCsv — 헤더·BOM·수식 인젝션 가드', () => {
  const csv = reclaimCsv([{ vcenterName: 'vc1', vmName: '=cmd', allocGB: 100, usedGB: 20, freeGB: 80, ratioPct: 20, partCount: 2 }]);
  assert.ok(csv.startsWith('\ufeff'), 'BOM 이 있어야 엑셀 한글이 안 깨진다');
  assert.ok(csv.includes("'=cmd"), '수식 인젝션(=)은 접두 인용부호로 무력화');
  assert.ok(csv.includes('회수가능(GB)'));
});

test('DB diff-저장 왕복 — 변화분만 series 에 남고 latest 는 교체된다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-'));
  process.env.GUESTDISK_DB_PATH = path.join(dir, 'guest-disk.db');
  const db = await import(`../src/guestdisk/db.js?t=${Date.now()}`);
  const gdb = await db.getDb();
  if (!gdb) { console.warn('node:sqlite 없음 — DB 테스트 skip'); return; }

  const vc = 'vc-1';
  const mk = (used) => ([{ vmId: 'vc-1:vm-1', vmName: 'W1', allocGB: 100, usedGB: used, partCount: 1, parts: [{ path: 'C:\\', capGB: 100, usedGB: used }] }]);

  // 1회차 — 첫 관측이므로 series 1행.
  let r = await db.commitCollection(vc, 'VC One', mk(20), { ts: 1000, changeThresholdGB: 1 });
  assert.equal(r.vmSeriesRows, 1);
  assert.equal(r.partSeriesRows, 1);

  // 2회차 — 0.5GB 변화(threshold 1 미만) → series 미기록, latest 는 갱신.
  r = await db.commitCollection(vc, 'VC One', mk(20.5), { ts: 2000, changeThresholdGB: 1 });
  assert.equal(r.vmSeriesRows, 0, 'threshold 미만 변화는 추이 행을 남기지 않는다');
  let latest = await db.listLatest([vc]);
  assert.equal(latest.length, 1);
  assert.equal(latest[0].usedGB, 20.5, 'latest 는 매 수집 최신값으로 교체');

  // 3회차 — 5GB 변화 → series 기록.
  r = await db.commitCollection(vc, 'VC One', mk(25.7), { ts: 3000, changeThresholdGB: 1 });
  assert.equal(r.vmSeriesRows, 1);
  const vs = await db.vmSeries('vc-1:vm-1');
  assert.deepEqual(vs.map((x) => x.usedGB), [20, 25.7], '기록된 추이는 첫 관측 + 유의미 변화만');

  // prune — 아주 짧은 보존이면 오래된 행 삭제.
  const pr = await db.prune(0.00001);
  assert.ok(pr.ok);
  fs.rmSync(dir, { recursive: true, force: true });
});
