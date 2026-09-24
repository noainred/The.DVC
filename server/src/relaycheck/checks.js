/**
 * relaycheck/checks.js — 점검 실행기(v2.429). 종류별로 TCP → 프로토콜 단계 → 정체 대조까지 한 번에 판정한다.
 * 반환 { ok, phase, ms, detail, error, got }. phase: refused|timeout|unreach|tls|http|identity|auth|hq|banner|ok
 */
import net from 'node:net';
import { probeRelayPath } from '../vcenter/relayProbe.js';
import { identityIssue } from '../collector/registry.js';
import { instanceId } from '../instanceId.js';
// v2.506(적대적 검증): 전역 fetch 는 lookup 이 없어 수집 토큰이 리바인딩된 주소로 나갈 수 있었다.
import { resilientFetch } from '../util/resilientFetch.js';
import { ssrfLookup } from '../util/ssrfLookup.js';
import { readJsonCapped } from '../util/readCapped.js';

// v2.605(감사 LEFT2605-01 — 재현): 이 점검은 **주기 폴러**(relaycheck/poller.js startAdaptiveTimer)가 돈다 — 관리자 수동 실행만이 아니다.
//   ping·health 응답은 수 KB 인데 fetch 의 json 읽기는 해제 후 크기 상한이 없어 150MB 응답에 중앙 RSS 70 → 693MB 였다. 상한까지만 읽는다.
export const RELAY_PING_MAX_BYTES = 256 * 1024;
const readPing = (r) => readJsonCapped(r, RELAY_PING_MAX_BYTES, '포탈 응답').then((j) => (j && typeof j === 'object' && !Array.isArray(j) ? j : {})).catch(() => ({}));

function tcp(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    // v2.506: DNS 리바인딩 차단(util/ssrfLookup.js) — 중계 점검도 외부 입력 host 로 붙는다.
    const sock = net.connect({ host, port, lookup: ssrfLookup });
    let done = false;
    const fin = (r) => { if (done) return; done = true; try { sock.destroy(); } catch { /* */ } resolve({ ...r, ms: Date.now() - t0 }); };
    sock.setTimeout(timeoutMs, () => fin({ ok: false, phase: 'timeout', error: `TCP 연결 타임아웃(${Math.round(timeoutMs / 1000)}초)` }));
    sock.once('connect', () => fin({ ok: true }));
    sock.once('error', (e) => fin({ ok: false, phase: e.code === 'ECONNREFUSED' ? 'refused' : /EHOSTUNREACH|ENETUNREACH/.test(e.code || '') ? 'unreach' : 'timeout', error: `${e.code || e.message}` }));
  });
}

/** SSH 배너 수신 상한(v2.607 SEC2607-01) — RFC 4253 배너 줄은 255자 이하이고 그 앞 안내 줄도 짧다. */
export const SSH_BANNER_MAX_BYTES = 2048;

function sshBanner(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    // v2.506: DNS 리바인딩 차단(util/ssrfLookup.js) — 중계 점검도 외부 입력 host 로 붙는다.
    const sock = net.connect({ host, port, lookup: ssrfLookup });
    let done = false; let buf = '';
    const fin = (r) => { if (done) return; done = true; clearTimeout(hard); try { sock.destroy(); } catch { /* */ } resolve({ ...r, ms: Date.now() - t0 }); };
    const onTimeout = () => fin({ ok: false, phase: buf ? 'banner' : 'timeout', error: buf ? `SSH 배너가 아님: ${buf.slice(0, 40)}` : 'TCP/배너 타임아웃' });
    // v2.607 SEC2607-01: sock.setTimeout 은 **유휴** 시한이라 대상이 개행 없이 계속 보내면 발화하지 않았다(재현: 1초 시한이
    //   12MB 동안 4초, 계속 보내면 끝나지 않음). 절대 시한을 따로 건다 — 주기 폴러의 재진입 가드가 영원히 잡히지 않게.
    const hard = setTimeout(onTimeout, timeoutMs);
    hard.unref?.();
    sock.setTimeout(timeoutMs, onTimeout);
    // v2.607 SEC2607-01: 수신 상한(SSH_BANNER_MAX_BYTES) + 개행은 **새 청크에서만** 찾는다 — 예전엔 buf 를 무상한으로 쌓고
    //   청크마다 전체를 다시 훑었다(O(n²) · 48MB 에 RSS 70 → 311MB). RFC 4253 의 배너 줄은 255자 이하다.
    sock.on('data', (d) => {
      if (done) return;
      const s = d.toString('latin1', 0, Math.min(d.length, SSH_BANNER_MAX_BYTES - buf.length + 1));
      const nl = s.indexOf('\n');
      buf += nl >= 0 ? s.slice(0, nl + 1) : s;
      if (nl >= 0) return fin(buf.startsWith('SSH-') ? { ok: true, detail: buf.trim().slice(0, 60) } : { ok: false, phase: 'banner', error: `SSH 배너가 아님: ${buf.trim().slice(0, 40)}` });
      if (buf.length > SSH_BANNER_MAX_BYTES) fin({ ok: false, phase: 'banner', error: `SSH 배너가 아님(개행 없이 ${SSH_BANNER_MAX_BYTES}B 초과): ${buf.slice(0, 40)}` });
    });
    sock.once('error', (e) => fin({ ok: false, phase: e.code === 'ECONNREFUSED' ? 'refused' : 'timeout', error: `${e.code || e.message}` }));
  });
}

