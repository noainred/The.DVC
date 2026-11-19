/**
 * tools/vmTrackText.js — VM 수량 추이의 **순증감 · 생성 · 삭제 요약 한 벌**(v3.10.20 · 가상화 플랫폼 점검 8회차).
 *  - 허브 KPI 카드(VCenters TrendKpis)와 VM 수량 추이 도구가 따로 세던 같은 계산을 모았다(판정 코어 하나). v3.19.0 에 KPI 카드를 걷어내 지금 쓰는 곳은 도구(VmTrackTool) 하나다.
 *  - 순증감(마지막 total − 처음 total)과 생성 − 삭제는 **같지 않을 수 있다** — 기준선 슬롯(첫 스냅샷 · DB 재설정 뒤)과 vCenter 를 건너뛴 슬롯에서는
 *    생성 · 삭제를 세지 않는다. 그 차이(`unaccounted`)를 숨기지 않고 '미집계 ±N' 으로 보인다('못 읽은 값은 0 이 아니다' — 전에는 '+61 · 생성 +0 · 삭제 −0' 처럼 보였다).
 *  - 점이 없으면 net 은 null(화면은 '—').
 */
const n0 = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** @returns {{net:number|null, added:number, removed:number, unaccounted:number|null, baselines:number, skippedSlots:number}} */
export function vmNetSummary(points) {
  const pts = Array.isArray(points) ? points.filter((p) => p && Number.isFinite(Number(p.total))) : [];
  const first = pts[0] || null; const last = pts[pts.length - 1] || null;
  const net = first && last ? Number(last.total) - Number(first.total) : null;
  const added = pts.reduce((a, p) => a + n0(p.added), 0);
  const removed = pts.reduce((a, p) => a + n0(p.removed), 0);
  const baselines = pts.filter((p) => p.baseline).length;
  const skippedSlots = pts.filter((p) => n0(p.skipped) > 0).length;
  const unaccounted = net == null ? null : net - (added - removed);
  return { net, added, removed, unaccounted, baselines, skippedSlots };
}

export const signed = (v) => (v > 0 ? `+${Number(v).toLocaleString()}` : Number(v).toLocaleString());

/** 카드 아래 줄 — '생성 +A · 삭제 −R' + 차이가 있으면 ' · 미집계 ±U'. */
export function vmNetMetaText(s) {
  if (!s || s.net == null) return '';
  const base = `생성 +${s.added.toLocaleString()} · 삭제 −${s.removed.toLocaleString()}`;
  return s.unaccounted ? `${base} · 미집계 ${signed(s.unaccounted)}` : base;
}

/** 미집계가 있을 때의 설명(title) — 왜 순증감과 생성 − 삭제가 다른가. 없으면 빈 글자. */
export function vmNetUnaccountedTitle(s) {
  if (!s || !s.unaccounted) return '';
  const why = [];
  if (s.baselines) why.push(`기준선 슬롯 ${s.baselines}개(첫 스냅샷 — 증감은 다음 슬롯부터)`);
  if (s.skippedSlots) why.push(`vCenter 를 건너뛴 슬롯 ${s.skippedSlots}개`);
  return `순증감 ${signed(s.net)} 과 생성 − 삭제(${signed(s.added - s.removed)})의 차이 ${signed(s.unaccounted)} 는 생성 · 삭제로 세지 못한 변화입니다${why.length ? ` — ${why.join(' · ')}` : ' — 기준선 · 건너뛴 슬롯 · 기간 밖 기준'}.`;
}
