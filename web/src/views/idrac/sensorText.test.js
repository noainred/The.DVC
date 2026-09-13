// v2.493 — iDRAC 센서 탭 문구 판정 회귀 고정.
// 핵심: '값이 없다' 를 '텔레메트리 미지원' 으로 단정하지 않는다(2026-09-12 사용자 신고 재발 방지).
import { describe, it, expect } from 'vitest';
import {
  cpuBadgeText, maxTempText, sampleCountText, emptyNote, latestTempRows, tempColorOf, fetchErrorNote,
  trendRows, trendEmptyReason, trendBaselineNote, trendDetailNote,
} from './sensorText.js';

const localWithData = {
  remote: false, seriesAvailable: true, cpuSynced: true, count: 42, intervalMs: 60000,
  samples: [{ t: 1, cpu: 12, temps: { 'CPU1 Temp': 52 } }],
  latest: { t: 1, cpu: 12, temps: { 'CPU1 Temp': 52, 'Inlet Temp': 21 }, fans: {} },
  sensors: ['CPU1 Temp', 'Inlet Temp'],
};
// 위임 서버: 중앙에 최신값만(법인별 온도가 쓰는 그 값), 이력·CPU 는 없음
const remote = {
  remote: true, seriesAvailable: false, cpuSynced: false, count: 0, samples: [], syncedAt: 1757000000000,
  latest: { t: 1757000000000, cpu: null, temps: { 'CPU1 Temp': 52, 'CPU2 Temp': 63 }, fans: {} },
  sensors: ['CPU1 Temp', 'CPU2 Temp'],
};

describe('CPU 배지 — 원인을 구분해 말한다', () => {
  it('값이 있으면 값', () => expect(cpuBadgeText(localWithData)).toBe('CPU 사용량 12%'));
  it('위임 수집은 미지원이 아니라 미동기화', () => {
    expect(cpuBadgeText(remote)).toBe('CPU 사용량 — (위임 수집: 중앙 미동기화)');
  });
  it('샘플이 아예 없으면 미지원이라 단정하지 않는다', () => {
    expect(cpuBadgeText({ seriesAvailable: true, cpuSynced: true, count: 0, samples: [], latest: null }))
      .toBe('CPU 사용량 — (샘플 없음)');
    expect(cpuBadgeText(null)).toBe('CPU 사용량 — (샘플 없음)');
  });
  it('표본은 있는데 CPU 값만 없을 때만 텔레메트리 미지원', () => {
    const s = { seriesAvailable: true, cpuSynced: true, count: 5, samples: [{}], latest: { t: 1, cpu: null, temps: { a: 30 } } };
    expect(cpuBadgeText(s)).toBe('CPU 사용량 — (텔레메트리 미지원)');
  });
});

describe('최고 온도·샘플 수', () => {
  it('최신 스냅샷에서 최대값', () => {
    expect(maxTempText(localWithData)).toBe('최고 온도 52℃');
    expect(maxTempText(remote)).toBe('최고 온도 63℃');
    expect(maxTempText({ latest: null })).toBe('최고 온도 —');
  });
  it('위임 서버는 동기화 시각을 밝히고 중앙 이력 없음을 말한다', () => {
    const t = sampleCountText(remote);
    expect(t).toContain('위임 수집');
    expect(t).toContain('중앙 이력 없음');
    expect(sampleCountText(localWithData)).toBe('1분 간격 · 최근 42샘플 · 30초마다 갱신');
  });
});

describe('안내 문구 — 같은 빈 화면이라도 할 일이 다르다', () => {
  it('정상 표시 중이면 안내 없음', () => expect(emptyNote(localWithData)).toBe(null));
  it('위임 + 최신값 있음: 현재값만 보이는 이유와 이력 위치를 안내', () => {
    expect(emptyNote(remote)).toContain('위임 법인(엣지)');
    expect(emptyNote(remote)).toContain('법인 포탈');
  });
  it('위임 + 최신값 없음: 엣지 수집 상태를 확인하라고 안내', () => {
    expect(emptyNote({ ...remote, latest: null })).toContain('엣지 포탈');
  });
  it('로컬 + 샘플 없음: 재시작으로 비는 성질을 함께 알린다', () => {
    const n = emptyNote({ seriesAvailable: true, samples: [], latest: null });
    expect(n).toContain('재시작');
  });
});

describe('현재값 표', () => {
  it('온도 높은 순으로 정렬하고 숫자만 남긴다', () => {
    expect(latestTempRows(remote)).toEqual([{ name: 'CPU2 Temp', celsius: 63 }, { name: 'CPU1 Temp', celsius: 52 }]);
    expect(latestTempRows({ latest: { temps: { a: null, b: 30 } } })).toEqual([{ name: 'b', celsius: 30 }]);
    expect(latestTempRows(null)).toEqual([]);
  });
  it('색 임계는 기존 규약과 같다(32/40)', () => {
    expect(tempColorOf(31)).toBe('var(--green)');
    expect(tempColorOf(32)).toBe('var(--amber)');
    expect(tempColorOf(40)).toBe('var(--red)');
    expect(tempColorOf(null)).toBe('var(--text-faint)');
  });
});