async function portalPing(host, port, { token, expectAgent, otherIds = [], timeoutMs }) {
  const t0 = Date.now();
  const base = `http://${host}:${port}`;
  try {
    if (token) {
      const r = await resilientFetch(`${base}/api/collector/ping`, { headers: { Accept: 'application/json', 'X-Collector-Token': token }, timeoutMs, retries: 0 });
      if (r.status === 403 || r.status === 401) return { ok: false, phase: 'auth', error: 'HTTP 403 토큰 거부', ms: Date.now() - t0 };
      if (r.status === 404) return { ok: false, phase: 'auth', error: 'HTTP 404 — 응답 포탈에 COLLECTOR_TOKEN 미설정(또는 포탈 아님)', ms: Date.now() - t0 };
      if (!r.ok) return { ok: false, phase: 'http', error: `HTTP ${r.status}`, ms: Date.now() - t0 };
      const j = await readPing(r);
      const iss = expectAgent ? identityIssue({ id: expectAgent, name: expectAgent }, j, otherIds) : null;
      if (iss) return { ok: false, phase: 'identity', error: iss.reason, got: { agent: j.agent, hostname: j.hostname }, ms: Date.now() - t0 };
      return { ok: true, detail: `응답 ${j.agent || '(이름 없음)'}${j.hostname ? `(${j.hostname})` : ''} v${j.version || '?'}`, got: { agent: j.agent, hostname: j.hostname }, ms: Date.now() - t0 };
    }
    const r = await resilientFetch(`${base}/api/health`, { headers: { Accept: 'application/json' }, timeoutMs, retries: 0 });
    if (!r.ok) return { ok: false, phase: 'http', error: `HTTP ${r.status}`, ms: Date.now() - t0 };
    const j = await readPing(r);
    return { ok: true, detail: `health 200 v${j.version || '?'}`, got: { instance: j.instance, agent: j.agent }, ms: Date.now() - t0 };
  } catch (e) {
    const code = e?.cause?.code || e?.code || '';
    return { ok: false, phase: code === 'ECONNREFUSED' ? 'refused' : /timeout|abort/i.test(e.name || e.message) ? 'timeout' : 'http', error: code || e.message, ms: Date.now() - t0 };
  }
}

/** 한 대상 점검. target: { host, port, kind, token?, expectAgent?, relayAgent?, otherIds? } */
export async function runCheck(target, { timeoutMs = 8_000 } = {}) {
  const { host, port, kind } = target;
  if (kind === 'irs-ssh') return sshBanner(host, port, timeoutMs);
  if (kind === 'edge-vcenter' || kind === 'irs-vcenter') {
    const p = await probeRelayPath(`${host}:${port}`, { timeoutMs });
    if (p.blocked) return { ok: false, phase: 'unknown', error: p.reason, ms: 0 };
    const st = p.verdict.state;
    if (st === 'ok') return { ok: true, detail: `TCP ${p.steps.tcp?.ms}ms · TLS ${p.steps.tls?.ms}ms · HTTP ${p.steps.http?.ms}ms`, ms: (p.steps.tcp?.ms || 0) + (p.steps.tls?.ms || 0) + (p.steps.http?.ms || 0) };
    if (st === 'tcp') { const e = String(p.steps.tcp?.error || ''); return { ok: false, phase: /ECONNREFUSED/.test(e) ? 'refused' : 'timeout', error: e, ms: p.steps.tcp?.ms || 0 }; }
    return { ok: false, phase: st, error: p.verdict.text, ms: (p.steps.tcp?.ms || 0) + (p.steps.tls?.ms || 0) };
  }
  if (kind === 'hq-portal') {
    const r = await portalPing(host, port, { timeoutMs });
    if (!r.ok) return r;
    if (r.got?.instance && r.got.instance !== instanceId()) return { ok: false, phase: 'hq', error: `응답 포탈 인스턴스가 이 중앙이 아님(${r.got.agent || r.got.instance.slice(0, 8)})`, got: r.got, ms: r.ms };
    if (!r.got?.instance) return { ok: true, detail: `${r.detail} (구버전 응답 — 인스턴스 대조 불가)`, ms: r.ms };
    return { ok: true, detail: '중앙 자신에게 도달', ms: r.ms };
  }
  // edge-portal / irs-portal
  const t = await tcp(host, port, timeoutMs);
  if (!t.ok) return t;
  return portalPing(host, port, { token: target.token, expectAgent: target.expectAgent, otherIds: target.otherIds || [], timeoutMs });
}
