import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// v2.416 RMA(원격 명령 에이전트) 회귀 테스트 — 카탈로그 검증·서명·잡큐(claim→ack, 다중 인스턴스
// 분배·페일오버)·실행기·패키지 유닛 동일성.
process.env.CONFIG_DIR = process.env.CONFIG_DIR || fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'rma-test-'));

const { buildCommand, catalog, describeCommand, LIMITS } = await import('../src/rma/commands.js');
const { signJob, verifyJob, canonical, SKEW_MS } = await import('../src/rma/signing.js');
const jobsMod = await import('../src/rma/jobs.js');
const { enqueueJob, takeJobs, takeJobsWait, setJobResult, getJob, noteHeartbeat, listRmaAgents, reapClaims, listHistory, pickInstance, _resetRma, HEARTBEAT_STALE_MS } = jobsMod;
const settings = await import('../src/rma/settings.js');
const { runCommand } = await import('../src/rma/exec.js');
const { RMA_UNIT_TEMPLATE, renderUnit } = await import('../src/rma/unitTemplate.js');
const { deployInputIssue } = await import('../src/rma/deploy.js');

// ── 카탈로그 ──
test('buildCommand: 프리셋은 argv 배열로 조립되고 셸을 쓰지 않는다', () => {
  const r = buildCommand('ping', { host: '10.0.0.1', count: '3' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.argv, ['ping', '-n', '-c', '3', '-W', '2', '10.0.0.1']);
  assert.equal(r.shell, undefined);
  assert.equal(r.args.count, 3, 'int 파라미터는 숫자로 정규화');
});
test('buildCommand: 파라미터는 화이트리스트 — 셸 메타문자·선행 - 거부', () => {
  assert.equal(buildCommand('ping', { host: '10.0.0.1; rm -rf /' }).ok, false);
  assert.equal(buildCommand('ping', { host: '-c' }).ok, false);
  assert.equal(buildCommand('ping', { host: '$(id)' }).ok, false);
  assert.equal(buildCommand('ls', { path: '/etc; cat /etc/shadow' }).ok, false);
  assert.equal(buildCommand('ls', { path: 'etc' }).ok, false, '절대경로만');
  assert.equal(buildCommand('journal', { unit: 'vmware-portal', lines: '9' }).ok, false, '하한');
  assert.equal(buildCommand('journal', { unit: 'vmware-portal', lines: '501' }).ok, false, '상한');
  assert.equal(buildCommand('sysctl-status', { unit: '--all' }).ok, false);
  assert.equal(buildCommand('http-head', { url: 'http://10.0.0.1:4000/health' }).ok, true);
  assert.equal(buildCommand('http-head', { url: 'http://10.0.0.1/a b' }).ok, false);
});
test('buildCommand: 선언되지 않은 키는 버리고 필수 누락은 거부', () => {
  const r = buildCommand('dns', { host: 'central.example', extra: 'x' });
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.args), ['host']);
  assert.equal(buildCommand('dns', {}).ok, false);
  assert.equal(buildCommand('nope', {}).ok, false);
});
test('buildCommand: 자유 명령은 allowCustom 일 때만, 제어문자·길이 제한', () => {
  assert.match(buildCommand('custom', { command: 'uptime' }).issue, /RMA_ALLOW_CUSTOM/);
  const ok = buildCommand('custom', { command: 'uptime && df -h' }, { allowCustom: true });
  assert.equal(ok.ok, true); assert.equal(ok.shell, 'uptime && df -h'); assert.equal(ok.danger, true);
  assert.equal(buildCommand('custom', { command: 'a\x00b' }, { allowCustom: true }).ok, false);
  assert.equal(buildCommand('custom', { command: 'x'.repeat(LIMITS.shellMaxLen + 1) }, { allowCustom: true }).ok, false);
});
test('buildCommand: 타임아웃은 상·하한으로 클램프, sudo 프리셋은 sudo -n 접두', () => {
  assert.equal(buildCommand('uptime', {}, { timeoutMs: 10 }).timeoutMs, LIMITS.timeoutMs.min);
  assert.equal(buildCommand('uptime', {}, { timeoutMs: 10_000_000 }).timeoutMs, LIMITS.timeoutMs.max);
  assert.equal(buildCommand('uptime', {}).timeoutMs, LIMITS.timeoutMs.def);
  const r = buildCommand('portal-restart', {});
  assert.deepEqual(r.argv, ['sudo', '-n', 'systemctl', 'restart', 'vmware-portal.service']);
  assert.equal(r.danger, true);
});
test('catalog: 함수 제거·힌트 부여, 파일 내용 읽기 프리셋(cat 임의 경로)·재부팅 프리셋 없음', () => {
  const c = catalog();
  assert.ok(c.length > 20);
  for (const p of c) { assert.equal(typeof p.argv, 'undefined'); for (const x of p.params || []) if (x.type !== 'shell') assert.ok(x.hint); }
  assert.ok(!c.some((p) => /^(reboot|poweroff|shutdown|halt)/.test(p.id)));
  assert.ok(!c.some((p) => (p.params || []).some((x) => x.type === 'path') && p.id !== 'ls'));
  assert.equal(describeCommand('ping', { host: 'h', count: 4 }), 'ping(host=h, count=4)');
});

