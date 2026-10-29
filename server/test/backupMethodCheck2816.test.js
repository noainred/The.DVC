/**
 * v2.816 — 백업 방식에 '확인 필요'(check) 추가(사용자 요청 "백업 방식에 '확인 필요' 라는 TAG 추가해줘").
 *  · 저장소: method 'check' 를 받는다 · 집계 method.check · 서머리 합계에도 같은 키
 *  · 글자·엑셀 색: METHOD_TEXT.check = '확인 필요' · METHOD_LOOK.check
 *  · 판정: '확인 필요' 는 미백업에서 빼지 않는다(백업 안함·Clone 만 뺀다) — needgap 보기·우선순위 gap·먼저 볼 VM 은 남기고 이유 앞에 밝힌다
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'backup2816-'));
process.env.CONFIG_DIR = DIR;
after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });

const BM = await import('../src/veeam/backupMarks.js');
const BS = await import('../src/veeam/backupStatus.js');
const XS = await import('../src/vcenter/vmXlsxStyle.js');
const XL = await import('../src/veeam/vmListXlsx.js');
const U = { username: 'op1' };
const H = 3_600_000;
const NOW = Math.floor(Date.now() / H) * H;

test('A 저장 · 집계 · 글자 · 색', () => {
  BM._resetMarksForTest();
  const vms = [{ id: 'x:1', name: 'a', vcenterId: 'x' }, { id: 'x:2', name: 'b', vcenterId: 'x' }];
  assert.equal(BM.setMarks([vms[0]], { method: 'check' }, U).ok, true);
  assert.equal(BM.markView(BM.getMarks()['x:1']).method, 'check');
  assert.deepEqual(BM.markCounts(vms, BM.getMarks(), {}, { veeamKnown: true }).method, { veeam: 0, clone: 0, config: 0, none: 0, check: 1, unset: 1 });
  assert.equal(BS.backupTotals([{ vm: 2, marks: { method: { veeam: 0, clone: 0, config: 0, none: 0, check: 1, unset: 1 } } }]).marks.method.check, 1);
  assert.equal(BS.METHOD_TEXT.check, '확인 필요');
  assert.ok(XS.METHOD_LOOK.check?.fg && XS.METHOD_LOOK.check?.bg);
  assert.ok(BS.VIEW_FILTERS.includes('method-check'));
});

test('B 판정 — 확인 필요는 미백업에서 빼지 않는다', () => {
  const vm = { id: 'x:1', v: null, s: { ev: null }, m: { need: true, method: 'check' } };
  assert.equal(BS.vmViewMatches(vm, 'method-check'), true);
  assert.equal(BS.vmViewMatches(vm, 'method-unset'), false);
  assert.equal(BS.vmViewMatches(vm, 'needgap'), true, 'Veeam 없음 + 백업 필요 + 확인 필요 = 미백업으로 남는다');
  const [c] = BS.priorityCandidates([{ id: 'x:1', name: 'a' }], { byVm: {}, marks: { 'x:1': { need: true, method: 'check' } }, veeamKnown: true, now: NOW });
  assert.deepEqual([c.method, c.gap], ['check', true]);
});

test('C 먼저 볼 VM — 확인 필요는 남기고 이유 앞에 밝힌다', () => {
  const it = { inv: { name: 'chk', snapshotCount: 0 }, view: { id: 'chk', name: 'chk', folder: 'DC/vm/A', power: 'POWERED_ON', v: null, s: { ev: null, now: null }, m: { method: 'check' } }, verdict: { code: 'none' }, stale: false };
  const [w] = XL.watchList([it], { snapDays: 7, at: NOW });
  assert.match(w.why, /^백업 방식 확인 필요로 표시함 — /);
});
