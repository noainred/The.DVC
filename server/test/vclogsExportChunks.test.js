import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 저장소 server/config 오염 방지 — import 전에 CONFIG_DIR 고정.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vclogs-chunk-'));
process.env.CONFIG_DIR = tmp;

let db;
before(async () => {
  const { getLogsDb } = await import('../src/logs/db.js');
  db = await getLogsDb();
  assert.equal(db.kind, 'sqlite', '테스트 환경은 node:sqlite 전제');
});
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

test('로그 청크 페이징: ts 동률이 많아도 청크 합집합 = 전체 조회(중복/누락 없음)', async () => {
  // CSV 청크 내보내기(20k 단위 OFFSET)가 전제하는 성질 — ORDER BY ts 만으로는 동률에서
  // 비결정적이라 rowid 타이브레이커를 붙였다. 동률 ts 를 대량으로 만들어 검증한다.
  const T = Date.now() - 3600_000;
  const rows = [];
  for (let i = 0; i < 3000; i++) {
    rows.push({
      vcenterId: `vc${i % 3}`, key: `k${i}`,
      ts: T + Math.floor(i / 100) * 1000, // 100건씩 같은 ts(동률 다량)
      severity: 'info', type: 'event', user: `u${i % 7}`, entity: `e${i % 11}`, message: `msg ${i}`,
    });
  }
  db.insertMany(rows);

  const f = { vcenterId: '', severity: '', q: '', since: 0, until: 0 };
  const full = db.query(f, 3000, 0);
  assert.equal(full.length, 3000);

  const CHUNK = 700; // 3000/700 → 경계가 동률 구간을 여러 번 가로지름
  const chunked = [];
  for (let offset = 0; ; offset += CHUNK) {
    const part = db.query(f, CHUNK, offset);
    chunked.push(...part);
    if (part.length < CHUNK) break;
  }
  assert.equal(chunked.length, full.length, '총 행 수 동일');
  const sig = (r) => `${r.ts}|${r.vcenterId}|${r.message}`;
  assert.deepEqual(chunked.map(sig), full.map(sig), '순서·내용 완전 일치(중복/누락 없음)');
});

test('IPAM 엑셀: 양보(setImmediate) 리팩터 후에도 시트/행 산출이 동일하다', async () => {
  const { buildWorkbook } = await import('../src/ipam/excel.js');
  const sheets = Array.from({ length: 9 }, (_, i) => ({
    subnet: `10.0.${i}.0/24`, base: `10.0.${i}`, used: 2,
    rows: [
      { ip: `10.0.${i}.1`, purpose: 'GW', hostname: `gw${i}`, serverType: 'VM', os: 'l', notes: '', power: 'on', scope: 'infra', status: 'used' },
      { ip: `10.0.${i}.2`, purpose: '', hostname: '', serverType: '', os: '', notes: '', power: '', scope: '', status: 'empty' },
    ],
  }));
  const wb = await buildWorkbook(sheets); // 4시트마다 양보 — 9시트면 양보 2회 경로를 지난다
  assert.equal(wb.worksheets.length, 9);
  const ws = wb.worksheets[4];
  assert.equal(ws.getCell('A1').value, 'VLAN — 10.0.4.0/24');
  assert.equal(ws.getCell('A3').value, '10.0.4.1'); // 타이틀(1)+헤더(2) 다음 첫 데이터 행
  assert.equal(ws.getCell('C3').value, 'gw4');
});
