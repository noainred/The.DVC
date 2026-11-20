import { describe, it, expect } from 'vitest';
import { confirmPrompt, resultText, canConfirm } from './settingsFileConfirmText.js';

describe('v2.633 설정 파일 기본값 확정 문구', () => {
  it('확인 창은 배포된다는 사실과 보존본이 남는다는 사실을 함께 말한다', () => {
    const t = confirmPrompt({ file: 'cvp-settings.json', label: 'CloudVision 수집 설정' });
    expect(t).toContain('CloudVision 수집 설정(cvp-settings.json)');
    expect(t).toContain('전 엣지에 배포');
    // 28회차 P-5: 보존 기간 설정(표시 이름에 '최대')은 최대 보존으로 확정한다고 말하고 줄이라고 안내한다
    const m = confirmPrompt({ file: 'svcmon-log.json', label: '성능점검 로그(CSV) 보관 설정 — 확정하면 보관 개수 최대' });
    expect(m).toContain('보존은 최대값'); expect(m).toContain('원래 값으로 줄이세요'); expect(m).not.toContain('지금 적용 중인 기본값');
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
