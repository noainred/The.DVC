/**
 * 결정(76~105 남긴 것 · 2026-11-20) A3 — 엣지 배포 반영 문구(edgeSyncText): 엣지가 적용 상태 파일을 읽지 못했다고 알렸으면(서버 stateUnread 엄격한 true)
 * '대기' 대신 그 사유 + 마지막 인출 시각. 칸이 없거나 거짓(옛 엣지 · 옛 중앙 · 읽히는 엣지)이면 예전 그대로.
 */
import { describe, it, expect } from 'vitest';
import { edgeSyncText } from './bmOnboardText.js';

const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;   // 정시 경계로 고정

describe('결정 A3 — 엣지 적용 상태 읽기 오류 표지', () => {
  it('표지가 서면 대기 대신 사유와 마지막 인출 시각(값 없이 지어내지 않는다)', () => {
    const s = edgeSyncText({ pulledAt: NOW - 3 * 60_000, inSync: false, stateUnread: true }, NOW);
    expect(s.tone).toBe('bad');
    expect(s.text).toMatch(/^엣지가 적용 상태 파일을 읽지 못함\(권한 · 디스크 확인\)/);
    expect(s.text).toMatch(/마지막 인출 3분 전$/);
    expect(s.text).not.toMatch(/대기/);
    expect(s.text).not.toMatch(/`/);
  });
  it('칸이 없거나 거짓 · 엄격한 true 가 아니면 예전 그대로(옛 엣지 · 옛 중앙)', () => {
    for (const v of [undefined, false, 'true', 1, null]) {
      expect(edgeSyncText({ pulledAt: NOW, inSync: false, stateUnread: v }, NOW)).toEqual({ tone: 'warn', text: '대기 — 엣지가 다음 인출에서 반영합니다' });
      expect(edgeSyncText({ pulledAt: NOW, inSync: true, stateUnread: v }, NOW).text).toBe('반영됨');
    }
  });
  it('인출 기록이 없으면 표지가 있어도 모름(중앙 재시작 직후 — 기록 없는 표지를 지어내지 않는다)', () => {
    expect(edgeSyncText({ pulledAt: null, stateUnread: true }, NOW).text).toMatch(/^모름/);
  });
});
