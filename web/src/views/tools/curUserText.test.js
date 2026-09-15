/**
 * curUserText.test.js — '현재 사용자'(v2.520) 화면 문구·판정 회귀 고정.
 *
 * 웹 테스트는 node 환경(DOM 없음)이라 렌더를 볼 수 없다 — 그래서 **행동이 갈리는 판정**을
 * 여기서 고정한다. 이 기능에서 가장 위험한 거짓은 '수집 대기' 한 문구로 서로 다른 상황을
 * 덮는 것이고(v2.509), 두 번째는 '확인 못 한 서버' 를 '사용자 0명' 으로 보이게 하는 것이다.
 */
import { describe, it, expect } from 'vitest';
import {
  agoText, whenText, intervalText, kindTone, kindAdvice, kindLabelOf,
  collectStateNote, unionNote, sinceNote, skippedSummary, agentGuide, collectSummary, TRUST_NOTE,
} from './curUserText.js';

const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;  // 정시 -30분(경계에서 떨어뜨림)

describe('시간 문구', () => {
  it('경과를 단계별로 쓴다', () => {
    expect(agoText(1000)).toBe('방금');
    expect(agoText(5 * 60_000)).toBe('5분 전');
    expect(agoText(3 * HOUR)).toBe('3시간 전');
    expect(agoText(2 * 86_400_000)).toBe('2일 전');
    expect(agoText(null)).toBe('—');
  });
  it('미래는 시계 오차임을 밝힌다', () => {
    expect(agoText(-60_000)).toContain('시계 오차');
  });
  it('없는 시각을 지어내지 않는다', () => {
    expect(whenText(null)).toBe('—');
    expect(whenText(0)).toBe('—');
  });
  it('주기 값이 없으면 숫자를 지어내지 않는다', () => {
    expect(intervalText(0)).toBe('설정값');
    expect(intervalText(undefined)).toBe('설정값');
    expect(intervalText(600_000)).toBe('10분');
    expect(intervalText(90 * 60_000)).toBe('1.5시간');
  });
});

describe('상태 색·조치', () => {
  it('ok 만 초록이다 — 확인 불가를 정상색으로 칠하지 않는다', () => {
    expect(kindTone('ok')).toBe('green');
    for (const k of ['stale', 'incomplete', 'clock-skew']) expect(kindTone(k)).toBe('amber');
    for (const k of ['guest-error', 'unparsed', 'not-found']) expect(kindTone(k)).toBe('red');
    expect(kindTone('no-agent')).toBe('gray');
  });
  it("기다리면 되는 것과 조치해야 하는 것을 구분한다", () => {
    expect(kindAdvice('incomplete').waiting).toBe(true);
    expect(kindAdvice('not-found').waiting).toBe(true);
    for (const k of ['stale', 'no-agent', 'guest-error', 'unparsed', 'clock-skew']) {
      expect(kindAdvice(k).waiting).toBe(false);
      expect(kindAdvice(k).text.length).toBeGreaterThan(10);
    }
  });
  it('no-agent 의 원인을 단정하지 않는다(미검증 전제)', () => {
    const t = kindAdvice('no-agent').text;
    expect(t).toMatch(/(또는|거나)/);   // 두 원인을 나열해야 한다(하나로 단정 금지)
    expect(t).toMatch(/구분할 정보가 포탈에 없습니다/);
  });
  it('unparsed 는 0명이 아니라고 말한다', () => {
    expect(kindAdvice('unparsed').text).toMatch(/0명이 아닙니다/);
  });
  it('라벨이 없으면 코드를 그대로 보여준다(빈 칸 금지)', () => {
    expect(kindLabelOf('ok', { ok: '정상' })).toBe('정상');
    expect(kindLabelOf('weird', {})).toBe('weird');
  });
});

