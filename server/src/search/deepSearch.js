/**
 * 심층 검색 — 다조건으로 VM을 검색한다. 1차는 스냅샷 기반(즉시): 게이트웨이·IP/서브넷·OS·전원·
 * Tools·CPU/메모리/디스크·사용률·GPU·클러스터/호스트·스냅샷·메모. 범위는 전체/특정/복수 vCenter.
 * 2차(선택)는 게스트 탐침: GPU 드라이버 설치 여부, 특정 프로세스 실행 여부(게스트 작업 API).
 */

import { loadVcenterConfig } from '../config.js';
import { VimSoapClient, runGuestScript } from '../gpu/guestops.js';
import { loadGpuGuestSettings, resolveVmCreds } from '../gpu/settings.js';

const has = (s, q) => String(s || '').toLowerCase().includes(String(q).toLowerCase());
const numOr = (x) => (x === '' || x == null || Number.isNaN(Number(x)) ? null : Number(x));

function ipInCidr(ip, cidr) {
  try {
    const [net, bitsStr] = String(cidr).split('/');
    const bits = Number(bitsStr); if (!net || !(bits >= 0 && bits <= 32)) return false;
    const toInt = (a) => a.split('.').reduce((acc, o) => (acc << 8) + (Number(o) & 255), 0) >>> 0;
    const mask = bits === 0 ? 0 : (~((1 << (32 - bits)) - 1)) >>> 0;
    return (toInt(ip) & mask) === (toInt(net) & mask);
  } catch { return false; }
}

