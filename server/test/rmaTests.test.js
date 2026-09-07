import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// v2.418 RMA 확장 — 점검 카탈로그/실행기·스케줄 배정·결과 상태/알림·정책·IP 허용·sudoers.
process.env.CONFIG_DIR = process.env.CONFIG_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'rma-tests-'));

const { buildTest, scheduleItemIssue, judge, testCatalog } = await import('../src/rma/tests.js');
const { runTest, pathAllowed } = await import('../src/rma/testRunner.js');
const { buildCommand, commandAllowed, parseList } = await import('../src/rma/commands.js');
const sch = await import('../src/rma/schedules.js');
const res = await import('../src/rma/testResults.js');
const settings = await import('../src/rma/settings.js');
const { RMA_SUDOERS } = await import('../src/rma/unitTemplate.js');

test('buildTest: 파라미터 검증·기본값·정규식 패턴 허용, 스케줄 항목 주기 범위', () => {
  const b = buildTest('ping', { host: '10.0.0.1' });
  assert.equal(b.ok, true); assert.equal(b.args.count, 3); assert.equal(b.args.maxLossPct, 0);
  assert.equal(buildTest('ping', { host: '10.0.0.1; id' }).ok, false);
  assert.equal(buildTest('text-log', { path: '/var/log/messages', pattern: 'error|fail\\d+' }).ok, true, '정규식 패턴은 text 집합보다 넓다');
  assert.equal(buildTest('text-log', { path: '/var/log/messages', pattern: 'a\x01b' }).ok, false);
  assert.equal(buildTest('rma-itself', {}).central, true);
  assert.equal(scheduleItemIssue({ test: 'tcp', args: { host: 'h', port: 22 }, intervalSec: 60 }), null);
  assert.match(scheduleItemIssue({ test: 'tcp', args: { host: 'h', port: 22 }, intervalSec: 5 }), /주기/);
  assert.match(scheduleItemIssue({ test: 'nope', args: {}, intervalSec: 60 }), /알 수 없는/);
  assert.ok(testCatalog().length >= 20);
});

test('judge: ping/threshold/certDays 임계 판정', () => {
  assert.equal(judge.ping({ sent: 3, received: 3, avgMs: 12 }, { maxLossPct: 0, maxRttMs: 100 }).status, 'ok');
  assert.equal(judge.ping({ sent: 3, received: 2, avgMs: 12 }, { maxLossPct: 0, maxRttMs: 100 }).status, 'bad');
  assert.equal(judge.ping({ sent: 3, received: 3, avgMs: 500 }, { maxLossPct: 0, maxRttMs: 100 }).status, 'warn');
  assert.equal(judge.ping({ sent: 3, received: 0 }, { maxLossPct: 50, maxRttMs: 100 }).status, 'bad');
  assert.equal(judge.threshold(95, { badAbove: 90, unit: '%' }).status, 'bad');
  assert.equal(judge.threshold(null, { badAbove: 90 }).status, 'unknown');
  assert.equal(judge.certDays(5, { warnDays: 30, badDays: 7 }).status, 'bad');
  assert.equal(judge.certDays(20, { warnDays: 30, badDays: 7 }).status, 'warn');
  assert.equal(judge.certDays(200, { warnDays: 30, badDays: 7 }).status, 'ok');
});

test('runTest: 네이티브 점검(tcp/disk/memory/load/file 계열)이 실제로 판정을 낸다, 파일 루트 밖은 unknown', async () => {
  const net = await import('node:net');
  const srv = net.createServer().listen(0, '127.0.0.1'); await new Promise((r) => srv.once('listening', r));
  const port = srv.address().port;
  assert.equal((await runTest({ test: 'tcp', args: { host: '127.0.0.1', port } })).status, 'ok');
  srv.close(); await new Promise((r) => srv.once('close', r));
  assert.equal((await runTest({ test: 'tcp', args: { host: '127.0.0.1', port, timeoutMs: 1000 } })).status, 'bad');
  assert.equal((await runTest({ test: 'disk-free', args: { path: '/', minFreePct: 0 } })).status, 'ok');
  assert.equal((await runTest({ test: 'disk-free', args: { path: '/', minFreePct: 100 } })).status, 'bad');
  assert.equal((await runTest({ test: 'memory', args: { minFreeMB: 1 } })).status, 'ok');
  assert.equal((await runTest({ test: 'load', args: { maxLoadPerCore: 1000 } })).status, 'ok');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rma-files-'));
  fs.writeFileSync(path.join(dir, 'a.log'), 'ok line\nERROR one\nERROR two\n');
  const roots = [dir];
  assert.equal((await runTest({ test: 'file-exists', args: { path: path.join(dir, 'a.log') } }, { fileRoots: roots })).status, 'ok');
  assert.equal((await runTest({ test: 'file-exists', args: { path: path.join(dir, 'nope') } }, { fileRoots: roots })).status, 'bad');
  assert.equal((await runTest({ test: 'count-files', args: { path: dir, pattern: '*.log', max: 0 } }, { fileRoots: roots })).status, 'bad');
  assert.equal((await runTest({ test: 'count-files', args: { path: dir, pattern: '*.log', max: 1 } }, { fileRoots: roots })).status, 'ok');
  const tl = await runTest({ test: 'text-log', args: { path: path.join(dir, 'a.log'), pattern: 'ERROR', maxMatches: 1 } }, { fileRoots: roots });
  assert.equal(tl.status, 'bad'); assert.match(tl.reply, /2건/);
  const outside = await runTest({ test: 'file-exists', args: { path: '/etc/passwd' } }, { fileRoots: roots });
  assert.equal(outside.status, 'unknown'); assert.match(outside.reply, /허용되지 않은 경로/);
  assert.equal(pathAllowed('/var/log/messages', ['/var/log']), true);
  assert.equal(pathAllowed('/var/logs/x', ['/var/log']), false, '접두 문자열 우회 불가');
  const sc = await runTest({ test: 'script', args: { command: 'exit 1' } }, { allowCustom: true });
  assert.equal(sc.status, 'warn');
  assert.equal((await runTest({ test: 'script', args: { command: 'true' } }, { allowCustom: false })).status, 'unknown');
});

