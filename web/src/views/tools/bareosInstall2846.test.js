// v2.846 Bareos 완전 설치 버그 점검(반증 판정 hunt/R.md) — 화면 쪽: U-7(postJson 409 를 성공으로 보임) · U-12(못 읽은 볼륨 크기를 0 으로 더함) ·
//   D-2(실행 중 작업 확인 불가 → 그 회차 동의) · C-1(되돌리기 실패 → 다시 되돌리기 · 설치 다시 하기 없음).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  okOrThrow, volumesSizeText, planIssues, planBody, defaultPlan, retryLabel, jobView, rollbackCauseText, runningUnknown, RUNNING_UNKNOWN_OK_LABEL,
} from './bareosInstallText.js';

const here = path.dirname(new URL(import.meta.url).pathname);
const src = fs.readFileSync(path.join(here, 'BareosInstall.jsx'), 'utf8');

describe('U-7 — postJson 의 ok:false(409 본문)를 성공으로 보이지 않는다', () => {
  it('okOrThrow — ok:false 면 사유로 던지고 본문을 e.body 에 싣는다(시작의 precheck 표 되돌림)', () => {
    const r = { ok: true, path: '/etc/bareos/vmware/vc1.ini' };
    expect(okOrThrow(r)).toBe(r);
    const body = { ok: false, code: 'precheck', reason: '사전 점검에 ✗ 항목이 있어 시작하지 않았습니다', precheck: { items: [], blocked: true } };
    let err = null;
    try { okOrThrow(body); } catch (e) { err = e; }
    expect(err?.message).toMatch(/✗ 항목/);
    expect(err?.body?.precheck?.blocked).toBe(true);
    expect(() => okOrThrow({ ok: false }, '지문을 읽지 못했습니다.')).toThrow('지문을 읽지 못했습니다.');
  });
  it('화면의 모든 postJson 결과는 okOrThrow 를 지난다(FD INI 쓰기 · 지문 읽기 · 번들 받기 · 시작 …)', () => {
    const calls = src.match(/postJson\(/g) || [];
    const wrapped = src.match(/okOrThrow\(await postJson\(/g) || [];
    expect(calls.length).toBeGreaterThanOrEqual(8);
    expect(wrapped.length).toBe(calls.length);
    expect(src).toMatch(/fd-thumbprint`, \{\}\), '지문을 읽지 못했습니다\.'\)/);
    expect(src).toMatch(/fd-ini`, \{[^}]*\}\), 'FD INI 를 쓰지 못했습니다\.'\)/);
    // 시작 실패의 precheck 본문이 살아 있어야 '점검 표로 돌아가기' 가 돈다(예전: new Error(r.reason) 로 본문을 버렸다)
    expect(src).not.toMatch(/if \(r\.ok === false\) throw new Error/);
    expect(src).toMatch(/if \(e\?\.body\?\.precheck\) \{ setPre\(e\.body\.precheck\); setStep\('precheck'\); \}/);
  });
});

describe('U-12 — 볼륨 크기 합은 못 읽은 것을 0 으로 더하지 않는다', () => {
  it('모름 · 일부 모름 · 전부 앎', () => {
    expect(volumesSizeText([]).text).toBe('—');
    const one = volumesSizeText([{ path: '/var/lib/bareos/storage', files: 37, bytes: null }]);
    expect(one.text).toBe('크기 모름(1곳)'); expect(one.known).toBe(null);
    expect(one.text).not.toMatch(/0 B/);
    const mixed = volumesSizeText([{ bytes: 2_000_000_000 }, { bytes: null }, { bytes: '' }]);
    expect(mixed.unknown).toBe(2); expect(mixed.text).toMatch(/일부 모름/); expect(mixed.text).toMatch(/모름 2곳/);
    expect(volumesSizeText([{ bytes: 1_000_000 }, { bytes: 0 }]).unknown).toBe(0);
  });
  it('화면은 v.bytes || 0 으로 더하지 않는다', () => {
    expect(src).not.toMatch(/v\.bytes \|\| 0/);
    expect(src).toMatch(/volumesSizeText\(vols\)/);
  });
});

