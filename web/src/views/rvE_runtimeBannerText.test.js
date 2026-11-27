// 검토 I-06 — 서버 Node 런타임 불일치 배너 판정·문구(views/runtimeBannerText.js).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runtimeBanner } from './runtimeBannerText.js';

const contract = { supportedMajors: [22], minVersion: '22.5.0', releaseVersion: '22.23.5', securityFloor: '22.23.5', engines: '>=22.5.0 <23' };
const admin = (over) => ({ runtime: { state: 'ok', node: 'v22.23.5', major: 22, supported: true, code: 'release', contract, selfCheck: { state: 'ok', code: null }, ...over } });

describe('runtimeBanner — 판정', () => {
  it('정상·점검 중·미점검·필드 없음(구버전 서버)·모르는 값은 배너 없음', () => {
    expect(runtimeBanner(admin())).toBeNull();
    expect(runtimeBanner(admin({ state: 'checking' }))).toBeNull();
    expect(runtimeBanner(admin({ state: 'unchecked' }))).toBeNull();
    expect(runtimeBanner({ status: 'ok' })).toBeNull();
    expect(runtimeBanner(null)).toBeNull();
    expect(runtimeBanner(undefined)).toBeNull();
    expect(runtimeBanner({ runtime: 'mismatch' })).toBeNull();
    expect(runtimeBanner(admin({ state: 'weird' }))).toBeNull();
  });

  it('불일치 — 관리자는 버전·코드·계약·조치, 장비 장애가 아닐 수 있다고 말한다', () => {
    const b = runtimeBanner(admin({ state: 'mismatch', node: 'v26.6.0', major: 26, supported: false, code: 'unsupported-major', selfCheck: { state: 'mismatch', code: 'UND_ERR_INVALID_ARG' } }));
    expect(b.tone).toBe('bad');
    expect(b.text).toContain('Node(‘v26.6.0’)에서');
    expect(b.text).toContain('‘UND_ERR_INVALID_ARG’');
    expect(b.text).toContain('‘>=22.5.0 <23’');
    expect(b.text).toContain('장비 장애가 아닐 수 있습니다');
    expect(b.text).toContain('검증 버전 ‘22.23.5’');
  });

  it('불일치 — 관리자가 아닌 계정(state 만)에도 보이되 버전·코드는 없다', () => {
    const b = runtimeBanner({ runtime: { state: 'mismatch' } });
    expect(b.tone).toBe('bad');
    expect(b.text).toMatch(/관리자에게 알리세요/);
    expect(b.text).not.toMatch(/v2\d|UND_ERR/);
  });

  it('지원 범위 밖 · 판정 불가는 관리자에게만(확인된 장애가 아니다)', () => {
    expect(runtimeBanner({ runtime: { state: 'unsupported' } })).toBeNull();
    expect(runtimeBanner({ runtime: { state: 'error' } })).toBeNull();
    const u = runtimeBanner(admin({ state: 'unsupported', node: 'v24.11.0', major: 24, supported: false, code: 'unsupported-major' }));
    expect(u.tone).toBe('warn');
    expect(u.text).toContain('Node(‘v24.11.0’)는 지원 범위(‘>=22.5.0 <23’) 밖입니다');
    expect(u.text).toContain('통신 자가 점검은 통과했지만');
    const low = runtimeBanner(admin({ state: 'unsupported', node: 'v22.4.1', code: 'below-minimum', selfCheck: { state: 'ok' } }));
    expect(low.text).toMatch(/SQLite/);
    const e = runtimeBanner(admin({ state: 'error', node: 'v22.22.2', code: 'supported', selfCheck: { state: 'timeout', code: 'self-check-timeout' } }));
    expect(e.tone).toBe('warn');
    expect(e.text).toContain('Node(‘v22.22.2’)의 통신 자가 점검을 판정하지 못했습니다');
  });

  it('문구에 백틱·별표 강조·undefined 가 없다', () => {
    const cases = [
      admin({ state: 'mismatch', selfCheck: { state: 'mismatch', code: 'X' } }),
      admin({ state: 'unsupported', code: 'unparsed', node: '' }),
      admin({ state: 'error', selfCheck: {} }),
      { runtime: { state: 'mismatch' } },
      admin({ state: 'mismatch', contract: {}, selfCheck: null }),
    ];
    for (const h of cases) {
      const b = runtimeBanner(h);
      expect(b).not.toBeNull();
      expect(b.text).not.toMatch(/`|\*\*|undefined|null|\s{2,}/);
      expect(b.title).toBeTruthy();
    }
    const src = fs.readFileSync(fileURLToPath(new URL('./runtimeBannerText.js', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/\\`/);
  });
});

// 보안 잔여 11-27 G4 — 계약 안이지만 보안 하한 미만(belowSecurityFloor) 런타임.
describe('runtimeBanner — 보안 하한 미만', () => {
  const low = (over) => admin({ node: 'v22.23.2', code: 'supported', releaseRelation: 'older', belowSecurityFloor: true, ...over });

  it('관리자 · ok/checking/unchecked · belowSecurityFloor true → warn 배너(하한 숫자는 API 값 · 재설치 안내)', () => {
    for (const state of ['ok', 'checking', 'unchecked']) {
      const b = runtimeBanner(low({ state }));
      expect(b, state).not.toBeNull();
      expect(b.tone).toBe('warn');
      expect(b.state).toBe(state);
      expect(b.title).toBe('보안 패치가 빠진 Node 런타임');
      expect(b.text).toContain('Node(‘v22.23.2’)는 보안 하한(‘22.23.5’)보다 낮아');
      expect(b.text).toContain('자동 업그레이드는 Node 런타임을 바꾸지 않으니');
      expect(b.text).toContain('소스 설치면');
      expect(b.text).not.toMatch(/`|\*\*|undefined|null|\s{2,}|TLS|Brotli/);
    }
    // 하한 숫자는 API 의 contract.securityFloor 에서 온다(화면에 박지 않는다)
    const other = runtimeBanner(low({ contract: { ...contract, securityFloor: '22.99.1' } }));
    expect(other.text).toContain('보안 하한(‘22.99.1’)');
    const none = runtimeBanner(low({ contract: { engines: '>=22.5.0 <23' } }));
    expect(none.text).toContain('보안 하한보다 낮아');
  });

  it('false · 없음(구버전 서버) · 참이 아닌 값 · 비관리자(state 만) → 배너 없음', () => {
    expect(runtimeBanner(low({ belowSecurityFloor: false }))).toBeNull();
    expect(runtimeBanner(low({ belowSecurityFloor: undefined }))).toBeNull();
    expect(runtimeBanner(low({ belowSecurityFloor: 'true' }))).toBeNull();
    expect(runtimeBanner(low({ belowSecurityFloor: 1 }))).toBeNull();
    expect(runtimeBanner({ runtime: { state: 'ok' } })).toBeNull();
    expect(runtimeBanner({ runtime: { state: 'ok', belowSecurityFloor: true } })).toBeNull();
    expect(runtimeBanner(low({ state: 'weird' }))).toBeNull();
  });

  it('불일치 · 지원 범위 밖 · 판정 불가가 먼저다', () => {
    expect(runtimeBanner(low({ state: 'mismatch', selfCheck: { state: 'mismatch', code: 'X' } })).title).toBe('포탈 서버 런타임 불일치');
    expect(runtimeBanner(low({ state: 'unsupported' })).title).toBe('지원 범위 밖 Node 런타임');
    expect(runtimeBanner(low({ state: 'error' })).title).toBe('런타임 통신 자가 점검 판정 불가');
  });
});
