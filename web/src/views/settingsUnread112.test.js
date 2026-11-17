// 전체 점검 112회차(설정 화면 스윕) — '설정 파일을 못 읽은 동안 받은 기본값' 으로 채운 폼이 다시 읽힌 뒤의 저장으로 저장된 설정을 덮지 않게.
//   서버의 쓰기 거절(503 · 409)은 읽기 오류가 이어지는 동안만 막는다 — 다시 읽힌 뒤에는 그 폼이 어디서 왔는지 서버가 모른다. 그래서 화면이 조회의 표지로 잠그고 다시 채운다.
// 판정 · 문구는 공용 순수 모듈(settingsUnread.js)을 실제로 호출한다(node 환경 — DOM 없음). 화면 배선 · 서버 표지는 server/test/settingsUnreadSweep112.test.js 가 고정한다.
import { describe, it, expect } from 'vitest';
import { unreadMarkOf, unreadKind, saveLockedByUnread, shouldReseed, settingsUnreadNote, staleSeedLock } from './settingsUnread.js';
import { reseedAfterUnread } from './tools/LinkCheck.jsx';
import { requireChanged } from './changeResult.js';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { SettingsUnreadBanner } from './SettingsUnreadBanner.jsx';

const READ = { readError: true, code: 'EISDIR', reason: '설정 파일을 읽지 못했습니다(EISDIR) — 읽기 오류이고 원본은 그대로 있습니다. 파일 권한 · 소유자 · 디스크를 확인하세요(30초마다 다시 읽습니다)' };
const CORRUPT = { readError: false, reason: '설정 파일을 읽지 못했습니다(형식 오류) — 손상 보존본으로 옮겼습니다' };

describe('조회 응답의 표지 꺼내기 — 서버마다 이름이 둘이고 글자인 loadError 는 표지가 아니다', () => {
  it('없으면 null', () => {
    expect(unreadMarkOf(null)).toBe(null);
    expect(unreadMarkOf(undefined)).toBe(null);
    expect(unreadMarkOf('x')).toBe(null);
    expect(unreadMarkOf({ settings: {} })).toBe(null);
    expect(unreadMarkOf({ loadError: null, settingsLoadError: null })).toBe(null);
  });
  it('loadError · settingsLoadError 둘 다 읽는다', () => {
    expect(unreadMarkOf({ loadError: READ })).toBe(READ);
    expect(unreadMarkOf({ settingsLoadError: READ })).toBe(READ);
  });
  it('글자인 loadError(게스트 파티션의 예전 화면 문구)는 건너뛰고 settingsLoadError 를 본다', () => {
    expect(unreadMarkOf({ loadError: '설정 파일을 읽지 못해 기본값으로 보여 줍니다', settingsLoadError: READ })).toBe(READ);
    expect(unreadMarkOf({ loadError: '설정 파일을 읽지 못해 기본값으로 보여 줍니다' })).toBe(null);   // 손상 — 표지 없음(저장이 해제 길)
    expect(unreadMarkOf({ loadError: [READ] })).toBe(null);
  });
  it('스토리지 사용량 메일: status.loadError({ at, readError })도 표지다', () => {
    expect(unreadKind(unreadMarkOf({ loadError: { at: 1, readError: true } }))).toBe('read');
    expect(unreadKind(unreadMarkOf({ loadError: { at: 1, readError: false } }))).toBe('corrupt');
  });
});

describe('저장 잠금 — 읽기 오류면 잠근다 · 손상은 저장이 해제 길이라 잠그지 않는다(서버가 손상도 거절하는 화면만 corruptLocks)', () => {
  it('종류', () => {
    expect(unreadKind(null)).toBe('');
    expect(unreadKind(READ)).toBe('read');
    expect(unreadKind(CORRUPT)).toBe('corrupt');
    expect(unreadKind({ reason: 'x' })).toBe('corrupt');   // readError 가 없으면 손상 쪽(예전 표지 — SAN 포트 사용량 · 디스크 점검)
    expect(unreadKind({ readError: 'true' })).toBe('corrupt');   // 글자 'true' 는 읽기 오류가 아니다(엄격 비교)
  });
  it('잠금', () => {
    expect(saveLockedByUnread(null)).toBe(false);
    expect(saveLockedByUnread(READ)).toBe(true);
    expect(saveLockedByUnread(CORRUPT)).toBe(false);
    expect(saveLockedByUnread(CORRUPT, { corruptLocks: true })).toBe(true);
    expect(saveLockedByUnread(null, { corruptLocks: true })).toBe(false);
  });
});

