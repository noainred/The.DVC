/**
 * audit2680c — v2.680 감사 그룹 C(웹): 전체 소비 전력 화면.
 *  D-04 읽은 장비가 없는 카테고리·합계는 '0.0 kW' 가 아니라 '—'.
 *  D-05 데이터를 가진 채 새로고침이 실패하면 배너로 말한다(직전 데이터 표시 중).
 *  A-06 서버 분모(측정 m/n대) · A-05 일부 PSU 만 읽은 스위치 개수.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { stripComments } from '../test/_stripComments.js';
import * as T from './overviewCardsText.js';

describe('v2.680 전체 소비 전력', () => {
  it('D-04 측정 0대 카테고리·합계는 —, 측정한 0 W 는 값', () => {
    expect(T.powerCatKw({ watts: 0, measured: 0 })).toBe('—');
    expect(T.powerCatKw({ watts: 0, measured: 2 })).toBe('0.0 kW');
    expect(T.powerCatKw({ watts: 400, measured: 0, partial: 1 })).toBe('0.4 kW');
    expect(T.powerCatKw(null)).toBe('—');
    const none = { totalWatts: 0, servers: { watts: 0, measured: 0 }, network: { watts: 0, measured: 0 }, storage: { watts: 0, measured: 0 } };
    expect(T.powerTotalKw(none)).toBe('—');
    expect(T.powerTotalKw({ ...none, totalWatts: 500, servers: { watts: 500, measured: 1 } })).toBe('0.5 kW');
    expect(T.cardMeta('power', { power: { servers: { watts: 0, measured: 0 }, network: { watts: 400, measured: 0, partial: 1 }, storage: { watts: 0, measured: 0 } } }))
      .toBe('서버 — · 네트워크 0.4 kW · 스토리지 —');
  });
  it('A-06 서버 분모 — 측정 m/n대 · 못 읽음 · OME', () => {
    expect(T.powerCatNote('servers', { measured: 3, ome: 1, devices: 5, unread: 3 })).toBe('iDRAC 실측 2/5대 · 못 읽음·오래된 값 3 · OME 로 읽음 1');
    expect(T.powerCatNote('servers', { measured: 2, devices: null, excludedVcenter: 1 })).toBe('iDRAC 실측 2대 · vCenter 추정 1대는 뺐습니다');
  });
  it('A-05 일부 PSU 만 읽은 스위치를 밝힌다', () => {
    expect(T.powerCatNote('network', { measured: 1, partial: 1, devices: 2 })).toMatch(/일부 PSU 만 읽음 1/);
  });
  it('D-04·D-05 화면이 판정 함수와 갱신 실패 배너를 쓴다', () => {
    const src = stripComments(fs.readFileSync(new URL('./tools/PowerTotal.jsx', import.meta.url), 'utf8'));
    expect(src).toMatch(/powerTotalKw\(d\)/);
    expect(src).toMatch(/powerCatKw\(x\)/);
    expect(src).not.toMatch(/\{kwText\(x\.watts\)\}/);
    expect(src).toMatch(/err && <div className="banner"[^>]*>갱신 실패\(직전 데이터 표시 중\)/);
  });
  it('문구에 백틱·별표가 없다', () => {
    for (const s of [T.powerCatNote('servers', { measured: 1, devices: 2, unread: 1, ome: 0 }), T.powerCatNote('network', { measured: 0, partial: 2, devices: 2 })]) {
      expect(s).not.toMatch(/[`*]/);
    }
  });
});
