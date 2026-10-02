// v2.685 — 사용자 신고 "설정에 Horizon 등록 메뉴가 없어".
// 등록 화면은 한 벌(HorizonAdmin.jsx)이고 설정 메뉴와 라이선스 만료 도구가 같이 쓴다.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const read = (p) => fs.readFileSync(path.join(HERE, p), 'utf8');

describe('Horizon 연결 서버 등록 — 설정 메뉴', () => {
  const settings = read('Settings.jsx');
  it('설정 하위 메뉴에 horizon-admin 이 있고 HorizonAdmin 을 그린다', () => {
    expect(settings).toMatch(/\{ k: 'horizon-admin', label: 'Horizon 연결 서버', C: HorizonAdmin \}/);
    expect(settings).toMatch(/import HorizonAdmin from '\.\/HorizonAdmin\.jsx'/);
  });
  it('라이선스 만료 도구는 등록 폼을 복제하지 않고 공용 컴포넌트를 쓴다', () => {
    const lic = read('tools/LicenseTools.jsx');
    expect(lic).toMatch(/<HorizonServerManager variant="details" onChanged=\{load\} \/>/);
    expect(lic).not.toMatch(/\/admin\/horizon/);
  });
  it('설정 화면에서 실시간 사용자 수집 설정도 열 수 있다', () => {
    const s = read('HorizonAdmin.jsx');
    expect(s).toMatch(/<HorizonSessionSettings onClose=/);
    expect(s).toMatch(/variant === 'page'/);
  });
});

import { hzTestMessage } from './horizonAdminText.js';
describe('연결 테스트 문구 — 로그인 성공 + 라이선스 404 를 실패와 구분', () => {
  it('licenses null 이면 주황 경고이고 로그인 성공을 먼저 말한다', () => {
    const m = hzTestMessage({ ok: true, loginOk: true, ms: 120, licenses: null, licenseStatus: 404, licenseError: 'X 404', csVersion: '8.12', probe: { path: '/rest/monitor/v1/connection-servers', status: 200 } });
    expect(m.ok).toBe(false); expect(m.warn).toBe(true);
    expect(m.text.startsWith('로그인 성공')).toBe(true);
    expect(m.text).toContain('8.12'); expect(m.text).toContain('HTTP 200');
    expect(m.text).not.toMatch(/`|\*\*/);
  });
  it('정상·실패는 예전 문구', () => {
    expect(hzTestMessage({ ok: true, ms: 5, licenses: 2, first: 'Enterprise' })).toEqual({ ok: true, text: '연결 성공 (5ms) · 라이선스 2건 · Enterprise' });
    expect(hzTestMessage({ ok: false, reason: 'Horizon 로그인 실패 (HTTP 401)' }).ok).toBe(false);
  });
});
