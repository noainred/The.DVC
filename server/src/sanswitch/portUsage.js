/**
 * v2.748 — SAN 스위치 '포트 사용량' 화면(시안 A안 개정 2)의 순수 조립 코어.
 *
 * 사용자 요구: 개별 포트의 피크·평균 사용량을 1일/7일/1달 단위로, 단위마다 이전 기록까지 넘겨 보고,
 *   같은 스토리지로 가는 포트를 묶어 보고, 포트×시간·날짜×시간 히스토리(색 칸)로 본다.
 *
 * 이 파일은 **DB 를 읽지 않는다** — 라우트가 perfDb.portSeries 결과(기억·합류·취소를 이미 탄다)를 넘기면
 *   기간 경계·칸 조립·스토리지 합산·불균형·유휴 판정만 한다. 그래서 테스트가 입력을 직접 넣어 고정할 수 있다.
 *
 * 정직 규칙(화면 문구와 짝):
 *  - 값은 portperfshow 의 송수신 합 처리량(바이트/초)이다. 피크는 '수집 시점들 중 최댓값' 이지 순간 최대가 아니다.
 *  - 못 읽은 칸은 0 이 아니라 null 이다. 스토리지 합은 **멤버가 다 있는 칸만** 더하고, 일부만 있는 칸은 null + partial 로 센다
 *    (v2.621 DATA-03 — 부분 합을 사용량으로 내지 않는다).
 *  - 스토리지 피크 합은 멤버 피크가 같은 순간이 아닐 수 있어 **상한**이다.
 *  - 연결 장비 이름은 최신 하나뿐이라(port_meta) 지난 기간도 지금 이름으로 묶인다.
 */
import { storageKey, endpointKind } from './perfDb.js';
import { DAY_OFFSET_MIN, DAY_MS } from '../util/dayKey.js';

const HOUR = 3_600_000;
export const UNITS = ['d', 'w', 'm'];
/** 불균형: 그룹 평균이 이 값(바이트/초 — 0.5 Gb/s) 이상일 때만, 멤버 평균이 그룹 평균의 RATIO 배 이상이면 편중. */
export const IMBALANCE_MIN_BPS = 0.5e9 / 8;
export const IMBALANCE_RATIO = 1.4;
/** 유휴: 30일 피크가 속도의 1% 미만. 데이터가 IDLE_MIN_DAYS 일 미만이면 판단 보류. */
export const IDLE_PCT = 1;
export const IDLE_DAYS = 30;
export const IDLE_MIN_DAYS = 7;

/** '16G' → 바이트/초 회선 용량. 모르면 null(0 이 아니다 — 0 이면 포화도가 무한대·0% 로 둔갑한다). */
export function capBpsOf(speed) {
  const m = String(speed || '').match(/^(\d+)G$/);
  if (!m || !(Number(m[1]) > 0)) return null;
  return (Number(m[1]) * 1e9) / 8;
}

const pad = (n) => String(n).padStart(2, '0');
const WD = ['일', '월', '화', '수', '목', '금', '토'];

/** 그 시각이 속한 지역(기본 한국) 하루의 시작(epoch ms). */
export function dayStartOf(t, offsetMin = DAY_OFFSET_MIN) {
  const off = offsetMin * 60_000;
  return Math.floor((t + off) / DAY_MS) * DAY_MS - off;
}
function ymd(t, offsetMin) {
  const d = new Date(t + offsetMin * 60_000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), wd: WD[d.getUTCDay()] };
}
const md = (t, o) => { const x = ymd(t, o); return `${pad(x.m)}-${pad(x.d)}`; };

/**
 * 기간 경계(순수). off 는 '오늘(이번 주·이번 달) 기준 몇 단위 전' — 0 이 현재, 음수가 과거.
 *  - d: 그 하루(지역 자정~자정).
 *  - w: 그날로 끝나는 7일(오늘 포함 지난 7일, 한 칸 전이면 그 앞 7일). 달력 주가 아니다(월요일 기준을 섞지 않는다).
 *  - m: 달력 한 달(1일~말일).
 * 하한(minOff)은 1시간 집계 보관 기간(retentionDays) 안에서 시작하는 마지막 단위다 — 그보다 과거는 칸이 전부 비므로 넘기지 않는다.
 * 잘못된 단위·범위 밖 off 는 issue 로 돌려준다(조용히 잘라 다른 기간을 보여 주지 않는다).
 */
