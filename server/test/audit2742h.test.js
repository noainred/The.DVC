/**
 * v2.742 GG 그룹 — GPU 게스트·엣지 배포 이름·정규식(감사 1회차).
 *
 *  VC-01   GPU 게스트 오버레이 독립 GC 가 30분 고정이라 폴 주기가 30분을 넘으면 수집 사이에 값이 사라지던 것
 *          (실제 store.js 의 GC 타이머를 mock 타이머로 돌린다 — 주기 60분이면 35분 뒤에도 값이 남아야 한다).
 *          guestWhy 의 엣지 '멈춤' 경계도 보고 주기를 알면 그 주기 × 3 으로 넓힌다(모르면 30분 그대로).
 *  INJPKG-08 게스트 파일 전송(PUT 업로드·GET 다운로드)이 3xx 를 따라가 평문 비밀번호 파일을 다른 곳으로 다시 보내던 것
 *          (가짜 ESXi HTTP 서버 + 실제 addGuestUser).
 *  LEFT-01 GPU 게스트 배포·엣지 배포 사용자: 읽기는 대소문자 무시, 쓰기는 글자 그대로라 빈 사본이 생기고 엣지가 그 사본을 받아
 *          VM 자격증명·관리 계정을 지우던 것(실제 저장 모듈 + 실제 centralRouter pull + 실제 엣지 병합 함수).
 *          로드 때 대소문자만 다른 중복 키를 하나로 합친다.
 *  INJPKG-06 로그 분석 규칙 gpu-guest-vc-collect-fail 의 무제한 뒤보기(O(n²)) — 예전 정규식과 결과 동일 + 비율로 속도 고정.
 *
 * 실행: node --test server/test/audit2742h.test.js
 */
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2742h-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'false';
process.env.CENTRAL_TOKEN = 'ctok-2742h'; // centralRouter pull 용(공유 토큰) — CENTRAL_URL 이 없으므로 이 프로세스는 중앙이다
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

// ── LEFT-01 로드 합치기 재현: 대소문자만 다른 중복 키가 든 파일을 모듈 로드 **전에** 둔다 ──
fs.writeFileSync(path.join(tmp, 'central-agent-gpu-guest.json'), JSON.stringify({
  'dup-x': { _updatedAt: 1000, enabled: true, pollIntervalMs: 60_000, vcenters: {
    vcA: { enabled: true, username: 'root', password: 'OLD-A', vms: {}, vmIps: {} },
    vcB: { enabled: true, username: 'root', password: 'OLD-B', vms: { 'vcB:vm-9': { username: 'u9', password: 'p9' } }, vmIps: {} },
  } },
  'Dup-X': { _updatedAt: 2000, enabled: true, pollIntervalMs: 60_000, vcenters: {
    vcA: { enabled: true, username: 'root2', password: 'NEW-A', vms: {}, vmIps: {} },
  } },
}));
fs.writeFileSync(path.join(tmp, 'central-agent-users.json'), JSON.stringify({
  'dup-u': { at: 1000, users: [{ username: 'ops1', name: 'Old', role: 'viewer' }, { username: 'ops2', name: 'Two', role: 'viewer' }] },
  'DUP-U': { at: 2000, users: [{ username: 'ops1', name: 'New', role: 'operator' }, { username: 'ops3', name: 'Three', role: 'viewer' }] },
}));

// ── VC-01: store.js 의 GC 타이머(setInterval 5분)를 mock 으로 잡기 위해 import 전에 타이머·시계를 바꾼다 ──
const T0 = 1_800_000_000_000;
mock.timers.enable({ apis: ['setInterval', 'Date'], now: T0 });
const st = await import('../src/gpu/store.js');
const { summarizeHostGpu } = await import('../src/gpu/hostGpu.js');
const { guestWhyOf } = await import('../src/gpu/guestWhy.js');

