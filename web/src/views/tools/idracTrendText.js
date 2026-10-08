/**
 * idracTrendText.js — 특수 기능 › iDRAC 통합 추이(v2.660)의 순수 판정(vitest 로 고정).
 * 서버 `routes/admin/idracTrend.js` 와 표(기간·집계 단위)를 맞춘다. 판정은 서버가 하고 여기서는 **읽기만** 한다.
 *
 * 지킬 것:
 *  · 결측은 null 이다 — 요약·차트·CSV 어디서도 0 으로 채우지 않는다(0 은 '유휴·급냉' 이라는 거짓).
 *  · 계열마다 보관 기간이 다르다(전력 DB 기본 90일) — retentionNote 가 그 사실을 말한다.
 *  · 문구에 백틱·별표를 쓰지 않는다(BoldText 규약 — uiText.test.js 스윕).
 */
import { csvCell } from '../../util/csv.js';
import { agoText } from './relTime.js';

export const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
export const PRESETS = [['1h', '1시간', HOUR], ['6h', '6시간', 6 * HOUR], ['24h', '24시간', DAY], ['7d', '7일', 7 * DAY], ['30d', '30일', 30 * DAY], ['90d', '90일', 90 * DAY], ['1y', '1년', 365 * DAY]];
export const BUCKET_LABELS = [[MIN, '1분'], [5 * MIN, '5분'], [30 * MIN, '30분'], [2 * HOUR, '2시간'], [6 * HOUR, '6시간'], [DAY, '1일']];
export const bucketLabel = (ms) => (BUCKET_LABELS.find(([m]) => m === ms) || [0, `${Math.round(ms / MIN)}분`])[1];

export const SERIES = [
  { k: 'cpuPct', label: 'CPU 사용률', unit: '%', color: '#3b82f6', axis: 'pct' },
  { k: 'cpuTemp', label: 'CPU 온도', unit: '℃', color: '#ef4444', axis: 'pct' },
  { k: 'gpuTemp', label: 'GPU 온도', unit: '℃', color: '#a855f7', axis: 'pct' },
  { k: 'inletTemp', label: '흡기 온도', unit: '℃', color: '#06b6d4', axis: 'pct', dash: 'dash' },   // v2.661 · v2.662 기본 점선
  { k: 'exhaustTemp', label: '배기 온도', unit: '℃', color: '#ec4899', axis: 'pct', dash: 'dash' }, // v2.661 · v2.662 기본 점선
  { k: 'powerW', label: '소비 전력', unit: ' W', color: '#f59e0b', axis: 'w' },
];
/*
 * v2.666 — 가상화 서버의 **ESXi 호스트 CPU 사용률(vCenter 값)** 을 비교용 계열로 함께 그린다(사용자 요청 "가상화 서버의 경우
 * hostname 이나 service tag 로 매칭되는 장비가 있으면 cpu 사용량을 불러와서 같이 보여주는 기능"). ⚠ 이것은 iDRAC 값이 아니다 —
 * v2.665 규칙(iDRAC CPU 에 vCenter 값을 섞지 않는다)은 그대로이고 **다른 선·다른 이름**으로만 보인다. 그래서 SERIES(iDRAC 6계열 —
 * 서버 표·조건 검색·무응답 구간 판정이 쓴다)에 넣지 않고 차트·카드·선 모양·내보내기 목록(CHART_SERIES)에만 넣는다.
 */
export const HOST_CPU_SERIES = { k: 'hostCpuPct', label: 'ESXi CPU (vCenter)', unit: '%', color: '#22c55e', axis: 'pct', dash: 'dot', vc: true };
/*
 * v2.668 — 매칭된 ESXi 호스트의 **GPU 사용률·GPU 메모리 점유**(특수 기능 GPU 모니터링이 호스트 id 로 적재하는 값 — 사용자 요청
 * "이 화면에서 수집한 GPU 사용량 붙여서 호스트 별로 사용량을 같이"). ESXi CPU 와 같은 이유로 SERIES 에 넣지 않는다(iDRAC 값이 아니다).
 * GPU 온도는 iDRAC 계열(gpuTemp)이 이미 있으므로 싣지 않는다. 호스트에 GPU 가 없다고 확인되면 카드·선을 숨긴다(gpu: true).
 */
export const HOST_GPU_SERIES = [
  { k: 'hostGpuPct', label: 'ESXi GPU 사용률', unit: '%', color: '#84cc16', axis: 'pct', dash: 'dot', vc: true, gpu: true },
  { k: 'hostGpuMemPct', label: 'ESXi GPU 메모리', unit: '%', color: '#14b8a6', axis: 'pct', dash: 'dot', vc: true, gpu: true },
];
export const CHART_SERIES = [...SERIES, HOST_CPU_SERIES, ...HOST_GPU_SERIES];

/** 이 응답에서 보일 계열(순수). ESXi 계열은 매칭된 가상화 서버에만, GPU 계열은 호스트에 GPU 가 없다고 확인되면 숨긴다(모르면 보인다). */
export function shownSeriesOf(data) {
  return CHART_SERIES.filter((s) => {
    if (!s.vc) return true;
    if (!data?.hostCpu) return false;
    if (s.gpu) return data?.hostGpu?.hasGpu !== false;
    return true;
  });
}

/** GPU 카드 빈 칸 문구 — 왜 비었는지(순수). */
export function hostGpuEmptyText(data) {
  const g = data?.hostGpu;
  if (g?.hasGpu === false) return 'GPU 없음';
  return 'GPU 값 없음 — GPU 모니터링 수집 확인';
}

/** GPU 계열 각주(순수). 출처를 밝힌다 — iDRAC 값이 아니다. */
export function hostGpuNote(data) {
  const g = data?.hostGpu;
  if (!g || g.hasGpu === false) return '';
  const firsts = Object.values(g.firstTs || {}).filter((x) => Number.isFinite(x));
  const first = firsts.length ? ` 첫 적재는 ${ymd(Math.min(...firsts))} ${hm(Math.min(...firsts))} 입니다.` : ' 아직 적재된 값이 없습니다 — 특수 기능 › GPU 모니터링의 수집 상태를 확인하세요.';
  return `연두·청록 점선(ESXi GPU 사용률·GPU 메모리)은 같은 호스트 ${g.hostName || g.hostId} 의 GPU 모니터링 값(ESXi 보고 또는 게스트 nvidia-smi)이고 iDRAC 값이 아닙니다.${first}`;
}

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
  const ok = (points || []).filter((p) => typeof p?.[k] === 'number' && Number.isFinite(p[k]));
  if (!ok.length) return null;
  const v = ok.map((p) => p[k]);
  const r = (x) => Math.round(x * 10) / 10;
  // v2.682(R3D-06): cur 은 창 안 '마지막 값' 이다 — 그 시각(curT)을 함께 돌려 화면이 현재값처럼 보이지 않게 한다.
  const lt = Number(ok[ok.length - 1]?.t);
  return { cur: v[v.length - 1], curT: Number.isFinite(lt) && lt > 0 ? lt : null, avg: r(v.reduce((a, b) => a + b, 0) / v.length), max: Math.max(...v) };
}

/**
 * v2.682(R3D-06): 카드 큰 숫자가 창 끝에서 2버킷 이상 떨어진 '마지막 값' 이면 그 사실을 말한다(아니면 '').
 * 계열 하나만 멈춘 경우(다른 계열은 정상)는 수집 멈춤 배너가 잡지 못한다. 시각을 모르면 단정하지 않는다('').
 */
