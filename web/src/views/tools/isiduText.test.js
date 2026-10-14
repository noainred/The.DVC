/**
 * isiduText.js — 아이실론 디렉터리 사용량 화면 문구·좌표(v2.736).
 * 서버 FAIL_KINDS 와 화면 FAIL_TEXT 가 1:1 인지는 서버 소스를 읽어 대조한다(한쪽만 늘면 화면이 코드를 그대로 보인다).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FAIL_TEXT, bytesText, signedBytes, deltaView, shareText, everyText, durationText, normPath, pathHint, commandText,
  sparkPath, trendModel, trendNotes, cadenceOf, baseNote, scanNotes, kpiCards, targetStatus, keyStatus, keyRows,
  runResultText, usersFootNote, blankTarget, formFromTarget, targetBody, tailPath,
  EDGE_CALL_TEXT, nudgeLines, testResultText, runSelectValue, runSelectPatch, formRunNode, deviceAuthIssue, RUN_FOLLOW, TIMEOUT_CHOICES,
} from './isiduText.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(here, '../../../../server/src');
const HOUR = 3_600_000; const DAY = 24 * HOUR; const GIB = 1024 ** 3; const TIB = 1024 ** 4;

describe('서버 계약 대조', () => {
  it('FAIL_TEXT 키 = 서버 collect.js FAIL_KINDS', () => {
    const src = fs.readFileSync(path.join(SERVER, 'isidu/collect.js'), 'utf8');
    const m = /FAIL_KINDS\s*=\s*Object\.freeze\(\[([^\]]+)\]\)/.exec(src);
    expect(m).toBeTruthy();
    const kinds = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
    expect(Object.keys(FAIL_TEXT).sort()).toEqual(kinds);
  });
  it('pathHint 는 서버 pathIssue 와 같은 입력에 같은 판정(문구 포함)', async () => {
    const { pathIssue } = await import('../../../../server/src/isidu/settings.js');
    for (const p of ['', '/ifs', '/ifs/data/workspace/users/', '/ifs//data', '/data/x', "/ifs/a'b", '/ifs/a/../b', '/ifs/$x', '/ifs/a\\b', 'x'.repeat(1100), '/ifs/a\u0001b']) {
      expect(pathHint(p)).toBe(pathIssue(p));
    }
  });
  it('normPath 는 서버 normPath 와 같다', async () => {
    const { normPath: srv } = await import('../../../../server/src/isidu/parse.js');
    for (const p of ['/ifs//a///b/', '/', '/ifs', '//ifs/', 'a//b']) expect(normPath(p)).toBe(srv(p));
  });
  it('명령 미리보기는 서버 duCommand 를 그대로 담는다', async () => {
    const { duCommand } = await import('../../../../server/src/isidu/parse.js');
    expect(commandText({ username: 'admin', host: '10.0.0.1', path: '/ifs/data/workspace/users/', sizeMode: 'h' })).toContain(duCommand('/ifs/data/workspace/users/', 'h'));
    expect(commandText({ username: 'admin', host: '10.0.0.1', path: '/ifs/x', sizeMode: 'k' })).toContain(duCommand('/ifs/x', 'k'));
    expect(commandText({ username: 'a', host: 'h', port: 2222, path: '/ifs/x' })).toMatch(/^ssh -p 2222 a@h /);
  });
});

describe('크기·증감 문구', () => {
  it('1024 단위 · 못 읽은 값은 — (단위 없음)', () => {
    expect(bytesText(73 * GIB)).toBe('73.0 GB');
    expect(bytesText(4.6 * TIB)).toBe('4.6 TB');
    expect(bytesText(980 * GIB)).toBe('980 GB');
    expect(bytesText(16 * 1024)).toBe('16.0 KB');
    expect(bytesText(null)).toBe('—');
    expect(bytesText('')).toBe('—');
    expect(bytesText(undefined)).toBe('—');
    expect(signedBytes(-120 * GIB)).toBe('−120 GB');
    expect(signedBytes(0)).toBe('0');
    expect(signedBytes(null)).toBe('—');
  });
  it('증감 — 신규·사라짐·기준 없음·해상도 안·증감', () => {
    expect(deltaView(null, { isNew: true }).tone).toBe('new');
    expect(deltaView(null, { removed: true }).tone).toBe('gone');
    expect(deltaView(null, { hasBase: false })).toMatchObject({ text: '—', tone: 'none' });
    expect(deltaView(null, { hasBase: false }).title).toMatch(/이전 수집이 아직 없습니다/);
    const w = deltaView({ bytes: 40 * GIB, withinRes: true, uncertainty: 100 * GIB });
    expect(w).toMatchObject({ text: '변화 없음', tone: 'flat' });
    expect(w.title).toMatch(/표기 오차/);
    expect(deltaView({ bytes: TIB, withinRes: false })).toMatchObject({ text: '+1.0 TB', tone: 'up' });
    expect(deltaView({ bytes: -2 * GIB, withinRes: false })).toMatchObject({ text: '−2.0 GB', tone: 'down' });
    // 기준에 없던 폴더(신규)를 0 에서 시작한 증가로 세지 않는다 — isNew 가 먼저다
    expect(deltaView({ bytes: 5 * GIB, withinRes: false }, { isNew: true }).text).toBe('신규');
  });
  it('비중·주기·소요', () => {
    expect(shareText(0.094)).toBe('9.4%');
    expect(shareText(0.0004)).toBe('<0.1%');
    expect(shareText(0.416)).toBe('42%');
    expect(shareText(null)).toBe('—');
    expect(everyText(24)).toBe('하루마다');
    expect(everyText(48)).toBe('2일마다');
    expect(everyText(6)).toBe('6시간마다');
    expect(everyText('')).toBe('—');
    expect(durationText(252_000)).toBe('4분 12초');
    expect(durationText(null)).toBe('—');
    expect(tailPath('/ifs/data/workspace/users/', 'aaa')).toBe('…/users/aaa');
  });
});

describe('스파크라인·추이', () => {
  it('null 은 선을 끊고, 홀로 있는 값은 점이다', () => {
    const s = sparkPath([null, 5, 6, null, 7, null]);
    expect(s.d.split('M').filter(Boolean).length).toBe(1);
    expect(s.dots.length).toBe(1);
    expect(sparkPath([null, null]).d).toBe('');
    expect(sparkPath([]).d).toBe('');
  });
  it('변화가 2% 미만이면 축을 넓힌다(잔물결을 급경사로 보이지 않게)', () => {
    const s = sparkPath([1000 * GIB, 1001 * GIB]);
    const ys = [...s.d.matchAll(/ ([\d.]+)/g)].map((m) => Number(m[1]));
    expect(Math.abs(ys[0] - ys[1])).toBeLessThan(12);
  });
  it('추이 — 수집 간격의 2.5배(최소 6시간)를 넘는 공백은 선을 끊는다 · 부분 합은 선에 넣지 않는다', () => {
    const t0 = Date.UTC(2026, 8, 1, 3);
    const pts = [0, 1, 2, 3, 10, 11, 12].map((d) => ({ ts: t0 + d * DAY, bytes: (40 + d) * TIB }));
    pts.push({ ts: t0 + 13 * DAY, bytes: 10 * TIB, partial: true });
    const m = trendModel(pts, {}, { now: t0 + 13 * DAY, days: 30 });
    expect(m.hasData).toBe(true);
    expect(m.breaks).toBe(1);
    expect(m.lines.length).toBe(2);
    expect(m.hollow.length).toBe(1);
    expect(m.last.bytes).toBe(52 * TIB);
    expect(cadenceOf(pts.map((p) => p.ts))).toBe(DAY);
    expect(trendModel([], {}).hasData).toBe(false);
  });
  it('추이 해설 — 해상도는 서버 res 를 쓴다 · -k 면 말하지 않는다 · 실패·부분 합 개수', () => {
    const tr = { points: [{ ts: 1, bytes: 4.6 * TIB, res: 0.1 * TIB }, { ts: 2, bytes: 4.7 * TIB, res: 0.1 * TIB, partial: true }], failures: [{ ts: 3, kind: 'timeout' }] };
    const n = trendNotes(tr, { sizeMode: 'h' });
    expect(n[0]).toMatch(/102 GB 보다 작은 변화/);
    expect(n.join(' ')).toMatch(/속이 빈 점 1개/);
    expect(n.join(' ')).toMatch(/실패한 수집 1회/);
    expect(trendNotes(tr, { sizeMode: 'k' }).join(' ')).not.toMatch(/반올림/);
  });
});

describe('보고서 해설·KPI', () => {
  const now = Date.UTC(2026, 9, 14, 3);
  const rep = {
    state: 'ok',
    scan: { ts: now - 12 * 60_000, durationMs: 252_000, node: '', path: '/ifs/data/workspace/users', sizeMode: 'h', errLines: 2, errSample: ['du: /ifs/x: Permission denied'], skipped: 0, truncated: false },
    base7: { scanId: 1, ts: now - 7 * DAY, spanDays: 7, errLines: 0 },
    base30: null,
    kpi: { denomBytes: 48.7 * TIB, totalDelta7: { bytes: 1.2 * TIB, withinRes: false }, users: 1284, new7: 6, removed7: 2, topN: 10, topBytes: 20.3 * TIB, topShare: 0.416 },
    lastFailure: { ts: now - HOUR, kind: 'timeout', node: '' }, failStreak: 2,
  };
  it('KPI 4칸', () => {
    const k = kpiCards(rep, { intervalHours: 24 }, now);
    expect(k.map((x) => x.key)).toEqual(['total', 'users', 'top', 'last']);
    expect(k[0].value).toBe('48.7 TB');
    expect(k[0].sub).toMatch(/\+1\.2 TB/);
    expect(k[1].sub).toMatch(/신규 6 · 사라짐 2/);
    expect(k[2].value).toBe('42%');
    expect(k[3].sub).toMatch(/하루마다 · 메인/);
    expect(kpiCards({ state: 'no-data' })).toEqual([]);
  });
  it('기준 없음이면 KPI 가 신규·사라짐을 지어내지 않는다', () => {
    const k = kpiCards({ ...rep, base7: null, kpi: { ...rep.kpi, new7: null, removed7: null, totalDelta7: null } }, { intervalHours: 24 }, now);
    expect(k[1].sub).toMatch(/7일 전 수집 없음/);
    expect(k[0].sub).toMatch(/7일 —/);
  });
  it('해설 — 권한 오류·마지막 실패·기준 간격', () => {
    const n = scanNotes(rep, now);
    expect(n.some((x) => /권한 오류 \*\*2줄\*\*/.test(x.text))).toBe(true);
    expect(n.some((x) => x.tone === 'red' && /시한 초과 · 연속 2회/.test(x.text))).toBe(true);
    expect(baseNote(rep)).toBeNull();
    expect(baseNote({ ...rep, base7: { ...rep.base7, spanDays: 9.5 } })).toMatch(/9\.5일/);
    expect(baseNote({ ...rep, base7: null })).toMatch(/판정하지 않았습니다/);
  });
});

