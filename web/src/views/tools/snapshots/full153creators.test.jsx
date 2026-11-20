// 153회차 N153-4 — 만든 계정 칸: 이벤트 DB 가 31일을 다 덮지 못한 vCenter(partial) · 상한까지만 읽은 vCenter(truncated)에서
//   못 찾은 VM 을 ‘31일 안 기록 없음’ 이라고 단정하지 않는다(읽은 만큼 찾은 계정은 그대로 보인다).
import { describe, it, expect } from 'vitest';

const { creatorText } = await import('./SnapshotTool.jsx');

const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;
const DAY = 86_400_000;
const row = (vc, name) => ({ id: `${vc}:${name}`, vcenterId: vc, name });
const CR = {
  ok: true, windowDays: 31,
  byVm: { 'vp\nvp:hit': { user: 'lee.ops', ts: NOW - 2 * DAY }, 'vt\nvt:hit': { user: 'kim.ops', ts: NOW - DAY }, 'vo\nvo:hit': { user: 'park', ts: NOW - DAY } },
  vcenters: { vo: 'ok', vp: 'partial', vt: 'truncated', vs: 'site', vn: 'no-db', vl: 'log-off', vf: 'severity-filter', vd: 'not-collected' },
  coveredFrom: { vp: NOW - 8 * DAY },
};

describe('153회차 — 만든 계정 칸은 못 읽은 것을 ‘없음’ 으로 말하지 않는다', () => {
  it('partial — 못 찾은 VM 은 모름, 찾은 계정은 보이고 일부만 읽었다고 밝힌다', () => {
    const miss = creatorText(CR, row('vp', 'old'));
    expect(miss).toMatch(/31일치 다 모으지 못해 모름/);
    expect(miss).not.toMatch(/기록 없음/);
    const hit = creatorText(CR, row('vp', 'hit'));
    expect(hit).toMatch(/최근 만든 계정 lee\.ops/);
    expect(hit).toMatch(/일부만 읽음/);
  });
  it('truncated — 못 찾은 VM 도 모름(더 오래된 이벤트는 읽지 못했다)', () => {
    const miss = creatorText(CR, row('vt', 'old'));
    expect(miss).toMatch(/일부만 읽어 모름/);
    expect(miss).not.toMatch(/기록 없음/);
    expect(creatorText(CR, row('vt', 'hit'))).toMatch(/최근 만든 계정 kim\.ops .*일부만 읽음/);
  });
  it('이벤트가 쌓이지 않는 vCenter(수집 끔 · 등급 제한 · 미수집) — 사유를 말하고, 예전에 쌓인 이벤트로 찾은 계정은 보인다', () => {
    expect(creatorText(CR, row('vl', 'x'))).toMatch(/이벤트 수집이 꺼져 있어 모름/);
    expect(creatorText(CR, row('vf', 'x'))).toMatch(/경고 이상만 저장해 모름/);
    expect(creatorText(CR, row('vd', 'x'))).toMatch(/이벤트를 모으지 않아 모름/);
    for (const vc of ['vl', 'vf', 'vd']) expect(creatorText(CR, row(vc, 'x'))).not.toMatch(/기록 없음/);
    const c2 = { ...CR, byVm: { 'vd\nvd:hit': { user: 'choi', ts: NOW - 20 * DAY }, 'vl\nvl:hit': { user: 'choi', ts: NOW - 20 * DAY }, 'vf\nvf:hit': { user: 'choi', ts: NOW - 20 * DAY } } };
    for (const vc of ['vl', 'vf', 'vd']) expect(creatorText(c2, row(vc, 'hit'))).toMatch(/최근 만든 계정 choi .*일부만 읽음/);
  });
  it('ok — 예전 그대로(찾으면 계정, 못 찾으면 31일 안 기록 없음) · 위임 · DB 없음은 사유', () => {
    expect(creatorText(CR, row('vo', 'none'))).toBe('만든 계정 — 31일 안 기록 없음');
    const hit = creatorText(CR, row('vo', 'hit'));
    expect(hit).toMatch(/최근 만든 계정 park/);
    expect(hit).not.toMatch(/일부만 읽음/);
    expect(creatorText(CR, row('vs', 'x'))).toMatch(/위임 법인/);
    expect(creatorText(CR, row('vn', 'x'))).toMatch(/이벤트 DB 를 쓸 수 없어 모름/);
    for (const t of [creatorText(CR, row('vp', 'old')), creatorText(CR, row('vt', 'old'))]) expect(t.includes('`')).toBe(false);
  });
});
