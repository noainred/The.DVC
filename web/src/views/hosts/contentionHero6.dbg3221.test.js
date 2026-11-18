// dbg3221 6회차 — 호스트 분석 ‘CPU 경합 · 디스크 지연’ 패널의 머리 숫자.
//   분자(hostsReadyCrit)는 VM 측정값(vm.perfc)으로 센 호스트이고, 예전 분모 hostsMeasured 는 호스트 측정값(host.perfc)이 신선한 호스트만이라
//   모집단이 달랐다(호스트 묶음이 시한에 잘리면 ‘측정한 호스트 1대 중 2대’). 분모는 연결된 호스트(hostsConnected — 분자를 포함하는 모집단)로 쓴다.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../../test/_stripComments.js';
import { contentionHostView } from './insight-tools/hostToolPanelsText.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = stripComments(fs.readFileSync(path.join(here, 'insight-tools/HostToolPanels.jsx'), 'utf8'));

describe('경합 패널 머리 숫자의 분모', () => {
  it('Hero 문구는 ‘연결된 호스트 M대 중’ — hostsConnected 를 쓰고 hostsMeasured 를 쓰지 않는다', () => {
    const hero = src.split('\n').find((l) => l.includes('<Hero') && l.includes('hostsReadyCrit'));
    expect(hero).toBeTruthy();
    expect(hero).toMatch(/연결된 호스트 \$\{fmtU\(v\.hostsConnected, '대'\)\} 중/);
    expect(hero).not.toMatch(/hostsMeasured/);
    expect(hero).not.toMatch(/측정한 호스트/);
  });
  it('재현 입력(호스트 측정 1대 · 대기 심각 호스트 2대 · 연결 2대) — 분자 ≤ 새 분모', () => {
    const resp = { thresholds: { readyCrit: 10 }, rows: [{ vcenterId: 'A', coverage: { hostsConnected: 2, hostsMeasured: 1 }, kpi: {}, hostsReadyCrit: 2, hostsContended: 2, top: { hosts: [], datastores: [] } }] };
    const v = contentionHostView(resp, []);
    expect(v.hostsReadyCrit).toBe(2);
    expect(v.hostsMeasured).toBe(1);                         // 예전 분모 — 분자보다 작았다
    expect(v.hostsReadyCrit).toBeLessThanOrEqual(v.hostsConnected);
  });
});
