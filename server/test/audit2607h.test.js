/**
 * v2.607 통합 단계 — 그룹 보고의 '배정 밖' 잔여 2건.
 *
 * INT2607-01 수집 서버 수정에서 url 이 바뀌어 저장 토큰을 폐기했으면 updateCollector 응답이 droppedSecrets 를 싣는다
 *   (normalize 가 돌려준 목록을 버려 화면의 '다시 입력' 안내가 수집 서버에서만 뜨지 않았다 — 그룹 g 보고).
 * INT2607-02 SAN push 재전송의 청크 0 이 실패해도, 첫 시도가 이미 교체한 부분 목록이 중앙에 남아 있음을 말한다
 *   ('직전 push 그대로' 는 거짓 — 그룹 e 가 curUserPush 에서 찾은 같은 구멍의 형제).
 * push 는 목 HTTP 중앙으로 실제 호출한다. 기준 시각은 고정값 T0.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-2607h-'));
Object.assign(process.env, {
  CONFIG_DIR: CFG, CENTRAL_TOKEN: 'shared-2607h', AGENT_NAME: 'e1', DATA_SOURCE: 'live',
  IPAM_WRITE_WORKER: '0', SSRF_ALLOW_LOOPBACK: 'true', SANSW_PUSH_CHUNK_BYTES: '65536',
});
fs.writeFileSync(path.join(CFG, 'vcenters.json'), JSON.stringify({ vcenters: [] }));

const got = [];
const replies = new Map();
const central = http.createServer((q, r) => {
  const ch = []; q.on('data', (c) => ch.push(c));
  q.on('end', () => {
    let b = Buffer.concat(ch);
    try { if (q.headers['content-encoding'] === 'gzip') b = zlib.gunzipSync(b); } catch { /* */ }
    let body = null; try { body = JSON.parse(b.toString('utf8') || 'null'); } catch { body = null; }
    const p = q.url.split('?')[0];
    got.push({ path: p, body });
    const fn = replies.get(p);
    const out = fn ? fn(body) : { status: 200, json: { ok: true } };
    r.writeHead(out.status, { 'content-type': 'application/json' }); r.end(JSON.stringify(out.json));
  });
});
await new Promise((r) => central.listen(0, '127.0.0.1', r));
test.after(() => central.close());

const { config } = await import('../src/config.js');
config.agent.centralUrl = `http://127.0.0.1:${central.address().port}`;
config.agent.centralToken = 'shared-2607h';
config.agent.name = 'e1';
const quiet = async (fn) => { const w = console.warn; const l = console.log; console.warn = () => {}; console.log = () => {}; try { return await fn(); } finally { console.warn = w; console.log = l; } };
const T0 = 1_780_000_000_000;

test('INT2607-01: 수집 서버 url 을 바꾸고 토큰을 비우면 폐기 사실을 응답에 싣는다', async () => {
  const reg = await import('../src/collector/registry.js');
  const a = reg.addCollector({ id: 'site-a', name: 'site-a', url: 'https://10.10.0.1:4000', token: 'TOKEN-A' });
  assert.equal(a.ok, true, JSON.stringify(a));
  // url 그대로 + 빈 토큰 → 승계, 폐기 없음
  const same = reg.updateCollector('site-a', { name: 'site-a', url: 'https://10.10.0.1:4000', token: '' });
  assert.equal(same.ok, true, JSON.stringify(same));
  assert.equal(same.droppedSecrets, undefined);
  // url 변경 + 빈 토큰 → 폐기하고 응답이 말한다(수정 전: 필드 없음)
  const moved = reg.updateCollector('site-a', { name: 'site-a', url: 'https://10.10.0.2:4000', token: '' });
  assert.equal(moved.ok, true, JSON.stringify(moved));
  assert.deepEqual(moved.droppedSecrets, ['token']);
});

test('INT2607-02: SAN 재전송의 청크 0 이 실패해도 첫 시도의 부분 목록이 중앙에 남아 있다고 말한다', async () => {
  const store = await import('../src/sanswitch/store.js');
  const push = await import('../src/sanswitch/push.js');
  const pad = 'x'.repeat(40_000);
  for (const id of ['sw1', 'sw2', 'sw3']) store.putSnapshot({ deviceId: id, name: id, ok: true, collectedAt: T0, ports: { total: 0, list: [] }, extra: { pad } });
  // 첫 시도: 청크 0 성공, 청크 1 실패 → 재전송: 청크 0 부터 실패
  let calls = 0;
  replies.set('/api/central/sanswitch-data', (b) => {
    calls += 1;
    if (calls === 1 && b?.chunk === 0) return { status: 200, json: { ok: true } };
    return { status: 400, json: { ok: false, reason: 'x' } };
  });
  try {
    const r = await quiet(() => push.pushSanSwitchNow());
    assert.equal(r.ok, false);
    assert.equal(push.sanSwitchPushStatus().resent, true);
    assert.doesNotMatch(r.reason, /직전 push 그대로/, '재전송 청크 0 실패여도 중앙에는 첫 시도의 교체분이 있다');
    assert.match(r.reason, /중앙 목록이 부분 상태/);
    assert.equal(r.centralPartial.receivedChunks, 1);
  } finally {
    replies.delete('/api/central/sanswitch-data');
    for (const id of ['sw1', 'sw2', 'sw3']) store.dropSnapshot(id);
  }
});
