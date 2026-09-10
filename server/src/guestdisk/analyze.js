/**
 * guestdisk/analyze.js — 게스트 디스크 회수 리포트 판정(순수 모듈, v2.459).
 *
 * 사용자 요구: "VM 별 게스트 파티션 할당량/사용량, 비율, 파티션별 사용량 증가 추이를 DB 에 저장해
 * 추이를 검색해서 줄일 수 있는 용량과 VM 을 정리해서 보여주고 CSV export".
 *
 * 정의(화면 문구도 이 정의를 그대로 쓴다):
 *  · 할당(alloc)   : 게스트가 인식한 파티션 capacity 합(GB). VMware Tools 가 보고한 파일시스템 크기.
 *  · 사용(used)    : 파티션 used(=capacity−free) 합(GB).
 *  · 여유(free)    : 할당−사용. **게스트 안에서 비어 있는 공간** = 디스크를 줄이면 회수 가능한 상한.
 *  · 비율(ratio)   : 사용/할당 × 100. 할당 0 이면 null(추정하지 않는다).
 *
 * 정직 원칙:
 *  - free 는 '게스트 관점의 회수 가능 상한'이다. 실제 스토리지 회수는 디스크 축소(shrink)+UNMAP 이
 *    필요하며, 파티션 정렬·OS 지원에 따라 전량을 회수하지 못할 수 있다 — 화면/문서에 명시한다.
 *  - 추이는 관측 시작 이후만. 표본이 정책 하한(점 수)을 못 넘으면 증가율을 계산하지 않고 null.
 */

/** 파티션 배열 → VM 요약. parts: [{path, capacityGB, usedGB}] */
export function vmSummary(parts) {
  const list = Array.isArray(parts) ? parts : [];
  let alloc = 0; let used = 0;
  for (const p of list) {
    alloc += Number(p.capacityGB) || 0;
    used += Number(p.usedGB) || 0;
  }
  alloc = round1(alloc); used = round1(used);
  const free = round1(Math.max(0, alloc - used));
  const ratioPct = alloc > 0 ? Math.round((used / alloc) * 1000) / 10 : null;
  return { allocGB: alloc, usedGB: used, freeGB: free, ratioPct, partCount: list.length };
}

/**
 * 회수 순위 — vm_latest 행 배열에서 여유(free)가 큰 VM 을 정렬한다.
 * rows: [{ vcenterId, vcenterName?, vmId, vmName, allocGB, usedGB, partCount }]
 * opts: { minReclaimGB=5 } — 이보다 작은 여유는 제외(잡음 컷).
 * 반환: { rows(정렬·회수량 포함), totalReclaimGB, vmCount }
 */
export function rankReclaim(rows, { minReclaimGB = 5 } = {}) {
  const out = [];
  for (const r of (rows || [])) {
    const alloc = Number(r.allocGB) || 0;
    const used = Number(r.usedGB) || 0;
    const free = round1(Math.max(0, alloc - used));
    const ratioPct = alloc > 0 ? Math.round((used / alloc) * 1000) / 10 : null;
    if (free < minReclaimGB) continue;
    out.push({ ...r, allocGB: round1(alloc), usedGB: round1(used), freeGB: free, ratioPct });
  }
  out.sort((a, b) => b.freeGB - a.freeGB);
  const totalReclaimGB = round1(out.reduce((s, r) => s + r.freeGB, 0));
  return { rows: out, totalReclaimGB, vmCount: out.length };
}

/**
 * 파티션(또는 VM) 사용량 추이 판정 — 시간순 점 배열에서 증가율과 라벨을 만든다.
 * points: [{ ts, usedGB, capGB? }] (오름차순 ts). diff-저장이라 점 사이 간격이 불규칙하다.
 * opts: { minPoints=2, flatPerDayGB=0.1 } — 하루 증가량이 ±flat 안이면 '평탄'.
 * 반환: { trend: 'growing'|'flat'|'shrinking'|null, growthGBPerDay|null, spanDays|null,
 *         firstUsedGB, lastUsedGB, points }
 * 정직: 점이 minPoints 미만이거나 기간이 0 이면 증가율 null·trend null(근거 부족).
 */
export function usageTrend(points, { minPoints = 2, flatPerDayGB = 0.1 } = {}) {
  const pts = (points || []).filter((p) => p && Number.isFinite(Number(p.usedGB)))
    .map((p) => ({ ts: Number(p.ts), usedGB: round1(Number(p.usedGB)), capGB: p.capGB == null ? null : round1(Number(p.capGB)) }))
    .sort((a, b) => a.ts - b.ts);
  const first = pts[0]; const last = pts[pts.length - 1];
  const base = {
    points: pts,
    firstUsedGB: first ? first.usedGB : null,
    lastUsedGB: last ? last.usedGB : null,
  };
  if (pts.length < minPoints) return { ...base, trend: null, growthGBPerDay: null, spanDays: null };
  const spanMs = last.ts - first.ts;
  const spanDays = spanMs > 0 ? Math.round((spanMs / 86_400_000) * 100) / 100 : 0;
  if (!(spanDays > 0)) return { ...base, trend: null, growthGBPerDay: null, spanDays: 0 };
  const growthGBPerDay = round2((last.usedGB - first.usedGB) / spanDays);
  let trend = 'flat';
  if (growthGBPerDay > flatPerDayGB) trend = 'growing';
  else if (growthGBPerDay < -flatPerDayGB) trend = 'shrinking';
  return { ...base, trend, growthGBPerDay, spanDays };
}

/**
 * 회수 안전도 — 여유가 크고(회수 이득) 사용량이 늘지 않으면(안전) 축소 후보.
 * trend 가 'growing' 이면 여유가 커도 곧 찰 수 있어 보류를 권한다.
 */
export function reclaimAdvice(freeGB, trend, { minReclaimGB = 5 } = {}) {
  if (!(freeGB >= minReclaimGB)) return { safe: false, label: '해당 없음' };
  if (trend === 'growing') return { safe: false, label: '보류(사용량 증가 추세)' };
  if (trend === 'shrinking') return { safe: true, label: '축소 권장(사용량 감소)' };
  if (trend === 'flat') return { safe: true, label: '축소 후보(사용량 평탄)' };
  return { safe: false, label: '근거 부족(추이 표본 부족)' };
}

function round1(n) { return Math.round((Number(n) || 0) * 10) / 10; }
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
