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
 *
 * 메시지(v2.732 B6-04 — 큰 원장은 메인이 조각으로 보낸다):
 *   { id, chunk: records[] }            조각 — **메모리에만** 모은다(트랜잭션을 열지 않는다)
 *   { id, commit: true, total }         모은 조각 전체를 한 트랜잭션으로 BEGIN IMMEDIATE·DELETE·INSERT·COMMIT
 *                                       (개수가 total 과 다르면 쓰지 않고 실패로 답한다 — 일부만 쓴 원장을 남기지 않는다)
 *   { id, abort: true }                 모으던 조각을 버린다(메인이 보내다 실패했다 — 답하지 않는다)
 *   { id, records } · { id, rows, updatedAt }   예전 한 번 메시지(작은 원장·옛 호출 — 그대로 받는다)
 *   ⚠ 첫 조각에서 트랜잭션을 열지 말 것: 메인이 양보하며 조각을 다 보낼 때까지 RESERVED 잠금을 쥐고, 캐시가 넘치면 EXCLUSIVE 로
 *     외부 리더까지 막는다. commit 에서만 쓰면 트랜잭션 길이가 예전(한 번 메시지)과 같다.
 */

import { parentPort, workerData } from 'node:worker_threads';
// eslint-disable-next-line import/no-unresolved
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { COLUMNS, toRecord } from './record.js';

const db = new DatabaseSync(workerData.dbPath);
// v2.535 감사: `ipam/db.js` 는 파일 권한 0600 을 거는데 이 워커는 걸지 않아, **둘 중 먼저 연
// 쪽이 권한을 정하는 경합**이었다(워커가 먼저면 umask 기본값으로 남는다). ipam.db 는 자격증명이
// 아니라 IP 인벤토리지만, 같은 파일을 두 곳이 만드는데 한쪽만 권한을 거는 것은 규칙 위반이다.
// best-effort — 실패가 동기화를 막지 않는다(db.js 와 같은 처리).
try { fs.chmodSync(workerData.dbPath, 0o600); } catch { /* best effort */ }
// 메인 스레드 리더(info 조회)와 겹치면 즉시 실패하지 않고 기다린다.
try { db.exec('PRAGMA busy_timeout=3000;'); } catch { /* 구버전 폴백 */ }

const del = db.prepare('DELETE FROM ip_records');
const ins = db.prepare(`INSERT INTO ip_records (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`);

/** 한 트랜잭션으로 원장을 갈아엎는다. records = 레코드 배열(컬럼 순서 값) 또는 rows + updatedAt(옛 호출). */
function replaceAll(records, rows, updatedAt) {
  db.exec('BEGIN IMMEDIATE');
  try {
    del.run();
    // v2.594: 메인이 레코드(컬럼 순서 값)를 보낸다. rows 는 예전 호출 호환용.
    if (Array.isArray(records)) for (const rec of records) ins.run(...rec);
    else for (const row of rows) ins.run(...toRecord(row, updatedAt));
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
}

// v2.732 B6-04: 조각 스트림 버퍼(id → 레코드 배열). 메인이 한 번에 한 스트림만 보낸다(syncLedger 직렬화) — 다른 id 의 버퍼가 남아 있으면
//   끝나지 않은 옛 스트림(abort 를 못 받았다)이므로 버리고 그 개수를 다음 답에 싣는다(메모리에 원장 두 벌이 남지 않게).
const streams = new Map();
let staleDropped = 0;

parentPort.on('message', (msg) => {
  const { id } = msg || {};
  if (msg && Array.isArray(msg.chunk)) {
    let buf = streams.get(id);
    if (!buf) {
      for (const k of streams.keys()) { streams.delete(k); staleDropped++; }
      buf = [];
      streams.set(id, buf);
    }
    for (const rec of msg.chunk) buf.push(rec);
    return;
  }
  if (msg && msg.abort) { streams.delete(id); return; }
  if (msg && msg.commit) {
    const buf = streams.get(id) || [];
    streams.delete(id);
    const dropped = staleDropped; staleDropped = 0;
    if (buf.length !== msg.total) {
      parentPort.postMessage({ id, ok: false, error: `원장 조각 수 불일치(받음 ${buf.length} · 기대 ${msg.total}) — 쓰지 않았습니다` });
      return;
    }
    try {
      replaceAll(buf, null, null);
      parentPort.postMessage({ id, ok: true, count: buf.length, ...(dropped ? { staleDropped: dropped } : {}) });
    } catch (err) {
      parentPort.postMessage({ id, ok: false, error: err.message });
    }
    return;
  }
  const { rows, records, updatedAt } = msg || {};
  try {
    replaceAll(records, rows, updatedAt);
    parentPort.postMessage({ id, ok: true, count: (records || rows).length });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: err.message });
  }
});
