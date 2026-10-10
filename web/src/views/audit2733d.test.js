// v2.733 점검 3회차 그룹 d — 읽지 못해 합계에서 뺀 것을 화면이 말한다(C2-02 vCenter 추정 전력 · C2-06 호스트 용량).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vcPowerSkippedNote, capacityUnknownNote, ratioText, VC_POWER_SKIP_REASON_TEXT } from './readGapText.js';
import { restFallbackBadge } from './restFallbackText.js';
import { cellTitle } from './compareMatrixText.js';

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../server/src');

describe('C2-02 vCenter 추정 전력 제외 문구', () => {
  it('뺀 것이 없으면 null(조용히 아무 말도 하지 않는다 — 문구가 화면을 덮지 않게)', () => {
    expect(vcPowerSkippedNote(null)).toBe(null);
    expect(vcPowerSkippedNote({ hosts: 0, byReason: {} })).toBe(null);
    expect(vcPowerSkippedNote(undefined)).toBe(null);
  });
  it('개수와 사유를 말하고 "소비가 줄었다" 로 읽히지 않게 한다', () => {
    const t = vcPowerSkippedNote({ hosts: 4, vcenters: 4, byReason: { unreachable: 1, maintenance: 1, stale: 1, 'host-unread': 1 } });
    expect(t).toContain('4대');
    expect(t).toContain('연결 실패');
    expect(t).toContain('점검중');
    expect(t).toContain('엣지 보고 낡음');
    expect(t).toContain('호스트 연결 끊김');
    expect(t).toContain('줄었다는 뜻이 아닙니다');
    expect(t).not.toMatch(/`/);
  });
  it('사유 키는 서버 vcPowerSkipReason 의 반환값과 1:1 이다', () => {
    const src = fs.readFileSync(path.join(SERVER, 'idrac/service.js'), 'utf8');
    const m = src.match(/@returns \{([^}]+)\}\s*\*\/\s*export function vcPowerSkipReason/);
    expect(m, 'vcPowerSkipReason 의 @returns 선언').toBeTruthy();
    const serverKeys = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
    expect(Object.keys(VC_POWER_SKIP_REASON_TEXT).sort()).toEqual(serverKeys);
    // vCenter 사유 셋은 leaf 판정(metrics/unreadVcenters.js)의 값이다
    const leaf = fs.readFileSync(path.join(SERVER, 'metrics/unreadVcenters.js'), 'utf8');
    for (const k of ['maintenance', 'unreachable', 'stale']) expect(leaf).toContain(`'${k}'`);
  });
});

describe('C2-06 호스트 용량을 못 읽음', () => {
  it('capacityUnknownNote — 0·없음은 null, 있으면 개수와 "—" 의 이유', () => {
    expect(capacityUnknownNote(0)).toBe(null);
    expect(capacityUnknownNote(null)).toBe(null);
    const t = capacityUnknownNote(2);
    expect(t).toContain('2대');
    expect(t).toContain('REST 폴백');
    expect(t).not.toMatch(/`/);
  });
  it("ratioText — null 은 '—'(0:1 이 아니다)", () => {
    expect(ratioText(null)).toBe('—');
    expect(ratioText(undefined)).toBe('—');
    expect(ratioText(2)).toBe('2:1');
    expect(ratioText(0)).toBe('0:1');
  });
  it('REST 폴백 배지가 새 키를 라벨로 말한다(키 이름을 그대로 보이지 않는다)', () => {
    const b = restFallbackBadge({ collectSource: 'rest', restUnknown: ['cluster', 'hostCapacity', 'dsCapacity', 'alarms'] });
    expect(b.title).toContain('호스트 용량');
    expect(b.title).toContain('데이터스토어 용량');
    expect(b.title).not.toContain('hostCapacity');
    expect(b.title).not.toContain('dsCapacity');
  });
  it('서버 restClient 가 싣는 restUnknown 키는 전부 화면 라벨이 있다', () => {
    const src = fs.readFileSync(path.join(SERVER, 'vcenter/restClient.js'), 'utf8');
    const keys = [...src.matchAll(/restUnknown\.push\('([^']+)'\)/g)].map((x) => x[1]);
    expect(keys).toContain('hostCapacity');
    const b = restFallbackBadge({ collectSource: 'rest', restUnknown: keys });
    for (const k of keys) expect(b.title, k).not.toContain(k);
  });
  it('비교 매트릭스 셀 툴팁이 용량 미상 개수를 말한다', () => {
    const t = cellTitle({ rowName: 'CL', vcName: 'R', metric: { label: 'vCPU:코어' }, value: null, cell: { hosts: 2, vms: 2, vmsOn: 2, capacityUnknown: 2 } });
    expect(t).toContain('용량을 읽지 못한 호스트 2대');
    const t2 = cellTitle({ rowName: 'CL', vcName: 'S', metric: { label: 'vCPU:코어' }, value: 2, cell: { hosts: 1, vms: 1, vmsOn: 1 } });
    expect(t2).not.toContain('용량을 읽지 못한');
  });
});
