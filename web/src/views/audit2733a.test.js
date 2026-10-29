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

/*
 * v2.772(bughunt4 Z4 — 그룹 G3): '수집은 하지만 뒤처진 vCenter'(따라잡는 중 포함) 문구. 서버 판정은 server/src/logs/coverage.js
 * (서버 테스트 evlog2772c — 웹 lagDurText 와 서버 eventLagText 를 같은 입력으로 대조한다).
 */
describe('v2.772 Z4 — 수집이 뒤처진 vCenter 를 0건·정상·미보호에 섞지 않는다', async () => {
  const { lagDurText, laggingNote } = await import('./eventCoverageText.js');
  const { laggingLoginNote } = await import('./loginFailsText.js');
  const { changeScanNote } = await import('./toolsReportText.js');
  const { vmHistoryLagText, HISTORY_STALE_MS } = await import('./vmchanges/vmChangesText.js');
  const { coverageNote: availNote, tailCutText } = await import('./bizreport/availText.js');
  const H = 3_600_000;
  const LAG = [{ vcenterId: 'oc2s', okAt: 1, lagMs: 94 * H, name: 'OC2Sandbox' }, { vcenterId: 'oc2', lagMs: 232 * H }];

  it('lagDurText — 분·시간·일 · 못 읽은 값은 빈 문자열(0분이 아니다)', () => {
    expect(lagDurText(94 * H)).toBe('3일 22시간');
    expect(lagDurText(5 * H)).toBe('5시간');
    expect(lagDurText(48 * H)).toBe('2일');
    expect(lagDurText(40 * 60_000)).toBe('40분');
    expect(lagDurText(null)).toBe('');
    expect(lagDurText('')).toBe('');
  });

  it('laggingNote — 뒤처진 vCenter 와 지연 · 이 기간 결과는 일부 · 없거나 판정 못 함(null)이면 빈 문자열', () => {
    const n = laggingNote(LAG, { what: '오류' });
    expect(n).toContain('이벤트 수집이 뒤처진 vCenter 2곳(따라잡는 중 포함)');
    expect(n).toContain('OC2Sandbox 3일 22시간 뒤처짐');
    expect(n).toContain('oc2 9일 16시간 뒤처짐');
    expect(n).toContain('이 기간 결과는 일부입니다');
    expect(laggingNote([])).toBe('');
    expect(laggingNote(null)).toBe('');
    expect(n).not.toMatch(/[`*]/);
  });

  it('로그인 실패 — 뒤처진 vCenter 는 감시가 아직 보지 못했다고 말한다', () => {
    const n = laggingLoginNote(LAG);
    expect(n).toContain('로그인 실패 기록은 아직 받지 못해');
    expect(n).toContain('브루트포스');
    expect(laggingLoginNote(undefined)).toBe('');
  });

  it('미보호 VM — collect-lag 사유와 지연 vCenter', () => {
    const n = undeterminedNote({ undeterminedCount: 1, undeterminedByReason: { 'collect-lag': 1 }, laggingVcenters: [{ vcenterId: 'oc2s', okAt: 1, lagMs: 94 * H, vms: 1 }] });
    expect(n).toContain('이벤트 수집이 뒤처진 vCenter(따라잡는 중 포함)');
    expect(n).toContain('수집이 뒤처진 vCenter: oc2s(3일 22시간 뒤처짐)');
    expect(n).not.toContain('collect-lag');
  });

  it('구성 변경 이력 — 상한에 닿으면 실제로 훑은 범위를 말하고 기간을 줄이라고 하지 않는다', () => {
    const n = changeScanNote({ truncated: true, scanned: 20000, scanMax: 20000, scannedFrom: 1000, scannedTo: 2000 }, (t) => `T${t}`);
    expect(n).toContain('최신 20,000행');
    expect(n).toContain('T1000 ~ T2000 만 봤습니다');
    expect(n).not.toContain('기간을 줄이세요');
    expect(changeScanNote({ truncated: false, scanned: 10 })).toBe(null);
    expect(changeScanNote({ truncated: true, scanned: 20000 })).not.toContain('~');   // 시각을 모르면 범위를 지어내지 않는다
    const src = fs.readFileSync(path.resolve(here, 'ToolsReports.jsx'), 'utf8');
    expect(src).not.toContain('기간을 줄이세요');
  });

  it('VM 상세 이력 — 서버 lagging 이 있으면 그것, 없으면 마지막 이벤트가 2일 넘게 지났을 때만', () => {
    const now = 100 * 24 * H;
    expect(vmHistoryLagText({ lagging: { okAt: 1, lagMs: 94 * H }, items: [] }, now)).toContain('3일 22시간 뒤처져');
    expect(vmHistoryLagText({ lastTs: now - HISTORY_STALE_MS - H, items: [] }, now)).toContain('2일 1시간 전');
    expect(vmHistoryLagText({ lastTs: now - H, items: [] }, now)).toBe(null);
    expect(vmHistoryLagText({ lastTs: null, items: [] }, now)).toBe(null);
    expect(vmHistoryLagText({ notCollected: 'site', lastTs: 1, items: [] }, now)).toBe(null);   // 다른 문장이 말한다
  });

  it('VM 가용성 — 꼬리를 자른 vCenter 를 \'멈춘\' 으로 단정하지 않는다(따라잡는 중 포함)', () => {
    const n = availNote({ coverage: { staleTail: 2, tailVcenters: 1 } });
    expect(n).toContain('이벤트 수집이 멈췄거나 뒤처진(따라잡는 중 포함) vCenter 1곳');
    expect(n).not.toContain('수집이 멈춘 vCenter');
    expect(tailCutText({ tailCut: true, windowTo: 5 }, () => 'T')).toBe('수집 멈춤·지연 — T 까지만 잼');
  });
});
