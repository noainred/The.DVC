// v2.680 감사 D-08 — iDRAC 통합 추이 카드 ◀ ▶ 는 '보이는 카드' 기준이다(숨은 ESXi 계열과 자리를 바꾸지 않는다).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
import { moveVisibleKey, DEFAULT_ORDER } from './idracTrendText.js';
import { stripComments } from '../../test/_stripComments.js';

describe('D-08 moveVisibleKey', () => {
  const order = ['cpuPct', 'hostCpuPct', 'cpuTemp', 'powerW', 'hostGpuPct'];
  const visible = ['cpuPct', 'cpuTemp', 'powerW'];
  it('숨은 키를 건너뛰고 보이는 이웃과 바꾼다', () => {
    expect(moveVisibleKey(order, visible, 'cpuPct', 1)).toEqual(['cpuTemp', 'hostCpuPct', 'cpuPct', 'powerW', 'hostGpuPct']);
    expect(moveVisibleKey(order, visible, 'cpuTemp', -1)).toEqual(['cpuTemp', 'hostCpuPct', 'cpuPct', 'powerW', 'hostGpuPct']);
  });
  it('보이는 끝에서는 그대로(숨은 꼬리와 바꾸지 않는다)', () => {
    expect(moveVisibleKey(order, visible, 'powerW', 1)).toEqual(order);
    expect(moveVisibleKey(order, visible, 'cpuPct', -1)).toEqual(order);
    expect(moveVisibleKey(DEFAULT_ORDER, DEFAULT_ORDER, 'nope', 1)).toEqual(DEFAULT_ORDER);
  });
  it('화면은 보이는 목록 길이로 ▶ 를 막고 moveVisibleKey 로 옮긴다', () => {
    const src = stripComments(fs.readFileSync(path.join(here, 'IdracTrendTool.jsx'), 'utf8'));
    expect(src).not.toMatch(/order\.length\s*-\s*1/);
    expect(src).toMatch(/visibleCards\.length\s*-\s*1/);
    expect(src).toMatch(/moveVisibleKey\(/);
    expect(src).not.toMatch(/moveKey\(/);
  });
});