export function periodOf(unit, off, { now = Date.now(), offsetMin = DAY_OFFSET_MIN, retentionDays = 730, fineDays = 31 } = {}) {
  if (!UNITS.includes(unit)) return { issue: `단위는 ${UNITS.join('·')} 중 하나입니다` };
  const o = Number(off);
  if (!Number.isInteger(o) || o > 0) return { issue: 'off 는 0 이하의 정수입니다' };
  const today = dayStartOf(now, offsetMin);
  const oldest = today - Math.max(1, Math.floor(retentionDays)) * DAY_MS;
  let start, end, label, short;
  const at = (oo) => {
    if (unit === 'd') { const s = today + oo * DAY_MS; return [s, s + DAY_MS]; }
    if (unit === 'w') { const e = today + DAY_MS + oo * 7 * DAY_MS; return [e - 7 * DAY_MS, e]; }
    const t = ymd(today, offsetMin);
    const off0 = offsetMin * 60_000;
    const s = Date.UTC(t.y, t.m - 1 + oo, 1) - off0;
    return [s, Date.UTC(t.y, t.m + oo, 1) - off0];
  };
  // 하한: 시작이 보관 기간 안인 가장 과거 단위.
  // v2.782(점검 K3 I-I1): 루프(−1000 상한) 대신 산술로 — 보관 3650일이면 1일 단위가 −1000 에서 막혀 거짓 '보관 기간보다 과거' 400 이 났다.
  //   결과는 옛 루프와 같다(상한에 걸리지 않는 범위 — server/test/audit2782c.test.js 가 단위·보관 일수·달 경계를 대조).
  const minOff = Number.isFinite(oldest) ? minOffOf(unit, today, oldest, offsetMin, at) : 0;
  if (o < minOff) return { issue: `보관 기간(${Math.floor(retentionDays)}일)보다 과거입니다`, minOff };
  [start, end] = at(o);
  const days = [];
  for (let t = start; t < end; t += DAY_MS) days.push(t);
  const a = ymd(start, offsetMin), z = ymd(end - DAY_MS, offsetMin);
  if (unit === 'd') { label = `${a.y}-${pad(a.m)}-${pad(a.d)} (${a.wd})`; short = `${md(start, offsetMin)}(${a.wd})`; }
  else if (unit === 'w') { label = `${md(start, offsetMin)}(${a.wd}) ~ ${md(end - DAY_MS, offsetMin)}(${z.wd})`; short = `${md(start, offsetMin)}~${md(end - DAY_MS, offsetMin)}`; }
  else { label = `${a.y}년 ${a.m}월`; short = `${a.m}월`; }
  // 1일 단위의 차트만 15분 칸을 쓴다 — 15분 집계 보관(fineDays)이 지난 날은 1시간 칸.
  const fine = unit === 'd' && start >= now - fineDays * DAY_MS;
  return { unit, off: o, minOff, start, end, days, label, short, fine, current: start <= now && now < end };
}

/**
 * 기간 하한(순수) — 시작(at(o)[0])이 oldest 이상인 가장 작은 o(0 이하). at 은 o 에 대해 단조 증가한다.
 *  - d: 시작 = today + o일 → o ≥ −(today−oldest)/하루.
 *  - w: 시작 = today − 6일 + 7o일 → o ≥ ⌈(6일 − (today−oldest))/7일⌉.
 *  - m: oldest 가 속한 달까지의 달 차이(그달 1일이 oldest 보다 앞이면 한 달 뒤).
 * 경계 오차(정수 나눗셈·달 길이)는 마지막에 at 으로 한두 칸 맞춘다 — 산술이 틀려도 결과가 at 기준과 어긋나지 않게.
 */
function minOffOf(unit, today, oldest, offsetMin, at) {
  let o;
  if (unit === 'd') o = -Math.floor((today - oldest) / DAY_MS);
  else if (unit === 'w') o = Math.ceil((6 * DAY_MS - (today - oldest)) / (7 * DAY_MS));
  else { const a = ymd(today, offsetMin), b = ymd(oldest, offsetMin); o = (b.y * 12 + b.m) - (a.y * 12 + a.m); }
  o = Math.min(0, o);
  while (o < 0 && at(o)[0] < oldest) o++;
  while (at(o - 1)[0] >= oldest) o--;
  return o === 0 ? 0 : o;   // Math.ceil 의 −0 을 0 으로(옛 루프와 같은 값)
}

