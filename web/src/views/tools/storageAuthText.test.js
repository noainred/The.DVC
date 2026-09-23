/**
 * storageAuthText.test.js — 인증 실패 안내 문구 회귀(v2.528).
 *
 * 사용자 신고: PowerStore PS-HG-2(엣지 HG) 401. 화면이 "계정/비밀번호 확인" 한 줄만 말해
 * **배포가 상했는지 / 장비 비밀번호가 다른지** 가릴 수 없었다.
 */
import { describe, it, expect } from 'vitest';
import { authFailInfo, credFpText, agoText, authStopInfo, authStopSummary } from './storageAuthText.js';

const FP = { user: 'admin', len: 13, hash: 'b12b', space: false, empty: false, userSpace: false };
const snapOf = (over = {}) => ({
  ok: false, error: '인증 실패(401) — 계정/비밀번호 확인',
  extra: { authStopped: { since: Date.now() - 3 * 3600_000, attempts: 4 }, credFp: FP, credFpSource: 'HG', ...over },
});

describe('authFailInfo', () => {
  it('인증 실패 흔적이 없으면 패널을 만들지 않는다(다른 오류에 이 안내를 붙이지 않는다)', () => {
    expect(authFailInfo({ ok: false, error: '수집 타임아웃', extra: {} }, {})).toBeNull();
    expect(authFailInfo({ ok: true, extra: {} }, {})).toBeNull();
    expect(authFailInfo(null, {})).toBeNull();
  });

  it('멈췄다는 사실을 반드시 말한다 — 조용히 멈추면 수집되는 줄 안다', () => {
    const r = authFailInfo(snapOf(), { agent: 'HG' });
    expect(r.stopped).toBe(true);
    expect(r.title).toMatch(/멈췄습니다/);
    expect(r.notes.join(' ')).toMatch(/주기 수집을 멈췄습니다/);
    expect(r.notes.join(' ')).toMatch(/비밀번호를 고치면 자동으로 다시 시작/);
    expect(r.notes.join(' ')).toMatch(/지금 수집|새로고침/);
  });

  it('엣지 위임이면 지문이 누구 것인지 밝히고 대조 방법을 양쪽 다 적는다', () => {
    const r = authFailInfo(snapOf(), { agent: 'HG' });
    expect(r.delegated).toBe(true);
    expect(r.fpSource).toBe('HG');
    const all = r.causes.join(' ');
    expect(all).toMatch(/엣지 'HG' 가 수집/);
    expect(all).toMatch(/다르면/);      // 배포가 상했다
    expect(all).toMatch(/같다면/);      // 장비 비밀번호가 다르다
    expect(all).toMatch(/잠갔을/);      // 계정 잠금 가능성
  });

  it('중앙 직접 수집이면 엣지 문구를 쓰지 않는다', () => {
    const r = authFailInfo(snapOf({ credFpSource: 'central' }), {});
    expect(r.delegated).toBe(false);
    expect(r.causes.join(' ')).not.toMatch(/엣지/);
    expect(r.causes.join(' ')).toMatch(/중앙이 직접 수집/);
  });

  it('★ 원인을 특정하지 않는다 — 후보를 나열한다(v2.493 규약)', () => {
    const r = authFailInfo(snapOf(), { agent: 'HG' });
    expect(r.causes.length).toBeGreaterThan(1);
    // '비밀번호가 틀렸습니다' 처럼 단정하는 문구가 없어야 한다
    expect(r.causes.join(' ')).not.toMatch(/틀렸습니다|입니다\.$/);
  });

  it("★ '지문이 같다 = 비밀번호가 같다' 라고 단정하지 않는다", () => {
    const r = authFailInfo(snapOf(), { agent: 'HG' });
    expect(r.notes.join(' ')).toMatch(/가능성이 \*\*높다\*\*|가능성이 높다/);
    expect(r.notes.join(' ')).toMatch(/되돌릴 수 없는/);
  });

  it('빈 비밀번호는 그 자체가 진단이라 다른 후보를 늘어놓지 않는다', () => {
    const r = authFailInfo(snapOf({ credFp: { ...FP, len: 0, empty: true } }), { agent: 'HG' });
    expect(r.causes.length).toBe(1);
    expect(r.causes[0]).toMatch(/비밀번호가 비어 있습니다/);
    expect(r.fp).toMatch(/없음/);
  });

  it('앞뒤 공백을 드러낸다(화면에서는 보이지 않는 사고 원인)', () => {
    const r = authFailInfo(snapOf({ credFp: { ...FP, space: true } }), { agent: 'HG' });
    expect(r.causes.join(' ')).toMatch(/앞뒤에 공백/);
    expect(r.fp).toMatch(/앞뒤공백/);
  });

  it('정지 기록이 없어도 지문만 있으면 표시한다(구버전 엣지 대비)', () => {
    const r = authFailInfo({ ok: false, error: '401', extra: { credFp: FP } }, { agent: 'HG' });
    expect(r.stopped).toBe(false);
    expect(r.since).toBeNull();
    expect(r.notes.join(' ')).not.toMatch(/멈췄습니다/);   // 멈추지 않았으면 멈췄다고 하지 않는다
    expect(r.fp).toBeTruthy();
  });
});

describe('credFpText — 평문을 만들지 않는다', () => {
  it('계정·길이·해시만 담는다', () => {
    expect(credFpText(FP)).toBe("계정 'admin' · 비번 13자·#b12b");
    expect(credFpText(null)).toBeNull();
  });
  it('계정이 비면 지어내지 않는다', () => {
    expect(credFpText({ ...FP, user: '' })).toMatch(/계정 없음/);
  });
});

