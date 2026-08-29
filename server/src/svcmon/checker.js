/**
 * 성능점검 실행기 — 표준 라이브러리만으로 15종 점검을 수행한다.
 *
 * 유형: ping · trace · tcp · udp · http · soap · dns · cert · ntp · smtp · pop3 · imap
 *       · ssh · ldap · domain
 * 모든 실패는 격리되어 { status:'bad', reply } 로 떨어진다(폴러/워커가 개별 오류로 죽지 않게).
 *
 * 보안
 * - 대상 host/url 은 저장 시 SSRF 가드를 통과했지만 DNS 가 나중에 바뀔 수 있어 http/soap 은
 *   실행 직전에도 재검증한다(허브 웹훅과 같은 규칙).
 * - TLS 검증 해제(insecure)는 그 요청의 로컬 디스패처에만 적용 — 전역 디스패처 오염 금지.
 * - 외부 CLI(traceroute)는 인자 화이트리스트를 통과한 값만 넘긴다(선행 '-' 차단).
 * - 배너류 점검은 연결 후 최소 바이트만 읽고 끊는다(대상 로그 오염·세션 점유 최소화).
 */

import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import { execFile } from 'node:child_process';
import { Resolver } from 'node:dns/promises';
import { Agent } from 'undici';
import { pingOne } from '../util/ping.js';
import { ssrfBlockReasonResolved } from '../collector/registry.js';

const insecureAgent = new Agent({ connect: { rejectUnauthorized: false } });
const SAFE_HOST = /^[a-zA-Z0-9._:-]+$/;
const shortErr = (e) => String(e?.cause?.code || e?.code || e?.message || e).slice(0, 140);

/** 유형별 기본 포트 — 폼에서 비워두면 이 값을 쓴다. */
export const DEFAULT_PORTS = {
  smtp: 25, pop3: 110, imap: 143, ssh: 22, ldap: 389, cert: 443, domain: 43, ntp: 123, dns: 53,
};

// 점검 1건의 하드 데드라인(방어선) — 개별 소켓 타임아웃(대개 5초, cert/ntp 등도 수 초)보다 넉넉히
// 두어 정상 점검은 건드리지 않되, 어떤 이유로든 내부 Promise 가 결말나지 않으면 여기서 끊는다.
// traceroute(execFile 25초)·domain(whois 다단) 이 가장 길어 45초로 잡았다.
const RUNCHECK_HARD_TIMEOUT_MS = 45_000;

/**
 * 단일 점검 실행 → { status:'ok'|'warn'|'bad', reply, ms }.
 * ⚠ CRITICAL 회귀 방지(v2.279): 개별 점검이 소켓/Promise 를 결말짓지 못하면(과거 banner/ldapBind 의
 * 부분응답·무응답 종료가 그랬다) 그 점검을 await 하던 워커/풀의 드레인 루프가 영영 끝나지 않아
 * 폴러 전체가 멈췄다. 소스(banner/ldapBind)는 각각 고쳤고, 여기서 한 번 더 하드 데드라인으로 감싸
 * 미래의 어떤 미결말도 폴러를 멈추지 못하게 한다(초과 시 bad 로 격리 — 실패 격리 원칙과 동일).
 */
export async function runCheck(test, host) {
  const startedAt = Date.now();
  let timer;
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve(bad('점검 시간 초과(내부 데드라인 45s)', startedAt)), RUNCHECK_HARD_TIMEOUT_MS);
    if (timer && typeof timer.unref === 'function') timer.unref(); // 데드라인 타이머가 프로세스 종료를 막지 않게
  });
  try {
    return await Promise.race([runCheckInner(test, host), guard]);
  } finally {
    clearTimeout(timer);
  }
}

