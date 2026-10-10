/**
 * v2.732 점검 2회차 그룹 i2 — B5-07: 웹 SSH 콘솔 재시도·인증 실패(기준 커밋 빌드에서 가짜 WebSocket 으로 재현된 두 결함).
 *  ① 재시도마다 xterm 이 같은 칸에 쌓였다(1→4) · 늦게 닫힌 옛 소켓 이벤트가 새 시도의 단계·타이머를 바꿨다
 *  ② 인증 실패 뒤 폼이 오류 막대로 덮였고 그 '재시도' 가 **빈 비밀번호로** 대상 서버에 로그인했다(클릭당 실패 로그인 1회)
 * 판정은 순수 모듈(sshConsoleState.js)로 고정하고, 화면 배선은 주석을 제거한 소스로 본다(웹 테스트는 DOM 이 없다 — 실제 동작은 리드의 Chromium 확인).
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../test/_stripComments.js';
import {
  isSshAuthFailText, canConnect, retryAction, RETRY_NEEDS_PASSWORD, holdsPhaseOnClose, releaseConsole,
} from './sshConsoleState.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const con = stripComments(fs.readFileSync(path.join(here, 'RemoteConsole.jsx'), 'utf8'));
/** SshConsole 컴포넌트 본문만(RdpConsole 과 섞지 않는다). */
const ssh = con.slice(con.indexOf('export function SshConsole'), con.indexOf('export function RdpConsole'));
const fnBody = (name) => {
  const i = ssh.indexOf(`const ${name} = () => {`);
  expect(i, `${name} 정의`).toBeGreaterThan(-1);
  // 다음 최상위 const 정의 전까지(들여쓰기 2칸)
  const rest = ssh.slice(i + 5);
  const j = rest.search(/\n {2}const \w+ = /);
  return ssh.slice(i, i + 5 + (j < 0 ? rest.length : j));
};

