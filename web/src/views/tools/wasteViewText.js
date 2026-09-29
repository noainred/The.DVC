/**
 * Optimization(낭비 자원) 화면 시안 A(v2.651) — 계산은 여기 하나가 소유한다(순수 · vitest 고정).
 * 서버 응답(`/tools/waste` · `/tools/waste/off-since`)을 **다시 판정하지 않고** 묶어서 보여줄 값만 만든다.
 */
import { numOrNull } from '../../numOrNull.js';

/**
 * 회수 가능 스토리지(추정) = 꺼진 VM 이 점유한 스토리지 + Thin 미사용(uncommitted) 여유.
 * 둘은 겹치지 않는다 — 앞은 VM 이 이미 쓴 양(committed), 뒤는 thin 디스크가 아직 쓰지 않은 양(uncommitted)이다.
 * 둘 다 모르면 null(0 을 지어내지 않는다).
 */
export function reclaimStorage(data) {
  const off = numOrNull(data?.poweredOff?.storageGB);
  const thin = numOrNull(data?.thinReclaim?.reclaimableGB);
  if (off == null && thin == null) return null;
  const total = (off || 0) + (thin || 0);
  return {
    totalGB: total, offGB: off, thinGB: thin,
    offPct: total > 0 && off != null ? Math.round((off / total) * 100) : null,
    thinVms: numOrNull(data?.thinReclaim?.count),
    partial: off == null || thin == null,
  };
}

/** 꺼진 기간 칸 — 30일 이상 / 7~30일 / 7일 미만 / 모름. 경계: 7일·30일은 긴 쪽에 넣는다. */
export const AGE_BUCKETS = Object.freeze([
  { k: 'ge30', label: '30일 이상' },
  { k: 'd7', label: '7~30일' },
  { k: 'lt7', label: '7일 미만' },
  { k: 'unknown', label: '시점 모름' },
]);
export function ageBucketOf(days) {
  const d = numOrNull(days);
  if (d == null || d < 0) return 'unknown';
  if (d >= 30) return 'ge30';
  if (d >= 7) return 'd7';
  return 'lt7';
}

/**
 * 꺼진 기간 분포 — off-since 행(꺼진 VM 전량)으로 센다. `total`(꺼진 VM 수)보다 행이 적으면 모자란 만큼 '모름'.
 * off-since 를 아직 못 받았으면 null(분포를 지어내지 않는다).
 */
export function ageCounts(offRows, total) {
  if (!Array.isArray(offRows)) return null;
  const out = { ge30: 0, d7: 0, lt7: 0, unknown: 0 };
  for (const r of offRows) out[ageBucketOf(r?.offDays)] += 1;
  const t = numOrNull(total);
  if (t != null && t > offRows.length) out.unknown += t - offRows.length;
  return out;
}

/**
 * 법인(vCenter)별 꺼진 VM 점유 — byVcenter(절단 전 전체 기준) 상위 n + 나머지 합.
 * 점유 0 인 법인은 빼고, 뺀 법인 수와 나머지 GB 를 밝힌다.
 */
export function corpOffShare(byVcenter, n = 7) {
  const rows = (Array.isArray(byVcenter) ? byVcenter : [])
    .map((e) => ({ vcenterId: e?.vcenterId, gb: numOrNull(e?.poweredOffGB) || 0, count: numOrNull(e?.poweredOff) || 0 }))
    .filter((e) => e.vcenterId && e.gb > 0)
    .sort((a, b) => b.gb - a.gb);
  const top = rows.slice(0, n);
  const rest = rows.slice(n);
  const max = top.length ? top[0].gb : 0;
  return {
    top: top.map((e) => ({ ...e, pct: max > 0 ? Math.max(2, Math.round((e.gb / max) * 100)) : 0 })),
    restCount: rest.length,
    restGB: rest.reduce((a, e) => a + e.gb, 0),
  };
}

/** GB → '283.6 TB' / '512 GB'. null 이면 '—'(단위를 붙이지 않는다). */
export function sizeText(gb) {
  const g = numOrNull(gb);
  if (g == null) return '—';
  return g >= 1024 ? `${(g / 1024).toFixed(1)} TB` : `${Math.round(g)} GB`;
}

/** 꺼진 지 근거 짧은 표기. */
export const OFF_SRC_SHORT = Object.freeze({ event: '이벤트', observed: '점검', track: '추적', first_seen: '관측 시작' });