/** 실제 점검 로직 — runCheck 하드 데드라인 래퍼 안에서 실행된다. */
async function runCheckInner(test, host) {
  const started = Date.now();
  const port = Number(test.port) || DEFAULT_PORTS[test.type] || 0;
  try {
    // ⚠ 보류(v2.322 보안 감사 LOW — svcmon 비-HTTP 실행시점 SSRF 재검증): tcp/udp/cert/banner/
    // ldap/ntp/dns 는 저장 시점 ssrfBlockReason 만 통과하고 실행 시점 해석 재검증이 없어 DNS
    // 리바인딩으로 루프백/링크로컬 도달성 오라클이 될 수 있다(LOW — 저장 시 loopback/link-local
    // 은 이미 차단됨, RFC1918 만 허용). 여기서 ssrfBlockReasonResolved 를 부르면 타임아웃 없는
    // DNS 조회가 매 점검마다 추가돼 폴러가 지연/정지될 수 있어 되돌렸다(docs/AUDIT-2026-08-17.md).
    // 올바른 조치는 dns.lookup(타임아웃)+ipBlockReason 후 그 IP 로 직접 접속(uagmon 핀 패턴) — 각
    // 케이스 접속부를 IP 핀으로 리팩터해야 하므로 별도 작업으로 뺀다.
    switch (test.type) {
      case 'ping': {
        const r = await pingOne(host, { timeoutMs: 4000 });
        return r.alive ? ok(`${r.rttMs ?? 0} ms`, r.rttMs ?? 0) : bad('응답 없음', started);
      }
      case 'trace': {
        const hopLimit = test.maxHops || 15;
        const r = await traceroute(host, hopLimit);
        // overLimit: 임계 내에 목적지에 닿지 못했다(경로가 더 길거나 중간에서 끊김).
        // 예전에는 아래 두 분기가 같은 값(maxHops)을 '명령 상한'과 '경고 임계'로 겸용해
        // 뒤 분기가 구조적으로 도달 불가한 죽은 코드였다 — 문구를 정확히 갈라 준다.
        if (r.overLimit) return warn(`${r.hops} hops — 임계(${hopLimit}) 내 목적지 미도달`, started);
        if (!r.reached) return warn(`${r.hops} hop 까지 도달(미완료)`, started);
        return ok(`${r.hops} hops`, Date.now() - started);
      }
      case 'tcp': {
        const alive = await tcpPort(host, port, 4000);
        return alive ? ok(`포트 ${port} 열림`, Date.now() - started) : bad(`포트 ${port} 연결 실패`, started);
      }
      case 'udp': {
        const bytes = await udpProbe(host, port, test.payload || '', 4000);
        return bytes > 0 ? ok(`응답 ${bytes} bytes`, Date.now() - started) : bad('UDP 응답 없음', started);
      }
      case 'http': case 'soap': {
        // 해석형 SSRF 재검증 — DNS 이름이 169.254/127.x 등으로 해석되는 우회를 막는다(동기
        // ssrfBlockReason 은 IP 리터럴만 판정해 이름을 통과시킴). collector/웹훅과 같은 async 가드.
        const reason = await ssrfBlockReasonResolved(test.url);
        if (reason) return bad(`차단: ${reason}`, started);
        const isSoap = test.type === 'soap';
        const res = await fetch(test.url, {
          method: isSoap ? 'POST' : 'GET',
          redirect: 'manual',
          signal: AbortSignal.timeout(8000),
          ...(isSoap ? {
            headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: test.soapAction || '' },
            body: test.body || '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body/></s:Envelope>',
          } : {}),
          ...(test.insecure ? { dispatcher: insecureAgent } : {}),
        });
        const ms = Date.now() - started;
        const okStatus = test.expectStatus ? res.status === test.expectStatus : res.status < 500;
        if (!okStatus) return { status: 'bad', reply: `HTTP ${res.status}`, ms };
        if (test.keyword) {
          const body = (await res.text()).slice(0, 262144);   // 256KB 상한 — 대용량 응답 방어
          if (!body.includes(test.keyword)) return { status: 'warn', reply: `HTTP ${res.status} · 키워드 없음`, ms };
        }
        if (test.warnMs && ms > test.warnMs) return { status: 'warn', reply: `HTTP ${res.status} · ${ms}ms(느림)`, ms };
        return { status: 'ok', reply: `HTTP ${res.status} · ${ms}ms`, ms };
      }
      case 'dns': {
        const resolver = new Resolver({ timeout: 4000, tries: 1 });
        resolver.setServers([test.server || host]);
        const name = test.record || 'localhost';
        const addrs = await resolver.resolve4(name).catch(() => resolver.resolve6(name));
        const ms = Date.now() - started;
        if (!addrs?.length) return bad('결과 없음', started);
        if (test.expect && !addrs.includes(test.expect)) return { status: 'warn', reply: `${addrs[0]} (기대 ${test.expect})`, ms };
        return { status: 'ok', reply: `${name} → ${addrs[0]} · ${ms}ms`, ms };
      }
      case 'cert': {
        const days = await certDaysLeft(host, port, 6000);
        const ms = Date.now() - started;
        if (days < 0) return { status: 'bad', reply: `만료됨 (${-days}일 경과)`, ms };
        if (days <= (test.warnDays || 30)) return { status: 'warn', reply: `D-${days}`, ms };
        return { status: 'ok', reply: `D-${days}`, ms };
      }
      case 'ntp': {
        const offset = await ntpOffset(test.server || host, 4000);
        const abs = Math.abs(offset);
        const ms = Date.now() - started;
        if (abs > (test.badMs || 5000)) return { status: 'bad', reply: `오프셋 ${Math.round(offset)}ms`, ms };
        if (abs > (test.warnMs || 1000)) return { status: 'warn', reply: `오프셋 ${Math.round(offset)}ms`, ms };
        return { status: 'ok', reply: `오프셋 ${Math.round(offset)}ms`, ms };
      }
      // 배너류 — 연결 후 인사말 1줄을 읽어 프로토콜 정상 응답인지 확인한다.
      case 'smtp': return banner(host, port, /^220[ -]/, 'SMTP', started, test);
      case 'pop3': return banner(host, port, /^\+OK/, 'POP3', started, test);
      case 'imap': return banner(host, port, /^\* OK/, 'IMAP', started, test);
      case 'ssh': return banner(host, port, /^SSH-2\.0-|^SSH-1\.99-/, 'SSH', started, test);
      case 'ldap': {
        const r = await ldapBind(host, port, 5000);
        return r.ok ? ok(`bind 성공 (resultCode ${r.code})`, Date.now() - started)
          : bad(`bind 실패 (resultCode ${r.code})`, started);
      }
      case 'domain': {
        const days = await domainDaysLeft(test.record || host, 8000);
        const ms = Date.now() - started;
        if (days == null) return { status: 'warn', reply: '만료일 파싱 실패', ms };
        if (days < 0) return { status: 'bad', reply: `만료됨 (${-days}일 경과)`, ms };
        if (days <= (test.warnDays || 60)) return { status: 'warn', reply: `D-${days}`, ms };
        return { status: 'ok', reply: `D-${days}`, ms };
      }
      default:
        return { status: 'bad', reply: `알 수 없는 점검 유형: ${test.type}`, ms: 0 };
    }
  } catch (e) {
    return { status: 'bad', reply: shortErr(e), ms: Date.now() - started };
  }
}

