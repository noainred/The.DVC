/**
 * views/platform/platformText.js — '서버 › 가상화 플랫폼' 허브(v2.915 · 설계 docs/design/virt-platform-menu 시안 A · 컨펌 2026-11-07)의 순수 보조(vitest 고정).
 *
 *  · 탭 세 개(vCenter · 호스트 · VM) — v2.994 부터 메뉴 항목 둘('Virtual Machine(VM)' = vCenter · VM · 'Hypervisor' = 호스트). 탭 id(vcenters · hosts · vms) · 해시 · 권한 id 는 그대로다 — 여기서는 이름 · 순서 · 문구 · 기억만 정한다.
 *  · 숫자 판정은 서버 /platform/summary(inventory/platformSummary.js) 하나 — 여기서는 글자로 바꾸기만 한다. 못 읽은 값(null)은 '—' 이고 단위를 붙이지 않는다.
 *  · 도구 키는 바꾸지 않는다(권한 파일의 값). 탭 줄 오른쪽의 도구는 그 탭 성격의 특수 기능 — vCenter 6 · 호스트 4 · VM 6(vmHubText.HUB_TOOLS).
 *  · localStorage 는 try/catch(사생활 모드 · 차단에서 던진다) — 못 기억해도 화면은 동작한다.
 */
import { numOrNull } from '../../numOrNull.js';
import { HUB_TOOLS } from '../vms/vmHubText.js';
import { handoffMany, takeSearch } from '../../hooks/searchHandoff.js'; // v2.959: KPI 카드 → 도구 화면에 고른 vCenter 인계(메모리)
import { MENU_GROUPS, tabsOf } from '../topMenu.js'; // v2.994: 허브 제목 = 그 탭에서 켜지는 사이드바 항목 이름(이름 코어는 MENU_GROUPS 하나)

/** 허브 탭 — 순서 = 계층(법인 → 호스트 → VM). k 는 App 의 탭 id 그대로.
 *  v2.994(사용자 요청 2026-11-13 · 설계 docs/design/server-menu-rename): 이름 'Hypervisor' · 'Virtual Machine' — 옛 이름은 작은 글자(sub)로 남긴다. */
export const PLATFORM_TABS = Object.freeze([
  { k: 'vcenters', label: 'vCenter', sub: '법인', perm: 'dashboard' },
  { k: 'hosts', label: 'Hypervisor', sub: 'ESXi 호스트', perm: 'inv.hosts' },
  { k: 'vms', label: 'Virtual Machine', sub: 'VM', perm: 'inv.vms' },
]);
export const PLATFORM_TAB_KEYS = Object.freeze(PLATFORM_TABS.map((t) => t.k));
export const isPlatformTab = (t) => PLATFORM_TAB_KEYS.includes(t);

/**
 * v2.994: 허브 제목 — 그 탭에서 사이드바에 켜지는 기본 메뉴 항목의 이름(vcenters · vms → 'Virtual Machine(VM)', hosts → 'Hypervisor').
 * 이름을 여기 따로 적지 않는다 — topMenu.MENU_GROUPS 의 라벨을 읽는다(v2.915 의 상수 PLATFORM_MENU_LABEL 은 없앴다). 허브 탭이 아니면 ''.
 */
export function platformMenuLabel(tab, groups = MENU_GROUPS) {
  if (!isPlatformTab(tab)) return '';
  for (const g of groups) {
    for (const c of Array.isArray(g.children) ? g.children : [g]) if (c.tab && tabsOf(c).includes(tab)) return String(c.label || '');
  }
  return '';
}

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
/**
 * 메뉴 항목 also 에 들어가는 도구 — v2.994 부터 두 항목으로 갈린다: 'Virtual Machine(VM)'(virt) = VM 6 + vCenter 6 · 'Hypervisor'(hv) = 호스트 4.
 * 그 도구를 열면 그 항목이 켜진다(topMenu.locate). 순서 = VM(기존) → vCenter → 호스트. 전체(16)는 PLATFORM_TOOL_KEYS.
 */
export const VM_ITEM_TOOL_KEYS = Object.freeze([...HUB_TOOLS.map(([k]) => k), ...VC_TOOLS.map(([k]) => k)]);
export const HV_ITEM_TOOL_KEYS = Object.freeze(HOST_TOOLS.map(([k]) => k));
export const PLATFORM_TOOL_KEYS = Object.freeze([...VM_ITEM_TOOL_KEYS, ...HV_ITEM_TOOL_KEYS]);

/** 브라우저 기억 키 — 바로가기 접힘 · vCenter 탭 보기(카드 | 표). v2.994: '마지막 본 탭'(platform.tab) 기억은 없앴다 — 메뉴 항목마다 자기 탭으로 간다. */
export const LS_CHIPS = 'platform.chips';
export const LS_VC_VIEW = 'platform.vcView';

