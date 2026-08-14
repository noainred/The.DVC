// vcdSearch 단위테스트(v2.293) — Platform 인벤토리 검색의 다단어 OR·메모 매칭·자원 합계.
// 사용자 요구사항 그대로를 고정한다: "NTP WA" 입력 → NTP 포함 + WA 포함 모두, 메모 포함
// 체크 시 vSphere 메모(notes)도 대상, 일치 VM 의 CPU/메모리/디스크 총합 표시.
import { describe, it, expect } from 'vitest';
import { parseTokens, entityMatches, notesSnippet, sumVmResources, fmtGb } from './vcdSearch.js';

describe('parseTokens', () => {
  it('공백(연속 포함) 분리 + 소문자화 + 빈 토큰 제거', () => {
    expect(parseTokens('NTP  WA')).toEqual(['ntp', 'wa']);
    expect(parseTokens('  ')).toEqual([]);
    expect(parseTokens('')).toEqual([]);
  });
});

describe('entityMatches — 다단어 OR', () => {
  const T = parseTokens('NTP WA');
  it('한 토큰이라도 이름에 포함되면 일치(OR) — 사용자 예시 그대로', () => {
    expect(entityMatches('ntp-server-01', '', T, false).hit).toBe(true);   // NTP 포함
    expect(entityMatches('leshWAdb02', '', T, false).hit).toBe(true);      // WA 포함(대소문자 무시)
    expect(entityMatches('web-front-01', '', T, false).hit).toBe(false);   // 둘 다 미포함
  });
  it('메모 포함 체크 시에만 notes 매칭 + viaNotes 로 구분', () => {
    const r0 = entityMatches('web-01', '담당: NTP 운영팀', T, false);
    expect(r0.hit).toBe(false); // 체크 안 하면 메모는 대상 아님
    const r1 = entityMatches('web-01', '담당: NTP 운영팀', T, true);
    expect(r1.hit).toBe(true);
    expect(r1.viaNotes).toBe(true);  // 이름이 아니라 메모로 걸림 → 결과 행에 📝 스니펫 표시 근거
    expect(r1.token).toBe('ntp');
    // 이름으로도 걸리면 viaNotes=false(이름 우선 — 스니펫 불필요)
    expect(entityMatches('ntp-01', 'WA 메모', T, true).viaNotes).toBe(false);
  });
  it('notes null/undefined 안전', () => {
    expect(entityMatches('web-01', null, T, true).hit).toBe(false);
    expect(entityMatches(null, undefined, T, true).hit).toBe(false);
  });
});

describe('notesSnippet', () => {
  it('토큰 주변 창을 자르고 절단 시 말줄임 표시', () => {
    const s = 'A'.repeat(30) + 'NTP 서버 이관 예정' + 'B'.repeat(60);
    const snip = notesSnippet(s, 'ntp');
    expect(snip.startsWith('…')).toBe(true);
    expect(snip.endsWith('…')).toBe(true);
    expect(snip).toContain('NTP');
  });
});

describe('sumVmResources — 일치 VM 자원 총합', () => {
  it('vCPU 합·메모리 GB 반올림·디스크 사용/할당 구분', () => {
    const vms = [
      { cpuCount: 4, memMB: 8192, storageGB: 100, uncommittedGB: 50 },  // thin
      { cpuCount: 8, memMB: 16384, storageGB: 200, uncommittedGB: 0 },  // thick
    ];
    expect(sumVmResources(vms)).toEqual({ vcpu: 12, memGB: 24, diskUsedGB: 300, diskProvGB: 350 });
  });
  it('결측 필드(수집 실패 VM)는 0 취급 — NaN 오염 방지', () => {
    const r = sumVmResources([{ name: 'broken' }, { cpuCount: 2, memMB: 4096, storageGB: 40 }]);
    expect(r).toEqual({ vcpu: 2, memGB: 4, diskUsedGB: 40, diskProvGB: 40 });
  });
  it('빈 배열/undefined 안전', () => {
    expect(sumVmResources([])).toEqual({ vcpu: 0, memGB: 0, diskUsedGB: 0, diskProvGB: 0 });
    expect(sumVmResources(undefined).vcpu).toBe(0);
  });
});

describe('fmtGb', () => {
  it('1TB 미만 GB·이상 TB(소수1)', () => {
    expect(fmtGb(300)).toBe('300 GB');
    expect(fmtGb(1536)).toBe('1.5 TB');
  });
});