describe('수집 상태 — 판정 순서', () => {
  const now = Date.UTC(2026, 9, 14, 3);
  const base = { id: 't', intervalHours: 24, timeoutMin: 30, enabled: true, okScan: { id: 2, ts: now - HOUR, errLines: 0 }, lastTry: { id: 2, ts: now - HOUR, ok: true } };
  it('장비 문제 → 꺼짐 → 진행 중 → 요청 → 인증 정지 → 실패 → 기록 없음 → 늦음 → 정상', () => {
    expect(targetStatus({ ...base, issue: 'device-missing', running: { since: now } }, now).key).toBe('issue');
    expect(targetStatus({ ...base, enabled: false, running: { since: now } }, now).key).toBe('off');
    expect(targetStatus({ ...base, running: { since: now - 4 * 60_000 } }, now)).toMatchObject({ key: 'running', tone: 'run' });
    expect(targetStatus({ ...base, request: { state: 'pending' } }, now).key).toBe('requested');
    expect(targetStatus({ ...base, authStopped: { since: now } }, now).key).toBe('auth-stopped');
    expect(targetStatus({ ...base, lastTry: { id: 3, ts: now, ok: false, kind: 'hostkey' } }, now)).toMatchObject({ key: 'failed', text: '호스트키 미확인', tone: 'bad' });
    expect(targetStatus({ ...base, okScan: null, lastTry: null }, now).key).toBe('never');
    expect(targetStatus({ ...base, okScan: { id: 2, ts: now - 3 * DAY } }, now)).toMatchObject({ key: 'stale', tone: 'warn' });
    expect(targetStatus(base, now)).toMatchObject({ key: 'ok', tone: 'ok' });
    // 실패가 성공보다 먼저면 정상
    expect(targetStatus({ ...base, lastTry: { id: 1, ts: now - 2 * HOUR, ok: false, kind: 'timeout' } }, now).key).toBe('ok');
  });
});

