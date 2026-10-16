/**
 * 게스트 계정 추가 오케스트레이션 — vCenter에 로그인해 선택된 VM들의 게스트 OS에 sudo 계정을
 * 추가한다. 게스트 인증은 root 게스트 자격증명 필요(요청에서 받거나 GPU 게스트 설정 폴백).
 * ⚠️ 강력한 권한 작업: 관리자 전용 + 감사 로그(라우트 레벨).
 */

import { loadVcenterConfig } from '../config.js';
import { morefOf } from '../vcenter/registry.js';   // v2.447: 콜론 포함 vcenterId 안전(감사 B1)
import { store } from '../store.js';
import { VimSoapClient, addGuestUser } from '../gpu/guestops.js';
import { loadGpuGuestSettings, resolveVmCreds } from '../gpu/settings.js';
import { onDemandVcBlock, onDemandBlockError, onDemandLoginError } from '../vcenter/dsBrowse.js';   // v2.742(VC-03): 주문형 vCenter 로그인 문
import { vcAuthStopOf } from '../vcenter/authStopGate.js';

export async function addUsersToVms({ vcenterId, vmIds = [], username, password, sudo = true, nopasswd = false, guestUser = '', guestPass = '' } = {}) {
  if (!vcenterId) throw new Error('vcenterId가 필요합니다.');
  if (!Array.isArray(vmIds) || !vmIds.length) throw new Error('대상 VM이 필요합니다.');
  if (!username || !password) throw new Error('새 계정의 사용자명/비밀번호가 필요합니다.');

  const vc = (loadVcenterConfig().vcenters || []).find((v) => v.id === vcenterId);
  if (!vc) throw new Error(`vCenter(${vcenterId}) 설정을 찾을 수 없습니다(live 모드 필요).`);
  /*
   * v2.742(감사 VC-03): 비활성·점검중·엣지 위임(site) vCenter 에는 로그인하지 않는다 — 예전에는 VM 확인보다 로그인이 먼저라
   *   관리자가 끈 vCenter 에도 로그인이 나갔다(판정은 collectTarget.js 하나 — dsBrowse.js onDemandVcBlock 이 묶는다).
   *   ⚠ 인증 정지(주 폴러가 자격증명 거부로 멈춘 vCenter)는 **막지 않는다** — 관리자가 누른 수동 작업이라 1회 시도한다
   *   (authGuard 규칙 3 · v2.741 심층 검색 게스트 탐침과 같은 판단). 대신 거부는 주 폴러와 같은 정지 기록에 올리고,
   *   실패 문구가 '이미 멈춰 있던 vCenter' 라는 사실을 말한다.
   */
  const block = onDemandVcBlock(vc, { allowAuthStopped: true });
  if (block) throw onDemandBlockError(block);
  const stoppedBefore = vcAuthStopOf(vc);   // 읽기 전용 — 막지 않는다. 실패 문구에만 쓴다.

  const snap = store.get();
  const hostByName = new Map();
  for (const h of snap.hosts || []) if (h.vcenterId === vcenterId) hostByName.set(h.name, h);
  const vmById = new Map();
  for (const v of snap.vms || []) if (v.vcenterId === vcenterId) vmById.set(v.id, v);
  const gset = loadGpuGuestSettings();

  const c = new VimSoapClient(vc);
  const results = [];
  try {
    try { await c.login(); }
    catch (e) {
      const le = onDemandLoginError(vc, e);   // 자격증명 거부만 기록한다(시한·연결 실패는 원래 오류 그대로 — authGuard 규칙 4)
      if (le === e) throw e;
      le.message = `vCenter 로그인 실패: ${e.message}${stoppedBefore ? ' — 인증 실패로 주기 수집이 이미 멈춰 있던 vCenter 입니다(수동 실행이라 1회 시도)' : ''} · 인증 실패 기록 ${le.authStopped?.attempts ?? '?'}회`;
      throw le;
    }
    for (const vmId of vmIds) {
      const v = vmById.get(vmId);
      const moref = morefOf(vmId, v?.vcenterId || vcenterId);
      const name = v?.name || moref;
      try {
        if (!v) { results.push({ vmId, name, ok: false, error: '스냅샷에서 VM을 찾을 수 없음' }); continue; }
        const isWindows = /windows/i.test(v.guestOS || '');
        // 게스트 인증 계정: 요청값 우선, 없으면 GPU 게스트 설정의 vCenter(OS별)/VM 계정.
        let creds = (guestUser && guestPass) ? { username: guestUser, password: guestPass } : resolveVmCreds(gset, vcenterId, vmId, isWindows);
        if (!creds || !creds.username) { results.push({ vmId, name, ok: false, error: '게스트 인증 계정 없음(root 계정 입력 또는 GPU 게스트 설정)' }); continue; }
        const h = hostByName.get(v.host);
        const dlHosts = h ? [h.mgmtIp, h.name].filter(Boolean) : [];
        const r = await addGuestUser(c, moref, creds, { username, password, sudo, nopasswd, isWindows, dlHosts });
        results.push({ vmId, name, ok: r.ok, exitCode: r.exitCode, stdout: r.stdout, error: r.ok ? null : (r.stderr || `exitCode=${r.exitCode}`) });
      } catch (e) { results.push({ vmId, name, ok: false, error: e.guestDiag ? e.message : String(e.message).slice(0, 200) }); }
    }
  } finally { await c.logout().catch(() => {}); }
  return { vcenterId, account: username, sudo, nopasswd, results, ok: results.filter((r) => r.ok).length, fail: results.filter((r) => !r.ok).length };
}
