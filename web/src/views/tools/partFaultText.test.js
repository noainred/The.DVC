/**
 * partFaultText.test.js — 파트 장애 화면 문구·판정(v2.547).
 *
 * 웹 테스트는 node 환경(DOM 없음)이라 컴포넌트를 렌더할 수 없다 — 그래서 **판정과 문구**를
 * 순수 모듈에 두고 여기서 고정한다. 이 파일이 지키는 것은 한 문장으로 요약된다:
 * **'장애 0건' 을 '정상' 이라고 말할 수 있는 경우는 매우 좁다.**
 */
import { describe, it, expect } from 'vitest';
import {
  ageText, intervalText, scanNote, emptyDiag, edgeNote,
  keyKindNote, holdText, holdNote, eventText, notifyNote, lastRunText, toneVar,
} from './partFaultText.js';

const scanned = (over = {}) => ({
  idrac: { devices: 10, ok: 10, failed: 0, parts: 300, capped: 0 },
  storage: { devices: 2, ok: 2, failed: 0, parts: 20, notCollected: {} },
  summary: { total: 320, ok: 320, warn: 0, fault: 0, unknown: 0, absent: 0 },
  ...over,
});
const poller = (over = {}) => ({ enabled: true, intervalMs: 600_000, busy: false, last: { at: Date.now() - 60_000, ms: 120, stats: { opened: 0, closed: 0, changed: 0 }, local: scanned() }, ...over });

describe('ageText — null 을 0 으로 바꾸지 않는다(Number(null)===0 함정)', () => {
  it('값이 없으면 —', () => {
    expect(ageText(null)).toBe('—');
    expect(ageText(undefined)).toBe('—');
    expect(ageText('x')).toBe('—');
  });
  it('구간별 단위', () => {
    expect(ageText(5_000)).toBe('5초 전');
    expect(ageText(120_000)).toBe('2분 전');
    expect(ageText(7_200_000)).toBe('2시간 전');
    expect(ageText(2 * 86_400_000)).toBe('2일 전');
  });
});

describe('intervalText — 주기 숫자를 문구에 박지 않는다(서버 값만 쓴다)', () => {
  it('분/시간', () => {
    expect(intervalText(600_000)).toBe('10분');
    expect(intervalText(7_200_000)).toBe('2시간');
    expect(intervalText(null)).toBe('');
  });
});

describe('scanNote — 확인 불가·빈 슬롯을 따로 말한다', () => {
  it('정상일 때는 군더더기를 붙이지 않는다', () => {
    const n = scanNote(scanned());
    expect(n.text).toContain('장비 12/12대');
    expect(n.text).not.toContain('빈 슬롯');
    expect(n.unknown).toBe(0);
  });
  it('unknown/absent/failed 를 각각 밝힌다', () => {
    const n = scanNote(scanned({
      idrac: { devices: 10, ok: 8, failed: 2, parts: 240, capped: 0 },
      summary: { total: 260, ok: 240, warn: 0, fault: 3, unknown: 5, absent: 12 },
    }));
    expect(n.failed).toBe(2);
    expect(n.text).toContain('2대는 보지 못했습니다');
    expect(n.text).toContain('상태를 읽지 못한 부품 5개');
    expect(n.text).toContain('빈 슬롯 12개');
    expect(n.text).toContain('고장이 아닙니다');
  });
  it('없으면 지어내지 않는다', () => {
    expect(scanNote(null)).toBeNull();
  });
});