/**
 * portSeries 결과(버킷이 성기다 — 표본 있는 버킷만) → 포트별 조밀 배열.
 * since 부터 bucketMs 간격 n 칸. now 이후에 시작하는 칸은 값이 있어도 비운다(데모 수식은 미래도 만든다).
 */
export function denseByPort(res, { since, bucketMs, n, now = Date.now() }) {
  const out = new Map();
  if (!res || !(bucketMs > 0)) return out;
  const pos = (res.buckets || []).map((ts) => {
    const i = Math.round((Number(ts) - since) / bucketMs);
    return i >= 0 && i < n && since + i * bucketMs <= now ? i : -1;
  });
  for (const s of res.series || []) {
    const avg = new Array(n).fill(null), peak = new Array(n).fill(null);
    for (let k = 0; k < pos.length; k++) {
      const i = pos[k]; if (i < 0) continue;
      const a = s.avg?.[k], p = s.peak?.[k];
      if (a != null && Number.isFinite(Number(a))) avg[i] = Number(a);
      if (p != null && Number.isFinite(Number(p))) peak[i] = Number(p);
    }
    out.set(Number(s.port), { avg, peak, name: s.name || '', speed: s.speed || '' });
  }
  return out;
}

/**
 * 1시간 칸 → 하루 칸. 평균 = 값 있는 시간들의 평균, 피크 = 최댓값, n = 값 있는 시간 수(화면이 '24시간 중 n시간' 을 말한다).
 * 값 있는 시간이 하나도 없으면 null.
 * v2.785(GI I-B3): perDay = 하루 칸 수(기본 24 = 1시간 칸). 유휴 30일은 3시간 칸(8)을 접는다 — 그때 n 은 값 있는 칸 수다.
 */
export function hoursToDays(avg, peak, dayCount, perDay = 24) {
  const out = [];
  const k = Math.max(1, Math.floor(perDay));
  for (let d = 0; d < dayCount; d++) {
    let s = 0, n = 0, pk = null;
    for (let h = d * k; h < d * k + k; h++) {
      if (avg[h] != null) { s += avg[h]; n++; }
      if (peak[h] != null) pk = pk == null ? peak[h] : Math.max(pk, peak[h]);
    }
    out.push(n ? [Math.round(s / n), pk ?? null, n] : null);
  }
  return out;
}

/** 시간 칸(avg·peak 배열)을 [avg, peak, 1] 셀 배열로. */
const hourCells = (avg, peak, from, count) => {
  const out = [];
  for (let i = from; i < from + count; i++) out.push(avg[i] == null ? null : [avg[i], peak[i] ?? null, 1]);
  return out;
};

/**
 * 멤버 칸 합산 — 멤버가 **다 있는 칸만** 더한다. 일부만 있으면 null 이고 partial 로 센다.
 * 셀은 [avg, peak, n] 또는 null. 합의 n 은 멤버 n 의 최솟값(덜 채워진 쪽 기준).
 */
export function sumCells(memberCells) {
  const len = memberCells[0]?.length || 0;
  const cells = []; let partial = 0;
  for (let i = 0; i < len; i++) {
    let a = 0, p = 0, n = Infinity, have = 0, peakKnown = true;
    for (const mc of memberCells) {
      const c = mc[i];
      if (!c) continue;
      have++; a += c[0]; n = Math.min(n, c[2] ?? 1);
      if (c[1] == null) peakKnown = false; else p += c[1];
    }
    if (have && have < memberCells.length) partial++;
    cells.push(have && have === memberCells.length ? [a, peakKnown ? p : null, n] : null);
  }
  return { cells, partial };
}

/** 같은 길이 배열 합산(차트용) — 멤버가 다 있는 칸만, 아니면 null. */
export function sumSeries(list) {
  const n = list[0]?.length || 0;
  const out = new Array(n).fill(null); let partial = 0;
  for (let i = 0; i < n; i++) {
    let s = 0, have = 0;
    for (const arr of list) if (arr[i] != null) { s += arr[i]; have++; }
    if (have === list.length && have) out[i] = s; else if (have) partial++;
  }
  return { values: out, partial };
}

