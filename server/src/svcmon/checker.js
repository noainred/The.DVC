/**
 * 성능점검 실행기 — 표준 라이브러리만으로 6종 점검(ping/tcp/http/dns/cert/ntp).
 * 모든 실패는 격리되어 { status:'bad', reply } 로 떨어진다(폴러가 개별 오류로 죽지 않게).
 *
 * 보안: 대상 host/url 은 저장 시 ssrfBlockReason 을 통과했지만, DNS 가 나중에 바뀌는 경우가
 * 있어 http 는 실행 직전에도 재검증한다(허브 웹훅과 같은 규칙). TLS 검증 해제(insecure)는
 * 그 요청의 로컬 디스패처에만 적용 — 전역 디스패처 오염 금지(CLAUDE.md 불변조건).
 */

import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import { Resolver } from 'node:dns/promises';
import { Agent } from 'undici';
import { pingOne } from '../util/ping.js';
import { ssrfBlockReason } from '../collector/registry.js';

const insecureAgent = new Agent({ connect: { rejectUnauthorized: false } }); // http insecure 전용(로컬 주입)

/** 단일 점검 실행 → { status:'ok'|'warn'|'bad', reply, ms }. */
export async function runCheck(test, host) {
  const started = Date.now();
  try {
    switch (test.type) {
      case 'ping': {
        const r = await pingOne(host, { timeoutMs: 4000 });
        return r.alive
          ? { status: 'ok', reply: `${r.rttMs ?? 0} ms`, ms: r.rttMs ?? 0 }
          : { status: 'bad', reply: '응답 없음', ms: Date.now() - started };
      }
      case 'tcp': {
        const ok = await tcpPort(host, test.port, 4000);
        return ok
          ? { status: 'ok', reply: `포트 ${test.port} 열림`, ms: Date.now() - started }
          : { status: 'bad', reply: `포트 ${test.port} 연결 실패`, ms: Date.now() - started };
      }
      case 'http': {
        const reason = ssrfBlockReason(test.url);
        if (reason) return { status: 'bad', reply: `차단: ${reason}`, ms: 0 };
        const res = await fetch(test.url, {
          redirect: 'manual',
          signal: AbortSignal.timeout(6000),
          ...(test.insecure ? { dispatcher: insecureAgent } : {}),
        });
        const ms = Date.now() - started;
        const okStatus = test.expectStatus ? res.status === test.expectStatus : res.status < 500;
        if (!okStatus) return { status: 'bad', reply: `HTTP ${res.status}`, ms };
        if (test.keyword) {
          const body = (await res.text()).slice(0, 262144); // 256KB 상한 — 대용량 응답 방어
          if (!body.includes(test.keyword)) return { status: 'warn', reply: `HTTP ${res.status} · 키워드 없음`, ms };
        }
        return { status: 'ok', reply: `HTTP ${res.status} · ${ms}ms`, ms };
      }
      case 'dns': {
        const resolver = new Resolver({ timeout: 4000, tries: 1 });
        if (test.server) resolver.setServers([test.server]);
        else resolver.setServers([host]);           // 대상 host = 검사할 DNS 서버
        const name = test.record || 'localhost';
        const addrs = await resolver.resolve4(name).catch(() => resolver.resolve6(name));
        const ms = Date.now() - started;
        return addrs?.length
          ? { status: 'ok', reply: `${name} → ${addrs[0]} · ${ms}ms`, ms }
          : { status: 'bad', reply: '결과 없음', ms };
      }
      case 'cert': {
        const days = await certDaysLeft(host, test.port || 443, 6000);
        const ms = Date.now() - started;
        if (days < 0) return { status: 'bad', reply: `만료됨 (${-days}일 경과)`, ms };
        if (days <= (test.warnDays || 30)) return { status: 'warn', reply: `D-${days}`, ms };
        return { status: 'ok', reply: `D-${days}`, ms };
      }
      case 'ntp': {
        const offsetMs = await ntpOffset(test.server || host, 4000);
        const ms = Date.now() - started;
        const abs = Math.abs(offsetMs);
        if (abs > 5000) return { status: 'bad', reply: `오프셋 ${Math.round(offsetMs)}ms`, ms };
        if (abs > 1000) return { status: 'warn', reply: `오프셋 ${Math.round(offsetMs)}ms`, ms };
        return { status: 'ok', reply: `오프셋 ${Math.round(offsetMs)}ms`, ms };
      }
      default:
        return { status: 'bad', reply: `알 수 없는 점검 유형: ${test.type}`, ms: 0 };
    }
  } catch (e) {
    return { status: 'bad', reply: shortErr(e), ms: Date.now() - started };
  }
}

const shortErr = (e) => String(e?.cause?.code || e?.code || e?.message || e).slice(0, 120);

function tcpPort(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port, timeout: timeoutMs });
    const done = (v) => { try { sock.destroy(); } catch { /* noop */ } resolve(v); };
    sock.once('connect', () => done(true));   // 연결 후 바이트를 보내지 않는다(대상 로그 오염 방지)
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
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

/** SNTP 1회 질의 — 서버시각-로컬시각 오프셋(ms). RFC 4330 48바이트 패킷. */
function ntpOffset(server, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const pkt = Buffer.alloc(48);
    pkt[0] = 0x1b; // LI=0, VN=3, Mode=3(client)
    const t1 = Date.now();
    const timer = setTimeout(() => { sock.close(); reject(new Error('NTP 타임아웃')); }, timeoutMs);
    sock.once('message', (msg) => {
      clearTimeout(timer);
      const t4 = Date.now();
      sock.close();
      if (msg.length < 48) return reject(new Error('NTP 응답 형식 오류'));
      // Transmit Timestamp(40..47): NTP epoch(1900) 초 + 분수
      const secs = msg.readUInt32BE(40) - 2208988800;
      const frac = msg.readUInt32BE(44) / 2 ** 32;
      const serverMs = (secs + frac) * 1000;
      resolve(serverMs - (t1 + t4) / 2);
    });
    sock.once('error', (e) => { clearTimeout(timer); sock.close(); reject(e); });
    sock.send(pkt, 123, server, (e) => { if (e) { clearTimeout(timer); sock.close(); reject(e); } });
  });
}
