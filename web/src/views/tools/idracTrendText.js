/**
 * idracTrendText.js — 특수 기능 › iDRAC 통합 추이(v2.660)의 순수 판정(vitest 로 고정).
 * 서버 `routes/admin/idracTrend.js` 와 표(기간·집계 단위)를 맞춘다. 판정은 서버가 하고 여기서는 **읽기만** 한다.
 *
 * 지킬 것:
 *  · 결측은 null 이다 — 요약·차트·CSV 어디서도 0 으로 채우지 않는다(0 은 '유휴·급냉' 이라는 거짓).
 *  · 계열마다 보관 기간이 다르다(전력 DB 기본 90일) — retentionNote 가 그 사실을 말한다.
 *  · 문구에 백틱·별표를 쓰지 않는다(BoldText 규약 — uiText.test.js 스윕).
 */
export const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
export const PRESETS = [['1h', '1시간', HOUR], ['6h', '6시간', 6 * HOUR], ['24h', '24시간', DAY], ['7d', '7일', 7 * DAY], ['30d', '30일', 30 * DAY], ['90d', '90일', 90 * DAY], ['1y', '1년', 365 * DAY]];
export const BUCKET_LABELS = [[MIN, '1분'], [5 * MIN, '5분'], [30 * MIN, '30분'], [2 * HOUR, '2시간'], [6 * HOUR, '6시간'], [DAY, '1일']];
export const bucketLabel = (ms) => (BUCKET_LABELS.find(([m]) => m === ms) || [0, `${Math.round(ms / MIN)}분`])[1];

export const SERIES = [
  { k: 'cpuPct', label: 'CPU 사용률', unit: '%', color: '#3b82f6', axis: 'pct' },
  { k: 'cpuTemp', label: 'CPU 온도', unit: '℃', color: '#ef4444', axis: 'pct' },
  { k: 'gpuTemp', label: 'GPU 온도', unit: '℃', color: '#a855f7', axis: 'pct' },
  { k: 'powerW', label: '소비 전력', unit: ' W', color: '#f59e0b', axis: 'w' },
];

const p2 = (n) => String(n).padStart(2, '0');
export const ymd = (t) => { const d = new Date(t); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };
export const hm = (t) => { const d = new Date(t); return `${p2(d.getHours())}:${p2(d.getMinutes())}`; };

/** 축 눈금 — 1일 이하 HH:mm · 14일 이하 MM-DD HH:mm · 그 이상 YYYY-MM-DD. */
export function fmtTick(t, span) {
  if (span <= DAY) return hm(t);
  if (span <= 14 * DAY) return `${ymd(t).slice(5)} ${hm(t)}`;
  return ymd(t);
}
/** 조회 기간 문구 — 시작·종료 날짜가 다르면 날짜를 붙인다(24시간이 '12:40 ~ 12:40' 으로 보이지 않게). */
export function periodText(start, end) {
  const multi = ymd(start) !== ymd(end);
  return `${multi ? `${ymd(start)} ` : ''}${hm(start)} ~ ${multi ? `${ymd(end)} ` : ''}${hm(end)}`;
}

/** 요약(결측 제외). 값이 하나도 없으면 null — 화면은 '—' 를 쓴다. */
export function statsOf(points, k) {
  const v = (points || []).map((p) => p?.[k]).filter((x) => typeof x === 'number' && Number.isFinite(x));
  if (!v.length) return null;
  const r = (x) => Math.round(x * 10) / 10;
  return { cur: v[v.length - 1], avg: r(v.reduce((a, b) => a + b, 0) / v.length), max: Math.max(...v) };
}

/** 값 + 단위(값이 없으면 단위 없는 '—'). */
export const valueText = (v, unit) => (v == null || !Number.isFinite(Number(v)) ? '—' : `${Number(v).toLocaleString()}${unit}`);

/**
 * 네 계열이 모두 빈 연속 구간 → [{x1,x2}]. 단 **수집 시작(firstTs) 이전**은 무응답이 아니라 '수집 전' 이라 빼고,
 * 전 구간이 비어 있으면 무응답으로 칠하지 않는다(그건 '데이터 없음' 이고 화면이 따로 말한다).
 */
export function gapAreas(points, firstTs = null) {
  const pts = (points || []).filter((p) => !(Number.isFinite(firstTs) && p.t < firstTs));
  if (!pts.some((p) => SERIES.some((s) => p[s.k] != null))) return [];
  const out = []; let a = null;
  for (const p of pts) {
    const empty = SERIES.every((s) => p[s.k] == null);
    if (empty && a == null) a = p.t;
    if (!empty && a != null) { out.push({ x1: a, x2: p.t }); a = null; }
  }
  if (a != null) out.push({ x1: a, x2: pts[pts.length - 1].t });
  return out;
}

