/**
 * vmdns/probe.js — DNS 서버 도달성 점검(UDP 53 + TCP 53, v2.696). 관리자가 누를 때만 돈다(주기 실행 없음).
 *
 * ── 무엇을 '응답' 으로 보는가 ───────────────────────────────────────────────
 *  질의 패킷을 직접 만들어 보내고(외부 라이브러리 없음), **ID 가 같고 QR 비트가 선 응답 패킷**을 받으면 rcode 와 무관하게
 *  '응답' 이다 — REFUSED·SERVFAIL 도 'DNS 서비스가 그 주소에서 살아 있다' 는 양성 증거다(v2.553 '무인증 401 은 양성 신호' 와
 *  같은 판단). rcode 는 그대로 싣는다. 시한(기본 2초) 안에 그런 패킷이 없으면 실패(timeout·refused·unreachable)다.
 *
 * ── 경계 ────────────────────────────────────────────────────────────────────
 *  · 대상 주소는 **스냅샷에서 계산한다**(analyze.js probeTargets) — 요청 본문에서 주소를 받지 않는다. 포트는 53 고정이다
 *    (테스트만 `port` 를 주입한다 — 라우트는 넘기지 않는다).
 *  · 동시 8(`util/pool.js poolRun`) · 서버마다 UDP·TCP 를 함께(각 2초) · 총 예산 90초 · 대상 상한 1,000 —
 *    예산·상한에 걸려 시도하지 않은 서버는 `skipped` 로 밝힌다(조용히 빼지 않는다).
 *  · 진행 중 실행은 하나다 — 두 번째 호출은 `{ busy:true }`(라우트가 409).
 *  · 결과는 **인메모리**다(재시작하면 사라진다 — 화면이 '마지막 점검 시각' 으로 말한다). 리비전은 응답 캐시 키에 쓴다.
 */
import dgram from 'node:dgram';
import net from 'node:net';
import crypto from 'node:crypto';
import { poolRun } from '../util/pool.js';

export const PROBE_TIMEOUT_MS = 2_000;
export const PROBE_CONCURRENCY = 8;
export const PROBE_BUDGET_MS = 90_000;
export const PROBE_TARGET_MAX = 1_000;
const RESPONSE_MAX = 65_537;

const RCODE = ['NOERROR', 'FORMERR', 'SERVFAIL', 'NXDOMAIN', 'NOTIMP', 'REFUSED', 'YXDOMAIN', 'YXRRSET', 'NXRRSET', 'NOTAUTH', 'NOTZONE'];
export const rcodeName = (n) => (Number.isInteger(n) ? (RCODE[n] || `RCODE${n}`) : null);
const QTYPE = { A: 1, NS: 2, SOA: 6 };

/** 질의 이름 → wire 형식. '.' 이면 루트(0 바이트 하나). 라벨 1~63 · 전체 253 · 글자 [A-Za-z0-9_-] 가 아니면 null. */
export function encodeName(name) {
  const s = typeof name === 'string' ? name.trim().replace(/\.$/, '') : '';
  if (!s) return Buffer.from([0]);
  if (s.length > 253) return null;
  const parts = [];
  for (const l of s.split('.')) {
    if (!l || l.length > 63 || !/^[A-Za-z0-9_-]+$/.test(l)) return null;
    parts.push(Buffer.from([l.length]), Buffer.from(l, 'ascii'));
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

/** 표준 질의 패킷(RD=1, 질문 1개, class IN). */
export function buildQuery(id, name, qtype = QTYPE.NS) {
  const q = encodeName(name) || encodeName('.');
  const h = Buffer.alloc(12);
  h.writeUInt16BE(id & 0xffff, 0);
  h.writeUInt16BE(0x0100, 2);   // RD
  h.writeUInt16BE(1, 4);        // QDCOUNT
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(qtype, 0);
  tail.writeUInt16BE(1, 2);     // IN
  return Buffer.concat([h, q, tail]);
}

/** 응답 헤더 — `{ id, qr, rcode }`. 12바이트 미만이면 null. */
export function parseHeader(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  const flags = buf.readUInt16BE(2);
  return { id: buf.readUInt16BE(0), qr: (flags & 0x8000) !== 0, rcode: flags & 0x000f };
}

const errKind = (e) => {
  const c = e?.code || '';
  if (c === 'ECONNREFUSED') return 'refused';
  if (c === 'EHOSTUNREACH' || c === 'ENETUNREACH' || c === 'EADDRNOTAVAIL') return 'unreachable';
  if (c === 'ETIMEDOUT') return 'timeout';
  return c ? `error:${String(c).slice(0, 32)}` : 'error';
};
const qtypeFor = (qname) => (qname && qname !== '.' ? QTYPE.SOA : QTYPE.NS);
const newId = () => crypto.randomInt(0, 0x10000);

/** UDP 53 질의 한 번. 반환 `{ ok, ms, rcode, error }`. */
export function probeUdp(ip, { port = 53, timeoutMs = PROBE_TIMEOUT_MS, qname = '.' } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const id = newId();
    let sock;
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock?.close(); } catch { /* 이미 닫힘 */ }
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, ms: null, rcode: null, error: 'timeout' }), Math.max(100, timeoutMs));
    try {
      sock = dgram.createSocket(String(ip).includes(':') ? 'udp6' : 'udp4');
    } catch (e) { finish({ ok: false, ms: null, rcode: null, error: errKind(e) }); return; }
    sock.on('error', (e) => finish({ ok: false, ms: null, rcode: null, error: errKind(e) }));
    sock.on('message', (msg) => {
      const h = parseHeader(msg);
      if (!h || h.id !== id || !h.qr) return;   // 다른 패킷은 무시하고 시한까지 기다린다
      finish({ ok: true, ms: Date.now() - t0, rcode: rcodeName(h.rcode), error: null });
    });
    // connect 해 두면 ICMP port unreachable 이 ECONNREFUSED 로 돌아온다(리눅스) — '닫힌 포트' 와 '무응답' 을 가른다.
    sock.connect(port, ip, (e) => {
      if (e) { finish({ ok: false, ms: null, rcode: null, error: errKind(e) }); return; }
      sock.send(buildQuery(id, qname, qtypeFor(qname)), (err) => { if (err) finish({ ok: false, ms: null, rcode: null, error: errKind(err) }); });
    });
  });
}

