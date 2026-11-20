// v3.17.0 디스크 점검 프로그램 자동 설치 · 설치 디렉터리 — 화면 판정(순수) · 소스 규칙(시안 ⑱ · 사용자 "자동으로 설치하는 기능 추가" · "설치 디렉터리를 사전에 사용자가 지정").
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { dirIssue, pathsPreview, dirLabel, installRowState, skipReason, installResultText, credText, CRED_TEXT } from './focusMonAuditInstallText.js';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

describe('설치 디렉터리', () => {
  it('판정 · 미리 보기', () => {
    expect(dirIssue('')).toBe(null); expect(dirIssue('/opt/dvc/disk-audit')).toBe(null);
    expect(dirIssue('/opt')).toBe('too-shallow'); expect(dirIssue('/tmp/dvc')).toBe('denied'); expect(dirIssue('/opt/dvc; rm -rf /')).toBe('bad-char');
    expect(dirIssue('/opt/../etc')).toBe('dot-segment'); expect(dirIssue('opt/x')).toBe('not-absolute'); expect(dirIssue('/opt/x/')).toBe('trailing-slash');
    expect(pathsPreview('/opt/dvc/disk-audit')).toEqual({ program: '/opt/dvc/disk-audit/rhel_disk_audit.py', wrapper: '/opt/dvc/disk-audit/dvc-disk-audit' });
    expect(pathsPreview('/tmp/x')).toBe(null);
    expect(pathsPreview('', { program: '/usr/local/libexec/dvc/rhel_disk_audit.py', wrapper: '/usr/local/sbin/dvc-disk-audit' }).wrapper).toBe('/usr/local/sbin/dvc-disk-audit');
    expect(dirLabel(null)).toBe('—'); expect(dirLabel('')).toMatch(/기본 경로/);
  });
});

describe('서버 줄 판단', () => {
  const ok = { state: 'ok' };
  it('옛 디렉터리 · 준비됨 · 할 일', () => {
    const r = { ready: { state: 'ready', dir: '' } };
    expect(installRowState(r, ok, '').settled).toBe(true); expect(installRowState(r, ok, '').can).toBe(false);
    const o = installRowState(r, ok, '/opt/dvc/disk-audit');
    expect(o.old).toBe(true); expect(o.can).toBe(true); expect(o.act).toBe('새 디렉터리로 옮김');
    expect(installRowState({ ready: { state: 'notinstalled', dir: null } }, ok, '').act).toBe('새로 설치');
    expect(installRowState({ ready: { state: 'version', dir: '' } }, ok, '').act).toBe('판본 맞춤');
    expect(installRowState(r, { state: 'feature' }, '/opt/dvc/disk-audit').can).toBe(false);
    expect(installRowState({ ...r, job: { mode: 'run' } }, ok, '/opt/dvc/disk-audit').can).toBe(false, '작업 중이면 닫는다');
    expect(installRowState(r, ok, null).can).toBe(false, '설정을 못 읽으면 설치하지 않는다');
  });
  it('건너뛰는 까닭 · 고르기', () => {
    const amb = { state: 'ambig', choices: [{ id: 'a1' }, { id: 'a2' }] };
    const r = { ready: { state: 'notinstalled', dir: null } };
    expect(skipReason(r, amb, '', null)).toMatch(/고르지 않음/); expect(skipReason(r, amb, '', 'a2')).toBe(null); expect(skipReason(r, amb, '', 'zz')).toMatch(/고르지 않음/);
    expect(skipReason({ ready: { state: 'ready', dir: '' } }, { state: 'ok' }, '', null)).toMatch(/이미/);
    expect(skipReason(r, { state: 'noentry' }, '', null)).toMatch(/설치 계정 없음/);
    expect(skipReason(r, { state: 'ok' }, null, null)).toMatch(/설정을 읽지 못함/);
  });
  it('결과 글', () => {
    expect(installResultText(null)).toBe(null);
    expect(installResultText({ code: 'ok', oldRm: 2 }).label).toMatch(/설치함/);
    expect(installResultText({ code: 'script', fail: 'dir-noexec' }).label).toMatch(/noexec/);
    expect(installResultText({ code: 'sudo-password' }).sub).toMatch(/NOPASSWD/);
    expect(installResultText({ code: 'cred', cred: 'feature' }).label).toMatch(/키에/);
    expect(credText({ state: 'nope' })).toBe(CRED_TEXT.error);
  });
});

describe('화면 소스 규칙', () => {
  it('표는 STable · 고르기는 Select · OTP 와 함께 · 백틱 없는 문구', () => {
    const src = read('./FocusMonAuditInstall.jsx');
    expect(src).toMatch(/<STable/); expect(src).not.toMatch(/<table/); expect(src).not.toMatch(/<select/);
    expect(src).toMatch(/putJson\('\/tools\/focus-mon\/audit\/install-dir', \{ dir: want, otp \}\)/);
    expect(src).toMatch(/postJson\('\/tools\/focus-mon\/audit\/install', \{ ids: todo\.map\(\(x\) => x\.id\), accounts, otp \}\)/);
    const text = src.replace(/`[^`]*`/g, '').replace(/className="[^"]*"/g, '');
    expect(/>[^<]*`[^<]*</.test(text)).toBe(false);
    expect(src).not.toMatch(/uppercase/);
  });
});