const MIN = 60_000;
const writeGpuSettings = (o) => fs.writeFileSync(path.join(tmp, 'gpu-guest.json'), JSON.stringify(o));
const oneVm = () => st.setGuestGpu({ vms: [{ vmId: 'vc1:vm-1', utilPct: 55, memUsedPct: 40, memUsedMB: 8000, memTotalMB: 20000, tempC: 61, gpus: 1, host: 'esx1', vcenterId: 'vc1' }] });

test('VC-01 ① 폴 주기 60분이면 독립 GC 가 35분 뒤에 오버레이를 지우지 않는다(호스트 요약 값이 남는다)', () => {
  try {
    st._resetGuestGpuForTest();
    writeGpuSettings({ enabled: true, pollIntervalMs: 60 * MIN });
    oneVm();
    assert.equal(st.guestGpuCounts().vms, 1);
    mock.timers.tick(35 * MIN); // 5분마다 도는 실제 GC 타이머가 일곱 번 돈다
    assert.equal(st.guestGpuCounts().vms, 1, '주기 60분 × 3 + 30초 안에는 지우면 안 된다(예전 30분 고정이면 여기서 0)');
    const host = { gpus: [{ model: 'NVIDIA A40', memGB: 45, mode: 'passthrough' }] };
    const vms = [{ id: 'vc1:vm-1', name: 'gpu-vm', powerState: 'POWERED_ON', gpu: { type: 'passthrough', count: 1 } }];
    const guestByVm = new Map(st.getGuestGpuVms().map((g) => [g.vmId, g]));
    const s = summarizeHostGpu(host, vms, guestByVm, { now: Date.now() });
    assert.equal(s.utilPct, 55); assert.equal(s.tempC, 61); assert.equal(s.vmsUnread, 0);
    assert.equal(guestWhyOf(s, { mode: 'direct', enabled: true, diagVc: { stage: '완료', results: [{ ok: true }] } }, { now: Date.now() }), null, '값이 있으면 사유를 내지 않는다');
    // 주기 × 3 + 30초(180.5분)를 넘으면 지운다 — 영원히 남기지는 않는다.
    mock.timers.tick(150 * MIN);
    assert.equal(st.guestGpuCounts().vms, 0, '3주기를 넘긴 항목은 지운다');
  } finally { /* 다음 하위 검사도 mock 시계를 쓴다 */ }
});

test('VC-01 ② 주기 60초(기본)면 예전처럼 30분 기본값 — 설정을 바꾸면 다음 GC 부터 바로 먹는다', () => {
  st._resetGuestGpuForTest();
  writeGpuSettings({ enabled: true, pollIntervalMs: 60_000 });
  oneVm();
  mock.timers.tick(35 * MIN);
  assert.equal(st.guestGpuCounts().vms, 0, '기본 주기에서는 30분 무갱신 항목을 예전처럼 지운다');
  // 주기를 2시간으로 바꾸면(모듈 재시작 없이) 다음 GC 가 넓힌 TTL 을 쓴다.
  oneVm();
  writeGpuSettings({ enabled: true, pollIntervalMs: 120 * MIN });
  mock.timers.tick(60 * MIN);
  assert.equal(st.guestGpuCounts().vms, 1, '설정 변경이 재시작 없이 다음 GC 에 반영돼야 한다');
  mock.timers.reset(); // 이후 검사는 실제 시계·타이머
});

