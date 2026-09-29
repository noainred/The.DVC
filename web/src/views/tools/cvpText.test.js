/**
 * cvpText.test.js — Arista CVP 화면 판정·문구 회귀(v2.608).
 * 고정하는 것: 못 읽은 값은 '—'(단위 없음) · 0 을 경고색으로 칠하지 않음 · 파트 5상태를 섞지 않음 ·
 * 차트 y축 0~100·끊김·점 1개 · 빈 칸은 보내지 않음 · 문구 백틱 0.
 */
import { describe, it, expect } from 'vitest';
import * as T from './cvpText.js';
const { eventDeviceRefs, eventDeviceSort } = T;

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
    expect(b).toEqual({ enabled: true, faultAlerts: false, faultAlertsClosed: true, rawRetentionDays: 7, concurrency: 2 });
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
    expect(Object.keys(T.ITEM_LABEL).sort()).toEqual([...keys, 'budget', 'deadline', 'eventsCapped'].sort());
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

describe('v2.640 ① 남은 결함·정리', () => {
  it('agoText 는 공용 relTime 코어다(사본 제거) · 0·null 은 —', () => {
    expect(T.agoText(null)).toBe('—');
    expect(T.agoText(0)).toBe('—');
    expect(T.agoText(Date.now() - 90_000)).toMatch(/분 전$/);
  });
  it('엣지 보고에 devicesUnavailable 을 말한다(서버는 싣는데 화면이 안 읽던 값)', () => {
    const v = T.edgeReportView({ ok: true, devicesUnavailable: true, servers: 2, error: null });
    expect(v.label).toBe('정상');
    expect(v.extras.join(' ')).toContain('엣지 DB 불가');
    expect(v.extras.join(' ')).toContain('CVP 2대');
    expect(T.edgeReportView({ ok: false, error: 'x' }).tone).toBe('bad');
    expect(T.edgeReportView(null).label).toBe('—');
  });
  it('서버 행 툴팁 — CVP 버전·수집 소요 · DB 요약 한 줄', () => {
    expect(T.serverMetaText({ cvpVersion: '2024.2.0', durationMs: 4250, partsRead: true })).toBe('CVP 2024.2.0 · 수집 소요 4.3초 · 이번 주기에 파트 읽음');
    expect(T.serverMetaText({})).toBe('');
    expect(T.dbStatsText({ available: true, rows: { device: 10, port: 640, sample: 5000, daily: 0 }, bytes: 1_048_576 })).toContain('원시 표본 5,000');
    expect(T.dbStatsText({ available: false, note: '잠금' })).toContain('사용 불가');
    expect(T.dbStatsText(null)).toBe('');
  });
});

