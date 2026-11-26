/**
 * test/cvpPushPartial342.test.js — v3.42 버그 점검 4회차 A2-F3(엣지 CVP push).
 *  여러 청크로 나뉜 push 에서 **뒤 청크만** 실패하면 앞 청크의 장비 레코드는 중앙에 이미 적재됐다. 그런데 '보낸 해시' 는 그대로라,
 *  다음 주기에 장비 상태가 예전에 보낸 것과 같아져 있으면 touch 만 갔다 — 중앙은 전량 갱신 주기(최대 60분)까지 실패한 push 의 상태로 남았다
 *  (복구된 포트가 down · 장애가 열린 채). 실패한 push 에 실었던 장비는 다음 push 에서 해시와 상관없이 레코드를 다시 보낸다.
 *  실제 진입 함수(pushCvpNow)를 가짜 중앙에 대고 부른다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cvppush342-'));
process.env.CONFIG_DIR = tmp;
process.env.SSRF_ALLOW_LOOPBACK = 'true';
process.env.CVP_PUSH_CHUNK_BYTES = '65536';
process.env.CVP_PUSH_GZIP = 'false';

const { config } = await import('../src/config.js');
const reg = await import('../src/cvp/registry.js');
const db = await import('../src/cvp/db.js');
const push = await import('../src/cvp/push.js');

let failLast = false; let seen = [];
const srv = http.createServer((req, res) => {
  const parts = [];
  req.on('data', (c) => parts.push(c));
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { /* 빈 본문 */ }
    const chunk = Number(body.chunk || 0); const chunks = Number(body.chunks || 1);
    const fail = failLast && chunks > 1 && chunk === chunks - 1;
    seen.push({ chunk, chunks, devices: (body.devices || []).map((d) => d.key), touch: (body.touch || []).length, fail });
    res.setHeader('Content-Type', 'application/json');
    if (fail) { res.statusCode = 503; return res.end(JSON.stringify({ ok: false, reason: '큰 본문 처리 혼잡(시험)' })); }
    res.end(JSON.stringify({ ok: true, saved: { touched: (body.touch || []).length } }));
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
after(() => { try { srv.close(); } catch { /* */ } config.agent.centralUrl = ''; config.agent.centralToken = ''; try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

test('뒤 청크만 실패한 push 뒤 — 상태가 예전에 보낸 것과 같아져도 레코드를 다시 보낸다', async () => {
  if (!(await db.available())) return;
  config.agent.name = 'edge-p342'; config.agent.centralUrl = `http://127.0.0.1:${srv.address().port}`; config.agent.centralToken = 'ctok-p342';
  const cvp = reg.saveServer({ name: 'cvp-p', host: 'https://10.99.0.9', authMode: 'token', token: 'T', verifyTls: false, agent: 'edge-p342' });
  const N = 12;
  // 기준 시각: 실제 시각에서 한 시간 전 정시로 떨어뜨린다(미래 시각 clamp · 날 경계를 피한다)
  const t0 = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 3_600_000;
  let m = 0;
  const save = async (e5) => {
    m++;
    const devices = Array.from({ length: N }, (_, i) => ({ key: `sw${i}`, ts: t0 + m * 60_000, hostname: `sw${i}`,
      ports: Array.from({ length: 64 }, (_, n) => ({ name: `Ethernet${n + 1}`, oper: n + 1 === 5 ? e5 : 'up', admin: 'up', speedBps: 1e10, desc: `server-${n + 1}-uplink-description-padding-padding-padding-padding` })) }));
    await db.saveDevices({ agent: '', cvpId: cvp.id, devices });
  };
  const doPush = async () => { seen = []; const r = await push.pushCvpNow(); return { r, records: seen.filter((x) => !x.fail).reduce((a, x) => a + x.devices.length, 0), touch: seen[0]?.touch ?? 0, chunks: seen.length }; };

  await save('up');
  const p1 = await doPush();
  assert.equal(p1.r.ok, true, JSON.stringify(p1.r));
  assert.equal(p1.records, N); assert.ok(p1.chunks >= 2, `여러 청크여야 재현된다(청크 ${p1.chunks})`);

  // 상태가 바뀐 push — 마지막 청크만 503. 앞 청크의 레코드는 중앙에 들어갔다
  await save('down');
  failLast = true;
  const p2 = await doPush();
  failLast = false;
  assert.equal(p2.r.ok, false);
  assert.ok(p2.records > 0 && p2.records < N, `앞 청크만 적재(레코드 ${p2.records}/${N})`);

  // 상태가 처음(①에서 보낸 것)과 같아졌다 — 그래도 레코드를 다시 보낸다(예전: 전부 touch — 중앙은 down 으로 남는다)
  await save('up');
  const p3 = await doPush();
  assert.equal(p3.r.ok, true, JSON.stringify(p3.r));
  assert.deepEqual([p3.records, p3.touch], [N, 0], '실패한 push 에 실었던 장비는 해시가 같아도 다시 보낸다');

  // 대조: 성공한 뒤 바뀐 것이 없으면 touch 만 간다(매 주기 전량을 다시 보내지 않는다)
  await save('up');
  const p4 = await doPush();
  assert.deepEqual([p4.r.ok, p4.records, p4.touch], [true, 0, N]);
});
