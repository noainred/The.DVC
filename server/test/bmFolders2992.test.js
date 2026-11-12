/**
 * v2.992 묶음 B(설계 docs/design/bm-folders §12) — 값 없음 사유(서버 판정 코드).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const W = await import('../src/bmfolders/usageWhy.js');

const ix = W.whyIndexOf({ settings: { enabled: true }, targets: [{ key: 'k-t' }], skipped: [{ key: 'k-os', reason: 'no-os-cred' }, { key: 'k-edge', reason: 'edge-delegated' }, { key: 'k-corp', reason: 'corp-off' }, { key: 'k-weird', reason: 'zzz' }] });
const M = (o) => ({ kind: 'bm', usage: { state: 'unread' }, powered: null, ...o });

test('값이 있으면 사유 없음 · 오래됨은 마지막 값 시각을 싣는다', () => {
  assert.equal(W.usageWhyOf(M({ usage: { state: 'ok', cpuPct: 3, memPct: null } }), ix), null);
  assert.deepEqual(W.usageWhyOf(M({ usage: { state: 'stale', at: 123 } }), ix), { code: 'stale', at: 123 });
  assert.deepEqual(W.usageWhyOf({ kind: 'esxi', usage: { state: 'stale', vcUnread: true } }, ix), { code: 'vc-unread' });
});

test('대상 해석의 사유 코드를 그대로 · 엣지 위임은 엣지 값 없음 · 대상인데 값 없음은 기록 없음 · 모르는 코드는 확인 못 함', () => {
  assert.equal(W.usageWhyOf(M({ usageKey: 'k-os' }), ix).code, 'no-os-cred');
  assert.equal(W.usageWhyOf(M({ usageKey: 'k-corp' }), ix).code, 'corp-off');
  assert.equal(W.usageWhyOf(M({ usageKey: 'k-edge' }), ix).code, 'edge-no-record');
  assert.equal(W.usageWhyOf(M({ usageKey: 'k-t' }), ix).code, 'no-record');
  assert.equal(W.usageWhyOf(M({ usageKey: 'k-weird' }), ix).code, 'unknown');
  assert.equal(W.usageWhyOf(M({ usageKey: 'k-none' }), ix).code, 'unknown');
  assert.equal(W.usageWhyOf(M({ usageKey: 'k-t' }), null).code, 'unknown', '대상 해석 실패 = 확인 못 함(단정하지 않는다)');
});

test('꺼진 서버 · 수집 꺼짐 · ESXi 는 베어메탈 사유를 쓰지 않는다', () => {
  assert.equal(W.usageWhyOf(M({ usageKey: 'k-os', powered: false }), ix).code, 'powered-off');
  const off = W.whyIndexOf({ settings: { enabled: false }, targets: [{ key: 'k-t' }], skipped: [{ key: 'k-os', reason: 'no-os-cred' }] });
  assert.equal(W.usageWhyOf(M({ usageKey: 'k-t' }), off).code, 'off');
  assert.equal(W.usageWhyOf(M({ usageKey: 'k-x' }), off).code, 'off');
  assert.equal(W.usageWhyOf(M({ usageKey: 'k-os' }), off).code, 'no-os-cred', '대상에서 빠진 이유가 더 구체적이면 그것');
  assert.equal(W.usageWhyOf({ kind: 'esxi', usageKey: 'k-os', usage: { state: 'unread' } }, ix).code, 'unknown');
});

test('memo — 성공 60초 · 실패 15초 · 진행 중 공유', async () => {
  W._resetWhyMemoForTest();
  let calls = 0;
  const load = async () => { calls += 1; return { settings: { enabled: true }, targets: [], skipped: [] }; };
  const [a, b] = await Promise.all([W.currentWhyIndex({ load }), W.currentWhyIndex({ load })]);
  assert.equal(calls, 1); assert.equal(a, b);
  await W.currentWhyIndex({ load, now: Date.now() + 30_000 }); assert.equal(calls, 1);
  await W.currentWhyIndex({ load, now: Date.now() + 61_000 }); assert.equal(calls, 2);
  W._resetWhyMemoForTest();
  const bad = async () => { calls += 1; throw new Error('x'); };
  assert.equal(await W.currentWhyIndex({ load: bad }), null);
  await W.currentWhyIndex({ load: bad, now: Date.now() + 10_000 }); assert.equal(calls, 3, '실패는 15초 안에 다시 묻지 않는다');
  W._resetWhyMemoForTest();
});

test('응답에 코드만 싣는다(문구 · 계정 · 주소 · 엣지 이름 없음) · 화면 문구 표가 모든 코드를 덮는다', () => {
  const src = fs.readFileSync(new URL('../src/routes/api/bmFolders.js', import.meta.url), 'utf8');
  assert.match(src, /why: ix !== undefined \? usageWhyOf\(m, ix\) \|\| undefined : undefined/);
  assert.match(src, /usageOff: !!ix\?\.off/);
  const web = fs.readFileSync(new URL('../../web/src/views/tools/bmFolders/whyText.js', import.meta.url), 'utf8');
  for (const c of W.WHY_CODES) assert.ok(web.includes(`'${c}':`) || web.includes(`\n  ${c}:`), `화면 문구 없음: ${c}`);
  for (const r of [W.usageWhyOf(M({ usageKey: 'k-edge' }), ix), W.usageWhyOf(M({ usage: { state: 'stale', at: 5 } }), ix)]) assert.deepEqual(Object.keys(r).filter((k) => !['code', 'at'].includes(k)), []);
});
