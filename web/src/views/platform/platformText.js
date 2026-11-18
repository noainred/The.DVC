/**
 * views/platform/platformText.js — '서버 › 가상화 플랫폼' 허브(v2.915 · 설계 docs/design/virt-platform-menu 시안 A · 컨펌 2026-11-07)의 순수 보조(vitest 고정).
 *
 *  · 탭 세 개(vCenter · VM · 호스트) — v2.994 부터 메뉴 항목 둘('Virtual Machine(VM)' = vCenter · VM · 'Hypervisor' = 호스트). 탭 id(vcenters · hosts · vms) · 해시 · 권한 id 는 그대로다 — 여기서는 이름 · 순서 · 문구 · 기억만 정한다.
 *  · 숫자 판정은 서버 /platform/summary(inventory/platformSummary.js) 하나 — 여기서는 글자로 바꾸기만 한다. 못 읽은 값(null)은 '—' 이고 단위를 붙이지 않는다.
 *  · 도구 키는 바꾸지 않는다(권한 파일의 값). 탭 줄 오른쪽의 도구는 그 탭 성격의 특수 기능 — vCenter 6 · 호스트 4 · VM 6(vmHubText.HUB_TOOLS).
 *  · localStorage 는 try/catch(사생활 모드 · 차단에서 던진다) — 못 기억해도 화면은 동작한다.
 */
import { numOrNull } from '../../numOrNull.js';
import { HUB_TOOLS } from '../vms/vmHubText.js';
import { handoffMany, takeSearch } from '../../hooks/searchHandoff.js'; // v2.959: KPI 카드 → 도구 화면에 고른 vCenter 인계(메모리)
import { MENU_GROUPS, tabsOf } from '../topMenu.js'; // v2.994: 허브 제목 = 그 탭에서 켜지는 사이드바 항목 이름(이름 코어는 MENU_GROUPS 하나)

/** 허브 탭 — 순서 = vCenter · Virtual Machine · Hypervisor(v3.19.0 사용자 지시 2026-11-18 — 사이드바 '서버' 묶음의 Virtual Machine → Hypervisor 순서와 같다. 전에는 법인 → 호스트 → VM 이었다). k 는 App 의 탭 id 그대로.
 *  v2.994(사용자 요청 2026-11-13 · 설계 docs/design/server-menu-rename): 이름 'Hypervisor' · 'Virtual Machine' — 옛 이름은 작은 글자(sub)로 남긴다. */
export const PLATFORM_TABS = Object.freeze([
  { k: 'vcenters', label: 'vCenter', sub: '법인', perm: 'dashboard' },
  { k: 'vms', label: 'Virtual Machine', sub: 'VM', perm: 'inv.vms' },
  { k: 'hosts', label: 'Hypervisor', sub: 'ESXi 호스트', perm: 'inv.hosts' },
]);
export const PLATFORM_TAB_KEYS = Object.freeze(PLATFORM_TABS.map((t) => t.k));
export const isPlatformTab = (t) => PLATFORM_TAB_KEYS.includes(t);

/**
 * v2.994: 허브 제목 — 그 탭에서 사이드바에 켜지는 기본 메뉴 항목의 이름(vcenters · vms → 'Virtual Machine', hosts → 'Hypervisor').
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
 * 메뉴 항목 also 에 들어가는 도구 — v2.994 부터 두 항목으로 갈린다: 'Virtual Machine'(virt) = VM 6 + vCenter 6 · 'Hypervisor'(hv) = 호스트 4.
 * 그 도구를 열면 그 항목이 켜진다(topMenu.locate). 순서 = VM(기존) → vCenter → 호스트. 전체(16)는 PLATFORM_TOOL_KEYS.
 */
export const VM_ITEM_TOOL_KEYS = Object.freeze([...HUB_TOOLS.map(([k]) => k), ...VC_TOOLS.map(([k]) => k)]);
export const HV_ITEM_TOOL_KEYS = Object.freeze(HOST_TOOLS.map(([k]) => k));
export const PLATFORM_TOOL_KEYS = Object.freeze([...VM_ITEM_TOOL_KEYS, ...HV_ITEM_TOOL_KEYS]);

