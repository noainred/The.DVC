/**
 * sanPerfDiagText.test.js — 사용량 진단 문구 회귀(v2.517).
 *
 * 왜 이 테스트가 필요한가: v2.516 까지 빈 상태가 **무조건** "설정에서 켜면 쌓기 시작합니다" 였다.
 * REST 장비·제한 셸 계정처럼 **켜도·기다려도 영원히 안 쌓이는** 경우까지 그 문구가 덮었고,
 * 사용자는 멀쩡한 설정을 의심하며 헤맸다. 여기서 고정하는 것은 두 가지다 —
 *   ① `waiting`('기다리면 되는가') 이 kind 마다 맞는가
 *   ② '켜세요' 같은 **조치 안내가 엉뚱한 상황에 나오지 않는가**
 */
import { describe, it, expect } from 'vitest';
import { perfDiagText, agoText, whenText, intervalText, edgePerfLine, perfCollectSummary, diagBorder } from './sanPerfDiagText.js';

const NOW = 1_700_000_000_000;
const d = (kind, facts = {}) => perfDiagText({ kind, facts }, NOW);

describe('perfDiagText — 기다리면 되는지', () => {
  it('첫 주기/첫 수집/push 대기만 waiting=true', () => {
    const waiting = ['first-cycle', 'edge-first-cycle', 'edge-pending-push'];
    const notWaiting = ['db-unavailable', 'out-of-range', 'rest-method', 'edge-no-report',
      'edge-disabled', 'edge-device-failed', 'disabled', 'device-failed', 'collected-empty'];
    for (const k of waiting) expect(d(k).waiting, k).toBe(true);
    for (const k of notWaiting) expect(d(k).waiting, k).toBe(false);
  });

  it("'기다리면' 류 표현은 waiting 인 kind 에만 나온다", () => {
    for (const k of ['rest-method', 'edge-device-failed', 'device-failed', 'edge-disabled']) {
      const t = d(k);
      expect(`${t.title}${t.body}`, k).not.toMatch(/기다리면 채워/);
    }
    expect(d('first-cycle').body).toMatch(/채워집니다/);
  });
});

describe('perfDiagText — 조치 안내가 상황과 맞아야 한다', () => {
  it("꺼짐일 때만 '수집을 켜세요' 를 말한다", () => {
    expect(d('disabled').action).toMatch(/수집을 켜세요/);
    // REST 장비는 켜도 안 쌓인다 — 켜라고 하면 거짓 안내다.
    expect(d('rest-method').action).not.toMatch(/수집을 켜세요/);
    expect(d('rest-method').title).toMatch(/REST/);
    expect(d('device-failed').action).not.toMatch(/수집을 켜세요/);
  });

  it('실패는 원문(error)을 함께 준다 — 툴팁이 아니라 본문으로', () => {
    const msg = 'rbash: portperfshow: command not found';
    const t = d('device-failed', { error: msg, errorAt: NOW - 120_000 });
    expect(t.error).toBe(msg);
    expect(t.tone).toBe('fix');
    expect(t.title).toMatch(/2분 전/);
  });

  it('엣지 미보고는 꺼짐이라 단정하지 않는다', () => {
    const t = d('edge-no-report', { agent: 'AZ' });
    expect(t.title).toMatch(/보고하지 않았습니다/);
    expect(t.title).not.toMatch(/꺼져/);
    expect(t.action).toMatch(/AZ/);
  });

  it('표본이 있는데 기간 밖이면 수집 문제라 말하지 않는다', () => {
    const t = d('out-of-range', { lastSampleAt: NOW - 8 * 86400_000 });
    expect(t.title).toMatch(/수집은 되고 있습니다/);
    expect(t.action).toMatch(/기간/);
    expect(t.tone).toBe('info');
  });

  it('diag 가 없으면 원인을 지어내지 않는다', () => {
    const t = perfDiagText(null, NOW);
    expect(t.body).toMatch(/판정할 정보를 받지 못했습니다/);
    expect(t.waiting).toBe(false);
  });

  it('주기 숫자를 문구에 박지 않는다 — 서버 값이 없으면 범위로 말한다', () => {
    expect(d('first-cycle', { intervalMs: null }).body).toMatch(/설정된 주기/);
    expect(d('first-cycle', { intervalMs: 300_000 }).body).toMatch(/5분 주기/);
  });

  it("경고색은 조치가 필요한 상황('fix')에만", () => {
    expect(diagBorder(d('device-failed').tone)).toBe('var(--amber)');
    expect(diagBorder(d('first-cycle').tone)).toBeUndefined();
    expect(diagBorder(d('out-of-range').tone)).toBeUndefined();
  });
});