const ok = (reply, ms) => ({ status: 'ok', reply, ms });
const warn = (reply, started) => ({ status: 'warn', reply, ms: Date.now() - started });
const bad = (reply, started) => ({ status: 'bad', reply, ms: Date.now() - started });

function tcpPort(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port, timeout: timeoutMs });
    const done = (v) => { try { sock.destroy(); } catch { /* noop */ } resolve(v); };
    sock.once('connect', () => done(true));   // 바이트를 보내지 않는다(대상 로그 오염 방지)
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

/** 배너 검사 공통 — 연결 후 첫 응답 1줄이 기대 패턴인지 본다. */
function banner(host, port, pattern, label, started, test) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port, timeout: 5000 });
    let buf = '';
    let done = false;
    const finish = (r) => { if (done) return; done = true; try { sock.destroy(); } catch { /* noop */ } resolve(r); };
    // 수집한 배너를 판정한다. 한 바이트도 못 받았으면(buf 빈 문자열) 무응답으로 떨어뜨린다.
    const evaluate = () => {
      if (!buf) return finish(bad(`${label} 무응답(연결 종료)`, started));
      const line = buf.split(/\r?\n/)[0].slice(0, 120);
      if (!pattern.test(line)) return finish({ status: 'warn', reply: `예상외 응답: ${line}`, ms: Date.now() - started });
      if (test?.keyword && !buf.includes(test.keyword)) return finish({ status: 'warn', reply: `${label} 응답 · 키워드 없음`, ms: Date.now() - started });
      finish({ status: 'ok', reply: line, ms: Date.now() - started });
    };
    sock.once('connect', () => { if (test?.send) sock.write(`${test.send}\r\n`); });
    sock.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      // 완결 신호(개행 도착 또는 배너 상한 2048B 도달)면 즉시 판정. 그 외엔 close 에서 판정한다.
      if (buf.length > 2048 || buf.includes('\n')) evaluate();
    });
    sock.once('timeout', () => finish(bad(`${label} 응답 타임아웃`, started)));
    sock.once('error', (e) => finish(bad(shortErr(e), started)));
    // ⚠ CRITICAL 회귀 방지(v2.279): 서버가 '개행 없는 부분 배너'를 보낸 뒤 정상 종료(FIN)하면
    // data 핸들러는 개행이 없어 판정하지 않고, 과거 close 핸들러는 `if (!buf)` 라 buf 가 비어있지
    // 않으면 아무 것도 안 해 Promise 가 영구 미해결 → 폴러 전체가 멈췄다(소켓 inactivity 타임아웃은
    // FIN·destroy 시 해제돼 발화하지 않음). close 에서 받은 부분 배너로 반드시 판정한다.
    sock.once('close', () => evaluate());
  });
}

