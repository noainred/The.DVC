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
import { withSsrfLookup, ssrfLookup } from '../util/ssrfLookup.js';
import { pingOne } from '../util/ping.js';
import { ssrfBlockReasonResolved } from '../collector/registry.js';
// v2.603(SEC2603-03): 본문 앞부분 읽기는 util 하나(rma/testRunner.js 도 같은 헬퍼) — 재수출은 import+export 형태(v2.575)
import { readBodyPrefix } from '../util/readPrefix.js';
export { readBodyPrefix };

// v2.537: DNS 리바인딩(TOCTOU) 차단 — util/ssrfLookup.js 머리말. v2.506 배선(11곳)에서 빠져 있던 dispatcher. 저장 시점 ssrfBlockReason·실행 시점 ssrfBlockReasonResolved 는 **해석한 IP 로 접속하지 않으므로** 리바인딩 창이 남는다.
const insecureAgent = new Agent({ connect: withSsrfLookup({ rejectUnauthorized: false }) });
/*
 * ⚠⚠ v2.574 SEC-09 — **기본(TLS 검증) 경로에도 dispatcher 가 있어야 한다.**
 * v2.573 까지 `...(test.insecure ? { dispatcher: insecureAgent } : {})` 라, `insecure` 가 아닌
 * **기본 경로는 dispatcher 없이 전역 `fetch`** 로 나갔다. CLAUDE.md v2.506 이 직접 경고한 그것 —
 * "**`globalThis.fetch` 에는 lookup 이 없다**". 즉 이 저장소가 두 번(v2.506·v2.537) 배선한
 * 리바인딩 방어가 svcmon 의 **가장 흔한 경로에서만** 빠져 있었다.
 *
 * 실측(CLAUDE.md 가 정한 실증 기준 — `https://localhost:8443/`):
 *   · dispatcher 있음 → `fetch failed ← ESSRFBLOCKED` ✓ (접속 자체를 막았다)
 *   · dispatcher 없음 → `fetch failed ← ECONNREFUSED` ✗ (**연결이 실제로 시도됐다**)
 *
 * ⚠ v2.537 의 전수 스윕(`test/ssrfAgents2537.test.js`)은 `new Agent(` 를 훑어 **모든 Agent 에
 * 훅이 붙었는지** 본다 — 여기는 **Agent 를 아예 안 쓰던 경로**라 그 스윕의 사각지대였다.
 * ⚠ 이 Agent 는 `rejectUnauthorized` 를 건드리지 않는다(기본값 = 검증 ON). 검증 정책은 그대로 두고
 *   lookup 훅만 더하는 것이 이 수정의 전부다 — 여기서 TLS 를 느슨하게 만들지 말 것.
 */
const secureAgent = new Agent({ connect: withSsrfLookup({}) });
const SAFE_HOST = /^[a-zA-Z0-9._:-]+$/;
const shortErr = (e) => String(e?.cause?.code || e?.code || e?.message || e).slice(0, 140);

/**
 * DNS 점검의 질의 서버 → `Resolver.setServers` 가 받는 주소(v2.815).
 * ⚠ `setServers` 는 **IP 만** 받는다(호스트 이름이면 ERR_INVALID_IP_ADDRESS). 저장 검증(SAFE_HOST)은 이름을 허용하고 내장
 *   'DNS 서버' 템플릿은 `server: '{host}'` 라, 이름으로 등록한 대상의 DNS 점검이 **매번 bad** 였다(재현). 이름이면 먼저 해석한다 —
 *   시한 있는 검증 lookup(`ssrfLookup`, 3초 · 루프백·링크로컬 해석 차단)을 쓴다(server/CLAUDE.md — 핫패스에 시한 없는 DNS 금지).
 *   IP 리터럴(포트 포함)은 예전 그대로 넘긴다. `이름:포트` 는 해석한 IP 에 포트를 다시 붙인다.
 */
export async function dnsServerAddr(server, lookup = ssrfLookup) {
  const s = String(server ?? '').trim();
  if (!s) throw new Error('질의 서버가 비어 있습니다');
  if (net.isIP(s) || /^\[[0-9a-fA-F:.]+\]:\d{1,5}$/.test(s)) return s;
  const m = /^([^:]+):(\d{1,5})$/.exec(s);
  const name = m ? m[1] : s;
  const port = m ? m[2] : '';
  if (net.isIP(name)) return s;
  const { address, family } = await new Promise((resolve, reject) => {
    lookup(name, {}, (err, a, f) => (err ? reject(err) : resolve({ address: a, family: f })));
  });
  if (!port) return address;
  return family === 6 ? `[${address}]:${port}` : `${address}:${port}`;
}

