/**
 * 2026-10-09 검토 S-04(리드 통합) — 세션 연장 토큰이 열린 원격 콘솔에 전달되는가 · 게이트웨이 닫힘 코드가 사유를 말하는가.
 * 서버 게이트웨이(proxy/sshGateway.js)는 연결마다 토큰 만료 시각에 닫는다 — 연장 뒤 새 토큰을 보내지 않으면 콘솔이 옛 만료 시각에 끊긴다.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { onTokenRenewed, notifyTokenRenewed, tokenAckText, _subscriberCount } from './tokenRenew.js';
import { sshCloseReasonText } from './sshSend.js';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('세션 연장 토큰 전달', () => {
  it('구독한 콘솔 전부에 새 토큰을 알리고, 해제하면 더 알리지 않는다 · 빈 토큰은 알리지 않는다', () => {
    const got = [];
    const off1 = onTokenRenewed((t) => got.push(['a', t]));
    const off2 = onTokenRenewed(() => { throw new Error('boom'); }); // 한 콘솔의 실패가 다른 콘솔을 막지 않는다
    const off3 = onTokenRenewed((t) => got.push(['c', t]));
    expect(notifyTokenRenewed('tok-2')).toBe(2);
    expect(got).toEqual([['a', 'tok-2'], ['c', 'tok-2']]);
    expect(notifyTokenRenewed('')).toBe(0);
    expect(notifyTokenRenewed(null)).toBe(0);
    off1(); off2(); off3();
    expect(_subscriberCount()).toBe(0);
    expect(notifyTokenRenewed('tok-3')).toBe(0);
  });
  it('token-ack 거부는 사유를 말하고, 성공·다른 메시지는 말하지 않는다', () => {
    expect(tokenAckText({ type: 'token-ack', ok: true })).toBeNull();
    expect(tokenAckText({ type: 'status', text: 'x' })).toBeNull();
    const t = tokenAckText({ type: 'token-ack', ok: false, code: 'session-mismatch' });
    expect(t).toContain('session-mismatch');
    expect(t).toContain('이전 만료 시각');
    expect(t).not.toContain('`');
  });
  it('세션 연장 화면이 새 토큰을 알리고, 두 콘솔이 구독·전송한다(소스 배선)', () => {
    const guard = fs.readFileSync(path.join(here, '../components/SessionExpiryGuard.jsx'), 'utf8');
    expect(guard).toMatch(/setToken\(r\.token[^\n]*\n\s*notifyTokenRenewed\(r\.token\)/);
    const con = fs.readFileSync(path.join(here, 'RemoteConsole.jsx'), 'utf8');
    expect(con).toMatch(/ws\.send\(JSON\.stringify\(\{ type: 'token', token \}\)\)/);
    expect(con).toMatch(/sendMessage\('dvc-token', token\)/);
    expect((con.match(/onTokenRenewed\(/g) || []).length).toBe(2);
    // token-ack 를 터미널 출력으로 흘리지 않는다(JSON 이 화면에 찍히던 경로)
    expect(con).toMatch(/j\.type === 'token-ack'[^\n]*return;/);
  });
});

describe('게이트웨이 닫힘 코드 — 서버 closeAll 코드와 1:1', () => {
  it('서버가 쓰는 4xxx 코드마다 사유 문구가 있다', () => {
    const srv = fs.readFileSync(path.join(here, '../../../server/src/proxy/sshGateway.js'), 'utf8');
    const codes = new Set([...srv.matchAll(/closeAll\((?:[^,()]*\?\s*)?(4\d{3})/g)].map((m) => Number(m[1])));
    for (const m of srv.matchAll(/\?\s*(4\d{3})\s*:\s*(4\d{3})/g)) { codes.add(Number(m[1])); codes.add(Number(m[2])); }
    expect(codes.size).toBeGreaterThanOrEqual(4);
    for (const c of codes) expect(sshCloseReasonText(c), `코드 ${c}`).toBeTruthy();
    expect(sshCloseReasonText(1000)).toBeNull();
  });
});