// ── 서명 ──
test('signJob/verifyJob: 같은 비밀번호·본문이면 통과, 변조·불일치·만료·무서명은 거부', () => {
  const job = { reqId: 'rma_1', agent: 'Seoul', cmd: 'ping', args: { host: '10.0.0.1', count: 4 }, timeoutMs: 30000, issuedAt: 1_000_000 };
  const sig = signJob('pw', job);
  assert.equal(verifyJob('pw', { ...job, sig }, 1_000_000 + 1000).ok, true);
  assert.equal(verifyJob('pw', { ...job, agent: 'SEOUL', sig }, 1_000_000).ok, true, 'agent 대소문자 무시');
  assert.equal(verifyJob('pw', { ...job, args: { host: '10.0.0.2', count: 4 }, sig }, 1_000_000).ok, false, '인자 변조');
  assert.equal(verifyJob('other', { ...job, sig }, 1_000_000).ok, false, '비밀번호 불일치');
  assert.equal(verifyJob('pw', { ...job, sig }, 1_000_000 + SKEW_MS + 1).ok, false, '만료');
  assert.match(verifyJob('pw', { ...job }, 1_000_000).reason, /서명 없는/);
  assert.equal(verifyJob('', { ...job }).ok, true, '엣지 비밀번호 미설정 = 서명 요구 없음');
  assert.equal(verifyJob('', { ...job }).signed, false);
  assert.equal(canonical({ ...job, args: { count: 4, host: '10.0.0.1' } }), canonical(job), '키 순서 무관');
});

// ── 잡큐 ──
test('잡큐: enqueue → take(claim) → 결과(ack) → done, running 중 UI 상태 구분', async () => {
  _resetRma();
  const { reqId } = enqueueJob('q1', { cmd: 'uptime', args: {} }, { user: 'admin', timeoutMs: 5000 });
  assert.equal(getJob(reqId).state, 'pending');
  const t = takeJobs('q1', 'a');
  assert.equal(t.length, 1); assert.equal(t[0].reqId, reqId); assert.equal(t[0].cmd, 'uptime');
  assert.equal(getJob(reqId).state, 'running');
  assert.deepEqual(takeJobs('q1', 'a'), [], '재인출 없음');
  assert.equal(setJobResult(reqId, { ok: true, stdout: 'up', exitCode: 0 }), true);
  assert.equal(getJob(reqId).state, 'done'); assert.equal(getJob(reqId).result.stdout, 'up');
  assert.equal(setJobResult(reqId, { ok: true }), false, '중복 ack 는 무시');
  assert.equal(listHistory({ agent: 'q1' })[0].reqId, reqId);
});
test('잡큐: 비멱등 — 기한 내 미회신은 재인출 없이 오류 종결(MAX_CLAIMS=1)', () => {
  _resetRma();
  const now = Date.now();
  const { reqId } = enqueueJob('q2', { cmd: 'portal-restart', args: {} }, { timeoutMs: 1000, now });
  takeJobs('q2', 'a', now);
  reapClaims(now + 1000 + 30_000 + 1);
  const j = getJob(reqId);
  assert.equal(j.state, 'done'); assert.equal(j.result.ok, false); assert.match(j.result.reason, /회신하지 않았습니다/);
  assert.deepEqual(takeJobs('q2', 'b', now + 60_000), [], '실패 종결 후 다른 인스턴스가 다시 받지 않는다');
});
test('잡큐: 서명 콜백은 reqId 를 받아 spec.sig 를 붙인다', () => {
  _resetRma();
  const { reqId } = enqueueJob('q3', { cmd: 'uptime', args: {}, timeoutMs: 1000, issuedAt: 5 }, { sign: (id) => signJob('pw', { reqId: id, agent: 'q3', cmd: 'uptime', args: {}, timeoutMs: 1000, issuedAt: 5 }) });
  const [job] = takeJobs('q3', 'x');
  assert.equal(verifyJob('pw', { ...job, agent: 'q3' }, 5).ok, true, '엣지가 받은 잡 그대로 검증 통과');
  assert.equal(job.reqId, reqId);
});
test('잡큐: 롱폴은 잡 도착 시 즉시 깨어난다', async () => {
  _resetRma();
  const t0 = Date.now();
  const p = takeJobsWait('q4', 'a', 5000);
  setTimeout(() => enqueueJob('q4', { cmd: 'uptime', args: {} }), 30);
  const jobs = await p;
  assert.equal(jobs.length, 1);
  assert.ok(Date.now() - t0 < 2000, '5초 대기를 다 채우지 않고 깨어남');
  const empty = await takeJobsWait('q4', 'a', 50);
  assert.deepEqual(empty, []);
});

