/**
 * v3.28.1 — 화면이 서버의 '못 읽은 vCPU · 메모리'(합 null · vcpuUnknown · ramUnknown · allocUnknown · vmAllocUnknown)를 0 으로 되돌리지 않는다.
 * 서버 회귀는 server/test/vmAllocSweep3281.test.js. 여기는 글자 함수(순수) + 화면 소스 스윕.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allocText, allocNullTitle, minMark } from './summaryAllocText.js';
import { samplerWithheldNote, normalizeWithheld } from './samplerWithheldText.js';
import { reclaimBasisNote } from './toolsReportText.js';
import { buildOverviewRows, OVERVIEW_COLUMNS } from './vcdOverview.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = (rel) => fs.readFileSync(path.join(HERE, rel), 'utf8');

describe('allocText — 한 줄 글자판', () => {
  it('null → — (단위 없음) · 미상 수가 있으면 붙인다', () => {
    expect(allocText(null)).toBe('—');
    expect(allocText(null, 3, ' GB')).toBe('— · 미상 3');
    expect(allocText('', 0, ' GB')).toBe('—');
  });
  it('값 + 단위 + 미상 수 · 0 은 읽은 값', () => {
    expect(allocText(1234, 0, ' GB')).toBe('1,234 GB');
    expect(allocText(1234, 2)).toBe('1,234 · 미상 2');
    expect(allocText(0)).toBe('0');
  });
  it('allocNullTitle — 하나도 못 읽은 경우만 이유를 말한다', () => {
    expect(allocNullTitle(null, 4, 'vcpu')).toContain('VM 4대의 vCPU 를 하나도 읽지 못해');
    expect(allocNullTitle(10, 4, 'vcpu')).toBe('');
    expect(allocNullTitle(null, 0, 'ram')).toBe('');
  });
  it('minMark — 비율이 있을 때만 ≥', () => {
    expect(minMark(1.5, 2)).toBe('≥ '); expect(minMark(null, 2)).toBe(''); expect(minMark(1.5, 0)).toBe('');
  });
});

describe('추이 적재 안내 — 할당 크기를 못 읽은 VM', () => {
  it('lastRun · 요약 두 모양 모두 vmAllocUnknown 을 읽고 문장으로 말한다', () => {
    expect(normalizeWithheld({ at: 1, staleVcenters: 0, vmAllocUnknown: { cpu: 2, mem: 0 } }).vmAllocUnknown).toEqual({ cpu: 2, mem: 0 });
    expect(normalizeWithheld({ vmAllocUnknown: { cpu: 0, mem: 3 } }).vmAllocUnknown).toEqual({ cpu: 0, mem: 3 });
    const t = samplerWithheldNote({ staleVcenters: 0, vmAllocUnknown: { cpu: 2, mem: 1 } });
    expect(t).toContain('할당 크기를 읽지 못한 켜진 VM(vCPU 2대 · 메모리 1대)');
    expect(t).toContain('할당 0 으로 채우지 않았습니다');
    expect(samplerWithheldNote({ staleVcenters: 0, vmAllocUnknown: { cpu: 0, mem: 0 } })).toBe(null);
  });
});

describe('인사이트 회수 합 안내', () => {
  it('크기를 못 읽은 후보가 있으면 최소값임을 밝힌다', () => {
    expect(reclaimBasisNote({ reclaimableRamGB: 12, reclaimBasis: 'instant', reclaimUnknown: { vcpu: 2, ramGB: 3 } })).toContain('크기 미상 VM 3대 제외(최소값)');
    expect(reclaimBasisNote({ reclaimableRamGB: 12, reclaimBasis: 'instant', reclaimUnknown: { vcpu: 0, ramGB: 0 } })).not.toContain('미상');
    expect(reclaimBasisNote({ reclaimableRamGB: 12 })).toBe('12 GB RAM');   // 옛 응답 그대로
  });
});

describe('vCenter 개요 표 · CSV — 못 읽은 VM 수 열', () => {
  it('호스트 · 클러스터 · vCenter 행에 vcpuUnknown · memUnknown 이 실리고 열 정의에 있다', () => {
    const hosts = [{ name: 'h1', cluster: 'C1', cpuCores: 8, cpuTotalMhz: 16000, memTotalMB: 65536, connectionState: 'CONNECTED' }];
    const vms = [{ host: 'h1', cpuCount: 4, memMB: 4096 }, { host: 'h1', cpuCount: null, memMB: '' }];
    const rows = buildOverviewRows({ site: { id: 'vc' }, hosts, vms });
    expect(rows.map((r) => [r.level, r.vcpuAlloc, r.vcpuUnknown, r.memUnknown])).toEqual([['vCenter', 4, 1, 1], ['클러스터', 4, 1, 1], ['호스트', 4, 1, 1]]);
    expect(OVERVIEW_COLUMNS.map((c) => c.key)).toEqual(expect.arrayContaining(['vcpuUnknown', 'memUnknown']));
  });
});

describe('화면 소스 — null 을 0 으로 되돌리지 않는다', () => {
  it('탐색 · VM 목록 · 법인별 · 게스트 OS · 용량 · 인사이트 · VM 시리즈', () => {
    const explore = src('./Explore.jsx');
    expect(explore).not.toMatch(/totals\.vcpu\.toLocaleString\(\)/);   // null 이면 화면이 죽었다
    expect(explore).not.toMatch(/totals\.ramGB\.toLocaleString\(\)/);
    expect(src('./Vms.jsx')).not.toMatch(/fmt\(t\.vcpu\)|fmt\(t\.ramGB\)/);
    expect(src('./vms/VmsByCorp.jsx')).not.toMatch(/\{fmtN\(t\.ramGB\)\} GB/);   // 모르면 단위를 붙이지 않는다
    const guest = src('./tools/GuestOsTools.jsx');
    expect(guest).not.toMatch(/num\(r\.vcpu\)|num\(data\.totalVcpu\)|num\(vc\.vcpu\)|num\(o\.vcpu\)/);
    expect(guest).not.toMatch(/render: \(r\) => `\$\{r\.cpu\}` \}/);
    const cap = src('./tools/CapacityTools.jsx');
    expect(cap).toMatch(/allocText\(c\.vcpuAllocated, c\.vcpuUnknown\)/);
    expect(cap).toMatch(/minMark\(c\.vcpuPerCore, c\.vcpuUnknown\)/);
    expect(cap).toMatch(/oa\.allocUnknown\?\.cpu/);
    expect(src('./tools/InsightsThreats.jsx')).toMatch(/v\.ramGB == null \? '—'/);
    expect(src('./VmSeriesSettings.jsx')).not.toMatch(/\{vm\.vcpu\}vCPU/);
  });
});