test('VC-01 ③ guestGpuTtlMs·edgeReportStaleMs 순수 판정 — 모르면 넓히지 않는다', async () => {
  assert.equal(st.guestGpuTtlMs(null), st.GUEST_GPU_TTL_BASE_MS);
  assert.equal(st.guestGpuTtlMs(''), st.GUEST_GPU_TTL_BASE_MS);
  assert.equal(st.guestGpuTtlMs(60_000), 30 * MIN);
  assert.equal(st.guestGpuTtlMs(60 * MIN), 3 * 60 * MIN + 30_000);
  const gw = await import('../src/gpu/guestWhy.js');
  assert.equal(gw.edgeReportStaleMs(null), gw.EDGE_REPORT_STALE_MS);
  assert.equal(gw.edgeReportStaleMs(60_000), gw.EDGE_REPORT_STALE_MS);
  assert.equal(gw.edgeReportStaleMs(60 * MIN), 3 * 60 * MIN + 30_000);
  const now = 1_900_000_000_000;
  const s = { vmsOn: 1, vmsRead: 0, vmsUnread: 1 };
  const base = { mode: 'site', agent: 'edge-a', report: { receivedAt: now - 45 * MIN }, diagVc: { stage: '완료', results: [] } };
  assert.equal(gw.guestWhyOf(s, base, { now }).code, 'edge-stale', '주기를 모르면 30분 경계 그대로');
  assert.notEqual(gw.guestWhyOf(s, { ...base, reportIntervalMs: 60 * MIN }, { now }).code, 'edge-stale', '보고 주기 60분이면 45분 전 보고는 멈춤이 아니다');
  assert.equal(gw.guestWhyOf(s, { ...base, reportIntervalMs: 10 * MIN }, { now }).code, 'edge-stale', '주기 10분이면 기본 30분 경계');
});

// ── INJPKG-08 ──
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

test('INJPKG-08 게스트 파일 전송은 3xx 를 따라가지 않는다 — 평문 비밀번호 파일이 다른 곳으로 가지 않는다', async () => {
  const hits = { steal: [], stealOut: 0, up: 0, out: 0 };
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url.startsWith('/upok')) { res.writeHead(200); return res.end(); }
      if (req.url.startsWith('/up')) { hits.up++; res.writeHead(307, { Location: '/steal' }); return res.end(); }
      if (req.url.startsWith('/steal')) { hits.steal.push(body); res.writeHead(200); return res.end('ok'); }
      if (req.url.startsWith('/out')) { hits.out++; res.writeHead(302, { Location: '/stolen-out' }); return res.end(); }
      if (req.url.startsWith('/stolen-out')) { hits.stealOut++; res.writeHead(200); return res.end('SECRET-OUT'); }
      res.writeHead(404); res.end();
    });
  });
  const port = await listen(srv);
  try {
    const { addGuestUser } = await import('../src/gpu/guestops.js');
    const base = `http://127.0.0.1:${port}`;
    const c = {
      vc: { host: `127.0.0.1:${port}` },
      sc: { guestOperationsManager: 'gom' },
      retrieveObjectProps: async () => [{ props: { processManager: 'pm', fileManager: 'fm', authManager: 'am' } }],
      callRaw: async (xml) => {
        if (xml.includes('<InitiateFileTransferToGuest')) return `<returnval>${base}/up?id=1</returnval>`;
        if (xml.includes('<StartProgramInGuest')) return '<returnval>42</returnval>';
        if (xml.includes('<ListProcessesInGuest')) return '<returnval><endTime>x</endTime><exitCode>0</exitCode></returnval>';
        if (xml.includes('<InitiateFileTransferFromGuest')) return `<returnval><url>${base}/out?id=2</url><size>10</size></returnval>`;
        return '';
      },
    };
    let err = null;
    try { await addGuestUser(c, 'vm-1', { username: 'root', password: 'x' }, { username: 'bob', password: 'S3cret!pw', timeoutMs: 5000 }); }
    catch (e) { err = e; }
    assert.ok(hits.up >= 1, '업로드는 시도했다');
    assert.deepEqual(hits.steal, [], 'PUT 본문(비밀번호 파일)이 리다이렉트 대상으로 다시 가면 안 된다');
    assert.ok(err && /리다이렉트/.test(err.message), `업로드 실패 사유에 리다이렉트를 밝힌다: ${err?.message}`);
    // 다운로드(GET)도 3xx 를 따라가지 않는다 — 업로드는 성공시키고 결과 파일 URL 만 리다이렉트한다.
    const { runGuestScript } = await import('../src/gpu/guestops.js');
    const c2 = { ...c, callRaw: async (xml) => (xml.includes('<InitiateFileTransferToGuest') ? `<returnval>${base}/upok?id=3</returnval>` : c.callRaw(xml)) };
    const r = await runGuestScript(c2, 'vm-1', { username: 'root', password: 'x' }, 'echo hi\n', { timeoutMs: 3000 });
    assert.equal(hits.stealOut, 0, '결과 파일 GET 이 리다이렉트 대상으로 가면 안 된다');
    assert.ok(hits.out >= 1, '다운로드는 시도했다');
    assert.equal(r.stdout, '', '리다이렉트 대상의 본문을 결과로 쓰지 않는다');
  } finally { srv.close(); }
});

