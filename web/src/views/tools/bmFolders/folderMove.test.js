import { describe, it, expect } from 'vitest';
import { canMove, moveTargets, movedPath, followSel, moveNote } from './folderMove.js';

const paths = ['AWX', 'DVC', 'Service', 'Service\\SBP', 'Service\\SBP\\AP', 'Service\\SBP\\DP', 'Service\\SBP\\DP\\Airflow', 'DVC\\AP'];
describe('v2.997 폴더 옮기기(같은 법인 · 부모만)', () => {
  it('막는 곳 — 지금 자리 · 자기/하위 · 같은 이름 · 없는 폴더 · 깊이', () => {
    expect(canMove('Service\\SBP\\DP', 'Service\\SBP', paths).ok).toBe(false);
    expect(canMove('Service\\SBP', 'Service\\SBP\\DP', paths).why).toContain('하위');
    expect(canMove('Service\\SBP\\AP', 'DVC', paths).why).toContain('같은 이름');
    expect(canMove('AWX', 'NOPE', paths).ok).toBe(false);
    const deep = Array.from({ length: 9 }, (_, i) => Array.from({ length: i + 1 }, (_, j) => `L${j}`).join('\\'));
    expect(canMove('Service\\SBP\\DP', deep[8], [...paths, ...deep]).why).toContain('10단계');
    expect(canMove('Service\\SBP\\DP', 'AWX', paths)).toEqual({ ok: true, why: '' });
    expect(canMove('Service\\SBP\\DP', '', paths).ok).toBe(true);
  });
  it('옮길 수 있는 곳 · 새 경로 · 고른 폴더 따라가기 · 알림', () => {
    expect(moveTargets('Service\\SBP\\DP', paths).map((x) => x.parent)).toEqual(['', 'AWX', 'DVC', 'DVC\\AP', 'Service', 'Service\\SBP\\AP']);
    expect(movedPath('Service\\SBP\\DP', 'AWX')).toBe('AWX\\DP');
    expect(followSel({ type: 'folder', corp: 'c', path: 'Service\\SBP\\DP\\Airflow' }, 'c', 'Service\\SBP\\DP', 'AWX\\DP')).toEqual({ type: 'folder', corp: 'c', path: 'AWX\\DP\\Airflow' });
    expect(followSel({ type: 'folder', corp: 'c', path: 'Service\\SBP\\DPX' }, 'c', 'Service\\SBP\\DP', 'AWX\\DP').path).toBe('Service\\SBP\\DPX');
    expect(moveNote('A\\B', 'C\\B', { moved: 2, rules: 1 })).toEqual({ ok: true, text: '‘A › B’ 을(를) ‘C › B’ 로 옮겼습니다(등록 2대 · 규칙 1개 함께).' });
    expect(moveNote('A', 'C\\A', { svcRulesNotMoved: 'x' }).ok).toBe(false);
  });
});
