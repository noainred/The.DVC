/**
 * test/audit2744rh.test.js — v2.744 회귀 검토 수정 그룹 RH(서버 쪽).
 *
 *  · GI-R2  GPU 게스트 배포 '대소문자 합침' 표지(행 folded · 응답 foldReport.groups)가 관리자가 그 엣지를 고쳐 저장한 뒤에도 중앙을
 *           재시작할 때까지 남았다 — 화면 문구는 '확인하고 필요하면 고쳐 저장하세요' 인데 저장해도 표지가 그대로라 저장이 먹지 않은 것처럼
 *           보였다(_foldReport 는 모듈 로드 때 한 번 정해지고 setAssignedGpuGuest 가 지우지 않았다). 이제 그 키의 저장이 **디스크에 성공한 뒤**
 *           그룹을 groups 에서 빼고 resolved 에 '언제 저장으로 확인됐는지' 만 남긴다. 쓰기가 실패하면 표지를 남긴다.
 *           실제 라우터(GET·PUT /gpu-guest/deploy/…)로 본다 — 대소문자가 다른 이름으로 저장해도 같은 키다(v2.742 LEFT-01).
 *  · GI-R3  audit2744i.test.js 가 임시 폴더를 세션 스크래치 경로로 박고, 없으면 cwd/../.. 에 만들었다(저장소 루트에서 실행하면 /home 에
 *           mkdtemp → EACCES 로 파일 전체 실패, server/ 에서 실행하면 저장소 밖에 쓰기). os.tmpdir() 의 mkdtemp 로 바꿨는지 소스로 본다.
 *
 * 실행: node --test --experimental-sqlite server/test/audit2744rh.test.js
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripComments } from './_stripComments.js';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2744rh-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.AUTH_ENABLED = 'false';
delete process.env.CENTRAL_URL;
fs.writeFileSync(path.join(DIR, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));

const FILE = path.join(DIR, 'central-agent-gpu-guest.json');
// 모듈 로드 **전에** 대소문자 중복 사본 두 쌍을 둔다(로드가 합친다) — edge-x 는 저장으로 확인하고, edge-y 는 쓰기 실패·미저장 대조군.
fs.writeFileSync(FILE, JSON.stringify({
  'edge-x': { enabled: true, pollIntervalMs: 300_000, vcenters: { vc1: { enabled: true, username: 'root', password: 'pw-x-rh', vms: {}, vmIps: {} } }, _updatedAt: 1000 },
  'Edge-X': { enabled: false, vcenters: {}, _updatedAt: 2000 },
  'edge-y': { enabled: true, vcenters: { vc1: { enabled: true, username: 'root', password: 'pw-y-rh', vms: {}, vmIps: {} } }, _updatedAt: 1000 },
  'EDGE-Y': { enabled: false, vcenters: {}, _updatedAt: 2000 },
}));

const closers = [];
after(async () => {
  for (const c of closers.reverse()) { try { await c(); } catch { /* */ } }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ }
});