export function loadChipsCollapsed(storage) {
  try { return storage?.getItem?.(LS_CHIPS) === '1'; } catch { return false; }
}
export function saveChipsCollapsed(storage, collapsed) {
  try { storage?.setItem?.(LS_CHIPS, collapsed ? '1' : '0'); } catch { /* */ }
}
/**
 * v2.958(사용자 요청 2026-11-10 "법인 선택하면 상태창의 백업/VM 수량 등을 법인에 맞게"): vCenter 탭 KPI 줄(VM 백업 · VM 증가 · 스토리지 증가)은
 * 허브 범위(리전 · vCenter) 안의 법인만 합한다. 검색어는 범위가 아니라 찾기라 KPI 에 걸지 않는다.
 *  - scopeLabel: KPI 문구의 머리 — 전체 / vCenter 이름 / '리전 X · N법인'.
 *  - bareosSumOf: Bareos 백업 현황 rows[] 중 범위 안 법인의 counts.jobs 합 — 못 읽은 법인(counts 없음)은 0 으로 더하지 않고 unknown 으로 센다 · 하나도 못 읽었으면 jobs null.
 */
/** v3.12.8: 리전 글자 — 'Unknown'(위치를 비워 등록)은 '리전 미지정', 그 밖은 '리전 X'. 범위 글자 · 칩 안내 · 범위 바가 한 벌로 쓴다. */
export function regionText(r) {
  const v = String(r || '').trim();
  return v === 'Unknown' ? '리전 미지정' : `리전 ${v}`;
}
export function scopeLabel(scope, sitesInScope) {
  const vc = String(scope?.vcenterId || ''); const region = String(scope?.region || '');
  const list = Array.isArray(sitesInScope) ? sitesInScope : [];
  if (vc) { const s = list.find((x) => x && x.id === vc); return s ? String(s.name || s.id) : vc; }
  if (region) return `${regionText(region)} · ${list.length}법인`;
  return '전체';
}
export function bareosSumOf(rows, ids) {
  const by = new Map((Array.isArray(rows) ? rows : []).filter((r) => r && typeof r === 'object').map((r) => [r.id, r]));
  let jobs = 0; let known = 0; let unknown = 0;
  for (const id of Array.isArray(ids) ? ids : []) {
    const r = by.get(id);
    const n = numOrNull(r?.counts?.jobs);
    if (n == null) { unknown += 1; continue; }
    jobs += n; known += 1;
  }
  return { jobs: known ? jobs : null, known, unknown, partial: known > 0 && unknown > 0 };
}

/**
 * v2.959(사용자 요청 2026-11-10 "법인을 선택한 상태에서 백업 · VM 수량 · 스토리지 증가 버튼 누르면 해당 법인에 대한 정보 보여주기"):
 * KPI 카드를 누르면 그 도구 화면으로 가면서 **고른 vCenter 를 메모리 인계**(hooks/searchHandoff — URL 에 싣지 않는다 · 30초 · 꺼내면 지운다)로 넘긴다.
 * 받는 도구는 마운트 때 한 번 꺼내 vCenter 선택 칸의 초기값으로 쓴다(VmTrackTool · StorageTrackTool). 범위가 리전뿐이면(vCenter 없음) 넘길 것이 없어 전체로 연다.
 */
export const KPI_HANDOFF = Object.freeze({ vmTrack: 'vm-track:vcenter', storageTrack: 'storage-track:vcenter', vmTrackRegion: 'vm-track:region', storageTrackRegion: 'storage-track:region', backupSummaryRegion: 'backup-summary:region' });   // v3.10.17 백업 카드 → Summary 리전
/**
 * v3.10.15(점검 3회차): KPI 카드 → 도구에 **리전도** 넘긴다(법인을 고르지 않고 리전만 골랐을 때 — 전에는 전체로 열렸다). 한 번의 인계에 vCenter · 리전을 함께 남긴다(handoffMany 는 새로 남길 때 이전 것을 지운다).
 * 도구 쪽 보조: regionsOf(목록의 리전 · 빈 값 제외 · 이름순) · vcInRegion(리전 안 vCenter — 리전이 없으면 전부).
 */