export function staleCurText(stat, end, bucketMs, now = Date.now()) {
  const t = Number(stat?.curT); const e = Number(end); const b = Number(bucketMs);
  if (!stat || !Number.isFinite(t) || t <= 0 || !Number.isFinite(e) || !Number.isFinite(b) || b <= 0) return '';
  if (e - t < 2 * b) return '';
  return `마지막 값(${agoText(t, now)})`;
}

/** 값 + 단위(값이 없으면 단위 없는 '—'). */
export const valueText = (v, unit) => (v == null || !Number.isFinite(Number(v)) ? '—' : `${Number(v).toLocaleString()}${unit}`);

/**
 * 네 계열이 모두 빈 연속 구간 → [{x1,x2}]. 단 **수집 시작(firstTs) 이전**은 무응답이 아니라 '수집 전' 이라 빼고,
 * 전 구간이 비어 있으면 무응답으로 칠하지 않는다(그건 '데이터 없음' 이고 화면이 따로 말한다).
 */
/**
 * v2.727: 무응답 구간 글자는 구간이 충분히 넓을 때만 — 좁은 구간 가운데에 '…값 없음' 을 두면 글자가 구간 밖(왼쪽 축 너머)으로
 * 넘쳐 잘린다(Chromium 판독에서 'AC 무응답' 으로 잘린 것을 발견). 음영은 그대로 두고, 뜻은 차트 아래 각주가 말한다.
 */
export const GAP_LABEL_MIN_FRAC = 0.12;
export function gapLabelShown(g, span) {
  const w = Number(g?.x2) - Number(g?.x1);
  return Number.isFinite(w) && Number.isFinite(span) && span > 0 && w / span >= GAP_LABEL_MIN_FRAC;
}
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

/** 법인 → 서비스(스캔 대역 이름 — v2.676 사용자 요청으로 '데이터센터' 표기를 '서비스' 로) → 서버 목록(서버 응답 기준). 정렬은 사람 이름 순(숫자 인식). */
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

/*
 * v2.687 — 서버 종류 선택(사용자 요청 "CPU 만 있는 서버, GPU 도 있는 서버, 가상화 서버, 베어메탈 서버 선택"). 두 축이고 함께 고를 수 있다:
 * 구성(전체 · GPU 있음 · CPU 만) × 형태(전체 · 가상화 · 베어메탈). GPU 판정은 서버 gpuState(GPU 온도 · iDRAC 인벤토리 GPU · 매칭 ESXi 호스트 GPU
 * 중 하나라도 있으면 'gpu', GPU 0 장이라고 읽었을 때만 'cpu', 근거가 없으면 'unknown') — 판정 불가는 'CPU 만' 에 넣지 않는다.
 * 구버전 서버 응답(gpuState 없음)은 예전 GPU 온도 플래그로만 판정한다(gpu 아니면 판정 불가).
 */
export const GPU_TYPES = [{ k: '', label: '전체' }, { k: 'gpu', label: 'GPU 있음' }, { k: 'cpu', label: 'CPU 만' }];
export const KIND_TYPES = [{ k: '', label: '전체' }, { k: 'esxi', label: '가상화(ESXi)' }, { k: 'baremetal', label: '베어메탈' }];
export const EMPTY_TYPE = Object.freeze({ gpu: '', kind: '' });
export const gpuStateOf = (s) => s?.gpuState || (s?.gpu ? 'gpu' : 'unknown');
export function matchType(s, tf) {
  if (tf?.gpu && gpuStateOf(s) !== tf.gpu) return false;
  if (tf?.kind && s?.kind !== tf.kind) return false;
  return true;
}
export const filterByType = (servers, tf) => (servers || []).filter((s) => matchType(s, tf));
/** 칩 개수 — 각 축은 **다른 축의 선택만** 반영해 센다(자기 축 선택으로 다른 칩이 0 이 되어 못 고르는 일이 없게 — deviceFacets 규칙). */
export function typeCounts(servers, tf = EMPTY_TYPE) {
  const list = servers || [];
  const gpu = {}; const kind = {};
  for (const o of GPU_TYPES) gpu[o.k] = list.filter((s) => matchType(s, { gpu: o.k, kind: tf.kind })).length;
  for (const o of KIND_TYPES) kind[o.k] = list.filter((s) => matchType(s, { gpu: tf.gpu, kind: o.k })).length;
  const unknown = list.filter((s) => matchType(s, { gpu: '', kind: tf.kind }) && gpuStateOf(s) === 'unknown').length;
  return { gpu, kind, unknown };
}
/** 서버 조회 쿼리(표·내보내기) — 빈 축은 싣지 않는다. */
export const typeQuery = (tf) => ({ ...(tf?.gpu ? { gpu: tf.gpu } : {}), ...(tf?.kind ? { kind: tf.kind } : {}) });
/** 선택 문구 — '' 이면 전체. */
export function typeText(tf) {
  const parts = [GPU_TYPES.find((o) => o.k === tf?.gpu && o.k)?.label, KIND_TYPES.find((o) => o.k === tf?.kind && o.k)?.label].filter(Boolean);
  return parts.join(' · ');
}

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
  const hn = d.host?.name || '';
  if (d.kind === 'esxi' && d.matchedBy === 'hostname') return `호스트네임 일치 → ESXi 호스트 ${hn}(도메인·대소문자 무시${d.serviceTag ? ` · 서비스태그 ${d.serviceTag} 는 일치 없음` : ' · 서비스태그 없음'})`;
  if (d.kind === 'esxi') return `서비스태그 ${d.serviceTag} → ESXi 호스트 ${hn || '일치'}`;
  const amb = d.hostAmbiguous ? ' · 같은 호스트네임의 ESXi 호스트가 여럿이라 정하지 않았습니다'
    : d.hostTagMismatch ? ' · 같은 호스트네임의 ESXi 호스트가 있지만 서비스태그가 달라(다른 장비) 연결하지 않았습니다' : '';
  if (!d.serviceTag) return `서비스태그 없음 — 서비스태그로 대조할 수 없어 호스트네임으로 찾았지만 일치하는 ESXi 호스트가 없어 베어메탈로 표시합니다${amb}`;
  return `서비스태그 ${d.serviceTag} · 호스트네임 — 일치하는 ESXi 호스트 없음${amb}`;
}

/** v2.666: ESXi 호스트 CPU(vCenter) 계열 각주. 매칭이 없으면 ''. */
export function hostCpuNote(data) {
  const h = data?.hostCpu;
  if (!h) return '';
  const by = h.matchedBy === 'hostname' ? '호스트네임(도메인·대소문자 무시)' : '서비스태그';
  const first = Number.isFinite(h.firstTs) ? ` 이 호스트의 첫 적재는 ${ymd(h.firstTs)} ${hm(h.firstTs)} 입니다(v2.666 부터 쌓이며 그 이전은 비어 있습니다).` : ' 이 계열은 v2.666 부터 쌓입니다 — 아직 적재된 값이 없습니다.';
  return `초록 점선 ESXi CPU (vCenter) 는 ${by}로 찾은 ESXi 호스트 ${h.hostName || h.hostId} 의 vCenter CPU 사용률이고 비교용입니다 — iDRAC CPU 사용률에 섞지 않습니다.${first}`;
}