function udpProbe(host, port, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const timer = setTimeout(() => { try { sock.close(); } catch { /* noop */ } resolve(0); }, timeoutMs);
    sock.once('message', (msg) => { clearTimeout(timer); try { sock.close(); } catch { /* noop */ } resolve(msg.length); });
    sock.once('error', (e) => { clearTimeout(timer); try { sock.close(); } catch { /* noop */ } reject(e); });
    sock.send(Buffer.from(payload || '\r\n'), port, host, (e) => {
      if (e) { clearTimeout(timer); try { sock.close(); } catch { /* noop */ } reject(e); }
    });
  });
}

/**
 * traceroute/tracert 출력 파서 — { hops, reached }. 순수 함수(테스트 대상).
 *
 * ⚠ 확정 버그 수정(2026-08-30): 이전 판정은 마지막 홉이 `* * *`(별표 3연속)일 때만 미도달로
 * 봤다. 그런데 Linux 인자는 `-q 1`(홉당 프로브 1개)이라 무응답 홉 출력이 `" 15  *"`(별표
 * 1개)뿐이어서 **별표 3연속이 구조적으로 나올 수 없었고**, 목적지까지 전 홉이 무응답이어도
 * reached=true 가 됐다 → 죽은 경로가 'ok'(정상)로 표시되는 거짓 정상. Windows tracert 는 기본
 * 3프로브라 `* * *` 가 나와 개발 환경에서는 드러나지 않고 운영(Rocky Linux 9)에서만 발현했다.
 *
 * 새 판정은 프로브 개수와 무관하다 — 마지막 홉이 '실제로 응답했는지'를 본다:
 *   ① 응답 증거가 있어야 한다 = 주소(IP)가 찍혔거나 RTT(`1 ms`·`0.512 ms`·`<1 ms`)가 있다.
 *      ⚠ '별표가 아닌 토큰이 있으면 응답'으로 보면 안 된다 — Windows tracert 의 무응답 줄은
 *      `2  *  *  *  Request timed out.` 처럼 **영문 안내 문구**가 붙어 오탐한다(테스트로 고정).
 *   ② ICMP 도달불가 표식(`!H` 호스트·`!N` 네트워크·`!P` 프로토콜 등)이나 문구형 도달불가
 *      (`Destination net unreachable`)가 있으면 미도달 — 응답은 왔지만 목적지에 닿지 못한 것이다.
 *   ③ **홉 임계 초과**면 미도달. traceroute 는 목적지가 응답하면 그 자리에서 멈추므로, 임계보다
 *      많은 줄이 찍혔다는 것은 목적지에 닿지 못한 채 끊긴 것이다. 이 검사가 없으면 마지막 홉의
 *      **중간 라우터**가 응답한 것을 목적지 도달로 오판한다(한국↔폴란드·미국동부처럼 홉이 긴
 *      경로에서 실제로 발현 — 재감사 실행 재현).
 *      ⚠ 그래서 명령은 임계보다 **1 크게**(`-m maxHops+1`) 실행하고 여기서는 `hops > maxHops` 로
 *      판정한다. 예전처럼 명령 상한과 임계를 같은 값으로 쓰고 `hops >= maxHops` 로 보면, 목적지가
 *      **정확히 임계 홉에 있는 정상 경로**까지 미도달로 오판했다(3차 재감사 지적).
 *
 * @param opts.maxHops 홉 임계(명령 상한이 아니다 — 명령은 이보다 1 크게 실행한다). 0이면 ③ 생략.
 * @param opts.target  대상 주소. IP 리터럴이면 마지막 홉과 대조해 도달을 확정한다(대소문자 무시).
 */