describe('못 읽은 값으로 채운 폼 다시 채우기 — 채울 때 못 읽은 상태였고 지금 상태가 달라졌을 때만', () => {
  it('읽기 오류로 채운 폼: 다시 읽혔거나 손상으로 바뀌면 다시 채운다 · 아직 못 읽으면 그대로', () => {
    expect(shouldReseed('read', null)).toBe(true);
    expect(shouldReseed('read', CORRUPT)).toBe(true);
    expect(shouldReseed('read', READ)).toBe(false);
  });
  it('읽은 값으로 채운 폼은 편집 중이니 건드리지 않는다(주기 조회가 입력을 되돌리지 않게)', () => {
    expect(shouldReseed('', null)).toBe(false);
    expect(shouldReseed('', READ)).toBe(false);
    expect(shouldReseed('', CORRUPT)).toBe(false);
    expect(shouldReseed(null, READ)).toBe(false);
  });
  it('손상으로 채운 폼: 손상인 동안은 그대로(그 폼이 새 설정이 된다) · 풀리면(확정 · 복구) 다시 채운다 — 기본값 폼이 확정된 값을 덮지 않게', () => {
    expect(shouldReseed('corrupt', CORRUPT)).toBe(false);
    expect(shouldReseed('corrupt', null)).toBe(true);
    expect(shouldReseed('corrupt', READ)).toBe(true);
  });
  it('통신 점검(106회차 reseedAfterUnread)과 같은 입력에 같은 답 — 판정이 두 벌로 갈리지 않게', () => {
    for (const le of [undefined, null, READ, CORRUPT, { readError: false }]) {
      expect(shouldReseed('read', le)).toBe(reseedAfterUnread(true, le));
      expect(shouldReseed('', le)).toBe(reseedAfterUnread(false, le));
    }
  });
});

describe('안내 문구 — 기본값임을 말하고 · 읽기 오류면 잠근다고 말한다 · 백틱을 쓰지 않는다', () => {
  it('표지가 없으면 안내도 없다', () => {
    expect(settingsUnreadNote(null)).toBe('');
    expect(settingsUnreadNote(undefined, { what: 'x' })).toBe('');
  });
  it('읽기 오류 — 설정 이름 · 서버 사유 · 기본값 · 잠금 · 다시 채움', () => {
    const t = settingsUnreadNote(READ, { what: '스토리지 수집 주기', save: '저장' });
    expect(t).toMatch(/^스토리지 수집 주기 — 설정 파일을 읽지 못했습니다\(EISDIR\)/);
    expect(t).toMatch(/저장된 설정이 아니라 기본값/);
    expect(t).toMatch(/‘저장’ 을 잠급니다/);
    expect(t).toMatch(/저장된 값으로 다시 채웁니다/);
    expect(t).not.toMatch(/`/);
  });
  it('편집 칸을 그리지 않는 화면(IPMS 설정 — 전체 교체 저장)은 보이는 값 을 말하지 않는다', () => {
    const t = settingsUnreadNote(READ, { what: 'IPMS 설정', save: '①·③ 저장', formHidden: true });
    expect(t).toMatch(/편집 칸을 열지 않습니다/);
    expect(t).toMatch(/읽히면 저장된 값으로 엽니다/);
    expect(t).not.toMatch(/지금 보이는 값/);
    expect(t).not.toMatch(/`/);
    expect(settingsUnreadNote(CORRUPT, { what: 'IPMS 설정', formHidden: true })).toMatch(/기본값입니다/);   // 손상은 폼을 그린다(저장이 해제 길)
  });
  it('서버가 마지막으로 읽은 값을 주는 설정(LLM)은 기본값이라고 단정하지 않는다', () => {
    const t = settingsUnreadNote(READ, { what: 'AI 검색(LLM) 설정', save: '저장', lastGood: true });
    expect(t).toMatch(/마지막으로 읽은 값\(기동 뒤 한 번도 읽지 못했으면 기본값\)/);
    expect(t).toMatch(/‘저장’ 을 잠급니다/);
    expect(t).not.toMatch(/저장된 설정이 아니라 기본값\(빈 값\)/);
    expect(t).not.toMatch(/`/);
  });
  it('사유가 없으면 코드로 만든다 — 코드 모양이 아니면 싣지 않는다', () => {
    expect(settingsUnreadNote({ readError: true, code: 'EACCES' })).toMatch(/설정 파일을 읽지 못했습니다\(EACCES\)/);
    expect(settingsUnreadNote({ readError: true })).toMatch(/설정 파일을 읽지 못했습니다 — /);
    expect(settingsUnreadNote({ readError: true, code: '<b>x</b>' })).not.toMatch(/<b>/);
  });
  it('손상 — 저장이 해제 길이라 잠근다고 말하지 않는다 · 서버가 손상도 거절하는 화면은 잠근다고 말한다', () => {
    const t = settingsUnreadNote(CORRUPT, { what: '통신 점검 설정', save: '설정 저장' });
    expect(t).toMatch(/기본값입니다/);
    expect(t).toMatch(/‘설정 저장’ 을 누르면 이 화면의 값이 새 설정/);
    expect(t).not.toMatch(/잠급니다/);
    const t2 = settingsUnreadNote(CORRUPT, { what: 'SAN 포트 사용량 수집 설정', save: '저장 · 지금 정리', corruptLocks: true });
    expect(t2).toMatch(/‘저장 · 지금 정리’ 을 잠급니다/);
    expect(t2).toMatch(/확정하거나 보존본을 되돌리세요/);
    expect(t2).not.toMatch(/`/);
  });
});

