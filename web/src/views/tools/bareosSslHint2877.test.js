// v2.877 작업 로그 해석 — 'Could not fetch SSL Cert'(FD → vCenter:443 접속 실패)와 그 연쇄 줄(2026-11-04 사용자 로그 JobId 32).
import { describe, it, expect } from 'vitest';
import { parseJobReport, issueHint, issueTone } from './bareosText.js';

// 사용자 로그의 모양(FD 이름 · 주소는 화면 그대로 · 플러그인 줄은 줄임)
const LOG = [
  '2026-11-04 10:12:01 bareos-dir JobId 32: Start Backup JobId 32, Job=vm-LESANXMPNJ01.2026-11-04_10.12.00_05',
  '2026-11-04 10:12:03 LESANXMPNJ01-fd JobId 32: Fatal error: python3-fd-mod: Could not fetch SSL Cert from 192.168.52.221: [Errno 111] Connection refused',
  '2026-11-04 10:12:03 LESANXMPNJ01-fd JobId 32: Fatal error: filed/fd_plugins.cc:688 Command plugin "python3:module_name=bareos-fd-vmware" requested, but job is already cancelled.',
  "2026-11-04 10:12:04 bareos-dir JobId 32: Fatal error: Director's comm line to SD dropped.",
];

describe('SSL Cert 받기 실패 · 연쇄 줄 해석', () => {
  it('사용자 로그 — 경고·오류 목록의 줄마다 해석이 붙는다', () => {
    const rep = parseJobReport(LOG);
    const texts = rep.issues.map((x) => x.text);
    const ssl = texts.find((t) => /Could not fetch SSL Cert/.test(t));
    const cancel = texts.find((t) => /already cancelled/.test(t));
    const sd = texts.find((t) => /comm line to SD dropped/.test(t));
    expect(ssl && cancel && sd).toBeTruthy();
    expect(issueHint(ssl)).toMatch(/vcserver\):443 에 접속하지 못했습니다/);
    expect(issueHint(ssl)).toMatch(/nc -vz <주소> 443/);
    expect(issueHint(cancel)).toMatch(/이미 취소된 뒤/);
    expect(issueHint(sd)).toMatch(/연결이 끊겼습니다/);
  });
  it('접속 실패의 변형(timed out · No route to host)은 같은 안내 · 이름 풀이 실패는 따로', () => {
    for (const tail of ['[Errno 110] Connection timed out', '[Errno 113] No route to host', 'timed out']) {
      expect(issueHint(`x-fd JobId 1: Fatal error: python3-fd-mod: Could not fetch SSL Cert from vc.corp: ${tail}`)).toMatch(/:443 에 접속하지 못했습니다/);
    }
    for (const tail of ['[Errno -2] Name or service not known', '[Errno -3] Temporary failure in name resolution']) {
      expect(issueHint(`x-fd JobId 1: Fatal error: python3-fd-mod: Could not fetch SSL Cert from vc.corp: ${tail}`)).toMatch(/이름을 풀지 못했습니다/);
    }
  });
  it('색은 낮추지 않는다(연쇄 줄도 오류 그대로 — 해석 문구가 연쇄일 수 있다고 말한다)', () => {
    for (const t of LOG.slice(1)) expect(issueTone(t)).toBe('err');
  });
  it('문구에 백틱이 없다(BoldText 규칙) · 모르는 줄은 해석하지 않는다', () => {
    for (const t of LOG.slice(1)) expect(issueHint(t)).not.toContain('`');
    expect(issueHint('x-fd JobId 1: Error: something nobody knows')).toBe('');
  });
  it('긴 줄도 빨리 끝난다(앞 600자만 · 유한 반복)', () => {
    const long = `Could not fetch SSL Cert ${'x'.repeat(200_000)}`;
    const t0 = performance.now();
    expect(issueHint(long)).toMatch(/:443 에 접속하지 못했습니다/);
    expect(performance.now() - t0).toBeLessThan(50);
  });
});
