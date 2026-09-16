/**
 * Small SSH helper built on ssh2: connect, run commands, and upload files via
 * SFTP. Shared by the proxy auto-deploy and the agent auto-deploy features.
 * Returns a structured log so the UI can show what happened on the remote host.
 */

import { Client as SSHClient } from 'ssh2';
import { createRequire } from 'node:module';

/**
 * 구형 장비 호환 알고리즘(v2.421). ssh2 기본 목록은 현대 알고리즘만 켜 두는데, 구형 Fabric OS/iDRAC 등은
 * diffie-hellman-group1-sha1 · ssh-dss · aes-cbc · hmac-sha1-96 만 제공하는 경우가 있어 "no matching key
 * exchange algorithm" 으로 핸드셰이크가 실패한다. 이때 **1회만** 라이브러리가 지원하는 전 목록으로 재시도한다
 * (SSH_LEGACY_FALLBACK=0 으로 끔). 정직한 한계: 이 포탈은 known_hosts 호스트키 검증을 하지 않으므로 알고리즘
 * 하향 자체가 MITM 방어 수준을 낮추는 것은 아니다(원래 없음) — 다만 약한 알고리즘 사용은 추적 로그에 남긴다.
 */
const LEGACY_FALLBACK = process.env.SSH_LEGACY_FALLBACK !== '0';
const LEGACY_ALGOS = (() => {
  try {
    const c = createRequire(import.meta.url)('ssh2/lib/protocol/constants.js'); // 공개 API 가 아니라 방어적으로 로드
    return { kex: c.SUPPORTED_KEX, serverHostKey: c.SUPPORTED_SERVER_HOST_KEY, cipher: c.SUPPORTED_CIPHER, hmac: c.SUPPORTED_MAC };
  } catch { return null; }
})();
const NO_MATCH = /no matching (key exchange|host key|cipher|MAC|compression)|Handshake failed/i;

