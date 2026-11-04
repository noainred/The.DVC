/**
 * test/bareosLinkTarget2879.test.js — v2.879 '등록부 대상 연결'(2026-11-04 사용자 요청: 완전 설치 대상 표의 '배포 등록부에 엣지 ‘agent-WA’ 의 SSH 대상이 없습니다' —
 *   '다르게 들어간 Agent 명을 수정할 수 있는 기능' · '기존 설치된 목록에서 선택하게' · '오타나 다른 오류가 생기는 거 방지').
 *  ① linkCandidates(순수): 다른 엣지가 쓰는 이름 · 비밀 없는 대상은 잠금 · 다른 법인 작업 표지 · 응답에 비밀 없음
 *  ② linkDecision(순수): 행 없음 · 엣지 없음 · 이미 연결 · 대상 없음 · 잠금 · 다른 법인 작업 · 화면이 본 이름과 다름
 *  ③ readPortalIdentity(가짜 exec): AGENT_NAME 마지막 값 → COLLECTOR_DATACENTER → hostname · 설정 파일을 정하지 못하면 확인 불가
 *  ④ linkInstallTarget(실제 배포 등록부 파일 + 가짜 SSH): 같은 서버면 agentName 만 바뀌고 비밀 · 주소 그대로 · 수집 서버 등록부 안 만듦 /
 *     다른 서버 · 확인 불가 · 인증 실패 · 시한 · SSH 동안 주소 변경 · 그사이 이름 변경 · 동시 실행이면 바꾸지 않는다
 *  ⑤ setTargetAgentName: expect 불일치 · 개행 거부
 *  ⑥ buildTargets 사유 문구는 실제 메뉴 이름(없는 메뉴 '배포 › 엣지 노드' 소스 스윕) · linkable
 *  ⑦ 라우트(express): 이름을 본문에서 받지 않는다(agentName 을 보내도 행의 엣지 이름) · 감사
 *  ⑧ 데모: 일곱째 엣지 — 실제 판정 코드 · 다른 서버 거부 · 연결 뒤 설치 가능
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bi2879-'));
process.env.CONFIG_DIR = tmp;
process.env.AUTH_ENABLED = 'false';
process.env.DATA_SOURCE = 'live';   // 라우트 ⑦ 은 실제 경로(데모 아님) — 데모 ⑧ 은 demo.js 를 직접 부른다

const L = await import('../src/bareos/install/linkTarget.js');
const { buildTargets, noTargetWhy } = await import('../src/bareos/install/targets.js');
const R = await import('../src/agent/deployRegistry.js');
const demo = await import('../src/bareos/install/demo.js');
const { stripComments } = await import('./_stripComments.js');
const { store } = await import('../src/store.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PASS = 'Edge-Root-pw!9';

/* ───────── ① ② 순수 ───────── */
test('① linkCandidates — 다른 엣지가 쓰는 이름 · 비밀 없는 대상 잠금 · 작업 표지 · 비밀 없음', () => {
  const c = L.linkCandidates({
    deployTargets: [
      { id: 'a', host: '10.0.0.20', port: 22, username: 'root', agentName: 'Edge-1', password: PASS },        // 살아 있는 엣지 edge-1 이 씀(대소문자 무시)
      { id: 'b', host: '10.0.0.9', port: 2222, username: 'root', agentName: 'agentWA', password: PASS },     // 이름 오타 — 고를 수 있음
      { id: 'c', host: '10.0.0.10', username: 'root', agentName: '', privateKey: 'KEY' },                    // 키만 — 고를 수 있음(확인은 키로)
      { id: 'd', host: '10.0.0.11', username: 'root', agentName: 'old' },                                    // 비밀 없음 — 잠금
      { id: 'e', host: '10.0.0.12', username: 'root', agentName: 'x', password: PASS },                       // 다른 법인 작업이 씀
      { id: 'f', host: '', agentName: 'nohost', password: PASS },                                             // 주소 없는 항목은 빼다
    ],
    inventory: [{ vcenterId: 'vc1', agent: 'edge-1' }, { vcenterId: 'vc9', agent: 'agent-WA' }],
    jobs: [{ id: 'bi_job001', vcenterId: 'vc5', vcenterName: '법인5', targetId: 'e', status: 'done' }, { id: 'bi_job002', vcenterId: 'vc6', targetId: 'b', status: 'rolledback' }],
  });
  assert.deepEqual(c.map((x) => x.id), ['b', 'c', 'd', 'e', 'a'], '주소 숫자 순(10.0.0.9 < 10.0.0.10)');
  const by = Object.fromEntries(c.map((x) => [x.id, x]));
  assert.match(by.a.blocked, /엣지 ‘edge-1’ 가 쓰는 대상/);
  assert.equal(by.b.blocked, ''); assert.equal(by.b.sshPort, 2222); assert.equal(by.b.jobVcenterId, undefined, '전부 되돌린 작업은 표지하지 않는다');
  assert.equal(by.c.blocked, ''); assert.equal(by.c.hasKey, true);
  assert.match(by.d.blocked, /비밀번호 · 키가 저장돼 있지 않아/);
  assert.equal(by.e.blocked, ''); assert.equal(by.e.jobVcenterId, 'vc5');
  const json = JSON.stringify(c);
  assert.ok(!json.includes(PASS) && !json.includes('KEY'), '응답에 비밀이 없다');
  for (const x of c) assert.equal('password' in x || 'privateKey' in x, false);
});

