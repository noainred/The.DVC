/**
 * audit2682a — 3회차 점검 그룹 A 웹 회귀(Overview 카드 문구).
 *   R3D-01 소비 전력 카드 '—'·측정 대수 · R3D-02 GPU 카드 '—'·최소값 · R3D-05 스토리지 사용량 모름·낡음 ·
 *   R3D-03 스토리지 부분 합 문구 · R3S-07 오류 원문 가림 문구.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import * as T from './overviewCardsText.js';
import { gpuKpi } from './execOverviewText.js';

const src = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

describe('R3D-01 소비 전력 카드', () => {
  it('측정 0대면 0.0 kW 가 아니라 — 이고, Overview 가 powerTotalKw 를 쓴다', () => {
    const p = { totalWatts: 0, servers: { watts: 0, measured: 0, devices: 50, unread: 50 }, network: { watts: 0, measured: 0, devices: 0 }, storage: { watts: 0, measured: 0, devices: 0 } };
    expect(T.powerTotalKw(p)).toBe('—');
    const ov = src('./Overview.jsx');
    expect(ov).toMatch(/label="소비 전력" value=\{cards\?\.power \? powerTotalKw\(cards\.power\)/);
    expect(ov).not.toMatch(/kwText\(cards\?\.power\?\.totalWatts\)/);
  });
  it('부제가 측정 m/n대와 못 읽음·오래됨·일부만 읽음을 말한다', () => {
    const p = { totalWatts: 400,
      servers: { watts: 400, measured: 1, devices: 50, unread: 49, ome: 0 },
      network: { watts: 0, measured: 0, devices: 3, unread: 2, stale: 1, partial: 0 },
      storage: { watts: 0, measured: 0, devices: 5, unsupported: 2, unread: 1, stale: 1, partial: 1 } };
    const m = T.cardMeta('power', { power: p });
    expect(m).toMatch(/측정 1\/56대/);
    expect(m).toMatch(/못 읽음 52/);
    expect(m).toMatch(/오래된 값 2/);
    expect(m).toMatch(/일부만 읽음 1/);
    expect(m).toMatch(/읽은 장비만의 합/);
  });
  it('범위 계정 사유는 그대로', () => {
    expect(T.cardMeta('power', { power: { totalWatts: null, reason: '전체 범위 계정만' } })).toBe('전체 범위 계정만');
  });
});

describe('R3D-02 GPU 카드', () => {
  it('인벤토리 0대면 — · 일부면 최소값 · 경영 보기와 같은 판정', () => {
    const none = { count: 0, inventoryRead: 0, servers: 120 };
    expect(T.gpuCardValue(none).value).toBe(null);
    expect(T.countText(T.gpuCardValue(none).value)).toBe('—');
    expect(T.cardMeta('gpus', { gpus: none })).toMatch(/아직 읽은 서버가 없습니다/);
    const part = { count: 8, inventoryRead: 10, servers: 12 };
    expect(T.gpuCardValue(part)).toEqual({ value: 8, partial: true, unknown: false });
    expect(T.cardMeta('gpus', { gpus: part })).toMatch(/최소값/);
    for (const g of [none, part, { count: 4, inventoryRead: 3, servers: 3 }]) expect(gpuKpi({ gpus: g }).value).toBe(T.gpuCardValue(g).value);
    expect(src('./Overview.jsx')).toMatch(/label="GPU" value=\{countText\(gpuCardValue\(cards\?\.gpus\)\.value\)\}/);
  });
});

describe('R3D-05 스토리지 용량 카드', () => {
  it('사용량 모름·오래된 값을 밝힌다', () => {
    const m = T.cardMeta('storage', { storage: { totalBytes: 2e15, usedPct: 70, read: 2, devices: 3, unread: 0, stale: 1, usedUnknown: 1 } });
    expect(m).toMatch(/오래된 값 1/);
    expect(m).toMatch(/사용량 모름 1/);
  });
});

describe('R3D-03 스토리지 전력 부분 합', () => {
  it('powerCatNote 가 일부 부품만 읽은 장비를 말한다', () => {
    expect(T.powerCatNote('storage', { measured: 1, devices: 2, partial: 1 })).toMatch(/일부 부품만 읽음 1/);
  });
});

describe('R3S-07 원천 오류 문구', () => {
  it('원문이 없으면 관리자에게만 표시한다고 말한다', () => {
    expect(T.sourceErrorsText({})).toBe('');
    expect(T.sourceErrorsText({ network: true })).toMatch(/네트워크\(CVP\) — 사유는 관리자에게만/);
    expect(T.sourceErrorsText({ storage: 'boom' })).toBe('스토리지 — boom');
    expect(T.cardMeta('network', { network: { count: null, errorHidden: true } })).toMatch(/관리자에게만/);
    expect(src('./tools/PowerTotal.jsx')).toMatch(/sourceErrorsText\(d\.errors\)/);
  });
});