function connect({ host, port = 22, username, password, privateKey, passphrase, readyTimeout = Number(process.env.SSH_READY_TIMEOUT_MS) || 60000, signal, trace = null, verbose = false, _legacy = false }) {
  const say = (msg, level) => { try { trace?.(msg, level); } catch { /* */ } };
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('SSH 접속 취소(타임아웃)'));
    const conn = new SSHClient();
    const t0 = Date.now();
    say(`SSH 접속 시도 → ${host}:${port} 계정=${username || '(없음)'} 인증=${privateKey ? '개인키' : '비밀번호'}${_legacy ? ' [구형 알고리즘 포함 재시도]' : ''} (readyTimeout ${Math.round(readyTimeout / 1000)}s)`);
    // 취소(signal) — 호출자의 장비당 타임아웃이 접속 대기 중에 만료되면 접속 시도 자체를 끊는다.
    const onAbort = () => { try { conn.end(); } catch { /* */ } say('SSH 접속 취소(호출자 타임아웃)', 'error'); reject(new Error('SSH 접속 취소(타임아웃)')); };
    signal?.addEventListener('abort', onAbort, { once: true });
    conn.on('ready', () => { signal?.removeEventListener('abort', onAbort); say(`SSH 세션 준비 완료(인증 성공) +${Date.now() - t0}ms`); resolve(conn); });
    conn.on('error', (e) => {
      signal?.removeEventListener('abort', onAbort);
      say(`SSH 오류: ${e.message}${e.level ? ` (level=${e.level})` : ''}${e.code ? ` code=${e.code}` : ''} +${Date.now() - t0}ms`, 'error');
      // 구형 알고리즘 폴백 — 협상 실패에만, 1회만.
      if (LEGACY_FALLBACK && LEGACY_ALGOS && !_legacy && NO_MATCH.test(e.message || '')) {
        say('알고리즘 협상 실패 → 구형 알고리즘(diffie-hellman-group1-sha1/ssh-dss/aes-cbc 등)까지 열어 1회 재시도합니다.', 'warn');
        try { conn.end(); } catch { /* */ }
        connect({ host, port, username, password, privateKey, passphrase, readyTimeout, signal, trace, verbose, _legacy: true }).then(resolve, reject);
        return;
      }
      reject(e);
    });
    // 준비(ready) 전에 연결이 닫히면(서버가 핸드셰이크/인증 중 소켓을 끊는 경우 ssh2 는 'error' 없이 'close' 만 낼 수 있다)
    // 반드시 reject 한다 — 안 하면 이 Promise 가 영원히 미결로 남아 호출자가 매달린다(v2.421 CI 에서 실제 발생:
    // 'Promise resolution is still pending but the event loop has already resolved').
    let settled = false;
    conn.once('ready', () => { settled = true; });
    conn.once('error', () => { settled = true; });
    conn.on('close', () => {
      if (trace) say(`SSH 연결 종료 +${Date.now() - t0}ms`, 'debug');
      if (!settled) { settled = true; signal?.removeEventListener('abort', onAbort); reject(new Error('SSH 연결이 준비 전에 닫혔습니다(서버가 세션을 끊음 — 접속 제한/알고리즘/배너 확인)')); }
    });
    if (trace) {
      conn.on('banner', (msg) => say(`서버 배너: ${String(msg).trim().slice(0, 300)}`));
      conn.on('handshake', (n) => say(`핸드셰이크 완료 +${Date.now() - t0}ms — kex=${n?.kex} hostkey=${n?.serverHostKey} cipher=${n?.cs?.cipher} mac=${n?.cs?.mac || '(AEAD)'}`));
    }
    // password 대신 keyboard-interactive 만 허용하는 서버 지원(ssh2는 명시적으로 켜야 시도).
    // 같은 비밀번호로 모든 프롬프트에 응답한다.
    conn.on('keyboard-interactive', (name, instr, lang, prompts, finish) => {
      say(`keyboard-interactive 프롬프트 ${prompts.length}개 — 같은 비밀번호로 응답`, 'debug');
      finish(prompts.map(() => password || ''));
    });
    const auth = { host, port, username, readyTimeout, keepaliveInterval: 15000 };
    if (privateKey) { auth.privateKey = privateKey; if (passphrase) auth.passphrase = passphrase; }
    else { auth.password = password; auth.tryKeyboard = true; }
    if (_legacy) auth.algorithms = LEGACY_ALGOS;
    // '자세히'(ssh -vvv 상당): ssh2 의 debug 콜백은 소켓 연결·ident 교환·KEXINIT·인증 방식 시도·채널 열기까지
    // 프로토콜 단계마다 한 줄씩 남긴다. 비밀번호는 찍히지 않는다(ssh2 가 로그에 넣지 않음).
    if (verbose && trace) auth.debug = (m) => say(`ssh2: ${m}`, 'debug');
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

/**
 * **페이저(--More-- / Type <CR> to continue)로 멈추는 명령**을 자동 응답으로 끝까지 받는다(v2.522).
 *
 * 왜 필요한가: 사용자 현장 계정(`rbash`)에는 비대화형 `errdump` 가 **없고** `errshow` 만 있다
 * (스크린샷으로 확인). `errshow` 는 페이지마다
 *     Type <CR> to continue, Q<CR> to stop:
 * 로 입력을 기다리므로 일반 `exec` 은 시한까지 매달린 뒤 **출력을 버리고** reject 한다 —
 * 그래서 v2.519~2.521 까지 RASLog 는 영영 '확인 불가' 였다.
 *
 * 설계(안전 규칙)
 *  · **응답 횟수에 상한**(`maxPages`). 상한에 닿으면 `q` 를 보내 스스로 끝낸다 — 무한히 개행을
 *    밀어 넣어 세션을 붙잡지 않는다.
 *  · 전체 시한·출력 상한은 일반 exec 과 같다. 다만 시한이 되면 **모아 둔 출력을 살려 돌려준다**
 *    (버리면 이 경로의 존재 이유가 없다). 그때는 `truncated`·`timedOut` 을 켠다.
 *  · 페이저 프롬프트 줄은 출력에서 제거한다(파서가 로그 줄로 오인하지 않게).
 *  · 기본 `pty: true` — 페이저가 붙는 명령은 TTY 를 전제로 도는 경우가 많고, 사용자가 본 출력도
 *    TTY 였다. pty 에서는 ANSI 제어문자가 섞이므로 걸러낸다.
 *
 * ⚠ **실장비로 검증하지 못했다** — 이 환경에 FOS 스위치가 없다. 프롬프트 정규식은 관용적이고,
 *   프롬프트가 한 번도 안 나오면 일반 실행과 같게 끝난다(부작용 없음).
 */
