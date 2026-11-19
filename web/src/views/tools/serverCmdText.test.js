import { describe, it, expect } from 'vitest';
import { CODE_TEXT, codeTone, pickIssue, sourceText, osOf, paramsText, resultText, msText, resultCounts, copyAllText } from './serverCmdText.js';

const srv = (o = {}) => ({ id: 's1', name: 'kr-db-01', host: '192.0.2.11', port: 22, corp: 'vcA', os: 'linux', agent: '', enabled: true, account: { source: 'os' }, ...o });
const LIN = { id: 'df-inode', os: ['linux'], params: [] };
const BOTH = { id: 'svc-state', os: ['linux', 'windows'], params: [{ name: 'unit', label: '서비스 이름' }] };

describe('서버 명령 실행 — 표시 도우미', () => {
  it('고를 수 있나 — 엣지 · 수집 끔 · 계정 없음 · 승인 대기 · 상태 파일 · 프리셋에 없는 OS 는 막는다(이유를 그 줄에)', () => {
    expect(pickIssue(srv(), BOTH)).toBe(null);
    expect(pickIssue(srv({ agent: 'pl-edge' }), BOTH).label).toBe('엣지 pl-edge 포탈의 같은 화면에서');
    expect(pickIssue(srv({ enabled: false }), BOTH).label).toBe('수집 끔');
    expect(pickIssue(srv({ account: { source: 'none' } }), BOTH).label).toBe('계정 없음');
    expect(pickIssue(srv({ account: { source: 'none', pending: true } }), BOTH).label).toBe('승인 대기');
    expect(pickIssue(srv({ account: { source: 'none', unreadable: true } }), BOTH).tone).toBe('bad');
    expect(pickIssue(srv({ os: 'windows' }), LIN).label).toBe('이 프리셋은 Windows 에 없음');
    // OS 미지정은 Linux 로 붙는다(코어와 같은 규칙) — Linux 전용 프리셋을 고를 수 있다
    expect(osOf(srv({ os: '' }))).toBe('linux');
    expect(pickIssue(srv({ os: '' }), LIN)).toBe(null);
    // 프리셋을 아직 안 골랐으면 OS 는 보지 않는다
    expect(pickIssue(srv({ os: 'windows' }), null)).toBe(null);
  });
  it('결과 글 — 끝 코드가 0 이 아니어도 실패로 치지 않는다 · 값이 없으면 ‘—’', () => {
    expect(resultText({ code: 'ok', exit: 0 })).toBe('실행됨 · 끝 코드 0');
    expect(resultText({ code: 'ok', exit: 3 })).toBe('실행됨 · 끝 코드 3');
    expect(resultText({ code: 'auth-rejected', exit: null })).toBe('로그인 거부');
    expect(resultText(null)).toBe('—');
    expect(codeTone('ok')).toBe('ok'); expect(codeTone('exec-timeout')).toBe('warn'); expect(codeTone('auth-rejected')).toBe('bad');
    expect(CODE_TEXT['no-plan']).toBe('이 OS 에 없는 프리셋');
    expect(msText(null)).toBe('—'); expect(msText('')).toBe('—'); expect(msText(1234)).toBe('1.2초');
  });
  it('합계 — 실행됨 · 시한/잘림 · 실행 못 함을 따로 센다(끝 코드 0 아님은 실행됨 안에서 따로)', () => {
    const c = resultCounts([{ ran: true, exit: 0 }, { ran: true, exit: 1 }, { ran: true, partial: true, exit: null }, { ran: false, code: 'auth-rejected' }]);
    expect(c).toEqual({ ran: 2, partial: 1, failed: 1, nonZero: 1 });
  });
  it('값 · 계정 글 · 전체 복사', () => {
    expect(paramsText(BOTH, { unit: 'chronyd' })).toBe('서비스 이름 chronyd');
    expect(paramsText(LIN, {})).toBe('');
    expect(sourceText(srv({ account: { source: 'os', via: 'winrm' } }))).toBe('OS 종류에서 물려받음 · WinRM');
    expect(sourceText(srv({ account: { source: 'own' } }))).toBe('따로 정함');
    const t = copyAllText('서비스 상태', [{ name: 'a', exit: 0, out: 'x' }, { name: 'b', exit: null, out: '', err: 'denied', cut: true }]);
    expect(t).toBe('### a — 서비스 상태 · 끝 코드 0\nx\n\n### b — 서비스 상태 · 잘림\n(출력 없음)\n--- 오류 출력\ndenied');
  });
});
