/**
 * 베어메탈 사용률 — 다음 작업(2026-11-19) 그룹 B 웹 쪽 고정(서버 쪽은 server/test/bmUsageNextGb.test.js).
 *  ④ 데모 표시 경로: 서버가 준 표시 값(pathsShown · missingShown)을 장비 종류 칩 · 사용률 표 · CSV · 각주가 그대로 읽는다(판정 사본 없음 · 없으면 등록 값).
 *  ⑥ 스냅샷 표지: 새 이유 code(auth-unresolved · demo-target) 문구 · 엣지 대행 판정 근거 한 줄(시각은 API 값) · 실행 거절 사유 줄.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { facetRows, csvOf, missingFootnotes, shownPaths, shownMissing, pathsText } from './bmUsageText.js';
import { WRITE_WHY_TEXT, gateWhy } from './bmWriteText.js';
import { SNAP_CODE_TEXT, snapPathBasisNote } from './bmOpsText.js';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const src = (f) => fs.readFileSync(path.join(HERE, f), 'utf8');

describe('④ 데모 표시 경로 — 서버 값을 그대로', () => {
  const demo = { key: 'D1', name: 'demo-db01', vcenterId: 'vcA', paths: ['idrac'], missing: ['no-os-cred'], demoOs: true, pathsShown: ['idrac', 'os'], missingShown: [], src: 'os+idrac+demo', cpu_pct: 41 };
  const real = { key: 'R1', name: 'real-01', vcenterId: 'vcA', paths: ['idrac'], missing: ['no-os-cred'], src: 'idrac', cpu_pct: 12 };
  it('칩 · 표 · CSV · 각주가 같은 값(데모는 표시 값 · 실운영은 등록 값)', () => {
    expect(facetRows([demo, real]).map((r) => r.type)).toEqual(['idrac+os', 'idrac']);
    expect(shownPaths(demo)).toEqual(['idrac', 'os']); expect(shownPaths(real)).toEqual(['idrac']);
    expect(shownMissing(demo)).toEqual([]); expect(shownMissing(real)).toEqual(['no-os-cred']);
    expect(pathsText(demo)).toBe('iDRAC·OS'); expect(pathsText(real, '+')).toBe('iDRAC');
    const csv = csvOf([demo, real]).split(/\r?\n/);
    expect(csv[1]).toContain('iDRAC+OS'); expect(csv[1]).not.toContain('no-os-cred');
    expect(csv[2]).toContain('no-os-cred');
    expect(missingFootnotes([demo]).length).toBe(0);
    expect(missingFootnotes([demo, real]).some((x) => x.includes('OS 계정 없음'))).toBe(true);
  });
  it('표시 값이 없으면 예전 그대로(paths · missing) · 사용률 표는 같은 함수를 쓴다(소스)', () => {
    expect(shownPaths({})).toEqual([]); expect(shownMissing({ missing: null })).toEqual([]);
    const ui = src('BmUsage.jsx');
    expect(ui).toMatch(/data-sort=\{shownPaths\(r\)\.join\(','\)\}/);
    expect(ui).toMatch(/missingMark\(shownMissing\(r\)\)/);
    expect(ui).not.toMatch(/\(r\.paths \|\| \[\]\)/);
  });
});

describe('⑥ 스냅샷 표지 · 근거', () => {
  it('새 이유 code 문구(서버 WRITE_WHY · SNAPSHOT_CODES 와 1:1 은 bmLoop2 · bmOpsText 시험) · 백틱 없음', () => {
    for (const k of ['auth-unresolved', 'demo-target']) {
      expect(WRITE_WHY_TEXT[k]).toBeTruthy(); expect(SNAP_CODE_TEXT[k]?.text).toBeTruthy();
      expect(WRITE_WHY_TEXT[k].includes('`')).toBe(false); expect(SNAP_CODE_TEXT[k].text.includes('`')).toBe(false);
    }
    expect(gateWhy({ ok: false, why: 'auth-unresolved' })).toMatch(/참조를 해석하지 못해/);
    expect(gateWhy({ ok: false, why: 'demo-target' })).toMatch(/데모 합성/);
  });
  it('엣지 대행만 근거 한 줄 — 시각은 API 값 · 이 노드는 빈 글', () => {
    expect(snapPathBasisNote({ via: 'local' })).toBe('');
    expect(snapPathBasisNote(null)).toBe('');
    const at = new Date(2026, 10, 19, 14, 5).getTime();
    const t = snapPathBasisNote({ via: 'edge', at });
    expect(t).toMatch(/엣지 보관분\(2026-11-19 14:05 가져옴\) 기준/); expect(t).toMatch(/지금 가져오기/); expect(t.includes('`')).toBe(false);
    expect(snapPathBasisNote({ via: 'edge', at: null })).toMatch(/가져온 시각 모름/);
    const tab = src('BmSnapshotTab.jsx');
    expect(tab).toMatch(/snapPathBasisNote\(list\.resp\?\.pathBasis\)/);
    expect(tab).toMatch(/SNAP_REASON_CODES = Object\.freeze\(\[[^\]]*'auth-unresolved'/);
  });
});
