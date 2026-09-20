/**
 * collectorDiag — 수집 서버 경고 배지 상세(v2.437) 회귀 고정.
 * 웹 테스트는 node 환경(DOM 없음)이라 컴포넌트 렌더는 못 한다 — 판정·문구를 순수 함수로 고정한다.
 */
import { describe, it, expect } from 'vitest';
import {
  denyCard, identityCards, urlIdentityCard, rowCards,
  displayIp, uaDisplay, DENY_KIND, denyReasonKind, denyPathResultLabel, tokenMismatchBanner, denyPathOf,
} from './collectorDiag.js';

describe('displayIp — v2.571 진단 모달 재구성: 표시 전용 변환, 원본은 바꾸지 않는다', () => {
  it('IPv4-매핑 IPv6 는 IPv4 로 풀어 보여준다', () => {
    expect(displayIp('::ffff:192.168.20.143')).toBe('192.168.20.143');
    expect(displayIp('::FFFF:10.0.0.1')).toBe('10.0.0.1'); // 대소문자 무관
  });
  it('그 밖의 값은 그대로 돌려준다(가공·추정 금지)', () => {
    expect(displayIp('192.168.1.1')).toBe('192.168.1.1');
    expect(displayIp('2001:db8::1')).toBe('2001:db8::1');
    expect(displayIp('')).toBe('');
    expect(displayIp(null)).toBe(null);
    expect(displayIp(undefined)).toBe(undefined);
  });
});

describe('uaDisplay — User-Agent 는 토큰도 엣지 이름도 아니다', () => {
  it('"node" 는 사람이 읽을 수 있는 이름 + 원문을 함께 준다', () => {
    const u = uaDisplay('node');
    expect(u.label).toBe('Node.js HTTP 요청');
    expect(u.raw).toBe('node');
    expect(u.known).toBe(true);
  });
  it('그 밖의 값은 원문 그대로(변형 없음)', () => {
    const u = uaDisplay('curl/8.0');
    expect(u.label).toBe('curl/8.0');
    expect(u.known).toBe(false);
  });
  it('값이 없으면 대시', () => {
    expect(uaDisplay(null).label).toBe('—');
    expect(uaDisplay('').label).toBe('—');
  });
});

describe('denyReasonKind / denyPathResultLabel / tokenMismatchBanner — v2.571', () => {
  it('세 갈래를 정확히 가른다', () => {
    expect(denyReasonKind('COLLECTOR_TOKEN 미설정(이 엣지의 수집 기능이 꺼져 있음)')).toBe(DENY_KIND.DISABLED);
    expect(denyReasonKind('요청에 X-Collector-Token 헤더 없음')).toBe(DENY_KIND.NO_HEADER);
    expect(denyReasonKind('토큰 불일치')).toBe(DENY_KIND.MISMATCH);
  });
  it('경로 결과 라벨은 갈래마다 다르다', () => {
    expect(denyPathResultLabel(DENY_KIND.MISMATCH)).toContain('토큰 불일치');
    expect(denyPathResultLabel(DENY_KIND.DISABLED)).toContain('미설정');
    expect(denyPathResultLabel(DENY_KIND.NO_HEADER)).toContain('헤더');
  });
  it('상단 배너는 토큰 불일치일 때만 뜨고 문구가 고정돼 있다', () => {
    const mismatch = denyCard({ authDeny: { count: 1, recent: [{ at: 1, why: '토큰 불일치' }] } });
    const b = tokenMismatchBanner(mismatch);
    expect(b.title).toBe('요청 서버와 edge의 수집 토큰이 일치하지 않습니다.');
    expect(b.sub).toBe('요청은 edge까지 정상 도착했지만 토큰 검증에서 거부되었습니다. 네트워크 연결은 정상입니다.');

    const disabled = denyCard({ authDeny: { count: 1, recent: [{ at: 1, why: 'COLLECTOR_TOKEN 미설정' }] } });
    expect(tokenMismatchBanner(disabled)).toBe(null);
    expect(tokenMismatchBanner(null)).toBe(null);
    expect(tokenMismatchBanner({ kind: 'agent-name' })).toBe(null);
  });
});

describe('denyPathOf — 요청 경로 시각화(deny 카드 전용)', () => {
  it('deny 가 아닌 카드는 경로가 없다', () => {
    expect(denyPathOf({ kind: 'agent-name' }, {})).toBe(null);
    expect(denyPathOf(null, {})).toBe(null);
  });
  it('출처 IP·결과·대상 엣지를 담는다(IPv4-매핑 표기도 화면용으로 풀린다)', () => {
    const card = denyCard({ authDeny: { count: 1, recent: [{ at: 1, ip: '::ffff:10.20.30.40', why: '토큰 불일치' }] } });
    const p = denyPathOf(card, { id: 'hd', name: 'HD', url: 'http://10.20.30.40:4000' });
    expect(p.from).toBe('10.20.30.40');
    expect(p.resultLabel).toContain('토큰 불일치');
    expect(p.to).toBe('HD (hd)');
    expect(p.toSub).toBe('http://10.20.30.40:4000');
  });
  it('출처 IP 가 없으면(구버전 엣지) 그 사실을 말한다', () => {
    const card = denyCard({ authDeny: { count: 2, lastAt: 5, lastWhy: '토큰 불일치' } });
    const p = denyPathOf(card, { id: 'hd' });
    expect(p.from).toBe('(출처 미상)');
  });
});

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
