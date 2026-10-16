/**
 * v2.743 GC 그룹 — GPU 게스트 배포 사본 합치기 · 엣지 오버레이 정리(감사 2회차).
 *
 *  RECENT-01 v2.742 의 대소문자 중복 접기(foldCaseDuplicateGpuGuest)가 _updatedAt 이 큰 사본을 **통째로** 남겨, 예전 결함(빈 바탕 {} 위
 *            부분 저장)이 만든 사본이 이기면 정확한 이름의 엣지가 수집 끔·공용 계정 비움·VM 계정 삭제를 당하던 것.
 *            모듈 로드 **전에** 중복이 든 파일을 두고 실제 로드 → 실제 centralRouter pull → 실제 엣지 병합(mergePulledGpuGuestSettings)까지 본다.
 *            ① 이름 근거 없음 → 먼저 있던 키 · 값은 필드 단위(빈 바탕 기본값이면 옛 값, VM 계정·고정 IP 합집합)
 *            ② 엣지 실제 이름 = 옛 키(등록부) · 최근 사본의 기본값 아닌 값은 이긴다
 *            ③ 근거 순서 — 인증된 이름(개별 토큰) > 등록부 이름 > 먼저 있던 키
 *            ④ 계정이 바뀌고 비밀번호가 비면 승계하지 않는다(v2.611) · 상태·목록 행이 합친 사실을 말한다
 *            ⑤ 순수 함수 — 사본 셋·객체 아닌 사본·null VM 계정(지움 표식)을 패치로 넘기지 않는다
 *  LEFT-02   GPU 폴러의 pruneGuestGpu(이 노드 주기 × 3 + 30초)가 엣지 push 항목까지 지우던 것 — 실제 pollGpuGuestOnce 를 부른다.
 *            엣지 항목은 독립 GC 가 그 엣지 주기(max(30분, 주기 × 3 + 30초))로만 지운다.
 *
 * 실행: node --test server/test/audit2743c.test.js
 */
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2743c-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'live';
process.env.AUTH_ENABLED = 'false';
process.env.CENTRAL_TOKEN = 'ctok-2743c'; // centralRouter pull 용(공유 토큰) — CENTRAL_URL 이 없으므로 이 프로세스는 중앙이다
fs.writeFileSync(path.join(tmp, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

const gs = await import('../src/gpu/settings.js'); // 중앙 배포 파일을 읽지 않는다 — 픽스처를 실제 병합 함수로 만든다

// ── 픽스처: v2.741 까지의 실제 저장 경로가 만든 모양 ──
// 온전한 배포(엣지 실제 이름 'edge-a').
const complete = () => gs.mergeGpuGuestSettings({}, {
  enabled: true, pollIntervalMs: 300_000, concurrency: 8, collectMethod: 'ssh',
  vcenters: {
    vc1: { enabled: true, username: 'root', password: 'pw-shared', winUsername: 'Administrator', winPassword: 'wpw',
      vms: { 'vc1:vm-1': { username: 'u1', password: 'p1' }, 'vc1:vm-2': { username: 'u2', password: 'p2' } },
      vmIps: { 'vc1:vm-1': '10.0.0.5' } },
    vc2: { enabled: true, username: 'gpu', password: 'pw-2', vms: {}, vmIps: {} },
  },
});
// v2.741 결함: 'Edge-A' 행에서 VM 계정만 고쳐 저장(VmCredManager 가 보내는 모양) → const cur = byAgent['Edge-A'] || {} 위에 새 사본.
const partial = () => gs.mergeGpuGuestSettings({}, { vcenters: { vc1: {
  vms: { 'vc1:vm-1': { username: 'u1', password: 'p1-new' }, 'vc1:vm-3': { username: 'u3', password: 'p3' } },
  vmIps: { 'vc1:vm-3': '10.0.0.9' },
} } });
const at = (o, t) => Object.assign(o, { _updatedAt: t });

fs.writeFileSync(path.join(tmp, 'central-agent-gpu-guest.json'), JSON.stringify({
  // ① 근거 없음 — 빈 바탕 부분 사본이 더 최근
  'edge-a': at(complete(), 1000), 'Edge-A': at(partial(), 2000),
  // ② 엣지 실제 이름 = 옛 키(등록부 'site-c') — 최근 사본은 온전한 사본이고 공용 비밀번호를 바꿨다
  'site-c': at(complete(), 1000),
  'SITE-C': at(gs.mergeGpuGuestSettings({}, { enabled: true, vcenters: { vc1: { enabled: true, username: 'root', password: 'pw-NEW' } } }), 2000),
  // ③ 근거가 최근 키를 가리킴(등록부 'edge-d') · 인증된 이름(토큰 'Edge-E')이 등록부('edge-e')보다 먼저
  'Edge-D': at(complete(), 1000), 'edge-d': at(partial(), 2000),
  'Edge-E': at(complete(), 1000), 'edge-e': at(partial(), 2000),
  // ④ 계정이 바뀌고 비밀번호가 비었다(빈 바탕 사본) — 옛 비밀번호를 새 계정에 승계하지 않는다
  'acct-f': at(complete(), 1000),
  'ACCT-F': at(gs.mergeGpuGuestSettings({}, { vcenters: { vc1: { username: 'admin2' } } }), 2000),
}));
fs.writeFileSync(path.join(tmp, 'collectors.json'), JSON.stringify({ collectors: [
  { id: 'site-c', name: 'site-c', url: 'https://10.9.0.3:4000', token: 't' },
  { id: 'edge-d', name: 'edge-d', url: 'https://10.9.0.4:4000', token: 't' },
  { id: 'edge-e', name: 'edge-e', url: 'https://10.9.0.5:4000', token: 't' },
] }));
fs.writeFileSync(path.join(tmp, 'central-agent-tokens.json'), JSON.stringify({ tokens: [{ agent: 'Edge-E', hash: '00'.repeat(32), createdAt: 1 }] }));

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const gg = await import('../src/central/agentGpuGuestConfig.js');
const keysOf = (lo) => gg.listAssignedGpuGuestAgents().map((a) => a.agent).filter((a) => a.toLowerCase() === lo);

test('RECENT-01 ① 근거 없음: 먼저 있던 키를 남기고, 빈 바탕 부분 사본의 기본값은 옛 값을 지우지 않는다(실제 pull + 엣지 병합)', async () => {
  assert.deepEqual(keysOf('edge-a'), ['edge-a'], '이름 근거가 없으면 먼저 있던(옛) 키 — v2.742 는 최근 키 Edge-A 를 남겼다');
  const s = gg.getAssignedGpuGuest('edge-a');
  assert.equal(s.enabled, true, '최상위 수집 켜짐이 빈 바탕 기본값(false)에 지워지면 안 된다');
  assert.equal(s.pollIntervalMs, 300_000, '주기도 옛 값');
  assert.equal(s.concurrency, 8);
  assert.equal(s.collectMethod, 'ssh', '수집 방식도 옛 값');
  assert.equal(s.vcenters.vc1.enabled, true, '겹친 vCenter 의 켜짐이 빈 바탕 기본값에 지워지면 안 된다');
  assert.equal(s.vcenters.vc1.username, 'root');
  assert.equal(s.vcenters.vc1.password, 'pw-shared', '공용 비밀번호를 비우면 안 된다');
  assert.equal(s.vcenters.vc1.winPassword, 'wpw');
  assert.deepEqual(Object.keys(s.vcenters.vc1.vms).sort(), ['vc1:vm-1', 'vc1:vm-2', 'vc1:vm-3'], 'VM 계정은 합집합');
  assert.equal(s.vcenters.vc1.vms['vc1:vm-1'].password, 'p1-new', '같은 VM 은 최근 것');
  assert.equal(s.vcenters.vc1.vms['vc1:vm-2'].password, 'p2', '최근 사본에 없던 VM 계정은 남는다');
  assert.deepEqual(s.vcenters.vc1.vmIps, { 'vc1:vm-1': '10.0.0.5', 'vc1:vm-3': '10.0.0.9' }, '고정 IP 도 합집합');
  assert.equal(s.vcenters.vc2.password, 'pw-2', '최근 사본에 없던 vCenter 는 옮긴다');
  assert.equal(s._updatedAt, 2000, '수정 시각은 가장 최근 것');

  const express = (await import('express')).default;
  const { centralRouter } = await import('../src/routes/central.js');
  const app = express(); app.use(express.json()); app.use('/api/central', centralRouter);
  const srv = http.createServer(app); const port = await listen(srv);
  try {
    for (const name of ['edge-a', 'Edge-A']) { // 엣지 실제 이름이 어느 표기든 같은 사본
      const r = await fetch(`http://127.0.0.1:${port}/api/central/gpu-guest-config?agent=${name}`, { headers: { 'X-Central-Token': 'ctok-2743c', 'X-Agent-Name': name } });
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.equal(body.assigned, true);
      // 엣지가 v2.741 까지 받던 온전한 사본 위에 지금 사본을 적용한다(실제 엣지 병합 함수).
      const { next, removed } = gs.mergePulledGpuGuestSettings(complete(), body.settings);
      assert.equal(removed.vms, 0, `${name}: 엣지가 VM 자격증명을 지우면 안 된다(v2.742 재현: 2)`);
      assert.equal(removed.vmIps, 0, `${name}: 고정 IP 를 지우면 안 된다(v2.742 재현: 1)`);
      assert.equal(next.enabled, true, `${name}: 엣지 GPU 게스트 수집 전체가 꺼지면 안 된다`);
      assert.equal(next.vcenters.vc1.enabled, true);
      assert.equal(next.vcenters.vc1.password, 'pw-shared');
      assert.equal(next.pollIntervalMs, 300_000);
      assert.equal(next.collectMethod, 'ssh');
      assert.equal(next.vcenters.vc1.vms['vc1:vm-3'].password, 'p3', '고친 값은 반영된다');
    }
  } finally { srv.close(); }
});

test('RECENT-01 ② 엣지 실제 이름 = 옛 키(등록부) — 그 키를 남기고, 최근 사본의 기본값이 아닌 값은 이긴다', () => {
  assert.deepEqual(keysOf('site-c'), ['site-c'], '등록부 이름과 글자 그대로 같은 키(v2.742 는 최근 키 SITE-C)');
  const s = gg.getAssignedGpuGuest('SITE-C');
  assert.equal(s.vcenters.vc1.password, 'pw-NEW', '최근 사본이 명시한 값(기본값 아님)은 최근 것');
  assert.equal(s.enabled, true);
  assert.equal(s.pollIntervalMs, 300_000, '최근 사본의 주기는 기본값이라 옛 값을 유지');
  assert.deepEqual(Object.keys(s.vcenters.vc1.vms).sort(), ['vc1:vm-1', 'vc1:vm-2'], '최근 사본에 VM 계정이 없어도 옛 계정은 남는다');
  assert.equal(s.vcenters.vc2.password, 'pw-2');
});

test('RECENT-01 ③ 남길 키의 근거 순서 — 인증된 이름 > 등록부 이름 > 먼저 있던 키(값 합치기는 키와 무관)', () => {
  assert.deepEqual(keysOf('edge-d'), ['edge-d'], '등록부 이름이 최근 키를 가리키면 그 키(근거가 먼저 — 먼저 있던 키가 아니다)');
  assert.deepEqual(keysOf('edge-e'), ['Edge-E'], '개별 토큰 이름(인증)이 등록부 이름보다 먼저');
  for (const k of ['edge-d', 'edge-e']) {
    const s = gg.getAssignedGpuGuest(k);
    assert.equal(s.enabled, true, `${k}: 키가 최근 사본의 것이어도 값은 필드 단위로 합친다`);
    assert.equal(s.vcenters.vc1.password, 'pw-shared');
    assert.deepEqual(Object.keys(s.vcenters.vc1.vms).sort(), ['vc1:vm-1', 'vc1:vm-2', 'vc1:vm-3']);
  }
});

test('RECENT-01 ④ 계정이 바뀌고 비밀번호가 비었으면 승계하지 않는다 · 합친 사실을 상태와 목록 행이 말한다(값은 싣지 않는다)', () => {
  const s = gg.getAssignedGpuGuest('acct-f');
  assert.equal(s.vcenters.vc1.username, 'admin2', '최근 사본이 명시한 계정명');
  assert.equal(s.vcenters.vc1.password, '', '다른 계정에 옛 비밀번호를 붙이지 않는다(v2.611 — 계정 잠금 위험)');
  assert.equal(s.vcenters.vc1.enabled, true, '켜짐은 빈 바탕 기본값이라 옛 값');

  const st = gg.gpuGuestFoldStatus();
  assert.ok(st && Array.isArray(st.groups), '로드 때 합친 결과가 상태에 남는다');
  const g = (k) => st.groups.find((x) => x.kept === k);
  assert.deepEqual(g('edge-a').dropped, ['Edge-A']);
  assert.equal(g('edge-a').keptBy, 'older');
  assert.equal(g('site-c').keptBy, 'registry');
  assert.equal(g('Edge-E').keptBy, 'authenticated');
  for (const p of ['enabled', 'pollIntervalMs', 'collectMethod', 'vcenters.vc1.enabled', 'vcenters.vc1.password', 'vcenters.vc1.vms.vc1:vm-2']) {
    assert.ok(g('edge-a').keptOlder.includes(p), `옛 값을 유지한 항목 경로에 ${p}: ${JSON.stringify(g('edge-a').keptOlder)}`);
  }
  assert.deepEqual(g('edge-a').vcentersFromOlder, ['vc2']);
  assert.deepEqual(g('acct-f').droppedSecrets, ['password']);
  const row = gg.listAssignedGpuGuestAgents().find((a) => a.agent === 'edge-a');
  assert.deepEqual(row.folded.from, ['Edge-A']);
  assert.equal(row.folded.by, 'older');
  assert.ok(row.folded.keptOlder >= 6);
  assert.ok(!JSON.stringify(st).includes('pw-shared') && !JSON.stringify(row).includes('pw-shared'), '상태·목록에 비밀번호 값을 싣지 않는다');
  const plain = gg.listAssignedGpuGuestAgents().find((a) => a.agent === 'Edge-E');
  assert.equal(plain.folded.by, 'authenticated');
});

test('RECENT-01 ⑤ 순수 함수: 사본 셋은 시간 순서로 · 객체 아닌 사본은 건너뛴다 · null VM 계정(지움 표식)을 넘기지 않는다', () => {
  const a = at(complete(), 100);
  const b = at(gs.mergeGpuGuestSettings({}, { vcenters: { vc1: { vms: { 'vc1:vm-2': { username: 'u2', password: 'p2-b' } } } } }), 300);
  const c = at(gs.mergeGpuGuestSettings({}, { enabled: true, collectMethod: 'guestops', vcenters: { vc1: { vms: { 'vc1:vm-2': { username: 'u2', password: 'p2-c' } } } } }), 200);
  const { map, merged } = gg.foldCaseDuplicateGpuGuest({ ab: a, AB: b, Ab: c, aB: null });
  const keys = Object.keys(map).filter((k) => k.toLowerCase() === 'ab');
  assert.deepEqual(keys, ['ab'], '근거가 없으면 가장 먼저 있던 사본의 키(객체 아닌 사본은 시각 0 이라도 값으로 쓰지 않는다)');
  const s = map[keys[0]];
  assert.equal(s.vcenters.vc1.vms['vc1:vm-2'].password, 'p2-b', '가장 늦은(300) 사본이 마지막에 얹힌다');
  assert.equal(s.collectMethod, 'guestops', '중간(200) 사본의 기본값 아닌 값도 남는다(뒤 사본이 기본값이면)');
  assert.equal(s.vcenters.vc1.password, 'pw-shared');
  assert.deepEqual(merged.find((m) => m.kept === 'ab').dropped.sort(), ['AB', 'Ab', 'aB'], '버린 키는 전부 밝힌다');
  // 손으로 고친 파일의 null VM 계정은 '지움' 표식이다 — 패치로 넘겨 옛 계정을 지우면 안 된다.
  const withNull = at(gs.mergeGpuGuestSettings({}, {}), 500); withNull.vcenters = { vc1: { vms: { 'vc1:vm-1': null }, vmIps: { 'vc1:vm-1': '' } } };
  const f2 = gg.foldCaseDuplicateGpuGuest({ 'y-1': at(complete(), 100), 'Y-1': withNull }, {});
  const s2 = Object.values(f2.map)[0];
  assert.equal(s2.vcenters.vc1.vms['vc1:vm-1'].password, 'p1', 'null 은 패치로 넘기지 않는다');
  assert.equal(s2.vcenters.vc1.vmIps['vc1:vm-1'], '10.0.0.5', '빈 고정 IP 도 지움으로 넘기지 않는다');
  // 패치 자체: 기본값·빈 문자열은 빠진다.
  const p = gs.gpuGuestNonDefaultPatch(partial());
  assert.equal(p.enabled, undefined); assert.equal(p.pollIntervalMs, undefined); assert.equal(p.collectMethod, undefined);
  assert.equal(p.vcenters.vc1.enabled, undefined); assert.equal(p.vcenters.vc1.username, undefined); assert.equal(p.vcenters.vc1.password, undefined);
  assert.deepEqual(Object.keys(p.vcenters.vc1.vms).sort(), ['vc1:vm-1', 'vc1:vm-3']);
});

// ── LEFT-02 ──
// 폴러는 엣지 위임(site) vCenter 하나만 대상이라 로그인 없이 정리 단계까지 간다(직접 수집 판정 — v2.733 C4-01).
fs.writeFileSync(path.join(tmp, 'vcenters.json'), JSON.stringify({ vcenters: [
  { id: 'vc-site', name: 'site', host: 'https://10.9.9.9', username: 'u', password: 'x', collectMode: 'site', remoteAgent: 'edge-x' },
] }));
const MIN = 60_000;
const writeGpu = (o) => fs.writeFileSync(path.join(tmp, 'gpu-guest.json'), JSON.stringify(o));

test('LEFT-02 ① 실제 폴러 정리(이 노드 주기 × 3 + 30초)는 로컬 항목만 지운다 — 엣지 push 항목은 엣지 TTL 안에서 남는다', async () => {
  const T0 = 1_900_000_000_000;
  mock.timers.enable({ apis: ['Date'], now: T0 });
  try {
    const st = await import('../src/gpu/store.js');
    const poller = await import('../src/gpu/poller.js');
    const diag = await import('../src/central/gpuGuestDiag.js');
    st._resetGuestGpuForTest(); diag._resetGpuGuestDiagForTest();
    writeGpu({ enabled: true, pollIntervalMs: 10_000, vcenters: { 'vc-site': { enabled: true, username: 'g', password: 'p' } } }); // 폴러 정리 경계 60초
    st.setGuestGpu({ vms: [{ vmId: 'vc-site:vm-e', utilPct: 50, host: 'esx1', vcenterId: 'vc-site' }], hosts: [{ hostId: 'vc-site:host-1', utilPct: 50 }], agent: 'edge-x', verified: true });
    st.setGuestGpu({ vms: [{ vmId: 'vc-local:vm-l', utilPct: 30, host: 'esx2', vcenterId: 'vc-local' }] }); // 로컬 폴러 항목(agent 없음)
    mock.timers.tick(5 * MIN); // 엣지 push 간격(예: AGENT_INVENTORY_INTERVAL_MS 5분)만큼 다음 push 가 안 왔다
    await poller.pollGpuGuestOnce();
    const vms = st.getGuestGpuVms().map((v) => v.vmId).sort();
    assert.deepEqual(vms, ['vc-site:vm-e'], `폴러 정리는 로컬 항목만(예전: 엣지 항목까지 지워 []) — ${JSON.stringify(vms)}`);
    assert.ok(st.getGuestGpuHost('vc-site:host-1'), '엣지 호스트 항목도 남는다');
    // 독립 GC: 엣지 주기를 모르면 이 노드 주기 기준(max(30분, 10초 × 3 + 30초) = 30분) — 25분 뒤(누적 30분 미만)에는 남고, 그 뒤에는 지운다.
    mock.timers.tick(20 * MIN);
    st.runGuestGpuGc();
    assert.equal(st.guestGpuCounts().vms, 1, 'TTL 안에서는 독립 GC 도 지우지 않는다');
    mock.timers.tick(10 * MIN);
    st.runGuestGpuGc();
    assert.equal(st.guestGpuCounts().vms, 0, 'TTL 을 넘긴 엣지 항목은 지운다 — 영원히 남기지는 않는다');
    assert.equal(st.getGuestGpuHost('vc-site:host-1'), null);
  } finally { mock.timers.reset(); }
});

test('LEFT-02 ② 엣지가 보고한 push 주기(60분)면 그 엣지 항목은 max(30분, 주기 × 3 + 30초) 까지 남는다 · 다른 엣지·로컬은 각자 기준', async () => {
  const T0 = 1_900_100_000_000;
  mock.timers.enable({ apis: ['Date'], now: T0 });
  try {
    const st = await import('../src/gpu/store.js');
    const diag = await import('../src/central/gpuGuestDiag.js');
    st._resetGuestGpuForTest(); diag._resetGpuGuestDiagForTest();
    writeGpu({ enabled: true, pollIntervalMs: 60_000 });
    diag.setGpuGuestDiag('Edge-Long', { at: T0, vcenters: [], intervalMs: 60 * MIN }, {}, { verified: true });
    st.setGuestGpu({ vms: [{ vmId: 'vc-site:vm-long', utilPct: 10 }], agent: 'edge-long', verified: true }); // 진단 이름과 대소문자만 다르다
    st.setGuestGpu({ vms: [{ vmId: 'vc-site:vm-short', utilPct: 10 }], agent: 'edge-short', verified: true }); // 주기 보고 없음 → 이 노드 기준 30분
    st.setGuestGpu({ vms: [{ vmId: 'vc-local:vm-l', utilPct: 10 }] });
    mock.timers.tick(35 * MIN);
    st.runGuestGpuGc();
    assert.deepEqual(st.getGuestGpuVms().map((v) => v.vmId).sort(), ['vc-site:vm-long'], '주기 60분 엣지는 남고, 30분 기준 항목은 지운다');
    assert.equal(st.edgeGuestGpuTtlMs(60 * MIN, 60_000), 3 * 60 * MIN + 30_000);
    assert.equal(st.edgeGuestGpuTtlMs(null, 60_000), 30 * MIN, '엣지 주기를 모르면 이 노드 주기(예전 기준)');
    assert.equal(st.edgeGuestGpuTtlMs(null, 60 * MIN), 3 * 60 * MIN + 30_000, '모를 때 예전 기준보다 짧아지지 않는다');
    assert.equal(st.edgeGuestGpuTtlMs(30_000, null), 30 * MIN);
    mock.timers.tick(150 * MIN); // 누적 185분 > 180.5분
    st.runGuestGpuGc();
    assert.equal(st.guestGpuCounts().vms, 0);
  } finally { mock.timers.reset(); }
});
