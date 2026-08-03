/**
 * TLS 인증서 만료 감시 — 등록된 vCenter·NSX Manager의 443 인증서를 주기적으로 프로브해
 * 만료일(D-90 경고 / D-30 위험)을 추적한다. 28개 vCenter 규모에서 수동 추적이 불가능한
 * 항목(커뮤니티 단골 장애: vCenter STS/머신 인증서 만료로 로그인 불능).
 *   · 프로브는 검증 없이(rejectUnauthorized:false) 인증서만 읽는다 — 자체서명 환경 지원.
 *   · 대상은 관리자가 등록한 레지스트리에서만 가져온다. 그래도 SSRF resolved 가드를 통과시켜
 *     이름이 루프백/링크로컬로 해석되는 우회를 차단한다(vcenter/relayProbe.js와 동일 원칙).
 *   · 12시간 주기 + 온디맨드 새로고침(관리자). 동시 프로브 6개 제한(고RTT 28대 순차 방지).
 */

import tls from 'node:tls';
import { loadRegistry as loadVcRegistry } from '../vcenter/registry.js';
import { loadRegistry as loadNsxRegistry } from '../nsx/registry.js';
import { ssrfBlockReasonResolved } from '../collector/registry.js';

const INTERVAL_MS = 12 * 3600_000;
const TIMEOUT_MS = 8000;
const CONCURRENCY = 6;

let cache = { items: [], at: null };
let timer = null;
let running = false;

/** 만료 시각(ts) → 상태 분류. 순수 함수(now 주입) — 테스트 대상. */
export function certExpiryStatus(validToTs, { now = Date.now(), soonDays = 90, criticalDays = 30 } = {}) {
  if (!Number.isFinite(validToTs)) return { status: 'unknown', daysLeft: null };
  const daysLeft = Math.floor((validToTs - now) / 86_400_000);
  if (daysLeft < 0) return { status: 'expired', daysLeft };
  if (daysLeft <= criticalDays) return { status: 'critical', daysLeft };
  if (daysLeft <= soonDays) return { status: 'expiring', daysLeft };
  return { status: 'ok', daysLeft };
}

/** host:port의 리프 인증서 조회(검증 없음 — 만료일 읽기 전용). */
function probeCert(host, port = 443, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (settled) return; settled = true; try { sock.destroy(); } catch { /* */ } resolve(r); };
    const sock = tls.connect(
      { host, port, servername: host, rejectUnauthorized: false, minVersion: 'TLSv1', ciphers: 'DEFAULT@SECLEVEL=0', timeout: timeoutMs },
      () => {
        const c = sock.getPeerCertificate();
        if (!c || !c.valid_to) return done({ ok: false, error: '인증서를 읽을 수 없습니다.' });
        done({
          ok: true,
          cn: c.subject?.CN || '', issuer: c.issuer?.CN || c.issuer?.O || '',
          validFrom: c.valid_from ? Date.parse(c.valid_from) : null,
          validTo: Date.parse(c.valid_to),
          selfSigned: !!(c.issuer && c.subject && c.issuer.CN === c.subject.CN),
        });
      },
    );
    sock.setTimeout(timeoutMs);
    sock.once('timeout', () => done({ ok: false, error: 'TLS 핸드셰이크 시간 초과' }));
    sock.once('error', (e) => done({ ok: false, error: e.message }));
  });
}

function targets() {
  const out = [];
  for (const vc of loadVcRegistry()) {
    const clean = String(vc.host || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (!clean) continue;
    out.push({ kind: 'vcenter', id: vc.id, name: vc.name || vc.id, host: clean.split(':')[0], port: Number(clean.split(':')[1]) || 443 });
  }
  for (const nx of loadNsxRegistry()) {
    const clean = String(nx.host || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (!clean) continue;
    out.push({ kind: 'nsx', id: nx.id, name: nx.name || nx.id, host: clean.split(':')[0], port: Number(clean.split(':')[1]) || 443 });
  }
  return out;
}

/** 전체 대상 프로브 실행(재진입 가드). force가 아니어도 호출 시점 기준 최신으로 갱신. */
export async function refreshCerts() {
  if (running) return cache;
  running = true;
  try {
    const list = targets();
    const items = new Array(list.length);
    let idx = 0;
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, async () => {
      while (idx < list.length) {
        const i = idx++;
        const t = list[i];
        const blocked = await ssrfBlockReasonResolved(`${t.host}:${t.port}`);
        if (blocked) { items[i] = { ...t, status: 'blocked', error: blocked, daysLeft: null }; continue; }
        const r = await probeCert(t.host, t.port);
        items[i] = r.ok
          ? { ...t, ...certExpiryStatus(r.validTo), cn: r.cn, issuer: r.issuer, validTo: r.validTo, validFrom: r.validFrom, selfSigned: r.selfSigned, error: null }
          : { ...t, status: 'error', error: r.error, daysLeft: null };
      }
    }));
    // 만료 임박 순 정렬(오류/차단은 뒤로).
    const rank = { expired: 0, critical: 1, expiring: 2, ok: 3, unknown: 4, error: 5, blocked: 6 };
    items.sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || (a.daysLeft ?? 1e9) - (b.daysLeft ?? 1e9));
    cache = { items, at: Date.now() };
    const bad = items.filter((c) => ['expired', 'critical'].includes(c.status)).length;
    if (bad) console.warn(`[certs] 만료/임박 인증서 ${bad}건 발견`);
    return cache;
  } finally {
    running = false;
  }
}

export function certStatus() {
  return { ...cache, running, intervalMs: INTERVAL_MS };
}

export function startCertMonitor() {
  setTimeout(() => refreshCerts().catch((e) => console.warn('[certs] 첫 프로브 실패:', e.message)), 45_000).unref?.();
  timer = setInterval(() => refreshCerts().catch(() => {}), INTERVAL_MS);
  timer.unref?.();
  console.log('[certs] TLS 인증서 만료 감시 시작 (12시간 주기)');
}
