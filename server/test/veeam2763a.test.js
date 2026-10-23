/**
 * test/veeam2763a.test.js — v2.763 Veeam 3회차 점검 확정분(수정 그룹 A — 등록·관리 화면/라우트) 회귀.
 *
 *  · V1-1 대량 가져오기 — 행에 **없는 열**은 기존 값 유지(agent·enabled·apiVersion·note·name·username) · 명시적으로 비운 칸은 지금처럼.
 *  · V1-2 자유텍스트 splitCells — 따옴표 밖 구분자만(내보내기 → 그대로 가져오기 왕복) · 닫히지 않은 따옴표는 예전처럼.
 *  · V1-3 CSV 비밀번호 칸은 수식 방지 접두(')를 벗기지 않는다 · 자유텍스트 비밀번호 원문에 따옴표·앞뒤 공백이면 드라이런 경고(값은 그대로).
 *  · V1-4 host:port 를 바꾼 수정도 중복 검사(이미 중복인 쌍의 다른 필드 수정은 막지 않음).
 *  · V2-1=V5-3 엣지 노드에서 중앙 배정(pulled) 서버의 수정·삭제는 409(대량 가져오기도 오류 행) · 엣지 로컬 등록·연결 시험은 그대로.
 *  · V5-4 관리 표의 '지금' 값(백업 중·대기·작업 실행 중)은 실패·오래됨이면 모름 + stale/runningStale.
 *  · V5-5 비관리자 판본 notes 에 서버 전체 기준 수가 없다(badges·vm-detail·backup-counts 스윕).
 *  · V5-I2 연결 시험 성공(저장 자격증명 로그인)은 인증 실패 정지를 푼다(gpuGuest v2.590 F2 선례) · 실패는 풀지 않는다.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'veeam2763a-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
delete process.env.CENTRAL_URL;
const VC_KR = 'kr:vc01';
const VC_PL = 'pl:vc02';
fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({ vcenters: [VC_KR, VC_PL].map((id) => ({ id, name: id, host: `${id.split(':')[1]}.corp.local`, username: 'u', password: 'p' })) }));
const closers = [];

// Veeam(https://vbr…) 요청만 가짜로 받는다 — 연결 시험 라우트는 전역 fetch 를 쓴다(테스트 서버 요청은 진짜 fetch 로).
const realFetch = globalThis.fetch;
let vbrHandler = null;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith('https://vbr')) {
    if (!vbrHandler) throw new TypeError('fetch failed');
    return vbrHandler(url, init || {});
  }
  return realFetch(url, init);
};
after(async () => {
  globalThis.fetch = realFetch;
  for (const c of closers.reverse()) { try { await c(); } catch { /* */ } }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ }
});

const R = await import('../src/veeam/registry.js');
const VB = await import('../src/veeam/bulk.js');
const BT = await import('../src/util/bulkText.js');
const ST = await import('../src/veeam/store.js');
const poller = await import('../src/veeam/poller.js');
const { config } = await import('../src/config.js');
const { store } = await import('../src/store.js');
const KEEP_AGENT = { ...config.agent };
const resetAgent = () => { Object.assign(config.agent, KEEP_AGENT); config.agent.centralUrl = ''; config.agent.centralToken = ''; config.agent.name = ''; };
const clearRegistry = () => { for (const d of R.listServers()) R.deleteServer(d.id); };

const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const prevSnap = store.snapshot;
after(() => { store.snapshot = prevSnap; });
let gen = NOW;
const setSnap = () => { gen += 1; store.snapshot = { source: 'live', generatedAt: gen, vcenters: [VC_KR, VC_PL].map((id) => ({ id, name: id })), vms: [VC_KR, VC_PL].map((id) => ({ id: `${id}:vm-1`, vcenterId: id, name: 'web01' })), hosts: [] }; };
setSnap();

