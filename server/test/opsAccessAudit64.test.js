// 전체 점검 64회차 — 운영 작업 계열 1차(원격 명령 rma · 호스트 접근 제어 hostaccess · SSH 공용 접속 sshaccess).
//  F1 RMA 'http-request' 프리셋의 본문 '@경로' 가 curl 로 그 파일을 읽어 보냈다(portal.env 유출 — 자유 명령 opt-in 없이).
//  F2 호스트 접근 자동 되돌림의 --reload 가 실패하면 pending 을 먼저 지워 다시 시도하지 않았다(확정 안 한 런타임 규칙이 남는다).
//  F3 RMA '접속 허용 IP' 가 rma-poll 에만 걸려 rma-credential(평문 계정) · rma-result 는 목록 밖 출처에서도 통했다.
//  개선: 엣지가 서명 잡의 같은 reqId 재전송을 거부한다(±10분 창 안 재실행 차단).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// v3.18.8: 이 파일이 만든 임시 폴더는 시험이 끝나면 지운다(지우지 않아 전량 실행마다 /tmp 에 쌓였다 — tmpCleanup3188 이 고정).
//   exit 에서 한 번 더 지운다 — 모듈의 종료 flush(util/exitFlush.js)가 뒤늦게 다시 만든 폴더(수 MB 실측)까지.
const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) fs.rmSync(d, { recursive: true, force: true }); };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });

const CFG = tmpDir('ops-access-64-');
process.env.CONFIG_DIR = CFG;
process.env.PORT = '4000';
process.env.CENTRAL_TOKEN = 'shared-token-for-ops-audit-64-0000000';

const { buildCommand } = await import('../src/rma/commands.js');

// ── F1 ────────────────────────────────────────────────────────────────────
test('F1: http-request 본문이 @ 로 시작하면 거부(공백을 앞에 붙여도) — curl --data @파일 읽기 차단', () => {
  for (const body of ['@/etc/vmware-portal/portal.env', ' @/etc/passwd', '@-']) {
    const b = buildCommand('http-request', { url: 'http://10.0.0.1/hook', method: 'POST', body });
    assert.equal(b.ok, false, `본문 ${JSON.stringify(body)} 이 통과했다`);
    assert.match(b.issue, /@ 로 시작할 수 없습니다/);
    // 엣지 정책 검증(같은 함수)도 같은 판정
    assert.equal(buildCommand('http-request', { url: 'http://10.0.0.1/hook', method: 'POST', body }, { policy: { enabled: [], disabled: [] } }).ok, false);
  }
  // 정상 본문(중간의 @ 포함)은 그대로 통과하고 --data 뒤 값이 @ 로 시작하지 않는다
  const ok = buildCommand('http-request', { url: 'http://10.0.0.1/hook', method: 'POST', body: '{"to":"ops@corp"}' });
  assert.equal(ok.ok, true, ok.issue);
  const i = ok.argv.indexOf('--data');
  assert.ok(i > 0 && !String(ok.argv[i + 1]).startsWith('@'));
});

test('F1: argv 를 만드는 모든 프리셋에서 @ 로 시작하는 message 값이 curl 옵션 값으로 가지 않는다(소스 대조)', async () => {
  const { PRESETS } = await import('../src/rma/commands.js');
  for (const p of PRESETS) {
    if (!p.argv) continue;
    const curl = p.argv(Object.fromEntries((p.params || []).map((x) => [x.name, x.type === 'int' ? (x.min ?? 1) : 'v'])))[0] === 'curl';
    if (!curl) continue;
    for (const x of p.params || []) if (x.type === 'message') assert.equal(x.noLeadingAt, true, `${p.id}.${x.name}: curl 로 가는 자유 문자열에 @ 검사가 없다`);
  }
});

