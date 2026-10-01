// v2.680 감사 D축 회귀 — 특수 기능 이름·단계 편집기 소거 방지(D-01) · GPU 출처·퍼센트 표기(D-02) ·
// 수집 점검 partial 문구(D-03) · 센서 상세 정렬 값(D-06) · 카테고리 저장 400(D-07).
// JSX 만 바뀐 것은 주석을 지운 소스 스윕으로 고정한다(web/src/test/_stripComments.js).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../test/_stripComments.js';
import { tempSubText, memSubText, memMainText, memPctSuffix } from './tools/gpuUsageText.js';
import { missingText, collectCheckGroups } from './tools/gpuWhyText.js';
import { detailSortValue, cpuSortValue } from './tools/serverTemp/sensorDetailText.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (rel) => stripComments(fs.readFileSync(path.join(here, rel), 'utf8'));

describe('D-01 이름·단계 편집기 — 못 읽은 설정으로 열거나 저장하지 않는다', () => {
  const st = src('SpecialTools.jsx');
  const ed = src('ToolNamesStages.jsx');
  it('특수 기능 화면은 설정 조회 상태를 들고 ⚙ 버튼을 그 상태로 잠근다', () => {
    expect(st).toMatch(/useState\('loading'\)/);
    expect(st).toMatch(/disabled=\{catsState !== 'ok'\}/);
    // 조회 실패를 조용히 삼키지 않는다 — 오류 상태로 바꾼다
    expect(st).toMatch(/\.catch\(\(e\) => \{[\s\S]{0,200}setCatsState\('error'\)/);
  });
  it('드로어는 읽은 설정으로만 렌더된다 — cats || {} 대체값 금지', () => {
    expect(st).not.toMatch(/settings=\{cats \|\| \{\}\}/);
    expect(st).toMatch(/drawer && catsState === 'ok' && cats &&/);
  });
  it('편집기 저장은 서버 설정(overrides 키)을 받았을 때만', () => {
    expect(ed).toMatch(/export function editorSettingsLoaded/);
    expect(ed).toMatch(/Object\.hasOwn\(settings, 'overrides'\)/);
    expect(ed).toMatch(/if \(!loaded\) \{[^}]*return; \}/);
    expect(ed).toMatch(/disabled=\{busy \|\| !loaded\}/);
  });
});

describe('D-07 카테고리 저장은 400 본문(ok:false)을 성공이라 말하지 않는다', () => {
  it('save() 가 r.ok === false 를 본다', () => {
    const tc = src('ToolCategories.jsx');
    const body = tc.slice(tc.indexOf('const save = async'), tc.indexOf('const save = async') + 800);
    expect(body).toMatch(/r\.ok === false\)[\s\S]{0,120}reason/);
    expect(body.indexOf('r.ok === false')).toBeLessThan(body.indexOf('저장되었습니다'));
  });
});

