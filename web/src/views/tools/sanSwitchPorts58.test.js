// 전체 점검 58회차 F4 — '문제만' 필터는 에러 카운터 7종 전부(서버 점검 · 엣지 축약과 같은 기준) · 표에 안 보이는 카운터는 칸 툴팁이 밝힌다.
//   서버 ERROR_KEYS 와 목록 대조는 server/test/sanFullAudit58.test.js F4.
import { describe, it, expect } from 'vitest';
import { filterPorts, hasPortErrors, otherErrorsTitle, PORT_ERROR_KEYS } from './sanSwitchPorts.js';

describe('58회차 F4 — 포트 에러 7종', () => {
  it('enc in · loss sig · disc c3 · enc out 단독 포트도 문제만 보기에 남는다(예전에는 빠졌다)', () => {
    const list = [
      { index: 1, state: 'online', errEncIn: 3 },
      { index: 2, state: 'online', errLossSig: 1 },
      { index: 3, state: 'online', discC3: 25000 },
      { index: 4, state: 'online', errEncOut: 2 },
      { index: 5, state: 'online', errCrc: 0, errEncIn: null, rxPowerDbm: -3 },
    ];
    expect(filterPorts(list, 'problem').map((p) => p.index)).toEqual([1, 2, 3, 4]);
  });
  it('못 읽음(null · 빈 글자)은 0 이 아니지만 에러로 세지도 않는다', () => {
    expect(hasPortErrors({ errCrc: null, errEncIn: '', discC3: undefined })).toBe(false);
    expect(hasPortErrors({ errLossSig: '2' })).toBe(true);
    expect(PORT_ERROR_KEYS).toHaveLength(7);
  });
  it('칸 툴팁 — 표에 없는 카운터만 · 0 · 못 읽음은 싣지 않는다', () => {
    expect(otherErrorsTitle({ errCrc: 5, errEncIn: 0, errLossSig: null })).toBeUndefined();
    expect(otherErrorsTitle({ errEncIn: 300, discC3: 25000 })).toBe('이 칸에 없는 누적 카운터: enc in 300 · disc c3 25,000');
  });
});
