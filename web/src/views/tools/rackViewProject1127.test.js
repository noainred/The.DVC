// 랙 실장도 — 칸 목록 투영(2026-11-27)에 맞춘 화면 판정: 미배치 목록 · 연결된 서버 이름 줄 · 보이지 않는 칸만 바뀐 변경 · 가림 집계.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as V from './rackView.js';

const here = path.dirname(new URL(import.meta.url).pathname);
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const TOOL = strip(fs.readFileSync(path.join(here, 'RackTool.jsx'), 'utf8'));
const CENSUS = strip(fs.readFileSync(path.join(here, 'RackMaskCensus.jsx'), 'utf8'));

describe('미배치 서버 패널 — 목록은 관리자 응답에만 실린다', () => {
  it('unplacedListed 가 false 면 대수만(count) · 그 밖(옛 서버 포함)은 목록', () => {
    expect(V.unplacedMode({ unplaced: [], unplacedListed: false, unplacedTotal: 12 })).toBe('count');
    expect(V.unplacedMode({ unplaced: [{ serverId: 'a' }], unplacedListed: true, unplacedTotal: 1 })).toBe('list');
    expect(V.unplacedMode({ unplaced: [] })).toBe('list');      // 표식이 없는 응답(옛 서버) — 예전처럼 목록
    expect(V.unplacedMode(null)).toBe('list');
  });
  it('전산실 요약의 미배치 대수는 목록 길이가 아니라 서버가 센 수', () => {
    expect(V.roomSummary({ racks: [], places: [], unplaced: [], unplacedListed: false, unplacedTotal: 12 }).unplaced).toBe(12);
  });
  it('배선: 패널은 unplacedMode 로 갈라 그리고, 대수만일 때는 "받다 말았다" 안내를 그리지 않는다', () => {
    const i = TOOL.indexOf("unplacedMode(view) === 'list' ? (<>");
    const j = TOOL.indexOf('view.unplacedTotal > (view.unplaced || []).length');
    const k = TOOL.indexOf('미배치 서버의 목록(등록부 이름 · 서비스 태그)은 관리자에게만 보입니다');   // 2026-11-27: '편집할 수 있는' 은 실제 기준(관리자 여부)보다 좁게 말했다
    expect(i).toBeGreaterThan(0); expect(j).toBeGreaterThan(i); expect(k).toBeGreaterThan(j);
  });
});

describe('연결된 서버의 이름 줄 — 등록부 이름 · 호스트 이름은 관리자 응답에만', () => {
  it('두 키가 모두 없으면 줄을 그리지 않는다(null) · 키는 있는데 비었으면 —', () => {
    expect(V.linkNameText({ serverId: 'masked-x', model: 'R760' })).toBe(null);
    expect(V.linkNameText(null)).toBe(null);
    expect(V.linkNameText({ name: '', hostname: '' })).toBe('—');
    expect(V.linkNameText({ name: 'kr-esx-01', hostname: '' })).toBe('kr-esx-01');
    expect(V.linkNameText({ name: 'kr-esx-01', hostname: 'os-host' })).toBe('os-host');
  });
  it('배선: 상세 패널이 linkNameText 로 그린다(옛 식 `l.hostname || l.name` 을 직접 쓰지 않는다)', () => {
    expect(TOOL).toContain('linkNameText(l) != null');
    expect(TOOL).not.toContain("l.hostname || l.name || '—'");
  });
});

describe('판 차이 — 이 계정에 보이지 않는 칸만 바뀐 변경', () => {
  it('바뀐 칸 이름이 비어 오면 그 사실을 말한다(빈 글로 두지 않는다)', () => {
    expect(V.fieldsText([])).toBe('이 계정에 보이지 않는 칸');
    expect(V.fieldsText(undefined)).toBe('이 계정에 보이지 않는 칸');
    expect(V.fieldsText(['label', 'note'])).toBe('이름 · 메모');
  });
});

describe('메모 — 관리자 전용 표시', () => {
  it('배선: 고치기 창과 상세 패널이 메모가 관리자에게만 보인다고 밝힌다', () => {
    expect(TOOL).toContain('메모(관리자에게만 보입니다');
    expect(TOOL).toContain('<dt style={dt}>관리 메모</dt>');   // 2026-11-27 화면 D7: '메모(관리자 전용)' 은 84px 칸에서 단어 중간에 줄이 바뀌었다
  });
});

describe('가림 집계', () => {
  const resp = {
    fields: { label: { total: 10, addr: 2, tag: 1, firstLabel: 3, altIp: 0 }, model: { total: 4, addr: 0, tag: 0, firstLabel: 0, altIp: 1 } },
    sum: { total: 14, addr: 2, tag: 1, firstLabel: 3, altIp: 1 }, notes: 5,
  };
  it('censusRows: 칸마다 한 행 · 합계 · 타일 값', () => {
    const c = V.censusRows(resp);
    expect(c.rows.map((r) => r.field)).toEqual(Object.keys(V.CENSUS_FIELD_LABEL));
    expect(c.rows[0]).toMatchObject({ field: 'label', label: '표시 이름', total: 10, addr: 2, tag: 1, firstLabel: 3, altIp: 0 });
    expect(c.sum.total).toBe(14); expect(c.hidden).toBe(3); expect(c.wider).toBe(4); expect(c.notes).toBe(5);
  });
  it('못 읽은 값은 0 이 아니다 — 응답에 없는 칸 · 수가 아닌 값은 null', () => {
    const c = V.censusRows({ fields: { label: { total: '7', addr: null } }, sum: { total: 3, addr: 1 } });
    expect(c.rows[0].total).toBe(null); expect(c.rows[0].addr).toBe(null);
    expect(c.rows.find((r) => r.field === 'rackName').total).toBe(null);
    expect(c.hidden).toBe(null); expect(c.wider).toBe(null); expect(c.notes).toBe(null);
    expect(V.censusRows(null).sum.total).toBe(null);
  });
  it('걸린 종류 글', () => {
    expect(V.censusHitsText(['addr', 'firstLabel'])).toBe('주소 · 등록 주소의 첫 마디');
    expect(V.censusHitsText(['new-kind'])).toBe('new-kind'); expect(V.censusHitsText(null)).toBe('');
  });
  it('배선: 집계 창은 열 때 한 번만 부르고(폴링 없음) 늦은 응답을 버리며, 값이 없으면 — 로 그린다', () => {
    expect(CENSUS).toContain("fetchJson('/tools/rack/mask-census')");
    expect(CENSUS).not.toMatch(/setInterval|usePolling/);
    expect(CENSUS).toContain('my === seq.current');
    expect(CENSUS).toContain("v == null ? '—'");
    expect(CENSUS).toContain('<STable');
    expect(TOOL).toContain("tree.canEditTypes ? <button type=\"button\" style={btn} onClick={() => setModal({ kind: 'census' })}>가림 집계</button>");
  });
});

