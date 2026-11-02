/**
 * bareos/console.js — Bareos Director **콘솔 프로토콜** 클라이언트(Node 표준 net/tls/crypto 만 — 의존성 0).
 *
 * 무엇을 옮겼나: python-bareos(`bsock/lowlevel.py`·`directorconsole.py`·`directorconsolejson.py`)와 Director C++ 원본
 * (`dird/socket_server.cc`·`lib/cram_md5.cc`·`lib/hello.cc`·`dird/ua_server.cc`)에서 확인한 순서다.
 *   1) TCP 9101 접속 → (기본) **TLS-PSK** 핸드셰이크. identity = `R_CONSOLE` + 0x1E + 콘솔 이름, PSK = 비밀번호 MD5 16진 문자열.
 *   2) 프레임: 4바이트 big-endian int32 길이 + 본문. 길이 ≤ 0 은 신호(BNET_*).
 *   3) `Hello <이름(공백→0x01)> calling version 25.0.0 Version="25.0.0"` — Director 는 18.2 미만 콘솔을 거부한다(hello.cc).
 *   4) CRAM-MD5 양방향: Director 챌린지에 응답 → `1000 OK auth` 확인 → **우리도 Director 에 챌린지**(같은 비밀번호를
 *      아는지 확인 — 가짜 Director 에게 명령을 보내지 않는다) → `1000 OK: …`(인증) → `1002 …`(안내 메시지).
 *   5) `.api json` · `.api json compact=yes` — 이후 명령 1개 = JSON-RPC 응답 1개. API 모드에서 Director 는 명령 끝에 EOD 대신
 *      다음 입력을 기다리며 **BNET_MAIN_PROMPT(-18)** 를 보낸다(ua_server.cc) — 그 신호까지가 한 응답이다.
 *
 * 안전 규칙(server/CLAUDE.md):
 *  - 접속 주소는 `lookup: ssrfLookup`(DNS 리바인딩 차단) + IP 리터럴은 `ipBlockReason` 동기 검사(리터럴은 lookup 을 타지 않는다).
 *  - 시한은 **절대 시한**(소켓 유휴 시한 아님 — 상대가 조금씩 계속 보내도 끊는다, relaycheck v2.607 교훈) · 프레임·응답 크기 상한.
 *  - 비밀번호·CRAM 응답·PSK 는 오류 문구·로그에 싣지 않는다. 오류는 `BareosConsoleError(code)` 하나로 분류한다.
 *  - TLS 를 끄는 경로(`tls: 'none'`)는 테스트·probe CLI 의 명시 옵션뿐이다 — 포탈 설정에는 두지 않는다(평문 하향 금지).
 */
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { ssrfLookup, pinnedLookup } from '../util/ssrfLookup.js';
import { ipBlockReason } from '../util/ssrfBlock.js';
import { cramResponse, passwordMd5Hex } from './base64.js';
import { configurePermission, CONFIGURE_FIX_TEXT } from './configurePerm.js';

/** Director 신호(core/src/lib/bsock.h — python-bareos constants.py 와 같은 값). */
export const BNET = Object.freeze({
  EOD: -1, EOD_POLL: -2, STATUS: -3, TERMINATE: -4, POLL: -5, HEARTBEAT: -6, HB_RESPONSE: -7,
  MSGS_PENDING: -17, MAIN_PROMPT: -18, SUB_PROMPT: -27,
});
const END_SIGNALS = new Set([BNET.EOD, BNET.TERMINATE, BNET.MAIN_PROMPT, BNET.SUB_PROMPT]);

/** Director 가 받아들이는 콘솔 버전(≥ 18.2). bconsole 의 인사 형식을 그대로 쓴다. */
export const CONSOLE_VERSION = '25.0.0';
export const DEFAULT_PORT = 9101;
export const DEFAULT_TIMEOUT_MS = 15_000;
/** 프레임 1개 상한 — Director 의 한 메시지는 수 KB~수백 KB 다. 이보다 크면 프로토콜이 어긋난 것으로 본다. */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;
/** 명령 하나가 요청할 수 있는 응답 상한의 끝(설정 maxResponseBytes 의 상한과 같다). */
export const HARD_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
/** 읽지 않고 쌓인 프레임 수 상한 — 신호 프레임(4바이트)은 바이트 상한에 거의 안 잡힌다(v2.822.3 P8). */
export const MAX_QUEUED_FRAMES = 100_000;
/** 명령 1개 응답 상한(기본) — 작업 로그·목록은 호출부가 limit 으로 줄인다. */
export const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * TLS-PSK 암호군. TLS 1.3 은 SHA-256 계열을 앞에 둔다(구식 PSK 콜백은 SHA-256 세션을 만든다 — OpenSSL 규칙).
 * TLS 1.2 PSK 암호군은 OpenSSL 기본 목록에 없어 이름으로 넣어야 한다(Node 문서 'Pre-shared keys').
 */
