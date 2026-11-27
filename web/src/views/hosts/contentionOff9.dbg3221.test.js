// dbg3221 9회차 — VM 분석 · Hypervisor 분석의 ‘CPU 경합 · 디스크 지연’ 요약 패널이 측정 꺼짐(scan.enabled === false)을 보지 않았다.
//   꺼져 있어도 머리 규칙 줄에 ‘15분마다 측정’ 이 나왔고(refreshMs 기본값 900000), 측정한 VM · 호스트가 0 이라 머리 숫자가 ‘0’(해당 없음)으로 그려졌다.
//   이제: 꺼짐이면 ‘N분마다 측정’ 을 싣지 않고 도구 화면과 같은 꺼짐 문구(SCAN_OFF_NOTE)를 보이며, 판정 수는 모름(null → ‘—’)이다.
//   켜져 있어도 측정한 VM(호스트)이 0 이면 그 측정에서 나온 수는 ‘—’ 다(guestPartView noValues 와 같은 규칙).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../../test/_stripComments.js';
import { contentionHostView } from './insight-tools/hostToolPanelsText.js';
import { contentionView, contentionRule, contentionEmpty } from '../vms/insight-tools/vmToolPanelsText.js';
import { fmtN } from '../insight/insightCore.js';
import { SCAN_OFF_NOTE, coverageNote } from '../contention/contentionText.js';

const { contentionSummaryByVc } = await import('../../../../server/src/contention/analyze.js');

const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;   // 정시 경계로 고정(docs/rules/common.md)
const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => stripComments(fs.readFileSync(path.join(here, p), 'utf8'));

// 측정값(perfc)이 하나도 없는 실제 모양 — 측정이 꺼져 있으면 collect.js 가 perfc 를 채우지 않는다.
const snap = {
  vcenters: [{ id: 'vc-a', name: 'A' }],
  hosts: [{ id: 'vc-a:h1', name: 'h1', vcenterId: 'vc-a', connectionState: 'CONNECTED' }, { id: 'vc-a:h2', name: 'h2', vcenterId: 'vc-a', connectionState: 'CONNECTED' }],
  vms: [{ id: 'vc-a:v1', name: 'v1', vcenterId: 'vc-a', host: 'h1', powerState: 'POWERED_ON' }, { id: 'vc-a:v2', name: 'v2', vcenterId: 'vc-a', host: 'h2', powerState: 'POWERED_ON' }],
  datastores: [],
};
const summary = (enabled) => ({ ...contentionSummaryByVc(snap, { now: NOW, refreshMs: 900_000, vcName: new Map([['vc-a', 'A']]), topN: 5 }), scan: { enabled, refreshMs: 900_000 } });

