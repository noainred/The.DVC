/**
 * v2.733(점검 3회차 그룹 a) — C1-01 웹: 이 포탈이 지금 이벤트를 수집하지 않는 vCenter(엣지 위임·비활성·점검중)를
 * 각 화면이 '0건·정상·변경 없음' 대신 짧은 문구로 말하는지 고정한다. 서버 판정은 server/src/logs/coverage.js(서버 테스트 audit2733a).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NOT_COLLECTED_WHY_TEXT, notCollectedWhyText, notCollectedNote, notCollectedOf, notCollectedOneText, notCollectedReasonText,
} from './eventCoverageText.js';
import { coverageNote as vmChangesCoverageNote, vmHistoryNotCollectedText } from './vmchanges/vmChangesText.js';
import { coverageNote as availCoverageNote } from './bizreport/availText.js';
import { undeterminedNote } from './unprotectedPatternText.js';
import { notCollectedLoginNote, kpiValueText } from './loginFailsText.js';
import { logIssueSummaryText, logIssueExcludedNote } from './NetTrafficAnalysis.jsx';
import { changeCoverageNote, changeEmptyText } from './ToolsReports.jsx';
import { vcLogRunText, vcLogNotCollectedText } from './VcenterLogs.jsx';

const here = path.dirname(fileURLToPath(import.meta.url));
const NC = [{ vcenterId: 'vc-s', why: 'site', name: 'Poland-site' }, { vcenterId: 'vc-x', why: 'disabled' }, { vcenterId: 'vc-m', why: 'maintenance' }];

describe('eventCoverageText — 사유 키는 서버(collectTarget DIRECT_SKIP_REASONS)와 1:1', () => {
  it('서버 소스의 사유 집합과 같다', () => {
    const src = fs.readFileSync(path.resolve(here, '../../../server/src/vcenter/collectTarget.js'), 'utf8');
    const m = /DIRECT_SKIP_REASONS\s*=\s*Object\.freeze\(\[([^\]]*)\]\)/.exec(src);
    expect(m).toBeTruthy();
    const keys = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
    expect(Object.keys(NOT_COLLECTED_WHY_TEXT).sort()).toEqual(keys);
  });
  it('한 줄 안내 — 개수·사유별 개수·이름(없으면 id) · 없으면 빈 문자열 · 모르는 사유를 지어내지 않는다', () => {
    const t = notCollectedNote(NC);
    expect(t).toContain('vCenter 3곳');
    expect(t).toContain('엣지 위임 1 · 비활성 1 · 점검중 1');
    expect(t).toContain('Poland-site');
    expect(t).toContain('vc-x');
    expect(notCollectedNote([])).toBe('');
    expect(notCollectedNote(null)).toBe('');
    expect(notCollectedWhyText('weird')).toBe('수집 대상 아님');
    expect(notCollectedReasonText([{ vcenterId: 'a', why: 'site' }, { vcenterId: 'b', why: 'site' }])).toBe('엣지 위임 2');
    expect(notCollectedOf(NC, 'vc-s')?.why).toBe('site');
    expect(notCollectedOf(NC, 'vc-d')).toBeNull();
    expect(notCollectedOneText(notCollectedOf(NC, 'vc-s'), { what: '변경' })).toContain('‘변경 없음’ 이 아닙니다');
  });
  it('문구에 백틱·별표가 없다(일반 글자로 그려지는 자리가 있다)', () => {
    for (const s of [notCollectedNote(NC), notCollectedOneText(NC[0]), vmChangesCoverageNote({ vcenters: [], notCollected: NC }),
      notCollectedLoginNote(NC), logIssueExcludedNote({ notCollected: NC, excluded: { errors: 1, warnings: 2 } }), vcLogNotCollectedText({ notCollected: NC })]) {
      expect(s).not.toMatch(/[`*]/);
    }
  });
});

describe('화면별 — 0건·정상 대신 말한다', () => {
  it('로그 이슈 분석: null 수치는 —, 전체 보기는 뺀 vCenter·옛 오류/경고 수를 말한다', () => {
    expect(logIssueSummaryText({ errors: null, warnings: null, peakPerHour: null, avgPerHour: null })).toBe('오류 — · 경고 — · 시간당 최대 —(평균 —)');
    expect(logIssueSummaryText({ errors: 4, warnings: 0, peakPerHour: 4, avgPerHour: 4 })).toBe('오류 4 · 경고 0 · 시간당 최대 4(평균 4)');
    const n = logIssueExcludedNote({ notCollected: NC, excluded: { errors: 7, warnings: 7 } });
    expect(n).toContain('분석에서 뺐습니다');
    expect(n).toContain('옛 오류 7건 · 경고 7건');
    expect(logIssueExcludedNote({ notCollected: [] })).toBe('');
  });
  it('구성 변경 이력: 고른 vCenter 가 NC 면 그 한 문장·빈 표 문구가 바뀐다 · 직접 수집은 예전 문구', () => {
    const data = { notCollected: [NC[0]], rows: [] };
    expect(changeCoverageNote(data, 'vc-s')).toContain('엣지 위임');
    expect(changeEmptyText(data, 'vc-s')).toContain('알 수 없습니다');
    expect(changeEmptyText({ notCollected: [] }, 'vc-d')).toBe('조건에 맞는 변경 이벤트가 없습니다.');
    expect(changeCoverageNote({ notCollected: NC }, '')).toContain('vCenter 3곳');
    expect(changeCoverageNote({ notCollected: [NC[0]] }, 'vc-d')).toBe('', '다른 vCenter 를 골랐으면 말하지 않는다');
  });
  it('VM 이동 이력: NC 는 받은 적 없음·이틀 지남보다 먼저, 같은 vCenter 를 두 번 세지 않는다', () => {
    const now = Date.UTC(2026, 9, 10);
    const data = { vcenters: [{ vcenterId: 'vc-s', name: 'Poland-site', lastTs: now - 5 * 86_400_000, notCollected: 'site' }, { vcenterId: 'vc-m', name: 'Maint', lastTs: null, notCollected: 'maintenance' }, { vcenterId: 'vc-d', name: 'D', lastTs: now - 1000 }], notCollected: [NC[0], NC[2]] };
    const t = vmChangesCoverageNote(data, now);
    expect(t).toContain('vCenter 2곳');
    expect(t).not.toContain('이벤트를 받은 적 없는 vCenter');
    expect(t).not.toContain('이틀 넘게 지난');
    // 서버 목록이 없으면(구버전 응답) 항목의 notCollected 로
    expect(vmChangesCoverageNote({ vcenters: data.vcenters }, now)).toContain('vCenter 2곳');
  });
  it('VM 상세 이력: notCollected 사유가 있으면 변경 없음 대신', () => {
    expect(vmHistoryNotCollectedText({ notCollected: 'site', items: [] })).toContain('‘이동·변경 없음’ 이 아닙니다');
    expect(vmHistoryNotCollectedText({ notCollected: 'site', items: [{}] })).toContain('수집을 멈추기 전 이력');
    expect(vmHistoryNotCollectedText({ notCollected: null, items: [] })).toBeNull();
  });
  it('VM 가용성: NC 를 수집 실패(재시작 직후·계속 실패)로 말하지 않는다', () => {
    const t = availCoverageNote({ coverage: { notCollectedVms: 2, staleTail: 1, tailVcenters: 1, tailNotCollected: 1, tailFromLastEvent: 0 }, notCollected: [NC[0]] });
    expect(t).toContain('이 포탈이 지금 이벤트를 수집하지 않는 vCenter 1곳');
    expect(t).toContain('VM 2대는 마지막으로 받은 이벤트 시각까지만');
    expect(t).not.toContain('포탈 재시작 직후');
  });
  it('미보호 VM: 지금 수집하지 않는 vCenter 를 사유와 함께', () => {
    const t = undeterminedNote({ undeterminedCount: 2, undeterminedByReason: { 'not-collected': 2 }, notCollectedVcenters: [{ vcenterId: 'vc-s', why: 'site', vms: 1 }, { vcenterId: 'vc-m', why: null, vms: 1 }] });
    expect(t).toContain('vc-s(엣지 위임)');
    expect(t).toContain('vc-m(사유 미상)');
  });
  it('로그인 실패: 감시 밖 vCenter·옛 실패 수 · KPI null 은 —', () => {
    const t = notCollectedLoginNote([{ vcenterId: 'vc-s', why: 'site', oldFails: 7 }, { vcenterId: 'vc-x', why: 'disabled', oldFails: 0 }]);
    expect(t).toContain('감시(알림)가 보지 못합니다');
    expect(t).toContain('옛 실패 7건');
    expect(notCollectedLoginNote([{ vcenterId: 'vc-s', why: 'site', oldFails: null }])).not.toContain('옛 실패');
    expect(kpiValueText(null)).toBe('—');
    expect(kpiValueText(0)).toBe('0');
  });
  it('vCenter 로그 보관 상태줄: 범위 계정의 collected null 은 —(0건 아님) · 건너뛴 vCenter·범위 밖 개수', () => {
    const fmt = () => 'T';
    expect(vcLogRunText({ at: 1, collected: null }, fmt)).toBe('최근 수집 T · —');
    expect(vcLogRunText({ at: 1, collected: 12 }, fmt)).toBe('최근 수집 T · 12건');
    expect(vcLogRunText(null, fmt)).toBe('아직 수집 안 함');
    const t = vcLogNotCollectedText({ notCollected: [NC[0]], notCollectedOmitted: 2 });
    expect(t).toContain('로그인하지 않아');
    expect(t).toContain('범위 밖 2곳');
    expect(vcLogNotCollectedText({})).toBe('');
  });
});