/* ═══════════════ 실제 라우터(관리 화면 · 사용자 배지) ═══════════════ */
let adminBase = ''; let apiBase = '';
let apiUser = { username: 'a', role: 'admin' };
before(async () => {
  const express = (await import('express')).default;
  const { registerVeeam } = await import('../src/routes/admin/veeam.js');
  const { registerVeeamBadges } = await import('../src/routes/api/veeam.js');
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  const admin = express.Router();
  app.use('/api/admin', (req, _res, next) => { req.user = { username: 'adm', role: 'admin' }; next(); }, admin);
  registerVeeam(admin);
  const api = express.Router(); registerVeeamBadges(api);
  app.use('/api', (req, _res, next) => { req.user = apiUser; next(); }, api);
  const srv = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
  closers.push(() => new Promise((ok) => { srv.closeAllConnections?.(); srv.close(() => ok()); }));
  adminBase = `http://127.0.0.1:${srv.address().port}/api/admin/veeam/servers`;
  apiBase = `http://127.0.0.1:${srv.address().port}/api`;
});
const call = async (method, p = '', body) => {
  const res = await realFetch(`${adminBase}${p}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: await res.json() };
};
const apiGet = async (p) => { const res = await realFetch(`${apiBase}${p}`); return { status: res.status, body: await res.json() }; };

/* 기존 서버: 엣지 pl-edge 가 읽고, 수집을 꺼 두고(잠금 조사 중), API 판 1.2-rev0 */
const seedOld = () => R.saveServer({ name: 'Old', host: 'vbr01.corp', username: 'svc', password: 'KEEP-PW', vcenterIds: [VC_PL], agent: 'pl-edge', enabled: false, apiVersion: '1.2-rev0', note: '계정 잠금 조사 중' });
const pick = (d) => ({ name: d.name, username: d.username, agent: d.agent, enabled: d.enabled, apiVersion: d.apiVersion, note: d.note, vcenterIds: d.vcenterIds });

/* ═══════════════ V1-1 ═══════════════ */
test('V1-1: 헤더형 CSV·키=값형·헤더형 텍스트에서 없는 열은 기존 값 유지 — 드라이런·저장이 같다 · 비밀번호 유지', async () => {
  resetAgent(); clearRegistry(); setSnap();
  const old = seedOld();
  const before = pick(R.getServerWithSecret(old.id));
  const cases = [
    ['csv', { csv: 'host,name,username,vcenters\nvbr01.corp,New CSV,svc,pl:vc02\n' }, { name: 'New CSV' }],
    ['text 키=값', { text: 'host=vbr01.corp name="New KV"', format: 'text' }, { name: 'New KV' }],
    ['text 헤더형(name 없음)', { text: 'host  note\nvbr01.corp  새메모', format: 'text' }, { note: '새메모' }],
  ];
  for (const [label, body, changed] of cases) {
    const dry = await call('POST', '/import', { ...body, dryRun: true });
    assert.equal(dry.status, 200, JSON.stringify(dry.body));
    assert.deepEqual(dry.body.report.map((x) => [x.action, x.reason]), [['update', null]], `${label}: 드라이런은 오류 없는 update`);
    const done = await call('POST', '/import', { ...body, selectLines: dry.body.report.map((x) => x.line) });
    assert.equal(done.body.updated, 1, `${label}: ${JSON.stringify(done.body)}`);
    const now = pick(R.getServerWithSecret(old.id));
    for (const k of Object.keys(before)) if (!(k in changed)) assert.deepEqual(now[k], before[k], `${label}: 없는 열 '${k}' 은 기존 값`);
    for (const [k, v] of Object.entries(changed)) assert.equal(now[k], v, `${label}: 적은 열 '${k}'`);
    assert.equal(R.getServerWithSecret(old.id).password, 'KEEP-PW', `${label}: 비밀번호 유지`);
    Object.assign(before, changed);
  }
});

test('V1-1: 명시적으로 비운 칸은 지금처럼(agent 빈 칸 = 중앙 · enabled 빈 칸 = 켜짐 · note 비움) · 신규 행은 열이 없어도 기본값', () => {
  resetAgent(); clearRegistry(); setSnap();
  seedOld();
  const ctx = { existing: (k) => R.listServers().find((d) => VB.keyOfHostPort(d.host, d.port) === k), vcenters: [{ id: VC_PL, name: VC_PL }], agents: ['pl-edge'] };
  const csv = VB.parseServersCsv('host,name,username,vcenters,agent,enabled,note,apiVersion\nvbr01.corp,Old,svc,,,,,\n');
  const inp = VB.toSaveInput(csv.rows[0], ctx);
  assert.deepEqual([inp.agent, inp.enabled, inp.note, inp.apiVersion], ['', true, '', ''], 'CSV 빈 칸은 비움');
  assert.deepEqual(inp.vcenterIds, [VC_PL], 'vcenters 빈 칸은 예전부터 기존 유지');
  const txt = VB.parseServersText('name host port username vcenters agent apiVersion enabled note\nOld vbr01.corp - svc - - - - -');
  const t = VB.toSaveInput(txt.rows[0], ctx);
  assert.deepEqual([t.agent, t.enabled, t.note], ['', true, ''], "텍스트 '-' 는 비움");
  const fresh = VB.toSaveInput(VB.parseServersText('host=vbr-new.corp name=N username=svc vcenters=kr:vc01 pw=Pw-1').rows[0], ctx);
  assert.deepEqual([fresh.agent, fresh.enabled, fresh.apiVersion], ['', true, ''], '신규는 열이 없으면 기본값(비교할 기존 값이 없다)');
  const kv = VB.parseServersText('host=vbr01.corp 엣지=중앙').rows[0];
  const k = VB.toSaveInput(kv, ctx);
  assert.deepEqual([k.agent, k.enabled, k.apiVersion, k.name], ['', false, '1.2-rev0', 'Old'], "적은 열(엣지=중앙)만 바꾸고 나머지는 유지");
});

/* ═══════════════ V1-2 ═══════════════ */
test('V1-2: 따옴표 밖 구분자만 — 쉼표·| 가 든 메모를 내보낸 자유텍스트를 그대로 가져온다 · 공용 파서 회귀', () => {
  resetAgent(); clearRegistry(); setSnap();
  const d = R.saveServer({ name: 'AZ Veeam', host: 'vbr-az.corp', username: 'svc', password: 'pw', vcenterIds: [VC_KR], note: 'Phoenix DC, rack 12 | row 3' });
  const text = VB.serversToText(R.listServers());
  const p = VB.parseServersText(text);
  assert.equal(p.error, undefined, String(p.error));
  const ctx = { existing: (k) => R.listServers().find((x) => VB.keyOfHostPort(x.host, x.port) === k), vcenters: [{ id: VC_KR, name: VC_KR }], agents: [] };
  const inp = VB.toSaveInput(p.rows[0], ctx);
  assert.equal(VB.inputIssue(inp, { isNew: !inp.id }), null);
  assert.deepEqual([inp.id, inp.name, inp.note], [d.id, 'AZ Veeam', 'Phoenix DC, rack 12 | row 3'], '왕복 보존');
  // 공용 splitCells — 따옴표 안 쉼표는 구분자가 아니다 · 명시적 구분자에서도 따옴표 칸을 지킨다 · 닫히지 않은 따옴표는 예전처럼 자른다
  assert.deepEqual(BT.splitCells('"WA Isilon, 01"  10.0.0.1  root'), { cells: ['WA Isilon, 01', '10.0.0.1', 'root'], explicit: false });
  assert.deepEqual(BT.splitCells('a, "b, c", d').cells, ['a', '"b, c"', 'd']);
  assert.deepEqual(BT.splitCells('a,"b,c').cells, ['a', '"b', 'c']);
  assert.deepEqual(BT.splitCells('a,Pa"ss,c').cells, ['a', 'Pa"ss', 'c'], '낱말 가운데 따옴표는 글자');
  assert.deepEqual(BT.splitCells('x\t"y"\tz').cells, ['x', '"y"', 'z'], '탭 구분은 예전 그대로');
  const fr = BT.parseFreeRows('"WA Isilon, 01" 10.0.0.1 isilon', { fields: ['name', 'host', 'type'] });
  assert.deepEqual([fr.rows[0].name, fr.rows[0].host, fr.rows[0].type].map(BT.unmark), ['WA Isilon, 01', '10.0.0.1', 'isilon']);
});

/* ═══════════════ V1-3 ═══════════════ */
test('V1-3: CSV 비밀번호 칸은 접두(\')를 벗기지 않는다(다른 칸은 벗긴다) · 자유텍스트 따옴표·앞뒤 공백은 드라이런 경고, 값은 그대로', async () => {
  resetAgent(); clearRegistry(); setSnap();
  const csv = VB.parseServersCsv("host,name,username,vcenters,password\nvbr-c.corp,'=CsvName,svc,kr:vc01,'-Secret1\n");
  assert.equal(csv.rows[0].password, "'-Secret1", 'CSV 비밀번호는 원문 그대로');
  assert.equal(csv.rows[0].name, '=CsvName', '다른 칸은 수식 방지 접두를 벗긴다(예전 그대로)');
  const lines = [
    'name host port username vcenters agent apiVersion enabled note password',
    'P1 vbr-p1.corp - svc kr:vc01 - - - - Pa"ss"w0rd',
    'host=vbr-p2.corp name=P2 username=svc vcenters=kr:vc01 비밀번호=Qx9   ',
    'host=vbr-p3.corp name=P3 username=svc vcenters=kr:vc01 pw=Clean-1',
    'P4, vbr-p4.corp, , svc, kr:vc01, , , , , Clean-2',
    'host=vbr-p5.corp 비밀번호=Mid-1   name=P5 username=svc vcenters=kr:vc01',
  ];
  const p = VB.parseServersText(lines.join('\n'));
  const pw = Object.fromEntries(p.rows.map((r) => [r.name, r.password]));
  assert.deepEqual(pw, { P1: 'Passw0rd', P2: 'Qx9', P3: 'Clean-1', P4: 'Clean-2', P5: 'Mid-1' }, '값은 지금 규칙대로(경고만 더한다)');
  const warned = p.warnings.filter((w) => w.includes('비밀번호 칸'));
  assert.deepEqual(warned.map((w) => Number(w.split('줄')[0])), [2, 3, 6], `경고 줄: ${JSON.stringify(p.warnings)}`);
  assert.match(warned[0], /따옴표\(\\?"\)가/); assert.match(warned[1], /앞뒤 공백이/);
  assert.ok(warned.every((w) => !w.includes('`')), '백틱 없음(BoldText)');
  assert.ok(!p.warnings.join('\n').includes('Pa"ss') && !p.warnings.join('\n').includes('Qx9'), '경고에 비밀번호 값을 싣지 않는다');
  const dry = await call('POST', '/import', { text: lines.join('\n'), format: 'text', dryRun: true });
  assert.equal(dry.body.warnings.filter((w) => w.includes('비밀번호 칸')).length, 3, '드라이런 응답에 경고');
  assert.equal(VB.passwordMangleWarning(9, ''), null); assert.equal(VB.passwordMangleWarning(9, 'plain'), null);
});

