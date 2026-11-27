/**
 * hostaccess/exec.js — firewall-cmd / systemctl 실행기(v2.485). 셸 없이 spawn(argv), sudo -n(비밀번호 없는 sudoers 필요).
 * 인자는 render.js 가 만든 것만 온다(사용자 입력은 정규화 후 rich rule 문자열로만 들어간다).
 *
 * 보안 잔여 11-27 M-5: firewall-cmd 는 root 소유 인자 검사 래퍼(FW_WRAPPER — packaging/offline/vmware-portal-firewall-cmd)로 부른다.
 *   install.sh 가 래퍼를 두고 sudoers(/etc/sudoers.d/vmware-portal-hostaccess)는 그 파일 하나만 허용한다(예전: /usr/bin/firewall-cmd 인자 무제한).
 *   - 래퍼가 **없으면(ENOENT 만)** 옛 설치본으로 보고 예전처럼 sudo -n /usr/bin/firewall-cmd 를 부른다(옛 sudoers 와 1:1 — 호환).
 *   - 래퍼가 있는데 그 길이 안전하지 않으면(링크 · root 소유 아님 · 그룹/기타 쓰기 · 실행 비트 없음 · 위 폴더 · ENOENT 밖의 확인 실패)
 *     **실행하지 않는다**(fail-closed) — 옛 직접 호출로도 내려가지 않는다.
 *   ⚠ 정직한 한계: sudo 는 명령 파일의 소유자를 보지 않고, 서비스 계정을 쥔 쪽은 node 를 거치지 않고 sudo 를 직접 부른다. 바꿔치기를
 *     막는 것은 install.sh 의 길 판정(vp_path_controllers — root 만 바꿀 수 있는 길에만 둔다)이고, 여기 확인은 이상을 **알리고 멈추는** 장치다.
 *   - 판정 코어는 래퍼 하나다: 적용 전 사전 검사(fw.validate)도 그 파일을 권한 없이 --vp-validate-only 로 실행한다(JS 사본을 두지 않는다).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const SAFE_ENV = { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C' };
export const FIREWALL_CMD = '/usr/bin/firewall-cmd';
export const SYSTEMCTL = '/usr/bin/systemctl';
/** 래퍼 설치 경로 — install.sh VP_FW_WRAPPER · uninstall.sh 와 같은 값(시험이 대조). env 로 바꾸지 않는다. */
export const FW_WRAPPER = '/usr/local/libexec/vmware-portal-firewall-cmd';
/** 래퍼가 거부할 때 stderr 접두(래퍼 TAG 와 같은 값). */
export const FW_REFUSED_TAG = 'vmware-portal-firewall-cmd: refused:';
/** 래퍼 거부 종료 코드. */
export const FW_REFUSED_CODE = 64;

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

const WHY_TEXT = {
  symlink: '심볼릭 링크입니다',
  'not-file': '일반 파일이 아닙니다',
  'not-root': 'root 소유가 아닙니다',
  writable: '그룹·기타가 쓸 수 있습니다',
  'not-exec': '실행 권한이 없습니다',
  'parent-not-root': '위 폴더가 root 소유가 아닙니다',
  'parent-writable': '위 폴더를 그룹·기타가 쓸 수 있습니다',
  'parent-link-not-root': '길에 root 소유가 아닌 링크가 있습니다',
  loop: '길에 링크가 너무 많이 이어집니다',
  'stat-error': '파일 정보를 확인하지 못했습니다',
};

/**
 * 래퍼 경로 판정 — 문자 그대로의 경로를 / 부터 한 단계씩 lstat 한다(realpath 로 건너뛰지 않는다 — install.sh vp_path_controllers 와 같은 방식).
 *   길의 링크는 그 링크 자체(소유자)를 본 뒤 대상 길을 이어서 본다. 마지막 항목이 링크면 불안전(설치는 rename 으로 일반 파일을 둔다).
 * @returns {{mode:'wrapper'|'direct'|'unsafe', cmd:string, why?:string, detail?:string}}
 *   direct = ENOENT 일 때만(옛 설치본). 그 밖의 확인 실패(EACCES · ENOTDIR · ELOOP …)는 unsafe — '없음' 이 아니다(134회차 규칙).
 */