/** 유형별 기본 포트 — 폼에서 비워두면 이 값을 쓴다. */
export const DEFAULT_PORTS = {
  smtp: 25, pop3: 110, imap: 143, ssh: 22, ldap: 389, cert: 443, domain: 43, ntp: 123, dns: 53,
};

// 점검 1건의 하드 데드라인(방어선) — 개별 소켓 타임아웃(대개 5초, cert/ntp 등도 수 초)보다 넉넉히
// 두어 정상 점검은 건드리지 않되, 어떤 이유로든 내부 Promise 가 결말나지 않으면 여기서 끊는다.
// traceroute(execFile 25초)·domain(whois 다단) 이 가장 길어 45초로 잡았다.
const RUNCHECK_HARD_TIMEOUT_MS = 45_000;

/** 키워드 검사가 읽는 본문 앞부분 상한(v2.603 SEC2603-03) — 넘는 부분은 읽지 않는다. */
export const KEYWORD_SCAN_BYTES = 256 * 1024;

/** 응답 본문을 버린다(읽지 않고 연결 정리). 실패는 무시 — 이미 소비됐거나 본문이 없다. */
function cancelBody(res) {
  try { res?.body?.cancel?.().catch?.(() => {}); } catch { /* */ }
}

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
        // v2.769(점검 R4-D3-6): RTT 를 못 읽었으면(출력 형식이 다른 OS·로케일) 0ms 가 아니다 — ms 는 null(CSV 빈 칸 · 분석 평균/p95 에서 제외).
        if (!r.alive) return bad('응답 없음', started);
        return r.rttMs != null ? ok(`${r.rttMs} ms`, r.rttMs) : ok('응답함 · RTT 미상', null);
      }
      case 'trace': {
        // 문구에도 **실제 적용된** 임계를 쓴다 — traceLimits 가 63 으로 클램프하므로(상한 64가
        // 하드실링), 원값을 그대로 찍으면 "임계(64) 내 미도달" 같은 자기모순 문구가 나온다.
        const hopLimit = traceLimits(test.maxHops).threshold;
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
          // ⚠ 두 갈래 **모두** dispatcher 를 준다 — 한쪽만 주면 그쪽만 리바인딩 방어가 산다(SEC-09).
          dispatcher: test.insecure ? insecureAgent : secureAgent,
        });
        const ms = Date.now() - started;
        const okStatus = test.expectStatus ? res.status === test.expectStatus : res.status < 500;
        if (!okStatus) { cancelBody(res); return { status: 'bad', reply: `HTTP ${res.status}`, ms }; }
        if (test.keyword) {
          // v2.603(감사 SEC2603-03): 예전에는 res.text() 로 본문 **전체**를 메모리로 읽은 뒤 잘랐다
          //   (실측 400MB 응답 한 번에 RSS 74 → 1,359MB). 이제 앞 256KB 까지만 스트림으로 읽고 끊는다 — 주석과 사실이 같다.
          const { text: body, capped } = await readBodyPrefix(res, KEYWORD_SCAN_BYTES);
          if (!body.includes(test.keyword)) {
            return { status: 'warn', reply: `HTTP ${res.status} · 키워드 없음${capped ? `(앞 ${Math.round(KEYWORD_SCAN_BYTES / 1024)}KB 만 확인)` : ''}`, ms };
          }
        } else cancelBody(res);   // 본문을 쓰지 않으면 읽지 않는다(연결만 정리)
        if (test.warnMs && ms > test.warnMs) return { status: 'warn', reply: `HTTP ${res.status} · ${ms}ms(느림)`, ms };
        return { status: 'ok', reply: `HTTP ${res.status} · ${ms}ms`, ms };
      }
      case 'dns': {
        const resolver = new Resolver({ timeout: 4000, tries: 1 });
        let serverAddr;
        try { serverAddr = await dnsServerAddr(test.server || host); }
        catch (e) { return bad(`질의 서버 이름 해석 실패: ${String(test.server || host).slice(0, 80)} (${shortErr(e)})`, started); }
        resolver.setServers([serverAddr]);
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
        // v2.744(감사 DEV-03): 응답 머리를 먼저 판정한다 — 미동기·KoD 응답의 시각은 오프셋으로 쓰지 않는다(judgeNtpReply 머리말).
        const q = await ntpQuery(test.server || host, 4000);
        // v2.744(회귀 검토 GH-R1): stratum 0 은 refid 로 가른 결과를 그대로 말한다 — '요청 거부' 는 RATE·DENY·RSTR 뿐이다.
        if (q.kind === 'kod') {
          return bad(q.refused
            ? `KoD(${q.code}) — 서버가 요청을 거부했습니다(${NTP_KOD_REFUSE[q.code]} · stratum 0)`
            : `KoD(${q.code}) — 서버가 시각을 주지 않았습니다(stratum 0)`, started);
        }
        if (q.kind === 'unsync') {
          if (q.code == null) return bad(`서버가 동기되지 않았습니다(stratum ${q.stratum} · LI ${q.li})`, started);
          const what = NTP_UNSYNC_CODE[q.code] || (q.code ? `refid ${q.code}` : 'refid 없음');
          return bad(`서버가 동기되지 않았습니다(stratum 0 · ${what} · LI ${q.li})`, started);
        }
        const offset = q.offset;
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
        // v2.743 DEV-01: 연결 종료 통지(ExtendedResponse)는 bind 응답이 아니다 — 그 사실을 문구에 남긴다.
        if (r.op === 'extended') return bad(`서버가 연결 종료를 통지했습니다 (resultCode ${r.code})`, started);
        // v2.744(감사 RECENT-04): 판정은 ldapBindVerdict 하나 — 'BindResponse 로 거부를 돌려준 것' 은 서버가 살아 있다는 뜻이다.
        const v = ldapBindVerdict(r.code);
        if (v === 'ok') return ok(`bind 성공 (resultCode ${r.code})`, Date.now() - started);
        if (v === 'credentials') return ok(`bind 거부(자격증명) — 서버는 응답 중 (resultCode ${r.code})`, Date.now() - started);
        if (v === 'policy') return ok(`bind 거부(정책) — 서버는 응답 중 (resultCode ${r.code})`, Date.now() - started);
        return bad(`bind 실패 (resultCode ${r.code})`, started);
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

/** NTP 시각(1900년 기준 초)과 Unix epoch(1970년)의 차 — RFC 5905. */
const NTP_EPOCH_OFFSET_S = 2208988800;

/**
 * v2.744(회귀 검토 GH-R1): stratum 0 응답의 refid → 뜻(judgeNtpReply 머리말).
 *   거부(KoD) — ntpd kiss_code_check 가 KoD 로 보는 세 코드. 화면 문구의 괄호 안 설명이기도 하다.
 *   미동기 — 그 상태의 이름인 코드(ntpd 첫 동기 전 'INIT' · 시계 step 뒤 재동기 전 'STEP').
 */
const NTP_KOD_REFUSE = Object.freeze({ RATE: '요청 빈도 제한', DENY: '접근 거부', RSTR: '접근 거부(정책)' });
const NTP_UNSYNC_CODE = Object.freeze({ INIT: 'INIT 첫 동기 전', STEP: 'STEP 시계 조정 뒤 재동기 전' });

/**
 * (순수) SNTP 서버 응답 머리 판정 — v2.744(감사 DEV-03).
 *   48바이트 = 0: LI(2비트)·VN(3)·Mode(3) · 1: stratum · 12~15: refid(KoD 코드) · 24~31: originate · 40~47: transmit.
 * 예전에는 길이만 보고 송신 타임스탬프(40~47)로 오프셋을 냈다. 그래서
 *   ① 상위 동기를 잃은 ntpd 의 응답(LI=3·stratum 16 — 로컬 시계로 계속 응답한다)이 '정상 · 오프셋 0ms' 였고
 *      (chronyd·ntpd·w32time 은 그런 서버를 시간 원천으로 받지 않는데 점검만 초록이었다)
 *   ② Kiss-o'-Death(stratum 0, 송신 타임스탬프 0)가 1900년 기준 '오프셋 −4조 ms' 로 보고됐고
 *   ③ 요청을 그대로 되돌리는 응답(mode 3)도 '오프셋 0ms' 였다.
 * 판정 순서(앞이 이긴다): 길이 → mode(4 = server 만) → stratum 0(refid 로 가른다 — 아래) → 원본 타임스탬프 대조
 *   → LI=3 또는 stratum ≥ 16(미동기) → 송신 타임스탬프 0(형식 오류) → 오프셋.
 * ⚠⚠ v2.744(회귀 검토 GH-R1): **stratum 0 이 곧 KoD(거부)는 아니다.** 실서버가 미동기일 때 싣는 값이 stratum 0 이다 —
 *   ntpd 는 STRATUM_UNSPEC(16)을 패킷에서 0 으로 바꾸고(include/ntp.h STRATUM_TO_PKT) 첫 동기 전에는 refid 'INIT',
 *   시계 step 뒤에는 'STEP' 을 싣는다(ntpd/ntp_proto.c 초기화·step 경로). chronyd 도 미동기면 stratum 16 → 0, refid 0
 *   (ntp_core.c transmit_packet 'Stratum 16 and larger are invalid' · reference.c NTP_REFID_UNSYNC)이다.
 *   ntpd 클라이언트 자신도 KoD 를 **LI 3 · stratum 0 · refid RATE·DENY·RSTR**(그리고 'X' 실험 코드)일 때만 KoD 로 본다
 *   (ntp_proto.c kiss_code_check). 예전 판정은 이 미동기 응답을 전부 '서버가 요청을 거부했습니다' 로 말해, 운영자가 상위 동기
 *   상실 대신 restrict·방화벽을 점검하게 만들었다(조치가 정반대). 그래서:
 *     · refid RATE·DENY·RSTR → {kind:'kod', refused:true}(거부 — 빈도 제한·접근 거부)
 *     · refid INIT·STEP(LI 무관 — 그 상태의 이름이다), 또는 refid 가 비었고 LI 3(chronyd 미동기) → {kind:'unsync', stratum:0, code}
 *     · 그 밖의 코드(AUTH·CRYP·NTSN …) → {kind:'kod', refused:false} — 원인을 단정하지 않는 중립 문구.
 *     LI 3 만으로는 가를 수 없다 — ntpd 의 RATE KoD 도 LI 3 이다(ntp_proto.c fast_xmit RES_KOD 분기).
 *   ⚠ 정직 기록: RFC 5905 원문은 이 환경에서 열지 못했다(프록시 403) — 위 판정은 ntpd·chronyd 원본 소스로 확인한 것이다.
 *   stratum 0 판정이 원본 대조보다 앞인 것은 그대로다(실서버의 KoD·미동기 응답은 둘 다 originate 를 요청의 송신 타임스탬프로
 *   채우므로 대조를 앞에 둬도 결과가 같지만, 판정 순서를 이 수정 범위 밖에서 바꾸지 않는다).
 * 원본 타임스탬프(24~31)는 서버가 요청의 송신 타임스탬프를 그대로 복사한 값이다(RFC 4330 §5). 다르면 이 요청의 응답이 아니다 —
 *   'mismatch' 를 돌려주고 호출부가 다음 패킷을 기다린다(실제 클라이언트도 그런 패킷을 버린다).
 * @param {Buffer} msg
 * @param {Buffer|null} sentTx 보낸 송신 타임스탬프 8바이트(없으면 대조하지 않는다)
 * @returns {{kind:'format', reason:string}|{kind:'kod', code:string, refused:boolean}|{kind:'mismatch'}
 *          |{kind:'unsync', stratum:number, li:number, code?:string}|{kind:'ok', stratum:number, li:number, serverMs:number}}
 *   unsync 의 code 는 stratum 0 일 때만 있다(refid ASCII — 비었으면 '').
 */
export function judgeNtpReply(msg, sentTx = null) {
  if (!msg || msg.length < 48) return { kind: 'format', reason: `길이 ${msg ? msg.length : 0}바이트 — 48바이트 미만` };
  const li = msg[0] >> 6;
  const mode = msg[0] & 7;
  const stratum = msg[1];
  if (mode !== 4) return { kind: 'format', reason: `mode ${mode} — 서버 응답(4)이 아님` };
  if (stratum === 0) {
    // KoD 코드는 refid 자리의 ASCII 4글자다(RATE·DENY·RSTR …). 인쇄 가능한 글자만 남긴다(응답 바이트를 그대로 화면에 싣지 않는다).
    const code = msg.subarray(12, 16).toString('latin1').replace(/[^\x21-\x7e]/g, '');
    // v2.744(회귀 검토 GH-R1): refid 로 가른다(머리말). 거부 코드만 '요청 거부' 다.
    if (Object.hasOwn(NTP_KOD_REFUSE, code)) return { kind: 'kod', code, refused: true };
    if (Object.hasOwn(NTP_UNSYNC_CODE, code) || (!code && li === 3)) return { kind: 'unsync', stratum: 0, li, code };
    return { kind: 'kod', code: code || '코드 없음', refused: false };
  }
  if (sentTx && !msg.subarray(24, 32).equals(sentTx)) return { kind: 'mismatch' };
  if (li === 3 || stratum >= 16) return { kind: 'unsync', stratum, li };
  const secs = msg.readUInt32BE(40);
  const fracRaw = msg.readUInt32BE(44);
  if (secs === 0 && fracRaw === 0) return { kind: 'format', reason: '송신 타임스탬프 0' };
  return { kind: 'ok', stratum, li, serverMs: (secs - NTP_EPOCH_OFFSET_S + fracRaw / 2 ** 32) * 1000 };
}

/** epoch ms → NTP 64비트 타임스탬프 8바이트. 아래 12비트는 무작위(같은 ms 의 두 요청을 응답에서 가르기 위해 — 1µs 미만이라 시각에는 영향이 없다). */
function ntpTimestamp(ms) {
  const b = Buffer.alloc(8);
  const secs = (Math.floor(ms / 1000) + NTP_EPOCH_OFFSET_S) % 2 ** 32;   // 2036년 era 경계에서 writeUInt32BE 가 던지지 않게
  const frac = ((Math.floor(((ms % 1000) / 1000) * 2 ** 32) & 0xfffff000) | Math.floor(Math.random() * 4096)) >>> 0;
  b.writeUInt32BE(secs, 0);
  b.writeUInt32BE(frac, 4);
  return b;
}

/**
 * SNTP 1회 질의(RFC 4330 48바이트) — 판정은 `judgeNtpReply`.
 * v2.744(감사 DEV-03): 요청에 송신 타임스탬프를 싣고 응답의 원본 타임스탬프와 대조한다. 대조가 맞지 않는 패킷은 버리고 기다린다 —
 *   시한까지 맞는 응답이 없고 맞지 않는 응답만 왔으면 그 사실을 사유로 말한다(조용한 '타임아웃' 으로 뭉개지 않는다).
 * ⚠ 소켓은 connect 하지 않는다(정직 기록) — 출처 주소를 고정하지 않으므로 원본 타임스탬프 대조가 '이 요청의 응답인가' 를 가린다.
 * @param {number} [port] 기본 123(점검 유형은 표준 포트만 쓴다 — test.port 를 읽지 않던 예전 동작 그대로)
 * @returns {Promise<{kind:'ok', offset:number, stratum:number}|{kind:'kod', code:string, refused:boolean}
 *          |{kind:'unsync', stratum:number, li:number, code?:string}>}
 */
export function ntpQuery(server, timeoutMs, port = 123) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const pkt = Buffer.alloc(48);
    pkt[0] = 0x1b;                       // LI=0, VN=3, Mode=3(client)
    const t1 = Date.now();
    const sentTx = ntpTimestamp(t1);
    sentTx.copy(pkt, 40);                // 송신 타임스탬프 — 서버가 응답의 원본 타임스탬프(24~31)로 되돌려 준다
    let mismatched = 0;
    let done = false;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); try { sock.close(); } catch { /* noop */ } fn(v); };
    const timer = setTimeout(() => finish(reject, new Error(mismatched
      ? `NTP 응답 ${mismatched}건이 보낸 요청과 맞지 않습니다(원본 타임스탬프 불일치 — 다른 요청의 응답이거나 위조)`
      : 'NTP 타임아웃')), timeoutMs);
    sock.on('message', (msg) => {
      if (done) return;
      const t4 = Date.now();
      const r = judgeNtpReply(msg, sentTx);
      if (r.kind === 'mismatch') { mismatched += 1; return; }   // 이 요청의 응답이 아니다 — 버리고 기다린다
      if (r.kind === 'format') return finish(reject, new Error(`NTP 응답 형식 오류(${r.reason})`));
      if (r.kind === 'kod') return finish(resolve, { kind: 'kod', code: r.code, refused: r.refused });
      if (r.kind === 'unsync') return finish(resolve, r);   // v2.744(회귀 검토 GH-R1): stratum 0 이면 code(refid)도 함께
      finish(resolve, { kind: 'ok', offset: r.serverMs - (t1 + t4) / 2, stratum: r.stratum });
    });
    sock.once('error', (e) => finish(reject, e));
    sock.send(pkt, port, server, (e) => { if (e) finish(reject, e); });
  });
}

