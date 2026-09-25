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
  hasNodeFault, deviceFaultKind, deviceFaultJudge, faultRows, faultKpi, faultKpiMeta, faultKpiAccent, faultKpiTitle, faultViewNote, faultNodeRows,
  faultJudgeOpts, staleLimitMs, snapAgeMs, isStaleSnap, unknownReasonText, STALE_FACTOR, UNKNOWN_REASON_TEXT,
} from './storageFaultText.js';
import { nodeRows, nodeFaultSummary, faultBadgeTitle } from './storageNodeText.js';
import { stripComments } from '../../test/_stripComments.js'; // v2.615 SF2-06 — 공용 주석 제거기

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

/*
 * ── v2.615 검토 반영 표본 ────────────────────────────────────────────────────────
 * ⚠ 기준 시각을 Date.now() 로 두지 않는다(CLAUDE.md v2.517 — 시각에 따라 깨진다). 고정 NOW 와 서버가 줄 법한 주기.
 */
const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const OPTS = faultJudgeOpts({
  poller: { intervalMs: HOUR },                          // 중앙 직접 수집 주기
  pollMsByAgent: { '': HOUR, GM1: 6 * HOUR },             // 엣지 GM1 은 6시간 주기로 배포됨
  edgeIntervals: { push: { ms: 5 * 60_000 } },
}, NOW);
const fresh = (snap, ageMs = 10 * 60_000) => ({ ...snap, collectedAt: NOW - ageMs });
const REVIEW_ROWS = [
  row('r-ok', fresh(snapOf(okNodes(4)))),
  row('r-off', fresh(snapOf(okNodes(4))), { enabled: false }),                       // 비활성 — 정상 아님
  row('r-old', fresh(snapOf(okNodes(4)), 30 * 24 * HOUR)),                         // 30일 전 — 낡음
  row('r-oldfault', fresh(snapOf([{ id: 1, health: 'DOWN' }, ...okNodes(3)], { unhealthy: 1 }), 30 * 24 * HOUR)),
  row('r-cand', fresh(snapOf([{ id: 1, name: 'n1', ip: '10.9.0.1', health: 'n/a' }, ...okNodes(3)], { unhealthy: 1 }))),
  row('r-66', fresh(snapOf(okNodes(66).slice(0, 64), { count: 66, unknown: 2 }))), // 목록 밖 2대 상태 미확인
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
    expect(k).toMatchObject({ total: 10, fault: 3, ok: 2, unknown: 5, faultNotCurrent: 0 });
    // 판정 불가 사유별 대수의 합 == 판정 불가(두 번째 항등식)
    expect(Object.values(k.unknownBy).reduce((a, b) => a + b, 0)).toBe(k.unknown);
    expect(k.unknownBy).toEqual({ 'node-unknown': 1, 'no-nodes': 2, 'collect-failed': 1, 'no-snap': 1 });
    expect(faultKpi([])).toEqual({ total: 0, fault: 0, ok: 0, unknown: 0, unknownBy: {}, faultNotCurrent: 0 });
    expect(faultKpi(null)).toEqual({ total: 0, fault: 0, ok: 0, unknown: 0, unknownBy: {}, faultNotCurrent: 0 });
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

describe('★ SF-R1-01 — 비활성·낡은 보고는 정상으로 세지 않는다(장애 칸은 ⚠ 표지 그대로)', () => {
  it('신선도 입력은 서버 값에서 만든다 — 담당 노드 주기 우선, 없으면 중앙 주기, 엣지는 push 주기를 더한다', () => {
    expect(STALE_FACTOR).toBe(3);
    expect(staleLimitMs(row('c', null), OPTS)).toBe(3 * HOUR);
    expect(staleLimitMs(row('e', null, { agent: 'GM1' }), OPTS)).toBe(18 * HOUR + 5 * 60_000);
    expect(staleLimitMs(row('e', null, { agent: 'NOCONF' }), OPTS)).toBe(3 * HOUR + 5 * 60_000); // 배포 주기 모름 → 중앙 주기
    expect(staleLimitMs(row('x', null), faultJudgeOpts({}, NOW))).toBeNull();                   // 주기를 모르면 지어내지 않는다
    expect(staleLimitMs(row('x', null, { agent: '__proto__' }), OPTS)).toBe(3 * HOUR + 5 * 60_000);
  });
  it('스냅샷 나이 — 수집 시각과 엣지 보고 나이(staleMs) 중 큰 값, ISO·숫자 문자열도 읽는다', () => {
    expect(snapAgeMs({ collectedAt: NOW - 5000 }, NOW)).toBe(5000);
    expect(snapAgeMs({ collectedAt: String(NOW - 7000) }, NOW)).toBe(7000);
    expect(snapAgeMs({ collectedAt: new Date(NOW - 9000).toISOString() }, NOW)).toBe(9000);
    expect(snapAgeMs({ collectedAt: NOW - 5000, staleMs: 4 * HOUR }, NOW)).toBe(4 * HOUR);
    for (const v of [null, '', undefined, 'abc']) expect(snapAgeMs({ collectedAt: v }, NOW)).toBeNull();
  });
  it('now 가 없으면 낡음을 판정하지 않고, 수집 시각이 없으면 낡은 것으로 본다(지금 정상이라 말하지 않는다)', () => {
    const r = row('x', { ...snapOf(okNodes(3)), collectedAt: NOW - 30 * 24 * HOUR });
    expect(isStaleSnap(r, undefined)).toBe(false);
    expect(isStaleSnap(r, OPTS)).toBe(true);
    expect(isStaleSnap(row('y', snapOf(okNodes(3))), OPTS)).toBe(true);        // collectedAt 없음
    expect(isStaleSnap(row('z', fresh(snapOf(okNodes(3)))), OPTS)).toBe(false);
  });
  it('★ 비활성 장비(노드 전부 정상·신선) → 판정 불가(disabled)', () => {
    expect(deviceFaultJudge(REVIEW_ROWS[1], OPTS)).toMatchObject({ kind: 'unknown', reason: 'disabled' });
    expect(deviceFaultKind(REVIEW_ROWS[1])).toBe('unknown');                   // opts 없이도 비활성은 판정 불가
  });
  it('★ 30일 전 스냅샷(노드 전부 정상) → 판정 불가(stale) · 장비 1대뿐이면 KPI 가 초록이 아니다', () => {
    expect(deviceFaultJudge(REVIEW_ROWS[2], OPTS)).toMatchObject({ kind: 'unknown', reason: 'stale' });
    const k = faultKpi([REVIEW_ROWS[2]], OPTS);
    expect(k).toMatchObject({ total: 1, fault: 0, ok: 0, unknown: 1 });
    expect(faultKpiAccent(k)).toBeUndefined();
    expect(faultKpiMeta(k)).not.toContain('모두 노드 정상');
    // 같은 행이 최근 수집이면 정상 → 초록
    const k2 = faultKpi([REVIEW_ROWS[0]], OPTS);
    expect(k2).toMatchObject({ ok: 1, unknown: 0 });
    expect(faultKpiAccent(k2)).toBe('var(--green)');
  });
  it('엣지 6시간 주기 장비는 10시간 전 수집이어도 낡지 않았다(담당 노드 주기를 쓴다)', () => {
    const r = row('g', fresh(snapOf(okNodes(3)), 10 * HOUR), { agent: 'GM1' });
    expect(deviceFaultKind(r, OPTS)).toBe('ok');
    expect(deviceFaultKind(row('c', fresh(snapOf(okNodes(3)), 10 * HOUR)), OPTS)).toBe('unknown'); // 중앙 1시간 주기
  });
  it('★ 장애 칸은 ⚠ 표지 계약 그대로 — 낡거나 비활성인 장애도 장애이고, faultNotCurrent 로 따로 센다', () => {
    const j = deviceFaultJudge(REVIEW_ROWS[3], OPTS);
    expect(j).toMatchObject({ kind: 'fault', notCurrent: true });
    const off = row('off-f', fresh(snapOf([{ id: 1, health: 'DOWN' }], { unhealthy: 1 })), { enabled: false });
    expect(deviceFaultJudge(off, OPTS)).toMatchObject({ kind: 'fault', notCurrent: true });
    const k = faultKpi(REVIEW_ROWS, OPTS);
    expect(k.fault).toBe(REVIEW_ROWS.filter((r) => hasNodeFault(r.snap)).length);   // == 표지 대수
    expect(k.faultNotCurrent).toBe(1);
    expect(k.fault + k.ok + k.unknown).toBe(k.total);
  });
  it('문구 — title·머리말이 비활성·낡은 보고를 판정 불가로 밝히고, 낡은 장애를 따로 말한다', () => {
    const k = faultKpi(REVIEW_ROWS, OPTS);
    const t = faultKpiTitle(k);
    expect(t).toContain('비활성 장비 1');
    expect(t).toContain('보고가 낡은 장비 1');
    expect(t).toContain('비활성·낡은 보고는 판정 불가');
    expect(t).toContain('1대는 비활성이거나 보고가 낡은 장비');
    const n = faultViewNote(k, k.fault);
    expect(n).toContain('비활성이거나 보고가 낡은 장비');
    expect(n).toContain('보고가 낡은 장비 1');
  });
});

describe('★ SF-R1-02 — 서버가 준 전 노드 기준 상태 미확인 수(nodes.unknown)', () => {
  it('목록 64대 전부 정상이어도 nodes.unknown 2 면 판정 불가(node-unknown)', () => {
    expect(deviceFaultJudge(REVIEW_ROWS[5], OPTS)).toMatchObject({ kind: 'unknown', reason: 'node-unknown' });
  });
  it('nodes.unknown 0 이면 정상(목록 절단만으로 판정 불가가 되지 않는다) · 문자열 수치도 읽는다', () => {
    expect(deviceFaultKind(row('a', fresh(snapOf(okNodes(66).slice(0, 64), { count: 66, unknown: 0 }))), OPTS)).toBe('ok');
    expect(deviceFaultKind(row('a', fresh(snapOf(okNodes(66).slice(0, 64), { count: 66, unknown: '1' }))), OPTS)).toBe('unknown');
  });
  it('구버전 수집기(필드 없음)는 예전 규칙(정상)이되 표지 title 이 목록 밖 대수와 그 한계를 밝힌다', () => {
    const legacy = snapOf(okNodes(66).slice(0, 64), { count: 66 });
    expect(deviceFaultKind(row('l', legacy))).toBe('ok');
    const t = faultBadgeTitle(legacy);
    expect(t).toContain('목록 밖 2대는 요약 수치(비정상 0대) 기준');
    expect(t).toContain('알려 주지 않습니다');
    const t2 = faultBadgeTitle(snapOf(okNodes(66).slice(0, 64), { count: 66, unknown: 0 }));
    expect(t2).toContain('목록 밖 2대');
    expect(t2).not.toContain('알려 주지 않습니다');
    expect(faultBadgeTitle(snapOf(okNodes(4)))).not.toContain('목록 밖');   // 절단 없으면 군말 없음
  });
});

describe('★ SF-R1-03 — 노드 목록의 비객체 원소가 화면을 죽이지 않는다', () => {
  const bad = { ok: true, collectedAt: NOW, nodes: { count: 2, unhealthy: 0, list: [null, { health: 'ok' }] } };
  const badFault = { ok: true, collectedAt: NOW, nodes: { count: 3, unhealthy: 1, list: [null, 'x', { id: 2, health: 'DOWN' }] } };
  it('nodeRows 는 객체만 읽고, 요약이 뺀 개수를 밝힌다', () => {
    expect(nodeRows(bad)).toHaveLength(1);
    const sum = nodeFaultSummary(badFault);
    expect(sum.dropped).toBe(2);
    expect(sum.body).toContain('형식이 올바르지 않은 노드 항목 2개');
  });
  it('판정·KPI·장애 노드 행·표지 title 이 던지지 않는다 — 읽을 수 없는 원소가 있으면 정상이라 말하지 않는다', () => {
    expect(deviceFaultJudge(row('b', bad), OPTS)).toMatchObject({ kind: 'unknown', reason: 'node-unknown' });
    expect(() => faultKpi([row('b', bad), row('bf', badFault)], OPTS)).not.toThrow();
    expect(faultNodeRows([row('bf', badFault)], OPTS).filter((x) => x.kind === 'bad')).toHaveLength(1);
    expect(() => faultBadgeTitle(bad)).not.toThrow();
  });
});

describe('★ SF-R1-04 · SF2-01 — 어긋남의 사유를 사실대로 말한다(수집 시점 차이 아님)', () => {
  it('목록이 다 올라왔고 상태 미확인 노드가 있으면 그 사실을 말하고, 그 노드들을 원문과 함께 후보로 싣는다', () => {
    const rows = faultNodeRows([REVIEW_ROWS[4]], OPTS);
    const u = rows.find((x) => x.kind === 'unidentified');
    expect(u.reason).toContain('상태를 읽지 못한 노드 1대');
    expect(u.reason).not.toContain('수집 시점');
    const c = rows.filter((x) => x.kind === 'candidate');
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ label: 'n1', ip: '10.9.0.1', health: 'n/a', count: 1 });
  });
  it('SF2-01: 목록 전부가 상태 미확인이고 unhealthy>0 이어도 사유는 상태 미확인이다(PowerStore 모양)', () => {
    const s = snapOf([{ id: 1, health: 'unknown' }, { id: 2, health: 'unknown' }, { id: 3, health: 'unknown' }, { id: 4, health: 'unknown' }], { unhealthy: 2 });
    const u = faultNodeRows([row('ps', s)]).find((x) => x.kind === 'unidentified');
    expect(u.count).toBe(2);
    expect(u.reason).toContain('상태를 읽지 못한 노드 4대');
  });
  it('상태 미확인도 없는 어긋남은 판정 규칙 차이라고 말한다', () => {
    const s = snapOf([{ id: 1, health: 'DOWN' }, ...okNodes(3)], { unhealthy: 2 });
    const u = faultNodeRows([row('m', s)]).find((x) => x.kind === 'unidentified');
    expect(u.reason).toContain('판정 규칙');
    expect(faultNodeRows([row('m', s)]).some((x) => x.kind === 'candidate')).toBe(false);
  });
  it("모든 문구에 '수집 시점 차이' 가 없다(원인이 아니다) — 노드 팝업 요약 포함", () => {
    const cases = [
      snapOf([{ id: 1, health: 'DOWN' }, ...okNodes(3)], { unhealthy: 2 }),
      snapOf([{ id: 1, health: 'n/a' }, ...okNodes(3)], { unhealthy: 1 }),
      snapOf([...okNodes(60), { id: 61, health: 'DOWN' }, ...okNodes(3)], { count: 66, unhealthy: 3 }),
    ];
    for (const s of cases) {
      expect(nodeFaultSummary(s).body).not.toContain('수집 시점');
      for (const x of faultNodeRows([row('q', s)])) expect(x.reason).not.toContain('수집 시점');
    }
    expect(nodeFaultSummary(cases[1]).body).toContain('후보');
  });
});