const meanOf = (arr) => { let s = 0, n = 0; for (const v of arr) if (v != null) { s += v; n++; } return n ? s / n : null; };
const maxAt = (arr) => { let m = null, at = -1; arr.forEach((v, i) => { if (v != null && (m == null || v > m)) { m = v; at = i; } }); return { max: m, at }; };

/**
 * 포트 목록(스냅샷 우선, 없으면 성능 DB 의 포트 정보)을 하나로.
 * 스냅샷 포트: { index, slotPort, state, speed, attachedName }. 이름·속도는 스냅샷이 비어 있으면 port_meta 값으로 채운다.
 */
export function portList(snapPorts = [], metaByPort = new Map()) {
  const seen = new Map();
  for (const p of snapPorts || []) {
    const idx = Number(p?.index);
    if (!Number.isInteger(idx) || idx < 0) continue;
    const m = metaByPort.get(idx) || {};
    seen.set(idx, { port: idx, slotPort: p.slotPort ?? String(idx), state: p.state || 'unknown',
      name: p.attachedName || m.name || '', speed: p.speed || m.speed || '' });
  }
  for (const [idx, m] of metaByPort) {
    if (!seen.has(idx)) seen.set(idx, { port: idx, slotPort: String(idx), state: 'unknown', name: m.name || '', speed: m.speed || '' });
  }
  return [...seen.values()].sort((a, b) => a.port - b.port);
}

/** 어레이 포트를 스토리지 키로 묶는다(호스트·이름 없는 포트는 묶지 않는다 — 스토리지가 아니다). */
export function storageGroups(ports) {
  const g = new Map();
  for (const p of ports) {
    if (!p.name) continue;
    const key = storageKey(p.name);
    if (endpointKind(key) !== 'array') continue;
    if (!g.has(key)) g.set(key, []);
    g.get(key).push(p.port);
  }
  return [...g.entries()].map(([key, members]) => ({ key, members: members.sort((a, b) => a - b) }));
}

/**
 * 30일 하루 칸(한국 하루 — idleDailyOf) → 유휴·보류·꺼짐·상태 모름 분류.
 * 꺼진(online 아님) 포트는 유휴로 세지 않고 따로 센다 — 안 쓰는 것과 못 쓰는 것은 다르다.
 * v2.785(GI I-B1): 상태를 모르는 포트(portList 가 'unknown' 으로 채운 것 — 엣지가 문제 포트만 보낸 축약 스냅샷·스냅샷 없음)는
 *   꺼짐도 유휴도 아니다. 전에는 off 로 세어 정상 online 포트가 전부 '사용 중이 아닌 포트' 로 보이고 유휴가 0개가 됐다
 *   ('못 읽은 값은 0 이 아니다' 와 같은 종류). 따로 센다 — 이유는 단정하지 않는다(화면 머리말의 portsScope 안내가 밝힌다).
 */
export function idleOf(ports, daily30) {
  const idle = [], pending = [], off = [], unknown = [];
  for (const p of ports) {
    if (!p.state || p.state === 'unknown') { unknown.push({ port: p.port, slotPort: p.slotPort, name: p.name }); continue; }
    if (p.state !== 'online') { off.push({ port: p.port, slotPort: p.slotPort, state: p.state }); continue; }
    const s = daily30.get(p.port);
    const days = s ? s.peak.filter((v) => v != null).length : 0;
    const peak = s ? maxAt(s.peak).max : null;
    const cap = capBpsOf(p.speed);
    if (cap == null) { pending.push({ port: p.port, slotPort: p.slotPort, name: p.name, days, why: '속도 모름' }); continue; }
    if (days < IDLE_MIN_DAYS) { pending.push({ port: p.port, slotPort: p.slotPort, name: p.name, days, why: `데이터 ${days}일` }); continue; }
    if (peak != null && peak < cap * (IDLE_PCT / 100)) idle.push({ port: p.port, slotPort: p.slotPort, name: p.name, peak, days, capBps: cap });
  }
  return { idle, pending, off, unknown, days: IDLE_DAYS, minDays: IDLE_MIN_DAYS, pct: IDLE_PCT };
}

