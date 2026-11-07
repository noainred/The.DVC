/**
 * v2.923(B-①) — CVP 포트 드롭의 '보여 주기' 쪽(수집·저장·push·정제는 v2.922 3a 가 넣었다 — bmPerf 계열 테스트가 고정한다).
 *  ① portWindowSums — 최근 창의 오류·드롭을 원시 표본에서 더하고, 값이 없는 표본(드롭 수집 전·구버전 엣지 10칸)은 더하지 않고 표본 수로 밝힌다
 *  ② portUsage 행에 드롭이 실린다(CVP 포트 사용량 표의 ‘드롭(수/송)’ 열)
 *  ③ 데모 합성 포트·백필 행에 드롭이 있다(12칸)
 *  ④ 호스트 업링크 라우트가 포트별 24시간 합(day)과 드롭을 싣는다(소스 고정 — 라우트 동작은 sanAttrib2920 ⑥ 이 실제로 부른다)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cvpdropui2923-'));
const H = 3_600_000;
const NOW = Math.floor(Date.now() / H) * H;   // 정시로 떨어뜨린 실제 시각(docs/rules/common.md)

test('① · ② portWindowSums · portUsage — 값이 있는 표본만 더한다 · 표본 수', async () => {
  const cdb = await import('../src/cvp/db.js');
  if (!(await cdb.available())) return;
  const port = (inDrop, outDrop) => ({ name: 'Ethernet1', desc: 'esx01 vmnic0', oper: 'up', admin: 'up', speedBps: 1e9, inBps: 100, outBps: 200, inUtil: 1, outUtil: 2, inErr: 0, outErr: 1, inDrop, outDrop });
  const t1 = NOW - 20 * 60_000; const t2 = NOW - 15 * 60_000; const t3 = NOW - 10 * 60_000;
  for (const [t, a, b] of [[t1, 2, 7], [t2, null, null], [t3, 0, 5]]) {
    await cdb.saveDevices({ cvpId: 'cvp-L', devices: [{ key: 'SN1', ts: t, hostname: 'leaf1', ports: [port(a, b)] }], samples: true });
  }
  const s = (await cdb.portWindowSums([{ agent: '', cvpId: 'cvp-L', key: 'SN1', port: 'Ethernet1' }], { now: NOW })).get('\u0000cvp-L\u0000SN1\u0000Ethernet1');
  assert.deepEqual(s, { inErr: 0, outErr: 3, inDrop: 2, outDrop: 12, samples: 3, dropN: 2, errN: 3 }, '드롭이 없는 표본은 더하지 않고 dropN 에 세지 않는다');
  const old = (await cdb.portWindowSums([{ agent: '', cvpId: 'cvp-L', key: 'SN1', port: 'Ethernet1' }], { now: NOW, sinceMs: 60_000 })).get('\u0000cvp-L\u0000SN1\u0000Ethernet1');
  assert.deepEqual(old, { inErr: null, outErr: null, inDrop: null, outDrop: null, samples: 0, dropN: 0, errN: 0 }, '창 안에 표본이 없으면 null(0 이 아니다)');
  // 구버전 엣지(10칸) 표본 — 드롭 null 로 들어가고 합에 들어가지 않는다
  const A = 'edge-a';
  await cdb.saveDevices({ agent: A, cvpId: 'cvp-E', devices: [{ key: 'SN2', ts: t1, hostname: 'leaf2', ports: [port(1, 1)] }] });
  await cdb.importSamples(A, [['cvp-E', 'SN2', 'Ethernet1', t2, 100, 200, 1, 2, 0, 0, 4, 9], ['cvp-E', 'SN2', 'Ethernet1', t3, 100, 200, 1, 2, 0, 0]]);
  const e = (await cdb.portWindowSums([{ agent: A, cvpId: 'cvp-E', key: 'SN2', port: 'Ethernet1' }], { now: NOW })).get(`${A}\u0000cvp-E\u0000SN2\u0000Ethernet1`);
  assert.equal(e.inDrop, 4); assert.equal(e.outDrop, 9); assert.equal(e.dropN, 1); assert.equal(e.samples, 2);
  assert.equal((await cdb.portWindowSums([{ agent: '', cvpId: 'x', key: 'y', port: 'z' }])).get('\u0000x\u0000y\u0000z').samples, 0);
  const pu = await cdb.portUsage({ cvpId: 'cvp-L', now: NOW });
  const row = (pu.rows || pu.ports || []).find((r) => r.port === 'Ethernet1');
  assert.ok(row, 'portUsage 가 포트 행을 준다');
  assert.equal(row.inDrop, 0); assert.equal(row.outDrop, 5, '포트 사용량 행에 마지막 드롭 델타');
});

test('③ 데모 — 합성 포트와 백필 행(12칸)에 드롭', () => {
  const src = fs.readFileSync(new URL('../src/mock/demo/cvp.js', import.meta.url), 'utf8');
  assert.match(src, /inDrop: ph % 29 === 0 \? 1 : 0, outDrop: hot \?/);
  assert.match(src, /v\.inErr, v\.outErr, v\.inDrop, v\.outDrop\]/);
});

test('④ 호스트 업링크 라우트 — 포트별 24시간 합(day) · 드롭', () => {
  const src = fs.readFileSync(new URL('../src/routes/api/hostSan.js', import.meta.url), 'utf8');
  assert.match(src, /cdb\.portWindowSums\(/);
  // v2.925(B-③): day 는 dayOf(u)(최근 1시간 recent 를 떼고) · hour 는 따로 — 24시간 합 자체는 그대로다.
  assert.match(src, /inDrop: u\.inDrop \?\? null, outDrop: u\.outDrop \?\? null, day: dayOf\(u\), hour: hourOf\(u\)/);
});
