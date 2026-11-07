/**
 * views/platform/platformText.js — '서버 › 가상화 플랫폼' 허브(v2.915 · 설계 docs/design/virt-platform-menu 시안 A · 컨펌 2026-11-07)의 순수 보조(vitest 고정).
 *
 *  · 메뉴 하나 = 탭 세 개(vCenter · 호스트 · VM). 탭 id(vcenters · hosts · vms) · 해시 · 권한 id 는 그대로다 — 여기서는 이름 · 순서 · 문구 · 기억만 정한다.
 *  · 숫자 판정은 서버 /platform/summary(inventory/platformSummary.js) 하나 — 여기서는 글자로 바꾸기만 한다. 못 읽은 값(null)은 '—' 이고 단위를 붙이지 않는다.
 *  · 도구 키는 바꾸지 않는다(권한 파일의 값). 탭 줄 오른쪽의 도구는 그 탭 성격의 특수 기능 — vCenter 6 · 호스트 4 · VM 6(vmHubText.HUB_TOOLS).
 *  · localStorage 는 try/catch(사생활 모드 · 차단에서 던진다) — 못 기억해도 화면은 동작한다.
 */
import { numOrNull } from '../../numOrNull.js';
import { HUB_TOOLS } from '../vms/vmHubText.js';

/** 허브 탭 — 순서 = 계층(법인 → 호스트 → VM). k 는 App 의 탭 id 그대로. */
export const PLATFORM_TABS = Object.freeze([
  { k: 'vcenters', label: 'vCenter', sub: '법인', perm: 'dashboard' },
  { k: 'hosts', label: 'ESXi 호스트', sub: '', perm: 'inv.hosts' },
  { k: 'vms', label: '가상화 서버 · VM', sub: '', perm: 'inv.vms' },
]);
export const PLATFORM_TAB_KEYS = Object.freeze(PLATFORM_TABS.map((t) => t.k));
export const PLATFORM_MENU_LABEL = '가상화 플랫폼';
export const isPlatformTab = (t) => PLATFORM_TAB_KEYS.includes(t);

/** 공용 범위 바 문구 — 세 탭이 같은 바를 쓴다(사용자 요청 2026-11-07). */
export const SCOPE_SEARCH_PLACEHOLDER = 'vCenter · 호스트 · VM 이름 · IP';
export const SCOPE_NOTE = '범위 · 검색은 vCenter · 호스트 · VM 탭에 함께 적용됩니다';

/** 탭 줄 오른쪽 도구 — [도구 키, 짧은 이름]. 키는 specialToolsList 의 k 그대로(바꾸지 않는다). */
export const VC_TOOLS = Object.freeze([
  ['vcversion', 'vCenter 버전별'], ['solutions', 'VMware 솔루션 / NSX'], ['licenses', '라이선스 한눈에'],
  ['license-expiry', '라이선스 만료일'], ['cert-expiry', '인증서 만료 감시'], ['change-history', '구성 변경 이력'],
]);
export const HOST_TOOLS = Object.freeze([
  ['host-hygiene', 'ESXi 호스트 구성 점검'], ['esxi', 'ESXi 버전별'], ['hba', 'HBA 카드 속도'], ['cluster-check', '클러스터 HA·DRS 점검'],
]);
/** 메뉴 항목 also 에 들어가는 전체(VM 도구 6 + vCenter 6 + 호스트 4) — 그 도구를 열어도 '서버 › 가상화 플랫폼' 이 켜진다. 순서 = VM(기존) → vCenter → 호스트. */
export const PLATFORM_TOOL_KEYS = Object.freeze([...HUB_TOOLS.map(([k]) => k), ...VC_TOOLS.map(([k]) => k), ...HOST_TOOLS.map(([k]) => k)]);

/** 브라우저 기억 키 — 마지막 본 탭 · 바로가기 접힘 · vCenter 탭 보기(카드 | 표). */
export const LS_TAB = 'platform.tab';
export const LS_CHIPS = 'platform.chips';
export const LS_VC_VIEW = 'platform.vcView';

