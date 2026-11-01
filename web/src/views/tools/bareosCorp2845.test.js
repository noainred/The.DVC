// v2.845 법인별 Bareos · 중앙 계정 통합 화면 판정(bareosCorpText.js). 서버 본문과의 대조는 server/test/bareosManage2845.test.js ③.
import { describe, it, expect } from 'vitest';
import {
  storageRows, portalOf, diskText, pathCheckLines, accountRows, profileOptions, poolFormOf, matrixCell, matrixTotals, bulkEligible, bulkCounts, bulkSummaryText,
  passwordCsv, maskPw, pwPairIssue, nameIssue, noSshNeeded, sshSourceText, retentionText,
} from './bareosCorpText.js';

const cfgSt = [
  { name: 'File', device: ['FileStorage'], mediaType: ['File'], maxConcurrentJobs: 10 },
  { name: 'Nas', device: ['NasStorage'], mediaType: ['Nas'], maxConcurrentJobs: 4 },
  { name: 'Mapped', device: ['MapDev'], mediaType: ['Map'], maxConcurrentJobs: null },
];
const scan = {
  devices: [{ name: 'FileStorage', archiveDevice: '/var/lib/bareos/storage', portal: false }, { name: 'NasStorage', archiveDevice: '/mnt/nas', portal: true }, { name: 'MapDev', archiveDevice: '/mnt/map', portal: true }],
  files: [{ type: 'storage', name: 'File', portal: false }, { type: 'storage', name: 'Nas', portal: true }, { type: 'storage', name: 'Mapped', portal: true }, { type: 'console', name: 'ops', portal: true }],
  disks: [{ path: '/var/lib/bareos/storage', files: 12, availBytes: 1e12, sizeBytes: 2e12 }, { path: '/mnt/nas', files: 0, availBytes: null, sizeBytes: null }, { path: '/mnt/map', files: 0, availBytes: 5, sizeBytes: 10 }],
};

describe('백업 스토리지 행', () => {
  it('스캔 전에는 만든 곳 · 경로 · 여유를 모른다(null · —) — 0 으로 보지 않는다', () => {
    const r = storageRows(cfgSt, null, []);
    expect(r.map((x) => x.portal)).toEqual([null, null, null]);
    expect(r[0].files).toBe(null);
    expect(r[0].delIssue).toMatch(/읽은 뒤/);
    expect(r[2].mcj).toBe(null);
  });
  it('스캔 뒤: 사람 파일은 읽기만 · 매핑 · 볼륨 파일이 있으면 삭제 불가 · 여유를 못 읽으면 —', () => {
    const r = storageRows(cfgSt, scan, ['Mapped']);
    expect(r[0]).toMatchObject({ portal: false, delIssue: '사람이 만든 설정 — 읽기만', path: '/var/lib/bareos/storage', files: 12 });
    expect(r[1]).toMatchObject({ portal: true, delIssue: '' });
    expect(diskText(r[1].disk)).toBe('—');
    expect(r[2].delIssue).toMatch(/매핑/);
    const vol = storageRows([cfgSt[1], cfgSt[0]], { ...scan, disks: [{ path: '/mnt/nas', files: 3, availBytes: 1, sizeBytes: 2 }] }, []);
    expect(vol[0].delIssue).toBe('볼륨 파일 3개');
    expect(storageRows([cfgSt[1]], scan, [])[0].delIssue).toBe('마지막 스토리지');
  });
  it('바꾼 뒤 오래된 스캔에 없는 이름은 사람 파일이 아니라 모름(v2.845 Chromium 실측 결함)', () => {
    const r = storageRows([...cfgSt, { name: 'New', device: ['NewStorage'], mediaType: ['New'] }], { ...scan, stale: true }, []);
    expect(r[3].portal).toBe(null);
    expect(portalOf({ ...scan, stale: false }, 'storage', 'New')).toBe(false);
    expect(portalOf(null, 'storage', 'New')).toBe(null);
  });
  it('경로 점검 줄', () => {
    const l = pathCheckLines({ kind: 'none', canonical: true, parent: '/mnt', availBytes: 100, sizeBytes: 200, mount: '/mnt', fsType: 'nfs4', selinux: 'Enforcing' }, '/mnt/nas01/b');
    expect(l.map((x) => x.label)).toEqual(['경로', '디스크', 'SELinux', '쓰기 시험']);
    expect(l[0].ok).toBe(null);
    expect(pathCheckLines({ kind: 'link', canonical: false }, '/x/y')[0].ok).toBe(false);
    expect(pathCheckLines({ kind: 'dir', canonical: false, availBytes: null }, '/x/y').find((x) => x.label === '정규 경로').ok).toBe(false);
    expect(pathCheckLines({ kind: 'dir', canonical: true, availBytes: null }, '/x/y').find((x) => x.label === '디스크').text).toMatch(/—/);
    expect(pathCheckLines(null, '/x')).toEqual([]);
  });
});

describe('WebUI 계정 행', () => {
  it('포탈 전용 · 패키지 콘솔은 잠김 · 사람 파일은 읽기만 · 모름은 서버가 판정', () => {
    const r = accountRows([{ name: 'portal', profile: ['portal'] }, { name: 'bareos-mon', commandAcl: ['status'] }, { name: 'admin', profile: ['webui-admin'] }, { name: 'ops', profile: ['webui-readonly'], tlsEnable: false }], scan, 'portal');
    expect(r[0].own).toBe(true); expect(r[0].lock).toMatch(/전용 콘솔/);
    expect(r[1].reserved).toBe(true); expect(r[1].profile).toMatch(/ACL 1개/);
    expect(r[2].portal).toBe(false); expect(r[2].lock).toMatch(/사람이 만든/);
    expect(r[3]).toMatchObject({ portal: true, lock: '' });
    expect(accountRows([{ name: 'ops', profile: [] }], null, 'portal')[0]).toMatchObject({ portal: null, lock: '', profile: '—' });
  });
  it('Profile 선택지에서 포탈 Profile 은 뺀다', () => {
    expect(profileOptions([{ name: 'portal' }, { name: 'webui-admin' }, { name: 'custom' }]).map((o) => o.value)).toEqual(['webui-admin', 'custom']);
  });
});

