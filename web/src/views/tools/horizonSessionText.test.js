/**
 * horizonSessionText.test.js — Horizon 실시간 사용자 화면 문구·판정 회귀 고정(v2.525).
 *
 * 웹 테스트는 node 환경(DOM 없음)이라 컴포넌트 렌더를 볼 수 없다 — 그래서 **판정과 문구**를
 * 여기서 고정한다. 특히 `waiting`('기다리면 채워지는가')이 틀리면 화면이 "기다리세요" 라고
 * 말해 놓고 영원히 안 채워진다(v2.517 에서 확정된 유형).
 */
import { describe, it, expect } from 'vitest';
import {
  collectStateNote, connectedText, unionNote, combinedNote, partialNote,
  provenanceText, sinceNote, intervalText, agoText, kindTone, kindAdvice, authStopNote,
  KIND_TONE, KIND_ADVICE, NAME_MASK_NOTE, TRUST_NOTE, SESSION_PATH_NOTE, SOURCE_STATE_LABEL,
} from './horizonSessionText.js';

const base = { registered: 1, targets: 1, settings: { enabled: true, intervalMs: 300_000 }, db: { available: true }, lastReadAt: 1_700_000_000_000, total: { serversOk: 1, serversFailed: 0 } };

describe('collectStateNote — 비어 있는 이유를 한 문구로 덮지 않는다', () => {
  it('DB 를 못 쓰면 그 사유를 그대로 말한다(기다려도 안 된다)', () => {
    const n = collectStateNote({ ...base, db: { available: false, error: 'node:sqlite 없음' } });
    expect(n.kind).toBe('db');
    expect(n.waiting).toBe(false);
    expect(n.text).toContain('node:sqlite 없음');
  });

  it('등록된 서버가 없으면 등록을 안내한다', () => {
    const n = collectStateNote({ ...base, registered: 0 });
    expect(n.kind).toBe('no-server');
    expect(n.waiting).toBe(false);
  });

  it('수집이 꺼져 있으면 켜라고 말한다 — 기다리라고 하지 않는다', () => {
    const n = collectStateNote({ ...base, settings: { ...base.settings, enabled: false } });
    expect(n.kind).toBe('off');
    expect(n.waiting).toBe(false);
    expect(n.text).toContain('5분 주기');
  });

  it('첫 수집 전이면 기다리면 된다고 말한다(유일하게 waiting=true)', () => {
    const n = collectStateNote({ ...base, lastReadAt: null });
    expect(n.kind).toBe('first');
    expect(n.waiting).toBe(true);
  });

  it('전 서버 실패는 사용자 0명이 아니라 확인 불가라고 말한다', () => {
    const n = collectStateNote({ ...base, total: { serversOk: 0, serversFailed: 2 } });
    expect(n.kind).toBe('all-failed');
    expect(n.tone).toBe('error');
    expect(n.text).toContain('확인 불가');
    expect(n.waiting).toBe(false);
  });

  it('일부 실패는 수치가 하한이라고 밝힌다', () => {
    const n = collectStateNote({ ...base, total: { serversOk: 1, serversFailed: 1 } });
    expect(n.kind).toBe('partial');
    expect(n.text).toContain('하한');
  });

  it('상태 필드를 못 읽으면 접속 중 인원을 셀 수 없다고 말한다', () => {
    const n = collectStateNote({ ...base, total: { serversOk: 1, serversFailed: 0, stateBlind: true } });
    expect(n.kind).toBe('state-blind');
  });

  it('정상이면 배너를 띄우지 않는다(같은 말로 화면을 뒤덮지 않는다)', () => {
    const n = collectStateNote(base);
    expect(n.kind).toBe('ok');
    expect(n.text).toBe('');
  });

  it('데모 모드는 없는 세션을 지어내지 않는다고 밝힌다', () => {
    const n = collectStateNote({ ...base, mock: true });
    expect(n.kind).toBe('mock');
    expect(n.text).toContain('지어내지');
  });

  it('주기 숫자를 문구에 박지 않는다 — 서버가 준 값을 쓴다', () => {
    const n = collectStateNote({ ...base, settings: { enabled: false, intervalMs: 20 * 60_000 } });
    expect(n.text).toContain('20분 주기');
  });
});

