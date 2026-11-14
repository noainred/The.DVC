/**
 * v3.10.0 SSH 공용 접속 2단계(설계 docs/design/ssh-access §4 · §8 S10 · S11 · 시안 SshKey · SshSec) —
 * 두 사람 승인(approval/store · approval/twoPerson) · 승인 대기 키 · 키 로그인 설정(authorized_keys 한 줄 추가 → 키 재접속 확인 → 실패 시 되돌림 ·
 * from= + 포워딩 금지 · 교체) · 키 거두기 · 보호 장치 · 7b 화면 우회 차단 · 알림 메일 · 비밀 노출 스윕 · 소스 스윕.
 *
 * 실제 api 라우터 · 실제 keyStore + secretVault(encrypted) · 실제 등록부 · 실제 ssh2 가짜 sshd.
 * 가짜 sshd 는 **실제 계정처럼** 군다 — 임시 HOME 을 두고, 받은 명령을 실제 bash 로 돌려 stdout · stderr · 종료 코드를 그대로 돌려주며,
 * 공개키 인증은 그 HOME 의 `.ssh/authorized_keys` 로 판정한다(줄에 from="X" 가 있으면 이 연결의 출발지 주소가 X 일 때만).
 * 두 사람 승인은 이 파일에서 기본값(켬) 그대로다 — 1단계 본래 동작(본인 OTP 만)은 sshAccess390.test.js 가 끄고 본다.
 *
 * `{ todo }` 로 둔 테스트(⑥-b · ⑥-c · ⑪-b · ⑫-c · ⑮-c)는 **소스가 아직 지키지 못하는 동작**이다 — 단언은 기대 동작 그대로 두었다(약하게 고치지 말 것).
 * 소스를 고쳐 통과하면 todo 를 뗀다. 사유 한 줄은 각 테스트의 todo 글에 있다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TMP = process.env.TMPDIR || os.tmpdir();
const DIR = fs.mkdtempSync(path.join(TMP, 'sshkl3100-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'live';
process.env.SETTINGS_OWNERS = 'own,own2,own3,own4,sown';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
process.env.SSH_HOSTKEY_POLICY = 'observe';
delete process.env.CENTRAL_URL;
const TMP_DIRS = [DIR];
const CLOSERS = [];
test.after(() => {
  for (const c of CLOSERS) { try { c(); } catch { /* */ } }
  for (const d of TMP_DIRS) fs.rmSync(d, { recursive: true, force: true });
});
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '../src');

const F = await import('./_sshKeyFixtures.js');
const { generateSecret, generateToken } = await import('../src/auth/totp.js');
// OTP 는 계정마다 한 창(30초)에 세 번까지다 — 쓰기 라우트를 여럿 지나야 해서 OTP 소유자를 넷 둔다(own · own2 가 요청자/승인자, own3 · own4 는 여분).
// adm2 = OTP 는 있지만 설정 소유자가 아닌 관리자(‘권한 없는 요청이 OTP 를 소모하지 않는다’ 를 보려는 계정).
const SECRETS = { own: generateSecret(), own2: generateSecret(), own3: generateSecret(), own4: generateSecret(), adm2: generateSecret() };
fs.writeFileSync(path.join(DIR, 'users.json'), JSON.stringify({ users: [
  { username: 'own', role: 'admin', totpEnabled: true, totpSecret: SECRETS.own },
  { username: 'own2', role: 'admin', totpEnabled: true, totpSecret: SECRETS.own2 },
  { username: 'own3', role: 'admin', totpEnabled: true, totpSecret: SECRETS.own3 },
  { username: 'own4', role: 'admin', totpEnabled: true, totpSecret: SECRETS.own4 },
  { username: 'sown', role: 'admin', scope: { vcenters: ['vcA'] } },
  { username: 'adm', role: 'admin' },
  { username: 'adm2', role: 'admin', totpEnabled: true, totpSecret: SECRETS.adm2 },
] }));
const VAULT = await import('../src/security/secretVault.js');
VAULT.saveSecretsPolicy({ mode: 'encrypted', level: 1 });
const ssh2 = (await import('ssh2')).default;
const AUTH = await import('../src/auth/auth.js');
const KS = await import('../src/bmusage/onboard/keyStore.js');
const REFS = await import('../src/bmusage/onboard/refs.js');
const BM = await import('../src/bmstor/registry.js');
const ST = await import('../src/sshaccess/state.js');
const US = await import('../src/sshaccess/usage.js');
const INS = await import('../src/sshaccess/installed.js');
const AK = await import('../src/sshaccess/authorizedKeys.js');
const SVC = await import('../src/sshaccess/service.js');
const CHK = await import('../src/sshaccess/check.js');
const KL = await import('../src/sshaccess/keyLogin.js');
const G = await import('../src/sshaccess/guards.js');
const N = await import('../src/sshaccess/notify.js');
const AP = await import('../src/approval/store.js');
const TP = await import('../src/approval/twoPerson.js');
const { store } = await import('../src/store.js');
store.snapshot = { ...store.get(), vcenters: [{ id: 'vcA', name: 'KR-SEL' }, { id: 'vcB', name: 'PL-WAW' }, { id: 'vcR', name: 'US-NYC' }] };

// 알림 메일 — 파일 처음부터 붙여 둔다(가짜 발송). 이 파일이 만든 사건이 실린 메일 전부를 마지막 테스트(비밀 스윕)가 본다.
const MAILS = [];
N._setKeyNotifySendForTest(async (m) => { MAILS.push(m); return { ok: true }; });
N.startKeyNotify();

/* ── 도우미 ─────────────────────────────────────────────────────────────── */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const modeOf = (p) => fs.statSync(p).mode & 0o777;
const pubOf = (pem) => { const k = ssh2.utils.parseKey(pem); const p = Array.isArray(k) ? k[0] : k; return `${p.type} ${p.getPublicSSH().toString('base64')}`; };
const RESTRICT = 'no-agent-forwarding,no-port-forwarding,no-X11-forwarding';
/** 개인키 원문이 글에 있는가 — PEM 본문 줄(머리 · 꼬리 줄 제외) 가운데 하나라도 그대로 있으면 샌 것이다(JSON 안에서는 줄 사이가 \n 이지만 줄 내용은 그대로다). */
const pemLines = (pem) => String(pem).split(/\r?\n/).filter((l) => l.length >= 20 && !l.startsWith('-----'));
const leaksKey = (text, pems) => pems.some((p) => pemLines(p).some((l) => String(text).includes(l)));
const ALL_PEMS = [];     // 이 파일이 저장소에 넣은 개인키 전부
const SECRET_WORDS = []; // 1회 비밀번호 · 저장 비밀번호(평문으로 어디에도 남으면 안 된다)
const secret = (s) => { SECRET_WORDS.push(s); return s; };

/** 사용자마다 지금 쓸 수 있는 OTP 코드 하나(1회용 — 카운터는 늘어나야 한다). 한 창에 세 개(앞 · 지금 · 뒤 칸)까지, 넘으면 다음 창을 기다린다. */
const _lastCtr = {};
async function otp(user) {
  for (;;) {
    const now = Date.now();
    const c = Math.floor(now / 30_000);
    const left = 30_000 - (now % 30_000);
    let cand = Math.max((_lastCtr[user] ?? -Infinity) + 1, c - 1);
    if (cand === c - 1 && left < 4_000) cand = c;   // 창 경계 직전의 앞 칸 코드는 검증 때 창 밖일 수 있다
    if (cand > c + 1) { await sleep(left + 30); continue; }
    _lastCtr[user] = cand;
    return generateToken(SECRETS[user], { counter: cand });
  }
}

