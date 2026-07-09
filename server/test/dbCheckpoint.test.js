import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { checkpointConfigDbs } = await import('../src/upgrade/dbCheckpoint.js');

test('checkpointConfigDbs: WAL DB를 체크포인트해 -wal을 비우고 데이터는 보존', async () => {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); }
  catch { return; } // node:sqlite 미사용 환경이면 스킵(폴백 경로는 별도 검증).

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-'));
  const dbPath = path.join(dir, 'idrac-power.db');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec('CREATE TABLE t (v INTEGER);');
  for (let i = 0; i < 200; i++) db.exec(`INSERT INTO t (v) VALUES (${i});`);
  // 커밋됐지만 아직 본 .db로 병합 전 — -wal 파일이 존재해야 한다.
  assert.ok(fs.existsSync(`${dbPath}-wal`), '체크포인트 전에는 -wal 존재');
  const walBefore = fs.statSync(`${dbPath}-wal`).size;
  assert.ok(walBefore > 0, '-wal에 미반영 페이지 있음');

  // 주 커넥션은 열린 채로(라이브 상황 재현) 별도 커넥션이 체크포인트.
  const r = await checkpointConfigDbs(dir);
  assert.equal(r.ok, true);
  assert.ok(r.checkpointed.includes('idrac-power.db'), '해당 DB가 체크포인트됨');

  // TRUNCATE 체크포인트 후 -wal은 0바이트(또는 제거)여야 하고 데이터는 온전해야 한다.
  const walAfter = fs.existsSync(`${dbPath}-wal`) ? fs.statSync(`${dbPath}-wal`).size : 0;
  assert.ok(walAfter < walBefore, '-wal이 줄어듦(플러시)');
  const n = db.prepare('SELECT COUNT(*) AS n FROM t').get().n;
  assert.equal(n, 200, '데이터 보존');
  db.close();

  // 체크포인트 후의 .db만 복사해도 자기완결적인지: 사본을 새 커넥션으로 열어 200행 확인.
  const copy = path.join(dir, 'copy.db');
  fs.copyFileSync(dbPath, copy);
  const db2 = new DatabaseSync(copy);
  assert.equal(db2.prepare('SELECT COUNT(*) AS n FROM t').get().n, 200, '.db 단독 복사본도 정합');
  db2.close();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
});

test('checkpointConfigDbs: ipam.db는 제외, -wal 없는 DB는 건너뜀', async () => {
  try { await import('node:sqlite'); } catch { return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt2-'));
  fs.writeFileSync(path.join(dir, 'ipam.db'), 'x');       // 대상 아님
  fs.writeFileSync(path.join(dir, 'nowal.db'), 'x');      // -wal 없음 → 건너뜀
  const r = await checkpointConfigDbs(dir);
  assert.equal(r.ok, true);
  assert.ok(!r.checkpointed.includes('ipam.db'));
  assert.ok(!r.checkpointed.includes('nowal.db'));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
});