describe('풀 · 스케줄 초기값', () => {
  it('포탈 풀 · 스케줄을 읽어 칸을 채운다 · 못 읽으면 빈 칸(지어내지 않는다)', () => {
    const f = poolFormOf([{ name: 'PortalVmwareFull', volRetentionSec: 90 * 86400, maxVolBytes: 50 * 1024 ** 3 }, { name: 'PortalVmwareIncr', volRetentionSec: 30 * 86400, maxVolBytes: 50 * 1024 ** 3 }],
      [{ name: 'PortalVmwareNightly', run: [{ text: 'Full sun at 02:00', level: 'Full' }, { text: 'Incremental mon at 02:00', level: 'Incremental' }] }]);
    expect(f).toEqual({ fullDays: '90', incrDays: '30', maxVolumeGB: '50', fullDay: 'sun', time: '02:00', hasPools: true, hasSchedule: true });
    expect(poolFormOf([], [])).toEqual({ fullDays: '', incrDays: '', maxVolumeGB: '', fullDay: '', time: '', hasPools: false, hasSchedule: false });
    expect(poolFormOf([], [{ name: 'PortalVmwareNightly', run: [{ text: 'Full Sunday at 2:05', level: 'Full' }] }]).time).toBe('02:05');
    expect(retentionText(null)).toBe('—');
  });
});

describe('중앙 계정 통합', () => {
  const dirs = [
    { id: 'a', name: 'A', ok: true, consoles: [{ name: 'ops', profile: ['webui-readonly'] }, { name: 'portal', portalConsole: true, profile: ['portal'] }] },
    { id: 'b', name: 'B', ok: true, consoles: [] },
    { id: 'c', name: 'C', ok: false, error: 'connect' },
  ];
  it('칸: 있음 · 없음 · 확인 불가(조회 실패 ≠ 없음) · 잠김', () => {
    expect(matrixCell(dirs[0], 'ops')).toEqual({ kind: 'has', text: 'webui-readonly' });
    expect(matrixCell(dirs[1], 'ops').kind).toBe('none');
    expect(matrixCell(dirs[2], 'ops').kind).toBe('unknown');
    expect(matrixCell(dirs[0], 'portal').kind).toBe('locked');
    expect(matrixTotals(dirs, 'ops').text).toBe('1 / 3 · 확인 불가 1');
  });
  it('일괄 대상: 추가는 없는 법인 · 변경/삭제는 있는 법인 · 조회 실패 법인은 서버가 판정', () => {
    const add = bulkEligible(dirs, 'console.add', 'ops');
    expect(add.map((x) => x.ok)).toEqual([false, true, true]);
    expect(add[2].why).toMatch(/서버가 판정/);
    expect(bulkEligible(dirs, 'console.delete', 'ops').map((x) => x.ok)).toEqual([true, false, true]);
    expect(bulkEligible(dirs, 'console.password', 'portal')[0].ok).toBe(false);
    expect(bulkEligible(dirs, 'console.add', '').every((x) => !x.ok)).toBe(true);
  });
  it('결과 요약은 부분 성공을 숨기지 않는다 · CSV 는 생성 비밀번호가 있는 법인만 · 따옴표 처리', () => {
    const res = [{ name: 'A,1', status: 'done', generatedPassword: 'pw"1' }, { name: 'B', status: 'failed' }, { name: 'C', status: 'skipped' }, { name: 'D', status: 'unknown' }];
    expect(bulkCounts(res)).toEqual({ done: 1, failed: 1, skipped: 1, unknown: 1 });
    expect(bulkSummaryText(res)).toBe('**부분 성공** — 성공 1 · 실패 1 · 보내지 않음 1 · 결과 모름 1');
    expect(bulkSummaryText([{ status: 'done' }])).toBe('성공 1 · 실패 0 · 보내지 않음 0');
    expect(passwordCsv(res, 'ops')).toBe('corp,account,password\n"A,1",ops,"pw""1"\n');
    expect(passwordCsv([{ name: 'B', status: 'failed' }], 'ops')).toBe('');
  });
});

describe('기타', () => {
  it('비밀번호 가림 · 두 번 입력 · 이름 · SSH 출처', () => {
    expect(maskPw('abcdefghijkl')).toBe('abcd••••ijkl');
    expect(maskPw('short')).toBe('••••');
    expect(pwPairIssue('Abcdef-123456', 'Abcdef-123457')).toMatch(/다릅니다/);
    expect(pwPairIssue('Abcdef-123456', 'Abcdef-123456')).toBe('');
    expect(nameIssue('ok_name-1')).toBe('');
    expect(nameIssue('bad name')).toMatch(/영문/);
    expect(noSshNeeded({ source: 'registry' })).toBe(true);
    expect(noSshNeeded({ source: 'demo' })).toBe(true);
    expect(noSshNeeded({ source: 'input' })).toBe(false);
    expect(sshSourceText({ source: 'input' })).toMatch(/저장하지 않음/);
  });
});