const PAGER_PROMPT = /(--\s*more\s*--|Type\s*<CR>\s*to\s*continue[^\n]*|\(END\)|press\s+any\s+key[^\n]*)\s*$/i;
const PAGER_STRIP = /(--\s*more\s*--|Type\s*<CR>\s*to\s*continue,?\s*Q<CR>\s*to\s*stop:?|\(END\))/gi;
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

/**
 * 대화형 프롬프트 자동 응답 규칙(v2.526 — v2.522 의 페이저 전용 경로를 일반화).
 *
 * 왜 일반화했나: Dell Unity 의 `uemcli` 는 **자체서명 인증서 수락 프롬프트**에서 멈춘다
 * (사용자 제공 실제 출력 2026-09-16: `Would you like to: [1] Accept the certificate for this
 * session / [2] Reject / [3] Accept and store`). 비대화형 `exec` 은 아무도 답하지 않아 배너만
 * 받고 시한까지 매달렸고, 그 배너가 `Key: Value` 로 파싱돼 **알맹이 없는 레코드**가 되어
 * 화면에 '없는 SP' 가 보였다. 페이저와 **같은 메커니즘**이므로 규칙 표로 합쳤다.
 *
 * ⚠ **`[3] Accept and store` 를 쓰지 않는다** — 장비에 인증서를 저장하는 **상태 변경**이다.
 *   포탈은 남의 장비 상태를 바꾸지 않는다(v2.519 `portstatsclear` 금지와 같은 판단).
 *   항상 `1`(이 세션만 수락)로 답한다.
 * ⚠ 응답 횟수 상한(`maxAnswers`)을 지우지 말 것 — 예상 못 한 프롬프트 루프가 세션을
 *   무한히 붙잡는다. 상한에 걸리면 `truncated` 로 **밝힌다**(조용한 절단 금지).
 * ⚠ 규칙에 없는 프롬프트(예: 계정/비밀번호 요구)가 나오면 답하지 않고 시한까지 기다렸다가
 *   **모아 둔 출력을 살려** 돌려준다 — 그 출력이 '무엇을 더 물었는지' 를 화면이 보여주는 근거다.
 */
export const PROMPT_RULES = Object.freeze({
  pager: { re: PAGER_PROMPT, answer: '\n', capAnswer: 'q\n' },
  // uemcli 인증서 수락. 꼬리에서만 본다 — 선택지 블록이거나 실제 입력 프롬프트일 때.
  // ⚠ 두 형태를 **둘 다** 받는다: 선택지가 먼저 오고 `Please input your selection …` 이 뒤따르는데,
  //   데이터가 그 프롬프트와 **같은 줄에 이어 붙어** 오므로(실측) 어느 쪽에 걸려도 답해야 한다.
  certAccept: {
    re: /(\[1\][^\n]*Accept the certificate[\s\S]{0,300}|Please input your selection[^\n]*)\s*$/i,
    answer: '1\n',
    capAnswer: null,
  },
});

