/**
 * compareSetText.js — ‘비교 세트’ 화면의 판정 · 문구(순수 · v2.962 — 사용자 요청 2026-11-10 "SAN A / SAN B · 가 법인의 SAN A / 가 법인의 베어메탈 AA …
 * 다양하게 각각의 스토리지의 성능을 비교").
 *
 * 서버(GET /tools/bm-storage/compare-set)가 대상마다 지표 넷(평균 · 피크 배열 + 요약)과 출처 · 사유 **코드**를 준다. 이 모듈은 문장 · 형식 · 비율 · 후보 목록만 만든다.
 * 규칙: 못 읽은 값은 '—'(단위 없이) · 사유는 문장으로 · 숫자(격자 · 주기)는 응답 값으로 · 백틱 금지(BoldText) · 값 인용은 ‘ ’.
 */
import { numOrNull } from '../../numOrNull.js';
import { fmtBps, kindTag, reasonText as sanReasonText, bytesText, pctText } from './bmSanCompareText.js';

export const MAX_TARGETS = 4;
export const SLOT_LABELS = Object.freeze(['A', 'B', 'C', 'D']);
/** 슬롯 색 — 종류가 섞이므로 종류가 아니라 슬롯(A~D)에 색을 준다. 어두운 바탕에서 서로 밝기가 다르게. */
export const SLOT_COLORS = Object.freeze(['#3b82f6', '#34e0b4', '#f472b6', '#a78bfa']);

export const SET_RANGES = Object.freeze([
  { k: '1h', label: '실시간 1시간', live: true }, { k: '24h', label: '24시간', live: false },
  { k: '7d', label: '7일', live: false }, { k: '30d', label: '30일', live: false },
]);

/** IOPS — 1,000 이상은 정수에 천 단위 쉼표, 그 아래는 소수 한 자리. */
export function fmtIops(v) {
  const n = numOrNull(v);
  if (n == null) return '—';
  return n >= 1000 ? `${Math.round(n).toLocaleString()} IOPS` : `${(Math.round(n * 10) / 10).toLocaleString()} IOPS`;
}
/** 응답 시간 — 1 ms 미만은 소수 둘째 자리, 그 위는 한 자리. */
export function fmtMs(v) {
  const n = numOrNull(v);
  if (n == null) return '—';
  return n < 1 ? `${n.toFixed(2)} ms` : `${(Math.round(n * 10) / 10).toFixed(1)} ms`;
}
export function fmtPct(v) {
  const n = numOrNull(v);
  return n == null ? '—' : `${(Math.round(n * 10) / 10).toFixed(1)}%`;
}

/** 차트 세로축 눈금용 짧은 IOPS — ‘48,709 IOPS’ 는 축 폭(70px)에서 두 줄로 접혔다(v2.962 화면 확인). 단위는 차트 제목에 있다. */
export function axisIops(v) {
  const n = numOrNull(v);
  if (n == null) return '';
  const a = Math.abs(n);
  const t = (x) => String(Math.round(x * 10) / 10);
  return a >= 1e6 ? `${t(n / 1e6)}M` : a >= 1e3 ? `${t(n / 1e3)}k` : t(n);
}
export const METRICS = Object.freeze([
  { k: 'tput', label: '전송 속도', fmt: fmtBps, axis: 'B/s', tick: fmtBps },
  { k: 'iops', label: 'IOPS', fmt: fmtIops, axis: 'IOPS', tick: axisIops },
  { k: 'lat', label: '응답 시간', fmt: fmtMs, axis: 'ms', tick: fmtMs },
  { k: 'busy', label: '바쁨', fmt: fmtPct, axis: '%', tick: fmtPct },
]);
export const metricOf = (k) => METRICS.find((m) => m.k === k) || METRICS[0];

/** 대상 종류 라벨 — SAN 은 장비 종류(VMAX · PowerMax …). */
export function kindLabel(kind, type = '') {
  if (kind === 'bm') return '베어메탈 서버';
  if (kind === 'bmg') return '베어메탈 그룹';
  if (kind === 'bmc') return '법인 베어메탈 합계';
  if (kind === 'san') return kindTag(type || 'san').label;
  return kind || '—';
}
/** 종류 배지 색(.badge 톤). */
export function kindBadge(kind, type = '') {
  if (kind === 'san') return kindTag(type || 'san').cls;
  return 'teal';
}

