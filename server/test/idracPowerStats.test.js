import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idrac-pw-'));
process.env.CONFIG_DIR = tmp;

let db;
before(async () => { const m = await import('../src/idrac/db.js'); db = await m.getDb(); });
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

test('statsSince: 서버별 24h 피크/평균/최소/마지막', () => {
  const base = 1_000_000_000_000;
  db.insert('srv1', 100, base + 1000);
  db.insert('srv1', 300, base + 2000);
  db.insert('srv1', 200, base + 3000);
  db.insert('srv2', 50, base + 1500);
  const m = db.statsSince(base);
  assert.equal(m.get('srv1').peak, 300);
  assert.equal(m.get('srv1').min, 100);
  assert.equal(m.get('srv1').avg, 200);
  assert.equal(m.get('srv1').last, base + 3000);
  assert.equal(m.get('srv1').count, 3);
  assert.equal(m.get('srv2').avg, 50);
});

test('statsSince: sinceTs 이전 샘플은 제외', () => {
  const base = 2_000_000_000_000;
  db.insert('srvA', 999, base - 10_000); // 윈도우 밖
  db.insert('srvA', 100, base + 1000);
  db.insert('srvA', 200, base + 2000);
  const m = db.statsSince(base);
  assert.equal(m.get('srvA').peak, 200); // 999 제외
  assert.equal(m.get('srvA').avg, 150);
});

test('serverIds/deleteServers: 고아 server_id 삭제(활성 보존)', () => {
  const base = 4_000_000_000_000;
  db.insert('keep1', 100, base + 1);
  db.insert('orphanA', 100, base + 1);
  db.insert('orphanB', 100, base + 1);
  const ids = db.serverIds();
  assert.ok(ids.includes('keep1') && ids.includes('orphanA') && ids.includes('orphanB'));
  const removed = db.deleteServers(['orphanA', 'orphanB']);
  assert.equal(removed >= 2, true);
  const after = db.serverIds();
  assert.ok(after.includes('keep1'));
  assert.ok(!after.includes('orphanA') && !after.includes('orphanB'));
});

test('bucketsSince: 시간 버킷별 서버 평균', () => {
  const base = 3_000_000_000_000;
  const H = 3_600_000;
  const b0 = Math.floor((base) / H) * H;
  db.insert('srvB', 100, b0 + 1000);
  db.insert('srvB', 200, b0 + 2000);       // 같은 버킷 → 평균 150
  db.insert('srvB', 400, b0 + H + 1000);   // 다음 버킷 → 400
  const rows = db.bucketsSince(base - H, H).filter((r) => r.serverId === 'srvB').sort((a, z) => a.bucket - z.bucket);
  assert.equal(rows.length, 2);
  assert.equal(Math.round(rows[0].avg), 150);
  assert.equal(Math.round(rows[1].avg), 400);
});
