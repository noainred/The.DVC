/**
 * linkcheck/protocols.js — HTTP 가 아닌 프로토콜의 **마지막 단계**(v2.553).
 *
 * v2.552 의 `checks.js` 는 DNS·TCP·TLS·HTTP 를 갖는다. 설정에 등록된 대상 중 9종은 SSH,
 * 1종은 SMTP, 1종은 LDAP 라 마지막 단계가 다르다. DNS·TCP·TLS 는 그대로 재사용한다
 * (CLAUDE.md '코어는 하나다' — 단계별 계측·SSRF 핀을 복제하지 않는다).
 *
 * ⚠⚠ **인증을 시도하지 않는다**(사용자 선택 '도달성만'). 이유는 하나다 — 저장된 비밀번호가
 *   장비의 현재 비밀번호와 다르면 5분 주기 점검이 **그 계정을 잠근다**. 이 저장소는 그 사고를
 *   이미 겪었고(`util/bulkRun.js` '자동 재시도 금지' · v2.535 `authGuard`) 같은 함정을 다시
 *   만들지 않는다. 그래서:
 *     · SSH  → **KEX(키 교환) 완료까지**. ssh2 는 인증 **전에** `handshake` 를 낸다.
 *     · SMTP → 220 배너 + `EHLO` + `QUIT`. **AUTH 안 함 · 메일 안 보냄.**
 *     · LDAP → **포트 열림까지**(익명 bind 도 안 한다 — 디렉터리 감사 로그·잠금 정책 대상이 될 수 있다).
 * ⚠ 접속 주소는 **DNS 단계가 검사한 IP** 를 그대로 쓴다(TOCTOU 제거 — v2.506·v2.552 규약).
 */
import net from 'node:net';
import tls from 'node:tls';
import { failKindOfCode } from './phases.js';

const t = (v) => String(v ?? '').trim();
const ms = (t0) => Date.now() - t0;

/**
 * SSH — **협상까지**. 반환의 `banner`·`kex`·`serverKey` 가 이슈 분석 자료다.
 * @param {string} ip   DNS 단계가 검사한 주소
 */
export async function stepSsh(ip, port, { timeoutMs = 12_000 } = {}) {
  const t0 = Date.now();
  let Client;
  try { ({ Client } = await import('ssh2')); }
  catch (e) { return { ok: false, ms: ms(t0), failKind: 'unknown', error: `ssh2 모듈을 불러오지 못했습니다(${String(e?.message || e).slice(0, 80)}).` }; }

  return new Promise((resolve) => {
    let done = false;
    const conn = new Client();
    let ident = '';
    const fin = (r) => {
      if (done) return; done = true;
      try { conn.end(); } catch { /* */ }
      try { conn.destroy(); } catch { /* */ }
      resolve({ ...r, ms: ms(t0) });
    };
    const timer = setTimeout(() => fin({ ok: false, failKind: 'timeout', error: `SSH 협상 타임아웃(${Math.round(timeoutMs / 1000)}초)` }), timeoutMs);
    timer.unref?.();

    /*
     * ⚠ `handshake` 는 KEX 완료 시점이고 **인증 이전**이다 — 여기서 끝내면 로그인 시도가
     *   서버에 도달하지 않는다(계정 잠금 위험 0). `ready` 를 기다리면 인증을 하게 된다.
     */
    conn.on('handshake', (info) => {
      clearTimeout(timer);
      fin({
        ok: true,
        banner: ident.slice(0, 200),
        kex: t(info?.kex), serverHostKey: t(info?.serverHostKey),
        cipher: t(info?.cs?.cipher) || t(info?.encrypt),
        note: '인증은 시도하지 않았습니다(협상까지만).',
      });
    });
    conn.on('greeting', (g) => { ident = t(g) || ident; });
    conn.on('banner', (b) => { if (!ident) ident = t(b); });
    conn.on('error', (e) => {
      clearTimeout(timer);
      const msg = `${e?.code || ''} ${e?.message || ''}`.trim();
      /*
       * ⚠ **협상 실패를 '인증 실패' 라 말하지 말 것**(v2.541 규약): `no matching key exchange
       *   algorithm` 은 구형 장비의 알고리즘 문제이고 조치가 정반대다(자격증명이 아니라 설정).
       */
      const kexBad = /no matching|handshake failed|unable to (?:verify|exchange)/i.test(msg);
      fin({
        ok: false,
        failKind: kexBad ? 'ssh-kex' : failKindOfCode(e?.code, msg),
        error: msg.slice(0, 200),
        ...(ident ? { banner: ident.slice(0, 200) } : {}),
      });
    });
    try {
      conn.connect({
        host: ip, port, readyTimeout: timeoutMs,
        // 인증 수단을 **주지 않는다**. handshake 에서 끊으므로 인증 단계에 도달하지 않는다.
        username: 'linkcheck-probe', tryKeyboard: false,
      });
    } catch (e) { clearTimeout(timer); fin({ ok: false, failKind: 'unknown', error: String(e?.message || e).slice(0, 200) }); }
  });
}

