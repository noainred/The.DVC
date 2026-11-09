/**
 * sanStorage2951.test.js — v2.951 어레이 측(디렉터 · 노드 · SP) 패널의 순수 계산 · 문구.
 *  ① feValueText — 값 없음은 '—'(단위 없음) · 지표별 단위 · ② lineModel — 결측은 선을 끊고 외톨이 점은 점으로 · yMax 는 보기 좋은 값 · ③ feMetricsPresent — 값 있는 지표만
 *  ④ 소스 규약 — 패널은 usePolling 데이터(data.arraySide)만 쓰고 자기 폴러 · 날 <table> 이 없다 · 기준 설정 모달의 슬라이더는 숫자 칸과 같은 상태를 쓴다
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as T from './sanStorageText.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(HERE, rel), 'utf8');

describe('① feValueText', () => {
  it('값 없음은 — · 지표별 단위', () => {
    expect(T.feValueText('busy', null)).toBe('—'); expect(T.feValueText('iops', '')).toBe('—'); expect(T.feValueText('lat', 'x')).toBe('—');
    expect(T.feValueText('busy', 77)).toBe('77.0%'); expect(T.feValueText('iops', 30000.4)).toBe('30,000 IO/s'); expect(T.feValueText('lat', 2.56)).toBe('2.6 ms');
    expect(T.feValueText('hbps', 1e9 / 8)).toBe('1.0 Gb/s'); expect(T.FE_UNIT_TEXT.hbps).toBe('Gb/s');
  });
});

describe('② lineModel', () => {
  it('결측은 선을 끊고 외톨이 점은 점 · yMax 는 보기 좋은 값', () => {
    const cols = [0, 1, 2, 3, 4].map((i) => 1_000 + i * 60_000);
    const m = T.lineModel(cols, [{ key: 'a', label: 'A', color: 'c', values: [10, 20, null, 30, null] }, { key: 'b', label: 'B', color: 'd', values: [null, 70, 60, 50, 40] }], { w: 400, h: 100 });
    expect(m.yMax).toBe(100); expect(m.n).toBe(5);
    expect(m.lines[0].d.split('M').length - 1).toBe(2);           // 두 조각(10,20) · (30)
    expect(m.lines[0].points.length).toBe(1);                      // 외톨이 점 하나
    expect(m.lines[1].d.split('M').length - 1).toBe(1); expect(m.lines[1].points.length).toBe(0);
    expect(m.y(0)).toBeGreaterThan(m.y(100));
    expect(T.lineModel([], []).lines).toEqual([]);
  });
});

describe('③ feMetricsPresent', () => {
  it('값 있는 지표만 · 시계열에만 있어도 포함', () => {
    const side = { metrics: [{ k: 'busy' }, { k: 'cpu' }, { k: 'iops' }], units: [{ id: 1, latest: { busy: 10, cpu: null, iops: null } }], series: { byUnit: { 1: { iops: [null, 5] } } } };
    expect(T.feMetricsPresent(side).map((m) => m.k)).toEqual(['busy', 'iops']);
    expect(T.feMetricsPresent(null)).toEqual([]);
  });
});

describe('④ 소스 규약', () => {
  it('패널 · 슬라이더', () => {
    const tool = read('./SanStorageTool.jsx');
    expect(tool).toMatch(/<ArraySidePanel side=\{data\.arraySide\} \/>/);
    expect(tool).not.toMatch(/\bsetInterval\(/); expect(tool).not.toMatch(/<table[\s>]/);
    expect(tool).toMatch(/href="#\/tools\/storage-mon"/);                              // 미해결 알람 → 스토리지 모니터링(I)
    const check = read('./SanStorageCheck.jsx');
    expect(check).toMatch(/<input type="range" className="sst-range"[^>]*onChange=\{\(e\) => setVals\(\(p\) => \(\{ \.\.\.p, \[it\.k\]: e\.target\.value \}\)\)\}/);
    expect(check).toMatch(/어레이 측 값<\/b>/);
  });
});