// ── LEFT-01 ──
test('LEFT-01 ① 로드 때 대소문자만 다른 중복 키를 가장 최근 것으로 합친다(빠진 vCenter·사용자는 옮긴다)', async () => {
  const gg = await import('../src/central/agentGpuGuestConfig.js');
  const keys = gg.listAssignedGpuGuestAgents().map((a) => a.agent).filter((a) => a.toLowerCase() === 'dup-x');
  assert.deepEqual(keys, ['Dup-X'], '중복 키는 하나로(가장 최근 저장분 키)');
  const s = gg.getAssignedGpuGuest('dup-x');
  assert.equal(s.vcenters.vcA.password, 'NEW-A', '겹친 vCenter 는 최근 값');
  assert.equal(s.vcenters.vcB.password, 'OLD-B', '최근 사본에 없던 vCenter 는 옮긴다');
  assert.equal(s.vcenters.vcB.vms['vcB:vm-9'].password, 'p9');
  const au = await import('../src/central/agentUsers.js');
  const ukeys = au.listAgentUserAgents().map((a) => a.agent).filter((a) => a.toLowerCase() === 'dup-u');
  assert.deepEqual(ukeys, ['DUP-U']);
  const users = au.getAgentUsers('dup-u');
  assert.deepEqual(users.map((u) => u.username).sort(), ['ops1', 'ops2', 'ops3'], '사용자는 합집합');
  assert.equal(users.find((u) => u.username === 'ops1').name, 'New', '같은 ID 는 최근 목록');
});

