/**
 * Small SSH helper built on ssh2: connect, run commands, and upload files via
 * SFTP. Shared by the proxy auto-deploy and the agent auto-deploy features.
 * Returns a structured log so the UI can show what happened on the remote host.
 */

import { Client as SSHClient } from 'ssh2';

function connect({ host, port = 22, username, password, privateKey, readyTimeout = Number(process.env.SSH_READY_TIMEOUT_MS) || 60000 }) {
  return new Promise((resolve, reject) => {
    const conn = new SSHClient();
    conn.on('ready', () => resolve(conn));
    conn.on('error', reject);
    // password 대신 keyboard-interactive 만 허용하는 서버 지원(ssh2는 명시적으로 켜야 시도).
    // 같은 비밀번호로 모든 프롬프트에 응답한다.
    conn.on('keyboard-interactive', (name, instr, lang, prompts, finish) => {
      finish(prompts.map(() => password || ''));
    });
    const auth = { host, port, username, readyTimeout, keepaliveInterval: 15000 };
    if (privateKey) auth.privateKey = privateKey;
    else { auth.password = password; auth.tryKeyboard = true; }
    conn.connect(auth);
  });
}

// exec 는 **반드시 타임아웃 + stream error 처리**가 있어야 한다. 멈춘 mount 위의 df 처럼
// 원격 명령이 hang 하면 'close' 이벤트가 오지 않아 이 Promise 가 영원히 미결로 남고,
// 이를 await 하는 폴러(bmstor 수집 등)가 running=true 로 영구 고착된다(실측 장애). Promise.race
// 대신 인라인 타이머로 stream 을 닫고 reject 해, 매달린 채널도 정리한다.
function exec(conn, command, timeoutMs = Number(process.env.SSH_EXEC_TIMEOUT_MS) || 60000) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = '', stderr = '', done = false;
      const finish = (fn, arg) => { if (done) return; done = true; clearTimeout(timer); fn(arg); };
      const timer = setTimeout(() => {
        try { stream.close?.(); } catch { /* */ }
        try { stream.destroy?.(); } catch { /* */ }
        finish(reject, new Error(`SSH exec 타임아웃(${Math.round(timeoutMs / 1000)}s): ${command}`));
      }, Math.max(1000, timeoutMs));
      timer.unref?.();
      stream.on('data', (d) => { stdout += d.toString(); });
      stream.stderr.on('data', (d) => { stderr += d.toString(); });
      stream.on('error', (e) => finish(reject, e));          // 채널/연결 오류로도 반드시 결말 짓는다
      stream.stderr.on('error', () => { /* stderr 스트림 오류는 비치명 — 무시 */ });
      stream.on('close', (code) => finish(resolve, { command, code, stdout, stderr }));
    });
  });
}

function sftpReadFile(conn, path) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      sftp.readFile(path, (e, data) => (e ? reject(e) : resolve(data.toString('utf8'))));
    });
  });
}

function sftpPutFile(conn, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      sftp.fastPut(localPath, remotePath, (e) => (e ? reject(e) : resolve()));
    });
  });
}

function sftpWriteFile(conn, path, content, mode = 0o644) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      const ws = sftp.createWriteStream(path, { mode });
      ws.on('close', resolve);
      ws.on('error', reject);
      ws.end(Buffer.isBuffer(content) ? content : Buffer.from(content));
    });
  });
}

/**
 * Open a session, run fn({exec, readFile, writeFile, log}), and always close.
 * `log` accumulates {command, code, stdout, stderr} entries for the response.
 */
export async function withSsh(creds, fn) {
  const conn = await connect(creds);
  const log = [];
  const api = {
    exec: async (cmd) => { const r = await exec(conn, cmd); log.push(r); return r; },
    readFile: (p) => sftpReadFile(conn, p),
    writeFile: (p, c, m) => sftpWriteFile(conn, p, c, m),
    putFile: (local, remote) => sftpPutFile(conn, local, remote),
    log,
  };
  try {
    const result = await fn(api);
    return { ok: true, log, ...result };
  } finally {
    try { conn.end(); } catch { /* ignore */ }
  }
}
