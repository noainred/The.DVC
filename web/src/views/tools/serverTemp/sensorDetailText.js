/**
 * 서버 온도 › 센서 상세(v2.659) — 판정·문구(순수 모듈, vitest).
 *
 * 서버(`/tools/esxi-temp/sensors`)가 상태(ok/warn/crit/unknown/absent)·역할(흡기·배기·CPU·GPU·DIMM·PSU)을 판정해 준다.
 * 이 모듈은 **읽기만** 한다 — 상태를 다시 판정하면 화면과 서버 KPI 가 갈라진다.
 *
 * 지킬 것:
 *  · 값이 없으면 단위를 붙이지 않는다('— ℃' 는 0℃ 처럼 읽힌다 — unitText 규약).
 *  · '판정 불가'(unknown)와 '빈 슬롯'(absent)을 정상으로 칠하지 않는다(회색).
 *  · GPU 온도는 **사용률이 아니다** — 동작 여부의 근거일 뿐이다(v2.650 규약). 문구가 그렇게 말한다.
 *  · 백틱·별표 없이 쓴다(BoldText 는 굵게만 해석하고 백틱은 글자로 샌다 — v2.576 스윕).
 */
import { numOrNull } from '../../../numOrNull.js';
import { unitText } from '../../unitText.js';

export const STATE_TEXT = { ok: '정상', warn: '경고', crit: '위험', unknown: '판정 불가', absent: '빈 슬롯' };
export const STATE_BADGE = { ok: 'green', warn: 'amber', crit: 'red', unknown: 'gray', absent: 'gray' };
export const STATE_ORDER = { crit: 0, warn: 1, unknown: 2, ok: 3, absent: 4 };
export const KIND_TEXT = { temperature: '온도', fan: '팬', voltage: '전압', current: '전류', power: '전력', percent: '사용률(%)', energy: '에너지', other: '기타' };
export const KIND_ORDER = ['temperature', 'fan', 'voltage', 'current', 'power', 'percent', 'energy', 'other'];
export const ROLE_TEXT = { inlet: '흡기(전산실)', exhaust: '배기', cpu: 'CPU', gpu: 'GPU', dimm: '메모리', psu: '전원공급장치', other: '' };
export const CPU_SRC_TEXT = { bmusage: '베어메탈 사용률', telemetry: 'iDRAC 텔레메트리', sensor: 'iDRAC 센서' };

/** Redfish 단위 → 화면 단위. 모르는 단위는 원문 그대로. */
export function unitLabel(u) {
  const t = String(u || '').trim();
  if (!t) return '';
  if (/^cel$/i.test(t) || t === 'C') return '℃';
  if (/^rpm$/i.test(t)) return 'RPM';
  if (t === '%') return '%';
  return t;
}

const fmt = (v) => {
  const n = numOrNull(v);
  if (n == null) return null;
  return Math.abs(n) >= 1000 ? Math.round(n).toLocaleString() : String(Math.round(n * 10) / 10);
};

const withUnit = (f, unit) => {
  const u = unitLabel(unit);
  return unitText(f, u ? (u === '℃' || u === '%' ? u : ` ${u}`) : '', { dash: '—' });
};
/** 센서 값 + 단위(값이 없으면 단위 없는 '—'). */
export function readingText(s) { return withUnit(fmt(s?.reading), s?.unit); }
/** 임계값 한 칸 — 장비가 주지 않으면 '—'(iDRAC 화면의 N/A 와 같은 뜻). */
export function thresholdText(v, unit) { return withUnit(fmt(v), unit); }
export const tempText = (v) => { const f = fmt(v); return f == null ? '—' : `${f}℃`; };
export const pctText = (v) => { const f = fmt(v); return f == null ? '—' : `${f}%`; };

/** CPU 사용률 칸 — 값 + 출처. 없을 때 이유가 둘로 갈린다(수집 꺼짐 / 값 없음). */
export function cpuCell(cpu) {
  if (!cpu || typeof cpu !== 'object') return { text: '—', sub: '', title: '' };
  const src = CPU_SRC_TEXT[cpu.src] || '';
  if (cpu.pct == null) {
    if (cpu.state === 'off') return { text: '—', sub: '수집 꺼짐', title: '베어메탈 사용률 수집이 꺼져 있고 iDRAC 텔레메트리·센서에도 CPU 사용률이 없습니다. 특수 기능 › 베어메탈 사용률에서 켜면 채워집니다.' };
    return { text: '—', sub: '', title: 'CPU 사용률을 읽지 못했습니다(베어메탈 사용률·iDRAC 텔레메트리·센서 모두 값 없음).' };
  }
  const stale = cpu.state === 'stale';
  return {
    text: pctText(cpu.pct), sub: stale ? '오래됨' : src, stale,
    title: `${src || '출처 미상'}${cpu.via ? ` · ${cpu.via}` : ''}${stale ? ' · 오래된 값입니다(지금 부하가 아닐 수 있습니다)' : ''}`,
  };
}

/** 상세 상태 칸 — 수집 전/오래됨은 정상이 아니다. */
export function detailStateText(row) {
  if (row?.detailState === 'none') return { text: '수집 전', badge: 'gray', title: '센서 상세가 없습니다 — 첫 수집 전이거나, 엣지가 2.659 이전이거나, Redfish 가 응답하지 않았습니다.' };
  if (row?.detailState === 'stale') return { text: '오래됨', badge: 'gray', title: '마지막 센서 수집이 신선도 경계를 넘었습니다 — 요약(전산실 온도·경고 수)에서 뺐습니다.' };
  const w = row?.summary?.worst;
  const c = row?.summary?.counts || {};
  if (w === 'crit') return { text: `위험 ${c.crit}`, badge: 'red', title: `위험 ${c.crit} · 경고 ${c.warn || 0}` };
  if (w === 'warn') return { text: `경고 ${c.warn}`, badge: 'amber', title: `경고 ${c.warn}` };
  if (w === 'ok') return { text: '정상', badge: 'green', title: c.unknown ? `판정 불가 ${c.unknown}개는 정상으로 세지 않았습니다` : '' };
  return { text: '판정 불가', badge: 'gray', title: '장비가 상태·임계값을 주지 않아 판정하지 않았습니다.' };
}

