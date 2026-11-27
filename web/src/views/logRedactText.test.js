import { describe, it, expect } from 'vitest';
import { serverLogRedactNote, logLineRedactLimit } from './logRedactText.js';
import { logRedactNote } from './tools/edgeLogText.js';

// 보안 잔여 11-27 L8 — 서버 로그 가림 안내(설정 › 진단)와 엣지 로그 화면이 같은 한계 문구를 쓴다.
describe('serverLogRedactNote', () => {
  it('서버가 가렸다고 밝히지 않은 응답(옛 서버)에는 말하지 않는다', () => {
    for (const v of [undefined, null, false, 'true', 1, {}]) expect(serverLogRedactNote({ redacted: v, maskedShown: 3 })).toBeNull();
    expect(serverLogRedactNote()).toBeNull();
  });
  it('가림 표식 · 한계 · 저널 원문을 말하고 백틱이 없다', () => {
    const s = serverLogRedactNote({ redacted: true });
    expect(s).toContain('[가림]');
    expect(s).toContain('남을 수 있');
    expect(s).toContain('journalctl');
    expect(s).toContain(logLineRedactLimit());
    expect(s).not.toContain('`');
    expect(s).not.toMatch(/줄\*\*에서 값을 가렸/);
  });
  it('가린 줄 수는 양의 정수일 때만 말한다', () => {
    expect(serverLogRedactNote({ redacted: true, maskedShown: 3 })).toMatch(/^지금 보이는 줄 중 \*\*3줄\*\*에서 값을 가렸습니다\. /);
    expect(serverLogRedactNote({ redacted: true, maskedShown: 1200 })).toContain('**1,200줄**');
    for (const v of [0, null, undefined, '3', -1, 1.5, NaN, Infinity]) expect(serverLogRedactNote({ redacted: true, maskedShown: v })).not.toContain('줄**에서');
  });
});

describe('logLineRedactLimit — 두 화면 공용', () => {
  it('엣지 로그 화면의 안내도 같은 한계 문구를 싣는다', () => {
    expect(logRedactNote()).toContain(logLineRedactLimit());
    expect(logLineRedactLimit()).not.toContain('`');
  });
});
