// toolEnforcementText 회귀(v2.506 검증 반영) — '체크를 끄면 막힌다' 는 오해를 만들지 않는지 고정한다.
import { describe, it, expect } from 'vitest';
import {
  enforcementOf, enforcementSummary, KIND_BADGE,
  LEVEL_SERVER, LEVEL_PARTIAL, LEVEL_DECLARED, LEVEL_UNKNOWN,
} from './toolEnforcementText.js';

const INFO = {
  enforced: ['ipam', 'aisearch', 'explore', 'daily-health'],
  notes: {
    dsusage: ['shared-endpoint', '/api/datastores 를 대시보드가 함께 쓴다'],
    'storage-track': ['partial', '전용 하위경로만 막힌다'],
    'service-hub': ['no-api', '외부 포탈 링크'],
    roomtemp: ['other-router', '/api/admin/room-temp(adminOnly)'],
  },
};

describe('enforcementOf', () => {
  it('매핑된 도구는 서버 차단으로 표시한다', () => {
    const r = enforcementOf('ipam', INFO);
    expect(r.level).toBe(LEVEL_SERVER);
    expect(r.badge).toBe('서버 차단');
    expect(r.title).toMatch(/403/);
  });
  it('부분 집행은 enforced 목록보다 우선한다(일부만 막히는 사실이 더 중요)', () => {
    const r = enforcementOf('storage-track', INFO);
    expect(r.level).toBe(LEVEL_PARTIAL);
    expect(r.badge).toBe(KIND_BADGE.partial);
    expect(r.title).toMatch(/전용 하위경로/);
  });
  it('선언된 미집행은 사유를 그대로 보여준다', () => {
    const ds = enforcementOf('dsusage', INFO);
    expect(ds.level).toBe(LEVEL_DECLARED);
    expect(ds.badge).toBe(KIND_BADGE['shared-endpoint']);
    expect(ds.title).toMatch(/대시보드/);
    expect(enforcementOf('service-hub', INFO).badge).toBe(KIND_BADGE['no-api']);
    expect(enforcementOf('roomtemp', INFO).badge).toBe(KIND_BADGE['other-router']);
  });
  it('선언도 매핑도 없으면 미확인 — 조용히 통과시키지 않는다', () => {
    const r = enforcementOf('brand-new-tool', INFO);
    expect(r.level).toBe(LEVEL_UNKNOWN);
    expect(r.badge).toBe('미확인');
  });
  it('집행 정보를 안 내려주는 구버전 서버는 원인을 밝힌다(단정 금지)', () => {
    for (const bad of [null, undefined, {}, { notes: {} }]) {
      const r = enforcementOf('ipam', bad);
      expect(r.level).toBe(LEVEL_UNKNOWN);
      expect(r.title).toMatch(/구버전/);
    }
  });
});

describe('enforcementSummary', () => {
  it('숫자는 응답에서 센다(화면 하드코딩 금지 규칙)', () => {
    const s = enforcementSummary(['ipam', 'aisearch', 'dsusage', 'storage-track', 'nope'], INFO);
    expect(s).toMatch(/서버 차단 2개/);
    expect(s).toMatch(/부분 집행 1개/);
    expect(s).toMatch(/화면 노출만 1개/);
    expect(s).toMatch(/미확인 1개/);
  });
  it('0 인 분류는 문구에서 생략한다', () => {
    expect(enforcementSummary(['ipam'], INFO)).toBe(
      "서버 차단 1개 — '서버 차단' 이 아닌 도구는 체크를 꺼도 API 직접 호출을 막지 못합니다.",
    );
  });
  it('구버전 서버는 집행을 주장하지 않는다', () => {
    expect(enforcementSummary(['ipam'], null)).toMatch(/제공하지 않는 서버/);
  });
});
