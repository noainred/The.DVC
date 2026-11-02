/**
 * v2.861 Bareos 복원(폴더에서 고르기 · 3단계 · 묶음 진행) — 화면 쪽 판정 · 글자(bareosRestoreText.js).
 *   서버 판정(bulkRestorePlan)과 같은 규칙을 화면이 먼저 말하는 것만(최종 판정은 서버) · 못 읽은 값은 '—'(0 아님).
 */
import { describe, it, expect } from 'vitest';
import * as T from './bareosRestoreText.js';

const J = (id, vmName, folder, extra = {}) => ({ id, vmName, folder, vcenterId: 'vc-a', directorId: 'D1', writable: true, restores: [], ...extra });

describe('v2.861 복원 고르기 · 마법사 판정', () => {
  it('트리 — 법인 › 폴더 › VM(이름순) · 찾기', () => {
    const jobs = [J('2', 'web-02', '/web'), J('1', 'web-01', '/web'), J('3', 'app-01', '/app'), J('4', 'db-01', '/', { vcenterId: 'vc-b', directorId: 'D2' })];
    const t = T.restoreTree(jobs);
    expect(t.map((x) => [x.vcenterId, x.n])).toEqual([['vc-a', 3], ['vc-b', 1]]);
    expect(t[0].folders.map((f) => [f.folder, f.vms.map((v) => v.vmName)])).toEqual([['/app', ['app-01']], ['/web', ['web-01', 'web-02']]]);
    expect(T.restoreTree(jobs, { q: 'WEB' })[0].n).toBe(2);
  });
  it('고를 수 없는 사유 — 조회 전용 · 진행 중 · 다른 법인(한 법인씩)', () => {
    expect(T.pickBlock(J('1', 'a', '/'))).toBe('');
    expect(T.pickBlock(J('1', 'a', '/', { writable: false }))).toMatch(/조회 전용/);
    expect(T.pickBlock(J('1', 'a', '/', { restores: [{ jobid: 9, state: 'running' }] }))).toMatch(/진행 중/);
    expect(T.pickBlock(J('1', 'a', '/', { restores: [{ jobid: 9, state: 'unknown' }] }))).toMatch(/진행 중/);   // 서버 restoreOpen 과 같다(끝난 상태가 아니면 진행 중)
    expect(T.pickBlock(J('1', 'a', '/', { restores: [{ jobid: 9, state: 'ok' }] }))).toBe('');
    expect(T.pickBlock(J('1', 'a', '/', { directorId: 'D2' }), { lockedDir: 'D1' })).toMatch(/한 법인씩/);
  });
  it('첫 값 · 방식 바꾸기 — 새 VM 은 네트워크 끊기 · 덮어쓰기는 그대로(사용자 결정 ⓓ) · 보낼 모양', () => {
    const it0 = T.defaultItem(J('1', 'web-01', '/web'));
    expect(it0).toMatchObject({ mode: 'newVm', name: 'web-01-restored', nic: 'disconnect', datastore: '' });
    const ov = T.withMode(it0, 'original');
    expect([ov.nic, ov.mode]).toEqual(['keep', 'original']);
    expect(T.withMode({ ...ov, nic: 'disconnect' }, 'original').nic).toBe('disconnect', '같은 방식이면 사람이 바꾼 값 유지');
    expect(T.itemBody({ ...it0, jobid: 130, datastore: 'ds1' })).toEqual({ id: '1', jobid: 130, mode: 'newVm', newVm: { name: 'web-01-restored', datastore: 'ds1' }, nic: 'disconnect' });
    expect(T.itemBody({ ...ov, jobid: 130, confirmName: 'web-01', allowDisksMismatch: true })).toEqual({ id: '1', jobid: 130, mode: 'original', confirmName: 'web-01', allowDisksMismatch: true, nic: 'keep' });
    expect(T.itemBody({ ...it0, mode: 'localVmdk', jobid: 130 })).toEqual({ id: '1', jobid: 130, mode: 'localVmdk' });
  });
  it('2 → 3 단계 확인 — 지점 · 이름 · 덮어쓰기 1대 · 이름 재입력 · 겹침', () => {
    const jobs = new Map([['1', J('1', 'web-01', '/')], ['2', J('2', 'web-02', '/')]]);
    const a = { ...T.defaultItem(jobs.get('1')), jobid: 130 };
    const b = { ...T.defaultItem(jobs.get('2')), jobid: 230 };
    expect(T.wizardIssue([], jobs)).toMatch(/고르세요/);
    expect(T.wizardIssue([a, b], jobs)).toBe('');
    expect(T.wizardIssue([a, { ...b, jobid: null }], jobs)).toMatch(/web-02.*복원 지점/);
    expect(T.wizardIssue([T.withMode(a, 'original'), b], jobs)).toMatch(/1대씩/);
    expect(T.wizardIssue([T.withMode(a, 'original')], jobs)).toMatch(/그대로 입력/);
    expect(T.wizardIssue([{ ...T.withMode(a, 'original'), confirmName: 'web-01' }], jobs)).toBe('');
    expect(T.wizardIssue([a, { ...b, name: 'WEB-01-restored' }], jobs)).toMatch(/겹칩니다/);
    expect(T.wizardIssue([{ ...a, name: '  ' }], jobs)).toMatch(/새 VM 이름/);
  });
  it('지점 · 데이터스토어 · 용량 판정 글자 — 모르면 —', () => {
    expect(T.pointText({ startedAt: new Date(2026, 9, 23, 2, 0).getTime(), level: 'I', chain: 3 })).toMatch(/10-23 02:00 · .+ · 체인 3/);
    expect(T.pointText({ startedAt: null, level: 'F', chain: null })).toMatch(/^— · .+ · 체인 없음/);
    expect(T.latestPoint([{ jobid: 1, chain: null }, { jobid: 2, chain: 2 }])?.jobid).toBe(2);
    expect(T.latestPoint([])).toBe(null);
    expect(T.dsText({ name: 'ds1', freeGB: 1536, capacityGB: 4096 })).toBe('ds1 · 여유 1.5TB / 4.0TB');
    expect(T.dsText({ name: 'ds1', freeGB: null, capacityGB: 500 })).toBe('ds1 · 여유 — / 500GB');
    expect(T.capacityText({ datastore: 'd', verdict: 'unknown', needGB: null, freeGB: 10 })).toMatch(/VM 용량을 읽지 못해/);
    expect(T.capacityText({ datastore: 'd', verdict: 'ok', needGB: 100, freeGB: 900 })).toMatch(/충분/);
    expect(T.capacityText({ datastore: 'd', verdict: 'short', issue: 'X 부족' })).toBe('X 부족');
  });
  it('네트워크 끊기 상태 · 묶음 진행 · 최근 묶음', () => {
    expect(T.finishText({ nic: 'disconnect', jobid: 9, state: 'running' })).toBe('복원 끝나면 끊음');
    expect(T.finishText({ nic: 'disconnect', jobid: 9, state: 'ok', finish: { nic: 'pending' } })).toBe('끊는 중');
    expect(T.finishText({ nic: 'disconnect', jobid: 9, state: 'ok', finish: { nic: 'ok' } })).toBe('끊음');
    expect(T.finishText({ nic: 'disconnect', jobid: 9, state: 'ok', finish: { nic: 'failed', detail: '켜져 있어' } })).toBe('실패 — 켜져 있어');
    expect(T.finishText({ nic: 'keep' })).toBe('그대로');
    expect(T.finishText({ jobid: 1 })).toBe('—');
    const jobs = [
      J('1', 'b', '/', { restores: [{ jobid: 1, batchId: 'rb-1', state: 'running', at: 2 }] }),
      J('2', 'a', '/', { restores: [{ jobid: 2, batchId: 'rb-1', state: 'ok', at: 2, nic: 'disconnect', finish: { nic: 'failed' } }, { jobid: 3, batchId: 'rb-0', state: 'ok', at: 1 }] }),
    ];
    const v = T.batchView(jobs, 'rb-1');
    expect([v.total, v.open, v.ok, v.bad, v.nicFailed]).toEqual([2, 1, 1, 0, 1]);
    expect(v.rows.map((x) => x.vmName)).toEqual(['a', 'b']);
    expect(T.latestBatchId(jobs)).toBe('rb-1');
    expect(T.latestBatchId([])).toBe('');
  });
  it('덮어쓰기 뒤 Full 권장 · 남은 스냅샷 칩(모르면 null)', () => {
    const job = J('1', 'a', '/', { restores: [{ mode: 'original', state: 'ok', endedAt: 100 }], lastRun: { startedAt: 50 } });
    expect(T.fullAfterRestoreHint(job)).toMatch(/Full/);
    expect(T.fullAfterRestoreHint({ ...job, lastRun: { startedAt: 150 } })).toBe('');
    expect(T.fullAfterRestoreHint(J('1', 'a', '/', { restores: [{ mode: 'newVm', state: 'ok' }] }))).toBe('');
    expect([T.snapshotChip(2), T.snapshotChip(0), T.snapshotChip(null), T.snapshotChip(undefined)]).toEqual(['스냅샷 2개', null, null, null]);
  });
  it('만든 문구에 백틱 · 강조 별표 없음(BoldText 규약)', () => {
    const jobs = new Map([['1', J('1', 'web-01', '/')]]);
    const outs = [
      T.wizardIssue([], jobs), T.wizardIssue([{ ...T.defaultItem(jobs.get('1')), jobid: null }], jobs), T.pickBlock(J('1', 'a', '/', { writable: false })),
      T.finishText({ nic: 'disconnect', jobid: 1, state: 'ok', finish: { nic: 'failed', detail: 'x' } }), T.capacityText({ datastore: 'd', verdict: 'unknown', needGB: 1, freeGB: null }),
      T.fullAfterRestoreHint(J('1', 'a', '/', { restores: [{ mode: 'original', state: 'ok' }] })), T.SNAPSHOT_TITLE,
    ];
    for (const s of outs) { expect(s).not.toMatch(/`/); expect(s).not.toMatch(/\*\*/); }
  });
  it('v2.862 복원 검증 · 일일 요약 글자 — 모르면 —(0 아님) · 검증 회차는 최근 묶음에서 뺀다', () => {
    expect(T.rehearsalPolicyText({ enabled: false, weekday: 6, time: '03:17', perCorp: 3, deleteOnOk: true })).toBe('꺼짐 · 매주 토요일 03:17 · 법인마다 3대 · 성공한 검증용 VM 지움 · 실패는 남김');
    expect([T.toolsText(null), T.toolsText(undefined), T.toolsText(0), T.toolsText(42_000), T.toolsText(125_000)]).toEqual(['—', '—', '0초', '42초', '2분 5초']);
    expect(T.verifyText({ finish: { verify: 'ok' } })).toMatch(/성공/);
    expect(T.verifyText({ finish: { verify: 'failed' } })).toBe('실패');
    expect(T.verifyText({ state: 'error', finish: { nic: 'skipped' } })).toMatch(/복원 실패/);
    expect(T.verifyText({ rid: 9, state: 'running' })).toBe('복원 중');
    expect(T.verifyText({ rid: 9, state: 'ok', finish: { nic: 'pending' } })).toBe('켜 보는 중');
    expect(T.digestStatusText(null)).toBe('아직 보낸 적 없음');
    expect(T.digestStatusText({ day: '2026-11-03', ok: false, tries: 2, reason: 'SMTP' })).toBe('2026-11-03 실패(2번 — SMTP)');
    const jobs = [J('1', 'a', '/', { restores: [{ jobid: 1, batchId: 'rv-9', rehearsal: 'rv-9', at: 9 }, { jobid: 2, batchId: 'rb-1', at: 5 }] })];
    expect(T.latestBatchId(jobs)).toBe('rb-1');
  });
});