export const PSK_CIPHERS = [
  'TLS_AES_128_GCM_SHA256', 'TLS_CHACHA20_POLY1305_SHA256', 'TLS_AES_256_GCM_SHA384',
  'ECDHE-PSK-CHACHA20-POLY1305', 'ECDHE-PSK-AES256-CBC-SHA384', 'ECDHE-PSK-AES128-CBC-SHA256',
  'DHE-PSK-AES256-GCM-SHA384', 'DHE-PSK-CHACHA20-POLY1305', 'DHE-PSK-AES128-GCM-SHA256',
  'PSK-AES256-GCM-SHA384', 'PSK-CHACHA20-POLY1305', 'PSK-AES128-GCM-SHA256',
].join(':');

/** 콘솔 이름: Director 리소스 이름 문자 + 기본 콘솔 `*UserAgent*`. 인사 메시지가 `%127s` 로 읽으므로 127자 이하. */
const CONSOLE_NAME_RE = /^[A-Za-z0-9 ._:*-]{1,127}$/;
/** 호스트: 이름·IPv4·IPv6(대괄호 없이). 스킴·경로·계정 금지. */
const HOST_RE = /^[A-Za-z0-9.:-]{1,253}$/;

export class BareosConsoleError extends Error {
  /**
   * @param {'invalid'|'blocked'|'connect'|'tls'|'auth'|'pam'|'timeout'|'protocol'|'too-large'|'closed'|'jsonrpc'|'aborted'} code
   * @param {string} message 사람이 읽는 사유(비밀 없음)
   * @param {object} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'BareosConsoleError';
    this.code = code;
    Object.assign(this, extra);
  }
}
const err = (code, msg, extra) => new BareosConsoleError(code, msg, extra);

/** 공백을 0x01 로 — Bareos 의 'bash' (인사 메시지는 공백으로 필드를 나눈다). */
export const bashName = (name) => String(name).replace(/ /g, '\x01');

/** 접속 옵션 정규화·검증(순수). 오류면 BareosConsoleError('invalid'). */
export function normalizeConsoleOptions(o = {}) {
  const host = String(o.host ?? '').trim();
  if (!HOST_RE.test(host)) throw err('invalid', 'Director 주소 형식이 올바르지 않습니다(호스트 이름 또는 IP 만 — 스킴·경로 없이).');
  const port = o.port === undefined || o.port === null || o.port === '' ? DEFAULT_PORT : Number(o.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw err('invalid', 'Director 포트가 올바르지 않습니다(1~65535).');
  const name = String(o.name ?? '').trim();
  if (!CONSOLE_NAME_RE.test(name)) throw err('invalid', '콘솔 이름이 올바르지 않습니다(영문·숫자·공백·._:*- 127자 이하).');
  if (typeof o.password !== 'string' || !o.password) throw err('invalid', '콘솔 비밀번호가 없습니다.');
  const t = Number(o.timeoutMs);
  const timeoutMs = Number.isFinite(t) && t > 0 ? Math.min(120_000, Math.max(1_000, Math.round(t))) : DEFAULT_TIMEOUT_MS;
  const tlsMode = o.tls === 'none' ? 'none' : 'psk';
  const tlsMaxVersion = o.tlsMaxVersion === 'TLSv1.2' ? 'TLSv1.2' : 'TLSv1.3';
  const m = Number(o.maxResponseBytes);
  const maxResponseBytes = Number.isFinite(m) && m > 0 ? Math.min(HARD_MAX_RESPONSE_BYTES, Math.round(m)) : DEFAULT_MAX_RESPONSE_BYTES;
  return { host, port, name, password: o.password, timeoutMs, tls: tlsMode, tlsMaxVersion, maxResponseBytes };
}

/** JSON-RPC 오류 객체 → 사람이 읽는 한 줄(Director 의 messages.error 를 우선). */
export function jsonRpcErrorText(e) {
  const msgs = e?.data?.messages?.error;
  const list = Array.isArray(msgs) ? msgs.map((s) => String(s).trim()).filter(Boolean) : [];
  const head = list.length ? list.join(' / ') : String(e?.message || 'failed');
  return head.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').slice(0, 600);
}

/**
 * 연결된 콘솔 세션. 명령은 한 번에 하나(내부 직렬화). 응답은 MAIN_PROMPT/EOD 신호까지.
 */
export class BareosSession {
  constructor(sock, opts) {
    this.sock = sock;
    this.opts = opts;
    this.closed = false;
    this.info = { tls: null, banner: '', infoMessage: '' };
    this._chunks = []; this._len = 0; this._need = null;
    this._frames = []; this._queuedBytes = 0; this._waiter = null; this._fatal = null;
    this._callMax = 0;   // 지금 명령이 요청한 응답 상한(callRaw — 기본값보다 크게 요청할 수 있다)
    this._queue = Promise.resolve();
    sock.on('data', (d) => this._onData(d));
    sock.on('error', (e) => this._fail(err('closed', `Director 연결 오류: ${e?.code || e?.message || e}`)));
    sock.on('close', () => this._fail(err('closed', 'Director 가 연결을 닫았습니다.')));
  }

  _onData(d) {
    if (this._fatal) return;
    this._chunks.push(d); this._len += d.length;
    // 읽지 않고 쌓인 양도 상한 — 명령 사이에 상대가 계속 보내면 메모리가 무한히 늘지 않게.
    //   v2.822.3(P8): 쌓인 바이트는 누적 카운터로 센다(예전에는 청크마다 전부 다시 더해 프레임 수의 제곱 시간이었다).
    const cap = Math.max(this.opts.maxResponseBytes, this._callMax);
    if (this._len + this._queuedBytes > cap + MAX_FRAME_BYTES) {
      this._fail(err('too-large', 'Director 응답이 상한을 넘었습니다.'));
      return;
    }
    this._parse();
  }

  _take(n) {
    const out = Buffer.allocUnsafe(n);
    let off = 0;
    while (off < n) {
      const c = this._chunks[0];
      const k = Math.min(c.length, n - off);
      c.copy(out, off, 0, k);
      off += k;
      if (k === c.length) this._chunks.shift(); else this._chunks[0] = c.subarray(k);
    }
    this._len -= n;
    return out;
  }

  _parse() {
    for (;;) {
      if (this._need === null) {
        if (this._len < 4) return;
        const h = this._take(4).readInt32BE(0);
        if (h < 0) { this._emit({ sig: h }); continue; }
        if (h === 0) continue; // 빈 프레임 — 무시
        if (h > MAX_FRAME_BYTES) { this._fail(err('protocol', `프레임 길이가 비정상입니다(${h}바이트).`)); return; }
        this._need = h;
      }
      if (this._len < this._need) return;
      const body = this._take(this._need);
      this._need = null;
      this._emit({ data: body });
    }
  }

  _emit(f) {
    if (this._waiter) { const w = this._waiter; this._waiter = null; w.resolve(f); return; }
    if (this._frames.length >= MAX_QUEUED_FRAMES) { this._fail(err('too-large', 'Director 가 읽지 않은 응답 조각을 너무 많이 보냈습니다.')); return; }
    this._frames.push(f);
    this._queuedBytes += f.data ? f.data.length : 0;
  }

  _fail(e) {
    if (this._fatal) return;
    this._fatal = e;
    this.closed = true;
    if (this._waiter) { const w = this._waiter; this._waiter = null; w.reject(e); }
    try { this.sock.destroy(); } catch { /* */ }
  }

  /** 다음 프레임(절대 시한). */
  _next(deadlineAt) {
    if (this._frames.length) {
      const f = this._frames.shift();
      this._queuedBytes -= f.data ? f.data.length : 0;
      return Promise.resolve(f);
    }
    if (this._fatal) return Promise.reject(this._fatal);
    return new Promise((resolve, reject) => {
      const left = deadlineAt - Date.now();
      if (left <= 0) { this._fail(err('timeout', 'Director 응답 시한을 넘겼습니다.')); reject(this._fatal); return; }
      const t = setTimeout(() => { this._fail(err('timeout', `Director 응답 시한(${Math.round(this.opts.timeoutMs / 1000)}초)을 넘겼습니다.`)); }, left);
      this._waiter = {
        resolve: (f) => { clearTimeout(t); resolve(f); },
        reject: (e) => { clearTimeout(t); reject(e); },
      };
    });
  }

  _send(buf) {
    if (this._fatal) throw this._fatal;
    const head = Buffer.allocUnsafe(4);
    head.writeInt32BE(buf.length, 0);
    this.sock.write(Buffer.concat([head, buf]));
  }

  _sendSignal(code) {
    if (this._fatal) return;
    const head = Buffer.allocUnsafe(4);
    head.writeInt32BE(code, 0);
    try { this.sock.write(head); } catch { /* */ }
  }

  /** 인증 단계의 데이터 프레임 1개를 문자열로(신호는 사유별로 오류). */
  async _authText(deadlineAt, what) {
    for (;;) {
      const f = await this._next(deadlineAt);
      if (f.data) return f.data.toString('utf8').replace(/\0+$/, '');
      if (f.sig === BNET.TERMINATE) throw err('auth', `Director 가 ${what} 단계에서 연결을 끊었습니다(콘솔 이름·비밀번호·접속 허용을 확인하세요).`);
      // 그 밖의 신호는 건너뛴다
    }
  }

  /** 인증(4·5단계). 성공하면 info.banner·infoMessage 를 채운다. */
  async _authenticate(name, md5hex, deadlineAt) {
    const bashed = bashName(name);
    this._send(Buffer.from(`Hello ${bashed} calling version ${CONSOLE_VERSION} Version="${CONSOLE_VERSION}"\n`, 'utf8'));
    // ① Director 의 챌린지
    const chalMsg = await this._authText(deadlineAt, '인사');
    if (/^1999 /.test(chalMsg)) throw err('auth', 'Director 가 이 콘솔을 거부했습니다(등록되지 않은 콘솔 이름이거나 접속이 허용되지 않음).');
    const m = /^auth cram-md5c? (\S+)(?: ssl=(\d+))?/.exec(chalMsg);
    if (!m) throw err('protocol', 'Director 인증 챌린지 형식을 알 수 없습니다.');
    const dirChal = m[1];
    const mine = cramResponse(dirChal, md5hex);
    this._send(Buffer.from(mine.plain, 'ascii')); // python-bareos 와 같이 비호환(Bareos) 변형 — Director 는 두 변형을 다 받는다
    const ok1 = await this._authText(deadlineAt, '비밀번호 확인');
    if (ok1 !== '1000 OK auth\n' && ok1 !== '1000 OK auth') throw err('auth', 'Director 가 비밀번호를 거부했습니다(콘솔 비밀번호를 확인하세요).');
    // ② 우리 챌린지 — Director 도 같은 비밀번호를 아는지 확인(가짜 Director 에 명령을 보내지 않는다)
    const rand = crypto.randomInt(1_000_000_000, 2_147_483_647);
    const myChal = `<${rand}.${Math.floor(Date.now() / 1000)}@${bashed}>`;
    this._send(Buffer.from(`auth cram-md5 ${myChal} ssl=0\n`, 'utf8'));
    const theirs = (await this._authText(deadlineAt, 'Director 확인')).trim();
    const want = cramResponse(myChal, md5hex);
    const a = Buffer.from(theirs, 'utf8');
    const same = (s) => { const b = Buffer.from(s, 'utf8'); return a.length === b.length && crypto.timingSafeEqual(a, b); };
    if (!same(want.plain) && !same(want.compatible)) {
      this._send(Buffer.from('1999 Authorization failed.\n', 'ascii'));
      throw err('auth', 'Director 의 응답이 비밀번호와 맞지 않습니다 — 접속한 상대가 등록한 Director 가 아닐 수 있습니다.');
    }
    this._send(Buffer.from('1000 OK auth\n', 'ascii'));
    // ③ 1000 OK(인증) → 1002(안내)
    const res = await this._authText(deadlineAt, '인증 결과');
    const rm = /^(\d{4})[ \x1e]?([\s\S]*)$/.exec(res);
    const code = rm ? Number(rm[1]) : 0;
    if (code === 1001) throw err('pam', '이 콘솔은 PAM 로그인을 요구합니다 — 포탈은 PAM 콘솔을 지원하지 않습니다(PAM 을 쓰지 않는 전용 콘솔을 만드세요).');
    if (code !== 1000) throw err('auth', `Director 인증 결과를 받지 못했습니다(코드 ${code || '없음'}).`);
    this.info.banner = (rm[2] || '').trim().slice(0, 300);
    const info = await this._authText(deadlineAt, '안내 메시지');
    const im = /^(\d{4})[ \x1e]?([\s\S]*)$/.exec(info);
    if (!im || Number(im[1]) !== 1002) throw err('protocol', 'Director 안내 메시지(1002)를 받지 못했습니다.');
    this.info.infoMessage = (im[2] || '').trim().slice(0, 300);
  }

  /**
   * 명령 1개 → 응답 원문(문자열). 응답 끝 = END 신호(MAIN_PROMPT·EOD·SUB_PROMPT·TERMINATE).
   * @param {string} cmd
   * @param {{ timeoutMs?: number, maxBytes?: number }} [o]
   */
  callRaw(cmd, o = {}) {
    const run = async () => {
      if (this._fatal) throw this._fatal;
      const text = String(cmd);
      if (/[\r\n\0]/.test(text)) throw err('invalid', '명령에 줄바꿈·NUL 을 넣을 수 없습니다.');
      const t = Number(o.timeoutMs);
      const deadlineAt = Date.now() + (Number.isFinite(t) && t > 0 ? t : this.opts.timeoutMs);
      // v2.822.3(C2-8): 명령이 요청한 상한을 그대로 쓴다(최대 HARD_MAX) — 예전에는 세션 기본값 8MB 와 작은 쪽이라 16MB 요청이 8MB 였다.
      const max = Number(o.maxBytes) > 0 ? Math.min(HARD_MAX_RESPONSE_BYTES, Number(o.maxBytes)) : this.opts.maxResponseBytes;
      this._callMax = max;
      try {
        this._send(Buffer.from(text, 'utf8'));
        const parts = []; let total = 0;
        for (;;) {
          const f = await this._next(deadlineAt);
          if (f.sig !== undefined) {
            if (END_SIGNALS.has(f.sig)) {
              if (f.sig === BNET.TERMINATE) { this.closed = true; }
              break;
            }
            continue; // MSGS_PENDING·HEARTBEAT 등
          }
          total += f.data.length;
          if (total > max) { this._fail(err('too-large', `Director 응답이 상한(${Math.round(max / 1024)}KB)을 넘었습니다.`)); throw this._fatal; }
          parts.push(f.data);
        }
        return Buffer.concat(parts).toString('utf8');
      } finally { this._callMax = 0; }
    };
    const p = this._queue.then(run, run);
    this._queue = p.catch(() => {});
    return p;
  }

  /**
   * JSON 모드 명령 → JSON-RPC `result`. 오류 객체면 BareosConsoleError('jsonrpc').
   * 빈 응답이면 null.
   */
  async call(cmd, o = {}) {
    const raw = (await this.callRaw(cmd, o)).trim();
    if (!raw) return null;
    let j;
    try { j = JSON.parse(raw); } catch {
      throw err('protocol', 'Director 응답이 JSON 이 아닙니다(API 모드 전환 실패 또는 JSON 을 지원하지 않는 명령).', { rawHead: raw.slice(0, 200) });
    }
    if (j && typeof j === 'object' && j.error) throw err('jsonrpc', jsonRpcErrorText(j.error), { rpc: j.error });
    if (j && typeof j === 'object' && 'result' in j) return j.result;
    throw err('protocol', 'Director 응답에 result·error 가 없습니다.');
  }

  /** 정상 종료 — BNET_TERMINATE 를 보내고 닫는다. 여러 번 불러도 된다. */
  close() {
    if (this.closed) { try { this.sock.destroy(); } catch { /* */ } return; }
    this.closed = true;
    this._sendSignal(BNET.TERMINATE);
    try { this.sock.end(); } catch { /* */ }
    setTimeout(() => { try { this.sock.destroy(); } catch { /* */ } }, 1_000).unref?.();
  }
}

/**
 * SSRF 차단 코드 — util/ssrfLookup.js 는 'ESSRFBLOCKED' 를 쓴다(v2.822: 예전에는 'ESSRF' 만 봐서 이름이 차단 주소로 풀리면
 * 'blocked' 가 아니라 'connect' 로 분류됐다 — 문구만 맞고 코드가 틀렸다).
 */
const blockedCode = (c) => c === 'ESSRFBLOCKED' || c === 'ESSRF';

/** TCP 접속(절대 시한). */
function connectTcp(host, port, deadlineAt, lookup, signal) {
  return new Promise((resolve, reject) => {
    let done = false;
    const sock = net.connect({ host, port, lookup });
    const fin = (e) => {
      if (done) return; done = true; clearTimeout(t); signal?.removeEventListener?.('abort', onAbort);
      if (e) { try { sock.destroy(); } catch { /* */ } reject(e); } else resolve(sock);
    };
    const onAbort = () => fin(err('aborted', '요청이 취소됐습니다.'));
    const t = setTimeout(() => fin(err('timeout', 'Director TCP 연결 시한을 넘겼습니다.')), Math.max(1, deadlineAt - Date.now()));
    signal?.addEventListener?.('abort', onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    sock.once('connect', () => fin(null));
    sock.once('error', (e) => {
      const c = e?.code || '';
      const blocked = blockedCode(c) || /SSRF|차단/.test(e?.message || '');
      const why = c === 'ECONNREFUSED' ? '연결 거부(포트가 닫혀 있거나 Director 가 꺼져 있음)'
        : c === 'ENOTFOUND' || c === 'EAI_AGAIN' ? '이름 해석 실패'
          : /EHOSTUNREACH|ENETUNREACH/.test(c) ? '네트워크 도달 불가'
            : blocked ? '접속이 차단된 대역(링크로컬·루프백 등)으로 해석되는 주소입니다' : (c || e?.message || '알 수 없는 오류');
      // v2.822(S4 — 재현): 차단 문구에 ssrfLookup 원문(Director 호스트 이름·해석 결과)을 싣지 않는다 — 이 문구는 lastError 로 범위 계정 목록에도 간다.
      fin(err(blocked ? 'blocked' : 'connect', `Director 에 연결하지 못했습니다: ${why}`));
    });
  });
}

/** TLS-PSK 래핑(절대 시한). */
function wrapPsk(raw, { name, md5hex, tlsMaxVersion }, deadlineAt, signal = null) {
  return new Promise((resolve, reject) => {
    let done = false;
    const identity = `R_CONSOLE\x1e${name}`;
    const psk = Buffer.from(md5hex, 'ascii');
    const sock = tls.connect({
      socket: raw,
      pskCallback: () => ({ psk, identity }),
      ciphers: PSK_CIPHERS,
      minVersion: 'TLSv1.2',
      maxVersion: tlsMaxVersion,
      checkServerIdentity: () => undefined, // 인증서가 없다 — 상대 확인은 PSK(같은 비밀) + CRAM-MD5 역챌린지가 한다
    });
    const fin = (e) => {
      if (done) return; done = true; clearTimeout(t); signal?.removeEventListener?.('abort', onAbort);
      if (e) { try { sock.destroy(); } catch { /* */ } reject(e); } else resolve(sock);
    };
    // v2.822: 핸드셰이크 중에도 취소를 받는다(예전에는 TCP·세션 단계만 받아 이 구간의 취소가 시한까지 매달렸다)
    const onAbort = () => fin(err('aborted', '요청이 취소됐습니다.'));
    const t = setTimeout(() => fin(err('timeout', 'Director TLS-PSK 핸드셰이크 시한을 넘겼습니다.')), Math.max(1, deadlineAt - Date.now()));
    signal?.addEventListener?.('abort', onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    sock.once('secureConnect', () => fin(null));
    // v2.822(C7 — 재현): TLS 경보(ERR_SSL_*)만 'tls'(=자격 불일치 — 주기 조회를 멈춘다). 핸드셰이크 중 ECONNRESET 같은 소켓 끊김은
    //   일시적일 수 있어 'closed' 로 둔다 — 예전에는 둘 다 'tls' 라 한 번의 끊김이 인증 정지를 파일로 남기고 주기 조회를 멈췄다.
    sock.once('error', (e) => {
      const c = String(e?.code || e?.message || e).slice(0, 160);
      if (/^ERR_SSL/.test(String(e?.code || ''))) fin(err('tls', `TLS-PSK 핸드셰이크 실패: ${c} — 콘솔 이름·비밀번호가 맞는지, Director 의 TLS 설정을 확인하세요.`));
      else fin(err('closed', `TLS-PSK 핸드셰이크 중 연결이 끊겼습니다(${c}) — 일시적 끊김이거나 Director 가 TLS-PSK 를 받지 않는 설정일 수 있습니다.`));
    });
  });
}

/**
 * Director 에 접속·인증하고 JSON 모드로 전환한 세션을 돌려준다.
 * @param {object} opts  host·port·name·password·timeoutMs·tls('psk'|'none')·tlsMaxVersion·maxResponseBytes
 * @param {object} [deps] 테스트 주입: lookup(기본 ssrfLookup)·blockReason(기본 ipBlockReason)·signal(AbortSignal)
 * @returns {Promise<BareosSession>}
 */
export async function openConsole(opts, { lookup = ssrfLookup, blockReason = ipBlockReason, signal = null } = {}) {
  const o = normalizeConsoleOptions(opts);
  const why = blockReason(o.host);
  if (why) throw err('blocked', `접속이 차단된 Director 주소입니다: ${why}`);
  const deadlineAt = Date.now() + o.timeoutMs;
  const md5hex = passwordMd5Hex(o.password);
  const raw = await connectTcp(o.host, o.port, deadlineAt, lookup, signal);
  let sock = raw;
  let tlsInfo = null;
  if (o.tls === 'psk') {
    sock = await wrapPsk(raw, { name: o.name, md5hex, tlsMaxVersion: o.tlsMaxVersion }, deadlineAt, signal);
    const c = sock.getCipher?.();
    tlsInfo = { protocol: sock.getProtocol?.() || '', cipher: c?.standardName || c?.name || '' };
  }
  const s = new BareosSession(sock, o);
  s.info.tls = tlsInfo;
  const onAbort = () => s._fail(err('aborted', '요청이 취소됐습니다.'));
  signal?.addEventListener?.('abort', onAbort, { once: true });
  try {
    await s._authenticate(o.name, md5hex, deadlineAt);
    // python-bareos 와 같은 순서 — json 을 먼저 켜고(15.2+) compact 를 켠다(15.2.2+)
    await s.callRaw('.api json', { timeoutMs: Math.max(1_000, deadlineAt - Date.now()) });
    await s.callRaw('.api json compact=yes', { timeoutMs: Math.max(1_000, deadlineAt - Date.now()) });
  } catch (e) {
    s._fail(e instanceof BareosConsoleError ? e : err('protocol', String(e?.message || e)));
    throw s._fatal;
  } finally {
    signal?.removeEventListener?.('abort', onAbort);
  }
  return s;
}

/**
 * 세션을 열어 fn(session) 을 돌리고 반드시 닫는다(요청마다 1세션 — 상시 연결을 들고 있지 않는다).
 */
export async function withConsole(opts, fn, deps) {
  const s = await openConsole(opts, deps);
  try { return await fn(s); } finally { s.close(); }
}

/* ───────────────────────── v2.822 단계별 연결 진단 ───────────────────────── */

/** 진단 단계(순서 고정) — 화면·CLI 가 같은 이름을 쓴다. */
export const DIAG_STAGES = Object.freeze([
  ['address', '주소 검사'], ['dns', '이름 해석(DNS)'], ['tcp', 'TCP 연결'], ['tls', 'TLS-PSK 핸드셰이크'],
  ['auth', '콘솔 인증(CRAM-MD5)'], ['api', 'JSON 모드(.api json)'], ['command', '시험 명령(.clients)'],
  // v2.848: 잡 만들기 권한 — 연결과 따로 본다(막혀 있어도 연결 시험은 성공 · 이 줄만 실패로 보인다 — 등록이 'configure: is an invalid command' 로 실패하던 화면)
  ['configure', '잡 만들기 권한(configure)'],
]);
const DIAG_LABEL = Object.fromEntries(DIAG_STAGES);

/** 실패 단계·코드 → 조치 안내(정해진 문구 — Director 응답 원문은 detail 에만). */
function diagHint(key, code) {
  if (key === 'address') return code === 'blocked' ? '링크로컬·루프백 같은 차단 대역입니다 — 사내 주소(RFC1918)는 허용됩니다.' : '주소·포트·콘솔 이름 형식을 확인하세요.';
  if (key === 'dns') return code === 'blocked' ? '이름이 차단 대역 주소로 풀립니다 — DNS 기록을 확인하세요.' : '포탈 서버에서 이 이름을 풀 수 있는지(DNS·hosts) 확인하세요. IP 로 넣어도 됩니다.';
  if (key === 'tcp') return code === 'timeout' ? '응답이 없습니다 — 방화벽·라우팅이 포탈 서버 → Director 9101 을 막고 있는지 확인하세요.' : 'Director(bareos-dir)가 실행 중이고 그 포트에서 듣는지, 방화벽이 막지 않는지 확인하세요.';
  if (key === 'tls' && code === 'closed') return 'TLS 협상 전에 Director 가 연결을 끊었습니다 — 다시 시험해 보고, 계속 끊기면 Director 의 TLS 설정(TLS Enable·TLS PSK Require)과 그 사이 장비(프록시·IPS)를 확인하세요.';
  if (key === 'tls') return 'TLS-PSK 키는 콘솔 이름·비밀번호로 만든다 — 둘 중 하나가 Director 의 Console 리소스와 다르면 여기서 실패합니다. Director 의 TLS 설정(TLS Enable·TLS PSK Require)도 확인하세요.';
  if (key === 'auth') return code === 'pam' ? 'Console 리소스에 PAM 이 켜져 있습니다 — 포탈 전용 콘솔은 PAM 을 쓰지 않게 만드세요.' : '콘솔 비밀번호·이름을 Director 의 Console 리소스와 맞추세요(응답이 맞지 않으면 다른 Director 일 수 있습니다).';
  if (key === 'api') return 'Bareos 15.2 이상이어야 JSON 모드를 씁니다(권장 25.x).';
  if (key === 'configure') return code === 'acl' ? `이 콘솔로는 백업 대상을 등록할 수 없습니다(조회 · 실행은 됩니다). ${CONFIGURE_FIX_TEXT}` : '권한을 확인하지 못했습니다 — 등록이 실패하면 콘솔 Profile 의 Command ACL 에 configure 가 있는지 확인하세요.';
  if (key === 'command') return code === 'jsonrpc' ? '콘솔 Profile 의 Command ACL 에 .clients 와 포탈이 쓰는 명령(설정 탭 사전 준비 블록)이 있는지 확인하세요.' : '응답이 JSON 이 아니면 JSON 모드가 켜지지 않은 것입니다(Bareos 버전 확인).';
  return '';
}

/** 이름 한 번 풀기(주입 가능 — 기본 ssrfLookup: 3초 시한 · 차단 대역 거부). */
function lookupOnce(lookup, host) {
  return new Promise((resolve, reject) => {
    try {
      lookup(host, { all: false }, (e, address, family) => (e ? reject(e) : resolve({ address: String(address), family })));
    } catch (e) { reject(e); }
  });
}

/**
 * 단계별 연결 진단 — **던지지 않는다**. 주소 검사 → DNS → TCP → TLS-PSK → 콘솔 인증 → JSON 모드 → 시험 명령(.clients) 순으로
 * 실제로 접속해 단계마다 { key, label, ok, ms, detail, hint, code } 를 남기고, 실패한 단계 뒤는 skipped(시도 안 함 — 실패로 세지 않는다).
 * DNS 는 자기 단계로 먼저 재고 그 주소로 고정해 붙는다(util/ssrfLookup.pinnedLookup — 단계 시간이 섞이지 않고 '이 IP 로 점검했다' 가 참이다).
 * 시한은 openConsole 과 같이 전체 timeoutMs 하나다.
 * @returns {Promise<{ ok, stages, failed: {key,code,detail}|null, banner, tls, clients, address }>}
 */
export async function diagnoseConsole(opts, { lookup = ssrfLookup, blockReason = ipBlockReason, signal = null } = {}) {
  const stages = [];
  const out = { ok: false, stages, failed: null, banner: '', tls: null, clients: null, address: '', configure: null };
  const push = (key, t0, ok, detail = '', code = '') => {
    const row = { key, label: DIAG_LABEL[key], ok, ms: Math.max(0, Date.now() - t0), detail: String(detail || '').slice(0, 300) };
    if (!ok) { row.code = code || 'error'; row.hint = diagHint(key, code); if (!out.failed) out.failed = { key, code: row.code, detail: row.detail }; }
    stages.push(row);
  };
  const skip = (key, detail) => stages.push({ key, label: DIAG_LABEL[key], skipped: true, detail });
  const finish = () => {
    for (const [key] of DIAG_STAGES) if (!stages.some((x) => x.key === key)) skip(key, '앞 단계가 실패해 시도하지 않았습니다.');
    stages.sort((a, b) => DIAG_STAGES.findIndex(([k]) => k === a.key) - DIAG_STAGES.findIndex(([k]) => k === b.key));
    // v2.848: 권한 단계(configure)는 연결 성공 여부에 넣지 않는다 — 연결 · 인증은 맞다(인증 정지 해제도 그대로)
    out.ok = !stages.some((x) => x.ok === false && x.key !== 'configure');
    return out;
  };
  let t0 = Date.now();
  let o;
  try { o = normalizeConsoleOptions(opts); } catch (e) { push('address', t0, false, e?.message, e?.code || 'invalid'); return finish(); }
  const why = blockReason(o.host);
  if (why) { push('address', t0, false, `접속이 차단된 Director 주소입니다: ${why}`, 'blocked'); return finish(); }
  push('address', t0, true, `${o.host}:${o.port} · 콘솔 ‘${o.name}’`);
  const deadlineAt = Date.now() + o.timeoutMs;
  let lk = lookup;
  t0 = Date.now();
  if (net.isIP(o.host)) { skip('dns', 'IP 주소라 이름 해석이 없습니다.'); out.address = o.host; }
  else {
    try {
      const a = await lookupOnce(lookup, o.host);
      out.address = a.address;
      lk = pinnedLookup(a.address);
      push('dns', t0, true, a.address);
    } catch (e) {
      const c = e?.code || '';
      const code = blockedCode(c) ? 'blocked' : c === 'ETIMEDOUT' ? 'timeout' : 'dns';
      const detail = blockedCode(c) ? String(e?.message || '차단 대역 주소') : c === 'ENOTFOUND' || c === 'EAI_AGAIN' ? `이름을 찾을 수 없습니다(${c})` : c === 'ETIMEDOUT' ? 'DNS 응답 시한을 넘겼습니다.' : String(c || e?.message || e);
      push('dns', t0, false, detail, code);
      return finish();
    }
  }
  const md5hex = passwordMd5Hex(o.password);
  let sock = null;
  t0 = Date.now();
  try { sock = await connectTcp(o.host, o.port, deadlineAt, lk, signal); push('tcp', t0, true, `${out.address || o.host}:${o.port}`); }
  catch (e) { push('tcp', t0, false, e?.message, e?.code); return finish(); }
  if (o.tls === 'psk') {
    t0 = Date.now();
    try {
      sock = await wrapPsk(sock, { name: o.name, md5hex, tlsMaxVersion: o.tlsMaxVersion }, deadlineAt, signal);
      const c = sock.getCipher?.();
      out.tls = { protocol: sock.getProtocol?.() || '', cipher: c?.standardName || c?.name || '' };
      push('tls', t0, true, `${out.tls.protocol} ${out.tls.cipher}`.trim());
    } catch (e) { push('tls', t0, false, e?.message, e?.code); try { sock.destroy(); } catch { /* */ } return finish(); }
  } else skip('tls', 'TLS 를 쓰지 않는 시험 연결입니다(포탈 설정에는 이 경로가 없다).');
  const s = new BareosSession(sock, o);
  s.info.tls = out.tls;
  const onAbort = () => s._fail(err('aborted', '요청이 취소됐습니다.'));
  signal?.addEventListener?.('abort', onAbort, { once: true });
  try {
    t0 = Date.now();
    try { await s._authenticate(o.name, md5hex, deadlineAt); out.banner = s.info.banner; push('auth', t0, true, s.info.banner || '인증 성공'); }
    catch (e) { push('auth', t0, false, e?.message, e?.code); return finish(); }
    t0 = Date.now();
    try {
      await s.callRaw('.api json', { timeoutMs: Math.max(1_000, deadlineAt - Date.now()) });
      await s.callRaw('.api json compact=yes', { timeoutMs: Math.max(1_000, deadlineAt - Date.now()) });
      push('api', t0, true, 'JSON 모드로 전환했습니다.');
    } catch (e) { push('api', t0, false, e?.message, e?.code); return finish(); }
    t0 = Date.now();
    try {
      const r = await s.call('.clients', { timeoutMs: Math.max(1_000, deadlineAt - Date.now()) });
      const list = r && typeof r === 'object' ? Object.values(r).find(Array.isArray) : null;
      out.clients = Array.isArray(list) ? list.map((x) => String(x?.name ?? x ?? '')).filter(Boolean).slice(0, 200) : [];
      push('command', t0, true, `클라이언트 ${out.clients.length}개`);
    } catch (e) { push('command', t0, false, e?.message, e?.code); return finish(); }
    t0 = Date.now();
    const perm = await configurePermission(s, { timeoutMs: Math.max(1_000, deadlineAt - Date.now()) });
    out.configure = perm;
    if (perm.allowed === true) push('configure', t0, true, perm.detail);
    else if (perm.allowed === false) push('configure', t0, false, perm.detail, 'acl');
    else stages.push({ key: 'configure', label: DIAG_LABEL.configure, unknown: true, ms: Math.max(0, Date.now() - t0), detail: perm.detail, hint: diagHint('configure', 'unknown') });
    return finish();
  } finally {
    signal?.removeEventListener?.('abort', onAbort);
    s.close();
  }
}

