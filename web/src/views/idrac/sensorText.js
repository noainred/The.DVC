/**
 * sensorText.js — iDRAC 상세 모달 '센서' 탭의 **정직한 문구 판정**(v2.493, 순수 모듈).
 *
 * 배경(2026-09-12 사용자 신고): 위임 법인(엣지 등록) 서버 LESVMDVCPZB01 이 '법인별 온도' 화면에서는
 * CPU1 Temp 52℃ 로 정상 표시되는데, 상세 모달에서는 '온도 센서 0개 · 최근 0샘플 ·
 * CPU 사용량 — (텔레메트리 미지원)' 으로 보여 **수집이 멈춘 것처럼 오해**됐다. 원인은 두 가지였다:
 *   1) 서버가 위임 서버에 빈 응답(latest:null)을 돌려줬다(v2.493 에서 최신 스냅샷을 싣도록 수정).
 *   2) 화면이 '값이 없다' 를 **'텔레메트리 미지원'** 이라고 단정했다 — 검증하지 않은 원인 단정.
 *
 * 그래서 값이 없는 이유를 네 가지로 구분해 문구를 만든다. 웹 테스트는 node 환경이라 컴포넌트
 * 렌더 테스트가 불가하므로(이 저장소 관례) 판정과 문구를 여기에 두고 vitest 로 고정한다.
 */
import { TEMP_WARN_C, TEMP_HOT_C } from '../tools/serverTemp/board.js';

/** CPU 사용량 배지 문구. 값이 있으면 값, 없으면 '왜 없는지' 를 근거대로. */
export function cpuBadgeText(sensors) {
  const latest = sensors?.latest;
  if (latest && typeof latest.cpu === 'number') return `CPU 사용량 ${latest.cpu}%`;
  // 위임 수집: 엣지가 CPU 사용량을 중앙으로 보내지 않는다(미지원이 아니라 미동기화).
  if (sensors && sensors.cpuSynced === false) return 'CPU 사용량 — (위임 수집: 중앙 미동기화)';
  if (!sensors || !latest) return 'CPU 사용량 — (샘플 없음)';
  // 표본은 있는데 CPU 값만 없다 = Dell 텔레메트리(SystemUsage) 미노출. 이때만 '미지원' 이라 말한다.
  return 'CPU 사용량 — (텔레메트리 미지원)';
}

/** 최고 온도 배지 문구. */
export function maxTempText(sensors) {
  const t = Object.values(sensors?.latest?.temps || {}).filter((x) => typeof x === 'number');
  return t.length ? `최고 온도 ${Math.max(...t)}℃` : '최고 온도 —';
}

/**
 * 수집 주기·샘플 수 안내. 위임 서버는 '중앙 보유 이력 없음' 을 밝힌다.
 * 주기는 **API 가 알려주는 실제 값**(intervalMs, 기본 60초·설정 가능)을 쓴다 — 예전에는 '1분 간격'
 * 이 화면에 하드코딩돼 있어 주기를 바꾸면 문구가 사실과 달라졌다.
 */
/** 주기 표기(v2.595 — 두 문구가 같은 값을 쓰게 헬퍼로). 값이 없으면 null. */
export function intervalText(intervalMs, suffix = '') {
  const ms = Number(intervalMs);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const base = ms % 60_000 === 0 ? `${ms / 60_000}분` : `${Math.round(ms / 1000)}초`;
  return suffix ? `${base} ${suffix}` : base;
}

export function sampleCountText(sensors) {
  if (sensors && sensors.seriesAvailable === false) {
    const at = sensors.syncedAt ? new Date(sensors.syncedAt).toLocaleString('ko-KR') : '—';
    return `위임 수집(엣지) · 최신값 동기화 ${at} · 중앙 이력 없음`;
  }
  const every = intervalText(sensors?.intervalMs, '간격') || '수집 주기 미확인';
  return `${every} · 최근 ${sensors?.count || 0}샘플 · 30초마다 갱신`;
}