// ── 다중 인스턴스 분배 ──
test('분배 active-active: target 없음 — 먼저 폴링한 인스턴스가 가져간다', () => {
  _resetRma();
  noteHeartbeat('m1', 'a', { priority: 100 }); noteHeartbeat('m1', 'b', { priority: 100 });
  const { target } = enqueueJob('m1', { cmd: 'uptime', args: {} });
  assert.equal(target, '');
  assert.equal(takeJobs('m1', 'b').length, 1);
  assert.equal(takeJobs('m1', 'a').length, 0);
});
test('분배 balance: 진행 중 잡이 적은 인스턴스 우선, 동률은 라운드로빈 — 다른 인스턴스는 그 잡을 받지 않는다', () => {
  _resetRma();
  settings._resetRmaSettings();
  settings.setAgentMode('m2', { mode: 'balance' });
  noteHeartbeat('m2', 'a', {}); noteHeartbeat('m2', 'b', {});
  const j1 = enqueueJob('m2', { cmd: 'uptime', args: {} });
  const j2 = enqueueJob('m2', { cmd: 'uptime', args: {} });
  assert.notEqual(j1.target, j2.target, '두 잡은 서로 다른 인스턴스로');
  assert.ok(['a', 'b'].includes(j1.target));
  // a 가 폴링하면 a 몫만 받는다(b 몫은 b 가 온라인이므로 남는다)
  const aJobs = takeJobs('m2', 'a');
  assert.equal(aJobs.length, 1);
  assert.equal(getJob(aJobs[0].reqId).target, 'a');
  const bJobs = takeJobs('m2', 'b');
  assert.equal(bJobs.length, 1);
  // a 는 끝났고(running 0) b 는 실행 중(running 1) → 다음 잡은 부하가 적은 a 로
  setJobResult(aJobs[0].reqId, { ok: true });
  const j3 = enqueueJob('m2', { cmd: 'uptime', args: {} });
  assert.equal(j3.target, 'a', '진행 중 잡이 적은 인스턴스 우선');
  // 둘 다 부하 0 이면 라운드로빈으로 번갈아 배정
  setJobResult(bJobs[0].reqId, { ok: true });
  takeJobs('m2', 'a'); setJobResult(j3.reqId, { ok: true });
  const seq = [enqueueJob('m2', { cmd: 'uptime', args: {} }).target];
  takeJobs('m2', seq[0]); // 인출해 pending 을 비움(running 은 남지만 서로 다른 잡을 완료해 균형)
  assert.ok(['a', 'b'].includes(seq[0]));
  settings.setAgentMode('m2', {});
});
test('분배 active-backup: 우선순위 최저(주)에만 배정, 주 오프라인이면 다음 순위가 페일오버로 받는다', () => {
  _resetRma();
  settings._resetRmaSettings();
  settings.setAgentMode('m3', { mode: 'active-backup' });
  const now = Date.now();
  noteHeartbeat('m3', 'backup', { priority: 200 }); noteHeartbeat('m3', 'primary', { priority: 10 });
  assert.equal(pickInstance('m3', 'active-backup', { now }), 'primary');
  const { target, reqId } = enqueueJob('m3', { cmd: 'uptime', args: {} }, { now });
  assert.equal(target, 'primary');
  assert.equal(takeJobs('m3', 'backup', now).length, 0, '주가 온라인이면 예비는 받지 않는다');
  // 주 하트비트 만료 → 예비가 페일오버로 인출
  // 하트비트 lastSeen 은 noteHeartbeat 내부의 Date.now() 라 test 의 now 보다 몇 ms 뒤일 수 있다 — 여유를 둔다(CI 에서 1회 실패).
  const later = Date.now() + HEARTBEAT_STALE_MS + 5_000;
  assert.equal(takeJobs('m3', 'backup', later).length, 1);
  assert.equal(getJob(reqId).failover, true);
  assert.equal(getJob(reqId).instance, 'backup');
  // 설정 primary 가 있으면 우선순위보다 우선
  settings.setAgentMode('m3', { mode: 'active-backup', primary: 'backup' });
  noteHeartbeat('m3', 'primary', { priority: 10 }); noteHeartbeat('m3', 'backup', { priority: 200 });
  assert.equal(pickInstance('m3', 'active-backup', { primary: 'backup' }), 'backup');
  settings.setAgentMode('m3', {});
});
test('명시 인스턴스 지정은 분배 방식과 무관하게 그 인스턴스만 — 오프라인이면 타 인스턴스 페일오버', () => {
  _resetRma();
  const now = Date.now();
  noteHeartbeat('m4', 'a', {}); noteHeartbeat('m4', 'b', {});
  const { target } = enqueueJob('m4', { cmd: 'uptime', args: {} }, { instance: 'b', now });
  assert.equal(target, 'b');
  assert.equal(takeJobs('m4', 'a', now).length, 0);
  assert.equal(takeJobs('m4', 'a', Date.now() + HEARTBEAT_STALE_MS + 5_000).length, 1, 'b 오프라인 → a 가 대신');
});
test('listRmaAgents: 법인별 그룹·온라인 수·주 인스턴스·모드', () => {
  _resetRma();
  settings._resetRmaSettings();
  noteHeartbeat('L1', 'x', { hostname: 'h1', version: '2.416.0', priority: 5, allowCustom: true, signed: true });
  noteHeartbeat('L1', 'y', { hostname: 'h2', priority: 50 });
  noteHeartbeat('L2', 'z', {});
  const g = listRmaAgents();
  assert.equal(g.length, 2);
  const l1 = g.find((x) => x.agent === 'L1');
  assert.equal(l1.instances.length, 2); assert.equal(l1.onlineCount, 2); assert.equal(l1.mode, 'active-active');
  assert.equal(l1.instances[0].instance, 'x', '우선순위 순 정렬'); assert.equal(l1.instances[0].allowCustom, true);
  settings.setAgentMode('L1', { mode: 'active-backup' });
  assert.equal(listRmaAgents().find((x) => x.agent === 'L1').activePrimary, 'x');
  settings.setAgentMode('L1', {});
});
test('settings: 모드 검증·전역 기본·파일 왕복', () => {
  settings._resetRmaSettings();
  assert.throws(() => settings.setAgentMode('s', { mode: 'weird' }), /알 수 없는/);
  assert.throws(() => settings.setAgentMode('s', { primary: 'bad name!' }), /형식/);
  settings.setDefaultMode('balance');
  assert.equal(settings.modeFor('unset').mode, 'balance');
  settings._resetRmaSettings();
  assert.equal(settings.modeFor('unset').mode, 'balance', '파일에서 다시 읽어도 유지');
  settings.setDefaultMode('active-active');
});