/*
 * v2.666 — CPU 사용률 기준선(75% 주의 · 90% 위험) 표시 켜기/끄기(사용자 요청 "cpu 90 위험, 75주의 표시 on/off"). 카드 순서·선 모양과
 * 같이 **브라우저에만** 저장한다(기본 켜짐 — 예전 화면 그대로). 기준선은 CPU 사용률 계열(iDRAC 또는 ESXi)이 하나라도 보일 때만 그린다.
 */
export const CPU_REF_KEY = 'idracTrend.cpuRef';
export function loadCpuRef(storage) {
  try { return storage?.getItem(CPU_REF_KEY) !== '0'; } catch { return true; }
}
export function saveCpuRef(storage, on) {
  try { if (on) storage?.removeItem(CPU_REF_KEY); else storage?.setItem(CPU_REF_KEY, '0'); } catch { /* 저장 못 하면 이번 화면에서만 */ }
}
export const showCpuRef = (refOn, on, st) => !!refOn && ((!!on?.cpuPct && !!st?.cpuPct) || (!!on?.hostCpuPct && !!st?.hostCpuPct));

/*
 * v2.712 — GPU 온도 기준선(사용자 요청 "GPU 온도 기준선 · 45도 이상 100도 미만 · 색상과 굵기를 사용자가 지정").
 * 값·색·굵기·켜짐을 CPU 기준선처럼 **브라우저에만** 저장한다(기본값과 같으면 저장하지 않는다).
 * 값은 정수 [GPU_REF_MIN, GPU_REF_MAX) — 범위 밖·빈 칸·숫자 아님은 저장하지 않고 직전 값을 쓴다(`Number('') === 0` 이 45 로 올라가지 않게).
 * 색은 #rrggbb 만 받는다(style 에 그대로 들어가는 값이다). 기준선은 GPU 온도 계열이 보일 때만 그린다.
 * ⚠ 포탈이 'GPU 온도 위험 수치' 를 정한 것이 아니다 — 모델·냉각마다 정상 범위가 다르다(v2.650 규약). 사용자가 고른 표시선이다.
 */
export const GPU_REF_KEY = 'idracTrend.gpuRef';
export const GPU_REF_MIN = 45;
export const GPU_REF_MAX = 100;   // 미만(포함하지 않는다)
export const GPU_REF_DEFAULT = Object.freeze({ on: true, value: 85, color: '#ec4899', width: 2 });
export const GPU_REF_COLORS = ['#ec4899', '#ef4444', '#f59e0b', '#facc15', '#22c55e', '#38bdf8', '#a855f7', '#e5e7eb'];
const HEX_COLOR = /^#[0-9a-f]{6}$/;
/** 기준선 값 판정 — 정수이고 [45, 100) 이면 그 수, 아니면 null. 빈 문자열·공백·불리언·배열은 숫자가 아니다. */
export function gpuRefValueOf(v) {
  if (typeof v === 'string') { if (!/^\s*\d+\s*$/.test(v)) return null; v = Number(v); }
  if (typeof v !== 'number' || !Number.isInteger(v)) return null;
  return v >= GPU_REF_MIN && v < GPU_REF_MAX ? v : null;
}
export function normalizeGpuRef(saved) {
  const s = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  const d = GPU_REF_DEFAULT;
  const color = typeof s.color === 'string' ? s.color.toLowerCase() : '';
  return {
    on: typeof s.on === 'boolean' ? s.on : d.on,
    value: gpuRefValueOf(s.value) ?? d.value,
    color: HEX_COLOR.test(color) ? color : d.color,
    width: WIDTHS.includes(s.width) ? s.width : d.width,
  };
}
/** 바꾼 칸만 반영 — 잘못된 값은 그 칸만 버린다(직전 값 유지). */
export function setGpuRef(ref, patch) {
  const cur = normalizeGpuRef(ref);
  const next = { ...cur };
  if (patch && 'on' in patch && typeof patch.on === 'boolean') next.on = patch.on;
  if (patch && 'value' in patch) { const v = gpuRefValueOf(patch.value); if (v != null) next.value = v; }
  if (patch && 'color' in patch) next.color = patch.color;
  if (patch && 'width' in patch) next.width = Number(patch.width);
  const out = normalizeGpuRef(next);
  if (patch && 'color' in patch && out.color !== String(patch.color).toLowerCase()) out.color = cur.color;
  if (patch && 'width' in patch && out.width !== Number(patch.width)) out.width = cur.width;
  return out;
}
export const isDefaultGpuRef = (r) => r.on === GPU_REF_DEFAULT.on && r.value === GPU_REF_DEFAULT.value && r.color === GPU_REF_DEFAULT.color && r.width === GPU_REF_DEFAULT.width;
export function loadGpuRef(storage) {
  try { return normalizeGpuRef(JSON.parse(storage?.getItem(GPU_REF_KEY) || 'null')); } catch { return normalizeGpuRef(null); }
}
export function saveGpuRef(storage, ref) {
  try {
    const r = normalizeGpuRef(ref);
    if (isDefaultGpuRef(r)) storage?.removeItem(GPU_REF_KEY); else storage?.setItem(GPU_REF_KEY, JSON.stringify(r));
  } catch { /* 저장 못 하면 이번 화면에서만 */ }
}
export const showGpuRef = (ref, on, st) => !!ref?.on && !!on?.gpuTemp && !!st?.gpuTemp;

/*
 * v2.661 — 카드 순서(사용자 요청 "사용자가 위치를 변경할 수 있게"). 브라우저에만 저장한다(사람마다 보는 순서가 다르다 —
 * 서버 설정으로 두면 한 사람이 바꾼 순서가 모두에게 바뀐다). 모르는 키는 버리고, 새 카드(다음 릴리스에 늘어난 계열)는 뒤에 붙인다.
 */
export const CARD_ORDER_KEY = 'idracTrend.cardOrder';
export const DEFAULT_ORDER = CHART_SERIES.map((s) => s.k);
export function normalizeOrder(saved) {
  const known = new Set(DEFAULT_ORDER);
  const seen = new Set();
  const out = [];
  for (const k of Array.isArray(saved) ? saved : []) if (known.has(k) && !seen.has(k)) { seen.add(k); out.push(k); }
  for (const k of DEFAULT_ORDER) if (!seen.has(k)) out.push(k);
  return out;
}
/** k 를 한 칸 옮긴다(dir -1 | +1). 끝에서는 그대로. */
export function moveKey(order, k, dir) {
  const a = [...order]; const i = a.indexOf(k); const j = i + dir;
  if (i < 0 || j < 0 || j >= a.length) return a;
  [a[i], a[j]] = [a[j], a[i]];
  return a;
}
/**
 * v2.680(D-08): 보이는 카드끼리만 한 칸 옮긴다 — 숨은 계열(매칭 안 된 ESXi CPU·GPU)과 자리를 바꾸면 화면에서 아무것도 안 움직인다.
 * visible 은 화면에 보이는 키(order 순서). 보이는 이웃이 없으면(끝) 그대로.
 */
