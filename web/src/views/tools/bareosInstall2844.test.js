// v2.844 Bareos 완전 설치 화면 문구·판정(bareosInstallText.js) + 화면 소스 규약.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  checkView, checkCountsText, stepView, jobView, edgeAgeText, targetModeText, uploadText, stepDurText, fixesOrdered, retryLabel, defaultPlan, planBody, planIssues, PYVMOMI_REASON,
} from './bareosInstallText.js';

const here = path.dirname(new URL(import.meta.url).pathname);
const src = fs.readFileSync(path.join(here, 'BareosInstall.jsx'), 'utf8');

describe('완전 설치 — 표시 판정', () => {
  it('점검 결과 · 못 읽음은 확인 불가(0 이 아님)', () => {
    expect(checkView('bad').cls).toBe('red');
    expect(checkView('unknown').mark).toMatch(/확인 불가/);
    expect(checkView('이상한값').mark).toMatch(/확인 불가/);
    expect(checkCountsText(null)).toBe('—');
    expect(checkCountsText({ ok: 5, warn: 2, bad: 0, unknown: 1 })).toBe('✓ 5 · ! 2 · ✗ 0 · ? 1');
  });
  it('단계·작업 상태', () => {
    expect(stepView('rolledback').mark).toMatch(/되돌림/);
    expect(jobView('rollback-failed').cls).toBe('red');
    expect(jobView('').text).toBe('—');
  });
  it('엣지 응답 나이 — 기록 없으면 기록 없음(0초 전이 아니다)', () => {
    expect(edgeAgeText(null)).toBe('기록 없음');
    expect(edgeAgeText('')).toBe('기록 없음');
    expect(edgeAgeText(45_000)).toBe('45초 전');
    expect(edgeAgeText(3 * 86_400_000)).toBe('3일 전');
  });
  it('대상 칸 문구', () => {
    expect(targetModeText({ can: false, why: '엣지 노드 없음' })).toBe('불가 — 엣지 노드 없음');
    expect(targetModeText({ can: true, mode: 'reinstall' })).toBe('초기화 후 재설치');
  });
  it('업로드 — 모르면 —, 재사용은 그 사실', () => {
    expect(uploadText(null)).toBe('—');
    expect(uploadText({ sent: null, total: 100 })).toBe('—');
    expect(uploadText({ reused: true })).toMatch(/다시 보내지 않음/);
    expect(uploadText({ sent: 50_000_000, total: 100_000_000 })).toMatch(/50%/);
  });
  it('단계 소요', () => {
    expect(stepDurText({ at: null })).toBe('');
    expect(stepDurText({ at: 1000, endedAt: 76_000 })).toBe('1분 15초');
  });
  it('고치는 방법 — 포탈에서 고치기가 먼저(사용자 채택) · 단추 문구', () => {
    const f = fixesOrdered({ fixes: [{ kind: 'server' }, { kind: 'retry' }, { kind: 'portal', action: 'pyvmomi-fix' }] });
    expect(f.map((x) => x.kind)).toEqual(['portal', 'retry', 'server']);
    expect(retryLabel({ action: 'pyvmomi-fix' }, 2)).toMatch(/2단계부터/);
    expect(retryLabel(null, 6)).toBe('6단계부터 그대로 다시');
  });
  it('계획 — 기본값 · 보내는 모양 · 재설치 확인', () => {
    const b = { contents: { pyvmomi: { versions: ['8.0.3.0.1', '8.0.2.0.1'], default: '8.0.3.0.1' } } };
    const t = { vcenterName: '폴란드', mode: 'reinstall' };
    const p = defaultPlan(b, t);
    expect(p.pyvmomi).toBe('8.0.3.0.1'); expect(p.webui).toBe(true); expect(p.reset.catalog).toBe(true); expect(p.reset.volumes).toBe(false);
    expect(planIssues(p, t).join(' ')).toMatch(/확인/);
    const q = { ...p, reset: { ...p.reset, ack: true, volumes: true, confirmName: '폴란' } };
    expect(planIssues(q, t).join(' ')).toMatch(/법인 이름/);
    expect(planIssues({ ...q, reset: { ...q.reset, confirmName: '폴란드' } }, t)).toEqual([]);
    expect(planIssues({ ...p, volumeDir: '/var' }, { mode: 'install' }).join(' ')).toMatch(/두 단계/);
    const body = planBody({ ...p, pools: { fullDays: '30', incrDays: '7', maxVolumeGB: '40' } });
    expect(body.pools).toEqual({ fullDays: 30, incrDays: 7, maxVolumeGB: 40 });
    expect(body.reset.ack).toBe(false);
  });
  it('pyVmomi 권고 근거는 현장 실측을 밝힌다', () => {
    expect(PYVMOMI_REASON).toMatch(/Python 3\.9/); expect(PYVMOMI_REASON).toMatch(/실측/);
  });
});

describe('완전 설치 화면 소스 규약', () => {
  it('OTP 칸이 없다(사용자 결정 — 코드 입력 없음)', () => {
    expect(src).not.toMatch(/inputMode="numeric"[^>]*otp|name="otp"|aria-label="[^"]*OTP/);
    expect(src).toMatch(/OTP 를 등록한 관리자\(코드 입력 없음\)/);
  });
  it('표는 STable · 대문자 변환 없음 · 버튼 행은 flexWrap', () => {
    expect(src).not.toMatch(/<table/);
    expect(src).not.toMatch(/uppercase/);
    expect(src).toMatch(/const ROW = \{ display: 'flex', flexWrap: 'wrap'/);
  });
  it('vCenter 비밀번호는 보낸 뒤 지운다 · password 입력은 autoComplete new-password', () => {
    expect(src).toMatch(/setVcpass\(''\)/);
    expect(src).toMatch(/type="password"[\s\S]{0,200}autoComplete="new-password"/);
  });
});
