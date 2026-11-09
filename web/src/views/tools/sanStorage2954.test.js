/**
 * sanStorage2954.test.js — v2.954 SAN 스토리지 성능 3차(점검 이력 모달 · 임의 구간 · ⌘K/Flow 인계 · 보고서 PDF)의 순수 계산 · 소스 규약.
 *  ① reportPdfDoc — 문서 모델(머리 · 블록 순서 · 표 열 수 = 2 + 항목 + 1) · 임베드 글꼴 밖 글자(✕) 없음 · 값 없으면 '—'
 *  ② 소스 규약 — 인계는 URL 이 아니라 handoffMany/useSearchHandoff · 해시에 ?targets= 금지 · 임의 구간 입력 · 이력 모달 available:false 표시 · PDF 는 reportExport 동적 import
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as T from './sanStorageText.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(HERE, rel), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');

const MODEL = {
  monthLabel: '2026-10', generatedAt: Date.UTC(2026, 10, 9, 2, 0, 0), portal: '',
  totals: { arrays: 2, nowBps: 2.06e9, imbalance: 1, unmeasured: 0 }, summary: { ok: 1, warn: 1, bad: 0, unknown: 0, partiallyUnchecked: 1 },
  items: [{ k: 'imbalance', label: '디렉터 편중' }, { k: 'portSat', label: '회선 포화' }, { k: 'dirBusy', label: '디렉터 busy' }],
  results: [
    { key: 'A', name: 'PMAX-1', dc: 'Ashburn 법인', vendor: 'PowerMax', overall: 'warn', uncheckedCount: 1, items: { imbalance: { status: 'warn' }, portSat: { status: 'ok' }, dirBusy: { status: 'unknown' } } },
    { key: 'B', name: 'UNITY-1', dc: 'Seoul 법인', vendor: 'Unity', overall: 'ok', uncheckedCount: 0, items: { imbalance: { status: 'ok' }, portSat: { status: 'ok' }, dirBusy: { status: 'na' } } },
  ],
  findings: [{ name: 'PMAX-1', dc: 'Ashburn 법인', item: 'imbalance', status: 'warn', text: 'FA-1D 1.48×' }],
  arraySide: { withValues: 1, total: 2 }, byDc: [{ dc: 'Ashburn 법인', arrays: 1, warn: 1, ok: 0, bad: 0, unknown: 0 }, { dc: 'Seoul 법인', arrays: 1, ok: 1, warn: 0, bad: 0, unknown: 0 }],
  top: [{ name: 'PMAX-1', dc: 'Ashburn 법인', avg24: 1.1e9, peak24: 2.2e9, utilPct: 4.5, delta7d: -1 }],
  thresholds: [{ label: '디렉터 busy — 이상(PowerMax)', value: 70, unit: '%', source: 'Unisphere 10.0 critical 70', userSet: false }, { label: '응답 시간 — 주의', value: null, unit: 'ms', source: '비움', userSet: false }],
};

describe('① reportPdfDoc', () => {
  it('문서 모델 · 표 열 · 글꼴 밖 글자 없음', () => {
    const d = T.reportPdfDoc(MODEL);
    expect(d.title).toBe('2026-10 SAN 스토리지 성능 월간 점검');
    expect(d.blocks.map((b) => b.type)).toEqual(['kvrow', 'note', 'heading', 'table', 'heading', 'table', 'heading', 'table', 'note', 'heading', 'table', 'heading', 'table']);
    const judge = d.blocks[7];
    expect(judge.columns.length).toBe(2 + MODEL.items.length + 1);
    expect(judge.rows[0].map((c) => c.text)).toEqual(['Ashburn 법인', 'PMAX-1', '▲', '●', '?', '▲ 주의 (미확인 1)']);
    expect(judge.rows[1][4].text).toBe('—');
    const json = JSON.stringify(d);
    expect(json).not.toMatch(/✕/);   // U+2715 는 Pretendard KS X 1001 서브셋에 없다 — × 로 쓴다
    expect(T.PDF_MARK.bad).toBe('×');
    const thr = d.blocks[12];
    expect(thr.rows.map((r) => r[1].text)).toEqual(['70%', '비움(판정 안 함)']);
    expect(T.reportPdfDoc({}).blocks.some((b) => b.type === 'note' && /항목이 없습니다/.test(b.text))).toBe(true);
    expect(T.reportPdfDoc({}).title).toBe('SAN 스토리지 성능 월간 점검');
  });
});

describe('② 소스 규약', () => {
  it('인계 · 임의 구간 · 이력 모달 · PDF', () => {
    const tool = strip(read('./SanStorageTool.jsx'));
    expect(tool).toMatch(/useSearchHandoff\('san-storage', setQ\)/);
    expect(tool).toMatch(/handoffMany\(\[\['san-flow:targets', w\.join\(','\)\]\]\)/);
    expect(tool).not.toMatch(/#\/tools\/san-flow\?/);                      // 도구 라우터는 해시의 ? 를 모른다
    expect(tool).toMatch(/type="datetime-local"[^\n]*aria-label="시작"/); expect(tool).toMatch(/type="datetime-local"[^\n]*aria-label="끝"/);
    expect(tool).toMatch(/366 \* 86_400_000/);
    expect(tool).toMatch(/custom \? \{ from: custom\.from, to: custom\.to \} : rangeQuery\(rangeK, \{ back \}\)/);
    expect(tool).toMatch(/href="#\/tools\/storage-paths"/);
    expect(tool).toMatch(/hours: 168, points: 168 \}/);   // 7일 히트맵은 1시간 칸 — 2시간 칸이면 기준선이 안 붙는다
    const check = strip(read('./SanStorageCheck.jsx'));
    expect(check).toMatch(/function HistoryModal\(/); expect(check).toMatch(/\/tools\/san-storage\/check\/history/);
    expect(check).toMatch(/!ov\.available && <div className="sst-info">이력 DB 를 열지 못했습니다/);
    expect(check).toMatch(/await import\('\.\/reportExport\.js'\)/); expect(check).toMatch(/reportPdfDoc\(d\.model\)/);
    expect(check).toMatch(/\.replace\(\/\\\.html\$\/i, '\.pdf'\)/);
    expect(check).not.toMatch(/<table[\s>]/); expect(check).not.toMatch(/window\.open\(/);
    const flow = strip(read('./SanFlowTool.jsx'));
    expect(flow).toMatch(/useSearchHandoff\('san-flow:targets', setPre\)/);
    const pal = strip(read('../../components/Palette.jsx'));
    expect(pal).toMatch(/SAN 스토리지 성능에서 ‘\$\{term\}’ 찾기/); expect(pal).toMatch(/lockOf\('san-storage'\)/);
    const q = read('../../components/invSearchQuery.js');
    expect(q).toMatch(/EXTRA_HANDOFF_TARGETS = Object\.freeze\(\['san-storage', 'san-flow:targets'\]\)/);
    const css = read('./sanStorage.css');
    expect(css).toMatch(/\.sst-custom \{[^}]*flex-wrap: wrap/); expect(css).toMatch(/\.sst-link \{/);
  });
});
