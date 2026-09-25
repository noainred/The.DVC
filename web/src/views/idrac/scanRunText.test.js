/**
 * scanRunText — '법인별 iDRAC 장비 스캔' 표의 최근 결과 문구(v2.441).
 * 사용자 요구: '발견(xx대)' 표기 + 성공/실패 표시. 위임 스캔이 결과를 못 보여주던 회귀를 고정한다.
 */
import { describe, it, expect } from 'vitest';
import { describeScanRun, scanLastRunSummary } from './scanRunText.js';

describe('describeScanRun', () => {
  it('기록이 없으면 —', () => {
    const d = describeScanRun(null);
    expect(d.state).toBe('none');
    expect(d.text).toBe('—');
  });

  it('성공 — 발견 대수를 사용자 요구 형식으로 보여준다', () => {
    const d = describeScanRun({ at: 1, ok: true, found: 3, registered: 3, scanned: 254, durationMs: 45_000, agent: 'AZ' });
    expect(d.state).toBe('ok');
    expect(d.badge).toBe('성공');
    expect(d.text).toContain('발견 3대');
    expect(d.text).toContain('등록 3대');
    expect(d.text).toContain('스캔 254개');
    expect(d.tone).toBe('green');
    expect(d.title).toContain('위임(AZ)');
    expect(d.title).toContain('45초');
  });

  it('성공했지만 0대면 초록으로 강조하지 않는다(찾은 게 없는 것도 사실대로)', () => {
    const d = describeScanRun({ at: 1, ok: true, found: 0, registered: 0, scanned: 100 });
    expect(d.badge).toBe('성공');
    expect(d.text).toContain('발견 0대');
    expect(d.tone).toBe('muted');
  });

  it('무응답·인증실패는 괄호로 덧붙인다', () => {
    const d = describeScanRun({ at: 1, ok: true, found: 2, registered: 2, scanned: 254, unreachable: 250, authFailed: 2 });
    expect(d.text).toContain('(무응답 250 · 인증실패 2)');
  });

  it('차단 대역이라 찌르지 않은 IP 는 개수를 말한다(v2.537 — 조용한 제외 금지)', () => {
    const d = describeScanRun({ at: 1, ok: true, found: 1, scanned: 10, blocked: 3 });
    expect(d.extra).toContain('차단대역 제외 3');
    expect(d.text).toContain('(차단대역 제외 3)');
    // 0 이면 조각을 만들지 않는다(없는 것을 말하지 않는다)
    expect(describeScanRun({ at: 1, ok: true, found: 1, scanned: 10, blocked: 0 }).extra).toEqual([]);
  });

  it('실패 — 사유를 보여주고 툴팁에 전문', () => {
    const err = '엣지 응답 HTTP 401 — 이 엣지에 PUSH 스캔 엔드포인트가 없습니다. 경로가 없어 인증 라우터가 401 을 낸 것입니다.';
    const d = describeScanRun({ at: 1, error: err, agent: 'nb-irs' });
    expect(d.state).toBe('fail');
    expect(d.badge).toBe('실패');
    expect(d.tone).toBe('red');
    expect(d.text).toContain('엣지 응답 HTTP 401');
    expect(d.text.startsWith('실패')).toBe(false);   // 배지와 중복되지 않게
    expect(d.title).toContain(err);            // 잘리지 않은 전문
  });

  it('위임했지만 결과 미회신은 대기 — 성공으로 오인하게 두지 않는다', () => {
    const now = 1_000_000;
    const d = describeScanRun({ at: 1, delegated: true, pending: true, agent: 'HM-IRS', dispatch: 'poll', dispatchedAt: now - 300_000 }, now);
    expect(d.state).toBe('pending');
    expect(d.badge).toBe('대기');
    expect(d.text).toContain('위임(HM-IRS) 요청함');
    expect(d.text).toContain('5분째');
    expect(d.title).toContain('에이전트 폴링');
  });

  it('PUSH 대기는 방식을 구분해 안내한다', () => {
    const d = describeScanRun({ at: 1, delegated: true, pending: true, agent: 'AZ-IRS', dispatch: 'push' });
    expect(d.title).toContain('중앙→엣지 직접 PUSH');
  });

  it('구버전 기록(pending 플래그 없음)도 대기로 본다 — 위임 + found 없음', () => {
    const d = describeScanRun({ at: 1, delegated: true, agent: 'GM1' });
    expect(d.state).toBe('pending');
  });

  it('중앙 직접 스캔은 위임 표기를 붙이지 않는다', () => {
    const d = describeScanRun({ at: 1, ok: true, found: 1, registered: 1, scanned: 10 });
    expect(d.title).toContain('중앙');
    expect(d.title).not.toContain('위임');
  });
});

