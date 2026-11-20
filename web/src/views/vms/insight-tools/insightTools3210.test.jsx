// v3.21.0 — VM 분석 화면 특수 기능 패널 · ‘과할당’ · ‘확인할 것’ 도구 칸: 권한 없을 때 숨김(요청도 없음) · 요약 칸 공유 · 늦은 응답 버림 · 소스 규약.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { stripComments } from '../../../test/_stripComments.js';

const calls = [];
let pending = [];
vi.mock('../../../api.js', async (orig) => {
  const real = await orig();
  return {
    ...real,
    fetchJson: (p, q, signal, opts) => {
      calls.push({ p, q, opts });
      return new Promise((resolve, reject) => { pending.push({ resolve, reject, p }); });
    },
  };
});

const { default: VmToolPanels, panelsFor, PANEL_TOOLS } = await import('./VmToolPanels.jsx');
const { default: VmOverView } = await import('./VmOverView.jsx');
const { buildToolChecks, checkItems } = await import('./vmToolChecks.js');
const { _internals, _resetToolSummaryCells } = await import('./useToolSummary.js');

beforeEach(() => { calls.length = 0; pending = []; _resetToolSummaryCells(); });

const here = path.dirname(fileURLToPath(import.meta.url));
const files = fs.readdirSync(here).filter((f) => /\.(jsx?|css)$/.test(f) && !/\.test\./.test(f));
const src = (f) => stripComments(fs.readFileSync(path.join(here, f), 'utf8'));

describe('권한 없는 도구의 패널 · 칸은 숨긴다(§6 ⑪)', () => {
  it('panelsFor — 권한 있는 패널만 · 추이는 두 도구 중 하나라도', () => {
    expect(panelsFor('capacity', () => true)).toEqual(['disk', 'off', 'trend']);
    expect(panelsFor('capacity', (k) => k === 'vm-lifecycle')).toEqual(['trend']);
    expect(panelsFor('capacity', (k) => k === 'waste')).toEqual(['off']);
    expect(panelsFor('perf', () => false)).toEqual([]);
    expect(panelsFor('config', (k) => k === 'vm-hygiene')).toEqual(['hygiene']);
    expect(panelsFor('capacity', () => true, ['off'])).toEqual(['off']);
    expect(panelsFor('nope', () => true)).toEqual([]);
    expect(panelsFor('capacity', undefined)).toEqual([]);
  });
  it('패널 → 도구 키는 카탈로그에 실재한다', async () => {
    const { TOOLS } = await import('../../specialToolsList.js');
    for (const ks of Object.values(PANEL_TOOLS)) for (const k of ks) expect(TOOLS.some((t) => t.k === k)).toBe(true);
  });
  it('canTool 이 모두 거짓이면 아무것도 그리지 않는다', () => {
    for (const g of ['capacity', 'perf', 'config']) expect(renderToStaticMarkup(<VmToolPanels vcIds={[]} rows={[]} group={g} canTool={() => false} />)).toBe('');
    expect(renderToStaticMarkup(<VmOverView vcIds={[]} rows={[]} canTool={() => false} />)).toBe('');
  });
  it('허용된 패널은 받는 중 자리부터 그린다(다른 패널을 기다리지 않는다)', () => {
    const html = renderToStaticMarkup(<VmToolPanels vcIds={[]} rows={[]} group="capacity" canTool={(k) => k === 'guest-partition'} />);
    expect(html).toContain('디스크가 차 가는 VM');
    expect(html).not.toContain('꺼진 VM');
    expect(html).toMatch(/받는 중/);
    const over = renderToStaticMarkup(<VmOverView vcIds={[]} rows={[]} canTool={(k) => k === 'waste'} />);
    expect(over).toContain('과할당');
  });
  it('확인할 것 — 권한 있는 도구 칸만 · 못 받았으면 —', () => {
    expect(buildToolChecks({ canTool: () => false })).toEqual([]);
    const only = buildToolChecks({ canTool: (k) => k === 'waste', waste: { loading: true } });
    expect(only.map((x) => x.key)).toEqual(['powered-off']);
    expect(only[0].value).toBe('—');
    expect(only[0].sub).toBe('받는 중…');
    expect(only[0].href).toBe('#/tools/waste/off');
    const gp = { data: { rows: [{ vcenterId: 'a', overVms: 4, crit: 1, soon: 2 }], thresholds: { soonDays: 30, overBinEdges: [85, 90, 95] } } };
    const both = buildToolChecks({ canTool: () => true, gp, waste: { error: new Error('x') } });
    expect(both[0]).toMatchObject({ key: 'disk-filling', value: '4', tone: 'crit', sub: '위험 1 · 30일 안 가득 2' });
    expect(both[1].sub).toBe('받지 못했습니다');
    expect(typeof checkItems).toBe('function');
  });
});