/**
 * LDAP 응답 하나를 모으는 상한 — BindResponse 는 보통 수십 바이트다. 이보다 크다고 선언하면 기다리지 않고 실패로 본다.
 * (v2.743 DEV-01) 상한이 없으면 길이 칸이 큰 값을 선언한 응답이 소켓 시한까지 버퍼를 키운다.
 */
const LDAP_RESPONSE_MAX = 64 * 1024;

/**
 * (순수) BER 머리(tag + 길이) 하나를 읽는다 — v2.743 DEV-01.
 * 길이는 **단형**(0x00~0x7f — 그 값이 곧 길이)과 **장형**(0x81~0x84 — 낮은 7비트가 뒤따르는 길이 바이트 수)이 있다.
 * 0x80(부정 길이)은 LDAP 이 금지한다(RFC 4511 §5.1 — 확정 길이만) → 형식 오류. 5바이트 이상 길이도 형식 오류로 본다.
 * @returns {{need:true}|{bad:string}|{tag:number, start:number, end:number}}  start/end = 내용의 [시작, 끝)
 */
export function berHeader(buf, off) {
  if (buf.length < off + 2) return { need: true };
  const tag = buf[off];
  const l0 = buf[off + 1];
  if (l0 < 0x80) return { tag, start: off + 2, end: off + 2 + l0 };
  if (l0 === 0x80) return { bad: '부정 길이(0x80) — LDAP 은 확정 길이만 쓴다' };
  const n = l0 & 0x7f;
  if (n > 4) return { bad: `길이 칸 ${n}바이트 — 지원하지 않는 길이` };
  if (buf.length < off + 2 + n) return { need: true };
  let len = 0;
  for (let i = 0; i < n; i++) len = len * 256 + buf[off + 2 + i];
  return { tag, start: off + 2 + n, end: off + 2 + n + len };
}

