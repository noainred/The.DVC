/**
 * invCheckText.test.js — 인벤토리 점검 화면 문구 회귀(v2.570).
 *
 * 이 화면이 만들 수 있는 거짓을 문구 수준에서 고정한다. 판정(행 상태·KPI)은 서버가 소유하므로
 * (`portalcheck/invScan.js scanInventory`) 여기서는 **읽기만** 하는지와 문구의 정직성을 본다.
 */
import { describe, it, expect } from 'vitest';
import {
  INV_STATE, INV_STATE_LABEL, INV_STATE_TONE, invRowState, ageText, rowExplain,
  rejectKindLine, rejectKindLabel, unverifiedNote, agentRowExplain, findingLine, findingGroupLine,
  targetsText, findingCodesDeclared, bannerText, freshRateText, tableFootnotes, unauthRejectNotes,
} from './invCheckText.js';

describe('행 상태는 서버 값을 읽기만 한다', () => {
  it('서버가 준 state 를 그대로 쓴다', () => {
    expect(invRowState({ state: 'ok' })).toBe(INV_STATE.OK);
    expect(invRowState({ state: 'stale' })).toBe(INV_STATE.STALE);
    expect(invRowState({ state: 'rejected' })).toBe(INV_STATE.REJECTED);
  });
  it('값이 없거나 모르는 값이면 확인 불가다 — 초록 폴백을 만들지 않는다', () => {
    expect(invRowState({})).toBe(INV_STATE.UNKNOWN);
    expect(invRowState(null)).toBe(INV_STATE.UNKNOWN);
    expect(invRowState({ state: 'green' })).toBe(INV_STATE.UNKNOWN);
  });
  it('다섯 상태 모두 라벨·색이 있고, stale 은 초록이 아니다', () => {
    for (const s of Object.values(INV_STATE)) {
      expect(INV_STATE_LABEL[s]).toBeTruthy();
      expect(INV_STATE_TONE[s]).toBeTruthy();
    }
    expect(INV_STATE_TONE.stale).not.toBe('green'); // 이 화면의 존재 이유 — 낡음을 정상으로 칠하면 안 된다
    expect(INV_STATE_TONE.rejected).toBe('red');
  });
});

describe('ageText — Number(null)===0 함정을 피한다', () => {
  it('null·빈 문자열은 대시', () => {
    expect(ageText(null)).toBe('—');
    expect(ageText(undefined)).toBe('—');
    expect(ageText('')).toBe('—');
  });
  it('0 은 방금(0초 전이 아니다)', () => {
    expect(ageText(0)).toBe('방금');
  });
  it('경계값', () => {
    expect(ageText(59_000)).toBe('59초 전');
    expect(ageText(60_000)).toBe('1분 전');
    expect(ageText(3_600_000)).toBe('1시간 전');
    expect(ageText(86_400_000)).toBe('1일 전');
  });
});

describe('rowExplain — 상태별로 다른 문장, 조치가 다르면 문장도 다르다', () => {
  it('담당 엣지 미상은 그 사실을 말한다', () => {
    const line = rowExplain({ state: 'never', owner: null });
    expect(line).toContain('담당 엣지 미상');
  });
  it('정상 수신이어도 빈 push 면 함께 말한다', () => {
    const line = rowExplain({ state: 'ok', owner: 'edge-a', ageMs: 1000, emptyPush: true });
    expect(line).toContain('0입니다');
  });
  it('낡음은 기준 시간을 넘겼다는 사실을 말하고 정상과 다른 문장이다', () => {
    const stale = rowExplain({ state: 'stale', owner: 'edge-a', ageMs: 999_999 });
    const ok = rowExplain({ state: 'ok', owner: 'edge-a', ageMs: 1000 });
    expect(stale).not.toBe(ok);
    expect(stale).toContain('기준 시간을 넘겼습니다');
  });
  it('거부는 이름이 검증되지 않았다는 사실을 함께 말한다', () => {
    const line = rowExplain({ state: 'rejected', reject: { kind: 'mock', agent: 'x', reason: 'r' } });
    expect(line).toContain(unverifiedNote());
  });
});