describe('agoText', () => {
  it('값이 없으면 null(지어내지 않는다)', () => {
    for (const v of [null, undefined, 0, NaN, 'x']) expect(agoText(v)).toBeNull();
  });
  it('경계', () => {
    const now = 1_700_000_000_000;
    expect(agoText(now - 30_000, now)).toBe('방금');
    expect(agoText(now - 5 * 60_000, now)).toBe('5분 전');
    expect(agoText(now - 3 * 3600_000, now)).toBe('3시간 전');
    expect(agoText(now - 50 * 3600_000, now)).toBe('2일 전');
  });
});

// ── v2.541: 모양이 다른 값을 지문인 척 그리지 않는다 ────────────────────────────────
// Chromium 판독에서 발견: 문자열이 들어오면 `계정 없음 · 비번 undefined자·#undefined` 라는
// **그럴듯한 한 줄**이 만들어졌다. 진짜 지문과 나란히 놓이면 사용자가 그것을 대조 값으로 읽는다.
describe('credFpText — 읽지 못한 값은 지어내지 않는다(v2.541)', () => {
  it('문자열·배열·숫자는 null 이다', () => {
    expect(credFpText('svc:12:#4a1f')).toBeNull();
    expect(credFpText(['svc', 12])).toBeNull();
    expect(credFpText(42)).toBeNull();
  });
  it('길이나 해시를 읽지 못하면 null 이다', () => {
    expect(credFpText({ user: 'svc' })).toBeNull();
    expect(credFpText({ user: 'svc', len: 12 })).toBeNull();
    expect(credFpText({ user: 'svc', hash: 'ab12' })).toBeNull();
  });
  it('빈 비밀번호(len:0)는 그 자체가 진단이라 계속 표시한다', () => {
    expect(credFpText({ user: 'svc', len: 0, empty: true })).toMatch(/비번 \*\*없음\*\*/);
  });
  it('어떤 입력에도 undefined 를 찍지 않는다', () => {
    for (const bad of ['x', 42, [], {}, { user: 'a' }, { len: 3 }, { hash: 'z' }]) {
      const out = credFpText(bad);
      expect(out === null || !String(out).includes('undefined')).toBe(true);
    }
  });
});

/* v2.590 — 인증 실패 '정지' 안내(도구 공통: vCenter·iDRAC·NSX·SAN·PDU·GPU·베어메탈). 기준 시각은 고정한다(v2.517). */
describe('authStopInfo(v2.590)', () => {
  const NOW = 1_800_000_000_000;
  const stop = { since: NOW - 3 * 3_600_000, at: NOW - 5 * 60_000, attempts: 3, reason: 'vCenter 인증 실패(InvalidLogin)' };
  it('정지 사실·시점·횟수·사유를 말하고 강조는 BoldText 형식(별표 두 개)만 쓴다', () => {
    const r = authStopInfo(stop, { what: '이 vCenter', manual: '연결 테스트', now: NOW });
    expect(r.short).toBe('인증 실패 정지');
    expect(r.text).toMatch(/\*\*인증 실패로 이 vCenter의 주기 수집을 멈췄습니다\*\*/);
    expect(r.text).toMatch(/실패 3회/);
    expect(r.text).toMatch(/계정이 잠기기 때문/);
    expect(r.text).toMatch(/사유: vCenter 인증 실패\(InvalidLogin\)/);
    expect(r.text).not.toMatch(/`/);   // 백틱은 BoldText 가 해석하지 않는다(v2.576 스윕)
  });
  it('수동 버튼 이름이 있으면 막지 않는다고 말하고, 조사는 받침에 맞춘다', () => {
    expect(authStopInfo(stop, { manual: '연결 테스트', now: NOW }).text).toMatch(/'연결 테스트'는 막지 않습니다/);
    expect(authStopInfo(stop, { manual: '지금 수집', now: NOW }).text).toMatch(/'지금 수집'은 막지 않습니다/);
    expect(authStopInfo(stop, { now: NOW }).text).not.toMatch(/막지 않습니다/);   // 없는 버튼을 말하지 않는다
  });
  it('횟수를 모르면 지어내지 않는다 — null·빈 문자열은 0회가 아니다(Number(null)===0 함정)', () => {
    expect(authStopInfo({ ...stop, attempts: null }, { now: NOW }).attempts).toBe(null);
    expect(authStopInfo({ ...stop, attempts: '' }, { now: NOW }).text).not.toMatch(/실패 0회/);
  });
  it('모양이 다른 값은 null(그럴듯한 문장을 만들지 않는다)', () => {
    expect(authStopInfo(null)).toBe(null);
    expect(authStopInfo('stopped')).toBe(null);
    expect(authStopInfo([stop])).toBe(null);
  });
});

describe('authStopSummary(v2.590)', () => {
  it('비어 있으면 문구를 만들지 않는다', () => {
    expect(authStopSummary([])).toBe('');
    expect(authStopSummary(null)).toBe('');
  });
  it('개수·이름(최대 4개 + 외 N)과 조치를 말한다', () => {
    const list = ['a', 'b', 'c', 'd', 'e'].map((n) => ({ name: n }));
    const t = authStopSummary(list, { unit: '대', what: 'PDU' });
    expect(t).toMatch(/\*\*PDU 5대는 인증 실패로 주기 수집을 멈췄습니다\*\*/);
    expect(t).toMatch(/a · b · c · d 외 1대/);
    expect(t).toMatch(/비밀번호를 고치면 자동으로 다시 시작/);
    expect(authStopSummary([{ id: 'x' }], { unit: '곳', what: 'vCenter' })).toMatch(/vCenter 1곳은/);
  });
});
