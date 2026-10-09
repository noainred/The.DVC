/**
 * 리뷰 I-05(그룹 D) — 게시판·공지 '저장 대기/실패' 문구(순수). 서버 계약은 server/test/rvD_bulletinPersist.test.js 가 고정한다.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  storeWarning, persistWarnings, writeResultNote, retryResultText, needsPersistPoll,
  PERSIST_STUCK_MS, WRITE_PHASE_TEXT, STORE_LABEL,
} from './bulletinText.js';

const NOW = 1_800_000_000_000;

describe('저장소 경고', () => {
  it('저장됨·모르는 모양은 경고하지 않는다', () => {
    expect(storeWarning(null)).toBeNull();
    expect(storeWarning({ state: 'saved' })).toBeNull();
    expect(storeWarning({ state: 'boom' })).toBeNull();
    expect(persistWarnings(undefined)).toEqual([]);
  });
  it('pending 은 정상 묶음 창이라 짧으면 말하지 않고, 오래 밀리면 호박색으로 말한다', () => {
    expect(storeWarning({ state: 'pending', unsavedSince: NOW - 2000 }, { now: NOW })).toBeNull();
    expect(storeWarning({ state: 'pending', unsavedSince: null }, { now: NOW })).toBeNull();
    const w = storeWarning({ state: 'pending', unsavedSince: NOW - PERSIST_STUCK_MS - 5000 }, { now: NOW, label: '게시판' });
    expect(w.tone).toBe('warn');
    expect(w.title).toContain('15초째');
  });
  it('failed 는 빨강 — 저장될 때까지 남는다는 사실 · 자동 재시도 여부 · 관리자 상세(있을 때만)', () => {
    const user = storeWarning({ state: 'failed', unsavedSince: NOW - 60000, retrying: true, nextRetryAt: NOW + 5000 }, { now: NOW });
    expect(user.tone).toBe('bad');
    expect(user.lines.join(' ')).toContain('다시 시작되면 사라질 수 있습니다');
    expect(user.lines.join(' ')).toContain('자동으로 다시 저장합니다');
    expect(user.lines.join(' ')).not.toContain('원인');
    expect(user.lines.join(' ')).not.toContain('미저장 변경');
    const admin = storeWarning({
      state: 'failed', unsavedSince: NOW - 60000, retrying: false, retryExhausted: true, unsaved: 3, lastSavedAt: NOW - 120000,
      lastWriteError: { code: 'ENOSPC', phase: 'write', message: '디스크 공간이 부족합니다' },
    }, { now: NOW });
    const t = admin.lines.join(' ');
    expect(t).toContain('디스크 공간이 부족합니다(ENOSPC · 임시 파일 쓰기 단계)');
    expect(t).toContain('미저장 변경 3건');
    expect(t).toContain('자동 재시도 횟수를 다 써서 멈췄습니다');
    const never = storeWarning({ state: 'failed', unsaved: 1, lastSavedAt: null, lastWriteError: { code: 'EACCES', phase: 'rename', message: 'x' } }, { now: NOW });
    expect(never.lines.join(' ')).toContain('마지막 저장 완료 기동 뒤 아직 없음');
  });
  it('실패를 밀림보다 먼저 보이고 저장소 이름을 붙인다', () => {
    const ws = persistWarnings({
      board: { state: 'pending', unsavedSince: NOW - 60000 },
      notices: { state: 'failed', unsavedSince: NOW - 1000 },
    }, { now: NOW });
    expect(ws.map((w) => [w.kind, w.tone])).toEqual([['notices', 'bad'], ['board', 'warn']]);
    expect(ws[0].title.startsWith(STORE_LABEL.notices)).toBe(true);
  });
  it('폴링은 저장 안 된 것이 있을 때만', () => {
    expect(needsPersistPoll({ board: { state: 'saved' }, notices: { state: 'saved' } })).toBe(false);
    expect(needsPersistPoll({ board: { state: 'pending' } })).toBe(true);
    expect(needsPersistPoll({ board: { state: 'failed' } })).toBe(true);
    expect(needsPersistPoll(null)).toBe(false);
  });
});

describe('쓰기 응답 안내', () => {
  it('saved·모름은 말하지 않고 failed 는 말한다 — 공감(기다리지 않음)의 pending 은 정상', () => {
    expect(writeResultNote({ state: 'saved' })).toBe('');
    expect(writeResultNote(undefined)).toBe('');
    expect(writeResultNote({ state: 'failed' })).toContain('사라질 수 있습니다');
    expect(writeResultNote({ state: 'failed', error: { code: 'ENOSPC', message: '디스크 공간이 부족합니다' } })).toContain('(ENOSPC)');
    expect(writeResultNote({ state: 'pending' })).toContain('기다리는 중');
    expect(writeResultNote({ state: 'pending' }, { waited: false })).toBe('');
  });
  it('다시 저장 결과', () => {
    expect(retryResultText({ ok: true, result: [{ kind: 'board', attempted: false, state: 'saved' }] })).toContain('이미 모두 저장');
    expect(retryResultText({ ok: true, result: [{ kind: 'board', attempted: true, state: 'saved' }] })).toBe('게시판: 저장했습니다.');
    expect(retryResultText({ ok: true, result: [{ kind: 'notices', attempted: true, state: 'failed', code: 'EACCES' }] })).toContain('공지: 여전히 저장하지 못했습니다(EACCES)');
    expect(retryResultText({ ok: false, reason: 'forbidden' })).toContain('저장하지 못했습니다');
  });
});

describe('서버와 1:1', () => {
  it('실패 단계 문구는 서버 WRITE_PHASES 와 같은 키다', () => {
    const src = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../server/src/bulletin/store.js'), 'utf8');
    const m = src.match(/WRITE_PHASES = Object\.freeze\(\[([^\]]*)\]\)/);
    expect(m).toBeTruthy();
    const keys = m[1].split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean);
    expect(Object.keys(WRITE_PHASE_TEXT).sort()).toEqual([...keys].sort());
  });
  it('화면 문구에 백틱·별표 강조가 없다(Board 는 BoldText 를 쓰지 않는다)', () => {
    const all = [
      storeWarning({ state: 'failed', retrying: true, unsaved: 1, lastSavedAt: NOW, lastWriteError: { code: 'EIO', phase: 'flush', message: 'm' } }, { now: NOW }),
      storeWarning({ state: 'pending', unsavedSince: NOW - 99999 }, { now: NOW }),
    ].flatMap((w) => [w.title, ...w.lines]).concat([writeResultNote({ state: 'failed' }), writeResultNote({ state: 'pending' })]);
    for (const t of all) { expect(t).not.toMatch(/[`]/); expect(t).not.toContain('**'); }
  });
});