/** 스냅샷 1차 필터. { vcenterIds[], f{} } → matching VM[]. */
export function snapshotFilter(snap, { vcenterIds = [], f = {} } = {}) {
  const set = new Set(vcenterIds || []);
  let vms = (snap.vms || []).filter((v) => !v.template);
  if (set.size) vms = vms.filter((v) => set.has(v.vcenterId));
  if (f.q) vms = vms.filter((v) => has(v.name, f.q) || has(v.guestOS, f.q) || (v.ipAddresses || []).some((ip) => ip.includes(f.q)) || has(v.host, f.q));
  if (f.powerState) vms = vms.filter((v) => v.powerState === f.powerState);
  if (f.toolsStatus) vms = vms.filter((v) => v.toolsStatus === f.toolsStatus);
  if (f.guestOS) vms = vms.filter((v) => has(v.guestOS, f.guestOS));
  if (f.cluster) vms = vms.filter((v) => has(v.cluster, f.cluster));
  if (f.host) vms = vms.filter((v) => has(v.host, f.host));
  if (f.gateway) vms = vms.filter((v) => (v.gateways || []).some((g) => g === f.gateway || g.includes(f.gateway)));
  if (f.ip) vms = vms.filter((v) => (v.ipAddresses || []).some((ip) => ip === f.ip || ip.startsWith(f.ip)));
  if (f.subnet && /\//.test(f.subnet)) vms = vms.filter((v) => (v.ipAddresses || []).some((ip) => ipInCidr(ip, f.subnet)));
  if (f.gpuMode) vms = vms.filter((v) => (f.gpuMode === 'none' ? !v.gpu : f.gpuMode === 'any' ? !!v.gpu : v.gpu?.type === f.gpuMode));
  if (f.hasSnapshot) vms = vms.filter((v) => (v.snapshotCount || 0) > 0);
  if (f.notes) vms = vms.filter((v) => has(v.notes, f.notes));
  const ge = (field, min) => { const n = numOr(min); if (n != null) vms = vms.filter((v) => (v[field] ?? 0) >= n); };
  const le = (field, max) => { const n = numOr(max); if (n != null) vms = vms.filter((v) => (v[field] ?? 1e12) <= n); };
  ge('cpuCount', f.vcpuMin); le('cpuCount', f.vcpuMax);
  if (numOr(f.ramMinGB) != null) vms = vms.filter((v) => (v.memMB || 0) >= numOr(f.ramMinGB) * 1024);
  if (numOr(f.ramMaxGB) != null) vms = vms.filter((v) => (v.memMB || 0) <= numOr(f.ramMaxGB) * 1024);
  ge('storageGB', f.diskMinGB); le('storageGB', f.diskMaxGB);
  ge('cpuUsagePct', f.cpuUsageMin); ge('memUsagePct', f.memUsageMin);
  return vms;
}

export const slimVm = (v) => ({
  id: v.id, name: v.name, vcenterId: v.vcenterId, host: v.host, cluster: v.cluster, powerState: v.powerState,
  guestOS: v.guestOS, ipAddress: v.ipAddress, ipAddresses: v.ipAddresses, gateways: v.gateways || [],
  toolsStatus: v.toolsStatus, cpuCount: v.cpuCount, memGB: Math.round((v.memMB || 0) / 1024),
  gpu: v.gpu, cpuUsagePct: v.cpuUsagePct, memUsagePct: v.memUsagePct, snapshotCount: v.snapshotCount,
});

// 간단 동시성 제한기.
async function eachLimited(items, limit, fn) {
  const out = []; let i = 0;
  async function worker() { while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`; // 셸 작은따옴표 안전

function probeScript(probe, isWindows) {
  if (isWindows) {
    if (probe.type === 'gpuDriver') return '@echo off\r\nwhere nvidia-smi >nul 2>&1 && (echo MATCH & nvidia-smi -L) || echo NOMATCH\r\n';
    if (probe.type === 'process') { const p = String(probe.pattern || '').replace(/["%]/g, ''); return `@echo off\r\ntasklist | findstr /I /C:"${p}" >nul 2>&1 && (echo MATCH & tasklist ^| findstr /I /C:"${p}") || echo NOMATCH\r\n`; }
    return '@echo off\r\necho NOMATCH\r\n';
  }
  if (probe.type === 'gpuDriver') return 'if command -v nvidia-smi >/dev/null 2>&1; then echo MATCH; nvidia-smi -L 2>/dev/null | head -2; else echo NOMATCH; fi';
  if (probe.type === 'process') { const pat = shq(probe.pattern || ''); return `L=$(ps -ef 2>/dev/null | grep -F -- ${pat} | grep -v grep | head -3); if [ -n "$L" ]; then echo MATCH; echo "$L"; else echo NOMATCH; fi`; }
  return 'echo NOMATCH';
}

/**
 * 게스트 탐침 — candidates(스냅샷 1차 통과 VM)를 vCenter별로 묶어 로그인 후 스크립트 실행.
 * probe: { type:'gpuDriver'|'process', pattern? }. 반환 { matched[], checked, errors[] }.
 */
export async function guestProbe(candidates, probe, { guestUser = '', guestPass = '', maxVms = 100, concurrency = 4 } = {}) {
  const eligible = candidates.filter((v) => v.powerState === 'POWERED_ON' && v.toolsStatus === 'RUNNING').slice(0, maxVms);
  const byVc = new Map();
  for (const v of eligible) { if (!byVc.has(v.vcenterId)) byVc.set(v.vcenterId, []); byVc.get(v.vcenterId).push(v); }
  const gset = loadGpuGuestSettings();
  const cfgVcs = loadVcenterConfig().vcenters || [];
  const matched = []; const errors = []; let checked = 0;

  for (const [vcId, vms] of byVc) {
    const vc = cfgVcs.find((x) => x.id === vcId);
    if (!vc) { errors.push({ vcenterId: vcId, error: 'vCenter 설정 없음(live 필요)' }); continue; }
    const c = new VimSoapClient(vc);
    try {
      await c.login();
      await eachLimited(vms, concurrency, async (v) => {
        const creds = (guestUser && guestPass) ? { username: guestUser, password: guestPass } : resolveVmCreds(gset, vcId, v.id);
        if (!creds || !creds.username) { errors.push({ vm: v.name, error: '게스트 계정 없음' }); return; }
        const moref = String(v.id).split(':').slice(1).join(':') || String(v.id);
        const isWindows = /windows/i.test(v.guestOS || '');
        try {
          checked++;
          const r = await runGuestScript(c, moref, creds, probeScript(probe, isWindows), { isWindows, timeoutMs: 20_000 });
          if (/(^|\n)MATCH(\n|$)/.test(r.stdout)) matched.push({ ...v, evidence: r.stdout.replace(/^MATCH\n?/, '').trim().slice(0, 300) });
        } catch (e) { errors.push({ vm: v.name, error: String(e.message).slice(0, 120) }); }
      });
    } catch (e) { errors.push({ vcenterId: vcId, error: `로그인 실패: ${e.message}` }); }
    finally { await c.logout().catch(() => {}); }
  }
  return { matched, checked, errors };
}
