/**
 * bmUsageDistText.js — 베어메탈 사용률 설정 '엣지에 배포' 화면 문구(v2.627, 순수 · vitest).
 *
 * 사용자 요청 "한번에 켜는 기능" · 선택 "중앙 설정이 엣지를 따른다": 중앙 관리자가 배포를 켜면 엣지 28곳이 다음 인출(기본
 * 10분 주기)에 중앙 값으로 바뀐다. ⚠ 정직 규칙:
 *  · 저장 즉시 반영된 척하지 않는다 — '다음 인출에 받는다' 와 엣지별 **적용됨 / 대기 / 인출 기록 없음** 을 나눠 말한다.
 *  · '인출 기록 없음' 을 '실패' 로 말하지 않는다 — 중앙 재시작 직후엔 기록이 비어 있고(인메모리), 구버전 엣지는 이 인출을 모른다.
 *  · Enterprise 대체 수집은 배포하지 않는다(v2.554 — 그 엣지 관리자의 동의). 화면이 그 사실을 말한다.
 */
export const DIST_STATE = Object.freeze({
  applied: { label: '적용됨', tone: 'ok', why: '이 엣지가 지금 판을 적용했다고 알려 왔습니다.' },
  pending: { label: '대기', tone: 'warn', why: '이 엣지가 이전 판을 쓰고 있습니다 — 다음 인출에 받습니다.' },
  'no-pull': { label: '인출 기록 없음', tone: 'muted', why: '중앙 재시작 뒤 아직 인출하지 않았거나 2.627 미만 엣지입니다(구버전은 이 배포를 받지 못합니다).' },
  excluded: { label: '제외', tone: 'muted', why: '이 엣지는 자기 로컬 설정을 씁니다.' },
  off: { label: '배포 꺼짐', tone: 'muted', why: '배포가 꺼져 있어 엣지는 로컬 설정을 씁니다.' },
});

export function distStateOf(state) { return DIST_STATE[state] || { label: '확인 불가', tone: 'muted', why: '' }; }

/** 배포 현황 요약 — 겹치지 않는 개수. 합계 = 적용 + 대기 + 기록 없음 + 제외(+ 꺼짐). */
export function distributionCounts(dist) {
  const c = { total: 0, applied: 0, pending: 0, 'no-pull': 0, excluded: 0, off: 0 };
  for (const r of dist?.rows || []) { c.total += 1; if (Object.hasOwn(c, r.state)) c[r.state] += 1; }
  return c;
}

export function distributionSummary(dist) {
  if (!dist) return '';
  const c = distributionCounts(dist);
  if (!dist.enabled) return `**배포 꺼짐** — 엣지 ${c.total}곳은 각자 로컬 설정을 씁니다. 켜면 이 화면의 설정(Enterprise 대체 수집 제외)이 다음 인출 때 모든 엣지에 내려갑니다.`;
  const parts = [`적용됨 ${c.applied}`, `대기 ${c.pending}`, `인출 기록 없음 ${c['no-pull']}`];
  if (c.excluded) parts.push(`제외 ${c.excluded}`);
  return `**배포 켜짐** — 엣지 ${c.total}곳: ${parts.join(' · ')}. 엣지는 **다음 인출**(기본 10분 주기)에 받습니다 — 저장 즉시 바뀌지 않습니다.`;
}

/** 엣지 화면: 이 노드가 중앙 배포값을 쓰고 있을 때 배너. 아니면 ''. */
export function centralManagedNote(central, agoFn) {
  if (!central?.managed) return '';
  const when = central.at && agoFn ? ` · 마지막 확인 ${agoFn(central.at)}` : '';
  return `🔒 **중앙이 이 설정을 배포 중입니다**${when} — 수집 켜기·법인·주기·보존·경로·알림은 중앙 포탈에서 바꿉니다(여기서 바꿔도 저장되지 않습니다). **Enterprise 대체 수집**만 이 엣지에서 정합니다.`;
}

/** 저장 응답이 배포 키를 무시했을 때 한 줄. */
export function ignoredCentralNote(r) {
  const n = Array.isArray(r?.ignoredCentralManaged) ? r.ignoredCentralManaged.length : 0;
  return n ? ` 중앙이 배포하는 항목 ${n}개는 저장하지 않았습니다(중앙 포탈에서 바꿉니다).` : '';
}

export const DIST_ENTERPRISE_NOTE = 'Enterprise 대체 수집은 **배포하지 않습니다** — 장비 부하에 대한 동의는 각 엣지 관리자가 합니다.';
