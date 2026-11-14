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
 * `{ todo }` 로 둔 테스트는 **소스가 아직 지키지 못하는 동작**이다 — 단언은 기대 동작 그대로 두고(약하게 고치지 말 것) 소스를 고쳐 통과하면 todo 를 뗀다(지금은 없다).
 *
 * 5축 점검(6ce017ad) · 반증 1차(71d9f6f9 · 19ce2ac1) 반영: 원격 스크립트는 akScript.js(서버 쪽 자물쇠 → 임시 파일 → 검증 → mv → 다시 읽어 확인 · awk 판정 ·
 * base64 로 싼 /bin/sh 한 줄)라 inode 가 바뀌고 파일 권한은 0600 이 된다(일부러 — 하드 링크로 이어진 남의 파일을 바꾸지 않는다).
 * 예전 결함 동작을 고정하던 단언은 뒤집고 줄마다 `// 점검 B-F2b` · `반증 R4` 처럼 근거를 적었다.
 * 스크립트를 직접 돌리는 시험(⑦~⑨-f)은 bash · dash 둘 다로 돈다(/bin/sh 가 bash 인 RHEL · dash 인 Debian 계열). 가짜 sshd 는 받은 한 줄을 bash 로 돌리고, 그 줄이 /bin/sh 를 부른다.
 * 새 회귀(①-b · ②-b · ③-b · ③-c · ⑥-d~⑥-h · ⑨-b~⑨-f · ⑪-c · ⑪-d · ⑫-d~⑫-h · ⑭-b · ⑯-b · ⑰-b~⑰-f · ⑱-b · ⑱-c)는 각 제목에 점검 · 반증 번호를 적었다.
 * ⑳(비밀 스윕)은 이 파일이 만든 것 전부를 보므로 **마지막**에 둔다.
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
process.env.SETTINGS_OWNERS = 'own,own2,own3,own4,own5,own6,own7,own8,own9,sown,lim';
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
// own5 ~ own9 = 점검 A10(사전 검사가 OTP 를 쓰지 않는다) · 작업 칸 사전 검사 · 거두기 멈추기 OTP 를 볼 때 쓰는 여분(OTP 를 쓰지 않았음을 그 코드로 다시 확인하므로 코드가 든다).
// lim = 설정 소유자이고 조회 범위는 무제한이지만 쓰기 범위(writeVcenters)가 좁은 관리자(1회차 A3 — SSH 공용 접속 쓰기 · 승인을 못 한다).
const SECRETS = { own: generateSecret(), own2: generateSecret(), own3: generateSecret(), own4: generateSecret(), own5: generateSecret(), own6: generateSecret(), own7: generateSecret(), own8: generateSecret(), own9: generateSecret(), adm2: generateSecret(), lim: generateSecret() };
fs.writeFileSync(path.join(DIR, 'users.json'), JSON.stringify({ users: [
  { username: 'own', role: 'admin', totpEnabled: true, totpSecret: SECRETS.own },
  { username: 'own2', role: 'admin', totpEnabled: true, totpSecret: SECRETS.own2 },
  { username: 'own3', role: 'admin', totpEnabled: true, totpSecret: SECRETS.own3 },
  { username: 'own4', role: 'admin', totpEnabled: true, totpSecret: SECRETS.own4 },
  { username: 'own5', role: 'admin', totpEnabled: true, totpSecret: SECRETS.own5 },
  { username: 'own6', role: 'admin', totpEnabled: true, totpSecret: SECRETS.own6 },
  { username: 'own7', role: 'admin', totpEnabled: true, totpSecret: SECRETS.own7 },
  { username: 'own8', role: 'admin', totpEnabled: true, totpSecret: SECRETS.own8 },
  { username: 'own9', role: 'admin', totpEnabled: true, totpSecret: SECRETS.own9 },
  { username: 'lim', role: 'admin', totpEnabled: true, totpSecret: SECRETS.lim, scope: { writeVcenters: ['vcA'] } },
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
const AKS = await import('../src/sshaccess/akScript.js');   // 원격 스크립트(순수) — keyLogin 은 이것을 /bin/sh 한 줄로 싼다
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
/** 가짜 sshd 에서 붙잡아 둔 명령(holdExec) — 테스트가 중간에 실패해도 놓는다(붙잡힌 접속이 작업 · 파일 전체를 멈추지 않게). */
const HELD = [];
/**
 * 테스트마다 끝에 — 붙잡은 명령을 놓고, 아직 도는 키 작업이 있으면 멈추고 끝나기를 기다린다(한 테스트가 중간에 실패해도 다음 테스트가 ‘busy’ 로 줄줄이 실패하지 않게).
 * 정상 테스트는 작업을 끝까지 기다리므로 여기서 멈출 것이 없다.
 */
test.afterEach(async () => {
  for (const r of HELD.splice(0)) r();
  const lj = KL.lastJobs();
  const ids = [lj.install, ...(lj.revokes || [])].filter((j) => j && j.running).map((j) => j.id);
  for (const id of ids) KL.cancelJob(id, { by: 'test-cleanup', why: '앞 테스트 정리' });
  for (const id of ids) for (let i = 0; i < 1500 && SVC.keyJob(id)?.running; i += 1) await sleep(20);
});

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
const USERS = Object.fromEntries(['own', 'own2', 'own3', 'own4', 'own5', 'own6', 'own7', 'own8', 'own9', 'adm', 'adm2'].map((u) => [u, { username: u, role: 'admin', scope: null }]));
USERS.sown = { username: 'sown', role: 'admin', scope: { vcenters: ['vcA'] } };
USERS.lim = { username: 'lim', role: 'admin', scope: { writeVcenters: ['vcA'] } };
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
 *  · st.gate(명령) — 있으면 명령을 돌리기 전에 그 Promise 를 기다린다(느린 서버 — 작업이 도는 동안 다른 일을 시험한다).
 *  · st.rejectExec(명령, 연결 번호) — 참이면 그 exec 요청을 거절한다(바꾸는 명령을 보낸 뒤 답을 받지 못한 접속 — 점검 B-F3).
 *  · st.dropExec(명령, 연결 번호) — 참이면 명령을 끝까지 돌린 뒤 **종료 코드 · 출력 없이** 연결을 끊는다(서버는 바꿨는데 답이 끊긴 경우).
 *  · st.fakeOut 은 함수여도 된다(명령, 연결 번호 → 글 또는 null) · st.banner(명령) — 명령 출력 앞에 붙일 글(로그인 셸 · .bashrc 가 찍는 잡음 흉내).
 *  · st.noPassword — password 방식을 내놓지 않는다(대화형 keyboard-interactive 만 받는 서버 — offerKbd 와 함께).
 *  · 인증 시도(연결 번호 · 방식 · 계정 · 보낸 비밀번호)를 전부 적는다 — ‘다시 시도하지 않았다’ 를 테스트가 센다.
 */
const HOSTKEY = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
const KEY_IN_LINE = /(?:^|[ \t])(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521))[ \t]+([A-Za-z0-9+/]+={0,3})/;
async function fakeSshd() {
  const home = fs.mkdtempSync(path.join(TMP, 'sshkl-home-'));
  TMP_DIRS.push(home);
  const akFile = path.join(home, '.ssh', 'authorized_keys');
  const st = { password: null, clientIp: '127.0.0.1', ipQueue: [], offerKbd: false, kbdPrompts: null, forceCmd: null, noSshConnection: false, fakeOut: null, onConn: null, gate: null, rejectExec: null, dropExec: null, path: null, banner: null, noPassword: false, seen: [], execs: [], conns: 0 };
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
      const pk = Array.isArray(k) ? k[0] : k;
      // 강제 명령(command="…") — 진짜 sshd 처럼 그 키로 들어온 세션의 모든 exec 를 그 명령으로 바꾼다(2회차 B6 시험)
      const forced = /(?:^|,)command="((?:[^"\\]|\\.)*)"/.exec(line.slice(0, m.index));
      return { pk, forced: forced ? forced[1].replace(/\\"/g, '"') : null };
    }
    return null;
  };
  const srv = new ssh2.Server({ hostKeys: [HOSTKEY] }, (client) => {
    st.conns += 1;
    const conn = st.conns;
    const ip = st.ipQueue.length ? st.ipQueue.shift() : st.clientIp;
    try { st.onConn?.(conn); } catch { /* */ }
    const left = () => ['publickey', ...(st.noPassword ? [] : ['password']), ...(st.offerKbd ? ['keyboard-interactive'] : [])];
    let forcedCmd = null;
    client.on('authentication', (ctx) => {
      const rec = { conn, ip, method: ctx.method, username: ctx.username };
      st.seen.push(rec);
      if (ctx.method === 'publickey') {
        rec.signed = !!ctx.signature;
        const hit = keyAllowed(ctx.key.data, ip);
        if (!hit) return ctx.reject(left());
        if (!ctx.signature) return ctx.accept();
        if (!hit.pk.verify(ctx.blob, ctx.signature, ctx.hashAlgo)) return ctx.reject(left());
        forcedCmd = hit.forced;
        return ctx.accept();
      }
      if (ctx.method === 'password') {
        rec.password = ctx.password;
        if (st.noPassword) return ctx.reject(left());
        return st.password && ctx.password === st.password ? ctx.accept() : ctx.reject(left());
      }
      if (ctx.method === 'keyboard-interactive' && st.offerKbd) {
        // st.kbdPrompts — 대화형 질의의 칸(기본: 가리는 Password 칸 하나). OTP 칸만 묻는 서버 흉내(2회차 B5).
        return ctx.prompt(st.kbdPrompts || [{ prompt: 'Password: ', echo: false }], (answers) => {
          rec.password = (answers || []).find((x) => x) ?? answers?.[0];
          rec.answers = answers;
          return st.password && (answers || []).includes(st.password) ? ctx.accept() : ctx.reject(left());
        });
      }
      return ctx.reject(left());
    });
    client.on('ready', () => client.on('session', (accept) => {
      const s = accept();
      s.on('exec', async (acc, rej, info) => {
        st.execs.push({ conn, command: info.command, ...(forcedCmd ? { forced: forcedCmd } : {}) });
        if (st.rejectExec?.(info.command, conn)) { rej(); return; }
        const stream = acc();
        const fo = typeof st.fakeOut === 'function' ? st.fakeOut(info.command, conn) : st.fakeOut;
        if (typeof fo === 'string') { stream.write(fo); stream.exit(1); stream.end(); return; }
        const bn = typeof st.banner === 'function' ? st.banner(info.command, conn) : null;
        if (typeof bn === 'string') stream.write(bn);
        if (st.gate) await st.gate(info.command, conn);
        const env = { HOME: home, PATH: st.path || process.env.PATH, ...(st.noSshConnection ? {} : { SSH_CONNECTION: `${ip} 50000 127.0.0.1 22` }) };
        const drop = !!st.dropExec?.(info.command, conn);
        // st.forceCmd(conn) — 그 연결의 exec 를 강제 명령으로(그 키 줄에 command= 가 붙은 서버 흉내 — 우리가 더한 줄이 아니라 다른 경로로 강제되는 경우 · 3회차 E3-5)
        const forced2 = typeof st.forceCmd === 'function' ? st.forceCmd(conn) : null;
        const p = spawn('bash', ['-c', forcedCmd || forced2 || info.command], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        if (!drop) { p.stdout.on('data', (d) => stream.write(d)); p.stderr.on('data', (d) => stream.stderr.write(d)); }
        else { p.stdout.resume(); p.stderr.resume(); }
        p.on('error', () => { stream.exit(127); stream.end(); });
        p.on('close', (code) => { if (drop) { client.end(); return; } stream.exit(code ?? 1); stream.end(); });
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
    clear() { st.seen.length = 0; st.execs.length = 0; st.conns = 0; st.ipQueue.length = 0; st.onConn = null; st.gate = null; st.forceCmd = null; st.rejectExec = null; st.dropExec = null; st.path = null; st.banner = null; },
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
// startKeyLogin · startKeyRevoke 는 v3.10.0 점검 뒤 async 다(데모 모드 판정 import) — 반드시 await.
async function runLogin(args) { const r = await SVC.startKeyLogin(args); assert.ok(r.ok, JSON.stringify(r)); return { start: r, job: await waitJob(r.jobId) }; }
async function runRevoke(args) { const r = await SVC.startKeyRevoke(args); assert.ok(r.ok, JSON.stringify(r)); return { start: r, job: await waitJob(r.jobId) }; }
/** 임시 HOME 에서 명령을 실제 셸로 돌린다(ssh 없이 — 순수 빌더 시험). 기본은 bash(가짜 sshd 와 같다 — 싼 한 줄이 /bin/sh 를 부른다). */
function mkHome() { const h = fs.mkdtempSync(path.join(TMP, 'sshkl-h-')); TMP_DIRS.push(h); return h; }
function sh(cmd, home, shell = 'bash', { PATH = process.env.PATH } = {}) {
  const r = spawnSync(shell, ['-c', cmd], { env: { HOME: home, PATH, SSH_CONNECTION: '127.0.0.1 50000 127.0.0.1 22' }, encoding: 'utf8' });
  return { out: r.stdout, err: r.stderr, code: r.status, m: KL.parseMarker(r.stdout) };
}
/**
 * 쓸 수 없는 ~/.ssh(하드닝 — AuthorizedKeysFile 을 root 가 관리 · 비 root 로그인)를 흉내 낸 HOME. content null = authorized_keys 없음.
 *  · root 로 도는 테스트: ~/.ssh 는 root 소유 0755, 스크립트는 setpriv 로 uid 65534 가 돌린다(root 에게 [ -w ] 는 늘 참이다).
 *  · 비 root: ~/.ssh 를 0555 로(끝나면 CLOSERS 가 되돌린다 — 지울 수 있게).
 */
const RUN_AS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;
/** 원격 스크립트의 자물쇠 주인 표 호스트 칸과 같은 식(uname -n / boot_id / pid 이름공간 — 2회차 B2). 이름만 쓰면 스크립트는 ‘다른 호스트’ 로 본다. */
const HOSTID = (() => { let boot = ''; let ns = ''; try { boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { /* */ } try { ns = fs.readlinkSync('/proc/self/ns/pid'); } catch { /* */ } return `${os.hostname()}/${boot}/${ns}`; })();
function roHome(content, { lockTok = '', sshMode = null } = {}) {
  const h = fs.mkdtempSync(path.join(TMP, 'sshkl-ro-')); TMP_DIRS.push(h);
  const d = path.join(h, '.ssh'); fs.mkdirSync(d);
  if (content != null) { fs.writeFileSync(path.join(d, 'authorized_keys'), content); fs.chmodSync(path.join(d, 'authorized_keys'), 0o644); }
  if (lockTok) { fs.mkdirSync(path.join(d, '.authorized_keys.portal.lock')); fs.writeFileSync(path.join(d, '.authorized_keys.portal.lock', 'owner'), `${lockTok}\n`); }   // 옛 자물쇠가 남은 읽기 전용 ~/.ssh(2회차 반증 R2R-4)
  if (RUN_AS_ROOT) { fs.chmodSync(h, 0o755); fs.chownSync(h, 65534, 65534); fs.chmodSync(d, sshMode ?? 0o755); return { h, how: 'root → setpriv uid 65534' }; }
  fs.chmodSync(d, sshMode ?? 0o555); CLOSERS.push(() => fs.chmodSync(d, 0o700));
  return { h, how: '비 root · ~/.ssh 0555' };
}
function shRo(cmd, ro, shell, { PATH = process.env.PATH } = {}) {
  if (!RUN_AS_ROOT) return sh(cmd, ro.h, shell, { PATH });
  const r = spawnSync('setpriv', ['--reuid=65534', '--regid=65534', '--clear-groups', shell, '-c', cmd], { env: { HOME: ro.h, PATH, SSH_CONNECTION: '127.0.0.1 50000 127.0.0.1 22' }, encoding: 'utf8' });
  assert.equal(r.error, undefined, `setpriv 를 돌리지 못했다: ${r.error}`);
  return { out: r.stdout, err: r.stderr, code: r.status, m: KL.parseMarker(r.stdout) };
}
/** 스크립트를 직접 돌릴 셸 — /bin/sh 가 bash 인 서버(RHEL)와 dash 인 서버(Debian · Ubuntu) 둘 다. dash 가 없는 환경이면 bash 만(그 사실을 테스트 이름이 아니라 여기서 밝힌다). */
const SHELLS = ['bash', 'dash'].filter((x) => spawnSync(x, ['-c', 'exit 0']).status === 0);
assert.ok(SHELLS.includes('bash'));
/** 표지 모양(설치 계열) — parseMarker 가 돌려주는 칸 그대로. */
const M = (kind, unmarked = 0, custom = 0, exact = 0, loose = 0, otherId = 0) => ({ kind, unmarked, custom, exact, loose, otherId });   // otherId = 같은 공개키를 다른 키 id 로 포탈이 넣은 줄 수(3회차 B3-4)
/** 가짜 sshd 가 받은 한 줄(`echo '<b64>' | base64 -d | /bin/sh`) → 안의 스크립트 글. 싼 꼴이 아니면 그대로. */
const WRAP_RE = /^echo '([A-Za-z0-9+/=]+)' \| base64 -d \| \/bin\/sh$/;
const scriptOf = (command) => { const m = WRAP_RE.exec(String(command)); return m ? Buffer.from(m[1], 'base64').toString('utf8') : String(command); };
/** 스크립트에 끼운 넣을 줄(L='…') — 없으면 ''. */
const lineInScript = (script) => (/^B='[^']*'; M='[^']*'; L='([^']*)'/m.exec(script) || /^L='([^']*)'/m.exec(script) || [])[1] || '';
/** 실제 awk 를 감싼 가짜 awk 가 든 bin 폴더(점검 B-F1 — busybox awk 흉내). mode: 'trunc' = 출력이 일반 파일이면 앞 2줄만 쓰고 0 · 'exit2' = 앞 2줄만 쓰고 2. */
const REAL = Object.fromEntries(['awk', 'mv', 'sleep', 'chmod', 'mkdir', 'date', 'ls', 'ln', 'rmdir'].map((c) => [c, execFileSync('sh', ['-c', `command -v ${c}`], { encoding: 'utf8' }).trim()]));
/**
 * mode — 'trunc' · 'exit2'(가짜 awk) · 'mvfail'(mv 실패) · 'nosleep'(sleep 이 바로 끝남 — 자물쇠 15초를 기다리지 않게) ·
 * 'race'(mv 한 뒤 다른 쪽이 authorized_keys 를 $HOME/race-content 로 바꾼다 — 자물쇠를 모르는 사람 · 도구) · 'mvhang'(mv 가 멈춘다 — 신호 시험) ·
 * 'chmodhook'(임시 파일 chmod — 검증 뒤 · mv 직전 — 에 $HOME/hook.sh 를 돌린다: 그 틈에 다른 쪽이 파일 · 자물쇠를 건드리는 흉내) ·
 * 'lockhooks'(자물쇠 시험용 — 모두 $HOME 의 파일이 있을 때만 움직이고 없으면 진짜 명령과 같다):
 *   sleep = 바로 끝나며 부른 횟수를 $HOME/sleeps 에 세고 $HOME/sleep-hook.sh 를 돌린다($c = 몇 번째) · date = $HOME/clock 이 있으면 부를 때마다 1초씩 가는 가짜 시계 ·
 *   mkdir = 자물쇠 경로를 $HOME/mkdir-fail 의 수만큼 만들지 않고 실패(경합 직후 놓인 흉내) · $HOME/owner-full 이 있으면 자물쇠를 만든 뒤 주인 표를 /dev/full 로 잇는다(디스크 가득 흉내) ·
 *   ls = $HOME/ls-hook.sh 를 한 번 돌린다(COMMIT 의 444 검사 — 자물쇠 · c0 뒤, 분류 뒤의 틈) ·
 *   (2회차 축 B) date = 부를 때마다 $HOME/date-calls 를 세고 $HOME/date-hook.sh 를 돌린다($dc = 몇 번째) · $HOME/clock-late 가 있으면 1 · 2번째는 1000000, 그 뒤는 +100초 ·
 *     $HOME/clock-half 가 있으면 (그 값 + 부른 횟수/2) — 자물쇠 기다림 한 바퀴(late · now 두 번)에 1초 ·
 *   mkdir = $HOME/owner-vanish 의 수만큼 자물쇠를 만든 직후 지운다(주인 표 쓰기 실패 + 폴더 사라짐) · $HOME/ssh-race 가 있으면 ~/.ssh 를 남이 먼저 만든 흉내(만들고 실패) ·
 *   mv = 남은 자물쇠를 옆으로 옮긴 횟수를 $HOME/stale-mv 에 세고 $HOME/mv-hook.sh 를 돌린다.
 */
function fakeBin(mode) {
  const d = fs.mkdtempSync(path.join(TMP, 'sshkl-bin-')); TMP_DIRS.push(d);
  const put = (name, body) => fs.writeFileSync(path.join(d, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  if (mode === 'mvfail') put('mv', 'echo "mv: cannot move" >&2\nexit 1');
  else if (mode === 'nosleep') put('sleep', 'exit 0');
  else if (mode === 'race') put('mv', `${REAL.mv} "$@" || exit $?\ncat "$HOME/race-content" > "$HOME/.ssh/authorized_keys"`);
  else if (mode === 'mvhang') put('mv', `: > "$HOME/mv-started"\nexec ${REAL.sleep} 30`);
  else if (mode === 'chmodhook') put('chmod', `${REAL.chmod} "$@" || exit $?\n[ -f "$HOME/hook.sh" ] && . "$HOME/hook.sh"\nexit 0`);
  else if (mode === 'lockhooks') {
    put('sleep', 'c=$(cat "$HOME/sleeps" 2>/dev/null || echo 0); c=$((c + 1)); echo "$c" > "$HOME/sleeps"\n[ -f "$HOME/sleep-hook.sh" ] && . "$HOME/sleep-hook.sh"\nexit 0');
    put('date', `dc=$(cat "$HOME/date-calls" 2>/dev/null || echo 0); dc=$((dc + 1)); echo "$dc" > "$HOME/date-calls"\n[ -f "$HOME/date-hook.sh" ] && . "$HOME/date-hook.sh" >/dev/null 2>&1\nif [ -f "$HOME/clock-late" ]; then if [ "$dc" -le 2 ]; then echo 1000000; else echo 1000100; fi; exit 0; fi\nif [ -f "$HOME/clock-half" ]; then echo $(( $(cat "$HOME/clock-half") + dc / 2 )); exit 0; fi\nif [ -f "$HOME/clock" ]; then n=$(cat "$HOME/clock"); n=$((n + 1)); echo "$n" > "$HOME/clock"; echo "$n"; exit 0; fi\nexec ${REAL.date} "$@"`);
    put('mkdir', `case "$1" in *.authorized_keys.portal.lock)\n  n=$(cat "$HOME/mkdir-fail" 2>/dev/null || echo 0); if [ "$n" -gt 0 ]; then echo $((n - 1)) > "$HOME/mkdir-fail"; exit 1; fi\n  ${REAL.mkdir} "$1" || exit $?\n  [ -f "$HOME/owner-full" ] && ln -s /dev/full "$1/owner"\n  v=$(cat "$HOME/owner-vanish" 2>/dev/null || echo 0); if [ "$v" -gt 0 ]; then echo $((v - 1)) > "$HOME/owner-vanish"; rmdir "$1"; fi\n  exit 0 ;;\n*/.ssh) if [ -f "$HOME/ssh-race" ]; then rm -f "$HOME/ssh-race"; ${REAL.mkdir} "$1"; exit 1; fi ;;\nesac\nexec ${REAL.mkdir} "$@"`);
    put('mv', `${REAL.mv} "$@" || exit $?\ncase "$2" in *.stale.*) mc=$(cat "$HOME/stale-mv" 2>/dev/null || echo 0); echo $((mc + 1)) > "$HOME/stale-mv"; [ -f "$HOME/mv-hook.sh" ] && . "$HOME/mv-hook.sh" >/dev/null 2>&1 ;; esac\nexit 0`);
    put('ls', `if [ -f "$HOME/ls-hook.sh" ]; then . "$HOME/ls-hook.sh" >/dev/null 2>&1; rm -f "$HOME/ls-hook.sh"; fi\nexec ${REAL.ls} "$@"`);
  }
  else put('awk', `if [ -f /proc/self/fd/1 ]; then ${REAL.awk} "$@" | head -n 2; exit ${mode === 'exit2' ? 2 : 0}; fi\nexec ${REAL.awk} "$@"`);
  return `${d}:${process.env.PATH}`;
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

  // 요청한 사람은 승인할 수 없다 — 이름 비교는 대소문자 · 앞뒤 공백 무시 · AD 도메인 접두(CORP\own) · 접미(own@corp) 무시(점검 A2 — AD 로그인은 세 꼴을 다 받는다)
  for (const who of ['Own', 'own', 'OWN', ' own ', 'CORP\\own', 'corp.local\\OWN', 'own@corp.local', 'Own@CORP']) {
    const d = AP.decide(q.id, { by: who, approve: true, digest: q.digest }, { now: NOW + 2000 });
    assert.deepEqual([d.ok, d.code, d.status], [false, 'self-approve', 403], who);
  }
  assert.deepEqual(['CORP\\alice', 'alice@corp.local', ' Alice ', 'a\\b\\Alice', 'alice'].map(AP.identityKey), ['alice', 'alice', 'alice', 'alice', 'alice']);
  assert.notEqual(AP.identityKey('own2'), AP.identityKey('own'), '다른 사람은 다른 신원');
  assert.equal(AP.identityKey('@own'), '@own', '맨 앞 @ 는 접미 구분이 아니다(빈 이름이 되지 않게)');
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
  assert.deepEqual(stuck.map((r) => [r.id, r.status, r.result.code, r.interrupted]), [[s1.id, 'failed', 'interrupted', true]], '만료와 다르게 ‘실행 여부 모름’ 표지(점검 C-8)');
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

test('①-b 승인 뒤 실행 결과를 적지 못하면 — 응답이 recordFailed 로 밝힌다 · 10분 뒤 ‘중단(실행 여부 모름)’ 으로 확정되고 뒷정리는 만료가 아니라 interrupted 사유로 불린다(점검 C-8)', async () => {
  const calls = [];
  let breakFile = false;
  // 실행 함수가 도는 사이 approvals.json 자리에 폴더가 생긴다(디스크 · 권한 사고 흉내 — 실행은 됐는데 결과 기록만 실패)
  TP.registerKind('test-c8', { label: '시험 C-8', run: () => { if (breakFile) { fs.rmSync(approvalsFile, { force: true }); fs.mkdirSync(approvalsFile); } return { ok: true }; },
    discard: (p, why) => calls.push([p.x, why]) });
  const q = await TP.submit({ kind: 'test-c8', title: 't', target: 'c8-1', payload: { x: 1 }, by: 'own' });
  assert.deepEqual([q.ok, q.pending], [true, true], JSON.stringify(q));
  breakFile = true;
  const a = await TP.approve(q.request.id, { by: 'own2', digest: q.request.digest });
  breakFile = false;
  assert.deepEqual([a.ok, a.recordFailed, a.request.status], [true, true, 'approved'], JSON.stringify(a));
  assert.match(a.recordReason, /승인 기록을 쓰지 못했습니다/);
  assert.deepEqual(calls, [], '실행이 성공했으면 뒷정리하지 않는다');
  fs.rmdirSync(approvalsFile);   // 사람이 사고를 고쳤다(메모리 기록은 ‘승인됨’ 그대로)
  // 10분 전에는 그대로 — 지나면 interrupted 로 확정되고 뒷정리는 ‘interrupted’ 사유(만료와 다른 문구 · 대기 키를 지울지 판단하는 쪽이 가른다)
  assert.deepEqual(TP.expireSweep({ now: Date.now() + 60_000 }), []);
  const swept = TP.expireSweep({ now: Date.now() + AP.INTERRUPTED_MS + 60_000 });
  assert.deepEqual(swept.map((r) => [r.id, r.status, r.result.code, r.interrupted]), [[q.request.id, 'failed', 'interrupted', true]]);
  assert.match(swept[0].result.reason, /실행됐는지 확인/);
  assert.deepEqual(calls, [[1, 'interrupted']]);
  // 시한 만료는 여전히 ‘expired’ 사유로
  const e = await TP.submit({ kind: 'test-c8', title: 't', target: 'c8-2', payload: { x: 2 }, by: 'own' });
  const ex = TP.expireSweep({ now: Date.now() + AP.REQUEST_TTL_MS + 60_000 });
  assert.deepEqual([ex.map((r) => [r.id, r.status, r.interrupted]), calls.at(-1)], [[[e.request.id, 'expired', undefined]], [2, 'expired']]);
  fs.rmSync(approvalsFile, { force: true });
  AP._resetApprovalsForTest();
});

test('②-b 끝난 기록은 끝난 시각 순으로 자른다(오래 기다린 요청을 지금 결정해도 그 기록이 남는다 — 점검 C-9) · 화면은 대기 요청 전부 + 끝난 요청 60개(합쳐서 자르면 대기 요청이 끝난 요청에 밀려 안 보였다 — 점검 E-1)', async () => {
  const now = Date.now();
  const H = AP.MAX_HISTORY;
  const mk = (i, status, requestedAt, decidedAt = 0) => ({ id: `ap_${i.toString(16).padStart(12, '0')}`, kind: 'ssh-key-delete', title: `시험 ${i}`, target: `k_c9${i}`, corp: '',
    payload: { keyId: `k_c9${i}` }, requestedBy: 'own', requestedAt, expiresAt: requestedAt + AP.REQUEST_TTL_MS, status, decidedBy: decidedAt ? 'own2' : '', decidedAt, note: '', result: null });
  const old = mk(1, 'pending', now - 3 * 3600_000);   // 가장 오래 기다린 요청
  const pend = [mk(2, 'pending', now - 3 * 3600_000 + 1), mk(3, 'pending', now - 3 * 3600_000 + 2)];
  const done = Array.from({ length: H }, (_, i) => mk(100 + i, 'rejected', now - 2 * 3600_000 + i, now - 3600_000 + i));
  fs.writeFileSync(approvalsFile, JSON.stringify({ requests: [old, ...pend, ...done] }));
  AP._resetApprovalsForTest();
  assert.equal(AP.approvalsLoadError(), null);
  // E-1 — 화면 목록: 대기 3개 전부 + 끝난 것 최근 60개. 예전 방식(합쳐서 60개)이면 대기 요청이 하나도 보이지 않는다.
  assert.equal(AP.listRequests({ kinds: ['ssh-key-delete'], limit: 60 }, { now }).filter((r) => r.status === 'pending').length, 0, '전제 — 합쳐 자르면 대기 요청이 밀린다');
  const lv = AP.listForView({ kinds: ['ssh-key-delete'], doneLimit: 60 }, { now });
  assert.deepEqual([lv.filter((r) => r.status === 'pending').length, lv.filter((r) => r.status !== 'pending').length], [3, 60]);
  const v = await SVC.buildView({ now });
  assert.deepEqual(v.approvals.filter((r) => r.status === 'pending').map((r) => r.id).sort(), [old.id, ...pend.map((p) => p.id)].sort(), '화면(buildView)도 같은 목록');
  assert.equal(v.approvals.filter((r) => r.status !== 'pending').length, 60);
  // C-9 — 가장 오래 기다린 요청을 지금 돌려보낸다 → 그 기록은 남고(끝난 시각이 가장 늦다), 가장 먼저 끝난 기록이 잘린다
  const d = AP.decide(old.id, { by: 'own2', approve: false, note: 'c9' }, { now });
  assert.equal(d.ok, true, JSON.stringify(d));
  const onDisk = JSON.parse(fs.readFileSync(approvalsFile, 'utf8')).requests;
  assert.equal(onDisk.filter((r) => r.status !== 'pending').length, H, '끝난 기록 상한');
  assert.ok(onDisk.some((r) => r.id === old.id && r.status === 'rejected'), '방금 결정한 기록이 남았다(요청 시각 순으로 자르면 바로 잘렸다)');
  assert.equal(onDisk.some((r) => r.id === done[0].id), false, '가장 먼저 끝난 기록이 잘렸다');
  assert.deepEqual([AP.getRequest(old.id)?.note, onDisk.filter((r) => r.status === 'pending').length], ['c9', 2], '대기 요청은 자르지 않는다');
  fs.rmSync(approvalsFile, { force: true });
  AP._resetApprovalsForTest();
});

/* ── 2. 두 사람 승인 — 실제 라우트 ─────────────────────────────────────── */
test('③ 키 등록(두 사람 승인) — 7b 화면은 OTP 를 쓰기 전에 409 · 등록 = 202 승인 대기 · 대기 키는 접속 · 고르기 · 키 로그인 설정 · 공통 계정에 쓰이지 않는다 · 권한 없는 계정은 OTP 전에 403 · 요청자 승인 403 · 다른 소유자 + 같은 지문 → 활성', async () => {
  // 보호 장치는 기본 켬 · 승인할 수 있는 소유자가 둘 이상인 설치라 화면(buildView)이 이미 ‘쌍을 봤다’(pairSeen)를 세웠다 — 이제 두 사람 승인은 혼자 끌 수 없다(반증 R3)
  assert.deepEqual([G.twoPersonOn(), ST.getGuards()], [true, { twoPerson: true, serverRestrict: true, pairSeen: true, seenAd: [] }]);
  assert.ok(G.approverNames().length >= 2);
  assert.ok(eventsOf('guard-changed').some((e) => /승인할 수 있는 설정 소유자 둘을 확인/.test(e.detail)), '쌍을 본 것은 사건으로 남는다');
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
  assert.equal((await SVC.startKeyLogin({ servers: [sv], keyId: pk.id, by: 'own' })).code, 'key-pending');
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
  // 요청한 사람은 OTP 가 맞아도 승인할 수 없다 — 사전 검사가 OTP 앞이라 그 코드는 쓰이지 않는다(점검 A10)
  const ownCode = await otp('own');
  const a2 = await call('own', 'POST', url, { digest, otp: ownCode });
  assert.deepEqual([a2.s, a2.j.code, a2.j.needOtp], [403, 'self-approve', undefined], a2.txt);
  assert.equal(AUTH.verifyUserOtp('own', ownCode).ok, true, '자기 승인 거절이 OTP 를 소모하지 않았다(점검 A10)');
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

test('③-b 승인 · 돌려보내기 사전 검사는 OTP 앞 — 자기 승인 403 · 지문 불일치 409 · 이미 처리됨 409 · 승인 기록 못 읽음 503 은 1회 비밀번호를 쓰지 않는다(점검 A10) · 승인 기록을 못 읽으면 404 가 아니라 503(점검 C-11)', async () => {
  const K = F.ed25519Key(); ALL_PEMS.push(K.pem);
  const add = await SVC.addKeyInFolder({ name: 'tp-a10', privateKey: K.pem, folderCorp: 'vcA', features: ['bm-usage'] }, { by: 'own5' });
  assert.deepEqual([add.ok, add.pending], [true, true], JSON.stringify(add));
  const { id, digest } = add.request;
  const url = (w) => `/settings/ssh-access/approvals/${id}/${w}`;
  // 거절된 요청이 그 코드를 쓰지 않았다 = 같은 코드로 지금 검증이 된다(③ 의 adm2 와 같은 확인 방식)
  const unused = (u, code, what) => assert.equal(AUTH.verifyUserOtp(u, code).ok, true, `${what} — ${u} 의 코드가 쓰이지 않았다`);
  // 자기 승인
  const c1 = await otp('own5');
  const r1 = await call('own5', 'POST', url('approve'), { digest, otp: c1 });
  assert.deepEqual([r1.s, r1.j.code, r1.j.needOtp], [403, 'self-approve', undefined], r1.txt);
  unused('own5', c1, '자기 승인');
  // 지문 불일치(화면이 본 요청과 다르다)
  const c2 = await otp('own6');
  const r2 = await call('own6', 'POST', url('approve'), { digest: '0'.repeat(32), otp: c2 });
  assert.deepEqual([r2.s, r2.j.code], [409, 'digest-mismatch'], r2.txt);
  unused('own6', c2, '지문 불일치');
  assert.equal(AP.getRequest(id).status, 'pending', '거절된 시도는 요청을 바꾸지 않는다');
  // 서비스 사전 검사 — AD 별칭도 같은 사람(점검 A2) · 통과면 null · 요청자 본인의 돌려보내기(취소)는 통과 · 없는 요청 404
  assert.equal(SVC.approvalPrecheck(id, { approve: true, by: 'CORP\\own5', digest }).code, 'self-approve');
  assert.equal(SVC.approvalPrecheck(id, { approve: true, by: 'own5@corp.local', digest }).code, 'self-approve');
  assert.equal(SVC.approvalPrecheck(id, { approve: true, by: 'own6', digest }), null);
  assert.equal(SVC.approvalPrecheck(id, { approve: false, by: 'own5' }), null);
  assert.deepEqual((({ code, status }) => [code, status])(SVC.approvalPrecheck('ap_000000000000', { approve: true, by: 'own6', digest })), ['not-found', 404]);
  // 승인 기록을 못 읽음 — 라우트 503 · OTP 를 쓰지 않는다 · 서비스(decideApproval)도 404 가 아니라 503(점검 C-11 — 화면이 ‘요청이 사라졌다’ 로 읽었다)
  const good = fs.readFileSync(approvalsFile, 'utf8');
  fs.writeFileSync(approvalsFile, '{ broken');
  AP._resetApprovalsForTest();
  const c3 = await otp('own6');
  const r3 = await call('own6', 'POST', url('approve'), { digest, otp: c3 });
  assert.deepEqual([r3.s, r3.j.code], [503, 'approvals-unreadable'], r3.txt);
  unused('own6', c3, '승인 기록 못 읽음');
  assert.equal(SVC.approvalPrecheck(id, { approve: false, by: 'own6' }).code, 'approvals-unreadable', '돌려보내기 사전 검사도');
  for (const approve of [true, false]) {
    const d = await SVC.decideApproval(id, { approve, by: 'own6', digest });
    assert.deepEqual([d.ok, d.code, d.status], [false, 'approvals-unreadable', 503], `decideApproval approve=${approve}`);
  }
  clearCorrupt(AP.APPROVALS_FILE_NAME);
  fs.writeFileSync(approvalsFile, good);
  AP._resetApprovalsForTest();
  // 요청자 본인의 돌려보내기(취소 — 소유자 등급 + OTP) → 그 뒤 승인 · 돌려보내기는 ‘이미 처리됨’ 409 이고 OTP 를 쓰지 않는다
  const r4 = await call('own5', 'POST', url('reject'), { otp: await otp('own5') });
  assert.deepEqual([r4.s, r4.j.request?.status], [200, 'cancelled'], r4.txt);
  assert.equal(KS.keyByName('tp-a10'), null, '취소된 요청의 대기 키는 지워졌다');
  const c5 = await otp('own5');
  const r5 = await call('own5', 'POST', url('reject'), { otp: c5 });
  assert.deepEqual([r5.s, r5.j.code], [409, 'not-pending'], r5.txt);
  unused('own5', c5, '이미 처리된 요청 돌려보내기');
  const c6 = await otp('own6');
  const r6 = await call('own6', 'POST', url('approve'), { digest, otp: c6 });
  assert.deepEqual([r6.s, r6.j.code], [409, 'not-pending'], r6.txt);
  unused('own6', c6, '이미 처리된 요청 승인');
});

test('③-c 승인 대기 키는 고를 수도 없다 — CSV 온보딩(importAnalyze) 행 거절 key-pending · bm-storage 키 고르기(bmBindCheck) key-pending · 활성 키는 그대로(점검 A7 · D-2)', async () => {
  const pk = mkKey('tp-pend-bind', { pending: true });
  const ak = mkKey('tp-act-bind');
  const { bmBindCheck } = await import('../src/routes/api/bmstor.js');
  const b1 = await bmBindCheck({ name: 'bm-pb1', host: '10.9.7.1', username: 'mon', keyRef: pk.id });
  assert.deepEqual([b1.code, typeof b1.error], ['key-pending', 'string'], JSON.stringify(b1));
  const b2 = await bmBindCheck({ name: 'bm-pb1', host: '10.9.7.1', username: 'mon', keyRef: ak.id });
  assert.deepEqual([b2.error, b2.binds], [undefined, true], JSON.stringify(b2));
  // CSV 온보딩 — 같은 판정(활성만)
  const P = await import('../src/bmusage/onboard/importParse.js');
  const A = await import('../src/bmusage/onboard/importAnalyze.js');
  const RUN = await import('../src/bmusage/onboard/onboardRun.js');
  const parsed = await P.parseOnboardFile(Buffer.from(`﻿${['name,corp,os_host,os_cred,os_key,mounts', 'bm-pb2,KR-SEL,10.9.7.2,개별:mon,tp-pend-bind,/', 'bm-pb3,KR-SEL,10.9.7.3,개별:mon,tp-act-bind,/'].join('\r\n')}\r\n`, 'utf8'));
  assert.equal(parsed.ok, true, parsed.reason);
  const ctx = RUN.buildOnboardCtx({ D: await RUN.defaultOnboardDeps(), corps: [{ id: 'vcA', name: 'KR-SEL', dc: '' }], isEdge: false, myCorps: [], edgeOf: () => null, rttOf: () => null,
    canView: () => true, canWrite: () => true, fullScope: true, ownerTier: true }).ctx;
  const rows = A.analyzeOnboardRows(parsed.rows, ctx).rows;
  assert.deepEqual(rows.map((x) => [x.name, x.action, x.code]), [['bm-pb2', 'reject', 'key-pending'], ['bm-pb3', 'new', '']], JSON.stringify(rows));
  assert.equal(typeof A.ROW_CODE['key-pending'], 'string', '거절 사유 문구가 있다');
  assert.ok(KS._removeKey(pk.id).ok);
});

test('③-d 쓰기 라우트의 결정적 거절은 OTP 앞(1회차 A5) — 같은 요청 대기 · 중지 아님 · 키 없음 · 승인 대기 키 넣기 · 보호 장치 끄기 중복은 1회 비밀번호를 쓰지 않는다 · 쓰기 범위(writeVcenters)가 좁은 소유자는 조회만 되고 쓰기 · 승인은 403 write-scope(1회차 A3) · 7b 화면 안내 문구', async () => {
  const unused = (u, code, what) => assert.equal(AUTH.verifyUserOtp(u, code).ok, true, `${what} — ${u} 의 코드가 쓰이지 않았다`);
  const kFrom = mkKey('pre-from'); const kTo = mkKey('pre-to'); const kPend = mkKey('pre-pend', { pending: true });
  const rq = await SVC.rotateKeyReq({ from: kFrom.id, to: kTo.id, by: 'own' });   // 같은 대상의 요청이 이미 대기
  assert.equal(rq.pending, true, JSON.stringify(rq));
  const gq = await SVC.changeGuards({ serverRestrict: false }, { by: 'own' });     // 보호 장치 끄기 요청 대기
  assert.equal(gq.pending, true, JSON.stringify(gq));
  const cases = [
    ['own8', 'POST', '/settings/ssh-access/keys/rotate', { from: kFrom.id, to: kTo.id }, 409, 'dup-request'],
    ['own8', 'DELETE', '/settings/ssh-access/corps/vcZ/stop', null, 409, 'not-stopped'],
    ['own8', 'DELETE', '/settings/ssh-access/keys/k_000000000000', null, 404, 'not-found'],
    ['own9', 'POST', '/settings/ssh-access/key-login', { keyId: kPend.id, servers: [{ id: 'x', addr: 'x' }] }, 409, 'key-pending'],
    ['own9', 'PUT', '/settings/ssh-access/guards', { serverRestrict: false }, 409, 'dup-request'],
  ];
  for (const [u, method, url, body, s0, code0] of cases) {
    const code = await otp(u);
    const r = method === 'DELETE' ? await call(u, method, `${url}?otp=${code}`) : await call(u, method, url, { ...body, otp: code });
    assert.deepEqual([r.s, r.j.code, r.j.needOtp], [s0, code0, undefined], `${method} ${url}: ${r.txt}`);
    unused(u, code, `${method} ${url}`);
  }
  // 쓰기 범위가 좁은 소유자(lim) — 화면은 보지만 바꾸지 못한다. OTP 를 묻기 전에 403(그 코드는 쓰이지 않는다)
  assert.equal((await call('lim', 'GET', '/settings/ssh-access')).s, 200, '조회는 소유자 등급(조회 범위 무제한)');
  const lc = await otp('lim');
  for (const [method, url, body] of [['POST', '/settings/ssh-access/key-login', { keyId: kFrom.id, servers: [] }], ['POST', `/settings/ssh-access/approvals/${rq.request.id}/approve`, { digest: rq.request.digest }],
    ['POST', '/settings/ssh-access/corps/vcZ/stop', { reason: 'x' }], ['POST', '/settings/ssh-access/jobs/kj_000000000000/cancel', {}]]) {
    const r = await call('lim', method, url, { ...body, otp: lc });
    assert.deepEqual([r.s, r.j.code], [403, 'write-scope'], `${url}: ${r.txt}`);
  }
  unused('lim', lc, '쓰기 범위 거절');
  assert.equal(G.otherOwners('own').includes('lim'), false, '승인자로도 세지 않는다(1회차 A3)');
  assert.equal(ST.stopFor('vcZ'), null);
  // 7b 화면 안내 — 승인할 다른 소유자가 없을 때의 길까지 말한다
  assert.match(G.twoPersonRedirect().reason, /승인할 다른 소유자가 없으면, 승인할 수 있는 소유자가 둘이었던 적이 없는 포탈은 그 화면의 보호 장치에서 두 사람 승인을 끌 수 있고, 그 밖에는 승인할 소유자를 다시 세워야 합니다/, '쌍을 본 포탈은 혼자 끌 수 없다는 것까지 밝힌다(2회차)');
  for (const r of [rq, gq]) assert.equal((await SVC.decideApproval(r.request.id, { approve: false, by: 'own' })).request.status, 'cancelled');
  assert.ok(KS._removeKey(kPend.id).ok);
});

test('③-e 파일을 못 읽어 생기는 거절도 OTP 앞 — 사용 재개는 상태 파일을 못 읽으면 503 state-unreadable · 키 작업은 키 저장소 · OS 계정 등록부가 손상이면 503 registry-unreadable(사전 검사 함수가 답한다 — 라우트 줄에서 pre · jobPre 가 reauth 앞인 것은 ⑲ 가 본다 · 1회차 반증 참고: 1회 코드를 쓴 뒤 503 이었다)', {}, () => {
  const tot = () => ({ totpEnabled: true, totpSecret: generateSecret() });
  const users = [{ username: 'own', role: 'admin', ...tot() }, { username: 'own2', role: 'admin', ...tot() }];
  const pick = 'const pick = (r) => (r ? { ok: r.ok, code: r.code, status: r.status, reason: r.reason } : null);';
  const corrupt = (name) => `fs.writeFileSync(path.join(process.env.CONFIG_DIR, '${name}'), '{ not json');`;
  const a = subRun({ owners: 'own,own2', users, code: `${pick} ${corrupt('ssh-access-state.json')}
    const SVC = await imp('sshaccess/service.js');
    console.log(JSON.stringify({ r: pick(await SVC.prechecks.resume({ corp: 'vcA', by: 'own' })) }));` });
  assert.deepEqual([a.r?.ok, a.r?.code, a.r?.status], [false, 'state-unreadable', 503], `예전에는 null(통과) → OTP 를 쓴 뒤 본 함수가 503 ${JSON.stringify(a)}`);
  const b = subRun({ owners: 'own,own2', users, code: `${pick} ${corrupt('ssh-keys.json')}
    const SVC = await imp('sshaccess/service.js');
    console.log(JSON.stringify({ login: pick(await SVC.keyJobPrecheck('key-login', 'k_000000000000')), revoke: pick(await SVC.keyJobPrecheck('key-revoke', '')) }));` });
  for (const r of [b.login, b.revoke]) {
    assert.deepEqual([r?.ok, r?.code, r?.status], [false, 'registry-unreadable', 503], JSON.stringify(b));
    assert.match(r.reason, /SSH 키 저장소/);
  }
  const c = subRun({ owners: 'own,own2', users, code: `${pick} ${corrupt('bm-storage.json')}
    const SVC = await imp('sshaccess/service.js');
    console.log(JSON.stringify({ login: pick(await SVC.keyJobPrecheck('key-login', 'k_000000000000')), revoke: pick(await SVC.keyJobPrecheck('key-revoke', '')) }));` });
  for (const r of [c.login, c.revoke]) {
    assert.deepEqual([r?.ok, r?.code, r?.status], [false, 'registry-unreadable', 503], JSON.stringify(c));
    assert.match(r.reason, /OS 계정 등록부/);
  }
  // 대조 — 파일이 멀쩡하면 같은 호출이 이 사유로 막히지 않는다(없는 키는 404 · 사용 중지 아님은 409)
  const d = subRun({ owners: 'own,own2', users, code: `${pick}
    const SVC = await imp('sshaccess/service.js');
    console.log(JSON.stringify({ resume: pick(await SVC.prechecks.resume({ corp: 'vcA', by: 'own' })), revoke: pick(await SVC.keyJobPrecheck('key-revoke', '', { corp: 'vcA' })) }));` });
  assert.deepEqual([d.resume?.code, d.revoke?.code], ['not-stopped', undefined], JSON.stringify(d));
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
  // 사용처가 있는 대기 키(예전 판에서 묶인 자료 — 지금은 묶기 자체를 막는다)는 지우지 않는다: 지우면 그 서버가 key-missing 으로 남는다(점검 C-5)
  const orphanUsed = mkKey('tp-orphan-used', { pending: true });
  const svO = mkServer('bm-tp-orphan', null, { host: '10.9.1.10', keyRef: orphanUsed.id, bindApproved: true });
  assert.equal(rawOf(svO.id).keyRef, orphanUsed.id, '전제 — 등록부에 묶인 대기 키');
  assert.deepEqual((({ ok, code }) => [ok, code])(await SVC.deleteKeyReq({ keyId: orphanUsed.id, by: 'own' })), [false, 'in-use']);
  const dq2 = await SVC.addKeyInFolder({ name: 'tp-c5-req', privateKey: (() => { const k = F.ed25519Key(); ALL_PEMS.push(k.pem); return k.pem; })(), folderCorp: 'vcA', features: ['bm-usage'] }, { by: 'own' });
  const c5 = KS.keyByName('tp-c5-req');
  const svC5 = mkServer('bm-tp-c5', null, { host: '10.9.1.11', keyRef: c5.id, bindApproved: true });
  assert.equal((await SVC.decideApproval(dq2.request.id, { approve: false, by: 'own2' })).request.status, 'rejected');
  assert.equal(KS.keyById(c5.id)?.status, 'pending', '돌려보낸 요청의 대기 키라도 쓰는 서버가 있으면 남긴다(뒷정리 = deleteKeyIfUnused)');
  for (const s of [svO, svC5]) assert.ok(BM.removeBmServer(s.id).ok);
  for (const k of [orphanUsed, c5]) assert.ok(KS._removeKey(k.id).ok);
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
  assert.equal((await SVC.stopCorp('vcB', { by: 'own', reason: '유출 의심' })).ok, true);
  assert.equal(REFS.resolveOsAuth(srvB, { feature: 'bm-usage' }).code, 'corp-stopped');
  const rs = await call('own3', 'DELETE', `/settings/ssh-access/corps/vcB/stop?otp=${await otp('own3')}`);
  assert.equal(rs.s, 202, rs.txt);
  assert.deepEqual([rs.j.pending, rs.j.request.kind, rs.j.request.target], [true, 'ssh-corp-resume', 'vcB']);
  assert.deepEqual(rs.j.request.payload, { corp: 'vcB', stopAt: ST.stopFor('vcB').at }, '요청은 그때의 중지(걸린 시각)에 묶인다(점검 A6)');
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
  assert.deepEqual(rl.j.request.payload, { sha: KS.diskFileSha() }, '요청은 그때의 디스크 내용(sha256)에 묶인다(점검 A5)');
  assert.match(rl.j.request.payload.sha, /^[0-9a-f]{64}$/);
  assert.equal(eventsOf('keystore-reloaded').length, before, '승인 전에는 다시 읽지 않았다');
  const ro = await SVC.decideApproval(rl.j.request.id, { approve: true, by: 'own', digest: rl.j.request.digest });
  assert.equal(ro.ok, true, JSON.stringify(ro));
  assert.deepEqual([eventsOf('keystore-reloaded').length, eventsOf('keystore-reloaded')[0].by], [before + 1, 'own']);
  // 보호 장치 — 켜는 것은 바로 · 끄는 것은 다른 소유자의 승인 뒤(한 요청에 섞여 있어도 따로)
  assert.equal(ST.setGuards({ serverRestrict: false }, { by: 'fixture' }).ok, true);
  const gd = await call('own2', 'PUT', '/settings/ssh-access/guards', { serverRestrict: true, twoPerson: false, otp: await otp('own2') });
  assert.equal(gd.s, 202, gd.txt);
  assert.deepEqual([gd.j.pending, gd.j.request.kind, gd.j.request.payload], [true, 'ssh-guard-change', { patch: { twoPerson: false } }]);
  assert.deepEqual(ST.getGuards(), { twoPerson: true, serverRestrict: true, pairSeen: true, seenAd: [] }, '켜기는 바로 적용 · 끄기는 아직');
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
  assert.deepEqual(ST.getGuards(), { twoPerson: true, serverRestrict: true, pairSeen: true, seenAd: [] });
  assert.ok(eventsOf('guard-changed').length >= 2);
});

/** 따로 설정 폴더를 둔 자식 프로세스에서 부른다(소유자 · 계정 구성이 이 파일과 달라야 하는 시험). code 는 마지막 줄에 JSON 한 줄을 찍는다. imp(p) = src/p. dir 를 주면 그 폴더를 이어 쓴다(재시작 흉내). */
function subRun({ owners, users, code, prefix = 'sshkl-sub-', env = {}, dir = '' }) {
  const d = dir || fs.mkdtempSync(path.join(TMP, prefix));
  if (!dir) TMP_DIRS.push(d);
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
    const fs = await import('node:fs'); const path = await import('node:path');
    fs.writeFileSync(path.join(process.env.CONFIG_DIR, 'users.json'), JSON.stringify({ users: ${JSON.stringify(users)} }));
    const imp = (p) => import(${JSON.stringify(`${SRC}/`)} + p);
    const F = await import(${JSON.stringify(path.join(HERE, '_sshKeyFixtures.js'))});
    void F;
    ${code}
  `], { env: { ...process.env, CONFIG_DIR: d, SETTINGS_OWNERS: owners, ...env }, encoding: 'utf8' }).trim().split('\n').pop();
  try { return { dir: d, ...JSON.parse(out) }; } catch { assert.fail(`자식 프로세스 출력이 JSON 이 아니다: ${out}`); }
}

test('⑥-b 승인할 사람이 없는 설치 — 키 등록 · 받는 곳 승인 · 재개는 부작용 전에 409 no-approver(대기 키 저장 · 평문 삭제 없음 — 점검 C-7) · 승인자 쌍을 본 적 없는 설치는 목록에 범위 소유자가 있어도 두 사람 승인 끄기가 본인만으로 된다(잠기지 않게 — 반증 R4)',
  {}, () => {
    const j = subRun({ owners: 'solo,scoped', users: [
      { username: 'solo', role: 'admin', totpEnabled: true, totpSecret: generateSecret() },
      { username: 'scoped', role: 'admin', scope: { vcenters: ['vcA'] } }], code: `
      const VAULT = await imp('security/secretVault.js'); VAULT.saveSecretsPolicy({ mode: 'encrypted', level: 1 });
      const { store } = await imp('store.js'); store.snapshot = { ...store.get(), vcenters: [{ id: 'vcA', name: 'KR-SEL' }] };
      const AUTH = await imp('auth/auth.js'); const SVC = await imp('sshaccess/service.js'); const ST = await imp('sshaccess/state.js');
      const G = await imp('sshaccess/guards.js'); const KS = await imp('bmusage/onboard/keyStore.js'); const INB = await imp('sshaccess/inbox.js');
      const AP = await imp('approval/store.js'); const SEC = await imp('security/securitySettings.js');
      const su = AUTH.getUser('noainred');
      const before = G.twoPersonOn();
      const pick = (r) => ({ ok: r.ok, code: r.code, status: r.status, reason: r.reason, pending: r.pending === true });
      const sha0 = KS.diskFileSha();
      const add = pick(await SVC.addKeyInFolder({ name: 'solo-k', privateKey: F.ed25519Key().pem, folderCorp: 'vcA', features: ['bm-usage'] }, { by: 'solo' }));
      const shaAfterAdd = KS.diskFileSha();
      const IK = F.ed25519Key();
      const idir = INB.inboxPathOf('vcA'); fs.mkdirSync(idir, { recursive: true }); fs.writeFileSync(path.join(idir, 'id_solo'), IK.pem, { mode: 0o600 });
      const it = (await INB.scanInbox({ corps: [{ id: 'vcA' }], servers: [] })).items.find((x) => x.file === 'id_solo');
      const ib = pick(await SVC.approveInbox({ relPath: it.relPath, fingerprint: IK.fingerprint, sha: it.sha, name: 'solo-inbox', features: ['bm-usage'], by: 'solo' }));
      const stop = await SVC.stopCorp('vcA', { by: 'solo', reason: '시험' });
      const rs = pick(await SVC.resumeCorp('vcA', { by: 'solo' }));
      const g = pick(await SVC.changeGuards({ twoPerson: false }, { by: 'solo' }));
      console.log(JSON.stringify({ before, owners: SEC.loadSessionSecurity().settingsOwners.filter((x) => x !== 'solo').sort(), superCanLogin: !!(su && (su.passwordHash || su.totpEnabled)),
        approvers: G.approverNames(), other: G.otherOwners('solo'), add, keyStored: !!KS.keyByName('solo-k'), storeUntouched: sha0 === shaAfterAdd,
        ib, inboxKept: fs.existsSync(path.join(idir, 'id_solo')), inboxKeyStored: !!KS.keyByName('solo-inbox'), stopOk: stop.ok, rs, stillStopped: !!ST.stopFor('vcA'),
        requests: AP.listRequests({}).length, g, guards: ST.getGuards(), ev: ST.listEvents({ limit: 50 }).filter((e) => e.kind === 'guard-changed').map((e) => e.detail) }));
    ` });
    // 전제 — 요청자 말고 유효 소유자 목록에 있는 이름은 로그인 수단이 없는 자동 포함 계정과 범위 소유자뿐이다(둘 다 승인 라우트를 통과하지 못한다)
    assert.deepEqual([j.before, j.owners, j.superCanLogin, j.approvers, j.other], [true, ['noainred', 'scoped'], false, ['solo'], []], JSON.stringify(j));
    // 점검 C-7 — 승인할 사람이 없으면 요청을 만들지 않는다: 대기 키를 저장하지 않고 받는 곳의 평문 파일도 지우지 않는다(끄는 길을 안내한다)
    assert.deepEqual([j.add.code, j.add.status, j.keyStored, j.storeUntouched], ['no-approver', 409, false, true], `대기 키를 저장했다 지우지도 않는다(키 저장소 파일을 쓰지 않음) ${JSON.stringify(j.add)}`);
    assert.match(j.add.reason, /두 사람 승인을 끄면 본인 OTP 만으로/);
    assert.deepEqual([j.ib.code, j.ib.status, j.inboxKept, j.inboxKeyStored], ['no-approver', 409, true, false], JSON.stringify(j.ib));
    assert.deepEqual([j.stopOk, j.rs.code, j.rs.status, j.stillStopped, j.requests], [true, 'no-approver', 409, true, 0], '멈추기는 바로 · 재개(다시 여는 쪽)는 요청을 만들지 않는다');
    // 반증 R4 — 화면에서 뺄 수 없는 범위 소유자(중앙 배포 admin 등)가 목록에 있어도 승인자 쌍을 본 적이 없으면 잠기지 않는다(첫 수정의 ‘목록 기준 409’ 를 뒤집음)
    assert.deepEqual([j.g.ok, j.g.pending, j.guards.twoPerson, j.guards.pairSeen], [true, false, false, false], JSON.stringify(j.g));
    assert.ok(j.ev.some((x) => /본인 OTP 만으로 껐습니다/.test(x)), '사건에 그렇게 적는다');
  });

test('⑥-c 복원 번들이 실어 온 새 개인키 — 복원(적용 시점 합치기)이 두 사람 승인 · OTP 없이 활성 키를 들이지 않는다(백업에는 개인키가 없다 — 설계 S13)',

  {}, async () => {
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

test('⑥-d 승인할 수 있는 소유자 둘을 한 번 본 설치(pairSeen) — 그 뒤 한 명을 목록에서 빼거나 범위 지정 · 강등해 승인자가 0명이 돼도 두 사람 승인을 혼자 끄지 못한다(409 · 반증 R3 · 점검 A1) · 쌍을 본 적 없는 설치(자기 자신 · AD 별칭 · 로그인 수단 없는 noainred 뿐)는 혼자 끈다(A2 의 짝)',
  {}, () => {
    const solo = { username: 'solo', role: 'admin', totpEnabled: true, totpSecret: generateSecret() };
    const other = { username: 'other', role: 'admin', totpEnabled: true, totpSecret: generateSecret() };
    const code = `
      const SVC = await imp('sshaccess/service.js'); const ST = await imp('sshaccess/state.js'); const G = await imp('sshaccess/guards.js');
      const seen0 = ST.getGuards().pairSeen;
      const v = await SVC.buildView();   // 화면을 한 번 연다(notePair)
      const r = process.env.T_OFF === '1' ? await SVC.changeGuards({ twoPerson: false }, { by: 'solo' }) : { ok: null };
      console.log(JSON.stringify({ seen0, viewSeen: v.guards.pairSeen, approvers: G.approverNames(), other: G.otherOwners('solo'), ok: r.ok, code: r.code || '', status: r.status || 0, reason: r.reason || '',
        pending: r.pending === true, approvers2: r.approvers ?? 0, guards: ST.getGuards(), ev: ST.listEvents({ limit: 20 }).filter((e) => e.kind === 'guard-changed').map((e) => e.detail) }));`;
    // ① 소유자 둘(solo · other) — 화면을 여는 것만으로 ‘쌍을 봤다’ 가 상태 파일에 남는다(내릴 길이 없다)
    const a = subRun({ owners: 'solo,other', users: [solo, other], code });
    assert.deepEqual([a.seen0, a.viewSeen, a.approvers.sort(), a.guards.pairSeen], [false, true, ['other', 'solo'], true], JSON.stringify(a));
    assert.ok(a.ev.some((x) => /둘을 확인 — 이제 두 사람 승인은 혼자 끌 수 없습니다/.test(x)));
    // ② 같은 설치(상태 파일 이어 씀)에서 other 를 설정 소유자 목록에서 뺐다 → 승인자 0명이지만 혼자 끄지 못한다
    const b = subRun({ dir: a.dir, owners: 'solo', users: [solo, other], code, env: { T_OFF: '1' } });
    assert.deepEqual([b.other, b.ok, b.code, b.status, b.pending, b.guards.twoPerson, b.guards.pairSeen], [[], false, 'no-approver', 409, false, true, true], JSON.stringify(b));
    assert.match(b.reason, /혼자 끌 수 없습니다/);
    // ③ 목록에는 있지만 범위 지정(소유자 등급 아님)으로 바꿨다 → 같다
    const c = subRun({ dir: a.dir, owners: 'solo,other', users: [solo, { ...other, scope: { vcenters: ['vcA'] } }], code, env: { T_OFF: '1' } });
    assert.deepEqual([c.other, c.code, c.status, c.guards.twoPerson], [[], 'no-approver', 409, true], JSON.stringify(c));
    // ④ 쌍을 본 적 없는 설치 — 목록이 자기 자신 · 그 AD 별칭 두 꼴(같은 사람 — 점검 A2) · 자동 포함 noainred(로그인 수단 없음)뿐이면 혼자 끈다
    const d = subRun({ owners: 'solo,CORP\\solo,solo@corp.local', users: [solo], code, env: { T_OFF: '1' } });
    assert.deepEqual([d.approvers, d.other, d.ok, d.pending, d.approvers2, d.guards.twoPerson, d.guards.pairSeen], [['solo'], [], true, false, 0, false, false], JSON.stringify(d));
    assert.ok(d.ev.some((x) => /본인 OTP 만으로/.test(x)), '사건에 그렇게 적는다');
    // ⑤ noainred 가 로그인 수단(비밀번호)이 있는 관리자면 승인자다 → 끄기는 승인 요청(그리고 쌍을 봤다)
    const e = subRun({ owners: 'solo', users: [solo, { username: 'noainred', role: 'admin', passwordHash: 'x'.repeat(60) }], code, env: { T_OFF: '1' } });
    assert.deepEqual([e.other, e.ok, e.pending, e.approvers2, e.guards.twoPerson, e.guards.pairSeen], [['noainred'], true, true, 1, true, true], JSON.stringify(e));
  });

test('⑥-e AD 별칭은 같은 사람 — 승인자 셈(otherOwners · approverNames)이 요청자의 다른 꼴(CORP\\own · own@corp · 대문자)을 승인자로 세지 않는다(점검 A2)', () => {
  const base = G.otherOwners('own');
  assert.deepEqual([base.includes('own'), base.includes('own2'), base.includes('sown')], [false, true, false], '전제 — 요청자 빼고 · 범위 소유자는 승인자가 아니다');
  assert.deepEqual([...G.approverNames()].sort(), ['own', 'own2', 'own3', 'own4', 'own5', 'own6', 'own7', 'own8', 'own9'], '승인할 수 있는 소유자 전부(범위 소유자 · 로그인 수단 없는 noainred 제외)');
  for (const alias of ['CORP\\own', 'corp.local\\Own', 'own@corp.local', 'OWN']) {
    assert.deepEqual(G.otherOwners(alias), base, alias);
  }
});

test('⑥-f 복원 합치기는 공개키 · 알고리즘 · 이름 칸과 공통 계정 비밀번호를 번들에서 받지 않는다 · 키 id 는 다른 키와 겹칠 때만 지금 것 · 공통 계정 묶음 칸은 번들 값(끊긴 기본 키는 dropped)(점검 A3 · A4 · 반증 R7 · 1회차 A6 · D2) · 저장된 공개키가 지문과 맞지 않는 키는 서버에 넣지도 거두지도 않는다(key-tampered — 점검 A3)', async () => {
  const BUN = await import('../src/bmusage/onboard/keyBundle.js');
  const file = path.join(DIR, 'ssh-keys.json');
  const k = mkKey('a3-key');
  const kOld = mkKey('a3-old');
  const good = mkKey('a3-new');   // 파일을 고치기 전에 넣는다(포탈 밖 변경이 남아 있으면 저장소가 쓰기를 거절한다 — 반증 D8)
  const acc = KS.saveAccount({ name: 'a4-acc', kind: 'os', corp: 'vcA', username: 'svc', password: secret('Acc-Pw-Current-A4') }, { by: 'fixture' });
  assert.ok(acc.ok, JSON.stringify(acc));
  const cur = fs.readFileSync(file, 'utf8');
  const curJ = JSON.parse(cur);
  const curK = curJ.keys.find((x) => x.id === k.id); const curA = curJ.accounts.find((a) => a.id === acc.account.id);
  const other = pubOf(F.ed25519Key().pem);
  // 손으로 만든 번들 — 같은 지문 · 남의 공개키(‘공개키 복사’ · authorized_keys 줄에 남의 키가 실린다) · 가리지 않은 평문 비밀번호 · 지금 없는 계정의 평문 비밀번호
  const bundle = JSON.parse(KS.redactKeyStoreText(cur).text);
  for (const x of bundle.keys) if (x.id === k.id) Object.assign(x, { publicKey: other, algo: 'rsa', sshType: 'ssh-rsa', bits: 1024 });
  for (const a of bundle.accounts) if (a.id === acc.account.id) a.password = 'Bundle-Plain-Pw-A4';
  bundle.accounts.push({ id: 'a_0000000000a4', name: 'a4-new', kind: 'os', corp: 'vcA', username: 'x', keyRef: '', password: 'Bundle-New-Pw-A4' });
  const merged = JSON.parse(BUN.mergeRedactedKeyStore(JSON.stringify(bundle), cur).text);
  const mk = merged.keys.find((x) => x.id === k.id);
  assert.deepEqual([mk.publicKey, mk.algo, mk.sshType, mk.bits], [curK.publicKey, curK.algo, curK.sshType, curK.bits], '공개키 · 알고리즘 칸은 지금 파일의 같은 지문 키에서');
  assert.equal(mk.publicKey, k.publicKey);
  const ma = merged.accounts.find((a) => a.id === acc.account.id);
  assert.equal(ma.password, curA.password, '같은 계정이면 지금 값(봉인본) — 번들의 평문을 받지 않는다');
  assert.equal(merged.accounts.find((a) => a.id === 'a_0000000000a4').password, '', '지금 없는 계정의 비밀번호도 번들에서 받지 않는다');
  assert.equal(JSON.stringify(merged).includes('Bundle-'), false);
  // 반증 R7 — 번들이 두 키의 id 를 맞바꿔도(지문 · 원문은 그대로) id 는 지금 것(번들 id 가 **지금 다른 지문 키의 id** 일 때만 바꾼다) ·
  //   1회차 A6 — 이름도 지금 것(이름은 CSV os_key 가 고르는 열쇠다 · 복원은 OTP 를 묻지 않는다)
  const swap = JSON.parse(KS.redactKeyStoreText(cur).text);
  const bk = swap.keys.find((x) => x.id === k.id); const bo = swap.keys.find((x) => x.id === kOld.id);
  [bk.id, bo.id] = [bo.id, bk.id];
  bk.name = 'renamed-in-bundle';
  const m2 = JSON.parse(BUN.mergeRedactedKeyStore(JSON.stringify(swap), cur).text);
  const mk2 = m2.keys.find((x) => x.fingerprint === k.fingerprint);
  assert.deepEqual([mk2?.id, m2.keys.find((x) => x.fingerprint === kOld.fingerprint)?.id], [k.id, kOld.id], '맞바꾼 id 는 지금 것');
  assert.equal(mk2.name, k.name, '이름은 지금 것(1회차 A6)');
  // 1회차 D2 — 번들 id 가 지금 어느 키의 것도 아니면(같은 키를 지웠다 새 id 로 다시 등록한 설치에 옛 백업을 복원) **번들 id 그대로** — 번들 안의 참조(공통 계정 · 서버)가 이어진다
  //   (항상 지금 id 로 바꾸던 첫 수정은 정상 복원에서 참조를 조용히 끊었다). 공통 계정의 묶음 칸은 번들 값(지금 값으로 덮던 첫 수정을 되돌림 — 복원의 뜻).
  const oldBackup = JSON.parse(KS.redactKeyStoreText(cur).text);
  const ob = oldBackup.keys.find((x) => x.id === k.id);
  ob.id = 'k_0000000000d2';
  for (const a of oldBackup.accounts) if (a.id === acc.account.id) Object.assign(a, { username: 'root', corp: 'vcB', keyRef: 'k_0000000000d2' });
  oldBackup.accounts.push({ id: 'a_0000000000d2', name: 'd2-orphan', kind: 'os', corp: 'vcA', username: 'x', keyRef: 'k_ffffffffffff', password: '' });
  const m3 = BUN.mergeRedactedKeyStore(JSON.stringify(oldBackup), cur);
  const j3 = JSON.parse(m3.text);
  assert.equal(j3.keys.find((x) => x.fingerprint === k.fingerprint)?.id, 'k_0000000000d2', '번들 id 가 다른 키와 겹치지 않으면 번들 id 그대로(1회차 D2)');
  const a3 = j3.accounts.find((a) => a.id === acc.account.id);
  assert.deepEqual([a3.username, a3.corp, a3.keyRef, a3.password], ['root', 'vcB', 'k_0000000000d2', ''], '공통 계정 묶음 칸은 번들 값 · 계정명이 바뀌었으니 비밀번호는 받지 않는다(A4)');
  assert.ok(m3.dropped.includes('account:a4-acc'), JSON.stringify(m3.dropped));
  assert.equal(j3.accounts.find((a) => a.id === 'a_0000000000d2').keyRef, '', '합친 키에 없는 기본 키는 뗀다');
  assert.ok(m3.dropped.includes('account-key:d2-orphan'), `뗀 사실을 밝힌다(1회차 D2 — 조용히 비웠다) ${JSON.stringify(m3.dropped)}`);
  // 메모리의 키 원본이 공개키 ↔ 지문이 맞지 않으면(복원 · 손으로 고친 파일을 다시 읽은 뒤) 넣기 · 거두기 모두 붙기 전에 거절
  const j = JSON.parse(cur);
  for (const x of j.keys) if (x.id === k.id || x.id === kOld.id) x.publicKey = other;
  fs.writeFileSync(file, JSON.stringify(j));
  KS._resetKeyStoreForTest();
  try {
    assert.equal(KS.publicKeyMatches(KS.keyById(k.id)), false, '전제');
    const sv = mkServer('bm-a3', null, { host: '10.9.6.1', password: 'x' });
    for (const r of [await SVC.startKeyLogin({ servers: [sv], keyId: k.id, by: 'own' }), await SVC.startKeyRevoke({ keyId: k.id, servers: [sv], by: 'own' }), await SVC.startKeyRevoke({ keyId: k.id, corp: 'vcA', by: 'own' })]) {
      assert.deepEqual([r.ok, r.code, r.status, r.jobId], [false, 'key-tampered', 409, undefined], JSON.stringify(r));
    }
    // 옛 키(교체로 지울 키)의 공개키가 지문과 맞지 않아도 거절 — 남의 줄을 지울 수 있다
    const rp = await SVC.startKeyLogin({ servers: [sv], keyId: good.id, replaceKeyId: kOld.id, by: 'own' });
    assert.deepEqual([rp.code, rp.status, rp.jobId], ['key-tampered', 409, undefined], JSON.stringify(rp));
    assert.ok(BM.removeBmServer(sv.id).ok);
  } finally {
    // 사람이 파일을 고쳐 되돌렸다(공개키 칸만)
    const back = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const x of back.keys) { if (x.id === k.id) x.publicKey = k.publicKey; if (x.id === kOld.id) x.publicKey = kOld.publicKey; }
    fs.writeFileSync(file, JSON.stringify(back));
    KS._resetKeyStoreForTest();
  }
  assert.equal(KS.publicKeyMatches(KS.keyById(k.id)), true, '되돌렸다');
});

test('⑥-g 승인 요청은 요청 때의 상태에 묶인다 — 재개 요청 뒤 사용 중지가 다시 걸리면 옛 요청으로 풀지 않는다(stop-changed · 점검 A6) · 다시 읽기 요청 뒤 키 저장소 파일이 또 바뀌면 받아들이지 않는다(disk-changed · 점검 A5) · 둘 다 승인 사전 검사(OTP 앞)가 먼저 거른다(2회차 A5) · 이미 중지된 법인에 다시 걸면 기록 · 사건을 다시 쓰지 않는다(2회차 A2)', async () => {
  assert.ok((await SVC.stopCorp('vcB', { by: 'own', reason: '첫 사건' })).ok);
  const at1 = ST.stopFor('vcB').at;
  const rq = await SVC.resumeCorp('vcB', { by: 'own' });
  assert.deepEqual([rq.pending, rq.request.payload], [true, { corp: 'vcB', stopAt: at1 }], JSON.stringify(rq));
  await sleep(5);
  // 이미 중지된 법인에 다시 걸면 기록을 다시 쓰지 않는다(2회차 A2 — 사건만 쌓였다) · 시각 그대로 · 사건 없음
  const evStop = eventsOf('corp-stop').length;
  const again = await SVC.stopCorp('vcB', { by: 'own3', reason: '다시 걸기' });
  assert.deepEqual([again.ok, again.already, ST.stopFor('vcB').at, ST.stopFor('vcB').reason, eventsOf('corp-stop').length], [true, true, at1, '첫 사건', evStop], JSON.stringify(again));
  // 요청 뒤 다른 길(상태 파일 다시 읽기 · 손으로 고침)로 풀렸다가 새 사건으로 다시 걸린 중지 — 옛 요청은 그것을 풀지 않는다
  assert.ok(ST.clearCorpStop('vcB', { by: 'fixture' }).ok);
  assert.ok((await SVC.stopCorp('vcB', { by: 'own3', reason: '새 사건' })).ok);
  const at2 = ST.stopFor('vcB').at;
  assert.ok(at2 > at1);
  // 승인 사전 검사(OTP 앞)가 먼저 거른다(2회차 A5 — 예전에는 OTP 를 쓴 뒤 실행 단계에서 실패해 요청까지 버렸다) · 요청은 그대로 대기
  assert.deepEqual((({ code, status }) => [code, status])(SVC.approvalPrecheck(rq.request.id, { approve: true, by: 'own2', digest: rq.request.digest }) || {}), ['stop-changed', 409]);
  assert.equal(AP.getRequest(rq.request.id).status, 'pending');
  const ap = await SVC.decideApproval(rq.request.id, { approve: true, by: 'own2', digest: rq.request.digest });
  assert.deepEqual([ap.ok, ap.code, ap.request.status], [false, 'stop-changed', 'failed'], JSON.stringify(ap));
  assert.deepEqual([ST.stopFor('vcB')?.at, ST.stopFor('vcB')?.reason], [at2, '새 사건'], '새 중지는 그대로');
  const rq2 = await SVC.resumeCorp('vcB', { by: 'own' });
  assert.equal(rq2.request.payload.stopAt, at2);
  assert.equal((await SVC.decideApproval(rq2.request.id, { approve: true, by: 'own2', digest: rq2.request.digest })).ok, true, '지금 중지에 묶인 새 요청은 푼다');
  assert.equal(ST.stopFor('vcB'), null);
  // 키 저장소 다시 읽기 — 승인 직전에 파일이 또 바뀌면(값이 같아도 글자가 다르다 = 승인한 사람이 본 sha 가 아니다) 받아들이지 않는다
  const file = path.join(DIR, 'ssh-keys.json');
  const orig = fs.readFileSync(file, 'utf8');
  const rl = await SVC.reloadKeyStore({ by: 'own' });
  assert.deepEqual([rl.pending, rl.request.payload], [true, { sha: KS.diskFileSha() }]);
  const before = eventsOf('keystore-reloaded').length;
  fs.writeFileSync(file, `${orig}\n`);
  try {
    assert.deepEqual((({ code, status }) => [code, status])(SVC.approvalPrecheck(rl.request.id, { approve: true, by: 'own2', digest: rl.request.digest }) || {}), ['disk-changed', 409], '사전 검사(OTP 앞)도 같은 판정');
    const ap2 = await SVC.decideApproval(rl.request.id, { approve: true, by: 'own2', digest: rl.request.digest });
    assert.deepEqual([ap2.ok, ap2.code, ap2.request.status], [false, 'disk-changed', 'failed'], JSON.stringify(ap2));
    assert.equal(eventsOf('keystore-reloaded').length, before, '다시 읽지 않았다');
    assert.equal(KS.reloadKeyStoreFromDisk({ expectSha: '0'.repeat(64) }).code, 'disk-changed', '저장소 함수도 같은 판정');
  } finally { fs.writeFileSync(file, orig); }
  assert.equal(KS.diskFileSha(), rl.request.payload.sha);
});

test('⑥-h 보호 장치 — 한 요청에 켜기와 끄기가 섞였는데 끄기가 실패하면 켠 것이 이미 적용됐다고 밝힌다(partial.applied · guards — 점검 E-7)', async () => {
  assert.ok(ST.setGuards({ serverRestrict: false }, { by: 'fixture' }).ok);
  const first = await SVC.changeGuards({ twoPerson: false }, { by: 'own' });   // 끄기 요청(승인 대기)
  assert.equal(first.pending, true, JSON.stringify(first));
  // 같은 끄기 요청이 이미 있어 끄는 쪽은 409 — 켜는 쪽(serverRestrict)은 이미 적용됐다
  const r = await SVC.changeGuards({ serverRestrict: true, twoPerson: false }, { by: 'own2' });
  assert.deepEqual([r.ok, r.code, r.partial, r.guards], [false, 'dup-request', { applied: ['serverRestrict'] }, { twoPerson: true, serverRestrict: true, pairSeen: true }], `응답의 보호 장치에는 판정용 seenAd(AD 소유자 신원)를 싣지 않는다(2회차) ${JSON.stringify(r)}`);
  assert.equal('seenAd' in (await SVC.buildView()).guards, false, '화면 응답에도 싣지 않는다 — 상태 파일에는 남는다');
  assert.deepEqual(ST.getGuards(), { twoPerson: true, serverRestrict: true, pairSeen: true, seenAd: [] });
  // 켜기만 · 끄기만(요청 대기)에는 partial 이 없다
  assert.equal((await SVC.changeGuards({ serverRestrict: true }, { by: 'own2' })).partial, undefined);
  assert.equal((await SVC.decideApproval(first.request.id, { approve: false, by: 'own' })).request.status, 'cancelled');
  const off = await SVC.changeGuards({ serverRestrict: false }, { by: 'own' });
  assert.deepEqual([off.pending, off.partial], [true, undefined]);
  assert.equal((await SVC.decideApproval(off.request.id, { approve: false, by: 'own' })).request.status, 'cancelled');
  assert.deepEqual(ST.getGuards(), { twoPerson: true, serverRestrict: true, pairSeen: true, seenAd: [] });
});

test('⑥-i 승인자 셈(1회차 A1 · A2 · A3 · 반증 1 · 2 · 3) — AD 를 켠 설치에서 로그인할 수 없는 소유자 이름은 ‘쌍’ 을 세우지 않는다(로컬 계정 · 실제 승인 · AD 소유자가 화면에 들어온 세션이 증거) · 계정은 글자 그대로 찾고 목록도 글자 그대로 하나로 센다(대소문자를 가른다) · 쓰기 범위가 좁은 소유자는 승인자가 아니다 · 신원이 같은 두 계정(jkim@a · jkim@b)은 쌍이 아니다(서로 승인할 수 없다 — 혼자 끌 수 있다)',
  {}, () => {
    const AD = { AD_ENABLED: 'true', AD_URL: 'ldap://ad.example.invalid' };
    const tot = () => ({ totpEnabled: true, totpSecret: generateSecret() });
    // ① AD 켬 · 소유자 목록에 로컬 계정이 아닌 이름(퇴사자 · 오타 · 아직 없는 AD 계정) 하나 — 승인자로는 세지만(AD 일 수 있다) ‘쌍’ 은 세우지 않는다
    const a = subRun({ owners: 'admin,kim.left', users: [{ username: 'admin', role: 'admin', ...tot() }], env: AD, code: `
      const G = await imp('sshaccess/guards.js'); const ST = await imp('sshaccess/state.js'); const SVC = await imp('sshaccess/service.js');
      const approvers = G.approverNames(); const other = G.otherOwners('admin');
      G.notePair({ by: '' }); await SVC.buildView();
      const seen0 = ST.getGuards().pairSeen;
      const g = await SVC.changeGuards({ twoPerson: false }, { by: 'admin' });
      const d = await SVC.decideApproval(g.request.id, { approve: true, by: 'kim.left', digest: g.request.digest });
      console.log(JSON.stringify({ approvers, other, seen0, gPending: g.pending === true, dOk: d.ok, seen1: ST.getGuards().pairSeen,
        ev: ST.listEvents({ limit: 20 }).filter((e) => e.kind === 'guard-changed').map((e) => e.detail) }));` });
    assert.deepEqual([a.approvers, a.other, a.seen0], [['admin'], ['kim.left'], false], `로그인할 수 없을지 모르는 AD 이름 하나로 영영 잠기지 않는다(예전에는 pairSeen 이 섰다) ${JSON.stringify(a)}`);
    // AD 이름이 실제로 승인했다 = 승인할 수 있는 소유자가 둘이라는 증거 → 그때 쌍을 세운다
    assert.deepEqual([a.gPending, a.dOk, a.seen1], [true, true, true], JSON.stringify(a));
    assert.ok(a.ev.some((x) => /둘을 확인/.test(x)), JSON.stringify(a.ev));
    // ② AD 켬 · 정확 일치 · 쓰기 범위 — Bob(로컬은 bob) 는 세지 않고, writeVcenters 소유자(lim)도 세지 않고, 앞에 viewer ‘Kim’ 이 있어도 진짜 ‘kim’ 을 센다
    const b = subRun({ owners: 'own,Bob,lim,kim', env: AD, users: [{ username: 'own', role: 'admin', ...tot() }, { username: 'bob', role: 'admin', ...tot() },
      { username: 'lim', role: 'admin', ...tot(), scope: { writeVcenters: ['vcA'] } }, { username: 'Kim', role: 'viewer', ...tot() }, { username: 'kim', role: 'admin', ...tot() }], code: `
      const G = await imp('sshaccess/guards.js'); const ST = await imp('sshaccess/state.js');
      const other = G.otherOwners('own'); const approvers = G.approverNames(); G.notePair({ by: '' });
      console.log(JSON.stringify({ other, approvers, seen: ST.getGuards().pairSeen }));` });
    assert.deepEqual([b.other, b.approvers.sort(), b.seen], [['kim'], ['kim', 'own'], true], JSON.stringify(b));
    // ③ 신원 글자가 같은 두 로컬 계정 jkim@corp · jkim@subsidiary — 서로의 요청을 승인할 수 없다(자기 승인 판정과 같은 신원 — 막히는 쪽).
    //    그래서 ‘쌍’ 이 아니다 — 예전(1회차 수정)은 이름 둘로 쌍을 세워 둘 다 영영 끄지 못했다(반증 3). 지금은 혼자 끈다(승인자 0명 · 쌍 없음).
    const c = subRun({ owners: 'jkim@corp.example,jkim@subsidiary.example', users: [{ username: 'jkim@corp.example', role: 'admin', ...tot() }, { username: 'jkim@subsidiary.example', role: 'admin', ...tot() }], code: `
      const G = await imp('sshaccess/guards.js'); const ST = await imp('sshaccess/state.js'); const SVC = await imp('sshaccess/service.js');
      const approvers = G.approverNames(); G.notePair({ by: '' }); await SVC.buildView();
      const g = await SVC.changeGuards({ twoPerson: false }, { by: 'jkim@corp.example' });
      console.log(JSON.stringify({ approvers, seen: ST.getGuards().pairSeen, other: G.otherOwners('jkim@corp.example'), g: { ok: g.ok, code: g.code || '', pending: g.pending === true }, twoPerson: ST.getGuards().twoPerson }));` });
    assert.deepEqual([c.approvers.length, c.seen, c.other, c.g, c.twoPerson], [2, false, [], { ok: true, code: '', pending: false }, false], `신원이 같은 둘은 쌍이 아니다 — 영영 잠기지 않는다 ${JSON.stringify(c)}`);
    //    셋째(다른 신원) 로컬 승인자가 있으면 그때는 쌍이다 — jkim@corp 혼자 끄지 못하고 lee 의 승인을 기다린다
    const c2 = subRun({ owners: 'jkim@corp.example,jkim@subsidiary.example,lee', users: [{ username: 'jkim@corp.example', role: 'admin', ...tot() }, { username: 'jkim@subsidiary.example', role: 'admin', ...tot() }, { username: 'lee', role: 'admin', ...tot() }], code: `
      const G = await imp('sshaccess/guards.js'); const ST = await imp('sshaccess/state.js'); const SVC = await imp('sshaccess/service.js');
      G.notePair({ by: '' });
      const g = await SVC.changeGuards({ twoPerson: false }, { by: 'jkim@corp.example' });
      console.log(JSON.stringify({ seen: ST.getGuards().pairSeen, other: G.otherOwners('jkim@corp.example'), pending: g.pending === true, twoPerson: ST.getGuards().twoPerson }));` });
    assert.deepEqual([c2.seen, c2.other, c2.pending, c2.twoPerson], [true, ['lee'], true, true], JSON.stringify(c2));
    // ④ 목록은 글자 그대로 하나로 센다(반증 2) — 소유자 목록 own · kim · Kim 에서 kim 은 viewer, Kim 은 관리자(OTP) · requireSettingsOwner 를 통과하는 진짜 승인자다.
    //    예전에는 소문자로 먼저 접어 앞의 viewer kim 이 Kim 을 가렸다 → 승인자 [own] 뿐 · 쌍 없음 → own 혼자 껐다.
    const d4 = subRun({ owners: 'own,kim,Kim', users: [{ username: 'own', role: 'admin', ...tot() }, { username: 'kim', role: 'viewer', ...tot() }, { username: 'Kim', role: 'admin', ...tot() }], code: `
      const G = await imp('sshaccess/guards.js'); const ST = await imp('sshaccess/state.js'); const SVC = await imp('sshaccess/service.js');
      const approvers = G.approverNames(); const other = G.otherOwners('own'); G.notePair({ by: '' });
      const g = await SVC.changeGuards({ twoPerson: false }, { by: 'own' });
      console.log(JSON.stringify({ approvers, other, seen: ST.getGuards().pairSeen, pending: g.pending === true, twoPerson: ST.getGuards().twoPerson }));` });
    assert.deepEqual([d4.approvers.sort(), d4.other, d4.seen, d4.pending, d4.twoPerson], [['Kim', 'own'], ['Kim'], true, true, true], `대소문자만 다른 viewer 가 진짜 승인자를 가리지 않는다 ${JSON.stringify(d4)}`);
    // ⑤ AD 공동 소유자가 화면(GET /settings/ssh-access)에 들어온 세션 = 쌍의 증거(반증 1 — noteOwnerSession).
    //    AD 켬 · 소유자 own(로컬) · bob.ad(AD). 로컬 계정 own 이 들어온 것으로는 쌍이 아니다(로컬 승인자 하나). bob.ad 가 들어오면 쌍.
    //    그 뒤 own 이 목록에서 bob.ad 를 빼도(소유자 목록 저장은 본인 OTP 만) 혼자 끄지 못한다 — 같은 설정 폴더를 소유자 own 하나로 다시 띄워 본다.
    const e5 = subRun({ owners: 'own,bob.ad', env: AD, users: [{ username: 'own', role: 'admin', ...tot() }], code: `
      const G = await imp('sshaccess/guards.js'); const ST = await imp('sshaccess/state.js'); const SVC = await imp('sshaccess/service.js');
      G.notePair({ by: '' }); await SVC.buildView(); const s0 = ST.getGuards().pairSeen;
      SVC.noteOwnerSession('own'); const s1 = ST.getGuards().pairSeen;
      SVC.noteOwnerSession('bob.ad'); const s2 = ST.getGuards().pairSeen;
      console.log(JSON.stringify({ s0, s1, s2, same: SVC.noteOwnerSession === G.noteOwnerSession }));` });
    assert.deepEqual([e5.s0, e5.s1, e5.s2, e5.same], [false, false, true, true], JSON.stringify(e5));
    const e5b = subRun({ owners: 'own', env: AD, dir: e5.dir, users: [{ username: 'own', role: 'admin', ...tot() }], code: `
      const G = await imp('sshaccess/guards.js'); const ST = await imp('sshaccess/state.js'); const SVC = await imp('sshaccess/service.js');
      const g = await SVC.changeGuards({ twoPerson: false }, { by: 'own' });
      console.log(JSON.stringify({ other: G.otherOwners('own'), g: { ok: g.ok, code: g.code || '' }, twoPerson: ST.getGuards().twoPerson }));` });
    assert.deepEqual([e5b.other, e5b.g, e5b.twoPerson], [[], { ok: false, code: 'no-approver' }, true], `AD 소유자를 목록에서 빼고 혼자 끄는 길이 막힌다 ${JSON.stringify(e5b)}`);
    //    대조(A/B): AD 소유자가 들어온 적이 없으면 같은 순서로 혼자 끈다(소유자가 실제로 한 명인 설치가 잠기지 않게 — 이 길은 의도된 것)
    const e5c = subRun({ owners: 'own,bob.ad', env: AD, users: [{ username: 'own', role: 'admin', ...tot() }], code: `
      const G = await imp('sshaccess/guards.js'); const SVC = await imp('sshaccess/service.js'); G.notePair({ by: '' }); await SVC.buildView();
      console.log(JSON.stringify({ ok: true }));` });
    const e5d = subRun({ owners: 'own', env: AD, dir: e5c.dir, users: [{ username: 'own', role: 'admin', ...tot() }], code: `
      const ST = await imp('sshaccess/state.js'); const SVC = await imp('sshaccess/service.js');
      const g = await SVC.changeGuards({ twoPerson: false }, { by: 'own' });
      console.log(JSON.stringify({ ok: g.ok, twoPerson: ST.getGuards().twoPerson }));` });
    assert.deepEqual([e5d.ok, e5d.twoPerson], [true, false], JSON.stringify(e5d));
    // ⑥ 쌍이 아닌 세션: AD 꺼짐(로컬 계정이 아닌 이름은 세션이 생길 수 없다) · AD 사용자가 유일한 로컬 승인자와 같은 신원(CORP\\own — 자기 별칭) · 빈 이름
    const f6 = subRun({ owners: 'own,bob.ad', users: [{ username: 'own', role: 'admin', ...tot() }], code: `
      const G = await imp('sshaccess/guards.js'); const ST = await imp('sshaccess/state.js');
      G.noteOwnerSession('bob.ad'); G.noteOwnerSession('');
      console.log(JSON.stringify({ seen: ST.getGuards().pairSeen }));` });
    const f6b = subRun({ owners: 'own,CORP\\own', env: AD, users: [{ username: 'own', role: 'admin', ...tot() }], code: `
      const G = await imp('sshaccess/guards.js'); const ST = await imp('sshaccess/state.js');
      G.noteOwnerSession('CORP' + String.fromCharCode(92) + 'own'); G.noteOwnerSession('own@corp.example');
      console.log(JSON.stringify({ seen: ST.getGuards().pairSeen }));` });
    assert.deepEqual([f6.seen, f6b.seen], [false, false], `AD 꺼짐 · 자기 별칭 세션은 쌍의 증거가 아니다 ${JSON.stringify([f6, f6b])}`);
  });

/* ── 3. 줄 · 원격 스크립트(순수 akScript) — 실제 bash · dash ───────────────── */
const BK = F.ed25519Key();           // 빌더 시험용 키(저장소에 넣지 않는다)
const BPUB = pubOf(BK.pem); const BBLOB = BPUB.split(' ')[1];
const BID = 'k_0123456789ab'; const BMARK = `portal-ssh:${BID}`;
const OTHER = `${pubOf(F.ed25519Key().pem)} ops@bastion`;   // 다른 사람이 넣어 둔 줄

test('⑦ buildKeyLine · parseMarker · 싼 명령 — 제한 옵션 · 표식 · 틀린 출발지 주소 · 키 id · 공개키는 null · 작은따옴표가 들어갈 수 없다 · 표지는 마지막 ##KL 줄 · 명령은 base64 로 싼 /bin/sh 한 줄', () => {
  assert.equal(KL.buildKeyLine({ publicKey: BPUB, keyId: BID }), `${BPUB} ${BMARK}`);
  assert.equal(KL.buildKeyLine({ publicKey: `${BPUB} some comment`, keyId: BID }), `${BPUB} ${BMARK}`, '공개키의 설명은 버리고 표식을 단다');
  assert.equal(KL.buildKeyLine({ publicKey: BPUB, keyId: BID, restrict: true, fromIp: '10.20.30.40' }), `from="10.20.30.40",${RESTRICT} ${BPUB} ${BMARK}`);
  assert.equal(KL.buildKeyLine({ publicKey: BPUB, keyId: BID, restrict: true, fromIp: 'fd00::1' }), `from="fd00::1",${RESTRICT} ${BPUB} ${BMARK}`);
  assert.equal(KL.buildKeyLine({ publicKey: BPUB, keyId: BID, restrict: false, fromIp: '10.20.30.40' }), `${BPUB} ${BMARK}`, '제한이 꺼져 있으면 옵션이 없다');
  // 제한을 켰는데 출발지 주소가 없으면 줄을 만들지 않는다 — 제한 없는 줄로 대신 넣지 않는다(점검 뒤 판 — 예전에는 from= 없이 포워딩 금지만 붙였다)
  assert.equal(KL.buildKeyLine({ publicKey: BPUB, keyId: BID, restrict: true }), null);
  assert.equal(KL.buildKeyLine({ publicKey: BPUB, keyId: BID, restrict: true, fromIp: '' }), null);
  assert.deepEqual([...KL.RESTRICT_OPTIONS], RESTRICT.split(','));
  assert.equal(KL.markOf(BID), BMARK);
  assert.equal(AK.PORTAL_MARK, AKS.PORTAL_MARK, '표식 글자는 한 곳(akScript)에서');
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
  for (const o of [{}, { restrict: true, fromIp: '10.20.30.40' }, { restrict: true, fromIp: '::1' }]) {
    const line = KL.buildKeyLine({ publicKey: BPUB, keyId: BID, ...o });
    assert.equal(typeof line, 'string');
    assert.equal(/['\\\r\n]/.test(line), false, '작은따옴표 · 역슬래시 · 줄바꿈이 없다(스크립트의 작은따옴표 안에 그대로 끼운다)');
  }
  // installCommand — 줄이 그 키 · 그 표식의 줄이 아니거나 작은따옴표가 있으면 명령을 만들지 않는다
  const line = KL.buildKeyLine({ publicKey: BPUB, keyId: BID });
  assert.equal(KL.installCommand({ publicKey: BPUB, keyId: BID, line: `${OTHER.split(' ').slice(0, 2).join(' ')} ${BMARK}` }), null, '다른 공개키의 줄');
  assert.equal(KL.installCommand({ publicKey: BPUB, keyId: BID, line: `${BPUB} portal-ssh:k_ffffffffffff` }), null, '다른 표식의 줄');
  assert.equal(KL.installCommand({ publicKey: BPUB, keyId: BID, line: `command="echo 'x'" ${line}` }), null, '작은따옴표가 든 줄');
  assert.equal(KL.installCommand({ publicKey: BPUB, keyId: BID, line: `${line}\n${OTHER}` }), null, '줄바꿈이 든 줄');
  // 되돌림 명령 — 줄 · 바꾸기 전 줄(base64) 글자 검사
  assert.equal(KL.rollbackCommand({ line: `${line}'` }), null);
  assert.equal(KL.rollbackCommand({ line, oldB64: 'abc$(id)' }), null, 'base64 글자가 아니면');
  assert.equal(KL.rollbackCommand({ line, oldB64: 'A'.repeat(AKS.MAX_OLD_B64 + 1) }), null, '상한');
  // 싼 꼴 — 어느 로그인 셸에서도 같은 /bin/sh 로 돈다(점검 B-F10). 안의 스크립트 = akScript 의 순수 빌더 그대로 · 사본 파일(.portal-bak)이 없다(점검 B-F6)
  const wrapped = [KL.installCommand({ publicKey: BPUB, keyId: BID, line }), KL.removeCommand({ publicKey: BPUB, keyId: BID }), KL.rollbackCommand({ line, oldB64: Buffer.from(`${line}\n`).toString('base64') }), KL.WHOAMI_COMMAND];
  for (const c of wrapped) assert.match(c, WRAP_RE);
  assert.deepEqual(wrapped.map(scriptOf), [AKS.installScript({ publicKey: BPUB, keyId: BID, line }), AKS.removeScript({ publicKey: BPUB, keyId: BID }),
    AKS.rollbackScript({ line, oldB64: Buffer.from(`${line}\n`).toString('base64') }), AKS.WHOAMI_SCRIPT]);
  for (const s of wrapped.map(scriptOf)) assert.doesNotMatch(s, /portal-bak|cat "\$tmp" >|> "\$f"|>> "\$f"/, '자리에서 다시 쓰지 않는다 · 사본 파일 없음(mv 로만 바꾼다 — 점검 B-F1 · B-F6)');
  for (const gone of ['BACKUP_SUFFIX', 'RESTORE_COMMAND', 'DROP_BACKUP_COMMAND']) assert.equal(KL[gone], undefined, `${gone} 는 없앴다(사본 파일을 두지 않는다)`);
  // 접속 한 번의 시한 산수(세션을 실제로 끊는다 — withDeadline)
  assert.equal(KL.legDeadlineMs(1), KL.READY_TIMEOUT_MS + KL.STEP_TIMEOUT_MS + 5_000);
  assert.equal(KL.legDeadlineMs(2), KL.READY_TIMEOUT_MS + 2 * KL.STEP_TIMEOUT_MS + 5_000);
  assert.equal(KL.legDeadlineMs(0), KL.legDeadlineMs(1), 'exec 0 개여도 한 개만큼은 준다');
  assert.ok(KL.legDeadlineMs(2) > KL.READY_TIMEOUT_MS + 2 * KL.STEP_TIMEOUT_MS, '준비 + exec 시한 합보다 길다(exec 시한이 먼저 걸린다)');
  // 표지 — 마지막 ##KL 줄(로그인 배너가 앞에 섞여도) · 설치 계열은 표식 없는 줄(um) · 관리자 줄(cu) · 같은 줄(ex) · 우리 꼴이지만 다른 줄(loose) 수를 싣는다
  assert.deepEqual(KL.parseMarker('Welcome to bm-a1\nLast login: …\n##KL ip 10.0.0.9\n'), { kind: 'ip', ip: '10.0.0.9' });
  assert.deepEqual(KL.parseMarker('##KL ip 10.0.0.9"\n'), { kind: 'ip', ip: '' }, 'IP 꼴이 아니면 비운다(from= 에 쓰지 않는다)');
  assert.deepEqual(KL.parseMarker('##KL ip\n'), { kind: 'ip', ip: '' });
  assert.deepEqual(KL.parseMarker('##KL added\n##KL present-marked\n'), M('present-marked'), '마지막 줄 · 수가 없으면 0');
  assert.deepEqual(KL.parseMarker('motd\r\n  ##KL present-unmarked 2 0  \r\n'), M('present-unmarked', 2));
  assert.deepEqual(KL.parseMarker('##KL added 1 0\n'), M('added', 1));
  assert.deepEqual(KL.parseMarker('##KL present-marked 1 2 3 4\n'), M('present-marked', 1, 2, 3, 4));
  assert.deepEqual(KL.parseMarker('##KL present-marked -1 x 1.7\n'), M('present-marked', 0, 0, 1), '음수 · 글자는 0 · 소수는 내림');
  const ob = Buffer.from(`${line}\n`).toString('base64');
  assert.deepEqual(KL.parseMarker(`##KL replaced 1 0 ${ob}\n`), { kind: 'replaced', unmarked: 1, custom: 0, old: ob, otherId: 0 });
  assert.deepEqual([KL.parseMarker(`##KL replaced 1 0 ${ob} 2\n`).otherId, KL.parseMarker('##KL added 0 0 0 0 3\n'), KL.parseMarker('##KL present-unmarked 0 0 0 0 1\n')], [2, M('added', 0, 0, 0, 0, 3), M('present-unmarked', 0, 0, 0, 0, 1)], '다른 id 포탈 줄 수(3회차 B3-4)');
  assert.equal(KL.parseMarker('##KL replaced 0 0 a$b\n').old, null, 'base64 글자가 아니면 옛 줄을 받지 않는다(되돌림이 그 글을 다시 넣는다)');
  assert.equal(KL.parseMarker(`##KL replaced 0 0 ${'A'.repeat(AKS.MAX_OLD_B64 + 4)}\n`).old, null, '상한');
  assert.deepEqual(KL.parseMarker('##KL restored 2\n'), { kind: 'restored', removed: 2 });
  assert.deepEqual(KL.parseMarker('##KL removed 2 unmarked 1\n'), { kind: 'removed', removed: 2, unmarked: 1 });
  assert.deepEqual(KL.parseMarker('##KL none\n'), { kind: 'none' });
  for (const why of ['nohome', 'symlink', 'notdir', 'mkdir', 'notfile', 'unreadable', 'notwritable', 'read', 'write', 'verify', 'rename', 'nobase64', 'toolong', 'locked', 'raced', 'locklost', 'changed']) {
    assert.deepEqual(KL.parseMarker(`##KL fail ${why}\n`), { kind: 'fail', why }, why);
    assert.equal(typeof KL.failText(why), 'string');
    assert.notEqual(KL.failText(why), AKS.FAIL_TEXT.unknown, `${why} 에 맞는 문구`);
  }
  for (const why of ['constructor', '__proto__', 'toString', 'rewrite', '']) {
    assert.deepEqual(KL.parseMarker(`##KL fail ${why}\n`), { kind: 'fail', why: 'unknown' }, `모르는 사유 ${why} → unknown`);
    assert.equal(KL.failText(why), AKS.FAIL_TEXT.unknown, `프로토타입 이름이 문구에 실리지 않는다(${why})`);
  }
  for (const s of ['', 'added', 'x ##KL added', '##KLadded', '##KL whatever', null]) assert.deepEqual(KL.parseMarker(s), { kind: 'unknown' }, JSON.stringify(s));
  // 시작 표지만 있고 끝 표지가 없다 = 스크립트가 돌기 시작했는데 결과를 모른다(begun — 1회차 B5: 안쪽 셸만 신호로 죽거나 표지가 잘림). 끝 표지가 있으면 그것.
  assert.deepEqual(KL.parseMarker('motd\n##KL begin\n'), { kind: 'begun' });
  assert.deepEqual(KL.parseMarker('##KL begin\n##KL added 0 0\n'), M('added'));
  // 앞 잡음이 200KB 를 넘어도(로그인 셸 · .bashrc) 끝의 표지를 읽는다 — 끝에서 자른다(예전에는 앞 200KB 만 보아 ‘표지 없음 → 바꾼 것 없음’ 이었다)
  assert.deepEqual(KL.parseMarker(`${'x'.repeat(300_000)}\n##KL begin\n##KL removed 1 unmarked 0\n`), { kind: 'removed', removed: 1, unmarked: 0 });
  for (const shell of SHELLS) assert.deepEqual(sh(AKS.WHOAMI_SCRIPT, mkHome(), shell).m, { kind: 'ip', ip: '127.0.0.1' }, `서버가 본 출발지 = $SSH_CONNECTION 첫 칸(${shell})`);
  assert.deepEqual(sh(KL.WHOAMI_COMMAND, mkHome()).m, { kind: 'ip', ip: '127.0.0.1' }, '싼 한 줄도 같은 답');
});

test('⑧ installScript(실제 bash · dash) — 새로 더함 · 포탈 줄이 이미 있음 · 표식 없는 같은 키 줄이 있음 · 끝에 줄바꿈이 없는 파일 · 심볼릭 링크 · 폴더 · ~/.ssh 링크는 건드리지 않음 · 하드 링크로 이어진 파일은 그대로 · ~/.ssh 0700 · 파일 0600', () => {
  const line = KL.buildKeyLine({ publicKey: BPUB, keyId: BID, restrict: true, fromIp: '127.0.0.1' });
  const script = AKS.installScript({ publicKey: BPUB, keyId: BID, line });
  for (const shell of SHELLS) {
    const run = (h) => sh(script, h, shell);
    // ~/.ssh 도 파일도 없던 계정
    const h1 = mkHome(); const f1 = path.join(h1, '.ssh', 'authorized_keys');
    const a = run(h1);
    assert.deepEqual([a.m, a.code], [M('added'), 0], `${shell}: ${a.out}${a.err}`);
    assert.equal(fs.readFileSync(f1, 'utf8'), `${line}\n`);
    assert.deepEqual([modeOf(path.join(h1, '.ssh')), modeOf(f1)], [0o700, 0o600], '새로 만든 폴더 · 파일 권한');
    assert.deepEqual(fs.readdirSync(path.join(h1, '.ssh')), ['authorized_keys'], '임시 파일을 남기지 않는다');
    // 다시 — 같은 포탈 줄이 이미 있다(더하지 않는다 · ex=1)
    assert.deepEqual(run(h1).m, M('present-marked', 0, 0, 1, 0));
    assert.equal(fs.readFileSync(f1, 'utf8'), `${line}\n`, '두 번 넣지 않았다');
    // 표식 없는 같은 키 줄(사람이 직접 넣은 줄)이 있다 — 더하지 않고 그 수를 알린다 · 파일은 손대지 않는다(권한 · inode 그대로)
    const h2 = mkHome(); const f2 = path.join(h2, '.ssh', 'authorized_keys');
    fs.mkdirSync(path.join(h2, '.ssh'), { mode: 0o755 }); fs.chmodSync(path.join(h2, '.ssh'), 0o755);
    const manual = `${OTHER}\n${BPUB} admin@laptop\n`;
    fs.writeFileSync(f2, manual, { mode: 0o644 }); fs.chmodSync(f2, 0o644);
    const ino2 = fs.statSync(f2).ino;
    assert.deepEqual(run(h2).m, M('present-unmarked', 1));
    assert.deepEqual([fs.readFileSync(f2, 'utf8'), modeOf(f2), fs.statSync(f2).ino], [manual, 0o644, ino2]);
    // 표식은 있지만 다른 키의 줄 · 끝에 줄바꿈이 없는 파일 → 이 키의 포탈 줄이 아니다 · 앞 줄에 붙지 않게 줄바꿈을 넣는다
    const h3 = mkHome(); const f3 = path.join(h3, '.ssh', 'authorized_keys');
    fs.mkdirSync(path.join(h3, '.ssh'), { mode: 0o755 }); fs.chmodSync(path.join(h3, '.ssh'), 0o755);
    const noNl = `${OTHER.split(' ').slice(0, 2).join(' ')} ${BMARK}`;
    fs.writeFileSync(f3, noNl, { mode: 0o644 }); fs.chmodSync(f3, 0o644);
    const ino3 = fs.statSync(f3).ino;
    const d = run(h3);
    assert.deepEqual(d.m, M('added'), d.out + d.err);
    assert.equal(fs.readFileSync(f3, 'utf8'), `${noNl}\n${line}\n`);
    // 점검 B-F1 — 임시 파일에 다 쓰고 검증한 뒤 mv 로 바꾼다: inode 가 바뀌고 파일은 0600 이 된다(예전 판의 ‘자리에서 다시 쓰기 — inode · 권한 유지’ 기대를 뒤집음).
    //   폴더 권한은 그대로(이미 있던 ~/.ssh 를 바꾸지 않는다).
    assert.deepEqual([modeOf(path.join(h3, '.ssh')), modeOf(f3)], [0o755, 0o600]);
    assert.notEqual(fs.statSync(f3).ino, ino3, 'mv 로 바꿨다(inode 가 바뀐다)');
    assert.deepEqual(fs.readdirSync(path.join(h3, '.ssh')), ['authorized_keys']);
    // 빈 파일 — 줄바꿈을 앞에 넣지 않는다
    const h4 = mkHome(); const f4 = path.join(h4, '.ssh', 'authorized_keys');
    fs.mkdirSync(path.join(h4, '.ssh')); fs.writeFileSync(f4, '');
    assert.deepEqual(run(h4).m, M('added'));
    assert.equal(fs.readFileSync(f4, 'utf8'), `${line}\n`);
    // 심볼릭 링크 — 건드리지 않는다(가리키는 파일도 그대로)
    const h5 = mkHome(); const f5 = path.join(h5, '.ssh', 'authorized_keys'); const target = path.join(h5, 'elsewhere');
    fs.mkdirSync(path.join(h5, '.ssh')); fs.writeFileSync(target, `${OTHER}\n`); fs.symlinkSync(target, f5);
    const e = run(h5);
    assert.deepEqual([e.m, e.code], [{ kind: 'fail', why: 'symlink' }, 3]);
    assert.deepEqual([fs.readFileSync(target, 'utf8'), fs.lstatSync(f5).isSymbolicLink()], [`${OTHER}\n`, true], '링크가 가리키는 파일에 쓰지 않았다');
    // 끊어진 링크(가리키는 파일이 없다)도 같다 — 링크를 따라가 새 파일을 만들지 않는다
    const h6 = mkHome(); const f6 = path.join(h6, '.ssh', 'authorized_keys'); const gone = path.join(h6, 'not-there');
    fs.mkdirSync(path.join(h6, '.ssh')); fs.symlinkSync(gone, f6);
    assert.deepEqual(run(h6).m, { kind: 'fail', why: 'symlink' });
    assert.equal(fs.existsSync(gone), false);
    // 일반 파일이 아니다(폴더)
    const h7 = mkHome(); fs.mkdirSync(path.join(h7, '.ssh', 'authorized_keys'), { recursive: true });
    assert.deepEqual(run(h7).m, { kind: 'fail', why: 'notfile' });
    // ~/.ssh 가 링크 · ~/.ssh 가 파일 — 건드리지 않는다
    const h8 = mkHome(); const real = path.join(h8, 'real-ssh'); fs.mkdirSync(real); fs.writeFileSync(path.join(real, 'authorized_keys'), `${OTHER}\n`);
    fs.symlinkSync(real, path.join(h8, '.ssh'));
    assert.deepEqual(run(h8).m, { kind: 'fail', why: 'symlink' });
    assert.equal(fs.readFileSync(path.join(real, 'authorized_keys'), 'utf8'), `${OTHER}\n`);
    const h9 = mkHome(); fs.writeFileSync(path.join(h9, '.ssh'), 'not a dir');
    assert.deepEqual(run(h9).m, { kind: 'fail', why: 'notdir' });
    // 하드 링크 — authorized_keys 만 바뀌고 이어져 있던 다른 파일(다른 계정 등)은 그대로(mv 는 그 이름만 바꾼다 — 점검 B-F10 하드 링크 관찰)
    const h10 = mkHome(); const f10 = path.join(h10, '.ssh', 'authorized_keys'); const peer = path.join(h10, 'peer_keys');
    fs.mkdirSync(path.join(h10, '.ssh')); fs.writeFileSync(f10, `${OTHER}\n`); fs.linkSync(f10, peer);
    assert.equal(fs.statSync(peer).nlink, 2, '전제 — 하드 링크');
    assert.deepEqual(run(h10).m, M('added'));
    assert.deepEqual([fs.readFileSync(f10, 'utf8'), fs.readFileSync(peer, 'utf8'), fs.statSync(peer).nlink], [`${OTHER}\n${line}\n`, `${OTHER}\n`, 1]);
  }
  // 싼 한 줄(가짜 sshd 가 받는 꼴)도 같은 결과
  const hw = mkHome();
  assert.deepEqual(sh(KL.installCommand({ publicKey: BPUB, keyId: BID, line }), hw).m, M('added'));
  assert.equal(fs.readFileSync(path.join(hw, '.ssh', 'authorized_keys'), 'utf8'), `${line}\n`);
});

test('⑨ removeScript(실제 bash · dash) — 그 공개키 + 포탈 표식이 함께 있는 줄만 지운다(키 id 는 가리지 않는다) · 남의 줄 · 표식 없는 같은 키 줄은 남긴다(수를 알린다) · 파일 없음 = none · 링크는 실패로 말한다 · 하드 링크는 그대로', () => {
  const rm = AKS.removeScript({ publicKey: BPUB, keyId: BID });
  const otherMarked = `${OTHER.split(' ').slice(0, 2).join(' ')} ${BMARK}`;          // 표식은 같지만 다른 공개키 — 남긴다
  // 같은 공개키 · 다른 키 id 의 포탈 표식 — 같은 키다(지웠다 다시 등록해 id 만 바뀐 키 · 반증 R10). 예전 판은 남겨 거둔 뒤에도 그 키로 들어갔다 → 이제 지운다.
  const sameKeyOtherMark = `${BPUB} portal-ssh:k_ffffffffffff`;
  const keep = ['# 사람이 적은 주석', OTHER, `${BPUB} admin@laptop`, otherMarked, `command="/usr/bin/true" ${OTHER.split(' ').slice(0, 2).join(' ')} backup`, `${BPUB} not-portal-ssh:k_x`];
  const gone = [`from="10.0.0.5",${RESTRICT} ${BPUB} ${BMARK}`, `${BPUB} ${BMARK}`, sameKeyOtherMark];
  for (const shell of SHELLS) {
    const h = mkHome(); const f = path.join(h, '.ssh', 'authorized_keys');
    fs.mkdirSync(path.join(h, '.ssh'), { mode: 0o700 });
    // 앞 공백 · 끝 CR 이 붙은 포탈 줄도 그 줄이다(awk 판정 — 점검 B-F2a)
    fs.writeFileSync(f, `${[keep[0], keep[1], gone[0], keep[2], keep[3], `  ${gone[1]}\r`, gone[2], keep[4], keep[5]].join('\n')}\n`, { mode: 0o640 }); fs.chmodSync(f, 0o640);
    const ino = fs.statSync(f).ino;
    const a = sh(rm, h, shell);
    assert.deepEqual([a.m, a.code], [{ kind: 'removed', removed: 3, unmarked: 2 }, 0], `${shell}: ${a.out}${a.err}`);
    assert.equal(fs.readFileSync(f, 'utf8'), `${keep.join('\n')}\n`, '남의 줄 · 표식 없는 같은 키 줄 · 주석은 순서대로 그대로');
    // 점검 B-F1 — mv 로 바꾼다: inode 가 바뀌고 0600(예전 판의 ‘inode · 권한 유지’ 기대를 뒤집음)
    assert.notEqual(fs.statSync(f).ino, ino);
    assert.equal(modeOf(f), 0o600);
    assert.deepEqual(fs.readdirSync(path.join(h, '.ssh')), ['authorized_keys'], '임시 파일을 남기지 않는다');
    // 다시 — 지울 것이 없다(표식 없는 줄 수는 그대로 알린다) · 파일을 다시 쓰지 않는다
    const ino2 = fs.statSync(f).ino;
    assert.deepEqual(sh(rm, h, shell).m, { kind: 'removed', removed: 0, unmarked: 2 });   // ‘admin@laptop’ · ‘not-portal-ssh:’ 줄
    assert.deepEqual([fs.readFileSync(f, 'utf8'), fs.statSync(f).ino], [`${keep.join('\n')}\n`, ino2]);
    // 포탈 줄만 있던 파일 — 빈 파일로 남는다(파일을 지우지 않는다)
    const h2 = mkHome(); const f2 = path.join(h2, '.ssh', 'authorized_keys');
    fs.mkdirSync(path.join(h2, '.ssh')); fs.writeFileSync(f2, `${gone[0]}\n`);
    assert.deepEqual(sh(rm, h2, shell).m, { kind: 'removed', removed: 1, unmarked: 0 });
    assert.equal(fs.readFileSync(f2, 'utf8'), '');
    // 파일이 없다 · ~/.ssh 가 없다 — 이때만 none
    assert.deepEqual(sh(rm, mkHome(), shell).m, { kind: 'none' });
    // 심볼릭 링크 — 가리키는 파일을 고치지 않고 **실패**로 말한다(점검 B-F2b — 예전 판은 ‘none(파일 없음)’ 이라 거두기가 성공처럼 끝나고 키는 계속 들어갔다)
    const h3 = mkHome(); const f3 = path.join(h3, '.ssh', 'authorized_keys'); const target = path.join(h3, 'elsewhere');
    fs.mkdirSync(path.join(h3, '.ssh')); fs.writeFileSync(target, `${gone[1]}\n`); fs.symlinkSync(target, f3);
    const s3 = sh(rm, h3, shell);
    assert.deepEqual([s3.m, s3.code], [{ kind: 'fail', why: 'symlink' }, 3]);
    assert.equal(fs.readFileSync(target, 'utf8'), `${gone[1]}\n`);
    // ~/.ssh 가 링크여도 실패
    const h3b = mkHome(); const real = path.join(h3b, 'real-ssh'); fs.mkdirSync(real); fs.writeFileSync(path.join(real, 'authorized_keys'), `${gone[1]}\n`);
    fs.symlinkSync(real, path.join(h3b, '.ssh'));
    assert.deepEqual(sh(rm, h3b, shell).m, { kind: 'fail', why: 'symlink' });
    // 하드 링크 — authorized_keys 에서만 지워지고 이어진 파일은 그대로
    const h5 = mkHome(); const f5 = path.join(h5, '.ssh', 'authorized_keys'); const peer = path.join(h5, 'peer_keys');
    fs.mkdirSync(path.join(h5, '.ssh')); fs.writeFileSync(f5, `${OTHER}\n${gone[1]}\n`); fs.linkSync(f5, peer);
    assert.deepEqual(sh(rm, h5, shell).m, { kind: 'removed', removed: 1, unmarked: 0 });
    assert.deepEqual([fs.readFileSync(f5, 'utf8'), fs.readFileSync(peer, 'utf8')], [`${OTHER}\n`, `${OTHER}\n${gone[1]}\n`]);
    // 넣기 → 거두기 왕복 — 파일이 처음 그대로 돌아온다
    const h4 = mkHome(); const f4 = path.join(h4, '.ssh', 'authorized_keys');
    fs.mkdirSync(path.join(h4, '.ssh')); fs.writeFileSync(f4, `${OTHER}\n${BPUB} admin@laptop\n`);
    const pubO = OTHER.split(' ').slice(0, 2).join(' ');
    const lineA = KL.buildKeyLine({ publicKey: pubO, keyId: 'k_aaaaaaaaaaaa', restrict: true, fromIp: '127.0.0.1' });
    assert.deepEqual(sh(AKS.installScript({ publicKey: pubO, keyId: 'k_aaaaaaaaaaaa', line: lineA }), h4, shell).m, M('present-unmarked', 1), '이미 있는 키(표식 없음)');
    const lineB = KL.buildKeyLine({ publicKey: BPUB, keyId: 'k_bbbbbbbbbbbb' });
    assert.deepEqual(sh(AKS.installScript({ publicKey: BPUB, keyId: 'k_bbbbbbbbbbbb', line: lineB }), h4, shell).m, M('present-unmarked', 1));
    const K3 = pubOf(F.ed25519Key().pem); const line3 = KL.buildKeyLine({ publicKey: K3, keyId: 'k_cccccccccccc', restrict: true, fromIp: '127.0.0.1' });
    assert.deepEqual(sh(AKS.installScript({ publicKey: K3, keyId: 'k_cccccccccccc', line: line3 }), h4, shell).m, M('added'));
    assert.deepEqual(sh(AKS.removeScript({ publicKey: K3, keyId: 'k_cccccccccccc' }), h4, shell).m, { kind: 'removed', removed: 1, unmarked: 0 });
    assert.equal(fs.readFileSync(f4, 'utf8'), `${OTHER}\n${BPUB} admin@laptop\n`);
  }
});

test('⑨-b 파일 어딘가에 NUL 바이트가 있어도 — 거두기 · 넣기 판정이 줄을 놓치지 않는다(awk 판정 · NUL 줄은 그대로 남긴다 — 점검 B-F2a: grep 은 바이너리로 보고 줄을 숨겨 ‘포탈 줄 없음’ 으로 끝났다)', () => {
  const portal = `${BPUB} ${BMARK}`;
  const nulLine = `ssh-ed25519 AAAA\u0000broken-by-power-loss`;
  for (const shell of SHELLS) {
    const h = mkHome(); const f = path.join(h, '.ssh', 'authorized_keys');
    fs.mkdirSync(path.join(h, '.ssh'), { mode: 0o700 });
    fs.writeFileSync(f, `${OTHER}\n${nulLine}\n${portal}\n${BPUB} admin@laptop\n`);
    // 넣기 — 같은 포탈 줄이 있다고 읽는다(예전 판은 없다고 읽고 또 더했다)
    assert.deepEqual(sh(AKS.installScript({ publicKey: BPUB, keyId: BID, line: portal }), h, shell).m, M('present-marked', 1, 0, 1, 0), shell);
    // 거두기 — 포탈 줄을 지운다 · NUL 줄 · 남의 줄 · 표식 없는 같은 키 줄은 바이트 그대로
    const r = sh(AKS.removeScript({ publicKey: BPUB, keyId: BID }), h, shell);
    assert.deepEqual(r.m, { kind: 'removed', removed: 1, unmarked: 1 }, `${shell}: ${r.out}${r.err}`);
    assert.equal(fs.readFileSync(f, 'utf8'), `${OTHER}\n${nulLine}\n${BPUB} admin@laptop\n`);
    // 되돌림(더한 줄 지우기)도 같은 판정
    fs.writeFileSync(f, `${nulLine}\n${portal}\n`);
    assert.deepEqual(sh(AKS.rollbackScript({ line: portal }), h, shell).m, { kind: 'restored', removed: 1 });
    assert.equal(fs.readFileSync(f, 'utf8'), `${nulLine}\n`);
  }
});

test('⑨-c 쓰기가 중간에 실패해도 원래 파일은 그대로 — busybox 처럼 잘린 채 0 을 돌려주는 awk · 쓰기 오류(종료 2) · mv 실패: 넣기 · 바꾸기 · 거두기 · 되돌림 모두 fail(verify · write · rename) · 임시 파일 없음(점검 B-F1)', () => {
  const lineNew = KL.buildKeyLine({ publicKey: BPUB, keyId: BID, restrict: true, fromIp: '127.0.0.1' });
  const loose = `${BPUB} ${BMARK}`;
  const other5 = Array.from({ length: 5 }, () => `${pubOf(F.ed25519Key().pem)} someone@host`);
  const cases = [
    ['넣기', AKS.installScript({ publicKey: BPUB, keyId: BID, line: lineNew }), `${other5.join('\n')}\n`],
    ['바꾸기', AKS.installScript({ publicKey: BPUB, keyId: BID, line: lineNew, replace: true }), `${other5.slice(0, 3).join('\n')}\n${loose}\n${other5.slice(3).join('\n')}\n`],
    ['거두기', AKS.removeScript({ publicKey: BPUB, keyId: BID }), `${other5.slice(0, 2).join('\n')}\n${loose}\n${other5.slice(2).join('\n')}\n`],
    ['되돌림', AKS.rollbackScript({ line: lineNew, oldB64: Buffer.from(`${loose}\n`).toString('base64') }), `${other5.join('\n')}\n${lineNew}\n`],
  ];
  const binTrunc = fakeBin('trunc'); const binExit2 = fakeBin('exit2'); const binMv = fakeBin('mvfail');
  for (const shell of SHELLS) {
    for (const [name, script, body] of cases) {
      for (const [bin, why] of [[binTrunc, 'verify'], [binExit2, 'write'], [binMv, 'rename']]) {
        const h = mkHome(); const f = path.join(h, '.ssh', 'authorized_keys');
        fs.mkdirSync(path.join(h, '.ssh'), { mode: 0o700 }); fs.writeFileSync(f, body, { mode: 0o600 });
        const ino = fs.statSync(f).ino;
        const r = sh(script, h, shell, { PATH: bin });
        assert.deepEqual([r.m, r.code], [{ kind: 'fail', why }, 3], `${shell} ${name} ${why}: ${r.out}${r.err}`);
        assert.deepEqual([fs.readFileSync(f, 'utf8'), fs.statSync(f).ino], [body, ino], `${shell} ${name} ${why} — 원래 파일 그대로(예전 판은 0 바이트가 되거나 포탈 줄만 남았다)`);
        assert.deepEqual(fs.readdirSync(path.join(h, '.ssh')), ['authorized_keys'], `${shell} ${name} ${why} — 임시 파일을 남기지 않는다`);
        assert.equal(KL.failText(why).includes('원래 파일은 그대로'), true, '문구도 그렇게 말한다');
      }
      // 같은 스크립트 · 정상 awk 면 성공한다(가짜 awk 가 실패의 원인임을 확인)
      const h = mkHome(); const f = path.join(h, '.ssh', 'authorized_keys');
      fs.mkdirSync(path.join(h, '.ssh'), { mode: 0o700 }); fs.writeFileSync(f, body, { mode: 0o600 });
      assert.notEqual(sh(script, h, shell).m.kind, 'fail', `${shell} ${name} — 정상 awk`);
    }
  }
});

test('⑨-d 관리자가 옵션을 바꾼 포탈 줄(command= · restrict · expiry-time 등)은 바꾸지 않는다 — ‘다시 넣기’ 가 더 조인 줄을 덜 엄한 줄로 풀지 않는다(cu 로 세어 알린다 — 점검 B-F4)', () => {
  const want = KL.buildKeyLine({ publicKey: BPUB, keyId: BID, restrict: true, fromIp: '127.0.0.1' });
  const loose = `${BPUB} ${BMARK}`;
  const customs = [`command="/usr/local/bin/only-uname",from="10.0.0.0/24",restrict ${BPUB} ${BMARK}`, `restrict ${BPUB} ${BMARK}`, `expiry-time="20991231",from="10.0.0.5",${RESTRICT} ${BPUB} ${BMARK}`,
    // 아래 셋 — 우리 꼴처럼 보여도 from= 이 주소 하나가 아니면(대역 · 여러 주소 · 와일드카드) 관리자가 넓힌 줄이다(반증 R9 — 예전에는 덮어썼다)
    `from="10.0.0.0/24",${RESTRICT} ${BPUB} ${BMARK}`, `from="10.0.0.5,10.0.0.6",${RESTRICT} ${BPUB} ${BMARK}`, `from="*",${RESTRICT} ${BPUB} ${BMARK}`];
  for (const shell of SHELLS) {
    for (const custom of customs) {
      const h = mkHome(); const f = path.join(h, '.ssh', 'authorized_keys');
      fs.mkdirSync(path.join(h, '.ssh'), { mode: 0o700 });
      const body = `${OTHER}\n${custom}\n${loose}\n`;   // 관리자 줄 하나 + 제한 없는 우리 꼴 줄 하나
      fs.writeFileSync(f, body);
      const r = sh(AKS.installScript({ publicKey: BPUB, keyId: BID, line: want, replace: true }), h, shell);
      assert.deepEqual(r.m, M('present-marked', 0, 1, 0, 1), `${shell} ${custom.slice(0, 30)}: ${r.out}${r.err}`);
      assert.equal(fs.readFileSync(f, 'utf8'), body, '관리자 줄이 하나라도 있으면 아무 줄도 바꾸지 않는다');
    }
    // 우리 꼴(옵션 없음 · from= + 포워딩 금지 세 가지)만 있으면 바꾼다 — 바꾸기 전 줄은 base64 로 돌려준다(되돌림이 다시 넣는다)
    const h = mkHome(); const f = path.join(h, '.ssh', 'authorized_keys');
    fs.mkdirSync(path.join(h, '.ssh'), { mode: 0o700 });
    const old2 = `from="10.1.1.1",${RESTRICT} ${BPUB} ${BMARK}`;
    fs.writeFileSync(f, `${OTHER}\n${loose}\n${BPUB} admin@laptop\n${old2}\n`);
    const r = sh(AKS.installScript({ publicKey: BPUB, keyId: BID, line: want, replace: true }), h, shell);
    assert.equal(r.m.kind, 'replaced', r.out + r.err);
    assert.deepEqual([r.m.unmarked, r.m.custom, Buffer.from(r.m.old, 'base64').toString('utf8')], [1, 0, `${loose}\n${old2}\n`]);
    assert.equal(fs.readFileSync(f, 'utf8'), `${OTHER}\n${BPUB} admin@laptop\n${want}\n`);
    // 바꾸기를 고르지 않으면(replace 없음) 우리 꼴의 다른 줄이 있어도 그대로(present-marked · loose 수)
    fs.writeFileSync(f, `${loose}\n`);
    assert.deepEqual(sh(AKS.installScript({ publicKey: BPUB, keyId: BID, line: want }), h, shell).m, M('present-marked', 0, 0, 0, 1));
    assert.equal(fs.readFileSync(f, 'utf8'), `${loose}\n`);
  }
});

test('⑨-e 되돌림은 우리 줄만 — 더한 그 줄(글자 그대로)만 지우고 바꾸기 전 포탈 줄을 다시 넣는다 · 그 줄이 이미 없으면 아무것도 하지 않는다(사람이 그 사이 고친 것을 버리거나 지운 줄을 되살리지 않는다 — 점검 B-F6)', () => {
  const ours = KL.buildKeyLine({ publicKey: BPUB, keyId: BID, restrict: true, fromIp: '127.0.0.1' });
  const old = `${BPUB} ${BMARK}`;
  const newcomer = `${pubOf(F.ed25519Key().pem)} added-by-human`;
  const oldB64 = Buffer.from(`${old}\n`).toString('base64');
  for (const shell of SHELLS) {
    const h = mkHome(); const f = path.join(h, '.ssh', 'authorized_keys');
    fs.mkdirSync(path.join(h, '.ssh'), { mode: 0o700 });
    // 바꾼 뒤 사람이 새 줄을 더했다 → 우리 줄만 지우고 옛 줄을 다시 넣는다(새 줄은 남는다 — 예전 판은 사본으로 파일 전체를 되써 새 줄이 사라졌다)
    fs.writeFileSync(f, `${OTHER}\n${ours}\n${newcomer}\n`);
    assert.deepEqual(sh(AKS.rollbackScript({ line: ours, oldB64 }), h, shell).m, { kind: 'restored', removed: 1 }, shell);
    assert.equal(fs.readFileSync(f, 'utf8'), `${OTHER}\n${newcomer}\n${old}\n`);
    // 사람이 우리 줄을 이미 지웠다(유출 키 정리) → 아무것도 하지 않는다 · 옛 줄을 되살리지 않는다
    fs.writeFileSync(f, `${OTHER}\n${newcomer}\n`);
    const ino = fs.statSync(f).ino;
    assert.deepEqual(sh(AKS.rollbackScript({ line: ours, oldB64 }), h, shell).m, { kind: 'restored', removed: 0 });
    assert.deepEqual([fs.readFileSync(f, 'utf8'), fs.statSync(f).ino], [`${OTHER}\n${newcomer}\n`, ino], '파일을 다시 쓰지도 않았다');
    // 더하기였으면(옛 줄 없음) 그 줄만 지운다 · 앞 공백 · 끝 CR 이 붙어도 같은 줄
    fs.writeFileSync(f, `${OTHER}\n  ${ours}\r\n${newcomer}\n`);
    assert.deepEqual(sh(AKS.rollbackScript({ line: ours }), h, shell).m, { kind: 'restored', removed: 1 });
    assert.equal(fs.readFileSync(f, 'utf8'), `${OTHER}\n${newcomer}\n`);
    // 글자가 하나라도 다른 줄(사람이 옵션을 고친 줄)은 우리 줄이 아니다
    const edited = ours.replace('no-X11-forwarding', 'no-X11-forwarding,no-pty');
    fs.writeFileSync(f, `${edited}\n`);
    assert.deepEqual(sh(AKS.rollbackScript({ line: ours, oldB64 }), h, shell).m, { kind: 'restored', removed: 0 });
    assert.equal(fs.readFileSync(f, 'utf8'), `${edited}\n`);
    // 파일이 없으면 none · 링크면 실패
    fs.rmSync(f);
    assert.deepEqual(sh(AKS.rollbackScript({ line: ours }), h, shell).m, { kind: 'none' });
    fs.symlinkSync(path.join(h, 'x'), f);
    assert.deepEqual(sh(AKS.rollbackScript({ line: ours }), h, shell).m, { kind: 'fail', why: 'symlink' });
  }
});

test('⑨-f 서버 쪽 자물쇠 · 바꾼 뒤 확인 · 읽기 전용 · 신호(실제 bash · dash) — 주인이 살아 있는 자물쇠는 기다리다 fail locked · 지울 것이 없는 거두기 · 되돌림은 자물쇠 없이 답한다(있으면 자물쇠 안에서 다시 본다) · 주인 없는 자물쇠(죽은 pid · 10분 넘은 표 · 처음 본 때부터 5초 표 없음)만 치운다 · 경합 아닌 mkdir 실패는 기다리지 않는다(쓸 수 없는 폴더 notwritable · 그 밖은 몇 번 다시 한 뒤 write) · 주인 표를 못 쓰면 자물쇠를 남기지 않고 write · c0 는 분류 전 · mv 뒤 다시 읽어 원하는 상태가 아니면 fail raced · root 여도 444 는 notwritable(ls) · 신호로 끊겨도 임시 파일 · 자물쇠를 남기지 않는다(반증 R1 · R8 · R11 · 1회차 B1 · B2 · B3 · B4 · 1회차 반증 5 · 6 · 7 · 8)', async () => {
  const line = KL.buildKeyLine({ publicKey: BPUB, keyId: BID });
  const add = AKS.installScript({ publicKey: BPUB, keyId: BID, line });
  const rm = AKS.removeScript({ publicKey: BPUB, keyId: BID });
  const binNoSleep = fakeBin('nosleep'); const binRace = fakeBin('race'); const binLock = fakeBin('lockhooks');
  const mk = (body, mode = 0o600) => {
    const h = mkHome(); fs.mkdirSync(path.join(h, '.ssh'), { mode: 0o700 });
    const f = path.join(h, '.ssh', 'authorized_keys'); fs.writeFileSync(f, body); fs.chmodSync(f, mode);
    return { h, f, lk: path.join(h, '.ssh', '.authorized_keys.portal.lock') };
  };
  for (const shell of SHELLS) {
    // 자물쇠(1회차 B1) — 안에 주인 표(호스트:pid:시각)가 있다. 남은 자물쇠는 주인이 없을 때만 치운다(예전 판은 2분 지난 것을 주인 확인 없이 치웠다).
    const owner = (lk, tok) => { fs.mkdirSync(lk, { recursive: true }); fs.writeFileSync(path.join(lk, 'owner'), `${tok}\n`); };
    const nowS = () => Math.floor(Date.now() / 1000);
    const deadPid = spawnSync('true').pid;   // 방금 끝난 프로세스 — 이 호스트에 없는 pid
    const liveTok = `${HOSTID}:${process.pid}:${nowS()}`;   // 스크립트와 같은 호스트 식별(이름/부팅 id/pid 이름공간 — 2회차 B2)
    const rb = AKS.rollbackScript({ line });
    // ① 이 호스트의 살아 있는 주인(이 테스트 프로세스)이 쥐고 있다 → 바꿀 것이 있으면 15번 기다리다 locked · 파일 · 남의 자물쇠(표 포함) 그대로
    const a = mk(`${OTHER}\n`); const a1 = mk(`${OTHER}\n${line}\n`);
    owner(a.lk, liveTok); owner(a1.lk, liveTok);
    for (const [sc, x] of [[add, a], [rm, a1], [rb, a1]]) {
      const r = sh(sc, x.h, shell, { PATH: binNoSleep });
      assert.deepEqual([r.m, r.code], [{ kind: 'fail', why: 'locked' }, 3], `${shell}: ${r.out}${r.err}`);
    }
    assert.deepEqual([fs.readFileSync(a.f, 'utf8'), fs.readFileSync(a1.f, 'utf8'), fs.readFileSync(path.join(a.lk, 'owner'), 'utf8')], [`${OTHER}\n`, `${OTHER}\n${line}\n`, `${liveTok}\n`], '남의 자물쇠 · 파일 그대로');
    // ①-b 바꿀 것이 없어도(그 줄 없음 · 파일 없음 · 이미 있음) **자물쇠 폴더가 있으면** 빠른 답을 내지 않고 자물쇠를 기다려 안에서 다시 본다(2회차 B — 진행 중인 넣기가
    //      아직 mv 하지 않은 때 ‘없음’ 으로 끝나면 거두기 뒤에 키가 들어갔다). 주인이 살아 있으면 끝까지 기다려 locked. 자물쇠가 없으면 빠른 답(④-d — 쓸 수 없는 ~/.ssh).
    const a0 = mk(''); fs.rmSync(a0.f); owner(a0.lk, liveTok);
    assert.deepEqual([sh(rm, a.h, shell, { PATH: binNoSleep }).m, sh(rb, a.h, shell, { PATH: binNoSleep }).m, sh(rm, a0.h, shell, { PATH: binNoSleep }).m, sh(rb, a0.h, shell, { PATH: binNoSleep }).m, sh(add, a1.h, shell, { PATH: binNoSleep }).m],
      Array(5).fill({ kind: 'fail', why: 'locked' }), `${shell} — 자물쇠가 있으면 줄 없음 · 파일 없음 · 이미 있음도 기다린다`);
    assert.deepEqual([fs.readFileSync(path.join(a.lk, 'owner'), 'utf8'), fs.readFileSync(path.join(a0.lk, 'owner'), 'utf8')], [`${liveTok}\n`, `${liveTok}\n`], '남의 자물쇠 그대로');
    //      그 사이 주인이 놓으면 — 줄 없음은 removed 0 · restored 0, 파일 없음은 none(자물쇠 안에서 판정)
    for (const [body, want] of [[`${OTHER}\n`, [{ kind: 'removed', removed: 0, unmarked: 0 }, { kind: 'restored', removed: 0 }]], [null, [{ kind: 'none' }, { kind: 'none' }]]]) {
      const got = [];
      for (const sc of [rm, rb]) {
        const x = mk(body ?? ''); if (body === null) fs.rmSync(x.f); owner(x.lk, liveTok);
        fs.writeFileSync(path.join(x.h, 'sleep-hook.sh'), '[ "$c" = 2 ] && rm -rf "$HOME/.ssh/.authorized_keys.portal.lock"\n');
        const r = sh(sc, x.h, shell, { PATH: binLock }); got.push(r.m);
        assert.equal(fs.readFileSync(path.join(x.h, 'sleeps'), 'utf8').trim(), '2', '자물쇠가 풀릴 때까지 기다렸다(예전: 기다리지 않고 바로 답)');
      }
      assert.deepEqual(got, want, `${shell} ${body === null ? '파일 없음' : '줄 없음'}`);
    }
    // ①-c 지울 것이 있어 자물쇠를 기다리는 동안 보유자가 그 줄(또는 파일)을 지웠으면 — 자물쇠 안에서 다시 보고 removed 0 · none(1회차 B2 — 판정은 자물쇠 안에서 다시)
    for (const [why, hook, want] of [['그 줄 지움', `printf '%s\\n' '${OTHER}' > "$HOME/.ssh/authorized_keys"`, [{ kind: 'removed', removed: 0, unmarked: 0 }, { kind: 'restored', removed: 0 }]],
      ['파일 지움', 'rm -f "$HOME/.ssh/authorized_keys"', [{ kind: 'none' }, { kind: 'none' }]]]) {
      const got = [];
      for (const sc of [rm, rb]) {
        const x = mk(`${OTHER}\n${line}\n`); owner(x.lk, liveTok);
        fs.writeFileSync(path.join(x.h, 'sleep-hook.sh'), `[ "$c" = 2 ] && { ${hook}; rm -rf "$HOME/.ssh/.authorized_keys.portal.lock"; }\n`);
        const r = sh(sc, x.h, shell, { PATH: binLock }); got.push(r.m);
        assert.deepEqual(fs.readdirSync(path.join(x.h, '.ssh')).filter((n) => n !== 'authorized_keys'), [], `${shell} ${why} — 자물쇠 · 임시 파일 없음`);
      }
      assert.deepEqual(got, want, `${shell} ${why}`);
    }
    // ② 다른 호스트(NFS 홈)의 방금 자물쇠 — 그 pid 를 볼 수 없으니 기다린다(locked)
    owner(a.lk, `nfs-peer.example:1:${nowS()}`);
    assert.deepEqual(sh(add, a.h, shell, { PATH: binNoSleep }).m, { kind: 'fail', why: 'locked' });
    // ③ 남은 자물쇠는 치운다 — 이 호스트의 죽은 pid · 다른 호스트의 10분 넘은 표 · 표 없는 자물쇠(만들다 죽음 — **처음 본 때부터** 5초 · 가짜 시계)
    for (const [why, setup] of [['죽은 pid', () => owner(a.lk, `${HOSTID}:${deadPid}:${nowS()}`)], ['10분 넘은 표', () => owner(a.lk, `nfs-peer.example:1:${nowS() - 700}`)],
      ['표 없음', () => { fs.rmSync(a.lk, { recursive: true, force: true }); fs.mkdirSync(a.lk); fs.writeFileSync(path.join(a.h, 'clock'), '1000'); }]]) {
      fs.writeFileSync(a.f, `${OTHER}\n`); setup();
      const r = sh(add, a.h, shell, { PATH: binLock });
      assert.deepEqual(r.m, M('added'), `${shell} ${why}: ${r.out}${r.err}`);
      assert.deepEqual(fs.readdirSync(path.join(a.h, '.ssh')), ['authorized_keys'], `${shell} ${why} — 남은 자물쇠 · 임시 파일을 치웠다`);
    }
    // ③-b 주인 표 없음 5초는 **그 자물쇠를 처음 본 때부터**(1회차 반증 7 ② — 대기자 자신의 대기 횟수로 재서, 오래 기다린 대기자가 막 만들어져 아직 표가 없는 남의 자물쇠를 치웠다).
    //      살아 있는 주인의 자물쇠를 6번 기다린 뒤 보유자가 놓고 다른 쪽이 막 잡아 표를 쓰기 전(2초) → 다시 표가 생긴다 → 또 한 번 놓고 잡는 사이 3초 표 없음 → 다시 표.
    //      표 없는 틈마다 처음 본 때부터 잰다(앞 틈의 시각을 이어 쓰면 둘째 틈에서 치운다) → 끝까지 기다려 locked · 남의 자물쇠 그대로
    //      시계는 기다림 한 바퀴(date 두 번 — 자기 시한 late · now)에 1초(clock-half) — 자기 시한(12초)은 14번째 바퀴에 걸린다
    const a3 = mk(`${OTHER}\n`); owner(a3.lk, liveTok); fs.writeFileSync(path.join(a3.h, 'clock-half'), '1000');
    fs.writeFileSync(path.join(a3.h, 'sleep-hook.sh'), `lk="$HOME/.ssh/.authorized_keys.portal.lock"\ncase "$c" in 6|10) rm -f "$lk/owner" ;; 8|13) printf '%s\\n' '${liveTok}' > "$lk/owner" ;; esac\n`);
    const r3 = sh(add, a3.h, shell, { PATH: binLock });
    assert.deepEqual([r3.m, fs.readFileSync(a3.f, 'utf8'), fs.readFileSync(path.join(a3.lk, 'owner'), 'utf8')], [{ kind: 'fail', why: 'locked' }, `${OTHER}\n`, `${liveTok}\n`], `${shell}: ${r3.out}${r3.err}`);
    // ④ 경합이 아닌 mkdir 실패 — 15초 기다리지 않는다(1회차 B3). 자물쇠 자리에 일반 파일(폴더는 쓸 수 있음) → 몇 번 다시 해 본 뒤 fail write(1회차 반증 7 ① — 예전 notwritable ‘관리자가 잠가 둠’ 은 틀린 사유)
    const a4 = mk(`${OTHER}\n${line}\n`);
    fs.writeFileSync(a4.lk, 'not a dir');
    const K4 = pubOf(F.ed25519Key().pem);
    const add4 = AKS.installScript({ publicKey: K4, keyId: 'k_dddddddddddd', line: KL.buildKeyLine({ publicKey: K4, keyId: 'k_dddddddddddd' }) });
    const t4 = Date.now();
    for (const sc of [add4, rm, rb]) assert.deepEqual(sh(sc, a4.h, shell).m, { kind: 'fail', why: 'write' }, shell);
    assert.ok(Date.now() - t4 < 5_000, `기다리지 않았다(${Date.now() - t4}ms — 진짜 sleep 으로 돌렸다)`);
    assert.equal(fs.readFileSync(a4.f, 'utf8'), `${OTHER}\n${line}\n`);
    // 바꿀 것이 없는 넣기는 자물쇠 없이 답한다(1회차 축 B)
    assert.deepEqual(sh(add, a4.h, shell).m, M('present-marked', 0, 0, 1, 0), '이미 있으면 자물쇠를 잡지 않고 present');
    // ④-b mkdir 이 실패했는데 자물쇠 폴더가 없다(잡은 쪽이 그 사이 놓음 — 진짜 경합) → 다시 해서 잡는다. 4번 실패 뒤 잡으면 added · 5번 내리 실패면 fail write(1회차 반증 7 ①)
    for (const [n, want] of [[4, M('added')], [5, { kind: 'fail', why: 'write' }]]) {
      const x = mk(`${OTHER}\n`); fs.writeFileSync(path.join(x.h, 'mkdir-fail'), String(n));
      const r = sh(add, x.h, shell, { PATH: binLock });
      assert.deepEqual(r.m, want, `${shell} mkdir 실패 ${n}번: ${r.out}${r.err}`);
      assert.equal(fs.existsSync(path.join(x.h, 'sleeps')), false, '이 경우는 기다리지(sleep) 않고 바로 다시 한다');
      assert.deepEqual(fs.readdirSync(path.join(x.h, '.ssh')), ['authorized_keys'], '자물쇠 · 임시 파일 없음');
    }
    // ④-c 주인 표를 못 쓰면(디스크 가득) 자물쇠를 남기지 않고 fail write(1회차 반증 6 — 빈 표가 든 자물쇠가 남고 ‘관리자가 잠가 둠’ 이라고 했다)
    for (const sc of [add, rm, rb]) {
      const x = mk(sc === add ? `${OTHER}\n` : `${OTHER}\n${line}\n`); fs.writeFileSync(path.join(x.h, 'owner-full'), '');
      const r = sh(sc, x.h, shell, { PATH: binLock });
      assert.deepEqual(r.m, { kind: 'fail', why: 'write' }, `${shell}: ${r.out}${r.err}`);
      assert.deepEqual(fs.readdirSync(path.join(x.h, '.ssh')), ['authorized_keys'], `${shell} — 빈 표 자물쇠를 남기지 않았다`);
    }
    // ④-d 쓸 수 없는 ~/.ssh(하드닝 — root 소유 · 비 root 로그인): 바꿀 것이 있으면 바로 notwritable · 없으면 자물쇠 없이 none · removed 0 · present(1회차 반증 5)
    {
      const ro = roHome(`${OTHER}\n${line}\n`); const ro0 = roHome(null); const ro1 = roHome(`${OTHER}\n`);
      const t5 = Date.now();
      const got = [shRo(rm, ro, shell).m, shRo(rb, ro, shell).m, shRo(add4, ro, shell).m, shRo(add, ro, shell).m,
        shRo(rm, ro0, shell).m, shRo(rb, ro0, shell).m, shRo(rm, ro1, shell).m, shRo(rb, ro1, shell).m];
      assert.deepEqual(got, [{ kind: 'fail', why: 'notwritable' }, { kind: 'fail', why: 'notwritable' }, { kind: 'fail', why: 'notwritable' }, M('present-marked', 0, 0, 1, 0),
        { kind: 'none' }, { kind: 'none' }, { kind: 'removed', removed: 0, unmarked: 0 }, { kind: 'restored', removed: 0 }], `${shell} (${ro.how})`);
      assert.ok(Date.now() - t5 < 5_000, `기다리지 않았다(${Date.now() - t5}ms)`);
    }
    // ④-e c0(원본 대조 기준)는 자물쇠 직후 · 분류 **전**에 잰다(1회차 반증 8 — 분류 뒤에 재서, 분류와 c0 사이에 다른 쪽이 바꾼 것을 놓쳤다).
    //      분류 뒤 COMMIT 의 444 검사(ls) 때 다른 쪽이 줄 수는 그대로 두고 내용을 바꾼다(줄 수가 같아 verify 는 통과) → changed · 그 내용 그대로 · 우리 쓰기 없음.
    //      넣기: 사람 줄을 관리자가 옵션을 바꾼 같은 키의 포탈 줄로 바꿈(예전에는 분류가 낡아 제한 없는 우리 줄을 더했다 — B-F4 가 그 틈에서 깨짐)
    const custom = `command="/bin/true",no-pty ${BPUB} ${BMARK}`;
    const OTHER2 = `${pubOf(F.ed25519Key().pem)} ops2@bastion`;
    for (const [sc, body, after] of [[add, `${OTHER}\n`, `${custom}\n`], [rm, `${OTHER}\n${line}\n`, `${OTHER2}\n${line}\n`], [rb, `${OTHER}\n${line}\n`, `${OTHER2}\n${line}\n`]]) {
      const x = mk(body);
      fs.writeFileSync(path.join(x.h, 'after'), after); fs.writeFileSync(path.join(x.h, 'ls-hook.sh'), 'cat "$HOME/after" > "$HOME/.ssh/authorized_keys"\n');
      const r = sh(sc, x.h, shell, { PATH: binLock });
      assert.deepEqual(r.m, { kind: 'fail', why: 'changed' }, `${shell}: ${r.out}${r.err}`);
      assert.equal(fs.readFileSync(x.f, 'utf8'), after, '다른 쪽이 바꾼 내용 그대로');
      assert.deepEqual(fs.readdirSync(path.join(x.h, '.ssh')), ['authorized_keys']);
    }
    for (const sc of [rm, rb]) assert.deepEqual(sh(sc, mkHome(), shell).m, { kind: 'none' }, '~/.ssh 가 없으면 바로 none');
    // mv 뒤 다른 쪽(자물쇠를 모르는 사람 · 구성 관리 도구)이 파일을 바꿨다 → 성공이라고 하지 않는다(raced)
    const b = mk(`${OTHER}\n`);
    fs.writeFileSync(path.join(b.h, 'race-content'), `${OTHER}\n`);   // 넣은 줄을 지운 내용으로 덮는다
    assert.deepEqual(sh(add, b.h, shell, { PATH: binRace }).m, { kind: 'fail', why: 'raced' }, shell);
    fs.writeFileSync(b.f, `${OTHER}\n${line}\n`);
    fs.writeFileSync(path.join(b.h, 'race-content'), `${OTHER}\n${line}\n`);   // 지운 줄을 다시 넣은 내용으로 덮는다
    assert.deepEqual(sh(rm, b.h, shell, { PATH: binRace }).m, { kind: 'fail', why: 'raced' }, '거두기도 — ‘removed’ 라고 했는데 키가 남는 일이 없게');
    assert.equal(KL.failText('raced').includes('다시 읽어'), true);
    // root 로그인이어도 쓰기 비트 없는 파일(관리자가 444 로 잠금)은 바꾸지 않는다(test -w 는 root 에게 늘 참 — 반증 R8)
    const c = mk(`${OTHER}\n${line}\n`, 0o444);
    const K3 = pubOf(F.ed25519Key().pem);
    const add3 = AKS.installScript({ publicKey: K3, keyId: 'k_cccccccccccc', line: KL.buildKeyLine({ publicKey: K3, keyId: 'k_cccccccccccc' }) });
    for (const sc of [add3, rm]) {
      const r = sh(sc, c.h, shell);
      assert.deepEqual(r.m, { kind: 'fail', why: 'notwritable' }, `${shell}: ${r.out}${r.err}`);
    }
    assert.deepEqual([fs.readFileSync(c.f, 'utf8'), modeOf(c.f)], [`${OTHER}\n${line}\n`, 0o444]);
  }
  // 신호로 끊김(접속이 끊겨 SIGHUP · 시한으로 SIGTERM) — 임시 파일 · 자물쇠를 남기지 않는다 · 원래 파일 그대로(반증 R11 — 예전 판은 종료(0)만 걸어 신호에 남았다)
  const binHang = fakeBin('mvhang');
  for (const shell of SHELLS) {
    for (const sig of ['SIGTERM', 'SIGHUP']) {
      const d = mk(`${OTHER}\n`);
      const child = spawn(shell, ['-c', add], { env: { HOME: d.h, PATH: binHang }, stdio: 'ignore', detached: true });
      const started = path.join(d.h, 'mv-started');
      for (let i = 0; i < 300 && !fs.existsSync(started); i += 1) await sleep(10);
      assert.ok(fs.existsSync(started), `${shell} — mv 까지 왔다`);
      assert.ok(fs.readdirSync(path.join(d.h, '.ssh')).some((x) => x.startsWith('.authorized_keys.portal.') && x !== '.authorized_keys.portal.lock'), '전제 — 임시 파일이 있다');
      const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
      process.kill(-child.pid, sig);
      const ex = await exited;
      assert.deepEqual(fs.readdirSync(path.join(d.h, '.ssh')), ['authorized_keys'], `${shell} ${sig} — 임시 파일 · 자물쇠를 치웠다(${JSON.stringify(ex)})`);
      assert.equal(fs.readFileSync(d.f, 'utf8'), `${OTHER}\n`);
    }
  }
});

test('⑨-g mv 직전 확인(실제 bash · dash) — 그 사이 자물쇠를 다른 쪽이 가져갔으면 fail locklost(남의 자물쇠를 지우지 않는다) · 원본이 바뀌었으면 fail changed(남이 더한 줄을 잃지 않는다) · 원래 파일 그대로 · 시작 표지 ##KL begin · find 를 쓰지 않는다 · 되돌림은 옛 줄 안의 같은 줄을 기대한다(1회차 B1 · B10 · B5 · B4 · B8)', () => {
  const line = KL.buildKeyLine({ publicKey: BPUB, keyId: BID });
  const scripts = { 넣기: AKS.installScript({ publicKey: BPUB, keyId: BID, line }), 거두기: AKS.removeScript({ publicKey: BPUB, keyId: BID }), 되돌림: AKS.rollbackScript({ line }) };
  const bodyFor = { 넣기: `${OTHER}\n`, 거두기: `${OTHER}\n${line}\n`, 되돌림: `${OTHER}\n${line}\n` };
  const binHook = fakeBin('chmodhook');
  for (const s0 of Object.values(scripts)) {
    assert.ok(s0.startsWith('LC_ALL=C; export LC_ALL\numask 077\necho "##KL begin"'), '시작 표지를 맨 앞에 찍는다(끝 표지 없이 이것만 오면 ‘결과 모름’)');
    assert.doesNotMatch(s0, /\bfind\b/, 'find 가 없는 서버에서도 같은 판정(1회차 B4 — find 가 없으면 남은 자물쇠를 영영 못 치우고 444 보호가 빠졌다)');
  }
  for (const shell of SHELLS) {
    for (const [name, sc] of Object.entries(scripts)) {
      // locklost — 검증 뒤 · mv 직전에 자물쇠 주인 표가 남의 것으로 바뀌었다(멈춘 사이 다른 쪽이 남은 자물쇠로 보고 가져감)
      const h = mkHome(); fs.mkdirSync(path.join(h, '.ssh'), { mode: 0o700 });
      const f = path.join(h, '.ssh', 'authorized_keys'); fs.writeFileSync(f, bodyFor[name], { mode: 0o600 });
      fs.writeFileSync(path.join(h, 'hook.sh'), 'printf \'%s\\n\' "other-host:1:1" > "$HOME/.ssh/.authorized_keys.portal.lock/owner"\n');
      const r = sh(sc, h, shell, { PATH: binHook });
      assert.deepEqual([r.m, r.code], [{ kind: 'fail', why: 'locklost' }, 3], `${shell} ${name}: ${r.out}${r.err}`);
      assert.match(r.out, /^##KL begin\n/, '출력 첫 줄은 시작 표지');
      assert.equal(fs.readFileSync(f, 'utf8'), bodyFor[name], '원래 파일 그대로');
      assert.deepEqual(fs.readdirSync(path.join(h, '.ssh')).sort(), ['.authorized_keys.portal.lock', 'authorized_keys'], '남의 자물쇠는 지우지 않았다 · 임시 파일은 치웠다');
      assert.equal(fs.readFileSync(path.join(h, '.ssh', '.authorized_keys.portal.lock', 'owner'), 'utf8'), 'other-host:1:1\n');
      // changed — 검증 뒤 · mv 직전에 자물쇠를 모르는 쪽(사람 · 구성 관리 도구)이 줄을 더했다 → 바꾸지 않는다(예전에는 그 줄이 사라지고 결과는 성공이었다)
      const h2 = mkHome(); fs.mkdirSync(path.join(h2, '.ssh'), { mode: 0o700 });
      const f2 = path.join(h2, '.ssh', 'authorized_keys'); fs.writeFileSync(f2, bodyFor[name], { mode: 0o600 });
      const ansible = `${pubOf(F.ed25519Key().pem)} added-by-ansible`;
      fs.writeFileSync(path.join(h2, 'hook.sh'), `printf '%s\\n' '${ansible}' >> "$HOME/.ssh/authorized_keys"\n`);
      const r2 = sh(sc, h2, shell, { PATH: binHook });
      assert.deepEqual([r2.m, r2.code], [{ kind: 'fail', why: 'changed' }, 3], `${shell} ${name}: ${r2.out}${r2.err}`);
      assert.equal(fs.readFileSync(f2, 'utf8'), `${bodyFor[name]}${ansible}\n`, '남이 더한 줄이 남았다 · 우리 쓰기는 하지 않았다');
      assert.deepEqual(fs.readdirSync(path.join(h2, '.ssh')), ['authorized_keys'], '내 자물쇠 · 임시 파일은 치웠다');
    }
    // 되돌림 — 바꾸기 전 줄(old) 안에 원하는 줄(L)과 똑같은 줄이 있으면 되살린 뒤 L 이 그만큼 남는 것이 정상이다(1회차 B8 — 0 을 기대해 제대로 되돌리고도 raced 라고 했다)
    const loose = `${BPUB} ${BMARK}`;
    const L = KL.buildKeyLine({ publicKey: BPUB, keyId: BID, restrict: true, fromIp: '10.0.0.1' });
    const h3 = mkHome(); fs.mkdirSync(path.join(h3, '.ssh'), { mode: 0o700 });
    const f3 = path.join(h3, '.ssh', 'authorized_keys'); fs.writeFileSync(f3, `${OTHER}\n${L}\n`);
    const rb = sh(AKS.rollbackScript({ line: L, oldB64: Buffer.from(`${loose}\n${L}\n`).toString('base64') }), h3, shell);
    assert.deepEqual(rb.m, { kind: 'restored', removed: 1 }, `${shell}: ${rb.out}${rb.err}`);
    assert.equal(fs.readFileSync(f3, 'utf8'), `${OTHER}\n${loose}\n${L}\n`, '바꾸기 전 그대로');
  }
  assert.equal(KL.failText('locklost').includes('원래 파일은 그대로'), true);
  assert.equal(KL.failText('changed').includes('원래 파일은 그대로'), true);
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
  assert.deepEqual([r.unmarked, r.custom, r.replaceSkipped, r.notes, r.note], [0, 0, false, [], undefined], '알릴 것이 없으면 안내 글도 없다');
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
  // 작업 요약 사건(중요 사건 — 서버마다의 key-login-set 은 중요 사건이 아니다 · 점검 C-3)
  assert.ok(eventsOf('key-job-done').some((e) => e.by === 'own' && e.target.includes('kl-happy') && /1대 — 확인 1 · 실패 0/.test(e.detail)), JSON.stringify(eventsOf('key-job-done')));
  // 다시 — 이제는 그 키로 붙는다. 포탈 줄이 이미 있어 더하지 않는다. 그동안 같은 칸(넣기)의 다른 작업은 받지 않는다(한 번에 하나 — 거두기 칸은 따로: ⑰-b).
  S.clear();
  const again = await SVC.startKeyLogin({ servers: [sv], keyId: K.id, by: 'own' });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.deepEqual((({ code, status, jobId }) => [code, status, jobId])(await SVC.startKeyLogin({ servers: [sv], keyId: K.id, by: 'own' })), ['busy', 409, again.jobId]);
  assert.deepEqual([KL.busyJob('key-login'), (await SVC.keyJobPrecheck('key-login'))?.code, await SVC.keyJobPrecheck('key-revoke', '', { corp: 'vcA' })], [again.jobId, 'busy', null], '라우트 사전 검사(OTP 앞 · async)도 같은 판정');
  const r2 = (await waitJob(again.jobId)).results[0];
  // restricted = 지금 서버에 있는 그 키의 포탈 줄에 제한이 붙어 있는가(이미 제한된 같은 줄이 있으면 참 — 바꾸지 않았어도)
  assert.deepEqual([r2.ok, r2.line, r2.restricted, r2.bound, r2.passwordRemoved, r2.replaceSkipped], [true, 'present-marked', true, true, false, false], JSON.stringify(r2));
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

test('⑪-b keyboard-interactive 도 받는 sshd(PAM 을 켠 서버) — 틀린 비밀번호는 서버에 한 번만 간다(한 번의 동작 = 인증 실패 한 번 · 서버가 둘 다 내놓으면 password 하나 — 1회차 D3)',
  {}, async () => {
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
    assert.equal(S.passwordTries()[0].method, 'password', '둘 다 내놓으면 password 우선');
  });

test('⑪-c 구형 알고리즘(diffie-hellman-group1-sha1)만 받는 서버 — 협상 실패 뒤 다시 붙을 때도 비밀번호는 password 방식 한 번(keyboard-interactive 로 다시 보내지 않는다 — 점검 B-F7 · D-4)', async () => {
  const seen = [];
  const srv = new ssh2.Server({ hostKeys: [HOSTKEY], algorithms: { kex: ['diffie-hellman-group1-sha1'] } }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password') { seen.push(`password:${ctx.password}`); return ctx.reject(['password', 'keyboard-interactive']); }
      if (ctx.method === 'keyboard-interactive') return ctx.prompt([{ prompt: 'Password: ', echo: false }], (a) => { seen.push(`kbd:${a?.[0]}`); ctx.reject(['password', 'keyboard-interactive']); });
      seen.push(ctx.method);
      return ctx.reject(['password', 'keyboard-interactive']);
    });
    client.on('error', () => {});
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  CLOSERS.push(() => srv.close());
  const { withSsh } = await import('../src/proxy/sshExec.js');
  const once = async (passwordOnly) => {
    seen.length = 0;
    const log = [];
    let err = '';
    try { await withSsh({ host: '127.0.0.1', port: srv.address().port, username: 'mon', password: 'Wrong-Legacy-Pw', readyTimeout: 10_000, passwordOnly, trace: (m) => log.push(m) }, async () => ({})); } catch (e) { err = String(e?.message || e); }
    return { err, seen: [...seen], legacy: log.some((m) => m.includes('구형 알고리즘 포함 재시도')) };
  };
  const a = await once(true);
  assert.equal(a.legacy, true, `전제 — 첫 협상이 실패해 구형 알고리즘으로 다시 붙었다 ${JSON.stringify(a)}`);
  assert.deepEqual(a.seen.filter((x) => x !== 'none'), ['password:Wrong-Legacy-Pw'], `비밀번호는 서버에 한 번만 갔다 ${JSON.stringify(a)}`);
  // 대조 — passwordOnly 가 아닌 호출(기존 기능 · keyboard-interactive 만 받는 서버 지원)은 같은 서버에서 keyboard-interactive 도 보낸다(이 가짜 서버가 그 방식을 받는다는 전제 확인)
  const b = await once(false);
  assert.ok(b.legacy && b.seen.includes('kbd:Wrong-Legacy-Pw'), JSON.stringify(b));
});

test('⑪-d 서버에 들어 있는 키 읽기도 비밀번호는 password 방식 한 번 — keyboard-interactive 를 받는 서버에 틀린 1회 비밀번호가 두 번 가지 않는다(문구 ‘다시 시도하지 않습니다’ 와 맞춘다 — 점검 E-3)', async () => {
  const S = await fakeSshd();
  S.st.password = 'Right-Pw-Read-11d';
  S.st.offerKbd = true;
  const sv = mkServer('bm-read-kbd', S);
  const once = secret('Once-Wrong-Read-11d');
  const r = await SVC.readInstalledKeys({ serverId: sv.id, oncePassword: once, by: 'own' });
  assert.deepEqual([r.ok, r.code], [false, 'auth-rejected'], JSON.stringify(r));
  assert.match(r.reason, /다시 시도하지 않습니다/);
  assert.deepEqual(S.passwordTries().map((x) => [x.method, x.password]), [['password', once]], '서버가 받은 비밀번호 시도 = 한 번');
  // 맞는 1회 비밀번호면 읽는다(같은 서버 · 같은 경로)
  S.clear(); S.writeAk(`${OTHER}\n`);
  const ok = await SVC.readInstalledKeys({ serverId: sv.id, oncePassword: S.st.password, by: 'own' });
  assert.deepEqual([ok.ok, ok.keys.length, ok.via], [true, 1, 'password-once'], JSON.stringify(ok));
});

test('⑪-e 대화형(keyboard-interactive)만 받는 서버 — 비밀번호는 서버가 내놓은 방식 하나로 한 번만: 맞으면 키 읽기 · 키 로그인 설정이 되고, 틀리면 대화형 한 번뿐(1회차 D3 — password 만 보내자 이런 서버에서 읽기가 늘 실패했다)', async () => {
  const S = await fakeSshd();
  const right = secret('Right-Kbd-Pw-11e');
  S.st.password = right; S.st.offerKbd = true; S.st.noPassword = true;
  const K = mkKey('kl-kbd-only');
  const sv = mkServer('bm-kbd-only', S);   // 저장된 비밀번호 없음 — 1회 비밀번호로
  S.writeAk(`${OTHER}\n`);
  // 서버에 들어 있는 키 읽기
  const rd = await SVC.readInstalledKeys({ serverId: sv.id, oncePassword: right, by: 'own' });
  assert.deepEqual([rd.ok, rd.keys?.length, rd.via], [true, 1, 'password-once'], JSON.stringify(rd));
  assert.deepEqual(S.passwordTries().map((x) => [x.method, x.password]), [['keyboard-interactive', right]], 'password 방식은 시도하지 않았다(서버가 내놓지 않음) · 대화형 한 번');
  // 틀린 비밀번호 — 대화형 한 번뿐
  S.clear();
  const wrong = secret('Wrong-Kbd-Pw-11e');
  const rd2 = await SVC.readInstalledKeys({ serverId: sv.id, oncePassword: wrong, by: 'own' });
  assert.deepEqual([rd2.ok, rd2.code], [false, 'auth-rejected'], JSON.stringify(rd2));
  assert.deepEqual(S.passwordTries().map((x) => [x.method, x.password]), [['keyboard-interactive', wrong]]);
  // 키 로그인 설정 — 대화형으로 붙어 줄을 넣고, 키로 다시 붙어 확인
  S.clear();
  const r = (await runLogin({ servers: [sv], keyId: K.id, oncePassword: right, by: 'own' })).job.results[0];
  assert.deepEqual([r.ok, r.line, r.restricted, r.bound], [true, 'added', true, true], JSON.stringify(r));
  assert.deepEqual(S.passwordTries().map((x) => [x.conn, x.method]), [[1, 'keyboard-interactive']]);
  assert.match(S.readAk(), new RegExp(`portal-ssh:${K.id}`));
  // 대조 — password 를 내놓는 서버에서는 password 하나(⑪-b · ⑪-c 가 대화형도 받는 서버에서 같은 것을 본다)
});

test('⑪-f passwordOnly 대화형은 처음 나온 가리는 칸(echo=false) 하나에만 비밀번호(나머지 · 다음 질의는 빈 답 — 2회차 B5: 보이는 OTP 칸에는 넣지 않는다 · 가리는 칸이 끝내 없으면 no-password-method) · 비밀번호를 받는 방식이 없으면 보내지 않고 SSH_NO_PASSWORD_METHOD → 키 작업 · 읽기는 no-password-method(인증 거부로 세지 않는다 — 작업이 멈추지 않는다) · 1회차 반증 9(r1R/d_pwonly a~g)', async () => {
  const { withSsh, SSH_NO_PASSWORD_METHOD } = await import('../src/proxy/sshExec.js');
  assert.equal(SSH_NO_PASSWORD_METHOD, 'SSH_NO_PASSWORD_METHOD');
  const PW = secret('Kbd-Once-Pw-11f');
  const trial = async (onAuth) => {
    const seen = [];
    const srv = new ssh2.Server({ hostKeys: [HOSTKEY] }, (client) => {
      client.on('authentication', (ctx) => onAuth(ctx, seen));
      client.on('ready', () => client.on('session', (accept) => { const ss = accept(); ss.on('exec', (acc) => { const x = acc(); x.write('ok\n'); x.exit(0); x.end(); }); }));
      client.on('error', () => {});
    });
    await new Promise((r) => { srv.listen(0, '127.0.0.1', r); });
    let ok = false; let code = ''; let msg = '';
    try { await withSsh({ host: '127.0.0.1', port: srv.address().port, username: 'mon', password: PW, readyTimeout: 6000, passwordOnly: true }, async ({ exec }) => exec('true')); ok = true; } catch (e) { code = e?.code || ''; msg = String(e?.message || e); }
    srv.close();
    return { ok, code, msg, sent: seen.filter((x) => x.secret === PW).length, seen: seen.map((x) => `${x.m}:${x.secret === PW ? 'PW' : JSON.stringify(x.secret ?? null)}`) };
  };
  const kbdOnly = (ask) => (ctx, seen) => {
    if (ctx.method === 'keyboard-interactive') return ask(ctx, seen);
    seen.push({ m: ctx.method, secret: ctx.password }); return ctx.reject(['keyboard-interactive']);
  };
  // a) 대화형 · 한 번 묻고 거부 → 한 번
  const a = await trial(kbdOnly((ctx, seen) => ctx.prompt([{ prompt: 'Password: ', echo: false }], (x) => { seen.push({ m: 'kbd', secret: x?.[0] }); ctx.reject(['keyboard-interactive']); })));
  assert.deepEqual([a.ok, a.sent, a.code], [false, 1, ''], JSON.stringify(a));
  // b) 같은 시도에서 두 번 묻는다(PAM 재질의 · 비밀번호 + OTP) → 둘째 질의는 빈 답(예전에는 둘 다 비밀번호)
  const b = await trial(kbdOnly((ctx, seen) => ctx.prompt([{ prompt: 'Password: ', echo: false }], (x) => { seen.push({ m: 'kbd1', secret: x?.[0] }); ctx.prompt([{ prompt: 'Verification code: ', echo: false }], (y) => { seen.push({ m: 'kbd2', secret: y?.[0] }); ctx.reject(['keyboard-interactive']); }); })));
  assert.deepEqual([b.sent, b.seen.filter((x) => x.startsWith('kbd'))], [1, ['kbd1:PW', 'kbd2:""']], JSON.stringify(b));
  // c) 한 질의에 프롬프트 둘 → 첫 프롬프트만
  const c = await trial(kbdOnly((ctx, seen) => ctx.prompt([{ prompt: 'Password: ', echo: false }, { prompt: 'OTP: ', echo: false }], (x) => { for (const v of x || []) seen.push({ m: 'kbd', secret: v }); ctx.reject(['keyboard-interactive']); })));
  assert.deepEqual([c.sent, c.seen.filter((x) => x.startsWith('kbd'))], [1, ['kbd:PW', 'kbd:""']], JSON.stringify(c));
  // h) 한 질의에 보이는 칸(OTP — echo=true)이 먼저, 가리는 칸(Password)이 뒤 → 비밀번호는 가리는 칸에만(2회차 B5 — 첫 칸에 넣어 평문 칸으로 갔다)
  const h = await trial(kbdOnly((ctx, seen) => ctx.prompt([{ prompt: 'Duo passcode: ', echo: true }, { prompt: 'Password: ', echo: false }], (x) => { (x || []).forEach((v, i) => seen.push({ m: `kbd[${i}]`, secret: v })); ctx.reject(['keyboard-interactive']); })));
  assert.deepEqual([h.sent, h.seen.filter((x) => x.startsWith('kbd')), h.code], [1, ['kbd[0]:""', 'kbd[1]:PW'], ''], JSON.stringify(h));
  // i) 첫 질의는 OTP 칸만(빈 답) · 둘째 질의에 Password → 거기에 보낸다 · 거부되면 거부다(비밀번호 방식 없음이 아니다)
  const i2 = await trial(kbdOnly((ctx, seen) => ctx.prompt([{ prompt: 'OTP: ', echo: true }], (x) => { seen.push({ m: 'kbd1', secret: x?.[0] }); ctx.prompt([{ prompt: 'Password: ', echo: false }], (y) => { seen.push({ m: 'kbd2', secret: y?.[0] }); ctx.reject(['keyboard-interactive']); }); })));
  assert.deepEqual([i2.sent, i2.seen.filter((x) => x.startsWith('kbd')), i2.code], [1, ['kbd1:""', 'kbd2:PW'], ''], JSON.stringify(i2));
  // j) OTP 칸만 묻고 거부 → 비밀번호를 보내지 않았다 → SSH_NO_PASSWORD_METHOD(거부로 세지 않는다)
  const jj = await trial(kbdOnly((ctx, seen) => ctx.prompt([{ prompt: 'Verification code: ', echo: true }], (x) => { seen.push({ m: 'kbd', secret: x?.[0] }); ctx.reject(['keyboard-interactive']); })));
  assert.deepEqual([jj.ok, jj.sent, jj.code, jj.seen.filter((x) => x.startsWith('kbd'))], [false, 0, 'SSH_NO_PASSWORD_METHOD', ['kbd:""']], JSON.stringify(jj));
  assert.match(jj.msg, /비밀번호 칸\(입력을 가리는 칸\)을 묻지 않았습니다/);
  // d) publickey 만 → 보내지 않고 SSH_NO_PASSWORD_METHOD(예전에는 ‘인증 거부’ 문구로 끝나 거부로 셌다)
  const d = await trial((ctx, seen) => { seen.push({ m: ctx.method, secret: ctx.password }); ctx.reject(['publickey']); });
  assert.deepEqual([d.ok, d.sent, d.code], [false, 0, 'SSH_NO_PASSWORD_METHOD'], JSON.stringify(d));
  assert.match(d.msg, /비밀번호를 보내지 않았습니다/); assert.match(d.msg, /publickey/);
  // e) none 이 받아들여짐 → 비밀번호 없이 성공
  const e = await trial((ctx, seen) => { seen.push({ m: ctx.method }); ctx.accept(); });
  assert.deepEqual([e.ok, e.sent], [true, 0], JSON.stringify(e));
  // f) password 부분 성공 뒤 대화형 요구 · g) password 거부 뒤 대화형만 남김 → 다시 보내지 않는다(한 번)
  const f = await trial((ctx, seen) => {
    if (ctx.method === 'password') { seen.push({ m: 'pw', secret: ctx.password }); return ctx.reject(['keyboard-interactive'], true); }
    if (ctx.method === 'keyboard-interactive') return ctx.prompt([{ prompt: 'Code: ', echo: false }], (x) => { seen.push({ m: 'kbd', secret: x?.[0] }); ctx.reject(['keyboard-interactive']); });
    seen.push({ m: ctx.method }); return ctx.reject(['password']);
  });
  const g = await trial((ctx, seen) => {
    if (ctx.method === 'password') { seen.push({ m: 'pw', secret: ctx.password }); return ctx.reject(['keyboard-interactive']); }
    if (ctx.method === 'keyboard-interactive') return ctx.prompt([{ prompt: 'Password: ', echo: false }], (x) => { seen.push({ m: 'kbd', secret: x?.[0] }); ctx.reject(['keyboard-interactive']); });
    seen.push({ m: ctx.method }); return ctx.reject(['password', 'keyboard-interactive']);
  });
  assert.deepEqual([f.ok, f.sent, f.code, g.ok, g.sent, g.code], [false, 1, '', false, 1, ''], JSON.stringify([f, g]));
  // 키 작업 · 읽기 — 비밀번호를 받지 않는 서버 셋(1회 비밀번호). 인증 거부가 아니라 no-password-method · 거부 셈에 들지 않아 작업이 멈추지 않는다(예전: 거부 둘 → 셋째 cancelled)
  const SS = []; for (let i = 0; i < 3; i += 1) { const S = await fakeSshd(); S.st.password = 'Right-Unused-11f'; S.st.noPassword = true; SS.push(S); }
  const K = mkKey('kl-nopw');
  const svs = SS.map((S, i) => mkServer(`bm-nopw${i}`, S));
  const once = secret('Once-NoPw-11f');
  const j = (await runLogin({ servers: svs, keyId: K.id, oncePassword: once, by: 'own' })).job;
  assert.deepEqual([j.results.map((r) => r.code), j.cancelled], [['no-password-method', 'no-password-method', 'no-password-method'], false], JSON.stringify(j.results));
  // 사유는 서버가 준 상세(허용 방식) + 안내(2회차 반증 — 고정 문구가 OTP 만 묻는 서버에도 ‘키만 받음’ 이라 했다)
  assert.match(j.results[0].reason, /^서버가 비밀번호 로그인을 받지 않습니다\(허용 방식: publickey\) — 비밀번호를 보내지 않았습니다 — 이미 되는 키로 접속하게 서버 설정을 고르거나 공개키를 서버에 직접 넣으세요/);
  assert.doesNotMatch(j.results[0].reason, /인증이 거부/);
  assert.deepEqual(SS.map((S) => S.passwordTries().length), [0, 0, 0], '비밀번호를 한 번도 보내지 않았다');
  const rd = await SVC.readInstalledKeys({ serverId: svs[0].id, oncePassword: once, by: 'own' });
  assert.deepEqual([rd.ok, rd.code], [false, 'no-password-method'], JSON.stringify(rd));
  // 키 작업 — 대화형이 OTP 칸만 묻는 서버(가리는 칸 없음): 전송 0 · no-password-method(2회차 B5)
  const So = await fakeSshd(); So.st.password = 'Right-Otp-Only-11f'; So.st.noPassword = true; So.st.offerKbd = true; So.st.kbdPrompts = [{ prompt: 'Verification code: ', echo: true }];
  const svo = mkServer('bm-otp-only', So);
  const jo = (await runLogin({ servers: [svo], keyId: K.id, oncePassword: once, by: 'own' })).job;
  assert.deepEqual(jo.results.map((r) => r.code), ['no-password-method'], JSON.stringify(jo.results));
  assert.ok(So.st.seen.every((x) => !(x.answers || []).includes(once)), '비밀번호를 어느 칸에도 보내지 않았다');
  assert.equal(rd.reason, '서버가 비밀번호 로그인을 받지 않습니다(허용 방식: publickey) — 비밀번호를 보내지 않았습니다.', '키 읽기도 서버가 준 상세(3회차 E3-6 — 고정 문구 ‘키만 받음’)');
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
  // 서버로 나간 명령은 base64 로 싼 한 줄이다 — 풀어서 본다(넣을 줄 L 에 그 키가 있으면 반드시 출발지 제한이 붙어 있다)
  const scripts = S.st.execs.map((x) => scriptOf(x.command));
  assert.ok(scripts.some((x) => lineInScript(x).includes(K.blob)), '전제 — 넣는 스크립트를 풀어 읽었다');
  assert.equal(scripts.some((x) => lineInScript(x).includes(K.blob) && !lineInScript(x).startsWith('from="127.0.0.1",')), false, '제한 없는 줄을 넣는 명령은 없었다');
  const raw = rawOf(sv.id);
  assert.deepEqual([raw.keyRef, raw.password], [undefined, S.st.password], '키를 묶지 않았고 저장 비밀번호도 지우지 않았다');
  const use = US.keyUsageView({ fingerprint: K.fingerprint }).rows.find((u) => u.server === 'bm-kl3' && u.feature === 'conn-test');
  assert.deepEqual([use.okCount, use.failCount, use.lastOk, use.lastCode], [0, 1, false, 'auth-rejected'], '거부된 키 접속도 사용 기록에 남는다(한 번)');
  // 포탈 줄이 이미 있던 서버(다른 출발지로 제한된 줄) — 제한을 지금 주소로 바꿔 넣었다가(replaced) 키 접속이 안 되면 원래대로 되돌린다(테스트 ⑮-c 의 바꾸기 경로).
  //   점검 B-F6 — 되돌림은 사본 파일로 파일 전체를 되쓰지 않고, 더한 줄만 지우고 바꾸기 전 줄(base64 로 받아 둔 것)을 다시 넣는다(줄은 파일 끝으로 간다).
  const kept = `${before}from="10.1.1.1",${RESTRICT} ${K.pub} portal-ssh:${K.id}\n`;
  S.writeAk(kept); S.clear();
  S.st.ipQueue.push('127.0.0.1', '10.77.0.9');   // 바꿔 넣은 뒤에도 둘째 연결의 출발지가 달라 키 접속이 안 되는 경우
  const r2 = (await runLogin({ servers: [sv], keyId: K.id, by: 'own' })).job.results[0];
  assert.deepEqual([r2.ok, r2.code, r2.line, r2.rolledBack], [false, 'key-login-failed', 'replaced', true], JSON.stringify(r2));
  assert.match(r2.reason, /원래대로 되돌렸습니다/);
  assert.equal(S.readAk(), kept, '이미 있던 줄이 글자 그대로 돌아왔다(여기서는 원래도 끝 줄이라 파일 전체가 같다)');
  assert.ok(S.st.execs.filter((x) => x.conn === 3).every((x) => /^L='/m.test(scriptOf(x.command)) && !/portal-bak/.test(scriptOf(x.command))), '되돌림 = 줄 지우기 + 옛 줄 다시 넣기(사본 파일 없음)');
  assert.equal(S.st.conns, 3, '붙어서 바꿈 → 키로 확인(거부) → 붙어서 되돌림');
  // 출발지가 같으면 바꾼 줄로 접속이 확인되고 사본은 지운다(제한이 지금 주소로 갱신된다)
  S.writeAk(kept); S.clear();
  const r4 = (await runLogin({ servers: [sv], keyId: K.id, by: 'own' })).job.results[0];
  assert.deepEqual([r4.ok, r4.line, r4.restricted, r4.fromIp], [true, 'replaced', true, '127.0.0.1'], JSON.stringify(r4));
  assert.equal(S.readAk(), `${before}from="127.0.0.1",${RESTRICT} ${K.pub} portal-ssh:${K.id}\n`);
  assert.deepEqual(fs.readdirSync(path.join(S.home, '.ssh')), ['authorized_keys'], '사본 · 임시 파일을 남기지 않았다');
  // 같은(제한된) 줄이 이미 있으면 바꾸지 않고, 키 접속이 안 돼도 지우지 않는다
  const same = `${before}from="127.0.0.1",${RESTRICT} ${K.pub} portal-ssh:${K.id}\n`;
  S.writeAk(same); S.clear();
  S.st.ipQueue.push('127.0.0.1', '10.77.0.9');
  const r3 = (await runLogin({ servers: [sv], keyId: K.id, by: 'own' })).job.results[0];
  assert.deepEqual([r3.ok, r3.code, r3.line, r3.rolledBack], [false, 'key-login-failed', 'present-marked', null], JSON.stringify(r3));
  assert.match(r3.reason, /이미 있던 것이라 지우지 않았습니다/);
  assert.equal(S.readAk(), same);
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
  {}, async () => {
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

test('⑫-d 관리자가 옵션을 바꾼 포탈 줄이 있으면 — 키 로그인 설정이 그 줄을 바꾸지 않고(제한을 다시 넣지 않음) custom 수 · 안내를 돌려준다 · restricted 는 거짓 · 표식 없는 같은 키 줄도 함께 알린다(점검 B-F4)', async () => {
  const S = await fakeSshd();
  S.st.password = secret('Pw-Custom-Stored-12d');
  const K = mkKey('kl-custom');
  // 강제 명령(command=)이 없는 관리자 옵션 — command= 가 있으면 그 키로는 우리 명령이 돌지 않아 key-login-failed 다(가짜 sshd 가 강제 명령을 따른다 — ㉒-b)
  const custom = `expiry-time="20991231",restrict ${K.pub} portal-ssh:${K.id}`;
  const before = `${OTHER}\n${custom}\n`;
  S.writeAk(before);
  const sv = mkServer('bm-kl-custom', S, { password: S.st.password });
  const r = (await runLogin({ servers: [sv], keyId: K.id, by: 'own' })).job.results[0];
  assert.deepEqual([r.ok, r.line, r.custom, r.unmarked, r.restricted, r.replaceSkipped, r.notes.length], [true, 'present-marked', 1, 0, false, false, 1], JSON.stringify(r));
  assert.match(r.note, /관리자가 옵션을 바꾼 포탈 줄 1개는 그대로 두었습니다/);
  assert.equal(S.readAk(), before, '관리자 줄을 덜 엄한 줄로 풀지 않았다(예전 판은 관리자 옵션 · restrict 를 지우고 포워딩 금지 세 가지 줄로 바꿨다)');
  // 사람이 넣은 같은 키 줄(표식 없음)까지 있으면 — 안내 둘 · 제한 있음으로 보고하지 않는다
  const before2 = `${before}${K.pub} admin@laptop\n`;
  S.writeAk(before2); S.clear();
  const r2 = (await runLogin({ servers: [sv], keyId: K.id, by: 'own' })).job.results[0];
  assert.deepEqual([r2.ok, r2.custom, r2.unmarked, r2.restricted, r2.notes.length], [true, 1, 1, false, 2], JSON.stringify(r2));
  assert.match(r2.note, /표식 없는 같은 키 줄 1개가 서버에 있습니다/);
  assert.match(r2.note, /출발지 제한이 없으니 서버에서 직접 정리하세요/);
  assert.equal(S.readAk(), before2);
  // 관리자 줄 + 제한 없는 우리 꼴 줄이 함께 있으면 — 바꾸기 대상(loose)이 있어도 아무 줄도 바꾸지 않는다(바꾸면 관리자 줄까지 지운다)
  const before3 = `${before}${K.pub} portal-ssh:${K.id}\n`;
  S.writeAk(before3); S.clear();
  const r3 = (await runLogin({ servers: [sv], keyId: K.id, by: 'own' })).job.results[0];
  assert.deepEqual([r3.ok, r3.line, r3.custom, r3.restricted], [true, 'present-marked', 1, false], JSON.stringify(r3));
  assert.equal(S.readAk(), before3, '관리자 줄이 그대로 남았다');
});

test('⑫-e 첫 접속이 바로 그 키(저장 비밀번호 없음)면 — 제한 없는 포탈 줄을 제한 줄로 바꾸지 않는다(확인이 실패하면 되돌릴 접속이 없다 — 점검 B-F5) · replaceSkipped + 안내 · 1회 비밀번호를 주면 바꾼다', async () => {
  const S = await fakeSshd();
  const K = mkKey('kl-self');
  const loose = `${K.pub} portal-ssh:${K.id}`;
  S.writeAk(`${OTHER}\n${loose}\n`);
  const sv = mkServer('bm-kl-self', S, { keyRef: K.id, bindApproved: true });   // 저장 비밀번호 없음 — 그 키로만 붙는 서버
  const r = (await runLogin({ servers: [sv], keyId: K.id, by: 'own' })).job.results[0];
  assert.deepEqual([r.ok, r.line, r.restricted, r.replaceSkipped, r.fromIp], [true, 'present-marked', false, true, ''], JSON.stringify(r));
  assert.match(r.note, /이번 한 번만 쓸 비밀번호를 넣고 다시 하면 바꿉니다/);
  assert.equal(S.readAk(), `${OTHER}\n${loose}\n`, '그 키로 붙은 접속에서는 그 키의 줄을 바꾸지 않았다');
  assert.deepEqual([S.passwordTries().length, S.keyTries().filter((x) => x.signed && x.conn === 1).length], [0, 1], '첫 접속은 그 키');
  assert.ok(S.st.execs.filter((x) => x.conn === 1).map((x) => scriptOf(x.command)).some((x) => x.includes("RP='0'")), '넣기 스크립트에 바꾸기를 끈 채로 보냈다');
  // 1회 비밀번호로 붙으면(되돌릴 접속이 그 키가 아니다) 바꾼다
  const once = secret('Once-Self-Pw-12e');
  S.st.password = once; S.clear();
  const r2 = (await runLogin({ servers: [sv], keyId: K.id, oncePassword: once, by: 'own' })).job.results[0];
  assert.deepEqual([r2.ok, r2.line, r2.restricted, r2.replaceSkipped], [true, 'replaced', true, false], JSON.stringify(r2));
  assert.equal(S.readAk(), `${OTHER}\nfrom="127.0.0.1",${RESTRICT} ${K.pub} portal-ssh:${K.id}\n`);
});

test('⑫-f 바꾼 뒤 확인이 실패했는데 그 사이 사람이 파일을 고쳤으면 — 사람이 더한 줄은 남기고 우리 줄만 되돌린다 · 사람이 우리 줄을 이미 지웠으면 옛 줄을 되살리지 않는다(rolledBack 거짓 · 점검 B-F6)', async () => {
  const S = await fakeSshd();
  S.st.password = secret('Pw-Human-Stored-12f');
  const K = mkKey('kl-human');
  const sv = mkServer('bm-kl-human', S, { password: S.st.password });
  const old = `from="10.1.1.1",${RESTRICT} ${K.pub} portal-ssh:${K.id}`;
  const newcomer = `${pubOf(F.ed25519Key().pem)} added-by-human`;
  // ① 확인 접속이 들어오는 사이 사람이 새 줄을 더했다 → 우리 줄만 지우고 옛 줄을 다시 넣는다(사람 줄은 남는다)
  S.writeAk(`${OTHER}\n${old}\n`);
  S.st.ipQueue.push('127.0.0.1', '10.77.0.9');
  S.st.onConn = (n) => { if (n === 2) fs.appendFileSync(S.akFile, `${newcomer}\n`); };
  const r1 = (await runLogin({ servers: [sv], keyId: K.id, by: 'own' })).job.results[0];
  assert.deepEqual([r1.ok, r1.code, r1.line, r1.rolledBack], [false, 'key-login-failed', 'replaced', true], JSON.stringify(r1));
  assert.equal(S.readAk(), `${OTHER}\n${newcomer}\n${old}\n`, '사람이 더한 줄이 남았다(예전 판은 사본으로 파일 전체를 되써 사라졌다)');
  // ② 사람이 우리 줄을 지웠다(유출 의심 정리) → 옛 줄을 되살리지 않고 그렇게 말한다
  S.writeAk(`${OTHER}\n${old}\n`); S.clear();
  S.st.ipQueue.push('127.0.0.1', '10.77.0.9');
  S.st.onConn = (n) => { if (n === 2) S.writeAk(`${OTHER}\n${newcomer}\n`); };
  const r2 = (await runLogin({ servers: [sv], keyId: K.id, by: 'own' })).job.results[0];
  assert.deepEqual([r2.ok, r2.code, r2.line, r2.rolledBack], [false, 'key-login-failed', 'replaced', false], JSON.stringify(r2));
  assert.match(r2.reason, /바꾼 줄을 되돌리지 못했습니다\(그 사이 줄이 이미 바뀌어 있어 손대지 않았습니다\)/);
  assert.equal(S.readAk(), `${OTHER}\n${newcomer}\n`, '지운 옛 줄이 되살아나지 않았다');
  assert.deepEqual([rawOf(sv.id).keyRef, rawOf(sv.id).password], [undefined, S.st.password]);
});

test('⑫-g 바꾸는 명령을 보낸 뒤 답을 받지 못하면 — ‘서버에서 바꾼 것은 없습니다’ 라고 하지 않고 uncertain(바뀌었을 수 있음 · 다시 읽기 안내)으로 말한다 · 키 접속 · 등록부 쓰기 없음 · 거두기도 같다(점검 B-F3)', async () => {
  const S = await fakeSshd();
  S.st.password = secret('Pw-Uncertain-Stored-12g');
  const K = mkKey('kl-uncertain');
  const sv = mkServer('bm-kl-unc', S, { password: S.st.password });
  S.writeAk(`${OTHER}\n`);
  // 넣는 명령(그 키의 공개키가 든 스크립트)의 exec 요청만 실패 — 출발지 주소 묻기는 된다
  S.st.rejectExec = (cmd) => scriptOf(cmd).includes(K.blob);
  const r = (await runLogin({ servers: [sv], keyId: K.id, removePassword: true, by: 'own' })).job.results[0];
  assert.deepEqual([r.ok, r.code], [false, 'uncertain'], JSON.stringify(r));
  assert.match(r.reason, /바뀌었을 수 있습니다/);
  assert.match(r.reason, /다시 읽기/);
  assert.doesNotMatch(r.reason, /서버에서 바꾼 것은 없습니다/);
  assert.deepEqual([S.keyTries().length, rawOf(sv.id).keyRef, rawOf(sv.id).password], [0, undefined, S.st.password], '키 접속 · 등록부 쓰기 없음');
  // 바꾸지 않는 명령(출발지 주소 묻기)에서 끊겼으면 ‘바꾼 것 없음’ 이 맞다 — 둘을 가른다
  S.clear();
  S.st.rejectExec = (cmd) => cmd === KL.WHOAMI_COMMAND;
  const r0 = (await runLogin({ servers: [sv], keyId: K.id, by: 'own' })).job.results[0];
  assert.notEqual(r0.code, 'uncertain', JSON.stringify(r0));
  assert.match(r0.reason, /서버에서 바꾼 것은 없습니다/);
  // 거두기 — 지우는 명령을 보낸 뒤 답이 없으면 uncertain(‘지워졌는지 서버에서 확인’)
  S.clear();
  S.writeAk(`${K.pub} portal-ssh:${K.id}\n`);
  S.st.rejectExec = (cmd) => scriptOf(cmd).includes(K.blob);
  const rv = (await runRevoke({ keyId: K.id, servers: [sv], by: 'own' })).job.results[0];
  assert.deepEqual([rv.ok, rv.code], [false, 'uncertain'], JSON.stringify(rv));
  assert.match(rv.reason, /지우는 명령은 보냈지만 결과를 받지 못했습니다/);
});

test('⑫-h 바꾸는 명령이 서버에서 끝까지 돈 뒤 종료 코드 · 출력 없이 연결이 끊기면 — ‘서버에서 바꾼 것은 없습니다’ 라고 하지 않고 uncertain(실제로는 줄이 들어갔다 — 점검 B-F3 의 남은 경로 · 테스트 갱신 중 발견해 19ce2ac1 에서 고침) · 되돌림 · 거두기도 같다', async () => {
  const S = await fakeSshd();
  S.st.password = secret('Pw-Drop-Stored-12h');
  const K = mkKey('kl-drop');
  const sv = mkServer('bm-kl-drop', S, { password: S.st.password });
  S.writeAk(`${OTHER}\n`);
  // ① 넣는 명령 — 서버에서는 끝까지 돌고(줄이 들어감) 답이 끊긴다(exec 는 code 없이 resolve 한다)
  S.st.dropExec = (cmd) => lineInScript(scriptOf(cmd)).includes(K.blob) && scriptOf(cmd).includes("RP='");
  const r = (await runLogin({ servers: [sv], keyId: K.id, by: 'own' })).job.results[0];
  assert.ok(S.readAk().includes(`portal-ssh:${K.id}`), '전제 — 서버에서는 줄이 들어갔다');
  assert.deepEqual([r.ok, r.code, r.via], [false, 'uncertain', 'password'], JSON.stringify(r));
  assert.match(r.reason, /서버가 결과 없이 연결을 닫았습니다/);
  assert.match(r.reason, /바뀌었을 수 있습니다/);
  assert.doesNotMatch(r.reason, /서버에서 바꾼 것은 없습니다/);
  assert.deepEqual([S.keyTries().length, rawOf(sv.id).keyRef, rawOf(sv.id).password], [0, undefined, S.st.password], '확인 · 묶기로 넘어가지 않았다');
  // 작업 요약 — 결과 모름은 ‘실패’ 가 아니다(2회차 E2-8 — 실패로 세고 실패 이름에 넣었다)
  //   결과 모름 서버는 이름을 먼저 싣는다(서버에서 직접 확인해야 한다 — 2회차 반증: 수만 있었다)
  assert.equal(eventsOf('key-job-done').find((e) => e.target.includes('kl-drop'))?.detail, '1대 — 확인 0 · 실패 0 · 결과 모름 1 — bm-kl-drop(결과 모름)', JSON.stringify(eventsOf('key-job-done').slice(0, 2)));
  // ② 확인 실패 뒤 되돌림 명령의 답이 끊겼다 → ‘지웠다’ 고도 ‘지우지 못했다’ 고도 하지 않고 **모른다** 고 말한다(rollbackUnknown — 1회차 B11)
  S.writeAk(`${OTHER}\n`); S.clear();
  S.st.ipQueue.push('127.0.0.1', '10.77.0.9');
  S.st.dropExec = (cmd, conn) => conn === 3;
  const r2 = (await runLogin({ servers: [sv], keyId: K.id, by: 'own' })).job.results[0];
  assert.deepEqual([r2.ok, r2.code, r2.line, r2.rolledBack, r2.rollbackUnknown], [false, 'key-login-failed', 'added', false, true], JSON.stringify(r2));
  assert.match(r2.reason, /더한 줄이 지워졌는지 모릅니다\(되돌림 명령의 결과를 받지 못했습니다\(연결 끊김\)\)/);
  assert.doesNotMatch(r2.reason, /지우지 못했습니다/);
  assert.equal(S.readAk(), `${OTHER}\n`, '서버에서는 되돌림이 실제로 돌았다(포탈은 확인하지 못했을 뿐)');
  // ③ 거두기 — 지우는 명령의 답이 끊겼다 → uncertain(‘없음’ · ‘실패’ 가 아니다)
  S.writeAk(`${K.pub} portal-ssh:${K.id}\n`); S.clear();
  S.st.dropExec = (cmd) => scriptOf(cmd).includes(K.blob);
  const rv = (await runRevoke({ keyId: K.id, servers: [sv], by: 'own' })).job.results[0];
  assert.deepEqual([rv.ok, rv.code, rv.via], [false, 'uncertain', 'password'], JSON.stringify(rv));
  assert.match(rv.reason, /서버가 결과 없이 연결을 닫았습니다 — 지우는 명령은 보냈으니 지워졌는지 서버에서 확인하세요/);
  // 대조 — 종료 코드가 있는데 표지가 없으면(셸이 스크립트를 받지 않음) 지금처럼 install-failed ‘바꾼 것 없음’(⑫-b · ⑫-c)
});

test('⑫-i 바꾸는 스크립트가 시작 표지만 내고 끝 표지 없이 끝나면(안쪽 셸만 신호로 죽음 — 바깥 셸은 종료 코드를 준다) uncertain · 로그인 셸이 300KB 를 찍어도 끝 표지를 읽는다(1회차 B5)', async () => {
  const S = await fakeSshd();
  S.st.password = secret('Pw-Begun-Stored-12i');
  const K = mkKey('kl-begun');
  const sv = mkServer('bm-kl-begun', S, { password: S.st.password });
  S.writeAk(`${OTHER}\n`);
  // 넣는 스크립트에만 — 시작 표지 뒤 끝 표지 없이 종료 코드 1(가짜 sshd 의 fakeOut 은 종료 코드를 준다)
  S.st.fakeOut = (cmd) => (lineInScript(scriptOf(cmd)).includes(K.blob) ? 'motd\n##KL begin\n' : null);
  const r = (await runLogin({ servers: [sv], keyId: K.id, by: 'own' })).job.results[0];
  assert.deepEqual([r.ok, r.code, r.via], [false, 'uncertain', 'password'], JSON.stringify(r));
  assert.match(r.reason, /바뀌었을 수 있습니다/);
  assert.doesNotMatch(r.reason, /서버에서 바꾼 것은 없습니다/, '예전에는 종료 코드가 있으면 ‘바꾼 것 없음’ 이었다');
  assert.equal(S.keyTries().length, 0);
  // 앞 잡음 300KB(로그인 셸 · .bashrc) — 끝의 표지를 읽어 정상으로 끝난다(예전에는 앞 200KB 만 보아 install-failed ‘바꾼 것 없음’ 인데 줄은 들어갔다)
  S.clear(); S.st.fakeOut = null; S.writeAk(`${OTHER}\n`);
  S.st.banner = () => `${'z'.repeat(300_000)}\n`;
  const r2 = (await runLogin({ servers: [sv], keyId: K.id, by: 'own' })).job.results[0];
  assert.deepEqual([r2.ok, r2.line, r2.restricted], [true, 'added', true], JSON.stringify(r2).slice(0, 400));
  assert.ok(S.readAk().includes(`portal-ssh:${K.id}`));
});

test('⑫-j mv 뒤 다시 읽어 원하는 상태가 아니면(그 사이 자물쇠를 모르는 쪽이 바꿈) — 넣기 · 거두기 모두 uncertain(mv 는 했으니 ‘바꾼 것 없음’ 꼬리를 붙이지 않는다 — 1회차 B9 · 결과는 받았으니 ‘결과를 받지 못했습니다’ 도 아니다 — 1회차 반증 12)', async () => {
  const S = await fakeSshd();
  S.st.password = secret('Pw-Raced-Stored-12j');
  const K = mkKey('kl-raced');
  const sv = mkServer('bm-kl-raced', S, { password: S.st.password });
  const raceBin = fakeBin('race');
  S.writeAk(`${OTHER}\n`);
  fs.writeFileSync(path.join(S.home, 'race-content'), `${OTHER}\n`);   // mv 직후 다른 쪽이 우리 줄을 지운 내용으로 덮는다
  S.st.path = raceBin;
  const r = (await runLogin({ servers: [sv], keyId: K.id, by: 'own' })).job.results[0];
  assert.deepEqual([r.ok, r.code, r.via], [false, 'uncertain', 'password'], JSON.stringify(r));
  // 결과(raced)는 받았다 — ‘결과를 받지 못했습니다’ 꼬리를 붙이지 않는다(1회차 반증 12). 포탈은 서버를 그 키에 묶지 않았다.
  assert.equal(r.reason, `${KL.failText('raced')} 포탈의 서버 설정은 바꾸지 않았습니다.`, r.reason);
  assert.doesNotMatch(r.reason, /결과를 받지 못했습니다/);
  assert.doesNotMatch(r.reason, /서버에서 바꾼 것은 없습니다/, '예전에는 mv 를 한 뒤인데 ‘바꾼 것 없음’ 이라 했다');
  assert.deepEqual([S.keyTries().length, rawOf(sv.id).keyRef], [0, undefined]);
  // 거두기 — mv 직후 다른 쪽이 포탈 줄을 다시 넣었다 → removed 가 아니라 uncertain
  S.clear(); S.st.path = raceBin;
  const portal = `${K.pub} portal-ssh:${K.id}`;
  S.writeAk(`${portal}\n`);
  fs.writeFileSync(path.join(S.home, 'race-content'), `${portal}\n`);
  const rv = (await runRevoke({ keyId: K.id, servers: [sv], by: 'own' })).job.results[0];
  assert.deepEqual([rv.ok, rv.code, rv.why, rv.via], [false, 'uncertain', 'raced', 'password'], JSON.stringify(rv));
  assert.match(rv.reason, /지워졌는지 서버에서 확인하세요/);
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
  assert.equal((await SVC.startKeyLogin({ servers: [sv], keyId: kNew.id, replaceKeyId: kNew.id, by: 'own' })).code, 'same-key');
  assert.equal((await SVC.startKeyLogin({ servers: [sv], keyId: kNew.id, replaceKeyId: 'k_000000000000', by: 'own' })).code, 'key-missing');
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
  const rmConn = S.st.execs.filter((x) => scriptOf(x.command).includes(kOld.blob)).map((x) => x.conn);   // 명령은 싼 한 줄 — 풀어서 본다
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
  const none = await SVC.startKeyLogin({ servers: [stale, { id: 'nope', addr: 'x' }, { id: sv.id }], keyId: K.id, by: 'own' });
  assert.deepEqual([none.ok, none.code, none.skipped.map((x) => x.code)], [false, 'empty', ['moved', 'not-found', 'moved']], JSON.stringify(none));
  assert.equal((await SVC.startKeyLogin({ servers: [], keyId: K.id, by: 'own' })).code, 'empty');
  assert.equal((await SVC.startKeyLogin({ servers: [sv], keyId: 'k_000000000000', by: 'own' })).code, 'key-missing');
  // 키 상태 — 작업을 만들기 전에 거절
  const kPend = mkKey('kl-refuse-pending', { pending: true });
  const kRet = mkKey('kl-refuse-retired'); assert.ok(KS.markKeyRetired(kRet.id).ok);
  const kTam = mkKey('kl-refuse-tampered'); KS.markKeyIntegrity(kTam.id, false);
  assert.deepEqual((({ code, status }) => [code, status])(await SVC.startKeyLogin({ servers: [sv], keyId: kPend.id, by: 'own' })), ['key-pending', 409]);
  assert.equal((await SVC.startKeyLogin({ servers: [sv], keyId: kRet.id, by: 'own' })).code, 'key-retired');
  assert.equal((await SVC.startKeyLogin({ servers: [sv], keyId: kTam.id, by: 'own' })).code, 'key-tampered');
  KS.markKeyIntegrity(kTam.id, true);
  assert.ok(KS._removeKey(kPend.id).ok);
  // 서버마다 — 엣지 위임 · 폴더 밖 키 · 사용 중지: 작업은 돌지만 그 서버에는 붙지 않는다
  const kB = mkKey('kl-refuse-vcb', { folderCorp: 'vcB' });
  const { start, job } = await runLogin({ servers: [stale, svEdge], keyId: K.id, by: 'own' });
  assert.deepEqual([start.total, start.skipped.map((x) => [x.name, x.code]), job.meta.skipped.length], [1, [['bm-kl5-moved', 'moved']], 1]);
  assert.deepEqual(job.results.map((x) => [x.name, x.ok, x.code]), [['bm-kl5-edge', false, 'edge-delegated']]);
  const rB = (await runLogin({ servers: [sv], keyId: kB.id, by: 'own' })).job.results[0];
  assert.deepEqual([rB.ok, rB.code], [false, 'key-folder']);
  assert.equal((await SVC.stopCorp('vcA', { by: 'own', reason: '시험' })).ok, true);
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

test('⑭-b 엣지 재배포가 키를 떼지 않는다 — 엣지에서 키 로그인 설정(키 묶기 · 저장 비밀번호 지우기)을 한 서버에 중앙 배포의 ‘개별:같은 계정’ 행이 다시 적용돼도 키가 남는다 · 계정이 바뀐 행은 그대로 뗀다(점검 D-3)', {}, () => {
  const j = subRun({ owners: 'adm', users: [{ username: 'adm', role: 'admin', totpEnabled: true, totpSecret: generateSecret() }], code: `
    const VAULT = await imp('security/secretVault.js'); VAULT.saveSecretsPolicy({ mode: 'encrypted', level: 1 });
    const KS = await imp('bmusage/onboard/keyStore.js'); const BM = await imp('bmstor/registry.js'); const REFS = await imp('bmusage/onboard/refs.js'); const EA = await imp('bmusage/onboard/edgeApply.js');
    const K = KS.addKey({ name: 'edge-key', privateKey: F.ed25519Key().pem }, { by: 'adm' }).key;
    const corps = [{ id: 'vcA', name: 'KR-SEL' }];
    const row = (note, osUser = 'mon') => ({ name: 'bm-e1', corp: 'vcA', osHost: '10.30.0.5', osPort: 22, osCred: '', osUser, osKey: '', mounts: ['/'], enabled: true, note, bindOk: true });
    const apply = (rows, sig) => EA.applyEdgeDeployment(rows, { sig, corps, myCorps: ['vcA'], currentTargets: async () => ({ targets: [], skipped: [] }) });
    const cur = () => BM.listBmServersRaw().find((x) => x.name === 'bm-e1');
    const out = {};
    out.first = (await apply([row('v1')], 'sig-1')).applied;
    BM.saveBmServer({ ...cur(), password: 'Edge-Pw-1' });   // 엣지 관리자가 비밀번호를 넣었다(배포 행에는 비밀번호가 없다)
    // 엣지에서 키 로그인 설정 — service.js bindKey · clearPassword 와 같은 등록부 쓰기
    out.bind = BM.setBmServerKeyRef(cur().id, K.id, {}).ok; out.clear = BM.clearBmServerPassword(cur().id, {}).ok;
    out.before = { key: cur().keyRef === K.id, hasPw: !!cur().password };
    // 중앙 배포 목록이 다른 칸(메모)만 바뀌어 다시 적용됐다
    out.redeployApplied = (await apply([row('v2')], 'sig-2')).applied;
    const ra = REFS.resolveOsAuth(cur(), { feature: 'bm-usage' });
    out.after = { key: cur().keyRef === K.id, hasPw: !!cur().password, auth: ra.ok, authKind: ra.authKind || '', note: cur().note || '' };
    // 같은 계정이지만 주소를 옮긴 행 — 키를 새 주소로 잇지 않는다(1회차 D1 — 같은 접속처일 때만 유지 · 주소가 바뀌면 keyRef 승계 없음)
    out.movedApplied = (await apply([{ ...row('v2b'), osHost: '10.30.0.6' }], 'sig-2b')).applied;
    out.moved = { host: cur().host, key: !!cur().keyRef };
    // 계정이 바뀐 행 — 키를 잇지 않는다(접속처가 바뀌면 승계 없음)
    out.otherApplied = (await apply([row('v3', 'root')], 'sig-3')).applied;
    out.other = { key: !!cur().keyRef, username: cur().username };
    console.log(JSON.stringify(out));
  ` });
  assert.deepEqual([j.first, j.bind, j.clear, j.before], [1, true, true, { key: true, hasPw: false }], JSON.stringify(j));
  assert.deepEqual([j.redeployApplied, j.after.key, j.after.auth, j.after.authKind], [1, true, true, 'key'], `재배포 뒤에도 키로 접속한다(예전 판은 키를 떼 인증 수단 없이 남았다) ${JSON.stringify(j.after)}`);
  assert.deepEqual([j.movedApplied, j.moved], [1, { host: '10.30.0.6', key: false }], '주소를 옮긴 행은 키를 새 주소에 잇지 않는다(1회차 D1)');
  assert.deepEqual([j.otherApplied, j.other], [1, { key: false, username: 'root' }]);
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
  {}, async () => {
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
  await N._flushKeyNotifyForTest();
  const m0 = MAILS.length;
  const { job } = await runRevoke({ keyId: K.id, servers: [sv], by: 'own' });
  assert.deepEqual([job.kind, job.meta.keyName, job.total], ['key-revoke', 'rv-key', 1]);
  const r = job.results[0];
  assert.deepEqual([r.ok, r.code, r.removed, r.unmarked, r.pinned], [true, 'removed', 2, 1, false], JSON.stringify(r));
  assert.equal(S.readAk(), keep);
  assert.notEqual(fs.statSync(S.akFile).ino, ino, '점검 B-F1 — 임시 파일을 검증한 뒤 mv 로 바꾼다(예전 판의 ‘inode 유지’ 기대를 뒤집음)');
  assert.deepEqual(S.passwordTries().length, 1);
  const ev = eventsOf('key-lines-removed').find((e) => e.target.includes('bm-rv1'));
  assert.ok(ev && ev.by === 'own' && ev.detail === '2줄', JSON.stringify(ev));
  // 작업 요약 사건 하나(중요 사건 · 메일 한 통) — 서버마다의 key-lines-removed 는 중요 사건도 메일도 아니다(점검 C-3 · C-4)
  const done = eventsOf('key-revoke-done').find((e) => e.target === 'rv-key');
  assert.ok(done && done.by === 'own' && /^1대 — 지움 1 · 줄 없음 0 · 실패 0/.test(done.detail), JSON.stringify(done));
  assert.deepEqual([ST.CRITICAL_EVENTS.includes('key-revoke-done'), ST.CRITICAL_EVENTS.includes('key-lines-removed'), ST.CRITICAL_EVENTS.includes('key-login-set')], [true, false, false]);
  await N._flushKeyNotifyForTest();
  const mailText = MAILS.slice(m0).map((m) => m.text).join('\n');
  assert.match(mailText, /서버에서 키 거두기 끝남 · rv-key · own — 1대 — 지움 1/, '작업 요약 한 통');
  assert.doesNotMatch(mailText, /bm-rv1 · rv-key/, '서버마다의 거둠 사건은 메일에 없다');
  // 다시 — 지울 포탈 줄이 없다
  const r2 = (await runRevoke({ keyId: K.id, servers: [sv], by: 'own' })).job.results[0];
  assert.deepEqual([r2.ok, r2.code, r2.removed, r2.unmarked], [true, 'not-present', 0, 1]);
  assert.equal(S.readAk(), keep);
  assert.equal(eventsOf('key-lines-removed').filter((e) => e.target.includes('bm-rv1')).length, 1, '지운 것이 없으면 사건을 남기지 않는다');
  // authorized_keys 가 없는 계정
  fs.rmSync(S.akFile);
  const r3 = (await runRevoke({ keyId: K.id, servers: [sv], by: 'own' })).job.results[0];
  assert.deepEqual([r3.ok, r3.code, r3.removed], [true, 'none', 0]);
  // authorized_keys 가 심볼릭 링크 — ‘없음’ 이 아니라 실패로 말한다(점검 B-F2b — 예전 판은 none 으로 성공처럼 끝나고 그 키로 계속 들어갔다) · 가리키는 파일은 그대로
  const target = path.join(S.home, 'keys-elsewhere');
  fs.writeFileSync(target, `${K.pub} portal-ssh:${K.id}\n`); fs.symlinkSync(target, S.akFile);
  const r5j = (await runRevoke({ keyId: K.id, servers: [sv], by: 'own' })).job;
  const r5 = r5j.results[0];
  assert.deepEqual([r5.ok, r5.code, r5.why], [false, 'revoke-failed', 'symlink'], JSON.stringify(r5));
  assert.match(r5.reason, /심볼릭 링크라 건드리지 않았습니다/);
  assert.equal(fs.readFileSync(target, 'utf8'), `${K.pub} portal-ssh:${K.id}\n`);
  assert.ok(eventsOf('key-revoke-done').some((e) => /실패 1 — bm-rv1\(revoke-failed\)/.test(e.detail)), '요약에 실패한 서버 이름');
  fs.rmSync(S.akFile);
  // 비밀번호가 틀리면 한 번만 · 파일 그대로
  S.writeAk(`${K.pub} portal-ssh:${K.id}\n`); S.st.password = 'Changed-On-Server'; S.clear();
  const r4 = (await runRevoke({ keyId: K.id, servers: [sv], by: 'own' })).job.results[0];
  assert.deepEqual([r4.ok, r4.code], [false, 'auth-rejected']);
  assert.equal(S.passwordTries().length, 1);
  assert.equal(S.readAk(), `${K.pub} portal-ssh:${K.id}\n`);
  // 입력 판정
  assert.equal((await SVC.startKeyRevoke({ keyId: 'k_000000000000', servers: [sv], by: 'own' })).code, 'key-missing');
  assert.equal((await SVC.startKeyRevoke({ keyId: K.id, by: 'own' })).code, 'bad-corp');
  assert.equal((await SVC.startKeyRevoke({ keyId: K.id, servers: [{ id: sv.id, addr: 'x' }], by: 'own' })).skipped[0].code, 'moved');
});

test('⑯-b 거둔 뒤 ‘이 서버는 아직 이 키로 접속하도록 설정됨’(pinned)은 법인 기본 키(공통 계정)를 따르는 서버도 센다(점검 B-F9)', async () => {
  const S = await fakeSshd();
  const K = mkKey('rv-acc-key');
  const acc = KS.saveAccount({ name: 'rv-acc', kind: 'os', corp: 'vcA', username: 'svc', keyRef: K.id }, { by: 'fixture' });
  assert.ok(acc.ok, JSON.stringify(acc));
  const sv = mkServer('bm-rv-acc', S, { credRef: acc.account.id, bindApproved: true });
  S.writeAk(`${OTHER}\n${K.pub} portal-ssh:${K.id}\n`);
  const r = (await runRevoke({ keyId: K.id, servers: [sv], by: 'own' })).job.results[0];
  assert.deepEqual([r.ok, r.code, r.removed, r.pinned], [true, 'removed', 1, true], JSON.stringify(r));
  assert.equal(S.readAk(), `${OTHER}\n`);
  assert.equal(KL.serverUsesKey(rawOf(sv.id), K.id), true);
  assert.equal(KL.serverUsesKey({ ...rawOf(sv.id), osAuth: 'password' }, K.id), false, '비밀번호 방식으로 고정한 서버는 아니다');
  assert.equal(KL.serverUsesKey({ ...rawOf(sv.id), keyRef: 'k_000000000000' }, K.id), false, '이름 고정이 다른 키면 아니다');
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
  const eo = await SVC.startKeyRevoke({ keyId: K.id, corp: 'vcE', by: 'own' });
  assert.deepEqual([eo.ok, eo.code, eo.skipped.map((x) => x.code)], [false, 'empty', ['edge-delegated']]);
  void a; void b;
  // 법인 키 사용 중지 중 — 그 키로만 붙는 서버는 키로 접속하지 않는다(안내) · 1회 비밀번호를 넣으면 거둔다
  S3.writeAk(`${line}\n${OTHER}\n`); S3.clear();
  assert.equal((await SVC.stopCorp('vcR', { by: 'own', reason: '유출 의심' })).ok, true);
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

/** S 에서 pred 에 맞는 명령을 붙잡아 둔다(느린 서버) — reached = 붙잡힌 때 · release() = 놓기. 테스트가 중간에 실패해도 놓는다(afterEach — 붙잡힌 접속이 파일 전체를 멈추지 않게). */
function holdExec(S, pred) {
  let release; const held = new Promise((r) => { release = r; });
  HELD.push(() => release());
  let entered; const hit = new Promise((r) => { entered = r; });
  S.st.gate = async (cmd) => { if (pred(cmd)) { entered(); await held; } };
  // 붙잡을 명령이 오지 않으면(작업이 시작되지 않음 등) 영원히 기다리지 않고 실패한다
  let timer;
  const reached = Promise.race([hit, new Promise((_r, rej) => { timer = setTimeout(() => rej(new Error('붙잡을 명령이 15초 안에 오지 않았다')), 15_000); timer.unref?.(); })]).finally(() => clearTimeout(timer));
  return { reached, release };
}
/** 그 키 넣기 명령(넣을 줄 L 이 든 스크립트)을 붙잡는다. */
const holdInstall = (S, K) => holdExec(S, (cmd) => scriptOf(cmd).includes(K.blob) && !!lineInScript(scriptOf(cmd)));
/** 그 키 거두기 명령(공개키는 있고 넣을 줄은 없는 스크립트)을 붙잡는다. */
const holdRevoke = (S, K) => holdExec(S, (cmd) => scriptOf(cmd).includes(K.blob) && !lineInScript(scriptOf(cmd)));

test('⑰-b 작업 칸은 넣기 · 거두기 따로 — 넣기 작업이 도는 동안에도 거두기가 바로 돈다 · 같은 키 거두기는 넣기 작업을 멈춘다(지금 서버는 끝까지 · 남은 서버는 cancelled · stopped) · 끝나면 요약 사건(점검 C-2 · B-F8)', async () => {
  const S1 = await fakeSshd(); const S2 = await fakeSshd(); const S3 = await fakeSshd(); const S4 = await fakeSshd();
  const pw = secret('Pw-Jobs-Stored-17b');
  for (const S of [S1, S2, S3, S4]) S.st.password = pw;
  const K = mkKey('job-key'); const K2 = mkKey('job-other');
  const [s1, s2, s3, s4] = [S1, S2, S3, S4].map((S, i) => mkServer(`bm-job${i + 1}`, S, { password: pw }));
  const h = holdInstall(S1, K);
  const st = await SVC.startKeyLogin({ servers: [s1, s2], keyId: K.id, by: 'own' });
  assert.equal(st.ok, true, JSON.stringify(st));
  await h.reached;
  assert.deepEqual([KL.busyJob('key-login'), KL.busyJob('key-revoke')], [st.jobId, '']);
  // ① 다른 키 거두기 — 넣기 작업에 막히지 않고 끝까지 돈다(예전 판은 409 busy — 긴급 조치가 넣기 작업 뒤에 줄 섰다)
  S3.writeAk(`${K2.pub} portal-ssh:${K2.id}\n`);
  const rv = await runRevoke({ keyId: K2.id, servers: [s3], by: 'own2' });
  assert.deepEqual([rv.start.stopped, rv.job.results[0].code], [undefined, 'removed'], JSON.stringify(rv.job.results));
  assert.equal(SVC.keyJob(st.jobId).running, true, '넣기 작업은 아직 도는 중(다른 키 거두기는 멈추지 않는다)');
  // ② 같은 키 거두기 — 넣기 작업을 멈춘다(거둔 키를 뒤 서버에 다시 넣지 않게) · 거두기 자신은 바로 돈다
  S4.writeAk(`${K.pub} portal-ssh:${K.id}\n`);
  const rv2 = await SVC.startKeyRevoke({ keyId: K.id, servers: [s4], by: 'own2' });
  assert.deepEqual([rv2.ok, rv2.stopped], [true, st.jobId], JSON.stringify(rv2));
  assert.equal((await waitJob(rv2.jobId)).results[0].code, 'removed');
  assert.deepEqual([SVC.keyJob(st.jobId).cancelled, SVC.keyJob(st.jobId).running], [true, true], '지금 서버(붙잡힌 S1)는 끝까지 한다 — 되돌림을 끊지 않는다');
  h.release();
  const j1 = await waitJob(st.jobId);
  assert.deepEqual(j1.results.map((r) => [r.name, r.ok, r.code]), [['bm-job1', true, 'ok'], ['bm-job2', false, 'cancelled']], JSON.stringify(j1.results));
  assert.match(j1.results[1].reason, /같은 키 거두기가 시작됨/);
  assert.deepEqual([j1.cancelled, j1.cancelledBy], [true, 'own2']);
  assert.equal(S2.st.conns, 0, '멈춘 뒤 남은 서버에는 붙지 않았다');
  assert.ok(eventsOf('key-job-done').some((e) => e.target.includes('job-key') && /2대 — 확인 1 · 실패 0 · 하지 않음 1 · 멈춘 사람 own2$/.test(e.detail) && /멈춘 사람 own2/.test(e.detail)), JSON.stringify(eventsOf('key-job-done')));
  // 같은 서버는 한 번에 한 작업만 — 넣기가 붙잡힌 서버의 거두기는 그 서버가 끝난 뒤에 돈다(서버 자물쇠). 열쇠는 접속처(주소:포트)라
  //   같은 서버를 가리키는 **다른 등록부 항목**(계정만 다름)으로 보내도 기다린다(반증 R1 — 항목 id 로 잡으면 같은 파일을 동시에 바꿨다).
  assert.deepEqual([KL.serverLockKey({ host: ' Bm-A1.Corp ', port: '2222' }), KL.serverLockKey({ host: '10.0.0.1' })], ['bm-a1.corp:2222', '10.0.0.1:22']);
  const s1b = mkServer('bm-job1-other-entry', S1, { username: 'mon-b', password: pw });
  S1.st.gate = null; S1.writeAk(`${K2.pub} portal-ssh:${K2.id}\n`);
  const h2 = holdInstall(S1, K);
  const st2 = await SVC.startKeyLogin({ servers: [s1], keyId: K.id, by: 'own' });
  assert.equal(st2.ok, true, JSON.stringify(st2));
  await h2.reached;
  const rv3 = await SVC.startKeyRevoke({ keyId: K2.id, servers: [s1b], by: 'own2' });
  await sleep(150);
  assert.deepEqual([SVC.keyJob(rv3.jobId).running, SVC.keyJob(rv3.jobId).done], [true, 0], '같은 접속처의 거두기는 넣기가 끝나기를 기다린다');
  h2.release();
  await waitJob(st2.jobId);
  assert.equal((await waitJob(rv3.jobId)).results[0].code, 'removed');
  assert.equal(S1.readAk().includes(`portal-ssh:${K2.id}`), false);
});

test('⑰-c 멈추기 라우트는 OTP 없이 소유자 등급만(줄이는 방향) · 권한 없는 계정 403 · 끝난 작업 409 · 없는 작업 404 · 진행 중이면 시작 라우트는 OTP 를 쓰기 전에 409 busy · 화면은 칸마다 마지막 작업(lastJobs) · 서버 · 키는 그 서버 차례에 다시 읽는다(moved · key-changed · 묶기 직전 퇴역 확인)', async () => {
  const S1 = await fakeSshd(); const S2 = await fakeSshd(); const S3 = await fakeSshd();
  const pw = secret('Pw-Cancel-Stored-17c');
  for (const S of [S1, S2, S3]) S.st.password = pw;
  const K = mkKey('job-cancel');
  const [s1, s2, s3] = [S1, S2, S3].map((S, i) => mkServer(`bm-jc${i + 1}`, S, { password: pw }));
  const code = await otp('own4'); const c7 = await otp('own7');   // OTP 코드는 붙잡기 전에 받는다 — otp() 가 창(30초)을 기다리면 붙잡힌 접속이 exec 시한(20초)을 넘겨 작업이 끝난다(검증 중 실측 — ㉑-c 7b 삭제가 200 으로 지나갔다)
  const h = holdInstall(S1, K);
  const st = await SVC.startKeyLogin({ servers: [s1, s2, s3], keyId: K.id, by: 'own' });
  assert.equal(st.ok, true, JSON.stringify(st));
  await h.reached;
  // 같은 칸 작업이 도는 중 — 시작 라우트는 OTP 앞에서 409(그 코드는 쓰이지 않는다)
  const busy = await call('own4', 'POST', '/settings/ssh-access/key-login', { servers: [s2], keyId: K.id, otp: code });
  assert.deepEqual([busy.s, busy.j.code, busy.j.jobId, busy.j.needOtp], [409, 'busy', st.jobId, undefined], busy.txt);
  assert.equal(AUTH.verifyUserOtp('own4', code).ok, true, 'busy 거절이 OTP 를 소모하지 않았다');
  // 화면 — 칸마다 마지막 작업(진행 중)
  const v = await call('own', 'GET', '/settings/ssh-access');
  assert.deepEqual([v.j.jobs.install?.id, v.j.jobs.install?.running, v.j.jobs.install?.total, v.j.jobs.install?.by, v.j.jobs.install?.keyName], [st.jobId, true, 3, 'own', 'job-cancel'], v.txt.slice(0, 300));
  assert.ok(Array.isArray(v.j.jobs.revokes), '거두기 작업 목록 칸은 늘 있다');
  // 멈추기 — 권한 없는 계정 403 · 범위 소유자 403 · 소유자 등급은 OTP 없이
  const curl = `/settings/ssh-access/jobs/${st.jobId}/cancel`;
  assert.equal((await call('adm', 'POST', curl, {})).s, 403);
  assert.equal((await call('sown', 'POST', curl, {})).s, 403);
  assert.equal(SVC.keyJob(st.jobId).cancelled, false, '거절된 멈추기는 작업을 바꾸지 않았다');
  const c = await call('own3', 'POST', curl, {});
  assert.deepEqual([c.s, c.j.ok, c.j.jobId], [200, true, st.jobId], c.txt);
  assert.equal(SVC.keyJob(st.jobId).running, true, '지금 서버는 끝까지(되돌림을 끊지 않는다)');
  h.release();
  const j = await waitJob(st.jobId);
  assert.deepEqual(j.results.map((r) => r.code), ['ok', 'cancelled', 'cancelled'], JSON.stringify(j.results));
  assert.match(j.results[1].reason, /own3 이\(가\) 멈춤/);
  assert.deepEqual([j.cancelled, j.cancelledBy, S2.st.conns, S3.st.conns], [true, 'own3', 0, 0]);
  const again = await call('own3', 'POST', curl, {});
  assert.deepEqual([again.s, again.j.code], [409, 'done']);
  assert.deepEqual([(await call('own3', 'POST', '/settings/ssh-access/jobs/kj_000000000000/cancel', {})).s], [404]);
  const v2 = await SVC.buildView();
  assert.deepEqual([v2.jobs.install.id, v2.jobs.install.running, v2.jobs.install.done], [st.jobId, false, 3], '끝난 뒤에도 화면이 결과를 이어 본다(점검 E-2)');
  assert.ok(eventsOf('key-job-cancel').some((e) => e.by === 'own3' && e.target === st.jobId));
  const chg = await call('own', 'GET', '/settings/ssh-access/changes');
  assert.ok(chg.j.items.some((e) => e.action === 'ssh-access.key-job.cancel'), '멈추기도 감사에 남는다');
  // 거두기 작업을 멈추는 것은 OTP — 유출 키가 남은 서버에 그대로 남는다(줄이는 방향이 아니다 · 반증 D1). 넣기 작업 멈추기만 OTP 없이.
  for (const S of [S2, S3]) { S.clear(); S.writeAk(`${K.pub} portal-ssh:${K.id}\n`); }
  const hr = holdRevoke(S2, K);
  const rv = await SVC.startKeyRevoke({ keyId: K.id, servers: [s2, s3], by: 'own' });
  assert.equal(rv.ok, true, JSON.stringify(rv));
  await hr.reached;
  assert.equal(SVC.keyJobKind(rv.jobId), 'key-revoke');
  const rcurl = `/settings/ssh-access/jobs/${rv.jobId}/cancel`;
  const noOtp = await call('own3', 'POST', rcurl, {});
  assert.deepEqual([noOtp.s, noOtp.j.needOtp], [403, true], noOtp.txt);
  assert.equal(SVC.keyJob(rv.jobId).cancelled, false);
  const rc = await call('own7', 'POST', rcurl, { otp: c7 });
  assert.deepEqual([rc.s, rc.j.ok], [200, true], rc.txt);
  hr.release();
  const rj = await waitJob(rv.jobId);
  assert.deepEqual(rj.results.map((r) => [r.name, r.code]), [['bm-jc2', 'removed'], ['bm-jc3', 'cancelled']], JSON.stringify(rj.results));
  assert.equal(S3.readAk(), `${K.pub} portal-ssh:${K.id}\n`, '멈춘 뒤 남은 서버의 줄은 그대로(그래서 OTP 를 묻는다)');
  // 서버 · 키를 그 서버 차례에 다시 읽는다 — 시작 뒤 접속처가 바뀐 서버는 moved · 키가 퇴역되면 뒤 서버는 key-changed ·
  //   지금 서버는 키 확인 **직전에** 자격을 다시 풀어(3회차 C3-1) 퇴역 키로 확인하지 않는다(key-retired · 더한 줄을 되돌림)
  const S4 = await fakeSshd(); S4.st.password = pw;
  const s4 = mkServer('bm-jc4', S4, { password: pw });   // 아직 그 키에 묶이지 않은 서버
  for (const S of [S2, S3]) S.clear();
  const h2 = holdInstall(S4, K);
  const st2 = await SVC.startKeyLogin({ servers: [s4, s2, s3], keyId: K.id, by: 'own' });
  assert.equal(st2.ok, true, JSON.stringify(st2));
  await h2.reached;
  assert.ok(BM.saveBmServer({ ...rawOf(s2.id), username: 'mon-moved' }).ok);
  assert.ok(KS.markKeyRetired(K.id).ok);
  h2.release();
  const j2 = await waitJob(st2.jobId);
  assert.deepEqual(j2.results.map((r) => [r.name, r.code]), [['bm-jc4', 'key-retired'], ['bm-jc2', 'moved'], ['bm-jc3', 'key-changed']], JSON.stringify(j2.results));
  assert.match(j2.results[0].reason, /그 키로 확인하지 않았습니다\. 더한 줄을 지웠습니다/);
  assert.equal(j2.results[0].rolledBack, true, '퇴역한 키의 줄은 되돌린다(1회차 C1-3 — 지운 키의 줄이 서버에 남아 거둘 수 없었다)');
  assert.equal(S4.readAk().includes(K.blob), false, '서버에서 그 줄이 지워졌다');
  assert.deepEqual([rawOf(s4.id).keyRef, S4.keyTries().filter((x) => x.signed).length, S2.st.conns, S3.st.conns], [undefined, 0, 0, 0], '퇴역한 키로는 접속하지 않았고(확인 0회) · 묶지 않았고 · 뒤 서버에는 붙지 않았다');
  // 키 확인은 됐는데 묶기 직전에 퇴역됐다(확인 명령을 붙잡고 그 사이 퇴역) → 묶기 직전에 다시 보고 묶지 않는다(bind-failed · 되돌림)
  const Kb = mkKey('job-key-bindfail');
  const S5 = await fakeSshd(); S5.st.password = pw;
  const s5 = mkServer('bm-jc5', S5, { password: pw });
  const h3 = holdExec(S5, (cmd) => scriptOf(cmd).includes('##KLV'));
  const st3 = await SVC.startKeyLogin({ servers: [s5], keyId: Kb.id, by: 'own' });
  assert.equal(st3.ok, true, JSON.stringify(st3));
  await h3.reached;
  assert.ok(KS.markKeyRetired(Kb.id).ok);
  h3.release();
  const j3 = await waitJob(st3.jobId);
  assert.deepEqual([j3.results[0].code, j3.results[0].rolledBack, rawOf(s5.id).keyRef, S5.readAk().includes(Kb.blob)], ['bind-failed', true, undefined, false], JSON.stringify(j3.results));
  assert.match(j3.results[0].reason, /그 사이 키가 퇴역 · 삭제돼 서버 설정에 적지 않았습니다\. 더한 줄을 지웠습니다/);
});

test('⑰-d 거두기는 500대까지 — 법인 단위든 골라 보낸 것이든 넘는 서버는 조용히 자르지 않고 over-limit 으로 밝힌다(점검 C-1 · E-10 · 반증 R6) · 넣기는 100대 초과면 too-many · 데모(mock) 모드는 넣기 · 거두기를 시작하지 않는다(demo)', {}, () => {
  const solo = { username: 'solo', role: 'admin', totpEnabled: true, totpSecret: generateSecret() };
  const j = subRun({ owners: 'solo', users: [solo], code: `
    const VAULT = await imp('security/secretVault.js'); VAULT.saveSecretsPolicy({ mode: 'encrypted', level: 1 });
    const KS = await imp('bmusage/onboard/keyStore.js'); const BM = await imp('bmstor/registry.js'); const SVC = await imp('sshaccess/service.js'); const KL = await imp('sshaccess/keyLogin.js');
    const ST = await imp('sshaccess/state.js');
    const k = KS.addKey({ name: 'ol-key', privateKey: F.ed25519Key().pem, folderCorp: 'vcO' }, { by: 'x' }).key;
    const n = KL.MAX_REVOKE_SERVERS + 3;
    const inputs = Array.from({ length: n }, (_, i) => ({ name: 'ol-' + i, host: '10.77.' + Math.floor(i / 250) + '.' + ((i % 250) + 1), username: 'mon', mounts: ['/'], vcenterId: 'vcO' }));
    inputs.push({ name: 'ol-edge', host: '10.78.0.1', username: 'mon', mounts: ['/'], vcenterId: 'vcO', agent: 'edge-o' });
    const b = BM.applyBmServerBatch(inputs);
    const r = await SVC.startKeyRevoke({ keyId: k.id, corp: 'vcO', by: 'solo' });
    // 작업 도중에 타이머가 돌 틈이 있는가(서버마다 setImmediate 양보 — 1회차 C1-1: SSH 전에 바로 실패하는 500대가 한 턴에 돌아 포탈이 수 초 멈췄다) ·
    //   서버마다의 사건은 작업 끝에 한 번에 쓴다(도중에는 없다)
    let mid = 0; let evMid = 0;
    const iv = setInterval(() => { const x = SVC.keyJob(r.jobId); if (x && !x.doneAt && x.done > 0 && x.done < x.total) { mid += 1; evMid = Math.max(evMid, ST.listEvents({ limit: 300 }).filter((e) => e.kind === 'key-lines-removed').length); } }, 1);
    let v = null;
    for (let i = 0; i < 600; i += 1) { v = SVC.keyJob(r.jobId); if (v && v.doneAt) break; await new Promise((x) => setTimeout(x, 20)); }
    clearInterval(iv);
    const lr = ST.listEvents({ limit: 300 }).filter((e) => e.kind === 'key-lines-removed');
    const done1 = ST.listEvents({ limit: 300 }).filter((e) => e.kind === 'key-revoke-done');
    const codes = {}; for (const x of v.results) codes[x.code] = (codes[x.code] || 0) + 1;
    // 골라 보낸 거두기(화면이 본 접속처와 함께) — 예전 판은 101대에서 조용히 잘랐다(반증 R6)
    const addrOf = new Map((await SVC.buildView()).servers.map((x) => [x.id, x.addr]));
    const picked = BM.listBmServersRaw().filter((x) => x.vcenterId === 'vcO' && !x.agent).map((x) => ({ id: x.id, addr: addrOf.get(x.id) }));
    const r2 = await SVC.startKeyRevoke({ keyId: k.id, servers: picked, by: 'solo' });
    let v2 = null;
    for (let i = 0; i < 600; i += 1) { v2 = SVC.keyJob(r2.jobId); if (v2 && v2.doneAt) break; await new Promise((x) => setTimeout(x, 20)); }
    // 넣기는 100대까지(101대째가 오면 작업이 too-many 로 거절)
    const r3 = await SVC.startKeyLogin({ servers: picked.slice(0, KL.MAX_JOB_SERVERS + 2), keyId: k.id, by: 'solo' });
    console.log(JSON.stringify({ max: KL.MAX_REVOKE_SERVERS, batch: b.ok, ok: r.ok, total: r.total, skipped: r.skipped.map((x) => x.code), overName: r.skipped.filter((x) => x.code === 'over-limit').map((x) => x.name),
      overReason: (r.skipped.find((x) => x.code === 'over-limit') || {}).reason || '', done: v.done, codes, metaSkipped: v.meta.skipped.length,
      picked: picked.length, ok2: r2.ok, total2: r2.total, skipped2: r2.skipped.map((x) => x.code), done2: v2?.done, ins: [r3.ok, r3.code, r3.status],
      mid, evMid, lrCount: lr.length, lrDetails: [...new Set(lr.map((e) => e.detail))], doneCount: done1.length }));
  ` });
  assert.deepEqual([j.max, j.batch, j.ok, j.total, j.done], [500, true, true, 500, 500], JSON.stringify(j).slice(0, 400));
  assert.deepEqual(j.skipped.sort(), ['edge-delegated', 'over-limit', 'over-limit', 'over-limit'], '예전 판은 100대에서 조용히 잘랐다');
  assert.equal(j.overName.length, 3);
  assert.match(j.overReason, /500대까지라 이번 작업에서 빠졌습니다/);
  assert.deepEqual([j.codes, j.metaSkipped], [{ 'no-secret': 500 }, 4], '저장된 인증 수단이 없는 서버는 붙지 않는다(시험이 실제로 접속하지 않게)');
  assert.deepEqual([j.picked, j.ok2, j.total2, j.skipped2, j.done2], [503, true, 500, ['over-limit', 'over-limit', 'over-limit'], 500], '골라 보낸 거두기도 500대 · 넘는 서버는 over-limit(반증 R6)');
  assert.deepEqual(j.ins, [false, 'too-many', 400], '넣기는 100대까지');
  // 1회차 C1-1 — 양보 · 사건 몰아 쓰기(실패 먼저 · 작업당 최대 50 + 요약)
  assert.ok(j.mid > 0, `작업 도중에 타이머가 돌았다(${j.mid}회 — 예전에는 500대가 한 턴에 돌아 0)`);
  assert.equal(j.evMid, 0, '서버마다의 사건은 도중에 쓰지 않는다(서버마다 상태 파일을 다시 쓰지 않게)');
  assert.deepEqual([j.lrCount, j.lrDetails, j.doneCount], [50, ['실패(no-secret)'], 1], '실패한 서버도 key-lines-removed ‘실패(code)’ 로 · 작업당 50개까지 + 요약 하나');
  // 데모 모드 — 서버에 접속하는 작업을 시작하지 않는다
  const d = subRun({ owners: 'solo', users: [solo], env: { DATA_SOURCE: 'mock' }, code: `
    const SVC = await imp('sshaccess/service.js'); const KL = await imp('sshaccess/keyLogin.js');
    const a = await SVC.startKeyLogin({ servers: [{ id: 'x' }], keyId: 'k_000000000000', by: 'solo' });
    const b = await SVC.startKeyRevoke({ keyId: 'k_000000000000', corp: 'vcA', by: 'solo' });
    console.log(JSON.stringify({ a: [a.ok, a.code, a.status], b: [b.ok, b.code, b.status], busy: KL.busyJob('key-login') }));
  ` });
  assert.deepEqual([d.a, d.b, d.busy], [[false, 'demo', 409], [false, 'demo', 409], '']);
});

test('⑰-e 거두기 칸은 키마다 — 다른 키의 거두기는 동시에 돈다(최대 MAX_REVOKE_JOBS) · 같은 키 거두기는 409 busy · 그 키를 거두는 중에는 넣기를 시작하지 않는다(409 revoking — 반증 R2 · D2) · 라우트 사전 검사도 body.keyId 로 본다(OTP 앞)', async () => {
  assert.equal(KL.MAX_REVOKE_JOBS, 3);
  const keys = [0, 1, 2, 3].map((i) => mkKey(`rv-slot-${i}`));
  const Ss = [];
  for (let i = 0; i < 4; i += 1) Ss.push(await fakeSshd());
  const pw = secret('Pw-RvSlot-Stored-17e');
  for (const S of Ss) S.st.password = pw;
  const svs = Ss.map((S, i) => mkServer(`bm-rvs${i}`, S, { password: pw }));
  Ss.forEach((S, i) => S.writeAk(`${keys[i].pub} portal-ssh:${keys[i].id}\n`));
  const code = await otp('own7');   // OTP 코드는 붙잡기 전에 받는다 — otp() 가 창(30초)을 기다리면 붙잡힌 접속이 exec 시한(20초)을 넘겨 작업이 끝난다(검증 중 실측 — ㉑-c 7b 삭제가 200 으로 지나갔다)
  const holds = [0, 1, 2].map((i) => holdRevoke(Ss[i], keys[i]));
  const starts = [];
  for (let i = 0; i < 3; i += 1) { const r = await SVC.startKeyRevoke({ keyId: keys[i].id, servers: [svs[i]], by: 'own' }); assert.equal(r.ok, true, JSON.stringify(r)); starts.push(r); }
  await Promise.all(holds.map((h) => h.reached));
  assert.deepEqual(starts.map((r) => SVC.keyJob(r.jobId).running), [true, true, true], '다른 키의 거두기 셋이 동시에 돈다(예전 판은 칸이 하나라 둘째부터 409 — 반증 D2)');
  // 같은 키 → busy(그 작업 id) · 넷째 키 → 동시 상한 busy
  const same = await SVC.startKeyRevoke({ keyId: keys[0].id, servers: [svs[3]], by: 'own' });
  assert.deepEqual([same.ok, same.code, same.jobId], [false, 'busy', starts[0].jobId], JSON.stringify(same));
  const fourth = await SVC.startKeyRevoke({ keyId: keys[3].id, servers: [svs[3]], by: 'own' });
  assert.deepEqual([fourth.ok, fourth.code], [false, 'busy'], JSON.stringify(fourth));
  assert.match(fourth.reason, /3개 진행 중/);
  // 그 키를 거두는 중에 넣기 → 409 revoking(거둔 키를 뒤 서버에 다시 넣지 않게 — 반증 R2: 예전에는 거두기 결과가 removed 인데 키가 모든 서버에 다시 들어갔다)
  const ins = await SVC.startKeyLogin({ servers: [svs[3]], keyId: keys[0].id, by: 'own' });
  assert.deepEqual([ins.ok, ins.code, ins.status, ins.jobId], [false, 'revoking', 409, starts[0].jobId], JSON.stringify(ins));
  assert.deepEqual([KL.busyJob('key-revoke', keys[1].id), KL.busyJob('key-login', keys[0].id), KL.busyJob('key-login', keys[3].id)], [starts[1].jobId, starts[0].jobId, '']);
  // 라우트 사전 검사 — body.keyId 로 보고 OTP 앞에서 409(코드가 쓰이지 않는다)
  const r1 = await call('own7', 'POST', '/settings/ssh-access/key-login', { servers: [svs[3]], keyId: keys[0].id, otp: code });
  assert.deepEqual([r1.s, r1.j.code], [409, 'revoking'], r1.txt);
  const r2 = await call('own7', 'POST', '/settings/ssh-access/key-revoke', { servers: [svs[3]], keyId: keys[1].id, otp: code });
  assert.deepEqual([r2.s, r2.j.code], [409, 'busy'], r2.txt);
  assert.equal(AUTH.verifyUserOtp('own7', code).ok, true, '사전 검사 거절이 OTP 를 소모하지 않았다');
  // 다른 키의 넣기는 된다(넣기 칸은 따로)
  const okIns = await SVC.startKeyLogin({ servers: [svs[3]], keyId: keys[3].id, by: 'own' });
  assert.equal(okIns.ok, true, JSON.stringify(okIns));
  await waitJob(okIns.jobId);
  // 화면 칸 — install · revoke(가장 최근 거두기) · revokes(1시간 안의 거두기 작업 — 최근 것부터 최대 5개 · 키 이름과 함께: 키마다 동시에 돌므로 하나만 보여 주면 나머지를 놓친다)
  const lj = KL.lastJobs();
  assert.deepEqual([lj.revoke?.id, lj.revoke?.keyName, lj.install?.id, lj.install?.keyName], [starts[2].jobId, 'rv-slot-2', okIns.jobId, 'rv-slot-3']);
  assert.ok(Array.isArray(lj.revokes) && lj.revokes.length <= 5, JSON.stringify(lj.revokes));
  const top3 = lj.revokes.slice(0, 3);
  assert.deepEqual(top3.map((x) => x.id).sort(), starts.map((r) => r.jobId).sort(), '진행 중인 거두기 셋이 맨 앞');
  assert.deepEqual(top3.map((x) => [x.kind, x.running, x.keyName]).sort(), [0, 1, 2].map((i) => ['key-revoke', true, `rv-slot-${i}`]));
  assert.deepEqual((await SVC.buildView()).jobs.revokes.slice(0, 3).map((x) => x.id).sort(), starts.map((r) => r.jobId).sort(), '화면(view.jobs.revokes)도 같은 목록');
  for (const h of holds) h.release();
  const done = await Promise.all(starts.map((r) => waitJob(r.jobId)));
  assert.deepEqual(done.map((j) => j.results[0].code), ['removed', 'removed', 'removed']);
});

test('⑰-f 같은 비밀번호의 거부를 센다 — 1회 비밀번호가 두 번 거부되면 작업을 멈춘다(남은 서버 cancelled) · 공통 계정 비밀번호가 한 번 거부되면 그 계정을 쓰는 나머지 서버는 auth-skipped · 키 인증 거부는 세지 않는다(디렉터리 계정 잠금 — 반증 D3) · 결과에 첫 접속 인증 방식(via)', async () => {
  const mk = async (n, pw) => { const out = []; for (let i = 0; i < n; i += 1) { const S = await fakeSshd(); S.st.password = pw; out.push(S); } return out; };
  const K = mkKey('d3-key');
  // ① 1회 비밀번호가 틀렸다(서버 넷) — 두 번 거부되면 멈춘다
  const A = await mk(4, 'Right-Pw-D3');
  const sa = A.map((S, i) => mkServer(`bm-d3a${i}`, S));
  const once = secret('Once-Wrong-D3');
  const ja = (await runLogin({ servers: sa, keyId: K.id, oncePassword: once, by: 'own' })).job;
  assert.deepEqual(ja.results.map((r) => [r.code, r.via]), [['auth-rejected', 'password-once'], ['auth-rejected', 'password-once'], ['cancelled', undefined], ['cancelled', undefined]], JSON.stringify(ja.results));
  assert.match(ja.results[2].reason, /한 번만 쓰는 비밀번호가 두 번 거부됨/);
  assert.deepEqual(A.map((S) => S.passwordTries().length), [1, 1, 0, 0], '남은 서버에는 비밀번호를 보내지 않았다');
  assert.equal(ja.cancelled, true);
  // ② 공통 계정 비밀번호가 틀렸다 — 한 번 거부되면 같은 계정 서버는 건너뛴다 · 서버 자체 비밀번호 서버는 그대로 한다
  const acc = KS.saveAccount({ name: 'd3-acc', kind: 'os', corp: 'vcA', username: 'svc', password: secret('Acc-Wrong-Pw-D3') }, { by: 'fixture' });
  assert.ok(acc.ok, JSON.stringify(acc));
  const B = await mk(3, 'Right-Pw-D3b');
  const [b1, b2, b3] = [mkServer('bm-d3b1', B[0], { credRef: acc.account.id, bindApproved: true }), mkServer('bm-d3b2', B[1], { password: 'Right-Pw-D3b' }), mkServer('bm-d3b3', B[2], { credRef: acc.account.id, bindApproved: true })];
  for (const S of B) S.writeAk(`${K.pub} portal-ssh:${K.id}\n`);
  const jb = (await runRevoke({ keyId: K.id, servers: [b1, b2, b3], by: 'own' })).job;
  assert.deepEqual(jb.results.map((r) => [r.name, r.code]), [['bm-d3b1', 'auth-rejected'], ['bm-d3b2', 'removed'], ['bm-d3b3', 'auth-skipped']], JSON.stringify(jb.results));
  assert.equal(jb.results[0].via, 'password');
  assert.match(jb.results[2].reason, /같은 공통 계정의 비밀번호가 이 작업의 다른 서버에서 거부돼/);
  assert.deepEqual([B[0].passwordTries().length, B[2].st.conns, jb.cancelled], [1, 0, false], '같은 계정의 둘째 서버에는 붙지 않았다 · 작업은 멈추지 않는다');
  // ③ 키 인증 거부는 세지 않는다 — 서버마다 키가 없을 수 있다(잠금과 무관)
  const C = await mk(2, 'unused');
  const sc = C.map((S, i) => mkServer(`bm-d3c${i}`, S, { keyRef: K.id, bindApproved: true }));
  const jc = (await runRevoke({ keyId: K.id, servers: sc, by: 'own' })).job;
  assert.deepEqual(jc.results.map((r) => [r.code, r.via]), [['auth-rejected', 'key'], ['auth-rejected', 'key']], JSON.stringify(jc.results));
  assert.deepEqual([C.map((S) => S.keyTries().length > 0), jc.cancelled], [[true, true], false]);
});

test('⑰-g 그 키를 넣는 작업이 도는 동안에는 그 키를 지우거나 회전으로 퇴역시키지 않는다 — 새 요청 · 앞서 만든 요청의 승인 실행 · 라우트 사전 검사(OTP 앞) 모두 409 key-installing · 7b 화면의 회전(from) · 삭제(:id)도 OTP 앞 409(1회차 C1-3 · 반증 — installingFirst)', async () => {
  const S = await fakeSshd();
  const pw = secret('Pw-Installing-Stored-17g');
  S.st.password = pw;
  const K = mkKey('inst-busy'); const K2 = mkKey('inst-busy-to');
  const sv = mkServer('bm-inst-busy', S, { password: pw });
  const dq = await SVC.deleteKeyReq({ keyId: K.id, by: 'own' });   // 작업 전에 만든 삭제 요청(승인 대기)
  assert.deepEqual([dq.ok, dq.pending], [true, true], JSON.stringify(dq));
  const code = await otp('own7');   // OTP 코드는 붙잡기 전에 받는다 — otp() 가 창(30초)을 기다리면 붙잡힌 접속이 exec 시한(20초)을 넘겨 작업이 끝난다(검증 중 실측 — ㉑-c 7b 삭제가 200 으로 지나갔다)
  const h = holdInstall(S, K);
  const st = await SVC.startKeyLogin({ servers: [sv], keyId: K.id, by: 'own' });
  assert.equal(st.ok, true, JSON.stringify(st));
  await h.reached;
  assert.deepEqual([KL.installingKeyId(), KL.installingKeyId() === K2.id], [K.id, false]);
  for (const r of [await SVC.deleteKeyReq({ keyId: K.id, by: 'own2' }), await SVC.rotateKeyReq({ from: K.id, to: K2.id, by: 'own' }), SVC.prechecks.deleteKey({ keyId: K.id, by: 'own2' }), SVC.prechecks.rotate({ from: K.id, to: K2.id, by: 'own' })]) {
    assert.deepEqual([r?.ok, r?.code, r?.status], [false, 'key-installing', 409], JSON.stringify(r));
  }
  // 앞서 만든 요청을 지금 승인해도 실행이 거절된다(요청은 failed)
  const ap = await SVC.decideApproval(dq.request.id, { approve: true, by: 'own2', digest: dq.request.digest });
  assert.deepEqual([ap.ok, ap.code, ap.request?.status], [false, 'key-installing', 'failed'], JSON.stringify(ap));
  // 라우트 — OTP 앞에서 409(코드가 쓰이지 않는다)
  const rr = await call('own7', 'DELETE', `/settings/ssh-access/keys/${K.id}?otp=${code}`);
  assert.deepEqual([rr.s, rr.j.code], [409, 'key-installing'], rr.txt);
  // 7b 화면(서버 사용률 › SSH 키)의 회전(from) · 삭제(:id)도 — 두 사람 승인이 꺼져 있어 그 화면이 받는 설치에서 OTP 앞 409(1회차 반증 참고 — 7b 경로는 넣는 중인 키를 보지 않았다)
  assert.ok(ST.setGuards({ twoPerson: false }, { by: 'fixture' }).ok);
  try {
    const r7r = await call('own7', 'POST', '/tools/bm-usage/ssh-keys/rotate', { from: K.id, to: K2.id, otp: code });
    const r7d = await call('own7', 'DELETE', `/tools/bm-usage/ssh-keys/${K.id}?otp=${code}`);
    assert.deepEqual([r7r.s, r7r.j.code, r7d.s, r7d.j.code], [409, 'key-installing', 409, 'key-installing'], `${r7r.txt} ${r7d.txt}`);
    const other = await call('own7', 'DELETE', `/tools/bm-usage/ssh-keys/${K2.id}`);   // 넣는 중이 아닌 키는 그 검사를 지나 OTP 에서 멈춘다(OTP 없이 — 지우지 않는다)
    assert.ok(other.s !== 409 && other.s >= 400 && KS.keyById(K2.id), `다른 키는 installingFirst 에 걸리지 않는다 ${other.s} ${other.txt}`);
  } finally { assert.ok(ST.setGuards({ twoPerson: true }, { by: 'fixture' }).ok); }
  assert.equal(AUTH.verifyUserOtp('own7', code).ok, true, '사전 검사 거절이 OTP 를 소모하지 않았다(두 화면 세 번 모두)');
  h.release();
  const j = await waitJob(st.jobId);
  assert.deepEqual([j.results[0].ok, KS.keyById(K.id)?.status, KL.installingKeyId()], [true, 'active', ''], '작업이 끝나면 칸이 빈다 · 키는 그대로');
  assert.equal(SVC.prechecks.deleteKey({ keyId: K2.id, by: 'own' }), null, '다른 키는 상관없다');
});

test('⑰-h 서버의 키 고르기는 키 작업과 같은 서버 자물쇠를 쓴다(쥐고 있으면 기다리지 않고 409 server-busy — 2회차 C2-7) · 연결 시험에 시한(withLegDeadline — 2회차 C2-2) · 고른 키가 안 돼 되돌릴 때는 내가 넣은 값이 그대로일 때만(그 사이 다른 쓰기가 바꾼 값을 옛 값으로 덮지 않는다 — 1회차 C1-2)', async (t) => {
  const S = await fakeSshd();
  const pw = secret('Pw-Choose-Stored-17h');
  S.st.password = pw;
  const kA = mkKey('choose-a'); const kB = mkKey('choose-b'); const kC = mkKey('choose-c');
  const sv = mkServer('bm-choose', S, { password: pw });
  S.writeAk(`${kA.pub} x@y\n`);   // kA 로는 접속된다 · kB 는 안 된다
  // ① 같은 서버(접속처)에 넣기 작업이 자물쇠를 쥐고 있으면 키 고르기는 기다리지 않고 409 server-busy · 등록부를 건드리지 않는다
  //    (1회차 C1-2 — 겹치면 되돌리기가 그 사이 쓰기를 덮었다 · 2회차 C2-7 — 기다리게 했더니 응답이 작업 한 대 분량을 기다렸다)
  const h = holdInstall(S, kC);
  const st = await SVC.startKeyLogin({ servers: [sv], keyId: kC.id, by: 'own' });
  assert.equal(st.ok, true, JSON.stringify(st));
  await h.reached;
  assert.equal(KL.serverLockBusy(KL.serverLockKey(rawOf(sv.id))), true);
  const before = rawOf(sv.id).keyRef;
  const busy = await SVC.chooseServerKey({ serverId: sv.id, keyId: kA.id, expectAddr: sv.addr, by: 'own' });
  assert.deepEqual([busy.ok, busy.code, busy.status, rawOf(sv.id).keyRef], [false, 'server-busy', 409, before], JSON.stringify(busy));
  h.release();
  assert.equal((await waitJob(st.jobId)).results[0].ok, true);
  assert.equal(KL.serverLockBusy(KL.serverLockKey(rawOf(sv.id))), false, '작업이 끝나면 자물쇠가 풀린다');
  const r1 = await SVC.chooseServerKey({ serverId: sv.id, keyId: kA.id, expectAddr: sv.addr, by: 'own' });
  assert.deepEqual([r1.ok, rawOf(sv.id).keyRef], [true, kA.id], JSON.stringify(r1));
  // ② 고른 키(kB)로 접속이 안 되는 사이 다른 쪽(키 로그인 설정 · 다른 사람의 고르기)이 키 설정을 kC 로 바꿨다 → 되돌리지 않고 그렇게 말한다
  S.clear();
  S.st.onConn = () => { BM.setBmServerKeyRef(sv.id, kC.id, {}); };
  const r2 = await SVC.chooseServerKey({ serverId: sv.id, keyId: kB.id, expectAddr: sv.addr, by: 'own' });
  assert.deepEqual([r2.ok, r2.code, r2.reverted], [false, 'test-failed', false], JSON.stringify(r2));
  assert.match(r2.revertError, /그 사이 다른 쪽이 이 서버의 키 설정을 바꿔 되돌리지 않았습니다/);
  assert.equal(rawOf(sv.id).keyRef, kC.id, '다른 쪽의 값이 남았다(옛 값 kA 로 덮지 않았다)');
  // ③ 대조 — 아무도 안 바꿨으면 이전 값으로 되돌린다
  S.clear();
  const r3 = await SVC.chooseServerKey({ serverId: sv.id, keyId: kB.id, expectAddr: sv.addr, by: 'own' });
  assert.deepEqual([r3.ok, r3.reverted, rawOf(sv.id).keyRef], [false, true, kC.id], JSON.stringify(r3));
  assert.deepEqual(BM.restoreBmServerKeyRef(sv.id, { keyRef: kA.id, addr: 'x' }, { expectKeyRef: kB.id }).code, 'changed', '등록부 함수도 같은 판정');  // 시한 경주(가짜 시계) — 끝나지 않는 연결 시험은 legDeadlineMs(2) 에 끊긴다 · 끝나면 그 값 · 던지면 그 오류
  assert.deepEqual([await KL.withLegDeadline(2, async () => 'v'), await KL.withLegDeadline(2, async () => { throw new Error('boom'); }).catch((e) => e.message)], ['v', 'boom']);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let err = null;
    const p = KL.withLegDeadline(2, () => new Promise(() => {})).catch((e) => { err = e; });
    t.mock.timers.tick(KL.legDeadlineMs(2) - 1); await Promise.resolve();
    assert.equal(err, null, '시한 전에는 끊지 않는다');
    t.mock.timers.tick(1); await p;
    assert.match(String(err?.message), new RegExp(`시한 초과\\(${Math.round(KL.legDeadlineMs(2) / 1000)}초\\)`));
  } finally { t.mock.timers.reset(); }
  const svcSrc = (await import('./_stripComments.js')).stripComments(fs.readFileSync(path.join(SRC, 'sshaccess/service.js'), 'utf8'));
  assert.match(svcSrc, /if \(KL\.serverLockBusy\(KL\.serverLockKey\(s\)\)\) return \{ ok: false, code: 'server-busy', status: 409/);
  assert.match(svcSrc, /await KL\.withLegDeadline\(2, \(\) => withDeadline\(KL\.legDeadlineMs\(2\) - 2_000, \(signal\) => testServer\(after, \{ by, signal \}\), '[^']+'\)\)/, '키 고르기의 연결 시험은 시한 안에서 · 시한이 지나면 세션도 끊는다(signal — 2회차 반증 R2R-7)');
  assert.match(svcSrc, /async function testServer\(s, \{ by = '', signal \} = \{\}\) \{[^]*?testSavedOs\(s, \{ signal \}\)/);
  const ctSrc = (await import('./_stripComments.js')).stripComments(fs.readFileSync(path.join(SRC, 'bmusage/onboard/connTest.js'), 'utf8'));
  assert.match(ctSrc, /export async function testSavedOs\(s0, \{ signal \} = \{\}\)[^]*?withSsh\(\{[^}]*\.\.\.\(signal \? \{ signal \} : \{\}\) \}/, '연결 시험이 signal 을 withSsh 에 넘긴다');
});

test('⑰-i 서버를 바꾸는 동안은 진행 기록(ssh-key-jobs-inflight.json — 비밀 없음)이 있고 끝나면 지운다 · 도중에 포탈이 재시작하면 기동 때 key-job-interrupted 사건(중요 · 메일)으로 남긴다(1회차 B7 — 작업이 메모리에만 있어 기록이 통째로 사라졌다)', async () => {
  const file = path.join(DIR, 'ssh-key-jobs-inflight.json');
  const S = await fakeSshd();
  const pw = secret('Pw-Inflight-Stored-17i');
  S.st.password = pw;
  const K = mkKey('inflight-key');
  const sv = mkServer('bm-inflight', S, { password: pw });
  const h = holdInstall(S, K);
  const st = await SVC.startKeyLogin({ servers: [sv], keyId: K.id, by: 'own' });
  assert.equal(st.ok, true, JSON.stringify(st));
  await h.reached;
  const raw = fs.readFileSync(file, 'utf8');
  assert.deepEqual(JSON.parse(raw).items.map((x) => [x.jobId, x.sid, x.kind, x.server, x.keyName, x.corp, x.by]), [[st.jobId, sv.id, 'key-login', 'bm-inflight', 'inflight-key', 'vcA', 'own']]);
  assert.equal(modeOf(file), 0o600);
  assert.equal(raw.includes(pw), false, '비밀번호가 없다');
  h.release();
  await waitJob(st.jobId);
  assert.equal(fs.existsSync(file), false, '서버가 끝나면 지운다');
  // 재시작 — ① 기록을 남긴 채 프로세스가 끝남(바꾸던 도중) ② 같은 설정 폴더로 새로 기동
  const solo = { username: 'solo', role: 'admin', totpEnabled: true, totpSecret: generateSecret() };
  const a = subRun({ owners: 'solo', users: [solo], code: `
    const INF = await imp('sshaccess/inflight.js');
    INF.markStart({ jobId: 'kj_aaaaaaaaaaaa', kind: 'key-revoke', keyName: 'leaked-key', sid: 'bm_x1', server: 'bm-x1', corp: 'vcA', by: 'solo' });
    console.log(JSON.stringify({ left: fs.existsSync(path.join(process.env.CONFIG_DIR, 'ssh-key-jobs-inflight.json')) }));` });
  assert.equal(a.left, true);
  const b = subRun({ dir: a.dir, owners: 'solo', users: [solo], code: `
    const N = await imp('sshaccess/notify.js'); const mails = []; N._setKeyNotifySendForTest(async (m) => { mails.push(m); return { ok: true }; });
    const SVC = await imp('sshaccess/service.js'); const ST = await imp('sshaccess/state.js');
    SVC.startSshAccessScheduler({ firstDelayMs: 3600000 });
    await N._flushKeyNotifyForTest();
    const ev = ST.listEvents({ limit: 20 }).filter((e) => e.kind === 'key-job-interrupted');
    SVC._resetSshAccessServiceForTest();
    console.log(JSON.stringify({ ev, file: fs.existsSync(path.join(process.env.CONFIG_DIR, 'ssh-key-jobs-inflight.json')), mail: mails.map((m) => m.text).join('\\n'), crit: ST.CRITICAL_EVENTS.includes('key-job-interrupted') }));` });
  assert.deepEqual(b.ev.map((e) => [e.target, e.by, e.corp]), [['bm-x1 · leaked-key', 'solo', 'vcA']], JSON.stringify(b));
  assert.match(b.ev[0].detail, /키 거두기 도중 포탈이 다시 시작됨 — 그 서버의 authorized_keys 를 확인하세요\(작업 kj_aaaaaaaaaaaa\)/);
  assert.deepEqual([b.file, b.crit], [false, true], '기록은 비우고 · 중요 사건이다');
  assert.match(b.mail, /키 작업이 서버를 바꾸던 중에 중단됨 · vcA · bm-x1 · leaked-key/, '메일로도 알린다');
});

test('⑰-i3 중단 기록은 사건을 쓴 뒤에만 지운다 — 기동 때 상태 파일을 못 읽어 사건을 못 쓰면 진행 기록을 남겨 두고 다음 기동 때 다시 한다 · peekLeftovers 는 비우지 않고 clearLeftovers 는 넘겨받은 항목만 지운다(그 사이 생긴 기록은 남는다 — 1회차 반증 10)', {}, () => {
  const solo = { username: 'solo', role: 'admin', totpEnabled: true, totpSecret: generateSecret() };
  const INFLIGHT = 'ssh-key-jobs-inflight.json';
  const a = subRun({ owners: 'solo', users: [solo], code: `
    const INF = await imp('sshaccess/inflight.js');
    INF.markStart({ jobId: 'kj_bbbbbbbbbbbb', kind: 'key-login', keyName: 'k-restart', sid: 'bm_r1', server: 'bm-r1', corp: 'vcA', by: 'solo' });
    console.log(JSON.stringify({ ok: true, take: typeof INF.takeLeftovers }));` });
  assert.equal(a.take, 'undefined', 'takeLeftovers(먼저 비우던 것)는 없다');
  const boot = `
    const SVC = await imp('sshaccess/service.js'); const ST = await imp('sshaccess/state.js');
    SVC.startSshAccessScheduler({ firstDelayMs: 3600000 });
    const ev = ST.listEvents({ limit: 20 }).filter((e) => e.kind === 'key-job-interrupted').map((e) => e.target);
    SVC._resetSshAccessServiceForTest();
    console.log(JSON.stringify({ ev, unreadable: !!ST.stateLoadError(), file: fs.existsSync(path.join(process.env.CONFIG_DIR, '${INFLIGHT}')) }));`;
  // ① 상태 파일 손상 상태로 기동 — 사건을 못 쓴다 → 진행 기록은 그대로(예전에는 먼저 비워 기록이 조용히 사라졌다)
  fs.writeFileSync(path.join(a.dir, 'ssh-access-state.json'), '{ not json');
  const b = subRun({ dir: a.dir, owners: 'solo', users: [solo], code: boot });
  assert.deepEqual([b.unreadable, b.ev, b.file], [true, [], true], JSON.stringify(b));
  // ② 상태 파일을 고친 뒤 다시 기동 — 이번에는 사건을 쓰고 그다음 지운다
  fs.writeFileSync(path.join(a.dir, 'ssh-access-state.json'), '{}');
  const c = subRun({ dir: a.dir, owners: 'solo', users: [solo], code: boot });
  assert.deepEqual([c.unreadable, c.ev, c.file], [false, ['bm-r1 · k-restart'], false], JSON.stringify(c));
  // ③ peek · clear 단위 — 보고 난 뒤 새로 생긴 기록은 지우지 않는다
  const d = subRun({ owners: 'solo', users: [solo], code: `
    const INF = await imp('sshaccess/inflight.js');
    const rec = (j, sid) => ({ jobId: j, kind: 'key-revoke', keyName: 'k', sid, server: sid, corp: 'vcA', by: 'solo' });
    INF.markStart(rec('kj_cccccccccccc', 'bm_c1'));
    const p1 = INF.peekLeftovers(); const p2 = INF.peekLeftovers();
    INF.markStart(rec('kj_dddddddddddd', 'bm_d1'));
    INF.clearLeftovers(p1);
    const left = JSON.parse(fs.readFileSync(path.join(process.env.CONFIG_DIR, '${INFLIGHT}'), 'utf8')).items.map((x) => x.jobId + '|' + x.sid);
    INF.clearLeftovers([{ jobId: 'kj_dddddddddddd', sid: 'bm_d1' }]);
    console.log(JSON.stringify({ p1: p1.map((x) => x.jobId), p2: p2.map((x) => x.jobId), left, gone: !fs.existsSync(path.join(process.env.CONFIG_DIR, '${INFLIGHT}')) }));` });
  assert.deepEqual([d.p1, d.p2, d.left, d.gone], [['kj_cccccccccccc'], ['kj_cccccccccccc'], ['kj_dddddddddddd|bm_d1'], true], JSON.stringify(d));
});

test('⑰-i2 진행 기록에 작업 id · 서버 id 가 적힌다 — 재시작 뒤 ‘중단’ 사건이 어느 작업인지 밝히고, 이름이 같은 두 서버(법인끼리 겹친다)를 바꾸는 두 작업(넣기 · 거두기 — 칸이 달라 동시에 돈다)의 기록이 서로 지우지 않는다(1회차 갱신 중 발견 → 640e5e62)', async () => {
  const file = path.join(DIR, 'ssh-key-jobs-inflight.json');
  const pw = secret('Pw-Inflight-Stored-17i2');
  const SA = await fakeSshd(); const SB = await fakeSshd();
  for (const S of [SA, SB]) S.st.password = pw;
  const K = mkKey('inflight-key2'); const K2 = mkKey('inflight-key3', { folderCorp: 'vcB' });
  const svA = mkServer('bm-samename', SA, { password: pw });
  const svB = mkServer('bm-samename', SB, { password: pw, vcenterId: 'vcB' });
  assert.notEqual(svA.id, svB.id);
  SB.writeAk(`${K2.pub} portal-ssh:${K2.id}\n`);
  const hA = holdInstall(SA, K); const hB = holdRevoke(SB, K2);
  const st = await SVC.startKeyLogin({ servers: [svA], keyId: K.id, by: 'own' });
  const rv = await SVC.startKeyRevoke({ keyId: K2.id, servers: [svB], by: 'own2' });
  assert.deepEqual([st.ok, rv.ok], [true, true], JSON.stringify([st, rv]));
  await hA.reached; await hB.reached;
  const items = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).items : []).map((x) => [x.jobId, x.sid, x.kind, x.server, x.corp]).sort();
  assert.deepEqual(items(), [[st.jobId, svA.id, 'key-login', 'bm-samename', 'vcA'], [rv.jobId, svB.id, 'key-revoke', 'bm-samename', 'vcB']].sort(), '두 기록이 함께 있다(예전에는 작업 id 가 비어 이름만으로 겹쳤다)');
  hB.release();
  await waitJob(rv.jobId);
  assert.deepEqual(items(), [[st.jobId, svA.id, 'key-login', 'bm-samename', 'vcA']], '거두기가 끝나며 지운 것은 제 기록뿐 — 넣기 기록은 남는다');
  hA.release();
  await waitJob(st.jobId);
  assert.deepEqual(items(), []);
});

test('⑰-j 넣기 작업 도중 서버 쪽 제한을 켜면 남은 서버부터 제한 줄로 넣는다 · 도중에 꺼도 시작 때 켜져 있었으면 끝까지 제한(엄한 쪽으로만 — 1회차 C1-7)', async () => {
  const pw = secret('Pw-RestrictMid-Stored-17j');
  const Ss = []; for (let i = 0; i < 4; i += 1) { const S = await fakeSshd(); S.st.password = pw; Ss.push(S); }
  const svs = Ss.map((S, i) => mkServer(`bm-rmid${i}`, S, { password: pw }));
  const K = mkKey('restrict-mid'); const K2 = mkKey('restrict-mid2');
  assert.ok(ST.setGuards({ serverRestrict: false }, { by: 'fixture' }).ok);
  try {
    const h = holdInstall(Ss[0], K);
    const st = await SVC.startKeyLogin({ servers: [svs[0], svs[1]], keyId: K.id, by: 'own' });
    await h.reached;
    assert.ok(ST.setGuards({ serverRestrict: true }, { by: 'fixture' }).ok);   // 도중에 켬
    h.release();
    const j = await waitJob(st.jobId);
    assert.deepEqual([j.meta.restrict, j.results.map((r) => [r.ok, r.restricted])], [false, [[true, false], [true, true]]], JSON.stringify(j.results));
    assert.equal(Ss[1].readAk(), `from="127.0.0.1",${RESTRICT} ${K.pub} portal-ssh:${K.id}\n`, '켠 뒤의 서버는 제한 줄');
    assert.equal(Ss[0].readAk(), `${K.pub} portal-ssh:${K.id}\n`);
    // 거꾸로 — 켜진 채 시작했는데 도중에 껐다 → 남은 서버도 제한(느슨한 쪽으로는 따르지 않는다)
    const h2 = holdInstall(Ss[2], K2);
    const st2 = await SVC.startKeyLogin({ servers: [svs[2], svs[3]], keyId: K2.id, by: 'own' });
    await h2.reached;
    assert.ok(ST.setGuards({ serverRestrict: false }, { by: 'fixture' }).ok);
    h2.release();
    const j2 = await waitJob(st2.jobId);
    assert.deepEqual(j2.results.map((r) => [r.ok, r.restricted]), [[true, true], [true, true]], JSON.stringify(j2.results));
  } finally { assert.ok(ST.setGuards({ serverRestrict: true }, { by: 'fixture' }).ok); }
});

test('⑰-k 옛 키 교체가 붙은 넣기 작업을 멈추는 것은 OTP(남은 서버에 옛 키 — 유출 키일 수 있다 — 가 남는다 · 1회차 A4) · 교체 없는 넣기 작업 멈추기는 OTP 없이', async () => {
  const pw = secret('Pw-ReplaceCancel-Stored-17k');
  const S1 = await fakeSshd(); const S2 = await fakeSshd();
  for (const S of [S1, S2]) S.st.password = pw;
  const kOld = mkKey('rc-old'); const kNew = mkKey('rc-new');
  const [s1, s2] = [S1, S2].map((S, i) => mkServer(`bm-rc${i}`, S, { password: pw }));
  const yesCode = await otp('own9');   // OTP 코드는 붙잡기 전에 받는다 — otp() 가 창(30초)을 기다리면 붙잡힌 접속이 exec 시한(20초)을 넘겨 작업이 끝난다(검증 중 실측 — ㉑-c 7b 삭제가 200 으로 지나갔다)
  const h = holdInstall(S1, kNew);
  const st = await SVC.startKeyLogin({ servers: [s1, s2], keyId: kNew.id, replaceKeyId: kOld.id, by: 'own' });
  assert.equal(st.ok, true, JSON.stringify(st));
  await h.reached;
  assert.deepEqual([KL.cancelNeedsOtp(st.jobId), SVC.keyJobCancelNeedsOtp(st.jobId), SVC.keyJob(st.jobId).meta.replaceKeyId], [true, true, kOld.id]);
  const url = `/settings/ssh-access/jobs/${st.jobId}/cancel`;
  const no = await call('own3', 'POST', url, {});
  assert.deepEqual([no.s, no.j.needOtp], [403, true], no.txt);
  const yes = await call('own9', 'POST', url, { otp: yesCode });
  assert.deepEqual([yes.s, yes.j.ok], [200, true], yes.txt);
  h.release();
  assert.deepEqual((await waitJob(st.jobId)).results.map((r) => r.code), ['ok', 'cancelled']);
  assert.equal(KL.cancelNeedsOtp('kj_000000000000'), false, '없는 작업은 false(라우트는 404 로 끝난다)');
});

/* ── 8. 알림 메일 ─────────────────────────────────────────────────────── */
test('⑱ 알림 메일 — 알릴 사건(MAIL_EVENTS)만 고른다 · 사건의 글만 싣는다(다른 칸은 본문에 없다) · HTML 이스케이프 · 몰아서 생긴 사건은 한 통', async () => {
  const { KINDS } = await import('../src/mail/kinds.js');
  assert.ok(KINDS.some((k) => k.id === N.MAIL_KIND && N.MAIL_KIND === 'ssh-key'), '메일 종류 등재');
  assert.equal(N.buildMail([]), null);
  assert.equal(N.buildMail(null), null);
  assert.equal(N.buildMail([{ kind: 'key-login-set', target: 'bm-a1 · k' }, { kind: 'inbox-approved', target: 'k' }, { kind: 'nope' }, null]), null, '알리지 않는 사건뿐이면 보내지 않는다');
  // 서버마다의 ‘키 거둠’ · 받는 곳 본 표지(inbox-seen)는 메일로 보내지 않는다 — 작업 끝 요약(key-revoke-done) 한 통(점검 C-4 — 100대 거두기가 메일 100통으로 포탈 전체 시간당 한도를 썼다)
  assert.equal(N.buildMail([{ kind: 'key-lines-removed', target: 'bm-a1 · k', detail: '1줄' }, { kind: 'inbox-seen', detail: 'abcdefabcdef' }, { kind: 'key-job-done', target: 'x' }]), null);
  assert.deepEqual([N.MAIL_EVENTS['key-lines-removed'], typeof N.MAIL_EVENTS['key-revoke-done']], [undefined, 'string']);
  const one = N.buildMail([{ kind: 'key-login-set', target: 'x' }, { kind: 'corp-stop', corp: 'vcA', by: 'own', detail: '유출 의심 · 서버 3대' }]);
  assert.deepEqual([one.count, Object.keys(one).sort()], [1, ['count', 'html', 'subject', 'text']]);
  assert.match(one.subject, /^\[SSH 키 보안\] 법인 키 사용 중지 · vcA · own — 유출 의심/);
  // 사건 객체에 다른 칸이 딸려 와도 본문에는 종류 · 법인 · 대상 · 누가 · 설명뿐이다
  const noisy = N.buildMail([
    { kind: 'approval-requested', corp: 'vcA', target: '키 등록 — <b>kr</b> & "co"', by: 'own', detail: '',
      privateKey: 'PEM-SHOULD-NOT-APPEAR', password: 'PW-SHOULD-NOT-APPEAR', oncePassword: 'ONCE-SHOULD-NOT-APPEAR', payload: { keyId: 'k_payloadnotshown' }, at: 123456789 },
    { kind: 'inbox-new', target: '2개 — vcA/common/id_a', detail: 'vcA/common/id_a|sha-not-shown\nvcA/common/id_b|sha-not-shown' },
    { kind: 'key-lines-removed', corp: 'vcA', target: 'bm-a1 · kr', by: 'own2', detail: '2줄' },
    { kind: 'key-revoke-done', corp: 'vcA', target: 'kr', by: 'own2', detail: '100대 — 지움 98 · 줄 없음 0 · 실패 2' },
  ]);
  const all = JSON.stringify(noisy);
  for (const x of ['SHOULD-NOT-APPEAR', 'k_payloadnotshown', '123456789', 'sha-not-shown']) assert.equal(all.includes(x), false, x);
  assert.equal(noisy.count, 3);
  assert.match(noisy.subject, /사건 3건 — 승인 요청 외/);
  assert.deepEqual(noisy.text.split('\n').slice(0, 3), ['승인 요청 · vcA · 키 등록 — <b>kr</b> & "co" · own', '받는 곳에 새 키 파일 · 2개 — vcA/common/id_a', '서버에서 키 거두기 끝남 · vcA · kr · own2 — 100대 — 지움 98 · 줄 없음 0 · 실패 2']);
  assert.equal(noisy.text.includes('bm-a1 · kr'), false, '서버마다의 거둠 사건은 싣지 않는다(점검 C-4 — 예전 판은 한 줄씩 실었다)');
  assert.ok(noisy.html.includes('&lt;b&gt;kr&lt;/b&gt; &amp; &quot;co&quot;') && !noisy.html.includes('<b>'), 'HTML 본문은 이스케이프');
  // 한 통의 줄 수 상한(60) — 넘친 사건은 말없이 버리지 않고 ‘외 N건’ 을 밝힌다 · count · 제목은 전체 수(1회차 C1-5 — 예전에는 제목도 60건이라 했다)
  const big = N.buildMail(Array.from({ length: 100 }, (_, i) => ({ kind: 'corp-resume', corp: `c${i}` })));
  assert.deepEqual([big.count, big.text.split('\n').filter((l) => l.startsWith('법인 키 사용 재개')).length], [100, 60]);
  assert.match(big.subject, /사건 100건/);
  assert.match(big.text, /… 외 40건은 이 메일에 싣지 않았습니다/);
  assert.match(big.html, /외 40건은 이 메일에 싣지 않았습니다/);
  assert.equal(N.buildMail(Array.from({ length: 60 }, (_, i) => ({ kind: 'corp-resume', corp: `c${i}` }))).text.includes('외 '), false, '넘치지 않으면 덧붙이지 않는다');
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

test('⑱-b 사건이 넘쳐도 중요 사건은 남는다 — 서버마다의 key-login-set 300건이 법인 사용 중지 · 작업 요약을 밀어내지 않는다(점검 C-3 · D-5) · 이번에 넣은 사건 가운데 중요 사건과 앞의 덜 중요한 사건 5개는 자르지 않는다(중요 사건으로 찬 기록에도 받는 곳 새 파일이 남고 알린다 — 반증 R5) · 그 밖의 이번 사건은 오래된 중요 사건보다 먼저 잘린다(작업 끝 몰아 쓰기가 중요 사건을 51개씩 밀어내던 것 — 1회차 반증 4) · 잘린 사건은 알리지 않는다', {}, () => {
  const j = subRun({ owners: 'solo', users: [{ username: 'solo', role: 'admin', totpEnabled: true, totpSecret: generateSecret() }], code: `
    const ST = await imp('sshaccess/state.js'); const N = await imp('sshaccess/notify.js');
    const mails = []; N._setKeyNotifySendForTest(async (m) => { mails.push(m); return { ok: true }; }); N.startKeyNotify();
    const flush = () => N._flushKeyNotifyForTest();
    ST.addEvent({ kind: 'corp-stop', corp: 'vcA', by: 'solo', detail: '유출 의심' });
    ST.addEvent({ kind: 'key-job-done', target: '키 로그인 설정 · k', by: 'solo', detail: '100대' });
    for (let i = 0; i < 3; i += 1) ST.addEvents(Array.from({ length: 100 }, (_, n) => ({ kind: 'key-login-set', target: 'bm-' + i + '-' + n, by: 'solo', detail: '키 접속 확인' })));
    const ev1 = ST.listEvents({ limit: 300 });
    // 중요 사건으로 가득 찬 기록 + 새 덜 중요한 사건(받는 곳 새 파일) — 이번 것은 남기고 오래된 것을 자른다 · 알림도 나간다
    for (let i = 0; i < 3; i += 1) ST.addEvents(Array.from({ length: 100 }, (_, n) => ({ kind: 'approval-decided', target: 'r-' + i + '-' + n, by: 'solo' })));
    await flush(); const m1 = mails.length;
    ST.addEvent({ kind: 'inbox-new', target: '1개 — r5-new', detail: 'aaaaaaaaaaaa' });
    await flush();
    const ev2 = ST.listEvents({ limit: 300 });
    const r5Mailed = mails.slice(m1).some((m) => m.text.includes('r5-new'));
    // 한 번에 많이 넣으면 그 묶음의 덜 중요한 사건은 앞의 5개만 지킨다 — 뒤에 있던 받는 곳 새 파일은 잘린다 · 기록에 남지 않은 사건은 알리지 않는다
    const m2 = mails.length;
    ST.addEvents([...Array.from({ length: 300 }, (_, n) => ({ kind: 'key-login-set', target: 'o-' + n })), { kind: 'inbox-new', target: '1개 — overflow-last' }]);
    await flush();
    const ev3 = ST.listEvents({ limit: 300 });
    // 1회차 반증 4 — 중요 사건(사용 중지)으로 찬 기록에 작업 끝 몰아 쓰기(서버마다 50 + 요약 1). 예전에는 이번 것을 모두 지켜 옛 중요 사건이 51개 밀려났다(서버마다 쓰던 판은 1개)
    for (let i = 0; i < 3; i += 1) ST.addEvents(Array.from({ length: 100 }, (_, n) => ({ kind: 'corp-stop', corp: 'vc-' + i + '-' + n, by: 'solo' })));
    const full = ST.listEvents({ limit: 300 }).filter((e) => e.kind === 'corp-stop').length;
    ST.addEvents([...Array.from({ length: 50 }, (_, n) => ({ kind: 'key-lines-removed', target: 'srv-' + n })), { kind: 'key-revoke-done', target: '키 거두기 · k' }]);
    const ev4 = ST.listEvents({ limit: 300 });
    const batch = { full, n: ev4.length, stops: ev4.filter((e) => e.kind === 'corp-stop').length, summary: ev4.some((e) => e.kind === 'key-revoke-done'),
      servers: ev4.filter((e) => e.kind === 'key-lines-removed').map((e) => e.target).sort(), oldestStopGone: !ev4.some((e) => e.corp === 'vc-0-0'), newestStopKept: ev4.some((e) => e.corp === 'vc-2-99') };
    console.log(JSON.stringify({ max: ST.MAX_EVENTS, n1: ev1.length, stopKept: ev1.some((e) => e.kind === 'corp-stop'), doneKept: ev1.some((e) => e.kind === 'key-job-done'),
      loginSet: ev1.filter((e) => e.kind === 'key-login-set').length, n2: ev2.length, r5Kept: ev2.some((e) => e.target.includes('r5-new')), r5Mailed, critMails: m1,
      n3: ev3.length, overflowKept: ev3.some((e) => e.target.includes('overflow-last')), overflowMailed: mails.slice(m2).some((m) => m.text.includes('overflow-last')),
      firstFive: ev3.filter((e) => e.kind === 'key-login-set').map((e) => e.target).sort(), batch }));
  ` });
  assert.deepEqual([j.max, j.n1, j.stopKept, j.doneKept, j.loginSet], [300, 300, true, true, 298], JSON.stringify(j));
  assert.deepEqual([j.n2, j.r5Kept, j.r5Mailed], [300, true, true], '중요 사건으로 찬 기록에도 새 사건은 남고 알린다(반증 R5 — 예전에는 넣자마자 잘려 영영 알리지 않았다)');
  assert.deepEqual([j.n3, j.overflowKept, j.overflowMailed], [300, false, false], '기록에 남지 않은 사건은 알리지 않는다');
  assert.deepEqual(j.firstFive, ['o-0', 'o-1', 'o-2', 'o-3', 'o-4'], '이번 묶음의 덜 중요한 사건은 앞의 5개만 지킨다');
  assert.deepEqual(j.batch, { full: 300, n: 300, stops: 294, summary: true, servers: ['srv-0', 'srv-1', 'srv-2', 'srv-3', 'srv-4'], oldestStopGone: true, newestStopKept: true },
    `몰아 쓰기 한 번에 밀려나는 옛 중요 사건은 6개(요약 1 + 앞의 서버 사건 5)까지 — 예전 249 ${JSON.stringify(j.batch)}`);
  assert.ok(j.critMails >= 1, '전제 — 알림 경로는 살아 있다');
});

test('⑱-c 받는 곳 ‘본 표지’ 는 12자 해시 — 새 파일 25개 = inbox-new 한 건(표지 20개 · 메일 한 줄) + inbox-seen(나머지 · 메일 없음) · 재시작 뒤 다시 알리지 않는다 · 예전 꼴(경로|sha) 표지도 같은 파일로 알아본다 · 표지는 상태 파일 별도 칸(사건이 밀려나도 · 첫 점검 때 못 읽어도 다시 알리지 않음)(점검 D S-2 · 1회차 C1-4)', async () => {
  const INB = await import('../src/sshaccess/inbox.js');
  const idir = INB.inboxPathOf('vcB');
  fs.mkdirSync(idir, { recursive: true });
  try { await inboxSigCase(INB, idir); } finally { for (const f of fs.readdirSync(idir)) fs.rmSync(path.join(idir, f)); }   // 평문 키 파일을 남기지 않는다(⑳ 이 설정 폴더를 훑는다)
});
async function inboxSigCase(INB, idir) {
  const count = (k) => eventsOf(k).length;
  // 예전 판이 이미 알린 파일 하나 — 사건에 원문 표지 ‘경로|sha’ 로 남아 있다
  const oldK = F.ed25519Key(); ALL_PEMS.push(oldK.pem);
  fs.writeFileSync(path.join(idir, 'id_old'), oldK.pem, { mode: 0o600 });
  const itOld = (await INB.scanInbox({ corps: [{ id: 'vcB' }], servers: [] })).items.find((x) => x.file === 'id_old');
  assert.equal(itOld?.code, 'ready', JSON.stringify(itOld));
  assert.ok(ST.addEvent({ kind: 'inbox-new', corp: 'vcB', target: '1개 — 예전 판', detail: `${itOld.relPath}|${itOld.sha}` }).ok);
  SVC._resetSshAccessServiceForTest();   // 재시작 — 본 표지를 사건 기록에서 다시 읽는다
  const n0 = count('inbox-new'); const s0 = count('inbox-seen');
  await SVC.runSshAccessScan();
  assert.equal(count('inbox-new'), n0, '예전 꼴로 알린 파일을 다시 알리지 않는다(업그레이드 날 다시 알리지 않게)');
  // 새 파일 25개
  for (let i = 0; i < 25; i += 1) { const k = F.ed25519Key(); ALL_PEMS.push(k.pem); fs.writeFileSync(path.join(idir, `id_n${String(i).padStart(2, '0')}`), k.pem, { mode: 0o600 }); }
  await N._flushKeyNotifyForTest();
  const m0 = MAILS.length;
  await SVC.runSshAccessScan();
  assert.deepEqual([count('inbox-new'), count('inbox-seen')], [n0 + 1, s0 + 1], '새 파일 25개 = 알림 사건 하나 + 본 표지 사건 하나');
  const ev = eventsOf('inbox-new')[0];
  const sigs = ev.detail.split(' ');
  assert.match(ev.target, /^25개 — /);
  assert.equal(sigs.length, 20);
  assert.ok(sigs.every((x) => /^[0-9a-f]{12}$/.test(x)), ev.detail);
  assert.ok(ev.detail.length <= 300, '사건 detail(300자) 안에 다 들어간다 — 예전 판은 경로|sha 원문이 잘려 재시작 뒤 나머지를 다시 알렸다');
  const seen = eventsOf('inbox-seen')[0].detail.split(' ');
  assert.equal(seen.length, 5);
  assert.equal(new Set([...sigs, ...seen]).size, 25, '표지 25개가 겹치지 않는다');
  await N._flushKeyNotifyForTest();
  const lines = MAILS.slice(m0).flatMap((m) => m.text.split('\n'));
  const inboxLines = lines.filter((l) => l.startsWith('받는 곳에 새 키 파일'));
  assert.equal(inboxLines.length, 1, `메일은 한 줄(본 표지 사건은 보내지 않는다) ${JSON.stringify(inboxLines)}`);
  assert.match(inboxLines[0], /^받는 곳에 새 키 파일 · 25개 — /);
  assert.equal(lines.some((l) => /[0-9a-f]{12}/.test(l)), false, '표지는 메일에 싣지 않는다');
  // 재시작 뒤 다시 점검 — 다시 알리지 않는다(25개 모두 표지가 있다)
  SVC._resetSshAccessServiceForTest();
  await SVC.runSshAccessScan();
  assert.deepEqual([count('inbox-new'), count('inbox-seen')], [n0 + 1, s0 + 1]);
  // 1회차 C1-4 — 본 표지는 상태 파일의 별도 칸(inboxSeen · 최대 MAX_INBOX_SEEN)에 같은 쓰기로 남는다: 사건 300개가 밀려나도 · 첫 점검 때 상태 파일을 못 읽어도 다시 알리지 않는다
  const seenList = ST.inboxSeenList();
  assert.ok([...sigs, ...seen].every((x) => seenList.includes(x)), '25개 표지가 별도 칸에 있다');
  assert.equal(ST.MAX_INBOX_SEEN, 2000);
  // ① 중요 사건 300개로 받는 곳 사건을 밀어낸 뒤 재시작(옛 꼴 표지로만 알던 id_old 는 뺀다 — 그 경우는 ⑱-d)
  fs.rmSync(path.join(idir, 'id_old'));
  for (let i = 0; i < 3; i += 1) ST.addEvents(Array.from({ length: 100 }, (_, n) => ({ kind: 'approval-decided', target: `c14-${i}-${n}` })));
  assert.equal(count('inbox-new'), 0, '전제 — 받는 곳 사건은 밀려났다');
  SVC._resetSshAccessServiceForTest();
  const m1 = MAILS.length;
  await SVC.runSshAccessScan();
  await N._flushKeyNotifyForTest();
  assert.equal(count('inbox-new'), 0, '다시 알리지 않았다(예전에는 사건에서만 표지를 읽어 25개를 다시 알렸다)');
  assert.equal(MAILS.slice(m1).some((m) => m.text.includes('받는 곳에 새 키 파일')), false);
  // ② 재시작 직후 첫 점검 때 상태 파일을 못 읽음 → 그 회차는 알리지 않고 빈 표지로 굳히지도 않는다 → 고친 뒤 점검도 다시 알리지 않는다
  const sf = path.join(DIR, ST.STATE_FILE_NAME);
  const good = fs.readFileSync(sf, 'utf8');
  fs.writeFileSync(sf, '{ broken'); ST._resetSshAccessStateForTest();
  SVC._resetSshAccessServiceForTest();
  assert.equal(ST.inboxSeenList(), null, '못 읽으면 null(빈 목록이 아니다)');
  await SVC.runSshAccessScan();
  fs.writeFileSync(sf, good);
  for (const f of fs.readdirSync(DIR)) if (f.startsWith(`${ST.STATE_FILE_NAME}.corrupt.`)) fs.rmSync(path.join(DIR, f));
  assert.equal(SVC.reloadState({ by: 'own' }).ok, true);
  await SVC.runSshAccessScan();   // 같은 실행(재시작 없음) — 앞 회차가 빈 표지를 굳혔다면 여기서 다시 알렸다
  assert.equal(count('inbox-new'), 0, '고친 뒤에도 다시 알리지 않았다');
}

test('⑱-e 상태 파일의 inboxSeen 칸은 모양이 틀려도 손상이 아니다 — 배열이 아니면 빈 칸 · 12자 해시가 아닌 것은 버린다 · 사용 중지 · 사건은 그대로(손상으로 보면 모든 키 접속이 멈췄다 — 1회차 반증 참고) · 다른 칸(stops)의 모양 오류는 여전히 손상', {}, () => {
  const j = subRun({ owners: 'solo', users: [{ username: 'solo', role: 'admin', totpEnabled: true, totpSecret: generateSecret() }], code: `
    const ST = await imp('sshaccess/state.js');
    const file = path.join(process.env.CONFIG_DIR, ST.STATE_FILE_NAME);
    ST.setCorpStop('vcA', { by: 'solo', reason: '시험' }); ST.addEvent({ kind: 'corp-stop', corp: 'vcA', by: 'solo' });
    const base = JSON.parse(fs.readFileSync(file, 'utf8'));
    const out = {};
    for (const [name, v] of [['문자열', 'aaaaaaaaaaaa'], ['객체', { a: 'aaaaaaaaaaaa' }], ['숫자', 7], ['null', null], ['섞인 배열', ['bbbbbbbbbbbb', 1, 'zz', 'BBBBBBBBBBBB', 'bbbbbbbbbbbb', 'cccccccccccc']]]) {
      fs.writeFileSync(file, JSON.stringify({ ...base, inboxSeen: v })); ST._resetSshAccessStateForTest();
      out[name] = { err: !!ST.stateLoadError(), seen: ST.inboxSeenList(), stop: !!ST.stopFor('vcA') && !ST.stopFor('vcA').unreadable, ev: ST.listEvents({ limit: 5 }).length };
    }
    fs.writeFileSync(file, JSON.stringify({ ...base, stops: 'x' })); ST._resetSshAccessStateForTest();
    out.stopsBad = { err: !!ST.stateLoadError(), seen: ST.inboxSeenList() };
    out.corrupt = fs.readdirSync(process.env.CONFIG_DIR).filter((n) => n.startsWith(ST.STATE_FILE_NAME + '.corrupt.')).length;
    console.log(JSON.stringify(out));` });
  for (const name of ['문자열', '객체', '숫자', 'null']) assert.deepEqual(j[name], { err: false, seen: [], stop: true, ev: 2 }, `${name} ${JSON.stringify(j)}`);
  assert.deepEqual(j['섞인 배열'], { err: false, seen: ['bbbbbbbbbbbb', 'cccccccccccc'], stop: true, ev: 2 }, JSON.stringify(j));
  assert.deepEqual([j.stopsBad, j.corrupt], [{ err: true, seen: null }, 1], '다른 칸의 모양 오류는 여전히 손상(fail-closed) — 보존본 하나');
});

test('⑱-d 옛 판(사건 detail 의 ‘경로|sha’)으로만 알린 받는 곳 파일 — 처음 표지를 만들 때 옛 표지를 상태 파일 칸(inboxSeen)으로 옮겨, 그 사건이 기록에서 밀려난 뒤 재시작해도 다시 알리지 않는다(1회차 갱신 중 확인 → 0992a0f1)',
  async () => {
    const INB = await import('../src/sshaccess/inbox.js');
    const idir = INB.inboxPathOf('vcB');
    fs.mkdirSync(idir, { recursive: true });
    const k = F.ed25519Key(); ALL_PEMS.push(k.pem);
    fs.writeFileSync(path.join(idir, 'id_legacy'), k.pem, { mode: 0o600 });
    try {
      const it = (await INB.scanInbox({ corps: [{ id: 'vcB' }], servers: [] })).items.find((x) => x.file === 'id_legacy');
      assert.ok(ST.addEvent({ kind: 'inbox-new', corp: 'vcB', target: '1개 — 예전 판', detail: `${it.relPath}|${it.sha}` }).ok);
      SVC._resetSshAccessServiceForTest();
      await SVC.runSshAccessScan();   // 업그레이드 뒤 첫 점검 — 옛 표지로 알아본다(다시 알리지 않음)
      for (let i = 0; i < 3; i += 1) ST.addEvents(Array.from({ length: 100 }, (_, n) => ({ kind: 'approval-decided', target: `c14d-${i}-${n}` })));
      SVC._resetSshAccessServiceForTest();
      const before = eventsOf('inbox-new').length;
      await SVC.runSshAccessScan();
      assert.equal(eventsOf('inbox-new').length, before, '옛 표지 사건이 밀려난 뒤에도 다시 알리지 않는다');
    } finally { for (const f of fs.readdirSync(idir)) fs.rmSync(path.join(idir, f)); }
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
  // 라우트 — 쓰기 라우트는 전부 관리자 → 설정 소유자 등급 → 쓰기 범위 무제한(fullRW · 1회차 A3) → (OTP 를 쓰지 않는 사전 검사) → OTP(마지막).
  //   묶음 · 묶음 함수(write(fn))를 펼친 미들웨어 줄로 본다(test/_routeChains.js — sshAccess390 ⑪ 이 모든 쓰기 라우트를 같은 규칙으로 본다).
  const rt = stripComments(fs.readFileSync(path.join(SRC, 'routes/api/sshAccess.js'), 'utf8'));
  const { routeChains } = await import('./_routeChains.js');
  const chains = routeChains(rt);
  assert.equal([...rt.matchAll(/api\.(get|post|put|delete)\(/g)].length, chains.size, '미들웨어 줄을 읽지 못한 라우트가 없다');
  const OWNER_READ = ['adminOnly', 'requireSettingsOwner'];
  const W = [...OWNER_READ, 'fullRW'];
  for (const r of ['post /settings/ssh-access/keys/rotate', 'delete /settings/ssh-access/keys/:id', 'put /settings/ssh-access/guards', 'delete /settings/ssh-access/corps/:corp/stop', 'post /settings/ssh-access/reload-keystore',
    'post /settings/ssh-access/corps/:corp/stop', 'post /settings/ssh-access/servers/:id/key', 'post /settings/ssh-access/inbox/discard']) {
    assert.deepEqual(chains.get(r), [...W, 'pre', 'reauth'], `${r} — 결정적 거절은 OTP 앞(1회차 A5 · 2회차 반증 R2R-5 — 중지 · 서버 키 고르기 · 받는 곳 버리기)`);
  }
  assert.deepEqual(chains.get('post /settings/ssh-access/approvals/:id/approve'), [...W, 'approvePre(true)', 'reauth'], '자기 승인 · 지문 · 처리됨 · 기록 손상은 OTP 앞(점검 A10)');
  assert.deepEqual(chains.get('post /settings/ssh-access/approvals/:id/reject'), [...W, 'approvePre(false)', 'reauth']);
  assert.deepEqual(chains.get('post /settings/ssh-access/key-login'), [...W, "jobPre('key-login')", 'reauth'], '데모 · 키 상태 · 진행 중 작업은 OTP 앞');
  assert.deepEqual(chains.get('post /settings/ssh-access/key-revoke'), [...W, "jobPre('key-revoke')", 'reauth']);
  assert.deepEqual(chains.get('get /settings/ssh-access/jobs/:id'), OWNER_READ);
  // 화면 조회는 소유자 세션을 승인자 쌍의 증거로 적는다(AD 공동 소유자 — 1회차 반증 1 · 동작은 ⑥-i ⑤ 가 본다). 응답을 만들기 전에 · 실패해도 화면은 나간다(guards 가 삼킨다)
  assert.deepEqual(chains.get('get /settings/ssh-access'), OWNER_READ);
  assert.match(rt, /api\.get\('\/settings\/ssh-access', \.\.\.ownerRead, async \(req, res\) => \{\s*SVC\.noteOwnerSession\(who\(req\)\);/);
  // 멈추기 — 넣기 작업 멈추기는 줄이는 방향이라 OTP 없음. 거두기 · 옛 키 교체가 붙은 넣기 멈추기는 OTP(반증 D1 · 1회차 A4). 쓰기 라우트 가운데 이것 하나만 명시적 예외.
  assert.deepEqual(chains.get('post /settings/ssh-access/jobs/:id/cancel'), [...W, 'cancelGate']);
  assert.match(rt, /const cancelGate = \(req, res, next\) => \(SVC\.keyJobCancelNeedsOtp\(t\(req\.params\.id, 20\)\) \? reauth\(req, res, next\) : next\(\)\);/);
  assert.match(rt, /const ownerWrite = \[adminOnly, requireSettingsOwner, fullRW, reauth\];/);
  assert.match(rt, /'\/settings\/ssh-access\/corps\/:corp\/stop', \.\.\.write\(\(req\) => SVC\.prechecks\.stop\(\{ corp: req\.params\.corp \}\)\)/);
  assert.match(rt, /'\/settings\/ssh-access\/servers\/:id\/key', \.\.\.write\(\(req\) => SVC\.prechecks\.chooseKey\(\{ serverId: req\.params\.id, keyId: bodyOf\(req\)\.keyId \}\)\)/);
  assert.match(rt, /'\/settings\/ssh-access\/inbox\/discard', \.\.\.write\(\(req\) => SVC\.prechecks\.inboxPath\(\{ relPath: bodyOf\(req\)\.relPath \}\)\)/);
  assert.match(rt, /const approvePre = \(approve\) => \(req, res, next\) => \{ const b = bodyOf\(req\); const p = SVC\.approvalPrecheck\(/, '사전 검사는 service 의 판정 하나');
  assert.match(rt, /const jobPre = \(kind\) => pre\(\(req\) => SVC\.keyJobPrecheck\(kind, t\(bodyOf\(req\)\.keyId, 32\), bodyOf\(req\)\)\);/, '작업 사전 검사는 요청의 키로(같은 키 거두기 중 넣기 409 revoking — 반증 R2) · async 라 pre 로 감싼다');
  assert.doesNotMatch(rt, /resolveOsAuth|keyMaterial|listKeysRaw|listBmServersRaw|KS\.|keyStore|approval\/store|approval\/twoPerson|keyLogin/, '라우트는 저장소 · 승인 저장소 · 키 로그인 본체를 직접 만지지 않는다(service 를 거친다)');
  // 접속 한 번마다 시한(세션을 실제로 끊는다) · 비밀번호는 password 방식 한 번(구형 알고리즘 재시도 · 서버에 들어 있는 키 읽기 포함 — 점검 B-F7 · E-3)
  assert.match(kl, /withDeadline\(legDeadlineMs\(execs\), \(signal\) => withSsh\(\{[^]*?passwordOnly: true, signal \}/);
  const svcSrc = stripComments(fs.readFileSync(path.join(SRC, 'sshaccess/service.js'), 'utf8'));
  assert.match(svcSrc, /import \{[^}]*\bnoteOwnerSession\b[^}]*\} from '\.\/guards\.js';\s*export \{ noteOwnerSession \};/, 'service 가 guards 의 판정을 재수출한다(두 벌 두지 않는다)');
  assert.match(svcSrc, /readyTimeout: 15_000,\s*passwordOnly: true \},\s*async \(\{ exec \}\) => exec\(READ_COMMAND, 15_000\)\)/, 'readInstalledKeys 도 passwordOnly(⑪-d 가 동작으로도 본다)');
  const sx = stripComments(fs.readFileSync(path.join(SRC, 'proxy/sshExec.js'), 'utf8'));
  assert.match(sx, /connect\(\{[^)]*_legacy: true, passwordOnly \}\)/, '구형 알고리즘 재시도에도 passwordOnly');
  assert.match(sx, /else if \(passwordOnly\) \{[^]*?auth\.authHandler = [^]*?if \(sent\) return cb\(false\);/, 'passwordOnly 는 authHandler 로 한 번만(1회차 D3 — ⑪-b · ⑪-e 가 동작으로 본다)');
  for (const line of rt.split('\n').filter((l) => /audit\(/.test(l))) assert.doesNotMatch(line, /oncePassword: (?!!!once\b)|: once\b|privateKey|passphrase/, line.trim().slice(0, 80));
  // 7b 화면 — 키 등록 · 교체 · 삭제 게이트에 두 사람 승인 검사가 OTP 앞에 있다
  const ob = stripComments(fs.readFileSync(path.join(SRC, 'routes/api/bmOnboard.js'), 'utf8'));
  assert.match(ob, /const keyAddGate = \[adminOnly, toolsPerm, requireSettingsOwner, fullRW, twoPersonFirst, keyVaultFirst, reauth\];/);
  assert.match(ob, /const keyChangeGate = \[adminOnly, toolsPerm, requireSettingsOwner, fullRW, twoPersonFirst, installingFirst, reauth\];/);
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

/* ── 2회차(25abafe1) 회귀 ─────────────────────────────────────────────── */
test('㉑-a 승인자 쌍(2회차 A1) — AD 소유자 세션의 신원을 상태 파일(guards.seenAd · 최대 20 · 처음 볼 때만 씀)에 적고, 쌍 = 로컬 승인자 ∪ (seenAd 에 있고 지금 목록에 있으며 승인할 수 있는 이름)의 서로 다른 신원 둘 · 소유자가 모두 AD 여도 둘 다 들어왔으면 쌍 · 다른 사람의 승인은 실행이 실패해도 쌍의 증거(돌려보냄은 아님)', {}, () => {
  const AD = { AD_ENABLED: 'true', AD_URL: 'ldap://ad.example.invalid' };
  const tot = () => ({ totpEnabled: true, totpSecret: generateSecret() });
  // ① 소유자가 모두 AD(로컬 승인자 0) — 한 사람만 들어오면 쌍이 아니고, 둘째가 들어오면 쌍
  const code = `
    const G = await imp('sshaccess/guards.js'); const ST = await imp('sshaccess/state.js');
    for (const u of (process.env.T_SEEN || '').split(',').filter(Boolean)) G.noteOwnerSession(u);
    G.notePair({ by: '' });
    console.log(JSON.stringify({ seen: ST.getGuards().pairSeen, seenAd: ST.getGuards().seenAd }));`;
  const a1 = subRun({ owners: 'ad.a,ad.b', users: [], env: { ...AD, T_SEEN: 'ad.a' }, code });
  assert.deepEqual([a1.seen, a1.seenAd], [false, ['ad.a']], JSON.stringify(a1));
  //    seenAd 에 있어도 지금 목록에 없으면 세지 않는다(같은 설정 폴더 · 목록에서 ad.b 를 뺀 뒤 ad.a 가 들어옴 — 예전에 ad.b 가 들어왔던 것으로 가정)
  const a2 = subRun({ dir: a1.dir, owners: 'ad.b', users: [], env: { ...AD, T_SEEN: 'ad.b' }, code });
  assert.deepEqual([a2.seen, a2.seenAd], [false, ['ad.a', 'ad.b']], JSON.stringify(a2));
  const a3 = subRun({ dir: a1.dir, owners: 'ad.a', users: [], env: { ...AD, T_SEEN: '' }, code });
  assert.deepEqual([a3.seen], [false], '목록에 ad.a 하나 — seenAd 의 ad.b 는 세지 않는다');
  const a3b = subRun({ dir: a1.dir, owners: 'ad.a,ad.b', users: [], env: { T_SEEN: '' }, code });
  assert.deepEqual([a3b.seen], [false], 'AD 를 끈 설치에서는 seenAd 를 세지 않는다(로컬 계정이 아닌 이름은 로그인할 수 없다)');
  const a4 = subRun({ dir: a1.dir, owners: 'ad.a,ad.b', users: [], env: { ...AD, T_SEEN: '' }, code });
  assert.deepEqual([a4.seen], [true], '둘 다 지금 목록에 있고 둘 다 들어온 적이 있다 → 쌍(새 세션 없이 notePair 만으로)');
  //    같은 신원 별칭(ad.a · ad.a@corp)은 한 번만 적는다
  const a5 = subRun({ owners: 'ad.a,ad.b', users: [], env: { ...AD, T_SEEN: 'ad.a,ad.a@corp.example' }, code });
  assert.deepEqual([a5.seen, a5.seenAd], [false, ['ad.a']], `같은 신원은 한 번만 적는다 ${JSON.stringify(a5)}`);
  const a6 = subRun({ dir: a4.dir, owners: 'ad.a,ad.b', users: [], env: { T_SEEN: '' }, code });
  assert.equal(a6.seen, true, '한 번 선 쌍은 AD 를 꺼도 내리지 않는다');
  // ② 상한 20 · 모양이 틀린 칸은 버린다(손상 아님) · 같은 신원은 다시 쓰지 않는다(쓰기 0)
  const b = subRun({ owners: 'own', users: [{ username: 'own', role: 'admin', ...tot() }], code: `
    const ST = await imp('sshaccess/state.js'); const file = path.join(process.env.CONFIG_DIR, ST.STATE_FILE_NAME);
    for (let i = 0; i < 25; i += 1) ST.noteSeenAd('ad' + i);
    const s1 = ST.getGuards().seenAd; const again = ST.noteSeenAd('ad24');
    const j = JSON.parse(fs.readFileSync(file, 'utf8')); j.guards.seenAd = ['ok1', 7, '', 'x'.repeat(129), 'ok2']; fs.writeFileSync(file, JSON.stringify(j)); ST._resetSshAccessStateForTest();
    console.log(JSON.stringify({ n: s1.length, first: s1[0], last: s1[19], again, s2: ST.getGuards().seenAd, err: !!ST.stateLoadError() }));` });
  assert.deepEqual([b.n, b.first, b.last, b.again, b.s2, b.err], [20, 'ad5', 'ad24', { ok: true, changed: 0 }, ['ok1', 'ok2'], false], JSON.stringify(b));
  // ③ 다른 사람의 승인 — 실행이 실패해도(stop-changed) 쌍의 증거 · 돌려보냄은 증거가 아니다. 소유자 own(로컬) · bob.ad(AD · 세션 없음)
  const c = subRun({ owners: 'own,bob.ad', env: AD, users: [{ username: 'own', role: 'admin', ...tot() }], code: `
    const { store } = await imp('store.js'); store.snapshot = { ...store.get(), vcenters: [{ id: 'vcA', name: 'KR-SEL' }, { id: 'vcB', name: 'PL-WAW' }] };
    const SVC = await imp('sshaccess/service.js'); const ST = await imp('sshaccess/state.js');
    await SVC.stopCorp('vcA', { by: 'own', reason: 't' }); await SVC.stopCorp('vcB', { by: 'own', reason: 't' });
    const q1 = await SVC.resumeCorp('vcB', { by: 'own' });
    const rj = await SVC.decideApproval(q1.request.id, { approve: false, by: 'bob.ad' });
    const s0 = ST.getGuards().pairSeen;
    const q2 = await SVC.resumeCorp('vcA', { by: 'own' });
    ST.clearCorpStop('vcA', { by: 'x' }); await new Promise((r) => setTimeout(r, 5)); await SVC.stopCorp('vcA', { by: 'own', reason: 'again' });
    const ap = await SVC.decideApproval(q2.request.id, { approve: true, by: 'bob.ad', digest: q2.request.digest });
    console.log(JSON.stringify({ pend: [q1.pending, q2.pending], rj: rj.request?.status, s0, ap: [ap.ok, ap.code, ap.request?.status], s1: ST.getGuards().pairSeen }));` });
  assert.deepEqual([c.pend, c.rj, c.s0, c.ap, c.s1], [[true, true], 'rejected', false, [false, 'stop-changed', 'failed'], true], `실패한 승인도 쌍(예전에는 r.ok 일 때만) · 돌려보냄은 아님 ${JSON.stringify(c)}`);
});

test('㉑-b 사용 중지 · 승인 저장소(2회차 A2) — 모르는 법인은 404 unknown-corp(법인 목록이 비었으면 막지 않음) · 모르는 법인이고 적힌 서버 · 주소도 없는 중지는 승인 없이 바로 푼다(서버가 적혔으면 승인) · 요청자(신원)마다 대기 요청 30건 상한(too-many — 다른 사람은 만든다)', async () => {
  const evBefore = eventsOf('corp-stop').length;
  const u = await SVC.stopCorp('vcNOPE', { by: 'own', reason: '없는 법인' });
  assert.deepEqual([u.ok, u.code, u.status, ST.stopFor('vcNOPE'), eventsOf('corp-stop').length], [false, 'unknown-corp', 404, null, evBefore], JSON.stringify(u));
  // 모르는 법인의 빈 중지(옛 판이 남긴 것 · 손으로 넣은 것) — 막는 것이 없으니 승인 없이 푼다
  assert.ok(ST.setCorpStop('ghost-corp', { by: 'fixture', reason: 'x' }).ok);
  const r1 = await SVC.resumeCorp('ghost-corp', { by: 'own' });
  assert.deepEqual([r1.ok, r1.pending === true, ST.stopFor('ghost-corp')], [true, false, null], JSON.stringify(r1));
  // 서버가 적힌 중지는 모르는 법인이어도 승인(풀면 그 서버가 다시 열린다)
  assert.ok(ST.setCorpStop('ghost-corp2', { by: 'fixture', reason: 'x', servers: [{ id: 'bm_ghost', addr: '10.9.9.9:22' }] }).ok);
  const r2 = await SVC.resumeCorp('ghost-corp2', { by: 'own' });
  assert.deepEqual([r2.ok, r2.pending, !!ST.stopFor('ghost-corp2')], [true, true, true], JSON.stringify(r2));
  assert.equal((await SVC.decideApproval(r2.request.id, { approve: false, by: 'own' })).request.status, 'cancelled');
  assert.ok(ST.clearCorpStop('ghost-corp2', { by: 'fixture' }).ok);
  // 아는 법인(vcB)의 빈 중지는 그대로 승인(대조)
  assert.ok((await SVC.stopCorp('vcB', { by: 'own', reason: 'x' })).ok);
  const r3 = await SVC.resumeCorp('vcB', { by: 'own' });
  assert.deepEqual([r3.pending, !!ST.stopFor('vcB')], [true, true]);
  assert.equal((await SVC.decideApproval(r3.request.id, { approve: false, by: 'own' })).request.status, 'cancelled');
  assert.ok(ST.clearCorpStop('vcB', { by: 'fixture' }).ok);
  // 법인 목록이 비었으면(수집 전 · 못 읽음) 막지 않는다(멈추는 쪽) · 대기 상한은 요청자 신원마다
  const j = subRun({ owners: 'own,own2', users: [{ username: 'own', role: 'admin', totpEnabled: true, totpSecret: generateSecret() }, { username: 'own2', role: 'admin', totpEnabled: true, totpSecret: generateSecret() }], code: `
    const SVC = await imp('sshaccess/service.js'); const AP = await imp('approval/store.js');
    const st = await SVC.stopCorp('any-corp', { by: 'own', reason: 'x' });
    const mk = (by, i) => AP.createRequest({ kind: 'ssh-key-delete', title: 't', target: 'k' + i, payload: { keyId: 'k' + i }, by });
    const oks = []; for (let i = 0; i < AP.MAX_PENDING_PER_USER; i += 1) oks.push(mk('own', i).ok);
    const over = mk('OWN@corp.example', 99); const other = mk('own2', 100);
    console.log(JSON.stringify({ st: [st.ok, st.code || ''], max: AP.MAX_PENDING_PER_USER, oks: oks.every(Boolean), over: [over.ok, over.code, over.status], other: other.ok }));` });
  assert.deepEqual([j.st, j.max, j.oks, j.over, j.other], [[true, ''], 30, true, [false, 'too-many', 409], true], JSON.stringify(j));
});

test('㉑-c 7b 화면(2회차 A3 · A4 · D2-2) — 키 관리 · 등록 · 교체 · 삭제 게이트에 fullRW(쓰기 범위가 좁은 소유자는 OTP 앞 403 write-scope) · 넣는 중 검사는 처리 함수와 같은 다듬기(공백 붙인 id 로 비켜 가지 못한다) · 교체로 지울 옛 키도 넣는 중(7b · SSH 공용 접속 모두 409)', async () => {
  const kx = mkKey('7b-scope');
  const code = await otp('lim');
  for (const [m, p, body] of [['POST', '/tools/bm-usage/ssh-keys', { name: 'x', privateKey: 'x', otp: code }], ['PUT', `/tools/bm-usage/ssh-keys/${kx.id}`, { name: 'y', otp: code }],
    ['POST', '/tools/bm-usage/ssh-keys/rotate', { from: kx.id, to: kx.id, otp: code }], ['DELETE', `/tools/bm-usage/ssh-keys/${kx.id}?otp=${code}`, null]]) {
    const r = await call('lim', m, p, body);
    assert.deepEqual([r.s, r.j.code], [403, 'write-scope'], `${m} ${p} ${r.txt}`);
  }
  assert.equal(AUTH.verifyUserOtp('lim', code).ok, true, '쓰기 범위 거절이 OTP 를 소모하지 않았다');
  // 넣는 중 — 넣는 키 K 와 교체로 지울 옛 키 kOld 둘 다
  const S = await fakeSshd(); const pw = secret('Pw-7b-Busy-21c'); S.st.password = pw;
  const K = mkKey('7b-new'); const kOld = mkKey('7b-old');
  const sv = mkServer('bm-7b-busy', S, { password: pw });
  const c2 = await otp('own7');   // OTP 코드는 붙잡기 전에 받는다 — otp() 가 창(30초)을 기다리면 붙잡힌 접속이 exec 시한(20초)을 넘겨 작업이 끝난다(검증 중 실측 — ㉑-c 7b 삭제가 200 으로 지나갔다)
  const h = holdInstall(S, K);
  const st = await SVC.startKeyLogin({ servers: [sv], keyId: K.id, replaceKeyId: kOld.id, by: 'own' });
  assert.equal(st.ok, true, JSON.stringify(st));
  await h.reached;
  assert.deepEqual(KL.installingKeyIds().sort(), [K.id, kOld.id].sort());
  assert.ok(ST.setGuards({ twoPerson: false }, { by: 'fixture' }).ok);
  try {
    // 처리 함수는 t(v, 32)(자른 뒤 공백 제거)로 id 를 읽는다 — 예전 검사는 공백 제거 뒤 잘라, ‘id + 공백 18 + 아무 글자’ 가 검사를 비켜 가고 처리 함수에서는 그 id 가 됐다(2회차 A4)
    const pad = (id) => `${id}${' '.repeat(18)}zz`;
    for (const [m, p, body] of [['DELETE', `/tools/bm-usage/ssh-keys/${kOld.id}?otp=${c2}`, null], ['DELETE', `/tools/bm-usage/ssh-keys/${encodeURIComponent(pad(K.id))}?otp=${c2}`, null],
      ['POST', '/tools/bm-usage/ssh-keys/rotate', { from: pad(kOld.id), to: kx.id, otp: c2 }]]) {
      const r = await call('own7', m, p, body);
      assert.deepEqual([r.s, r.j.code], [409, 'key-installing'], `${m} ${p} ${r.txt}`);
    }
    assert.equal(AUTH.verifyUserOtp('own7', c2).ok, true);
  } finally { assert.ok(ST.setGuards({ twoPerson: true }, { by: 'fixture' }).ok); }
  for (const r of [await SVC.deleteKeyReq({ keyId: kOld.id, by: 'own' }), await SVC.rotateKeyReq({ from: kOld.id, to: kx.id, by: 'own' })]) assert.deepEqual([r.code, r.status], ['key-installing', 409], JSON.stringify(r));
  h.release();
  await waitJob(st.jobId);
  assert.deepEqual(KL.installingKeyIds(), [], '끝나면 빈다');
});

test('㉑-d 키 작업 사전 검사가 요청 본문까지 본다(OTP 앞 — 2회차 A5) — 옛 키 없음 404 key-missing · 넣을 키와 지울 키가 같음 400 same-key · 대상 서버가 모두 빠짐 400 empty(화면이 낡음) · 거두기 법인 · 서버 없음 400 bad-corp · 문제없으면 null', async () => {
  const K = mkKey('pre-body'); const kOld = mkKey('pre-body-old');
  const S = await fakeSshd(); const sv = mkServer('bm-pre-body', S);
  const pick = (r) => (r ? [r.code, r.status] : null);
  assert.deepEqual(pick(await SVC.keyJobPrecheck('key-login', K.id, { replaceKeyId: 'k_000000000000', servers: [sv] })), ['key-missing', 404]);
  assert.deepEqual(pick(await SVC.keyJobPrecheck('key-login', K.id, { replaceKeyId: K.id, servers: [sv] })), ['same-key', 400]);
  const empty = await SVC.keyJobPrecheck('key-login', K.id, { servers: [{ id: sv.id, addr: 'moved.example:22' }, { id: 'bm_nope', addr: 'x' }] });
  assert.deepEqual([...pick(empty), empty.skipped.length], ['empty', 400, 2], JSON.stringify(empty));
  assert.deepEqual(pick(await SVC.keyJobPrecheck('key-login', K.id, {})), ['empty', 400]);
  assert.deepEqual(pick(await SVC.keyJobPrecheck('key-revoke', K.id, {})), ['bad-corp', 400]);
  assert.deepEqual(pick(await SVC.keyJobPrecheck('key-revoke', K.id, { corp: '   ' })), ['bad-corp', 400]);
  for (const [kind, body] of [['key-login', { servers: [sv], replaceKeyId: kOld.id }], ['key-revoke', { corp: 'vcA' }], ['key-revoke', { servers: [] }]]) {
    assert.equal(await SVC.keyJobPrecheck(kind, K.id, body), null, `${kind} ${JSON.stringify(body)}`);
  }
});

test('㉑-e 사전 검사(OTP 앞 — 2회차 A5) — 키 저장소 다시 읽기는 디스크를 못 읽으면 503 read-failed · 받는 곳 승인은 받는 곳 안의 경로가 아니면 400 bad-path(라우트 줄은 ⑲)', {}, () => {
  const j = subRun({ owners: 'own,own2', users: [{ username: 'own', role: 'admin', totpEnabled: true, totpSecret: generateSecret() }, { username: 'own2', role: 'admin', totpEnabled: true, totpSecret: generateSecret() }], code: `
    fs.mkdirSync(path.join(process.env.CONFIG_DIR, 'ssh-keys.json'));   // 파일 자리에 폴더 — 읽기 실패
    const SVC = await imp('sshaccess/service.js'); const KS = await imp('bmusage/onboard/keyStore.js');
    const pick = (r) => (r ? [r.code, r.status] : null);
    const a = pick(SVC.prechecks.reloadKeyStore({ by: 'own' })); const sha = KS.diskFileSha();
    fs.rmdirSync(path.join(process.env.CONFIG_DIR, 'ssh-keys.json'));
    const b = pick(SVC.prechecks.reloadKeyStore({ by: 'own' }));
    fs.mkdirSync(path.join(process.env.CONFIG_DIR, 'ssh-keys-inbox', 'kr-sel', 'common'), { recursive: true });
    console.log(JSON.stringify({ a, sha, b, p: ['../x.pub', '/etc/passwd', 'vcA/common/../../x', ' vcA/common/a.pub', 'kr-sel/common/a.pub'].map((p) => pick(SVC.prechecks.inboxPath({ relPath: p }))) }));` });
  assert.deepEqual([j.a, j.sha], [['read-failed', 503], null], JSON.stringify(j));
  assert.notDeepEqual(j.b, ['read-failed', 503], '파일이 없으면(빈 저장소) 읽기 실패가 아니다');
  assert.deepEqual(j.p.slice(0, 4), [['bad-path', 400], ['bad-path', 400], ['bad-path', 400], ['bad-path', 400]], JSON.stringify(j.p));
  assert.equal(j.p[4], null, '받는 곳 꼴의 경로는 통과(파일 판정은 본 함수)');
});

test('㉑-f 교체(replaceKeyId)를 요청했는데 그 사이 옛 키가 바뀌었으면(저장 내용과 지문이 맞지 않음) 남은 서버는 옛 키 줄을 지우지 못한다 — 조용히 넘기지 않고 성공 결과에 note · oldRemoved:null(2회차 D2-2)', async () => {
  const S1 = await fakeSshd(); const S2 = await fakeSshd();
  const pw = secret('Pw-Replace-Changed-21f');
  for (const S of [S1, S2]) S.st.password = pw;
  const K = mkKey('rep-chg-new'); const kOld = mkKey('rep-chg-old');
  const oldLine = `${kOld.pub} portal-ssh:${kOld.id}`;
  for (const S of [S1, S2]) S.writeAk(`${OTHER}\n${oldLine}\n`);
  const [s1, s2] = [S1, S2].map((S, i) => mkServer(`bm-rep-chg${i}`, S, { password: pw }));
  const h = holdInstall(S1, K);
  const st = await SVC.startKeyLogin({ servers: [s1, s2], keyId: K.id, replaceKeyId: kOld.id, by: 'own' });
  assert.equal(st.ok, true, JSON.stringify(st));
  await h.reached;
  const file = path.join(DIR, 'ssh-keys.json');
  const orig = fs.readFileSync(file, 'utf8');
  try {
    const j = JSON.parse(orig);
    for (const x of j.keys) if (x.id === kOld.id) x.publicKey = OTHER.split(' ').slice(0, 2).join(' ');   // 사람이 파일의 옛 키 공개키 칸을 바꿨다
    fs.writeFileSync(file, JSON.stringify(j)); KS._resetKeyStoreForTest();
    assert.equal(KS.publicKeyMatches(KS.keyById(kOld.id)), false, '전제');
    h.release();
    const v = await waitJob(st.jobId);
    const [r1, r2] = v.results;
    assert.deepEqual([r1.ok, r1.oldRemoved], [true, 1], JSON.stringify(r1));
    assert.deepEqual([r2.ok, r2.oldRemoved], [true, null], JSON.stringify(r2));
    assert.match(r2.note, /옛 키 ‘rep-chg-old’ 가 그 사이 지워졌거나 저장된 내용이 바뀌어 이 서버의 옛 키 줄을 지우지 않았습니다/);
    assert.ok(S2.readAk().includes(oldLine), '옛 키 줄은 남아 있다(지우지 않았다 — 그래서 밝힌다)');
  } finally { fs.writeFileSync(file, orig); KS._resetKeyStoreForTest(); }
  assert.equal(KS.publicKeyMatches(KS.keyById(kOld.id)), true);
});

test('㉑-g 백업 · 복원(2회차 D2-1 · D2-4) — 서버에서 읽은 키 기록 · 키 작업 진행 기록은 상태 파일(설정 변경 자동 백업 · 지문 밖) · 진행 기록은 복원 제외 · 지금 파일에만 있는 계정의 기본 키는 같은 지문의 키(번들 id 로 되살아난 같은 키)로 잇고, 없으면 dropped 에 account-key: 로 밝힌다', async () => {
  const SF = await import('../src/util/stateFiles.js');
  const BS = await import('../src/backup/service.js');
  const SR = await import('../src/backup/stagedRestore.js');
  const INF = await import('../src/sshaccess/inflight.js');
  for (const n of [INS.INSTALLED_FILE_NAME, INF.INFLIGHT_FILE_NAME]) {
    assert.equal(SF.isRegisteredStateFile(n), true, n);
    assert.equal(BS.RUNTIME_STATE_NAMES.has(n), true, n);
  }
  assert.deepEqual([INS.INSTALLED_FILE_NAME, INF.INFLIGHT_FILE_NAME], ['ssh-access-installed.json', 'ssh-key-jobs-inflight.json']);
  assert.equal(SR.RESTORE_EXCLUDE.has('ssh-key-jobs-inflight.json'), true, '되돌리면 끝난 작업이 기동 때 ‘중단’ 사건(메일)이 된다');
  assert.equal(SR.RESTORE_EXCLUDE.has('ssh-access-installed.json'), false, '읽은 키 기록은 복원해도 된다(화면용)');
  const BUN = await import('../src/bmusage/onboard/keyBundle.js');
  const cur = { keys: [{ id: 'k_cur000000001', name: 'same-key', fingerprint: 'SHA256:FP1', publicKey: 'ssh-ed25519 AAA1', privateKey: 'PK1' }],
    accounts: [{ id: 'a_cur000000001', name: 'cur-acc', kind: 'os', corp: 'vcA', username: 'u', keyRef: 'k_cur000000001', password: '' },
      { id: 'a_cur000000002', name: 'gone-acc', kind: 'os', corp: 'vcA', username: 'u2', keyRef: 'k_nokey0000001', password: '' }] };
  const bundle = { keys: [{ id: 'k_bun000000001', name: 'old-name', fingerprint: 'SHA256:FP1', publicKey: 'ssh-ed25519 AAA1', privateKey: '' }], accounts: [] };
  const m = BUN.mergeRedactedKeyStore(JSON.stringify(bundle), JSON.stringify(cur));
  const j = JSON.parse(m.text);
  assert.deepEqual(j.keys.map((k) => [k.id, k.fingerprint]), [['k_bun000000001', 'SHA256:FP1']], '같은 키는 번들 id 로 되살아난다(1회차 D2)');
  const acc = Object.fromEntries(j.accounts.map((a) => [a.name, a.keyRef]));
  assert.deepEqual(acc, { 'cur-acc': 'k_bun000000001', 'gone-acc': '' }, '지금 파일에만 있는 계정의 기본 키는 지문으로 이어진다(예전에는 조용히 비웠다)');
  assert.ok(m.dropped.includes('account-key:gone-acc') && !m.dropped.includes('account-key:cur-acc'), JSON.stringify(m.dropped));
});

test('㉑-h 받는 곳 훑기는 한 번에 하나(진행 중이면 지난 결과 + busy · 화면 inbox.busy — 2회차 C2-1) · 진행 기록 읽기 오류는 손상이 아니다(원본을 두고 빈 것 — JSON 깨짐만 보존본 · C2-8) · 메일 대기열에서 넘쳐 버린 수는 다음 메일의 ‘외 N건’ · 제목 건수에 더한다(C2-6)', async () => {
  const INB = await import('../src/sshaccess/inbox.js');
  INB._resetInboxScanForTest();
  const p1 = INB.scanInbox({ corps: [], servers: [] });
  const p2 = await INB.scanInbox({ corps: [], servers: [] });
  assert.deepEqual([p2.busy, p2.items], [true, []], '앞 훑기가 끝나지 않았으면 기다리지 않는다');
  const v = await SVC.buildView();
  assert.equal(v.inbox.busy, true, '화면도 그 사실을 받는다');
  const r1 = await p1;
  assert.equal(r1.busy, undefined);
  const again = INB.scanInbox({ corps: [], servers: [] });
  const busyAgain = await INB.scanInbox({ corps: [], servers: [] });
  assert.deepEqual([busyAgain.busy, busyAgain.dir], [true, r1.dir], '진행 중이면 지난 결과에 busy');
  await again;
  assert.equal((await SVC.buildView()).inbox.busy, false);
  INB._resetInboxScanForTest();
  // 진행 기록 — 읽기 오류(파일 자리에 폴더)는 빈 것으로 보고 원본을 옮기지 않는다 · JSON 깨짐은 보존본
  const j = subRun({ owners: 'solo', users: [{ username: 'solo', role: 'admin', totpEnabled: true, totpSecret: generateSecret() }], code: `
    const INF = await imp('sshaccess/inflight.js'); const f = path.join(process.env.CONFIG_DIR, INF.INFLIGHT_FILE_NAME);
    fs.mkdirSync(f);
    const a = INF.peekLeftovers(); const corrupt0 = fs.readdirSync(process.env.CONFIG_DIR).filter((n) => n.includes('.corrupt.')).length; const stillDir = fs.statSync(f).isDirectory();
    fs.rmdirSync(f); fs.writeFileSync(f, '{ broken'); INF._resetInflightForTest();
    const b = INF.peekLeftovers(); const corrupt1 = fs.readdirSync(process.env.CONFIG_DIR).filter((n) => n.startsWith(INF.INFLIGHT_FILE_NAME + '.corrupt.')).length;
    console.log(JSON.stringify({ a, corrupt0, stillDir, b, corrupt1 }));` });
  assert.deepEqual([j.a, j.corrupt0, j.stillDir, j.b, j.corrupt1], [[], 0, true, [], 1], JSON.stringify(j));
  // 메일 — 순수 함수 · 실제 대기열(상한 = 60 × 4)
  const evs = Array.from({ length: 3 }, (_, i) => ({ kind: 'corp-stop', corp: `c${i}` }));
  const m = N.buildMail(evs, { dropped: 7 });
  assert.deepEqual([m.count, /사건 10건/.test(m.subject), /… 외 7건은 이 메일에 싣지 않았습니다/.test(m.text)], [10, true, true], JSON.stringify(m));
  assert.equal(N.buildMail(evs.slice(0, 1), { dropped: 0 }).count, 1);
  const q = subRun({ owners: 'solo', users: [{ username: 'solo', role: 'admin', totpEnabled: true, totpSecret: generateSecret() }], code: `
    const ST = await imp('sshaccess/state.js'); const N = await imp('sshaccess/notify.js');
    const mails = []; N._setKeyNotifySendForTest(async (m) => { mails.push(m); return { ok: true }; }); N.startKeyNotify();
    for (let i = 0; i < 3; i += 1) ST.addEvents(Array.from({ length: 100 }, (_, n) => ({ kind: 'corp-stop', corp: 'q' + i + '-' + n })));
    await N._flushKeyNotifyForTest();
    ST.addEvent({ kind: 'corp-stop', corp: 'next-one' }); await N._flushKeyNotifyForTest();
    console.log(JSON.stringify({ mails: mails.map((m) => ({ subject: m.subject, more: (/외 (\\d+)건/.exec(m.text) || [])[1] || '' })) }));` });
  assert.deepEqual(q.mails.map((x) => [(/사건 (\d+)건/.exec(x.subject) || [])[1] || '1', x.more]), [['300', '240'], ['1', '']], `대기열 상한(240)에서 버린 60건도 센다(예전: 사건 240건 · 외 180건) ${JSON.stringify(q.mails)}`);
  assert.match(q.mails[1].subject, /법인 키 사용 중지 · next-one/, '버린 수는 한 번만 더한다(다음 메일은 제 건수)');
});

test('㉑-i 작업이 서버 자물쇠를 기다리는 사이 멈췄으면 그 서버는 하지 않는다(cancelled · 접속 0회 — 2회차 C2-2: 앞 동작이 오래 쥐고 있으면 멈추기가 듣지 않았다)', async () => {
  const S = await fakeSshd(); const pw = secret('Pw-Lock-Cancel-21i'); S.st.password = pw;
  const K = mkKey('lock-cancel');
  const sv = mkServer('bm-lock-cancel', S, { password: pw });
  let rel; let entered;
  const inLock = new Promise((r) => { entered = r; });
  const held = KL.withServerLock(KL.serverLockKey(rawOf(sv.id)), () => new Promise((r) => { entered(); rel = r; }));
  await inLock;
  const st = await SVC.startKeyLogin({ servers: [sv], keyId: K.id, by: 'own' });
  assert.equal(st.ok, true, JSON.stringify(st));
  await sleep(100);
  assert.equal(SVC.cancelKeyJob(st.jobId, { by: 'own' }).ok, true);
  rel(); await held;
  const v = await waitJob(st.jobId);
  assert.deepEqual([v.results[0].code, S.st.conns], ['cancelled', 0], JSON.stringify(v.results));
  assert.match(v.results[0].reason, /작업을 멈춰 이 서버는 하지 않았습니다/);
});

test('㉑-j 점검 회차가 하는 뒷일(2회차 C2-3 · C2-4 · C2-5 · C2-8) — 작업 끝 사건을 못 쓰면 콘솔에 남기고 다음 점검 때 다시 쓴다 · 중단 기록은 기동뿐 아니라 점검 때도 옮기되 이 프로세스에 살아 있는 작업은 뺀다 · 버려진 회차는 쓰지 않는다(소스) · 지울 때는 지금 서버 목록', async () => {
  // ① 작업 끝 사건 쓰기 실패 → 다음 점검 때 다시(자식 프로세스 — 상태 파일을 작업 도중 망가뜨린다)
  const j = subRun({ owners: 'solo', users: [{ username: 'solo', role: 'admin', totpEnabled: true, totpSecret: generateSecret() }], code: `
    const VAULT = await imp('security/secretVault.js'); VAULT.saveSecretsPolicy({ mode: 'encrypted', level: 1 });
    const { store } = await imp('store.js'); store.snapshot = { ...store.get(), vcenters: [{ id: 'vcA', name: 'A' }] };
    const KS = await imp('bmusage/onboard/keyStore.js'); const BM = await imp('bmstor/registry.js');
    const ST = await imp('sshaccess/state.js'); const SVC = await imp('sshaccess/service.js'); const KL = await imp('sshaccess/keyLogin.js');
    const k = KS.addKey({ name: 'wje-key', privateKey: F.ed25519Key().pem, folderCorp: 'vcA', features: ['bm-usage'] }, { by: 'x' });
    const s = BM.saveBmServer({ name: 'wje-s1', host: '127.0.0.1', port: 1, username: 'mon', mounts: ['/'], vcenterId: 'vcA', password: 'x' });
    const addr = SVC.serverKeyCandidates(s.server.id).server.addr;
    const warns = []; const ow = console.warn; console.warn = (...a) => { warns.push(a.join(' ')); };
    const st = await SVC.startKeyLogin({ servers: [{ id: s.server.id, addr }], keyId: k.key.id, by: 'solo' });
    fs.writeFileSync(path.join(process.env.CONFIG_DIR, ST.STATE_FILE_NAME), '{ bad'); ST._resetSshAccessStateForTest();
    for (let i = 0; i < 200 && !KL.jobView(st.jobId)?.doneAt; i += 1) await new Promise((r) => setTimeout(r, 20));
    const ev0 = ST.listEvents({ limit: 20 }).map((e) => e.kind);
    fs.writeFileSync(path.join(process.env.CONFIG_DIR, ST.STATE_FILE_NAME), '{}'); ST._resetSshAccessStateForTest();
    const sc = await SVC.runSshAccessScan();
    const ev1 = ST.listEvents({ limit: 20 }).filter((e) => e.kind === 'key-job-done').map((e) => e.detail);
    const sc2 = await SVC.runSshAccessScan();
    const n2 = ST.listEvents({ limit: 20 }).filter((e) => e.kind === 'key-job-done').length;
    console.warn = ow;
    console.log(JSON.stringify({ st: st.ok, ev0, sc: sc.ok, ev1, sc2: sc2.ok, n2, warns: warns.filter((w) => w.startsWith('[ssh-access]')) }));` });
  assert.deepEqual([j.st, j.ev0, j.sc, j.ev1, j.n2], [true, [], true, ['1대 — 확인 0 · 실패 1 — wje-s1(connect)'], 1], JSON.stringify(j));
  assert.ok(j.warns.some((w) => /키 작업 결과 사건 2건을 쓰지 못했습니다 — 다음 점검 때 다시 씁니다/.test(w)), JSON.stringify(j.warns));
  // ② 점검 때 중단 기록 옮기기 — 지금 돌고 있는 작업(이 프로세스)의 기록은 그대로 · 지난 실행의 기록만 사건으로
  const INF = await import('../src/sshaccess/inflight.js');
  const S = await fakeSshd(); const pw = secret('Pw-Leftover-21j'); S.st.password = pw;
  const K = mkKey('leftover-live'); const sv = mkServer('bm-leftover-live', S, { password: pw });
  const h = holdInstall(S, K);
  const st = await SVC.startKeyLogin({ servers: [sv], keyId: K.id, by: 'own' });
  await h.reached;
  INF.markStart({ jobId: 'kj_0dead0dead00', kind: 'key-revoke', keyName: 'old-run', sid: 'bm_old', server: 'bm-old-run', corp: 'vcA', by: 'own' });
  const before = eventsOf('key-job-interrupted').length;
  try {
    const sc = await SVC.runSshAccessScan();
    assert.equal(sc.ok, true, JSON.stringify(sc));
    const ev = eventsOf('key-job-interrupted');
    assert.equal(ev.length, before + 1, JSON.stringify(ev.slice(0, 3)));
    assert.equal(ev[0].target, 'bm-old-run · old-run');
    assert.ok(!ev.some((e) => e.target.includes('leftover-live')), '살아 있는 작업은 ‘재시작으로 중단됨’ 이 아니다(기동 직후 시작한 작업이 그렇게 적혔다)');
    assert.deepEqual(INF.peekLeftovers().map((x) => x.jobId), [st.jobId], '살아 있는 작업의 기록은 남는다');
  } finally { h.release(); }
  await waitJob(st.jobId);
  assert.deepEqual(INF.peekLeftovers(), []);
  // ③ 소스 — 버려진 회차(15분 상한을 넘겨 다음 회차가 돌았다)는 뒷일 · 쓰기 · 지우기 전에 돌아간다 · 지울 때는 지금 서버 목록
  const svc = (await import('./_stripComments.js')).stripComments(fs.readFileSync(path.join(SRC, 'sshaccess/service.js'), 'utf8'));
  assert.match(svc, /if \(_runningSince !== myRun\) return \{ ok: false, abandoned: true \};\s*retryJobEvents\(\);\s*processLeftovers\(\);\s*const wrote = /);
  assert.match(svc, /const exp = TP\.expireSweep\(\{ now \}\)[^]*?if \(exp\.length\) writeJobEvents\(exp\);[^]*?if \(_runningSince !== myRun\) return/, '만료 사건은 점검 맨 앞에서 바로 쓴다(버려진 회차여도 남는다 — 2회차 반증)');
  assert.match(svc, /if \(!regErr && !bmRegistryLoadError\(\)\) INS\.pruneInstalled\(new Set\(listBmServersRaw\(\)\.map\(\(s\) => s\.id\)\)\);/);
  assert.match(svc, /startKeyNotify\(\);[^]*?processLeftovers\(\);[^]*?const run = \(\) =>/, '기동 때도');
  assert.match(svc, /_pendingJobEvents = capPending\(_pendingJobEvents\.concat\(list\)\);/, '다시 쓸 사건은 상한(200)을 넘으면 비중요부터 버리고 수를 알린다(3회차 C3-3 — capPending → ST.reportLostEvents)');
  assert.match(svc, /function capPending\(list\) \{[^]*?ST\.reportLostEvents\(lost\);/);
});

test('㉑-k 회전 · 읽기 · 회전 판정(2회차 E2-1 · E2-3) — 새 키에 수집 기능이 없으면 요청 본문에 toFeatures · noCollect · 응답에 warning · 서버에서 키 읽기는 없음(missing · error 없음)과 못 읽음(readFailed · unreadable · notfile)을 가른다 · 승인 대기 키로는 회전하지 않는다(key-pending)', async () => {
  // 회전 — 승인 요청에 새 키의 허용 기능을 싣는다
  const kFrom = mkKey('rot-from'); const kNoCol = mkKey('rot-nocollect', { features: ['disk-audit'] }); const kCol = mkKey('rot-collect', { features: ['bm-storage'] });
  const a = await SVC.rotateKeyReq({ from: kFrom.id, to: kNoCol.id, by: 'own' });
  assert.deepEqual([a.pending, a.request.payload.toFeatures, a.request.payload.noCollect], [true, ['disk-audit'], true], JSON.stringify(a));
  assert.match(a.warning, /새 키 ‘rot-nocollect’ 는 베어메탈 사용률 · 스토리지 수집에 허용되지 않았습니다 — 옛 키를 쓰던 서버의 주기 수집이 멈춥니다/);
  assert.equal((await SVC.decideApproval(a.request.id, { approve: false, by: 'own' })).request.status, 'cancelled');
  const b = await SVC.rotateKeyReq({ from: kFrom.id, to: kCol.id, by: 'own' });
  assert.deepEqual([b.pending, b.request.payload.noCollect, b.warning], [true, false, undefined], JSON.stringify(b));
  assert.equal((await SVC.decideApproval(b.request.id, { approve: false, by: 'own' })).request.status, 'cancelled');
  // 회전 판정(refs) — 새 키가 승인 대기면 key-pending(퇴역과 가른다)
  const kPend = mkKey('rot-pending', { pending: true });
  assert.deepEqual((({ ok, code }) => [ok, code])(REFS.rotateKey(kFrom.id, kPend.id)), [false, 'key-pending']);
  KS.deleteKey?.(kPend.id);
  // 읽기 명령(실제 bash) — 없음 · 있음 · 일반 파일 아님(폴더 · 끊긴 링크) · 못 읽음(비 root)
  const h0 = mkHome(); fs.mkdirSync(path.join(h0, '.ssh'));
  const run = (h) => AK.parseReadOutput(spawnSync('bash', ['-c', AK.READ_COMMAND], { env: { HOME: h, PATH: process.env.PATH }, encoding: 'utf8' }).stdout);
  assert.deepEqual(run(h0), { ok: true, present: false, keys: [], bad: 0, truncated: 0 });
  fs.mkdirSync(path.join(h0, '.ssh', 'authorized_keys'));
  assert.deepEqual((({ ok, code }) => [ok, code])(run(h0)), [false, 'notfile']);
  const h1 = mkHome(); fs.mkdirSync(path.join(h1, '.ssh')); fs.symlinkSync(path.join(h1, 'nowhere'), path.join(h1, '.ssh', 'authorized_keys'));
  assert.deepEqual((({ ok, code }) => [ok, code])(run(h1)), [false, 'notfile'], '끊긴 링크');
  const ro = roHome(`${OTHER}\n`); fs.chmodSync(path.join(ro.h, '.ssh', 'authorized_keys'), 0o000);
  assert.deepEqual((({ ok, code }) => [ok, code])(AK.parseReadOutput(shRo(AK.READ_COMMAND, ro, 'bash').out)), [false, 'unreadable'], ro.how);
  assert.deepEqual((({ ok, code }) => [ok, code])(AK.parseReadOutput('Welcome!\n##AK present\n')), [false, undefined], '표지가 첫 줄이 아니면 모양 오류(코드 없음)');
  // 서버에서 키 읽기 — 파일 없음은 읽기 실패가 아니다(missing · error '') · 일반 파일이 아니면 readFailed(화면이 ‘읽지 못했습니다’)
  const S = await fakeSshd(); const pw = secret('Pw-Read-21k'); S.st.password = pw;
  const sv = mkServer('bm-read-21k', S, { password: pw });
  fs.rmSync(path.join(S.home, '.ssh', 'authorized_keys'), { force: true });
  const r1 = await SVC.readInstalledKeys({ serverId: sv.id, by: 'own' });
  assert.deepEqual([r1.ok, r1.missing, r1.readFailed, r1.error, r1.keys.length], [true, true, false, '', 0], JSON.stringify(r1));
  fs.mkdirSync(path.join(S.home, '.ssh', 'authorized_keys'), { recursive: true });
  const r2 = await SVC.readInstalledKeys({ serverId: sv.id, by: 'own' });
  assert.deepEqual([r2.ok, r2.missing, r2.readFailed], [true, false, true], JSON.stringify(r2));
  assert.match(r2.error, /일반 파일이 아니거나 따라갈 수 없는 링크/);
  fs.rmdirSync(path.join(S.home, '.ssh', 'authorized_keys'));
});

test('㉒ 원격 스크립트 2회차 축 B(실제 bash · dash) — 자기 시한(SCRIPT_DEADLINE_S — 산수 고정 · mv 직전 늦으면 fail slow · 자물쇠 기다림도 시한) · 주인 표 호스트 = 이름/부팅 id/pid 이름공간(이름만 같으면 pid 로 치우지 않는다) · 주인 표 쓰기 중 자물쇠가 사라지면 다시 잡는다 · 옮기기 직전 표 재확인 · 되돌릴 자리에 새 자물쇠가 있으면 되돌리지 않는다 · ~/.ssh mkdir 경합은 실패가 아니다', () => {
  // 산수 — 스크립트가 스스로 멈추는 시각 + date 1초 해상도 + 채널 열기 · exec 왕복 여유(≥ 3초, 800ms+ RTT) < 포탈의 exec 시한
  assert.ok(AKS.SCRIPT_DEADLINE_S * 1000 + 1000 + 3000 < KL.STEP_TIMEOUT_MS, `${AKS.SCRIPT_DEADLINE_S}s vs ${KL.STEP_TIMEOUT_MS}ms`);
  assert.match(KL.failText('slow'), new RegExp(`${AKS.SCRIPT_DEADLINE_S}초 안에 바꾸기까지 가지 못해 멈췄습니다[^]*원래 파일은 그대로`));
  const line = KL.buildKeyLine({ publicKey: BPUB, keyId: BID });
  const add = AKS.installScript({ publicKey: BPUB, keyId: BID, line });
  const rm = AKS.removeScript({ publicKey: BPUB, keyId: BID });
  const rb = AKS.rollbackScript({ line });
  const binLock = fakeBin('lockhooks');
  const mk = (body) => { const h = mkHome(); fs.mkdirSync(path.join(h, '.ssh'), { mode: 0o700 }); const f = path.join(h, '.ssh', 'authorized_keys'); if (body !== null) fs.writeFileSync(f, body, { mode: 0o600 }); return { h, f, lk: path.join(h, '.ssh', '.authorized_keys.portal.lock') }; };
  const owner = (lk, tok) => { fs.mkdirSync(lk, { recursive: true }); fs.writeFileSync(path.join(lk, 'owner'), `${tok}\n`); };
  const nowS = () => Math.floor(Date.now() / 1000);
  const deadPid = spawnSync('true').pid;
  const live = `${HOSTID}:${process.pid}:${nowS()}`;
  const clean = (x) => fs.readdirSync(path.join(x.h, '.ssh')).filter((n) => n !== 'authorized_keys');
  for (const shell of SHELLS) {
    // ① 늦었다(시작 뒤 12초 넘음 — 가짜 date 셋째 호출부터 +100초) → mv 직전에 멈춘다: 바꾼 것 없음 · 파일 그대로 · 자물쇠 · 임시 파일 없음
    for (const [sc, body] of [[add, `${OTHER}\n`], [rm, `${OTHER}\n${line}\n`], [rb, `${OTHER}\n${line}\n`]]) {
      const x = mk(body); fs.writeFileSync(path.join(x.h, 'clock-late'), '');
      const r = sh(sc, x.h, shell, { PATH: binLock });
      assert.deepEqual([r.m, r.code, fs.readFileSync(x.f, 'utf8'), clean(x)], [{ kind: 'fail', why: 'slow' }, 3, body, []], `${shell}: ${r.out}${r.err}`);
    }
    //    자물쇠 기다림도 시한 — 늦었으면 15번을 채우지 않고 바로 locked(기다리지 않음)
    const xl = mk(`${OTHER}\n`); owner(xl.lk, live); fs.writeFileSync(path.join(xl.h, 'clock-late'), '');
    const rl = sh(add, xl.h, shell, { PATH: binLock });
    assert.deepEqual([rl.m, fs.existsSync(path.join(xl.h, 'sleeps'))], [{ kind: 'fail', why: 'locked' }, false], `${shell}: ${rl.out}`);
    // ② 주인 표 호스트 — 이름만 같고(부팅 id · 이름공간 없음 · 다름) pid 가 없는 표는 ‘다른 호스트’ 라 pid 로 치우지 않는다(10분 규칙만 — 방금 표면 기다림)
    for (const tok of [`${os.hostname()}:${deadPid}:${nowS()}`, `${os.hostname()}/00000000-0000-0000-0000-000000000000/pid:[1]:${deadPid}:${nowS()}`]) {
      const x = mk(`${OTHER}\n`); owner(x.lk, tok);
      assert.deepEqual(sh(add, x.h, shell, { PATH: binLock }).m, { kind: 'fail', why: 'locked' }, `${shell} ${tok}`);
      assert.equal(fs.readFileSync(path.join(x.lk, 'owner'), 'utf8'), `${tok}\n`, '남의 자물쇠 그대로');
    }
    //    같은 호스트 식(이름/부팅 id/이름공간 — 이름공간 글자에 ':' 가 있어 오른쪽부터 가른다) + 죽은 pid → 치우고 넣는다
    { const x = mk(`${OTHER}\n`); owner(x.lk, `${HOSTID}:${deadPid}:${nowS()}`); assert.deepEqual(sh(add, x.h, shell, { PATH: binLock }).m, M('added'), shell); assert.deepEqual(clean(x), []); }
    // ③ 주인 표를 쓰는 사이 자물쇠 폴더가 사라졌다(남은 자물쇠를 치우던 쪽이 막 만든 내 자물쇠를 옮김) → 실패가 아니라 다시 잡는다 · 5번 내리면 write
    for (const [n, want] of [[4, M('added')], [5, { kind: 'fail', why: 'write' }]]) {
      const x = mk(`${OTHER}\n`); fs.writeFileSync(path.join(x.h, 'owner-vanish'), String(n));
      const r = sh(add, x.h, shell, { PATH: binLock });
      assert.deepEqual([r.m, clean(x)], [want, []], `${shell} 사라짐 ${n}번: ${r.out}${r.err}`);
    }
    // ④ 옮기기 직전 표 재확인 — 남은 자물쇠(죽은 pid)로 판단한 뒤 · 옮기기 전에 다른 쪽이 그 자리를 새로 잡았다(표가 바뀜) → 옮기지 않는다 · 끝까지 기다려 locked
    { const x = mk(`${OTHER}\n`); owner(x.lk, `${HOSTID}:${deadPid}:${nowS()}`);
      fs.writeFileSync(path.join(x.h, 'date-hook.sh'), `[ "$dc" = 4 ] && printf '%s\\n' '${live}' > "$HOME/.ssh/.authorized_keys.portal.lock/owner"\n`);
      const r = sh(add, x.h, shell, { PATH: binLock });
      assert.deepEqual([r.m, fs.existsSync(path.join(x.h, 'stale-mv')), fs.readFileSync(path.join(x.lk, 'owner'), 'utf8'), clean(x)], [{ kind: 'fail', why: 'locked' }, false, `${live}\n`, ['.authorized_keys.portal.lock']], `${shell}: ${r.out}`); }
    // ⑤ 옮긴 뒤 보니 남의 새 자물쇠였고(표가 판단한 것과 다름) 그 사이 또 다른 새 자물쇠가 생겼다 → 되돌리지 않는다(예전: mv 가 새 자물쇠 **안으로** 들어가 찌꺼기를 남겼다)
    { const x = mk(`${OTHER}\n`); owner(x.lk, `${HOSTID}:${deadPid}:${nowS()}`);
      fs.writeFileSync(path.join(x.h, 'mv-hook.sh'), `printf '%s\\n' 'other-x:1:1' > "$2/owner"; mkdir "$1"; printf '%s\\n' '${live}' > "$1/owner"\n`);
      const r = sh(add, x.h, shell, { PATH: binLock });
      assert.deepEqual([r.m, fs.readdirSync(x.lk), fs.readFileSync(path.join(x.lk, 'owner'), 'utf8'), clean(x)], [{ kind: 'fail', why: 'locked' }, ['owner'], `${live}\n`, ['.authorized_keys.portal.lock']], `${shell}: ${r.out}`); }
    //    새 자물쇠가 없으면 되돌린다(옮긴 것이 남의 자물쇠였다 — 표 그대로)
    { const x = mk(`${OTHER}\n`); owner(x.lk, `${HOSTID}:${deadPid}:${nowS()}`);
      fs.writeFileSync(path.join(x.h, 'mv-hook.sh'), `printf '%s\\n' '${live}' > "$2/owner"\n`);
      const r = sh(add, x.h, shell, { PATH: binLock });
      assert.deepEqual([r.m, fs.readFileSync(path.join(x.lk, 'owner'), 'utf8'), clean(x)], [{ kind: 'fail', why: 'locked' }, `${live}\n`, ['.authorized_keys.portal.lock']], `${shell}: ${r.out}`); }
    // ⑥ 처음 넣기 둘이 겹쳐 ~/.ssh 를 남이 먼저 만들었다(내 mkdir 실패) — 진짜 폴더면 실패가 아니다(예전: fail mkdir)
    { const h = mkHome(); fs.writeFileSync(path.join(h, 'ssh-race'), '');
      const r = sh(add, h, shell, { PATH: binLock });
      assert.deepEqual([r.m, fs.existsSync(path.join(h, 'ssh-race'))], [M('added'), false], `${shell}: ${r.out}${r.err}`);
      assert.ok(fs.readFileSync(path.join(h, '.ssh', 'authorized_keys'), 'utf8').includes(line)); }
  }
});

test('㉒-b 키 접속 확인은 이번 접속의 nonce 를 되돌려 받아야 한다(2회차 B6) — 그 키 줄에 강제 명령(command=)이 있으면 접속은 되지만 우리 명령이 돌지 않는다: key-login-failed · 묶지 않음 · 저장 비밀번호 그대로 · 로그인 메시지가 섞여도 nonce 줄을 찾는다', async () => {
  const S = await fakeSshd(); const pw = secret('Pw-Forced-22b'); S.st.password = pw;
  const K = mkKey('kl-forced');
  const sv = mkServer('bm-kl-forced', S, { password: pw });
  // 관리자가 그 키의 포탈 줄에 강제 명령을 붙여 두었다(덜 엄한 줄을 더하지 않는다 — B-F4) · 그 줄로 키 접속은 된다
  S.writeAk(`${OTHER}\ncommand="/bin/echo hi",no-pty ${K.pub} portal-ssh:${K.id}\n`);
  const r = (await runLogin({ servers: [sv], keyId: K.id, removePassword: true, by: 'own' })).job.results[0];
  assert.deepEqual([r.ok, r.code, !!r.bound, !!r.passwordRemoved], [false, 'key-login-failed', false, false], JSON.stringify(r));
  assert.match(r.reason, /포탈이 보낸 명령이 돌지 않았습니다\(그 키 줄에 강제 명령\(command=\)이 있는 등\)/);
  assert.match(r.reason, /이 키로는 수집할 수 없어 묶지 않았습니다\. /, '문장이 끝난 뒤 덧붙는다(마침표 — 2회차 반증 문구)');
  assert.doesNotMatch(r.reason, /출발지 제한/, '로그인은 됐다(강제 명령) — 출발지 제한 안내는 키가 거부됐을 때만(3회차 E3-5)');
  assert.deepEqual([rawOf(sv.id).keyRef, rawOf(sv.id).password], [undefined, pw], '묶지 않았다 · 저장 비밀번호를 지우지 않았다(예전: uname 이 성공으로 끝나 묶고 지웠다)');
  assert.ok(S.st.execs.some((x) => x.forced === '/bin/echo hi'), '전제 — 강제 명령이 돌았다');
  assert.equal(S.readAk(), `${OTHER}\ncommand="/bin/echo hi",no-pty ${K.pub} portal-ssh:${K.id}\n`, '관리자 줄 그대로');
  // 강제 명령이 확인 줄 꼴을 흉내 내도(다른 nonce) 확인되지 않는다 — 이번 접속의 nonce 만 맞는 것으로 친다
  S.writeAk(`${OTHER}\ncommand="echo '##KLV 000000000000 Linux'",no-pty ${K.pub} portal-ssh:${K.id}\n`); S.clear();
  const rf = (await runLogin({ servers: [sv], keyId: K.id, removePassword: true, by: 'own' })).job.results[0];
  assert.deepEqual([rf.ok, rf.code, rawOf(sv.id).keyRef, rawOf(sv.id).password], [false, 'key-login-failed', undefined, pw], JSON.stringify(rf));
  // 우리가 줄을 더했고(출발지 제한) 키 로그인은 됐지만 명령이 강제됐다 → 더한 줄은 되돌리고 · 출발지 제한 안내는 붙이지 않는다(거부가 아니다 — 3회차 E3-5)
  const S3 = await fakeSshd(); S3.st.password = pw; S3.writeAk(`${OTHER}\n`);
  const sv3 = mkServer('bm-kl-forced-added', S3, { password: pw });
  S3.st.forceCmd = (conn) => (conn === 2 ? 'echo hi' : null);
  const r3 = (await runLogin({ servers: [sv3], keyId: K.id, removePassword: true, by: 'own' })).job.results[0];
  assert.deepEqual([r3.ok, r3.code, r3.line, r3.rolledBack, rawOf(sv3.id).password], [false, 'key-login-failed', 'added', true, pw], JSON.stringify(r3));
  assert.doesNotMatch(r3.reason, /출발지 제한/, JSON.stringify(r3));
  assert.equal(S3.readAk(), `${OTHER}\n`, '더한 줄을 지웠다');
  // 대조 — 강제 명령이 없는 서버에서는 배너가 섞여도 확인된다(nonce 줄을 찾는다)
  const S2 = await fakeSshd(); S2.st.password = pw;
  const sv2 = mkServer('bm-kl-nonce-banner', S2, { password: pw });
  S2.st.banner = (cmd, conn) => (conn === 2 ? 'Last login: today\n##KLV 000000000000 Fake\n' : null);   // 다른 nonce 의 가짜 줄은 맞는 것으로 치지 않는다
  const r2 = (await runLogin({ servers: [sv2], keyId: K.id, by: 'own' })).job.results[0];
  assert.deepEqual([r2.ok, r2.bound], [true, true], JSON.stringify(r2));
  const verify = S2.st.execs.find((x) => x.conn === 2);
  assert.match(scriptOf(verify.command), /^echo "##KLV [0-9a-f]{12} \$\(uname -s 2>\/dev\/null\)"$/m, '확인 명령은 nonce 를 되돌려 받는 꼴(셸과 무관하게 /bin/sh 로 싼다)');
});

/* ── 2회차 반증 반영(973b7224) 회귀 ─────────────────────────────────────── */
test('㉓-a 진행 기록을 못 읽어도(파일 자리에 폴더 — EISDIR) 키 작업은 끝까지 돈다 — 기록만 못 함(markStart · markEnd · clearLeftovers 가 false · 원본을 덮지 않음 — 2회차 반증 R2R-1: 모든 키 작업이 오류로 끝났다) · 이 프로세스가 시작한 작업의 남은 줄(지우기 실패)은 ‘재시작으로 중단’ 이 아니다(끝났으면 조용히 지움)', async () => {
  const INF = await import('../src/sshaccess/inflight.js');
  const file = path.join(DIR, INF.INFLIGHT_FILE_NAME);
  const S = await fakeSshd(); const pw = secret('Pw-Inflight-Eisdir-23a'); S.st.password = pw;
  const K = mkKey('eisdir-key');
  const sv = mkServer('bm-eisdir', S, { password: pw });
  S.writeAk(`${OTHER}\n${K.pub} portal-ssh:${K.id}\n`);
  fs.rmSync(file, { force: true }); fs.mkdirSync(file); INF._resetInflightForTest();
  try {
    const rec = { jobId: 'kj_eeeeeeeeeeee', kind: 'key-revoke', keyName: 'k', sid: 'bm_e', server: 'e', corp: 'vcA', by: 'own' };
    assert.deepEqual([INF.markStart(rec), INF.markEnd(rec), INF.clearLeftovers([rec]), INF.peekLeftovers()], [false, false, false, []]);
    const rv = (await runRevoke({ keyId: K.id, servers: [sv], by: 'own' })).job.results[0];
    assert.deepEqual([rv.ok, rv.code, rv.removed], [true, 'removed', 1], `거두기는 기록 없이도 끝난다(예전: 작업 오류) ${JSON.stringify(rv)}`);
    assert.equal(S.readAk(), `${OTHER}\n`);
    assert.equal(fs.statSync(file).isDirectory(), true, '원본(폴더)을 덮지 않았다');
  } finally { fs.rmSync(file, { recursive: true, force: true }); INF._resetInflightForTest(); }
  // 이 프로세스가 시작해 끝난 작업의 줄이 남았다(지우기 실패 흉내) → 점검이 ‘중단’ 사건으로 적지 않고 조용히 지운다
  const S2 = await fakeSshd(); S2.st.password = pw;
  const sv2 = mkServer('bm-mine-done', S2, { password: pw });
  const j = await runLogin({ servers: [sv2], keyId: K.id, by: 'own' });
  INF.markStart({ jobId: j.start.jobId, kind: 'key-login', keyName: K.name, sid: sv2.id, server: 'bm-mine-done', corp: 'vcA', by: 'own' });
  KL._resetKeyLoginJobsForTest();   // 작업 기록이 1시간 뒤 사라진 때(jobView 없음) — 그래도 이 프로세스가 시작한 작업이면 ‘재시작으로 중단’ 이 아니다
  assert.equal(KL.jobView(j.start.jobId), null, '전제');
  const before = eventsOf('key-job-interrupted').length;
  assert.equal((await SVC.runSshAccessScan()).ok, true);
  assert.deepEqual([eventsOf('key-job-interrupted').length, INF.peekLeftovers()], [before, []], '내 작업의 남은 줄은 중단이 아니다 · 끝났으니 지웠다');
});

test('㉓-b 원격 스크립트(실제 bash · dash · 2회차 반증 R2R-3 · R2R-4) — mv 직전 ‘##KL commit’ 을 내고 그 쓰기가 실패하면(포탈이 끊음) 바꾸지 않고 종료 3 · 마지막 표지가 commit 이면 결과 모름(begun) · 쓸 수 없는 ~/.ssh 는 옛 자물쇠가 남아 있어도 빠른 답(줄 없음 removed 0 · 바꿀 것이 있으면 바로 notwritable) · locked 문구에 숫자 없음', () => {
  assert.deepEqual([KL.parseMarker('##KL begin\n##KL commit\n'), KL.parseMarker('##KL begin\n##KL commit\n##KL added 0 0\n').kind], [{ kind: 'begun' }, 'added']);
  assert.doesNotMatch(KL.failText('locked'), /\d+초/, '기다리는 시간은 자기 시한에 따라 다르다 — 숫자를 박지 않는다');
  const line = KL.buildKeyLine({ publicKey: BPUB, keyId: BID });
  const scripts = { 넣기: [AKS.installScript({ publicKey: BPUB, keyId: BID, line }), `${OTHER}\n`], 거두기: [AKS.removeScript({ publicKey: BPUB, keyId: BID }), `${OTHER}\n${line}\n`], 되돌림: [AKS.rollbackScript({ line }), `${OTHER}\n${line}\n`] };
  const binNoSleep = fakeBin('nosleep');
  for (const shell of SHELLS) {
    for (const [name, [sc, body]] of Object.entries(scripts)) {
      assert.ok(sc.includes("'echo \"##KL commit\" || exit 3'") || sc.includes('echo "##KL commit" || exit 3'), name);
      // 출력이 써지지 않는다(/dev/full — 포탈이 끊어 출력 관이 닫힌 것과 같다: 쓰기 실패) → commit 표지 쓰기에서 멈춘다
      const h = mkHome(); fs.mkdirSync(path.join(h, '.ssh'), { mode: 0o700 }); const f = path.join(h, '.ssh', 'authorized_keys'); fs.writeFileSync(f, body, { mode: 0o600 });
      const r = spawnSync(shell, ['-c', `exec >/dev/full; ${sc}`], { env: { HOME: h, PATH: process.env.PATH, SSH_CONNECTION: '127.0.0.1 50000 127.0.0.1 22' }, encoding: 'utf8' });
      assert.deepEqual([r.status, fs.readFileSync(f, 'utf8'), fs.readdirSync(path.join(h, '.ssh'))], [3, body, ['authorized_keys']], `${shell} ${name}: 바꾸지 않았다 · 자물쇠 · 임시 파일 없음(${r.stderr.slice(0, 200)})`);
    }
    // 쓸 수 없는 ~/.ssh + 옛 자물쇠(주인 살아 있음) — 기다리지 않는다(예전: 바꿀 것이 없어도 · 있어도 15번 기다려 locked)
    const live = `${HOSTID}:${process.pid}:${Math.floor(Date.now() / 1000)}`;
    const roNo = roHome(`${OTHER}\n`, { lockTok: live }); const roYes = roHome(`${OTHER}\n${line}\n`, { lockTok: live }); const roHas = roHome(`${OTHER}\n${line}\n`, { lockTok: live });
    const t0 = Date.now();
    const got = [shRo(scripts.거두기[0], roNo, shell).m, shRo(scripts.되돌림[0], roNo, shell).m, shRo(scripts.거두기[0], roYes, shell).m, shRo(scripts.넣기[0], roHas, shell).m];
    assert.deepEqual(got, [{ kind: 'removed', removed: 0, unmarked: 0 }, { kind: 'restored', removed: 0 }, { kind: 'fail', why: 'notwritable' }, M('present-marked', 0, 0, 1, 0)], `${shell} (${roNo.how})`);
    assert.ok(Date.now() - t0 < 5_000, `기다리지 않았다(${Date.now() - t0}ms — 진짜 sleep)`);
    void binNoSleep;
  }
});

test('㉓-c 법인 사용 중지 · 사전 검사(2회차 반증 R2R-5 · R2R-6) — 아는 법인 = vCenter ∪ 등록부 서버의 법인 ∪ 공통 계정 · 키 폴더의 법인(vCenter 를 지웠어도 서버가 남은 법인은 중지된다) · 중지 · 서버 키 고르기 · 받는 곳 버리기 · 승인 요청의 결정적 거절은 OTP 앞 · 이미 중지된 법인을 다시 중지하면 그 뒤 등록된 서버를 기록에 더한다(사건 없음 · added)', async () => {
  // ① vCenter 목록에 없지만 등록부 서버가 남은 법인 — 중지된다(예전: 404 unknown-corp)
  const sGone = mkServer('bm-vc-gone', null, { host: '10.9.23.1', password: 'x', vcenterId: 'vcGone' });
  const st1 = await SVC.stopCorp('vcGone', { by: 'own', reason: 'vCenter 는 지웠다' });
  assert.deepEqual([st1.ok, ST.stopFor('vcGone')?.serverIds], [true, [sGone.id]], JSON.stringify(st1));
  // ② 다시 중지 — 그 뒤 등록한 서버를 기록에 더한다(사건 없음)
  const evN = eventsOf('corp-stop').length;
  const sNew = mkServer('bm-vc-gone-new', null, { host: '10.9.23.2', password: 'x', vcenterId: 'vcGone' });
  const st2 = await SVC.stopCorp('vcGone', { by: 'own', reason: '다시' });
  assert.deepEqual([st2.ok, st2.already, st2.added, ST.stopFor('vcGone').serverIds.sort(), eventsOf('corp-stop').length], [true, true, 1, [sGone.id, sNew.id].sort(), evN], JSON.stringify(st2));
  assert.equal(st2.addFailed, false, '더하기에 성공했으면 addFailed 는 거짓(웹이 이 칸으로 판정 — 3회차 D3-2)');
  assert.match(st2.reason, /그 뒤 등록된 서버 1대를 중지 기록에 더함/);
  const st3 = await SVC.stopCorp('vcGone', { by: 'own', reason: '또' });
  assert.deepEqual([st3.added, ST.stopFor('vcGone').serverIds.length], [0, 2], '더할 것이 없으면 0');
  assert.ok(ST.clearCorpStop('vcGone', { by: 'fixture' }).ok);
  for (const x of [sGone, sNew]) assert.ok(BM.removeBmServer(x.id).ok);
  // ③ 키 폴더 · 공통 계정의 법인도 아는 법인(자식 프로세스 — vCenter 목록은 vcA 하나)
  const j = subRun({ owners: 'own', users: [{ username: 'own', role: 'admin', totpEnabled: true, totpSecret: generateSecret() }], code: `
    const VAULT = await imp('security/secretVault.js'); VAULT.saveSecretsPolicy({ mode: 'encrypted', level: 1 });
    const { store } = await imp('store.js'); store.snapshot = { ...store.get(), vcenters: [{ id: 'vcA', name: 'A' }] };
    const KS = await imp('bmusage/onboard/keyStore.js'); const SVC = await imp('sshaccess/service.js');
    KS.addKey({ name: 'kf', privateKey: F.ed25519Key().pem, folderCorp: 'vcKey', features: ['bm-usage'] }, { by: 'x' });
    KS.saveAccount({ name: 'acc', kind: 'os', corp: 'vcAcc', username: 'svc', password: 'x' }, { by: 'x' });
    const pick = (r) => (r ? [r.ok, r.code || ''] : null);
    console.log(JSON.stringify({ key: pick(await SVC.stopCorp('vcKey', { by: 'own' })), acc: pick(await SVC.stopCorp('vcAcc', { by: 'own' })), nope: pick(await SVC.stopCorp('vcNope', { by: 'own' })), pre: pick(await SVC.prechecks.stop({ corp: 'vcNope' })), preOk: await SVC.prechecks.stop({ corp: 'vcKey' }) }));` });
  assert.deepEqual([j.key, j.acc, j.nope, j.pre, j.preOk], [[true, ''], [true, ''], [false, 'unknown-corp'], [false, 'unknown-corp'], null], JSON.stringify(j));
  // ④ 라우트 — OTP 를 쓰기 전에 거절(같은 코드로 네 번 · 끝에 그 코드가 아직 쓰이지 않았는지 본다)
  const code = await otp('own6');
  const S = await fakeSshd(); const sv = mkServer('bm-23c-busy', S, { password: 'x' });
  let rel; let entered; const inLock = new Promise((r) => { entered = r; });
  const held = KL.withServerLock(KL.serverLockKey(rawOf(sv.id)), () => new Promise((r) => { entered(); rel = r; }));
  await inLock;
  const mine = [];
  try {
    for (let i = 0; i < AP.MAX_PENDING_PER_USER; i += 1) { const q = AP.createRequest({ kind: 'ssh-key-delete', title: 't', target: `k_23c_${i}`, payload: { keyId: `k_23c_${i}` }, by: 'own6' }); assert.ok(q.ok, JSON.stringify(q)); mine.push(q.request); }
    const res = [];
    for (const [m, p, body, want] of [
      ['POST', '/settings/ssh-access/corps/vcNOPE23/stop', { reason: 'x', otp: code }, [404, 'unknown-corp']],
      ['POST', `/settings/ssh-access/servers/${sv.id}/key`, { keyId: '', otp: code }, [409, 'server-busy']],
      ['POST', '/settings/ssh-access/inbox/discard', { relPath: '../etc/passwd', sha: 'x', otp: code }, [400, 'bad-path']],
      ['PUT', '/settings/ssh-access/guards', { twoPerson: false, otp: code }, [409, 'too-many']]]) {
      const r = await call('own6', m, p, body); res.push([r.s, r.j.code]);
      assert.deepEqual([r.s, r.j.code], want, `${m} ${p} ${r.txt}`);
    }
    assert.equal(AUTH.verifyUserOtp('own6', code).ok, true, '네 거절 모두 OTP 를 쓰지 않았다');
  } finally {
    rel(); await held;
    for (const q of mine) AP.decide(q.id, { by: 'own6', approve: false });
  }
  assert.equal(SVC.prechecks.chooseKey({ serverId: sv.id }), null, '자물쇠가 풀리면 통과');
  // 받는 곳 경로 사전 검사는 글자 꼴만 본다(파일 시스템을 만지지 않는다 — 받는 곳이 멈추면 동기 lstat 이 이벤트 루프를 멈췄다) — 없는 폴더의 꼴 맞는 경로도 통과(판정은 본 함수)
  assert.equal(SVC.prechecks.inboxPath({ relPath: 'no-such-corp-23c/common/x.pub' }), null);
});

test('㉓-d 응답 · 기록(2회차 반증 R2R-8 · R2R-10 · 그 밖) — setGuards · 승인 실행 결과에 seenAd 없음 · 기록 상한에 밀린 새 사건은 메일의 ‘외 N건’ · 제목 건수에 센다 · 다시 쓰는 사건은 처음 시각(미래 시각은 받지 않음) · 다시 읽기 승인 사전 검사는 파일을 못 읽으면 503 read-failed(‘또 바뀜’ 이 아님)', async () => {
  // seenAd — 상태에는 있고 응답에는 없다
  assert.ok(ST.noteSeenAd('ad.someone').ok);
  const sg = ST.setGuards({ serverRestrict: true }, { by: 'fixture' });
  assert.deepEqual([sg.ok, 'seenAd' in sg.guards, ST.getGuards().seenAd.includes('ad.someone')], [true, false, true], JSON.stringify(sg));
  const rq = await SVC.changeGuards({ serverRestrict: false }, { by: 'own' });
  assert.equal(rq.pending, true, JSON.stringify(rq));
  const ap = await SVC.decideApproval(rq.request.id, { approve: true, by: 'own2', digest: rq.request.digest });
  assert.equal(ap.ok, true, JSON.stringify(ap));
  assert.doesNotMatch(JSON.stringify(ap), /seenAd|ad\.someone/, '승인 실행 결과(요청 기록의 result 포함)에도 싣지 않는다');
  assert.ok(ST.setGuards({ serverRestrict: true }, { by: 'fixture' }).ok);
  // 사건 시각 — 지난 시각은 그대로 · 미래는 지금
  const past = Date.now() - 600_000;
  assert.ok(ST.addEvents([{ kind: 'key-job-done', target: 'at-past-23d', at: past }, { kind: 'key-job-done', target: 'at-future-23d', at: Date.now() + 3_600_000 }]).ok);
  const ev = Object.fromEntries(eventsOf('key-job-done').filter((e) => e.target.startsWith('at-')).map((e) => [e.target, e.at]));
  assert.ok(ev['at-past-23d'] === past && ev['at-future-23d'] <= Date.now(), JSON.stringify(ev));
  // 다시 읽기 요청 뒤 파일을 못 읽는다(자리에 폴더) → 503 read-failed · 요청은 대기 그대로
  const rl = await SVC.reloadKeyStore({ by: 'own' });
  assert.equal(rl.pending, true, JSON.stringify(rl));
  const file = path.join(DIR, 'ssh-keys.json'); const aside = `${file}.aside-23d`;
  fs.renameSync(file, aside); fs.mkdirSync(file);
  try {
    assert.deepEqual((({ code, status }) => [code, status])(SVC.approvalPrecheck(rl.request.id, { approve: true, by: 'own2', digest: rl.request.digest }) || {}), ['read-failed', 503]);
    assert.equal(AP.getRequest(rl.request.id).status, 'pending');
  } finally { fs.rmdirSync(file); fs.renameSync(aside, file); }
  assert.equal((await SVC.decideApproval(rl.request.id, { approve: false, by: 'own' })).request.status, 'cancelled');
  // 기록 상한에 밀린 사건 수(자식 프로세스) — 한 번에 400건 → 기록 300 · 밀린 100 + 대기열 상한(240)에서 버린 60 = 메일 ‘사건 400건 · 외 340건’
  const q = subRun({ owners: 'solo', users: [{ username: 'solo', role: 'admin', totpEnabled: true, totpSecret: generateSecret() }], code: `
    const ST = await imp('sshaccess/state.js'); const N = await imp('sshaccess/notify.js');
    const mails = []; N._setKeyNotifySendForTest(async (m) => { mails.push(m); return { ok: true }; }); N.startKeyNotify();
    const warns = []; const ow = console.warn; console.warn = (...a) => warns.push(a.join(' '));
    ST.addEvents(Array.from({ length: 400 }, (_, n) => ({ kind: 'corp-stop', corp: 'L' + n })));
    console.warn = ow;
    await N._flushKeyNotifyForTest();
    console.log(JSON.stringify({ n: ST.listEvents({ limit: 300 }).length, mails: mails.map((m) => ({ subject: m.subject, more: (/외 (\\d+)건/.exec(m.text) || [])[1] || '' })), warns }));` });
  assert.deepEqual([q.n, q.mails.map((m) => [(/사건 (\d+)건/.exec(m.subject) || [])[1], m.more])], [300, [['400', '340']]], JSON.stringify(q));
  assert.ok(q.warns.some((w) => /사건 100건이 기록 상한\(300\)에 밀려 남지 않았습니다/.test(w)), JSON.stringify(q.warns));
});

test('㉓-e 서버에서 키 읽기 · 대화형 칸 고르기(2회차 반증 R2R-9 · R2R-11) — 홈 · ~/.ssh 를 따라갈 수 없으면 ‘##AK unreachable’ → unreadable(‘파일 없음’ 이 아니다) · 가리는 칸 가운데 비밀번호 글 칸을 먼저(가리는 OTP 칸에는 넣지 않는다) · 없으면 OTP 류가 아닌 가리는 칸 · 그것도 없으면 no-password-method', async () => {
  const roX = roHome(null, { sshMode: RUN_AS_ROOT ? 0o700 : 0o600 });
  const out = shRo(AK.READ_COMMAND, roX, 'bash').out;
  assert.match(out, /^##AK unreachable\n?$/, `${roX.how}: ${out}`);
  const p = AK.parseReadOutput(out);
  assert.deepEqual([p.ok, p.code], [false, 'unreadable']);
  assert.match(p.reason, /홈 또는 ~\/\.ssh 폴더를 이 계정으로 열 수 없습니다\(권한\) — authorized_keys 가 있는지 알 수 없습니다/);
  const h0 = mkHome(); fs.mkdirSync(path.join(h0, '.ssh'));
  assert.equal(spawnSync('bash', ['-c', AK.READ_COMMAND], { env: { HOME: h0, PATH: process.env.PATH }, encoding: 'utf8' }).stdout, '##AK missing\n', '따라갈 수 있고 파일이 없으면 missing(대조)');
  // 칸 고르기 — 글 판정(정규식 export)
  const SX = await import('../src/proxy/sshExec.js');
  assert.ok(['Password: ', 'Passwort:', 'mot de passe :', '비밀번호:', 'パスワード:'].every((x) => SX.PW_PROMPT_RE.test(x)));
  assert.ok(['Verification code: ', 'Duo passcode: ', 'Enter PIN:', 'One-time password token:', '인증 코드:'].every((x) => SX.OTP_PROMPT_RE.test(x)));
  assert.equal(SX.PW_PROMPT_RE.test('Duo passcode:'), false, "'passcode' 는 비밀번호 글이 아니다");
  const { withSsh } = SX;
  const PW = secret('Kbd-Pick-Pw-23e');
  const trial = async (prompts2) => {
    const seen = [];
    const srv = new ssh2.Server({ hostKeys: [HOSTKEY] }, (client) => {
      client.on('authentication', (ctx) => {
        if (ctx.method !== 'keyboard-interactive') return ctx.reject(['keyboard-interactive']);
        const ask = (i) => ctx.prompt(prompts2[i], (a) => { (a || []).forEach((v, k) => seen.push(`${i}.${k}:${v === PW ? 'PW' : JSON.stringify(v)}`)); if (i + 1 < prompts2.length) ask(i + 1); else ctx.reject(['keyboard-interactive']); });
        return ask(0);
      });
      client.on('error', () => {});
    });
    await new Promise((r) => { srv.listen(0, '127.0.0.1', r); });
    let code = '';
    try { await withSsh({ host: '127.0.0.1', port: srv.address().port, username: 'mon', password: PW, readyTimeout: 6000, passwordOnly: true }, async () => ({})); } catch (e) { code = e?.code || ''; }
    srv.close();
    return { seen, code };
  };
  // n) 한 질의 [가리는 Verification, 가리는 Password] → Password 칸에만(예전: 처음 가리는 칸 = OTP 칸)
  assert.deepEqual(await trial([[{ prompt: 'Verification code: ', echo: false }, { prompt: 'Password: ', echo: false }]]), { seen: ['0.0:""', '0.1:PW'], code: '' });
  // o) 첫 질의 가리는 Verification(빈 답) → 둘째 질의 Password → 거기에(보냈으니 거부는 거부)
  assert.deepEqual(await trial([[{ prompt: 'Verification code: ', echo: false }], [{ prompt: 'Password: ', echo: false }]]), { seen: ['0.0:""', '1.0:PW'], code: '' });
  //    가리는 칸이 여럿이면 비밀번호 글 칸이 먼저(그 앞의 다른 가리는 칸이 OTP 류가 아니어도)
  assert.deepEqual(await trial([[{ prompt: 'Account name: ', echo: false }, { prompt: 'Password: ', echo: false }]]), { seen: ['0.0:""', '0.1:PW'], code: '' });
  //    글이 없는 가리는 칸 하나(옛 sshd) → 거기에 · 가리는 OTP 칸만 → 보내지 않음(no-password-method)
  assert.deepEqual(await trial([[{ prompt: '', echo: false }]]), { seen: ['0.0:PW'], code: '' });
  assert.deepEqual(await trial([[{ prompt: 'Duo passcode: ', echo: false }]]), { seen: ['0.0:""'], code: 'SSH_NO_PASSWORD_METHOD' });
});

/* ── 3회차 축 E(4c5695ac) 회귀 ──────────────────────────────────────────── */
test('㉔ 3회차 축 E — 홈 · ~/.ssh 를 따라갈 수 없으면 바꾸는 스크립트는 fail noaccess(‘없음’ 이 아니다 · 줄 그대로) · 키 로그인 대상이 상한을 넘으면 OTP 앞 400 too-many · 화면에 상한 값(limits) · vCenter 목록 밖 법인도 화면 법인 목록에(missing)', async () => {
  // ① noaccess(실제 bash · dash) — root 면 setpriv uid 65534 + root 소유 0700 ~/.ssh, 비 root 면 ~/.ssh 0600(x 없음)
  const line = KL.buildKeyLine({ publicKey: BPUB, keyId: BID });
  const body = `${OTHER}\n${line}\n`;
  assert.match(KL.failText('noaccess'), /홈 또는 ~\/\.ssh 폴더를 이 계정으로 열 수 없어\(권한\) authorized_keys 가 있는지 알 수 없습니다/);
  for (const shell of SHELLS) {
    for (const [name, sc] of [['거두기', AKS.removeScript({ publicKey: BPUB, keyId: BID })], ['되돌림', AKS.rollbackScript({ line })], ['넣기', AKS.installScript({ publicKey: BPUB, keyId: BID, line })]]) {
      const ro = roHome(body, { sshMode: RUN_AS_ROOT ? 0o700 : 0o600 });
      const r = shRo(sc, ro, shell);
      assert.deepEqual([r.m, r.code], [{ kind: 'fail', why: 'noaccess' }, 3], `${shell} ${name} (${ro.how}): ${r.out}${r.err}`);
      if (!RUN_AS_ROOT) fs.chmodSync(path.join(ro.h, '.ssh'), 0o700);
      assert.equal(fs.readFileSync(path.join(ro.h, '.ssh', 'authorized_keys'), 'utf8'), body, '줄 그대로(예전: 거두기가 ‘파일 없음’ 으로 끝났다)');
      if (!RUN_AS_ROOT) fs.chmodSync(path.join(ro.h, '.ssh'), 0o600);
    }
  }
  // ② 화면 — 상한 값 · vCenter 목록 밖 법인
  const sGhost = mkServer('bm-ghost-corp-24', null, { host: '10.9.24.1', password: 'x', vcenterId: 'vcGhost24' });
  try {
    const v = await SVC.buildView();
    assert.deepEqual(v.limits, { keyLoginServers: KL.MAX_JOB_SERVERS, revokeServers: KL.MAX_REVOKE_SERVERS });
    const g = v.corps.find((c) => c.id === 'vcGhost24');
    assert.deepEqual(g && { id: g.id, name: g.name, dc: g.dc, missing: g.missing }, { id: 'vcGhost24', name: 'vcGhost24 (vCenter 목록에 없음)', dc: '', missing: true }, JSON.stringify(g));
    assert.equal(v.corps.find((c) => c.id === 'vcA')?.missing, undefined, 'vCenter 목록의 법인에는 missing 이 없다');
  } finally { assert.ok(BM.removeBmServer(sGhost.id).ok); }
  // ③ 키 로그인 대상 상한(자식 프로세스 — 서버 101대) — OTP 앞 사전 검사가 400 too-many(예전: OTP 를 쓴 뒤 시작 함수가 거절)
  const j = subRun({ owners: 'own', users: [{ username: 'own', role: 'admin', totpEnabled: true, totpSecret: generateSecret() }], code: `
    const VAULT = await imp('security/secretVault.js'); VAULT.saveSecretsPolicy({ mode: 'encrypted', level: 1 });
    const { store } = await imp('store.js'); store.snapshot = { ...store.get(), vcenters: [{ id: 'vcA', name: 'A' }] };
    const KS = await imp('bmusage/onboard/keyStore.js'); const BM = await imp('bmstor/registry.js'); const SVC = await imp('sshaccess/service.js'); const KL = await imp('sshaccess/keyLogin.js');
    const k = KS.addKey({ name: 'lim-key', privateKey: F.ed25519Key().pem, folderCorp: 'vcA', features: ['bm-usage'] }, { by: 'x' });
    const list = [];
    for (let i = 0; i < KL.MAX_JOB_SERVERS + 1; i += 1) { const r = BM.saveBmServer({ name: 'lim' + i, host: '10.77.' + Math.floor(i / 200) + '.' + (i % 200 + 1), port: 22, username: 'mon', mounts: ['/'], vcenterId: 'vcA', password: 'x' }); list.push({ id: r.server.id, addr: SVC.serverKeyCandidates(r.server.id).server.addr }); }
    const over = await SVC.keyJobPrecheck('key-login', k.key.id, { servers: list });
    const at = await SVC.keyJobPrecheck('key-login', k.key.id, { servers: list.slice(0, KL.MAX_JOB_SERVERS) });
    console.log(JSON.stringify({ max: KL.MAX_JOB_SERVERS, over: over && [over.code, over.status, over.reason], at }));` });
  assert.deepEqual([j.over?.slice(0, 2), j.at], [['too-many', 400], null], JSON.stringify(j));
  assert.match(j.over[2], new RegExp(`한 번에 ${j.max}대까지입니다`));
});

/* ── 3회차 축 A · B · C · D(d488ff93) 회귀 ──────────────────────────────── */
test('㉕-a 인증 · 승인 · 재개(3회차 A) — 인증을 끈 설치는 보호 장치 끄기 · 승인 사전 검사 · 승인을 409 auth-disabled(켜기는 받는다 · 끄기가 섞이면 켜기도 하지 않음) · 승인 사전 검사가 넣는 중인 옛 키 · 활성이 아닌 새 키를 거절(요청은 그대로) · 모르는 빈 중지의 재개 사전 검사는 통과(async)', async () => {
  const j = subRun({ owners: 'own,own2', users: [{ username: 'own', role: 'admin', totpEnabled: true, totpSecret: generateSecret() }, { username: 'own2', role: 'admin', totpEnabled: true, totpSecret: generateSecret() }], env: { AUTH_ENABLED: 'false' }, code: `
    const SVC = await imp('sshaccess/service.js'); const ST = await imp('sshaccess/state.js'); const AP = await imp('approval/store.js');
    const pick = (r) => (r ? [r.ok, r.code || '', r.status || 0] : null);
    ST.setGuards({ serverRestrict: false }, { by: 'x' });
    const pre = pick(SVC.prechecks.guards({ patch: { twoPerson: false }, by: 'own' }));
    const mixed = pick(await SVC.changeGuards({ twoPerson: false, serverRestrict: true }, { by: 'own' }));
    const afterMixed = ST.getGuards();
    const on = pick(await SVC.changeGuards({ serverRestrict: true }, { by: 'own' }));
    const q = AP.createRequest({ kind: 'ssh-key-delete', title: 't', target: 'k_a', payload: { keyId: 'k_a' }, by: 'own' });
    const ap = pick(SVC.approvalPrecheck(q.request.id, { approve: true, by: 'own2', digest: q.request.digest }));
    const dec = pick(await SVC.decideApproval(q.request.id, { approve: true, by: 'own2', digest: q.request.digest }));
    console.log(JSON.stringify({ pre, mixed, afterMixed: [afterMixed.twoPerson, afterMixed.serverRestrict], on, sr: ST.getGuards().serverRestrict, ap, dec, status: AP.getRequest(q.request.id).status }));` });
  assert.deepEqual([j.pre, j.mixed, j.afterMixed, j.on, j.sr, j.ap, j.dec, j.status],
    [[false, 'auth-disabled', 409], [false, 'auth-disabled', 409], [true, false], [true, '', 0], true, [false, 'auth-disabled', 409], [false, 'auth-disabled', 409], 'pending'], JSON.stringify(j));
  // 승인 사전 검사 — 교체 · 삭제 요청의 옛 키를 넣는 중이면 409 · 새 키가 퇴역이면 key-retired(요청은 대기 그대로 — 실행 단계에서 실패해 요청까지 버리던 것)
  const kFrom = mkKey('ap-from-25a'); const kTo = mkKey('ap-to-25a');
  const rq = await SVC.rotateKeyReq({ from: kFrom.id, to: kTo.id, by: 'own' }); const dq = await SVC.deleteKeyReq({ keyId: kFrom.id, by: 'own' });
  assert.deepEqual([rq.pending, dq.pending], [true, true], JSON.stringify([rq, dq]));
  const S = await fakeSshd(); const pw = secret('Pw-Approve-Installing-25a'); S.st.password = pw;
  const sv = mkServer('bm-25a', S, { password: pw });
  const h = holdInstall(S, kFrom);
  const st = await SVC.startKeyLogin({ servers: [sv], keyId: kFrom.id, by: 'own' });
  await h.reached;
  const code = (r) => (r ? [r.code, r.status] : null);
  try {
    assert.deepEqual([code(SVC.approvalPrecheck(rq.request.id, { approve: true, by: 'own2', digest: rq.request.digest })), code(SVC.approvalPrecheck(dq.request.id, { approve: true, by: 'own2', digest: dq.request.digest }))], [['key-installing', 409], ['key-installing', 409]]);
    assert.deepEqual([AP.getRequest(rq.request.id).status, AP.getRequest(dq.request.id).status], ['pending', 'pending']);
  } finally { h.release(); }
  await waitJob(st.jobId);
  assert.ok(KS.markKeyRetired(kTo.id).ok);
  assert.deepEqual(code(SVC.approvalPrecheck(rq.request.id, { approve: true, by: 'own2', digest: rq.request.digest })), ['key-retired', 409]);
  for (const r of [rq, dq]) assert.equal((await SVC.decideApproval(r.request.id, { approve: false, by: 'own' })).request.status, 'cancelled');
  // 재개 사전 검사(async) — 모르는 법인 · 적힌 서버 없음이면 승인 없이 풀리므로 요청 중복 등을 보지 않고 통과
  assert.ok(ST.setCorpStop('ghost25a', { by: 'fixture', reason: 'x' }).ok);
  const dup = AP.createRequest({ kind: 'ssh-corp-resume', title: 't', target: 'ghost25a', corp: 'ghost25a', payload: { corp: 'ghost25a', stopAt: ST.stopFor('ghost25a').at }, by: 'own' });
  assert.ok(dup.ok, JSON.stringify(dup));
  const pr = SVC.prechecks.resume({ corp: 'ghost25a', by: 'own' });
  assert.ok(pr instanceof Promise, 'async');
  assert.equal(await pr, null, '중복 요청이 있어도(예전: dup-request) 승인 없이 풀 수 있는 중지라 통과');
  assert.deepEqual([(await SVC.resumeCorp('ghost25a', { by: 'own' })).ok, ST.stopFor('ghost25a')], [true, null]);
  AP.decide(dup.request.id, { by: 'own', approve: false });
  assert.deepEqual(code(await SVC.prechecks.resume({ corp: 'vcB', by: 'own' })), ['not-stopped', 409], '대조 — 아는 법인은 예전 판정');
});

test('㉕-b 원격 스크립트 · 칸 고르기 · 옛 id 포탈 줄(3회차 B) — 주인 표 시각이 숫자가 아니거나 너무 크면(0 · 0 앞자리 · 13자 이상) 셸이 죽지 않고 처음 본 때부터 5초 뒤 치운다 · 칸 1순위 = 비밀번호 글 ∧ OTP 글 아님(‘One-time password’ · ‘Token password’ 만이면 보내지 않음) · 같은 공개키를 다른 키 id 로 넣은 포탈 줄은 사람 줄이 아니라 otherId(restricted 아님 · 안내)', async () => {
  const line = KL.buildKeyLine({ publicKey: BPUB, keyId: BID });
  const add = AKS.installScript({ publicKey: BPUB, keyId: BID, line });
  const binLock = fakeBin('lockhooks');
  for (const shell of SHELLS) {
    for (const ot of ['0', '0123456789', '9'.repeat(20)]) {
      const h = mkHome(); fs.mkdirSync(path.join(h, '.ssh'), { mode: 0o700 }); fs.writeFileSync(path.join(h, '.ssh', 'authorized_keys'), `${OTHER}\n`, { mode: 0o600 });
      const lk = path.join(h, '.ssh', '.authorized_keys.portal.lock'); fs.mkdirSync(lk); fs.writeFileSync(path.join(lk, 'owner'), `other-host.example/x/y:1:${ot}\n`);
      fs.writeFileSync(path.join(h, 'clock-half'), '1000');
      const r = sh(add, h, shell, { PATH: binLock });
      assert.deepEqual([r.m, r.code], [M('added'), 0], `${shell} ot=${ot.slice(0, 12)}: ${r.out}${r.err}`);
      assert.ok(Number(fs.readFileSync(path.join(h, 'sleeps'), 'utf8')) >= 4, `${shell} ot=${ot.slice(0, 12)} — 바로 치우지 않고 처음 본 때부터 5초 기다렸다`);
      assert.doesNotMatch(r.err, /arithmetic|value too great|out of range|syntax error/i, '셸 산술 오류 없음');
    }
    // 같은 공개키 · 다른 키 id 의 포탈 줄(지웠다 다시 등록한 키의 옛 줄) — 사람 줄(unmarked)로 세지 않고 otherId · 줄을 더하지 않음
    const h2 = mkHome(); fs.mkdirSync(path.join(h2, '.ssh'), { mode: 0o700 }); fs.writeFileSync(path.join(h2, '.ssh', 'authorized_keys'), `${OTHER}\n${BPUB} portal-ssh:k_00000000old1\n`, { mode: 0o600 });
    assert.deepEqual(sh(add, h2, shell).m, M('present-unmarked', 0, 0, 0, 0, 1), shell);
  }
  // 칸 고르기
  const { withSsh } = await import('../src/proxy/sshExec.js');
  const PW = secret('Kbd-Pick-Pw-25b');
  const trial = async (prompts) => {
    const seen = [];
    const srv = new ssh2.Server({ hostKeys: [HOSTKEY] }, (client) => {
      client.on('authentication', (ctx) => {
        if (ctx.method !== 'keyboard-interactive') return ctx.reject(['keyboard-interactive']);
        return ctx.prompt(prompts, (a) => { (a || []).forEach((v, k) => seen.push(`${k}:${v === PW ? 'PW' : JSON.stringify(v)}`)); ctx.reject(['keyboard-interactive']); });
      });
      client.on('error', () => {});
    });
    await new Promise((r) => { srv.listen(0, '127.0.0.1', r); });
    let code = '';
    try { await withSsh({ host: '127.0.0.1', port: srv.address().port, username: 'mon', password: PW, readyTimeout: 6000, passwordOnly: true }, async () => ({})); } catch (e) { code = e?.code || ''; }
    srv.close();
    return { seen, code };
  };
  assert.deepEqual(await trial([{ prompt: 'One-time password: ', echo: false }]), { seen: ['0:""'], code: 'SSH_NO_PASSWORD_METHOD' }, "‘password’ 글이어도 OTP 글이면 비밀번호 칸이 아니다");
  assert.deepEqual(await trial([{ prompt: 'Token password: ', echo: false }]), { seen: ['0:""'], code: 'SSH_NO_PASSWORD_METHOD' });
  assert.deepEqual(await trial([{ prompt: 'One-time password: ', echo: false }, { prompt: 'Password: ', echo: false }]), { seen: ['0:""', '1:PW'], code: '' });
  // 키 로그인(가짜 sshd) — 옛 id 포탈 줄이 있으면 줄을 더하지 않고 otherId · 안내 · restricted 아님
  const S = await fakeSshd(); const pw = secret('Pw-OtherId-25b'); S.st.password = pw;
  const K = mkKey('kl-otherid');
  S.writeAk(`${OTHER}\n${K.pub} portal-ssh:k_00000000old2\n`);
  const sv = mkServer('bm-otherid', S, { password: pw });
  const r = (await runLogin({ servers: [sv], keyId: K.id, by: 'own' })).job.results[0];
  assert.deepEqual([r.line, r.unmarked, r.otherId, r.restricted], ['present-unmarked', 0, 1, false], JSON.stringify(r));
  assert.match(r.note, /같은 공개키를 다른 키 id 로 포탈이 넣은 줄 1개가 서버에 있습니다/);
  //   원하는 줄(제한 붙음)이 이미 있어도 다른 id 포탈 줄(제한 없음)이 함께 있으면 ‘제한됨’ 이라 하지 않는다(그 줄로도 들어올 수 있다 — restricted 의 !m.otherId)
  const S2 = await fakeSshd(); S2.st.password = pw;
  const Lx = KL.buildKeyLine({ publicKey: K.pub, keyId: K.id, restrict: true, fromIp: '127.0.0.1' });
  S2.writeAk(`${OTHER}\n${Lx}\n${K.pub} portal-ssh:k_00000000old3\n`);
  const sv2 = mkServer('bm-otherid-exact', S2, { password: pw });
  const r2 = (await runLogin({ servers: [sv2], keyId: K.id, by: 'own' })).job.results[0];
  assert.deepEqual([r2.ok, r2.line, r2.otherId, r2.restricted], [true, 'present-marked', 1, false], JSON.stringify(r2));
  assert.equal(S2.readAk(), `${OTHER}\n${Lx}\n${K.pub} portal-ssh:k_00000000old3\n`, '줄은 바꾸지 않았다');
});

test('㉕-c 자격 다시 풀기 · 사건 · 기록(3회차 C) — 키 확인 직전에 자격을 다시 풀어 그 사이 건 법인 중지면 그 키로 접속하지 않고 더한 줄을 되돌린다 · 듣는 쪽이 붙기 전에 쓴 사건도 메일로 · 버린 사건 수(reportLostEvents)도 메일 수에 · 진행 기록을 못 읽으면 작업마다 경고 한 번 · 점검 항목 inflight-unreadable · 읽은 키 · 사용 기록은 읽기 오류면 원본을 덮지 않는다 · 승인 기록은 읽기 오류 뒤 파일이 없으면 다시 쓴다', async () => {
  // ① 넣은 뒤 · 확인 전에 법인 중지
  const S = await fakeSshd(); const pw = secret('Pw-Stop-Mid-25c'); S.st.password = pw;
  const K = mkKey('kl-stop-mid');
  const sv = mkServer('bm-stop-mid', S, { password: pw });
  S.writeAk(`${OTHER}\n`);
  const h = holdInstall(S, K);
  const st = await SVC.startKeyLogin({ servers: [sv], keyId: K.id, removePassword: true, by: 'own' });
  await h.reached;
  assert.ok((await SVC.stopCorp('vcA', { by: 'own', reason: '도중 중지' })).ok);
  try {
    h.release();
    const r = (await waitJob(st.jobId)).results[0];
    assert.deepEqual([r.ok, r.code, r.rolledBack, S.keyTries().filter((x) => x.signed).length, rawOf(sv.id).keyRef, rawOf(sv.id).password], [false, 'corp-stopped', true, 0, undefined, pw], JSON.stringify(r));
    assert.equal(S.readAk(), `${OTHER}\n`, '더한 줄을 되돌렸다');
  } finally { assert.ok(ST.clearCorpStop('vcA', { by: 'fixture' }).ok); }
  // ② 사건 — 듣는 쪽이 붙기 전에 쓴 사건 · 버린 사건 수
  const q = subRun({ owners: 'solo', users: [{ username: 'solo', role: 'admin', totpEnabled: true, totpSecret: generateSecret() }], code: `
    const ST = await imp('sshaccess/state.js'); const N = await imp('sshaccess/notify.js');
    ST.addEvent({ kind: 'corp-stop', corp: 'before-listener' });
    ST.reportLostEvents(Array.from({ length: 5 }, () => ({ kind: 'corp-stop' })));
    const mails = []; N._setKeyNotifySendForTest(async (m) => { mails.push(m); return { ok: true }; }); N.startKeyNotify();
    await new Promise((r) => setImmediate(r));
    await N._flushKeyNotifyForTest();
    N.startKeyNotify(); ST.reportLostEvents([{ kind: 'corp-stop' }, { kind: 'key-login-set' }]); ST.addEvent({ kind: 'corp-stop', corp: 'after' });
    await N._flushKeyNotifyForTest();
    console.log(JSON.stringify({ mails: mails.map((m) => ({ s: m.subject, more: (/외 (\\d+)건/.exec(m.text) || [])[1] || '', early: m.text.includes('before-listener') })) }));` });
  assert.deepEqual(q.mails.map((m) => [(/사건 (\d+)건/.exec(m.s) || [])[1] || '1', m.more, m.early]), [['6', '5', true], ['2', '1', false]], `붙기 전 사건 · 버린 수(메일 종류만) ${JSON.stringify(q.mails)}`);
  // ③ 진행 기록을 못 읽음 — 경고는 작업마다 한 번 · 점검 항목
  const INF = await import('../src/sshaccess/inflight.js');
  const file = path.join(DIR, INF.INFLIGHT_FILE_NAME);
  fs.rmSync(file, { force: true }); fs.mkdirSync(file); INF._resetInflightForTest();
  const warns = []; const ow = console.warn; console.warn = (...a) => { warns.push(a.join(' ')); };
  try {
    const Ss = [await fakeSshd(), await fakeSshd()]; for (const x of Ss) { x.st.password = pw; x.writeAk(`${K.pub} portal-ssh:${K.id}\n`); }
    const svs = Ss.map((x, i) => mkServer(`bm-inflight-warn${i}`, x, { password: pw }));
    const rv = (await runRevoke({ keyId: K.id, servers: svs, by: 'own' })).job;
    assert.deepEqual(rv.results.map((x) => x.code), ['removed', 'removed']);
    console.warn = ow;
    assert.equal(warns.filter((w) => /진행 기록/.test(w)).length, 1, `작업마다 한 번 ${JSON.stringify(warns)}`);
    assert.ok(INF.inflightReadIssue(), '읽기 문제를 알린다');
    assert.ok((await SVC.buildView()).check.items.some((i) => i.code === 'inflight-unreadable'), '키 점검 항목');
  } finally { console.warn = ow; fs.rmSync(file, { recursive: true, force: true }); INF._resetInflightForTest(); }
  assert.equal(INF.inflightReadIssue(), null);
  // ④ 읽은 키 기록 · 사용 기록 — 읽기 오류(자리에 폴더)면 덮지 않는다
  const insFile = path.join(DIR, INS.INSTALLED_FILE_NAME); const insAside = `${insFile}.aside-25c`;
  if (fs.existsSync(insFile)) fs.renameSync(insFile, insAside);
  fs.mkdirSync(insFile); INS._resetInstalledForTest();
  try {
    const w = INS.noteInstalled(sv.id, { host: 'h', port: 22, username: 'u', file: '~/.ssh/authorized_keys', keys: [] });
    assert.deepEqual([w.ok, w.code, w.status, fs.statSync(insFile).isDirectory()], [false, 'read-failed', 503, true], JSON.stringify(w));
  } finally { fs.rmdirSync(insFile); if (fs.existsSync(insAside)) fs.renameSync(insAside, insFile); INS._resetInstalledForTest(); }
  assert.equal(INS.noteInstalled(sv.id, { host: 'h', port: 22, username: 'u', file: '~/.ssh/authorized_keys', keys: [] }).ok, true, '다시 읽히면 쓴다');
  const u = subRun({ owners: 'solo', users: [{ username: 'solo', role: 'admin', totpEnabled: true, totpSecret: generateSecret() }], code: `
    const US = await imp('sshaccess/usage.js'); const f = path.join(process.env.CONFIG_DIR, US.USAGE_FILE_NAME);
    fs.mkdirSync(f);
    const FP = 'SHA256:' + 'A'.repeat(43);
    const rec = US.noteKeyUse({ fingerprint: FP, keyName: 'k', server: 's1', corp: 'vcA', feature: 'bm-usage', ok: true });
    const w1 = US.flushKeyUsage(); const stillDir = fs.statSync(f).isDirectory();
    fs.rmdirSync(f); fs.writeFileSync(f, JSON.stringify({ rows: [{ fingerprint: FP, keyName: 'k', server: 's1', corp: 'vcA', feature: 'bm-usage', count: 3, okCount: 3, failCount: 0, firstAt: 1000, lastAt: Date.now() - 1000, lastOk: true, lastCode: 'ok' }] }));
    const w2 = US.flushKeyUsage();
    const rows = JSON.parse(fs.readFileSync(f, 'utf8')).rows || [];
    console.log(JSON.stringify({ rec: rec.recorded, w1, stillDir, w2ok: !!w2?.ok, rows: rows.filter((r) => r.fingerprint === FP).map((r) => [r.okCount, r.firstAt]) }));` });
  assert.deepEqual([u.rec, u.w1?.ok, u.w1?.skipped, u.stillDir, u.w2ok], [true, false, true, true, true], JSON.stringify(u));
  assert.deepEqual(u.rows.map((x) => x[0]), [4], `다시 읽히면 합친다(파일 3 + 메모리 1) ${JSON.stringify(u.rows)}`);
  assert.equal(u.rows[0][1], 1000, 'firstAt 은 작은 쪽');
  // ⑤ 승인 기록 — 읽기 오류(자리에 폴더) 뒤 파일이 없으면 오류를 풀고 다시 쓴다
  const a = subRun({ owners: 'own', users: [{ username: 'own', role: 'admin', totpEnabled: true, totpSecret: generateSecret() }], code: `
    const AP = await imp('approval/store.js'); const f = path.join(process.env.CONFIG_DIR, AP.APPROVALS_FILE_NAME);
    fs.mkdirSync(f);
    const r1 = AP.createRequest({ kind: 'ssh-key-delete', title: 't', target: 'k1', payload: { keyId: 'k1' }, by: 'own' });
    const kept = fs.statSync(f).isDirectory();
    fs.rmdirSync(f);
    const r2 = AP.createRequest({ kind: 'ssh-key-delete', title: 't', target: 'k1', payload: { keyId: 'k1' }, by: 'own' });
    console.log(JSON.stringify({ r1: [r1.ok, r1.status], kept, r2: r2.ok }));` });
  assert.deepEqual([a.r1, a.kept, a.r2], [[false, 503], true, true], JSON.stringify(a));
});

test('㉕-d 그 밖(3회차 D · 공통) — 복원으로 id 가 바뀐 대기 키도 지문으로 활성화 · 공통 계정을 확인할 수 없으면 1회 비밀번호를 보내지 않는다(계정 이름 짐작 금지) · 거두는 중인 키로 서버를 묶지 않는다(키 고르기 · 교체 새 키 409 revoking)', async () => {
  const j = subRun({ owners: 'own', users: [{ username: 'own', role: 'admin', totpEnabled: true, totpSecret: generateSecret() }], code: `
    const VAULT = await imp('security/secretVault.js'); VAULT.saveSecretsPolicy({ mode: 'encrypted', level: 1 });
    const KS = await imp('bmusage/onboard/keyStore.js'); const f = path.join(process.env.CONFIG_DIR, 'ssh-keys.json');
    const r = KS.addKey({ name: 'restored-pending', privateKey: F.ed25519Key().pem, folderCorp: 'vcA', features: ['bm-usage'] }, { by: 'x', pending: true });
    const oldId = r.key.id; const fp = r.key.fingerprint;
    const d = JSON.parse(fs.readFileSync(f, 'utf8')); for (const k of d.keys) if (k.id === oldId) k.id = 'k_0000000025dd'; fs.writeFileSync(f, JSON.stringify(d)); KS._resetKeyStoreForTest();
    const a1 = KS.activateKey(oldId); const a2 = KS.activateKey(oldId, { fingerprint: fp });
    console.log(JSON.stringify({ a1: a1.ok, a2: a2.ok, st: KS.keyById('k_0000000025dd')?.status }));` });
  assert.deepEqual([j.a1, j.a2, j.st], [false, true, 'active'], `요청의 id 로 못 찾으면 지문이 같은 대기 키(하나)를 쓴다 ${JSON.stringify(j)}`);
  // 1회 비밀번호의 접속 계정 — 공통 계정을 확인할 수 없으면 보내지 않는다(예전: 서버 칸 · root 로 짐작)
  assert.deepEqual(KL.onceUsername({ host: '10.0.0.1', username: 'mon' }), { ok: true, username: 'mon' });
  assert.deepEqual(KL.onceUsername({ host: '10.0.0.1' }), { ok: true, username: 'root' });
  const bad = KL.onceUsername({ host: '10.0.0.1', username: 'mon', credRef: 'a_000000missing' });
  assert.equal(bad.ok, false, JSON.stringify(bad));
  assert.match(bad.reason, /접속 계정을 정할 수 없어 이번 한 번만 쓸 비밀번호를 보내지 않았습니다/);
  // 거두는 중인 키
  const S = await fakeSshd(); const pw = secret('Pw-Revoking-25d'); S.st.password = pw;
  const Kr = mkKey('kl-revoking'); const kx = mkKey('kl-revoking-from');
  S.writeAk(`${Kr.pub} portal-ssh:${Kr.id}\n`);
  const sv = mkServer('bm-revoking', S, { password: pw });
  const S2 = await fakeSshd(); const sv2 = mkServer('bm-revoking-choose', S2, { password: pw });
  const h = holdRevoke(S, Kr);
  const rv = await SVC.startKeyRevoke({ keyId: Kr.id, servers: [sv], by: 'own' });
  await h.reached;
  try {
    const code = (r) => (r ? [r.code, r.status] : null);
    assert.deepEqual(code(KL.revokingIssue(Kr.id)), ['revoking', 409]);
    assert.deepEqual([code(SVC.prechecks.chooseKey({ serverId: sv2.id, keyId: Kr.id })), code(await SVC.chooseServerKey({ serverId: sv2.id, keyId: Kr.id, expectAddr: sv2.addr, by: 'own' })),
      code(SVC.prechecks.rotate({ from: kx.id, to: Kr.id, by: 'own' })), code(await SVC.rotateKeyReq({ from: kx.id, to: Kr.id, by: 'own' }))], Array(4).fill(['revoking', 409]));
    assert.equal(rawOf(sv2.id).keyRef, undefined, '묶지 않았다');
    assert.equal(KL.revokingIssue(kx.id), null, '다른 키는 상관없다');
  } finally { h.release(); }
  await waitJob(rv.jobId);
  assert.equal(KL.revokingIssue(Kr.id), null, '끝나면 풀린다');
});
