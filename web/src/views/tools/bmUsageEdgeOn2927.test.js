/**
 * v2.927 '중앙에서 켜기'(사용자 요청 "중앙에서 엣지를 켜는 기능 추가") — 화면 판단·문구(순수).
 *  · 버튼은 배포 현황을 받은 사람(전체 범위 관리자 · 중앙)에게만 · '엣지에서 꺼짐' 행 + **엣지 노드**에만(반증 F7) · 전체 배포·제외에 묶인 엣지는 버튼 대신 이유
 *  · 저장 뒤 '켜기 지시됨 — 다음 인출 대기' → '전달됨' → '적용됨' — 보관분 상태를 **대체하지 않고 함께**(반증 F8)
 *  · 법인 매핑이 바뀌면 '다시 확인'(반증 F2·F3) · 해제 문구는 해제 뒤 실제로 받는 설정(전체 배포 계속 — 반증 F4) · 전체 배포가 끈 엣지 안내(반증 F5)
 *  · 확인 문구 — 법인 이름 · 바뀌는 값(API 값) · 보존 정리는 되돌릴 수 없음(반증 F6) · Enterprise 비배포 · 토큰 없음 경고
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
const offEdge = { agent: 'OC2', enabled: true, hasUrl: true, snapAt: NOW - 60_000, enabledOnEdge: false, nodeRole: 'edge' };
const onEdge = { ...offEdge, enabledOnEdge: true };
const row = (o) => ({ agent: 'OC2', mode: 'off', state: 'off', excluded: false, perEdge: false, corps: ['vc-oc2'], savedCorps: null, corpsChanged: false, tokenIssued: true, ...o });
const pe = (o) => row({ mode: 'per-edge', perEdge: true, savedCorps: ['vc-oc2'], ...o });

describe('edgeOnView — 버튼 · 지시 상태(함께) · 이유', () => {
  it('배포 현황이 없는 사람(비관리자·범위 계정·엣지 노드)에게는 아무것도 없다', () => {
    expect(edgeOnView(offEdge, row(), { canManage: false })).toEqual({ actions: [], instr: null, note: '', offWhy: '' });
    expect(edgeOnView(offEdge, null, { canManage: true }).actions).toEqual([]);
  });
  it("'엣지에서 꺼짐' 행 + 로컬 모드 + 엣지 노드에만 켜기 버튼 · 켜져 있거나 보관분이 없으면 없다", () => {
    expect(edgeOnView(offEdge, row(), { canManage: true }).actions).toEqual(['on']);
    expect(edgeOnView(onEdge, row(), { canManage: true }).actions).toEqual([]);
    expect(edgeOnView({ ...offEdge, snapAt: null }, row(), { canManage: true }).actions).toEqual([]);
  });
  it('F7 — 엣지가 아닌 노드(중앙·단독)·역할을 모르는 노드에는 버튼이 없고, 사유는 노드 역할로 말한다', () => {
    for (const nodeRole of ['central', 'unknown', undefined]) expect(edgeOnView({ ...offEdge, nodeRole }, row(), { canManage: true }).actions, String(nodeRole)).toEqual([]);
    const c = edgePullState({ ...offEdge, nodeRole: 'central' }, { now: NOW });
    expect(c.why).toMatch(/이 노드는 엣지가 아닙니다/); expect(c.why).toMatch(/그 포탈의 베어메탈 사용률 설정에서 직접 켜세요/); expect(c.label).toBe('그 노드에서 꺼짐');
    expect(edgePullState({ ...offEdge, nodeRole: 'unknown' }, { now: NOW }).why).toMatch(/역할을 확인할 수 없어 중앙 켜기를 제공하지 않습니다/);
  });
  it('전체 배포·제외에 묶인 엣지는 버튼 대신 이유(서버도 409) — F5: 전체 배포가 끈 엣지는 배포 설정에서 바꾼다고 말한다', () => {
    const all = edgeOnView(offEdge, row({ mode: 'all', state: 'applied' }), { canManage: true });
    expect(all.actions).toEqual([]); expect(all.offWhy).toMatch(/중앙의 \*\*전체 배포 설정\*\*이 끄고 있습니다/);
    const es = edgePullState(offEdge, { now: NOW, offWhy: all.offWhy });
    expect(es.why).toBe(all.offWhy); expect(es.why).not.toMatch(/법인 포탈에서 켭니다/);
    const ex = edgeOnView(offEdge, row({ mode: 'excluded', state: 'excluded', excluded: true }), { canManage: true });
    expect(ex.actions).toEqual([]); expect(ex.note).toMatch(/제외를 먼저 해제/);
  });
  it('저장 뒤 — 지시 상태(켜기 지시됨 → 전달됨 → 적용됨)는 보관분 상태와 **함께** · 해제 버튼', () => {
    const p = (state, e = offEdge) => edgeOnView(e, pe({ state }), { canManage: true });
    for (const s of ['no-pull', 'pending']) {
      const v = p(s);
      expect(v.instr.label).toBe('켜기 지시됨 — 다음 인출 대기');
      expect(v.instr.why).toMatch(/다음 인출/);
      expect(v.actions).toEqual(['off']);
      expect(v.offWhy).toMatch(/엣지가 중앙 켜기를 받아 적용한 뒤/);
    }
    expect(p('no-pull').instr.why).toMatch(/2\.627 미만/);
    expect(p('delivered').instr.label).toBe('전달됨');
    expect(p('applied').instr.label).toBe('적용됨');
    // F8 — 보관분이 오래됐거나 마지막 시도가 실패해도 그 상태가 그대로 보인다(지시 상태가 덮지 않는다)
    const stale = { ...onEdge, snapAt: NOW - 3 * 3_600_000, lastAttempt: { ok: false, kind: 'timeout', reason: 'x' } };
    const v = edgeOnView(stale, pe({ state: 'unverified' }), { canManage: true });
    expect(v.instr.label).toMatch(/받지 못함/); expect(v.instr.tone).toBe('bad');
    expect(edgePullState(stale, { now: NOW, offWhy: v.offWhy }).state).toBe('stale-failed');
  });
  it('F2·F3 — 법인 매핑이 바뀌면 다시 확인 버튼과 사유 · 엣지는 저장 법인을 계속 받는다고 말한다', () => {
    const v = edgeOnView(onEdge, pe({ state: 'applied', corps: ['vc-oc2', 'vc-new'], corpsChanged: true }), { canManage: true });
    expect(v.actions).toEqual(['reconfirm', 'off']);
    expect(v.note).toMatch(/법인 매핑이 바뀌었습니다 — 다시 확인 필요/); expect(v.note).toMatch(/저장한 법인을 계속 받습니다/);
    expect(edgeOnView(onEdge, pe({ state: 'applied', corpsChanged: null }), { canManage: true }).actions).toEqual(['off'], '모르면 단정하지 않는다');
  });
  it('전체 배포에 가려짐 · 제외와 충돌 · 해제 대기를 조용히 두지 않는다', () => {
    const sup = edgeOnView(offEdge, pe({ mode: 'all', perEdgeSuperseded: true, state: 'applied' }), { canManage: true });
    expect(sup.note).toMatch(/전체 배포가 우선/); expect(sup.actions).toEqual(['off']); expect(sup.instr).toBe(null);
    const cf = edgeOnView(offEdge, pe({ mode: 'excluded', conflict: true, excluded: true, state: 'excluded' }), { canManage: true });
    expect(cf.note).toMatch(/제외가 우선/);
    const rel = edgeOnView(onEdge, row({ mode: 'off', state: 'releasing' }), { canManage: true });
    expect(rel.instr.label).toBe('해제 대기'); expect(rel.instr.why).toMatch(/엣지 로컬 설정으로 돌아갑니다/);
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
  it('법인 이름 · 저장 때 확정 · 주기·보존·경로·알림 값 · F6 보존 정리는 되돌릴 수 없음 · Enterprise 비배포', () => {
    const lines = edgeOnConfirmLines({ agent: 'OC2', distRow: row({ corps: ['vc-a', 'vc-b'] }), dist, vcName: (id) => ({ 'vc-a': '법인A' }[id]) });
    const all = lines.join('\n');
    expect(all).toMatch(/\*\*OC2\*\* 의 베어메탈 사용률 수집을 중앙에서 켭니다/);
    expect(all).toMatch(/다음 인출/);
    expect(all).toMatch(/켜지는 법인 \*\*2곳\*\*: 법인A · vc-b — 저장 때 이 목록으로 확정합니다/);
    expect(all).toMatch(/주기 · 보존 · OS SSH · iDRAC · 알림 값도 이 중앙의 값으로 바뀝니다/);
    expect(all).toMatch(/주기 7분 · 원시 보존 60일 · 일 롤업 400일 · OS SSH 끔 · iDRAC 텔레메트리 켬\(전수 끔\) · ESXi 호스트 포함 켬/);
    expect(all).toMatch(/알림 켬\(85% · 15분 지속 · 6시간 재알림\)/);
    expect(all).toMatch(/해제하면 엣지 로컬 설정으로 돌아갑니다/);
    expect(lines).toContain('⚠ 이 엣지의 보존 기간이 위 값보다 길면 넘친 이력은 정리되며, **해제해도 돌아오지 않습니다**.');
    expect(lines).toContain(DIST_ENTERPRISE_NOTE);
    expect(all).not.toMatch(/개별 토큰이 발급돼 있지 않습니다/);
    for (const l of lines) expect(l).not.toMatch(/`/);
  });
  it('다시 확인 — 저장된 법인과 지금 매핑을 나란히', () => {
    const all = edgeOnConfirmLines({ agent: 'OC2', distRow: pe({ corps: ['vc-a', 'vc-b'], savedCorps: ['vc-a'], corpsChanged: true }), dist, reconfirm: true }).join('\n');
    expect(all).toMatch(/법인을 \*\*다시 확인\*\*합니다/); expect(all).toMatch(/저장된 법인 1곳: vc-a/); expect(all).toMatch(/지금 매핑 \*\*2곳\*\*: vc-a · vc-b/);
  });
  it('법인 0 · 매핑 미확인 · 토큰 없음 · 값을 모르면 숫자를 지어내지 않는다', () => {
    expect(edgeOnConfirmLines({ agent: 'X', distRow: row({ corps: [] }), dist }).join('\n')).toMatch(/저장할 수 없습니다/);
    expect(edgeOnConfirmLines({ agent: 'X', distRow: row({ corps: null }), dist }).join('\n')).toMatch(/아직 확인하지 못했습니다/);
    expect(edgeOnConfirmLines({ agent: 'X', distRow: row({ tokenIssued: false }), dist }).join('\n')).toMatch(/개별 토큰이 발급돼 있지 않습니다/);
    const noBase = edgeOnConfirmLines({ agent: 'X', distRow: row(), dist: {} }).join('\n');
    expect(noBase).toMatch(/중앙의 값으로 바뀝니다/); expect(noBase).not.toMatch(/주기 \d+분 ·|원시 보존 \d/);
  });
  it('F4 — 해제 문구 · 저장 응답 문구는 해제 뒤 실제로 받는 설정을 말한다', () => {
    expect(edgeOffConfirmLines('OC2', pe({}))[0]).toMatch(/엣지 로컬 설정\*\*으로 돌아갑니다/);
    const allOff = edgeOffConfirmLines('OC2', pe({ mode: 'all', perEdgeSuperseded: true }))[0];
    expect(allOff).toMatch(/전체 배포가 계속 적용됩니다/); expect(allOff).not.toMatch(/로컬 설정\*\*으로 돌아갑니다/);
    expect(edgeOffConfirmLines('OC2', pe({ mode: 'excluded', conflict: true }))[0]).toMatch(/바뀌는 설정은 없습니다/);
    expect(edgeOnSavedText({ agent: 'OC2', on: true })).toMatch(/저장 즉시 켜지지 않습니다/);
    expect(edgeOnSavedText({ agent: 'OC2', on: true }, { reconfirm: true })).toMatch(/다시 확인해 저장했습니다/);
    expect(edgeOnSavedText({ agent: 'OC2', on: false, distribution: { rows: [row({ mode: 'off' })] } })).toMatch(/로컬 설정으로 돌아갑니다/);
    expect(edgeOnSavedText({ agent: 'OC2', on: false, distribution: { rows: [row({ mode: 'all' })] } })).toMatch(/전체 배포가 계속 적용됩니다/);
  });
});

describe('배포 요약·현황', () => {
  it("전체 배포가 꺼져 있어도 중앙 켜기 엣지가 있으면 '모두 각자 로컬' 이라 말하지 않는다 · 매핑 바뀜 · 버린 항목", () => {
    const d = { enabled: false, rows: [pe({ state: 'applied', corpsChanged: true }), row({ agent: 'B' }), row({ agent: 'C' })], perEdgeOmitted: 1, perEdgeMax: 256 };
    const s = distributionSummary(d);
    expect(s).toMatch(/중앙 켜기\(이 엣지만\) 1곳\*\*\(적용됨 1\)/);
    expect(s).toMatch(/나머지 2곳은 각자 로컬/);
    expect(s).toMatch(/법인 매핑이 바뀌었습니다 — 다시 확인 필요/);
    expect(s).toMatch(/1건은 법인이 없거나 상한\(256곳\)을 넘어 쓰지 않았습니다/);
    expect(distributionSummary({ enabled: false, rows: [row()] })).toMatch(/\*\*배포 꺼짐\*\* — 엣지 1곳은 각자 로컬/);
    const on = distributionSummary({ enabled: true, rows: [pe({ mode: 'all', perEdgeSuperseded: true, state: 'applied' })] });
    expect(on).toMatch(/전체 배포가 우선/);
    const c = distributionCounts({ rows: [row({ state: 'unverified', verified: false }), row({ state: 'releasing' })] });
    expect(c.notVerified).toBe(1); expect(c.unverified).toBe(1); expect(c.releasing).toBe(1);
    expect(findDistRow({ rows: [row()] }, 'oc2').agent).toBe('OC2');
    expect(findDistRow({ rows: [row()] }, '')).toBe(null);
  });
  it('서버 상태·모드 낱말 전부에 라벨(소스 대조 — 모르는 상태를 정상으로 칠하지 않는다)', () => {
    const src = fs.readFileSync(path.resolve(HERE, '../../../../server/src/bmusage/settings.js'), 'utf8');
    const body = src.slice(src.indexOf('export function distributionStatus'), src.indexOf('perEdgeOmitted: d.perEdgeOmitted'));
    const states = new Set([...body.matchAll(/state = '([a-z-]+)'/g)].map((m) => m[1]));
    for (const m of body.matchAll(/state = p\?\.deliveredSig \? '([a-z-]+)' : mode/g)) states.add(m[1]);
    states.add('off'); states.add('excluded');
    expect(states.size).toBeGreaterThanOrEqual(8);
    for (const s of states) expect(DIST_STATE[s]?.label, s).toBeTruthy();
    for (const m of ['all', 'per-edge', 'excluded', 'off']) expect(distModeLabel(m)).not.toBe('—');
    expect(distStateOf('zzz').label).toBe('확인 불가');
  });
  it('BmUsage.jsx — 버튼은 배포 현황(전체 범위 관리자 · 중앙)이 있을 때만 · 확인 상자를 거쳐 저장 · 화면 목록(corps)을 함께 보낸다', () => {
    const jsx = fs.readFileSync(path.join(HERE, 'BmUsage.jsx'), 'utf8');
    expect(jsx).toMatch(/edgeOnView\(r, findDistRow\(data\?\.distribution, r\.agent\), \{ canManage: !!data\?\.distribution \}\)/);
    expect(jsx).toMatch(/putJson\('\/tools\/bm-usage\/distribute\/edge', \{ agent, on, \.\.\.\(on && Array\.isArray\(corps\) \? \{ corps \} : \{\}\) \}\)/);
    expect((jsx.match(/saveEdgeOn\(/g) || []).length).toBe(2);   // 정의 1 + 확인 상자의 저장 버튼 1 — 표 버튼이 바로 저장하지 않는다
    expect(jsx).toMatch(/onClick=\{\(\) => saveEdgeOn\(edgeAsk\.agent, edgeAsk\.on, \{ corps: dr\?\.corps, reconfirm: !!edgeAsk\.reconfirm \}\)\}/);
    expect(jsx).toMatch(/const blocked = edgeAsk\.on && !\(Array\.isArray\(dr\?\.corps\) && dr\.corps\.length\);/, '법인을 모르거나 0 이면 저장 버튼을 열지 않는다');
    expect(jsx).not.toMatch(/ev\.override/, 'F8 — 지시 상태가 보관분 상태를 대체하지 않는다');
  });
  it('BmUsage.jsx — 400·409 응답(sendJson 은 던지지 않는다)을 성공으로 그리지 않는다(Chromium 409 가로채기에서 실제로 잡힌 결함)', () => {
    const jsx = fs.readFileSync(path.join(HERE, 'BmUsage.jsx'), 'utf8');
    for (const route of ["'/tools/bm-usage/distribute/edge'", "'/tools/bm-usage/distribute'"]) {
      const i = jsx.indexOf(`putJson(${route}`);
      expect(i, route).toBeGreaterThan(0);
      const after = jsx.slice(i, i + 600);
      expect(after, route).toMatch(/if \(r\?\.ok === false\)/);
      expect(after.indexOf('r?.ok === false'), route).toBeLessThan(after.indexOf('setData('));
    }
  });
});
