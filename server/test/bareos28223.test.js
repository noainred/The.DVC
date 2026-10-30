/**
 * test/bareos28223.test.js — v2.822.3 2차 검토(5축 + 반증 2인)에서 확정한 결함 중 콘솔·probe 쪽.
 *  C2-6: `bareos-probe --chain` 이 import 하지 않은 함수(jobStatus·jobRuns·chainFromHistory)를 불러 ReferenceError 로 끝났다(v2.822.0 회귀).
 *  C2-8: 명령별 응답 상한(maxBytes 16MB)이 세션 기본값 8MB 와 작은 쪽으로 묶여 실효 8MB 였다 — 요청한 상한을 쓴다(최대 64MB).
 *  P8: 읽지 않고 쌓인 프레임을 청크마다 전부 다시 더했다(프레임 수의 제곱 시간) · 신호 프레임(4바이트)은 바이트 상한에 잡히지 않았다 — 누적 카운터 + 개수 상한.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.SSRF_ALLOW_LOOPBACK = 'true';
const { BareosSession, BNET, MAX_QUEUED_FRAMES } = await import('../src/bareos/console.js');
const { jobRuns } = await import('../src/bareos/director.js');
const { withConsole } = await import('../src/bareos/console.js');
const { startFakeDirector, LOOPBACK_DEPS } = await import('./_fakeBareosDirector.js');

const SRV = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const servers = [];
after(async () => { for (const s of servers) await s.close(); });

const HIST = (name) => [
  { jobid: 100, name, type: 'B', level: 'F', jobstatus: 'T', starttime: '2026-10-20 02:00:00', endtime: '2026-10-20 02:40:00', jobbytes: 1000 },
  { jobid: 110, name, type: 'B', level: 'I', jobstatus: 'T', starttime: '2026-10-21 02:00:00', endtime: '2026-10-21 02:05:00', jobbytes: 10 },
  { jobid: 130, name, type: 'B', level: 'I', jobstatus: 'T', starttime: '2026-10-23 02:00:00', endtime: '2026-10-23 02:05:00', jobbytes: 12 },
];

test('C2-6: bareos-probe --chain 이 끝까지 돈다(포탈 체인 + .bvfs 비교)', async () => {
  const fd = await startFakeDirector({
    name: 'portal', password: 'pw-1',
    handle: (cmd) => {
      if (cmd === '.clients') return { clients: [{ name: 'kr-fd' }] };
      if (cmd.startsWith('llist jobid=130')) return { jobs: [HIST('pv-1-vm-1')[2]] };
      if (cmd.startsWith('list jobs job=pv-1-vm-1')) return { jobs: HIST('pv-1-vm-1') };
      if (cmd.startsWith('.bvfs_get_jobids')) return { jobids: '90,100,110,130' };
      return {};
    },
  });
  servers.push(fd);
  // 비동기 실행 — spawnSync 는 같은 프로세스의 가짜 Director 까지 멈춰 TLS 가 시한으로 끝난다
  const r = await new Promise((res) => execFile(process.execPath, ['src/tools/bareos-probe.js', '--host', '127.0.0.1', '--port', String(fd.port), '--name', 'portal', '--chain', '130', '--timeout', '5'],
    { cwd: SRV, encoding: 'utf8', timeout: 60_000, env: { ...process.env, BAREOS_PASSWORD: 'pw-1', SSRF_ALLOW_LOOPBACK: 'true' } },
    (e, stdout, stderr) => res({ status: e ? (e.code ?? 1) : 0, stdout, stderr })));
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.doesNotMatch(`${r.stdout}${r.stderr}`, /is not defined/);
  assert.match(r.stdout, /포탈이 쓰는 체인\(잡 ‘pv-1-vm-1’ 의 이력\): 100, 110, 130/);
  assert.match(r.stdout, /\.bvfs_get_jobids: 90, 100, 110, 130 {2}← 다르다/);
});

test('C2-8: 명령별 상한 16MB 가 실제로 16MB 다(세션 기본 8MB 에 묶이지 않는다) · 그 상한을 넘으면 too-large', async () => {
  const pad = 'x'.repeat(200);
  const rows = (n) => Array.from({ length: n }, (_, i) => ({ jobid: 1000 + i, name: 'pv-1-vm-1', type: 'B', level: 'I', jobstatus: 'T', job: pad }));
  let n = 0;
  // 큰 응답은 1MB 프레임 여러 개로 보낸다(프레임 하나 상한 MAX_FRAME_BYTES 4MB — Director 가 큰 JSON 을 나눠 보내는지는 실환경 미확인·추정)
  const framed = (obj) => {
    const b = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: null, result: obj }));
    const out = [];
    for (let i = 0; i < b.length; i += 1024 * 1024) { const c = b.subarray(i, i + 1024 * 1024); const h = Buffer.alloc(4); h.writeInt32BE(c.length, 0); out.push(h, c); }
    return { raw: out };
  };
  const fd = await startFakeDirector({ name: 'portal', password: 'pw-1', handle: (cmd) => (cmd.startsWith('list jobs job=') ? framed({ jobs: rows(n) }) : {}) });
  servers.push(fd);
  const conn = { host: '127.0.0.1', port: fd.port, name: 'portal', password: 'pw-1', timeoutMs: 20_000 };
  n = 45_000;   // 약 12MB(8MB 기본 상한보다 크고 16MB 보다 작다)
  const got = await withConsole(conn, (s) => jobRuns(s, 'pv-1-vm-1'), LOOPBACK_DEPS);
  assert.equal(got.length, 45_000);
  assert.equal(got[0].jobid, 1000 + 44_999, '최신 먼저');
  n = 75_000;   // 약 20MB — 16MB 를 넘는다
  await assert.rejects(withConsole(conn, (s) => jobRuns(s, 'pv-1-vm-1'), LOOPBACK_DEPS), (e) => e.code === 'too-large');
});

test('P8: 읽지 않은 신호 프레임이 상한을 넘으면 끊는다 · 쌓기는 선형 시간', () => {
  const sock = new EventEmitter();
  sock.write = () => true; sock.destroy = () => {}; sock.end = () => {};
  const s = new BareosSession(sock, { timeoutMs: 5000, maxResponseBytes: 8 * 1024 * 1024 });
  const hb = Buffer.alloc(4); hb.writeInt32BE(BNET.HEARTBEAT, 0);
  const t0 = Date.now();
  // 한 청크에 2만 프레임씩 — 예전 방식(청크마다 전부 다시 더하기)이면 청크 수 × 쌓인 프레임 수만큼 돈다
  const chunk = Buffer.concat(Array.from({ length: 20_000 }, () => hb));
  for (let i = 0; i * 20_000 <= MAX_QUEUED_FRAMES && !s._fatal; i++) sock.emit('data', chunk);
  assert.equal(s._fatal?.code, 'too-large');
  assert.ok(s._frames.length <= MAX_QUEUED_FRAMES);
  assert.ok(Date.now() - t0 < 3_000, `${Date.now() - t0}ms`);
  // 정상 소비 뒤에는 카운터가 0 으로 돌아온다(누수 없음)
  const sock2 = new EventEmitter(); sock2.write = () => true; sock2.destroy = () => {};
  const s2 = new BareosSession(sock2, { timeoutMs: 5000, maxResponseBytes: 1024 });
  const body = Buffer.from('{"x":1}'); const head = Buffer.alloc(4); head.writeInt32BE(body.length, 0);
  sock2.emit('data', Buffer.concat([head, body, head, body]));
  assert.equal(s2._queuedBytes, body.length * 2);
  return s2._next(Date.now() + 1000).then(() => s2._next(Date.now() + 1000)).then(() => assert.equal(s2._queuedBytes, 0));
});
