// v2.959 — Backup 현황 · Detail 이 이어받는 vCenter 키 · 여는 함수 한 벌(서머리 openDetail 과 가상화 플랫폼 KPI 카드가 같이 쓴다).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { DETAIL_VC_KEY, openBackupDetail } from './backupViewText.js';

describe('openBackupDetail(v2.959)', () => {
  it('고른 vCenter 를 키에 남기고 Detail 주소로 간다 — 저장이 막혀도 이동은 한다 · 빈 id 는 저장하지 않는다', () => {
    const mem = new Map();
    const storage = { setItem: (k, v) => mem.set(k, v) };
    const gone = [];
    openBackupDetail('vc-a', { storage, go: (h) => gone.push(h) });
    expect(mem.get(DETAIL_VC_KEY)).toBe('vc-a');
    expect(gone).toEqual(['#/tools/backup-detail']);
    const broken = { setItem: () => { throw new Error('quota'); } };
    expect(() => openBackupDetail('vc-b', { storage: broken, go: (h) => gone.push(h) })).not.toThrow();
    expect(gone.length).toBe(2);
    openBackupDetail('', { storage, go: (h) => gone.push(h) });
    expect(mem.get(DETAIL_VC_KEY)).toBe('vc-a');
    expect(openBackupDetail(' vc-c ', { storage: null, go: () => {} })).toBeUndefined();
  });
  it('키는 한 곳 — BackupSummaryTool 은 재수출만 하고 BackupDetailTool · VCenters 는 같은 값을 읽는다', () => {
    expect(DETAIL_VC_KEY).toBe('backup-detail-vc');
    const sum = fs.readFileSync(new URL('./BackupSummaryTool.jsx', import.meta.url), 'utf8');
    expect(sum).toMatch(/export \{ DETAIL_VC_KEY \};/);
    expect(sum).not.toMatch(/localStorage\.setItem\(DETAIL_VC_KEY/);
    const vc = fs.readFileSync(new URL('../VCenters.jsx', import.meta.url), 'utf8');
    expect(vc).toMatch(/openBackupDetail\(vcSel\)/);
    expect(vc).not.toMatch(/'backup-detail-vc'/);
  });
});