// ── F2 ────────────────────────────────────────────────────────────────────
const LIST_ALL = 'public (active)\n  target: default\n  services: ssh\n  ports: 4000/tcp 22/tcp\n  rich rules:\n';
function fakeFw(st) {
  return async (args) => {
    if (args[0] === '--state') return { ok: true, code: 0, stdout: 'running\n', stderr: '' };
    if (args[0] === '--get-default-zone') return { ok: true, code: 0, stdout: 'public\n', stderr: '' };
    if (args.includes('--list-all')) return { ok: true, code: 0, stdout: LIST_ALL, stderr: '' };
    if (args[0] === '--reload') { st.reloads++; return st.failReload > 0 ? (st.failReload--, { ok: false, code: 1, stdout: '', stderr: 'Error: COMMAND_FAILED' }) : { ok: true, code: 0, stdout: 'success', stderr: '' }; }
    return { ok: true, code: 0, stdout: 'success', stderr: '' };
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('F2: 자동 되돌림의 --reload 실패 → pending 을 남기고(사유 포함) 다시 시도해 결국 되돌린다', async () => {
  const S = await import('../src/hostaccess/service.js');
  const St = await import('../src/hostaccess/settings.js');
  St._resetHostAccessCache(); St.saveHostAccess({ pending: null, applied: null });
  const st = { reloads: 0, failReload: 2 };
  S._setExec({ fw: fakeFw(st), sshdCtl: async () => ({ ok: true }), sshdActive: async () => true, isSudoDenied: () => false });
  S._setRevertRetryMinMs(100);
  try {
    const a = await S.applyHostAccess({ ssh: { mode: 'deny' }, confirmMinutes: 1 }, { requesterIp: '10.1.1.1', by: 't' });
    assert.equal(a.ok, true, JSON.stringify(a.errors));
    St.saveHostAccess({ pending: { ...St.loadHostAccess().pending, deadline: Date.now() + 30 } });
    await S.resumeHostAccessPending();
    await sleep(120);
    const p = St.loadHostAccess().pending;
    assert.ok(p, '--reload 가 실패했는데 pending 을 지웠다 — 확정 안 한 런타임 규칙이 남고 다시 시도하지 않는다');
    assert.match(String(p.revertError || ''), /COMMAND_FAILED/);
    for (let k = 0; k < 40 && St.loadHostAccess().pending; k++) await sleep(50);
    assert.equal(St.loadHostAccess().pending, null, `재시도로 되돌리지 못했다(reload ${st.reloads}회)`);
    assert.equal(st.reloads, 3);
  } finally { S._setRevertRetryMinMs(); S._setExec(null); }
});

test('F2: 수동 되돌림이 실패해도 pending · 자동 되돌림 타이머가 남는다 · 기동 때 실패도 다시 시도한다', async () => {
  const S = await import('../src/hostaccess/service.js');
  const St = await import('../src/hostaccess/settings.js');
  St._resetHostAccessCache(); St.saveHostAccess({ pending: null, applied: null });
  const st = { reloads: 0, failReload: 1 };
  S._setExec({ fw: fakeFw(st), sshdCtl: async () => ({ ok: true }), sshdActive: async () => true, isSudoDenied: () => false });
  S._setRevertRetryMinMs(100);
  try {
    assert.equal((await S.applyHostAccess({ ssh: { mode: 'deny' }, confirmMinutes: 1 }, { requesterIp: '10.1.1.1', by: 't' })).ok, true);
    St.saveHostAccess({ pending: { ...St.loadHostAccess().pending, deadline: Date.now() + 150 } });
    const r = await S.revertHostAccess({ by: 'admin' });
    assert.equal(r.ok, false);
    assert.ok(St.loadHostAccess().pending, '수동 되돌림 실패가 pending 을 지웠다');
    for (let k = 0; k < 40 && St.loadHostAccess().pending; k++) await sleep(50);
    assert.equal(St.loadHostAccess().pending, null, '수동 되돌림 실패 뒤 자동 되돌림이 사라졌다(타이머를 지우고 다시 걸지 않았다)');

    // 기동 때(기한 지남) 되돌림 실패 → 다시 시도
    st.failReload = 1; st.reloads = 0;
    St.saveHostAccess({ pending: { at: Date.now() - 600_000, deadline: Date.now() - 1, by: 'x', fingerprint: '', rich: [] } });
    await S.resumeHostAccessPending();
    assert.equal(st.reloads, 1);
    assert.ok(St.loadHostAccess().pending);
    for (let k = 0; k < 40 && St.loadHostAccess().pending; k++) await sleep(50);
    assert.equal(St.loadHostAccess().pending, null, '기동 때 되돌림이 실패하면 다시 시도하지 않았다');
  } finally { S._setRevertRetryMinMs(); S._setExec(null); }
});

// ── F3 ────────────────────────────────────────────────────────────────────
let server; let base; let tokens; let jobs; let settings;
before(async () => {
  tokens = await import('../src/central/agentTokens.js');
  jobs = await import('../src/rma/jobs.js');
  settings = await import('../src/rma/settings.js');
  const express = (await import('express')).default;
  const { centralRouter } = await import('../src/routes/central.js');
  const app = express();
  app.use(express.json());
  app.use('/api/central', centralRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api/central`;
});
after(() => { try { server?.close(); } catch { /* */ } });
const post = (p, body, token) => fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Central-Token': token }, body: JSON.stringify(body) });

test('F3: 접속 허용 IP 밖 출처는 rma-credential(평문 계정 브로커)도 403 — 목록 안이면 브로커 판정까지 간다', async () => {
  const t = tokens.issueAgentToken('RMA-64A');
  settings.setAgentAccess('RMA-64A', { allowedIps: ['10.9.9.9'] });
  let r = await post('/rma-credential', { agent: 'RMA-64A', credentialId: 'cred_x64', host: '10.0.0.5' }, t.token);
  assert.equal(r.status, 403);
  assert.match((await r.json()).reason, /허용 IP/, '목록 밖 출처가 계정 브로커에 닿았다');
  settings.setAgentAccess('RMA-64A', { allowedIps: ['127.0.0.0/8'] });
  r = await post('/rma-credential', { agent: 'RMA-64A', credentialId: 'cred_x64', host: '10.0.0.5' }, t.token);
  assert.equal(r.status, 403);
  assert.doesNotMatch((await r.json()).reason, /허용 IP/, '목록 안 출처는 브로커 판정(계정 없음)까지 가야 한다');
  settings.setAgentAccess('RMA-64A', {});
});

test('F3: 접속 허용 IP 밖 출처의 rma-result 는 403 이고 잡 상태가 바뀌지 않는다', async () => {
  jobs._resetRma();
  const t = tokens.issueAgentToken('RMA-64B');
  const { reqId } = jobs.enqueueJob('RMA-64B', { cmd: 'uptime', args: {}, timeoutMs: 5000 }, { timeoutMs: 5000 });
  assert.equal(jobs.takeJobs('RMA-64B', 'n1').length, 1);
  settings.setAgentAccess('RMA-64B', { allowedIps: ['10.9.9.9'] });
  let r = await post('/rma-result', { reqId, result: { ok: true, stdout: 'forged' } }, t.token);
  assert.equal(r.status, 403);
  assert.equal(jobs.getJob(reqId).state, 'running', '목록 밖 출처가 결과를 회신(위조)했다');
  settings.setAgentAccess('RMA-64B', {});
  r = await post('/rma-result', { reqId, result: { ok: true, stdout: 'up', exitCode: 0 } }, t.token);
  assert.equal(r.status, 200);
  assert.equal(jobs.getJob(reqId).state, 'done');
});

// ── 개선: 서명 잡 재전송 ──────────────────────────────────────────────────────
test('개선: 엣지는 서명된 같은 reqId 를 두 번 실행하지 않는다(서명 시각 창 안 재전송)', async () => {
  const A = await import('../src/rma/agent.js');
  const { signJob } = await import('../src/rma/signing.js');
  const agent = process.env.AGENT_NAME || process.env.COLLECTOR_DATACENTER || os.hostname();
  const now = Math.floor(Date.now() / 3600_000) * 3600_000;
  const job = { reqId: 'rma_64_replay', cmd: 'uptime', args: {}, timeoutMs: 30_000, issuedAt: now };
  job.sig = signJob('pw-64', { ...job, agent });
  let runs = 0;
  const exec = async () => { runs++; return { ok: true, stdout: 'x', exitCode: 0 }; };
  const r1 = await A.handleJob(job, { password: 'pw-64', now, exec });
  assert.equal(r1.ok, true, r1.reason);
  const r2 = await A.handleJob({ ...job }, { password: 'pw-64', now: now + 60_000, exec });
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /재전송/);
  assert.equal(runs, 1, '같은 서명 잡이 두 번 실행됐다');
  // 다른 reqId 는 영향 없음 · 서명 없는 엣지(비밀번호 없음)는 판정 대상 아님
  const j3 = { ...job, reqId: 'rma_64_other' }; j3.sig = signJob('pw-64', { ...j3, agent });
  assert.equal((await A.handleJob(j3, { password: 'pw-64', now, exec })).ok, true);
  assert.equal((await A.handleJob({ reqId: 'rma_64_nosig', cmd: 'uptime', args: {} }, { password: '', exec })).ok, true);
  assert.equal((await A.handleJob({ reqId: 'rma_64_nosig', cmd: 'uptime', args: {} }, { password: '', exec })).ok, true);
});

// ── 개선(F4): 점검 파라미터도 argv 로 가면 선행 '-' 를 막는다(명령 프리셋 buildCommand 와 같은 규약) ──────────
test('F4: process 점검의 이름(pgrep -c -f <name>)은 - 로 시작할 수 없다 · 정상 이름은 통과', async () => {
  const { buildTest, scheduleItemIssue } = await import('../src/rma/tests.js');
  for (const name of ['-v', '--inverse', '-F']) {
    const b = buildTest('process', { name });
    assert.equal(b.ok, false, `이름 ${name} 이 통과했다 — pgrep 옵션으로 읽힌다`);
    assert.ok(scheduleItemIssue({ test: 'process', args: { name }, intervalSec: 60 }), '중앙 스케줄 저장도 같은 판정이어야 한다');
  }
  assert.equal(buildTest('process', { name: 'node' }).ok, true);
  assert.equal(buildTest('process', { name: 'vmware-portal' }).ok, true, '중간의 - 는 허용');
});

// ── F5: TRUST_PROXY 뒤 — 방화벽이 보는 TCP 상대(프록시)도 웹 허용목록 자기 잠금 검사에 넣는다 ─────────────
test('F5: 프록시 주소가 웹 허용목록 밖이면 적용 계획이 오류(프록시를 거친 접속 전부 차단 방지)', async () => {
  const R = await import('../src/hostaccess/render.js');
  const { settings } = R.normalizeSettings({ web: { mode: 'allowlist', allow: ['10.1.1.0/24'] } }, { portalPorts: ['4000'] });
  const cur = R.parseListAll('public (active)\n  target: default\n  interfaces: ens192\n  services: ssh\n  ports: 4000/tcp\n  rich rules:\n');
  const bad = R.planCommands(settings, cur, { requesterIp: '10.1.1.50', peerIp: '::ffff:10.0.0.2' });
  assert.ok(bad.errors.some((e) => /프록시.*10\.0\.0\.2.*허용목록에 없습니다/.test(e)), JSON.stringify(bad.errors));
  // 프록시가 허용목록 안 → 오류 없음 · 경고(사람 주소로 못 거른다)
  const { settings: s2 } = R.normalizeSettings({ web: { mode: 'allowlist', allow: ['10.1.1.0/24', '10.0.0.2'] } }, { portalPorts: ['4000'] });
  const ok = R.planCommands(s2, cur, { requesterIp: '10.1.1.50', peerIp: '10.0.0.2' });
  assert.deepEqual(ok.errors, []);
  assert.ok(ok.warnings.some((w) => /프록시/.test(w)));
  // 같은 호스트 프록시(루프백) · 직접 접속(상대 = 요청자)은 예전과 같다
  assert.deepEqual(R.planCommands(settings, cur, { requesterIp: '10.1.1.50', peerIp: '127.0.0.1' }).errors, []);
  assert.deepEqual(R.planCommands(settings, cur, { requesterIp: '10.1.1.50', peerIp: '10.1.1.50' }).errors, []);
  assert.deepEqual(R.planCommands(settings, cur, { requesterIp: '10.1.1.50' }).errors, []);
});

test('F5: 계획 · 적용 라우트가 TCP 상대 주소를 넘긴다(소스 대조 — 주석 제거 뒤)', async () => {
  const { stripComments } = await import('./_stripComments.js');
  const src = stripComments(fs.readFileSync(new URL('../src/routes/admin/hostAccess.js', import.meta.url), 'utf8'));
  assert.match(src, /peerIpOf\s*=\s*\(req\)\s*=>[^\n]*req\.socket\?\.remoteAddress/);
  assert.match(src, /planHostAccess\([^\n]*peerIp:\s*peerIpOf\(req\)/);
  assert.match(src, /applyHostAccess\([^\n]*peerIp:\s*peerIpOf\(req\)/);
  const svc = stripComments(fs.readFileSync(new URL('../src/hostaccess/service.js', import.meta.url), 'utf8'));
  assert.match(svc, /planCommands\([^\n]*peerIp/);
  assert.match(svc, /planHostAccess\(input, \{ requesterIp, peerIp \}\)/);
});