// ── 실행기 ──
test('runCommand: argv 실행·exit code·타임아웃·출력 상한·줄 수 제한', async () => {
  const ok = await runCommand({ argv: ['sh', '-c', 'echo hello; echo err 1>&2'], timeoutMs: 5000, maxLines: 0 });
  assert.equal(ok.ok, true); assert.equal(ok.stdout, 'hello\n'); assert.equal(ok.stderr, 'err\n'); assert.equal(ok.exitCode, 0);
  const fail = await runCommand({ argv: ['sh', '-c', 'exit 3'], timeoutMs: 5000 });
  assert.equal(fail.ok, false); assert.equal(fail.exitCode, 3); assert.match(fail.reason, /종료 코드 3/);
  const to = await runCommand({ argv: ['sleep', '5'], timeoutMs: 1000 });
  assert.equal(to.timedOut, true); assert.equal(to.ok, false); assert.ok(to.durationMs < 4500);
  const big = await runCommand({ argv: ['sh', '-c', 'yes | head -c 100000'], timeoutMs: 5000 }, { maxOutput: 2048 });
  assert.equal(big.truncated, true); assert.ok(big.stdout.length <= 2048); assert.equal(big.ok, false);
  const lines = await runCommand({ argv: ['sh', '-c', 'seq 1 100'], timeoutMs: 5000, maxLines: 5 });
  assert.equal(lines.clipped, true); assert.equal(lines.stdout.split('\n').filter(Boolean).length, 5); assert.equal(lines.ok, true);
  const missing = await runCommand({ argv: ['definitely-not-a-command-xyz'], timeoutMs: 2000 });
  assert.equal(missing.ok, false); assert.match(missing.reason, /없습니다|실행 실패/);
});
test('runCommand: tcp-port 네이티브 — 닫힌 포트는 실패, 열린 포트는 성공', async () => {
  const net = await import('node:net');
  const srv = net.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const port = srv.address().port;
  const open = await runCommand({ native: 'tcp-port', args: { host: '127.0.0.1', port }, timeoutMs: 3000 });
  assert.equal(open.ok, true);
  srv.close();
  await new Promise((r) => srv.once('close', r));
  const closed = await runCommand({ native: 'tcp-port', args: { host: '127.0.0.1', port }, timeoutMs: 3000 });
  assert.equal(closed.ok, false);
});

