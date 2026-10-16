// v2.743(감사 AUTHZ-02): VM 복제 화면의 NFS 마운트 표기 — 서버가 가린 응답(label·mountsMasked)과 구버전 응답 둘 다.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mountLabel, MOUNTS_MASKED_NOTE, showMountsMaskedNote } from './vmCloneMountText.js';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('vmCloneMountText', () => {
  it('label 이 있으면 그것을 쓰고, 구버전 응답(label 없음)은 서버:경로로 그린다', () => {
    expect(mountLabel({ id: 'nfs-a1', label: 'NFS 마운트 nfs-a1', mounted: true })).toBe('NFS 마운트 nfs-a1');
    expect(mountLabel({ id: 'nfs-a1', server: '10.0.0.5', exportPath: '/exp' })).toBe('10.0.0.5:/exp');
    expect(mountLabel({ id: 'nfs-a1' })).toBe('nfs-a1');
    expect(mountLabel(null)).toBe('');
    expect(mountLabel(undefined)).toBe('');
  });
  it('가린 응답이고 NFS 가 하나라도 있을 때만 안내를 띄운다', () => {
    expect(showMountsMaskedNote({ mountsMasked: true, mounts: [{ id: 'nfs-a' }], jobs: [] })).toBe(true);
    expect(showMountsMaskedNote({ mountsMasked: true, mounts: [], jobs: [{ dest: { type: 'nfs', mountId: 'x' } }] })).toBe(true);
    expect(showMountsMaskedNote({ mountsMasked: true, mounts: [], jobs: [{ dest: { type: 'datastore' } }] })).toBe(false);
    expect(showMountsMaskedNote({ mounts: [{ id: 'nfs-a' }], jobs: [] })).toBe(false);
    expect(showMountsMaskedNote(null)).toBe(false);
  });
  it('문구에 백틱·별표 강조가 없다', () => {
    expect(MOUNTS_MASKED_NOTE).not.toMatch(/[`]|\*\*/);
  });
  it('화면은 서버 주소 필드를 직접 그리지 않고 mountLabel 을 쓴다', () => {
    const src = fs.readFileSync(path.join(here, 'VmCloneTool.jsx'), 'utf8');
    expect(src).not.toMatch(/\{m\.server\}|\.server \|\|/);
    expect(src).toMatch(/mountLabel\(/);
  });
});
