// v2.935(C-②) SAN 플로우 모니터 문구 — 못 읽음 ≠ 없음 · 값이 없으면 ‘—’ · 사람이 만든 플로우는 보기만 · 차이 % 는 둘 다 있을 때만
import { describe, it, expect } from 'vitest';
import { fvBadge, checkBadge, createBlock, deviceRows, diffPct, diffText, flowRows, flowKpis, jobTitle, jobTone, traceLines, hbaOptions, targetOptions, shortWwn, existingPairs, cycleText, deadlineText, CONFIRM } from './sanFlowText.js';

const T0 = new Date(2026, 10, 7, 12, 30).getTime();
const dev = (over = {}) => ({ id: 'sw1', name: 'us-sw-a1', fv: { state: 'yes', expires: null }, limit: 128, check: { at: T0, ok: true, total: 9, portal: 3, others: ['ops_backup'] }, portalFlows: 3, collectedAt: T0, agent: 'us-edge-01', ...over });
const flow = (over = {}) => ({ deviceId: 'sw1', name: 'dvc_esx1_vmhba1_01', state: 'active', srcdev: '10:00:00:90:fa:8e:12:34', dstdev: '50:06:0e:80:07:c3:f8:00', ingrport: '1/12',
  hostName: 'esx-us-003.corp.local', hba: 'vmhba1', targetName: 'PMAX-8000', counters: { rxBytes: 2e12, txBytes: 1e12 }, rxBps: 100e6, txBps: 50e6, esxiBps: 148e6, lastAt: T0, ...over });

describe('라이선스 · 권한 점검 배지', () => {
  it('없음과 못 읽음을 가른다', () => {
    expect(fvBadge({ state: 'yes', expires: '2027-03-31' }).label).toBe('있음 · 2027-03-31');
    expect(fvBadge({ state: 'no' }).label).toBe('없음');
    expect(fvBadge({ state: 'unknown', reason: 'rbash' }).label).toBe('못 읽음');
    expect(fvBadge(null).title).toMatch(/단정하지 않습니다/);
  });
  it('점검 결과 종류', () => {
    expect(checkBadge(null).label).toBe('점검 안 함');
    expect(checkBadge({ ok: true, at: T0 }).label).toBe('통과 · 12:30');
    expect(checkBadge({ ok: false, kind: 'no-command', text: 'x' })).toMatchObject({ label: '막힘 · 명령 없음', tone: 'red' });
    expect(checkBadge({ ok: false, kind: 'license' }).label).toBe('라이선스 없음');
  });
  it('만들기 막는 이유', () => {
    expect(createBlock(dev())).toBe(null);
    expect(createBlock(dev({ fv: { state: 'no' } }))).toBe('라이선스 없음');
    expect(createBlock(dev({ check: null }))).toBe('먼저 계정 권한 점검');
    expect(createBlock(dev({ check: { ok: false } }))).toBe('점검 통과 필요');
    expect(createBlock(dev({ collectedAt: null }))).toBe('수집 스냅샷 없음');
  });
  it('스위치 행 — 개수 / 상한 · 실행 위치', () => {
    const [r] = deviceRows({ devices: [dev()] });
    expect(r.countText).toBe('9 / 128'); expect(r.where).toBe('엣지 us-edge-01');
    expect(deviceRows({ devices: [dev({ flowCount: 11 })] })[0].countText).toBe('11 / 128');   // 점검 뒤 만든 것까지
    expect(deviceRows({ devices: [dev({ check: null, portalFlows: 0, agent: '' })] })[0]).toMatchObject({ countText: '0 / 128', where: '이 포탈' });
  });
});

