/**
 * 2026-10-09 검토 S-09(그룹 J) — 수집 서버 화면의 전송 보호 문구(views/collectors/transportText.js).
 * 서버 판정(collector/transportPolicy.js)이 싣는 값을 문장으로만 바꾼다 — 폼의 '평문인가' 는 서버 urlTransport 와 같은 규칙.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import {
  transportBadge, isInsecureHttpUrl, sameCollectorUrl, formHttpNote, transportBannerLines, rejectedText, importHttpNote, REJECTED_HELP,
} from './transportText.js';

describe('isInsecureHttpUrl — 서버 urlTransport 와 같은 규칙', () => {
  it('원격 http 만 평문, 스킴 없는 주소·https·루프백은 아니다', () => {
    expect(isInsecureHttpUrl('http://10.1.1.1:4000')).toBe(true);
    expect(isInsecureHttpUrl('HTTP://edge.corp:4000')).toBe(true);
    expect(isInsecureHttpUrl('https://10.1.1.1:4443')).toBe(false);
    expect(isInsecureHttpUrl('10.1.1.1:4000')).toBe(false); // 서버가 https:// 를 붙인다
    expect(isInsecureHttpUrl('ftp://10.1.1.1:21')).toBe(false); // http 가 아니다(형식 오류는 서버가 말한다)
    expect(isInsecureHttpUrl('ws://10.1.1.1:4000')).toBe(false);
    expect(isInsecureHttpUrl('http://127.0.0.1:4000')).toBe(false);
    expect(isInsecureHttpUrl('http://127.5.5.5:4000')).toBe(false);
    expect(isInsecureHttpUrl('http://[::1]:4000')).toBe(false);
    expect(isInsecureHttpUrl('http://localhost:4000')).toBe(false);
    expect(isInsecureHttpUrl('http://')).toBe(false);
    expect(isInsecureHttpUrl('')).toBe(false);
    expect(isInsecureHttpUrl(null)).toBe(false);
  });
  it('같은 접속처 판정 — 표기 차이(대소문자·끝 슬래시·기본 포트)를 무시', () => {
    expect(sameCollectorUrl('http://10.1.1.1:4000', 'HTTP://10.1.1.1:4000/')).toBe(true);
    expect(sameCollectorUrl('http://e', 'http://e:80')).toBe(true);
    expect(sameCollectorUrl('http://10.1.1.1:4000', 'https://10.1.1.1:4000')).toBe(false);
    expect(sameCollectorUrl('', '')).toBe(false);
  });
});

describe('transportBadge', () => {
  it('안전한 상태는 배지 없음 · 평문 세 상태는 각자 문구', () => {
    expect(transportBadge({ state: 'tls' })).toBe(null);
    expect(transportBadge({ state: 'loopback' })).toBe(null);
    expect(transportBadge(null)).toBe(null);
    const legacy = transportBadge({ state: 'http-legacy', formerRule: '10.3.0.0/16' });
    expect(legacy.tone).toBe('red'); expect(legacy.label).toBe('평문 HTTP');
    expect(legacy.title).toMatch(/승인 기록 없는 평문 HTTP/); expect(legacy.title).toMatch(/지금은 빠졌습니다/);
    const ap = transportBadge({ state: 'http-approved', exception: { reason: 'IPsec 터널', by: 'boss', at: 1_700_000_000_000 } });
    expect(ap.tone).toBe('amber'); expect(ap.title).toMatch(/사유: IPsec 터널/); expect(ap.title).toMatch(/승인: boss/);
    const al = transportBadge({ state: 'http-allowlisted', rule: '10.1.0.0/16' });
    expect(al.title).toMatch(/COLLECTOR_HTTP_ALLOW ‘10\.1\.0\.0\/16’/);
  });
});

describe('formHttpNote', () => {
  it('평문이 아니면 null · 새 주소는 예외 안내 · 기존 그대로의 주소는 예외 없이 저장된다고 말한다', () => {
    expect(formHttpNote({ url: 'https://e:4443' })).toBe(null);
    const fresh = formHttpNote({ url: 'http://10.1.1.1:4000' });
    expect(fresh.legacyOk).toBe(false); expect(fresh.text).toMatch(/예외를 승인하고 사유/);
    const kept = formHttpNote({ url: 'http://10.1.1.1:4000/', editing: true, originalUrl: 'http://10.1.1.1:4000' });
    expect(kept.legacyOk).toBe(true); expect(kept.text).toMatch(/예외 없이도 저장/);
    const moved = formHttpNote({ url: 'http://10.1.1.2:4000', editing: true, originalUrl: 'http://10.1.1.1:4000' });
    expect(moved.legacyOk).toBe(false);
  });
});

describe('transportBannerLines', () => {
  it('말할 것이 없으면 빈 배열(전부 https · TLS 리스닝)', () => {
    expect(transportBannerLines(null)).toEqual([]);
    const lines = transportBannerLines({ summary: { total: 2, tls: 2 }, listener: { tls: true, tlsPort: 4443, warnings: [] }, wanTls: { verify: true }, allowlist: {}, centralUrl: {} });
    expect(lines).toEqual([{ tone: 'info', text: '이 포탈은 HTTPS(:4443) 로 받습니다.' }]);
  });
  it('승인 기록 없는 평문이 있으면 red, 예외만이면 amber · 리스너 평문 · CA 오류 · 검증 해제 · 엣지 CENTRAL_URL', () => {
    const lines = transportBannerLines({
      summary: { httpLegacy: 2, httpApproved: 1, httpAllowlisted: 0 },
      listener: { tls: false, warnings: [] },
      wanTls: { verify: false, caError: 'WAN_TLS_CA_FILE(x) 을(를) 쓰지 못했습니다 — 파일이 없습니다' },
      allowlist: { configured: true, wildcard: true, rules: ['*'], invalid: ['bad host'] },
      centralUrl: { insecure: true, warning: 'CENTRAL_URL 이 평문 HTTP(central) 입니다' },
    });
    expect(lines[0].tone).toBe('red'); expect(lines[0].text).toMatch(/평문 HTTP 수집 서버 3대 — 승인 기록 없음 2 · 예외 승인 1 · 허용 목록 0/);
    const all = lines.map((l) => l.text).join('\n');
    expect(all).toMatch(/평문 HTTP 로만 받습니다/);
    expect(all).toMatch(/검증에 실패합니다/);
    expect(all).toMatch(/WAN_TLS_INSECURE=true/);
    expect(all).toMatch(/COLLECTOR_HTTP_ALLOW=\*/);
    expect(all).toMatch(/형식이 틀린 항목/);
    expect(all).toMatch(/CENTRAL_URL 이 평문/);
    const amberOnly = transportBannerLines({ summary: { httpLegacy: 0, httpApproved: 1 }, listener: { tls: true } });
    expect(amberOnly[0].tone).toBe('amber');
  });
  it('인증서 만료일을 모르면 숫자를 지어내지 않는다(null 은 0일이 아니다)', () => {
    const t = transportBannerLines({ listener: { tls: true, tlsPort: 4443, cert: { daysLeft: null } } })[0].text;
    expect(t).not.toMatch(/0일/);
    const t2 = transportBannerLines({ listener: { tls: true, cert: { daysLeft: 12 }, httpAlso: true, httpPort: 4000 } });
    expect(t2[0].text).toMatch(/만료 12일 남음/); expect(t2[1].text).toMatch(/TLS_HTTP_ALSO/);
  });
});

describe('거부 기록·CSV 안내', () => {
  it('rejectedText · REJECTED_HELP · importHttpNote', () => {
    expect(rejectedText({ source: 'self-register', name: 'gm9', url: 'http://10.9.9.9:4000', count: 3, at: 1_700_000_000_000 })).toMatch(/엣지 자기등록 — ‘gm9’ http:\/\/10\.9\.9\.9:4000 · 3회/);
    expect(rejectedText(null)).toBe('');
    expect(REJECTED_HELP).toMatch(/EDGE_ADVERTISE_URL=https/);
    expect(importHttpNote({ insecureRows: 0 })).toBe('');
    expect(importHttpNote({ insecureRows: 2 })).toMatch(/승인된 예외만/);
    expect(importHttpNote({ insecureRows: 2 }, { approved: true })).toMatch(/예외 승인합니다/);
  });
  it('문구에 백틱이 없다(BoldText 는 백틱을 해석하지 않는다)', () => {
    const src = fs.readFileSync(new URL('./transportText.js', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    // 템플릿 리터럴 구분자는 있어도 된다 — 문구 안의 '이스케이프된' 백틱만 찾는다
    expect(/\\`/.test(src)).toBe(false);
  });
});
