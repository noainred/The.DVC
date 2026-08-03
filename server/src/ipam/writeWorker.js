/**
 * IPAM 레저 쓰기 워커 — 대량 SQLite 적재를 메인 이벤트 루프 밖에서 수행한다.
 *
 * 왜 필요한가: 레저 동기화는 스냅샷 전체를 갈아엎는다(DELETE + 수천 행 INSERT).
 * 트랜잭션으로 묶어 fsync 는 1회로 줄였지만, **바인딩·INSERT 자체가 동기 CPU 작업**이라
 * 5,850 VM 규모에서는 그 시간 동안 메인 스레드가 멈춘다(HTTP 응답·다른 vCenter 수집이 밀림).
 * node:sqlite 는 동기 API 뿐이므로, 스레드를 옮기는 것 말고는 비블로킹으로 만들 방법이 없다.
 *
 * 규칙
 * - 이 워커만 쓰기를 한다(메인 스레드는 폴백일 때만). 두 연결이 동시에 쓰면 SQLITE_BUSY 가 난다.
 * - 스키마는 만들지 않는다 — 메인 스레드 초기화가 끝난 뒤에만 생성되므로 테이블은 이미 있다.
 * - `ipam.db` 는 외부 프로그램이 직접 읽는 공유 파일이라 저널 모드를 바꾸지 않는다(WAL 금지).
 */

import { parentPort, workerData } from 'node:worker_threads';
// eslint-disable-next-line import/no-unresolved
import { DatabaseSync } from 'node:sqlite';
import { COLUMNS, toRecord } from './record.js';

const db = new DatabaseSync(workerData.dbPath);
// 메인 스레드 리더(info 조회)와 겹치면 즉시 실패하지 않고 기다린다.
try { db.exec('PRAGMA busy_timeout=3000;'); } catch { /* 구버전 폴백 */ }

const del = db.prepare('DELETE FROM ip_records');
const ins = db.prepare(`INSERT INTO ip_records (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`);

parentPort.on('message', ({ id, rows, updatedAt }) => {
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      del.run();
      for (const row of rows) ins.run(...toRecord(row, updatedAt));
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    }
    parentPort.postMessage({ id, ok: true, count: rows.length });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: err.message });
  }
});
