/**
 * util/smtp.js — 의존성 없는 최소 SMTP 클라이언트 (v2.454).
 *
 * 왜 직접 만드나: 이 포탈에는 메일 발송 경로가 **없었다**. `alerts.js` 는 Slack/Teams/Webhook 만
 * 지원하고 헤더에 "Email 은 SMTP 라이브러리가 필요하므로 현재는 webhook 경유를 권장(추후 옵션)"
 * 이라고 적어 둔 채였다. 폴더 사용량 리포트(dirusage)가 메일을 요구하므로 그 자리를 채운다.
 * 저장소 방침이 dependency-free(HTTP 는 fetch, SSH 만 ssh2)이므로 net/tls 로 직접 구현한다.
 *
 * 구현 범위 — 사내 릴레이를 상대하는 데 필요한 만큼만:
 *   EHLO → (STARTTLS → EHLO) → (AUTH LOGIN|PLAIN) → MAIL FROM → RCPT TO → DATA → QUIT
 * 지원하지 않는 것(정직하게): OAuth2 · DKIM 서명 · 첨부파일 · 8BITMIME 협상 · 파이프라이닝.
 * 본문은 항상 base64(UTF-8)로 보내 인코딩 사고를 없앤다.
 *
 * 보안:
 *  - 비밀번호는 어떤 로그·오류 메시지에도 싣지 않는다(AUTH 단계 오류는 명령어를 가린다).
 *  - 서버 응답 버퍼에 상한(64KB)을 둔다 — 악의적/고장난 서버가 메모리를 밀어 넣지 못하게.
 *  - 단계마다 타임아웃. 연결이 멈춰도 폴러가 영원히 붙잡히지 않는다.
 *  - 헤더 주입 차단: 주소·제목의 CR/LF 는 거부한다(BCC 몰래 추가·본문 위조 방지).
 */
import net from 'node:net';
import tls from 'node:tls';

/** 서버 응답 누적 상한 — 고장난 서버가 무한히 밀어 넣는 것을 막는다. */
const MAX_REPLY_BYTES = 64 * 1024;

/** 주소·제목에 CR/LF 가 들어가면 헤더 주입이다. 그 외 제어문자도 거부. */
// eslint-disable-next-line no-control-regex
const HEADER_UNSAFE = /[\x00-\x1f\x7f]/;

/** 아주 느슨한 주소 형식 검사 — 릴레이가 최종 판정하므로 여기서는 명백한 오류만 막는다. */
const ADDR_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

/** 주소 목록 정규화: 문자열/배열 → 중복 없는 배열. 형식이 틀린 항목은 이유와 함께 돌려준다. */
export function normalizeAddresses(input) {
  const raw = Array.isArray(input) ? input : String(input || '').split(/[,;]/);
  const ok = [];
  const bad = [];
  const seen = new Set();
  for (const s of raw) {
    const a = String(s || '').trim();
    if (!a) continue;
    if (HEADER_UNSAFE.test(a) || !ADDR_RE.test(a)) { bad.push(a.slice(0, 80)); continue; }
    const k = a.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    ok.push(a);
  }
  return { ok, bad };
}

/** RFC 2047 — 비ASCII 헤더는 base64 로 인코딩한다(한글 제목이 깨지지 않게). */
export function encodeHeaderWord(s) {
  const v = String(s ?? '');
  if (!v) return '';
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(v)) return v;             // 순수 ASCII 는 그대로
  return `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`;
}

/** base64 본문을 76자로 접는다(RFC 2045 권장 줄 길이). */
function foldBase64(b64) {
  const out = [];
  for (let i = 0; i < b64.length; i += 76) out.push(b64.slice(i, i + 76));
  return out.join('\r\n');
}

/**
 * MIME 메시지를 만든다(순수 — 테스트로 고정한다).
 * html 과 text 가 모두 있으면 multipart/alternative, 하나만 있으면 단일 파트.
 * @returns {string} DATA 로 보낼 본문(끝의 `.` 는 붙이지 않는다)
 */
