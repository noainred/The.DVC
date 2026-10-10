/**
 * views/tools/audit2732i3_cvpPower.test.jsx — 점검 2회차(v2.732) 그룹 i3: CVP › 전력 장비 표가 '지금 값이 아닌 장비'(서버 B2-03 —
 * /tools/cvp/power 행 stale:true·staleReason·lastWatts, watts:null)의 빈 소비전력 칸을 설명하는가(cvpPowerText.powerRowNote).
 * 예전에는 KPI 칸만 '오래된 값 N' 을 말하고 행은 '—' 뿐이라 '왜 비었는지' 를 알 수 없었다. 법인별 표의 '읽은 장비 1 / 3' 빈 자리도 말한다.
 * 렌더(renderToStaticMarkup)로 실제 표 HTML 을 본다.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import CvpPowerView from './CvpPower.jsx';
import { powerRowNote } from './cvpPowerText.js';

const h = React.createElement;
const NOW = 1_780_000_000_000;
const dev = (o) => ({ cvpId: 'c1', cvpName: 'CVP-1', key: o.key, hostname: o.key, model: 'DCS-7050', psus: 2, psuRead: 2, basis: 'input', capW: 1100, corpId: 'dc1', corpName: 'HQ', partsAt: NOW, partial: false, ...o });
const DATA = {
  totals: { devices: 3, read: 1, watts: 400, partial: 0, stale: 2, staleBy: { 'parts-stale': 1, stale: 1 }, unread: { partsNotRead: 0, noPsu: 0, noPowerField: 0 }, capDevices: 3, capW: 3300 },
  corps: [{ corpId: 'dc1', corpName: 'HQ', devices: 3, read: 1, watts: 400, partial: 0, stale: 2 }],
  models: [{ model: 'DCS-7050', devices: 3, read: 1, watts: 400, avgW: 400 }],
  devices: [
    dev({ key: 'sw-now', watts: 400, stale: false }),
    dev({ key: 'sw-parts-old', watts: null, lastWatts: 380, stale: true, staleReason: 'parts-stale' }),
    dev({ key: 'sw-old', watts: null, stale: true, staleReason: 'stale' }),
  ],
};
const rowOf = (html, key) => {
  const m = html.match(new RegExp(`<tr[^>]*>(?:(?!</tr>).)*?>${key}</button>(?:(?!</tr>).)*</tr>`, 's'));
  return m ? m[0] : '';
};

describe('CVP 전력 장비 표 — 오래된 행은 왜 비었는지 말한다', () => {
  const html = renderToStaticMarkup(h(CvpPowerView, { servers: [], initialData: DATA }));
  it('오래된 행: 소비전력 칸 아래에 사유·직전 값·합계 제외', () => {
    const r = rowOf(html, 'sw-parts-old');
    expect(r).toBeTruthy();
    const note = powerRowNote(DATA.devices[1]);
    expect(note).toBeTruthy();
    expect(r).toContain('data-power-row-note');
    expect(r).toContain(note);
    expect(r).toContain('합계 제외');
    const r2 = rowOf(html, 'sw-old');
    expect(r2).toContain(powerRowNote(DATA.devices[2]));
  });
  it('지금 값 행에는 표지가 없다', () => {
    const r = rowOf(html, 'sw-now');
    expect(r).toBeTruthy();
    expect(r).not.toContain('data-power-row-note');
  });
  it('법인별 표 — 읽은 장비 칸이 오래된 값 제외 대수를 말한다(KPI 칸이 아니라 표 안에서)', () => {
    const corpSection = html.slice(html.indexOf('<b>법인별</b>'), html.indexOf('<b>모델별</b>'));
    expect(corpSection.length).toBeGreaterThan(0);
    expect(corpSection).toContain('오래된 값 2대 제외');
  });
  it('값이 없는 칸은 null·NaN 으로 새지 않는다', () => {
    expect(html).not.toMatch(/>(null|undefined|NaN)</);
  });
});
