/**
 * 중계 경로 단계별 진단 — vCenter(또는 중계 HAProxy 엔드포인트)에 대해 TCP 연결 → TLS
 * 핸드셰이크 → HTTP 응답을 각각 짧은 타임아웃으로 분리 테스트한다. "telnet은 되는데 포탈은
 * 멈춤"처럼 어느 단계에서 막혔는지(예: TCP는 OK인데 TLS 무응답 = HAProxy frontend만 살고
 * backend 끊김)를 화면에서 바로 짚게 한다.
 */

import net from 'node:net';
import tls from 'node:tls';
import https from 'node:https';

function tcpStep(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = net.connect({ host, port });
    let settled = false;
    const done = (r) => { if (settled) return; settled = true; try { sock.destroy(); } catch { /* */ } resolve({ ...r, ms: Date.now() - t0 }); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done({ ok: true }));
    sock.once('timeout', () => done({ ok: false, error: 'TCP 연결 시간 초과(포트 미개방/방화벽/호스트 다운)' }));
    sock.once('error', (e) => done({ ok: false, error: e.message }));
  });
}

function tlsStep(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let settled = false;
    const done = (r) => { if (settled) return; settled = true; try { sock.destroy(); } catch { /* */ } resolve({ ...r, ms: Date.now() - t0 }); };
    const sock = tls.connect(
      { host, port, servername: host, rejectUnauthorized: false, minVersion: 'TLSv1', ciphers: 'DEFAULT@SECLEVEL=0', timeout: timeoutMs },
      () => { const c = sock.getPeerCertificate(); done({ ok: true, protocol: sock.getProtocol(), cert: c && c.subject ? { cn: c.subject.CN || '', issuer: c.issuer?.CN || '', validTo: c.valid_to || '' } : null }); },
    );
    sock.setTimeout(timeoutMs);
    sock.once('timeout', () => done({ ok: false, error: 'TLS 핸드셰이크 무응답(시간 초과) — TCP는 받지만 암호화 응답이 없음. 중계(HAProxy) frontend만 살아있고 backend(vCenter)로 전달이 끊긴 상태로 의심됩니다.' }));
    sock.once('error', (e) => done({ ok: false, error: e.message }));
  });
}

function httpStep(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let settled = false;
    const done = (r) => { if (settled) return; settled = true; resolve({ ...r, ms: Date.now() - t0 }); };
    const req = https.request(
      { host, port, path: '/sdk', method: 'GET', rejectUnauthorized: false, servername: host, timeout: timeoutMs },
      (res) => { done({ ok: true, status: res.statusCode }); res.resume(); req.destroy(); },
    );
    req.on('timeout', () => { req.destroy(); done({ ok: false, error: 'HTTP 응답 시간 초과 — TLS는 되나 vCenter 서비스(vpxd)/경로 응답이 없음' }); });
    req.on('error', (e) => done({ ok: false, error: e.message }));
    req.end();
  });
}

/** host(스킴 제거), port(기본 443)에 대해 3단계 테스트. timeoutMs는 단계별 상한. */
export async function probeRelayPath(rawHost, { timeoutMs = 6000 } = {}) {
  const clean = String(rawHost || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const host = clean.split(':')[0];
  const port = Number(clean.split(':')[1]) || 443;
  const steps = { tcp: null, tls: null, http: null };

  steps.tcp = await tcpStep(host, port, timeoutMs);
  if (steps.tcp.ok) steps.tls = await tlsStep(host, port, timeoutMs);
  if (steps.tls?.ok) steps.http = await httpStep(host, port, timeoutMs);

  let verdict;
  if (!steps.tcp.ok) verdict = { state: 'tcp', text: 'TCP 연결 자체가 안 됩니다 — 포트 닫힘/방화벽/호스트 다운. 중계/대상 주소를 확인하세요.' };
  else if (steps.tls && !steps.tls.ok) verdict = { state: 'tls', text: '핵심: TCP는 되는데 TLS 응답이 없습니다. 중계(HAProxy) frontend는 TCP만 받고 backend(vCenter)로 전달이 끊긴 상태가 가장 유력합니다 → 중계 서버에서 HAProxy backend UP 여부 확인 후 systemctl restart haproxy.' };
  else if (steps.http && !steps.http.ok) verdict = { state: 'http', text: 'TLS는 되는데 HTTP 응답이 없습니다 — vCenter 서비스(vpxd) 지연/중단 또는 경로 문제.' };
  else verdict = { state: 'ok', text: '정상 — TCP·TLS·HTTP 모두 응답합니다. 일시적 문제였거나 다음 주기에 복구됩니다.' };

  return { host, port, steps, verdict };
}