test('LEFT-01 ② 대소문자만 다른 이름으로 일부만 저장해도 사본이 생기지 않고, 엣지 pull 이 자격증명을 지우지 않는다(실제 centralRouter)', async () => {
  const gg = await import('../src/central/agentGpuGuestConfig.js');
  const gs = await import('../src/gpu/settings.js');
  const full = { enabled: true, vcenters: { vc1: { enabled: true, username: 'root', password: 'P1', vms: { 'vc1:vm-1': { username: 'u1', password: 'v1pw' }, 'vc1:vm-2': { username: 'u2', password: 'v2pw' } } } } };
  gg.setAssignedGpuGuest('edge-a', full);
  // 관리자가 등록부 표기 'Edge-A' 로 vm-1 계정만 고쳐 저장(예전에는 여기서 enabled·비밀번호·vm-2 가 빠진 새 사본이 생겼다)
  gg.setAssignedGpuGuest('Edge-A', { vcenters: { vc1: { vms: { 'vc1:vm-1': { username: 'u1', password: 'v1pw-new' } } } } });
  const keys = gg.listAssignedGpuGuestAgents().map((a) => a.agent).filter((a) => a.toLowerCase() === 'edge-a');
  assert.deepEqual(keys, ['edge-a'], '새 사본을 만들지 않는다');

  const express = (await import('express')).default;
  const { centralRouter } = await import('../src/routes/central.js');
  const app = express(); app.use(express.json()); app.use('/api/central', centralRouter);
  const srv = http.createServer(app); const port = await listen(srv);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/central/gpu-guest-config?agent=Edge-A`, { headers: { 'X-Central-Token': 'ctok-2742h', 'X-Agent-Name': 'Edge-A' } });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.assigned, true);
    assert.equal(body.settings.enabled, true, '수집 켜짐이 빠진 사본이 내려가면 안 된다');
    assert.equal(body.settings.vcenters.vc1.password, 'P1');
    assert.equal(body.settings.vcenters.vc1.vms['vc1:vm-1'].password, 'v1pw-new', '고친 값은 반영된다');
    // 엣지 쪽 실제 병합: 로컬(전체) 위에 받은 사본을 적용해도 vm-2 계정이 지워지지 않는다.
    const edgeLocal = gs.mergeGpuGuestSettings({}, full);
    const { next, removed } = gs.mergePulledGpuGuestSettings(edgeLocal, body.settings);
    assert.equal(removed.vms, 0, '엣지가 VM 자격증명을 지우면 안 된다(예전 재현: 1)');
    assert.equal(next.vcenters.vc1.vms['vc1:vm-2'].password, 'v2pw');
    assert.equal(next.enabled, true);

    // 배포 사용자 — 'edge-b' 에 둘, 'Edge-B' 로 추가·삭제
    const au = await import('../src/central/agentUsers.js');
    assert.equal(au.upsertAgentUser('edge-b', { username: 'opsa', role: 'operator', password: 'Passw0rd!x' }).ok, true);
    assert.equal(au.upsertAgentUser('edge-b', { username: 'opsb', role: 'viewer', password: 'Passw0rd!y' }).ok, true);
    assert.equal(au.upsertAgentUser('Edge-B', { username: 'opsc', role: 'viewer', password: 'Passw0rd!z' }).ok, true);
    assert.deepEqual(au.listAgentUserAgents().map((a) => a.agent).filter((a) => a.toLowerCase() === 'edge-b'), ['edge-b'], '사용자 목록도 사본을 만들지 않는다');
    const ru = await fetch(`http://127.0.0.1:${port}/api/central/users-config?agent=Edge-B`, { headers: { 'X-Central-Token': 'ctok-2742h', 'X-Agent-Name': 'Edge-B' } });
    assert.equal(ru.status, 200);
    const ub = await ru.json();
    assert.deepEqual(ub.users.map((u) => u.username).sort(), ['opsa', 'opsb', 'opsc'], '엣지가 받는 목록에서 기존 관리 계정이 빠지면 엣지가 지운다(예전 재현: opsc 하나)');
    const rm = au.removeAgentUser('Edge-B', 'opsb');
    assert.equal(rm.ok, true, `'Edge-B' 이름으로도 삭제된다(예전: 없는 agent) ${rm.reason || ''}`);
    assert.deepEqual(au.getAgentUsers('edge-b').map((u) => u.username).sort(), ['opsa', 'opsc']);
    const bulk = au.upsertAgentUsersBulk(['edge-b', 'EDGE-B'], { username: 'opsd', role: 'viewer', password: 'Passw0rd!w' });
    assert.deepEqual(bulk.applied, ['edge-b'], '대소문자만 다른 대상은 한 번만 적용·보고');
  } finally { srv.close(); }
});