describe('connectedText — 못 세는 것을 0 이라 말하지 않는다', () => {
  it('접속 중 인원을 모르면 —', () => {
    expect(connectedText({ usersConnected: null })).toBe('—');
    expect(connectedText(null)).toBe('—');
  });
  it('0 명은 0 으로 표시한다(모르는 것과 다르다)', () => {
    expect(connectedText({ usersConnected: 0 })).toBe('0');
    expect(connectedText({ usersConnected: 3 })).toBe('3');
  });
});

describe('unionNote — 합집합과 서버별 합의 차이를 밝힌다', () => {
  it('차이가 없으면 그 사실을 말한다', () => {
    expect(unionNote({ users: 3, usersByServerSum: 3 })).toContain('겹치는 계정이 없습니다');
  });
  it('사용자가 0명이면 공허한 단정을 하지 않는다', () => {
    // 서버가 0대일 때 '겹치는 계정이 없습니다' 가 그대로 나왔다(v2.525 Chromium 판독).
    expect(unionNote({ users: 0, usersByServerSum: 0 })).toBe('');
  });
  it('차이가 있으면 몇 명이 여러 서버에 걸쳐 있는지 말한다', () => {
    const t = unionNote({ users: 3, usersByServerSum: 5 });
    expect(t).toContain('차이 2명');
  });
  it('수치가 없으면 빈 문구', () => {
    expect(unionNote({ users: null, usersByServerSum: null })).toBe('');
  });
});

describe('combinedNote / partialNote — 전체가 아니면 전체라고 말하지 않는다', () => {
  it('겹친 인원을 밝힌다', () => {
    const t = combinedNote({ union: 4, sum: 5, both: 1, sidOnly: 0 });
    expect(t).toContain('4명');
    expect(t).toContain('1명');
  });
  it('SID 만 있는 계정은 겹칠 수 없다는 사실을 밝힌다', () => {
    expect(combinedNote({ union: 2, sum: 2, both: 0, sidOnly: 1 })).toContain('겹치지 않습니다');
  });
  it('빠진 출처와 그 상태를 적는다', () => {
    const t = partialNote({ partial: true, missingSources: [{ key: 'vdi', label: 'Horizon(VDI)', state: 'off' }] });
    expect(t).toContain('전체가 아닙니다');
    expect(t).toContain('수집 꺼짐');
  });
  it('빠진 출처가 없으면 경고하지 않는다', () => {
    expect(partialNote({ partial: false })).toBe('');
  });
  it('출처 상태 라벨이 네 가지 모두 있다', () => {
    for (const k of ['ok', 'off', 'failed', 'unavailable']) expect(SOURCE_STATE_LABEL[k]).toBeTruthy();
  });
});

describe('provenanceText — 무엇으로 읽었는지 밝힌다', () => {
  it('계정·상태 필드와 페이지 수를 적는다', () => {
    const t = provenanceText({ ok: true, usedUserKey: 'user_name', usedStateKey: 'session_state', pages: 2 });
    expect(t).toContain('user_name');
    expect(t).toContain('session_state');
    expect(t).toContain('2페이지');
  });
  it('상태 필드가 없으면 구분할 수 없다고 적는다', () => {
    expect(provenanceText({ ok: true, usedUserKey: 'user_name' })).toContain('구분할 수 없습니다');
  });
  it('SID 로 센 경우 이름을 표시할 수 없다고 적는다', () => {
    expect(provenanceText({ ok: true, usedUserKey: 'user_id', userIdOnly: true })).toContain('SID');
  });
  it('상한으로 자른 것은 개수를 밝힌다', () => {
    const t = provenanceText({ ok: true, usedUserKey: 'user_name', usedStateKey: 'session_state', truncated: true, usersOmitted: 7, poolsOmitted: 2 });
    expect(t).toContain('일부만');
    expect(t).toContain('7명');
    expect(t).toContain('2개');
  });
  it('실패한 서버에는 근거가 없다', () => {
    expect(provenanceText({ ok: false })).toBe('');
  });
});

