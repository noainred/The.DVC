// version_4/data.js 회귀(v2.490) — 그리드 지도 마커 배치(아트보드 알고리즘)와 색 판정. node 환경(DOM 없음)에서 순수 함수만.
import { describe, it, expect } from 'vitest';
import { siteMarkers, barColor, textColor, tempCellColor, tempTextColor, alarmCountColor } from './data.js';

describe('siteMarkers', () => {
  it('좌표 없는 사이트는 제외하고 개수만 센다(추정 좌표 금지)', () => {
    const { markers, skipped } = siteMarkers([{ id: 'a', name: 'A', hosts: 10, lat: 37.5, lon: 127 }, { id: 'b', name: 'B', hosts: 5 }]);
    expect(markers).toHaveLength(1);
    expect(skipped).toBe(1);
  });
  it('경도→x% · 위도→y% · 호스트 수 비례 크기(14~30px)', () => {
    const { markers } = siteMarkers([{ id: 'a', name: 'A', hosts: 100, lat: 75, lon: -180, worst: 10 }, { id: 'b', name: 'B', hosts: 50, lat: -60, lon: 180, worst: 95 }]);
    const a = markers.find((m) => m.id === 'a'), b = markers.find((m) => m.id === 'b');
    expect(a.left).toBe('calc(0.00% + 0px)'); expect(a.top).toBe('0.00%'); expect(a.size).toBe(30);
    expect(b.left).toBe('calc(100.00% + 0px)'); expect(b.top).toBe('100.00%'); expect(b.size).toBe(22);
    expect(b.labelColor).toBe('#dc2626');   // 최대 사용률 ≥ 90
    expect(a.labelColor).toBe('#526075');
  });
  it('x 가 8% 안에 몰린 사이트는 클러스터로 묶어 22px 씩 벌린다', () => {
    const { markers } = siteMarkers([{ id: 'a', name: 'A', hosts: 1, lat: 0, lon: 0 }, { id: 'b', name: 'B', hosts: 1, lat: 0, lon: 1 }, { id: 'c', name: 'C', hosts: 1, lat: 0, lon: 90 }]);
    const dx = markers.map((m) => Number(/\+ (-?\d+)px/.exec(m.left)[1]));
    expect(dx).toEqual([-11, 11, 0]);
    expect(markers[0].labelTop).not.toBe(markers[1].labelTop); // 라벨 슬롯이 다르다
  });
  it('연결 안 된 vCenter 는 사용률과 무관하게 빨강', () => {
    const { markers } = siteMarkers([{ id: 'a', name: 'A', hosts: 1, lat: 0, lon: 0, worst: 5, status: 'disconnected' }]);
    expect(markers[0].fill).toBe('#dc2626cc');
    expect(markers[0].labelColor).toBe('#dc2626');
  });
});

describe('색 판정(아트보드 라이트 팔레트, 임계 75/90)', () => {
  it('barColor / textColor', () => {
    expect(barColor(10)).toBe('#16a34a'); expect(barColor(75)).toBe('#d97706'); expect(barColor(90)).toBe('#dc2626'); expect(barColor(null)).toBe('#9aa5b8');
    expect(textColor(10)).toBe('#15803d'); expect(textColor(80)).toBe('#b45309'); expect(textColor(95)).toBe('#dc2626'); expect(textColor(undefined)).toBe('#68738a');
  });
  it('온도 눈금 파랑 <22 · 회색 22–24 · 노랑 24–26 · 빨강 ≥26 · 미측정 null', () => {
    expect(tempCellColor(21)).toBe('#2563eb'); expect(tempCellColor(22)).toBe('#cdd5e0'); expect(tempCellColor(24)).toBe('#d97706'); expect(tempCellColor(26)).toBe('#dc2626'); expect(tempCellColor(null)).toBe(null);
    expect(tempTextColor(26)).toBe('#dc2626'); expect(tempTextColor(24.5)).toBe('#b45309'); expect(tempTextColor(20)).toBe('#526075'); expect(tempTextColor(null)).toBe('#68738a');
  });
  it('알람 수 색 ≥15 빨강 · ≥8 주황', () => {
    expect(alarmCountColor(15)).toBe('#dc2626'); expect(alarmCountColor(8)).toBe('#b45309'); expect(alarmCountColor(3)).toBe('#526075');
  });
});