/**
 * (순수) LDAP 메시지 하나(BindResponse)에서 resultCode 를 읽는다 — v2.743 DEV-01.
 *   LDAPMessage ::= SEQUENCE(0x30) { messageID INTEGER(0x02), protocolOp [APPLICATION n], … }
 *   BindResponse = [APPLICATION 1](0x61) { resultCode ENUMERATED(0x0a), matchedDN, diagnosticMessage, … }
 * ⚠⚠ 예전 판정은 `indexOf(0x61)` 위치에서 **4바이트 뒤**를 resultCode 로 읽었다. 그것은 길이가 **단형일 때만** 맞다 —
 *   AD 는 길이를 **장형(0x84 + 4바이트)** 으로 보내므로 그 자리는 길이 셋째 바이트(늘 0x00)였고, resultCode 53·8 같은
 *   실패가 'bind 성공 (resultCode 0)' 으로 보고됐다. 이제 길이를 해석해 정확한 위치에서 읽는다.
 * 같은 이유로 ExtendedResponse(0x78 — 서버가 끊기 전에 보내는 연결 종료 통지)도 LDAPResult 를 먼저 싣는다 — 그 resultCode 를 읽되
 *   bind 응답이 아니라고 밝힌다(op 'extended').
 * @returns {{need:true}|{bad:string}|{op:'bind'|'extended', code:number, msgId:number|null}}
 */
