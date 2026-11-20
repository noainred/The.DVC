import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PLACEMENT_LABEL, PLACEMENT_HINT, notAppliedText, jobStatusLabel, vmStatusLabel, doneCountLabel, liveSubmitNote, LOCKED_PLACEMENT, LOCKED_PLACEMENT_NOTE, lockedPlacementText, jobProgressPct } from './provisionText.js';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('74회차 F5 · F6 — 배치 항목 적용 여부를 화면이 밝힌다', () => {
  it('적용 안 됨 목록이 비면 null · 있으면 항목 이름과 값을 싣는다', () => {
    expect(notAppliedText([], {})).toBeNull();
    expect(notAppliedText(undefined, {})).toBeNull();
    const t = notAppliedText(['folder', 'resourcePool', 'storageProfile'], { folder: 'Prod', resourcePool: 'Batch', storageProfile: 'Gold' });
    expect(t).toContain('적용 안 됨');
    expect(t).toContain('폴더 ‘Prod’');
    expect(t).toContain('리소스 풀 ‘Batch’');
    expect(t).toContain('스토리지 프로파일 ‘Gold’');
    expect(t).not.toContain('`');
  });
  it('안내 문구는 폴더 · 리소스 풀 · 프로파일이 적용되지 않는다고 말한다(예전 문구는 정확한 이름을 넣으라고 했다)', () => {
    expect(PLACEMENT_HINT).toContain('호스트 · 데이터스토어만 적용');
    expect(PLACEMENT_HINT).toContain('적용되지 않습니다');
    expect(PLACEMENT_HINT).not.toContain('`');
  });
  it('서버 placementNotApplied 의 키 이름은 화면 이름표에 모두 있다', () => {
    const src = readFileSync(path.join(here, '../../../server/src/provision/placement.js'), 'utf8');
    const body = src.slice(src.indexOf('export function placementNotApplied'));
    const keys = [...body.slice(0, body.indexOf('\n}')).matchAll(/'(cluster|folder|resourcePool|storageProfile|host|datastore)'/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(PLACEMENT_LABEL[k]).toBeTruthy();
  });
});

// 결정(56~75 남긴 것) 74 ② — 기대값 갱신: 예전(74회차 F8) LIVE 의 done 은 '제출됨'(서버가 작업 결과를 기다리지 않았다)이었다.
//   이제 서버가 vCenter 작업 결과를 기다리므로 done = 복제 작업 성공('완료'), 제출 뒤 대기 중은 submitted, 시간 초과 · 조회 실패는 unknown('결과 모름').
describe('결정 74 ② — LIVE 도 vCenter 작업 결과를 추적한다', () => {
  it('LIVE 의 done 은 완료 · running 은 제출 중 · submitted 는 vCenter 작업 중 · unknown 은 결과 모름', () => {
    expect(vmStatusLabel('done', true)).toBe('완료');
    expect(vmStatusLabel('running', true)).toBe('제출 중');
    expect(vmStatusLabel('submitted', true)).toBe('vCenter 작업 중');
    expect(vmStatusLabel('unknown', true)).toBe('결과 모름');
    expect(vmStatusLabel('done', false)).toBe('완료');
    expect(vmStatusLabel('error', true)).toBe('실패');
    expect(jobStatusLabel('completed', true)).toBe('완료');
    expect(jobStatusLabel('completed', false)).toBe('완료');
    expect(jobStatusLabel('completed_with_errors', true)).toBe('일부 실패');
    expect(jobStatusLabel('completed_with_unknown', true)).toBe('일부 결과 모름');
    expect(doneCountLabel(true)).toBe('완료');
    expect(doneCountLabel(false)).toBe('완료');
    expect(liveSubmitNote(true)).toContain('vCenter 최근 작업');
    expect(liveSubmitNote(true)).toContain('첫 부팅');
    expect(liveSubmitNote(true)).not.toContain('`');
    expect(liveSubmitNote(false)).toBeNull();
  });
  it('진행률은 완료 · 실패 · 결과 모름을 끝난 것으로 센다', () => {
    expect(jobProgressPct({ total: 4, done: 1, failed: 1, unknown: 1 })).toBe(75);
    expect(jobProgressPct({ total: 0 })).toBe(0);
    expect(jobProgressPct(null)).toBe(0);
  });
  it('서버의 VM 상태 이름(taskTracker.js · jobs.js)은 화면 글자가 모두 있다', () => {
    const tracker = readFileSync(path.join(here, '../../../server/src/provision/taskTracker.js'), 'utf8');
    const jobs = readFileSync(path.join(here, '../../../server/src/provision/jobs.js'), 'utf8');
    for (const st of ['running', 'submitted', 'unknown', 'done', 'error']) {
      expect(tracker).toContain(`v.status = '${st}'`);
      expect(vmStatusLabel(st, true)).not.toBe(st);
    }
    expect(jobs).toContain("'completed_with_unknown'");
    expect(jobStatusLabel('completed_with_unknown')).not.toBe('completed_with_unknown');
  });
  it('모르는 상태는 원문 · 비면 —', () => {
    expect(vmStatusLabel('weird', true)).toBe('weird');
    expect(jobStatusLabel(undefined, false)).toBe('—');
  });
});

describe('결정 74 ① — 폴더 · 리소스 풀 · 스토리지 프로파일 칸은 잠근다', () => {
  it('잠근 칸 목록은 서버 placementNotApplied 의 항상-미적용 키와 같다', () => {
    const src = readFileSync(path.join(here, '../../../server/src/provision/placement.js'), 'utf8');
    expect(src).toMatch(/for \(const k of \['folder', 'resourcePool', 'storageProfile'\]\)/);
    expect([...LOCKED_PLACEMENT]).toEqual(['folder', 'resourcePool', 'storageProfile']);
  });
  it('불러온 값이 있으면 보이되 생성에 쓰지 않는다고 밝히고, 없으면 null', () => {
    expect(lockedPlacementText({})).toBeNull();
    expect(lockedPlacementText({ folder: '  ', host: 'esx1' })).toBeNull();
    const t = lockedPlacementText({ folder: 'Prod', storageProfile: 'Gold' });
    expect(t).toContain('폴더 ‘Prod’');
    expect(t).toContain('스토리지 프로파일 ‘Gold’');
    expect(t).toContain('생성에는 쓰지 않습니다');
    expect(t).not.toContain('`');
    expect(LOCKED_PLACEMENT_NOTE).toContain('아직 적용되지 않음');
  });
  it('화면은 세 칸을 입력 불가로 그린다(입력 핸들러 없음)', () => {
    const src = readFileSync(path.join(here, 'VmProvision.jsx'), 'utf8');
    for (const k of ['folder', 'resourcePool', 'storageProfile']) {
      expect(src).not.toContain(`setP('${k}')`);
      expect(src).toMatch(new RegExp(`value=\\{form\\.placement\\.${k}\\} disabled readOnly`));
    }
  });
});