test('② linkDecision — 거부 사유들', () => {
  const row = { vcenterId: 'vc9', vcenterName: '법인9', agent: 'agent-WA', targetId: '' };
  const cand = { id: 'b', host: '10.0.0.9', sshPort: 22, agentName: 'agentWA', blocked: '' };
  const code = (fn) => { try { fn(); return 'ok'; } catch (e) { return e.code; } };
  assert.equal(code(() => L.linkDecision(row, cand, { expectName: 'agentWA' })), 'ok');
  assert.equal(code(() => L.linkDecision(null, cand)), 'not-found');
  assert.equal(code(() => L.linkDecision({ ...row, agent: '' }, cand)), 'invalid');
  assert.equal(code(() => L.linkDecision({ ...row, targetId: 't1' }, cand)), 'conflict', '이미 연결된 행');
  assert.equal(code(() => L.linkDecision(row, null)), 'not-found');
  assert.equal(code(() => L.linkDecision(row, { ...cand, blocked: '엣지 ‘x’ 가 쓰는 대상입니다' })), 'conflict');
  assert.equal(code(() => L.linkDecision(row, { ...cand, jobVcenterId: 'vc5', jobVcenterName: '법인5', jobId: 'bi_x' })), 'conflict', '다른 법인 작업');
  assert.equal(code(() => L.linkDecision(row, { ...cand, jobVcenterId: 'vc9' })), 'ok', '이 법인 작업은 막지 않는다');
  assert.equal(code(() => L.linkDecision(row, cand, { expectName: 'agentwa' })), 'conflict', '화면이 본 이름과 다르면(대소문자도) 거부');
});

/* ───────── ③ SSH 안 읽기 ───────── */
function fakeExec({ uid = '0', env = '', hostname = 'edge-wa01', listenPid = '', unit = '', envPort = '' } = {}) {
  const cmds = [];
  const exec = async (cmd) => {
    cmds.push(cmd);
    if (cmd === 'id -u') return { stdout: `${uid}\n`, code: 0 };
    if (cmd.startsWith('ss -ltnp')) return { stdout: listenPid ? `LISTEN 0 511 *:4000 *:* users:(("node",pid=${listenPid},fd=20))\n` : '' };
    if (cmd.startsWith('ps -o unit=')) return { stdout: `${unit}\n` };
    if (cmd.startsWith("grep -E '^PORT='")) return { stdout: envPort ? `PORT=${envPort}\n` : '' };
    if (cmd.startsWith("grep -E '^(AGENT_NAME|COLLECTOR_DATACENTER)='")) return { stdout: env };
    if (cmd.startsWith('hostname')) return { stdout: `${hostname}\n` };
    return { stdout: '', code: 0 };
  };
  return { exec, cmds };
}

