/**
 * 전체 점검 127회차 — 서버가 정지 기록 파일을 못 읽는 동안의 정지(표지 unread · 시도 0회)는 **이 대상에서 인증 실패가 확인된 것이 아니다**.
 *  · 판정은 공용 isUnreadStop 하나(서버 util/authGuard.js 와 같은 규칙) — 배지 글자 · vCenter 주문형 조회 문구 · 성능 창 문구가 그것을 쓴다(124회차가 남긴 사본들).
 *  · 서버 정책이 '전부 정지' 에서 '같은 자격증명마다 한 대상으로 먼저 확인' 으로 바뀌었다 — 공용 문구가 '비밀번호를 고쳐도 그때까지는 건너뜁니다' 라고 말하지 않는다.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isUnreadStop, authStopShort, authStopInfo } from './tools/storageAuthText.js';
import { authStopCell, authStopSingleText, authStopNote, authStoppedList } from './vcAuthStopText.js';
import { metricAuthStopText, metricErrorState } from '../components/vmMetricsText.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;
const WAIT = '정지 기록 파일(vcenter-auth-stops.json)을 읽지 못해 이 대상의 주기 수집을 잠시 건너뜁니다 — 읽기 오류(EACCES)이고 원본은 그대로 있습니다.';
const unread = { since: NOW - 60_000, at: NOW - 60_000, attempts: 0, unread: true, reason: WAIT };
const real = { since: NOW - 60_000, at: NOW - 60_000, attempts: 2, reason: 'HTTP 401 Unauthorized' };

describe('127회차 못 읽음 정지 판정 — 공용 하나', () => {
  it('표지 또는 시도 0회 · 빈 값은 0 으로 보지 않는다', () => {
    expect(isUnreadStop(unread)).toBe(true);
    expect(isUnreadStop({ attempts: 0 })).toBe(true);
    expect(isUnreadStop({ attempts: '0' })).toBe(true);
    expect(isUnreadStop(real)).toBe(false);
    for (const v of [null, undefined, '', [], { attempts: null }, { attempts: '' }, {}]) expect(isUnreadStop(v)).toBe(false);
  });
  it('배지 글자', () => {
    expect(authStopShort(unread)).toBe('정지 기록 읽기 오류');
    expect(authStopShort(real)).toBe('인증 실패 정지');
    expect(authStopShort({})).toBe('인증 실패 정지');
  });
  it('배지를 직접 적던 화면이 공용 글자를 쓴다(인증 실패 정지를 박아 두지 않는다)', () => {
    for (const rel of ['tools/PduTool.jsx', 'tools/SanSwitchTool.jsx', 'Nsx.jsx', 'VCenterAdmin.jsx', 'gpu-guest/PhysicalGpuManager.jsx', 'GuestScanJobs.jsx']) {
      const src = fs.readFileSync(path.join(HERE, rel), 'utf8');
      expect(src, rel).toMatch(/authStopShort\(/);
      expect(src, rel).not.toMatch(/>인증 실패 정지<\/span>|'인증 실패 정지 ⓘ'|\? '인증 실패 정지'/);
    }
  });
  it('공용 문구 — 한 대상으로 먼저 확인한다고 말하고, 고쳐도 건너뛴다고 말하지 않는다', () => {
    const r = authStopInfo(unread, { what: '이 vCenter', manual: '연결 테스트', now: NOW });
    expect(r.unread).toBe(true);
    expect(r.text).toContain('같은 자격증명을 쓰는 대상 하나로 먼저 로그인을 확인합니다');
    expect(r.text).not.toMatch(/비밀번호를 고쳐도 그때까지는 건너뜁니다|인증 실패로|실패 0회/);
    expect(r.text).not.toContain('`');
    expect(authStopInfo(real, { now: NOW }).short).toBe('인증 실패 정지');
  });
});

describe('127회차 vCenter 주문형 조회 — 못 읽음 정지를 인증 실패라고 말하지 않는다', () => {
  it('표 한 칸 · 한 줄 안내', () => {
    const c = authStopCell(unread);
    expect(c.text).toBe('정지 기록 읽기 오류');
    expect(c.title).toContain('인증 실패가 확인된 것이 아닙니다');
    expect(c.title).toContain(WAIT);
    expect(authStopCell(real)).toEqual({ text: '인증 정지', title: 'vCenter 인증 실패로 멈춰 있어 조회하지 않았습니다(실패 2회). 비밀번호를 고치거나 설정 › vCenter 연결 테스트가 성공하면 다시 조회합니다.' });
    const s = authStopSingleText(unread);
    expect(s).toContain('**정지 기록 파일을 읽지 못해 조회하지 않았습니다**');
    expect(s).not.toMatch(/vCenter 인증 실패로|비밀번호를 고치거나|`/);
    expect(authStopSingleText(real)).toBe('**vCenter 인증 실패로 조회를 멈췄습니다**(실패 2회) — 계정 잠금을 막으려고 로그인하지 않습니다. 비밀번호를 고치거나 설정 › vCenter 연결 테스트가 성공하면 다시 조회합니다.');
  });
  it('여러 vCenter 각주 — 실제 정지와 못 읽음을 따로 센다', () => {
    expect(authStoppedList({ a: real, b: unread })).toEqual([{ vcenterId: 'a', attempts: 2 }, { vcenterId: 'b', attempts: null, unread: true }]);
    const both = authStopNote({ a: real, b: unread });
    expect(both).toContain('**인증 실패로 멈춘 vCenter** 1곳(‘a’ 실패 2회)');
    expect(both).toContain('**정지 기록 파일을 읽지 못해** vCenter 1곳(‘b’)');
    const only = authStopNote({ b: unread, c: { ...unread } });
    expect(only).toContain('vCenter 2곳(‘b’ · ‘c’)');
    expect(only).not.toMatch(/인증 실패로 멈춘 vCenter/);
    expect(authStopNote({ a: real })).toBe('**인증 실패로 멈춘 vCenter** 1곳(‘a’ 실패 2회)은 조회하지 않았습니다 — 계정 잠금을 막으려고 로그인하지 않습니다. 비밀번호를 고치거나 설정 › vCenter 연결 테스트가 성공하면 다시 조회합니다.');
    expect(authStopNote({})).toBe('');
  });
  it('성능 창 — 409 본문의 시도 0회 · 표지를 지나도 같은 판정', () => {
    const st = metricErrorState({ status: 409, body: { authStopped: true, attempts: 0, since: NOW, reason: WAIT, unread: true } });
    expect(st.authStopped).toEqual({ attempts: 0, since: NOW, reason: WAIT, unread: true });
    const t = metricAuthStopText(st.authStopped);
    expect(t).toContain('**정지 기록 파일을 읽지 못해 조회하지 않았습니다**');
    expect(t).toContain('자동 갱신도 멈췄습니다');
    expect(t).not.toMatch(/실패 0회|계정이 잠깁니다|인증 실패로 멈춘/);
    expect(metricAuthStopText({ attempts: 3 })).toContain('**인증 실패로 멈춘 vCenter 라 자동 갱신을 멈췄습니다**(실패 3회)');
  });
});