describe('상단 배너 — 한 문구로 덮지 않는다', () => {
  const base = { settings: { enabled: true, intervalMs: 600_000 }, poller: { intervalMs: 600_000 }, db: { available: true } };
  it('DB 불가가 가장 먼저다', () => {
    const n = collectStateNote({ ...base, db: { available: false, error: 'no sqlite' } });
    expect(n.kind).toBe('db-unavailable');
    expect(n.tone).toBe('red');
  });
  it('꺼짐은 "켜면 된다"', () => {
    expect(collectStateNote({ ...base, settings: { enabled: false } }).kind).toBe('disabled');
  });
  it('대상 0은 폴더를 지정하라고 말한다', () => {
    const n = collectStateNote({ ...base, targets: 0 });
    expect(n.kind).toBe('no-targets');
    expect(n.body).toMatch(/전체 VM 으로 확대하지 않습니다/);
  });
  it('첫 주기는 기다리면 된다', () => {
    const n = collectStateNote({ ...base, targets: 5, kinds: {}, records: [] });
    expect(n.kind).toBe('first-cycle');
    expect(n.waiting).toBe(true);
  });
  it('전부 발행기 없음은 기다려도 안 된다', () => {
    const n = collectStateNote({ ...base, targets: 3, kinds: { 'no-agent': 3 }, records: [1, 2, 3] });
    expect(n.kind).toBe('all-no-agent');
    expect(n.waiting).toBe(false);
    expect(n.body).toMatch(/구분할 수 없습니다/);
  });
  it('일부 확인 불가는 제외했다는 사실을 밝힌다', () => {
    const n = collectStateNote({ ...base, targets: 5, kinds: { ok: 3, stale: 2 }, records: [1, 2, 3, 4, 5] });
    expect(n.kind).toBe('partial');
    expect(n.title).toMatch(/2대는 확인하지 못했습니다/);
    expect(n.body).toMatch(/세지 않았습니다/);
  });
  it('전부 확인했으면 초록이고 긴 설명이 없다', () => {
    const n = collectStateNote({ ...base, targets: 2, kinds: { ok: 2 }, records: [1, 2] });
    expect(n.kind).toBe('ok');
    expect(n.tone).toBe('green');
    expect(n.body).toBe('');
  });
  it('주기 숫자를 문구에 박지 않고 API 값을 쓴다', () => {
    const n = collectStateNote({ ...base, poller: { intervalMs: 30 * 60_000 }, targets: 1, kinds: {}, records: [] });
    expect(n.body).toContain('30분');
  });
});

describe('고유 사용자 설명', () => {
  it('합집합과 법인별 합이 같으면 그 사실을 말한다', () => {
    expect(unionNote({ usersUnion: 3, usersByVcSum: 3 })).toMatch(/걸쳐 있지는 않습니다/);
  });
  it('다르면 차이의 이유를 말한다', () => {
    const t = unionNote({ usersUnion: 3, usersByVcSum: 5 });
    expect(t).toMatch(/차이 2명/);
    expect(t).toMatch(/여러 법인에 로그인/);
  });
  it('둘 다 0이면 아무 말도 하지 않는다', () => {
    expect(unionNote({ usersUnion: 0, usersByVcSum: 0 })).toBe('');
  });
});

describe('추이 시작점 — 단정하지 않는다(plan D1 과 같은 유형)', () => {
  it('보존 경계에 붙어 있으면 두 가능성을 함께 말한다', () => {
    const r = sinceNote({ first: NOW - 180 * 86_400_000 }, 180, NOW);
    expect(r.kind).toBe('either');
    expect(r.text).toMatch(/기다려도 채워지지 않습니다/);
  });
  it('보존 경계와 멀면 수집 시작이라 말한다', () => {
    const r = sinceNote({ first: NOW - 3 * 86_400_000 }, 180, NOW);
    expect(r.kind).toBe('start');
  });
  it('표본이 없으면 첫 수집 이후라고만 말한다', () => {
    expect(sinceNote(null, 180, NOW).kind).toBe('none');
  });
});

describe('대상 아님 / 배포 안내 / 수집 요약', () => {
  it('제외 사유를 개수와 함께 모은다', () => {
    const s = skippedSummary(
      [{ reason: 'not-windows' }, { reason: 'not-windows' }, { reason: 'no-tools' }],
      { 'not-windows': 'Windows 아님', 'no-tools': 'Tools 미실행' },
    );
    expect(s.total).toBe(3);
    expect(s.rows[0]).toMatchObject({ reason: 'not-windows', n: 2, text: 'Windows 아님' });
  });
  it('배포 안내는 게스트 계정·방화벽이 필요 없다고 말한다', () => {
    const g = agentGuide({ guestPublishMs: 600_000, installCommand: 'schtasks /Create ...' });
    expect(g.join('\n')).toMatch(/게스트 계정도, 포탈로 나가는 방화벽 허용도 필요 없습니다/);
    expect(g.join('\n')).toContain('10분');
  });
  it('수집 요약은 진행 중·실패·상한을 구분한다', () => {
    expect(collectSummary({ skipped: true, reason: '이미 수집이 진행 중입니다.' })).toMatch(/진행 중/);
    expect(collectSummary({ ok: false, reason: '수집이 꺼져 있습니다(설정에서 켜세요).' })).toMatch(/꺼져/);
    const t = collectSummary({ ok: true, targets: 10, records: 9, users: 4, errors: [{}], overLimit: 2 });
    expect(t).toMatch(/대상 10대/);
    expect(t).toMatch(/고유 사용자 4명/);
    expect(t).toMatch(/실패 1곳/);
    expect(t).toMatch(/상한 초과 2대 제외/);
  });
  it('신뢰 고지가 감사 증적이 아님을 밝힌다', () => {
    expect(TRUST_NOTE).toMatch(/감사 증적이 아닙니다/);
  });
});
