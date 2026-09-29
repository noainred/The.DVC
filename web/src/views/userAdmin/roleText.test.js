import { describe, it, expect } from 'vitest';
import { roleOptions, superTargetLocked, permCell, toggleAdminDenied, isAdminTier, MATRIX_NOTE } from './roleText.js';

const CSV = { key: 'data.csv', adminOnly: true, adminToggle: true };
const INV = { key: 'inv.vms' };

describe('v2.643 super_admin 화면 판정', () => {
  it('super_admin 선택지는 super_admin 에게만(그 계정이 이미 super_admin 이면 표시용으로 포함)', () => {
    expect(roleOptions(false, 'viewer')).not.toContain('super_admin');
    expect(roleOptions(true, 'viewer')).toContain('super_admin');
    expect(roleOptions(false, 'super_admin')).toContain('super_admin');
  });
  it('super_admin 계정은 super_admin 만 바꿀 수 있다', () => {
    expect(superTargetLocked(false, { role: 'super_admin' })).toBe(true);
    expect(superTargetLocked(true, { role: 'super_admin' })).toBe(false);
    expect(superTargetLocked(false, { role: 'admin' })).toBe(false);
    expect(isAdminTier('super_admin') && isAdminTier('admin') && !isAdminTier('operator')).toBe(true);
  });
  it('CSV 칸: super_admin 항상 · admin 은 super_admin 만 토글 · operator/viewer 잠금', () => {
    const perms = { matrix: { operator: ['inv.vms'], viewer: [], adminDenied: ['data.csv'] }, canEditAdminRow: false };
    expect(permCell(CSV, 'super_admin', perms)).toMatchObject({ checked: true, disabled: true });
    expect(permCell(CSV, 'admin', perms)).toMatchObject({ checked: false, disabled: true });
    expect(permCell(CSV, 'admin', { ...perms, canEditAdminRow: true })).toMatchObject({ checked: false, disabled: false });
    expect(permCell(CSV, 'operator', perms)).toMatchObject({ checked: false, disabled: true });
    expect(permCell(INV, 'admin', perms)).toMatchObject({ checked: true, disabled: true });
    expect(permCell(INV, 'operator', perms)).toMatchObject({ checked: true, disabled: false });
  });
  it('admin 행 토글은 adminDenied 를 뒤집는다(원본 불변)', () => {
    const m = { adminDenied: [] };
    const n = toggleAdminDenied(m, 'data.csv');
    expect(n.adminDenied).toEqual(['data.csv']);
    expect(m.adminDenied).toEqual([]);
    expect(toggleAdminDenied(n, 'data.csv').adminDenied).toEqual([]);
  });
  it('문구에 백틱 없음', () => { expect(MATRIX_NOTE.includes('`')).toBe(false); });
});