/** 브라우저 기억 키 — 바로가기 접힘. v3.19.0: vCenter 탭 보기(카드 | 표) 기억(platform.vcView)은 없앴다 — 표 보기가 없다(옛 저장 값은 읽지 않는다). v2.994: '마지막 본 탭'(platform.tab) 기억은 없앴다 — 메뉴 항목마다 자기 탭으로 간다. */
export const LS_CHIPS = 'platform.chips';

export function loadChipsCollapsed(storage) {
  try { return storage?.getItem?.(LS_CHIPS) === '1'; } catch { return false; }
}
export function saveChipsCollapsed(storage, collapsed) {
  try { storage?.setItem?.(LS_CHIPS, collapsed ? '1' : '0'); } catch { /* */ }
}
/**
 * v2.958(사용자 요청 2026-11-10): 허브 범위(리전 · vCenter) 글자. v3.19.0: vCenter 탭의 KPI 줄은 없앴지만 scopeLabel 은 VM 이름 검색 제목이 쓴다.
 *  - scopeLabel: KPI 문구의 머리 — 전체 / vCenter 이름 / '리전 X · N법인'.
 */
/** v3.13.6: 리전 글자 — 'Unknown'(위치를 비워 등록)은 '리전 미지정', 그 밖은 '리전 X'. 범위 글자 · 칩 안내 · 범위 바가 한 벌로 쓴다. */
export function regionText(r) {
  const v = String(r || '').trim();
  return v === 'Unknown' ? '리전 미지정' : `리전 ${v}`;
}
export function scopeLabel(scope, sitesInScope) {
  const ids = scopeIdsOf(scope); const region = String(scope?.region || '');
  const list = Array.isArray(sitesInScope) ? sitesInScope : [];
  if (ids.length > 1) return `법인 ${ids.length}곳`;   // v3.20.0 복수 선택
  const vc = ids[0] || '';
  if (vc) { const s = list.find((x) => x && x.id === vc); return s ? String(s.name || s.id) : vc; }
  if (region) return `${regionText(region)} · ${list.length}법인`;
  return '전체';
}
/**
 * v2.959(사용자 요청 2026-11-10 "법인을 선택한 상태에서 백업 · VM 수량 · 스토리지 증가 버튼 누르면 해당 법인에 대한 정보 보여주기"):
 * KPI 카드를 누르면 그 도구 화면으로 가면서 **고른 vCenter 를 메모리 인계**(hooks/searchHandoff — URL 에 싣지 않는다 · 30초 · 꺼내면 지운다)로 넘긴다.
 * 받는 도구는 마운트 때 한 번 꺼내 vCenter 선택 칸의 초기값으로 쓴다(VmTrackTool · StorageTrackTool). 범위가 리전뿐이면(vCenter 없음) 넘길 것이 없어 전체로 연다.
 */
export const KPI_HANDOFF = Object.freeze({ vmTrack: 'vm-track:vcenter', storageTrack: 'storage-track:vcenter', vmTrackRegion: 'vm-track:region', storageTrackRegion: 'storage-track:region', backupSummaryRegion: 'backup-summary:region' });   // v3.10.17 백업 카드 → Summary 리전
/** 도구 쪽 보조: regionsOf(목록의 리전 · 빈 값 제외 · 이름순) · vcInRegion(리전 안 vCenter — 리전이 없으면 전부). (v3.19.0: KPI 카드가 없어져 인계를 남기는 handoffKpiScope 는 지웠다 — 받는 쪽 takeKpiVcenter 만 남는다.) */
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
 * v3.20.0(사용자 요청 2026-11-18 "바로가기의 선택을 복수개 선택해서 볼 수 있게" · 설계 docs/design/vm-menu §5 ③ 기본값 ‘복수 선택 · 세 탭 공용’):
 * 허브 범위의 **고른 법인 목록**(vcenterIds — 배열 · 메모리만 · 저장하지 않는다) 판정 코어. App · 허브 칩 · 카드 · 상세 이웃이 이 한 벌을 쓴다.
 *  · API 계약: 0곳 = 둘 다 안 보냄(리전이 있으면 region) · 1곳 = 지금처럼 vcenterId=<id> · 2곳 이상 = vcenterIds=<id>,<id>(쉼표 목록) — 둘을 함께 보내지 않는다(hubScopeQuery).
 *    값은 날 글자로 잇고 인코딩은 보내는 쪽(URLSearchParams)이 한다 — 여기서 encodeURIComponent 를 하면 두 번 인코딩된다.
 *  · 허브 밖 탭 · 도구의 vcenterId(문자열 하나)는 그대로다 — 이 목록은 App 의 허브 칸(PLATFORM_SCOPE_KEY)에만 산다.
 */