describe('★ SF-R1-05 · SF2-03 — title 이 실제 판정 불가 사유와 두 카드의 겹침, 타입별 열 이름을 말한다', () => {
  it('있는 사유만 개수와 함께 나열한다', () => {
    const k = faultKpi(FIXTURE);
    const t = faultKpiTitle(k);
    expect(t).toContain('일부 노드의 상태를 읽지 못한 장비 1');
    expect(t).toContain('수집 실패(부분 실패 포함) 1');
    expect(t).toContain('수집 전 1');
    expect(t).not.toContain('노드 목록과 요약이 어긋난 장비');                 // 없는 사유는 말하지 않는다
    const mism = faultKpi([row('mm', snapOf([{ id: 1, health: 'DOWN' }, ...okNodes(2)], { unhealthy: 0 }))]);
    expect(faultKpiTitle(mism)).toContain('노드 목록과 요약이 어긋난 장비 1');
    expect(unknownReasonText({})).toBe('');
  });
  it('수집 실패 카드와 겹칠 수 있다는 사실을 밝힌다', () => {
    expect(faultKpiTitle(faultKpi(FIXTURE))).toContain('부분 실패여도 노드를 읽었고 비정상이 있으면 장애로도 셉니다');
  });
  it('근거 문구가 타입별 열 이름(SP·SC·디렉터)을 함께 적는다', () => {
    expect(faultKpiTitle(faultKpi(FIXTURE))).toContain('노드(SP·SC·디렉터) 열');
    expect(faultViewNote(faultKpi(FIXTURE), 3)).toContain('노드(SP·SC·디렉터) 열');
  });
});

