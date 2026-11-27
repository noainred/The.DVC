// v2.954(점검 A-4) — 엣지 배포 행의 공통 계정 · 키 칸. 범위 계정에는 서버가 이름 대신 불리언만 준다 — 'true · true' 로 그리지 않는다.
import { describe, it, expect } from 'vitest';
import { edgeCredText } from './bmOnboardText.js';

describe('edgeCredText', () => {
  it('이름이면 이름을 잇는다(전체 범위 판본)', () => {
    expect(edgeCredText({ idracCred: 'shared-idrac', osCred: 'ops', osKey: 'k1' })).toBe('shared-idrac · ops · k1');
  });
  it('불리언이면 종류만 — 범위 계정 판본(이름 없음)', () => {
    const s = edgeCredText({ idracCred: true, osCred: false, osKey: true });
    expect(s).toBe('iDRAC 계정 지정됨 · SSH 키 지정됨');
    expect(s).not.toMatch(/true|false/);
  });
  it('아무것도 없으면 —', () => {
    expect(edgeCredText({ idracCred: false, osCred: '', osKey: undefined })).toBe('—');
    expect(edgeCredText()).toBe('—');
  });
});
