/**
 * storageFaultText.test.js — 스토리지 '장애 장비' KPI·화면 판정 회귀 고정(v2.615).
 *
 * 사용자 요청: "'미해결 정보' 를 '장애 장비' 로 변경하고 … 장애 숫자를 클릭하면 장애 발생한 장비들만".
 *
 * ⚠⚠ 이 기능은 v2.567 에 한 번 만들었다가 v2.568 에 철회됐다 — 장비가 보고한 헬스 문자열(Isilon 'ATTN')을
 * 장애로 읽어 실제 3대가 **27대**로 보고됐다. 그래서 이 테스트의 중심은 ① 판정이 노드 ⚠ 표지와 **같은 조건**
 * 이라는 것 ② 헬스 문자열·경보 수·하드웨어 인벤토리가 **판정을 바꾸지 않는다**는 것 ③ 판정 불가를 정상에도
 * 장애에도 넣지 않는다는 것(항등식)이다. 소스 스윕은 화면이 이 모듈을 실제로 쓰는지 본다.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as F from './storageFaultText.js';
import {
  hasNodeFault, deviceFaultKind, faultRows, faultKpi, faultKpiMeta, faultKpiAccent, faultKpiTitle, faultViewNote, faultNodeRows,
} from './storageFaultText.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 노드 목록으로 스냅샷을 만든다(요약 unhealthy 는 명시값이 우선). */
const snapOf = (list, over = {}) => ({
  ok: true,
  nodes: { count: list.length, unhealthy: 0, list, ...over },
  sections: { nodes: 'ok' },
});
const okNodes = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, health: 'OK' }));
const row = (id, snap, extra = {}) => ({ id, name: `dev-${id}`, host: `10.0.0.${id}`, type: 'isilon', datacenterId: 'dc1', snap, ...extra });

// 현장과 같은 모양의 표본 — 장애 3대(노드 비정상) + 헬스 문자열만 이상한 정상 장비 여럿 + 판정 불가 여럿.
const FIXTURE = [
  row('a', snapOf([...okNodes(23), { id: 24, name: 'n24', ip: '10.1.0.24', health: 'ATTN' }], { unhealthy: 1 })),
  row('b', snapOf([{ id: 1, health: 'DOWN' }, { id: 2, health: 'SMARTFAIL' }, ...okNodes(4)], { unhealthy: 2 })),
  row('c', snapOf([], { count: 4, unhealthy: '2' }), { type: 'powerstore' }),             // 개수만 — 문자열 수치
  row('d', { ...snapOf(okNodes(66).slice(0, 64), { count: 66 }), extra: { clusterHealth: 'ATTN' } }), // v2.568 오보 모양
  row('e', { ...snapOf(okNodes(3)), extra: { healthState: 'ATTN_DEGRADED' }, alerts: { unresolved: 5000 } }),
  row('f', snapOf([{ id: 1, health: 'unknown' }, { id: 2, health: 'unknown' }], { unhealthy: 0 }), { type: 'powerstore' }),
  row('g', { ok: true, nodes: { count: null, unhealthy: null }, sections: {} }, { type: 'unity480' }),
  row('h', { ok: false, nodes: { count: 0, unhealthy: 0 }, sections: {} }),
  row('i', null),
  row('j', { ok: true, nodes: { count: 0, unhealthy: 0, list: [] }, sections: {} }, { type: 'vmax' }),
];

