import { describe, it, expect } from 'vitest';
import {
  dateText, forecastText, linkqBasis, fieldValue, linkCheckState, layoutNodes, sparkPath, TAB_GROUPS, TAB_KEYS, changeLabel, changeValue,
  macText, idleText, opticTrendText, naText, sourceText, transitBasis, perMonthText, bytesText,
} from './cvpNetText.js';

// v3.38 CVP 네트워크 기능 — 화면 문구 · 그리기 함수(판정은 서버 cvp/*.js).
describe('cvpNetText', () => {
  const NOW = Date.UTC(2026, 10, 25, 3);
  it('못 읽은 값은 0 이 아니라 —', () => {
    expect(dateText(null)).toBe('—');
    expect(dateText('')).toBe('—');
    expect(perMonthText(null, '개')).toBe('—');
    expect(bytesText(null)).toBe('—');
    expect(fieldValue('mtu', null)).toBe('못 읽음');
    expect(sparkPath([[1, null], [2, null]])).toBe('');
  });
  it('예측 문장 — 기록 부족 · 예측 없음 · 이미 넘음 · 날짜', () => {
    expect(forecastText({ state: 'short', days: 12 }, { minDays: 90 })).toBe('기록 부족(12/90일)');
    expect(forecastText({ state: 'flat' })).toBe('늘지 않음 — 예측 없음');
    expect(forecastText({ state: 'already' })).toBe('이미 넘음');
    expect(forecastText({ state: 'none' })).toBe('기록 없음');
    expect(forecastText({ state: 'eta', eta: NOW + 20 * 86_400_000 }, { now: NOW })).toMatch(/무렵\(약 20일\)$/);
    expect(forecastText({ state: 'eta', eta: NOW + 200 * 86_400_000 }, { now: NOW })).toMatch(/약 7개월/);
    expect(opticTrendText({ state: 'alreadyFault' })).toBe('이미 장애 임계 이하');
  });
  it('링크 품질 근거', () => {
    expect(linkqBasis({ errs: 40, errDays: 3, days: 7, downs: 0, rx: -12.5 }, -10)).toBe('오류 40건(3/7일) · Rx -12.5 dBm ≤ 주의 -10');
    expect(linkqBasis({ errs: 5, errDays: 1, days: 7, downs: 0, rx: null, copper: true }, -10)).toContain('구리');
    expect(linkqBasis({ errs: 5, errDays: 1, days: 7, downs: 0, rx: null, copper: false, xcvrRead: false }, -10)).toContain('트랜시버 목록 못 읽음');
    expect(linkqBasis({ errs: null, downs: 4 }, -10)).toBe('링크 내려감 4회');
  });
  it('양끝 비교 상태 · 값', () => {
    expect(linkCheckState({ items: null })).toBe('none');
    expect(linkCheckState({ items: [{ state: 'na' }] })).toBe('na');
    expect(linkCheckState({ items: [{ state: 'na' }, { state: 'diff' }] })).toBe('diff');
    expect(linkCheckState({ items: [] })).toBe('ok');
    expect(fieldValue('admin', 'down')).toBe('꺼짐');
    expect(fieldValue('lag', 'no')).toBe('단독');
  });
  it('지도 배치 — 층 순서(스파인 위) · 줄 바꿈', () => {
    const nodes = [{ id: 'a', hostname: 'leaf-1', layer: 'leaf' }, { id: 'b', hostname: 'spine-1', layer: 'spine' },
      ...Array.from({ length: 12 }, (_, i) => ({ id: `l${i}`, hostname: `leaf-x${i}`, layer: 'leaf' }))];
    const { pos, bands } = layoutNodes(nodes, { width: 1000, perRow: 10 });
    expect(bands.map((b) => b.layer)).toEqual(['spine', 'leaf']);
    expect(pos.get('b').y).toBeLessThan(pos.get('a').y);
    const ys = new Set(nodes.filter((n) => n.layer === 'leaf').map((n) => pos.get(n.id).y));
    expect(ys.size).toBe(2);
  });
  it('추이선 — null 은 선을 끊는다', () => {
    const d = sparkPath([[0, 1], [1, 2], [2, null], [3, 3], [4, 4]], { w: 40, h: 10 });
    expect((d.match(/M/g) || []).length).toBe(2);
  });
  it('탭 묶음 — 기존 탭 키를 모두 품고 새 키는 겹치지 않는다', () => {
    for (const k of ['overview', 'devices', 'models', 'traffic', 'intf', 'portmap', 'ports', 'optics', 'power', 'events', 'settings']) expect(TAB_KEYS).toContain(k);
    for (const k of ['linkq', 'topology', 'locate', 'compare']) expect(TAB_KEYS).toContain(k);
    expect(new Set(TAB_KEYS).size).toBe(TAB_KEYS.length);
    expect(TAB_GROUPS.filter((g) => g.name).map((g) => g.name)).toEqual(['현황', '포트 · 링크', '연결', '변경']);
  });
  it('전후 비교 문구', () => {
    expect(changeLabel({ kind: 'port', item: 'Ethernet1', field: 'oper' })).toBe('Ethernet1 · 링크');
    expect(changeLabel({ kind: 'bgp', item: 'default|(주소 가림)', field: 'state' })).toBe('피어 (주소 가림)(default) · 상태');
    expect(changeLabel({ kind: 'device', field: 'version' })).toBe('EOS 버전');
    expect(changeValue({ kind: 'port', field: 'speed', before: 25e9 }, 'before')).toMatch(/25/);
    expect(changeValue({ kind: 'port', field: 'added', before: null }, 'before')).toBe('');
    expect(naText(['ports', 'lldp'])).toBe('비교 못 함: 포트 · LLDP(한쪽이 못 읽음)');
    expect(naText([])).toBe('');
  });
  it('회수 · 위치 문구', () => {
    expect(idleText({ never: true, since: NOW })).toMatch(/^기록 시작\(\d{4}-\d{2}-\d{2}\) 뒤 사용 없음$/);
    expect(idleText({ never: false, idleDays: 120 })).toBe('120일 전');
    expect(macText('005056AABBCC')).toBe('00:50:56:aa:bb:cc');
    expect(sourceText(['fdb', 'cvp'])).toBe('MAC 테이블 + CVP 위치');
    expect(transitBasis({ basis: 'macs', portMacs: 300 }, 64)).toContain('300');
  });
});