export function moveVisibleKey(order, visible, k, dir) {
  const v = (visible || []).filter((x) => order.includes(x));
  const i = v.indexOf(k); const j = i + dir;
  if (i < 0 || j < 0 || j >= v.length) return [...order];
  const a = [...order]; const ai = a.indexOf(k); const aj = a.indexOf(v[j]);
  [a[ai], a[aj]] = [a[aj], a[ai]];
  return a;
}
/** 끌어서 놓기 — from 을 to 자리로(to 뒤 카드들은 밀린다). */
export function dropKey(order, from, to) {
  if (from === to || !order.includes(from) || !order.includes(to)) return [...order];
  const a = order.filter((k) => k !== from);
  a.splice(a.indexOf(to) + (order.indexOf(from) < order.indexOf(to) ? 1 : 0), 0, from);
  return a;
}
export function loadOrder(storage) {
  try { return normalizeOrder(JSON.parse(storage?.getItem(CARD_ORDER_KEY) || 'null')); } catch { return [...DEFAULT_ORDER]; }
}
export function saveOrder(storage, order) {
  try { if (order.join() === DEFAULT_ORDER.join()) storage?.removeItem(CARD_ORDER_KEY); else storage?.setItem(CARD_ORDER_KEY, JSON.stringify(order)); } catch { /* 저장 못 하면 이번 화면에서만 */ }
}

/**
 * CPU 사용률 출처(버킷 수) — 어느 값으로 채웠는지 밝힌다. v2.665 부터 **iDRAC 출처만**(사용자 지시 — vCenter·OS 값은 쓰지 않는다).
 * 출처가 바뀌는 구간은 측정 방식이 달라(텔레메트리 1분 · Sensors 컬렉션 30분 · 대체 경로 5분) 값이 튈 수 있다.
 */
export const CPU_SRC = { telemetry: 'iDRAC 텔레메트리', sensor: 'iDRAC CPU 센서', bmIdrac: 'iDRAC 대체 경로(베어메탈 사용률)', history: 'iDRAC 대체 경로 이력' };
export function cpuSourceNote(data) {
  const src = data?.cpuSources;
  if (!src) return '';
  const parts = Object.entries(src).filter(([, n]) => n > 0).map(([k, n]) => `${CPU_SRC[k] || k} ${n}구간`);
  if (!parts.length) return 'CPU 사용률은 iDRAC 의 어느 경로로도 읽지 못했습니다 — 텔레메트리(Datacenter 라이선스)·Sensors 컬렉션의 CPU 센서·베어메탈 사용률의 iDRAC 대체 경로 모두 값이 없습니다.';
  const mixed = parts.length > 1 ? ' 출처가 바뀌는 구간은 측정 방식이 달라 값이 튈 수 있습니다.' : '';
  return `CPU 사용률 출처: ${parts.join(' · ')}.${mixed}`;
}
/** 소비 전력을 못 찾은 이유. */
export function powerNote(data) {
  const p = data?.power;
  if (!p || p.found) return '';
  if (p.reason === 'no-edge-report') return '소비 전력 — 이 서버를 수집하는 엣지의 전력 보고를 아직 받지 못했습니다(중앙 재시작 직후면 1분 안에 채워집니다).';
  return '소비 전력 계열을 찾지 못했습니다.';
}

/*
 * v2.662 — 선 모양(사용자 요청 "흡기·배기 온도는 점선으로" + "사용자가 줄 모양과 형태를 지정해서 볼 수 있게").
 * 계열마다 { dash, width, dot } 이고 카드 순서와 같이 **브라우저에만** 저장한다(사람마다 보는 방식이 다르다).
 * 기본값과 같은 계열은 저장하지 않는다 — 다음 릴리스에서 기본값을 바꾸면 손대지 않은 사람에게 그대로 먹게.
 * 모양 키는 엑셀 차트(`xlsxChart.js` prstDash)와 같은 이름을 쓴다 — 서버가 같은 목록으로 거른다.
 */
export const LINE_STYLE_KEY = 'idracTrend.lineStyle';
export const DASHES = [
  { k: 'solid', label: '실선', array: undefined },
  { k: 'dash', label: '점선', array: '6 4' },
  { k: 'dot', label: '짧은 점선', array: '2 3' },
  { k: 'dashdot', label: '일점쇄선', array: '8 3 2 3' },
];
export const WIDTHS = [1, 2, 3, 4];
export const dashArrayOf = (k) => DASHES.find((d) => d.k === k)?.array;
export function defaultStyleOf(k) {
  const s = CHART_SERIES.find((x) => x.k === k);
  return { dash: s?.dash || 'solid', width: 2, dot: false };
}
export const DEFAULT_STYLES = Object.fromEntries(CHART_SERIES.map((s) => [s.k, defaultStyleOf(s.k)]));
/** 저장값 정규화 — 모르는 계열·모양·굵기는 기본값(조용히 깨지지 않게). 항상 전 계열을 채운다. */
export function normalizeStyles(saved) {
  const src = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  const out = {};
  for (const s of CHART_SERIES) {
    const d = defaultStyleOf(s.k);
    const v = src[s.k] && typeof src[s.k] === 'object' ? src[s.k] : {};
    out[s.k] = {
      dash: DASHES.some((x) => x.k === v.dash) ? v.dash : d.dash,
      width: WIDTHS.includes(v.width) ? v.width : d.width,
      dot: typeof v.dot === 'boolean' ? v.dot : d.dot,
    };
  }
  return out;
}
const sameStyle = (a, b) => a.dash === b.dash && a.width === b.width && a.dot === b.dot;
export const isDefaultStyles = (styles) => CHART_SERIES.every((s) => sameStyle(styles[s.k], defaultStyleOf(s.k)));
export function setStyle(styles, k, patch) {
  if (!styles[k]) return styles;
  return normalizeStyles({ ...styles, [k]: { ...styles[k], ...patch } });
}
export function loadStyles(storage) {
  try { return normalizeStyles(JSON.parse(storage?.getItem(LINE_STYLE_KEY) || 'null')); } catch { return normalizeStyles(null); }
}
export function saveStyles(storage, styles) {
  try {
    const diff = Object.fromEntries(CHART_SERIES.filter((s) => !sameStyle(styles[s.k], defaultStyleOf(s.k))).map((s) => [s.k, styles[s.k]]));
    if (!Object.keys(diff).length) storage?.removeItem(LINE_STYLE_KEY); else storage?.setItem(LINE_STYLE_KEY, JSON.stringify(diff));
  } catch { /* 저장 못 하면 이번 화면에서만 */ }
}
/** 엑셀 내보내기 쿼리 — `k:모양:굵기:점` 을 쉼표로. 기본값이면 빈 문자열(서버 기본과 같다). */
export function stylesQuery(styles, keys) {
  return (keys || []).filter((k) => styles?.[k]).map((k) => `${k}:${styles[k].dash}:${styles[k].width}:${styles[k].dot ? 1 : 0}`).join(',');
}

/*
 * v2.663 — 서버 표 · 조건 검색(사용자 요청 "데이터 센터 선택하면 전체 서버 리스트를 표 형식으로" + "최근 몇 시간 동안 CPU/GPU 온도
 * 몇 도 이상/이하, 소비 전력 몇 W 이상/이하 검색하는 조건식" — 선택: '최근 N시간 안에 한 번이라도').
 * 판정: '이상' 은 그 기간 최대가 기준 이상, '이하' 는 최소가 기준 이하(= 한 번이라도 그랬다). 값이 없는 지표는 맞지 않은 것이 아니라
 * **판정 불가**다 — 개수를 따로 센다(0 으로 보고 '이하' 에 걸리게 하면 거짓이다).
 */