/**
 * v2.785(GI I-B3): 유휴 30일 조회의 칸 폭 — 지역 자정이 그 폭의 정배수여야 epoch 정배수 버킷(perfDb `ts / bm`)이 지역 하루로 나뉜다.
 * 하루(DAY) 버킷은 UTC 하루라 한국 하루와 9시간 어긋났다(첫 한국 아침 00~09시 표본이 버려지고 데이터 일수가 +1).
 * 3시간이 한국(+9h)·UTC 에 맞는 가장 큰 폭이다. 1시간 칸은 768포트에서 요청당 +0.5~0.7초라 쓰지 않는다(3시간은 그 절반 이하 — 감사 실측).
 * 지역 자정이 3시간 정배수가 아니면 1시간. 30·45분 오프셋은 1시간도 맞지 않아 남은 어긋남(30·45분)이 있다 — 15분 칸은 15분 표 보관(env)에 달려 쓰지 않는다.
 */
export function idleBucketMs(offsetMin = DAY_OFFSET_MIN) {
  const offMs = (((Number(offsetMin) || 0) * 60_000) % DAY_MS + DAY_MS) % DAY_MS;
  for (const bm of [3 * HOUR, HOUR]) if (offMs % bm === 0) return bm;
  return HOUR;
}

/** 유휴 판정 창 — 오늘(지역)을 포함한 지난 IDLE_DAYS 일, 지역 자정부터. 라우트는 이 창을 `points = (until − since) / bucketMs` 로 조회한다. */
export function idleWindow(now = Date.now(), offsetMin = DAY_OFFSET_MIN) {
  const since = dayStartOf(now, offsetMin) - (IDLE_DAYS - 1) * DAY_MS;
  return { since, until: since + IDLE_DAYS * DAY_MS, bucketMs: idleBucketMs(offsetMin) };
}

/**
 * 유휴 창 조회 결과 → 포트별 지역 하루 칸 { avg[IDLE_DAYS], peak[IDLE_DAYS] }(idleOf 의 daily30).
 * 칸 폭은 **응답의 bucketMs**(없으면 요청 폭)로 읽는다 — 요청과 다른 폭이 와도 칸을 어긋나게 놓지 않게. 미래 칸은 denseByPort 가 비운다.
 */
export function idleDailyOf(res, { since, until, bucketMs, now = Date.now() }) {
  const bm = Number(res?.bucketMs) > 0 ? Number(res.bucketMs) : bucketMs;
  const out = new Map();
  if (!(bm > 0)) return out;
  const dayCount = Math.round((until - since) / DAY_MS);
  const perDay = Math.max(1, Math.round(DAY_MS / bm));
  const dense = denseByPort(res, { since, bucketMs: bm, n: dayCount * perDay, now });
  for (const [port, s] of dense) {
    const days = hoursToDays(s.avg, s.peak, dayCount, perDay);
    out.set(port, { avg: days.map((c) => (c ? c[0] : null)), peak: days.map((c) => (c ? c[1] : null)), name: s.name, speed: s.speed });
  }
  return out;
}

/**
 * v2.785(GI I-B4): 조회 결과를 조밀 배열로 놓을 틀 — 칸 폭은 **응답의 bucketMs**(perfDb.rangeOf 가 15분 표 보관(SANSW_PERF_ROLLUP_15M_DAYS)·
 * 집계 표 정배수로 고른 실제 폭), 빈 응답(0)이면 요청 폭. 라우트가 15분·96칸으로 단정하면 15분 표가 없는 날은 1시간 칸이 와서 96칸 중 72칸이 비었다.
 */
export function seriesFrame(res, { since, end, wantMs }) {
  const bm = Number(res?.bucketMs) > 0 ? Number(res.bucketMs) : wantMs;
  return { since, bucketMs: bm, n: Math.max(0, Math.round((end - since) / bm)) };
}

/**
 * v2.782(점검 K3 I-I2): 조립의 바탕(순수) — 전 포트 1시간 칸·히트맵 A 행·스토리지 합. 대상 고르기와 최종 조립이 같은 것을 쓴다.
 * 라우트는 이것을 한 번 만들어 대상 포트를 고르고(usageTargetMembers), 같은 바탕을 buildPortUsage({ base }) 에 넘긴다 —
 * 전에는 대상 고르기용으로 buildPortUsage 를 한 번 더 돌려 큰 디렉터·1달에서 같은 동기 구간이 두 번 들어갔다.
 */
