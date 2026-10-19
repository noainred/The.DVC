/**
 * v2.744 최종 수정분 적대적 검토 VE(웹) — RV2744F-WEB-03.
 *
 * 결함: 상세 카드 문구(detailNotes·telemetryNote·entDetailNotes)가 목록 행의 `detail` 을 읽었는데 어떤 서버 응답도 그 필드를 싣지 않아
 *   문구가 화면에 한 번도 나오지 않았다. 이제 서버 상세 조회(/tools/bm-usage/history)가 `usageDetail`(폴러 slimUsageDetail — 장치 이름 없이
 *   판정 필드·개수만 + buildUsage 노트)을 싣고, 화면은 그것을 쓴다.
 * 여기서 보는 것: ① 응답 모양(개수 필드·노트 배열)으로 문구 함수가 실제 문장을 만든다 ② 서버 노트와 웹 줄이 같은 말을 두 번 하지 않는다
 *   ③ 상태 줄(usageDetailNote)이 없는 상세를 지어내지 않는다 ④ BmUsage.jsx 가 그 응답 필드를 문구 함수에 넘긴다(소스 — 렌더는 브라우저 몫).
 * 기준 시각은 정시에서 30분 떨어진 고정값이다(Date.now() 금지 — CLAUDE.md v2.517).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import * as text from './bmUsageText.js';
import { stripComments } from '../../test/_stripComments.js';
import { fcUtilization, fcRowPctFields } from '../../../../server/src/bmusage/parse/fcRate.js';
import { buildUsage } from '../../../../server/src/bmusage/usage.js';

const HOUR = 3_600_000;
const NOW = Math.floor(1_790_000_000_000 / HOUR) * HOUR + 30 * 60_000;

/** 서버 slimUsageDetail 이 내는 모양(필드 목록은 server/src/bmusage/poller.js USAGE_DETAIL_FIELDS 와 같다 — 서버 테스트가 고정한다). */
const resp = (over = {}) => ({
  at: NOW - 120_000, ok: true,
  osKind: null, osRead: [], osMissing: [], osAbsent: [], osError: '',
  idracKind: '', idracError: '', idracUsedIds: null, idracSeenIdCount: null,
  idracReports: [], idracSeenReports: [], idracSeenReportCount: null, idracAbsent: [],
  interfaces: [], fc: [], idracFc: [],
  entTried: [], entVia: '', entKind: '', entError: '', entUsedPathCount: null, entUsedCmd: '', entUsedStat: null, entSkipped: [], entSeenSensorCount: null, entRaw: '',
  notes: [],
  ...over,
});

describe('① 응답 모양(개수 필드)으로 문구 함수가 실제 문장을 만든다', () => {
  it('telemetryNote — 목록이 잘려도 장비가 가진 리포트 수는 idracSeenReportCount', () => {
    const d = resp({ idracReports: ['SystemUsage', 'NICStatistics'], idracSeenReports: ['SystemUsage', 'NICStatistics'], idracSeenReportCount: 150, idracAbsent: ['hba'] });
    const s = text.telemetryNote(d);
    expect(s).toContain('리포트 **150종** 중 **2종**을 읽었습니다');
    expect(s).toContain('SystemUsage · NICStatistics');
    expect(s).toContain('HBA 통계 리포트가 없습니다');
    // 리포트를 하나도 모르면 문장을 만들지 않는다(지어내지 않는다).
    expect(text.telemetryNote(resp())).toBe('');
  });

  it('detailNotes — 응답 id 개수 · 메트릭 id(내부 키 제외) · OS 경로 · 실패 사유', () => {
    const d = resp({
      osKind: 'linux', osRead: ['cpu', 'mem'], osMissing: ['hba'],
      idracKind: 'ids-unmatched', idracSeenIdCount: 37,
      idracUsedIds: { cpu: 'SystemBoardCPUUsage', __seenMetricIds: ['a', 'b'], bad: { x: 1 } },
    });
    const notes = text.detailNotes(d);
    expect(notes.some((x) => x.includes('Linux(/proc)') && x.includes('cpu·mem'))).toBe(true);
    expect(notes.some((x) => x.includes('읽지 못한 항목') && x.includes('hba'))).toBe(true);
    expect(notes.some((x) => x.includes('(응답 id 37개)'))).toBe(true);
    const ids = notes.find((x) => x.startsWith('iDRAC 이 쓴 메트릭 id'));
    expect(ids).toContain('cpu=SystemBoardCPUUsage');
    expect(ids).not.toContain('__seenMetricIds');
    expect(ids).not.toContain('[object Object]');
  });

  it('entDetailNotes — 경로·센서 개수 · 원문 가림 사실', () => {
    const a = text.entDetailNotes(resp({ entTried: ['api'], entVia: 'api', entUsedPathCount: 3 }));
    expect(a.some((x) => x.includes('표준 Redfish 센서(3개)'))).toBe(true);
    const b = text.entDetailNotes(resp({ entTried: ['api'], entKind: 'absent', entSeenSensorCount: 12, entUsedPathCount: 0 }));
    expect(b.some((x) => x.includes('센서 **12개** 중 사용률 이름이 맞는 것이 없었습니다'))).toBe(true);
    const c = text.entDetailNotes(resp({ entTried: ['ssh'], entVia: 'ssh', entUsedCmd: 'racadm systemperfstatistics', entRaw: '', entRawHidden: true }));
    expect(c.some((x) => x.includes('원문은 관리자에게만'))).toBe(true);
    // 대체 경로를 시도하지 않았으면 아무 말도 하지 않는다.
    expect(text.entDetailNotes(resp())).toEqual([]);
  });

  it('가상 인터페이스는 \'링크 속도를 읽지 못한 인터페이스\' 로 세지 않는다(서버 usage.js 와 같은 규칙)', () => {
    const d = { interfaces: [{ bps: 10, bitsPerSec: null, pct: null, virtual: true }, { bps: 10, bitsPerSec: null, pct: null }] };
    const line = text.detailNotes(d).find((x) => x.includes('링크 속도를 읽지 못한 인터페이스'));
    expect(line).toContain('인터페이스 1개');
  });
});