test('스케줄: upsert/버전 증가/삭제, 인스턴스별 결정적 배정 + 명시 인스턴스 + rma-itself 제외', () => {
  sch._resetSchedules();
  const a = sch.upsertScheduleItem('S1', { test: 'tcp', args: { host: 'h', port: 22 }, intervalSec: 60, name: 'ssh' });
  const b = sch.upsertScheduleItem('S1', { test: 'disk-free', args: { path: '/' }, intervalSec: 300, instance: 'node2' });
  const c = sch.upsertScheduleItem('S1', { test: 'rma-itself', args: {}, intervalSec: 60 });
  assert.equal(sch.scheduleFor('S1').version, 3);
  assert.throws(() => sch.upsertScheduleItem('S1', { test: 'tcp', args: {}, intervalSec: 60 }), /필요합니다/);
  const n1 = sch.assignForInstance(sch.scheduleFor('S1'), 'node1', ['node1', 'node2']);
  const n2 = sch.assignForInstance(sch.scheduleFor('S1'), 'node2', ['node1', 'node2']);
  const ids = (x) => x.tests.map((t) => t.id).sort();
  assert.ok(!ids(n1).includes(c.id) && !ids(n2).includes(c.id), 'rma-itself 는 엣지에 내려가지 않는다');
  assert.ok(ids(n2).includes(b.id) && !ids(n1).includes(b.id), '명시 인스턴스는 그 인스턴스만');
  assert.equal([...ids(n1), ...ids(n2)].filter((id) => id === a.id).length, 1, '무지정 항목은 정확히 한 인스턴스에만');
  const solo = sch.assignForInstance(sch.scheduleFor('S1'), 'node1', ['node1']);
  assert.ok(ids(solo).includes(a.id), '온라인이 하나면 그쪽이 전부');
  sch.upsertScheduleItem('S1', { id: a.id, test: 'tcp', args: { host: 'h', port: 443 }, intervalSec: 120 });
  assert.equal(sch.scheduleFor('S1').tests.find((t) => t.id === a.id).args.port, 443);
  assert.equal(sch.removeScheduleItem('S1', b.id), true);
  assert.equal(sch.removeScheduleItem('S1', 'nope'), false);
});

test('결과 반영: 상태 변화·연속 실패 알림 1회·복구 해소, rma-itself 판정, 요약', async () => {
  res._resetTestResults();
  const t0 = Date.now();
  let r = await res.ingestResult('R1', { id: 'x', test: 'tcp', status: 'ok', reply: 'open', at: t0 }, { now: t0, alert: false });
  assert.equal(r.changed, true);
  r = await res.ingestResult('R1', { id: 'x', test: 'tcp', status: 'bad', reply: 'closed', at: t0 + 1000 }, { now: t0 + 1000, alert: false });
  assert.equal(r.changed, true); assert.equal(r.cur.streak, 1); assert.equal(r.cur.okAt, t0);
  r = await res.ingestResult('R1', { id: 'x', test: 'tcp', status: 'bad', reply: 'closed', at: t0 + 2000 }, { now: t0 + 2000, alert: false });
  assert.equal(r.cur.streak, 2); assert.equal(r.cur.since, t0 + 1000);
  const rows = res.latestResults({ agent: 'r1' });
  assert.equal(rows.length, 1); assert.equal(rows[0].status, 'bad');
  await res.evaluateRmaItself('R1', 'self', { online: 0, total: 2, now: t0 + 3000 });
  assert.equal(res.latestResults({ agent: 'R1' }).find((x) => x.testId === 'self').status, 'bad');
  await res.evaluateRmaItself('R1', 'self', { online: 1, total: 2, now: t0 + 4000 });
  assert.equal(res.latestResults({ agent: 'R1' }).find((x) => x.testId === 'self').status, 'ok');
  const sum = res.summarize();
  assert.deepEqual(sum.find((s) => s.agent === 'R1'), { agent: 'R1', ok: 1, warn: 0, bad: 1, unknown: 0, total: 2 });
});

