// v2.728 — iDRAC 하드웨어 화면의 부품 상태·링크·'부품 이상' 열 문구. 판정은 서버(partState·linkState·parts)이고
// 여기서는 색·문구만 고정한다: 확인 불가는 회색(정상도 장애도 아님) · 빈 슬롯은 장애 아님 · 못 읽은 링크를 ⛔ 로 칠하지 않는다.
import { describe, it, expect } from 'vitest';
import {
  partStatusBadge, linkBadge, portSpeedText, partsCell, partsHeadline, failedKindsNote, statusMissingNote, partFaultNote,
  PARTS_REASON_TEXT, partsReasonText,
} from './hwStatusText.js';

describe('partStatusBadge — 글자는 장비 보고(health → state), 색은 서버 판정', () => {
  it('정상·장애·주의', () => {
    expect(partStatusBadge({ partState: 'ok', health: 'OK', state: 'Enabled' })).toMatchObject({ cls: 'green', text: 'OK' });
    expect(partStatusBadge({ partState: 'fault', health: 'Critical' })).toMatchObject({ cls: 'red', text: 'Critical' });
    expect(partStatusBadge({ partState: 'warn', health: 'OK', predictiveFailure: true })).toMatchObject({ cls: 'amber', text: '예측 실패' });
  });
  it('값이 없으면 확인 불가(회색) — 예전 화면은 "—" 였다', () => {
    const b = partStatusBadge({ partState: 'unknown', health: '', state: '' });
    expect(b).toMatchObject({ cls: 'gray', text: '확인 불가' });
    expect(b.title).toMatch(/정상도 장애도 아님/);
    expect(partStatusBadge({ partState: 'unknown', health: '', state: 'Enabled' }).text).toBe('Enabled');
    expect(partStatusBadge({}).cls).toBe('gray');
    expect(partStatusBadge(null).text).toBe('확인 불가');
  });
  it('빈 슬롯은 장애가 아니다', () => {
    expect(partStatusBadge({ partState: 'absent', state: 'Absent' })).toMatchObject({ cls: 'gray', text: '빈 슬롯' });
  });
});

describe('linkBadge — unknown 을 ⛔ 로 칠하지 않는다', () => {
  it('up/down/unknown', () => {
    expect(linkBadge({ linkState: 'up', link: 'LinkUp' })).toMatchObject({ cls: 'green', icon: '🔗' });
    expect(linkBadge({ linkState: 'down', link: 'Down' })).toMatchObject({ icon: '⛔' });
    const u = linkBadge({ linkState: 'unknown', link: '' });
    expect(u.icon).toBe('?');
    expect(u.title).toMatch(/다운이라는 뜻이 아닙니다/);
    expect(linkBadge({ link: 'Up' }).icon).toBe('?');   // 판정이 없으면 웹이 추측하지 않는다
  });
  it('속도', () => {
    expect(portSpeedText(1000)).toBe('1G');
    expect(portSpeedText(2500)).toBe('2.5G');
    expect(portSpeedText(100)).toBe('100M');
    for (const v of [0, null, undefined, '1000', NaN]) expect(portSpeedText(v)).toBe('');
  });
});

describe('partsCell — 서버 목록 부품 이상 열', () => {
  const now = 1_800_000_000_000;
  it('장애·경고·확인 불가를 따로, 정렬은 나쁜 것이 크게', () => {
    const c = partsCell({ judged: true, fault: 1, warn: 2, unknown: 3, absent: 4, ok: 10, total: 20, collectedAt: now, stale: false }, now);
    expect(c.badges.map((b) => b.text)).toEqual(['장애 1', '경고 2', '확인 불가 3']);
    expect(c.badges.map((b) => b.cls)).toEqual(['red', 'amber', 'gray']);
    expect(c.badges[0].title).toMatch(/빈 슬롯 4\(장애 아님\)/);
    const w = partsCell({ judged: true, fault: 0, warn: 1, unknown: 0, ok: 5 }, now);
    expect(c.sort).toBeGreaterThan(w.sort);
  });
  it('전부 정상이면 이상 없음(초록) — 확인 불가만 있으면 초록이 아니다', () => {
    expect(partsCell({ judged: true, fault: 0, warn: 0, unknown: 0, ok: 9 }, now).badges).toEqual([expect.objectContaining({ cls: 'green', text: '이상 없음' })]);
    expect(partsCell({ judged: true, fault: 0, warn: 0, unknown: 2, ok: 9 }, now).badges.map((b) => b.cls)).toEqual(['gray']);
    expect(partsCell({ judged: true, fault: 0, warn: 0, unknown: 0, ok: 0 }, now).badges).toEqual([]);
  });
  it('판정 불가는 — + 사유(0 건이라 말하지 않는다), 정렬은 뒤로', () => {
    const c = partsCell({ judged: false, reason: 'edge-old' }, now);
    expect(c.badges).toEqual([]);
    expect(c.sort).toBe('');
    expect(c.title).toMatch(/2\.728 이전/);
    expect(partsCell(undefined, now).title).toMatch(/받지 못했습니다/);
  });
  it('오래된 인벤토리는 숨기지 않고 ⏱ 표지', () => {
    const c = partsCell({ judged: true, fault: 1, ok: 3, collectedAt: now - 3 * 3_600_000, stale: true }, now);
    expect(c.badges.map((b) => b.text)).toEqual(['장애 1', '⏱']);
    expect(c.badges[1].title).toMatch(/180분 전/);
  });
});

