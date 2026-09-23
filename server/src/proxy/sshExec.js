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
 * 프롬프트 자동 응답용 PTY 창 크기(v2.530 — **확정된 근본 원인 수정**).
 *
 * ⚠ ssh2 의 `{ pty: true }` 는 **80×24** 를 요청한다. 장비 CLI 는 TTY 폭에 맞춰 출력을 접으므로
 *   80칸을 넘는 줄이 전부 하드랩된다 — 그리고 우리 파서는 **접힌 줄을 읽지 못한다**.
 *   Dell Unity `uemcli` 에서 실측(2026-09-16, 사용자 제공 실제 출력으로 재현):
 *     · `-output csv` : 헤더와 데이터 줄이 같은 지점에서 접혀 `Current allocation` 이
 *       `"29973242855424 (27.2T"` 로 **잘리고**, 접힌 조각이 데이터 줄로 읽혀
 *       **`ID=47%` · 이름 `38 x 3.8T SAS Flash 4` 라는 없는 풀 1개가 만들어졌다.**
 *     · 사용자가 손으로 돌린 넓은 터미널에서는 같은 명령이 멀쩡했다 — 즉 **파서가 아니라
 *       우리가 요청한 터미널 폭이 변수**였다(v2.517 `portperfshow` 줄바꿈과 같은 계열).
 *   v2.525·v2.529 가 CSV 를 1순위로 두고, v2.526 이 평문을 1순위로 두고 **셋 다 실패**한 이유가
 *   이것이다 — 순서는 원인이 아니었다.
 *
 * ⚠ 장비가 요청 폭을 무시할 수 있으므로 이것만 믿지 않는다 — `cliSsh.parseCsv` 가 **줄이 따옴표
 *   안에서 끊겼는지**(접힘의 흔적)를 보고 CSV 를 통째로 거부한다(이중 방어).
 * `rows` 를 크게 두는 것은 페이저가 덜 뜨게 하려는 것이고, 페이저 자동 응답은 그대로 둔다.
 */
const WIDE_PTY = Object.freeze({
  rows: Math.max(24, Number(process.env.SSH_PTY_ROWS) || 200),
  cols: Math.max(80, Number(process.env.SSH_PTY_COLS) || 1000),
  width: 0,
  height: 0,
  term: 'vt100',
});

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
/**
 * ⚠⚠ **`sudo` 비밀번호 프롬프트는 답하지 않고 즉시 중단한다**(v2.543 — 사용자 재현으로 확정).
 *
 * 재현(사용자, 2026-09-17, Unity 10.94.41.237 · 계정 `service`):
 *   `ssh    service@host 'uemcli /stor/config/pool show -detail'` → **정상 출력**
 *   `ssh -tt service@host 'uemcli /stor/config/pool show -detail'` → `[sudo] password for root:` 에서 **정지**
 * 계정·명령·호스트가 같고 **`-tt`(PTY 강제) 하나만** 다른데 증상이 그대로 재현됐다. 그리고 그
 * 프롬프트는 SSH 인증 직후, **출력이 시작되기 전에** 떴다 — 즉 `uemcli` 는 **실행조차 되지 않았다**.
 *
 * ⚠ **여기에 비밀번호를 자동으로 보내지 말 것.** 장비가 묻는 것은 **`root`** 비밀번호인데 우리가
 * 가진 것은 접속 계정(`service`) 비밀번호다. 틀린 값을 매 주기 반복하면 계정이 잠긴다
 * (`util/bulkRun.js` 의 '자동 재시도 금지' 와 같은 이유). 그래서 `answer` 가 아니라 `abort` 다.
 * ⚠ 45초 시한을 기다리지 않는다 — 명령 3개면 135초를 통째로 버린다(실측: 사용자 화면 45.1초 × 3).
 */