export function wrapperState(file = FW_WRAPPER, io = { lstatSync: fs.lstatSync, readlinkSync: fs.readlinkSync }) {
  const unsafe = (why, at = file) => ({ mode: 'unsafe', cmd: file, why, detail: `${WHY_TEXT[why] || why}(${at})` });
  if (typeof file !== 'string' || !path.isAbsolute(file)) return unsafe('stat-error');
  let todo = file.split('/').filter((c) => c && c !== '.');
  let cur = '';
  let hops = 0;
  let st;
  // '/' 자체
  try { st = io.lstatSync('/'); } catch (e) { return e?.code === 'ENOENT' ? { mode: 'direct', cmd: FIREWALL_CMD } : unsafe('stat-error', '/'); }
  if (st.uid !== 0) return unsafe('parent-not-root', '/');
  if ((st.mode & 0o022) && !(st.mode & 0o1000)) return unsafe('parent-writable', '/');
  while (todo.length) {
    const comp = todo.shift();
    if (comp === '..') { cur = cur.slice(0, cur.lastIndexOf('/')); continue; }
    const p = `${cur}/${comp}`;
    const last = todo.length === 0;
    try { st = io.lstatSync(p); }
    catch (e) { return e?.code === 'ENOENT' ? { mode: 'direct', cmd: FIREWALL_CMD } : unsafe('stat-error', p); }
    if (st.isSymbolicLink()) {
      if (last) return unsafe('symlink', p);
      if (st.uid !== 0) return unsafe('parent-link-not-root', p);
      if (++hops > 40) return unsafe('loop', p);
      let t;
      try { t = String(io.readlinkSync(p)); } catch { return unsafe('stat-error', p); }
      if (t.startsWith('/')) cur = '';
      todo = [...t.split('/').filter((c) => c && c !== '.'), ...todo];
      continue;
    }
    if (last) {
      if (!st.isFile()) return unsafe('not-file', p);
      if (st.uid !== 0) return unsafe('not-root', p);
      if (st.mode & 0o022) return unsafe('writable', p);
      if (!(st.mode & 0o100)) return unsafe('not-exec', p);
      return { mode: 'wrapper', cmd: file };
    }
    if (!st.isDirectory()) return unsafe('stat-error', p);
    if (st.uid !== 0) return unsafe('parent-not-root', p);
    if ((st.mode & 0o022) && !(st.mode & 0o1000)) return unsafe('parent-writable', p);
    cur = p;
  }
  return unsafe('not-file');
}

/** 지금 쓸 firewall-cmd 실행 방식(매 호출 판정 — install.sh 재실행 뒤 재시작 없이 바로 래퍼로 바뀐다). */
export function fwRunner() { return wrapperState(); }

/**
 * firewall-cmd 실행기 — 함수에 runner(실행 방식) · validate(래퍼 사전 검사)를 붙인다. 서비스는 deps.fw.runner 로 방식을 읽는다
 *   (가짜 실행기를 넣은 시험은 runner 가 없어 예전 동작 그대로 — 호스트에 래퍼가 깔려 있어도 결과가 바뀌지 않는다).
 */
export function makeFw({ runner = fwRunner, runImpl = run } = {}) {
  const fwFn = async (args, opts) => {
    const r = runner();
    if (r.mode === 'unsafe') return { ok: false, code: -1, stdout: '', stderr: r.detail || '방화벽 래퍼가 안전하지 않습니다', ms: 0, wrapperUnsafe: true, why: r.why };
    if (r.mode === 'wrapper') return runImpl('sudo', ['-n', r.cmd, ...args], opts);
    return runImpl('sudo', ['-n', FIREWALL_CMD, ...args], opts);   // 옛 설치본(래퍼 없음) — 옛 sudoers 와 1:1
  };
  fwFn.runner = runner;
  /**
   * 래퍼 사전 검사 — 같은 파일을 **권한 없이** --vp-validate-only 로 실행한다(firewall-cmd 를 부르지 않는다 · 기본 존 확인은 실제 실행 때만).
   * @returns {Promise<null|string>} null = 받는다 · 문자열 = 받지 않는 사유(실행하지 못한 경우 포함 — fail-closed)
   */
  fwFn.validate = async (args) => {
    const r = runner();
    if (r.mode !== 'wrapper') return r.mode === 'unsafe' ? (r.detail || '방화벽 래퍼가 안전하지 않습니다') : null;
    const v = await runImpl(r.cmd, ['--vp-validate-only', ...args], { timeoutMs: 5_000 });
    if (v.ok) return null;
    const err = String(v.stderr || '').trim();
    if (v.code === FW_REFUSED_CODE && err.startsWith(FW_REFUSED_TAG)) return err.slice(FW_REFUSED_TAG.length).trim().slice(0, 200) || '형식';
    return `래퍼로 사전 검사를 하지 못했습니다(exit ${v.code})`;
  };
  return fwFn;
}

/** sudo -n <래퍼 | 옛 설치본은 /usr/bin/firewall-cmd> <args> */
export const fw = makeFw();
/** sudo -n systemctl <verb> sshd.service — sudoers 줄과 정확히 같은 인자만. */
export const sshdCtl = (verb) => run('sudo', ['-n', SYSTEMCTL, verb, 'sshd.service']);
/** systemctl is-active sshd (root 불필요) */
export const sshdActive = async () => { const r = await run(SYSTEMCTL, ['is-active', 'sshd.service'], { timeoutMs: 5_000 }); return r.stdout.trim() === 'active'; };

/** sudo 거부(비밀번호 요구/규칙 없음) 판정 — 화면이 정확한 sudoers 줄을 안내한다. */
export function isSudoDenied(r) {
  return !r.ok && /a password is required|not allowed to execute|sudo: .*command not found|sudoers/i.test(r.stderr || '');
}
