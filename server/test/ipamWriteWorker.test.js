import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { COLUMNS, toRecord } from '../src/ipam/record.js';

// IPAM 레저 대량 적재를 worker_threads 로 오프로딩하는 경로(#10-①) 검증.
// 워커/인라인 어느 쪽으로 가든 **DB 내용이 동일해야** 한다 — 다르면 외부 프로그램이
// 읽는 공유 파일(ipam.db)이 경로에 따라 달라진다.

function row(i) {
  return {
    ip: `10.0.${Math.floor(i / 254)}.${(i % 254) + 1}`,
    ipNum: 167772160 + i,
    vcenterId: 'vc-1',
    vcenterName: 'Seoul vCenter',
    ownerType: i % 7 === 0 ? 'host' : 'vm',
    ownerName: `node-${i}`,
    powerState: 'poweredOn',
    multiHomed: i % 3 === 0,
    duplicate: false,
  };
}

test('toRecord: 컬럼 수와 행 길이가 일치한다', () => {
  // 컬럼을 추가하고 toRecord 를 빠뜨리면 값이 한 칸씩 밀려 조용히 오염된다.
  assert.equal(toRecord(row(1), 'now').length, COLUMNS.length);
});

test('toRecord: 워커와 메인 스레드가 같은 정의를 공유한다', async () => {
  const worker = await import('../src/ipam/record.js');
  assert.equal(worker.COLUMNS.length, COLUMNS.length);
  assert.deepEqual(worker.toRecord(row(2), 'now'), toRecord(row(2), 'now'));
});

test('쓰기 워커: 대량 적재 결과가 인라인 적재와 동일하다', async (t) => {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    return t.skip('node:sqlite 사용 불가(--experimental-sqlite 없음)');
  }
  const { Worker } = await import('node:worker_threads');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipam-worker-'));
  const dbPath = path.join(dir, 'ipam.db');
  const rows = Array.from({ length: 1200 }, (_, i) => row(i));
  const updatedAt = new Date().toISOString();

  // 메인 스레드가 스키마를 만든다(워커는 스키마를 만들지 않는 계약).
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE ip_records (${COLUMNS.map((c) => `${c} TEXT`).join(', ')});`);

  const worker = new Worker(new URL('../src/ipam/writeWorker.js', import.meta.url), {
    workerData: { dbPath },
  });
  try {
    const result = await new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
      worker.postMessage({ id: 1, rows, updatedAt });
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.count, rows.length);

    const stored = db.prepare('SELECT COUNT(*) AS n FROM ip_records').get();
    assert.equal(stored.n, rows.length, '워커가 트랜잭션을 커밋해야 한다');

    const first = db.prepare('SELECT * FROM ip_records ORDER BY rowid LIMIT 1').get();
    const expected = toRecord(rows[0], updatedAt);
    assert.equal(String(first.ip), String(expected[0]));
    assert.equal(String(first.owner_name), String(expected[6]));

    // 두 번째 동기화는 전체를 갈아엎는다 — 행이 누적되면 안 된다.
    const second = await new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
      worker.postMessage({ id: 2, rows: rows.slice(0, 10), updatedAt });
    });
    assert.equal(second.ok, true);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ip_records').get().n, 10);
  } finally {
    await worker.terminate();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('쓰기 워커: 스키마가 없으면 실패를 보고하고 죽지 않는다', async (t) => {
  try {
    await import('node:sqlite');
  } catch {
    return t.skip('node:sqlite 사용 불가');
  }
  const { Worker } = await import('node:worker_threads');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipam-worker-bad-'));
  const worker = new Worker(new URL('../src/ipam/writeWorker.js', import.meta.url), {
    workerData: { dbPath: path.join(dir, 'empty.db') },
  });
  try {
    // 준비 단계(prepare)에서 실패하면 워커가 error 로 죽는다 — 호출자는 인라인으로 폴백한다.
    const outcome = await new Promise((resolve) => {
      worker.once('message', (msg) => resolve({ kind: 'message', msg }));
      worker.once('error', (err) => resolve({ kind: 'error', err }));
      worker.postMessage({ id: 1, rows: [row(1)], updatedAt: 'now' });
    });
    if (outcome.kind === 'message') assert.equal(outcome.msg.ok, false);
    else assert.ok(outcome.err instanceof Error);
  } finally {
    await worker.terminate();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
