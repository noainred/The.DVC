/**
 * test/scanRestart2737.test.js — **실제 포탈 프로세스**를 조사 도중 SIGTERM 으로 끊고 다시 띄워, 끊긴 아이실론 조사가 자동으로 이어지는지 본다(v2.737).
 *
 * 사용자 신고: "프로그램이 업그레이드 되면 scan 하던게 중단되는 버그". 업그레이드 재시작은 systemd 가 SIGTERM 을 보내는 것과 같다.
 *   ① 가짜 아이실론 = 이 테스트 프로세스의 SSH 서버. 받은 명령을 **이 컨테이너의 sh 로 실제로 실행**한다(PATH 맨 앞의 가짜 du — 18초 잠든다).
 *   ② 포탈 A(node src/index.js)를 띄우고 '지금 수집' → 실행 중 스캔 기록에 장비 쪽 작업 id 가 남을 때까지 기다린 뒤 SIGTERM.
 *   ③ 포탈 B 를 같은 CONFIG_DIR 로 띄운다 — 재개 지연(10초) 뒤 **같은 du 작업에 다시 붙어** 결과를 받아야 한다.
 *      증거: du 실행 횟수 1번(새로 돌리지 않았다) · 결과 저장 · 재개 이력 'resumed' · 폴러 기록의 '이어 받음'.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ssh2 from 'ssh2';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'scanrestart2737-'));
const FAKE = fs.mkdtempSync(path.join(os.tmpdir(), 'fakedu2737r-'));
const COUNT = path.join(FAKE, 'count');
const ROOT = '/ifs/data/users';
const procs = new Set();
const closers = [];
const jobs = new Set();

fs.writeFileSync(path.join(FAKE, 'du'), [
  '#!/bin/sh',
  'for a; do last="$a"; done',
  'echo run >> "$FAKE_DU_COUNT"',
  'sleep "$FAKE_DU_SLEEP"',
  'printf \'40G\\t%s/alpha.kim\\n12G\\t%s/beta.lee\\n52G\\t%s\\n\' "$last" "$last" "$last"',
].join('\n') + '\n', { mode: 0o755 });

const shEnv = { ...process.env, PATH: `${FAKE}:${process.env.PATH}`, FAKE_DU_SLEEP: '18', FAKE_DU_COUNT: COUNT };
const hostKey = () => crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'sec1', format: 'pem' });

/** 공개키면 누구든 받는 가짜 아이실론 — 명령을 로컬 sh 로 실제 실행(분리 실행 명령이 그대로 돈다). */
async function fakeIsilon() {
  const st = { commands: [] };
  const srv = new ssh2.Server({ hostKeys: [hostKey()] }, (client) => {
    client.on('authentication', (ctx) => (ctx.method === 'publickey' ? ctx.accept() : ctx.reject(['publickey'])));
    client.on('ready', () => client.on('session', (accept) => {
      const session = accept();
      session.on('exec', (acc, _rej, info) => {
        st.commands.push(info.command);
        const m = /J="[^"]*"\/([A-Za-z0-9_-]+)/.exec(info.command);
        if (m) jobs.add(m[1]);
        const stream = acc();
        const ch = spawn('sh', ['-c', info.command], { env: shEnv, stdio: ['ignore', 'pipe', 'pipe'] });
        ch.stdout.on('data', (d) => stream.write(d));
        ch.stderr.on('data', (d) => stream.stderr.write(d));
        ch.on('close', (code) => { try { stream.exit(code ?? 1); stream.end(); } catch { /* 세션이 이미 끊겼다 */ } });
      });
    }));
    client.on('error', () => {});
  });
  const port = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
  closers.push(() => new Promise((r) => srv.close(() => r())));
  return { port, st };
}

const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

