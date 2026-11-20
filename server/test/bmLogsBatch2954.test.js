/**
 * v2.954(점검 C-1 · C-2) — 7a 로그 적재 · 보관 정리가 이벤트 루프를 한 번에 붙잡지 않는다.
 *   C-1: 적재는 서버 단위 원자(커서 비교 후 쓰기 + 패턴 · 시간 · 보안이 같이)로 묶음 트랜잭션 · 묶음 사이 양보 —
 *        중간 묶음이 실패해도 앞 묶음(커밋됨)은 writtenKeys 로 알리고, 실패한 서버는 커서까지 통째로 빠진다.
 *   C-2: 보관 정리는 공용 chunkedDelete(청크 사이 setImmediate).
 *   수정 전 판본은 서버 전부를 한 동기 트랜잭션으로 써서(양보 0 · 실패 시 written 0) 아래 ① ② ③ 이 실패한다.
 * 기준 시각: 정시 −30분(실제 시각에서 떨어뜨려 고정).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bmlog2954-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'false';
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
let sqlite = true; try { await import('node:sqlite'); } catch { sqlite = false; }
const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;
const H0 = Math.floor(NOW / HOUR) * HOUR;

const S = sqlite ? await import('../src/bmusage/logs/store.js') : null;
const { mainDb } = sqlite ? await import('../src/bmusage/db.js') : {};

function item(key, { pats = 10, hours = 2, readRev = null } = {}) {
  const patterns = []; const hrs = [];
  for (let p = 0; p < pats; p++) {
    const sig = `${key}-${p}`.padStart(16, '0').slice(-16);
    patterns.push({ sig, cls: 'issue', severity: 'low', ruleId: '', src: 'messages', unit: 'x', tmpl: `t${p}`, count: 2, first: NOW - 1000, last: NOW, samples: [{ ts: NOW, text: `s${p}` }] });
    for (let h = 0; h < hours; h++) hrs.push({ hour: H0 - h * HOUR, sig, cls: 'issue', count: 1 });
  }
  return { key, readRev, at: NOW, state: { pos: {} }, status: {}, patterns, hours: hrs, sec: [{ hour: H0, kind: 'fail_ip', item: '10.0.0.1', count: 1 }] };
}
/** fn 이 끝나기 전에 setImmediate 가 몇 번 돌았는가(양보 횟수의 하한). */
async function immediateTicksDuring(fn) {
  let done = false; let ticks = 0;
  const loop = () => { if (done) return; ticks += 1; setImmediate(loop); };
  const p = fn();
  setImmediate(loop);
  const r = await p; done = true;
  return { r, ticks };
}

test('① C-1 — 적재가 묶음 사이에 양보한다(서버 전부를 한 동기 구간으로 쓰지 않는다) · 결과는 그대로', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  await mainDb();   // 열기는 시험 밖에서(열기의 비동기 대기를 양보로 세지 않게)
  const items = Array.from({ length: 120 }, (_, i) => item(`Y${i}`, { pats: 15, hours: 3 }));
  const { r, ticks } = await immediateTicksDuring(() => S.logWriteBatch({ agent: 'ag-y', items, sliceMs: 1 }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.written, 120); assert.equal(r.writtenKeys.length, 120);
  assert.ok(r.batches > 1, `묶음이 나뉘어야 한다: ${r.batches}`);
  assert.ok(ticks >= 2, `적재 도중 이벤트 루프가 돌아야 한다(setImmediate ${ticks}회)`);
  const db = await mainDb();
  assert.equal(db.prepare("SELECT COUNT(*) c FROM log_cursor WHERE agent='ag-y'").get().c, 120);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM log_hour WHERE agent='ag-y'").get().c, 120 * 15 * 3);
});

test('② C-1 — 서버 단위 원자: 중간 서버가 실패하면 그 묶음만 되돌리고 앞 묶음(커밋)은 writtenKeys 로 알린다 · 실패 서버는 커서까지 빠진다', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  const items = [item('A0'), item('A1'), item('A2'), { ...item('A3'), patterns: 5 /* 순회 불가 — 커서를 쓴 뒤 던진다 */ }, item('A4')];
  const r = await S.logWriteBatch({ agent: 'ag-a', items, sliceMs: 0 });   // 0 = 서버마다 묶음 경계
  assert.equal(r.ok, false);
  assert.deepEqual(r.writtenKeys, ['A0', 'A1', 'A2'], JSON.stringify(r));
  assert.equal(r.written, 3);
  const cur = await S.logCursorsAll({ agent: 'ag-a' });
  assert.deepEqual([...cur.keys()].sort(), ['A0', 'A1', 'A2'], 'A3 은 커서를 쓴 뒤 던졌다 — 그 서버 전체가 되돌려져야 한다(다음 주기에 같은 줄을 다시 읽는다)');
  // 비교 후 쓰기의 의미는 그대로 — 옛 rev 로 다시 쓰면 그 서버를 통째로 건너뛴다
  const again = await S.logWriteBatch({ agent: 'ag-a', items: [item('A0', { readRev: 0 }), item('A3')], sliceMs: 0 });
  assert.equal(again.ok, true); assert.equal(again.conflicts, 1); assert.deepEqual(again.writtenKeys, ['A3']);
});

test('③ C-2 — 보관 정리는 청크 사이에 양보하고 같은 행을 지운다', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  const db = await mainDb();
  const ins = db.prepare('INSERT INTO log_hour (agent,key,hour,sig,cls,count) VALUES (?,?,?,?,?,1)');
  db.exec('BEGIN');
  for (let i = 0; i < 7_000; i++) ins.run('ag-p', `P${i % 50}`, H0 - 40 * 24 * HOUR - (i % 24) * HOUR, `sig${i}`, 'issue');
  db.exec('COMMIT');
  const before = db.prepare("SELECT COUNT(*) c FROM log_hour WHERE agent='ag-p'").get().c;
  assert.equal(before, 7_000);
  const { r, ticks } = await immediateTicksDuring(() => S.logPrune({ before: H0 - 30 * 24 * HOUR, agent: 'ag-p' }));
  assert.ok(r.hours >= 7_000, JSON.stringify(r));
  assert.equal(db.prepare("SELECT COUNT(*) c FROM log_hour WHERE agent='ag-p'").get().c, 0);
  assert.ok(ticks >= 2, `정리 도중 이벤트 루프가 돌아야 한다(setImmediate ${ticks}회)`);
});