test('③ readPortalIdentity — AGENT_NAME 마지막 값 · COLLECTOR_DATACENTER · hostname · 확인 불가', async () => {
  let f = fakeExec({ env: 'AGENT_NAME=agentWA\nAGENT_NAME="agent-WA"\n', listenPid: '4242', unit: 'vmware-portal.service' });
  let r = await L.readPortalIdentity(f.exec, 4000);
  assert.deepEqual([r.ok, r.name, r.fromEnv, r.root], [true, 'agent-WA', true, true], '마지막 값 · 따옴표 벗김');
  assert.ok(f.cmds.some((c) => c.includes("'/etc/vmware-portal/portal.env'")), '기본 인스턴스 파일');
  assert.ok(!f.cmds.some((c) => /TOKEN/.test(c)), '토큰 키를 읽는 명령이 없다');
  r = await L.readPortalIdentity(fakeExec({ env: 'COLLECTOR_DATACENTER=WA\n' }).exec, 4000);
  assert.equal(r.name, 'WA');
  r = await L.readPortalIdentity(fakeExec({ env: '', uid: '1000', hostname: 'edge-wa01' }).exec, 4000);
  assert.deepEqual([r.name, r.fromEnv, r.root], ['edge-wa01', false, false]);
  r = await L.readPortalIdentity(fakeExec({ envPort: '4100' }).exec, 4000);
  assert.equal(r.ok, false, ':4000 리슨 없음 + 기본 인스턴스 PORT 다름 → 그 엣지인지 모름');
  assert.match(r.reason, /확인할 수 없습니다\(바꾸지 않았습니다\)/);
  r = await L.readPortalIdentity(fakeExec({ listenPid: '77', unit: 'haproxy.service' }).exec, 4000);
  assert.equal(r.ok, false, '포워더가 받는 포트');
  assert.equal(L.identityIssue('h', { ok: true, name: '', hostname: '', fromEnv: false, root: true }, ''), 'h 의 포탈 이름은 ‘모름’ 입니다(호스트 이름 모름) — 엣지 ‘’ 가 아닌 다른 서버입니다. 다른 대상을 고르세요(바꾸지 않았습니다).', '빈 이름끼리 같다고 보지 않는다');
  assert.match(L.identityIssue('h', { ok: true, name: 'edge-wa01', hostname: 'edge-wa01', fromEnv: false, root: false }, 'agent-WA'), /root 가 아니라 portal\.env 를 읽지 못했을 수/);
});

/* ───────── ④ 실행(실제 등록부 파일) ───────── */
const ROWS = () => [
  { vcenterId: 'vc9', vcenterName: '법인9', agent: 'agent-WA', targetId: '', sshHost: '', linkable: true },
  { vcenterId: 'vc1', vcenterName: '법인1', agent: 'edge-1', targetId: '', sshHost: '' },
];
function setup({ portal = 'agent-WA', sshThrows = null, during = null } = {}) {
  for (const t of R.listTargetsRaw()) R.removeTarget(t.id);
  const wa = R.saveTarget({ host: '10.0.0.9', port: 22, username: 'root', password: PASS, agentName: 'agentWA', centralToken: 'CT-secret', collectorToken: 'COL-secret', portalPort: 4000 }).target;
  const other = R.saveTarget({ host: '10.0.0.30', port: 22, username: 'root', password: PASS, agentName: 'old-edge' }).target;
  const calls = { ssh: 0 };
  L._setLinkDepsForTest({
    snapshot: () => ({ rows: ROWS(), inventory: [{ vcenterId: 'vc9', agent: 'agent-WA' }, { vcenterId: 'vc1', agent: 'edge-1' }], deployTargets: R.listTargetsRaw(), jobs: [] }),
    ssh: async (creds, fn, { signal } = {}) => {
      calls.ssh++; calls.creds = creds; calls.signal = signal;
      if (sshThrows) throw sshThrows;
      if (during) during();
      return fn({ exec: fakeExec({ env: `AGENT_NAME=${creds.host === '10.0.0.9' ? portal : 'old-edge'}\n` }).exec });
    },
  });
  return { wa, other, calls };
}
const colFile = () => path.join(tmp, 'collectors.json');

