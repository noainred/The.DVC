/**
 * test/cvpBulk2641.test.js — CVP 서버 **CSV·자유텍스트 대량 등록**(v2.641) 회귀 고정.
 *
 * 사용자 요청: "CVP 를 CSV import/export 하는 기능 추가해줘 CVP 가 많아" → "비밀번호도 export 에 추가해줘" → "토큰도 포함".
 *
 * 실제 라우터(`registerCvpBulk`)를 express 에 마운트하고 AUTH_ENABLED=true 로 상태코드를 본다(꺼져 있으면 requireRole·
 * requireSettingsOwner 가 전부 통과해 게이트를 검증할 수 없다). 등록부·감사로그는 임시 CONFIG_DIR 의 실제 파일이다.
 *  ① 기본 내보내기 — 비밀 열은 있고 값은 비어 있다 · BOM · no-store · ASCII 파일명
 *  ② ?secrets=1 — 설정 소유자가 아니면 403, 소유자면 비밀번호·토큰이 실리고 감사로그에 '비밀번호·토큰 포함'(값은 없음)
 *  ③ 드라이런 — add/update/error 판정이 saveServer 와 같은 검증(드라이런 통과 = 실제 저장 성공)
 *  ④ 빈 비밀 칸 = 저장값 유지 · 접속 대상이 바뀌면 승계 안 함(비밀 없으면 오류) · 인증 방식 전환은 droppedSecrets
 *  ⑤ 파일 내 중복 키(id / 주소+담당) · 수식 가드(‘=’ 로 시작하는 셀) · 왕복(export → import = 전부 update, 복제 없음)
 *  ⑥ 담당 엣지·DataCenter 는 formChoices 와 같은 정규화(대소문자 → 목록 표기, 이름 → id, 모르는 값 오류)
 *  ⑦ 연결 테스트 — 엣지 위임 행은 skipped(실패 아님)·publicRun 에 비밀 없음 · 파일에 없는 열은 저장값 유지
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cvpbulk2641-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let srv, base, reg, bulk, sec, dcStore, audit, bulkRun;
const USERS = {
  owner: { username: 'owner1', role: 'admin', scope: null },
  admin: { username: 'adm2', role: 'admin', scope: null },
  op: { username: 'op', role: 'operator', scope: null },
};

before(async () => {
  const express = (await import('express')).default;
  const { registerCvpBulk } = await import('../src/routes/api/cvpBulk.js');
  reg = await import('../src/cvp/registry.js');
  bulk = await import('../src/cvp/bulk.js');
  sec = await import('../src/security/securitySettings.js');
  dcStore = await import('../src/datacenter/store.js');
  audit = await import('../src/audit.js');
  bulkRun = await import('../src/util/bulkRun.js');
  sec.saveSessionSecurity({ settingsOwners: ['owner1'] });
  dcStore.addDatacenter({ id: 'dc-seoul', name: 'Seoul HQ' });
  // 중앙이 아는 엣지 이름 하나(knownAgentNames 의 출처 중 하나 — 위임 스캔 배정)
  (await import('../src/central/assignments.js')).addAssignment({ agent: 'Edge-Seoul', ips: '10.0.0.1', username: 'u', password: 'p' });
  const r = express.Router();
  registerCvpBulk(r);
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api', r);
  srv = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  base = `http://127.0.0.1:${srv.address().port}/api/tools/cvp/bulk/servers`;
});
after(() => { try { srv?.close(); } catch { /* */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

