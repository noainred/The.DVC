/**
 * serverTemp/board.js — '서버 온도' 히트맵 보드의 **계산**(순수, v2.556).
 *
 * 시안 B(`docs/design/server-temp/README.md`)의 수식을 한곳에 모았다. 버킷·타일 격자·비교
 * 막대 폭·스파크 path 는 화면 여러 곳이 쓰는데, 컴포넌트 안에 흩어 두면 한쪽만 고쳐져
 * **색과 개수가 어긋난다**(예: 히스토그램 임계선 위치와 KPI 의 32℃↑ 개수가 다른 기준).
 *
 * 웹 테스트는 node 환경(DOM 없음)이라 렌더 테스트가 불가하다 — 그래서 계산은 여기,
 * 회귀는 `board.test.js` 로 고정한다(`accessDeniedText.js`·`loadState.js` 와 같은 관례).
 */

/*
 * ⚠ 온도 임계는 **이 파일이 소유**하고 `../shared.jsx` 가 재수출한다(`tempColor` 가 쓴다).
 *   반대 방향(여기서 shared.jsx 를 import)으로 두면 이 모듈의 vitest 가 React·api.js 까지
 *   끌고 와 node 환경에서 깨진다 — 판정 모듈은 의존을 0 으로 유지한다(웹 테스트 관례).
 */
export const TEMP_WARN_C = 32;
export const TEMP_HOT_C = 40;

/**
 * 온도 값 파서 — 읽을 수 없으면 **null**.
 *
 * ⚠⚠ `Number(null) === 0` 이고 `Number('') === 0` 이다. `Number.isFinite(Number(v))` 만 보면
 *   **결측이 0℃ 로 둔갑**한다 — 히스토그램은 14℃ 칸에 클램프되고, 스파크라인은 선이 바닥으로
 *   떨어지고, KPI 는 그 서버를 '정상' 으로 센다. 전부 **오류 없이 틀린 값**이라 화면은 정상처럼
 *   보인다. 이 저장소가 v2.525·v2.540·v2.550·v2.552 에 네 번 밟은 함정이고, v2.556 의 자체
 *   테스트가 다시 잡았다(히스토그램·스파크 두 곳). **`v == null || v === ''` 를 먼저 본다.**
 */
export function tempNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  // ⚠ `Number([]) === 0` 이기도 하다(자체 테스트가 잡았다) — 그래서 타입을 먼저 좁힌다.
  //    숫자 문자열만 받아들이고, 빈 문자열·공백·그 밖의 값은 전부 '못 읽음' 이다.
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/* ── 히스토그램(1℃ 구간) ──────────────────────────────────────────────────── */

export const BUCKET_MIN = 14;
export const BUCKET_MAX = 46;          // 마지막 칸은 '46℃ 이상'(클램프)
export const BUCKET_COUNT = BUCKET_MAX - BUCKET_MIN + 1;   // 33

/**
 * 현재 온도 분포. 범위를 벗어난 값은 **양끝 칸에 클램프**한다(버리지 않는다 — 버리면
 * 막대 합이 대수와 달라져 '서버 N대' 라는 부제가 거짓이 된다).
 * @param {Array<{curC:number|null}>} rows
 * @returns {Array<{t:number, n:number, last:boolean}>} 33칸
 */
export function tempBuckets(rows = []) {
  const out = [];
  for (let t = BUCKET_MIN; t <= BUCKET_MAX; t += 1) out.push({ t, n: 0, last: t === BUCKET_MAX });
  for (const r of rows || []) {
    const v = tempNum(r?.curC);
    if (v == null) continue;                                  // 못 읽은 값은 0℃ 가 아니다
    const i = Math.min(BUCKET_COUNT - 1, Math.max(0, Math.floor(v) - BUCKET_MIN));
    out[i].n += 1;
  }
  return out;
}

/** 임계선의 가로 위치(%) — 칸 수로 나눈다(README: (32−14)/33 ≈ 54.5%). */
export function thresholdLeftPct(c) {
  return ((Number(c) - BUCKET_MIN) / BUCKET_COUNT) * 100;
}

/** 막대 위에 개수 라벨을 띄울지. 높은 막대이거나 **임계 이상이면 무조건** 보인다. */
export function showBucketLabel(b, maxN) {
  if (!b || !b.n) return false;
  return b.n >= (Number(maxN) || 0) * 0.35 || b.t >= TEMP_WARN_C;
}

/** 버킷 툴팁 — 마지막 칸은 '이상' 이라고 적는다(범위를 속이지 않는다). */
export function bucketTitle(b) {
  if (!b) return '';
  return b.last ? `${b.t}℃ 이상 · ${b.n}대` : `${b.t}~${b.t + 1}℃ · ${b.n}대`;
}