describe('metrics — 등록 수량 강조(v2.442, 사용자 요구)', () => {
  it('발견/등록/스캔을 조각으로 내보내고 등록에만 accent 를 붙인다', () => {
    const d = describeScanRun({ at: 1, ok: true, found: 6, registered: 6, scanned: 30, unreachable: 20 });
    expect(d.metrics).toEqual([
      { k: '발견', n: 6, unit: '대' },
      { k: '등록', n: 6, unit: '대', accent: 'red' },
      { k: '스캔', n: 30, unit: '개' },
    ]);
    expect(d.extra).toEqual(['무응답 20']);
    // 문자열도 그대로 유지된다(툴팁·구버전 호환).
    expect(d.text).toBe('발견 6대 · 등록 6대 · 스캔 30개 (무응답 20)');
  });

  it('등록 값이 없으면 등록 조각을 만들지 않는다', () => {
    const d = describeScanRun({ at: 1, ok: true, found: 2 });
    expect(d.metrics.map((m) => m.k)).toEqual(['발견']);
  });

  it('실패·대기에는 metrics 가 없다(색 강조 대상이 아니다)', () => {
    expect(describeScanRun({ at: 1, error: 'x' }).metrics).toBe(undefined);
    expect(describeScanRun({ at: 1, delegated: true, pending: true }).metrics).toBe(undefined);
  });
});

describe('v2.591 — 인증 실패와 인증 정지 건너뜀(감사 C5·F3·C3)', () => {
  it('발견 0대인데 인증 실패가 있으면 성공이 아니라 확인 필요(호박색) — 빈 대역과 구분한다', () => {
    const d = describeScanRun({ at: 1, ok: true, found: 0, registered: 0, scanned: 10, authFailed: 10 });
    expect(d.badge).toBe('확인 필요');
    expect(d.tone).toBe('amber');
    expect(d.text).toContain('인증실패 10');
    // 인증 문제가 없는 빈 대역은 그대로 '성공'(회색)
    const e = describeScanRun({ at: 1, ok: true, found: 0, registered: 0, scanned: 10 });
    expect(e.badge).toBe('성공');
    expect(e.tone).toBe('muted');
  });

  it('인증 정지로 건너뛴 IP 는 개수를 밝힌다(조용한 제외 금지)', () => {
    const d = describeScanRun({ at: 1, ok: true, found: 2, registered: 2, scanned: 8, authSkipped: 5 });
    expect(d.text).toContain('인증정지 건너뜀 5');
    expect(d.badge).toBe('성공'); // 발견이 있으면 성공
    const z = describeScanRun({ at: 1, ok: true, found: 0, scanned: 0, authSkipped: 3 });
    expect(z.badge).toBe('확인 필요');
  });

  it('최근 전체 스캔 요약은 서버 키 datacenters 를 읽는다(구버전 vcenters 도) · 단위는 대역', () => {
    expect(scanLastRunSummary(null)).toBe('');
    expect(scanLastRunSummary({ found: 1 })).toBe('');
    expect(scanLastRunSummary({ datacenters: 3, found: 5, registered: 4 })).toBe('대역 3개 · 발견 5 · 등록 4');
    expect(scanLastRunSummary({ vcenters: 2, found: 0 })).toBe('대역 2개 · 발견 0 · 등록 0');
    expect(scanLastRunSummary({ datacenters: 1, found: 0, delegated: 1, authSkipped: 2 })).toContain('인증정지 건너뜀 2');
  });
});