describe('못 읽은 동안 연 편집 창 — 창은 폼을 다시 채우지 않으므로 다시 읽힌 뒤에도 잠근다', () => {
  it('지금 읽기 오류면 잠근다', () => {
    expect(staleSeedLock('', READ, { what: 'RMA 분배 · 접속 허용 설정' })).toMatch(/RMA 분배 · 접속 허용 설정 파일을 읽지 못한 상태라 저장을 잠급니다/);
    expect(staleSeedLock('read', READ)).toMatch(/저장을 잠급니다/);
  });
  it('읽기 오류 때 연 창은 다시 읽힌 뒤에도 잠근다 — 빈 ‘접속 허용 IP’ 저장이 허용 목록을 제한 없음 으로 만들지 않게', () => {
    const t = staleSeedLock('read', null, { what: 'RMA 분배 · 접속 허용 설정' });
    expect(t).toMatch(/읽지 못한 동안 연 창/);
    expect(t).toMatch(/닫고 다시 열면 저장된 값/);
    expect(t).not.toMatch(/`/);
  });
  it('읽은 값으로 연 창은 잠그지 않는다 · 손상은 저장이 해제 길이다', () => {
    expect(staleSeedLock('', null)).toBe('');
    expect(staleSeedLock('', CORRUPT)).toBe('');
    expect(staleSeedLock('corrupt', null)).toBe('');
  });
});

describe('디스크 점검 설정 저장 — 409(엣지 노드) 본문을 저장 성공으로 읽지 않는다', () => {
  it('requireChanged 가 실패 본문을 사유로 던진다(설정 칸을 r.settings = undefined 로 지우기 전에)', () => {
    const edge = { ok: false, reason: '엣지 노드에서는 저장하지 않습니다 — 중앙 포탈에서 설정하세요.' };
    expect(() => requireChanged(edge)).toThrow(/엣지 노드에서는 저장하지 않습니다/);
    const ok = { ok: true, settings: { autoEnabled: true } };
    expect(requireChanged(ok)).toBe(ok);
  });
});

describe('안내 배너(SettingsUnreadBanner) — 실제로 그려 본다', () => {
  it('표지가 없으면 아무것도 그리지 않는다', () => {
    expect(renderToString(createElement(SettingsUnreadBanner, { le: null, what: 'x' }))).toBe('');
  });
  it('읽기 오류 — 경고 배너 · 종류 표지 · ‘다시 확인’ 단추(onRecheck 가 있을 때만)', () => {
    const html = renderToString(createElement(SettingsUnreadBanner, { le: READ, what: '스토리지 수집 주기', save: '저장', onRecheck: () => {} }));
    expect(html).toContain('class="banner warn"');
    expect(html).toContain('data-settings-unread="read"');
    expect(html).toContain('스토리지 수집 주기');
    expect(html).toContain('다시 확인');
    expect(html).toContain('white-space:normal');   // 400px 에서 줄바꿈(가로 넘침 금지)
    const noBtn = renderToString(createElement(SettingsUnreadBanner, { le: READ, what: 'x' }));
    expect(noBtn).not.toContain('다시 확인');
  });
  it('손상 — 종류 표지가 다르다', () => {
    expect(renderToString(createElement(SettingsUnreadBanner, { le: CORRUPT, what: 'x' }))).toContain('data-settings-unread="corrupt"');
  });
});