/**
 * uemcli 배너·인증서 블록 제거(v2.526).
 *
 * ⚠ **응답 프롬프트와 첫 데이터가 같은 줄에 붙어 나온다**(사용자 제공 실측 2026-09-16):
 *   `Please input your selection (The default selection is [1]): 1:    System name  = DE411224865949`
 *   이걸 그대로 두면 `parseKeyValueBlocks` 가 **앞쪽 `:` 를 키 경계로 읽어** 그 줄을 통째로 잃는다
 *   (첫 레코드가 시스템 이름·모델인데 그게 사라진다). 프롬프트 접두만 잘라내고 뒤는 남긴다.
 * ⚠ 배너(`Storage system address:` · `Remote certificate:` 블록)도 지운다 — 남겨 두면
 *   `Issuer: CN=…` 같은 줄이 **알맹이 없는 레코드**가 되어 '없는 장비' 로 보인다(v2.525 실제 사고).
 */
export function stripUemcliBanner(text) {
  return String(text || '')
    // 응답 프롬프트 접두 — 같은 줄에 붙은 데이터는 보존한다.
    .replace(/^.*Please input your selection[^:]*:\s*\d*:?\s*/gm, '')
    // 접속 배너
    .replace(/^Storage system (address|port):.*$/gm, '')
    .replace(/^HTTPS connection\s*$/gm, '')
    // 인증서 블록 — `Remote certificate:` 부터 선택지 마지막 줄까지
    .replace(/^Remote certificate:[\s\S]*?^\s*\[3\][^\n]*\n?/gm, '')
    .replace(/^(Issuer|Subject|Valid from|Valid to|Serial|Id):[^\n]*\n?/gm, '')
    .replace(/^Would you like to:\s*\n?/gm, '')
    .replace(/^\s*\[[123]\][^\n]*\n?/gm, '');
}

/**
 * 프롬프트 자동 응답 실행. `rules` 는 `PROMPT_RULES` 의 키 배열(앞에서부터 먼저 검사).
 * 반환: `{ command, code, stdout, stderr, pages, answers, truncated, timedOut }`
 *  · `pages`  — 페이저 응답 횟수(v2.522 호환).
 *  · `answers`— 규칙별 응답 횟수(`{pager, certAccept}`) — 화면이 '인증서를 자동 수락했다' 를 말한다.
 */
function execAnswered(conn, command, {
  timeoutMs = Number(process.env.SSH_EXEC_TIMEOUT_MS) || 60000,
  maxAnswers = Math.max(1, Number(process.env.SSH_PAGER_MAX_PAGES) || 400),
  rules = ['pager'],
  pty = true,
} = {}) {
  const active = rules.map((k) => [k, PROMPT_RULES[k]]).filter(([, r]) => r);
  const clean = (t) => String(t).replace(ANSI_RE, '').replace(/\r/g, '').replace(PAGER_STRIP, '');
  return new Promise((resolve, reject) => {
    conn.exec(command, { pty }, (err, stream) => {
      if (err) return reject(err);
      let stdout = ''; let stderr = ''; let done = false; let bytes = 0; let total = 0; let truncated = false;
      const answers = {};
      for (const [k] of active) answers[k] = 0;
      const out = (extra) => ({ command, stdout: clean(stdout), stderr, pages: answers.pager || 0, answers, truncated, ...extra });
      const finish = (fn, arg) => { if (done) return; done = true; clearTimeout(timer); fn(arg); };
      const kill = () => { try { stream.close?.(); } catch { /* */ } try { stream.destroy?.(); } catch { /* */ } };
      const timer = setTimeout(() => {
        kill();
        // 시한이 되면 모아 둔 출력을 **살려** 돌려준다(일반 exec 은 버린다 — 그러면 이 경로의 존재 이유가 없다).
        truncated = true;
        finish(resolve, out({ code: null, truncated: true, timedOut: true }));
      }, Math.max(1000, timeoutMs));
      timer.unref?.();
      stream.on('data', (d) => {
        bytes += d.length;
        if (bytes > EXEC_MAX_OUTPUT) { kill(); return finish(reject, new Error(`SSH exec 출력 상한(${Math.round(EXEC_MAX_OUTPUT / 1024)}KB) 초과: ${command}`)); }
        stdout += d.toString();
        // 꼬리에서만 프롬프트를 본다 — 본문에 같은 문구가 있어도 오응답하지 않게.
        const tail = stdout.slice(-400).replace(ANSI_RE, '');
        const hit = active.find(([, r]) => r.re.test(tail));
        if (!hit) return;
        const [key, rule] = hit;
        if (total >= maxAnswers) {
          truncated = true;
          if (rule.capAnswer) {
            try { stream.write(rule.capAnswer); } catch { /* */ }
            const t2 = setTimeout(() => { kill(); finish(resolve, out({ code: null, truncated: true })); }, 300);
            t2.unref?.();
            return;
          }
          kill();
          return finish(resolve, out({ code: null, truncated: true }));
        }
        total += 1; answers[key] += 1;
        try { stream.write(rule.answer); } catch { /* */ }
      });
      stream.stderr.on('data', (d) => { stderr += d.toString(); });
      stream.on('error', (e) => finish(reject, e));
      stream.stderr.on('error', () => { /* 비치명 */ });
      stream.on('close', (code) => finish(resolve, out({ code })));
    });
  });
}

