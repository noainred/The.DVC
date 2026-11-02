// 로그인 ID 기억 — 성공한 ID 만 저장하고, 비밀번호는 저장하지 않으며, 저장소 오류에도 로그인 화면이 깨지지 않는다.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOGIN_ID_KEY, cleanLoginId, loadLoginId, saveLoginId } from './loginIdMemory.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m }; };
const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };

describe('loginIdMemory', () => {
  it('저장한 ID 를 다시 읽는다(앞뒤 공백 제거)', () => {
    const s = mem();
    expect(loadLoginId(s)).toBe('');
    expect(saveLoginId('  kim.admin ', s)).toBe(true);
    expect(s.m.get(LOGIN_ID_KEY)).toBe('kim.admin');
    expect(loadLoginId(s)).toBe('kim.admin');
  });
  it('빈 값·제어문자·과도한 길이는 저장도 복원도 하지 않는다', () => {
    const s = mem();
    expect(saveLoginId('   ', s)).toBe(false);
    expect(saveLoginId('a\nb', s)).toBe(false);
    expect(saveLoginId('x'.repeat(129), s)).toBe(false);
    expect(s.m.size).toBe(0);
    s.setItem(LOGIN_ID_KEY, 'a\u0000b');
    expect(loadLoginId(s)).toBe('');
    expect(cleanLoginId(null)).toBe('');
    expect(cleanLoginId(123)).toBe('');
  });
  it('저장소가 예외를 던져도 빈 값/false 로 끝난다', () => {
    expect(loadLoginId(broken)).toBe('');
    expect(saveLoginId('admin', broken)).toBe(false);
  });
  it('Login.jsx 는 로그인 성공 뒤에만 저장하고 비밀번호는 저장 함수에 넘기지 않는다', () => {
    const src = fs.readFileSync(path.join(HERE, 'Login.jsx'), 'utf8');
    const iLogin = src.indexOf('await login(');
    const iSave = src.indexOf('saveLoginId(');
    expect(iLogin).toBeGreaterThan(0);
    expect(iSave).toBeGreaterThan(iLogin);
    expect(src).not.toMatch(/saveLoginId\([^)]*password/);
  });
  it('ID 칸은 name·autocomplete=username(크롬 기억용), 비밀번호 칸은 one-time-code 유지', () => {
    const src = fs.readFileSync(path.join(HERE, 'loginThemes.jsx'), 'utf8');
    expect(src).toMatch(/<input[^>]*name="username"[^>]*autoComplete="username"/);
    expect(src).toMatch(/autoComplete="one-time-code" value=\{f\.password\}/);
  });
});