/** 출처 코드 → 짧은 문장(셀 아래 · 각주). */
const SOURCES = {
  diskstats: '서버 /proc/diskstats(평균 = 디스크별 카운터 차분 · 피크 = 2초 표본과 구간 평균 중 큰 값)',
  'diskstats-busy': '가장 바쁜 디스크의 사용률(iostat %util 과 같은 뜻)',
  'switch-port': 'SAN 스위치 포트 트래픽(어레이 포트 합 · 5분 표본)',
  'array-fe-hbps': '어레이가 보고한 호스트 처리량(스위치 포트에서 이 어레이를 찾지 못해 대신 씀)',
  'array-fe': '어레이가 보고한 5분 표본(FA 디렉터 · 노드 · SP)',
  'array-fe-busy': '가장 바쁜 FA 디렉터 busy %',
  'array-fe-cpu': '가장 바쁜 노드 · SP CPU %',
};
export function sourceText(code) { return SOURCES[String(code || '')] || ''; }

/** 사유 코드 → 문장(비교 세트 전용 코드 먼저 · 나머지는 SAN 비교 탭과 같은 문장). */
const REASONS = {
  'no-io-data': '이 구간에 디스크 I/O 표본이 없습니다.',
  'no-iops-data': 'IOPS · 응답 시간 표본이 없습니다 — v2.962 이전 표본이거나 엣지가 구버전입니다(처리량은 별개).',
  'unknown-target': '등록부에서 이 대상을 찾지 못했습니다(지워졌거나 이름이 바뀌었습니다).',
  'fe-no-device': '등록 스토리지와 시리얼이 일치하지 않아 어레이 측 값이 없습니다.',
  'fe-type': '이 장비 종류는 어레이 측 성능 경로가 없습니다.',
  'fe-ssh': 'SSH 로 수집하는 장비는 어레이 측 성능 경로가 없습니다(REST 로 바꾸면 5분 표본이 쌓입니다).',
  'fe-disabled': '이 장비의 5분 표본(디렉터 성능)이 꺼져 있습니다.',
  'fe-no-sample': '이 구간에 어레이 측 5분 표본이 없습니다.',
  'fe-no-units': '아직 어레이 측 표본이 없습니다(첫 5분 표본 뒤에 채워집니다).',
  'db-unavailable': 'I/O 시계열 DB 를 열 수 없습니다.',
  'no-data': '이 구간에 값이 없습니다.',
};
export function reasonText(code) {
  if (!code) return '';
  return REASONS[String(code)] || sanReasonText(code);
}

/** 기준(A) 대비 배율 — '×1.80' · 기준이 0 · 없음이면 ''. */
export function ratioText(value, base) {
  const v = numOrNull(value); const b = numOrNull(base);
  if (v == null || b == null || b === 0) return '';
  const r = v / b;
  return `×${r >= 10 ? Math.round(r) : r.toFixed(2)}`;
}
/** 사용률 차이(%p) — '+4.6%p' · '−8.7%p'. */
export function ppText(value, base) {
  const v = numOrNull(value); const b = numOrNull(base);
  if (v == null || b == null) return '';
  const d = Math.round((v - b) * 10) / 10;
  if (Math.abs(d) < 0.05) return '±0%p';
  return d > 0 ? `+${d.toFixed(1)}%p` : `−${Math.abs(d).toFixed(1)}%p`;
}

/** 주소 해시의 대상 목록 — '#/tools/bm-storage/set/<encode(ids)>'. 모르는 모양이면 []. */
export function idsFromHash(hash) {
  const segs = String(hash || '').replace(/^#\/?/, '').split('/');
  if (segs[0] !== 'tools' || segs[1] !== 'bm-storage' || segs[2] !== 'set' || !segs[3]) return [];
  let raw = '';
  try { raw = decodeURIComponent(segs.slice(3).join('/')); } catch { return []; }
  return normalizeIds(raw.split(','));
}
export function hashForIds(ids) {
  const list = normalizeIds(ids);
  return `#/tools/bm-storage/set${list.length ? `/${encodeURIComponent(list.join(','))}` : ''}`;
}
/** 아는 종류만 · 중복 제거 · 상한 4(서버 parseSetIds 와 같은 규칙). */
export function normalizeIds(list) {
  const out = []; const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const t = String(raw || '').trim();
    if (!/^(bm|bmg|bmc|san):.{1,128}$/.test(t) || seen.has(t)) continue;
    seen.add(t); out.push(t);
    if (out.length >= MAX_TARGETS) break;
  }
  return out;
}

