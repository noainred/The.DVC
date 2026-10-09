/**
 * 리뷰 I-05(그룹 D) — 게시판 화면의 '저장 대기/실패' 배너 렌더 스모크(서버 없이 GET /board/persist 계약 모양으로).
 * renderToStaticMarkup 이라 레이아웃은 보지 못한다(Chromium 몫). 여기서 잡는 것: 미저장 상태가 화면에 나타나는지 · 상세는 관리자만 ·
 * 다시 저장 버튼은 관리자에게만(전체 범위가 아니면 잠김) · 저장되면 사라진다 · 실패 문구가 초록으로 남지 않는다 · null/NaN 누출.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PersistBannerView } from './Board.jsx';

const h = React.createElement;
const NOW = 1_800_000_000_000;
const FAIL_ADMIN = {
  state: 'failed', loaded: true, unsavedSince: NOW - 90_000, retrying: true, retryExhausted: false, writing: false,
  unsaved: 4, lastSavedAt: NOW - 300_000, lastWriteError: { at: NOW - 5_000, code: 'ENOSPC', phase: 'write', message: '디스크 공간이 부족합니다' },
  failCount: 2, failTotal: 2, attempts: 5, writes: 1, nextRetryAt: NOW + 10_000, retryMax: 6, unsavedForMs: 90_000,
};
const FAIL_USER = { state: 'failed', loaded: true, unsavedSince: NOW - 90_000, retrying: true, retryExhausted: false, writing: false };
const SAVED = { state: 'saved', loaded: true, unsavedSince: null, retrying: false, retryExhausted: false, writing: false };
const render = (props) => renderToStaticMarkup(h(PersistBannerView, { now: NOW, onRetry: () => {}, ...props }));
const noLeak = (html) => {
  expect(html).not.toMatch(/>(null|undefined|NaN)</);
  expect(html).not.toMatch(/\[object Object\]/);
  expect(html).not.toMatch(/(null|undefined|NaN)(건|초|\))/);
};

describe('저장 상태 배너', () => {
  it('저장됨이면 아무것도 그리지 않는다', () => {
    expect(render({ data: { admin: true, canRetry: true, stores: { board: SAVED, notices: SAVED } } })).toBe('');
    expect(render({ data: null })).toBe('');
  });
  it('관리자 — 실패 경고 + 사유 코드·미저장 수 + 지금 다시 저장 버튼', () => {
    const html = render({ data: { admin: true, canRetry: true, stores: { board: FAIL_ADMIN, notices: SAVED } } });
    expect(html).toContain('게시판 저장 실패');
    expect(html).toContain('banner bad');
    expect(html).toContain('다시 시작되면 사라질 수 있습니다');
    expect(html).toContain('ENOSPC');
    expect(html).toContain('미저장 변경 4건');
    expect(html).toContain('지금 다시 저장');
    expect(html).not.toMatch(/<button[^>]*disabled/);
    noLeak(html);
  });
  it('범위 관리자 — 상세는 보이고 버튼은 잠긴다(사유를 말한다)', () => {
    const html = render({ data: { admin: true, canRetry: false, stores: { board: FAIL_ADMIN, notices: SAVED } } });
    expect(html).toMatch(/<button[^>]*disabled/);
    expect(html).toContain('전체 범위 관리자만');
  });
  it('운영자·조회자 — 경고는 보이고 사유 코드·버튼은 없다', () => {
    const html = render({ data: { admin: false, canRetry: false, stores: { board: FAIL_USER, notices: SAVED } } });
    expect(html).toContain('게시판 저장 실패');
    expect(html).toContain('자동으로 다시 저장합니다');
    expect(html).not.toContain('ENOSPC');
    expect(html).not.toContain('미저장 변경');
    expect(html).not.toContain('지금 다시 저장');
    noLeak(html);
  });
  it('짧은 대기는 경고하지 않고, 오래 밀리면 호박색으로 말한다', () => {
    expect(render({ data: { admin: false, stores: { board: { ...SAVED, state: 'pending', unsavedSince: NOW - 1_000 }, notices: SAVED } } })).toBe('');
    const html = render({ data: { admin: false, stores: { board: { ...SAVED, state: 'pending', unsavedSince: NOW - 60_000 }, notices: SAVED } } });
    expect(html).toContain('banner warn');
    expect(html).toContain('60초째');
  });
  it('다시 저장 결과 — 성공 문구만 경고가 사라진 뒤에 남고, 실패 문구는 초록으로 남지 않는다', () => {
    const okHtml = render({ data: { admin: true, canRetry: true, stores: { board: SAVED, notices: SAVED } }, msg: { text: '게시판: 저장했습니다.', ok: true } });
    expect(okHtml).toContain('banner ok');
    expect(render({ data: { admin: true, canRetry: true, stores: { board: SAVED, notices: SAVED } }, msg: { text: '게시판: 여전히 저장하지 못했습니다', ok: false } })).toBe('');
    const stillFail = render({ data: { admin: true, canRetry: true, stores: { board: FAIL_ADMIN, notices: SAVED } }, msg: { text: '게시판: 여전히 저장하지 못했습니다(ENOSPC)', ok: false } });
    expect(stillFail).toContain('여전히 저장하지 못했습니다');
    expect(stillFail).not.toContain('banner ok');
  });
  it('공지 저장소의 실패도 따로 말한다', () => {
    const html = render({ data: { admin: false, stores: { board: SAVED, notices: FAIL_USER } } });
    expect(html).toContain('공지 저장 실패');
  });
});