test('LEFT-01 ③ 배포 대상 후보 목록은 대소문자를 무시하고 한 줄로(실제 admin 라우트)', async () => {
  const express = (await import('express')).default;
  const { registerGpuGuest, caseFoldNames } = await import('../src/routes/admin/gpuGuest.js');
  const diag = await import('../src/central/gpuGuestDiag.js');
  diag.setGpuGuestDiag('EDGE-A', { at: Date.now(), vcenters: [] }, {}, { verified: true });
  diag.setGpuGuestDiag('Edge-B', { at: Date.now(), vcenters: [] }, {}, { verified: true });
  const m = caseFoldNames([['edge-a'], ['Edge-A', 'x'], ['EDGE-A']]);
  assert.deepEqual([...m.values()], ['edge-a', 'x'], '먼저 본 표기 하나');
  const router = express.Router(); registerGpuGuest(router);
  const app = express(); app.use(express.json()); app.use('/api/admin', router);
  const srv = http.createServer(app); const port = await listen(srv);
  try {
    const g = await (await fetch(`http://127.0.0.1:${port}/api/admin/gpu-guest/deploy/agents`)).json();
    const rows = g.agents.filter((a) => a.agent.toLowerCase() === 'edge-a');
    assert.equal(rows.length, 1, `한 줄: ${JSON.stringify(rows)}`);
    assert.equal(rows[0].agent, 'edge-a', '저장된 키 표기');
    assert.equal(rows[0].assigned, true, '배정 여부도 대소문자 무시');
    const u = await (await fetch(`http://127.0.0.1:${port}/api/admin/edge-users/agents`)).json();
    const urows = u.agents.filter((a) => a.agent.toLowerCase() === 'edge-b');
    assert.equal(urows.length, 1);
    assert.ok(urows[0].users >= 2, '사용자 수도 저장 키에서 읽는다');
  } finally { srv.close(); }
});

// ── INJPKG-06 ──
test('INJPKG-06 gpu-guest-vc-collect-fail: 예전 뒤보기 정규식과 결과(캡처) 동일 + 긴 줄에서 선형', async () => {
  const { CATALOG_RULES } = await import('../src/loganalysis/catalog.js');
  const rule = CATALOG_RULES.find((r) => r.id === 'gpu-guest-vc-collect-fail');
  const NEW = new RegExp(rule.re);
  const OLD = /(?<!✗.*)(\S+) 수집 실패: /;
  assert.ok(!/\(\?<!✗\.\*\)/.test(rule.re), '무제한 뒤보기를 쓰지 않는다');
  const cap = (re, s) => { const m = re.exec(s); return m ? m[1] : null; };
  const fixed = [
    rule.sample,
    '[gpu-guest] vc-a 수집 실패: x',
    '[gpu-guest]   ✗ gpu-vm-01: SSH 수집 실패: SSH 인증 실패',
    'vc✗a 수집 실패: y', 'a ✗ b 수집 실패: ', '✗', '', ' 수집 실패: ', 'x  수집 실패: ', 'a\n✗ b 수집 실패: \nc 수집 실패: ',
    'p 수집 실패: q 수집 실패: ', '✗a\nb 수집 실패: ', 'b 수집 실패:', 'aa b 수집 실패: ',
  ];
  for (const s of fixed) assert.equal(cap(NEW, s), cap(OLD, s), JSON.stringify(s));
  // 결정적 난수 대조
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const parts = ['✗', ' ', 'a', 'vc-1', ' 수집 실패: ', '\n', 'x', '수집', ' 실패:', '\t', ' '];
  for (let i = 0; i < 3000; i++) {
    let s = ''; const n = 1 + Math.floor(rnd() * 12);
    for (let j = 0; j < n; j++) s += parts[Math.floor(rnd() * parts.length)];
    assert.equal(cap(NEW, s), cap(OLD, s), JSON.stringify(s));
  }
  // 속도: 메시지 상한(2,000자) 줄 — 비율로 본다(절대 시간은 CPU 에 따라 다르다).
  const long = '[gpu-guest] ' + '실패 '.repeat(660);
  const time = (re) => { const t0 = process.hrtime.bigint(); for (let k = 0; k < 20; k++) re.exec(long); return Number(process.hrtime.bigint() - t0) / 1e6; };
  time(OLD); time(NEW);
  const tOld = time(OLD); const tNew = time(NEW);
  assert.ok(tNew * 5 < tOld || tOld < 5, `새 정규식이 훨씬 빨라야 한다(old ${tOld.toFixed(1)}ms · new ${tNew.toFixed(1)}ms)`);
});