describe('키 목록', () => {
  it('메인 + 키 인증 대상을 맡은 엣지 · 엣지 보고가 없으면 key=null(키가 없다고 단정하지 않는다)', () => {
    const rows = keyRows([
      { id: 'a', auth: 'key', agent: '' }, { id: 'b', auth: 'key', agent: 'Edge-Seoul', label: 'B' },
      { id: 'c', auth: 'device', agent: 'Edge-PL' }, { id: 'd', auth: 'key', agent: 'edge-seoul' },
    ], { present: true, usable: true }, [{ agent: 'edge-seoul', at: 5, key: { usable: true, publicKey: 'ecdsa-sha2-nistp256 AAA' } }]);
    expect(rows.map((r) => r.node)).toEqual(['메인', '엣지 Edge-Seoul']);
    expect(rows[1].targets).toEqual(['B', 'd']);
    expect(rows[1].key.usable).toBe(true);
    expect(keyStatus(null).text).toBe('보고 없음');
    expect(keyStatus({ present: false }).text).toBe('키 없음');
    expect(keyStatus({ present: true, usable: true }).text).toBe('키 있음');
  });
});

describe('지금 수집 · 표 문구', () => {
  it('요청 결과를 나눠 말한다', () => {
    const t = runResultText({ started: ['a'], requested: [{ id: 'b' }], duplicate: [], busy: ['c'], issues: [], notFound: [] });
    expect(t).toMatch(/메인에서 1개 시작 · 엣지에 1개 요청/);
    expect(t).toMatch(/이미 조사 중 1개/);
    expect(runResultText({ started: [], requested: [] })).toMatch(/없습니다/);
  });
  it('표 아래 범위', () => {
    expect(usersFootNote({ state: 'ok', total: 1284, offset: 0 }, 200)).toMatch(/1,284개 중 1–200 · 나머지 1,084개/);
    expect(usersFootNote({ state: 'ok', total: 0, offset: 0 }, 0)).toMatch(/없습니다/);
  });
});

