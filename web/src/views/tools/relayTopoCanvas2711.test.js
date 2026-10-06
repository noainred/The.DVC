// v2.711: 중계 토폴로지 3D 캔버스 — 화면을 떠날 때(효과 정리 전) 떨어진 캔버스로 그린 마지막 프레임이 NaN 좌표로
// createRadialGradient 를 던졌다(전수 화면 조사에서 발견). 크기 0 · 연결 끊김 · 유한하지 않은 노드는 그리지 않는다.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../../test/_stripComments.js';

const src = stripComments(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'RelayTopoTool.jsx'), 'utf8'));

describe('RelayTopoTool 3D 캔버스 가드', () => {
  it('크기가 없거나 떨어진 캔버스면 그리지 않고 다음 프레임으로 넘긴다', () => {
    expect(src).toMatch(/if \(!cv\.isConnected \|\| !\(w > 0 && h > 0\)\) \{ raf = requestAnimationFrame\(draw\); return; \}/);
  });
  it('투영이 유한하지 않은 노드는 그라데이션을 만들지 않는다', () => {
    const guard = src.indexOf('if (!Number.isFinite(n.x) || !Number.isFinite(n.y) || !(r > 0)) continue;');
    const grad = src.indexOf('ctx.createRadialGradient(n.x');
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(grad);
  });
});