describe('D-2 — 실행 중 작업을 못 읽은 재설치는 그 회차 동의가 있어야 시작', () => {
  const t = { vcenterName: '폴란드', mode: 'reinstall' };
  const b = { contents: { pyvmomi: { versions: ['8.0.3.0.1'], default: '8.0.3.0.1' } } };
  const pre = (status) => ({ items: [{ key: 'running', status }] });
  const p = { ...defaultPlan(b, t), reset: { ack: true, catalog: true, volumes: false, confirmName: '' } };
  it('확인 불가면 동의 전까지 막고, 동의하면 통과 · 새 설치 · 확인된 0 은 해당 없음', () => {
    expect(runningUnknown(pre('unknown'), t)).toBe(true);
    expect(runningUnknown(pre('ok'), t)).toBe(false);
    expect(runningUnknown(pre('unknown'), { mode: 'install' })).toBe(false);
    expect(planIssues(p, t, pre('unknown')).join(' ')).toContain(RUNNING_UNKNOWN_OK_LABEL);
    expect(planIssues({ ...p, runningUnknownOk: true }, t, pre('unknown'))).toEqual([]);
    expect(planIssues(p, t, pre('ok'))).toEqual([]);
    expect(planIssues(p, t)).toEqual([]);
  });
  it('보내는 모양 — 동의는 불리언 true 일 때만 싣는다', () => {
    // v2.847 U2-5: 지금 사전 점검이 '확인 불가' 일 때만(다시 점검해 정상이면 남은 동의를 싣지 않는다)
    const ctx = { pre: pre('unknown'), target: t };
    expect(planBody({ ...p, runningUnknownOk: true }, ctx).runningUnknownOk).toBe(true);
    expect('runningUnknownOk' in planBody({ ...p, runningUnknownOk: true }, { pre: pre('ok'), target: t })).toBe(false);
    expect('runningUnknownOk' in planBody({ ...p, runningUnknownOk: true })).toBe(false);
    expect('runningUnknownOk' in planBody(p, ctx)).toBe(false);
    expect('runningUnknownOk' in planBody({ ...p, runningUnknownOk: 'true' }, ctx)).toBe(false);
  });
  it('실패 카드의 동의 단추 — 문구 · 확인 체크가 있어야 누를 수 있다', () => {
    expect(retryLabel({ action: 'running-unknown-ok' }, 0)).toContain(RUNNING_UNKNOWN_OK_LABEL);
    expect(retryLabel({ action: 'running-unknown-ok' }, 0)).toMatch(/0단계부터/);
    expect(src).toMatch(/x\.action === 'running-unknown-ok' && !unknownAck/);
    expect(src).toMatch(/planIssues\(plan, t, pre\)/);
  });
});

describe('C-1 · C-2 — 되돌리기 실패는 다시 되돌리기(설치 다시 하기 없음)', () => {
  it('상태 · 원인 문구 — 잠금에 걸린 되돌리기를 일부 실패로 단정하지 않는다', () => {
    expect(jobView('rollback-failed').cls).toBe('red');
    expect(jobView('rollback-failed').text).not.toMatch(/일부/);
    expect(rollbackCauseText('busy')).toMatch(/아무것도 바꾸지 않았습니다/);
    expect(rollbackCauseText('ssh-auth')).toMatch(/자동으로 다시 시도하지 않습니다/);
    expect(rollbackCauseText('모르는값')).toMatch(/사유를 확인/);
  });
  it('화면 — rollback-failed 카드에 다시 되돌리기 · SSH 인증 실패면 고쳤음 체크 · 되돌리기를 시도한 작업은 다시 하기 단추가 없다', () => {
    expect(src).toMatch(/j\.status === 'rollback-failed' && <RollbackFailedCard/);
    expect(src).toMatch(/>다시 되돌리기</);
    expect(src).toMatch(/disabled=\{busy \|\| !ack \|\| \(auth && !fixed\)\}/);
    expect(src).toMatch(/onRollback\(auth \? \{ sshFixed: true \} : \{\}\)/);
    expect(src).toMatch(/const fixes = rolledAll \? \[\] : fixesOrdered\(c\)/);
  });
});