export const ABORT_PROMPTS = Object.freeze({
  sudoPassword: {
    re: /\[sudo\]\s*password\s+for\s+\S+\s*:\s*$/i,
    reason: 'sudo 비밀번호를 요구합니다 — PTY 세션에서 계정 환경이 sudo 를 부릅니다.'
      + ' 포탈은 root 비밀번호를 가지고 있지 않고, 틀린 값을 반복하면 계정이 잠기므로 응답하지 않습니다.',
  },
});

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
/**
 * 인증서 블록 — `Remote certificate:` 줄부터 뒤따르는 첫 `[3]` 선택지 줄까지 지운다(v2.598 INJ-06, O(n)).
 * 블록은 실장비에서 수십 줄이다 — `CERT_BLOCK_MAX_LINES` 안에 `[3]` 이 없으면 블록으로 보지 않고 남긴다
 * (예전 정규식은 거리 제한이 없었지만, 수백 줄 떨어진 `[3]` 까지 지우면 데이터를 먹는다).
 */
const CERT_BLOCK_MAX_LINES = 80;
function stripCertBlocks(text) {
  const lines = text.split('\n');
  // 뒤에서부터 '다음 [3] 줄' 위치를 한 번에 계산한다.
  const next3 = new Array(lines.length);
  let nx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*\[3\]/.test(lines[i])) nx = i;
    next3[i] = nx;
  }
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('Remote certificate:')) {
      const j = next3[i];
      if (j >= 0 && j - i <= CERT_BLOCK_MAX_LINES) { i = j; continue; }
    }
    out.push(lines[i]);
  }
  return out.join('\n');
}

