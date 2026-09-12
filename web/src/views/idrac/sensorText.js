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

/** 수집 주기·샘플 수 안내. 위임 서버는 '중앙 보유 이력 없음' 을 밝힌다. */
export function sampleCountText(sensors) {
  if (sensors && sensors.seriesAvailable === false) {
    const at = sensors.syncedAt ? new Date(sensors.syncedAt).toLocaleString('ko-KR') : '—';
    return `위임 수집(엣지) · 최신값 동기화 ${at} · 중앙 이력 없음`;
  }
  return `1분 간격 · 최근 ${sensors?.count || 0}샘플 · 30초마다 갱신`;
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
    return '아직 수집된 센서 샘플이 없습니다. 센서 시계열은 메모리에 보관되어 포탈 재시작 후 비므로, 첫 수집(1분 주기) 뒤에 표시됩니다.';
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

/** 온도 색(기존 tempColor 규약과 동일: 40℃↑ 빨강 · 32℃↑ 주황). */
export const tempColorOf = (c) => (c == null ? 'var(--text-faint)' : c >= 40 ? 'var(--red)' : c >= 32 ? 'var(--amber)' : 'var(--green)');
