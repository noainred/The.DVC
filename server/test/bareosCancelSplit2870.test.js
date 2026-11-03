/**
 * test/bareosCancelSplit2870.test.js — v2.870 통합 · 법인별 현황에서 사람이 멈춘 실행(canceled)을 실패와 따로 센다
 * (사용자 요청 '프로그램 개선' — v2.867 남긴 것 '통합 · 법인별 현황은 지금도 canceled 를 실패로 센다').
 *  · bareosClass: fail = error 만 · cancel = canceled(웹 bareosViewText.bareosClass 와 한 쌍 — 웹 시험이 같은 입력으로 대조)
 *  · corpCounts · sumCounts: cancel 칸(결과를 모르면 null — 0 이 아니다)
 *  · priorityKind: 멈춘 실행은 '실패' 우선 확인에 넣지 않는다(백업이 비면 old · never 가 잡는다)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as VV from '../src/bareos/vmView.js';

const NOW = Date.UTC(2026, 10, 3, 12);
const canceled = { job: true, on: true, st: 'canceled', ok: NOW - 3_600_000, at: NOW - 600_000 };
const failed = { job: true, on: true, st: 'error', ok: NOW - 3_600_000, at: NOW - 600_000 };

test('bareosClass — canceled 는 cancel · error 만 fail', () => {
  assert.deepEqual([VV.bareosClass(canceled).fail, VV.bareosClass(canceled).cancel], [false, true]);
  assert.deepEqual([VV.bareosClass(failed).fail, VV.bareosClass(failed).cancel], [true, false]);
  assert.equal(VV.bareosClass(null).cancel, false);
});

test('corpCounts · sumCounts — 취소는 따로 · 결과를 모르면 null', () => {
  const rows = [{ method: 'bareos', b: canceled }, { method: 'bareos', b: canceled }, { method: 'bareos', b: failed }, { method: 'bareos', b: { job: true, on: true, st: 'ok', ok: NOW } }];
  const c = VV.corpCounts(rows, { now: NOW });
  assert.equal(c.fail, 1);
  assert.equal(c.cancel, 2);
  assert.equal(c.ok, 1);
  const u = VV.corpCounts(rows, { resultsKnown: false, now: NOW });
  assert.equal(u.cancel, null, '결과를 모르면 취소 수도 모름');
  const s = VV.sumCounts([c, u]);
  assert.equal(s.cancel, 2);
  assert.equal(s.partial.cancel, true, '한 법인이 모름이면 부분 합 표지');
});

test('priorityKind — 멈춘 실행은 실패 우선 확인이 아니다(오래되면 old)', () => {
  assert.equal(VV.priorityKind({ b: failed }, { now: NOW }), 'fail');
  assert.equal(VV.priorityKind({ b: canceled }, { now: NOW }), '');
  assert.equal(VV.priorityKind({ b: { ...canceled, ok: NOW - 3 * 86_400_000 } }, { now: NOW, rpoDays: 1 }), 'old');
});

test('v2.870 감사 A1-05 — cancelSummary 시작 결과 모름 수(취소를 보낼 수 없는 항목) · 감사 문구', async () => {
  const GR = await import('../src/bareos/groupRunner.js');
  const r = { canceled: 3, finished: 0, cleared: 0, failed: 0, unknown: 0, busy: 0, vms: {} };
  const c = GR.cancelSummary({ at: NOW, by: 'kim' }, 'sending', r, null, 1, 2);
  assert.equal(c.startUnknown, 2);
  assert.match(GR.cancelAuditText(c), /시작 결과 모름 2\(취소 못 함\)/);
  assert.equal('startUnknown' in GR.cancelSummary({ at: NOW, by: 'kim' }, 'sending', r, null, 1, 0), false, '0 이면 칸을 두지 않는다');
});
