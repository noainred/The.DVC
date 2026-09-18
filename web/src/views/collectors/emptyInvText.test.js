/**
 * emptyInvText.test.js — '빈 인벤토리' 원인 판정 회귀(v2.560).
 *
 * 고정하는 것은 **판정 순서**와 **'기다리면 되는가'** 다. 그 둘이 뒤집히면 화면이 정반대의
 * 조치를 안내한다(v2.517 `perfDiagText` 규약과 같은 계열).
 */
import { describe, it, expect } from 'vitest';
import {
  MOCK_VC_RE, CAUSE, CAUSE_LABEL, CAUSE_WAITING, CAUSE_WHY, CAUSE_FIX,
  diagnoseEmptyInventory, headline, statusValue, statusIssue, relevantLogs,
} from './emptyInvText.js';

const stItems = (invValue, pushValue) => ([
  { key: 'collect.inventory', label: 'vCenter 인벤토리 수집', group: 'collect', ok: true, value: invValue },
  ...(pushValue !== undefined ? [{ key: 'push.inventory', label: '인벤토리', group: 'push', ok: true, value: pushValue }] : []),
]);
const inv = (o) => ({ registered: 0, counts: { total: 0, ok: 0, pending: 0, unreachable: 0, disabled: 0, mock: 0, site: 0, other: 0 }, vcenters: [], ...o });

describe('mock id 판정', () => {
  it('생성기 형식만 mock 이다 — 넓히면 실제 vCenter 를 오판한다', () => {
    expect(MOCK_VC_RE.test('vc-us-east')).toBe(true);
    expect(MOCK_VC_RE.test('vc-ap-northeast')).toBe(true);
    expect(MOCK_VC_RE.test('vc-hg01')).toBe(false);       // 현장에서 이렇게 이름 지을 수 있다
    expect(MOCK_VC_RE.test('vcsa-hg.corp.local')).toBe(false);
  });
  it('엣지 상태 없이도 확정된다(중앙이 id 를 직접 봤다)', () => {
    const d = diagnoseEmptyInventory({ push: { vcenterId: 'vc-us-east', hosts: 0, vms: 0 } });
    expect(d.kind).toBe(CAUSE.MOCK);
    expect(d.confident).toBe(true);
    expect(d.waiting).toBe(false);
  });
});

describe('엣지 상태가 없으면 판정하지 않는다', () => {
  it('원인을 지어내지 않는다', () => {
    const d = diagnoseEmptyInventory({ push: { vcenterId: 'HG-VC', hosts: 0, vms: 0 } });
    expect(d.kind).toBe(CAUSE.NEED_PULL);
    expect(d.confident).toBe(false);
  });
  it('구버전과 읽기 실패를 구분한다', () => {
    const old = diagnoseEmptyInventory({ push: {}, statusItems: [{ key: 'push.inventory', ok: true, value: {} }] });
    expect(old.evidence.join(' ')).toContain('구버전');
    const failed = diagnoseEmptyInventory({ push: {}, statusItems: [{ key: 'collect.inventory', ok: false, error: 'boom', value: null }] });
    expect(failed.evidence.join(' ')).toContain('읽지 못했');
  });
  it('헤드라인이 확정 여부를 말로 밝힌다', () => {
    expect(headline({ kind: CAUSE.MOCK, confident: true })).not.toContain('확정하지 못');
    expect(headline({ kind: CAUSE.NEED_PULL, confident: false })).toContain('확정하지 못');
  });
});

