// bulkRows 단위테스트(v2.295, 3차 모듈화 감사 확정 #3) — 대량 자동등록의 클라이언트 검증을
// **현재 동작 그대로** 고정한다(감사 검증자: 추출=이동, 로직 무변 — '정리'하며 조이지 말 것).
// 이 테스트는 npm run verify 릴리스 게이트에 편입되므로 기대값은 전부 실행으로 확인한 값이다.
import { describe, it, expect } from 'vitest';
import { ipMsg, parseFree, validateRows, buildTargetRows, EMPTY_ROW, TABLE_CAP, MAX_COUNT } from './bulkRows.js';

describe('ipMsg — 서버(nonCanonicalIp·SAFE_HOST)와 같은 취지의 클라 검사(드리프트 감시)', () => {
  it('IPv4: 정상/선행 0 거부/옥텟>255 거부', () => {
    expect(ipMsg('10.0.0.1')).toBe('');
    expect(ipMsg('10.0.0.01')).toBe('IPv4 형식 오류(선행 0)');   // 8진수 오해 소지 — 서버 nonCanonicalIp 와 정렬
    expect(ipMsg('10.0.0.256')).toBe('IPv4 형식 오류(0~255)');
  });
  it('IPv6 는 문자셋 검사만(의도적으로 느슨 — 서버가 최종 검증). ":::::" 도 통과가 현재 동작', () => {
    expect(ipMsg('fe80::1')).toBe('');
    expect(ipMsg(':::::')).toBe('');                    // 느슨함을 고정 — 조이면 안 됨(검증자 지적)
    expect(ipMsg('fe80::g1')).toBe('IPv6 형식 오류');   // 허용 문자 밖
  });
  it('호스트명 허용문자·빈값', () => {
    expect(ipMsg('web-01.corp_x')).toBe('');
    expect(ipMsg('bad host!')).toBe('호스트/IP 형식 오류');
    expect(ipMsg('')).toBe('IP를 입력하세요');
    expect(ipMsg('  ')).toBe('IP를 입력하세요');
  });
});

describe('parseFree — 자유형식(쉼표/공백/탭 구분, # 주석)', () => {
  it('구분자 혼용·주석·빈 줄 처리', () => {
    const rows = parseFree('# 주석\nedge1, host1, 10.0.0.1\n\nedge2\thost2 10.0.0.2\nhost-only');
    expect(rows).toEqual([
      { edge: 'edge1', hostname: 'host1', ip: '10.0.0.1' },
      { edge: 'edge2', hostname: 'host2', ip: '10.0.0.2' },
      { edge: 'host-only', hostname: '', ip: '' },  // 필드 부족 시 앞에서부터 채움(현재 동작)
    ]);
  });
  it('null/빈 입력 안전', () => {
    expect(parseFree('')).toEqual([]);
    expect(parseFree(null)).toEqual([]);
  });
});

describe('validateRows — 엣지 2단계(warn/error)·이름 중복·집계', () => {
  const EDGES = new Set(['seoul', 'tokyo']);
  it('엣지 미선택=warn(등록 가능) vs 없는 엣지=error(hard fail) 구분', () => {
    const v = validateRows([
      { edge: '', hostname: 'a', ip: '10.0.0.1' },        // warn — ok 유지
      { edge: 'busan', hostname: 'b', ip: '10.0.0.2' },   // error — ok=false
      { edge: 'seoul', hostname: 'c', ip: '10.0.0.3' },   // ok
    ], EDGES);
    expect(v.detail[0].edgeLevel).toBe('warn');
    expect(v.detail[0].ok).toBe(true);
    expect(v.detail[1].edgeLevel).toBe('error');
    expect(v.detail[1].ok).toBe(false);
    expect(v.edgeMissing).toBe(1);
    expect(v.edgeBad).toBe(1);
    expect(v.okCount).toBe(2);
    expect(v.total).toBe(3);
  });
  it('이름 중복: 대소문자 무시·첫 행은 ok, 이후 행만 실패 + dupNames 는 중복행만 집계', () => {
    const v = validateRows([
      { edge: 'seoul', hostname: 'Web01', ip: '10.0.0.1' },
      { edge: 'seoul', hostname: 'web01', ip: '10.0.0.2' },
    ], EDGES);
    expect(v.detail[0].ok).toBe(true);
    expect(v.detail[1].ok).toBe(false);
    expect(v.detail[1].msgs.some((m) => m.startsWith('이름 중복'))).toBe(true); // ⚠ prefix 결합 고정
    expect(v.dupNames).toBe(1);
  });
  it('엣지 후보가 비면(edgeSet empty) 비어있지 않은 edge 는 전부 error — UI 문구와 달라도 이것이 현재 동작', () => {
    const v = validateRows([{ edge: 'seoul', hostname: 'a', ip: '10.0.0.1' }], new Set());
    expect(v.detail[0].edgeLevel).toBe('error');
  });
  it('호스트네임 없음·IP 오류는 hard fail + 공백 트림', () => {
    const v = validateRows([{ edge: ' seoul ', hostname: '  ', ip: ' 10.0.0.999 ' }], EDGES);
    expect(v.detail[0].ok).toBe(false);
    expect(v.detail[0].msgs).toContain('호스트네임 없음');
    expect(v.ipBad).toBe(1);
  });
});

describe('buildTargetRows — import 페이로드 생성', () => {
  it('빈 줄 제외·edge 없으면 agent 키 생략·kind/path/enabled 부착', () => {
    const t = buildTargetRows([
      { edge: 'seoul', hostname: 'a', ip: '10.0.0.1' },
      { edge: '', hostname: 'b', ip: '10.0.0.2' },
      { edge: '', hostname: '', ip: '' },               // 완전 빈 줄 — 제외
    ], { kind: 'infra', path: '중앙\\A', enabled: false });
    expect(t).toEqual([
      { kind: 'infra', path: '중앙\\A', name: 'a', host: '10.0.0.1', enabled: false, agent: 'seoul' },
      { kind: 'infra', path: '중앙\\A', name: 'b', host: '10.0.0.2', enabled: false },
    ]);
    expect(Object.prototype.hasOwnProperty.call(t[1], 'agent')).toBe(false);
  });
});

describe('상수 — 서버와의 정렬 고정', () => {
  it('MAX_COUNT=서버 maxBulkRows(2000)·TABLE_CAP=500·EMPTY_ROW shape', () => {
    expect(MAX_COUNT).toBe(2000);
    expect(TABLE_CAP).toBe(500);
    expect(EMPTY_ROW()).toEqual({ edge: '', hostname: '', ip: '' });
  });
});