export function parseLdapResponse(buf) {
  const msg = berHeader(buf, 0);
  if (msg.need || msg.bad) return msg;
  if (msg.tag !== 0x30) return { bad: `LDAPMessage(0x30)가 아님 (0x${msg.tag.toString(16)})` };
  if (msg.end - msg.start > LDAP_RESPONSE_MAX) return { bad: `응답 길이 ${msg.end - msg.start}바이트 — 상한 초과` };
  if (buf.length < msg.end) return { need: true };
  const id = berHeader(buf, msg.start);
  if (id.need || id.end > msg.end) return { bad: '응답이 messageID 앞에서 끝났다' };
  if (id.bad) return id;
  if (id.tag !== 0x02) return { bad: `messageID(INTEGER) 자리에 0x${id.tag.toString(16)}` };
  let msgId = null;
  if (id.end - id.start >= 1 && id.end - id.start <= 4) { msgId = 0; for (let i = id.start; i < id.end; i++) msgId = msgId * 256 + buf[i]; }
  const op = berHeader(buf, id.end);
  if (op.need || op.end > msg.end) return { bad: '응답이 protocolOp 앞에서 끝났다' };
  if (op.bad) return op;
  if (op.tag !== 0x61 && op.tag !== 0x78) return { bad: `BindResponse(0x61)가 아님 (0x${op.tag.toString(16)})` };
  const rc = berHeader(buf, op.start);
  if (rc.need || rc.end > op.end) return { bad: '응답이 resultCode 앞에서 끝났다' };
  if (rc.bad) return rc;
  const n = rc.end - rc.start;
  if (rc.tag !== 0x0a || n < 1 || n > 4) return { bad: `resultCode(ENUMERATED) 자리에 0x${rc.tag.toString(16)}/${n}바이트` };
  let code = 0;
  for (let i = rc.start; i < rc.end; i++) code = code * 256 + buf[i];
  return { op: op.tag === 0x61 ? 'bind' : 'extended', code, msgId };
}

