/**
 * sanSwitchPorts.js — SAN 스위치 화면의 순수 판정 로직(v2.410).
 *
 * 웹 테스트가 node 환경(DOM 없음)이라 렌더는 검증할 수 없다. 그래서 **틀리면 운영자가 잘못된
 * 판단을 하게 되는 규칙**(광레벨 임계·에러 등급·포트 여유 판정)을 여기 순수 함수로 두고
 * 회귀로 고정한다(storageColumns.js·accessDeniedText.js 와 같은 패턴).
 */

/** 포트 상태 → 화면 표시(라벨·색). summarizePorts 의 분류와 1:1. */
export const STATE_LABEL = {
  online: { label: '사용중', tone: 'ok' },
  offline: { label: '비어있음', tone: 'muted' },
  disabled: { label: '비활성', tone: 'warn' },
  faulty: { label: '장애', tone: 'bad' },
  noLicense: { label: '라이선스 없음', tone: 'muted' },
  unknown: { label: '알수없음', tone: 'muted' },
};
export const stateLabel = (s) => STATE_LABEL[s]?.label || s || '—';
export const stateTone = (s) => STATE_LABEL[s]?.tone || 'muted';

/**
 * 광레벨(dBm) 건전성.
 *
 * 임계 근거: FC SFP(단파 850nm)의 일반적인 수신 감도는 대략 -10 ~ -14 dBm 이고, 벤더
 * 권장 운용 하한은 보통 -9 dBm 안팎이다. 값이 그 아래로 내려가면 CRC 에러가 따라 오르는
 * 것이 현장에서 흔한 패턴이라 **경고(-9) / 위험(-12)** 두 단계로 나눈다.
 * ⚠ 정직 표기: 정확한 임계는 SFP 모델·거리·케이블에 따라 다르다. 여기 값은 **일반 기준**이며
 *   장비 벤더 사양을 대체하지 않는다(화면 툴팁에도 그렇게 적는다).
 * 송신(Tx)이 -3 dBm 이하로 크게 떨어지면 SFP 노후/고장 신호로 본다.
 */
export const RX_WARN_DBM = -9;
export const RX_BAD_DBM = -12;

/**
 * 숫자 변환 — **null/undefined/빈 문자열은 null 로 남긴다**.
 * ⚠ `Number(null)` 은 0 이고 0 은 유한값이라, `Number.isFinite(Number(v))` 로 거르면
 *   '미수집'이 '0 dBm'(=완벽한 광레벨)으로 둔갑한다. 실제로 이 함수의 첫 구현이 그랬고
 *   회귀 테스트가 잡았다 — 미수집을 정상으로 칠하는 것은 이 화면에서 가장 위험한 오류다.
 */
export function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function opticalHealth(rxDbm, txDbm) {
  const rx = numOrNull(rxDbm);
  const tx = numOrNull(txDbm);
  if (rx == null && tx == null) return { level: 'none', why: '' };
  if (rx != null && rx <= RX_BAD_DBM) return { level: 'bad', why: `수신 ${rx} dBm — 일반 하한(${RX_BAD_DBM})보다 낮습니다. 케이블·SFP·접점을 점검하세요.` };
  if (rx != null && rx <= RX_WARN_DBM) return { level: 'warn', why: `수신 ${rx} dBm — 일반 권장 하한(${RX_WARN_DBM})에 근접합니다.` };
  if (tx != null && tx <= -7) return { level: 'warn', why: `송신 ${tx} dBm — SFP 출력이 낮습니다(노후 의심).` };
  return { level: 'ok', why: '' };
}

/**
 * 에러 카운터 등급. **누적값**이라 '값이 크다 = 지금 나쁘다'가 아니다(스위치를 껐다 켠 적이
 * 없으면 몇 년치가 쌓여 있다). 그래서 등급은 '0인가 / 있는가'를 먼저 보고, 규모로 강조만 한다.
 * 화면 툴팁에 '누적값이며 마지막 초기화 이후 합계'임을 반드시 적는다 — 안 그러면 오래된
 * 카운터를 현재 장애로 오해한다.
 */