describe('설정 폼', () => {
  it('숫자 빈 칸은 보내지 않는다(빈 칸 = 0 금지)', () => {
    const b = targetBody({ ...blankTarget(), host: '10.0.0.5', username: 'admin', intervalHours: '', timeoutMin: '', topN: '', port: '' });
    expect('intervalHours' in b).toBe(false);
    expect('timeoutMin' in b).toBe(false);
    expect('port' in b).toBe(false);
    expect(b).toMatchObject({ host: '10.0.0.5', username: 'admin', auth: 'key', sizeMode: 'h', agent: '', datacenterId: '' });
  });
  it('등록부 장비를 고르면 주소·엣지·DataCenter 를 싣지 않는다(등록부가 정한다)', () => {
    const b = targetBody({ ...blankTarget(), deviceId: 'dev1', host: 'evil', agent: 'x', datacenterId: 'y', username: '', intervalHours: '12' });
    expect(b.deviceId).toBe('dev1');
    expect('host' in b || 'agent' in b || 'datacenterId' in b || 'username' in b).toBe(false);
    expect(b.intervalHours).toBe(12);
  });
  it('서버 값 → 폼 → 본문 왕복', () => {
    const t = { id: 't1', label: 'HQ', deviceId: 'd', port: 22, username: 'admin', auth: 'device', path: '/ifs/u', sizeMode: 'k', intervalHours: 24, timeoutMin: 30, topN: 10, enabled: false };
    const b = targetBody(formFromTarget(t));
    expect(b).toMatchObject({ id: 't1', label: 'HQ', deviceId: 'd', port: 22, username: 'admin', auth: 'device', path: '/ifs/u', sizeMode: 'k', intervalHours: 24, timeoutMin: 30, topN: 10, enabled: false });
  });
});

