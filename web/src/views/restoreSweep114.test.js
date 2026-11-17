// 114회차(복원 대상 전수): 예약 복원 적용 결과에 '지금 파일을 그대로 둔 실행 기록'(서버 stagedRestore 의 kept) 수를 밝힌다 —
//   적용 수가 예약 수보다 적은 까닭을 조용히 넘기지 않는다. 문구는 화면이 export 한 순수 함수를 실제로 부른다(node 환경 — DOM 없음).
import { describe, it, expect } from 'vitest';
import { restoreStateText } from './PortalBackup.jsx';

describe('114회차 — 예약 복원 적용 결과의 실행 기록 유지 표시', () => {
  const last = (over) => ({ at: 1, ok: true, applied: ['ui.json', 'svcmon.json'], failed: [], rejected: [], warnings: [], ...over });
  it('kept 가 있으면 개수를 말하고 경고색은 켜지 않는다(실패가 아니다)', () => {
    const t = restoreStateText({ pending: null, last: last({ kept: [{ file: 'vm-hygiene-state.json', reason: 'x' }, { file: 'diskbad-cursors.json', reason: 'y' }] }) });
    expect(t.last).toMatch(/적용.*2개/);
    expect(t.last).toMatch(/실행 기록 2개는 지금 것 유지/);
    expect(t.warn).toBe(false);
  });
  it('kept 가 없거나 옛 서버 응답(칸 없음)이면 예전 문구 그대로', () => {
    expect(restoreStateText({ pending: null, last: last({ kept: [] }) }).last).not.toMatch(/실행 기록/);
    expect(restoreStateText({ pending: null, last: last({}) }).last).not.toMatch(/실행 기록/);
    expect(restoreStateText({ pending: null, last: last({ kept: 'x' }) }).last).not.toMatch(/실행 기록/);
  });
  it('적용하지 못한 기동(reason)에는 붙이지 않고 · 경고 문구보다 앞에 온다', () => {
    expect(restoreStateText({ last: { at: 1, ok: false, reason: 'interrupted', applied: [], failed: [], rejected: [], kept: [{ file: 'a.json' }] } }).last).not.toMatch(/실행 기록/);
    const t = restoreStateText({ last: last({ kept: [{ file: 'a.json' }], warnings: [{ file: 'users.json', reason: '세션 버전을 올렸습니다' }] }) });
    expect(t.last).toMatch(/실행 기록 1개는 지금 것 유지 — 주의: users\.json: 세션 버전을 올렸습니다/);
    expect(t.warn).toBe(true);
  });
});
