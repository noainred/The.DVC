/**
 * bmIoChartText.js — 장비별 디스크 성능 차트(평균 · 피크 · 실시간 · 트렌드)의 판정 · 문구(순수 · v2.915, 설계 bm-san-compare §4.6 · 보드 ⑥).
 *
 * 숫자(집계 단위 · 점 간격 · 보존 일수)는 전부 API 응답 값으로 문장을 만든다 — 화면에 박지 않는다.
 */
import { numOrNull } from '../../numOrNull.js';

export const RANGES = Object.freeze([
  { k: '1h', label: '실시간 1시간', ms: 3600e3, live: true },
  { k: '24h', label: '24시간', ms: 86400e3, live: false },
  { k: '7d', label: '7일', ms: 7 * 86400e3, live: false },
  { k: '30d', label: '30일', ms: 30 * 86400e3, live: false },
]);
export const METRICS = Object.freeze([
  { k: 'total', label: '읽기+쓰기' }, { k: 'read', label: '읽기' }, { k: 'write', label: '쓰기' },
]);
export const MAX_PICKS = 8;
export const LIVE_REFRESH_MS = 30_000;   // 실시간 1시간 보기의 재조회 간격(가벼운 조회 — 고른 ≤8 계열)

export function rangeOf(k) { return RANGES.find((r) => r.k === k) || RANGES[0]; }

/** 격자 단위 문구 — 15분 · 1시간 · 6시간 집계 / 30초 격자. */
export function bucketLabel(bucketMs) {
  const ms = numOrNull(bucketMs);
  if (ms == null || ms <= 0) return '';
  if (ms >= 3600e3 && ms % 3600e3 === 0) return `${ms / 3600e3}시간 집계`;
  if (ms >= 60e3 && ms % 60e3 === 0) return ms >= 900e3 ? `${ms / 60e3}분 집계` : `${ms / 60e3}분 격자`;
  return `${Math.round(ms / 1000)}초 격자`;
}
/** 점 간격 문구 — '점 1분' · '점 5분'. */
export function sampleText(ms) {
  const v = numOrNull(ms);
  if (v == null || v <= 0) return '';
  if (v >= 3600e3) return `점 ${Math.round(v / 3600e3)}시간`;
  if (v >= 60e3) return `점 ${Math.round(v / 60e3)}분`;
  return `점 ${Math.round(v / 1000)}초`;
}

/** 두 값의 기준 문장(각주) — 계열 basis 코드로. */
export function basisText(kind, basis) {
  if (kind === 'bm') {
    const a = basis?.avg === 'counter' ? '카운터 차분 평균(수집 사이 구간 전체의 평균)' : '표본 평균';
    const p = basis?.peak === 'sample2s' ? '2초 표본 중 최댓값(실제 순간 피크의 하한)' : '표본 최댓값';
    return `베어메탈 — 평균: ${a} · 피크: ${p}`;
  }
  return 'SAN — 평균 · 피크: 스위치 포트 사용량 표본(5분 주기 · 어레이 포트 합)의 평균 · 최댓값 — 어레이가 스스로 보고하는 프런트엔드 표본(SAN 스토리지 성능 화면)이 아니라 스위치 쪽 값입니다';
}

/** 계열 색 — 베어메탈 민트 계열 · SAN 파랑 계열(합계는 첫 색). */
const BM_COLORS = ['#34e0b4', '#5eead4', '#2dd4bf', '#99f6e4', '#14b8a6'];
const SAN_COLORS = ['#3b82f6', '#93c5fd', '#60a5fa', '#bfdbfe', '#2563eb'];
export function seriesColors(series) {
  let b = 0; let s = 0;
  const out = new Map();
  for (const x of series || []) {
    if (x.kind === 'bm') out.set(x.id, BM_COLORS[b++ % BM_COLORS.length]);
    else out.set(x.id, SAN_COLORS[s++ % SAN_COLORS.length]);
  }
  return out;
}

/** recharts 데이터 — 버킷마다 { t, '<id>|avg': v, '<id>|peak': v } (null 은 끊긴 선). */
export function toChartData(buckets, series) {
  const n = Array.isArray(buckets) ? buckets.length : 0;
  const out = [];
  for (let i = 0; i < n; i++) {
    const row = { t: buckets[i] };
    for (const s of series || []) {
      row[`${s.id}|avg`] = Array.isArray(s.avg) ? s.avg[i] ?? null : null;
      row[`${s.id}|peak`] = Array.isArray(s.peak) ? s.peak[i] ?? null : null;
    }
    out.push(row);
  }
  return out;
}

/** y 축 범위 — 로그 눈금이면 [양수 최솟값, 최댓값], 아니면 [0, 최댓값×1.1]. 값이 없으면 [0, 1]. */
export function yDomain(series, { log = false } = {}) {
  let max = null; let minPos = null;
  for (const s of series || []) {
    for (const arr of [s.avg, s.peak]) {
      for (const v of arr || []) {
        if (v == null) continue;
        if (max == null || v > max) max = v;
        if (v > 0 && (minPos == null || v < minPos)) minPos = v;
      }
    }
  }
  if (max == null || max <= 0) return [0, 1];
  if (log) return [Math.max(1, Math.pow(10, Math.floor(Math.log10(minPos || 1)))), Math.pow(10, Math.ceil(Math.log10(max)))];
  return [0, Math.ceil(max * 1.1)];
}

