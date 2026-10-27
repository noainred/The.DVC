import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import * as T from './backupEmText.js';
import { emStatusCell } from '../VeeamEmSettings.jsx';

describe('v2.788 Veeam 백업 현황 · EM 탭 도우미', async () => {
  const EC = await import('../../../../server/src/veeam/em/client.js');
  const V = await import('../../../../server/src/veeam/em/view.js');
  const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;

  it('못 읽은 값은 — (0 이 아니다) · 크기·소요 시간 · 날짜는 로컬', () => {
    expect([T.fmtBytes(null), T.fmtBytes(undefined), T.fmtBytes(''), T.fmtBytes(0)]).toEqual(['—', '—', '—', '0 B']);
    expect([T.fmtBytes(412e12), T.fmtBytes(1.9e15), T.fmtBytes(212e9)]).toEqual(['412 TB', '1.9 PB', '212 GB']);
    expect([T.fmtDur(null), T.fmtDur(18720), T.fmtDur(2520), T.fmtDur(30)]).toEqual(['—', '5시간 12분', '42분', '30초']);
    expect(T.dateText(null)).toBe('—');
    expect(T.dateText(new Date(2027, 2, 31, 12).getTime())).toBe('2027-03-31');
    expect([T.ddayText(null), T.ddayText(47), T.ddayText(-3)]).toEqual(['—', 'D-47', '만료(3일 지남)']);
    expect([T.ddayTone(5), T.ddayTone(25), T.ddayTone(60), T.ddayTone(200), T.ddayTone(null)]).toEqual(['fail', 'warn', 'run', 'ok', 'none']);
  });

  it('수집 항목 이름 = 서버 EM_SECTIONS(같은 키·순서) · 상태 줄', () => {
    expect(Object.keys(T.SECTION_LABEL)).toEqual([...EC.EM_SECTIONS]);
    expect(T.statusLine(null).tone).toBe('muted');
    expect(T.statusLine({ ok: false, kind: 'auth-stopped', authStop: {}, lastOkTs: NOW }).tone).toBe('bad');
    expect(T.statusLine({ ok: false, error: 'down', lastOkTs: NOW }, NOW).text).toMatch(/마지막 성공/);
    const okLine = T.statusLine({ ok: true, ts: NOW, lastOkTs: NOW, sections: { overview: { ok: true }, jobs: { ok: false, reason: 'x' } } }, NOW);
    expect(okLine.tone).toBe('warn');
    expect(okLine.text).toMatch(/1개 항목을 읽지 못했습니다/);
    expect(T.sectionChips({ sections: { jobs: { ok: false, reason: 'r' }, overview: { ok: true } } }).map((c) => [c.k, c.ok])).toEqual([['overview', true], ['jobs', false]]);
  });

  it('라이선스 카드 — 합계는 서버 licenseTotals(둘 다 아는 서버만) · 사용 많은 순', () => {
    const items = [
      { id: 'a', name: 'A', license: { instances: { used: 100, licensed: 200 }, supportExpires: NOW + 10 * 86_400_000 } },
      { id: 'b', name: 'B', license: { instances: { used: 300, licensed: null } } },
      { id: 'c', name: 'C', license: { instances: { used: 50, licensed: 100 } } },
    ];
    const c = T.licenseCard({ items, totals: V.licenseTotals(items, NOW) });
    expect([c.used, c.licensed, c.remain, c.pct, c.unknown]).toEqual([150, 300, 150, 50, 1]);
    expect(c.items.map((x) => x.id)).toEqual(['b', 'a', 'c']);
    expect(c.items[0].pct).toBe(null);
    expect(c.earliestSupport.daysLeft).toBe(10);
    expect(T.licenseCard(null).pct).toBe(null);
  });

  it('작업 — 서버 jobsView 순서(실패 → 경고 → 실행 중 → 정상 → 기록 없음) · 필터·검색 · 24시간 막대', () => {
    const jv = V.jobsView([
      { name: 'ok1', server: 'S', last: { result: 'ok', end: NOW } }, { name: 'none1', server: 'S', last: null },
      { name: 'fail1', server: 'PL', last: { result: 'fail', end: NOW } }, { name: 'run1', server: 'S', running: { start: NOW }, last: null },
      { name: 'warn1', server: 'S', last: { result: 'warn', end: NOW } },
    ]);
    expect(jv.items.map((j) => j.state)).toEqual(['fail', 'warn', 'run', 'ok', 'none']);
    expect(jv.counts).toEqual({ all: 5, fail: 1, warn: 1, run: 1, ok: 1, none: 1 });
    expect(T.filterJobs(jv.items, 'fail').map((j) => j.name)).toEqual(['fail1']);
    expect(T.filterJobs(jv.items, 'all', 'pl').map((j) => j.name)).toEqual(['fail1']);
    expect(T.JOB_FILTERS.map(([k]) => k)).toEqual(['all', 'fail', 'warn', 'run', 'ok', 'none']);
    expect(T.runBar({ ok: 0, warn: 0, fail: 0 })).toBe(null);
    expect(T.runBar({ ok: 452, warn: 23, fail: 11 }).total).toBe(486);
  });

  it('저장소 사용률·추이 — 모르면 null · 한 점은 추이가 아니다 · 빈 날은 건너뛴다', () => {
    expect([T.usedPctOf(100, 7), T.usedPctOf(null, 1), T.usedPctOf(0, 0)]).toEqual([93, null, null]);
    expect([T.repoTone(93), T.repoTone(84), T.repoTone(40), T.repoTone(null)]).toEqual(['fail', 'warn', 'run', 'none']);
    expect(T.sparkPoints([[1, 100, 10]], T.usedPctOf)).toBe(null);
    const sp = T.sparkPoints([[1, 100, 50], [2, null, null], [3, 100, 10]], T.usedPctOf);
    expect(sp.days).toBe(2);
    expect([sp.first, sp.last]).toEqual([50, 90]);
  });

  it('설정 상태 칸 — 꺼짐·수집 전·인증 정지·실패·못 읽은 항목', () => {
    expect(emStatusCell(null, false).text).toBe('수집 꺼짐');
    expect(emStatusCell(null).text).toBe('아직 수집 전');
    expect(emStatusCell({ ok: false, kind: 'auth-stopped' }).tone).toBe('bad');
    expect(emStatusCell({ ok: true, ts: NOW, sections: { jobs: { ok: false } } }).sub).toMatch(/작업/);
  });

  it('화면 — EM 탭 머리 · 결과 확인(r?.ok === false) · 폴링 없음 · 대문자 변환 없음', () => {
    const tool = fs.readFileSync(new URL('./BackupEmTool.jsx', import.meta.url), 'utf8');
    expect(tool).toMatch(/<VeeamHeader active="em"/);
    expect(tool).not.toMatch(/setInterval/);
    const set = fs.readFileSync(new URL('../VeeamEmSettings.jsx', import.meta.url), 'utf8');
    expect(set).toMatch(/const r = await sendJson\('\/admin\/veeam\/em', 'POST'[\s\S]{0,140}r\?\.ok === false/);
    expect(tool + set).not.toMatch(/textTransform|text-transform/);
    const vs = fs.readFileSync(new URL('../VeeamSettings.jsx', import.meta.url), 'utf8');
    expect(vs).toMatch(/useHashTab\(\{ base: \['settings', 'veeam'\]/);
  });
});

describe('v2.788.1 EM 매핑 · 실패·경고 상세', async () => {
  const V = await import('../../../../server/src/veeam/em/view.js');
  it('짝·법인 문구 — 서버 mapBackupServers 의 출처 값을 그대로 읽는다', () => {
    const rows = V.mapBackupServers([{ name: 'AZ' }, { name: 'HM' }, { name: 'NJ' }], {
      emId: 'e', brServers: [{ id: 'b1', name: 'AZ', host: 'az', vcenterIds: ['us:az'] }],
      map: { 'e|hm': { br: 'none', vcenterIds: ['eu:hm'] } }, vcName: new Map([['us:az', 'Arizona'], ['eu:hm', 'Hungary']]),
    });
    expect(rows.map((r) => T.brMatchText(r).text)).toEqual(['AZ (이름으로 자동)', '포탈에 없음(확정)', '짝 없음 — 포탈 미등록']);
    expect(rows.map((r) => [T.vcMatchText(r).text, T.vcMatchText(r).sub])).toEqual([['Arizona', 'B&R 등록을 따름'], ['Hungary', '수동'], ['정하지 않음', '']]);
    expect(T.mappingSummary([...rows, { name: 'X', gone: true }])).toEqual({ total: 3, registered: 1, withVc: 2, gone: 1 });
    expect(T.brMatchText({ brSource: 'missing' }).tone).toBe('fail');
  });
  it('상세 — 실패 → 경고 → 정상 순 · 소요 · 결과를 모르면 열지 않는다', () => {
    const s = T.detailSummary({ head: { end: 1_800_000_000_000 }, tasks: [
      { vm: 'b', result: 'ok', start: 0, end: 60_000 }, { vm: 'a', result: 'warn', start: 0, end: 120_000 }, { vm: 'c', result: 'fail', start: null, end: 5 },
    ] });
    expect(s.tasks.map((t) => t.vm)).toEqual(['c', 'a', 'b']);
    expect(s.tasks.map((t) => t.durSec)).toEqual([null, 120, 60]);
    expect(s.counts).toEqual({ fail: 1, warn: 1, ok: 1 });
    expect(s.line).toMatch(/VM 3대 — 실패 1 · 경고 1 · 정상 1/);
    expect(T.detailSummary({ head: null, tasks: null }).line).toBe('');
    expect([T.canOpenDetail('fail', 'u'), T.canOpenDetail('warn', 'u'), T.canOpenDetail('ok', 'u'), T.canOpenDetail('fail', '')]).toEqual([true, true, false, false]);
  });
  it('화면 — 매핑 저장은 r?.ok === false 확인 · 상세는 늦은 응답 버림 · 백틱 없음', () => {
    const m = fs.readFileSync(new URL('../VeeamEmMapping.jsx', import.meta.url), 'utf8');
    expect(m).toMatch(/const r = await sendJson\('\/admin\/veeam\/em\/map', 'PUT', body\);\s*\n\s*if \(r\?\.ok === false\)/);
    const d = fs.readFileSync(new URL('./EmSessionDetail.jsx', import.meta.url), 'utf8');
    expect(d).toMatch(/if \(my === gen\.current\) setD\(r\)/);
    const tool = fs.readFileSync(new URL('./BackupEmTool.jsx', import.meta.url), 'utf8');
    expect(tool).toMatch(/<EmSessionDetail emId=\{em\.id\} uid=\{j\.last\.uid\}/);
  });
});

describe('v2.795 EM VM 단위 반영 — 설정 매핑 표의 vCenter 반영 칸', () => {
  it('서버가 정한 반영 값을 문구로 · VM 수를 모르면 — (0 이 아니다)', () => {
    expect(T.reflectText({ reflect: 'em', vmCount: 1234, brId: '' })).toMatchObject({ text: 'EM 기록으로', sub: 'VM 1,234대', tone: 'run' });
    expect(T.reflectText({ reflect: 'em', vmCount: 3, brId: 'vbr-1' }).sub).toMatch(/B&R 읽기 실패·대기 대신/);
    expect(T.reflectText({ reflect: 'br', vmCount: null }).sub).toMatch(/EM 기록 —/);
    expect(T.reflectText({ reflect: 'none' }).text).toBe('반영 안 함');
    expect(T.reflectText({ reflect: 'em', gone: true }).text).toBe('반영 안 함');
    expect(T.reflectText({ reflect: 'mixed', vmCount: 0 }).sub).toMatch(/VM 0대/);
  });
  it('화면 — 매핑 표에 반영 칸 · 접힌 편집 줄이 칸 수를 따라간다', () => {
    const m = fs.readFileSync(new URL('../VeeamEmMapping.jsx', import.meta.url), 'utf8');
    expect(m).toMatch(/<th[^>]*>vCenter 반영<\/th>/);
    expect(m).toMatch(/colSpan=\{6\}/);
    expect(m).not.toMatch(/colSpan=\{5\}/);
  });
});

describe('v2.798 EM 서버를 포탈 B&R 로 바로 등록 · 서버 수 확인', () => {
  it('등록 양식 — 이름을 표시명·주소로 미리 채우고 REST 9419 · 빈 칸은 먼저 알린다', () => {
    const d = T.brRegisterDraft({ name: ' HM_SDBX ' });
    expect(d).toMatchObject({ name: 'HM_SDBX', host: 'HM_SDBX', port: '9419', username: '', password: '' });
    expect(T.brRegisterIssue(d)).toMatch(/계정/);
    expect(T.brRegisterIssue({ ...d, username: 'u', password: 'p', vcenterIds: [] })).toMatch(/vCenter/);
    expect(T.brRegisterIssue({ ...d, username: 'u', password: 'p', vcenterIds: ['kr:vc1'] })).toBe('');
  });
  it('서버 수 경고 — 개요보다 적은 EM 만 · 모르면 말하지 않는다', () => {
    const w = T.serverCountWarnings([{ emName: 'HQ', overview: 22, merged: 5, viaQuery: true }, { emName: 'B', overview: 3, merged: 3 }, { emName: 'C', overview: null, merged: 1 }]);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/개요는 백업 서버 22대인데 목록은 5대만.*추정/);
  });
  it('화면 — 기존 등록 API 그대로 · 두 요청 모두 r?.ok === false 확인 · 비밀번호 칸 · 백틱 없음', () => {
    const m = fs.readFileSync(new URL('../VeeamEmMapping.jsx', import.meta.url), 'utf8');
    expect(m).toMatch(/sendJson\('\/admin\/veeam\/servers', 'POST'/);
    expect(m).toMatch(/if \(a\?\.ok === false\)/);
    expect(m).toMatch(/if \(b\?\.ok === false\)/);
    expect(m).toMatch(/type === 'password' \? 'new-password'/);
    expect(m).not.toMatch(/textTransform|text-transform/);
  });
});
