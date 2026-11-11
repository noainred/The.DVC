/**
 * v2.954(점검 B-2) — SAN 스토리지 성능 알림: unknown · na 는 직전 수준을 지우지 않는다(항목별 '마지막으로 알던 수준' 이월).
 *  ① warn → unknown → warn: 같은 주의를 다시 보내지 않는다.
 *  ② warn → unknown → ok: 회복을 보낸다(받는 쪽 사건이 열린 채 남지 않게).
 *  ③ ok → unknown → warn: 열림(마지막 수준 ok 보다 높다) · collect 는 그대로(ok → unknown = 보고 끊김).
 *  러너와 같은 순서로 이어 간다 — 다음 상태 = carryKnown(직전 상태, 이번 스냅샷), 비교 = diffCheck(직전 상태, 이번 스냅샷).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sannotify2954-'));
process.env.CONFIG_DIR = tmp;
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const mk = (items) => ({ key: 'K', datacenterId: 'dcA', datacenterName: '서울 법인', name: 'PMAX-1', overall: 'ok',
  items: Object.fromEntries(Object.entries(items).map(([k, s]) => [k, { status: s, text: `${k} 문구` }])) });

async function chain(seq) {
  const NS = await import('../src/sanswitch/storagePerfNotifyStore.js');
  let state = {}; const out = [];
  for (const items of seq) {
    const cur = NS.snapshotOf([mk(items)]);
    const d = NS.diffCheck(state, cur);
    out.push({ opened: d.opened.map((x) => [x.item, x.from, x.to, x.kind || '']), recovered: d.recovered.map((x) => [x.item, x.from, x.to]) });
    state = NS.carryKnown(state, cur);
  }
  return out;
}

test('B-2 ① warn → unknown → warn 은 다시 열지 않는다', async () => {
  const r = await chain([{ imbalance: 'ok', collect: 'ok' }, { imbalance: 'warn', collect: 'ok' }, { imbalance: 'unknown', collect: 'ok' }, { imbalance: 'warn', collect: 'ok' }]);
  assert.deepEqual(r[1].opened, [['imbalance', 'ok', 'warn', '']]);
  assert.deepEqual(r[2], { opened: [], recovered: [] }, 'unknown 은 아무것도 아님');
  assert.deepEqual(r[3], { opened: [], recovered: [] }, '마지막으로 알던 수준(warn)과 같으므로 재알림 없음');
});

test('B-2 ② warn → unknown → ok 는 회복 · na 도 같다', async () => {
  const r = await chain([{ resp: 'ok' }, { resp: 'bad' }, { resp: 'unknown' }, { resp: 'na' }, { resp: 'ok' }]);
  assert.deepEqual(r[1].opened, [['resp', 'ok', 'bad', '']]);
  assert.deepEqual(r[4].recovered, [['resp', 'bad', 'ok']]);
  assert.deepEqual(r[4].opened, []);
});

test('B-2 ③ ok → unknown → warn 은 열림 · warn → unknown → bad 는 올림 · collect 의미는 그대로', async () => {
  const r = await chain([{ cpu: 'ok', collect: 'ok' }, { cpu: 'unknown', collect: 'unknown' }, { cpu: 'warn', collect: 'unknown' }, { cpu: 'unknown', collect: 'ok' }, { cpu: 'bad', collect: 'ok' }]);
  assert.deepEqual(r[1].opened, [['collect', 'ok', 'unknown', 'lost']]);
  assert.deepEqual(r[2].opened, [['cpu', 'ok', 'warn', '']]);
  assert.deepEqual(r[3].recovered, [['collect', 'unknown', 'ok']]);
  assert.deepEqual(r[4].opened, [['cpu', 'warn', 'bad', '']]);
});

test('B-2 carryKnown — 수준이 아닌 항목만 known 을 싣고 collect 는 싣지 않는다', async () => {
  const NS = await import('../src/sanswitch/storagePerfNotifyStore.js');
  const s0 = NS.snapshotOf([mk({ a: 'warn', b: 'ok', collect: 'ok' })]);
  const s1 = NS.carryKnown(NS.carryKnown({}, s0), NS.snapshotOf([mk({ a: 'unknown', b: 'ok', collect: 'unknown' })]));
  assert.deepEqual(s1['dcA|K'].known, { a: 'warn' });
  const s2 = NS.carryKnown(s1, NS.snapshotOf([mk({ a: 'na', b: 'ok', collect: 'ok' })]));
  assert.deepEqual(s2['dcA|K'].known, { a: 'warn' }, '여러 주기 unknown · na 여도 이월');
  const s3 = NS.carryKnown(s2, NS.snapshotOf([mk({ a: 'ok', b: 'ok', collect: 'ok' })]));
  assert.equal(s3['dcA|K'].known, undefined, '수준이 다시 읽히면 이월분이 필요 없다');
});

test('B-2 러너가 carryKnown 으로 상태를 저장한다', () => {
  const src = fs.readFileSync(new URL('../src/sanswitch/storagePerfNotify.js', import.meta.url), 'utf8');
  assert.match(src, /last:\s*carryKnown\(st\.last,\s*cur\)/);
});
