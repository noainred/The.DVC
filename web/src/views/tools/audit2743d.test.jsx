/**
 * views/tools/audit2743d.test.jsx — 점검 2회차(v2.743) 그룹 GD 의 화면 쪽.
 * WEB-05: 라이선스 사용량·총량을 못 읽으면(null — v2.727 C-02) '라이선스 한눈에' 가 사용률 0%·카드 '0/0' 이 아니라 '—' 와 '사용량 모름 N건' 을 말하는가.
 *   입력은 서버 /tools/licenses 롤업(server/src/routes/api/toolsInfo.js — server/test/audit2743d.test.js 가 같은 모양을 고정)의 응답 모양이다.
 * VC-03: Tools 업그레이드 결과 문구가 서버의 blocked(비활성·점검중·엣지 위임·로그인 거부 — 사유 포함)를 말하고, 실패를 초록으로 칠하지 않는가.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LicensesView, licenseUsePct, licenseCardText, licenseUnknownNote } from './LicenseTools.jsx';
import { upgradeResultMsg } from './VmInfoTools.jsx';

const h = React.createElement;
const noLeak = (html) => {
  expect(html).not.toMatch(/>(null|undefined|NaN)</);
  expect(html).not.toMatch(/null%|NaN%|\[object Object\]/);
};

const DATA = {
  items: [
    { vcenterId: 'vc1', vcenterName: 'VC1', name: 'vSAN', key: 'B', total: null, used: null },
    { vcenterId: 'vc1', vcenterName: 'VC1', name: 'vSphere 8 Ent', key: 'D', total: 16, used: null },
    { vcenterId: 'vc1', vcenterName: 'VC1', name: 'NSX', key: 'C', total: 10, used: 4 },
  ],
  byLicense: [
    { name: 'vSphere 8 Ent', total: 48, used: 20, usedUnknown: 1, totalUnknown: 0, count: 3, duplicates: 1 },
    { name: 'NSX', total: 10, used: 4, usedUnknown: 0, totalUnknown: 0, count: 1, duplicates: 0 },
    { name: 'vSAN', total: null, used: null, usedUnknown: 2, totalUnknown: 2, count: 2, duplicates: 0 },
  ],
  totalAssigned: 24, usedUnknown: 3, totalUnknown: 2, duplicateKeys: 1, unread: [], partial: false,
};

describe('WEB-05 라이선스 사용률 — 못 읽은 값은 0% 가 아니라 —', () => {
  it('licenseUsePct: 사용량·총량을 둘 다 읽었고 총량 > 0 일 때만 숫자', () => {
    expect(licenseUsePct({ used: 4, total: 10 })).toBe(40);
    expect(licenseUsePct({ used: null, total: 16 })).toBeNull();
    expect(licenseUsePct({ used: 3, total: null })).toBeNull();
    expect(licenseUsePct({ used: null, total: null })).toBeNull();
    expect(licenseUsePct({ used: 0, total: 0 })).toBeNull();   // 분모 0 — 0% 가 아니다(v2.593 DATA-05)
    expect(licenseUsePct({ used: 0, total: 8 })).toBe(0);      // 읽은 0 은 값이다
    expect(licenseUsePct({ used: '', total: 8 })).toBeNull();  // Number('') === 0 함정
  });
  it('licenseCardText: 합계를 못 읽었으면 —, 일부만 못 읽었으면 그 수를 meta 로', () => {
    expect(licenseCardText(DATA.byLicense[2])).toEqual({ value: '—/—', meta: '사용량 모름 2건 · 총량 모름 2건' });
    expect(licenseCardText(DATA.byLicense[0])).toEqual({ value: '20/48', meta: '사용량 모름 1건' });
    expect(licenseCardText({ name: 'X', total: 4, used: 1, productVersion: '8.0' })).toEqual({ value: '1/4', meta: 'v8.0' });   // 구버전 서버(필드 없음)
  });
  it('licenseUnknownNote: 못 읽은 것이 있을 때만 한 줄 — 백틱·별표 없음', () => {
    const n = licenseUnknownNote(DATA);
    expect(n).toContain('사용량 모름 3건');
    expect(n).toContain('총량 모름 2건');
    expect(n).toContain('확인 불가');
    expect(n).not.toMatch(/[`*]/);
    expect(licenseUnknownNote({ usedUnknown: 0, totalUnknown: 0 })).toBeNull();
    expect(licenseUnknownNote({})).toBeNull();   // 구버전 서버 — 말하지 않는다
  });
  it('LicensesView: 결측 행은 사용 — · 사용률 — · 카드 —/— · 안내 문구', () => {
    const html = renderToStaticMarkup(h(LicensesView, { data: DATA }));
    noLeak(html);
    expect(html).toContain('—/—');
    expect(html).toContain('사용량 모름 2건');
    expect(html).toContain('제품별 합계와 사용률에서 빠졌습니다');
    expect(html).not.toContain('0/0');
    // NSX 는 40% · 결측 행 두 개는 사용률 '—'(UsageCell 의 미상 표시)
    expect(html).toContain('40%');
    expect((html.match(/사용률을 읽지 못했습니다/g) || []).length).toBe(2);
    expect(html).not.toMatch(/>0%</);
  });
});

describe('VC-03 Tools 업그레이드 결과 문구 — 막힌 vCenter 의 사유를 말한다', () => {
  it('blocked 가 있으면 vCenter·대수·사유를 싣고 초록(ok) 이 아니다', () => {
    const m = upgradeResultMsg({ ok: true, requested: 3, succeeded: 1, results: [], blocked: [
      { vcenterId: 'vc-site', vms: 2, reason: '엣지 위임 vCenter — 담당 엣지가 수집하므로 중앙이 직접 로그인하지 않습니다', skipReason: 'site' },
    ] });
    expect(m.ok).toBe(false);
    expect(m.text).toContain('1/3건');
    expect(m.text).toContain('vc-site(2대)');
    expect(m.text).toContain('엣지 위임 vCenter');
    expect(m.text).not.toContain('실패 ');   // 막힌 2대 말고 다른 실패는 없다
    expect(m.text).not.toMatch(/undefined|null|NaN|[`*]/);
  });
  it('막힘 없는 실패는 개수로, 전부 성공·데모는 예전 문구 그대로', () => {
    expect(upgradeResultMsg({ requested: 2, succeeded: 1, results: [] })).toEqual({ ok: false, text: '업그레이드 요청: 1/2건 — 실패 1건' });
    expect(upgradeResultMsg({ requested: 2, succeeded: 2, results: [] })).toEqual({ ok: true, text: '업그레이드 요청: 2/2건' });
    expect(upgradeResultMsg({ ok: true, mock: true, requested: 3, results: [] })).toEqual({ ok: true, text: '업그레이드 요청: 3/3건 (데모)' });
  });
});