describe('판정 = 노드 ⚠ 표지와 같은 조건', () => {
  it('★ 표지 조건(hasNodeFault)을 만족하는 행 수 == KPI 장애 수 == faultRows 길이', () => {
    const badge = FIXTURE.filter((r) => hasNodeFault(r.snap)).length;
    const k = faultKpi(FIXTURE);
    expect(k.fault).toBe(badge);
    expect(faultRows(FIXTURE).length).toBe(badge);
    expect(faultRows(FIXTURE).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });
  it('★ 항등식 total = fault + ok + unknown', () => {
    const k = faultKpi(FIXTURE);
    expect(k.total).toBe(FIXTURE.length);
    expect(k.fault + k.ok + k.unknown).toBe(k.total);
    expect(k).toEqual({ total: 10, fault: 3, ok: 2, unknown: 5 });
    expect(faultKpi([])).toEqual({ total: 0, fault: 0, ok: 0, unknown: 0 });
    expect(faultKpi(null)).toEqual({ total: 0, fault: 0, ok: 0, unknown: 0 });
  });
  it('문자열 수치 "2" 는 장애, 빈 값·null·"0"·음수는 장애가 아니다', () => {
    expect(hasNodeFault({ nodes: { unhealthy: '2' } })).toBe(true);
    expect(hasNodeFault({ nodes: { unhealthy: 1 } })).toBe(true);
    for (const v of ['', null, undefined, '0', 0, -1, '  ', [], {}]) expect(hasNodeFault({ nodes: { unhealthy: v } })).toBe(false);
    expect(hasNodeFault(null)).toBe(false);
    expect(hasNodeFault({})).toBe(false);
  });
});

describe('★ v2.568 회귀 — 헬스 문자열·경보 수·하드웨어 인벤토리는 판정에 쓰지 않는다', () => {
  const allOk = snapOf(okNodes(4));
  it('clusterHealth ATTN · healthState ATTN_DEGRADED · 경보 5000 · 부품 이상 3 — 노드가 전부 정상이면 장애가 아니다', () => {
    const variants = [
      { ...allOk, extra: { clusterHealth: 'ATTN' } },
      { ...allOk, extra: { healthState: 'ATTN_DEGRADED' } },
      { ...allOk, alerts: { unresolved: 5000 } },
      { ...allOk, extra: { inventory: { hardware: { unhealthy: 3 } } } },
      { ...allOk, extra: { clusterHealth: 'ATTN', healthState: 'CRITICAL', inventory: { hardware: { unhealthy: 3 } } }, alerts: { unresolved: 5000 } },
    ];
    for (const s of variants) {
      expect(deviceFaultKind(row('x', s))).toBe('ok');
      expect(hasNodeFault(s)).toBe(false);
    }
  });
  it('모듈 소스에 판정용 헬스·경보·인벤토리 참조가 없다(주석 제외)', () => {
    const src = stripComments(fs.readFileSync(path.join(HERE, 'storageFaultText.js'), 'utf8'));
    expect(src).not.toMatch(/healthState|clusterHealth|alerts|inventory|healthBadge/);
  });
});

describe('판정 불가(unknown) — 정상에도 장애에도 넣지 않는다', () => {
  it('PowerStore 류(목록 health unknown, unhealthy 0) → unknown', () => {
    expect(deviceFaultKind(FIXTURE[5])).toBe('unknown');
  });
  it('Unity SSH(노드 수 null) → unknown', () => {
    expect(deviceFaultKind(FIXTURE[6])).toBe('unknown');
  });
  it('수집 실패(ok:false) · 스냅샷 없음 · 노드 정보 없는 타입(VMAX) → unknown', () => {
    expect(deviceFaultKind(FIXTURE[7])).toBe('unknown');
    expect(deviceFaultKind(FIXTURE[8])).toBe('unknown');
    expect(deviceFaultKind(row('z', undefined))).toBe('unknown');
    expect(deviceFaultKind(FIXTURE[9])).toBe('unknown');
  });
  it('개수만 있고 목록이 없으면(unhealthy 0) → unknown', () => {
    expect(deviceFaultKind(row('y', snapOf([], { count: 4, unhealthy: 0 })))).toBe('unknown');
  });
  it('요약 unhealthy 가 없으면(null) → unknown', () => {
    expect(deviceFaultKind(row('y', snapOf(okNodes(3), { unhealthy: null })))).toBe('unknown');
  });
  it('한 노드라도 상태 미확인이면 → unknown', () => {
    expect(deviceFaultKind(row('y', snapOf([...okNodes(3), { id: 9, health: '' }])))).toBe('unknown');
  });
  it('목록은 이상인데 요약이 0 이면 정상이라 말하지 않는다 → unknown', () => {
    expect(deviceFaultKind(row('y', snapOf([...okNodes(3), { id: 9, health: 'DOWN' }], { unhealthy: 0 })))).toBe('unknown');
  });
  it('★ Isilon 66대 · 목록 64대(상한) · unhealthy 0 · 목록 전부 OK → ok(상한 절단만으로 판정 불가가 되지 않는다)', () => {
    expect(deviceFaultKind(row('d', snapOf(okNodes(66).slice(0, 64), { count: 66 })))).toBe('ok');
  });
  it('장애는 수집 실패 스냅샷이어도 표지 조건 그대로다(표지와 같은 조건)', () => {
    expect(deviceFaultKind(row('y', { ok: false, nodes: { count: 4, unhealthy: 1 } }))).toBe('fault');
  });
});

describe('KPI 문구·색', () => {
  it('meta — 판정 불가가 먼저, 그다음 장애 안내, 전부 정상, 장비 없음', () => {
    expect(faultKpiMeta({ total: 10, fault: 3, ok: 2, unknown: 5 })).toBe('노드 상태 판정 불가 5대 제외');
    expect(faultKpiMeta({ total: 5, fault: 3, ok: 2, unknown: 0 })).toBe('클릭하면 장애 장비만 봅니다');
    expect(faultKpiMeta({ total: 4, fault: 0, ok: 4, unknown: 0 })).toBe('4대 모두 노드 정상');
    expect(faultKpiMeta({ total: 0, fault: 0, ok: 0, unknown: 0 })).toBe('등록된 장비 없음');
    expect(faultKpiMeta(null)).toBe('등록된 장비 없음');
  });
  it('accent — 장애면 빨강, 전부 판정·장애 0 이면 초록, 판정 불가가 섞이면 중립(초록 거짓 금지)', () => {
    expect(faultKpiAccent({ total: 5, fault: 1, ok: 4, unknown: 0 })).toBe('var(--red)');
    expect(faultKpiAccent({ total: 5, fault: 1, ok: 0, unknown: 4 })).toBe('var(--red)');
    expect(faultKpiAccent({ total: 4, fault: 0, ok: 4, unknown: 0 })).toBe('var(--green)');
    expect(faultKpiAccent({ total: 4, fault: 0, ok: 3, unknown: 1 })).toBeUndefined();
    expect(faultKpiAccent({ total: 0, fault: 0, ok: 0, unknown: 0 })).toBeUndefined();
    expect(faultKpiAccent(null)).toBeUndefined();
  });
  it('title — 근거(⚠ 표지)·세 칸 개수·판정 불가의 뜻·수집 실패 카드를 말한다', () => {
    const t = faultKpiTitle({ total: 10, fault: 3, ok: 2, unknown: 5 });
    expect(t).toContain('⚠ 표지');
    expect(t).toContain('장애 3 · 정상 2 · 판정 불가 5');
    expect(t).toContain('정상이라는 뜻이 아닙니다');
    expect(t).toContain('수집 실패/대기');
    expect(t).toContain('클릭하면');
    expect(faultKpiTitle({ total: 4, fault: 0, ok: 4, unknown: 0 })).not.toContain('정상이라는 뜻이 아닙니다');
    expect(faultKpiTitle(null)).toBe('등록된 스토리지 장비가 없습니다.');
  });
});

describe('장애 장비 화면 머리말', () => {
  it('장애 0 — 판정 불가가 있으면 단정하지 않는다', () => {
    expect(faultViewNote({ total: 5, fault: 0, ok: 3, unknown: 2 }, 0)).toContain('단정할 수 없습니다');
    expect(faultViewNote({ total: 5, fault: 0, ok: 3, unknown: 2 }, 0)).toContain('판정 불가 2대');
    const clean = faultViewNote({ total: 5, fault: 0, ok: 5, unknown: 0 }, 0);
    expect(clean).toContain('장애로 판정된 장비가 없습니다');
    expect(clean).not.toContain('단정할 수 없습니다');
  });
  it('필터·찾기로 가려진 장애 장비 수를 밝힌다', () => {
    const t = faultViewNote({ total: 10, fault: 3, ok: 2, unknown: 5 }, 1);
    expect(t).toContain('장애 장비 3대');
    expect(t).toContain('2대가 가려져 있습니다');
    expect(t).toContain('판정하지 못한 장비 5대');
    expect(faultViewNote({ total: 10, fault: 3, ok: 7, unknown: 0 }, 3)).not.toContain('가려져');
  });
  it('장비 없음', () => {
    expect(faultViewNote({ total: 0, fault: 0, ok: 0, unknown: 0 }, 0)).toBe('등록된 장비가 없습니다.');
    expect(faultViewNote(null, 0)).toBe('등록된 장비가 없습니다.');
  });
});

describe('비정상 노드 행 — 노드 이름을 지어내지 않는다', () => {
  it('목록의 이상 노드는 한 행씩, 원문 상태를 싣는다', () => {
    const rows = faultNodeRows([FIXTURE[0]]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ deviceId: 'a', label: 'n24', ip: '10.1.0.24', health: 'ATTN', kind: 'bad', count: 1 });
  });
  it('★ 요약 unhealthy 가 목록의 이상 노드보다 많으면 장비당 한 행 "어느 노드인지 알 수 없음 N대"', () => {
    const s = snapOf([...okNodes(60), { id: 61, health: 'DOWN' }, ...okNodes(3)], { count: 66, unhealthy: 3 });
    const rows = faultNodeRows([row('big', s)]);
    expect(rows.filter((x) => x.kind === 'bad')).toHaveLength(1);
    const u = rows.filter((x) => x.kind === 'unidentified');
    expect(u).toHaveLength(1);
    expect(u[0].count).toBe(2);
    expect(u[0].label).toBe('어느 노드인지 알 수 없음 2대');
    expect(u[0].reason).toContain('64대만');
  });
  it('개수만 주는 수집기(목록 없음) — 전부 알 수 없음 한 행', () => {
    const rows = faultNodeRows([FIXTURE[2]]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ deviceId: 'c', kind: 'unidentified', count: 2, ip: '', health: '' });
    expect(rows[0].reason).toContain('개수만');
  });
  it('장애가 아닌 장비는 행을 만들지 않는다', () => {
    expect(faultNodeRows(FIXTURE.slice(3))).toEqual([]);
    expect(faultNodeRows([])).toEqual([]);
  });
});

