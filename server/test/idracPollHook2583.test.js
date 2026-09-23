/**
 * v2.583 — iDRAC 폴러가 실장비 폴마다 `ReferenceError: invRefreshed is not defined` 로 끝나던 결함(v2.548~).
 * 카운터가 pollOnce() 에 선언되고 pollOnceInner() 가 썼다. pollNow 가 잡아 '[idrac] pollNow 실패' 를 폴마다
 * 찍었고 파트 장애 즉시 판정 훅(v2.548 F7)은 한 번도 돌지 않았다. 목 모드는 먼저 return 해 드러나지 않았다
 * — 그래서 이 테스트는 **목이 아닌 경로**를 실제로 돈다(가짜 Redfish = 모든 경로 404 인 로컬 HTTP).
 * v2.566 교훈과 같다: push/poll 함수는 실제로 호출하는 테스트가 있어야 이 종류를 잡는다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idrac-hook-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'live';
process.env.SSRF_ALLOW_LOOPBACK = 'true';

test('실장비 경로 폴이 예외 없이 끝나고, 인벤토리를 갱신하면 파트 장애 훅을 부른다', async () => {
  const srv = http.createServer((req, res) => { res.statusCode = 404; res.setHeader('Content-Type', 'application/json'); res.end('{}'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  fs.writeFileSync(path.join(tmp, 'idrac.json'), JSON.stringify({ servers: [{ id: 'synth-1', name: 'synth-1', host: `http://127.0.0.1:${port}`, username: 'u', password: 'p', type: 'idrac', enabled: true }] }));
  const errs = [];
  const orig = console.error;
  console.error = (...a) => { errs.push(a.join(' ')); };
  try {
    const P = await import('../src/idrac/poller.js');
    const last = await P.pollNow();
    assert.ok(last && last.results && last.results.length === 1, `폴 결과가 남아야 한다: ${JSON.stringify(last)}`);
    assert.deepEqual(errs.filter((e) => /pollNow 실패/.test(e)), [], 'pollNow 가 예외를 잡으면 안 된다(ReferenceError 재발)');
    const H = await import('../src/partfault/hooks.js');
    const st = H.hookStatus();
    assert.ok(st.pending > 0, `인벤토리를 갱신했으니 파트 장애 훅이 예약돼야 한다: ${JSON.stringify(st)}`);
  } finally {
    console.error = orig;
    await new Promise((r) => srv.close(r));
  }
});

test('소스 — 카운터는 그것을 쓰는 함수 안에 선언된다', () => {
  const s = fs.readFileSync(new URL('../src/idrac/poller.js', import.meta.url), 'utf8');
  // v2.590: 두 함수가 옵션 인자({ manual })를 받게 됐다 — 시그니처가 아니라 함수 이름으로 경계를 찾는다
  //   (인자 목록까지 문자열로 고정하면 indexOf 가 -1 이 되어 slice(-1) 로 검사가 공허하게 깨진다).
  const iInner = s.indexOf('async function pollOnceInner(');
  const iOuter = s.indexOf('async function pollOnce(');
  assert.ok(iOuter >= 0 && iInner > iOuter, '두 함수를 찾아야 한다(순서: pollOnce → pollOnceInner)');
  const inner = s.slice(iInner);
  const outer = s.slice(iOuter, iInner);
  assert.match(inner, /let invRefreshed = 0;/);
  assert.doesNotMatch(outer, /invRefreshed/);
});
