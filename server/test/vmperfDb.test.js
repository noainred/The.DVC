// vCenter별 독립 VM 성능 DB 검증(v2.376) — 파일 분리·조회·롤업·prune·삭제 회수·LRU.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vmperf-'));
process.env.VMPERF_DB_DIR = path.join(tmp, 'vmperf');
process.env.VMPERF_MAX_OPEN_DB = '3';   // LRU 검증을 위해 작게

const sqliteOk = await import('node:sqlite').then(() => true).catch(() => false);
const db = await import('../src/metrics/vmperfDb.js');

const HOUR = 3_600_000;
const rowsFor = (vc, cpuAlloc, cpuUsed) => ([
  { metric: 'vm_cpu_alloc_mhz', k: vc, v: cpuAlloc },
  { metric: 'vm_cpu_used_mhz', k: vc, v: cpuUsed },
]);

test('vCenter별로 파일이 분리되고 조회가 그 DB만 본다', { skip: !sqliteOk ? 'node:sqlite 미지원' : false }, async () => {
  const t0 = Date.now() - 5 * HOUR;
  for (let i = 0; i < 5; i++) {
    await db.insertVmperf('vc-a', rowsFor('vc-a', 20000, 2000 + i * 100), t0 + i * HOUR);
    await db.insertVmperf('vc-b', rowsFor('vc-b', 8000, 6000), t0 + i * HOUR);
  }
  const dir = process.env.VMPERF_DB_DIR;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.db')).sort();
  assert.deepEqual(files, ['vc-a.db', 'vc-b.db'], 'vCenter 당 파일 1개');

  const a = await db.vmperfHistory('vc-a', 'vm_cpu_used_mhz', t0 - HOUR, HOUR, 100);
  assert.ok(a.length >= 5, `vc-a 포인트 ${a.length}`);
  // vc-a 값(2000~2400)만 보여야 한다 — vc-b(6000)가 섞이면 분리 실패.
  assert.ok(a.every((p) => p.avg >= 2000 && p.avg <= 2400), `vc-a 값 범위: ${a.map((p) => p.avg).join(',')}`);

  const b = await db.vmperfHistory('vc-b', 'vm_cpu_used_mhz', t0 - HOUR, HOUR, 100);
  assert.ok(b.every((p) => p.avg === 6000), `vc-b 값: ${b.map((p) => p.avg).join(',')}`);
});

test('전체 합계는 _all.db 로 분리 저장된다', { skip: !sqliteOk ? 'node:sqlite 미지원' : false }, async () => {
  const ts = Date.now();
  await db.insertVmperf('', [{ metric: 'vm_cpu_alloc_mhz', k: '', v: 28000 }], ts);
  assert.ok(fs.existsSync(path.join(process.env.VMPERF_DB_DIR, '_all.db')), '_all.db 생성');
  const pts = await db.vmperfHistory('', 'vm_cpu_alloc_mhz', ts - HOUR, HOUR, 10);
  assert.equal(pts.at(-1)?.avg, 28000);
});

test('파일명 sanitize — 경로 조작 차단', () => {
  assert.equal(db.dbFileName('vc-eu-central'), 'vc-eu-central');
  assert.equal(db.dbFileName(''), '_all');
  assert.ok(!db.dbFileName('../../etc/passwd').includes('/'), '슬래시 제거');
  assert.ok(!db.dbFileName('..\\win').includes('\\'), '백슬래시 제거');
  assert.equal(db.dbFileName('a:b*c?'), 'a_b_c_', 'OS 금지문자 치환');
});

test('prune 이 보존기간 밖 행을 지운다(0 이면 무제한)', { skip: !sqliteOk ? 'node:sqlite 미지원' : false }, async () => {
  const old = Date.now() - 40 * 86_400_000;   // 40일 전
  await db.insertVmperf('vc-p', rowsFor('vc-p', 1000, 500), old);
  await db.insertVmperf('vc-p', rowsFor('vc-p', 1000, 500), Date.now());
  // vmperfMeta 는 metric 단위 count(기본 vm_cpu_alloc_mhz) → 40일전 1 + 최근 1 = 2행.
  const before = await db.vmperfMeta('vc-p');
  assert.equal(before.count, 2, 'metric 당 2행(40일전·최근)');

  assert.equal(await db.pruneVmperf('vc-p', 0), 0, '0 = 무제한(삭제 없음)');
  assert.equal((await db.vmperfMeta('vc-p')).count, 2);

  // rowsFor 가 메트릭 2종을 넣으므로 40일 전 시점의 삭제 행은 2행이다(전체 테이블 기준).
  const removed = await db.pruneVmperf('vc-p', 7);   // 7일 보존 → 40일 전 행 삭제
  assert.equal(removed, 2, `삭제 ${removed}행(메트릭 2종 × 1시점)`);
  assert.equal((await db.vmperfMeta('vc-p')).count, 1, '최근 시점만 남음');
});

test('제외 시 파일 삭제로 용량을 회수한다', { skip: !sqliteOk ? 'node:sqlite 미지원' : false }, async () => {
  const ts = Date.now();
  await db.insertVmperf('vc-drop', rowsFor('vc-drop', 5000, 100), ts);
  const p = path.join(process.env.VMPERF_DB_DIR, 'vc-drop.db');
  assert.ok(fs.existsSync(p), '생성됨');
  const usageBefore = db.vmperfDiskUsage().find((u) => u.vcenterId === 'vc-drop');
  assert.ok(usageBefore && usageBefore.bytes > 0, `사용량 측정 ${usageBefore?.bytes}B`);

  const removed = db.dropVmperfDb('vc-drop');
  assert.ok(removed >= 1, `파일 ${removed}개 삭제`);
  assert.equal(fs.existsSync(p), false, '파일이 실제로 사라짐(용량 회수)');
  assert.equal(db.vmperfDiskUsage().some((u) => u.vcenterId === 'vc-drop'), false);
});

test('LRU 로 동시 오픈 핸들이 상한을 넘지 않는다', { skip: !sqliteOk ? 'node:sqlite 미지원' : false }, async () => {
  const ts = Date.now();
  for (const vc of ['l1', 'l2', 'l3', 'l4', 'l5']) await db.insertVmperf(vc, rowsFor(vc, 100, 10), ts);
  // 상한 3(env) 을 넘겨 열었어도, 닫힌 DB 를 다시 조회하면 재오픈되어 값이 그대로 읽혀야 한다.
  const pts = await db.vmperfHistory('l1', 'vm_cpu_alloc_mhz', ts - HOUR, HOUR, 10);
  assert.equal(pts.at(-1)?.avg, 100, 'LRU 로 닫혔던 DB 재오픈 후 데이터 보존');
});
