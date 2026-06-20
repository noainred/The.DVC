/**
 * Small SSH helper built on ssh2: connect, run commands, and upload files via
 * SFTP. Shared by the proxy auto-deploy and the agent auto-deploy features.
 * Returns a structured log so the UI can show what happened on the remote host.
 */

import { Client as SSHClient } from 'ssh2';

function connect({ host, port = 22, username, password, privateKey, readyTimeout = 20000 }) {
  return new Promise((resolve, reject) => {
    const conn = new SSHClient();
    conn.on('ready', () => resolve(conn));
    conn.on('error', reject);
    const auth = { host, port, username, readyTimeout, keepaliveInterval: 15000 };
    if (privateKey) auth.privateKey = privateKey; else auth.password = password;
    conn.connect(auth);
  });
}

function exec(conn, command) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = '', stderr = '';
      stream.on('data', (d) => { stdout += d.toString(); });
      stream.stderr.on('data', (d) => { stderr += d.toString(); });
      stream.on('close', (code) => resolve({ command, code, stdout, stderr }));
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
