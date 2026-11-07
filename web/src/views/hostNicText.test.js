// v2.925(B-③) — vmnic 드롭·에러 판정 문구(hostNicText.js). '어느 쪽 드롭' 은 같은 창에 양쪽 값이 다 있을 때만 · 결측이 섞인 0 은 '없음' 이 아니다.
import { describe, it, expect } from 'vitest';
import { countText, countCell, sideVerdict, nicRows, verdictText, nicSummary } from './hostNicText.js';
import { ageText } from './hostNetText.js';

describe('sideVerdict — 한 방향 판정', () => {
  it('양쪽 값이 있을 때만 쪽을 말한다', () => {
    expect(sideVerdict(0, 0).side).toBe('none');
    expect(sideVerdict(3, 0).side).toBe('esxi');
    expect(sideVerdict(0, 7).side).toBe('switch');
    expect(sideVerdict(3, 7).side).toBe('both');
    expect(sideVerdict(3, 7).tone).toBe('red');
  });
  it('못 읽음 · 결측이 섞인 0 은 판정 보류(0 으로 세지 않는다)', () => {
    expect(sideVerdict(null, 0)).toMatchObject({ side: 'unknown', text: '판정 보류', why: 'ESXi 값 없음' });
    expect(sideVerdict(0, 0, { swPartial: true }).why).toBe('스위치 0 이지만 드롭 없는 표본이 섞임');
    expect(sideVerdict('', 0).side).toBe('unknown');   // Number('') === 0 함정
    expect(sideVerdict(0, 0, { esxiPartial: true }).side).toBe('unknown');
    expect(sideVerdict(0, 0, { swPartial: true }).side).toBe('unknown');
    expect(sideVerdict(4, 0, { esxiPartial: true }).side).toBe('esxi');   // 결측이 섞여도 0 보다 크면 그 드롭은 실제로 있었다
  });
  it('한쪽만 드롭이 보이고 다른 쪽을 모르면 그쪽만 말한다', () => {
    expect(sideVerdict(5, null).text).toBe('ESXi 쪽 드롭(스위치 값 없음)');
    expect(sideVerdict(null, 2).text).toBe('스위치 쪽 드롭(ESXi 값 없음)');
  });
});