export function parseTraceroute(out, { maxHops = 0, target = '' } = {}) {
  const lines = String(out || '').split('\n').filter((l) => /^\s*\d+/.test(l));
  const hops = lines.length;
  const last = lines[lines.length - 1] || '';
  const rest = last.replace(/^\s*\d+\s*/, '').trim();
  const hasAddr = /\d{1,3}(?:\.\d{1,3}){3}|(?:[0-9a-f]{1,4}:){2,}[0-9a-f]{0,4}/i.test(rest); // IPv4 또는 IPv6
  const hasRtt = /\d+(?:\.\d+)?\s*ms/i.test(rest);
  const unreachable = /!(?:H|N|P|X|A|S|F|C|T|U|\d+)\b/.test(rest) || /unreachable/i.test(rest);
  // 목적지 주소가 마지막 홉에 그대로 찍혔는지(IP 리터럴 대상일 때만 신뢰할 수 있는 신호).
  const t = String(target || '').trim();
  const targetHit = !!t && /^[0-9a-fA-F.:]+$/.test(t)
    && new RegExp(`(?:^|\\s)${t.replace(/[.]/g, '\\.')}(?:\\s|$)`, 'i').test(rest);
  const overLimit = maxHops > 0 && hops > maxHops && !targetHit;
  return { hops, overLimit, reached: hops > 0 && (hasAddr || hasRtt) && !unreachable && !overLimit };
}

/**
 * 홉 '판정 임계'와 '명령 상한'을 한 곳에서 계산한다 — 두 값을 헷갈리면 판정이 죽는다.
 *
 * ⚠ 실제로 그렇게 죽었다(4차 재감사): 호출부가 `parseTraceroute(out, { maxHops: limit })` 로
 * **명령 상한**을 임계로 넘기는 바람에, 명령이 `-m limit` 이라 홉 줄이 limit 를 넘을 수 없어
 * `hops > limit` 이 **어떤 입력에서도 거짓**이 됐다 → 임계 초과 검사 전체가 무력화(거짓 정상 재발).
 * 그래서 두 값을 함께 반환하는 이 헬퍼로 묶고, 임계는 항상 `threshold` 를 쓰도록 강제한다.
 *
 * threshold 를 63 으로 클램프하는 이유: 상한은 64 가 하드 실링이라, 임계가 64 이상이면
 * `limit === threshold` 가 되어 위와 같은 '판정 불가' 상태로 되돌아간다.
 */
export function traceLimits(maxHops) {
  const threshold = Math.min(63, Math.max(1, Number(maxHops) || 15));
  return { threshold, limit: threshold + 1 };   // limit ≤ 64
}

/** traceroute — CLI 호출. host 는 화이트리스트를 통과한 값만(명령 인젝션 방지). */
function traceroute(host, maxHops) {
  return new Promise((resolve, reject) => {
    if (!SAFE_HOST.test(host) || host.startsWith('-')) return reject(new Error('호스트 형식 위반'));
    const isWin = process.platform === 'win32';
    const cmd = isWin ? 'tracert' : 'traceroute';
    // 명령 상한은 임계보다 1 크게 — 목적지가 정확히 임계 홉에 있는 정상 경로를 '임계 초과'로
    // 오판하지 않게 한다(parseTraceroute ③ 주석 참고).
    const { threshold, limit } = traceLimits(maxHops);
    const args = isWin
      ? ['-d', '-h', String(limit), '-w', '1000', host]
      : ['-n', '-m', String(limit), '-w', '1', '-q', '1', host];
    execFile(cmd, args, { timeout: 25_000, maxBuffer: 256 * 1024 }, (err, stdout) => {
      const out = String(stdout || '');
      if (!out) return reject(err || new Error('traceroute 출력 없음'));
      // ⚠ 반드시 threshold(임계) — limit(명령 상한)을 넘기면 판정이 영구 거짓이 된다(위 주석).
      resolve(parseTraceroute(out, { maxHops: threshold, target: host }));
    });
  });
}

function certDaysLeft(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host, port, servername: host, rejectUnauthorized: false, timeout: timeoutMs });
    const fail = (e) => { try { sock.destroy(); } catch { /* noop */ } reject(e); };
    sock.once('secureConnect', () => {
      const cert = sock.getPeerCertificate();
      try { sock.destroy(); } catch { /* noop */ }
      if (!cert?.valid_to) return reject(new Error('인증서 정보 없음'));
      resolve(Math.floor((new Date(cert.valid_to).getTime() - Date.now()) / 86400000));
    });
    sock.once('timeout', () => fail(new Error('TLS 타임아웃')));
    sock.once('error', fail);
  });
}

