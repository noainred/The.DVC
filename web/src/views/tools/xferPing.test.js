/**
 * v2.890 전송 속도 상세 'Ping 함께 보기' — 순수 함수(xferSpeedText.js)의 좌표·문구·기억.
 * 시안 docs/design/xfer-ping · 서버 계약 server/test/xferPing2890.test.js.
 */
import { describe, it, expect } from 'vitest';
import {
  chartModel, pingModel, pingAt, pingLineText, comboHover, niceTop, msText, pingMethodText, pingHeadNote, pingStatChips,
  samePingWindow, loadView, saveView, viewOf, VIEW_MODES, DEFAULT_VIEW, VIEW_STORE_KEY, PING_REASON_TEXT,
} from './xferSpeedText.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// 정시에서 떨어진 고정 끝(테스트 규칙 — 경계 근처에 두지 않는다).
const END = Date.UTC(2026, 10, 4, 1, 36);
const START = END - DAY;
const BMS = 6 * MIN;

function pingResp(over = {}) {
  const series = [];
  for (let ts = Math.floor(START / BMS) * BMS; ts < END; ts += BMS) series.push({ ts, avg: 246, min: 240, max: 252, loss: 0, n: 6 });
  return {
    ok: true, agent: 'Edge-Seoul', days: 1, start: START, end: END, past: true, offsetMin: 540,
    method: 'tcp-connect', target: { id: 'edge_edge-seoul', kind: 'tcp', port: 443, enabled: true },
    intervalMs: MIN, bucketMs: BMS, source: 'raw', series,
    stats: { n: 1440, ok: 1436, fail: 4, lossPct: 0.28, avg: 251.3, median: 246.2, max: 592.1 }, last: null, reason: null, ...over,
  };
}
const hist = (over = {}) => ({
  agent: 'Edge-Seoul', days: 1, end: END, past: true, offsetMin: 540, source: 'raw',
  series: { down: [{ ts: START + 5 * MIN, ok: true, mbps: 2.25, bytes: 10_485_760, latMs: 484 }], up: [{ ts: START + 6 * MIN, ok: true, mbps: 8.82, bytes: 10_485_760, latMs: 263 }] },
  stats: { down: { median: 2.2 }, up: { median: 21.8 } }, ...over,
});

describe('보기 선택 — 기본은 전송 속도(지금 화면과 같다) · 기억은 편의', () => {
  it('세 가지 보기와 기본값', () => {
    expect(VIEW_MODES.map((v) => v.key)).toEqual(['speed', 'both', 'ping']);
    expect(DEFAULT_VIEW).toBe('speed');
    expect(viewOf('both')).toBe('both');
    expect(viewOf('garbage')).toBe('speed');
    expect(viewOf(null)).toBe('speed');
  });
  it('저장소가 없거나 던져도 기본값 — 보기는 바뀐다', () => {
    const mem = new Map();
    const st = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
    expect(loadView(st)).toBe('speed');
    saveView(st, 'ping');
    expect(mem.get(VIEW_STORE_KEY)).toBe('ping');
    expect(loadView(st)).toBe('ping');
    const bad = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(loadView(bad)).toBe('speed');
    expect(() => saveView(bad, 'both')).not.toThrow();
    expect(loadView(null)).toBe('speed');
  });
});

