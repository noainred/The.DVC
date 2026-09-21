import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  MODE_OFF, MODE_ALLOW, MODE_DENY, MODE_LABEL, modeHelp, overrideBadge,
  overrideByText, toolsPermWarning, enforcementGapNote, saveSummary, SECTION_NOTE,
  roleToolRows, ROLE_SECTION_NOTE, ADMIN_MARK_LABEL, ADMIN_MARK_TITLE_ROLE, ADMIN_MARK_TITLE_USER,
} from './userToolText.js';
import { TOOLS as SPECIAL_TOOLS } from '../specialToolsList.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 소스 검사 전에 주석을 지운다 — 규칙을 설명하는 주석이 통과 근거가 되면 안 된다(v2.535 규약).
 *  ⚠ 개행은 **보존**한다(지우면 줄 번호가 밀려 엉뚱한 줄을 지목한다 — v2.569 오탐). */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const ALL = ['storage-mon', 'ipam', 'ping', 'gpu'];
const levelOf = (k) => (k === 'ipam' || k === 'storage-mon' ? 'server' : 'declared');

describe('userToolText (v2.555)', () => {
  it('모드 라벨·설명이 셋 다 있다 — 화면이 하드코딩하지 않게', () => {
    for (const m of [MODE_OFF, MODE_ALLOW, MODE_DENY]) {
      expect(MODE_LABEL[m]).toBeTruthy();
      expect(modeHelp(m).length).toBeGreaterThan(10);
    }
  });

  it('배지 — 허용 0개는 "전면 차단" 으로 말한다(제한 없음으로 읽히면 최악의 거짓)', () => {
    expect(overrideBadge(null)).toMatchObject({ mode: MODE_OFF, text: '역할 기준' });
    expect(overrideBadge({ mode: MODE_ALLOW, tools: [] })).toMatchObject({ tone: 'bad', text: '특수기능 전면 차단' });
    expect(overrideBadge({ mode: MODE_ALLOW, tools: ['a', 'b'] }).text).toBe('허용 2개만');
    expect(overrideBadge({ mode: MODE_DENY, tools: ['a'] }).text).toBe('추가 차단 1개');
  });

  it('설정자·시각이 없으면 null — 지어내지 않는다', () => {
    expect(overrideByText(null)).toBe(null);
    expect(overrideByText({ mode: MODE_ALLOW, tools: [], by: '', at: 0 })).toBe(null);
    expect(overrideByText({ by: 'admin', at: 0 })).toContain('시각 미기록');
    expect(overrideByText({ by: 'admin', at: 1_700_000_000_000 })).toContain('admin');
  });

  it('★ tools 권한이 없으면 허용 목록이 무의미하다는 사실을 말한다(무음 실패 금지)', () => {
    const w = toolsPermWarning({ entry: { mode: MODE_ALLOW, tools: ['ipam'] }, hasToolsPerm: false, role: 'viewer' });
    expect(w).toContain('특수 기능');
    expect(w).toContain('viewer');
    // 권한이 있으면 경고하지 않는다(없는 문제를 만들지 않는다)
    expect(toolsPermWarning({ entry: { mode: MODE_ALLOW, tools: ['ipam'] }, hasToolsPerm: true })).toBe(null);
    // 재정의가 없거나 추가 차단 모드면 이 경고의 뜻이 없다
    expect(toolsPermWarning({ entry: null, hasToolsPerm: false })).toBe(null);
    expect(toolsPermWarning({ entry: { mode: MODE_DENY, tools: ['ipam'] }, hasToolsPerm: false })).toBe(null);
  });

  it('★ 허용 목록 모드에서 "고르지 않은 전부" 를 차단 대상으로 보고 서버 집행 공백을 센다', () => {
    const n = enforcementGapNote({ mode: MODE_ALLOW, tools: ['storage-mon'] }, ALL, levelOf);
    // 차단 대상 = ipam·ping·gpu 이고 그중 서버가 막는 것은 ipam → 공백 2개
    expect(n.count).toBe(2);
    expect(n.keys.sort()).toEqual(['gpu', 'ping']);
  });

  it('추가 차단 모드는 "고른 것" 만 차단 대상이다', () => {
    expect(enforcementGapNote({ mode: MODE_DENY, tools: ['ipam'] }, ALL, levelOf)).toBe(null); // ipam 은 서버가 막는다
    expect(enforcementGapNote({ mode: MODE_DENY, tools: ['ping'] }, ALL, levelOf).count).toBe(1);
    expect(enforcementGapNote(null, ALL, levelOf)).toBe(null);
  });

  it('저장 요약이 숨기는 개수를 말한다 · 허용 0개는 경고한다', () => {
    expect(saveSummary(MODE_ALLOW, ['a'], 4)).toContain('숨김 3개');
    expect(saveSummary(MODE_ALLOW, [], 4)).toContain('전부');
    expect(saveSummary(MODE_DENY, [], 4)).toContain('역할 기준');
    expect(saveSummary(MODE_OFF, [], 4)).toContain('지웁니다');
  });

  it('문구에 백틱이 없어야 한다 — BoldText 는 **강조** 만 해석한다(v2.553 규약)', () => {
    const texts = [
      SECTION_NOTE, ROLE_SECTION_NOTE, ADMIN_MARK_TITLE_ROLE, ADMIN_MARK_TITLE_USER,
      modeHelp(MODE_OFF), modeHelp(MODE_ALLOW), modeHelp(MODE_DENY),
      saveSummary(MODE_ALLOW, [], 3), saveSummary(MODE_DENY, [], 3), saveSummary(MODE_OFF, [], 3),
      toolsPermWarning({ entry: { mode: MODE_ALLOW }, hasToolsPerm: false, role: 'viewer' }),
      enforcementGapNote({ mode: MODE_ALLOW, tools: [] }, ALL, levelOf).text,
      ...Object.values(MODE_LABEL),
    ];
    for (const t of texts) expect(String(t)).not.toContain('`');
  });
});