describe('emptyDiag — 빈 목록의 이유를 한 문구로 덮지 않는다', () => {
  it('장애가 있으면 진단을 만들지 않는다', () => {
    expect(emptyDiag({ open: [{}] }).kind).toBe('has');
  });
  it('DB 를 못 열면 "정상으로 읽지 마세요" 라고 말한다', () => {
    const d = emptyDiag({ open: [], db: { available: false, error: 'no sqlite' } });
    expect(d.kind).toBe('db');
    expect(d.tone).toBe('bad');
    expect(d.text).toContain('정상으로 읽지 마세요');
  });
  it('엣지 노드에서는 중앙에서 보라고 안내한다(여기서 비는 것이 정상)', () => {
    const d = emptyDiag({ open: [], role: 'edge', db: { available: true }, poller: poller() });
    expect(d.kind).toBe('edge-node');
  });
  it('꺼져 있으면 "켜면 된다", 첫 주기면 "기다리면 된다" — 둘을 구분한다', () => {
    const off = emptyDiag({ open: [], db: { available: true }, poller: { enabled: false, last: null } });
    expect(off.kind).toBe('disabled');
    expect(off.waiting).toBe(false);          // 켜지 않으면 기다려도 안 된다
    const first = emptyDiag({ open: [], db: { available: true }, poller: { enabled: true, last: null } });
    expect(first.kind).toBe('first');
    expect(first.waiting).toBe(true);
  });
  it('직전 점검이 실패했으면 사유를 그대로 싣는다', () => {
    const d = emptyDiag({ open: [], db: { available: true }, poller: poller({ last: { at: Date.now(), error: 'boom' } }) });
    expect(d.kind).toBe('error');
    expect(d.text).toContain('boom');
  });
  it('전 장비를 못 봤으면 "장애가 없는 것이 아니라 확인하지 못한 것"', () => {
    const d = emptyDiag({
      open: [], db: { available: true },
      poller: poller({ last: { at: Date.now(), ms: 1, stats: {}, local: scanned({ idrac: { devices: 10, ok: 0, failed: 10, parts: 0, capped: 0 }, storage: { devices: 0, ok: 0, failed: 0, parts: 0, notCollected: {} }, summary: { total: 0 } }) } }),
    });
    expect(d.kind).toBe('all-failed');
    expect(d.text).toContain('확인하지 못한 것');
  });
  it('일부라도 못 봤으면 "전부 정상" 이라고 말하지 않는다', () => {
    const d = emptyDiag({
      open: [], db: { available: true },
      poller: poller({ last: { at: Date.now(), ms: 1, stats: {}, local: scanned({ idrac: { devices: 10, ok: 9, failed: 1, parts: 270, capped: 0 }, summary: { total: 290, unknown: 3 } }) } }),
      edges: { reports: [], silent: ['OC2SDBX'] },
    });
    expect(d.kind).toBe('partial');
    expect(d.text).toContain("'전부 정상' 이라고는 말할 수 없습니다");
    expect(d.text).toContain('보고가 없는 엣지 1곳');
  });
  it('정말로 전부 확인했을 때만 "정상" 이라고 말한다', () => {
    const d = emptyDiag({ open: [], db: { available: true }, poller: poller(), edges: { reports: [], silent: [] } });
    expect(d.kind).toBe('ok');
    expect(d.tone).toBe('ok');
  });
});

describe('edgeNote — 보고가 없는 엣지를 "정상" 이라 하지 않는다', () => {
  it('무보고 엣지는 "모름" 이라고 적는다', () => {
    const n = edgeNote({ reports: [{ agent: 'A', stale: false }], silent: ['B'] });
    expect(n.silent).toBe(1);
    expect(n.text).toContain("'장애 없음' 이 아니라 '모름'");
    expect(n.tone).toBe('warn');
  });
  it('오래된 보고는 해소로 처리하지 않는다는 사실을 적는다', () => {
    const n = edgeNote({ reports: [{ agent: 'A', stale: true }], silent: [] });
    expect(n.stale).toBe(1);
    expect(n.text).toContain('해소로 처리하지 않습니다');
  });
  it('위임이 없으면 그 사실만 말한다', () => {
    expect(edgeNote({ reports: [], silent: [] }).tone).toBe('muted');
    expect(edgeNote(null).text).toContain('엣지 위임 없음');
  });
});

describe('keyKindNote — 안정적인 키에는 안내를 붙이지 않는다', () => {
  const notes = { index: '⚠ 순번으로 잡은 파트입니다', name: '이름으로 잡았습니다', none: '식별자가 없습니다' };
  it('slot·serial·name 은 조용하다(모든 행에 안내가 붙으면 아무도 안 읽는다)', () => {
    expect(keyKindNote('slot', notes)).toBe('');
    expect(keyKindNote('serial', notes)).toBe('');
    // ⚠ v2.547 Chromium 판독: name 까지 호박색으로 띄우니 정상 행이 경고처럼 보였다.
    expect(keyKindNote('name', notes)).toBe('');
  });
  it('index·none 은 밝힌다', () => {
    expect(keyKindNote('index', notes)).toContain('순번');
    expect(keyKindNote('none', notes)).toContain('식별자');
  });
});

