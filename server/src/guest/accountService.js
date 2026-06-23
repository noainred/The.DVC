/**
 * 게스트 계정 추가 오케스트레이션 — vCenter에 로그인해 선택된 VM들의 게스트 OS에 sudo 계정을
 * 추가한다. 게스트 인증은 root 게스트 자격증명 필요(요청에서 받거나 GPU 게스트 설정 폴백).
 * ⚠️ 강력한 권한 작업: 관리자 전용 + 감사 로그(라우트 레벨).
 */

import { loadVcenterConfig } from '../config.js';
import { store } from '../store.js';
import { VimSoapClient, addGuestUser } from '../gpu/guestops.js';
import { loadGpuGuestSettings, resolveVmCreds } from '../gpu/settings.js';

export async function addUsersToVms({ vcenterId, vmIds = [], username, password, sudo = true, nopasswd = false, guestUser = '', guestPass = '' } = {}) {
  if (!vcenterId) throw new Error('vcenterId가 필요합니다.');
  if (!Array.isArray(vmIds) || !vmIds.length) throw new Error('대상 VM이 필요합니다.');
  if (!username || !password) throw new Error('새 계정의 사용자명/비밀번호가 필요합니다.');

  const vc = (loadVcenterConfig().vcenters || []).find((v) => v.id === vcenterId);
  if (!vc) throw new Error(`vCenter(${vcenterId}) 설정을 찾을 수 없습니다(live 모드 필요).`);

  const snap = store.get();
  const hostByName = new Map();
  for (const h of snap.hosts || []) if (h.vcenterId === vcenterId) hostByName.set(h.name, h);
  const vmById = new Map();
  for (const v of snap.vms || []) if (v.vcenterId === vcenterId) vmById.set(v.id, v);
  const gset = loadGpuGuestSettings();

  const c = new VimSoapClient(vc);
  const results = [];
  try {
    await c.login();
    for (const vmId of vmIds) {
      const v = vmById.get(vmId);
      const moref = String(vmId).split(':').slice(1).join(':') || String(vmId);
      const name = v?.name || moref;
      try {
        if (!v) { results.push({ vmId, name, ok: false, error: '스냅샷에서 VM을 찾을 수 없음' }); continue; }
        // 게스트 인증 계정: 요청값 우선, 없으면 GPU 게스트 설정의 vCenter/VM 계정.
        let creds = (guestUser && guestPass) ? { username: guestUser, password: guestPass } : resolveVmCreds(gset, vcenterId, vmId);
        if (!creds || !creds.username) { results.push({ vmId, name, ok: false, error: '게스트 인증 계정 없음(root 계정 입력 또는 GPU 게스트 설정)' }); continue; }
        const isWindows = /windows/i.test(v.guestOS || '');
        const h = hostByName.get(v.host);
        const dlHosts = h ? [h.mgmtIp, h.name].filter(Boolean) : [];
        const r = await addGuestUser(c, moref, creds, { username, password, sudo, nopasswd, isWindows, dlHosts });
        results.push({ vmId, name, ok: r.ok, exitCode: r.exitCode, stdout: r.stdout, error: r.ok ? null : (r.stderr || `exitCode=${r.exitCode}`) });
      } catch (e) { results.push({ vmId, name, ok: false, error: e.guestDiag ? e.message : String(e.message).slice(0, 200) }); }
    }
  } finally { await c.logout().catch(() => {}); }
  return { vcenterId, account: username, sudo, nopasswd, results, ok: results.filter((r) => r.ok).length, fail: results.filter((r) => !r.ok).length };
}