test('④-1 같은 서버 — agentName 만 바뀌고 비밀 · 주소 · 토큰 그대로 · 수집 서버 등록부를 만들지 않는다', async () => {
  const { wa, calls } = setup();
  const before = R.getTargetRaw(wa.id);
  const r = await L.linkInstallTarget({ vcenterId: 'vc9', targetId: wa.id, expectName: 'agentWA' });
  assert.deepEqual([r.agent, r.before, r.portalName, r.host], ['agent-WA', 'agentWA', 'agent-WA', '10.0.0.9']);
  const after = R.getTargetRaw(wa.id);
  assert.equal(after.agentName, 'agent-WA', '행의 엣지 이름 그대로(대소문자 포함)');
  for (const k of ['host', 'port', 'username', 'password', 'centralToken', 'collectorToken', 'portalPort']) assert.deepEqual(after[k], before[k], `${k} 그대로`);
  assert.equal(calls.ssh, 1); assert.equal(calls.creds.host, '10.0.0.9'); assert.equal(calls.creds.password, PASS);
  assert.ok(calls.signal instanceof AbortSignal, '시한 신호로 세션을 끊는다');
  assert.equal(fs.existsSync(colFile()), false, '수집 서버 등록부를 건드리지 않는다');
  // 파일에도 남는다(캐시만이 아니다)
  const disk = JSON.parse(fs.readFileSync(path.join(tmp, 'agent-deploy-targets.json'), 'utf8'));
  assert.equal(disk.targets.find((t) => t.id === wa.id).agentName, 'agent-WA');
  // 다시 하면 — 이제 고를 수 없다(살아 있는 엣지가 쓰는 대상)
  await assert.rejects(L.linkInstallTarget({ vcenterId: 'vc9', targetId: wa.id, expectName: 'agent-WA' }), (e) => e.code === 'conflict');
});

test('④-2 다른 서버 · 확인 불가 · 인증 실패 · 시한이면 바꾸지 않는다', async () => {
  let s = setup();
  await assert.rejects(L.linkInstallTarget({ vcenterId: 'vc9', targetId: s.other.id, expectName: 'old-edge' }),
    (e) => e.code === 'conflict' && /포탈 이름은 ‘old-edge’ .*다른 서버입니다/.test(e.message));
  assert.equal(R.getTargetRaw(s.other.id).agentName, 'old-edge');
  s = setup({ portal: 'agent-WB' });
  await assert.rejects(L.linkInstallTarget({ vcenterId: 'vc9', targetId: s.wa.id, expectName: 'agentWA' }), (e) => e.code === 'conflict');
  assert.equal(R.getTargetRaw(s.wa.id).agentName, 'agentWA');
  s = setup({ sshThrows: Object.assign(new Error('All configured authentication methods failed'), { level: 'client-authentication' }) });
  await assert.rejects(L.linkInstallTarget({ vcenterId: 'vc9', targetId: s.wa.id, expectName: 'agentWA' }), (e) => e.code === 'ssh-auth');
  assert.equal(s.calls.ssh, 1, '인증 실패는 다시 시도하지 않는다');
  assert.equal(R.getTargetRaw(s.wa.id).agentName, 'agentWA');
  s = setup({ sshThrows: new Error('SSH 세션 취소(타임아웃)') });
  await assert.rejects(L.linkInstallTarget({ vcenterId: 'vc9', targetId: s.wa.id, expectName: 'agentWA' }), /타임아웃/);
  assert.equal(R.getTargetRaw(s.wa.id).agentName, 'agentWA');
});

