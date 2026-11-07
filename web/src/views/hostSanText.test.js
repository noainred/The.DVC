// v2.920 — 호스트 SAN 경로·트래픽 문구: 값 없음은 ‘—’, 확정/추정 분리, 상태 문구는 이유를 말한다.
import { describe, it, expect } from 'vitest';
import { CONF, bytesText, rateText, rwText, sanSubText, sanStateText, sanKpis, hbaTargetsText, storageNoteText, seriesRows, sanFootText, confText } from './hostSanText.js';

const d = { hours: 24, switches: 2, status: 'ok', hbas: [{ hba: 'vmhba1' }, { hba: 'vmhba1' }, { hba: 'vmhba2' }], storages: [{ confirmedPorts: ['a'], estimatedPorts: [] }, { confirmedPorts: [], estimatedPorts: ['b'] }],
  totals: { hostBytes: 1500, confirmedBytes: 1000, estimatedBytes: 500, unsplitBytes: null, measuredPorts: 2, unmeasuredPorts: 0, loggedIn: 2, zonedOnly: 1, unseen: 0, nowRead: 125_000_000, nowWrite: null }, mpTargets: 3 };

describe('문구', () => {
  it('bytes 는 TB·PB 까지 · 없으면 —', () => {
    expect(bytesText(212_856_858_276_615)).toBe('193.6 TB'); expect(bytesText(1536)).toBe('1.5 KB'); expect(bytesText(0)).toBe('0 B'); expect(bytesText(null)).toBe('—'); expect(bytesText('')).toBe('—');
  });
  it('rate 는 ×8 · 없으면 —', () => {
    expect(rateText(125_000_000)).toBe('1.00 Gbps'); expect(rateText(125_000)).toBe('1.0 Mbps'); expect(rateText(null)).toBe('—'); expect(rateText('')).toBe('—'); expect(rateText(0)).toBe('0 bps');
    expect(rwText(null, null)).toBe('—'); expect(rwText(125_000_000, null)).toBe('1.00 Gbps / —');
  });
  it('KPI — 확정·추정 따로 · 값 없음 —', () => {
    const k = sanKpis(d);
    expect(k[0].v).toBe('1.5 KB');
    // v2.935(C-①): 확정 + 실측 비율(근거 있는 몫)과 추정(IPF · 포트 비율)을 따로 — 한 숫자로 합치지 않는다
    expect(k[1].v).toBe('1000 B'); expect(k[1].s).toBe(`${CONF.confirmed.glyph} 확정 1000 B · ${CONF.measured.glyph} 실측 비율 —`);
    expect(k[2].v).toBe('≈ 500 B');
    expect(k[3].v).toBe('1.00 Gbps / —'); expect(k[4].v).toBe('—'); expect(k[4].s).toContain('아직 측정 전'); expect(k[4].s).toContain('멀티패스 타깃 3');
    const e = sanKpis({ hours: 168, totals: { measuredPorts: 0, unmeasuredPorts: 2 }, storPathScan: false });
    expect(e[0].l).toBe('7일 전송 합 · HBA 포트'); expect(e[0].v).toBe('—'); expect(e[0].s).toContain('측정 0/2 포트'); expect(e[1].v).toBe('—'); expect(e[2].v).toBe('—');
    expect(e[4].s).toContain('수집 꺼짐'); expect(e[4].s).toContain('아직 안 읽음');
  });
  it('상태 문구 — 이유를 말한다', () => {
    expect(sanStateText({ corpMissing: true })).toContain('법인');
    expect(sanStateText({ switches: 0 })).toContain('스냅샷이 없습니다');
    expect(sanStateText({ switches: 3, status: 'unseen' })).toContain('3대');
    expect(sanStateText(d)).toBe('');
    expect(sanSubText(d)).toBe('HBA 2 · 로그인 2 · 조닝만 1 · 스토리지 2');
    expect(sanSubText({ ...d, corpLimited: true })).toContain('이 법인 스위치만');
  });
  it('행 글자', () => {
    expect(hbaTargetsText({ targets: [{ name: 'PMAX-1', share: 0.75 }, { name: 'PS', share: 0.25 }] })).toBe('PMAX-1 75% · PS 25%');
    expect(hbaTargetsText({ targets: [{ name: 'PMAX-1', share: 1 }] })).toBe('PMAX-1');
    expect(hbaTargetsText({ targets: [], status: 'zoned-only' })).toBe('조닝만'); expect(hbaTargetsText({ targets: [] })).toBe('—');
    expect(storageNoteText({ registered: { type: 'powermax' }, unsplitPorts: ['x'], unmeasuredPorts: [], zonedOnlyPorts: ['y'] })).toBe('등록 powermax · 분배 불가 1 · 조닝만 1');
    expect(storageNoteText({ kind: 'host' })).toBe('어레이 미확인(평평한 이름)');
    expect(confText('confirmed')).toBe('● 확정'); expect(confText('nope')).toBe('— 타깃 없음');
  });
  it('차트 행 — null 유지 · Gbps', () => {
    expect(seriesRows({ buckets: [1, 2], sum: [125_000_000, null] })).toEqual([{ ts: 1, gbps: 1 }, { ts: 2, gbps: null }]);
    expect(seriesRows(null)).toEqual([]);
  });
  it('각주', () => {
    const t = sanFootText({ source: { kind: 'rollup' }, series: { partialBuckets: 2 }, computedAt: 1000, fabrics: [{ nsKnown: false, portsComplete: true }] }, 61_000);
    expect(t).toBe('기간 바이트 출처 집계 표 + 원본 자투리 · 일부 포트만 표본이 있는 버킷 2개는 그리지 않음 · 계산 60초 전 · 네임서버 역할이 없는 스위치가 있어 그 패브릭의 귀속은 추정');
    expect(sanFootText({ perfUnavailable: true })).toContain('DB 를 열지 못해');
  });
});
