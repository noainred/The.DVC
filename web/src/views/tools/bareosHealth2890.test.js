// v2.890 Bareos 사전 점검 화면 문구(bareosHealthText.js) + 화면 소스 규약.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  healthBadge, healthCounts, healthCell, diskCell, healthBand, fmtBytes, sparkPoints, healthSettingsBody, healthSettingsForm, lastRunText, fromText, HEALTH_LIMIT_TEXT,
} from './bareosHealthText.js';

const here = path.dirname(new URL(import.meta.url).pathname);
const src = (f) => fs.readFileSync(path.join(here, f), 'utf8');
const corp = (verdict, items, o = {}) => ({ vcenterId: 'vc-a', verdict, items, at: Date.UTC(2026, 10, 4, 11, 0), from: 'edge', ...o });

describe('사전 점검 — 표시', () => {
  it('배지 · 모름은 0 이 아니다', () => {
    expect(healthBadge('bad').text).toBe('불가');
    expect(healthBadge('info').text).toBe('참고');
    expect(healthBadge('이상한값').text).toBe('모름');
    expect(healthCounts([{ verdict: 'ok' }, { verdict: 'bad' }, { verdict: 'x' }, null])).toEqual({ ok: 1, warn: 0, bad: 1, unknown: 2 });
    expect(fmtBytes(null)).toBe('—'); expect(fmtBytes(-1)).toBe('—'); expect(fmtBytes(1.5 * 1024 ** 4)).toBe('1.5 TB');
  });
  it('표 칸 — 가장 나쁜 항목 · 정상은 시각 · 중앙이면 밝힘 · 기록 없으면 null', () => {
    const c = corp('bad', [{ key: 'vc', status: 'bad', label: 'vCenter 접속', detail: 'vc:443 접속 거부' }, { key: 'disk', status: 'warn', label: 'SD 디스크 여유', detail: 'x' }]);
    expect(healthCell(c)).toMatchObject({ text: '불가', detail: 'vCenter 접속 — vc:443 접속 거부' });
    expect(healthCell(corp('ok', [], { from: 'central' })).detail).toMatch(/중앙에서/);
    expect(healthCell(corp('unknown', [{ key: 'dir', status: 'unknown', detail: '인증 정지' }])).detail).toBe('인증 정지');
    expect(healthCell(null)).toBeNull();
  });
  it('디스크 칸 — 첫 경로 · 못 읽음 null', () => {
    const c = corp('warn', [{ key: 'disk', status: 'warn', disks: [{ path: '/x', code: 'ENOENT' }, { path: '/v', availBytes: 240 * 1024 ** 3, sizeBytes: 2 * 1024 ** 4, pct: 11.7, daysLeft: 8.6, status: 'warn' }] }]);
    expect(diskCell(c)).toEqual({ tone: 'warn', avail: '240 GB', size: '2.0 TB', days: 9, pct: 11.7 });
    expect(diskCell(corp('unknown', [{ key: 'disk', status: 'unknown' }]))).toBeNull();
  });
  it('띠 — 불가 법인만 · 이름 순', () => {
    const b = healthBand([corp('bad', [{ status: 'bad', label: 'L', detail: 'D' }], { vcenterId: 'z' }), corp('warn', [], { vcenterId: 'w' }), corp('bad', [], { vcenterId: 'a' })], (id) => `n-${id}`);
    expect(b.map((x) => x.name)).toEqual(['n-a', 'n-z']);
    expect(b[1]).toMatchObject({ label: 'L', detail: 'D' });
  });
  it('추이 점 · 표본 2개 미만이면 빈 글', () => {
    expect(sparkPoints([{ used: 1, size: 2 }])).toBe('');
    expect(sparkPoints([{ used: 0, size: 2 }, { used: 2, size: 2 }], 100, 20)).toBe('2.0,18.0 98.0,2.0');
  });
  it('설정 폼 ↔ 본문 — 컨펌된 기본값 · 숫자는 수로 · 빈 칸은 그대로(서버가 거부)', () => {
    const f = healthSettingsForm(null);
    expect(f).toEqual({ enabled: true, time: '20:00', warnPct: 15, warnDays: 14, badPct: 5, badDays: 3, onWorse: true, onRecover: true, inDigest: true });
    expect(healthSettingsBody({ ...f, warnPct: '20', badDays: '' })).toEqual({ enabled: true, time: '20:00', disk: { warnPct: 20, warnDays: 14, badPct: 5, badDays: '' }, mail: { onWorse: true, onRecover: true, inDigest: true } });
    expect(lastRunText(null)).toMatch(/아직/);
    expect(fromText('central')).toMatch(/FD 시점 아님/);
    expect(HEALTH_LIMIT_TEXT).toMatch(/보장하지 않습니다/);
  });
});

describe('사전 점검 — 화면 소스', () => {
  const card = src('BareosHealth.jsx');
  it('관리자가 아니면(403) 조용히 숨긴다 · 늦은 응답 버림 · 표는 STable', () => {
    expect(card).toMatch(/e\?\.status === 403 \|\| e\?\.status === 401\) setD\(\{ hidden: true/);
    expect(card).toMatch(/if \(g === gen\.current\)/);
    expect(card).toMatch(/<STable sortable=\{false\}/);
  });
  it('현황 — 띠 · 열 2개 · 칩 · 열 수에 맞춘 colSpan · KPI 칸은 그대로(사용자 결정)', () => {
    const s = src('BareosSummaryTool.jsx');
    expect(s).toMatch(/<HealthBand /);
    expect(s).toMatch(/>사전 점검<\/th>/); expect(s).toMatch(/>SD 디스크 여유<\/th>/);
    expect(s).toMatch(/점검 경고 \{hBadN\}/);
    expect(s).toMatch(/colSpan=\{hShow \? 9 : 7\}/);
    expect(s).toMatch(/<Stat label="확인 필요"/);
  });
  it('법인 · 설정 화면에 붙는다', () => {
    expect(src('BareosDetailTool.jsx')).toMatch(/<BareosHealthCard key=\{vcId\} vcId=\{vcId\} \/>/);
    expect(src('BareosSettings.jsx')).toMatch(/<BareosHealthSettings writable=\{writable\} \/>/);
  });
});
