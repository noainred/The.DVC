import { describe, it, expect } from 'vitest';
import { pullDropCard } from './collectorDiag.js';
import { agentTokSummary, fileUnreadableText } from './readFailText.js';

// v2.771(점검 R6-F4-1·F4-2): 엣지 export 전력 원소 상한 초과 표지 · 등록부/토큰 파일 '읽지 못함' 을 '등록 없음'·'0개 발급' 으로 그리지 않는다.
describe('pullDropCard — byHostDropped (R6-F4-1)', () => {
  it('버린 전력 원소를 사유별로 말한다', () => {
    const c = pullDropCard({ ok: true, hosts: 150, byHostDropped: { notObject: 2, overCount: 2850 } });
    expect(c.badge).toBe('버린 전력 2852');
    expect(c.title).toBe('이 엣지가 보낸 전력 목록 일부를 받지 않았습니다');
    expect(c.evidence[0].v).toBe('객체 아님 2 · 상한 초과 2850');
    expect(c.summary).toMatch(/전력 원소 2852개/);
  });
  it('서버만 버렸으면 예전 제목 그대로 · 0 이면 카드 없음', () => {
    expect(pullDropCard({ serversDropped: { notObject: 1, badId: 0, overCount: 0 } }).title).toBe('이 엣지가 보낸 서버 목록 일부를 받지 않았습니다');
    expect(pullDropCard({ byHostDropped: { notObject: 0, overCount: 0 } })).toBe(null);
  });
});

describe('파일 읽지 못함 문구 (R6-F4-2)', () => {
  it('토큰 파일을 읽지 못했으면 0개 발급이라 말하지 않는다', () => {
    expect(agentTokSummary({ tokens: [], loadError: { code: 'parse-error', text: 'JSON 형식 오류' } }, null)).toBe('토큰 파일을 읽지 못함');
    expect(agentTokSummary({ tokens: [] }, null)).toBe('0개 발급');
  });
  it('loadError 요약을 사유와 함께 말하고, 없으면 null', () => {
    const t = fileUnreadableText({ at: 1, code: 'corrupt-only', text: '등록부 파일이 없고 손상 보존본만 있음' }, '수집 서버 등록부(collectors.json)', { notMeaning: '등록이 없다는 뜻이 아닙니다' });
    expect(t).toMatch(/수집 서버 등록부\(collectors\.json\)을\(를\) 읽지 못했습니다\(등록부 파일이 없고 손상 보존본만 있음\)/);
    expect(t).toMatch(/등록이 없다는 뜻이 아닙니다/);
    expect(fileUnreadableText(null, 'x')).toBe(null);
  });
});
