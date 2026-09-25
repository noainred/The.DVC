/**
 * partFaultText.test.js — 파트 장애 화면 문구·판정(v2.547).
 *
 * 웹 테스트는 node 환경(DOM 없음)이라 컴포넌트를 렌더할 수 없다 — 그래서 **판정과 문구**를
 * 순수 모듈에 두고 여기서 고정한다. 이 파일이 지키는 것은 한 문장으로 요약된다:
 * **'장애 0건' 을 '정상' 이라고 말할 수 있는 경우는 매우 좁다.**
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  historyEmptyText, kpiValue, kpiAccent,
  ageText, intervalText, scanNote, emptyDiag, edgeNote,
  keyKindNote, holdText, holdNote, eventText, notifyNote, lastRunText, toneVar,
  deviceKeyNote, tableFootnotes, keyKindMark, deviceKeyMark, edgeScanTotals, resetNote, pushNote, EDGE_KIND_LABEL, EDGE_KIND_TONE,
} from './partFaultText.js';

const scanned = (over = {}) => ({
  idrac: { devices: 10, ok: 10, failed: 0, stale: 0, unreachable: 0, legacy: 0, partial: 0, parts: 300, capped: 0 },
  storage: { devices: 2, ok: 2, failed: 0, parts: 20, notCollected: {} },
  sanswitch: { devices: 0, ok: 0, failed: 0, parts: 0, notCollected: {}, notJudged: 0 },
  summary: { total: 320, ok: 320, warn: 0, fault: 0, unknown: 0, absent: 0 },
  ...over,
});
const poller = (over = {}) => ({ enabled: true, intervalMs: 600_000, busy: false, last: { at: Date.now() - 60_000, ms: 120, stats: { opened: 0, closed: 0, changed: 0 }, local: scanned() }, ...over });

describe('ageText — null 을 0 으로 바꾸지 않는다(Number(null)===0 함정)', () => {
  it('값이 없으면 —', () => {
    expect(ageText(null)).toBe('—');
    expect(ageText(undefined)).toBe('—');
    expect(ageText('x')).toBe('—');
  });
  it('구간별 단위', () => {
    expect(ageText(5_000)).toBe('5초 전');
    expect(ageText(120_000)).toBe('2분 전');
    expect(ageText(7_200_000)).toBe('2시간 전');
    expect(ageText(2 * 86_400_000)).toBe('2일 전');
  });
});

describe('intervalText — 주기 숫자를 문구에 박지 않는다(서버 값만 쓴다)', () => {
  it('분/시간', () => {
    expect(intervalText(600_000)).toBe('10분');
    expect(intervalText(7_200_000)).toBe('2시간');
    expect(intervalText(null)).toBe('');
  });
});

describe('scanNote — 확인 불가·빈 슬롯을 따로 말한다', () => {
  it('정상일 때는 군더더기를 붙이지 않는다', () => {
    const n = scanNote(scanned());
    expect(n.text).toContain('장비 12/12대');
    expect(n.text).not.toContain('빈 슬롯');
    expect(n.unknown).toBe(0);
  });
  it('unknown/absent/failed 를 각각 밝히고, 못 본 이유(불통/낡음)와 부분 실패를 나눈다(v2.548 F1)', () => {
    const n = scanNote(scanned({
      idrac: { devices: 10, ok: 8, failed: 2, stale: 1, unreachable: 1, legacy: 0, partial: 3, parts: 240, capped: 0 },
      sanswitch: { devices: 1, ok: 1, failed: 0, parts: 4, notCollected: {}, notJudged: 20 },
      summary: { total: 260, ok: 240, warn: 0, fault: 3, unknown: 5, absent: 12 },
    }));
    expect(n.failed).toBe(2);
    expect(n.text).toContain('2대는 보지 못했습니다');
    expect(n.text).toContain('불통 1대');
    expect(n.text).toContain('낡음 1대');
    expect(n.text).toContain('일부 부품 종류를 못 읽은 서버 3대');
    expect(n.text).toContain('링크 없는 SAN 포트 20개는 판정 대상 아님');
    expect(n.text).toContain('상태를 읽지 못한 부품 5개');
    expect(n.text).toContain('빈 슬롯 12개');
    expect(n.text).toContain('고장이 아닙니다');
  });
  it('없으면 지어내지 않는다', () => {
    expect(scanNote(null)).toBeNull();
  });
});

describe('emptyDiag — 빈 목록의 이유를 한 문구로 덮지 않는다', () => {
  it('장애가 있으면 진단을 만들지 않는다', () => {
    expect(emptyDiag({ open: [{}] }).kind).toBe('has');
  });
  it('DB 를 못 열면 "정상으로 읽지 마세요" 라고 말한다', () => {
    const d = emptyDiag({ open: [], db: { available: false, error: 'no sqlite' } });
    expect(d.kind).toBe('db');
    expect(d.tone).toBe('bad');
    expect(d.text).toContain('정상으로 읽지 마세요');
  });
  it('엣지 노드에서는 중앙에서 보라고 안내한다(여기서 비는 것이 정상)', () => {
    const d = emptyDiag({ open: [], role: 'edge', db: { available: true }, poller: poller() });
    expect(d.kind).toBe('edge-node');
  });
  it('꺼져 있으면 "켜면 된다", 첫 주기면 "기다리면 된다" — 둘을 구분한다', () => {
    const off = emptyDiag({ open: [], db: { available: true }, poller: { enabled: false, last: null } });
    expect(off.kind).toBe('disabled');
    expect(off.waiting).toBe(false);          // 켜지 않으면 기다려도 안 된다
    const first = emptyDiag({ open: [], db: { available: true }, poller: { enabled: true, last: null } });
    expect(first.kind).toBe('first');
    expect(first.waiting).toBe(true);
  });
  it('직전 점검이 실패했으면 사유를 그대로 싣는다', () => {
    const d = emptyDiag({ open: [], db: { available: true }, poller: poller({ last: { at: Date.now(), error: 'boom' } }) });
    expect(d.kind).toBe('error');
    expect(d.text).toContain('boom');
  });
  it('전 장비를 못 봤으면 "장애가 없는 것이 아니라 확인하지 못한 것"', () => {
    const d = emptyDiag({
      open: [], db: { available: true },
      poller: poller({ last: { at: Date.now(), ms: 1, stats: {}, local: scanned({ idrac: { devices: 10, ok: 0, failed: 10, parts: 0, capped: 0 }, storage: { devices: 0, ok: 0, failed: 0, parts: 0, notCollected: {} }, summary: { total: 0 } }) } }),
    });
    expect(d.kind).toBe('all-failed');
    expect(d.text).toContain('확인하지 못한 것');
  });
  it('일부라도 못 봤으면 "전부 정상" 이라고 말하지 않는다', () => {
    const d = emptyDiag({
      open: [], db: { available: true },
      poller: poller({ last: { at: Date.now(), ms: 1, stats: {}, local: scanned({ idrac: { devices: 10, ok: 9, failed: 1, parts: 270, capped: 0 }, summary: { total: 290, unknown: 3 } }) } }),
      edges: { rows: [{ agent: 'OC2SDBX', kind: 'silent' }, { agent: 'HB', kind: 'old-version' }], counts: { silent: 1, 'old-version': 1 } },
    });
    expect(d.kind).toBe('partial');
    expect(d.text).toContain("'전부 정상' 이라고는 말할 수 없습니다");
    expect(d.text).toContain('보고가 없는 엣지 1곳');
    expect(d.text).toContain('구버전 엣지 1곳');
  });
  it('정말로 전부 확인했을 때만 "정상" 이라고 말한다', () => {
    const d = emptyDiag({ open: [], db: { available: true }, poller: poller(), edges: { rows: [{ agent: 'A', kind: 'fresh' }], counts: { fresh: 1 } } });
    expect(d.kind).toBe('ok');
    expect(d.tone).toBe('ok');
  });
});

describe('edgeNote — 보고 없음을 구버전/무보고/오래됨/구 프로토콜로 나눈다(v2.548)', () => {
  const edges = (counts, rows = []) => ({ rows, counts, minVersion: '2.548.0' });
  it('구버전은 "업그레이드 전까지 보이지 않는다", 무보고는 "모름" 이라고 적는다', () => {
    const n = edgeNote(edges({ fresh: 1, 'old-version': 2, silent: 1 }, [{ agent: 'a', kind: 'fresh' }, { agent: 'b', kind: 'old-version' }, { agent: 'c', kind: 'old-version' }, { agent: 'd', kind: 'silent' }]));
    expect(n.total).toBe(4);
    expect(n.notFresh).toBe(3);
    expect(n.tone).toBe('warn');
    expect(n.text).toContain('구버전 2곳');
    expect(n.text).toContain('업그레이드 전까지');
    expect(n.text).toContain("'장애 없음' 이 아니라 '모름'");
  });
  it('구 프로토콜은 "해소를 판정하지 못한다", 오래됨은 "해소로 처리하지 않는다"', () => {
    const n = edgeNote(edges({ legacy: 1, stale: 1 }, [{ agent: 'a', kind: 'legacy' }, { agent: 'b', kind: 'stale' }]));
    expect(n.text).toContain('해소를 판정하지 못합니다');
    expect(n.text).toContain('해소로 처리하지 않습니다');
  });
  it('소유권 불일치로 버린 장비 수를 숨기지 않는다(F5)', () => {
    const n = edgeNote(edges({ fresh: 1 }, [{ agent: 'a', kind: 'fresh', rejected: 3 }]));
    expect(n.text).toContain('버린 장비 3대');
  });
  it('전부 정상 보고면 ok, 위임이 없으면 muted', () => {
    expect(edgeNote(edges({ fresh: 2 }, [{ kind: 'fresh' }, { kind: 'fresh' }])).tone).toBe('ok');
    expect(edgeNote(null).tone).toBe('muted');
    expect(edgeNote(null).text).toContain('엣지 위임 없음');
  });
  it('라벨·톤 표는 서버 classifyEdges 의 kind 와 글자 그대로 짝이다', () => {
    const here = path.dirname(new URL(import.meta.url).pathname);
    const src = fs.readFileSync(path.join(here, '../../../../server/src/routes/api/partFaults.js'), 'utf8');
    for (const k of Object.keys(EDGE_KIND_LABEL)) {
      expect(src.includes(`'${k}'`)).toBe(true);
      expect(EDGE_KIND_TONE[k]).toBeTruthy();
    }
  });
});

describe('pushNote — 엣지가 왜 안 보내는지를 각각 말한다(v2.548)', () => {
  const base = { configured: true, enabled: true, source: 'edge-central', last: null };
  it('토큰 없음 / 꺼짐 / 첫 push 대기 / 정상 / 403 / 413 / 그 밖 실패가 서로 다른 kind', () => {
    expect(pushNote({ ...base, configured: false }).kind).toBe('unconfigured');
    expect(pushNote({ ...base, enabled: false, source: 'default' }).kind).toBe('disabled');
    expect(pushNote({ ...base, enabled: false, source: 'default' }).text).toContain('아직 내려오지 않았습니다');
    expect(pushNote(base).kind).toBe('first');
    expect(pushNote({ ...base, last: { ok: true, at: 1000, devices: 3, open: 1 } }, 61_000).text).toContain('장비 3대');
    expect(pushNote({ ...base, last: { ok: false, at: 1000, httpStatus: 403, error: 'x' } }, 2000).kind).toBe('rejected');
    expect(pushNote({ ...base, last: { ok: false, at: 1000, httpStatus: 403 } }, 2000).text).toContain('AGENT_NAME');
    expect(pushNote({ ...base, last: { ok: false, at: 1000, httpStatus: 413 } }, 2000).kind).toBe('too-large');
    expect(pushNote({ ...base, last: { ok: false, at: 1000, httpStatus: 500, error: 'boom' } }, 2000).kind).toBe('error');
    expect(pushNote({ ...base, last: { skipped: true, at: 1000, reason: '꺼짐(env)' } }, 2000).kind).toBe('skipped');
  });
  it('상한으로 뺀 장비 수를 밝힌다(조용한 상한 금지)', () => {
    expect(pushNote({ ...base, last: { ok: true, at: 1000, devices: 5000, open: 0, omitted: 12 } }, 2000).text).toContain('상한으로 12대 제외');
  });
  it('없으면 빈 문자열', () => { expect(pushNote(null).text).toBe(''); });
});

describe('resetNote / deviceKeyNote — 키 체계(v2.548 F2)', () => {
  it('키 체계 변경으로 이력을 새로 시작한 사실을 말하고, 없으면 빈 문자열', () => {
    expect(resetNote(null)).toBe('');
    const t = resetNote({ at: 1_700_000_000_000, from: 1, to: 2 });
    expect(t).toContain('이력을 새로 시작');
    expect(t).toContain('1→2');
  });
  it('localId(IP) 장비만 안내하고 서비스태그·UUID·중앙 id 는 조용하다', () => {
    const notes = { localId: '⚠ 로컬 id 로 식별합니다' };
    expect(deviceKeyNote('serviceTag', notes)).toBe('');
    expect(deviceKeyNote('uuid', notes)).toBe('');
    expect(deviceKeyNote('centralId', notes)).toBe('');
    expect(deviceKeyNote('localId', notes)).toContain('로컬 id');
  });
});

describe('keyKindNote — 안정적인 키에는 안내를 붙이지 않는다', () => {
  const notes = { index: '⚠ 순번으로 잡은 파트입니다', name: '이름으로 잡았습니다', none: '식별자가 없습니다' };
  it('slot·serial·name 은 조용하다(모든 행에 안내가 붙으면 아무도 안 읽는다)', () => {
    expect(keyKindNote('slot', notes)).toBe('');
    expect(keyKindNote('serial', notes)).toBe('');
    // ⚠ v2.547 Chromium 판독: name 까지 호박색으로 띄우니 정상 행이 경고처럼 보였다.
    expect(keyKindNote('name', notes)).toBe('');
  });
  it('index·none 은 밝힌다', () => {
    expect(keyKindNote('index', notes)).toContain('순번');
    expect(keyKindNote('none', notes)).toContain('식별자');
  });
});

describe('toneVar — 서버 톤과 진단 톤 두 어휘를 모두 받는다', () => {
  it('한쪽만 매핑하면 표의 상태 글자가 색을 잃는다(초판 결함)', () => {
    expect(toneVar('red')).toBe('var(--red)');
    expect(toneVar('bad')).toBe('var(--red)');
    expect(toneVar('amber')).toBe('var(--amber)');
    expect(toneVar('warn')).toBe('var(--amber)');
    expect(toneVar('green')).toBe('var(--green)');
    expect(toneVar('ok')).toBe('var(--green)');
  });
  it("'확인 불가' 는 빨강이 아니라 회색이다(v2.526 healthBadge 규약)", () => {
    expect(toneVar('gray')).toBe('var(--text-faint)');
    expect(toneVar('muted')).toBe('var(--text-faint)');
    expect(toneVar(undefined)).toBe('var(--text-faint)');
  });
});

describe('holdText / holdNote — 행은 짧게, 긴 설명은 배너가 한 번만', () => {
  it('네 사유가 서로 다르고 행 문구는 짧다(v2.509 규약)', () => {
    const a = holdText('unknown'); const b = holdText('device-failed'); const c = holdText('missing'); const d = holdText('collection-failed');
    expect(new Set([a, b, c, d]).size).toBe(4);
    expect(d).toContain('부품 종류만');   // v2.548 F1 — 장비엔 닿았는데 그 컬렉션만 실패
    // ⚠ 40자를 넘으면 5행짜리 표가 같은 문장으로 뒤덮인다(400px 판독에서 실제로 그랬다).
    for (const t of [a, b, c, d]) expect(t.length).toBeLessThanOrEqual(40);
  });
  it('사유가 없으면 빈 문자열(지어내지 않는다)', () => {
    expect(holdText(null)).toBe('');
    expect(holdText('bogus')).toBe('');
  });
  it("배너는 '해소로 처리하지 않았다' 를 한 번 말하고 사유별 건수를 센다", () => {
    const t = holdNote([
      { holdReason: 'device-failed' }, { holdReason: 'device-failed' },
      { holdReason: 'unknown' }, { holdReason: 'collection-failed' }, { holdReason: null },
    ]);
    expect(t).toContain('판정 보류 4건');
    expect(t).toContain('이 장비 수집 실패 2건');
    expect(t).toContain('부품 종류 수집 실패 1건');
    expect(t).toContain('상태를 읽지 못함 1건');
    expect(t).toContain('해소로 처리하지 않았습니다');
  });
  it('보류가 없으면 빈 문자열', () => { expect(holdNote([{ holdReason: null }])).toBe(''); });
});

describe('eventText — 제거와 복구를 한 문구로 덮지 않는다', () => {
  const labels = { state: { fault: '장애', warn: '주의' } };
  it('열림/변화/해소', () => {
    expect(eventText({ event: 'open', state: 'fault' }, labels)).toContain('장애 발생');
    expect(eventText({ event: 'change', prevState: 'warn', state: 'fault' }, labels)).toContain('주의 → 장애');
    expect(eventText({ event: 'close', prevState: 'fault', closeReason: 'ok' }, labels)).toContain('정상으로 복귀');
    expect(eventText({ event: 'close', prevState: 'fault', closeReason: 'removed' }, labels)).toContain('제거');
  });
  it('없으면 빈 문자열', () => { expect(eventText(null)).toBe(''); });
});

describe('notifyNote / lastRunText — 상한과 실패를 숨기지 않는다', () => {
  it('상한으로 빠진 건수를 말한다', () => {
    const t = notifyNote({ notify: { sent: 200, capped: 15, dropped: 3 } });
    expect(t).toContain('200건 발송');
    expect(t).toContain('15건은 보내지 않았습니다');
    expect(t).toContain('3건 미발송');
  });
  it('알림이 없으면 빈 문자열', () => { expect(notifyNote({})).toBe(''); });
  it('점검 이력이 없으면 지어내지 않는다', () => {
    expect(lastRunText(null)).toBe('점검 이력 없음');
    expect(lastRunText({ last: { at: 1000, error: 'x' } }, 2000)).toContain('직전 점검 실패');
  });
});

describe('tableFootnotes — 표 아래 각주 1회(v2.548 400px 판독)', () => {
  const labels = {
    deviceKeyKindNote: { serviceTag: '', uuid: '', centralId: '', localId: '⚠ **로컬 id(IP)** 로 식별합니다' },
    keyKindNote: { slot: '슬롯', serial: '시리얼', name: '이름', index: '⚠ **순번** 으로 식별합니다', none: '**그룹 단위**' },
  };
  it('안정 키(서비스태그·슬롯)만 있으면 각주가 없다', () => {
    expect(tableFootnotes([{ deviceKeyKind: 'serviceTag', keyKind: 'slot' }, { deviceKeyKind: 'uuid', keyKind: 'serial' }], labels)).toEqual([]);
    expect(tableFootnotes([], labels)).toEqual([]);
    expect(tableFootnotes(null, labels)).toEqual([]);
  });
  it('같은 안내는 행이 여러 개여도 한 번만 · 장비 키와 파트 키 안내를 모두 모은다', () => {
    const rows = [
      { deviceKeyKind: 'localId', keyKind: 'index' },
      { deviceKeyKind: 'localId', keyKind: 'index' },
      { deviceKeyKind: 'localId', keyKind: 'none' },
      { deviceKeyKind: 'serviceTag', keyKind: 'slot' },
    ];
    const out = tableFootnotes(rows, labels);
    expect(out).toHaveLength(3);
    expect(out[0]).toContain('로컬 id');
    expect(out[1]).toContain('순번');
    expect(out[2]).toContain('그룹 단위');
  });
  it('표시된 행(검색 결과)에 없는 종류의 안내는 내지 않는다', () => {
    const out = tableFootnotes([{ deviceKeyKind: 'serviceTag', keyKind: 'index' }], labels);
    expect(out).toEqual(['⚠ **순번** 으로 식별합니다']);
  });
});

describe('edgeNote — 수신 상한(v2.548 S2)을 조용히 넘기지 않는다', () => {
  it('잘린 파트·버린 scanned 를 문구에 싣는다', () => {
    const r = edgeNote({ rows: [{ agent: 'A', kind: 'fresh', partsOmitted: 501, scannedDropped: true }, { agent: 'B', kind: 'fresh', partsOmitted: 0 }], counts: { fresh: 2 }, minVersion: '2.548.0' });
    expect(r.text).toContain('잘린 파트 501개');
    expect(r.text).toContain('scanned');
  });
  it('상한에 걸린 엣지가 없으면 그 문구가 없다', () => {
    const r = edgeNote({ rows: [{ agent: 'A', kind: 'fresh' }], counts: { fresh: 1 }, minVersion: '2.548.0' });
    expect(r.text).not.toContain('잘린 파트');
    expect(r.text).not.toContain('scanned');
  });
});

describe('keyKindMark / deviceKeyMark — 행 안의 짧은 표지', () => {
  const kl = { slot: '슬롯', serial: '시리얼', name: '이름', index: '순번', none: '식별 불가' };
  const dl = { serviceTag: '서비스태그', uuid: 'UUID', centralId: '중앙 발급 id', localId: '로컬 id' };
  it('조용한 등급은 빈 문자열', () => {
    for (const k of ['slot', 'serial', 'name']) expect(keyKindMark(k, kl)).toBe('');
    for (const k of ['serviceTag', 'uuid', 'centralId']) expect(deviceKeyMark(k, dl)).toBe('');
  });
  it('none 은 "식별 불가 식별" 같은 겹말이 아니라 "그룹 단위"', () => {
    expect(keyKindMark('none', kl)).toBe('⚠ 그룹 단위');
    expect(keyKindMark('index', kl)).toBe('⚠ 순번 식별');
    expect(deviceKeyMark('localId', dl)).toBe('⚠ 로컬 id 식별');
  });
});

describe('emptyDiag — 정직성 리뷰 H1·H4(v2.548)', () => {
  const NOW = 1_800_000_000_000;
  const okPoller = (over = {}) => ({ enabled: true, intervalMs: 600_000, busy: false, last: { at: NOW - 60_000, ms: 1, stats: {}, local: scanned() }, ...over });
  const emptyLocal = () => scanned({ idrac: { devices: 0, ok: 0, failed: 0, parts: 0, capped: 0 }, storage: { devices: 0, ok: 0, failed: 0, parts: 0, notCollected: {} }, sanswitch: { devices: 0, ok: 0, failed: 0, parts: 0, notCollected: {}, notJudged: 0 }, summary: { total: 0 } });
  it('H4: 자동 점검이 꺼져 있고 마지막 점검이 있으면 초록이 아니라 stale-off', () => {
    const d = emptyDiag({ open: [], db: { available: true }, poller: okPoller({ enabled: false }), now: NOW });
    expect(d.kind).toBe('stale-off'); expect(d.tone).toBe('warn'); expect(d.text).toContain('꺼져');
  });
  it('H4: 마지막 점검이 주기의 2배를 넘기면 stale-check — 주기는 서버 값만 쓴다', () => {
    const d = emptyDiag({ open: [], db: { available: true }, poller: okPoller({ last: { at: NOW - 1_300_000, ms: 1, stats: {}, local: scanned() } }), now: NOW });
    expect(d.kind).toBe('stale-check');
    const fresh = emptyDiag({ open: [], db: { available: true }, poller: okPoller({ last: { at: NOW - 1_100_000, ms: 1, stats: {}, local: scanned() } }), now: NOW });
    expect(fresh.kind).not.toBe('stale-check');
    const noIv = emptyDiag({ open: [], db: { available: true }, poller: okPoller({ intervalMs: null, last: { at: NOW - 86_400_000, ms: 1, stats: {}, local: scanned() } }), now: NOW });
    expect(noIv.kind).not.toBe('stale-check');
  });
  it('H1: 중앙 직접 장비 0 이어도 신선한 엣지가 있으면 "장비가 없다" 고 하지 않는다', () => {
    const p = okPoller({ last: { at: NOW - 60_000, ms: 1, stats: {}, local: emptyLocal() } });
    const none = emptyDiag({ open: [], db: { available: true }, poller: p, edges: { rows: [], counts: {} }, now: NOW });
    expect(none.kind).toBe('no-devices');
    const notFresh = emptyDiag({ open: [], db: { available: true }, poller: p, edges: { rows: [{ agent: 'A', kind: 'old-version' }, { agent: 'B', kind: 'silent' }], counts: { 'old-version': 1, silent: 1 } }, now: NOW });
    expect(notFresh.kind).toBe('edges-not-fresh'); expect(notFresh.tone).toBe('bad'); expect(notFresh.text).toContain('2곳');
    const fresh = emptyDiag({ open: [], db: { available: true }, poller: p, edges: { rows: [{ agent: 'A', kind: 'fresh' }], counts: { fresh: 1 } }, now: NOW });
    expect(fresh.kind).toBe('partial'); expect(fresh.text).toContain('중앙 직접 수집 장비 없음');
  });
  it('H1: 중앙 직접 장비 전부 실패여도 신선한 엣지가 있으면 all-failed 가 아니라 partial 로 나눠 말한다', () => {
    const p = okPoller({ last: { at: NOW - 60_000, ms: 1, stats: {}, local: scanned({ idrac: { devices: 3, ok: 0, failed: 3, parts: 0, capped: 0 }, storage: { devices: 0, ok: 0, failed: 0, parts: 0, notCollected: {} }, summary: { total: 0 } }) } });
    expect(emptyDiag({ open: [], db: { available: true }, poller: p, edges: { rows: [], counts: {} }, now: NOW }).kind).toBe('all-failed');
    const d = emptyDiag({ open: [], db: { available: true }, poller: p, edges: { rows: [{ agent: 'A', kind: 'fresh' }], counts: { fresh: 1 } }, now: NOW });
    expect(d.kind).toBe('partial'); expect(d.text).toContain('3대 전부 못 읽음');
  });
});

describe('edgeScanTotals — 엣지 unknown/absent 합산(H2)', () => {
  it('신선한 보고만 더하고 요약 없음·오래됨은 개수로 밝힌다', () => {
    const r = edgeScanTotals([
      { agent: 'a', scanned: { summary: { total: 40, unknown: 3, absent: 12 } } },
      { agent: 'b', stale: true, scanned: { summary: { total: 9, unknown: 9, absent: 0 } } },
      { agent: 'c', legacy: true, scanned: null },
      { agent: 'd', scannedDropped: true, scanned: null },
      { agent: 'e', scanned: {} },
      null,
    ]);
    expect(r).toEqual({ agents: 1, unknown: 3, absent: 12, total: 40, noSummary: 2, skipped: 2 });
    expect(edgeScanTotals(undefined)).toEqual({ agents: 0, unknown: 0, absent: 0, total: 0, noSummary: 0, skipped: 0 });
  });
});

describe('pushNote / eventText / holdText — H6·C5·H7', () => {
  it('H6: 보냈는데 중앙이 꺼져 있으면 경고한다', () => {
    const r = pushNote({ configured: true, enabled: true, last: { ok: true, at: 1000, devices: 3, open: 1, centralEnabled: false } }, 2000);
    expect(r.kind).toBe('central-off'); expect(r.tone).toBe('warn'); expect(r.text).toContain('꺼져');
    const ok = pushNote({ configured: true, enabled: true, last: { ok: true, at: 1000, devices: 3, open: 1, centralEnabled: true, rejected: 2 } }, 2000);
    expect(ok.kind).toBe('ok'); expect(ok.text).toContain('버린 장비 2대');
  });
  it('C5: 수동 닫기 이벤트는 "고쳐졌다" 고 말하지 않는다', () => {
    expect(eventText({ event: 'close', closeReason: 'manual', prevState: 'fault' }, { state: { fault: '이상' } })).toContain('수동으로 닫음');
    expect(eventText({ event: 'close', closeReason: 'ok', prevState: 'fault' }, {})).toContain('정상으로 복귀');
  });
  it('H7·C5: 새 보류 사유가 문구를 갖는다', () => {
    for (const k of ['unassigned', 'no-report', 'edge-stale', 'edge-legacy']) expect(holdText(k)).toContain('판정 보류');
    const n = holdNote([{ holdReason: 'edge-stale' }, { holdReason: 'edge-legacy' }, { holdReason: 'unassigned' }, { holdReason: 'no-report' }]);
    expect(n).toContain('보류 4건'); expect(n).toContain('오래됨'); expect(n).toContain('구버전'); expect(n).toContain("'닫기'");
  });
});

describe('v2.598 WEBUI-2598-03 — 이력이 비었을 때', () => {
  const NOW = 1_800_000_000_000;
  it('점검이 한 번도 돌지 않았으면 "변화 없음" 이라 말하지 않는다', () => {
    const r = historyEmptyText({ poller: { enabled: true, last: null }, db: { openParts: 0, rows: 0 }, days: 30, now: NOW });
    expect(r.kind).toBe('never');
    expect(r.text).toContain('변화가 없었다는 뜻이 아닙니다');
    expect(historyEmptyText({ poller: { enabled: false }, db: null, now: NOW }).text).toContain('꺼짐');
  });
  it('재시작으로 poller.last 가 비어도 DB 흔적이 있으면 "한 번도 안 했다" 고 단정하지 않는다', () => {
    expect(historyEmptyText({ poller: { enabled: true }, db: { openParts: 12, rows: 0 }, now: NOW }).kind).toBe('nochange');
  });
  it('마지막 점검이 조회 기간 이전이면 그 사실을 말한다', () => {
    const r = historyEmptyText({ poller: { last: { at: NOW - 40 * 86_400_000 } }, days: 30, now: NOW });
    expect(r.kind).toBe('before');
    expect(r.text).toContain('최근 30일');
  });
  it('기간 안에 점검이 돌았으면 예전 문구(변화 없음)', () => {
    expect(historyEmptyText({ poller: { last: { at: NOW - 3600_000 } }, days: 30, now: NOW }).kind).toBe('nochange');
  });
});

describe('v2.598 WEBUI-2598-06 — KPI 0·결측', () => {
  it('요약이 없으면 0 이 아니라 —', () => {
    expect(kpiValue(null, 'fault')).toBe('—');
    expect(kpiValue({ fault: 0 }, 'fault')).toBe(0);
    expect(kpiValue({ fault: 3 }, 'fault')).toBe(3);
  });
  it('0·결측은 경고색을 쓰지 않는다', () => {
    expect(kpiAccent(0, 'var(--red)')).toBe(undefined);
    expect(kpiAccent('—', 'var(--red)')).toBe(undefined);
    expect(kpiAccent(2, 'var(--red)')).toBe('var(--red)');
  });
});

describe("v2.603 EDGE2603-05 — 중앙 설정으로 끈 엣지('off')", () => {
  const NOW = 1_800_000_000_000;
  const p = (local) => poller({ last: { at: NOW - 60_000, ms: 1, stats: {}, local } });
  const none = scanned({ idrac: { devices: 0, ok: 0, failed: 0, parts: 0, capped: 0 }, storage: { devices: 0, ok: 0, failed: 0, parts: 0, notCollected: {} }, summary: { total: 0 } });
  it('라벨·톤이 있다(원문 off 를 그대로 보이지 않는다)', () => {
    expect(EDGE_KIND_LABEL.off).toBe('꺼짐(중앙 설정)');
    expect(EDGE_KIND_TONE.off).toBe('muted');
  });
  it('edgeNote 는 개수를 밝히고 notFresh(주의)에서 뺀다', () => {
    const n = edgeNote({ rows: [{ agent: 'A', kind: 'fresh' }, { agent: 'B', kind: 'off' }], counts: { fresh: 1, off: 1 }, minVersion: '2.548.0' });
    expect(n.text).toContain('꺼짐 1곳');
    expect(n.notFresh).toBe(0);
    expect(n.tone).toBe('ok');
    const m = edgeNote({ rows: [{ kind: 'off' }, { kind: 'silent' }], counts: { off: 1, silent: 1 }, minVersion: '2.548.0' });
    expect(m.notFresh).toBe(1);
    expect(m.tone).toBe('warn');
  });
  it('빈 상태 — 일부 off 면 전부 정상이라 말하지 않고 개수를 적는다', () => {
    const d = emptyDiag({ now: NOW, open: [], db: { available: true }, poller: p(scanned()), edges: { rows: [{ agent: 'A', kind: 'fresh' }, { agent: 'B', kind: 'off' }], counts: { fresh: 1, off: 1 } } });
    expect(d.kind).toBe('partial');
    expect(d.text).toContain('중앙 설정으로 파트 장애를 끈 엣지 1곳');
  });
  it('빈 상태 — 직접 장비가 없고 엣지가 전부 off 면 "모두 보고 없음(bad)" 이 아니라 "점검 안 함"', () => {
    const d = emptyDiag({ now: NOW, open: [], db: { available: true }, poller: p(none), edges: { rows: [{ agent: 'A', kind: 'off' }, { agent: 'B', kind: 'off' }], counts: { off: 2 } } });
    expect(d.kind).toBe('edges-off');
    expect(d.tone).toBe('muted');
    expect(d.text).toContain('점검 안 함');
    const e = emptyDiag({ now: NOW, open: [], db: { available: true }, poller: p(none), edges: { rows: [{ kind: 'off' }, { kind: 'silent' }], counts: { off: 1, silent: 1 } } });
    expect(e.kind).toBe('edges-not-fresh');
  });
});

describe('v2.612 LEFT2612-04 eventText — 키 이전은 복구가 아니다', () => {
  it('key-migrated 는 해소(정상으로 복귀)로 말하지 않는다', () => {
    const t = eventText({ event: 'close', closeReason: 'key-migrated', prevState: 'fault' });
    expect(t).toContain('식별 키 변경');
    expect(t).not.toContain('정상으로 복귀');
  });
});