function startPortal(port, tag) {
  const env = {
    ...process.env, CONFIG_DIR: DIR, DATA_SOURCE: 'live', AUTH_ENABLED: 'false', PORT: String(port), HOST: '127.0.0.1',
    SSRF_ALLOW_LOOPBACK: 'true', SSH_HOSTKEY_POLICY: 'observe', SCAN_RESUME_DELAY_MS: '10000', IDRAC_ENABLED: 'false',
    STALL_WATCH: '0', NODE_ENV: 'test',
  };
  delete env.SCAN_RESUME;
  const p = spawn(process.execPath, ['src/index.js'], { cwd: SERVER, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = [];
  const keep = (d) => { log.push(String(d)); if (log.length > 400) log.shift(); };
  p.stdout.on('data', keep); p.stderr.on('data', keep);
  procs.add(p);
  p.on('exit', () => procs.delete(p));
  p.tag = tag; p.log = log;
  return p;
}
const stopPortal = (p, sig = 'SIGTERM') => new Promise((r) => { if (p.exitCode != null || p.signalCode) return r(); p.once('exit', () => r()); p.kill(sig); });

const waitFor = async (fn, ms, what) => {
  const until = Date.now() + ms;
  for (;;) {
    let v = null; try { v = await fn(); } catch { /* 아직 */ }
    if (v) return v;
    if (Date.now() > until) throw new Error(`시간 초과: ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
};
const api = (port, p, opt = {}) => fetch(`http://127.0.0.1:${port}/api${p}`, { ...opt, headers: { 'Content-Type': 'application/json', ...(opt.headers || {}) } });
const journal = () => JSON.parse(fs.readFileSync(path.join(DIR, 'scan-journal.json'), 'utf8'));

after(async () => {
  for (const p of [...procs]) await stopPortal(p, 'SIGKILL');
  // 남은 분리 실행 작업(가짜 du)을 멈춘다 — 실패한 실행이 컨테이너에 잠든 프로세스를 남기지 않게.
  const D = await import('../src/isidu/detach.js');
  for (const id of jobs) { await new Promise((r) => { const c = spawn('sh', ['-c', D.killCommand(id)], { env: shEnv, stdio: 'ignore' }); c.on('close', r); }); }
  for (const c of closers.reverse()) { try { await c(); } catch { /* */ } }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ }
  try { fs.rmSync(FAKE, { recursive: true, force: true }); } catch { /* */ }
});

test('재시작으로 끊긴 아이실론 조사 — 다음 기동이 장비에서 돌던 같은 du 작업에 다시 붙어 결과를 받는다(du 1번)', { timeout: 150_000 }, async () => {
  const fk = await fakeIsilon();
  const portA = await freePort();
  const A = startPortal(portA, 'A');
  await waitFor(async () => (await api(portA, '/health')).ok, 40_000, '포탈 A 기동');

  const put = await api(portA, '/tools/isilon-dirusage/settings', { method: 'PUT', body: JSON.stringify({
    targets: [{ id: 'tgt-rs', label: '재시작 시험', host: '127.0.0.1', port: fk.port, username: 'admin', auth: 'key', path: ROOT, sizeMode: 'h', timeoutMin: 10, intervalHours: 24 }],
  }) });
  assert.equal(put.status, 200, await put.text());
  const run = await api(portA, '/tools/isilon-dirusage/run', { method: 'POST', body: JSON.stringify({ ids: ['tgt-rs'] }) });
  assert.equal(run.status, 202);
  assert.deepEqual((await run.json()).started, ['tgt-rs']);

  // 장비 쪽 작업 id 가 실행 중 스캔 기록에 남을 때까지(분리 실행이 시작됐다)
  const jobId = await waitFor(() => journal().active?.['isidu:tgt-rs']?.meta?.jobId, 30_000, '작업 id 기록');
  assert.match(jobId, /^tgt-rs-/);
  await stopPortal(A, 'SIGTERM');                                   // 업그레이드 재시작과 같다
  assert.ok(journal().active?.['isidu:tgt-rs'], '끝나지 못한 조사가 기록에 남아 있다(종료 경로가 지우지 않는다)');
  assert.equal(fs.readFileSync(COUNT, 'utf8').trim().split('\n').length, 1, '포탈이 끝났어도 장비의 du 는 계속 돈다');

  const portB = await freePort();
  const B = startPortal(portB, 'B');
  await waitFor(async () => (await api(portB, '/health')).ok, 40_000, '포탈 B 기동');
  const pre = await (await api(portB, '/tools/isilon-dirusage')).json();
  const row0 = pre.targets.find((x) => x.id === 'tgt-rs');
  assert.ok(row0.interrupted, '재개 전에는 화면이 "재시작으로 중단됨 · 재개 대기" 를 말한다');

  const row = await waitFor(async () => {
    const j = await (await api(portB, '/tools/isilon-dirusage')).json();
    const r = j.targets.find((x) => x.id === 'tgt-rs');
    return r?.okScan ? { r, j } : null;
  }, 90_000, '재개된 조사의 결과');
  assert.equal(row.r.okScan.count, 2, '두 폴더(alpha.kim · beta.lee)');
  assert.equal(row.r.lastResume?.outcome, 'resumed');
  assert.equal(fs.readFileSync(COUNT, 'utf8').trim().split('\n').length, 1, 'du 를 새로 돌리지 않았다 — 재시작 전 작업을 이어 받았다');
  const recent = (row.j.poller.recent || []).map((x) => x.msg || '').join('\n');
  assert.match(recent, /재시작 전 장비에서 돌던 du 결과를 이어 받음/);
  assert.equal(journal().active?.['isidu:tgt-rs'], undefined, '끝나면 기록을 지운다');
  assert.equal(journal().history?.[0]?.outcome, 'resumed');
  assert.equal(fk.st.commands.filter((c) => c.includes('DVC-STARTED')).length, 1, '시작 명령은 포탈 A 가 보낸 한 번뿐');
  await stopPortal(B);
});