/** 실제 라우터(요청마다 x-u 머리로 계정을 정한다). */
const express = (await import('express')).default;
const { api: router } = await import('../src/routes/api.js');
const USERS = Object.fromEntries(['own', 'own2', 'own3', 'own4', 'adm', 'adm2'].map((u) => [u, { username: u, role: 'admin', scope: null }]));
USERS.sown = { username: 'sown', role: 'admin', scope: { vcenters: ['vcA'] } };
const app = express(); app.use(express.json({ limit: '4mb' }));
app.use((req, _r, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
app.use('/api', router);
const HTTP = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
CLOSERS.push(() => HTTP.close());
async function call(u, method, p, body) {
  const r = await fetch(`http://127.0.0.1:${HTTP.address().port}/api${p}`, { method, headers: { 'x-u': u, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const txt = await r.text(); let j = {}; try { j = JSON.parse(txt); } catch { /* */ }
  return { s: r.status, j, txt };
}

/**
 * 가짜 sshd — 임시 HOME 을 가진 실제 계정처럼.
 *  · 공개키 인증: HOME/.ssh/authorized_keys 의 줄에 그 공개키가 있을 때만. from="X" 가 있으면 **이 연결의 출발지 주소**가 X 일 때만.
 *    출발지 주소는 연결마다 정할 수 있다(st.ipQueue 에서 하나씩 꺼내고, 비면 st.clientIp) — $SSH_CONNECTION 첫 칸에도 같은 값이 실린다.
 *  · 비밀번호 인증: st.password 하나만. st.offerKbd 면 keyboard-interactive 도 받는다(PAM 을 켠 sshd 처럼).
 *  · exec: 받은 명령을 실제 bash 로 돌린다(HOME · PATH · SSH_CONNECTION 만 준다). st.noSshConnection 이면 SSH_CONNECTION 을 주지 않고,
 *    st.fakeOut(글)이 있으면 명령을 돌리지 않고 그 글만 돌려준다(명령을 받지 않는 제한된 셸 흉내).
 *  · st.onConn(연결 번호) — 연결이 들어올 때 불린다(그 사이 서버 쪽 사정이 바뀐 상황을 만든다).
 *  · 인증 시도(연결 번호 · 방식 · 계정 · 보낸 비밀번호)를 전부 적는다 — ‘다시 시도하지 않았다’ 를 테스트가 센다.
 */
const HOSTKEY = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
const KEY_IN_LINE = /(?:^|[ \t])(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521))[ \t]+([A-Za-z0-9+/]+={0,3})/;
async function fakeSshd() {
  const home = fs.mkdtempSync(path.join(TMP, 'sshkl-home-'));
  TMP_DIRS.push(home);
  const akFile = path.join(home, '.ssh', 'authorized_keys');
  const st = { password: null, clientIp: '127.0.0.1', ipQueue: [], offerKbd: false, noSshConnection: false, fakeOut: null, onConn: null, seen: [], execs: [], conns: 0 };
  const keyAllowed = (data, ip) => {
    let text = '';
    try { text = fs.readFileSync(akFile, 'utf8'); } catch { return null; }
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const m = KEY_IN_LINE.exec(line);
      if (!m || Buffer.compare(Buffer.from(m[2], 'base64'), data) !== 0) continue;
      const from = /from="([^"]*)"/.exec(line.slice(0, m.index));
      if (from && !from[1].split(',').includes(ip)) continue;   // 출발지 제한에 걸린 줄 — 이 줄로는 못 들어온다
      const k = ssh2.utils.parseKey(`${m[1]} ${m[2]}`);
      return Array.isArray(k) ? k[0] : k;
    }
    return null;
  };
  const srv = new ssh2.Server({ hostKeys: [HOSTKEY] }, (client) => {
    st.conns += 1;
    const conn = st.conns;
    const ip = st.ipQueue.length ? st.ipQueue.shift() : st.clientIp;
    try { st.onConn?.(conn); } catch { /* */ }
    const left = () => ['publickey', 'password', ...(st.offerKbd ? ['keyboard-interactive'] : [])];
    client.on('authentication', (ctx) => {
      const rec = { conn, ip, method: ctx.method, username: ctx.username };
      st.seen.push(rec);
      if (ctx.method === 'publickey') {
        rec.signed = !!ctx.signature;
        const pk = keyAllowed(ctx.key.data, ip);
        if (!pk) return ctx.reject(left());
        if (!ctx.signature) return ctx.accept();
        return pk.verify(ctx.blob, ctx.signature, ctx.hashAlgo) ? ctx.accept() : ctx.reject(left());
      }
      if (ctx.method === 'password') {
        rec.password = ctx.password;
        return st.password && ctx.password === st.password ? ctx.accept() : ctx.reject(left());
      }
      if (ctx.method === 'keyboard-interactive' && st.offerKbd) {
        return ctx.prompt([{ prompt: 'Password: ', echo: false }], (answers) => {
          rec.password = answers?.[0];
          return st.password && answers?.[0] === st.password ? ctx.accept() : ctx.reject(left());
        });
      }
      return ctx.reject(left());
    });
    client.on('ready', () => client.on('session', (accept) => {
      const s = accept();
      s.on('exec', (acc, _rej, info) => {
        st.execs.push({ conn, command: info.command });
        const stream = acc();
        if (typeof st.fakeOut === 'string') { stream.write(st.fakeOut); stream.exit(1); stream.end(); return; }
        const env = { HOME: home, PATH: process.env.PATH, ...(st.noSshConnection ? {} : { SSH_CONNECTION: `${ip} 50000 127.0.0.1 22` }) };
        const p = spawn('bash', ['-c', info.command], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        p.stdout.on('data', (d) => stream.write(d));
        p.stderr.on('data', (d) => stream.stderr.write(d));
        p.on('error', () => { stream.exit(127); stream.end(); });
        p.on('close', (code) => { stream.exit(code ?? 1); stream.end(); });
      });
    }));
    client.on('error', () => {});
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  CLOSERS.push(() => srv.close());
  return {
    port: srv.address().port, st, home, akFile,
    /** authorized_keys 를 미리 써 둔다(사람이 넣어 둔 줄 흉내 — 0700 · 0600). */
    writeAk(text) { fs.mkdirSync(path.dirname(akFile), { recursive: true, mode: 0o700 }); fs.writeFileSync(akFile, text, { mode: 0o600 }); },
    readAk() { return fs.existsSync(akFile) ? fs.readFileSync(akFile, 'utf8') : null; },
    /** 인증 시도 · 명령 기록을 비우고 연결 번호를 처음부터 다시 센다. */
    clear() { st.seen.length = 0; st.execs.length = 0; st.conns = 0; st.ipQueue.length = 0; st.onConn = null; },
    /** 비밀번호가 **실제로 서버에 간** 시도(password 방식 · 프롬프트에 답한 keyboard-interactive). 프롬프트 없이 거절된 방식 문의는 비밀번호를 싣지 않는다. */
    passwordTries() { return st.seen.filter((x) => x.password !== undefined); },
    keyTries() { return st.seen.filter((x) => x.method === 'publickey'); },
  };
}

/** 활성 키를 저장소에 넣는다(시험 준비물 — 승인 절차를 지나지 않는다: keyStore 를 직접 부른다). */
function mkKey(name, { folderCorp = 'vcA', folderServer = '', features = ['bm-usage', 'bm-storage'], pending = false } = {}) {
  const k = F.ed25519Key(); ALL_PEMS.push(k.pem);
  const r = KS.addKey({ name, privateKey: k.pem, folderCorp, folderServer, features }, { by: 'fixture', pending });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.key.publicKey, pubOf(k.pem), '저장소의 공개키 = 개인키에서 만든 공개키');
  return { ...r.key, pem: k.pem, pub: pubOf(k.pem), blob: pubOf(k.pem).split(' ')[1] };
}
/** OS 등록부에 서버 하나(가짜 sshd 를 가리킨다). 돌려주는 addr = 화면이 보는 접속처(키 고르기 창과 같은 값). */
function mkServer(name, sshd, extra = {}) {
  const r = BM.saveBmServer({ name, host: '127.0.0.1', port: sshd ? sshd.port : 22, username: 'mon', mounts: ['/'], vcenterId: 'vcA', ...extra });
  assert.ok(r.ok, JSON.stringify(r));
  return { id: r.server.id, addr: SVC.serverKeyCandidates(r.server.id).server.addr };
}
const rawOf = (id) => BM.listBmServersRaw().find((x) => x.id === id);
/** 작업이 끝날 때까지 진행을 물어 본다(화면과 같은 방식 — keyJob). */
async function waitJob(jobId, ms = 30_000) {
  const t0 = Date.now();
  for (;;) {
    const j = SVC.keyJob(jobId);
    assert.ok(j, '작업 기록이 있다');
    if (j.doneAt) return j;
    if (Date.now() - t0 > ms) assert.fail(`작업이 ${ms}ms 안에 끝나지 않았다(${j.done}/${j.total} · ${j.current})`);
    await sleep(20);
  }
}
async function runLogin(args) { const r = SVC.startKeyLogin(args); assert.ok(r.ok, JSON.stringify(r)); return { start: r, job: await waitJob(r.jobId) }; }
async function runRevoke(args) { const r = SVC.startKeyRevoke(args); assert.ok(r.ok, JSON.stringify(r)); return { start: r, job: await waitJob(r.jobId) }; }
/** 임시 HOME 에서 명령을 실제 bash 로 돌린다(ssh 없이 — 순수 빌더 시험). */
function mkHome() { const h = fs.mkdtempSync(path.join(TMP, 'sshkl-h-')); TMP_DIRS.push(h); return h; }
function sh(cmd, home) {
  const r = spawnSync('bash', ['-c', cmd], { env: { HOME: home, PATH: process.env.PATH, SSH_CONNECTION: '127.0.0.1 50000 127.0.0.1 22' }, encoding: 'utf8' });
  return { out: r.stdout, err: r.stderr, code: r.status, m: KL.parseMarker(r.stdout) };
}
const eventsOf = (kind) => ST.listEvents({ limit: 300 }).filter((e) => e.kind === kind);
const approvalsFile = path.join(DIR, AP.APPROVALS_FILE_NAME);
const clearCorrupt = (name) => { for (const f of fs.readdirSync(DIR)) if (f.startsWith(`${name}.corrupt.`)) fs.rmSync(path.join(DIR, f)); };

/* ── 1. 승인 저장소(approval/store.js) ─────────────────────────────────── */
test('① 승인 저장소 — 요청 · 중복 거절 · 요청자는 승인 못 함(대소문자 무시) · 지문 불일치 · 시한 · 실행 기록 · 시한 확정 · 본문 크기 상한 · 복원 제외', async () => {
  // 기준 시각은 실제 시각에서 정시 경계로 떨어뜨려 고정한다(docs/rules/common.md) — 목록은 실제 시각으로 ‘시한 지남’ 을 가르므로 고정 epoch 는 쓰지 않는다.
  const NOW = Math.floor(Date.now() / 3600_000) * 3600_000 - 30 * 60_000;
  const r1 = AP.createRequest({ kind: 'ssh-key-rotate', title: '키 교체 — a → b', target: 'k_a>k_b', corp: 'vcA', payload: { from: 'k_a', to: 'k_b' }, by: 'Own' }, { now: NOW });
  assert.ok(r1.ok, JSON.stringify(r1));
  const q = r1.request;
  assert.match(q.id, /^ap_[0-9a-f]{12}$/);
  assert.deepEqual([q.status, q.requestedBy, q.requestedAt, q.expiresAt], ['pending', 'Own', NOW, NOW + AP.REQUEST_TTL_MS]);
  assert.equal(q.digest, AP.digestOf('ssh-key-rotate', 'k_a>k_b', { to: 'k_b', from: 'k_a' }), '지문은 종류 · 대상 · 본문(키 순서 무관)');
  assert.notEqual(q.digest, AP.digestOf('ssh-key-rotate', 'k_a>k_b', { from: 'k_a', to: 'k_c' }), '본문이 다르면 지문이 다르다');
  assert.equal(modeOf(approvalsFile), 0o600);
  // 같은 종류 · 같은 대상의 대기 요청이 있으면 거절(다른 사람이 요청해도)
  const dup = AP.createRequest({ kind: 'ssh-key-rotate', title: 'x', target: 'k_a>k_b', payload: { from: 'k_a', to: 'k_b' }, by: 'own2' }, { now: NOW + 1000 });
  assert.deepEqual([dup.ok, dup.code, dup.status], [false, 'dup-request', 409]);
  assert.equal(AP.listRequests({ includeDone: false }, { now: NOW + 1000 }).length, 1, '중복 요청은 쌓이지 않았다');
  // 입력 판정 · 본문 크기 상한(본문에 비밀을 넣지 않는 것은 호출부 몫 — 저장소는 크기만 막는다)
  assert.equal(AP.createRequest({ kind: 'Bad Kind', target: 'x', by: 'own' }, { now: NOW }).code, 'bad-kind');
  assert.deepEqual((({ code, status }) => [code, status])(AP.createRequest({ kind: 'ssh-key-delete', target: 'x', by: '' }, { now: NOW })), ['no-user', 403]);
  assert.equal(AP.createRequest({ kind: 'ssh-key-delete', target: 'x', by: 'own', payload: ['k'] }, { now: NOW }).code, 'bad-payload');
  assert.equal(AP.createRequest({ kind: 'ssh-key-delete', target: 'x', by: 'own', payload: { blob: 'x'.repeat(4200) } }, { now: NOW }).code, 'bad-payload', '본문 4KB 상한');
  assert.equal(AP.listRequests({}, { now: NOW }).length, 1, '거절된 요청은 파일에 없다');

  // 요청한 사람은 승인할 수 없다 — 이름 비교는 대소문자 · 앞뒤 공백 무시
  for (const who of ['Own', 'own', 'OWN', ' own ']) {
    const d = AP.decide(q.id, { by: who, approve: true, digest: q.digest }, { now: NOW + 2000 });
    assert.deepEqual([d.ok, d.code, d.status], [false, 'self-approve', 403], who);
  }
  assert.equal(AP.decide(q.id, { by: '', approve: true, digest: q.digest }, { now: NOW + 2000 }).code, 'no-user');
  // 화면이 본 지문과 다르면(또는 지문 없이) 승인하지 않는다
  assert.deepEqual((({ code, status }) => [code, status])(AP.decide(q.id, { by: 'own2', approve: true, digest: '0'.repeat(32) }, { now: NOW + 2000 })), ['digest-mismatch', 409]);
  assert.equal(AP.decide(q.id, { by: 'own2', approve: true }, { now: NOW + 2000 }).code, 'digest-mismatch');
  assert.equal(AP.decide('ap_000000000000', { by: 'own2', approve: true, digest: q.digest }, { now: NOW + 2000 }).code, 'not-found');
  // 시한(24시간)이 지나면 승인할 수 없다(경계 포함) — 거절된 시도는 요청을 바꾸지 않는다
  assert.deepEqual((({ code, status }) => [code, status])(AP.decide(q.id, { by: 'own2', approve: true, digest: q.digest }, { now: NOW + AP.REQUEST_TTL_MS })), ['expired', 409]);
  assert.equal(AP.decide(q.id, { by: 'own2', approve: false }, { now: NOW + AP.REQUEST_TTL_MS + 1 }).code, 'expired');
  assert.deepEqual([AP.getRequest(q.id).status, AP.getRequest(q.id).decidedBy], ['pending', '']);
  // 승인되지 않은 요청에는 실행 결과를 적지 못한다
  assert.equal(AP.markExecuted(q.id, { ok: true }).code, 'not-approved');
  // 다른 설정 소유자 + 같은 지문 + 시한 안 → 승인
  const ok = AP.decide(q.id, { by: 'own2', approve: true, digest: q.digest, note: '확인함' }, { now: NOW + 3000 });
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.deepEqual([ok.request.status, ok.request.decidedBy, ok.request.decidedAt, ok.request.note], ['approved', 'own2', NOW + 3000, '확인함']);
  assert.equal(AP.decide(q.id, { by: 'own3', approve: true, digest: q.digest }, { now: NOW + 4000 }).code, 'not-pending', '두 번 승인되지 않는다');
  assert.equal(AP.markExecuted(q.id, { ok: true }).ok, true);
  assert.equal(AP.getRequest(q.id).status, 'executed');
  assert.equal(AP.markExecuted(q.id, { ok: true }).code, 'not-approved', '실행 기록은 한 번');
  // 실행 실패 = failed(사유와 함께)
  const f1 = AP.createRequest({ kind: 'ssh-key-delete', title: '키 삭제', target: 'k_d', payload: { keyId: 'k_d' }, by: 'own' }, { now: NOW }).request;
  assert.ok(AP.decide(f1.id, { by: 'own2', approve: true, digest: f1.digest }, { now: NOW + 1 }).ok);
  assert.equal(AP.markExecuted(f1.id, { ok: false, code: 'in-use', reason: '쓰는 서버가 있다' }).ok, true);
  assert.deepEqual([AP.getRequest(f1.id).status, AP.getRequest(f1.id).result], ['failed', { ok: false, code: 'in-use', reason: '쓰는 서버가 있다' }]);
  // 돌려보내기 = rejected · 요청자 본인이면 cancelled(지문은 필요 없다)
  const j1 = AP.createRequest({ kind: 'ssh-corp-resume', title: '재개', target: 'vcA', payload: { corp: 'vcA' }, by: 'own' }, { now: NOW }).request;
  assert.equal(AP.decide(j1.id, { by: 'own2', approve: false, note: '아직' }, { now: NOW + 1 }).request.status, 'rejected');
  const j2 = AP.createRequest({ kind: 'ssh-corp-resume', title: '재개', target: 'vcA', payload: { corp: 'vcA' }, by: 'own' }, { now: NOW + 2 }).request;
  assert.ok(j2, '끝난 요청과 같은 대상은 다시 요청할 수 있다');
  assert.equal(AP.decide(j2.id, { by: 'OWN', approve: false }, { now: NOW + 3 }).request.status, 'cancelled');
  // 시한 확정 — 지난 것만 expired 로 바꾸고 그 목록을 돌려준다(뒷정리는 호출부)
  const e1 = AP.createRequest({ kind: 'ssh-guard-change', title: '끄기', target: 'twoPerson', payload: { patch: { twoPerson: false } }, by: 'own' }, { now: NOW }).request;
  const e2 = AP.createRequest({ kind: 'ssh-keystore-reload', title: '다시 읽기', target: 'ssh-keys.json', by: 'own', ttlMs: 2 * 3600_000 }, { now: NOW }).request;
  assert.deepEqual(AP.expireDue({ now: NOW + 3600_000 }), [], '아직 지난 것이 없다');
  const due = AP.expireDue({ now: NOW + 2 * 3600_000 });
  assert.deepEqual(due.map((r) => [r.id, r.status]), [[e2.id, 'expired']]);
  assert.equal(AP.decide(e2.id, { by: 'own2', approve: true, digest: e2.digest }, { now: NOW + 2 * 3600_000 + 1 }).code, 'not-pending');
  assert.equal(AP.getRequest(e1.id).status, 'pending');
  // 목록은 시한이 지난 대기 요청을 expired 로 보여 준다(파일은 expireDue 가 바꾼다)
  assert.equal(AP.listRequests({ kinds: ['ssh-guard-change'] }, { now: NOW + AP.REQUEST_TTL_MS + 1 })[0].status, 'expired');
  assert.equal(AP.listRequests({ includeDone: false }, { now: NOW + AP.REQUEST_TTL_MS + 1 }).length, 0);
  assert.equal(AP.listRequests({ kinds: ['ssh-guard-change'], includeDone: false }, { now: NOW + 1 }).length, 1);
  // 승인은 됐지만 실행 결과가 적히지 않은 요청(실행 중 포탈이 멈춤) — 영원히 ‘승인됨’ 으로 남지 않는다: 10분 뒤 failed(interrupted)로 확정
  const s1 = AP.createRequest({ kind: 'ssh-key-activate', title: '키 등록', target: 'k_s', payload: { keyId: 'k_s' }, by: 'own' }, { now: NOW }).request;
  assert.ok(AP.decide(s1.id, { by: 'own2', approve: true, digest: s1.digest }, { now: NOW + 10 }).ok);
  assert.deepEqual(AP.expireDue({ now: NOW + 10 + AP.INTERRUPTED_MS - 1 }), [], '아직은 실행 중일 수 있다');
  const stuck = AP.expireDue({ now: NOW + 10 + AP.INTERRUPTED_MS });
  assert.deepEqual(stuck.map((r) => [r.id, r.status, r.result.code]), [[s1.id, 'failed', 'interrupted']]);
  assert.equal(AP.markExecuted(s1.id, { ok: true }).code, 'not-approved', '중단으로 확정된 요청은 뒤늦게 ‘실행됨’ 으로 바뀌지 않는다');
  // 백업 복원에서 뺀다 — 되돌리면 지난 요청이 다시 승인 대기가 된다
  const SR = await import('../src/backup/stagedRestore.js');
  assert.ok(SR.RESTORE_EXCLUDE.has('approvals.json'));
  assert.equal(SR.stagedNameIssue(AP.APPROVALS_FILE_NAME), '복원 제외');
  fs.rmSync(approvalsFile, { force: true });
  AP._resetApprovalsForTest();
});

test('② 승인 저장소 fail-closed — 깨졌거나 모양이 틀린 파일이면 새 요청 · 승인 · 돌려보내기 · 실행 기록을 모두 거절하고 손상본을 보존한다(빈 파일로 덮어쓰지 않는다)', () => {
  const NOW = Math.floor(Date.now() / 3600_000) * 3600_000 - 30 * 60_000;
  const p = AP.createRequest({ kind: 'ssh-key-delete', title: '키 삭제', target: 'k_z', payload: { keyId: 'k_z' }, by: 'own' }, { now: NOW }).request;
  const good = fs.readFileSync(approvalsFile, 'utf8');
  const asApproved = JSON.stringify({ requests: [{ ...p, status: 'approved!' }] });
  const bads = ['{ broken', '[]', '{"requests":{}}', '{"requests":[null]}', asApproved,
    JSON.stringify({ requests: [{ ...p, id: 'x' }] }), JSON.stringify({ requests: [{ ...p, payload: 'k_z' }] })];
  for (const bad of bads) {
    clearCorrupt(AP.APPROVALS_FILE_NAME);
    fs.writeFileSync(approvalsFile, bad);
    AP._resetApprovalsForTest();
    const c = AP.createRequest({ kind: 'ssh-key-delete', title: 'x', target: 'k_y', payload: { keyId: 'k_y' }, by: 'own' }, { now: NOW });
    assert.deepEqual([c.ok, c.code, c.status], [false, 'approvals-unreadable', 503], bad.slice(0, 40));
    assert.equal(AP.decide(p.id, { by: 'own2', approve: true, digest: p.digest }, { now: NOW + 1 }).code, 'approvals-unreadable', '승인도 받지 않는다');
    assert.equal(AP.decide(p.id, { by: 'own2', approve: false }, { now: NOW + 1 }).code, 'approvals-unreadable');
    assert.equal(AP.markExecuted(p.id, { ok: true }).code, 'approvals-unreadable');
    assert.deepEqual(AP.expireDue({ now: NOW + 8 * 24 * 3600_000 }), []);
    assert.deepEqual(AP.listRequests({}, { now: NOW }), [], '못 읽은 파일에서 요청을 지어내지 않는다');
    assert.ok(AP.approvalsLoadError());
    const kept = fs.readdirSync(DIR).filter((f) => f.startsWith(`${AP.APPROVALS_FILE_NAME}.corrupt.`));
    assert.equal(kept.length, 1, '손상본을 옆에 보존했다');
    assert.equal(fs.readFileSync(path.join(DIR, kept[0]), 'utf8'), bad, '보존본 = 손상된 원본 그대로');
    assert.equal(fs.existsSync(approvalsFile), false, '빈 승인 파일을 새로 쓰지 않았다');
    // 보존본만 남은 상태(재시작 뒤)에서도 잠긴 채다
    AP._resetApprovalsForTest();
    assert.equal(AP.createRequest({ kind: 'ssh-key-delete', title: 'x', target: 'k_y', payload: {}, by: 'own' }, { now: NOW }).code, 'approvals-unreadable');
    assert.equal(fs.existsSync(approvalsFile), false);
  }
  // 사람이 파일을 되돌리면 풀린다 — 대기 요청은 그대로 대기(승인된 것으로 읽히지 않는다)
  clearCorrupt(AP.APPROVALS_FILE_NAME);
  fs.writeFileSync(approvalsFile, good);
  AP._resetApprovalsForTest();
  assert.equal(AP.approvalsLoadError(), null);
  assert.equal(AP.getRequest(p.id).status, 'pending');
  fs.rmSync(approvalsFile, { force: true });
  AP._resetApprovalsForTest();
});

/* ── 2. 두 사람 승인 — 실제 라우트 ─────────────────────────────────────── */
test('③ 키 등록(두 사람 승인) — 7b 화면은 OTP 를 쓰기 전에 409 · 등록 = 202 승인 대기 · 대기 키는 접속 · 고르기 · 키 로그인 설정 · 공통 계정에 쓰이지 않는다 · 권한 없는 계정은 OTP 전에 403 · 요청자 승인 403 · 다른 소유자 + 같은 지문 → 활성', async () => {
  assert.deepEqual([G.twoPersonOn(), ST.getGuards()], [true, { twoPerson: true, serverRestrict: true }], '보호 장치는 기본 켬');
  const old = mkKey('tp-old'); const nw = mkKey('tp-new-active');
  const K = F.ed25519Key(); ALL_PEMS.push(K.pem);
  // 7b(베어메탈 사용률) 화면의 키 등록 · 교체 · 삭제 — 두 사람 승인이 켜져 있으면 409. 같은 OTP 코드를 세 번 보내도 쓰이지 않는다.
  const code = await otp('own');
  const b1 = await call('own', 'POST', '/tools/bm-usage/ssh-keys', { name: 'tp-7b', privateKey: K.pem, otp: code });
  const b2 = await call('own', 'POST', '/tools/bm-usage/ssh-keys/rotate', { from: old.id, to: nw.id, otp: code });
  const b3 = await call('own', 'DELETE', `/tools/bm-usage/ssh-keys/${old.id}?otp=${code}`);
  for (const b of [b1, b2, b3]) assert.deepEqual([b.s, b.j.code, b.j.needOtp], [409, 'two-person-required', undefined], b.txt);
  assert.equal(KS.keyByName('tp-7b'), null);
  assert.deepEqual([KS.keyById(old.id).status, KS.keyById(nw.id).status], ['active', 'active'], '교체 · 삭제되지 않았다');
  // 승인 절차가 있는 화면 — 위에서 보낸 그 코드가 아직 살아 있다(409 가 OTP 를 소모하지 않았다)
  const add = await call('own', 'POST', '/settings/ssh-access/keys', { name: 'tp-pending', privateKey: K.pem, folderCorp: 'vcA', features: ['bm-usage'], otp: code });
  assert.equal(add.s, 202, add.txt);
  assert.deepEqual([add.j.ok, add.j.pending, add.j.key.status, add.j.request.status, add.j.request.requestedBy, add.j.request.kind], [true, true, 'pending', 'pending', 'own', 'ssh-key-activate']);
  assert.ok(add.j.approvers >= 1, '승인해 줄 다른 설정 소유자 수');
  assert.equal(leaksKey(add.txt, [K.pem]), false, '응답에 개인키 없음');
  const pk = KS.keyByName('tp-pending');
  assert.equal(pk.status, 'pending');
  assert.deepEqual([add.j.request.target, add.j.request.payload.keyId, add.j.request.payload.fingerprint], [pk.id, pk.id, K.fingerprint]);
  // 승인하는 사람이 보는 것 = 요청 지문에 묶이는 것(이름 · 폴더 · 허용 기능 · 지문) — 그 뒤로 대기 키는 바꿀 수 없다(승인 뒤 쓰이는 내용 = 본 내용)
  assert.deepEqual([add.j.request.payload.name, add.j.request.payload.folderCorp, add.j.request.payload.folderServer, add.j.request.payload.features], ['tp-pending', 'vcA', '', ['bm-usage']]);
  assert.equal(add.j.request.digest, AP.digestOf('ssh-key-activate', pk.id, add.j.request.payload));
  assert.equal(SVC.setKeyPlacement({ keyId: pk.id, folderCorp: '', features: null }).code, 'key-pending', '폴더 · 허용 기능을 넓힐 수 없다');
  assert.equal(KS.updateKeyMeta(pk.id, { name: 'tp-renamed' }).code, 'key-pending', '이름을 바꿀 수 없다');
  assert.equal(KS.setKeyPassphrase(pk.id, '').code, 'key-pending');
  assert.deepEqual((({ name, folderCorp, features, status }) => [name, folderCorp, features, status])(KS.keyById(pk.id)), ['tp-pending', 'vcA', ['bm-usage'], 'pending']);
  // 승인 기록 파일 — 요청에는 id · 지문만(개인키 · 봉인본 없음)
  const apRaw = fs.readFileSync(approvalsFile, 'utf8');
  assert.equal(leaksKey(apRaw, [K.pem]), false);
  assert.equal(/PRIVATE KEY|enc\$1\$|passphrase|privateKey/.test(apRaw), false, '승인 요청 본문에 비밀 칸이 없다');
  // 승인 전에는 어디에도 쓰이지 않는다
  const srvP = { id: 'x1', name: 'bm-p', host: '10.9.1.1', vcenterId: 'vcA', username: 'mon', keyRef: pk.id };
  for (const feature of ['conn-test', 'bm-usage', '']) assert.equal(REFS.resolveOsAuth(srvP, { feature }).code, 'key-pending', feature);
  const wr = REFS.withResolvedAuth([srvP], { feature: 'bm-usage' })[0];
  assert.deepEqual([wr.authErrorCode, wr.privateKey, wr.password], ['key-pending', undefined, ''], '폴러 목록 — 키를 싣지 않고 접속하지 않게 표지');
  assert.equal(KS.keyMaterial(pk.id).code, 'key-pending');
  const sv = mkServer('bm-tp1', null, { host: '10.9.1.2', password: secret('Pw-Tp-Stored-1') });
  const ch = await SVC.chooseServerKey({ serverId: sv.id, keyId: pk.id, expectAddr: sv.addr, by: 'own' });
  assert.deepEqual([ch.ok, ch.code, ch.status], [false, 'key-pending', 409]);
  assert.equal(rawOf(sv.id).keyRef, undefined);
  assert.equal(SVC.serverKeyCandidates(sv.id).keys.find((k) => k.id === pk.id)?.selectable, false, '키 고르기 후보에서 고를 수 없다');
  assert.equal(SVC.startKeyLogin({ servers: [sv], keyId: pk.id, by: 'own' }).code, 'key-pending');
  assert.equal(KS.saveAccount({ name: 'tp-acc', kind: 'os', corp: 'vcA', username: 'svc', keyRef: pk.id }, { by: 'own' }).ok, false, '공통 계정의 기본 키가 될 수 없다');
  assert.equal((await SVC.rotateKeyReq({ from: old.id, to: pk.id, by: 'own' })).code, 'key-pending', '대기 키로는 교체를 요청할 수 없다');
  assert.equal((await SVC.deleteKeyReq({ keyId: pk.id, by: 'own' })).code, 'key-pending', '대기 키는 삭제 요청이 아니라 돌려보내기로 지운다');
  // 화면 — 승인 대기 요청 · 키 점검 · 보호 장치
  const v = await call('own', 'GET', '/settings/ssh-access');
  assert.equal(v.s, 200, v.txt);
  const shown = v.j.approvals.find((r) => r.id === add.j.request.id);
  assert.deepEqual([shown.status, shown.label, shown.digest], ['pending', '키 등록', add.j.request.digest]);
  assert.ok(v.j.check.items.some((i) => i.code === 'approvals-pending'));
  assert.deepEqual([v.j.guards.twoPerson, v.j.guards.serverRestrict, v.j.guards.twoPersonActive, v.j.approvalsUnreadable], [true, true, true, false]);
  assert.equal(v.j.keys.find((k) => k.id === pk.id).status, 'pending');
  assert.equal(leaksKey(v.txt, ALL_PEMS), false);

  // 승인 — 권한 없는 계정은 OTP 를 묻기 전에 403(코드가 쓰이지 않는다)
  const url = `/settings/ssh-access/approvals/${add.j.request.id}/approve`;
  const digest = add.j.request.digest;
  const admCode = generateToken(SECRETS.adm2);
  const a0 = await call('adm2', 'POST', url, { digest, otp: admCode });
  assert.deepEqual([a0.s, a0.j.needOtp], [403, undefined], '설정 소유자가 아닌 관리자');
  assert.equal(AUTH.verifyUserOtp('adm2', admCode).ok, true, '그 코드는 쓰이지 않았다(소유자 판정이 OTP 보다 먼저)');
  assert.equal((await call('adm', 'POST', url, { digest })).s, 403);
  assert.equal((await call('sown', 'POST', url, { digest })).s, 403, '범위가 지정된 소유자(소유자 등급 아님)');
  const a1 = await call('own2', 'POST', url, { digest });
  assert.deepEqual([a1.s, a1.j.needOtp], [403, true], '소유자 등급이어도 본인 OTP 가 없으면 승인하지 못한다');
  // 요청한 사람은 OTP 가 맞아도 승인할 수 없다
  const a2 = await call('own', 'POST', url, { digest, otp: await otp('own') });
  assert.deepEqual([a2.s, a2.j.code], [403, 'self-approve'], a2.txt);
  // 화면이 본 지문과 다르면 거절
  const a3 = await SVC.decideApproval(add.j.request.id, { approve: true, by: 'own2', digest: '0'.repeat(32) });
  assert.deepEqual([a3.ok, a3.code, a3.status], [false, 'digest-mismatch', 409]);
  assert.deepEqual([KS.keyById(pk.id).status, AP.getRequest(add.j.request.id).status], ['pending', 'pending'], '거절된 승인은 아무것도 바꾸지 않았다');
  // 다른 설정 소유자 + 같은 지문 + 본인 OTP → 실행(키 활성)
  const a4 = await call('own2', 'POST', url, { digest, otp: await otp('own2') });
  assert.equal(a4.s, 200, a4.txt);
  assert.deepEqual([a4.j.ok, a4.j.request.status, a4.j.request.decidedBy], [true, 'executed', 'own2']);
  assert.equal(leaksKey(a4.txt, [K.pem]), false);
  assert.equal(KS.keyById(pk.id).status, 'active');
  const au = REFS.resolveOsAuth(srvP, { feature: 'bm-usage' });
  assert.deepEqual([au.ok, au.authKind, au.keyFingerprint], [true, 'key', K.fingerprint], '승인 뒤에는 접속에 쓰인다');
  assert.equal((await SVC.decideApproval(add.j.request.id, { approve: true, by: 'own3', digest })).code, 'not-pending', '끝난 요청은 다시 승인되지 않는다');
  // 기록 — 사건(요청 · 결정) · 감사(등록 · 승인)
  assert.ok(eventsOf('approval-requested').some((e) => e.by === 'own' && e.target.includes('tp-pending')));
  assert.ok(eventsOf('approval-decided').some((e) => e.by === 'own2' && e.target.includes('tp-pending') && e.detail.includes('실행됨')));
  const chg = await call('own', 'GET', '/settings/ssh-access/changes');
  assert.equal(chg.s, 200);
  for (const action of ['ssh-access.key.add', 'ssh-access.approval.approve']) assert.ok(chg.j.items.some((e) => e.action === action), action);
  assert.equal(leaksKey(chg.txt, ALL_PEMS), false, '감사 · 사건에 개인키 없음');
});

test('④ 돌려보냄 · 취소 · 시한 만료 · 실행 실패 — 승인 대기 키는 저장소에서 지워진다 · 승인 기록을 못 읽으면 대기 키를 남기지 않고 등록을 거절한다', async () => {
  const add = async (name) => {
    const K = F.ed25519Key(); ALL_PEMS.push(K.pem);
    const r = await SVC.addKeyInFolder({ name, privateKey: K.pem, folderCorp: 'vcA', features: ['bm-usage'] }, { by: 'own' });
    assert.deepEqual([r.ok, r.pending, KS.keyByName(name)?.status], [true, true, 'pending'], JSON.stringify(r));
    return r;
  };
  // 다른 소유자가 돌려보냄(실제 라우트) → 키 삭제
  const r1 = await add('tp-rej');
  const rj = await call('own2', 'POST', `/settings/ssh-access/approvals/${r1.request.id}/reject`, { note: '모르는 키', otp: await otp('own2') });
  assert.equal(rj.s, 200, rj.txt);
  assert.deepEqual([rj.j.request.status, rj.j.request.decidedBy, rj.j.request.note], ['rejected', 'own2', '모르는 키']);
  assert.equal(KS.keyByName('tp-rej'), null, '돌려보낸 요청의 키는 남지 않는다');
  assert.equal((await SVC.decideApproval(r1.request.id, { approve: true, by: 'own3', digest: r1.request.digest })).code, 'not-pending');
  // 요청자 본인이 거두면 ‘취소’
  const r2 = await add('tp-cancel');
  const cn = await SVC.decideApproval(r2.request.id, { approve: false, by: 'own' });
  assert.deepEqual([cn.ok, cn.request.status], [true, 'cancelled']);
  assert.equal(KS.keyByName('tp-cancel'), null);
  // 시한(24시간) 만료 — 주기 점검이 부르는 expireSweep 이 확정하고 대기 키를 지운다
  const r3 = await add('tp-expire');
  assert.deepEqual(TP.expireSweep({ now: Date.now() + AP.REQUEST_TTL_MS - 60_000 }), [], '시한 전에는 그대로');
  assert.equal(KS.keyByName('tp-expire').status, 'pending');
  const swept = TP.expireSweep({ now: Date.now() + AP.REQUEST_TTL_MS + 60_000 });
  assert.deepEqual(swept.map((r) => [r.id, r.status]), [[r3.request.id, 'expired']]);
  assert.equal(KS.keyByName('tp-expire'), null, '시한이 지난 요청의 키는 남지 않는다');
  assert.equal((await SVC.decideApproval(r3.request.id, { approve: true, by: 'own2', digest: r3.request.digest })).code, 'not-pending', '시한이 지난 요청은 승인되지 않는다');
  // 승인됐지만 실행이 실패 — 요청은 failed · 대상은 그대로(쓰는 서버가 있는 키 삭제)
  const used = mkKey('tp-inuse');
  const svU = mkServer('bm-tp-inuse', null, { host: '10.9.1.9', keyRef: used.id, bindApproved: true });
  const dq = await SVC.deleteKeyReq({ keyId: used.id, by: 'own' });
  assert.deepEqual([dq.ok, dq.pending], [true, true], JSON.stringify(dq));
  const dr = await SVC.decideApproval(dq.request.id, { approve: true, by: 'own2', digest: dq.request.digest });
  assert.deepEqual([dr.ok, dr.code, dr.request.status], [false, 'in-use', 'failed'], JSON.stringify(dr));
  assert.equal(KS.keyById(used.id).status, 'active');
  assert.equal(rawOf(svU.id).keyRef, used.id);
  assert.ok(eventsOf('approval-decided').some((e) => e.detail.includes('실행 실패')));
  // 받는 곳(폴더에 직접 넣은 키) 승인도 같은 절차 — 평문 파일은 바로 지우고 키는 승인 대기, 돌려보내면 키도 지워진다
  const INB = await import('../src/sshaccess/inbox.js');
  const IK = F.ed25519Key(); ALL_PEMS.push(IK.pem);
  const idir = INB.inboxPathOf('vcA');
  fs.mkdirSync(idir, { recursive: true });
  fs.writeFileSync(path.join(idir, 'id_tp'), IK.pem, { mode: 0o600 });
  const it = (await INB.scanInbox({ corps: [{ id: 'vcA' }], servers: [] })).items.find((x) => x.file === 'id_tp');
  const ib = await SVC.approveInbox({ relPath: it.relPath, fingerprint: IK.fingerprint, sha: it.sha, name: 'tp-inbox', features: ['bm-usage'], by: 'own' });
  assert.deepEqual([ib.ok, ib.pending, ib.plaintextRemoved, KS.keyByName('tp-inbox').status], [true, true, true, 'pending'], JSON.stringify(ib));
  assert.equal(fs.existsSync(path.join(idir, 'id_tp')), false, '승인을 기다리는 동안 디스크에 평문을 두지 않는다');
  assert.equal((await SVC.decideApproval(ib.request.id, { approve: false, by: 'own2', note: '확인 안 됨' })).request.status, 'rejected');
  assert.equal(KS.keyByName('tp-inbox'), null);
  // 요청이 없는 승인 대기 키(요청 뒷정리가 실패해 남은 것) — 쓰인 적이 없으므로 요청 없이 지울 수 있다. 요청이 살아 있는 대기 키는 돌려보내기로만.
  const orphan = mkKey('tp-orphan', { pending: true });
  assert.equal((await SVC.deleteKeyReq({ keyId: orphan.id, by: 'own' })).ok, true);
  assert.equal(KS.keyById(orphan.id), null);
  // approval/twoPerson — 등록되지 않은 종류는 요청도 승인도 하지 않는다 · 실행이 던지면 failed + 뒷정리
  assert.equal((await TP.submit({ kind: 'not-registered', title: 'x', target: 'x', by: 'own' }, () => ({ ok: true }))).code, 'unknown-kind');
  const unk = AP.createRequest({ kind: 'not-registered', title: 'x', target: 'x', by: 'own' }).request;
  const ua = await TP.approve(unk.id, { by: 'own2', digest: unk.digest });
  assert.deepEqual([ua.ok, ua.code, AP.getRequest(unk.id).status], [false, 'unknown-kind', 'pending'], '모르는 종류는 승인 기록도 남기지 않는다');
  assert.equal((await SVC.decideApproval(unk.id, { approve: true, by: 'own2', digest: unk.digest })).code, 'not-found', '이 화면의 종류가 아닌 요청은 이 화면에서 승인되지 않는다');
  assert.equal(TP.reject(unk.id, { by: 'own' }).request.status, 'cancelled');
  const calls = [];
  TP.registerKind('test-throws', { label: '시험', run: () => { throw new Error('boom'); }, discard: (p, why) => calls.push([p.x, why]) });
  const now0 = Date.now();
  assert.equal((await TP.submit({ kind: 'test-throws', title: 't', target: 't1', payload: { x: 1 }, by: 'own', required: false }, () => ({ ok: true, ranNow: true }))).ranNow, true, '두 사람 승인이 꺼진 호출은 바로 실행');
  const tq = await TP.submit({ kind: 'test-throws', title: 't', target: 't1', payload: { x: 1 }, by: 'own' }, () => assert.fail('켜져 있으면 바로 실행하지 않는다'));
  assert.deepEqual([tq.ok, tq.pending], [true, true]);
  const ta = await TP.approve(tq.request.id, { by: 'own2', digest: tq.request.digest });
  assert.deepEqual([ta.ok, ta.code, ta.request.status, calls], [false, 'error', 'failed', [[1, 'failed']]], JSON.stringify(ta));
  assert.ok(ta.request.decidedAt >= now0);
  // 복원(적용 시점 합치기)은 승인 대기 키를 활성으로 되살리지 않는다 — 번들이 ‘active’ 라고 적어 와도 지금 상태(대기)를 유지한다
  const SR = await import('../src/backup/stagedRestore.js');
  const pend = mkKey('tp-restore-pending', { pending: true });
  const bundle = JSON.parse(KS.redactKeyStoreText(fs.readFileSync(path.join(DIR, 'ssh-keys.json'), 'utf8')).text);
  for (const k of bundle.keys) if (k.id === pend.id) { k.status = 'active'; k.features = null; k.folderCorp = ''; }
  const merged = JSON.parse(SR.reconcileForApply('ssh-keys.json', JSON.stringify(bundle), DIR).content);
  assert.deepEqual((({ status, features, folderCorp }) => [status, features, folderCorp])(merged.keys.find((k) => k.id === pend.id)), ['pending', ['bm-usage', 'bm-storage'], 'vcA']);
  assert.ok(KS._removeKey(pend.id).ok);
  // 승인 기록 파일을 못 읽으면 — 등록을 거절하고 승인 대기 키를 남기지 않는다(요청 없는 대기 키가 생기지 않게)
  const good = fs.readFileSync(approvalsFile, 'utf8');
  fs.writeFileSync(approvalsFile, '{ broken');
  AP._resetApprovalsForTest();
  const K = F.ed25519Key(); ALL_PEMS.push(K.pem);
  const bad = await SVC.addKeyInFolder({ name: 'tp-noapprovals', privateKey: K.pem, folderCorp: 'vcA', features: ['bm-usage'] }, { by: 'own' });
  assert.deepEqual([bad.ok, bad.code, bad.status], [false, 'approvals-unreadable', 503]);
  assert.equal(KS.keyByName('tp-noapprovals'), null);
  assert.equal((await SVC.deleteKeyReq({ keyId: used.id, by: 'own' })).code, 'approvals-unreadable');
  assert.equal(KS.keyById(used.id).status, 'active', '승인 기록을 못 읽는다고 바로 실행되지 않는다');
  const vu = await SVC.buildView();
  assert.deepEqual([vu.approvalsUnreadable, vu.approvals], [true, []], '화면은 ‘못 읽음’ 표지를 받는다(빈 목록을 승인 대기 없음으로 읽지 않게)');
  clearCorrupt(AP.APPROVALS_FILE_NAME);
  fs.writeFileSync(approvalsFile, good);
  AP._resetApprovalsForTest();
  assert.equal(AP.approvalsLoadError(), null);
});

test('⑤ 키 교체 · 삭제 — 라우트는 요청만 만든다(202) · 승인 전에는 서버 · 키가 그대로 · 다른 소유자가 승인해야 실행된다', async () => {
  const kOld = mkKey('rot-old'); const kNew = mkKey('rot-new'); const kDel = mkKey('rot-del');
  const sv = mkServer('bm-rot1', null, { host: '10.9.1.3', keyRef: kOld.id, bindApproved: true });
  assert.equal(rawOf(sv.id).keyRef, kOld.id);
  const rq = await call('own', 'POST', '/settings/ssh-access/keys/rotate', { from: kOld.id, to: kNew.id, otp: await otp('own') });
  assert.equal(rq.s, 202, rq.txt);
  assert.deepEqual([rq.j.pending, rq.j.request.kind, rq.j.request.payload.from, rq.j.request.payload.to], [true, 'ssh-key-rotate', kOld.id, kNew.id]);
  assert.deepEqual([rawOf(sv.id).keyRef, KS.keyById(kOld.id).status], [kOld.id, 'active'], '승인 전에는 아무것도 바뀌지 않았다');
  assert.equal((await SVC.rotateKeyReq({ from: kOld.id, to: kNew.id, by: 'own2' })).code, 'dup-request', '같은 요청을 다른 사람이 또 만들 수 없다');
  assert.equal((await SVC.decideApproval(rq.j.request.id, { approve: true, by: 'own', digest: rq.j.request.digest })).code, 'self-approve');
  assert.equal(rawOf(sv.id).keyRef, kOld.id);
  const ok = await SVC.decideApproval(rq.j.request.id, { approve: true, by: 'own2', digest: rq.j.request.digest });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.deepEqual([rawOf(sv.id).keyRef, KS.keyById(kOld.id).status, ok.request.status], [kNew.id, 'retired', 'executed']);
  // 삭제 — DELETE 는 OTP 를 쿼리로
  const dq = await call('own3', 'DELETE', `/settings/ssh-access/keys/${kDel.id}?otp=${await otp('own3')}`);
  assert.equal(dq.s, 202, dq.txt);
  assert.deepEqual([dq.j.pending, dq.j.request.kind, dq.j.request.payload.keyId], [true, 'ssh-key-delete', kDel.id]);
  assert.equal(KS.keyById(kDel.id).status, 'active', '승인 전에는 지워지지 않았다');
  assert.equal((await SVC.decideApproval(dq.j.request.id, { approve: true, by: 'own3', digest: dq.j.request.digest })).code, 'self-approve');
  assert.ok(KS.keyById(kDel.id));
  const dk = await SVC.decideApproval(dq.j.request.id, { approve: true, by: 'own', digest: dq.j.request.digest });
  assert.equal(dk.ok, true, JSON.stringify(dk));
  assert.equal(KS.keyById(kDel.id), null);
  assert.equal((await SVC.deleteKeyReq({ keyId: 'k_000000000000', by: 'own' })).code, 'not-found');
});

test('⑥ 다시 여는 방향은 두 사람 승인 — 법인 사용 재개 202(승인 전에는 중지 그대로) · 키 저장소 다시 읽기 202 · 보호 장치: 켜기는 바로, 끄기는 요청', async () => {
  const kB = mkKey('resume-b', { folderCorp: 'vcB' });
  const srvB = { id: 'xb', name: 'bm-b1', host: '10.9.2.1', vcenterId: 'vcB', username: 'mon', keyRef: kB.id };
  // 멈추는 방향은 본인만으로 바로
  assert.equal(SVC.stopCorp('vcB', { by: 'own', reason: '유출 의심' }).ok, true);
  assert.equal(REFS.resolveOsAuth(srvB, { feature: 'bm-usage' }).code, 'corp-stopped');
  const rs = await call('own3', 'DELETE', `/settings/ssh-access/corps/vcB/stop?otp=${await otp('own3')}`);
  assert.equal(rs.s, 202, rs.txt);
  assert.deepEqual([rs.j.pending, rs.j.request.kind, rs.j.request.target], [true, 'ssh-corp-resume', 'vcB']);
  assert.equal(ST.stopFor('vcB')?.by, 'own', '승인 전에는 사용 중지가 그대로다');
  assert.equal(REFS.resolveOsAuth(srvB, { feature: 'bm-usage' }).code, 'corp-stopped');
  assert.equal((await SVC.resumeCorp('vcB', { by: 'own2' })).code, 'dup-request');
  assert.equal((await SVC.decideApproval(rs.j.request.id, { approve: true, by: 'own3', digest: rs.j.request.digest })).code, 'self-approve');
  assert.ok(ST.stopFor('vcB'));
  assert.equal((await SVC.decideApproval(rs.j.request.id, { approve: true, by: 'own', digest: rs.j.request.digest })).ok, true);
  assert.equal(ST.stopFor('vcB'), null);
  assert.equal(REFS.resolveOsAuth(srvB, { feature: 'bm-usage' }).ok, true);
  assert.ok(eventsOf('corp-resume').some((e) => e.corp === 'vcB' && e.by === 'own'), '재개 사건은 승인한 사람 이름으로');
  const ns = await SVC.resumeCorp('vcA', { by: 'own' });
  assert.deepEqual([ns.ok, ns.code, ns.pending], [false, 'not-stopped', undefined], '중지 상태가 아니면 요청을 만들지 않는다');
  // 키 저장소 다시 읽기(포탈 밖 변경 받아들이기)
  const before = eventsOf('keystore-reloaded').length;
  const rl = await call('own3', 'POST', '/settings/ssh-access/reload-keystore', { otp: await otp('own3') });
  assert.equal(rl.s, 202, rl.txt);
  assert.deepEqual([rl.j.pending, rl.j.request.kind], [true, 'ssh-keystore-reload']);
  assert.equal(eventsOf('keystore-reloaded').length, before, '승인 전에는 다시 읽지 않았다');
  const ro = await SVC.decideApproval(rl.j.request.id, { approve: true, by: 'own', digest: rl.j.request.digest });
  assert.equal(ro.ok, true, JSON.stringify(ro));
  assert.deepEqual([eventsOf('keystore-reloaded').length, eventsOf('keystore-reloaded')[0].by], [before + 1, 'own']);
  // 보호 장치 — 켜는 것은 바로 · 끄는 것은 다른 소유자의 승인 뒤(한 요청에 섞여 있어도 따로)
  assert.equal(ST.setGuards({ serverRestrict: false }, { by: 'fixture' }).ok, true);
  const gd = await call('own2', 'PUT', '/settings/ssh-access/guards', { serverRestrict: true, twoPerson: false, otp: await otp('own2') });
  assert.equal(gd.s, 202, gd.txt);
  assert.deepEqual([gd.j.pending, gd.j.request.kind, gd.j.request.payload], [true, 'ssh-guard-change', { patch: { twoPerson: false } }]);
  assert.deepEqual(ST.getGuards(), { twoPerson: true, serverRestrict: true }, '켜기는 바로 적용 · 끄기는 아직');
  assert.equal(G.twoPersonOn(), true);
  assert.equal((await SVC.decideApproval(gd.j.request.id, { approve: true, by: 'own2', digest: gd.j.request.digest })).code, 'self-approve', '혼자서는 두 사람 승인을 끌 수 없다');
  assert.equal(G.twoPersonOn(), true);
  assert.equal((await SVC.decideApproval(gd.j.request.id, { approve: true, by: 'own', digest: gd.j.request.digest })).ok, true);
  assert.deepEqual([ST.getGuards().twoPerson, G.twoPersonOn(), G.twoPersonRedirect()], [false, false, null]);
  assert.ok(CHK.buildKeyCheck({ policyMode: 'encrypted', drift: null, guards: ST.getGuards() }).items.some((i) => i.code === 'two-person-off'), '끈 상태는 키 점검이 경고');
  // 끈 설치에서는 본인만으로 바로 실행된다(1단계 동작)
  const K = F.ed25519Key(); ALL_PEMS.push(K.pem);
  const im = await SVC.addKeyInFolder({ name: 'tp-immediate', privateKey: K.pem, folderCorp: 'vcA', features: ['bm-usage'] }, { by: 'own' });
  assert.deepEqual([im.ok, im.pending, KS.keyByName('tp-immediate').status], [true, undefined, 'active']);
  // 다시 켜기 — 요청 없이 바로
  const on = await SVC.changeGuards({ twoPerson: true }, { by: 'own' });
  assert.deepEqual([on.ok, on.pending, G.twoPersonOn()], [true, undefined, true]);
  const off = await SVC.changeGuards({ serverRestrict: false }, { by: 'own' });
  assert.deepEqual([off.ok, off.pending, ST.getGuards().serverRestrict], [true, true, true], '서버 쪽 제한 끄기도 요청');
  assert.equal((await SVC.decideApproval(off.request.id, { approve: false, by: 'own' })).request.status, 'cancelled');
  assert.deepEqual(ST.getGuards(), { twoPerson: true, serverRestrict: true });
  assert.ok(eventsOf('guard-changed').length >= 2);
});

test('⑥-b 승인해 줄 사람이 없는 설치(설정 소유자 한 명) — 두 사람 승인 끄기는 본인만으로 바로 된다(영영 잠기지 않게 — guards.js) · 승인할 수 있는 사람 수는 0',
  { todo: 'guards.js otherOwners 가 로그인 수단이 없는 자동 포함 계정(noainred — 비밀번호 · OTP 없이 시드)과 범위 소유자(소유자 등급 403)까지 세어, 혼자뿐인 설치에서 끄기 요청이 승인 대기로 갇힌다' }, () => {
    const d = fs.mkdtempSync(path.join(TMP, 'sshkl-solo-'));
    TMP_DIRS.push(d);
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
      const fs = await import('node:fs'); const path = await import('node:path');
      fs.writeFileSync(path.join(process.env.CONFIG_DIR, 'users.json'), JSON.stringify({ users: [
        { username: 'solo', role: 'admin', totpEnabled: true, totpSecret: ${JSON.stringify(generateSecret())} },
        { username: 'scoped', role: 'admin', scope: { vcenters: ['vcA'] } } ] }));
      const AUTH = await import(${JSON.stringify(path.join(SRC, 'auth/auth.js'))});
      const SVC = await import(${JSON.stringify(path.join(SRC, 'sshaccess/service.js'))});
      const ST = await import(${JSON.stringify(path.join(SRC, 'sshaccess/state.js'))});
      const SEC = await import(${JSON.stringify(path.join(SRC, 'security/securitySettings.js'))});
      const su = AUTH.getUser('noainred');
      const before = (await import(${JSON.stringify(path.join(SRC, 'sshaccess/guards.js'))})).twoPersonOn();
      const r = await SVC.changeGuards({ twoPerson: false }, { by: 'solo' });
      console.log(JSON.stringify({ before, owners: SEC.loadSessionSecurity().settingsOwners.filter((x) => x !== 'solo').sort(), superCanLogin: !!(su && (su.passwordHash || su.totpEnabled)),
        ok: r.ok, pending: r.pending === true, approvers: r.approvers ?? 0, twoPerson: ST.getGuards().twoPerson }));
    `], { env: { ...process.env, CONFIG_DIR: d, SETTINGS_OWNERS: 'solo,scoped' }, encoding: 'utf8' }).trim().split('\n').pop();
    const j = JSON.parse(out);
    // 전제 — 요청자 말고 유효 소유자 목록에 있는 이름은 로그인 수단이 없는 자동 포함 계정과 범위 소유자뿐이다(둘 다 승인 라우트를 통과하지 못한다)
    assert.deepEqual([j.before, j.owners, j.superCanLogin, j.ok], [true, ['noainred', 'scoped'], false, true], out);
    assert.deepEqual([j.pending, j.twoPerson, j.approvers], [false, false, 0], '승인할 사람이 없으면 끄기는 바로 · 승인자 수는 0 으로 알린다');
  });

test('⑥-c 복원 번들이 실어 온 새 개인키 — 복원(적용 시점 합치기)이 두 사람 승인 · OTP 없이 활성 키를 들이지 않는다(백업에는 개인키가 없다 — 설계 S13)',
  { todo: 'keyBundle.js mergeRedactedKeyStore 가 지금 파일에 없는 키도 번들에 개인키가 실려 있으면 그대로(상태 active) 받아들인다 — 복원 라우트는 OTP · 승인을 묻지 않는다' }, async () => {
    const SR = await import('../src/backup/stagedRestore.js');
    const P = await import('../src/bmusage/onboard/keyParse.js');
    const NEW = F.ed25519Key();
    const pp = P.parsePrivateKey(NEW.pem, '');
    const cur = fs.readFileSync(path.join(DIR, 'ssh-keys.json'), 'utf8');
    const bundle = JSON.parse(KS.redactKeyStoreText(cur).text);
    assert.equal(leaksKey(JSON.stringify(bundle), ALL_PEMS) || /enc\$1\$/.test(JSON.stringify(bundle)), false, '정상 번들에는 개인키도 봉인본도 없다');
    bundle.keys.push({ id: 'k_abcabcabcabc', name: 'tp-injected', algo: pp.algo, sshType: pp.sshType, bits: pp.bits, fingerprint: pp.fingerprint, publicKey: pp.publicKey,
      privateKey: NEW.pem, passphrase: '', createdBy: 'own', createdAt: Date.now(), status: 'active', folderCorp: '', folderServer: '', features: null });
    const merged = JSON.parse(SR.reconcileForApply('ssh-keys.json', JSON.stringify(bundle), DIR).content);
    const usable = merged.keys.filter((k) => k.fingerprint === pp.fingerprint && k.status !== 'pending' && k.status !== 'retired' && k.privateKey);
    assert.deepEqual(usable.map((k) => k.name), [], '지금 저장소에 없던 키가 승인 없이 쓸 수 있는 키로 들어오지 않는다');
  });

/* ── 3. 줄 · 명령 빌더(순수) — 실제 bash ───────────────────────────────── */
const BK = F.ed25519Key();           // 빌더 시험용 키(저장소에 넣지 않는다)
const BPUB = pubOf(BK.pem); const BBLOB = BPUB.split(' ')[1];
const BID = 'k_0123456789ab'; const BMARK = `portal-ssh:${BID}`;
const OTHER = `${pubOf(F.ed25519Key().pem)} ops@bastion`;   // 다른 사람이 넣어 둔 줄

test('⑦ buildKeyLine · parseMarker — 제한 옵션 · 표식 · 틀린 출발지 주소 · 키 id · 공개키는 null · 작은따옴표가 들어갈 수 없다 · 표지는 마지막 ##KL 줄', () => {
  assert.equal(KL.buildKeyLine({ publicKey: BPUB, keyId: BID }), `${BPUB} ${BMARK}`);
  assert.equal(KL.buildKeyLine({ publicKey: `${BPUB} some comment`, keyId: BID }), `${BPUB} ${BMARK}`, '공개키의 설명은 버리고 표식을 단다');
  assert.equal(KL.buildKeyLine({ publicKey: BPUB, keyId: BID, restrict: true, fromIp: '10.20.30.40' }), `from="10.20.30.40",${RESTRICT} ${BPUB} ${BMARK}`);
  assert.equal(KL.buildKeyLine({ publicKey: BPUB, keyId: BID, restrict: true, fromIp: 'fd00::1' }), `from="fd00::1",${RESTRICT} ${BPUB} ${BMARK}`);
  assert.equal(KL.buildKeyLine({ publicKey: BPUB, keyId: BID, restrict: false, fromIp: '10.20.30.40' }), `${BPUB} ${BMARK}`, '제한이 꺼져 있으면 옵션이 없다');
  assert.deepEqual([...KL.RESTRICT_OPTIONS], RESTRICT.split(','));
  assert.equal(KL.markOf(BID), BMARK);
  // 출발지 주소 — IP 글자만(따옴표 · 쉼표 · 공백 · 셸 글자 · 이름은 거절)
  for (const ip of ['10.0.0.1"', '10.0.0.1,10.0.0.2', '10.0.0.1 10.0.0.2', '$(id)', "1.2.3.4'", '*', 'bastion.corp', '10.0.0.0/8', 'fe80::1%eth0', '1.2.3.4\n5.6.7.8']) {
    assert.equal(KL.buildKeyLine({ publicKey: BPUB, keyId: BID, restrict: true, fromIp: ip }), null, JSON.stringify(ip));
  }
  for (const keyId of ['', 'k_', 'k_XYZ123', 'x_0123456789ab', "k_0123456789ab'", 'k_0123456789ab x', 'k_0123456789ab\n']) {
    assert.equal(KL.buildKeyLine({ publicKey: BPUB, keyId }), null, JSON.stringify(keyId));
    assert.equal(KL.installCommand({ publicKey: BPUB, keyId, line: `${BPUB} ${BMARK}` }), null);
    assert.equal(KL.removeCommand({ publicKey: BPUB, keyId }), null);
  }
  for (const publicKey of ['', 'ssh-ed25519', BBLOB, `ssh-dss ${BBLOB}`, `ssh-ed25519 ${BBLOB.slice(0, 20)}`, `ssh-ed25519 ${BBLOB.slice(0, -4)}'x;y`, `ssh-ed25519 $(touch${BBLOB})`, `'ssh-ed25519 ${BBLOB}`]) {
    assert.equal(KL.buildKeyLine({ publicKey, keyId: BID }), null, publicKey.slice(0, 40));
    assert.equal(KL.splitPublicKey(publicKey), null);
    assert.equal(KL.removeCommand({ publicKey, keyId: BID }), null);
  }
  for (const o of [{}, { restrict: true }, { restrict: true, fromIp: '10.20.30.40' }, { restrict: true, fromIp: '::1' }]) {
    const line = KL.buildKeyLine({ publicKey: BPUB, keyId: BID, ...o });
    assert.equal(/['\\\r\n]/.test(line), false, '작은따옴표 · 역슬래시 · 줄바꿈이 없다(명령의 작은따옴표 안에 그대로 끼운다)');
  }
  // installCommand — 줄이 그 키 · 그 표식의 줄이 아니거나 작은따옴표가 있으면 명령을 만들지 않는다
  const line = KL.buildKeyLine({ publicKey: BPUB, keyId: BID });
  assert.equal(KL.installCommand({ publicKey: BPUB, keyId: BID, line: `${OTHER.split(' ').slice(0, 2).join(' ')} ${BMARK}` }), null, '다른 공개키의 줄');
  assert.equal(KL.installCommand({ publicKey: BPUB, keyId: BID, line: `${BPUB} portal-ssh:k_ffffffffffff` }), null, '다른 표식의 줄');
  assert.equal(KL.installCommand({ publicKey: BPUB, keyId: BID, line: `command="echo 'x'" ${line}` }), null, '작은따옴표가 든 줄');
  assert.equal(KL.installCommand({ publicKey: BPUB, keyId: BID, line: `${line}\n${OTHER}` }), null, '줄바꿈이 든 줄');
  assert.equal(typeof KL.installCommand({ publicKey: BPUB, keyId: BID, line }), 'string');
  // 표지 — 마지막 ##KL 줄(로그인 배너가 앞에 섞여도)
  assert.deepEqual(KL.parseMarker('Welcome to bm-a1\nLast login: …\n##KL ip 10.0.0.9\n'), { kind: 'ip', ip: '10.0.0.9' });
  assert.deepEqual(KL.parseMarker('##KL ip 10.0.0.9"\n'), { kind: 'ip', ip: '' }, 'IP 꼴이 아니면 비운다(from= 에 쓰지 않는다)');
  assert.deepEqual(KL.parseMarker('##KL ip\n'), { kind: 'ip', ip: '' });
  assert.deepEqual(KL.parseMarker('##KL added\n##KL present-marked\n'), { kind: 'present-marked' });
  assert.deepEqual(KL.parseMarker('motd\r\n  ##KL present-unmarked  \r\n'), { kind: 'present-unmarked' });
  assert.deepEqual(KL.parseMarker('##KL removed 2 unmarked 1\n'), { kind: 'removed', removed: 2, unmarked: 1 });
  assert.deepEqual(KL.parseMarker('##KL none\n'), { kind: 'none' });
  assert.deepEqual(KL.parseMarker('##KL fail symlink\n'), { kind: 'fail', why: 'symlink' });
  for (const s of ['', 'added', 'x ##KL added', '##KLadded', '##KL whatever', null]) assert.deepEqual(KL.parseMarker(s), { kind: 'unknown' }, JSON.stringify(s));
  assert.deepEqual(sh(KL.WHOAMI_COMMAND, mkHome()).m, { kind: 'ip', ip: '127.0.0.1' }, '서버가 본 출발지 = $SSH_CONNECTION 첫 칸');
});

test('⑧ installCommand(실제 bash) — 새로 더함 · 포탈 줄이 이미 있음 · 표식 없는 같은 키 줄이 있음 · 끝에 줄바꿈이 없는 파일 · 심볼릭 링크는 건드리지 않음 · ~/.ssh 0700 · 파일 0600', () => {
  const line = KL.buildKeyLine({ publicKey: BPUB, keyId: BID, restrict: true, fromIp: '127.0.0.1' });
  const cmd = KL.installCommand({ publicKey: BPUB, keyId: BID, line });
  // ~/.ssh 도 파일도 없던 계정
  const h1 = mkHome(); const f1 = path.join(h1, '.ssh', 'authorized_keys');
  const a = sh(cmd, h1);
  assert.deepEqual([a.m, a.code], [{ kind: 'added' }, 0], a.out + a.err);
  assert.equal(fs.readFileSync(f1, 'utf8'), `${line}\n`);
  assert.deepEqual([modeOf(path.join(h1, '.ssh')), modeOf(f1)], [0o700, 0o600], '새로 만든 폴더 · 파일 권한');
  // 다시 — 포탈 줄이 이미 있다(더하지 않는다)
  const b = sh(cmd, h1);
  assert.deepEqual(b.m, { kind: 'present-marked' });
  assert.equal(fs.readFileSync(f1, 'utf8'), `${line}\n`, '두 번 넣지 않았다');
  // 표식 없는 같은 키 줄(사람이 직접 넣은 줄)이 있다 — 더하지 않고 그렇게 알린다
  const h2 = mkHome(); const f2 = path.join(h2, '.ssh', 'authorized_keys');
  fs.mkdirSync(path.join(h2, '.ssh'), { mode: 0o755 }); fs.chmodSync(path.join(h2, '.ssh'), 0o755);
  const manual = `${OTHER}\n${BPUB} admin@laptop\n`;
  fs.writeFileSync(f2, manual, { mode: 0o644 }); fs.chmodSync(f2, 0o644);
  const c = sh(cmd, h2);
  assert.deepEqual(c.m, { kind: 'present-unmarked' });
  assert.equal(fs.readFileSync(f2, 'utf8'), manual);
  // 표식은 있지만 다른 키의 줄 · 같은 키지만 다른 포탈 키 id 의 표식 → 이 키의 포탈 줄이 아니다
  const h3 = mkHome(); const f3 = path.join(h3, '.ssh', 'authorized_keys');
  fs.mkdirSync(path.join(h3, '.ssh'), { mode: 0o755 }); fs.chmodSync(path.join(h3, '.ssh'), 0o755);
  const noNl = `${OTHER.split(' ').slice(0, 2).join(' ')} ${BMARK}`;   // 끝에 줄바꿈이 없다
  fs.writeFileSync(f3, noNl, { mode: 0o644 }); fs.chmodSync(f3, 0o644);
  const ino = fs.statSync(f3).ino;
  const d = sh(cmd, h3);
  assert.deepEqual(d.m, { kind: 'added' }, d.out + d.err);
  assert.equal(fs.readFileSync(f3, 'utf8'), `${noNl}\n${line}\n`, '끝에 줄바꿈이 없던 파일 — 앞 줄에 붙지 않게 줄바꿈을 먼저 넣는다');
  assert.deepEqual([modeOf(path.join(h3, '.ssh')), modeOf(f3), fs.statSync(f3).ino], [0o755, 0o644, ino], '이미 있던 폴더 · 파일의 권한 · inode 는 바꾸지 않는다');
  // 빈 파일 — 줄바꿈을 앞에 넣지 않는다
  const h4 = mkHome(); const f4 = path.join(h4, '.ssh', 'authorized_keys');
  fs.mkdirSync(path.join(h4, '.ssh')); fs.writeFileSync(f4, '');
  assert.deepEqual(sh(cmd, h4).m, { kind: 'added' });
  assert.equal(fs.readFileSync(f4, 'utf8'), `${line}\n`);
  // 심볼릭 링크 — 건드리지 않는다(가리키는 파일도 그대로)
  const h5 = mkHome(); const f5 = path.join(h5, '.ssh', 'authorized_keys'); const target = path.join(h5, 'elsewhere');
  fs.mkdirSync(path.join(h5, '.ssh')); fs.writeFileSync(target, `${OTHER}\n`); fs.symlinkSync(target, f5);
  const e = sh(cmd, h5);
  assert.deepEqual([e.m, e.code], [{ kind: 'fail', why: 'symlink' }, 3]);
  assert.equal(fs.readFileSync(target, 'utf8'), `${OTHER}\n`, '링크가 가리키는 파일에 쓰지 않았다');
  assert.equal(fs.lstatSync(f5).isSymbolicLink(), true);
  // 끊어진 링크(가리키는 파일이 없다)도 같다 — 링크를 따라가 새 파일을 만들지 않는다
  const h6 = mkHome(); const f6 = path.join(h6, '.ssh', 'authorized_keys'); const gone = path.join(h6, 'not-there');
  fs.mkdirSync(path.join(h6, '.ssh')); fs.symlinkSync(gone, f6);
  assert.deepEqual(sh(cmd, h6).m, { kind: 'fail', why: 'symlink' });
  assert.equal(fs.existsSync(gone), false);
  // 일반 파일이 아니다(폴더)
  const h7 = mkHome(); fs.mkdirSync(path.join(h7, '.ssh', 'authorized_keys'), { recursive: true });
  assert.deepEqual(sh(cmd, h7).m, { kind: 'fail', why: 'notfile' });
});

test('⑨ removeCommand(실제 bash) — 공개키와 표식이 함께 있는 줄만 지운다 · 남의 줄 · 표식 없는 같은 키 줄은 남긴다(수를 알린다) · inode · 권한 유지 · 파일 없음 · 링크는 건드리지 않음', () => {
  const rm = KL.removeCommand({ publicKey: BPUB, keyId: BID });
  const h = mkHome(); const f = path.join(h, '.ssh', 'authorized_keys');
  fs.mkdirSync(path.join(h, '.ssh'), { mode: 0o700 });
  const otherMarked = `${OTHER.split(' ').slice(0, 2).join(' ')} ${BMARK}`;          // 표식은 같지만 다른 공개키
  const sameKeyOtherMark = `${BPUB} portal-ssh:k_ffffffffffff`;                       // 같은 공개키지만 다른 키 id 의 표식
  const keep = ['# 사람이 적은 주석', OTHER, `${BPUB} admin@laptop`, otherMarked, sameKeyOtherMark, `command="/usr/bin/true" ${OTHER.split(' ').slice(0, 2).join(' ')} backup`];
  const gone = [`from="10.0.0.5",${RESTRICT} ${BPUB} ${BMARK}`, `${BPUB} ${BMARK}`];
  fs.writeFileSync(f, `${[keep[0], keep[1], gone[0], keep[2], keep[3], gone[1], keep[4], keep[5]].join('\n')}\n`, { mode: 0o640 }); fs.chmodSync(f, 0o640);
  const ino = fs.statSync(f).ino;
  const a = sh(rm, h);
  assert.deepEqual([a.m, a.code], [{ kind: 'removed', removed: 2, unmarked: 2 }, 0], a.out + a.err);
  assert.equal(fs.readFileSync(f, 'utf8'), `${keep.join('\n')}\n`, '남의 줄 · 표식 없는 같은 키 줄 · 주석은 순서대로 그대로');
  assert.deepEqual([fs.statSync(f).ino, modeOf(f)], [ino, 0o640], '파일은 자리에서 다시 쓴다(inode · 권한 유지)');
  assert.deepEqual(fs.readdirSync(path.join(h, '.ssh')), ['authorized_keys'], '임시 파일을 남기지 않는다');
  // 다시 — 지울 것이 없다(표식 없는 줄 수는 그대로 알린다) · 파일은 그대로
  const b = sh(rm, h);
  assert.deepEqual(b.m, { kind: 'removed', removed: 0, unmarked: 2 });
  assert.equal(fs.readFileSync(f, 'utf8'), `${keep.join('\n')}\n`);
  // 포탈 줄만 있던 파일 — 빈 파일로 남는다(파일을 지우지 않는다)
  const h2 = mkHome(); const f2 = path.join(h2, '.ssh', 'authorized_keys');
  fs.mkdirSync(path.join(h2, '.ssh')); fs.writeFileSync(f2, `${gone[0]}\n`);
  assert.deepEqual(sh(rm, h2).m, { kind: 'removed', removed: 1, unmarked: 0 });
  assert.equal(fs.readFileSync(f2, 'utf8'), '');
  // 파일이 없다 · ~/.ssh 가 없다
  assert.deepEqual(sh(rm, mkHome()).m, { kind: 'none' });
  // 심볼릭 링크 — 가리키는 파일을 고치지 않는다
  const h3 = mkHome(); const f3 = path.join(h3, '.ssh', 'authorized_keys'); const target = path.join(h3, 'elsewhere');
  fs.mkdirSync(path.join(h3, '.ssh')); fs.writeFileSync(target, `${gone[1]}\n`); fs.symlinkSync(target, f3);
  assert.deepEqual(sh(rm, h3).m, { kind: 'none' });
  assert.equal(fs.readFileSync(target, 'utf8'), `${gone[1]}\n`);
  // 넣기 → 거두기 왕복 — 파일이 처음 그대로 돌아온다
  const h4 = mkHome(); const f4 = path.join(h4, '.ssh', 'authorized_keys');
  fs.mkdirSync(path.join(h4, '.ssh')); fs.writeFileSync(f4, `${OTHER}\n${BPUB} admin@laptop\n`);
  const line = KL.buildKeyLine({ publicKey: `${OTHER.split(' ').slice(0, 2).join(' ')}`, keyId: 'k_aaaaaaaaaaaa', restrict: true, fromIp: '127.0.0.1' });
  const pubO = OTHER.split(' ').slice(0, 2).join(' ');
  assert.deepEqual(sh(KL.installCommand({ publicKey: pubO, keyId: 'k_aaaaaaaaaaaa', line }), h4).m, { kind: 'present-unmarked' }, '이미 있는 키(표식 없음)');
  const lineB = KL.buildKeyLine({ publicKey: BPUB, keyId: 'k_bbbbbbbbbbbb' });
  assert.deepEqual(sh(KL.installCommand({ publicKey: BPUB, keyId: 'k_bbbbbbbbbbbb', line: lineB }), h4).m, { kind: 'present-unmarked' });
  const K3 = pubOf(F.ed25519Key().pem); const line3 = KL.buildKeyLine({ publicKey: K3, keyId: 'k_cccccccccccc', restrict: true, fromIp: '127.0.0.1' });
  assert.deepEqual(sh(KL.installCommand({ publicKey: K3, keyId: 'k_cccccccccccc', line: line3 }), h4).m, { kind: 'added' });
  assert.deepEqual(sh(KL.removeCommand({ publicKey: K3, keyId: 'k_cccccccccccc' }), h4).m, { kind: 'removed', removed: 1, unmarked: 0 });
  assert.equal(fs.readFileSync(f4, 'utf8'), `${OTHER}\n${BPUB} admin@laptop\n`);
});

/* ── 4. 키 로그인 설정 — 끝에서 끝까지(가짜 sshd) ─────────────────────── */
test('⑩ 키 로그인 설정 — 저장 비밀번호로 붙어 from= + 포워딩 금지 줄을 더하고 → 그 키로 다시 접속해 확인 → 서버를 그 키에 묶고 저장 비밀번호를 지운다 · 읽은 키 기록 갱신 · 한 번에 작업 하나', async () => {
  const S = await fakeSshd();
  S.st.password = secret('Pw-Happy-Stored-1');
  S.writeAk(`${OTHER}\n`);
  const K = mkKey('kl-happy');
  const sv = mkServer('bm-kl1', S, { password: S.st.password });
  INS.noteInstalled(sv.id, { host: '127.0.0.1', port: S.port, username: 'mon', file: '~/.ssh/authorized_keys', keys: [], by: 'old-reader' }, { now: Date.now() - 3600_000 });
  const t0 = Date.now();
  const { start, job } = await runLogin({ servers: [sv], keyId: K.id, removePassword: true, by: 'own' });
  assert.deepEqual([start.total, start.skipped], [1, []]);
  assert.deepEqual([job.kind, job.by, job.running, job.total, job.done], ['key-login', 'own', false, 1, 1]);
  assert.deepEqual([job.meta.keyId, job.meta.keyName, job.meta.restrict, job.meta.removePassword], [K.id, 'kl-happy', true, true]);
  const r = job.results[0];
  assert.deepEqual([r.ok, r.code, r.line, r.restricted, r.fromIp, r.bound, r.passwordRemoved], [true, 'ok', 'added', true, '127.0.0.1', true, true], JSON.stringify(r));
  // 서버의 파일 — 남의 줄은 그대로, 더한 줄은 출발지 제한 + 포워딩 금지 세 가지 + 표식
  assert.equal(S.readAk(), `${OTHER}\nfrom="127.0.0.1",${RESTRICT} ${K.pub} portal-ssh:${K.id}\n`);
  assert.deepEqual(AK.parseAuthorizedKeys(S.readAk()).keys.map((k) => [k.fingerprint, k.portal, k.hasOptions]), [[AK.parseAuthorizedKeys(OTHER).keys[0].fingerprint, false, false], [K.fingerprint, true, true]]);
  // 접속 — 비밀번호 한 번(저장분) → 끊고 → 키로 한 번
  assert.equal(S.st.conns, 2);
  assert.deepEqual(S.passwordTries().map((x) => [x.conn, x.method, x.username, x.password]), [[1, 'password', 'mon', S.st.password]]);
  assert.deepEqual(S.keyTries().filter((x) => x.signed).map((x) => [x.conn, x.username]), [[2, 'mon']]);
  assert.ok(S.st.execs.filter((x) => x.conn === 1).every((x) => !x.command.includes(S.st.password)), '명령에 비밀번호가 없다');
  // 등록부 — 키에 묶이고 저장 비밀번호가 지워졌다
  const raw = rawOf(sv.id);
  assert.deepEqual([raw.keyRef, raw.password, raw.osAuth], [K.id, '', undefined]);
  assert.equal(REFS.resolveOsAuth(raw, { feature: 'bm-usage' }).authKind, 'key');
  // 읽은 키 기록(서버에 들어 있는 키) — 이번에 읽은 것으로 바뀌었다
  const inst = INS.installedOf(sv.id);
  assert.ok(inst.at >= t0 && inst.by === 'own' && inst.username === 'mon', JSON.stringify(inst));
  assert.deepEqual(inst.keys.map((k) => [k.fingerprint === K.fingerprint, k.portal, k.hasOptions]), [[false, false, false], [true, true, true]]);
  // 사건 · 사용 기록
  const ev = eventsOf('key-login-set').find((e) => e.target.includes('bm-kl1'));
  assert.ok(ev && ev.by === 'own' && ev.corp === 'vcA' && ['키 접속 확인', '출발지 제한', '저장 비밀번호 삭제'].every((x) => ev.detail.includes(x)), JSON.stringify(ev));
  assert.ok(US.keyUsageView({ fingerprint: K.fingerprint }).rows.some((u) => u.feature === 'conn-test' && u.okCount >= 1));
  // 다시 — 이제는 그 키로 붙는다. 포탈 줄이 이미 있어 더하지 않는다. 그동안 다른 키 작업은 받지 않는다(한 번에 하나).
  S.clear();
  const again = SVC.startKeyLogin({ servers: [sv], keyId: K.id, by: 'own' });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.deepEqual((({ code, status }) => [code, status])(SVC.startKeyRevoke({ keyId: K.id, servers: [sv], by: 'own' })), ['busy', 409]);
  assert.equal(SVC.startKeyLogin({ servers: [sv], keyId: K.id, by: 'own' }).code, 'busy');
  const r2 = (await waitJob(again.jobId)).results[0];
  assert.deepEqual([r2.ok, r2.line, r2.restricted, r2.bound, r2.passwordRemoved], [true, 'present-marked', false, true, false], JSON.stringify(r2));
  assert.equal(S.readAk().split('\n').filter((l) => l.includes(K.blob)).length, 1, '줄을 두 번 넣지 않았다');
  assert.equal(S.passwordTries().length, 0);
  // 화면 — 서버 행이 키 고정 · 제한 있음으로 보인다
  const row = (await SVC.buildView()).servers.find((x) => x.id === sv.id);
  assert.deepEqual([row.keyMode, row.keyName, row.hasPassword, row.installed.hasKey, row.installed.keyHasOptions], ['pinned', 'kl-happy', false, true, true]);
});

test('⑪ 비밀번호가 틀리면 — auth-rejected · authorized_keys 는 그대로 · 비밀번호 시도는 딱 한 번(다시 시도하지 않는다) · 키 접속을 시도하지 않는다 · 서버 설정도 그대로', async () => {
  const S = await fakeSshd();
  S.st.password = 'Right-Pw-Never-Sent';
  const before = `${OTHER}\n`;
  S.writeAk(before);
  const K = mkKey('kl-wrongpw');
  const sv = mkServer('bm-kl2', S, { password: secret('Wrong-Pw-Stored-2') });
  const { job } = await runLogin({ servers: [sv], keyId: K.id, removePassword: true, by: 'own' });
  const r = job.results[0];
  assert.deepEqual([r.ok, r.code, r.bound, r.rolledBack], [false, 'auth-rejected', undefined, undefined], JSON.stringify(r));
  assert.match(r.reason, /다시 시도하지 않았습니다/); assert.match(r.reason, /서버에서 바꾼 것은 없습니다/);
  assert.equal(S.readAk(), before);
  assert.equal(S.st.conns, 1, '연결 한 번');
  assert.deepEqual(S.passwordTries().map((x) => [x.method, x.password]), [['password', 'Wrong-Pw-Stored-2']], '비밀번호 시도 한 번');
  assert.equal(S.keyTries().length, 0, '비밀번호가 틀렸으면 키 접속으로 넘어가지 않는다');
  assert.equal(S.st.execs.length, 0);
  const raw = rawOf(sv.id);
  assert.deepEqual([raw.keyRef, raw.password], [undefined, 'Wrong-Pw-Stored-2'], '서버 설정은 그대로(키를 묶지 않고 비밀번호도 지우지 않는다)');
  assert.ok(eventsOf('key-login-set').some((e) => e.target.includes('bm-kl2') && e.detail.includes('실패(auth-rejected)')));
  // 이번 한 번만 쓰는 비밀번호가 틀려도 같다 — 저장분으로 넘어가 다시 시도하지 않는다
  S.clear();
  const once = secret('Once-Wrong-Pw-22');
  const r2 = (await runLogin({ servers: [sv], keyId: K.id, oncePassword: once, by: 'own' })).job.results[0];
  assert.equal(r2.code, 'auth-rejected');
  assert.deepEqual(S.passwordTries().map((x) => x.password), [once], '1회 비밀번호 한 번뿐(저장 비밀번호로 다시 시도하지 않는다)');
  assert.equal(S.readAk(), before);
});

test('⑪-b keyboard-interactive 도 받는 sshd(PAM 을 켠 서버) — 틀린 비밀번호는 서버에 한 번만 간다(한 번의 동작 = 인증 실패 한 번)',
  { todo: 'proxy/sshExec.js connect 의 tryKeyboard 가 password 거부 뒤 같은 비밀번호를 keyboard-interactive 로 한 번 더 보낸다 — 동작 한 번에 인증 실패 2회(계정 잠금)' }, async () => {
    const S = await fakeSshd();
    S.st.password = 'Right-Pw-Never-Sent';
    S.st.offerKbd = true;
    const K = mkKey('kl-kbd');
    const sv = mkServer('bm-kl-kbd', S, { password: secret('Wrong-Pw-Stored-Kbd') });
    const r = (await runLogin({ servers: [sv], keyId: K.id, by: 'own' })).job.results[0];
    assert.equal(r.code, 'auth-rejected');
    assert.equal(S.st.conns, 1);
    assert.match(r.reason, /다시 시도하지 않았습니다\(계정 잠금 방지\)/, '결과 문구는 다시 시도하지 않았다고 말한다');
    assert.equal(S.passwordTries().length, 1, `서버가 받은 비밀번호 인증 시도(= 서버의 실패 횟수) — ${S.passwordTries().map((x) => x.method).join(' → ')}`);
  });

test('⑫ 키 접속 확인이 실패하면(출발지 제한 불일치) — key-login-failed · 더한 줄을 지운다(rolledBack) · 남의 줄은 그대로 · 출발지 제한 안내 · 제한을 빼고 다시 넣지 않는다 · 이미 있던 줄은 지우지 않는다', async () => {
  const S = await fakeSshd();
  S.st.password = secret('Pw-Mismatch-Stored-3');
  const before = `${OTHER}\n${pubOf(F.ed25519Key().pem)} someone@else\n`;
  S.writeAk(before);
  const K = mkKey('kl-mismatch');
  const sv = mkServer('bm-kl3', S, { password: S.st.password });
  // 첫 연결(비밀번호)에서 서버가 본 출발지는 127.0.0.1, 둘째 연결(키)에서는 다른 주소(NAT · 여러 출구) → from= 에 걸린다
  S.st.ipQueue.push('127.0.0.1', '10.77.0.9');
  const r = (await runLogin({ servers: [sv], keyId: K.id, removePassword: true, by: 'own' })).job.results[0];
  assert.deepEqual([r.ok, r.code, r.line, r.rolledBack, r.fromIp], [false, 'key-login-failed', 'added', true, '127.0.0.1'], JSON.stringify(r));
  assert.match(r.reason, /더한 줄을 지웠습니다/);
  assert.match(r.reason, /출발지 제한\(from="127\.0\.0\.1"\)/);
  assert.match(r.reason, /자동으로 빼지 않습니다/);
  assert.equal(S.readAk(), before, '더한 줄만 지워졌다 — 남의 줄은 그대로');
  assert.equal(S.st.conns, 3, '붙어서 더함 → 키로 확인(거부) → 붙어서 지움. 제한 없는 줄로 다시 넣는 네 번째 연결은 없다');
  assert.deepEqual(S.st.seen.filter((x) => x.method !== 'none').map((x) => [x.conn, x.method]), [[1, 'password'], [2, 'publickey'], [3, 'password']]);
  assert.equal(S.st.execs.some((x) => x.command.includes(K.blob) && !x.command.includes('from="127.0.0.1"') && x.command.includes('>> "$f"')), false, '제한 없는 줄을 넣는 명령은 없었다');
  const raw = rawOf(sv.id);
  assert.deepEqual([raw.keyRef, raw.password], [undefined, S.st.password], '키를 묶지 않았고 저장 비밀번호도 지우지 않았다');
  const use = US.keyUsageView({ fingerprint: K.fingerprint }).rows.find((u) => u.server === 'bm-kl3' && u.feature === 'conn-test');
  assert.deepEqual([use.okCount, use.failCount, use.lastOk, use.lastCode], [0, 1, false, 'auth-rejected'], '거부된 키 접속도 사용 기록에 남는다(한 번)');
  // 포탈 줄이 이미 있던 서버 — 키 접속이 안 돼도 그 줄은 우리가 더한 것이 아니므로 지우지 않는다
  const kept = `${before}from="10.1.1.1",${RESTRICT} ${K.pub} portal-ssh:${K.id}\n`;
  S.writeAk(kept); S.clear();
  const r2 = (await runLogin({ servers: [sv], keyId: K.id, by: 'own' })).job.results[0];
  assert.deepEqual([r2.ok, r2.code, r2.line, r2.rolledBack], [false, 'key-login-failed', 'present-marked', null], JSON.stringify(r2));
  assert.match(r2.reason, /이미 있던 것이라 지우지 않았습니다/);
  assert.equal(S.readAk(), kept);
  assert.equal(S.st.conns, 2, '되돌릴 것이 없으면 세 번째 연결도 없다');
});

test('⑫-b 서버가 예상한 답을 주지 않으면 install-failed — 서버에서 바꾼 것 없음 · 키 접속을 시도하지 않는다(출발지 주소를 못 읽음 · 명령을 받지 않는 셸 · 심볼릭 링크) · 되돌리지 못했으면 ‘지웠다’ 고 말하지 않는다', async () => {
  const S = await fakeSshd();
  S.st.password = secret('Pw-Fail-Stored-4');
  const before = `${OTHER}\n`;
  S.writeAk(before);
  const K = mkKey('kl-fail');
  const sv = mkServer('bm-kl-fail', S, { password: S.st.password });
  const run = async () => (await runLogin({ servers: [sv], keyId: K.id, removePassword: true, by: 'own' })).job.results[0];
  // 서버가 본 출발지 주소를 읽지 못한다($SSH_CONNECTION 없음) → 제한 없는 줄로 대신 넣지 않는다
  S.st.noSshConnection = true;
  const a = await run();
  assert.deepEqual([a.ok, a.code], [false, 'install-failed'], JSON.stringify(a));
  assert.match(a.reason, /출발지 제한을 붙일 수 없습니다/); assert.match(a.reason, /서버에서 바꾼 것은 없습니다/);
  assert.deepEqual([S.readAk(), S.st.conns, S.keyTries().length], [before, 1, 0]);
  S.st.noSshConnection = false;
  // 명령을 받지 않는 셸(표지 줄이 오지 않는다)
  S.clear(); S.st.fakeOut = 'This account is restricted.\n';
  const b = await run();
  assert.deepEqual([b.ok, b.code], [false, 'install-failed'], JSON.stringify(b));
  assert.match(b.reason, /서버에서 바꾼 것은 없습니다/);
  assert.deepEqual([S.readAk(), S.st.conns, S.keyTries().length], [before, 1, 0]);
  S.st.fakeOut = null;
  // authorized_keys 가 심볼릭 링크 — 가리키는 파일에 쓰지 않는다
  S.clear();
  const target = path.join(S.home, 'elsewhere');
  fs.writeFileSync(target, before); fs.rmSync(S.akFile); fs.symlinkSync(target, S.akFile);
  const c = await run();
  assert.deepEqual([c.ok, c.code], [false, 'install-failed'], JSON.stringify(c));
  assert.match(c.reason, /심볼릭 링크라 건드리지 않았습니다/);
  assert.deepEqual([fs.readFileSync(target, 'utf8'), fs.lstatSync(S.akFile).isSymbolicLink(), S.keyTries().length], [before, true, 0]);
  fs.rmSync(S.akFile); S.writeAk(before);
  assert.deepEqual([rawOf(sv.id).keyRef, rawOf(sv.id).password], [undefined, S.st.password], '세 경우 모두 서버 설정은 그대로');
  // 줄을 더한 뒤 키 접속이 안 됐는데, 되돌리러 다시 붙지도 못했다(그 사이 비밀번호가 바뀜) → 지웠다고 말하지 않고 줄이 남았다고 알린다
  S.clear();
  S.st.ipQueue.push('127.0.0.1', '10.77.0.9');
  const stored = S.st.password;
  S.st.onConn = (n) => { if (n === 3) S.st.password = 'Changed-Meanwhile'; };
  const d = await run();
  assert.deepEqual([d.ok, d.code, d.line, d.rolledBack], [false, 'key-login-failed', 'added', false], JSON.stringify(d));
  assert.match(d.reason, /더한 줄을 지우지 못했습니다/);
  assert.doesNotMatch(d.reason, /더한 줄을 지웠습니다/);
  assert.ok(d.reason.includes(`portal-ssh:${K.id}`), '직접 지울 줄의 표식을 알려 준다');
  assert.equal(S.readAk(), `${before}from="127.0.0.1",${RESTRICT} ${K.pub} portal-ssh:${K.id}\n`, '줄은 실제로 남아 있다');
  assert.deepEqual(S.passwordTries().map((x) => [x.conn, x.password]), [[1, stored], [3, stored]], '되돌리기도 한 번만 시도한다');
  assert.deepEqual([rawOf(sv.id).keyRef, rawOf(sv.id).password], [undefined, stored]);
});

test('⑫-c 명령을 받지 않는 셸 — 표지 줄이 아예 오지 않았으면 ‘예상한 답을 주지 않았다’ 고 말한다(‘출발지 주소를 못 읽었으니 서버 쪽 제한을 끄라’ 고 하지 않는다 — 꺼도 같은 서버에서 다시 실패한다)',
  { todo: 'keyLogin.js installOne 이 출발지 문의의 답에 표지가 없는 것(unknown)을 주소가 빈 것과 같은 noip 로 묶어, 도움이 되지 않는 ‘보호 장치 끄기’ 를 안내한다' }, async () => {
    const S = await fakeSshd();
    S.st.password = secret('Pw-Rsh-Stored-4c');
    S.st.fakeOut = 'This account is restricted.\n';
    const K = mkKey('kl-rsh');
    const sv = mkServer('bm-kl-rsh', S, { password: S.st.password });
    const on = (await runLogin({ servers: [sv], keyId: K.id, by: 'own' })).job.results[0];
    assert.ok(ST.setGuards({ serverRestrict: false }, { by: 'fixture' }).ok);
    let off;
    try { off = (await runLogin({ servers: [sv], keyId: K.id, by: 'own' })).job.results[0]; }
    finally { assert.ok(ST.setGuards({ serverRestrict: true }, { by: 'fixture' }).ok); }
    assert.deepEqual([on.code, off.code, S.readAk()], ['install-failed', 'install-failed', null], '보호 장치를 켜든 끄든 이 서버에서는 같은 까닭으로 실패한다');
    assert.match(off.reason, /예상한 답을 주지 않았습니다/);
    assert.match(on.reason, /예상한 답을 주지 않았습니다/);
    assert.doesNotMatch(on.reason, /‘서버 쪽 제한’ 을 끄고/);
  });

test('⑬ 교체(replaceKeyId) — 새 키 접속이 확인된 뒤에만 옛 키의 포탈 줄 · 저장 비밀번호를 지운다 · 표식 없는 옛 키 줄은 남긴다 · 새 키 확인에 실패하면 옛 줄 · 옛 설정 · 저장 비밀번호 그대로', async () => {
  const S = await fakeSshd();
  const kOld = mkKey('kl-rep-old'); const kNew = mkKey('kl-rep-new');
  const oldLine = `from="127.0.0.1",${RESTRICT} ${kOld.pub} portal-ssh:${kOld.id}`;
  const before = `${OTHER}\n${kOld.pub} admin@laptop\n${oldLine}\n`;
  S.writeAk(before);
  const stored = secret('Pw-Rep-Stored-4');   // 옛 키에 묶여 있으면서 저장 비밀번호도 남아 있는 서버
  const sv = mkServer('bm-kl4', S, { keyRef: kOld.id, bindApproved: true, password: stored });
  assert.deepEqual([rawOf(sv.id).keyRef, rawOf(sv.id).password], [kOld.id, stored]);
  assert.equal(SVC.startKeyLogin({ servers: [sv], keyId: kNew.id, replaceKeyId: kNew.id, by: 'own' }).code, 'same-key');
  assert.equal(SVC.startKeyLogin({ servers: [sv], keyId: kNew.id, replaceKeyId: 'k_000000000000', by: 'own' }).code, 'key-missing');
  // 새 키 접속 확인 실패(둘째 연결의 출발지가 다르다) → 새 줄만 되돌리고 옛 줄은 그대로
  S.st.ipQueue.push('127.0.0.1', '10.77.0.9');
  const f = (await runLogin({ servers: [sv], keyId: kNew.id, replaceKeyId: kOld.id, removePassword: true, by: 'own' })).job.results[0];
  assert.deepEqual([f.ok, f.code, f.rolledBack, f.oldRemoved, f.passwordRemoved], [false, 'key-login-failed', true, undefined, undefined], JSON.stringify(f));
  assert.equal(S.readAk(), before, '옛 키 줄을 먼저 지우지 않았다');
  assert.deepEqual([rawOf(sv.id).keyRef, rawOf(sv.id).password], [kOld.id, stored], '새 키가 확인되지 않았으면 저장 비밀번호를 지우지 않는다');
  assert.equal(S.passwordTries().length, 0, '옛 키로 붙는다(저장 비밀번호를 보내지 않는다)');
  assert.equal(REFS.resolveOsAuth(rawOf(sv.id), { feature: 'conn-test' }).keyFingerprint, kOld.fingerprint);
  // 성공 — 새 키로 확인된 뒤 옛 포탈 줄 삭제(표식 없는 옛 키 줄은 남기고 수를 알린다)
  S.clear();
  const { job } = await runLogin({ servers: [sv], keyId: kNew.id, replaceKeyId: kOld.id, removePassword: true, by: 'own' });
  const r = job.results[0];
  assert.deepEqual([r.ok, r.line, r.bound, r.oldRemoved, r.oldUnmarked, r.passwordRemoved], [true, 'added', true, 1, 1, true], JSON.stringify(r));
  assert.equal(job.meta.replaceKeyName, 'kl-rep-old');
  assert.equal(S.readAk(), `${OTHER}\n${kOld.pub} admin@laptop\nfrom="127.0.0.1",${RESTRICT} ${kNew.pub} portal-ssh:${kNew.id}\n`);
  assert.deepEqual([rawOf(sv.id).keyRef, rawOf(sv.id).password], [kNew.id, '']);
  // 순서 — 옛 줄을 지우는 명령은 새 키로 연 연결에서만 나갔다
  const rmConn = S.st.execs.filter((x) => x.command.includes(kOld.blob)).map((x) => x.conn);
  const newKeyConns = new Set(S.keyTries().filter((x) => x.signed && x.conn >= 2).map((x) => x.conn));
  assert.ok(rmConn.length >= 1 && rmConn.every((c) => c >= 2 && newKeyConns.has(c)), JSON.stringify({ rmConn, seen: S.st.seen }));
});

test('⑭ 붙기 전에 거절 — 화면이 본 접속처와 다르면 moved(빼고 진행) · 엣지가 수집하는 서버는 하지 않는다 · 승인 대기 · 퇴역 · 바꿔치기 표지 키 · 폴더 밖 키 · 사용 중지 법인은 연결 0회', async () => {
  const S = await fakeSshd();
  S.st.password = secret('Pw-Refuse-Stored-5');
  const K = mkKey('kl-refuse');
  const sv = mkServer('bm-kl5', S, { password: S.st.password });
  const svMoved = mkServer('bm-kl5-moved', S, { username: 'mon2', password: S.st.password });
  const svEdge = mkServer('bm-kl5-edge', S, { username: 'mon3', password: S.st.password, agent: 'edge-kr' });
  // 화면이 본 접속처가 등록부와 다르다(그 사이 주소 · 포트 · 계정이 바뀜) → 그 서버는 빼고, 남은 서버가 없으면 시작하지 않는다
  const stale = { id: svMoved.id, addr: svMoved.addr.replace('|mon2', '|root') };
  const none = SVC.startKeyLogin({ servers: [stale, { id: 'nope', addr: 'x' }, { id: sv.id }], keyId: K.id, by: 'own' });
  assert.deepEqual([none.ok, none.code, none.skipped.map((x) => x.code)], [false, 'empty', ['moved', 'not-found', 'moved']], JSON.stringify(none));
  assert.equal(SVC.startKeyLogin({ servers: [], keyId: K.id, by: 'own' }).code, 'empty');
  assert.equal(SVC.startKeyLogin({ servers: [sv], keyId: 'k_000000000000', by: 'own' }).code, 'key-missing');
  // 키 상태 — 작업을 만들기 전에 거절
  const kPend = mkKey('kl-refuse-pending', { pending: true });
  const kRet = mkKey('kl-refuse-retired'); assert.ok(KS.markKeyRetired(kRet.id).ok);
  const kTam = mkKey('kl-refuse-tampered'); KS.markKeyIntegrity(kTam.id, false);
  assert.deepEqual((({ code, status }) => [code, status])(SVC.startKeyLogin({ servers: [sv], keyId: kPend.id, by: 'own' })), ['key-pending', 409]);
  assert.equal(SVC.startKeyLogin({ servers: [sv], keyId: kRet.id, by: 'own' }).code, 'key-retired');
  assert.equal(SVC.startKeyLogin({ servers: [sv], keyId: kTam.id, by: 'own' }).code, 'key-tampered');
  KS.markKeyIntegrity(kTam.id, true);
  assert.ok(KS._removeKey(kPend.id).ok);
  // 서버마다 — 엣지 위임 · 폴더 밖 키 · 사용 중지: 작업은 돌지만 그 서버에는 붙지 않는다
  const kB = mkKey('kl-refuse-vcb', { folderCorp: 'vcB' });
  const { start, job } = await runLogin({ servers: [stale, svEdge], keyId: K.id, by: 'own' });
  assert.deepEqual([start.total, start.skipped.map((x) => [x.name, x.code]), job.meta.skipped.length], [1, [['bm-kl5-moved', 'moved']], 1]);
  assert.deepEqual(job.results.map((x) => [x.name, x.ok, x.code]), [['bm-kl5-edge', false, 'edge-delegated']]);
  const rB = (await runLogin({ servers: [sv], keyId: kB.id, by: 'own' })).job.results[0];
  assert.deepEqual([rB.ok, rB.code], [false, 'key-folder']);
  assert.equal(SVC.stopCorp('vcA', { by: 'own', reason: '시험' }).ok, true);
  const rS = (await runLogin({ servers: [sv], keyId: K.id, by: 'own' })).job.results[0];
  assert.deepEqual([rS.ok, rS.code], [false, 'corp-stopped'], '사용 중지 중인 법인의 키는 서버에 넣지 않는다(비밀번호로 붙기 전에 끝낸다)');
  assert.ok(ST.clearCorpStop('vcA', { by: 'fixture' }).ok);
  // 저장된 인증 수단이 없는 서버 — 1회 비밀번호를 넣으라고 한다(빈 비밀번호로 시도하지 않는다)
  const svNone = mkServer('bm-kl5-none', S, { username: 'mon4' });
  const rN = (await runLogin({ servers: [svNone], keyId: K.id, by: 'own' })).job.results[0];
  assert.deepEqual([rN.ok, rN.code], [false, 'no-secret']);
  assert.deepEqual([S.st.conns, S.st.seen.length, S.readAk()], [0, 0, null], '이 모든 거절에서 서버에는 한 번도 붙지 않았다');
  for (const id of [sv.id, svMoved.id, svEdge.id, svNone.id]) assert.equal(rawOf(id).keyRef, undefined);
});

test('⑮ 서버 쪽 제한(보호 장치)이 꺼져 있으면 — 넣는 줄에 옵션이 없다 · 출발지 주소를 묻지 않는다 · 1회 비밀번호로 붙고 저장하지 않는다', async () => {
  const S = await fakeSshd();
  const once = secret('Once-NoRestrict-Pw-6');
  S.st.password = once;
  const K = mkKey('kl-norestrict');
  const sv = mkServer('bm-kl6', S);   // 저장된 인증 수단 없음
  assert.equal(ST.setGuards({ serverRestrict: false }, { by: 'fixture' }).ok, true);
  try {
    assert.equal(G.serverRestrictOn(), false);
    const { job } = await runLogin({ servers: [sv], keyId: K.id, oncePassword: once, removePassword: true, by: 'own' });
    const r = job.results[0];
    assert.deepEqual([r.ok, r.line, r.restricted, r.fromIp, r.bound, r.passwordRemoved], [true, 'added', false, '', true, null], JSON.stringify(r));
    assert.equal(job.meta.restrict, false, '서버 쪽 제한은 보호 장치 설정을 따른다(요청이 고르지 않는다)');
    assert.equal(S.readAk(), `${K.pub} portal-ssh:${K.id}\n`, '옵션 없는 줄');
    assert.equal(S.st.execs.some((x) => x.command === KL.WHOAMI_COMMAND), false);
    assert.deepEqual(S.passwordTries().map((x) => x.password), [once]);
    assert.equal(leaksKey(JSON.stringify(job), ALL_PEMS) || JSON.stringify(job).includes(once), false, '작업 기록에 비밀 없음');
    const row = (await SVC.buildView()).servers.find((x) => x.id === sv.id);
    assert.deepEqual([row.installed.hasKey, row.installed.keyHasOptions], [true, false]);
    const items = (await SVC.buildView()).check.items;
    assert.ok(items.some((i) => i.code === 'restrict-missing' && i.files.includes('bm-kl6')), '제한 없는 키 줄은 키 점검이 경고');
    assert.ok(items.some((i) => i.code === 'restrict-off' && i.level === 'warn'), '보호 장치가 꺼져 있다는 것도 경고');
  } finally { assert.equal(ST.setGuards({ serverRestrict: true }, { by: 'fixture' }).ok, true); }
  const raw = rawOf(sv.id);
  assert.deepEqual([raw.keyRef, raw.password || ''], [K.id, ''], '1회 비밀번호는 등록부에 저장되지 않았다');
});

test('⑮-b 법인 기본 키(공통 계정)를 따르는 서버 — 키 로그인 설정이 그 서버를 이름 고정으로 바꾸지 않는다 · 공통 계정의 계정명으로 붙는다 · 지울 서버 비밀번호가 없으면 ‘없음’', async () => {
  const S = await fakeSshd();
  const once = secret('Once-CorpDefault-Pw-6b');
  S.st.password = once;
  const K = mkKey('kl-corp-default');
  const acc = KS.saveAccount({ name: 'kl-acc', kind: 'os', corp: 'vcA', username: 'svc', keyRef: K.id }, { by: 'fixture' });
  assert.ok(acc.ok, JSON.stringify(acc));
  const sv = mkServer('bm-kl-acc', S, { credRef: acc.account.id, bindApproved: true });
  assert.deepEqual([rawOf(sv.id).credRef, rawOf(sv.id).keyRef], [acc.account.id, undefined]);
  const r = (await runLogin({ servers: [sv], keyId: K.id, oncePassword: once, removePassword: true, by: 'own' })).job.results[0];
  assert.deepEqual([r.ok, r.line, r.bound, r.passwordRemoved], [true, 'added', true, null], JSON.stringify(r));
  assert.deepEqual([rawOf(sv.id).keyRef, rawOf(sv.id).credRef], [undefined, acc.account.id], '서버에 키를 고정하지 않았다(법인 기본 키를 바꾸면 따라간다)');
  assert.deepEqual([...new Set(S.st.seen.map((x) => x.username))], ['svc'], '비밀번호 · 키 접속 모두 공통 계정의 계정명으로');
  assert.equal(S.readAk(), `from="127.0.0.1",${RESTRICT} ${K.pub} portal-ssh:${K.id}\n`);
  const row = (await SVC.buildView()).servers.find((x) => x.id === sv.id);
  assert.deepEqual([row.keyMode, row.keyName, row.accountName], ['corp-default', 'kl-corp-default', 'kl-acc']);
});

test('⑮-c 서버 쪽 제한 ‘다시 넣기’ — 제한 없이 들어가 있는 포탈 줄은 보호 장치를 켠 뒤 키 로그인 설정을 다시 하면 제한이 붙는다(키 점검 restrict-missing 의 안내 · 시안 SshSec ‘다시 넣기’)',
  { todo: 'keyLogin.js installCommand 가 포탈 줄이 이미 있으면(present-marked) 아무것도 하지 않는다 — 키 점검이 안내하는 ‘다시 넣으면 제한이 붙습니다’ 가 실제로는 일어나지 않는다' }, async () => {
    const S = await fakeSshd();
    S.st.password = secret('Pw-Reinsert-Stored-6c');
    const K = mkKey('kl-reinsert');
    const sv = mkServer('bm-kl-re', S, { password: S.st.password });
    assert.ok(ST.setGuards({ serverRestrict: false }, { by: 'fixture' }).ok);
    let r1;
    try { r1 = (await runLogin({ servers: [sv], keyId: K.id, by: 'own' })).job.results[0]; }
    finally { assert.ok(ST.setGuards({ serverRestrict: true }, { by: 'fixture' }).ok); }
    assert.deepEqual([r1.ok, r1.restricted], [true, false], JSON.stringify(r1));
    assert.equal(S.readAk(), `${K.pub} portal-ssh:${K.id}\n`);
    const item = (await SVC.buildView()).check.items.find((i) => i.code === 'restrict-missing');
    assert.ok(item && item.files.includes('bm-kl-re') && /다시 넣으면 제한이 붙습니다/.test(item.detail), '키 점검이 그렇게 안내한다');
    const r2 = (await runLogin({ servers: [sv], keyId: K.id, by: 'own' })).job.results[0];
    assert.equal(r2.ok, true, JSON.stringify(r2));
    assert.equal(S.readAk(), `from="127.0.0.1",${RESTRICT} ${K.pub} portal-ssh:${K.id}\n`, '다시 넣은 뒤 그 줄에 출발지 제한 · 포워딩 금지가 붙어 있다');
  });

/* ── 5. 키 거두기 ─────────────────────────────────────────────────────── */
test('⑯ 키 거두기 — 포탈 줄만 지운다(removed) · 표식 없는 같은 키 줄 수를 알린다 · 없으면 not-present · 파일이 없으면 none · 인증 실패는 한 번 · 사건 기록', async () => {
  const S = await fakeSshd();
  S.st.password = secret('Pw-Revoke-Stored-7');
  const K = mkKey('rv-key');
  const keep = `${OTHER}\n${K.pub} admin@laptop\n`;
  S.writeAk(`${OTHER}\nfrom="127.0.0.1",${RESTRICT} ${K.pub} portal-ssh:${K.id}\n${K.pub} admin@laptop\n${K.pub} portal-ssh:${K.id}\n`);
  const ino = fs.statSync(S.akFile).ino;
  const sv = mkServer('bm-rv1', S, { password: S.st.password });
  const { job } = await runRevoke({ keyId: K.id, servers: [sv], by: 'own' });
  assert.deepEqual([job.kind, job.meta.keyName, job.total], ['key-revoke', 'rv-key', 1]);
  const r = job.results[0];
  assert.deepEqual([r.ok, r.code, r.removed, r.unmarked, r.pinned], [true, 'removed', 2, 1, false], JSON.stringify(r));
  assert.equal(S.readAk(), keep);
  assert.equal(fs.statSync(S.akFile).ino, ino);
  assert.deepEqual(S.passwordTries().length, 1);
  const ev = eventsOf('key-lines-removed').find((e) => e.target.includes('bm-rv1'));
  assert.ok(ev && ev.by === 'own' && ev.detail === '2줄', JSON.stringify(ev));
  // 다시 — 지울 포탈 줄이 없다
  const r2 = (await runRevoke({ keyId: K.id, servers: [sv], by: 'own' })).job.results[0];
  assert.deepEqual([r2.ok, r2.code, r2.removed, r2.unmarked], [true, 'not-present', 0, 1]);
  assert.equal(S.readAk(), keep);
  assert.equal(eventsOf('key-lines-removed').filter((e) => e.target.includes('bm-rv1')).length, 1, '지운 것이 없으면 사건을 남기지 않는다');
  // authorized_keys 가 없는 계정
  fs.rmSync(S.akFile);
  const r3 = (await runRevoke({ keyId: K.id, servers: [sv], by: 'own' })).job.results[0];
  assert.deepEqual([r3.ok, r3.code, r3.removed], [true, 'none', 0]);
  // 비밀번호가 틀리면 한 번만 · 파일 그대로
  S.writeAk(`${K.pub} portal-ssh:${K.id}\n`); S.st.password = 'Changed-On-Server'; S.clear();
  const r4 = (await runRevoke({ keyId: K.id, servers: [sv], by: 'own' })).job.results[0];
  assert.deepEqual([r4.ok, r4.code], [false, 'auth-rejected']);
  assert.equal(S.passwordTries().length, 1);
  assert.equal(S.readAk(), `${K.pub} portal-ssh:${K.id}\n`);
  // 입력 판정
  assert.equal(SVC.startKeyRevoke({ keyId: 'k_000000000000', servers: [sv], by: 'own' }).code, 'key-missing');
  assert.equal(SVC.startKeyRevoke({ keyId: K.id, by: 'own' }).code, 'bad-corp');
  assert.equal(SVC.startKeyRevoke({ keyId: K.id, servers: [{ id: sv.id, addr: 'x' }], by: 'own' }).skipped[0].code, 'moved');
});

test('⑰ 키 거두기(법인 단위) — 중앙이 수집하는 서버만 돈다 · 엣지 위임 서버는 사유와 함께 빠진다 · 법인 키 사용 중지 중에는 1회 비밀번호를 안내하고, 넣으면 거둔다', async () => {
  const S1 = await fakeSshd(); const S2 = await fakeSshd(); const S3 = await fakeSshd();
  S1.st.password = secret('Pw-Corp-Stored-8a'); S2.st.password = secret('Pw-Corp-Stored-8b');
  const K = mkKey('rv-corp', { folderCorp: 'vcR' });
  const line = `from="127.0.0.1",${RESTRICT} ${K.pub} portal-ssh:${K.id}`;
  S1.writeAk(`${OTHER}\n${line}\n`);
  S3.writeAk(`${line}\n${OTHER}\n`);
  const a = mkServer('bm-r1', S1, { vcenterId: 'vcR', password: S1.st.password });
  const b = mkServer('bm-r2', S2, { vcenterId: 'vcR', password: S2.st.password });        // authorized_keys 없음
  mkServer('bm-r3-edge', null, { host: '10.9.3.3', vcenterId: 'vcR', password: 'x', agent: 'edge-us' });
  const c = mkServer('bm-r4', S3, { vcenterId: 'vcR', keyRef: K.id, bindApproved: true }); // 그 키로만 붙는 서버
  const { start, job } = await runRevoke({ keyId: K.id, corp: 'vcR', by: 'own' });
  assert.deepEqual([start.total, start.skipped.map((x) => [x.name, x.code])], [3, [['bm-r3-edge', 'edge-delegated']]]);
  assert.deepEqual(job.meta.corp, 'vcR');
  const by = Object.fromEntries(job.results.map((x) => [x.name, x]));
  assert.deepEqual(Object.keys(by).sort(), ['bm-r1', 'bm-r2', 'bm-r4'], '엣지 위임 서버는 시도하지 않는다');
  assert.deepEqual([by['bm-r1'].code, by['bm-r1'].removed, by['bm-r2'].code, by['bm-r4'].code, by['bm-r4'].removed, by['bm-r4'].pinned], ['removed', 1, 'none', 'removed', 1, true], JSON.stringify(job.results));
  assert.equal(S1.readAk(), `${OTHER}\n`); assert.equal(S3.readAk(), `${OTHER}\n`);
  // 엣지 위임 서버뿐인 법인 → 시작하지 않고 사유를 준다
  mkServer('bm-e-only', null, { host: '10.9.4.1', vcenterId: 'vcE', password: 'x', agent: 'edge-e' });
  const eo = SVC.startKeyRevoke({ keyId: K.id, corp: 'vcE', by: 'own' });
  assert.deepEqual([eo.ok, eo.code, eo.skipped.map((x) => x.code)], [false, 'empty', ['edge-delegated']]);
  void a; void b;
  // 법인 키 사용 중지 중 — 그 키로만 붙는 서버는 키로 접속하지 않는다(안내) · 1회 비밀번호를 넣으면 거둔다
  S3.writeAk(`${line}\n${OTHER}\n`); S3.clear();
  assert.equal(SVC.stopCorp('vcR', { by: 'own', reason: '유출 의심' }).ok, true);
  const st1 = (await runRevoke({ keyId: K.id, servers: [c], by: 'own' })).job.results[0];
  assert.deepEqual([st1.ok, st1.code], [false, 'corp-stopped'], JSON.stringify(st1));
  assert.match(st1.reason, /이번 한 번만 쓸 비밀번호/);
  assert.deepEqual([S3.st.conns, S3.readAk()], [0, `${line}\n${OTHER}\n`], '사용 중지 중에는 키로 붙지 않았다');
  const once = secret('Once-Revoke-Pw-8');
  S3.st.password = once;
  const st2 = (await runRevoke({ keyId: K.id, servers: [c], oncePassword: once, by: 'own' })).job.results[0];
  assert.deepEqual([st2.ok, st2.code, st2.removed, st2.pinned], [true, 'removed', 1, true], JSON.stringify(st2));
  assert.equal(S3.readAk(), `${OTHER}\n`);
  assert.deepEqual([S3.passwordTries().map((x) => x.password), S3.keyTries().length], [[once], 0], '1회 비밀번호로만 붙었다(중지된 키를 쓰지 않았다)');
  assert.deepEqual([rawOf(c.id).keyRef, rawOf(c.id).password || ''], [K.id, ''], '1회 비밀번호는 저장되지 않았다');
  assert.ok(ST.clearCorpStop('vcR', { by: 'fixture' }).ok);
});

/* ── 8. 알림 메일 ─────────────────────────────────────────────────────── */
test('⑱ 알림 메일 — 알릴 사건(MAIL_EVENTS)만 고른다 · 사건의 글만 싣는다(다른 칸은 본문에 없다) · HTML 이스케이프 · 몰아서 생긴 사건은 한 통', async () => {
  const { KINDS } = await import('../src/mail/kinds.js');
  assert.ok(KINDS.some((k) => k.id === N.MAIL_KIND && N.MAIL_KIND === 'ssh-key'), '메일 종류 등재');
  assert.equal(N.buildMail([]), null);
  assert.equal(N.buildMail(null), null);
  assert.equal(N.buildMail([{ kind: 'key-login-set', target: 'bm-a1 · k' }, { kind: 'inbox-approved', target: 'k' }, { kind: 'nope' }, null]), null, '알리지 않는 사건뿐이면 보내지 않는다');
  const one = N.buildMail([{ kind: 'key-login-set', target: 'x' }, { kind: 'corp-stop', corp: 'vcA', by: 'own', detail: '유출 의심 · 서버 3대' }]);
  assert.deepEqual([one.count, Object.keys(one).sort()], [1, ['count', 'html', 'subject', 'text']]);
  assert.match(one.subject, /^\[SSH 키 보안\] 법인 키 사용 중지 · vcA · own — 유출 의심/);
  // 사건 객체에 다른 칸이 딸려 와도 본문에는 종류 · 법인 · 대상 · 누가 · 설명뿐이다
  const noisy = N.buildMail([
    { kind: 'approval-requested', corp: 'vcA', target: '키 등록 — <b>kr</b> & "co"', by: 'own', detail: '',
      privateKey: 'PEM-SHOULD-NOT-APPEAR', password: 'PW-SHOULD-NOT-APPEAR', oncePassword: 'ONCE-SHOULD-NOT-APPEAR', payload: { keyId: 'k_payloadnotshown' }, at: 123456789 },
    { kind: 'inbox-new', target: '2개 — vcA/common/id_a', detail: 'vcA/common/id_a|sha-not-shown\nvcA/common/id_b|sha-not-shown' },
    { kind: 'key-lines-removed', corp: 'vcA', target: 'bm-a1 · kr', by: 'own2', detail: '2줄' },
  ]);
  const all = JSON.stringify(noisy);
  for (const x of ['SHOULD-NOT-APPEAR', 'k_payloadnotshown', '123456789', 'sha-not-shown']) assert.equal(all.includes(x), false, x);
  assert.equal(noisy.count, 3);
  assert.match(noisy.subject, /사건 3건 — 승인 요청 외/);
  assert.deepEqual(noisy.text.split('\n').slice(0, 3), ['승인 요청 · vcA · 키 등록 — <b>kr</b> & "co" · own', '받는 곳에 새 키 파일 · 2개 — vcA/common/id_a', '서버에서 키 거둠 · vcA · bm-a1 · kr · own2 — 2줄']);
  assert.ok(noisy.html.includes('&lt;b&gt;kr&lt;/b&gt; &amp; &quot;co&quot;') && !noisy.html.includes('<b>'), 'HTML 본문은 이스케이프');
  assert.equal(N.buildMail(Array.from({ length: 100 }, (_, i) => ({ kind: 'corp-resume', corp: `c${i}` }))).count, 60, '한 통의 줄 수 상한');
  // 몰아서 생긴 사건 → 한 통(가짜 발송은 파일 처음에 붙여 뒀다)
  await N._flushKeyNotifyForTest();
  const n0 = MAILS.length;
  assert.ok(ST.addEvents([{ kind: 'corp-stop', corp: 'vcZ', by: 'own', detail: '시험' }, { kind: 'key-login-set', target: '안 보낼 사건' }, { kind: 'corp-resume', corp: 'vcZ', by: 'own2' }]).ok);
  assert.ok(ST.addEvent({ kind: 'key-added-outside', target: 'intruder', detail: 'SHA256:xxxx' }).ok);
  assert.equal(MAILS.length, n0, '바로 보내지 않는다(모은다)');
  await N._flushKeyNotifyForTest();
  assert.equal(MAILS.length, n0 + 1, '한 통');
  const m = MAILS[n0];
  assert.deepEqual([m.kind, Object.keys(m).sort()], ['ssh-key', ['html', 'kind', 'subject', 'text']]);
  assert.match(m.subject, /사건 3건/);
  assert.equal(m.text.includes('안 보낼 사건'), false);
  assert.deepEqual([N.lastKeyNotify().ok, N.lastKeyNotify().count], [true, 3]);
  await N._flushKeyNotifyForTest();
  assert.equal(MAILS.length, n0 + 1, '보낼 것이 없으면 보내지 않는다');
});

/* ── 7. 소스 스윕 ─────────────────────────────────────────────────────── */
test('⑲ 소스 스윕 — 등록부 쓰기(키 묶기 · 되돌리기 · 저장 비밀번호 삭제)는 service.js 만 부른다(keyLogin.js 는 넘겨받은 함수만) · 새 쓰기 라우트는 ownerWrite · 감사에 1회 비밀번호를 싣지 않는다', async () => {
  const { stripComments } = await import('./_stripComments.js');
  const files = execFileSync('git', ['ls-files', '*.js'], { cwd: SRC, encoding: 'utf8' }).split('\n').filter(Boolean);
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '*.js'], { cwd: SRC, encoding: 'utf8' }).split('\n').filter(Boolean);
  const all = [...new Set([...files, ...untracked])].filter((f) => fs.existsSync(path.join(SRC, f)));
  // 이름이 글자로도 없는 파일은 주석을 벗기지 않는다(전 소스를 이름마다 다시 벗기면 수 초가 든다)
  const has = (name) => all.filter((f) => { const raw = fs.readFileSync(path.join(SRC, f), 'utf8'); return raw.includes(name) && new RegExp(`\\b${name}\\b`).test(stripComments(raw)); }).sort();
  for (const name of ['setBmServerKeyRef', 'restoreBmServerKeyRef', 'clearBmServerPassword']) {
    assert.deepEqual(has(name), ['bmstor/registry.js', 'sshaccess/service.js'], name);
  }
  const kl = stripComments(fs.readFileSync(path.join(SRC, 'sshaccess/keyLogin.js'), 'utf8'));
  assert.doesNotMatch(kl, /setBmServerKeyRef|restoreBmServerKeyRef|clearBmServerPassword|bmstor\/registry|saveBmServer|applyBmServerBatch/, 'keyLogin.js 는 등록부를 직접 쓰지 않는다');
  assert.match(kl, /\bo\.bind\(/); assert.match(kl, /\bo\.clearPassword\(/);
  assert.doesNotMatch(kl, /console\.[a-z]+\([^\n]*(?:assword|privateKey|passphrase)/, '비밀을 콘솔에 찍지 않는다');
  // 라우트 — 새 쓰기 라우트는 전부 관리자 → 설정 소유자 등급 → OTP(마지막)
  const rt = stripComments(fs.readFileSync(path.join(SRC, 'routes/api/sshAccess.js'), 'utf8'));
  const gates = new Map([...rt.matchAll(/api\.(get|post|put|delete)\('([^']+)', \.\.\.(\w+)/g)].map((m) => [`${m[1]} ${m[2]}`, m[3]]));
  for (const r of ['post /settings/ssh-access/keys/rotate', 'delete /settings/ssh-access/keys/:id', 'post /settings/ssh-access/approvals/:id/approve', 'post /settings/ssh-access/approvals/:id/reject',
    'put /settings/ssh-access/guards', 'post /settings/ssh-access/key-login', 'post /settings/ssh-access/key-revoke', 'delete /settings/ssh-access/corps/:corp/stop', 'post /settings/ssh-access/reload-keystore']) {
    assert.equal(gates.get(r), 'ownerWrite', r);
  }
  assert.equal(gates.get('get /settings/ssh-access/jobs/:id'), 'ownerRead');
  assert.match(rt, /const ownerWrite = \[adminOnly, requireSettingsOwner, reauth\];/);
  assert.equal([...rt.matchAll(/api\.(get|post|put|delete)\(/g)].length, gates.size, '게이트 묶음 없이 등록된 라우트가 없다');
  assert.doesNotMatch(rt, /resolveOsAuth|keyMaterial|listKeysRaw|listBmServersRaw|KS\.|keyStore|approval\/store|approval\/twoPerson|keyLogin/, '라우트는 저장소 · 승인 저장소 · 키 로그인 본체를 직접 만지지 않는다(service 를 거친다)');
  for (const line of rt.split('\n').filter((l) => /audit\(/.test(l))) assert.doesNotMatch(line, /oncePassword: (?!!!once\b)|: once\b|privateKey|passphrase/, line.trim().slice(0, 80));
  // 7b 화면 — 키 등록 · 교체 · 삭제 게이트에 두 사람 승인 검사가 OTP 앞에 있다
  const ob = stripComments(fs.readFileSync(path.join(SRC, 'routes/api/bmOnboard.js'), 'utf8'));
  assert.match(ob, /const keyAddGate = \[adminOnly, toolsPerm, requireSettingsOwner, twoPersonFirst, keyVaultFirst, reauth\];/);
  assert.match(ob, /const keyChangeGate = \[adminOnly, toolsPerm, requireSettingsOwner, twoPersonFirst, reauth\];/);
  assert.match(ob, /api\.post\('\/tools\/bm-usage\/ssh-keys\/rotate', \.\.\.keyChangeGate/);
  assert.match(ob, /api\.delete\('\/tools\/bm-usage\/ssh-keys\/:id', \.\.\.keyChangeGate/);
  // 알림 메일 — 본문이 사건에서 읽는 칸은 종류 · 법인 · 대상 · 누가 · 설명뿐이다(다른 칸을 본문에 싣는 코드가 생기면 여기서 걸린다)
  const nt = stripComments(fs.readFileSync(path.join(SRC, 'sshaccess/notify.js'), 'utf8'));
  const read = new Set([...nt.matchAll(/\be\??\.([A-Za-z_]\w*)/g)].map((m) => m[1]));
  assert.deepEqual([...read].filter((f) => !['kind', 'corp', 'target', 'by', 'detail', 'message'].includes(f)), []);
  assert.doesNotMatch(nt, /JSON\.stringify\(\s*(?:e|rows|events|batch)\b/, '사건 객체를 통째로 본문에 싣지 않는다');
  // 승인 저장소는 실행을 모른다(무엇을 실행하는지 — 종류를 등록받는 twoPerson 만 안다)
  const ap = stripComments(fs.readFileSync(path.join(SRC, 'approval/store.js'), 'utf8'));
  assert.doesNotMatch(ap, /sshaccess|keyStore|bmstor|twoPerson/);
  assert.deepEqual([...SVC.SSH_KINDS].sort(), ['ssh-corp-resume', 'ssh-guard-change', 'ssh-key-activate', 'ssh-key-delete', 'ssh-key-rotate', 'ssh-keystore-reload']);
  for (const k of SVC.SSH_KINDS) assert.notEqual(TP.kindLabel(k), k, `${k} 실행 절차 등록`);
});

/* ── 6. 비밀 노출 ─────────────────────────────────────────────────────── */
test('⑳ 비밀 — 1회 비밀번호 · 저장 비밀번호 · 개인키가 설정 폴더의 어느 파일에도 · 작업 기록 · 승인 기록 · 감사 · 사건 · 메일 · HTTP 응답에도 평문으로 없다', async () => {
  // 실제 라우트로 키 로그인 설정 · 키 거두기(1회 비밀번호 포함) — 응답 · 작업 조회 · 감사에 비밀이 없다
  const S = await fakeSshd();
  const once = secret('Once-Http-Pw-9');
  S.st.password = once;
  const K = mkKey('sec-http');
  const sv = mkServer('bm-sec1', S);
  assert.equal((await call('adm', 'POST', '/settings/ssh-access/key-login', { servers: [sv], keyId: K.id, oncePassword: once })).s, 403);
  assert.equal(S.st.conns, 0);
  const http = [];
  const kl = await call('own4', 'POST', '/settings/ssh-access/key-login', { servers: [sv], keyId: K.id, oncePassword: once, removePassword: true, otp: await otp('own4') });
  assert.equal(kl.s, 202, kl.txt);
  assert.match(kl.j.jobId, /^kj_[0-9a-f]{12}$/);
  http.push(kl.txt);
  await waitJob(kl.j.jobId);
  const jv = await call('own4', 'GET', `/settings/ssh-access/jobs/${kl.j.jobId}`);
  assert.deepEqual([jv.s, jv.j.job.results[0].ok, jv.j.job.results[0].line], [200, true, 'added'], jv.txt);
  assert.equal((await call('adm', 'GET', `/settings/ssh-access/jobs/${kl.j.jobId}`)).s, 403);
  assert.equal((await call('own4', 'GET', '/settings/ssh-access/jobs/kj_000000000000')).s, 404);
  http.push(jv.txt);
  const once2 = secret('Once-Http-Pw-9b');
  S.st.password = once2;
  const rv = await call('own4', 'POST', '/settings/ssh-access/key-revoke', { keyId: K.id, servers: [sv], oncePassword: once2, otp: await otp('own4') });
  assert.equal(rv.s, 202, rv.txt);
  http.push(rv.txt);
  await waitJob(rv.j.jobId);
  const jv2 = await call('own4', 'GET', `/settings/ssh-access/jobs/${rv.j.jobId}`);
  assert.deepEqual([jv2.j.job.kind, jv2.j.job.results[0].code, jv2.j.job.results[0].removed], ['key-revoke', 'removed', 1], jv2.txt);
  http.push(jv2.txt);
  assert.deepEqual(S.passwordTries().map((x) => x.password), [once, once2], '1회 비밀번호로 붙었다');
  http.push((await call('own', 'GET', '/settings/ssh-access')).txt);
  const chg = await call('own', 'GET', '/settings/ssh-access/changes');
  for (const action of ['ssh-access.key-login.start', 'ssh-access.key-revoke.start']) assert.ok(chg.j.items.some((e) => e.action === action && /"oncePassword":true/.test(e.detail)), `${action} — 썼다는 사실만`);
  http.push(chg.txt);
  http.push((await call('own', 'GET', '/settings/ssh-access/usage')).txt);

  const bad = (text) => SECRET_WORDS.find((w) => String(text).includes(w)) || (leaksKey(text, ALL_PEMS) ? '개인키 원문' : /PRIVATE KEY/.test(String(text)) ? 'PRIVATE KEY' : null);
  assert.ok(SECRET_WORDS.length >= 8 && ALL_PEMS.length >= 20, '스윕할 비밀이 실제로 있다');
  for (const t of http) assert.equal(bad(t), null, 'HTTP 응답');
  assert.equal(http.some((t) => /enc\$1\$/.test(t)), false, '응답에 봉인본도 없다');
  // 설정 폴더의 모든 파일(키 저장소 · 등록부 · 상태 · 승인 · 읽은 키 · 사용 기록 · 감사 · 호스트키 기록 …)
  US.flushKeyUsage();
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.isFile() ? [path.join(d, e.name)] : []));
  const filesAll = walk(DIR);
  for (const name of ['ssh-keys.json', 'bm-storage.json', 'audit.ndjson', ST.STATE_FILE_NAME, AP.APPROVALS_FILE_NAME, INS.INSTALLED_FILE_NAME, US.USAGE_FILE_NAME]) assert.ok(filesAll.some((f) => path.basename(f) === name), `${name} 이 스윕 대상에 있다`);
  for (const f of filesAll) assert.equal(bad(fs.readFileSync(f, 'utf8')), null, path.relative(DIR, f));
  assert.equal(KS.plainStoredKeyIds().length, 0, '키 저장소에 평문 개인키가 없다');
  // 승인 기록 — 본문에 비밀 칸이 없다
  const apRaw = fs.readFileSync(approvalsFile, 'utf8');
  assert.equal(/enc\$1\$|privateKey|passphrase|password/i.test(apRaw), false);
  // 사건 · 메일(이 파일이 만든 사건이 실린 메일 전부)
  assert.equal(bad(JSON.stringify(ST.listEvents({ limit: 300 }))), null);
  await N._flushKeyNotifyForTest();
  assert.ok(MAILS.length >= 2);
  assert.equal(bad(JSON.stringify(MAILS)), null, '메일 본문');
  // 서버로 나간 명령 — 비밀번호 · 개인키는 명령에 실리지 않는다(공개키 · 표식 · 출발지 주소만)
  assert.equal(bad(JSON.stringify(S.st.execs)), null);
});