export const TABLE_HOUR_PRESETS = [1, 6, 12, 24, 48, 72, 168, 720];
export const TABLE_HOURS_MAX = 720;
export const hoursLabel = (h) => (h % 24 === 0 && h >= 48 ? `${h / 24}일` : `${h}시간`);
/*
 * v2.687 — '평균 대비 변화' 조건(사용자 요청 "7일 동안 CPU 사용률이 평균에서 10% 이상 변화가 있는 장비" — 선택: 절대 차이·비율 **둘 다** ·
 * **기간 중 한 번이라도**). 변화 = max(최대 − 평균, 평균 − 최소) — 오르거나 내리거나. 단위가 같은 차이(devAbs: %는 %p, ℃, W)와
 * 평균 대비 비율(devPct: 변화 ÷ 평균 × 100)을 따로 둔다. 비율은 평균이 0 이하이면 판정 불가다(0 으로 나눈 값을 지어내지 않는다).
 * 값은 시간당 집계의 최대·최소라 1분 표본의 순간 스파이크까지 그대로 보인다(롤업이 최대·최소를 보존한다).
 */
export const COND_OPS = [
  { k: 'ge', label: '이상' }, { k: 'le', label: '이하' },
  { k: 'devAbs', label: '평균 대비 ± 이상 변화' }, { k: 'devPct', label: '평균 대비 ±% 이상 변화' },
];
const OP_KEYS = new Set(COND_OPS.map((o) => o.k));
export const isDevOp = (op) => op === 'devAbs' || op === 'devPct';
/*
 * v2.687: 서버 표·조건 검색의 지표 = iDRAC 6계열 + ESXi 3계열(매칭 호스트 — 차트에 보이는 계열 전부). ESXi 계열은 베어메탈 서버에 값이 없다
 * (판정 불가로 센다). SERIES(무응답 구간 판정용 iDRAC 6계열)는 그대로 둔다.
 */
export const TABLE_SERIES = [...SERIES, HOST_CPU_SERIES, ...HOST_GPU_SERIES];
const seriesOf = (k) => TABLE_SERIES.find((s) => s.k === k);
/** 조건 칸 옆 단위 — 비율 조건은 %, 퍼센트 지표의 절대 차이는 %p(퍼센트 포인트). */
export function condUnit(k, op) {
  const s = seriesOf(k);
  if (!s) return '';
  if (op === 'devPct') return '%';
  const u = s.unit.trim();
  return op === 'devAbs' && u === '%' ? '%p' : u;
}
/** 평균 대비 변화(순수) — { abs, pct, dir } | null. 평균·최대·최소 중 하나라도 없으면 null. pct 는 평균 ≤ 0 이면 null. */
export function deviationOf(st) {
  if (!st) return null;
  const { avg, max, min } = st;
  if (![avg, max, min].every((x) => typeof x === 'number' && Number.isFinite(x))) return null;
  const up = max - avg; const down = avg - min;
  const abs = Math.round(Math.max(up, down, 0) * 10) / 10;
  const pct = avg > 0 ? Math.round((Math.max(up, down, 0) / avg) * 1000) / 10 : null;
  return { abs, pct, dir: up >= down ? 'up' : 'down' };
}
/** 변화 한 줄(셀·CSV 공용) — '±12%p (40%)' · 비율을 못 내면 절대값만. */
export function deviationText(st, k) {
  const d = deviationOf(st);
  if (!d) return '—';
  const u = condUnit(k, 'devAbs');
  return `${d.dir === 'up' ? '▲' : '▼'} ${d.abs.toLocaleString()}${u}${d.pct == null ? '' : ` (${d.pct.toLocaleString()}%)`}`;
}
let condSeq = 0;
export const newCond = (k = 'cpuTemp', op = 'ge', v = '') => ({ id: `c${(condSeq += 1)}`, k, op, v });
/** 입력 칸 → 판정용 조건(값이 빈 칸·숫자 아님이면 뺀다 — 빈 칸을 0 으로 읽지 않는다). */
export function activeConds(conds) {
  return (conds || []).filter((c) => TABLE_SERIES.some((s) => s.k === c.k) && OP_KEYS.has(c.op))
    .map((c) => ({ ...c, n: typeof c.v === 'string' && c.v.trim() !== '' ? Number(c.v) : typeof c.v === 'number' ? c.v : NaN }))
    // 변화 조건의 음수 기준은 뜻이 없다(언제나 참) — 빈 칸처럼 쓰지 않는다.
    .filter((c) => Number.isFinite(c.n) && !(isDevOp(c.op) && c.n < 0));
}
/** 한 조건 → true | false | null(그 지표 값 없음). */
export function condHit(row, c) {
  const st = row?.[c.k];
  if (!st) return null;
  if (isDevOp(c.op)) {
    const d = deviationOf(st);
    const x = d ? (c.op === 'devPct' ? d.pct : d.abs) : null;
    return x == null ? null : x >= c.n;
  }
  const x = c.op === 'ge' ? st.max : st.min;
  if (typeof x !== 'number' || !Number.isFinite(x)) return null;
  return c.op === 'ge' ? x >= c.n : x <= c.n;
}
/** 행 판정 — mode 'all'(모두) | 'any'(하나라도). { hit, unknown } — unknown 이면 판정에 필요한 값이 없어 결론을 못 냈다. */
export function matchRow(row, conds, mode = 'all') {
  if (!conds.length) return { hit: true, unknown: false };
  const rs = conds.map((c) => condHit(row, c));
  if (mode === 'any') {
    if (rs.some((r) => r === true)) return { hit: true, unknown: false };
    return { hit: false, unknown: rs.some((r) => r === null) };
  }
  if (rs.some((r) => r === false)) return { hit: false, unknown: false };
  if (rs.some((r) => r === null)) return { hit: false, unknown: true };
  return { hit: true, unknown: false };
}
export function filterTable(rows, conds, mode = 'all') {
  const act = activeConds(conds);
  const out = []; let unknown = 0;
  for (const r of rows || []) { const m = matchRow(r, act, mode); if (m.hit) out.push(r); else if (m.unknown) unknown += 1; }
  return { rows: out, unknown, active: act.length };
}
export function condText(conds, mode = 'all') {
  const act = activeConds(conds);
  if (!act.length) return '';
  const parts = act.map((c) => {
    const s = seriesOf(c.k);
    if (isDevOp(c.op)) return `${s.label} 평균 대비 ±${c.n}${condUnit(c.k, c.op)} 이상 변화`;
    return `${s.label} ${c.n}${s.unit.trim()} ${c.op === 'ge' ? '이상' : '이하'}`;
  });
  return parts.join(mode === 'any' ? ' 또는 ' : ' 그리고 ');
}
/*
 * v2.687 — 찾은 서버의 '언제 · 얼마나'(사용자 요청 "서버를 찾으면 어느 날 어느 시간에 얼마 만큼의 변화가 있었는지 리스트로").
 * 입력: 서버 `/idrac/:id/trend/hourly` 의 시간별 평균·최대·최소 + 표의 기간 요약(평균 — 조건 판정 기준) + 조건.
 * 시간마다 **표와 같은 규칙**으로 판정한다(이상 = 그 시간 최대, 이하 = 그 시간 최소, 변화 = 그 시간 최대·최소 중 기간 평균에서 더 먼 쪽).
 * 연속한 시간은 한 구간으로 묶고(구간마다 가장 크게 벗어난 시간 = 정점), 값이 없는 시간은 판정하지 않는다(0 으로 보지 않는다).
 */