describe('문구 — 값이 없으면 단위 없는 대시 · 방식을 밝힌다', () => {
  it('msText', () => {
    expect(msText(null)).toBe('—');
    expect(msText('')).toBe('—');
    expect(msText(246.18)).toBe('246ms');
    expect(msText(4.26)).toBe('4.3ms');
    expect(msText(592.1, { unit: false })).toBe('592');
  });
  it('TCP 연결은 ICMP 라고 쓰지 않는다 · 주기·칸은 응답 값', () => {
    expect(pingMethodText(pingResp())).toBe('엣지 포탈 TCP 연결(443)');
    expect(pingMethodText(pingResp({ method: 'icmp' }))).toBe('ICMP');
    const note = pingHeadNote(pingResp());
    expect(note).toContain('TCP 연결(443)');
    expect(note).toContain('1분 간격');
    expect(note).toContain('6분 평균');
    expect(pingHeadNote(pingResp({ bucketMs: 3 * HOUR, source: 'hourly' }))).toContain('3시간 평균(시간 요약)');
  });
  it('통계 알약 — 중앙값 없음은 대시 + 이유 · 마지막은 지금 창만', () => {
    const c = pingStatChips(pingResp());
    expect(c.map((x) => x.label)).toEqual(['평균', '중앙값', '최고', '손실']);
    expect(c[3].value).toBe('0.28%');
    expect(c[3].sub).toBe('4/1,440');
    const h = pingStatChips(pingResp({ source: 'hourly', stats: { n: 0, fail: 0, lossPct: null, avg: null, median: null, max: null } }));
    expect(h.map((x) => x.value)).toEqual(['—', '—', '—', '—']);
    expect(h[1].title).toMatch(/시간 요약/);
    const live = pingStatChips(pingResp({ past: false, last: { ts: END - MIN, rtt: 244.1, ok: true } }));
    expect(live.at(-1)).toMatchObject({ label: '마지막', value: '244ms' });
    const down = pingStatChips(pingResp({ last: { ts: END - MIN, rtt: null, ok: false } }));
    expect(down.at(-1).value).toBe('응답 없음');
  });
  it('사유 문구는 백틱 없이 제목·설명', () => {
    for (const v of Object.values(PING_REASON_TEXT)) {
      expect(v.title).toBeTruthy();
      expect(v.body).toBeTruthy();
      expect(`${v.title}${v.body}`).not.toMatch(/`/);
    }
  });
});

describe('niceTop — 눈금 4칸이 깔끔한 수', () => {
  it('값', () => {
    expect(niceTop(592)).toBe(600);
    expect(niceTop(250)).toBe(400);
    expect(niceTop(48)).toBe(60);
    expect(niceTop(0)).toBe(100);
    expect(niceTop(null)).toBe(100);
  });
});

describe('pingModel — 속도 차트와 같은 x 축 · 결측은 끊는다', () => {
  const opts = { w: 1000, h: 170, padL: 52, padR: 12, from: START, to: END };
  it('칸 중심에 점 · 같은 from/to 면 x 가 속도 차트와 같다', () => {
    const pm = pingModel(pingResp(), opts);
    const m = chartModel(hist(), { w: 1000, h: 280, now: END });
    expect(pm.top).toBe(400);
    const mid = pm.pts[120];
    const expectX = m.padL + ((mid.c - m.from) / (m.to - m.from)) * (m.w - m.padL - m.padR);
    expect(mid.x).toBeCloseTo(expectX, 6);
    expect(pm.avgPath.startsWith('M')).toBe(true);
    expect(pm.bandPath).toContain('Z');
    expect(pm.medianY).not.toBeNull();
  });
  it('모두 실패한 칸·빠진 칸에서 선을 끊는다(0 으로 잇지 않는다) · 손실 눈금', () => {
    const p = pingResp();
    p.series[50] = { ...p.series[50], avg: null, min: null, max: null, loss: 1 };
    p.series.splice(100, 3);   // 칸 3개 빠짐(표본 없음)
    p.series[150] = { ...p.series[150], loss: 1 / 6 };
    const pm = pingModel(p, opts);
    expect(pm.avgPath.split('M').length - 1).toBe(3);
    expect(pm.avgPath).not.toMatch(/NaN/);
    expect(pm.lossMarks.length).toBe(2);
    expect(pm.lossMarks.find((l) => l.full)).toBeTruthy();
    expect(pm.pts.find((b) => b.avg == null).y).toBeNull();
    expect(pm.lossMarks.every((l) => l.w >= 2 && l.w <= 4)).toBe(true);
  });
  it('표본 간격이 칸보다 길어도(15분 표본 · 6분 칸) 선을 잇는다 — 칸 크기만 보면 점만 남았다', () => {
    const series = [];
    for (let ts = START; ts < END; ts += 15 * MIN) series.push({ ts: Math.floor(ts / BMS) * BMS, avg: 250, min: 250, max: 250, loss: 0, n: 1 });
    const pm = pingModel(pingResp({ series }), opts);
    expect(pm.avgPath.split('M').length - 1).toBe(1);
    expect(pm.singles.length).toBe(0);
    expect(pm.gapMs).toBeGreaterThan(15 * MIN);
    // 그래도 몇 시간 빈 구간은 끊는다
    const holed = series.filter((b) => b.ts < START + 6 * HOUR || b.ts > START + 9 * HOUR);
    expect(pingModel(pingResp({ series: holed }), opts).avgPath.split('M').length - 1).toBe(2);
  });
  it('단위는 맨 위 눈금에만(따로 그린 ms 가 숫자와 겹치지 않게)', () => {
    const pm = pingModel(pingResp(), opts);
    expect(pm.grid.at(-1).label).toBe('400ms');
    expect(pm.grid.slice(0, -1).every((g) => !g.label.includes('ms'))).toBe(true);
  });
  it('외톨이 칸은 점으로', () => {
    const p = pingResp({ series: [{ ts: START + HOUR, avg: 200, min: 190, max: 210, loss: 0, n: 6 }] });
    const pm = pingModel(p, opts);
    expect(pm.avgPath).toBe('');
    expect(pm.singles.length).toBe(1);
  });
  it('응답·축이 없으면 null', () => {
    expect(pingModel(null, opts)).toBeNull();
    expect(pingModel(pingResp(), { ...opts, from: null })).toBeNull();
  });
});

describe('마우스 오버 — 한 상자에 같은 시각의 ↓ · ↑ · Ping', () => {
  const m = chartModel(hist(), { w: 1000, h: 280, now: END });
  const pm = pingModel(pingResp(), { w: 1000, h: 170, padL: m.padL, padR: m.padR, from: m.from, to: m.to });
  it('전송 측정이 있는 시각 — 속도 줄 + 그 시각 Ping 칸', () => {
    const hv = comboHover(m, pm, m.pts.down[0].x, 540, 'both');
    expect(hv.lines.map((l) => l.dir)).toEqual(['down', 'up', 'ping']);
    expect(hv.lines[2].text).toBe('Ping 246ms 평균 · 240~252ms · 손실 0% (6회 중 0회)');
    expect(hv.pingDot).not.toBeNull();
  });
  it('전송 측정이 없는 시각 — 속도 줄은 측정 없음(0 아님) · Ping 칸 시각 범위', () => {
    const px = m.padL + 0.5 * (m.w - m.padL - m.padR);
    const hv = comboHover(m, pm, px, 540, 'both');
    expect(hv.lines[0].text).toBe('이 시각엔 전송 측정 없음');
    expect(hv.lines[0].ok).toBeNull();
    expect(hv.head).toMatch(/^\d{2}-\d{2} \d{2}:\d{2} ~ \d{2}:\d{2}$/);
  });
  it('Ping만 보기 — Ping 줄만', () => {
    const px = m.padL + 0.5 * (m.w - m.padL - m.padR);
    const hv = comboHover(m, pm, px, 540, 'ping');
    expect(hv.lines.map((l) => l.dir)).toEqual(['ping']);
  });
  it('전송 속도 보기 — 예전 hoverAt 그대로(Ping 줄 없음)', () => {
    const hv = comboHover(m, pm, m.pts.down[0].x, 540, 'speed');
    expect(hv.lines.map((l) => l.dir)).toEqual(['down', 'up']);
  });
  it('모두 실패한 칸 — 응답 없음', () => {
    expect(pingLineText({ avg: null, n: 6, loss: 1, fail: 6 })).toEqual({ text: 'Ping 응답 없음 · 6회 모두 실패', ok: false });
    expect(pingLineText(null).text).toBe('Ping —');
  });
  it('칸이 없던 구간은 고르지 않는다', () => {
    const p = pingResp({ series: [{ ts: START, avg: 100, min: 100, max: 100, loss: 0, n: 6 }] });
    const pm2 = pingModel(p, { w: 1000, h: 170, padL: m.padL, padR: m.padR, from: m.from, to: m.to });
    expect(pingAt(pm2, END - HOUR)).toBeNull();
  });
});

describe('samePingWindow — 다른 창의 Ping 을 지금 축에 그리지 않는다', () => {
  it('같은 법인·같은 기간·같은 과거 끝', () => {
    expect(samePingWindow(pingResp(), hist())).toBe(true);
    expect(samePingWindow(pingResp({ end: END - DAY }), hist())).toBe(false);
    expect(samePingWindow(pingResp({ days: 7 }), hist())).toBe(false);
    expect(samePingWindow(pingResp({ agent: 'Other' }), hist())).toBe(false);
    expect(samePingWindow(pingResp({ past: false, end: END + 5 }), hist({ past: false }))).toBe(true);
    expect(samePingWindow(null, hist())).toBe(false);
  });
});
