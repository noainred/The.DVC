/**
 * sanswitch/precheck.js — 연결 사전 점검(v2.421): DNS 해석과 TCP 연결을 SSH/REST 와 **분리해서** 잰다.
 * "연결 테스트를 누르면 멈춘다"의 가장 흔한 실체는 TCP SYN 무응답(방화벽/경로/엣지 망) 인데, 그 경우
 * ssh2 readyTimeout(60초)까지 아무 로그 없이 기다리게 된다. 여기서 10초 안에 단계와 사유를 확정한다.
 * SSRF 검사는 호출자(deviceInputIssue)가 이미 했다 — 여기서는 도달성만 본다.
 */
import dns from 'node:dns';
import net from 'node:net';

export async function precheckTarget(host, port, { trace = null, timeoutMs = 10_000 } = {}) {
  const say = (m, lv) => { try { trace?.(m, lv); } catch { /* */ } };
  const t0 = Date.now();
  let address = host;
  if (!net.isIP(host)) {
    say(`DNS 해석: ${host}`);
    try {
      const r = await dns.promises.lookup(host);
      address = r.address;
      say(`DNS 해석 결과: ${host} → ${r.address} (IPv${r.family}) +${Date.now() - t0}ms`);
    } catch (e) {
      say(`DNS 해석 실패: ${e.code || ''} ${e.message} +${Date.now() - t0}ms`, 'error');
      return { ok: false, phase: 'dns', reason: `DNS 해석 실패: ${e.code || e.message}` };
    }
  }
  say(`TCP 연결 시도: ${address}:${port} (제한 ${Math.round(timeoutMs / 1000)}초)`);
  const t1 = Date.now();
  const r = await new Promise((resolve) => {
    const sock = net.connect({ host: address, port: Number(port) });
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; try { sock.destroy(); } catch { /* */ } resolve(v); };
    sock.setTimeout(Math.max(1000, timeoutMs), () => finish({ ok: false, reason: `TCP 연결 타임아웃(${Math.round(timeoutMs / 1000)}초) — SYN 에 응답 없음` }));
    sock.once('connect', () => finish({ ok: true, local: `${sock.localAddress}:${sock.localPort}` }));
    sock.once('error', (e) => finish({ ok: false, reason: `TCP 연결 실패: ${e.code || e.message}`, code: e.code }));
  });
  if (!r.ok) { say(`${r.reason} +${Date.now() - t1}ms`, 'error'); return { ok: false, phase: 'tcp', reason: r.reason, address }; }
  say(`TCP 연결 성공 (${r.local} → ${address}:${port}) +${Date.now() - t1}ms — 포트가 열려 있음. 이제 프로토콜 단계로 넘어갑니다.`);
  return { ok: true, address };
}
