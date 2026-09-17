/**
 * storageNodeText.test.js — 스토리지 노드 장애 팝업(v2.523) 판정·문구 회귀 고정.
 *
 * 사용자 요청: "장애표지 클릭하면 어떤 장애인지 확인하는 팝업 만들어줘"(스크린샷: Isilon
 * `24 ⚠1` 인데 **어느 노드인지 알 방법이 없었다**).
 *
 * 이 기능에서 가장 위험한 거짓은 ① 상태를 못 읽은 노드를 정상으로 칠하는 것 ② 노드 목록이
 * 없는데 '비정상 없음' 이라 말하는 것 ③ 목록이 상한으로 잘린 것을 숨기는 것이다.
 */
import { describe, it, expect } from 'vitest';
import { nodeHealthKind, nodeRows, nodeFaultSummary, nodeKindLabel, bpsText, faultBadgeTitle, healthBadge, sectionBadge } from './storageNodeText.js';

const nodesOf = (list, over = {}) => ({
  nodes: { count: list.length, unhealthy: list.filter((n) => nodeHealthKind(n.health) === 'bad').length, list, ...over },
  sections: { nodes: 'ok' },
});

describe('노드 상태 판정', () => {
  it('수집기와 같은 기준으로 ok/bad/unknown 을 가른다', () => {
    for (const v of ['OK', 'ok', 'HEALTHY', 'Normal', 'up', 'green', 'Online']) expect(nodeHealthKind(v)).toBe('ok');
    for (const v of ['ATTN', 'DOWN', 'degraded', 'SMARTFAIL', 'error']) expect(nodeHealthKind(v)).toBe('bad');
    for (const v of ['', null, undefined, 'unknown', 'N/A', '-']) expect(nodeHealthKind(v)).toBe('unknown');
  });
  it("'상태 미확인' 은 정상도 이상도 아니다", () => {
    expect(nodeKindLabel('unknown').label).toBe('상태 미확인');
    expect(nodeKindLabel('unknown').color).not.toBe('green');
    expect(nodeKindLabel('ok').color).toBe('green');
    expect(nodeKindLabel('bad').color).toBe('red');
  });
});

describe('노드 행', () => {
  it('이름이 없으면 id·IP 로 대체하고 지어내지 않는다', () => {
    const rows = nodeRows(nodesOf([{ id: 3, ip: '10.0.0.3', health: 'OK' }, { ip: '10.0.0.9', health: 'OK' }, {}]));
    expect(rows[0].label).toBe('노드 3');
    expect(rows[1].label).toBe('10.0.0.9');
    expect(rows[2].label).toBe('#3');
    expect(rows[2].ip).toBe('');
  });
  it('없는 값을 0 으로 위장하지 않는다', () => {
    const [r] = nodeRows(nodesOf([{ id: 1, health: 'OK' }]));
    expect(r.hddPct).toBeNull();
    expect(r.ssdPct).toBeNull();
    expect(r.inBps).toBeNull();
  });
  it('디스크 없는 노드(null 풀)도 처리한다', () => {
    const [r] = nodeRows(nodesOf([{ id: 1, health: 'OK', hdd: null, ssd: { pct: 42 } }]));
    expect(r.hddPct).toBeNull();
    expect(r.ssdPct).toBe(42);
  });
});

describe('표지 요약 — 무엇을 알고 무엇을 모르는지 분리한다', () => {
  it('현장 사례(24대 중 1대 이상)를 그대로 말한다', () => {
    const list = Array.from({ length: 24 }, (_, i) => ({ id: i + 1, health: i === 7 ? 'ATTN' : 'OK' }));
    const s = nodeFaultSummary(nodesOf(list));
    expect(s.title).toContain('24대 중 1대가 비정상');
    expect(s.badRows.map((r) => r.label)).toEqual(['노드 8']);
    expect(s.body).toBe('');            // 어긋나는 것이 없으면 군말을 붙이지 않는다
    expect(s.tone).toBe('red');
  });
  it("노드 목록이 없으면 '어느 노드인지 알 수 없다' 고 말한다", () => {
    const s = nodeFaultSummary({ nodes: { count: 2, unhealthy: 1, list: [] }, sections: { nodes: 'ok' } });
    expect(s.body).toContain('어느 노드인지 알 수 없습니다');
    expect(s.badRows).toEqual([]);
    expect(s.tone).toBe('amber');       // 빨강(확정)도 초록(정상)도 아니다
  });
  it('목록이 상한으로 잘렸으면 밝힌다(조용한 절단 금지)', () => {
    const list = Array.from({ length: 64 }, (_, i) => ({ id: i + 1, health: i < 2 ? 'DOWN' : 'OK' }));
    const s = nodeFaultSummary({ nodes: { count: 100, unhealthy: 2, list } });
    expect(s.missing).toBe(36);
    expect(s.body).toContain('나머지 36대는 상태를 알 수 없습니다');
  });
  it('상태를 못 읽은 노드 수를 따로 밝힌다', () => {
    const s = nodeFaultSummary(nodesOf([{ id: 1, health: 'OK' }, { id: 2, health: '' }, { id: 3, health: 'unknown' }]));
    expect(s.unknown).toBe(2);
    expect(s.body).toContain('비정상으로 세지 않았습니다');
    expect(s.body).toContain('정상이라는 뜻도 아닙니다');
  });
  it('요약 수치와 목록이 어긋나면 숨기지 않는다', () => {
    const s = nodeFaultSummary({ nodes: { count: 4, unhealthy: 3, list: [{ id: 1, health: 'DOWN' }, { id: 2, health: 'OK' }] } });
    expect(s.body).toContain('요약은 3대라고 하는데');
  });
  it('비정상이 없으면 초록이고 제목이 그렇게 말한다', () => {
    const s = nodeFaultSummary(nodesOf([{ id: 1, health: 'OK' }, { id: 2, health: 'OK' }]));
    expect(s.tone).toBe('green');
    expect(s.title).toContain('비정상 없음');
  });
  it('노드 수집이 실패했으면 그 사유를 싣는다', () => {
    const s = nodeFaultSummary({ nodes: { count: 0, unhealthy: 0, list: [] }, sections: { nodes: 'ssh 인증 실패' } });
    expect(s.body).toContain('ssh 인증 실패');
  });
});

