// v2.846 Bareos 버그 점검 A 묶음 화면 판정 — U-3 디스크 합계(같은 파일시스템 한 번 · 일부 모름) · U-6 다시 시도 결과 합치기.
import { describe, it, expect } from 'vitest';
import { diskTotal, mergeBulkRows, storageRows } from './bareosCorpText.js';

describe('U-3 디스크 여유 합계', () => {
  it('같은 마운트를 쓰는 스토리지는 한 번만 더한다(완전 설치 기본값 File · PortalFile)', () => {
    const scan = { devices: [{ name: 'FileStorage', archiveDevice: '/var/lib/bareos/storage' }, { name: 'PortalFileStorage', archiveDevice: '/var/lib/bareos/storage' }],
      files: [], disks: [{ path: '/var/lib/bareos/storage', files: 0, availBytes: 400, sizeBytes: 1000, mount: '/var' }] };
    const rows = storageRows([{ name: 'File', device: ['FileStorage'] }, { name: 'PortalFile', device: ['PortalFileStorage'] }], scan, []);
    expect(diskTotal(rows)).toEqual({ availBytes: 400, sizeBytes: 1000, filesystems: 1, partial: false });
  });
  it('못 읽은 행이 있으면 일부 모름 · 하나도 모르면 null', () => {
    expect(diskTotal([{ disk: { path: '/a', mount: '/a', availBytes: 1, sizeBytes: 2 } }, { disk: null }]).partial).toBe(true);
    expect(diskTotal([{ disk: null }, { disk: { missing: true } }])).toBe(null);
  });
});

describe('U-6 다시 시도 결과 합치기', () => {
  it('다시 시도한 법인만 바꾸고 첫 실행 성공 법인의 생성 비밀번호를 남긴다', () => {
    const prev = [{ directorId: 'a', status: 'done', generatedPassword: 'pw-a' }, { directorId: 'b', status: 'failed' }];
    const next = [{ directorId: 'b', status: 'done', generatedPassword: 'pw-b' }];
    expect(mergeBulkRows(prev, next)).toEqual([{ directorId: 'a', status: 'done', generatedPassword: 'pw-a' }, { directorId: 'b', status: 'done', generatedPassword: 'pw-b' }]);
  });
});
