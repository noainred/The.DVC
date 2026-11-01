/**
 * views/tools/bareosTargetsWidth.test.js — Bareos 관리 도구 '백업 대상' 표가 1440px 에서 카드 안에 든다(v2.840 후속).
 *
 *  v2.840 까지: 표 최소폭 1160px · '작업' 칸 min-width 236px(실행 레벨 상자 168px 를 넣으려는 값) · VM 칸에 이름 + 배지 한 줄(nowrap)이라
 *  1440px(사이드바 펼침 — 표 래퍼 1154px)에서 표가 1202~1232px 로 넘쳐 '작업' 열(로그 · 삭제 버튼)이 잘렸다(audits.md 'Bareos v2.840' 남긴 것).
 *  고친 것: '작업' 칸 = 2열 × 3행 격자(폭 TARGET_ACT_W) · 실행 레벨 상자는 두 열을 가로지른다 · VM 배지는 이름 아래 줄에서 줄바꿈 · 표 최소폭 TARGET_TABLE_MINW.
 *
 *  Chromium 실측(목 서버 DATA_SOURCE=mock · 데모 대상 5개 · 같은 데이터에서 A/B):
 *    변경 전 1440 — 표 1216px · 래퍼 1154px(62px 넘침 · 5행 모두 작업 버튼 잘림) / 변경 후 — 표 1154px · 넘침 0 · 잘린 버튼 0 · 페이지 넘침 0(1440 · 400).
 *    변경 후 표의 min-content 폭 1039px = '작업' 칸 168px(격자 140 + 칸 여백 28) + 나머지 7열 871px.
 *    실행 레벨 상자의 가장 긴 선택지 '기본(Differential)' 은 12px 글꼴로 95px(캔버스 측정) — 상자 안쪽 여백 12px · 네이티브 화살표 약 20px.
 *  ⚠ 나머지 열 폭은 목 데이터 기준이다 — 운영의 VM · Director · vCenter 이름이 길면 그만큼 넓어진다(정직 기록). 여기서는 '작업' 칸과 최소폭이
 *    그 여유(1154 − 1039 = 115px)를 다시 먹지 않게, 그리고 레벨 상자가 선택지를 자르지 않게 두 쪽을 고정한다.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { TARGET_ACT_W, TARGET_TABLE_MINW } from './BareosBackupTool.jsx';
import { stripComments } from '../../test/_stripComments.js';

const WRAP_1440 = 1154;    // 표 래퍼(.table-wrap) clientWidth — 1440px · 사이드바 펼침
const OTHERS_MIN = 871;    // 나머지 7열 min-content 합(목 데이터)
const CELL_PAD = 28;       // 작업 칸 좌우 여백(168 − 140)
const SELECT_NEED = 95 + 12 + 20;   // 가장 긴 선택지 + 안쪽 여백 + 화살표

describe('백업 대상 표 — 1440px 에서 카드 안에 든다', () => {
  it('작업 칸(격자 + 여백) + 나머지 열의 최소 합이 1440px 래퍼 안이다', () => {
    expect(OTHERS_MIN + TARGET_ACT_W + CELL_PAD).toBeLessThanOrEqual(WRAP_1440);
  });
  it('표 최소폭(STable minWidth)이 1440px 래퍼보다 넓지 않다 — 최소폭만으로 넘치지 않게', () => {
    expect(TARGET_TABLE_MINW).toBeLessThanOrEqual(WRAP_1440);
    // 400px 에서는 이 최소폭이 칸을 지킨다(줄바꿈 칸이 머리글 폭으로 짜부라지지 않게) — 실측 min-content 보다 작으면 안 된다
    expect(TARGET_TABLE_MINW).toBeGreaterThanOrEqual(OTHERS_MIN + TARGET_ACT_W + CELL_PAD);
  });
  it('실행 레벨 상자(격자 폭)가 가장 긴 선택지를 자르지 않는다', () => {
    expect(TARGET_ACT_W).toBeGreaterThanOrEqual(SELECT_NEED);
  });
});

describe('백업 대상 표 — 화면 소스', () => {
  const src = stripComments(fs.readFileSync(new URL('./BareosBackupTool.jsx', import.meta.url), 'utf8'));
  const tab = src.slice(src.indexOf('function TargetsTab('), src.indexOf('function AddForm('));
  it('TargetsTab 구간을 찾았다', () => {
    expect(tab.length).toBeGreaterThan(1000);
  });
  it('표 최소폭은 상수 하나 · 작업 칸에 고정 min-width 가 없다', () => {
    expect(tab).toMatch(/<STable minWidth=\{TARGET_TABLE_MINW\} wrap=\{false\}>/);
    expect(tab).not.toMatch(/minWidth: 236/);
    expect(tab).not.toMatch(/width: 168/);
  });
  it('작업 칸 = 2열 격자 · 버튼은 칸을 채우고 전역 margin-left 를 지운다 · 레벨 상자는 두 열을 가로지른다', () => {
    expect(src).toMatch(/const ACT_GRID = \{ display: 'grid', gridTemplateColumns: 'repeat\(2, minmax\(0, 1fr\)\)', gap: 6, width: TARGET_ACT_W \};/);
    expect(src).toMatch(/const ACT_BTN = \{ \.\.\.BTN, width: '100%', marginLeft: 0 \};/);
    expect(tab).toMatch(/<div data-target-actions="" style=\{ACT_GRID\}>/);
    expect(tab).toMatch(/aria-label="실행 레벨"/);
    expect(tab).toMatch(/style=\{\{ gridColumn: '1 \/ -1', minWidth: 0, width: '100%', boxSizing: 'border-box'/);
    // 작업 칸의 버튼 9개(취소 · 시작 · 닫기 · 실행… · 결과 · 로그 · 복원… · 활성/비활성 · 삭제)는 모두 ACT_BTN 계열
    const actions = tab.slice(tab.indexOf('data-target-actions'), tab.indexOf('</STable>'));
    const btnStyles = [...actions.matchAll(/<button [^>]*style=\{([^}]*\}?)\}/g)].map((m) => m[1]);
    expect(btnStyles.length).toBe(9);
    for (const s of btnStyles) expect(s).toMatch(/ACT_BTN/);
  });
  it('VM 배지는 이름 아래 줄바꿈 상자 안 · 배지에 margin-left 가 남지 않았다', () => {
    expect(src).toMatch(/const VM_BADGES = \{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 \};/);
    const vm = tab.slice(tab.indexOf('<td data-sort={j.vmName}>'), tab.indexOf('<td data-sort={dirName(j.directorId)}'));
    expect(vm).toMatch(/<b>\{j\.vmName\}<\/b>\s*<div data-target-badges="" style=\{VM_BADGES\}>/);
    expect(vm).not.toMatch(/marginLeft/);
    for (const b of ['osLabel(osKey(j))', '비활성', 'Director 에 없음', '데모', '등록 뒤 바뀜']) expect(vm).toContain(b);
  });
});