export function buildMime({ from, to = [], cc = [], subject = '', html = '', text = '', date = new Date(), messageId = '' }) {
  if (HEADER_UNSAFE.test(String(subject))) throw new Error('제목에 제어문자를 쓸 수 없습니다.');
  const h = [];
  h.push(`From: ${from}`);
  if (to.length) h.push(`To: ${to.join(', ')}`);
  if (cc.length) h.push(`Cc: ${cc.join(', ')}`);
  h.push(`Subject: ${encodeHeaderWord(subject)}`);
  h.push(`Date: ${date.toUTCString().replace('GMT', '+0000')}`);
  if (messageId) h.push(`Message-ID: <${messageId}>`);
  h.push('MIME-Version: 1.0');

  const part = (ctype, body) => [
    `Content-Type: ${ctype}; charset=UTF-8`,
    'Content-Transfer-Encoding: base64',
    '',
    foldBase64(Buffer.from(body, 'utf8').toString('base64')),
  ].join('\r\n');

  if (html && text) {
    const b = `_dvc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    h.push(`Content-Type: multipart/alternative; boundary="${b}"`);
    return [
      h.join('\r\n'), '',
      `--${b}`, part('text/plain', text),
      `--${b}`, part('text/html', html),
      `--${b}--`, '',
    ].join('\r\n');
  }
  const body = html || text || '';
  return [h.join('\r\n'), part(html ? 'text/html' : 'text/plain', body)].join('\r\n');
}

/** DATA 구간의 dot-stuffing — 줄 시작의 `.` 은 `..` 로 바꿔야 본문이 조기 종료되지 않는다. */
export function dotStuff(body) {
  return String(body).replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
}

/** 서버 응답 한 덩어리를 파싱한다. 멀티라인(`250-…` 반복 후 `250 …`)을 하나로 합친다. */
export function parseReply(buf) {
  const lines = String(buf).split(/\r?\n/).filter(Boolean);
  if (!lines.length) return null;
  const last = lines[lines.length - 1];
  const m = /^(\d{3})([ -])(.*)$/.exec(last);
  if (!m || m[2] !== ' ') return null;                 // 아직 끝나지 않은 멀티라인
  return { code: Number(m[1]), lines: lines.map((l) => l.slice(4)), text: lines.join(' | ') };
}

/** EHLO 응답에서 지원 확장을 뽑는다(대문자 정규화). */
export function ehloCaps(reply) {
  const caps = new Set();
  for (const l of reply?.lines || []) {
    const t = String(l).trim();
    if (t) caps.add(t.split(/\s+/)[0].toUpperCase());
  }
  return caps;
}

/** AUTH 방식 선택 — 서버가 광고하는 것 중 우리가 구현한 것. */
export function pickAuthMech(reply) {
  const line = (reply?.lines || []).find((l) => /^AUTH\b/i.test(String(l).trim()));
  if (!line) return null;
  const mechs = String(line).trim().split(/\s+/).slice(1).map((s) => s.toUpperCase());
  if (mechs.includes('PLAIN')) return 'PLAIN';
  if (mechs.includes('LOGIN')) return 'LOGIN';
  return null;
}

/** 한 줄 대화 — 명령을 보내고 완성된 응답 한 덩어리를 기다린다. */
function converse(sock, line, timeoutMs, { redact = false } = {}) {
  return new Promise((resolve, reject) => {
    let buf = '';
    let done = false;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      sock.off('data', onData); sock.off('error', onErr); sock.off('close', onClose);
      err ? reject(err) : resolve(val);
    };
    const label = redact ? '<인증 정보>' : String(line ?? '').split('\r')[0].slice(0, 40);
    const t = setTimeout(() => finish(new Error(`SMTP 응답 시간 초과(${timeoutMs}ms): ${label}`)), timeoutMs);
    const onData = (d) => {
      buf += d.toString('utf8');
      if (buf.length > MAX_REPLY_BYTES) return finish(new Error('SMTP 응답이 너무 큽니다(64KB 초과).'));
      const r = parseReply(buf);
      if (r) finish(null, r);
    };
    const onErr = (e) => finish(new Error(`SMTP 소켓 오류: ${e.message}`));
    const onClose = () => finish(new Error(`SMTP 연결이 끊겼습니다: ${label}`));
    sock.on('data', onData); sock.on('error', onErr); sock.on('close', onClose);
    if (line != null) sock.write(line + '\r\n');
  });
}

/** 2xx/3xx 가 아니면 오류. 인증 단계는 명령을 가려서 비밀번호가 로그에 남지 않게 한다. */
function expect(reply, okCodes, what) {
  if (!okCodes.includes(reply.code)) throw new Error(`${what} 실패 — 서버 응답 ${reply.code}: ${reply.lines[reply.lines.length - 1] || ''}`);
  return reply;
}

/**
 * 메일 1건 발송.
 *
 * @param {{host:string, port?:number, secure?:boolean, startTls?:boolean, user?:string, password?:string,
 *          from:string, timeoutMs?:number, rejectUnauthorized?:boolean, name?:string}} cfg
 * @param {{to:string[]|string, cc?:string[]|string, subject:string, html?:string, text?:string}} msg
 * @returns {Promise<{accepted:string[], code:number, text:string}>}
 */
export async function sendMail(cfg, msg) {
  const host = String(cfg?.host || '').trim();
  if (!host) throw new Error('SMTP 서버 주소가 없습니다.');
  const port = Number(cfg.port) || (cfg.secure ? 465 : 25);
  const timeoutMs = Math.max(1000, Number(cfg.timeoutMs) || 20_000);
  const from = String(cfg.from || '').trim();
  if (!from || HEADER_UNSAFE.test(from) || !ADDR_RE.test(from)) throw new Error('보내는 사람(From) 주소가 올바르지 않습니다.');

  const to = normalizeAddresses(msg.to);
  const cc = normalizeAddresses(msg.cc || []);
  if (to.bad.length || cc.bad.length) throw new Error(`받는 사람 주소 형식 오류: ${[...to.bad, ...cc.bad].join(', ')}`);
  if (!to.ok.length && !cc.ok.length) throw new Error('받는 사람이 없습니다.');

  const sock = await new Promise((resolve, reject) => {
    const onErr = (e) => reject(new Error(`SMTP 접속 실패(${host}:${port}): ${e.message}`));
    const s = cfg.secure
      ? tls.connect({ host, port, servername: host, rejectUnauthorized: cfg.rejectUnauthorized !== false }, () => resolve(s))
      : net.connect({ host, port }, () => resolve(s));
    s.setTimeout(timeoutMs, () => { s.destroy(new Error('연결 유휴 시간 초과')); });
    s.once('error', onErr);
  });

  let sk = sock;
  try {
    expect(await converse(sk, null, timeoutMs), [220], 'SMTP 접속');
    const me = cfg.name || 'vmware-portal';
    let ehlo = expect(await converse(sk, `EHLO ${me}`, timeoutMs), [250], 'EHLO');

    // STARTTLS — 평문 연결에서 인증 정보를 보내기 전에 반드시 승격한다.
    if (cfg.startTls !== false && !cfg.secure && ehloCaps(ehlo).has('STARTTLS')) {
      expect(await converse(sk, 'STARTTLS', timeoutMs), [220], 'STARTTLS');
      sk = await new Promise((resolve, reject) => {
        const up = tls.connect({ socket: sock, servername: host, rejectUnauthorized: cfg.rejectUnauthorized !== false },
          () => resolve(up));
        up.once('error', (e) => reject(new Error(`STARTTLS 협상 실패: ${e.message}`)));
      });
      ehlo = expect(await converse(sk, `EHLO ${me}`, timeoutMs), [250], 'EHLO(TLS)');
    }

    if (cfg.user) {
      const mech = pickAuthMech(ehlo);
      if (!mech) throw new Error('서버가 AUTH PLAIN/LOGIN 을 지원하지 않습니다(계정을 비우면 인증 없이 시도합니다).');
      const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
      if (mech === 'PLAIN') {
        const tok = Buffer.from(`\0${cfg.user}\0${cfg.password || ''}`, 'utf8').toString('base64');
        expect(await converse(sk, `AUTH PLAIN ${tok}`, timeoutMs, { redact: true }), [235], 'SMTP 인증');
      } else {
        expect(await converse(sk, 'AUTH LOGIN', timeoutMs, { redact: true }), [334], 'SMTP 인증');
        expect(await converse(sk, b64(cfg.user), timeoutMs, { redact: true }), [334], 'SMTP 인증(계정)');
        expect(await converse(sk, b64(cfg.password || ''), timeoutMs, { redact: true }), [235], 'SMTP 인증(비밀번호)');
      }
    }

    expect(await converse(sk, `MAIL FROM:<${from}>`, timeoutMs), [250], 'MAIL FROM');
    const accepted = [];
    for (const rcpt of [...to.ok, ...cc.ok]) {
      const r = await converse(sk, `RCPT TO:<${rcpt}>`, timeoutMs);
      if (r.code === 250 || r.code === 251) accepted.push(rcpt);
      // 개별 거부는 치명적이지 않다 — 나머지에게는 보낸다. 전원 거부면 아래에서 오류.
    }
    if (!accepted.length) throw new Error('모든 수신자가 거부되었습니다(릴레이 권한·주소 확인).');

    expect(await converse(sk, 'DATA', timeoutMs), [354], 'DATA');
    const mime = buildMime({ from, to: to.ok, cc: cc.ok, subject: msg.subject, html: msg.html, text: msg.text });
    const sent = expect(await converse(sk, `${dotStuff(mime)}\r\n.`, timeoutMs), [250], '본문 전송');
    try { await converse(sk, 'QUIT', 3000); } catch { /* QUIT 응답은 못 받아도 무방 */ }
    return { accepted, code: sent.code, text: sent.lines[sent.lines.length - 1] || '' };
  } finally {
    try { sk.destroy(); } catch { /* noop */ }
    if (sk !== sock) { try { sock.destroy(); } catch { /* noop */ } }
  }
}