const NO_GROUP = '(그룹 없음)';
/**
 * 후보 목록 — /tools/bm-storage/compare?types=all 응답에서. 종류별 [{ id, name, sub, dcId, dcName, disabled?, why? }].
 * SAN 은 시리얼이 있어야 고를 수 있다(스냅샷이 없으면 막고 사유).
 */
export function candidatesFrom(d) {
  const servers = (d?.bm?.servers || []).filter((s) => s && s.enabled !== false);
  const san = (d?.san?.arrays || []).map((a) => ({
    id: a.serial ? `san:${a.serial}` : `san-none:${a.id}`, kind: 'san', type: a.type, name: a.name, dcId: a.datacenterId || '',
    dcName: a.datacenterName || '(법인 미지정)', sub: `${kindTag(a.type).label} · ${a.datacenterName || '(법인 미지정)'}`,
    disabled: !a.serial, why: a.serial ? '' : '수집된 스냅샷이 없어 시리얼을 모릅니다',
  }));
  const bm = servers.map((s) => ({ id: `bm:${s.id}`, kind: 'bm', name: s.name, dcId: s.datacenterId || '', dcName: s.datacenterName || '(법인 미지정)',
    sub: `${s.datacenterName || '(법인 미지정)'}${(s.groups || []).length ? ` · ${(s.groups || []).join(', ')}` : ''}` }));
  const groupDc = new Map();
  for (const s of servers) for (const g of s.groups || []) { if (!groupDc.has(g)) groupDc.set(g, new Set()); groupDc.get(g).add(s.datacenterId || ''); }
  const bmg = (d?.bm?.groups || []).filter((g) => g && g.name && g.name !== NO_GROUP).map((g) => {
    const dcs = groupDc.get(g.name) || new Set();
    return { id: `bmg:${g.name}`, kind: 'bmg', name: g.name, dcId: dcs.size === 1 ? [...dcs][0] : null, dcName: '', sub: `서버 ${g.servers}대` };
  });
  const bmc = (d?.datacenters || []).filter((c) => (Number(c.servers) || 0) > 0).map((c) => ({
    id: `bmc:${c.id}`, kind: 'bmc', name: c.name, dcId: c.id === '__none__' ? '' : c.id, dcName: c.name, sub: `베어메탈 ${c.servers}대 합계`,
  }));
  return { san, bm, bmg, bmc };
}
export const CANDIDATE_KINDS = Object.freeze([
  { k: 'san', label: 'SAN 어레이' }, { k: 'bm', label: '베어메탈 서버' }, { k: 'bmg', label: '베어메탈 그룹' }, { k: 'bmc', label: '법인 베어메탈 합계' },
]);

/** 빠른 세트 — 후보로 만들 수 있는 것만(없으면 비활성). */
export function presetsFrom(c) {
  const san = (c?.san || []).filter((x) => !x.disabled);
  const out = [];
  out.push({ k: 'san2', label: 'SAN ↔ SAN', ids: san.slice(0, 2).map((x) => x.id), ok: san.length >= 2 });
  // 같은 법인에 어레이와 베어메탈이 다 있는 첫 법인: 그 법인 어레이 ↔ 그 법인 베어메탈 합계
  const corp = (c?.bmc || []).find((b) => san.some((a) => a.dcId === b.dcId));
  const corpSan = corp ? san.find((a) => a.dcId === corp.dcId) : null;
  out.push({ k: 'corp', label: corp ? `${corp.name}: SAN ↔ 베어메탈` : '같은 법인 SAN ↔ 베어메탈', ids: corp && corpSan ? [corpSan.id, corp.id] : [], ok: !!(corp && corpSan) });
  const g = (c?.bmg || []).slice(0, 2);
  out.push({ k: 'groups', label: '베어메탈 그룹 ↔ 그룹', ids: g.map((x) => x.id), ok: g.length >= 2 });
  return out;
}