export function errorLevel(port) {
  const crc = Number(port?.errCrc) || 0;
  const linkFail = Number(port?.errLinkFail) || 0;
  const lossSync = Number(port?.errLossSync) || 0;
  const encOut = Number(port?.errEncOut) || 0;
  const total = crc + linkFail + lossSync;
  if (total === 0 && encOut === 0) return { level: 'ok', total: 0 };
  if (crc >= 1000 || linkFail >= 100) return { level: 'bad', total };
  if (total > 0) return { level: 'warn', total };
  return { level: 'info', total };
}

/** 포트 사용률 → 색 등급. 여유 포트가 적을수록 증설 판단이 급해진다. */
export function capacityLevel(usedPct) {
  const p = Number(usedPct) || 0;
  if (p >= 90) return 'bad';
  if (p >= 75) return 'warn';
  return 'ok';
}

/** 여러 스위치 합산(법인 카드·상단 KPI). 실패 스냅샷은 포트 합계에서 제외한다. */
export function aggregate(rows = []) {
  const a = { switches: 0, ok: 0, failed: 0, total: 0, licensed: 0, online: 0, free: 0,
    faulty: 0, disabled: 0, alerts: 0, usedPct: 0 };
  for (const r of rows) {
    a.switches++;
    const s = r.snap;
    if (!s || !s.ok) { a.failed++; continue; }
    a.ok++;
    const p = s.ports || {};
    a.total += p.total || 0;
    a.licensed += p.licensed || 0;
    a.online += p.online || 0;
    a.free += p.free || 0;
    a.faulty += p.faulty || 0;
    a.disabled += p.disabled || 0;
    a.alerts += s.health?.alerts || 0;
  }
  a.usedPct = a.licensed ? Math.round((a.online / a.licensed) * 1000) / 10 : 0;
  return a;
}

