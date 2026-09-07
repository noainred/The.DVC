/**
 * Small SSH helper built on ssh2: connect, run commands, and upload files via
 * SFTP. Shared by the proxy auto-deploy and the agent auto-deploy features.
 * Returns a structured log so the UI can show what happened on the remote host.
 */

import { Client as SSHClient } from 'ssh2';

function connect({ host, port = 22, username, password, privateKey, passphrase, readyTimeout = Number(process.env.SSH_READY_TIMEOUT_MS) || 60000, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('SSH 접속 취소(타임아웃)'));
    const conn = new SSHClient();
    // 취소(signal) — 호출자의 장비당 타임아웃이 접속 대기 중에 만료되면 접속 시도 자체를 끊는다.
    const onAbort = () => { try { conn.end(); } catch { /* */ } reject(new Error('SSH 접속 취소(타임아웃)')); };
    signal?.addEventListener('abort', onAbort, { once: true });
    conn.on('ready', () => { signal?.removeEventListener('abort', onAbort); resolve(conn); });
    conn.on('error', (e) => { signal?.removeEventListener('abort', onAbort); reject(e); });
    // password 대신 keyboard-interactive 만 허용하는 서버 지원(ssh2는 명시적으로 켜야 시도).
    // 같은 비밀번호로 모든 프롬프트에 응답한다.
    conn.on('keyboard-interactive', (name, instr, lang, prompts, finish) => {
      finish(prompts.map(() => password || ''));
    });
    const auth = { host, port, username, readyTimeout, keepaliveInterval: 15000 };
    if (privateKey) { auth.privateKey = privateKey; if (passphrase) auth.passphrase = passphrase; }
    else { auth.password = password; auth.tryKeyboard = true; }
    conn.connect(auth);
  });
}

// exec 는 **반드시 타임아웃 + stream error 처리**가 있어야 한다. 멈춘 mount 위의 df 처럼
// 원격 명령이 hang 하면 'close' 이벤트가 오지 않아 이 Promise 가 영원히 미결로 남고,
// 이를 await 하는 폴러(bmstor 수집 등)가 running=true 로 영구 고착된다(실측 장애). Promise.race
// 대신 인라인 타이머로 stream 을 닫고 reject 해, 매달린 채널도 정리한다.
// 출력 누적 상한(v2.417) — 고장 장비가 타임아웃까지 출력을 흘리면 메모리가 무한히 자란다.
// 넘치면 채널을 닫고 reject(정직: 절단본을 성공으로 넘기지 않는다). execCapture 는 자체 2MB 캡.
const EXEC_MAX_OUTPUT = Math.max(64 * 1024, Number(process.env.SSH_EXEC_MAX_OUTPUT) || 4 * 1024 * 1024);
function exec(conn, command, timeoutMs = Number(process.env.SSH_EXEC_TIMEOUT_MS) || 60000) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = '', stderr = '', done = false, bytes = 0;
      const finish = (fn, arg) => { if (done) return; done = true; clearTimeout(timer); fn(arg); };
      const kill = () => { try { stream.close?.(); } catch { /* */ } try { stream.destroy?.(); } catch { /* */ } };
      const timer = setTimeout(() => {
        kill();
        finish(reject, new Error(`SSH exec 타임아웃(${Math.round(timeoutMs / 1000)}s): ${command}`));
      }, Math.max(1000, timeoutMs));
      timer.unref?.();
      const onChunk = (which) => (d) => {
        bytes += d.length;
        if (bytes > EXEC_MAX_OUTPUT) { kill(); return finish(reject, new Error(`SSH exec 출력 상한(${Math.round(EXEC_MAX_OUTPUT / 1024)}KB) 초과: ${command}`)); }
        if (which === 'out') stdout += d.toString(); else stderr += d.toString();
      };
      stream.on('data', onChunk('out'));
      stream.stderr.on('data', onChunk('err'));
      stream.on('error', (e) => finish(reject, e));          // 채널/연결 오류로도 반드시 결말 짓는다
      stream.stderr.on('error', () => { /* stderr 스트림 오류는 비치명 — 무시 */ });
      stream.on('close', (code) => finish(resolve, { command, code, stdout, stderr }));
    });
  });
}