describe('B5-07 판정 — 빈 비밀번호로는 접속하지 않는다', () => {
  it('canConnect: 사용자명과 비밀번호가 둘 다 있어야 한다', () => {
    expect(canConnect({ username: 'root', password: 'pw' })).toBe(true);
    expect(canConnect({ username: 'root', password: '' })).toBe(false);
    expect(canConnect({ username: '   ', password: 'pw' })).toBe(false);
    expect(canConnect({ username: 'root' })).toBe(false);
    expect(canConnect(null)).toBe(false);
    expect(canConnect({ username: 'root', password: 0 })).toBe(false);
  });
  it("retryAction: 인증 실패로 비밀번호를 지운 뒤의 '재시도' 는 폼으로 보낸다(재현: 재시도 3회의 auth 프레임이 전부 pwLen 0)", () => {
    expect(retryAction({ username: 'root', password: '' })).toBe('form');
    expect(retryAction({ username: 'root', password: 'pw' })).toBe('connect');
    expect(RETRY_NEEDS_PASSWORD).toMatch(/빈 비밀번호/);
    expect(RETRY_NEEDS_PASSWORD).not.toMatch(/`/);
  });
  it('인증 실패 문구 판정 — 게이트웨이 실제 문구(ssh2 원문 + 안내)를 잡고, 성공·연결 오류는 아니다', () => {
    expect(isSshAuthFailText('연결 실패: All configured authentication methods failed — 아이디/비밀번호를 확인하세요.')).toBe(true);
    expect(isSshAuthFailText('Permission denied (publickey,password)')).toBe(true);
    expect(isSshAuthFailText('연결 실패: connect ECONNREFUSED 10.0.0.5:22')).toBe(false);
    expect(isSshAuthFailText('')).toBe(false);
    expect(isSshAuthFailText(null)).toBe(false);
  });
  it("닫힘 이벤트는 '폼' 단계를 바꾸지 않는다 — 그 밖의 단계는 기존 규칙", () => {
    expect(holdsPhaseOnClose('form')).toBe(true);
    for (const p of ['connecting', 'live', 'error', 'closed']) expect(holdsPhaseOnClose(p)).toBe(false);
  });
});

describe('B5-07 releaseConsole — 이전 시도의 자원 정리', () => {
  it('옛 소켓은 핸들러를 먼저 떼고 닫는다 · 터미널 dispose · 관찰자 disconnect · 칸 비우기', () => {
    const order = [];
    const ws = { onopen: () => {}, onmessage: () => {}, onerror: () => {}, onclose: () => order.push('onclose-fired'), close: vi.fn(() => { order.push('close'); ws.onclose?.(); }) };
    const term = { dispose: vi.fn() };
    const ro = { disconnect: vi.fn() };
    const el = { replaceChildren: vi.fn() };
    releaseConsole({ ws, term, ro, el });
    expect(ws.close).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['close']);   // 늦게 도착하는 onclose 가 새 시도를 건드리지 않는다
    for (const k of ['onopen', 'onmessage', 'onerror', 'onclose']) expect(ws[k]).toBeNull();
    expect(term.dispose).toHaveBeenCalledTimes(1);
    expect(ro.disconnect).toHaveBeenCalledTimes(1);
    expect(el.replaceChildren).toHaveBeenCalledTimes(1);
  });
  it('없거나 이미 정리된 자원·던지는 구현에서도 예외가 없다', () => {
    expect(() => releaseConsole()).not.toThrow();
    expect(() => releaseConsole({ ws: null, term: undefined })).not.toThrow();
    const boom = () => { throw new Error('x'); };
    expect(() => releaseConsole({ ws: { close: boom }, term: { dispose: boom }, ro: { disconnect: boom }, el: { replaceChildren: boom } })).not.toThrow();
    const kids = [1, 2]; const el = { get firstChild() { return kids[0]; }, removeChild: () => kids.shift() };
    releaseConsole({ el });
    expect(kids.length).toBe(0);
  });
});

describe('B5-07 화면 배선(RemoteConsole.jsx SshConsole)', () => {
  it('connect 는 새 Terminal 을 만들기 전에 이전 자원을 정리하고, 빈 비밀번호면 폼으로 간다', () => {
    const body = fnBody('connect');
    const iGuard = body.indexOf('canConnect(creds)');
    const iRel = body.indexOf('releaseConsole(');
    const iTerm = body.indexOf('new Terminal(');
    expect(iGuard).toBeGreaterThan(-1);
    expect(iRel).toBeGreaterThan(iGuard);
    expect(iTerm).toBeGreaterThan(iRel);
    // 늦게 도는 setTimeout 은 그사이 새 시도·언마운트가 있으면 터미널을 만들지 않는다
    expect(body).toMatch(/attempt !== attemptRef\.current/);
  });
  it('소켓 핸들러 전부가 이 시도의 소켓인지 먼저 본다', () => {
    const body = fnBody('connect');
    for (const h of ['ws.onopen', 'ws.onmessage', 'ws.onerror', 'ws.onclose']) {
      const i = body.indexOf(`${h} = `);
      expect(i, h).toBeGreaterThan(-1);
      expect(body.slice(i, i + 160), h).toMatch(/!mine\(\)/);
    }
  });
  it('onclose 는 폼 유지 판정을 오류 전환보다 먼저 한다', () => {
    const body = fnBody('connect');
    const i = body.indexOf('ws.onclose = ');
    const seg = body.slice(i);
    const iHold = seg.indexOf('holdsPhaseOnClose(phaseRef.current)');
    const iErr = seg.indexOf("setPhase('error')");
    expect(iHold).toBeGreaterThan(-1);
    expect(iErr).toBeGreaterThan(iHold);
  });
  it("오류 막대의 '재시도' 는 retry(빈 비밀번호면 폼)로 가고, 폼의 접속 버튼·Enter 도 canConnect 로 막는다", () => {
    expect(ssh).toMatch(/onClick=\{retry\}>재시도</);
    expect(ssh).not.toMatch(/onClick=\{connect\}>재시도</);
    expect(fnBody('retry')).toMatch(/retryAction\(creds\) === 'form'/);
    expect(ssh).toMatch(/disabled=\{!canConnect\(creds\)\}/);
    expect(ssh).toMatch(/e\.key === 'Enter' && canConnect\(creds\) && connect\(\)/);
  });
  it('언마운트 정리도 같은 releaseConsole 을 쓰고 시도 번호를 올린다', () => {
    expect(ssh).toMatch(/useEffect\(\(\) => \(\) => \{ attemptRef\.current \+= 1; stopTimer\(\); releaseConsole\(/);
  });
});