export const SCOPE_IDS_MAX = 200;   // 서버 상한(등록 vCenter 수와 200 중 작은 값)과 같은 바깥 상한 — 화면에서 그 이상 고를 일은 없다
/** 목록 정리 — 배열 · 문자열(쉼표 목록 포함) 모두 받는다 · 앞뒤 공백 제거 · 빈 값 · 중복 제거 · 상한. 순서는 고른 차례 그대로. */
export function normScopeIds(v) {
  const raw = Array.isArray(v) ? v : (v == null ? [] : String(v).split(','));
  const out = [];
  for (const x of raw) {
    if (x == null || typeof x === 'object') continue;
    const id = String(x).trim();
    if (id && !out.includes(id)) out.push(id);
    if (out.length >= SCOPE_IDS_MAX) break;
  }
  return out;
}
/** 범위 객체에서 고른 법인 목록 — vcenterIds(목록)가 있으면 그것, 없으면 옛 단일 vcenterId 를 한 곳 목록으로. */
export function scopeIdsOf(scope) {
  if (!scope || typeof scope !== 'object') return [];
  const list = normScopeIds(scope.vcenterIds);
  if (list.length) return list;
  return normScopeIds(scope.vcenterId ? [scope.vcenterId] : []);
}
/** 목록 → 단일 vcenterId(옛 값을 읽는 곳 — 범위 바의 선택 칸 · 내보내기) — 정확히 1곳일 때만 그 id, 아니면 ''. */
export const singleScopeId = (ids) => { const l = normScopeIds(ids); return l.length === 1 ? l[0] : ''; };
/** 칩 하나를 켜고 끈다 — 있으면 빼고 없으면 뒤에 더한다(새 배열). */
export function toggleScopeId(ids, id) {
  const l = normScopeIds(ids); const v = String(id ?? '').trim();
  if (!v) return l;
  return l.includes(v) ? l.filter((x) => x !== v) : normScopeIds([...l, v]);
}
/**
 * 리전을 바꾸면 그 리전 밖 선택은 풀린다(scopeVcPatch 와 같은 규칙 — 리전과 고른 법인이 엇갈리면 화면이 빈다).
 * 리전이 없으면(전체 리전) 그대로. 목록에 없는 id(지워진 vCenter · 목록을 아직 못 받음)는 판정할 수 없어 남긴다 — 못 읽은 것을 리전 밖으로 단정하지 않는다.
 */
export function idsInRegion(ids, vcenters, region) {
  const l = normScopeIds(ids); const r = String(region || '');
  if (!r) return l;
  const byId = new Map((Array.isArray(vcenters) ? vcenters : []).filter((v) => v && typeof v === 'object').map((v) => [String(v.id), v]));
  return l.filter((id) => { const v = byId.get(id); return !v || String(v.location?.region ?? '') === r; });
}
/**
 * API 범위 쿼리 조각 — 허브 세 탭(/platform/summary · /hosts · /hosts/checks · /hosts/corp · /vms · /vms/by-vcenter)과 그 밖 탭의 filters · scope 를 이 함수 하나가 만든다.
 * 1곳 = { vcenterId } · 2곳 이상 = { vcenterIds: 'a,b' } · 0곳 = 리전이 있으면 { region } · 아무것도 없으면 {}. 고른 법인이 있으면 리전은 싣지 않는다(지금 규칙 — 법인이 리전보다 좁다).
 */
