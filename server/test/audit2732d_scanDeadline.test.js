// v2.732(점검 2회차 B4-02): IP 스캔 워커가 데드라인을 넘기면 같은 스캔을 메인 프로세스에서 '시한 없이' 다시 돌리지 않는다.
// 예전에는 데드라인 오류도 인라인 폴백 catch 로 들어가 데드라인 + 스캔 본래 길이만큼 걸리고(재현 135초), 그동안 ping 자식·TCP 소켓이
// v2.363 이 떼어낸 메인 포탈 프로세스로 돌아왔다. 여기서는 PATH 앞의 가짜 `ping`(sleep)으로 워커를 묶고 데드라인을 짧게 둔다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'scan2732d-'));
const PINGLOG = path.join(TMP, 'pids');
// 가짜 ping: 자기 PID 를 남기고 sleep 으로 바뀐다(exec — execFile 시한이 sleep 자체를 죽인다).
fs.writeFileSync(path.join(TMP, 'ping'), `#!/bin/sh\necho $$ >> "${PINGLOG}"\nexec sleep 30\n`, { mode: 0o755 });
process.env.PATH = `${TMP}:${process.env.PATH}`;
process.env.IPAM_FPING = '0';
delete process.env.IPAM_SCAN_WORKER;

const runner = await import('../src/ipam/scanRunner.js');

const pids = () => { try { return fs.readFileSync(PINGLOG, 'utf8').split('\n').map((x) => Number(x)).filter((n) => n > 0); } catch { return []; } };

after(() => {
  runner._setScanDeadlineOverrideForTest?.(null);
  // 워커를 SIGKILL 하면 그 자식(가짜 ping = sleep)은 고아로 남는다 — 테스트가 직접 정리한다.
  for (const pid of pids()) { try { process.kill(pid, 'SIGKILL'); } catch { /* 이미 끝남 */ } }
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('① fallbackAllowed — 데드라인 표지 오류만 폴백하지 않는다', () => {
  const dl = new Error('스캔 데드라인(60s) 초과 — 자식 종료'); dl.code = runner.SCAN_DEADLINE_CODE;
  assert.equal(runner.SCAN_DEADLINE_CODE, 'SCAN_DEADLINE');
  assert.equal(runner.fallbackAllowed(dl), false);
  assert.equal(runner.fallbackAllowed(new Error('워커가 결과 없이 종료(code=1)')), true);
  const spawn = new Error('spawn EMFILE'); spawn.code = 'EMFILE';
  assert.equal(runner.fallbackAllowed(spawn), true);
  assert.equal(runner.fallbackAllowed(undefined), true);
});

test('② 워커 데드라인 초과 → reject(SCAN_DEADLINE) · 메인에서 같은 스캔을 다시 돌리지 않는다', { timeout: 60_000 }, async () => {
  runner._setScanDeadlineOverrideForTest(1500);
  const t0 = Date.now();
  const job = { ranges: ['192.0.2.1'], ports: [], concurrency: 1, timeoutMs: 3000, reverseDns: false, ping: true };
  await assert.rejects(
    runner.runScan(job),
    (e) => e?.code === 'SCAN_DEADLINE',
    '데드라인 초과는 그대로 실패로 올라와야 한다(인라인 재실행 금지)',
  );
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 4500, `데드라인 근처에서 끝나야 한다(경과 ${elapsed}ms)`);
  // 인라인 폴백이 돌았다면 이 프로세스가 가짜 ping 을 한 번 더 띄운다 — 잠깐 기다려 본다.
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(pids().length, 1, `ping 은 워커에서 1번만 떠야 한다(메인 재실행 없음) — 기록 ${pids().length}건`);
  runner._setScanDeadlineOverrideForTest(null);
});
