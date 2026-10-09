import { fmtBytes } from '../../util/fmt.js';
/**
 * SAN 스위치 포트 사용량 화면의 **순수 헬퍼**(v2.420) — 평균/피크 보기 설명·기간 지정 파라미터·
 * 보관 기간 추정. 웹 테스트가 node 환경(DOM 없음)이라 판정·문구는 여기서 회귀로 고정한다.
 */

/** 보기 기준. 값 산출 방식이 다르므로 라벨만이 아니라 설명까지 함께 둔다(사용자 요구 '메뉴에 최대한 자세한 설명'). */
export const MODES = [
  ['avg', '평균 기준', '버킷(구간을 약 120등분한 폭 — 10분 이상이면 15분·1시간 단위로 맞춘다) 안의 포트별 평균(AVG)을 스토리지의 포트끼리 합산한 값입니다. 지속적인 부하(평소 얼마나 쓰는가)를 보는 데 맞습니다. 구간이 길수록 버킷이 넓어져 순간 피크가 평균에 깎입니다.'],
  ['peak', '피크 기준', '버킷 안의 포트별 최댓값(MAX, 원시 표본)을 스토리지의 포트끼리 합산한 값입니다. 포화·증설 판단(가장 바쁠 때 얼마나 쓰는가)에 맞습니다. 포트마다 최댓값이 찍힌 시각이 다를 수 있어 "동시에 발생한 총량"보다 크거나 같은 상한값입니다.'],
];

export const RANGE_MAX_DAYS = 366;

/** 버킷 폭을 사람이 읽는 문자열로. */
export function bucketText(ms) {
  const n = Number(ms) || 0;
  if (n <= 0) return '—';
  if (n < 60_000) return `${Math.round(n / 1000)}초`;
  if (n < 3600_000) return `${Math.round(n / 60_000)}분`;
  if (n < 86400_000) { const h = n / 3600_000; return `${Number.isInteger(h) ? h : h.toFixed(1)}시간`; }
  const d = n / 86400_000; return `${Number.isInteger(d) ? d : d.toFixed(1)}일`;
}

/** 조회 파라미터 — 기간 지정(range={from,to} ms)이 있으면 from/to, 없으면 hours. */
export function perfQuery({ hours = 24, range = null } = {}) {
  if (range && Number.isFinite(range.from) && Number.isFinite(range.to) && range.to > range.from) {
    return { from: String(range.from), to: String(range.to) };
  }
  return { hours: String(hours) };
}

/** `datetime-local` 문자열(현지시각) → epoch ms. 형식이 아니면 null. */
export function parseLocalDt(str) {
  const m = String(str || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] || 0)).getTime();
  return Number.isFinite(t) ? t : null;
}

/** epoch ms → `datetime-local` 값(현지시각, 분 단위). */
export function toLocalDt(ms) {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 기간 지정 입력 검증 — 통과하면 {from,to}, 아니면 {issue}. 서버(rangeParams)와 같은 규칙(최대 366일, from<to). */
export function rangeIssueOf(fromStr, toStr, now = Date.now()) {
  const from = parseLocalDt(fromStr);
  const to = toStr ? parseLocalDt(toStr) : now;
  if (from == null) return { issue: '시작 시각을 입력하세요(예: 2026-09-01 09:00).' };
  if (toStr && to == null) return { issue: '끝 시각 형식이 올바르지 않습니다.' };
  if (from > now) return { issue: '시작 시각이 미래입니다.' };
  if (from >= to) return { issue: '시작 시각이 끝 시각보다 늦거나 같습니다.' };
  if (to - from > RANGE_MAX_DAYS * 86400_000) return { issue: `한 번에 최대 ${RANGE_MAX_DAYS}일까지 조회할 수 있습니다.` };
  return { from, to };
}

/** 기간 표시 문자열. */
export function rangeLabel(range) {
  if (!range) return '';
  const f = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
  return `${f(range.from)} ~ ${f(range.to)}`;
}

/** 보관 기간 프리셋(일). */
export const RETENTION_PRESETS = [[7, '1주'], [30, '1개월'], [90, '3개월'], [180, '6개월'], [365, '1년'], [1095, '3년']];

/** 바이트 → 사람이 읽는 크기 — util/fmt.fmtBytes(v2.613 WEB2613-03: 로컬 사본은 null 을 '0 B' 로 만들었다). */
export const bytesText = fmtBytes;

/**
 * 보관 기간에 따른 DB 크기 **추정**(정직: 추정치임을 문구에 명시). 최근 24시간 적재 행수 × 보관일 × 행당 바이트.
 * 행당 바이트는 현재 파일 크기 ÷ 현재 행수(WAL 포함이라 실제보다 다소 클 수 있다). 표본이 없으면 null.
 */
export function retentionEstimate({ rows = 0, fileBytes = 0, rowsLastDay = 0, retentionDays = 90 } = {}) {
  if (!rows || !fileBytes || !rowsLastDay) return null;
  const bytesPerRow = fileBytes / rows;
  const perDay = rowsLastDay * bytesPerRow;
  return { bytesPerRow, rowsPerDay: rowsLastDay, bytesPerDay: perDay, rowsAtRetention: rowsLastDay * retentionDays, bytesAtRetention: perDay * retentionDays };
}

/**
 * v2.728(SAN 1차): 법인 스토리지 사용량 창 — 연결 대상 종류별 개수. 서버가 고른 종류만 보내므로(응답 크기)
 * '전체' 개수는 받은 시리즈 길이가 아니라 counts 의 합이다. counts 가 없으면(구버전 서버) 받은 시리즈로 센다.
 */
export function kindCountOf(data, kind) {
  if (!data) return null;
  const c = data.counts && typeof data.counts === 'object' ? data.counts : null;
  if (!c) {
    const list = Array.isArray(data.series) ? data.series : [];
    return kind === 'all' ? list.length : list.filter((s) => s?.endpointKind === kind).length;
  }
  if (kind === 'all') return Object.values(c).reduce((a, v) => a + (Number.isFinite(Number(v)) ? Number(v) : 0), 0);
  const n = Number(c[kind]);
  return Number.isFinite(n) ? n : 0;
}

/** 표 한 번에 그리는 행 수 — 법인 합산의 호스트(HBA)는 수천 개라 전부 그리면 창이 몇 초씩 굳는다. */
export const PERF_TABLE_PAGE = 200;

/**
 * 표 상한 — **정렬한 뒤** 자른다(앞 N 을 정렬하면 표가 거짓이 된다 — v2.556·v2.575 규약). 뺀 개수를 함께 돌려준다.
 */
export function limitRows(sorted, limit) {
  const list = Array.isArray(sorted) ? sorted : [];
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0 || list.length <= n) return { rows: list, omitted: 0 };
  return { rows: list.slice(0, n), omitted: list.length - n };
}