export function hubScopeQuery(scope) {
  const ids = scopeIdsOf(scope);
  if (ids.length === 1) return { vcenterId: ids[0] };
  if (ids.length > 1) return { vcenterIds: ids.join(',') };
  const region = String(scope?.region || '');
  return region ? { region } : {};
}
/** 범위 안 법인(카드) — 고른 법인이 있으면 그 법인들만(목록 순서 그대로), 없으면 리전. hubScopeQuery 가 서버에 싣는 것과 같은 뜻. */
export function sitesInHubScope(sites, scope) {
  const list = (Array.isArray(sites) ? sites : []).filter((s) => s && typeof s === 'object');
  const ids = scopeIdsOf(scope);
  if (ids.length) { const set = new Set(ids); return list.filter((s) => set.has(String(s.id))); }
  const region = String(scope?.region || '');
  return region ? list.filter((s) => s.location?.region === region) : list;
}
/**
 * App 허브 칸에 쓰는 patch 정규화 — 옛 단일 patch({ vcenterId })를 목록(vcenterIds)으로 바꾼다. 허브 칸에는 vcenterId 를 저장하지 않는다(값이 두 벌이 되지 않게).
 * 카드의 호스트 · VM 수 · VM 표의 법인 · 범위 바 선택 칸 · ⌘K 인계 · ‘필터 초기화’ 가 보내는 { vcenterId: id | '' } 가 그대로 한 곳 목록 · 빈 목록이 된다.
 */
export function hubScopePatch(patch) {
  const p = { ...(patch && typeof patch === 'object' ? patch : {}) };
  if ('vcenterId' in p) { const v = String(p.vcenterId || '').trim(); p.vcenterIds = v ? [v] : []; delete p.vcenterId; }
  if ('vcenterIds' in p) p.vcenterIds = normScopeIds(p.vcenterIds);
  return p;
}
/** 범위 바 vCenter 선택 칸의 ‘여러 곳’ 글자 — 2곳 이상이면 ‘법인 N곳 선택’(비활성 option), 아니면 ''. */
export const multiPickText = (ids) => { const n = normScopeIds(ids).length; return n > 1 ? `법인 ${n}곳 선택` : ''; };
export const MULTI_PICK_VALUE = '__multi__';   // 그 option 의 값(고를 수 없다 — disabled)

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
/**
 * v3.19.0(사용자 요청 2026-11-18 "바로가기 메뉴에 텍스트로 검색 — AAA AAB 가 있을 때 AA 를 입력하면 둘 다"): 바로가기 칩을 글자로 좁힌다.
 * 판정은 카드와 같은 vcMatches · keywordsOf 한 벌(부분 일치 · 대소문자 무시 · 공백 낱말 AND) — 새 판정을 만들지 않는다. 범위 바의 공용 검색(q)과는 별개의 값이다.
 * **고른 법인(selectedIds)의 칩은 일치하지 않아도 남긴다** — 다시 눌러 풀 수 있어야 한다. 빈 글자 = 전부(원본 순서 그대로).
 */
export function filterChipSites(sites, text, selectedIds = []) {
  const list = Array.isArray(sites) ? sites : [];
  const kws = keywordsOf(text);
  if (kws.length === 0) return list;
  const keep = new Set((Array.isArray(selectedIds) ? selectedIds : [selectedIds]).filter(Boolean).map(String));
  return list.filter((s) => s && typeof s === 'object' && (keep.has(String(s.id)) || vcMatches(s, kws)));
}
/**
 * v3.20.0: 고른 법인이 **2곳 이상**이면 이웃은 그 법인들 안에서 돈다(목록 순서 · 검색어는 그대로 건다 — 카드와 같은 범위).
 *   0 · 1곳이면 지금 규칙(리전 · 검색어 — 한 곳만 고른 것은 범위로 치지 않는다. 그러면 이웃이 없다).
 */