// ── 패키지 유닛 동일성 + 배포 입력 검증 ──
test('vmware-portal-rma@.service 패키지 파일은 unitTemplate.js 와 동일하다', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = fs.readFileSync(path.join(here, '..', '..', 'packaging', 'offline', 'vmware-portal-rma@.service'), 'utf8');
  assert.equal(file, RMA_UNIT_TEMPLATE);
  const r = renderUnit({ prefix: '/opt/vmware-portal', user: 'vmportal', configDir: '/etc/vmware-portal' });
  assert.ok(!/@[A-Z_]+@/.test(r), '플레이스홀더 잔존 없음');
  assert.match(r, /ExecStart=\/opt\/vmware-portal\/runtime\/node\/bin\/node \/opt\/vmware-portal\/app\/server\/src\/rma\/agent\.js/);
  assert.match(r, /PartOf=vmware-portal\.service/);
});
test('deployInputIssue: 인스턴스 이름·중복·우선순위·비밀번호 문자 집합', () => {
  assert.equal(deployInputIssue({ instances: [{ name: 'a', priority: 10 }, { name: 'b' }], password: 'Str0ng!Pass' }), null);
  assert.match(deployInputIssue({ instances: [] }), /1개 이상/);
  assert.match(deployInputIssue({ instances: [{ name: '-bad' }] }), /형식/);
  assert.match(deployInputIssue({ instances: [{ name: 'a' }, { name: 'A' }] }), /중복/);
  assert.match(deployInputIssue({ instances: [{ name: 'a', priority: 5000 }] }), /우선순위/);
  assert.match(deployInputIssue({ instances: [{ name: 'a' }], password: "pw'; rm -rf /" }), /비밀번호/);
  assert.match(deployInputIssue({ instances: [{ name: 'a' }], centralUrl: 'ftp://x' }), /CENTRAL_URL/);
});

// ── v2.417 개선 — 이력 sqlite 영속화 ──
test('historyDb: 저장 후 조회(법인 필터·출력 상한), DB 가 있으면 listHistoryAsync 가 DB 를 쓴다', async () => {
  const h = await import('../src/rma/historyDb.js');
  if (!(await h.historyAvailable())) { console.log('node:sqlite 없음 — 건너뜀'); return; }
  _resetRma();
  const { reqId } = enqueueJob('H1', { cmd: 'uptime', args: { x: 1 } }, { user: 'admin', timeoutMs: 5000 });
  takeJobs('H1', 'a');
  setJobResult(reqId, { ok: true, stdout: 'x'.repeat(70 * 1024), exitCode: 0, durationMs: 5 });
  await new Promise((r) => setTimeout(r, 50));
  const rows = await h.listHistoryRows({ agent: 'h1', limit: 10 });
  const row = rows.find((x) => x.reqId === reqId);
  assert.ok(row, 'DB 에 저장됨(대소문자 무시 조회)');
  assert.equal(row.instance, 'a'); assert.equal(row.ok, true); assert.deepEqual(row.args, { x: 1 });
  assert.ok(row.stdout.length <= 64 * 1024 && row.truncated, '출력 상한 + truncated 표시');
  const viaJobs = await jobsMod.listHistoryAsync({ agent: 'H1', limit: 5 });
  assert.ok(viaJobs.some((x) => x.reqId === reqId));
});
