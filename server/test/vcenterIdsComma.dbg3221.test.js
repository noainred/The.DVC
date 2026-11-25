/**
 * dbg3221 5회차 — 쉼표가 든 vCenter id 를 바로가기에서 2곳 이상 고르면 서버 합계에서 그 법인이 조용히 빠졌다.
 *   원인: 웹 platformText.hubScopeQuery 가 id 를 날 글자로 쉼표 연결 · 서버 shared.parseVcenterIds 가 쉼표로 나눔 ·
 *         등록부(vcenter/registry.js normalize)는 id 의 쉼표를 허용한다.
 *   고침: 웹이 id 마다 encodeURIComponent 한 뒤 잇고, 서버가 나눈 조각마다 decodeVcenterIdPart(웹 decodeScopeIdPart 와 같은 뜻).
 * 실제 웹 함수 → URLSearchParams(브라우저 fetchJson) → 바깥 디코드(express 와 같은 URLSearchParams.get) → parseVcenterIds → applyFilters 경로를 탄다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vcIdsComma3221-'));
Object.assign(process.env, { CONFIG_DIR: DIR });
after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });

const S = await import('../src/routes/api/shared.js');
const W = await import('../../web/src/views/platform/platformText.js');

const snap = { vcenters: [{ id: 'KR,Seoul' }, { id: 'US1' }, { id: 'PL' }, { id: '50%off' }] };
/** 브라우저 → 서버 왕복 — fetchJson 의 URLSearchParams 직렬화 뒤 서버 쪽 바깥 디코드. */
const roundTrip = (q) => Object.fromEntries(new URLSearchParams(new URLSearchParams(q).toString()));

test('쉼표가 든 id 를 포함해 2곳 고르면 서버가 같은 두 법인으로 읽는다 — 합계에서 빠지지 않는다', () => {
  const q = W.hubScopeQuery({ vcenterIds: ['KR,Seoul', 'US1'] });
  const server = roundTrip(q);
  assert.deepEqual(S.parseVcenterIds(server, snap), ['KR,Seoul', 'US1']);
  const rows = [{ vcenterId: 'KR,Seoul', name: 'h1' }, { vcenterId: 'US1', name: 'h2' }, { vcenterId: 'PL', name: 'h3' }];
  assert.deepEqual(S.applyFilters(rows, server, snap).map((r) => r.vcenterId), ['KR,Seoul', 'US1']);
  assert.deepEqual([...S.vcenterPickOf(server, snap)], ['KR,Seoul', 'US1']);
  // 웹 화면 안 재해석(scopeIdsOf(filters))도 같은 목록 — 분석 화면 합과 서버 합이 같은 집합
  assert.deepEqual(W.scopeIdsOf(q), ['KR,Seoul', 'US1']);
});

test('% 가 든 id · 공백 id 도 왕복 · 잘못된 % 줄은 날 글자 그대로(옛 웹 호환) · 길이 상한은 푼 뒤에', () => {
  const server = roundTrip(W.hubScopeQuery({ vcenterIds: ['50%off', 'pl 1', 'PL'] }));
  assert.deepEqual(S.parseVcenterIds(server, snap), ['50%off', 'pl 1', 'PL']);
  assert.deepEqual(S.parseVcenterIds({ vcenterIds: 'US1,PL' }, snap), ['US1', 'PL'], '옛 날 글자 목록도 그대로');
  assert.deepEqual(S.parseVcenterIds({ vcenterIds: 'a%ZZ,US1' }, snap), ['a%ZZ', 'US1']);
  const id200 = 'é'.repeat(S.VCENTER_ID_LEN_MAX);   // 푼 뒤 200자 — 인코딩하면 1200자
  const many = { vcenters: [{ id: id200 }, { id: 'x' }] };
  assert.deepEqual(S.parseVcenterIds(roundTrip(W.hubScopeQuery({ vcenterIds: [id200, 'x'] })), many), [id200, 'x']);
});

test('조각 디코드 판정은 웹 · 서버 한 뜻 — 같은 입력 대조', () => {
  for (const p of ['', 'a', 'KR%2CSeoul', '50%25off', 'a%ZZ', '%', 'pl%201', '%E2%82%AC', '%E2%82']) {
    assert.equal(S.decodeVcenterIdPart(p), W.decodeScopeIdPart(p), p);
  }
});

// dbg3221 5회차 ②: 분석 화면이 고른 법인으로 다시 판정하는 partial(web toolSumText.notReadPartialIn)은 서버 notReadPartialOf 와 같은 뜻이어야 한다.
test('못 읽음 부분 합 판정 — 웹 notReadPartialIn ↔ 서버 notReadPartialOf 같은 입력 대조', async () => {
  const { notReadPartialOf } = await import('../src/corelicense/analyze.js');
  const { notReadPartialIn } = await import('../../web/src/views/vms/insight-tools/toolSumText.js');
  const cases = [[], [{ why: 'disabled' }], [{ why: 'stale' }], [{ why: 'pending' }, { why: 'disabled' }], [{ why: 'unreachable' }], [{ why: 'maintenance' }], null, undefined, [{}]];
  for (const c of cases) assert.equal(notReadPartialIn(c), notReadPartialOf(c), JSON.stringify(c));
});
