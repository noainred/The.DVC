/**
 * v2.727 감사 C-01(VM 스토리지 결측)·E-12(GPU VRAM 결측) — 웹 소비처가 null 을 0 으로 그리지 않는다.
 *
 * 변이 검증: gpuUsageText.vramText 의 `n == null ? '—'` 를 `${n} GB` 로 되돌리거나, GpuTool 의 `numOrNull(h.memGB)` 를 `h.memGB || 0`
 * 으로 되돌리거나, shared.jsx tb 의 null 가드를 지우면 아래가 실패한다.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { vramText, vramTitle, VRAM_UNKNOWN_TITLE } from './gpuUsageText.js';
import { tb } from './shared.jsx';
import { reclaimStorage } from './wasteViewText.js';
import { reclaimMeta } from '../toolsReportText.js';
import { samplerWithheldNote, normalizeWithheld } from '../samplerWithheldText.js';

const src = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('E-12 GPU VRAM — 카드가 VRAM 을 보고하지 않으면 0 GB 가 아니다', () => {
  it('vramText: null·빈 값은 —, 보고된 0 은 0 GB', () => {
    expect(vramText(null)).toBe('—'); expect(vramText(undefined)).toBe('—'); expect(vramText('')).toBe('—');
    expect(vramText(0)).toBe('0 GB'); expect(vramText(45)).toBe('45 GB'); expect(vramText(47.6)).toBe('48 GB');
  });
  it('vramTitle: 전부 미보고면 안내, 일부면 최대값 기준 + 미보고 수, 전부 읽었으면 빈 문자열', () => {
    expect(vramTitle({ memGB: null })).toBe(VRAM_UNKNOWN_TITLE);
    expect(vramTitle({ memGB: null, memUnknownHosts: 3 })).toBe(VRAM_UNKNOWN_TITLE);
    expect(vramTitle({ memGB: 48, memUnknownHosts: 2 })).toMatch(/호스트 2대는 VRAM 을 보고하지 않았습니다/);
    expect(vramTitle({ memGB: 48, memUnknownHosts: 0 })).toBe('');
    expect(vramTitle(null)).toBe('');
  });
  it('GpuTool.jsx 는 memGB 를 0 으로 접지 않고 vramText 로 그린다(소스)', () => {
    const s = src('./GpuTool.jsx').replace(/\/\/[^\n]*/g, '');
    expect(s).not.toMatch(/memGB \|\| 0/);
    expect(s).not.toMatch(/\$\{r\.memGB\} GB/);
    expect(s).toMatch(/vramText\(r\.memGB\)/);
    expect(s).toMatch(/memUnknownHosts\+\+/);
  });
  it('문구에 백틱이 없다', () => {
    expect(VRAM_UNKNOWN_TITLE.includes('`')).toBe(false);
    expect(vramTitle({ memGB: 1, memUnknownHosts: 1 }).includes('`')).toBe(false);
  });
});

describe('C-01 VM 스토리지 결측 — 합계 문구·단위', () => {
  it('shared.tb: null 은 —(단위 없음), 0 은 0 GB', () => {
    expect(tb(null)).toBe('—'); expect(tb(undefined)).toBe('—'); expect(tb('')).toBe('—');
    expect(tb(0)).toBe('0 GB'); expect(tb(512)).toBe('512 GB'); expect(tb(2048)).toBe('2.0 TB');
  });
  it('ToolsReports.tb 도 null 을 —(소스)', () => {
    const s = src('../ToolsReports.jsx');
    expect(s).toMatch(/const tb = \(gb\) => \{ const n = numOrNull\(gb\)/);
  });
  it('reclaimMeta: 용량 미상 정지 VM 수를 말한다(없으면 예전 문장 그대로)', () => {
    expect(reclaimMeta({})).toBe('정지 VM 디스크 + 정지 VM 에 속하지 않은 스냅샷 델타');
    expect(reclaimMeta({ poweredOffStorageUnknown: 2 })).toMatch(/용량 미상 정지 VM 2대 제외$/);
    expect(reclaimMeta({ snapshotInPoweredOffGB: 60, poweredOffStorageUnknown: 1 })).toMatch(/겹친 60 GB 제외\) · 용량 미상 정지 VM 1대 제외/);
    expect(reclaimMeta({ poweredOffStorageUnknown: 0 })).not.toMatch(/미상/);
  });
  it('wasteViewText.reclaimStorage: 서버가 뺀 VM 수를 싣는다(없으면 0)', () => {
    const r = reclaimStorage({ poweredOff: { storageGB: 100, storageUnknown: 2 }, thinReclaim: { reclaimableGB: 50, count: 3, uncommittedUnknown: 1 } });
    expect(r.offUnknown).toBe(2); expect(r.thinUnknown).toBe(1);
    expect(reclaimStorage({ poweredOff: { storageGB: 100 } }).offUnknown).toBe(0);
  });
  it('samplerWithheldNote: 결측으로 뺀 VM·DS 수를 말한다(lastRun 원본·sampler 요약 둘 다)', () => {
    expect(normalizeWithheld({ at: 1, vmStorageUnknown: 2, dsUsedUnknown: 1 }).vmStorageUnknown).toBe(2);
    expect(normalizeWithheld({ staleVcenters: 0, vmStorageUnknown: 3, dsUsedUnknown: 0 }).vmStorageUnknown).toBe(3);
    const t = samplerWithheldNote({ at: 1, rows: 3, vmStorageUnknown: 2, dsUsedUnknown: 1 });
    expect(t).toMatch(/스토리지 용량을 읽지 못한 VM 2대는 VM 디스크 계열/);
    expect(t).toMatch(/0 으로 채우지 않았습니다/);
    expect(t).toMatch(/데이터스토어 1개는 용량·사용 계열에서 뺐습니다/);
    expect(samplerWithheldNote({ at: 1, rows: 3, hostsWithTemp: 2 })).toBe(null);
  });
  it('합계 화면 5곳이 뺀 VM 수를 한 줄로 말한다(소스)', () => {
    expect(src('../Summary.jsx')).toMatch(/al\.vmStorageUnknown/);
    expect(src('./DiskTrend.jsx')).toMatch(/b\.vm\.storageUnknown/);
    expect(src('./CapacityTools.jsx')).toMatch(/data\.poweredOff\.storageUnknown/);
    expect(src('../Vms.jsx')).toMatch(/t\.storageUnknown/);
    expect(src('../Explore.jsx')).toMatch(/totals\.storageUnknown/);
    expect(src('./GuestOsTools.jsx')).toMatch(/r\.diskGB == null/);
  });
});