describe('상세 요약·안내', () => {
  it('머리 한 줄 — 판정 불가·정상·장애', () => {
    expect(partsHeadline({ judged: false, reason: 'unreachable' }).text).toMatch(/판정 불가 — 마지막 인벤토리 수집이 장비에 닿지 못했습니다/);
    const h = partsHeadline({ judged: true, fault: 1, warn: 0, unknown: 1, absent: 2, ok: 30, total: 34, collectedAt: Date.now() });
    expect(h.tone).toBe('red');
    expect(h.text).toMatch(/장애 \*\*1\*\*/);
    expect(h.text).toMatch(/빈 슬롯 2/);
    expect(partsHeadline({ judged: true, ok: 5, total: 5 }).tone).toBe('green');
    expect(partsHeadline({ judged: true, unknown: 2, ok: 5, total: 7 }).tone).toBe('gray');
  });
  it('일부 종류 수집 실패는 정상이라는 뜻이 아니다', () => {
    expect(failedKindsNote({ judged: true, failedKinds: ['psu'] })).toMatch(/정상이라는 뜻이 아닙니다/);
    expect(failedKindsNote({ judged: true, failedKinds: [] })).toBe('');
  });
  it('구버전 엣지 안내 — 원격 + statusMissing 일 때만', () => {
    expect(statusMissingNote({ remote: true, statusMissing: true })).toMatch(/2\.728 이상으로 올리면/);
    expect(statusMissingNote({ remote: true, statusMissing: false })).toBe('');
    expect(statusMissingNote({ statusMissing: true })).toBe('');
  });
  it('파트 장애 연결 — 꺼짐·엣지 꺼짐·켜짐·권한', () => {
    const off = partFaultNote({ enabled: false, source: 'default' }, { allowed: true });
    expect(off.text).toMatch(/\*\*꺼져 있습니다\*\*/);
    expect(off.link).toBe('#/tools/part-faults');
    expect(partFaultNote({ enabled: true, edgeEnabled: false }).text).toMatch(/엣지에는 꺼져 있습니다/);
    expect(partFaultNote({ enabled: true, dbAvailable: true, open: [{}], omitted: 2 }).text).toMatch(/\*\*3건\*\*/);
    expect(partFaultNote({ enabled: true, dbAvailable: false, open: [] }).text).toMatch(/기록 DB 가 없습니다/);
    const scoped = partFaultNote({ enabled: true, scoped: true, open: [] }, { allowed: true });
    expect(scoped.link).toBe(null);
    expect(scoped.hint).toMatch(/전체 범위/);
    expect(partFaultNote({ enabled: false }, { allowed: false }).link).toBe(null);
    expect(partFaultNote(null)).toBe(null);
  });
  it('사유 문구 — 모르는 사유도 빈 칸이 아니다', () => {
    expect(Object.keys(PARTS_REASON_TEXT).sort()).toEqual(['edge-old', 'no-inventory', 'system-failed', 'unreachable']);
    expect(partsReasonText('zzz')).toBe('판정하지 못했습니다');
  });
  it('문구에 백틱이 없다(BoldText 는 **강조** 만 해석한다)', () => {
    const all = [
      partFaultNote({ enabled: false }).text, partFaultNote({ enabled: true, edgeEnabled: false }).text,
      statusMissingNote({ remote: true, statusMissing: true }), ...Object.values(PARTS_REASON_TEXT),
      linkBadge({ linkState: 'unknown' }).title, partStatusBadge({ partState: 'unknown' }).title,
    ];
    for (const t of all) expect(t).not.toMatch(/`/);
  });
});
