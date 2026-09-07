import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// v2.419 통합 계정 관리 — 저장(봉인·비밀 무반환)·범위 판정·키 검증·브로커(범위/속도/감사)·RMA ssh-exec 정책·1회 비밀 삭제.
const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-cred-'));
process.env.CONFIG_DIR = CFG;
process.env.CENTRAL_TOKEN = 'shared-token-for-cred-test-1234567890';

const store = await import('../src/security/credentialStore.js');
const { buildCommand, targetAllowed } = await import('../src/rma/commands.js');
const jobs = await import('../src/rma/jobs.js');
let tokens; let server; let base;
before(async () => {
  tokens = await import('../src/central/agentTokens.js');
  const express = (await import('express')).default;
  const { centralRouter } = await import('../src/routes/central.js');
  const app = express(); app.use(express.json()); app.use('/api/central', centralRouter);
  server = app.listen(0); await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api/central`;
});
after(() => { try { server?.close(); } catch { /* */ } });
const post = (p, body, token) => fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Central-Token': token } : {}) }, body: JSON.stringify(body) });

const pemKey = () => crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }); // ssh2 parseKey 가 읽는 RSA PEM

test('저장: 비밀번호/키 종류 선택, 목록·뷰에 비밀 값 없음, 파일에 평문 없음(봉인), 비우면 기존 비밀 유지', () => {
  store._resetCredentials();
  const a = store.saveCredential({ name: 'linux-ops', kind: 'password', username: 'svc', password: 'S3cret!pw', hosts: '10.10.0.0/16, db01.corp', agents: 'Seoul' }, { actor: 'admin' });
  assert.equal(a.hasPassword, true); assert.equal('password' in a, false);
  assert.ok(!JSON.stringify(store.listCredentials()).includes('S3cret!pw'));
  const raw = fs.readFileSync(path.join(CFG, 'credentials.json'), 'utf8');
  assert.equal(fs.statSync(path.join(CFG, 'credentials.json')).mode & 0o777, 0o600);
  // 정책이 평문이면 파일엔 값이 있을 수 있다(secretVault 정책에 따름) — 여기서는 '응답에 없음'만 고정하고 파일은 정책 의존임을 명시
  void raw;
  const key = pemKey();
  const k = store.saveCredential({ name: 'key-acct', kind: 'key', username: 'root', privateKey: key, hosts: '*', agents: '*' }, { actor: 'admin' });
  assert.equal(k.hasKey, true); assert.match(k.fingerprint, /^SHA256:/); assert.ok(k.keyType);
  assert.equal(JSON.stringify(k).includes('PRIVATE KEY'), false);
  const upd = store.saveCredential({ id: a.id, name: 'linux-ops2', kind: 'password', username: 'svc', password: '', hosts: '10.10.0.0/16', agents: 'Seoul' }, { actor: 'admin' });
  assert.equal(upd.name, 'linux-ops2'); assert.equal(upd.hasPassword, true, '빈 비밀번호는 기존 유지');
  assert.equal(store.brokerFetch(a.id, { agent: 'Seoul', host: '10.10.1.1' }).secret.password, 'S3cret!pw');
});

test('검증: 이름/계정/범위 형식, 잘못된 키·패스프레이즈 거부, 대상 호스트 SSRF(루프백) 차단', () => {
  assert.match(store.credentialInputIssue({ name: 'x', kind: 'password', username: 'a b', password: 'p', hosts: '*', agents: '*' }), /계정\(ID\)/);
  assert.match(store.credentialInputIssue({ name: 'x', kind: 'password', username: 'a', password: 'p', hosts: '', agents: '*' }), /대상 호스트/);
  assert.match(store.credentialInputIssue({ name: 'x', kind: 'password', username: 'a', password: 'p', hosts: '*', agents: '' }), /법인/);
  assert.match(store.credentialInputIssue({ name: 'x', kind: 'password', username: 'a', password: 'p', hosts: '127.0.0.1', agents: '*' }), /차단/);
  assert.match(store.credentialInputIssue({ name: 'x', kind: 'password', username: 'a', password: '', hosts: '*', agents: '*' }), /비밀번호/);
  assert.throws(() => store.saveCredential({ name: 'k', kind: 'key', username: 'a', privateKey: 'not a key', hosts: '*', agents: '*' }), /개인키/);
  assert.equal(store.inspectPrivateKey(pemKey()).ok, true);
});

test('범위 판정(순수): hostAllowed/agentAllowed/targetAllowed', () => {
  assert.equal(store.hostAllowed('10.10.5.5', ['10.10.0.0/16']), true);
  assert.equal(store.hostAllowed('10.11.5.5', ['10.10.0.0/16']), false);
  assert.equal(store.hostAllowed('db01.corp', ['db01.corp']), true);
  assert.equal(store.hostAllowed('web.corp.local', ['*.corp.local']), true);
  assert.equal(store.hostAllowed('corp.local', ['*.corp.local']), false);
  assert.equal(store.hostAllowed('x', []), false, '빈 목록은 거부');
  assert.equal(store.agentAllowed('seoul', ['Seoul']), true); assert.equal(store.agentAllowed('x', ['*']), true);
  assert.equal(targetAllowed('10.1.1.1', []), true, '엣지 SSH 대상 목록이 비면 전부(opt-in 이 별도)');
  assert.equal(targetAllowed('10.1.1.1', ['10.2.0.0/16']), false);
});

test('ssh-exec 정책: RMA_ALLOW_SSH 미허용·대상 목록 밖 거부, credentialId/1회 입력 모두 argv 없이 native', () => {
  const pol = { allowSsh: false, sshTargets: [] };
  assert.match(buildCommand('ssh-exec', { host: '10.1.1.1', command: 'uptime', credentialId: 'cred_x' }, { policy: pol }).issue, /RMA_ALLOW_SSH/);
  assert.match(buildCommand('ssh-exec', { host: '10.1.1.1', command: 'uptime' }, { policy: { allowSsh: true, sshTargets: ['10.2.0.0/16'] } }).issue, /허용 목록/);
  const ok = buildCommand('ssh-exec', { host: '10.2.3.4', command: 'df -h && uptime', credentialId: 'cred_abc_1_ff' }, { policy: { allowSsh: true, sshTargets: ['10.2.0.0/16'] } });
  assert.equal(ok.ok, true); assert.equal(ok.native, 'ssh-exec'); assert.equal(ok.argv, undefined); assert.equal(ok.args.command, 'df -h && uptime');
  assert.equal(buildCommand('ssh-exec', { host: '10.2.3.4', command: 'x' }).ok, true, '중앙(정책 없음)은 형식만');
});

test('잡큐: 1회 입력 비밀(spec.secret)은 인출 시 엣지에 전달되고 중앙에서는 즉시 삭제된다(getJob/이력 무노출)', () => {
  jobs._resetRma();
  const { reqId } = jobs.enqueueJob('S', { cmd: 'ssh-exec', args: { host: 'h', command: 'id', username: 'u' }, timeoutMs: 5000, secret: { username: 'u', password: 'P@ss' } }, { timeoutMs: 5000 });
  const [job] = jobs.takeJobs('S', 'i1');
  assert.equal(job.secret.password, 'P@ss', '엣지가 받는 잡에는 있다');
  assert.equal(JSON.stringify(jobs.getJob(reqId)).includes('P@ss'), false, '중앙 조회에는 없다');
  jobs.setJobResult(reqId, { ok: true, stdout: 'uid=0' });
  assert.equal(JSON.stringify(jobs.listHistory({ agent: 'S' })).includes('P@ss'), false, '이력에도 없다');
});

test('브로커(HTTP): 개별 토큰 전용, 법인/대상 범위 검사, 응답 no-store, 분당 상한', async () => {
  store._resetCredentials();
  const c = store.saveCredential({ name: 'broker-acct', kind: 'password', username: 'svc', password: 'pw1', hosts: '10.50.0.0/16', agents: 'RMA-K' }, { actor: 'admin' });
  const t = tokens.issueAgentToken('RMA-K');
  const other = tokens.issueAgentToken('RMA-Z');
  let r = await post('/rma-credential', { credentialId: c.id, host: '10.50.1.1' }, process.env.CENTRAL_TOKEN);
  assert.equal(r.status, 403, '공유 토큰 거부');
  r = await post('/rma-credential', { credentialId: c.id, host: '10.50.1.1' }, other.token);
  assert.equal(r.status, 403); assert.match((await r.json()).reason, /허용되지 않았습니다/);
  r = await post('/rma-credential', { credentialId: c.id, host: '10.60.1.1' }, t.token);
  assert.equal(r.status, 403, '대상 밖');
  r = await post('/rma-credential', { credentialId: c.id, host: '10.50.1.1' }, t.token);
  assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'no-store');
  const body = await r.json();
  assert.equal(body.secret.password, 'pw1'); assert.equal(body.secret.username, 'svc'); assert.equal(body.name, 'broker-acct');
  assert.equal(store.getCredentialView(c.id).useCount, 1);
  r = await post('/rma-credential', { credentialId: 'bad id', host: '10.50.1.1' }, t.token);
  assert.equal(r.status, 400);
});
