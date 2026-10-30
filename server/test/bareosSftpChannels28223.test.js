/**
 * test/bareosSftpChannels28223.test.js — v2.822.3 I2-1·P2-8(검토 재현 — 하네스는 2차 검토 통합 축의 것을 옮겼다).
 *  proxy/sshExec.js 의 SFTP 쓰기·읽기·올리기가 채널을 닫지 않아(sftp.end() 없음) 파일마다 세션 채널이 쌓였다 — OpenSSH MaxSessions
 *  (연결당 세션 채널 상한, 기본 10)를 흉내 낸 ssh2 서버에서 Bareos 자동 설정이 ① MaxSessions 4 면 첫 실행부터 실패 ② 기본 10 에서도
 *  재실행 + 검사 실패면 세션 안 되돌리기가 깨져 '세션이 끊겨' 라는 틀린 문구로 새 세션 되돌리기에 넘어갔다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bareos-sftpch-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
process.env.SSH_HOSTKEY_POLICY = 'observe';
fs.writeFileSync(path.join(DIR, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));
after(() => { fs.rmSync(DIR, { recursive: true, force: true }); });

const { default: ssh2 } = await import('ssh2');
const auto = await import('../src/bareos/autoSetup.js');
const newKey = () => crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'sec1', format: 'pem' });

function bareosHost({ maxSessions, mode /* 'none' | 'managed' */, testFails, noSftp = false }) {
  const stats = { open: 0, peak: 0, rejected: 0, sftpOpened: 0, sftpClosed: 0, cmds: [] };
  const files = new Map();   // 원격 파일(경로 → 내용)
  const hostKey = newKey();
  const srv = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
    client.on('authentication', (ctx) => { if (ctx.method === 'password' && ctx.password === 'rootpw') ctx.accept(); else ctx.reject(['password']); });
    client.on('error', () => {});
    const conn = { open: 0 };   // MaxSessions 는 연결당이다
    stats.conns = (stats.conns || 0) + 1;
    client.on('ready', () => client.on('session', (accept, reject) => {
      if (conn.open >= maxSessions) { stats.rejected += 1; reject(); return; }
      const s = accept();
      conn.open += 1; stats.peak = Math.max(stats.peak, conn.open);
      let counted = true;
      const done = () => { if (counted) { counted = false; conn.open -= 1; } };
      s.on('close', done);
      s.on('exec', (acc, rej, info) => {
        const st = acc();
        const cmd = info.command;
        stats.cmds.push(cmd.slice(0, 60));
        let out = ''; let code = 0;
        if (cmd === 'id -u') out = '0\n';
        else if (cmd.startsWith('test -d /etc/bareos/bareos-dir.d && echo D')) out = 'D\nB\nC\nU\nR\n';
        else if (cmd.startsWith('if [ -L ') || cmd.startsWith('if ! [ "$(readlink')) {
          const p = /(?:^if|elif) \[ -L (\S+) \]/.exec(cmd)[1];
          if (files.has(p)) out = `FILE\n${files.get(p)}`;
          else if (mode === 'managed') out = `FILE\n${auto.MARKER}\nold content for ${p}\n`;
          else out = 'NONE\n';
        } else if (cmd.startsWith('mktemp -d /tmp/portal-bareos.')) out = '/tmp/portal-bareos.abcdefghij\n';
        else if (cmd.startsWith('test -d /tmp/portal-bareos.')) out = 'ok\n';
        else if (cmd.startsWith('runuser -u bareos -- bareos-dir -t')) { if (testFails) { out = 'Config error: simulated\n'; code = 1; } }
        else if (cmd.startsWith("printf 'reload")) out = 'reloaded\n';
        st.write(out); st.exit(code); st.end();
      });
      s.on('sftp', (acc, rej) => {
        if (noSftp) { rej(); return; }
        stats.sftpOpened += 1;
        const sftp = acc();
        let h = 0; const handles = new Map();
        sftp.on('OPEN', (reqid, filename) => { const hb = Buffer.from(String(++h)); handles.set(hb.toString(), filename); sftp.handle(reqid, hb); });
        sftp.on('FSETSTAT', (reqid) => sftp.status(reqid, ssh2.utils.sftp.STATUS_CODE.OK));
        sftp.on('WRITE', (reqid) => sftp.status(reqid, ssh2.utils.sftp.STATUS_CODE.OK));
        sftp.on('CLOSE', (reqid) => sftp.status(reqid, ssh2.utils.sftp.STATUS_CODE.OK));
        sftp.on('close', () => { stats.sftpClosed += 1; });
      });
    }));
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port, stats })));
}

const fakeConsole = async () => ({ info: { banner: 'OK: bareos-dir Version: 25.0.4 (01 Oct 2026)', tls: 'TLSv1.3' }, call: async () => ({ clients: [{ name: 'site-fd' }] }), close() {} });
auto._setDepsForTest({ openConsole: fakeConsole, sleep: async () => {} });


auto._setDepsForTest({ openConsole: fakeConsole, sleep: async () => {} });
after(() => auto._setDepsForTest());

async function run(opts) {
  const h = await bareosHost(opts);
  try {
    const r = await auto.setupDirector({ host: '127.0.0.1', sshPort: h.port, username: 'root', password: 'rootpw', restoreClient: 'site-fd', restoreStorage: 'File', restorePool: 'Full' });
    return { ok: true, files: r.files.map((f) => f.action).join(','), stats: h.stats };
  } catch (e) {
    return { ok: false, code: e.code || '', message: String(e.message), stats: h.stats };
  } finally { await new Promise((r) => setTimeout(r, 100)); h.srv.close(); }
}

test('MaxSessions 4(강화 설정) — 첫 실행·재실행 모두 성공 · 연결당 동시 세션 채널이 쌓이지 않는다', async () => {
  const a = await run({ maxSessions: 4, mode: 'none', testFails: false });
  assert.equal(a.ok, true, a.message);
  assert.equal(a.stats.rejected, 0);
  assert.ok(a.stats.peak <= 2, `동시 채널 ${a.stats.peak}`);
  const b = await run({ maxSessions: 4, mode: 'managed', testFails: false });
  assert.equal(b.ok, true, b.message);
  assert.equal(b.files, 'updated,updated,updated,updated,updated');
});

test('기본 MaxSessions 10 — 재실행 + 검사 실패면 같은 세션에서 되돌린다(새 세션으로 넘어가 틀린 문구를 내지 않는다)', async () => {
  const r = await run({ maxSessions: 10, mode: 'managed', testFails: true });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'config-test');
  assert.match(r.message, /넣은 파일을 되돌렸습니다/);
  assert.doesNotMatch(r.message, /세션이 끊겨/);
  assert.equal(r.stats.rejected, 0);
});