describe('v2.736 엣지 원격 실행·실행 노드', () => {
  it('EDGE_CALL_TEXT 키 = 서버 EDGE_PULL_KINDS + isiduRemote 의 edge-pull·demo-edge', () => {
    const src = fs.readFileSync(path.join(SERVER, 'central/edgePull.js'), 'utf8');
    const m = /EDGE_PULL_KINDS\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/.exec(src);
    expect(m).toBeTruthy();
    const kinds = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    const remote = fs.readFileSync(path.join(SERVER, 'central/isiduRemote.js'), 'utf8');
    const extra = [...new Set([...remote.matchAll(/'((?:edge-pull|demo-edge))'/g)].map((x) => x[1]))];
    expect(extra.sort()).toEqual(['demo-edge', 'edge-pull']);
    expect(Object.keys(EDGE_CALL_TEXT).sort()).toEqual([...kinds, ...extra].sort());
  });
  it('지금 수집 — 엣지별로 바로 전달했는지, 못 했으면 왜와 다음 pull 에 가져간다는 사실을 말한다', () => {
    const r = { ok: true, started: [], requested: [{ id: 'a', agent: 'e1' }, { id: 'b', agent: 'e2' }], nudged: [{ agent: 'e1', ok: true, started: 1 }, { agent: 'e2', ok: false, kind: 'old-version' }] };
    expect(runResultText(r)).toMatch(/바로 전달 1\/2곳/);
    const lines = nudgeLines(r);
    expect(lines[0]).toMatchObject({ agent: 'e1', ok: true });
    expect(lines[0].text).toMatch(/조사 1개 시작/);
    expect(lines[1].ok).toBe(false);
    expect(lines[1].text).toContain(EDGE_CALL_TEXT['old-version']);
    expect(lines[1].text).toMatch(/다음 설정 pull/);
    expect(nudgeLines({})).toEqual([]);
  });
  it('연결 시험 결과 — 어느 노드에서 시험했는지 · 엣지에 못 보냈으면 그 사유', () => {
    expect(testResultText({ ok: true, out: '/ifs/x', ms: 12, via: 'edge', node: 'e1' }).text).toMatch(/엣지 ‘e1’ 에서/);
    expect(testResultText({ ok: true, out: '/ifs/x', ms: 12, via: 'main' }).text).toMatch(/메인에서/);
    const nr = testResultText({ ok: false, via: 'edge', node: 'e1', kind: 'not-registered' });
    expect(nr.tone).toBe('bad');
    expect(nr.text).toContain(EDGE_CALL_TEXT['not-registered']);
    const auth = testResultText({ ok: false, via: 'edge', node: 'e1', reason: 'All configured authentication methods failed', failKind: 'auth' });
    expect(auth.text).toMatch(/엣지 ‘e1’ 에서 실패/);
    expect(auth.text).toMatch(/authorized_keys/);
  });
  it('실행 노드 Select ↔ 폼 · 등록부 계정은 다른 엣지에서 쓸 수 없다(서버와 같은 판정)', async () => {
    const f = { ...blankTarget(), deviceId: 'd1' };
    expect(runSelectValue(f)).toBe(RUN_FOLLOW);
    expect(formRunNode(f, { agent: 'e1' })).toBe('e1');
    const f2 = { ...f, ...runSelectPatch('e2') };
    expect(f2).toMatchObject({ runVia: 'node', agent: 'e2' });
    expect(formRunNode(f2, { agent: 'e1' })).toBe('e2');
    expect(targetBody(f2)).toMatchObject({ runVia: 'node', agent: 'e2' });
    const f3 = { ...f2, ...runSelectPatch(RUN_FOLLOW) };
    expect(targetBody(f3).runVia).toBe('device');
    expect('agent' in targetBody(f3)).toBe(false);
    expect(deviceAuthIssue({ ...f2, auth: 'device' }, { agent: 'e1' })).toMatch(/e2/);
    expect(deviceAuthIssue({ ...f2, auth: 'device', agent: '' }, { agent: 'e1' })).toBe(null);
    expect(deviceAuthIssue({ ...f2, auth: 'device', agent: 'E1' }, { agent: 'e1' })).toBe(null);
    const { normalizeTarget } = await import('../../../../server/src/isidu/settings.js');
    const { pickAgent, pickDatacenter } = await import('../../../../server/src/cvp/formChoices.js');
    const ctx = { devices: [{ id: 'd1', type: 'isilon', host: '10.0.0.5', agent: 'e1' }], agents: ['e1', 'e2'], dcs: [], pickAgent, pickDatacenter, ssrfBlockReason: () => null };
    for (const [agent, auth] of [['e2', 'device'], ['', 'device'], ['E1', 'device'], ['e2', 'key']]) {
      const form = { ...blankTarget(), deviceId: 'd1', path: '/ifs/u', runVia: 'node', agent, auth };
      const srv = normalizeTarget(targetBody(form), null, ctx);
      expect(!!deviceAuthIssue(form, ctx.devices[0])).toBe(srv.field === 'auth');
    }
  });
  it('시한 선택지는 서버 상한(120분) 안', async () => {
    const { RANGES } = await import('../../../../server/src/isidu/settings.js');
    expect(Math.max(...TIMEOUT_CHOICES)).toBe(RANGES.timeoutMin.max);
    expect(formFromTarget({ id: 't', deviceId: 'd', runVia: 'node', agent: 'e2' })).toMatchObject({ runVia: 'node', agent: 'e2' });
  });
});