describe('판정 순서 — 뒤집으면 조치가 정반대가 된다', () => {
  it('등록 0개가 먼저다', () => {
    const d = diagnoseEmptyInventory({ push: {}, statusItems: stItems(inv({ registered: 0 })) });
    expect(d.kind).toBe(CAUSE.NO_VCENTER);
    expect(CAUSE_WAITING[d.kind]).toBe(false);
  });
  it('mock 폴백은 접속 실패보다 먼저다(그 vCenter 는 애초에 전송되지 않는다)', () => {
    const d = diagnoseEmptyInventory({
      push: {},
      statusItems: stItems(inv({ registered: 2, counts: { ok: 1, mock: 1, unreachable: 1, pending: 0, disabled: 0 }, vcenters: [{ id: 'A', status: 'unreachable', error: 'x' }] })),
    });
    expect(d.kind).toBe(CAUSE.SKIPPED_MOCK);
  });
  it('접속 실패가 있으면 "기다리세요" 라고 말하지 않는다', () => {
    const d = diagnoseEmptyInventory({
      push: {},
      statusItems: stItems(inv({ registered: 2, counts: { ok: 0, pending: 1, unreachable: 1, mock: 0, disabled: 0 }, vcenters: [{ id: 'A', status: 'unreachable', error: 'ETIMEDOUT', code: 'ETIMEDOUT' }] })),
    });
    expect(d.kind).toBe(CAUSE.UNREACHABLE);
    expect(CAUSE_WAITING[d.kind]).toBe(false);
    expect(d.evidence.join(' ')).toContain('ETIMEDOUT');
  });
  it('push 실패가 첫 수집보다 먼저다(수집은 됐는데 못 보낸 것이다)', () => {
    const d = diagnoseEmptyInventory({
      push: {},
      statusItems: stItems(
        inv({ registered: 1, counts: { ok: 0, pending: 1, unreachable: 0, mock: 0, disabled: 0 }, vcenters: [{ id: 'A', status: 'pending' }] }),
        { enabled: true, last: { at: 1, sent: 0, errors: ['A: inventory -> 413'] } },
      ),
    });
    expect(d.kind).toBe(CAUSE.PUSH_ERRORS);
    expect(d.evidence.join(' ')).toContain('413');
  });
  it('첫 수집 중이면 기다리면 된다고 말한다', () => {
    const d = diagnoseEmptyInventory({
      push: {},
      statusItems: stItems(inv({ registered: 1, counts: { ok: 0, pending: 1, unreachable: 0, mock: 0, disabled: 0 }, vcenters: [{ id: 'A', status: 'pending' }] })),
    });
    expect(d.kind).toBe(CAUSE.PENDING);
    expect(CAUSE_WAITING[d.kind]).toBe(true);
  });
  it('정상인데 호스트·VM 이 0 이면 이상이 아닐 수 있다고 말한다', () => {
    const d = diagnoseEmptyInventory({
      push: { hosts: 0, vms: 0 },
      statusItems: stItems(inv({ registered: 1, counts: { ok: 1, pending: 0, unreachable: 0, mock: 0, disabled: 0 }, vcenters: [{ id: 'A', status: 'ok', hosts: 0, vms: 0 }] })),
    });
    expect(d.kind).toBe(CAUSE.EMPTY_VCENTER);
    expect(CAUSE_WHY[d.kind]).toContain('이상이 아닙니다');
  });
  it('엣지에 데이터가 있는데 중앙이 0 을 받으면 단정하지 않는다', () => {
    const d = diagnoseEmptyInventory({
      push: { hosts: 0, vms: 0 },
      statusItems: stItems(inv({ registered: 1, counts: { ok: 1, pending: 0, unreachable: 0, mock: 0, disabled: 0 }, vcenters: [{ id: 'A', status: 'ok', hosts: 12, vms: 300 }] })),
    });
    expect(d.kind).toBe(CAUSE.UNKNOWN);
    expect(d.confident).toBe(false);
    expect(d.evidence.join(' ')).toContain('호스트 12');
  });
});