describe('D-02 GPU 온도·메모리 출처와 퍼센트', () => {
  it('ESXi 값은 게스트라 적지 않는다', () => {
    expect(tempSubText({ tempC: 55, tempSource: 'esxi' })).toMatch(/ESXi/);
    expect(tempSubText({ tempC: 55, tempSource: 'esxi' })).not.toMatch(/nvidia-smi/);
    expect(tempSubText({ tempC: 55, tempSource: 'guest' })).toMatch(/nvidia-smi/);
    expect(tempSubText({ tempC: null })).toMatch(/수집값 없음/);
    expect(memSubText({ memUsedMB: 2048, memSource: 'esxi', memVms: 0 })).toMatch(/ESXi/);
    expect(memSubText({ memUsedMB: 2048, memSource: 'esxi', memVms: 0 })).not.toMatch(/0대 합/);
    expect(memSubText({ memUsedMB: 2048, memSource: 'guest', memVms: 3 })).toBe('켜진 VM 3대 합');
    expect(memSubText({ memUsedMB: null, memUsedPct: null })).toMatch(/수집값 없음/);
  });
  it("값이 없으면 '%' 를 붙이지 않는다 — null% · (%) 금지", () => {
    expect(memMainText(20480, null, null)).not.toMatch(/null|%/);
    expect(memMainText(20480, null, null)).toMatch(/GB/);
    expect(memMainText(null, null, 37)).toBe('37%');
    expect(memMainText(null, null, null)).toBe('—');
    expect(memMainText(10240, 40960, 25)).toBe('10 / 40 GB');
    expect(memPctSuffix(10240, 40960, 25)).toBe(' (25%)');
    expect(memPctSuffix(10240, 40960, null)).toBe('');
    expect(memPctSuffix(10240, null, 25)).toBe('');
  });
  it('화면이 헬퍼를 쓴다(인라인 null% 금지)', () => {
    const hp = src('../components/HostGpuPanel.jsx');
    expect(hp).toMatch(/sub=\{tempSubText\(d\)\}/);
    expect(hp).toMatch(/sub=\{memSubText\(d\)\}/);
    expect(hp).not.toMatch(/\(\{d\.memUsedPct\}%\)/);
    const gt = src('tools/GpuTool.jsx');
    expect(gt).not.toMatch(/: `\$\{r\.memUsedPct\}%`/);
    expect(gt).not.toMatch(/data\.memUsedMB == null \? '—' : `\$\{data\.memUsedPct\}%`/);
  });
});

describe('D-03 수집 점검 — partial 은 ESXi 로 채웠다고 말하지 않는다', () => {
  const partial = { code: 'partial', vcenterId: 'vc1', hosts: 2, vms: 5, missing: { util: 0, mem: 0, temp: 0, all: 0, alloc: 0 } };
  it('missing 이 전부 0 인 partial', () => {
    const t = missingText(partial);
    expect(t).not.toMatch(/ESXi 카운터로 채웠/);
    expect(t).toMatch(/게스트 값으로 집계/);
  });
  it('partial 의 일부 결측도 ESXi 를 말하지 않는다', () => {
    const t = missingText({ ...partial, missing: { ...partial.missing, temp: 1 } });
    expect(t).toMatch(/온도 1대/);
    expect(t).not.toMatch(/ESXi 카운터로 채움/);
  });
  it('full 항목은 예전 문구 그대로', () => {
    expect(missingText({ ...partial, code: 'no-config' })).toMatch(/ESXi 카운터로 채웠/);
    const g = collectCheckGroups([partial], []);
    expect(g[0].entries[0].detail).not.toMatch(/ESXi 카운터로 채웠/);
  });
});

describe('D-06 센서 상세 정렬 — 칸이 — 이면 정렬 값도 null', () => {
  const ok = { detailState: 'ok', summary: { inletC: 22, exhaustC: 35, cpuTempMaxC: 60, gpuTempMaxC: 70, gpuTempCount: 2 } };
  const stale = { detailState: 'stale', summary: { inletC: 22, exhaustC: 35, cpuTempMaxC: 60, gpuTempMaxC: 70, gpuTempCount: 2 } };
  it('상세가 오래됐으면 null', () => {
    for (const f of ['inletC', 'exhaustC', 'cpuTempMaxC', 'gpuTempMaxC']) {
      expect(detailSortValue(ok, f)).not.toBeNull();
      expect(detailSortValue(stale, f)).toBeNull();
    }
    expect(detailSortValue({ detailState: 'ok', summary: { gpuTempMaxC: 70, gpuTempCount: 0 } }, 'gpuTempMaxC')).toBeNull();
    expect(detailSortValue({ detailState: 'ok', summary: {} }, 'inletC')).toBeNull();
  });
  it('CPU 는 값 없으면 null(-1 금지)', () => {
    expect(cpuSortValue({ cpu: { pct: null } })).toBeNull();
    expect(cpuSortValue({ cpu: { pct: 12 } })).toBe(12);
  });
  it('화면에 -999 · -1 대체값이 없다', () => {
    const v = src('tools/serverTemp/SensorDetailView.jsx');
    expect(v).not.toMatch(/\?\? -999/);
    expect(v).not.toMatch(/\?\? -1\b/);
  });
});