describe('보조 문구', () => {
  it('처리량은 사람 단위이고 없으면 —', () => {
    expect(bpsText(null)).toBe('—');
    expect(bpsText(999)).toBe('999 bps');
    expect(bpsText(12345678)).toBe('12 Mbps');
    expect(bpsText(1500)).toBe('1.5 Kbps');
  });
  it('표지 버튼 title 이 클릭 가능함을 알린다', () => {
    expect(faultBadgeTitle(nodesOf([{ id: 1, health: 'DOWN' }]))).toContain('클릭하면');
  });
});

describe('healthBadge (v2.526)', () => {
  it("Unity 의 'OK' 를 빨강으로 그리지 않는다 — 배지 색과 글자가 반대말을 하면 안 된다", () => {
    expect(healthBadge('OK').tone).toBe('green');
    expect(healthBadge('OK (5)').tone).toBe('green');   // 장비 코드가 붙는 형태
    expect(healthBadge('Healthy').tone).toBe('green');
    expect(healthBadge('normal').tone).toBe('green');
  });

  it('상태를 읽지 못한 것은 이상이 아니라 회색(확인 불가)이다', () => {
    for (const v of ['', null, undefined, 'unknown', 'N/A', '?']) {
      expect(healthBadge(v).tone).toBe('gray');
    }
    expect(healthBadge(null).text).toMatch(/확인 불가/);
    expect(healthBadge('').title).toMatch(/정상이라는 뜻이 아닙니다/);
  });

  it('그 밖은 빨강이고 장비 원문을 그대로 보여준다', () => {
    const b = healthBadge('Degraded (7)');
    expect(b.tone).toBe('red');
    expect(b.text).toBe('Health: Degraded (7)');
  });
});

// ── v2.542: '조회하지 않은 것' 을 빨간 '오류' 로 그리지 않는다 ──────────────────────
// Unity 수집기를 명령 3개로 줄이면서 nodes·accounts·alerts 는 '미수집' 이 됐다. 예전 인라인
// 판정은 ok/skip 이 아니면 전부 빨강이라 그것이 장애처럼 보였다(색이 글자와 반대말을 한다).
describe('sectionBadge — 미수집을 오류로 그리지 않는다(v2.542)', () => {
  it("'ok' 는 초록 OK", () => {
    expect(sectionBadge('ok')).toMatchObject({ tone: 'green', text: 'OK' });
  });
  it("'skip' 은 회색 건너뜀", () => {
    expect(sectionBadge('skip')).toMatchObject({ tone: 'gray', text: '건너뜀' });
  });
  it('미수집은 회색이고 사유를 툴팁에 담는다', () => {
    const b = sectionBadge('미수집(이 수집 방식에서는 조회하지 않습니다)');
    expect(b.tone).toBe('gray');
    expect(b.text).toBe('미수집');
    expect(b.title).toMatch(/조회하지 않습니다/);
  });
  it('오류는 계속 빨강이다 — 부분 실패를 회색으로 덮지 않는다', () => {
    const b = sectionBadge('오류: 명령 출력이 끊겼습니다(26B 수신)');
    expect(b.tone).toBe('red');
    expect(b.text).toBe('오류');
    expect(b.title).toMatch(/26B/);
  });
  it('빈 값도 오류로 다룬다(정상이라 하지 않는다)', () => {
    expect(sectionBadge('').tone).toBe('red');
    expect(sectionBadge(undefined).tone).toBe('red');
  });
});
