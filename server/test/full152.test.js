/**
 * 전체 점검 152회차 1축(인증 · 권한 · 라우트 틀 · 원격 실행 · 자격증명) — 확정분 회귀.
 *  A1 서버 명령 실행 값 검사: 자동 마운트 자리(/net) 거절이 글자 앞머리만 봐서 `//net/…` · `/./net/…` · `/proc/self/root/net/…` 가 통과했다.
 *  A2 SSH exec 출력: 청크마다 `toString()` 이라 여러 바이트 글자(한글)가 청크 경계에 걸리면 깨졌다(U+FFFD) — 서버 명령 실행은 그 출력을 사람에게 그대로 보인다.
 *  A3 서버 명령 실행 끝 코드: 코어가 stderr 를 앞 2,000자만 남겨, stderr 가 길면 끝의 끝 코드 표지가 잘려 시한(124)에 끊긴 실행이 ‘실행됨 · 끝 코드 모름’ 이었다.
 *  A4 서버 명령 실행 · 서버 정보 라우트: `ids: [{"toString":1}]` 이 `String()` 에서 던져 500(값 오류 400 이 아니다).
 *  A5 RMA 실행기(엣지): 자식 프로세스 출력도 청크마다 `toString()` — du-top 2만 줄(1.2MB)에서 한글 폴더 이름 9줄이 깨져 폴더 사용량이 없는 이름을 기록했다.
 * 실제 등록부 · 가짜 sshd(청크를 나눠 쓴다) · 실제 라우터.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'full152-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'live';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
process.env.SSH_HOSTKEY_POLICY = 'observe';
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const VAULT = await import('../src/security/secretVault.js');
VAULT.saveSecretsPolicy({ mode: 'encrypted', level: 1 });
const ssh2 = (await import('ssh2')).default;
const P = await import('../src/servercmd/presets.js');
const SVC = await import('../src/servercmd/service.js');
const BM = await import('../src/bmstor/registry.js');
const { withSsh } = await import('../src/proxy/sshExec.js');
const { store } = await import('../src/store.js');
store.snapshot = { ...store.get(), vcenters: [{ id: 'vcA', name: 'KR-SEL' }] };

const KO = '가나다라마바사 한글 파일.txt';
const KO_BUF = Buffer.from(`${KO}\n`, 'utf8');

/* ── 가짜 sshd — 비밀번호 로그인 · st.plan(명령 → 쓰기 순서)대로 청크를 나눠 쓴다 ── */
async function fakeSshd() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const st = { cmds: [], mode: 'plain', rc: 0, errPad: 0 };
  const srv = new ssh2.Server({ hostKeys: [privateKey] }, (client) => {
    client.on('authentication', (ctx) => (ctx.method === 'password' && ctx.password === 'Own-1' ? ctx.accept() : ctx.reject(['password'])));
    client.on('ready', () => client.on('session', (accept) => {
      const s = accept();
      s.on('exec', async (acc, _rej, info) => {
        st.cmds.push(info.command); const stream = acc();
        const n = (info.command.match(/#DVC-RC=/g) || []).length;
        const marks = Array.from({ length: n }, () => `\n#DVC-RC=${st.rc}\n`).join('');
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        if (st.mode === 'split') {
          // 한글 한 글자(3바이트)의 가운데에서 끊어 두 번에 쓴다 — stdout · stderr 둘 다
          stream.write(KO_BUF.subarray(0, 4)); stream.stderr.write(KO_BUF.subarray(0, 5));
          await wait(60);
          stream.write(KO_BUF.subarray(4)); stream.stderr.write(Buffer.concat([KO_BUF.subarray(5), Buffer.from(marks)]));
        } else {
          stream.write('ok\n');
          stream.stderr.write(`${'ls: cannot access entry: Stale file handle\n'.repeat(st.errPad)}${marks}`);
        }
        await wait(20);
        stream.exit(0); stream.end();
      });
    }));
    client.on('error', () => {});
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, st, close: () => srv.close() };
}
const SSHD = await fakeSshd();
test.after(() => SSHD.close());
const mkServer = (body) => { const r = BM.saveBmServer({ host: '127.0.0.1', port: SSHD.port, mounts: ['/'], ...body }); assert.equal(r.ok, true, r.reason); return BM.listBmServersRaw().find((x) => x.id === r.server.id); };
const OWN = mkServer({ name: 'own152', vcenterId: 'vcA', os: 'linux', password: 'Own-1' });

test('A1 값 검사 — 자동 마운트 자리(/net)는 달리 써도 거절(빈 조각 · . 조각 · /proc 의 root · cwd 링크) · 보통 경로는 그대로', () => {
  for (const v of ['/net', '/net/', '/net/10.0.0.5', '//net/10.0.0.5', '///net', '/./net/10.0.0.5', '/.//./net/host/export', '//./net',
    '/proc/self/root/net/10.0.0.5', '/proc/1/root', '/proc/thread-self/root/net/x', '/proc/self/task/1/root/net/x', '/proc/self/cwd/net/x', '//proc/./self/root/net/x']) {
    for (const preset of ['ls', 'du-top']) {
      const c = P.checkRequest(preset, { path: v });
      assert.equal(c.ok, false, `${preset} ${v}`); assert.equal(c.code, 'bad-param');
    }
    assert.equal(P.previewOf('ls', { path: v }).linux, undefined, `미리 보기에도 명령이 없다 ${v}`);
  }
  // 사유는 그 자리를 말한다(글자 종류 사유가 아니다)
  assert.match(P.checkParam('path', '//net/10.0.0.5').reason, /자동 마운트/);
  assert.match(P.checkParam('path', '/proc/self/root/net/x').reason, /root · cwd/);
  // 보통 경로 · 비슷한 이름은 그대로 통과(값은 넣은 글자 그대로 — 다듬지 않는다)
  for (const v of ['/', '/network', '/var/net', '/var//log', '/var/./log', '/netapp', '/proc', '/proc/1', '/proc/self/status', '/proc/sys/net', '/home/root', '/srv/cwd', '/rootfs/proc/root']) {
    const c = P.checkRequest('ls', { path: v });
    assert.equal(c.ok, true, v); assert.equal(c.params.path, v);
  }
  // 실행 경로도 접속 전에 막는다
  const n0 = SSHD.st.cmds.length;
  const r = SVC.startRun({ preset: 'ls', params: { path: '//net/10.0.0.5' }, ids: [OWN.id] }, { by: 'own' });
  assert.equal(r.ok, false); assert.equal(r.status, 400); assert.equal(SSHD.st.cmds.length, n0);
});

test('A2 SSH exec — 여러 바이트 글자가 청크 경계에 걸려도 깨지지 않는다(stdout · stderr) · 서버 명령 실행 출력도', async () => {
  SSHD.st.mode = 'split'; SSHD.st.rc = 0;
  const r = await withSsh({ host: '127.0.0.1', port: SSHD.port, username: 'root', password: 'Own-1', readyTimeout: 10_000 }, async ({ exec }) => ({ out: await exec('echo', 5_000) }));
  assert.equal(r.out.stdout, `${KO}\n`, JSON.stringify(r.out.stdout));
  assert.equal(r.out.stderr, `${KO}\n`, JSON.stringify(r.out.stderr));
  assert.equal(r.out.stdout.includes('�'), false);
  // partial(받은 만큼) 경로도 같은 누적
  const p = await withSsh({ host: '127.0.0.1', port: SSHD.port, username: 'root', password: 'Own-1', readyTimeout: 10_000 }, async ({ exec }) => ({ out: await exec('echo', 5_000, { partial: true, maxBytes: 64 * 1024 }) }));
  assert.equal(p.out.stdout, `${KO}\n`); assert.equal(p.out.stderr, `${KO}\n`);
  // 기능 끝까지 — 사람에게 보이는 출력
  const d = await SVC.runMany({ preset: 'ls', params: { path: '/data' }, ids: [OWN.id] }, { by: 'own' });
  assert.equal(d.ok, true, JSON.stringify(d));
  const o = SVC.outputs(OWN.id).rows[0];
  assert.equal(o.out, KO); assert.equal(o.err, KO); assert.equal(o.exit, 0);
  SSHD.st.mode = 'plain';
});

test('A3 끝 코드 표지 — stderr 가 길어도(2,000자 초과) 끝의 표지를 읽는다: 시한(124) · 0 아닌 끝 코드를 ‘모름’ 으로 떨어뜨리지 않는다', async () => {
  SSHD.st.mode = 'plain'; SSHD.st.errPad = 80; SSHD.st.rc = 124;   // 80줄 × 44자 = 3,520자 뒤에 표지
  await SVC.runMany({ preset: 'ls', params: { path: '/data' }, ids: [OWN.id] }, { by: 'own' });
  let row = SVC.buildView().last.rows[0];
  assert.equal(row.code, 'exec-timeout', JSON.stringify(row)); assert.equal(row.partial, true); assert.equal(row.exit, 124); assert.equal(row.ok, false);
  SSHD.st.rc = 2;
  const d = await SVC.runMany({ preset: 'ls', params: { path: '/data' }, ids: [OWN.id] }, { by: 'own' });
  row = SVC.buildView().last.rows[0];
  assert.equal(row.code, 'ok'); assert.equal(row.exit, 2); assert.equal(d.nonZero, 1);
  // 보이는 stderr 는 여전히 줄 상한(40줄)에서 자른다 · 표지는 보이지 않는다
  const o = SVC.outputs(OWN.id).rows[0];
  assert.equal(o.err.split('\n').length <= 40, true); assert.equal(o.err.includes('#DVC-RC'), false);
  // 다른 기능(코어 기본값)은 예전 그대로 앞 2,000자
  const RS = await import('../src/sshaccess/readServer.js');
  const base = await RS.readServer(OWN.id, { feature: 'server-info', plan: { linux: { command: 'x', timeoutMs: 5_000 } } });
  assert.equal(base.ok, true, JSON.stringify(base).slice(0, 300)); assert.equal(base.stderr.length, 2000);
  SSHD.st.errPad = 0; SSHD.st.rc = 0;
});

test('A4 라우트 — ids 에 글자로 바꿀 수 없는 객체가 섞여도 500 이 아니라 값 오류(400 · 접속 0) — 서버 명령 실행 · 서버 정보', async (t) => {
  const express = (await import('express')).default;
  const { api: router } = await import('../src/routes/api.js');
  const app = express(); app.use(express.json());
  app.use((req, _r, next) => { req.user = { username: 'own', role: 'admin', scope: null }; next(); });
  app.use('/api', router);
  app.use((err, _req, res, _next) => { res.status(500).json({ ok: false, error: 'thrown', message: String(err?.message || err) }); });
  const hs = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => hs.close());
  const post = async (p, raw) => { const r = await fetch(`http://127.0.0.1:${hs.address().port}/api${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw }); return { s: r.status, j: await r.json().catch(() => ({})) }; };
  const n0 = SSHD.st.cmds.length;
  for (const bad of ['[{"toString":1}]', '[{"toString":1,"valueOf":2}]', '[["a"],{"x":1},null,7]']) {
    const a = await post('/tools/server-cmd/run', `{"preset":"uptime","ids":${bad}}`);
    assert.equal(a.s < 500, true, `server-cmd ${bad} → ${a.s} ${JSON.stringify(a.j)}`); assert.equal(a.j.ok, false);
    assert.equal(['no-servers', 'not-found'].includes(a.j.code), true, a.j.code);
    const b = await post('/tools/server-info/read', `{"ids":${bad}}`);
    assert.equal(b.s < 500, true, `server-info ${bad} → ${b.s} ${JSON.stringify(b.j)}`); assert.equal(b.j.ok, false);
  }
  // 글자가 아닌 id 를 조용히 빼지 않는다 — 온전한 id 와 섞여도 하나도 돌리지 않는다(404)
  const mixed = await post('/tools/server-cmd/run', `{"preset":"uptime","ids":[${JSON.stringify(OWN.id)},{"x":1}]}`);
  assert.equal(mixed.s, 404, JSON.stringify(mixed.j)); assert.equal(mixed.j.code, 'not-found');
  // 일괄 틀을 바로 불러도(라우트 밖) 던지지 않는다
  const SI = await import('../src/serverinfo/service.js');
  const trap = JSON.parse('{"toString":1}');
  assert.equal(SVC.startRun({ preset: 'uptime', ids: [trap] }, { by: 'own' }).code, 'not-found');
  assert.equal(SI.startRead([trap, OWN.id], { by: 'own' }).code, 'not-found');
  assert.equal(SVC.startRun({ preset: 'uptime', ids: [null, '', '  '] }, { by: 'own' }).code, 'no-servers');
  assert.equal(SSHD.st.cmds.length, n0, '접속하지 않았다');
  // 정상 요청은 그대로 202
  const ok = await post('/tools/server-cmd/run', JSON.stringify({ preset: 'uptime', ids: [OWN.id] }));
  assert.equal(ok.s, 202, JSON.stringify(ok.j));
  for (let i = 0; i < 200 && SVC.buildView().job; i += 1) await new Promise((r) => setTimeout(r, 50));
});

test('A5 RMA 실행기 — 파이프 청크 경계에 걸린 여러 바이트 글자가 깨지지 않는다(나눠 쓴 stdout · stderr · du 꼴 2만 줄) · 상한 절단에 깨진 조각을 붙이지 않는다', async () => {
  const { runCommand } = await import('../src/rma/exec.js');
  // ① 글자(3바이트) 가운데에서 끊어 두 번에 쓴다 — 두 번의 data 이벤트
  const split = `const b=Buffer.from(${JSON.stringify(`${KO}\n`)});process.stdout.write(b.subarray(0,4));process.stderr.write(b.subarray(0,5));setTimeout(()=>{process.stdout.write(b.subarray(4));process.stderr.write(b.subarray(5));},200);`;
  const a = await runCommand({ argv: [process.execPath, '-e', split], timeoutMs: 20_000 });
  assert.equal(a.ok, true, JSON.stringify(a)); assert.equal(a.stdout, `${KO}\n`); assert.equal(a.stderr, `${KO}\n`);
  // ② du-top 꼴 2만 줄(약 1.2MB — 파이프 청크 64KB 경계가 스무 번쯤 지난다)
  const lineOf = (i) => `${4096 + i}\t/data/사용자폴더/홍길동_${i}/프로젝트자료`;
  const big = 'let s="";for(let i=0;i<20000;i++)s+=(4096+i)+"\\t/data/사용자폴더/홍길동_"+i+"/프로젝트자료\\n";process.stdout.write(s)';
  const r = await runCommand({ argv: [process.execPath, '-e', big], timeoutMs: 30_000, maxLines: 20_001, maxOutput: 4 * 1024 * 1024 });
  assert.equal(r.ok, true, String(r.reason || ''));
  const lines = r.stdout.split('\n');
  assert.equal(lines.length, 20_001); assert.equal(r.stdout.includes('\ufffd'), false, '깨진 글자가 없다');
  for (let i = 0; i < 20_000; i += 1) if (lines[i] !== lineOf(i)) assert.fail(`줄 ${i} 가 다르다: ${JSON.stringify(lines[i])}`);
  // ③ 상한이 글자 가운데에 걸려도(이어지는 바이트 자리) 깨진 조각을 붙이지 않는다 — 잘림 표지 · 종료는 그대로
  const all = Buffer.from(Array.from({ length: 40 }, (_, i) => `${lineOf(i)}\n`).join(''), 'utf8');
  let cut = 600; while ((all[cut] & 0xc0) !== 0x80) cut += 1;   // 이어지는 바이트(10xxxxxx)에서 자른다
  const t = await runCommand({ argv: [process.execPath, '-e', big], timeoutMs: 30_000 }, { maxOutput: cut });
  assert.equal(t.truncated, true); assert.equal(t.ok, false);
  assert.equal(t.stdout.includes('\ufffd'), false, JSON.stringify(t.stdout.slice(-20)));
  assert.equal(Buffer.byteLength(t.stdout) <= cut, true); assert.equal(all.toString('utf8').startsWith(t.stdout), true);
});