/**
 * v2.728: 조회 결과가 언제 계산됐고 얼마나 기억되는지, 어디서 읽었는지(원본 / 집계 표) 한 줄로 말한다.
 * 같은 조건을 다시 열면 서버가 기억한 결과를 준다 — 그 사실을 숨기면 '방금 수집했는데 안 바뀐다' 를 결함으로 읽는다.
 * 계산 시각이 없으면(구버전 서버) null — 지어내지 않는다.
 */
export function perfComputedNote(data, now) {
  const at = data && typeof data.computedAt === 'number' && Number.isFinite(data.computedAt) ? data.computedAt : null;
  if (at == null || !Number.isFinite(now)) return null;
  const sec = Math.max(0, Math.round((now - at) / 1000));
  const ago = sec < 5 ? '방금' : sec < 120 ? `${sec}초 전` : `${Math.round(sec / 60)}분 전`;
  const ttl = Number(data.cacheTtlMs);
  const ttlText = Number.isFinite(ttl) && ttl > 0
    ? ` · 같은 조건은 ${ttl >= 60_000 ? `${Math.round(ttl / 60_000)}분` : `${Math.round(ttl / 1000)}초`} 동안 다시 계산하지 않습니다(새 수집분은 그 뒤에 반영 — '지금 수집' 은 곧바로 반영)`
    : '';
  const src = data.source && typeof data.source === 'object' ? data.source : null;
  const srcText = !src ? ''
    : src.kind === 'rollup'
      ? ` · 미리 합친 집계 표(15분·1시간)와 원본으로 계산${src.headApprox ? '(맨 앞 구간은 원본이 보관 기간으로 지워져 집계 표 한 칸 전체를 썼습니다 — 근사)' : ''}`
      : ' · 원본 표본으로 계산';
  return `${ago} 계산${ttlText}${srcText}`;
}

/**
 * v2.728: 최근 N시간 조회의 버킷 폭 — 서버 perfDb.rangeOf + perfRollup.snapBucketMs 와 같은 규칙(버튼 툴팁 표시용).
 * 구간 ÷ 120(하한 60초) → 10분 미만 그대로 · 45분 이상 또는 31일보다 오래된 구간을 포함하면 1시간 정배수 · 그 밖 15분 정배수.
 * 실제 값은 응답의 bucketMs 가 정답이다(화면 설명은 그 값을 쓴다).
 */
export function perfBucketMsFor(hours) {
  const h = Math.max(1, Number(hours) || 24);
  const raw = Math.max(60_000, Math.round((h * 3600_000) / 120));
  if (raw < 600_000) return raw;
  if (raw >= 2_700_000 || h > 31 * 24) return Math.ceil(raw / 3_600_000) * 3_600_000;
  return Math.ceil(raw / 900_000) * 900_000;
}