/** TCP 53 질의 한 번(길이 접두 2바이트). 반환 `{ ok, ms, rcode, error }`. */
export function probeTcp(ip, { port = 53, timeoutMs = PROBE_TIMEOUT_MS, qname = '.' } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const id = newId();
    let done = false;
    let buf = Buffer.alloc(0);
    const sock = new net.Socket();
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch { /* */ }
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, ms: null, rcode: null, error: 'timeout' }), Math.max(100, timeoutMs));
    sock.on('error', (e) => finish({ ok: false, ms: null, rcode: null, error: errKind(e) }));
    sock.on('close', () => finish({ ok: false, ms: null, rcode: null, error: 'closed' }));
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > RESPONSE_MAX) { finish({ ok: false, ms: null, rcode: null, error: 'too-large' }); return; }
      if (buf.length < 2) return;
      const len = buf.readUInt16BE(0);
      if (buf.length < 2 + Math.min(len, 12)) return;   // 헤더만 있으면 판정할 수 있다
      const h = parseHeader(buf.subarray(2));
      if (!h || h.id !== id || !h.qr) { finish({ ok: false, ms: null, rcode: null, error: 'bad-response' }); return; }
      finish({ ok: true, ms: Date.now() - t0, rcode: rcodeName(h.rcode), error: null });
    });
    sock.connect({ host: ip, port }, () => {
      const q = buildQuery(id, qname, qtypeFor(qname));
      const len = Buffer.alloc(2); len.writeUInt16BE(q.length, 0);
      sock.write(Buffer.concat([len, q]));
    });
  });
}

// ── 실행 상태(인메모리) ─────────────────────────────────────────────────────
let _running = null;          // 진행 중 프라미스
let _last = null;             // { ranAt, finishedAt, results: Map ip → result, summary }
let _rev = 0;

export function probeRev() { return _rev; }
export function probeResultOf(ip) { return _last?.results.get(ip) || null; }
export function vmDnsProbeState() {
  return { running: !!_running, lastRunAt: _last?.ranAt ?? null, finishedAt: _last?.finishedAt ?? null, summary: _last?.summary ?? null };
}

/**
 * 대상 목록을 점검한다. targets: `[{ ip, qname, skip }]`(analyze.js probeTargets). 진행 중이면 `{ busy:true }`.
 * 반환 `{ ok, ranAt, summary, results }`(results 는 배열 — 라우트는 summary 만 돌려준다).
 */
export async function runVmDnsProbe(targets, { port = 53, timeoutMs = PROBE_TIMEOUT_MS, concurrency = PROBE_CONCURRENCY,
  budgetMs = PROBE_BUDGET_MS, max = PROBE_TARGET_MAX, now = Date.now } = {}) {
  if (_running) return { ok: false, busy: true };
  const ranAt = now();
  _rev += 1;
  _running = (async () => {
    const list = Array.isArray(targets) ? targets.filter((t) => t && typeof t.ip === 'string') : [];
    const results = new Map();
    const summary = { targets: list.length, answered: 0, failed: 0, skipped: 0, edgeOnly: 0, skippedBy: {} };
    const skip = (t, why) => {
      results.set(t.ip, { at: now(), where: 'central', skipped: why, udp: null, tcp: null });
      summary.skipped += 1; summary.skippedBy[why] = (summary.skippedBy[why] || 0) + 1;
    };
    const work = [];
    list.forEach((t, i) => {
      if (t.skip === 'edge-only') { results.set(t.ip, { at: now(), where: 'edge-only', udp: null, tcp: null }); summary.edgeOnly += 1; }
      else if (t.skip) skip(t, String(t.skip));
      else if (i >= max) skip(t, 'cap');
      else work.push(t);
    });
    await poolRun(work, concurrency, async (t) => {
      if (now() - ranAt > budgetMs) { skip(t, 'budget'); return; }
      const opt = { port, timeoutMs, qname: t.qname || '.' };
      const [udp, tcp] = await Promise.all([probeUdp(t.ip, opt), probeTcp(t.ip, opt)]);
      results.set(t.ip, { at: now(), where: 'central', qname: opt.qname, udp, tcp });
      if (udp.ok || tcp.ok) summary.answered += 1; else summary.failed += 1;
    });
    _last = { ranAt, finishedAt: now(), results, summary };
    return { ok: true, ranAt, summary, results: [...results.entries()].map(([ip, r]) => ({ ip, ...r })) };
  })();
  try {
    return await _running;
  } catch (e) {
    console.warn(`[vm-dns] 도달성 점검 실패: ${e?.message || e}`);
    return { ok: false, reason: String(e?.message || e).slice(0, 200) };
  } finally {
    _running = null;
    _rev += 1;
  }
}

export function _resetVmDnsProbeForTest() { _running = null; _last = null; _rev = 0; }