/** x 축 눈금 문구 — 1시간 · 24시간은 'HH:mm', 7일 · 30일은 'M/D HH시'. */
export function timeTick(ts, rangeKey) {
  const d = new Date(Number(ts));
  if (!Number.isFinite(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0'); const mm = String(d.getMinutes()).padStart(2, '0');
  if (rangeKey === '7d' || rangeKey === '30d') return `${d.getMonth() + 1}/${d.getDate()} ${hh}시`;
  return `${hh}:${mm}`;
}
/** 툴팁 머리 — '11/9 16:25'. */
export function tipTime(ts) {
  const d = new Date(Number(ts));
  if (!Number.isFinite(d.getTime())) return '';
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 이 범위가 읽는 보존 일수(API retention) — 1h 원시 · 24h 15분 · 7d/30d 1시간. */
export function retentionDaysFor(rangeKey, retention) {
  if (!retention) return null;
  if (rangeKey === '1h') return numOrNull(retention.rawDays);
  if (rangeKey === '24h') return numOrNull(retention.r15Days);
  return numOrNull(retention.r1hDays);
}
/** ◀ 이전 으로 갈 수 있는 최대 칸 수 — 보존 기간 ÷ 범위 − 1(최근 칸). 모르면 0. */
export function maxBackOf(rangeKey, retention) {
  const days = retentionDaysFor(rangeKey, retention);
  const r = rangeOf(rangeKey);
  if (days == null || !(days > 0)) return 0;
  return Math.max(0, Math.floor((days * 86400e3) / r.ms) - 1);
}
/** 창 끝 시각 — back 칸 전(0 = 최신 · null to). */
export function windowTo(rangeKey, back, now) {
  const b = Math.max(0, Math.floor(Number(back) || 0));
  if (!b) return null;
  return Number(now) - b * rangeOf(rangeKey).ms;
}
export function windowLabel(rangeKey, back) {
  const b = Math.max(0, Math.floor(Number(back) || 0));
  if (!b) return '최근 구간';
  return `${b}칸 전 (${rangeOf(rangeKey).label} 단위)`;
}

/** 기본 선택 — 합계 둘 + 평균이 가장 큰 베어메탈 1 · SAN 1(순위에서). */
export function defaultPicks(rank, { max = 4 } = {}) {
  const picks = ['bm:all', 'san:all'];
  const sorted = [...(rank || [])].filter((r) => numOrNull(r.avgBps) != null).sort((a, b) => b.avgBps - a.avgBps);
  const bm = sorted.find((r) => r.kind === 'bm'); const san = sorted.find((r) => r.kind === 'san');
  if (bm) picks.push(bm.id);
  if (san) picks.push(san.id);
  return picks.slice(0, max);
}

/** 막대 비교 행 — 표 최댓값 대비 비율(평균 · 피크) · 접힘 경계. 평균 높은 순(측정 없음은 뒤). */
export function rankRows(rank, { fold = 12 } = {}) {
  const list = [...(rank || [])].sort((a, b) => (b.avgBps ?? -1) - (a.avgBps ?? -1));
  let max = 0;
  for (const r of list) { if (r.peakBps != null && r.peakBps > max) max = r.peakBps; if (r.avgBps != null && r.avgBps > max) max = r.avgBps; }
  const rows = list.map((r) => ({ ...r, avgPct: max > 0 && r.avgBps != null ? Math.min(100, (r.avgBps / max) * 100) : 0, peakPct: max > 0 && r.peakBps != null ? Math.min(100, (r.peakBps / max) * 100) : null }));
  const measured = rows.filter((r) => r.avgBps != null);
  return { rows, max, shown: rows.slice(0, fold), hidden: Math.max(0, rows.length - fold), measured: measured.length, unmeasured: rows.length - measured.length };
}

/** 표본 수 문구 — '5분 표본 288개' · '1분 표본 1,440개(카운터 평균)'. */
export function pointsText(r, sampleMs) {
  const n = Number(r?.points) || 0;
  if (!n) return '';
  const st = sampleText(sampleMs).replace('점 ', '');
  return `${st ? `${st} ` : ''}표본 ${n.toLocaleString()}개${r?.kind === 'bm' ? '(카운터 평균)' : ''}`;
}

/** 합계 선의 부분 합 각주 — 'N칸은 일부 서버 값이 없어 비웠습니다'. */
export function partialNote(series) {
  const n = Array.isArray(series?.partial) ? series.partial.length : Number(series?.partialBuckets) || 0;
  if (!n) return '';
  return `${n}칸은 일부 ${series?.kind === 'bm' ? '서버' : '어레이'} 값이 없어 합을 비웠습니다(모르는 것을 0 으로 더하지 않음)`;
}