/**
 * (순수) 익명 simple bind 의 BindResponse resultCode → 점검 판정 — v2.744(감사 RECENT-04).
 * 이 점검은 **살아 있음(liveness)** 점검이다 — 익명 bind 로 '서버가 LDAP 으로 정상 응답하는가' 만 본다(계정 검증이 아니다).
 *   · 'ok'          0(success)
 *   · 'credentials' 48(inappropriateAuthentication)·49(invalidCredentials) — 익명 bind 를 금지한 서버의 정상 응답(원래 설계)
 *   · 'policy'      8(strongerAuthRequired — LDAP 서명을 요구하는 DC 가 평문 simple bind 를 거부)·53(unwillingToPerform — 익명 bind 금지 정책).
 *                   서버가 BindResponse 로 **정책 거부를 돌려준 것**이라 48·49 와 같은 성격이다. v2.743 DEV-01 이 장형 BER 을 읽게 되며
 *                   AD 의 8·53 이 처음으로 정확히 읽혔는데, 그것을 'bad' 로 두면 서명 필수 DC 가 업그레이드 직후 일제히 '장애' 가 된다.
 *   · 'bad'         51(busy)·52(unavailable)·그 밖의 코드 — 서버가 요청을 처리하지 못하는 상태다.
 * 형식 오류·연결 종료 통지(ExtendedResponse)·무응답·잘린 응답은 이 함수에 오기 전에 실패다(ldapBind·runCheckInner).
 * ⚠ 실제 AD 가 익명 bind 에 8 을 돌려주는지는 실장비로 확인하지 못했다(정직 기록) — 돌려준다면 이 판정이 맞다.
 */