describe('rejectKindLine — 종류마다 다른 조치', () => {
  it('mock 은 DATA_SOURCE 를 고치라고 한다', () => {
    expect(rejectKindLine({ kind: 'mock' })).toContain('DATA_SOURCE');
  });
  it('owner 는 토큰을 고치라고 하지 않는다(조치가 다르다)', () => {
    const line = rejectKindLine({ kind: 'owner', reason: 'x' });
    expect(line).not.toContain('토큰');
    expect(rejectKindLine({ kind: 'auth' })).toContain('토큰');
  });
  it('원문 사유가 있으면 함께 보여준다', () => {
    expect(rejectKindLine({ kind: 'owner', reason: '이유 원문' })).toContain('이유 원문');
  });
});

describe('agentRowExplain — 위임 담당 여부에 따라 결함/정보를 구분한다', () => {
  it('mock 자기보고는 항상 결함 문구', () => {
    expect(agentRowExplain({ mockReported: true })).toContain('mock');
  });
  it('인벤토리 전송 중이면 최근 값을 말한다', () => {
    const line = agentRowExplain({ sentInventory: true, lastHosts: 5, lastVms: 10, gzip: true });
    expect(line).toContain('5');
    expect(line).toContain('10');
    expect(line).not.toContain('무압축');
  });
  it('무압축이면 그 사실을 말한다', () => {
    expect(agentRowExplain({ sentInventory: true, lastHosts: 1, lastVms: 1, gzip: false })).toContain('무압축');
  });
  it('위임 담당인데 인벤토리를 안 보내면 결함 어조', () => {
    const line = agentRowExplain({ sentInventory: false, knownOwner: true, lastEndpoint: 'svcmon-report' });
    expect(line).toContain('위임 담당으로 등록돼 있는데');
  });
  it('위임 담당이 아니면 정상 구성일 수 있다고 말한다(오탐 방지)', () => {
    const line = agentRowExplain({ sentInventory: false, knownOwner: false, lastEndpoint: 'storage-data' });
    expect(line).toContain('정상 구성일 수 있습니다');
  });
});

describe('발견 코드 ↔ 문구 1:1', () => {
  it('선언된 코드 목록이 서버 상수와 이름이 겹친다(형식 확인)', () => {
    const codes = findingCodesDeclared();
    expect(codes).toContain('inv-stale');
    expect(codes).toContain('inv-never');
    expect(codes).toContain('inv-reject-mock');
    expect(codes).toContain('inv-agent-no-inventory');
    expect(codes.length).toBeGreaterThan(5);
  });
  it('모르는 코드는 원본 코드를 그대로 보여준다(무음 실패 금지)', () => {
    expect(findingLine({ code: 'never-seen-code', target: 'x' })).toContain('never-seen-code');
  });
  it('findingGroupLine 은 대상 목록·개수를 함께 낸다', () => {
    const line = findingGroupLine({ code: 'inv-never', count: 3, targets: ['a', 'b', 'c'] });
    expect(line).toContain('3곳');
    expect(line).toContain('a');
    expect(line).toContain('c');
  });
});

describe('targetsText — 상한을 넘기면 잘린 개수를 밝힌다', () => {
  it('짧으면 전부 나열', () => {
    expect(targetsText(['a', 'b'])).toBe('a · b');
  });
  it('길면 자르고 개수를 말한다(조용한 상한 금지)', () => {
    const many = Array.from({ length: 10 }, (_, i) => `v${i}`);
    const out = targetsText(many, 3);
    expect(out).toContain('외 7곳');
  });
});

describe('bannerText — 판정 순서와 KPI 항등식을 따른다', () => {
  it('대상 0 이면 그 사실만 말한다', () => {
    expect(bannerText({ kpis: { total: 0 } }).tone).toBe('gray');
  });
  it('거부가 있으면 낡음·미수신보다 먼저 말한다(가장 위험)', () => {
    const b = bannerText({ kpis: { total: 5, rejected: 1, stale: 2, never: 1 } });
    expect(b.tone).toBe('red');
    expect(b.text).toContain('거부');
  });
  it('거부 없이 낡음만 있으면 amber', () => {
    const b = bannerText({ kpis: { total: 3, rejected: 0, stale: 1, never: 0 } });
    expect(b.tone).toBe('amber');
    expect(b.text).toContain('낡았습니다');
  });
  it('전부 정상이면 초록', () => {
    const b = bannerText({ kpis: { total: 2, ok: 2, measured: 2, rejected: 0, stale: 0, never: 0, emptyPush: 0 } });
    expect(b.tone).toBe('green');
  });
});

describe('freshRateText — 분모는 measured, 0이면 null(0%가 아니다)', () => {
  it('measured 0 이면 대시', () => {
    expect(freshRateText({ freshPct: null })).toBe('—');
  });
  it('값이 있으면 %', () => {
    expect(freshRateText({ freshPct: 87 })).toBe('87%');
  });
});