describe('toneVar — 서버 톤과 진단 톤 두 어휘를 모두 받는다', () => {
  it('한쪽만 매핑하면 표의 상태 글자가 색을 잃는다(초판 결함)', () => {
    expect(toneVar('red')).toBe('var(--red)');
    expect(toneVar('bad')).toBe('var(--red)');
    expect(toneVar('amber')).toBe('var(--amber)');
    expect(toneVar('warn')).toBe('var(--amber)');
    expect(toneVar('green')).toBe('var(--green)');
    expect(toneVar('ok')).toBe('var(--green)');
  });
  it("'확인 불가' 는 빨강이 아니라 회색이다(v2.526 healthBadge 규약)", () => {
    expect(toneVar('gray')).toBe('var(--text-faint)');
    expect(toneVar('muted')).toBe('var(--text-faint)');
    expect(toneVar(undefined)).toBe('var(--text-faint)');
  });
});

describe('holdText / holdNote — 행은 짧게, 긴 설명은 배너가 한 번만', () => {
  it('세 사유가 서로 다르고 행 문구는 짧다(v2.509 규약)', () => {
    const a = holdText('unknown'); const b = holdText('device-failed'); const c = holdText('missing');
    expect(new Set([a, b, c]).size).toBe(3);
    // ⚠ 40자를 넘으면 5행짜리 표가 같은 문장으로 뒤덮인다(400px 판독에서 실제로 그랬다).
    for (const t of [a, b, c]) expect(t.length).toBeLessThanOrEqual(40);
  });
  it('사유가 없으면 빈 문자열(지어내지 않는다)', () => {
    expect(holdText(null)).toBe('');
    expect(holdText('bogus')).toBe('');
  });
  it("배너는 '해소로 처리하지 않았다' 를 한 번 말하고 사유별 건수를 센다", () => {
    const t = holdNote([
      { holdReason: 'device-failed' }, { holdReason: 'device-failed' },
      { holdReason: 'unknown' }, { holdReason: null },
    ]);
    expect(t).toContain('판정 보류 3건');
    expect(t).toContain('이 장비 수집 실패 2건');
    expect(t).toContain('상태를 읽지 못함 1건');
    expect(t).toContain('해소로 처리하지 않았습니다');
  });
  it('보류가 없으면 빈 문자열', () => { expect(holdNote([{ holdReason: null }])).toBe(''); });
});

describe('eventText — 제거와 복구를 한 문구로 덮지 않는다', () => {
  const labels = { state: { fault: '장애', warn: '주의' } };
  it('열림/변화/해소', () => {
    expect(eventText({ event: 'open', state: 'fault' }, labels)).toContain('장애 발생');
    expect(eventText({ event: 'change', prevState: 'warn', state: 'fault' }, labels)).toContain('주의 → 장애');
    expect(eventText({ event: 'close', prevState: 'fault', closeReason: 'ok' }, labels)).toContain('정상으로 복귀');
    expect(eventText({ event: 'close', prevState: 'fault', closeReason: 'removed' }, labels)).toContain('제거');
  });
  it('없으면 빈 문자열', () => { expect(eventText(null)).toBe(''); });
});

describe('notifyNote / lastRunText — 상한과 실패를 숨기지 않는다', () => {
  it('상한으로 빠진 건수를 말한다', () => {
    const t = notifyNote({ notify: { sent: 200, capped: 15, dropped: 3 } });
    expect(t).toContain('200건 발송');
    expect(t).toContain('15건은 보내지 않았습니다');
    expect(t).toContain('3건 미발송');
  });
  it('알림이 없으면 빈 문자열', () => { expect(notifyNote({})).toBe(''); });
  it('점검 이력이 없으면 지어내지 않는다', () => {
    expect(lastRunText(null)).toBe('점검 이력 없음');
    expect(lastRunText({ last: { at: 1000, error: 'x' } }, 2000)).toContain('직전 점검 실패');
  });
});