/** 이름표 — 후보에서 찾고 없으면 응답의 이름 · 아니면 키. */
export function labelFor(id, cands, targets) {
  for (const list of Object.values(cands || {})) { const x = (list || []).find((y) => y.id === id); if (x) return x.name; }
  const t = (targets || []).find((y) => y.id === id);
  return t?.name || String(id).replace(/^[a-z]+:/, '');
}

/**
 * 비교 표 행 — 용량 사용률 · 용량 · 지표 넷(평균 · 피크). 셀: { v, text, delta(기준 대비 — 첫 대상에는 없음), reason }.
 */
export function matrixRows(targets) {
  const list = Array.isArray(targets) ? targets : [];
  const base = list[0] || null;
  const rows = [];
  rows.push({ key: 'cap-pct', label: '용량 사용률', cells: list.map((t, i) => {
    const v = numOrNull(t.capacity?.pct);
    return { v, text: v == null ? '—' : pctText(v), delta: i && base ? ppText(v, base.capacity?.pct) : '', reason: v == null ? (t.missing ? t.reason : 'no-capacity') : null };
  }) });
  rows.push({ key: 'cap-used', label: '사용 / 전체', cells: list.map((t) => {
    const u = numOrNull(t.capacity?.usedBytes); const tot = numOrNull(t.capacity?.totalBytes);
    return { v: u, text: u == null && tot == null ? '—' : `${bytesText(u)} / ${bytesText(tot)}`, delta: '', reason: null };
  }) });
  for (const m of METRICS) {
    for (const which of ['avg', 'peak']) {
      rows.push({
        key: `${m.k}-${which}`, metric: m.k, which, label: `${m.label} ${which === 'avg' ? '평균' : '피크'}`,
        cells: list.map((t, i) => {
          const mm = t.metrics?.[m.k];
          const v = numOrNull(which === 'avg' ? mm?.avgTotal : mm?.peakTotal);
          const bv = base ? numOrNull(which === 'avg' ? base.metrics?.[m.k]?.avgTotal : base.metrics?.[m.k]?.peakTotal) : null;
          return { v, text: m.fmt(v), delta: i ? ratioText(v, bv) : '', reason: v == null ? (mm?.reason || 'no-data') : null, source: mm?.source || null };
        }),
      });
    }
  }
  return rows;
}

/** 차트 데이터 — 버킷마다 { t, '<슬롯>|avg', '<슬롯>|peak' } (null 은 끊긴 선). */
export function chartRows(buckets, targets, metricKey, { log = false } = {}) {
  const out = [];
  // 로그 축에는 0 이하를 그릴 수 없다 — 그 점은 빈칸(null)으로 둔다(0 으로 바꾸거나 지어내지 않는다).
  const pick = (v) => (v == null ? null : log && !(v > 0) ? null : v);
  for (let i = 0; i < (buckets || []).length; i++) {
    const row = { t: buckets[i] };
    (targets || []).forEach((t, j) => {
      const m = t.metrics?.[metricKey];
      row[`${SLOT_LABELS[j]}|avg`] = pick(m?.avg?.[i] ?? null);
      row[`${SLOT_LABELS[j]}|peak`] = pick(m?.peak?.[i] ?? null);
    });
    out.push(row);
  }
  return out;
}

/** 대상끼리 평균 차이가 이만큼(배) 넘으면 ‘로그 축’ 을 권한다(SAN 수만 IOPS ↔ 서버 수백 IOPS 처럼 작은 쪽이 바닥에 붙을 때). */
export const LOG_HINT_RATIO = 20;
export function wideSpread(targets, metricKey) {
  const v = (targets || []).map((t) => t?.metrics?.[metricKey]?.avgTotal).filter((x) => x != null && x > 0);
  return v.length >= 2 && Math.max(...v) / Math.min(...v) >= LOG_HINT_RATIO;
}

/** 칸 수가 적으면 점을 그린다 — 선이 끊긴 외딴 값도 보이게(값이 칸마다 없을 수 있다). */
export function showDots(buckets) { return (buckets || []).length <= 48; }

/** 격자 문구 — '10분 격자' · '1시간 격자'(응답 bucketMs). */
export function gridText(bucketMs) {
  const ms = numOrNull(bucketMs);
  if (ms == null || ms <= 0) return '';
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}시간 격자`;
  if (ms % 60_000 === 0) return `${ms / 60_000}분 격자`;
  return `${Math.round(ms / 1000)}초 격자`;
}