describe('보조 포맷터', () => {
  it('agoText — 미래·비정상은 null(지어내지 않는다)', () => {
    expect(agoText(NOW - 30_000, NOW)).toBe('방금');
    expect(agoText(NOW - 600_000, NOW)).toBe('10분 전');
    expect(agoText(NOW - 7200_000, NOW)).toBe('2시간 전');
    expect(agoText(NOW - 3 * 86400_000, NOW)).toBe('3일 전');
    expect(agoText(0, NOW)).toBeNull();
    expect(agoText(null, NOW)).toBeNull();
    expect(agoText(NOW + 600_000, NOW)).toBeNull();
  });

  it('whenText/intervalText', () => {
    expect(whenText(null)).toBeNull();
    expect(whenText(0)).toBeNull();
    expect(typeof whenText(NOW)).toBe('string');
    expect(intervalText(30_000)).toBe('30초 주기');
    expect(intervalText(0)).toBe('설정된 주기');
  });
});

describe('edgePerfLine — 모름과 꺼짐을 구분한다', () => {
  it('보고가 없으면 "보고 없음"(꺼짐이라 말하지 않는다)', () => {
    expect(edgePerfLine(null)).toBe('보고 없음');
  });
  it('켜짐·마지막 수집·실패 수를 한 줄로', () => {
    const line = edgePerfLine({ enabled: true, at: NOW - 120_000, pushAt: NOW - 60_000, failed: 2, version: '2.517.0' }, NOW);
    expect(line).toMatch(/수집 켜짐/);
    expect(line).toMatch(/마지막 수집 2분 전/);
    expect(line).toMatch(/실패 2대/);
    expect(line).toMatch(/v2\.517\.0/);
  });
  it('수집 기록이 없으면 그렇게 말한다(0 으로 채우지 않는다)', () => {
    expect(edgePerfLine({ enabled: true, at: null }, NOW)).toMatch(/수집 기록 없음/);
  });
  it('실패 0건은 적지 않는다', () => {
    expect(edgePerfLine({ enabled: true, at: NOW, failed: 0 }, NOW)).not.toMatch(/실패/);
  });
});