describe('변이 고정 — M3 · X8', () => {
  it('★ M3: 수집 실패(ok:false) 스냅샷은 노드를 전부 정상으로 읽었어도 정상이 아니다', () => {
    const s = { ok: false, collectedAt: NOW, nodes: { count: 3, unhealthy: 0, list: okNodes(3) }, sections: { nodes: 'ok', config: '오류', capacity: '오류' } };
    expect(deviceFaultKind({ id: 'x', snap: s })).toBe('unknown');
    expect(deviceFaultJudge({ id: 'x', snap: s }, OPTS).reason).toBe('collect-failed');
  });
  it('★ X8: 노드 수가 0·음수인데 목록이 전부 정상인 어긋난 데이터는 정상이 아니다', () => {
    for (const count of [0, -1]) expect(deviceFaultKind({ id: 'x', snap: { ok: true, collectedAt: NOW, nodes: { count, unhealthy: 0, list: okNodes(3) } } })).toBe('unknown');
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
    // 검토 반영 경로(판정 불가 사유·낡은 보고·후보 노드)의 문구도 전부 본다.
    const kpis = [faultKpi(FIXTURE), faultKpi(REVIEW_ROWS, OPTS)];
    for (const k of kpis) texts.push(faultKpiMeta(k), faultKpiTitle(k), faultViewNote(k, 0), faultViewNote(k, k.fault), unknownReasonText(k));
    for (const x of faultNodeRows(REVIEW_ROWS, OPTS)) texts.push(x.label, x.reason);
    texts.push(...Object.values(UNKNOWN_REASON_TEXT));
    for (const t of texts) expect(String(t)).not.toContain('`');
    expect(Object.keys(F).sort()).toEqual([
      'STALE_FACTOR', 'UNKNOWN_REASON_TEXT', 'deviceFaultJudge', 'deviceFaultKind', 'faultJudgeOpts', 'faultKpi', 'faultKpiAccent', 'faultKpiMeta',
      'faultKpiTitle', 'faultNodeRows', 'faultRows', 'faultViewNote', 'hasNodeFault', 'isStaleSnap', 'snapAgeMs', 'staleLimitMs', 'unknownReasonText',
    ]);
  });
});