/** 목록 필터 — 검색어(서버·서비스태그·법인·모델, 대소문자 무시)와 칩. */
export const FILTERS = [['all', '전체'], ['alert', '경고·위험'], ['gpu', 'GPU 서버'], ['nocpu', 'CPU 사용률 없음'], ['nodetail', '상세 없음·오래됨']];
export function filterRows(rows = [], { filter = 'all', q = '' } = {}) {
  const term = String(q || '').trim().toLowerCase().slice(0, 200);
  return (rows || []).filter((r) => {
    if (!r) return false;
    if (filter === 'alert' && !(r.detailState === 'ok' && (r.summary?.counts?.warn || r.summary?.counts?.crit))) return false;
    if (filter === 'gpu' && !(r.summary?.gpuTempCount > 0)) return false;
    if (filter === 'nocpu' && r.cpu?.pct != null) return false;
    if (filter === 'nodetail' && r.detailState === 'ok') return false;
    if (!term) return true;
    return [r.name, r.serviceTag, r.dcLabel, r.model].some((v) => String(v || '').toLowerCase().includes(term));
  });
}
export function filterCounts(rows = []) {
  const out = {};
  for (const [k] of FILTERS) out[k] = filterRows(rows, { filter: k }).length;
  return out;
}

/** 상세 모달 — 종류별 묶음(정해진 순서), 묶음 안은 나쁜 상태 먼저 → 이름. */
export function groupSensors(list = []) {
  const by = new Map();
  for (const s of list || []) {
    if (!s || typeof s !== 'object') continue;
    const k = KIND_ORDER.includes(s.kind) ? s.kind : 'other';
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(s);
  }
  return KIND_ORDER.filter((k) => by.has(k)).map((k) => ({
    kind: k, label: KIND_TEXT[k],
    rows: by.get(k).slice().sort((a, b) => (STATE_ORDER[a.state] ?? 9) - (STATE_ORDER[b.state] ?? 9) || String(a.name).localeCompare(String(b.name), 'en', { numeric: true })),
  }));
}

/** 상세의 수집 경로 설명(Sensors 컬렉션 메타). 조용히 줄인 것이 없게 개수를 밝힌다. */
export function collectionNote(d) {
  const parts = [];
  const c = d?.collection;
  if (!c) parts.push('Sensors 컬렉션을 아직 읽지 않았습니다(인벤토리 주기에 읽습니다) — 지금 보이는 것은 Thermal(온도·팬)뿐입니다.');
  else {
    if (c.ok === false) parts.push(`Sensors 컬렉션을 읽지 못했습니다${c.error ? `: ${c.error}` : ''} — 직전에 읽은 목록을 보여줍니다.`);
    if (numOrNull(c.notRead) > 0) parts.push(`읽지 못한 센서 ${c.notRead}개가 있습니다(시간 예산·상한·오류).`);
    if (numOrNull(c.absent) > 0 && !numOrNull(c.count)) parts.push('이 장비는 Sensors 컬렉션을 제공하지 않습니다(구펌웨어·다른 벤더) — Thermal 값만 있습니다.');
  }
  if (numOrNull(d?.omitted) > 0) parts.push(`표시 상한을 넘어 ${d.omitted}개를 생략했습니다.`);
  return parts;
}

export const ROLE_NOTE = '역할(흡기·CPU·GPU 등)은 센서 이름과 위치 정보로 추정한 것입니다. 전산실 온도는 흡기 센서의 최고값을 씁니다(전원공급장치 흡기는 빼고).';
export const GPU_NOTE = 'GPU 온도는 사용률이 아닙니다 — GPU 가 동작 중인지 가늠하는 근거로만 보여줍니다(정상 범위가 모델·냉각마다 달라 임계로 판정하지 않습니다).';
export const CPU_NOTE = 'CPU 사용률은 베어메탈 사용률 수집값을 먼저 쓰고, 없으면 iDRAC 텔레메트리·센서 값을 씁니다(출처를 칸에 적습니다).';

/**
 * v2.680 D-06: 표 정렬 값 — 칸이 보여 주는 것과 같은 값이어야 한다. 상세가 없거나 오래된 행(detailState !== 'ok')은
 * 칸이 '—' 이므로 정렬 값도 null(DataTable 이 방향과 무관하게 뒤로 보낸다). -999·-1 같은 대체값을 쓰면 '—' 행이
 * 오름차순 맨 앞에 온다(v2.631 규약). GPU 온도는 GPU 온도 센서가 있을 때만 칸에 값이 있다.
 */
export function detailSortValue(row, field) {
  if (!row || row.detailState !== 'ok') return null;
  if (field === 'gpuTempMaxC' && !numOrNull(row.summary?.gpuTempCount)) return null;
  return numOrNull(row.summary?.[field]);
}
/** CPU 사용률 정렬 값 — 칸이 값을 보여 줄 때(오래된 값 포함, 흐리게 표시)만. 없으면 null. */
export function cpuSortValue(row) { return numOrNull(row?.cpu?.pct); }