describe('② 서버 노트(buildUsage)가 오면 그대로 싣고, 같은 말을 하는 웹 줄은 양보한다', () => {
  const KIND = { nom104: [1.3e9, 10e9], dr30: [0.48e9, 16e9] };
  const T0 = NOW - 300_000;
  const hbaRow = (host, k, tx) => ({ host, state: 'Online', speedRaw: `${KIND[k][1] / 1e9} Gbit`, bitsPerSec: KIND[k][1], txBytes: tx, rxBytes: 0 });
  /** 명목 초과 OS 포트 1개 + iDRAC 정상 포트 1개 → 서버 노트는 'iDRAC 측정으로 정했습니다'(fallback-value). */
  const built = buildUsage({
    target: { key: 'K', name: 's', vcenterId: 'vc' }, now: NOW, intervalMs: 300_000,
    prev: { at: T0, counters: { hbas: [hbaRow('host0', 'nom104', 0)] }, idrac: { nics: [], fcs: [{ host: 'F0', bitsPerSec: KIND.dr30[1], rxBytes: 0, txBytes: 0, at: T0 }] } },
    os: { ok: true, osKind: 'linux', at: NOW, mem: { usedPct: 1 }, mounts: [], read: [], missing: [], absent: [], counters: { hbas: [hbaRow('host0', 'nom104', KIND.nom104[0] * 300)] } },
    idrac: { ok: true, at: NOW, nics: [], fcs: [{ host: 'F0', bitsPerSec: KIND.dr30[1], rxBytes: 0, txBytes: KIND.dr30[0] * 300, at: NOW }] },
  });
  // 응답 모양 — 장치 이름(host)을 빼고(서버 dFc 와 같은 필드) 노트를 배열로.
  const strip = (rows) => (rows || []).map((x) => { const y = { ...x }; delete y.host; delete y.iface; return y; });
  const d = resp({ osKind: 'linux', fc: strip(built.detail.fc), idracFc: strip(built.detail.idracFc), notes: built.notes });

  it('서버의 명목 초과 문장(실제로 대표값을 정한 경로 포함)이 그대로 나오고 웹 줄은 겹치지 않는다', () => {
    const serverLine = built.notes.find((x) => x.includes('명목 속도(Gbit)로 나눴는데 100% 를 넘은'));
    expect(serverLine).toBeTruthy();
    expect(serverLine).toContain('iDRAC');
    const notes = text.detailNotes(d);
    expect(notes).toContain(serverLine);
    // 웹의 같은 내용 줄(명목 초과 · 데이터율 초과)은 서버 노트가 있으면 나오지 않는다 — 두 번 말하지 않는다.
    expect(notes.some((x) => x.startsWith('**명목 속도(Gbit)를 넘는 처리량이 나온 포트'))).toBe(false);
    expect(notes.filter((x) => x.includes('명목')).length).toBe(built.notes.filter((x) => x.includes('명목')).length);
  });

  it('서버 노트가 없는 입력(옛 응답·옛 테스트 모양)은 예전처럼 웹이 문장을 만든다', () => {
    const old = { ...d }; delete old.notes;
    const notes = text.detailNotes(old);
    expect(notes.some((x) => x.startsWith('**명목 속도(Gbit)를 넘는 처리량이 나온 포트 1개**'))).toBe(true);
  });

  it('서버 노트가 있어도 서버가 말하지 않는 줄(속도를 못 읽은 FC 포트)은 웹이 말한다', () => {
    const notes = text.detailNotes(resp({ fc: [{ bps: 5, pct: null, pctBasis: null }], notes: ['첫 수집이라 …'] }));
    expect(notes.some((x) => x.includes('속도를 읽지 못한 FC 포트 1개'))).toBe(true);
    expect(notes[notes.length - 1]).toBe('첫 수집이라 …');
  });
});