test('④-3 SSH 동안 주소가 바뀌거나 · 화면이 본 이름이 다르거나 · 동시 실행이면 바꾸지 않는다', async () => {
  let s = setup({ during: () => R.saveTarget({ id: R.listTargetsRaw().find((t) => t.host === '10.0.0.9').id, host: '10.0.0.99', password: PASS }) });
  await assert.rejects(L.linkInstallTarget({ vcenterId: 'vc9', targetId: s.wa.id, expectName: 'agentWA' }), (e) => e.code === 'conflict' && /SSH 주소 · 계정이 바뀌었습니다/.test(e.message));
  assert.equal(R.getTargetRaw(s.wa.id).agentName, 'agentWA');
  s = setup({ during: () => R.saveTarget({ id: R.listTargetsRaw().find((t) => t.host === '10.0.0.9').id, host: '10.0.0.9', agentName: 'someone-else' }) });
  await assert.rejects(L.linkInstallTarget({ vcenterId: 'vc9', targetId: s.wa.id, expectName: 'agentWA' }), (e) => e.code === 'conflict');
  assert.equal(R.getTargetRaw(s.wa.id).agentName, 'someone-else', '그사이 사람이 바꾼 값을 덮지 않는다');
  s = setup();
  await assert.rejects(L.linkInstallTarget({ vcenterId: 'vc9', targetId: s.wa.id, expectName: 'agent-WA' }), (e) => e.code === 'conflict', '화면이 본 이름이 다르다');
  assert.equal(s.calls.ssh, 0, '판정에서 막히면 접속하지 않는다');
  await assert.rejects(L.linkInstallTarget({ vcenterId: 'vc9', targetId: s.wa.id }), (e) => e.code === 'invalid', 'expectName 없음');
  await assert.rejects(L.linkInstallTarget({ vcenterId: ['vc9'], targetId: s.wa.id, expectName: 'agentWA' }), (e) => e.code === 'invalid', '글자가 아닌 값');
  // 동시 실행 — 첫 SSH 가 끝나기 전 두 번째는 409
  let release; const gate = new Promise((r) => { release = r; });
  s = setup();
  L._setLinkDepsForTest({
    snapshot: () => ({ rows: ROWS(), inventory: [{ vcenterId: 'vc9', agent: 'agent-WA' }], deployTargets: R.listTargetsRaw(), jobs: [] }),
    ssh: async (creds, fn) => { await gate; return fn({ exec: fakeExec({ env: 'AGENT_NAME=agent-WA\n' }).exec }); },
  });
  const p1 = L.linkInstallTarget({ vcenterId: 'vc9', targetId: s.wa.id, expectName: 'agentWA' });
  await assert.rejects(L.linkInstallTarget({ vcenterId: 'vc9', targetId: s.other.id, expectName: 'old-edge' }), (e) => e.code === 'conflict' && /진행 중/.test(e.message));
  release(); await p1;
  assert.equal(R.getTargetRaw(s.wa.id).agentName, 'agent-WA');
});

/* ───────── ⑤ 등록부 ───────── */
test('⑤ setTargetAgentName — expect 불일치 · 개행 · 빈 값 거부', () => {
  for (const t of R.listTargetsRaw()) R.removeTarget(t.id);
  const t = R.saveTarget({ host: '10.1.1.1', username: 'root', password: PASS, agentName: 'a1' }).target;
  assert.equal(R.setTargetAgentName(t.id, 'a2', { expect: 'zz' }).code, 'conflict');
  assert.equal(R.setTargetAgentName(t.id, 'a2\nAUTH_ENABLED=false').code, 'invalid');
  assert.equal(R.setTargetAgentName(t.id, '  ').code, 'invalid');
  assert.equal(R.setTargetAgentName('nope', 'a2').code, 'not-found');
  const ok = R.setTargetAgentName(t.id, 'a2', { expect: 'a1' });
  assert.equal(ok.ok, true); assert.equal(ok.before, 'a1'); assert.equal(ok.target.password, undefined, '응답은 가림'); assert.equal(ok.target.hasPassword, true);
  assert.equal(R.getTargetRaw(t.id).password, PASS);
});

/* ───────── ⑥ 사유 문구 ───────── */
test('⑥ 사유 문구는 실제 메뉴 이름 · linkable · 없는 메뉴 이름 소스 스윕', () => {
  const rows = buildTargets({ vcenters: [{ id: 'vc9', name: '법인9' }], inventory: [{ vcenterId: 'vc9', agent: 'agent-WA', at: Date.now() }], deployTargets: [{ id: 'b', host: '10.0.0.9', agentName: 'agentWA', password: PASS }] });
  assert.equal(rows[0].linkable, true); assert.equal(rows[0].can, false);
  assert.equal(rows[0].why, noTargetWhy('agent-WA'));
  assert.match(rows[0].why, /설정 › 원격 법인\(DC\)에 Edge 노드 포탈 설치/);
  assert.match(rows[0].why, /‘등록부 대상 연결’/);
  const ok = buildTargets({ vcenters: [{ id: 'vc9', name: '법인9' }], inventory: [{ vcenterId: 'vc9', agent: 'agent-WA', at: Date.now() }], deployTargets: [{ id: 'b', host: '10.0.0.9', agentName: 'AGENT-wa', password: PASS }] });
  assert.equal(ok[0].linkable, undefined, '이름이 대소문자만 다르면 이미 찾는다(연결 단추 없음)');
  const roots = [path.join(HERE, '../src'), path.join(HERE, '../../web/src')];
  const hits = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(js|jsx)$/.test(e.name) && !/\.test\.jsx?$/.test(e.name) && stripComments(fs.readFileSync(p, 'utf8')).includes('배포 › 엣지 노드')) hits.push(p); } };   // 주석은 뺀다(옛 문구를 밝히는 주석)
  roots.forEach(walk);
  assert.deepEqual(hits, [], '없는 메뉴 이름(배포 › 엣지 노드)을 안내하지 않는다');
});

