/**
 * curuser/scope.js — 수집 대상 VM 해석(v2.520, 순수 모듈).
 *
 * 사용자 요청의 '설정에서 지정한 폴더의 windows 서버' 를 판정으로 옮긴 것이다.
 *
 * ── 대상이 되는 조건(모두 만족) ─────────────────────────────────────────────────
 *  ① 그 vCenter 가 설정에서 켜져 있고 폴더가 지정돼 있다
 *  ② VM 의 폴더 경로가 지정 폴더에 속한다(하위 포함 옵션·제외 목록 반영)
 *  ③ **Windows** 게스트다(`guestOS` 문자열 판정 — vCenter 가 주는 값)
 *  ④ 전원이 켜져 있다
 *  ⑤ 템플릿이 아니다
 *  ⑥ VMware Tools 가 **실행 중**이다 — 게스트 안의 발행기(`vmtoolsd --cmd info-set`)가
 *     돌 수 있는 전제다. 멈춰 있으면 값이 갱신되지 않으므로 '대상 아님' 으로 밝힌다.
 *
 * ⚠ ③~⑥ 에 걸려 빠진 VM 은 **'사용자 0명' 이 아니라 '대상 아님'** 이다. 이유를 함께 돌려주고
 *   화면이 그 개수를 밝힌다 — 조용히 빼면 '이 폴더에 아무도 없다' 는 거짓이 된다.
 * ⚠ **게스트 계정은 필요하지 않다**(2026-09-15 사용자 결정 "Guestos 계정 없이"). 수집은
 *   게스트 안의 발행기가 `guestinfo.curuser.*` 에 써 둔 값을 vCenter `config.extraConfig` 로
 *   **읽기만** 한다 — 그래서 이 모듈에는 자격증명 판정이 없다. 초판(WIP)에 있던 `no-creds`
 *   사유는 제거했다. 있으면 영원히 만들어지지 않는 사유가 화면 범례에 남는다.
 * ⚠ 폴더 경로 비교는 **구분자·대소문자·앞뒤 공백을 정규화**한다. vCenter 는 `/DC/vm/Prod/WEB`
 *   처럼 주지만 사용자가 설정에 `\DC\vm\Prod\WEB ` 을 붙여 넣을 수 있다 — 정규화 없이 비교하면
 *   **지정한 폴더가 통째로 비어 보인다**(가장 흔한 신고 유형이 될 것이다).
 */

/** 폴더 경로 정규화 — `/` 통일, 중복 슬래시 제거, 끝 슬래시 제거, 소문자. */
export function normFolder(p) {
  return String(p ?? '')
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .trimEnd()   // v2.599(SEC2599-02): replace(/\s+$/g) 는 O(n²)
    .replace(/^\s+/g, '')
    .replace(/\/$/, '')
    .toLowerCase();
}

/** `child` 가 `parent` 와 같거나 그 하위인가(경계를 슬래시로 확인 — `/a/bc` 가 `/a/b` 에 안 걸리게). */
export function isUnder(child, parent) {
  const c = normFolder(child); const p = normFolder(parent);
  if (!p) return false;
  return c === p || c.startsWith(`${p}/`);
}

/** Windows 게스트 판정 — vCenter 의 `guestFullName` 문자열 기준(가장 신뢰할 수 있는 단일 출처). */
export function isWindowsGuest(guestOS) {
  return /windows|microsoft/i.test(String(guestOS || ''));
}

/** 제외 사유 코드 → 사람 문구. 화면·보고서가 이 문구를 쓴다. */
export const SKIP_REASON = Object.freeze({
  'not-windows': 'Windows 게스트가 아닙니다(이 기능은 Windows 로그온 세션만 셉니다).',
  'powered-off': '전원이 꺼져 있습니다.',
  template: '템플릿입니다.',
  'no-tools': 'VMware Tools 가 실행 중이 아닙니다 — 게스트 안의 발행기가 값을 갱신할 수 없습니다.',
  'over-limit': '한 주기 대상 상한을 넘어 이번 주기에서 제외됐습니다.',
});

/**
 * VMware Tools 실행 여부.
 *
 * ⚠ `/running/i` 만 보면 **`guestToolsNotRunning` 이 매치된다**(문자열 안에 'Running' 이 있다) —
 *   Tools 없는 VM 이 대상에 들어가 매 주기 게스트 실행을 시도하고 매번 실패한다. 합성 픽스처가
 *   실제로 잡아낸 결함이다. 그래서 **부정형을 먼저** 걸러낸다.
 *   vCenter 값: `guestToolsRunning` · `guestToolsNotRunning` · `guestToolsExecutingScripts`.
 */
const toolsRunning = (v) => {
  const s = String(v ?? '');
  if (!s) return false;
  if (/not\s*running/i.test(s)) return false;
  return /running|executing/i.test(s);
};

/**
 * 대상 해석.
 *
 * @param {object[]} vms      스냅샷 VM 목록(`vcenterId`·`folder`·`guestOS`·`powerState`·`template`·`toolsRunningStatus`)
 * @param {object}   settings `curuser/settings.js` 정규화 결과
 * @returns {{ targets: object[], skipped: Array<{vmId,name,vcenterId,folder,reason}>, overLimit: number, vcenters: string[] }}
 */
export function resolveTargets(vms, settings) {
  const s = settings || {};
  const targets = []; const skipped = [];
  const vcIds = new Set();
  if (s.enabled !== true) return { targets, skipped, overLimit: 0, vcenters: [] };

  for (const vm of (vms || [])) {
    const vcId = String(vm.vcenterId || '');
    const cfg = (s.vcenters || {})[vcId];
    if (!cfg || cfg.enabled !== true || !(cfg.folders || []).length) continue;   // 이 vCenter 는 범위 밖(제외 목록에 넣지 않는다 — 애초에 대상이 아니다)

    const folder = vm.folder || '';
    const inScope = cfg.includeSubfolders
      ? (cfg.folders || []).some((f) => isUnder(folder, f))
      : (cfg.folders || []).some((f) => normFolder(folder) === normFolder(f));
    if (!inScope) continue;
    if ((cfg.excludeFolders || []).some((f) => isUnder(folder, f))) continue;

    vcIds.add(vcId);
    const base = { vmId: vm.id, name: vm.name || '', vcenterId: vcId, folder, guestOS: vm.guestOS || '' };
    const isWin = isWindowsGuest(vm.guestOS);
    if (!isWin) { skipped.push({ ...base, reason: 'not-windows' }); continue; }
    if (vm.template === true) { skipped.push({ ...base, reason: 'template' }); continue; }
    if (!/on/i.test(String(vm.powerState || ''))) { skipped.push({ ...base, reason: 'powered-off' }); continue; }
    if (!toolsRunning(vm.toolsRunningStatus ?? vm.toolsStatus)) { skipped.push({ ...base, reason: 'no-tools' }); continue; }
    targets.push(base);
  }

  // 상한 — 자른 개수를 **밝힌다**(조용한 상한 금지).
  const max = Number(s.maxVms) || 400;
  let overLimit = 0;
  if (targets.length > max) {
    overLimit = targets.length - max;
    for (const t of targets.slice(max)) skipped.push({ ...t, reason: 'over-limit' });
    targets.length = max;
  }
  return { targets, skipped, overLimit, vcenters: [...vcIds] };
}
