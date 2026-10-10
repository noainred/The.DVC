/**
 * views/audit2732i3_peerTrust.test.jsx — 점검 2회차(v2.732) 그룹 i3: 설정 › 장비 신뢰 배너가 '읽지 못함'(unreadable)·'손상'(corrupt)·
 * '저장 멈춤'(writeBlocked)·'보존본 이름' 을 구분해 말하는가(서버 security/peerTrust.js failClosed 의 loadError 모양).
 * 예전 배너는 언제나 '손상 원본은 보존했습니다' 였다 — 원본을 옮기지 못해 쓰기를 멈춘 경우에도 '보존했다' 고 말했다(거짓).
 * 렌더(renderToStaticMarkup)로 실제 배너 HTML 을 본다.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import PeerTrustSettings from './PeerTrustSettings.jsx';

const h = React.createElement;
const status = (loadError) => ({
  loadError,
  kinds: {
    ssh: { policy: { mode: 'enforce', source: 'file', origin: 'load-error' }, counts: {} },
    tls: { policy: { mode: 'enforce', source: 'file', origin: 'load-error' }, counts: {} },
  },
});
const render = (loadError) => renderToStaticMarkup(h(PeerTrustSettings, {
  initialData: { ok: true, status: status(loadError), peers: [], kinds: ['ssh', 'tls'], modes: ['enforce', 'observe'], tls: null, tlsError: null },
  initialKind: 'ssh',
}));
const banner = (html) => {
  const m = html.match(/<div class="banner bad"[^>]*>([\s\S]*?)<\/div>/);
  return m ? m[1] : '';
};

describe('장비 신뢰 파일 배너 — 원인과 조치를 나눠 말한다', () => {
  it('읽지 못함 + 원본을 옮기지 못함(writeBlocked) — "보존했다" 가 아니라 "저장을 멈췄다" + 권한·재시작 조치', () => {
    const b = banner(render({ code: 'unreadable', detail: 'EACCES', writeBlocked: true }));
    expect(b).toContain('장비 신뢰 파일을 읽지 못했습니다(unreadable · EACCES)');
    expect(b).toContain('<b>원본을 옮기지 못해 저장을 멈췄습니다</b>');
    expect(b).toContain('포탈을 재시작하세요');
    expect(b).not.toContain('보존했습니다');
    expect(b).not.toContain('손상 원본');
    expect(b).toContain('<b>손상이 아니라</b>');
    expect(b).not.toContain('**');
  });
  it('읽지 못함 + 보존됨 — "손상" 이라 말하지 않고 보존본 이름을 준다', () => {
    const b = banner(render({ code: 'unreadable', detail: 'EACCES', preserved: 'peer-trust.json.corrupt.1780000000000' }));
    expect(b).toContain('읽지 못한 원본은 ‘peer-trust.json.corrupt.1780000000000’ 로 보존했습니다');
    expect(b).not.toContain('손상 원본');
    expect(b).not.toContain('저장을 멈췄습니다');
  });
  it('손상 + 보존됨 — 손상이라 말하고 보존본 이름을 준다', () => {
    const b = banner(render({ code: 'corrupt', preserved: 'peer-trust.json.corrupt.1780000000001' }));
    expect(b).toContain('장비 신뢰 파일을 읽지 못했습니다(corrupt)');
    expect(b).toContain('내용이 손상돼 해석하지 못했습니다');
    expect(b).toContain('손상 원본은 ‘peer-trust.json.corrupt.1780000000001’ 로 보존했습니다');
  });
  it('보존본 이름이 없으면(구버전 서버 등) 보존했다고 단정하지 않는다', () => {
    const b = banner(render({ code: 'corrupt' }));
    expect(b).not.toContain('보존했습니다');
    expect(b).toContain('peer-trust.json.corrupt.*');
  });
  it('loadError 가 없으면 배너가 없다', () => {
    expect(banner(render(null))).toBe('');
  });
});
