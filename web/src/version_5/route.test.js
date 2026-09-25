import { describe, it, expect } from 'vitest';
import { isV5Hash, v5EntryTarget, readShell, writeShell, SHELL_KEY } from './route.js';

const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };

describe('V5 진입 신호', () => {
  it('#/v5 만 진입 신호다', () => {
    expect(isV5Hash('#/v5')).toBe(true);
    expect(isV5Hash('#/v5/vms')).toBe(true);
    expect(isV5Hash('#v5')).toBe(true);
    expect(isV5Hash('#/v4')).toBe(false);
    expect(isV5Hash('#/tools/v5')).toBe(false);
    expect(isV5Hash('')).toBe(false);
  });
  it('진입 신호 → 기존 주소', () => {
    expect(v5EntryTarget('#/v5')).toBe('#/overview');
    expect(v5EntryTarget('#/v5/')).toBe('#/overview');
    expect(v5EntryTarget('#/v5/vms')).toBe('#/vms');
    expect(v5EntryTarget('#/v5/tools/storage-mon/faults')).toBe('#/tools/storage-mon/faults');
  });
});

describe('셸 플래그', () => {
  it('쓰고 읽고 끈다', () => {
    const s = mem();
    expect(readShell(s)).toBe(false);
    expect(writeShell(true, s)).toBe(true);
    expect(s.getItem(SHELL_KEY)).toBe('v5');
    expect(readShell(s)).toBe(true);
    writeShell(false, s);
    expect(readShell(s)).toBe(false);
  });
  it('저장소가 throw 하면 V5 가 아니다(기존 화면이 안전한 기본값)', () => {
    expect(readShell(throwing)).toBe(false);
    expect(writeShell(true, throwing)).toBe(false);
  });
});
