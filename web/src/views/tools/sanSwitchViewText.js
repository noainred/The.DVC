/**
 * SAN 스위치 화면(시안 'SAN Switch v2', v2.669)의 판정·문구 — 순수 모듈(웹 테스트가 node 환경이라 여기서 고정한다).
 *
 *  · 트래픽 카드: 서버 `/tools/sanswitch/perf/traffic-total` 응답(바이트/초)을 bps 로 바꿔 문장으로 말한다.
 *    ⚠ 값이 없으면 숫자 대신 '—' 다 — 0 Gbps 는 '트래픽 없음' 이라는 거짓이다(모름과 다르다).
 *    ⚠ 수집 주기 숫자를 문구에 박지 않는다 — 서버가 준 intervalMs 로 만든다(설정에서 바뀐다).
 *  · 스위치 목록 정렬 세그먼트(사용률 높은 순·여유 적은 순·이름순): 사용률을 모르는 스위치(수집 실패·
 *    라이선스 0)는 방향과 무관하게 뒤로 보낸다(sortRows 규칙). 맨 앞에 '미수집' 이 몰리면 가장 위험한
 *    스위치처럼 읽힌다.
 */
import { numOrNull } from '../../numOrNull.js';
import { sortRows, capacityLevel } from './sanSwitchPorts.js';

