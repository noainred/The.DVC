/**
 * v2.927 '중앙에서 켜기'(사용자 요청 "중앙에서 엣지를 켜는 기능 추가") — 화면 판단·문구(순수).
 *  · 버튼은 배포 현황을 받은 사람(전체 범위 관리자 · 중앙)에게만 · '엣지에서 꺼짐' 행에만 · 전체 배포·제외에 묶인 엣지는 버튼 대신 이유
 *  · 저장 뒤 '켜기 지시됨 — 다음 인출 대기' → '전달됨' → '적용됨' · 엣지 스냅샷이 켜지면 원래 상태
 *  · 확인 문구 — 켜지는 법인 이름 · 주기·보존·경로·알림이 중앙 값으로 바뀜(API 값) · 해제하면 로컬 복귀 · Enterprise 비배포 · 토큰 없음 경고
 *  · 서버 상태 낱말 전부에 라벨(소스 대조 — 모르는 상태를 정상으로 칠하지 않는다)
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  edgeOnView, edgeOnConfirmLines, edgeOffConfirmLines, edgeOnSavedText, findDistRow, distributionSummary, distributionCounts,
  DIST_STATE, distStateOf, distModeLabel, DIST_ENTERPRISE_NOTE,
} from './bmUsageDistText.js';
import { edgePullState } from './bmUsageText.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOW = Date.now();
const offEdge = { agent: 'OC2', enabled: true, hasUrl: true, snapAt: NOW - 60_000, enabledOnEdge: false };
const onEdge = { ...offEdge, enabledOnEdge: true };
const row = (o) => ({ agent: 'OC2', mode: 'off', state: 'off', excluded: false, perEdge: false, corps: ['vc-oc2'], tokenIssued: true, ...o });

describe('edgeOnView — 버튼·상태 덮기·이유', () => {
  it('배포 현황이 없는 사람(비관리자·범위 계정·엣지 노드)에게는 아무것도 없다', () => {
    expect(edgeOnView(offEdge, row(), { canManage: false })).toEqual({ action: null, override: null, badge: '', note: '' });
    expect(edgeOnView(offEdge, null, { canManage: true }).action).toBe(null);
  });
  it("'엣지에서 꺼짐' 행 + 로컬 모드에만 켜기 버튼 · 켜져 있거나 보관분이 없으면 없다", () => {
    expect(edgeOnView(offEdge, row(), { canManage: true }).action).toBe('on');
    expect(edgeOnView(onEdge, row(), { canManage: true }).action).toBe(null);
    expect(edgeOnView({ ...offEdge, snapAt: null }, row(), { canManage: true }).action).toBe(null);
  });
  it('전체 배포·제외에 묶인 엣지는 버튼 대신 이유(서버도 409)', () => {
    const all = edgeOnView(offEdge, row({ mode: 'all', state: 'applied' }), { canManage: true });
    expect(all.action).toBe(null); expect(all.note).toMatch(/전체 배포/);
    const ex = edgeOnView(offEdge, row({ mode: 'excluded', state: 'excluded', excluded: true }), { canManage: true });
    expect(ex.action).toBe(null); expect(ex.note).toMatch(/제외를 먼저 해제/);
  });
  it('저장 뒤 — 켜기 지시됨(다음 인출 대기) → 전달됨 → 적용됨 · 해제 버튼 · 이름 아래 표시', () => {
    const p = (state) => edgeOnView(offEdge, row({ mode: 'per-edge', perEdge: true, state }), { canManage: true });
    for (const s of ['no-pull', 'pending']) {
      const v = p(s);
      expect(v.override.label).toBe('켜기 지시됨 — 다음 인출 대기');
      expect(v.override.why).toMatch(/다음 인출/);
      expect(v.action).toBe('off');
    }
    expect(p('no-pull').override.why).toMatch(/2\.627 미만/);
    expect(p('delivered').override.label).toBe('전달됨');
    expect(p('applied').override.label).toBe('적용됨');
    expect(p('applied').override.why).toMatch(/지금 가져오기/);
    expect(p('applied').badge).toBe('중앙 켜기 · 적용됨');
  });
  it('엣지 스냅샷이 켜지면 원래 상태(덮지 않는다) — 해제 버튼과 표시는 남는다', () => {
    const v = edgeOnView(onEdge, row({ mode: 'per-edge', perEdge: true, state: 'applied' }), { canManage: true });
    expect(v.override).toBe(null); expect(v.action).toBe('off'); expect(v.badge).toMatch(/중앙 켜기/);
  });
  it('받지 못함(공유 토큰) · 법인 없음 · 매핑 준비 중은 엣지 상태와 무관하게 밝힌다', () => {
    const u = edgeOnView(onEdge, row({ mode: 'per-edge', perEdge: true, state: 'unverified' }), { canManage: true });
    expect(u.override.label).toMatch(/받지 못함/); expect(u.override.tone).toBe('bad'); expect(u.override.why).toMatch(/개별 토큰/);
    expect(edgeOnView(offEdge, row({ mode: 'per-edge', perEdge: true, state: 'no-corps' }), { canManage: true }).override.why).toMatch(/법인을 찾지 못했습니다/);
    expect(edgeOnView(offEdge, row({ mode: 'per-edge', perEdge: true, state: 'not-ready' }), { canManage: true }).override.label).toMatch(/매핑 준비 중/);
  });
  it('전체 배포에 가려짐 · 제외와 충돌 · 해제 대기를 조용히 두지 않는다', () => {
    const sup = edgeOnView(offEdge, row({ mode: 'all', perEdge: true, perEdgeSuperseded: true, state: 'applied' }), { canManage: true });
    expect(sup.note).toMatch(/전체 배포가 우선/); expect(sup.action).toBe('off'); expect(sup.override).toBe(null);
    const cf = edgeOnView(offEdge, row({ mode: 'excluded', perEdge: true, conflict: true, excluded: true, state: 'excluded' }), { canManage: true });
    expect(cf.note).toMatch(/제외가 우선/);
    const rel = edgeOnView(onEdge, row({ mode: 'off', state: 'releasing' }), { canManage: true });
    expect(rel.override.label).toBe('해제 대기'); expect(rel.override.why).toMatch(/엣지 로컬 설정으로 돌아갑니다/);
  });
});

describe("'엣지에서 꺼짐' 문구 정정(v2.627 부터 사실이 아니었다)", () => {
  it('켤 수 없다고 말하지 않는다 — 관리자에게는 버튼, 그 밖에는 관리자·법인 포탈', () => {
    const plain = edgePullState(offEdge, { now: NOW });
    expect(plain.why).not.toMatch(/켤 수 없습니다/);
    expect(plain.why).toMatch(/관리자가 중앙에서 켜거나 그 법인 포탈에서 켭니다/);
    expect(edgePullState(offEdge, { now: NOW, canEnableCentral: true }).why).toMatch(/\*\*중앙에서 켜기\*\* 버튼으로 켤 수 있습니다/);
  });
});

describe('확인 문구 — 무엇이 바뀌는지 값과 함께', () => {
  const dist = { perEdgeBase: { enabled: true, intervalMs: 420_000, rawRetentionDays: 60, dailyRetentionDays: 400, osSsh: false, idracTelemetry: true,
    idracFullTelemetry: false, includeVirtualization: true, includeUnassigned: false, alertEnabled: true, alertPct: 85, alertSustainMin: 15, alertRepeatHours: 6 } };
  it('법인 이름 · 주기·보존·경로·알림 값 · 해제하면 로컬 복귀 · Enterprise 비배포', () => {
    const lines = edgeOnConfirmLines({ agent: 'OC2', distRow: row({ corps: ['vc-a', 'vc-b'] }), dist, vcName: (id) => ({ 'vc-a': '법인A' }[id]) });
    const all = lines.join('\n');
    expect(all).toMatch(/\*\*OC2\*\* 의 베어메탈 사용률 수집을 중앙에서 켭니다/);
    expect(all).toMatch(/다음 인출/);
    expect(all).toMatch(/켜지는 법인 \*\*2곳\*\*: 법인A · vc-b/);
    expect(all).toMatch(/주기 · 보존 · OS SSH · iDRAC · 알림 값도 이 중앙의 값으로 바뀝니다/);
    expect(all).toMatch(/주기 7분 · 원시 보존 60일 · 일 롤업 400일 · OS SSH 끔 · iDRAC 텔레메트리 켬\(전수 끔\) · ESXi 호스트 포함 켬/);
    expect(all).toMatch(/알림 켬\(85% · 15분 지속 · 6시간 재알림\)/);
    expect(all).toMatch(/해제하면 엣지 로컬 설정으로 돌아갑니다/);
    expect(lines).toContain(DIST_ENTERPRISE_NOTE);
    expect(all).not.toMatch(/개별 토큰이 발급돼 있지 않습니다/);
    for (const l of lines) expect(l).not.toMatch(/`/);
  });
  it('법인 0 · 매핑 미확인 · 토큰 없음 · 값을 모르면 숫자를 지어내지 않는다', () => {
    expect(edgeOnConfirmLines({ agent: 'X', distRow: row({ corps: [] }), dist }).join('\n')).toMatch(/내려보내지 않습니다/);
    expect(edgeOnConfirmLines({ agent: 'X', distRow: row({ corps: null }), dist }).join('\n')).toMatch(/아직 확인하지 못했습니다/);
    expect(edgeOnConfirmLines({ agent: 'X', distRow: row({ tokenIssued: false }), dist }).join('\n')).toMatch(/개별 토큰이 발급돼 있지 않습니다/);
    const noBase = edgeOnConfirmLines({ agent: 'X', distRow: row(), dist: {} }).join('\n');
    expect(noBase).toMatch(/중앙의 값으로 바뀝니다/); expect(noBase).not.toMatch(/주기 \d+분 ·|원시 보존 \d/);
  });
  it('해제 문구 · 저장 응답 문구', () => {
    expect(edgeOffConfirmLines('OC2')[0]).toMatch(/엣지 로컬 설정\*\*으로 돌아갑니다/);
    expect(edgeOnSavedText({ agent: 'OC2', on: true })).toMatch(/저장 즉시 켜지지 않습니다/);
    expect(edgeOnSavedText({ agent: 'OC2', on: false })).toMatch(/로컬 설정으로 돌아갑니다/);
  });
});

describe('배포 요약·현황', () => {
  it("전체 배포가 꺼져 있어도 중앙 켜기 엣지가 있으면 '모두 각자 로컬' 이라 말하지 않는다", () => {
    const d = { enabled: false, rows: [row({ mode: 'per-edge', perEdge: true, state: 'applied' }), row({ agent: 'B' }), row({ agent: 'C' })] };
    const s = distributionSummary(d);
    expect(s).toMatch(/중앙 켜기\(이 엣지만\) 1곳\*\*\(적용됨 1\)/);
    expect(s).toMatch(/나머지 2곳은 각자 로컬/);
    expect(distributionSummary({ enabled: false, rows: [row()] })).toMatch(/\*\*배포 꺼짐\*\* — 엣지 1곳은 각자 로컬/);
    const on = distributionSummary({ enabled: true, rows: [row({ mode: 'all', perEdge: true, perEdgeSuperseded: true, state: 'applied' })] });
    expect(on).toMatch(/전체 배포가 우선/);
    const c = distributionCounts({ rows: [row({ state: 'unverified', verified: false }), row({ state: 'releasing' })] });
    expect(c.notVerified).toBe(1); expect(c.unverified).toBe(1); expect(c.releasing).toBe(1);
    expect(findDistRow({ rows: [row()] }, 'oc2').agent).toBe('OC2');
    expect(findDistRow({ rows: [row()] }, '')).toBe(null);
  });
  it('서버 상태·모드 낱말 전부에 라벨(소스 대조 — 모르는 상태를 정상으로 칠하지 않는다)', () => {
    const src = fs.readFileSync(path.resolve(HERE, '../../../../server/src/bmusage/settings.js'), 'utf8');
    const body = src.slice(src.indexOf('export function distributionStatus'), src.indexOf('perEdgeBase, mappingReady };'));
    const states = new Set([...body.matchAll(/state = '([a-z-]+)'/g)].map((m) => m[1]));
    for (const m of body.matchAll(/state = p\?\.deliveredSig \? '([a-z-]+)' : mode/g)) states.add(m[1]);
    states.add('off'); states.add('excluded');
    expect(states.size).toBeGreaterThanOrEqual(10);
    for (const s of states) expect(DIST_STATE[s]?.label, s).toBeTruthy();
    for (const m of ['all', 'per-edge', 'excluded', 'off']) expect(distModeLabel(m)).not.toBe('—');
    expect(distStateOf('zzz').label).toBe('확인 불가');
  });
  it('BmUsage.jsx — 버튼은 배포 현황(전체 범위 관리자 · 중앙)이 있을 때만 · 확인 상자를 거쳐 저장한다', () => {
    const jsx = fs.readFileSync(path.join(HERE, 'BmUsage.jsx'), 'utf8');
    expect(jsx).toMatch(/edgeOnView\(r, findDistRow\(data\?\.distribution, r\.agent\), \{ canManage: !!data\?\.distribution \}\)/);
    expect(jsx).toMatch(/putJson\('\/tools\/bm-usage\/distribute\/edge', \{ agent, on \}\)/);
    expect((jsx.match(/saveEdgeOn\(/g) || []).length).toBe(2);   // 정의 1 + 확인 상자의 저장 버튼 1 — 표 버튼이 바로 저장하지 않는다
  });
  it('BmUsage.jsx — 400·409 응답(sendJson 은 던지지 않는다)을 성공으로 그리지 않는다(Chromium 409 가로채기에서 실제로 잡힌 결함)', () => {
    const jsx = fs.readFileSync(path.join(HERE, 'BmUsage.jsx'), 'utf8');
    for (const route of ["'/tools/bm-usage/distribute/edge'", "'/tools/bm-usage/distribute'"]) {
      const i = jsx.indexOf(`putJson(${route}`);
      expect(i, route).toBeGreaterThan(0);
      const after = jsx.slice(i, i + 400);
      expect(after, route).toMatch(/if \(r\?\.ok === false\)/);
      expect(after.indexOf('r?.ok === false'), route).toBeLessThan(after.indexOf('setData('));
    }
  });
});
