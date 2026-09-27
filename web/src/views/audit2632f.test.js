/**
 * v2.632 그룹 F(웹 표시) 회귀 — WEB2632-03..07 + data-sort `?? 0` 5곳.
 * 판정은 순수 모듈로, 화면 파일은 주석을 뗀 소스로 본다(웹 테스트는 DOM 이 없다).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../test/_stripComments.js';
import { topOmittedNote } from './topOmittedText.js';
import { dsOptionLabel } from './tools/vmCloneDsText.js';
import { forecastCapNote } from './toolsReportText.js';
import { licenseDupNote } from './tools/licenseScopeText.js';
import { physicalServersKpi } from './vcCardText.js';
import { infraTotals } from '../version_5/overviewData.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (rel) => stripComments(fs.readFileSync(path.join(here, rel), 'utf8'));

describe('WEB2632-03 인사이트 트리 — 결측 사용률을 0% 로 그리지 않는다', () => {
  it('Insights.jsx 는 node.cpuPct/memPct 를 unitText 로 그린다', () => {
    const s = src('Insights.jsx');
    expect(s).not.toMatch(/\$\{node\.cpuPct\}%/);
    expect(s).not.toMatch(/\$\{node\.memPct\}%/);
    expect(s).toMatch(/unitText\(node\.cpuPct, '%'\)/);
  });
});

describe('WEB2632-04 용량 고갈 예측', () => {
  it('사용률 셀은 null% 를 만들지 않는다', () => {
    const s = src('ToolsReports.jsx');
    expect(s).not.toMatch(/`\$\{r\.usagePct\}%`/);
    expect(s).toMatch(/unitText\(r\.usagePct, '%'\)/);
    expect(s).toMatch(/forecastCapNote\(data\)/);
  });
  it('상한에 닿으면 말하고, 아니면 null · 개수를 지어내지 않는다', () => {
    expect(forecastCapNote({ datastoresCapped: true, listLimit: 100 })).toMatch(/상한\(100개\)/);
    expect(forecastCapNote({ datastoresCapped: true, listLimit: 100 })).toMatch(/더 있을 수 있습니다/);
    expect(forecastCapNote({ datastoresCapped: false, listLimit: 100 })).toBeNull();
    expect(forecastCapNote({})).toBeNull();
    expect(forecastCapNote(null)).toBeNull();
  });
});

describe('WEB2632-05 VM 복제 대상 DS — 여유 미상을 0TB 로 보이지 않는다', () => {
  it('freeGB null → 미상, usagePct null → 퍼센트 생략', () => {
    const t = dsOptionLabel({ name: 'ds1', freeGB: null, usagePct: null });
    expect(t).toBe('ds1 — 여유 —(미상)');
    expect(t).not.toMatch(/null|0TB/);
  });
  it('값이 있으면 예전 표기', () => {
    expect(dsOptionLabel({ name: 'ds2', freeGB: 2048, usagePct: 40 })).toBe('ds2 — 여유 2TB (40%)');
    expect(dsOptionLabel({ name: 'ds3', freeGB: 0, usagePct: 100 })).toBe('ds3 — 여유 0TB (100%)'); // 0 은 값이다
  });
  it('VmCloneTool 은 옛 인라인 표기를 쓰지 않는다', () => {
    const s = src('tools/VmCloneTool.jsx');
    expect(s).not.toMatch(/ds\.freeGB \|\| 0/);
    expect(s).toMatch(/dsOptionLabel\(ds\)/);
  });
});

describe('WEB2632-06 물리 서버 집계 실패를 없음·0 으로 보이지 않는다', () => {
  it('physicalServersKpi — error 면 실패라고 말한다', () => {
    expect(physicalServersKpi({ servers: 0, error: 'boom' })).toEqual({ value: null, note: '물리 서버 집계 실패' });
    expect(physicalServersKpi({ servers: 0 })).toEqual({ value: null, note: 'iDRAC 등록 없음' });
    expect(physicalServersKpi({ servers: 5 })).toEqual({ value: 5, note: null });
  });
  it('V5 infraTotals(전체) — error 면 null + 사유', () => {
    const base = { global: { vcenters: 1, hosts: 1, vms: 1, vmsPoweredOn: 1, datastores: 0 } };
    const r = infraTotals({ ...base, physical: { servers: 0, error: 'x' } });
    expect(r.physical).toBeNull();
    expect(r.physicalNote).toMatch(/읽지 못했습니다/);
    const ok = infraTotals({ ...base, physical: { servers: 0 } });
    expect(ok.physical).toBe(0);
    expect(ok.physicalNote).toBeNull();
  });
});

describe('WEB2632-07 서버가 싣는 제외·사유를 화면이 말한다', () => {
  it('topOmittedNote', () => {
    expect(topOmittedNote({ hostsByCpu: 3 }, 'hostsByCpu', 'host')).toMatch(/호스트 3대\(연결 끊김·무응답 포함\)/);
    expect(topOmittedNote({ datastoresByUsage: 2 }, 'datastoresByUsage', 'datastore')).toMatch(/데이터스토어 2개/);
    expect(topOmittedNote({}, 'hostsByCpu', 'host')).toBeNull();
    expect(topOmittedNote({ hostsByCpu: 0 }, 'hostsByCpu', 'host')).toBeNull();
    expect(topOmittedNote(undefined, 'x', 'vm')).toBeNull();
  });
  it('Explore 는 omitted 가 실리는 목록 전부에 문구를 넘긴다', () => {
    const s = src('Explore.jsx');
    for (const n of ['vmsByCpuUsage', 'vmsByMemUsage', 'vmsByStorage', 'hostsByCpu', 'hostsByMem', 'datastoresByUsage', 'vmsByVcpu', 'vmsByRam', 'hostsByVmCount']) {
      expect(s).toContain(`topOmittedNote(top.omitted, '${n}'`);
    }
  });
  it('DiskTrend 는 reclaimReason 을 그린다', () => {
    expect(src('tools/DiskTrend.jsx')).toMatch(/growth\.reclaimReason/);
  });
  it('licenseDupNote', () => {
    expect(licenseDupNote({ duplicateKeys: 4 })).toMatch(/4건은 제품별 합계에서 한 번만/);
    expect(licenseDupNote({ duplicateKeys: 0 })).toBeNull();
    expect(licenseDupNote({})).toBeNull();
    expect(src('tools/LicenseTools.jsx')).toMatch(/licenseDupNote\(data\)/);
  });
  it('문구에 백틱·별표가 새지 않는다', () => {
    const texts = [forecastCapNote({ datastoresCapped: true, listLimit: 100 }), licenseDupNote({ duplicateKeys: 1 }),
      topOmittedNote({ a: 1 }, 'a', 'vm'), dsOptionLabel({ name: 'n', freeGB: null })];
    for (const t of texts) { expect(t).not.toMatch(/`|\*\*/); }
  });
});

describe('data-sort — 값 없는 행을 0 으로 정렬하지 않는다(빈 값은 항상 뒤)', () => {
  it.each([
    'PerfMonitor.jsx', 'ApiKeys.jsx', 'tools/BmUsage.jsx', 'tools/CorpUsage.jsx', 'tools/DirUsageReport.jsx',
  ])('%s', (f) => {
    const s = src(f);
    expect(s).not.toMatch(/data-sort=\{[^}]*\?\? *0\}/);
    expect(s).not.toMatch(/data-sort=\{String\([^)]*\?\? *0\)\}/);
  });
});
