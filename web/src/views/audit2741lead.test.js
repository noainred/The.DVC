/**
 * v2.741 리드 통합분 — 그룹 수정이 남긴 화면 배선을 고정한다.
 *
 * ① vCenter 로그 뷰어 기간 선택(DB-01) — 모르는 키는 기본 기간(7일)으로 보고 '전체' 로 넓히지 않는다 · 빈 표는 '이 기간에 없다' 고 말한다.
 * ② 보관 크기 문구(DB-03) — 사용 중 크기를 알면 '사용 중 · 파일 · 빈 공간', 모르면(구버전 서버) 파일 크기만.
 * ③ 성능 샘플러 제외 안내(VC-02) — 사용률을 못 읽어 뺀 VM 을 '사용 0(유휴)' 이 아니라 '뺐다' 고 말한다.
 * ④ CVP 트래픽 KPI(LEFT-04) — 화면이 trafficTotalsText 를 쓰고, 상위 장비 합은 두 방향 다 모르면 '—'.
 * ⑤ VMware 구성 백업 다운로드(AUTHZ-02) — data.csv 권한이 없으면 버튼을 숨기고 사유를 말한다.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VCLOG_PERIODS, VCLOG_DEFAULT_PERIOD, vcLogSinceOf, vcLogEmptyText, vcLogSizeText } from './VcenterLogs.jsx';
import { samplerWithheldNote, normalizeWithheld } from './samplerWithheldText.js';
import { trafficTotalsText } from './tools/cvpOverviewText.js';
import { cloneRunMark } from './authSkipText.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = (rel) => fs.readFileSync(path.join(HERE, rel), 'utf8');
const NOW = Date.UTC(2026, 9, 15, 3, 30, 0);
const DAY = 86_400_000;

describe('① vCenter 로그 기간 선택', () => {
  it('기간 키 → since · 모르는 키는 기본 기간 · 전체는 0', () => {
    expect(VCLOG_DEFAULT_PERIOD).toBe('7d');
    expect(vcLogSinceOf('1d', NOW)).toBe(NOW - DAY);
    expect(vcLogSinceOf('7d', NOW)).toBe(NOW - 7 * DAY);
    expect(vcLogSinceOf('90d', NOW)).toBe(NOW - 90 * DAY);
    expect(vcLogSinceOf('all', NOW)).toBe(0);
    expect(vcLogSinceOf('zzz', NOW), '모르는 키를 전체(0)로 넓히지 않는다').toBe(NOW - 7 * DAY);
    expect(vcLogSinceOf(undefined, NOW)).toBe(NOW - 7 * DAY);
    expect(new Set(VCLOG_PERIODS.map((p) => p.key)).size).toBe(VCLOG_PERIODS.length);
  });
  it('빈 표 문구 — 좁힌 기간이면 넓혀 보라고 말한다', () => {
    expect(vcLogEmptyText('7d')).toMatch(/최근 7일 안에 맞는 로그가 없습니다 — 기간을 넓혀/);
    expect(vcLogEmptyText('all')).toBe('보관된 로그가 없습니다.');
  });
});

describe('② 보관 크기 문구', () => {
  const fmt = (b) => (b == null ? '—' : `${Math.round(b / 1e6)}MB`);
  it('사용 중 크기를 알면 사용 중 · 파일 · 빈 공간', () => {
    expect(vcLogSizeText({ dbSizeBytes: 500e6, dbUsedBytes: 300e6, dbFreeBytes: 200e6 }, fmt))
      .toBe('사용 중 300MB · 파일 500MB · 빈 공간 200MB(새 로그가 다시 씁니다)');
    expect(vcLogSizeText({ dbSizeBytes: 500e6, dbUsedBytes: 500e6, dbFreeBytes: 0 }, fmt)).toBe('사용 중 500MB · 파일 500MB');
  });
  it('구버전 서버(사용 중 크기 없음) — 파일 크기만', () => {
    expect(vcLogSizeText({ dbSizeBytes: 500e6 }, fmt)).toBe('500MB');
    expect(vcLogSizeText(null, fmt)).toBe('—');
  });
});

describe('③ 샘플러 — 사용률을 못 읽은 VM', () => {
  it('lastRun 원본·요약 둘 다 같은 문장 · 0 이면 문장을 만들지 않는다', () => {
    const raw = { staleSkipped: {}, vmperfStale: {}, vmUsageUnknown: { cpu: 3, mem: 2 } };
    const sum = { staleVcenters: 0, totalWithheld: false, vmUsageUnknown: { cpu: 3, mem: 2 } };
    const a = samplerWithheldNote(raw); const b = samplerWithheldNote(sum);
    expect(a).toMatch(/사용률을 읽지 못한 켜진 VM\(CPU 3대 · 메모리 2대\)은 할당·사용 계열에서 뺐습니다 — 사용 0\(유휴\)으로 채우지 않았습니다/);
    expect(b).toBe(a);
    expect(samplerWithheldNote({ staleSkipped: {}, vmperfStale: {}, vmUsageUnknown: { cpu: 0, mem: 0 } })).toBeNull();
    expect(normalizeWithheld({ staleSkipped: {}, vmperfStale: {} }).vmUsageUnknown).toBeNull();
    expect(samplerWithheldNote({ staleSkipped: {}, vmperfStale: {}, vmUsageUnknown: { mem: 4 } })).toMatch(/\(메모리 4대\)/);
  });
});

describe('④ CVP 트래픽 KPI', () => {
  it('전부 못 읽은 방향은 —, 일부만 못 읽었으면 note', () => {
    const t = trafficTotalsText({ portsMeasured: 10, devicesMeasured: 4, inBps: 1e9, outBps: 0, inUnread: 1, outUnread: 4 });
    expect(t.inText).not.toBe('—');
    expect(t.inNote).toMatch(/수신 못 읽은 장비 1대/);
    expect(t.outText, '전부 못 읽은 송신은 0 bps 가 아니다').toBe('—');
  });
  it('화면이 trafficTotalsText 를 쓰고, 상위 장비 합은 두 방향 다 null 이면 null 을 넘긴다', () => {
    const s = src('tools/CvpOverview.jsx');
    expect(s).toMatch(/const tt = trafficTotalsText\(t\)/);
    expect(s).not.toMatch(/t\.portsMeasured > 0 \? bpsText\(t\.inBps\)/);
    expect(s).not.toMatch(/\(d\.inBps \|\| 0\) \+ \(d\.outBps \|\| 0\)/);
    expect(s).toMatch(/d\.inBps == null && d\.outBps == null \? null/);
  });
});

describe('⑤ VMware 구성 백업 다운로드', () => {
  it('canCsv() 일 때만 버튼 — 아니면 사유', () => {
    const s = src('DavinciChecks.jsx');
    expect(s).toMatch(/canCsv\(\)\s*\n?\s*\? <button[^>]*onClick=\{download\}/);
    expect(s).toMatch(/내보내기 권한\(data\.csv\)이 있는 계정만/);
  });
});

describe('⑥ VM 복제 — 재시작 뒤 정리 포기는 일시 보류가 아니다', () => {
  it('gave-up 은 ⚠(빨강), 나머지 건너뜀은 ⏸', () => {
    expect(cloneRunMark({ ok: false, skipped: 'restart-cleanup-gave-up' })).toEqual({ icon: '⚠', tone: 'red' });
    expect(cloneRunMark({ ok: false, skipped: 'restart-cleanup-pending' })).toEqual({ icon: '⏸', tone: 'amber' });
    expect(cloneRunMark({ ok: false, skipped: 'restart-interrupted' })).toEqual({ icon: '⏸', tone: 'amber' });
    expect(cloneRunMark({ ok: false, skipped: true })).toEqual({ icon: '⏸', tone: 'amber' });
  });
  it('서버 runner 가 실제로 그 코드를 쓴다', () => {
    const r = fs.readFileSync(path.join(HERE, '../../../server/src/vmclone/runner.js'), 'utf8');
    expect(r).toMatch(/'restart-cleanup-gave-up'/);
  });
});