export function loadLastTab(storage, ok = () => true) {
  try {
    const v = storage?.getItem?.(LS_TAB);
    return isPlatformTab(v) && ok(v) ? v : null;
  } catch { return null; }
}
export function saveLastTab(storage, t) {
  if (!isPlatformTab(t)) return;
  try { storage?.setItem?.(LS_TAB, t); } catch { /* 기억 못 해도 화면은 동작한다 */ }
}
export function loadChipsCollapsed(storage) {
  try { return storage?.getItem?.(LS_CHIPS) === '1'; } catch { return false; }
}
export function saveChipsCollapsed(storage, collapsed) {
  try { storage?.setItem?.(LS_CHIPS, collapsed ? '1' : '0'); } catch { /* */ }
}
export const VC_VIEWS = Object.freeze([['cards', '카드'], ['table', '표']]);
export function loadVcView(storage) {
  try { const v = storage?.getItem?.(LS_VC_VIEW); return VC_VIEWS.some(([k]) => k === v) ? v : 'cards'; } catch { return 'cards'; }
}
export function saveVcView(storage, v) {
  if (!VC_VIEWS.some(([k]) => k === v)) return;
  try { storage?.setItem?.(LS_VC_VIEW, v); } catch { /* */ }
}

export const fmtN = (v) => { const n = numOrNull(v); return n == null ? '—' : n.toLocaleString('en-US'); };

/**
 * 엔티티 탭 3장의 글자 — 서버 요약(totals)에서. 분해는 **그 탭에만 있는 것**(시안 §4.0-2): vCenter 는 연결 · 불가 · REST 폴백 · 엣지 위임 · 알람,
 * 호스트는 연결 · 점검 · 끊김 · 미수집 · 클러스터, VM 은 구동 · 정지 · 미수집 · 템플릿. 배지는 '지금 볼 것'(낡은 값 · 확인 대상 · 조치 필요) — 0 이면 없다.
 * 요약이 아직 없으면(응답 전 · 첫 수집 중 · 권한 없음) 수는 '—' 이고 배지도 없다(0 을 지어내지 않는다).
 */
export function entityTabs(summary) {
  const t = summary && typeof summary === 'object' && !summary.initial ? summary.totals : null;
  const v = t?.vcenters || null; const a = t?.alarms || null; const h = t?.hosts || null; const m = t?.vms || null;
  const pos = (x) => numOrNull(x) != null && x > 0;
  return [
    {
      k: 'vcenters', label: 'vCenter', sub: '법인', value: fmtN(v?.total),
      badge: pos(v?.stale) ? { text: `낡은 값 ${fmtN(v.stale)}`, tone: 'amber' } : pos(v?.unreachable) ? { text: `불가 ${fmtN(v.unreachable)}`, tone: 'red' } : null,
      parts: v ? [
        { text: `연결 ${fmtN(v.connected)}`, tone: 'green' }, { text: `불가 ${fmtN(v.unreachable)}`, tone: pos(v.unreachable) ? 'red' : '' },
        { text: `REST 폴백 ${fmtN(v.rest)}` }, { text: `엣지 위임 ${fmtN(v.site)}` },
        { text: `알람 ${fmtN(a?.total)}`, tone: pos(a?.critical) ? 'red' : '', note: pos(a?.unknownVcs) ? `(미조회 ${fmtN(a.unknownVcs)}곳 제외)` : '',
          title: pos(a?.unknownVcs) ? 'REST 폴백으로 수집된 vCenter 는 경보를 조회하지 않아 합계에 없습니다 — 0건이 아닙니다' : '' },
      ] : [],
    },
    {
      k: 'hosts', label: 'ESXi 호스트', sub: '', value: fmtN(h?.total),
      badge: pos(h?.attention) ? { text: `확인 대상 ${fmtN(h.attention)}`, tone: 'amber' } : null,
      parts: h ? [
        { text: `연결 ${fmtN(h.connected)}` }, { text: `점검 ${fmtN(h.maint)}`, tone: pos(h.maint) ? 'amber' : '' }, { text: `끊김 ${fmtN(h.down)}`, tone: pos(h.down) ? 'red' : '' },
        { text: `미수집 ${fmtN(h.unread)}` }, { text: `클러스터 ${fmtN(h.clusters)}` },
        ...(pos(h.unknownVcs) ? [{ text: `개수 모름 ${fmtN(h.unknownVcs)}곳`, title: '첫 수집 중 · 비활성 · 연결 실패인 법인 — 0대가 아니라 모르는 것입니다' }] : []),
      ] : [],
    },
    {
      k: 'vms', label: '가상화 서버 · VM', sub: '', value: fmtN(m?.total),
      badge: pos(m?.attention) ? { text: `조치 필요 ${fmtN(m.attention)}`, tone: 'red' } : null,
      parts: m ? [
        { text: `구동 ${fmtN(m.on)}`, tone: 'green' }, { text: `정지 ${fmtN(m.off)}` }, { text: `사용률 미수집 ${fmtN(m.usageUnknown)}` }, { text: `템플릿 ${fmtN(m.templates)}` },
        ...(pos(m.unknownVcs) ? [{ text: `개수 모름 ${fmtN(m.unknownVcs)}곳`, title: '첫 수집 중 · 비활성 · 연결 실패인 법인 — 0대가 아니라 모르는 것입니다' }] : []),
      ] : [],
    },
  ];
}