describe('경합 요약 패널 — 측정 꺼짐', () => {
  it('꺼짐: 규칙 줄에 ‘분마다 측정’ 이 없다 · 머리 숫자는 ‘—’ · 목록 비움 · 빈 줄 문구는 판정하지 않음', () => {
    const resp = summary(false);
    for (const v of [contentionView(resp, []), contentionHostView(resp, [])]) {
      expect(v.off).toBe(true);
      expect(v.noValues).toBe(true);
      expect(contentionRule(v)).not.toMatch(/분마다 측정/);
      expect(contentionRule(v)).toMatch(/심각 = 대기 \d+% 이상/);
      expect(contentionEmpty(v, '없습니다')).toBe('측정이 꺼져 있어 판정하지 않습니다.');
    }
    const vm = contentionView(resp, []);
    expect([vm.readyCrit, vm.readyWarn, vm.costop, vm.diskCrit, vm.diskWarn]).toEqual([null, null, null, null, null]);
    expect(fmtN(vm.readyCrit)).toBe('—');
    expect(vm.ready).toEqual([]); expect(vm.disk).toEqual([]);
    const h = contentionHostView(resp, []);
    expect([h.hostsReadyCrit, h.hostsContended, h.hostsDisk, h.dsSlow]).toEqual([null, null, null, null]);
    expect(fmtN(h.hostsReadyCrit)).toBe('—');
    expect(h.hosts).toEqual([]); expect(h.datastores).toEqual([]);
    // 도구 화면과 같은 문구 하나
    expect(coverageNote(resp)).toBe(SCAN_OFF_NOTE);
  });
  it('켜짐 · 측정 0: 규칙 줄에 ‘15분마다 측정’ · 머리 숫자는 ‘—’(0 이 아니다) · 빈 줄 문구는 측정한 값 없음', () => {
    const resp = summary(true);
    const vm = contentionView(resp, []);
    expect(vm.off).toBe(false); expect(vm.noValues).toBe(true);
    expect(vm.measured).toBe(0);
    expect(contentionRule(vm)).toMatch(/15분마다 측정/);
    expect(vm.readyCrit).toBeNull();
    expect(contentionEmpty(vm, '없습니다')).toBe('측정한 값이 없어 판정하지 않았습니다.');
    const h = contentionHostView(resp, []);
    expect(h.hostsMeasured).toBe(0);
    expect([h.hostsReadyCrit, h.hostsDisk, h.dsSlow]).toEqual([null, null, null]);
  });
  it('켜짐 · 측정 있음: 수는 그대로(0 은 0) · 빈 줄 문구는 원래 문구', () => {
    const resp = { thresholds: { readyCrit: 10 }, scan: { enabled: true, refreshMs: 600_000 },
      rows: [{ vcenterId: 'a', coverage: { poweredOn: 3, measured: 3, hostsConnected: 2, hostsMeasured: 2 }, kpi: { readyCrit: 0, hostsDisk: 0, dsSlow: 0 }, hostsReadyCrit: 0, hostsContended: 0, top: {} }] };
    const vm = contentionView(resp, []);
    expect(vm.noValues).toBe(false); expect(vm.readyCrit).toBe(0);
    expect(contentionRule(vm)).toBe('심각 = 대기 10% 이상 · 10분마다 측정');
    expect(contentionEmpty(vm, '없습니다')).toBe('없습니다');
    const h = contentionHostView(resp, []);
    expect([h.hostsReadyCrit, h.hostsDisk, h.dsSlow]).toEqual([0, 0, 0]);
  });
  it('호스트만 측정 0(VM 측정 있음): VM 판정에서 나온 수는 그대로 · 호스트 보고값 수만 ‘—’', () => {
    const resp = { thresholds: {}, scan: { enabled: true, refreshMs: 900_000 },
      rows: [{ vcenterId: 'a', coverage: { measured: 4, hostsConnected: 2, hostsMeasured: 0 }, kpi: { hostsDisk: 0, dsSlow: 0 }, hostsReadyCrit: 1, hostsContended: 1, top: {} }] };
    const h = contentionHostView(resp, []);
    expect([h.hostsReadyCrit, h.hostsContended]).toEqual([1, 1]);
    expect([h.hostsDisk, h.dsSlow]).toEqual([null, null]);
    expect(h.noValues).toBe(false);
  });
  it('소스 계약 — 두 패널이 공용 규칙 줄 · 꺼짐 문구를 쓰고 scan.refreshMs 로 직접 만들지 않는다', () => {
    for (const f of ['insight-tools/HostToolPanels.jsx', '../vms/insight-tools/VmToolPanels.jsx']) {
      const src = read(f);
      const body = src.slice(src.indexOf('function ContentionPanel'), src.indexOf('\n}\n', src.indexOf('function ContentionPanel')));
      expect(body).toMatch(/contentionRule\(v\)/);
      expect(body).toMatch(/v\.off && <div className="vit-note warn">\{SCAN_OFF_NOTE\}<\/div>/);
      expect(body).not.toMatch(/scan\??\.refreshMs/);
      expect((body.match(/contentionEmpty\(v, /g) || []).length).toBe(2);
    }
  });
});