/**
 * SMTP — 220 배너 + EHLO + QUIT. `secure` 면 TLS 로 먼저 감싼다(465).
 * ⚠ **AUTH 하지 않고 메일도 보내지 않는다.** STARTTLS 광고 여부는 `starttls` 로 알려만 준다.
 */
export function stepSmtp(ip, port, { timeoutMs = 12_000, secure = false, servername = '' } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let done = false;
    let buf = '';
    let phase = 'banner';
    let banner = '';
    let ehlo = '';
    const sock = secure
      ? tls.connect({ host: ip, port, servername: t(servername) || undefined, rejectUnauthorized: false, family: net.isIPv6(ip) ? 6 : 4 })
      : net.connect({ host: ip, port, family: net.isIPv6(ip) ? 6 : 4 });
    const fin = (r) => { if (done) return; done = true; try { sock.destroy(); } catch { /* */ } resolve({ ...r, ms: ms(t0) }); };
    sock.setTimeout(timeoutMs, () => fin({
      ok: false, failKind: 'timeout',
      error: `SMTP 응답 타임아웃(${Math.round(timeoutMs / 1000)}초${phase === 'banner' ? ' — 220 배너를 받지 못했습니다' : ' — EHLO 응답을 받지 못했습니다'})`,
      ...(banner ? { banner } : {}),
    }));
    sock.on('error', (e) => fin({ ok: false, failKind: failKindOfCode(e?.code, e?.message), error: `${e?.code || ''} ${e?.message || ''}`.trim().slice(0, 200) }));
    const onLine = () => {
      if (phase === 'banner') {
        const line = buf.split(/\r?\n/)[0] || '';
        if (!/\r?\n/.test(buf)) return;
        banner = line.slice(0, 200);
        // ⚠ 421 은 '지금은 못 받는다'(과부하·차단)라 **정상이 아니다** — 조용히 ok 로 넘기지 않는다.
        if (!/^220[ -]/.test(line)) {
          return fin({ ok: false, failKind: 'smtp-refused', error: `SMTP 배너가 220 이 아닙니다: ${line.slice(0, 120)}`, banner });
        }
        phase = 'ehlo'; buf = '';
        sock.write('EHLO linkcheck.local\r\n');
        return;
      }
      if (phase === 'ehlo') {
        // 멀티라인 응답은 마지막 줄이 `250 ` (하이픈 없음)이다.
        if (!/^250 [^\n]*\r?\n/m.test(buf) && !/^\d{3} [^\n]*\r?\n/m.test(buf)) return;
        ehlo = buf.slice(0, 600);
        const ok = /^250[ -]/m.test(buf);
        phase = 'done';
        try { sock.write('QUIT\r\n'); } catch { /* */ }
        return fin(ok
          ? { ok: true, banner, ehlo, starttls: /STARTTLS/i.test(buf), authAdvertised: /^250[ -]AUTH/im.test(buf), note: 'AUTH·메일 발송은 하지 않았습니다.' }
          : { ok: false, failKind: 'smtp-refused', error: `EHLO 응답이 거부입니다: ${ehlo.split(/\r?\n/)[0] || ''}`.slice(0, 200), banner, ehlo });
      }
    };
    sock.on('data', (d) => { buf += d.toString('latin1'); if (buf.length > 8_000) buf = buf.slice(-8_000); onLine(); });
  });
}

/** 포트 열림만(LDAP 등). TCP 단계가 이미 그것을 재므로 **성공을 그대로 옮긴다**. */
export function stepPortOnly(tcpStep, { note = '' } = {}) {
  if (!tcpStep) return null;
  return tcpStep.ok
    ? { ok: true, ms: 0, note: note || '포트가 열려 있습니다(프로토콜 대화는 하지 않았습니다).' }
    : { ok: false, ms: 0, failKind: tcpStep.failKind || 'unknown', error: tcpStep.error || '' };
}
