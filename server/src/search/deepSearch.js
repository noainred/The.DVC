/**
 * 심층 검색 — 다조건으로 VM을 검색한다. 1차는 스냅샷 기반(즉시): 게이트웨이·IP/서브넷·OS·전원·
 * Tools·CPU/메모리/디스크·사용률·GPU·클러스터/호스트·스냅샷·메모. 범위는 전체/특정/복수 vCenter.
 * 2차(선택)는 게스트 탐침: GPU 드라이버 설치 여부, 특정 프로세스 실행 여부(게스트 작업 API).
 */

import { loadVcenterConfig } from '../config.js';
import { morefOf } from '../vcenter/registry.js';   // v2.447: vcenterId 에 콜론이 있어도 안전한 moref 추출(감사 B1)
import { VimSoapClient, runGuestScript } from '../gpu/guestops.js';
import { loadGpuGuestSettings, resolveVmCreds } from '../gpu/settings.js';
import { ipToNum } from '../util/ipv4.js';
import { poolRun } from '../util/pool.js'; // v2.579: 동시성 풀 단일 소스(util/pool.js) — 손으로 쓴 사본 제거
import { directCollectSkipReason } from '../vcenter/collectTarget.js';
import { vcAuthStopOf, noteVcAuthFailure, authStopView } from '../vcenter/authStopGate.js';

/**
 * v2.629(감사 AUTHZ2629-01): 검색어 소문자화는 **루프 밖에서 1회**. 예전 `has()` 는 VM 마다·필드마다 검색어를 다시
 * 소문자화해, 본문 1MB 안의 900KB 검색어 하나로 VM 2,242대에서 이벤트 루프가 3초 넘게 멈췄다(tools 권한 계정 1요청).
 * 길이 상한(`SEARCH_TERM_MAX`)을 넘는 검색어는 **어떤 VM 과도 맞지 않는다** — VM 이름·OS·호스트·클러스터가 그보다 길 수
 * 없으므로 옛 구현(긴 needle 의 includes = false)과 결과가 같고, 잘라서 넓게 맞추는 거짓을 만들지 않는다.
 */
export const SEARCH_TERM_MAX = 1024;
/** 검색어 → 소문자(1회). 상한 초과면 null(= 아무것도 맞지 않음). */
export function lowerTerm(q) {
  const t = String(q);
  return t.length > SEARCH_TERM_MAX ? null : t.toLowerCase();
}
const hasLow = (s, lq) => lq != null && String(s || '').toLowerCase().includes(lq);
const numOr = (x) => (x === '' || x == null || Number.isNaN(Number(x)) ? null : Number(x));

// 엄격 IPv4 → uint32. 4옥텟·각 0~255가 아니면 null(예: '10/8', '999.1.1.1', IPv6 → 오매칭 방지).
const ipToInt = ipToNum; // v2.586 — util/ipv4.js 하나(같은 엄격 규칙)
function ipInCidr(ip, cidr) {
  try {
    const [net, bitsStr] = String(cidr).split('/');
    const bits = Number(bitsStr); if (!net || !(bits >= 0 && bits <= 32)) return false;
    const ni = ipToInt(net); const ii = ipToInt(ip);
    if (ni == null || ii == null) return false;
    const mask = bits === 0 ? 0 : (~((1 << (32 - bits)) - 1)) >>> 0;
    return (ii & mask) === (ni & mask);
  } catch { return false; }
}

/**
 * IP 스캔으로 발견된 항목(vCenter가 모르는 물리서버·네트워크장비 등)을 검색 필터(f)로 거른다.
 * IP성 조건(ip/subnet/q)이 하나라도 있을 때만 매칭(빈 검색에 스캔 전체를 쏟지 않도록).
 * scan: [{ ip, hostname, openPorts, services, lastSeen }], histMap: ip→{firstSeen,lastSeen}.
 */