describe('2026-11-27 6회차 수정 — 되돌리기 미리 보기 자리 · 랙 머리글 · 기록 관리', () => {
  it('restoreMissingText: 조회 계정은 관리자에게만 보인다는 사실 · 관리자는 비교하지 못한 까닭(예전엔 둘 다 "—")', () => {
    expect(V.restoreMissingText(false)).toBe('되돌리기 미리 보기는 관리자에게만 보입니다.');
    expect(V.restoreMissingText(true)).toMatch(/^지금 원장과 비교하지 못했습니다/);
    expect(TOOL).toContain('restoreMissingText(isAdmin)');
    expect(TOOL).toContain('isAdmin={!!tree.isAdmin}');
    expect(TOOL).not.toMatch(/detail\.restore \? <>[^\n]*: <span[^>]*>—<\/span>/);
  });
  it('랙 머리글: 이름은 줄임표 + title · 사용 U 는 줄어들지 않는다(가린 이름이 넘쳐 사용 U 를 밀어냈다)', () => {
    expect(TOOL).toContain("<strong title={rack.name} style={{ ...mono, fontSize: 14, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', flex: '0 1 auto' }}>{rack.name}</strong>");
    expect(TOOL).toContain("<span style={{ fontSize: 11, color: 'var(--text-dim)', flexShrink: 0 }}>{rack.totalsStale");
  });
  it('seenKeyOf · forgetItemsOf: 종류와 값을 함께 키로 · 목록에 없는 키는 버린다', () => {
    const stale = [{ kind: 'h', key: 'a.example' }, { kind: 't', key: 'a.example' }, { kind: 't', key: 'TAG1' }];
    expect(V.seenKeyOf(stale[0])).not.toBe(V.seenKeyOf(stale[1]));
    const sel = new Set([V.seenKeyOf(stale[1]), V.seenKeyOf({ kind: 'h', key: 'gone.example' })]);
    expect(V.forgetItemsOf(stale, sel)).toEqual([{ kind: 't', key: 'a.example' }]);
    expect(V.forgetItemsOf(null, sel)).toEqual([]);
    expect(V.forgetItemsOf(stale, [V.seenKeyOf(stale[2])])).toEqual([{ kind: 't', key: 'TAG1' }]);
  });
  it('seenCapText: 상한의 90% 부터 경고 · 못 읽은 값은 null · 대기 · 메모리에만 수', () => {
    expect(V.seenCapText({ hosts: 10, tags: 20, max: 200000 })).toEqual({ text: '본 적 있는 주소 10 · 태그 20(종류마다 상한 200,000)', warn: false });
    expect(V.seenCapText({ hosts: 180000, tags: 1, max: 200000 }).warn).toBe(true);
    expect(V.seenCapText({ hosts: 179999, tags: 1, max: 200000 }).warn).toBe(false);
    expect(V.seenCapText({ hosts: 1, tags: 2, max: 9, pending: 3, overflow: 4 }).text).toBe('본 적 있는 주소 1 · 태그 2(종류마다 상한 9) · 파일에 쓰는 중 3 · 메모리에만 4');
    expect(V.seenCapText({ hosts: '1', tags: 2 })).toBe(null);
    expect(V.seenCapText(null)).toBe(null);
  });
  it('배선: 집계 창의 기록 관리 — 누를 때 한 번 · 늦은 응답 버림 · 지우기 전 확인 · 서버 연산 mask.forget', () => {
    expect(CENSUS).toContain("fetchJson('/tools/rack/mask-seen')");
    expect(CENSUS).toContain("postJson('/tools/rack/op', { op: 'mask.forget', items })");
    expect(CENSUS).toContain('window.confirm(');
    expect(CENSUS).toContain('const items = forgetItemsOf(list?.stale, sel);');
    expect(CENSUS).toContain("if (my === seq.current) { setList(r); setErr(null); setSel(new Set()); }");
    expect(CENSUS).toContain('<SeenRecords material={data.material} onChanged={load} />');
    expect(CENSUS).not.toMatch(/setInterval|usePolling/);
  });
  it('배선: 표본 표의 위치 · 글 칸은 줄을 바꾼다(전역 nowrap 때문에 걸린 종류 열이 밀려났다)', () => {
    expect(CENSUS).toContain("<td style={{ whiteSpace: 'normal', overflowWrap: 'anywhere', minWidth: 160 }}>{x.where || '—'}</td>");
    expect(CENSUS).toContain("<td style={{ ...mono, whiteSpace: 'normal', overflowWrap: 'anywhere', minWidth: 200 }}>{x.text}</td>");
  });
});