export function usageBase({ period, ports, hist, histSince, now = Date.now() }) {
  const histDays = Math.round((period.end - histSince) / DAY_MS);
  const H = denseByPort(hist, { since: histSince, bucketMs: HOUR, n: histDays * 24, now });
  const periodDays = period.days.length;
  const dayFrom = histDays - periodDays;               // hist 안에서 기간이 시작하는 날
  const isD = period.unit === 'd';
  const cellsOf = (pt) => {
    const s = H.get(pt);
    if (!s) return new Array(isD ? 24 : periodDays).fill(null);
    if (isD) return hourCells(s.avg, s.peak, dayFrom * 24, 24);
    return hoursToDays(s.avg.slice(dayFrom * 24), s.peak.slice(dayFrom * 24), periodDays);
  };
  const portCells = new Map(ports.map((p) => [p.port, cellsOf(p.port)]));
  const groups = storageGroups(ports);
  const portOf = new Map(ports.map((p) => [p.port, p]));
  const groupOfPort = new Map();
  for (const g of groups) for (const m of g.members) groupOfPort.set(m, g.key);
  const capSum = (members) => { let s = 0; for (const m of members) { const c = capBpsOf(portOf.get(m)?.speed); if (c == null) return null; s += c; } return s; };

  // 히트맵 A 행
  const portRows = ports.map((p) => ({ kind: 'port', key: `p:${p.port}`, port: p.port, slotPort: p.slotPort, name: p.name, speed: p.speed,
    state: p.state, capBps: capBpsOf(p.speed), storage: groupOfPort.get(p.port) || null, cells: portCells.get(p.port) }));
  const storageRows = groups.map((g) => {
    const { cells, partial } = sumCells(g.members.map((m) => portCells.get(m)));
    return { kind: 'storage', key: `s:${g.key}`, storage: g.key, name: g.key, members: g.members, capBps: capSum(g.members), cells, partial };
  });
  const pAvg = (pt) => meanOf((portCells.get(pt) || []).map((c) => (c ? c[0] : null)));
  return { period, ports, hist, histSince, now, histDays, H, periodDays, dayFrom, isD, portCells, groups, portOf, portRows, storageRows, pAvg };
}

/** 대상 고르기 — 요청 대상이 없거나 모르면 평균이 가장 큰 포트(스토리지 묶음). */
function chooseTarget(base, { view = 'port', target = null } = {}) {
  const { portRows, storageRows, pAvg } = base;
  let tgt = null;
  if (view === 'storage') {
    const want = target == null ? null : String(target);
    tgt = storageRows.find((r) => r.storage === want) || null;
    if (!tgt && storageRows.length) tgt = [...storageRows].sort((a, b) => (meanOf(b.cells.map((c) => (c ? c[0] : null))) ?? -1) - (meanOf(a.cells.map((c) => (c ? c[0] : null))) ?? -1))[0];
  } else {
    const want = Number(target);
    tgt = portRows.find((r) => target != null && target !== '' && r.port === want) || null;
    if (!tgt && portRows.length) tgt = [...portRows].sort((a, b) => (pAvg(b.port) ?? -1) - (pAvg(a.port) ?? -1))[0];
  }
  return tgt;
}

/** 대상의 멤버 포트(라우트가 대상 포트만 15분·앞 기간을 조회할 때). buildPortUsage 의 target.members 와 같다. */
export function usageTargetMembers(base, { view = 'port', target = null } = {}) {
  const tgt = chooseTarget(base, { view, target });
  return tgt ? (tgt.kind === 'storage' ? tgt.members : [tgt.port]) : [];
}

/**
 * 화면 응답 조립(순수).
 * @param period   periodOf 결과
 * @param ports    portList 결과
 * @param hist     1시간 칸 portSeries — d: 고른 날로 끝나는 7일, w·m: 그 기간. histSince 가 시작.
 * @param chart    d 의 15분 차트 portSeries(대상 포트만) — 없으면(15분 보관이 지난 날) hist 의 마지막 날을 쓴다
 * @param prev     이전 기간 차트(대상 포트만, 선택) — { res, since, bucketMs, n }
 * @param daily30  지난 30일 지역 하루 칸(idleDailyOf 결과 — 유휴 판정, 선택)
 * @param view     'port' | 'storage'
 * @param target   포트 번호(view=port) 또는 스토리지 키(view=storage) — 없거나 모르면 기본값을 고른다
 * @param base     usageBase 결과(선택) — 같은 period·ports·hist·histSince·now 로 만든 것만 쓰고, 아니면 새로 만든다
 */
