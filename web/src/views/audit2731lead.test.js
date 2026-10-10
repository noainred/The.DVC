// v2.731 점검 1회차 — 리드 통합분(웹).
//  ① 표 정렬값에 음수 sentinel 을 쓰지 않는다(I-01 이후 음수는 진짜 값으로 읽혀 결측이 오름차순 맨 앞에 온다 — DataTable 은 null 을 언제나 뒤로 보낸다).
//  ② GPU 내보내기 창의 vCenter 목록 조회 실패를 빈 선택지로 숨기지 않는다.
//  ④ VM 가용성 표 — 수집이 멈춰 측정 끝을 자른 VM(tailCut)은 행이 '어디까지 쟀는지' 를 말한다(A2-01 의 화면판).
//  ③ 서버 온도 'ESXi 호스트별' 보기가 서버가 오래됨으로 판정한 호스트(읽히지 않는 vCenter)에 표지를 단다(A2-03 의 화면판).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../test/_stripComments.js';
import { tailCutText } from './bizreport/availText.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const walk = (d, out = []) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out); else if (/\.(js|jsx)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p);
  }
  return out;
};

describe('v2.731 리드 — 웹', () => {
  it('① sortValue 가 결측을 -1 같은 음수 sentinel 로 바꾸지 않는다(전수)', () => {
    const hits = [];
    for (const f of walk(SRC)) {
      const lines = stripComments(fs.readFileSync(f, 'utf8')).split('\n');
      lines.forEach((l, i) => { if (/sortValue:[^,]*\?\?\s*-\d/.test(l)) hits.push(`${path.relative(SRC, f)}:${i + 1}`); });
    }
    expect(hits).toEqual([]);
  });
  it('② GpuExportModal 의 /vcenters 조회는 실패를 상태로 남기고 화면이 말한다', () => {
    const s = stripComments(fs.readFileSync(path.join(SRC, 'views/tools/GpuTool.jsx'), 'utf8'));
    const body = s.slice(s.indexOf('export function GpuExportModal'));
    expect(body).not.toMatch(/fetchJson\('\/vcenters'\)[^;\n]*\.catch\(\(\) => \{\}\)/);
    expect(body).toMatch(/setVcsErr\(/);
    expect(body).toMatch(/vCenter 목록을 읽지 못했습니다/);
  });
  it('③ 서버 온도 호스트 보기 — stale 을 행에 싣고 이름 칸·히트맵 제목·표 머리가 말한다', () => {
    const s = stripComments(fs.readFileSync(path.join(SRC, 'views/tools/serverTemp/ServerTempBoard.jsx'), 'utf8'));
    const host = s.slice(s.indexOf("if (view === 'host') {"), s.indexOf("const list = view === 'cluster'"));
    expect(host).toMatch(/stale: !!h\.stale/);
    expect(s).toMatch(/view === 'host' \? \[\s*\{ key: 'name', label: '호스트', render: \(r\) => \(r\.stale/);
    expect(s).toMatch(/h\.stale \? ' · 오래된 값/);
    expect(s).toMatch(/view === 'host' && data\.staleHosts/);
  });
  it('④ VM 가용성 — tailCutText 는 tailCut 행에만, 측정 끝 시각을 말한다 · 화면이 그 문구를 그린다', () => {
    expect(tailCutText({ tailCut: false, windowTo: 5 })).toBe(null);
    expect(tailCutText(null)).toBe(null);
    expect(tailCutText({ tailCut: true, windowTo: 1000 }, () => 'T')).toBe('수집 멈춤 — T 까지만 잼');
    expect(tailCutText({ tailCut: true, windowTo: null })).toBe('수집 멈춤 — 멈춘 시각까지만 잼');
    const s = stripComments(fs.readFileSync(path.join(SRC, 'views/tools/VmAvailabilityTool.jsx'), 'utf8'));
    expect(s).toMatch(/v\.tailCut && <div[^>]*>\{tailCutText\(v\)\}/);
  });
});
