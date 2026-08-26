// IP 스캔 별도 프로세스(v2.363) — 워커 포크 경로와 인라인 폴백이 같은 형태를 돌려주는지,
// fping 인자 형식을 고정한다. (실제 네트워크에 의존하지 않게 127.0.0.1 의 닫힌 고포트만 스캔)
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.IPAM_FPING = '0'; // fping 미사용 경로로 결정적 검증(설치 여부 무관)

const { runScan } = await import('../src/ipam/scanRunner.js');
const { fpingArgs } = await import('../src/ipam/scan.js');

const JOB = { ranges: ['127.0.0.1'], ports: [9], timeoutMs: 200, reverseDns: false, ping: false };

test('runScan: 워커(별도 프로세스) 경로 — viaWorker=true, 형태 유지', async () => {
  delete process.env.IPAM_SCAN_WORKER; // 워커 활성(기본)
  const r = await runScan(JOB);
  assert.equal(r.viaWorker, true, '별도 프로세스에서 실행되어야 한다');
  assert.equal(r.scanned, 1);
  assert.ok(Array.isArray(r.alive));
});

test('runScan: 인라인 폴백(IPAM_SCAN_WORKER=0) — viaWorker=false, 동일 형태', async () => {
  process.env.IPAM_SCAN_WORKER = '0';
  const r = await runScan(JOB);
  assert.equal(r.viaWorker, false, '워커 비활성 시 같은 프로세스 폴백');
  assert.equal(r.scanned, 1);
  assert.ok(Array.isArray(r.alive));
  delete process.env.IPAM_SCAN_WORKER;
});

test('fpingArgs: -a -q -r 0 -t <ms> + IP 목록', () => {
  assert.deepEqual(fpingArgs(['10.0.0.1', '10.0.0.2'], 700), ['-a', '-q', '-r', '0', '-t', '700', '10.0.0.1', '10.0.0.2']);
  assert.deepEqual(fpingArgs(['10.0.0.1'], 30), ['-a', '-q', '-r', '0', '-t', '50', '10.0.0.1']); // 하한 50ms
});
