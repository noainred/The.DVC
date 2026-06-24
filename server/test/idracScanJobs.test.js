import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'idscan-'));
const { enqueueIdracScan, takeIdracScanJobs, setIdracScanResult, getIdracScanResult } = await import('../src/central/idracScanJobs.js');

test('위임 스캔: enqueue → take(에이전트 이름) → result → 폴링 라이프사이클', () => {
  const reqId = enqueueIdracScan('SEOUL', { ips: '10.0.0.1-10', username: 'root', password: 'pw' });
  assert.ok(reqId, 'reqId가 발급되어야 함');
  assert.equal(getIdracScanResult(reqId).state, 'pending');

  // 다른 에이전트 이름으로는 인출되지 않음
  assert.equal(takeIdracScanJobs('TOKYO').length, 0);

  // 담당 에이전트가 인출 → running, 비밀번호 포함
  const jobs = takeIdracScanJobs('seoul'); // 대소문자 무시
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].reqId, reqId);
  assert.equal(jobs[0].password, 'pw');
  assert.equal(getIdracScanResult(reqId).state, 'running');

  // 재인출 시 비어 있음(중복 실행 방지)
  assert.equal(takeIdracScanJobs('seoul').length, 0);

  // 결과 보고 → done, 발견 목록 노출(비밀번호 미포함)
  setIdracScanResult(reqId, { scanned: 10, found: [{ ip: '10.0.0.3', serviceTag: 'ABC123' }], unreachable: 7, registered: 1 });
  const r = getIdracScanResult(reqId);
  assert.equal(r.state, 'done');
  assert.equal(r.foundCount, 1);
  assert.equal(r.found[0].ip, '10.0.0.3');
  assert.equal(r.registered, 1);
  assert.ok(!('password' in r));
});

test('위임 스캔: 오류 보고는 error 상태', () => {
  const reqId = enqueueIdracScan('PARIS', { ips: '10.1.0.0/30', username: 'root', password: 'x' });
  takeIdracScanJobs('PARIS');
  setIdracScanResult(reqId, { error: '인증 실패' });
  const r = getIdracScanResult(reqId);
  assert.equal(r.state, 'error');
  assert.equal(r.error, '인증 실패');
});

test('위임 스캔: 알 수 없는 reqId는 unknown', () => {
  assert.equal(getIdracScanResult('nope').state, 'unknown');
});