// v2.610(사용자 요청 '스캔하면 HPE 서버가 몇 대인지 리스트에'): iLO 계정이 없어도 HPE 대수는 보인다.
import { hpeInfo as hpeInfo2610 } from './scanRunText.js';
describe('v2.610 HPE 대수', () => {
  it('iLO 계정 없이 HPE 3대 판별 → 지표 HPE 3대 + 등록 안 됨 안내', () => {
    const d = describeScanRun({ at: 1, found: 5, registered: 5, scanned: 256, hpeDetected: 3, iloEnabled: false });
    const m = d.metrics.find((x) => x.k === 'HPE');
    expect(m.n).toBe(3); expect(m.unit).toBe('대');
    expect(d.text).toContain('HPE 3대');
    expect(d.text).toContain('iLO 계정이 없어 등록하지 않음');
  });
  it('iLO 계정으로 일부만 로그인 → 실패·미확인 대수를 밝힌다', () => {
    expect(hpeInfo2610({ hpeDetected: 4, hpeFound: 3, iloEnabled: true }).note).toBe('HPE 중 iLO 로그인 3대 · 실패·미확인 1대');
  });
  it('구버전 엣지(하한) → 대 이상', () => {
    const d = describeScanRun({ at: 1, found: 0, registered: 0, hpeDetected: 2, hpeDetectedApprox: true });
    expect(d.metrics.find((x) => x.k === 'HPE').unit).toBe('대 이상');
  });
  it('HPE 없음·iLO 계정 없음 → 칸을 늘리지 않는다', () => {
    expect(hpeInfo2610({ found: 2 })).toBe(null);
    expect(describeScanRun({ at: 1, found: 2, registered: 2 }).metrics.some((x) => x.k === 'HPE')).toBe(false);
  });
});

// v2.611 감사 그룹 A — 보류·noCreds·구버전 엣지·폐기 안내.
import { scanHoldNote } from './scanRunText.js';
describe('v2.611 iLO 스캔 체인', () => {
  it('EDGE2611-01: 위임 보류는 실패(빨강)가 아니라 보류(호박색) + 사유', () => {
    const d = describeScanRun({ at: 1, held: true, heldReason: '위임 보류 — 엣지 버전 미상(2.610 이상 필요)', agent: 'edgeA' });
    expect(d.state).toBe('held'); expect(d.badge).toBe('보류'); expect(d.tone).toBe('amber');
    expect(d.title).toContain('2.610');
  });
  it('RECENT2611-04: 계정이 없어 시도하지 않은 서버 수를 말한다', () => {
    const d = describeScanRun({ at: 1, found: 1, registered: 1, scanned: 6, noCreds: 3, iloEnabled: true, hpeFound: 1, hpeDetected: 1 });
    expect(d.extra).toContain('계정 없어 시도 안 함 3');
    expect(describeScanRun({ at: 1, found: 1, noCreds: 0 }).extra.some((x) => x.includes('계정 없어'))).toBe(false);
    expect(scanLastRunSummary({ datacenters: 1, found: 0, noCreds: 2, held: 1 })).toContain('계정 없어 시도 안 함 2');
  });
  it('EDGE2611-02: 구버전 엣지가 iLO 를 무시했으면 "iLO 계정이 없어" 가 아니라 엣지 업그레이드를 말한다', () => {
    const d = describeScanRun({ at: 1, found: 2, registered: 2, hpeDetected: 3, hpeDetectedApprox: true, iloIgnoredByEdge: true });
    expect(d.text).toContain('엣지 업그레이드 필요');
    expect(d.text).not.toContain('iLO 계정이 없어');
  });
  it('RECENT2611-02: 폐기 안내는 남은 계정으로 무엇이 계속되는지 말한다', () => {
    expect(scanHoldNote({ username: 'root', hasPassword: false, iloUsername: 'Administrator', iloHasPassword: true })).toContain('HPE(iLO) 스캔은 계속됩니다');
    expect(scanHoldNote({ username: 'root', hasPassword: true, iloUsername: 'Administrator', iloHasPassword: false })).toContain('Dell(iDRAC) 스캔은 계속됩니다');
    expect(scanHoldNote({ username: 'root', hasPassword: false, iloUsername: '', iloHasPassword: false })).toBe('스캔은 비밀번호를 입력할 때까지 보류됩니다.');
  });
});