/**
 * 바로가기 칩 하나의 숫자 — 이 탭의 '지금 볼 것'(vCenter: 알람 · 호스트: 확인 대상 · VM: 조치 필요). 모르면 null('—' 는 그리지 않고 숫자만 비운다).
 * @returns {{ n:number|null, tone:'red'|'amber'|'', title:string }}
 */
export function chipCount(row, tab) {
  if (!row || typeof row !== 'object') return { n: null, tone: '', title: '' };
  if (tab === 'hosts') { const n = numOrNull(row.hosts?.attention); return { n, tone: n > 0 ? 'amber' : '', title: n == null ? '확인 대상 수를 모릅니다' : `확인 대상 호스트 ${n}` }; }
  if (tab === 'vms') { const n = numOrNull(row.vms?.attention); return { n, tone: n > 0 ? 'red' : '', title: n == null ? '조치 필요 수를 모릅니다' : `조치 필요 VM ${n}` }; }
  if (row.alarms?.unknown) return { n: null, tone: '', title: 'REST 폴백 — 경보를 조회하지 않았습니다(0건이 아닙니다)' };
  const n = numOrNull(row.alarms?.critical) == null ? null : (row.alarms.critical || 0) + (row.alarms.warning || 0);
  return { n, tone: row.alarms?.critical > 0 ? 'red' : n > 0 ? 'amber' : '', title: n == null ? '알람 수를 모릅니다' : `알람 ${n}(심각 ${row.alarms?.critical ?? 0})` };
}

/** 칩 숫자의 뜻(줄 끝 안내). */
export function chipLegend(tab) {
  return tab === 'hosts' ? '숫자 = 그 vCenter 의 확인 대상 호스트 · 고른 법인은 파랗게'
    : tab === 'vms' ? '숫자 = 그 vCenter 의 조치 필요 VM · 고른 법인은 파랗게'
      : '숫자 = 그 vCenter 의 알람 · 고른 법인은 파랗게';
}

/** '조치 필요' 타일(VM 탭 — 예전 '전체 VM' 타일 자리)의 신호 분해 — 서버 signalCounts 키 순서. */
export const SIGNAL_TILE = Object.freeze([
  ['overload', '과부하', 'red'], ['usageUnknown', '미수집', ''], ['toolsOld', 'Tools 구버전', 'amber'], ['snapOld', '스냅샷 오래됨', 'amber'],
]);
export function signalSegments(sc) {
  const any = numOrNull(sc?.any);
  return SIGNAL_TILE.map(([k, label, tone]) => {
    const n = numOrNull(sc?.[k]);
    return { k, label, tone, n, pct: any && n != null ? Math.round((n / any) * 100) : 0 };
  });
}