async function call(u, method, p, body) {
  const r = await fetch(base + p, { method, headers: { 'x-u': u, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const buf = Buffer.from(await r.arrayBuffer());   // Response.text() 는 BOM 을 벗긴다 — 원시 바이트로 본다
  const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const t = (bom ? buf.subarray(3) : buf).toString('utf8');
  let j = null; try { j = JSON.parse(t); } catch { /* CSV */ }
  return { s: r.status, t, j, h: r.headers, bom };
}

/** 등록부를 비우고 다시 채운다(테스트 사이 독립). */
function resetRegistry(list = []) {
  fs.rmSync(path.join(tmp, 'cvp-servers.json'), { force: true });
  reg._resetForTest();
  return list.map((x) => reg.saveServer(x));
}

const csvRows = (t) => t.trim().split(/\r?\n/).map((l) => l.split(','));

test('① 기본 내보내기 — 비밀 열은 비어 있고 BOM·no-store·ASCII 파일명', async () => {
  resetRegistry([
    { name: 'CVP-A', host: 'https://10.10.0.1', authMode: 'token', token: 'tok-secret-A' },
    { name: 'CVP-B', host: '10.10.0.2:8443', authMode: 'password', username: 'svc', password: 'pw-secret-B' },
  ]);
  const r = await call('admin', 'GET', '/export.csv');
  assert.equal(r.s, 200);
  assert.ok(r.bom, 'UTF-8 BOM(엑셀 한글)');
  assert.equal(r.h.get('cache-control'), 'no-store');
  assert.match(r.h.get('content-disposition'), /filename="cvp-servers-[0-9-]+\.csv"/);
  assert.doesNotMatch(r.h.get('content-disposition'), /with-secrets/);
  const rows = csvRows(r.t);
  assert.deepEqual(rows[0], bulk.COLUMNS);
  const pi = bulk.COLUMNS.indexOf('password'); const ti = bulk.COLUMNS.indexOf('token');
  for (const row of rows.slice(1)) { assert.equal(row[pi], ''); assert.equal(row[ti], ''); }
  assert.equal(r.t.includes('tok-secret-A') || r.t.includes('pw-secret-B'), false, '기본 내보내기에 비밀이 없다');
  // 자유텍스트도 비밀 없음
  const tx = await call('admin', 'GET', '/export.txt');
  assert.equal(tx.s, 200);
  assert.equal(tx.t.includes('tok-secret-A') || tx.t.includes('pw-secret-B'), false);
  // operator 는 등록부 대량 기능 자체가 403(adminOnly)
  assert.equal((await call('op', 'GET', '/export.csv')).s, 403);
});

test('② ?secrets=1 — 설정 소유자만 · 비밀번호·토큰 포함 · 감사로그(값 없음)', async () => {
  resetRegistry([
    { name: 'CVP-A', host: 'https://10.10.0.1', authMode: 'token', token: 'tok-secret-A' },
    { name: 'CVP-B', host: '10.10.0.2:8443', authMode: 'password', username: 'svc', password: 'pw-secret-B' },
  ]);
  const deny = await call('admin', 'GET', '/export.csv?secrets=1');
  assert.equal(deny.s, 403, '설정 소유자가 아닌 admin');
  assert.equal(deny.j.requiredOwner, true);
  assert.equal(deny.t.includes('tok-secret-A'), false);
  // 스토리지 모달의 옛 쿼리 이름도 같은 게이트를 탄다
  assert.equal((await call('admin', 'GET', '/export.csv?passwords=1')).s, 403);

  const ok = await call('owner', 'GET', '/export.csv?secrets=1');
  assert.equal(ok.s, 200);
  assert.match(ok.h.get('content-disposition'), /cvp-servers-with-secrets-/);
  assert.equal(ok.h.get('cache-control'), 'no-store');
  assert.ok(ok.t.includes('tok-secret-A'), '토큰 포함');
  assert.ok(ok.t.includes('pw-secret-B'), '비밀번호 포함');
  const logs = audit.listAudit({ limit: 50 }).items || audit.listAudit({ limit: 50 });
  const entries = Array.isArray(logs) ? logs : (logs.entries || logs.rows || []);
  const hit = entries.find((e) => /비밀번호·토큰 포함/.test(e.action || ''));
  assert.ok(hit, '감사로그에 비밀 포함 내보내기 기록');
  assert.equal(hit.user, 'owner1');
  assert.equal(JSON.stringify(entries).includes('tok-secret-A') || JSON.stringify(entries).includes('pw-secret-B'), false, '감사로그에 비밀 값 없음');
});

test('③ 드라이런 — add/update/error 가 saveServer 와 같은 검증이다', async () => {
  const [a] = resetRegistry([{ name: 'CVP-A', host: 'https://10.10.0.1', authMode: 'token', token: 'tok-A' }]);
  const csv = [
    bulk.COLUMNS.join(','),
    `${a.id},CVP-A2,https://10.10.0.1,token,,,,false,true,,,`,          // update(id) — 토큰 비움 = 유지
    ',CVP-N,https://10.10.0.9,token,,,,false,true,,,tok-N',             // add
    ',CVP-X,https://10.10.0.8,token,,,,false,true,,,',                  // error — 새 토큰 모드에 토큰 없음
    ',CVP-Y,http://169.254.169.254,token,,,,false,true,,,tok',          // error — 링크로컬 차단(baseUrlOf)
    'cvp-nope,CVP-Z,https://10.10.0.7,token,,,,false,true,,,tok',       // error — 없는 id
    ',CVP-W,https://10.10.0.6,password,,,,false,true,,pw,',             // error — password 모드 계정 없음
  ].join('\n');
  const r = await call('admin', 'POST', '/import', { csv, dryRun: true });
  assert.equal(r.s, 200, r.t);
  const act = Object.fromEntries(r.j.report.map((x) => [x.line, x.action]));
  assert.deepEqual(act, { 2: 'update', 3: 'add', 4: 'error', 5: 'error', 6: 'error', 7: 'error' });
  const reason = Object.fromEntries(r.j.report.map((x) => [x.line, x.reason]));
  assert.match(reason[4], /토큰을 입력/);
  assert.match(reason[5], /차단/);
  assert.match(reason[6], /없는 CVP 서버/);
  assert.match(reason[7], /접속 계정/);
  // 토큰 오류 조언은 username 이 아니라 token 열을 가리킨다(공용 규칙이 '계정' 에 걸리는 것을 바로잡음)
  assert.equal(r.j.report.find((x) => x.line === 4).field, 'token');
  // 드라이런은 저장하지 않는다
  assert.equal(reg.listServers().length, 1);

  // 같은 검증 = 저장 성공: 선택 없이 커밋하면 오류 아닌 2행만 저장된다
  const c = await call('admin', 'POST', '/import', { csv });
  assert.equal(c.s, 200, c.t);
  assert.equal(c.j.added, 1); assert.equal(c.j.updated, 1); assert.deepEqual(c.j.failed, []);
  assert.equal(reg.getServerWithSecret(a.id).token, 'tok-A', '빈 토큰 칸 = 저장값 유지');
  assert.equal(reg.getServer(a.id).name, 'CVP-A2');
});

test('④ 접속 대상이 바뀌면 저장 비밀을 승계하지 않는다 · 인증 방식 전환은 droppedSecrets 로 밝힌다', async () => {
  const [p, t] = resetRegistry([
    { name: 'CVP-P', host: 'https://10.10.1.1', authMode: 'password', username: 'svc', password: 'pw-old' },
    { name: 'CVP-T', host: 'https://10.10.1.2', authMode: 'token', token: 'tok-old' },
  ]);
  // host 를 바꾸고 비밀번호를 비운 행 → 오류(승계 안 함)
  const moved = [bulk.COLUMNS.join(','), `${p.id},CVP-P,https://10.10.1.99,password,svc,,,false,true,,,`].join('\n');
  const d = await call('admin', 'POST', '/import', { csv: moved, dryRun: true });
  assert.equal(d.j.report[0].action, 'error');
  assert.match(d.j.report[0].reason, /비밀번호를 입력/);
  // 토큰 → 비밀번호 방식으로 바꾸며 새 비밀번호를 준 행 → 저장되고 옛 토큰은 폐기(droppedSecrets)
  const sw = [bulk.COLUMNS.join(','), `${t.id},CVP-T,https://10.10.1.2,password,svc2,,,false,true,,pw-new,`].join('\n');
  const c = await call('admin', 'POST', '/import', { csv: sw });
  assert.equal(c.s, 200, c.t);
  assert.equal(c.j.updated, 1);
  assert.equal(c.j.droppedSecrets.length, 1);
  assert.deepEqual(c.j.droppedSecrets[0].secrets, ['token']);
  assert.ok(c.j.skipped.some((x) => /폐기/.test(x.reason)), '공용 모달이 보여 주는 skipped 에도 폐기 사실');
  const raw = reg.getServerWithSecret(t.id);
  assert.equal(raw.token, undefined);
  assert.equal(raw.password, 'pw-new');
  assert.equal(JSON.stringify(c.j).includes('pw-new'), false, '응답에 비밀 없음');
});

test('⑤ 파일 내 중복 · 수식 가드 · 왕복(export → import = 복제 없이 전부 update)', async () => {
  const [a] = resetRegistry([{ name: '=SUM(1+2)', host: 'https://10.10.2.1', authMode: 'token', token: 'tok', note: '+cmd' }]);
  const ex = await call('owner', 'GET', '/export.csv?secrets=1');
  assert.ok(ex.t.includes(`'=SUM(1+2)`), '‘=’ 로 시작하는 셀은 작은따옴표로 가드');
  assert.ok(ex.t.includes(`'+cmd`));
  // 왕복 — 가드를 풀고 그대로 update 1건, 추가 0
  const rt = await call('admin', 'POST', '/import', { csv: ex.t });
  assert.equal(rt.s, 200, rt.t);
  assert.equal(rt.j.updated, 1); assert.equal(rt.j.added, 0);
  assert.equal(reg.listServers().length, 1);
  assert.equal(reg.getServer(a.id).name, '=SUM(1+2)', '가드가 한 겹씩 쌓이지 않는다');
  // 기본(비밀 없는) 내보내기도 id 없이 왕복하면 주소+담당으로 같은 서버를 찾는다
  const plain = await call('admin', 'GET', '/export.csv');
  const noId = plain.t.split(/\r?\n/).map((l, i) => (i === 0 || !l ? l : `,${l.split(',').slice(1).join(',')}`)).join('\n');
  const rt2 = await call('admin', 'POST', '/import', { csv: noId, dryRun: true });
  assert.equal(rt2.j.report[0].action, 'update', rt2.t);

  // 파일 내 중복 — 같은 id 두 줄, 같은 주소+담당 두 줄(새 서버)
  const dup = [bulk.COLUMNS.join(','),
    `${a.id},A1,https://10.10.2.1,token,,,,false,true,,,`,
    `${a.id},A2,https://10.10.2.1,token,,,,false,true,,,`,
    ',N1,https://10.10.2.5,token,,,,false,true,,,t1',
    ',N2,https://10.10.2.5:443,token,,,,false,true,,,t2',
  ].join('\n');
  const d = await call('admin', 'POST', '/import', { csv: dup, dryRun: true });
  const byLine = Object.fromEntries(d.j.report.map((x) => [x.line, x]));
  assert.equal(byLine[2].action, 'update');
  assert.equal(byLine[3].action, 'error'); assert.match(byLine[3].reason, /파일 내 중복 — 2행/);
  assert.equal(byLine[4].action, 'add');
  assert.equal(byLine[5].action, 'error', ':443 는 같은 origin — 같은 서버로 본다'); assert.match(byLine[5].reason, /파일 내 중복 — 4행/);
});

test('⑥ 담당 엣지·DataCenter 는 폼과 같은 정규화 — 순수 판정(prepareRow)', () => {
  const ctx = { servers: [], agents: ['Edge-Seoul'], datacenters: [{ id: 'dc-seoul', name: 'Seoul HQ' }] };
  const row = (o) => ({ _line: 2, _present: null, id: '', name: 'X', host: 'https://10.1.1.1', authMode: 'token', username: '', agent: '', datacenter: '', verifyTls: '', enabled: '', note: '', password: '', token: 'tok', ...o });
  const p1 = bulk.prepareRow(row({ agent: 'edge-seoul', datacenter: 'seoul hq' }), ctx);
  assert.equal(p1.issue, null);
  assert.equal(p1.input.agent, 'Edge-Seoul', '대소문자는 목록 표기로');
  assert.equal(p1.input.datacenterId, 'dc-seoul', '이름 → id');
  assert.match(bulk.prepareRow(row({ agent: 'Edge-Busan' }), ctx).issue, /엣지 목록에 없습니다/);
  assert.match(bulk.prepareRow(row({ datacenter: 'Nowhere' }), ctx).issue, /DataCenter 목록에 없습니다/);
  assert.match(bulk.prepareRow(row({ verifyTls: 'maybe' }), ctx).quick, /verifyTls/);
  // 엣지 위임 행은 연결 테스트 대상이 아니다(skipped)
  assert.match(bulk.skipReasonOf(p1.input), /엣지\(Edge-Seoul\)/);
  assert.equal(bulk.skipReasonOf({ agent: '' }), null);
});

test('⑦ 파일에 없는 열은 저장값 유지 · 연결 테스트 엣지 행은 skipped · 결과에 비밀 없음', async () => {
  const [e] = resetRegistry([{ name: 'CVP-E', host: 'https://10.10.3.1', authMode: 'token', token: 'tok-e', agent: '', datacenterId: 'dc-seoul', note: 'keep-me' }]);
  // 헤더에 id·name·token 만 — agent·datacenter·note 는 건드리지 않는다
  const csv = ['id,name,token', `${e.id},CVP-E2,`].join('\n');
  const c = await call('admin', 'POST', '/import', { csv });
  assert.equal(c.s, 200, c.t);
  const s = reg.getServerWithSecret(e.id);
  assert.equal(s.name, 'CVP-E2'); assert.equal(s.datacenterId, 'dc-seoul'); assert.equal(s.note, 'keep-me'); assert.equal(s.token, 'tok-e');
  // 자유텍스트 키=값 한 줄 — 적지 않은 note 유지
  const t = await call('admin', 'POST', '/import', { text: `id=${e.id} name=CVP-E3`, format: 'text' });
  assert.equal(t.s, 200, t.t);
  assert.equal(reg.getServer(e.id).note, 'keep-me');
  assert.equal(reg.getServer(e.id).name, 'CVP-E3');

  // 연결 테스트 — 엣지 위임 행은 '실패' 가 아니라 skipped(로그인 시도 0 — 중앙에서 닿지 않는 것이 정상)
  bulkRun._resetForTest();
  const test1 = await call('admin', 'POST', '/import/test', { csv: [bulk.COLUMNS.join(','), ',CVP-Q,https://127.0.0.1:1,token,,,,false,true,,,tok-live-SECRET'].join('\n') });
  assert.equal(test1.s, 400, '루프백은 형식 검증(SSRF 차단)에서 떨어진다 — 테스트할 행이 없다');
  const test2 = await call('admin', 'POST', '/import/test', { csv: [bulk.COLUMNS.join(','), ',CVP-Q,https://10.255.255.1,token,,edge-seoul,,false,true,,,tok-live-SECRET'].join('\n') });
  assert.equal(test2.s, 200, test2.t);
  let run;
  for (let i = 0; i < 50; i++) { run = await call('admin', 'GET', `/import/test/${test2.j.id}`); if (run.j.status === 'done') break; await new Promise((r) => setTimeout(r, 20)); }
  assert.equal(run.s, 200);
  assert.equal(run.j.kind, 'cvp');
  assert.equal(run.j.status, 'done');
  assert.deepEqual(run.j.summary, { ok: 0, fail: 0, skipped: 1, pending: 0 });
  assert.match(run.j.results[0].reason, /엣지\(Edge-Seoul\)/);
  assert.equal(JSON.stringify(run.j).includes('tok-live-SECRET'), false, 'publicRun 에 비밀 없음');
  assert.equal((await call('admin', 'GET', '/import/test/bt-nope')).s, 404);
});

test('⑧ 샘플은 비밀이 아닌 자리표시자만이고 그대로 가져와도 오류가 없다 · api.js 가 라우트를 등록한다', async () => {
  resetRegistry([]);
  const sc = await call('admin', 'GET', '/sample.csv');
  assert.equal(sc.s, 200);
  assert.ok(sc.bom);
  const d = await call('admin', 'POST', '/import', { csv: sc.t, dryRun: true });
  assert.equal(d.s, 200, d.t);
  assert.equal(d.j.summary.error, 0, JSON.stringify(d.j.report));
  const st = await call('admin', 'GET', '/sample.txt');
  const d2 = await call('admin', 'POST', '/import', { text: st.t, format: 'text', dryRun: true });
  assert.equal(d2.s, 200, d2.t);
  assert.equal(d2.j.summary.error, 0, JSON.stringify(d2.j.report));
  assert.equal(d2.j.total, 4);
  const apiSrc = fs.readFileSync(path.join(HERE, '../src/routes/api.js'), 'utf8');
  assert.match(apiSrc, /^registerCvpBulk\(api\);$/m);
});
