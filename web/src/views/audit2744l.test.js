/**
 * v2.744 감사 후속 FB-3 — 설정 › 세션 보안: 소유자 목록의 범위 계정 경고(서버 GET·PUT 응답 ownerWarnings).
 * renderToStaticMarkup 이라 레이아웃은 보지 못한다(Chromium 몫). 여기서 잡는 것: 경고가 화면에 나타나는지 · 계정 이름을 보이는지 ·
 * 경고가 없으면 아무것도 그리지 않는지 · 잘못된 원소(null·문자열)에 죽지 않는지 · 조치 문구가 사실(범위를 비우면 통과)만 말하는지.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OwnerScopeWarnings } from './SessionSecurity.jsx';

const h = React.createElement;
const render = (warnings) => renderToStaticMarkup(h(OwnerScopeWarnings, { warnings }));

describe('OwnerScopeWarnings', () => {
  it('범위 계정 소유자가 있으면 개수·이름·이유·조치를 말한다', () => {
    const html = render([{ username: 'sadm', reason: 'x' }, { username: 'kadm' }]);
    expect(html).toContain('범위가 지정된 계정 2개');
    expect(html).toContain('sadm, kadm');
    expect(html).toContain('소유자 등급 화면');
    expect(html).toContain('전체 범위');
    expect(html).toContain('범위를 비우세요');
    expect(html).toContain('메뉴는 그대로 보입니다');
    expect(html).not.toMatch(/undefined|null|NaN|`|\*\*/);
  });

  it('경고가 없거나 모양이 틀리면 그리지 않는다', () => {
    expect(render(undefined)).toBe('');
    expect(render([])).toBe('');
    expect(render('sadm')).toBe('');
    expect(render([null, { username: '' }, 3])).toBe('');
  });
});