describe('v2.640 ④ 필터 칩·CSV·처리량 차트', () => {
  const devs = [
    { hostname: 'a', parts: { fault: 1 }, ports: { down: 0 }, bgp: { down: 0 }, streaming: true, telemetry: 'ok' },
    { hostname: 'b', parts: { fault: 0, warn: 2 }, ports: { down: 3 }, bgp: null, streaming: false, telemetry: 'ok' },
    { hostname: 'c', parts: null, ports: null, bgp: { down: 1 }, streaming: true, telemetry: 'failed' },
    null,
  ];
  it('칩 개수는 요약 셀과 같은 값을 보고, 못 읽음은 정상이 아니라 모름', () => {
    const c = T.chipCounts(devs);
    expect(c).toEqual({ all: 3, fault: 1, warn: 1, portDown: 1, bgpDown: 1, notStreaming: 1, sysHigh: 0, unread: 2 });
    expect(T.filterByChip(devs, 'unread').map((d) => d.hostname)).toEqual(['b', 'c']);
    expect(T.filterByChip(devs, 'all')).toHaveLength(3);
    expect(T.filterByChip(devs, 'nope')).toHaveLength(0);
    expect(T.chipMatch({ parts: { fault: '' } }, 'fault')).toBe(false);
  });
  it('CSV 경로는 검색·CVP 만 반영한다', () => {
    expect(T.devicesCsvPath('', '')).toBe('/tools/cvp/devices.csv');
    expect(T.devicesCsvPath('c1', ' leaf ')).toBe('/tools/cvp/devices.csv?cvpId=c1&q=leaf');
    expect(T.CSV_NOTE).not.toMatch(/`/);
  });
  it('처리량 축 상한은 데이터 최대를 1·2·5 계열로 올리고, 값 없으면 기본', () => {
    expect(T.bpsAxisMax(0)).toBe(1000);
    expect(T.bpsAxisMax(null)).toBe(1000);
    expect(T.bpsAxisMax(1_300_000)).toBe(2_000_000);
    expect(T.bpsAxisMax(5_000_000)).toBe(5_000_000);
    expect(T.bpsAxisMax(7_000_000)).toBe(10_000_000);
  });
  it('처리량 기하 — null 은 버리고 끊김·점 1개 규칙은 사용률과 같다', () => {
    const opt = { width: 200, height: 120, pad: 10, intervalMs: 60_000 };
    const pts = [{ ts: 0, inBps: 100, outBps: null }, { ts: 60_000, inBps: 200, outBps: 50 }, { ts: 3_600_000, inBps: 150, outBps: 20 }];
    const g = T.seriesGeometryBps(pts, ['inBps', 'outBps'], opt);
    expect(g.count).toBe(5);
    expect(g.max).toBe(200);
    expect(g.axisMax).toBe(200);
    expect(g.paths.inBps).toHaveLength(1);
    expect(g.dots.inBps).toHaveLength(1);
    expect(g.dots.outBps).toHaveLength(2);
    expect(g.ticks).toHaveLength(3);
    expect(g.ticks[2].label).toBe('200 bps');
    expect(T.seriesGeometryBps([], ['inBps'], opt).count).toBe(0);
  });
  it('상한으로 잘린 추이는 밝힌다', () => {
    expect(T.chartCutNote({ truncated: true, limit: 5000 })).toContain('5,000점');
    expect(T.chartCutNote({ truncated: false })).toBe('');
    expect(T.chartCutNote(null)).toBe('');
  });
});

describe('v2.640 ③ 장애 전이', () => {
  it('보류 사유 키 == 서버 HOLD_REASON 값(두 목록 대조 — 서버가 새 사유를 내면 화면도 문구를 가져야 한다)', () => {
    const src = fs.readFileSync(path.resolve(HERE, '../../../../server/src/cvp/faults.js'), 'utf8');
    const m = src.match(/export const HOLD_REASON = Object\.freeze\(\{([^}]*)\}\)/);
    expect(m).toBeTruthy();
    const serverVals = [...m[1].matchAll(/:\s*'([^']+)'/g)].map((x) => x[1]).sort();
    expect([...T.HOLD_KEYS].sort()).toEqual(serverVals);
    for (const k of T.HOLD_KEYS) expect(T.holdText(k)).not.toMatch(/`/);
  });
  it('종류 라벨은 한글이고 모르는 종류는 원문', () => {
    for (const k of ['psu', 'fan', 'temp', 'xcvr', 'port', 'bgp']) expect(T.faultKindLabel(k)).not.toMatch(/^[a-z]/);
    expect(T.faultKindLabel('zzz')).toBe('zzz');
  });
  it('열린 장애 행·이벤트·닫힘 사유', () => {
    const v = T.faultRowView({ kind: 'port', state: 'fault', deviceName: 'leaf1', cvpName: 'CVP-HQ', agent: 'edge-a', holdReason: 'missing', firstSeen: 1, lastSeen: 2, notifiedAt: 3 });
    expect(v.kindLabel).toBe('포트');
    expect(v.state.label).toBe('장애');
    expect(v.where).toBe('CVP-HQ · 엣지 edge-a');
    expect(v.hold).toContain('고쳐졌다는 뜻이 아닙니다');
    expect(v.notified).toBe(true);
    expect(T.faultRowView({ state: 'weird' }).state.label).toBe('상태 미확인');
    expect(T.faultEventText({ event: 'open', state: 'warn' })).toBe('열림 — 주의');
    expect(T.faultEventText({ event: 'change', prevState: 'warn', state: 'fault' })).toBe('변경 — 주의 → 장애');
    expect(T.faultEventText({ event: 'close', closeReason: 'removed' })).toContain('빈 슬롯');
    expect(T.closeReasonText('manual:admin')).toBe('수동 닫기(admin)');
    expect(T.closeReasonText('ok')).toBe('정상으로 관측');
  });
  it('KPI — DB 불가는 0 이 아니라 — · 0 은 강조색 없음 · 보류를 따로 말한다', () => {
    expect(T.faultKpi({ unavailable: true }).value).toBe('—');
    expect(T.faultKpi(null).value).toBe('—');
    const k = T.faultKpi({ open: 0, byState: { fault: 0, warn: 0 }, held: 0 });
    expect(k.value).toBe('0');
    expect(k.accent).toBeNull();
    const k2 = T.faultKpi({ open: 3, byState: { fault: 2, warn: 1 }, held: 1 });
    expect(k2.accent).toBe('var(--red)');
    expect(k2.meta).toContain('보류 1');
  });
  it('판정 문장 — 판정 전은 모른다고, 알림 꺼짐은 기록만 남긴다고 말한다', () => {
    const t = T.faultScanNote(null, { faultAlerts: false });
    expect(t).toContain('아직 판정하지 않았습니다');
    expect(t).toContain('알림 꺼짐');
    const t2 = T.faultScanNote({ at: Date.now() - 1000, reason: 'poll', devices: 5, opened: 1, updated: 0, closed: 0, held: 2, notified: { sent: 1, capped: 0 } }, { faultAlerts: true, faultAlertsClosed: false });
    expect(t2).toContain('장비 5대');
    expect(t2).toContain('알림 1건');
    expect(t2).toContain('해소는 알리지 않음');
    expect(T.FAULT_INTRO).not.toMatch(/`/);
  });
  it('설정 폼은 알림 스위치를 싣고 응답에서 되돌린다', () => {
    const f = T.settingsToForm({ enabled: true, faultAlerts: true, faultAlertsClosed: false, intervalMs: 300000 });
    expect(f.faultAlerts).toBe(true);
    expect(f.faultAlertsClosed).toBe(false);
    expect(T.settingsPayload(f).faultAlertsClosed).toBe(false);
    expect(T.settingsToForm({}).faultAlertsClosed).toBe(true);
  });
});

describe('v2.640 ② 진단 — 원문 표본·파서 시험', () => {
  it('표본 행은 라벨 순이고 비객체는 버린다', () => {
    const rows = T.sampleRows({ interfaces: { path: '/x', ok: true, status: 200, bytes: 12, head: '{}' }, inventory: { path: '/i', ok: false, status: 404, reason: '없음(404)', head: '{"error":1}' }, junk: 5 });
    expect(rows.map((r) => r.kind)).toEqual(['inventory', 'interfaces']);
    expect(rows[0].ok).toBe(false);
    expect(rows[0].status).toBe(404);
    expect(T.sampleRows(null)).toEqual([]);
    expect(T.SAMPLE_NOTE).not.toMatch(/`/);
    expect(T.PREVIEW_NOTE).not.toMatch(/`/);
  });
  it('파서 시험 요약 — 실패는 응답에 있던 필드를 근거로 말한다', () => {
    const bad = T.previewSummary({ ok: false, note: '인식한 필드가 없습니다', keys: ['errorMessage'], badChunks: 0 });
    expect(bad.ok).toBe(false);
    expect(bad.text).toContain('errorMessage');
    const ok = T.previewSummary({ ok: true, format: 'notifications', count: 3, entities: 4, truncated: 0, unrecognized: 1, truncatedInput: true });
    expect(ok.text).toContain('읽은 항목 3');
    expect(ok.text).toContain('인식 못 한 개체 1');
    expect(ok.text).toContain('앞부분만');
    expect(T.previewSummary(null).ok).toBe(false);
    expect(T.previewColumns([{ a: 1 }, { b: 2, a: 3 }, null])).toEqual(['a', 'b']);
  });
});

describe('v2.643 이벤트 장비 — 시리얼 대신 호스트명', () => {
  it('찾은 장비는 호스트명·키, 못 찾은 것은 원문 식별자(키 없음)', () => {
    const r = eventDeviceRefs({ deviceRefs: [{ id: 'HNN21445377', key: 'HNN21445377', hostname: 'SW-A' }, { id: 'JPA1' }] });
    expect(r).toEqual([
      { id: 'HNN21445377', key: 'HNN21445377', hostname: 'SW-A', label: 'SW-A' },
      { id: 'JPA1', key: null, hostname: '', label: 'JPA1' },
    ]);
    expect(eventDeviceSort({ deviceRefs: [{ id: 'X', key: 'X', hostname: 'SW-B' }] })).toBe('SW-B');
  });
  it('옛 응답(deviceRefs 없음)은 devices 원문 · 오염 원소는 버린다', () => {
    expect(eventDeviceRefs({ devices: ['S1', null, ''] }).map((d) => d.label)).toEqual(['S1']);
    expect(eventDeviceRefs({ deviceRefs: [null, 'x', { id: 'S2', hostname: 5 }] })).toEqual([{ id: 'S2', key: null, hostname: '', label: 'S2' }]);
    expect(eventDeviceSort({})).toBe('');
  });
});

import { faultKindLabel as fkl2648 } from './cvpText.js';
describe('v2.648 슬롯 전원 표시', () => {
  it('ecb › LinecardN 은 슬롯 전원 · 일반 PSU 는 그대로', () => {
    expect(fkl2648('psu', 'ecb › Linecard4')).toBe('슬롯 전원(카드)');
    expect(fkl2648('psu', 'powerSupply › PowerSupply1')).toBe('전원(PSU)');
    expect(fkl2648('psu')).toBe('전원(PSU)');
  });
});