/** 페이저 전용(v2.522 호환) — `maxPages` 이름을 그대로 받는다. */
function execPaged(conn, command, { maxPages, ...rest } = {}) {
  return execAnswered(conn, command, { ...rest, maxAnswers: maxPages, rules: ['pager'] });
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
  const trace = typeof creds?.trace === 'function' ? creds.trace : null;
  const say = (m, lv) => { try { trace?.(m, lv); } catch { /* */ } };
  const traced = async (label, cmd, run) => {
    const t0 = Date.now();
    say(`실행: ${cmd}`);
    try {
      const r = await run();
      say(`완료(${label}): exit=${r.code ?? '—'} stdout ${Buffer.byteLength(r.stdout || '')}B stderr ${Buffer.byteLength(r.stderr || '')}B +${Date.now() - t0}ms${r.captured ? ' [캡처 종료]' : ''}`);
      return r;
    } catch (e) { say(`실패(${label}): ${e.message} +${Date.now() - t0}ms`, 'error'); throw e; }
  };
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
    exec: async (cmd, timeoutMs) => { const r = await (trace ? traced('exec', cmd, () => exec(conn, cmd, timeoutMs)) : exec(conn, cmd, timeoutMs)); log.push(r); return r; },
    // 스스로 끝나지 않는 갱신형 명령(portperfshow 등) 전용 — captureMs 만큼 모으고 채널을 닫는다.
    execCapture: async (cmd, captureMs) => { const r = await (trace ? traced('capture', cmd, () => execCapture(conn, cmd, captureMs)) : execCapture(conn, cmd, captureMs)); log.push(r); return r; },
    // 페이저로 멈추는 명령(errshow 등) — 프롬프트에 자동 응답해 끝까지 받는다(상한·시한 있음).
    execPaged: async (cmd, opts) => { const r = await (trace ? traced('paged', cmd, () => execPaged(conn, cmd, opts)) : execPaged(conn, cmd, opts)); log.push(r); return r; },
    // 대화형 프롬프트 자동 응답(v2.526) — `rules:['certAccept','pager']` 처럼 규칙을 고른다.
    // uemcli 인증서 수락처럼 **페이저가 아닌** 프롬프트를 다루는 유일한 경로다.
    execAnswered: async (cmd, opts) => { const r = await (trace ? traced('answered', cmd, () => execAnswered(conn, cmd, opts)) : execAnswered(conn, cmd, opts)); log.push(r); return r; },
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
