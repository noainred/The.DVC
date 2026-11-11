/**
 * v2.964 Ping 측정 설정 문구·폼 검사(사용자 요청 "화면에서 주기 설정할 수 있게 · ping 은 중단없이 계속 ping").
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { durText, settingsLine, sourceLine, monitorText, formOf, payloadOf, pingLoadOf, loadText, PING_SETTING_RANGES } from './pingSettingsText.js';

const S = { probeIntervalMs: 1000, summaryIntervalMs: 60000, timeoutMs: 2500, source: { probeIntervalMs: 'default', summaryIntervalMs: 'env', timeoutMs: 'default' } };

describe('문구', () => {
  it('시간 표기 · 한 줄 요약', () => {
    expect(durText(1000)).toBe('1초');
    expect(durText(2500)).toBe('2.5초');
    expect(durText(90000)).toBe('1분 30초');
    expect(durText(3600000)).toBe('1시간');
    expect(durText(null)).toBe('—');
    expect(settingsLine(S)).toBe('1초마다 측정 · 1분마다 요약 저장 · 시한 2.5초');
  });
  it('출처 · 모니터 상태', () => {
    expect(sourceLine(S)).toBe('환경 변수(포탈 시작 값)');
    expect(sourceLine({ ...S, source: { probeIntervalMs: 'ui' }, updatedBy: 'admin1' })).toBe('화면 설정 · admin1');
    expect(sourceLine({ source: { a: 'default' } })).toBe('기본값');
    expect(monitorText({ mode: 'continuous', running: true, targets: 31 })).toBe('연속 측정 중 · 대상 31개');
    expect(monitorText({ mode: 'mock' })).toMatch(/합성/);
    expect(monitorText({ mode: 'off' })).toMatch(/꺼져/);
    for (const t of [settingsLine(S), sourceLine(S), monitorText({ mode: 'off' })]) expect(t).not.toMatch(/`/);
  });
});

describe('폼', () => {
  it('서버 값 ↔ 폼(초)', () => {
    expect(formOf(S)).toEqual({ probeSec: '1', summarySec: '60', timeoutSec: '2.5' });
    expect(payloadOf(formOf(S))).toEqual({ body: { probeIntervalMs: 1000, summaryIntervalMs: 60000, timeoutMs: 2500 }, issues: [] });
  });
  it('숫자 아님 · 범위 밖 · 요약 < 측정은 보내지 않는다', () => {
    const bad = payloadOf({ probeSec: 'abc', summarySec: '5', timeoutSec: '0.1' });
    expect(bad.body).toBeNull();
    expect(bad.issues.map((x) => x.field)).toEqual(['probeIntervalMs', 'summaryIntervalMs', 'timeoutMs']);
    expect(bad.issues[0].reason).not.toMatch(/`/);
    const order = payloadOf({ probeSec: '30', summarySec: '20', timeoutSec: '1' });
    expect(order.body).toBeNull();
    expect(order.issues).toEqual([{ field: 'summaryIntervalMs', reason: '요약(저장) 주기는 측정 간격 이상이어야 합니다' }]);
    expect(payloadOf({ probeSec: '1.5', summarySec: '10', timeoutSec: '0.2' }).body).toEqual({ probeIntervalMs: 1500, summaryIntervalMs: 10000, timeoutMs: 200 });
  });
  it('부하 미리보기 — 서버와 같은 식', () => {
    expect(pingLoadOf({ probeIntervalMs: 1000, summaryIntervalMs: 60000 }, 30)).toEqual({ targets: 30, probesPerSec: 30, probesPerSummary: 60, rowsPerDay: 43200 });
    expect(loadText(pingLoadOf({ probeIntervalMs: 2000, summaryIntervalMs: 60000 }, 30))).toBe('전체 대상 30개(엣지 노드 · vCenter 포트 포함) · 초당 약 15회 측정 · 한 줄에 30회 · 하루 43,200줄 저장');
    expect(PING_SETTING_RANGES.probeIntervalMs.min).toBe(1000);
  });
});

describe('화면 연결', () => {
  it('Ping 모니터링에 측정 설정 카드 · 저장 PUT · 마운트 1회', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.join(here, 'PingMonitor.jsx'), 'utf8');
    expect(src).toMatch(/<PingSettingsCard isAdmin=\{isAdmin\} \/>/);
    expect(src).toMatch(/putJson\('\/ping\/settings', body\)/);
    expect(src).toMatch(/fetchJson\('\/ping\/settings'\)/);
    expect(src).not.toMatch(/usePolling\('\/ping\/settings'/);
  });
});
