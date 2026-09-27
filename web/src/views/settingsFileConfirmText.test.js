import { describe, it, expect } from 'vitest';
import { confirmPrompt, resultText, canConfirm } from './settingsFileConfirmText.js';

describe('v2.633 설정 파일 기본값 확정 문구', () => {
  it('확인 창은 배포된다는 사실과 보존본이 남는다는 사실을 함께 말한다', () => {
    const t = confirmPrompt({ file: 'cvp-settings.json', label: 'CloudVision 수집 설정' });
    expect(t).toContain('CloudVision 수집 설정(cvp-settings.json)');
    expect(t).toContain('전 엣지에 배포');
    expect(t).toContain('지우지 않습니다');
    expect(t).not.toMatch(/`|\*\*/);
  });
  it('결과 문구는 코드마다 다르고 모르는 코드는 일반 실패', () => {
    expect(resultText({ ok: true, file: 'a.json', label: 'A' })).toContain('확정했습니다 — A');
    expect(resultText({ code: 'not-in-error' })).toContain('이미 정상');
    expect(resultText({ code: 'confirm-failed', detail: '디스크' })).toBe('저장에 실패했습니다: 디스크');
    expect(resultText({ code: 'x' })).toBe('확정하지 못했습니다');
    expect(resultText({ detail: '전체 범위만' })).toBe('확정하지 못했습니다: 전체 범위만');
  });
  it('버튼은 관리자 + 확정 가능 파일만', () => {
    expect(canConfirm({ file: 'a.json', confirmable: true }, true)).toBe(true);
    expect(canConfirm({ file: 'a.json', confirmable: true }, false)).toBe(false);
    expect(canConfirm({ file: 'a.json', confirmable: false }, true)).toBe(false);
    expect(canConfirm({ file: 'a.json' }, true)).toBe(false);
  });
});