/** 처리량 표기 — REST 는 bps, SSH 는 프레임/초. 단위를 섞어 보여주지 않는다. */
export function throughputText(port, unit) {
  if (unit === 'bps') {
    if (numOrNull(port?.inBps) == null && numOrNull(port?.outBps) == null) return '—';
    return `${bps(port.inBps)} / ${bps(port.outBps)}`;
  }
  if (numOrNull(port?.inFps) == null && numOrNull(port?.outFps) == null) return '—';
  return `${num(port.inFps)} / ${num(port.outFps)} f/s`;
}
const num = (n) => (numOrNull(n) == null ? '—' : Number(n).toLocaleString());
export function bps(v) {
  const n = numOrNull(v);   // null/'' 을 0 으로 보지 않는다(위 numOrNull 머리말 참조)
  if (n == null) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} Gbps`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} Mbps`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} Kbps`;
  return `${n} bps`;
}

/**
 * 연결 장비 이름 축약(v2.411 — 사용자 신고 '1줄에 길게 나와서 읽을 수 없음').
 *
 * 네임서버 심볼릭 이름은 장비 종류에 따라 극단적으로 길다. 실제 관측 예:
 *   SYMMETRIX::000497700230::SAF-1d 4::FC::5978_0714+::EMUL B90F0000 698529C0 EE8A28 03.18.24 09:33.
 * 이걸 그대로 그리면 표의 옆 칸(CRC 열)을 덮어 읽을 수 없게 된다.
 *
 * 축약 규칙: `::` 로 나뉜 이름은 **앞 세그먼트가 식별 정보**다(제품군 → 시리얼 → 디렉터 포트).
 * 뒤쪽은 펌웨어·에뮬레이션·타임스탬프라 포트 식별에 쓸모가 적다. 그래서 앞에서부터
 * max 자를 넘지 않는 만큼만 이어 붙이고(최소 1개는 항상 유지), 잘렸으면 '…' 를 붙인다.
 * `::` 가 없는 이름(예: HBA 의 'QLE2692 FW:v9.15.01 DVR:v5.4.84.0')은 단순 길이 절단.
 *
 * ⚠ 원문은 버리지 않는다 — 호출부가 title 툴팁으로 전문을 보여준다(잘린 뒤가 필요한 경우 대비).
 */
export function shortDeviceName(name, max = 44) {
  const s = String(name || '').trim();
  if (!s || s.length <= max) return s;
  if (s.includes('::')) {
    const seg = s.split('::');
    let out = seg[0];
    for (let i = 1; i < seg.length; i++) {
      const next = `${out}::${seg[i]}`;
      if (next.length > max) break;
      out = next;
    }
    return `${out}…`;
  }
  return `${s.slice(0, max - 1)}…`;
}

/**
 * 처리량 표기(바이트/초 → 사람이 읽는 값). portperfshow 원단위가 B/s 라 그대로 받는다.
 * 네트워크 관례상 회선 속도는 bps 로 말하므로 **bps 로 환산해 보여준다**(×8).
 */
export function bytesPerSecText(bytesPerSec) {
  const n = numOrNull(bytesPerSec);
  if (n == null) return '—';
  return bps(n * 8);
}

/**
 * 포트 포화도(순수) — 협상 속도 대비 사용률(%).
 * 왜 필요한가: '2 Gbps 사용'이 16G 포트에서는 여유롭고 4G 포트에서는 포화 직전이다. 절대값만
 * 보면 증설 판단을 못 한다. 속도를 모르면 **판정하지 않는다**(null) — 0% 로 칠하면 '한가하다'는
 * 반대 결론이 된다.
 */
export function saturationPct(bytesPerSec, speedLabel) {
  const n = numOrNull(bytesPerSec);
  const m = String(speedLabel || '').match(/^(\d+)G$/);
  if (n == null || !m) return null;
  const lineBps = Number(m[1]) * 1e9;
  return Math.round(((n * 8) / lineBps) * 1000) / 10;
}

/** 포화도 등급 — 표/차트 강조용. */
export function saturationLevel(pct) {
  if (pct == null) return 'none';
  if (pct >= 80) return 'bad';
  if (pct >= 50) return 'warn';
  return 'ok';
}

/**
 * 시계열 배열들을 recharts 가 먹는 행 배열로 변환(순수).
 * @param buckets  ts 배열
 * @param series   [{ key, values[] }]  values[i] 는 buckets[i] 시점 값(없으면 null)
 */
export function toChartRows(buckets = [], series = []) {
  return buckets.map((ts, i) => {
    const row = { ts };
    for (const s of series) row[s.key] = s.values[i] == null ? null : s.values[i];
    return row;
  });
}

/** 평균 사용량 상위 N개만 남긴다(포트 128개를 전부 그리면 차트가 읽히지 않는다). */
export function topSeries(series = [], n = 8) {
  const avg = (a) => { const v = a.filter((x) => x != null); return v.length ? v.reduce((x, y) => x + y, 0) / v.length : 0; };
  return [...series].sort((a, b) => avg(b.values) - avg(a.values)).slice(0, n);
}

/**
 * 포트 표 정렬(순수, v2.411 — 사용자 요구 '제목별로 소팅').
 *
 * 규칙: **값이 없는 행(null)은 방향과 무관하게 항상 뒤로 보낸다.** 내림차순 정렬에서 null 을
 * 0 으로 취급하면 뒤로 가지만, 오름차순에서는 맨 앞에 몰려 '가장 좋은 포트'처럼 보인다 —
 * 미수집을 최상위로 올리는 정렬은 이 화면에서 오독을 만든다.
 */
export const SORT_KEYS = {
  index: (p) => p.index,
  state: (p) => ['online', 'faulty', 'disabled', 'offline', 'noLicense'].indexOf(p.state),
  speed: (p) => { const m = String(p.speed || '').match(/^(\d+)G$/); return m ? Number(m[1]) : null; },
  portType: (p) => p.portType || null,
  attached: (p) => p.attachedName || (p.attached || [])[0] || null,
  err: (p) => {
    const v = [p.errCrc, p.errLinkFail, p.errLossSync].map(numOrNull);
    return v.every((x) => x == null) ? null : v.reduce((a, b) => a + (b || 0), 0);
  },
  optical: (p) => numOrNull(p.rxPowerDbm),
  temp: (p) => numOrNull(p.sfpTempC),
  throughput: (p) => {
    const b = numOrNull(p.inBps), o = numOrNull(p.outBps);
    if (b != null || o != null) return (b || 0) + (o || 0);
    const fi = numOrNull(p.inFps), fo = numOrNull(p.outFps);
    return fi == null && fo == null ? null : (fi || 0) + (fo || 0);
  },
};

export function sortPorts(list = [], key = 'index', dir = 'asc') {
  const get = SORT_KEYS[key] || SORT_KEYS.index;
  const sign = dir === 'desc' ? -1 : 1;
  return [...list].sort((a, b) => {
    const va = get(a); const vb = get(b);
    if (va == null && vb == null) return a.index - b.index;
    if (va == null) return 1;   // 값 없음은 항상 뒤로(방향 무관)
    if (vb == null) return -1;
    if (typeof va === 'string' || typeof vb === 'string') {
      const c = String(va).localeCompare(String(vb));
      return c !== 0 ? c * sign : a.index - b.index;
    }
    return va === vb ? a.index - b.index : (va - vb) * sign;
  });
}

/** 헤더 클릭 → 다음 정렬 상태(같은 열이면 방향 토글, 다른 열이면 그 열 오름차순). */
export function nextSort(cur, key) {
  if (cur.key !== key) return { key, dir: 'asc' };
  return { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' };
}

/**
 * 임의 표의 제목 정렬(순수, v2.412 — 사용자 요구 '타이틀별로 소팅').
 * sortPorts 와 **같은 규칙**을 쓴다: 값이 없는 행(null)은 정렬 방향과 무관하게 항상 뒤로.
 * 오름차순에서 null 이 맨 앞에 몰리면 '미수집'이 최상위 항목으로 읽히기 때문이다.
 *
 * @param get  행 → 정렬 값(숫자 또는 문자열, 없으면 null)
 * @param tie  동점일 때의 안정 정렬 키(선택) — 없으면 원래 순서를 유지하지 않는다
 */
export function sortRows(rows = [], get, dir = 'asc', tie = null) {
  const sign = dir === 'desc' ? -1 : 1;
  const tieOf = tie || (() => 0);
  return [...rows].sort((a, b) => {
    const va = get(a); const vb = get(b);
    if (va == null && vb == null) return String(tieOf(a)).localeCompare(String(tieOf(b)));
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === 'string' || typeof vb === 'string') {
      const c = String(va).localeCompare(String(vb));
      return c !== 0 ? c * sign : String(tieOf(a)).localeCompare(String(tieOf(b)));
    }
    return va === vb ? String(tieOf(a)).localeCompare(String(tieOf(b))) : (va - vb) * sign;
  });
}

/** 시계열 배열의 평균/최대(순수) — 분석 표의 정렬·표시가 같은 값을 쓰게 한 곳에 둔다. */
export function seriesStats(values = []) {
  const v = values.filter((x) => x != null);
  return {
    avg: v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0,
    max: v.length ? Math.max(...v) : 0,
  };
}

/** 포트 목록 필터(순수) — 화면의 '문제만 보기'가 무엇을 남기는지 한 곳에서 정의. */
export function filterPorts(list = [], mode = 'all') {
  if (mode === 'online') return list.filter((p) => p.state === 'online');
  if (mode === 'free') return list.filter((p) => p.state === 'offline');
  if (mode === 'problem') {
    return list.filter((p) => p.state === 'faulty' || p.state === 'disabled'
      || errorLevel(p).level === 'bad' || errorLevel(p).level === 'warn'
      || ['warn', 'bad'].includes(opticalHealth(p.rxPowerDbm, p.txPowerDbm).level));
  }
  return list;
}