/**
 * ⚠ 표지 조건(unhealthy)을 **표시용 보간 밖에서** 쓰는 곳(SF2-05). 허용은 `{s.nodes.unhealthy}`·`${s.nodes.unhealthy}`
 * (선택 `?? 0` 같은 표시 기본값 포함)뿐이다 — 비교·조건·산술로 쓰면 판정을 복제한 것이다(hasNodeFault 밖의 중복 판정 금지).
 */
const ALLOWED_UNHEALTHY = /\$?\{\s*s\??\.nodes\??\.unhealthy(?:\s*\?\?\s*(?:\d+|'[^'\n]*'|"[^"\n]*"))?\s*\}/g;
function unhealthyViolations(src) {
  const spans = [...src.matchAll(ALLOWED_UNHEALTHY)].map((m) => [m.index, m.index + m[0].length]);
  return [...src.matchAll(/\bunhealthy\b/g)].map((m) => m.index).filter((i) => !spans.some(([a, b]) => i >= a && i < b));
}

describe('★ 화면 소스 스윕 — StorageMonTool.jsx 가 이 모듈을 실제로 쓴다', () => {
  const src = stripComments(fs.readFileSync(path.join(HERE, 'StorageMonTool.jsx'), 'utf8'));
  it('⚠ 표지는 hasNodeFault( 를 조건으로 쓰고, 표시값은 s.nodes.unhealthy 그대로다(X11)', () => {
    expect(src).toMatch(/\{hasNodeFault\(s\)\s*\?\s*<button[^>]*className="badge red fail-badge"/);
    expect(src).toMatch(/className="badge red fail-badge"[^\n]*>⚠\{s\.nodes\.unhealthy\}<\/button>/);
  });
  it('★ SF2-05: unhealthy 를 표시용 보간 밖에서(비교·조건·산술) 쓰는 곳이 0건이다', () => {
    const v = unhealthyViolations(src);
    expect(v.map((i) => src.slice(Math.max(0, i - 40), i + 30))).toEqual([]);
  });
  it('KPI 에 "미해결 경보" 가 없고 "장애 장비" 카드의 값은 fk.fault, 누르면 faults 화면을 연다(X1)', () => {
    expect(src).not.toMatch(/label="미해결 경보"/);
    expect(src).toMatch(/<Kpi label="장애 장비" value=\{fk\.fault\}/);
    expect(src).toMatch(/<Kpi label="장애 장비"[\s\S]{0,200}onClick=\{\(\) => setView\('faults'\)\}/);
  });
  it('KPI 는 전체 장비(rows)를 신선도 입력(fjo)과 함께 판정한다(X4 · SF-R1-01)', () => {
    expect(src).toMatch(/const fjo = faultJudgeOpts\(d, Date\.now\(\)\);/);
    expect(src).toMatch(/const fk = faultKpi\(rows, fjo\);/);
  });
  it("useHashTab valid 목록에 'faults' 가 있고 탭 버튼 숫자는 KPI 와 같은 fk.fault 다(X2)", () => {
    const m = src.match(/useHashTab\(\{[^}]*valid:\s*\[([^\]]*)\]/);
    expect(m).toBeTruthy();
    expect(m[1]).toMatch(/'faults'/);
    expect(src).toMatch(/`⚠ 장애 장비 \$\{fk\.fault\}`/);
  });
  it('★ 장애 화면이 실제로 렌더되고, 목록은 필터를 적용한 shown 에서 만든 shownFaults 다(X12 · X3)', () => {
    expect(src).toMatch(/const shownFaults = view === 'faults' \? faultRows\(shown, fjo\) : \[\];/);
    expect(src).toMatch(/\{view === 'faults' && \(\s*<FaultsView fk=\{fk\} list=\{shownFaults\}/);
    // 필터 바는 장애 화면에서도 보인다(추이만 감춘다)
    expect(src).toMatch(/\{view !== 'trend' && rows\.length > 0 && \(\s*<DeviceFacetBar/);
  });
  it('비정상 노드 표는 장애 목록에서 만든다(X5) · 장비 버튼 title 에 전체 이름(SF2-04)', () => {
    expect(src).toMatch(/const nodeList = faultNodeRows\(list\);/);
    expect(src).toMatch(/title=\{`\$\{x\.deviceName\} — 이 장비의 노드 상태 보기`\}/);
  });
  it('SF2-02: 장애 화면에서 필터·검색 요약 줄이 같은 모집단의 장애 대수를 함께 말한다', () => {
    expect(src).toMatch(/\{view === 'faults' && <> · 이 중 장애 <b[^>]*>\{shownFaults\.length\}<\/b>대<\/>\}/);
    expect(src).toMatch(/\{view === 'faults' \? ` · 이 중 장애 \$\{shownFaults\.length\}대` : ''\}/);
  });
  it('스윕 자체가 동작한다(변이 검증 — 주석 속 설명이 통과 근거가 되지 않는다)', () => {
    expect(stripComments("const k = 1; // hasNodeFault(s) ? <b/>\n/* label=\"미해결 경보\" */x")).toBe('const k = 1; \nx');
    // 허용: 표시용 보간
    expect(unhealthyViolations('<b>⚠{s.nodes.unhealthy}</b> `${s.nodes.unhealthy}대` {s?.nodes?.unhealthy ?? 0}')).toEqual([]);
    // 거부: 조건·비교·산술(판정 복제)
    for (const bad of [
      '{s?.nodes?.unhealthy ? <b/> : null}', '{s?.nodes?.unhealthy\n ? <b/> : null}', 'Number(s?.nodes?.unhealthy) > 0 ? a : b',
      's.nodes.unhealthy > 0 && x', 'const n = r.snap.nodes.unhealthy;', "{x.nodes['unhealthy'] ? 1 : 0}",
    ]) expect(unhealthyViolations(bad).length, bad).toBeGreaterThan(0);
  });
});