export function siblingSites(sites, scope) {
  const region = String(scope?.region || '');
  const kws = keywordsOf(scope?.q);
  const ids = scopeIdsOf(scope);
  const picked = ids.length > 1 ? new Set(ids) : null;
  return (Array.isArray(sites) ? sites : []).filter((s) => s && typeof s === 'object'
    && (picked ? picked.has(String(s.id)) : (!region || s.location?.region === region)) && vcMatches(s, kws));
}
/** 이전 · 다음 옆에 붙는 범위 글자 — 고른 법인(2곳 이상) · 리전 · 검색어가 있을 때만('리전 유럽 · ‘kr1’' · '법인 3곳'), 없으면 ''. */
export function siblingScopeText(scope) {
  const region = String(scope?.region || '').trim(); const q = String(scope?.q || '').trim();
  const ids = scopeIdsOf(scope);
  const head = ids.length > 1 ? `법인 ${ids.length}곳` : region ? regionText(region) : '';
  return [head, q ? `‘${q}’` : ''].filter(Boolean).join(' · ');
}

export const fmtN = (v) => { const n = numOrNull(v); return n == null ? '—' : n.toLocaleString('en-US'); };

/**
 * 엔티티 탭 3장의 글자 — 서버 요약(totals)에서. 분해는 **그 탭에만 있는 것**(시안 §4.0-2): vCenter 는 연결 · 불가 · REST 폴백 · 엣지 위임 · 알람,
 * VM 은 구동 · 정지 · 미수집 · 템플릿, 호스트는 연결 · 점검 · 끊김 · 미수집 · 클러스터(v3.19.0 순서 — vCenter · VM · 호스트). 배지는 '지금 볼 것'(낡은 값 · 확인 대상 · 조치 필요) — 0 이면 없다.
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
      k: 'vms', ...tabText('vms'), value: fmtN(m?.total),
      badge: pos(m?.attention) ? { text: `조치 필요 ${fmtN(m.attention)}`, tone: 'red' } : null,
      parts: m ? [
        { text: `구동 ${fmtN(m.on)}`, tone: 'green' }, { text: `정지 ${fmtN(m.off)}` }, { text: `사용률 미수집 ${fmtN(m.usageUnknown)}` }, { text: `템플릿 ${fmtN(m.templates)}` },
        ...(pos(m.unknownVcs) ? [{ text: `개수 모름 ${fmtN(m.unknownVcs)}곳`, title: '첫 수집 중 · 비활성 · 연결 실패인 법인 — 0대가 아니라 모르는 것입니다' }] : []),
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
 * v3.13.0(2차 루프 1회차): 공용 범위 바의 vCenter 선택지 — 리전을 골랐으면 **그 리전 vCenter 만**(칩과 같은 판정 chipSites).
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
 * v3.13.6(2차 루프 7회차): 공용 범위 바의 리전 선택지 — 정해진 4리전(regions.js) **더하기 등록 데이터에만 있는 리전**(예: 위치를 비워 등록해 서버가 'Unknown' 으로 둔 vCenter).
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

/** v3.20.0: 칩은 켜고 끄는 단추 — 여러 곳을 함께 고를 수 있다는 안내를 붙인다. */
export function chipLegend(tab) {
  return tab === 'hosts' ? '숫자 = 그 vCenter 의 확인 대상 호스트 · 고른 법인은 파랗게 · 여러 곳을 함께 고를 수 있습니다'
    : tab === 'vms' ? '숫자 = 그 vCenter 의 조치 필요 VM · 고른 법인은 파랗게 · 여러 곳을 함께 고를 수 있습니다'
      : '숫자 = 그 vCenter 의 알람 · 고른 법인은 파랗게 · 여러 곳을 함께 고를 수 있습니다';
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