export function buildPortUsage({ period, ports, hist, histSince, chart = null, prev = null, daily30 = null, view = 'port', target = null, now = Date.now(), base = null }) {
  const B = base && base.period === period && base.ports === ports && base.hist === hist && base.histSince === histSince && base.now === now
    ? base : usageBase({ period, ports, hist, histSince, now });
  const { histDays, H, periodDays, dayFrom, isD, groups, portOf, portRows, storageRows, pAvg } = B;

  // 대상 고르기
  const tgt = chooseTarget(B, { view, target });
  const members = tgt ? (tgt.kind === 'storage' ? tgt.members : [tgt.port]) : [];

  // 차트(대상) — d: 15분(가능하면), w·m: 1시간
  let ch = null;
  if (tgt) {
    let since, bucketMs, list;
    if (isD && chart?.res) {
      ({ since, bucketMs } = chart);
      const C = denseByPort(chart.res, { since, bucketMs, n: chart.n, now });
      list = members.map((m) => C.get(m) || { avg: new Array(chart.n).fill(null), peak: new Array(chart.n).fill(null) });
    } else {
      since = period.start; bucketMs = HOUR;
      const n = periodDays * 24;
      list = members.map((m) => { const s = H.get(m); return s ? { avg: s.avg.slice(dayFrom * 24), peak: s.peak.slice(dayFrom * 24) } : { avg: new Array(n).fill(null), peak: new Array(n).fill(null) }; });
    }
    const a = sumSeries(list.map((x) => x.avg)), p = sumSeries(list.map((x) => x.peak));
    const pk = maxAt(p.values);
    ch = { since, bucketMs, avg: a.values, peak: p.values, partial: a.partial,
      avgMean: meanOf(a.values), peakMax: pk.max, peakAt: pk.at >= 0 ? since + pk.at * bucketMs : null };
    if (prev?.res) {
      const P = denseByPort(prev.res, { since: prev.since, bucketMs: prev.bucketMs, n: prev.n, now });
      const pl = members.map((m) => P.get(m) || { avg: new Array(prev.n).fill(null), peak: new Array(prev.n).fill(null) });
      const pa = sumSeries(pl.map((x) => x.avg)), pp = sumSeries(pl.map((x) => x.peak));
      ch.prev = { since: prev.since, bucketMs: prev.bucketMs, avg: pa.values, peak: pp.values, avgMean: meanOf(pa.values), peakMax: maxAt(pp.values).max };
      // v2.782(점검 K3 I-B2): 진행 중 기간(오늘·이번 7일·이번 달)의 현재 쪽은 '지금까지' 의 칸뿐이다(denseByPort 가 미래 칸을 비운다).
      //   앞 기간 전체와 견주면 매일 같은 트래픽도 평균 −77%·피크 −90% 로 보였다 — 앞 기간 KPI 도 **같은 경과 구간**만 잘라 낸다.
      //   기준은 겹쳐 그리기(usageChartRows)와 같은 '기간 시작부터의 경과 시간' — 앞 칸 j ≤ floor(경과/앞 칸 폭)
      //   (15분↔1시간 칸·달 길이 차이를 함께 처리 — 앞 달이 더 짧으면 앞 달 전체까지). 겹쳐 그리는 선(avg·peak)은 앞 기간 전체 그대로.
      if (period.current) {
        const elapsedMs = Math.max(0, now - period.start);
        const cut = Math.min(pa.values.length, Math.floor(elapsedMs / prev.bucketMs) + 1);
        Object.assign(ch.prev, { avgMean: meanOf(pa.values.slice(0, cut)), peakMax: maxAt(pp.values.slice(0, cut)).max,
          sameElapsed: true, elapsedMs, cmpEnd: prev.since + cut * prev.bucketMs });
      }
    }
  }

  // 히트맵 B(대상의 날짜 × 시간) — d: 고른 날 포함 지난 7일, w·m: 그 기간
  let histB = null;
  if (tgt) {
    const bDays = isD ? Math.min(7, histDays) : periodDays;
    const from = histDays - bDays;
    const rows = [];
    for (let d = from; d < histDays; d++) {
      const mc = members.map((m) => { const s = H.get(m); return s ? hourCells(s.avg, s.peak, d * 24, 24) : new Array(24).fill(null); });
      rows.push({ day: histSince + d * DAY_MS, cells: members.length === 1 ? mc[0] : sumCells(mc).cells });
    }
    histB = { rows };
  }

  // 스토리지 멤버 몫·편중
  const imbalance = [];
  const memberShare = (g) => {
    const avgs = g.members.map((m) => ({ port: m, avg: pAvg(m) }));
    const known = avgs.filter((x) => x.avg != null);
    const total = known.reduce((s, x) => s + x.avg, 0);
    const mean = known.length ? total / known.length : null;
    return avgs.map((x) => {
      const skewed = mean != null && mean >= IMBALANCE_MIN_BPS && x.avg != null && x.avg >= IMBALANCE_RATIO * mean;
      if (skewed) imbalance.push({ storage: g.key, port: x.port, ratio: Math.round((x.avg / mean) * 100) / 100 });
      return { port: x.port, slotPort: portOf.get(x.port)?.slotPort, name: portOf.get(x.port)?.name || '', speed: portOf.get(x.port)?.speed || '',
        avg: x.avg, share: x.avg != null && total > 0 ? Math.round((x.avg / total) * 1000) / 10 : null, skewed };
    });
  };
  let tgtMembers = null;
  for (const g of groups) { const s = memberShare(g); if (tgt?.kind === 'storage' && tgt.storage === g.key) tgtMembers = s; }

  return {
    unit: period.unit, off: period.off, minOff: period.minOff, label: period.label, short: period.short,
    start: period.start, end: period.end, days: period.days, current: period.current, now, offsetMin: DAY_OFFSET_MIN,
    colMs: isD ? HOUR : DAY_MS, cols: isD ? 24 : periodDays,
    view, rows: view === 'storage' ? storageRows.map((r) => ({ ...r, memberRows: r.members.map((m) => portRows.find((x) => x.port === m)).filter(Boolean) })) : portRows,
    storages: storageRows.map((r) => ({ key: r.storage, members: r.members })),
    target: tgt ? { kind: tgt.kind, key: tgt.key, port: tgt.port ?? null, storage: tgt.storage ?? null, name: tgt.name, slotPort: tgt.slotPort ?? null,
      speed: tgt.speed ?? null, state: tgt.state ?? null, capBps: tgt.capBps, members, memberRows: tgtMembers, chart: ch, histB } : null,
    imbalance, idle: daily30 ? idleOf(ports, daily30) : null,
    rules: { imbalanceMinBps: IMBALANCE_MIN_BPS, imbalanceRatio: IMBALANCE_RATIO },
  };
}