/** 바이트/초 → bps 문자열. 값이 없으면 '—'(단위를 붙이지 않는다). */
export function bpsText(bytesPerSec) {
  const b = numOrNull(bytesPerSec);
  if (b == null) return '—';
  const n = b * 8;
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e11 ? 0 : 1)} Gbps`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} Mbps`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} Kbps`;
  return `${Math.round(n)} bps`;
}

/** 차트 Y축용 Gbps 숫자(바이트/초 → Gbps). */
export function toGbps(bytesPerSec) {
  const b = numOrNull(bytesPerSec);
  return b == null ? null : (b * 8) / 1e9;
}

/** 주기(ms) → '5분' · '90초' · '1시간'. 모르면 ''. */
export function intervalText(ms) {
  const n = numOrNull(ms);
  if (n == null || n <= 0) return '';
  if (n % 3_600_000 === 0) return `${n / 3_600_000}시간`;
  if (n >= 60_000 && n % 60_000 === 0) return `${n / 60_000}분`;
  if (n >= 60_000) return `${Math.round(n / 60_000)}분`;
  return `${Math.round(n / 1000)}초`;
}

/**
 * 배지 '● 5분마다 수집 · 다음 약 3분' — 다음 시각은 마지막 표본 + 주기로 **추정**한다(엣지 스위치는 엣지 주기).
 * 마지막 표본을 모르거나 이미 지났으면 '다음' 조각을 만들지 않는다(지난 시각을 '곧' 이라 말하지 않게).
 */
export function collectBadgeText({ intervalMs, lastSampleAt, enabled }, now = Date.now()) {
  if (enabled === false) return '수집 꺼짐';
  const iv = intervalText(intervalMs);
  if (!iv) return '';
  const last = numOrNull(lastSampleAt);
  const next = last == null ? null : last + Number(intervalMs) - now;
  if (next == null || next <= 0) return `${iv}마다 수집`;
  const min = Math.ceil(next / 60_000);
  return `${iv}마다 수집 · 다음 약 ${min < 1 ? 1 : min}분`;
}

const RANGE_LABEL = { 1: '1시간', 24: '24시간', [24 * 7]: '7일' };
export const TRAFFIC_RANGES = [[1, '1시간'], [24, '24시간'], [24 * 7, '7일']];

/** 하루 환산 전송량(TB) — 평균 바이트/초 × 86,400. 모르면 null. */
export function dayTB(avgBytesPerSec) {
  const a = numOrNull(avgBytesPerSec);
  return a == null ? null : (a * 86_400) / 1e12;
}

const hhmm = (ts) => {
  const d = new Date(Number(ts));
  if (!Number.isFinite(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const whenText = (ts, hours) => {
  const d = new Date(Number(ts));
  if (!Number.isFinite(d.getTime())) return '';
  return hours > 24 ? `${d.getMonth() + 1}/${d.getDate()} ${hhmm(ts)}` : hhmm(ts);
};

/**
 * 트래픽 카드 본문. 반환:
 *   { state:'off'|'unavailable'|'empty'|'ok', lead, now, tail, sub, notes[] }
 *   - lead/now/tail: 큰 문장('… 트래픽은 지금 ' + <민트>now</민트> + '입니다.')
 *   - sub: 평균·최고·하루 환산 한 줄(값이 있을 때만)
 *   - notes: 엣지 미반영·부분 합 같은 짧은 부기(조용히 빼지 않는다)
 */
export function trafficSummary(d, { selected = 0 } = {}) {
  const scope = selected > 0
    ? `선택한 ${selected}개 법인`
    : `전체 ${numOrNull(d?.datacenters) ?? 0}개 법인`;
  const notes = [];
  const edgeMissing = numOrNull(d?.edgeMissing) || 0;
  if (edgeMissing > 0) notes.push(`엣지 수집 스위치 ${edgeMissing}대는 아직 중앙에 표본이 오지 않아 합계에 없습니다.`);
  const partial = numOrNull(d?.partialBuckets) || 0;
  if (partial > 0) notes.push(`일부 스위치 표본이 빠진 구간 ${partial}칸은 부분 합을 그리지 않았습니다.`);
  if (!d) return { state: 'empty', lead: '', now: '—', tail: '', sub: '', notes };
  if (d.enabled === false) {
    return { state: 'off', lead: '', now: '', tail: '',
      sub: `포트 사용량 수집이 꺼져 있습니다 — 설정 › 수집 서버 › SAN 스위치 포트 사용량에서 켜면 ${intervalText(d.intervalMs) || '주기'}마다 합산합니다.`,
      notes: [] };
  }
  if (d.unavailable) {
    return { state: 'unavailable', lead: '', now: '', tail: '', sub: '트래픽 DB 를 열 수 없습니다(수집은 계속됩니다).', notes: [] };
  }
  const lead = `${scope}의 SAN 스토리지 트래픽은 지금 `;
  if (!d.now || numOrNull(d.now.bps) == null) {
    const why = !numOrNull(d.arrays)
      ? '이 범위에서 스토리지 어레이가 물린 포트의 표본을 아직 찾지 못했습니다.'
      : '조회 기간 안에 모든 스위치의 표본이 모인 구간이 없습니다.';
    return { state: 'empty', lead, now: '—', tail: '입니다.', sub: `${why} 값이 없는 것은 트래픽이 0 이라는 뜻이 아닙니다.`, notes };
  }
  const label = RANGE_LABEL[d.hours] || `${d.hours}시간`;
  const parts = [];
  const avg = numOrNull(d.avg);
  if (avg != null && avg > 0) {
    const diff = Math.round(((d.now.bps - avg) / avg) * 100);
    const cmp = diff === 0 ? '와 같고' : diff > 0 ? `보다 ${diff}% 높고` : `보다 ${-diff}% 낮고`;
    parts.push(`${label} 평균 ${bpsText(avg)}${cmp}`);
  }
  if (d.peak && numOrNull(d.peak.bps) != null) parts.push(`최고치는 ${whenText(d.peak.ts, d.hours)}의 ${bpsText(d.peak.bps)}였습니다`);
  let sub = parts.length ? `${parts.join(', ')}.` : '';
  const tb = dayTB(avg);
  if (tb != null) sub += `${sub ? ' ' : ''}하루로 환산하면 약 ${tb >= 10 ? tb.toFixed(0) : tb.toFixed(1)} TB 가 오갑니다.`;
  return { state: 'ok', lead, now: bpsText(d.now.bps), tail: '입니다.', sub, notes };
}

/** 차트 행 — null 버킷은 null 그대로(선을 끊는다). */
export function trafficChartRows(d) {
  const b = Array.isArray(d?.buckets) ? d.buckets : [];
  const t = Array.isArray(d?.total) ? d.total : [];
  return b.map((ts, i) => ({ ts, gbps: toGbps(t[i]) }));
}

/** 법인별 비중 상위 N — 합 대비 퍼센트(합이 0 이면 null). */
export function dcShare(d, top = 5) {
  const list = Array.isArray(d?.byDatacenter) ? d.byDatacenter.filter((x) => numOrNull(x?.bps) != null) : [];
  const sum = list.reduce((a, x) => a + x.bps, 0);
  const rows = list.slice(0, top).map((x) => ({ ...x, pct: sum > 0 ? Math.round((x.bps / sum) * 100) : null }));
  return { rows, omitted: Math.max(0, list.length - top) };
}

/* ── 스위치 목록 ──────────────────────────────────────────────────────── */

export const LIST_SORTS = [
  { key: 'usage', label: '사용률 높은 순' },
  { key: 'free', label: '여유 적은 순' },
  { key: 'name', label: '이름순' },
];

const usedPctOf = (r) => (r?.snap?.ok ? numOrNull(r.snap.ports?.usedPct) : null);
const freeOf = (r) => (r?.snap?.ok && numOrNull(r.snap.ports?.licensed) ? numOrNull(r.snap.ports?.free) : null);

/** 정렬 세그먼트 — 값을 모르는 스위치는 방향과 무관하게 뒤로. 동점은 이름. */
export function sortSwitches(rows = [], key = 'usage') {
  const tie = (r) => String(r?.name || '');
  if (key === 'name') return sortRows(rows, (r) => String(r?.name || '') || null, 'asc', tie);
  if (key === 'free') return sortRows(rows, freeOf, 'asc', tie);
  return sortRows(rows, usedPctOf, 'desc', tie);
}

/** 여유 부족(75%↑) 스위치 수 — capacityLevel 과 같은 경계. */
export function hotCount(rows = []) {
  return rows.filter((r) => { const l = capacityLevel(usedPctOf(r)); return l === 'warn' || l === 'bad'; }).length;
}

/** 행 왼쪽 표지 색(75% 이상 amber, 90% 이상 red, 그 밖 없음). */
export function rowMark(r) {
  const l = capacityLevel(usedPctOf(r));
  return l === 'bad' ? 'var(--red)' : l === 'warn' ? 'var(--amber)' : null;
}

/**
 * 머리 상태 줄 — '● 12대 수집 정상 · 실패 1대 · 5개 법인 · 마지막 수집 2분 전'. 0대면 등록 안내.
 * 실패가 있으면 점 색을 바꾼다(전부 정상이 아닌데 초록 점을 두지 않는다).
 */
export function headStatus(rows = [], dcCount = 0) {
  const n = rows.length;
  if (!n) return { tone: 'muted', text: '등록된 SAN 스위치가 없습니다' };
  const ok = rows.filter((r) => r?.snap?.ok).length;
  const failed = n - ok;
  const parts = [`${ok}대 수집 정상`];
  if (failed) parts.push(`실패·미수집 ${failed}대`);
  parts.push(`${dcCount}개 법인`);
  return { tone: failed ? (ok ? 'warn' : 'bad') : 'ok', text: parts.join(' · ') };
}

/** 가장 최근 수집 시각(ms) — 모르면 null. */
export function lastCollectedAt(rows = []) {
  let m = null;
  for (const r of rows) { const t = numOrNull(r?.snap?.collectedAt); if (t != null && (m == null || t > m)) m = t; }
  return m;
}
