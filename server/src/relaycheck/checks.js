/**
 * relaycheck/checks.js — 점검 실행기(v2.429). 종류별로 TCP → 프로토콜 단계 → 정체 대조까지 한 번에 판정한다.
 * 반환 { ok, phase, ms, detail, error, got }. phase: refused|timeout|unreach|tls|http|identity|auth|hq|banner|ok
 */
import net from 'node:net';
import { probeRelayPath } from '../vcenter/relayProbe.js';
import { identityIssue } from '../collector/registry.js';
import { instanceId } from '../instanceId.js';

function tcp(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = net.connect({ host, port });
    let done = false;
    const fin = (r) => { if (done) return; done = true; try { sock.destroy(); } catch { /* */ } resolve({ ...r, ms: Date.now() - t0 }); };
    sock.setTimeout(timeoutMs, () => fin({ ok: false, phase: 'timeout', error: `TCP 연결 타임아웃(${Math.round(timeoutMs / 1000)}초)` }));
    sock.once('connect', () => fin({ ok: true }));
    sock.once('error', (e) => fin({ ok: false, phase: e.code === 'ECONNREFUSED' ? 'refused' : /EHOSTUNREACH|ENETUNREACH/.test(e.code || '') ? 'unreach' : 'timeout', error: `${e.code || e.message}` }));
  });
}

function sshBanner(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = net.connect({ host, port });
    let done = false; let buf = '';
    const fin = (r) => { if (done) return; done = true; try { sock.destroy(); } catch { /* */ } resolve({ ...r, ms: Date.now() - t0 }); };
    sock.setTimeout(timeoutMs, () => fin({ ok: false, phase: buf ? 'banner' : 'timeout', error: buf ? `SSH 배너가 아님: ${buf.slice(0, 40)}` : 'TCP/배너 타임아웃' }));
    sock.on('data', (d) => { buf += d.toString('latin1'); if (buf.includes('\n')) fin(buf.startsWith('SSH-') ? { ok: true, detail: buf.trim().slice(0, 60) } : { ok: false, phase: 'banner', error: `SSH 배너가 아님: ${buf.trim().slice(0, 40)}` }); });
    sock.once('error', (e) => fin({ ok: false, phase: e.code === 'ECONNREFUSED' ? 'refused' : 'timeout', error: `${e.code || e.message}` }));
  });
}

async function portalPing(host, port, { token, expectAgent, otherIds = [], timeoutMs }) {
  const t0 = Date.now();
  const base = `http://${host}:${port}`;
  try {
    if (token) {
      const r = await fetch(`${base}/api/collector/ping`, { headers: { Accept: 'application/json', 'X-Collector-Token': token }, signal: AbortSignal.timeout(timeoutMs) });
      if (r.status === 403 || r.status === 401) return { ok: false, phase: 'auth', error: 'HTTP 403 토큰 거부', ms: Date.now() - t0 };
      if (r.status === 404) return { ok: false, phase: 'auth', error: 'HTTP 404 — 응답 포탈에 COLLECTOR_TOKEN 미설정(또는 포탈 아님)', ms: Date.now() - t0 };
      if (!r.ok) return { ok: false, phase: 'http', error: `HTTP ${r.status}`, ms: Date.now() - t0 };
      const j = await r.json().catch(() => ({}));
      const iss = expectAgent ? identityIssue({ id: expectAgent, name: expectAgent }, j, otherIds) : null;
      if (iss) return { ok: false, phase: 'identity', error: iss.reason, got: { agent: j.agent, hostname: j.hostname }, ms: Date.now() - t0 };
      return { ok: true, detail: `응답 ${j.agent || '(이름 없음)'}${j.hostname ? `(${j.hostname})` : ''} v${j.version || '?'}`, got: { agent: j.agent, hostname: j.hostname }, ms: Date.now() - t0 };
    }
    const r = await fetch(`${base}/api/health`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return { ok: false, phase: 'http', error: `HTTP ${r.status}`, ms: Date.now() - t0 };
    const j = await r.json().catch(() => ({}));
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
