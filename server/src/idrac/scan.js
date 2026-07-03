/**
 * Scan an IP range for Dell iDRACs. Expands the IP list, probes each address'
 * Redfish endpoint with the given credentials (bounded concurrency + short
 * timeout), and returns only the confirmed iDRACs with their identity.
 */

import { expandIpList } from './iprange.js';
import { probeIdrac } from './redfish.js';

export async function scanForIdracs({ ips, username, password, concurrency = 32, perHostTimeout = 3000, max = 2048, onProgress = null, shouldAbort = null }) {
  const { ips: list, errors, truncated } = expandIpList(ips);
  const targets = list.slice(0, max);

  const found = [];
  let unreachable = 0, notIdrac = 0, authFailed = 0;
  const authHints = new Map(); // 인증실패 원인별 카운트(예: 'Digest 요구', '자격증명 거부') — 로그 진단용
  let idx = 0;
  let done = 0;
  // 진행률 콜백(스로틀): 너무 잦은 호출을 피하려 일정 개수마다만 보고.
  const total = targets.length;
  const step = Math.max(1, Math.floor(total / 100)); // 약 1%마다
  // (done, total, found) — found는 지금까지 발견한 iDRAC 수(진행 창의 '발견 N대' 표시용).
  const report = () => { if (onProgress) { try { onProgress(done, total, found.length); } catch { /* ignore */ } } };

  let aborted = false;
  async function worker() {
    while (idx < targets.length) {
      // 사용자 '스캔 중지' — 진행 중인 probe는 마치되 새 IP는 시작하지 않는다.
      if (shouldAbort && shouldAbort()) { aborted = true; break; }
      const ip = targets[idx++];
      const r = await probeIdrac(ip, username, password, perHostTimeout);
      if (!r.ok) unreachable++;
      else if (r.authFailed) { authFailed++; if (r.authHint) authHints.set(r.authHint, (authHints.get(r.authHint) || 0) + 1); }
      else if (r.isIdrac) found.push({ ip, serviceTag: r.serviceTag || '', model: r.model || '', manufacturer: r.manufacturer || '', hostName: r.hostName || '' });
      else notIdrac++;
      done++;
      if (done % step === 0) report();
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, targets.length || 1) }, worker);
  await Promise.all(workers);
  report(); // 최종 100%

  found.sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));
  // 인증실패 원인 요약(가장 많은 것 우선) — '계정 맞는데 401'의 실제 이유를 UI 로그에 노출.
  const authFailReason = [...authHints.entries()].sort((a, z) => z[1] - a[1])
    .map(([msg, n]) => `${msg} (${n})`).join(' · ') || null;
  return {
    scanned: aborted ? done : targets.length,
    aborted,
    found,
    foundCount: found.length,
    unreachable,
    notIdrac,
    authFailed,
    authFailReason,
    truncated: truncated || list.length > max,
    ipErrors: errors,
  };
}
