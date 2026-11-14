/**
 * 2026-10-09 검토 S-05 — 웹의 서버 로그아웃·활동 신호(sessionActivity.js) + App 배선.
 * 서버는 자동 폴링을 활동으로 세지 않는다 — 화면이 키보드·마우스 활동을 최대 1분에 한 번 알리고, 로그아웃을 서버에 알린다.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { createActivityPinger, sendActivity, serverLogout, ACTIVITY_EVENTS, ACTIVITY_MIN_INTERVAL_MS } from './sessionActivity.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('createActivityPinger', () => {
  it('최대 1분에 한 번 — 서버 유휴 여유(120초)보다 짧은 간격', async () => {
    let t = 1_000_000; let sent = 0;
    const p = createActivityPinger({ send: () => { sent++; }, now: () => t });
    expect(p.ping(true)).toBe(true);
    await tick();
    t += 10_000; expect(p.ping()).toBe(false);
    t += ACTIVITY_MIN_INTERVAL_MS; expect(p.ping()).toBe(true);
    await tick();
    expect(sent).toBe(2);
    expect(ACTIVITY_MIN_INTERVAL_MS).toBeLessThan(120_000);
  });

  it('전송 중에는 겹쳐 보내지 않고, 실패해도 다음 활동에서 다시 보낸다', async () => {
    let t = 0; let calls = 0; let release;
    const p = createActivityPinger({ send: () => { calls++; return new Promise((_, rej) => { release = rej; }); }, now: () => t });
    p.ping(true);
    await tick();
    // v3.10.8: 전송 중 보류는 한 간격(60초) 안에서만 — 예전 판본은 120초 뒤에도 false 였다(아래 '끝나지 않는 전송' 결함).
    t += 30_000; expect(p.ping(true)).toBe(false);
    release(new Error('net'));
    await tick(); await tick();
    expect(p.ping(true)).toBe(true);
    await tick();
    expect(calls).toBe(2);
  });

  // v3.10.8(공통 기능 점검 6회차): fetch 는 기본 시한이 없다 — 끊긴 연결에서 전송이 끝나지 않으면 예전엔 그 뒤 활동 신호가
  //   영원히 나가지 않아, 사용자가 일하는 중에 서버 유휴 만료(120초 여유)로 로그아웃됐다.
  it('끝나지 않는 전송이 활동 신호를 영원히 막지 않는다 — 한 간격 뒤 다시 보낸다', async () => {
    let t = 1_000_000; let calls = 0;
    const p = createActivityPinger({ send: () => { calls++; return new Promise(() => {}); }, now: () => t });
    expect(p.ping(true)).toBe(true);
    await tick();
    t += ACTIVITY_MIN_INTERVAL_MS - 1; expect(p.ping()).toBe(false);
    t += 1; expect(p.ping()).toBe(true);
    await tick();
    expect(calls).toBe(2);
    t += ACTIVITY_MIN_INTERVAL_MS; expect(p.ping()).toBe(true);
    expect(ACTIVITY_MIN_INTERVAL_MS).toBeLessThan(120_000);
  });

  it('늦게 끝난 옛 전송이 새 전송의 보류 표시를 지우지 않는다', async () => {
    let t = 0; const rel = [];
    const p = createActivityPinger({ send: () => new Promise((r) => { rel.push(r); }), now: () => t });
    p.ping(true); await tick();
    t += ACTIVITY_MIN_INTERVAL_MS; expect(p.ping()).toBe(true);   // 옛 전송은 아직 — 시한이 지나 새로 보냄
    await tick();
    expect(rel.length).toBe(2);
    rel[0](); await tick(); await tick();                         // 옛 전송이 이제 끝남
    t += 1_000; expect(p.ping(true)).toBe(false);                  // 새 전송은 아직 진행 중 — 겹쳐 보내지 않는다
  });

  it('시계를 되돌려도 막히지 않는다(남긴 시각이 미래)', async () => {
    let t = 10_000_000; let calls = 0;
    const p = createActivityPinger({ send: () => { calls++; }, now: () => t });
    p.ping(true); await tick();
    t -= 3_600_000; expect(p.ping()).toBe(true);
    await tick();
    expect(calls).toBe(2);
  });
});

describe('sendActivity · serverLogout', () => {
  it('Bearer 토큰으로 POST, keepalive, 실패해도 던지지 않는다', async () => {
    const calls = [];
    const ok = (url, o) => { calls.push([url, o]); return Promise.resolve({ status: 200 }); };
    expect(await sendActivity('TOK', ok)).toBe(200);
    expect(await serverLogout('TOK', ok)).toBe(200);
    expect(calls.map((c) => c[0])).toEqual(['/api/auth/activity', '/api/auth/logout']);
    for (const [, o] of calls) {
      expect(o.method).toBe('POST');
      expect(o.headers.Authorization).toBe('Bearer TOK');
      expect(o.keepalive).toBe(true);
    }
    const boom = () => { throw new Error('x'); };
    await expect(serverLogout('TOK', boom)).resolves.toBe(null);
    await expect(serverLogout('TOK', () => Promise.reject(new Error('net')))).resolves.toBe(null);
    await expect(serverLogout(null, ok)).resolves.toBe(null);
  });
});

describe('App 배선(소스) — 로그아웃은 서버에 알리고, 활동 신호는 유휴 타이머와 같은 사건', () => {
  const src = fs.readFileSync(new URL('./App.jsx', import.meta.url), 'utf8');
  it('logout 이 serverLogout 을 setToken(null) 보다 먼저 부른다(토큰을 지우기 전에 읽어야 한다)', () => {
    const line = src.split('\n').find((l) => /const logout = \(\) =>/.test(l)) || '';
    expect(line).toMatch(/serverLogout\(getToken\(\)\);\s*setToken\(null\)/);
    expect(src).toMatch(/broadcastLogout\(\)/);
  });
  it('유휴 자동 로그아웃·다른 탭 로그아웃도 서버에 알린다', () => {
    expect(src).toMatch(/const doLogout = \(\) => \{ serverLogout\(getToken\(\)\);/);
    expect(src).toMatch(/LOGOUT_BROADCAST_KEY\) \{ serverLogout\(getToken\(\)\);/);
  });
  it('활동 신호는 ACTIVITY_EVENTS 로 — 웹 유휴 타이머도 같은 목록을 쓴다', () => {
    expect(src).toMatch(/const events = ACTIVITY_EVENTS;/);
    expect(src).toMatch(/ACTIVITY_EVENTS\.forEach\(\(e\) => window\.addEventListener\(e, on/);
    expect(ACTIVITY_EVENTS).toContain('keydown');
    expect(ACTIVITY_EVENTS).toContain('mousedown');
  });
});
