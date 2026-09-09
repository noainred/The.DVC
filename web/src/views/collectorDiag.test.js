/**
 * collectorDiag — 수집 서버 경고 배지 상세(v2.437) 회귀 고정.
 * 웹 테스트는 node 환경(DOM 없음)이라 컴포넌트 렌더는 못 한다 — 판정·문구를 순수 함수로 고정한다.
 */
import { describe, it, expect } from 'vitest';
import { denyCard, identityCards, urlIdentityCard, rowCards } from './collectorDiag.js';

describe('denyCard — 엣지가 수집 요청을 거부한 내역', () => {
  it('거부가 없으면 카드를 만들지 않는다', () => {
    expect(denyCard(null)).toBe(null);
    expect(denyCard({ authDeny: { count: 0 } })).toBe(null);
  });

  it('상세 내역·출처 집계를 싣고, 토큰 값은 지문만 남긴다', () => {
    const c = denyCard({
      authDeny: {
        count: 3, lastAt: 1000, lastWhy: '토큰 불일치', lastEndpoint: 'export',
        recent: [{ at: 1000, endpoint: 'export', ip: '10.94.40.217', why: '토큰 불일치', tokenLen: 44, fp: 'sha256:1a2b3c4d(len=44)', ua: 'node' }],
        bySrc: [{ ip: '10.94.40.217', count: 3, firstAt: 900, lastAt: 1000, lastWhy: '토큰 불일치', lastEndpoint: 'export' }],
      },
    });
    expect(c.kind).toBe('deny');
    expect(c.badge).toBe('거부 3');
    expect(c.rows).toHaveLength(1);
    expect(c.bySrc[0].ip).toBe('10.94.40.217');
    // 출처 IP 가 근거에 드러나야 한다 — 예전엔 엣지 콘솔 로그에만 있어 SSH 로 들어가야 했다.
    expect(c.evidence.find((e) => e.k === '마지막 출처 IP').v).toBe('10.94.40.217');
    expect(c.steps.length).toBeGreaterThan(1);
    expect(c.where.length).toBeGreaterThan(0);
    expect(c.note).toBe('');
  });

  it('사유 세 갈래마다 해결 절차가 다르다', () => {
    const disabled = denyCard({ authDeny: { count: 1, recent: [{ at: 1, why: 'COLLECTOR_TOKEN 미설정(이 엣지의 수집 기능이 꺼져 있음)' }] } });
    expect(disabled.steps[0]).toContain('COLLECTOR_TOKEN 이 없습니다');
    const noHeader = denyCard({ authDeny: { count: 1, recent: [{ at: 1, why: '요청에 X-Collector-Token 헤더 없음' }] } });
    expect(noHeader.steps[0]).toContain('헤더가 아예 없었습니다');
    const mismatch = denyCard({ authDeny: { count: 1, recent: [{ at: 1, why: '토큰 불일치' }] } });
    expect(mismatch.steps[0]).toContain('토큰 값이 다릅니다');
  });

  it('상세를 안 보내는 구버전 엣지는 한계를 명시한다(모른다고 말한다)', () => {
    const c = denyCard({ authDeny: { count: 2, lastAt: 5, lastWhy: '토큰 불일치', lastEndpoint: 'export' } });
    expect(c.note).toContain('구버전');
    expect(c.evidence.find((e) => e.k === '마지막 출처 IP').v).toContain('구버전 엣지');
  });
});

describe('identityCards — 한 배지에 뭉쳐 있던 두 사고를 가른다', () => {
  const ident = {
    byAgent: {
      hd: {
        agent: 'hd', hostname: 'hd-edge', peer: '192.168.79.221', at: 20, seen: 9,
        conflict: { hostname: 'hd-irs-edge', peer: '192.168.79.10', at: 20, prevAt: 10, flips: 2 },
      },
    },
    vcenterConflicts: [{
      vcenterId: 'vc-ap-seoul', agent: 'hd-irs', peer: '1.1.1.1', hostname: 'a',
      other: 'hd', otherPeer: '2.2.2.2', otherHostname: 'b', at: 30, flips: 1,
    }],
  };

  it('AGENT_NAME 충돌과 vCenter id 충돌이 별개 배지로 나뉜다', () => {
    // v2.436 까지는 둘 다 빨간 '이름 충돌' 하나였다 — 원인이 달라 해결 절차도 다르다.
    const a = identityCards({ id: 'hd', name: 'HD' }, ident);
    expect(a.map((x) => x.badge)).toEqual(['이름 충돌', 'vCenter 중복']);
    expect(a[0].evidence.some((e) => String(e.v).includes('hd-irs-edge'))).toBe(true);
    expect(a[1].evidence.some((e) => String(e.v).includes('hd-irs'))).toBe(true);
  });

  it('이름 충돌은 그 이름을 가진 항목에만 붙는다', () => {
    const b = identityCards({ id: 'hd-irs', name: 'HD-IRS' }, ident);
    expect(b.map((x) => x.badge)).toEqual(['vCenter 중복']);
  });

  it('충돌이 없으면 카드가 없다', () => {
    const none = identityCards({ id: 'gm2' }, { byAgent: { gm2: { agent: 'gm2', conflict: null } }, vcenterConflicts: [] });
    expect(none).toEqual([]);
  });
});

describe('urlIdentityCard / rowCards', () => {
  it('등록 URL 이 다른 엣지에 닿은 경우', () => {
    expect(urlIdentityCard({})).toBe(null);
    const u = urlIdentityCard({ identity: { agent: 'gm2', hostname: 'h', reason: '다른 엣지가 응답' } });
    expect(u.badge).toBe('응답 gm2');
    expect(u.summary).toBe('다른 엣지가 응답');
  });

  it('배지 순서를 고정하고 모든 카드가 해결 절차·출처를 갖는다', () => {
    const cards = rowCards(
      { id: 'hd', name: 'HD' },
      { identity: { agent: 'hg', reason: 'r' }, authDeny: { count: 1, recent: [{ at: 1, why: '토큰 불일치' }] } },
      { byAgent: { hd: { agent: 'hd', hostname: 'a', conflict: { hostname: 'b', at: 1 } } }, vcenterConflicts: [] },
    );
    expect(cards.map((c) => c.kind)).toEqual(['url-identity', 'agent-name', 'deny']);
    for (const c of cards) {
      expect(c.title).toBeTruthy();
      expect(c.summary).toBeTruthy();
      expect(c.steps.length).toBeGreaterThan(0);
      expect(c.where.length).toBeGreaterThan(0);
    }
  });
});