describe('요약 칸 — summary=1 · 옵션은 넷째 자리 · 늦게 온 이전 응답은 버린다', () => {
  it('두 번 받으면 첫 응답이 늦게 와도 둘째 값이 남는다', async () => {
    const c = _internals.cellOf('/tools/contention', null, { timeoutMs: 60000, retries: 0 });
    const seen = [];
    c.subs.add((st) => seen.push(st));
    _internals.load(c);
    _internals.load(c);
    expect(calls).toHaveLength(2);
    expect(calls[0].q).toEqual({ summary: '1' });
    expect(calls[0].opts).toEqual({ timeoutMs: 60000, retries: 0 });
    pending[1].resolve({ v: 2 });
    await new Promise((r) => setTimeout(r, 0));
    pending[0].resolve({ v: 1 });
    await new Promise((r) => setTimeout(r, 0));
    expect(c.st.data).toEqual({ v: 2 });
    expect(c.st.loading).toBe(false);
  });
  it('다시 받기가 실패해도 이전 값은 남는다(값 + 실패 안내)', async () => {
    const c = _internals.cellOf('/tools/vm-hygiene', null, {});
    _internals.load(c);
    pending[0].resolve({ ok: 1 });
    await new Promise((r) => setTimeout(r, 0));
    _internals.load(c);
    pending[1].reject(new Error('boom'));
    await new Promise((r) => setTimeout(r, 0));
    expect(c.st.data).toEqual({ ok: 1 });
    expect(c.st.error?.message).toBe('boom');
  });
  it('같은 경로 · 쿼리는 같은 칸(패널과 확인할 것 칸이 한 요청을 나눠 본다)', () => {
    expect(_internals.cellOf('/tools/waste', null)).toBe(_internals.cellOf('/tools/waste', null));
    expect(_internals.cellOf('/tools/waste', { a: 1 })).not.toBe(_internals.cellOf('/tools/waste', null));
  });
});

describe('소스 규약', () => {
  it('주기 폴링이 없다(마운트 1회 + 다시 받기) · usePolling 을 쓰지 않는다', () => {
    for (const f of files) {
      const s = src(f);
      expect(s, f).not.toMatch(/setInterval\(|usePolling\(/);
    }
  });
  it('화면 문구에 백틱 · 대문자 변환이 없다', () => {
    for (const f of files) {
      const s = src(f);
      expect(s, f).not.toMatch(/text-transform:\s*uppercase|textTransform:\s*['"]uppercase/);
      if (/\.jsx$/.test(f)) {
        // JSX 글자 노드 · 따옴표 문자열 안의 백틱(템플릿 문자열 자체는 코드라 허용)
        expect(s, f).not.toMatch(/>[^<{]*`[^<{]*</);
      }
    }
  });
  it('fetchJson 옵션(timeoutMs · retries)을 둘째 자리(쿼리)에 넣지 않는다', () => {
    for (const f of files) expect(src(f), f).not.toMatch(/fetchJson\([^,]+,\s*\{[^}]*(timeoutMs|retries)/);
  });
  it('기준값을 화면에 박지 않는다 — 판정 숫자(80 · 95 · 20 · 40 · 90)를 글자로 쓰지 않는다', () => {
    for (const f of files.filter((x) => /\.jsx$/.test(x))) {
      const s = src(f).replace(/width:\s*'\d+%'/g, '');   // 열 폭(배치)은 기준값이 아니다
      expect(s, f).not.toMatch(/['‘`(\s](80|95|20|40|90)\s*%/);
      expect(s, f).not.toMatch(/(30|7)일 안/);
    }
  });
});

describe('리뷰 정정 — 로그아웃 · 계정 전환이면 요약 칸을 비운다(모듈 변수가 이전 계정의 범위 · 권한으로 받은 값을 들고 있다)', () => {
  it('clearToolSummaryCells — 값 · 칸을 지우고 진행 중 요청의 늦은 응답을 버린다', async () => {
    const { clearToolSummaryCells, _toolSummaryCellInfo } = await import('./useToolSummary.js');
    const c = _internals.cellOf('/tools/waste', null, {});
    const p1 = _internals.load(c);
    pending[0].resolve({ rows: [{ vcenterId: 'secret-vc' }] });
    await p1;
    expect(_toolSummaryCellInfo('/tools/waste').st.data.rows[0].vcenterId).toBe('secret-vc');
    const seen = [];
    c.subs.add((st) => seen.push(st));
    const p2 = _internals.load(c);                       // 다시 받는 중에 계정이 바뀐다
    clearToolSummaryCells();
    expect(_toolSummaryCellInfo('/tools/waste')).toBeNull();
    expect(seen.at(-1)).toMatchObject({ data: null, error: null, loading: false });   // 아직 붙은 화면에도 빈 상태
    pending[1].resolve({ rows: [{ vcenterId: 'late' }] });
    await p2;
    expect(c.st.data).toBeNull();                        // 늦은 응답은 버린다
  });
  it('accountReset.noteAccount 가 계정이 바뀔 때 부른다', () => {
    const s = stripComments(fs.readFileSync(path.join(here, '../../../accountReset.js'), 'utf8'));
    expect(s).toMatch(/import \{ clearToolSummaryCells \} from '\.\/views\/vms\/insight-tools\/useToolSummary\.js'/);
    const body = s.slice(s.indexOf('export function noteAccount'), s.indexOf('export function tokenChangeAction'));
    expect(body).toMatch(/closeAllSessions\(\);\s*clearToolSummaryCells\(\);/);
  });
  it('‘모두 보기 →’ 는 받는 쪽 없는 인계를 남기지 않는다', () => {
    expect(src('ToolParts.jsx')).not.toMatch(/handoffSearch|handoffMany/);
  });
});
