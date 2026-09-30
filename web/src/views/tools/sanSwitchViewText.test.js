import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bpsText, intervalText, collectBadgeText, dayTB, trafficSummary, trafficChartRows, dcShare,
  sortSwitches, hotCount, rowMark, headStatus, lastCollectedAt } from './sanSwitchViewText.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sw = (name, usedPct, extra = {}) => ({ name, snap: usedPct === undefined ? { ok: false } : { ok: true, ports: { usedPct, licensed: 10, free: 10 - Math.round(usedPct / 10), ...extra } } });

describe('트래픽 문구 — 값이 없으면 0 이 아니라 —', () => {
  it('bpsText 는 바이트/초를 bps 로(×8)', () => {
    expect(bpsText(1_500_000_000)).toBe('12.0 Gbps');
    expect(bpsText(125_000)).toBe('1.0 Mbps');
    expect(bpsText(null)).toBe('—');
    expect(bpsText('')).toBe('—');
  });
  it('주기 문구는 서버 값으로 만든다', () => {
    expect(intervalText(300_000)).toBe('5분');
    expect(intervalText(90_000)).toBe('2분');
    expect(intervalText(3_600_000)).toBe('1시간');
    expect(intervalText(null)).toBe('');
    const now = 1_000_000_000_000;
    expect(collectBadgeText({ intervalMs: 300_000, lastSampleAt: now - 60_000, enabled: true }, now)).toBe('5분마다 수집 · 다음 약 4분');
    expect(collectBadgeText({ intervalMs: 300_000, lastSampleAt: now - 600_000, enabled: true }, now)).toBe('5분마다 수집');
    expect(collectBadgeText({ intervalMs: 300_000, enabled: false }, now)).toBe('수집 꺼짐');
  });
  it('하루 환산 TB = 평균 바이트/초 × 86400 / 1e12', () => {
    expect(dayTB(1e9)).toBeCloseTo(86.4);
    expect(dayTB(null)).toBeNull();
  });
  it('꺼짐·DB 불가·값 없음을 각각 다르게 말한다', () => {
    expect(trafficSummary({ enabled: false, intervalMs: 300_000 }).state).toBe('off');
    expect(trafficSummary({ enabled: false, intervalMs: 300_000 }).sub).toContain('5분마다 합산');
    expect(trafficSummary({ enabled: true, unavailable: true }).state).toBe('unavailable');
    const e = trafficSummary({ enabled: true, now: null, arrays: 2, datacenters: 3, hours: 24 });
    expect(e.state).toBe('empty');
    expect(e.now).toBe('—');
    expect(e.sub).toContain('0 이라는 뜻이 아닙니다');
  });
  it('정상 문장 — 평균 대비·최고·하루 환산 · 선택 법인 · 엣지 미반영 부기', () => {
    const d = { enabled: true, hours: 24, datacenters: 13, arrays: 4, now: { ts: 0, bps: 1.2e9 }, avg: 1e9, peak: { ts: 0, bps: 2e9 }, edgeMissing: 2 };
    const s = trafficSummary(d);
    expect(s.state).toBe('ok');
    expect(s.lead).toContain('전체 13개 법인');
    expect(s.now).toBe('9.6 Gbps');
    expect(s.sub).toContain('24시간 평균 8.0 Gbps보다 20% 높고');
    expect(s.sub).toContain('16.0 Gbps였습니다');
    expect(s.sub).toContain('약 86 TB');
    expect(s.notes.join(' ')).toContain('엣지 수집 스위치 2대');
    expect(trafficSummary(d, { selected: 2 }).lead).toContain('선택한 2개 법인');
    expect(trafficSummary({ ...d, now: { ts: 0, bps: 0.8e9 } }).sub).toContain('20% 낮고');
  });
  it('차트 행은 null 을 null 로 둔다(선을 끊는다)', () => {
    expect(trafficChartRows({ buckets: [1, 2], total: [125_000_000, null] })).toEqual([{ ts: 1, gbps: 1 }, { ts: 2, gbps: null }]);
  });
  it('법인별 비중 상위 5 + 나머지 개수', () => {
    const by = Array.from({ length: 7 }, (_, i) => ({ datacenterId: `d${i}`, name: `D${i}`, bps: 10 }));
    const r = dcShare({ byDatacenter: by });
    expect(r.rows).toHaveLength(5);
    expect(r.rows[0].pct).toBe(14);
    expect(r.omitted).toBe(2);
  });
});

describe('스위치 목록 정렬 — 모르는 값은 뒤로', () => {
  const rows = [sw('b', 50), sw('a', 95), sw('c'), sw('d', 80)];
  it('사용률 높은 순(기본) · 여유 적은 순 · 이름순', () => {
    expect(sortSwitches(rows).map((r) => r.name)).toEqual(['a', 'd', 'b', 'c']);
    expect(sortSwitches(rows, 'free').map((r) => r.name)).toEqual(['a', 'd', 'b', 'c']);
    expect(sortSwitches(rows, 'name').map((r) => r.name)).toEqual(['a', 'b', 'c', 'd']);
  });
  it('여유 부족(75%↑) 개수와 행 표지', () => {
    expect(hotCount(rows)).toBe(2);
    expect(rowMark(rows[1])).toBe('var(--red)');
    expect(rowMark(rows[3])).toBe('var(--amber)');
    expect(rowMark(rows[0])).toBeNull();
    expect(rowMark(rows[2])).toBeNull();
  });
  it('머리 상태 줄 — 실패가 있으면 초록 점이 아니다', () => {
    expect(headStatus([], 0).text).toContain('없습니다');
    const h = headStatus(rows, 3);
    expect(h.tone).toBe('warn');
    expect(h.text).toBe('3대 수집 정상 · 실패·미수집 1대 · 3개 법인');
    expect(headStatus([sw('x', 10)], 1).tone).toBe('ok');
    expect(lastCollectedAt([{ snap: { collectedAt: 5 } }, { snap: { collectedAt: 9 } }, { snap: {} }])).toBe(9);
  });
});

describe('화면 소스 규약', () => {
  const src = fs.readFileSync(path.join(HERE, 'SanSwitchV2Parts.jsx'), 'utf8') + fs.readFileSync(path.join(HERE, 'sanSwitchViewText.js'), 'utf8');
  it('트래픽 선은 null 을 잇지 않는다', () => { expect(src).toContain('connectNulls={false}'); });
  it('주기 숫자를 문구에 박지 않는다(5분마다)', () => { expect(src).not.toMatch(/['`"]5분마다/); });
  it('문구에 백틱 표기를 쓰지 않는다', () => { expect(/[가-힣][^\n]*\\`/.test(src)).toBe(false); });
});
