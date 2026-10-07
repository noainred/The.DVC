/**
 * v2.720 감사 그룹 G5 — R2-02(데모 거부 화면 역할 표기) · R2-03(기간 중 생성 VM 표지) · R2-04(vCenter 선택지 누적) ·
 * B1-03(관제 콘솔 전력 타일 0 kW) · B1-07(PDU 전력 부분 합).
 * 웹 테스트는 DOM 이 없는 node 환경이라 판정·문구는 순수 헬퍼를 실제로 불러 고정한다.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describePermission, deniedRoleLabel, deniedSubText } from '../components/accessDeniedText.js';
import { bornWindowText } from './bizreport/availText.js';
import { mergeVcChoices, isFullVcChoices } from './tools/vcChoices.js';
import { buildDomainTiles, pduSummary } from '../console/consoleData.js';
import { stripComments } from '../test/_stripComments.js';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('R2-02 데모 거부 화면', () => {
  const demo = describePermission({ demoGuest: true });
  it('데모 계정은 요청 문맥 역할(admin)이 아니라 데모 계정으로 표기한다', () => {
    expect(deniedRoleLabel({ username: 'guest', role: 'admin', demoGuest: true }, demo)).toBe('데모 계정');
    expect(deniedRoleLabel({ username: 'guest', role: 'admin' }, demo)).toBe('데모 계정');
    expect(deniedRoleLabel({ username: 'op', role: 'operator' }, describePermission({ requiredRole: ['admin'] }))).toBe('운영자(operator)');
    expect(deniedRoleLabel({ username: 'x' }, describePermission(null))).toBe('');
  });
  it('데모 거부의 머리말은 재로그인으로 해결되지 않는다고 말하지 않는다', () => {
    expect(deniedSubText(demo)).not.toMatch(/해결되지 않습니다/);
    expect(deniedSubText(demo)).toMatch(/일반 계정/);
    expect(deniedSubText(describePermission({ requiredPerm: ['tools'] }))).toMatch(/재로그인으로는 해결되지 않습니다/);
  });
  it('AccessDenied 가 두 헬퍼로 그린다(roleName 직접 호출 없음)', () => {
    const src = stripComments(fs.readFileSync(path.join(here, '../components/AccessDenied.jsx'), 'utf8'));
    expect(src).toMatch(/deniedRoleLabel\(user, d\)/);
    expect(src).toMatch(/deniedSubText\(d\)/);
    expect(src).not.toMatch(/roleName\(user\.role\)/);
  });
});

describe('R2-03 기간 중 생성 VM 표지', () => {
  const fmt = (ts) => `T${ts}`;
  it('측정 시작 시각(windowFrom)을 적는다 — 생성 시각이 아니라 서버가 정한 측정 시작', () => {
    expect(bornWindowText({ bornInWindow: true, windowFrom: 1_000 }, fmt)).toBe('기간 중 생성 — T1000 부터 잼');
  });
  it('시각을 모르면 지어내지 않는다 · 생성 VM 이 아니면 null', () => {
    expect(bornWindowText({ bornInWindow: true, windowFrom: null }, fmt)).not.toMatch(/T/);
    expect(bornWindowText({ bornInWindow: false, windowFrom: 1 }, fmt)).toBeNull();
  });
  it('화면이 옛 고정 문구를 쓰지 않는다', () => {
    const src = fs.readFileSync(path.join(here, 'tools/VmAvailabilityTool.jsx'), 'utf8');
    expect(src).not.toMatch(/생성 뒤부터 잼/);
    expect(src).toMatch(/bornWindowText\(v\)/);
  });
});

describe('R2-04 vCenter 선택지는 전체 응답에서 온 목록만 병합한다', () => {
  const A = { vcenterId: 'a', name: 'A' }; const B = { vcenterId: 'b', name: 'B' }; const C = { vcenterId: 'c', name: 'C' };
  it('범위가 골라진 채 진입해 법인만 바꾸면 방문한 vCenter 를 모으지 않는다', () => {
    const first = mergeVcChoices([], [A], 'a');
    expect(isFullVcChoices(first)).toBe(false);
    expect(mergeVcChoices(first, [B], 'b').map((v) => v.vcenterId)).toEqual(['b']);
  });
  it('전체 응답 뒤에는 고른 응답이 목록을 지우지 않는다(기준 유지)', () => {
    const full = mergeVcChoices([], [A, B, C], '');
    expect(isFullVcChoices(full)).toBe(true);
    const picked = mergeVcChoices(full, [B], 'b');
    expect(picked.map((v) => v.vcenterId)).toEqual(['a', 'b', 'c']);
    expect(isFullVcChoices(picked)).toBe(true);
    expect(mergeVcChoices(picked, [C], 'c').map((v) => v.vcenterId)).toEqual(['a', 'b', 'c']);
  });
});

describe('B1-03 관제 콘솔 설비·전력 타일', () => {
  const g = { vcenters: 1, vcentersConnected: 1, hosts: 1, vms: 1, networks: 1 };
  const fac = (gg) => buildDomainTiles({ global: gg, alarms: [] }).find((t) => t.name === '설비 · 전력');
  it('전력 보고 서버 0대면 0 kW 가 아니라 —', () => {
    expect(fac({ ...g, powerKw: 0, powerReporting: 0 }).value).toBe('—');
  });
  it('보고가 있으면 kW', () => {
    expect(fac({ ...g, powerKw: 12, powerReporting: 3 }).value).toBe('12 kW');
  });
});

describe('B1-07 PDU 전력 합은 읽은 장비만', () => {
  const snap = (powerW) => ({ snapshot: { ok: true, summary: { powerW, sensors: 0 } } });
  it('전력을 못 읽은 PDU 는 0 W 로 더하지 않고 읽은 대수를 센다', () => {
    const s = pduSummary({ devices: [snap(1000), snap(null), snap(500)] });
    expect(s.ok).toBe(3);
    expect(s.powerRead).toBe(2);
    expect(s.powerW).toBe(1500);
  });
  it('한 대도 못 읽었으면 powerW 는 null', () => {
    const s = pduSummary({ devices: [snap(null), snap(undefined)] });
    expect(s.powerRead).toBe(0);
    expect(s.powerW).toBeNull();
  });
});
