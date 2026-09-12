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
  const authHints = new Map(); // 인증실패 원인별 카운트(예: '자격증명 거부') — 로그 진단용
  const authFailedIps = []; // '계정 맞는데 막힌' IP 목록 — 어느 iDRAC을 점검할지 로그에 표시(상한 200)
  const MAX_AUTHFAIL_IPS = 200;
  // v2.495: '미지원 서버' — Redfish 서비스 루트가 응답했으나 Dell 이 아닌 장비(HPE iLO 등).
  // 정의를 좁게 둔다: Redfish 양성 신호(redfish:true) 가 없는 HTTPS 응답(스위치 웹UI·ESXi·프린터)은
  // 담지 않는다 — 담으면 목록이 잡탕이 되어 신뢰를 잃는다. 상한 200(authFailedIps 와 동일 — 중앙
  // 회신 본문 1MB 한도 안). found 에는 절대 넣지 않는다(등록되어 전력 폴러가 영구 실패 수집을 반복).
  const unsupported = [];
  const MAX_UNSUPPORTED = 200;
  let unsupportedCount = 0;
  const noteUnsupported = (ip, r) => {
    if (!r.redfish || r.vendor === 'dell') return false;
    unsupportedCount++;
    if (unsupported.length < MAX_UNSUPPORTED) {
      unsupported.push({ ip, vendor: r.vendor || 'unknown', vendorLabel: r.vendorLabel || '', evidence: r.vendorEvidence || '', product: r.product || '', model: r.model || '', manufacturer: r.manufacturer || '', hostName: r.hostName || '', authFailed: !!r.authFailed, at: Date.now() });
    }
    return true;
  };
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
      // v2.495: 비-Dell Redfish 장비는 '인증실패'·'비iDRAC' 카운터 앞에서 분리한다 — Dell 계정으로
      // 찌른 HPE iLO 는 401 이라 예전에는 '인증실패' 로 집계돼 정체 없이 사라졌다. 분기 순서(authFailed
      // 우선)는 그대로 두되 그 앞에 한 단계만 추가한다(기존 authHints/authFailedIps 진단 기능 보존).
      else if (noteUnsupported(ip, r)) { /* 미지원 서버 — found 에 넣지 않는다 */ }
      else if (r.authFailed) {
        authFailed++;
        if (r.authHint) authHints.set(r.authHint, (authHints.get(r.authHint) || 0) + 1);
        if (authFailedIps.length < MAX_AUTHFAIL_IPS) authFailedIps.push(ip); // 막힌 IP 기록
      } else if (r.isIdrac) found.push({ ip, serviceTag: r.serviceTag || '', model: r.model || '', manufacturer: r.manufacturer || '', hostName: r.hostName || '' });
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
  authFailedIps.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return {
    scanned: aborted ? done : targets.length,
    aborted,
    found,
    foundCount: found.length,
    unreachable,
    notIdrac,
    authFailed,
    authFailReason,
    authFailedIps, // 인증 거부된 IP 목록(≤200) — 어느 iDRAC을 점검할지
    authFailedIpsTruncated: authFailed > authFailedIps.length,
    // v2.495: 비-Dell Redfish 장비(HPE iLO 등). 상한 200 — 넘으면 unsupportedTruncated 로 알린다.
    unsupported: unsupported.sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true })),
    unsupportedCount,
    unsupportedTruncated: unsupportedCount > unsupported.length,
    truncated: truncated || list.length > max,
    ipErrors: errors,
  };
}