export function stripUemcliBanner(text) {
  return String(text || '')
    /*
     * 응답 프롬프트 접두 — 같은 줄에 붙은 데이터는 보존한다.
     *
     * ⚠⚠ **레코드 번호(`1:`)를 먹지 말 것**(v2.544 에 고친 **v2.542 회귀**).
     * 실장비는 프롬프트 줄 **뒤에 이어서** 데이터를 낸다:
     *   `Please input your selection (The default selection is [1]): 1:    ID = pool_2`
     * 여기엔 `1` 이 둘 있다 — 프롬프트의 기본 선택과 **uemcli 출력의 레코드 번호 `1:`**.
     * v2.526 은 `\d*:?` 로 뒤의 `1:` 까지 지웠다. 그때 파서(`parseKeyValueBlocks`)가 `:` 를
     * 키 경계로 읽어 그 줄을 통째로 잃었기 때문이고, **그 시점엔 맞는 규칙이었다**.
     * v2.542 가 파서를 ` = ` 규칙으로 바꾸면서 **레코드 경계를 `^N:` 으로 정했는데** 이 규칙은
     * 그대로 남아, 새 파서가 반드시 필요로 하는 표시를 지우고 있었다.
     * 증상: 명령은 성공(`✓ 성공 3 · 실패 0`)인데 섹션은 `풀 출력을 읽지 못했습니다`.
     * ⚠ 풀이 2개 이상이면 **더 나쁘다** — 프롬프트 줄에 붙는 것은 첫 레코드뿐이라
     *   `2:` 이후만 살아남아 **오류 없이 용량이 과소 보고**된다(실측으로 확인).
     */
    .replace(/^.*Please input your selection[^:]*:[ \t]*/gm, '')
    // 접속 배너
    .replace(/^Storage system (address|port):.*$/gm, '')
    .replace(/^HTTPS connection\s*$/gm, '')
    // 인증서 블록 — `Remote certificate:` 부터 선택지 마지막 줄까지
    // ⚠ v2.598 INJ-06: 예전 `/^Remote certificate:[\s\S]*?^\s*\[3\].../gm` 는 `[3]` 줄이 없는 출력에서
    //   'Remote certificate:' 줄마다 끝까지 훑어 O(n²) 였다(실측 800KB → 7.9초 루프 정지). 줄 단위 O(n) 으로 바꿨다.
    .replace(/[\s\S]*/, stripCertBlocks)
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
/**
 * ⚠⚠ v2.539 — **에코 루프**(사용자 신고 "지금 파싱이 안되, 처음에는 됐었는데"): 프롬프트에 `1\n` 을 쓰면
 * pty 가 그 입력을 **에코**하고, 그 에코가 `data` 이벤트로 돌아온다. 꼬리 400자에는 아직 프롬프트 문구가
 * 남아 있으므로 정규식이 다시 매치 → 또 `1\n` → 또 에코 … 실제 출력이 400자 쌓이기 전까지 자기 자신과
 * 핑퐁하다 `maxAnswers`(400) 에서 `kill()` 했다. 그 결과 uemcli 의 진짜 출력은 오지 않거나 잘렸고,
 * 파서는 배너만 보고 "형식이 예상과 다릅니다" 라고 **원인을 잘못 말했다**(실측: 정규식이 에코 뒤·
 * 실제 출력 120자 뒤에도 매치 — 400자 이후에만 안 매치). 400회 × RTT 가 세션 예산까지 먹었다.
 * 수정: **마지막 응답 이후에 새로 도착한 출력**에서만 프롬프트를 찾는다(`answeredUpTo`). 페이저처럼
 * 프롬프트가 반복해서 *새로* 나오는 경우는 그대로 동작한다.
 */
export function execAnswered(conn, command, {
  timeoutMs = Number(process.env.SSH_EXEC_TIMEOUT_MS) || 60000,
  maxAnswers = Math.max(1, Number(process.env.SSH_PAGER_MAX_PAGES) || 400),
  rules = ['pager'],
  pty = true,
} = {}) {
  const active = rules.map((k) => [k, PROMPT_RULES[k]]).filter(([, r]) => r);
  const clean = (t) => String(t).replace(ANSI_RE, '').replace(/\r/g, '').replace(PAGER_STRIP, '');
  return new Promise((resolve, reject) => {
    conn.exec(command, { pty: pty === true ? WIDE_PTY : pty }, (err, stream) => {
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
      let answeredUpTo = 0; // 마지막으로 응답했을 때의 stdout 길이 — 그 뒤에 온 출력에서만 프롬프트를 찾는다
      stream.on('data', (d) => {
        bytes += d.length;
        if (bytes > EXEC_MAX_OUTPUT) { kill(); return finish(reject, new Error(`SSH exec 출력 상한(${Math.round(EXEC_MAX_OUTPUT / 1024)}KB) 초과: ${command}`)); }
        stdout += d.toString();
        // 꼬리에서만 프롬프트를 본다 — 본문에 같은 문구가 있어도 오응답하지 않게.
        // ⚠ 그리고 **마지막 응답 이후 새로 온 부분**만 본다(위 머리말 — 우리 응답의 에코로 다시 매치하지 않게).
        const tail = stdout.slice(Math.max(answeredUpTo, stdout.length - 400)).replace(ANSI_RE, '');
        // ⚠ 답할 수 없는 프롬프트(sudo)를 만나면 **기다리지 않고** 끝낸다 — 시한까지 매달리면
        //   명령마다 45초를 버리고, 화면에는 '형식 문제' 처럼 보인다(v2.543 실제 사고).
        for (const [k, r] of Object.entries(ABORT_PROMPTS)) {
          if (!r.re.test(tail)) continue;
          kill();
          return finish(resolve, out({ code: null, truncated: true, aborted: k, abortReason: r.reason }));
        }
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
        answeredUpTo = stdout.length;
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
/**
 * ssh2 가 던진 오류가 **자격증명 거부**인가(순수, v2.541).
 *
 * ⚠ 왜 문자열이 아니라 여기서 판정하나: ssh2 의 인증 실패 문구는
 * `All configured authentication methods failed` 하나뿐이고(`ssh2/lib/client.js:863`)
 * 그 객체에 **`level = 'client-authentication'`** 가 붙는다. 영문 문구만 보던 예전
 * 판정(`util/authGuard.js`)은 사이에 `methods` 가 끼어 있어 **매치하지 못했고**, 그래서
 * 자격증명이 틀린 SSH 장비의 주기 수집이 멈추지 않았다(v2.541 에 고친 실제 결함).
 * `level` 은 라이브러리가 직접 붙이는 값이라 문구가 바뀌어도 살아남는다 — 그것을 **먼저** 본다.
 *
 * ⚠ 여기에 협상 실패(`no matching key exchange algorithm`)·타임아웃·`ECONNREFUSED` 를
 * 넣지 말 것 — 일시 장애로 주기 수집을 영구 정지시키게 된다(authGuard 규칙 4).
 * @param {any} err
 */
export function isSshAuthError(err) {
  if (!err) return false;
  if (err.level === 'client-authentication') return true;
  return /all configured authentication methods failed|authentication (?:\w+\s+){0,3}fail/i.test(String(err.message || ''));
}

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
