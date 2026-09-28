/**
 * v2.636 — IP관리 서브메뉴(사용자 요청 2026-09-28: "IPMS 설정·추천 30선·대용량 CSV·스캔 상태·스캔 로그를 각각의 페이지로 ·
 * 편집하다가 없어지는 일이 없도록").
 *   ① 페이지 정의(ipamPages) — 키 고유·그룹·관리자 페이지 숨김은 '확실히 아님(403)' 일 때만
 *   ② 편집 초안(ipamDraft) — 저장·복원·서버 값 변경 감지·같은 값이면 지움·저장소 없음/큰 값은 volatile
 *   ③ CSV 분할(ipamCsvChunk) — **서버 파서와 같은 행 경계**(행 번호가 원래 파일과 같아야 한다) · 조각 한도 · 조각을 넘는 중복
 *   ④ 문구 — 서버 이벤트 목록과 1:1 · 백틱 0 · null 을 0 으로 말하지 않는다
 *   ⑤ 화면 소스 — 대장 로딩이 화면 전체를 갈아치우지 않는다(편집 유실의 원인) · 설정은 페이지로 · 해시 키 전부
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../../test/_stripComments.js';
import { IPAM_PAGES, IPAM_PAGE_KEYS, IPAM_GROUPS, menuGroups, pageShown, pageDeniedNote, ipamPage } from './ipamPages.js';
import * as D from './ipamDraft.js';
import { splitCsvRecords, chunkRecords, mergeManageReports, commentRecord, ipColumnIndex, normHeader, utf8Len, sniffDelimiter } from './ipamCsvChunk.js';
import * as L from './ipamScanLogText.js';
import * as C from './ipamCsvText.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.resolve(HERE, p), 'utf8');

describe('① 페이지 정의', () => {
  it('키는 고유하고 전부 그룹에 속한다', () => {
    expect(new Set(IPAM_PAGE_KEYS).size).toBe(IPAM_PAGE_KEYS.length);
    const groups = new Set(IPAM_GROUPS.map(([g]) => g));
    for (const p of IPAM_PAGES) expect(groups.has(p.group), p.k).toBe(true);
    // 사용자가 요청한 페이지가 전부 있다
    for (const k of ['list', 'sheet', 'insights', 'netmap', 'ranges', 'policies', 'scan', 'status', 'log', 'ipms', 'csv']) expect(ipamPage(k), k).toBeTruthy();
  });
  it("관리자 페이지는 '확실히 아님(no)' 일 때만 숨긴다 — 모름(unknown)은 보인다(권한은 서버가 집행)", () => {
    const keysOf = (a) => menuGroups(a).flatMap((g) => g.pages.map((p) => p.k));
    expect(keysOf('yes')).toEqual(expect.arrayContaining(['scan', 'status', 'log', 'ipms']));
    expect(keysOf('unknown')).toEqual(expect.arrayContaining(['scan', 'status', 'log', 'ipms']));
    const no = keysOf('no');
    for (const k of ['scan', 'status', 'log', 'ipms']) expect(no).not.toContain(k);
    expect(no).toEqual(expect.arrayContaining(['list', 'csv', 'insights']));
    expect(pageShown('nope', 'yes')).toBe(false);
  });
  it('관리자 페이지를 주소로 연 비관리자에게 안내한다(모름이면 단정하지 않는다)', () => {
    expect(pageDeniedNote('ipms', 'no')).toMatch(/관리자만/);
    expect(pageDeniedNote('ipms', 'unknown')).toBeNull();
    expect(pageDeniedNote('list', 'no')).toBeNull();
  });
});

describe('② 편집 초안', () => {
  let store;
  beforeEach(() => {
    store = new Map();
    globalThis.window = { sessionStorage: {
      get length() { return store.size; }, key: (i) => [...store.keys()][i] ?? null,
      getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); },
    } };
    D._resetDraftsForTest();
  });
  afterEach(() => { delete globalThis.window; D._resetDraftsForTest(); });

  it('쓰고·읽고·지운다 + 세션 저장소에 남는다(새로고침 대비)', () => {
    D.writeDraft('scan:__local__', { ranges: ['10.0.0.0/24'] }, { ranges: [] });
    expect(D.readDraft('scan:__local__').value.ranges).toEqual(['10.0.0.0/24']);
    expect([...store.keys()]).toEqual(['ipam.draft.scan:__local__']);
    expect(D.dirtyPages().has('scan')).toBe(true);
    // 메모리를 비워도(새로고침) 세션 저장소에서 되살아난다
    D._resetDraftsForTest();
    expect(D.readDraft('scan:__local__')?.value.ranges).toEqual(['10.0.0.0/24']);
    D.clearDraft('scan:__local__');
    expect(D.readDraft('scan:__local__')).toBeNull();
    expect(store.size).toBe(0);
  });
  it('초안이 있으면 초안이 이기고, 그 사이 서버 값이 바뀌었으면 알린다', () => {
    const base = { global: ['1.1.1.1'] };
    D.writeDraft('ipms:settings', { global: ['1.1.1.1', '2.2.2.2'] }, base);
    const same = D.resolveDraft(base, D.readDraft('ipms:settings'));
    expect(same).toMatchObject({ restored: true, serverChanged: false });
    expect(same.value.global).toEqual(['1.1.1.1', '2.2.2.2']);
    const changed = D.resolveDraft({ global: ['9.9.9.9'] }, D.readDraft('ipms:settings'));
    expect(changed).toMatchObject({ restored: true, serverChanged: true });
    // 초안이 서버 값과 같으면 '복원' 이 아니다
    expect(D.resolveDraft({ global: ['1.1.1.1', '2.2.2.2'] }, D.readDraft('ipms:settings')).restored).toBe(false);
    expect(D.resolveDraft(base, null)).toMatchObject({ value: base, restored: false });
  });
  it('값 비교는 객체 키 순서와 무관하다', () => {
    expect(D.sameValue({ a: 1, b: [1, { c: 2, d: 3 }] }, { b: [1, { d: 3, c: 2 }], a: 1 })).toBe(true);
    expect(D.sameValue({ a: 1 }, { a: 2 })).toBe(false);
    expect(D.sameValue({ a: 1, u: undefined }, { a: 1 })).toBe(true);
  });
  it('큰 초안·저장소 없음은 메모리에만 두고 volatile 로 밝힌다', () => {
    const big = 'x'.repeat(D.MAX_PERSIST + 10);
    expect(D.writeDraft('csv:manage', big, '').volatile).toBe(true);
    expect(store.has('ipam.draft.csv:manage')).toBe(false);
    expect(D.readDraft('csv:manage').value.length).toBe(big.length);
    delete globalThis.window; D._resetDraftsForTest();
    expect(D.writeDraft('scan:a', { x: 1 }, {}).volatile).toBe(true);
  });
  it('안내 문구 — 변경·복원·서버 변경·volatile 을 각각 말하고, 깨끗하면 null', () => {
    expect(D.draftNote({})).toBeNull();
    expect(D.draftNote({ dirty: true })).toMatch(/저장하지 않은 변경/);
    expect(D.draftNote({ dirty: true, restored: true })).toMatch(/복원/);
    expect(D.draftNote({ dirty: true, restored: true, serverChanged: true })).toMatch(/서버에 저장된 값이 바뀌었습니다/);
    expect(D.draftNote({ dirty: true, volatile: true })).toMatch(/새로고침하면 사라집니다/);
    // CSV 가져오기 입력은 '저장' 이 아니라 '적용' 이라고 말한다
    expect(D.draftNote({ dirty: true, kind: 'import' })).toMatch(/‘적용’ 을 눌러야/);
    expect(D.draftNote({ dirty: true, kind: 'import' })).not.toMatch(/저장을 눌러야/);
  });
  it('구독자는 쓰기·지우기에 불린다', () => {
    let n = 0; const off = D.onDraftChange(() => { n++; });
    D.writeDraft('ipms:x', 1, 0); D.clearDraft('ipms:x'); D.clearDraft('ipms:x');
    off(); D.writeDraft('ipms:y', 1, 0);
    expect(n).toBe(2);
  });
});

describe('③ CSV 분할 — 서버 파서와 같은 행 경계', async () => {
  const server = await import('../../../../server/src/util/csv.js');
  const manage = await import('../../../../server/src/ipam/manageCsv.js');
  const TEXTS = [
    'ip,memo\n10.0.0.1,"여러\n줄 메모"\n\n10.0.0.2,"따옴표 ""안"" 값"\r\n,,\n10.0.0.3,x\n',
    '﻿ip\tstatus\n10.0.0.1\tactive\n10.0.0.2\treserved',
    '\n\nip,owner\n  ,  \n10.0.0.9,"a,b"\n',
    'ip,note\n10.0.0.1,he said "hi"\n10.0.0.2,"x\r\ny"\n',
  ];
  it.each(TEXTS)('행·칸이 서버 parseCsvRows 와 같다 — %#', (t) => {
    const mine = splitCsvRecords(t);
    const theirs = server.parseCsvRows(t);
    expect([mine.header.cells, ...mine.records.map((r) => r.cells)]).toEqual(theirs);
  });
  it('구분자 판정이 같다(쉼표 우선 · 탭만 있으면 탭)', () => {
    expect(sniffDelimiter('ip\tstatus\n')).toBe('\t');
    expect(sniffDelimiter('ip,status\tx\n')).toBe(',');
  });
  it('조각마다 헤더를 붙이고, 서버가 매기는 행 번호가 원래 파일의 행 번호와 같다', () => {
    const rows = Array.from({ length: 23 }, (_, i) => `10.1.0.${i + 1},m${i}`);
    const t = `ip,memo\n${rows.slice(0, 5).join('\n')}\n\n${rows.slice(5).join('\n')}\n`;
    const parsed = splitCsvRecords(t);
    const chunks = chunkRecords(parsed, { maxRows: 7 });
    expect(chunks.map((c) => c.rows)).toEqual([7, 7, 7, 2]);
    expect(chunks.map((c) => c.lineOffset)).toEqual([0, 7, 14, 21]);
    const whole = manage.parseManageCsv(t, { maxRows: 100 }).rows.map((r) => [r._line, r.ip]);
    const pieces = chunks.flatMap((c) => manage.parseManageCsv(c.csv, { lineOffset: c.lineOffset, maxRows: 100 }).rows.map((r) => [r._line, r.ip]));
    expect(pieces).toEqual(whole);
  });
  it('바이트 한도로도 나눈다(한글은 3바이트)', () => {
    expect(utf8Len('가a')).toBe(4);
    const t = `ip,memo\n${Array.from({ length: 10 }, (_, i) => `10.2.0.${i + 1},${'가'.repeat(100)}`).join('\n')}`;
    const chunks = chunkRecords(splitCsvRecords(t), { maxRows: 1000, maxBytes: 1000 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(utf8Len(c.csv)).toBeLessThanOrEqual(1000 + 400);
  });
  it('조각을 넘는 같은 IP — 뒤 행을 오류로 바꾸고 적용 때 주석 행으로 보낸다(행 번호 유지)', () => {
    const r1 = { report: [{ line: 2, ip: '10.0.0.1', action: 'create', changes: ['status'] }, { line: 3, ip: '10.0.0.2', action: 'error', reason: 'x' }] };
    const r2 = { report: [{ line: 4, ip: '10.0.0.1', action: 'update', changes: ['owner'] }, { line: 5, ip: '10.0.0.3', action: 'same', changes: [] }] };
    const m = mergeManageReports([r1, r2]);
    expect(m.report.find((x) => x.line === 4).action).toBe('error');
    expect(m.report.find((x) => x.line === 4).reason).toMatch(/2행/);
    expect([...m.skip]).toEqual([2]);
    expect(m.summary).toEqual({ create: 1, update: 0, same: 1, clear: 0, error: 2 });
    // 주석 행은 ip 칸이 '#' 로 시작한다 — 서버가 건너뛰고 행 번호는 그대로
    const t = 'owner,ip,status\nA,10.0.0.1,active\nB,10.0.0.1,reserved\n';
    const parsed = splitCsvRecords(t);
    const ipIdx = ipColumnIndex(parsed.header.cells);
    expect(ipIdx).toBe(1);
    const [chunk] = chunkRecords(parsed, { replace: new Map([[1, commentRecord(ipIdx, parsed.delim)]]) });
    const rows = manage.parseManageCsv(chunk.csv).rows;
    expect(rows.map((r) => [r._line, r.ip])).toEqual([[2, '10.0.0.1']]);
  });
  it('헤더 정규화는 서버와 같다(역가드·공백·밑줄·괄호)', () => {
    expect(normHeader(" IP_Address ")).toBe('ipaddress');
    expect(normHeader("'=ip")).toBe('=ip');
    expect(ipColumnIndex(['상태', 'IP주소'])).toBe(1);
    expect(ipColumnIndex(['a', 'b'])).toBe(-1);
  });
});

describe('④ 문구', () => {
  it('스캔 로그 이벤트 표가 서버 SCAN_LOG_EVENTS 와 1:1', () => {
    const src = read('../../../../server/src/ipam/scanLog.js');
    const m = /SCAN_LOG_EVENTS = Object\.freeze\(\[([^\]]*)\]\)/.exec(src);
    const events = m[1].match(/'([a-z]+)'/g).map((x) => x.slice(1, -1));
    expect(Object.keys(L.EVENT_TEXT).sort()).toEqual([...events].sort());
  });
  it('못 읽은 수치는 0 이 아니라 —', () => {
    expect(L.countsText({ scanned: null, alive: null })).toBe('—');
    expect(L.countsText({ scanned: 256, alive: null })).toBe('256 / —');
    expect(L.durationText(null)).toBe('—');
    expect(L.durationText('')).toBe('—');
    expect(L.durationText(1500)).toBe('1.5초');
    expect(L.rangesText({ ranges: null })).toBe('—');
    expect(L.rangesText({ ranges: 7, rangesSample: ['a', 'b'] })).toBe('7개 · a, b 외 5개');
    expect(L.agentText('__local__')).toBe('이 포탈');
    expect(L.repeatText({ count: 1 })).toBe('');
  });
  it('상한으로 잘렸으면 말한다 · 비어 있음을 단정하지 않는다', () => {
    expect(L.listHeadText({ entries: [1], matched: 5, total: 9, max: 1000, truncated: true })).toMatch(/잘렸습니다/);
    expect(L.emptyText(false)).toMatch(/v2\.636 부터/);
  });
  it('CSV 결과 문구', () => {
    expect(C.applicableCount({ create: 2, update: 3, clear: 1, same: 9, error: 4 })).toBe(6);
    expect(C.changesText(['status', 'claimedVcenterId', 'memo'])).toBe('상태, 귀속 vCenter, 메모');
    expect(C.planText({ blocked: '막힘', before: [], after: [], added: [], removed: [] })).toBe('막힘');
    expect(C.planText({ isNew: true, before: [], after: ['a'], added: ['a'], removed: [] })).toMatch(/새 에이전트 · 0개 → 1개 · \+1/);
    expect(C.manageApplyText({ applied: 3, override: { changed: 2, removed: 1 }, annotation: { changed: 0, removed: 0 }, summary: { error: 1 } })).toMatch(/다시 판정/);
  });
  it('화면 문구에 백틱이 없다(BoldText 는 **강조** 만 해석한다)', () => {
    const strs = [...Object.values(C.MANAGE_ACTION).flat(), ...Object.values(C.MODE_NOTE), ...C.MANAGE_RULES, ...Object.values(L.EVENT_TEXT),
      ...IPAM_PAGES.flatMap((p) => [p.label, p.title]), D.draftNote({ dirty: true, restored: true, serverChanged: true, volatile: true }), L.emptyText(false)];
    for (const s of strs) expect(String(s), s).not.toMatch(/`/);
  });
});

describe('⑤ 화면 소스', () => {
  const core = stripComments(read('./IpamCore.jsx'));
  const ipamFn = core.slice(core.indexOf('function Ipam('), core.indexOf('function IpOwnerDetail('));
  it('대장 로딩이 화면 전체를 갈아치우지 않는다(예전: if (loading) return <Loading /> 가 설정 모달까지 언마운트)', () => {
    expect(ipamFn).not.toMatch(/if \(loading\) return <Loading/);
    expect(ipamFn).not.toMatch(/if \(error\) return <ErrorBox/);
  });
  it('해시 키는 페이지 전부 · 설정은 모달이 아니라 페이지(asPage)', () => {
    expect(ipamFn).toMatch(/useHashTab\(\{ base: \['ipam'\], valid: IPAM_PAGE_KEYS/);
    // v2.638 부터 onSaved · v2.639 부터 access 도 넘긴다 — 'asPage 로 그린다' 만 고정한다(D3: 초판 정규식이 ' />' 까지 요구해 깨졌다).
    expect(ipamFn).toMatch(/<IpScanSettings asPage\b/);
    expect(ipamFn).toMatch(/<IpmsSettings asPage\b/);
    expect(ipamFn).toMatch(/<ScanStatusModal asPage \/>/);
    expect(ipamFn).toMatch(/<IpamScanLog \/>/);
    expect(ipamFn).toMatch(/<IpamCsv /);
    expect(ipamFn).not.toMatch(/setScanOpen|setIpms\(|setScanStatusOpen/);
  });
  it('설정 폼은 편집 초안을 쓴다(IPMS·vCenter 스캔 대역·IP 스캔) — v2.639 분할 뒤 파일별', () => {
    // v2.639(U2): IpamSettings.jsx 는 재수출 셸이고 구현은 성격별 파일에 있다. 초안 키의 첫 조각은 서브메뉴 키여야 한다(pageOfKey → ● 표시).
    expect(stripComments(read('./IpmsSettings.jsx'))).toMatch(/useIpamDraft\('ipms:settings'\)/);
    const editor = stripComments(read('./VcScanRangeEditor.jsx'));
    expect(editor).toMatch(/useIpamDraft\(`\$\{draftPrefix\}:\$\{vc \|\| '-'\}`\)/);
    expect(stripComments(read('./IpmsSettings.jsx'))).toMatch(/draftPrefix="ipms:vcscan"/);
    expect(stripComments(read('./IpamNet.jsx'))).toMatch(/draftPrefix="ranges:vc"/);
    const scan = stripComments(read('./IpScanSettings.jsx'));
    expect(scan).toMatch(/useIpamDraft\(`scan:\$\{agent\}`\)/);
    expect(scan).toMatch(/d\.saved\(r\.settings\)/);
    // 재수출 셸에는 구현이 없다
    const shell = stripComments(read('./IpamSettings.jsx'));
    expect(shell).not.toMatch(/useState|useEffect|<Frame/);
    for (const name of ['MemoEditor', 'OverrideEditor', 'IpmsSettings', 'IpScanSettings', 'ipScanAccept', 'ScanProgressBar', 'ScanStatusModal', 'vcRangesGate']) expect(shell, name).toContain(name);
  });
  it('CSV 적용 뒤에는 초안을 내린다(적용한 입력을 \'미적용\' 으로 말하지 않는다)', () => {
    const csv = stripComments(read('./IpamCsv.jsx'));
    expect((csv.match(/d\.saved\(text\)/g) || []).length).toBe(2);
  });
  it('서브메뉴가 저장하지 않은 페이지를 표시하고, 탭을 닫을 때 경고한다', () => {
    expect(ipamFn).toMatch(/dirty\.has\(pg\.k\)/);
    expect(ipamFn).toMatch(/beforeunload/);
  });
});
