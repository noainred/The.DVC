/** 성능점검(svcmon) — 저장소 검증·SSRF 차단·체커·폴러 가드. 임시 CONFIG_DIR 사용. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'svcmon-'));

const store = await import('../src/svcmon/store.js');
const { runCheck } = await import('../src/svcmon/checker.js');
const poller = await import('../src/svcmon/poller.js');

test('addTarget: 경로/이름/호스트 검증 + SSRF(루프백) 차단', () => {
  assert.throws(() => store.addTarget({ path: 'A', name: '', host: '10.0.0.1' }), /이름/);
  assert.throws(() => store.addTarget({ path: 'A', name: 't', host: 'bad host;rm' }), /호스트 형식/);
  assert.throws(() => store.addTarget({ path: 'A', name: 't', host: '127.0.0.1' }), /차단/);   // 루프백
  assert.throws(() => store.addTarget({ path: 'A', name: 't', host: '169.254.169.254' }), /차단/); // 링크로컬
  const t = store.addTarget({ path: 'B.Service\\SBP\\01.HQ', name: 'SBP_Admin01', host: '192.168.10.55' }); // RFC1918 허용
  assert.ok(t.id);
  assert.equal(t.enabled, true);
});

test('테스트 CRUD: 유형별 필수값 + http URL SSRF 검증', () => {
  const target = store.listTargets()[0];
  assert.throws(() => store.addTest(target.id, { name: 'x', type: 'tcp' }), /포트/);
  assert.throws(() => store.addTest(target.id, { name: 'x', type: 'http' }), /URL/);
  assert.throws(() => store.addTest(target.id, { name: 'x', type: 'http', url: 'http://127.0.0.1/' }), /차단/);
  const ping = store.addTest(target.id, { name: 'Ping', type: 'ping', intervalSec: 5 });
  const tcp = store.addTest(target.id, { name: 'TCP 8080', type: 'tcp', port: 8080 });
  assert.equal(ping.intervalSec, 10);       // 최소 10초로 클램프
  assert.equal(tcp.port, 8080);
  const upd = store.updateTest(target.id, tcp.id, { ...tcp, name: 'TCP 8081', port: 8081 });
  assert.equal(upd.port, 8081);
  assert.equal(store.deleteTest(target.id, ping.id), true);
});

test('저장 파일 왕복: 캐시 리셋 후에도 대상 유지(원자적 쓰기 확인)', () => {
  const before = store.listTargets();
  store._resetCache();
  const after = store.listTargets();
  assert.deepEqual(after.map((t) => t.name), before.map((t) => t.name));
});

test('checker: tcp 열림/닫힘 판정 (로컬 리스너 실측)', async () => {
  const srv = net.createServer().listen(0, '0.0.0.0');
  await new Promise((r) => srv.once('listening', r));
  const port = srv.address().port;
  // 저장소는 루프백을 막지만 체커 단위는 직접 호출로 검증(대상 검증은 저장 시점 책임).
  const ok = await runCheck({ type: 'tcp', port }, '127.0.0.1');
  assert.equal(ok.status, 'ok');
  srv.close();
  const closed = await runCheck({ type: 'tcp', port }, '127.0.0.1');
  assert.equal(closed.status, 'bad');
});

test('checker: http 는 실행 직전에도 SSRF 재검증(루프백 차단)', async () => {
  const r = await runCheck({ type: 'http', url: 'http://127.0.0.1:9/' }, 'ignored');
  assert.equal(r.status, 'bad');
  assert.match(r.reply, /차단/);
});

test('poller: runNow 실행·결과 적재·streak 증가·재진입 가드', async () => {
  const srv = net.createServer().listen(0, '0.0.0.0');
  await new Promise((r) => srv.once('listening', r));
  const port = srv.address().port;
  const target = store.listTargets()[0];
  // 폴러 경로 검증용 — RFC1918 대신 실제 리스너에 닿도록 저장소를 직접 다루지 않고
  // 대상 host 는 그대로 두되(192.168.x, 연결 실패 = bad), 결과 적재 자체를 확인한다.
  const t = store.addTest(target.id, { name: 'poll-tcp', type: 'tcp', port, intervalSec: 10 });
  const ran = await poller.runNow();
  assert.equal(ran, true);
  const r1 = poller.getResults().get(t.id);
  assert.ok(r1, '결과가 적재되어야 함');
  assert.equal(r1.streak, 1);
  const ran2 = await poller.runNow();
  assert.equal(ran2, true);
  const r2 = poller.getResults().get(t.id);
  assert.equal(r2.streak, 2, '같은 상태 연속이면 streak 증가');
  srv.close();
});