describe('문구에 백틱이 없다(BoldText 는 **강조** 만 해석한다)', () => {
  it('★ 내보낸 문구 함수 결과 전부', () => {
    const ks = [
      null, { total: 0, fault: 0, ok: 0, unknown: 0 }, { total: 10, fault: 3, ok: 2, unknown: 5 },
      { total: 4, fault: 0, ok: 4, unknown: 0 }, { total: 5, fault: 0, ok: 3, unknown: 2 }, { total: 5, fault: 3, ok: 2, unknown: 0 },
    ];
    const texts = [];
    for (const k of ks) texts.push(faultKpiMeta(k), faultKpiTitle(k), faultViewNote(k, 1), faultViewNote(k, 0));
    for (const x of faultNodeRows(FIXTURE)) texts.push(x.label, x.reason);
    const s = snapOf([...okNodes(60), { id: 61, health: 'DOWN' }, ...okNodes(3)], { count: 66, unhealthy: 3 });
    for (const x of faultNodeRows([row('big', s), row('mis', snapOf([{ id: 1, health: 'DOWN' }], { unhealthy: 2 }))])) texts.push(x.label, x.reason);
    for (const t of texts) expect(String(t)).not.toContain('`');
    expect(Object.keys(F).sort()).toEqual([
      'deviceFaultKind', 'faultKpi', 'faultKpiAccent', 'faultKpiMeta', 'faultKpiTitle', 'faultNodeRows', 'faultRows', 'faultViewNote', 'hasNodeFault',
    ]);
  });
});

