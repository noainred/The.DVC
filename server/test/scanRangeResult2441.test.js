/**
 * v2.441 — 위임 스캔 **결과**가 대역 엔트리의 '최근 결과' 에 반영된다.
 *
 * 결함: 위임(에이전트/PUSH) 스캔은 폴러가 잡을 던진 시점에만 lastRun 을 남기고
 * (`delegated:true, found:null`), 에이전트가 결과를 회신하면 스캔 로그에만 적재하고 이 엔트리는
 * 갱신하지 않았다. 그래서 '법인별 iDRAC 장비 스캔' 표의 최근 결과가 19개 법인 대부분에서
 * 영원히 '위임(AZ) · 시각' 으로만 보이고 몇 대를 찾았는지 알 수 없었다(사용자 지적).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanrange-'));
process.env.CONFIG_DIR = dir;

const { saveScanRanges, recordScanRangeRun, recordScanRangeRunByReqId, listScanRanges } = await import('../src/idrac/scanRanges.js');

/** saveScanRanges 는 { ok, id, ... } 를 돌려준다. */
const mk = (body) => { const r = saveScanRanges(body); assert.equal(r.ok, true, r.reason); return r.id; };

const get = (id) => listScanRanges().find((e) => e.id === id);

test('위임 요청 → 결과 회신으로 발견/등록 수치가 채워진다', () => {
  const id = mk({ datacenterId: 'az', service: 'AZ IRS MGMT', ranges: ['10.0.0.0/24'], username: 'root', password: 'pw', agent: 'AZ-IRS', dispatch: 'push' });

  // ① 던짐 — 결과는 아직 없다.
  recordScanRangeRun(id, { delegated: true, agent: 'AZ-IRS', found: null, registered: null, reqId: 'idscan_abc_1', dispatch: 'push', dispatchedAt: Date.now(), pending: true });
  let e = get(id);
  assert.equal(e.lastRun.pending, true);
  assert.equal(e.lastRun.found, null);
  assert.equal(e.lastRun.reqId, 'idscan_abc_1');

  // ② 결과 회신 — reqId 로 짝을 찾아 수치를 채운다.
  const hit = recordScanRangeRunByReqId('idscan_abc_1', { pending: false, ok: true, scanned: 254, found: 3, registered: 3, unreachable: 250, durationMs: 45_000 });
  assert.equal(hit, true);
  e = get(id);
  assert.equal(e.lastRun.pending, false);
  assert.equal(e.lastRun.ok, true);
  assert.equal(e.lastRun.found, 3);
  assert.equal(e.lastRun.registered, 3);
  assert.equal(e.lastRun.scanned, 254);
  assert.equal(e.lastRun.agent, 'AZ-IRS');      // 던질 때 값은 유지
  assert.equal(e.lastRun.dispatch, 'push');
});

test('오류 회신도 반영된다(성공으로 남지 않는다)', () => {
  const id = mk({ datacenterId: 'nb', service: 'NB IRS', ranges: ['10.1.0.0/24'], username: 'root', password: 'pw', agent: 'nb-irs', dispatch: 'push' });
  recordScanRangeRun(id, { delegated: true, agent: 'nb-irs', reqId: 'idscan_err_1', pending: true, dispatchedAt: Date.now() });
  const hit = recordScanRangeRunByReqId('idscan_err_1', { pending: false, ok: false, error: '엣지 응답 HTTP 401', found: null, registered: null });
  assert.equal(hit, true);
  const e = get(id);
  assert.equal(e.lastRun.ok, false);
  assert.match(e.lastRun.error, /HTTP 401/);
});

test('모르는 reqId 는 아무것도 건드리지 않는다(늦게 온 옛 결과가 새 실행을 덮지 않게)', () => {
  assert.equal(recordScanRangeRunByReqId('no-such-req', { found: 99 }), false);
  assert.equal(recordScanRangeRunByReqId('', { found: 99 }), false);
});

test('같은 엔트리를 다시 스캔하면 reqId 가 갱신돼 옛 결과가 덮지 못한다', () => {
  const id = mk({ datacenterId: 'hm', service: 'HM IRS MGMT', ranges: ['10.2.0.0/24'], username: 'root', password: 'pw', agent: 'HM-IRS' });
  recordScanRangeRun(id, { delegated: true, agent: 'HM-IRS', reqId: 'old_req', pending: true });
  recordScanRangeRun(id, { delegated: true, agent: 'HM-IRS', reqId: 'new_req', pending: true });   // 재스캔
  assert.equal(recordScanRangeRunByReqId('old_req', { found: 1 }), false);                          // 옛 결과 무시
  assert.equal(recordScanRangeRunByReqId('new_req', { pending: false, ok: true, found: 7 }), true);
  assert.equal(get(id).lastRun.found, 7);
});
