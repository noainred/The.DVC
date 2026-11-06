// v2.912 기능 사용 추적 — 화면 쪽 판정(주소 → 키 · 1초 머문 화면만 열람 · 보임 + 유휴 한도 안에서만 머문 시간 · 10초 묶음).
import { describe, it, expect } from 'vitest';
import { usageKeyFromHash, createUsageTracker, sendUsage, BEAT_MS, MAX_TICK_MS } from './usageTracker.js';

describe('usageKeyFromHash', () => {
  it('탭 · 도구 · 설정 하위 · 콘솔', () => {
    expect(usageKeyFromHash('#/vms')).toBe('tab:vms');
    expect(usageKeyFromHash('#/vcenters/vc1/vm/vm-1')).toBe('tab:vcenters');
    expect(usageKeyFromHash('#/hosts/host-9')).toBe('tab:hosts');
    expect(usageKeyFromHash('#/overview/exec')).toBe('tab:overview');
    expect(usageKeyFromHash('#/tools')).toBe('tab:tools');
    expect(usageKeyFromHash('#/tools/vmfinder')).toBe('tool:vmfinder');
    expect(usageKeyFromHash('#/tools/vmfinder/anything')).toBe('tool:vmfinder');
    expect(usageKeyFromHash('#/tools/serveranalysis/baremetal')).toBe('tool:serveranalysis/baremetal');
    expect(usageKeyFromHash('#/settings')).toBe('tab:settings');
    expect(usageKeyFromHash('#/settings/audit')).toBe('settings:audit');
    expect(usageKeyFromHash('#/settings/feature-usage/users')).toBe('settings:feature-usage');
    expect(usageKeyFromHash('#/console')).toBe('console:overview');
    expect(usageKeyFromHash('#/console/compute')).toBe('console:compute');
    expect(usageKeyFromHash('#/vms?q=abc')).toBe('tab:vms');
  });
  it('모르는 모양은 null(보내지 않는다)', () => {
    expect(usageKeyFromHash('')).toBe(null);
    expect(usageKeyFromHash('#/')).toBe(null);
    expect(usageKeyFromHash('#/<script>')).toBe(null);
    expect(usageKeyFromHash('#/tools/A B')).toBe(null);
    expect(usageKeyFromHash(null)).toBe(null);
  });
});

function harness({ idleMs = 5 * 60_000 } = {}) {
  const sent = [];
  const st = { t: 1_000_000, hash: '#/overview', visible: true };
  const tr = createUsageTracker({ send: (b, o) => sent.push({ ...b, final: !!o?.final }), now: () => st.t, getHash: () => st.hash, isVisible: () => st.visible, idleMs });
  const step = (ms, n = 1) => { for (let i = 0; i < n; i++) { st.t += ms; tr.tick(); } };
  return { sent, st, tr, step };
}

describe('createUsageTracker', () => {
  it('1초 이상 머문 화면만 열람 1회 — 훑고 지나간 화면은 세지 않는다', () => {
    const h = harness();
    h.step(1000);                     // 후보
    h.step(1000);                     // 1초 머묾 → 열람
    expect(h.sent).toEqual([{ k: 'tab:overview', hit: true, final: false }]);
    h.st.hash = '#/vms'; h.step(500);
    h.st.hash = '#/hosts'; h.step(500);   // vms 는 0.5초만
    h.step(1000);
    expect(h.sent.filter((s) => s.hit).map((s) => s.k)).toEqual(['tab:overview', 'tab:hosts']);
  });
  it('머문 시간은 10초마다 보내고, 화면이 바뀌면 앞 화면 몫을 먼저 보낸다', () => {
    const h = harness();
    h.step(1000, 2);
    h.step(1000, 10);
    const beats = h.sent.filter((s) => s.ms);
    expect(beats.length).toBe(1);
    expect(beats[0]).toMatchObject({ k: 'tab:overview' });
    expect(beats[0].ms).toBeGreaterThanOrEqual(BEAT_MS);
    h.st.hash = '#/tools/vmfinder'; h.step(1000, 2);
    const last = h.sent.slice(-2);
    expect(last[0]).toMatchObject({ k: 'tab:overview' });        // 앞 화면 몫
    expect(last[1]).toMatchObject({ k: 'tool:vmfinder', hit: true });
  });
  it('창이 가려지거나 유휴 한도를 넘으면 머문 시간을 더하지 않는다', () => {
    const h = harness({ idleMs: 5_000 });
    h.step(1000, 2);                  // 열람
    h.st.visible = false; h.step(1000, 20);
    expect(h.sent.filter((s) => s.ms)).toEqual([]);
    h.st.visible = true; h.tr.input(); h.step(1000, 4);     // 입력 뒤 4초
    h.step(1000, 20);                 // 5초 넘으면 멈춤
    h.tr.hidden();
    const ms = h.sent.filter((s) => s.ms).reduce((a, s) => a + s.ms, 0);
    expect(ms).toBeGreaterThanOrEqual(4000);
    expect(ms).toBeLessThanOrEqual(6000);
    expect(h.sent[h.sent.length - 1].final).toBe(true);
  });
  it('절전 뒤 깨어난 첫 틱은 몇 시간을 더하지 않는다', () => {
    const h = harness({ idleMs: 24 * 3_600_000 });
    h.step(1000, 2);
    h.step(3 * 3_600_000);            // 3시간 점프
    h.tr.stop();
    const ms = h.sent.filter((s) => s.ms).reduce((a, s) => a + s.ms, 0);
    expect(ms).toBeLessThanOrEqual(MAX_TICK_MS + 1000);
  });
  it('모르는 주소에서는 아무것도 보내지 않는다', () => {
    const h = harness();
    h.st.hash = '';
    h.step(1000, 30);
    h.tr.stop();
    expect(h.sent).toEqual([]);
  });
});

describe('sendUsage', () => {
  it('토큰이 있으면 Bearer · 본문은 키 · 실패는 던지지 않는다', async () => {
    const calls = [];
    sendUsage('tok', { k: 'tab:vms', hit: true }, { final: true }, (url, init) => { calls.push({ url, init }); return Promise.reject(new Error('net')); });
    await Promise.resolve();
    expect(calls[0].url).toBe('/api/usage/track');
    expect(calls[0].init.headers.Authorization).toBe('Bearer tok');
    expect(calls[0].init.keepalive).toBe(true);
    expect(JSON.parse(calls[0].init.body)).toEqual({ k: 'tab:vms', hit: true });
    expect(() => sendUsage('', { k: 'tab:vms' }, {}, () => { throw new Error('x'); })).not.toThrow();
  });
});
