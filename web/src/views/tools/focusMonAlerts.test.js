// v3.16.0 ⑯ 서버 집중 모니터링 알림 · OOM · 자동 조절 — 순수 함수 · 화면 소스(시안 Alerts · 사용자 "기본값대로 모두 구현해줘").
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { scopeText, nowText, thresholdIssue, previewText, kerrText, READ_TEXT } from './focusMonAlertsText.js';
import { TABS } from './focusMonText.js';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

describe('알림 글', () => {
  it('대상 · 지금', () => {
    expect(scopeText({ scope: { kind: 'record' } })).toBe('계속 수집 전체');
    expect(scopeText({ scope: { kind: 'group', group: 'DB' } })).toBe('그룹 DB');
    expect(scopeText({ scope: { kind: 'server', target: 'fm-1' } }, () => 'kr-db-01')).toBe('kr-db-01');
    expect(nowText({ enabled: false }).text).toBe('꺼짐');
    expect(nowText({ enabled: true, firing: 2, hold: 1 }).text).toBe('발생 2대 · 보류 1');
    expect(nowText({ enabled: true, firing: 0, hold: 3 }).text).toBe('판정 보류 3대');
    expect(nowText({ enabled: true, firing: 0, hold: 0, covered: 4 }).text).toBe('정상 · 4대');
    expect(nowText({ enabled: true, covered: 0 }, { judged: false }).text).toBe('판정 전(1분마다)'); // 기동 직후 — '덮는 서버 없음' 이라고 하지 않는다(Chromium 확인)
  });
  it('문턱 · 미리 보기 · 커널 오류', () => {
    expect(thresholdIssue('', { range: [1, 100] })).toMatch(/숫자/);
    expect(thresholdIssue(101, { range: [1, 100] })).toMatch(/1 ~ 100/);
    expect(thresholdIssue(90, { range: [1, 100] })).toBe('');
    expect(previewText({ coveredMin: 0 })).toMatch(/미리 볼 수 없습니다/);
    expect(previewText({ coveredMin: 1440, count: 2 })).toMatch(/2번 발생했을 것입니다\(추정/);
    expect(previewText({ unsupported: true, reason: 'x' })).toBe('x');
    expect(kerrText(null)).toBe('—'); expect(kerrText(0)).toBe('없음'); expect(kerrText(3)).toBe('3줄');
  });
});

describe('화면 · 서버 대조', () => {
  it('탭 · 읽기 상태 이름은 서버 라우트와 같다', () => {
    expect(TABS.map((t) => t.key)).toContain('alerts');
    const route = read('../../../../server/src/routes/api/focusMon.js');
    for (const k of Object.keys(READ_TEXT)) expect(route).toContain(`'${k}'`);
  });
  it('알림 탭은 30초마다 · 자동 조절은 설정 저장 경로(감사) · 시간 띠를 보이지 않는다', () => {
    const tab = read('./FocusMonAlerts.jsx'); const tool = read('./FocusMonTool.jsx');
    expect(tab).toMatch(/usePoll\('\/tools\/focus-mon\/alerts', null, 30_000, true\)/);
    expect(tab).toMatch(/putJson\('\/tools\/focus-mon\/settings', \{ autoTune: v === 'on' \? 1 : 0 \}\)/);
    expect(tool).toMatch(/route\.tab !== 'audit' && route\.tab !== 'alerts' && ids\.length\) \? <TimeBar/);
  });
});