describe('nicRows — vmnic 와 CVP 업링크(같은 1시간) 짝', () => {
  const data = { samples: 180, nics: [
    { nic: 'vmnic0', droppedRx: 12, droppedTx: 0, errorsRx: 0, errorsTx: 0, packetsRx: 1000, packetsTx: 800, valid: { droppedRx: 180, droppedTx: 180 }, samples: 180 },
    { nic: 'vmnic1', droppedRx: 0, droppedTx: 0, errorsRx: null, errorsTx: null, packetsRx: 1, packetsTx: 1, valid: { droppedRx: 170, droppedTx: 180 }, samples: 180, partial: true },
    { nic: 'vmnic2', droppedRx: 0, droppedTx: 0, valid: { droppedRx: 180, droppedTx: 180 }, samples: 180 },
  ] };
  const up = (nic, port, hour) => ({ nic, hostname: 'leaf1', port, hour });
  it('방향 짝 — 수신 = 스위치 Out ↔ ESXi droppedRx · 송신 = 스위치 In ↔ ESXi droppedTx', () => {
    const rows = nicRows(data, [up('vmnic0', 'Ethernet1', { inDrop: 3, outDrop: 0, samples: 12, dropN: 12 })]);
    expect(rows[0].port).toBe('leaf1 Ethernet1');
    expect(rows[0].swRx).toBe(0); expect(rows[0].swTx).toBe(3);
    expect(rows[0].rx.side).toBe('esxi');
    expect(rows[0].tx.side).toBe('switch');
    expect(verdictText(rows[0])).toBe('수신 ESXi 쪽 · 송신 스위치 쪽');
    expect(rows[0].rx.tone).toBe('amber');
  });
  it('매칭 포트 없음 · 두 개 · 표본 없는 hour 는 판정 보류', () => {
    const rows = nicRows(data, [up('vmnic2', 'Ethernet3', null), up('vmnic2', 'Ethernet4', { inDrop: 0, outDrop: 0, samples: 3, dropN: 3 })]);
    expect(rows[0].port).toBe('');
    expect(rows[0].rx).toMatchObject({ side: 'unknown', text: 'ESXi 쪽 드롭(스위치 값 없음)' });   // 매칭 포트가 없어도 ESXi 쪽 드롭은 말한다(비교는 못 함)
    expect(rows[1].rx.why).toBe('ESXi 0 이지만 수집 공백이 섞임 · 스위치 값 없음(매칭 포트 없음 · 드롭 수집 전 포함)');   // vmnic1 수신 0 인데 결측이 섞였다
    expect(rows[2].port).toBe('매칭 포트 2개');
    expect(rows[2].rx).toMatchObject({ side: 'unknown', why: '매칭 포트 2개' });
    const one = nicRows(data, [up('vmnic2', 'Ethernet3', { inDrop: null, outDrop: null, samples: 0, dropN: 0 })]);
    expect(one[2].swRx).toBe(null);
    expect(one[2].rx.side).toBe('unknown');
  });
  it('CVP 도구가 없으면(uplinks null) 스위치 칸 자체가 없다', () => {
    const rows = nicRows(data, null);
    expect(rows[0].port).toBe(null);
  });
  it('스위치 쪽 합에 드롭 없는 표본이 섞였으면 0 을 없음으로 보지 않는다', () => {
    const rows = nicRows(data, [up('vmnic2', 'Ethernet3', { inDrop: 0, outDrop: 0, samples: 12, dropN: 6 })]);
    expect(rows[2].swPartial).toBe(true);
    expect(rows[2].rx.side).toBe('unknown');
  });
});

describe('셀 · 요약 문구', () => {
  it('countText · countCell — 못 읽음은 —, 결측이 섞인 합은 (일부)', () => {
    expect(countText(null)).toBe('—'); expect(countText(1234)).toBe('1,234');
    expect(countCell({ droppedRx: 5, valid: { droppedRx: 170 }, samples: 180 }, 'droppedRx')).toMatchObject({ text: '5 (일부)', partial: true });
    expect(countCell({ droppedRx: 5, valid: { droppedRx: 180 }, samples: 180 }, 'droppedRx').text).toBe('5');
    expect(countCell({ droppedRx: null }, 'droppedRx').text).toBe('—');
  });
  it('nicSummary — 합 · 없는 카운터 · 빈 응답 · (일부) 안내', () => {
    const s = nicSummary({ samples: 180, windowStart: null, windowEnd: null, missingCounters: ['packetsTx'], nics: [{ nic: 'vmnic0', droppedRx: 2, droppedTx: null, partial: true }, { nic: 'vmnic1', droppedRx: 3, droppedTx: null }] });
    expect(s.text).toBe('vmnic 2개 · 실시간 최근 1시간(20초 표본 180개) · 수신 드롭 합 5 · 송신 드롭 합 —');
    expect(s.notes[0]).toBe('vCenter 카운터 목록에 없는 항목: 송신 패킷(그 칸은 —)');
    expect(s.notes.some((t) => t.includes('(일부)'))).toBe(true);
    const e = nicSummary({ nics: [] });
    expect(e.notes.some((t) => t.includes('단정할 수 없습니다'))).toBe(true);
    for (const t of [s.text, ...s.notes, ...e.notes]) expect(t).not.toMatch(/`/);   // BoldText 규약 — 백틱 금지
  });
  it('ageText — 1분이 안 되면 ‘0분 전’ 이 아니라 ‘1분 안’ (B-② 화면 확인)', () => {
    expect(ageText(1, 1 + 20_000)).toBe('1분 안');
    expect(ageText(1, 1 + 61_000)).toBe('1분 전');
  });
});
