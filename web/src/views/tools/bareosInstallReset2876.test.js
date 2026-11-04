// v2.876 완전 설치 — 포탈 미등록 Bareos 를 지우고 설치('초기화 후 재설치로 진행' — 2026-11-04 사용자 화면: 사전 점검 '이미 설치된 Bareos ✗' 에서 막다른 길).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { canResetExisting, effectiveTarget, resetExistingPlan, planBody, planIssues, defaultPlan } from './bareosInstallText.js';

const here = path.dirname(new URL(import.meta.url).pathname);
const src = fs.readFileSync(path.join(here, 'BareosInstall.jsx'), 'utf8');
const T = { vcenterId: 'vc1', vcenterName: '법인1', mode: 'install', can: true, director: null };
const BUNDLE = { contents: { pyvmomi: { versions: ['8.0.3.0.1'], default: '8.0.3.0.1' } } };
const pre = (status, mode = 'install') => ({ mode, items: [{ key: 'os', status: 'ok' }, { key: 'bareos', status }] });

describe('초기화 후 재설치로 진행 — 판정', () => {
  it('새 설치 대상 + 사전 점검 기존 Bareos ✗ 일 때만 보인다', () => {
    expect(canResetExisting(pre('bad'), T)).toBe(true);
    expect(canResetExisting(pre('ok'), T)).toBe(false);
    expect(canResetExisting(pre('bad'), { ...T, mode: 'reinstall' })).toBe(false);
    expect(canResetExisting(pre('warn', 'reinstall'), T)).toBe(false);
    expect(canResetExisting(pre('bad'), { ...T, can: false })).toBe(false);
    expect(canResetExisting(null, T)).toBe(false);
    expect(canResetExisting(pre('bad'), null)).toBe(false);
  });
  it('계획에 표지가 있을 때만 재설치로 본다(원래 행은 그대로)', () => {
    expect(effectiveTarget(T, null)).toBe(T);
    expect(effectiveTarget(T, { resetExisting: 'true' })).toBe(T);
    const e = effectiveTarget(T, { resetExisting: true });
    expect(e.mode).toBe('reinstall'); expect(e.resetUnregistered).toBe(true); expect(T.mode).toBe('install');
    const re = { ...T, mode: 'reinstall', director: { id: 'd' } };
    expect(effectiveTarget(re, { resetExisting: true })).toBe(re);
    expect(effectiveTarget(null, { resetExisting: true })).toBe(null);
  });
  it('계획 기본값은 재설치와 같다(확인 체크 필요 · 카탈로그 기본 삭제 · 볼륨 기본 보존) · 본문에 표지를 싣는다', () => {
    const p = resetExistingPlan(BUNDLE, T);
    expect(p.resetExisting).toBe(true);
    expect(p.reset).toEqual({ ack: false, catalog: true, volumes: false, confirmName: '' });
    expect(p.directorName).toBe('법인1 Bareos');
    const b = planBody(p);
    expect(b.resetExisting).toBe(true); expect(b.reset.ack).toBe(false);
    expect(planBody(defaultPlan(BUNDLE, T)).resetExisting).toBeUndefined();
    const issues = planIssues(p, effectiveTarget(T, p));
    expect(issues.join(' ')).toMatch(/확인했다는 표시/);
    expect(planIssues({ ...p, reset: { ...p.reset, volumes: true, ack: true, confirmName: '틀림' } }, effectiveTarget(T, p)).join(' ')).toMatch(/법인 이름/);
  });
});

describe('초기화 후 재설치로 진행 — 화면 소스', () => {
  it('사전 점검 화면이 판정 함수로 단추를 보이고 쓰기 가능할 때만', () => {
    expect(src).toMatch(/canReset=\{writable && canResetExisting\(pre, t\)\}/);
    expect(src).toMatch(/초기화 후 재설치로 진행…/);
  });
  it('화면 대상은 effectiveTarget · 대상 표로 돌아가면 계획을 지운다(다른 대상에 표지가 남지 않게)', () => {
    expect(src).toMatch(/const t = effectiveTarget\(t0, plan\)/);
    expect(src).toMatch(/const toTargets = \(\) => \{ setStep\('targets'\); setPlan\(null\);/);
  });
  it('미등록 Bareos 의 초기화 확인 · 마무리 문구는 기존 Director 를 말하지 않는다', () => {
    expect(src).toMatch(/t\.resetUnregistered \? <>이 서버에는 <b>포탈에 등록되지 않은 Bareos<\/b>/);
    expect(src).toMatch(/j\.mode === 'reinstall' && !j\.resetUnregistered && <><dt className="muted">백업 대상<\/dt>/);
  });
});
