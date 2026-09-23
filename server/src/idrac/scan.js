/**
 * Scan an IP range for Dell iDRACs. Expands the IP list, probes each address'
 * Redfish endpoint with the given credentials (bounded concurrency + short
 * timeout), and returns only the confirmed iDRACs with their identity.
 */

import { expandIpList } from './iprange.js';
import { probeIdrac } from './redfish.js';
import { ipBlockReason } from '../collector/registry.js'; // v2.537: 차단 대역은 스캔하지 않는다

/**
 * @param {object} p
 * @param {object|null} [p.authPolicy] v2.591(감사 F3) — `idrac/scanAuth.js makeScanAuthPolicy` 의 결과. 주기 스캔이면
 *   직전 인증 실패 IP·주 폴러 정지 서버를 **건너뛰고**(`authSkipped*` 로 밝힌다), 수동이면 전부 시도하되 결과를 기록한다.
 *   없으면(예전 호출부) 예전 동작 그대로다.
 */
export async function scanForIdracs({ ips, username, password, concurrency = 32, perHostTimeout = 3000, max = 2048, onProgress = null, shouldAbort = null, authPolicy = null }) {
  const { ips: list, errors, truncated } = expandIpList(ips);
  // v2.537: 차단 대역(루프백·링크로컬·우회표기)은 **찌르지 않는다**. lookup 훅(util/ssrfLookup.js)은
  // IP 리터럴에는 불리지 않으므로(v2.506 문서의 한계) 스캐너는 정적으로 걸러야 한다.
  // ⚠ 조용히 빼지 않는다 — 몇 개를 왜 뺐는지 `blocked`·`blockedIps` 로 돌려주고 화면이 말한다.
  const blockedIps = [];
  let blocked = 0;
  const MAX_BLOCKED_IPS = 200;
  const allowed = [];
  for (const ip of list) {
    if (ipBlockReason(ip)) { blocked++; if (blockedIps.length < MAX_BLOCKED_IPS) blockedIps.push(ip); continue; }
    allowed.push(ip);
  }
  const targets = allowed.slice(0, max);

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

  // v2.591(감사 F3): 인증 실패 정지로 건너뛴 IP — 조용히 빼면 '전부 스캔했다' 는 거짓이 된다.
  let authSkipped = 0; let authSkippedRegistered = 0;
  const authSkippedIps = [];
  const MAX_AUTHSKIP_IPS = 200;
  let aborted = false;
  async function worker() {
    while (idx < targets.length) {
      // 사용자 '스캔 중지' — 진행 중인 probe는 마치되 새 IP는 시작하지 않는다.
      if (shouldAbort && shouldAbort()) { aborted = true; break; }
      const ip = targets[idx++];
      const why = authPolicy ? authPolicy.skip(ip) : null;
      if (why) {
        authSkipped++;
        if (why === 'registered') authSkippedRegistered++;
        if (authSkippedIps.length < MAX_AUTHSKIP_IPS) authSkippedIps.push(ip);
        done++;
        if (done % step === 0) report();
        continue;
      }
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
        authPolicy?.noteAuthFailed(ip, r.authHint);
      } else if (r.isIdrac) { found.push({ ip, serviceTag: r.serviceTag || '', model: r.model || '', manufacturer: r.manufacturer || '', hostName: r.hostName || '' }); authPolicy?.noteOk(ip); }
      else { notIdrac++; authPolicy?.noteOk(ip); }
      done++;
      if (done % step === 0) report();
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, targets.length || 1) }, worker);
  try { await Promise.all(workers); }
  finally { authPolicy?.flush(); }   // 지연 기록을 실행 끝에 한 번 쓴다(건마다 쓰면 파일 전체를 수천 번 다시 쓴다)
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
    truncated: truncated || allowed.length > max,
    ipErrors: errors,
    // v2.537: 차단 대역이라 찌르지 않은 IP — 화면(scanRunText)·스캔 로그가 개수를 밝힌다.
    blocked,
    blockedIps,
    blockedTruncated: blocked > blockedIps.length,
    // v2.591(감사 F3): 인증 실패 정지로 시도하지 않은 IP(주기 스캔만) — registered 는 주 전력 폴러 정지를 따른 것.
    authSkipped,
    authSkippedRegistered,
    authSkippedIps: authSkippedIps.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
    authSkippedTruncated: authSkipped > authSkippedIps.length,
  };
}
