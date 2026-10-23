// v2.768(점검 R3 — G1 백업/복원) 화면 회귀: 복원은 예약 → 재시작 때 적용(C5-02) · 상한으로 엣지 사본을 뺀 백업 경고(C5-01).
// 판정·문구는 화면이 export 한 순수 함수를 실제로 호출한다(node 환경 — DOM 없음). 배선은 주석 제거 후 소스로 고정한다.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { stripComments } from '../test/_stripComments.js';
import { restoreStateText, edgesOmittedText } from './PortalBackup.jsx';

const src = stripComments(fs.readFileSync(new URL('./PortalBackup.jsx', import.meta.url), 'utf8'));

describe('C5-02 — 복원 예약 상태 문구', () => {
  it('예약이 있으면 재시작하면 적용된다고 말하고 완료라고 하지 않는다', () => {
    const t = restoreStateText({ pending: { stagedAt: Date.now(), source: 'portal-backup-x.json.gz', files: ['a.json', 'b.json'] }, last: null, interrupted: false });
    expect(t.pending).toMatch(/재시작하면 적용/);
    expect(t.pending).toMatch(/2개/);
    expect(t.pending).not.toMatch(/복원 완료/);
    expect(t.warn).toBe(true);
  });
  it('적용 결과 — 실패·거부를 숨기지 않고, 실패하면 경고색', () => {
    const ok = restoreStateText({ pending: null, last: { at: 1, ok: true, applied: ['a.json'], failed: [], rejected: [] } });
    expect(ok.last).toMatch(/적용.*1개/); expect(ok.warn).toBe(false);
    const bad = restoreStateText({ pending: null, last: { at: 1, ok: false, applied: [], failed: [{ file: 'users.json', reason: 'EACCES' }], rejected: [] } });
    expect(bad.last).toMatch(/실패 1개\(users\.json\)/); expect(bad.warn).toBe(true);
    expect(restoreStateText({ last: { at: 1, ok: false, reason: 'interrupted', applied: [], failed: [], rejected: [] } }).last).toMatch(/중단/);
  });
  it('값이 없으면 아무것도 말하지 않는다', () => {
    expect(restoreStateText(null)).toEqual({ pending: null, last: null, interrupted: null, warn: false });
    expect(restoreStateText({ pending: null, last: null, interrupted: false }).pending).toBeNull();
  });
  it('배선 — 재시작 여부를 묻고 restart 를 보낸다 · 예약 취소 버튼', () => {
    expect(src).toMatch(/postJson\(`\/admin\/backup\/restore\/\$\{encodeURIComponent\(name\)\}`, \{ restart \}\)/);
    expect(src).toMatch(/postJson\('\/admin\/backup\/restore-staged\/cancel'/);
    expect(src).toMatch(/restoreStateText\(d\.restore\)/);
  });
});

describe('C5-01 — 엣지 사본을 뺀 백업 경고', () => {
  it('뺀 엣지가 있으면 경고, 없으면 빈 문자열', () => {
    expect(edgesOmittedText({ agents: ['e1', 'e2'], capBytes: 64 * 1024 * 1024 })).toMatch(/엣지 설정 사본 2곳/);
    expect(edgesOmittedText(null)).toBe('');
    expect(edgesOmittedText({ agents: [] })).toBe('');
  });
  it('지금 백업·상세 보기에 경고를 싣는다', () => {
    expect(src).toMatch(/edgesOmittedText\(r\.edgesOmitted\)/);
    expect(src).toMatch(/edgesOmittedText\(view\.edgesOmitted\)/);
  });
});

describe('v2.769 R4-D1-2 — 예약 복원 적용 경고 표시', () => {
  it('적용 결과의 warnings(되살린 엣지 토큰·재로그인)를 마지막 적용 문구에 붙이고 경고 배너로 띄운다', () => {
    const t = restoreStateText({ pending: null, last: { at: 1, ok: true, applied: ['a.json'], failed: [], rejected: [], warnings: ['백업에만 있던 엣지 토큰 2개를 되살렸습니다'] } });
    expect(t.last).toContain('주의: 백업에만 있던 엣지 토큰 2개');
    expect(t.warn).toBe(true);
  });
  it('경고가 없으면 예전과 같다', () => {
    const t = restoreStateText({ pending: null, last: { at: 1, ok: true, applied: ['a.json'], failed: [], rejected: [] } });
    expect(t.last).not.toContain('주의');
    expect(t.warn).toBe(false);
  });
});
