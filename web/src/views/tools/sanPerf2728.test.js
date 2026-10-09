/**
 * v2.728(SAN 1·2차) — 법인 스토리지 사용량 창의 종류별 개수·표 상한·계산 시각 문구와 버킷 폭 표시가 서버 규칙과 같은지.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { kindCountOf, limitRows, PERF_TABLE_PAGE, perfComputedNote, perfBucketMsFor } from './sanSwitchPerfText.js';
import { snapBucketMs } from '../../../../server/src/sanswitch/perfRollup.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe('kindCountOf — 서버가 고른 종류만 보내도 개수는 전 종류 기준', () => {
  it('전체는 counts 의 합(받은 시리즈 길이가 아니다)', () => {
    const d = { counts: { array: 3, host: 120, unknown: 2 }, series: [{ endpointKind: 'array' }, { endpointKind: 'array' }, { endpointKind: 'array' }] };
    expect(kindCountOf(d, 'all')).toBe(125);
    expect(kindCountOf(d, 'host')).toBe(120);
    expect(kindCountOf(d, 'array')).toBe(3);
  });
  it('구버전 서버(counts 없음)는 받은 시리즈로 센다', () => {
    const d = { series: [{ endpointKind: 'array' }, { endpointKind: 'host' }, { endpointKind: 'host' }] };
    expect(kindCountOf(d, 'all')).toBe(3);
    expect(kindCountOf(d, 'host')).toBe(2);
  });
  it('없는 종류는 0, 데이터 없음은 null', () => {
    expect(kindCountOf({ counts: { array: 1 } }, 'host')).toBe(0);
    expect(kindCountOf(null, 'all')).toBeNull();
  });
});

describe('limitRows — 정렬한 뒤 자르고 뺀 개수를 밝힌다', () => {
  it('상한보다 많으면 앞에서 자르고 omitted 를 준다', () => {
    const list = Array.from({ length: 450 }, (_, i) => i);
    const r = limitRows(list, PERF_TABLE_PAGE);
    expect(r.rows.length).toBe(200);
    expect(r.rows[0]).toBe(0);
    expect(r.omitted).toBe(250);
  });
  it('상한 이하·이상한 상한이면 자르지 않는다', () => {
    expect(limitRows([1, 2], 200)).toEqual({ rows: [1, 2], omitted: 0 });
    expect(limitRows([1, 2, 3], 0).omitted).toBe(0);
    expect(limitRows(null, 5)).toEqual({ rows: [], omitted: 0 });
  });
});

describe('perfComputedNote — 계산 시각·기억 시간·출처', () => {
  const T = 1_790_000_000_000;
  it('계산 시각과 기억 시간, 집계 표 출처를 말한다', () => {
    const t = perfComputedNote({ computedAt: T - 42_000, cacheTtlMs: 300_000, source: { kind: 'rollup' } }, T);
    expect(t).toContain('42초 전 계산');
    expect(t).toContain('5분 동안');
    expect(t).toContain('집계 표');
  });
  it('원본·근사 머리를 구분한다', () => {
    expect(perfComputedNote({ computedAt: T, source: { kind: 'raw' } }, T)).toContain('원본 표본');
    expect(perfComputedNote({ computedAt: T, source: { kind: 'rollup', headApprox: true } }, T)).toContain('근사');
  });
  it('계산 시각이 없으면 null(구버전 서버 — 지어내지 않는다)', () => {
    expect(perfComputedNote({}, T)).toBeNull();
    expect(perfComputedNote({ computedAt: '1' }, T)).toBeNull();
    expect(perfComputedNote(null, T)).toBeNull();
  });
});

describe('perfBucketMsFor — 서버 snapBucketMs 와 같은 버킷 폭', () => {
  it('프리셋 기간마다 서버 규칙과 같다', () => {
    for (const h of [1, 6, 12, 24, 72, 24 * 7, 24 * 30, 24 * 31, 24 * 90, 24 * 366]) {
      const raw = Math.max(60_000, Math.round((h * 3600_000) / 120));
      const server = snapBucketMs(raw, { allow15: h <= 31 * 24 });
      expect(perfBucketMsFor(h), `${h}시간`).toBe(server);
    }
  });
  it('24시간 = 15분, 7일 = 2시간, 1시간 = 60초', () => {
    expect(perfBucketMsFor(24)).toBe(900_000);
    expect(perfBucketMsFor(24 * 7)).toBe(7_200_000);
    expect(perfBucketMsFor(1)).toBe(60_000);
  });
});

describe('화면 소스 — 취소·종류 전달·표 상한', () => {
  const src = fs.readFileSync(path.join(HERE, 'SanSwitchTool.jsx'), 'utf8');
  it('법인 스토리지 사용량은 kind 를 서버에 보내고 종류가 바뀌면 다시 받는다', () => {
    expect(src).toMatch(/kind: kind === 'all' \? '' : kind/);
    expect(src).toMatch(/\}, \[dcParam, hours, range, split, kind\]\);/);
  });
  it('사용량 조회는 이전 요청을 끊고 재시도하지 않는다', () => {
    const n = (src.match(/ac\.signal, \{ timeoutMs: 90_000, retries: 0 \}/g) || []).length;
    expect(n).toBeGreaterThanOrEqual(2);
    expect(src).not.toMatch(/let alive = true;\s*\n\s*setData\(null\); setError\(null\);\s*\n\s*fetchJson\('\/tools\/sanswitch\/perf\/storage-summary'/);
  });
  it('표는 limitRows 로 자르고 뺀 개수를 말한다', () => {
    expect(src).toMatch(/limitRows\(sorted, tableMax\)/);
    expect(src).toMatch(/tableLim\.omitted/);
  });
});
