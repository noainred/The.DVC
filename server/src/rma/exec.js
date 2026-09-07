/**
 * RMA 실행기(엣지) — buildCommand() 결과를 실행한다. 셸 없이 spawn(argv) 가 기본이고,
 * 자유 명령(shell)만 /bin/sh -c 를 쓴다(엣지 opt-in 시에만 여기까지 온다).
 *
 * 안전장치:
 *  - 타임아웃: SIGTERM → 3초 뒤 SIGKILL. 프로세스 그룹(detached) 으로 띄워 자식까지 정리.
 *  - 출력 상한(maxOutput 바이트): 넘치면 잘라내고 truncated 표시 + 프로세스 종료(무한 출력 방어).
 *  - maxLines: 긴 목록형 출력(ps/top)은 앞 N줄만.
 *  - stdin 은 닫는다(입력 대기로 매달리지 않게).
 *  - 환경: PATH 최소 + LANG=C(출력 파싱·표시 안정).
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import dgram from 'node:dgram';
import os from 'node:os';

export const DEFAULT_MAX_OUTPUT = Number(process.env.RMA_MAX_OUTPUT) || 256 * 1024;

const SAFE_ENV = { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C', HOME: process.env.HOME || '/tmp' };

function clipLines(s, maxLines) {
  if (!maxLines) return { text: s, clipped: false };
  const lines = s.split('\n');
  if (lines.length <= maxLines) return { text: s, clipped: false };
  return { text: lines.slice(0, maxLines).join('\n') + '\n', clipped: true };
}

/** TCP 포트 접속 확인(네이티브 — nc 유무에 의존하지 않음). */
export function tcpPortCheck(host, port, timeoutMs = 5_000) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const sock = net.connect({ host, port: Number(port) });
    const done = (ok, reason) => { try { sock.destroy(); } catch { /* */ } resolve({ ok, exitCode: ok ? 0 : 1, stdout: ok ? `open ${host}:${port} (${Date.now() - t0}ms)\n` : '', stderr: ok ? '' : `${reason}\n`, durationMs: Date.now() - t0, timedOut: false, truncated: false }); };
    sock.setTimeout(Math.max(500, timeoutMs));
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false, `timeout after ${timeoutMs}ms`));
    sock.once('error', (e) => done(false, e?.code || e?.message || 'error'));
  });
}

/**
 * 실행. spec = buildCommand() 의 ok 결과. 반환:
 * { ok, exitCode, signal, stdout, stderr, durationMs, timedOut, truncated, clipped }
 * ok = 정상 종료(exit 0) 이고 타임아웃/출력초과 없음.
 */
/** TCP 전송 — 연결 후 문자열을 보내고 응답 앞부분(최대 4KB, 2초)을 회신. */
export function tcpSend(host, port, data = '', timeoutMs = 10_000) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const sock = net.connect({ host, port: Number(port) });
    let out = ''; let done = false;
    const fin = (ok, reason) => { if (done) return; done = true; try { sock.destroy(); } catch { /* */ } resolve({ ok, exitCode: ok ? 0 : 1, stdout: out, stderr: ok ? '' : `${reason}\n`, durationMs: Date.now() - t0, timedOut: false, truncated: false }); };
    sock.setTimeout(Math.max(500, timeoutMs));
    sock.once('connect', () => { if (data) sock.write(data.replace(/\\n/g, '\n').replace(/\\r/g, '\r')); setTimeout(() => fin(true), 2000).unref?.(); });
    sock.on('data', (b) => { out += b.toString('utf8'); if (out.length > 4096) { out = out.slice(0, 4096); fin(true); } });
    sock.once('end', () => fin(true));
    sock.once('timeout', () => fin(!!out, 'timeout')); sock.once('error', (e) => fin(false, e?.code || e?.message));
  });
}
/** UDP 전송(응답 기대 없음 — 송신 성공만 보고). */
export function udpSend(host, port, data) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    const buf = Buffer.from(String(data), 'utf8');
    s.send(buf, Number(port), host, (err) => { try { s.close(); } catch { /* */ } resolve(err ? { ok: false, exitCode: 1, stdout: '', stderr: `${err.code || err.message}\n`, durationMs: Date.now() - t0 } : { ok: true, exitCode: 0, stdout: `sent ${buf.length} bytes to ${host}:${port}\n`, stderr: '', durationMs: Date.now() - t0 }); });
  });
}
/** Syslog(RFC 3164, facility user=1) — UDP 로 전송. */
export function syslogSend(host, port, message, severity = 6) {
  const pri = 1 * 8 + Math.max(0, Math.min(7, Number(severity) || 0));
  const ts = new Date().toString().slice(4, 24); // 'Sep  7 12:34:56' 형식 근사
  return udpSend(host, port, `<${pri}>${ts} ${os.hostname()} vmware-portal-rma: ${String(message).slice(0, 900)}`);
}