/** 센서 조회가 실패한 경우의 안내 — '수집 0' 과 '조회 실패' 를 구분한다(둘은 할 일이 다르다). */
export function fetchErrorNote(err) {
  if (!err) return null;
  const m = String(err.message || err);
  if (/OME/.test(m)) return `이 항목은 OME(OpenManage) 소스입니다 — 센서 시계열을 제공하지 않습니다. (${m})`;
  return `센서 조회에 실패했습니다: ${m} — 수집이 멈춘 것과는 다릅니다(권한·대상 없음·서버 오류 확인).`;
}

/**
 * 차트 아래 안내 문구. null 이면 안내를 띄우지 않는다(정상적으로 그려진 상태).
 * 네 경우를 구분한다 — 같은 '빈 화면' 이라도 사용자가 할 일이 다르다.
 */
export function emptyNote(sensors) {
  if (!sensors) return '센서 정보를 불러오지 못했습니다.';
  if (sensors.seriesAvailable === false) {
    return sensors.latest
      ? '이 서버는 위임 법인(엣지)에서 수집합니다. 중앙에는 최신값만 동기화되어 현재값 표로 표시하고, 시간별 추이 차트는 해당 법인 포탈에서 볼 수 있습니다.'
      : '위임 법인(엣지)에서 아직 센서 값을 보내지 않았습니다. 엣지 포탈의 iDRAC 수집 상태를 확인하세요.';
  }
  if (!sensors.samples?.length) {
    // v2.595(감사 WT-05): 주기는 설정 가능하다(IDRAC_POLL_INTERVAL_MS) — '1분' 을 박지 않고 응답 값을 쓴다.
    const iv = intervalText(sensors.intervalMs);
    return `아직 수집된 센서 샘플이 없습니다. 센서 시계열은 메모리에 보관되어 포탈 재시작 후 비므로, 첫 수집(${iv ? `${iv} 주기` : '수집 주기 미확인'}) 뒤에 표시됩니다.`;
  }
  return null;
}

/** 현재값 표 행 — 최신 스냅샷의 센서명·℃(온도 높은 순). 차트가 없어도 값은 보여준다. */
export function latestTempRows(sensors) {
  const temps = sensors?.latest?.temps || {};
  return Object.entries(temps)
    .filter(([, c]) => typeof c === 'number')
    .map(([name, celsius]) => ({ name, celsius }))
    .sort((a, b) => b.celsius - a.celsius);
}

/**
 * 온도 색 — 임계는 `serverTemp/board.js` 가 소유한다(v2.556 규약). v2.613 WEB2613-12: 여기만 40/32 를 숫자로 적어
 * 두어 임계를 바꾸면 iDRAC 상세 모달만 옛 색이 됐다. `board.js` 는 import 0 인 순수 모듈이라 여기서 import 해도
 * 이 모듈의 vitest(node 환경)가 React 를 끌고 오지 않는다.
 */
export const tempColorOf = (c) => (c == null ? 'var(--text-faint)' : c >= TEMP_HOT_C ? 'var(--red)' : c >= TEMP_WARN_C ? 'var(--amber)' : 'var(--green)');

/* ── 온도 장기 추이(v2.504) ──────────────────────────────────────────────────
 * 사용자 요청: "idrac 에서 조사하는 온도를 차트로 보이게 해줘"(참고 화면은 '특수 기능 › ESXi 온도'
 * 의 `5년 추이`). 기간·집계 단위 조작을 그 화면과 똑같이 맞추고, 판정·문구는 여기 순수 함수에 둔다
 * (웹 테스트는 node 환경이라 컴포넌트 렌더 테스트가 불가 — 회귀는 여기서 고정한다).
 */

/** 기간 버튼(ESXi 온도 차트와 동일한 표). */
export const TREND_RANGES = [[1, '1일'], [7, '1주'], [30, '1달'], [365, '1년'], [1830, '5년']];
/** 집계 단위 버튼. */
export const TREND_BUCKETS = [['auto', '자동'], ['minute', '분'], ['hour', '시간'], ['day', '일']];

/** 계열(종류) → 화면 이름·색. `max` 는 항상 있고 나머지는 상세 적재를 켠 경우에만 온다. */
export const TREND_KINDS = [
  { key: 'max', label: '최고', color: '#f87171' },
  { key: 'cpu', label: 'CPU', color: '#fbbf24' },
  { key: 'exhaust', label: '배기', color: '#fb923c' },
  { key: 'inlet', label: '흡기', color: '#22d3ee' },
];