export const LDAP_BIND_CODES = Object.freeze({ ok: [0], credentials: [48, 49], policy: [8, 53] });
export function ldapBindVerdict(code) {
  for (const k of ['ok', 'credentials', 'policy']) if (LDAP_BIND_CODES[k].includes(code)) return k;
  return 'bad';
}

/**
 * LDAP 익명 simple bind — BER 최소 인코딩.
 * SEQ{ msgID INT 1, [APP 0] BindRequest{ version INT 3, name "", [CTX 0] "" } }
 * 응답의 resultCode 판정은 `ldapBindVerdict`(0·48·49·8·53 = 서버가 정상 응답 — 익명 bind 금지 서버도 '살아있음').
 * v2.743 DEV-01: 응답은 **여러 조각으로 올 수 있다** — 메시지 길이만큼 모일 때까지 모으고(`parseLdapResponse`),
 *   모이기 전에 연결이 끝나면 '응답이 잘렸다' 로 실패한다(앞부분만 보고 판정하지 않는다).
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
    let got = Buffer.alloc(0);
    const settle = (fn, v) => { if (done) return; done = true; try { sock.destroy(); } catch { /* noop */ } fn(v); };
    const fail = (e) => settle(reject, e);
    sock.once('connect', () => sock.write(pdu));
    sock.on('data', (chunk) => {
      if (done) return;
      got = got.length ? Buffer.concat([got, chunk]) : chunk;
      const r = parseLdapResponse(got);
      if (r.need) {
        if (got.length > LDAP_RESPONSE_MAX + 16) fail(new Error('LDAP 응답 과대(상한 초과)'));
        return;   // 메시지 길이만큼 모일 때까지 기다린다(시한·연결 종료가 결말짓는다)
      }
      if (r.bad) { fail(new Error(`LDAP 응답 형식 오류(${r.bad})`)); return; }
      settle(resolve, { ok: r.op === 'bind' && ldapBindVerdict(r.code) !== 'bad', code: r.code, op: r.op });
    });
    sock.once('timeout', () => fail(new Error(got.length ? `LDAP 타임아웃(응답 ${got.length}바이트에서 멈춤)` : 'LDAP 타임아웃')));
    sock.once('error', fail);
    // ⚠ CRITICAL 회귀 방지(v2.279): 서버가 데이터 없이 정상 종료(FIN)하면 과거엔 close 핸들러가
    // 없어(data/timeout/error 만 존재) Promise 가 영구 미해결 → 폴러 전체가 멈췄다. FIN 도 결말짓는다.
    // v2.743 DEV-01: 응답 일부만 받고 끝나면 '잘린 응답' 이다 — 앞부분으로 판정하지 않는다.
    sock.once('close', () => fail(new Error(got.length ? `LDAP 응답이 잘렸습니다(${got.length}바이트 수신 뒤 연결 종료)` : 'LDAP 무응답(연결 종료)')));
  });
}