/* ── v2.573 — 새 특수기능이 권한 화면에 자동으로 나온다 ───────────────────────
 * 사용자 지시: "특수기능이 추가되면 자동으로 권한설정 하는 기능에 추가되게 해줘".
 * v2.572 까지 역할 표가 `adminOnly` 를 걸러 카탈로그 86개 중 61개만 보였고, 빠진 25개는
 * 대부분 최근 추가분이었다 — 즉 기능을 더할수록 권한 화면이 뒤처졌다. 여기서 고정한다.  */
describe('역할별 도구 표는 카탈로그 전체다 (v2.573)', () => {
  it('roleToolRows 는 카탈로그를 거르지 않는다 — 실제 카탈로그로 확인', () => {
    const rows = roleToolRows(SPECIAL_TOOLS);
    expect(rows.length).toBe(SPECIAL_TOOLS.length);
    expect(rows.map((t) => t.k)).toEqual(SPECIAL_TOOLS.map((t) => t.k));
    // 핵심: adminOnly 도구가 반드시 들어 있어야 한다(그것이 예전에 빠지던 것들이다).
    const admins = SPECIAL_TOOLS.filter((t) => t.adminOnly).map((t) => t.k);
    expect(admins.length).toBeGreaterThan(0);
    for (const k of admins) expect(rows.some((t) => t.k === k)).toBe(true);
  });

  it('키가 없는 행만 뺀다 — 표에 그릴 수 없기 때문이다', () => {
    expect(roleToolRows([{ k: 'a' }, null, { label: '키없음' }, { k: '' }])).toEqual([{ k: 'a' }]);
    expect(roleToolRows(null)).toEqual([]);
    expect(roleToolRows()).toEqual([]);
  });

  it('UserAdmin.jsx 가 행을 다시 거르지 않는다 — 호출부에서 재발하는 것을 막는다', () => {
    const src = stripComments(fs.readFileSync(path.join(HERE, '../UserAdmin.jsx'), 'utf8'));
    expect(src).toMatch(/const TOOL_ROWS = roleToolRows\(SPECIAL_TOOLS\)/);
    // `SPECIAL_TOOLS.filter(...)` 형태가 하나라도 있으면 다시 걸러지고 있는 것이다.
    expect(src).not.toMatch(/SPECIAL_TOOLS\s*\.filter/);
    expect(src).not.toMatch(/TOOL_ROWS\s*\.filter/);
  });

  it('머리말이 "목록에서 제외" 라고 말하지 않는다 — 이제 제외하지 않는다', () => {
    expect(ROLE_SECTION_NOTE).not.toContain('제외');
    expect(ROLE_SECTION_NOTE).toContain('모든 도구');
    // adminOnly 가 접근제어가 아니라는 사실을 말해야 한다(v2.555 가 확인한 사실).
    expect(ROLE_SECTION_NOTE).toContain('접근제어가 아닙니다');
  });

  it('관리자 표시 배지는 두 화면이 같은 상수를 쓴다 — 말이 갈라지지 않게', () => {
    const src = stripComments(fs.readFileSync(path.join(HERE, '../UserAdmin.jsx'), 'utf8'));
    expect(src).toContain('ADMIN_MARK_TITLE_ROLE');
    expect(src).toContain('ADMIN_MARK_TITLE_USER');
    // 라벨 문자열을 JSX 에 다시 적으면 한쪽만 바뀐다.
    expect(src.match(/관리자 표시/g)).toBe(null);
    expect(ADMIN_MARK_LABEL).toBe('관리자 표시');
    // 두 뜻이 다르므로 문구도 달라야 한다(한 문구로 덮으면 반대 방향 안내가 된다).
    expect(ADMIN_MARK_TITLE_ROLE).not.toBe(ADMIN_MARK_TITLE_USER);
  });
});
