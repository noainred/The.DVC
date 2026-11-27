/**
 * svcstatus/probe.js — 대상 하나의 **TCP 연결 측정**(v3.54 — 중앙 폴러 · 엣지 워커가 같은 함수를 쓴다).
 *
 * 무엇을 재나: 등록된 주소:포트로 TCP 연결이 맺어지기까지의 시간(ms). 로그인 · API 응답 · 장비 건강은 **보지 않는다**
 * (화면 첫 문단이 밝힌다 — 5분 주기 로그인은 계정 잠금 위험이고, 이 기능의 질문은 '포탈이 그 포트에 닿는가' 다).
 *
 * ⚠ DNS 를 먼저 따로 풀고 **그 주소로 붙는다**(`linkcheck/checks.js stepDns → stepTcp` — 시한 있는 lookup + 차단 대역 거름 + 핀).
 *   server/CLAUDE.md 'SSRF 재검증에 타임아웃 없는 DNS 조회를 핫패스에 넣지 말 것' · '외부 입력 host 를 찌르는 신규 기능은 SSRF 가드 통과' 규약.
 * ⚠ 연결 시간은 TCP 단계만이다(DNS 시간을 더하지 않는다 — 이름 해석이 느린 날 '지연' 으로 보이지 않게).
 * ⚠ 던지지 않는다 — 예외는 `{ ok:false, fk:'unknown' }`(측정 실패로 센다).
 */
import { stepDns, stepTcp } from '../linkcheck/checks.js';

export const DNS_TIMEOUT_MS = 3_000;

/**
 * @param {{host:string, port:number}} target
 * @param {{timeoutMs:number, dnsTimeoutMs?:number}} opts
 * @returns {Promise<{ok:boolean, ms:number|null, fk:string|null}>}
 */
export async function probeTcp(target, { timeoutMs = 2_500, dnsTimeoutMs = DNS_TIMEOUT_MS } = {}) {
  const host = String(target?.host ?? '').trim();
  const port = Number(target?.port);
  if (!host) return { ok: false, ms: null, fk: 'dns-fail' };
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, ms: null, fk: 'unknown' };
  try {
    const d = await stepDns(host, { timeoutMs: dnsTimeoutMs });
    if (!d.ok) return { ok: false, ms: null, fk: d.failKind || 'dns-fail' };
    const c = await stepTcp(d.addrs[0], port, { timeoutMs });
    if (c.ok) return { ok: true, ms: Math.max(0, Math.round(Number(c.ms) || 0)), fk: null };
    return { ok: false, ms: null, fk: c.failKind || 'unknown' };
  } catch {
    return { ok: false, ms: null, fk: 'unknown' };
  }
}