export function handoffKpiScope(targets, scope) {
  const vc = String(scope?.vcenterId || '').trim(); const region = String(scope?.region || '').trim();
  const entries = [];
  if (vc && targets?.vc) entries.push([targets.vc, vc]);
  else if (region && targets?.region) entries.push([targets.region, region]);
  if (!entries.length) return false;
  handoffMany(entries);
  return true;
}
export function regionsOf(vcList) {
  const set = new Set((Array.isArray(vcList) ? vcList : []).map((v) => String(v?.region || '').trim()).filter(Boolean));
  return [...set].sort((a, b) => a.localeCompare(b, 'ko'));
}
export function vcInRegion(vcList, region) {
  const r = String(region || '').trim();
  const list = (Array.isArray(vcList) ? vcList : []).filter((v) => v && typeof v === 'object');
  return r ? list.filter((v) => String(v.region || '') === r) : list;
}
export function handoffKpiVcenter(target, vcenterId) {
  const id = String(vcenterId || '').trim();
  if (!id) return false;
  handoffMany([[target, id]]);
  return true;
}
export function takeKpiVcenter(target) { return takeSearch(target) || ''; }

/**
 * v3.10.13(점검 1회차): vCenter 목록의 검색어 규칙 한 벌(공백 구분 다중 키워드 AND — 이름 · id · 도시 · 국가 · 리전 · 버전)과,
 * 상세의 ‹ 이전 · 다음 › 이 도는 **이웃 목록 = 허브에서 보던 범위(리전 · 검색어) 안의 vCenter**. 고른 법인 하나(vcenterId)는 범위로 치지 않는다(그러면 이웃이 없다).
 * 전에는 범위를 리전으로 좁혀도 상세의 이전 · 다음이 전 법인을 돌았다(세 탭이 같은 범위를 쓴다는 v2.915 규약과 어긋남).
 */