/* ═══════════════ V1-4 ═══════════════ */
test('V1-4: 수정으로 다른 서버의 host:port 를 받으면 거부 · host:port 그대로인 수정은 이미 중복인 쌍이어도 통과', () => {
  resetAgent(); clearRegistry();
  const a = R.saveServer({ name: 'A', host: 'vbr01.corp', username: 'svc', password: 'pa', vcenterIds: [VC_KR] });
  const b = R.saveServer({ name: 'B', host: 'vbr02.corp', username: 'svc', password: 'pb', vcenterIds: [VC_KR] });
  assert.throws(() => R.saveServer({ id: b.id, name: 'B', host: 'VBR01.corp', username: 'svc', vcenterIds: [VC_KR] }), /이미 등록된 Veeam 서버/);
  assert.equal(R.getServerWithSecret(b.id).host, 'vbr02.corp', '거부되면 바뀌지 않는다');
  assert.throws(() => R.saveServer({ id: a.id, name: 'A', host: 'vbr02.corp', port: 9419, username: 'svc', vcenterIds: [VC_KR] }), /이미 등록된/, '포트까지 같게 적어도');
  R.saveServer({ id: a.id, name: 'A2', host: 'vbr01.corp', username: 'svc', vcenterIds: [VC_KR] });
  assert.equal(R.getServerWithSecret(a.id).name, 'A2', '자기 host:port 그대로 수정은 통과');
  // 옛 결함으로 이미 중복인 쌍 — 다른 필드(비밀번호·끄기) 수정은 막지 않는다
  const file = path.join(DIR, 'veeam-servers.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.servers.find((d) => d.id === b.id).host = 'vbr01.corp';
  fs.writeFileSync(file, JSON.stringify(raw)); R._resetForTest();
  R.saveServer({ id: b.id, name: 'B', host: 'vbr01.corp', username: 'svc', password: 'new-pb', vcenterIds: [VC_KR], enabled: false });
  assert.deepEqual([R.getServerWithSecret(b.id).password, R.getServerWithSecret(b.id).enabled], ['new-pb', false]);
  clearRegistry();
});

/* ═══════════════ V2-1 = V5-3 ═══════════════ */
test('V2-1: 엣지 노드 — 중앙 배정(pulled) 서버의 수정·삭제는 409(등록부 그대로) · 대량 가져오기도 오류 행 · 엣지 로컬 등록은 그대로 · 중앙에서는 잠그지 않는다', async () => {
  resetAgent(); clearRegistry(); setSnap();
  try {
    config.agent.centralUrl = 'http://127.0.0.1:9'; config.agent.name = 'pl-edge';
    R.applyPulledServers([{ id: 'vbr-c1', name: 'PL Veeam', host: 'vbr-pl.corp', port: 9419, username: 'svc', password: 'central-pw', agent: 'pl-edge', vcenterIds: [VC_PL] }]);
    const local = R.saveServer({ name: 'Local', host: 'vbr-local.corp', username: 'svc', password: 'lpw', vcenterIds: [VC_PL] });
    const g = await call('GET');
    const row = (id) => g.body.servers.find((x) => x.id === id);
    assert.equal(row('vbr-c1').centralManaged, true, '중앙 배정 표지');
    assert.equal(row(local.id).centralManaged, undefined, '엣지 로컬 등록은 표지 없음');
    assert.equal(row('vbr-c1').readsHere, true, '연결 시험·지금 읽기는 그대로 열린다(readsHere)');

    const ed = await call('POST', '', { id: 'vbr-c1', name: 'PL Veeam', host: 'vbr-b.corp', username: 'svc', password: 'edge-fixed-pw', vcenterIds: [VC_PL], agent: 'pl-edge' });
    assert.equal(ed.status, 409, JSON.stringify(ed.body));
    assert.equal(ed.body.centralManaged, true); assert.match(ed.body.reason, /중앙 포탈의 설정 › Veeam 백업 서버에서 고치세요/);
    assert.ok(!ed.body.reason.includes('`'));
    assert.deepEqual([R.getServerWithSecret('vbr-c1').host, R.getServerWithSecret('vbr-c1').password], ['vbr-pl.corp', 'central-pw'], '수정 거부 — 등록부 그대로');
    const del = await call('DELETE', '/vbr-c1');
    assert.equal(del.status, 409); assert.ok(R.getServerWithSecret('vbr-c1'), '삭제 거부 — 남아 있다');

    const imp = await call('POST', '/import', { text: 'host=vbr-pl.corp name="PL renamed" pw=edge-pw', format: 'text', dryRun: true });
    assert.equal(imp.body.report[0].action, 'error'); assert.match(imp.body.report[0].reason, /중앙 포탈이 배정한/);
    const imp2 = await call('POST', '/import', { text: 'host=vbr-pl.corp name="PL renamed" pw=edge-pw', format: 'text', selectLines: [1] });
    assert.equal(imp2.body.updated, 0); assert.equal(R.getServerWithSecret('vbr-c1').name, 'PL Veeam', '가져오기로도 바뀌지 않는다');

    const le = await call('POST', '', { id: local.id, name: 'Local2', host: 'vbr-local.corp', username: 'svc', vcenterIds: [VC_PL] });
    assert.equal(le.status, 201, JSON.stringify(le.body)); assert.equal(R.getServerWithSecret(local.id).name, 'Local2');
    const ld = await call('DELETE', `/${local.id}`);
    assert.equal(ld.status, 200); assert.equal(R.getServerWithSecret(local.id), null);

    vbrHandler = async () => json({ message: 'nope' }, 401);
    const t = await call('POST', '/vbr-c1/test');
    assert.equal(t.status, 200, '연결 시험은 409 가 아니다(엣지에서 인증 정지를 푸는 길)');
    assert.equal(t.body.centralManaged, undefined);
  } finally { vbrHandler = null; resetAgent(); }
  // 중앙 노드: pulled 표지가 있어도(이론상) 잠그지 않는다 — 판정은 '엣지 노드 + pulled'
  assert.equal(R.centralManagedReason({ pulled: true }), null);
  assert.match(R.centralManagedReason({ pulled: true }, { isEdge: true }), /중앙 포탈이 배정한/);
  assert.equal(R.centralManagedReason({ pulled: false }, { isEdge: true }), null);
  assert.equal(R.centralManagedReason(null, { isEdge: true }), null);
  clearRegistry();
});

/* ═══════════════ V5-4 ═══════════════ */
test('V5-4: 관리 표 — 실패 중·오래된 결과의 백업 중·대기·작업 실행 중은 모름 + stale/runningStale · 새 결과는 그대로', async () => {
  const { serverStatusView } = await import('../src/routes/admin/veeam.js');
  const now = NOW + 60_000;
  const okRes = (ts) => ({ ok: true, ts, counts: { jobs: 2, vmJobs: 10, running: 7, pending: 1 }, jobs: [{ name: 'KR-Job', running: true }, { name: 'PL-Job', running: true }], notes: [] });
  const fresh = serverStatusView({ at: now, via: 'local', result: okRes(now - 60_000) }, now);
  assert.deepEqual([fresh.counts.running, fresh.counts.pending, fresh.jobs.map((j) => j.running), fresh.stale, fresh.runningStale], [7, 1, [true, true], false, false]);
  const failed = serverStatusView({ at: now, via: 'local', result: { ok: false, ts: now, error: 'HTTP 401', kind: 'auth' }, lastOk: okRes(now - 72 * HOUR) }, now);
  assert.deepEqual([failed.counts.running, failed.counts.pending, failed.jobs.map((j) => j.running), failed.runningStale], [null, null, [false, false], true], '실패 중');
  assert.deepEqual([failed.counts.jobs, failed.counts.vmJobs, failed.jobs.length], [2, 10, 2], '작업 수·VM 수·작업 목록은 마지막 성공분(의도)');
  const old = serverStatusView({ at: now, via: 'edge', agent: 'pl-edge', result: okRes(now - 72 * HOUR) }, now);
  assert.deepEqual([old.ok, old.stale, old.runningStale, old.counts.running, old.jobs[0].running], [true, true, true, null, false], '오래된 엣지 결과');
  const noTs = serverStatusView({ at: now, via: 'local', result: { ...okRes(null) } }, now);
  assert.equal(noTs.stale, true, '시각 모르는 결과는 지금이 아니다');
  assert.equal(serverStatusView({ at: now, result: { ok: false, ts: now, error: 'x' } }, now).stale, false, '쓸 결과가 없으면 stale 아님(실패만)');
});

/* ═══════════════ V5-5 ═══════════════ */
test('V5-5: 비관리자 판본 notes 에 서버 전체 기준 수가 없다 — badges·vm-detail·backup-counts 스윕 · 관리자는 원문', async () => {
  resetAgent(); clearRegistry(); setSnap();
  const { maskCounts } = await import('../src/routes/api/veeam.js');
  const d = R.saveServer({ name: 'Shared', host: 'vbr-sh.corp', username: 'svc', password: 'pw', vcenterIds: [VC_KR, VC_PL] });
  const notes = ['에이전트 백업 40대는 vCenter 정보가 없어 컴퓨터 이름이 같은 VM 이 하나뿐일 때만 배지를 붙입니다',
    '작업이 폴더·클러스터·태그 같은 컨테이너 12개를 포함합니다 — 그 안의 VM 은 복원 지점이 생기거나 백업 중일 때만 표시됩니다',
    'VM 상한(5000)을 넘어 33건을 버렸습니다', '실행 중 세션 61개 중 50개만 VM 단위로 읽었습니다(나머지는 작업 단위)', '복원 지점이 9000개를 넘어 일부만 읽었습니다'];
  ST.putResult(d.id, { ok: true, ts: Date.now(), jobs: [], counts: { agentObjects: 40, containers: 12 }, notes, vms: [{ n: 'web01', m: 'vm-1', h: 'vc01.corp.local', j: [], rp: 1 }] });
  const COUNT = /\d[\d,]*\s*(개|대|건)/;
  try {
    apiUser = { username: 'v', role: 'viewer' };
    const bodies = {
      badges: (await apiGet(`/veeam/badges?vcenterId=${VC_KR}`)).body,
      'vm-detail': (await apiGet(`/veeam/vm-detail?vcenterId=${VC_KR}&vmId=${encodeURIComponent(`${VC_KR}:vm-1`)}`)).body,
      'backup-counts': (await apiGet('/veeam/backup-counts')).body,
    };
    for (const [name, body] of Object.entries(bodies)) {
      assert.equal(body.ok, true, `${name}: ${JSON.stringify(body).slice(0, 200)}`);
      const all = JSON.stringify(body);
      for (const n of (body.servers || []).flatMap((s) => s.notes || [])) assert.doesNotMatch(n, COUNT, `${name} notes 에 수: ${n}`);
      for (const leak of ['40대', '12개', '33건', '61개', '50개']) assert.ok(!all.includes(leak), `${name} 본문에 '${leak}'`);
    }
    assert.equal(bodies.badges.servers[0].notes.length, notes.length, '문구는 남는다(수만 지운다)');
    assert.match(bodies.badges.servers[0].notes[0], /^에이전트 백업 일부는/);
    apiUser = { username: 'a', role: 'admin' };
    setSnap();
    const ab = (await apiGet(`/veeam/badges?vcenterId=${VC_KR}`)).body;
    assert.deepEqual(ab.servers[0].notes, notes, '관리자는 원문');
  } finally { apiUser = { username: 'a', role: 'admin' }; clearRegistry(); ST._resetForTest(); }
  assert.equal(maskCounts('백업 3개는 파일 목록을 받지 못해'), '백업 일부는 파일 목록을 받지 못해');
  assert.equal(maskCounts('VM 상한(5000)을 넘어 12건을 버렸습니다'), 'VM 상한(5000)을 넘어 일부를 버렸습니다', '조사도 맞춘다');
  assert.equal(maskCounts('복원 지점이 9000개를 넘어 일부만'), '복원 지점이 상한을 넘어 일부만');
});

/* ═══════════════ V5-I2 ═══════════════ */
test('V5-I2: 연결 시험 성공은 인증 실패 정지를 풀고 authStopCleared 를 싣는다 · 실패는 풀지 않는다', async () => {
  resetAgent(); clearRegistry();
  const d = R.saveServer({ name: 'Stop', host: 'vbr-stop.corp', username: 'svc', password: 'pw', vcenterIds: [VC_KR] });
  const full = R.getServerWithSecret(d.id);
  try {
    poller.authGuard.markAuthStopped(d.id, full, '인증 실패(401)');
    vbrHandler = async () => json({ message: 'nope' }, 401);
    const bad = await call('POST', `/${d.id}/test`);
    assert.equal(bad.body.ok, false);
    assert.ok(poller.authGuard.authStopFor(full), '실패는 정지를 풀지 않는다');
    vbrHandler = async (url) => {
      const p = new URL(url).pathname;
      if (p === '/api/oauth2/token') return json({ access_token: 'T', token_type: 'bearer' });
      if (p === '/api/v1/jobs') return json({ data: [], pagination: { total: 0 } });
      return json({});
    };
    const ok = await call('POST', `/${d.id}/test`);
    assert.equal(ok.body.ok, true, JSON.stringify(ok.body));
    assert.equal(ok.body.authStopCleared, true);
    assert.equal(poller.authGuard.authStopFor(full), null, '정지 해제');
    const again = await call('POST', `/${d.id}/test`);
    assert.equal(again.body.authStopCleared, undefined, '정지가 없으면 표지 없음');
  } finally { vbrHandler = null; poller.authGuard.clearAuthStop(d.id); clearRegistry(); }
});

test('V1-I1 후속: 비밀번호가 없는(접속처 변경으로 폐기된) 서버는 연결 시험에서도 로그인하지 않는다', async () => {
  resetAgent(); clearRegistry();
  const d = R.saveServer({ name: 'NoPw', host: 'vbr-a.corp', username: 'svc', password: 'pw', vcenterIds: [VC_KR] });
  const { password: _pw, ...pub } = R.getServerWithSecret(d.id);
  R.saveServer({ ...pub, id: d.id, host: 'vbr-b.corp' });   // 접속처가 바뀌면 비밀번호를 승계하지 않는다(secretCarry)
  assert.equal(R.getServerWithSecret(d.id).password || '', '', '전제: 비밀번호 폐기');
  let calls = 0;
  try {
    vbrHandler = async () => { calls++; return json({ message: 'nope' }, 401); };
    const r = await call('POST', `/${d.id}/test`);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.kind, 'no-password');
    assert.equal(calls, 0, '빈 비밀번호로 로그인을 시도하지 않는다(AD 실패 로그온)');
  } finally { vbrHandler = null; clearRegistry(); }
});