/* ── 막대 폭 ──────────────────────────────────────────────────────────────── */

/** 법인 비교 막대(15~30℃ 스케일). 값이 없으면 0(막대를 그리지 않는다). */
export function barPct1530(v) {
  const n = tempNum(v);
  if (n == null) return 0;
  return Math.max(2, Math.min(100, ((n - 15) / 15) * 100));
}

/** 표의 히트셀 막대(15~45℃ 스케일). */
export function heatPct(v) {
  const n = tempNum(v);
  if (n == null) return 0;
  return Math.max(4, Math.min(100, ((n - 15) / 30) * 100));
}

/* ── 히트맵 타일 ──────────────────────────────────────────────────────────── */

/**
 * 타일 채움색. ⚠ **값을 못 읽은 타일(null)을 초록으로 칠하지 않는다** — 회색이다.
 * 정상 구간은 15~32℃ 를 농도로 표현하고(비교), 임계 이상은 상태색으로 굳힌다(판정).
 * 두 체계를 섞으면 판정이 사라진다(README §Screens 4).
 */
export function tileFill(v) {
  const n = tempNum(v);
  if (n == null) return 'rgba(255,255,255,.08)';
  if (n >= TEMP_HOT_C) return '#ef4444';
  if (n >= TEMP_WARN_C) return '#f59e0b';
  const a = 0.22 + Math.max(0, Math.min(1, (n - 15) / 17)) * 0.7;
  return `rgba(34,197,94,${a.toFixed(2)})`;
}

/** 타일 격자 열 수 — 가로로 조금 긴 사각(2.2배)을 만든다. 4~24 로 묶는다. */
export function gridCols(n) {
  const c = Math.ceil(Math.sqrt(Math.max(0, Number(n) || 0) * 2.2));
  return Math.max(4, Math.min(24, c || 4));
}

/** 타일/간격 크기(뷰·밀도별). 서버·호스트는 수백 개라 작게, 클러스터·법인은 크게. */
export function tileSize(view, dense) {
  if (view === 'vc') return { tile: dense ? 18 : 24, gap: dense ? 1 : 2 };
  if (view === 'cluster') return { tile: dense ? 14 : 18, gap: dense ? 1 : 2 };
  return { tile: dense ? 9 : 12, gap: dense ? 1 : 2 };
}

/**
 * 한 그룹(법인)의 타일 배치. 값 내림차순으로 놓는다(더운 것이 먼저 보이게).
 * ⚠ 평균은 **값을 읽은 타일만**으로 낸다(null 을 0 으로 세면 평균이 끌려 내려간다).
 */
export function layoutGroup(items = [], valOf = (x) => x?.curC, { view = 'server', dense = false } = {}) {
  const { tile, gap } = tileSize(view, dense);
  const sorted = [...(items || [])].sort((a, b) => (valOf(b) ?? -1) - (valOf(a) ?? -1));
  const n = sorted.length;
  const cols = gridCols(n);
  const step = tile + gap;
  const rows = Math.max(1, Math.ceil(n / Math.max(1, cols)));
  const read = sorted.map(valOf).map(tempNum).filter((v) => v != null);
  const avg = read.length ? read.reduce((a, v) => a + v, 0) / read.length : null;
  return {
    items: sorted.map((x, i) => ({ item: x, x: (i % cols) * step, y: Math.floor(i / cols) * step, v: valOf(x) })),
    cols, rows, tile, gap, step,
    width: Math.max(tile, cols * step - gap),
    height: Math.max(tile, rows * step - gap),
    n,
    avg: avg == null ? null : Number(avg.toFixed(1)),
    unreadable: n - read.length,
  };
}

/* ── 스파크라인 ───────────────────────────────────────────────────────────── */

/**
 * 계열 → path. y 는 계열 min~max 로 정규화하되 **최소 폭 2℃** 를 둔다 — 안 두면 21.0~21.2℃
 * 같은 평탄한 계열이 화면 높이를 가득 채우는 톱니로 보인다(거짓 변동).
 * 점이 2개 미만이면 `null`(한 점을 선으로 만들면 추세가 있는 것처럼 보인다).
 */
