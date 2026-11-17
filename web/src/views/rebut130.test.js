/**
 * 전체 점검 130회차(126 · 127회차 수정의 반증) — 웹 쪽 확정분.
 *  · R5: VM 내보내기 ‘인벤토리’ 타일 — 수집이 멈춘 vCenter(서버 status.invNotCurrent)의 인벤토리를 ‘마지막 N초 전’(스냅샷 시각)이라 말하지 않는다.
 *  · R6: 127회차 C4(배지 6곳)의 남은 형제 4곳 — 못 읽음 정지(정지 기록 파일 읽기 오류 · 시도 0회)에 ‘인증 실패 정지’ 를 박아 두지 않는다(판정은 공용 isUnreadStop 하나).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceTiles } from './tools/vmExportText.js';
import { serverState } from './tools/cvpText.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;

describe('130회차 R5 VM 내보내기 인벤토리 타일', () => {
  const base = { vmTotal: 214, vmOn: 200, templates: 3, cfgVms: 210, devVms: 205 };
  it('정상이면 예전 그대로', () => {
    const t = sourceTiles({ ...base, invAt: NOW - 41_000 }, { now: NOW })[0];
    expect(t).toMatchObject({ value: '214대', meta: '켜짐 200 · 템플릿 3 · 마지막 41초 전', tone: 'ok' });
  });
  it('수집이 멈춘 vCenter — 사유와 읽은 시각을 말한다(행 수는 그대로)', () => {
    const t = sourceTiles({ ...base, invAt: NOW - 3 * 3_600_000, invNotCurrent: { reason: 'unreachable', why: '연결 실패' } }, { now: NOW })[0];
    expect(t.value).toBe('214대');
    expect(t.meta).toBe('켜짐 200 · 템플릿 3 · 수집 멈춤(연결 실패) — 3시간 전에 읽은 값');
    expect(t.tone).not.toBe('ok');
    expect(t.meta).not.toContain('마지막 ');
  });
  it('읽은 시각을 모르면(점검중 — 직전 캐시) 그렇게 말한다 — 지어내지 않는다', () => {
    const t = sourceTiles({ ...base, invAt: null, invNotCurrent: { reason: 'maintenance', why: '점검중' } }, { now: NOW })[0];
    expect(t.meta).toBe('켜짐 200 · 템플릿 3 · 수집 멈춤(점검중) — 읽은 시각 모름');
  });
});

describe('130회차 R6 못 읽음 정지의 배지 글자 — 127회차가 빠뜨린 형제', () => {
  const unread = { since: NOW - 60_000, at: NOW - 60_000, attempts: 0, unread: true, reason: '정지 기록 파일(cvp-auth-stops.json)을 읽지 못해 …' };
  const real = { since: NOW - 60_000, at: NOW - 60_000, attempts: 2, reason: 'HTTP 401 Unauthorized' };
  it('CVP 서버 상태', () => {
    expect(serverState({ status: { ok: false, authStopped: unread } }).label).toBe('정지 기록 읽기 오류');
    expect(serverState({ status: { ok: false, authStopped: { ...unread, unread: undefined } } }).label).toBe('정지 기록 읽기 오류');   // 표지를 떨군 옛 응답(시도 0회)
    expect(serverState({ status: { ok: false, authStopped: real } }).label).toBe('인증 실패 정지');
    expect(serverState({ status: { ok: false, authStopped: true } }).label).toBe('인증 실패 정지');   // 불리언(옛 엣지)
  });
  it('배지를 직접 적던 화면이 공용 글자를 쓴다', () => {
    for (const rel of ['tools/BmSanCompare.jsx', 'tools/BmStorageTool.jsx', 'NsxAdmin.jsx']) {
      const src = fs.readFileSync(path.join(HERE, rel), 'utf8');
      expect(src, rel).toMatch(/authStopShort\(/);
      expect(src.replace(/\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, ''), rel).not.toMatch(/>인증 실패 정지[<{]|\? '인증 실패 정지'/);
    }
    // 시도 수 ‘0회’ 를 붙이지 않는다
    expect(fs.readFileSync(path.join(HERE, 'tools/BmStorageTool.jsx'), 'utf8')).toMatch(/!isUnreadStop\(s\.authStopped\) \? ` · \$\{s\.authStopped\.attempts\}회`/);
  });
});