describe('플로우 결과', () => {
  it('ESXi 대비 차이 — 둘 다 있을 때만', () => {
    expect(diffPct(flow())).toBeCloseTo(1.35, 1);
    expect(diffPct(flow({ esxiBps: null }))).toBe(null);
    expect(diffPct(flow({ rxBps: null, txBps: null }))).toBe(null);
    expect(diffPct(flow({ esxiBps: 0 }))).toBe(null);
    expect(diffText(null)).toBe('—'); expect(diffText(-2.04)).toBe('-2.0%'); expect(diffText(7.8)).toBe('+7.8%');
  });
  it('카운터가 없으면 ‘—’(0 이 아니다) · 사람이 만든 플로우는 보기만', () => {
    const rows = flowRows({ devices: [dev()], flows: [flow(), flow({ name: 'dvc_x_y_02', counters: undefined, rxBps: null, txBps: null, esxiBps: null, state: 'failed', lastError: '라이선스 없음' })] });
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ portal: true, host: 'esx-us-003 · vmhba1', target: 'PMAX-8000', bytes: '2.7 TB', diff: '+1.4%', diffWarn: false });
    expect(rows[0].rate).toBe('800.0 Mbps / 400.0 Mbps');
    expect(rows[1]).toMatchObject({ rate: '—', bytes: '—', diff: '—', lastError: '라이선스 없음' });
    expect(rows[1].state.label).toBe('만들지 못함');
    expect(rows[2]).toMatchObject({ portal: false, name: 'ops_backup' });
    expect(rows[2].state.label).toBe('사람이 만듦 · 보기만');
  });
  it('5% 넘으면 표시', () => {
    expect(flowRows({ devices: [dev()], flows: [flow({ esxiBps: 100e6 })] })[0].diffWarn).toBe(true);
  });
  it('짧은 WWN', () => { expect(shortWwn('10:00:00:90:fa:8e:12:34')).toBe('10:00…12:34'); expect(shortWwn('')).toBe('—'); });
});

describe('KPI', () => {
  it('라이선스 · 점검 · 플로우 · 차이 중앙값 · 마지막 수집', () => {
    const k = flowKpis({ devices: [dev(), dev({ id: 'sw2', fv: { state: 'no' }, check: null }), dev({ id: 'sw3', fv: { state: 'unknown' }, check: { ok: false, kind: 'no-command' } })],
      flows: [flow(), flow({ name: 'b', esxiBps: 100e6 }), flow({ name: 'c', state: 'deleted' })], showEveryMs: 900_000 });
    expect(k.map((x) => x.value)).toEqual(['1 / 3', '1 / 2', '2', '25.7%', '12:30']);
    expect(k[0].meta).toBe('없음 1 · 못 읽음 1');
    expect(k[4].meta).toBe('15분 주기 · flow --show');
  });
  it('값이 없으면 ‘—’', () => {
    const k = flowKpis({ devices: [], flows: [] });
    expect(k[1].value).toBe('—'); expect(k[3].value).toBe('—'); expect(k[4].value).toBe('—');
  });
});

describe('작업 기록 · 만들기 폼', () => {
  it('상태 문구', () => {
    expect(jobTitle({ action: 'create', deviceName: 'sw', status: 'queued', user: 'kim' })).toBe('만들기 · sw · 엣지 대기(설정 pull 전) · kim');
    expect(jobTitle({ action: 'check', deviceName: 'sw', status: 'done', result: { ok: false } })).toBe('계정 권한 점검 · sw · 실패');
    expect(jobTone({ status: 'done', result: { ok: true } })).toBe('green');
    expect(traceLines({ trace: [{ t: 12_400, msg: 'a' }] })[0]).toMatchObject({ t: '+12초', msg: 'a', level: 'info' });
  });
  it('고른 스위치에 로그인한 HBA 만 · 타깃 펼치기', () => {
    const cand = { hbas: [{ hba: 'vmhba1', deviceId: 'sw1', targets: [{ name: 'PMAX', wwns: ['a', 'b'] }] }, { hba: 'vmhba2', deviceId: 'sw2', targets: [] }] };
    expect(hbaOptions(cand, 'sw1').map((x) => x.hba)).toEqual(['vmhba1']);
    expect(targetOptions(hbaOptions(cand, 'sw1')[0]).map((t) => t.wwn)).toEqual(['a', 'b']);
    expect(hbaOptions(null, 'sw1')).toEqual([]);
  });
});

