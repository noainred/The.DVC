/**
 * views/tools/audit2732i3_license.test.jsx — 점검 2회차(v2.732) 그룹 i3: 라이선스 만료일 화면이 데모 계정의 'Horizon 접속 안 함'
 * (demoSkipped — 서버 B3-01)을 '⚠ 일부 수집 실패:' 줄에 섞지 않고 별도 안내로 말하는가.
 * 서버(routes/api/toolsInfo.js)는 호환을 위해 그 안내를 collectionErrors 에도 넣는다 — 화면이 알아보는 머리(DEMO_SKIP_PREFIX)가 서버 문구와
 * 같은지 서버 소스를 읽어 대조한다(문구가 바뀌면 이 테스트가 먼저 깨진다).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LicenseExpiry, licenseNotices, DEMO_SKIP_PREFIX } from './LicenseTools.jsx';

const h = React.createElement;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const serverToolsInfo = fs.readFileSync(path.join(HERE, '../../../../server/src/routes/api/toolsInfo.js'), 'utf8');

const DEMO_LINE = 'Horizon: 데모 계정은 사람이 등록한 커넥션 서버 2대에 접속하지 않습니다(실제 로그인 방지) — 그 서버의 라이선스는 이 목록에 없습니다';
const NSX_LINE = 'NSX nsx-a: 라이선스 조회 실패 — 이 매니저의 라이선스는 \'없음\' 이 아니라 확인 불가 (timeout)';
const base = (extra) => ({
  items: [{ family: 'vCenter', name: 'vCenter Standard', source: 'vCenter', where: 'vc1', key: 'AAAA', used: 1, total: 2, expires: null, daysLeft: null, status: 'perpetual' }],
  summary: { perpetual: 1 }, families: ['vCenter'], total: 1, horizonServers: 0, ...extra,
});
const render = (data) => renderToStaticMarkup(h(LicenseExpiry, { scope: '', isAdmin: false, initialData: data }));
const failLine = (html) => {
  const m = html.match(/⚠ 일부 수집 실패: ([^<]*)/);
  return m ? m[1] : null;
};

describe('서버 문구와 화면이 알아보는 머리가 같다', () => {
  it('toolsInfo.js 의 demoSkipped 안내 문구가 DEMO_SKIP_PREFIX 로 시작한다', () => {
    const m = serverToolsInfo.match(/if \(demoSkipped > 0\) collectionErrors\.push\(`([^`$]*)/);
    expect(m, '서버의 demoSkipped 안내 push 를 찾지 못했다').toBeTruthy();
    expect(m[1].startsWith(DEMO_SKIP_PREFIX)).toBe(true);
  });
});

describe('licenseNotices — 데모 안내는 실패 목록에서 빠진다', () => {
  it('demoSkipped > 0 이면 그 줄을 실패에서 빼고 별도 안내를 만든다', () => {
    const r = licenseNotices(base({ collectionErrors: [NSX_LINE, DEMO_LINE], demoSkipped: 2 }));
    expect(r.failures).toEqual([NSX_LINE]);
    expect(r.demoNote).toContain('**데모 계정**');
    expect(r.demoNote).toContain('2대');
    expect(r.demoNote).toContain('수집 실패가 아닙니다');
  });
  it('demoSkipped 가 없으면(구버전 서버·데모 아님) 예전 그대로', () => {
    const r = licenseNotices(base({ collectionErrors: [NSX_LINE] }));
    expect(r.failures).toEqual([NSX_LINE]);
    expect(r.demoNote).toBe('');
  });
  it('demoSkipped 0 이면 안내가 없다(0대를 말하지 않는다)', () => {
    expect(licenseNotices(base({ collectionErrors: [], demoSkipped: 0 })).demoNote).toBe('');
  });
});

describe('라이선스 만료일 화면 렌더', () => {
  it('데모 줄만 있으면 \'일부 수집 실패\' 줄이 없고 별도 안내가 보인다', () => {
    const html = render(base({ collectionErrors: [DEMO_LINE], demoSkipped: 2 }));
    expect(failLine(html)).toBeNull();
    expect(html).toContain('<b>데모 계정</b>');
    expect(html).toContain('수집 실패가 아닙니다');
    expect(html).not.toContain('**');
  });
  it('진짜 실패와 함께면 실패 줄에는 진짜 실패만 있다', () => {
    const html = render(base({ collectionErrors: [NSX_LINE, DEMO_LINE], demoSkipped: 2 }));
    const fl = failLine(html);
    expect(fl).toBeTruthy();
    expect(fl).toContain('NSX nsx-a');
    expect(fl).not.toContain('데모 계정');
    expect(html).toContain('<b>데모 계정</b>');
  });
  it('데모가 아니면 실패 줄은 예전과 같다', () => {
    const html = render(base({ collectionErrors: [NSX_LINE] }));
    expect(failLine(html)).toContain('NSX nsx-a');
    expect(html).not.toContain('데모 계정');
  });
});