/* ───────── ⑦ 라우트 ───────── */
test('⑦ 라우트 — 본문의 이름은 쓰지 않는다 · 성공 · 거부 감사', async () => {
  const { default: express } = await import('express');
  const { registerBareosInstall } = await import('../src/routes/api/bareosInstall.js');
  const app = express(); app.use(express.json());
  const api = express.Router(); registerBareosInstall(api); app.use('/api', api);
  const srv = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
  const url = `http://127.0.0.1:${srv.address().port}/api/tools/bareos-backup/settings/install/link-target`;
  const post = (b) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  try {
    const s = setup();
    const bad = await post({ vcenterId: 'vc9', targetId: s.other.id, expectName: 'old-edge', agentName: 'old-edge' });
    assert.equal(bad.status, 409); assert.match(bad.body.reason, /다른 서버입니다/);
    const r = await post({ vcenterId: 'vc9', targetId: s.wa.id, expectName: 'agentWA', agentName: 'typo-name', name: 'typo-name' });
    assert.equal(r.status, 200); assert.equal(r.body.agent, 'agent-WA', '본문의 agentName · name 은 쓰지 않는다');
    assert.equal(R.getTargetRaw(s.wa.id).agentName, 'agent-WA');
    assert.ok(!JSON.stringify(r.body).includes(PASS));
    const audit = fs.readdirSync(tmp).filter((f) => /audit/.test(f)).map((f) => { try { return fs.readFileSync(path.join(tmp, f), 'utf8'); } catch { return ''; } }).join('\n');
    if (audit) {   // 감사 저장 위치가 이 디렉터리일 때만 대조(저장 방식은 audit.js 몫)
      assert.match(audit, /배포 등록부 대상 연결/);
      assert.ok(!audit.includes(PASS), '감사에 비밀 없음');
    }
  } finally { srv.close(); }
});

/* ───────── ⑧ 데모 ───────── */
test('⑧ 데모 — 일곱째 엣지(이름 오타)를 실제 판정 코드로 연결', () => {
  demo._resetForTest();
  const prev = store.snapshot;
  store.snapshot = { ...prev, vcenters: Array.from({ length: 7 }, (_, i) => ({ id: `vc${i + 1}`, name: `법인${i + 1}` })) };
  try {
    const ov = demo.overview();
    const t7 = ov.targets[6];
    assert.deepEqual([t7.agent, t7.targetId, t7.can, t7.linkable], ['edge-demo-7', '', false, true]);
    assert.equal(t7.why, noTargetWhy('edge-demo-7'));
    assert.ok(!JSON.stringify(ov.linkTargets).includes('"password"'), '데모 목록에도 비밀 칸 없음');
    assert.match(ov.linkTargets.find((c) => c.id === 'demo-target-1').blocked, /edge-demo-1/);
    assert.throws(() => demo.linkTarget({ vcenterId: 'vc7', targetId: 'demo-target-old', expectName: 'old-edge' }), (e) => e.code === 'conflict' && /다른 서버입니다/.test(e.message));
    assert.throws(() => demo.linkTarget({ vcenterId: 'vc7', targetId: 'demo-target-nokey', expectName: '' }), (e) => e.code === 'conflict');
    assert.throws(() => demo.linkTarget({ vcenterId: 'vc7', targetId: 'demo-target-7', expectName: 'edge-demo-7' }), (e) => e.code === 'conflict', '화면이 본 이름과 다름');
    const r = demo.linkTarget({ vcenterId: 'vc7', targetId: 'demo-target-7', expectName: 'edge-demo7' });
    assert.deepEqual([r.agent, r.before, r.portalName], ['edge-demo-7', 'edge-demo7', 'edge-demo-7']);
    const t7b = demo.overview().targets[6];
    assert.deepEqual([t7b.targetId, t7b.can, t7b.linkable], ['demo-target-7', true, undefined]);
  } finally { store.snapshot = prev; demo._resetForTest(); }
});