describe('같은 정의 중복 방지', () => {
  it('이 스위치 · 이 초기자의 활성 플로우 타깃만', () => {
    const fl = [{ deviceId: 'sw1', srcdev: 'i1', dstdev: 't1', state: 'active' }, { deviceId: 'sw1', srcdev: 'i1', dstdev: 't2', state: 'failed' },
      { deviceId: 'sw2', srcdev: 'i1', dstdev: 't3', state: 'active' }, { deviceId: 'sw1', srcdev: 'i9', dstdev: 't4', state: 'active' }];
    expect(existingPairs(fl, 'sw1', 'i1')).toEqual(['t1']);
    expect(existingPairs(fl, 'sw1', '')).toEqual([]);
  });
});

describe('반증 1인 확정분(v2.935)', () => {
  it('M-5 한쪽만 읽힌 속도 · 바이트는 비교 · 합하지 않는다', () => {
    expect(diffPct(flow({ txBps: null }))).toBe(null);
    const [r] = flowRows({ devices: [dev()], flows: [flow({ counters: { rxBytes: 5, txBytes: null } })] });
    expect(r.bytes).toBe('—');
  });
  it('새 상태 · 기록 없는 dvc_ · 기록 정리', () => {
    const rows = flowRows({ devices: [dev({ check: { at: T0, ok: true, others: [], orphans: ['dvc_orphan9abcd_01'] } })],
      flows: [flow({ name: 'a', state: 'unknown' }), flow({ name: 'b', state: 'conflict' }), flow({ name: 'c', deviceKnown: false }), flow({ name: 'd', state: 'failed' })] });
    expect(rows.map((r) => r.state.label)).toEqual(['결과 모름', '이름 충돌', '활성', '만들지 못함', '포탈 기록 없음']);
    expect(rows.map((r) => [r.canDelete, r.canForget])).toEqual([[true, false], [true, false], [false, true], [false, false], [true, false]]);
  });
  it('엣지 버전 낮음 · 주기 · 시한 문구', () => {
    expect(createBlock(dev({ edgeIssue: '엣지 "e" 의 버전(2.932.0)은 …' }))).toBe('엣지 버전 낮음');
    expect(cycleText({ at: T0, devices: 5, started: 3, skipped: { '인증 실패 정지': 1, '꺼짐': 1 } })).toBe('마지막 카운터 주기 12:30 — 스위치 5대 중 3대 시작 · 건너뜀 인증 실패 정지 1 · 꺼짐 1');
    expect(cycleText(null)).toBe('');
    expect(deadlineText(1_200_000)).toContain('20분 안에');
    expect(deadlineText(undefined)).toContain('정해진 시간');
    expect(jobTitle({ action: 'create', deviceName: 'sw', status: 'done', timedOut: true, result: { ok: false } })).toBe('만들기 · sw · 결과 모름');
  });
});

describe('v2.939 비활성화 · 다시 켜기(시안 C-②)', () => {
  it('활성은 비활성화 · 비활성은 다시 켜기 · 등록부에 없으면 둘 다 없음', () => {
    const rows = flowRows({ devices: [dev()], flows: [flow({ name: 'a' }), flow({ name: 'b', state: 'inactive', rxBps: null, txBps: null }), flow({ name: 'c', deviceKnown: false })] });
    expect(rows.slice(0, 3).map((r) => [r.state.label, r.canDeactivate, r.canActivate])).toEqual([['활성', true, false], ['비활성', false, true], ['활성', false, false]]);
    expect(rows[3]).toMatchObject({ canDeactivate: false, canActivate: false });   // 사람이 만든 플로우
    expect(rows[1].rate).toBe('— / —');
    const k = flowKpis({ devices: [dev()], flows: [flow({ name: 'a' }), flow({ name: 'b', state: 'inactive' }), flow({ name: 'c', state: 'failed' })] });
    expect(k[2].meta).toBe('활성 1 · 비활성 1 · 그 밖 1');
  });
  it('확인 줄 문구 · 라우트', () => {
    expect(CONFIRM.deactivate.path).toBe('/tools/san-flow/deactivate');
    expect(CONFIRM.activate.text('dvc_x_01')).toContain('다시 켭니다');
    expect(CONFIRM.delete.danger).toBe(true); expect(CONFIRM.deactivate.danger).toBe(false);
  });
});