/** SNTP 1회 질의 — 서버시각 − 로컬시각(ms). RFC 4330 48바이트. */
function ntpOffset(server, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const pkt = Buffer.alloc(48);
    pkt[0] = 0x1b;                       // LI=0, VN=3, Mode=3(client)
    const t1 = Date.now();
    const timer = setTimeout(() => { sock.close(); reject(new Error('NTP 타임아웃')); }, timeoutMs);
    sock.once('message', (msg) => {
      clearTimeout(timer);
      const t4 = Date.now();
      sock.close();
      if (msg.length < 48) return reject(new Error('NTP 응답 형식 오류'));
      const secs = msg.readUInt32BE(40) - 2208988800;
      const frac = msg.readUInt32BE(44) / 2 ** 32;
      resolve((secs + frac) * 1000 - (t1 + t4) / 2);
    });
    sock.once('error', (e) => { clearTimeout(timer); sock.close(); reject(e); });
    sock.send(pkt, 123, server, (e) => { if (e) { clearTimeout(timer); sock.close(); reject(e); } });
  });
}

/**
 * LDAP 익명 simple bind — BER 최소 인코딩.
 * SEQ{ msgID INT 1, [APP 0] BindRequest{ version INT 3, name "", [CTX 0] "" } }
 * 응답의 resultCode 0(success) 또는 49(invalidCredentials)/48(inappropriateAuth)면 서버가
 * 정상 응답한 것으로 본다(익명 bind 금지 서버도 '살아있음'으로 판정).
 */
function ldapBind(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const body = Buffer.concat([
      Buffer.from([0x02, 0x01, 0x03]),           // version 3
      Buffer.from([0x04, 0x00]),                 // name ""
      Buffer.from([0x80, 0x00]),                 // simple password ""
    ]);
    const bindReq = Buffer.concat([Buffer.from([0x60, body.length]), body]);
    const msg = Buffer.concat([Buffer.from([0x02, 0x01, 0x01]), bindReq]);
    const pdu = Buffer.concat([Buffer.from([0x30, msg.length]), msg]);
    const sock = net.connect({ host, port, timeout: timeoutMs });
    // done 가드 — data 로 resolve 하면 destroy→close 가 뒤따르므로 close 핸들러가 재차 reject 하지
    // 않게 막는다.
    let done = false;
    const settle = (fn, v) => { if (done) return; done = true; try { sock.destroy(); } catch { /* noop */ } fn(v); };
    const fail = (e) => settle(reject, e);
    sock.once('connect', () => sock.write(pdu));
    sock.once('data', (res) => {
      // 0x30(SEQ) … 0x61(BindResponse) 0xLL 0x0a 0x01 <resultCode>
      const i = res.indexOf(0x61);
      const code = (i >= 0 && res.length > i + 4) ? res[i + 4] : -1;
      settle(resolve, { ok: [0, 48, 49].includes(code), code });
    });
    sock.once('timeout', () => fail(new Error('LDAP 타임아웃')));
    sock.once('error', fail);
    // ⚠ CRITICAL 회귀 방지(v2.279): 서버가 데이터 없이 정상 종료(FIN)하면 과거엔 close 핸들러가
    // 없어(data/timeout/error 만 존재) Promise 가 영구 미해결 → 폴러 전체가 멈췄다. FIN 도 결말짓는다.
    sock.once('close', () => fail(new Error('LDAP 무응답(연결 종료)')));
  });
}

/** 도메인 만료 — whois(TCP 43) 조회 후 Expiry Date 파싱. IANA 참조 서버 1회 추적. */
async function domainDaysLeft(domain, timeoutMs) {
  if (!SAFE_HOST.test(domain)) throw new Error('도메인 형식 위반');
  const first = await whois('whois.iana.org', domain, timeoutMs);
  const refer = /refer:\s*(\S+)/i.exec(first)?.[1];
  const text = refer && SAFE_HOST.test(refer) ? await whois(refer, domain, timeoutMs) : first;
  const m = /(?:Registry Expiry Date|Expiration Date|paid-till|expires?(?: on)?)\s*:\s*(\S+)/i.exec(text);
  if (!m) return null;
  const t = new Date(m[1]).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((t - Date.now()) / 86400000);
}

function whois(server, query, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: server, port: 43, timeout: timeoutMs });
    let buf = '';
    sock.once('connect', () => sock.write(`${query}\r\n`));
    sock.on('data', (c) => { buf += c.toString('utf8'); if (buf.length > 65536) sock.destroy(); });
    sock.once('close', () => resolve(buf));
    sock.once('timeout', () => { try { sock.destroy(); } catch { /* noop */ } reject(new Error('whois 타임아웃')); });
    sock.once('error', reject);
  });
}
