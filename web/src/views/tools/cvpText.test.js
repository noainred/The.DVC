/**
 * cvpText.test.js — Arista CVP 화면 판정·문구 회귀(v2.608).
 * 고정하는 것: 못 읽은 값은 '—'(단위 없음) · 0 을 경고색으로 칠하지 않음 · 파트 5상태를 섞지 않음 ·
 * 차트 y축 0~100·끊김·점 1개 · 빈 칸은 보내지 않음 · 문구 백틱 0.
 */
import { describe, it, expect } from 'vitest';
import * as T from './cvpText.js';

describe('값 표기', () => {
  it('null·빈 문자열은 0 이 아니라 — 이고 단위가 없다', () => {
    expect(T.bpsText(null)).toBe('—');
    expect(T.bpsText('')).toBe('—');
    expect(T.pctText(null)).toBe('—');
    expect(T.pctText('')).toBe('—');
    expect(T.countText(null)).toBe('—');
    expect(T.countText(0)).toBe('0');
    expect(T.bpsText(0)).toBe('0 bps');
    expect(T.bpsText(1_500_000_000)).toBe('1.5 Gbps');
  });
  it('0~100 밖의 사용률은 사용률로 보지 않는다', () => {
    expect(T.pctOrNull(192)).toBeNull();
    expect(T.pctOrNull(-1)).toBeNull();
    expect(T.pctText(45.25)).toBe('45%');
  });
});

describe('KPI', () => {
  it('0 이면 강조색이 없다', () => {
    const k = T.kpiItems({ devices: 10, streaming: 10, partsFault: 0, partsWarn: 0, partsUnknown: 0, bgpDown: 0, portsDown: 0 });
    for (const x of k) expect(x.accent).toBeNull();
  });
  it('장애가 있으면 강조하고, 미확인은 따로 적는다', () => {
    const k = T.kpiItems({ devices: 3, partsFault: 2, partsWarn: 1, partsUnknown: 4, bgpDown: 1, portsDown: 0 });
    const parts = k.find((x) => x.key === 'parts');
    expect(parts.accent).toBe('var(--red)');
    expect(parts.meta).toContain('상태 미확인 4');
    expect(k.find((x) => x.key === 'bgp').accent).toBe('var(--red)');
    expect(k.find((x) => x.key === 'ports').accent).toBeNull();
  });
  it('totals 가 없으면 전부 —', () => {
    for (const x of T.kpiItems(null)) expect(x.value).toBe('—');
  });
});

describe('서버 상태', () => {
  it('기록 없음은 실패가 아니다', () => {
    expect(T.serverState({ status: null }).tone).toBe('muted');
    expect(T.serverState({ status: {} }).label).toBe('수집 기록 없음');
  });
  it('인증 정지·실패·일부 미확인·성공', () => {
    expect(T.serverState({ status: { ok: false, authStopped: { since: 1 } } }).label).toBe('인증 실패 정지');
    expect(T.serverState({ status: { ok: false, error: 'timeout' } }).detail).toBe('timeout');
    expect(T.serverState({ status: { ok: true, collectedAt: 1, missing: { bgp: '404' } } }).tone).toBe('warn');
    expect(T.serverState({ status: { ok: true, collectedAt: 1, missing: {} } }).tone).toBe('ok');
    expect(T.serverState({ enabled: false, status: { ok: true } }).label).toBe('비활성');
  });
  it('authStopped 문구는 불리언·객체 둘 다 받는다', () => {
    expect(T.authStopText(true)).toContain('인증 실패');
    expect(T.authStopText({ attempts: 3, reason: '401' })).toContain('실패 3회');
    expect(T.authStopText(false)).toBe('');
  });
  it('확인하지 못한 경로 각주는 항목별로 한 번', () => {
    const f = T.missingFootnotes([
      { name: 'A', status: { missing: { bgp: '404', parts: '형식 미인식' } } },
      { name: 'B', status: { missing: { bgp: '404' } } },
      { name: 'C', status: null },
    ]);
    expect(f.map((x) => x.item)).toEqual(['bgp', 'parts']);
    expect(f[0].servers).toEqual(['A', 'B']);
    expect(f[0].reasons).toEqual(['404']);
  });
});

describe('장비 셀', () => {
  it('parts null 은 읽지 못함(—)이고 빈 슬롯·미확인은 정상·장애에 섞지 않는다', () => {
    expect(T.partsCell(null).text).toBe('—');
    const c = T.partsCell({ ok: 10, warn: 0, fault: 0, unknown: 2, absent: 3 });
    expect(c.tone).toBe('ok');
    expect(c.text).toBe('정상 10 · 미확인 2');
    expect(T.partsCell({ ok: 1, fault: 1 }).tone).toBe('bad');
  });
  it('bgp·ports null 은 —', () => {
    expect(T.bgpCell(null).text).toBe('—');
    expect(T.portsCell(null).text).toBe('—');
    expect(T.bgpCell({ peers: 4, established: 3, down: 1 }).tone).toBe('bad');
    expect(T.bgpCell({ peers: 0 }).text).toBe('피어 없음');
  });
  it('검색은 단어 AND', () => {
    const d = [{ hostname: 'leaf1', model: '7050' }, { hostname: 'spine1', model: '7280' }, null];
    expect(T.filterDevices(d, 'leaf 7050')).toHaveLength(1);
    expect(T.filterDevices(d, '')).toHaveLength(2);
  });
});

