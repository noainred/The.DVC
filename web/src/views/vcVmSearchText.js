/**
 * vcVmSearchText.js — Platform(vCenter 목록) 검색창의 '전체 vCenter VM 이름 조회' 판정·문구(v2.671, 순수 — vitest).
 *
 * 사용자 요청: "이 화면의 검색에서 전체 vcenter 를 검색해서 vm 이름으로 조회할 수 있는 기능".
 * 같은 입력으로 ① vCenter 카드를 거르고(기존) ② 서버 `/vms?nameOnly=1&q=` 로 VM 이름을 찾는다.
 *   · 한 글자는 조회하지 않는다 — 5,850대 중 대부분이 걸려 표가 의미 없고 응답만 크다.
 *   · 범위(scope)는 서버가 먼저 강제한다(applyFilters) — 화면은 받은 것만 그린다.
 *   · 상한으로 자른 것은 개수를 밝힌다(조용한 상한 금지).
 */
export const VM_SEARCH_MIN = 2;
export const VM_SEARCH_LIMIT = 50;

/** 조회할 검색어 — 앞뒤 공백을 떼고 최소 길이를 넘을 때만. 아니면 ''. */
export function vmSearchTerm(query) {
  const q = String(query ?? '').trim();
  return q.length >= VM_SEARCH_MIN ? q : '';
}

/** vCenter id → 표시 이름. 모르면 id. */
export function vcNameOf(sites, id) {
  const s = (Array.isArray(sites) ? sites : []).find((x) => x && x.id === id);
  return s?.name || id || '';
}

/** 결과 요약 — `VM 이름에 "web" 이 들어간 VM 128대 · 앞 50대 표시 · 7개 vCenter`. */
export function vmSearchSummary(term, data) {
  if (!term) return '';
  if (!data) return `VM 이름에서 "${term}" 을 찾는 중…`;
  const total = Number(data.total) || 0;
  const items = Array.isArray(data.items) ? data.items : [];
  if (!total) return `VM 이름에 "${term}" 이 들어간 VM 이 없습니다(전체 vCenter).`;
  const vcs = new Set(items.map((v) => v.vcenterId)).size;
  const cut = total > items.length ? ` · 앞 ${items.length}대만 표시 — 검색어를 더 구체적으로 입력하세요` : '';
  return `VM 이름에 "${term}" 이 들어간 VM ${total.toLocaleString()}대${cut} · 표시 중 ${vcs}개 vCenter`;
}

const POWER = { POWERED_ON: 'On', POWERED_OFF: 'Off', SUSPENDED: '일시중지' };
export const powerLabel = (s) => POWER[s] || s || '—';

/** 메모리 MB → 'N GB'. 모르면 '—'. */
export function memText(mb) {
  const n = Number(mb);
  if (mb == null || mb === '' || !Number.isFinite(n)) return '—';
  return `${Math.round((n / 1024) * 10) / 10} GB`;
}
