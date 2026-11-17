import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PLACEMENT_LABEL, PLACEMENT_HINT, notAppliedText, jobStatusLabel, vmStatusLabel, doneCountLabel, liveSubmitNote } from './provisionText.js';

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

describe('74회차 F8 — LIVE 의 done 은 제출됨(완료가 아니다)', () => {
  it('LIVE 는 제출됨 · 제출 완료, MOCK 은 예전 글자', () => {
    expect(vmStatusLabel('done', true)).toBe('제출됨');
    expect(vmStatusLabel('running', true)).toBe('제출 중');
    expect(vmStatusLabel('done', false)).toBe('완료');
    expect(vmStatusLabel('error', true)).toBe('실패');
    expect(jobStatusLabel('completed', true)).toBe('제출 완료');
    expect(jobStatusLabel('completed', false)).toBe('완료');
    expect(jobStatusLabel('completed_with_errors', true)).toBe('일부 실패');
    expect(doneCountLabel(true)).toBe('제출');
    expect(doneCountLabel(false)).toBe('완료');
    expect(liveSubmitNote(true)).toContain('vCenter 최근 작업');
    expect(liveSubmitNote(false)).toBeNull();
  });
  it('모르는 상태는 원문 · 비면 —', () => {
    expect(vmStatusLabel('weird', true)).toBe('weird');
    expect(jobStatusLabel(undefined, false)).toBe('—');
  });
});
