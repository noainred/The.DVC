/**
 * hostaccess/exec.js — firewall-cmd / systemctl 실행기(v2.485). 셸 없이 spawn(argv), sudo -n(비밀번호 없는 sudoers 필요).
 * 인자는 render.js 가 만든 것만 온다(사용자 입력은 정규화 후 rich rule 문자열로만 들어간다).
 */
import { spawn } from 'node:child_process';

const SAFE_ENV = { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C' };
export const FIREWALL_CMD = '/usr/bin/firewall-cmd';
export const SYSTEMCTL = '/usr/bin/systemctl';

export function run(cmd, args, { timeoutMs = 20_000 } = {}) {
  return new Promise((resolve) => {
    let out = ''; let err = ''; let done = false;
    const t0 = Date.now();
    let child;
    try { child = spawn(cmd, args, { env: SAFE_ENV, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return resolve({ ok: false, code: -1, stdout: '', stderr: String(e.message || e), ms: 0 }); }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* */ } }, timeoutMs);
    child.stdout.on('data', (b) => { if (out.length < 256 * 1024) out += b.toString('utf8'); });
    child.stderr.on('data', (b) => { if (err.length < 64 * 1024) err += b.toString('utf8'); });
    const fin = (code) => { if (done) return; done = true; clearTimeout(timer); resolve({ ok: code === 0, code, stdout: out, stderr: err, ms: Date.now() - t0 }); };
    child.on('error', (e) => { err += String(e.message || e); fin(-1); });
    child.on('close', (code) => fin(code == null ? -1 : code));
  });
}

/** sudo -n firewall-cmd <args> */
export const fw = (args, opts) => run('sudo', ['-n', FIREWALL_CMD, ...args], opts);
/** sudo -n systemctl <verb> sshd.service — sudoers 줄과 정확히 같은 인자만. */
export const sshdCtl = (verb) => run('sudo', ['-n', SYSTEMCTL, verb, 'sshd.service']);
/** systemctl is-active sshd (root 불필요) */
export const sshdActive = async () => { const r = await run(SYSTEMCTL, ['is-active', 'sshd.service'], { timeoutMs: 5_000 }); return r.stdout.trim() === 'active'; };

/** sudo 거부(비밀번호 요구/규칙 없음) 판정 — 화면이 정확한 sudoers 줄을 안내한다. */
export function isSudoDenied(r) {
  return !r.ok && /a password is required|not allowed to execute|sudo: .*command not found|sudoers/i.test(r.stderr || '');
}