describe('수집 주기는 API 값을 쓴다(하드코딩 금지)', () => {
  it('intervalMs 를 분/초로 표기하고, 없으면 단정하지 않는다', () => {
    expect(sampleCountText({ seriesAvailable: true, count: 3, intervalMs: 300000 })).toContain('5분 간격');
    expect(sampleCountText({ seriesAvailable: true, count: 3, intervalMs: 30000 })).toContain('30초 간격');
    expect(sampleCountText({ seriesAvailable: true, count: 3 })).toContain('수집 주기 미확인');
  });
});

describe('조회 실패는 수집 0 과 구분한다', () => {
  it('실패 사유를 밝히고 수집 중단과 다름을 알린다', () => {
    const n = fetchErrorNote(new Error('not found'));
    expect(n).toContain('not found');
    expect(n).toContain('수집이 멈춘 것과는 다릅니다');
  });
  it('OME 소스는 별도 안내', () => {
    expect(fetchErrorNote(new Error('OME 소스는 센서 시계열을 지원하지 않습니다.'))).toContain('OME');
  });
  it('오류가 없으면 null', () => expect(fetchErrorNote(null)).toBe(null));
});

/* ── v2.504 온도 장기 추이 ─────────────────────────────────────────────────── */
describe('온도 추이 — 계열 합치기', () => {
  const hist = {
    enabled: true, detail: true,
    series: {
      max: [{ ts: 1000, avg: 38, max: 40 }, { ts: 2000, avg: 37, max: 39 }],
      inlet: [{ ts: 1000, avg: 18 }, { ts: 2000, avg: 19 }],
      cpu: [],                       // 빈 계열은 라인을 만들지 않는다
    },
  };
  it('같은 타임스탬프를 한 행으로 묶는다', () => {
    const { rows, kinds, points } = trendRows(hist, { fmt: (ts) => `t${ts}` });
    expect(points).toBe(2);
    expect(rows[0]).toMatchObject({ ts: 1000, t: 't1000', max: 38, inlet: 18 });
    expect(kinds.map((k) => k.key)).toEqual(['max', 'inlet']);
  });
  it('값이 없는 계열에 0 을 채우지 않는다(급냉으로 보인다)', () => {
    const { rows } = trendRows({ series: { max: [{ ts: 1, avg: 30 }], inlet: [{ ts: 2, avg: 18 }] } });
    expect(rows[0].inlet).toBeUndefined();
    expect(rows[1].max).toBeUndefined();
  });
  it('빈 입력에 안전', () => {
    expect(trendRows(null).points).toBe(0);
    expect(trendRows({}).rows).toEqual([]);
  });
});

describe('온도 추이 — 빈 화면의 사유를 구분한다', () => {
  it('조회 실패와 수집 0 은 다르다', () => {
    expect(trendEmptyReason({ error: 'DB 잠김' }).kind).toBe('error');
    expect(trendEmptyReason({ enabled: true, series: {} }).kind).toBe('empty');
  });
  it('기능이 꺼진 것은 고장이 아니다 — 켜는 방법을 알린다', () => {
    const r = trendEmptyReason({ enabled: false, series: {} });
    expect(r.kind).toBe('disabled');
    expect(r.text).toContain('IDRAC_TEMP_SERIES');
  });
  it('점이 1개면 선을 그리지 않는다(없는 추이를 지어내지 않는다)', () => {
    expect(trendEmptyReason({ enabled: true, series: { max: [{ ts: 1, avg: 30 }] } }).kind).toBe('short');
  });
  it('점이 2개 이상이면 그린다', () => {
    expect(trendEmptyReason({ enabled: true, series: { max: [{ ts: 1, avg: 30 }, { ts: 2, avg: 31 }] } })).toBe(null);
  });
  it('불러오는 중에는 사유를 띄우지 않는다(깜빡임 방지)', () => {
    expect(trendEmptyReason(null, { loading: true })).toBe(null);
  });
});

describe('온도 추이 — 기준선·상세 안내', () => {
  it('첫 관측이 요청 구간보다 늦으면 그 사실을 밝힌다', () => {
    const t = trendBaselineNote({ firstTs: Date.now() - 2 * 86_400_000 }, 30);
    expect(t).toContain('부터입니다');
  });
  it('구간 전체가 수집 이후면 안내하지 않는다(소음 방지)', () => {
    expect(trendBaselineNote({ firstTs: Date.now() - 60 * 86_400_000 }, 7)).toBe('');
    expect(trendBaselineNote({}, 7)).toBe('');
  });
  it('상세 적재가 꺼져 있으면 켜는 방법을 알린다', () => {
    expect(trendDetailNote({ detail: false })).toContain('IDRAC_TEMP_SERIES_DETAIL');
    expect(trendDetailNote({ detail: true })).toBe('');
  });
});