export function sparkPath(points = [], { width = 84, height = 24, pad = 2, bottom = 3, minSpan = 2 } = {}) {
  // ⚠ `.map(Number).filter(Number.isFinite)` 로 쓰면 **null 점이 0℃ 로 살아남는다**(위 tempNum
  //   주석). 자체 테스트가 이 결함을 잡았다 — 결측은 건너뛴다(선을 바닥으로 끌지 않는다).
  /*
   * ⚠⚠ v2.574 BUG-15 — **수집이 없던 구간은 선을 잇지 않는다.**
   *   v2.573 까지는 결측을 버린 뒤 남은 점을 전부 `L` 로 이어 붙여, 6시간 공백이 **직선 보간**
   *   으로 그려졌다 — 없는 데이터를 있는 것처럼 보여주는 것이다. CLAUDE.md v2.551 이
   *   "수집이 없던 구간은 선을 잇지 않는다(끊어진 subpath — `roomTempView.sparkPath` 와 같은
   *   규약)" 라고 못 박았고 그 형제(`roomTempView.js:140`)는 실제로
   *   `prevTs != null && p.ts - prevTs <= gapMs ? 'L' : 'M'` 로 끊고 있었다. 여기만 빠져 있었다.
   * ⚠ x 좌표는 **결측 점까지 포함한 전체 길이**로 잡는다 — 버린 뒤 다시 세면 공백이 시간축에서
   *   사라져 남은 점들이 균등 간격으로 당겨진다(그것도 거짓이다).
   */
  const raw = (points || []).map((p) => tempNum(typeof p === 'number' ? p : p?.avg));
  const vals = raw.filter((v) => v != null);
  if (vals.length < 2) return null;
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = Math.max(hi - lo, minSpan);
  const denom = Math.max(1, raw.length - 1);
  const xs = (i) => pad + (i * (width - pad * 2)) / denom;
  const ys = (v) => height - bottom - ((v - lo) / span) * (height - bottom * 2);
  // 결측이 하나라도 끼면 그 자리에서 subpath 를 끊는다(`M`).
  let broke = false;
  const seg = [];
  raw.forEach((v, i) => {
    if (v == null) { broke = true; return; }
    const cmd = seg.length === 0 || broke ? 'M' : 'L';
    broke = false;
    seg.push(`${cmd}${xs(i).toFixed(1)},${ys(v).toFixed(1)}`);
  });
  const d = seg.join(' ');
  const firstI = raw.findIndex((v) => v != null);
  const lastI = raw.length - 1 - [...raw].reverse().findIndex((v) => v != null);
  // ⚠ 면적은 **끊긴 구간이 있으면 그리지 않는다** — 채우면 공백이 메워져 보인다.
  const gaps = raw.some((v) => v == null);
  const area = gaps ? null
    : `${d} L${xs(lastI).toFixed(1)},${height} L${xs(firstI).toFixed(1)},${height} Z`;
  return { d, area, lo, hi, first: vals[0], last: vals[vals.length - 1], n: vals.length, gaps };
}

/** 24시간 변화량 문구(현재 − 계열 첫 점). 계열이 없으면 빈 문자열(지어내지 않는다). */
export function sparkDeltaText(points, curC) {
  const sp = sparkPath(points);
  const cur = tempNum(curC);
  if (!sp || cur == null) return '';
  const d = cur - sp.first;
  return `24h ${d >= 0 ? '+' : ''}${d.toFixed(1)}`;
}

/**
 * 스파크라인이 어느 계열인지 — 표의 '현재온도'(흡기)와 다를 수 있으므로 **툴팁이 말한다**.
 * 서버가 `metricByKey` 로 알려준 값만 쓴다(추측 금지 — 모르면 계열 이름을 붙이지 않는다).
 */
export function sparkSeriesLabel(metric) {
  const m = String(metric || '');
  if (m === 'idractemp_inlet') return '24시간 · 흡기';
  if (m === 'idractemp_max') return '24시간 · 최고 센서';
  if (m === 'idractemp_exhaust') return '24시간 · 배기';
  if (m === 'idractemp_cpu') return '24시간 · CPU';
  if (m === 'temp_host') return '24시간 · ESXi 호스트';
  if (m === 'temp_cluster') return '24시간 · 클러스터 평균';
  if (m === 'temp_vc') return '24시간 · 법인 평균';
  return '24시간 추이';
}

/* ── 집계 ─────────────────────────────────────────────────────────────────── */

/**
 * 임계 개수. ⚠ **값을 못 읽은 서버를 정상으로도 이상으로도 세지 않는다** —
 * `ok + warm + hot + unknown === 전체` 가 항상 성립한다(v2.519·v2.523·v2.534 규약).
 */
export function tempCounts(rows = []) {
  const c = { ok: 0, warm: 0, hot: 0, unknown: 0, total: 0 };
  for (const r of rows || []) {
    c.total += 1;
    const v = tempNum(r?.curC);
    if (v == null) { c.unknown += 1; continue; }
    if (v >= TEMP_HOT_C) c.hot += 1;
    else if (v >= TEMP_WARN_C) c.warm += 1;
    else c.ok += 1;
  }
  return c;
}