/**
 * 주석만 지우고 **개행은 보존**한다(audit2613b·uiText 와 같은 상태 기계 — 줄 번호가 밀리지 않게, v2.574 규약).
 * ⚠ 문자열 안의 // 는 구분하지 않는다 — 대상 파일(StorageMonTool.jsx·storageFaultText.js)에는 그런 문자열이 없다.
 * (JSX 텍스트의 홑따옴표 때문에 따옴표 추적을 넣으면 오히려 동기가 깨진다.)
 */
function stripComments(s) {
  let out = ''; let i = 0;
  const N = s.length;
  while (i < N) {
    const c = s[i]; const d = s[i + 1];
    if (c === '/' && d === '*') { const e = s.indexOf('*/', i + 2); const seg = s.slice(i, e < 0 ? N : e + 2); out += seg.replace(/[^\n]/g, ''); i = e < 0 ? N : e + 2; continue; }
    if (c === '/' && d === '/') { const e = s.indexOf('\n', i); const seg = s.slice(i, e < 0 ? N : e); out += seg.replace(/[^\n]/g, ''); i = e < 0 ? N : e; continue; }
    out += c; i += 1;
  }
  return out;
}

describe('★ 화면 소스 스윕 — StorageMonTool.jsx 가 이 모듈을 실제로 쓴다', () => {
  const src = stripComments(fs.readFileSync(path.join(HERE, 'StorageMonTool.jsx'), 'utf8'));
  it('⚠ 표지는 hasNodeFault( 를 조건으로 쓰고, 인라인 s?.nodes?.unhealthy ? 조건이 남아 있지 않다', () => {
    expect(src).toMatch(/\{hasNodeFault\(s\)\s*\?\s*<button[^>]*className="badge red fail-badge"/);
    expect(src).not.toMatch(/s\?\.nodes\?\.unhealthy\s*\?(?!\.)/);
  });
  it('KPI 에 "미해결 경보" 가 없고 "장애 장비" 가 faults 화면을 연다', () => {
    expect(src).not.toMatch(/label="미해결 경보"/);
    expect(src).toMatch(/<Kpi label="장애 장비"[\s\S]{0,200}onClick=\{\(\) => setView\('faults'\)\}/);
  });
  it("useHashTab valid 목록에 'faults' 가 있다", () => {
    const m = src.match(/useHashTab\(\{[^}]*valid:\s*\[([^\]]*)\]/);
    expect(m).toBeTruthy();
    expect(m[1]).toMatch(/'faults'/);
  });
  it('장애 화면 목록은 필터를 적용한 목록(shown)에서 faultRows 로 만든다', () => {
    expect(src).toMatch(/faultRows\(shown\)/);
  });
  it('스윕 자체가 동작한다(변이 검증 — 주석 속 설명이 통과 근거가 되지 않는다)', () => {
    expect(stripComments("const k = 1; // hasNodeFault(s) ? <b/>\n/* label=\"미해결 경보\" */x")).toBe('const k = 1; \nx');
    expect(/s\?\.nodes\?\.unhealthy\s*\?(?!\.)/.test('{s?.nodes?.unhealthy\n ? <b/> : null}')).toBe(true);
    expect(/s\?\.nodes\?\.unhealthy\s*\?(?!\.)/.test('s?.nodes?.unhealthy?.x')).toBe(false);
  });
});