describe('tableFootnotes — 해당 종류가 있을 때만 만든다(v2.509 규약)', () => {
  it('아무 조건도 없으면 빈 배열', () => {
    expect(tableFootnotes({ rows: [], agents: [] })).toEqual([]);
  });
  it('담당 미상 행이 있으면 각주 1건', () => {
    const notes = tableFootnotes({ rows: [{ state: 'never', owner: null }], agents: [] });
    expect(notes.some((x) => x.includes('담당 엣지 미상'))).toBe(true);
  });
  it('거부 상태 행이 있으면 이름 미검증 각주', () => {
    const notes = tableFootnotes({ rows: [{ state: 'rejected', owner: 'a' }], agents: [] });
    expect(notes.some((x) => x.includes('검증되지 않았습니다'))).toBe(true);
  });
});

describe('v2.599 WEB2599-04 — 거부 종류 unknown-route', () => {
  it('없는 경로는 수신 꺼짐과 다른 조치를 말한다', () => {
    const line = rejectKindLine({ kind: 'unknown-route' });
    expect(line).toContain('없는 경로');
    expect(line).not.toContain('비활성');
    expect(rejectKindLabel('unknown-route')).toBe('없는 경로');
    expect(rejectKindLabel('disabled')).toBe('수신 꺼짐');
    expect(rejectKindLabel('new-kind')).toBe('new-kind');
    expect(rejectKindLabel('')).toBe('—');
  });
});

describe('v2.600 WEB2600-02·05 — 전부 거부된 엣지·등록부 밖 vCenter', () => {
  it('전부 거부된 엣지는 거부 사유와 미검증 사실을 말한다', () => {
    const line = agentRowExplain({ rejectedOnly: true, rejectedInventory: true, rejects: { total: 4, lastKind: 'bad-request', lastReason: 'vcenterId 없음' } });
    expect(line).toContain('전부 거부');
    expect(line).toContain('4건');
    expect(line).toContain('형식 오류');
    expect(line).toContain(unverifiedNote());
  });
  it('각주 — 전부 거부·인증 실패 칸을 밝히고, 거부 엣지를 \'다른 용도 엣지\' 로 설명하지 않는다', () => {
    const f = tableFootnotes({ rows: [], agents: [{ rejectedOnly: true, sentInventory: false, knownOwner: false }], unauthRejects: 7 });
    expect(f.some((x) => x.includes('전부 거부됨'))).toBe(true);
    expect(f.some((x) => x.includes('7건'))).toBe(true);
    expect(f.some((x) => x.includes('다른 용도로만'))).toBe(false);
  });
  it('새 발견 코드 두 개의 문구가 있다', () => {
    expect(findingCodesDeclared()).toEqual(expect.arrayContaining(['inv-agent-rejected-only', 'inv-unregistered-vcenter']));
    expect(findingLine({ code: 'inv-unregistered-vcenter', target: 'vc-x' })).toContain('등록부에 없는');
  });
});

describe('v2.602 WEB2602-02 — 인증 전 거부를 종류별로 말한다', () => {
  it('수신 꺼짐·없는 경로는 토큰 문구로 뭉개지 않는다', () => {
    const lines = unauthRejectNotes({ unauthRejects: 6, unauthRejectsByKind: { auth: 1, disabled: 3, 'unknown-route': 2 } });
    expect(lines).toHaveLength(3);
    expect(lines.filter((x) => x.includes('토큰 점검에서'))).toHaveLength(1);
    expect(lines.find((x) => x.includes('**1건**'))).toContain('토큰 인증에 실패');
    expect(lines.find((x) => x.includes('**3건**'))).toContain('수신이 꺼져');
    expect(lines.find((x) => x.includes('**2건**'))).toContain('없는 경로');
  });
  it('전부 disabled 면 토큰 대조를 안내하지 않는다', () => {
    const f = tableFootnotes({ rows: [], agents: [], unauthRejects: 3, unauthRejectsByKind: { disabled: 3 } });
    expect(f.some((x) => x.includes('토큰 점검에서'))).toBe(false);
    expect(f.some((x) => x.includes('3건'))).toBe(true);
  });
  it('종류를 모르면 원인을 단정하지 않는다', () => {
    const [line] = unauthRejectNotes({ unauthRejects: 4 });
    expect(line).toContain('4건');
    expect(line).not.toContain('토큰 인증에 실패');
  });
});