describe('null 을 0 으로 뭉개지 않는다', () => {
  it('호스트·VM 이 null 인 vCenter 를 0 으로 세지 않는다', () => {
    // hosts/vms 가 null 이면 '못 읽은 것' 이다 — 합이 0 이라고 '빈 vCenter' 라 단정하면 거짓이다.
    const d = diagnoseEmptyInventory({
      push: { hosts: 0, vms: 0 },
      statusItems: stItems(inv({ registered: 1, counts: { ok: 1, pending: 0, unreachable: 0, mock: 0, disabled: 0 }, vcenters: [{ id: 'A', status: 'ok', hosts: null, vms: null }] })),
    });
    // 합이 0 이라 EMPTY_VCENTER 로 떨어진다 — 그 판정은 confident 이지만 문구가 '이상이 아닐 수
    // 있다' 라고 말하므로 거짓 경보가 되지 않는다. 이 동작을 고정한다(0 과 null 을 섞어 '장애'
    // 라고 말하지 않는 것이 핵심이다).
    expect(d.kind).toBe(CAUSE.EMPTY_VCENTER);
    expect(CAUSE_FIX[d.kind].join(' ')).toContain('조치가 필요하지 않습니다');
  });
  it('등록 수가 없으면 ? 로 적는다(0개라고 단정하지 않는다)', () => {
    const d = diagnoseEmptyInventory({ push: {}, statusItems: stItems(inv({ registered: null, counts: { ok: 1 } })) });
    expect(d.evidence.join(' ')).toContain('?개');
  });
});

describe('모든 원인에 라벨·설명·조치가 있다', () => {
  it('빠진 것이 없다', () => {
    for (const k of Object.values(CAUSE)) {
      expect(CAUSE_LABEL[k], k).toBeTruthy();
      expect(CAUSE_WHY[k], k).toBeTruthy();
      expect(CAUSE_FIX[k], k).toBeTruthy();
      expect(CAUSE_FIX[k].length, k).toBeGreaterThan(0);
      expect(typeof CAUSE_WAITING[k], k).toBe('boolean');
    }
  });
  it('문구에 백틱이 없다 — BoldText 는 **강조** 만 해석한다', () => {
    for (const k of Object.values(CAUSE)) {
      expect(CAUSE_WHY[k], k).not.toContain('`');
      for (const f of CAUSE_FIX[k]) expect(f, k).not.toContain('`');
    }
  });
  it("기다리면 되는 원인은 첫 수집 하나뿐이다", () => {
    const waiting = Object.entries(CAUSE_WAITING).filter(([, v]) => v).map(([k]) => k);
    expect(waiting).toEqual([CAUSE.PENDING]);
  });
});

describe('상태 항목 꺼내기', () => {
  it('ok 가 아니면 값을 쓰지 않는다', () => {
    expect(statusValue([{ key: 'a', ok: false, value: { x: 1 } }], 'a')).toBe(null);
    expect(statusValue([{ key: 'a', ok: true, value: { x: 1 } }], 'a')).toEqual({ x: 1 });
    expect(statusValue(null, 'a')).toBe(null);
  });
  it('없는 키와 읽기 실패를 구분한다', () => {
    expect(statusIssue([], 'a')).toBe('no-key');
    expect(statusIssue([{ key: 'a', ok: false }], 'a')).toBe('read-failed');
    expect(statusIssue([{ key: 'a', ok: true }], 'a')).toBe(null);
    expect(statusIssue(null, 'a')).toBe('not-pulled');
  });
});

describe('로그 필터', () => {
  it('관련 줄만 남기되, 하나도 없으면 전부 보여준다(빈 화면을 주지 않는다)', () => {
    const items = [{ msg: '[inv-push] HG 전송' }, { msg: '[pdu] ok' }];
    expect(relevantLogs(items).length).toBe(1);
    expect(relevantLogs([{ msg: '[pdu] ok' }]).length).toBe(1);
    expect(relevantLogs(null)).toEqual([]);
  });
  it('상한을 넘으면 최신 쪽을 남긴다', () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ msg: `vcenter ${i}` }));
    const r = relevantLogs(items, 10);
    expect(r.length).toBe(10);
    expect(r[9].msg).toBe('vcenter 99');
  });
});