test('정책: 허용/차단 목록, 서비스 유닛 허용 목록, 재부팅 opt-in, kill/log-event/http-request argv', () => {
  assert.equal(commandAllowed('df', {}), true);
  assert.equal(commandAllowed('df', { enabled: ['uptime'] }), false);
  assert.equal(commandAllowed('df', { enabled: ['*'], disabled: ['df'] }), false);
  assert.deepEqual(parseList('a, b  c'), ['a', 'b', 'c']);
  const pol = { serviceUnits: ['nginx'], allowReboot: false };
  assert.equal(buildCommand('service-restart', { unit: 'nginx' }, { policy: pol }).ok, true);
  assert.match(buildCommand('service-restart', { unit: 'sshd' }, { policy: pol }).issue, /허용 목록/);
  assert.deepEqual(buildCommand('service-restart', { unit: 'nginx' }, { policy: pol }).argv, ['sudo', '-n', 'systemctl', 'restart', 'nginx.service']);
  assert.match(buildCommand('reboot', {}, { policy: pol }).issue, /RMA_ALLOW_REBOOT/);
  assert.equal(buildCommand('reboot', {}, { policy: { ...pol, allowReboot: true } }).ok, true);
  assert.match(buildCommand('df', {}, { policy: { enabled: ['uptime'] } }).issue, /허용되지 않은 명령/);
  assert.deepEqual(buildCommand('kill-pid', { pid: '1234', force: '1' }).argv, ['kill', '-KILL', '1234']);
  assert.equal(buildCommand('kill-pid', { pid: '1' }).ok, false, 'pid 1 은 거부');
  const le = buildCommand('log-event', { message: 'disk almost full: 95% used!', priority: 'warning' });
  assert.equal(le.ok, true); assert.equal(le.argv[le.argv.length - 1], 'disk almost full: 95% used!');
  assert.equal(buildCommand('log-event', { message: 'a\nb' }).ok, false, '제어문자 거부');
  const hr = buildCommand('http-request', { url: 'http://10.0.0.1/hook', method: 'POST', body: '{"a":1}' });
  assert.equal(hr.ok, true); assert.ok(hr.argv.includes('POST') && hr.argv.includes('{"a":1}'));
  assert.equal(buildCommand('rma-restart', {}).native, 'rma-restart');
});

test('접속 허용 IP: CIDR/단일 매칭, 형식 검증, 설정 왕복', () => {
  assert.equal(settings.ipAllowed('10.1.2.3', []), true);
  assert.equal(settings.ipAllowed('10.1.2.3', ['10.1.0.0/16']), true);
  assert.equal(settings.ipAllowed('10.2.2.3', ['10.1.0.0/16']), false);
  assert.equal(settings.ipAllowed('::ffff:192.168.1.5', ['192.168.1.5']), true);
  assert.equal(settings.ipAllowed('192.168.1.6', ['192.168.1.5']), false);
  assert.match(settings.ipEntriesIssue(['10.0.0.1; rm']), /형식/);
  settings._resetRmaSettings();
  const r = settings.setAgentAccess('A1', { allowedIps: '10.0.0.0/8, 192.168.1.5', comment: 'Seoul edge' });
  assert.deepEqual(r.allowedIps, ['10.0.0.0/8', '192.168.1.5']); assert.equal(r.comment, 'Seoul edge');
  settings.setAgentMode('A1', { mode: 'balance' });
  assert.deepEqual(settings.accessFor('A1').allowedIps, ['10.0.0.0/8', '192.168.1.5'], '분배 설정 저장이 접속 설정을 지우지 않는다');
  const rm = settings.setAgentRemote('A1', { longpollMs: 30000, testConcurrency: 2, disabledTests: 'script,reboot' });
  assert.deepEqual(rm, { longpollMs: 30000, testConcurrency: 2, disabledTests: ['script', 'reboot'] });
  assert.throws(() => settings.setAgentRemote('A1', { longpollMs: 100 }), /롱폴/);
  settings.setAgentMode('A1', {}); settings.setAgentAccess('A1', {}); settings.setAgentRemote('A1', {});
});

test('sudoers: 기본 1줄 + 허용 유닛별 start/stop/restart + reboot opt-in, 잘못된 유닛명은 제외', () => {
  const s = RMA_SUDOERS('vmportal', { units: ['nginx', 'bad name;'], reboot: true });
  assert.match(s, /systemctl restart vmware-portal\.service/);
  assert.match(s, /systemctl start nginx\.service/); assert.match(s, /systemctl stop nginx\.service/);
  assert.match(s, /systemctl reboot/);
  assert.ok(!s.includes('bad name'));
  assert.ok(!RMA_SUDOERS('vmportal').includes('reboot'));
});