describe('파트 상태', () => {
  it('모르는 상태는 정상이 아니라 미확인', () => {
    expect(T.partState('weird').label).toBe('상태 미확인');
    expect(T.partCounts([{ state: 'ok' }, { state: 'absent' }, { state: 'x' }, null])).toEqual({ ok: 1, warn: 0, fault: 0, unknown: 1, absent: 1 });
  });
});

describe('추이 차트 기하', () => {
  const opt = { width: 200, height: 120, pad: 10, intervalMs: 60_000 };
  it('y축은 0~100 고정 — 3% 는 바닥 근처', () => {
    const g = T.seriesGeometry([{ ts: 0, inUtil: 3 }, { ts: 60_000, inUtil: 3 }], 'inUtil', opt);
    const y = Number(g.paths[0].split(',')[1].split(' ')[0]);
    expect(y).toBeGreaterThan(100);
  });
  it('수집 없던 구간은 끊고, 한 점 조각은 점으로', () => {
    const pts = [{ ts: 0, inUtil: 10 }, { ts: 60_000, inUtil: 20 }, { ts: 3_600_000, inUtil: 30 }];
    const g = T.seriesGeometry(pts, 'inUtil', opt);
    expect(g.paths).toHaveLength(1);
    expect(g.dots).toHaveLength(1);
  });
  it('점 1개면 선이 없다 · null 은 버린다', () => {
    const g = T.seriesGeometry([{ ts: 1, inUtil: 50 }, { ts: 2, inUtil: null }, { ts: 3, inUtil: '' }], 'inUtil', opt);
    expect(g.paths).toHaveLength(0);
    expect(g.count).toBe(1);
  });
});

describe('지금 수집', () => {
  it('즉시분과 요청분을 나눠 말한다', () => {
    const t = T.collectSummary({ direct: 1, requested: 2 });
    expect(t).toContain('중앙 직접 1대');
    expect(t).toContain('엣지 위임 2대');
  });
});

describe('폼', () => {
  it('설정 빈 칸은 보내지 않는다', () => {
    const b = T.settingsPayload({ enabled: true, intervalMin: '', rawRetentionDays: '7', dailyRetentionDays: ' ', concurrency: '2', deviceTimeoutSec: '' });
    expect(b).toEqual({ enabled: true, rawRetentionDays: 7, concurrency: 2 });
    const c = T.settingsPayload({ enabled: false, intervalMin: '5', deviceTimeoutSec: '120' });
    expect(c.intervalMs).toBe(300_000);
    expect(c.deviceTimeoutMs).toBe(120_000);
  });
  it('설정 응답의 결측은 빈 칸(0 아님)', () => {
    expect(T.settingsToForm({ intervalMs: null }).intervalMin).toBe('');
    expect(T.settingsToForm({ intervalMs: 300000 }).intervalMin).toBe('5');
  });
  it('서버 폼: 마스크는 유지로 보내고 쓰지 않는 방식의 비밀은 보내지 않는다', () => {
    const f = T.serverToForm({ id: 'c1', name: 'CVP-1', host: 'cvp', authMode: 'token', token: T.SECRET_MASK, password: T.SECRET_MASK, status: { ok: true } });
    expect(f.status).toBeUndefined();
    const { body, issue } = T.serverPayload(f);
    expect(issue).toBe('');
    expect(body.token).toBe(T.SECRET_MASK);
    expect(body.password).toBeUndefined();
    expect(body.id).toBe('c1');
    expect(T.serverPayload({ ...f, authMode: 'password', username: '' }).issue).toContain('계정');
    expect(T.serverPayload({ ...f, host: '' }).issue).toContain('주소');
    expect(T.serverPayload({ ...f, name: '' }).issue).toContain('표시명');
  });
});

describe('문구 위생', () => {
  it('모듈의 문자열에 백틱이 없다', () => {
    const texts = [T.CANDIDATE_NOTE, T.authStopText(true), T.collectSummary({ direct: 1, requested: 1 }),
      T.serverPayload({ name: 'n', host: '' }).issue, T.serverPayload({ name: 'n', host: 'h', authMode: 'token', token: '' }).issue];
    for (const s of texts) expect(s).not.toMatch(/`/);
  });
});

describe('isTruncated (v2.608 Chromium 판독 — 개수 객체가 전부 0 인데 "잘림" 으로 표시)', () => {
  it('개수 객체는 양수가 있을 때만 잘림', () => {
    expect(T.isTruncated({ devices: 0, ports: 0, peers: 0, notTried: 0 })).toBe(false);
    expect(T.isTruncated({ devices: 0, ports: 3 })).toBe(true);
    expect(T.isTruncated(true)).toBe(true);
    expect(T.isTruncated(null)).toBe(false);
    expect(T.isTruncated(false)).toBe(false);
  });
});