/** 기간 지정 검증 — 서버 parseWindow 와 같은 규칙. 오류 문구 | null. */
export function customRangeError(startMs, endMs, { now = Date.now(), retentionDays = 365 } = {}) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return '시작·종료 일시를 모두 입력하세요.';
  if (startMs >= endMs) return '종료 일시가 시작 일시보다 뒤여야 합니다.';
  if (endMs - startMs < HOUR) return '기간은 최소 1시간입니다.';
  if (startMs < now - retentionDays * DAY - MIN) return `보관 기간(${retentionDays}일)을 넘었습니다 — ${ymd(now - retentionDays * DAY)} 이후만 조회할 수 있습니다.`;
  if (endMs > now + MIN) return '종료 일시가 현재 이후입니다.';
  return null;
}

export const toLocalInput = (t) => `${ymd(t)}T${hm(t)}`;
/** 전력 축 상한 — 최대의 1.15배를 200W 단위로 올림. 값이 없으면 1000. */
export const pMaxOf = (points) => { const m = statsOf(points, 'powerW')?.max; return m ? Math.ceil((m * 1.15) / 200) * 200 : 1000; };

/** 법인 → 데이터센터 → 서버 목록(서버 응답 기준). 정렬은 사람 이름 순(숫자 인식). */
const COLL = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });
export function corpsOf(servers) {
  const m = new Map();
  for (const s of servers || []) m.set(s.corp, s.corpName || s.corp || '(법인 미지정)');
  return [...m.entries()].map(([value, label]) => ({ value, label })).sort((a, b) => (a.value === '') - (b.value === '') || COLL.compare(a.label, b.label));
}
export function sitesOf(servers, corp) {
  const m = new Map();
  for (const s of servers || []) if (s.corp === corp) m.set(s.site, (m.get(s.site) || 0) + 1);
  const tail = (x) => (x.startsWith('(') ? 1 : 0);
  return [...m.entries()].map(([value, n]) => ({ value, n })).sort((a, b) => tail(a.value) - tail(b.value) || COLL.compare(a.value, b.value));
}
export function serversOf(servers, corp, site) {
  return (servers || []).filter((s) => s.corp === corp && s.site === site).sort((a, b) => COLL.compare(a.name || a.id, b.name || b.id));
}
export const serverLabel = (s) => `${s.name || s.id} · ${s.kind === 'esxi' ? 'ESXi' : '베어메탈'}`;

/** 보관·빈 상태 안내(각주). 서버가 준 값만 쓴다(숫자를 박지 않는다). */
export function retentionNote(data) {
  const r = data?.retention || {};
  const parts = [`CPU 사용률·온도는 ${r.metricsDays ?? data?.retentionDays ?? 365}일 보관합니다.`];
  if (Number(r.powerDays) > 0 && Number(r.powerDays) < (r.metricsDays ?? 365)) parts.push(`소비 전력은 전력 DB 보관 기간(${r.powerDays}일)만 있습니다 — 그보다 긴 기간은 앞부분이 비어 보입니다.`);
  return parts.join(' ');
}
export function emptyNote(data) {
  if (!data) return '';
  if (data.enabled === false) return 'iDRAC 통합 추이 적재가 꺼져 있습니다(IDRAC_TREND_SERIES=false) — 소비 전력만 보일 수 있습니다.';
  const any = (data.points || []).some((p) => SERIES.some((s) => p[s.k] != null));
  if (any) return '';
  if (data.firstTs && data.firstTs > data.end) return '이 기간 이후부터 수집되었습니다 — 더 최근 기간을 고르세요.';
  return '이 기간에 수집된 값이 없습니다 — 적재는 v2.660 설치 이후부터 쌓이며 소급하지 않습니다. iDRAC 이 응답하지 않았을 수도 있습니다.';
}
export const DC_SOURCE_TEXT = {
  'scan-agent': '법인은 iDRAC 스캔 대역의 에이전트가 속한 데이터센터로 분류했습니다',
  'scan-range': '법인은 이 서버 IP 를 포함한 iDRAC 스캔 대역의 법인으로 분류했습니다',
  'scan-ambiguous': '여러 법인의 스캔 대역이 겹쳐 법인을 정하지 않았습니다',
};

/** 서버 형태 판별 근거 — 서비스태그가 없으면 판별할 수 없어 베어메탈로 보인다는 사실을 말한다. */
export function kindBasisText(d) {
  if (!d) return '';
  if (!d.serviceTag) return '서비스태그 없음 — ESXi 호스트와 대조할 수 없어 베어메탈로 표시합니다';
  return d.kind === 'esxi' ? `서비스태그 ${d.serviceTag} → ESXi 호스트 일치` : `서비스태그 ${d.serviceTag} — 일치하는 ESXi 호스트 없음`;
}
