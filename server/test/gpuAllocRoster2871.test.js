/**
 * test/gpuAllocRoster2871.test.js — v2.871 감사 GPU 할당 목차 · 법인 칩의 '모름'(A4-02 · A4-04).
 *  · A4-02: 계층에 노드가 없는 법인을 'GPU 호스트 0대' 로 적지 않는다 — 인벤토리 없이 status 만 있는 vCenter(재시작 직후 첫 수집 전 'pending' ·
 *    보존 창을 넘긴 장기 장애 'unreachable' · 수집 꺼짐 · 점검 중)와 상한으로 잘린 계층은 모름. stale(직전 인벤토리 보존)이면 실제 0대.
 *    재현(감사 a4_roster): unreachable PL → 목차 [vc-poland, '', 0, 0, …, '— GPU 호스트 없음(시트 없음)'].
 *    서버 allocTree.corpUnknownOf 와 웹 gpuAllocText.corpUnknownOf 를 같은 입력으로 대조한다(판정 코어 하나 규칙).
 *  · A4-04: 목차의 전체(GB) · 할당(GB) 이 용량·할당을 모르는 GPU·VM 이 섞인 부분 합이면 '48 + 모름 1장' + 비고 — 숫자만 적지 않는다.
 *    재현(감사 a4_toc): GPU 2장(1장 memGB null) → 목차 [vc-kr, '', 1, 2, 48, 0, null, …] — GPU 2장에 전체 48GB 로 읽혔다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { allocCorpRoster, buildGpuAllocTree, corpUnknownOf, CORP_UNKNOWN_TEXT, CORP_INV_EMPTY } from '../src/gpu/allocTree.js';
import { renderGpuAllocWorkbook } from '../src/gpu/allocTreeXlsx.js';

const W = await import('../../web/src/views/tools/gpuAllocText.js');

const host = (id, vcenterId, gpus) => ({ id, name: id, vcenterId, cluster: 'CL1', vcDatacenter: 'DC1', connectionState: 'CONNECTED', gpus });
const A40 = { model: 'NVIDIA A40', memGB: 48, mode: 'vgpu', vms: [] };
const meta = { stamp: '2026-11-03 20:00', tz: 'KST', scopeText: '전체 법인' };
const tocRows = async (snap) => {
  const tree = buildGpuAllocTree(snap);
  const roster = allocCorpRoster(snap, {}, tree);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await renderGpuAllocWorkbook(tree, meta, { roster, sheets: ['corp'] }));
  const ws = wb.getWorksheet('목차');
  const out = new Map();
  ws.eachRow((r, i) => { if (i >= 4 && r.getCell(2).value !== undefined) { const v = r.getCell(1).value; const name = typeof v === 'object' && v ? v.text : v; out.set(name, r); } });
  return { roster, out, ws };
};

test('A4-02 판정 — 서버 · 웹 corpUnknownOf 가 같은 입력에 같은 답 · 사유 글자도 같다', () => {
  const cases = [];
  for (const status of ['', 'ok', 'pending', 'unreachable', 'disabled', 'maintenance', 'stale', 'warning', undefined]) {
    for (const stale of [false, true]) for (const hasNode of [false, true]) for (const truncated of [0, 3]) cases.push([{ status, stale }, hasNode, truncated]);
  }
  cases.push([null, false, 0], [undefined, false, 2], [{ status: 5 }, false, 0]);
  for (const c of cases) assert.equal(W.corpUnknownOf(...c), corpUnknownOf(...c), JSON.stringify(c));
  assert.deepEqual(W.CORP_UNKNOWN_TEXT, CORP_UNKNOWN_TEXT);
  assert.deepEqual(W.CORP_INV_EMPTY, CORP_INV_EMPTY);
  assert.equal(corpUnknownOf({ status: 'pending' }, false), 'pending', '재시작 직후 첫 수집 전');
  assert.equal(corpUnknownOf({ status: 'unreachable' }, false), 'unreachable', '보존 창을 넘긴 장기 장애(인벤토리 비움)');
  assert.equal(corpUnknownOf({ status: 'unreachable', stale: true }, false), '', 'stale 은 직전 인벤토리가 있다 — 노드가 없으면 실제 0대');
  assert.equal(corpUnknownOf({ status: 'ok' }, false), '', '정상 수집인데 노드가 없으면 실제 0대');
  assert.equal(corpUnknownOf({ status: 'ok' }, false, 1), 'truncated', '상한으로 잘린 계층에서는 노드가 없어도 모름');
  assert.equal(corpUnknownOf({ status: 'unreachable' }, true), '', '노드가 있으면 아는 값');
});

test('A4-02 목차 — 수집 전 · 접속 불가 법인은 GPU 호스트 · GPU 를 0 이 아니라 빈 칸 + 사유 · 실제 0대 법인은 그대로 0', async () => {
  const snap = {
    vcenters: [{ id: 'KR', name: 'vc-kr', status: 'ok' }, { id: 'PL', name: 'vc-poland', status: 'unreachable' }, { id: 'US', name: 'vc-us-east', status: 'pending' }, { id: 'BR', name: 'vc-br', status: 'ok' }],
    hosts: [host('esx1', 'KR', [{ ...A40 }])], vms: [],
  };
  const { roster, out } = await tocRows(snap);
  assert.deepEqual(roster.map((c) => [c.id, c.unknown]), [['BR', ''], ['KR', ''], ['PL', 'unreachable'], ['US', 'pending']]);
  const pl = out.get('vc-poland');
  assert.equal(pl.getCell(3).value, null, '접속 불가 법인의 GPU 호스트 수는 빈 칸(0 아님)');
  assert.equal(pl.getCell(4).value, null);
  assert.match(String(pl.getCell(10).value), /접속 불가/);
  assert.doesNotMatch(String(pl.getCell(10).value), /GPU 호스트 없음\(시트 없음\)/);
  assert.match(String(pl.getCell(11).value), /0 이 아님/);
  const us = out.get('vc-us-east');
  assert.equal(us.getCell(3).value, null);
  assert.match(String(us.getCell(10).value), /수집 전/);
  const br = out.get('vc-br');
  assert.equal(br.getCell(3).value, 0, '정상 수집 · GPU 호스트 없음은 실제 0');
  assert.equal(br.getCell(4).value, 0);
  assert.match(String(br.getCell(10).value), /GPU 호스트 없음/);
  assert.equal(out.get('vc-kr').getCell(3).value, 1);
  // 웹 칩도 같은 판정 — /vcenters 응답(status · stale)으로
  const chips = W.corpChips(buildGpuAllocTree(snap), snap.vcenters);
  const byId = Object.fromEntries(chips.map((c) => [c.id, c]));
  assert.equal(byId.PL.unknown, 'unreachable'); assert.equal(byId.PL.hosts, null, '칩도 0 이 아니라 모름(null)');
  assert.equal(W.corpChipText(byId.PL).count, '—');
  assert.match(W.corpChipText(byId.PL).title, /모름\(접속 불가/);
  assert.equal(byId.BR.hosts, 0); assert.equal(W.corpChipText(byId.BR).count, '0');
  assert.equal(byId.KR.hosts, 1);
});

test('A4-04 목차 — 용량을 모르는 GPU 가 섞이면 전체(GB)는 ‘48 + 모름 1장’ · 비고에 같은 말(부분 합을 전체처럼 적지 않는다)', async () => {
  const snap = {
    vcenters: [{ id: 'KR', name: 'vc-kr', status: 'ok' }, { id: 'DE', name: 'vc-de', status: 'ok' }],
    hosts: [host('esx1', 'KR', [{ ...A40 }, { model: 'Mystery GPU', memGB: null, mode: 'vgpu', vms: [] }]), host('esx2', 'DE', [{ ...A40 }])], vms: [],
  };
  const tree = buildGpuAllocTree(snap);
  const kr0 = tree.vcenters.find((v) => v.id === 'KR').totals;
  assert.equal(kr0.capUnknown, 1, '전제: 용량 모르는 GPU 1장');
  const { out } = await tocRows(snap);
  const kr = out.get('vc-kr');
  assert.equal(kr.getCell(4).value, 2);
  assert.equal(kr.getCell(5).value, '48 + 모름 1장', '부분 합만 숫자로 적으면 GPU 2장에 전체 48GB 로 읽힌다');
  assert.equal(kr.getCell(7).value, null, '예비는 빈 칸(이미 그랬다)');
  assert.match(String(kr.getCell(11).value), /용량 모르는 GPU 1장/);
  const de = out.get('vc-de');
  assert.equal(de.getCell(5).value, 48, '모르는 것이 없으면 숫자 그대로');
  assert.equal(de.getCell(11).value || '', '');
});
