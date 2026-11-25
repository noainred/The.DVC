// 120회차(114 반증): 예약 복원 적용 경고는 5건까지만 보여 준다 — 잘랐으면 남은 수와 전부를 볼 곳을 말한다(예전에는 조용히 빠졌다).
//   문구는 화면이 export 한 순수 함수를 실제로 부른다(node 환경 — DOM 없음).
import { describe, it, expect } from 'vitest';
import { restoreStateText } from './PortalBackup.jsx';

describe('120회차 — 예약 복원 경고가 5건을 넘으면 잘린 사실을 밝힌다', () => {
  const last = (warnings) => ({ at: 1, ok: true, applied: ['ui.json'], failed: [], rejected: [], warnings });
  const W = (n) => Array.from({ length: n }, (_, i) => ({ file: `f${i + 1}.json`, reason: `사유${i + 1}` }));
  it('7건이면 앞 5건 + 외 2건 + 볼 곳', () => {
    const t = restoreStateText({ pending: null, last: last(W(7)) });
    expect(t.last).toMatch(/주의: f1\.json: 사유1 · .*f5\.json: 사유5 외 2건\(전체는 서버 로그의 ‘예약 복원 경고’ 줄\)$/);
    expect(t.last).not.toMatch(/f6\.json/);
    expect(t.last).not.toMatch(/`/);
    expect(t.warn).toBe(true);
  });
  it('5건 이하면 예전 문구 그대로(외 N건 없음)', () => {
    expect(restoreStateText({ pending: null, last: last(W(5)) }).last).toMatch(/f5\.json: 사유5$/);
    expect(restoreStateText({ pending: null, last: last(W(1)) }).last).not.toMatch(/외 \d+건/);
  });
  it('문구로 바꿀 수 없는 항목(빈 객체 · null)은 세지 않는다', () => {
    const t = restoreStateText({ pending: null, last: last([...W(5), {}, null]) });
    expect(t.last).not.toMatch(/외 \d+건/);
  });
});