export function filterScanResults(scan = [], f = {}, histMap = {}) {
  const ipf = String(f.ip || '').trim();
  const subnet = String(f.subnet || '').trim();
  const q = String(f.q || '').trim().toLowerCase();
  if (!ipf && !subnet && !q) return []; // IP성 조건 없으면 스캔 결과 미포함
  const out = [];
  for (const s of scan) {
    if (!s || !s.ip) continue;
    if (ipf && !(s.ip === ipf || s.ip.startsWith(ipf))) continue;
    if (subnet && subnet.includes('/') && !ipInCidr(s.ip, subnet)) continue;
    if (q && !(s.ip.includes(q) || String(s.hostname || '').toLowerCase().includes(q)
      || (s.services || []).some((v) => String(v).toLowerCase().includes(q)))) continue;
    const h = histMap[s.ip] || {};
    out.push({
      ip: s.ip, hostname: s.hostname || '', openPorts: s.openPorts || [], services: s.services || [],
      firstSeen: h.firstSeen || null, lastSeen: s.lastSeen || h.lastSeen || null, agent: s.agent || '',
    });
  }
  return out;
}

/** 스냅샷 1차 필터. { vcenterIds[], f{} } → matching VM[]. */
export function snapshotFilter(snap, { vcenterIds = [], f = {} } = {}) {
  const set = new Set(vcenterIds || []);
  let vms = (snap.vms || []).filter((v) => !v.template);
  if (set.size) vms = vms.filter((v) => set.has(v.vcenterId));
  if (f.q) { const lq = lowerTerm(f.q); vms = lq == null ? [] : vms.filter((v) => hasLow(v.name, lq) || hasLow(v.guestOS, lq) || (v.ipAddresses || []).some((ip) => ip.includes(f.q)) || hasLow(v.host, lq)); }
  if (f.powerState) vms = vms.filter((v) => v.powerState === f.powerState);
  if (f.toolsStatus) vms = vms.filter((v) => v.toolsStatus === f.toolsStatus);
  if (f.guestOS) { const lq = lowerTerm(f.guestOS); vms = vms.filter((v) => hasLow(v.guestOS, lq)); }
  if (f.cluster) { const lq = lowerTerm(f.cluster); vms = vms.filter((v) => hasLow(v.cluster, lq)); }
  if (f.host) { const lq = lowerTerm(f.host); vms = vms.filter((v) => hasLow(v.host, lq)); }
  if (f.gateway) vms = vms.filter((v) => (v.gateways || []).some((g) => g === f.gateway || g.includes(f.gateway)));
  if (f.ip) vms = vms.filter((v) => (v.ipAddresses || []).some((ip) => ip === f.ip || ip.startsWith(f.ip)));
  if (f.subnet && /\//.test(f.subnet)) vms = vms.filter((v) => (v.ipAddresses || []).some((ip) => ipInCidr(ip, f.subnet)));
  if (f.gpuMode) vms = vms.filter((v) => (f.gpuMode === 'none' ? !v.gpu : f.gpuMode === 'any' ? !!v.gpu : v.gpu?.type === f.gpuMode));
  if (f.hasSnapshot) vms = vms.filter((v) => (v.snapshotCount || 0) > 0);
  if (f.notes) { const lq = lowerTerm(f.notes); vms = vms.filter((v) => hasLow(v.notes, lq)); }
  const ge = (field, min) => { const n = numOr(min); if (n != null) vms = vms.filter((v) => (v[field] ?? 0) >= n); };
  const le = (field, max) => { const n = numOr(max); if (n != null) vms = vms.filter((v) => (v[field] ?? 1e12) <= n); };
  ge('cpuCount', f.vcpuMin); le('cpuCount', f.vcpuMax);
  // v2.760(점검 B-09): 메모리를 못 읽은 VM 은 vCPU·디스크 조건과 같이 최소·최대 어느 쪽에도 맞지 않는다 —
  //   예전 `(v.memMB || 0)` 은 그 VM 을 0MB 로 보고 'RAM N GB 이하' 결과에 넣었다.
  const memOf = (v) => numOr(v.memMB);
  if (numOr(f.ramMinGB) != null) vms = vms.filter((v) => memOf(v) != null && memOf(v) >= numOr(f.ramMinGB) * 1024);
  if (numOr(f.ramMaxGB) != null) vms = vms.filter((v) => memOf(v) != null && memOf(v) <= numOr(f.ramMaxGB) * 1024);
  ge('storageGB', f.diskMinGB); le('storageGB', f.diskMaxGB);
  ge('cpuUsagePct', f.cpuUsageMin); ge('memUsagePct', f.memUsageMin);
  return vms;
}

export const slimVm = (v) => ({
  id: v.id, name: v.name, vcenterId: v.vcenterId, host: v.host, cluster: v.cluster, powerState: v.powerState,
  guestOS: v.guestOS, ipAddress: v.ipAddress, ipAddresses: v.ipAddresses, gateways: v.gateways || [],
  toolsStatus: v.toolsStatus, cpuCount: v.cpuCount, memGB: numOr(v.memMB) == null ? null : Math.round(numOr(v.memMB) / 1024), // v2.760 B-09: 못 읽음은 null
  gpu: v.gpu, cpuUsagePct: v.cpuUsagePct, memUsagePct: v.memUsagePct, snapshotCount: v.snapshotCount,
});

// 간단 동시성 제한기.

const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`; // 셸 작은따옴표 안전

function probeScript(probe, isWindows) {
  if (isWindows) {
    if (probe.type === 'gpuDriver') return '@echo off\r\nwhere nvidia-smi >nul 2>&1 && (echo MATCH & nvidia-smi -L) || echo NOMATCH\r\n';
    // cmd.exe 배치는 안전한 인용이 없어 메타문자(& | < > ^ ( ) " %)를 화이트리스트로 제거한다(프로세스명만 허용).
    if (probe.type === 'process') { const p = String(probe.pattern || '').replace(/[^A-Za-z0-9._ -]/g, ''); return `@echo off\r\ntasklist | findstr /I /C:"${p}" >nul 2>&1 && (echo MATCH & tasklist ^| findstr /I /C:"${p}") || echo NOMATCH\r\n`; }
    return '@echo off\r\necho NOMATCH\r\n';
  }
  if (probe.type === 'gpuDriver') return 'if command -v nvidia-smi >/dev/null 2>&1; then echo MATCH; nvidia-smi -L 2>/dev/null | head -2; else echo NOMATCH; fi';
  if (probe.type === 'process') { const pat = shq(probe.pattern || ''); return `L=$(ps -ef 2>/dev/null | grep -F -- ${pat} | grep -v grep | head -3); if [ -n "$L" ]; then echo MATCH; echo "$L"; else echo NOMATCH; fi`; }
  return 'echo NOMATCH';
}

/**
 * v2.741 VC-05 — 직접 수집 대상이 아닌 vCenter 의 사유 문구(collectTarget.DIRECT_SKIP_REASONS 와 1:1).
 * 화면(DeepSearch.jsx)은 errors[].error 를 그대로 보여 주므로 사람이 읽는 문장이다.
 */
export const PROBE_SKIP_TEXT = Object.freeze({
  disabled: '비활성 vCenter — 이 포탈이 로그인하지 않습니다',
  maintenance: '점검중 vCenter — 수집이 멈춰 있어 이 포탈이 로그인하지 않습니다',
  site: '엣지 위임 vCenter — 담당 엣지가 수집하므로 중앙이 로그인하지 않습니다',
  invalid: 'vCenter 설정 형식이 올바르지 않습니다',
});

/**
 * 게스트 탐침 — candidates(스냅샷 1차 통과 VM)를 vCenter별로 묶어 로그인 후 스크립트 실행.
 * probe: { type:'gpuDriver'|'process', pattern? }. 반환 { matched[], checked, errors[], notCollected[], authStopped{} }.
 *
 * v2.741 VC-05 — 형제 OS 판별 스캐너(inventory/osScanner.js, v2.732 B4-01)와 같은 vCenter 경계:
 *   · 비활성·점검중·엣지 위임(site) vCenter 에는 로그인하지 않는다(`directCollectSkipReason` 하나 — 주 폴러와 같은 판정).
 *     후보를 스냅샷에서 고르므로 엣지가 push 한 site VM·점검중 vCenter 의 직전 VM(lastGood)이 섞여 중앙이 그 vCenter 에
 *     게스트 명령 로그인을 하던 것이다. 건너뛴 vCenter 는 조용히 빼지 않고 `notCollected[{vcenterId, why, vms}]` 와
 *     errors 에 사유 문장으로 싣는다(화면은 errors 를 보여 준다).
 *   · vCenter 로그인 거부는 주 폴러와 **같은 인증 정지 기록**에 올린다(noteVcAuthFailure) — 결과 `authStopped[vcId]`.
 *   · ⚠ 인증 정지 중인 vCenter 도 **시도는 한다** — 사람이 누른 수동 실행이다(authGuard 규칙 3 · osScanner 수동 실행과 같다.
 *     검증자 판단: '수동 실행은 막지 않는다'). 대신 실패 문구가 정지 중이었다는 사실을 말한다.
 *   · 게스트 계정 거부는 vCenter 거부가 아니다(isVcAuthError 가 guestAuth 를 제외) — 이 기록에 올리지 않는다.
 */
export async function guestProbe(candidates, probe, { guestUser = '', guestPass = '', maxVms = 100, concurrency = 4 } = {}) {
  const eligible = candidates.filter((v) => v.powerState === 'POWERED_ON' && v.toolsStatus === 'RUNNING').slice(0, maxVms);
  const byVc = new Map();
  for (const v of eligible) { if (!byVc.has(v.vcenterId)) byVc.set(v.vcenterId, []); byVc.get(v.vcenterId).push(v); }
  const gset = loadGpuGuestSettings();
  const cfgVcs = loadVcenterConfig().vcenters || [];
  const matched = []; const errors = []; let checked = 0;
  const notCollected = []; const authStopped = {};

  for (const [vcId, vms] of byVc) {
    const vc = cfgVcs.find((x) => x.id === vcId);
    if (!vc) { errors.push({ vcenterId: vcId, error: 'vCenter 설정 없음(live 필요)' }); continue; }
    const why = directCollectSkipReason(vc);
    if (why) {
      notCollected.push({ vcenterId: vcId, why, vms: vms.length });
      errors.push({ vcenterId: vcId, why, error: `${PROBE_SKIP_TEXT[why] || why} — 후보 ${vms.length}대는 탐침하지 않았습니다` });
      continue;
    }
    const stoppedBefore = vcAuthStopOf(vc);   // 읽기 전용 — 막지 않는다(수동 실행). 실패 문구에만 쓴다.
    const c = new VimSoapClient(vc);
    try {
      try { await c.login(); }
      catch (e) {
        const info = noteVcAuthFailure(vc, e);   // 자격증명 거부만 기록한다(시한·연결 실패는 null — authGuard 규칙 4)
        if (info) authStopped[vcId] = authStopView(info);
        const hint = info
          ? `${stoppedBefore ? ' — 인증 실패로 주기 수집이 이미 멈춰 있던 vCenter 입니다(수동 실행이라 1회 시도)' : ''} · 인증 실패 기록 ${info.attempts}회`
          : '';
        errors.push({ vcenterId: vcId, error: `로그인 실패: ${e.message}${hint}` });
        continue;   // finally 가 logout 을 정리한다
      }
      await poolRun(vms, concurrency, async (v) => {
        const isWindows = /windows/i.test(v.guestOS || '');
        const creds = (guestUser && guestPass) ? { username: guestUser, password: guestPass } : resolveVmCreds(gset, vcId, v.id, isWindows);
        if (!creds || !creds.username) { errors.push({ vm: v.name, error: '게스트 계정 없음' }); return; }
        const moref = morefOf(v.id, v.vcenterId || vcId);
        try {
          checked++;
          const r = await runGuestScript(c, moref, creds, probeScript(probe, isWindows), { isWindows, timeoutMs: 20_000 });
          if (/(^|\n)MATCH(\n|$)/.test(r.stdout)) matched.push({ ...v, evidence: r.stdout.replace(/^MATCH\n?/, '').trim().slice(0, 300) });
        } catch (e) { errors.push({ vm: v.name, error: String(e.message).slice(0, 120) }); }
      });
    } catch (e) { errors.push({ vcenterId: vcId, error: `탐침 실패: ${e.message}` }); }   // 로그인 실패는 위에서 따로 싣는다
    finally { await c.logout().catch(() => {}); }
  }
  return { matched, checked, errors, notCollected, authStopped };
}