/**
 * 계속 갱신되는(스스로 끝나지 않는) 명령을 정해진 시간만 캡처하고 채널을 닫는다(v2.411).
 *
 * 왜 필요한가: Brocade `portperfshow` 는 Ctrl-C 전까지 화면을 계속 다시 그린다. 일반 exec 은
 * 타임아웃 시 **reject 하면서 그때까지 받은 stdout 을 버리므로** 이런 명령은 영원히 수집할 수
 * 없다. 여기서는 같은 타임아웃을 '수집 종료 신호'로 쓰고 **모아 둔 출력을 resolve** 한다.
 *
 * ⚠ 일반 명령에는 쓰지 말 것 — 정상 종료를 기다리지 않고 잘라내므로, 끝이 있는 명령에 쓰면
 *   출력이 중간에 끊긴 것을 성공으로 오인한다.
 */
function execCapture(conn, command, captureMs) {
  return new Promise((resolve, reject) => {
    conn.exec(command, { pty: false }, (err, stream) => {
      if (err) return reject(err);
      let stdout = ''; let stderr = ''; let done = false;
      const finish = (fn, arg) => { if (done) return; done = true; clearTimeout(timer); fn(arg); };
      const stop = () => {
        try { stream.close?.(); } catch { /* */ }
        try { stream.destroy?.(); } catch { /* */ }
        finish(resolve, { command, code: null, stdout, stderr, captured: true });
      };
      const timer = setTimeout(stop, Math.max(1000, captureMs));
      timer.unref?.();
      stream.on('data', (d) => {
        stdout += d.toString();
        // 폭주 방어 — 갱신형 명령이 예상보다 빨리 그리면 메모리가 부풀 수 있다.
        if (stdout.length > 2_000_000) stop();
      });
      stream.stderr.on('data', (d) => { stderr += d.toString(); });
      stream.on('error', (e) => finish(reject, e));
      stream.stderr.on('error', () => { /* 비치명 */ });
      stream.on('close', (code) => finish(resolve, { command, code, stdout, stderr, captured: false }));
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
export async function withSsh(creds, fn, { signal = creds?.signal } = {}) {
  const conn = await connect({ ...creds, signal });
  const log = [];
  // 취소(signal, v2.417): 호출자의 장비당 타임아웃이 만료되면 **세션을 실제로 끊는다**. 예전에는
  // 호출자가 Promise.race 로 결과만 포기하고 세션은 남은 명령을 끝까지 돌렸다(최대 ~8.5분) —
  // 동시성 상한이 실효를 잃고 다음 주기가 같은 장비에 두 번째 세션을 열었다(리뷰 확정).
  let onAbort = null;
  const aborted = new Promise((_, reject) => {
    if (!signal) return;
    onAbort = () => { try { conn.end(); } catch { /* */ } reject(new Error('SSH 세션 취소(타임아웃)')); };
    if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
  });
  aborted.catch(() => {}); // 취소가 없으면 영원히 미결 — unhandled 방지
  const api = {
    // timeoutMs 는 선택 — 생략하면 exec 의 기본값(SSH_EXEC_TIMEOUT_MS 또는 60s). 원격에서
    // `timeout <N> tcpdump` 처럼 **의도적으로 오래 도는** 명령은 반드시 명시해야 한다(과거
    // pcap/트래픽 캡처가 최대 120초를 허용하면서 전송 계층은 60초에 끊어 항상 실패했다).
    exec: async (cmd, timeoutMs) => { const r = await exec(conn, cmd, timeoutMs); log.push(r); return r; },
    // 스스로 끝나지 않는 갱신형 명령(portperfshow 등) 전용 — captureMs 만큼 모으고 채널을 닫는다.
    execCapture: async (cmd, captureMs) => { const r = await execCapture(conn, cmd, captureMs); log.push(r); return r; },
    readFile: (p) => sftpReadFile(conn, p),
    writeFile: (p, c, m) => sftpWriteFile(conn, p, c, m),
    putFile: (local, remote) => sftpPutFile(conn, local, remote),
    log,
  };
  try {
    const result = signal ? await Promise.race([fn(api), aborted]) : await fn(api);
    return { ok: true, log, ...result };
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    try { conn.end(); } catch { /* ignore */ }
  }
}

/**
 * 장비당 타임아웃 헬퍼(v2.417) — AbortController 로 signal 을 만들어 fn(signal) 을 돌리고, 기한이
 * 지나면 abort 한다(withSsh 가 세션을 끊는다). 결과만 포기하는 Promise.race 대신 이걸 쓸 것.
 */
export async function withDeadline(ms, fn, label = '타임아웃') {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), Math.max(1000, ms)); // unref 하지 않는다 — 대기 중인 수집을 반드시 끊어야 한다
  try { return await fn(ac.signal); }
  catch (e) { if (ac.signal.aborted) throw new Error(`${label}(${Math.round(ms / 1000)}초)`); throw e; }
  finally { clearTimeout(t); }
}