describe('③ usageDetailNote — 상세가 없으면 이유를 말하고 지어내지 않는다', () => {
  it('none(재시작 직후·아직 수집 전) · 꺼짐 · demo · ok(언제 것인지) · 실패 주기', () => {
    const none = text.usageDetailNote({ usageDetail: null, usageDetailState: 'none', usageDetailSince: NOW - 5 * 60_000 }, { enabled: true, now: NOW });
    expect(none).toContain('5분 전 시작한 뒤 이 서버를 아직 수집하지 않아');
    expect(none).toContain('재시작하면 다음 수집 뒤에 다시 나옵니다');
    expect(none).not.toContain('읽은 것이 없');
    const off = text.usageDetailNote({ usageDetailState: 'none', usageDetailSince: NOW }, { enabled: false, now: NOW });
    expect(off).toContain('수집이 꺼져 있어');
    expect(text.usageDetailNote({ usageDetailState: 'demo' }, { now: NOW })).toContain('데모 대상');
    const ok = text.usageDetailNote({ usageDetail: resp(), usageDetailState: 'ok' }, { now: NOW });
    expect(ok).toContain('2분 전 수집');
    const fail = text.usageDetailNote({ usageDetail: resp({ ok: false }), usageDetailState: 'ok' }, { now: NOW });
    expect(fail).toContain('값을 읽지 못한 주기');
    // 옛 서버(상태 필드 없음)·응답 없음 — 빈 문자열.
    expect(text.usageDetailNote({ ok: true, raw: [] }, { now: NOW })).toBe('');
    expect(text.usageDetailNote(null)).toBe('');
    for (const s of [none, off, ok, fail]) {
      expect(s).not.toMatch(/`/);
      expect(s).not.toMatch(/null|undefined|NaN/);
    }
  });
});

describe('④ BmUsage.jsx — 상세 카드가 상세 조회 응답의 usageDetail 을 문구 함수에 넘긴다', () => {
  const src = stripComments(fs.readFileSync(new URL('./BmUsage.jsx', import.meta.url), 'utf8'));
  it('목록 행의 detail(어떤 응답에도 없는 필드)을 읽지 않는다', () => {
    expect(src).not.toMatch(/selRow\??\.detail\b/);
  });
  it('usageDetail 을 고른 서버 응답에서 꺼내 detailNotes·telemetryNote·entDetailNotes·원문·차트 absent 에 넘긴다', () => {
    expect(src).toMatch(/detailForSel\?\.usageDetail/);
    expect(src).toMatch(/telemetryNote\(ud \|\| \{\}\)/);
    expect(src).toMatch(/detailNotes\(\{ \.\.\.\(detailForSel\?\.target \|\| \{\}\), \.\.\.ud \}\)/);
    expect(src).toMatch(/entDetailNotes\(ud \|\| \{\}\)/);
    expect(src).toMatch(/ud\?\.entRaw/);
    expect(src).toMatch(/ud\?\.idracAbsent/);
    expect(src).toMatch(/usageDetailNote\(detailForSel/);
  });
});

/*
 * v2.744(VE 독립 검토 R1·R2 — 리드 보완):
 *   R1 서버 상세에는 노트 배열이 언제나(빈 배열이어도) 실린다. 예전 판정은 '배열이 있다' 만으로 웹의 '링크 속도를 읽지 못한 인터페이스' 줄과
 *      FC 초과 줄을 숨겨, 그 노트를 내지 않는 Windows 경로에서 안내가 사라졌다 — 서버가 **같은 말을 실제로 했을 때만** 양보한다.
 *   R2 수집이 꺼져 있으면 마지막 상세가 그대로 남는다 — '다음 수집 때 바뀝니다' 라고 말하지 않는다.
 */
describe('⑤ VE 검토 R1·R2 — 양보는 서버가 같은 말을 했을 때만 · 꺼짐이면 바뀐다고 말하지 않는다', () => {
  const strip = (rows) => (rows || []).map((x) => { const y = { ...x }; delete y.host; delete y.iface; delete y.name; return y; });
  it('R1 Windows 경로: 서버 노트에 링크 속도 노트가 없으면 웹이 그 안내를 낸다', () => {
    const built = buildUsage({ now: NOW, os: { ok: true, osKind: 'windows', at: NOW, nics: [{ name: 'Ethernet0', bytesPerSec: 12_345, bitsPerSec: null, pct: null }], hbas: [], disks: [], read: ['nic'], missing: [], absent: [] } });
    expect(built.notes.some((x) => x.includes('링크 속도를 읽지 못한 인터페이스'))).toBe(false);
    const notes = text.detailNotes(resp({ osKind: 'windows', interfaces: strip(built.detail.interfaces), notes: built.notes }));
    expect(notes.some((x) => x.includes('링크 속도를 읽지 못한 인터페이스 1개'))).toBe(true);
  });
  it('R1 Linux 경로: 서버가 같은 노트를 냈으면 웹 줄은 겹치지 않는다(한 번만 말한다)', () => {
    const prev = { at: NOW - 300_000, counters: { nets: [{ iface: 'eth0', rxBytes: 1_000, txBytes: 1_000, bitsPerSec: null }] } };
    const os = { ok: true, osKind: 'linux', at: NOW, mem: { usedPct: 1 }, mounts: [], read: ['net'], missing: [], absent: [], counters: { nets: [{ iface: 'eth0', rxBytes: 301_000, txBytes: 301_000, bitsPerSec: null }] } };
    const built = buildUsage({ now: NOW, os, prev });
    expect(built.notes.some((x) => x.includes('링크 속도를 읽지 못한 인터페이스'))).toBe(true);
    const notes = text.detailNotes(resp({ osKind: 'linux', interfaces: strip(built.detail.interfaces), notes: built.notes }));
    expect(notes.filter((x) => x.includes('링크 속도를 읽지 못한 인터페이스')).length).toBe(1);
  });
  it('R1 서버 노트에 FC 데이터율 노트가 없으면 FC 초과 줄은 웹이 말한다(노트 상한에 잘린 경우 등)', () => {
    const notes = text.detailNotes(resp({ fc: [{ bps: 9e9, pct: null, pctOver: true, pctBasis: 'dataRate' }], notes: ['첫 수집이라 …'] }));
    expect(notes.some((x) => x.includes('FC 표준 데이터율을 넘는 처리량이 크게 나온 포트 1개'))).toBe(true);
    const yielded = text.detailNotes(resp({ fc: [{ bps: 9e9, pct: null, pctOver: true, pctBasis: 'dataRate' }], notes: ['FC 표준 데이터율을 넘는 처리량이 나온 HBA 1개는 …'] }));
    expect(yielded.some((x) => x.startsWith('**FC 표준 데이터율을 넘는 처리량이 크게 나온 포트'))).toBe(false);
  });
  it('R2 수집이 꺼져 있으면 ok 상세도 "바뀌지 않습니다" 라고 말한다', () => {
    const off = text.usageDetailNote({ usageDetail: resp(), usageDetailState: 'ok' }, { enabled: false, now: NOW });
    expect(off).toContain('수집이 꺼져 있어 바뀌지 않습니다');
    expect(off).not.toContain('다음 수집 때');
    const offFail = text.usageDetailNote({ usageDetail: resp({ ok: false }), usageDetailState: 'ok' }, { enabled: false, now: NOW });
    expect(offFail).toContain('바뀌지 않습니다');
    const on = text.usageDetailNote({ usageDetail: resp(), usageDetailState: 'ok' }, { enabled: true, now: NOW });
    expect(on).toContain('다음 수집 때 바뀝니다');
  });
});