export function runCommand(spec, { maxOutput = DEFAULT_MAX_OUTPUT } = {}) {
  if (spec.native === 'tcp-port') return tcpPortCheck(spec.args.host, spec.args.port, Math.min(spec.timeoutMs, 30_000));
  if (spec.native === 'tcp-send') return tcpSend(spec.args.host, spec.args.port, spec.args.data || '', Math.min(spec.timeoutMs, 30_000));
  if (spec.native === 'udp-send') return udpSend(spec.args.host, spec.args.port, spec.args.data);
  if (spec.native === 'syslog') return syslogSend(spec.args.host, spec.args.port, spec.args.message, spec.args.severity);
  if (spec.native === 'rma-restart') {
    // systemd Restart=always 가 재기동한다. 결과를 먼저 회신할 수 있게 지연 종료(agent.js 가 postResult 후 exit 하도록 플래그만).
    return Promise.resolve({ ok: true, exitCode: 0, stdout: 'RMA 프로세스를 3초 뒤 종료합니다(systemd 가 재기동)\n', stderr: '', durationMs: 0, restartSelf: true });
  }
  const t0 = Date.now();
  const timeoutMs = Math.max(1000, Number(spec.timeoutMs) || 30_000);
  return new Promise((resolve) => {
    let child;
    try {
      child = spec.shell
        ? spawn('/bin/sh', ['-c', spec.shell], { env: SAFE_ENV, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
        : spawn(spec.argv[0], spec.argv.slice(1), { env: SAFE_ENV, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (e) {
      return resolve({ ok: false, exitCode: null, signal: null, stdout: '', stderr: `spawn 실패: ${e.message}\n`, durationMs: Date.now() - t0, timedOut: false, truncated: false, reason: e.message });
    }
    let out = '', err = '', bytes = 0, truncated = false, timedOut = false, finished = false;
    const killGroup = (sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* */ } } };
    const onData = (which) => (buf) => {
      bytes += buf.length;
      if (bytes > maxOutput) {
        if (!truncated) { truncated = true; const room = Math.max(0, maxOutput - (bytes - buf.length)); if (which === 'out') out += buf.subarray(0, room).toString(); else err += buf.subarray(0, room).toString(); killGroup('SIGTERM'); }
        return;
      }
      if (which === 'out') out += buf.toString(); else err += buf.toString();
    };
    child.stdout.on('data', onData('out'));
    child.stderr.on('data', onData('err'));
    const timer = setTimeout(() => { timedOut = true; killGroup('SIGTERM'); setTimeout(() => killGroup('SIGKILL'), 3000).unref?.(); }, timeoutMs);
    const finish = (code, signal, spawnErr) => {
      if (finished) return; finished = true;
      clearTimeout(timer);
      const { text, clipped } = clipLines(out, spec.maxLines);
      const ok = !spawnErr && !timedOut && !truncated && code === 0;
      const reason = spawnErr ? `실행 실패: ${spawnErr.code === 'ENOENT' ? `'${spec.argv?.[0]}' 명령이 이 엣지에 없습니다` : spawnErr.message}`
        : timedOut ? `제한 시간(${Math.round(timeoutMs / 1000)}초) 초과로 중단` : truncated ? `출력이 ${Math.round(maxOutput / 1024)}KB 를 넘어 중단` : code !== 0 ? `종료 코드 ${code}${signal ? ` (${signal})` : ''}` : '';
      resolve({ ok, exitCode: code, signal: signal || null, stdout: text, stderr: err, durationMs: Date.now() - t0, timedOut, truncated, clipped, ...(reason ? { reason } : {}) });
    };
    child.once('error', (e) => finish(null, null, e));
    child.once('close', (code, signal) => finish(code, signal));
  });
}