/** CSV 행(순수) — 지금 보기·단위·기간의 히트맵 A 칸. 빈 칸은 0 이 아니라 빈 값. */
export function usageCsvRows(r, { deviceName = '', offsetMin = DAY_OFFSET_MIN } = {}) {
  const head = ['스위치', '대상', '포트', '스토리지', '칸 시작', '칸', '평균(Gb/s)', '피크(Gb/s)', '피크 포화도(%)', '값 있는 시간'];
  const g = (v) => (v == null ? '' : Math.round((v * 8) / 1e7) / 100);
  const at = (t) => { const x = ymd(t, offsetMin); const h = new Date(t + offsetMin * 60_000).getUTCHours(); return `${x.y}-${pad(x.m)}-${pad(x.d)} ${pad(h)}:00`; };
  const out = [head];
  const push = (row, label, portText) => row.cells.forEach((c, i) => {
    const t = r.start + i * r.colMs;
    out.push([deviceName, label, portText, row.storage || '', at(t), r.colMs === HOUR ? '1시간' : '1일',
      c ? g(c[0]) : '', c && c[1] != null ? g(c[1]) : '', c && c[1] != null && row.capBps ? Math.round((c[1] / row.capBps) * 1000) / 10 : '', c ? c[2] : '']);
  });
  for (const row of r.rows) {
    if (row.kind === 'storage') {
      push(row, `${row.storage} 합계`, row.members.join(' '));
      for (const m of row.memberRows || []) push(m, m.name || `포트 ${m.port}`, String(m.port));
    } else push(row, row.name || `포트 ${row.port}`, String(row.port));
  }
  return out;
}