describe('perfCollectSummary — 즉시와 요청을 뭉치지 않는다', () => {
  it('중앙 수집분과 엣지 요청분을 따로 말한다', () => {
    const t = perfCollectSummary({ ok: true, result: { ok: true, collected: 3, failed: 1 }, requested: ['AZ', 'PL'], alreadyQueued: [] });
    expect(t).toMatch(/중앙 직접 3대 수집/);
    expect(t).toMatch(/실패 1대/);
    expect(t).toMatch(/엣지 2곳에 재수집 요청/);
  });
  it('이미 대기 중인 엣지는 그대로 밝힌다', () => {
    const t = perfCollectSummary({ ok: true, result: { ok: true, collected: 0 }, requested: [], alreadyQueued: ['AZ'] });
    expect(t).toMatch(/이미 요청 대기 중/);
  });
  it('폴러 재진입으로 건너뛰면 그 사유를 말한다', () => {
    const t = perfCollectSummary({ ok: true, result: { ok: false, reason: '이전 수집 진행 중(겹침 방지)' }, requested: [], alreadyQueued: [] });
    expect(t).toMatch(/건너뜀\(이전 수집 진행 중/);
  });
  it('빈 입력에 문구를 지어내지 않는다', () => {
    expect(perfCollectSummary(null)).toBe('');
  });
});

const KINDS = ['db-unavailable', 'out-of-range', 'stale', 'rest-method', 'edge-no-report', 'edge-disabled',
  'edge-device-failed', 'edge-first-cycle', 'edge-push-failed', 'edge-pending-push', 'disabled',
  'device-failed', 'first-cycle', 'collected-empty'];

describe('v2.566 — 정지와 기간 문제를 구분한다', () => {
  const f = (o = {}) => ({ kind: 'stale', waiting: false, facts: { intervalMs: 300_000, lastSampleAt: Date.now() - 10 * 86400_000, agent: null, ...o } });

  it('stale 은 "수집은 되고 있습니다" 라고 말하지 않는다 — 그것이 신고된 거짓이었다', () => {
    const t = perfDiagText(f());
    expect(t.title).not.toMatch(/수집은 되고 있습니다/);
    expect(t.title).toMatch(/멈춘/);
    expect(t.waiting).toBe(false);
    expect(t.tone).toBe('bad');
  });

  it('stale 도 "예전 값은 더 긴 기간에서 보인다" 는 사실은 함께 말한다', () => {
    expect(perfDiagText(f()).body).toMatch(/예전 값은/);
  });

  it('엣지 위임이면 조치가 엣지를 가리킨다', () => {
    expect(perfDiagText(f({ agent: 'agent-WA' })).action).toMatch(/agent-WA/);
  });

  it('edge-push-failed 는 기다리라고 하지 않고 엣지 사유를 보여준다', () => {
    const t = perfDiagText({ kind: 'edge-push-failed', waiting: false, facts: { agent: 'agent-WA', edgeAt: Date.now() - 60_000, error: "Cannot access 'maxRowid' before initialization" } });
    expect(t.waiting).toBe(false);
    expect(t.tone).toBe('bad');
    expect(t.error).toMatch(/maxRowid/);
    expect(t.action).toMatch(/엣지/);
  });

  it('⚠ 어느 kind 든 title·body·action 에 ** 를 쓰지 않는다 — 이 패널은 평문으로 그린다', () => {
    /*
     * v2.566 Chromium 판독에서 실제로 잡았다: `stale` 의 body 에 `**예전 값은 보이지만**` 을 썼더니
     * **별표가 그대로 화면에 찍혔다**(이 패널은 BoldText 를 타지 않는다). 기존 12개 kind 는 어느
     * 필드에도 ** 를 쓰지 않는다 — 그 관례를 전 kind 에 대해 고정한다.
     */
    const facts = { agent: 'a', intervalMs: 300_000, lastSampleAt: 1, since: 2, edgeAt: 1, edgePushAt: 1, error: 'e', errorAt: 1, errorSource: 'a', pollerAt: 1, sampleAgeMs: 1, staleLimitMs: 1 };
    for (const kind of KINDS) {
      const t = perfDiagText({ kind, waiting: false, facts });
      for (const [k, v] of Object.entries({ title: t.title, body: t.body, action: t.action })) {
        expect(String(v || ''), `${kind}.${k}`).not.toContain('**');
      }
    }
  });

  it('⚠ 문구에 백틱을 쓰지 않는다 — BoldText 는 **강조** 만 해석한다', () => {
    for (const kind of ['stale', 'edge-push-failed']) {
      const t = perfDiagText({ kind, waiting: false, facts: { agent: 'a', intervalMs: 300_000, lastSampleAt: 1, edgeAt: 1, error: 'e' } });
      for (const v of [t.title, t.body, t.action]) expect(String(v || '')).not.toContain('`');
    }
  });
});