export const keywordsOf = (q) => String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
export function vcMatches(s, keywords) {
  if (!s || typeof s !== 'object') return false;
  if (!Array.isArray(keywords) || keywords.length === 0) return true;
  const hay = [s.name, s.id, s.location?.city, s.location?.country, s.location?.region, s.version].filter(Boolean).join(' ').toLowerCase();
  return keywords.every((kw) => hay.includes(kw));
}
export function siblingSites(sites, scope) {
  const region = String(scope?.region || '');
  const kws = keywordsOf(scope?.q);
  return (Array.isArray(sites) ? sites : []).filter((s) => s && typeof s === 'object' && (!region || s.location?.region === region) && vcMatches(s, kws));
}
/** 이전 · 다음 옆에 붙는 범위 글자 — 리전 · 검색어가 있을 때만('리전 유럽 · ‘kr1’'), 없으면 ''. */
export function siblingScopeText(scope) {
  const region = String(scope?.region || '').trim(); const q = String(scope?.q || '').trim();
  return [region ? regionText(region) : '', q ? `‘${q}’` : ''].filter(Boolean).join(' · ');
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
const tabText = (k) => { const x = PLATFORM_TABS.find((p) => p.k === k); return { label: x.label, sub: x.sub }; };   // v2.994: 탭 이름은 PLATFORM_TABS 하나
export function entityTabs(summary) {
  const t = summary && typeof summary === 'object' && !summary.initial ? summary.totals : null;
  const v = t?.vcenters || null; const a = t?.alarms || null; const h = t?.hosts || null; const m = t?.vms || null;
  const pos = (x) => numOrNull(x) != null && x > 0;
  return [
    {
      k: 'vcenters', ...tabText('vcenters'), value: fmtN(v?.total),
      badge: pos(v?.stale) ? { text: `낡은 값 ${fmtN(v.stale)}`, tone: 'amber' } : pos(v?.unreachable) ? { text: `불가 ${fmtN(v.unreachable)}`, tone: 'red' } : null,
      parts: v ? [
        { text: `연결 ${fmtN(v.connected)}`, tone: 'green' }, { text: `불가 ${fmtN(v.unreachable)}`, tone: pos(v.unreachable) ? 'red' : '' },
        { text: `REST 폴백 ${fmtN(v.rest)}` }, { text: `엣지 위임 ${fmtN(v.site)}` },
        { text: `알람 ${fmtN(a?.total)}`, tone: pos(a?.critical) ? 'red' : '', note: pos(a?.unknownVcs) ? `(미조회 ${fmtN(a.unknownVcs)}곳 제외)` : '',
          title: pos(a?.unknownVcs) ? 'REST 폴백으로 수집된 vCenter 는 경보를 조회하지 않아 합계에 없습니다 — 0건이 아닙니다' : '' },
      ] : [],
    },
    {
      k: 'hosts', ...tabText('hosts'), value: fmtN(h?.total),
      badge: pos(h?.attention) ? { text: `확인 대상 ${fmtN(h.attention)}`, tone: 'amber' } : null,
      parts: h ? [
        { text: `연결 ${fmtN(h.connected)}` }, { text: `점검 ${fmtN(h.maint)}`, tone: pos(h.maint) ? 'amber' : '' }, { text: `끊김 ${fmtN(h.down)}`, tone: pos(h.down) ? 'red' : '' },
        { text: `미수집 ${fmtN(h.unread)}` }, { text: `클러스터 ${fmtN(h.clusters)}` },
        ...(pos(h.unknownVcs) ? [{ text: `개수 모름 ${fmtN(h.unknownVcs)}곳`, title: '첫 수집 중 · 비활성 · 연결 실패인 법인 — 0대가 아니라 모르는 것입니다' }] : []),
      ] : [],
    },
    {
      k: 'vms', ...tabText('vms'), value: fmtN(m?.total),
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
/**
 * v3.10.14(점검 2회차): 바로가기 칩은 **고른 리전 안의 법인만** 보인다(전에는 리전을 골라도 28곳 전부 — 리전 밖 칩을 누르면 리전이 지워져 범위가 튀었다).
 * 리전이 없으면 전부. 리전에 맞는 법인이 없으면 빈 목록(칩 줄은 안내만 — 전체로 넓히지 않는다).
 */
export function chipSites(vcenters, region) {
  const r = String(region || '');
  const list = (Array.isArray(vcenters) ? vcenters : []).filter((s) => s && typeof s === 'object');
  return r ? list.filter((s) => String(s.location?.region ?? '') === r) : list;
}
/**
 * v3.12.2(2차 루프 1회차): 공용 범위 바의 vCenter 선택지 — 리전을 골랐으면 **그 리전 vCenter 만**(칩과 같은 판정 chipSites).
 *   예전에는 리전과 무관하게 전부를 보여 리전 밖 vCenter 를 고를 수 있었고, 그러면 허브 카드(그 vCenter 숫자)와 본문(리전 ∩ vCenter = 0건)이 엇갈렸다.
 *   지금 고른 vCenter 가 리전 밖이면(다른 경로에서 넘어온 값) 맨 앞에 남기고 outside 로 표시한다 — 선택 상자가 거짓 '전체 vCenter' 를 보이지 않게.
 * @returns {Array<{id:string, name:string, outside:boolean}>}
 */
export function scopeVcOptions(vcenters, region, vcenterId = '') {
  const list = chipSites(vcenters, region).map((v) => ({ id: String(v.id), name: String(v.name || v.id), outside: false }));
  const id = String(vcenterId || '');
  if (id && !list.some((o) => o.id === id)) {
    const v = (Array.isArray(vcenters) ? vcenters : []).find((x) => x && String(x.id) === id);
    list.unshift({ id, name: String(v?.name || id), outside: !!String(region || '') });
  }
  return list;
}
/**
 * v3.12.8(2차 루프 7회차): 공용 범위 바의 리전 선택지 — 정해진 4리전(regions.js) **더하기 등록 데이터에만 있는 리전**(예: 위치를 비워 등록해 서버가 'Unknown' 으로 둔 vCenter).
 *   예전에는 정해진 4리전만 보여 그런 vCenter 는 리전으로 거를 수 없었다(도구의 리전 선택 — regionsOf — 은 데이터에서 만들어 보였다). 범위 계정(scope.regions)은 그 리전만.
 * @returns {Array<{value:string, label:string}>}
 */
export function scopeRegionOptions(base, vcenters, allowed = null) {
  const fixed = (Array.isArray(base) ? base : []).map(String);
  const extra = [...new Set((Array.isArray(vcenters) ? vcenters : []).map((v) => String(v?.location?.region ?? '').trim()).filter((r) => r && !fixed.includes(r)))]
    .sort((a, b) => (a === 'Unknown') - (b === 'Unknown') || a.localeCompare(b, 'ko'));   // 'Unknown'(위치 미지정)은 맨 뒤
  const all = [...fixed, ...extra];
  const list = Array.isArray(allowed) && allowed.length ? all.filter((r) => allowed.includes(r)) : all;
  return list.map((r) => ({ value: r, label: r === 'Unknown' ? '리전 미지정(Unknown)' : r }));   // 선택지 글자는 값을 함께 보인다(regionText 와 구분)
}
/** vCenter 를 고를 때의 patch — 리전 밖 vCenter 면 리전을 비운다(vCenter 하나가 리전보다 좁다 · 둘이 엇갈리면 화면이 빈다). 목록에 없는 id 는 리전을 그대로 둔다. */
export function scopeVcPatch(vcenters, region, id) {
  const v = String(id || ''); const r = String(region || '');
  if (!v || !r) return { vcenterId: v };
  const vc = (Array.isArray(vcenters) ? vcenters : []).find((x) => x && String(x.id) === v);
  return vc && String(vc.location?.region ?? '') !== r ? { vcenterId: v, region: '' } : { vcenterId: v };
}
/** 칩 줄 범례 앞에 붙는 리전 안내 — '리전 유럽 · 5법인'(리전이 없으면 ''). */
export function chipRegionNote(region, n) {
  const r = String(region || '').trim();
  return r ? `${regionText(r)} · ${Number.isFinite(n) ? n : 0}법인` : '';
}

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
