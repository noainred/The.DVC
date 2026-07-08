import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'idscan-'));
const { enqueueIdracScan, takeIdracScanJobs, setIdracScanResult, setIdracScanProgress, getIdracScanResult, listIdracScanJobs, getIdracScanJobLog, recentPollingAgents, cancelIdracScanJob } = await import('../src/central/idracScanJobs.js');

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

test('위임 스캔: enqueue 시 총 IP 수 + 진행률 보고', () => {
  const reqId = enqueueIdracScan('OSAKA', { ips: '10.2.0.1-10.2.0.20', username: 'root', password: 'pw' });
  // enqueue 시점에 총 IP 수가 분모로 잡힘(20개)
  assert.equal(getIdracScanResult(reqId).progress.total, 20);
  assert.equal(getIdracScanResult(reqId).progress.scanned, 0);

  takeIdracScanJobs('OSAKA');
  // 중간 진행률 보고 → scanned 갱신, running 유지
  setIdracScanProgress(reqId, { scanned: 12, total: 20 });
  const r = getIdracScanResult(reqId);
  assert.equal(r.state, 'running');
  assert.equal(r.progress.scanned, 12);
  assert.equal(r.progress.total, 20);
});

test('위임 스캔: 같은 에이전트+법인의 대기 잡은 중복 적재되지 않음(dedup)', () => {
  const a = enqueueIdracScan('agent-MI', { ips: '10.94.42.1-10', username: 'root', password: 'pw', datacenterId: 'mi' });
  const b = enqueueIdracScan('agent-MI', { ips: '10.94.42.1-10', username: 'root', password: 'pw', datacenterId: 'mi' });
  assert.equal(a, b, '동일 에이전트+법인의 대기 스캔은 같은 reqId(중복 미적재)');
  // 다른 법인은 별개 잡.
  const c = enqueueIdracScan('agent-MI', { ips: '10.94.50.1-10', username: 'root', password: 'pw', datacenterId: 'mi2' });
  assert.notEqual(a, c);
  // 인출(running)되면 dedup 대상이 아니므로, 이후 같은 법인 재요청은 새 잡을 만든다.
  takeIdracScanJobs('agent-MI');
  const d = enqueueIdracScan('agent-MI', { ips: '10.94.42.1-10', username: 'root', password: 'pw', datacenterId: 'mi' });
  assert.notEqual(a, d, '이미 running으로 넘어간 뒤에는 새 스캔 허용');
});

test('위임 스캔: 알 수 없는 reqId는 unknown', () => {
  assert.equal(getIdracScanResult('nope').state, 'unknown');
});

test('개별 잡 취소: 대기 잡만 취소되고 큐에서 빠진다(인출 후엔 취소 불가)', () => {
  const reqId = enqueueIdracScan('CancelMe', { ips: '10.8.0.1-10', username: 'root', password: 'pw', datacenterId: 'cm' });
  assert.equal(getIdracScanResult(reqId).state, 'pending');

  // 대기 잡 개별 취소 → error, 큐에서 제거되어 인출되지 않음.
  const c = cancelIdracScanJob(reqId);
  assert.equal(c.ok, true);
  assert.equal(getIdracScanResult(reqId).state, 'error');
  assert.equal(takeIdracScanJobs('CancelMe').length, 0, '취소된 잡은 인출되지 않음');

  // 이미 종료된(error) 잡은 재취소 불가.
  assert.equal(cancelIdracScanJob(reqId).ok, false);
  // 알 수 없는 reqId도 실패.
  assert.equal(cancelIdracScanJob('nope').ok, false);

  // 이미 인출된(running) 잡은 개별 취소 대상이 아니다.
  const r2 = enqueueIdracScan('CancelMe2', { ips: '10.8.1.1-5', username: 'root', password: 'pw' });
  takeIdracScanJobs('CancelMe2');
  assert.equal(getIdracScanResult(r2).state, 'running');
  assert.equal(cancelIdracScanJob(r2).ok, false, 'running 잡은 개별 취소 불가');
});