export const HOUR_MS = HOUR;
export const EPISODE_MAX = 300;
function hourHit(p, c, avg) {
  if (![p?.avg, p?.min, p?.max].every((x) => typeof x === 'number' && Number.isFinite(x))) return null;
  if (c.op === 'ge') return p.max >= c.n ? { value: p.max, dir: 'up', score: p.max } : null;
  if (c.op === 'le') return p.min <= c.n ? { value: p.min, dir: 'down', score: -p.min } : null;
  if (typeof avg !== 'number' || !Number.isFinite(avg)) return null;
  const up = p.max - avg; const down = avg - p.min;
  const d = Math.max(up, down, 0);
  const abs = Math.round(d * 10) / 10;
  const pct = avg > 0 ? Math.round((d / avg) * 1000) / 10 : null;
  const x = c.op === 'devPct' ? pct : abs;
  if (x == null || x < c.n) return null;
  return up >= down ? { value: p.max, dir: 'up', score: d } : { value: p.min, dir: 'down', score: d };
}
/** 시간별 점 → 조건에 걸린 구간 목록(순수). 반환 { episodes, omitted, hitHours, readHours } — 최신 구간 먼저. */
export function changeEpisodes(series, row, conds) {
  const out = []; let hitHours = 0; const readHours = {};
  for (const c of activeConds(conds)) {
    const pts = series?.[c.k];
    if (!Array.isArray(pts)) continue;
    readHours[c.k] = pts.length;
    const avg = row?.[c.k]?.avg;
    let cur = null;
    const close = () => { if (cur) { out.push(cur); cur = null; } };
    for (const p of [...pts].sort((a, b) => a.ts - b.ts)) {
      const h = hourHit(p, c, avg);
      if (!h) { close(); continue; }
      hitHours += 1;
      if (cur && p.ts - cur.lastTs === HOUR) {
        cur.lastTs = p.ts; cur.end = p.ts + HOUR; cur.hours += 1;
        if (h.score > cur._score) Object.assign(cur, { peakTs: p.ts, peak: h.value, dir: h.dir, _score: h.score });
      } else {
        close();
        cur = { id: `${c.id}:${p.ts}`, k: c.k, cond: c, start: p.ts, end: p.ts + HOUR, lastTs: p.ts, hours: 1, peakTs: p.ts, peak: h.value, dir: h.dir, _score: h.score, avg };
      }
    }
    close();
  }
  for (const e of out) {
    const hasAvg = typeof e.avg === 'number' && Number.isFinite(e.avg);
    e.delta = hasAvg ? Math.round((e.peak - e.avg) * 10) / 10 : null;
    e.deltaPct = hasAvg && e.avg > 0 ? Math.round(((e.peak - e.avg) / e.avg) * 1000) / 10 : null;
    delete e._score; delete e.lastTs;
  }
  out.sort((a, b) => b.start - a.start || a.k.localeCompare(b.k));
  return { episodes: out.slice(0, EPISODE_MAX), omitted: Math.max(0, out.length - EPISODE_MAX), hitHours, readHours };
}
/** 구간 시각 문구 — '10-01 14:00 ~ 16:00' · 날짜가 바뀌면 끝에도 날짜. 끝은 마지막 시간 칸의 끝(포함하지 않는 경계). */
export function episodeRangeText(e) {
  const s = new Date(e.start); const en = new Date(e.end);
  const md = (d) => `${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  return `${md(s)} ${hm(e.start)} ~ ${ymd(e.start) === ymd(e.end - 1) ? '' : `${md(en)} `}${hm(e.end)}`;
}
/** 변화 문구 — '+12.5%p (+41.7%)' · 평균을 모르면 '—'. 퍼센트 지표의 차이는 %p. */
export function episodeDeltaText(e) {
  if (e.delta == null) return '—';
  const sign = e.delta > 0 ? '+' : e.delta < 0 ? '−' : '±';
  const u = condUnit(e.k, 'devAbs');
  const pct = e.deltaPct == null ? '' : ` (${e.deltaPct > 0 ? '+' : e.deltaPct < 0 ? '−' : '±'}${Math.abs(e.deltaPct).toLocaleString()}%)`;
  return `${sign}${Math.abs(e.delta).toLocaleString()}${u}${pct}`;
}
/** 조건 한 줄 문구(구간 표의 '조건' 칸). */
export function condOneText(c) {
  const s = seriesOf(c.k);
  if (!s) return '';
  if (isDevOp(c.op)) return `평균 대비 ±${c.n}${condUnit(c.k, c.op)} 이상`;
  return `${c.n}${s.unit.trim()} ${c.op === 'ge' ? '이상' : '이하'}`;
}
/** 구간 목록 CSV(브라우저) — 결측은 빈 칸. */
export function episodesCsv(server, episodes) {
  const q = csvCell;
  const head = ['서버', '지표', '조건', '시작', '끝', '지속(시간)', '정점 시각', '정점 값', '기간 평균', '평균 대비 변화', '평균 대비 변화(%)'];
  const lines = [head.map(q).join(',')];
  for (const e of episodes || []) {
    const s = seriesOf(e.k);
    lines.push([server, s?.label, condOneText(e.cond), `${ymd(e.start)} ${hm(e.start)}`, `${ymd(e.end)} ${hm(e.end)}`, e.hours,
      `${ymd(e.peakTs)} ${hm(e.peakTs)}`, e.peak, e.avg, e.delta, e.deltaPct].map(q).join(','));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
/** 셀 강조 — 이 지표에 조건이 있고 그 조건을 만족하면 true. */
export const cellHit = (row, k, conds) => activeConds(conds).some((c) => c.k === k && condHit(row, c) === true);
/** 표 CSV(브라우저에서 만든다 — 화면에 있는 값 그대로). 결측은 빈 칸. */
export function tableCsv(rows, hours) {
  const q = csvCell; // 수식 인젝션 가드 공용 코어(util/csv.js)
  const head = ['법인', '서비스', '서버', '서비스태그', '유형', ...TABLE_SERIES.flatMap((s) => [`${s.label} 최대`, `${s.label} 평균`, `${s.label} 최소`, `${s.label} 평균 대비 변화(${condUnit(s.k, 'devAbs')})`, `${s.label} 평균 대비 변화(%)`])];
  const lines = [`# 최근 ${hoursLabel(hours)}`, head.map(q).join(',')];
  for (const r of rows || []) {
    lines.push([r.corpName, r.site, r.name, r.serviceTag, r.kind === 'esxi' ? 'ESXi' : '베어메탈',
      ...TABLE_SERIES.flatMap((s) => { const d = deviationOf(r[s.k]); return [r[s.k]?.max, r[s.k]?.avg, r[s.k]?.min, d?.abs, d?.pct]; })].map(q).join(','));
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

const minText = (ms) => {
  if (ms == null || ms === '' || !Number.isFinite(Number(ms))) return '—';
  const m = Math.round(Number(ms) / 60_000);
  if (m < 60) return `${m}분`;
  const h = Math.floor(m / 60); const r = m % 60;
  if (h < 48) return r ? `${h}시간 ${r}분` : `${h}시간`;
  return `${Math.round(h / 24)}일`;
};

/**
 * v2.665: 지금 CPU 사용률을 iDRAC 의 어느 경로로 읽는지 · 못 읽으면 왜인지(서버 cpuDiag). '지금' 기준이다(과거 구간의 원인은 말하지 않는다).
 * vCenter·OS 값은 쓰지 않으므로 그 사유도 말하지 않는다.
 */
export function cpuDiagText(d) {
  if (!d || !d.code) return '';
  switch (d.code) {
    case 'ok':
      if (d.source === 'telemetry') return '지금 CPU 사용률: iDRAC 텔레메트리로 읽는 중.';
      if (d.source === 'sensor') return `지금 CPU 사용률: iDRAC Sensors 컬렉션의 CPU 센서${d.name ? `(${d.name})` : ''}로 읽는 중(인벤토리 주기 — 기본 30분마다 갱신).`;
      return '지금 CPU 사용률: 베어메탈 사용률의 iDRAC 대체 경로 값으로 읽는 중.';
    case 'sensor-stale': return `지금 CPU 사용률을 쓰지 않습니다 — iDRAC CPU 센서 값이 ${minText(d.ageMs)} 전 것입니다(Sensors 컬렉션을 최근에 읽지 못했습니다).`;
    case 'bm-os-only': return '지금 CPU 사용률이 없습니다 — 베어메탈 사용률 값은 OS(SSH) 경로라 이 화면(iDRAC)에는 쓰지 않습니다. 이 서버 iDRAC 은 텔레메트리·CPU 센서를 주지 않습니다.';
    case 'bm-stale': return `지금 CPU 사용률을 쓰지 않습니다 — iDRAC 대체 경로 값이 ${minText(d.ageMs)} 전 것입니다.`;
    case 'no-idrac-cpu': return '지금 CPU 사용률이 없습니다 — 이 서버 iDRAC 에서 CPU 사용률을 읽을 경로가 없습니다(텔레메트리는 Datacenter 라이선스 전용 · CPU 센서 없음 · 베어메탈 사용률 iDRAC 대체 경로 미수집). vCenter 값은 쓰지 않습니다.';
    default: return `CPU 사용률 진단 실패: ${d.reason || d.code}`;
  }
}

/**
 * v2.665: iDRAC 표본이 지금 들어오는가(서버 idracState — 사용자 신고 "데이터가 수집되다가 지금은 안되고 있어").
 * 온도·전력은 표본이 신선할 때만 쌓이므로 차트가 멈췄다면 여기서 어디가 멈췄는지 가른다. 멈추지 않았으면 null(배너 없음).
 * @returns {{tone:'amber'|'red', title:string, lines:string[]}|null}
 */
export function idracStateBanner(st) {
  if (!st || typeof st !== 'object' || !st.stale) return null;
  const lines = [];
  const age = st.sampleAt != null ? `마지막 iDRAC 표본은 ${minText(st.ageMs)} 전(${hm(st.sampleAt)})입니다` : 'iDRAC 표본 시각을 모릅니다';
  lines.push(st.stale === 'no-sensors' ? '이 서버의 iDRAC 온도 표본이 없습니다.' : `${age} — 기준 ${minText(st.maxAgeMs)} 을 넘겨 새 값을 쌓지 않습니다.`);
  const c = st.collector;
  if (!st.remote) {
    lines.push('이 포탈이 직접 폴링하는 서버입니다 — 서비스 점검의 iDRAC 폴 주기 행과 iDRAC 응답(연결 테스트)을 확인하세요.');
    return { tone: 'amber', title: 'iDRAC 수집이 멈췄습니다', lines };
  }
  if (!c || !c.known) {
    lines.push('담당 엣지의 pull 상태를 중앙이 모릅니다(중앙 재시작 직후이거나 수집 서버 등록에서 빠졌습니다).');
    return { tone: 'amber', title: 'iDRAC 수집이 멈췄습니다', lines };
  }
  const pulled = c.lastOkAt != null ? `${minText(c.lastOkAgeMs)} 전` : '기록 없음';
  // v2.693(2026-10-04 운영 사고): 상태가 'ok' 로 남아 있어도 정상 pull 이 주기보다 크게 오래됐으면 **중앙이 pull 을 하지 못하고 있는 것**이다 —
  //   'pull 은 정상' 이라고 말하면 엉뚱하게 엣지의 iDRAC 수집을 의심하게 된다. 판정은 서버(pullStale)가 한다.
  if (c.pullStale) {
    const run = c.pullerRunningForMs != null ? ` 지금 진행 중인 pull 주기는 ${minText(c.pullerRunningForMs)}째입니다.` : '';
    const rel = c.pullerStuckReleases ? ` 끝나지 않은 주기를 ${c.pullerStuckReleases}회 버렸습니다.` : '';
    lines.push(`중앙이 엣지(${c.id})에서 ${minText(c.lastOkAgeMs)}째 pull 하지 못하고 있습니다(주기 ${minText(c.pullIntervalMs)} · 마지막 정상 ${pulled}).${run}${rel} 엣지 문제가 아니라 **중앙의 pull 이 멈춘 것**일 수 있습니다 — 서비스 점검의 '원격 수집기' 행과 서비스 로그의 [collector] 줄을 확인하세요.`);
    return { tone: 'red', title: '중앙이 엣지에서 데이터를 가져오지 못하고 있습니다', lines };
  }
  if (c.ok) {
    lines.push(`중앙 → 엣지(${c.id}) pull 은 정상입니다(마지막 정상 ${pulled}). 엣지가 보내는 이 서버의 표본 시각이 멈췄으므로 **엣지의 iDRAC 수집**을 보세요 — 특수 기능 › 엣지 로그에서 그 엣지의 collect.idrac 줄(마지막 실행·진행 시간·주기).`);
    return { tone: 'amber', title: '엣지의 iDRAC 수집이 멈췄습니다', lines };
  }
  const err = c.error ? ` 사유: ${c.error}` : (c.errorHidden ? ' (사유는 전체 범위 관리자에게만 보입니다)' : '');
  lines.push(`중앙 → 엣지(${c.id}) pull 이 실패하고 있습니다(마지막 정상 ${pulled}${c.fails ? ` · 연속 실패 ${c.fails}회` : ''}).${err} 설정 › 수집 서버에서 그 엣지 상태를 확인하세요.`);
  return { tone: 'red', title: '엣지에서 데이터를 가져오지 못하고 있습니다', lines };
}

/*
 * v2.666 — 과거 구간 스크롤(사용자 요청 "차트 아래 스크롤바로 이전 기간도 조회 · 1시간 조회에서 1시간 이전 데이터도 1시간 단위로").
 * 같은 길이(span)의 창을 `back` 칸만큼 과거로 옮긴다. 기준 끝(anchor)은 스크롤을 시작한 순간 한 번 잡는다 — 매번 Date.now() 로
 * 다시 잡으면 30초 폴링 사이에 창이 조금씩 밀려 같은 칸이 다른 구간이 된다. back=0 은 예전 그대로 '최근 구간'(폴링)이다.
 */
export const presetSpanOf = (range) => (PRESETS.find(([k]) => k === range) || [])[2] || null;
/** 보관 기간 안에서 몇 칸까지 과거로 갈 수 있나(창 전체가 보관 기간 안이어야 한다 — 서버 parseWindow 가 그 밖을 거절한다). */
export function maxBackOf(spanMs, retentionDays) {
  const span = Number(spanMs); const keep = Number(retentionDays) * DAY;
  if (!(span > 0) || !(keep > 0)) return 0;
  return Math.max(0, Math.floor((keep - span) / span));
}
/** back 칸 과거 창 — { start, end } (ms). back 은 [0, max] 로 자른다. */
export function scrollWindow(spanMs, back, anchorEnd, maxBack = Infinity) {
  const b = Math.max(0, Math.min(Number.isFinite(maxBack) ? maxBack : Infinity, Math.floor(Number(back) || 0)));
  const end = Number(anchorEnd) - b * spanMs;
  return { start: end - spanMs, end, back: b };
}
/** 스크롤 위치 문구 — '최근' 또는 'N칸 전(단위)'. */
export function scrollLabel(back, range) {
  if (!back) return '최근 구간';
  const lbl = (PRESETS.find(([k]) => k === range) || [])[1] || '';
  return `${back.toLocaleString()}칸 전 (${lbl} 단위)`;
}

/* ── v2.676: GPU 카드 · 호스트 상세에서 연결(사용자 요청 "GPU 어떤 카드가 몇 장 꽂혀 있는지 · 통합 성능 모니터링 · 복합 조회") ── */

const cardsLine = (g) => (g?.cards || []).map((c) => `${c.model} ×${c.count}`).join(' · ');
const MODE_TEXT = { vgpu: 'vGPU', vsga: 'vSGA', passthrough: '패스쓰루' };
/**
 * 서버 머리의 GPU 표지(순수). 서버 응답 gpuCards = { esxi, idrac } — 각각 null(못 읽음) | { cards:[{model,count,modes}], total }.
 * ESXi(vCenter 가 본 GPU)가 먼저이고, 없거나 0장이면 iDRAC 인벤토리. 둘 다 읽었는데 장수가 다르면 그 사실을 말한다
 * (패스쓰루 GPU 는 iDRAC 에 안 보일 수 있다 — 어느 쪽이 맞다고 단정하지 않는다). 둘 다 0장·모름이면 null(표지를 그리지 않는다).
 */
export function gpuCardsText(gc) {
  if (!gc) return null;
  const e = gc.esxi; const i = gc.idrac;
  const main = e?.total > 0 ? { g: e, src: 'ESXi' } : i?.total > 0 ? { g: i, src: 'iDRAC' } : null;
  if (!main) return null;
  const modes = [...new Set((main.g.cards || []).flatMap((c) => c.modes || []))].map((m) => MODE_TEXT[m] || m);
  const parts = [`${main.src === 'ESXi' ? 'vCenter(ESXi)' : 'iDRAC 인벤토리'} 기준 GPU ${main.g.total}장 — ${cardsLine(main.g)}${modes.length ? ` (${modes.join('·')})` : ''}`];
  let differ = false;
  if (e && i && e.total !== i.total) {
    differ = true;
    parts.push(`vCenter(ESXi) 는 ${e.total}장${e.total ? `(${cardsLine(e)})` : ''}, iDRAC 인벤토리는 ${i.total}장${i.total ? `(${cardsLine(i)})` : ''}으로 다릅니다 — 패스쓰루로 VM 에 준 GPU 는 iDRAC 에 안 보일 수 있고, vCenter 는 GPU 를 쓰도록 구성된 카드만 셉니다. 어느 쪽이 맞다고 단정하지 않습니다.`);
  } else if (!e || !i) {
    parts.push(main.src === 'ESXi' ? 'iDRAC 인벤토리의 GPU 목록은 읽지 못했거나 아직 없습니다.' : 'vCenter(ESXi) 쪽 GPU 목록은 없습니다(매칭된 ESXi 호스트가 없거나 읽지 못함).');
  }
  return { text: `GPU ${cardsLine(main.g)}`, src: main.src, total: main.g.total, differ, title: parts.join(' ') };
}

export const MATCH_RULE_LABEL = Object.freeze({ serviceTag: '서비스태그', hostname: '호스트네임', ip: 'IP', mac: 'MAC' });
/** 호스트 상세 → 통합 추이 인계 키(hooks/searchHandoff target). */
export const TREND_HANDOFF = 'idrac-trend';

/** 인계 문자열 → { id, host, matchedBy, confidence, conflicts, reverseSame } | null (순수 · 잘못된 값은 null). */
export function parseTrendHandoff(q) {
  if (!q) return null;
  try {
    const o = JSON.parse(q);
    if (!o || typeof o.id !== 'string' || !o.id) return null;
    return { id: o.id, host: String(o.host || ''), matchedBy: Array.isArray(o.matchedBy) ? o.matchedBy.map(String) : [],
      confidence: o.confidence === 'high' ? 'high' : o.confidence === 'medium' ? 'medium' : null,
      conflicts: Array.isArray(o.conflicts) ? o.conflicts.map(String) : [], reverseSame: o.reverseSame === false ? false : o.reverseSame === true ? true : null };
  } catch { return null; }
}

/** 연결 근거 문장(순수) — 통합 추이 화면 상단 안내. */
export function linkBasisText(h) {
  if (!h) return '';
  const by = h.matchedBy.map((r) => MATCH_RULE_LABEL[r] || r).join(' · ') || '근거 없음';
  const conf = h.confidence === 'high' ? '확실' : h.confidence === 'medium' ? '근거 1개' : '';
  let s = `ESXi 호스트 ${h.host || '(이름 없음)'} 에서 연결 — 일치: ${by}${conf ? ` (${conf})` : ''}`;
  if (h.conflicts.length) s += ` · ⚠ ${h.conflicts.map((r) => MATCH_RULE_LABEL[r] || r).join('·')} 은 다른 서버를 가리켜 서비스태그를 따랐습니다`;
  if (h.reverseSame === false) s += ' · ⚠ 이 서버에서 거꾸로 찾은 ESXi 호스트는 다른 호스트입니다(아래 판정 문구 참조)';
  return s;
}

const RULE_STATE_TEXT = { match: '일치', ambiguous: '여러 서버', none: '일치 없음', 'no-key': '값 없음', mismatch: '태그 다름' };
/** 연결 실패 사유(순수) — 호스트 상세 버튼 아래. r = /admin/idrac/trend/resolve-host 응답. */
export function resolveFailText(r) {
  if (!r) return '';
  const rules = Object.entries(r.rules || {}).map(([k, v]) => `${MATCH_RULE_LABEL[k] || k} ${RULE_STATE_TEXT[v?.state] || '—'}${v?.state === 'ambiguous' && v.count ? `(${v.count}대)` : ''}`).join(' · ');
  // v2.682 R3D-04: 이름·IP·MAC 은 맞았지만 서비스태그가 다른 서버만 있으면 다른 박스다 — 후보로 고르게 하지 않고 그 사실을 말한다.
  const tm = Array.isArray(r.tagMismatch) ? r.tagMismatch : [];
  if (r.reason === 'conflict' && tm.length && !(r.candidates || []).length) {
    const who = tm.slice(0, 3).map((m) => `${m.name}${m.serviceTag ? `(${m.serviceTag})` : ''}`).join(', ');
    return `호스트네임·IP·MAC 이 맞는 iDRAC 서버(${who}${tm.length > 3 ? ` 외 ${tm.length - 3}대` : ''})의 서비스태그가 이 호스트(${r.rules?.serviceTag?.value || '—'})와 달라 연결하지 않았습니다 — 하드웨어 교체 뒤 이름을 재사용했는지 확인하세요. 판정: ${rules}.`;
  }
  const head = r.reason === 'conflict' ? '규칙마다 다른 iDRAC 서버를 가리켜 연결하지 않았습니다 — 아래 후보에서 고르세요.'
    : r.reason === 'ambiguous' ? '같은 값을 가진 iDRAC 서버가 여럿이라 정하지 않았습니다 — 아래 후보에서 고르세요.'
      : `이 호스트에 대응하는 iDRAC 서버를 찾지 못했습니다${r.scoped ? '(볼 수 있는 범위 안에서)' : ''} — iDRAC 이 등록·스캔되지 않았거나 서비스태그·호스트네임·IP·MAC 이 모두 다릅니다.`;
  return `${head} 판정: ${rules}.`;
}