/** 도메인 만료 — whois(TCP 43) 조회 후 Expiry Date 파싱. IANA 참조 서버 1회 추적. */
async function domainDaysLeft(domain, timeoutMs) {
  if (!SAFE_HOST.test(domain)) throw new Error('도메인 형식 위반');
  const first = await whois('whois.iana.org', domain, timeoutMs);
  const refer = /refer:\s*(\S+)/i.exec(first)?.[1];
  const text = refer && SAFE_HOST.test(refer) ? await whois(refer, domain, timeoutMs) : first;
  const t = parseWhoisExpiry(text);
  if (t == null) return null;
  return Math.floor((t - Date.now()) / 86400000);
}

/**
 * WHOIS 응답 → 만료 시각(ms) 또는 null(v2.815).
 * ⚠ 예전에는 `:\s*(\S+)` 로 **공백 전까지만** 잘라 `new Date()` 에 넘겼다. KISA(whois.kr)의 만료일 줄은
 *   `Expiration Date : 2027. 03. 15.` 형식이라 `'2027.'` 만 잡혀 V8 이 **그해 1월 1일**로 읽었다(파싱 재현 — 연중 만료 .kr 도메인이
 *   1월 1일부터 '만료됨'). 줄 끝까지 잡고 `YYYY. MM. DD.`·`YYYY/MM/DD`·`YYYY-MM-DD` 를 먼저 읽고, 그 밖(ISO 시각 등)은 예전처럼 첫 토큰을 Date 로 읽는다.
 *   ⚠ whois.kr 의 실제 응답은 이 환경에서 접속하지 못해 실측하지 못했다(공개된 형식 기준).
 */
export function parseWhoisExpiry(text) {
  const m = /(?:Registry Expiry Date|Expiration Date|paid-till|expires?(?: on)?)[ \t]*:[ \t]*([^\r\n]{1,80})/i.exec(String(text ?? ''));
  if (!m) return null;
  const v = m[1].trim();
  const ymd = /^(\d{4})[ \t]*[./-][ \t]*(\d{1,2})[ \t]*[./-][ \t]*(\d{1,2})\.?(?=$|[ \t])/.exec(v);
  if (ymd) {
    const y = Number(ymd[1]); const mo = Number(ymd[2]); const d = Number(ymd[3]);
    const t = Date.UTC(y, mo - 1, d);
    const back = new Date(t);
    // 2027. 02. 31. 같은 없는 날은 Date.UTC 가 다음 달로 넘긴다 — 믿지 않는다.
    if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
    return t;
  }
  const t = new Date(v.split(/[ \t]/)[0]).getTime();
  return Number.isFinite(t) ? t : null;
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
