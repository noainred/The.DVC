/**
 * vcdUsage.js — Platform › vCenter 상세 트리의 **기간 실사용률** 표시용 순수 로직(v2.492).
 *
 * 왜 분리하나: 웹 테스트는 node 환경(DOM 없음)이라 컴포넌트 렌더 테스트가 불가하다. 이 저장소는
 * 판정·문구를 순수 모듈로 빼고 vitest 로 고정하는 관례(vcdSearch.js·accessDeniedText.js)를 쓴다.
 *
 * 데이터 출처(정직 표기): 값은 우리 DB 가 아니라 **vCenter 가 보관하는 성능 롤업**이다. 서버가
 * 화면에 보이는 행만 골라 배치로 빌려온다(POST /vms/usage). 표본이 없으면 null 이고 화면은 '—' 로
 * 그린다 — 0% 로 채우면 '유휴' 로 오해된다.
 */

/** 기간 프리셋(일) — 서버 USAGE_DAYS 와 같아야 한다. 기본 30일(사용자 요청). */
export const USAGE_DAYS = [7, 30, 90, 180, 365];
export const DEFAULT_USAGE_DAYS = 30;
export const normUsageDays = (v) => (USAGE_DAYS.includes(Number(v)) ? Number(v) : DEFAULT_USAGE_DAYS);
export const usageDaysLabel = (d) => (Number(d) === 365 ? '365일' : `${Number(d)}일`);

/** 캐시 키 — 기간별로 따로 담아 기간을 되돌렸을 때 재조회 없이 즉시 보이게 한다. */
export const usageKey = (days, vmId) => `${Number(days)}|${vmId}`;

/**
 * 트리에서 **지금 화면에 그려지는** VM id 목록.
 *
 * 폴더는 기본 접힘이고 펼친 폴더의 VM 만 DOM 에 마운트되므로, 조회도 그만큼만 해야 한다
 * (307 VM 트리를 전부 조회하면 고RTT 에서 분 단위가 된다 — 서버 상한과 같은 이유).
 * open 맵의 키 형식은 트리 코드와 동일하게 `f:${path}/${name}` 이다.
 *
 * 주의: 루트 직속 VM(vm.folder === 'vm')은 현재 트리가 렌더하지 않으므로 여기서도 제외한다
 * (렌더되지 않는 행을 조회하면 상한을 헛되게 쓴다).
 */
export function visibleTreeVmIds(node, open, path = '') {
  const out = [];
  if (!node) return out;
  for (const name of Object.keys(node.folders || {}).sort()) {
    const key = `f:${path}/${name}`;
    if (!open?.[key]) continue;             // 접힌 폴더 = 렌더되지 않음
    const f = node.folders[name];
    out.push(...visibleTreeVmIds(f, open, `${path}/${name}`));
    for (const vm of f.vms || []) out.push(vm.id);
  }
  return out;
}

/** 호스트 탭에서 펼쳐진 호스트에 속한 VM id — open 키는 `h:${host.id}`. */
export function visibleHostVmIds(hosts, vmsByHost, open) {
  const out = [];
  for (const h of hosts || []) {
    if (!open?.[`h:${h.id}`]) continue;
    for (const vm of vmsByHost?.get(h.name) || []) out.push(vm.id);
  }
  return out;
}

/** 아직 값이 없는(캐시 미보유) id 만 골라 서버 상한만큼 자른다. */
export function pendingIds(ids, days, have, cap) {
  const seen = new Set();
  const out = [];
  for (const id of ids || []) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (have && Object.prototype.hasOwnProperty.call(have, usageKey(days, id))) continue;
    out.push(id);
    if (cap && out.length >= cap) break;
  }
  return out;
}

/** 응답(usage 맵)을 기간 키를 붙여 보유 맵에 합친다. 조회했지만 표본이 없으면 null 로 기억한다. */
export function mergeUsage(have, days, usage) {
  const next = { ...(have || {}) };
  for (const [id, u] of Object.entries(usage || {})) next[usageKey(days, id)] = u || null;
  return next;
}

/**
 * 행에 붙일 문구 — 트리 한 줄이라 짧게. 값이 없으면 null 을 돌려 호출측이 아무것도 안 그리게 한다
 * (로딩 중과 '표본 없음' 을 구분하는 것은 호출측 책임).
 */
export function usageText(u, days) {
  if (!u) return null;
  const p = (x) => (x == null ? '—' : `${Math.round(x)}%`);
  return `${usageDaysLabel(days)} 평균 CPU ${p(u.cpuPct)} · MEM ${p(u.memPct)}`;
}

/**
 * 툴팁 — 평균만 보고 판단하지 않도록 최대값·표본 수·실제 덮은 기간을 함께 밝힌다.
 * 요청 기간보다 표본이 짧으면(신규 VM·보관 기간) 그 사실을 먼저 알린다.
 */
export function usageTitle(u, days, { synthesized = false } = {}) {
  if (!u) return `최근 ${usageDaysLabel(days)} 표본이 없습니다 — 전원이 꺼져 있었거나 vCenter 보관 기간 밖입니다.`;
  const parts = [];
  parts.push(`CPU 평균 ${u.cpuPct == null ? '—' : `${u.cpuPct}%`} · 최대 ${u.cpuMax == null ? '—' : `${u.cpuMax}%`}`);
  parts.push(`MEM 평균 ${u.memPct == null ? '—' : `${u.memPct}%`} · 최대 ${u.memMax == null ? '—' : `${u.memMax}%`}`);
  if (u.samples) parts.push(`표본 ${u.samples}개`);
  if (u.coverageDays != null && u.coverageDays + 1 < Number(days)) {
    parts.push(`⚠ 표본이 덮는 기간은 ${u.coverageDays}일 — 요청한 ${usageDaysLabel(days)}보다 짧습니다`);
  }
  parts.push(synthesized ? '데모(mock) 합성값입니다 — 실측이 아닙니다' : '출처: vCenter 성능 롤업(요청 시 조회)');
  return parts.join('\n');
}

/** 사용률 색 임계(트리의 호스트 행과 동일): 초록 <60 · 주황 60~85 · 빨강 ≥85. */
export const usagePctColor = (p) => (p == null ? 'var(--text-faint)' : p >= 85 ? 'var(--red)' : p >= 60 ? 'var(--amber)' : 'var(--green)');
