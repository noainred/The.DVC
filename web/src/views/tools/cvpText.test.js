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

describe('choiceOptions (v2.609)', () => {
  it('문자열 목록과 {id,name} 목록을 같은 모양으로', () => {
    expect(T.choiceOptions(['a'], '')).toEqual([{ value: 'a', label: 'a' }]);
    expect(T.choiceOptions([{ id: 'dc1', name: '서울' }], '')).toEqual([{ value: 'dc1', label: '서울' }]);
  });
  it('목록에 없는 현재 값은 지우지 않고 표시한다', () => {
    const o = T.choiceOptions(['a'], 'old');
    expect(o[0]).toEqual({ value: 'old', label: 'old (목록에 없음)', missing: true });
    expect(o).toHaveLength(2);
  });
  it('대소문자만 다른 현재 값은 목록 항목으로 본다', () => {
    expect(T.choiceOptions(['Edge-A'], 'edge-a')).toHaveLength(1);
  });
});

// ── v2.611 감사(WEB2611-02·03·04·05·11·12) ──────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe('v2.611 — 서버 키 대조·못 읽은 수·배너', () => {
  it('ITEM_LABEL 키 == 서버 CANDIDATES 키 + budget·deadline(두 목록 대조 — WEB2611-04)', () => {
    const src = fs.readFileSync(path.resolve(HERE, '../../../../server/src/cvp/client.js'), 'utf8');
    const block = src.slice(src.indexOf('export const CANDIDATES'), src.indexOf('});', src.indexOf('export const CANDIDATES')));
    const keys = [...block.matchAll(/^\s{2}(\w+):\s*\[/gm)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(5);
    expect(Object.keys(T.ITEM_LABEL).sort()).toEqual([...keys, 'budget', 'deadline'].sort());
    for (const k of Object.keys(T.ITEM_LABEL)) expect(T.itemLabel(k)).not.toMatch(/^[a-z]/);
  });
  it('0 초과 0.05 미만은 0% 가 아니라 <0.1%(WEB2611-12)', () => {
    expect(T.pctText(6.7e-5)).toBe('<0.1%');
    expect(T.pctText(0)).toBe('0%');
    expect(T.pctText(0.05)).toBe('0.1%');
  });
  it('못 읽은 장비 수를 KPI 가 말한다(WEB2611-02)', () => {
    const k = T.kpiItems({ devices: 5, partsFault: 0, partsUnread: 2, bgpDown: 0, bgpUnread: 3, portsDown: 0, portsUnread: 1 });
    expect(k.find((x) => x.key === 'parts').meta).toContain('못 읽은 장비 2대');
    expect(k.find((x) => x.key === 'bgp').meta).toContain('못 읽은 장비 3대');
    expect(k.find((x) => x.key === 'ports').meta).toContain('못 읽은 장비 1대');
    for (const x of k) expect(x.accent).toBeNull();
  });
  it('dbUnavailable·collectDrops·pendingRequest·orphanRows 를 배너로(WEB2611-03)', () => {
    const now = Date.now();
    const notes = T.listNotes({
      dbUnavailable: true, orphanRows: 4,
      servers: [{ id: 'c1', name: 'CVP-A', pendingRequest: true, status: { pruneHeld: { reason: '0대 보류' }, partsDueUnread: true } }],
      collectDrops: [{ id: 'c1', agent: 'edge-a', at: now - 60_000, tries: 2, reason: 'untaken' }],
    }, now);
    const all = notes.join('\n');
    expect(all).toContain('CVP DB 를 열지 못했습니다');
    expect(all).toContain('폐기');
    expect(all).toContain('재수집 요청 대기 1대');
    expect(all).toContain('옛 장비 행 4개');
    expect(all).toContain('0대 보류');
    expect(all).toContain('파트를 읽을 차례');
    expect(T.listNotes({})).toEqual([]);
  });
  it('읽지 못한 파트 종류를 한글로(WEB2611-05)', () => {
    expect(T.partsMissingText(['cooling', 'temperature'])).toContain('팬 · 온도 센서');
    expect(T.partsMissingText([])).toBe('');
    expect(T.telemetryText('aborted')).toContain('시한');
    expect(T.telemetryText('weird')).toContain('weird');
  });
  it('지금 수집은 admin·operator 만(WEB2611-11)', () => {
    expect(T.canCollect({ role: 'viewer' })).toBe(false);
    expect(T.canCollect({ role: 'operator' })).toBe(true);
    expect(T.canCollect({ role: 'admin' })).toBe(true);
    expect(T.canCollect(null)).toBe(true);
  });
  it('CvpTool 이 새 판정을 실제로 쓴다(소스)', () => {
    const src = fs.readFileSync(path.resolve(HERE, 'CvpTool.jsx'), 'utf8');
    for (const f of ['listNotes(', 'partsMissingText(', 'canCollect(', 'collectErr']) expect(src).toContain(f);
    for (const t of Object.values(T.TELEMETRY_TEXT)) expect(t).not.toMatch(/`/);
  });
});

describe('v2.612 감사 그룹 B', () => {
  it('RECENT2612-01 파트 미조회 배너는 확인된 원인(예산·시한)만 말하고 경로 실패 사유를 붙인다', () => {
    const s = T.partsDueNote('CVP-A', { partsDueUnread: true, partsNotTried: 3, missing: { power: '2대 실패(없음(404))', budget: '예산' } });
    expect(s).toContain('3대');
    expect(s).toContain('시간 예산·수집 시한');
    expect(s).toContain('전원(PSU): 2대 실패(없음(404))');
    expect(s).not.toMatch(/한 대도 읽지 못했습니다/);
    expect(T.partsDueNote('X', {})).toContain('일부 장비');
    const notes = T.listNotes({ servers: [{ id: 'c1', name: 'A', status: { partsDueUnread: true, partsNotTried: 1 } }] }).join('\n');
    expect(notes).toContain('파트를 읽을 차례');
  });
  it('COL2612-04 prefix 수를 모르는 피어가 있으면 합계는 최소 값', () => {
    expect(T.prefixText(120, 1)).toContain('최소 120');
    expect(T.prefixText(120, 0)).toBe(T.countText(120));
    expect(T.prefixText(null, 2)).toBe('—');
    expect(T.bgpCell({ peers: 2, established: 1, down: 1, prefixes: 120, prefixesUnknown: 1 }).title).toContain('최소 120');
  });
  it('WEB2612-07 장비 목록을 못 받았으면 0대가 아니라 —', () => {
    expect(T.deviceCountLabel(null, 0, 0)).toBe('장비 —');
    expect(T.deviceCountLabel({ unavailable: true }, 0, 0)).toBe('장비 —');
    expect(T.deviceCountLabel({ devices: [] }, 0, 0)).toBe('장비 0대');
    expect(T.deviceCountLabel({ devices: [1, 2] }, 1, 2)).toContain('전체');
  });
});

describe('v2.613 CONTRACT2613-04 — 위임 CVP 의 보고 없음은 kind 별로 말한다(구버전은 기다려도 안 된다)', () => {
  const readSrc = (p) => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), p), 'utf8');
  it('서버 CVP_EDGE_KINDS 와 웹 문구 키가 1:1', () => {
    const src = readSrc('../../../../server/src/central/cvpEdge.js');
    const m = src.match(/export const CVP_EDGE_KINDS = Object\.freeze\(\[([^\]]*)\]\)/);
    expect(m).toBeTruthy();
    const serverKinds = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
    expect([...T.CVP_EDGE_KINDS].sort()).toEqual(serverKinds);
  });
  it('old-version → bad + 업그레이드 안내(버전 둘 다 문구에) · unknown-version/silent → warn · waiting → muted', () => {
    const old = T.serverState({ agent: 'e1', status: { pending: true, ok: null, kind: 'old-version', edgeVersion: '2.607.0', minEdgeVersion: '2.608.0' } });
    expect(old.tone).toBe('bad');
    expect(old.label).toContain('구버전');
    expect(old.detail).toContain('2.607.0');
    expect(old.detail).toContain('2.608.0');
    expect(old.detail).toContain('업그레이드');
    expect(old.detail).not.toContain('기다리는 중');
    const unk = T.serverState({ status: { pending: true, ok: null, kind: 'unknown-version', edgeVersion: '' } });
    expect(unk.tone).toBe('warn');
    expect(unk.label).toContain('버전 미상');
    const sil = T.serverState({ status: { pending: true, ok: null, kind: 'silent', edgeVersion: '2.613.0' } });
    expect(sil.tone).toBe('warn');
    expect(sil.detail).toContain('엣지 로그');
    const wait = T.serverState({ status: { pending: true, ok: null, kind: 'waiting', edgeVersion: '2.613.0' } });
    expect(wait.tone).toBe('muted');
    expect(wait.label).toBe('수집 기록 없음');
  });
  it('kind 가 없는(구버전 중앙·중앙 직접) 응답과 수집 꺼짐은 예전 문구 그대로', () => {
    expect(T.serverState({ status: {} }).label).toBe('수집 기록 없음');
    expect(T.serverState({ status: { pending: true, ok: null, note: 'x' } }).detail).toContain('기다리는 중');
    expect(T.serverState({ status: { pending: true, ok: null, kind: 'old-version' } }, { enabled: false }).detail).toContain('꺼져');
  });
});