/**
 * 응답 → 차트에 넣을 행 배열(순수).
 *
 * 여러 계열의 타임스탬프를 한 행으로 합친다. 버킷이 같으면 ts 가 정확히 같으므로 Map 으로 묶는다.
 * **없는 값은 넣지 않는다**(undefined) — 0 으로 채우면 '급냉' 으로 보인다(roomTempSeries 와 같은 규약).
 *
 * @returns {{rows:Array, kinds:Array<{key,label,color}>, points:number}}
 */
export function trendRows(hist, { fmt = (ts) => String(ts) } = {}) {
  const series = hist?.series || {};
  const kinds = TREND_KINDS.filter((k) => Array.isArray(series[k.key]) && series[k.key].length);
  const byTs = new Map();
  for (const k of kinds) {
    for (const p of series[k.key]) {
      const ts = Number(p?.ts);
      if (!Number.isFinite(ts)) continue;
      let row = byTs.get(ts);
      if (!row) { row = { ts, t: fmt(ts) }; byTs.set(ts, row); }
      if (p.avg != null) row[k.key] = p.avg;
      if (p.max != null) row[`${k.key}_max`] = p.max;
    }
  }
  const rows = [...byTs.values()].sort((a, b) => a.ts - b.ts);
  return { rows, kinds, points: rows.length };
}

/**
 * 차트를 그릴 수 없을 때의 사유(순수). null 이면 그린다.
 * **원인을 단정하지 않는다** — v2.493 규칙: '조회 실패' 와 '수집 0' 과 '기능 비활성' 은 서로 다르다.
 */
export function trendEmptyReason(hist, { loading = false } = {}) {
  if (loading) return null;
  if (!hist) return { kind: 'none', text: '온도 추이를 아직 불러오지 않았습니다.' };
  if (hist.error) return { kind: 'error', text: `온도 추이를 불러오지 못했습니다: ${hist.error}` };
  if (hist.enabled === false) {
    return { kind: 'disabled', text: '서버별 온도 시계열 적재가 꺼져 있습니다(IDRAC_TEMP_SERIES=false). 켜면 다음 수집부터 쌓입니다.' };
  }
  const { points } = trendRows(hist);
  if (points === 0) {
    return { kind: 'empty', text: '이 기간에 저장된 온도 표본이 없습니다. 시계열은 수집 주기마다 쌓이므로, 기능을 켠 시점 이후부터 표시됩니다.' };
  }
  if (points === 1) {
    // 점 1개로 선을 그리면 '변화 없음' 처럼 보인다 — 없는 추이를 지어내지 않는다(v2.493 규칙).
    return { kind: 'short', text: '표본이 1개뿐이라 추이 선을 그릴 수 없습니다(표본이 2개 이상 쌓이면 표시됩니다).' };
  }
  return null;
}

/**
 * 기준선 안내 — 첫 관측 시각이 요청 구간보다 늦으면 그 사실을 밝힌다.
 * (추적 시작 이전 구간을 사용자가 '온도가 없었다' 로 오해하지 않게 한다.)
 */
export function trendBaselineNote(hist, days) {
  const first = Number(hist?.firstTs);
  if (!Number.isFinite(first) || first <= 0) return '';
  const since = Date.now() - Math.max(1, Number(days) || 1) * 86_400_000;
  if (first <= since) return '';
  return `이 서버의 온도 수집은 ${new Date(first).toLocaleString('ko-KR')} 부터입니다 — 그 이전 구간은 비어 있습니다.`;
}

/** 상세(흡기·배기·CPU) 계열이 꺼져 있을 때의 안내(켜는 방법을 함께 알린다). */
export function trendDetailNote(hist) {
  if (!hist || hist.detail !== false) return '';
  return '흡기·배기·CPU 를 따로 보려면 서버에서 IDRAC_TEMP_SERIES_DETAIL=true 로 상세 적재를 켜세요(저장 행 수가 약 4배가 됩니다).';
}
