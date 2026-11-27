/**
 * 전체 점검 132회차 — 원격 콘솔 WS 주소에 세션 토큰을 싣지 않는다(129회차 결정 D2).
 * 고치기 전: ‘/api/remote/ssh?token=<JWT>’ · RDP 연결 쿼리 ‘token=<JWT>’ — 쿼리스트링은 상위 프록시 액세스 로그 · 브라우저 기록에 남는다.
 * 고친 뒤: 접속마다 인증된 POST 로 1회용 티켓을 받아 주소에는 그 ID(‘wst=’)만 싣는다(remote/wsTicket.js · 서버 proxy/wsTicket.js).
 * 순수 판정은 모듈로, 화면 배선은 주석을 제거한 소스로 본다(웹 테스트는 DOM 이 없다 — 실제 주소는 Chromium 으로 확인).
 * web/src 전체 스윕과 실제 upgrade 는 서버 test/wsTicket132.test.js 가 맡는다.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../test/_stripComments.js';
import { WS_TICKET_PARAM, WS_TICKET_TIMEOUT_MS, wsTicketOf, requestWsTicket, sshWsUrl, rdpWsUrl, wsTicketFailText } from './wsTicket.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const con = stripComments(fs.readFileSync(path.join(here, 'RemoteConsole.jsx'), 'utf8'));
const ssh = con.slice(con.indexOf('export function SshConsole'), con.indexOf('export function RdpConsole'));
const rdp = con.slice(con.indexOf('export function RdpConsole'));
const ID = 'ab'.repeat(24);

describe('wsTicket — 순수 판정', () => {
  it('wsTicketOf: hex 티켓만 받는다(없음 · 형식 아님 · 객체는 빈 값)', () => {
    expect(wsTicketOf({ ok: true, wst: ID })).toBe(ID);
    for (const bad of [null, undefined, 'x', {}, { wst: '' }, { wst: 123 }, { wst: { a: 1 } }, { wst: 'eyJhbGciOi.payload.sig' }, { wst: `${ID}&token=x` }, { ticket: ID }]) {
      expect(wsTicketOf(bad)).toBe('');
    }
  });

  it('requestWsTicket: 인증된 POST(본문 없음 · 짧은 시한)로 받고, 못 받으면 사유를 던진다', async () => {
    const post = vi.fn(async () => ({ ok: true, wst: ID }));
    await expect(requestWsTicket(post)).resolves.toBe(ID);
    expect(post).toHaveBeenCalledWith('/remote/ws-ticket', {}, { timeoutMs: WS_TICKET_TIMEOUT_MS });
    expect(WS_TICKET_TIMEOUT_MS).toBeLessThan(30_000); // 서버 티켓 수명(30초)보다 짧게 — 받은 티켓이 이미 만료이지 않게
    await expect(requestWsTicket(async () => ({ ok: false, reason: '원격 접속 권한이 없습니다' }))).rejects.toThrow('원격 접속 권한이 없습니다');
    await expect(requestWsTicket(async () => ({}))).rejects.toThrow(/티켓/);
    await expect(requestWsTicket(async () => { throw new Error('forbidden'); })).rejects.toThrow('forbidden');
  });

  it('주소에는 티켓 ID 만 실린다 — 토큰 이름의 쿼리가 없다', () => {
    const u = sshWsUrl({ protocol: 'https:', host: 'portal.example:8443' }, ID);
    expect(u).toBe(`wss://portal.example:8443/api/remote/ssh?${WS_TICKET_PARAM}=${ID}`);
    expect(sshWsUrl({ protocol: 'http:', host: 'h:4000' }, ID)).toBe(`ws://h:4000/api/remote/ssh?wst=${ID}`);
    expect(new URL(u).searchParams.has('token')).toBe(false);
    expect([...new URL(u).searchParams.keys()]).toEqual(['wst']);
    expect(sshWsUrl({ protocol: 'http:', host: 'h' }, 'a b&token=x')).toBe('ws://h/api/remote/ssh?wst=a%20b%26token%3Dx'); // 값이 쿼리를 깨지 않는다
    expect(rdpWsUrl({ protocol: 'https:', host: 'p' })).toBe('wss://p/api/remote/rdp');
  });

  it('wsTicketFailText: 사유를 말하고 백틱을 쓰지 않는다', () => {
    expect(wsTicketFailText(new Error('원격 접속 권한이 없습니다'))).toBe('접속 티켓을 발급받지 못했습니다(원격 접속 권한이 없습니다) — 다시 시도하세요.');
    expect(wsTicketFailText(new Error('signal timed out'))).toContain('포탈 응답이 늦습니다');
    expect(wsTicketFailText(new TypeError('Failed to fetch'))).toContain('포탈에 연결하지 못했습니다');
    expect(wsTicketFailText(null)).toBe('접속 티켓을 발급받지 못했습니다 — 다시 시도하세요.');
    for (const e of [new Error('x'), null, 'y']) expect(wsTicketFailText(e)).not.toContain('`');
    expect(wsTicketFailText(new Error('가'.repeat(900))).length).toBeLessThan(260);
  });
});

describe('화면 배선(RemoteConsole.jsx — 주석 제거 후)', () => {
  it('원격 콘솔은 세션 토큰을 읽지 않는다 — 주소에 실을 값이 없다', () => {
    expect(con).not.toMatch(/getToken/);
    expect(con).not.toMatch(/[?&]token=/);
    expect(con).not.toMatch(/URLSearchParams\(\{[^}]*\btoken\b/);
  });

  it('SSH: 접속마다 티켓을 받은 뒤에 WS 를 열고, 기다리는 사이 새 시도 · 창 닫힘이면 열지 않는다', () => {
    const iTerm = ssh.indexOf('new Terminal(');
    const iTicket = ssh.indexOf('wst = await requestWsTicket(postJson)');
    const iGuard = ssh.indexOf('if (attempt !== attemptRef.current || !elRef.current) return;', iTicket);
    const iWs = ssh.indexOf('new WebSocket(sshWsUrl(location, wst))');
    expect(iTerm).toBeGreaterThan(-1);
    expect(iTicket).toBeGreaterThan(iTerm);
    expect(iGuard).toBeGreaterThan(iTicket);
    expect(iWs).toBeGreaterThan(iGuard);
    expect((ssh.match(/new WebSocket\(/g) || []).length).toBe(1);
    // 티켓은 connect 안에서 받는다 — 재시도 · 복제(자동 접속)도 connect 를 지나므로 매번 새 티켓이다
    const iConnect = ssh.indexOf('const connect = () => {');
    const iRetry = ssh.indexOf('const retry = () => {');
    expect(iTicket).toBeGreaterThan(iConnect);
    expect(iTicket).toBeLessThan(iRetry);
  });

  it('SSH: 티켓을 못 받으면 접속하지 않고 사유를 오류 막대에 보인다(토큰을 싣는 폴백 없음)', () => {
    const i = ssh.indexOf('wst = await requestWsTicket(postJson)');
    const seg = ssh.slice(i, ssh.indexOf('new WebSocket(', i));
    expect(seg).toMatch(/catch \(e\) \{[\s\S]*const why = wsTicketFailText\(e\);[\s\S]*setPhase\('error'\); setStatus\(why\); stopTimer\(\);\s*return;/);
    expect(seg).toMatch(/if \(attempt !== attemptRef\.current\) return;/); // 옛 시도의 실패가 새 시도의 화면을 바꾸지 않는다
  });

  it('RDP: 같은 응답의 WS 티켓을 연결 쿼리에 싣고, 없으면 접속하지 않는다', () => {
    expect(rdp).toMatch(/ticket = r\?\.ticket \|\| ''; wst = wsTicketOf\(r\);/);
    expect(rdp).toMatch(/if \(!ticket\) \{ setStatus\(/);
    expect(rdp).toMatch(/if \(!wst\) \{ setStatus\('접속 티켓을 발급받지 못했습니다[^']*'\); return; \}/);
    expect(rdp).toMatch(/new URLSearchParams\(\{ \[WS_TICKET_PARAM\]: wst, mappingId: mapping\.id, width: String\(w\), height: String\(h\), ticket \}\)\.toString\(\)/);
    expect(rdp).toMatch(/new Guacamole\.WebSocketTunnel\(rdpWsUrl\(location\)\)/);
    // 티켓 발급은 connect 안 — 접속(복제 자동 접속 포함)마다 새로 받는다
    expect(rdp.indexOf("postJson('/remote/rdp-ticket'")).toBeGreaterThan(rdp.indexOf('const connect = async () => {'));
  });
});
