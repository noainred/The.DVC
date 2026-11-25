// v2.991 IP 스캔 호스트명 — 화면 문구 · 요약(ipamHostText.js)과 에이전트 표의 nameStats 전달(scanRangeImportText.agentReportRows).
import { describe, it, expect } from 'vitest';
import { NAME_SRC, NAME_METHODS, scanNameSummary, scanNameSummaryParts, mismatchTitle, methodRows, methodStateText, nameStatsCell, nameStatsText } from './ipamHostText.js';
import { agentReportRows } from './scanRangeImportText.js';

describe('ipamHostText — 출처 · 요약', () => {
  it('출처 라벨은 서버 netNameSrc 값과 1:1 · 표시 순서는 역DNS > mDNS > NetBIOS', () => {
    expect(Object.keys(NAME_SRC).sort()).toEqual(['dns', 'manual', 'mdns', 'netbios']);
    expect(NAME_METHODS).toEqual(['dns', 'mdns', 'netbios']);
  });
  it('스캔 IP 요약은 ownerType scanned 만 세고 0 인 출처는 조각에서 뺀다', () => {
    const rows = [
      { ownerType: 'scanned', netName: 'a', netNameSrc: 'dns' },
      { ownerType: 'scanned', netName: 'B', netNameSrc: 'netbios' },
      { ownerType: 'scanned', netName: 'c', netNameSrc: 'manual' },
      { ownerType: 'scanned' },
      { ownerType: 'vm', netName: 'vm.corp', netNameSrc: 'dns' },
    ];
    const s = scanNameSummary(rows);
    expect(s).toEqual({ total: 4, named: 3, none: 1, bySrc: { manual: 1, dns: 1, mdns: 0, netbios: 1 } });
    expect(scanNameSummaryParts(s).map((p) => p.label)).toEqual(['역DNS 1', 'NetBIOS 1', '수동 1', '없음 1']);
    expect(scanNameSummaryParts(scanNameSummary([]))).toEqual([]);
  });
  it('이름 다름 설명은 다른 이름들을 출처 라벨과 함께 — 판정하지 않는다고 말한다', () => {
    expect(mismatchTitle([{ src: 'netbios', v: 'NAS-BACKUP' }])).toContain('NetBIOS: NAS-BACKUP');
    expect(mismatchTitle([{ src: 'netbios', v: 'NAS-BACKUP' }])).toContain('판정하지 않습니다');
    expect(mismatchTitle(null)).toContain('방식별 결과');
  });
});

describe('ipamHostText — IP 상세 창 방식별 줄', () => {
  it('답함 · 지난 스캔 무응답 · 응답 없음 · 묻지 않음 · 모름(옛 기록)', () => {
    const rows = methodRows({ names: { dns: { v: 'fs.corp', at: 10, miss: 0 }, netbios: { v: 'FS', at: 9, miss: 2 } }, tried: ['dns', 'netbios'] });
    expect(rows.map((r) => [r.key, r.state])).toEqual([['dns', 'found'], ['mdns', 'skipped'], ['netbios', 'stale']]);
    expect(methodStateText(rows[1])).toBe('묻지 않음(꺼짐 또는 다른 네트워크 구간)');
    expect(methodStateText(rows[2], 3)).toBe('지난 스캔 2회 연속 답하지 않았습니다 — 3회가 되면 이 이름을 지웁니다');
    expect(methodStateText(rows[0])).toBe('');
    const none = methodRows({ names: {}, tried: ['dns', 'netbios'] });
    expect(none.map((r) => r.state)).toEqual(['none', 'skipped', 'none']);
    expect(methodStateText(none[2])).toBe('응답 없음');
    expect(methodStateText({ key: 'netbios', state: 'skipped' })).toBe('묻지 않음(꺼짐)');
    const old = methodRows({ names: { dns: { v: 'x' } }, tried: null });
    expect(old.map((r) => r.state)).toEqual(['found', 'unknown', 'unknown']);
    expect(methodStateText(old[1])).toBe('—');
    expect(methodRows(null)).toEqual([]);
  });
});

describe('ipamHostText — 에이전트 표 · 상태 카드', () => {
  it('요약이 있으면 찾은 수 / 응답 수 + 방식별 설명, 없으면 이전 버전 표시(완료 보고가 있을 때만)', () => {
    const ns = { tried: { dns: 12, mdns: 1, netbios: 12 }, found: { dns: 4, mdns: 1, netbios: 3 }, named: 8, alive: 12 };
    expect(nameStatsCell({ nameStats: ns, alive: 12, at: 1 })).toEqual({ text: '8 / 12', title: '방식별 찾은 수 / 물어본 수 — 역DNS 4/12 · mDNS 1/1 · NetBIOS 3/12', noReport: false });
    expect(nameStatsCell({ nameStats: null, alive: 233, at: 5 }).noReport).toBe(true);
    expect(nameStatsCell({ nameStats: null, alive: null, at: null })).toEqual({ text: '—', title: '', noReport: false });
    expect(nameStatsCell({ nameStats: { tried: {}, found: {}, named: null }, alive: 3, at: 1 }).text).toBe('—');
    expect(nameStatsCell({ nameStats: { tried: { dns: 0 }, found: {}, named: 0, alive: 3 }, at: 1 }).title).toContain('모두 꺼져');
  });
  it('상태 카드 문구 — 물어본 방식만, 요약이 없으면 빈 글자', () => {
    expect(nameStatsText({ tried: { dns: 12, mdns: 0, netbios: 12 }, found: { dns: 4, mdns: 0, netbios: 3 }, named: 6 })).toBe('호스트명 6개 확인 · 역DNS 4 · NetBIOS 3');
    expect(nameStatsText({ tried: { dns: 0, mdns: 0, netbios: 0 }, found: {}, named: 0 })).toBe('호스트명 0개 확인 · 방식 모두 꺼짐');
    expect(nameStatsText(null)).toBe('');
    expect(nameStatsText({ named: null })).toBe('');
  });
  it('agentReportRows 가 보고의 nameStats 를 줄에 싣고 이 포탈의 마지막 실행 값이 더 새면 그것을 쓴다', () => {
    const ns = { tried: { dns: 2 }, found: { dns: 1 }, named: 1, alive: 2 };
    const ns2 = { tried: { dns: 3 }, found: { dns: 3 }, named: 3, alive: 3 };
    const rows = agentReportRows({
      agents: [{ name: '__local__' }, { name: 'edge-a' }, { name: 'edge-old' }],
      reports: { 'edge-a': { at: 100, scanned: 10, alive: 2, nameStats: ns }, 'edge-old': { at: 100, scanned: 9, alive: 1 }, __local__: { at: 50, scanned: 1, alive: 1, nameStats: ns } },
      localLast: { at: 200, scanned: 5, alive: 3, nameStats: ns2 }, now: 300,
    });
    const by = Object.fromEntries(rows.map((x) => [x.name, x]));
    expect(by['edge-a'].nameStats).toEqual(ns);
    expect(by['edge-old'].nameStats).toBe(null);
    expect(by.__local__.nameStats).toEqual(ns2);
  });
});