test('스캔 로그 진단: 폴링 기록 없는 pending은 error 힌트 + AGENT_NAME 불일치 시 폴링 중 목록 안내', () => {
  // 담당 에이전트가 한 번도 폴링하지 않은 pending 잡.
  const reqId = enqueueIdracScan('OC2Sandbox', { ips: '10.9.0.1-10', username: 'root', password: 'pw', datacenterId: 'oc2' });
  // 다른 이름('EdgeSeoul')만 중앙에 폴링 중인 상황을 재현.
  takeIdracScanJobs('EdgeSeoul');
  assert.ok(recentPollingAgents(30_000).includes('edgeseoul'), '폴링 기록은 소문자 키로 남는다');

  const log = getIdracScanJobLog(reqId);
  const msgs = log.hints.map((h) => h.msg).join('\n');
  assert.ok(log.hints.some((h) => h.level === 'error' && h.msg.includes('폴링 기록이 없습니다')), '폴링 무기록 error 힌트');
  // OC2Sandbox 이름으로는 폴링이 없지만 EdgeSeoul은 폴링 중 → 불일치를 짚어줘야 한다.
  assert.ok(msgs.includes('edgeseoul'), '현재 폴링 중인 에이전트 이름을 안내');
  assert.ok(msgs.includes('AGENT_NAME'), 'AGENT_NAME 불일치 점검 안내');
});

test('스캔 로그 진단: 수집 서버로 등록·정상인데 폴링만 없으면 방향(PULL/폴링) 차이를 안내', () => {
  // 잡 에이전트가 수집 서버(원격)로는 등록돼 있으나 스캔 폴링 기록이 없는 상황.
  const reqId = enqueueIdracScan('OS2SDBX', { ips: '10.84.76.1-10', username: 'root', password: 'pw', datacenterId: 'oc2sandbox' });
  const collectors = new Set(['os2sdbx', 'oc2sandbox']); // 수집 서버 id/이름(소문자)
  const log = getIdracScanJobLog(reqId, { collectors });
  const msgs = log.hints.map((h) => h.msg).join('\n');
  assert.ok(log.hints.some((h) => h.level === 'error' && h.msg.includes('폴링 기록이 없습니다')), '폴링 무기록 error');
  assert.ok(msgs.includes('수집 서버(원격)로 등록'), '수집 등록 사실 안내');
  assert.ok(msgs.includes('CENTRAL_URL'), '엣지 CENTRAL_URL/TOKEN 점검 안내');
  // 수집 서버로 등록돼 있지 않으면(collectors 미전달) 그 특화 힌트는 나오지 않는다.
  const log2 = getIdracScanJobLog(reqId);
  assert.ok(!log2.hints.some((h) => h.msg.includes('수집 서버(원격)로 등록')), '미등록 시 특화 힌트 없음');
});

test('listIdracScanJobs: 잡 목록 요약(비밀번호·IP 원문 미노출, 최신순)', () => {
  const reqId = enqueueIdracScan('BERLIN', { ips: '10.3.0.1-10.3.0.5', username: 'root', password: 'SECRET', vcenterId: 'OC2', datacenterId: 'oc1' });
  const list = listIdracScanJobs();
  const j = list.find((x) => x.reqId === reqId);
  assert.ok(j, '목록에 포함');
  assert.equal(j.vcenterId, 'OC2');
  assert.equal(j.datacenterId, 'oc1', "'대상' 칸 표시용 datacenterId 노출");
  assert.equal(j.state, 'pending');
  assert.ok(j.progress && j.progress.total === 5);
  // 민감정보(비밀번호·IP 원문)는 절대 노출 금지.
  const serialized = JSON.stringify(list);
  assert.ok(!serialized.includes('SECRET'), '비밀번호 미노출');
  assert.ok(!('password' in j) && !('ips' in j), '비밀번호/IP 필드 없음');
  // 최신순(createdAt 내림차순) 정렬 불변식 — 다른 테스트 잡이 섞여도 단조 비증가여야 함.
  for (let i = 1; i < list.length; i++) {
    assert.ok((list[i - 1].createdAt || 0) >= (list[i].createdAt || 0), 'createdAt 내림차순 정렬');
  }
});