describe('sinceNote — 수집 시작이라 단정하지 않는다', () => {
  const NOW = 1_700_000_000_000;
  it('보존 경계에 가까우면 either 로 밝힌다', () => {
    const r = sinceNote({ span: { first: NOW - 30 * 86_400_000 }, retentionDays: 30, now: NOW });
    expect(r.kind).toBe('either');
    expect(r.text).toContain('기다려도 채워지지 않습니다');
  });
  it('경계에서 멀면 수집 시작으로 본다', () => {
    const r = sinceNote({ span: { first: NOW - 3 * 86_400_000 }, retentionDays: 180, now: NOW });
    expect(r.kind).toBe('start');
    expect(r.text).not.toContain('기다려도');
  });
  it('추이가 없으면 없다고 말한다', () => {
    expect(sinceNote({ span: null }).kind).toBe('none');
  });
});

describe('보조 문구', () => {
  it('intervalText 는 알 수 없는 값을 지어내지 않는다', () => {
    expect(intervalText(null)).toContain('알 수 없습니다');
    expect(intervalText(300_000)).toBe('5분 주기');
  });
  it('agoText 경계', () => {
    const n = 1_700_000_000_000;
    expect(agoText(null, n)).toBe('—');
    expect(agoText(n - 30_000, n)).toBe('30초 전');
    expect(agoText(n - 120_000, n)).toBe('2분 전');
    expect(agoText(n - 2 * 3_600_000, n)).toBe('2시간 전');
    expect(agoText(n - 3 * 86_400_000, n)).toBe('3일 전');
  });
  it('판정마다 색조와 조치 문구가 있다', () => {
    for (const k of ['ok', 'auth', 'no-endpoint', 'unparsed', 'timeout', 'http', 'error', 'mock', 'disabled']) {
      expect(KIND_TONE[k]).toBeTruthy();
      expect(typeof KIND_ADVICE[k]).toBe('string');
    }
    // '확인 불가' 계열을 빨강으로 칠하지 않는다(실패와 조치가 다르다)
    expect(kindTone('no-endpoint')).toBe('amber');
    expect(kindTone('unparsed')).toBe('amber');
    expect(kindTone('auth')).toBe('red');
    expect(kindAdvice('auth')).toContain('자동 재시도');
    expect(kindAdvice('없는키')).toBe('');
  });
  it("'인증 실패 정지'(v2.535)는 'auth' 와 구분되고 재개 방법을 말한다", () => {
    // 조치가 같아 보여도 사용자가 알아야 할 사실이 다르다 — 지금은 시도조차 하지 않는다.
    expect(KIND_TONE['auth-stopped']).toBe('red');
    const a = kindAdvice('auth-stopped');
    expect(a).toContain('주기 수집을 멈췄습니다');
    expect(a).toContain('자동으로 재개');      // 비밀번호를 고치면 버튼 없이 재개된다
    expect(a).toContain('지금 수집');          // 수동 실행은 막히지 않는다
    expect(a).not.toBe(KIND_ADVICE.auth);
  });
  it('정지 시점·횟수를 말한다 — 없는 값은 지어내지 않는다', () => {
    const n = 1_700_000_000_000;
    const r = authStopNote({ since: n - 3 * 3_600_000, at: n - 300_000, attempts: 7, reason: '인증 실패(401)' }, n);
    expect(r.text).toContain('3시간 전부터 정지');
    expect(r.text).toContain('실패 7회');
    expect(r.text).toContain('마지막 시도 5분 전');
    expect(r.text).toContain('사유: 인증 실패(401)');
    // ⚠ `Number(null) === 0` — 횟수를 못 읽으면 '0회' 라고 말하지 않는다(v2.525 규약)
    const noAttempt = authStopNote({ since: n - 60_000, at: n, attempts: null }, n);
    expect(noAttempt.attempts).toBe(null);
    expect(noAttempt.text).not.toContain('실패');
    expect(noAttempt.text).not.toContain('사유');
    expect(authStopNote(null)).toBe(null);
  });
  it('신뢰·경로·가림 고지를 지우지 않는다', () => {
    expect(TRUST_NOTE).toContain('포탈이 세션을 만들거나 바꾸지 않습니다');
    expect(SESSION_PATH_NOTE).toContain('/rest/inventory/v1/sessions');
    expect(NAME_MASK_NOTE).toContain('개인정보');
  });
});
