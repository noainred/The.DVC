import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cellText, CODE_TEXT, codeTone, sourceText, summaryText, osText, shownOf, bytesText } from './serverInfoText.js';

const base = (o = {}) => ({ model: { value: 'GX-650', missing: false }, cpuCores: { value: 64, missing: false }, memBytes: { value: 512 * 1024 ** 3, missing: false }, ...o });

describe('서버 정보 — 표시 도우미', () => {
  it('못 읽은 칸은 이유와 함께 ‘—’(0 이 아니다) · 값이 없으면 단위를 붙이지 않는다', () => {
    expect(cellText({ value: null, missing: true, reason: 'permission' })).toBe('— 못 읽음 · 권한');
    expect(cellText({ value: null, missing: true, reason: 'absent' })).toBe('— 없음');
    expect(cellText(undefined)).toBe('—');
    expect(cellText({ value: 0, missing: false })).toBe('0');
    expect(bytesText(null)).toBe('—');
    expect(bytesText(3.84e12)).toMatch(/TB$/);
  });
  it('보일 값의 출처 — 성공 · 일부만 · 지난 값(실패 행) · 없음(반증 F10)', () => {
    expect(shownOf({ ok: true, base: base() }).kind).toBe('now');
    expect(shownOf({ ok: false, partial: true, base: base() }).kind).toBe('partial');
    expect(shownOf({ ok: false, code: 'auth-rejected', lastOk: { ok: true, at: 1, base: base() } }).kind).toBe('last');
    expect(shownOf({ ok: false, code: 'connect' })).toBe(null);
  });
  it('요약 — 지난 값 · 일부만은 앞에 밝힌다(지금 값처럼 보이지 않게)', () => {
    expect(summaryText({ ok: true, base: base(), disks: [{}, {}], fs: [{ mount: '/', usePct: 41 }, { mount: '/data', usePct: 63 }] })).toBe('GX-650 · 64코어 · 512.0 GB · 디스크 2개 · /data 63%');
    expect(summaryText({ ok: false, code: 'connect', lastOk: { ok: true, base: base(), disks: null, fs: null } })).toMatch(/^지난 값 · GX-650/);
    expect(summaryText({ ok: false, partial: true, code: 'exec-timeout', base: base(), disks: null, fs: null })).toMatch(/^일부만 · /);
    expect(summaryText(null)).toBe('—');
  });
  it('코드 글 · 색 — 서버 코드 전부에 글이 있다', () => {
    for (const c of ['ok', 'unparsed', 'maybe-windows', 'not-found', 'registry-unreadable', 'edge-delegated', 'disabled', 'not-configured', 'cred', 'auth-rejected', 'same-cred-rejected', 'hostkey', 'timeout', 'exec-timeout', 'exec-truncated', 'connect', 'no-plan']) expect(CODE_TEXT[c], c).toBeTruthy();
    expect(codeTone('ok')).toBe('ok'); expect(codeTone('exec-timeout')).toBe('warn'); expect(codeTone('auth-rejected')).toBe('bad');
  });
  it('136회차 — 서버 readServer.READ_CODES 전부에 글이 있다(손으로 적은 목록이 아니라 서버 소스와 대조 · WinRM 의 tls 가 빠져 코드 글자가 그대로 보였다)', () => {
    const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../../server/src/sshaccess/readServer.js'), 'utf8');
    const m = /export const READ_CODES = Object\.freeze\(\[([^\]]{1,2000})\]\)/.exec(src);
    expect(m, 'READ_CODES 를 찾지 못함').toBeTruthy();
    const codes = [...m[1].matchAll(/'([a-z-]{1,40})'/g)].map((x) => x[1]);
    expect(codes).toContain('tls');
    for (const c of codes) expect(CODE_TEXT[c], c).toBeTruthy();
  });
  it('계정이 오는 곳 · OS 글', () => {
    expect(sourceText({ agent: 'e1' }).label).toBe('엣지가 읽음');
    expect(sourceText({ account: { source: 'os' } }).label).toBe('OS 종류에서 물려받음');
    expect(sourceText({ account: { pending: true } }).label).toBe('승인 대기');
    expect(osText('')).toBe('미지정(Linux 로 읽음)');
  });
});