/** 이상 서버(임계 이상) — 더운 순. 값을 못 읽은 서버는 들어가지 않는다(모르는 것이다). */
export function hotList(rows = []) {
  return (rows || [])
    .filter((r) => { const v = tempNum(r?.curC); return v != null && v >= TEMP_WARN_C; })
    .sort((a, b) => tempNum(b.curC) - tempNum(a.curC));
}

/** 법인 비교 목록 — 전체 평균 내림차순 + 그 법인의 임계 개수. */
export const UNASSIGNED_DC = '(미분류)';

/**
 * 행 → 법인 그룹 키. ⚠ **서버의 `byDatacenter` 조립 규칙과 글자 그대로 같아야 한다**
 * (`server/src/tools/serverTemp.js`: `r.datacenterId || r.vcenterId || '(미분류)'`).
 * 다르면 비교 목록의 임계 개수와 히트맵 그룹이 **서로 다른 집합**을 세면서도 오류가 나지 않는다.
 */
export function dcKeyOf(r) {
  return String(r?.datacenterId || r?.vcenterId || UNASSIGNED_DC);
}

export function compareRows(byDatacenter = [], rows = []) {
  const perDc = new Map();
  for (const r of rows || []) {
    const k = dcKeyOf(r);
    if (!k) continue;
    const g = perDc.get(k) || [];
    g.push(r);
    perDc.set(k, g);
  }
  return [...(byDatacenter || [])]
    .map((d) => {
      const c = tempCounts(perDc.get(String(d.key)) || []);
      return { ...d, warm: c.warm, hot: c.hot, unknown: c.unknown };
    })
    .sort((a, b) => (b.all?.avgC ?? -1) - (a.all?.avgC ?? -1));
}

/** 표 행 배경(임계). hover 는 CSS 가 덮는다 — 여기서는 배경만 준다. */
export function rowTint(v) {
  const n = tempNum(v);
  if (n == null) return undefined;
  if (n >= TEMP_HOT_C) return { background: 'rgba(239,68,68,.07)' };
  if (n >= TEMP_WARN_C) return { background: 'rgba(245,158,11,.05)' };
  return undefined;
}

/* ── 밀도(여유/촘촘히) ────────────────────────────────────────────────────── */

export const DENSITY_KEY = 'dvc.esxitemp.density';

/** 저장된 밀도 복원. ⚠ 프라이빗 창에서 throw 하므로 try/catch(루트 CLAUDE.md 규약). */
export function loadDensity() {
  try { return localStorage.getItem(DENSITY_KEY) === 'compact'; } catch { return false; }
}
export function saveDensity(dense) {
  try { localStorage.setItem(DENSITY_KEY, dense ? 'compact' : 'comfortable'); } catch { /* 저장 못 해도 화면은 동작한다 */ }
}

/** 밀도별 치수 — 화면이 숫자를 흩뿌리지 않게 한곳에서 준다. */
export function densityMetrics(dense) {
  return {
    listMaxH: dense ? 300 : 380,
    cmpPad: dense ? '4px 8px' : '7px 8px',
    hotPad: dense ? '5px 6px' : '8px 6px',
    groupGap: dense ? 8 : 12,
    barW: dense ? 36 : 48,
  };
}

/* ── 추이 모달: 점 상한으로 잘린 기간(v2.621 감사 RECENT-02) ─────────────── */

function pad2(n) { return String(n).padStart(2, '0'); }

/**
 * 서버가 점 상한(`limit`) 때문에 요청 기간을 다 덮지 못했으면(`truncated:true`) 그 사실을 말하는 문구.
 * 잘리지 않았으면 null. ⚠ 조용한 상한 금지 — 1달·분 단위처럼 점이 상한을 넘으면 최근 구간만 오는데,
 * 이 문구가 없으면 차트가 '요청한 기간 전체' 인 것처럼 보인다. 시각은 브라우저 로컬 시각(차트 축과 같다).
 */
export function histCutNote(hist) {
  if (!hist || hist.truncated !== true) return null;
  const lim = typeof hist.limit === 'number' && Number.isFinite(hist.limit) && hist.limit > 0 ? hist.limit : null;
  const limTxt = lim ? `(점 상한 ${lim.toLocaleString()}개)` : '(점 상한)';
  const cs = hist.coveredSince;
  if (typeof cs === 'number' && Number.isFinite(cs) && cs > 0) {
    const d = new Date(cs);
    const at = `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    return `요청한 기간 중 ${at} 이후만 표시합니다${limTxt}. 집계 단위를 넓히면 전체 기간이 보입니다.`;
  }
  return `요청한 기간을 다 담지 못했습니다${limTxt}. 집계 단위를 넓히면 전체 기간이 보입니다.`;
}