const express = (await import('express')).default;
const { registerGpuGuest } = await import('../src/routes/admin/gpuGuest.js');
const gg = await import('../src/central/agentGpuGuestConfig.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = { username: 'admin', role: 'admin', scope: null }; next(); });
const r = express.Router();
registerGpuGuest(r);
app.use('/api/admin', r);
// 동기 throw(쓰기 실패)는 express 가 잡아 이 처리기로 온다 — 500 으로 답한다.
app.use((err, _req, res, _next) => { res.status(500).json({ ok: false, reason: String(err?.message || err) }); });
const srv = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
closers.push(() => new Promise((ok) => { srv.closeAllConnections?.(); srv.close(ok); }));
const BASE = `http://127.0.0.1:${srv.address().port}/api/admin`;

const agentsList = async () => {
  const res = await fetch(`${BASE}/gpu-guest/deploy/agents`);
  assert.equal(res.status, 200);
  return res.json();
};
const rowOf = (body, name) => body.agents.find((a) => a.agent.toLowerCase() === name);
const groupOf = (body, name) => (body.foldReport?.groups || []).find((g) => String(g.kept).toLowerCase() === name) || null;
const put = (agent, payload) => fetch(`${BASE}/gpu-guest/deploy/${encodeURIComponent(agent)}`, {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
});

test('GI-R2 ① 로드 직후: 두 쌍 모두 합침 표지가 있다(행 folded + foldReport.groups)', async () => {
  const body = await agentsList();
  for (const n of ['edge-x', 'edge-y']) {
    assert.ok(rowOf(body, n)?.folded, `${n}: 합친 행 표지 ${JSON.stringify(rowOf(body, n))}`);
    assert.ok(groupOf(body, n), `${n}: foldReport 그룹 ${JSON.stringify(body.foldReport)}`);
  }
  assert.equal(typeof body.foldReport.at, 'number', '합친 때(at)를 싣는다 — 화면이 기동 때의 일임을 밝힌다');
});

test('GI-R2 ② 쓰기가 실패한 저장은 표지를 내리지 않는다(확인된 것이 아니다)', async () => {
  // 설정 파일 자리를 비어 있지 않은 디렉터리로 바꿔 원자 쓰기(rename)를 실패시킨다.
  fs.rmSync(FILE, { force: true });
  fs.mkdirSync(FILE);
  fs.writeFileSync(path.join(FILE, 'block'), 'x');
  try {
    const res = await put('edge-y', { enabled: true });
    assert.equal(res.status, 500, '쓰기 실패는 성공으로 답하지 않는다');
    const body = await agentsList();
    assert.ok(rowOf(body, 'edge-y')?.folded, `쓰기 실패 뒤에도 edge-y 표지는 남는다: ${JSON.stringify(rowOf(body, 'edge-y'))}`);
    assert.ok(groupOf(body, 'edge-y'), 'foldReport 그룹도 남는다');
    assert.ok(!(body.foldReport.resolved || []).some((x) => x.kept.toLowerCase() === 'edge-y'), 'resolved 에 들어가지 않는다');
  } finally {
    fs.rmSync(FILE, { recursive: true, force: true });
  }
});

test('GI-R2 ③ 관리자가 그 엣지를 저장하면(대소문자가 다른 이름으로도) 표지가 곧바로 사라지고 resolved 에 시각이 남는다 · 다른 그룹은 그대로', async () => {
  const t0 = Date.now();
  const res = await put('Edge-X', { enabled: true });
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(FILE, 'utf8'))).filter((k) => k.toLowerCase() === 'edge-x'), ['edge-x'],
    '저장은 기존 키 하나로 쓴다(v2.742 LEFT-01)');
  const body = await agentsList();
  assert.equal(rowOf(body, 'edge-x')?.folded, undefined, `저장 뒤 edge-x 행에 합침 표지가 없다: ${JSON.stringify(rowOf(body, 'edge-x'))}`);
  assert.equal(groupOf(body, 'edge-x'), null, 'foldReport.groups 에서도 빠진다');
  const rs = (body.foldReport?.resolved || []).find((x) => x.kept.toLowerCase() === 'edge-x');
  assert.ok(rs, `resolved 에 남는다: ${JSON.stringify(body.foldReport)}`);
  assert.ok(rs.at >= t0, '저장으로 확인된 시각');
  assert.deepEqual(rs.dropped, ['Edge-X'], '어떤 이름을 합쳤는지는 남긴다');
  // 저장하지 않은 edge-y 는 그대로다.
  assert.ok(rowOf(body, 'edge-y')?.folded, '다른 엣지의 표지는 그대로');
  assert.ok(groupOf(body, 'edge-y'));
  // 상태 함수(모듈)도 같은 사실을 말한다.
  const st = gg.gpuGuestFoldStatus();
  assert.ok(!st.groups.some((g) => g.kept.toLowerCase() === 'edge-x'));
  assert.ok(st.resolved.some((g) => g.kept.toLowerCase() === 'edge-x'));
  const txt = JSON.stringify(body);
  for (const secret of ['pw-x-rh', 'pw-y-rh']) assert.ok(!txt.includes(secret), `비밀번호 값을 싣지 않는다: ${secret}`);
});

test('GI-R2 ④ 마지막 그룹까지 저장하면 groups 는 비고 표지는 하나도 없다', async () => {
  const res = await put('edge-y', { enabled: true });
  assert.equal(res.status, 200);
  const body = await agentsList();
  assert.ok(!body.agents.some((a) => a.folded), `합침 표지가 남은 행이 없다: ${JSON.stringify(body.agents)}`);
  assert.deepEqual(body.foldReport?.groups || [], []);
  assert.deepEqual((body.foldReport?.resolved || []).map((x) => x.kept.toLowerCase()).sort(), ['edge-x', 'edge-y']);
});

test('GI-R3 audit2744i.test.js 는 세션 스크래치 경로를 박지 않고 os.tmpdir() 의 mkdtemp 를 쓴 뒤 지운다', () => {
  const src = stripComments(fs.readFileSync(new URL('./audit2744i.test.js', import.meta.url), 'utf8'));
  assert.ok(!/\/tmp\/claude-/.test(src), '세션 스크래치 경로가 남아 있다');
  assert.ok(!/process\.cwd\(\)\s*,\s*'\.\.'/.test(src), 'cwd 상위 폴더에 만들지 않는다');
  assert.match(src, /mkdtempSync\(\s*path\.join\(\s*os\.tmpdir\(\)\s*,\s*'audit2744i-'\s*\)\s*\)/);
  assert.match(src, /rmSync\(\s*DIR\s*,\s*\{\s*recursive:\s*true\s*,\s*force:\s*true\s*\}\s*\)/, 'after 에서 지운다');
});
