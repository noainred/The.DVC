import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idrac-scanlog-'));
process.env.CONFIG_DIR = tmp;

let log;
before(async () => { log = await import('../src/idrac/scanLog.js'); });
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

test('append/list: 최신순 정렬 + 필드 정규화 + 민감정보 미저장', () => {
  log.appendIdracScanLog({ trigger: 'periodic', kind: 'central', datacenterId: 'OC2', service: '서비스A', scanned: 254, found: 9, registered: 2, durationMs: 4200 });
  log.appendIdracScanLog({ trigger: 'manual', kind: 'delegated', phase: 'dispatch', datacenterId: 'AZ', agent: 'agent-az', dispatch: 'poll', reqId: 'idscan_x_1', password: 'MUST-NOT-STORE' });
  log.appendIdracScanLog({ trigger: 'manual', kind: 'delegated', phase: 'result', datacenterId: 'AZ', agent: 'agent-az', dispatch: 'poll', reqId: 'idscan_x_1', scanned: 100, found: 3, registered: 3, durationMs: 9000 });

  const list = log.listIdracScanLog();
  assert.equal(list.length, 3);
  // 최신(마지막 append)이 맨 앞.
  assert.equal(list[0].reqId, 'idscan_x_1');
  assert.equal(list[0].phase, 'result');
  assert.equal(list[1].phase, 'dispatch');
  assert.equal(list[2].datacenterId, 'OC2');
  assert.equal(list[2].trigger, 'periodic');
  assert.equal(list[2].kind, 'central');
  assert.equal(list[2].found, 9);
  // 자격증명 등 정의되지 않은 필드는 저장하지 않는다.
  for (const e of list) assert.ok(!('password' in e), '비밀번호가 로그에 저장되면 안 됨');
});

test('법인별 필터 + limit + 법인 목록', () => {
  const az = log.listIdracScanLog({ datacenterId: 'AZ' });
  assert.equal(az.length, 2);
  assert.ok(az.every((e) => e.datacenterId === 'AZ'));
  const one = log.listIdracScanLog({ limit: 1 });
  assert.equal(one.length, 1);
  assert.deepEqual(log.idracScanLogDatacenters(), ['AZ', 'OC2']);
  // 미등록 법인 필터 = 빈 목록(전체가 아니라).
  assert.equal(log.listIdracScanLog({ datacenterId: 'NOPE' }).length, 0);
});

test('오류 메시지 500자 절단 + 재시작(캐시 리셋) 후에도 파일에서 복원', () => {
  log.appendIdracScanLog({ trigger: 'periodic', datacenterId: 'GM1', error: 'x'.repeat(2000) });
  log._resetIdracScanLogCache(); // 프로세스 재시작 시뮬레이션 — 파일에서 다시 읽기
  const list = log.listIdracScanLog({ datacenterId: 'GM1' });
  assert.equal(list.length, 1);
  assert.equal(list[0].error.length, 500);
});

test('상한(2000건) 초과 시 오래된 것부터 삭제', () => {
  // 2000건을 실제 append(파일 2000회 재기록)하면 느리므로, 파일을 직접 시드하고 캐시를 리셋한다.
  const FILE = path.join(tmp, 'idrac-scan-log.json');
  const entries = Array.from({ length: 2000 }, (_, i) => ({ at: i + 1, trigger: 'periodic', phase: 'result', kind: 'central', datacenterId: `DC${i}`, service: '', agent: '', dispatch: '', reqId: '', scanned: 1, found: 0, registered: 0, durationMs: 1, error: null }));
  fs.writeFileSync(FILE, JSON.stringify({ entries }));
  log._resetIdracScanLogCache();
  log.appendIdracScanLog({ trigger: 'manual', datacenterId: 'NEWEST' });
  log._resetIdracScanLogCache();
  const list = log.listIdracScanLog({ limit: 1000 });
  assert.equal(list[0].datacenterId, 'NEWEST', '새 항목은 유지');
  // 총량은 상한(2000)을 넘지 않고, 가장 오래된 DC0가 삭제됐다.
  const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  assert.equal(raw.entries.length, 2000);
  assert.equal(raw.entries[0].datacenterId, 'DC1');
});
